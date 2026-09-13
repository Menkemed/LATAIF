// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — der Goldkern: Gramm-Schulden anlegen und begleichen, an EINER Stelle.
//
// Vorher wohnte jede Begleichung im Store: sie las die Verbindlichkeit aus dessen Zwischenspeicher
// und schrieb ABSOLUTE Werte zurück („erfüllt = gesehen + neu"). Zwei Rechner, die dieselbe Schuld
// begleichen, überschrieben sich still. Die Zusagen der Maske („wird beim Speichern
// zurückgewiesen") hielt niemand ein, und die Umwandlung eines Kundenguthabens in Geld verschluckte
// das Scheitern des Geldguthabens — das Gold war danach trotzdem „erfüllt".
//
// Jetzt gilt für jede Handlung hier:
//   • gelesen wird aus der DATENBANK, in der Transaktion des Aufrufers (Maske: `runOnPrimary`,
//     PC2: `runRemoteCommand`) — dieses Modul öffnet und schließt nie selbst eine;
//   • die gesehene Fassung (`revision`) wird verglichen, sobald sie mitkommt;
//   • die Zusagen der Maske sind Regeln: nicht mehr als offen, nicht mehr als im Laden, nur Karate,
//     deren Reinheit das Haus kennt (`purity.ts`);
//   • gebucht wird strikt: scheitert eine Buchung, scheitert die ganze Handlung.
//
// Die Bedeutung der drei Wege ist bewusst die alte (siehe SettleGoldModal):
//   return_gold  der Workshop bringt das geschuldete Gold zurück → Zufluss in den Ladenbestand;
//   shop_gold    wir geben Gold aus dem Bestand — auch in einem anderen Karat, reinheitsgleich;
//   money        die Gramm-Schuld wird eine Ausgabe beim Lieferanten (Zahlungsart wie bisher 'bank').
// Alle drei senken die offenen Gramm derselben Verbindlichkeit.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { postExpense, postGoldConversionCredit, hasLedgerEntries } from '@/core/ledger/posting';
import type { Expense, GoldBucket, GoldPayable } from '@/core/models/types';
import { KARAT_PURITY } from './purity';

/** Ein fachliches Nein des Goldkerns — am Primary eine Meldung, aus der Ferne ein eingefrorenes Urteil. */
export class GoldRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoldRejected';
    this.code = code;
  }
}

/** Die Toleranz des Hauses beim Vergleich zweier Grammzahlen — dieselbe wie bisher im Store. */
export const GRAM_EPS = 0.0001;

/** Wer handelt, und in wessen Büchern: am Primary die Sitzung, aus der Ferne der geprüfte Absender. */
export interface GoldActor { branchId: string; userId: string }

const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const nowIso = (): string => new Date().toISOString();

// ── Eingaben ────────────────────────────────────────────────────────────────

export function isKnownKarat(k: unknown): k is string {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(KARAT_PURITY, k);
}

/** Ein Karat, dessen Reinheit das Haus kennt — sonst gäbe es keine Umrechnung (kein stilles `?? 1.0`). */
export function assertKnownKarat(k: unknown, what = 'karat'): string {
  if (!isKnownKarat(k)) {
    throw new GoldRejected('GOLD_KARAT_UNKNOWN', `${what} must be one of ${Object.keys(KARAT_PURITY).join(', ')} (got ${String(k)})`);
  }
  return k;
}

/** Gramm, wie die Masken sie erfassen: endlich, größer null, in Schritten von 0.001 g. */
export function assertGrams(v: unknown, what = 'grams'): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new GoldRejected('GOLD_GRAMS_INVALID', `${what} must be a positive number of grams`);
  }
  if (Math.abs(v * 1000 - Math.round(v * 1000)) > 1e-6) {
    throw new GoldRejected('GOLD_GRAMS_INVALID', `${what} is entered in steps of 0.001 g (got ${v})`);
  }
  return v;
}

/** Ein BHD-Betrag: mindestens ein Fils — darunter rundet die Buchung auf null und fiele weg. */
export function assertBhd(v: unknown, what = 'amount'): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.round(v * 1000) <= 0) {
    throw new GoldRejected('GOLD_AMOUNT_INVALID', `${what} must be a positive BHD amount (at least 0.001)`);
  }
  return v;
}

// ── Karat gegen Karat ──────────────────────────────────────────────────────

export interface CrossKaratPlan {
  sourcePurity: number;
  targetPurity: number;
  /** Was die Quellgramm im Karat der Schuld wert sind (gleicher Feingoldgehalt). */
  targetEquivalent: number;
  /** Eine halbe Eingabestufe (0.0005 g Quelle), ausgedrückt in Gramm der Schuld. */
  tolerance: number;
  verdict: 'exact' | 'partial' | 'over';
  /** Um so viel sinkt die offene Schuld. */
  applied: number;
  /** Die Eingabe (auf 0.001 g), die die offene Schuld genau begleicht. */
  exactSourceGrams: number;
}

/**
 * Die Formel bleibt die alte (Quellgramm · P[Quelle] / P[Ziel]). Neu ist die Toleranz: eine Eingabe
 * in 0.001-g-Schritten trifft eine offene Schuld in einem anderen Karat praktisch nie genau — vorher
 * blieb dann entweder ein Staubrest offen, oder die nächste Stufe wurde als „zu viel" abgewiesen.
 * Liegt das Äquivalent innerhalb einer halben Eingabestufe um das Offene, ist die Schuld genau
 * beglichen; darüber hinaus ist es zu viel.
 */
export function crossKaratPlan(sourceKarat: string, targetKarat: string, sourceGrams: number, openGrams: number): CrossKaratPlan {
  const sourcePurity = KARAT_PURITY[assertKnownKarat(sourceKarat, 'sourceKarat')];
  const targetPurity = KARAT_PURITY[assertKnownKarat(targetKarat, 'the karat of the payable')];
  const targetEquivalent = (sourceGrams * sourcePurity) / targetPurity;
  const tolerance = (0.0005 * sourcePurity) / targetPurity;
  const verdict: CrossKaratPlan['verdict'] = Math.abs(targetEquivalent - openGrams) <= tolerance
    ? 'exact'
    : targetEquivalent > openGrams ? 'over' : 'partial';
  return {
    sourcePurity, targetPurity, targetEquivalent, tolerance, verdict,
    applied: verdict === 'exact' ? openGrams : targetEquivalent,
    exactSourceGrams: Math.round(((openGrams * targetPurity) / sourcePurity) * 1000) / 1000,
  };
}

// ── Bestand und Audit ──────────────────────────────────────────────────────

/**
 * Schreibt einen Audit-Eintrag für eine Gramm-Bewegung. Die Filiale kommt aus der Handlung, nicht
 * aus der Sitzung — damit eine Bewegung dort steht, wo die Schuld steht.
 */
export function recordGoldMovement(args: {
  branchId: string;
  direction: 'in' | 'out';
  weightGrams: number;
  karat: string;
  sourceBucket?: GoldBucket;
  sourceId?: string;
  targetBucket?: GoldBucket;
  targetId?: string;
  relatedRepairId?: string;
  notes?: string;
}): string {
  const db = getDatabase();
  const id = uuid();
  db.run(
    `INSERT INTO gold_movements (id, branch_id, moved_at, direction, weight_grams, karat,
       source_bucket, source_id, target_bucket, target_id, related_repair_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, args.branchId, nowIso(), args.direction, args.weightGrams, args.karat,
      args.sourceBucket || null, args.sourceId || null,
      args.targetBucket || null, args.targetId || null,
      args.relatedRepairId || null, args.notes || null,
    ],
  );
  trackInsert('gold_movements', id, {
    direction: args.direction, weightGrams: args.weightGrams, karat: args.karat,
    relatedRepairId: args.relatedRepairId,
  });
  return id;
}

/**
 * Der Ladenbestand eines Karats: die Summe ALLER Goldzeilen im Bestand, auch der negativen (eine
 * negative Zeile ist ein früherer Abfluss ohne Deckung). Dieselbe Rechnung zeigt die Maske
 * (`metalStockByKaratFor`) — was sie als verfügbar anzeigt, lässt die Regel auch zu.
 */
export function shopGoldStock(branchId: string, karat: string): number {
  const r = query(
    `SELECT COALESCE(SUM(weight_grams), 0) AS total FROM precious_metals
      WHERE branch_id = ? AND metal_type = 'gold' AND status = 'in_stock' AND karat = ?`,
    [branchId, karat],
  )[0];
  return num(r?.total);
}

/**
 * Passt den Gold-Bestand in `precious_metals` an: die jüngste Goldzeile dieses Karats trägt die
 * Änderung; ohne Zeile legt ein Zufluss eine an. Ein Abfluss ohne Zeile legt — wie bisher — eine
 * negative Zeile an, damit die Abstimmung ihn sieht (die Regel „nicht mehr als im Laden" steht
 * davor, im Begleichen).
 */
export function adjustPreciousMetals(args: {
  branchId: string;
  karat: string;
  deltaGrams: number;
  sourceLabel: string;
  createdBy: string;
}): void {
  const db = getDatabase();
  const now = nowIso();
  const rows = query(
    `SELECT id, weight_grams FROM precious_metals
       WHERE branch_id = ? AND metal_type = 'gold' AND karat = ? AND status = 'in_stock'
       ORDER BY created_at DESC LIMIT 1`,
    [args.branchId, args.karat],
  );
  if (rows.length > 0) {
    const existingId = str(rows[0].id);
    const next = round6(num(rows[0].weight_grams) + args.deltaGrams);
    db.run(`UPDATE precious_metals SET weight_grams = ?, updated_at = ? WHERE id = ?`, [next, now, existingId]);
    trackUpdate('precious_metals', existingId, { weightGrams: next, source: args.sourceLabel });
    return;
  }
  const id = uuid();
  const negative = args.deltaGrams < 0;
  db.run(
    `INSERT INTO precious_metals (id, branch_id, metal_type, karat, weight_grams,
       description, status, paid_amount, payment_status, images, created_at, updated_at, created_by)
     VALUES (?, ?, 'gold', ?, ?, ?, 'in_stock', 0, 'UNPAID', '[]', ?, ?, ?)`,
    [id, args.branchId, args.karat, args.deltaGrams, negative ? `NEG: ${args.sourceLabel}` : args.sourceLabel, now, now, args.createdBy || null],
  );
  trackInsert('precious_metals', id, {
    karat: args.karat, weightGrams: args.deltaGrams, source: args.sourceLabel, ...(negative ? { negative: true } : {}),
  });
}

// ── Anlegen ────────────────────────────────────────────────────────────────

export interface NewGoldPayable {
  supplierId?: string;
  weightGrams?: number;
  karat?: string;
  sourceRepairId?: string;
  sourceRepairLineId?: string;
  sourceOrderId?: string;
  sourceOrderLineId?: string;
  direction?: GoldPayable['direction'];
  settlementType?: GoldPayable['settlementType'];
  notes?: string;
}

/**
 * Die EINE Stelle, an der eine Gramm-Schuld entsteht — für den Auftrag (R5E, über
 * `createGoldPayable`), für Reparatur-Material, für „Add Gold Usage" und für „Add Cost".
 * Die Vorgaben sind die alten: wir schulden (`we_owe`), beglichen wird mit Gold (`return_gold`).
 */
export function insertGoldPayable(branchId: string, data: NewGoldPayable): string {
  if (!data.supplierId) throw new GoldRejected('GOLD_PAYABLE_INVALID', 'createGoldPayable: supplierId required');
  if (!data.weightGrams || data.weightGrams <= 0) throw new GoldRejected('GOLD_PAYABLE_INVALID', 'createGoldPayable: weightGrams must be > 0');
  if (!data.karat) throw new GoldRejected('GOLD_PAYABLE_INVALID', 'createGoldPayable: karat required');
  assertKnownKarat(data.karat);
  // v0.2.1 — exactly one of sourceRepairId / sourceOrderId
  if (data.sourceRepairId && data.sourceOrderId) {
    throw new GoldRejected('GOLD_PAYABLE_INVALID', 'createGoldPayable: only one of sourceRepairId / sourceOrderId may be set');
  }
  const id = uuid();
  const now = nowIso();
  getDatabase().run(
    `INSERT INTO gold_payables (id, branch_id, supplier_id, source_repair_id, source_repair_line_id, source_order_id,
       source_order_line_id, direction, weight_grams, karat, settlement_type, fulfilled_grams, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
    [
      id, branchId, data.supplierId, data.sourceRepairId || null, data.sourceRepairLineId || null,
      data.sourceOrderId || null, data.sourceOrderLineId || null,
      data.direction || 'we_owe', data.weightGrams, data.karat,
      data.settlementType || 'return_gold', data.notes || null, now, now,
    ],
  );
  trackInsert('gold_payables', id, {
    supplierId: data.supplierId, weightGrams: data.weightGrams, karat: data.karat,
    settlementType: data.settlementType,
    sourceRepairId: data.sourceRepairId,
    sourceOrderId: data.sourceOrderId,
    sourceOrderLineId: data.sourceOrderLineId,
  });
  return id;
}

export interface NewCustomerGoldCredit {
  customerId?: string;
  weightGrams?: number;
  karat?: string;
  sourceRepairId?: string;
  sourceOrderId?: string;
  notes?: string;
}

/** Die EINE Stelle, an der ein Gold-Guthaben eines Kunden entsteht. */
export function insertCustomerGoldCredit(branchId: string, data: NewCustomerGoldCredit): string {
  if (!data.customerId) throw new GoldRejected('GOLD_CREDIT_INVALID', 'createCustomerGoldCredit: customerId required');
  if (!data.weightGrams || data.weightGrams <= 0) throw new GoldRejected('GOLD_CREDIT_INVALID', 'createCustomerGoldCredit: weightGrams must be > 0');
  if (!data.karat) throw new GoldRejected('GOLD_CREDIT_INVALID', 'createCustomerGoldCredit: karat required');
  assertKnownKarat(data.karat);
  // v0.2.1 — exactly one of sourceRepairId / sourceOrderId
  if (data.sourceRepairId && data.sourceOrderId) {
    throw new GoldRejected('GOLD_CREDIT_INVALID', 'createCustomerGoldCredit: only one of sourceRepairId / sourceOrderId may be set');
  }
  const id = uuid();
  const now = nowIso();
  getDatabase().run(
    `INSERT INTO customer_gold_credits (id, branch_id, customer_id, source_repair_id, source_order_id,
       weight_grams, karat, fulfilled_grams, status, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, ?)`,
    [id, branchId, data.customerId, data.sourceRepairId || null, data.sourceOrderId || null,
      data.weightGrams, data.karat, data.notes || null, now, now],
  );
  trackInsert('customer_gold_credits', id, {
    customerId: data.customerId, weightGrams: data.weightGrams, karat: data.karat,
    sourceRepairId: data.sourceRepairId,
    sourceOrderId: data.sourceOrderId,
  });
  return id;
}

/**
 * Plan v0.1.45 — „Shop Keeps": der Rest des Kundengolds geht in den Ladenbestand, mit Audit-Eintrag
 * (Quelle `repair_consumption`). Keine Schuld, kein Guthaben.
 */
export function creditShopGoldCore(actor: GoldActor, karat: string, grams: number,
  opts: { repairId?: string; sourceLabel?: string; notes?: string } = {}): void {
  if (!Number.isFinite(grams) || grams <= 0) throw new GoldRejected('GOLD_GRAMS_INVALID', 'creditShopGold: grams must be > 0');
  if (!karat) throw new GoldRejected('GOLD_KARAT_UNKNOWN', 'creditShopGold: karat required');
  assertKnownKarat(karat);
  const label = opts.sourceLabel || (opts.repairId
    ? `Customer-leftover from repair ${opts.repairId.slice(0, 8)}`
    : 'Shop-keeps gold credit');
  adjustPreciousMetals({ branchId: actor.branchId, karat, deltaGrams: grams, sourceLabel: label, createdBy: actor.userId });
  recordGoldMovement({
    branchId: actor.branchId, direction: 'in', weightGrams: grams, karat,
    sourceBucket: 'repair_consumption',
    sourceId: opts.repairId,
    targetBucket: 'precious_metals',
    relatedRepairId: opts.repairId,
    notes: opts.notes || label,
  });
}

// ── Lesen in der Transaktion ──────────────────────────────────────────────

/** Der Fassungsvergleich — nur wenn die Handlung sagt, welche Fassung sie gesehen hat. */
export function assertSeenRevision(row: Record<string, unknown>, expected: number | undefined): void {
  if (expected === undefined) return;
  const now = num(row.revision);
  if (now !== expected) {
    throw new GoldRejected('RECORD_CHANGED', `this record changed since you opened it (you saw ${expected}, it is now ${now})`);
  }
}

function livePayable(id: string, branchId: string): Record<string, unknown> {
  const p = query('SELECT * FROM gold_payables WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!p) throw new GoldRejected('GOLD_PAYABLE_NOT_FOUND', 'no such gold payable in this branch');
  return p;
}

function liveGoldCredit(id: string, branchId: string): Record<string, unknown> {
  const c = query('SELECT * FROM customer_gold_credits WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!c) throw new GoldRejected('GOLD_CREDIT_NOT_FOUND', 'no such customer gold credit in this branch');
  return c;
}

/** Erfüllt + Neu → neuer Stand. Im Rahmen der Toleranz ist die Schuld genau erfüllt (kein Staub). */
function fulfil(fulfilled: number, add: number, weight: number): { fulfilled: number; status: 'OPEN' | 'FULFILLED' } {
  const next = fulfilled + add;
  if (next >= weight - GRAM_EPS) return { fulfilled: weight, status: 'FULFILLED' };
  return { fulfilled: round6(next), status: 'OPEN' };
}

function overSettled(what: string, grams: number, open: number, karat: string): GoldRejected {
  return new GoldRejected('GOLD_OVER_SETTLEMENT',
    `${what} ${grams.toFixed(3)} g ${karat} is more than the ${open.toFixed(3)} g ${karat} still open`);
}

function assertShopStock(branchId: string, karat: string, grams: number): void {
  const stock = shopGoldStock(branchId, karat);
  if (grams > stock + GRAM_EPS) {
    throw new GoldRejected('GOLD_SHOP_STOCK_INSUFFICIENT',
      `only ${Math.max(0, stock).toFixed(3)} g ${karat} gold in shop stock — cannot give ${grams.toFixed(3)} g`);
  }
}

// ── Gold-Verbindlichkeit begleichen ───────────────────────────────────────

export type PayableSettleMode = 'return_gold' | 'shop_gold' | 'money';
export const PAYABLE_SETTLE_MODES: readonly PayableSettleMode[] = ['return_gold', 'shop_gold', 'money'];

export interface PayableSettleRequest {
  payableId: string;
  /** Die gesehene Fassung. PC2 muss sie nennen; die Maske des Primary nennt sie auch. */
  expectedRevision?: number;
  mode: PayableSettleMode;
  /** return_gold / shop_gold — bei anderem Quell-Karat in GRAMM DER QUELLE. */
  grams?: number;
  /** shop_gold: aus welchem Karat des Bestands (Vorgabe: das Karat der Schuld). */
  sourceKarat?: string;
  /** money: der ausgehandelte BHD-Betrag. */
  agreedBhd?: number;
  notes?: string;
  /** Nur für die alten Store-Aufrufer; die Maske und PC2 nennen keine (es bleibt 'bank'). */
  method?: 'cash' | 'bank' | 'benefit';
}

export interface PayableSettleResult {
  payableId: string;
  mode: PayableSettleMode;
  fulfilledGrams: number;
  openGrams: number;
  status: string;
  revision: number;
  expenseId?: string;
}

function payableState(id: string): { fulfilledGrams: number; openGrams: number; status: string; revision: number } {
  const r = query('SELECT weight_grams, fulfilled_grams, status, revision FROM gold_payables WHERE id = ?', [id])[0];
  const weight = num(r?.weight_grams);
  const done = num(r?.fulfilled_grams);
  return { fulfilledGrams: done, openGrams: Math.max(0, round6(weight - done)), status: str(r?.status), revision: num(r?.revision) };
}

export function settleGoldPayable(actor: GoldActor, req: PayableSettleRequest): PayableSettleResult {
  const p = livePayable(req.payableId, actor.branchId);
  assertSeenRevision(p, req.expectedRevision);
  const status = str(p.status);
  if (status !== 'OPEN') throw new GoldRejected('GOLD_PAYABLE_NOT_OPEN', `this gold payable is already ${status}`);
  if (!PAYABLE_SETTLE_MODES.includes(req.mode)) throw new GoldRejected('GOLD_SETTLE_MODE_INVALID', `unknown settle mode ${String(req.mode)}`);

  const db = getDatabase();
  const now = nowIso();
  const id = str(p.id);
  const karat = str(p.karat);
  const weight = num(p.weight_grams);
  const fulfilled = num(p.fulfilled_grams);
  const open = Math.max(0, weight - fulfilled);
  const repairId = str(p.source_repair_id) || undefined;

  if (req.mode === 'money') {
    // Gold-Schuld in BHD: eine Ausgabe beim verknüpften Lieferanten (wie ein Reparatur-Kostenposten),
    // die Verbindlichkeit ist danach erfüllt und zeigt auf die Ausgabe. Ausgabe, Buchung, Schuld und
    // Bewegung stehen zusammen — oder gar nicht.
    const agreed = assertBhd(req.agreedBhd, 'agreedBhd');
    const method = req.method ?? 'bank';
    const expenseId = uuid();
    const expenseNumber = getNextDocumentNumber('EXP');
    const description = `Gold-Settlement: ${open.toFixed(3)}g ${karat} (gold_payable ${id.slice(0, 8)})`;
    // v0.6.0 — Order-Gold-Payables kapitalisieren in COGS (Kategorie 'Inventory',
    // von den Betriebsausgaben ausgeschlossen); Repair-Gold bleibt 'RepairCosts'.
    const category: Expense['category'] = p.source_order_id ? 'Inventory' : 'RepairCosts';
    const supplierId = str(p.supplier_id);
    const day = now.split('T')[0];
    db.run(
      `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, payment_method,
         expense_date, description, related_module, related_entity_id, supplier_id, status, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'gold_payable', ?, ?, 'PENDING', ?, ?)`,
      [expenseId, actor.branchId, expenseNumber, category, agreed, method, day, description, id, supplierId, now, actor.userId || null],
    );
    trackInsert('expenses', expenseId, {
      category, amount: agreed, sourceGoldPayableId: id, supplierId, status: 'PENDING',
    });
    const expense: Expense = {
      id: expenseId, expenseNumber, branchId: actor.branchId, category,
      amount: agreed, paidAmount: 0, paymentMethod: method,
      expenseDate: day, description,
      relatedModule: 'gold_payable', relatedEntityId: id,
      supplierId, status: 'PENDING', createdAt: now,
    };
    if (!hasLedgerEntries('EXPENSE', expenseId)) postExpense(expense);

    db.run(
      `UPDATE gold_payables SET settlement_expense_id = ?, status = 'FULFILLED',
         fulfilled_grams = weight_grams, notes = COALESCE(notes, '') || ?, updated_at = ?
         WHERE id = ?`,
      [expenseId, ' · ' + (req.notes || `Converted to ${agreed} BHD`), now, id],
    );
    trackUpdate('gold_payables', id, { status: 'FULFILLED', settlementExpenseId: expenseId, convertedTo: agreed });
    recordGoldMovement({
      branchId: actor.branchId, direction: 'out', weightGrams: open, karat,
      sourceBucket: 'gold_payable', sourceId: id,
      targetBucket: 'external',
      relatedRepairId: repairId,
      notes: req.notes || `Converted ${open.toFixed(3)}g to ${agreed} BHD`,
    });
    return { payableId: id, mode: 'money', ...payableState(id), expenseId };
  }

  const grams = assertGrams(req.grams, 'grams');

  if (req.mode === 'return_gold') {
    // Der Workshop bringt das geschuldete Gold physisch zurück → Ladenbestand ↑.
    if (grams > open + GRAM_EPS) throw overSettled('returning', grams, open, karat);
    const next = fulfil(fulfilled, grams, weight);
    db.run(`UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
      [next.fulfilled, next.status, now, id]);
    trackUpdate('gold_payables', id, { fulfilledGrams: next.fulfilled, status: next.status });
    adjustPreciousMetals({
      branchId: actor.branchId, karat, deltaGrams: grams, createdBy: actor.userId,
      sourceLabel: `Gold-Return from supplier (payable ${id.slice(0, 8)})`,
    });
    recordGoldMovement({
      branchId: actor.branchId, direction: 'in', weightGrams: grams, karat,
      sourceBucket: 'gold_payable', sourceId: id,
      targetBucket: 'precious_metals',
      relatedRepairId: repairId,
      notes: req.notes || 'Settlement (return_gold)',
    });
    return { payableId: id, mode: 'return_gold', ...payableState(id) };
  }

  // shop_gold — wir geben Gold aus dem Bestand.
  const sourceKarat = req.sourceKarat === undefined || req.sourceKarat === '' ? karat : req.sourceKarat;
  if (sourceKarat === karat) {
    if (grams > open + GRAM_EPS) throw overSettled('giving', grams, open, karat);
    assertShopStock(actor.branchId, karat, grams);
    adjustPreciousMetals({
      branchId: actor.branchId, karat, deltaGrams: -grams, createdBy: actor.userId,
      sourceLabel: `Applied to supplier gold-payable ${id.slice(0, 8)}`,
    });
    const next = fulfil(fulfilled, grams, weight);
    db.run(`UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
      [next.fulfilled, next.status, now, id]);
    trackUpdate('gold_payables', id, { fulfilledGrams: next.fulfilled, status: next.status });
    recordGoldMovement({
      branchId: actor.branchId, direction: 'out', weightGrams: grams, karat,
      sourceBucket: 'precious_metals',
      targetBucket: 'gold_payable', targetId: id,
      relatedRepairId: repairId,
      notes: req.notes || 'Cross-Settle: Shop gold applied to supplier payable',
    });
    return { payableId: id, mode: 'shop_gold', ...payableState(id) };
  }

  // Plan v0.1.47 — anderes Karat: reinheitsgleicher Transfer (siehe `crossKaratPlan`).
  const plan = crossKaratPlan(sourceKarat, karat, grams, open);
  if (plan.verdict === 'over') {
    throw new GoldRejected('GOLD_OVER_SETTLEMENT',
      `${grams.toFixed(3)} g ${sourceKarat} = ${plan.targetEquivalent.toFixed(3)} g ${karat}-equivalent — `
      + `only ${open.toFixed(3)} g ${karat} are still open (exact: ${plan.exactSourceGrams.toFixed(3)} g ${sourceKarat})`);
  }
  assertShopStock(actor.branchId, sourceKarat, grams);
  adjustPreciousMetals({
    branchId: actor.branchId, karat: sourceKarat, deltaGrams: -grams, createdBy: actor.userId,
    sourceLabel: `Cross-karat applied: ${grams.toFixed(3)}g ${sourceKarat} → payable ${id.slice(0, 8)} (${karat})`,
  });
  const next = plan.verdict === 'exact'
    ? { fulfilled: weight, status: 'FULFILLED' as const }
    : fulfil(fulfilled, plan.applied, weight);
  db.run(`UPDATE gold_payables SET fulfilled_grams = ?, status = ?, updated_at = ? WHERE id = ?`,
    [next.fulfilled, next.status, now, id]);
  trackUpdate('gold_payables', id, { fulfilledGrams: next.fulfilled, status: next.status });
  // Zwei Einträge: Quelle und Ziel jeweils mit IHREM Karat und IHREN Gramm — der Owner sieht im
  // Audit „8.759 g 24K wurden zu 10 g 21K-Schuld".
  recordGoldMovement({
    branchId: actor.branchId, direction: 'out', weightGrams: grams, karat: sourceKarat,
    sourceBucket: 'precious_metals',
    targetBucket: 'gold_payable', targetId: id,
    relatedRepairId: repairId,
    notes: req.notes || `Cross-Karat-Settle OUT: ${grams.toFixed(3)}g ${sourceKarat} (${(plan.sourcePurity * 100).toFixed(1)}% fine) → ${plan.applied.toFixed(3)}g ${karat}-equivalent`,
  });
  recordGoldMovement({
    branchId: actor.branchId, direction: 'in', weightGrams: round6(plan.applied), karat,
    sourceBucket: 'precious_metals',
    targetBucket: 'gold_payable', targetId: id,
    relatedRepairId: repairId,
    notes: `Cross-Karat-Settle FULFILL: payable in ${karat} reduced by ${plan.applied.toFixed(3)}g (au-equivalent from ${sourceKarat})`,
  });
  return { payableId: id, mode: 'shop_gold', ...payableState(id) };
}

// ── Gold-Guthaben eines Kunden begleichen ─────────────────────────────────

export type CreditSettleMode = 'return' | 'money';
export const CREDIT_SETTLE_MODES: readonly CreditSettleMode[] = ['return', 'money'];

export interface CreditSettleRequest {
  creditId: string;
  expectedRevision?: number;
  mode: CreditSettleMode;
  grams?: number;
  agreedBhd?: number;
  notes?: string;
}

export interface CreditSettleResult {
  creditId: string;
  mode: CreditSettleMode;
  fulfilledGrams: number;
  openGrams: number;
  status: string;
  revision: number;
  customerCreditId?: string;
}

function creditState(id: string): { fulfilledGrams: number; openGrams: number; status: string; revision: number } {
  const r = query('SELECT weight_grams, fulfilled_grams, status, revision FROM customer_gold_credits WHERE id = ?', [id])[0];
  const weight = num(r?.weight_grams);
  const done = num(r?.fulfilled_grams);
  return { fulfilledGrams: done, openGrams: Math.max(0, round6(weight - done)), status: str(r?.status), revision: num(r?.revision) };
}

export function settleCustomerGoldCredit(actor: GoldActor, req: CreditSettleRequest): CreditSettleResult {
  const c = liveGoldCredit(req.creditId, actor.branchId);
  assertSeenRevision(c, req.expectedRevision);
  const status = str(c.status);
  if (status !== 'OPEN') throw new GoldRejected('GOLD_CREDIT_NOT_OPEN', `this gold credit is already ${status}`);
  if (!CREDIT_SETTLE_MODES.includes(req.mode)) throw new GoldRejected('GOLD_SETTLE_MODE_INVALID', `unknown settle mode ${String(req.mode)}`);

  const db = getDatabase();
  const now = nowIso();
  const id = str(c.id);
  const karat = str(c.karat);
  const weight = num(c.weight_grams);
  const fulfilled = num(c.fulfilled_grams);
  const open = Math.max(0, weight - fulfilled);
  const customerId = str(c.customer_id);

  if (req.mode === 'return') {
    // Der Kunde holt physisch einen Teil seines Guthabens ab. Kein Geldfluss.
    const grams = assertGrams(req.grams, 'grams');
    if (grams > open + GRAM_EPS) throw overSettled('returning', grams, open, karat);
    const next = fulfil(fulfilled, grams, weight);
    db.run(
      `UPDATE customer_gold_credits SET fulfilled_grams = ?, status = ?, updated_at = ?,
         notes = COALESCE(notes, '') || ? WHERE id = ?`,
      [next.fulfilled, next.status, now, ' · returned ' + grams.toFixed(3) + 'g' + (req.notes ? ' (' + req.notes + ')' : ''), id],
    );
    trackUpdate('customer_gold_credits', id, { fulfilledGrams: next.fulfilled, status: next.status });
    recordGoldMovement({
      branchId: actor.branchId, direction: 'out', weightGrams: grams, karat,
      sourceBucket: 'customer_gold_credit', sourceId: id,
      targetBucket: 'external',
      notes: req.notes || 'Returned to customer',
    });
    return { creditId: id, mode: 'return', ...creditState(id) };
  }

  // money — das Gold-Guthaben wird ein BHD-Guthaben (`customer_credits`), das die Rückgabe-/
  // Zahlungswege einlösen. Vorher wurde ein gescheitertes Geldguthaben verschluckt und das Gold
  // trotzdem geschlossen — jetzt stehen Guthaben, Buchung, Gold und Bewegung zusammen oder gar nicht.
  const agreed = assertBhd(req.agreedBhd, 'agreedBhd');
  const moneyId = uuid();
  db.run(
    `INSERT INTO customer_credits (id, branch_id, customer_id, amount, used_amount, status,
       source_type, source_id, note, created_at)
     VALUES (?, ?, ?, ?, 0, 'OPEN', 'gold_conversion', ?, ?, ?)`,
    [moneyId, actor.branchId, customerId, agreed, id,
      `Gold-Conversion: ${open.toFixed(3)}g ${karat}` + (req.notes ? ' · ' + req.notes : ''), now],
  );
  trackInsert('customer_credits', moneyId, { customerId, amount: agreed, sourceGoldCreditId: id });
  // Credit-Modell Slice 4b — DR GOLD_CREDIT_CLEARING / CR CUSTOMER_CREDIT (Brücke Buch B → Buch A,
  // kein P&L), gekeyt auf die customer_credits-Zeile.
  if (!hasLedgerEntries('GOLD_CONVERSION', moneyId)) postGoldConversionCredit(moneyId, customerId, agreed, now);
  db.run(
    `UPDATE customer_gold_credits SET settlement_credit_id = ?, status = 'FULFILLED',
       fulfilled_grams = weight_grams, notes = COALESCE(notes, '') || ?, updated_at = ?
       WHERE id = ?`,
    [moneyId, ' · Converted to ' + agreed + ' BHD', now, id],
  );
  trackUpdate('customer_gold_credits', id, { status: 'FULFILLED', settlementCreditId: moneyId, convertedTo: agreed });
  recordGoldMovement({
    branchId: actor.branchId, direction: 'out', weightGrams: open, karat,
    sourceBucket: 'customer_gold_credit', sourceId: id,
    targetBucket: 'external',
    notes: req.notes || `Converted ${open.toFixed(3)}g to ${agreed} BHD`,
  });
  return { creditId: id, mode: 'money', ...creditState(id), customerCreditId: moneyId };
}

// ── Löschen einer Gramm-Schuld ────────────────────────────────────────────

/**
 * Wann eine Gramm-Schuld mit ihrer Zeile (oder allein) verschwinden darf. Die bestehende Regel
 * sperrte nur erfüllte; eine TEILWEISE beglichene offene Schuld wurde hart gelöscht — der
 * zurückgegebene/abgegebene Bestand und seine Bewegungen blieben ohne Gegenstück stehen. Dieselbe
 * Regel, zu Ende gedacht: sobald Gramm bewegt wurden, bleibt die Schuld.
 */
export function assertGoldPayablesRemovable(rows: ReadonlyArray<Record<string, unknown>>, where: 'Zeile' | 'Position' | 'Verbindlichkeit'): void {
  const allowed = where === 'Verbindlichkeit' ? ['OPEN'] : ['OPEN', 'CANCELLED'];
  for (const g of rows) {
    if (!allowed.includes(str(g.status))) {
      throw new GoldRejected('GOLD_PAYABLE_SETTLED', where === 'Verbindlichkeit'
        ? 'Nur offene Gold-Verbindlichkeiten können gelöscht werden.'
        : `Die Gold-Verbindlichkeit dieser ${where} wurde bereits beglichen — bitte erst die Verbindlichkeit rückabwickeln.`);
    }
    const done = num(g.fulfilled_grams);
    if (done > GRAM_EPS) {
      throw new GoldRejected('GOLD_PAYABLE_PARTLY_SETTLED',
        `the gold payable ${where === 'Verbindlichkeit' ? '' : 'of this line '}was already partly settled (${done.toFixed(3)} g) — `
        + 'gold has moved; it can no longer be deleted');
    }
  }
}

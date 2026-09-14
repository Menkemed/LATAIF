// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — ein Fertigungsvorgang (PRD): EINE Hausfolge für Primary und PC2.
//
// Die Maske „New Production Record" verbraucht Artikel (Eingänge) und legt neue an (Ausgänge),
// wertgleich (Plan §12: Input Value = Output Value, keine versteckten Gewinne). Bis hierher schrieb
// `productionStore.createRecord` das direkt und am Primary allein — mit sechs Fehlern, die ein
// zweiter Rechner nicht erben darf:
//
//   1. Die Fotos der Ausgänge landeten als Text in `products.images`, am Medienspeicher vorbei, den
//      jede andere Anlage seit MEDIA-3B2B benutzt. Jetzt entsteht jeder Ausgang über DENSELBEN
//      Anlageweg wie jeder Artikel (`createProductWithMedia`) — kein zweiter Bildweg.
//   2. Die Eingänge wurden nicht geprüft: ein unbekannter wurde still übersprungen, einer aus einer
//      anderen Filiale oder ein schon verkaufter/verbrauchter wurde (noch einmal) verbraucht. Die
//      Maske bietet nur Artikel „in_stock" dieser Filiale an — das ist jetzt auch die Regel des Hauses.
//   3. Ein Eingang mit MEHREREN Stück wurde ganz verbraucht (alle Lose auf 0), aber nur mit dem
//      Stückpreis bewertet — ein stiller Wertverlust gegen Plan §12 und die Bestandsbewertung
//      (`computeStockValuation`). Die Maske kennt keine Menge je Eingang; also ein Nein statt einer
//      erfundenen Teilmengen-Regel (siehe offene Entscheidung im Bericht).
//   4. Die Ausgänge liefen ohne Pflichtfeld- und SKU-Prüfung (Rückfall 'cat-watch', doppelte SKU
//      möglich). Jetzt dieselbe Prüfung wie der Artikel-Entwurf in Einkauf und Auftrag
//      (`checkEmbeddedProduct`): Pflichtfelder der Kategorie, veraltete Merkmale gestrichen, eine
//      vergebene SKU abgewiesen. Vergeben wird wie bisher KEINE SKU.
//   5. Ohne Sitzung schrieb der Store still nach 'branch-main' als 'user-owner'. Jetzt: Filiale und
//      Mensch aus der Sitzung (Primary) bzw. aus dem geprüften Ausweis (PC2), sonst nichts.
//   6. Zwischendurch `saveDatabase()`, keine Klammer: ein Fehler nach dem ersten Ausgang ließ einen
//      halben Vorgang stehen. Jetzt läuft alles in der Transaktion des Aufrufers (`runOnPrimary` am
//      Primary, `runRemoteCommand` für PC2) — diese Datei öffnet und schließt keine.
//
// Buchungen: das Anlegen bucht NICHTS ins Hauptbuch (wie bisher). Der Wert wandert nur zwischen
// Losen (Eingangs-Lose geleert ⇄ Ausgangs-Los zum Ausgangswert); Arbeit und Gemeinkosten werden
// am Vorgang festgehalten und erst beim Abschließen (`completeRecord`) als Ausgabe gebucht.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { getActiveLots, consumeLot, syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
import { isClientMode } from '@/core/bridge/client-mode';
import { useProductStore } from '@/stores/productStore';
import { checkEmbeddedProduct, EmbeddedProductRejected, pickProductSpec } from '@/core/products/embedded-product';
import { skuIsEmpty } from '@/core/products/sku-allocation';
import { createPayload } from '@/core/data/write-payloads';
import { TAX_SCHEMES, type Product } from '@/core/models/types';
import type { MediaSource } from '@/core/media/product-media-create';
import { createExpenseInHouse, PayablesRejected } from '@/core/payables/payables-house';

/**
 * Die Felder, die ein Ausgang aus der Maske mitbringt — genau die, die `createRecord` bisher in die
 * Produktzeile schrieb. Einstand, Menge, Lagerort, Preise, Bestand und Herkunft blendet die Maske
 * aus (`hideFields`) oder setzt der Vorgang selbst.
 */
export const PRODUCTION_OUTPUT_FIELDS = [
  'categoryId', 'brand', 'name', 'sku', 'condition', 'attributes', 'scopeOfDelivery',
  'taxScheme', 'notes', 'images',
] as const;

/** Bestehende Rundungstoleranz des Vorgangs (Plan §12: „Wir tolerieren 0.01 BHD Rundung") — in Fils. */
const TOLERANCE_FILS = 10;

export const PRODUCTION_PRIMARY_ONLY = 'PRODUCTION_PRIMARY_ONLY';

export interface ProductionOutputInput {
  /** Was die Maske „New Output Product" erfasst; `images` sind Daten-URLs (am Primary) bzw. die aus der Ablage gelesenen Bytes (PC2). */
  spec: Partial<Product>;
  /** Der Fertigungswert dieses Ausgangs (= Einstand des neuen Artikels), vom Menschen eingetippt. */
  value: number;
}

export interface ProductionCreateInput {
  /** Nur der alte Store-Vertrag kennt ein Datum; die Maske schickt keins, fern gibt es keins. */
  productionDate?: string;
  notes?: string;
  inputProductIds: string[];
  outputs: ProductionOutputInput[];
  laborCost?: number;
  overheadCost?: number;
}

/** Die Filiale und der Mensch: fern aus dem geprüften Ausweis, am Primary aus der Sitzung. */
export interface ProductionCtx {
  branchId: string;
  userId: string;
}

export interface ProductionCreated {
  recordId: string;
  recordNumber: string;
  totalValue: number;
  outputProductIds: string[];
  imageCount: number;
}

/** Ein fachliches Nein des Vorgangs — mit dem Code, den auch der Fernbefehl meldet. */
export class ProductionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProductionRejected';
    this.code = code;
  }
}

/** Kein Nein, sondern ein Ausfall: die Bilder eines Ausgangs kamen nicht vollständig an. Alles geht zurück. */
export class ProductionMediaIncomplete extends Error {
  readonly code = 'PRODUCT_MEDIA_INCOMPLETE';
  constructor(message: string) {
    super(message);
    this.name = 'ProductionMediaIncomplete';
  }
}

/**
 * Ein Rechner ohne Geschäftsdatenbank schreibt hier nie — auch nicht über einen vergessenen direkten
 * Store-Aufruf. Der Riegel steht vor dem ersten Zugriff auf eine Datenbank (dieselbe Regel wie R6E).
 */
export function assertProductionHere(): void {
  if (isClientMode()) {
    throw new ProductionRejected(PRODUCTION_PRIMARY_ONLY, 'production records are kept on the main computer — this window has no business database');
  }
}

/** Die Sitzung des Primary. Kein stilles 'branch-main'/'user-owner' mehr: ohne Filiale wird nichts geschrieben. */
export function localProductionCtx(): ProductionCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new ProductionRejected('PRODUCTION_NO_SESSION', 'no branch in this session — sign in again');
  return { branchId, userId };
}

/** Geld in Fils — gerechnet wird ganzzahlig, gespeichert in BHD mit drei Stellen. */
const fils = (v: number): number => Math.round(v * 1000);
const bhd = (f: number): number => f / 1000;

interface CheckedInput {
  id: string;
  purchasePrice: number;
  snapshot: Record<string, unknown>;
}

interface CheckedOutput {
  data: Partial<Product>;
  images: string[];
  valueFils: number;
}

function money(v: unknown, what: string, opts: { positive?: boolean } = {}): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || (opts.positive && !(n > 0))) {
    throw new ProductionRejected(
      opts.positive ? 'PRODUCTION_OUTPUT_VALUE_INVALID' : 'PRODUCTION_COST_INVALID',
      opts.positive ? `${what}: value must be > 0.` : `${what} cannot be negative.`,
    );
  }
  return n;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  try { return JSON.parse(String(raw ?? '')) as T; } catch { return fallback; }
}

/**
 * Die Eingänge — aus der DATENBANK, in der Filiale des Vorgangs. Nur, was die Maske anbietet, darf
 * verbraucht werden: ein Artikel dieser Filiale, „in_stock", mit einem einzigen Stück.
 */
function checkInputs(ids: readonly string[], branchId: string): CheckedInput[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ProductionRejected('PRODUCTION_INPUTS_REQUIRED', 'Select at least one input product.');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ProductionRejected('PRODUCTION_INPUT_DUPLICATE', 'the same input product twice is not a production');
  }
  const out: CheckedInput[] = [];
  for (const id of ids) {
    const r = query('SELECT * FROM products WHERE id = ? AND branch_id = ?', [id, branchId])[0];
    if (!r) throw new ProductionRejected('PRODUCTION_INPUT_NOT_FOUND', 'an input product does not exist in this branch');
    if (String(r.stock_status ?? '') !== 'in_stock') {
      throw new ProductionRejected('PRODUCTION_INPUT_NOT_AVAILABLE', `${String(r.brand ?? '')} ${String(r.name ?? '')} is not in stock (${String(r.stock_status ?? '')})`.trim());
    }
    // Stückzahl nach DERSELBEN Regel wie die Bestandsbewertung: wo es Lose gibt, deren Restmenge;
    // sonst die Menge der Zeile. Mehr als ein Stück kann dieser Vorgang nicht wertgleich verbrauchen.
    const lot = query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status != 'CANCELLED' AND qty_remaining > 0 THEN qty_remaining ELSE 0 END), 0) AS active
         FROM stock_lots WHERE product_id = ?`,
      [id],
    )[0];
    const pieces = Number(lot?.total) > 0 ? Number(lot?.active) || 0 : (r.quantity === null || r.quantity === undefined ? 1 : Number(r.quantity));
    if (pieces > 1) {
      throw new ProductionRejected('PRODUCTION_INPUT_MULTI_PIECE',
        `${String(r.brand ?? '')} ${String(r.name ?? '')} holds ${pieces} pieces — a production consumes the whole item at one piece's value`.trim());
    }
    const purchasePrice = Number(r.purchase_price) || 0;
    // Der Schnappschuss bleibt der Prüfpfad des Verbrauchs (Detailansicht) — dieselben Felder wie bisher.
    out.push({
      id,
      purchasePrice,
      snapshot: {
        categoryId: r.category_id as string,
        brand: r.brand as string,
        name: r.name as string,
        sku: (r.sku as string | null) ?? undefined,
        condition: (r.condition as string) || '',
        attributes: parseJson<Record<string, unknown>>(r.attributes || '{}', {}),
        images: parseJson<string[]>(r.images || '[]', []),
        purchasePrice,
      },
    });
  }
  return out;
}

/** Die Ausgänge: dieselbe Prüfung wie ein Artikel-Entwurf in Einkauf und Auftrag, gegen den FRISCHEN Bestand. */
function checkOutputs(outputs: readonly ProductionOutputInput[]): CheckedOutput[] {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new ProductionRejected('PRODUCTION_OUTPUTS_REQUIRED', 'Add at least one output product.');
  }
  const ps = useProductStore.getState();
  ps.loadProducts();
  ps.loadCategories();
  const typedSkus = new Set<string>();
  return outputs.map((o, i) => {
    const what = `Output ${i + 1}`;
    const value = money(o?.value, what, { positive: true });
    const picked = (pickProductSpec(o?.spec, PRODUCTION_OUTPUT_FIELDS) ?? {}) as Partial<Product>;
    const { images, ...spec } = picked;
    if (spec.taxScheme !== undefined && spec.taxScheme !== null && !(TAX_SCHEMES as readonly string[]).includes(String(spec.taxScheme))) {
      throw new ProductionRejected('TAX_SCHEME_INVALID', `${what}: unknown tax scheme ${String(spec.taxScheme)}`);
    }
    let checked: Partial<Product>;
    try {
      checked = checkEmbeddedProduct(spec, {
        category: (id) => useProductStore.getState().getCategory(id),
        isSkuTaken: (sku) => useProductStore.getState().isSkuTaken(sku),
      });
    } catch (e) {
      if (e instanceof EmbeddedProductRejected) throw new ProductionRejected(e.code, `${what}: ${e.message}`);
      throw e;
    }
    // Zwei Ausgänge DESSELBEN Vorgangs mit derselben SKU: derselbe Riegel wie gegen den Bestand
    // (getrimmt, ohne Groß/Klein) — der erste stünde sonst erst nach dem Anlegen im Bestand.
    if (!skuIsEmpty(checked.sku)) {
      const key = String(checked.sku).trim().toUpperCase();
      if (typedSkus.has(key)) throw new ProductionRejected('SKU_TAKEN', `${what}: The SKU / reference ${String(checked.sku).trim()} is already in use.`);
      typedSkus.add(key);
    }
    return {
      data: checked,
      images: Array.isArray(images) ? images.filter((s): s is string => typeof s === 'string') : [],
      valueFils: fils(value),
    };
  });
}

/**
 * Der Vorgang selbst — INNERHALB der Transaktion des Aufrufers. Erst wird alles geprüft (Eingänge,
 * Ausgänge, Kosten, Wertgleichheit), dann geschrieben: Beleg, verbrauchte Eingänge samt Losen,
 * neue Artikel über den Anlageweg des Hauses (Bilder in den Medienspeicher), je Ausgang ein Los.
 */
export async function createProductionInHouse(input: ProductionCreateInput, ctx: ProductionCtx): Promise<ProductionCreated> {
  assertProductionHere();
  if (!ctx.branchId) throw new ProductionRejected('PRODUCTION_NO_SESSION', 'no branch for this production');

  // ── 1. Prüfen ──
  const inputs = checkInputs(input.inputProductIds, ctx.branchId);
  const outputs = checkOutputs(input.outputs);
  const laborFils = fils(money(input.laborCost ?? 0, 'Labor cost'));
  const overheadFils = fils(money(input.overheadCost ?? 0, 'Overhead cost'));
  const totalInputFils = inputs.reduce((s, p) => s + fils(p.purchasePrice), 0);
  const totalOutputFils = outputs.reduce((s, o) => s + o.valueFils, 0);
  if (Math.abs(totalInputFils - totalOutputFils) > TOLERANCE_FILS) {
    throw new ProductionRejected('PRODUCTION_VALUE_MISMATCH',
      `Value mismatch — Input ${bhd(totalInputFils).toFixed(2)} ≠ Output ${bhd(totalOutputFils).toFixed(2)}`);
  }

  // ── 2. Schreiben ──
  const db = getDatabase();
  const now = new Date().toISOString();
  const id = uuid();
  const recordNumber = getNextDocumentNumber('PRD');
  const prodDate = input.productionDate || now.split('T')[0];
  const totalValue = bhd(totalInputFils);
  const totalCost = bhd(totalInputFils + laborFils + overheadFils);
  db.run(
    `INSERT INTO production_records (id, branch_id, record_number, production_date, total_value, notes, status,
       labor_cost, overhead_cost, total_cost, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?, ?)`,
    [id, ctx.branchId, recordNumber, prodDate, totalValue, input.notes || null,
      bhd(laborFils), bhd(overheadFils), totalCost, now, ctx.userId || null],
  );

  // Eingänge: NICHT löschen (Collection-History 2026-05-18) — stock_status='consumed', Lose geleert
  // (H-04: sonst Phantom-Bestand und doppelt gezählter Wert), Menge aus den Losen.
  for (const p of inputs) {
    const inputRowId = uuid();
    db.run(
      `INSERT INTO production_inputs (id, record_id, product_id, product_snapshot, input_value) VALUES (?, ?, ?, ?, ?)`,
      [inputRowId, id, p.id, JSON.stringify(p.snapshot), bhd(fils(p.purchasePrice))],
    );
    // POST-PARITY R7A (PP-10) — die Eingangszeile reist mit dem Beleg (vorher nur `production_records`:
    // ein anderer Datenbank-Rechner sah einen Beleg ohne Ein- und Ausgänge).
    trackChange('production_inputs', inputRowId, 'insert', {});
    db.run(`UPDATE products SET stock_status = 'consumed', updated_at = ? WHERE id = ?`, [now, p.id]);
    trackProductRow(p.id);   // LAN-Sync Phase 1b — Legacy-Input ohne Lose; für Lot-Inputs überschreibt syncProductQuantity
    for (const lot of getActiveLots(p.id)) consumeLot(lot.id, lot.qtyRemaining);
    syncProductQuantity(p.id);
  }

  // Ausgänge: neuer Artikel über DENSELBEN Anlageweg wie jede Anlage — Bilder in den Medienspeicher,
  // `products.images` bleibt '[]'. Die festen Werte des Fertigungseingangs setzt der Vorgang.
  const outputProductIds: string[] = [];
  let imageCount = 0;
  for (const o of outputs) {
    const d = o.data;
    const userNotes = (d.notes ? `${d.notes}\n` : '') + `Created from Production ${recordNumber}`;
    const source: MediaSource = { kind: 'data_urls', images: o.images };
    const made = await useProductStore.getState().createProductWithMedia({
      categoryId: d.categoryId,
      brand: String(d.brand ?? '').trim(),
      name: String(d.name ?? '').trim(),
      sku: skuIsEmpty(d.sku) ? undefined : String(d.sku).trim(),
      condition: d.condition || '',
      scopeOfDelivery: d.scopeOfDelivery || [],
      attributes: d.attributes || {},
      taxScheme: d.taxScheme || 'MARGIN',
      notes: userNotes,
      purchaseDate: prodDate,
      purchasePrice: bhd(o.valueFils),
      purchaseCurrency: 'BHD',
      quantity: 1,
      stockStatus: 'in_stock',
      sourceType: 'OWN',
    }, undefined, undefined, source, { alreadySerialised: true });
    if (made.status !== 'created') {
      // Ein Ausgang ohne seine Bilder ist kein Ausgang. Der Wurf nimmt den GANZEN Vorgang zurück;
      // bereits veröffentlichte Bilddateien sind dann verwaist — dafür gibt es die Medien-Müllabfuhr.
      throw new ProductionMediaIncomplete(`${made.status}: ${made.errorCode}`);
    }
    const pId = made.productId;
    outputProductIds.push(pId);
    imageCount += o.images.length;
    const outputRowId = uuid();
    db.run(
      `INSERT INTO production_outputs (id, record_id, product_id, output_value) VALUES (?, ?, ?, ?)`,
      [outputRowId, id, pId, bhd(o.valueFils)],
    );
    trackChange('production_outputs', outputRowId, 'insert', {});
    // F-PRD-03 — Output-Los: Eingangs-Lose geleert ⇄ Ausgangs-Los zum Ausgangswert (purchase_id NULL, qty 1).
    const lotId = uuid();
    db.run(
      `INSERT INTO stock_lots (id, branch_id, product_id, purchase_id, purchase_line_id,
         unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, 1, 1, 'ACTIVE', ?, ?)`,
      [lotId, ctx.branchId, pId, bhd(o.valueFils), prodDate, now],
    );
    trackLotRow(lotId, 'insert');
    syncProductQuantity(pId);
  }

  // Dieselben zwei Spuren wie `trackInsert` (Abgleich + Protokoll) — das Protokoll aber als Teil des
  // Vorgangs: scheitert es, geht der GANZE Vorgang zurück (wie beim Retourenstorno, R6E), statt einen
  // Beleg ohne Protokollzeile stehen zu lassen.
  trackChange('production_records', id, 'insert', { recordNumber, totalValue });
  logAuditOrThrow({
    module: 'Production', entityType: 'production_records', entityId: id, action: 'CREATE',
    newValue: { recordNumber, totalValue },
  });
  return { recordId: id, recordNumber, totalValue, outputProductIds, imageCount };
}

// ════ POST-PARITY R7A (PP-2) — „Complete Production" ════════════════════════
//
// Bis R7A hatte der Abschluss (`productionStore.completeRecord`) keinen Aufrufer: Arbeit und Gemein-
// kosten standen am Beleg, gebucht wurden sie nie. Der alte Weg hätte außerdem bei einem zweiten Aufruf
// eine zweite Ausgabe gebucht (keine Statusprüfung) — ohne Klammer, mit verschluckten Buchungsfehlern
// und stillem 'branch-main'. Jetzt EINE Hausfolge für Primary und PC2:
//   • abgeschlossen wird nur ein BESTÄTIGTER Beleg dieser Filiale; ein abgeschlossener ist ein Nein —
//     genau einmal gebucht, auch nach einem zweiten Klick oder aus einem veralteten Fenster;
//   • Arbeit + Gemeinkosten > 0 → EINE Ausgabe (Miscellaneous, bar bezahlt, `related_module
//     'production'`) über denselben Anlageweg wie jede Ausgabe (`createExpenseInHouse`: Beleg, Zahlung,
//     beide Buchungen STRIKT) — dieselbe Wirkung wie der alte Abschluss, die `deleteRecord` schon kennt;
//   • der Einstand des Fertigteils bleibt der Materialwert (= Ausgangswert, wie beim Anlegen): Arbeit und
//     Gemeinkosten sind Aufwand, nicht Einstand — sonst stünden sie doppelt in den Büchern;
//   • der Beleg wird COMPLETED, `total_cost` = Materialwert + Arbeit + Gemeinkosten (der Primary rechnet).
// Alles in der Transaktion des Aufrufers; scheitert ein Teil, bleibt nichts — kein halber Abschluss.

export interface ProductionCompleteInput {
  recordId: string;
  /** Die endgültigen Beträge — nicht genannt heißt: was am Beleg steht. */
  laborCost?: number;
  overheadCost?: number;
}

export interface ProductionCompleted {
  recordId: string;
  recordNumber: string;
  status: 'COMPLETED';
  laborCost: number;
  overheadCost: number;
  totalCost: number;
  expenseId: string | null;
  expenseNumber: string | null;
}

export function completeProductionInHouse(input: ProductionCompleteInput, ctx: ProductionCtx): ProductionCompleted {
  assertProductionHere();
  if (!ctx.branchId) throw new ProductionRejected('PRODUCTION_NO_SESSION', 'no branch for this production');
  const rec = query('SELECT * FROM production_records WHERE id = ? AND branch_id = ?', [input.recordId, ctx.branchId])[0];
  if (!rec) throw new ProductionRejected('PRODUCTION_NOT_FOUND', 'no such production record in this branch');
  const status = String(rec.status || 'CONFIRMED');
  if (status === 'COMPLETED') {
    throw new ProductionRejected('PRODUCTION_ALREADY_COMPLETED', 'this production record is already completed — its labor and overhead are booked');
  }
  if (status !== 'CONFIRMED') {
    throw new ProductionRejected('PRODUCTION_NOT_COMPLETABLE', `a ${status} production record cannot be completed`);
  }
  // Auch ein Altstand, der schon eine Ausgabe trägt, wird nicht ein zweites Mal gebucht.
  if (query(`SELECT 1 FROM expenses WHERE related_module = 'production' AND related_entity_id = ? LIMIT 1`, [rec.id]).length > 0) {
    throw new ProductionRejected('PRODUCTION_ALREADY_BOOKED', 'labor and overhead of this record are already booked as an expense');
  }
  const laborFils = fils(money(input.laborCost ?? Number(rec.labor_cost ?? 0), 'Labor cost'));
  const overheadFils = fils(money(input.overheadCost ?? Number(rec.overhead_cost ?? 0), 'Overhead cost'));
  const costFils = laborFils + overheadFils;
  const totalCost = bhd(fils(Number(rec.total_value ?? 0)) + costFils);
  const now = new Date().toISOString();
  const recordId = String(rec.id);
  const recordNumber = String(rec.record_number ?? '');

  let expense: { expenseId: string; expenseNumber: string } | null = null;
  if (costFils > 0) {
    try {
      expense = createExpenseInHouse({
        category: 'Miscellaneous',
        amount: bhd(costFils),
        paymentMethod: 'cash',
        expenseDate: now.split('T')[0],
        description: `Production ${recordNumber} — Labor ${bhd(laborFils).toFixed(3)} + Overhead ${bhd(overheadFils).toFixed(3)}`,
        initialPaid: bhd(costFils),
        relatedModule: 'production',
        relatedEntityId: recordId,
      }, { branchId: ctx.branchId, userId: ctx.userId, now });
    } catch (e) {
      if (e instanceof PayablesRejected) throw new ProductionRejected(e.code, e.message);
      throw e;
    }
  }
  getDatabase().run(
    `UPDATE production_records SET status = 'COMPLETED', labor_cost = ?, overhead_cost = ?, total_cost = ? WHERE id = ? AND branch_id = ?`,
    [bhd(laborFils), bhd(overheadFils), totalCost, recordId, ctx.branchId],
  );
  const fx = { status: 'COMPLETED', laborCost: bhd(laborFils), overheadCost: bhd(overheadFils), totalCost, expenseId: expense?.expenseId ?? null };
  trackChange('production_records', recordId, 'update', fx);
  logAuditOrThrow({
    module: 'Production', entityType: 'production_records', entityId: recordId, action: 'UPDATE', newValue: fx,
  });
  return {
    recordId, recordNumber, status: 'COMPLETED',
    laborCost: bhd(laborFils), overheadCost: bhd(overheadFils), totalCost,
    expenseId: expense?.expenseId ?? null, expenseNumber: expense?.expenseNumber ?? null,
  };
}

// ── PC2: der Rumpf ────────────────────────────────────────────────────────

/**
 * Die Ausgänge für den Fernbefehl: je Ausgang die Felder der Maske (ohne die leeren) und statt der
 * Fotos ihre Kennungen in der Zwischenablage des Primary. Die Bilder selbst reisen NIE im Auftrag;
 * dieselben Bytes ergeben dieselbe Kennung, ein erneutes Ablegen erzeugt keinen anderen Auftrag.
 */
export async function productionOutputBodies(
  outputs: readonly ProductionOutputInput[], stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const o of outputs) {
    const picked = (pickProductSpec(o.spec, PRODUCTION_OUTPUT_FIELDS) ?? {}) as Record<string, unknown>;
    const { images, ...rest } = picked;
    const spec = createPayload(rest, PRODUCTION_OUTPUT_FIELDS.filter((f) => f !== 'images'));
    const urls = Array.isArray(images) ? (images as string[]) : [];
    if (urls.length > 0) spec.stagingIds = await stage(urls);
    out.push({ spec, value: o.value });
  }
  return out;
}

/** Der Rumpf von `production.create`: nur, was ein Mensch an der Maske eingibt. */
export function productionCreateRequest(
  input: ProductionCreateInput, outputBodies: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    inputProductIds: [...input.inputProductIds],
    outputs: outputBodies.map((o) => ({ ...o })),
  };
  if (input.laborCost !== undefined && input.laborCost > 0) body.laborCost = input.laborCost;
  if (input.overheadCost !== undefined && input.overheadCost > 0) body.overheadCost = input.overheadCost;
  if (input.notes) body.notes = input.notes;
  return body;
}

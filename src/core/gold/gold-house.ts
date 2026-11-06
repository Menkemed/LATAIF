// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Gold, Material und Kostenzeilen am Haus: EINE Folge, zwei Anschlüsse.
//
// Was vorher am Primary geschah — und warum es nicht bleiben konnte:
//   • „Add Material" (Reparatur) und „Add Cost" (Auftrag) riefen je Position einzeln
//     `addRepairLine`/`addOrderLine` und danach `createGoldPayable`; jede Position stand für sich.
//     Scheiterte die dritte, standen die ersten beiden — ein zweiter Klick legte sie doppelt an.
//   • „Add Gold Usage" schrieb Schuld, Guthaben oder Bestand je Fall direkt aus der Seite; mehr
//     verbraucht als erhalten wurde still ignoriert.
//   • Das Löschen einer Kostenzeile stornierte die Ausgabe in einem `try/catch`, das nur
//     protokollierte — die Zeile verschwand, die Schuld beim Lieferanten blieb.
//
// Jetzt: `…InHouse` ist die EINE Folge (prüfen, dann schreiben) innerhalb der Transaktion des
// Aufrufers — der Fernbefehl ruft sie in `runRemoteCommand`, die Maske des Primary über
// `…OnPrimary` in `runOnPrimary` (exklusiv, eine Klammer, durabel). Die Gramm-, Karat- und
// Begleichungslogik selbst steht NUR im Goldkern (`gold-settle.ts`); diese Datei setzt zusammen.
// ════════════════════════════════════════════════════════════════════════════
import { settleOrderGoldInBhd, reverseOrderGoldSettlement, soldLineOf, type OrderGoldSettleRequest, type OrderGoldSettled } from './order-gold-settle';
import { planSoldLineCostCorrection, applySoldLineCostCorrection, type SoldLineRef } from '@/core/invoices/sold-line-cost-correction';
import { correctionDateIssue } from '@/core/ledger/correction-dates';
import { orderCustomCostBasis } from '@/core/orders/order-invoice-lines';
import { trackUpdate } from '@/core/sync/track';
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert } from '@/core/sync/track';
import { runOnPrimary } from '@/core/data/primary-action';
import { readsFromPrimary } from '@/core/data/primary-source';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { planOrderCostExpense, applyOrderCostExpense, type CostOverpayChoice, type OrderCostExpenseApplied } from '@/core/orders/order-cost-correction';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { useGoldStore } from '@/stores/goldStore';
import { useRepairStore } from '@/stores/repairStore';
import { useOrderStore } from '@/stores/orderStore';
import type { GoldPayable, OrderLine, RepairLine } from '@/core/models/types';
import {
  GRAM_EPS, GoldRejected, assertGoldPayablesRemovable, assertGrams, assertKnownKarat, assertSeenRevision,
  creditShopGoldCore, insertCustomerGoldCredit, insertGoldPayable, settleCustomerGoldCredit, settleGoldPayable,
  type CreditSettleRequest, type CreditSettleResult, type GoldActor, type PayableSettleRequest, type PayableSettleResult,
} from './gold-settle';

export type { CreditSettleRequest, CreditSettleResult, PayableSettleRequest, PayableSettleResult } from './gold-settle';

const num = (v: unknown): number => Number(v ?? 0) || 0;
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

// ── Nachschlagen in der Filiale ───────────────────────────────────────────

function liveRepair(id: string, branchId: string): Record<string, unknown> {
  const r = query('SELECT id, repair_number, customer_id, revision FROM repairs WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!r) throw new GoldRejected('REPAIR_NOT_FOUND', 'no such repair in this branch');
  return r;
}

function liveOrder(id: string, branchId: string): Record<string, unknown> {
  const o = query('SELECT id, status, revision FROM orders WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!o) throw new GoldRejected('ORDER_NOT_FOUND', 'no such order in this branch');
  return o;
}

/** Die Auswahl der Masken zeigt nur aktive Lieferanten (wie `houseOrderPort` beim Anlegen, R5E). */
function activeSupplierName(id: string, branchId: string): string {
  const r = query('SELECT name FROM suppliers WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId])[0];
  if (!r) throw new GoldRejected('SUPPLIER_NOT_FOUND', 'no such active supplier in this branch');
  return str(r.name);
}

function seenRevision(v: number | undefined): number | undefined {
  // Die Maske des Primary kennt die Fassung aus ihrem Store; eine 0 heißt „keine geladen".
  return typeof v === 'number' && v > 0 ? v : undefined;
}

// ── Material- und Kostenzeilen ────────────────────────────────────────────

/** Der explizite Eintrag „Shop / Own Stock" der Auswahl (v0.7.6) — kein Lieferant, keine A/P. */
export const INHOUSE_SOURCE = '__INHOUSE__';
export const MATERIAL_KINDS = ['labor', 'diamond', 'stone', 'gold'] as const;
export type MaterialKind = typeof MATERIAL_KINDS[number];

/** Eine Position, wie „Add Material" sie sammelt. `supplierId` ist Pflicht: ein Lieferant ODER `__INHOUSE__`. */
export interface MaterialRowInput {
  materialKind: string;
  description: string;
  quantity?: number;
  caratPerPiece?: number;
  weightGrams?: number;
  karat?: string;
  /** Der Betrag des Menschen (die Maske schlägt ihn beim Gold aus dem Spotpreis vor) — eine Eingabe. */
  totalCost: number;
  supplierId: string;
}

interface MaterialRow {
  kind: MaterialKind;
  description: string;
  quantity: number;
  caratPerPiece?: number;
  weightGrams?: number;
  karat?: string;
  totalCost: number;
  supplierId?: string;
  supplierName?: string;
  /** Goldschmied-Gold: die Schuld lebt in Gramm, die Zeile trägt dann KEINEN Lieferanten (keine Doppel-A/P). */
  goldAsPayable: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Die Regeln von „Add Material" (`AddMaterialModal.buildEntry`) — jetzt am Haus, damit PC2 dieselbe
 * Antwort bekommt. ALLE Positionen werden geprüft, bevor die erste geschrieben wird.
 */
export function checkMaterialRows(rows: readonly MaterialRowInput[], branchId: string, allowLabor: boolean): MaterialRow[] {
  if (!Array.isArray(rows) || rows.length === 0) throw new GoldRejected('MATERIAL_ROWS_EMPTY', 'add at least one cost position');
  return rows.map((r, i) => {
    const at = `position ${i + 1}`;
    const kind = r.materialKind as MaterialKind;
    if (!(MATERIAL_KINDS as readonly string[]).includes(kind) || (kind === 'labor' && !allowLabor)) {
      throw new GoldRejected('MATERIAL_KIND_INVALID', `${at}: this material kind is not offered here (${String(r.materialKind)})`);
    }
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (!description) throw new GoldRejected('MATERIAL_DESCRIPTION_REQUIRED', `${at}: description is required`);
    if (!finite(r.totalCost) || r.totalCost <= 0) throw new GoldRejected('MATERIAL_COST_INVALID', `${at}: cost > 0 required`);

    let quantity = 1;
    if (kind === 'labor') {
      if (r.quantity !== undefined && r.quantity !== 1) throw new GoldRejected('MATERIAL_FIELD_NOT_APPLICABLE', `${at}: labor has no quantity`);
    } else {
      quantity = r.quantity === undefined ? 1 : r.quantity;
      if (!finite(quantity) || quantity <= 0) throw new GoldRejected('MATERIAL_QUANTITY_INVALID', `${at}: quantity > 0 required`);
    }
    const carat = kind === 'diamond' || kind === 'stone';
    if (carat) {
      if (!finite(r.caratPerPiece) || r.caratPerPiece <= 0) {
        throw new GoldRejected('MATERIAL_CARAT_REQUIRED', `${at}: carat per piece > 0 is required for diamond/stone`);
      }
    } else if (r.caratPerPiece !== undefined) {
      throw new GoldRejected('MATERIAL_FIELD_NOT_APPLICABLE', `${at}: carat belongs to diamond/stone`);
    }
    let weightGrams: number | undefined;
    let karat: string | undefined;
    if (kind === 'gold') {
      weightGrams = assertGrams(r.weightGrams, `${at}: weight`);
      karat = assertKnownKarat(r.karat, `${at}: karat`);
    } else if (r.weightGrams !== undefined || r.karat !== undefined) {
      throw new GoldRejected('MATERIAL_FIELD_NOT_APPLICABLE', `${at}: weight and karat belong to a gold piece`);
    }
    // v0.7.6 — die Quelle ist eine ausdrückliche Wahl: Shop/Own Stock ODER ein Lieferant.
    if (typeof r.supplierId !== 'string' || !r.supplierId.trim()) {
      throw new GoldRejected('MATERIAL_SOURCE_REQUIRED', `${at}: pick the source — shop / own stock or a supplier`);
    }
    const supplierId = r.supplierId === INHOUSE_SOURCE ? undefined : r.supplierId;
    const supplierName = supplierId ? activeSupplierName(supplierId, branchId) : undefined;
    return {
      kind, description, quantity, totalCost: r.totalCost, supplierId, supplierName,
      ...(carat ? { caratPerPiece: r.caratPerPiece } : {}),
      ...(kind === 'gold' ? { weightGrams, karat } : {}),
      goldAsPayable: kind === 'gold' && !!supplierId,
    };
  });
}

/** Die Positionen der Maske (Lieferant fehlt = „Shop / Own Stock") in die Form des Hauses. */
export function materialRowsFromModal(rows: ReadonlyArray<{
  materialKind: string; description: string; quantity?: number; caratPerPiece?: number;
  weightGrams?: number; karat?: string; totalCost: number; supplierId?: string;
}>): MaterialRowInput[] {
  return rows.map((r) => {
    const out: MaterialRowInput = {
      materialKind: r.materialKind, description: r.description, totalCost: r.totalCost,
      supplierId: r.supplierId || INHOUSE_SOURCE,
    };
    if (r.materialKind !== 'labor' && r.quantity !== undefined) out.quantity = r.quantity;
    if (r.caratPerPiece !== undefined) out.caratPerPiece = r.caratPerPiece;
    if (r.weightGrams !== undefined) out.weightGrams = r.weightGrams;
    if (r.karat !== undefined) out.karat = r.karat;
    return out;
  });
}

function materialDetailsOf(r: MaterialRow) {
  return {
    ct: r.caratPerPiece, qty: r.quantity, description: r.description,
    karat: r.karat, weightGrams: r.weightGrams, supplierName: r.supplierName,
  };
}

// ── Reparatur: „Add Material" ─────────────────────────────────────────────

export interface RepairMaterialRequest { repairId: string; expectedRevision?: number; rows: MaterialRowInput[] }
export interface RepairMaterialResult { repairId: string; lineIds: string[]; goldPayableIds: string[]; revision: number }

export function addRepairMaterialInHouse(actor: GoldActor, req: RepairMaterialRequest): RepairMaterialResult {
  const rep = liveRepair(req.repairId, actor.branchId);
  assertSeenRevision(rep, seenRevision(req.expectedRevision));
  const rows = checkMaterialRows(req.rows, actor.branchId, false);
  const rs = useRepairStore.getState();
  // Die Hausfunktion schlägt die Reparatur in IHRER Liste nach — ein Fernauftrag hat keinen Bildschirm, der sie lud.
  rs.loadRepairs();
  rs.loadRepairLines();
  const check = watchLedgerPosts('repairs.add_material');
  const lineIds: string[] = [];
  const goldPayableIds: string[] = [];
  for (const r of rows) {
    const line = useRepairStore.getState().addRepairLine(req.repairId, {
      supplierId: r.goldAsPayable ? undefined : r.supplierId,
      workType: 'service',
      description: r.description,
      costAmount: r.totalCost,
      materialKind: r.kind as RepairLine['materialKind'],
      materialDetails: materialDetailsOf(r),
    });
    if (!line) throw new Error('repairs.add_material: the repair line was not written');
    lineIds.push(line.id);
    if (r.goldAsPayable) {
      goldPayableIds.push(insertGoldPayable(actor.branchId, {
        supplierId: r.supplierId,
        sourceRepairId: req.repairId,
        // v0.7.6 — Link auf die Zeile: `cancelRepairLine` nimmt die Gramm-Schuld mit.
        sourceRepairLineId: line.id,
        weightGrams: r.weightGrams,
        karat: r.karat,
        settlementType: 'return_gold',
      }));
    }
  }
  check();
  return { repairId: req.repairId, lineIds, goldPayableIds, revision: num(liveRepair(req.repairId, actor.branchId).revision) };
}

// ── Reparatur: „Add Gold Usage" ───────────────────────────────────────────

export type GoldUsageSource = 'workshop' | 'customer';
export type GoldLeftover = 'return' | 'credit' | 'shop_keep';
export const GOLD_LEFTOVER_DESTINATIONS: readonly GoldLeftover[] = ['return', 'credit', 'shop_keep'];
export const GOLD_SETTLEMENT_TYPES: ReadonlyArray<GoldPayable['settlementType']> = ['return_gold', 'pay_money'];

export interface RepairGoldUsageRequest {
  repairId: string;
  expectedRevision?: number;
  source: GoldUsageSource;
  karat: string;
  receivedGrams: number;
  /** workshop */
  supplierId?: string;
  settlementType?: GoldPayable['settlementType'];
  /** customer */
  usedGrams?: number;
  leftover?: GoldLeftover;
}

export interface RepairGoldUsageResult {
  repairId: string;
  source: GoldUsageSource;
  payableId?: string;
  goldCreditId?: string;
  leftoverGrams: number;
  shopKeptGrams: number;
}

/**
 * Der FACHVERLAUF eines angenommenen Goldeinsatzes — und nur er.
 *
 * Es wird nichts gerechnet und nichts gebucht: geschrieben werden die Werte, die der Vorgang
 * ohnehin hat (Quelle, Karat, erhalten, verbraucht, Rest, Verbleib, Ausgleichsart) und die
 * Kennungen dessen, was die Domäne GERADE gebucht hat. Der Aufruf steht am Ende jedes
 * angenommenen Zweigs — eine Ablehnung wirft vorher, und dann gibt es auch keinen Eintrag.
 * Die Klammer hält der Aufrufer (`runRemoteCommand` bzw. `runOnPrimary`), deshalb gehört die
 * Zeile zu derselben Transaktion wie die Buchung.
 */
function insertGoldUsageHistory(
  actor: GoldActor,
  req: RepairGoldUsageRequest,
  v: {
    karat: string; received: number; used?: number; rest?: number;
    leftover?: GoldLeftover; settlementType?: GoldPayable['settlementType'];
    result: RepairGoldUsageResult;
  },
): string {
  const db = getDatabase();
  const id = uuid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO repair_gold_usage_history
       (id, branch_id, repair_id, source, supplier_id, karat, received_grams, used_grams,
        remainder_grams, leftover, settlement_type, shop_kept_grams, gold_payable_id,
        gold_credit_id, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, actor.branchId, req.repairId, req.source, req.supplierId ?? null, v.karat, v.received,
      v.used === undefined ? null : v.used,
      v.rest === undefined ? null : v.rest,
      v.leftover ?? null, v.settlementType ?? null,
      v.result.shopKeptGrams, v.result.payableId ?? null, v.result.goldCreditId ?? null,
      now, actor.userId || null,
    ],
  );
  trackInsert('repair_gold_usage_history', id, {
    repairId: req.repairId, source: req.source, karat: v.karat, receivedGrams: v.received,
    usedGrams: v.used, remainderGrams: v.rest,
  });
  return id;
}

/**
 * Workshop-Gold → Gramm-Schuld beim Goldschmied. Kundengold → der Rest (erhalten − verbraucht) geht
 * zurück (nichts zu buchen), wird Guthaben des Kunden oder bleibt im Laden. Alles in EINER Klammer.
 */
export function recordRepairGoldUsageInHouse(actor: GoldActor, req: RepairGoldUsageRequest): RepairGoldUsageResult {
  const rep = liveRepair(req.repairId, actor.branchId);
  assertSeenRevision(rep, seenRevision(req.expectedRevision));
  const karat = assertKnownKarat(req.karat);
  const received = assertGrams(req.receivedGrams, 'receivedGrams');

  if (req.source === 'workshop') {
    if (!req.supplierId) throw new GoldRejected('SUPPLIER_NOT_FOUND', 'workshop gold needs the supplier / goldsmith');
    activeSupplierName(req.supplierId, actor.branchId);
    const settlementType = req.settlementType ?? 'return_gold';
    if (!GOLD_SETTLEMENT_TYPES.includes(settlementType)) {
      throw new GoldRejected('GOLD_SETTLEMENT_TYPE_INVALID', `settlement type is return_gold or pay_money (got ${String(settlementType)})`);
    }
    const payableId = insertGoldPayable(actor.branchId, {
      supplierId: req.supplierId, sourceRepairId: req.repairId, weightGrams: received, karat, settlementType,
    });
    const werkstatt: RepairGoldUsageResult = {
      repairId: req.repairId, source: 'workshop', payableId, leftoverGrams: 0, shopKeptGrams: 0,
    };
    insertGoldUsageHistory(actor, req, { karat, received, settlementType, result: werkstatt });
    return werkstatt;
  }
  if (req.source !== 'customer') throw new GoldRejected('GOLD_SOURCE_INVALID', 'gold comes from the workshop or from the customer');

  const used = req.usedGrams === undefined || req.usedGrams === 0 ? 0 : assertGrams(req.usedGrams, 'usedGrams');
  // Vorher still ignoriert: mehr verbraucht als der Kunde gebracht hat, ist kein Rest, sondern ein Tippfehler.
  if (used > received + GRAM_EPS) {
    throw new GoldRejected('GOLD_USED_EXCEEDS_RECEIVED',
      `used ${used.toFixed(3)} g is more than the ${received.toFixed(3)} g the customer brought`);
  }
  const leftover = req.leftover ?? 'return';
  if (!GOLD_LEFTOVER_DESTINATIONS.includes(leftover)) {
    throw new GoldRejected('GOLD_LEFTOVER_INVALID', `the leftover goes back, becomes credit or stays in the shop (got ${String(leftover)})`);
  }
  const rest = round3(received - used);
  const out: RepairGoldUsageResult = { repairId: req.repairId, source: 'customer', leftoverGrams: rest, shopKeptGrams: 0 };
  const number = str(rep.repair_number);
  // Kein Rest heisst: nichts zu buchen. Der VORGANG bleibt trotzdem stehen — genau dieser Fall
  // („5 g gebracht, 5 g verarbeitet") war bisher hinterher nirgends mehr zu sehen.
  if (rest <= GRAM_EPS) {
    insertGoldUsageHistory(actor, req, { karat, received, used, rest, leftover, result: out });
    return out;
  }
  if (leftover === 'credit') {
    const customerId = str(rep.customer_id);
    if (!customerId || !query('SELECT id FROM customers WHERE id = ? AND branch_id = ?', [customerId, actor.branchId])[0]) {
      throw new GoldRejected('CUSTOMER_NOT_FOUND', 'the customer of this repair is not in this branch');
    }
    out.goldCreditId = insertCustomerGoldCredit(actor.branchId, {
      customerId, sourceRepairId: req.repairId, weightGrams: rest, karat,
      notes: `Customer-Gold leftover from repair ${number}`,
    });
  } else if (leftover === 'shop_keep') {
    // Plan v0.1.45 — der Laden behält den Rest: Zufluss in den Bestand, Audit-Eintrag.
    creditShopGoldCore(actor, karat, rest, { repairId: req.repairId, sourceLabel: `Customer-Gold leftover from repair ${number}` });
    out.shopKeptGrams = rest;
  }
  // 'return' — der Kunde nimmt den Rest wieder mit: nichts zu buchen (wie bisher).
  insertGoldUsageHistory(actor, req, { karat, received, used, rest, leftover, result: out });
  return out;
}

// ── Auftrag: „Add Cost" und eine Kostenzeile löschen ─────────────────────

/**
 * CUSTOM-ORDER K1 — ist das Sonderstück dieser Order schon abgerechnet, sind seine Kosten im Wareneinsatz der
 * Rechnung. Eine neue oder entfernte Kostenzeile änderte ihn still; abgelehnt, bevor etwas geschrieben wird.
 * (Die nachträgliche Begleichung einer Goldschuld in BHD berichtigt die Rechnung ausdrücklich — K3a.)
 */
/**
 * CUSTOM-ORDER Owner-Regel (Edit Order After Invoice Conversion) — ist das Sonderstück schon verkauft, bleiben seine
 * Kosten über die Order korrigierbar, solange die Rechnung im OFFENEN Zeitraum berichtigt werden kann — auch FINAL und
 * voll bezahlt. Geprüft VOR jedem Schreiben: Rechnungszeile vorhanden, keine Retoure/Gutschrift, kein Korrektur-Guthaben,
 * Rechnungs- und Buchungstag offen. `null` = noch nicht verkauft (dann gilt das bisherige „vor der Rechnung").
 */
function invoicedPieceCorrection(orderId: string, branchId: string): SoldLineRef | null {
  const inv = query(`SELECT 1 FROM order_lines WHERE order_id = ? AND material_kind = 'custom' AND invoice_id IS NOT NULL LIMIT 1`, [orderId]);
  if (inv.length === 0) return null;
  const sold = soldLineOf(orderId);
  if (!sold) {
    throw new GoldRejected('ORDER_COSTS_LOCKED',
      'the invoice line of the custom piece is not found — its costs stay as they are. Nothing was changed.');
  }
  const plan = planSoldLineCostCorrection(sold, 0, branchId);
  if (plan.blocker) {
    throw new GoldRejected(plan.blocker.code, `${plan.blocker.message} The costs of this order stay as they are. Nothing was changed.`);
  }
  if (plan.mode !== 'INVOICE') {
    throw new GoldRejected('ORDER_COSTS_PERIOD_CLOSED',
      `The invoice of this order lies in a closed period — its costs are no longer corrected via the order. ${plan.periodReason ?? ''} Nothing was changed.`.trim());
  }
  const heute = correctionDateIssue(branchId, [{ iso: new Date().toISOString(), what: 'the cost correction' }]);
  if (heute) throw new GoldRejected(heute.code, heute.message);
  return sold;
}

/** Nach dem Schreiben der Kosten: die Rechnungszeile (Einstand, ggf. Margin-VAT) und der Artikel folgen um die Differenz. */
function followInvoicedPiece(sold: SoldLineRef, orderId: string, branchId: string, beforeFils: number, context: Record<string, unknown>): void {
  const afterFils = Math.round(orderCustomCostBasis(useOrderStore.getState().getOrderLines(orderId)) * 1000);
  const delta = afterFils - beforeFils;
  if (delta === 0) return;
  const nowIso = new Date().toISOString();
  applySoldLineCostCorrection(sold, delta, branchId, nowIso, {
    setProductCost: false, auditField: 'cost_correction_order_after_invoice', auditContext: { orderId, ...context },
  });
  // Der Artikel trägt den tatsächlichen Einstand: + Differenz (eine getrennt gebuchte Goldschuld-Differenz bleibt darin).
  const p = query('SELECT product_id FROM invoice_lines WHERE id = ?', [sold.lineId])[0];
  if (p?.product_id) {
    const pid = String(p.product_id);
    const alt = Math.round((Number(query('SELECT purchase_price FROM products WHERE id = ?', [pid])[0]?.purchase_price) || 0) * 1000);
    const neu = Math.max(0, alt + delta) / 1000;
    getDatabase().run('UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?', [neu, nowIso, pid]);
    trackUpdate('products', pid, { purchasePrice: neu });
  }
}
const costBasisFils = (orderId: string): number => Math.round(orderCustomCostBasis(useOrderStore.getState().getOrderLines(orderId)) * 1000);

export interface OrderCostRequest { orderId: string; expectedRevision?: number; rows: MaterialRowInput[] }
export interface OrderCostResult { orderId: string; lineIds: string[]; goldPayableIds: string[]; expenseIds: string[]; revision: number }

export function addOrderCostInHouse(actor: GoldActor, req: OrderCostRequest): OrderCostResult {
  const o = liveOrder(req.orderId, actor.branchId);
  assertSeenRevision(o, seenRevision(req.expectedRevision));
  // Die Maske bietet „Add Cost" nur für einen nicht stornierten Auftrag an.
  if (str(o.status) === 'cancelled') throw new GoldRejected('ORDER_CANCELLED', 'this order is cancelled — it takes no new cost lines');
  const sold = invoicedPieceCorrection(req.orderId, actor.branchId);
  const rows = checkMaterialRows(req.rows, actor.branchId, true);
  // CUSTOM-ORDER OF3 — am verkauften Stück nur Kosten, die im Lager gebucht werden (Werkstatt / Goldschuld).
  if (sold && rows.some((r) => !r.supplierId && !r.goldAsPayable && r.totalCost > 0.0005)) {
    throw new GoldRejected('CUSTOM_COSTS_NOT_BOOKED',
      'own labour / own gold without a workshop is not supported on an invoiced piece — record the cost with the workshop. Nothing was changed.');
  }
  const vorher = sold ? costBasisFils(req.orderId) : 0;
  const check = watchLedgerPosts('orders.add_cost');
  const lineIds: string[] = [];
  const goldPayableIds: string[] = [];
  for (const r of rows) {
    const ctLabel = r.kind === 'diamond' || r.kind === 'stone' ? `${r.quantity}× ${(r.caratPerPiece || 0).toFixed(2)}ct ` : '';
    // Als ARRIVED angelegt → `commitOrderLineExpenses` bucht die A/P einer Lieferantenzeile sofort.
    const lineId = useOrderStore.getState().addOrderLine(req.orderId, {
      description: `${ctLabel}${r.description}`.trim(),
      quantity: 1,
      unitPrice: 0,
      isCustomerFacing: false,
      materialKind: r.kind as OrderLine['materialKind'],
      supplierId: r.goldAsPayable ? undefined : r.supplierId,
      costAmount: r.totalCost,
      status: 'ARRIVED',
      materialDetails: materialDetailsOf(r),
    });
    lineIds.push(lineId);
    if (r.goldAsPayable) {
      // v0.6.5 — die Gramm-Schuld hängt an ihrer Kostenzeile (dieselben Vorgaben wie beim Anlegen, R5E).
      goldPayableIds.push(insertGoldPayable(actor.branchId, {
        supplierId: r.supplierId, sourceOrderId: req.orderId, sourceOrderLineId: lineId,
        weightGrams: r.weightGrams, karat: r.karat,
      }));
    }
  }
  // CUSTOM-ORDER K1 — die Gramm-Schuld entsteht erst NACH ihrer (sofort angekommenen) Zeile: ihr Wert wird jetzt
  // gebucht (Soll INVENTORY / Haben GOLD_LIABILITY). Idempotent; schon gebuchte Zeilen bleiben unberührt.
  if (goldPayableIds.length > 0) useOrderStore.getState().commitOrderLineExpenses(req.orderId);
  if (sold) followInvoicedPiece(sold, req.orderId, actor.branchId, vorher, { addedLineIds: lineIds });
  check();
  const expenseIds = lineIds.length === 0 ? [] : query(
    `SELECT expense_id FROM order_lines WHERE id IN (${lineIds.map(() => '?').join(',')}) AND expense_id IS NOT NULL ORDER BY position`,
    lineIds,
  ).map((x) => str(x.expense_id));
  return { orderId: req.orderId, lineIds, goldPayableIds, expenseIds, revision: num(liveOrder(req.orderId, actor.branchId).revision) };
}

export interface OrderCostRemoveRequest {
  orderId: string; expectedRevision?: number; lineId: string;
  /** CUSTOM-ORDER Kostenkorrektur — nur bei einer echten Überzahlung: Guthaben ('credit') oder Rückforderung ('refund'). */
  overpayChoice?: CostOverpayChoice;
}
export interface OrderCostRemoveResult {
  orderId: string; lineId: string; removedGoldPayableIds: string[]; cancelledExpenseId?: string; revision: number;
  /** Überzahlung aus der schon bezahlten Schuld (0 = keine). */
  overpay?: number; overpayCreditId?: string; overpayKind?: CostOverpayChoice;
}

export function removeOrderCostInHouse(actor: GoldActor, req: OrderCostRemoveRequest): OrderCostRemoveResult {
  const o = liveOrder(req.orderId, actor.branchId);
  assertSeenRevision(o, seenRevision(req.expectedRevision));
  if (str(o.status) === 'cancelled') throw new GoldRejected('ORDER_CANCELLED', 'this order is cancelled — its cost lines stay as they are');
  const line = query('SELECT id, order_id, invoice_id, expense_id, is_customer_facing FROM order_lines WHERE id = ?', [req.lineId])[0];
  if (!line) throw new GoldRejected('LINE_NOT_FOUND', 'no such order line');
  if (str(line.order_id) !== req.orderId) throw new GoldRejected('LINE_NOT_ON_ORDER', 'this line belongs to another order');
  // Der Löschknopf steht nur in der Kostenkarte — eine Kundenposition geht diesen Weg nicht.
  if (num(line.is_customer_facing) !== 0) throw new GoldRejected('LINE_NOT_A_COST_LINE', 'this is a customer line, not a cost line');
  if (str(line.invoice_id)) throw new GoldRejected('LINE_INVOICED', 'Diese Position ist bereits in einer Invoice — erst die Invoice stornieren.');
  const sold = invoicedPieceCorrection(req.orderId, actor.branchId);
  const linked = query('SELECT id, status, fulfilled_grams FROM gold_payables WHERE source_order_line_id = ?', [req.lineId]);
  assertGoldPayablesRemovable(linked, 'Position');
  // CUSTOM-ORDER Kostenkorrektur (Owner) — eine schon (teil-)bezahlte Lieferantenschuld: die Ausgabe wird storniert, ihre
  // Zahlungen bleiben stehen, das Bezahlte wird Guthaben oder Rückforderung (Wahl). Geplant VOR jedem Schreiben.
  // (Vorher: Nein ORDER_COST_PAID — und noch früher nahm das Löschen die Zahlungszeilen mit und ließ ihre Buchung stehen.)
  const nowIso = new Date().toISOString();
  const plan = planOrderCostExpense(req.lineId, 0, req.overpayChoice, actor.branchId, nowIso);
  const vorher = sold ? costBasisFils(req.orderId) : 0;
  const check = watchLedgerPosts('orders.remove_cost');
  const ueber: OrderCostExpenseApplied | null = plan && plan.settledF > 0
    ? applyOrderCostExpense(plan, { branchId: actor.branchId, userId: actor.userId, now: nowIso }, { orderId: req.orderId, orderLineId: req.lineId })
    : null;
  useOrderStore.getState().deleteOrderLine(req.lineId);
  if (sold) followInvoicedPiece(sold, req.orderId, actor.branchId, vorher, { removedLineId: req.lineId });
  check();
  if (query('SELECT id FROM order_lines WHERE id = ?', [req.lineId])[0]) {
    throw new Error('orders.remove_cost: the cost line is still there');
  }
  return {
    orderId: req.orderId, lineId: req.lineId,
    removedGoldPayableIds: linked.map((g) => str(g.id)),
    ...(str(line.expense_id) ? { cancelledExpenseId: str(line.expense_id) } : {}),
    ...(ueber ? { overpay: ueber.overpay, ...(ueber.overpayCreditId ? { overpayCreditId: ueber.overpayCreditId, overpayKind: ueber.overpayKind } : {}) } : {}),
    revision: num(liveOrder(req.orderId, actor.branchId).revision),
  };
}

// ── CUSTOM-ORDER Kostenkorrektur: den Betrag einer Kostenzeile ändern ─────────────────────────────────────────

export interface OrderCostChangeRequest {
  orderId: string; expectedRevision?: number; lineId: string;
  /** Der neue Betrag der Kostenzeile (> 0; „0" ist Löschen). */
  newCost: number;
  /** Nur bei einer echten Überzahlung: Guthaben ('credit') oder Rückforderung ('refund'). */
  overpayChoice?: CostOverpayChoice;
}
export interface OrderCostChangeResult {
  orderId: string; lineId: string; oldCost: number; newCost: number; expenseId?: string;
  overpay: number; overpayCreditId?: string; overpayKind?: CostOverpayChoice; revision: number;
}

/**
 * „Change Cost" an einer Kostenzeile (Owner-Entscheidung): die Lieferantenschuld folgt dem neuen Betrag (offen bleibt
 * Betrag − Bezahltes); nur bei einer echten Überzahlung wird gewählt (Guthaben / Rückforderung). Am verkauften Stück
 * folgt die Rechnungszeile (Einstand, Wareneinsatz, ggf. Margin-VAT) und der Artikel — wie bei „Add Cost".
 * Goldschuld-Zeilen (Gramm) ändern sich weiter über Entfernen + neu Anlegen.
 */
export function changeOrderCostInHouse(actor: GoldActor, req: OrderCostChangeRequest): OrderCostChangeResult {
  const o = liveOrder(req.orderId, actor.branchId);
  assertSeenRevision(o, seenRevision(req.expectedRevision));
  if (str(o.status) === 'cancelled') throw new GoldRejected('ORDER_CANCELLED', 'this order is cancelled — its cost lines stay as they are');
  const line = query(
    'SELECT id, order_id, invoice_id, expense_id, is_customer_facing, supplier_id, cost_amount, status FROM order_lines WHERE id = ?', [req.lineId],
  )[0];
  if (!line) throw new GoldRejected('LINE_NOT_FOUND', 'no such order line');
  if (str(line.order_id) !== req.orderId) throw new GoldRejected('LINE_NOT_ON_ORDER', 'this line belongs to another order');
  if (num(line.is_customer_facing) !== 0) throw new GoldRejected('LINE_NOT_A_COST_LINE', 'this is a customer line, not a cost line');
  if (str(line.invoice_id)) throw new GoldRejected('LINE_INVOICED', 'this line is on an invoice');
  if (typeof req.newCost !== 'number' || !Number.isFinite(req.newCost) || Math.round(req.newCost * 1000) <= 0) {
    throw new GoldRejected('INVALID_INPUT', 'the new cost must be more than 0 — to drop the cost, delete the line');
  }
  if (query('SELECT 1 FROM gold_payables WHERE source_order_line_id = ? LIMIT 1', [req.lineId]).length > 0) {
    throw new GoldRejected('ORDER_COST_GOLD_DEBT',
      'this is a gold debt in grams — change it by removing the line and adding the gold again. Nothing was changed.');
  }
  const altF = Math.round(num(line.cost_amount) * 1000);
  const neuF = Math.round(req.newCost * 1000);
  const rev = (): number => num(liveOrder(req.orderId, actor.branchId).revision);
  if (neuF === altF) {
    return { orderId: req.orderId, lineId: req.lineId, oldCost: altF / 1000, newCost: neuF / 1000, overpay: 0, revision: rev() };
  }
  const sold = invoicedPieceCorrection(req.orderId, actor.branchId);
  // CUSTOM-ORDER OF3 — am verkauften Stück nur Kosten, die im Lager gebucht sind (Werkstatt).
  if (sold && !str(line.supplier_id)) {
    throw new GoldRejected('CUSTOM_COSTS_NOT_BOOKED',
      'own labour / own gold without a workshop is not supported on an invoiced piece — record the cost with the workshop. Nothing was changed.');
  }
  const nowIso = new Date().toISOString();
  const plan = planOrderCostExpense(req.lineId, neuF, req.overpayChoice, actor.branchId, nowIso);
  const vorher = sold ? costBasisFils(req.orderId) : 0;
  const check = watchLedgerPosts('orders.change_cost');
  getDatabase().run('UPDATE order_lines SET cost_amount = ? WHERE id = ?', [neuF / 1000, req.lineId]);
  trackUpdate('order_lines', req.lineId, { costAmount: neuF / 1000 });
  const ueber = plan
    ? applyOrderCostExpense(plan, { branchId: actor.branchId, userId: actor.userId, now: nowIso }, { orderId: req.orderId, orderLineId: req.lineId })
    : null;
  // Eine angekommene Werkstattzeile ohne gebuchte Schuld (bisher 0): jetzt wie bei „Add Cost" als Lieferantenschuld buchen.
  if (!plan && str(line.supplier_id) && ['ARRIVED', 'DELIVERED'].includes(str(line.status))) {
    useOrderStore.getState().commitOrderLineExpenses(req.orderId);
  }
  logAuditOrThrow({
    module: 'Orders', entityType: 'order_lines', entityId: req.lineId, action: 'UPDATE', field: 'cost_amount',
    oldValue: { costAmount: altF / 1000 },
    newValue: { costAmount: neuF / 1000, orderId: req.orderId, ...(ueber ? { expenseId: ueber.expenseId, overpay: ueber.overpay } : {}) },
    actor: { userId: actor.userId || undefined, branchId: actor.branchId },
  });
  if (sold) followInvoicedPiece(sold, req.orderId, actor.branchId, vorher, { changedLineId: req.lineId, oldCost: altF / 1000, newCost: neuF / 1000 });
  check();
  useOrderStore.getState().loadOrders();
  return {
    orderId: req.orderId, lineId: req.lineId, oldCost: altF / 1000, newCost: neuF / 1000,
    ...(ueber ? { expenseId: ueber.expenseId } : {}),
    overpay: ueber?.overpay ?? 0,
    ...(ueber?.overpayCreditId ? { overpayCreditId: ueber.overpayCreditId, overpayKind: ueber.overpayKind } : {}),
    revision: rev(),
  };
}

// ── Die Rümpfe für PC2 — dieselben Werte, die die Maske am Primary übergibt ──

function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export function goldPayableSettleBody(req: PayableSettleRequest): Record<string, unknown> {
  return compact({
    payableId: req.payableId, expectedRevision: req.expectedRevision, mode: req.mode,
    grams: req.grams, sourceKarat: req.sourceKarat, agreedBhd: req.agreedBhd, notes: req.notes,
  });
}

export function goldCreditSettleBody(req: CreditSettleRequest): Record<string, unknown> {
  return compact({
    creditId: req.creditId, expectedRevision: req.expectedRevision, mode: req.mode,
    grams: req.grams, agreedBhd: req.agreedBhd, notes: req.notes,
  });
}

export function repairGoldUsageBody(req: RepairGoldUsageRequest): Record<string, unknown> {
  return compact({ ...req });
}

export function repairMaterialBody(req: RepairMaterialRequest): Record<string, unknown> {
  return compact({ repairId: req.repairId, expectedRevision: req.expectedRevision, rows: req.rows.map((r) => compact({ ...r })) });
}

export function orderCostBody(req: OrderCostRequest): Record<string, unknown> {
  return compact({ orderId: req.orderId, expectedRevision: req.expectedRevision, rows: req.rows.map((r) => compact({ ...r })) });
}

export function orderCostRemoveBody(req: OrderCostRemoveRequest): Record<string, unknown> {
  return compact({ orderId: req.orderId, expectedRevision: req.expectedRevision, lineId: req.lineId, overpayChoice: req.overpayChoice });
}

/** CUSTOM-ORDER Kostenkorrektur — derselbe Fernbefehl `orders.remove_cost`, mit `newCost` = „Change Cost". */
export function orderCostChangeBody(req: OrderCostChangeRequest): Record<string, unknown> {
  return compact({ orderId: req.orderId, expectedRevision: req.expectedRevision, lineId: req.lineId, newCost: req.newCost, overpayChoice: req.overpayChoice });
}

// ── Die Maske des Primary ─────────────────────────────────────────────────

/**
 * Wer am Primary handelt. Auf einem verbundenen Client gibt es hier NICHTS lokal zu tun — die Maske
 * geht dort über den Fernbefehl; ein Aufruf dieses Anschlusses ist ein Nein, bevor die Datenbank
 * gefragt wird.
 */
function primaryActor(what: string): GoldActor {
  if (readsFromPrimary()) {
    throw new GoldRejected('CLIENT_WRITE_UNSUPPORTED', `${what} runs on the primary — a connected client sends it as a command`);
  }
  const branchId = currentBranchId();
  if (!branchId) throw new GoldRejected('BRANCH_MISSING', 'no branch in this session');
  return { branchId, userId: currentUserId() };
}

/** Die Listen, die die Masken danach zeigen — auch nach einem Rollback. */
function frischLesen(): void {
  useGoldStore.getState().loadAll();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useOrderStore.getState().loadOrders();
}

export async function settleGoldPayableOnPrimary(req: PayableSettleRequest): Promise<PayableSettleResult> {
  const actor = primaryActor('settling a gold payable');
  return runOnPrimary(() => settleGoldPayable(actor, req), frischLesen);
}

/** CUSTOM-ORDER K3a — Goldschuld einer Order in BHD begleichen (Teil, Kurs, Tag) — am Primary in EINER Klammer. */
export async function settleOrderGoldOnPrimary(req: OrderGoldSettleRequest): Promise<OrderGoldSettled> {
  const actor = primaryActor('settling a gold debt in BHD');
  return runOnPrimary(() => {
    const check = watchLedgerPosts('gold.payables.settle (BHD)');
    const out = settleOrderGoldInBhd(actor, req);
    check();
    return out;
  }, frischLesen);
}

/** CUSTOM-ORDER K3a — eine BHD-Begleichung zurücknehmen (solange unbezahlt). */
export async function reverseOrderGoldSettlementOnPrimary(settlementId: string): Promise<{ settlementId: string; payableId: string }> {
  const actor = primaryActor('reversing a gold settlement');
  return runOnPrimary(() => {
    const check = watchLedgerPosts('gold.payables.settle (reverse)');
    const out = reverseOrderGoldSettlement(actor, settlementId);
    check();
    return out;
  }, frischLesen);
}

/** Die Rümpfe des Fernbefehls `gold.payables.settle` für die beiden neuen Arten. */
export function orderGoldSettleBody(req: OrderGoldSettleRequest, expectedRevision: number): Record<string, unknown> {
  return { payableId: req.payableId, expectedRevision, mode: 'money_order', grams: req.grams, ratePerGram: req.ratePerGram,
    ...(req.settledOn ? { settledOn: req.settledOn } : {}), ...(req.notes ? { notes: req.notes } : {}) };
}
export function orderGoldReverseBody(payableId: string, settlementId: string, expectedRevision: number): Record<string, unknown> {
  return { payableId, expectedRevision, mode: 'money_order_reverse', settlementId };
}

export async function settleGoldCreditOnPrimary(req: CreditSettleRequest): Promise<CreditSettleResult> {
  const actor = primaryActor('settling a customer gold credit');
  return runOnPrimary(() => settleCustomerGoldCredit(actor, req), frischLesen);
}

export async function recordRepairGoldUsageOnPrimary(req: RepairGoldUsageRequest): Promise<RepairGoldUsageResult> {
  const actor = primaryActor('recording gold usage');
  return runOnPrimary(() => recordRepairGoldUsageInHouse(actor, req), frischLesen);
}

export async function addRepairMaterialOnPrimary(req: RepairMaterialRequest): Promise<RepairMaterialResult> {
  const actor = primaryActor('adding repair material');
  return runOnPrimary(() => addRepairMaterialInHouse(actor, req), frischLesen);
}

export async function addOrderCostOnPrimary(req: OrderCostRequest): Promise<OrderCostResult> {
  const actor = primaryActor('adding order costs');
  return runOnPrimary(() => addOrderCostInHouse(actor, req), frischLesen);
}

export async function removeOrderCostOnPrimary(req: OrderCostRemoveRequest): Promise<OrderCostRemoveResult> {
  const actor = primaryActor('removing an order cost line');
  return runOnPrimary(() => removeOrderCostInHouse(actor, req), frischLesen);
}

export async function changeOrderCostOnPrimary(req: OrderCostChangeRequest): Promise<OrderCostChangeResult> {
  const actor = primaryActor('changing an order cost');
  return runOnPrimary(() => changeOrderCostInHouse(actor, req), frischLesen);
}

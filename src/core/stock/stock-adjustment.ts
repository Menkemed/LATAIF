// ════════════════════════════════════════════════════════════════════════════
// STOCK-ADJUSTMENT Phase 1 — kontrollierter Bestandsabgang eigener Stückware (Verlust, Diebstahl, Schaden,
// Zählfehler), mit eigenem Beleg (ADJ-…), exaktem Storno, strengem Protokoll und Sync. Zugänge und Anfangsbestand
// folgen erst nach der buchhalterischen Klärung (docs/stock-correction-contract.md).
//
// Woher weiß das Haus, ob ein Abgang Lagerwert ausbucht? Nicht aus „Los ja/nein", sondern aus dem Hauptbuch:
// INVENTORY wird im Code an genau diesen Stellen im SOLL bebucht (Stand v0.8.82, siehe Pin im Test):
//   • Einkauf          `postPurchaseReceived` — je Einkaufszeile (source_line_id = purchase_lines.id); jede
//                      Einkaufszeile eines Artikels legt sein Los an;
//   • Reparaturkosten  Ausgabe der Kategorie „Inventory" zu einer Reparatur (`repairCostAccount`) und eigene
//                      Arbeit/eigener Bestand (`postRepairOwnWork`, Bereich OWN) — aktiviert auf den Artikel der
//                      Reparatur, auch OHNE Los;
//   • Retoure „In Stock" `postSalesReturnCogs` — nimmt nur den Wareneinsatz eines Verkaufs zurück (kein Zugang);
//   • Rücknahmen       (reverses_entry_id gesetzt) — Spiegel einer früheren Buchung.
// Produktion und „Keep" legen Lose an, buchen aber NICHT auf INVENTORY.
//
// Daraus die zwei Wege, beide fail-closed:
//   • LOT      — der Artikel hat Lose. Entnommen wird nach der bestehenden Regel (ältestes zuerst). Jedes entnommene
//                Los muss aus einer Einkaufszeile stammen, deren INVENTORY-Buchung steht (oder deren Einstand 0 ist).
//                Dann: Soll INVENTORY_LOSS an INVENTORY zum Einstand. Sonst: Wert unklar → abgewiesen.
//   • LOTLESS  — der Artikel hatte nie ein Los. Nur wenn NACHWEISLICH nie Lagerwert gebucht wurde (keine Einkaufszeile,
//                keine aktivierten Reparaturkosten, und im ganzen Hauptbuch keine INVENTORY-Sollbuchung unbekannter
//                Herkunft), wird NUR die Menge reduziert — ohne erfundene Buchung, im Beleg ausdrücklich
//                ACCOUNTING_RECONCILIATION_PENDING (mit Einkaufspreis als Bewertungshinweis), damit die spätere
//                Anfangsbestands-Abstimmung ihn findet. Sonst: abgewiesen.
//
// Ausgeschlossen: Kommission, Agent, nicht „in stock" (reserviert, angeboten, verkauft, in Reparatur, verbraucht …),
// offene Reparatur, offene Auftragsbindung, Partnerware, Edelmetall. Nur Owner (Admin), nie automatisch; geschrieben wird
// nur am Primary — der PC2 schickt dieselbe Absicht als Fernbefehl, der Primary prüft die Rolle des Absenders.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackChange, watchSyncTracks } from '@/core/sync/sync-service';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { canonicalRole } from '@/core/models/types';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAuthStore } from '@/stores/authStore';
import { postStockAdjustmentLoss, reverseSource, watchLedgerPosts } from '@/core/ledger/posting';
import { consumeLot, restoreLot, syncProductQuantity } from '@/core/lots/lot-queries';
import { belongsToConsignment } from '@/core/consignment/consignment-sale-link';
import { isBulkMetalProduct } from '@/core/bulk/bulk-product';
import { businessDateIssue, businessTimestamp } from '@/core/utils/business-date';
import { payloadHash } from '@/core/bulk/bulk-math';
import { PRODUCT_LINK_TABLES } from '@/stores/productStore';

export class StockAdjustmentRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'StockAdjustmentRejected';
  }
}
const nein = (code: string, msg: string): StockAdjustmentRejected => new StockAdjustmentRejected(code, `${msg} — nothing was changed`);

export const STOCK_ADJUSTMENT_REASONS = ['LOST', 'STOLEN', 'DAMAGED', 'COUNT_ERROR', 'OTHER'] as const;
export type StockAdjustmentReason = typeof STOCK_ADJUSTMENT_REASONS[number];
export type StockAdjustmentAccounting = 'BOOKED' | 'ACCOUNTING_RECONCILIATION_PENDING';

/** Abgeschlossene Reparaturen — jede andere bindet den Artikel. */
const REPAIR_CLOSED = ['picked_up', 'cancelled', 'returned', 'DELIVERED', 'CANCELLED'];
/** INVENTORY-Sollbuchungen dieser Herkunft sind bekannt und zuordenbar (s. Kopf); jede andere ist „unbekannt". */
const KNOWN_INVENTORY_DEBIT_SOURCES = ['PURCHASE', 'EXPENSE', 'REPAIR_OWN_WORK', 'SALES_RETURN_COGS'];

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const placeholders = (a: readonly unknown[]): string => a.map(() => '?').join(',');

export interface StockIssueLot { lotId: string; take: number; unitCost: number; qtyBefore: number; statusBefore: string }
export interface StockIssuePlan {
  productId: string;
  quantity: number;
  qtyBefore: number;
  statusBefore: string;
  path: 'LOT' | 'LOTLESS';
  lots: StockIssueLot[];
  value: number;
  accounting: StockAdjustmentAccounting;
  purchasePriceHint: number | null;
}

// ── Herkunft des Lagerwerts ─────────────────────────────────────────────────

/** Steht im ganzen Hauptbuch eine INVENTORY-Sollbuchung, die keinem bekannten Weg zuzuordnen ist? */
export function unknownInventoryDebits(): number {
  return Number(query(
    `SELECT COUNT(*) AS n FROM ledger_entries le
      WHERE le.account = 'INVENTORY' AND le.direction = 'DEBIT' AND le.reverses_entry_id IS NULL
        AND (le.source_module NOT IN (${placeholders(KNOWN_INVENTORY_DEBIT_SOURCES)})
             OR (le.source_module = 'EXPENSE' AND NOT EXISTS (
                   SELECT 1 FROM expenses e WHERE e.id = le.source_id AND e.related_module = 'repair')))`,
    KNOWN_INVENTORY_DEBIT_SOURCES,
  )[0]?.n) || 0;
}

/** Hat dieser Artikel ohne Los nachweislich NIE Lagerwert bekommen? null = ja; sonst der Grund. */
export function lotlessValueIssue(productId: string): string | null {
  if (query('SELECT 1 FROM purchase_lines WHERE product_id = ? LIMIT 1', [productId]).length > 0) {
    return 'the item has purchase lines — its inventory value is not clear without a lot';
  }
  const repairs = `SELECT id FROM repairs WHERE product_id = ?`;
  const aktiviert = query(
    `SELECT 1 FROM ledger_entries le
      WHERE le.account = 'INVENTORY' AND le.direction = 'DEBIT'
        AND ((le.source_module = 'EXPENSE' AND le.source_id IN (SELECT e.id FROM expenses e WHERE e.related_module = 'repair' AND e.related_entity_id IN (${repairs})))
          OR (le.source_module = 'REPAIR_OWN_WORK' AND json_extract(le.metadata_json, '$.repairId') IN (${repairs})))
      LIMIT 1`,
    [productId, productId],
  );
  if (aktiviert.length > 0) return 'repair costs of this item were booked to inventory';
  if (unknownInventoryDebits() > 0) return 'the ledger holds inventory bookings of unknown origin';
  return null;
}

/** Ist der Wert dieses Loses im Hauptbuch belegt (Einkaufszeile mit stehender INVENTORY-Buchung, oder Einstand 0)? */
function lotValueIssue(lot: Record<string, unknown>): string | null {
  if (Number(lot.unit_cost) === 0) return null;
  const line = lot.purchase_line_id as string | null;
  if (!line) return `lot ${String(lot.id)} does not come from a purchase (production, keep or legacy) — its inventory value is not proven`;
  const kauf = query('SELECT p.status FROM purchase_lines pl JOIN purchases p ON p.id = pl.purchase_id WHERE pl.id = ?', [line])[0];
  if (!kauf) return `the purchase line of lot ${String(lot.id)} does not exist`;
  if (String(kauf.status ?? '').toUpperCase() === 'CANCELLED') return `the purchase of lot ${String(lot.id)} is cancelled`;
  const gebucht = Number(query(
    `SELECT COALESCE(SUM(e1.amount), 0) AS t FROM ledger_entries e1
      WHERE e1.source_module = 'PURCHASE' AND e1.account = 'INVENTORY' AND e1.direction = 'DEBIT' AND e1.source_line_id = ?
        AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`,
    [line],
  )[0]?.t) || 0;
  if (!(gebucht > 0)) return `the purchase of lot ${String(lot.id)} has no inventory booking — its value is not proven`;
  return null;
}

// ── Plan (rein lesend; auch die Vorschau der Maske) ─────────────────────────

/**
 * Die Ausschlüsse, die für JEDE Korrektur gelten (Abgang und Altbestands-Zugang): nur eigene Stückware im Bestand, nicht
 * bei einem Agenten, nicht in Reparatur, nicht an einen offenen Auftrag gebunden, keine Partnerware, kein Edelmetall.
 */
function correctableOwnItem(productId: string, branchId: string): { p: Record<string, unknown>; statusBefore: string } {
  const p = query('SELECT * FROM products WHERE id = ? AND branch_id = ?', [productId, branchId])[0];
  if (!p) throw nein('PRODUCT_NOT_FOUND', 'no such item in this branch');
  if (isBulkMetalProduct(productId)) throw nein('EXCLUDED_BULK_METAL', 'bulk metal is corrected with its own write-off');
  if (String(p.source_type ?? 'OWN').toUpperCase() !== 'OWN' || belongsToConsignment(productId)) {
    throw nein('EXCLUDED_NOT_OWN', 'only own goods can be corrected here (consignment and agent goods have their own process)');
  }
  if (query("SELECT 1 FROM agent_transfers WHERE product_id = ? AND status = 'transferred' LIMIT 1", [productId]).length > 0) {
    throw nein('EXCLUDED_AGENT', 'the item is with an agent');
  }
  const statusBefore = String(p.stock_status ?? 'in_stock');
  if (statusBefore.toLowerCase() !== 'in_stock') throw nein('EXCLUDED_NOT_IN_STOCK', `the item is not in stock (status ${statusBefore})`);
  if (query(`SELECT 1 FROM repairs WHERE product_id = ? AND status NOT IN (${placeholders(REPAIR_CLOSED)}) LIMIT 1`, [productId, ...REPAIR_CLOSED]).length > 0) {
    throw nein('EXCLUDED_REPAIR', 'the item is in an open repair');
  }
  if (query(
    `SELECT 1 FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE ol.product_id = ? AND ol.invoice_id IS NULL AND o.status NOT IN ('cancelled', 'completed')
        AND COALESCE(ol.status, '') NOT IN ('CANCELLED', 'DELIVERED') LIMIT 1`, [productId]).length > 0) {
    throw nein('EXCLUDED_RESERVED', 'the item is bound to an open order');
  }
  if (query("SELECT 1 FROM item_participations WHERE product_id = ? AND party = 'PARTNER' LIMIT 1", [productId]).length > 0) {
    throw nein('EXCLUDED_PARTNER', 'partner-owned goods are not corrected here');
  }
  return { p, statusBefore };
}

export function planStockIssue(productId: string, quantity: unknown, branchId: string): StockIssuePlan {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) {
    throw nein('QUANTITY_INVALID', 'the quantity must be a whole number of pieces above 0');
  }
  const { p, statusBefore } = correctableOwnItem(productId, branchId);

  const qtyBefore = Number(p.quantity);
  if (!Number.isFinite(qtyBefore) || p.quantity === null || p.quantity === undefined) throw nein('STOCK_INCONSISTENT', 'the quantity of the item is not set');
  const lotRows = query("SELECT * FROM stock_lots WHERE product_id = ? AND unit = 'pcs' ORDER BY acquired_at ASC, id ASC", [productId]);

  if (lotRows.length > 0) {
    const active = lotRows.filter((l) => String(l.status) !== 'CANCELLED' && Number(l.qty_remaining) > 0);
    const available = active.reduce((s, l) => s + Number(l.qty_remaining), 0);
    if (available !== qtyBefore) throw nein('STOCK_INCONSISTENT', `the item shows ${qtyBefore} but its lots hold ${available}`);
    if (quantity > available) throw nein('QUANTITY_EXCEEDS_STOCK', `only ${available} in stock`);
    const lots: StockIssueLot[] = [];
    let rest = quantity;
    for (const l of active) {
      if (rest <= 0) break;
      const take = Math.min(rest, Number(l.qty_remaining));
      if (!Number.isInteger(take)) throw nein('STOCK_INCONSISTENT', `lot ${String(l.id)} holds a fraction of a piece`);
      const issue = lotValueIssue(l);
      if (issue) throw nein('VALUE_NOT_PROVEN', issue);
      lots.push({ lotId: String(l.id), take, unitCost: Number(l.unit_cost) || 0, qtyBefore: Number(l.qty_remaining), statusBefore: String(l.status) });
      rest -= take;
    }
    const value = round3(lots.reduce((s, l) => s + l.take * l.unitCost, 0));
    return { productId, quantity, qtyBefore, statusBefore, path: 'LOT', lots, value, accounting: 'BOOKED', purchasePriceHint: null };
  }

  if (!Number.isInteger(qtyBefore)) throw nein('STOCK_INCONSISTENT', 'the quantity of the item is not a whole number');
  if (quantity > qtyBefore) throw nein('QUANTITY_EXCEEDS_STOCK', `only ${qtyBefore} in stock`);
  const issue = lotlessValueIssue(productId);
  if (issue) throw nein('VALUE_NOT_PROVEN', `${issue} — this correction needs an accounting decision`);
  const hint = p.purchase_price === null || p.purchase_price === undefined ? null : Number(p.purchase_price);
  return {
    productId, quantity, qtyBefore, statusBefore, path: 'LOTLESS', lots: [], value: 0,
    accounting: 'ACCOUNTING_RECONCILIATION_PENDING', purchasePriceHint: hint,
  };
}

// ── Abgang ──────────────────────────────────────────────────────────────────

export interface StockIssueInput {
  actionId: string; productId: string; quantity: number; expectedQuantity: number;
  reasonCategory: string; reason: string; businessDate?: string;
}
export interface StockAdjustmentResult {
  adjustmentId: string; adjustmentNumber: string; productId: string; quantity: number;
  qtyBefore: number; qtyAfter: number; accounting: StockAdjustmentAccounting; value: number; status: 'POSTED' | 'CANCELLED';
  /**
   * ISSUE = Abgang; RECEIPT = zusätzlich erfasster Altbestand (nur Menge, Eröffnung offen); CORRECTION = die erste Mengeneingabe
   * eines unberührten Artikels war falsch („Correct initial qty") — keine Bewegung, keine Buchung.
   */
  direction: 'ISSUE' | 'RECEIPT' | 'CORRECTION';
  /** Abgang ohne Los: Einkaufspreis als Hinweis; Altbestand: der historische Einstand je Stück. */
  unitCostHint: number | null;
  reasonCategory: string;
  businessDate: string;
}
export interface AdjustmentCtx { branchId: string; userId: string; now: string; role?: string }

function assertOwner(ctx: AdjustmentCtx): void {
  if (canonicalRole(ctx.role) !== 'ADMIN') throw nein('PERMISSION_DENIED', 'only the owner (admin) may correct stock');
}

function resultOf(row: Record<string, unknown>): StockAdjustmentResult {
  return {
    adjustmentId: String(row.id), adjustmentNumber: String(row.adjustment_number), productId: String(row.product_id),
    quantity: Number(row.quantity), qtyBefore: Number(row.qty_before), qtyAfter: Number(row.qty_after),
    accounting: String(row.accounting) as StockAdjustmentAccounting, value: Number(row.value_booked) || 0,
    status: String(row.status) as 'POSTED' | 'CANCELLED',
    direction: String(row.direction) === 'RECEIPT' ? 'RECEIPT' : String(row.direction) === 'CORRECTION' ? 'CORRECTION' : 'ISSUE',
    unitCostHint: row.purchase_price_hint === null || row.purchase_price_hint === undefined ? null : Number(row.purchase_price_hint),
    reasonCategory: String(row.reason_category ?? ''),
    businessDate: String(row.business_date ?? ''),
  };
}

/** In der Transaktion des Aufrufers: der Abgang — ganz oder gar nicht. */
export function issueStockInHouse(input: StockIssueInput, ctx: AdjustmentCtx): StockAdjustmentResult {
  assertOwner(ctx);
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 100) throw nein('ACTION_ID_REQUIRED', 'a stable action id is required');
  const reasonCategory = String(input.reasonCategory ?? '');
  if (!(STOCK_ADJUSTMENT_REASONS as readonly string[]).includes(reasonCategory)) throw nein('REASON_REQUIRED', 'choose why the stock is corrected');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please describe what happened');
  const businessDate = input.businessDate || ctx.now.slice(0, 10);
  const dateIssue = businessDateIssue(businessDate, 'Business date');
  if (dateIssue) throw nein('INVALID_DATE', dateIssue);
  const hash = payloadHash({ op: 'stock_issue', productId: input.productId, quantity: input.quantity, reasonCategory, reason, businessDate });

  // Wiederholung derselben Absicht (Doppelklick, verlorene Antwort): dieselbe Antwort, keine zweite Wirkung.
  const schon = query('SELECT * FROM stock_adjustments WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (schon) {
    if (String(schon.payload_hash) !== hash) throw nein('ACTION_ID_CONFLICT', 'this action id was already used for a different correction');
    return resultOf(schon);
  }

  const plan = planStockIssue(input.productId, input.quantity, ctx.branchId);
  if (input.expectedQuantity !== plan.qtyBefore) {
    throw nein('STOCK_CHANGED', `the stock changed meanwhile (you saw ${input.expectedQuantity}, it is now ${plan.qtyBefore}) — reload`);
  }

  const buchung = watchLedgerPosts('stock adjustment');
  const abgleich = watchSyncTracks('stock adjustment');
  const db = getDatabase();
  const id = uuid();
  const number = getNextDocumentNumber('ADJ');

  if (plan.path === 'LOT') {
    for (const l of plan.lots) {
      if (!consumeLot(l.lotId, l.take)) throw nein('STOCK_CHANGED', `lot ${l.lotId} could not give ${l.take}`);
    }
    syncProductQuantity(input.productId);
  } else {
    db.run('UPDATE products SET quantity = quantity - ? WHERE id = ? AND quantity = ?', [plan.quantity, input.productId, plan.qtyBefore]);
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('STOCK_CHANGED', 'the item changed meanwhile');
  }
  const qtyAfter = Number(query('SELECT quantity FROM products WHERE id = ?', [input.productId])[0]?.quantity);
  if (qtyAfter !== plan.qtyBefore - plan.quantity) throw nein('STOCK_INCONSISTENT', `the stock is ${qtyAfter} instead of ${plan.qtyBefore - plan.quantity}`);
  // Ein Abgang auf 0 ist kein Verkauf: der Artikel ist abgeschrieben (`write_off`); sonst bleibt sein Status.
  const statusAfter = qtyAfter === 0 ? 'write_off' : plan.statusBefore;
  db.run('UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?', [statusAfter, ctx.now, input.productId]);
  trackChange('products', input.productId, 'update', {});

  db.run(
    `INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after,
       status_before, status_after, accounting, value_booked, purchase_price_hint, lots_json, reason_category, reason,
       business_date, status, action_id, payload_hash, created_by, created_at, revision)
     VALUES (?, ?, ?, ?, 'ISSUE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, 0)`,
    [id, ctx.branchId, number, input.productId, plan.quantity, plan.qtyBefore, qtyAfter, plan.statusBefore, statusAfter,
      plan.accounting, plan.value, plan.purchasePriceHint, JSON.stringify(plan.lots), reasonCategory, reason,
      businessDate, actionId, hash, ctx.userId || null, ctx.now],
  );
  trackChange('stock_adjustments', id, 'insert', {});

  if (plan.path === 'LOT' && plan.value > 0) {
    postStockAdjustmentLoss({
      adjustmentId: id, adjustmentNumber: number, productId: input.productId, amount: plan.value, reason,
      occurredAt: businessTimestamp(businessDate, ctx.now), branchId: ctx.branchId, userId: ctx.userId,
    });
  }

  const actor = { userId: ctx.userId, branchId: ctx.branchId };
  logAuditOrThrow({
    module: 'Stock', entityType: 'stock_adjustments', entityId: id, action: 'CREATE',
    newValue: { adjustmentNumber: number, productId: input.productId, direction: 'ISSUE', quantity: plan.quantity,
      qtyBefore: plan.qtyBefore, qtyAfter, statusBefore: plan.statusBefore, statusAfter, accounting: plan.accounting,
      value: plan.value, purchasePriceHint: plan.purchasePriceHint, lots: plan.lots, reasonCategory, reason, businessDate },
    actor,
  });
  logAuditOrThrow({
    module: 'Product', entityType: 'products', entityId: input.productId, action: 'UPDATE', field: 'quantity',
    oldValue: plan.qtyBefore, newValue: { quantity: qtyAfter, adjustmentNumber: number, accounting: plan.accounting }, actor,
  });
  buchung();
  abgleich();
  return resultOf(query('SELECT * FROM stock_adjustments WHERE id = ?', [id])[0]);
}

// ── Storno ──────────────────────────────────────────────────────────────────

export interface StockAdjustmentCancelInput { adjustmentId: string; reason: string }

/**
 * In der Transaktion des Aufrufers: den Abgang exakt zurück — nur solange seitdem nichts anderes am Bestand des Artikels
 * geschah (Menge, Status und jedes entnommene Los stehen genau so, wie der Abgang sie hinterließ). Sonst wäre die
 * Wiederherstellung mehrdeutig (z. B. das Stück inzwischen verkauft) → abgewiesen.
 */
export function cancelStockAdjustmentInHouse(input: StockAdjustmentCancelInput, ctx: AdjustmentCtx): StockAdjustmentResult {
  assertOwner(ctx);
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please give a reason for the cancellation');
  const row = query('SELECT * FROM stock_adjustments WHERE id = ? AND branch_id = ?', [input.adjustmentId, ctx.branchId])[0];
  if (!row) throw nein('ADJUSTMENT_NOT_FOUND', 'no such stock adjustment in this branch');
  if (String(row.status) === 'CANCELLED') throw nein('ALREADY_CANCELLED', `stock adjustment ${String(row.adjustment_number)} is already cancelled`);
  // INITIAL QTY — eine Eingabekorrektur ist kein Bestandsvorgang: sie wird nicht storniert, sondern (solange der Artikel
  // unberührt ist) noch einmal korrigiert.
  if (String(row.direction) === 'CORRECTION') {
    throw nein('CORRECTION_NOT_CANCELLABLE', `${String(row.adjustment_number)} corrected the first quantity entry — correct the quantity again instead`);
  }
  const productId = String(row.product_id);
  const qty = Number(row.quantity);
  const p = query('SELECT quantity, stock_status FROM products WHERE id = ?', [productId])[0];
  if (!p) throw nein('PRODUCT_NOT_FOUND', 'the item of this adjustment does not exist');
  if (Number(p.quantity) !== Number(row.qty_after) || String(p.stock_status ?? '') !== String(row.status_after ?? '')) {
    throw nein('MOVED_SINCE', `the stock of this item changed after ${String(row.adjustment_number)} — the cancellation would not be exact`);
  }
  let lots: StockIssueLot[] = [];
  try { lots = JSON.parse(String(row.lots_json || '[]')) as StockIssueLot[]; } catch { throw nein('MOVED_SINCE', 'the lots of this adjustment cannot be read'); }
  for (const l of lots) {
    const lot = query('SELECT qty_remaining, qty_total, status FROM stock_lots WHERE id = ?', [l.lotId])[0];
    const nachher = l.qtyBefore - l.take;
    if (!lot || String(lot.status) === 'CANCELLED' || Number(lot.qty_remaining) !== nachher
      || String(lot.status) !== (nachher <= 0 ? 'EXHAUSTED' : 'ACTIVE') || l.qtyBefore > Number(lot.qty_total)) {
      throw nein('MOVED_SINCE', `lot ${l.lotId} changed after ${String(row.adjustment_number)} — the cancellation would not be exact`);
    }
  }

  const buchung = watchLedgerPosts('cancel stock adjustment');
  const abgleich = watchSyncTracks('cancel stock adjustment');
  const db = getDatabase();
  if (lots.length > 0) {
    for (const l of lots) {
      if (!restoreLot(l.lotId, l.take)) throw nein('MOVED_SINCE', `lot ${l.lotId} could not be restored`);
    }
    syncProductQuantity(productId);
  } else {
    // Ein Abgang gibt die Stücke zurück; ein Altbestands-Zugang (RECEIPT) nimmt sie wieder heraus.
    const delta = String(row.direction) === 'RECEIPT' ? -qty : qty;
    db.run('UPDATE products SET quantity = quantity + ? WHERE id = ? AND quantity = ?', [delta, productId, Number(row.qty_after)]);
    if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('MOVED_SINCE', 'the item changed meanwhile');
  }
  const qtyNow = Number(query('SELECT quantity FROM products WHERE id = ?', [productId])[0]?.quantity);
  if (qtyNow !== Number(row.qty_before)) throw nein('STOCK_INCONSISTENT', `the stock would be ${qtyNow} instead of ${Number(row.qty_before)}`);
  db.run('UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?', [row.status_before ?? 'in_stock', ctx.now, productId]);
  trackChange('products', productId, 'update', {});
  if (Number(row.value_booked) > 0) reverseSource('STOCK_ADJUST', String(row.id), ctx.now);
  db.run(
    `UPDATE stock_adjustments SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, revision = revision + 1
      WHERE id = ? AND status = 'POSTED'`,
    [ctx.now, ctx.userId || null, reason, String(row.id)],
  );
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('ALREADY_CANCELLED', 'the adjustment changed meanwhile');
  trackChange('stock_adjustments', String(row.id), 'update', {});
  const actor = { userId: ctx.userId, branchId: ctx.branchId };
  logAuditOrThrow({
    module: 'Stock', entityType: 'stock_adjustments', entityId: String(row.id), action: 'STATUS_CHANGE', field: 'status',
    oldValue: 'POSTED', newValue: { status: 'CANCELLED', adjustmentNumber: row.adjustment_number, reason }, actor,
  });
  logAuditOrThrow({
    module: 'Product', entityType: 'products', entityId: productId, action: 'UPDATE', field: 'quantity',
    oldValue: Number(row.qty_after), newValue: { quantity: qtyNow, cancelledAdjustment: row.adjustment_number }, actor,
  });
  buchung();
  abgleich();
  return resultOf(query('SELECT * FROM stock_adjustments WHERE id = ?', [String(row.id)])[0]);
}

// ── Altbestand zusätzlich erfassen („Add Old Stock") ─────────────────────────
//
// Bestätigte Regel (Owner, 14.10.2026): New Collection, Handy und Excel-Import erfassen vorhandene eigene Ware
// (Altbestand) — ohne Geld, ohne Einkauf, ohne Lieferantenschuld; der Einkaufspreis ist der historische Einstand.
// Findet der Owner weitere Stücke eines schon erfassten Artikels, nimmt er sie hier auf: ein nummerierter Beleg
// (RECEIPT) mit Menge, historischem Einstand je Stück, Grund und Protokoll — und KEINE Buchung. Der Beleg steht immer
// auf ACCOUNTING_RECONCILIATION_PENDING: die einmalige Eröffnung (Phase 3) nimmt ihn später auf, nach den Regeln des
// Buchhalters. Fail-closed, und deshalb hier NICHT erlaubt (BLOCKED bis zu den Eröffnungsregeln):
//   • Artikel mit Losen (Einkauf, Produktion, „Keep", später Eröffnung): Lose und Menge müssen übereinstimmen; ein
//     Stück ohne Los daneben hätte keinen belegten Wert, ein erfundenes Los wäre eine erfundene Aktivierung;
//   • Artikel mit Lagerwert-Buchung (Einkaufszeile, aktivierte Reparaturkosten) oder ein Hauptbuch mit INVENTORY-
//     Sollbuchungen unbekannter Herkunft — dieselbe Herkunftsregel wie beim Abgang ohne Los;
//   • ausverkaufte oder nicht freie Artikel (dieselben Ausschlüsse wie beim Abgang).
// Ein früher als verloren ausgebuchtes Stück ist KEIN Altbestand: hat der Artikel offene Abgänge, muss der Owner
// ausdrücklich bestätigen, dass es andere Stücke sind (die Wiederherstellung eines Abgangs wartet auf D1c).

export const OLD_STOCK_REASON = 'OLD_STOCK';
const MAX_OLD_STOCK_PIECES = 100_000;

export interface OldStockReceiptPlan {
  productId: string;
  quantity: number;
  qtyBefore: number;
  statusBefore: string;
  unitCost: number;
  itemCost: number | null;
  /** Offene Abgänge dieses Artikels (nicht storniert) — ein wiedergefundenes Stück gehört dorthin, nicht hierher. */
  openRemovals: Array<{ adjustmentNumber: string; quantity: number; accounting: StockAdjustmentAccounting }>;
}

export function planOldStockReceipt(productId: string, quantity: unknown, unitCost: unknown, branchId: string): OldStockReceiptPlan {
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_OLD_STOCK_PIECES) {
    throw nein('QUANTITY_INVALID', 'the quantity must be a whole number of pieces above 0');
  }
  if (typeof unitCost !== 'number' || !Number.isFinite(unitCost) || unitCost < 0) {
    throw nein('COST_REQUIRED', 'enter the historical cost per piece (0 or more)');
  }
  const { p, statusBefore } = correctableOwnItem(productId, branchId);
  const qtyBefore = Number(p.quantity);
  if (p.quantity === null || p.quantity === undefined || !Number.isInteger(qtyBefore) || qtyBefore < 0) {
    throw nein('STOCK_INCONSISTENT', 'the quantity of the item is not a whole number');
  }
  if (query('SELECT 1 FROM stock_lots WHERE product_id = ? LIMIT 1', [productId]).length > 0) {
    throw nein('BLOCKED_HAS_LOTS', 'the item has lots (purchase, production or opening) — adding old-stock pieces to it needs the opening rules of the accountant; record them as a new item through New Collection');
  }
  const issue = lotlessValueIssue(productId);
  if (issue) throw nein('VALUE_NOT_PROVEN', `${issue} — old stock cannot be added to it without accounting rules`);
  const openRemovals = query(
    "SELECT adjustment_number, quantity, accounting FROM stock_adjustments WHERE product_id = ? AND branch_id = ? AND direction = 'ISSUE' AND status = 'POSTED' ORDER BY created_at",
    [productId, branchId],
  ).map((r) => ({ adjustmentNumber: String(r.adjustment_number), quantity: Number(r.quantity), accounting: String(r.accounting) as StockAdjustmentAccounting }));
  const itemCost = p.purchase_price === null || p.purchase_price === undefined ? null : Number(p.purchase_price);
  return { productId, quantity, qtyBefore, statusBefore, unitCost: round3(unitCost), itemCost, openRemovals };
}

export interface OldStockReceiptInput {
  actionId: string; productId: string; quantity: number; expectedQuantity: number;
  unitCost: number; reason: string; businessDate?: string;
  /** Pflicht, wenn der Artikel offene Abgänge hat: „das sind andere Stücke, keins der ausgebuchten". */
  confirmNotRemovedPiece?: boolean;
}

/** In der Transaktion des Aufrufers: Altbestand zusätzlich erfassen — nur Menge, Beleg, Protokoll, Sync; keine Buchung. */
export function addOldStockInHouse(input: OldStockReceiptInput, ctx: AdjustmentCtx): StockAdjustmentResult {
  assertOwner(ctx);
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 100) throw nein('ACTION_ID_REQUIRED', 'a stable action id is required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please describe where these pieces come from');
  const businessDate = input.businessDate || ctx.now.slice(0, 10);
  const dateIssue = businessDateIssue(businessDate, 'Business date');
  if (dateIssue) throw nein('INVALID_DATE', dateIssue);
  const confirmed = input.confirmNotRemovedPiece === true;
  const hash = payloadHash({ op: 'old_stock_receipt', productId: input.productId, quantity: input.quantity, unitCost: input.unitCost, reason, businessDate, confirmed });

  const schon = query('SELECT * FROM stock_adjustments WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (schon) {
    if (String(schon.payload_hash) !== hash) throw nein('ACTION_ID_CONFLICT', 'this action id was already used for a different correction');
    return resultOf(schon);
  }

  const plan = planOldStockReceipt(input.productId, input.quantity, input.unitCost, ctx.branchId);
  if (input.expectedQuantity !== plan.qtyBefore) {
    throw nein('STOCK_CHANGED', `the stock changed meanwhile (you saw ${input.expectedQuantity}, it is now ${plan.qtyBefore}) — reload`);
  }
  if (plan.openRemovals.length > 0 && !confirmed) {
    throw nein('REMOVED_PIECE_CHECK', `this item has removals (${plan.openRemovals.map((r) => r.adjustmentNumber).join(', ')}): if a found piece is one of them, cancel that removal instead; confirm that these are other pieces of old stock`);
  }

  const buchung = watchLedgerPosts('old stock receipt');
  const abgleich = watchSyncTracks('old stock receipt');
  const db = getDatabase();
  const id = uuid();
  const number = getNextDocumentNumber('ADJ');
  db.run('UPDATE products SET quantity = quantity + ?, updated_at = ? WHERE id = ? AND quantity = ?', [plan.quantity, ctx.now, input.productId, plan.qtyBefore]);
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('STOCK_CHANGED', 'the item changed meanwhile');
  const qtyAfter = Number(query('SELECT quantity FROM products WHERE id = ?', [input.productId])[0]?.quantity);
  if (qtyAfter !== plan.qtyBefore + plan.quantity) throw nein('STOCK_INCONSISTENT', `the stock is ${qtyAfter} instead of ${plan.qtyBefore + plan.quantity}`);
  trackChange('products', input.productId, 'update', {});

  db.run(
    `INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after,
       status_before, status_after, accounting, value_booked, purchase_price_hint, lots_json, reason_category, reason,
       business_date, status, action_id, payload_hash, created_by, created_at, revision)
     VALUES (?, ?, ?, ?, 'RECEIPT', ?, ?, ?, ?, ?, 'ACCOUNTING_RECONCILIATION_PENDING', 0, ?, '[]', ?, ?, ?, 'POSTED', ?, ?, ?, ?, 0)`,
    [id, ctx.branchId, number, input.productId, plan.quantity, plan.qtyBefore, qtyAfter, plan.statusBefore, plan.statusBefore,
      plan.unitCost, OLD_STOCK_REASON, reason, businessDate, actionId, hash, ctx.userId || null, ctx.now],
  );
  trackChange('stock_adjustments', id, 'insert', {});

  const actor = { userId: ctx.userId, branchId: ctx.branchId };
  logAuditOrThrow({
    module: 'Stock', entityType: 'stock_adjustments', entityId: id, action: 'CREATE',
    newValue: { adjustmentNumber: number, productId: input.productId, direction: 'RECEIPT', quantity: plan.quantity,
      qtyBefore: plan.qtyBefore, qtyAfter, unitCost: plan.unitCost, itemCost: plan.itemCost, accounting: 'ACCOUNTING_RECONCILIATION_PENDING',
      reasonCategory: OLD_STOCK_REASON, reason, businessDate,
      openRemovals: plan.openRemovals.map((r) => r.adjustmentNumber), confirmedNotRemoved: plan.openRemovals.length > 0 ? confirmed : null },
    actor,
  });
  logAuditOrThrow({
    module: 'Product', entityType: 'products', entityId: input.productId, action: 'UPDATE', field: 'quantity',
    oldValue: plan.qtyBefore, newValue: { quantity: qtyAfter, adjustmentNumber: number, oldStock: true, accounting: 'ACCOUNTING_RECONCILIATION_PENDING' }, actor,
  });
  buchung();
  abgleich();
  return resultOf(query('SELECT * FROM stock_adjustments WHERE id = ?', [id])[0]);
}

// ── Anfangsmenge korrigieren („Correct initial qty") ─────────────────────────
//
// Owner-Entscheidung (15.10.2026): Eine falsch ERFASSTE Menge (5 eingegeben, 3 Stück da) wird korrigiert, ohne einen
// künstlichen Lagerverlust oder Altbestands-Zugang zu erzeugen. Das ist keine Bestandsbewegung, sondern die Berichtigung
// der ersten Eingabe — deshalb nur an einem nachweislich UNBERÜHRTEN Artikel (fail-closed):
//   • dieselben Ausschlüsse wie jede Korrektur (eigene Stückware, frei, nicht bei Agent/Reparatur/Auftrag/Partner, kein
//     Edelmetall) — `correctableOwnItem`;
//   • keine Lose, keine Einkaufszeile, kein gebuchter Lagerwert, keine INVENTORY-Buchung unbekannter Herkunft
//     (`lotlessValueIssue`) — der Wert des Artikels ist noch nirgends gebucht;
//   • kein einziger Beleg am Artikel: Rechnung (auch Entwurf/storniert), Angebot, Auftrag, Kommission, Agent, Reparatur,
//     Retoure, Produktion, Beteiligung, Bestandskorrektur (Abgang oder Altbestand, auch storniert) — Liste wie die
//     Löschsperre (`PRODUCT_LINK_TABLES`); nur frühere Eingabekorrekturen desselben Artikels zählen nicht;
//   • keine protokollierte Mengenänderung außerhalb dieser Korrektur (Zusammenführen, frühere freie Bearbeitung).
// Gebucht wird nichts (kein Geld, kein Einkauf, keine VAT, kein Lagerverlust); der Beleg (Richtung CORRECTION) hält Menge
// vorher/nachher, Grund, Zeit und Owner fest. Die Eröffnungsvorschau rechnet danach mit der berichtigten Menge (sie liest
// die Artikelmenge; CORRECTION ist dort weder Zugang noch Abgang). Ein Storno gibt es nicht — nur eine weitere Korrektur.

export const INITIAL_QTY_REASON = 'INITIAL_QTY';

export interface InitialQtyPlan {
  productId: string;
  qtyBefore: number;
  qtyAfter: number;
  delta: number;
  statusBefore: string;
  itemCost: number | null;
  /** Frühere Eingabekorrekturen dieses Artikels (dürfen sein). */
  earlierCorrections: string[];
}

/** Hat dieser Artikel IRGENDEINE Vorgeschichte außer seiner Erfassung (und früheren Eingabekorrekturen)? null = nein. */
function initialQtyHistoryIssue(productId: string): string | null {
  const gefunden: string[] = [];
  for (const t of PRODUCT_LINK_TABLES) {
    const n = t.table === 'stock_adjustments'
      ? Number(query("SELECT COUNT(*) AS n FROM stock_adjustments WHERE product_id = ? AND direction != 'CORRECTION'", [productId])[0]?.n) || 0
      : Number(query(`SELECT COUNT(*) AS n FROM ${t.table} WHERE product_id = ?`, [productId])[0]?.n) || 0;
    if (n > 0 && !gefunden.includes(t.label)) gefunden.push(t.label);
  }
  if (query('SELECT 1 FROM item_participations WHERE product_id = ? LIMIT 1', [productId]).length > 0) gefunden.push('Participation');
  if (gefunden.length > 0) return `the item already has documents (${gefunden.join(', ')}) — its quantity is no longer just the first entry`;
  // Protokollierte Mengenänderungen, die nicht aus dieser Korrektur stammen (Zusammenführen, freie Bearbeitung vor F9).
  const fremd = query(
    `SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'products' AND entity_id = ? AND field_name = 'quantity'
       AND action_type IN ('UPDATE', 'MERGE') AND COALESCE(new_value, '') NOT LIKE '%"initialQtyCorrection":true%'`,
    [productId],
  );
  if ((Number(fremd[0]?.n) || 0) > 0) return 'the quantity of this item was changed before (merge or an earlier edit) — its history is not just the first entry';
  return null;
}

export function planInitialQtyCorrection(productId: string, newQuantity: unknown, branchId: string): InitialQtyPlan {
  if (typeof newQuantity !== 'number' || !Number.isInteger(newQuantity) || newQuantity < 1 || newQuantity > MAX_OLD_STOCK_PIECES) {
    throw nein('QUANTITY_INVALID', 'the correct quantity is a whole number of pieces, at least 1 (an item that does not exist is deleted, not corrected)');
  }
  const { p, statusBefore } = correctableOwnItem(productId, branchId);
  const qtyBefore = Number(p.quantity);
  if (p.quantity === null || p.quantity === undefined || !Number.isInteger(qtyBefore) || qtyBefore < 1) {
    throw nein('STOCK_INCONSISTENT', 'the quantity of the item is not a whole number of pieces');
  }
  if (newQuantity === qtyBefore) throw nein('QUANTITY_UNCHANGED', `the item already shows ${qtyBefore}`);
  if (query('SELECT 1 FROM stock_lots WHERE product_id = ? LIMIT 1', [productId]).length > 0) {
    throw nein('BLOCKED_HAS_LOTS', 'the item has lots (purchase, production or return) — its quantity follows those documents');
  }
  const history = initialQtyHistoryIssue(productId);
  if (history) throw nein('HAS_HISTORY', `${history}; use Add old stock or Remove from stock instead`);
  const value = lotlessValueIssue(productId);
  if (value) throw nein('VALUE_NOT_PROVEN', `${value} — the first quantity entry cannot be corrected without accounting rules`);
  const earlierCorrections = query(
    "SELECT adjustment_number FROM stock_adjustments WHERE product_id = ? AND direction = 'CORRECTION' ORDER BY created_at", [productId],
  ).map((r) => String(r.adjustment_number));
  const itemCost = p.purchase_price === null || p.purchase_price === undefined ? null : Number(p.purchase_price);
  return { productId, qtyBefore, qtyAfter: newQuantity, delta: newQuantity - qtyBefore, statusBefore, itemCost, earlierCorrections };
}

export interface InitialQtyInput {
  actionId: string; productId: string; newQuantity: number; expectedQuantity: number; reason: string;
}

/** In der Transaktion des Aufrufers: die erste Mengeneingabe berichtigen — Menge, Beleg, Protokoll, Sync; KEINE Buchung. */
export function correctInitialQtyInHouse(input: InitialQtyInput, ctx: AdjustmentCtx): StockAdjustmentResult {
  assertOwner(ctx);
  const actionId = typeof input.actionId === 'string' ? input.actionId.trim() : '';
  if (actionId.length < 8 || actionId.length > 100) throw nein('ACTION_ID_REQUIRED', 'a stable action id is required');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw nein('REASON_REQUIRED', 'please describe what was entered wrongly');
  if (reason.length > 500) throw nein('INVALID_INPUT', 'the reason is longer than 500 characters');
  const hash = payloadHash({ op: 'initial_qty_correction', productId: input.productId, newQuantity: input.newQuantity, expectedQuantity: input.expectedQuantity, reason });

  const schon = query('SELECT * FROM stock_adjustments WHERE branch_id = ? AND action_id = ?', [ctx.branchId, actionId])[0];
  if (schon) {
    if (String(schon.payload_hash) !== hash) throw nein('ACTION_ID_CONFLICT', 'this action id was already used for a different correction');
    return resultOf(schon);
  }

  const plan = planInitialQtyCorrection(input.productId, input.newQuantity, ctx.branchId);
  // Der Stand, den die Maske gesehen hat — sonst korrigierte ein veraltetes Fenster (PC2) eine inzwischen andere Menge.
  if (input.expectedQuantity !== plan.qtyBefore) {
    throw nein('STOCK_CHANGED', `the quantity changed meanwhile (you saw ${input.expectedQuantity}, it is now ${plan.qtyBefore}) — reload`);
  }

  const buchung = watchLedgerPosts('initial quantity correction');
  const abgleich = watchSyncTracks('initial quantity correction');
  const db = getDatabase();
  const id = uuid();
  const number = getNextDocumentNumber('ADJ');
  const businessDate = ctx.now.slice(0, 10);
  db.run('UPDATE products SET quantity = ?, updated_at = ? WHERE id = ? AND quantity = ?', [plan.qtyAfter, ctx.now, input.productId, plan.qtyBefore]);
  if (Number(query('SELECT changes() AS n')[0]?.n) !== 1) throw nein('STOCK_CHANGED', 'the item changed meanwhile');
  trackChange('products', input.productId, 'update', {});
  db.run(
    `INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after,
       status_before, status_after, accounting, value_booked, purchase_price_hint, lots_json, reason_category, reason,
       business_date, status, action_id, payload_hash, created_by, created_at, revision)
     VALUES (?, ?, ?, ?, 'CORRECTION', ?, ?, ?, ?, ?, 'ACCOUNTING_RECONCILIATION_PENDING', 0, ?, '[]', ?, ?, ?, 'POSTED', ?, ?, ?, ?, 0)`,
    [id, ctx.branchId, number, input.productId, Math.abs(plan.delta), plan.qtyBefore, plan.qtyAfter, plan.statusBefore, plan.statusBefore,
      plan.itemCost, INITIAL_QTY_REASON, reason, businessDate, actionId, hash, ctx.userId || null, ctx.now],
  );
  trackChange('stock_adjustments', id, 'insert', {});

  const actor = { userId: ctx.userId, branchId: ctx.branchId };
  logAuditOrThrow({
    module: 'Stock', entityType: 'stock_adjustments', entityId: id, action: 'CREATE',
    newValue: { adjustmentNumber: number, productId: input.productId, direction: 'CORRECTION', qtyBefore: plan.qtyBefore, qtyAfter: plan.qtyAfter,
      reasonCategory: INITIAL_QTY_REASON, reason, booking: 'none (input correction)', earlierCorrections: plan.earlierCorrections, initialQtyCorrection: true },
    actor,
  });
  logAuditOrThrow({
    module: 'Product', entityType: 'products', entityId: input.productId, action: 'UPDATE', field: 'quantity',
    oldValue: plan.qtyBefore, newValue: { quantity: plan.qtyAfter, adjustmentNumber: number, initialQtyCorrection: true }, actor,
  });
  buchung();
  abgleich();
  return resultOf(query('SELECT * FROM stock_adjustments WHERE id = ?', [id])[0]);
}

export interface InitialQtyPreview { plan: InitialQtyPlan | null; issue: string | null; code: string | null }

export function initialQtyPreviewFor(ctx: { branchId: string }, productId: string, newQuantity: unknown): InitialQtyPreview {
  try { return { plan: planInitialQtyCorrection(productId, newQuantity, ctx.branchId), issue: null, code: null }; }
  catch (e) { return { plan: null, issue: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null }; }
}

// ── Lesen (Karte am Primary und, als Fernauskunft `stock_adjustments.product.get`, am PC2) ──────────
// Die Filiale kommt aus dem Kontext (am PC2: aus dem geprüften Absender), nie aus dem Rumpf.

export interface StockIssuePreview { plan: StockIssuePlan | null; issue: string | null; code: string | null }
export interface OldStockReceiptPreview { plan: OldStockReceiptPlan | null; issue: string | null; code: string | null }
export interface StockCorrectionsRead { docs: StockAdjustmentResult[]; issuePreview: StockIssuePreview | null; receiptPreview: OldStockReceiptPreview | null; correctionPreview?: InitialQtyPreview | null }

export function oldStockReceiptPreviewFor(ctx: { branchId: string }, productId: string, quantity: unknown, unitCost: unknown): OldStockReceiptPreview {
  try { return { plan: planOldStockReceipt(productId, quantity, unitCost, ctx.branchId), issue: null, code: null }; }
  catch (e) { return { plan: null, issue: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null }; }
}

export function stockAdjustmentsFor(ctx: { branchId: string }, productId: string): StockAdjustmentResult[] {
  return query('SELECT * FROM stock_adjustments WHERE product_id = ? AND branch_id = ? ORDER BY created_at DESC', [productId, ctx.branchId]).map(resultOf);
}

/** Die Vorschau der Maske: der Plan, oder der Grund, warum nicht. */
export function stockIssuePreviewFor(ctx: { branchId: string }, productId: string, quantity: unknown): StockIssuePreview {
  try { return { plan: planStockIssue(productId, quantity, ctx.branchId), issue: null, code: null }; }
  catch (e) { return { plan: null, issue: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code ?? null }; }
}

/** Alles, was die Karte „Stock corrections" zeichnet: die Belege und — wenn eine Menge genannt ist — die Vorschau. */
export function stockCorrectionsFor(
  ctx: { branchId: string },
  input: { productId: string; issueQuantity?: unknown; receiptQuantity?: unknown; receiptUnitCost?: unknown; correctionQuantity?: unknown },
): StockCorrectionsRead {
  const leer = (v: unknown): boolean => v === undefined || v === null;
  return {
    docs: stockAdjustmentsFor(ctx, input.productId),
    issuePreview: leer(input.issueQuantity) ? null : stockIssuePreviewFor(ctx, input.productId, input.issueQuantity),
    receiptPreview: leer(input.receiptQuantity) ? null : oldStockReceiptPreviewFor(ctx, input.productId, input.receiptQuantity, input.receiptUnitCost),
    correctionPreview: leer(input.correctionQuantity) ? null : initialQtyPreviewFor(ctx, input.productId, input.correctionQuantity),
  };
}

export function stockAdjustmentsOf(productId: string): StockAdjustmentResult[] {
  return stockAdjustmentsFor({ branchId: currentBranchId() }, productId);
}

export function previewStockIssue(productId: string, quantity: number): StockIssuePreview {
  return stockIssuePreviewFor({ branchId: currentBranchId() }, productId, quantity);
}

// ── Anschlüsse am Primary: exklusiv, EINE Transaktion, erst danach durabel ──────
// Der PC2 schreibt nie selbst: er schickt dieselbe Eingabe als Fernbefehl (`stock_adjustments.issue` /
// `.cancel`, `core/bridge/stock-adjustment-commands.ts`); der Primary fährt dieselbe Hausfolge mit der Rolle des
// geprüften Absenders. Diese lokalen Anschlüsse weisen am PC2 deshalb ab.

function localCtx(): AdjustmentCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}
const nurPrimary = (): Promise<never> => Promise.reject(new StockAdjustmentRejected('PRIMARY_ONLY', 'this computer writes stock corrections through the main computer'));

export function issueStockOnPrimary(input: StockIssueInput, reload: () => void): Promise<StockAdjustmentResult> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => issueStockInHouse(input, localCtx()), reload);
}
export function cancelStockAdjustmentOnPrimary(input: StockAdjustmentCancelInput, reload: () => void): Promise<StockAdjustmentResult> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => cancelStockAdjustmentInHouse(input, localCtx()), reload);
}
export function addOldStockOnPrimary(input: OldStockReceiptInput, reload: () => void): Promise<StockAdjustmentResult> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => addOldStockInHouse(input, localCtx()), reload);
}
export function correctInitialQtyOnPrimary(input: InitialQtyInput, reload: () => void): Promise<StockAdjustmentResult> {
  if (isClientMode()) return nurPrimary();
  return runOnPrimary(() => correctInitialQtyInHouse(input, localCtx()), reload);
}

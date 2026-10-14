// ════════════════════════════════════════════════════════════════════════════
// OLD STOCK — die schreibgeschützte Eröffnungsvorschau und Abstimmungsliste (Phase 3, Grundlage).
//
// Bestätigt (Owner, 14.10.2026): New Collection (Desktop, Handy) und Excel-Import erfassen Altbestand — ohne Geld,
// ohne Einkauf; der Einkaufspreis ist der historische Einstand. Altbestand darf vor seiner Eröffnung verkauft werden;
// die spätere Eröffnung darf keinen Wareneinsatz doppelt buchen. Gebucht wird HIER NICHTS: die Gegenkonten, das Datum,
// die Behandlung früherer Verkäufe, offener Abgänge und von Wertunterschieden entscheidet der Buchhalter (D1–D6, D8).
//
// Diese Datei ist die EINE Rechengrundlage: dieselbe Funktion (`oldStockRowsFor`) speist heute die Vorschau und später
// die Buchungsplanung — die Buchung ruft sie in ihrer Transaktion noch einmal und prüft jeden Nachweis neu.
//
// Je eigenem Artikel (keine Kommission, kein Edelmetall) drei Teile, jeder mit seiner Quelle:
//   (a) schon gebuchter Wareneinsatz — aus dem Hauptbuch, netto (Verkäufe − Stornos − Retouren), über die Rechnungszeile
//       bzw. den Agentenverkauf dem Artikel zugeordnet; nie geschätzt;
//   (b) offene Abgänge ohne Buchung (Phase 1, ACCOUNTING_RECONCILIATION_PENDING) — Menge × Preis-Hinweis des Belegs;
//   (c) Bestand — Menge × historischer Einstand (Einkaufspreis des Artikels).
// V1 = a + b + c (Abgang später als Verlust gebucht), V2 = a + c (Abgang nicht gezeigt) — nur Vorschau, keine Wahl.
//
// Nachweisregel (Vorlage D4+D5, fest): eröffnet wird nur, was das Hauptbuch als NIE aktiviert belegt. Ein fehlendes Los
// reicht nicht. Jeder Zweifel macht einen Prüffall mit Grund (fail-visible), nie eine stille Annahme.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { isBulkMetalProduct } from '@/core/bulk/bulk-product';
import { belongsToConsignment } from '@/core/consignment/consignment-sale-link';
import { unknownInventoryDebits } from './stock-adjustment';

export type OldStockClass = 'OPENING_CANDIDATE' | 'REVIEW' | 'CAPITALISED';

/** Warum ein Artikel nicht automatisch eröffnet werden kann — jeder Grund für sich lesbar. */
export const OLD_STOCK_REVIEW_REASONS: Record<string, string> = {
  LEDGER_UNKNOWN_INVENTORY_DEBIT: 'the ledger holds inventory bookings that cannot be traced to an item — no automatic opening',
  PURCHASE_LINE_WITHOUT_LOT: 'the item has purchase lines but no lot — its inventory value is not clear',
  LOT_NOT_FROM_BOOKED_PURCHASE: 'a lot of this item does not come from a booked purchase (production, keep or legacy)',
  QUANTITY_DIFFERS_FROM_LOTS: 'the quantity differs from what the lots hold — part of it has no booked value',
  REPAIR_COSTS_CAPITALISED: 'repair costs of this item were booked to inventory',
  FROM_PRODUCTION: 'the item was made in production — its value came from consumed materials',
  FROM_CANCELLED_CUSTOM_ORDER: 'the item comes from a cancelled custom order — its costs were already booked as expenses',
  LEGACY_SALE_LINES: 'it has sales from before the stock tracking with more than one piece — the quantity on hand is uncertain',
  NO_HISTORICAL_COST: 'no historical cost (purchase price missing or 0) — the value needs a decision (D2)',
  COST_DIFFERS_FROM_BOOKED_COGS: 'the cost booked on earlier sales differs from the current historical cost (value-difference question D4)',
  OLD_STOCK_COST_DIFFERS: 'pieces added as old stock carry a different historical cost than the item',
  QUANTITY_INVALID: 'the quantity is not a whole number of pieces',
};

export interface OldStockRow {
  productId: string;
  sku: string;
  title: string;
  stockStatus: string;
  quantity: number;
  /** Stücke im Besitz (Menge, außer verkauft/verbraucht/abgeschrieben). */
  shelfQty: number;
  historicalCost: number | null;
  klass: OldStockClass;
  reasons: string[];
  /** (a) gebuchter Wareneinsatz netto. */
  soldCogs: number;
  /** (b) offene Abgänge ohne Buchung. */
  pendingRemovalQty: number;
  pendingRemovalValue: number;
  pendingRemovalNumbers: string[];
  /** Altbestand, der über „Add Old Stock" dazukam (Belege, Stücke). */
  oldStockReceipts: number;
  oldStockReceiptQty: number;
  /** (c) Bestand × historischer Einstand. */
  shelfValue: number;
  /** Vorschau der Eröffnung (nur für Kandidaten und Prüffälle; bei schon aktivierter Ware 0). */
  v1: number;
  v2: number;
}

export interface OldStockReconciliation {
  branchId: string;
  rows: OldStockRow[];
  totals: {
    candidates: number; review: number; capitalised: number;
    soldCogs: number; pendingRemovalValue: number; shelfValue: number; v1: number; v2: number;
    reviewV1: number;
  };
  ledger: { inventoryBalance: number; unknownInventoryDebits: number; unattributedCogs: number };
  notes: string[];
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const num = (v: unknown): number => Number(v) || 0;
const GONE = new Set(['sold', 'consumed', 'write_off']);

function groupNum(sql: string, params: unknown[] = []): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of query(sql, params)) m.set(String(r.pid), num(r.v));
  return m;
}

/**
 * Die Zeilen der Abstimmung — deterministisch (SKU, dann Kennung). `onlyProductId` rechnet genau einen Artikel mit
 * DENSELBEN Regeln (die spätere Buchung je Artikel).
 */
export function oldStockRowsFor(ctx: { branchId: string }, onlyProductId?: string): OldStockRow[] {
  const branchId = ctx.branchId;
  const products = query(
    `SELECT id, sku, brand, name, quantity, stock_status, purchase_price, source_type, notes FROM products
      WHERE branch_id = ? ${onlyProductId ? 'AND id = ?' : ''} ORDER BY COALESCE(sku, ''), id`,
    onlyProductId ? [branchId, onlyProductId] : [branchId],
  );
  const globalUnknown = unknownInventoryDebits() > 0;

  const purchaseLines = groupNum('SELECT product_id AS pid, COUNT(*) AS v FROM purchase_lines WHERE product_id IS NOT NULL GROUP BY product_id');
  const bookedLines = new Set(query(
    `SELECT DISTINCT e1.source_line_id AS id FROM ledger_entries e1
      WHERE e1.source_module = 'PURCHASE' AND e1.account = 'INVENTORY' AND e1.direction = 'DEBIT' AND e1.amount > 0
        AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`,
  ).map((r) => String(r.id)));
  const lotsBy = new Map<string, Array<Record<string, unknown>>>();
  for (const l of query('SELECT id, product_id, purchase_id, purchase_line_id, unit_cost, qty_remaining, status FROM stock_lots')) {
    const k = String(l.product_id);
    if (!lotsBy.has(k)) lotsBy.set(k, []);
    lotsBy.get(k)!.push(l);
  }
  const cancelledPurchases = new Set(query("SELECT id FROM purchases WHERE UPPER(COALESCE(status, '')) = 'CANCELLED'").map((r) => String(r.id)));
  const repairCapitalised = new Set(query(
    `SELECT DISTINCT r.product_id AS pid FROM ledger_entries le JOIN repairs r ON (
         (le.source_module = 'EXPENSE' AND le.source_id IN (SELECT e.id FROM expenses e WHERE e.related_module = 'repair' AND e.related_entity_id = r.id))
      OR (le.source_module = 'REPAIR_OWN_WORK' AND json_extract(le.metadata_json, '$.repairId') = r.id))
      WHERE le.account = 'INVENTORY' AND le.direction = 'DEBIT' AND r.product_id IS NOT NULL`,
  ).map((r) => String(r.pid)));
  const fromProduction = new Set(query('SELECT DISTINCT product_id AS pid FROM production_outputs').map((r) => String(r.pid)));
  // (a) Wareneinsatz netto je Artikel: Rechnungszeile oder Agentenverkauf; Stornos und Retouren tragen dieselbe Zuordnung.
  const cogsByLine = groupNum(
    `SELECT il.product_id AS pid, SUM(CASE le.direction WHEN 'DEBIT' THEN le.amount ELSE -le.amount END) AS v
       FROM ledger_entries le JOIN invoice_lines il ON il.id = le.source_line_id
      WHERE le.account = 'COGS' AND il.product_id IS NOT NULL AND le.branch_id = ? GROUP BY il.product_id`, [branchId]);
  const cogsByAgent = groupNum(
    `SELECT at.product_id AS pid, SUM(CASE le.direction WHEN 'DEBIT' THEN le.amount ELSE -le.amount END) AS v
       FROM ledger_entries le JOIN agent_transfers at ON at.id = le.source_id
      WHERE le.account = 'COGS' AND le.source_module = 'AGENT_TRANSFER_SOLD' AND le.source_line_id IS NULL AND le.branch_id = ? GROUP BY at.product_id`, [branchId]);
  const legacyMulti = new Set(query(
    `SELECT DISTINCT il.product_id AS pid FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.legacy_stock IN ('deducted', 'pending') AND COALESCE(il.quantity, 1) > 1 AND i.status != 'CANCELLED'`,
  ).map((r) => String(r.pid)));
  const snapshots = new Map<string, number[]>();
  for (const r of query(
    `SELECT il.product_id AS pid, il.purchase_price_snapshot AS c FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE i.status != 'CANCELLED' AND COALESCE(il.purchase_price_snapshot, 0) > 0 AND il.product_id IS NOT NULL AND il.lot_id IS NULL`)) {
    const k = String(r.pid);
    if (!snapshots.has(k)) snapshots.set(k, []);
    snapshots.get(k)!.push(num(r.c));
  }
  const removals = new Map<string, { qty: number; value: number; numbers: string[] }>();
  for (const r of query(
    `SELECT product_id, adjustment_number, quantity, purchase_price_hint FROM stock_adjustments
      WHERE branch_id = ? AND direction = 'ISSUE' AND status = 'POSTED' AND accounting = 'ACCOUNTING_RECONCILIATION_PENDING'
      ORDER BY created_at, id`, [branchId])) {
    const k = String(r.product_id);
    const e = removals.get(k) ?? { qty: 0, value: 0, numbers: [] };
    e.qty += num(r.quantity); e.value += num(r.quantity) * num(r.purchase_price_hint); e.numbers.push(String(r.adjustment_number));
    removals.set(k, e);
  }
  const receipts = new Map<string, { n: number; qty: number; costs: number[] }>();
  for (const r of query(
    `SELECT product_id, quantity, purchase_price_hint FROM stock_adjustments
      WHERE branch_id = ? AND direction = 'RECEIPT' AND status = 'POSTED'`, [branchId])) {
    const k = String(r.product_id);
    const e = receipts.get(k) ?? { n: 0, qty: 0, costs: [] };
    e.n += 1; e.qty += num(r.quantity); e.costs.push(num(r.purchase_price_hint));
    receipts.set(k, e);
  }

  const rows: OldStockRow[] = [];
  for (const p of products) {
    const pid = String(p.id);
    if (String(p.source_type ?? 'OWN').toUpperCase() !== 'OWN' || isBulkMetalProduct(pid) || belongsToConsignment(pid)) continue;
    const status = String(p.stock_status ?? '');
    const qtyRaw = Number(p.quantity);
    const qtyOk = p.quantity !== null && p.quantity !== undefined && Number.isInteger(qtyRaw) && qtyRaw >= 0;
    const quantity = qtyOk ? qtyRaw : 0;
    const shelfQty = GONE.has(status.toLowerCase()) ? 0 : quantity;
    const cost = p.purchase_price === null || p.purchase_price === undefined ? null : Number(p.purchase_price);
    const soldCogs = r3((cogsByLine.get(pid) ?? 0) + (cogsByAgent.get(pid) ?? 0));
    const rem = removals.get(pid) ?? { qty: 0, value: 0, numbers: [] };
    const rec = receipts.get(pid) ?? { n: 0, qty: 0, costs: [] };
    const lots = lotsBy.get(pid) ?? [];
    const hasPurchase = (purchaseLines.get(pid) ?? 0) > 0;
    const reasons: string[] = [];
    let klass: OldStockClass;

    if (hasPurchase || lots.length > 0) {
      const proven = (l: Record<string, unknown>): boolean => num(l.unit_cost) === 0
        || (!!l.purchase_line_id && bookedLines.has(String(l.purchase_line_id)) && !cancelledPurchases.has(String(l.purchase_id ?? '')));
      if (lots.length === 0) reasons.push('PURCHASE_LINE_WITHOUT_LOT');
      if (lots.some((l) => !proven(l))) reasons.push('LOT_NOT_FROM_BOOKED_PURCHASE');
      const held = lots.filter((l) => String(l.status) !== 'CANCELLED' && num(l.qty_remaining) > 0).reduce((s, l) => s + num(l.qty_remaining), 0);
      if (lots.length > 0 && held !== shelfQty && !GONE.has(status.toLowerCase())) reasons.push('QUANTITY_DIFFERS_FROM_LOTS');
      if (!qtyOk) reasons.push('QUANTITY_INVALID');
      klass = reasons.length === 0 ? 'CAPITALISED' : 'REVIEW';
    } else {
      // Nichts zu eröffnen: kein Bestand, kein Wareneinsatz, kein offener Abgang, kein Altbestands-Beleg (z. B. ein
      // Auftragsartikel, der noch auf seinen Einkauf wartet).
      if (shelfQty === 0 && Math.abs(soldCogs) < 0.0005 && rem.qty === 0 && rec.n === 0 && qtyOk) continue;
      if (globalUnknown) reasons.push('LEDGER_UNKNOWN_INVENTORY_DEBIT');
      if (repairCapitalised.has(pid)) reasons.push('REPAIR_COSTS_CAPITALISED');
      if (fromProduction.has(pid)) reasons.push('FROM_PRODUCTION');
      if (/From cancelled custom order/i.test(String(p.notes ?? ''))) reasons.push('FROM_CANCELLED_CUSTOM_ORDER');
      if (legacyMulti.has(pid)) reasons.push('LEGACY_SALE_LINES');
      if (!qtyOk) reasons.push('QUANTITY_INVALID');
      if (cost === null || !(cost > 0)) reasons.push('NO_HISTORICAL_COST');
      if (cost !== null && (snapshots.get(pid) ?? []).some((c) => Math.abs(c - cost) > 0.0005)) reasons.push('COST_DIFFERS_FROM_BOOKED_COGS');
      if (cost !== null && rec.costs.some((c) => Math.abs(c - cost) > 0.0005)) reasons.push('OLD_STOCK_COST_DIFFERS');
      klass = reasons.length === 0 ? 'OPENING_CANDIDATE' : 'REVIEW';
    }
    const shelfValue = klass === 'CAPITALISED' ? 0 : r3(shelfQty * (cost ?? 0));
    const a = klass === 'CAPITALISED' ? 0 : soldCogs;
    const b = klass === 'CAPITALISED' ? 0 : r3(rem.value);
    rows.push({
      productId: pid,
      sku: String(p.sku ?? ''),
      title: [p.brand, p.name].filter((x) => x && String(x).trim()).join(' ') || pid,
      stockStatus: status,
      quantity,
      shelfQty,
      historicalCost: cost,
      klass,
      reasons,
      soldCogs: a,
      pendingRemovalQty: rem.qty,
      pendingRemovalValue: b,
      pendingRemovalNumbers: rem.numbers,
      oldStockReceipts: rec.n,
      oldStockReceiptQty: rec.qty,
      shelfValue,
      v1: r3(a + b + shelfValue),
      v2: r3(a + shelfValue),
    });
  }
  return rows;
}

/** Die ganze Abstimmung: Zeilen, Summen der Kandidaten, Hauptbuch-Lage und Hinweise. Schreibt nichts. */
export function oldStockReconciliationFor(ctx: { branchId: string }): OldStockReconciliation {
  const rows = oldStockRowsFor(ctx);
  const cand = rows.filter((r) => r.klass === 'OPENING_CANDIDATE');
  const sum = (xs: OldStockRow[], f: (r: OldStockRow) => number): number => r3(xs.reduce((s, r) => s + f(r), 0));
  const unknown = unknownInventoryDebits();
  const totalCogs = num(query(
    "SELECT SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) AS v FROM ledger_entries WHERE account = 'COGS' AND branch_id = ?",
    [ctx.branchId],
  )[0]?.v);
  const attributed = num(query(
    `SELECT SUM(CASE le.direction WHEN 'DEBIT' THEN le.amount ELSE -le.amount END) AS v FROM ledger_entries le
      WHERE le.account = 'COGS' AND (EXISTS (SELECT 1 FROM invoice_lines il WHERE il.id = le.source_line_id AND il.product_id IS NOT NULL)
        OR (le.source_module = 'AGENT_TRANSFER_SOLD' AND le.source_line_id IS NULL AND EXISTS (SELECT 1 FROM agent_transfers at WHERE at.id = le.source_id)))
        AND le.branch_id = ?`,
    [ctx.branchId],
  )[0]?.v);
  const inventoryBalance = r3(num(query(
    "SELECT SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) AS v FROM ledger_entries WHERE account = 'INVENTORY' AND branch_id = ?",
    [ctx.branchId],
  )[0]?.v));
  const unattributedCogs = r3(totalCogs - attributed);
  const notes: string[] = ['Preview only — nothing is booked. The opening waits for the accountant\'s rules (D1–D6, D8).'];
  if (unknown > 0) notes.push(`${unknown} inventory booking(s) in the ledger cannot be traced to an item — no automatic opening until this is clarified.`);
  if (Math.abs(unattributedCogs) >= 0.0005) notes.push(`Cost of sales of ${unattributedCogs.toFixed(3)} BHD cannot be traced to an item — the history part may be incomplete.`);
  return {
    branchId: ctx.branchId,
    rows,
    totals: {
      candidates: cand.length,
      review: rows.filter((r) => r.klass === 'REVIEW').length,
      capitalised: rows.filter((r) => r.klass === 'CAPITALISED').length,
      soldCogs: sum(cand, (r) => r.soldCogs),
      pendingRemovalValue: sum(cand, (r) => r.pendingRemovalValue),
      shelfValue: sum(cand, (r) => r.shelfValue),
      v1: sum(cand, (r) => r.v1),
      v2: sum(cand, (r) => r.v2),
      reviewV1: sum(rows.filter((r) => r.klass === 'REVIEW'), (r) => r.v1),
    },
    ledger: { inventoryBalance, unknownInventoryDebits: unknown, unattributedCogs },
    notes,
  };
}

/** Ein Artikel nach denselben Regeln — der Einstieg, den die spätere Eröffnungsbuchung in ihrer Transaktion ruft. */
export function planOldStockOpening(ctx: { branchId: string }, productId: string): OldStockRow | null {
  return oldStockRowsFor(ctx, productId)[0] ?? null;
}

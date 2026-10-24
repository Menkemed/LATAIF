// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT B5 — was ist aus der Ware einer Einkaufszeile geworden?
//
// Storno und Bearbeitung eines Einkaufs dürfen nur wirken, was die Ware noch trägt. Bisher fragte der
// Storno allein nach Rechnungen (`PURCHASE_STOCK_SOLD`). Die anderen Wege, auf denen ein Stück das Los
// verlässt oder seinen Einstand ändert, sah er nicht — Agentenverkauf, Produktion, Bestandsabgang,
// aktivierte Reparaturkosten. Ein Storno reversierte dann den vollen Lagerzugang, obwohl ein Teil schon
// als Wareneinsatz, Produktionseingang oder Abschreibung abgeflossen war, und INVENTORY stimmte nicht
// mehr mit den Losen überein.
//
// Diese Datei ist die EINE Auskunft dafür — nur lesend, aus der Datenbank, je Einkaufszeile über ihr
// Los (`stock_lots.purchase_line_id`). Sie entscheidet nichts; Storno und Bearbeitung ziehen daraus
// ihre eigenen Regeln.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { purchaseLotUnitCost } from '@/core/lots/lot-cost';

const EPS = 0.0005;

export interface PurchaseLotState {
  id: string;
  productId: string;
  qtyTotal: number;
  qtyRemaining: number;
  unitCost: number;
  status: string;
  unit: string;
}

/** Ein Verkauf eines Stücks dieser Zeile über eine Rechnung (nicht storniert). */
export interface PurchaseLineSale {
  invoiceId: string;
  invoiceLineId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  /** Rechnungsdatum (JJJJ-MM-TT) — das wirtschaftliche Datum einer Einstandskorrektur (D1). */
  issuedDate: string;
  quantity: number;
  /** Stücke, deren Wareneinsatz eine Kunden-Retoure schon zurückgebucht hat (SALES_RETURN_COGS, wirksam). */
  returnedToStock: number;
  /** Stücke, deren Wareneinsatz noch gebucht ist — genau diese berichtigt eine Einstandskorrektur. */
  unitsInCogs: number;
  /** Der Einstand je Stück, den die Rechnung beim Verkauf festhielt. */
  snapshotUnitCost: number;
  lineTotal: number;
  taxScheme: string;
  vatRate: number;
  /** Ist für diese Zeile ein Wareneinsatz im Hauptbuch gebucht (wirksam)? */
  hasCogs: boolean;
  /** Kam die Rechnung aus einem Agentenverkauf (der Agent hielt das Stück)? */
  viaAgent: boolean;
  productId: string | null;
}

export interface PurchaseLineConsumption {
  lineId: string;
  productId: string | null;
  lineQty: number;
  lots: PurchaseLotState[];
  sales: PurchaseLineSale[];
  /** Vom Agenten verkauft, noch nicht in eine Rechnung umgewandelt. */
  agentHeld: number;
  /** In einer Produktion als Eingang verbraucht. */
  production: number;
  /** Durch einen Bestandsabgang (Stock Correction) ausgebucht. */
  adjustments: number;
  /** In einer nicht stornierten Rückgabe an den Lieferanten. */
  supplierReturned: number;
  /** Der Los-Einstand weicht vom Einkauf ab (z. B. aktivierte Reparaturkosten eigener Ware). */
  costChanged: boolean;
  /** Ein Los, aktiv, volle Restmenge = Zeilenmenge, und kein Weg oben hat es berührt. */
  untouched: boolean;
}

const num = (v: unknown): number => Number(v) || 0;
const day = (v: unknown): string => String(v ?? '').slice(0, 10);

function lotsOfLine(lineId: string): PurchaseLotState[] {
  return query(
    `SELECT id, product_id, qty_total, qty_remaining, unit_cost, status, COALESCE(unit, 'pcs') AS unit
       FROM stock_lots WHERE purchase_line_id = ? ORDER BY acquired_at ASC, id ASC`,
    [lineId],
  ).map((r) => ({
    id: String(r.id), productId: String(r.product_id ?? ''), qtyTotal: num(r.qty_total), qtyRemaining: num(r.qty_remaining),
    unitCost: num(r.unit_cost), status: String(r.status ?? ''), unit: String(r.unit ?? 'pcs'),
  }));
}

function salesOfLots(lotIds: string[]): PurchaseLineSale[] {
  if (lotIds.length === 0) return [];
  const marks = lotIds.map(() => '?').join(',');
  const rows = query(
    `SELECT il.id, il.invoice_id, il.product_id, il.quantity, il.purchase_price_snapshot, il.line_total, il.vat_rate, il.tax_scheme,
            i.invoice_number, i.status AS invoice_status, COALESCE(i.issued_at, i.created_at) AS issued_at,
            (SELECT COALESCE(SUM(srl.quantity), 0) FROM sales_return_lines srl
               WHERE srl.invoice_line_id = il.id
                 AND EXISTS (SELECT 1 FROM ledger_entries e1
                              WHERE e1.source_module = 'SALES_RETURN_COGS' AND e1.source_id = srl.return_id
                                AND e1.source_line_id = il.id AND e1.reverses_entry_id IS NULL
                                AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id))) AS returned_stock,
            (SELECT COUNT(*) FROM ledger_entries e1
               WHERE e1.source_module = 'INVOICE' AND e1.account = 'COGS' AND e1.source_line_id = il.id
                 AND e1.reverses_entry_id IS NULL
                 AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)) AS cogs_rows,
            (SELECT COUNT(*) FROM agent_transfers t WHERE t.invoice_id = il.invoice_id AND t.product_id = il.product_id) AS agent_rows
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
      WHERE il.lot_id IN (${marks}) AND i.status != 'CANCELLED'
      ORDER BY COALESCE(i.issued_at, i.created_at) ASC, il.id ASC`,
    lotIds,
  );
  return rows.map((r) => {
    const quantity = Math.max(1, num(r.quantity));
    const returnedToStock = Math.min(quantity, num(r.returned_stock));
    return {
      invoiceId: String(r.invoice_id), invoiceLineId: String(r.id), invoiceNumber: String(r.invoice_number ?? ''),
      invoiceStatus: String(r.invoice_status ?? ''), issuedDate: day(r.issued_at), quantity, returnedToStock,
      unitsInCogs: Math.max(0, quantity - returnedToStock), snapshotUnitCost: num(r.purchase_price_snapshot),
      lineTotal: num(r.line_total), taxScheme: String(r.tax_scheme ?? ''), vatRate: num(r.vat_rate),
      hasCogs: num(r.cogs_rows) > 0, viaAgent: num(r.agent_rows) > 0,
      productId: r.product_id ? String(r.product_id) : null,
    };
  });
}

/** Wie viel ein JSON-Verbrauchsnachweis (`lots: [{ lotId, qty|take }]`) aus diesen Losen nahm. */
function takenFrom(lotIds: Set<string>, lots: unknown): number {
  if (!Array.isArray(lots)) return 0;
  let n = 0;
  for (const l of lots) {
    const x = l as { lotId?: unknown; qty?: unknown; take?: unknown };
    if (typeof x.lotId === 'string' && lotIds.has(x.lotId)) n += num(x.take ?? x.qty);
  }
  return n;
}

/** Die Auskunft je Zeile eines Einkaufs. */
export function purchaseLineConsumption(purchaseId: string): PurchaseLineConsumption[] {
  const lines = query(
    'SELECT id, product_id, quantity, unit_price, line_total, vat_amount FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id',
    [purchaseId],
  );
  return lines.map((pl) => {
    const lineId = String(pl.id);
    const productId = pl.product_id ? String(pl.product_id) : null;
    const lineQty = Math.max(1, num(pl.quantity));
    const lots = lotsOfLine(lineId);
    const pieceLots = lots.filter((l) => l.unit === 'pcs');
    const lotIds = pieceLots.map((l) => l.id);
    const idSet = new Set(lotIds);
    const sales = salesOfLots(lotIds);

    let agentHeld = 0;
    let production = 0;
    let adjustments = 0;
    if (lotIds.length > 0) {
      const marks = lotIds.map(() => '?').join(',');
      agentHeld = num(query(
        `SELECT COALESCE(SUM(stock_taken), 0) AS n FROM agent_transfers
          WHERE stock_lot_id IN (${marks}) AND COALESCE(stock_taken, 0) > 0 AND COALESCE(invoice_id, '') = ''`,
        lotIds,
      )[0]?.n);
      if (productId) {
        for (const r of query('SELECT lot_consumption FROM production_inputs WHERE product_id = ? AND lot_consumption IS NOT NULL', [productId])) {
          try { production += takenFrom(idSet, (JSON.parse(String(r.lot_consumption)) as { lots?: unknown }).lots); } catch { production += 0; }
        }
        for (const r of query(
          `SELECT lots_json FROM stock_adjustments WHERE product_id = ? AND direction = 'ISSUE' AND status != 'CANCELLED' AND lots_json IS NOT NULL`,
          [productId],
        )) {
          try { adjustments += takenFrom(idSet, JSON.parse(String(r.lots_json))); } catch { adjustments += 0; }
        }
      }
    }
    const supplierReturned = num(query(
      `SELECT COALESCE(SUM(prl.quantity), 0) AS n FROM purchase_return_lines prl JOIN purchase_returns pr ON pr.id = prl.return_id
        WHERE prl.purchase_line_id = ? AND pr.status != 'CANCELLED'`,
      [lineId],
    )[0]?.n);

    // Was der Einkauf als Einstand anlegte: netto (seit LOT-VAT-COST) oder — Altlos von davor — der
    // Bruttostückpreis. Weicht das Los von beidem ab, hat etwas anderes seinen Einstand verschoben.
    const purchaseUnit = purchaseLotUnitCost({
      qty: lineQty, unitPrice: num(pl.unit_price), lineTotal: num(pl.line_total), vatAmount: num(pl.vat_amount),
    });
    const costChanged = pieceLots.some((l) => l.status !== 'CANCELLED'
      && Math.abs(l.unitCost - purchaseUnit) > EPS && Math.abs(l.unitCost - num(pl.unit_price)) > EPS);
    const lot = pieceLots[0];
    const untouched = lots.length === 1 && !!lot && lot.status === 'ACTIVE'
      && Math.abs(lot.qtyTotal - lineQty) < EPS && Math.abs(lot.qtyRemaining - lot.qtyTotal) < EPS
      && sales.length === 0 && agentHeld === 0 && production === 0 && adjustments === 0 && supplierReturned === 0 && !costChanged;

    return {
      lineId, productId, lineQty, lots, sales, agentHeld, production, adjustments, supplierReturned, costChanged, untouched,
    };
  });
}

/**
 * B5 — der Storno-Riegel über alle Verbrauchswege außer der Rechnung (die prüft der Storno schon
 * selbst, mit seiner eigenen Meldung). `null` = nichts im Weg; sonst Code und Satz für den Menschen.
 */
export function purchaseCancelBlocker(purchaseId: string): { code: string; message: string } | null {
  for (const c of purchaseLineConsumption(purchaseId)) {
    if (c.agentHeld > 0) {
      return { code: 'PURCHASE_STOCK_AGENT_SOLD', message: 'Cannot cancel this purchase: an item from it was sold by an agent. Return or undo that agent sale first.' };
    }
    if (c.production > 0) {
      return { code: 'PURCHASE_STOCK_IN_PRODUCTION', message: 'Cannot cancel this purchase: an item from it was used in a production. Delete that production first.' };
    }
    if (c.adjustments > 0) {
      return { code: 'PURCHASE_STOCK_ADJUSTED', message: 'Cannot cancel this purchase: an item from it was written off by a stock correction. Cancel that correction first.' };
    }
    if (c.costChanged) {
      return { code: 'PURCHASE_LOT_COST_CHANGED', message: 'Cannot cancel this purchase: the cost of an item from it was changed since (for example by a repair). Reverse that cost first.' };
    }
  }
  return null;
}

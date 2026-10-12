// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT-INTEGRITY — welche Kommission gehört zu einer verkauften Rechnungszeile, und was ist
// überhaupt Kommissionsware? EINE Stelle für Verkauf, Rückgabe und Storno.
//
// Autoritative Zuordnung (bewiesen, nicht angenommen):
//   • `consignments.invoice_id` schreibt NUR „Record Sale" (`consignmentStore.recordSale`) — immer mit
//     einer FRISCH angelegten Rechnung, die genau EINE Zeile für den Artikel der Kommission trägt — und
//     NUR „Cancel Sale" setzt sie wieder auf NULL. Keine Maske, kein Fernbefehl, keine Bearbeitung
//     (`updateConsignment` wird nie mit `invoiceId` gerufen außer von „Record Sale").
//   • Also gehört zu (Rechnung, Artikel) höchstens EINE Kommission. Das wird hier trotzdem gezählt:
//     genau eine → zugeordnet; keine → nicht zugeordnet; mehr als eine → mehrdeutig. Nur „genau eine"
//     darf eine Kommission verändern. `product_id` allein ist KEINE Zuordnung: ein Artikel kann über die
//     Zeit mehrere Kommissionen haben (zurückgegeben, neu eingeliefert …).
//
// Kommissionsware wird NUR über „Record Sale" verkauft: nur dort entstehen Einkauf beim Einlieferer
// (Verbindlichkeit), Provision/Auszahlung, Boden-Prüfung und die Verknüpfung. Eine gewöhnliche Rechnung
// verkaufte das Stück am Vertrag vorbei — und „Record Sale" konnte es danach ein zweites Mal verkaufen.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

/** Status einer Kommission, deren Ware noch beim Händler liegt und noch nicht verkauft ist. */
const OPEN_CONSIGNMENT = ['active', 'IN_STOCK'];

export const CONSIGNMENT_SELL_VIA_CONSIGNMENT = 'CONSIGNMENT_SELL_VIA_CONSIGNMENT';

/** Ist dieser Artikel Kommissionsware (Quelle CONSIGNMENT oder eine offene Kommission dazu)? */
export function isConsignmentGoods(productId: string | null | undefined): boolean {
  if (!productId) return false;
  if (query("SELECT 1 FROM products WHERE id = ? AND source_type = 'CONSIGNMENT'", [productId]).length > 0) return true;
  return query(
    `SELECT 1 FROM consignments WHERE product_id = ? AND status IN (${OPEN_CONSIGNMENT.map(() => '?').join(',')}) LIMIT 1`,
    [productId, ...OPEN_CONSIGNMENT],
  ).length > 0;
}

export type SaleConsignment =
  | { kind: 'none' }
  | { kind: 'one'; id: string; status: string; productId: string; invoiceId: string }
  | { kind: 'ambiguous'; count: number };

/** Die Kommission, deren Verkauf diese Rechnungszeile IST — über Rechnung UND Artikel, in dieser Filiale. */
export function saleConsignmentOfLine(invoiceLineId: string, branchId: string): SaleConsignment {
  const rows = query(
    `SELECT c.id, c.status, c.product_id, c.invoice_id
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id AND i.branch_id = ?
       JOIN consignments c ON c.invoice_id = il.invoice_id AND c.product_id = il.product_id AND c.branch_id = ?
      WHERE il.id = ?`,
    [branchId, branchId, invoiceLineId],
  );
  if (rows.length === 0) return { kind: 'none' };
  if (rows.length > 1) return { kind: 'ambiguous', count: rows.length };
  const r = rows[0];
  return { kind: 'one', id: String(r.id), status: String(r.status ?? ''), productId: String(r.product_id), invoiceId: String(r.invoice_id) };
}

// ── Die Erlaubnis von „Record Sale" ──────────────────────────────────────────
// „Record Sale" legt seine Rechnung über denselben Rechnungsweg an wie jede andere Rechnung. Nur für
// GENAU diesen Artikel und nur während dieses Aufrufs ist Kommissionsware dort erlaubt (synchron;
// danach in jedem Fall wieder zu).
let permittedProduct: string | null = null;

export function withConsignmentSalePermit<T>(productId: string, fn: () => T): T {
  const before = permittedProduct;
  permittedProduct = productId;
  try {
    return fn();
  } finally {
    permittedProduct = before;
  }
}

/** Wirft, wenn eine dieser Zeilen Kommissionsware am Kommissionsverkauf vorbei verkaufen würde. */
export function assertNoConsignmentGoods(lines: ReadonlyArray<{ productId?: string | null }>): void {
  for (const l of lines) {
    if (!l.productId || l.productId === permittedProduct) continue;
    if (isConsignmentGoods(l.productId)) {
      throw new InvoiceActionRejected(CONSIGNMENT_SELL_VIA_CONSIGNMENT,
        'This item is consignment stock — sell it with "Record Sale" on its consignment, not on an ordinary invoice.');
    }
  }
}

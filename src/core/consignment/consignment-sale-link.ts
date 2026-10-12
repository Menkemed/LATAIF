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

// ── Eigentum ↔ Agent ─────────────────────────────────────────────────────────
// `products.source_type` mischt Eigentum (OWN/CONSIGNMENT) und Aufenthaltsort (AGENT) — beim Agenten steht dort
// `AGENT`, egal wem das Stück gehört. Die verlässliche Quelle für „gehört es einem Einlieferer?" ist deshalb die
// Kommission selbst (`consignments`), nicht `source_type` allein.

/** Status einer Kommission, deren Ware noch dem Einlieferer gehört und beim Händler liegt (auch abgelaufen). */
const CONSIGNOR_HOLDS = ['active', 'IN_STOCK', 'expired'];
/** Status einer Kommission, deren Verkauf gebucht ist (die Ware gehört dem Käufer). */
const CONSIGNMENT_SOLD = ['sold', 'SOLD', 'paid_out'];
/** Abgeschlossen: an den Einlieferer zurück oder als eigene Ware behalten. */
const CONSIGNMENT_CLOSED = ['returned', 'RETURNED', 'RETURNED_TO_OWNER'];

export const CONSIGNMENT_NOT_TRANSFERABLE = 'CONSIGNMENT_NOT_TRANSFERABLE';

/** Gehört dieser Artikel zu einer (noch nicht abgeschlossenen) Kommission — unabhängig von `source_type`/Status? */
export function belongsToConsignment(productId: string | null | undefined): boolean {
  if (!productId) return false;
  if (query("SELECT 1 FROM products WHERE id = ? AND source_type = 'CONSIGNMENT'", [productId]).length > 0) return true;
  const offen = [...CONSIGNOR_HOLDS, ...CONSIGNMENT_SOLD];
  return query(
    `SELECT 1 FROM consignments WHERE product_id = ? AND status IN (${offen.map(() => '?').join(',')}) LIMIT 1`,
    [productId, ...offen],
  ).length > 0;
}

export type AgentReturnOwnership =
  | { kind: 'own' }
  | { kind: 'consignment'; consignmentId: string }
  | { kind: 'unclear'; reason: string };

/**
 * Wem gehört ein Stück, das vom Agenten zurückkommt? Aus der Relation, nicht geraten:
 *   keine nicht abgeschlossene Kommission → eigene Ware;
 *   genau eine, deren Ware beim Einlieferer liegt → Kommissionsware;
 *   mehrere, oder eine schon verkaufte → unklar (nichts wird geschrieben).
 */
export function ownershipAfterAgent(productId: string): AgentReturnOwnership {
  const rows = query(
    `SELECT id, status FROM consignments WHERE product_id = ? AND status NOT IN (${CONSIGNMENT_CLOSED.map(() => '?').join(',')})`,
    [productId, ...CONSIGNMENT_CLOSED],
  );
  if (rows.length === 0) return { kind: 'own' };
  if (rows.length > 1) return { kind: 'unclear', reason: `the item belongs to ${rows.length} open consignments` };
  const st = String(rows[0].status ?? '');
  if (CONSIGNOR_HOLDS.includes(st)) return { kind: 'consignment', consignmentId: String(rows[0].id) };
  return { kind: 'unclear', reason: `its consignment is "${st}" (already sold through the consignment)` };
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

// ── Die Verkaufsrechnung einer Kommission ────────────────────────────────────
// Was „Record Sale" auf diese Rechnung schrieb (Artikel, Menge, Preis, Käufer), ist zugleich die Grundlage
// von Provision, Auszahlung und Einkauf beim Einlieferer. Eine gewöhnliche Rechnungsänderung zöge davon
// nichts nach — zwei widersprüchliche Wahrheiten. Also: diese Werte ändert nur „Cancel Sale" (+ neu
// verkaufen) — samt Rechnungsdatum (= Verkaufsdatum). Notiz, Mitarbeiter und Zahlungen bleiben nach den Regeln der Rechnung änderbar.

export const CONSIGNMENT_INVOICE_LOCKED = 'CONSIGNMENT_INVOICE_LOCKED';

export interface BoundSaleConsignment { id: string; number: string; productId: string; buyerId: string }

/** Die Kommission, deren Verkaufsrechnung diese Rechnung ist (`consignments.invoice_id`) — oder null. */
export function boundSaleConsignment(invoiceId: string): BoundSaleConsignment | null {
  const r = query(
    'SELECT id, consignment_number, product_id, buyer_id FROM consignments WHERE invoice_id = ? ORDER BY id LIMIT 1',
    [invoiceId],
  )[0];
  return r ? { id: String(r.id), number: String(r.consignment_number ?? ''), productId: String(r.product_id ?? ''), buyerId: String(r.buyer_id ?? '') } : null;
}

const gesperrt = (c: BoundSaleConsignment, was: string): InvoiceActionRejected => new InvoiceActionRejected(CONSIGNMENT_INVOICE_LOCKED,
  `This invoice is the sale of consignment ${c.number || c.id}. ${was} Use "Cancel Sale" on the consignment (and record the sale again if needed). Nothing was changed.`);

/** Löschen / Stornieren der Verkaufsrechnung einer Kommission: nur über „Cancel Sale". */
export function assertNotConsignmentSaleInvoice(invoiceId: string, was: string): void {
  const c = boundSaleConsignment(invoiceId);
  if (c) throw gesperrt(c, was);
}

const gleich = (a: number, b: number): boolean => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0005;

/**
 * Rechnung ändern: ist sie die Verkaufsrechnung einer Kommission, bleiben ihre Zeilen, wie „Record Sale" sie
 * schrieb (Artikel, Menge, Preis, Steuerart, Summe; keine Zeile dazu, keine weg), und der Käufer bleibt.
 */
export function assertConsignmentSaleInvoiceEdit(
  invoiceId: string,
  base: ReadonlyArray<{ id: string; productId: string | null; qty: number; unitPrice: number; taxScheme: string; lineTotal: number }>,
  next: ReadonlyArray<{ productId?: string | null; quantity?: number; unitPrice: number; taxScheme: string; lineTotal: number }>,
  lineMatch: ReadonlyArray<string | null>,
  customerChanged: boolean,
  // Das Rechnungsdatum ist das Datum des Verkaufs — der Einkauf beim Einlieferer und seine Buchungen tragen es mit.
  // Verschöbe nur die Rechnung, lägen Verkauf und Einkauf an anderen Tagen (bis in eine andere VAT-Periode).
  dateChanged = false,
): void {
  const c = boundSaleConsignment(invoiceId);
  if (!c) return;
  if (customerChanged) throw gesperrt(c, 'Its buyer belongs to the consignment.');
  if (dateChanged) throw gesperrt(c, 'Its date is the date of the consignment sale (and of the consignor\'s purchase).');
  if (next.length !== base.length || lineMatch.some((m) => m === null)) {
    throw gesperrt(c, 'Its lines cannot be added, removed or replaced.');
  }
  const byId = new Map(base.map((b) => [b.id, b]));
  next.forEach((n, i) => {
    const b = byId.get(lineMatch[i] as string);
    if (!b || (n.productId ?? null) !== b.productId || !gleich(n.quantity ?? 1, b.qty) || !gleich(n.unitPrice, b.unitPrice)
      || String(n.taxScheme) !== String(b.taxScheme) || !gleich(n.lineTotal, b.lineTotal)) {
      throw gesperrt(c, 'Its item, quantity and price belong to the consignment (commission, payout and the consignor\'s purchase).');
    }
  });
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

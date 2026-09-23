// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S2 — Rechnungszeilen beim Bearbeiten ABGLEICHEN statt wegwerfen.
//
// Früher löschte `editInvoice` alle Zeilen und legte sie mit neuen IDs neu an. Daran hängen aber
// Retourenzeilen (`sales_return_lines.invoice_line_id`), der Doppel-Retouren-Schutz und der
// Wareneinsatz im Hauptbuch (`source_line_id`). Deshalb war jede Rechnung mit Retoure komplett
// gesperrt.
//
// Jetzt behält eine Zeile, die es schon gab (gleicher Artikel), ihre ID, ihr Los und ihren
// Einstand. Nur Zeilen, die wirklich wegfallen, werden gelöscht; wirklich neue bekommen eine neue
// ID. Eine Zeile MIT Retoure hat drei gezielte Grenzen — alles andere an der Rechnung bleibt frei:
//   • sie darf nicht wegfallen oder durch einen anderen Artikel ersetzt werden,
//   • ihre Menge darf nicht unter die schon zurückgenommene Menge fallen,
//   • Preis und Steuerart bleiben, wie sie sind (die Gutschrift wurde zu diesem Preis ausgestellt).
// Und die Rechnung darf nicht unter die Summe ihrer wirksamen Gutschriften fallen.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';

export interface EditBaseLine {
  id: string;
  productId: string | null;
  lotId: string | null;
  qty: number;
  unitPrice: number;
  taxScheme: string;
  purchasePrice: number;
  /** Was die Zeile aus dem Bestand genommen hat (NULL = Zeile von vor dem Bestandsvertrag). */
  stockTaken: number | null;
  /** Menge, die aus wirksamen Retouren (nicht REJECTED) von dieser Zeile schon zurückgenommen ist. */
  returnedQty: number;
}

export interface EditInputLine {
  productId: string;
  quantity?: number;
  unitPrice: number;
  taxScheme: string;
  lineTotal: number;
}

/** Die fachlichen Neins, als Kennung — die Oberfläche zeigt nur den Satz. */
export const EDIT_LINE_HAS_RETURN = 'INVOICE_LINE_HAS_RETURN';
export const EDIT_BELOW_RETURNED_QTY = 'INVOICE_LINE_BELOW_RETURNED_QTY';
export const EDIT_RETURNED_LINE_PRICE_LOCKED = 'INVOICE_RETURNED_LINE_PRICE_LOCKED';
export const EDIT_BELOW_CREDIT_NOTES = 'INVOICE_BELOW_CREDIT_NOTES';

export class InvoiceEditLineRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'InvoiceEditLineRejected';
  }
}

/** Die Zeilen der Rechnung, wie sie jetzt gespeichert sind — mit ihrer zurückgenommenen Menge. */
export function loadEditBaseLines(invoiceId: string): EditBaseLine[] {
  return query(
    `SELECT il.id, il.product_id, il.lot_id, il.quantity, il.unit_price, il.tax_scheme, il.purchase_price_snapshot, il.stock_taken,
            COALESCE((SELECT SUM(srl.quantity) FROM sales_return_lines srl
                        JOIN sales_returns sr ON sr.id = srl.return_id
                       WHERE srl.invoice_line_id = il.id AND sr.status != 'REJECTED'), 0) AS returned_qty
       FROM invoice_lines il
      WHERE il.invoice_id = ?
      ORDER BY il.position, il.id`,
    [invoiceId],
  ).map((r) => ({
    id: String(r.id),
    productId: (r.product_id as string | null) || null,
    lotId: (r.lot_id as string | null) || null,
    qty: Math.max(1, Number(r.quantity ?? 1) || 1),
    unitPrice: Number(r.unit_price ?? 0),
    taxScheme: String(r.tax_scheme ?? ''),
    purchasePrice: Number(r.purchase_price_snapshot ?? 0),
    stockTaken: r.stock_taken === null || r.stock_taken === undefined ? null : Number(r.stock_taken),
    returnedQty: Number(r.returned_qty ?? 0),
  }));
}

const samePrice = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

/**
 * Welche gespeicherte Zeile entspricht welcher neuen? Ergebnis: je neue Zeile die ID der
 * gespeicherten Zeile, die sie fortsetzt, oder `null` (neu). Maßgeblich ist der Artikel; gibt es
 * denselben Artikel mehrmals, gewinnt zuerst die Zeile mit gleichem Preis und gleicher Steuerart,
 * dann die Reihenfolge. Jede gespeicherte Zeile wird höchstens einmal fortgesetzt.
 */
export function matchEditLines(base: readonly EditBaseLine[], next: readonly EditInputLine[]): Array<string | null> {
  const used = new Set<string>();
  const out: Array<string | null> = next.map(() => null);
  // Zwei Durchgänge: erst exakte Treffer (Artikel + Preis + Steuerart), dann nur Artikel.
  for (const exact of [true, false]) {
    next.forEach((n, i) => {
      if (out[i] !== null || !n.productId) return;
      const hit = base.find((b) => !used.has(b.id) && b.productId === n.productId
        && (!exact || (samePrice(b.unitPrice, n.unitPrice) && b.taxScheme === n.taxScheme)));
      if (hit) { used.add(hit.id); out[i] = hit.id; }
    });
  }
  return out;
}

function productLabel(productId: string | null): string {
  if (!productId) return 'this item';
  const r = query('SELECT brand, name, sku FROM products WHERE id = ?', [productId])[0];
  const label = [r?.brand, r?.name].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
  return label || String(r?.sku ?? '') || productId;
}
const fmtQty = (q: number): string => String(Math.round(q * 1000) / 1000);

/**
 * Vor jedem Schreiben: verletzt die gewünschte Änderung eine Retoure oder eine Gutschrift?
 * Wirft `InvoiceEditLineRejected` mit Kennung und verständlichem Satz; sonst nichts.
 */
export function assertEditKeepsReturns(
  invoiceId: string,
  base: readonly EditBaseLine[],
  next: readonly EditInputLine[],
  match: ReadonlyArray<string | null>,
): void {
  for (const b of base) {
    if (!(b.returnedQty > 0.0005)) continue;
    const i = match.indexOf(b.id);
    const label = productLabel(b.productId);
    if (i < 0) {
      throw new InvoiceEditLineRejected(EDIT_LINE_HAS_RETURN,
        `This item has a return and cannot be removed or replaced on the invoice: ${label}. `
        + 'Cancel the return first if the item really has to change.');
    }
    const n = next[i];
    const qty = Math.max(1, n.quantity || 1);
    if (qty < b.returnedQty - 0.0005) {
      throw new InvoiceEditLineRejected(EDIT_BELOW_RETURNED_QTY,
        `The quantity of ${label} cannot go below ${fmtQty(b.returnedQty)} — that many were already returned.`);
    }
    if (!samePrice(n.unitPrice, b.unitPrice) || n.taxScheme !== b.taxScheme) {
      throw new InvoiceEditLineRejected(EDIT_RETURNED_LINE_PRICE_LOCKED,
        `The price of ${label} cannot be changed — it has a return, and its credit note was issued at the current price.`);
    }
  }
  const cn = Number(query(
    `SELECT COALESCE(SUM(total_amount), 0) AS t FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'`,
    [invoiceId],
  )[0]?.t ?? 0);
  const newGross = next.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
  if (cn > newGross + 0.005) {
    throw new InvoiceEditLineRejected(EDIT_BELOW_CREDIT_NOTES,
      `The invoice total cannot go below its credit notes (${cn.toFixed(3)} BHD).`);
  }
}

/** Was wirksame Gutschriften von der Forderung dieser Rechnung schon abgezogen haben. */
export function creditNoteReceivableCancel(invoiceId: string): number {
  return Number(query(
    `SELECT COALESCE(SUM(receivable_cancel_amount), 0) AS c FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'`,
    [invoiceId],
  )[0]?.c ?? 0);
}

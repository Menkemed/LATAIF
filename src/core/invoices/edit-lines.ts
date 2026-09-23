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
//
// Welche gespeicherte Zeile eine neue fortsetzt, sagt die ZEILEN-ID (`lineId`), die Maske und PC2
// für jede geladene Zeile mitschicken. Nur eine Gegenstelle ohne IDs wird über Artikel/Preis
// zugeordnet — und auch das nur, wo es eindeutig ist: steht derselbe Artikel mehrfach auf der
// Rechnung und hat eine dieser Zeilen eine Retoure, wird nicht geraten, sondern abgelehnt.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { hasLotHistory } from '@/core/lots/stock-contract';
import { calcInvoiceLine, vatRateFor, type LineScheme } from '@/core/invoices/line-derivation';

export interface EditBaseLine {
  id: string;
  productId: string | null;
  lotId: string | null;
  qty: number;
  unitPrice: number;
  taxScheme: string;
  purchasePrice: number;
  vatRate: number;
  vatAmount: number;
  lineTotal: number;
  /** Was die Zeile aus dem Bestand genommen hat (NULL = Zeile von vor dem Bestandsvertrag). */
  stockTaken: number | null;
  /** Menge, die aus wirksamen Retouren (nicht REJECTED) von dieser Zeile schon zurückgenommen ist. */
  returnedQty: number;
}

export interface EditInputLine {
  /** Die ID der gespeicherten Zeile, die diese Zeile fortsetzt (fehlt bei neuen Zeilen). */
  lineId?: string;
  productId: string;
  quantity?: number;
  unitPrice: number;
  taxScheme: string;
  vatRate?: number;
  lineTotal: number;
}

/** Die fachlichen Neins, als Kennung — die Oberfläche zeigt nur den Satz. */
export const EDIT_LINE_HAS_RETURN = 'INVOICE_LINE_HAS_RETURN';
export const EDIT_BELOW_RETURNED_QTY = 'INVOICE_LINE_BELOW_RETURNED_QTY';
export const EDIT_RETURNED_LINE_PRICE_LOCKED = 'INVOICE_RETURNED_LINE_PRICE_LOCKED';
export const EDIT_BELOW_CREDIT_NOTES = 'INVOICE_BELOW_CREDIT_NOTES';
export const EDIT_LINE_ID_INVALID = 'INVOICE_EDIT_LINE_ID_INVALID';
export const EDIT_AMBIGUOUS_RETURNED_LINE = 'INVOICE_EDIT_AMBIGUOUS_RETURNED_LINE';
export const EDIT_RETURNED_LINE_LOT_UNKNOWN = 'INVOICE_RETURNED_LINE_LOT_UNKNOWN';
export const EDIT_KEPT_LINE_LOT_SHORT = 'INVOICE_KEPT_LINE_LOT_SHORT';

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
            il.vat_rate, il.vat_amount, il.line_total,
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
    vatRate: Number(r.vat_rate ?? 0),
    vatAmount: Number(r.vat_amount ?? 0),
    lineTotal: Number(r.line_total ?? 0),
    stockTaken: r.stock_taken === null || r.stock_taken === undefined ? null : Number(r.stock_taken),
    returnedQty: Number(r.returned_qty ?? 0),
  }));
}

const samePrice = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

const RELOAD = 'The invoice has changed since it was opened — reload it and edit it again.';

/**
 * Welche gespeicherte Zeile entspricht welcher neuen? Ergebnis: je neue Zeile die ID der
 * gespeicherten Zeile, die sie fortsetzt, oder `null` (neu).
 *
 * • Trägt die Anfrage Zeilen-IDs, gelten NUR sie: jede ID muss zu dieser Rechnung gehören und darf
 *   höchstens einmal vorkommen; eine Zeile ohne ID ist neu. Wechselt unter einer ID der Artikel,
 *   ist das ein Ersetzen: die alte Zeile fällt weg, die neue bekommt eine neue ID.
 * • Ohne IDs (ältere Gegenstelle): Zuordnung über Artikel (zuerst mit gleichem Preis und gleicher
 *   Steuerart, dann Reihenfolge) — aber nicht, wo eine retournierte Zeile verwechselt werden
 *   könnte: steht ihr Artikel mehrfach auf der Rechnung, wird abgelehnt.
 */
export function matchEditLines(base: readonly EditBaseLine[], next: readonly EditInputLine[]): Array<string | null> {
  const used = new Set<string>();
  const out: Array<string | null> = next.map(() => null);
  if (next.some((n) => !!n.lineId)) {
    const byId = new Map(base.map((b) => [b.id, b]));
    next.forEach((n, i) => {
      if (!n.lineId) return;
      const b = byId.get(n.lineId);
      if (!b || used.has(n.lineId)) throw new InvoiceEditLineRejected(EDIT_LINE_ID_INVALID, RELOAD);
      used.add(n.lineId);
      if (b.productId === n.productId) out[i] = n.lineId;   // anderer Artikel = ersetzen → neue Zeile
    });
    return out;
  }
  for (const b of base) {
    if (!(b.returnedQty > 0.0005) || !b.productId) continue;
    if (base.filter((x) => x.productId === b.productId).length > 1) {
      throw new InvoiceEditLineRejected(EDIT_AMBIGUOUS_RETURNED_LINE,
        `${productLabel(b.productId)} is on this invoice more than once and one of the lines has a return — `
        + 'reload the invoice and edit it again, so each line keeps its own return.');
    }
  }
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
    // Preis, Steuerart, Steuersatz und Betrag PRO STÜCK (ein Rabatt ist hier eine Preisänderung).
    const unitTotalNew = (Number(n.lineTotal) || 0) / qty;
    const unitTotalOld = b.lineTotal / b.qty;
    const rateChanged = n.vatRate !== undefined && Math.abs(Number(n.vatRate) - b.vatRate) > 0.0005;
    if (!samePrice(n.unitPrice, b.unitPrice) || n.taxScheme !== b.taxScheme || rateChanged
      || Math.abs(unitTotalNew - unitTotalOld) > 0.005) {
      throw new InvoiceEditLineRejected(EDIT_RETURNED_LINE_PRICE_LOCKED,
        `The price of ${label} cannot be changed — it has a return, and its credit note was issued at the current price.`);
    }
    // Das Los einer retournierten Zeile bleibt, was es war. Kennt die Zeile ihr Los nicht (von vor
    // dem Bestandsvertrag, Artikel mit Losen), müsste es neu gewählt werden — das würde den
    // Wareneinsatz der Retoure verschieben.
    if (b.lotId === null && b.productId && hasLotHistory(b.productId)) {
      throw new InvoiceEditLineRejected(EDIT_RETURNED_LINE_LOT_UNKNOWN,
        `${label} has a return but its stock lot is not recorded on this invoice — it cannot be edited automatically.`);
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

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Die Beträge einer retournierten Zeile für die neue Menge — pro Stück genau wie gespeichert.
 * Preis und Steuerart sind oben schon festgehalten; so kann auch ein anders gerechneter
 * Einstand (Marge) auf der Gegenseite die Steuer der Zeile nicht verschieben.
 */
export function frozenReturnedLineAmounts(b: EditBaseLine, qty: number): { vatAmount: number; lineTotal: number } {
  return { vatAmount: round3(b.vatAmount / b.qty * qty), lineTotal: round3(b.lineTotal / b.qty * qty) };
}

/**
 * INVOICE-EDIT S2 (Marge) — die Beträge einer FORTGESETZTEN Zeile rechnet das Haus, nicht die
 * Gegenstelle. Bei MARGIN hängt die Steuer am Einstand; rechnete die Maske mit einem anderen Los
 * als dem, das die Zeile hält, verschöbe schon eine reine Notizänderung die Steuer, während der
 * Einstand der Zeile bleibt. Maske und PC2 laufen beide hier durch — eine Rechnung, eine Regel.
 *   • Zeile mit Retoure → pro Stück genau wie gespeichert (`frozenReturnedLineAmounts`).
 *   • fachlich unverändert (Menge, Nettopreis, Steuerart, Satz) → die gespeicherten Beträge
 *     bleiben, auch wenn eine heutige Rechnung anders ergäbe — nichts wird still überschrieben.
 *   • sonst → neu aus dem Einstand, den die Zeile wirklich hält (`costBasis`).
 */
export function keptLineAmounts(
  b: EditBaseLine,
  n: { quantity?: number; unitPrice: number; taxScheme: string; vatRate?: number },
  costBasis: number,
): { unitPrice: number; vatAmount: number; lineTotal: number } {
  const qty = Math.max(1, n.quantity || 1);
  if (b.returnedQty > 0.0005) return { unitPrice: b.unitPrice, ...frozenReturnedLineAmounts(b, qty) };
  const rate = Number.isFinite(n.vatRate) ? Number(n.vatRate) : vatRateFor(n.taxScheme as LineScheme);
  const unchanged = Math.abs(qty - b.qty) < 0.0005 && samePrice(n.unitPrice, b.unitPrice)
    && n.taxScheme === b.taxScheme && Math.abs(rate - b.vatRate) < 0.0005;
  if (unchanged) return { unitPrice: b.unitPrice, vatAmount: b.vatAmount, lineTotal: b.lineTotal };
  const calc = calcInvoiceLine(n.unitPrice, qty, costBasis, n.taxScheme as LineScheme, rate);
  return { unitPrice: n.unitPrice, vatAmount: calc.internalVatAmount || calc.vatAmount, lineTotal: calc.grossAmount };
}

/** Der Satz, wenn eine fortgesetzte Zeile mehr braucht, als ihr eigenes Los noch hat (Maske und Haus). */
export function keptLineLotShortMessage(label: string, rest: number): string {
  return rest > 0.0005
    ? `Only ${fmtQty(rest)} more of ${label} left in the stock lot this line was sold from. `
      + 'Lower the quantity, or add the extra pieces as a new line.'
    : `The stock lot this line of ${label} was sold from has nothing left. `
      + 'Keep the quantity, or add the extra pieces as a new line.';
}

/**
 * Eine fortgesetzte Zeile bleibt auf ihrem Los; braucht sie mehr, muss DIESES Los es haben.
 * Wirft mit verständlichem Satz statt des allgemeinen „nicht mehr auf Lager".
 */
export function assertKeptLinesStock(picks: ReadonlyArray<{ productId: string; lotId: string | null; extra: number }>): void {
  const want = new Map<string, { productId: string; extra: number }>();
  for (const p of picks) {
    if (!p.lotId || !(p.extra > 0.0005)) continue;
    const w = want.get(p.lotId);
    want.set(p.lotId, { productId: p.productId, extra: (w?.extra ?? 0) + p.extra });
  }
  for (const [lotId, w] of want) {
    const r = query('SELECT qty_remaining, status FROM stock_lots WHERE id = ?', [lotId])[0];
    const rest = r && r.status !== 'CANCELLED' ? Math.max(0, Number(r.qty_remaining ?? 0)) : 0;
    if (w.extra > rest + 0.0005) {
      throw new InvoiceEditLineRejected(EDIT_KEPT_LINE_LOT_SHORT, keptLineLotShortMessage(productLabel(w.productId), rest));
    }
  }
}

/** Was wirksame Gutschriften von der Forderung dieser Rechnung schon abgezogen haben. */
export function creditNoteReceivableCancel(invoiceId: string): number {
  return Number(query(
    `SELECT COALESCE(SUM(receivable_cancel_amount), 0) AS c FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'`,
    [invoiceId],
  )[0]?.c ?? 0);
}

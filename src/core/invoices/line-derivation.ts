// CENTRAL-C3B — die eine Stelle, an der aus einer Eingabe eine Rechnungszeile wird.
//
// Bisher stand diese Ableitung im Formular (`InvoiceCreate.tsx`): Steuerschema auflösen, Satz
// bestimmen, `vatEngine.calculateNet` rufen, daraus die Zeile für `createDirectInvoice` bauen. Das
// war richtig, solange nur ein Mensch vor einem Fenster Rechnungen schrieb. Sobald ein zweiter
// Rechner dieselbe Rechnung schickt, darf diese Rechnung NICHT ein zweites Mal irgendwo entstehen —
// sonst gäbe es zwei Wahrheiten über Netto, MwSt und Zeilensumme, die eine Weile gleich aussehen
// und irgendwann auseinanderlaufen.
//
// Deshalb liegt sie hier, und beide Wege benutzen sie: das Formular auf dem Primary und der
// Fernauftrag. Es ist ausdrücklich KEINE neue Buchhaltungslogik — es ist dieselbe, nur an einem
// Ort. `vatEngine` bleibt die Rechenmaschine, die Rundung ändert sich nicht.

import { vatEngine } from '@/core/tax/vat-engine';
import type { TaxCalculation } from '@/core/tax/vat-engine';

export type LineScheme = 'VAT_10' | 'ZERO' | 'MARGIN';

/** Was in einer Zeile stehen darf, bevor gerechnet wurde. `auto` heißt: das Schema des Produkts. */
export type RequestedScheme = LineScheme | 'auto';

export function resolveLineScheme(requested: RequestedScheme | undefined, productScheme: string | undefined): LineScheme {
  if (requested && requested !== 'auto') return requested;
  const p = productScheme as LineScheme | undefined;
  return p === 'ZERO' || p === 'MARGIN' || p === 'VAT_10' ? p : 'VAT_10';
}

/** Nullsatz nur bei ZERO — die Zahl stand vorher genauso im Formular. */
export function vatRateFor(scheme: LineScheme): number {
  return scheme === 'ZERO' ? 0 : 10;
}

/**
 * `calculateNet` erwartet den Netto-Betrag der GANZEN Position, nicht den pro Stück — deshalb die
 * Multiplikation mit der Menge. (Wortgleich der alte `calcLine` aus dem Formular.)
 */
export function calcInvoiceLine(
  unitPrice: number,
  qty: number,
  purchasePrice: number,
  scheme: LineScheme,
  vatRate: number,
): TaxCalculation {
  return vatEngine.calculateNet(unitPrice * qty, purchasePrice * qty, scheme, vatRate);
}

/** Genau die Form, die `createDirectInvoice` erwartet. */
export interface InvoiceLineInput {
  productId: string;
  lotId?: string;
  quantity: number;
  unitPrice: number;
  purchasePrice: number;
  taxScheme: string;
  vatRate: number;
  vatAmount: number;
  lineTotal: number;
}

/**
 * Baut eine Zeile aus dem, was ein Mensch wählt (Produkt, Los, Menge, Preis, Schema) und dem, was
 * das Haus dazu weiß (Einstandskosten des Loses). Alles Abgeleitete entsteht HIER — nie beim
 * Aufrufer, und schon gar nicht auf einem anderen Rechner.
 *
 * `vatAmount` ist bei MARGIN bewusst die interne MwSt auf die Marge (kundenseitig nicht sichtbar,
 * aber für Ledger und NBR nötig) — genau die Regel, die das Formular seit v0.7.1 anwendet.
 */
export function toInvoiceLine(input: {
  productId: string;
  lotId?: string | null;
  quantity: number;
  unitPrice: number;
  costBasis: number;
  scheme: LineScheme;
}): InvoiceLineInput {
  const qty = Math.max(1, input.quantity);
  const vatRate = vatRateFor(input.scheme);
  const calc = calcInvoiceLine(input.unitPrice, qty, input.costBasis, input.scheme, vatRate);
  return {
    productId: input.productId,
    lotId: input.lotId ?? undefined,
    quantity: qty,
    // Netto pro Stück — die Detailansicht rechnet damit weiter.
    unitPrice: calc.netAmount / qty,
    purchasePrice: input.costBasis,
    taxScheme: input.scheme,
    vatRate,
    vatAmount: calc.internalVatAmount || calc.vatAmount,
    lineTotal: calc.grossAmount,
  };
}

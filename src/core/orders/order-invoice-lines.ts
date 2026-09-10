// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5A.2 — die Rechnungszeilen eines Auftrags, an EINEM Ort.
//
// Diese Rechnung stand bis hierher IN der Auftragsansicht (`convertWithPersistedSchemes`). Der
// Fernbefehl `orders.convert_to_invoice` konnte sie nicht erreichen und rechnete deshalb selbst —
// und zwar anders: Steuer immer obendrauf (`netto × Satz`). Fuer eine MARGIN-Zeile hiess das 10 %
// mehr auf der Rechnung, fuer ein Sonderstueck mit VAT_10 die Steuer ein zweites Mal auf den
// Bruttopreis. Dazu fielen die Wahl im Schema-Dialog und die Sondernummer still weg.
//
// Hier steht die Rechnung unveraendert, Wort fuer Wort aus der Ansicht gehoben. Beide Seiten rufen
// sie: die Auftragsansicht am Primary und der Fernbefehl innerhalb seiner Transaktion. Was sich
// unterscheidet, wird HINEINGEREICHT (woher ein Artikel kommt, wie einer entsteht) — nicht
// nachgebaut.
// ════════════════════════════════════════════════════════════════════════════
import { vatEngine } from '@/core/tax/vat-engine';
import type { Order, OrderLine, Product, TaxScheme } from '@/core/models/types';

export interface OrderInvoiceLineInput {
  productId: string; quantity: number; unitPrice: number; purchasePrice: number;
  taxScheme: string; vatRate: number; vatAmount: number; lineTotal: number;
}

/**
 * v0.6.0 Model B — Kostenbasis des fertigen Custom-Stuecks = Summe aller internen
 * Kostenpositionen (Labor + Diamond + Gold) des Auftrags.
 */
export function orderCustomCostBasis(lines: readonly OrderLine[]): number {
  return lines.reduce((s, l) => s + (l.costAmount || 0), 0);
}

export interface BuildOrderInvoiceLinesArgs {
  order: Order;
  /** Die abzurechnenden, kundenseitigen Positionen. */
  billableLines: readonly OrderLine[];
  /** v0.6.7 — Schema aus dem ConfirmTaxSchemeModal-Override, sonst persistiert. */
  perLineSchemes?: Record<string, TaxScheme>;
  customCostBasis: number;
  findProduct: (productId: string) => Product | undefined;
  /** Wie ein fehlender Artikel entsteht — am Primary `createProduct`, im Fernbefehl ein Nein. */
  createProduct: (data: Partial<Product>) => Product;
}

// Direkter Convert-Pfad: Pro Order-Line wird eine Invoice-Line gebaut, mit
// der in OrderCreate gewählten Scheme. order_lines.unit_price ist Netto pro Stück
// (siehe OrderCreate.unitNetFromGross), daher: lineNet = unitPrice × qty,
// dann vatEngine.calculateNet → vat + gross. Keine Doppelbesteuerung möglich,
// weil wir nicht erneut auf einen schon-gross-Wert rechnen.
export function buildOrderInvoiceLines(args: BuildOrderInvoiceLinesArgs): OrderInvoiceLineInput[] {
  const { order, billableLines, perLineSchemes, customCostBasis, findProduct, createProduct } = args;
  const invoiceLineInputs: OrderInvoiceLineInput[] = [];

  for (const ol of billableLines) {
    // v0.6.7 — Schema aus dem ConfirmTaxSchemeModal-Override, sonst persistiert.
    const scheme = (perLineSchemes?.[ol.id] as TaxScheme | undefined) || (ol.taxScheme as TaxScheme);
    const rate = scheme === 'ZERO' ? 0 : 10;
    let prod = ol.productId ? findProduct(ol.productId) : undefined;
    // Für freitext-Lines ohne Produkt eines auto-erzeugen — analog zum bisherigen
    // Single-Line-Auto-Create, nur jetzt pro Line.
    if (!prod) {
      // v0.6.0 Model B — das Custom-Stueck wird gefertigt, nicht gekauft:
      // seine Kostenbasis (COGS) = Summe der internen Kostenpositionen der
      // Order. Kein Purchase, kein Lager-Durchlauf ('reserved' statt 'in_stock').
      const isCustomPiece = ol.materialKind === 'custom';
      // v0.6.7 — bei Custom-Quote die strukturierte Produkt-Spec nutzen wenn da.
      const spec = isCustomPiece ? (order.customProductSpec || {}) : {};
      prod = createProduct({
        categoryId: spec.categoryId || order.categoryId || '',
        brand: spec.brand || order.requestedBrand || '',
        name: spec.name || ol.description || order.requestedModel || 'Custom Item',
        sku: spec.sku,
        condition: spec.condition || order.condition || '',
        attributes: (spec.attributes as Record<string, string | number | boolean | string[]>) || order.attributes || {},
        images: spec.images || [],
        scopeOfDelivery: spec.scopeOfDelivery || [],
        purchasePrice: isCustomPiece ? customCostBasis : 0,
        plannedSalePrice: ol.unitPrice * Math.max(1, ol.quantity),
        stockStatus: 'reserved',
        taxScheme: scheme,
        sourceType: 'OWN',
        notes: spec.notes || `From order ${order.orderNumber}`,
      });
    }
    const qty = Math.max(1, ol.quantity);
    // v0.6.7 — Custom-Quote-Lines speichern BRUTTO (Quoted Price = Endpreis).
    // Bei VAT_10 auf Custom: lineNet aus brutto decomposen, sonst rechnet
    // calculateNet 10% on-top und der Kunde wuerde Quoted * 1.10 zahlen.
    // Normal-Produkt-Lines speichern Netto (siehe OrderCreate.unitNetFromGross),
    // dort lineNet = unitPrice * qty wie bisher.
    const grossPerLine = ol.unitPrice * qty;
    let lineNet: number;
    if (ol.materialKind === 'custom' && scheme === 'VAT_10') {
      lineNet = grossPerLine / 1.10;
    } else {
      lineNet = grossPerLine;
    }
    const calc = vatEngine.calculateNet(lineNet, (prod.purchasePrice || 0) * qty, scheme, rate);
    // v0.7.1 — NBR: MARGIN persistiert internalVatAmount damit MARGIN_VAT-Ledger
    // + invoice.vatAmount-Hero korrekt sind. Display-Schicht versteckt VAT bei
    // MARGIN-Print weiterhin (gesetzliche Differenzbesteuerung).
    const persistedVat = calc.internalVatAmount ?? calc.vatAmount;
    invoiceLineInputs.push({
      productId: prod.id,
      quantity: qty,
      unitPrice: lineNet / qty,
      purchasePrice: prod.purchasePrice || 0,
      taxScheme: scheme,
      vatRate: rate,
      vatAmount: persistedVat,
      lineTotal: calc.grossAmount,
    });
  }
  return invoiceLineInputs;
}

/**
 * M-07 — Option 3: "Auftrag abschliessen" angehakt → die invoicten Positionen auf DELIVERED
 * setzen (NACH der atomaren Konvertierung). recomputeOrderStatus (in updateOrderLineStatus)
 * rollt die Order auf 'completed', sobald ALLE kundenseitigen Lines DELIVERED sind; bei
 * Teil-Convert bleibt sie 'arrived'.
 */
export function markConvertedLinesDelivered(
  lines: readonly OrderLine[], setStatus: (lineId: string, status: 'DELIVERED') => void,
): void {
  for (const l of lines) {
    try { setStatus(l.id, 'DELIVERED'); }
    catch (err) { console.warn('[order] mark-complete-on-convert failed:', err); }
  }
}

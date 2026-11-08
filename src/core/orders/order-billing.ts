// ════════════════════════════════════════════════════════════════════════════
// ORDER ↔ INVOICE (v0.8.99) — was eine Order nach der Umwandlung als Betrag und Zahlstand zeigt (rein, ohne Datenbank).
//
// Vorher rechneten Liste und Detail der Order nur mit dem Auftragspreis und den NOCH OFFENEN Anzahlungen. Nach der
// Umwandlung ist die Anzahlung auf die Rechnung angerechnet (offen 0), und Zahlungen landen auf der Rechnung — die Order
// blieb „Unpaid", und eine Preisänderung der Rechnung erschien nie. Jetzt gilt:
//   • ohne aktive Rechnung: wie bisher — Auftragspreis, offene Anzahlungen;
//   • mit Rechnung(en): die Rechnung ist maßgeblich — Betrag = Rechnungsbrutto (aktuell), offen = Brutto − wirksame
//     Gutschriften − Rechnungszahlungen (darin die angerechneten Anzahlungen, Art 'order_deposit'); dazu, bei einer
//     Teilumwandlung, der Wert der noch nicht berechneten Kundenzeilen und die noch offenen Anzahlungen. Nichts doppelt.
//   • der Auftragspreis bleibt als ursprünglicher Wert (`originalPrice`) sichtbar.
// Gelesen wird über `orderPaidTotalsFor` (page-reads) — am Primary direkt, am PC2 über denselben Lesebefehl.
// ════════════════════════════════════════════════════════════════════════════
import { vatEngine } from '@/core/tax/vat-engine';
import { canonicalTaxScheme, deriveOrderPaymentStatus, type OrderPaymentStatus, type TaxScheme } from '@/core/models/types';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const EPS = 0.005;

/** Eine verknüpfte, nicht stornierte Rechnung der Order. */
export interface OrderInvoiceFigure {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  gross: number;
  paid: number;
  /** Was wirksame Gutschriften von der Forderung abgezogen haben (`receivable_cancel_amount`). */
  creditCancel: number;
}

export interface OrderBilling {
  orderId: string;
  /** Mindestens eine aktive Rechnung hängt an der Order. */
  invoiced: boolean;
  /** Keine Kundenzeile mehr offen — Zahlungen gehören auf die Rechnung. */
  fullyInvoiced: boolean;
  /** Der Auftragspreis, wie vereinbart (bleibt nachvollziehbar). */
  originalPrice: number;
  /** Summe der Rechnungsbeträge (aktuell). */
  invoiceTotal: number;
  /** Wert der noch nicht berechneten Kundenzeilen (Teilumwandlung). */
  uninvoiced: number;
  /** Aktueller Gesamtbetrag der Order: Rechnungen + noch nicht berechnet. */
  total: number;
  /** Bezahlt: Rechnungszahlungen (inkl. angerechneter Anzahlungen) + noch offene Anzahlungen. */
  paid: number;
  remaining: number;
  status: OrderPaymentStatus;
  invoices: Array<{ invoiceId: string; invoiceNumber: string; open: number }>;
  /** Die Rechnung, auf die eine Zahlung jetzt gehört (die erste noch offene). */
  payInvoiceId?: string;
}

/** Brutto einer Kundenzeile der Order — dieselbe Regel wie die Umwandlung (`buildOrderInvoiceLines`, Steuerart der Zeile). */
export function orderLineGross(l: { unitPrice: number; quantity: number; taxScheme?: string | null; materialKind?: string | null }): number {
  const qty = Math.max(1, Number(l.quantity) || 1);
  const preis = Number(l.unitPrice) || 0;
  if (l.materialKind === 'custom') return r3(preis * qty);
  let scheme: TaxScheme;
  try { scheme = canonicalTaxScheme(String(l.taxScheme ?? 'ZERO')) as TaxScheme; } catch { scheme = 'ZERO'; }
  return vatEngine.calculateNet(preis * qty, 0, scheme, scheme === 'ZERO' ? 0 : 10).grossAmount;
}

/**
 * Der Stand einer Order. `lineLinked`: die Order führt ihre Rechnung je Zeile (`order_lines.invoice_id`) — nur dann zählt
 * ein Rest offener Kundenzeilen; ein Altauftrag, der nur am Kopf auf seine Rechnung zeigt, gilt als ganz berechnet.
 */
export function orderBillingOf(input: {
  orderId: string; agreedPrice: number; openDeposits: number; invoices: OrderInvoiceFigure[]; uninvoicedGross: number; lineLinked: boolean;
}): OrderBilling {
  const originalPrice = r3(Math.max(0, Number(input.agreedPrice) || 0));
  const offenAnz = r3(Math.max(0, Number(input.openDeposits) || 0));
  if (input.invoices.length === 0) {
    const status = deriveOrderPaymentStatus(originalPrice, offenAnz);
    return {
      orderId: input.orderId, invoiced: false, fullyInvoiced: false, originalPrice, invoiceTotal: 0, uninvoiced: 0,
      total: originalPrice, paid: offenAnz, remaining: r3(Math.max(0, originalPrice - offenAnz)), status, invoices: [],
    };
  }
  const uninvoiced = input.lineLinked ? r3(Math.max(0, input.uninvoicedGross)) : 0;
  const rechnungen = input.invoices.map((i) => ({
    invoiceId: i.invoiceId, invoiceNumber: i.invoiceNumber,
    owed: r3(Math.max(0, i.gross - i.creditCancel)),
    paid: r3(Math.max(0, i.paid)),
    open: r3(Math.max(0, i.gross - i.creditCancel - i.paid)),
  }));
  const invoiceTotal = r3(input.invoices.reduce((s, i) => s + i.gross, 0));
  const owed = r3(rechnungen.reduce((s, i) => s + i.owed, 0) + uninvoiced);
  const paid = r3(rechnungen.reduce((s, i) => s + Math.min(i.paid, i.owed), 0) + offenAnz);
  const remaining = r3(Math.max(0, owed - paid));
  // „Paid" nur, wenn wirklich bezahlt ist, was geschuldet wird. Ist durch Gutschriften nichts mehr geschuldet, zählt nur Geld.
  const status: OrderPaymentStatus = owed > EPS
    ? (remaining <= EPS ? 'PAID' : paid > EPS ? 'PARTIALLY_PAID' : 'UNPAID')
    : (paid > EPS ? 'PAID' : 'UNPAID');
  const offen = rechnungen.find((i) => i.open > EPS);
  return {
    orderId: input.orderId, invoiced: true, fullyInvoiced: uninvoiced <= EPS, originalPrice, invoiceTotal, uninvoiced,
    total: r3(invoiceTotal + uninvoiced), paid, remaining, status,
    invoices: rechnungen.map((i) => ({ invoiceId: i.invoiceId, invoiceNumber: i.invoiceNumber, open: i.open })),
    ...(offen ? { payInvoiceId: offen.invoiceId } : {}),
  };
}

// SSOT fuer Verkaufs-Kennzahlen ALLER Reports (Dashboard, Sales-Report,
// Executive Summary, Analytics, KPI-Cards). Eine einzige Realisierungsregel,
// damit die Zahlen nie wieder auseinanderlaufen.
//
// REGEL:
//  - nur FINAL-Rechnungen (voll bezahlt) in der Periode (auf issuedAt ?? createdAt)
//  - Rueckerstattungen (cash auf FINAL-Invoices, Refund-Datum in Periode) werden
//    ANTEILIG (paid / gross) von ALLEN Kennzahlen abgezogen — einheitlich, auch Cost
//  - kundensichtbare VAT NUR aus VAT_10-Lines (Margin-VAT ist intern; siehe M-11)
//  - Scrap/Altgold ist NICHT enthalten (separat ausweisen) — die Funktion nimmt
//    bewusst keine Scrap-Daten entgegen
//
// Reine Funktion: der Aufrufer reicht die bereits geladenen Invoices/Returns rein
// (loest die SQL-vs-JS-Huerde — die LOGIK ist zentral, die Datenbeschaffung bleibt
// beim jeweiligen Report). Customer-/Kategorie-Filter sind Sache des Aufrufers
// (vorgefilterte Liste reinreichen).
//
// Schmale Input-Interfaces (nur die gelesenen Felder): so passen sowohl die vollen
// Store-Objekte (Invoice[]/SalesReturn[] — strukturell zuweisbar) als auch von SQL
// gebaute Minimal-Objekte (z.B. context.ts/headless) ohne Cast.

export interface SalesMetricsLine {
  taxScheme: string;
  vatAmount: number;
}

export interface SalesMetricsInvoice {
  id: string;
  status: string;
  grossAmount: number;
  netAmount: number;
  marginSnapshot?: number;
  purchasePriceSnapshot?: number;
  issuedAt?: string;
  createdAt?: string;
  lines: SalesMetricsLine[];
}

export interface SalesMetricsReturn {
  invoiceId: string;
  refundPaidAmount: number;
  refundPaidDate?: string;
  returnDate?: string;
}

export interface SalesPeriod {
  from: string;   // ISO (inklusive)
  to: string;     // ISO (inklusive)
}

export interface SalesMetrics {
  count: number;    // Anzahl FINAL-Rechnungen in der Periode
  gross: number;    // Brutto-Umsatz (inkl. VAT) abzgl. Cash-Refunds
  net: number;      // Netto-Umsatz abzgl. anteiligem Refund-Netto
  vat: number;      // kundensichtbare VAT (nur VAT_10-Lines) abzgl. anteiligem Refund-VAT
  profit: number;   // Marge (marginSnapshot) abzgl. anteiligem Refund-Profit
  cost: number;     // Wareneinsatz (purchasePriceSnapshot) abzgl. anteiligem Refund-Cost
}

// Kundensichtbare VAT einer Rechnung = nur VAT_10-Lines (Differenzbesteuerung/MARGIN
// traegt internen VAT, der nicht auf der Rechnung ausgewiesen ist — siehe M-11).
function vat10Of(inv: SalesMetricsInvoice): number {
  return (inv.lines || []).reduce(
    (s, l) => s + (l.taxScheme === 'VAT_10' ? (l.vatAmount || 0) : 0), 0);
}

function invoiceInPeriod(inv: SalesMetricsInvoice, period: SalesPeriod): boolean {
  const when = inv.issuedAt || inv.createdAt;
  if (!when) return true;   // ohne Datum: nicht ausschliessen (wie salesReport)
  return when >= period.from && when <= period.to;
}

export function computeSalesMetrics(
  invoices: SalesMetricsInvoice[],
  salesReturns: SalesMetricsReturn[],
  period: SalesPeriod,
): SalesMetrics {
  const finalInvs = invoices.filter(i => i.status === 'FINAL' && invoiceInPeriod(i, period));
  const finalIds = new Set(finalInvs.map(i => i.id));
  const finalById = new Map(finalInvs.map(i => [i.id, i]));

  let gross = 0, net = 0, vat = 0, profit = 0, cost = 0;
  for (const i of finalInvs) {
    gross += i.grossAmount || 0;
    net += i.netAmount || 0;
    vat += vat10Of(i);
    profit += i.marginSnapshot || 0;
    cost += i.purchasePriceSnapshot || 0;
  }

  // Rueckerstattungen: cash tatsaechlich erstattet, nur auf FINAL-Invoices, nur wenn
  // das Refund-Datum in der Periode liegt. Proportional ueber gross verteilt.
  const fromDay = period.from.slice(0, 10);
  const toDay = period.to.slice(0, 10);
  for (const r of salesReturns) {
    if (!finalIds.has(r.invoiceId)) continue;
    const paid = r.refundPaidAmount || 0;
    if (paid <= 0) continue;
    const when = (r.refundPaidDate || r.returnDate || '').slice(0, 10);
    if (when && (when < fromDay || when > toDay)) continue;
    const inv = finalById.get(r.invoiceId)!;
    const g = inv.grossAmount || 0;
    gross -= paid;
    if (g > 0) {
      const ratio = paid / g;
      net -= (inv.netAmount || 0) * ratio;
      vat -= vat10Of(inv) * ratio;
      profit -= (inv.marginSnapshot || 0) * ratio;
      cost -= (inv.purchasePriceSnapshot || 0) * ratio;
    }
  }

  return { count: finalInvs.length, gross, net, vat, profit, cost };
}

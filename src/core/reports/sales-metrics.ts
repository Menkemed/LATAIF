// SSOT fuer Verkaufs-Kennzahlen ALLER Reports (Dashboard, Sales-Report,
// Executive Summary, Analytics, KPI-Cards) UND — seit M-01 — fuer den
// per-Kunde-Umsatz (LTV: CustomerDetail/CustomerList/Top Clients/Analytics,
// via computeSalesMetricsByCustomer). Eine einzige Realisierungsregel,
// damit die Zahlen nie wieder auseinanderlaufen.
//
// REGEL:
//  - nur FINAL-Rechnungen (voll bezahlt) in der Periode (auf issuedAt ?? createdAt);
//    period weglassen = echtes All-Time (kein Datumsfilter — auch fuer Refunds)
//  - wirksame Sales Returns (Credit Note existiert → status APPROVED/REFUNDED/CLOSED)
//    reduzieren ANTEILIG (totalAmount / gross) ALLE Kennzahlen (einheitlich, auch Cost)
//    der URSPRUNGS-RECHNUNG — UNABHAENGIG von Return-/Approval-/Refund-Datum. B3-Fix:
//    vorher faelschlich an refund_paid_amount gekoppelt → Report zeigte Umsatz/Gewinn zu
//    hoch, solange der Refund noch payable/unpaid war. B3-B: INVOICE-PERIOD-SEMANTIK — ein
//    wirksamer Return RESTATED die Periode SEINER Rechnung (kein separater Event-Period-
//    Abzug ueber Return-/Refund-Datum). REQUESTED (noch keine CN) und REJECTED (storniert
//    via cancelReturn) zaehlen NICHT.
//  - kundensichtbare VAT NUR aus VAT_10-Lines (Margin-VAT ist intern; siehe M-11)
//  - Scrap/Altgold ist NICHT enthalten (separat ausweisen) — die Funktion nimmt
//    bewusst keine Scrap-Daten entgegen
//
// M-01: customers.total_revenue/total_profit/purchase_count sind als Quelle
// ABGESCHAFFT (nie sync-getrackt, Full-Row-LWW → Multi-Device-Drift, loechrige
// Inkremente). Kunden-Umsatz wird IMMER hieraus abgeleitet — Datenbeschaffung
// dafuer: loadSalesData() in sales-metrics-loader.ts.
// ABGRENZUNG: Das zentrale Ledger realisiert Revenue BEI ISSUE (Accrual,
// bewusster Entscheid — siehe postInvoiceIssued in core/ledger/posting.ts) und
// enthaelt auch Nicht-Invoice-Quellen (Repair/Metal/Agent/Scrap). Ledger- und
// Report-Revenue duerfen deshalb abweichen; vergleichbar ist nur der
// source_module-INVOICE/CN-Anteil (ReconciliationPage).
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
  status: string;                // SalesReturnStatus — nur wirksame (CN existiert) zaehlen
  totalAmount: number;           // wirtschaftlich wirksamer Return-Betrag (= geschuldeter Refund / CN-Summe)
  refundPaidAmount: number;      // Cash-Abwicklung — NICHT mehr fuer die Umsatz-/Gewinnminderung genutzt
  refundPaidDate?: string;       // (nur noch informativ)
  returnDate?: string;           // (informativ — Periode folgt der Rechnung, nicht dem Return-Datum; B3-B)
}

export interface SalesPeriod {
  from: string;   // ISO (inklusive)
  to: string;     // ISO (inklusive)
}

export interface SalesMetrics {
  count: number;    // Anzahl FINAL-Rechnungen in der Periode
  gross: number;    // Brutto-Umsatz (inkl. VAT) abzgl. wirksamer Returns (totalAmount)
  net: number;      // Netto-Umsatz abzgl. anteiligem Return-Netto
  vat: number;      // kundensichtbare VAT (nur VAT_10-Lines) abzgl. anteiligem Return-VAT
  profit: number;   // Marge (marginSnapshot) abzgl. anteiligem Return-Profit
  cost: number;     // Wareneinsatz (purchasePriceSnapshot) abzgl. anteiligem Return-Cost
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

// B3 — ein Sales Return ist wirtschaftlich wirksam (Umsatz/Gewinn-mindernd), sobald seine
// Credit Note existiert: approveReturn erstellt die CN und setzt den Status auf APPROVED
// (danach REFUNDED/CLOSED im Lifecycle). REQUESTED = angelegt, aber noch KEINE CN
// (nur Disposition/COGS); REJECTED = via cancelReturn storniert (CN reversiert). Beide
// duerfen den Report-Umsatz nicht mindern — sonst weicht der Report vom Ledger ab.
const EFFECTIVE_RETURN_STATUSES = new Set(['APPROVED', 'REFUNDED', 'CLOSED']);

// period weglassen = All-Time: KEIN Datumsfilter auf Invoices UND Refunds.
// Bewusst optionaler Parameter statt Sentinel-Datum ('9999-…'), damit
// zukunftsdatierte Belege nicht anders behandelt werden als im Sales-Report.
export function computeSalesMetrics(
  invoices: SalesMetricsInvoice[],
  salesReturns: SalesMetricsReturn[],
  period?: SalesPeriod,
): SalesMetrics {
  const finalInvs = invoices.filter(i => i.status === 'FINAL' && (!period || invoiceInPeriod(i, period)));
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

  // B3 / B3-B — wirksame Returns (Credit Note existiert) mindern ALLE Kennzahlen anteilig,
  // basierend auf dem GESCHULDETEN Return-Betrag (totalAmount = CN-Summe), NICHT auf der
  // Refund-Auszahlung. Nur FINAL-Invoices, nur APPROVED/REFUNDED/CLOSED. Proportional ueber
  // gross verteilt (kanonische Return-Berechnung wie bisher).
  //
  // INVOICE-PERIOD-SEMANTIK (B3-B, bewusster Entscheid): ein wirksamer Return RESTATED die
  // Periode SEINER Rechnung — der finalIds-Guard koppelt ihn bereits an die (schon
  // periodengefilterte) Rechnung, daher KEIN zusaetzlicher Datumsfilter ueber Return-/Refund-
  // Datum. Das Refund-Zahlungsdatum beeinflusst die Umsatzrealisierung nicht; und ein Return-
  // Datum in einer anderen Periode als die Rechnung wuerde den Return sonst aus JEDEM Monats-
  // Report fallen lassen (die Rechnung liegt dann in keiner finalIds-Menge). Eine echte Event-/
  // Accounting-Period-Auswertung nach credit_notes.issued_at braeuchte eine separate Architektur
  // (die SSOT filtert Rechnungen bereits nach issuedAt) — offenes Design-Finding, siehe B3-B-Report.
  for (const r of salesReturns) {
    if (!finalIds.has(r.invoiceId)) continue;
    if (!EFFECTIVE_RETURN_STATUSES.has(r.status)) continue;
    const amt = r.totalAmount || 0;
    if (amt <= 0) continue;
    const inv = finalById.get(r.invoiceId)!;
    const g = inv.grossAmount || 0;
    gross -= amt;
    if (g > 0) {
      const ratio = amt / g;
      net -= (inv.netAmount || 0) * ratio;
      vat -= vat10Of(inv) * ratio;
      profit -= (inv.marginSnapshot || 0) * ratio;
      cost -= (inv.purchasePriceSnapshot || 0) * ratio;
    }
  }

  return { count: finalInvs.length, gross, net, vat, profit, cost };
}

// M-01 — per-Kunde-Partition derselben Regel: gruppiert die Invoices nach
// customerId und rechnet pro Kunde EXAKT computeSalesMetrics. Returns folgen
// ihrer Invoice (invoiceId → customerId) — ein Refund zaehlt nur beim Kunden,
// dessen FINAL-Rechnung er referenziert (Orphan-Returns fallen wie im
// Gesamt-Report durch den finalIds-Guard raus). Invoices ohne customerId
// (Walk-in) tragen kein LTV und fehlen in der Map.
// Mathematisch partitioniert das den Gesamt-Report: Summe aller Map-Werte
// = computeSalesMetrics(alle Invoices mit Kunde).
export function computeSalesMetricsByCustomer(
  invoices: Array<SalesMetricsInvoice & { customerId?: string | null }>,
  salesReturns: SalesMetricsReturn[],
  period?: SalesPeriod,
): Map<string, SalesMetrics> {
  const invsByCustomer = new Map<string, SalesMetricsInvoice[]>();
  const customerByInvoice = new Map<string, string>();
  for (const inv of invoices) {
    const cid = inv.customerId;
    if (!cid) continue;
    const arr = invsByCustomer.get(cid) || [];
    arr.push(inv);
    invsByCustomer.set(cid, arr);
    customerByInvoice.set(inv.id, cid);
  }
  const retsByCustomer = new Map<string, SalesMetricsReturn[]>();
  for (const r of salesReturns) {
    const cid = customerByInvoice.get(r.invoiceId);
    if (!cid) continue;
    const arr = retsByCustomer.get(cid) || [];
    arr.push(r);
    retsByCustomer.set(cid, arr);
  }
  const out = new Map<string, SalesMetrics>();
  for (const [cid, invs] of invsByCustomer) {
    out.set(cid, computeSalesMetrics(invs, retsByCustomer.get(cid) || [], period));
  }
  return out;
}

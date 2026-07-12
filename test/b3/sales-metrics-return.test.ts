// B3 / B3-B — Sales Metrics Return Recognition regression tests.
// Prüft die reine SSOT computeSalesMetrics(ByCustomer): eine wirtschaftlich wirksame Return/
// Credit Note (status APPROVED/REFUNDED/CLOSED) reduziert Umsatz+Gewinn über den GESCHULDETEN
// Betrag (totalAmount) — UNABHÄNGIG von der Refund-Auszahlung. Periodenzuordnung: INVOICE-PERIOD-
// SEMANTIK (B3-B) — der Return restated die Periode SEINER Rechnung, nicht das Return-/Refund-Datum.
// Die spätere Refund-Zahlung darf NICHT ein zweites Mal abziehen. Run: node test/b3/sales-metrics-return.test.ts
import {
  computeSalesMetrics,
  computeSalesMetricsByCustomer,
  type SalesMetricsInvoice,
  type SalesMetricsReturn,
} from '../../src/core/reports/sales-metrics.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void { if (cond) pass++; else fail.push(msg); }
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// Invoice: gross 100, net 90, margin 40, cost 50, vat10 10 (eine VAT_10-Line).
function inv(o: Partial<SalesMetricsInvoice> & { id?: string; customerId?: string } = {}): SalesMetricsInvoice & { customerId?: string } {
  return {
    id: o.id ?? 'INV1',
    customerId: o.customerId,
    status: o.status ?? 'FINAL',
    grossAmount: o.grossAmount ?? 100,
    netAmount: o.netAmount ?? 90,
    marginSnapshot: o.marginSnapshot ?? 40,
    purchasePriceSnapshot: o.purchasePriceSnapshot ?? 50,
    issuedAt: o.issuedAt,
    createdAt: o.createdAt,
    lines: o.lines ?? [{ taxScheme: 'VAT_10', vatAmount: 10 }],
  };
}
function ret(o: Partial<SalesMetricsReturn> = {}): SalesMetricsReturn {
  return {
    invoiceId: o.invoiceId ?? 'INV1',
    status: o.status ?? 'APPROVED',
    totalAmount: o.totalAmount ?? 0,
    refundPaidAmount: o.refundPaidAmount ?? 0,
    refundPaidDate: o.refundPaidDate,
    returnDate: o.returnDate,
  };
}

// ── 1: Grundfall — kein Return ──
function test1(): void {
  const m = computeSalesMetrics([inv()], []);
  check(close(m.gross, 100) && close(m.profit, 40) && close(m.vat, 10), '1: sale 100, kein Return → gross 100, profit 40, vat 10');
  check(m.count === 1, '1: count 1');
}

// ── 2: gültige Return 20, Refund UNBEZAHLT → gross 80, profit einmalig reduziert ──
function test2(): void {
  const m = computeSalesMetrics([inv()], [ret({ totalAmount: 20, refundPaidAmount: 0 })]);
  check(close(m.gross, 80), '2: Return 20 unpaid → gross 80 (nicht 100)');
  check(close(m.profit, 32), '2: profit 40 - 40*0.2 = 32 (einmalig)');
  check(close(m.vat, 8), '2: vat 10 - 10*0.2 = 8');
  check(close(m.net, 72), '2: net 90 - 90*0.2 = 72');
  check(close(m.cost, 40), '2: cost 50 - 50*0.2 = 40');
}

// ── 3 & 8: Refund SPÄTER bezahlt → Revenue bleibt 80, KEIN zweiter Abzug (Doppelzählung) ──
function test3(): void {
  const paid = computeSalesMetrics([inv()], [ret({ totalAmount: 20, refundPaidAmount: 20, refundPaidDate: '2026-08-01' })]);
  check(close(paid.gross, 80), '3: Refund voll bezahlt → gross bleibt 80 (nicht 60)');
  check(close(paid.profit, 32), '3: profit bleibt 32 (kein zweiter Abzug)');
  // Identisch zum unbezahlten Fall — Auszahlung ändert die Metrics nicht.
  const unpaid = computeSalesMetrics([inv()], [ret({ totalAmount: 20, refundPaidAmount: 0 })]);
  check(close(paid.gross, unpaid.gross) && close(paid.profit, unpaid.profit), '8: bezahlt == unbezahlt (Refund-Zahlung irrelevant)');
}

// ── 4: Teilrückgabe 30 → gross 70 ──
function test4(): void {
  const m = computeSalesMetrics([inv()], [ret({ totalAmount: 30 })]);
  check(close(m.gross, 70), '4: Return 30 → gross 70');
  check(close(m.profit, 28), '4: profit 40 - 40*0.3 = 28');
}

// ── 5: mehrere gültige Returns 20 + 10 → gross 70 ──
function test5(): void {
  const m = computeSalesMetrics([inv()], [
    ret({ totalAmount: 20, status: 'APPROVED' }),
    ret({ totalAmount: 10, status: 'REFUNDED' }),
  ]);
  check(close(m.gross, 70), '5: Returns 20+10 → gross 70');
  check(close(m.profit, 28), '5: profit 40 - 40*0.3 = 28');
}

// ── 6: reverted/deleted Return (REJECTED) → wieder gross 100 ──
function test6(): void {
  const m = computeSalesMetrics([inv()], [ret({ totalAmount: 20, status: 'REJECTED', refundPaidAmount: 20 })]);
  check(close(m.gross, 100) && close(m.profit, 40), '6: REJECTED (storniert) → kein Abzug, gross 100');
}

// ── 7: unwirksamer Status REQUESTED (noch keine CN) → kein Abzug ──
function test7(): void {
  const m = computeSalesMetrics([inv()], [ret({ totalAmount: 20, status: 'REQUESTED' })]);
  check(close(m.gross, 100) && close(m.profit, 40), '7: REQUESTED (keine CN) → kein Abzug, gross 100');
}

// ── 9: Invoice-Period-Semantik (B3-B, Option A) — ein wirksamer Return RESTATED die Periode
//        SEINER Rechnung; Return-/Approval-/Refund-Datum sind für die Zuordnung irrelevant. ──
function test9(): void {
  const june = { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z' };
  const july = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T23:59:59.999Z' };
  const august = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T23:59:59.999Z' };
  const i = inv({ issuedAt: '2026-06-15' });   // Rechnung im JUNI

  // (a) Rechnung Juni, Return im Juli approved → restated in der JUNI-Rechnung; Juli/All-Time konsistent.
  const rJuly = [ret({ totalAmount: 20, status: 'APPROVED', returnDate: '2026-07-05' })];
  check(close(computeSalesMetrics([i], rJuly, june).gross, 80), '9a: Rechnung Juni + Return Juli → Juni-Report 80');
  check(close(computeSalesMetrics([i], rJuly, june).profit, 32), '9a: Juni-Report profit 32 (anteilig)');
  check(close(computeSalesMetrics([i], rJuly, july).gross, 0), '9a: Juli-Report 0 (Rechnung nicht in Juli)');
  check(close(computeSalesMetrics([i], rJuly).gross, 80), '9a: All-Time 80');

  // (b) derselbe Return erst im August bezahlt → Zuordnung UNVERÄNDERT (Zahlungsdatum irrelevant).
  const rPaidAug = [ret({ totalAmount: 20, status: 'REFUNDED', returnDate: '2026-07-05', refundPaidAmount: 20, refundPaidDate: '2026-08-10' })];
  check(close(computeSalesMetrics([i], rPaidAug, june).gross, 80), '9b: Refund August → Juni bleibt 80');
  check(close(computeSalesMetrics([i], rPaidAug, july).gross, 0), '9b: Juli bleibt 0');
  check(close(computeSalesMetrics([i], rPaidAug, august).gross, 0), '9b: August bleibt 0 (kein Event-Period-Abzug)');
  check(close(computeSalesMetrics([i], rPaidAug).gross, 80), '9b: All-Time bleibt 80');

  // (c) Request ohne Approval (REQUESTED, noch keine CN) → kein Restatement.
  const rReq = [ret({ totalAmount: 20, status: 'REQUESTED', returnDate: '2026-07-05' })];
  check(close(computeSalesMetrics([i], rReq, june).gross, 100), '9c: REQUESTED → Juni 100 (kein Restatement)');
  check(close(computeSalesMetrics([i], rReq, july).gross, 0), '9c: Juli 0');

  // (d) Approval danach (APPROVED) → Juni wird auf 80 restated, Juli bleibt 0.
  const rApp = [ret({ totalAmount: 20, status: 'APPROVED', returnDate: '2026-07-05' })];
  check(close(computeSalesMetrics([i], rApp, june).gross, 80), '9d: nach Approval → Juni restated 80');
  check(close(computeSalesMetrics([i], rApp, july).gross, 0), '9d: Juli bleibt 0');

  // (e) Cancel/Revert (REJECTED) → Restatement zurückgenommen: Juni wieder 100.
  const rRej = [ret({ totalAmount: 20, status: 'REJECTED', returnDate: '2026-07-05', refundPaidAmount: 20 })];
  check(close(computeSalesMetrics([i], rRej, june).gross, 100), '9e: REJECTED → Juni wieder 100');
  check(close(computeSalesMetrics([i], rRej, july).gross, 0), '9e: Juli 0');

  // (f) Mehrere Cross-Period-Returns (Juli 20 + August 10) → beide restaten die JUNI-Rechnung.
  const rMul = [
    ret({ totalAmount: 20, status: 'APPROVED', returnDate: '2026-07-05' }),
    ret({ totalAmount: 10, status: 'APPROVED', returnDate: '2026-08-05' }),
  ];
  check(close(computeSalesMetrics([i], rMul, june).gross, 70), '9f: zwei Cross-Period-Returns → Juni 70');
  check(close(computeSalesMetrics([i], rMul, july).gross, 0), '9f: Juli 0');
  check(close(computeSalesMetrics([i], rMul, august).gross, 0), '9f: August 0');
  check(close(computeSalesMetrics([i], rMul).gross, 70), '9f: All-Time 70');

  // (g) Same-Period-Kontrolle: Return-Datum Juni (= Rechnungsperiode) liefert IDENTISCH 80.
  const rJune = [ret({ totalAmount: 20, status: 'APPROVED', returnDate: '2026-06-20' })];
  check(close(computeSalesMetrics([i], rJune, june).gross, 80), '9g: Return-Datum Juni (Same-Period) → Juni 80 (wie Cross-Period)');
}

// ── 10: orphan Return (Invoice nicht FINAL/nicht vorhanden) → ignoriert ──
function test10(): void {
  const m = computeSalesMetrics([inv({ id: 'INV1' })], [ret({ invoiceId: 'GHOST', totalAmount: 20 })]);
  check(close(m.gross, 100), '10: Return auf fremde/fehlende Invoice → ignoriert');
}

// ── 11: per-Kunde-Partition summiert zum Gesamt-Report ──
function test11(): void {
  const invoices = [inv({ id: 'A', customerId: 'c1' }), inv({ id: 'B', customerId: 'c2' })];
  const returns = [ret({ invoiceId: 'A', totalAmount: 20 }), ret({ invoiceId: 'B', totalAmount: 10 })];
  const byCust = computeSalesMetricsByCustomer(invoices, returns);
  const total = computeSalesMetrics(invoices, returns);
  const sumGross = (byCust.get('c1')?.gross || 0) + (byCust.get('c2')?.gross || 0);
  check(close(byCust.get('c1')!.gross, 80), '11: c1 gross 80');
  check(close(byCust.get('c2')!.gross, 90), '11: c2 gross 90');
  check(close(sumGross, total.gross), '11: Σ per-Kunde == Gesamt-gross');
}

function main(): void {
  test1(); test2(); test3(); test4(); test5(); test6(); test7(); test9(); test10(); test11();
  const total = pass + fail.length;
  console.log(`\nB3 sales-metrics-return: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all B3 sales-metrics-return checks green');
}
main();

// D1 — Replay historischer Rechnungszahlungen: Ueberzahlung darf NIE gegen AR laufen.
// Run: node test/d1/invoice-payment-backfill.test.ts
//
// Der Bug: `backfillInvoicePayments` rief `postInvoicePayment` ohne `openRemainder`. Damit legt
// `computePaymentSplit` den GESAMTEN Betrag auf ACCOUNTS_RECEIVABLE — bei Rechnung 100 BD und
// historischer Zahlung 120 BD also AR = -20 BD, eine Phantom-Forderung mit falschem Vorzeichen,
// statt 20 BD redeembarem Kundenguthaben.
//
// Getestet wird der Kern, den der Backfill wirklich ausfuehrt (`planInvoicePaymentBackfill`),
// nicht eine nachgebaute Kopie davon.

import {
  planInvoicePaymentBackfill,
  type BackfillPaymentRow,
} from '../../src/core/ledger/backfill-payment-plan.ts';
import { computePaymentSplit, ROUND } from '../../src/core/ledger/payment-split.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const none = () => false;

function row(id: string, invoiceId: string, amount: number, grossAmount: number, method = 'cash'): BackfillPaymentRow {
  return { id, invoiceId, amount, method, grossAmount };
}

// ── 1. Punktgenaue Zahlung ────────────────────────────────────────────────
{
  const [d] = planInvoicePaymentBackfill([row('p1', 'i1', 100, 100)], none);
  check(close(d.openRemainder, 100), 'exact: openRemainder = voller Bruttobetrag');
  check(close(d.arCredit, 100), 'exact: der volle Betrag geht gegen AR');
  check(close(d.overpayExcess, 0), 'exact: kein Ueberschuss');
  check(d.needsCreditRow === false, 'exact: keine customer_credits-Row');
}

// ── 2. Teilzahlung ────────────────────────────────────────────────────────
{
  const [d] = planInvoicePaymentBackfill([row('p1', 'i1', 40, 100)], none);
  check(close(d.arCredit, 40), 'partial: Teilbetrag vollstaendig gegen AR');
  check(close(d.overpayExcess, 0), 'partial: kein Ueberschuss');
}

// ── 3. Historische Ueberzahlung — der eigentliche D1-Fall ────────────────
{
  const [d] = planInvoicePaymentBackfill([row('p1', 'i1', 120, 100)], none);
  check(close(d.openRemainder, 100), 'overpay: offener Rest ist der Bruttobetrag');
  check(close(d.arCredit, 100), 'overpay: AR bekommt HOECHSTENS den offenen Rest');
  check(close(d.overpayExcess, 20), 'overpay: 20 BD werden Kundenguthaben');
  check(d.needsCreditRow === true, 'overpay: eine customer_credits-Row wird gebraucht');
  // Das alte Verhalten war exakt dies — es darf nicht zurueckkommen.
  const alt = computePaymentSplit(120, undefined, 'cash');
  check(close(alt.arCredit, 120), 'Kontrolle: ohne openRemainder legt der Helper alles auf AR');
  check(!close(d.arCredit, alt.arCredit), 'Regression: der Plan bucht NICHT mehr wie der Alt-Pfad');
}

// ── 4. Mehrere historische Zahlungen auf dieselbe Rechnung ───────────────
{
  const ds = planInvoicePaymentBackfill(
    [row('p1', 'i1', 60, 100), row('p2', 'i1', 60, 100)],
    none
  );
  check(close(ds[0].openRemainder, 100), 'multi: erste Zahlung sieht den vollen Rest');
  check(close(ds[0].arCredit, 60), 'multi: erste Zahlung ganz gegen AR');
  check(close(ds[1].openRemainder, 40), 'multi: zweite Zahlung sieht nur noch 40 offen');
  check(close(ds[1].arCredit, 40), 'multi: zweite Zahlung deckt den Rest');
  check(close(ds[1].overpayExcess, 20), 'multi: der Rest der zweiten Zahlung wird Guthaben');
  const arTotal = ds.reduce((s, d) => s + d.arCredit, 0);
  check(close(arTotal, 100), 'multi: gegen AR laufen insgesamt genau 100 — AR wird nie negativ');
}

// ── 5. Bereits gebuchte Zahlungen bleiben unangetastet … ────────────────
{
  const ds = planInvoicePaymentBackfill(
    [row('p1', 'i1', 100, 100), row('p2', 'i1', 20, 100)],
    (id) => id === 'p1'
  );
  check(ds[0].skipped === true, 'idempotent: die bereits gebuchte Zahlung wird uebersprungen');
  check(ds[0].needsCreditRow === false, 'idempotent: fuer sie entsteht keine Guthaben-Row');
  // … zaehlen aber weiter in den verbrauchten Rest.
  check(close(ds[1].openRemainder, 0), 'idempotent: die gebuchte Zahlung hat den Rest verbraucht');
  check(close(ds[1].arCredit, 0), 'idempotent: nichts mehr gegen AR');
  check(close(ds[1].overpayExcess, 20), 'idempotent: die zweite Zahlung ist ganz Guthaben');
}

// ── 6. Zwei Rechnungen laufen nicht ineinander ──────────────────────────
{
  const ds = planInvoicePaymentBackfill(
    [row('p1', 'i1', 100, 100), row('p2', 'i2', 50, 80)],
    none
  );
  check(close(ds[1].openRemainder, 80), 'zwei Rechnungen: der Rest wird je Rechnung gefuehrt');
  check(close(ds[1].arCredit, 50), 'zwei Rechnungen: zweite Rechnung unbeeinflusst');
}

// ── 7. Guthaben-Einloesung splittet nie ─────────────────────────────────
{
  const [d] = planInvoicePaymentBackfill([row('p1', 'i1', 120, 100, 'credit')], none);
  check(close(d.arCredit, 120), "method 'credit': kein Split (waere self-referential)");
  check(close(d.overpayExcess, 0), "method 'credit': kein zusaetzliches Guthaben");
}

// ── 8. Rounding: die beiden Beine ergeben immer exakt den Betrag ────────
{
  for (const [amount, gross] of [[33.333, 10], [0.007, 0.003], [99.999, 50], [120, 100]]) {
    const [d] = planInvoicePaymentBackfill([row('p1', 'i1', amount, gross)], none);
    check(
      close(ROUND(d.arCredit + d.overpayExcess), ROUND(amount)),
      `rounding: ${amount} teilt sich ohne Fil-Verlust (gross ${gross})`
    );
    check(d.arCredit >= 0 && d.overpayExcess >= 0, `rounding: kein negatives Bein bei ${amount}`);
  }
}

// ── 9. Rechnung ohne Bruttobetrag treibt AR nicht negativ ───────────────
{
  const [d] = planInvoicePaymentBackfill([row('p1', 'i1', 25, 0)], none);
  check(close(d.arCredit, 0), 'gross 0: nichts gegen AR');
  check(close(d.overpayExcess, 25), 'gross 0: alles Guthaben');
}

console.log(`\nD1 invoice-payment-backfill: ${pass}/${pass + fail.length} checks passed`);
if (fail.length) {
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all D1 invoice-payment-backfill checks green');

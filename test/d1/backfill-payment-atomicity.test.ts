// D1 — Ledger-Bein und Überzahlungs-Guthaben committen zusammen oder gar nicht.
// Run: node test/d1/backfill-payment-atomicity.test.ts
//
// Echtes Transaktionsverhalten gegen eine echte in-memory sql.js-DB mit echten
// BEGIN/COMMIT/ROLLBACK — kein Quelltext-Scan. Der erzwungene Fehler sitzt dort, wo es weh tut:
// nachdem `postPayment` die Ledger-Beine geschrieben hat, aber bevor die `customer_credits`-Row
// steht. Ohne Klammer bliebe ein CR-CUSTOMER_CREDIT-Bein ohne Domain-Row zurück.
//
// Fasst NIE echte App-Daten an: alle Tabellen werden hier angelegt.

import initSqlJs from 'sql.js';
import { planInvoicePaymentBackfill } from '../../src/core/ledger/backfill-payment-plan.ts';
import {
  applyPaymentDecision,
  type PaymentApplyDeps,
} from '../../src/core/ledger/backfill-payment-apply.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++; else fail.push(msg);
}
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

const SQL = await initSqlJs({});
const db = new SQL.Database();
db.run(`
  CREATE TABLE ledger_entries (
    id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT,
    account TEXT, direction TEXT, amount REAL
  );
  CREATE TABLE customer_credits (
    id TEXT PRIMARY KEY, customer_id TEXT, source_type TEXT, source_id TEXT,
    amount REAL, status TEXT
  );
`);

function scalar(sql: string, params: unknown[] = []): number {
  const st = db.prepare(sql);
  st.bind(params as never);
  st.step();
  const v = Number(st.get()[0] ?? 0);
  st.free();
  return v;
}
const ledgerRows = (pid: string) => scalar(`SELECT COUNT(*) FROM ledger_entries WHERE source_id = ?`, [pid]);
const creditRows = (pid: string) => scalar(`SELECT COUNT(*) FROM customer_credits WHERE source_type = 'overpayment' AND source_id = ?`, [pid]);
const creditSum = (pid: string) => scalar(`SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE source_id = ?`, [pid]);
const arCredited = (pid: string) => scalar(
  `SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
   WHERE source_id = ? AND account = 'ACCOUNTS_RECEIVABLE' AND direction = 'CREDIT'`, [pid]);

let seq = 0;
const nextId = () => `row-${++seq}`;

/** `failIn` erzwingt den Abbruch an genau einer Stelle des Vorgangs. */
function deps(failIn: 'none' | 'afterLedger' | 'creditInsert'): PaymentApplyDeps {
  return {
    postPayment: (d) => {
      // Die drei Beine, die `postInvoicePayment` fuer eine Ueberzahlung schreibt.
      db.run(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)`,
        [nextId(), 'PAYMENT', d.id, 'CASH', 'DEBIT', d.arCredit + d.overpayExcess]);
      db.run(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)`,
        [nextId(), 'PAYMENT', d.id, 'ACCOUNTS_RECEIVABLE', 'CREDIT', d.arCredit]);
      if (d.overpayExcess > 0) {
        db.run(`INSERT INTO ledger_entries VALUES (?,?,?,?,?,?)`,
          [nextId(), 'PAYMENT', d.id, 'CUSTOMER_CREDIT', 'CREDIT', d.overpayExcess]);
      }
      if (failIn === 'afterLedger') throw new Error('injected: nach dem Ledger-Posting');
    },
    creditRowExists: (paymentId) => creditRows(paymentId) > 0,
    insertCreditRow: (d) => {
      if (failIn === 'creditInsert') throw new Error('injected: beim Guthaben-INSERT');
      db.run(`INSERT INTO customer_credits VALUES (?,?,?,?,?,?)`,
        [nextId(), 'cust-1', 'overpayment', d.id, d.overpayExcess, 'OPEN']);
    },
    inTransaction: () => inTx,
    begin: () => { db.run('BEGIN'); inTx = true; },
    commit: () => { db.run('COMMIT'); inTx = false; },
    rollback: () => { db.run('ROLLBACK'); inTx = false; },
  };
}
let inTx = false;

// Rechnung 100, historische Zahlung 120 → 100 gegen AR, 20 Guthaben.
const PID = 'pay-1';
const rows = [{ id: PID, invoiceId: 'inv-1', amount: 120, method: 'cash', grossAmount: 100 }];
const posted = () => ledgerRows(PID) > 0;
const decision = () => planInvoicePaymentBackfill(rows, (id) => id === PID && posted())[0];

{
  const d = decision();
  check(close(d.arCredit, 100) && close(d.overpayExcess, 20), 'Plan: 100 gegen AR, 20 Guthaben');
  check(d.needsCreditRow === true, 'Plan: eine Guthaben-Row wird gebraucht');
}

// ── 1. Fehler beim Guthaben-INSERT — nachdem die Ledger-Beine schon geschrieben waren ──
{
  let threw: unknown = null;
  try { applyPaymentDecision(decision(), deps('creditInsert')); } catch (e) { threw = e; }
  check(threw !== null, 'Abbruch: der Fehler wird durchgereicht (safeStep zaehlt ihn)');
  check(ledgerRows(PID) === 0, 'Abbruch: KEINE Ledger-Buchung bleibt stehen');
  check(creditRows(PID) === 0, 'Abbruch: KEIN Guthaben bleibt stehen');
  check(inTx === false, 'Abbruch: keine offene Transaktion zurueckgelassen');
}

// ── 2. Fehler direkt nach dem Ledger-Posting ──
{
  let threw: unknown = null;
  try { applyPaymentDecision(decision(), deps('afterLedger')); } catch (e) { threw = e; }
  check(threw !== null, 'Abbruch nach Ledger-Posting: Fehler wird durchgereicht');
  check(ledgerRows(PID) === 0, 'Abbruch nach Ledger-Posting: Ledger zurueckgerollt');
  check(creditRows(PID) === 0, 'Abbruch nach Ledger-Posting: kein Guthaben');
}

// ── 3. Fehler weg, erneut ausfuehren — jetzt muss es exakt einmal stehen ──
{
  applyPaymentDecision(decision(), deps('none'));
  check(close(arCredited(PID), 100), 'Wiederholung: AR wird um genau 100 reduziert, nicht 120');
  check(creditRows(PID) === 1, 'Wiederholung: genau eine Guthaben-Row');
  check(close(creditSum(PID), 20), 'Wiederholung: 20 BD Guthaben');
  check(ledgerRows(PID) === 3, 'Wiederholung: genau drei Ledger-Beine');
  check(inTx === false, 'Wiederholung: Transaktion sauber geschlossen');
}

// ── 4. Noch ein Backfill-Lauf — nichts darf sich verdoppeln ──
{
  const d = planInvoicePaymentBackfill(rows, (id) => id === PID && posted())[0];
  check(d.skipped === true, 'Zweiter Lauf: die gebuchte Zahlung wird uebersprungen');
  check(d.needsCreditRow === false, 'Zweiter Lauf: keine Guthaben-Row angefordert');
  if (!d.skipped) applyPaymentDecision(d, deps('none'));
  check(ledgerRows(PID) === 3, 'Zweiter Lauf: weiterhin drei Ledger-Beine');
  check(creditRows(PID) === 1, 'Zweiter Lauf: weiterhin genau ein Guthaben');
}

// ── 5. Und selbst wenn der Skip ausfaellt, verhindert der Lookup das zweite Guthaben ──
{
  const forced = { ...decision(), skipped: false, needsCreditRow: true };
  applyPaymentDecision(forced, deps('none'));
  check(creditRows(PID) === 1, 'Erzwungener Zweitlauf: immer noch genau ein Guthaben');
  check(close(creditSum(PID), 20), 'Erzwungener Zweitlauf: Guthaben unveraendert 20 BD');
}

console.log(`\nD1 backfill-payment-atomicity: ${pass}/${pass + fail.length} checks passed`);
if (fail.length) {
  for (const f of fail) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all D1 backfill-payment-atomicity checks green');

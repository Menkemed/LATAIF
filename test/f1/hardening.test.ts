// F1 hardening test — pure lot-availability logic + order-line invoice idempotency SQL.
// Run: node test/f1/hardening.test.ts
// Mirrors the test/b1/migration.test.ts pattern (sql.js direct, no Vite SSR needed).
// The full store paths (invoiceStore/orderStore) need '@/'-alias + browser globals and
// cannot run headless in bare Node (see E1); here we prove the two extracted decision
// cores that back the F1 guards.

import initSqlJs from 'sql.js';
import { isLotConsumable, firstUnavailableLot } from '../../src/core/lots/lot-availability.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}

// ── Finding A: lot-availability decision (backs assertLotsConsumable / consumeLot guard) ──
function testLotAvailability(): void {
  // isLotConsumable mirrors consumeLot's guards exactly (CANCELLED → no, qtyRemaining < qty → no)
  check(isLotConsumable(null, 1) === false, 'A: null lot not consumable');
  check(isLotConsumable(undefined, 1) === false, 'A: undefined lot not consumable');
  check(isLotConsumable({ status: 'CANCELLED', qtyRemaining: 5 }, 1) === false, 'A: CANCELLED lot not consumable');
  check(isLotConsumable({ status: 'ACTIVE', qtyRemaining: 0 }, 1) === false, 'A: empty ACTIVE lot not consumable');
  check(isLotConsumable({ status: 'EXHAUSTED', qtyRemaining: 0 }, 1) === false, 'A: EXHAUSTED lot not consumable');
  check(isLotConsumable({ status: 'ACTIVE', qtyRemaining: 1 }, 1) === true, 'A: ACTIVE qty1 consumable for 1');
  check(isLotConsumable({ status: 'ACTIVE', qtyRemaining: 2 }, 3) === false, 'A: qty2 not consumable for 3');
  check(isLotConsumable({ status: 'ACTIVE', qtyRemaining: 3 }, 3) === true, 'A: qty3 consumable for 3');

  const lots: Record<string, { status: string; qtyRemaining: number }> = {
    'lot-a': { status: 'ACTIVE', qtyRemaining: 1 },
    'lot-b': { status: 'ACTIVE', qtyRemaining: 5 },
  };
  const lookup = (id: string) => lots[id] ?? null;

  check(firstUnavailableLot([{ lotId: 'lot-a', qty: 1 }], lookup) === null, 'A: single line covered');
  check(firstUnavailableLot([{ lotId: null, qty: 9 }], lookup) === null, 'A: no-lot line skipped (service/consignment)');
  check(firstUnavailableLot([{ lotId: 'lot-b', qty: 5 }], lookup) === null, 'A: exact remaining covered');
  // The real bug: two lines drawing the SAME lot must aggregate → 1+1 > remaining 1
  check(
    firstUnavailableLot([{ lotId: 'lot-a', qty: 1 }, { lotId: 'lot-a', qty: 1 }], lookup) === 'lot-a',
    'A: two lines same lot exceed remaining (aggregated)',
  );
  check(
    firstUnavailableLot([{ lotId: 'lot-b', qty: 2 }, { lotId: 'lot-a', qty: 2 }], lookup) === 'lot-a',
    'A: mixed batch flags the over-drawn lot',
  );
  check(firstUnavailableLot([{ lotId: 'lot-missing', qty: 1 }], lookup) === 'lot-missing', 'A: missing lot flagged');
}

// ── Finding B: order_line → invoice idempotency (backs markOrderLinesInvoiced / assert) ──
async function testOrderLineIdempotency(SQL: { Database: new () => { run: (s: string) => void; exec: (s: string) => { values: unknown[][] }[] } }): Promise<void> {
  const db = new SQL.Database();
  db.run('CREATE TABLE order_lines (id TEXT PRIMARY KEY, invoice_id TEXT)');
  db.run("INSERT INTO order_lines (id, invoice_id) VALUES ('ol-1', NULL)");

  // assertOrderLinesBillable core: no invoice yet → not flagged (billable)
  const before = db.exec("SELECT invoice_id FROM order_lines WHERE id IN ('ol-1') AND invoice_id IS NOT NULL");
  check((before[0]?.values?.length ?? 0) === 0, 'B: line billable before convert');

  // first convert links it (idempotent WHERE invoice_id IS NULL)
  db.run("UPDATE order_lines SET invoice_id = 'inv-1' WHERE id = 'ol-1' AND invoice_id IS NULL");
  const after1 = db.exec("SELECT invoice_id FROM order_lines WHERE id = 'ol-1'");
  check(String(after1[0].values[0][0]) === 'inv-1', 'B: first convert links inv-1');

  // second (double-click / race) convert must NOT overwrite the existing link
  db.run("UPDATE order_lines SET invoice_id = 'inv-2' WHERE id = 'ol-1' AND invoice_id IS NULL");
  const after2 = db.exec("SELECT invoice_id FROM order_lines WHERE id = 'ol-1'");
  check(String(after2[0].values[0][0]) === 'inv-1', 'B: second convert does NOT overwrite (idempotent)');

  // assertOrderLinesBillable core now flags the already-invoiced line → throws in the store
  const guard = db.exec("SELECT invoice_id FROM order_lines WHERE id IN ('ol-1') AND invoice_id IS NOT NULL");
  check((guard[0]?.values?.length ?? 0) === 1, 'B: guard flags already-invoiced line');
}

async function main(): Promise<void> {
  testLotAvailability();
  const SQL = (await initSqlJs()) as unknown as { Database: new () => { run: (s: string) => void; exec: (s: string) => { values: unknown[][] }[] } };
  await testOrderLineIdempotency(SQL);

  console.log(`F1 hardening test: ${pass} checks passed, ${fail.length} failed`);
  if (fail.length > 0) {
    for (const f of fail) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

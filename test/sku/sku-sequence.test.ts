// ════════════════════════════════════════════════════════════════════════════
// SKU-ALLOC §A3/§A4/§A5 — the durable allocator against a REAL SQLite database.
// Run: node test/sku/sku-sequence.test.ts
//
// The rule that matters cannot be shown with a list: deleting a product must NOT release its
// number. So every case here runs against an actual database with actual rows, deletes actual
// products, and checks what the next allocation returns.
// ════════════════════════════════════════════════════════════════════════════

import { DatabaseSync } from 'node:sqlite';
import {
  SKU_SEQUENCES_DDL,
  allocateSku,
  historicalHighWater,
  type SkuSequenceDb,
} from '../../src/core/products/sku-sequence.ts';
import { buildSkuSeed } from '../../src/core/products/sku-allocation.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`);

/** The sql.js-shaped surface the allocator expects, over a real node:sqlite handle. */
function adapt(db: DatabaseSync): SkuSequenceDb {
  return {
    run: (sql, params = []) => db.prepare(sql).run(...(params as never[])),
    exec: (sql, params = []) => {
      const r = db.prepare(sql).all(...(params as never[])) as Array<Record<string, unknown>>;
      if (r.length === 0) return [];
      const columns = Object.keys(r[0]);
      return [{ columns, values: r.map((row) => columns.map((c) => row[c])) }];
    },
  };
}

function freshDb(): { db: DatabaseSync; api: SkuSequenceDb } {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, brand TEXT, name TEXT)`);
  db.exec(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT, data TEXT)`);
  db.exec(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, field_name TEXT, old_value TEXT, new_value TEXT)`);
  db.exec(SKU_SEQUENCES_DDL);
  return { db, api: adapt(db) };
}
const addProduct = (db: DatabaseSync, id: string, sku: string | null) =>
  db.prepare('INSERT INTO products (id, sku, brand, name) VALUES (?,?,?,?)').run(id, sku, 'Rolex', 'Datejust 36');
const delProduct = (db: DatabaseSync, id: string) => db.prepare('DELETE FROM products WHERE id=?').run(id);

const SEED = 'RLX-WCH-001';

// ── §A5 — the first number is 001, not 002 ──────────────────────────────────
{
  const { api } = freshDb();
  eq(allocateSku(api, SEED), 'RLX-WCH-001', '§A5 an unused stem starts at 001');
  eq(allocateSku(api, SEED), 'RLX-WCH-002', '§A5 the next is 002');
  eq(allocateSku(api, SEED), 'RLX-WCH-003', '§A5 and then 003');
}

// ── §A4 — a deleted product never gives its number back ─────────────────────
{
  const { db, api } = freshDb();
  const a = allocateSku(api, SEED); addProduct(db, 'p1', a);
  const b = allocateSku(api, SEED); addProduct(db, 'p2', b);
  const c = allocateSku(api, SEED); addProduct(db, 'p3', c);
  eq([a, b, c], ['RLX-WCH-001', 'RLX-WCH-002', 'RLX-WCH-003'], '§A4 three products, three numbers');

  delProduct(db, 'p3');                                   // the -003 product is gone
  const next = allocateSku(api, SEED);
  eq(next, 'RLX-WCH-004', '§A4 the number of the deleted product is NOT handed out again');
  ok(next !== c, '§A4 explicitly: the next SKU differs from the deleted one');

  delProduct(db, 'p1'); delProduct(db, 'p2');             // now nothing is left at all
  eq(allocateSku(api, SEED), 'RLX-WCH-005',
    '§A4 even with the table emptied the counter keeps climbing — it does not live in products');
}

// ── §A4 — history seeds the counter on first use ────────────────────────────
{
  const { db, api } = freshDb();
  // A product that was deleted before this table existed: only the changelog still knows its SKU.
  db.prepare(`INSERT INTO sync_changelog (table_name, record_id, action, data) VALUES ('products','gone','delete',?)`)
    .run(JSON.stringify({ id: 'gone', sku: 'RLX-WCH-007', brand: 'Rolex' }));
  eq(historicalHighWater(api, 'RLX-WCH-'), 7, 'the changelog payload contributes to the high-water mark');
  eq(allocateSku(api, SEED), 'RLX-WCH-008',
    '§A4 a number retired before the counter existed is still not reused');

  const { db: db2, api: api2 } = freshDb();
  db2.prepare(`INSERT INTO audit_log (id, entity_type, entity_id, field_name, old_value, new_value) VALUES ('a1','products','p','sku',?,?)`)
    .run('RLX-WCH-011', 'RLX-WCH-012');
  eq(historicalHighWater(api2, 'RLX-WCH-'), 12, 'both sides of an audited SKU change count');
  eq(allocateSku(api2, SEED), 'RLX-WCH-013', '§A4 the audit log seeds the counter too');

  const { db: db3, api: api3 } = freshDb();
  addProduct(db3, 'alive', 'RLX-WCH-020');
  eq(allocateSku(api3, SEED), 'RLX-WCH-021', 'a living product with a higher number is respected');
}

// ── §A6 — a manually typed SKU is never overwritten and never collided with ─
{
  const { db, api } = freshDb();
  addProduct(db, 'manual', 'RLX-WCH-002');                // operator typed this one by hand
  const first = allocateSku(api, SEED);
  eq(first, 'RLX-WCH-003', 'the counter starts above a manually typed number');
  addProduct(db, 'p1', first);

  // and if a manual SKU is typed AHEAD of the counter later, the allocator steps over it
  const { db: db2, api: api2 } = freshDb();
  eq(allocateSku(api2, SEED), 'RLX-WCH-001', 'counter at 1');
  addProduct(db2, 'manual2', 'RLX-WCH-002');              // typed by hand after the fact
  eq(allocateSku(api2, SEED), 'RLX-WCH-003', 'the allocator skips a number a human already took');
}

// ── §A3 — two allocations in the same tick cannot collide ───────────────────
{
  const { api } = freshDb();
  const claimed = new Set<string>();
  for (let i = 0; i < 50; i++) claimed.add(allocateSku(api, SEED));
  eq(claimed.size, 50, '§A3 fifty back-to-back allocations produced fifty distinct SKUs');
  ok(claimed.has('RLX-WCH-001') && claimed.has('RLX-WCH-050'), '§A3 and they are the contiguous run 001…050');
}

// ── stems do not interfere ──────────────────────────────────────────────────
{
  const { api } = freshDb();
  eq(allocateSku(api, buildSkuSeed('Rolex', 'cat-watch')), 'RLX-WCH-001', 'Rolex watch stem');
  eq(allocateSku(api, buildSkuSeed('Cartier', 'cat-gold-jewelry')), 'CAR-GLD-001', 'a different stem has its own counter');
  eq(allocateSku(api, buildSkuSeed('Rolex', 'cat-watch')), 'RLX-WCH-002', 'the first stem continues where it was');
}

// ── the model-number trap: an explicit suffix protects the stem ─────────────
{
  const { api } = freshDb();
  // The generated seed always carries -001, so digits that belong to the NAME stay in the stem.
  eq(allocateSku(api, 'RLX-DJ41-001'), 'RLX-DJ41-001', 'a seed with an explicit sequence keeps its stem');
  eq(allocateSku(api, 'RLX-DJ41-001'), 'RLX-DJ41-002', 'and counts within it');
  eq(allocateSku(api, 'RLX-DJ41-001'), 'RLX-DJ41-003', 'still inside the same stem');
  for (const s of ['RLX-DJ42', 'RLX-DJ42-001']) {
    ok(allocateSku(api, 'RLX-DJ41-001') !== s, `never produces ${s} — the model number is not a sequence`);
  }
}

// ── width is preserved, and overflow widens rather than wrapping ────────────
{
  const { db, api } = freshDb();
  addProduct(db, 'p', 'RLX-WCH-998');
  eq(allocateSku(api, SEED), 'RLX-WCH-999', 'three-digit width preserved');
  eq(allocateSku(api, SEED), 'RLX-WCH-1000', 'past 999 the number widens instead of wrapping to 000');
}

// ── a seed that cannot be split yields nothing rather than a bad SKU ────────
{
  const { api } = freshDb();
  eq(allocateSku(api, ''), '', 'an empty seed allocates nothing');
  eq(allocateSku(api, '   '), '', 'a blank seed allocates nothing');
}

console.log(`\nsku-sequence: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }

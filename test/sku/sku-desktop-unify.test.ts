// ════════════════════════════════════════════════════════════════════════════
// SKU-UNIFY — desktop and mobile on ONE durable sequence, and the split that makes it usable.
// Run: node test/sku/sku-desktop-unify.test.ts
//
// Two functions, one counter:
//
//   • `peekNextSku` answers "what would I get?" and writes nothing, so a form can show the number
//     and a cancelled dialog costs nothing,
//   • `allocateSku` / `resolveSkuDurable` CLAIM the number, and that is the only thing a create is
//     allowed to persist.
//
// The pair is the whole point, so the central case here is that they agree: peek must return
// exactly what the next allocate returns, in every state the counter can be in. Once they can
// drift, a form shows one number and the product gets another, or — far worse — someone persists
// the peeked value and two products share a SKU.
//
// Everything runs against a real SQLite database with real product rows, because the rule that
// matters (a deleted number is never handed out again) cannot be shown with a list.
// ════════════════════════════════════════════════════════════════════════════

import { DatabaseSync } from 'node:sqlite';
import {
  SKU_SEQUENCES_DDL,
  allocateSku,
  peekNextSku,
  resolveSkuDurable,
  type SkuSequenceDb,
} from '../../src/core/products/sku-sequence.ts';
import { buildSkuSeed, skuBrandCode } from '../../src/core/products/sku-allocation.ts';

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  x ${msg}`); }
}
const eq = (a: unknown, b: unknown, msg: string) =>
  ok(a === b, `${msg} (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`);

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

/** A database shaped like the real one: products plus the two history tables the seed reads. */
function fresh(): { raw: DatabaseSync; db: SkuSequenceDb } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, sku TEXT, brand TEXT, category_id TEXT)`);
  raw.exec(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, data TEXT)`);
  raw.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY, entity_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT)`);
  raw.exec(SKU_SEQUENCES_DDL);
  return { raw, db: adapt(raw) };
}

let seq = 0;
/** Create a product the way any surface does: claim a number, then write the row with it. */
function createProduct(raw: DatabaseSync, db: SkuSequenceDb, brand: string, categoryId: string, typed?: string): string {
  const sku = resolveSkuDurable(db, typed, brand, categoryId);
  raw.prepare(`INSERT INTO products (id, sku, brand, category_id) VALUES (?,?,?,?)`)
    .run(`p${++seq}`, sku, brand, categoryId);
  return sku;
}
const deleteProduct = (raw: DatabaseSync, sku: string): void => {
  // Deleting the way the app does: the row goes, and the changelog keeps what it was.
  const row = raw.prepare(`SELECT sku FROM products WHERE sku = ?`).get(sku) as { sku: string } | undefined;
  if (row) raw.prepare(`INSERT INTO sync_changelog (table_name, data) VALUES ('products', ?)`).run(JSON.stringify({ sku: row.sku }));
  raw.prepare(`DELETE FROM products WHERE sku = ?`).run(sku);
};
const counters = (raw: DatabaseSync) =>
  raw.prepare(`SELECT stem, next_number FROM sku_sequences ORDER BY stem`).all() as Array<{ stem: string; next_number: number }>;

const WATCH = 'cat-watch';
const seedFor = (brand: string, cat: string) => buildSkuSeed(brand, cat);

// ── a peek costs nothing ────────────────────────────────────────────────────
{
  const { raw, db } = fresh();
  const seed = seedFor('Rolex', WATCH);
  const before = counters(raw);
  const first = peekNextSku(db, seed);
  const again = peekNextSku(db, seed);
  eq(first, 'RLX-WCH-001', 'a fresh stem previews its first number');
  eq(again, first, 'looking twice shows the same number — nothing was taken in between');
  eq(counters(raw).length, before.length, 'peeking created no counter row at all');
  eq(counters(raw).length, 0, 'the counter table is still empty after two peeks');

  // …and the number that was previewed is the one the create then claims.
  eq(allocateSku(db, seed), first, 'the create claims exactly the number that was previewed');
  eq(counters(raw).length, 1, 'the claim is what creates the counter');
  raw.close();
}

// ── peek and allocate never disagree ────────────────────────────────────────
{
  const { raw, db } = fresh();
  const seed = seedFor('Rolex', WATCH);
  let agreed = 0;
  for (let i = 0; i < 6; i++) {
    const peeked = peekNextSku(db, seed);
    const claimed = createProduct(raw, db, 'Rolex', WATCH);
    if (peeked === claimed) agreed++;
  }
  eq(agreed, 6, 'through six creates the preview always named the number that was claimed');

  // With a manually-typed number sitting in the way, both must skip it identically.
  createProduct(raw, db, 'Rolex', WATCH, 'RLX-WCH-007');
  const peeked = peekNextSku(db, seed);
  const claimed = createProduct(raw, db, 'Rolex', WATCH);
  eq(peeked, claimed, 'they agree across a manually-typed number too');
  eq(claimed, 'RLX-WCH-008', 'and both walked past the number the operator had taken by hand');
  raw.close();
}

// ── one sequence for both surfaces ──────────────────────────────────────────
// DESKTOP_MOBILE_SHARED_SKU_SEQUENCE — the two surfaces are the SAME call. Alternating between
// them must count 1,2,3,4 through a single row, not two counters that each start at 1.
{
  const { raw, db } = fresh();
  const desktop = () => createProduct(raw, db, 'Rolex', WATCH);
  // What the mobile drain does, verbatim: claim from the brand+category seed.
  const mobile = () => {
    const sku = allocateSku(db, buildSkuSeed('Rolex', WATCH));
    raw.prepare(`INSERT INTO products (id, sku, brand, category_id) VALUES (?,?,?,?)`).run(`m${++seq}`, sku, 'Rolex', WATCH);
    return sku;
  };
  eq(desktop(), 'RLX-WCH-001', 'desktop takes the first number of a fresh stem');
  eq(mobile(), 'RLX-WCH-002', 'the phone continues from it rather than starting over');
  eq(desktop(), 'RLX-WCH-003', 'and the desktop continues from the phone');
  eq(mobile(), 'RLX-WCH-004', 'alternating leaves no gap and no repeat');

  const rows = counters(raw);
  eq(rows.length, 1, 'ONE counter row serves both surfaces');
  eq(rows[0].stem, 'RLX-WCH-', 'keyed by the stem, not by the surface');
  eq(rows[0].next_number, 5, 'and it stands where the four creates left it');
  const skus = (raw.prepare(`SELECT sku FROM products ORDER BY sku`).all() as Array<{ sku: string }>).map(r => r.sku);
  eq(new Set(skus).size, skus.length, 'no two products share a SKU');
  raw.close();
}

// ── a deleted number is gone for good ───────────────────────────────────────
{
  const { raw, db } = fresh();
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-001', 'first');
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-002', 'second');
  const third = createProduct(raw, db, 'Rolex', WATCH);
  eq(third, 'RLX-WCH-003', 'third');
  deleteProduct(raw, third);
  eq(peekNextSku(db, seedFor('Rolex', WATCH)), 'RLX-WCH-004', 'the preview already refuses to offer the retired number');
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-004', 'and the next create goes past it, not back into the gap');
  raw.close();
}

// ── a stale preview is safe ─────────────────────────────────────────────────
// DESKTOP_SKU_STALE_PREVIEW_SAFE — the form looked at 001 and someone else created it first.
{
  const { raw, db } = fresh();
  const seed = seedFor('Rolex', WATCH);
  const shown = peekNextSku(db, seed);                       // desktop opens its dialog
  eq(shown, 'RLX-WCH-001', 'the desktop form is showing the first number');
  const takenByPhone = createProduct(raw, db, 'Rolex', WATCH); // the phone gets there first
  eq(takenByPhone, shown, 'the phone claimed exactly the number the form was showing');
  const saved = createProduct(raw, db, 'Rolex', WATCH);       // now the desktop saves
  eq(saved, 'RLX-WCH-002', 'the desktop save claims the NEXT number instead of the stale one');
  const skus = (raw.prepare(`SELECT sku FROM products`).all() as Array<{ sku: string }>).map(r => r.sku);
  eq(new Set(skus).size, 2, 'so the two products do not collide');
  raw.close();
}

// ── a typed SKU is never replaced, and never claims a number ────────────────
{
  const { raw, db } = fresh();
  const typed = createProduct(raw, db, 'Rolex', WATCH, 'MY-OWN-REF');
  eq(typed, 'MY-OWN-REF', 'what the operator typed is what gets stored');
  eq(counters(raw).length, 0, 'and it claimed nothing — a manual SKU does not move any counter');

  eq(resolveSkuDurable(db, '  RLX-WCH-042  ', 'Rolex', WATCH), 'RLX-WCH-042', 'a typed value is trimmed, not renumbered');
  eq(resolveSkuDurable(db, 'null', 'Rolex', WATCH), 'RLX-WCH-001', 'the string "null" means empty — the shared emptiness rule');
  raw.close();
}

// ── a manual number ahead of the counter ────────────────────────────────────
// The REAL behaviour, verified rather than assumed: the history scan runs once, when a stem is
// first used. After that a hand-typed number is not a high-water mark that drags the counter up —
// it is simply occupied, and the walk steps over it. So the free numbers below it are still handed
// out (they were never used by anything), and the manual number itself is never handed out twice.
{
  const { raw, db } = fresh();
  for (let i = 0; i < 8; i++) createProduct(raw, db, 'Rolex', WATCH);   // 001..008
  eq(counters(raw)[0].next_number, 9, 'the counter stands at 9 after eight creates');

  createProduct(raw, db, 'Rolex', WATCH, 'RLX-WCH-015');                // typed by hand, far ahead
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-009', 'the next auto-create takes 009 — a number nothing has ever held');

  for (let i = 0; i < 5; i++) createProduct(raw, db, 'Rolex', WATCH);   // 010..014
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-016', 'and when the walk reaches the manual number it steps over it');
  const skus = (raw.prepare(`SELECT sku FROM products ORDER BY sku`).all() as Array<{ sku: string }>).map(r => r.sku);
  eq(new Set(skus).size, skus.length, 'nothing was handed out twice');
  raw.close();
}

// ── a stem used before the counter existed starts above its history ─────────
{
  const { raw, db } = fresh();
  raw.prepare(`INSERT INTO products (id, sku, brand, category_id) VALUES ('old','RLX-WCH-004','Rolex',?)`).run(WATCH);
  raw.prepare(`INSERT INTO sync_changelog (table_name, data) VALUES ('products', ?)`).run(JSON.stringify({ sku: 'RLX-WCH-009' }));
  eq(peekNextSku(db, seedFor('Rolex', WATCH)), 'RLX-WCH-010', 'the preview starts above the retired number in the changelog');
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-010', 'and the first claim agrees with it');
  raw.close();
}

// ── different stems are independent ─────────────────────────────────────────
{
  const { raw, db } = fresh();
  eq(createProduct(raw, db, 'Rolex', WATCH), 'RLX-WCH-001', 'Rolex watch');
  eq(createProduct(raw, db, 'Omega', WATCH), 'OME-WCH-001', 'a different brand starts its own count');
  eq(createProduct(raw, db, 'Rolex', 'cat-accessory'), 'RLX-ACC-001', 'and so does a different category');
  eq(counters(raw).length, 3, 'three stems, three counters');
  raw.close();
}


// ── the brand a SKU is known by ────────────────────────────────────────────
// Most names give their own code away in the first three letters, and the stock already reads that
// way. Rolex does not: every number on the shelf says RLX, and a generator answering ROL opens a
// second family for a brand that already has one.
{
  eq(skuBrandCode('Rolex'), 'RLX', 'Rolex is RLX, the code the business actually uses');
  eq(skuBrandCode('ROLEX'), 'RLX', 'however it was typed');
  eq(skuBrandCode(' rolex '), 'RLX', 'and whatever came with it');
  eq(skuBrandCode('Cartier'), 'CAR', 'Cartier keeps the code it already has in the stock');
  eq(skuBrandCode('Bvlgari'), 'BVL', 'so does Bvlgari');
  eq(skuBrandCode('Dior'), 'DIO', 'and Dior');
  eq(skuBrandCode('Zeniqa'), 'ZEN', 'an unknown brand still gets a deterministic code');
  eq(skuBrandCode('Ap'), 'APX', 'a short name is padded rather than left ragged');
  eq(skuBrandCode(''), 'ITM', 'and no brand at all still yields a usable stem');

  eq(buildSkuSeed('Rolex', WATCH), 'RLX-WCH-001', 'the seed carries the canonical code');
  eq(buildSkuSeed('Rolex', 'cat-accessory'), 'RLX-ACC-001', 'with the CATEGORY in the middle');
}

// ── the model must not reach the stem ──────────────────────────────────────
// A stem per reference would give every Datejust variant its own -001 — four parallel families on
// one shelf, which is the shape the legacy numbers already left behind.
{
  const { raw, db } = fresh();
  const dj = createProduct(raw, db, 'Rolex', WATCH);          // "Datejust 36"
  const sub = createProduct(raw, db, 'Rolex', WATCH);         // "Submariner"
  eq(dj, 'RLX-WCH-001', 'the first Rolex watch');
  eq(sub, 'RLX-WCH-002', 'a different model continues the same count, it does not start over');
  eq(counters(raw).filter(c => c.stem === 'RLX-WCH-').length, 1, 'one counter for the brand+category');
  raw.close();
}

// ── the two surfaces compute the same stem ─────────────────────────────────
// DESKTOP_MOBILE_CANONICAL_SKU_SHARED — same function, so the phone cannot answer ROL while the
// desktop answers RLX and the two quietly fill different columns of the same shelf.
{
  const { raw, db } = fresh();
  const desktop = () => createProduct(raw, db, 'Rolex', WATCH);
  const mobile = () => {
    const sku = allocateSku(db, buildSkuSeed('Rolex', WATCH));   // verbatim what the drain does
    raw.prepare(`INSERT INTO products (id, sku, brand, category_id) VALUES (?,?,?,?)`).run(`m${++seq}`, sku, 'Rolex', WATCH);
    return sku;
  };
  eq(desktop(), 'RLX-WCH-001', 'desktop opens the Rolex watch count');
  eq(mobile(), 'RLX-WCH-002', 'the phone continues it under the same code');
  eq(desktop(), 'RLX-WCH-003', 'and back again');
  eq(counters(raw).map(c => c.stem).join(), 'RLX-WCH-', 'through exactly one counter row');
  raw.close();
}

// ── the legacy numbers are left exactly where they are ─────────────────────
// The new convention governs new allocations. It does not rename anything, and an old number in
// the way is stepped over rather than reused.
{
  const { raw, db } = fresh();
  for (const legacy of ['RLX-DJ36-001', 'RLX-SUB-002', 'RLX-GMT-002']) {
    raw.prepare(`INSERT INTO products (id, sku, brand, category_id) VALUES (?,?,?,?)`)
      .run('legacy-' + legacy, legacy, 'Rolex', WATCH);
  }
  const fresh1 = createProduct(raw, db, 'Rolex', WATCH);
  eq(fresh1, 'RLX-WCH-001', 'a new item starts the brand+category count at 001');
  const still = (raw.prepare(`SELECT sku FROM products WHERE id LIKE 'legacy-%' ORDER BY sku`).all() as Array<{ sku: string }>).map(r => r.sku);
  eq(still.join(), 'RLX-DJ36-001,RLX-GMT-002,RLX-SUB-002', 'and not one legacy number was touched');
  raw.close();
}

console.log(`\nsku-desktop-unify: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }

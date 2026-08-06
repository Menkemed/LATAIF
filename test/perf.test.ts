// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — unit tests for the harness (stats) and the deterministic fixture generator.
// Part of the node sweep. Fast: builds one SMALL fixture twice and asserts byte-identical content.
// ════════════════════════════════════════════════════════════════════════════
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stats, rng, measure } from './perf/harness.mjs';
import { buildFixture, SIZES } from './perf/fixtures.mjs';
import { dbScenarios } from './perf/scenarios-db.mjs';

let PASS = 0, FAIL = 0; const fails: string[] = [];
function ok(c: unknown, m: string) { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  ✗ ' + m); } }

// ── stats correctness ────────────────────────────────────────────────────────
{
  const s = stats([5, 1, 3, 2, 4]);
  ok(s.n === 5 && s.min === 1 && s.max === 5 && s.p50 === 3, 'stats: n/min/max/p50 on a known sample');
  ok(stats([]).n === 0 && stats([]).p50 === null, 'stats: empty is safe');
  const one = stats([7]);
  ok(one.p50 === 7 && one.min === 7 && one.max === 7, 'stats: single sample');
  // outliers are kept: max reflects the outlier, not dropped.
  const o = stats([1, 1, 1, 1, 100]);
  ok(o.max === 100 && o.p50 === 1, 'stats: outliers are visible in max, never silently dropped');
}

// ── deterministic PRNG ───────────────────────────────────────────────────────
{
  const a = rng(42), b = rng(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  ok(JSON.stringify(seqA) === JSON.stringify(seqB), 'rng: same seed → identical sequence');
  ok(rng(1)() !== rng(2)(), 'rng: different seeds differ');
}

// ── deterministic fixtures: two independent builds are byte-identical in content ──
{
  const d1 = mkdtempSync(join(tmpdir(), 'perf-fx1-'));
  const d2 = mkdtempSync(join(tmpdir(), 'perf-fx2-'));
  try {
    const f1 = buildFixture(join(d1, 'small'), 'small');
    const f2 = buildFixture(join(d2, 'small'), 'small');
    ok(JSON.stringify(f1.counts) === JSON.stringify(f2.counts), 'fixture: identical row counts across builds');
    ok(f1.counts.products === SIZES.small.products, 'fixture: product count matches the requested size');
    // content fingerprint over stable ordered rows must match exactly.
    const fp = (p: string) => { const db = new DatabaseSync(p, { readOnly: true }); const rows = db.prepare('SELECT id,sku,brand,purchase_price FROM products ORDER BY id LIMIT 25').all(); const inv = db.prepare('SELECT id,gross_amount,paid_amount FROM invoices ORDER BY id LIMIT 25').all(); const keys = db.prepare('SELECT storage_key FROM media_blob_generations ORDER BY storage_key LIMIT 25').all(); db.close(); return JSON.stringify({ rows, inv, keys }); };
    ok(fp(f1.dbPath) === fp(f2.dbPath), 'fixture: identical product/invoice/media content fingerprint (deterministic)');
    // finance integrity within the fixture: paid never exceeds gross.
    const db = new DatabaseSync(f1.dbPath, { readOnly: true });
    const bad = (db.prepare('SELECT COUNT(*) c FROM invoices WHERE paid_amount > gross_amount').get() as { c: number }).c;
    ok(bad === 0, 'fixture: no invoice is over-paid (paid <= gross)');
    db.close();
  } finally { rmSync(d1, { recursive: true, force: true }); rmSync(d2, { recursive: true, force: true }); }
}

// ── a scenario runs, validates, and produces stats ───────────────────────────
await (async () => {
  const d = mkdtempSync(join(tmpdir(), 'perf-fx3-'));
  try {
    const fx = buildFixture(join(d, 'small'), 'small');
    const { db, scenarios } = dbScenarios(fx);
    const s = scenarios.find((x) => x.name === 'invoice.totals.validate')!;
    const r = await measure(s.name, s.op, { reps: 3, warmup: 1, validate: s.validate });
    ok(r.ok === 3 && r.fail === 0 && r.p50 !== null, 'scenario: invoice totals validate + produce stats');
    db.close();
  } finally { rmSync(d, { recursive: true, force: true }); }
})();

console.log(`\nPERF-SUITE unit: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

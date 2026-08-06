// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — orchestrator.
//   node test/perf/run.mjs smoke     → SMALL fixture, quick baseline (dev gate)
//   node test/perf/run.mjs full      → MEDIUM fixture (realistic volume)
//   node test/perf/run.mjs large     → LARGE fixture (elevated load, on demand)
//   node test/perf/run.mjs baseline  → MEDIUM + write test/perf/baseline.json
// Writes a machine-readable JSON + Markdown under test/perf/artifacts/ (gitignored). Non-destructive; builds
// an isolated fixture in the OS temp dir and cleans it up.
// ════════════════════════════════════════════════════════════════════════════
import { measure, writeReport, envMeta, ARTIFACT_DIR } from './harness.mjs';
import { buildFixture, SIZES } from './fixtures.mjs';
import { dbScenarios, gcDryRunScenario, backupSelectScenario } from './scenarios-db.mjs';
import { mergeBaselineClass, baselineScenarios } from './baseline.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = process.argv[2] || 'smoke';
const SIZE = arg === 'full' || arg === 'baseline' ? 'medium' : arg === 'large' ? 'large' : 'small';
const runId = 'r' + Date.now().toString(36);
const REPS = SIZE === 'large' ? 5 : 9;

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'lataif-perf-'));
  const results = [];
  let fx;
  try {
    // 1) fixture build (measured once — it's the deterministic seed step).
    const buildT0 = performance.now();
    fx = buildFixture(join(work, SIZE), SIZE);
    const buildMs = Math.round((performance.now() - buildT0) * 1000) / 1000;
    results.push({ name: 'fixture.build', n: 1, p50: buildMs, p95: buildMs, min: buildMs, max: buildMs, stddev: 0, ok: 1, fail: 0, meta: { cold: true } });

    // 2) DB-layer scenarios (warm).
    const { db, scenarios } = dbScenarios(fx);
    for (const s of scenarios) results.push(await measure(s.name, s.op, { reps: REPS, validate: s.validate }));
    db.close();

    // 3) cold variant for the two list views (fresh connection per rep → cold cache-ish path).
    for (const [name, sql, expectLen] of [
      ['inventory.list.page1', 'SELECT id,brand,name,sku FROM products WHERE branch_id=? ORDER BY created_at DESC LIMIT 50', Math.min(50, fx.counts.products)],
      ['invoice.list.page1', 'SELECT i.id FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.branch_id=? ORDER BY i.issued_at DESC LIMIT 50', Math.min(50, fx.counts.invoices)],
    ]) {
      results.push(await measure(name + '.cold', () => { const d = new DatabaseSync(fx.dbPath, { readOnly: true }); const r = d.prepare(sql).all('branch-main'); d.close(); return r; }, { reps: Math.max(5, Math.floor(REPS / 2)), validate: (r) => r.length === expectLen, meta: { cold: true } }));
    }

    // 4) Media-GC dry-run + backup selection (data-layer proxies of the Rust plan/selection).
    const gc = gcDryRunScenario(fx);
    for (const s of gc.scenarios) results.push(await measure(s.name, s.op, { reps: REPS, validate: s.validate }));
    gc.close();
    const bk = backupSelectScenario(fx);
    for (const s of bk.scenarios) results.push(await measure(s.name, s.op, { reps: REPS, validate: s.validate }));
    bk.close();

    // 5) resource snapshot (node harness process — labelled as such, not the app).
    const rss = process.memoryUsage().rss;
    const extra = {
      fixture: { size: SIZE, counts: fx.counts, dbBytes: fx.dbBytes },
      resource: { harnessPeakRssBytes: rss, note: 'harness process RSS (node), not the Tauri app — app RSS is measured by the WebView2 perf E2E' },
    };

    const { jsonPath, mdPath } = writeReport(runId, `db-${SIZE}`, results, extra);
    const failed = results.filter((r) => r.fail > 0);
    console.log(`PERF db-${SIZE}: ${results.length} scenarios, ${failed.length} with failures. runId=${runId}`);
    console.log(`  json: ${jsonPath}`);
    console.log(`  md:   ${mdPath}`);

    if (arg === 'baseline') writeBaseline(SIZE, fx, results);
    if (failed.length) { console.error('SCENARIO FAILURES:', failed.map((f) => f.name + ' (' + f.lastError + ')').join('; ')); process.exit(1); }
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

function writeBaseline(size, fx, results) {
  const env = envMeta();
  // The node DB-layer numbers are their OWN class — never merged with the real-UI/app classes into a shared p50.
  mergeBaselineClass('node_sqlite_microbenchmark', {
    buildProfile: 'node-harness', runtime: 'node:sqlite (native SQLite, FK OFF/WAL) — NOT the app sql.js runtime',
    fixtureSize: size, fixtureCounts: fx.counts, sampleCount: REPS,
    scenarios: baselineScenarios(results.filter((r) => r.n >= 3)),
  }, { commit: env.commit, cpu: env.cpu, cpuCount: env.cpuCount, ramGB: env.totalRamGB, os: env.os, node: env.node,
    note: 'Reference environment for all classes. Machine-specific; only same-machine relative regression is meaningful.' });
  console.log('  baseline class node_sqlite_microbenchmark written');
}

main().catch((e) => { console.error('PERF RUN ERROR:', e?.stack || e); process.exit(1); });

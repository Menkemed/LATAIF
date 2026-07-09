// D4-C — Dry-Run Baseline/Compaction Report. READ-ONLY on COPIES only.
// Reuses the pure D4-B logic (src/core/sync/d4-changelog.ts). Writes ONLY report files.
// NO INSERT/UPDATE/DELETE/DROP/ALTER/VACUUM/CREATE — only SELECT + read-only PRAGMA metadata.
//
// Usage:
//   node scripts/d4/d4c_changelog_dry_run.mjs --frontend-db <lataif.db-copy> --sync-db <sync.db-copy> --out <dir> [--allow-copy-path]
//
// Safety: refuses the exact live AppData originals unless --allow-copy-path is passed; always
// opens read-only; never mutates the input DBs; never dumps base64/full rows (only ids/counts).

import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import {
  replayChanges,
  liveRecords,
  buildCorrectiveBaselinePlan,
  compactChangePlan,
  compareFinalStates,
  summarizePlan,
  plannedToChanges,
  maxId,
} from '../../src/core/sync/d4-changelog.ts';

// D4-C: plain-ASCII separator for composite map keys (never a NUL/control byte; keeps the file text/diffable).
const KEY_SEP = '::';

// Live originals we must never treat as an input (must use a copy).
export const LIVE_APPDATA_HINTS = ['com.lataif.app/lataif.db', 'com.lataif.app\\lataif.db',
  'com.lataif.app/lataif_sync_server.db', 'com.lataif.app\\lataif_sync_server.db'];

export function looksLikeLiveOriginal(p) {
  const norm = String(p);
  return LIVE_APPDATA_HINTS.some((h) => norm.endsWith(h));
}

function listTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
}
function tableColumns(db, t) {
  return db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
}
function scalar(db, sql) {
  const r = db.prepare(sql).get();
  return r ? Object.values(r)[0] : null;
}

/**
 * Pure-ish analysis: opens both DBs READ-ONLY, runs the D4-B plan, returns a summary object
 * (ids/counts only — NO base64, NO full rows). Writes NOTHING.
 */
export function analyze(frontendDbPath, syncDbPath) {
  const flags = [];
  let blocked = false;
  const block = (msg) => { flags.push('BLOCK: ' + msg); blocked = true; };
  const warn = (msg) => flags.push('WARN: ' + msg);

  const sv = new DatabaseSync(syncDbPath, { readOnly: true });
  const fe = new DatabaseSync(frontendDbPath, { readOnly: true });

  try {
    // ── integrity + schema safety ──
    const svIntegrity = String(scalar(sv, 'PRAGMA integrity_check'));
    const feIntegrity = String(scalar(fe, 'PRAGMA integrity_check'));
    if (svIntegrity !== 'ok') block(`sync db integrity_check = ${svIntegrity}`);
    if (feIntegrity !== 'ok') block(`frontend db integrity_check = ${feIntegrity}`);

    const svTables = listTables(sv);
    const feTables = listTables(fe);
    if (!svTables.includes('sync_changelog')) block('sync_changelog table missing');

    const changelogSchema = svTables.includes('sync_changelog') ? tableColumns(sv, 'sync_changelog') : [];
    const expectedCols = ['id', 'tenant_id', 'branch_id', 'table_name', 'record_id', 'action', 'data', 'created_at'];
    const missingCols = expectedCols.filter((c) => !changelogSchema.includes(c));
    if (changelogSchema.length && missingCols.length) block(`sync_changelog schema unexpected, missing: ${missingCols.join(',')}`);

    if (blocked) {
      return { blocked, flags, changelogSchema, svTables, feTables };
    }

    // ── changelog stats ──
    const totalChanges = Number(scalar(sv, 'SELECT COUNT(*) FROM sync_changelog'));
    const idRange = sv.prepare('SELECT MIN(id) mn, MAX(id) mx FROM sync_changelog').get();
    const dateRange = sv.prepare('SELECT MIN(created_at) a, MAX(created_at) b FROM sync_changelog').get();
    const tenants = sv.prepare('SELECT DISTINCT tenant_id FROM sync_changelog').all().map((r) => r.tenant_id);
    const branches = sv.prepare('SELECT DISTINCT branch_id FROM sync_changelog').all().map((r) => r.branch_id);

    const perTableActionRows = sv.prepare(
      'SELECT table_name, action, COUNT(*) n FROM sync_changelog GROUP BY table_name, action'
    ).all();
    const perTable = {};
    for (const r of perTableActionRows) {
      const t = (perTable[r.table_name] ??= { table: r.table_name, changes: 0, insert: 0, update: 0, delete: 0, distinctRecords: 0 });
      t.changes += Number(r.n);
      if (r.action === 'insert' || r.action === 'update' || r.action === 'delete') t[r.action] += Number(r.n);
    }
    for (const t of Object.keys(perTable)) {
      perTable[t].distinctRecords = Number(scalar(sv, `SELECT COUNT(DISTINCT record_id) FROM sync_changelog WHERE table_name = '${t.replace(/'/g, "''")}'`));
    }
    const topTables = Object.values(perTable).sort((a, b) => b.changes - a.changes).slice(0, 15);

    if (tenants.length > 1) warn(`changelog has ${tenants.length} distinct tenant_ids (${tenants.join(',')}) — multi-tenant, verify authoritative mapping`);

    // ── load changelog IDENTITY rows (NO `data` column → never touch base64) ──
    const clRows = sv.prepare('SELECT id, tenant_id, branch_id, table_name, record_id, action FROM sync_changelog').all();
    const changes = clRows.map((r) => ({
      id: Number(r.id), tenant_id: r.tenant_id, branch_id: r.branch_id,
      table_name: r.table_name, record_id: String(r.record_id), action: r.action, data: {}, created_at: '',
    }));

    // meta lookup: latest (tenant, branch) per (table, record_id) — align authoritative keys to changelog.
    const metaByTR = new Map();
    for (const c of changes) metaByTR.set(c.table_name + KEY_SEP + c.record_id, { tenant: c.tenant_id, branch: c.branch_id });
    const dominantTenant = tenants[0] ?? '';

    // ── table coverage: changelog tables that safely map to frontend tables (with `id`) ──
    const changelogTables = [...new Set(changes.map((c) => c.table_name))];
    const covered = [];
    const skipped = [];
    for (const t of changelogTables) {
      if (!feTables.includes(t)) { skipped.push({ table: t, reason: 'not present in frontend db' }); continue; }
      const cols = tableColumns(fe, t);
      if (!cols.includes('id')) { skipped.push({ table: t, reason: 'no id column in frontend db' }); continue; }
      covered.push({ table: t, hasBranch: cols.includes('branch_id') });
    }
    const coveredSet = new Set(covered.map((c) => c.table));

    // ── authoritative live records (IDENTITY only — no row data, no base64) from covered tables ──
    const authoritative = [];
    const authPerTable = {};
    for (const { table, hasBranch } of covered) {
      const rows = fe.prepare(`SELECT id${hasBranch ? ', branch_id' : ''} FROM "${table}"`).all();
      authPerTable[table] = rows.length;
      for (const r of rows) {
        const rid = String(r.id);
        const meta = metaByTR.get(table + KEY_SEP + rid);
        authoritative.push({
          tenant_id: meta ? meta.tenant : dominantTenant,
          branch_id: meta ? meta.branch : (hasBranch ? String(r.branch_id ?? '') : ''),
          table_name: table, record_id: rid, data: {},
        });
      }
    }

    // ── D4-B plan (baseline restricted to COVERED tables → never tombstone skipped tables) ──
    const coveredChanges = changes.filter((c) => coveredSet.has(c.table_name));
    const replayAll = replayChanges(changes);
    const replayCovered = replayChanges(coveredChanges);
    const baseline = buildCorrectiveBaselinePlan({ changes: coveredChanges, authoritativeLiveRecords: authoritative });

    // ── safety: empty authoritative but many live records ──
    const liveCoveredCount = liveRecords(replayCovered).length;
    if (authoritative.length === 0 && liveCoveredCount > 20) block(`authoritative live set EMPTY but changelog has ${liveCoveredCount} live records in covered tables`);
    if (authoritative.length > 0 && baseline.syntheticDeletes.length > authoritative.length * 20 && baseline.syntheticDeletes.length > 100)
      warn(`synthetic deletes (${baseline.syntheticDeletes.length}) ≫ authoritative live (${authoritative.length}) — likely a STALE changelog vs current DB; verify the changelog and authoritative DB are the SAME dataset before any real migration`);

    // ── compaction (size analysis over ALL changes) + liveness-preservation check ──
    const compaction = compactChangePlan(changes);
    const compDiff = compareFinalStates(replayAll, replayChanges(compaction.kept));
    const livenessDiffs = compDiff.differences.filter((d) => d.kind === 'liveness-changed' || d.kind === 'only-in-before' || d.kind === 'only-in-after');
    if (livenessDiffs.length) warn(`compaction changed liveness for ${livenessDiffs.length} records (should be 0) — investigate`);

    // ── idempotency simulation (apply plan as synthetic changes → recompute) ──
    const applied = plannedToChanges([...baseline.baselineUpserts, ...baseline.syntheticDeletes], maxId(coveredChanges), 'T');
    const plan2 = buildCorrectiveBaselinePlan({ changes: [...coveredChanges, ...applied], authoritativeLiveRecords: authoritative });
    const idempotent = plan2.syntheticDeletes.length === 0;
    if (!idempotent) warn(`idempotency simulation produced ${plan2.syntheticDeletes.length} extra synthetic deletes (should be 0)`);

    // ── products special (aggregates only) ──
    let products = null;
    if (feTables.includes('products')) {
      products = {
        count: Number(scalar(fe, 'SELECT COUNT(*) FROM products')),
        quantitySum: Number(scalar(fe, 'SELECT COALESCE(SUM(quantity),0) FROM products')),
        withImages: Number(scalar(fe, "SELECT COUNT(*) FROM products WHERE images IS NOT NULL AND images NOT IN ('','[]','null')")),
        has3d187aed: !!fe.prepare("SELECT 1 FROM products WHERE id LIKE '3d187aed%'").get(),
      };
    }

    const summary = summarizePlan({ ...baseline, ...compaction });
    const compactionPct = totalChanges > 0 ? Math.round((compaction.archived.length / totalChanges) * 1000) / 10 : 0;

    return {
      blocked, flags,
      integrity: { syncDb: svIntegrity, frontendDb: feIntegrity },
      changelogSchema, tenants, branches,
      changelog: {
        totalChanges, minId: idRange.mn, maxId: idRange.mx,
        firstCreatedAt: dateRange.a, lastCreatedAt: dateRange.b,
        distinctTablesInLog: changelogTables.length, topTables,
      },
      coverage: {
        covered: covered.map((c) => c.table), skipped,
        authPerTable, authoritativeLiveTotal: authoritative.length,
      },
      replay: {
        liveInLog: liveRecords(replayAll).length,
        tombstonesInLog: replayAll.size - liveRecords(replayAll).length,
        liveInCoveredTables: liveCoveredCount,
      },
      plan: {
        baselineUpserts: baseline.baselineUpserts.length,
        syntheticDeletes: baseline.syntheticDeletes.length,
        syntheticDeleteSample: baseline.syntheticDeletes.slice(0, 15).map((d) => ({ table: d.table_name, record_id: d.record_id })),
      },
      compaction: {
        totalChanges, kept: compaction.kept.length, archived: compaction.archived.length,
        tombstonesKept: compaction.kept.filter((c) => c.action === 'delete').length,
        reductionPct: compactionPct, livenessPreserved: livenessDiffs.length === 0,
      },
      idempotent,
      products,
      summary,
    };
  } finally {
    sv.close();
    fe.close();
  }
}

// ── report rendering (ids/counts/summaries only — NO base64, NO row data) ──
export function renderMarkdown(report, meta) {
  if (report.blocked) {
    return `# D4-C Dry-Run Report — BLOCKED\n\n- timestamp: ${meta.timestamp}\n- flags:\n${report.flags.map((f) => `  - ${f}`).join('\n')}\n`;
  }
  const r = report;
  const l = [];
  l.push(`# D4-C Dry-Run Baseline/Compaction Report`);
  l.push(``);
  l.push(`- timestamp: ${meta.timestamp}`);
  l.push(`- frontend db copy: \`${meta.frontendDbPath}\``);
  l.push(`- sync db copy: \`${meta.syncDbPath}\``);
  l.push(`- **READ-ONLY dry-run — originals untouched, no SQL writes, no data/base64 dumped.**`);
  l.push(``);
  l.push(`## Integrity\n- sync db: \`${r.integrity.syncDb}\`\n- frontend db: \`${r.integrity.frontendDb}\``);
  l.push(``);
  l.push(`## Changelog statistics`);
  l.push(`- total changes: **${r.changelog.totalChanges}**`);
  l.push(`- id range: ${r.changelog.minId} .. ${r.changelog.maxId}`);
  l.push(`- created_at range: ${r.changelog.firstCreatedAt} .. ${r.changelog.lastCreatedAt}`);
  l.push(`- distinct tables in log: ${r.changelog.distinctTablesInLog}`);
  l.push(`- tenants: ${r.tenants.join(', ')} | branches: ${r.branches.join(', ')}`);
  l.push(``);
  l.push(`### Top tables by change count`);
  l.push(`| table | changes | insert | update | delete | distinct records |`);
  l.push(`|---|---|---|---|---|---|`);
  for (const t of r.changelog.topTables) l.push(`| ${t.table} | ${t.changes} | ${t.insert} | ${t.update} | ${t.delete} | ${t.distinctRecords} |`);
  l.push(``);
  l.push(`## Live-DB (authoritative) coverage`);
  l.push(`- covered tables: ${r.coverage.covered.join(', ') || '(none)'}`);
  l.push(`- skipped/uncertain: ${r.coverage.skipped.map((s) => `${s.table} (${s.reason})`).join('; ') || '(none)'}`);
  l.push(`- authoritative live records total: **${r.coverage.authoritativeLiveTotal}**`);
  if (r.products) l.push(`- products: count=${r.products.count}, quantitySum=${r.products.quantitySum}, withImages=${r.products.withImages}, 3d187aed present=${r.products.has3d187aed}`);
  l.push(``);
  l.push(`## Replay (final state from changelog)`);
  l.push(`- live in log: ${r.replay.liveInLog} | tombstones in log: ${r.replay.tombstonesInLog} | live in covered tables: ${r.replay.liveInCoveredTables}`);
  l.push(``);
  l.push(`## Planned corrective baseline (DRY-RUN — nothing written)`);
  l.push(`- baseline upserts (authoritative live re-assert): **${r.plan.baselineUpserts}**`);
  l.push(`- synthetic delete tombstones (orphaned changelog records): **${r.plan.syntheticDeletes}**`);
  l.push(`- synthetic-delete sample (ids only): ${r.plan.syntheticDeleteSample.map((s) => `${s.table}:${s.record_id}`).join(', ') || '(none)'}`);
  l.push(``);
  l.push(`## Compaction potential (DRY-RUN)`);
  l.push(`- total changes: ${r.compaction.totalChanges}`);
  l.push(`- kept (1 per record): ${r.compaction.kept} | archived/prunable: ${r.compaction.archived} | tombstones kept: ${r.compaction.tombstonesKept}`);
  l.push(`- reduction: **${r.compaction.reductionPct}%** | liveness preserved: ${r.compaction.livenessPreserved}`);
  l.push(``);
  l.push(`## Idempotency simulation\n- apply plan → recompute → no new tombstones: **${r.idempotent}**`);
  l.push(``);
  l.push(`## Risks / uncertainties`);
  l.push(r.flags.length ? r.flags.map((f) => `- ${f}`).join('\n') : '- none flagged');
  return l.join('\n') + '\n';
}

// ── CLI (only runs when executed directly, not when imported by tests) ──
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--frontend-db') a.frontendDb = argv[++i];
    else if (argv[i] === '--sync-db') a.syncDb = argv[++i];
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--allow-copy-path') a.allowCopyPath = true;
  }
  return a;
}

async function main() {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const a = parseArgs(process.argv.slice(2));
  if (!a.frontendDb || !a.syncDb || !a.out) {
    console.error('Usage: node scripts/d4/d4c_changelog_dry_run.mjs --frontend-db <copy> --sync-db <copy> --out <dir> [--allow-copy-path]');
    process.exit(2);
  }
  if (!a.allowCopyPath && (looksLikeLiveOriginal(a.frontendDb) || looksLikeLiveOriginal(a.syncDb))) {
    console.error('REFUSED: a path looks like the LIVE AppData original. Point at COPIES, or pass --allow-copy-path if you are sure these are copies.');
    process.exit(3);
  }
  // Timestamp passed in via out-dir name by the caller (no Date in the tool body beyond the label).
  const ts = a.out.split(/[\\/]/).pop() || 'dry-run';
  const report = analyze(a.frontendDb, a.syncDb);
  const meta = { timestamp: ts, frontendDbPath: a.frontendDb, syncDbPath: a.syncDb };
  mkdirSync(a.out, { recursive: true });
  writeFileSync(join(a.out, `D4C_DRY_RUN_REPORT_${ts}.md`), renderMarkdown(report, meta), 'utf8');
  writeFileSync(join(a.out, `D4C_DRY_RUN_SUMMARY_${ts}.json`), JSON.stringify({ meta, report }, null, 2), 'utf8');
  console.log(`D4-C dry-run complete. blocked=${report.blocked}. Reports in: ${a.out}`);
  if (report.blocked) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('D4-C dry-run crashed:', e); process.exit(1); });
}

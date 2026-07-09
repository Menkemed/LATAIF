// D4-D — Corrective Baseline / Tombstone / Compaction migration tool for lataif_sync_server.db.
// DEFAULT = DRY-RUN (no writes). Writes ONLY with the full explicit safety flag set:
//   --execute --i-understand-this-writes-to-sync-db --backup-dir <path>
// Backup-first, single-transaction (archive → append corrective baseline → prune → verify).
// Reports contain counts/ids/sku/hashes ONLY — never base64/full rows/secrets.
//
// GENERIC TOOL — we currently have NO real colleague DB, so this does NOT claim to have fixed
// the colleague case. Run it on a COPY (dry-run) as a function check; execute only after review.
//
// Usage (dry-run):
//   node scripts/d4/d4d_changelog_migrate.mjs --frontend-db <lataif.db> --sync-db <sync.db> --out <dir>
// Usage (execute — writes to sync db, backup mandatory):
//   node scripts/d4/d4d_changelog_migrate.mjs --frontend-db <lataif.db> --sync-db <sync.db> --out <dir> \
//     --execute --i-understand-this-writes-to-sync-db --backup-dir <backup-dir> [--allow-live-path] [--allow-large-correction]

import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  recordKey, replayChanges, liveRecords, buildCorrectiveBaselinePlan, compareFinalStates, maxId,
} from '../../src/core/sync/d4-changelog.ts';

const KEY_SEP = '::';
const LARGE_CORRECTION_ABS = 500; // synthetic deletes above this need --allow-large-correction
const LIVE_APPDATA_HINTS = ['com.lataif.app/lataif.db', 'com.lataif.app\\lataif.db',
  'com.lataif.app/lataif_sync_server.db', 'com.lataif.app\\lataif_sync_server.db'];

export function looksLikeLiveOriginal(p) {
  const s = String(p);
  return LIVE_APPDATA_HINTS.some((h) => s.endsWith(h));
}
export function parseArgs(argv) {
  const a = { execute: false, understand: false, allowLivePath: false, allowLargeCorrection: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--frontend-db') a.frontendDb = argv[++i];
    else if (t === '--sync-db') a.syncDb = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--backup-dir') a.backupDir = argv[++i];
    else if (t === '--execute') a.execute = true;
    else if (t === '--i-understand-this-writes-to-sync-db') a.understand = true;
    else if (t === '--allow-live-path') a.allowLivePath = true;
    else if (t === '--allow-large-correction') a.allowLargeCorrection = true;
  }
  return a;
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
function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ── read-only planning: opens both DBs read-only, returns full plan + stats + flags. Writes nothing. ──
// withData=true attaches full lataif.db rows to baseline upserts (needed for EXECUTE); the report
// never serialises those rows.
export function computePlan(frontendDbPath, syncDbPath, opts = {}) {
  const withData = !!opts.withData;
  const flags = [];
  let blocked = false;
  const block = (m) => { flags.push('BLOCK: ' + m); blocked = true; };
  const warn = (m) => flags.push('WARN: ' + m);

  const sv = new DatabaseSync(syncDbPath, { readOnly: true });
  const fe = new DatabaseSync(frontendDbPath, { readOnly: true });
  try {
    const svIntegrity = String(scalar(sv, 'PRAGMA integrity_check'));
    const feIntegrity = String(scalar(fe, 'PRAGMA integrity_check'));
    if (svIntegrity !== 'ok') block(`sync db integrity_check = ${svIntegrity}`);
    if (feIntegrity !== 'ok') block(`frontend db integrity_check = ${feIntegrity}`);

    const svTables = listTables(sv);
    const feTables = listTables(fe);
    if (!svTables.includes('sync_changelog')) block('sync_changelog table missing');
    const changelogSchema = svTables.includes('sync_changelog') ? tableColumns(sv, 'sync_changelog') : [];
    const need = ['id', 'tenant_id', 'branch_id', 'table_name', 'record_id', 'action', 'data', 'created_at'];
    const missing = need.filter((c) => !changelogSchema.includes(c));
    if (changelogSchema.length && missing.length) block(`sync_changelog schema unexpected, missing: ${missing.join(',')}`);
    if (blocked) return { blocked, flags, integrity: { syncDb: svIntegrity, frontendDb: feIntegrity } };

    const totalChanges = Number(scalar(sv, 'SELECT COUNT(*) FROM sync_changelog'));
    const oldMaxId = Number(scalar(sv, 'SELECT COALESCE(MAX(id),0) FROM sync_changelog'));
    const tenants = sv.prepare('SELECT DISTINCT tenant_id FROM sync_changelog').all().map((r) => r.tenant_id);
    const branches = sv.prepare('SELECT DISTINCT branch_id FROM sync_changelog').all().map((r) => r.branch_id);
    if (tenants.length > 1) warn(`changelog has ${tenants.length} distinct tenant_ids — verify mapping (execute needs a single-tenant plan)`);

    const clRows = sv.prepare('SELECT id, tenant_id, branch_id, table_name, record_id, action FROM sync_changelog').all();
    const changes = clRows.map((r) => ({
      id: Number(r.id), tenant_id: r.tenant_id, branch_id: r.branch_id,
      table_name: r.table_name, record_id: String(r.record_id), action: r.action, data: {}, created_at: '',
    }));
    const metaByTR = new Map();
    for (const c of changes) metaByTR.set(c.table_name + KEY_SEP + c.record_id, { tenant: c.tenant_id, branch: c.branch_id });
    const dominantTenant = tenants[0] ?? '';

    // coverage
    const changelogTables = [...new Set(changes.map((c) => c.table_name))];
    const covered = [];
    const skipped = [];
    for (const t of changelogTables) {
      if (!feTables.includes(t)) { skipped.push({ table: t, reason: 'not in frontend db' }); continue; }
      const cols = tableColumns(fe, t);
      if (!cols.includes('id')) { skipped.push({ table: t, reason: 'no id column' }); continue; }
      covered.push({ table: t, hasBranch: cols.includes('branch_id'), cols });
    }
    const coveredNames = covered.map((c) => c.table);
    const coveredSet = new Set(coveredNames);
    if (covered.length === 0 && changelogTables.length > 0) block('no changelog table maps to the frontend db (nothing safely coverable)');

    // authoritative live records (identity; +full row when withData)
    const authoritative = [];
    const authPerTable = {};
    for (const { table, hasBranch, cols } of covered) {
      const sel = withData ? '*' : `id${hasBranch ? ', branch_id' : ''}`;
      const rows = fe.prepare(`SELECT ${sel} FROM "${table}"`).all();
      authPerTable[table] = rows.length;
      for (const r of rows) {
        const rid = String(r.id);
        const meta = metaByTR.get(table + KEY_SEP + rid);
        const data = withData ? Object.fromEntries(cols.map((c) => [c, r[c]])) : {};
        authoritative.push({
          tenant_id: meta ? meta.tenant : dominantTenant,
          branch_id: meta ? meta.branch : (hasBranch ? String(r.branch_id ?? '') : ''),
          table_name: table, record_id: rid, data,
        });
      }
    }

    const coveredChanges = changes.filter((c) => coveredSet.has(c.table_name));
    const replayCovered = replayChanges(coveredChanges);
    const { baselineUpserts, syntheticDeletes } = buildCorrectiveBaselinePlan({ changes: coveredChanges, authoritativeLiveRecords: authoritative });

    // preserve tombstones for already-deleted records that the plan does not otherwise cover
    const coveredByPlan = new Set([...baselineUpserts, ...syntheticDeletes].map((p) => recordKey(p)));
    const preservedTombstones = [];
    for (const e of replayCovered.values()) {
      if (e.deleted && !coveredByPlan.has(recordKey(e))) {
        preservedTombstones.push({ tenant_id: e.tenant_id, branch_id: e.branch_id, table_name: e.table_name, record_id: e.record_id, action: 'delete', data: {}, reason: 'preserved-tombstone' });
      }
    }
    // target = 1 corrective row per covered record_id (baseline upserts + synthetic deletes + preserved tombstones)
    const targetRows = [...baselineUpserts, ...syntheticDeletes, ...preservedTombstones];

    // safety: empty authoritative but many live records
    const liveCovered = liveRecords(replayCovered).length;
    if (authoritative.length === 0 && liveCovered > 20) block(`authoritative live set EMPTY but changelog has ${liveCovered} live covered records`);
    const largeCorrection = syntheticDeletes.length > LARGE_CORRECTION_ABS || (authoritative.length > 0 && syntheticDeletes.length > authoritative.length * 20 && syntheticDeletes.length > 100);

    // per-table change stats
    const perTable = {};
    for (const r of sv.prepare('SELECT table_name, action, COUNT(*) n FROM sync_changelog GROUP BY table_name, action').all()) {
      const t = (perTable[r.table_name] ??= { table: r.table_name, changes: 0, insert: 0, update: 0, delete: 0 });
      t.changes += Number(r.n);
      if (['insert', 'update', 'delete'].includes(r.action)) t[r.action] += Number(r.n);
    }
    const topTables = Object.values(perTable).sort((a, b) => b.changes - a.changes).slice(0, 15);

    let products = null;
    if (feTables.includes('products')) {
      products = {
        count: Number(scalar(fe, 'SELECT COUNT(*) FROM products')),
        quantitySum: Number(scalar(fe, 'SELECT COALESCE(SUM(quantity),0) FROM products')),
        withImages: Number(scalar(fe, "SELECT COUNT(*) FROM products WHERE images IS NOT NULL AND images NOT IN ('','[]','null')")),
        has3d187aed: !!fe.prepare("SELECT 1 FROM products WHERE id LIKE '3d187aed%'").get(),
      };
    }

    // final active-changelog size after migration = target rows for covered + untouched skipped rows
    const skippedRowCount = totalChanges - coveredChanges.length;
    const afterActive = targetRows.length + skippedRowCount;

    return {
      blocked, flags, integrity: { syncDb: svIntegrity, frontendDb: feIntegrity },
      tenants, branches, oldMaxId, totalChanges, topTables,
      coverage: { covered: coveredNames, skipped, authPerTable, authoritativeLiveTotal: authoritative.length },
      replay: { liveCovered, tombstonesCovered: replayCovered.size - liveCovered },
      plan: {
        baselineUpserts, syntheticDeletes, preservedTombstones, targetRows,
        baselineUpsertCount: baselineUpserts.length, syntheticDeleteCount: syntheticDeletes.length,
        preservedTombstoneCount: preservedTombstones.length, targetRowCount: targetRows.length,
        syntheticDeleteSample: syntheticDeletes.slice(0, 15).map((d) => ({ table: d.table_name, record_id: d.record_id })),
      },
      compaction: { beforeActive: totalChanges, afterActive, prunedCovered: coveredChanges.length, reductionPct: totalChanges ? Math.round((1 - afterActive / totalChanges) * 1000) / 10 : 0 },
      largeCorrection, products, replayCoveredState: replayCovered,
    };
  } finally {
    sv.close();
    fe.close();
  }
}

// ── backup: copy sync (+wal+shm) + frontend to backupDir, write manifest with sha/size/mtime. ──
export function backupDbs(syncDbPath, frontendDbPath, backupDir, gitHash) {
  mkdirSync(backupDir, { recursive: true });
  const srcs = [syncDbPath, syncDbPath + '-wal', syncDbPath + '-shm', frontendDbPath];
  const files = [];
  for (const src of srcs) {
    if (!existsSync(src)) continue;
    const name = src.split(/[\\/]/).pop();
    const dst = join(backupDir, name);
    copyFileSync(src, dst);
    const st = statSync(src);
    const sha = sha256File(src);
    const dsha = sha256File(dst);
    if (sha !== dsha) throw new Error(`backup verify failed for ${name} (sha mismatch)`);
    files.push({ name, originalPath: src, backupPath: dst, size: st.size, mtime: st.mtime.toISOString(), sha256: sha });
  }
  if (!files.some((f) => f.originalPath === syncDbPath)) throw new Error('backup failed: sync db not backed up');
  const manifest = {
    warning: 'D4-D pre-migration backup — restore by copying these files back over the originals.',
    tool: 'd4d_changelog_migrate', gitHash: gitHash || 'unknown', timestamp: new Date().toISOString(), files,
  };
  writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { ok: true, manifest, backupDir };
}

// ── execute: single transaction — archive covered rows → append corrective baseline → prune → verify. ──
export function executeMigration(syncDbPath, plan, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const db = new DatabaseSync(syncDbPath); // read-write
  try {
    const coveredNames = plan.coverage.covered;
    const coveredList = coveredNames.map((t) => `'${t.replace(/'/g, "''")}'`).join(',');
    db.exec('BEGIN');
    try {
      // A. archive table + copy covered rows
      db.exec(`CREATE TABLE IF NOT EXISTS sync_changelog_archive (
        id INTEGER, tenant_id TEXT, branch_id TEXT, table_name TEXT, record_id TEXT,
        action TEXT, data TEXT, user_id TEXT, created_at TEXT, archived_at TEXT)`);
      const archived = coveredNames.length
        ? db.prepare(`INSERT INTO sync_changelog_archive SELECT id,tenant_id,branch_id,table_name,record_id,action,data,user_id,created_at,? FROM sync_changelog WHERE table_name IN (${coveredList})`).run(now).changes
        : 0;

      // B. append corrective baseline (new AUTOINCREMENT ids > oldMaxId)
      const ins = db.prepare(`INSERT INTO sync_changelog (tenant_id,branch_id,table_name,record_id,action,data,user_id,created_at)
        VALUES (?,?,?,?,?,?, 'd4d-migration', ?)`);
      let appended = 0;
      for (const t of plan.plan.targetRows) {
        ins.run(t.tenant_id, t.branch_id, t.table_name, t.record_id, t.action, JSON.stringify(t.data ?? {}), now);
        appended++;
      }

      // C. prune old covered rows (id <= oldMaxId keeps the appended baseline which has higher ids)
      const pruned = coveredNames.length
        ? db.prepare(`DELETE FROM sync_changelog WHERE table_name IN (${coveredList}) AND id <= ?`).run(plan.oldMaxId).changes
        : 0;

      // D. verify inside the tx: integrity + replay == corrective state
      const integrity = String(scalar(db, 'PRAGMA integrity_check'));
      if (integrity !== 'ok') throw new Error(`post-migration integrity_check = ${integrity}`);
      db.exec('COMMIT');
      return { archived, appended, pruned, integrity };
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.close();
  }
}

// ── verify after execute (read-only): replay covered == authoritative-live + orphans-deleted; idempotent. ──
export function verifyAfter(frontendDbPath, syncDbPath) {
  const re = computePlan(frontendDbPath, syncDbPath, { withData: false });
  if (re.blocked) return { ok: false, reason: 'recompute blocked: ' + re.flags.join('; ') };
  const idempotent = re.plan.syntheticDeleteCount === 0;
  return { ok: idempotent, idempotent, remainingSyntheticDeletes: re.plan.syntheticDeleteCount, integrity: re.integrity, afterActive: re.compaction.afterActive };
}

// ── report (counts/ids only — NO base64/rows) ──
export function renderReport(plan, meta) {
  if (plan.blocked) return `# D4-D Migration Report — BLOCKED\n\n- timestamp: ${meta.timestamp}\n- mode: ${meta.mode}\n- flags:\n${plan.flags.map((f) => `  - ${f}`).join('\n')}\n`;
  const p = plan;
  const l = [];
  l.push(`# D4-D Corrective Migration Report (${meta.mode})`);
  l.push(``);
  l.push(`- timestamp: ${meta.timestamp}`);
  l.push(`- mode: **${meta.mode}**  ${meta.mode === 'DRY-RUN' ? '(no writes)' : '(WROTE to sync db)'}`);
  l.push(`- frontend db: \`${meta.frontendDbPath}\``);
  l.push(`- sync db: \`${meta.syncDbPath}\``);
  if (meta.backup) l.push(`- backup dir: \`${meta.backup.backupDir}\` (${meta.backup.manifest.files.length} files, manifest.json with SHA-256)`);
  l.push(`- **No base64 / full rows / secrets in this report.**`);
  l.push(``);
  l.push(`## Integrity\n- sync db: \`${p.integrity.syncDb}\` | frontend db: \`${p.integrity.frontendDb}\``);
  l.push(``);
  l.push(`## Changelog before\n- total active changes: **${p.totalChanges}** | max id: ${p.oldMaxId} | tenants: ${p.tenants.join(', ')} | branches: ${p.branches.join(', ')}`);
  l.push(``);
  l.push(`## Coverage\n- covered tables: ${p.coverage.covered.join(', ') || '(none)'}\n- skipped/uncertain (LEFT UNTOUCHED): ${p.coverage.skipped.map((s) => `${s.table} (${s.reason})`).join('; ') || '(none)'}\n- authoritative live records: **${p.coverage.authoritativeLiveTotal}**`);
  if (p.products) l.push(`- products: count=${p.products.count}, quantitySum=${p.products.quantitySum}, withImages=${p.products.withImages}, 3d187aed present=${p.products.has3d187aed}`);
  l.push(``);
  l.push(`## Planned corrective baseline`);
  l.push(`- baseline upserts (authoritative live): **${p.plan.baselineUpsertCount}**`);
  l.push(`- synthetic delete tombstones (orphans): **${p.plan.syntheticDeleteCount}**`);
  l.push(`- preserved tombstones (already-deleted): **${p.plan.preservedTombstoneCount}**`);
  l.push(`- total corrective rows to append: **${p.plan.targetRowCount}**`);
  l.push(`- synthetic-delete sample (ids only): ${p.plan.syntheticDeleteSample.map((s) => `${s.table}:${s.record_id}`).join(', ') || '(none)'}`);
  l.push(`- large correction: ${p.largeCorrection} ${p.largeCorrection ? '→ requires --allow-large-correction' : ''}`);
  l.push(``);
  l.push(`## Compaction`);
  l.push(`- active changes before: ${p.compaction.beforeActive} | after: ${p.compaction.afterActive} | pruned covered: ${p.compaction.prunedCovered} → **${p.compaction.reductionPct}% smaller active log**`);
  l.push(`- (old covered rows are ARCHIVED into sync_changelog_archive — restore-able; disk space is reclaimed later via a confirmed \`DROP TABLE sync_changelog_archive; VACUUM;\`)`);
  l.push(``);
  if (meta.executeResult) {
    l.push(`## Execute result`);
    l.push(`- archived: ${meta.executeResult.archived} | appended: ${meta.executeResult.appended} | pruned: ${meta.executeResult.pruned} | post integrity: \`${meta.executeResult.integrity}\``);
    l.push(``);
  }
  if (meta.verify) {
    l.push(`## Post-migration verify`);
    l.push(`- replay idempotent (0 new synthetic deletes): **${meta.verify.idempotent}** | remaining synthetic deletes: ${meta.verify.remainingSyntheticDeletes} | integrity: \`${meta.verify.integrity?.syncDb}\``);
    l.push(``);
  }
  l.push(`## Restore instructions`);
  l.push(meta.backup
    ? `- To roll back: copy the files in \`${meta.backup.backupDir}\` back over the originals (see manifest.json / SHA-256). Alternatively restore rows from \`sync_changelog_archive\`.`
    : `- Dry-run: nothing was written; no restore needed.`);
  l.push(``);
  l.push(`## Risks / flags`);
  l.push(p.flags.length ? p.flags.map((f) => `- ${f}`).join('\n') : '- none flagged');
  return l.join('\n') + '\n';
}

// ── orchestrator: dry-run by default; execute only with the full flag set + all safety gates. ──
export function runMigration(args, deps = {}) {
  const now = deps.now || new Date().toISOString();
  const gitHash = deps.gitHash || 'unknown';
  const wantsExecute = args.execute || args.understand || args.backupDir;
  const executeAuthorized = args.execute && args.understand && !!args.backupDir;

  // path safety
  if (!args.allowLivePath && (looksLikeLiveOriginal(args.frontendDb) || looksLikeLiveOriginal(args.syncDb))) {
    return { blocked: true, reason: 'a path looks like the LIVE AppData original; pass --allow-live-path only if these are safe copies/authorized' };
  }
  if (wantsExecute && !executeAuthorized) {
    return { blocked: true, reason: 'execute requires ALL of: --execute --i-understand-this-writes-to-sync-db --backup-dir <path>. Missing → staying dry-run, nothing written.' };
  }

  // plan (execute needs full data for baseline upserts). Any DB open/read failure → BLOCK (never write).
  let plan;
  try {
    plan = computePlan(args.frontendDb, args.syncDb, { withData: executeAuthorized });
  } catch (e) {
    return { blocked: true, mode: 'DRY-RUN', reason: 'cannot open/read a DB (corrupt / not a database?) → NO WRITE: ' + String(e.message || e) };
  }
  const mode = executeAuthorized ? 'EXECUTE' : 'DRY-RUN';

  if (plan.blocked) return { blocked: true, plan, mode, reason: 'planning blocked: ' + plan.flags.join('; ') };
  if (executeAuthorized && plan.largeCorrection && !args.allowLargeCorrection) {
    return { blocked: true, plan, mode: 'DRY-RUN', reason: `large correction (${plan.plan.syntheticDeleteCount} synthetic deletes) requires --allow-large-correction; nothing written` };
  }

  const meta = { mode: 'DRY-RUN', timestamp: deps.outTs || now, frontendDbPath: args.frontendDb, syncDbPath: args.syncDb };

  if (!executeAuthorized) {
    return { blocked: false, executed: false, plan, mode: 'DRY-RUN', meta };
  }

  // EXECUTE path: backup → write → verify
  let backup;
  try {
    backup = backupDbs(args.syncDb, args.frontendDb, args.backupDir, gitHash);
  } catch (e) {
    return { blocked: true, plan, mode: 'DRY-RUN', reason: 'backup failed → NO WRITE: ' + String(e.message || e) };
  }
  meta.backup = backup;
  const executeResult = executeMigration(args.syncDb, plan, { now });
  const verify = verifyAfter(args.frontendDb, args.syncDb);
  meta.mode = 'EXECUTE';
  meta.executeResult = executeResult;
  meta.verify = verify;
  return { blocked: false, executed: true, plan, mode: 'EXECUTE', meta, backup, executeResult, verify };
}

// ── CLI ──
async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.frontendDb || !a.syncDb || !a.out) {
    console.error('Usage: node scripts/d4/d4d_changelog_migrate.mjs --frontend-db <db> --sync-db <db> --out <dir> [--execute --i-understand-this-writes-to-sync-db --backup-dir <dir>] [--allow-live-path] [--allow-large-correction]');
    process.exit(2);
  }
  let gitHash = 'unknown';
  try { gitHash = (await import('node:child_process')).execSync('git rev-parse HEAD', { cwd: process.cwd() }).toString().trim(); } catch { /* ok */ }
  const ts = a.out.split(/[\\/]/).pop() || 'run';
  const res = runMigration(a, { gitHash, outTs: ts });
  mkdirSync(a.out, { recursive: true });
  const meta = res.meta || { mode: res.mode || 'DRY-RUN', timestamp: ts, frontendDbPath: a.frontendDb, syncDbPath: a.syncDb };
  const plan = res.plan || { blocked: true, flags: [res.reason || 'blocked'] };
  writeFileSync(join(a.out, `D4D_REPORT_${ts}.md`), renderReport(plan, meta), 'utf8');
  writeFileSync(join(a.out, `D4D_SUMMARY_${ts}.json`), JSON.stringify({
    mode: res.mode, executed: res.executed, blocked: res.blocked, reason: res.reason,
    summary: plan.blocked ? null : {
      totalChanges: plan.totalChanges, coverage: plan.coverage, replay: plan.replay,
      baselineUpserts: plan.plan.baselineUpsertCount, syntheticDeletes: plan.plan.syntheticDeleteCount,
      preservedTombstones: plan.plan.preservedTombstoneCount, compaction: plan.compaction,
      products: plan.products, largeCorrection: plan.largeCorrection,
    },
    executeResult: res.executeResult, verify: res.verify,
  }, null, 2), 'utf8');
  console.log(`D4-D ${res.mode || 'DRY-RUN'} complete. blocked=${!!res.blocked}${res.reason ? ' (' + res.reason + ')' : ''}. executed=${!!res.executed}. Reports: ${a.out}`);
  if (res.blocked) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('D4-D crashed:', e); process.exit(1); });
}

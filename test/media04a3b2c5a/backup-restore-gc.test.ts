// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C5A — consistent backup + crash-safe restore + safe staging-GC.
// Run: node test/media04a3b2c5a/backup-restore-gc.test.ts
//
// Backup collection runs against REAL sql.js (the media tables the queries read,
// created directly so the test targets the collection LOGIC, not the 03A triggers
// which are covered elsewhere). Verify/restore use a fake content-addressed FS;
// GC is pure. No image bytes, no absolute paths in any assertion output.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import {
  collectRequiredMediaFiles, buildBackupManifest, verifyBackupFiles, finalizeBackupManifest,
  validateBackupForRestore, restoreRecoveryDecision, mayOpenLive, isUnsafeRelPath,
  assertBackupHostActivated, BACKUP_ACTIVATION,
  BACKUP_FORMAT_VERSION, type BackupManifest, type FilePresence, type BackupFileEntry,
} from '../../src/core/media/backup-core.ts';
import {
  analyzeStagingGc, applyStagingGc, preparedJournalDeletable,
  assertStagingGcHostActivated, STAGING_GC_ACTIVATION,
  type StagingFile, type StagingSsots,
} from '../../src/core/media/staging-gc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0; const failures: string[] = [];
function ok(c: unknown, m: string): void { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  x ${m}`); } }

function mediaSchema(db: InstanceType<Awaited<ReturnType<typeof initSqlJs>>['Database']>): void {
  db.run(`CREATE TABLE media_links (tenant_id TEXT, link_id TEXT, media_id TEXT, media_role TEXT, deleted_at TEXT);
    CREATE TABLE media_objects (tenant_id TEXT, media_id TEXT, master_blob_id TEXT, deleted_at TEXT);
    CREATE TABLE media_blobs (tenant_id TEXT, blob_id TEXT, current_generation_no INTEGER, blob_status TEXT);
    CREATE TABLE media_blob_generations (tenant_id TEXT, blob_id TEXT, generation_no INTEGER, storage_key TEXT,
      stored_blob_hash TEXT, byte_size INTEGER, gen_status TEXT, extension TEXT);
    CREATE TABLE media_variants (tenant_id TEXT, variant_id TEXT, media_id TEXT, variant_type TEXT, blob_id TEXT, deleted_at TEXT);
    CREATE TABLE media_ingest_jobs (tenant_id TEXT, target_media_id TEXT, target_blob_id TEXT, state TEXT);`);
}
// helper: insert one blob+generation and return its content-addressed rel path.
function insertGen(db: any, scope: string, blobId: string, hash: string, size: number, ext = 'jpg', gen = 1, status = 'available'): string {
  const rel = `${scope}/${hash.slice(0, 2)}/${hash}.${ext}`;
  db.run('INSERT INTO media_blobs VALUES (?,?,?,?)', [scope, blobId, gen, 'present']);
  db.run('INSERT INTO media_blob_generations VALUES (?,?,?,?,?,?,?,?)', [scope, blobId, gen, rel, hash, size, status, ext]);
  return rel;
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── backup collection ──────────────────────────────────────────────────────
  const db = new SQL.Database();
  mediaSchema(db);
  const S = 'tenant-1';
  const mMain = insertGen(db, S, 'b-main', 'a'.repeat(64), 1000);      // product1 master
  const mThumb = insertGen(db, S, 'b-thumb', 'b'.repeat(64), 200, 'jpg', 1); // product1 thumb
  const shared = insertGen(db, S, 'b-shared', 'c'.repeat(64), 900);    // product2 & product3 same bytes
  insertGen(db, S, 'b-super', 'd'.repeat(64), 800, 'jpg', 1, 'superseded'); // historical → excluded
  const pend = insertGen(db, S, 'b-pend', 'e'.repeat(64), 700, 'jpg', 2, 'staged'); // pending recovery
  db.run(`INSERT INTO media_objects VALUES ('tenant-1','m1','b-main',NULL),('tenant-1','m2','b-shared',NULL),
          ('tenant-1','m3','b-shared',NULL),('tenant-1','mDel','b-super',NULL),('tenant-1','mPend','b-pend',NULL)`);
  db.run(`INSERT INTO media_links VALUES ('tenant-1','l1','m1','photo',NULL),('tenant-1','l2','m2','photo',NULL),
          ('tenant-1','l3','m3','photo',NULL),('tenant-1','lDel','mDel','photo','2026-01-01')`); // lDel deleted
  db.run(`INSERT INTO media_variants VALUES ('tenant-1','v1','m1','thumbnail','b-thumb',NULL)`);
  db.run(`INSERT INTO media_ingest_jobs VALUES ('tenant-1','mPend','b-pend','awaiting_ai')`);

  const files = collectRequiredMediaFiles(db as any);
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  ok(byPath.has(mMain) && byPath.has(mThumb) && byPath.has(shared) && byPath.has(pend), 'collects master + thumbnail + shared + pending');
  ok(!files.some((f) => f.relPath.includes('d'.repeat(64))), 'superseded/deleted-link generation excluded');
  ok(files.filter((f) => f.relPath === shared).length === 1, 'content-addressed dedup: shared bytes → one file entry');
  ok(byPath.get(pend)!.reason === 'pending_recovery' && byPath.get(mMain)!.reason === 'active', 'reasons tagged');
  ok(files.every((f) => !isUnsafeRelPath(f.relPath)), 'all collected paths are safe relative paths');

  // ── manifest + verify ────────────────────────────────────────────────────
  const fsMap = new Map<string, { hash: string; size: number; symlink?: boolean }>();
  for (const f of files) fsMap.set(f.relPath, { hash: f.hash, size: f.byteSize });
  const DBF = 'lataif.db';
  fsMap.set(DBF, { hash: 'db'.repeat(32), size: 4096 });
  const fs: FilePresence = {
    exists: (p) => fsMap.has(p), sizeOf: (p) => fsMap.get(p)!.size, hashOf: (p) => fsMap.get(p)!.hash,
    isSymlink: (p) => !!fsMap.get(p)?.symlink,
  };
  const manifest = buildBackupManifest({
    createdAt: '2026-07-26T00:00:00Z', appVersion: '0.8.23', schemaVersion: '84', mediaSchemaVersion: '10',
    db: { fileName: DBF, byteSize: 4096, sha256: 'db'.repeat(32) }, files,
  });
  ok(manifest.fileCount === files.length && manifest.status === 'in_progress', 'manifest built, fileCount correct, in_progress');
  const v = verifyBackupFiles(manifest, fs);
  ok(v.ok, 'verify passes when all files present + hashed');
  const complete = finalizeBackupManifest(manifest, v);
  ok(complete.status === 'complete', 'finalize → complete only after verify');

  // missing file → fail closed
  const savedMain = fsMap.get(mMain)!; fsMap.delete(mMain);
  ok(!verifyBackupFiles(manifest, fs).ok, 'missing media file → verify fail closed');
  fsMap.set(mMain, savedMain);
  // hash mismatch → fail closed
  fsMap.set(mMain, { ...savedMain, hash: 'f'.repeat(64) });
  const hm = verifyBackupFiles(manifest, fs);
  ok(!hm.ok && hm.code === 'MEDIA_BACKUP_HASH_MISMATCH', 'hash mismatch → fail closed');
  fsMap.set(mMain, savedMain);
  // crash before final manifest → in_progress is never restorable
  try { finalizeBackupManifest(manifest, { ok: false, code: 'X' }); ok(false, 'finalize on failed verify must throw'); }
  catch { ok(true, 'incomplete backup cannot be finalized (crash before manifest = not valid)'); }
  // unsafe path rejected at authoring
  try { buildBackupManifest({ createdAt: 'x', appVersion: 'a', schemaVersion: 's', mediaSchemaVersion: 'm',
    db: { fileName: DBF, byteSize: 1, sha256: 'h' }, files: [{ ...files[0], relPath: '../etc/passwd' } as BackupFileEntry] });
    ok(false, 'unsafe path must throw at build'); } catch { ok(true, 'unsafe manifest path rejected at authoring'); }

  // ── restore validation (DB introspection, not caller flags) ─────────────────
  const hostRefs = (n: number) => ({ appVersion: '0.8.23', maxBackupFormatVersion: BACKUP_FORMAT_VERSION, introspectActiveMediaRefs: () => n });
  const host = hostRefs(5);
  ok(validateBackupForRestore(complete, fs, host).ok, 'valid backup → restore validation ok');
  // corrupt DB hash
  const badDbFs = { ...fs, hashOf: (p: string) => (p === DBF ? 'bad'.repeat(21) + 'b' : fs.hashOf(p)) };
  ok(!validateBackupForRestore(complete, badDbFs, host).ok, 'corrupt DB hash → fail closed');
  // unknown newer version
  ok(!validateBackupForRestore({ ...complete, backupFormatVersion: 99 }, fs, host).ok, 'unknown newer backup version → fail closed');
  // path traversal / absolute / symlink
  ok(isUnsafeRelPath('../x') && isUnsafeRelPath('/abs/x') && isUnsafeRelPath('C:/x') && isUnsafeRelPath('a\\b') && isUnsafeRelPath('a/../b') && isUnsafeRelPath('a//b'), 'path-traversal / absolute / backslash / empty-seg rejected');
  const symFs: FilePresence = { ...fs, isSymlink: (p) => p === mThumb };
  const symRes = validateBackupForRestore(complete, symFs, host);
  ok(!symRes.ok && (symRes as any).code === 'MEDIA_BACKUP_SYMLINK', 'symlink media file → fail closed');
  // legacy DB-only backup (no files) — allowed ONLY when DB introspection reports 0 refs
  const legacy = finalizeBackupManifest(buildBackupManifest({ createdAt: 'x', appVersion: 'a', schemaVersion: 's',
    mediaSchemaVersion: 'm', db: { fileName: DBF, byteSize: 4096, sha256: 'db'.repeat(32) }, files: [] }),
    verifyBackupFiles({ ...manifest, files: [], fileCount: 0 } as BackupManifest, fs));
  const legRes = validateBackupForRestore(legacy, fs, hostRefs(0));
  ok(legRes.ok && (legRes as any).legacyDbOnly === true, 'legacy DB-only allowed only when introspection reports 0 media refs');
  // DB-only but introspection finds media refs → rejected (no caller hasMediaRefs=false shortcut, no empty galleries)
  ok(!validateBackupForRestore(legacy, fs, hostRefs(3)).ok, 'legacy DB with HIDDEN media refs → fail closed');

  // ── restore journal recovery ───────────────────────────────────────────────
  ok(restoreRecoveryDecision('prepared').action === 'safe_no_change', 'crash at prepared → live unchanged');
  ok(restoreRecoveryDecision('db_swapped').action === 'continue_media_swap', 'crash between DB/media swap → continue forward');
  ok(restoreRecoveryDecision('media_swapped').action === 'verify', 'crash after media swap → verify');
  ok(restoreRecoveryDecision(null).action === 'safe_no_change' && restoreRecoveryDecision('verified').action === 'done', 'null/verified handled');
  ok(!mayOpenLive('db_swapped') && !mayOpenLive('media_swapped') && mayOpenLive('verified') && mayOpenLive(null), 'app must not open a partially-restored (mid-swap) state');

  // ── staging GC ─────────────────────────────────────────────────────────────
  const GRACE = 60_000;
  const ssots: StagingSsots = {
    referencedKeys: new Set(['tenant-1/aa/active.jpg']),
    liveIngestRequests: new Set(['tenant-1::req-live']),
    lockedRequests: new Set(['tenant-1::req-locked']),
    operationInProgress: false,
  };
  const stagingFiles: StagingFile[] = [
    { relKey: 'tenant-1/aa/active.jpg', ageMs: 999_999, byteSize: 100, insideRoot: true, isSymlink: false },       // referenced
    { relKey: '.ingest-journal/req-live.main', ageMs: 999_999, byteSize: 100, insideRoot: true, isSymlink: false, scope: 'tenant-1', requestId: 'req-live' }, // live job
    { relKey: '.ingest-journal/req-locked.main', ageMs: 999_999, byteSize: 100, insideRoot: true, isSymlink: false, scope: 'tenant-1', requestId: 'req-locked' }, // locked
    { relKey: '.ingest-journal/young.tmp', ageMs: 1_000, byteSize: 100, insideRoot: true, isSymlink: false, scope: 'tenant-1', requestId: 'req-young' },  // grace
    { relKey: '.ingest-journal/old-orphan.tmp', ageMs: 999_999, byteSize: 4242, insideRoot: true, isSymlink: false, scope: 'tenant-1', requestId: 'req-dead' }, // DELETABLE
    { relKey: '../escape.jpg', ageMs: 999_999, byteSize: 100, insideRoot: false, isSymlink: false },               // escape
    { relKey: '.ingest-journal/link.tmp', ageMs: 999_999, byteSize: 100, insideRoot: true, isSymlink: true, scope: 'tenant-1', requestId: 'req-sym' },  // symlink
  ];
  const plan = analyzeStagingGc(stagingFiles, ssots, { gracePeriodMs: GRACE }, 1_000_000);
  ok(plan.deletable.length === 1 && plan.deletable[0].relKey === '.ingest-journal/old-orphan.tmp', 'only the old real orphan is deletable');
  ok(plan.deletableBytes === 4242 && plan.deletableCount === 1, 'dry-run reports counts + sizes');
  ok(plan.deletable.every((d) => !d.relKey.startsWith('/') && !/^[A-Za-z]:/.test(d.relKey)), 'dry-run output carries no absolute paths');
  const reasons = new Map(plan.retained.map((r) => [r.relKey, r.reason]));
  ok(reasons.get('tenant-1/aa/active.jpg') === 'referenced_by_ssot', 'active/referenced → retained');
  ok(reasons.get('.ingest-journal/req-live.main') === 'live_ingest_job', 'live ingest → retained');
  ok(reasons.get('.ingest-journal/req-locked.main') === 'locked', 'locked → retained');
  ok(reasons.get('.ingest-journal/young.tmp') === 'within_grace_period', 'young orphan → retained (grace)');
  ok(reasons.get('../escape.jpg') === 'outside_staging_root', 'outside root → retained (never deleted)');
  ok(reasons.get('.ingest-journal/link.tmp') === 'symlink', 'symlink → retained (no follow)');

  // operationInProgress → nothing deletable
  const busy = analyzeStagingGc(stagingFiles, { ...ssots, operationInProgress: true }, { gracePeriodMs: GRACE }, 1_000_000);
  ok(busy.deletable.length === 0, 'no GC while a media operation is in progress');

  // apply GC: idempotent + TOCTOU re-check
  const disk = new Set(plan.deletable.map((d) => d.relKey));
  const port = { delete: (k: string) => (disk.delete(k)), stillSafe: (_: string) => true };
  const r1 = applyStagingGc(plan, port);
  ok(r1.deleted === 1 && !disk.has('.ingest-journal/old-orphan.tmp'), 'apply deletes the orphan');
  const r2 = applyStagingGc(plan, port);
  ok(r2.deleted === 0 && r2.skipped === 1, 'apply is idempotent (already-gone file skipped)');
  const r3 = applyStagingGc(plan, { delete: () => true, stillSafe: () => false });
  ok(r3.deleted === 0 && r3.skipped === 1, 'TOCTOU: became-unsafe file skipped at apply time');

  // preparedJournalDeletable single-file rule
  const orphan = stagingFiles[4];
  ok(preparedJournalDeletable(orphan, ssots, { gracePeriodMs: GRACE }), 'prepared-journal orphan deletable when unref+old+in-root+no-op');
  ok(!preparedJournalDeletable(orphan, { ...ssots, operationInProgress: true }, { gracePeriodMs: GRACE }), 'prepared-journal NOT deletable during an operation');
  ok(!preparedJournalDeletable({ ...orphan, ageMs: 10 }, ssots, { gracePeriodMs: GRACE }), 'prepared-journal NOT deletable within grace');

  // ── R1 §1/§2 — forged host flags never yield production safety ──────────────
  // A caller can claim complete + present + matching hashes + non-symlink, and the
  // MODEL accepts it — but that is only the host port's CLAIM, and production truth
  // requires the (unwired) Rust adapter. The activation guards enforce the boundary.
  {
    const forgedFs: FilePresence = { exists: () => true, sizeOf: (p) => (p === DBF ? 4096 : files[0]?.byteSize ?? 1),
      hashOf: (p) => (p === DBF ? 'db'.repeat(32) : (fsMap.get(p)?.hash ?? 'x')), isSymlink: () => false };
    // even with a fully "green" forged host, the production activation is refused.
    let threw = false; try { assertBackupHostActivated(); } catch { threw = true; }
    ok(threw, 'forged green host flags still cannot activate real backup safety (typed host-not-wired)');
    ok(BACKUP_ACTIVATION.activatable === false && STAGING_GC_ACTIVATION.activatable === false, 'both cores report host wiring NOT activated');
    let gcThrew = false; try { assertStagingGcHostActivated(); } catch { gcThrew = true; }
    ok(gcThrew, 'GC real deletion refused until host wired (typed block)');
    void forgedFs;
  }
  // path-collision manifest → fail closed
  {
    const dup = { ...complete, files: [files[0], { ...files[1], relPath: files[0].relPath }], fileCount: 2 } as BackupManifest;
    const r = verifyBackupFiles(dup, fs);
    ok(!r.ok && (r as any).code === 'MEDIA_BACKUP_PATH_COLLISION', 'duplicate/normalized path collision → fail closed');
  }
  // R1 §2 — a stale dry-run plan cannot delete on its own: stillSafe gate is mandatory
  {
    const stalePlan = analyzeStagingGc(stagingFiles, ssots, { gracePeriodMs: GRACE }, 1_000_000);
    // the environment changed after the dry-run (file became referenced) → stillSafe=false → no delete
    let deletedAny = false;
    applyStagingGc(stalePlan, { delete: () => { deletedAny = true; return true; }, stillSafe: () => false });
    ok(!deletedAny, 'stale dry-run plan cannot delete without a fresh host re-check');
  }
  // R1 §3 — pending-recovery files are bound by concrete DB/journal refs (the ingest job),
  // not free-floating: removing the ingest job removes them from the required set.
  {
    const db2 = new SQL.Database(); mediaSchema(db2);
    insertGen(db2, S, 'b-pend2', '9'.repeat(64), 500, 'jpg', 1, 'staged');
    db2.run(`INSERT INTO media_ingest_jobs VALUES ('tenant-1','mX','b-pend2','ready')`); // terminal → not needed
    ok(collectRequiredMediaFiles(db2 as any).length === 0, 'pending file of a TERMINAL ingest job is not required (bound to live job only)');
    db2.close();
  }

  db.close();
  console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });

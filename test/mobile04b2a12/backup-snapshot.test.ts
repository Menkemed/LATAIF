// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-I1 — consistent DB+media snapshot (unit + REAL isolated node-fs smoke)
// Run: node test/mobile04b2a12/backup-snapshot.test.ts
//
// §A unit (fake host): manifest integrity + fail-closed on unsafe/symlink/missing/changed/count.
// §B real smoke: a real sql.js media DB + a real temp media root of content-addressed files → the
// orchestrator publishes a complete manifest with correct hashes and every referenced media file; a
// corrupted / missing / symlinked input fails closed and publishes nothing. All under os.tmpdir()
// (production data is never touched).
// ════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, lstatSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  createConsistentSnapshot, type SnapshotHost, type SnapshotMeta,
} from '../../src/core/media/backup-snapshot.ts';
import { verifyBackupFiles, buildBackupManifest, type FilePresence } from '../../src/core/media/backup-core.ts';

const require = createRequire('E:/software/lataif/desktop/package.json');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const here = dirname(fileURLToPath(import.meta.url));
let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log(`  ✗ ${m}`); } };
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new Uint8Array(Buffer.from(s));
const META = (finalDir: string): SnapshotMeta => ({ createdAt: '2026-07-30T00:00:00Z', appVersion: '0.8.23', schemaVersion: 's1', mediaSchemaVersion: 'm1', finalDir });

// ── §A — fail-closed at the verify layer (deterministic, no real fs) ─────────
{
  const files = [{ relPath: 'tenant-1/ab/abcd.jpg', hash: 'H', byteSize: 3, mediaId: 'm', generationNo: 1, variantType: null, role: 'stock_image', scope: 'tenant-1', reason: 'active' as const }];
  const dbEntry = { fileName: 'lataif.db', byteSize: 2, sha256: 'DBH' };
  const okPresence: FilePresence = { exists: () => true, sizeOf: (p) => (p === 'lataif.db' ? 2 : 3), hashOf: (p) => (p === 'lataif.db' ? 'DBH' : 'H'), isSymlink: () => false };
  const m = buildBackupManifest({ ...META('x'), db: dbEntry, additionalDbFiles: [{ fileName: 'lataif_sync_server.db', byteSize: 4, sha256: 'SH' }], files });
  ok(m.status === 'in_progress' && m.fileCount === 1 && m.additionalDbFiles?.length === 1, 'manifest authored in_progress with media + additional server DB');
  const serverOk: FilePresence = { ...okPresence, sizeOf: (p) => (p === 'lataif.db' ? 2 : p === 'lataif_sync_server.db' ? 4 : 3), hashOf: (p) => (p === 'lataif.db' ? 'DBH' : p === 'lataif_sync_server.db' ? 'SH' : 'H') };
  ok(verifyBackupFiles(m, serverOk).ok === true, 'verify passes when every media + DB file matches');
  ok((verifyBackupFiles(m, { ...serverOk, exists: (p) => p !== 'lataif_sync_server.db' }) as any).code === 'MEDIA_BACKUP_DB_MISSING', 'missing server DB → fail closed');
  ok((verifyBackupFiles(m, { ...serverOk, hashOf: (p) => (p === 'tenant-1/ab/abcd.jpg' ? 'WRONG' : serverOk.hashOf(p)) }) as any).code === 'MEDIA_BACKUP_HASH_MISMATCH', 'media hash mismatch → fail closed');
  ok((verifyBackupFiles(m, { ...serverOk, isSymlink: (p) => p === 'tenant-1/ab/abcd.jpg' }) as any).code === 'MEDIA_BACKUP_SYMLINK', 'symlinked media file → fail closed');
}

// ── §B — REAL isolated node-fs smoke ─────────────────────────────────────────
const SQL = await initSqlJs();
const MEDIA_SCHEMA = `
CREATE TABLE media_links(tenant_id TEXT,media_id TEXT,media_role TEXT,deleted_at TEXT);
CREATE TABLE media_objects(tenant_id TEXT,media_id TEXT,master_blob_id TEXT,deleted_at TEXT);
CREATE TABLE media_blobs(tenant_id TEXT,blob_id TEXT,blob_status TEXT,current_generation_no INTEGER);
CREATE TABLE media_blob_generations(tenant_id TEXT,blob_id TEXT,generation_no INTEGER,gen_status TEXT,storage_key TEXT,stored_blob_hash TEXT,byte_size INTEGER,extension TEXT);
CREATE TABLE media_variants(tenant_id TEXT,media_id TEXT,variant_type TEXT,blob_id TEXT,deleted_at TEXT);
CREATE TABLE media_ingest_jobs(tenant_id TEXT,target_media_id TEXT,target_blob_id TEXT,state TEXT);`;

function relPathFor(scope: string, hash: string, ext: string) { return `${scope}/${hash.slice(0, 2)}/${hash}.${ext}`; }

// Build a real media DB (one product link: a master + a thumbnail variant) + the real files on disk.
function seedRealMedia(root: string) {
  const db = new SQL.Database(); db.run(MEDIA_SCHEMA);
  const scope = 'tenant-1'; const media = 'media-1';
  const masterBytes = enc('MASTER-IMAGE-BYTES'); const thumbBytes = enc('THUMB-BYTES');
  const mh = sha256(masterBytes), th = sha256(thumbBytes);
  const mRel = relPathFor(scope, mh, 'jpg'), tRel = relPathFor(scope, th, 'jpg');
  db.run(`INSERT INTO media_links VALUES(?,?,?,NULL)`, [scope, media, 'stock_image']);
  db.run(`INSERT INTO media_objects VALUES(?,?,?,NULL)`, [scope, media, 'blob-m']);
  db.run(`INSERT INTO media_blobs VALUES(?,?, 'present', 1)`, [scope, 'blob-m']);
  db.run(`INSERT INTO media_blob_generations VALUES(?,?,1,'available',?,?,?, 'jpg')`, [scope, 'blob-m', mRel, mh, masterBytes.length]);
  db.run(`INSERT INTO media_variants VALUES(?,?, 'thumbnail','blob-t',NULL)`, [scope, media]);
  db.run(`INSERT INTO media_blobs VALUES(?,?, 'present', 1)`, [scope, 'blob-t']);
  db.run(`INSERT INTO media_blob_generations VALUES(?,?,1,'available',?,?,?, 'jpg')`, [scope, 'blob-t', tRel, th, thumbBytes.length]);
  const dbBytes = new Uint8Array(db.export()); db.close();
  for (const [rel, bytes] of [[mRel, masterBytes], [tRel, thumbBytes]] as [string, Uint8Array][]) {
    const abs = join(root, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, bytes);
  }
  return { dbBytes, mRel, tRel, mh, th };
}

// A real node-fs SnapshotHost over (mediaRoot, workspace/final parent).
function nodeHost(mediaRoot: string, dbBytes: Uint8Array, tmpBase: string): SnapshotHost {
  const safeAbs = (relPath: string) => {
    if (relPath.includes('..') || relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/')) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
    const abs = join(mediaRoot, relPath);
    if (!abs.startsWith(mediaRoot)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH'); // root containment
    return abs;
  };
  const presence = (base: string): FilePresence => ({
    exists: (p) => existsSync(join(base, p)),
    sizeOf: (p) => statSync(join(base, p)).size,
    hashOf: (p) => sha256(new Uint8Array(readFileSync(join(base, p)))),
    isSymlink: (p) => { try { return lstatSync(join(base, p)).isSymbolicLink(); } catch { return false; } },
  });
  return {
    acquireLease: async () => ({ release() {} }),
    snapshotFrontendDb: async () => ({ fileName: 'lataif.db', bytes: dbBytes }),
    snapshotServerDbs: async () => [{ fileName: 'lataif_sync_server.db', bytes: enc('SERVER-DB-BYTES-checkpointed') }],
    openMediaQuery: async (bytes) => { const d = new SQL.Database(bytes); return { exec: (sql: string, params?: unknown[]) => d.exec(sql, params as any), close: () => d.close() }; },
    isSymlink: async (relPath) => { try { return lstatSync(safeAbs(relPath)).isSymbolicLink(); } catch { return false; } },
    readMediaFile: async (relPath) => { const abs = safeAbs(relPath); if (!existsSync(abs)) throw new Error('MEDIA_BACKUP_FILE_MISSING'); if (lstatSync(abs).isSymbolicLink()) throw new Error('MEDIA_BACKUP_SYMLINK'); return new Uint8Array(readFileSync(abs)); },
    sha256,
    createWorkspace: async () => mkdtempSync(join(tmpBase, 'ws-')),
    writeIntoWorkspace: async (ws, rel, bytes) => { const abs = join(ws, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, bytes); },
    writeManifest: async (ws, manifest) => writeFileSync(join(ws, 'manifest.json'), JSON.stringify(manifest)),
    workspacePresence: (ws) => presence(ws),
    publishAtomically: async (ws, finalDir) => { const { renameSync } = require('node:fs'); renameSync(ws, finalDir); },
    discardWorkspace: async (ws) => rmSync(ws, { recursive: true, force: true }),
  };
}

async function withRoot(fn: (root: string, seeded: ReturnType<typeof seedRealMedia>, finalDir: string, tmpBase: string) => Promise<void>) {
  const tmpBase = mkdtempSync(join(os.tmpdir(), 'a12-'));
  const root = join(tmpBase, 'media'); mkdirSync(root, { recursive: true });
  const seeded = seedRealMedia(root);
  const finalDir = join(tmpBase, 'backup-final');
  try { await fn(root, seeded, finalDir, tmpBase); } finally { rmSync(tmpBase, { recursive: true, force: true }); }
}

// B1 — happy path: complete manifest, hashes, every media file present.
await withRoot(async (root, seeded, finalDir, tmpBase) => {
  const m = await createConsistentSnapshot(nodeHost(root, seeded.dbBytes, tmpBase), META(finalDir));
  ok(m.status === 'complete', 'B1 published manifest is complete');
  ok(m.fileCount === 2 && m.files.length === 2, 'B1 manifest holds both media files (master + thumbnail)');
  ok(m.additionalDbFiles?.length === 1, 'B1 manifest holds the checkpointed server DB');
  ok(existsSync(join(finalDir, 'lataif.db')) && existsSync(join(finalDir, 'lataif_sync_server.db')) && existsSync(join(finalDir, 'manifest.json')), 'B1 DB files + manifest published');
  ok(existsSync(join(finalDir, seeded.mRel)) && existsSync(join(finalDir, seeded.tRel)), 'B1 both referenced media files copied into the backup');
  ok(sha256(new Uint8Array(readFileSync(join(finalDir, seeded.mRel)))) === seeded.mh, 'B1 copied master hashes to its content address');
  ok(m.files.every((f) => f.hash === sha256(new Uint8Array(readFileSync(join(finalDir, f.relPath))))), 'B1 every manifest hash matches the copied bytes');
});

// B2 — a media file changed/corrupted since the DB snapshot → whole backup aborts, nothing published.
await withRoot(async (root, seeded, finalDir, tmpBase) => {
  writeFileSync(join(root, seeded.mRel), enc('TAMPERED-DIFFERENT-BYTES'));
  let code = '';
  try { await createConsistentSnapshot(nodeHost(root, seeded.dbBytes, tmpBase), META(finalDir)); } catch (e) { code = String((e as Error).message); }
  ok(code === 'MEDIA_BACKUP_FILE_CHANGED', 'B2 corrupted/changed media → MEDIA_BACKUP_FILE_CHANGED');
  ok(!existsSync(finalDir), 'B2 nothing published (fail-closed)');
});

// B3 — a referenced media file missing → abort, nothing published.
await withRoot(async (root, seeded, finalDir, tmpBase) => {
  rmSync(join(root, seeded.tRel));
  let code = '';
  try { await createConsistentSnapshot(nodeHost(root, seeded.dbBytes, tmpBase), META(finalDir)); } catch (e) { code = String((e as Error).message); }
  ok(code === 'MEDIA_BACKUP_FILE_MISSING', 'B3 missing referenced media → MEDIA_BACKUP_FILE_MISSING');
  ok(!existsSync(finalDir), 'B3 nothing published (fail-closed)');
});

// B4 — a symlinked media file → abort (best-effort: needs OS symlink perms; else covered by §A).
await withRoot(async (root, seeded, finalDir, tmpBase) => {
  let symlinked = false;
  try { rmSync(join(root, seeded.mRel)); symlinkSync(join(root, seeded.tRel), join(root, seeded.mRel)); symlinked = lstatSync(join(root, seeded.mRel)).isSymbolicLink(); } catch { symlinked = false; }
  if (!symlinked) { ok(true, 'B4 skipped (no OS symlink perm) — symlink rejection covered by §A + adapter lstat'); return; }
  let code = '';
  try { await createConsistentSnapshot(nodeHost(root, seeded.dbBytes, tmpBase), META(finalDir)); } catch (e) { code = String((e as Error).message); }
  ok(code === 'MEDIA_BACKUP_SYMLINK', 'B4 symlinked media → MEDIA_BACKUP_SYMLINK');
  ok(!existsSync(finalDir), 'B4 nothing published (fail-closed)');
});

console.log(`\nMOBILE-04B2A12-I1 backup-snapshot: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04B2A12-I1 — consistent DB + media backup SNAPSHOT orchestrator.
//
// Activates the dormant `backup-core` model through an INJECTED host port. The
// orchestration (order, consistency, fail-closed, atomic publish) lives here and
// is unit-testable under node with an in-memory host; the REAL isolated smoke
// drives it with a node-fs adapter over a real temp media root + a real sql.js DB.
// No production wiring here (the pre-destructive DB backup is untouched) — that
// integration is a reviewed follow-up.
//
// Consistency contract:
//   • the WHOLE snapshot runs under ONE read/backup lease (no mixed DB/media
//     version): the frontend DB is exported, the server DB(s) are checkpointed,
//     and the required media files are read — all pinned to that lease,
//   • the required files come from `collectRequiredMediaFiles` over the SAME
//     exported DB (active gallery links' masters + current variants + durable
//     pending-recovery generations); staging/orphan files are never read,
//   • every media file is read SAFELY (the adapter canonicalizes + enforces
//     root-containment + rejects symlinks) and must hash to its content address —
//     a missing/changed/corrupt file aborts the WHOLE backup,
//   • a temp workspace is written, VERIFIED (re-hash), finalized to `complete`,
//     and only then atomically published; any failure discards the workspace and
//     publishes nothing (the manifest never leaves `in_progress`).
//
// Never logs image bytes / content paths.
// ════════════════════════════════════════════════════════════════════════════

import {
  type BackupManifest, type BackupDbFileEntry, type BackupFileEntry, type FilePresence, type MediaDbQuery,
  buildBackupManifest, collectRequiredMediaFiles, finalizeBackupManifest, isUnsafeRelPath, verifyBackupFiles,
} from './backup-core.ts';

/** A DB (or media) file the host produced for the snapshot. */
export interface SnapshotBytes { fileName: string; bytes: Uint8Array }

/** The host operations a real snapshot needs. Injected so the orchestrator stays
 *  framework-free; the production impl is Rust/Tauri-backed, tests use fakes/node-fs. */
export interface SnapshotHost {
  /** Acquire a read/backup lease pinning a single point-in-time for the whole run. */
  acquireLease(): Promise<{ release(): void | Promise<void> }>;
  /** The frontend DB (`lataif.db`) as a consistent byte snapshot under the lease. */
  snapshotFrontendDb(): Promise<SnapshotBytes>;
  /** The server DB file(s) after a safe WAL checkpoint; [] when no server DB exists. */
  snapshotServerDbs(): Promise<SnapshotBytes[]>;
  /** A read-only query over the SAME exported frontend DB (for required-file selection). */
  openMediaQuery(frontendDbBytes: Uint8Array): Promise<MediaDbQuery & { close?(): void }>;
  /** True iff the media-root path for `relPath` is a symlink (rejected). */
  isSymlink(relPath: string): Promise<boolean>;
  /** Read one content-addressed media file SAFELY (canonicalize + root-containment).
   *  Throws `MEDIA_BACKUP_FILE_MISSING` / `MEDIA_BACKUP_SYMLINK` / `MEDIA_BACKUP_UNSAFE_PATH`. */
  readMediaFile(relPath: string): Promise<Uint8Array>;
  sha256(bytes: Uint8Array): string;
  /** Create a fresh temp workspace directory (isolated from the final location). */
  createWorkspace(): Promise<string>;
  writeIntoWorkspace(ws: string, relName: string, bytes: Uint8Array): Promise<void>;
  writeManifest(ws: string, manifest: BackupManifest): Promise<void>;
  /** Presence port over the workspace copies (for the pre-publish re-verify). */
  workspacePresence(ws: string): FilePresence;
  /** Atomically move the finished workspace to `finalDir` (temp + rename). */
  publishAtomically(ws: string, finalDir: string): Promise<void>;
  discardWorkspace(ws: string): Promise<void>;
}

export interface SnapshotMeta {
  createdAt: string;            // metadata only — passed in, never derived here
  appVersion: string;
  schemaVersion: string;
  mediaSchemaVersion: string;
  /** The final published backup directory. */
  finalDir: string;
}

function hashEntry(host: SnapshotHost, s: SnapshotBytes): BackupDbFileEntry {
  if (isUnsafeRelPath(s.fileName)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
  return { fileName: s.fileName, byteSize: s.bytes.length, sha256: host.sha256(s.bytes) };
}

/**
 * Create a consistent DB + media snapshot. Returns the `complete` manifest on
 * success; throws (publishing nothing) on any inconsistency. Fail-closed.
 */
export async function createConsistentSnapshot(host: SnapshotHost, meta: SnapshotMeta): Promise<BackupManifest> {
  const lease = await host.acquireLease();
  let ws: string | null = null;
  try {
    // ── 1. consistent DB snapshots under the lease ──
    const front = await host.snapshotFrontendDb();
    const dbEntry = hashEntry(host, front);
    const servers = await host.snapshotServerDbs();
    const additionalDbFiles = servers.map((s) => hashEntry(host, s));

    // ── 2. required media files from the SAME exported DB ──
    const q = await host.openMediaQuery(front.bytes);
    let files: BackupFileEntry[];
    try { files = collectRequiredMediaFiles(q); } finally { q.close?.(); }

    // ── 3. stage everything into a temp workspace ──
    ws = await host.createWorkspace();
    await host.writeIntoWorkspace(ws, front.fileName, front.bytes);
    for (const s of servers) await host.writeIntoWorkspace(ws, s.fileName, s.bytes);

    for (const f of files) {
      if (isUnsafeRelPath(f.relPath)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
      if (await host.isSymlink(f.relPath)) { const e = new Error('MEDIA_BACKUP_SYMLINK'); throw e; }
      const bytes = await host.readMediaFile(f.relPath);           // safe read (throws on missing/unsafe)
      // Content-addressed: the file MUST hash to its declared address + size. A
      // mismatch = corrupt OR changed during the snapshot → abort the whole backup.
      if (bytes.length !== f.byteSize || host.sha256(bytes) !== f.hash) throw new Error('MEDIA_BACKUP_FILE_CHANGED');
      await host.writeIntoWorkspace(ws, f.relPath, bytes);
    }

    // ── 4. author manifest, RE-VERIFY the staged copies, finalize, publish ──
    const manifest = buildBackupManifest({
      createdAt: meta.createdAt, appVersion: meta.appVersion,
      schemaVersion: meta.schemaVersion, mediaSchemaVersion: meta.mediaSchemaVersion,
      db: dbEntry, additionalDbFiles, files,
    });
    const verify = verifyBackupFiles(manifest, host.workspacePresence(ws));
    if (!verify.ok) throw new Error(verify.code);                  // staged copy mismatch → fail closed
    const complete = finalizeBackupManifest(manifest, verify);     // status → complete ONLY now
    await host.writeManifest(ws, complete);
    await host.publishAtomically(ws, meta.finalDir);               // atomic; nothing half-published
    ws = null;                                                     // published — do not discard
    return complete;
  } finally {
    if (ws) { try { await host.discardWorkspace(ws); } catch { /* best-effort cleanup */ } }
    try { await lease.release(); } catch { /* lease release never masks the real error */ }
  }
}

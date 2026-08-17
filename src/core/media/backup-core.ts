// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-3B2C5A (+R1) — consistent backup + crash-safe restore CORE.  INACTIVE.
//
// ── What this core PROVES (models only) ──────────────────────────────────────
//   • the backup manifest + required-file SELECTION model,
//   • the restore VALIDATION + journal STATE MACHINE (deterministic transitions),
//   • the GC DECISION / dry-run model (in staging-gc.ts),
//   • the legacy-compatibility RULES.
// ── What this core does NOT prove (the ACTIVATION BOUNDARY, host/Rust only) ──
//   a real consistent PRODUCTION snapshot, real file hashes/copies, atomic backup
//   publication, a real restore swap/rollback, real symlink/canonical-path
//   safety, real GC deletion, updater-/kill-safety. Those require a Rust/host
//   adapter that itself does canonicalize + symlink_metadata + root-containment +
//   file hashing + lock/lease acquisition + fsync/atomic-rename. No such adapter
//   is wired: `assertBackupHostActivated()` throws, and BACKUP_ACTIVATION reports
//   it. Every `FilePresence`/host-evidence value here is an UNVERIFIED PORT RESULT
//   (a claim), never a cryptographic fact — a `verify ok:true` means "the host
//   port asserted these", provable only once the Rust adapter runs.
//
// Real media layout (audited): a generation file is content-addressed at the
// RELATIVE path `{scope}/{hash[0:2]}/{hash}.{ext}` under the media root; staging
// lives under `<media_root>/.ingest-journal/`. Backups carry only relative paths —
// never an absolute path, never image bytes in JSON, never a secret. NEVER logs
// image bytes/content paths.
// ════════════════════════════════════════════════════════════════════════════

export const BACKUP_FORMAT_VERSION = 1;

/** The host wiring that would make any production-safety claim real. None of it
 *  exists yet, so the core is INACTIVE and refuses to be treated as activated. */
export const BACKUP_ACTIVATION = {
  activatable: false as const,
  missingHostContract: [
    'CANONICALIZE_AND_ROOT_CONTAINMENT',
    'SYMLINK_METADATA',
    'FILE_HASHING',
    'DB_LEASE_AND_MEDIA_LOCK_ACQUISITION',
    'FSYNC_ATOMIC_RENAME_SWAP',
  ],
} as const;

/** Typed guard a production caller would hit: the backup/restore host adapter is
 *  not wired, so no real snapshot/copy/swap may be claimed. */
export function assertBackupHostActivated(): never {
  throw new Error('MEDIA_BACKUP_HOST_NOT_WIRED');
}

/** A minimal row-query port (same shape the other media cores use). */
export interface MediaDbQuery {
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
function rows(db: MediaDbQuery, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const r = db.exec(sql, params);
  if (r.length === 0) return [];
  return r[0].values.map((v) => {
    const o: Record<string, unknown> = {};
    r[0].columns.forEach((c, i) => (o[c] = v[i]));
    return o;
  });
}

export interface BackupFileEntry {
  relPath: string;      // {scope}/{hh}/{hash}.{ext} — relative, content-addressed
  hash: string;         // SHA-256 of the file bytes (== the content address)
  byteSize: number;
  mediaId: string;
  generationNo: number;
  variantType: string | null; // null = master; else 'thumbnail'/'display'/…
  role: string;         // media_role of the owning link (for audit)
  scope: string;        // tenant scope
  reason: 'active' | 'pending_recovery';
}

export type BackupStatus = 'in_progress' | 'complete';

/** A backed-up SQLite file (its own consistent snapshot, checkpointed for WAL DBs). */
export interface BackupDbFileEntry { fileName: string; byteSize: number; sha256: string }

export interface BackupManifest {
  backupFormatVersion: number;
  createdAt: string;            // metadata ONLY — never an identity/causality key
  appVersion: string;
  schemaVersion: string;
  mediaSchemaVersion: string;
  /** The primary DB the media metadata + gallery links live in (`lataif.db`). */
  db: BackupDbFileEntry;
  /** MEDIA-04B2A12 — further consistent DB snapshots that belong to the SAME
   *  point-in-time (e.g. the embedded server DB `lataif_sync_server.db`, checkpointed
   *  so its WAL is folded in). Optional + backward-compatible: absent/[] = legacy. */
  additionalDbFiles?: BackupDbFileEntry[];
  files: BackupFileEntry[];
  fileCount: number;
  status: BackupStatus;
}

// ── path safety (pure) ───────────────────────────────────────────────────────
/** A relative media path is safe iff it is not absolute, has no `..`/`.` segment,
 *  no NUL, no backslash, no leading slash, and is non-empty. Used for BOTH manifest
 *  authoring and restore validation (defence in depth). */
export function isUnsafeRelPath(p: string): boolean {
  if (!p || typeof p !== 'string') return true;
  if (p.includes('\0') || p.includes('\\')) return true;
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(p)) return true;            // drive-letter absolute
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return true;
  return false;
}

// ── required-file collection from a CONSISTENT snapshot ──────────────────────
/**
 * The exact media files a valid restore needs, read from an already-consistent DB
 * snapshot: every ACTIVE link's master medium current-available generation + that
 * medium's active variants' current-available generations. Content-addressed, so
 * two links to the same bytes yield ONE file entry (dedup by relPath). Pending
 * recovery: a non-terminal ingest job whose target generation is already durable
 * (staged/available) is included as `pending_recovery` so a mid-ingest crash stays
 * recoverable after restore. Staging temp files are NOT copied.
 */
export function collectRequiredMediaFiles(db: MediaDbQuery): BackupFileEntry[] {
  const out = new Map<string, BackupFileEntry>();
  const add = (e: BackupFileEntry) => {
    if (isUnsafeRelPath(e.relPath)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
    const prev = out.get(e.relPath);
    // active wins over pending_recovery for the same content address
    if (!prev || (prev.reason === 'pending_recovery' && e.reason === 'active')) out.set(e.relPath, e);
  };
  // active master generations (link → object → master_blob → current available gen)
  const masters = rows(
    db,
    `SELECT l.tenant_id AS scope, l.media_id, l.media_role AS role, g.storage_key, g.stored_blob_hash AS hash,
            g.byte_size, g.generation_no, g.extension
       FROM media_links l
       JOIN media_objects o ON o.tenant_id=l.tenant_id AND o.media_id=l.media_id AND o.deleted_at IS NULL
       JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id AND b.blob_status='present'
       JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id
            AND g.generation_no=b.current_generation_no AND g.gen_status='available'
      WHERE l.deleted_at IS NULL`,
  );
  for (const m of masters) {
    add({ relPath: String(m.storage_key), hash: String(m.hash), byteSize: Number(m.byte_size),
      mediaId: String(m.media_id), generationNo: Number(m.generation_no), variantType: null,
      role: String(m.role), scope: String(m.scope), reason: 'active' });
  }
  // active variant generations (variant → blob → current available gen), only for linked media
  const variants = rows(
    db,
    `SELECT v.tenant_id AS scope, v.media_id, v.variant_type, g.storage_key, g.stored_blob_hash AS hash,
            g.byte_size, g.generation_no, g.extension
       FROM media_variants v
       JOIN media_links l ON l.tenant_id=v.tenant_id AND l.media_id=v.media_id AND l.deleted_at IS NULL
       -- v0.8.44: same object join the Rust SSOT and the gallery resolver use. Without it a DELETED
       -- media object still contributed its thumbnail. This module is dormant (no production caller
       -- reaches it; the live backup is the Rust one), but a dormant duplicate that disagrees is a
       -- disagreement waiting to be activated.
       JOIN media_objects o ON o.tenant_id=v.tenant_id AND o.media_id=v.media_id AND o.deleted_at IS NULL
       JOIN media_blobs b ON b.tenant_id=v.tenant_id AND b.blob_id=v.blob_id AND b.blob_status='present'
       JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id
            AND g.generation_no=b.current_generation_no AND g.gen_status='available'
      WHERE v.deleted_at IS NULL`,
  );
  for (const v of variants) {
    add({ relPath: String(v.storage_key), hash: String(v.hash), byteSize: Number(v.byte_size),
      mediaId: String(v.media_id), generationNo: Number(v.generation_no), variantType: String(v.variant_type),
      role: 'variant', scope: String(v.scope), reason: 'active' });
  }
  // pending recovery: durable generations of non-terminal ingest jobs
  const pending = rows(
    db,
    `SELECT j.tenant_id AS scope, j.target_media_id AS media_id, g.storage_key, g.stored_blob_hash AS hash,
            g.byte_size, g.generation_no, g.extension
       FROM media_ingest_jobs j
       JOIN media_blob_generations g ON g.tenant_id=j.tenant_id AND g.blob_id=j.target_blob_id
            AND g.gen_status IN ('staged','available')
      WHERE j.state NOT IN ('ready','failed','quarantined','expired') AND j.target_blob_id IS NOT NULL`,
  );
  for (const p of pending) {
    add({ relPath: String(p.storage_key), hash: String(p.hash), byteSize: Number(p.byte_size),
      mediaId: String(p.media_id ?? ''), generationNo: Number(p.generation_no), variantType: null,
      role: 'pending', scope: String(p.scope), reason: 'pending_recovery' });
  }
  return [...out.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ── manifest authoring ───────────────────────────────────────────────────────
export function buildBackupManifest(args: {
  createdAt: string;
  appVersion: string; schemaVersion: string; mediaSchemaVersion: string;
  db: BackupDbFileEntry;
  additionalDbFiles?: BackupDbFileEntry[];
  files: BackupFileEntry[];
}): BackupManifest {
  for (const f of args.files) if (isUnsafeRelPath(f.relPath)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
  if (isUnsafeRelPath(args.db.fileName)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
  for (const d of args.additionalDbFiles ?? []) if (isUnsafeRelPath(d.fileName)) throw new Error('MEDIA_BACKUP_UNSAFE_PATH');
  return {
    backupFormatVersion: BACKUP_FORMAT_VERSION,
    createdAt: args.createdAt,
    appVersion: args.appVersion, schemaVersion: args.schemaVersion, mediaSchemaVersion: args.mediaSchemaVersion,
    db: args.db,
    additionalDbFiles: args.additionalDbFiles ?? [],
    files: args.files,
    fileCount: args.files.length,
    status: 'in_progress',
  };
}

/** An UNVERIFIED host port: each method is a CLAIM the Rust/host adapter makes
 *  (it must have actually canonicalized + stat'd + hashed). The core never treats
 *  these as cryptographic facts on its own. */
export interface FilePresence {
  exists: (relPath: string) => boolean;
  sizeOf: (relPath: string) => number;
  hashOf: (relPath: string) => string;
  isSymlink?: (relPath: string) => boolean;
}

export type VerifyResult = { ok: true } | { ok: false; code: string; relPath?: string };

/** Reject a manifest whose relative paths collide (the same path listed twice) —
 *  after the segment-safety check in `isUnsafeRelPath`, a repeated path is either
 *  a malformed manifest or a normalization/collision attack. Content-addressed
 *  authoring never produces duplicates, so any duplicate fails closed. */
export function pathCollision(files: { relPath: string }[]): string | null {
  const seen = new Set<string>();
  for (const f of files) {
    if (isUnsafeRelPath(f.relPath)) return f.relPath;
    if (seen.has(f.relPath)) return f.relPath;
    seen.add(f.relPath);
  }
  return null;
}

/** Verify every referenced file is present, the right size, and hashes to its
 *  content address (and the DB file too). Fail-closed on the first problem. Note:
 *  `ok:true` only means the HOST PORT asserted these — production truth needs the
 *  Rust adapter (see BACKUP_ACTIVATION). */
export function verifyBackupFiles(manifest: BackupManifest, fs: FilePresence): VerifyResult {
  if (manifest.fileCount !== manifest.files.length) return { ok: false, code: 'MEDIA_BACKUP_COUNT_MISMATCH' };
  const collision = pathCollision(manifest.files);
  if (collision) return { ok: false, code: 'MEDIA_BACKUP_PATH_COLLISION', relPath: collision };
  for (const f of manifest.files) {
    if (isUnsafeRelPath(f.relPath)) return { ok: false, code: 'MEDIA_BACKUP_UNSAFE_PATH', relPath: f.relPath };
    if (fs.isSymlink?.(f.relPath)) return { ok: false, code: 'MEDIA_BACKUP_SYMLINK', relPath: f.relPath };
    if (!fs.exists(f.relPath)) return { ok: false, code: 'MEDIA_BACKUP_FILE_MISSING', relPath: f.relPath };
    if (fs.sizeOf(f.relPath) !== f.byteSize) return { ok: false, code: 'MEDIA_BACKUP_SIZE_MISMATCH', relPath: f.relPath };
    if (fs.hashOf(f.relPath) !== f.hash) return { ok: false, code: 'MEDIA_BACKUP_HASH_MISMATCH', relPath: f.relPath };
  }
  if (!fs.exists(manifest.db.fileName)) return { ok: false, code: 'MEDIA_BACKUP_DB_MISSING' };
  if (fs.sizeOf(manifest.db.fileName) !== manifest.db.byteSize) return { ok: false, code: 'MEDIA_BACKUP_DB_SIZE' };
  if (fs.hashOf(manifest.db.fileName) !== manifest.db.sha256) return { ok: false, code: 'MEDIA_BACKUP_DB_HASH' };
  // MEDIA-04B2A12 — every additional DB snapshot (e.g. the checkpointed server DB) verifies too.
  for (const d of manifest.additionalDbFiles ?? []) {
    if (isUnsafeRelPath(d.fileName)) return { ok: false, code: 'MEDIA_BACKUP_UNSAFE_PATH', relPath: d.fileName };
    if (fs.isSymlink?.(d.fileName)) return { ok: false, code: 'MEDIA_BACKUP_SYMLINK', relPath: d.fileName };
    if (!fs.exists(d.fileName)) return { ok: false, code: 'MEDIA_BACKUP_DB_MISSING', relPath: d.fileName };
    if (fs.sizeOf(d.fileName) !== d.byteSize) return { ok: false, code: 'MEDIA_BACKUP_DB_SIZE', relPath: d.fileName };
    if (fs.hashOf(d.fileName) !== d.sha256) return { ok: false, code: 'MEDIA_BACKUP_DB_HASH', relPath: d.fileName };
  }
  return { ok: true };
}

/** Mark a manifest `complete` — ONLY after `verifyBackupFiles` passed. An
 *  aborted backup keeps `in_progress` and can never be treated as restorable. */
export function finalizeBackupManifest(manifest: BackupManifest, verify: VerifyResult): BackupManifest {
  if (!verify.ok) throw new Error('MEDIA_BACKUP_INCOMPLETE');
  return { ...manifest, status: 'complete' };
}

// ── restore validation ───────────────────────────────────────────────────────
export interface RestoreHost {
  appVersion: string;
  maxBackupFormatVersion: number;
  /** DB INTROSPECTION port — NOT a caller-asserted boolean. Returns the number of
   *  active media references (media_links rows) the backed-up DB itself carries.
   *  The core calls this and decides; a caller cannot take a `hasMediaRefs=false`
   *  shortcut. In production this runs a real `SELECT COUNT(*)` on the restored DB. */
  introspectActiveMediaRefs: () => number;
}

export type RestoreValidation =
  | { ok: true; legacyDbOnly: boolean }
  | { ok: false; code: string; relPath?: string };

/**
 * Validate a backup for restore WITHOUT touching the live system. Fail-closed on:
 * unknown/newer format, not `complete`, any unsafe/symlink path, any missing/size/
 * hash mismatch, or a DB that references media but ships no files. A legacy DB-only
 * backup (no media refs, no files) is explicitly allowed.
 */
export function validateBackupForRestore(manifest: BackupManifest, fs: FilePresence, host: RestoreHost): RestoreValidation {
  if (typeof manifest.backupFormatVersion !== 'number' || manifest.backupFormatVersion > host.maxBackupFormatVersion) {
    return { ok: false, code: 'MEDIA_RESTORE_UNKNOWN_VERSION' };
  }
  if (manifest.status !== 'complete') return { ok: false, code: 'MEDIA_RESTORE_INCOMPLETE_BACKUP' };
  const v = verifyBackupFiles(manifest, fs);
  if (!v.ok) return v;
  const legacyDbOnly = manifest.files.length === 0;
  // Media-ref presence comes from DB introspection, never a caller flag. A DB that
  // references media but ships no files → fail closed (no silent empty galleries).
  const activeMediaRefs = host.introspectActiveMediaRefs();
  if (legacyDbOnly && activeMediaRefs > 0) return { ok: false, code: 'MEDIA_RESTORE_MISSING_MEDIA_FILES' };
  return { ok: true, legacyDbOnly };
}

// ── restore journal (crash-safe swap) ────────────────────────────────────────
export type RestoreJournalState =
  | 'prepared'      // backup fully validated + staged; live untouched
  | 'db_swapped'    // new DB in place, media root NOT yet swapped
  | 'media_swapped' // both swapped, not yet verified
  | 'verified';     // restore verified — terminal success

export type RestoreRecovery =
  | { action: 'safe_no_change' }     // crash before/at prepared → live unchanged
  | { action: 'continue_media_swap' }// crash after db_swapped → finish forward
  | { action: 'verify' }             // crash after media_swapped → re-verify
  | { action: 'done' };

/** What startup must do given a restore journal left behind by a crash. Between
 *  the DB swap and the media swap the app must NOT open (partial state); recovery
 *  deterministically finishes the swap forward using the staged new media root. */
export function restoreRecoveryDecision(state: RestoreJournalState | null): RestoreRecovery {
  switch (state) {
    case null:
    case 'prepared': return { action: 'safe_no_change' };
    case 'db_swapped': return { action: 'continue_media_swap' };
    case 'media_swapped': return { action: 'verify' };
    case 'verified': return { action: 'done' };
  }
}

/** True iff the app may open the live system normally (NOT mid-restore). A
 *  `db_swapped`/`media_swapped` journal means recovery must run first. */
export function mayOpenLive(state: RestoreJournalState | null): boolean {
  return state === null || state === 'verified';
}

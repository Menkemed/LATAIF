// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER Phase 5B — alte Bildfassungen für den vorhandenen Medien-GC freigeben (17.11.2026).
//
// Nach der Migration hat jedes umgestellte Bild eine alte Generation `superseded` (die frühere, größere Fassung).
// Der Medien-GC (Rust `media_gc.rs`) schützt jede Datei, auf die eine Generation zeigt, die NICHT `deleted` ist
// (`reachability::preserved_keys`, ohne Backup-Pin). Dieser Schritt löscht KEINE Datei: er setzt nur alte
// Generationen über die vom Schema erlaubten Übergänge `superseded → gc_pending → deleted` (Tombstone, die Zeile
// bleibt). Erst danach findet der vorhandene GC die Datei als unbenutzt: Scan → Quarantäne beim nächsten Start →
// ausdrückliche Owner-Bestätigung (endgültig löschen). Die Quarantäne holt eine Datei zurück, falls sie wieder
// gebraucht wird.
//
// Freigegeben wird eine Generation NUR, wenn ALLES stimmt (sonst bleibt sie, mit Grund):
//   • sie ist `superseded` und älter als die aktuelle Generation desselben Blobs;
//   • der Blob ist `present`, seine aktuelle Generation `available`, und deren DATEI ist vor der Freigabe
//     verifiziert gelesen worden (Rust prüft SHA-256 und Größe);
//   • kein Ausweis/höhere Sicherheitsklasse in irgendeiner Nutzung des Blobs;
//   • kein Backup-Pin, kein Rotationsauftrag, kein eingefrorener Einkaufs-Ausweis auf genau dieser Generation;
//   • Speicherschlüssel in der bekannten Form `<scope>/<hh>/<hash>.jpg`.
// NIE angefasst: aktuelle Generationen (auch die von entfernten Fotos — ihr Medium kann wieder verknüpft werden,
// und für eine aktuelle Generation gibt es keinen freigebenden Lebenszyklus), Ausweise, das Ingest-Journal
// (`.ingest-journal`, Steuerdaten; der GC betritt Steuerordner nie).
// Pakete im exklusiven Schreibplatz, je Paket durables Speichern; Owner-Prüfung und Vorbedingungen (keine offene
// Aufnahme, keine Rotation) vor JEDEM Paket; kooperativer Abbruch; ein neuer Lauf setzt fort (idempotent).
// ════════════════════════════════════════════════════════════════════════════
import { assertMigrationPreconditions, ImageMigrationError, type MigrationDb } from './image-store-migration.ts';

export interface ReleaseCandidate {
  tenantId: string;
  blobId: string;
  generationNo: number;
  storageKey: string;
  bytes: number;
  rendition: 'main' | 'thumbnail';
  /** Speicher-Scope (erstes Segment des Schlüssels), für das verifizierte Lesen der aktuellen Datei. */
  scope: string;
  currentGeneration: number;
  currentHash: string;
  currentBytes: number;
  currentExtension: string;
}

export type ReleaseSkipReason =
  | 'not_older_than_current' | 'current_not_available' | 'blob_not_present' | 'backup_pinned' | 'rotation_reference'
  | 'security_class' | 'purchase_identity' | 'storage_key_form' | 'current_unverified';

export interface GroupTotals { files: number; bytes: number }
/** Was bleibt — zur Anzeige im Probelauf (aus der DB; Dateien = Zeilen mit `present`-Blob). */
export interface KeptGroups {
  currentInUse: GroupTotals;
  currentIdentity: GroupTotals;
  /** Aktuelle Fassungen entfernter Fotos: bleiben (Medium wieder verknüpfbar, kein freigebender Lebenszyklus). */
  currentRemovedPhotos: GroupTotals;
  /** Alte Fassungen, die aus einem der Gründe oben bleiben. */
  oldExcluded: GroupTotals;
}

export interface ReleasePlan {
  candidates: ReleaseCandidate[];
  excluded: Array<{ blobId: string; generationNo: number; bytes: number; reason: ReleaseSkipReason }>;
  kept: KeptGroups;
}

type Row = Record<string, unknown>;
function rows(db: MigrationDb, sql: string, params: unknown[] = []): Row[] {
  const r = db.exec(sql, params);
  if (r.length === 0) return [];
  return r[0].values.map((v) => {
    const o: Row = {};
    for (let i = 0; i < r[0].columns.length; i++) o[r[0].columns[i]] = v[i];
    return o;
  });
}
const tableExists = (db: MigrationDb, name: string) => rows(db, `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, [name]).length > 0;
const KEY_FORM = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/([0-9a-f]{2})\/([0-9a-f]{64})\.jpg$/;
const gk = (t: unknown, b: unknown, n: unknown) => `${String(t)}|${String(b)}|${Number(n)}`;

/** Alle Generationen, die eine Sonderregel schützt (Pin, Rotation, Einkaufs-Ausweis). */
function protectedGenerations(db: MigrationDb): Map<string, ReleaseSkipReason> {
  const out = new Map<string, ReleaseSkipReason>();
  if (tableExists(db, 'media_backup_generation_pins')) {
    for (const r of rows(db, `SELECT tenant_id AS t, blob_id AS b, generation_no AS n FROM media_backup_generation_pins`)) out.set(gk(r.t, r.b, r.n), 'backup_pinned');
  }
  if (tableExists(db, 'media_rotation_jobs')) {
    for (const r of rows(db, `SELECT tenant_id AS t, blob_id AS b, from_generation_no AS f, to_generation_no AS g FROM media_rotation_jobs`)) {
      if (r.f != null) out.set(gk(r.t, r.b, r.f), 'rotation_reference');
      if (r.g != null) out.set(gk(r.t, r.b, r.g), 'rotation_reference');
    }
  }
  if (tableExists(db, 'purchases') && rows(db, `PRAGMA table_info(purchases)`).some((c) => c.name === 'supplier_snapshot')) {
    // MEDIA-IDENTITY §7/§8 — die exakte Fassung, die ein Einkauf eingefroren hat (aktuell oder ersetzt).
    const snap = rows(db, `SELECT o.tenant_id AS t, o.master_blob_id AS b, json_extract(p.supplier_snapshot, '$.identity.generationNo') AS n
        FROM purchases p JOIN media_objects o ON o.media_id = json_extract(p.supplier_snapshot, '$.identity.mediaId')
       WHERE p.supplier_snapshot IS NOT NULL AND json_valid(p.supplier_snapshot) AND json_extract(p.supplier_snapshot, '$.identity.mediaId') IS NOT NULL
      UNION ALL
      SELECT o.tenant_id, o.master_blob_id, json_extract(r.value, '$.generationNo')
        FROM purchases p, json_each(p.supplier_snapshot, '$.identityRetired') r JOIN media_objects o ON o.media_id = json_extract(r.value, '$.mediaId')
       WHERE p.supplier_snapshot IS NOT NULL AND json_valid(p.supplier_snapshot) AND json_type(p.supplier_snapshot, '$.identityRetired') = 'array'`);
    for (const r of snap) if (r.n != null) out.set(gk(r.t, r.b, r.n), 'purchase_identity');
  }
  return out;
}

/** Blobs, die irgendwo (auch gelöscht) als Ausweis o. Ä. genutzt werden — nie freigeben. */
function sensitiveBlobs(db: MigrationDb): Set<string> {
  const s = new Set<string>();
  for (const r of rows(db, `SELECT tenant_id AS t, master_blob_id AS b FROM media_objects WHERE security_class NOT IN ('internal','public')
      UNION SELECT v.tenant_id, v.blob_id FROM media_variants v JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id
       WHERE o.security_class NOT IN ('internal','public')`)) s.add(`${String(r.t)}|${String(r.b)}`);
  return s;
}

/** Rein lesend: welche alten Generationen freigegeben werden dürfen, welche bleiben (mit Grund), und was sonst bleibt. */
export function planOldVersionRelease(db: MigrationDb): ReleasePlan {
  if (!tableExists(db, 'media_blob_generations')) throw new ImageMigrationError('MEDIA_SCHEMA_MISSING');
  const prot = protectedGenerations(db);
  const sens = sensitiveBlobs(db);
  const variantBlobs = new Set(rows(db, `SELECT tenant_id AS t, blob_id AS b FROM media_variants`).map((r) => `${String(r.t)}|${String(r.b)}`));
  const candidates: ReleaseCandidate[] = [];
  const excluded: ReleasePlan['excluded'] = [];
  const old = rows(db, `SELECT g.tenant_id AS t, g.blob_id AS b, g.generation_no AS n, g.storage_key AS k, g.byte_size AS s,
      b.blob_status AS bs, b.current_generation_no AS cn, c.gen_status AS cst, c.stored_blob_hash AS ch, c.byte_size AS cs, c.extension AS ce, c.storage_key AS ck
    FROM media_blob_generations g
    JOIN media_blobs b ON b.tenant_id = g.tenant_id AND b.blob_id = g.blob_id
    LEFT JOIN media_blob_generations c ON c.tenant_id = b.tenant_id AND c.blob_id = b.blob_id AND c.generation_no = b.current_generation_no
   WHERE g.gen_status = 'superseded'
   ORDER BY g.tenant_id, g.blob_id, g.generation_no`);
  for (const r of old) {
    const bytes = Number(r.s ?? 0);
    const skip = (reason: ReleaseSkipReason) => excluded.push({ blobId: String(r.b), generationNo: Number(r.n), bytes, reason });
    const key = String(r.k ?? '').replace(/\\/g, '/');
    const ckey = String(r.ck ?? '').replace(/\\/g, '/');
    const m = KEY_FORM.exec(key);
    const cm = KEY_FORM.exec(ckey);
    if (r.bs !== 'present') { skip('blob_not_present'); continue; }
    if (r.cn == null || Number(r.n) >= Number(r.cn)) { skip('not_older_than_current'); continue; }
    if (r.cst !== 'available' || !r.ch) { skip('current_not_available'); continue; }
    if (sens.has(`${String(r.t)}|${String(r.b)}`)) { skip('security_class'); continue; }
    const p = prot.get(gk(r.t, r.b, r.n));
    if (p) { skip(p); continue; }
    if (!m || !cm || m[1] !== cm[1] || cm[3] !== String(r.ch) || String(r.ce) !== 'jpg') { skip('storage_key_form'); continue; }
    candidates.push({
      tenantId: String(r.t), blobId: String(r.b), generationNo: Number(r.n), storageKey: key, bytes,
      rendition: variantBlobs.has(`${String(r.t)}|${String(r.b)}`) ? 'thumbnail' : 'main', scope: m[1],
      currentGeneration: Number(r.cn), currentHash: String(r.ch), currentBytes: Number(r.cs ?? 0), currentExtension: String(r.ce),
    });
  }
  return { candidates, excluded, kept: keptGroups(db, excluded) };
}

function keptGroups(db: MigrationDb, excluded: ReleasePlan['excluded']): KeptGroups {
  const sens = sensitiveBlobs(db);
  const linked = new Set(rows(db, `SELECT o.tenant_id AS t, o.master_blob_id AS b FROM media_links l
      JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id AND o.deleted_at IS NULL WHERE l.deleted_at IS NULL
    UNION SELECT v.tenant_id, v.blob_id FROM media_variants v
      JOIN media_links l ON l.tenant_id = v.tenant_id AND l.media_id = v.media_id AND l.deleted_at IS NULL
      JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id AND o.deleted_at IS NULL WHERE v.deleted_at IS NULL`).map((r) => `${String(r.t)}|${String(r.b)}`));
  const z = (): GroupTotals => ({ files: 0, bytes: 0 });
  const k: KeptGroups = { currentInUse: z(), currentIdentity: z(), currentRemovedPhotos: z(), oldExcluded: z() };
  for (const r of rows(db, `SELECT g.tenant_id AS t, g.blob_id AS b, g.byte_size AS s FROM media_blobs b
      JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
     WHERE b.blob_status = 'present' AND g.gen_status = 'available'`)) {
    const id = `${String(r.t)}|${String(r.b)}`;
    const g = sens.has(id) ? k.currentIdentity : linked.has(id) ? k.currentInUse : k.currentRemovedPhotos;
    g.files++; g.bytes += Number(r.s ?? 0);
  }
  for (const e of excluded) { k.oldExcluded.files++; k.oldExcluded.bytes += e.bytes; }
  return k;
}

/**
 * EINE alte Generation freigeben: in einer eigenen Transaktion den Stand neu prüfen, dann `superseded → gc_pending →
 * deleted`. Wirft `RELEASE_STATE_CHANGED`, wenn sich die Lage seit der Planung geändert hat (nichts geschrieben), und
 * `MIGRATION_TRANSACTION_BUSY`, wenn eine fremde Transaktion offen ist (nie schachteln, nie fremd zurückrollen).
 */
export function releaseOldVersion(db: MigrationDb, c: ReleaseCandidate, now: string, transactionActive?: () => boolean): void {
  if (transactionActive?.()) throw new ImageMigrationError('MIGRATION_TRANSACTION_BUSY', 'another transaction is open');
  try { db.run('BEGIN'); } catch { throw new ImageMigrationError('MIGRATION_TRANSACTION_BUSY', 'BEGIN refused'); }
  try {
    const r = rows(db, `SELECT g.gen_status AS st, b.blob_status AS bs, b.current_generation_no AS cn, c.gen_status AS cst, c.stored_blob_hash AS ch
        FROM media_blob_generations g JOIN media_blobs b ON b.tenant_id = g.tenant_id AND b.blob_id = g.blob_id
        LEFT JOIN media_blob_generations c ON c.tenant_id = b.tenant_id AND c.blob_id = b.blob_id AND c.generation_no = b.current_generation_no
       WHERE g.tenant_id = ? AND g.blob_id = ? AND g.generation_no = ?`, [c.tenantId, c.blobId, c.generationNo])[0];
    if (!r || r.st !== 'superseded' || r.bs !== 'present' || Number(r.cn) !== c.currentGeneration || r.cst !== 'available' || r.ch !== c.currentHash) {
      throw new ImageMigrationError('RELEASE_STATE_CHANGED', 'the generation or its replacement changed since planning');
    }
    db.run(`UPDATE media_blob_generations SET gen_status = 'gc_pending', gc_eligible_at = ?
             WHERE tenant_id = ? AND blob_id = ? AND generation_no = ? AND gen_status = 'superseded'`, [now, c.tenantId, c.blobId, c.generationNo]);
    db.run(`UPDATE media_blob_generations SET gen_status = 'deleted', deleted_at = ?
             WHERE tenant_id = ? AND blob_id = ? AND generation_no = ? AND gen_status = 'gc_pending'`, [now, c.tenantId, c.blobId, c.generationNo]);
    const after = rows(db, `SELECT gen_status AS st FROM media_blob_generations WHERE tenant_id = ? AND blob_id = ? AND generation_no = ?`, [c.tenantId, c.blobId, c.generationNo])[0];
    if (after?.st !== 'deleted') throw new ImageMigrationError('RELEASE_NOT_APPLIED', 'status did not reach deleted');
    db.run('COMMIT');
  } catch (e) {
    try { db.run('ROLLBACK'); } catch { /* eigene Transaktion: schon beendet */ }
    throw e;
  }
}

export interface ReleaseJournalEntry {
  at: string;
  runId: string;
  event: 'start' | 'planned' | 'released' | 'skipped' | 'failed' | 'stopped' | 'done';
  blobId?: string;
  generationNo?: number;
  bytes?: number;
  rendition?: 'main' | 'thumbnail';
  reason?: string;
}

export interface ReleaseProgress { runId: string; mode: 'dry-run' | 'apply'; total: number; done: number; released: number; planned: number; skipped: number; failed: number; running: boolean }

export interface ReleaseReport {
  runId: string;
  mode: 'dry-run' | 'apply';
  total: number;
  /** Probelauf: geprüft und freigebbar. Lauf: freigegeben. */
  planned: number;
  released: number;
  bytesPlanned: number;
  bytesReleased: number;
  byRendition: { main: GroupTotals; thumbnail: GroupTotals };
  skipped: Partial<Record<ReleaseSkipReason, number>>;
  failed: number;
  kept: KeptGroups;
  stoppedEarly: boolean;
  stopCode?: string;
  errors: Array<{ blobId: string; code: string }>;
}

export interface ReleaseDeps {
  db: MigrationDb;
  /** Prüft die AKTUELLE Datei des Blobs (Rust: Pfad im Medienstamm, SHA-256, Größe). Wirft bei Abweichung. */
  verifyCurrent(c: ReleaseCandidate): Promise<void>;
  saveDurably(): Promise<void>;
  exclusive?<T>(fn: () => Promise<T>): Promise<T>;
  transactionActive?(): boolean;
  assertAllowed?(): void;
  progress?(p: ReleaseProgress): void;
  journal(e: ReleaseJournalEntry): void | Promise<void>;
  now?(): string;
}

export interface ReleaseOptions {
  mode: 'dry-run' | 'apply';
  /** Paketgröße (Standard 25). */
  batchSize?: number;
  shouldStop?(): boolean;
  onlyBlobIds?: Set<string>;
}

function newRunId(now: string): string {
  const stamp = now.replace(/[^0-9]/g, '').slice(0, 14);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `old-ver-${stamp}-${rnd}`;
}

export async function runOldVersionRelease(deps: ReleaseDeps, opts: ReleaseOptions): Promise<ReleaseReport> {
  const now = deps.now ?? (() => new Date().toISOString());
  const exclusive = deps.exclusive ?? (<T>(fn: () => Promise<T>) => fn());
  const runId = newRunId(now());
  const batchSize = Math.max(1, Math.min(200, opts.batchSize ?? 25));
  let plan!: ReleasePlan;
  await exclusive(async () => {
    deps.assertAllowed?.();
    if (opts.mode === 'apply') assertMigrationPreconditions(deps.db);
    plan = planOldVersionRelease(deps.db);
  });
  const list = opts.onlyBlobIds ? plan.candidates.filter((c) => opts.onlyBlobIds!.has(c.blobId)) : plan.candidates;
  const report: ReleaseReport = {
    runId, mode: opts.mode, total: list.length, planned: 0, released: 0, bytesPlanned: 0, bytesReleased: 0,
    byRendition: { main: { files: 0, bytes: 0 }, thumbnail: { files: 0, bytes: 0 } },
    skipped: {}, failed: 0, kept: plan.kept, stoppedEarly: false, errors: [],
  };
  for (const e of plan.excluded) report.skipped[e.reason] = (report.skipped[e.reason] ?? 0) + 1;
  let done = 0;
  const prog = (running: boolean) => deps.progress?.({ runId, mode: opts.mode, total: list.length, done, released: report.released, planned: report.planned,
    skipped: Object.values(report.skipped).reduce((a, b) => a + (b ?? 0), 0), failed: report.failed, running });
  await deps.journal({ at: now(), runId, event: 'start' });
  prog(true);
  outer: for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    let unsaved = 0;
    try {
      await exclusive(async () => {
        deps.assertAllowed?.();
        if (opts.mode === 'apply') assertMigrationPreconditions(deps.db);
        try {
          for (const c of batch) {
            if (opts.shouldStop?.()) { report.stoppedEarly = true; report.stopCode = 'RELEASE_STOP_REQUESTED'; return; }
            try {
              await deps.verifyCurrent(c);
            } catch (e) {
              report.skipped.current_unverified = (report.skipped.current_unverified ?? 0) + 1;
              await deps.journal({ at: now(), runId, event: 'skipped', blobId: c.blobId, generationNo: c.generationNo, reason: 'current_unverified' });
              done++; prog(true);
              continue;
            }
            if (opts.mode === 'dry-run') {
              report.planned++; report.bytesPlanned += c.bytes;
              report.byRendition[c.rendition].files++; report.byRendition[c.rendition].bytes += c.bytes;
              await deps.journal({ at: now(), runId, event: 'planned', blobId: c.blobId, generationNo: c.generationNo, bytes: c.bytes, rendition: c.rendition });
            } else {
              try {
                releaseOldVersion(deps.db, c, now(), deps.transactionActive);
              } catch (e) {
                const code = e instanceof ImageMigrationError ? e.code : 'RELEASE_FAILED';
                if (code === 'MIGRATION_TRANSACTION_BUSY') { report.stoppedEarly = true; report.stopCode = code; return; }
                report.failed++; report.errors.push({ blobId: c.blobId, code });
                await deps.journal({ at: now(), runId, event: 'failed', blobId: c.blobId, generationNo: c.generationNo, reason: code });
                done++; prog(true);
                continue;
              }
              unsaved++;
              report.released++; report.bytesReleased += c.bytes;
              report.byRendition[c.rendition].files++; report.byRendition[c.rendition].bytes += c.bytes;
              await deps.journal({ at: now(), runId, event: 'released', blobId: c.blobId, generationNo: c.generationNo, bytes: c.bytes, rendition: c.rendition });
            }
            done++; prog(true);
          }
        } finally {
          if (unsaved > 0) { await deps.saveDurably(); unsaved = 0; }
        }
      });
    } catch (e) {
      if (e instanceof ImageMigrationError && e.code === 'MIGRATION_OPEN_INGEST_JOBS') { report.stoppedEarly = true; report.stopCode = e.code; break outer; }
      throw e;
    }
    if (report.stoppedEarly) break;
  }
  await deps.journal({ at: now(), runId, event: report.stoppedEarly ? 'stopped' : 'done', reason: report.stopCode });
  prog(false);
  return report;
}

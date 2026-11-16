// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — bestehende Bilder kontrolliert auf die Klassengrenzen bringen.
//
// Mechanismus: GENERATIONSWECHSEL je Blob. Die neue, kleinere Datei wird von Rust aus der
// ORIGINAL-Generation erzeugt, inhaltsadressiert veröffentlicht und verifiziert zurückgelesen
// (`media_recompress_stored`). Danach schreibt EINE sql.js-Transaktion:
//     Generation n+1 (`available`) → Zeiger `current_generation_no` n → n+1 → Generation n `superseded`
// Die Schema-Trigger prüfen dabei Zeiger (nur auf `available`), Größe je Nutzung (Master ≤ 100 000,
// Vorschau ≤ 20 000) und den Zustandsautomaten. media_id, blob_id, media_objects, media_variants,
// media_links und jede Geschäftszeile (products …) bleiben UNVERÄNDERT — damit auch pHash, Embedding,
// sync_changelog und audit_log. Die alte Datei bleibt liegen (keine Löschung in diesem Schritt).
//
// Sicherheit:
//   • Probelauf (`dry-run`) schreibt nichts — weder Datei noch Zeile; er misst mit demselben Encoder.
//   • Wiederaufnahme ergibt sich aus dem DB-Zustand: ein umgestellter Blob liegt danach unter seiner
//     Grenze und wird übersprungen. Ein Abbruch zwischen Veröffentlichen und Commit hinterlässt nur
//     eine unverknüpfte Datei; der nächste Lauf erzeugt sie bitgleich und verwendet sie wieder.
//   • Vor dem ersten Schreiben: keine offene Aufnahme, keine laufende Schlüsselrotation (sonst Abbruch).
//   • Übersprungen (nie angefasst): unter der Grenze, < 10 % Ersparnis, Ausweise/höhere
//     Sicherheitsklassen, fremde Besitzer (Logo, Dokument, Lieferant …), unverknüpfte bzw. entfernte
//     Bilder, gemischt genutzte Blobs, nicht-JPEG/verschlüsselt.
//   • Teilfehler (fehlende Datei, Hashabweichung, Konflikt) werden je Bild protokolliert; der Lauf
//     geht weiter, der Blob bleibt auf seiner bisherigen Generation.
//   • PAKETE (Phase 4, 16.11.2026): der Lauf arbeitet in kleinen Paketen. Jedes Paket läuft im EINEN
//     exklusiven Schreibplatz des Primary (`deps.exclusive` = Schreib-Warteschlange + Medien-Sperre +
//     DB-Lease) und endet mit einem durablen Speichern. Damit gibt es nie eine zweite offene Transaktion
//     neben der Umstellung (früher: Fernauftrag mit offenem BEGIN wartete auf die Medien-Sperre, die
//     Migration rief ein zweites BEGIN), und ein Leser von außen sieht nur gespeicherte Stände (kein
//     Bildschlüssel, den `/api/media` auf der Platte noch nicht kennt). Zwischen den Paketen kommen
//     wartende Schreib- und Lesevorgänge in ihrer Reihenfolge dran.
//   • Abbruch nur zwischen zwei Bildern; das angefangene Paket wird gespeichert — es bleibt keine
//     veröffentlichte Datei ohne Zeile zurück. Ein harter Absturz mitten im Paket lässt höchstens die
//     Dateien dieses Pakets ohne Zeile; die Wiederaufnahme erzeugt sie bitgleich und übernimmt sie.
//
// Kein G5, keine Sync-Änderung: Medienzeilen erzeugen keinen sync_changelog-Eintrag.
// ════════════════════════════════════════════════════════════════════════════
import { SIZE_PROFILE_LIMITS, sizeProfileFor, MAIN30_CATEGORY_IDS, type MediaSizeProfile } from './size-profile.ts';

export interface MigrationDb {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}

export interface RecompressArgs {
  tenantScope: string;
  sourceHash: string;
  sourceExtension: string;
  rendition: 'main' | 'thumbnail';
  maxBytes: number;
  publish: boolean;
  /** Nur veröffentlichen, wenn die neue Fassung kleiner als dieser Wert ist. */
  publishOnlyBelow?: number;
}

/** Spiegel von Rust `RecompressResult` (snake_case wie über IPC). */
export interface RecompressOutcome {
  rendition: 'main' | 'thumbnail';
  source_hash: string;
  source_byte_size: number;
  hash: string;
  byte_size: number;
  width: number;
  height: number;
  extension: string;
  content_kind: string;
  mime_type: string;
  storage_key: string;
  published: boolean;
}

export type SkipReason =
  | 'already_small'
  | 'saving_below_10pct'
  | 'excluded_security'
  | 'excluded_identity'
  | 'excluded_entity'
  | 'unlinked_usage'
  | 'mixed_usage'
  | 'not_current_available'
  | 'not_jpeg_raster'
  | 'encrypted'
  /** Die neue Fassung ist bitgleich mit der aktuellen Fassung eines ANDEREN Blobs (z. B. zwei Vorschauen
   *  desselben Hauptbilds). Ein Speicherschlüssel gehört genau einer Generation — dieser Blob bleibt. */
  | 'duplicate_content';

export interface MigrationJournalEntry {
  at: string;
  runId: string;
  event: 'start' | 'switched' | 'skipped' | 'failed' | 'planned' | 'stopped' | 'done';
  blobId?: string;
  rendition?: 'main' | 'thumbnail';
  fromGeneration?: number;
  toGeneration?: number;
  fromBytes?: number;
  toBytes?: number;
  reason?: SkipReason | string;
}

export interface MigrationDeps {
  db: MigrationDb;
  recompress(a: RecompressArgs): Promise<RecompressOutcome>;
  /** Die DB dauerhaft speichern (Primary: `lease.saveDurably` des laufenden Pakets). */
  saveDurably(): Promise<void>;
  /** Protokoll AUSSERHALB der Datenbank (nur Kennungen und Zahlen — keine Namen, keine Inhalte). */
  journal(entry: MigrationJournalEntry): void | Promise<void>;
  now?(): string;
  /**
   * Ein Paket im exklusiven Schreibplatz ausführen (Primary: Schreib-Warteschlange → Medien-Sperre → DB-Lease).
   * Ohne Angabe läuft alles direkt (Tests). Wirft `fn`, wird das Paket trotzdem freigegeben.
   */
  exclusive?<T>(fn: () => Promise<T>): Promise<T>;
  /** Ist gerade eine (fremde) Transaktion offen? Dann wird NICHT umgestellt, sondern sauber angehalten. */
  transactionActive?(): boolean;
  /** Fortschritt nach jedem Bild (für die Anzeige; nur Zahlen). */
  progress?(p: MigrationProgress): void;
  /** Zu Beginn jedes Pakets im exklusiven Platz: Freigabe noch gültig? (z. B. Owner-Rolle). Wirft → Abbruch. */
  assertAllowed?(): void;
}

export interface MigrationProgress {
  runId: string;
  mode: 'dry-run' | 'apply';
  /** Bilder über ihrer Grenze, die dieser Lauf bearbeiten wird. */
  total: number;
  done: number;
  switched: number;
  /** Im Probelauf: als umstellbar vorhergesagt. */
  planned: number;
  skipped: number;
  failed: number;
  running: boolean;
}

export interface MigrationOptions {
  mode: 'dry-run' | 'apply';
  /** Paketgröße: so viele Bilder je exklusivem Platz, danach wird gespeichert (Standard 10; immer auch am Ende). */
  saveEvery?: number;
  /** Höchstens so viele Blobs bearbeiten (Tests, Stichproben). */
  maxBlobs?: number;
  /** Nur diese Blobs (Tests, Stichproben). */
  onlyBlobIds?: ReadonlySet<string>;
  /** Kooperativer Abbruch zwischen zwei Blobs. */
  shouldStop?(): boolean;
}

export type UsageClass = 'watch' | 'jewelry' | 'accessory' | 'repair' | 'order' | 'other';

export interface BlobPlan {
  tenantId: string;
  blobId: string;
  rendition: 'main' | 'thumbnail';
  currentGeneration: number;
  currentBytes: number;
  targetBytes: number;
  sourceHash: string;
  sourceGeneration: number;
  /** Fallback-Quelle einer Vorschau (eigene Original-Generation), falls das Hauptbild-Original fehlt. */
  fallbackSourceHash: string | null;
  usageClass: UsageClass;
}

export interface ClassTotals { n: number; before: number; after: number }

export interface MigrationReport {
  mode: 'dry-run' | 'apply';
  runId: string;
  startedAt: string;
  finishedAt: string;
  /** Blobs mit mindestens einer aktiven Nutzung, die geprüft wurden. */
  considered: number;
  skipped: Partial<Record<SkipReason, number>>;
  /** Über der Grenze und mit ≥ 10 % Ersparnis: im Probelauf vorhergesagt, im Lauf umgestellt. */
  eligible: number;
  switched: number;
  failed: number;
  stoppedEarly: boolean;
  /** Warum vorzeitig angehalten wurde (`MIGRATION_STOP_REQUESTED`, `MIGRATION_TRANSACTION_BUSY`, …). */
  stopCode?: string;
  /** Bilder über ihrer Grenze, die dieser Lauf bearbeiten sollte (Planung). */
  total: number;
  /** Planung je Fassung: Hauptbilder und Vorschauen getrennt (keine Doppelzählung). */
  plannedByRendition: { main: number; thumbnail: number };
  /** Summen über die umgestellten (bzw. im Probelauf umstellbaren) Blobs. */
  bytesBefore: number;
  bytesAfter: number;
  byClass: Partial<Record<UsageClass | 'thumbnail', ClassTotals>>;
  errors: Array<{ blobId: string; rendition: 'main' | 'thumbnail'; code: string }>;
}

export class ImageMigrationError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'ImageMigrationError';
  }
}

/** Mindestersparnis: darunter lohnt die zusätzliche Verlustkodierung nicht. */
export const MIGRATION_MIN_SAVING = 0.10;

/** Besitzer, deren Bilder migriert werden dürfen (Allow-List: alles andere bleibt unberührt). */
export const MIGRATABLE_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'product', 'repair', 'order', 'purchase_inbox', 'scrap_trade', 'scrap_trade_line', 'precious_metal',
]);

const TERMINAL_JOB_STATES = ['ready', 'failed', 'quarantined', 'expired'];

// ── kleine Abfragehelfer ─────────────────────────────────────────────────────

function rows(db: MigrationDb, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, params);
  if (r.length === 0) return [];
  return r[0].values.map((v) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < r[0].columns.length; i++) o[r[0].columns[i]] = v[i];
    return o;
  });
}

function tableExists(db: MigrationDb, name: string): boolean {
  return rows(db, `SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?`, [name]).length > 0;
}

// ── Vorbedingungen ───────────────────────────────────────────────────────────

/** Fail-closed: offene Aufnahmen oder eine laufende Rotation verbieten jedes Schreiben. */
export function assertMigrationPreconditions(db: MigrationDb): void {
  if (!tableExists(db, 'media_blob_generations')) throw new ImageMigrationError('MEDIA_SCHEMA_MISSING');
  if (tableExists(db, 'media_ingest_jobs')) {
    const open = rows(db, `SELECT COUNT(*) AS n FROM media_ingest_jobs WHERE state NOT IN (${TERMINAL_JOB_STATES.map(() => '?').join(',')})`, TERMINAL_JOB_STATES);
    if (Number(open[0]?.n ?? 0) > 0) throw new ImageMigrationError('MIGRATION_OPEN_INGEST_JOBS', `${open[0]?.n} open media ingest job(s) — finish or recover them first`);
  }
  if (tableExists(db, 'media_rotation_jobs')) {
    const rot = rows(db, `SELECT COUNT(*) AS n FROM media_rotation_jobs WHERE state NOT IN ('done','failed','quarantined')`);
    if (Number(rot[0]?.n ?? 0) > 0) throw new ImageMigrationError('MIGRATION_ROTATION_ACTIVE');
  }
}

// ── Planung (rein lesend) ────────────────────────────────────────────────────

interface Usage {
  kind: 'master' | 'variant';
  variantType: string | null;
  mediaId: string;
  securityClass: string;
  masterBlobId: string;
  links: Array<{ entityType: string; role: string; categoryId: string | null }>;
}

function categoryCase(db: MigrationDb): string {
  const parts: string[] = [];
  if (tableExists(db, 'products')) parts.push(`WHEN 'product' THEN (SELECT p.category_id FROM products p WHERE p.id = l.entity_id)`);
  if (tableExists(db, 'repairs')) parts.push(`WHEN 'repair' THEN (SELECT r.item_category_id FROM repairs r WHERE r.id = l.entity_id)`);
  if (tableExists(db, 'orders')) parts.push(`WHEN 'order' THEN (SELECT x.category_id FROM orders x WHERE x.id = l.entity_id)`);
  return parts.length ? `CASE l.entity_type ${parts.join(' ')} ELSE NULL END` : 'NULL';
}

function usageClassOf(links: Usage['links']): UsageClass {
  const l = links[0];
  if (!l) return 'other';
  if (l.entityType === 'repair') return 'repair';
  if (l.entityType === 'order') return 'order';
  if (l.entityType !== 'product') return 'other';
  if (l.categoryId === 'cat-watch') return 'watch';
  if (l.categoryId === 'cat-accessory') return 'accessory';
  if (l.categoryId && MAIN30_CATEGORY_IDS.has(l.categoryId)) return 'jewelry';
  return 'other';
}

/** Alle Blobs mit aktiver Nutzung → Entscheidung (Plan oder Grund zum Überspringen). */
export function planImageStoreMigration(db: MigrationDb): { plans: BlobPlan[]; skipped: Array<{ tenantId: string; blobId: string; reason: SkipReason }> } {
  const linkRows = rows(db, `SELECT l.tenant_id, l.media_id, l.entity_type, l.media_role, ${categoryCase(db)} AS category_id
      FROM media_links l WHERE l.deleted_at IS NULL`);
  const linksByMedia = new Map<string, Usage['links']>();
  for (const r of linkRows) {
    const k = `${r.tenant_id}|${r.media_id}`;
    const list = linksByMedia.get(k) ?? [];
    list.push({ entityType: String(r.entity_type), role: String(r.media_role), categoryId: r.category_id == null ? null : String(r.category_id) });
    linksByMedia.set(k, list);
  }
  const usages = new Map<string, Usage[]>();
  const add = (tenant: string, blob: string, u: Usage) => {
    const k = `${tenant}|${blob}`;
    const list = usages.get(k) ?? [];
    list.push(u);
    usages.set(k, list);
  };
  for (const o of rows(db, `SELECT tenant_id, media_id, master_blob_id, security_class FROM media_objects WHERE deleted_at IS NULL`)) {
    add(String(o.tenant_id), String(o.master_blob_id), {
      kind: 'master', variantType: null, mediaId: String(o.media_id), securityClass: String(o.security_class),
      masterBlobId: String(o.master_blob_id), links: linksByMedia.get(`${o.tenant_id}|${o.media_id}`) ?? [],
    });
  }
  for (const v of rows(db, `SELECT v.tenant_id, v.blob_id, v.variant_type, v.media_id, o.security_class, o.master_blob_id
      FROM media_variants v JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id AND o.deleted_at IS NULL
     WHERE v.deleted_at IS NULL`)) {
    add(String(v.tenant_id), String(v.blob_id), {
      kind: 'variant', variantType: String(v.variant_type), mediaId: String(v.media_id), securityClass: String(v.security_class),
      masterBlobId: String(v.master_blob_id), links: linksByMedia.get(`${v.tenant_id}|${v.media_id}`) ?? [],
    });
  }

  const plans: BlobPlan[] = [];
  const skipped: Array<{ tenantId: string; blobId: string; reason: SkipReason }> = [];
  for (const [key, us] of [...usages.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [tenantId, blobId] = key.split('|');
    // Nur Blobs, die überhaupt jemand sieht: mindestens eine verknüpfte Nutzung.
    if (!us.some((u) => u.links.length > 0)) continue;
    const skip = (reason: SkipReason) => skipped.push({ tenantId, blobId, reason });
    if (us.some((u) => u.securityClass !== 'internal' && u.securityClass !== 'public')) { skip('excluded_security'); continue; }
    if (us.some((u) => u.links.some((l) => l.role === 'identity_document'))) { skip('excluded_identity'); continue; }
    if (us.some((u) => u.links.some((l) => !MIGRATABLE_ENTITY_TYPES.has(l.entityType)))) { skip('excluded_entity'); continue; }
    if (us.some((u) => u.links.length === 0)) { skip('unlinked_usage'); continue; }
    const kinds = new Set(us.map((u) => (u.kind === 'master' ? 'master' : `variant:${u.variantType}`)));
    if (kinds.size !== 1 || (!kinds.has('master') && !kinds.has('variant:thumbnail'))) { skip('mixed_usage'); continue; }
    const rendition: 'main' | 'thumbnail' = kinds.has('master') ? 'main' : 'thumbnail';

    const cur = rows(db, `SELECT b.current_generation_no AS gen, b.blob_status, g.gen_status, g.byte_size, g.content_kind, g.extension,
        g.is_encrypted, g.stored_blob_hash
        FROM media_blobs b JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
       WHERE b.tenant_id = ? AND b.blob_id = ?`, [tenantId, blobId])[0];
    if (!cur || cur.blob_status !== 'present' || cur.gen_status !== 'available') { skip('not_current_available'); continue; }
    if (cur.content_kind !== 'raster_image' || cur.extension !== 'jpg') { skip('not_jpeg_raster'); continue; }
    if (Number(cur.is_encrypted) !== 0) { skip('encrypted'); continue; }

    // Zielgrenze: bei mehreren Nutzungen die GRÖSSTE (die sichere) Grenze.
    const profiles: MediaSizeProfile[] = us.flatMap((u) => u.links.map((l) => sizeProfileFor({ categoryId: l.entityType === 'product' || l.entityType === 'repair' || l.entityType === 'order' ? l.categoryId : null, role: l.role, securityClass: u.securityClass })));
    const target = Math.max(...profiles.map((p) => (rendition === 'main' ? SIZE_PROFILE_LIMITS[p].main : SIZE_PROFILE_LIMITS[p].thumbnail)));
    const currentBytes = Number(cur.byte_size);
    if (currentBytes <= target) { skip('already_small'); continue; }

    // Quelle = die ÄLTESTE noch vorhandene Fassung (das Original), nie eine schon verkleinerte.
    const original = (blob: string) => rows(db, `SELECT generation_no, stored_blob_hash, extension FROM media_blob_generations
        WHERE tenant_id = ? AND blob_id = ? AND gen_status IN ('available','superseded') AND content_kind = 'raster_image'
        ORDER BY generation_no ASC LIMIT 1`, [tenantId, blob])[0];
    const own = original(blobId);
    let src = own;
    if (rendition === 'thumbnail') {
      const masters = [...new Set(us.map((u) => u.masterBlobId))].sort();
      const m = masters.length ? original(masters[0]) : undefined;
      if (m && m.extension === 'jpg') src = m;
    }
    if (!src || src.extension !== 'jpg') { skip('not_jpeg_raster'); continue; }
    plans.push({
      tenantId, blobId, rendition,
      currentGeneration: Number(cur.gen), currentBytes, targetBytes: target,
      sourceHash: String(src.stored_blob_hash), sourceGeneration: Number(src.generation_no),
      fallbackSourceHash: rendition === 'thumbnail' && own && own.extension === 'jpg' && own.stored_blob_hash !== src.stored_blob_hash ? String(own.stored_blob_hash) : null,
      usageClass: rendition === 'main' ? usageClassOf(us[0].links) : 'other',
    });
  }
  return { plans, skipped };
}

// ── Umstellen (eine Transaktion je Blob) ────────────────────────────────────

/**
 * Generation n+1 anlegen, Zeiger umstellen, n → superseded. Wirft bei jedem Widerspruch (Rollback).
 * Ist schon eine Transaktion offen (fremder Schreiber), wird NICHT geschachtelt: `MIGRATION_TRANSACTION_BUSY`,
 * ohne irgendeine Zeile zu berühren — ein zweites BEGIN wäre ein Fehler, ein Mitschreiben in die fremde
 * Transaktion hinge die Umstellung an deren Schicksal.
 */
export function switchBlobGeneration(db: MigrationDb, p: BlobPlan, r: RecompressOutcome, now: string, transactionActive?: () => boolean): number {
  if (transactionActive?.()) throw new ImageMigrationError('MIGRATION_TRANSACTION_BUSY');
  // Auch ohne Kontext-Wissen: scheitert BEGIN, ist eine Transaktion offen — dann NICHT zurückrollen (das wäre
  // die fremde), sondern unverändert melden.
  try { db.run('BEGIN'); } catch (e) { throw new ImageMigrationError('MIGRATION_TRANSACTION_BUSY', String((e as Error)?.message ?? e)); }
  try {
    const cur = rows(db, `SELECT current_generation_no AS gen FROM media_blobs WHERE tenant_id = ? AND blob_id = ? AND blob_status = 'present'`, [p.tenantId, p.blobId])[0];
    if (!cur || Number(cur.gen) !== p.currentGeneration) throw new ImageMigrationError('MIGRATION_BLOB_CHANGED');
    const clash = rows(db, `SELECT blob_id FROM media_blob_generations WHERE tenant_id = ? AND storage_key = ?`, [p.tenantId, r.storage_key])[0];
    if (clash) throw new ImageMigrationError('MIGRATION_STORAGE_KEY_TAKEN');
    const next = Number(rows(db, `SELECT MAX(generation_no) AS m FROM media_blob_generations WHERE tenant_id = ? AND blob_id = ?`, [p.tenantId, p.blobId])[0]?.m ?? 0) + 1;
    db.run(
      `INSERT INTO media_blob_generations
        (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension,
         width, height, is_encrypted, dek_version, gen_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'available', ?)`,
      [p.tenantId, p.blobId, next, r.storage_key, r.hash, r.byte_size, r.content_kind, r.mime_type, r.extension, r.width, r.height, now],
    );
    db.run(`UPDATE media_blobs SET current_generation_no = ?, updated_at = ? WHERE tenant_id = ? AND blob_id = ? AND current_generation_no = ?`,
      [next, now, p.tenantId, p.blobId, p.currentGeneration]);
    db.run(`UPDATE media_blob_generations SET gen_status = 'superseded', superseded_at = ? WHERE tenant_id = ? AND blob_id = ? AND generation_no = ? AND gen_status = 'available'`,
      [now, p.tenantId, p.blobId, p.currentGeneration]);
    const after = rows(db, `SELECT b.current_generation_no AS gen, g.gen_status AS st, g.stored_blob_hash AS h FROM media_blobs b
        JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
       WHERE b.tenant_id = ? AND b.blob_id = ?`, [p.tenantId, p.blobId])[0];
    const old = rows(db, `SELECT gen_status AS st FROM media_blob_generations WHERE tenant_id = ? AND blob_id = ? AND generation_no = ?`, [p.tenantId, p.blobId, p.currentGeneration])[0];
    if (!after || Number(after.gen) !== next || after.st !== 'available' || after.h !== r.hash || old?.st !== 'superseded') {
      throw new ImageMigrationError('MIGRATION_SWITCH_NOT_APPLIED');
    }
    db.run('COMMIT');
    return next;
  } catch (e) {
    try { db.run('ROLLBACK'); } catch { /* schon zurückgerollt */ }
    throw e;
  }
}

function codeOf(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  if (typeof c === 'string') return c;
  const m = String((e as { message?: unknown })?.message ?? e);
  const hit = /[A-Z][A-Z0-9_]{6,}/.exec(m);
  return hit ? hit[0] : 'MIGRATION_UNKNOWN_ERROR';
}

/** Ein Bild ist im exklusiven Platz bearbeitet: wie ging es aus? `busy` = fremde Transaktion offen, nichts getan. */
type BlobOutcome = 'switched' | 'planned' | 'skipped' | 'failed' | 'busy';

/** Der Lauf (Probelauf oder echt). Liefert den Bericht; das Protokoll geht an `deps.journal`. */
export async function runImageStoreMigration(deps: MigrationDeps, opts: MigrationOptions): Promise<MigrationReport> {
  const now = deps.now ?? (() => new Date().toISOString());
  const runId = `img-mig-${now().replace(/[^0-9]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  const report: MigrationReport = {
    mode: opts.mode, runId, startedAt: now(), finishedAt: '', considered: 0, skipped: {}, eligible: 0, switched: 0,
    failed: 0, stoppedEarly: false, total: 0, plannedByRendition: { main: 0, thumbnail: 0 },
    bytesBefore: 0, bytesAfter: 0, byClass: {}, errors: [],
  };
  const exclusive = deps.exclusive ? <T>(fn: () => Promise<T>) => deps.exclusive!(fn) : <T>(fn: () => Promise<T>) => fn();
  const prog: MigrationProgress = { runId, mode: opts.mode, total: 0, done: 0, switched: 0, planned: 0, skipped: 0, failed: 0, running: true };
  const emit = () => { try { deps.progress?.({ ...prog }); } catch { /* Anzeige darf den Lauf nie stören */ } };

  // Planung im exklusiven Platz: derselbe Stand, auf den die Pakete danach schreiben.
  const { plans } = await exclusive(async () => {
    deps.assertAllowed?.();
    if (opts.mode === 'apply') assertMigrationPreconditions(deps.db);
    const { plans: all, skipped } = planImageStoreMigration(deps.db);
    report.considered = all.length + skipped.length;
    for (const s of skipped) report.skipped[s.reason] = (report.skipped[s.reason] ?? 0) + 1;
    return { plans: all.filter((p) => !opts.onlyBlobIds || opts.onlyBlobIds.has(p.blobId)).slice(0, opts.maxBlobs ?? Infinity) };
  });
  report.total = prog.total = plans.length;
  for (const p of plans) report.plannedByRendition[p.rendition]++;
  await deps.journal({ at: now(), runId, event: 'start', reason: `${opts.mode} total=${plans.length}` });
  emit();

  const batchSize = Math.max(1, opts.saveEvery ?? 10);
  const producedKeys = new Set<string>();
  const keyTaken = (k: string) => producedKeys.has(k) || rows(deps.db, 'SELECT 1 AS x FROM media_blob_generations WHERE storage_key = ?', [k]).length > 0;
  const tally = (p: BlobPlan, after: number) => {
    const k: UsageClass | 'thumbnail' = p.rendition === 'thumbnail' ? 'thumbnail' : p.usageClass;
    const t = (report.byClass[k] ??= { n: 0, before: 0, after: 0 });
    t.n++; t.before += p.currentBytes; t.after += after;
    report.bytesBefore += p.currentBytes; report.bytesAfter += after;
  };
  const fail = async (p: BlobPlan, code: string): Promise<BlobOutcome> => {
    report.failed++; prog.failed++; report.errors.push({ blobId: p.blobId, rendition: p.rendition, code });
    await deps.journal({ at: now(), runId, event: 'failed', blobId: p.blobId, rendition: p.rendition, reason: code });
    return 'failed';
  };

  async function one(p: BlobPlan): Promise<BlobOutcome> {
    // Vor dem Veröffentlichen: ist eine fremde Transaktion offen, entsteht nicht einmal eine Datei.
    if (opts.mode === 'apply' && deps.transactionActive?.()) return 'busy';
    const threshold = Math.floor(p.currentBytes * (1 - MIGRATION_MIN_SAVING));
    const args = (sourceHash: string): RecompressArgs => ({
      tenantScope: p.tenantId, sourceHash, sourceExtension: 'jpg', rendition: p.rendition, maxBytes: p.targetBytes,
      publish: opts.mode === 'apply', publishOnlyBelow: threshold,
    });
    let r: RecompressOutcome;
    try {
      try {
        r = await deps.recompress(args(p.sourceHash));
      } catch (e) {
        // Vorschau: fehlt das Hauptbild-Original, aus der eigenen Original-Fassung rechnen.
        if (!p.fallbackSourceHash || codeOf(e) !== 'MEDIA_FILE_MISSING') throw e;
        r = await deps.recompress(args(p.fallbackSourceHash));
      }
    } catch (e) {
      return fail(p, codeOf(e));
    }
    if (r.byte_size > p.targetBytes || r.byte_size >= threshold) {
      report.skipped.saving_below_10pct = (report.skipped.saving_below_10pct ?? 0) + 1; prog.skipped++;
      await deps.journal({ at: now(), runId, event: 'skipped', blobId: p.blobId, rendition: p.rendition, reason: 'saving_below_10pct', fromBytes: p.currentBytes, toBytes: r.byte_size });
      return 'skipped';
    }
    if (keyTaken(r.storage_key)) {
      report.skipped.duplicate_content = (report.skipped.duplicate_content ?? 0) + 1; prog.skipped++;
      await deps.journal({ at: now(), runId, event: 'skipped', blobId: p.blobId, rendition: p.rendition, reason: 'duplicate_content' });
      return 'skipped';
    }
    producedKeys.add(r.storage_key);
    report.eligible++;
    if (opts.mode === 'dry-run') {
      tally(p, r.byte_size); prog.planned++;
      await deps.journal({ at: now(), runId, event: 'planned', blobId: p.blobId, rendition: p.rendition, fromBytes: p.currentBytes, toBytes: r.byte_size });
      return 'planned';
    }
    if (!r.published) return fail(p, 'MIGRATION_NOT_PUBLISHED');
    try {
      const next = switchBlobGeneration(deps.db, p, r, now(), deps.transactionActive ? () => deps.transactionActive!() : undefined);
      report.switched++; prog.switched++; tally(p, r.byte_size);
      await deps.journal({ at: now(), runId, event: 'switched', blobId: p.blobId, rendition: p.rendition, fromGeneration: p.currentGeneration, toGeneration: next, fromBytes: p.currentBytes, toBytes: r.byte_size });
      return 'switched';
    } catch (e) {
      // Fremde Transaktion: die veröffentlichte Datei bleibt bitgleich wiederverwendbar; nicht als Fehler zählen.
      if (codeOf(e) === 'MIGRATION_TRANSACTION_BUSY') return 'busy';
      return fail(p, codeOf(e));
    }
  }

  let i = 0;
  try {
    while (i < plans.length) {
      if (opts.shouldStop?.()) { report.stopCode = 'MIGRATION_STOP_REQUESTED'; break; }
      const stop = await exclusive(async (): Promise<string | null> => {
        let unsaved = 0;
        try {
          deps.assertAllowed?.();
          for (let n = 0; n < batchSize && i < plans.length; n++) {
            if (n > 0 && opts.shouldStop?.()) return 'MIGRATION_STOP_REQUESTED';
            const out = await one(plans[i]);
            if (out === 'busy') return 'MIGRATION_TRANSACTION_BUSY';
            i++; prog.done++;
            if (out === 'switched') unsaved++;
            emit();
          }
          return null;
        } finally {
          // Jedes Paket endet gespeichert — auch bei Abbruch oder Fehler mitten im Paket.
          if (opts.mode === 'apply' && unsaved > 0) await deps.saveDurably();
        }
      });
      if (stop) { report.stopCode = stop; break; }
    }
  } finally {
    report.stoppedEarly = i < plans.length;
    prog.running = false; emit();
  }
  if (report.stoppedEarly) await deps.journal({ at: now(), runId, event: 'stopped', reason: report.stopCode ?? 'MIGRATION_STOPPED' });
  report.finishedAt = now();
  await deps.journal({ at: now(), runId, event: 'done', reason: `switched=${report.switched} failed=${report.failed} done=${i}/${plans.length}` });
  return report;
}

// ── Bestandsübersicht (rein lesend) ─────────────────────────────────────────

export interface ImageStoreInventory {
  /** Alle vorhandenen Blobs (`blob_status = 'present'`) — jede Datei genau einmal gezählt. */
  blobsPresent: number;
  /** Nach Fassung: Hauptbild eines Medienobjekts, Vorschau, andere Variante, ohne lebendes Objekt. */
  byRendition: { main: number; thumbnail: number; otherVariant: number; noObject: number };
  /** Davon sichtbar (mindestens eine aktive Verknüpfung) bzw. nur noch historisch (Bild entfernt). */
  linked: { main: number; thumbnail: number; otherVariant: number };
  notLinked: { main: number; thumbnail: number; otherVariant: number; noObject: number };
  /** Entscheidung der Planung für die sichtbaren Blobs, je Fassung. */
  decision: {
    main: { planned: number } & Partial<Record<SkipReason, number>>;
    thumbnail: { planned: number } & Partial<Record<SkipReason, number>>;
    otherVariant: Partial<Record<SkipReason, number>>;
  };
  /** Prüfsumme: linked + notLinked = blobsPresent; geplant + übersprungen = linked. */
  balanced: boolean;
}

/** Jeder vorhandene Blob genau einmal: Fassung, sichtbar ja/nein, Entscheidung der Planung. */
export function inventoryImageStore(db: MigrationDb): ImageStoreInventory {
  const present = rows(db, `SELECT tenant_id, blob_id FROM media_blobs WHERE blob_status = 'present'`).map((r) => `${r.tenant_id}|${r.blob_id}`);
  const masterOf = new Map<string, boolean>();   // blob → hat ein lebendes Objekt verknüpfte Nutzung?
  const variantOf = new Map<string, { thumb: boolean; linked: boolean }>();
  const linkedMedia = new Set(rows(db, `SELECT DISTINCT tenant_id || '|' || media_id AS k FROM media_links WHERE deleted_at IS NULL`).map((r) => String(r.k)));
  for (const o of rows(db, `SELECT tenant_id, media_id, master_blob_id FROM media_objects WHERE deleted_at IS NULL`)) {
    const k = `${o.tenant_id}|${o.master_blob_id}`;
    masterOf.set(k, (masterOf.get(k) ?? false) || linkedMedia.has(`${o.tenant_id}|${o.media_id}`));
  }
  for (const v of rows(db, `SELECT v.tenant_id, v.blob_id, v.variant_type, v.media_id FROM media_variants v
      JOIN media_objects o ON o.tenant_id = v.tenant_id AND o.media_id = v.media_id AND o.deleted_at IS NULL WHERE v.deleted_at IS NULL`)) {
    const k = `${v.tenant_id}|${v.blob_id}`;
    const prev = variantOf.get(k) ?? { thumb: true, linked: false };
    variantOf.set(k, { thumb: prev.thumb && v.variant_type === 'thumbnail', linked: prev.linked || linkedMedia.has(`${v.tenant_id}|${v.media_id}`) });
  }
  const { plans, skipped } = planImageStoreMigration(db);
  const decided = new Map<string, string>();
  for (const p of plans) decided.set(`${p.tenantId}|${p.blobId}`, 'planned');
  for (const s of skipped) decided.set(`${s.tenantId}|${s.blobId}`, s.reason);

  const inv: ImageStoreInventory = {
    blobsPresent: present.length,
    byRendition: { main: 0, thumbnail: 0, otherVariant: 0, noObject: 0 },
    linked: { main: 0, thumbnail: 0, otherVariant: 0 },
    notLinked: { main: 0, thumbnail: 0, otherVariant: 0, noObject: 0 },
    decision: { main: { planned: 0 }, thumbnail: { planned: 0 }, otherVariant: {} },
    balanced: false,
  };
  for (const k of present) {
    // Ein Blob, der Hauptbild UND Variante ist, zählt als Hauptbild (die Planung überspringt ihn als gemischt).
    const kind: 'main' | 'thumbnail' | 'otherVariant' | 'noObject' = masterOf.has(k) ? 'main' : variantOf.has(k) ? (variantOf.get(k)!.thumb ? 'thumbnail' : 'otherVariant') : 'noObject';
    inv.byRendition[kind]++;
    const linked = kind === 'main' ? masterOf.get(k)! || (variantOf.get(k)?.linked ?? false) : kind === 'noObject' ? false : variantOf.get(k)!.linked;
    if (kind === 'noObject' || !linked) { inv.notLinked[kind]++; continue; }
    inv.linked[kind]++;
    const d = decided.get(k) ?? 'unlinked_usage';
    const bucket = inv.decision[kind] as Record<string, number>;
    bucket[d] = (bucket[d] ?? 0) + 1;
  }
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  inv.balanced = sum(inv.linked) + sum(inv.notLinked) === inv.blobsPresent
    && sum(inv.decision.main) === inv.linked.main && sum(inv.decision.thumbnail) === inv.linked.thumbnail
    && sum(inv.decision.otherVariant as Record<string, number>) === inv.linked.otherVariant;
  return inv;
}

// ── Prüfung danach ───────────────────────────────────────────────────────────

/** Ein Fingerabdruck der Zeilen, die eine Migration NIE ändern darf. */
export function migrationInvariantDigest(db: MigrationDb): Record<string, number | string> {
  const one = (sql: string) => rows(db, sql)[0] ?? {};
  const n = (sql: string) => Number(Object.values(one(sql))[0] ?? 0);
  const out: Record<string, number | string> = {
    media_objects: n('SELECT COUNT(*) FROM media_objects'),
    media_links_active: n('SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL'),
    media_variants: n('SELECT COUNT(*) FROM media_variants'),
    media_blobs: n('SELECT COUNT(*) FROM media_blobs'),
    links_sig: String(one(`SELECT group_concat(link_id || ':' || media_id || ':' || sort_order || ':' || is_primary, ',') AS s FROM (SELECT * FROM media_links ORDER BY link_id)`).s ?? ''),
    objects_sig: String(one(`SELECT group_concat(media_id || ':' || master_blob_id, ',') AS s FROM (SELECT * FROM media_objects ORDER BY media_id)`).s ?? ''),
    variants_sig: String(one(`SELECT group_concat(media_id || ':' || blob_id, ',') AS s FROM (SELECT * FROM media_variants ORDER BY media_id, variant_type)`).s ?? ''),
  };
  if (tableExists(db, 'sync_changelog')) out.sync_changelog = n('SELECT COUNT(*) FROM sync_changelog');
  if (tableExists(db, 'audit_log')) out.audit_log = n('SELECT COUNT(*) FROM audit_log');
  if (tableExists(db, 'products')) {
    out.products = n('SELECT COUNT(*) FROM products');
    out.products_media_sig = String(one(`SELECT group_concat(id || ':' || IFNULL(image_hash,'') || ':' || length(IFNULL(image_embedding,'')) || ':' || IFNULL(updated_at,''), ',') AS s FROM (SELECT * FROM products ORDER BY id)`).s ?? '');
  }
  return out;
}

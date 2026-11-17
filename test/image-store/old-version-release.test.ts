// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER Phase 5B — alte Bildfassungen für den vorhandenen Medien-GC freigeben.
// Run: node test/image-store/old-version-release.test.ts
//
// Echtes Medienschema (sql.js, alle Trigger), echter Coordinator, echte Migration (Rust durch Ersatz). Geprüft:
// Kandidaten = genau die alten Fassungen; Ausweis, Backup-Pin, Einkaufs-Ausweis, entfernte Fotos und aktuelle Fassungen
// bleiben; Probelauf schreibt nichts; Lauf nur über erlaubte Übergänge, nichts anderes ändert sich; Stop/Fortsetzung;
// fail-closed (offene Aufnahme, fremde Transaktion, geänderter Stand, unverifizierte aktuelle Datei); Owner-Pfad,
// Wartungsmodus, Protokoll, gemeinsame Laufsperre; der Rust-GC gibt danach genau diese Dateien frei.
// ════════════════════════════════════════════════════════════════════════════
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database' || ((specifier === './database' || specifier === '../db/database') && context.parentURL)) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);
const ls = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'b1', userId: 'u1' })]]);
const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, String(v)); }, removeItem: (k: string) => { ls.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const { MediaDbCoordinator } = await import('../../src/core/media/coordinator.ts');
const eng = await import('../../src/core/media/image-store-migration.ts');
const rel = await import('../../src/core/media/old-version-release.ts');
const wiring = await import('../../src/core/media/image-store-migration-wiring.ts');
type MigrationDb = import('../../src/core/media/image-store-migration.ts').MigrationDb;
type RecompressArgs = import('../../src/core/media/image-store-migration.ts').RecompressArgs;
type RecompressOutcome = import('../../src/core/media/image-store-migration.ts').RecompressOutcome;
type ReleaseCandidate = import('../../src/core/media/old-version-release.ts').ReleaseCandidate;

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
const pad64 = (s: string) => (s.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
const key = (t: string, h: string) => `${t}/${h.slice(0, 2)}/${h}.jpg`;
const desc = (hash: string, size: number) => ({ hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 1200, height: 900 });
function q(db: any, sql: string, p: unknown[] = []): any[] {
  const r = db.exec(sql, p); if (!r.length) return [];
  return r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]])));
}
class Gw {
  jobs = new Map<string, any>(); sizes = new Map<string, number>();
  preset(t: string, req: string, main: any, thumb: any) { this.jobs.set(`${t}::${req}`, { main, thumb }); this.sizes.set(main.hash, main.size); this.sizes.set(thumb.hash, thumb.size); }
  async prepareStockImage(i: any) { const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`); return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size) }; }
  async commitStockImage(i: any) { const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`); return { state: 'published', main_descriptor: desc(j.main.hash, j.main.size), thumbnail_descriptor: desc(j.thumb.hash, j.thumb.size), main_storage_key: key(i.tenantScope, j.main.hash), thumbnail_storage_key: key(i.tenantScope, j.thumb.hash) }; }
  async abortStockImage(i: any) { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: any) { const n = this.sizes.get(i.hash) ?? 3; return { bytes: new Uint8Array(n), hash: i.hash, byte_size: n, mime_type: 'image/jpeg', extension: 'jpg' }; }
  async recoverMediaIngests() { return []; }
}
function fakeRust() {
  return async (a: RecompressArgs): Promise<RecompressOutcome> => {
    const hash = pad64(`e${a.rendition === 'main' ? 'a' : 'b'}${a.sourceHash.slice(0, 20)}${a.maxBytes}`);
    const size = Math.floor(a.maxBytes * 0.7);
    return { rendition: a.rendition, source_hash: a.sourceHash, source_byte_size: 0, hash, byte_size: size, width: 900, height: 600,
      extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key(a.tenantScope, hash), published: a.publish };
  };
}

/** Bestand NACH einer Migration: 8 umgestellte Artikel (alte Fassungen superseded), 1 kleines Bild, 1 Ausweis, 1 entferntes Foto. */
async function world(SQL: any, n = 8) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`); db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`); db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE) as Array<{ table: string; idCol: string }>) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
  for (const c of ['images TEXT', 'category_id TEXT', 'image_hash TEXT', 'image_embedding TEXT', 'updated_at TEXT', 'purchase_price REAL']) db.run(`ALTER TABLE products ADD COLUMN ${c}`);
  db.run(`ALTER TABLE repairs ADD COLUMN item_category_id TEXT`); db.run(`ALTER TABLE orders ADD COLUMN category_id TEXT`);
  db.run(`ALTER TABLE purchases ADD COLUMN supplier_snapshot TEXT`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, table_name TEXT, record_id TEXT, data TEXT)`);
  db.run(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY, entity_type TEXT, entity_id TEXT)`);
  db.run(`CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY, amount REAL)`);
  db.run(`INSERT INTO tenants VALUES ('t1')`); db.run(`INSERT INTO branches VALUES ('b1','t1')`);
  db.run(`INSERT INTO ledger_entries (amount) VALUES (125.5), (-125.5)`);
  db.run(`INSERT INTO sync_changelog (table_name, record_id, data) VALUES ('products','p-w0','{}')`);
  applyMediaSchema(db);
  const gw = new Gw(); const coord = new MediaDbCoordinator(db, gw as never);
  let k = 0;
  const add = async (entityType: string, id: string, cat: string | null, mainSize: number, thumbSize: number, extra: Record<string, unknown> = {}) => {
    k++;
    if (entityType === 'product') db.run(`INSERT INTO products (id, branch_id, images, category_id, updated_at, purchase_price) VALUES (?, 'b1', '[]', ?, '2026-11-10', 1000)`, [id, cat]);
    if (entityType === 'customer') db.run(`INSERT INTO customers (id, branch_id) VALUES (?, 'b1')`, [id]);
    const req = `req-${id}`; const main = { hash: pad64(`a${k}a${id.length}`), size: mainSize }; const thumb = { hash: pad64(`b${k}b${id.length}`), size: thumbSize };
    gw.preset('t1', req, main, thumb);
    return coord.finalize({ tenantId: 't1', branchId: 'b1', entityType, entityId: id, scopeKind: 'branch', role: 'stock_image', ingestRequestId: req, requestHash: pad64(`c${k}`), isPrimary: true, sortOrder: 0, ...extra } as never);
  };
  for (let i = 0; i < n; i++) await add('product', `p-w${i}`, i % 2 ? 'cat-watch' : 'cat-gold-jewelry', 90_000, 16_000);
  await add('product', 'p-small', 'cat-watch', 40_000, 8_000);
  await add('customer', 'c1', null, 95_000, 19_000, { role: 'identity_document', securityClass: 'sensitive' });
  await add('product', 'p-old', 'cat-watch', 92_000, 18_000);
  db.run(`UPDATE media_links SET deleted_at = '2026-11-01' WHERE entity_id = 'p-old'`);
  // die Migration (echter Kern) erzeugt die alten Fassungen
  const rep = await eng.runImageStoreMigration({ db: db as MigrationDb, recompress: fakeRust(), journal: () => {}, saveDurably: async () => {} }, { mode: 'apply' });
  return { db, gw, migrated: rep.switched };
}
const statuses = (db: any) => Object.fromEntries(q(db, `SELECT gen_status AS s, COUNT(*) AS n FROM media_blob_generations GROUP BY gen_status`).map((r) => [r.s, r.n]));
/** Inhalt aller Tabellen außer den Generationen (Fachdaten, Zuordnungen, Protokolle). */
function digestOthers(db: any): string {
  const out: string[] = [];
  for (const t of q(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'media_blob_generations' ORDER BY name`)) {
    out.push(t.name + ':' + JSON.stringify(db.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`)));
  }
  return out.join('|');
}
/** Was der Rust-GC schützt (reachability::preserved_keys, mit Pin-Tabelle). */
const preserved = (db: any) => new Set(q(db, `SELECT g.storage_key AS k FROM media_blob_generations g WHERE g.gen_status <> 'deleted'
  UNION SELECT g.storage_key FROM media_blob_generations g JOIN media_backup_generation_pins p ON p.tenant_id = g.tenant_id AND p.blob_id = g.blob_id AND p.generation_no = g.generation_no WHERE g.gen_status = 'deleted'`).map((r) => String(r.k)));
const currentKeys = (db: any) => new Set(q(db, `SELECT g.storage_key AS k FROM media_blobs b JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no`).map((r) => String(r.k)));
const okVerify = async (_c: ReleaseCandidate) => {};
const S = JSON.stringify;
/** Die ECHTE Rust-Schutzmenge: SQL-Texte aus `src-tauri/src/media/reachability.rs`, hier in sql.js ausgeführt. */
function rustConst(name: string): string {
  const src = readFileSync(join(repo, 'src-tauri/src/media/reachability.rs'), 'utf8');
  const start = src.indexOf(`const ${name}: &str = "`);
  if (start < 0) throw new Error('Rust-Konstante fehlt: ' + name);
  const from = src.indexOf('"', start) + 1;
  const to = src.indexOf('";', from);
  return src.slice(from, to).replace(/\\\r?\n\s*/g, '');
}
function preservedRust(db: any): Set<string> {
  const base = rustConst('PRESERVED_GENERATIONS_SQL') + rustConst('RELEASED_BLOB_EXCLUSION');
  const sql = `${base} UNION ${rustConst('PRESERVED_PINNED_DELETED_SQL')}`;
  return new Set(q(db, sql).map((r) => String(r.storage_key ?? Object.values(r)[0])));
}
function digestExcept(db: any, skip: string[]): string {
  const out: string[] = [];
  for (const t of q(db, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)) {
    if (skip.includes(t.name)) continue;
    out.push(t.name + ':' + JSON.stringify(db.exec(`SELECT * FROM "${t.name}" ORDER BY rowid`)));
  }
  return out.join('|');
}


async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: (f: string) => join(repo, 'node_modules', 'sql.js', 'dist', f) });

  // ── §1 Planung: Kandidaten = genau die alten Fassungen; was bleibt, bleibt ──────────────────────
  { console.log('  … §1');
    const { db, migrated } = await world(SQL);
    const sup = q(db, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE gen_status = 'superseded'`)[0].n;
    const plan = rel.planOldVersionRelease(db as MigrationDb);
    ok(migrated === 16 && sup === 16 && plan.candidates.length === 16, `§1 16 alte Fassungen (8 Haupt + 8 Vorschau) = 16 Kandidaten (${migrated}/${sup}/${plan.candidates.length})`);
    ok(plan.candidates.filter((c) => c.rendition === 'main').length === 8 && plan.candidates.filter((c) => c.rendition === 'thumbnail').length === 8, '§1 Haupt-/Vorschaubild richtig erkannt');
    ok(plan.candidates.every((c) => c.currentGeneration > c.generationNo && c.scope === 't1'), '§1 jede Kandidatin ist älter als die aktuelle Fassung');
    const cur = currentKeys(db);
    ok(plan.candidates.every((c) => !cur.has(c.storageKey)), '§1 keine aktuelle Fassung ist Kandidatin');
    ok(plan.kept.currentIdentity.files === 2 && plan.kept.currentRemovedPhotos.files === 2 && plan.kept.currentInUse.files === 18,
      `§1 bleiben: Ausweis 2, entferntes Foto 2, in Gebrauch 18 (${JSON.stringify(plan.kept)})`);
  }

  // ── §2 Ausschlüsse: Ausweis, Backup-Pin, Einkaufs-Ausweis, Speicherschlüssel ──────────────────────
  { console.log('  … §2');
    const { db } = await world(SQL);
    // Ausweis mit einer alten Fassung (direkt über den Kern umgestellt — die Migration fasst Ausweise nie an)
    const idBlob = q(db, `SELECT master_blob_id AS b FROM media_objects WHERE security_class = 'sensitive'`)[0].b;
    const g1 = q(db, `SELECT * FROM media_blob_generations WHERE blob_id = ?`, [idBlob])[0];
    const nh = pad64('ff1d' + idBlob.slice(0, 10));
    eng.switchBlobGeneration(db as MigrationDb, { tenantId: 't1', blobId: idBlob, rendition: 'main', currentGeneration: 1, currentBytes: Number(g1.byte_size), targetBytes: 60_000,
      sourceHash: g1.stored_blob_hash, sourceGeneration: 1, fallbackSourceHash: null, usageClass: 'other' } as never,
      { rendition: 'main', source_hash: g1.stored_blob_hash, source_byte_size: 0, hash: nh, byte_size: 50_000, width: 900, height: 600, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key('t1', nh), published: true } as never,
      '2026-11-17T10:00:00Z');
    // Einkaufs-Ausweis: ein Einkauf hat genau eine alte Fassung eines Artikelbilds eingefroren (künstlich, Regelprobe)
    const pm = q(db, `SELECT o.media_id AS m, o.master_blob_id AS b FROM media_objects o JOIN media_links l ON l.media_id = o.media_id WHERE l.entity_id = 'p-w0'`)[0];
    db.run(`INSERT INTO purchases (id, supplier_snapshot) VALUES ('pu1', ?)`, [JSON.stringify({ identity: { mediaId: pm.m, generationNo: 1, blobHash: 'x' } })]);
    // Backup-Pin: eine Sicherung pinnt die damals AKTUELLE Fassung; danach wird umgestellt → die alte Fassung ist gepinnt
    const pinned = q(db, `SELECT o.master_blob_id AS b FROM media_objects o JOIN media_links l ON l.media_id = o.media_id WHERE l.entity_id = 'p-small'`)[0].b;
    db.run(`INSERT INTO media_backup_sets (tenant_id, backup_id, status, created_at) VALUES ('t1','bk1','in_progress','2026-11-17')`);
    db.run(`INSERT INTO media_backup_generation_pins (tenant_id, backup_id, blob_id, generation_no, pinned_at) VALUES ('t1','bk1',?,1,'2026-11-17')`, [pinned]);
    const gp = q(db, `SELECT * FROM media_blob_generations WHERE blob_id = ?`, [pinned])[0];
    const ph = pad64('ff2e' + pinned.slice(0, 10));
    eng.switchBlobGeneration(db as MigrationDb, { tenantId: 't1', blobId: pinned, rendition: 'main', currentGeneration: 1, currentBytes: Number(gp.byte_size), targetBytes: 30_000,
      sourceHash: gp.stored_blob_hash, sourceGeneration: 1, fallbackSourceHash: null, usageClass: 'watch' } as never,
      { rendition: 'main', source_hash: gp.stored_blob_hash, source_byte_size: 0, hash: ph, byte_size: 25_000, width: 900, height: 600, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: key('t1', ph), published: true } as never,
      '2026-11-17T10:00:00Z');
    const plan = rel.planOldVersionRelease(db as MigrationDb);
    const why = (b: string) => plan.excluded.filter((e) => e.blobId === b).map((e) => e.reason);
    ok(why(idBlob).includes('security_class') && !plan.candidates.some((c) => c.blobId === idBlob), '§2 Ausweis-Fassung bleibt (Sicherheitsklasse)');
    ok(why(pm.b).includes('purchase_identity') && !plan.candidates.some((c) => c.blobId === pm.b), '§2 vom Einkauf eingefrorene Fassung bleibt');
    ok(why(pinned).includes('backup_pinned') && !plan.candidates.some((c) => c.blobId === pinned), '§2 Backup-Pin hält die alte Fassung');
    ok(plan.candidates.length === 15 && plan.excluded.length === 3, `§2 übrige Kandidaten 15, ausgeschlossen 3 (${plan.candidates.length}/${plan.excluded.length})`);
    let pinGuard = '';
    try { rel.releaseOldVersion(db as MigrationDb, { ...plan.candidates[0], blobId: pinned, generationNo: 1, currentGeneration: 2, currentHash: ph }, '2026-11-17'); } catch (e) { pinGuard = String((e as Error).message); }
    ok(/MEDIA_GENERATION_BACKUP_PINNED/.test(pinGuard) && q(db, `SELECT gen_status AS s FROM media_blob_generations WHERE blob_id = ? AND generation_no = 1`, [pinned])[0].s === 'superseded',
      '§2 selbst direkt aufgerufen: der Schema-Pin-Riegel hält, nichts geschrieben');
    // die Schema-Riegel selbst: aktuelle Fassung nie, kein Direktsprung, kein Hard-Delete
    const err = (fn: () => void) => { try { fn(); return 'KEIN FEHLER'; } catch (e) { return String((e as Error).message); } };
    const cur = q(db, `SELECT b.blob_id AS b, b.current_generation_no AS n FROM media_blobs b LIMIT 1`)[0];
    ok(/MEDIA_CURRENT_GENERATION_STATUS_LOCKED/.test(err(() => db.run(`UPDATE media_blob_generations SET gen_status = 'superseded' WHERE blob_id = ? AND generation_no = ?`, [cur.b, cur.n]))), '§2 Schema: aktuelle Fassung lässt sich nicht freigeben');
    const s1 = q(db, `SELECT blob_id AS b, generation_no AS n FROM media_blob_generations WHERE gen_status = 'superseded' LIMIT 1`)[0];
    ok(/MEDIA_GENERATION_STATE_TRANSITION/.test(err(() => db.run(`UPDATE media_blob_generations SET gen_status = 'deleted' WHERE blob_id = ? AND generation_no = ?`, [s1.b, s1.n]))), '§2 Schema: kein Direktsprung superseded → deleted');
    ok(/HARD_DELETE_FORBIDDEN/.test(err(() => db.run(`DELETE FROM media_blob_generations WHERE blob_id = ? AND generation_no = ?`, [s1.b, s1.n]))), '§2 Schema: Generationszeilen werden nie gelöscht');
  }

  // ── §3 Probelauf schreibt nichts; Lauf nur über erlaubte Übergänge; nichts anderes ändert sich ──
  { console.log('  … §3');
    const { db } = await world(SQL);
    const d0 = digestOthers(db); const st0 = statuses(db); const exported0 = db.export().length;
    const verified: string[] = [];
    const dry = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: async (c) => { verified.push(c.currentHash); }, saveDurably: async () => { throw new Error('darf nicht speichern'); }, journal: () => {} }, { mode: 'dry-run' });
    ok(dry.planned === 16 && dry.released === 0 && verified.length === 16, `§3 Probelauf: 16 geprüft, 0 freigegeben, jede aktuelle Datei verifiziert (${dry.planned}/${verified.length})`);
    ok(JSON.stringify(statuses(db)) === JSON.stringify(st0) && digestOthers(db) === d0 && db.export().length === exported0, '§3 Probelauf ändert keine Zeile');
    ok(dry.byRendition.main.files === 8 && dry.byRendition.thumbnail.files === 8 && dry.bytesPlanned === dry.byRendition.main.bytes + dry.byRendition.thumbnail.bytes, '§3 Zahlen je Gruppe (Haupt/Vorschau, Bytes)');
    const keysBefore = preserved(db); const cur = currentKeys(db);
    const candKeys = new Set(rel.planOldVersionRelease(db as MigrationDb).candidates.map((c) => c.storageKey));
    let inside = false, saves = 0, savesOutside = 0; const ev: string[] = [];
    const rep = await rel.runOldVersionRelease({
      db: db as MigrationDb, verifyCurrent: okVerify, journal: (e) => { ev.push(e.event); },
      saveDurably: async () => { saves++; if (!inside) savesOutside++; },
      exclusive: async (fn) => { inside = true; try { return await fn(); } finally { inside = false; } },
      now: () => '2026-11-17T12:00:00Z',
    }, { mode: 'apply', batchSize: 5 });
    ok(rep.released === 16 && rep.failed === 0 && !rep.stoppedEarly, `§3 Lauf: 16 freigegeben (${rep.released}/${rep.failed})`);
    ok(saves === 4 && savesOutside === 0, `§3 je Paket (5) einmal gespeichert, nur im exklusiven Platz (${saves}/${savesOutside})`);
    const st = statuses(db);
    ok(st.deleted === 16 && !st.superseded && st.available === st0.available, `§3 Status: 16 deleted, aktuelle unverändert (${JSON.stringify(st)})`);
    ok(q(db, `SELECT COUNT(*) AS n FROM media_blob_generations WHERE gen_status = 'deleted' AND deleted_at = '2026-11-17T12:00:00Z' AND gc_eligible_at = '2026-11-17T12:00:00Z'`)[0].n === 16, '§3 Zeitpunkte gesetzt (gc_eligible_at, deleted_at), Zeilen bleiben');
    ok(digestOthers(db) === d0, '§3 Artikel, Preise, Zuordnungen, Buchhaltung, Sync-Protokoll und Audit unverändert');
    const keysAfter = preserved(db);
    ok([...candKeys].every((k) => keysBefore.has(k) && !keysAfter.has(k)), '§3 GC-Schutzmenge: genau die freigegebenen Dateien fallen heraus');
    ok([...cur].every((k) => keysAfter.has(k)) && keysAfter.size === keysBefore.size - 16, '§3 GC-Schutzmenge: jede aktuelle Fassung bleibt geschützt');
    ok(ev[0] === 'start' && ev.filter((e) => e === 'released').length === 16 && ev[ev.length - 1] === 'done', '§3 Protokoll: start, je Fassung released, done');
    const again = rel.planOldVersionRelease(db as MigrationDb);
    ok(again.candidates.length === 0, '§3 erneuter Lauf: nichts mehr zu tun (idempotent)');
  }

  // ── §4 Stop mitten im Lauf; Fortsetzung; unverifizierte aktuelle Datei bleibt ──────────────────
  { console.log('  … §4');
    const { db } = await world(SQL);
    let released = 0;
    const r1 = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: okVerify, saveDurably: async () => {}, journal: (e) => { if (e.event === 'released') released++; } },
      { mode: 'apply', batchSize: 4, shouldStop: () => released >= 6 });
    ok(r1.stoppedEarly && r1.stopCode === 'RELEASE_STOP_REQUESTED' && r1.released === 6 && statuses(db).deleted === 6 && statuses(db).superseded === 10, `§4 Stop nach 6: Rest bleibt superseded (${JSON.stringify(statuses(db))})`);
    const bad = rel.planOldVersionRelease(db as MigrationDb).candidates[0];
    const r2 = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: async (c) => { if (c.blobId === bad.blobId) throw new Error('MEDIA_FILE_HASH_MISMATCH'); }, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    ok(r2.released === 9 && r2.skipped.current_unverified === 1, `§4 Fortsetzung: 9 freigegeben, 1 bleibt (aktuelle Datei nicht verifiziert) (${r2.released})`);
    ok(q(db, `SELECT gen_status AS s FROM media_blob_generations WHERE blob_id = ? AND generation_no = ?`, [bad.blobId, bad.generationNo])[0].s === 'superseded', '§4 die Fassung mit unverifiziertem Ersatz bleibt superseded');
  }

  // ── §5 fail-closed: offene Aufnahme, fremde Transaktion, geänderter Stand ───────────────────────
  { console.log('  … §5');
    const { db } = await world(SQL);
    db.run(`UPDATE media_ingest_jobs SET state = 'accepted' WHERE rowid = (SELECT MIN(rowid) FROM media_ingest_jobs)`);
    let code = '';
    try { await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: okVerify, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' }); } catch (e) { code = (e as { code?: string }).code ?? String(e); }
    ok(code === 'MIGRATION_OPEN_INGEST_JOBS' && statuses(db).deleted == null, `§5 offene Aufnahme: Lauf abgewiesen, nichts geschrieben (${code})`);
    db.run(`UPDATE media_ingest_jobs SET state = 'ready' WHERE state = 'accepted'`);
    const c = rel.planOldVersionRelease(db as MigrationDb).candidates[0];
    db.run('BEGIN'); db.run(`UPDATE products SET updated_at = 'fremd' WHERE id = 'p-small'`);
    let busy = '';
    try { rel.releaseOldVersion(db as MigrationDb, c, '2026-11-17', () => true); } catch (e) { busy = (e as { code?: string }).code ?? ''; }
    let busy2 = '';
    try { rel.releaseOldVersion(db as MigrationDb, c, '2026-11-17'); } catch (e) { busy2 = (e as { code?: string }).code ?? ''; }
    db.run('COMMIT');
    ok(busy === 'MIGRATION_TRANSACTION_BUSY' && busy2 === 'MIGRATION_TRANSACTION_BUSY' && q(db, `SELECT updated_at AS u FROM products WHERE id = 'p-small'`)[0].u === 'fremd',
      '§5 fremde Transaktion: nie schachteln, nie fremd zurückrollen');
    const stale = { ...c, currentHash: pad64('veraltet') };
    let chg = '';
    try { rel.releaseOldVersion(db as MigrationDb, stale, '2026-11-17'); } catch (e) { chg = (e as { code?: string }).code ?? ''; }
    ok(chg === 'RELEASE_STATE_CHANGED' && statuses(db).deleted == null, '§5 Ersatz seit der Planung geändert: nichts geschrieben');
    const curRow = q(db, `SELECT b.blob_id AS b, b.current_generation_no AS n FROM media_blobs b WHERE b.blob_id = ?`, [c.blobId])[0];
    let curErr = '';
    try { rel.releaseOldVersion(db as MigrationDb, { ...c, generationNo: Number(curRow.n) }, '2026-11-17'); } catch (e) { curErr = (e as { code?: string }).code ?? ''; }
    ok(curErr === 'RELEASE_STATE_CHANGED' && statuses(db).deleted == null, '§5 eine aktuelle Fassung wird nie freigegeben');
  }

  // ── §6 Owner-Pfad: Primary, Owner, Notiz, Wartungsmodus, Protokoll, gemeinsame Sperre ───────────
  { console.log('  … §6');
    const { db } = await world(SQL);
    const logs: Array<[string, string]> = []; const maint: string[] = [];
    let role: string | null = 'ADMIN'; let client = false;
    const mkEnv = (over: Record<string, unknown> = {}) => ({
      exclusive: async (fn: any) => fn({ db, saveDurably: async () => {} }),
      recompress: fakeRust(),
      session: () => (role ? { userId: 'u-owner', role } : null),
      isClientMode: () => client,
      setMaintenance: async (on: boolean, reason: string) => { maint.push(on ? `an:${reason}` : 'aus'); },
      appendLog: async (n: string, l: string) => { logs.push([n, l]); },
      transactionActive: () => false,
      verifyStored: async () => {},
      ...over,
    });
    client = true;
    ok((await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'dry-run' })).refused?.code === 'MIGRATION_PRIMARY_ONLY', '§6 nur am Primary');
    client = false; role = 'SALES';
    ok((await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'dry-run' })).refused?.code === 'MIGRATION_NOT_OWNER', '§6 nur der Owner');
    role = 'ADMIN';
    ok((await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'apply', reason: 'x' })).refused?.code === 'MIGRATION_NOTE_REQUIRED', '§6 Lauf nur mit Grund und Sicherungsname');
    const dry = await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'dry-run' });
    ok(dry.report?.planned === 16 && maint.length === 0 && dry.logName?.endsWith('-dry') && statuses(db).deleted == null, '§6 Probelauf: kein Wartungsmodus, Protokoll -dry, nichts geschrieben');
    let relCount = 0;
    const env2 = mkEnv({ appendLog: async (n: string, l: string) => { logs.push([n, l]); if (l.includes('"event":"released"') && ++relCount === 5) role = 'SALES'; } });
    const lost = await wiring.runOldVersionReleaseWith(env2 as never, { mode: 'apply', reason: 'Bildspeicher', backupRef: '2026-11-17_vor-bildbereinigung', batchSize: 5 });
    role = 'ADMIN';
    ok(lost.refused?.code === 'MIGRATION_NOT_OWNER' && statuses(db).deleted === 5 && statuses(db).superseded === 11 && maint.join(',') === 'an:old-image-version-release,aus',
      `§6 Rolle weg mitten im Lauf: sauberer Halt nach gespeichertem Paket, Wartungsmodus aus (${JSON.stringify(statuses(db))})`);
    maint.length = 0;
    const r = await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'apply', reason: 'Bildspeicher', backupRef: '2026-11-17_vor-bildbereinigung' });
    ok(r.report && !r.refused && statuses(db).deleted === 16 && maint.join(',') === 'an:old-image-version-release,aus', '§6 Fortsetzung über den Owner-Pfad: alle 16 freigegeben, Wartungsmodus an/aus');
    const own = logs.filter(([n]) => n === r.logName).map(([, l]) => JSON.parse(l));
    ok(own[0]?.event === 'owner' && own[0]?.reason === 'Bildspeicher' && own[0]?.backup === '2026-11-17_vor-bildbereinigung' && own[own.length - 1]?.event === 'report', '§6 Protokoll: Grund und Sicherung zuerst, Bericht zuletzt');
    // gemeinsame Laufsperre mit der Migration
    let release!: () => void;
    const hold = new Promise<void>((res) => { release = res; });
    const slowEnv = mkEnv({ exclusive: async (fn: any) => { await hold; return fn({ db, saveDurably: async () => {} }); } });
    const migRun = wiring.runImageMigrationWith(slowEnv as never, { mode: 'dry-run' });
    const blocked = await wiring.runOldVersionReleaseWith(mkEnv() as never, { mode: 'dry-run' });
    release(); await migRun;
    ok(blocked.refused?.code === 'MIGRATION_ALREADY_RUNNING', '§6 nie zugleich mit der Migration');
  }

  // ── §8 Fotos endgültig gelöschter Einträge: nur nachweislich unbenutzte Medien; umkehrbar ────────────
  { console.log('  … §8');
    const { db, gw } = await world(SQL, 2);
    db.run(`ALTER TABLE sync_changelog ADD COLUMN action TEXT`); db.run(`ALTER TABLE audit_log ADD COLUMN action_type TEXT`);
    const coord = new MediaDbCoordinator(db, gw as never);
    let k = 100;
    const add = async (id: string, h?: { main: string; thumb: string }) => {
      k++;
      db.run(`INSERT INTO products (id, branch_id, images, category_id, updated_at, purchase_price) VALUES (?, 'b1', '[]', 'cat-watch', '2026-11-10', 1000)`, [id]);
      const req = `req-${id}`; const main = { hash: h?.main ?? pad64(`d${k}d${id.length}`), size: 50_000 }; const thumb = { hash: h?.thumb ?? pad64(`f${k}f${id.length}`), size: 9_000 };
      gw.preset('t1', req, main, thumb);
      await coord.finalize({ tenantId: 't1', branchId: 'b1', entityType: 'product', entityId: id, scopeKind: 'branch', role: 'stock_image', ingestRequestId: req, requestHash: pad64(`c${k}`), isPrimary: true, sortOrder: 0 } as never);
      return { media: `media-${req}`, main: main.hash, thumb: thumb.hash };
    };
    const del = (id: string, tomb: 'cl' | 'audit' | 'none') => {
      db.run(`UPDATE media_links SET deleted_at = '2026-11-17' WHERE entity_type = 'product' AND entity_id = ?`, [id]);   // wie purgeProductLeftovers
      db.run(`DELETE FROM products WHERE id = ?`, [id]);
      if (tomb === 'cl') db.run(`INSERT INTO sync_changelog (table_name, record_id, data, action) VALUES ('products', ?, '{}', 'delete')`, [id]);
      if (tomb === 'audit') db.run(`INSERT INTO audit_log (entity_type, entity_id, action_type) VALUES ('products', ?, 'DELETE')`, [id]);
    };
    const d1 = await add('p-del1'); del('p-del1', 'cl');                 // endgültig gelöscht (Änderungsprotokoll)
    const d2 = await add('p-del2'); del('p-del2', 'audit');              // endgültig gelöscht (Audit)
    const d3 = await add('p-del3'); del('p-del3', 'none');               // gelöscht, aber nicht protokolliert → bleibt
    const s1 = await add('p-share1');                                    // geteilter Inhalt: dieselben Bytes an einem zweiten, lebenden Artikel
    await add('p-share2', { main: s1.main, thumb: s1.thumb }); del('p-share1', 'cl');
    const g1 = await add('p-gal');                                       // nur aus der Galerie entfernt, Artikel existiert → bleibt
    db.run(`UPDATE media_links SET deleted_at = '2026-11-17' WHERE entity_id = 'p-gal'`);
    const o1 = await add('p-open'); del('p-open', 'cl');                 // offene Aufnahme nennt das Medium → bleibt
    db.run(`UPDATE media_ingest_jobs SET state = 'accepted' WHERE target_media_id = ?`, [o1.media]);
    const addFor = async (entityType: string, table: string, role: string, id: string) => {
      k++;
      db.run(`INSERT INTO ${table} (id, branch_id) VALUES (?, 'b1')`, [id]);
      const req = `req-${id}`; const main = { hash: pad64(`e${k}e${id.length}`), size: 50_000 }; const thumb = { hash: pad64(`9${k}9${id.length}`), size: 9_000 };
      gw.preset('t1', req, main, thumb);
      await coord.finalize({ tenantId: 't1', branchId: 'b1', entityType, entityId: id, scopeKind: 'branch', role, ingestRequestId: req, requestHash: pad64(`c${k}`), isPrimary: true, sortOrder: 0 } as never);
      return { media: `media-${req}`, main: main.hash };
    };
    // Reparatur und Auftrag gelöscht: ihr Löschweg lässt die Verknüpfung AKTIV (Sync kann sie zurückbringen) → gilt als genutzt
    const rp = await addFor('repair', 'repairs', 'gallery', 'r-del');
    db.run(`DELETE FROM repairs WHERE id = 'r-del'`); db.run(`INSERT INTO sync_changelog (table_name, record_id, data, action) VALUES ('repairs','r-del','{}','delete')`);
    const od = await addFor('order', 'orders', 'reference_image', 'o-del');
    db.run(`DELETE FROM orders WHERE id = 'o-del'`); db.run(`INSERT INTO sync_changelog (table_name, record_id, data, action) VALUES ('orders','o-del','{}','delete')`);
    const ib = await addFor('purchase_inbox', 'purchase_inbox', 'intake_photo', 'i-dis');   // Inbox verworfen (Status), Verknüpfung aktiv
    const rg = await addFor('repair', 'repairs', 'gallery', 'r-gal');                          // Reparaturfoto nur aus der Galerie entfernt
    db.run(`UPDATE media_links SET deleted_at = '2026-11-17' WHERE entity_id = 'r-gal'`);
    const ownerLinks = new (await import('../../src/core/media/media-links.ts')).MediaOwnerLinks(db as never);
    const plan = rel.planDeadMediaRelease(db as MigrationDb);
    const ids = plan.candidates.map((c) => c.mediaId).sort();
    ok(S(ids) === S([d1.media, d2.media].sort()) && plan.candidates.every((c) => c.blobs.length === 2 && c.ownerTypes.join() === 'product'),
      `§8 Kandidaten = genau die 2 endgültig gelöschten Artikel (Protokoll in Änderungs- ODER Audit-Log) (${S(ids)})`);
    ok(plan.kept.owner_without_delete_record?.media === 1 && plan.kept.shared_blob?.media === 1 && (plan.kept.owner_exists?.media ?? 0) >= 3 && plan.kept.open_ingest_job?.media === 1,
      `§8 bleiben: ohne Löschprotokoll, geteilt, Besitzer existiert (Galerie/Altfoto), offene Aufnahme (${S(plan.kept)})`);
    ok(!ids.includes(d3.media) && !ids.includes(s1.media) && !ids.includes(g1.media) && !ids.includes(o1.media) && ![rp, od, ib, rg].some((x) => ids.includes(x.media)), '§8 kein geschütztes Medium ist Kandidat (auch Reparatur, Auftrag, Inbox)');
    // Probelauf: zweiter Abschnitt getrennt, nichts geschrieben
    const before = S(db.exec(`SELECT * FROM media_objects ORDER BY media_id`)) + S(db.exec(`SELECT * FROM media_blobs ORDER BY blob_id`));
    db.run(`UPDATE media_ingest_jobs SET state = 'ready' WHERE target_media_id = ?`, [o1.media]);   // für den Lauf keine offene Aufnahme
    const plan2 = rel.planDeadMediaRelease(db as MigrationDb);
    ok(S(plan2.candidates.map((c) => c.mediaId).sort()) === S([d1.media, d2.media, o1.media].sort()), '§8 nach Abschluss der Aufnahme ist auch dieses Medium nachweislich frei (3 Kandidaten)');
    const dry = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: okVerify, saveDurably: async () => { throw new Error('nein'); }, journal: () => {} }, { mode: 'dry-run' });
    ok(dry.deadMedia.media === plan2.candidates.length && dry.deadMedia.files === plan2.candidates.length * 2 && dry.deadMedia.ownerTypes.product === plan2.candidates.length && dry.planned === 4,
      `§8 Probelauf: alte Fassungen (${dry.planned}) und Fotos gelöschter Artikel (${dry.deadMedia.media}) getrennt ausgewiesen`);
    ok(S(db.exec(`SELECT * FROM media_objects ORDER BY media_id`)) + S(db.exec(`SELECT * FROM media_blobs ORDER BY blob_id`)) === before, '§8 Probelauf ändert nichts');
    const presBefore = preservedRust(db);
    const others0 = digestExcept(db, ['media_objects', 'media_variants', 'media_blobs', 'media_blob_generations']);
    const rep = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: okVerify, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    const relKeys = new Set(q(db, `SELECT g.storage_key AS k FROM media_blobs b JOIN media_blob_generations g ON g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no WHERE b.blob_status = 'gc_pending'`).map((r) => String(r.k)));
    ok(rep.deadMedia.media === plan2.candidates.length && relKeys.size === plan2.candidates.length * 2, `§8 Lauf: ${rep.deadMedia.media} Medien freigegeben, ${relKeys.size} Blobs gc_pending`);
    ok(q(db, `SELECT COUNT(*) AS n FROM media_objects WHERE deleted_at IS NOT NULL`)[0].n === plan2.candidates.length, '§8 nur die freigegebenen Medien sind gelöscht markiert (nicht mehr verknüpfbar)');
    ok(digestExcept(db, ['media_objects', 'media_variants', 'media_blobs', 'media_blob_generations']) === others0, '§8 Artikel, Verknüpfungen, Buchhaltung, Sync und Audit unverändert');
    const presAfter = preservedRust(db);
    ok([...relKeys].every((k2) => presBefore.has(k2) && !presAfter.has(k2)), '§8 Rust-Schutzmenge (echte SQL aus reachability.rs): genau die freigegebenen Dateien fallen heraus');
    ok([...presBefore].filter((k2) => !presAfter.has(k2)).length === relKeys.size + 4, '§8 sonst nichts außer den freigegebenen alten Fassungen');
    ok(presAfter.has(key('t1', s1.main)) && presAfter.has(key('t1', d3.main)) && presAfter.has(key('t1', g1.main)) && [rp, od, ib, rg].every((x) => presAfter.has(key('t1', x.main))), `§8 geteilte, nicht protokollierte, Galerie-, Reparatur-, Auftrags- und Inbox-Medien bleiben geschützt (${S(Object.entries({ s1, d3, g1, rp, od, ib, rg }).filter(([, x]) => !presAfter.has(key('t1', x.main))).map(([n]) => n))})`);
    let relink = '';
    try { ownerLinks.setGallery({ tenantId: 't1', scopeKind: 'branch', branchId: 'b1', entityType: 'product', entityId: 'p-gal', role: 'stock_image', securityClass: 'internal' } as never, [d1.media]); } catch (e) { relink = (e as { code?: string }).code ?? String(e); }
    ok(/MEDIA_LINK_OBJECT_NOT_READY/.test(relink), `§8 ein freigegebenes Medium lässt sich nicht wieder verknüpfen (${relink})`);
    // wiederholen: kein Fehler, nichts mehr zu tun
    const again = await rel.runOldVersionRelease({ db: db as MigrationDb, verifyCurrent: okVerify, saveDurably: async () => {}, journal: () => {} }, { mode: 'apply' });
    ok(again.deadMedia.total === 0 && again.deadMedia.failed === 0 && again.total === 0, '§8 erneuter Lauf: kein Fehler, nichts mehr zu tun');
    // Wiederbelebung: genau dasselbe Bild kommt wieder (neuer Artikel) → Blob present, Datei wieder geschützt
    await add('p-reupload', { main: d1.main, thumb: d1.thumb });
    const st1 = q(db, `SELECT blob_status AS s FROM media_blobs WHERE blob_id IN (?, ?)`, ['blob-' + d1.main, 'blob-' + d1.thumb]).map((r) => r.s);
    ok(S(st1) === S(['present', 'present']) && preservedRust(db).has(key('t1', d1.main)) && preservedRust(db).has(key('t1', d1.thumb)),
      `§8 erneutes Hochladen desselben Bildes belebt den Blob wieder; die Datei ist wieder geschützt (${S(st1)})`);
    ok(q(db, `SELECT COUNT(*) AS n FROM media_links WHERE entity_id = 'p-reupload' AND deleted_at IS NULL`)[0].n === 1, '§8 der neue Artikel zeigt das Bild (neue Verknüpfung, neues Medium)');
  }

  // ── §7 Rust-GC: Schutzmenge ohne `deleted`, Quarantäne/Bestätigung unverändert, Steuerordner nie ─────────
  { console.log('  … §7');
    const reach = readFileSync(join(repo, 'src-tauri/src/media/reachability.rs'), 'utf8');
    const gc = readFileSync(join(repo, 'src-tauri/src/media/media_gc.rs'), 'utf8');
    ok(reach.includes(`WHERE g.gen_status <> 'deleted'`) && reach.includes('PRESERVED_PINNED_DELETED_SQL'), '§7 Rust-Schutzmenge: alle Generationen außer deleted (gepinnte deleted bleiben geschützt)');
    ok(gc.includes('super::reachability::preserved_keys(&conn)') && gc.includes('QUARANTINE_DIRNAME') && gc.includes('pub fn finalize'), '§7 GC nutzt diese Schutzmenge; Quarantäne und Bestätigung bleiben');
    ok(/control dirs[\s\S]{0,200}\.ingest-journal/.test(gc), '§7 GC betritt das Ingest-Journal nie (Steuerordner)');
    const src = readFileSync(join(repo, 'src/core/media/old-version-release.ts'), 'utf8');
    ok(!/unlink|remove_file|rmSync|deleteFile/.test(src) && !/DELETE FROM/.test(src), '§7 der Freigabeschritt löscht selbst keine Datei und keine Zeile');
  }

  console.log(`\n${FAIL ? 'FAIL' : 'PASS'} — Bildfassungen freigeben (Phase 5B): ${PASS} passed, ${FAIL} failed`);
  if (FAIL) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
await main();

// COLLECTIONS-S3 — Kartenbild = VORSCHAU, nicht Hauptbild und nicht Galerie.
// Gegen das ECHTE Medienschema (sql.js, alle Trigger), den ECHTEN Coordinator (finalize) und den echten
// Generationswechsel der Bildmigration (`switchBlobGeneration`). Rust ist ein deterministischer Ersatz.
//   §1 Primary  `cardThumbnailPlan` / `resolveCardThumbnail`: Vorschau über den Rohweg, kein JSON-Bytefeld,
//               Rückfall Hauptbild (Vorschau fehlt / Datei fehlt / Länge falsch), Altbestand, leer, Fingerabdruck
//               ändert sich bei Generationswechsel (gleiche Medienkennung), Galerieänderung, neuem Hauptbild.
//   §2 PC2-Liste `cardThumbsFor`: erstes Bild = `products.get`-Reihenfolge, Vorschau-Schlüssel der aktuellen
//               Generation, Rückfallschlüssel, fremde Filiale/entfernte Verknüpfung ausgeschlossen.
//   §3 PC2-Karte `loadRemoteCardThumb`: gleicher Fingerabdruck → keine Anfrage; Vorschau; Rückfall Hauptbild.
//   §4 Speicher: nichts geschrieben (Zeilen/DB unverändert durch Lesen).
// Run: node test/media-thumb/card-thumbnail-s3.test.ts
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts' || ((specifier === './database' || specifier === '../db/database') && context.parentURL)) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      for (const cand of [p, p + '.ts', p + '.tsx']) if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const ls = new Map<string, string>([['lataif_runtime_mode', 'client'], ['lataif_client_server_url', 'http://pc1:3001'], ['lataif_client_token', 'tok']]);
const storage = { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, String(v)); }, removeItem: (k: string) => { ls.delete(k); } };
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const { MediaDbCoordinator } = await import('../../src/core/media/coordinator.ts');
const { ProductMediaResolver } = await import('../../src/core/media/product-media-resolver.ts');
const { switchBlobGeneration } = await import('../../src/core/media/image-store-migration.ts');
const { cardThumbsFor, cardThumbFingerprint } = await import('../../src/core/media/card-thumbs.ts');
const { loadRemoteCardThumb } = await import('../../src/core/media/client-media-source.ts');

let PASS = 0, FAIL = 0; const failures: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; failures.push(m); console.log('  ✗ ' + m); } };
const pad64 = (s: string) => (s.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
const keyOf = (t: string, h: string) => `${t}/${h.slice(0, 2)}/${h}.jpg`;
const desc = (hash: string, size: number) => ({ hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 1200, height: 900 });
const q = (db: any, sql: string, p: unknown[] = []) => { const r = db.exec(sql, p); return r.length ? r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]]))) : []; };

const SQL = await initSqlJs({ locateFile: (f: string) => join(repo, 'node_modules', 'sql.js', 'dist', f) });
const db = new SQL.Database();
db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`);
db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
db.run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
db.run(`INSERT INTO tenants VALUES ('t1')`);
db.run(`INSERT INTO branches VALUES ('b1','t1'),('b2','t1')`);
db.run(`INSERT INTO products (id, branch_id, images) VALUES ('pA','b1','[]'),('pB','b1','[]'),('pNone','b1','[]'),('pOther','b2','[]'),
  ('pLegacy','b1','["data:image/png;base64,iVBORw0KGgo="]')`);
applyMediaSchema(db);

// Rust-Ersatz: Dateien = Hash → Größe; JSON-Lesungen (readVerifiedMedia) werden gezählt und sollen 0 bleiben.
const files = new Map<string, number>();
let jsonReads = 0;
const gw = {
  jobs: new Map<string, { main: string; thumb: string }>(),
  async prepareStockImage() { throw new Error('nope'); },
  async commitStockImage(i: { tenantScope: string; ingestRequestId: string }) {
    const j = this.jobs.get(i.ingestRequestId)!;
    return { state: 'published', main_descriptor: desc(j.main, 50_000), thumbnail_descriptor: desc(j.thumb, 8_000), main_storage_key: keyOf(i.tenantScope, j.main), thumbnail_storage_key: keyOf(i.tenantScope, j.thumb) };
  },
  async abortStockImage() { return {}; },
  async readVerifiedMedia(i: { hash: string }) { jsonReads++; const n = files.get(i.hash); if (n == null) throw new Error('MEDIA_FILE_MISSING'); return { bytes: new Uint8Array(n), hash: i.hash, byte_size: n, mime_type: 'image/jpeg', extension: 'jpg' }; },
  async recoverMediaIngests() { return []; },
};
const coord = new MediaDbCoordinator(db, gw as never);
let n = 0;
async function add(pid: string, primary: boolean, sortOrder: number, branch = 'b1') {
  n++;
  const req = `req-${pid}-${n}`; const main = pad64(`a${n}${pid}`); const thumb = pad64(`b${n}${pid}`);
  gw.jobs.set(req, { main, thumb }); files.set(main, 50_000); files.set(thumb, 8_000);
  return coord.finalize({ tenantId: 't1', branchId: branch, entityType: 'product', entityId: pid, scopeKind: 'branch', role: 'stock_image',
    ingestRequestId: req, requestHash: pad64(`c${n}`), isPrimary: primary, sortOrder } as never);
}
const a0 = await add('pA', true, 0);
const a1 = await add('pA', false, 1);
const b0 = await add('pB', true, 0);
await add('pOther', true, 0, 'b2');

const reads: string[] = [];
const readRaw = async (i: { hash: string }) => { reads.push(i.hash); const n = files.get(i.hash); if (n == null) throw new Error('MEDIA_FILE_MISSING'); return new Uint8Array(n); };
const resolver = new ProductMediaResolver({ dbProvider: () => db, gateway: gw as never, tenantId: 't1', branchId: 'b1' });

// ── §1 Primary ──────────────────────────────────────────────────────────────
{
  const plan = resolver.cardThumbnailPlan('pA');
  ok(plan.kind === 'read' && plan.thumb?.hash === a0.thumbnail.hash && plan.main.hash === a0.main.hash, 'Plan: Hauptbild + seine Vorschau (aktuelle Generation)');
  ok(plan.fingerprint.startsWith(resolver.galleryFingerprint('pA')) && plan.fingerprint.includes(`|t:${a0.thumbnail.hash}`), 'Fingerabdruck = Galerie + Vorschau-Fassung');
  reads.length = 0; jsonReads = 0;
  const r = await resolver.resolveCardThumbnail('pA', readRaw);
  ok(r.result.kind === 'media' && r.result.source === 'thumbnail' && r.result.bytes.byteLength === 8_000, 'Karte: Vorschau (8 KB) statt Hauptbild (50 KB)');
  ok(reads.length === 1 && reads[0] === a0.thumbnail.hash && jsonReads === 0, 'genau EINE Lesung über den Rohweg, kein JSON-Bytefeld, keine Galerie');
  ok(r.fingerprint === plan.fingerprint, 'Fingerabdruck der Lesung = Plan');
}
{ // Vorschau-Datei fehlt → Hauptbild
  files.delete(b0.thumbnail.hash);
  reads.length = 0;
  const r = await resolver.resolveCardThumbnail('pB', readRaw);
  ok(r.result.kind === 'media' && r.result.source === 'main' && reads.join() === `${b0.thumbnail.hash},${b0.main.hash}`, 'Vorschau-Datei fehlt → Hauptbild (sicherer Rückfall)');
  files.set(b0.thumbnail.hash, 8_000);
}
{ // Länge stimmt nicht (beschädigt) → Hauptbild
  const r = await resolver.resolveCardThumbnail('pB', async (i) => (i.hash === b0.thumbnail.hash ? new Uint8Array(5) : new Uint8Array(files.get(i.hash)!)));
  ok(r.result.kind === 'media' && r.result.source === 'main', 'Vorschau beschädigt (Länge) → Hauptbild');
}
{ // beides fehlt → Fehler, kein falsches Bild
  const r = await resolver.resolveCardThumbnail('pB', async () => { throw new Error('MEDIA_FILE_MISSING'); });
  ok(r.result.kind === 'final' && r.result.resolution.kind === 'integrity_error', 'Vorschau und Hauptbild fehlen → Fehler, kein falsches Bild');
}
{ // Variante entfernt → Plan ohne Vorschau, Hauptbild
  db.run(`UPDATE media_variants SET deleted_at = '2026-11-15' WHERE media_id = ?`, [b0.mediaId]);
  const plan = resolver.cardThumbnailPlan('pB');
  ok(plan.kind === 'read' && plan.thumb === null && plan.fingerprint.endsWith('|t:-'), 'keine Vorschau-Variante → Plan ohne Vorschau');
  reads.length = 0;
  const r = await resolver.resolveCardThumbnail('pB', readRaw);
  ok(r.result.kind === 'media' && r.result.source === 'main' && reads.length === 1, 'ohne Vorschau: direkt das Hauptbild (eine Lesung)');
  db.run(`UPDATE media_variants SET deleted_at = NULL WHERE media_id = ?`, [b0.mediaId]);
}
{ // Altbestand / leer
  const l = resolver.cardThumbnailPlan('pLegacy');
  ok(l.kind === 'final' && l.resolution.kind === 'legacy' && l.resolution.items.length === 1 && l.fingerprint === 'legacy', 'Altbestand (products.images): erstes Altbild, keine Medienlesung');
  const e = resolver.cardThumbnailPlan('pNone');
  ok(e.kind === 'final' && e.resolution.kind === 'none' && e.fingerprint === 'none', 'ohne Bild: leer');
}
{ // Generationswechsel der VORSCHAU bei gleicher Medienkennung (Bildmigration)
  const before = resolver.cardThumbnailPlan('pA');
  const newHash = pad64('ffee01');
  files.set(newHash, 6_000);
  switchBlobGeneration(db as never, { tenantId: 't1', blobId: a0.thumbnailBlobId, rendition: 'thumbnail', currentGeneration: 1, currentBytes: 8_000, targetBytes: 10_000,
    sourceHash: a0.main.hash, sourceGeneration: 1, fallbackSourceHash: null, usageClass: 'watch' } as never,
  { rendition: 'thumbnail', source_hash: a0.main.hash, source_byte_size: 50_000, hash: newHash, byte_size: 6_000, width: 256, height: 192, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: keyOf('t1', newHash), published: true }, '2026-11-15T10:00:00Z');
  const after = resolver.cardThumbnailPlan('pA');
  ok(after.kind === 'read' && after.thumb?.hash === newHash && after.fingerprint !== before.fingerprint, 'Generationswechsel der Vorschau (gleiche Medien-ID): Fingerabdruck ändert sich → Karte lädt neu');
  ok(resolver.galleryFingerprint('pA') === (before.kind === 'read' ? before.fingerprint.split('|t:')[0] : ''), '… die Galerie selbst (Hauptbilder) ist unverändert');
  reads.length = 0;
  const r = await resolver.resolveCardThumbnail('pA', readRaw);
  ok(r.result.kind === 'media' && r.result.bytes.byteLength === 6_000 && reads[0] === newHash, '… und liest die neue Fassung');
}
{ // Generationswechsel des HAUPTBILDS
  const before = resolver.cardThumbnailPlan('pA').fingerprint;
  const newMain = pad64('ffee02'); files.set(newMain, 30_000);
  switchBlobGeneration(db as never, { tenantId: 't1', blobId: a0.mainBlobId, rendition: 'main', currentGeneration: 1, currentBytes: 50_000, targetBytes: 60_000,
    sourceHash: a0.main.hash, sourceGeneration: 1, fallbackSourceHash: null, usageClass: 'watch' } as never,
  { rendition: 'main', source_hash: a0.main.hash, source_byte_size: 50_000, hash: newMain, byte_size: 30_000, width: 1200, height: 900, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: keyOf('t1', newMain), published: true }, '2026-11-15T10:01:00Z');
  ok(resolver.cardThumbnailPlan('pA').fingerprint !== before, 'Generationswechsel des Hauptbilds: Fingerabdruck ändert sich');
}
{ // Galerieänderung: anderes Hauptbild (Reihenfolge)
  const before = resolver.cardThumbnailPlan('pA').fingerprint;
  db.run(`UPDATE media_links SET is_primary = 0 WHERE entity_id = 'pA'`);
  db.run(`UPDATE media_links SET sort_order = 9 WHERE link_id = ?`, [a0.linkId]);
  db.run(`UPDATE media_links SET sort_order = 0, is_primary = 1 WHERE link_id = ?`, [a1.linkId]);
  db.run(`UPDATE media_links SET sort_order = 1 WHERE link_id = ?`, [a0.linkId]);
  const p = resolver.cardThumbnailPlan('pA');
  ok(p.kind === 'read' && p.fingerprint !== before && p.thumb?.hash === a1.thumbnail.hash, 'neues Hauptbild: Fingerabdruck ändert sich, Vorschau des NEUEN Hauptbilds');
}

// ── §2 PC2: Verweise in der Artikelliste ───────────────────────────────────────
const rowsFn = (sql: string, params: unknown[]) => q(db, sql, params);
{
  const refs = cardThumbsFor(rowsFn, 't1', 'b1');
  // Referenz: dieselbe Reihenfolge wie products.get (galleryOf: is_primary DESC, sort_order, link_id)
  const first = q(db, `SELECT l.media_id AS m, g.storage_key AS k FROM media_links l JOIN media_objects o ON o.tenant_id=l.tenant_id AND o.media_id=l.media_id
    JOIN media_blobs b ON b.tenant_id=o.tenant_id AND b.blob_id=o.master_blob_id JOIN media_blob_generations g ON g.tenant_id=b.tenant_id AND g.blob_id=b.blob_id AND g.generation_no=b.current_generation_no
    WHERE l.entity_id='pA' AND l.deleted_at IS NULL ORDER BY l.is_primary DESC, l.sort_order ASC, l.link_id ASC LIMIT 1`)[0];
  ok(refs.pA?.mediaId === first.m && refs.pA?.mainKey === first.k, 'Liste: erstes Bild = erstes Bild von products.get');
  ok(refs.pA?.thumbKey === a1.thumbnail.storage_key, 'Liste: Vorschau-Schlüssel des Hauptbilds (aktuelle Generation)');
  ok(refs.pB?.thumbKey === b0.thumbnail.storage_key && refs.pB?.mainKey === b0.main.storage_key, 'Liste: zweiter Artikel');
  ok(!refs.pNone && !refs.pLegacy && !refs.pOther, 'ohne Galerie / Altbestand / fremde Filiale: kein Verweis');
  // Generationswechsel der Vorschau → neuer Schlüssel im Verweis
  const newT = pad64('ffee03'); files.set(newT, 5_000);
  switchBlobGeneration(db as never, { tenantId: 't1', blobId: b0.thumbnailBlobId, rendition: 'thumbnail', currentGeneration: 1, currentBytes: 8_000, targetBytes: 10_000,
    sourceHash: b0.main.hash, sourceGeneration: 1, fallbackSourceHash: null, usageClass: 'watch' } as never,
  { rendition: 'thumbnail', source_hash: b0.main.hash, source_byte_size: 50_000, hash: newT, byte_size: 5_000, width: 256, height: 192, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', storage_key: keyOf('t1', newT), published: true }, '2026-11-15T10:02:00Z');
  const refs2 = cardThumbsFor(rowsFn, 't1', 'b1');
  ok(refs2.pB?.thumbKey === keyOf('t1', newT) && cardThumbFingerprint(refs2.pB!) !== cardThumbFingerprint(refs.pB!), 'Generationswechsel: neuer Vorschau-Schlüssel, neuer Fingerabdruck auf PC2');
  db.run(`UPDATE media_variants SET deleted_at = '2026-11-15' WHERE media_id = ?`, [b0.mediaId]);
  ok(cardThumbsFor(rowsFn, 't1', 'b1').pB?.thumbKey === null, 'Variante fehlt: thumbKey null (Hauptbild als Rückfall)');
  db.run(`UPDATE media_variants SET deleted_at = NULL WHERE media_id = ?`, [b0.mediaId]);
  db.run(`UPDATE media_links SET deleted_at = '2026-11-15' WHERE entity_id = 'pB'`);
  ok(!cardThumbsFor(rowsFn, 't1', 'b1').pB, 'entfernte Verknüpfung: kein Verweis mehr');
  db.run(`UPDATE media_links SET deleted_at = NULL WHERE entity_id = 'pB'`);
  ok(Object.keys(cardThumbsFor(rowsFn, '', 'b1')).length === 0, 'ohne Mandant: nichts');
}

// ── §3 PC2: Karte über den Verweis ─────────────────────────────────────────────
{
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(String(url));
    const key = decodeURIComponent(String(url).split('key=')[1] ?? '');
    const h = key.split('/').pop()!.replace('.jpg', '');
    const nBytes = files.get(h);
    return nBytes == null ? new Response(null, { status: 404 }) : new Response(new Uint8Array(nBytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;
  const ref = cardThumbsFor(rowsFn, 't1', 'b1').pB!;
  const fp = cardThumbFingerprint(ref);
  const same = await loadRemoteCardThumb(ref, fp, fetchFn);
  ok(same.kind === 'same' && calls.length === 0, 'PC2: gleicher Fingerabdruck → keine Anfrage (weder Auskunft noch Bild)');
  const r = await loadRemoteCardThumb(ref, undefined, fetchFn);
  ok(r.kind === 'media' && calls.length === 1 && calls[0].includes(encodeURIComponent(ref.thumbKey!)) && (r as { blob: Blob }).blob.size === 5_000, 'PC2: genau EINE Übertragung — die Vorschau');
  calls.length = 0;
  files.delete(ref.thumbKey!.split('/').pop()!.replace('.jpg', ''));
  const f = await loadRemoteCardThumb(ref, undefined, fetchFn);
  ok(f.kind === 'media' && calls.length === 2 && calls[1].includes(encodeURIComponent(ref.mainKey)), 'PC2: Vorschau nicht lieferbar → Hauptbild');
  calls.length = 0;
  const g = await loadRemoteCardThumb({ ...ref, thumbKey: null }, undefined, fetchFn);
  ok(g.kind === 'media' && calls.length === 1 && calls[0].includes(encodeURIComponent(ref.mainKey)), 'PC2: ohne Vorschau direkt das Hauptbild');
  let thrown = '';
  try { await loadRemoteCardThumb({ ...ref, thumbKey: null, mainKey: 't1/00/none.jpg' }, undefined, fetchFn); } catch (e) { thrown = (e as Error).message; }
  ok(thrown === 'MEDIA_UNAVAILABLE', 'PC2: nichts lieferbar → Fehler, kein falsches Bild');
  ok(!cardThumbFingerprint(ref).startsWith('media:'), 'Fingerabdruck unterscheidet sich vom S1-Format (kein falsches „gleich" beim Wechsel des Wegs)');
}

// ── §4 Lesen schreibt nichts ───────────────────────────────────────────────────
{
  const snap = () => JSON.stringify(['media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations', 'products'].map((t) => q(db, `SELECT * FROM ${t} ORDER BY rowid`)));
  const s0 = snap();
  resolver.cardThumbnailPlan('pA'); await resolver.resolveCardThumbnail('pA', readRaw); cardThumbsFor(rowsFn, 't1', 'b1');
  ok(snap() === s0, 'Plan, Lesung und Listenverweise schreiben keine Zeile');
}

console.log(`\nCARD-THUMBNAIL-S3: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }

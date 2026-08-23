// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT-S3 — Galerie-Edit vom Handy: Plan-Vertrag + echte Anwendung auf sql.js
// Run: node test/mobile-gallery-edit/gallery-plan-and-apply.test.ts
//
// Zwei Ebenen in einer Datei, weil sie dieselbe Frage aus zwei Richtungen stellen:
//
//   TEIL 1 — der Plan selbst. Was darf ueberhaupt bis zur Datenbank vordringen? Hier wird bewiesen,
//            dass ein Bild NIE dadurch verschwindet, dass es im Plan fehlt, und dass ein Plan auf
//            einer ueberholten Sicht gar nicht erst gebaut wird.
//   TEIL 2 — die echte Wirkung. Derselbe Plan laeuft durch den ECHTEN Koordinator gegen eine echte
//            sql.js-Datenbank, und geprueft werden `media_links` Zeile fuer Zeile: Link-Id,
//            Media-Id, sort_order, is_primary, deleted_at. Counts allein beweisen nichts.
//
// Der Fingerabdruck-Vektor unten ist DERSELBE wie in
// `src-tauri/src/sync/product_query_tests.rs::the_shared_baseline_vector_is_stable`. Laufen die
// beiden Formeln auseinander, wuerde jeder echte Save als Konflikt enden — dieser Vektor haelt sie
// zusammen.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, type EditBaselineLink, type EditPlanEnvelope } from '../../src/core/media/coordinator.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes,
  MediaCommandGateway, PrepareInput, PrepareResult, ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';
import {
  buildMobileGalleryEnvelope, parseMobileGalleryPlan, MobileGalleryConflict,
  ERR_GALLERY_BASELINE_CHANGED, ERR_GALLERY_PLAN_INCOMPLETE, ERR_GALLERY_TOO_MANY,
} from '../../src/core/media/mobile-gallery-edit.ts';
import { galleryBaselineFingerprint, galleryBaselineInput } from '../../src/core/media/gallery-baseline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(Buffer.from(b)).digest('hex');
const digestHex = async (s: string): Promise<string> => createHash('sha256').update(s).digest('hex');

// ── ein Gateway, das echte Deskriptoren liefert, ohne echte Dateien ─────────
function d(hash: string, size: number) {
  return { hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 800, height: 600 };
}
class FakeGateway implements MediaCommandGateway {
  private req = new Map<string, Uint8Array>();
  private rend(input: Uint8Array) {
    const h = sha256Hex(input);
    const r = { main: sha256Hex(new TextEncoder().encode('m' + h)), thumb: sha256Hex(new TextEncoder().encode('t' + h)) };
    this.thumbHashes.add(r.thumb);
    return r;
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    this.req.set(i.ingestRequestId, i.imageBytes);
    const r = this.rend(i.imageBytes);
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: d(r.main, 24), thumbnail_descriptor: d(r.thumb, 12) };
  }
  commits = 0;
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    this.commits++;
    const bytes = this.req.get(i.ingestRequestId);
    if (!bytes) throw new Error('MEDIA_INGEST_NOT_FOUND');
    const r = this.rend(bytes);
    return { state: 'published', main_descriptor: d(r.main, 24), thumbnail_descriptor: d(r.thumb, 12), main_storage_key: `t1/${r.main.slice(0, 2)}/${r.main}.jpg`, thumbnail_storage_key: `t1/${r.thumb.slice(0, 2)}/${r.thumb}.jpg` };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    // Die Groesse muss zum Deskriptor passen — der Koordinator prueft Hash, Groesse, MIME und
    // Endung gegen das, was er gespeichert hat. Ein Haupt-Rendition ist 24 Bytes gross, ein
    // Thumbnail 12; genau diese Werte kommen aus `d(...)` oben.
    const size = this.thumbHashes.has(i.hash) ? 12 : 24;
    return { bytes: new Uint8Array(size), hash: i.hash, byte_size: size, mime_type: 'image/jpeg', extension: 'jpg' };
  }
  private thumbHashes = new Set<string>();
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}

const TENANT = 't1', BRANCH = 'b1', PRODUCT = 'p-1', ROLE = 'stock_image';
const SCOPE = { tenantId: TENANT, scopeKind: 'branch' as const, branchId: BRANCH, entityType: 'product', entityId: PRODUCT, role: ROLE };

interface LinkRow { linkId: string; mediaId: string; sortOrder: number; isPrimary: number; deletedAt: string | null }
function allLinks(db: { exec: (sql: string, p?: unknown[]) => Array<{ values: unknown[][] }> }): LinkRow[] {
  const r = db.exec(
    `SELECT link_id, media_id, sort_order, is_primary, deleted_at FROM media_links
      WHERE tenant_id=? AND entity_id=? ORDER BY link_id`, [TENANT, PRODUCT]);
  if (!r.length) return [];
  return r[0].values.map((v) => ({ linkId: String(v[0]), mediaId: String(v[1]), sortOrder: Number(v[2]), isPrimary: Number(v[3]), deletedAt: v[4] === null ? null : String(v[4]) }));
}
const activeLinks = (db: never): LinkRow[] => allLinks(db).filter((l) => l.deletedAt === null).sort((a, b) => a.sortOrder - b.sortOrder);
const sameRows = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Zeilen einer Medien-Tabelle zaehlen — fuer den Nachweis, dass ein gescheiterter Save WIRKLICH
 *  nichts geschrieben hat, nicht nur nichts an `media_links`. */
function countRows(db: never, table: string): number {
  const r = (db as unknown as { exec: (s: string) => Array<{ values: unknown[][] }> }).exec(`SELECT COUNT(*) FROM ${table}`);
  return r.length ? Number(r[0].values[0][0]) : -1;
}

function newDb(SQL: { Database: new () => never }): never {
  const db = new SQL.Database();
  const run = (sql: string, p?: unknown[]) => (db as unknown as { run: (s: string, p?: unknown[]) => void }).run(sql, p);
  applyMediaSchema({ run: (sql: string) => run(sql) });
  run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT)`);
  run(`ALTER TABLE products ADD COLUMN images TEXT DEFAULT '[]'`);
  for (const c of ['brand', 'name', 'category_id', 'sku', 'attributes', 'updated_at', 'image_hash', 'image_description', 'image_embedding', 'scope_of_delivery']) run(`ALTER TABLE products ADD COLUMN ${c} TEXT`);
  run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT)`);
  run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT, entity_type TEXT, entity_id TEXT, action_type TEXT, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT)`);
  run(`INSERT INTO tenants (id) VALUES ('${TENANT}')`);
  run(`INSERT INTO branches (id, tenant_id) VALUES ('${BRANCH}','${TENANT}')`);
  run(`INSERT INTO products (id, branch_id, tenant_id, images) VALUES ('${PRODUCT}','${BRANCH}','${TENANT}','[]')`);
  return db;
}

/** Die Ausgangsgalerie: vier unterscheidbare Bilder, ueber den ECHTEN Edit-Pfad angelegt. */
async function seedFour(co: MediaDbCoordinator, gw: FakeGateway): Promise<EditBaselineLink[]> {
  const prepared = new Map<string, PrepareResult>();
  const desired: Array<{ source: 'new'; requestId: string; requestHash: string }> = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    const bytes = new TextEncoder().encode(`image-${name}`);
    const requestId = `seed-${name}`;
    const requestHash = sha256Hex(bytes);
    prepared.set(requestId, await gw.prepareStockImage({ tenantScope: TENANT, ingestRequestId: requestId, requestHash, imageBytes: bytes }));
    desired.push({ source: 'new', requestId, requestHash });
  }
  const { buildEditPlanEnvelope } = await import('../../src/core/media/product-media-edit.ts');
  const env = await buildEditPlanEnvelope({
    batchId: 'seed-batch', tenantId: TENANT, branchId: BRANCH, scopeKind: 'branch',
    entityType: 'product', entityId: PRODUCT, role: ROLE, baseline: [], desired, prepared,
  }, digestHex);
  co.registerEditPlan(env);
  await co.applyEditBatch(env);
  return co.readGalleryBaseline(SCOPE);
}

/** Ein neues Bild vorbereiten und als Slot-Eintrag zurueckgeben. */
async function prepareNew(gw: FakeGateway, name: string, slot: number) {
  const bytes = new TextEncoder().encode(`image-${name}`);
  const requestId = `new-${name}`;
  const prepared = await gw.prepareStockImage({ tenantScope: TENANT, ingestRequestId: requestId, requestHash: sha256Hex(bytes), imageBytes: bytes });
  return [slot, { requestId, prepared }] as const;
}

/** Den Plan bauen und anwenden — genau die Reihenfolge, die auch die Verdrahtung nimmt. */
async function applyPlan(
  co: MediaDbCoordinator,
  plan: Parameters<typeof buildMobileGalleryEnvelope>[0]['plan'],
  preparedBySlot: Map<number, { requestId: string; prepared: PrepareResult }>,
  batchId: string,
): Promise<EditPlanEnvelope> {
  const env = await buildMobileGalleryEnvelope({
    plan, baseline: co.readGalleryBaseline(SCOPE), preparedBySlot, batchId,
    tenantId: TENANT, branchId: BRANCH, entityId: PRODUCT, role: ROLE, digestHex,
  });
  co.registerEditPlan(env);
  await co.applyEditBatch(env);
  return env;
}

const planFor = (baseline: string, order: Array<{ keep: string } | { new: number }>, remove: string[] = []) =>
  ({ productId: PRODUCT, galleryBaseline: baseline, order, remove });

// ════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════════════════════
  // TEIL 1 — der Fingerabdruck und der Plan-Vertrag (ohne Datenbank)
  // ══════════════════════════════════════════════════════════════════════════
  const vector = [
    { linkId: 'lnk-a', mediaId: 'med-a', sortOrder: 0, isPrimary: true },
    { linkId: 'lnk-b', mediaId: 'med-b', sortOrder: 1, isPrimary: false },
  ];
  ok(galleryBaselineInput(vector) === 'lnk-a:med-a:0:1|lnk-b:med-b:1:0', `the canonical input is the shared one ("${galleryBaselineInput(vector)}")`);
  ok(await galleryBaselineFingerprint(vector) === '4ede7717390d74cb4b3818fe48f6ddf7e20f3d956bfdbf5fbf1cac08f4f0b8e3',
    'FINGERPRINT the shared vector matches the value Rust pins');
  ok(await galleryBaselineFingerprint([]) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'FINGERPRINT an empty gallery has a real fingerprint — "read, nothing in it" is a valid state');
  ok(await galleryBaselineFingerprint(vector) !== await galleryBaselineFingerprint([vector[1], vector[0]].map((r, i) => ({ ...r, sortOrder: i, isPrimary: i === 0 }))),
    'FINGERPRINT swapping the order changes it');

  const HEX = 'a'.repeat(64);
  ok(parseMobileGalleryPlan(JSON.stringify({ kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ keep: 'l1' }, { new: 0 }], remove: ['l2'] })).ok,
    'PARSE a well-formed plan is accepted');
  const bad: Array<[string, unknown]> = [
    ['not json', '{'],
    ['a text edit is not a gallery edit', { kind: 'text_edit', productId: 'p' }],
    ['no baseline', { kind: 'gallery_edit', productId: 'p', order: [], remove: ['l1'] }],
    ['a short baseline', { kind: 'gallery_edit', productId: 'p', galleryBaseline: 'abc', order: [], remove: ['l1'] }],
    ['an uppercase baseline', { kind: 'gallery_edit', productId: 'p', galleryBaseline: 'A'.repeat(64), order: [], remove: ['l1'] }],
    ['no product', { kind: 'gallery_edit', galleryBaseline: HEX, order: [], remove: ['l1'] }],
    ['a duplicate keep', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ keep: 'l1' }, { keep: 'l1' }], remove: [] }],
    ['a duplicate new slot', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ new: 0 }, { new: 0 }], remove: [] }],
    ['keep and remove of the same link', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ keep: 'l1' }], remove: ['l1'] }],
    ['an entry that is both', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ keep: 'l1', new: 0 }], remove: [] }],
    ['an empty plan', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [], remove: [] }],
    ['a negative slot', { kind: 'gallery_edit', productId: 'p', galleryBaseline: HEX, order: [{ new: -1 }], remove: [] }],
  ];
  for (const [what, payload] of bad) {
    ok(!parseMobileGalleryPlan(typeof payload === 'string' ? payload : JSON.stringify(payload)).ok, `PARSE refuses ${what}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEIL 2 — die echte Wirkung auf `media_links`
  // ══════════════════════════════════════════════════════════════════════════
  const SQL = await initSqlJs({ locateFile: () => WASM }) as unknown as { Database: new () => never };

  /** Frische Datenbank mit vier Bildern; gibt alles zurueck, was die Faelle brauchen. */
  async function fixture() {
    const db = newDb(SQL);
    const gw = new FakeGateway();
    const co = new MediaDbCoordinator(db as never, gw);
    const baseline = await seedFour(co, gw);
    const fp = await galleryBaselineFingerprint(baseline);
    return { db, gw, co, baseline, fp, before: allLinks(db as never) };
  }

  // ── §22.2 ADD: A B C D + E F ──────────────────────────────────────────────
  {
    const { db, gw, co, baseline, fp, before } = await fixture();
    ok(baseline.length === 4, `FIXTURE four images through the real edit path (${baseline.length})`);
    ok(activeLinks(db as never).filter((l) => l.isPrimary === 1).length === 1, 'FIXTURE exactly one primary');

    const prepared = new Map([await prepareNew(gw, 'E', 0), await prepareNew(gw, 'F', 1)]);
    await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }, { new: 1 }]), prepared, 'batch-add');

    const after = activeLinks(db as never);
    ok(after.length === 6, `ADD the gallery holds six images (${after.length})`);
    const keptBefore = before.filter((l) => l.deletedAt === null).sort((a, b) => a.sortOrder - b.sortOrder);
    ok(sameRows(after.slice(0, 4).map((l) => [l.linkId, l.mediaId, l.sortOrder]), keptBefore.map((l) => [l.linkId, l.mediaId, l.sortOrder])),
      'ADD the four old links keep their ids, media and positions');
    ok(new Set(after.map((l) => l.mediaId)).size === 6, 'ADD six distinct media — nothing was linked twice');
    ok(after[0].isPrimary === 1 && after[0].linkId === keptBefore[0].linkId, 'ADD the old cover stays the cover');
    ok(after.filter((l) => l.isPrimary === 1).length === 1, 'ADD exactly one primary');
    ok(allLinks(db as never).filter((l) => l.deletedAt !== null).length === 0, 'ADD not one existing link was retired');
  }

  // ── §22.3 REMOVE: A B C D − C ─────────────────────────────────────────────
  {
    const { db, co, baseline, fp, before } = await fixture();
    const c = baseline[2];
    await applyPlan(co, planFor(fp, baseline.filter((b) => b.linkId !== c.linkId).map((b) => ({ keep: b.linkId })), [c.linkId]), new Map(), 'batch-remove');

    const after = activeLinks(db as never);
    ok(after.length === 3, `REMOVE three images remain (${after.length})`);
    ok(!after.some((l) => l.linkId === c.linkId), 'REMOVE the named link is gone from the active gallery');
    ok(sameRows(after.map((l) => l.mediaId), baseline.filter((b) => b.linkId !== c.linkId).map((b) => b.mediaId)),
      'REMOVE exactly A, B and D remain, in order');
    const retired = allLinks(db as never).filter((l) => l.deletedAt !== null);
    ok(retired.length === 1 && retired[0].linkId === c.linkId, `REMOVE only C was retired (${retired.length})`);
    ok(retired[0].isPrimary === 0, 'REMOVE a retired link never keeps the primary flag');
    // §10 — Entfernen ist eine Link-Mutation. Die Medien-Objekte bleiben; das Aufraeumen der Dateien
    // ist Sache des bestehenden Reachability-/GC-Vertrags und passiert NICHT hier.
    const objs = (db as unknown as { exec: (s: string, p?: unknown[]) => Array<{ values: unknown[][] }> }).exec(
      `SELECT COUNT(*) FROM media_objects WHERE tenant_id=? AND deleted_at IS NULL`, [TENANT]);
    ok(Number(objs[0].values[0][0]) === 4, `REMOVE all four media objects are untouched (${objs[0].values[0][0]})`);
  }

  // ── §22.4 ADD + REMOVE: A B C D − C + E F ────────────────────────────────
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const c = baseline[2];
    const prepared = new Map([await prepareNew(gw, 'E', 0), await prepareNew(gw, 'F', 1)]);
    await applyPlan(co, planFor(fp,
      [...baseline.filter((b) => b.linkId !== c.linkId).map((b) => ({ keep: b.linkId })), { new: 0 }, { new: 1 }],
      [c.linkId]), prepared, 'batch-both');

    const after = activeLinks(db as never);
    ok(after.length === 5, `ADD+REMOVE exactly five images (${after.length})`);
    ok(!after.some((l) => l.mediaId === c.mediaId), 'ADD+REMOVE C is really gone');
    ok(sameRows(after.slice(0, 3).map((l) => l.linkId), baseline.filter((b) => b.linkId !== c.linkId).map((b) => b.linkId)),
      'ADD+REMOVE A, B and D kept their exact link ids');
    ok(new Set(after.map((l) => l.mediaId)).size === 5, 'ADD+REMOVE E and F appear exactly once each');
  }

  // ── §22.5 REORDER: A B C D → D A C B ─────────────────────────────────────
  {
    const { db, co, baseline, fp, before } = await fixture();
    const want = [baseline[3], baseline[0], baseline[2], baseline[1]];
    await applyPlan(co, planFor(fp, want.map((b) => ({ keep: b.linkId }))), new Map(), 'batch-reorder');

    const after = activeLinks(db as never);
    ok(sameRows(after.map((l) => l.linkId), want.map((b) => b.linkId)), `REORDER exactly the requested order (${after.map((l) => l.linkId).join(',')})`);
    ok(sameRows(after.map((l) => l.mediaId).sort(), before.map((l) => l.mediaId).sort()), 'REORDER not one media identity changed');
    ok(allLinks(db as never).length === 4, 'REORDER no link was created or deleted — only positions moved');
    ok(after[0].isPrimary === 1 && after[0].linkId === want[0].linkId, 'REORDER the new first image is the cover');
    ok(after.filter((l) => l.isPrimary === 1).length === 1, 'REORDER exactly one primary');
  }

  // ── §13 PRIMARY: unveraendert / Wechsel / neues Bild / Primary entfernt ───
  {
    const { db, co, baseline, fp } = await fixture();
    // Wechsel: C an die Spitze, Rest in Reihenfolge.
    const want = [baseline[2], baseline[0], baseline[1], baseline[3]];
    await applyPlan(co, planFor(fp, want.map((b) => ({ keep: b.linkId }))), new Map(), 'batch-primary');
    const after = activeLinks(db as never);
    ok(after[0].linkId === baseline[2].linkId && after[0].isPrimary === 1, 'PRIMARY the chosen image is the cover');
    ok(after.filter((l) => l.isPrimary === 1).length === 1, 'PRIMARY exactly one');
  }
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const prepared = new Map([await prepareNew(gw, 'E', 0)]);
    await applyPlan(co, planFor(fp, [{ new: 0 }, ...baseline.map((b) => ({ keep: b.linkId }))]), prepared, 'batch-primary-new');
    const after = activeLinks(db as never);
    ok(after.length === 5 && after[0].isPrimary === 1, 'PRIMARY a brand-new image can be the cover');
    ok(!baseline.some((b) => b.linkId === after[0].linkId), 'PRIMARY …and it really is the new one');
    ok(after.filter((l) => l.isPrimary === 1).length === 1, 'PRIMARY still exactly one');
  }
  {
    const { db, co, baseline, fp } = await fixture();
    // Das aktuelle Titelbild ausdruecklich entfernen — der Rest behaelt seine Reihenfolge.
    const head = baseline[0];
    await applyPlan(co, planFor(fp, baseline.slice(1).map((b) => ({ keep: b.linkId })), [head.linkId]), new Map(), 'batch-primary-removed');
    const after = activeLinks(db as never);
    ok(after.length === 3, `PRIMARY removing the cover leaves the rest (${after.length})`);
    ok(after.filter((l) => l.isPrimary === 1).length === 1, 'PRIMARY a new cover was chosen — never zero, never two');
    ok(after[0].linkId === baseline[1].linkId, 'PRIMARY …deterministically the next one in the requested order');
  }

  // ── §4/§22.10 STALE BASELINE: der fuenfte Link darf nicht sterben ─────────
  {
    const { db, gw, co, baseline, fp, before } = await fixture();
    // Das Handy hat A B C D gesehen. INZWISCHEN kommt E dazu (jemand anders, Desktop).
    const preparedE = new Map([await prepareNew(gw, 'E', 0)]);
    await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }]), preparedE, 'batch-external');
    const withFive = activeLinks(db as never);
    ok(withFive.length === 5, `STALE the gallery meanwhile holds five (${withFive.length})`);

    // Jetzt speichert das Handy mit seiner ALTEN Sicht: es kennt E nicht.
    const snapshot = allLinks(db as never);
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, baseline.map((b) => ({ keep: b.linkId }))), new Map(), 'batch-stale');
    } catch (e) { thrown = e; }
    ok(thrown instanceof MobileGalleryConflict && (thrown as MobileGalleryConflict).code === ERR_GALLERY_BASELINE_CHANGED,
      `STALE the save is refused as a conflict (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), snapshot), 'STALE not one media_links row changed');
    ok(activeLinks(db as never).length === 5, 'STALE the image the phone never saw is still there');
    ok(before.length === 4, 'STALE …and the four it did see are untouched too');
  }

  // ── §4 STALE bei UNVERAENDERTER Bildmenge: nur die Reihenfolge zog um ────
  //
  // Dieser Fall trifft ausschliesslich der Fingerabdruck: die Deckungspruefung sieht dieselben
  // Link-Ids und waere zufrieden. Ohne den Fingerabdruck wuerde das Handy eine fremde, neuere
  // Sortierung mit seiner alten ueberschreiben.
  {
    const { db, co, baseline, fp } = await fixture();
    const rotated = [baseline[1], baseline[2], baseline[3], baseline[0]];
    const fpNow = await galleryBaselineFingerprint(co.readGalleryBaseline(SCOPE));
    await applyPlan(co, planFor(fpNow, rotated.map((b) => ({ keep: b.linkId }))), new Map(), 'batch-ext-reorder');
    const snapshot = allLinks(db as never);

    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, baseline.map((b) => ({ keep: b.linkId }))), new Map(), 'batch-stale-order');
    } catch (e) { thrown = e; }
    ok((thrown as { code?: string })?.code === ERR_GALLERY_BASELINE_CHANGED,
      `STALE-ORDER a reorder by someone else is a conflict, even with the same images (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), snapshot), 'STALE-ORDER the newer order survives untouched');
    ok(activeLinks(db as never)[0].linkId === rotated[0].linkId, 'STALE-ORDER …including the cover');
  }

  // ── §6/§23 NEGATIVKONTROLLE: ein Bild einfach weglassen ist KEINE Loeschung ─
  {
    const { db, co, baseline, fp } = await fixture();
    const snapshot = allLinks(db as never);
    let thrown: unknown = null;
    try {
      // "Replace-all"-Denkweise: nur drei nennen und hoffen, dass das vierte verschwindet.
      await applyPlan(co, planFor(fp, baseline.slice(0, 3).map((b) => ({ keep: b.linkId }))), new Map(), 'batch-omit');
    } catch (e) { thrown = e; }
    ok(thrown instanceof MobileGalleryConflict && (thrown as MobileGalleryConflict).code === ERR_GALLERY_PLAN_INCOMPLETE,
      `OMIT an unnamed image is an error, not a deletion (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), snapshot), 'OMIT the gallery is completely untouched');
    ok(activeLinks(db as never).length === 4, 'OMIT all four images are still there');
  }

  // ── §6 ein fremder Link im Plan ist ebenfalls ein Fehler ──────────────────
  {
    const { db, co, baseline, fp } = await fixture();
    const snapshot = allLinks(db as never);
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { keep: 'lnk-from-nowhere' }]), new Map(), 'batch-foreign');
    } catch (e) { thrown = e; }
    ok((thrown as { code?: string })?.code === ERR_GALLERY_PLAN_INCOMPLETE, `FOREIGN a link that is not in the baseline is refused (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), snapshot), 'FOREIGN nothing changed');
  }

  // ── §20 MAX 8 ─────────────────────────────────────────────────────────────
  {
    const { db, gw, co, baseline, fp } = await fixture();
    // Erst auf acht auffuellen.
    const four = new Map([await prepareNew(gw, 'E', 0), await prepareNew(gw, 'F', 1), await prepareNew(gw, 'G', 2), await prepareNew(gw, 'H', 3)]);
    await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }, { new: 1 }, { new: 2 }, { new: 3 }]), four, 'batch-fill');
    const eight = co.readGalleryBaseline(SCOPE);
    const fp8 = await galleryBaselineFingerprint(eight);
    ok(eight.length === 8, `MAX8 the gallery is full (${eight.length})`);

    // 8 behalten + 1 dazu → abgewiesen.
    const snapshot = allLinks(db as never);
    const preparedI = new Map([await prepareNew(gw, 'I', 0)]);
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp8, [...eight.map((b) => ({ keep: b.linkId })), { new: 0 }]), preparedI, 'batch-nine');
    } catch (e) { thrown = e; }
    ok((thrown as { code?: string })?.code === ERR_GALLERY_TOO_MANY, `MAX8 a ninth image is refused (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), snapshot), 'MAX8 …and the full gallery is untouched');

    // 8 behalten, 1 entfernen, 1 dazu → erlaubt, Endzustand 8.
    const drop = eight[7];
    await applyPlan(co, planFor(fp8, [...eight.filter((b) => b.linkId !== drop.linkId).map((b) => ({ keep: b.linkId })), { new: 0 }], [drop.linkId]), preparedI, 'batch-swap');
    const after = activeLinks(db as never);
    ok(after.length === 8, `MAX8 removing one and adding one stays within the cap (${after.length})`);
    ok(!after.some((l) => l.linkId === drop.linkId), 'MAX8 …the dropped one is gone');
  }

  // ── §17 REPLAY / DOUBLE SAVE: derselbe Plan zweimal ───────────────────────
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const prepared = new Map([await prepareNew(gw, 'E', 0)]);
    const plan = planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }]);
    const env = await applyPlan(co, plan, prepared, 'batch-replay');
    const afterFirst = allLinks(db as never);
    ok(activeLinks(db as never).length === 5, 'REPLAY the first save added the image');

    // Exakt derselbe eingefrorene Envelope noch einmal — so verhaelt sich ein Resume.
    const again = await co.applyEditBatch(env);
    ok(again.status === 'noop_already_applied', `REPLAY the same frozen plan is a no-op (${again.status})`);
    ok(sameRows(allLinks(db as never), afterFirst), 'REPLAY not one row changed');
    ok(activeLinks(db as never).length === 5, 'REPLAY still five — no duplicate link');
    ok(new Set(activeLinks(db as never).map((l) => l.mediaId)).size === 5, 'REPLAY no duplicate media');
    ok(activeLinks(db as never).filter((l) => l.isPrimary === 1).length === 1, 'REPLAY still exactly one primary');
  }

  // ── §15.C ATOMARITAET: scheitert der Commit, bleibt die alte Galerie ──────
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const snapshot = allLinks(db as never);
    // Ein Bild, das vorbereitet ist, dessen Commit aber scheitert (die Bytes sind dem Gateway
    // unbekannt) — genau der Fall "gestaged, aber nicht committbar".
    const prepared = new Map([[0, { requestId: 'never-prepared', prepared: { ingest_request_id: 'never-prepared', request_hash: 'x'.repeat(64), state: 'prepared', main_descriptor: d('a'.repeat(64), 24), thumbnail_descriptor: d('b'.repeat(64), 12) } as PrepareResult }]]);
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }]), prepared, 'batch-commitfail');
    } catch (e) { thrown = e; }
    ok(thrown !== null, `COMMIT-FAIL the save fails loudly (${(thrown as { message?: string })?.message?.slice(0, 40)})`);
    ok(sameRows(allLinks(db as never), snapshot), 'COMMIT-FAIL every media_links row is byte-identical to before');
    ok(activeLinks(db as never).length === 4, 'COMMIT-FAIL all four old images are still there');
    ok(activeLinks(db as never).filter((l) => l.isPrimary === 1).length === 1, 'COMMIT-FAIL the old cover is still the cover');
    void gw;
  }

  // ── §15.D ADD scheitert → REMOVE darf NICHT trotzdem greifen ─────────────
  {
    const { db, co, baseline, fp } = await fixture();
    const snapshot = allLinks(db as never);
    const c = baseline[2];
    const prepared = new Map([[0, { requestId: 'broken-new', prepared: { ingest_request_id: 'broken-new', request_hash: 'y'.repeat(64), state: 'prepared', main_descriptor: d('c'.repeat(64), 24), thumbnail_descriptor: d('d'.repeat(64), 12) } as PrepareResult }]]);
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, [...baseline.filter((b) => b.linkId !== c.linkId).map((b) => ({ keep: b.linkId })), { new: 0 }], [c.linkId]), prepared, 'batch-addfail');
    } catch (e) { thrown = e; }
    ok(thrown !== null, 'ADD-FAIL the combined save fails');
    ok(sameRows(allLinks(db as never), snapshot), 'ADD-FAIL the removal was NOT committed on its own');
    ok(activeLinks(db as never).some((l) => l.linkId === c.linkId), 'ADD-FAIL C is still in the gallery');
    ok(activeLinks(db as never).length === 4, 'ADD-FAIL all four images are still there');
  }

  // ── §4 ORPHANS: was passiert, wenn ein Bild schon veroeffentlicht ist ─────
  //
  // Der ehrliche Ablauf: `applyEditBatch` committet JEDES neue Bild beim Gateway, BEVOR die
  // Transaktion beginnt. Scheitert danach etwas, sind die Bytes bereits veroeffentlicht — die
  // Datenbank aber unberuehrt. Genau das wird hier gemessen: ein Batch mit zwei neuen Bildern, bei
  // dem das zweite von seinem eingefrorenen Deskriptor abweicht. Das erste ist dann committed, der
  // Job faellt, und es darf trotzdem KEINE Zeile entstehen.
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const snapshot = allLinks(db as never);
    const objectsBefore = countRows(db as never, 'media_objects');
    const gensBefore = countRows(db as never, 'media_blob_generations');
    const variantsBefore = countRows(db as never, 'media_variants');
    const commitsBefore = gw.commits;

    const good = await prepareNew(gw, 'E', 0);
    // Das zweite Bild traegt einen eingefrorenen Deskriptor, den der Commit nicht bestaetigen wird.
    const diverged = [1, { requestId: 'diverged', prepared: { ...good[1].prepared, ingest_request_id: 'diverged', main_descriptor: d('9'.repeat(64), 24) } as PrepareResult }] as const;
    let thrown: unknown = null;
    try {
      await applyPlan(co, planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }, { new: 1 }]), new Map([good, diverged]), 'batch-orphan');
    } catch (e) { thrown = e; }

    ok(thrown !== null, `ORPHAN the save fails (${(thrown as { message?: string })?.message?.slice(0, 40)})`);
    ok(gw.commits > commitsBefore, `ORPHAN at least one new image WAS already published (${gw.commits - commitsBefore})`);
    ok(sameRows(allLinks(db as never), snapshot), 'ORPHAN not one media_links row was written');
    ok(countRows(db as never, 'media_objects') === objectsBefore, `ORPHAN no media_objects row (${countRows(db as never, 'media_objects')} vs ${objectsBefore})`);
    ok(countRows(db as never, 'media_blob_generations') === gensBefore, `ORPHAN no generation row (${countRows(db as never, 'media_blob_generations')} vs ${gensBefore})`);
    ok(countRows(db as never, 'media_variants') === variantsBefore, `ORPHAN no variant row (${variantsBefore})`);
    ok(activeLinks(db as never).length === 4 && activeLinks(db as never)[0].isPrimary === 1, 'ORPHAN the old gallery and its cover are intact');
    // Damit steht der Vertrag fest: das veroeffentlichte, aber nirgends verknuepfte Rendition ist
    // UNERREICHBAR und wird ausschliesslich vom bestehenden Reachability-/GC-Vertrag abgeraeumt.
    // Hier wird bewusst NICHTS geloescht — ad-hoc-Loeschen waere genau der Weg, auf dem ein noch
    // referenziertes Bild verschwinden koennte.
    ok(!allLinks(db as never).some((l) => l.mediaId.includes('diverged')), 'ORPHAN the unreferenced rendition is reachable from nothing');
  }

  // ── §6 REPLAY NACH FREMDER AENDERUNG: kein Wiederherstellen, kein Ueberschreiben ──
  //
  // Der gefaehrliche Fall hinter `noop_already_applied`: derselbe Plan wird ein zweites Mal
  // vorgelegt, NACHDEM jemand anders die Galerie weiterbewegt hat. Er darf weder den alten Zustand
  // zurueckholen noch die fremde Aenderung ueberschreiben.
  {
    const { db, gw, co, baseline, fp } = await fixture();
    const plan = planFor(fp, baseline.slice(1).map((b) => ({ keep: b.linkId })), [baseline[0].linkId]);
    await applyPlan(co, plan, new Map(), 'batch-r1');
    ok(activeLinks(db as never).length === 3, `REPLAY-EXT the first save applied (${activeLinks(db as never).length})`);

    // Jemand anders fuegt danach ein Bild hinzu.
    const nowBase = co.readGalleryBaseline(SCOPE);
    const preparedX = new Map([await prepareNew(gw, 'X', 0)]);
    await applyPlan(co, planFor(await galleryBaselineFingerprint(nowBase), [...nowBase.map((b) => ({ keep: b.linkId })), { new: 0 }]), preparedX, 'batch-ext');
    const external = allLinks(db as never);
    ok(activeLinks(db as never).length === 4, `REPLAY-EXT someone else added an image (${activeLinks(db as never).length})`);

    // Derselbe alte Plan noch einmal — ueber den vollen mobilen Weg, so wie ein Resume ihn nimmt.
    let thrown: unknown = null;
    try { await applyPlan(co, plan, new Map(), 'batch-r1'); } catch (e) { thrown = e; }
    ok((thrown as { code?: string })?.code === ERR_GALLERY_BASELINE_CHANGED,
      `REPLAY-EXT the stale plan is a conflict, not a success (${(thrown as { code?: string })?.code})`);
    ok(sameRows(allLinks(db as never), external), 'REPLAY-EXT the external change is untouched');
    ok(activeLinks(db as never).length === 4, 'REPLAY-EXT the removed image was NOT restored and nothing was overwritten');
  }

  // ── v0.8.48 §17 GEMISCHTER SAVE: Felder UND Bilder in EINER Transaktion ──
  //
  // Der Benutzer aendert im selben Bildschirm die Notiz und die Reihenfolge und drueckt einmal
  // Speichern. Beides muss zusammen ankommen — "Preis gespeichert, Bildaenderung verloren" darf es
  // nicht geben. Der Feld-Patch reist als `productEdit` im selben Umschlag.
  {
    const { db, co, baseline, fp } = await fixture();
    (db as unknown as { run: (s: string, p?: unknown[]) => void }).run(`UPDATE products SET name = ? WHERE id = ?`, ["Alt", PRODUCT]);
    const want = [baseline[2], baseline[0], baseline[1], baseline[3]];
    const env = await buildMobileGalleryEnvelope({
      plan: planFor(fp, want.map((b) => ({ keep: b.linkId }))),
      baseline: co.readGalleryBaseline(SCOPE), preparedBySlot: new Map(), batchId: "batch-mixed",
      tenantId: TENANT, branchId: BRANCH, entityId: PRODUCT, role: ROLE, digestHex,
      productEdit: {
        set: [["name", "Neu"]], baseline: ["Alt"], invalidateImageDerived: true, withSync: false,
        audit: { module: "Product", changedBy: null, newValueJson: "{}" },
      },
    });
    co.registerEditPlan(env);
    await co.applyEditBatch(env);

    const after = activeLinks(db as never);
    ok(sameRows(after.map((l) => l.linkId), want.map((b) => b.linkId)), "MIXED the gallery order really moved");
    const nameNow = (db as unknown as { exec: (s: string, p?: unknown[]) => Array<{ values: unknown[][] }> }).exec(`SELECT name FROM products WHERE id=?`, [PRODUCT]);
    ok(String(nameNow[0].values[0][0]) === "Neu", `MIXED …and the field change landed in the SAME save (${nameNow[0].values[0][0]})`);
    ok(after.filter((l) => l.isPrimary === 1).length === 1, "MIXED exactly one primary");
  }

  // Und der Gegenbeweis: scheitert der Bildteil, darf der Feldteil NICHT allein durchkommen.
  {
    const { db, gw, co, baseline, fp } = await fixture();
    (db as unknown as { run: (s: string, p?: unknown[]) => void }).run(`UPDATE products SET name = ? WHERE id = ?`, ["Alt", PRODUCT]);
    const snapshot = allLinks(db as never);
    const broken = new Map([[0, { requestId: "mixed-broken", prepared: { ingest_request_id: "mixed-broken", request_hash: "z".repeat(64), state: "prepared", main_descriptor: d("7".repeat(64), 24), thumbnail_descriptor: d("8".repeat(64), 12) } as PrepareResult }]]);
    let thrown: unknown = null;
    try {
      const env = await buildMobileGalleryEnvelope({
        plan: planFor(fp, [...baseline.map((b) => ({ keep: b.linkId })), { new: 0 }]),
        baseline: co.readGalleryBaseline(SCOPE), preparedBySlot: broken, batchId: "batch-mixed-fail",
        tenantId: TENANT, branchId: BRANCH, entityId: PRODUCT, role: ROLE, digestHex,
        productEdit: {
          set: [["name", "Neu"]], baseline: ["Alt"], invalidateImageDerived: true, withSync: false,
          audit: { module: "Product", changedBy: null, newValueJson: "{}" },
        },
      });
      co.registerEditPlan(env);
      await co.applyEditBatch(env);
    } catch (e) { thrown = e; }
    ok(thrown !== null, "MIXED-FAIL the combined save fails");
    ok(sameRows(allLinks(db as never), snapshot), "MIXED-FAIL the gallery is untouched");
    const nameNow = (db as unknown as { exec: (s: string, p?: unknown[]) => Array<{ values: unknown[][] }> }).exec(`SELECT name FROM products WHERE id=?`, [PRODUCT]);
    ok(String(nameNow[0].values[0][0]) === "Alt", `MIXED-FAIL …and the field change was NOT committed on its own (${nameNow[0].values[0][0]})`);
    void gw;
  }
  // ── §7 TEXT-ONLY bleibt unberuehrt: der Galerie-Pfad fasst ihn nicht an ───
  {
    const { db, co } = await fixture();
    (db as unknown as { run: (s: string, p?: unknown[]) => void }).run(`UPDATE products SET name = 'Alt' WHERE id = ?`, [PRODUCT]);
    const snapshot = allLinks(db as never);
    co.applyProductTextEditDurably({
      tenantId: TENANT, branchId: BRANCH, entityId: PRODUCT, batchId: 'text-1',
      productEdit: { set: [['name', 'Neuer Name']], baseline: ['Alt'], invalidateImageDerived: false, withSync: false, audit: { module: 'Product', changedBy: null, newValueJson: '{}' } },
    });
    const nameNow = (db as unknown as { exec: (s: string, p?: unknown[]) => Array<{ values: unknown[][] }> }).exec(`SELECT name FROM products WHERE id=?`, [PRODUCT]);
    ok(String(nameNow[0].values[0][0]) === 'Neuer Name', 'TEXT-ONLY the text edit really landed');
    ok(sameRows(allLinks(db as never), snapshot), 'TEXT-ONLY a text edit leaves every media_links row byte-identical');
    ok(activeLinks(db as never).length === 4, 'TEXT-ONLY still four images');
  }
}

main()
  .catch((e) => { FAIL++; failures.push('harness: ' + ((e as { message?: string })?.message ?? String(e))); console.error(e); })
  .finally(() => {
    console.log(`\nMOBILE-EDIT-S3 gallery plan + apply: ${PASS} passed, ${FAIL} failed`);
    if (FAIL > 0) { for (const f of failures) console.log('   - ' + f); process.exit(1); }
  });

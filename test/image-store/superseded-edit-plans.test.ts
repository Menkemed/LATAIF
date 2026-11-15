// OWNER-WARTUNG — überholte Galerie-Bearbeitungen kontrolliert abbrechen. Gegen das ECHTE Medienschema
// (sql.js, alle Trigger), den ECHTEN Coordinator (registerEditPlan / applyEditBatch / recover) und den
// echten Plan-Bau (buildEditPlanEnvelope). Rust wird durch einen deterministischen Ersatz vertreten
// (die Rust-Seite hat ihren eigenen Test: ingest_tests.rs `journal_entry_present_is_read_only_and_exact`).
//
// Nachgestellt sind genau die zwei Befund-Muster:
//   A „Ersetzen“ (wie CAR-OGJ-001): alter Plan [X] → [neu R1] + Einkaufspreis null; später [X] → [neu R2] ok.
//   B „Entfernen“ (wie TAG-WCH-004): alter Plan [Y1,Y2] → [Y1] + Preise null; später dasselbe mit Preisen 0 ok.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { MediaDbCoordinator, editRequestId, type FinalizeInput, type ProductEditIntent } from '../../src/core/media/coordinator.ts';
import { buildEditPlanEnvelope } from '../../src/core/media/product-media-edit.ts';
import { canonicalRequestHash } from '../../src/core/media/product-media-cutover.ts';
import { findProductsNeedingEmbedding } from '../../src/core/media/embedding-reconcile.ts';
import { assertMigrationPreconditions, type MigrationDb } from '../../src/core/media/image-store-migration.ts';
import {
  SUPERSEDED_EDIT_PLAN_CASES, EDIT_PLAN_SUPERSEDED, inspectSupersededEditPlan, closeSupersededEditPlan,
  type SupersededEditPlanCase, type SupersededDeps, type SupersededDb,
} from '../../src/core/media/superseded-edit-plans.ts';
import type {
  AbortInput, AbortResult, CommitInput, CommitResult, MediaBytes, MediaCommandGateway, PrepareInput, PrepareResult,
  ReadVerifiedInput, RecoveryOutcome,
} from '../../src/core/media/gateway.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
const pad64 = (s: string) => (s.toLowerCase().replace(/[^0-9a-f]/g, '0') + '0'.repeat(64)).slice(0, 64);
const key = (t: string, h: string) => `${t}/${h.slice(0, 2)}/${h}.jpg`;
const desc = (hash: string, size: number) => ({ hash, extension: 'jpg', content_kind: 'raster_image', mime_type: 'image/jpeg', byte_size: size, width: 1200, height: 900 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const digest = (s: string) => canonicalRequestHash(new TextEncoder().encode(s), 'edit-plan');

class FakeGateway implements MediaCommandGateway {
  jobs = new Map<string, { hash: string; main: string; thumb: string }>();
  sizes = new Map<string, number>();
  preset(t: string, req: string, reqHash: string, main: string, thumb: string) {
    this.jobs.set(`${t}::${req}`, { hash: reqHash, main, thumb }); this.sizes.set(main, 50_000); this.sizes.set(thumb, 8_000);
  }
  async prepareStockImage(i: PrepareInput): Promise<PrepareResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`)!;
    return { ingest_request_id: i.ingestRequestId, request_hash: i.requestHash, state: 'prepared', main_descriptor: desc(j.main, 50_000), thumbnail_descriptor: desc(j.thumb, 8_000) };
  }
  async commitStockImage(i: CommitInput): Promise<CommitResult> {
    const j = this.jobs.get(`${i.tenantScope}::${i.ingestRequestId}`);
    if (!j) throw new Error('MEDIA_INGEST_NOT_FOUND');
    return { state: 'published', main_descriptor: desc(j.main, 50_000), thumbnail_descriptor: desc(j.thumb, 8_000), main_storage_key: key(i.tenantScope, j.main), thumbnail_storage_key: key(i.tenantScope, j.thumb) };
  }
  async abortStockImage(i: AbortInput): Promise<AbortResult> { return { ingest_request_id: i.ingestRequestId, state: 'aborted' }; }
  async readVerifiedMedia(i: ReadVerifiedInput): Promise<MediaBytes> {
    const n = this.sizes.get(i.hash);
    if (n == null) throw new Error('MEDIA_FILE_MISSING');
    return { bytes: new Uint8Array(n), hash: i.hash, byte_size: n, mime_type: 'image/jpeg', extension: 'jpg' };
  }
  async recoverMediaIngests(): Promise<RecoveryOutcome[]> { return []; }
}

function q(db: any, sql: string, p: unknown[] = []): any[] {
  const r = db.exec(sql, p);
  if (!r.length) return [];
  return r[0].values.map((v: unknown[]) => Object.fromEntries(r[0].columns.map((c: string, i: number) => [c, v[i]])));
}

/** Alles außer media_ingest_jobs/audit_log — muss der Abbruch unverändert lassen. */
function untouchedDigest(db: any): string {
  const t = ['products', 'media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations', 'sync_changelog'];
  return JSON.stringify(t.map((n) => q(db, `SELECT * FROM ${n} ORDER BY 1, 2`)));
}
const jobsOtherThan = (db: any, ids: string[]) => JSON.stringify(q(db, `SELECT * FROM media_ingest_jobs WHERE job_id NOT IN (${ids.map(() => '?').join(',')}) ORDER BY job_id`, ids));

const T = 't1', B = 'b1', ROLE = 'stock_image';
const OWNER = { userId: 'user-owner', role: 'owner' };

async function world(SQL: any) {
  const db = new SQL.Database();
  db.run(`CREATE TABLE tenants (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
  }
  for (const col of ['sku TEXT', `images TEXT DEFAULT '[]'`, 'category_id TEXT', 'image_hash TEXT', 'image_description TEXT', 'image_embedding TEXT',
    'updated_at TEXT', 'purchase_price REAL NOT NULL DEFAULT 0', 'planned_sale_price REAL', 'min_sale_price REAL', 'notes TEXT']) {
    db.run(`ALTER TABLE products ADD COLUMN ${col}`);
  }
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER, created_at TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, branch_id TEXT, module TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    action_type TEXT NOT NULL, field_name TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, changed_at TEXT NOT NULL)`);
  db.run(`INSERT INTO tenants VALUES ('t1')`);
  db.run(`INSERT INTO branches VALUES ('b1','t1')`);
  db.run(`INSERT INTO products (id, branch_id, sku, images, category_id, purchase_price, planned_sale_price, min_sale_price, notes, updated_at)
          VALUES ('pA','b1','CAR-T-001','[]','cat-original-gold-jewelry',1650,NULL,NULL,NULL,'2026-10-01'),
                 ('pB','b1','TAG-T-004','[]','cat-watch',100,200,150,'Test','2026-08-25'),
                 ('pC','b1','OK-T-009','[]','cat-watch',10,NULL,NULL,NULL,'2026-08-01')`);
  applyMediaSchema(db);
  const gw = new FakeGateway();
  const coord = new MediaDbCoordinator(db, gw);
  let n = 0;
  const add = async (pid: string, sortOrder: number) => {
    n++;
    const req = `req-${pid}-${n}`;
    gw.preset(T, req, pad64(`c${n}${pid}`), pad64(`a${n}${pid.length}0`), pad64(`b${n}${pid.length}1`));
    await coord.finalize({ tenantId: T, branchId: B, entityType: 'product', entityId: pid, scopeKind: 'branch', role: ROLE,
      ingestRequestId: req, requestHash: pad64(`c${n}${pid}`), isPrimary: sortOrder === 0, sortOrder } as FinalizeInput);
  };
  const scope = (pid: string) => ({ tenantId: T, scopeKind: 'branch' as const, branchId: B, entityType: 'product', entityId: pid, role: ROLE });
  /** Plan bauen wie Handy/Desktop (buildEditPlanEnvelope) aus dem HEUTIGEN Ausgangsstand. */
  const plan = async (pid: string, ev: string, desired: Array<{ keep: number } | { newReq: string }>, productEdit?: ProductEditIntent) => {
    const baseline = coord.readGalleryBaseline(scope(pid));
    const prepared = new Map<string, PrepareResult>();
    const d = [];
    for (const x of desired) {
      if ('keep' in x) d.push({ source: 'keep' as const, mediaId: baseline[x.keep].mediaId });
      else {
        gw.preset(T, x.newReq, pad64(`d${x.newReq}`), pad64(`e${x.newReq}0`), pad64(`f${x.newReq}1`));
        prepared.set(x.newReq, await gw.prepareStockImage({ tenantScope: T, ingestRequestId: x.newReq, requestHash: pad64(`d${x.newReq}`), imageBytes: new Uint8Array(1) }));
        d.push({ source: 'new' as const, requestId: x.newReq, requestHash: pad64(`d${x.newReq}`) });
      }
    }
    return buildEditPlanEnvelope({ batchId: `gallery-edit:${T}:${B}:${pid}:${ROLE}:${ev}`, tenantId: T, branchId: B, scopeKind: 'branch',
      entityType: 'product', entityId: pid, role: ROLE, baseline, desired: d, prepared, productEdit }, digest);
  };
  const pe = (set: Array<[string, string | number | null]>, baseline: Array<string | number | null>): ProductEditIntent =>
    ({ set, baseline, invalidateImageDerived: true, withSync: true, audit: { module: 'Product', changedBy: null, newValueJson: '{}' } });

  // Ausgangslage: A hat ein Foto, B zwei, C eins (C bleibt ganz normal).
  await add('pA', 0);
  await add('pB', 0); await add('pB', 1);
  await add('pC', 0);
  // A — alter Plan: ersetzen + Einkaufspreis null. Er wird eingefroren, die Anwendung scheitert (wie damals).
  const a1 = await plan('pA', 'ev-a1', [{ newReq: 'aaaaaaaa1111' }], pe([['purchase_price', null]], [1650]));
  coord.registerEditPlan(a1);
  let a1Err = '';
  try { await coord.applyEditBatch(a1); } catch (e) { a1Err = (e as Error).message; }
  // B — alter Plan: zweites Foto entfernen + Preise/Notiz leeren; scheitert ebenso.
  const b1 = await plan('pB', 'ev-b1', [{ keep: 0 }], pe([['purchase_price', null], ['planned_sale_price', null], ['min_sale_price', null], ['notes', null]], [100, 200, 150, 'Test']));
  coord.registerEditPlan(b1);
  let b1Err = '';
  try { await coord.applyEditBatch(b1); } catch (e) { b1Err = (e as Error).message; }
  await sleep(5);
  // Die späteren, erfolgreichen Aufträge vom selben Ausgangsstand.
  const a2 = await plan('pA', 'ev-a2', [{ newReq: 'aaaaaaaa2222' }], pe([['purchase_price', 0]], [1650]));
  coord.registerEditPlan(a2); await coord.applyEditBatch(a2);
  const b2 = await plan('pB', 'ev-b2', [{ keep: 0 }], pe([['purchase_price', 0], ['planned_sale_price', 0], ['min_sale_price', 0], ['notes', null]], [100, 200, 150, 'Test']));
  coord.registerEditPlan(b2); await coord.applyEditBatch(b2);

  const job = (env: { plan: { batchId: string } }) => q(db, `SELECT * FROM media_ingest_jobs WHERE ingest_request_id = ?`, [editRequestId(env.plan.batchId)])[0];
  const mkCase = (sku: string, pid: string, stale: typeof a1, succ: typeof a2): SupersededEditPlanCase => {
    const j = job(stale);
    return { sku, tenantId: T, branchId: B, role: ROLE, productId: pid, jobId: String(j.job_id), ingestRequestId: String(j.ingest_request_id),
      requestHash: stale.plan.planHash, createdAt: String(j.created_at), supersededByIngestRequestId: editRequestId(succ.plan.batchId) };
  };
  const cases = [mkCase('CAR-T-001', 'pA', a1, a2), mkCase('TAG-T-004', 'pB', b1, b2)];
  const journal = new Set<string>();
  const deps = (over: Partial<SupersededDeps> = {}): SupersededDeps => ({
    db: db as SupersededDb, inspect: (t, r) => coord.inspectStoredEditPlan(t, r),
    journalPresent: async (_t, rid) => journal.has(rid), cases, now: () => '2026-11-15T12:00:00.000Z', ...over,
  });
  return { db, gw, coord, cases, deps, journal, a1, a2, b1, b2, a1Err, b1Err, job, plan, pe, mkCase };
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ── §0 die feste Liste: genau die zwei Befund-Jobs ─────────────────────────────
  ok(SUPERSEDED_EDIT_PLAN_CASES.length === 2 && Object.isFrozen(SUPERSEDED_EDIT_PLAN_CASES) && SUPERSEDED_EDIT_PLAN_CASES.every((c) => Object.isFrozen(c)), 'genau zwei zugelassene Vorgänge, unveränderlich');
  ok(SUPERSEDED_EDIT_PLAN_CASES.map((c) => c.sku).join(',') === 'TAG-WCH-004,CAR-OGJ-001', 'TAG-WCH-004 und CAR-OGJ-001');
  ok(SUPERSEDED_EDIT_PLAN_CASES.every((c) => c.jobId === `job-${c.ingestRequestId}` && c.ingestRequestId.includes(c.productId) && c.supersededByIngestRequestId.includes(c.productId) && c.supersededByIngestRequestId !== c.ingestRequestId), 'Job-, Artikel- und Nachfolger-Kennungen passen zueinander');

  // ── §1 Welt: beide Muster wie im Befund ─────────────────────────────────────
  const W = await world(SQL);
  const { db, coord, cases, deps, journal } = W;
  ok(/PURCHASE_PRICE_REQUIRED/.test(W.a1Err) && /PURCHASE_PRICE_REQUIRED/.test(W.b1Err), `Testwelt: die alten Pläne scheitern wie damals (${W.a1Err})`);
  ok(cases.every((c) => q(db, `SELECT state FROM media_ingest_jobs WHERE job_id = ?`, [c.jobId])[0]?.state === 'accepted'), 'Testwelt: beide alten Jobs hängen auf accepted');
  const rec0 = await coord.recover();
  const r0 = (c: SupersededEditPlanCase) => rec0.find((r) => r.ingestRequestId === c.ingestRequestId)?.action;
  ok(r0(cases[0]) === 'left_pending_edit_baseline_changed' && r0(cases[1]) === 'left_pending_edit_product_changed', 'Wiederherstellung lässt beide liegen (wie im Betrieb)');
  ok(findProductsNeedingEmbedding(db).map((s) => s.productId).sort().join(',') === 'pC', 'vorher: A und B fehlen im Embedding-Abgleich (blockiert), C nicht');
  let migBlocked = '';
  try { assertMigrationPreconditions(db as MigrationDb); } catch (e) { migBlocked = (e as Error).message; }
  ok(migBlocked !== '', `vorher: Bildmigration blockiert (${migBlocked})`);

  // ── §2 Prüfen ────────────────────────────────────────────────────────────────
  const before = untouchedDigest(db);
  const auditBefore = q(db, `SELECT COUNT(*) AS n FROM audit_log`)[0].n;
  const vA = await inspectSupersededEditPlan(deps(), cases[0].jobId);
  const vB = await inspectSupersededEditPlan(deps(), cases[1].jobId);
  ok(vA.status === 'closable' && vA.evidence.galleryAtBaseline === false && vA.evidence.galleryAtTarget === false && vA.evidence.newImageRequestIds.join() === 'aaaaaaaa1111', 'A erkannt: Ausgangsstand überholt, neues Bild ohne Journal');
  ok(vB.status === 'closable' && vB.evidence.galleryAtTarget === true && vB.evidence.productAtBaseline === false && vB.evidence.productAtTarget === false, 'B erkannt: Galerie am Ziel, Artikel weder am Ausgangs- noch Zielstand');
  ok(vA.status === 'closable' && vA.evidence.successor.state === 'ready' && vB.status === 'closable' && vB.evidence.successor.state === 'ready', 'späterer erfolgreicher Auftrag nachgewiesen');
  ok(untouchedDigest(db) === before && q(db, `SELECT COUNT(*) AS n FROM audit_log`)[0].n === auditBefore, 'Prüfen schreibt nichts');

  // ── §3 Abweisungen (keine Mutation) ─────────────────────────────────────────
  const jobsSnap = () => JSON.stringify(q(db, `SELECT * FROM media_ingest_jobs ORDER BY job_id`));
  const snap0 = jobsSnap();
  const fpA = vA.status === 'closable' ? vA.fingerprint : '';
  const fpB = vB.status === 'closable' ? vB.fingerprint : '';
  const succJobId = `job-${cases[0].supersededByIngestRequestId}`;
  ok((await inspectSupersededEditPlan(deps(), succJobId)).status === 'refused' && (await closeSupersededEditPlan(deps(), succJobId, fpA, OWNER) as { code?: string }).code === 'SUPERSEDED_NOT_ALLOWLISTED', 'nicht eingetragener Job (z. B. der Nachfolger) → abgewiesen');
  ok((await closeSupersededEditPlan(deps({ cases: SUPERSEDED_EDIT_PLAN_CASES }), cases[0].jobId, fpA, OWNER) as { code?: string }).code === 'SUPERSEDED_NOT_ALLOWLISTED', 'Produktionsliste lässt fremde Jobs nicht zu');
  ok((await closeSupersededEditPlan(deps(), cases[0].jobId, fpA, { userId: 'u2', role: 'manager' }) as { code?: string }).code === 'SUPERSEDED_NOT_OWNER', 'nur der Owner');
  ok((await closeSupersededEditPlan(deps(), cases[0].jobId, 'f'.repeat(64), OWNER) as { code?: string }).code === 'SUPERSEDED_FINGERPRINT_CHANGED', 'ohne passenden Fingerabdruck der Prüfung → abgewiesen');
  const variant = (patch: Partial<SupersededEditPlanCase>) => deps({ cases: [{ ...cases[0], ...patch }, cases[1]] });
  ok((await inspectSupersededEditPlan(variant({ sku: 'CAR-T-999' }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_PRODUCT_MISMATCH', 'falsche SKU → abgewiesen');
  ok((await inspectSupersededEditPlan(variant({ productId: 'pC' }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_JOB_MISMATCH', 'falsche Artikelzuordnung → abgewiesen');
  ok((await inspectSupersededEditPlan(variant({ requestHash: pad64('beef') }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_JOB_MISMATCH', 'anderer Plan-Hash → abgewiesen');
  ok((await inspectSupersededEditPlan(variant({ createdAt: '2026-01-01T00:00:00.000Z' }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_JOB_MISMATCH', 'anderer Zeitstempel → abgewiesen');
  ok((await inspectSupersededEditPlan(variant({ supersededByIngestRequestId: cases[1].supersededByIngestRequestId }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_NO_SUCCESSOR', 'Nachfolger eines anderen Artikels zählt nicht');
  ok((await inspectSupersededEditPlan(variant({ supersededByIngestRequestId: 'edit:gallery-edit:nope' }), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_NO_SUCCESSOR', 'ohne nachgewiesenen Nachfolger → abgewiesen');
  journal.add('aaaaaaaa1111');
  ok((await closeSupersededEditPlan(deps(), cases[0].jobId, fpA, OWNER) as { code?: string }).code === 'SUPERSEDED_JOURNAL_PRESENT', 'Rust hält noch Journal/Temp für das neue Bild → abgewiesen');
  journal.delete('aaaaaaaa1111');
  ok(jobsSnap() === snap0 && untouchedDigest(db) === before, 'alle Abweisungen: keine Zeile geändert');

  // Zustand anders als accepted
  db.run(`UPDATE media_ingest_jobs SET state = 'failed', error_code = 'X' WHERE job_id = ?`, [cases[0].jobId]);
  ok((await inspectSupersededEditPlan(deps(), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_STATE_CHANGED', 'Job nicht mehr accepted → abgewiesen');
  db.run(`UPDATE media_ingest_jobs SET state = 'accepted', error_code = NULL WHERE job_id = ?`, [cases[0].jobId]);
  // Neues Bild doch als Medium vorhanden / Zielspalte gesetzt → hängt noch etwas dran
  db.run(`UPDATE media_ingest_jobs SET target_media_id = 'media-x' WHERE job_id = ?`, [cases[0].jobId]);
  ok((await inspectSupersededEditPlan(deps(), cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_PENDING_MEDIA', 'Job verweist auf Zielmedium → abgewiesen');
  db.run(`UPDATE media_ingest_jobs SET target_media_id = NULL WHERE job_id = ?`, [cases[0].jobId]);
  // B: Artikel wieder am Ausgangsstand → der Plan wäre anwendbar → nie abbrechen
  db.run(`UPDATE products SET purchase_price = 100, planned_sale_price = 200, min_sale_price = 150, notes = 'Test' WHERE id = 'pB'`);
  ok((await inspectSupersededEditPlan(deps(), cases[1].jobId) as { code?: string }).code === 'SUPERSEDED_PLAN_STILL_APPLICABLE', 'B: Plan wäre wieder anwendbar → abgewiesen');
  db.run(`UPDATE products SET purchase_price = 0, planned_sale_price = 0, min_sale_price = 0, notes = NULL WHERE id = 'pB'`);
  // Veränderung zwischen Prüfung und Abbruch (während Rust-Journal-Abfrage) → nicht schreiben
  const racing = deps({ journalPresent: async () => { db.run(`UPDATE media_ingest_jobs SET attempt_count = attempt_count + 1 WHERE job_id = ?`, [cases[0].jobId]); return false; } });
  const raced = await closeSupersededEditPlan(racing, cases[0].jobId, fpA, OWNER) as { status: string; code?: string };
  ok(raced.status === 'refused' && raced.code === 'SUPERSEDED_FINGERPRINT_CHANGED', 'zwischen Prüfung und Abbruch verändert → abgewiesen');
  ok(q(db, `SELECT state FROM media_ingest_jobs WHERE job_id = ?`, [cases[0].jobId])[0].state === 'accepted', '… und nichts geschrieben');
  db.run(`UPDATE media_ingest_jobs SET attempt_count = attempt_count - 1 WHERE job_id = ?`, [cases[0].jobId]);
  ok(jobsSnap() === snap0 && untouchedDigest(db) === before, 'Testwelt nach den Abweisungen wieder exakt am Ausgangsstand');

  // ── §4 Abbruch ──────────────────────────────────────────────────────────────
  const otherJobs = jobsOtherThan(db, cases.map((c) => c.jobId));
  const planA = q(db, `SELECT result_json, request_hash FROM media_ingest_jobs WHERE job_id = ?`, [cases[0].jobId])[0];
  const cA = await closeSupersededEditPlan(deps(), cases[0].jobId, fpA, OWNER);
  const cB = await closeSupersededEditPlan(deps(), cases[1].jobId, fpB, OWNER);
  ok(cA.status === 'closed' && cB.status === 'closed', 'beide abgebrochen');
  const jA = q(db, `SELECT * FROM media_ingest_jobs WHERE job_id = ?`, [cases[0].jobId])[0];
  ok(jA.state === 'failed' && jA.error_code === EDIT_PLAN_SUPERSEDED && jA.completed_at === '2026-11-15T12:00:00.000Z', 'Job → failed / MEDIA_EDIT_PLAN_SUPERSEDED');
  ok(jA.result_json === planA.result_json && jA.request_hash === planA.request_hash, 'gespeicherter Plan bleibt unverändert erhalten');
  ok(JSON.parse(jA.error_detail_safe).supersededBy === cases[0].supersededByIngestRequestId, 'Nachweis (Nachfolger) im Job vermerkt');
  const audits = q(db, `SELECT * FROM audit_log WHERE module = 'Media' ORDER BY entity_id`);
  ok(audits.length === 2 && audits.every((a: any) => a.action_type === 'STATUS_CHANGE' && a.changed_by === 'user-owner' && a.entity_type === 'media_ingest_jobs'), 'je eine Audit-Zeile (wer, was, wann)');
  ok(untouchedDigest(db) === before, 'Artikel, Preise, Medien, Zuordnungen, Generationen und sync_changelog unverändert');
  ok(jobsOtherThan(db, cases.map((c) => c.jobId)) === otherJobs, 'alle anderen Jobs unverändert');

  // ── §5 erneuter Aufruf ──────────────────────────────────────────────────────
  const auditN = audits.length;
  const again = await closeSupersededEditPlan(deps(), cases[0].jobId, fpA, OWNER);
  const again2 = await inspectSupersededEditPlan(deps(), cases[1].jobId);
  ok(again.status === 'already_closed' && again2.status === 'already_closed', 'erneuter Aufruf: already_closed');
  ok(q(db, `SELECT COUNT(*) AS n FROM audit_log WHERE module = 'Media'`)[0].n === auditN && untouchedDigest(db) === before, 'erneuter Aufruf: keine weitere Zeile');

  // ── §6 Wirkung ──────────────────────────────────────────────────────────────
  const rec1 = await coord.recover();
  ok(cases.every((c) => rec1.find((r) => r.ingestRequestId === c.ingestRequestId)?.action === 'noop_terminal_state'), 'Wiederherstellung: beide jetzt Endzustand (kein Liegenlassen mehr)');
  ok(findProductsNeedingEmbedding(db).map((s) => s.productId).sort().join(',') === 'pA,pB,pC', 'Embedding-Abgleich berücksichtigt A und B wieder');
  let migAfter = '';
  try { assertMigrationPreconditions(db as MigrationDb); } catch (e) { migAfter = (e as Error).message; }
  ok(migAfter === '', 'Bildmigration: keine Blockade mehr durch diese Jobs');

  // ── §7 eigene Welt: Plan, dessen Galerie noch am Ausgangsstand steht; unlesbarer Plan ──────────
  {
    const W2 = await world(SQL);
    const c1 = await W2.plan('pC', 'ev-c1', [{ keep: 0 }], W2.pe([['purchase_price', 11]], [10]));
    W2.coord.registerEditPlan(c1); // eingefroren, nie angewandt → Galerie noch am Ausgangsstand
    const cC = W2.mkCase('OK-T-009', 'pC', c1, W2.a2);
    const d2 = (over: Partial<SupersededDeps> = {}) => W2.deps({ cases: [...W2.cases, cC], ...over });
    const snap = JSON.stringify(q(W2.db, `SELECT * FROM media_ingest_jobs ORDER BY job_id`));
    ok((await inspectSupersededEditPlan(d2(), cC.jobId) as { code?: string }).code === 'SUPERSEDED_BASELINE_CURRENT', 'Galerie noch am Ausgangsstand → abgewiesen (offene Änderung)');
    W2.db.run(`UPDATE media_ingest_jobs SET result_json = '{"kind":"edit_plan","version":1}' WHERE job_id = ?`, [W2.cases[0].jobId]);
    ok((await inspectSupersededEditPlan(d2(), W2.cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_PLAN_UNREADABLE', 'unlesbarer/fremder Plan → abgewiesen');
    W2.db.run(`UPDATE media_ingest_jobs SET result_json = ? WHERE job_id = ?`, [JSON.stringify(W2.a1), W2.cases[0].jobId]);
    // Eine Darstellung der neuen Bilder liegt doch als Generation vor → hängt noch etwas dran.
    const k = W2.a1.newRenditions[0].main.storage_key;
    const g = q(W2.db, `SELECT * FROM media_blob_generations LIMIT 1`)[0];
    ok(g && k, 'Testwelt: Generation + Speicherschlüssel vorhanden');
    const pending = d2({ db: { run: W2.db.run.bind(W2.db), exec: (sql: string, p?: unknown) => (/FROM media_blob_generations WHERE storage_key/.test(sql) ? [{ columns: ['n'], values: [[1]] }] : W2.db.exec(sql, p)) } as SupersededDb });
    ok((await inspectSupersededEditPlan(pending, W2.cases[0].jobId) as { code?: string }).code === 'SUPERSEDED_PENDING_MEDIA', 'Darstellung des neuen Bildes ist gespeicherte Generation → abgewiesen');
    ok(JSON.stringify(q(W2.db, `SELECT * FROM media_ingest_jobs ORDER BY job_id`)) === snap, 'keine Zeile geändert');
  }

  console.log(`\nSUPERSEDED-EDIT-PLANS: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

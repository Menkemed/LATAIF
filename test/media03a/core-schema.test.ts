// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03A — additive inactive core media schema :: DB invariant tests
// Run: node test/media03a/core-schema.test.ts
//   optional: MEDIA03A_EXISTING_DB=<path to a byte-identical lataif.db copy>
//             enables the existing-DB upgrade/idempotency check (§17).
//
// Uses REAL sql.js. No production DB is opened (only a caller-supplied COPY).
// No app code beyond src/core/db/media-schema.ts is loaded.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_TABLES, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0;
let FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { PASS++; } else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}
/** assert that running `sql` is REJECTED (throws). */
function rejects(db: any, sql: string, msg: string): void {
  let threw = false;
  try { db.run(sql); } catch { threw = true; }
  ok(threw, `${msg} (expected rejection)`);
}
/** assert that running `sql` is ALLOWED (no throw). */
function allows(db: any, sql: string, msg: string): void {
  let err: unknown = null;
  try { db.run(sql); } catch (e) { err = e; }
  ok(!err, `${msg} (expected allowed, got ${err instanceof Error ? err.message : String(err)})`);
}
const H64 = 'a'.repeat(64);

function tableCount(db: any): number {
  const r = db.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return Number(r[0].values[0][0]);
}
function hasTable(db: any, name: string): boolean {
  const r = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return r.length > 0 && r[0].values.length > 0;
}

// ── minimal entity-table stubs the media_links scope triggers reference ──
function seedEntityStubs(db: any): void {
  db.run(`CREATE TABLE tenants  (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  db.run(`CREATE TABLE users    (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of ['products','repairs','purchase_inbox','purchases','suppliers','documents','orders','offers','precious_metals','scrap_trades']) {
    db.run(`CREATE TABLE ${t} (id TEXT PRIMARY KEY, branch_id TEXT)`);
  }
  db.run(`INSERT INTO tenants (id) VALUES ('t1'),('t2')`);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES ('b1','t1'),('b2','t1'),('b3','t2')`);
  db.run(`INSERT INTO users (id, tenant_id) VALUES ('u1','t1')`);
  db.run(`INSERT INTO products (id, branch_id) VALUES ('p1','b1')`);
}

// insert a generation (default: available raster 50 KB, unencrypted) + a blob
// pointing at it (present) unless overridden.
function makeBlob(db: any, o: {
  id: string; gen?: number; bytes?: number; kind?: string; enc?: number; dek?: number | null;
  genStatus?: string; present?: boolean; token?: string;
}): void {
  const gen = o.gen ?? 1;
  const bytes = o.bytes ?? 50000;
  const kind = o.kind ?? 'raster_image';
  const enc = o.enc ?? 0;
  const dek = o.dek === undefined ? null : o.dek;
  const gs = o.genStatus ?? 'available';
  const present = o.present ?? true;
  const token = o.token ?? `tok-${o.id}`;
  db.run(
    `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,is_encrypted,dek_version,gen_status,created_at)
     VALUES ('t1','${o.id}',${gen},'k/${o.id}/${gen}','${H64}',${bytes},'${kind}','image/webp','webp',${enc},${dek === null ? 'NULL' : dek},'${gs}','n')`,
  );
  db.run(
    `INSERT INTO media_blobs (tenant_id,blob_id,dedup_token,current_generation_no,blob_status,created_at,updated_at)
     VALUES ('t1','${o.id}','${token}',${present ? gen : 'NULL'},'${present ? 'present' : 'pending'}','n','n')`,
  );
}
function makeObject(db: any, id: string, blobId: string, sec = 'internal'): void {
  db.run(
    `INSERT INTO media_objects (tenant_id,media_id,master_blob_id,master_kind,source_type,security_class,ingest_status,created_at,updated_at)
     VALUES ('t1','${id}','${blobId}','normalized','upload_desktop','${sec}','pending','n','n')`,
  );
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // ═══ Part A — fresh DB + negative matrix (§18) ═══
  const db = new (SQL as any).Database();
  seedEntityStubs(db);
  const beforeCount = tableCount(db);
  applyMediaSchema(db);
  // §17 fresh: all six tables exist
  for (const t of MEDIA_TABLES) ok(hasTable(db, t), `fresh: table ${t} created`);
  // idempotent second apply → identical table count
  const afterFirst = tableCount(db);
  applyMediaSchema(db);
  ok(tableCount(db) === afterFirst, 'fresh: second applyMediaSchema is idempotent (table count stable)');
  ok(afterFirst - beforeCount === MEDIA_TABLES.length, `fresh: exactly ${MEDIA_TABLES.length} tables added`);
  // entity-scope SSOT completeness (13 types, production_input excluded)
  ok(Object.keys(MEDIA_ENTITY_SCOPE).length === 13, 'entity-scope SSOT has 13 types');
  ok(!('production_input' in MEDIA_ENTITY_SCOPE), 'production_input excluded from entity scope');

  // ── generation size CHECK (§12) ──
  allows(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','gA',1,'k/gA','${H64}',100000,'raster_image','image/webp','webp','available','n')`, 'raster generation 100000 B');
  rejects(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','gB',1,'k/gB','${H64}',100001,'raster_image','image/webp','webp','available','n')`, 'raster generation 100001 B');
  allows(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','gPDF',1,'k/gPDF','${H64}',200000,'pdf','application/pdf','pdf','available','n')`, 'pdf generation >100 KB');
  // is_encrypted=1 requires dek_version
  rejects(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,is_encrypted,gen_status,created_at) VALUES ('t1','gE',1,'k/gE','${H64}',50000,'raster_image','image/webp','webp',1,'available','n')`, 'encrypted generation without dek_version');

  // ── blob bootstrap + available-only pointer (§5) ──
  rejects(db, `INSERT INTO media_blobs (tenant_id,blob_id,dedup_token,current_generation_no,blob_status,created_at,updated_at) VALUES ('t1','bNULL','tok-bNULL',NULL,'present','n','n')`, 'present blob with NULL pointer');
  // staged gen → pointer rejected
  db.run(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bStaged',1,'k/bStaged','${H64}',50000,'raster_image','image/webp','webp','staged','n')`);
  rejects(db, `INSERT INTO media_blobs (tenant_id,blob_id,dedup_token,current_generation_no,blob_status,created_at,updated_at) VALUES ('t1','bStaged','tok-bStaged',1,'present','n','n')`, 'pointer to staged generation');
  allows(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bAvail',1,'k/bAvail','${H64}',50000,'raster_image','image/webp','webp','available','n')`, 'available generation insert');
  allows(db, `INSERT INTO media_blobs (tenant_id,blob_id,dedup_token,current_generation_no,blob_status,created_at,updated_at) VALUES ('t1','bAvail','tok-bAvail',1,'present','n','n')`, 'pointer to available generation');

  // ── linkable-blob (§11) ──
  makeBlob(db, { id: 'bPending', present: false, genStatus: 'available' }); // pending blob
  rejects(db, `INSERT INTO media_objects (tenant_id,media_id,master_blob_id,master_kind,source_type,security_class,ingest_status,created_at,updated_at) VALUES ('t1','mP','bPending','normalized','upload_desktop','internal','pending','n','n')`, 'master-link on pending blob');
  makeObject(db, 'mAvail', 'bAvail'); // present+available → allowed
  rejects(db, `INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vMiss','mAvail','display',1,'bMissing','n')`, 'variant-link on missing blob');
  ok(true, 'master-link on present/available blob allowed'); // reached without throw above

  // ── variant role size (§12) ──
  makeBlob(db, { id: 'bThumb20', bytes: 20000 });
  makeObject(db, 'mThumb', 'bThumb20');
  allows(db, `INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vT20','mThumb','thumbnail',1,'bThumb20','n')`, 'thumbnail 20000 B');
  makeBlob(db, { id: 'bThumb21', bytes: 21000 });
  makeObject(db, 'mThumb2', 'bThumb21');
  rejects(db, `INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vT21','mThumb2','thumbnail',1,'bThumb21','n')`, 'thumbnail 21000 B');

  // ── reverse pointer size guard (§13): thumbnail 18k → switch to 21k ──
  makeBlob(db, { id: 'bRev', bytes: 18000 });          // gen1 available/current 18k
  makeObject(db, 'mRev', 'bRev');
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vRev','mRev','thumbnail',1,'bRev','n')`);
  db.run(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bRev',2,'k/bRev/2','${H64}',21000,'raster_image','image/webp','webp','available','n')`);
  rejects(db, `UPDATE media_blobs SET current_generation_no=2 WHERE tenant_id='t1' AND blob_id='bRev'`, 'pointer switch invalidating 20k thumbnail usage');
  // display-100001 case is subsumed by the generation CHECK (a raster gen >100000 cannot exist):
  rejects(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bRev',3,'k/bRev/3','${H64}',100001,'raster_image','image/webp','webp','available','n')`, 'display 100001 B generation (CHECK)');

  // ── class-D security (§14) ──
  makeBlob(db, { id: 'bPlain', bytes: 40000, enc: 0 });
  rejects(db, `INSERT INTO media_objects (tenant_id,media_id,master_blob_id,master_kind,source_type,security_class,ingest_status,created_at,updated_at) VALUES ('t1','mD','bPlain','normalized','upload_desktop','highly_sensitive','pending','n','n')`, 'class-D master on unencrypted blob');
  makeBlob(db, { id: 'bEnc', bytes: 40000, enc: 1, dek: 1 });   // encrypted current gen
  makeObject(db, 'mDok', 'bEnc', 'highly_sensitive');            // allowed
  db.run(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,is_encrypted,dek_version,gen_status,created_at) VALUES ('t1','bEnc',2,'k/bEnc/2','${H64}',40000,'raster_image','image/webp','webp',0,NULL,'available','n')`);
  rejects(db, `UPDATE media_blobs SET current_generation_no=2 WHERE tenant_id='t1' AND blob_id='bEnc'`, 'class-D pointer switch to unencrypted generation');

  // ── entity scope (§9) ──
  allows(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lOK','branch','b1','product','p1','mAvail','gallery','n')`, 'branch-scoped product in correct branch');
  rejects(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lWrongBranch','branch','b2','product','p1','mAvail','gallery','n')`, 'branch-scoped product in wrong branch');
  rejects(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lNoEnt','branch','b1','product','nope','mAvail','gallery','n')`, 'non-existent entity');
  rejects(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lTB','tenant','b1','tenant_logo','t1','mAvail','logo','n')`, 'tenant-scoped entity with branch_id (CHECK)');
  allows(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lTenant','tenant',NULL,'tenant_logo','t1','mAvail','logo','n')`, 'tenant-scoped tenant_logo (no branch)');
  rejects(db, `INSERT INTO media_links (tenant_id,link_id,scope_kind,branch_id,entity_type,entity_id,media_id,media_role,created_at) VALUES ('t1','lWrongKind','tenant',NULL,'product','p1','mAvail','gallery','n')`, 'product with tenant scope_kind');

  // ── ingest idempotency (§10) ──
  db.run(`INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,state,created_at,updated_at) VALUES ('t1','j1','r1','accepted','n','n')`);
  rejects(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,state,created_at,updated_at) VALUES ('t1','j2','r1','accepted','n','n')`, 'duplicate ingest_request_id same tenant');
  allows(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,state,created_at,updated_at) VALUES ('t2','j3','r1','accepted','n','n')`, 'same ingest_request_id other tenant');

  // ═══ MEDIA-03A-R1 — variant UPDATE / generation immutability / security upgrade / tenant-branch ═══
  // §3 variant UPDATE guard
  makeBlob(db, { id: 'bDisp90', bytes: 90000 });
  makeObject(db, 'mDisp', 'bDisp90');
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vDisp','mDisp','display',1,'bDisp90','n')`);
  rejects(db, `UPDATE media_variants SET variant_type='thumbnail' WHERE tenant_id='t1' AND variant_id='vDisp'`, 'variant UPDATE display→thumbnail over 20k');
  makeBlob(db, { id: 'bPend2', present: false });
  rejects(db, `UPDATE media_variants SET blob_id='bPend2' WHERE tenant_id='t1' AND variant_id='vDisp'`, 'variant UPDATE blob_id to pending blob');
  makeBlob(db, { id: 'bEncMove', bytes: 40000, enc: 1, dek: 1 });
  makeObject(db, 'mDsec', 'bEncMove', 'highly_sensitive');
  rejects(db, `UPDATE media_variants SET media_id='mDsec' WHERE tenant_id='t1' AND variant_id='vDisp'`, 'variant UPDATE media_id to class-D object (unencrypted blob)');
  db.run(`UPDATE media_variants SET deleted_at='n' WHERE tenant_id='t1' AND variant_id='vDisp'`); // soft-delete (no re-check)
  rejects(db, `UPDATE media_variants SET deleted_at=NULL, variant_type='thumbnail' WHERE tenant_id='t1' AND variant_id='vDisp'`, 'reactivation re-checks (thumbnail over 20k)');

  // §5 available-generation immutability
  makeBlob(db, { id: 'bImm', bytes: 18000 });
  rejects(db, `UPDATE media_blob_generations SET byte_size=21000 WHERE tenant_id='t1' AND blob_id='bImm' AND generation_no=1`, 'available gen byte_size mutation');
  rejects(db, `UPDATE media_blob_generations SET content_kind='pdf' WHERE tenant_id='t1' AND blob_id='bImm' AND generation_no=1`, 'available gen content_kind mutation');
  rejects(db, `UPDATE media_blob_generations SET stored_blob_hash='${'b'.repeat(64)}' WHERE tenant_id='t1' AND blob_id='bImm' AND generation_no=1`, 'available gen stored_blob_hash mutation');
  makeBlob(db, { id: 'bImmE', bytes: 40000, enc: 1, dek: 1 });
  rejects(db, `UPDATE media_blob_generations SET is_encrypted=0 WHERE tenant_id='t1' AND blob_id='bImmE' AND generation_no=1`, 'available gen is_encrypted mutation');
  allows(db, `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bImm',2,'k/bImm/2','${H64}',21000,'raster_image','image/webp','webp','staged','n')`, 'new generation_no with new physical data');
  db.run(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','bImm',3,'k/bImm/3','${H64}',30000,'raster_image','image/webp','webp','available','n')`);
  allows(db, `UPDATE media_blob_generations SET gen_status='superseded', superseded_at='n' WHERE tenant_id='t1' AND blob_id='bImm' AND generation_no=3`, 'available→superseded transition allowed');

  // §6 security-class upgrade guard
  makeBlob(db, { id: 'bU1', bytes: 40000, enc: 0 });
  makeObject(db, 'mU1', 'bU1', 'internal');
  rejects(db, `UPDATE media_objects SET security_class='highly_sensitive' WHERE tenant_id='t1' AND media_id='mU1'`, 'upgrade to D with unencrypted master');
  makeBlob(db, { id: 'bU2', bytes: 40000, enc: 1, dek: 1 });
  makeObject(db, 'mU2', 'bU2', 'internal');
  makeBlob(db, { id: 'bU2v', bytes: 30000, enc: 0 });
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vU2','mU2','display',1,'bU2v','n')`);
  rejects(db, `UPDATE media_objects SET security_class='highly_sensitive' WHERE tenant_id='t1' AND media_id='mU2'`, 'upgrade to D with unencrypted active variant');
  makeBlob(db, { id: 'bU3', bytes: 40000, enc: 1, dek: 1 });
  makeObject(db, 'mU3', 'bU3', 'internal');
  makeBlob(db, { id: 'bU3v', bytes: 30000, enc: 1, dek: 1 });
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vU3','mU3','display',1,'bU3v','n')`);
  allows(db, `UPDATE media_objects SET security_class='highly_sensitive' WHERE tenant_id='t1' AND media_id='mU3'`, 'upgrade to D with encrypted master + variant');

  // §7 tenant/branch guards (b3 belongs to t2)
  rejects(db, `INSERT INTO media_objects (tenant_id,media_id,origin_branch_id,master_blob_id,master_kind,source_type,security_class,ingest_status,created_at,updated_at) VALUES ('t1','mFB','b3','bAvail','normalized','upload_desktop','internal','pending','n','n')`, 'origin_branch_id of another tenant');
  allows(db, `INSERT INTO media_objects (tenant_id,media_id,origin_branch_id,master_blob_id,master_kind,source_type,security_class,ingest_status,created_at,updated_at) VALUES ('t1','mOB','b1','bAvail','normalized','upload_desktop','internal','pending','n','n')`, 'origin_branch_id in same tenant');
  rejects(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,scope_kind,branch_id,state,created_at,updated_at) VALUES ('t1','jFB','rFB','branch','b3','accepted','n','n')`, 'ingest job with foreign branch');
  rejects(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,scope_kind,branch_id,state,created_at,updated_at) VALUES ('t1','jTB','rTB','tenant','b1','accepted','n','n')`, 'tenant-scope ingest job with branch_id');
  rejects(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,scope_kind,branch_id,state,created_at,updated_at) VALUES ('t1','jBN','rBN','branch',NULL,'accepted','n','n')`, 'branch-scope ingest job without branch_id');
  allows(db, `INSERT INTO media_ingest_jobs (tenant_id,job_id,ingest_request_id,scope_kind,branch_id,state,created_at,updated_at) VALUES ('t1','jOK','rOK','branch','b1','accepted','n','n')`, 'branch-scope ingest job with valid branch');

  // ═══ MEDIA-03A-R2 — generation state machine / reactivation guards ═══
  const gen = (blob: string, no: number, bytes: number, status: string) =>
    `INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,gen_status,created_at) VALUES ('t1','${blob}',${no},'k/${blob}/${no}','${H64}',${bytes},'raster_image','image/webp','webp','${status}','n')`;
  const setGen = (blob: string, no: number, status: string) =>
    `UPDATE media_blob_generations SET gen_status='${status}' WHERE tenant_id='t1' AND blob_id='${blob}' AND generation_no=${no}`;

  // §5 generation state machine (gen1 current, gen2 non-current)
  makeBlob(db, { id: 'bSM', bytes: 30000 });
  db.run(gen('bSM', 2, 50000, 'available'));
  rejects(db, setGen('bSM', 2, 'staged'), 'available→staged rejected');
  rejects(db, setGen('bSM', 2, 'writing'), 'available→writing rejected');
  rejects(db, setGen('bSM', 1, 'superseded'), 'current gen available→superseded rejected (status lock)');
  allows(db, setGen('bSM', 2, 'superseded'), 'available→superseded allowed (non-current)');
  rejects(db, setGen('bSM', 2, 'available'), 'superseded→available rejected');
  allows(db, setGen('bSM', 2, 'gc_pending'), 'superseded→gc_pending allowed');
  allows(db, setGen('bSM', 2, 'deleted'), 'gc_pending→deleted allowed');
  rejects(db, setGen('bSM', 2, 'available'), 'deleted→available rejected');
  rejects(db, gen('bSM', 3, 40000, 'superseded'), 'insert generation at superseded rejected');

  // §7 media_object reactivation guard
  makeBlob(db, { id: 'bRA1', bytes: 40000, enc: 0 });
  makeObject(db, 'mRA1', 'bRA1', 'internal');
  db.run(`UPDATE media_objects SET deleted_at='n' WHERE tenant_id='t1' AND media_id='mRA1'`);
  db.run(`UPDATE media_objects SET security_class='highly_sensitive' WHERE tenant_id='t1' AND media_id='mRA1'`);
  rejects(db, `UPDATE media_objects SET deleted_at=NULL WHERE tenant_id='t1' AND media_id='mRA1'`, 'reactivate D object with unencrypted master');
  makeBlob(db, { id: 'bRA2', bytes: 40000 });
  makeObject(db, 'mRA2', 'bRA2', 'internal');
  makeBlob(db, { id: 'bRA2p', present: false });
  db.run(`UPDATE media_objects SET deleted_at='n' WHERE tenant_id='t1' AND media_id='mRA2'`);
  db.run(`UPDATE media_objects SET master_blob_id='bRA2p' WHERE tenant_id='t1' AND media_id='mRA2'`);
  rejects(db, `UPDATE media_objects SET deleted_at=NULL WHERE tenant_id='t1' AND media_id='mRA2'`, 'reactivate object with pending master blob');
  makeBlob(db, { id: 'bRA3', bytes: 40000 });
  makeObject(db, 'mRA3', 'bRA3', 'internal');
  db.run(`UPDATE media_objects SET deleted_at='n' WHERE tenant_id='t1' AND media_id='mRA3'`);
  db.run(`UPDATE media_objects SET origin_branch_id='b3' WHERE tenant_id='t1' AND media_id='mRA3'`);
  rejects(db, `UPDATE media_objects SET deleted_at=NULL WHERE tenant_id='t1' AND media_id='mRA3'`, 'reactivate object with foreign origin_branch');
  makeBlob(db, { id: 'bRA4', bytes: 40000, enc: 1, dek: 1 });
  makeObject(db, 'mRA4', 'bRA4', 'internal');
  makeBlob(db, { id: 'bRA4v', bytes: 30000, enc: 0 });
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vRA4','mRA4','display',1,'bRA4v','n')`);
  db.run(`UPDATE media_objects SET deleted_at='n' WHERE tenant_id='t1' AND media_id='mRA4'`);
  db.run(`UPDATE media_objects SET security_class='highly_sensitive' WHERE tenant_id='t1' AND media_id='mRA4'`);
  rejects(db, `UPDATE media_objects SET deleted_at=NULL WHERE tenant_id='t1' AND media_id='mRA4'`, 'reactivate D object with unencrypted variant');
  makeBlob(db, { id: 'bRA5', bytes: 40000 });
  makeObject(db, 'mRA5', 'bRA5', 'internal');
  db.run(`UPDATE media_objects SET deleted_at='n' WHERE tenant_id='t1' AND media_id='mRA5'`);
  allows(db, `UPDATE media_objects SET deleted_at=NULL WHERE tenant_id='t1' AND media_id='mRA5'`, 'reactivate fully valid object');

  // §8 variant reactivation re-confirm
  makeBlob(db, { id: 'bVR', bytes: 90000 });
  makeObject(db, 'mVR', 'bVR');
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vVR','mVR','display',1,'bVR','n')`);
  db.run(`UPDATE media_variants SET deleted_at='n' WHERE tenant_id='t1' AND variant_id='vVR'`);
  makeBlob(db, { id: 'bVRp', present: false });
  db.run(`UPDATE media_variants SET blob_id='bVRp' WHERE tenant_id='t1' AND variant_id='vVR'`);
  rejects(db, `UPDATE media_variants SET deleted_at=NULL WHERE tenant_id='t1' AND variant_id='vVR'`, 'reactivate variant with pending blob');
  makeBlob(db, { id: 'bVR2', bytes: 90000 });
  makeObject(db, 'mVR2', 'bVR2');
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vVR2','mVR2','display',1,'bVR2','n')`);
  db.run(`UPDATE media_variants SET deleted_at='n' WHERE tenant_id='t1' AND variant_id='vVR2'`);
  db.run(`UPDATE media_variants SET variant_type='thumbnail' WHERE tenant_id='t1' AND variant_id='vVR2'`);
  rejects(db, `UPDATE media_variants SET deleted_at=NULL WHERE tenant_id='t1' AND variant_id='vVR2'`, 'reactivate variant display→thumbnail over 20k');
  makeBlob(db, { id: 'bVR3', bytes: 15000 });
  makeObject(db, 'mVR3', 'bVR3');
  db.run(`INSERT INTO media_variants (tenant_id,variant_id,media_id,variant_type,transform_version,blob_id,created_at) VALUES ('t1','vVR3','mVR3','thumbnail',1,'bVR3','n')`);
  db.run(`UPDATE media_variants SET deleted_at='n' WHERE tenant_id='t1' AND variant_id='vVR3'`);
  allows(db, `UPDATE media_variants SET deleted_at=NULL WHERE tenant_id='t1' AND variant_id='vVR3'`, 'reactivate fully valid variant');

  db.close();

  // ═══ Part B — existing DB copy upgrade/idempotency (§17) ═══
  const existing = process.env.MEDIA03A_EXISTING_DB;
  if (existing) {
    const bytes = readFileSync(existing);
    const edb = new (SQL as any).Database(bytes);
    const t0 = tableCount(edb);
    const sampleTables = ['products', 'invoices', 'branches'].filter((t) => hasTable(edb, t));
    const rows0 = sampleTables.map((t) => Number(edb.exec(`SELECT COUNT(*) AS n FROM ${t}`)[0].values[0][0]));
    applyMediaSchema(edb);
    for (const t of MEDIA_TABLES) ok(hasTable(edb, t), `existing-copy: ${t} added`);
    ok(tableCount(edb) - t0 === MEDIA_TABLES.length, `existing-copy: exactly ${MEDIA_TABLES.length} tables added (was ${t0})`);
    const rows1 = sampleTables.map((t) => Number(edb.exec(`SELECT COUNT(*) AS n FROM ${t}`)[0].values[0][0]));
    ok(JSON.stringify(rows0) === JSON.stringify(rows1), 'existing-copy: existing row counts unchanged');
    for (const t of MEDIA_TABLES) ok(Number(edb.exec(`SELECT COUNT(*) AS n FROM ${t}`)[0].values[0][0]) === 0, `existing-copy: ${t} is empty (inactive)`);
    const t1 = tableCount(edb);
    applyMediaSchema(edb);
    ok(tableCount(edb) === t1, 'existing-copy: second apply idempotent');
    edb.close();
    console.log(`  (existing-DB copy: ${sampleTables.length} sample tables verified, started at ${t0} tables)`);
  } else {
    console.log('  (existing-DB copy check SKIPPED — set MEDIA03A_EXISTING_DB to a byte-identical lataif.db copy)');
  }

  if (failures.length) {
    console.log(`\nMEDIA03A core-schema: ${PASS}/${PASS + FAIL} checks passed — ${FAIL} FAILED`);
    process.exit(1);
  }
  console.log(`MEDIA03A core-schema: ${PASS}/${PASS} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });

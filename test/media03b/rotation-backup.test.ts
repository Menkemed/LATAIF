// ════════════════════════════════════════════════════════════════════════════
// MEDIA-03B(+R1/R2) — inactive rotation + backup schema :: DB invariant tests
// Run: node test/media03b/rotation-backup.test.ts
//
// Uses REAL sql.js. Only src/core/db/media-schema.ts is loaded; NO production DB.
//
// MEDIA-03B-R2: everything runs on ONE connection (the R1 two-DB split is gone).
// The reject→valid path on a single connection is proven directly and in a 20×
// loop, with NO SELECT/REINDEX/reopen "healing" between a reject and the next
// valid operation. The "one active job" invariant is a partial UNIQUE index again
// (the trg_*_one_active triggers only surface a stable domain error code).
//
// Covers §3–§16 base + R1 §1–§12 + R2 §3 same-connection contract, §4 DDL,
// §6 full negative matrix, §20 isolation.
// ════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_TABLES } from '../../src/core/db/media-schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const H64 = 'a'.repeat(64), B64 = 'b'.repeat(64), BAD64 = 'g'.repeat(64), UP64 = 'A'.repeat(64);

let PASS = 0, FAIL = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string) => { if (c) PASS++; else { FAIL++; fails.push(m); console.log(`  ✗ ${m}`); } };
const allow = (db: any, sql: string, m: string) => {
  let err: unknown = null; try { db.run(sql); } catch (e) { err = e; }
  ok(!err, `${m} (expected allowed, got ${err instanceof Error ? err.message : String(err)})`);
};
const reject = (db: any, sql: string, m: string, code?: string) => {
  let msg: string | null = null; try { db.run(sql); } catch (e) { msg = e instanceof Error ? e.message : String(e); }
  if (msg === null) { ok(false, `${m} (expected rejection)`); return; }
  ok(code ? msg.includes(code) : true, code ? `${m} → ${code}` : `${m} (rejected)`);
};
const rows = (db: any, t: string): number => Number(db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0]);
const tableCount = (db: any): number => Number(db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].values[0][0]);
const trigCount = (db: any): number => Number(db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'")[0].values[0][0]);

function gen(db: any, t: string, b: string, no: number, dek: number | null, status = 'available', bytes = 40000, enc = 1): void {
  db.run(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,storage_key,stored_blob_hash,byte_size,content_kind,mime_type,extension,is_encrypted,dek_version,gen_status,created_at)
     VALUES ('${t}','${b}',${no},'k/${t}/${b}/${no}','${H64}',${bytes},'raster_image','image/webp','webp',${enc},${dek === null ? 'NULL' : dek},'${status}','n')`);
}
function blob(db: any, t: string, b: string, curGen: number | null, dek: number | null = 1, enc = 1): void {
  if (curGen !== null) gen(db, t, b, curGen, dek, 'available', 40000, enc);
  db.run(`INSERT INTO media_blobs (tenant_id,blob_id,dedup_token,current_generation_no,blob_status,created_at,updated_at)
     VALUES ('${t}','${b}','tok-${t}-${b}',${curGen === null ? 'NULL' : curGen},'${curGen === null ? 'pending' : 'present'}','n','n')`);
}
const insTKRJ = (e: number, fromB: number, toB: number, fromD: number, toD: number, s = 'accepted') =>
  `INSERT INTO tenant_key_rotation_jobs (tenant_id,rotation_epoch,from_bundle_revision,to_bundle_revision,from_dek_version,to_dek_version,state,created_at,updated_at) VALUES ('t1',${e},${fromB},${toB},${fromD},${toD},'${s}','n','n')`;
const setTKRJ = (e: number, s: string) => `UPDATE tenant_key_rotation_jobs SET state='${s}' WHERE tenant_id='t1' AND rotation_epoch=${e}`;
const insMRJ = (id: string, e: number, b: string, fromG: number, toG: number, fromD: number, toD: number) =>
  `INSERT INTO media_rotation_jobs (tenant_id,rotation_job_id,rotation_epoch,blob_id,from_generation_no,to_generation_no,from_dek_version,to_dek_version,state,created_at,updated_at) VALUES ('t1','${id}',${e},'${b}',${fromG},${toG},${fromD},${toD},'accepted','n','n')`;
const setMRJ = (id: string, s: string) => `UPDATE media_rotation_jobs SET state='${s}' WHERE tenant_id='t1' AND rotation_job_id='${id}'`;
const setGen = (b: string, no: number, s: string) => `UPDATE media_blob_generations SET gen_status='${s}' WHERE tenant_id='t1' AND blob_id='${b}' AND generation_no=${no}`;
const switchPtr = (b: string, no: number) => `UPDATE media_blobs SET current_generation_no=${no} WHERE tenant_id='t1' AND blob_id='${b}'`;
const insBk = (t: string, id: string) => `INSERT INTO media_backup_sets (tenant_id,backup_id,status,created_at) VALUES ('${t}','${id}','in_progress','n')`;
const completeBk = (t: string, id: string) => `UPDATE media_backup_sets SET status='complete', manifest_hash='${H64}', completed_at='c' WHERE tenant_id='${t}' AND backup_id='${id}'`;
const deleteBk = (t: string, id: string, at = 'd') => `UPDATE media_backup_sets SET status='deleted', deleted_at='${at}' WHERE tenant_id='${t}' AND backup_id='${id}'`;
const insPin = (t: string, bk: string, b: string, no: number) => `INSERT INTO media_backup_generation_pins (tenant_id,backup_id,blob_id,generation_no,pinned_at) VALUES ('${t}','${bk}','${b}',${no},'n')`;

const setupEpoch = (db: any, e: number) => {
  allow(db, insTKRJ(e, 0, 1, 1, 2), `epoch${e} accepted`);
  allow(db, setTKRJ(e, 'bundle_written'), `epoch${e} →bundle_written`);
  allow(db, setTKRJ(e, 'rotating_blobs'), `epoch${e} →rotating_blobs`);
};
// walk a fresh child rotation job to `target` (blob created here: gen1 current dek1, gen2 writing dek2)
function childTo(db: any, e: number, blb: string, jid: string, target: string): void {
  blob(db, 't1', blb, 1, 1);
  gen(db, 't1', blb, 2, 2, 'writing');
  allow(db, insMRJ(jid, e, blb, 1, 2, 1, 2), `${jid}: insert`);
  if (target === 'accepted') return;
  allow(db, setMRJ(jid, 'file_written'), `${jid}: →file_written`);
  if (target === 'file_written') return;
  allow(db, setGen(blb, 2, 'staged'), `${jid}: gen2→staged`);
  allow(db, setMRJ(jid, 'staged'), `${jid}: →staged`);
  if (target === 'staged') return;
  allow(db, setGen(blb, 2, 'available'), `${jid}: gen2→available`);
  allow(db, switchPtr(blb, 2), `${jid}: switch→gen2`);
  allow(db, setGen(blb, 1, 'superseded'), `${jid}: gen1→superseded`);
  allow(db, setMRJ(jid, 'switched'), `${jid}: →switched`);
  if (target === 'switched') return;
  allow(db, setMRJ(jid, target), `${jid}: switched→${target}`);
}

// ── R2 §3: the same-connection reject→valid contract, one fresh connection, no healing ──
function contractOnce(SQL: any, i: number): void {
  const db = new SQL.Database();
  applyMediaSchema(db);
  setupEpoch(db, 1);
  blob(db, 't1', 'bA', 1, 1); gen(db, 't1', 'bA', 2, 2, 'writing');
  // reject INSERT — then, with NO intervening read, a valid INSERT must succeed
  reject(db, insMRJ('bad', 99, 'bA', 1, 2, 1, 2), `#${i} reject INSERT (foreign epoch)`, 'MEDIA_ROTATION_TENANT_JOB');
  allow(db, insMRJ('jA', 1, 'bA', 1, 2, 1, 2), `#${i} valid INSERT right after reject`);
  // reject UPDATE — then a valid UPDATE must succeed
  reject(db, `UPDATE media_rotation_jobs SET blob_id='x' WHERE rotation_job_id='jA'`, `#${i} reject UPDATE (identity)`, 'MEDIA_LIFECYCLE_IMMUTABLE');
  allow(db, setMRJ('jA', 'file_written'), `#${i} valid UPDATE right after reject`);
  // reject DELETE — then continue the valid lifecycle to done
  reject(db, `DELETE FROM media_rotation_jobs WHERE rotation_job_id='jA'`, `#${i} reject DELETE (hard-delete)`, 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');
  allow(db, setGen('bA', 2, 'staged'), `#${i} gen2→staged`);
  allow(db, setMRJ('jA', 'staged'), `#${i} →staged`);
  allow(db, setGen('bA', 2, 'available'), `#${i} gen2→available`);
  allow(db, switchPtr('bA', 2), `#${i} switch→gen2`);
  allow(db, setGen('bA', 1, 'superseded'), `#${i} gen1→superseded`);
  allow(db, setMRJ('jA', 'switched'), `#${i} →switched`);
  allow(db, setMRJ('jA', 'done'), `#${i} →done`);
  // another valid job for ANOTHER blob (same epoch, jA now terminal so slot free)
  blob(db, 't1', 'bB', 1, 1); gen(db, 't1', 'bB', 2, 2, 'writing');
  allow(db, insMRJ('jB', 1, 'bB', 1, 2, 1, 2), `#${i} valid job for another blob`);
  db.close();
}

// ── R2-V3 explicit reject-atomicity: full before/after snapshots on ONE connection.
//    Separate from contractOnce (which stays a pure reject→valid contract with no
//    reads between reject and the next valid op). Here the snapshot SELECTs are the
//    point — they prove a RAISE(ABORT) leaves the table byte/value-identical. ──
const MRJ_COLS = 'tenant_id, rotation_job_id, rotation_epoch, blob_id, from_generation_no, to_generation_no, from_dek_version, to_dek_version, state, attempt_count, error_code, error_detail_safe, created_at, updated_at, completed_at';
const ID_COLS = 'tenant_id, rotation_job_id, rotation_epoch, blob_id, from_generation_no, to_generation_no, from_dek_version, to_dek_version, created_at';
const snapAll = (db: any): string => { const r = db.exec(`SELECT ${MRJ_COLS} FROM media_rotation_jobs ORDER BY rotation_job_id`); return JSON.stringify(r.length ? r[0].values : []); };
const snapRow = (db: any, jid: string): string => { const r = db.exec(`SELECT ${MRJ_COLS} FROM media_rotation_jobs WHERE rotation_job_id='${jid}'`); return JSON.stringify(r.length ? r[0].values : []); };
const snapIdentity = (db: any, jid: string): string => { const r = db.exec(`SELECT ${ID_COLS} FROM media_rotation_jobs WHERE rotation_job_id='${jid}'`); return JSON.stringify(r.length ? r[0].values : []); };
const mrjState = (db: any, jid: string): string => { const r = db.exec(`SELECT state FROM media_rotation_jobs WHERE rotation_job_id='${jid}'`); return r.length ? String(r[0].values[0][0]) : '(none)'; };
const mrjTotal = (db: any): number => Number(db.exec('SELECT COUNT(*) FROM media_rotation_jobs')[0].values[0][0]);
const epochChildren = (db: any, e: number): number => Number(db.exec(`SELECT COUNT(*) FROM media_rotation_jobs WHERE rotation_epoch=${e}`)[0].values[0][0]);
const hasRow = (db: any, jid: string): boolean => db.exec(`SELECT 1 FROM media_rotation_jobs WHERE rotation_job_id='${jid}'`).length > 0;
const tkrjState = (db: any, e: number): string => { const r = db.exec(`SELECT state FROM tenant_key_rotation_jobs WHERE rotation_epoch=${e}`); return r.length ? String(r[0].values[0][0]) : '(none)'; };

function assertRejectAtomicity(SQL: any, i: number): void {
  const db = new SQL.Database();
  applyMediaSchema(db);
  setupEpoch(db, 1);
  blob(db, 't1', 'bA', 1, 1); gen(db, 't1', 'bA', 2, 2, 'writing');
  blob(db, 't1', 'bO', 1, 1); gen(db, 't1', 'bO', 2, 2, 'writing');
  allow(db, insMRJ('jA', 1, 'bA', 1, 2, 1, 2), `#${i} atomicity setup: valid jA`);
  allow(db, insMRJ('jO', 1, 'bO', 1, 2, 1, 2), `#${i} atomicity setup: valid jO (other existing row)`);

  // ── §4 rejected INSERT: table + child set unchanged ──
  const iAll = snapAll(db), iTot = mrjTotal(db), iChild = epochChildren(db, 1);
  reject(db, insMRJ('rejINS', 1, 'bA', 1, 2, 1, 2), `#${i} reject INSERT: error code`, 'MEDIA_ROTATION_ACTIVE');
  ok(mrjTotal(db) === iTot, `#${i} reject INSERT: total row count unchanged`);
  ok(!hasRow(db, 'rejINS'), `#${i} reject INSERT: no row with rejected rotation_job_id`);
  ok(epochChildren(db, 1) === iChild, `#${i} reject INSERT: no extra child row in parent epoch`);
  ok(snapAll(db) === iAll, `#${i} reject INSERT leaves table and child set unchanged`);

  // ── §5 rejected identity-UPDATE against a non-trivial-state row ──
  allow(db, setMRJ('jA', 'file_written'), `#${i} atomicity: advance jA to file_written`);
  const uRow = snapRow(db, 'jA'), uState = mrjState(db, 'jA'), uIdent = snapIdentity(db, 'jA'), uAll = snapAll(db), uTot = mrjTotal(db), uChild = epochChildren(db, 1);
  reject(db, `UPDATE media_rotation_jobs SET blob_id='x' WHERE rotation_job_id='jA'`, `#${i} reject identity UPDATE: error code`, 'MEDIA_LIFECYCLE_IMMUTABLE');
  ok(snapRow(db, 'jA') === uRow, `#${i} reject UPDATE: complete target row value-identical to before-snapshot`);
  ok(mrjState(db, 'jA') === uState, `#${i} reject UPDATE: state unchanged`);
  ok(snapIdentity(db, 'jA') === uIdent, `#${i} reject UPDATE: identity columns unchanged`);
  ok(mrjTotal(db) === uTot, `#${i} reject UPDATE: total row count unchanged`);
  ok(epochChildren(db, 1) === uChild, `#${i} reject UPDATE: no extra child row`);
  ok(snapAll(db) === uAll, `#${i} reject UPDATE: no other existing row changed`);

  // ── §6 rejected DELETE preserves the complete lifecycle row ──
  const dRow = snapRow(db, 'jA'), dState = mrjState(db, 'jA'), dAll = snapAll(db), dTot = mrjTotal(db), dChild = epochChildren(db, 1), dParent = tkrjState(db, 1);
  reject(db, `DELETE FROM media_rotation_jobs WHERE rotation_job_id='jA'`, `#${i} reject DELETE: error code`, 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');
  ok(hasRow(db, 'jA'), `#${i} reject DELETE: target row still exists`);
  ok(mrjState(db, 'jA') === dState, `#${i} reject DELETE: state unchanged`);
  ok(mrjTotal(db) === dTot, `#${i} reject DELETE: total row count unchanged`);
  ok(epochChildren(db, 1) === dChild, `#${i} reject DELETE: child set unchanged`);
  ok(tkrjState(db, 1) === dParent, `#${i} reject DELETE: parent state unchanged`);
  ok(snapAll(db) === dAll, `#${i} reject DELETE: no other existing row changed`);
  ok(snapRow(db, 'jA') === dRow, `#${i} reject DELETE preserves complete lifecycle row`);
  db.close();
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const db = new (SQL as any).Database();

  // ═══ §18 fresh migration + trigger inventory ═══
  applyMediaSchema(db);
  for (const t of MEDIA_TABLES) ok(db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`).length > 0, `fresh: ${t} exists`);
  ok(tableCount(db) === 10, `fresh: 10 media tables (got ${tableCount(db)})`);
  ok(trigCount(db) === 42, `fresh: 42 triggers (got ${trigCount(db)})`);
  applyMediaSchema(db);
  ok(tableCount(db) === 10, 'fresh: idempotent');
  for (const t of ['tenant_key_rotation_jobs', 'media_rotation_jobs', 'media_backup_sets', 'media_backup_generation_pins']) ok(rows(db, t) === 0, `fresh: ${t} empty`);

  // ═══ §3 tenant constraints (CHECK negatives before epoch1 so one-active never shadows) ═══
  reject(db, insTKRJ(3, 0, 1, 5, 5), '§3 from_dek=to_dek', 'constraint');
  reject(db, insTKRJ(4, 0, 3, 1, 2), '§3 to_bundle<>from+1', 'constraint');
  reject(db, insTKRJ(6, -1, 0, 1, 2), '§3 from_bundle<0', 'constraint');
  reject(db, insTKRJ(5, 0, 1, 1, 2, 'done'), '§4 INSERT non-accepted', 'MEDIA_TENANT_ROTATION_STATE');
  allow(db, insTKRJ(1, 0, 1, 1, 2), '§3 epoch1 accepted');
  reject(db, insTKRJ(2, 0, 1, 1, 2), '§3/§4-DDL 2nd active tenant job', 'MEDIA_TENANT_ROTATION_ACTIVE');
  // §6 tenant identity: every column separately
  for (const [c, v] of [['tenant_id', "'z'"], ['rotation_epoch', '9'], ['from_bundle_revision', '9'], ['to_bundle_revision', '9'], ['from_dek_version', '9'], ['to_dek_version', '9'], ['created_at', "'z'"]] as const)
    reject(db, `UPDATE tenant_key_rotation_jobs SET ${c}=${v} WHERE tenant_id='t1' AND rotation_epoch=1`, `§6 tkrj identity ${c} immutable`, 'MEDIA_LIFECYCLE_IMMUTABLE');
  reject(db, `DELETE FROM tenant_key_rotation_jobs WHERE rotation_epoch=1`, '§2 tenant hard-delete', 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');

  // ═══ fixtures + bootstrap-parent-state, then advance ═══
  blob(db, 't1', 'bH', 1, 1);
  gen(db, 't1', 'bH', 2, 2, 'writing');
  gen(db, 't1', 'bH', 5, 1, 'available');
  gen(db, 't1', 'bH', 6, 2, 'available');
  gen(db, 't1', 'bH', 7, 7, 'writing');
  blob(db, 't1', 'bPlain', 1, null, 0);
  gen(db, 't1', 'bPlain', 2, null, 'writing', 40000, 0);
  reject(db, insMRJ('mrjPS', 1, 'bH', 1, 2, 1, 2), '§6 rotation under non-rotating parent', 'MEDIA_ROTATION_PARENT_STATE');
  allow(db, setTKRJ(1, 'bundle_written'), '§4 accepted→bundle_written');
  reject(db, setTKRJ(1, 'accepted'), '§4 bundle_written→accepted backward', 'MEDIA_TENANT_ROTATION_STATE');
  allow(db, setTKRJ(1, 'rotating_blobs'), '§4 bundle_written→rotating_blobs');

  // ═══ admission negatives (aborted INSERTs) ═══
  reject(db, insMRJ('mrjEp', 99, 'bH', 1, 2, 1, 2), '§6 foreign epoch', 'MEDIA_ROTATION_TENANT_JOB');
  reject(db, insMRJ('mrjXB', 1, 'bH', 1, 9, 1, 2), '§6 cross-blob to-generation', 'MEDIA_ROTATION_GENERATION_SCOPE');
  reject(db, insMRJ('mrjDek', 1, 'bH', 1, 7, 1, 2), '§8 to_dek<>target generation dek', 'MEDIA_ROTATION_DEK_MISMATCH');
  reject(db, insMRJ('mrjPl', 1, 'bPlain', 1, 2, 1, 2), '§8 unencrypted blob rotation', 'MEDIA_ROTATION_UNENCRYPTED');
  reject(db, insMRJ('mrjFC', 1, 'bH', 5, 2, 1, 2), '§6 from_generation not current', 'MEDIA_ROTATION_BOOTSTRAP');
  reject(db, insMRJ('mrjTW', 1, 'bH', 1, 6, 1, 2), '§6 to_generation not writing', 'MEDIA_ROTATION_BOOTSTRAP');

  // ═══ §3 SAME-CONNECTION: right after the aborted admissions, valid work must flow ═══
  ok(rows(db, 'media_rotation_jobs') === 0, '§3 no stray row after aborted admissions');
  allow(db, insMRJ('mrjH', 1, 'bH', 1, 2, 1, 2), '§6 valid rotation job right after rejects (bootstrap)');
  reject(db, insMRJ('mrjHdup', 1, 'bH', 1, 2, 1, 2), '§5 2nd active rotation job per blob', 'MEDIA_ROTATION_ACTIVE');
  // §6 media_rotation_jobs identity: every column separately
  for (const [c, v] of [['tenant_id', "'z'"], ['rotation_job_id', "'z'"], ['rotation_epoch', '9'], ['blob_id', "'z'"], ['from_generation_no', '9'], ['to_generation_no', '9'], ['from_dek_version', '9'], ['to_dek_version', '9'], ['created_at', "'z'"]] as const)
    reject(db, `UPDATE media_rotation_jobs SET ${c}=${v} WHERE rotation_job_id='mrjH'`, `§6 mrj identity ${c} immutable`, 'MEDIA_LIFECYCLE_IMMUTABLE');
  reject(db, `DELETE FROM media_rotation_jobs WHERE rotation_job_id='mrjH'`, '§2 rotation hard-delete', 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');

  // ═══ §7 per-transition walk with negatives ═══
  allow(db, setMRJ('mrjH', 'file_written'), '§7 accepted→file_written');
  reject(db, setMRJ('mrjH', 'staged'), '§7 file_written→staged while to-gen writing', 'MEDIA_ROTATION_GEN_STATE');
  allow(db, setGen('bH', 2, 'staged'), 'gen2 writing→staged');
  allow(db, setMRJ('mrjH', 'staged'), '§7 file_written→staged');
  reject(db, setMRJ('mrjH', 'switched'), '§7 staged→switched, pointer not on to-gen', 'MEDIA_ROTATION_POINTER');
  allow(db, setGen('bH', 2, 'available'), 'gen2 staged→available');
  allow(db, switchPtr('bH', 2), 'switch pointer bH→gen2');
  reject(db, setMRJ('mrjH', 'switched'), '§7 staged→switched, from-gen not superseded', 'MEDIA_ROTATION_GEN_STATE');
  allow(db, setGen('bH', 1, 'superseded'), 'gen1 available→superseded');
  allow(db, setMRJ('mrjH', 'switched'), '§7 staged→switched (all preconditions met)');

  // ═══ §9 tenant completion: switched-child reject + all-done allow (epoch1) ═══
  childTo(db, 1, 'bH2', 'mrjH2', 'switched');
  allow(db, setTKRJ(1, 'finalizing'), '§9 rotating→finalizing (children switched, none accepted/fw/staged)');
  reject(db, setTKRJ(1, 'done'), '§9 finalizing→done blocked by switched child', 'MEDIA_ROTATION_CHILD_ACTIVE');
  allow(db, setMRJ('mrjH2', 'done'), 'mrjH2 switched→done');
  allow(db, setMRJ('mrjH', 'done'), 'mrjH switched→done');
  allow(db, setTKRJ(1, 'done'), '§9 finalizing→done (all children done)');
  reject(db, setTKRJ(1, 'accepted'), '§16 tenant done→accepted', 'MEDIA_TENANT_ROTATION_STATE');
  reject(db, insTKRJ(1, 0, 1, 1, 2), '§16 reuse rotation_epoch (PK)', 'constraint');

  // ═══ §9 done blocked by failed / quarantined child (fresh epochs, same connection) ═══
  setupEpoch(db, 10);
  childTo(db, 10, 'bF', 'mrjF', 'failed');
  allow(db, setTKRJ(10, 'finalizing'), 'epoch10 →finalizing (child failed, none accepted/fw/staged)');
  reject(db, setTKRJ(10, 'done'), '§9 finalizing→done blocked by failed child', 'MEDIA_ROTATION_CHILD_ACTIVE');
  allow(db, setTKRJ(10, 'failed'), 'epoch10 →failed (no active child)');

  setupEpoch(db, 11);
  childTo(db, 11, 'bQ', 'mrjQ', 'quarantined');
  allow(db, setTKRJ(11, 'finalizing'), 'epoch11 →finalizing (child quarantined)');
  reject(db, setTKRJ(11, 'done'), '§9 finalizing→done blocked by quarantined child', 'MEDIA_ROTATION_CHILD_ACTIVE');
  allow(db, setTKRJ(11, 'quarantined'), 'epoch11 →quarantined (no active child)');

  // §9 parent may not terminalise with an ACTIVE child
  setupEpoch(db, 12);
  childTo(db, 12, 'bAct', 'mrjAct', 'file_written');
  reject(db, setTKRJ(12, 'finalizing'), '§9 finalizing with file_written child', 'MEDIA_ROTATION_CHILD_ACTIVE');
  reject(db, setTKRJ(12, 'failed'), '§9 parent→failed with active child', 'MEDIA_ROTATION_CHILD_ACTIVE');
  allow(db, setMRJ('mrjAct', 'failed'), 'terminalise the child first');
  allow(db, setTKRJ(12, 'failed'), 'epoch12 →failed after child terminalised');

  // §8 child cannot be created under a terminal parent
  setupEpoch(db, 13);
  allow(db, setTKRJ(13, 'quarantined'), 'epoch13 rotating_blobs→quarantined');
  blob(db, 't1', 'bZ', 1, 1); gen(db, 't1', 'bZ', 2, 2, 'writing');
  reject(db, insMRJ('mrjZ', 13, 'bZ', 1, 2, 1, 2), '§8 child under terminal (quarantined) parent', 'MEDIA_ROTATION_PARENT_STATE');

  // ═══ §5 backup metadata full matrix ═══
  allow(db, insBk('t1', 'bkA'), 'backup bkA in_progress');
  reject(db, `INSERT INTO media_backup_sets (tenant_id,backup_id,status,created_at) VALUES ('t1','bkBad','complete','n')`, '§10 INSERT non-in_progress', 'MEDIA_BACKUP_STATE');
  for (const [c, v] of [['tenant_id', "'z'"], ['backup_id', "'z'"], ['created_at', "'z'"]] as const)
    reject(db, `UPDATE media_backup_sets SET ${c}=${v} WHERE tenant_id='t1' AND backup_id='bkA'`, `§6 mbs identity ${c} immutable`, 'MEDIA_LIFECYCLE_IMMUTABLE');
  reject(db, `DELETE FROM media_backup_sets WHERE backup_id='bkA'`, '§2 backup hard-delete', 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');
  reject(db, `UPDATE media_backup_sets SET status='complete' WHERE backup_id='bkA'`, '§5 complete manifest NULL', 'MEDIA_BACKUP_METADATA_REQUIRED');
  reject(db, `UPDATE media_backup_sets SET status='complete', manifest_hash='${'a'.repeat(63)}', completed_at='c' WHERE backup_id='bkA'`, '§5 manifest 63 chars', 'MEDIA_BACKUP_METADATA_REQUIRED');
  reject(db, `UPDATE media_backup_sets SET status='complete', manifest_hash='${'a'.repeat(65)}', completed_at='c' WHERE backup_id='bkA'`, '§5 manifest 65 chars', 'MEDIA_BACKUP_METADATA_REQUIRED');
  reject(db, `UPDATE media_backup_sets SET status='complete', manifest_hash='${UP64}', completed_at='c' WHERE backup_id='bkA'`, '§5 manifest uppercase hex', 'MEDIA_BACKUP_METADATA_REQUIRED');
  reject(db, `UPDATE media_backup_sets SET status='complete', manifest_hash='${BAD64}', completed_at='c' WHERE backup_id='bkA'`, '§5 manifest non-hex', 'MEDIA_BACKUP_METADATA_REQUIRED');
  reject(db, `UPDATE media_backup_sets SET status='complete', manifest_hash='${H64}' WHERE backup_id='bkA'`, '§5 completed_at NULL', 'MEDIA_BACKUP_METADATA_REQUIRED');
  allow(db, completeBk('t1', 'bkA'), '§5 valid complete');
  reject(db, `UPDATE media_backup_sets SET manifest_hash='${B64}' WHERE backup_id='bkA'`, '§5 manifest immutable after complete', 'MEDIA_BACKUP_METADATA_IMMUTABLE');
  reject(db, `UPDATE media_backup_sets SET completed_at='z' WHERE backup_id='bkA'`, '§5 completed_at immutable after complete', 'MEDIA_BACKUP_METADATA_IMMUTABLE');
  reject(db, `UPDATE media_backup_sets SET status='deleted' WHERE backup_id='bkA'`, '§9 deleted without deleted_at', 'constraint');
  allow(db, deleteBk('t1', 'bkA'), '§10 complete→deleted');
  reject(db, `UPDATE media_backup_sets SET deleted_at='e' WHERE backup_id='bkA'`, '§5 deleted_at immutable once set', 'MEDIA_BACKUP_METADATA_IMMUTABLE');
  reject(db, `UPDATE media_backup_sets SET status='complete' WHERE backup_id='bkA'`, '§16 deleted→complete', 'MEDIA_BACKUP_STATE');
  reject(db, insBk('t1', 'bkA'), '§16 reuse backup_id (PK)', 'constraint');

  // ═══ §4 pin release + §11/§12 contract + §13 identity + §2 hard-delete ═══
  blob(db, 't1', 'bY', 1, 1);
  allow(db, insBk('t1', 'bkP'), 'backup bkP in_progress');
  allow(db, insPin('t1', 'bkP', 'bY', 1), '§12 valid pin');
  reject(db, `DELETE FROM media_backup_generation_pins WHERE backup_id='bkP'`, '§2 pin hard-delete', 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');
  reject(db, insPin('t1', 'bkP', 'bY', 99), '§12 pin non-current generation', 'MEDIA_BACKUP_PIN_NOT_CURRENT');
  reject(db, `INSERT INTO media_backup_generation_pins (tenant_id,backup_id,blob_id,generation_no,pinned_at,released_at) VALUES ('t1','bkP','bY',1,'n','n')`, '§12 pin created already-released', 'MEDIA_BACKUP_PIN_CONTRACT');
  allow(db, insBk('t2', 'bkT2'), 't2 backup');
  reject(db, insPin('t2', 'bkT2', 'bY', 1), '§12 pin generation of another tenant', 'MEDIA_BACKUP_PIN_BLOB');
  allow(db, insBk('t1', 'bkComplete'), 'backup bkComplete');
  allow(db, completeBk('t1', 'bkComplete'), 'bkComplete → complete');
  reject(db, insPin('t1', 'bkComplete', 'bY', 1), '§12 pin on complete backup', 'MEDIA_BACKUP_PIN_BACKUP');
  // §6 pin identity: every column separately
  for (const [c, v] of [['tenant_id', "'z'"], ['backup_id', "'z'"], ['blob_id', "'z'"], ['generation_no', '9'], ['pinned_at', "'z'"]] as const)
    reject(db, `UPDATE media_backup_generation_pins SET ${c}=${v} WHERE tenant_id='t1' AND backup_id='bkP' AND blob_id='bY' AND generation_no=1`, `§6 pin identity ${c} immutable`, 'MEDIA_BACKUP_PIN_IMMUTABLE');
  // §4 manual release rejected while backup is in_progress / complete / failed
  reject(db, `UPDATE media_backup_generation_pins SET released_at='r' WHERE backup_id='bkP' AND blob_id='bY' AND generation_no=1`, '§4 manual release while in_progress', 'MEDIA_BACKUP_PIN_RELEASE_NOT_ALLOWED');
  allow(db, insBk('t1', 'bkFail'), 'bkFail in_progress');
  blob(db, 't1', 'bFp', 1, 1);
  allow(db, insPin('t1', 'bkFail', 'bFp', 1), 'pin on bkFail');
  allow(db, `UPDATE media_backup_sets SET status='failed' WHERE backup_id='bkFail'`, 'bkFail → failed');
  reject(db, `UPDATE media_backup_generation_pins SET released_at='r' WHERE backup_id='bkFail' AND blob_id='bFp' AND generation_no=1`, '§4 manual release while failed', 'MEDIA_BACKUP_PIN_RELEASE_NOT_ALLOWED');
  allow(db, insBk('t1', 'bkComp2'), 'bkComp2 in_progress');
  blob(db, 't1', 'bCp', 1, 1);
  allow(db, insPin('t1', 'bkComp2', 'bCp', 1), 'pin on bkComp2');
  allow(db, completeBk('t1', 'bkComp2'), 'bkComp2 → complete');
  reject(db, `UPDATE media_backup_generation_pins SET released_at='r' WHERE backup_id='bkComp2' AND blob_id='bCp' AND generation_no=1`, '§4 manual release while complete', 'MEDIA_BACKUP_PIN_RELEASE_NOT_ALLOWED');

  // ═══ §14/§15 two backups pin same generation; delete-release isolation; GC; §3 gen hard-delete ═══
  blob(db, 't1', 'bX', 1, 1);
  allow(db, insBk('t1', 'bk1'), 'bk1 in_progress');
  allow(db, insBk('t1', 'bk2'), 'bk2 in_progress');
  allow(db, insBk('t2', 'bk1'), 't2/bk1 in_progress (same backup_id other tenant)');
  blob(db, 't2', 'bXt2', 1, 1);
  allow(db, insPin('t2', 'bk1', 'bXt2', 1), 't2/bk1 pin (must stay untouched)');
  allow(db, insPin('t1', 'bk1', 'bX', 1), '§14 pin A on bX gen1');
  allow(db, insPin('t1', 'bk2', 'bX', 1), '§14 pin B on same generation');
  gen(db, 't1', 'bX', 2, 2, 'available');
  allow(db, switchPtr('bX', 2), 'switch bX→gen2');
  allow(db, setGen('bX', 1, 'superseded'), 'bX gen1→superseded');
  reject(db, setGen('bX', 1, 'gc_pending'), '§15 gc_pending with active pins A+B', 'MEDIA_GENERATION_BACKUP_PINNED');
  reject(db, `DELETE FROM media_blob_generations WHERE tenant_id='t1' AND blob_id='bX' AND generation_no=1`, '§3 physical generation delete while pinned', 'MEDIA_GENERATION_BACKUP_PINNED');
  allow(db, completeBk('t1', 'bk1'), 'bk1 → complete');
  allow(db, deleteBk('t1', 'bk1', 'd1'), '§14 delete t1/bk1');
  ok(Number(db.exec(`SELECT COUNT(*) FROM media_backup_generation_pins WHERE tenant_id='t1' AND backup_id='bk1' AND released_at IS NOT NULL`)[0].values[0][0]) === 1, '§14 pin A released');
  ok(Number(db.exec(`SELECT COUNT(*) FROM media_backup_generation_pins WHERE tenant_id='t1' AND backup_id='bk2' AND released_at IS NULL`)[0].values[0][0]) === 1, '§14 pin B (other backup) untouched');
  ok(Number(db.exec(`SELECT COUNT(*) FROM media_backup_generation_pins WHERE tenant_id='t2' AND backup_id='bk1' AND released_at IS NULL`)[0].values[0][0]) === 1, '§14 t2/bk1 pin (same id, other tenant) untouched');
  reject(db, `UPDATE media_backup_generation_pins SET released_at=NULL WHERE tenant_id='t1' AND backup_id='bk1' AND blob_id='bX' AND generation_no=1`, '§13 released_at value→NULL', 'MEDIA_BACKUP_PIN_IMMUTABLE');
  reject(db, `UPDATE media_backup_generation_pins SET released_at='dX' WHERE tenant_id='t1' AND backup_id='bk1' AND blob_id='bX' AND generation_no=1`, '§13 released_at value→other value', 'MEDIA_BACKUP_PIN_IMMUTABLE');
  reject(db, setGen('bX', 1, 'gc_pending'), '§14 GC still blocked by pin B', 'MEDIA_GENERATION_BACKUP_PINNED');
  allow(db, completeBk('t1', 'bk2'), 'bk2 → complete');
  allow(db, deleteBk('t1', 'bk2', 'd2'), '§14 delete t1/bk2');
  allow(db, setGen('bX', 1, 'gc_pending'), '§15 gc_pending allowed after all pins released');
  reject(db, `DELETE FROM media_blob_generations WHERE tenant_id='t1' AND blob_id='bX' AND generation_no=1`, '§3 physical generation delete forbidden even unpinned', 'MEDIA_LIFECYCLE_HARD_DELETE_FORBIDDEN');

  // ═══ §20 sync isolation ═══
  const manifest = JSON.parse(readFileSync(join(repo, 'src/core/sync/sync-business-schema.json'), 'utf8'));
  const sync = new Set(Object.keys(manifest.tables));
  for (const t of ['tenant_key_rotation_jobs', 'media_rotation_jobs', 'media_backup_sets', 'media_backup_generation_pins'])
    ok(!sync.has(t), `§20 ${t} NOT in sync allowlist`);
  db.close();

  // ═══ R2 §3 — the pure reject→valid contract, 20× on fresh single connections ═══
  let contractRuns = 0;
  for (let i = 1; i <= 20; i++) { contractOnce(SQL, i); contractRuns++; }
  ok(contractRuns === 20, `§3 same-connection reject→valid contract ran 20× (got ${contractRuns})`);

  // ═══ R2-V3 — explicit reject-atomicity (before/after snapshots), 20× on fresh connections ═══
  let atomicityRuns = 0;
  for (let i = 1; i <= 20; i++) { assertRejectAtomicity(SQL, i); atomicityRuns++; }
  ok(atomicityRuns === 20, `V3 explicit reject-atomicity ran 20× (got ${atomicityRuns})`);

  if (fails.length) {
    console.log(`\nMEDIA03B-R2 rotation-backup: ${PASS}/${PASS + FAIL} checks passed — ${FAIL} FAILED`);
    process.exit(1);
  }
  console.log(`MEDIA03B-R2 rotation-backup: ${PASS}/${PASS} checks passed`);
  console.log(`  Pure reject→valid iterations: ${contractRuns}/20`);
  console.log(`  Explicit atomicity iterations: ${atomicityRuns}/20`);
}

main().catch((e) => { console.error(e); process.exit(1); });

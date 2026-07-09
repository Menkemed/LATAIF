// D4-D migration tool test — exercises scripts/d4/d4d_changelog_migrate.mjs against SYNTHETIC
// node:sqlite temp DBs. Execute writes ONLY to temp DBs. No real data. Run: node test/d4/migrate.test.ts

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error — .mjs sibling tool, no types
import { runMigration, renderReport, backupDbs, looksLikeLiveOriginal } from '../../scripts/d4/d4d_changelog_migrate.mjs';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}
function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}
type Row = [number, string, string, string, Record<string, unknown>?];
function makeSyncDb(path: string, rows: Row[]): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL, data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL)`);
  const st = db.prepare(`INSERT INTO sync_changelog (id,tenant_id,branch_id,table_name,record_id,action,data,user_id,created_at)
    VALUES (?,'t1','b1',?,?,?,?,'u','T')`);
  for (const [id, table, rid, action, data] of rows) st.run(id, table, rid, action, JSON.stringify(data ?? {}));
  db.close();
}
function makeFrontendDb(path: string, products: string[] = [], customers: string[] = []): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT, name TEXT, quantity INTEGER, images TEXT)`);
  db.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, branch_id TEXT, name TEXT)`);
  const p = db.prepare(`INSERT INTO products (id, branch_id, name, quantity, images) VALUES (?, 'b1', ?, 1, 'data:image/x')`);
  for (const id of products) p.run(id, 'name-' + id);
  const c = db.prepare(`INSERT INTO customers (id, branch_id, name) VALUES (?, 'b1', ?)`);
  for (const id of customers) c.run(id, 'cust-' + id);
  db.close();
}
function dir(): string { return mkdtempSync(join(tmpdir(), 'd4d-')); }

// 1: default dry-run writes nothing
function test1(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  makeSyncDb(sv, [[1, 'products', 'pA', 'insert'], [2, 'products', 'orphan', 'insert']]);
  makeFrontendDb(fe, ['pA']);
  const before = sha(sv);
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d }, { now: 'T' });
  check(res.blocked === false && res.executed === false && res.mode === 'DRY-RUN', '1: default is dry-run');
  check(sha(sv) === before, '1: dry-run wrote nothing');
}
// 2: execute without full safety flags blocks
function test2(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  makeSyncDb(sv, [[1, 'products', 'pA', 'insert']]);
  makeFrontendDb(fe, ['pA']);
  const before = sha(sv);
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d, execute: true }, { now: 'T' });
  check(res.blocked === true && !res.executed && /requires ALL of/.test(res.reason), '2: execute without full flags blocked');
  check(sha(sv) === before, '2: nothing written');
}
// 3: backup failure blocks
function test3(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  makeSyncDb(sv, [[1, 'products', 'pA', 'insert', { name: 'a' }], [2, 'products', 'orphan', 'insert', {}]]);
  makeFrontendDb(fe, ['pA']);
  const before = sha(sv);
  const badBackup = join(d, 'not-a-dir');
  writeFileSync(badBackup, 'x'); // a FILE where a dir is expected → mkdir fails → backup throws
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d, execute: true, understand: true, backupDir: badBackup }, { now: 'T' });
  check(res.blocked === true && /backup failed/i.test(res.reason), '3: backup failure blocks');
  check(sha(sv) === before, '3: no write on backup failure');
}
// 4: corrupt / non-database sync db blocks
function test4(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  writeFileSync(sv, Buffer.from('THIS IS NOT A SQLITE DATABASE ............................'));
  makeFrontendDb(fe, ['pA']);
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d }, { now: 'T' });
  check(res.blocked === true, '4: corrupt/non-db sync db blocks (no crash)');
}
// 5: empty authoritative + full changelog blocks
function test5(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  const rows: Row[] = [];
  for (let i = 1; i <= 25; i++) rows.push([i, 'products', 'p' + i, 'insert']);
  makeSyncDb(sv, rows);
  makeFrontendDb(fe, []); // products table exists but EMPTY
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d }, { now: 'T' });
  check(res.blocked === true && /authoritative live set EMPTY/i.test((res.plan?.flags || []).join(';')), '5: empty authoritative + full changelog blocks');
}
// 6/7/8/9/10: execute appends baseline + synthetic + preserved, archives + prunes, replay corrective, idempotent
function testExecute(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db'), bk = join(d, 'backup');
  makeSyncDb(sv, [
    [1, 'products', 'pA', 'insert', { name: 'a1' }],
    [2, 'products', 'pA', 'update', { name: 'a2' }],
    [3, 'products', 'orphan', 'insert', { name: 'o' }],
    [4, 'products', 'pC', 'insert', { name: 'c' }],
    [5, 'products', 'pC', 'delete'],
  ]);
  makeFrontendDb(fe, ['pA']); // authoritative live: pA only
  const res = runMigration({ frontendDb: fe, syncDb: sv, out: d, execute: true, understand: true, backupDir: bk }, { now: 'T' });
  check(res.executed === true && res.mode === 'EXECUTE', '6: execute ran with full flags');

  const db = new DatabaseSync(sv, { readOnly: true });
  const rows = db.prepare('SELECT table_name, record_id, action FROM sync_changelog ORDER BY id').all() as Array<{ record_id: string; action: string }>;
  const archiveCount = Number((db.prepare('SELECT COUNT(*) n FROM sync_changelog_archive').get() as { n: number }).n);
  db.close();

  check(rows.some((r) => r.record_id === 'pA' && r.action === 'insert'), '6: baseline upsert for pA appended');
  check(rows.some((r) => r.record_id === 'orphan' && r.action === 'delete'), '7: synthetic delete for orphan appended');
  check(rows.some((r) => r.record_id === 'pC' && r.action === 'delete'), '7b: pC tombstone preserved');
  check(archiveCount === 5, '8: 5 old covered rows archived');
  check(rows.length === 3, '8: active changelog pruned to 3 corrective rows');
  check(res.executeResult.appended === 3 && res.executeResult.pruned === 5, '8: execute result counts (appended 3, pruned 5)');
  check(res.verify && res.verify.idempotent === true, '9: post-migration replay idempotent (0 new synthetic deletes)');

  // 10: second dry-run on the migrated db → 0 synthetic deletes
  const res2 = runMigration({ frontendDb: fe, syncDb: sv, out: d }, { now: 'T' });
  check(res2.plan.plan.syntheticDeleteCount === 0, '10: second dry-run on migrated db → 0 synthetic deletes');

  // 11: report contains no base64/image data
  const md = renderReport(res.plan, res.meta);
  check(!/data:image/i.test(md) && !/[A-Za-z0-9+/]{120,}/.test(md), '11: execute report has no base64/image data');
  // 14: restore hint present in execute report; dry-run report says nothing written
  check(/Restore instructions/i.test(md) && /copy the files/i.test(md), '14: restore hint present in execute report');
  check(/no restore needed/i.test(renderReport(res2.plan, res2.meta)), '14: dry-run report restore note');

  // backup manifest exists + verified
  const manifest = JSON.parse(readFileSync(join(bk, 'manifest.json'), 'utf8'));
  check(manifest.files.some((f: { originalPath: string }) => f.originalPath === sv) && manifest.files.every((f: { sha256: string }) => !!f.sha256), '3b: backup manifest has sync db + sha256 per file');
}
// 12: live AppData path blocked without allow-flag
function test12(): void {
  const d = dir(), sv = join(d, 's.db');
  makeSyncDb(sv, [[1, 'products', 'pA', 'insert']]);
  const res = runMigration({ frontendDb: 'C:/Users/x/AppData/Roaming/com.lataif.app/lataif.db', syncDb: sv, out: d }, { now: 'T' });
  check(res.blocked === true && /LIVE AppData/i.test(res.reason), '12: live AppData path blocked without --allow-live-path');
  check(looksLikeLiveOriginal('C:/x/AppData/Roaming/com.lataif.app/lataif_sync_server.db') === true, '12: guard flags live sync db');
  check(looksLikeLiveOriginal('C:/tmp/copies/lataif.db') === false, '12: guard allows a copy path');
}
// 13: large correction requires extra flag
function test13(): void {
  const d = dir(), sv = join(d, 's.db'), fe = join(d, 'f.db');
  const rows: Row[] = [];
  for (let i = 1; i <= 600; i++) rows.push([i, 'products', 'orph' + i, 'insert']);
  rows.push([601, 'products', 'keep', 'insert']);
  makeSyncDb(sv, rows);
  makeFrontendDb(fe, ['keep']); // authoritative non-empty (keep) → 600 orphans → large correction
  const before = sha(sv);
  const dry = runMigration({ frontendDb: fe, syncDb: sv, out: d }, { now: 'T' });
  check(dry.plan.largeCorrection === true, '13: large correction detected in dry-run');
  const ex = runMigration({ frontendDb: fe, syncDb: sv, out: d, execute: true, understand: true, backupDir: join(d, 'bk') }, { now: 'T' });
  check(ex.blocked === true && /large correction/i.test(ex.reason), '13: execute blocked without --allow-large-correction');
  check(sha(sv) === before, '13: nothing written when large correction blocks');
  // with the flag it proceeds (executes)
  const ex2 = runMigration({ frontendDb: fe, syncDb: sv, out: d, execute: true, understand: true, backupDir: join(d, 'bk2'), allowLargeCorrection: true }, { now: 'T' });
  check(ex2.executed === true, '13: --allow-large-correction lets it execute');
}

function main(): void {
  test1(); test2(); test3(); test4(); test5(); testExecute(); test12(); test13();
  const total = pass + fail.length;
  console.log(`\nD4-D migration tool: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all D4-D migration checks green');
}
main();

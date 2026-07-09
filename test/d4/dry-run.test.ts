// D4-C dry-run tool test — exercises scripts/d4/d4c_changelog_dry_run.mjs against SYNTHETIC
// node:sqlite temp DBs. No real DB, no committed data. Run: node test/d4/dry-run.test.ts

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error — .mjs sibling tool, no types
import { analyze, renderMarkdown, looksLikeLiveOriginal } from '../../scripts/d4/d4c_changelog_dry_run.mjs';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}
function sha(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function makeSyncDb(path: string, rows: Array<[number, string, string, string, string]>): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sync_changelog (
    id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, branch_id TEXT NOT NULL,
    table_name TEXT NOT NULL, record_id TEXT NOT NULL, action TEXT NOT NULL,
    data TEXT NOT NULL, user_id TEXT, created_at TEXT NOT NULL)`);
  const st = db.prepare(`INSERT INTO sync_changelog (id, tenant_id, branch_id, table_name, record_id, action, data, user_id, created_at)
    VALUES (?, 't1', 'b1', ?, ?, ?, '{}', 'u', 'T')`);
  for (const [id, table, rid, action] of rows) st.run(id, table, rid, action);
  db.close();
}
function makeFrontendDb(path: string, products: string[], customers: string[] = []): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT, quantity INTEGER, images TEXT)`);
  db.exec(`CREATE TABLE customers (id TEXT PRIMARY KEY, branch_id TEXT)`);
  const p = db.prepare(`INSERT INTO products (id, branch_id, quantity, images) VALUES (?, 'b1', 1, 'data:image/x')`);
  for (const id of products) p.run(id);
  const c = db.prepare(`INSERT INTO customers (id, branch_id) VALUES (?, 'b1')`);
  for (const id of customers) c.run(id);
  db.close();
}

function testMain(): void {
  const dir = mkdtempSync(join(tmpdir(), 'd4c-'));
  const sv = join(dir, 'sync.db');
  const fe = join(dir, 'fe.db');
  // pA: insert+update (live), pB: insert (live), orphan: insert (live, not authoritative),
  // pC: insert+delete (tombstone), cX: customer insert (live)
  makeSyncDb(sv, [
    [1, 'products', 'pA', 'insert'],
    [2, 'products', 'pA', 'update'],
    [3, 'products', 'pB', 'insert'],
    [4, 'products', 'orphan', 'insert'],
    [5, 'products', 'pC', 'insert'],
    [6, 'products', 'pC', 'delete'],
    [7, 'customers', 'cX', 'insert'],
  ]);
  makeFrontendDb(fe, ['pA', 'pB'], ['cX']); // authoritative live: pA, pB, cX (NOT orphan, NOT pC)

  const shaSvBefore = sha(sv);
  const shaFeBefore = sha(fe);

  const r = analyze(fe, sv);

  // 1/3/4: reads both DBs, detects orphan, plans synthetic delete
  check(r.blocked === false, '1: not blocked on healthy inputs');
  check(r.plan.syntheticDeletes === 1, '4: exactly one synthetic delete (the orphan)');
  check(r.plan.syntheticDeleteSample.some((s: { record_id: string }) => s.record_id === 'orphan'), '3: orphan detected & tombstoned');
  check(!r.plan.syntheticDeleteSample.some((s: { record_id: string }) => ['pA', 'pB', 'cX'].includes(s.record_id)), '3: authoritative records NOT tombstoned');
  check(!r.plan.syntheticDeleteSample.some((s: { record_id: string }) => s.record_id === 'pC'), '4: already-deleted pC not re-tombstoned');

  // 5: baseline upserts = authoritative live count (pA, pB, cX)
  check(r.plan.baselineUpserts === 3, '5: baseline upserts = 3 authoritative live records');

  // 6: compaction potential
  check(r.compaction.kept === 5, '6: compaction keeps 5 (one per record)');
  check(r.compaction.archived === 2, '6: 2 archived (pA superseded insert, pC superseded insert)');
  check(r.compaction.tombstonesKept === 1, '6: pC delete tombstone kept');
  check(r.compaction.livenessPreserved === true, '6: compaction preserves liveness');

  // 10: idempotent
  check(r.idempotent === true, '10: plan is idempotent');

  // integrity + products
  check(r.integrity.syncDb === 'ok' && r.integrity.frontendDb === 'ok', 'integrity ok');
  check(r.products && r.products.count === 2, 'products aggregate read (count=2)');

  // coverage
  check(r.coverage.covered.includes('products') && r.coverage.covered.includes('customers'), 'coverage: products+customers covered');

  // 8: renderMarkdown contains NO base64 / no image data
  const md = renderMarkdown(r, { timestamp: 'X', frontendDbPath: fe, syncDbPath: sv });
  check(!/data:image/i.test(md) && !/[A-Za-z0-9+/]{120,}/.test(md), '8: report contains no base64/image data');
  check(md.includes('READ-ONLY dry-run'), '8: report labelled read-only');

  // 9: input DBs unchanged
  check(sha(sv) === shaSvBefore && sha(fe) === shaFeBefore, '9: input DBs unchanged (sha stable)');
}

// 7: blocked when authoritative set empty but changelog has many live records
function testBlockedEmptyAuthoritative(): void {
  const dir = mkdtempSync(join(tmpdir(), 'd4c-'));
  const sv = join(dir, 'sync.db');
  const fe = join(dir, 'fe.db');
  const rows: Array<[number, string, string, string]> = [];
  for (let i = 1; i <= 25; i++) rows.push([i, 'products', 'p' + i, 'insert']);
  makeSyncDb(sv, rows);
  makeFrontendDb(fe, []); // products table exists but EMPTY → authoritative empty
  const r = analyze(fe, sv);
  check(r.blocked === true, '7: blocked when authoritative empty + many live changelog records');
  check(r.flags.some((f: string) => /authoritative live set EMPTY/i.test(f)), '7: block reason surfaced');
}

// safety helper: refuses live-original paths
function testLivePathGuard(): void {
  check(looksLikeLiveOriginal('C:/Users/x/AppData/Roaming/com.lataif.app/lataif.db') === true, 'guard: flags live lataif.db original');
  check(looksLikeLiveOriginal('C:/Users/x/AppData/Roaming/com.lataif.app/lataif_sync_server.db') === true, 'guard: flags live sync db original');
  check(looksLikeLiveOriginal('C:/tmp/d4c-dry-run/lataif.db') === false, 'guard: allows a copy path');
}

function main(): void {
  testMain();
  testBlockedEmptyAuthoritative();
  testLivePathGuard();

  const total = pass + fail.length;
  console.log(`\nD4-C dry-run tool: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all D4-C dry-run checks green');
}

main();

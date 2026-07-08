// D3 safe-purge test — tracked bulk deletes + pre-destructive backup + full-replay.
// Run: node test/d3/safe-purge.test.ts
// Nutzt echte in-memory sql.js-DBs (wie test/b1) + Node-fs-Adapter gegen synthetische
// Temp-Dateien. Fasst NIE echte App-/Produktdaten an.

import initSqlJs from 'sql.js';
import { mkdtemp, writeFile, readFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { createHash } from 'node:crypto';
import {
  PURGE_PLANS,
  selectPurgeIds,
  countPurge,
  executeTrackedPurge,
  runSafePurge,
  isFactoryResetBlocked,
  runGuardedReset,
  type PurgeDb,
} from '../../src/core/settings/safe-purge.ts';
import {
  buildBackupManifest,
  runPreDestructiveBackup,
  type BackupFsDeps,
  type BackupFileEntry,
} from '../../src/core/settings/pre-destructive-backup.ts';

let pass = 0;
const fail: string[] = [];
function check(cond: unknown, msg: string): void {
  if (cond) pass++;
  else fail.push(msg);
}
async function threw(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e ?? new Error('threw'); }
}
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SQL: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(): any {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE customers (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE offers (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE offer_lines (id TEXT PRIMARY KEY, offer_id TEXT);
    CREATE TABLE invoices (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT);
    CREATE TABLE payments (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE repairs (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE consignments (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, branch_id TEXT);
    CREATE TABLE documents (id TEXT PRIMARY KEY, branch_id TEXT);
  `);
  return db;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function insB(db: any, table: string, id: string, scopeCol: string, scope: string): void {
  db.run(`INSERT INTO ${table} (id, ${scopeCol}) VALUES (?, ?)`, [id, scope]);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ids(db: any, table: string): string[] {
  const r = db.exec(`SELECT id FROM ${table} ORDER BY id`);
  return (r[0]?.values ?? []).map((v: unknown[]) => String(v[0]));
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cnt(db: any, table: string): number {
  const r = db.exec(`SELECT COUNT(*) FROM ${table}`);
  return Number(r[0].values[0][0]);
}
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

// Client-DB mit Produkten p1,p2,p3 (branch B), p9 (OTHER) + je 1 offer/invoice-Zeile in B.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seedClientB(): any {
  const db = seed();
  insB(db, 'products', 'p1', 'branch_id', 'B');
  insB(db, 'products', 'p2', 'branch_id', 'B');
  insB(db, 'products', 'p3', 'branch_id', 'B');
  insB(db, 'products', 'p9', 'branch_id', 'OTHER');
  insB(db, 'offers', 'o1', 'branch_id', 'B');
  insB(db, 'offer_lines', 'ol1', 'offer_id', 'o1');
  insB(db, 'invoices', 'i1', 'branch_id', 'B');
  insB(db, 'invoice_lines', 'il1', 'invoice_id', 'i1');
  return db;
}

function okBackup() {
  return Promise.resolve({ location: '<temp>/backups/pre_destructive_x' });
}

// ── 1-3, 8: executeTrackedPurge / runSafePurge Kern ──
async function testTrackedPurge(): Promise<void> {
  // 1: liest alle betroffenen Produkt-IDs (branch B, nicht OTHER)
  const db0 = seedClientB();
  const productStep = PURGE_PLANS.products[2]; // BRANCH('products')
  check(sameSet(selectPurgeIds(db0 as unknown as PurgeDb, productStep, 'B'), ['p1', 'p2', 'p3']), '1: reads affected product ids for branch');
  check(selectPurgeIds(db0 as unknown as PurgeDb, productStep, 'OTHER').length === 1, '1: other branch scoped separately');
  db0.close();

  // 2+3: runSafePurge schreibt genau 1 delete-change je ID, löscht danach lokal
  const db = seedClientB();
  const deletes: Array<{ table: string; id: string }> = [];
  const res = await runSafePurge(PURGE_PLANS.products, 'B', {
    db: db as unknown as PurgeDb,
    backup: okBackup,
    begin: () => db.run('BEGIN'),
    commit: () => db.run('COMMIT'),
    rollback: () => db.run('ROLLBACK'),
    onDelete: (table, id) => { deletes.push({ table, id }); },
  });
  // je Record genau ein delete-change: ol1, il1, p1, p2, p3 = 5
  check(deletes.length === 5, '2: one delete-change per affected record (5)');
  const prodDeletes = deletes.filter(d => d.table === 'products').map(d => d.id);
  check(sameSet(prodDeletes, ['p1', 'p2', 'p3']), '2: delete-changes cover exactly the branch products');
  check(deletes.some(d => d.table === 'offer_lines' && d.id === 'ol1'), '2: offer_lines child tracked');
  check(deletes.some(d => d.table === 'invoice_lines' && d.id === 'il1'), '2: invoice_lines child tracked');
  // danach lokal gelöscht
  check(sameSet(ids(db, 'products'), ['p9']), '3: branch products deleted locally, other branch kept');
  check(cnt(db, 'offer_lines') === 0 && cnt(db, 'invoice_lines') === 0, '3: child lines deleted locally');
  check(res.total === 5, '3: result total = 5');
  check(res.backupLocation.includes('pre_destructive'), '3: backup location surfaced');
  db.close();

  // 8: leerer Bestand → kein Fehler, total 0, keine delete-changes
  const empty = seed();
  const emptyDeletes: string[] = [];
  const r8 = await runSafePurge(PURGE_PLANS.products, 'NOBRANCH', {
    db: empty as unknown as PurgeDb,
    backup: okBackup,
    begin: () => empty.run('BEGIN'),
    commit: () => empty.run('COMMIT'),
    rollback: () => empty.run('ROLLBACK'),
    onDelete: (_t, id) => { emptyDeletes.push(id); },
  });
  check(r8.total === 0 && emptyDeletes.length === 0, '8: empty stock → 0 deletes, no crash');
  empty.close();
}

// ── 4: Backup-Fehler → kein Delete, kein trackDelete ──
async function testBackupFailureAborts(): Promise<void> {
  const db = seedClientB();
  const deletes: string[] = [];
  const e = await threw(() => runSafePurge(PURGE_PLANS.products, 'B', {
    db: db as unknown as PurgeDb,
    backup: () => Promise.reject(new Error('simulated backup failure')),
    begin: () => db.run('BEGIN'),
    commit: () => db.run('COMMIT'),
    rollback: () => db.run('ROLLBACK'),
    onDelete: (_t, id) => { deletes.push(id); },
  }));
  check(e instanceof Error, '4: runSafePurge throws when backup fails');
  check(deletes.length === 0, '4: NO delete-change written when backup fails');
  check(cnt(db, 'products') === 4, '4: NO rows deleted when backup fails');
  db.close();
}

// ── 5: trackDelete/onDelete-Fehler mitten drin → ROLLBACK, nichts (halb) gelöscht ──
async function testTrackFailureRollsBack(): Promise<void> {
  const db = seedClientB();
  // onDelete wirft erst bei 'products' (3. Tabelle) — offer_lines/invoice_lines wurden
  // vorher schon getrackt+gelöscht; der Rollback muss AUCH die zurücknehmen (Atomarität).
  const e = await threw(() => runSafePurge(PURGE_PLANS.products, 'B', {
    db: db as unknown as PurgeDb,
    backup: okBackup,
    begin: () => db.run('BEGIN'),
    commit: () => db.run('COMMIT'),
    rollback: () => db.run('ROLLBACK'),
    onDelete: (table) => { if (table === 'products') throw new Error('simulated trackDelete failure'); },
  }));
  check(e instanceof Error, '5: runSafePurge propagates the trackDelete failure');
  check(cnt(db, 'products') === 4, '5: no products deleted after rollback');
  check(cnt(db, 'offer_lines') === 1 && cnt(db, 'invoice_lines') === 1, '5: earlier child deletes rolled back too (atomic)');
  db.close();
}

// ── 6: All-Data-Purge trackt Produkte (+ alle sync-getrackten Tabellen) ──
async function testAllDataPurge(): Promise<void> {
  const db = seedClientB();
  insB(db, 'customers', 'c1', 'branch_id', 'B');
  insB(db, 'tasks', 't1', 'branch_id', 'B');
  const tracked: Array<{ table: string; id: string }> = [];
  await runSafePurge(PURGE_PLANS.all_data, 'B', {
    db: db as unknown as PurgeDb,
    backup: okBackup,
    begin: () => db.run('BEGIN'),
    commit: () => db.run('COMMIT'),
    rollback: () => db.run('ROLLBACK'),
    onDelete: (table, id) => { tracked.push({ table, id }); },
  });
  check(tracked.some(t => t.table === 'products' && ['p1', 'p2', 'p3'].includes(t.id)), '6: all_data tracks product deletes');
  check(tracked.some(t => t.table === 'customers' && t.id === 'c1'), '6: all_data tracks customer delete');
  check(tracked.some(t => t.table === 'tasks' && t.id === 't1'), '6: all_data tracks task delete');
  check(cnt(db, 'products') === 1 && cnt(db, 'customers') === 0 && cnt(db, 'tasks') === 0, '6: all_data deleted branch rows (other-branch product kept)');
  // Jede Tabelle, die in Branch B Zeilen hatte, muss delete-changes bekommen haben (kein silent untracked).
  const trackedTables = new Set(tracked.map(t => t.table));
  const expectTracked = ['offer_lines', 'invoice_lines', 'offers', 'invoices', 'products', 'customers', 'tasks'];
  check(expectTracked.every(t => trackedTables.has(t)), '6: every non-empty purged table got delete-changes');
  db.close();
}

// ── 7: Full-Replay — alte Inserts + D3-Delete-Changes → gelöschte Produkte bleiben weg ──
async function testFullReplay(): Promise<void> {
  // Server-Changelog (bereits gesyncte alte Inserts):
  const serverLog: Array<{ table: string; record_id: string; action: string; branch_id?: string }> = [
    { table: 'products', record_id: 'p1', action: 'insert', branch_id: 'B' },
    { table: 'products', record_id: 'p2', action: 'insert', branch_id: 'B' },
    { table: 'products', record_id: 'p3', action: 'insert', branch_id: 'B' },
    { table: 'products', record_id: 'p9', action: 'insert', branch_id: 'OTHER' },
  ];
  // Client A hat genau diese Produkte und purged Branch B:
  const clientA = seed();
  for (const c of serverLog) insB(clientA, c.table, c.record_id, 'branch_id', c.branch_id!);
  await runSafePurge(PURGE_PLANS.products, 'B', {
    db: clientA as unknown as PurgeDb,
    backup: okBackup,
    begin: () => clientA.run('BEGIN'),
    commit: () => clientA.run('COMMIT'),
    rollback: () => clientA.run('ROLLBACK'),
    // D3-Delete-Changes werden an den Server-Log angehängt (wie trackDelete → changelog):
    onDelete: (table, id) => { serverLog.push({ table, record_id: id, action: 'delete' }); },
  });
  clientA.close();

  // Client B repliziert den GESAMTEN Server-Log frisch (applyUpsert-Semantik):
  const clientB = seed();
  for (const c of serverLog) {
    if (c.action === 'insert' || c.action === 'update') {
      clientB.run(`INSERT OR REPLACE INTO ${c.table} (id, branch_id) VALUES (?, ?)`, [c.record_id, c.branch_id ?? null]);
    } else if (c.action === 'delete') {
      clientB.run(`DELETE FROM ${c.table} WHERE id = ?`, [c.record_id]);
    }
  }
  check(sameSet(ids(clientB, 'products'), ['p9']), '7: after full replay, purged products stay deleted (only other-branch survives)');
  clientB.close();
}

// ── countPurge ──
async function testCount(): Promise<void> {
  const db = seedClientB();
  const c = countPurge(db as unknown as PurgeDb, PURGE_PLANS.products, 'B');
  check(c.total === 5, 'count: products plan total 5');
  check(c.perTable['products'] === 3, 'count: 3 products');
  check(cnt(db, 'products') === 4, 'count: countPurge does NOT delete');
  db.close();
}

// ── Backup module ──
function nodeBackupDeps(appDir: string, overrides: Partial<BackupFsDeps> = {}): BackupFsDeps {
  return {
    appDataDir: async () => appDir,
    join: async (...parts: string[]) => pjoin(...parts),
    exists: async (p: string) => exists(p),
    readFile: async (p: string) => new Uint8Array(await readFile(p)),
    writeFile: async (p: string, d: Uint8Array) => { await writeFile(p, d); },
    mkdir: async (p: string, o: { recursive: boolean }) => { await mkdir(p, { recursive: o.recursive }); },
    sha256: async (d: Uint8Array) => { const h = createHash('sha256'); h.update(d); return h.digest('hex'); },
    appVersion: async () => '9.9.9-test',
    nowIso: () => '2026-07-08T12:00:00.000Z',
    ...overrides,
  };
}

function testManifest(): void {
  const files: BackupFileEntry[] = [
    { name: 'lataif.db', srcPath: '/a/lataif.db', dstPath: '/b/lataif.db', size: 10, sha256: 'abc' },
  ];
  const m = buildBackupManifest({ action: 'purge:products', timestamp: 'T', appVersion: '1.2.3', backupDir: '/b', files });
  check(m.warning.includes('pre-destructive'), 'manifest: has warning');
  check(m.action === 'purge:products', 'manifest: action set');
  check(m.appVersion === '1.2.3', 'manifest: appVersion set');
  check(m.files[0].originalPath === '/a/lataif.db' && m.files[0].copiedPath === '/b/lataif.db', 'manifest: paths mapped');
  check(m.files[0].sha256 === 'abc' && m.files[0].size === 10, 'manifest: sha+size mapped');
}

async function testBackupRun(): Promise<void> {
  // success: synthetische lataif.db + sync-server-Dateien im appDir
  const appDir = await mkdtemp(pjoin(tmpdir(), 'lataif-d3-'));
  const dbBytes = new TextEncoder().encode('SYNTHETIC-DB-CONTENT');
  await writeFile(pjoin(appDir, 'lataif.db'), dbBytes);
  await writeFile(pjoin(appDir, 'lataif_sync_server.db'), new TextEncoder().encode('SYNC'));
  const res = await runPreDestructiveBackup('purge:products', nodeBackupDeps(appDir));
  check(await exists(res.dir), 'backup: backup dir created');
  check(res.files.length === 2, 'backup: copied both present files (wal/shm absent → skipped)');
  const copied = new Uint8Array(await readFile(pjoin(res.dir, 'lataif.db')));
  check(copied.length === dbBytes.length && copied[0] === dbBytes[0], 'backup: lataif.db copied faithfully');
  const expectSha = createHash('sha256').update(dbBytes).digest('hex');
  const dbEntry = res.files.find(f => f.name === 'lataif.db')!;
  check(dbEntry.sha256 === expectSha, 'backup: sha256 recorded correctly');
  check(dbEntry.size === dbBytes.length, 'backup: size recorded');
  const manifest = JSON.parse(new TextDecoder().decode(await readFile(res.manifestPath)));
  check(manifest.warning.includes('pre-destructive') && manifest.files.length === 2, 'backup: manifest.json written & complete');

  // failure: writeFile wirft → runPreDestructiveBackup wirft (→ Aufrufer bricht ab)
  const appDir2 = await mkdtemp(pjoin(tmpdir(), 'lataif-d3-'));
  await writeFile(pjoin(appDir2, 'lataif.db'), dbBytes);
  const e = await threw(() => runPreDestructiveBackup('x', nodeBackupDeps(appDir2, {
    writeFile: async () => { throw new Error('simulated disk full'); },
  })));
  check(e instanceof Error, 'backup: copy failure throws (aborts destructive action)');

  // no source files → throw
  const appDir3 = await mkdtemp(pjoin(tmpdir(), 'lataif-d3-'));
  const e2 = await threw(() => runPreDestructiveBackup('x', nodeBackupDeps(appDir3)));
  check(e2 instanceof Error, 'backup: no source DB files → throws');
}

// ── D3b: Factory-Reset-Guard ──
function testResetGuardPure(): void {
  check(isFactoryResetBlocked({ syncConfigured: true, lanMode: 'off' }) === true, 'g: blocked when sync configured');
  check(isFactoryResetBlocked({ syncConfigured: false, lanMode: 'server' }) === true, 'g: blocked when LAN server');
  check(isFactoryResetBlocked({ syncConfigured: false, lanMode: 'client' }) === true, 'g: blocked when LAN client');
  check(isFactoryResetBlocked({ syncConfigured: false, lanMode: 'manual' }) === true, 'g: blocked when LAN manual');
  check(isFactoryResetBlocked({ syncConfigured: false, lanMode: 'off' }) === false, 'g: NOT blocked when off + no sync');
  check(isFactoryResetBlocked({ syncConfigured: false, lanMode: '' }) === false, 'g: NOT blocked when empty lanMode + no sync');
}

async function testGuardedReset(): Promise<void> {
  // 1-3: Sync konfiguriert → blockiert, KEIN Backup, KEIN Reset
  let backupCalls = 0, resetCalls = 0, blockedCalls = 0;
  const r1 = await runGuardedReset({
    syncConfigured: true,
    lanMode: 'off',
    backup: async () => { backupCalls++; return { location: 'x' }; },
    reset: async () => { resetCalls++; },
    onBlocked: () => { blockedCalls++; },
  });
  check(r1.blocked === true, 'reset-1: factory reset blocked when sync configured');
  check(blockedCalls === 1, 'reset-2: onBlocked fired');
  check(resetCalls === 0, 'reset-2: resetDatabase NOT called when blocked');
  check(backupCalls === 0, 'reset-3: no destructive action (no backup) when blocked');

  // 4: ohne Sync → Backup ZUERST, dann Reset
  const order: string[] = [];
  const r4 = await runGuardedReset({
    syncConfigured: false,
    lanMode: 'off',
    backup: async () => { order.push('backup'); return { location: '/b/pre_destructive_x' }; },
    reset: async () => { order.push('reset'); },
    onBlocked: () => { order.push('blocked'); },
  });
  check(r4.blocked === false, 'reset-4: runs when no sync configured');
  check(order.join(',') === 'backup,reset', 'reset-4: backup runs before reset');
  check(r4.backupLocation === '/b/pre_destructive_x', 'reset-4: backup location surfaced');

  // 5: Backup-Fehler → kein Reset (wie D3)
  let reset5 = 0;
  const e = await threw(() => runGuardedReset({
    syncConfigured: false,
    lanMode: 'off',
    backup: async () => { throw new Error('simulated backup failure'); },
    reset: async () => { reset5++; },
    onBlocked: () => {},
  }));
  check(e instanceof Error, 'reset-5: backup failure throws');
  check(reset5 === 0, 'reset-5: no reset when backup fails');
}

async function main(): Promise<void> {
  SQL = await initSqlJs();
  await testTrackedPurge();
  await testBackupFailureAborts();
  await testTrackFailureRollsBack();
  await testAllDataPurge();
  await testFullReplay();
  await testCount();
  testManifest();
  await testBackupRun();
  testResetGuardPure();
  await testGuardedReset();

  const total = pass + fail.length;
  console.log(`\nD3 safe-purge: ${pass}/${total} checks passed`);
  if (fail.length) {
    console.log('FAILURES:');
    for (const f of fail) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('✓ all D3 safe-purge checks green');
}

main().catch((e) => { console.error('D3 test crashed:', e); process.exit(1); });

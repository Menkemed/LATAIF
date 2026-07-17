// M6-B2DE4 S5/S6 -- BEHAVIORAL proof of the sync apply gates against a REAL sql.js database.
//
// This is not a source-position scan. It drives the ACTUAL production dispatcher
// `applySyncChange` (src/core/sync/apply-change.ts) -- the same function the Tauri pull loop
// calls -- plus the REAL `applyChangesAtomic` / `commitPulledBatch` orchestration
// (src/core/sync/durable-cursor.ts), against a real sql.js `Database`. No mirrored second
// implementation. For every crafted table/column attack it proves: a stable-coded throw, and
// NO INSERT / UPDATE / DELETE (schema + data byte-equal to the pre-attack snapshot). S6 then
// reproduces the payload-column poisoning head-of-line DoS end to end.
//
// Run: node test/m6b2de4/identifier-apply-behavior.test.ts

import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  applySyncChange,
  SYNC_TABLE_NAME_INVALID,
  SYNC_COLUMN_NAME_INVALID,
  SYNC_CONTROL_PLANE_TABLE_FORBIDDEN,
  type ApplyChange,
  type SqlDb,
} from '../../src/core/sync/apply-change.ts';
import { applyChangesAtomic, commitPulledBatch, SyncApplyError } from '../../src/core/sync/durable-cursor.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs({ locateFile: () => join(here, '../../node_modules/sql.js/dist/sql-wasm.wasm') });

// 1. A real database: two business tables and two control-plane tables that ACTUALLY EXIST, so a
//    successful write would be observable -- the guard, not a missing table, is what stops it.
function freshDb(): any {
  const db = new SQL.Database();
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT, name TEXT)');
  db.run('CREATE TABLE invoices (id TEXT PRIMARY KEY, total TEXT)');
  db.run('CREATE TABLE enrolled_devices (id TEXT PRIMARY KEY, secret TEXT)');
  db.run('CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT)');
  db.run("INSERT INTO products (id, brand, name) VALUES ('p1','Rolex','Submariner')");
  db.run("INSERT INTO enrolled_devices (id, secret) VALUES ('d1','KEEP-ME')");
  db.run("INSERT INTO users (id, password_hash) VALUES ('u1','ORIGINAL-HASH')");
  return db;
}

// 2. Snapshot = schema (sqlite_master) + every row of every table, serialized. Byte-equal before
//    and after => no INSERT/UPDATE/DELETE, no table added or dropped, no schema change.
function snapshot(db: any): string {
  const out: Record<string, unknown> = {
    schema: db.exec('SELECT type, name, sql FROM sqlite_master ORDER BY type, name'),
  };
  for (const t of ['products', 'invoices', 'enrolled_devices', 'users']) {
    out[t] = db.exec(`SELECT * FROM ${t} ORDER BY id`);
  }
  return JSON.stringify(out);
}

const chg = (table: string, id: string, action: string, data: Record<string, unknown>): ApplyChange =>
  ({ table_name: table, record_id: id, action, data: JSON.stringify(data) });

// Run the REAL dispatcher; expect a throw carrying `code` and ZERO mutation.
function expectRejected(label: string, change: ApplyChange, code: string): void {
  const db = freshDb();
  const before = snapshot(db);
  let threw: Error | null = null;
  try { applySyncChange(db as SqlDb, change); } catch (e) { threw = e as Error; }
  check(threw !== null, `${label}: must throw`);
  check(!!threw && threw.message.includes(code),
    `${label}: carries ${code} (got: ${threw ? threw.message.slice(0, 70) : 'no throw'})`);
  check(snapshot(db) === before, `${label}: no mutation -- schema + data byte-equal`);
  db.close();
}

// -- S5 column attacks (INSERT and UPDATE paths). Control chars are proper \u escapes so the
//    SOURCE file stays clean ASCII while the RUNTIME string carries a real newline/tab/NUL. --
const COLUMN_ATTACKS: [string, string][] = [
  ['UPPERCASE', SYNC_COLUMN_NAME_INVALID],
  ['column.name', SYNC_COLUMN_NAME_INVALID],
  ['"column"', SYNC_COLUMN_NAME_INVALID],
  ['`column`', SYNC_COLUMN_NAME_INVALID],
  ['[column]', SYNC_COLUMN_NAME_INVALID],
  ['column name', SYNC_COLUMN_NAME_INVALID],
  ['column; DROP TABLE users', SYNC_COLUMN_NAME_INVALID],
  ['column -- comment', SYNC_COLUMN_NAME_INVALID],
  ['column /* comment */', SYNC_COLUMN_NAME_INVALID],
  ['col\nnewline', SYNC_COLUMN_NAME_INVALID],
  ['col\ttab', SYNC_COLUMN_NAME_INVALID],
  ['col\u0000nul', SYNC_COLUMN_NAME_INVALID],
  ['col\u0007bell', SYNC_COLUMN_NAME_INVALID],
  ['a'.repeat(65), SYNC_COLUMN_NAME_INVALID],
];
for (const [col, expected] of COLUMN_ATTACKS) {
  // INSERT path (new record) and UPDATE path (existing record) both interpolate column keys.
  expectRejected(`col INSERT ${JSON.stringify(col)}`, chg('products', 'p2', 'insert', { [col]: 'x' }), expected);
  expectRejected(`col UPDATE ${JSON.stringify(col)}`, chg('products', 'p1', 'update', { [col]: 'x' }), expected);
}

// a normal column IS applied (control -- proves the gate is not blocking everything)
{
  const db = freshDb();
  applySyncChange(db as SqlDb, chg('products', 'p1', 'update', { brand: 'Omega' }));
  check(db.exec("SELECT brand FROM products WHERE id='p1'")[0].values[0][0] === 'Omega',
    'a canonical column name applies normally');
  applySyncChange(db as SqlDb, chg('products', 'p9', 'insert', { brand: 'Seiko', name: 'S9' }));
  check(db.exec("SELECT COUNT(*) FROM products WHERE id='p9'")[0].values[0][0] === 1,
    'a canonical INSERT applies normally');
  db.close();
}

// -- S5 table-name attacks (UPDATE and DELETE paths) --
const TABLE_ATTACKS = [
  'UPPERCASE', 'Products', 'main.products', 'temp.products', '"products"', '`products`', '[products]',
  ' products', 'products ', 'products\n', 'products\t', 'products;', 'products-- x', 'products/* x */',
  'products-', 'a'.repeat(65),
];
for (const t of TABLE_ATTACKS) {
  expectRejected(`table UPDATE ${JSON.stringify(t)}`, chg(t, 'p1', 'update', { brand: 'x' }), SYNC_TABLE_NAME_INVALID);
  expectRejected(`table DELETE ${JSON.stringify(t)}`, chg(t, 'p1', 'delete', {}), SYNC_TABLE_NAME_INVALID);
}

// -- S5 control-plane block (UPDATE and DELETE), including the DELETE path --
for (const cp of ['enrolled_devices', 'users']) {
  expectRejected(`control-plane UPDATE ${cp}`, chg(cp, 'd1', 'update', { secret: 'STOLEN' }), SYNC_CONTROL_PLANE_TABLE_FORBIDDEN);
  expectRejected(`control-plane DELETE ${cp}`, chg(cp, 'd1', 'delete', {}), SYNC_CONTROL_PLANE_TABLE_FORBIDDEN);
}
// and the secret really is untouched after a rejected control-plane write
{
  const db = freshDb();
  try { applySyncChange(db as SqlDb, chg('enrolled_devices', 'd1', 'update', { secret: 'STOLEN' })); } catch { /* expected */ }
  check(db.exec("SELECT secret FROM enrolled_devices WHERE id='d1'")[0].values[0][0] === 'KEEP-ME',
    'control-plane data is unchanged after a rejected write');
  db.close();
}

// ===========================================================================
// S6 -- the poisoned-changelog head-of-line DoS, reproduced end to end on the CLIENT.
// A CANONICAL allowed table (`products`) carrying an INVALID payload column name. The server
// accepts it (proven Rust-side: the legacy push stores `data` opaquely); here we prove the client
// half: it refuses the batch, the cursor does not advance, and every subsequent valid change in
// the same window is blocked -- and a re-pull fails identically, so the cursor is permanently stuck.
// ===========================================================================
{
  const db = freshDb();
  let cursor = 0;
  const batch = [
    { id: 1, ...chg('products', 'p1', 'update', { brand: 'Legit-1' }) },
    { id: 2, ...chg('products', 'p3', 'insert', { BadColumn: 'x' }) }, // canonical table, INVALID column
    { id: 3, ...chg('invoices', 'i1', 'insert', { total: '100' }) },
  ];
  const runBatch = () => applyChangesAtomic(batch as any, {
    begin: () => db.run('BEGIN'),
    applyChange: (c: any) => applySyncChange(db as SqlDb, c),
    commit: () => db.run('COMMIT'),
    rollback: () => db.run('ROLLBACK'),
  });

  let threw: any = null;
  try {
    await commitPulledBatch({ applyBatch: runBatch, durableSave: async () => {}, setCursor: () => { cursor = 3; } });
  } catch (e) { threw = e; }

  check(threw instanceof SyncApplyError, 'S6a: the poisoned batch throws SyncApplyError');
  const causeMsg = String(threw?.cause?.message ?? threw?.message ?? '');
  check(causeMsg.includes(SYNC_COLUMN_NAME_INVALID), 'S6b: it fails specifically on the invalid column');
  check(cursor === 0, 'S6c: cursor did NOT advance (commitPulledBatch never reached setCursor)');
  // rollback => NONE of the batch applied
  check(db.exec("SELECT brand FROM products WHERE id='p1'")[0].values[0][0] === 'Rolex',
    'S6d: the earlier valid change was rolled back');
  check(db.exec("SELECT COUNT(*) FROM products WHERE id='p3'")[0].values[0][0] === 0,
    'S6e: the poisoned insert was not applied');
  check(db.exec("SELECT COUNT(*) FROM invoices WHERE id='i1'")[0].values[0][0] === 0,
    'S6f: the subsequent valid change is BLOCKED behind the poison');

  // re-pull the SAME window => identical failure => cursor STILL stuck: head-of-line DoS.
  let threw2 = false;
  try {
    await commitPulledBatch({ applyBatch: runBatch, durableSave: async () => {}, setCursor: () => { cursor = 3; } });
  } catch { threw2 = true; }
  check(threw2 && cursor === 0, 'S6g: re-pull fails identically -> cursor permanently stuck (HoL DoS confirmed)');
  db.close();
}

console.log(`M6-B2DE4 identifier-apply-behavior: ${pass}/${pass + fails.length} checks passed`);
if (fails.length) {
  for (const f of fails) console.error('  x', f);
  process.exit(1);
}
console.log('OK -- real sql.js apply: every table/column attack throws a stable code with ZERO mutation; ' +
  'control-plane data untouched; the payload-column poisoning HoL DoS is reproduced (client refuses, cursor stuck).');

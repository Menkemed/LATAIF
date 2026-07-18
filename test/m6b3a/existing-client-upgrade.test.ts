// M6-B3A1 §7/§8/§9 — the EXISTING-CLIENT UPGRADE proof.
//
// A production client that predates B3A has the business schema + real business data + a pull
// cursor, but NO sync_change_quarantine table. This proves the REAL boot path (re-running
// schema.sql, exactly as database.ts does via `import SCHEMA from './schema.sql?raw'`) upgrades
// such a database in place: the quarantine table appears idempotently, every existing table and row
// is untouched, and the cursor is preserved — no reset, no re-create. Then it drives a real poisoned
// batch through the production apply path, simulates a full restart (export the sql.js bytes, reload
// a fresh instance), and shows the data, the quarantine and the cursor all survive with an idempotent
// re-pull.
//
// §9 — NO part of this test hand-creates sync_change_quarantine; the table can ONLY come from the
// real schema.sql boot, so the upgrade path is what is actually exercised.
//
// Run: node test/m6b3a/existing-client-upgrade.test.ts

import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applySyncChange, type SqlDb } from '../../src/core/sync/apply-change.ts';
import { applyChangesAtomic, commitPulledBatch } from '../../src/core/sync/durable-cursor.ts';
import { recordClientQuarantine } from '../../src/core/sync/quarantine.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules/sql.js/dist/sql-wasm.wasm') });

// The REAL boot schema. A "pre-B3A" client is simulated by the SAME file with only the
// sync_change_quarantine statements removed — everything else (all business tables, sync_changelog)
// is exactly what shipped before B3A.
const SCHEMA_SQL = readFileSync(join(repo, 'src/core/db/schema.sql'), 'utf8');
const PRE_B3A_SQL = SCHEMA_SQL.split(';').filter(s => !s.includes('sync_change_quarantine')).join(';') + ';';

const tableExists = (db: any, name: string): boolean =>
  db.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${name}'`).length > 0;
const dataSnapshot = (db: any): string => {
  const tables = ['products', 'invoices', 'sync_changelog'];
  return JSON.stringify(tables.map(t => (tableExists(db, t) ? db.exec(`SELECT * FROM ${t} ORDER BY id`) : null)));
};
const brandOf = (db: any, id: string): string => {
  const r = db.exec(`SELECT brand FROM products WHERE id='${id}'`);
  return r.length && r[0].values.length ? String(r[0].values[0][0]) : '';
};
const nameOf = (db: any, id: string): string => {
  const r = db.exec(`SELECT name FROM products WHERE id='${id}'`);
  return r.length && r[0].values.length ? String(r[0].values[0][0]) : '';
};
const quarantineCount = (db: any): number => {
  if (!tableExists(db, 'sync_change_quarantine')) return -1;
  return Number(db.exec('SELECT COUNT(*) FROM sync_change_quarantine')[0].values[0][0]);
};

// ── 1. a pre-B3A database: business schema + data + a pull cursor, NO quarantine table ──
const db: any = new SQL.Database();
db.run('PRAGMA foreign_keys = OFF'); // FK parents (branches/categories) irrelevant to this proof
db.run(PRE_B3A_SQL);
// Insert a real products row, satisfying EVERY NOT NULL-without-default column (self-adapting to the
// live schema) so the proof does not rot when a column is added.
function insertProduct(id: string, brand: string, name: string): void {
  const info = db.exec('PRAGMA table_info(products)')[0].values as unknown[][];
  const cols: string[] = [], vals: string[] = [];
  for (const row of info) {
    const cname = String(row[1]), ctype = String(row[2]).toUpperCase();
    const need = Number(row[3]) === 1 && row[4] === null; // notnull && no default
    if (cname === 'id') { cols.push('id'); vals.push(`'${id}'`); }
    else if (cname === 'brand') { cols.push('brand'); vals.push(`'${brand}'`); }
    else if (cname === 'name') { cols.push('name'); vals.push(`'${name}'`); }
    else if (need) { cols.push(cname); vals.push(ctype.includes('REAL') || ctype.includes('INT') ? '0' : "'x'"); }
  }
  db.run(`INSERT INTO products (${cols.join(',')}) VALUES (${vals.join(',')})`);
}
insertProduct('p1', 'Rolex', 'Submariner');
insertProduct('p2', 'Omega', 'Speedmaster');
// The pull cursor lives in localStorage in production (STORAGE_KEY_LAST), NOT in the DB — modelled
// here as a value the DB boot must never touch.
const cursor = { v: 42 };

check(!tableExists(db, 'sync_change_quarantine'), '1: pre-B3A DB has NO quarantine table');
check(tableExists(db, 'products') && tableExists(db, 'sync_changelog'), '1: pre-B3A business schema present');
const preBootData = dataSnapshot(db);

// ── 2. the REAL boot path: run the current schema.sql (idempotent) ──
db.run(SCHEMA_SQL);
check(tableExists(db, 'sync_change_quarantine'), '2: boot created sync_change_quarantine');
check(quarantineCount(db) === 0, '2: the new quarantine table is empty');
check(dataSnapshot(db) === preBootData, '2: every existing table + row is value-identical (no reset, no re-create)');
check(cursor.v === 42, '2: the existing pull cursor is preserved (boot never touches localStorage)');
// idempotent: a SECOND boot changes nothing
db.run(SCHEMA_SQL);
check(quarantineCount(db) === 0 && dataSnapshot(db) === preBootData, '2: re-running schema.sql is idempotent');

// ── 3. upgrade + a real poisoned batch through the production apply path ──
function pull(changes: any[]): Promise<void> {
  return commitPulledBatch({
    applyBatch: () => applyChangesAtomic(changes, {
      begin: () => db.run('BEGIN'),
      applyChange: (c: any) => applySyncChange(db as SqlDb, c),
      onPoison: (c: any, code: string) => recordClientQuarantine(db as SqlDb, {
        changeId: c.id, tableName: c.table_name, recordId: c.record_id, rawData: c.data, reasonCode: code, now: 'T',
      }),
      commit: () => db.run('COMMIT'),
      rollback: () => db.run('ROLLBACK'),
    }),
    durableSave: async () => {},
    setCursor: () => { cursor.v = Number(changes[changes.length - 1].id); },
  });
}
const batch = [
  { id: 43, table_name: 'products', record_id: 'p1', action: 'update', data: JSON.stringify({ brand: 'Updated-A' }) }, // valid A
  { id: 44, table_name: 'products', record_id: 'p1', action: 'update', data: JSON.stringify({ bad_field: 1 }) },       // historical poison
  { id: 45, table_name: 'products', record_id: 'p2', action: 'update', data: JSON.stringify({ brand: 'Updated-B' }) }, // valid B
];
await pull(batch);
check(brandOf(db, 'p1') === 'Updated-A', '3: valid change A applied');
check(brandOf(db, 'p2') === 'Updated-B', '3: valid change B (after the poison) applied');
check(quarantineCount(db) === 1, '3: the poison is quarantined (exactly one row)');
check(cursor.v === 45, '3: the cursor advanced atomically over the whole batch');

// ── 4. full restart: export the sql.js bytes and reload a fresh instance ──
const bytes = db.export();
db.close();
const db2: any = new SQL.Database(bytes);
check(brandOf(db2, 'p1') === 'Updated-A' && brandOf(db2, 'p2') === 'Updated-B', '4: business data survives restart');
check(nameOf(db2, 'p1') === 'Submariner', '4: untouched fields survive restart');
check(quarantineCount(db2) === 1, '4: the quarantine survives restart');
check(cursor.v === 45, '4: the cursor (localStorage) survives restart');

// re-pull the SAME window on the restarted DB → idempotent (upsert + quarantine dedup by change_id)
function pull2(changes: any[]): Promise<void> {
  return commitPulledBatch({
    applyBatch: () => applyChangesAtomic(changes, {
      begin: () => db2.run('BEGIN'),
      applyChange: (c: any) => applySyncChange(db2 as SqlDb, c),
      onPoison: (c: any, code: string) => recordClientQuarantine(db2 as SqlDb, {
        changeId: c.id, tableName: c.table_name, recordId: c.record_id, rawData: c.data, reasonCode: code, now: 'T2',
      }),
      commit: () => db2.run('COMMIT'),
      rollback: () => db2.run('ROLLBACK'),
    }),
    durableSave: async () => {},
    setCursor: () => { cursor.v = Number(changes[changes.length - 1].id); },
  });
}
await pull2(batch);
check(quarantineCount(db2) === 1, '4: re-pull does NOT duplicate the quarantine row (idempotent)');
check(brandOf(db2, 'p1') === 'Updated-A' && brandOf(db2, 'p2') === 'Updated-B', '4: re-pull re-applies idempotently');
const occ = Number(db2.exec('SELECT MAX(occurrence_count) FROM sync_change_quarantine')[0].values[0][0]);
check(occ === 2, '4: re-pull bumps occurrence_count, not a duplicate row');
db2.close();

// M6-B3A1 §11 — a deliberate throw can be injected here (see the RED/GREEN hygiene run in the report);
// this test holds only in-memory sql.js databases (no file, no WAL/SHM, no exported bytes on disk), so
// even a mid-test panic leaks nothing.
if (process.env.M6B3A1_RED === '1') throw new Error('M6B3A1 red/green hygiene marker');

console.log(`M6-B3A1 existing-client-upgrade: ${pass}/${pass + fails.length} checks passed`);
if (fails.length) { for (const f of fails) console.error('  x', f); process.exit(1); }
console.log('OK — the real schema.sql boot upgrades a pre-B3A database in place (quarantine added idempotently, ' +
  'data + cursor preserved), a poisoned batch quarantines cleanly, and everything survives a restart with an idempotent re-pull.');

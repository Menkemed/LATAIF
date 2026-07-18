// M6-B3A §14 — this slice must NOT accidentally introduce a new LWW/revision/CAS semantics for a
// FULLY VALID business change. applyUpsert stays exactly as before B3A: an unconditional
// last-writer-BY-ARRIVAL overwrite — no base_revision, no server CAS, no conflict object. A stale
// (out-of-order) valid update still overwrites the newer one; a valid change is applied normally
// and NEVER quarantined. This is the tripwire for M6_STALE_REPLAY_OPEN: if a future edit added
// revision gating to the apply path, the "stale wins on arrival" assertion below would go red.
//
// Run: node test/m6b3a/stale-replay-unchanged.test.ts

import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applySyncChange, changeContractViolation, type SqlDb } from '../../src/core/sync/apply-change.ts';
import { applyChangesAtomic, commitPulledBatch } from '../../src/core/sync/durable-cursor.ts';
import { recordClientQuarantine } from '../../src/core/sync/quarantine.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs({ locateFile: () => join(here, '../../node_modules/sql.js/dist/sql-wasm.wasm') });

const db: any = new SQL.Database();
// A products table WITH a `version` column — so we can prove version is treated as an ordinary
// overwritten field, NOT consulted as a CAS/revision gate.
db.run('CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT, version TEXT)');
db.run(`CREATE TABLE sync_change_quarantine (
  quarantine_id TEXT PRIMARY KEY, change_id INTEGER, source TEXT NOT NULL, table_name_redacted TEXT NOT NULL,
  record_id_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, reason_code TEXT NOT NULL, first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open',
  resolution_note TEXT, resolved_at TEXT)`);

const chg = (id: number, action: string, data: Record<string, unknown>) =>
  ({ id, table_name: 'products', record_id: 'p1', action, data: JSON.stringify(data) });

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
    setCursor: () => {},
  });
}
const brandOf = () => String(db.exec("SELECT brand FROM products WHERE id='p1'")[0].values[0][0]);
const versionOf = () => String(db.exec("SELECT version FROM products WHERE id='p1'")[0].values[0][0]);
const quarantineCount = () => Number(db.exec('SELECT COUNT(*) FROM sync_change_quarantine')[0].values[0][0]);

// 1. Pre-flight: a fully valid change satisfies the contract (verdict null) — it is NOT poison.
check(changeContractViolation('products', 'update', JSON.stringify({ brand: 'X', version: '5' })) === null,
  'a fully valid change passes the contract (not quarantined)');

// 2. Apply a "newer" change (version 5), then a STALE one (version 2). Last arrival wins,
//    unconditionally — no revision/CAS gate rejects or reorders it.
await pull([chg(1, 'insert', { id: 'p1', brand: 'New', version: '5' })]);
check(brandOf() === 'New' && versionOf() === '5', 'the first valid change applied');

await pull([chg(2, 'update', { brand: 'Stale', version: '2' })]); // lower version arrives later
check(brandOf() === 'Stale', '§14: a STALE valid update still overwrites — last-writer-by-arrival, no CAS');
check(versionOf() === '2', '§14: version is an ordinary overwritten field, NOT a revision gate');

// 3. And none of these valid changes were ever quarantined.
check(quarantineCount() === 0, '§14: valid changes are applied, never quarantined');

db.close();

console.log(`M6-B3A stale-replay-unchanged: ${pass}/${pass + fails.length} checks passed`);
if (fails.length) { for (const f of fails) console.error('  x', f); process.exit(1); }
console.log('OK — a valid change is unconditional last-writer-by-arrival (no base_revision, no CAS, no conflict object); ' +
  'M6_STALE_REPLAY_OPEN behavior is unchanged by this slice.');

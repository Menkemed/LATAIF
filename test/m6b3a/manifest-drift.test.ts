// M6-B3A §3 — the manifest DRIFT GATE.
//
// `sync-business-schema.json` is the canonical SSOT the Rust server and the TS client both read.
// This gate keeps it honest against the LIVE codebase, so it can never silently rot:
//   1. Table set  — re-derives the actually-synced tables from every track*() call site under src/
//      and asserts the manifest's table set is EXACTLY that (a new synced table, or a removed one,
//      breaks the gate until the manifest is regenerated).
//   2. Field set  — re-derives every table's column set from the live frontend schema (schema.sql +
//      database.ts + operations/migration.ts, CREATE TABLE + ALTER ADD COLUMN) and asserts the
//      manifest's allowed_fields matches it EXACTLY (a new migration column breaks the gate).
//   3. Ground truth — builds the real schema in sql.js and asserts every runtime column (what
//      SELECT * actually emits, i.e. what trackChange snapshots) is in the manifest — so no valid
//      sync is ever wrongly quarantined by an under-specified allowlist.
//   4. Safety — every manifest table/field is a canonical identifier, no manifest table is a
//      control-plane/internal denylist entry, every table's record id is `id`.
//
// Run: node test/m6b3a/manifest-drift.test.ts

import initSqlJs from 'sql.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import MANIFEST from '../../src/core/sync/sync-business-schema.json' with { type: 'json' };
import { isValidSyncIdentifier, isControlPlaneTable, changeContractViolation } from '../../src/core/sync/apply-change.ts';

let pass = 0;
const fails: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fails.push(m); };
const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

// ── the manifest under test ──
const manifest = MANIFEST as unknown as {
  schema_version: number;
  limits: { max_payload_bytes: number; max_fields: number };
  tables: Record<string, { allowed_operations: string[]; record_id_field: string; allowed_fields: string[] }>;
};
const manifestTables = new Set(Object.keys(manifest.tables));

// ── 1. re-derive the synced-table set from every track*() call site under src/ ──
const synced = new Set<string>();
for (const rel of readdirSync(join(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
  if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;
  const src = readFileSync(join(repo, 'src', rel), 'utf8');
  for (const m of src.matchAll(/track(?:Change|Insert|Update|Delete)\('([a-z_]+)'/g)) {
    if (m[1] !== 'delete') synced.add(m[1]); // 'delete' only appears in a comment; never a table
  }
}
check(synced.size >= 40, `found a plausible synced-table set (${synced.size})`);
check(setEq(manifestTables, synced),
  `manifest tables == actually-synced tables. only-in-manifest=[${[...manifestTables].filter(t => !synced.has(t))}] ` +
  `only-in-src=[${[...synced].filter(t => !manifestTables.has(t))}]`);

// ── 2. re-derive columns from the live schema sources (mirror of the generator) ──
const schemaSrc = read('src/core/db/schema.sql') + '\n' + read('src/core/db/database.ts') + '\n' + read('src/core/operations/migration.ts');
function stripComments(s: string) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, ''); }
function splitTop(bodyRaw: string): string[] {
  const body = stripComments(bodyRaw);
  const parts: string[] = []; let depth = 0, cur = '', q = '';
  for (const ch of body) {
    if (q) { cur += ch; if (ch === q) q = ''; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; }
    else if (ch === '(') { depth++; cur += ch; }
    else if (ch === ')') { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
const CONSTRAINT = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;
const cols = new Map<string, Set<string>>();
for (const m of schemaSrc.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([A-Za-z0-9_]+)\s*\(/gi)) {
  const name = m[1];
  let i = (m.index ?? 0) + m[0].length - 1, depth = 0, start = -1;
  for (; i < schemaSrc.length; i++) {
    if (schemaSrc[i] === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (schemaSrc[i] === ')') { depth--; if (depth === 0) break; }
  }
  const set = cols.get(name) ?? new Set<string>();
  for (const line of splitTop(schemaSrc.slice(start, i))) {
    const l = line.trim().replace(/^["'`[]/, '');
    if (!l || CONSTRAINT.test(l)) continue;
    const cm = l.match(/^([A-Za-z0-9_]+)/);
    if (cm) set.add(cm[1]);
  }
  cols.set(name, set);
}
for (const m of schemaSrc.matchAll(/ALTER TABLE\s+([A-Za-z0-9_]+)\s+ADD COLUMN\s+([A-Za-z0-9_]+)/gi)) {
  const set = cols.get(m[1]) ?? new Set<string>();
  set.add(m[2]);
  cols.set(m[1], set);
}
for (const t of manifestTables) {
  const extracted = cols.get(t);
  const declared = new Set(manifest.tables[t].allowed_fields);
  check(!!extracted && setEq(declared, extracted!),
    `${t}: manifest allowed_fields == live schema columns. ` +
    `only-in-manifest=[${[...declared].filter(c => !extracted?.has(c))}] ` +
    `only-in-schema=[${extracted ? [...extracted].filter(c => !declared.has(c)) : 'MISSING'}]`);
}

// ── 3. ground truth: every runtime column (what SELECT * emits) is in the manifest ──
const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules/sql.js/dist/sql-wasm.wasm') });
const db = new SQL.Database();
try { db.run(read('src/core/db/schema.sql')); } catch { /* base */ }
// create the non-core tables + apply every ALTER (tolerating dup-column), so PRAGMA is complete
for (const m of schemaSrc.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+[A-Za-z0-9_]+\s*\(/gi)) {
  let i = (m.index ?? 0) + m[0].length - 1, depth = 0;
  for (; i < schemaSrc.length; i++) { if (schemaSrc[i] === '(') depth++; else if (schemaSrc[i] === ')') { depth--; if (depth === 0) { i++; break; } } }
  try { db.run(schemaSrc.slice(m.index, i)); } catch { /* exists */ }
}
for (const m of schemaSrc.matchAll(/ALTER TABLE\s+([A-Za-z0-9_]+)\s+ADD COLUMN\s+([A-Za-z0-9_]+)([^`'"]*)/gi)) {
  try { db.run(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]}${m[3]}`.trim()); } catch { /* dup or truncated default */ }
}
for (const t of manifestTables) {
  const r = db.exec(`PRAGMA table_info(${t})`);
  const runtime = r.length ? r[0].values.map(v => String(v[1])) : [];
  const declared = new Set(manifest.tables[t].allowed_fields);
  const missing = runtime.filter(c => !declared.has(c));
  check(runtime.length > 0, `${t}: exists at runtime`);
  check(missing.length === 0, `${t}: every runtime column is allow-listed (missing: [${missing}])`);
}
db.close();

// ── 4. safety invariants ──
check(manifest.schema_version >= 1, 'schema_version present');
check(manifest.limits.max_payload_bytes >= 1_000_000, 'a generous payload limit');
for (const t of manifestTables) {
  check(isValidSyncIdentifier(t), `${t}: table is a canonical identifier`);
  check(!isControlPlaneTable(t), `${t}: not a control-plane/internal denylist entry`);
  const c = manifest.tables[t];
  check(c.record_id_field === 'id', `${t}: record_id_field is id`);
  check(c.allowed_fields.includes('id'), `${t}: allowed_fields includes id`);
  for (const f of c.allowed_fields) check(isValidSyncIdentifier(f), `${t}.${f}: field is a canonical identifier`);
  for (const op of c.allowed_operations) check(['insert', 'update', 'delete'].includes(op), `${t}: op ${op} valid`);
}

// ── 4b. Operation matrix (M6-B3A1 §2): the manifest's allowed_operations per table must EQUAL the
//    exact set of operations PRODUCTION writers emit — no blanket insert/update/delete, and no op a
//    writer produces missing. Re-derived from track* call sites (bidirectional drift). ──
const wOps = new Map<string, Set<string>>();
const addOp = (t: string, op: string) => { if (!wOps.has(t)) wOps.set(t, new Set()); wOps.get(t)!.add(op); };
const stripLine = (s: string) => s.split('\n').map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; }).join('\n');
for (const rel of readdirSync(join(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
  if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;
  const s = stripLine(readFileSync(join(repo, 'src', rel), 'utf8'));
  for (const m of s.matchAll(/trackInsert\('([a-z_]+)'/g)) addOp(m[1], 'insert');
  for (const m of s.matchAll(/trackUpdate\('([a-z_]+)'/g)) addOp(m[1], 'update');
  for (const m of s.matchAll(/trackDelete\('([a-z_]+)'/g)) addOp(m[1], 'delete');
  for (const m of s.matchAll(/trackChange\('([a-z_]+)',[^,]+,\s*'(insert|update|delete)'/g)) addOp(m[1], m[2]);
  for (const m of s.matchAll(/trackLotRow\([^,]+,\s*'(insert|update|delete)'/g)) addOp('stock_lots', m[1]);
  for (const m of s.matchAll(/trackProductRow\(([^,)]+)(?:,\s*'(insert|update|delete)')?/g)) addOp('products', m[2] || 'update');
}
// M6-B3A2 §4 — the MOBILE picture uploader is a SECOND /sync/push producer (embedded JS in
// mobile_page.rs builds change payloads directly). Its operations are part of the safe union — in
// particular a purchase_inbox INSERT the desktop never emits. Missing this is exactly the bug B3A2
// caught: B3A1 marked purchase_inbox update-only and would have quarantined every mobile inbox photo.
const mobileSrc = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');
for (const m of mobileSrc.matchAll(/table_name:\s*'([a-z_]+)',[^}]*?action:\s*'(insert|update|delete)'/g)) addOp(m[1], m[2]);
const OP_ORDER = ['insert', 'update', 'delete'];
let iC = 0, uC = 0, dC = 0;
for (const t of manifestTables) {
  const declared = manifest.tables[t].allowed_operations;
  const derived = OP_ORDER.filter(o => wOps.get(t)?.has(o));
  check(derived.length > 0, `${t}: has at least one production writer operation`);
  check(JSON.stringify([...declared].sort()) === JSON.stringify([...derived].sort()),
    `${t}: manifest allowed_operations [${declared}] == production writers [${derived}]`);
  if (declared.includes('insert')) iC++;
  if (declared.includes('update')) uC++;
  if (declared.includes('delete')) dC++;
}
check(iC === 50 && uC === 36 && dC === 37, `operation counts insert=${iC} update=${uC} delete=${dC} (expected 50/36/37 — incl. the mobile purchase_inbox insert)`);

// ── 5. Rust/TS semantic parity: the SAME shared fixture the Rust test runs. Both sides must map
//    each vector to the same verdict → transitively, Rust and TS agree byte-for-byte. ──
const vectors = (JSON.parse(read('test/fixtures/sync-payload-vectors.json')) as {
  vectors: { table: string; action: string; data: string; expect: string | null }[];
}).vectors;
check(vectors.length >= 20, `a non-trivial shared vector set (${vectors.length})`);
for (const v of vectors) {
  const got = changeContractViolation(v.table, v.action, v.data);
  check(got === v.expect, `TS vector ${v.table}/${v.action} => expected ${v.expect}, got ${got}`);
}

console.log(`M6-B3A manifest-drift: ${pass}/${pass + fails.length} checks passed ` +
  `(${manifestTables.size} tables, ${[...manifestTables].reduce((n, t) => n + manifest.tables[t].allowed_fields.length, 0)} fields)`);
if (fails.length) { for (const f of fails) console.error('  x', f); process.exit(1); }
console.log('OK — the manifest matches the live synced-table set, the live schema columns, and runtime truth; all canonical; none forbidden.');

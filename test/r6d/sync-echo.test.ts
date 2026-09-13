// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — das Sync-Echo erhöht keine Fassung mehr.
// Run: node test/r6d/sync-echo.test.ts
//
// Befund aus dem Two-App-Lauf: der Primary spielt die Änderungen, die er selbst hochgeschoben hat, beim
// nächsten Pull (30-s-Takt) wieder ein. `applyUpsert` schrieb dabei ein UPDATE mit denselben Werten — und
// die Fassungs-Trigger zählten +1. Wer den Datensatz davor geöffnet hatte, bekam `RECORD_CHANGED`, obwohl
// niemand etwas geändert hatte. Hier: echte Datenbank, echte Migrationen, echte Trigger, echter Upsert.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { applyUpsert } = await import('../../src/core/sync/apply-change.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-13T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    data[name] = /INT|REAL|NUM/.test(String(c.type || '').toUpperCase()) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}
const MIGRATIONS = (() => {
  const d = src('src/core/db/database.ts');
  const a = d.indexOf('const migrations: string[] = [');
  return [...d.slice(a, d.indexOf('\n  ];', a)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
})();
const db = new SQL.Database() as unknown as Db;
db.run(src('src/core/db/schema.sql'));
for (const s of MIGRATIONS) { try { db.run(s); } catch { /* schon da */ } }
db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('b1','t1','Haupt',?,?)", [NOW, NOW]);

const rev = (t: string, id: string): number => Number(rows(db, `SELECT revision FROM ${t} WHERE id = ?`, [id])[0]?.revision);
const snapshot = (t: string, id: string): Record<string, unknown> => rows(db, `SELECT * FROM ${t} WHERE id = ?`, [id])[0];

// §1 — die sieben R6D-Tabellen: das Echo einer Zeile ändert die Fassung nicht
// [Tabelle, Zeile, eine echte Änderung]
for (const [table, values, change] of [
  ['debts', { id: 'd1', branch_id: 'b1', direction: 'we_lend', counterparty: 'X', amount: 100, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW }, { amount: 101 }],
  ['expenses', { id: 'e1', branch_id: 'b1', category: 'Rent', amount: 50, paid_amount: 0, status: 'PENDING', created_at: NOW, updated_at: NOW }, { amount: 51 }],
  ['purchases', { id: 'pu1', branch_id: 'b1', status: 'ORDERED', total_amount: 10, paid_amount: 0, remaining_amount: 10, created_at: NOW, updated_at: NOW }, { remaining_amount: 9 }],
  ['gold_payables', { id: 'g1', branch_id: 'b1', supplier_id: 's1', weight_grams: 10, karat: '21K', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW }, { fulfilled_grams: 2 }],
  ['customer_gold_credits', { id: 'c1', branch_id: 'b1', customer_id: 'k1', weight_grams: 5, karat: '18K', fulfilled_grams: 0, status: 'OPEN', created_at: NOW, updated_at: NOW }, { fulfilled_grams: 1 }],
  ['precious_metals', { id: 'm1', branch_id: 'b1', metal_type: 'gold', karat: '21K', weight_grams: 12.5, status: 'in_stock', created_at: NOW, updated_at: NOW }, { weight_grams: 13 }],
  ['recurring_expense_templates', { id: 't1', branch_id: 'b1', category: 'Rent', amount: 50, day_of_month: 1, start_date: '2026-01-01', active: 1, created_at: NOW, updated_at: NOW }, { amount: 55 }],
] as Array<[string, Record<string, unknown>, Record<string, unknown>]>) {
  insert(db, table, values);
  const id = String(values.id);
  // Eine eigene Änderung am Primary: der Trigger zählt 1 → 2.
  db.run(`UPDATE ${table} SET id = id WHERE id = ?`, [id]);
  const vorher = rev(table, id);
  const echo = snapshot(table, id);
  applyUpsert(db as never, table, id, echo);
  applyUpsert(db as never, table, id, echo);
  ok(vorher === 2 && rev(table, id) === 2, `ECHO ${table}: das eigene Echo (zweimal) lässt die Fassung bei ${vorher} (${rev(table, id)})`);
  // Eine echte Abweichung schreibt wie bisher — und die Fassung steigt.
  applyUpsert(db as never, table, id, { ...echo, ...change });
  const [k, v] = Object.entries(change)[0];
  ok(rev(table, id) === 3 && Number(snapshot(table, id)[k]) === Number(v),
    `ECHO ${table}: eine echte Änderung wird geschrieben und zählt die Fassung (${rev(table, id)})`);
}

// §2 — Rechnung/Auftrag (seit C3D/C3E betroffen): auch das Echo einer Kindzeile zählt den Kopf nicht mehr
{
  insert(db, 'orders', { id: 'o1', branch_id: 'b1', order_number: 'O-1', status: 'pending', created_at: NOW, updated_at: NOW });
  insert(db, 'order_lines', { id: 'ol1', order_id: 'o1', description: 'Gold', status: 'ARRIVED', created_at: NOW, updated_at: NOW });
  const vorher = rev('orders', 'o1');
  applyUpsert(db as never, 'order_lines', 'ol1', snapshot('order_lines', 'ol1'));
  ok(rev('orders', 'o1') === vorher, `ECHO order_lines: das Echo der Zeile zählt den Auftrag nicht hoch (${vorher} → ${rev('orders', 'o1')})`);
  applyUpsert(db as never, 'order_lines', 'ol1', { ...snapshot('order_lines', 'ol1'), description: 'Gold 21K' });
  ok(rev('orders', 'o1') === vorher + 1, 'ECHO order_lines: eine echte Zeilenänderung zählt den Auftrag wie bisher');
}

// §3 — die Vergleichsregel ist vorsichtig
{
  insert(db, 'debts', { id: 'd2', branch_id: 'b1', direction: 'we_lend', counterparty: 'Y', amount: 100, source: 'cash', status: 'OPEN', notes: null, created_at: NOW, updated_at: NOW });
  const r0 = rev('debts', 'd2');
  applyUpsert(db as never, 'debts', 'd2', { amount: '100', notes: null });
  ok(rev('debts', 'd2') === r0, 'VERGLEICH Zahl und Zahltext, NULL und null gelten als gleich → kein Schreiben');
  applyUpsert(db as never, 'debts', 'd2', { notes: '' });
  ok(rev('debts', 'd2') === r0 + 1 && String(snapshot('debts', 'd2').notes) === '', 'VERGLEICH NULL und Leertext sind NICHT gleich → wird geschrieben');
  applyUpsert(db as never, 'debts', 'd-neu', { branch_id: 'b1', direction: 'we_lend', counterparty: 'Z', amount: 1, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW });
  ok(rows(db, "SELECT id FROM debts WHERE id = 'd-neu'").length === 1, 'VERGLEICH eine neue Zeile wird wie bisher eingefügt');
}

// §4 — der Vertrag: echte Fremdänderungen, Reihenfolge, Löschen, Metadaten
{
  const { applySyncChange } = await import('../../src/core/sync/apply-change.ts');
  insert(db, 'debts', { id: 'd3', branch_id: 'b1', direction: 'we_lend', counterparty: 'R', amount: 100, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW });
  const alt = snapshot('debts', 'd3');
  // Eine echte Fremdänderung mit neuer Fassung (der andere Rechner hat 3× geändert): angewendet, Fassung übernommen.
  applyUpsert(db as never, 'debts', 'd3', { ...alt, amount: 120, revision: 4, updated_at: '2026-09-13T11:00:00.000Z' });
  ok(Number(snapshot('debts', 'd3').amount) === 120 && rev('debts', 'd3') === 4, `VERTRAG eine Fremdänderung mit neuer Fassung wird angewendet, die Fassung übernommen (${rev('debts', 'd3')})`);
  // Nur die Fassung neu (alle Felder sonst gleich): KEIN No-op — die Fassung ist eine Spalte wie jede andere.
  applyUpsert(db as never, 'debts', 'd3', { ...snapshot('debts', 'd3'), revision: 7 });
  ok(rev('debts', 'd3') === 7, `VERTRAG eine abweichende Fassung allein wird nicht übersprungen (${rev('debts', 'd3')})`);
  // Nur der Zeitstempel neu: ebenfalls kein No-op — Metadaten zählen als Abweichung.
  applyUpsert(db as never, 'debts', 'd3', { ...snapshot('debts', 'd3'), updated_at: '2026-09-13T12:00:00.000Z' });
  ok(String(snapshot('debts', 'd3').updated_at) === '2026-09-13T12:00:00.000Z' && rev('debts', 'd3') === 8,
    'VERTRAG ein neuer Zeitstempel ist eine Abweichung — geschrieben, und der Trigger zählt wie bisher');
  // Alt / außer der Reihe: unverändert „letzter Schreiber nach Ankunft" (M6-B3A stale-replay-unchanged).
  applyUpsert(db as never, 'debts', 'd3', alt);
  ok(Number(snapshot('debts', 'd3').amount) === 100 && rev('debts', 'd3') === Number(alt.revision),
    'VERTRAG ein älterer Stand wird wie bisher angewendet — der Echo-Schutz ändert die Reihenfolge-Regel nicht');
  // Der volle Dispatcher: Echo über applySyncChange (update) → kein Schreiben; Löschen → weg, wie bisher.
  const r0 = rev('debts', 'd3');
  applySyncChange(db as never, { table_name: 'debts', record_id: 'd3', action: 'update', data: JSON.stringify(snapshot('debts', 'd3')) });
  ok(rev('debts', 'd3') === r0, 'VERTRAG über den Dispatcher: das Echo eines Updates schreibt nicht');
  applySyncChange(db as never, { table_name: 'debts', record_id: 'd3', action: 'delete', data: '{}' });
  ok(rows(db, "SELECT id FROM debts WHERE id = 'd3'").length === 0, 'VERTRAG Löschen läuft unverändert');
}
console.log('CENTRAL_UI_R6D_SYNC_ECHO_CONTRACT_PINNED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d sync echo: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_SYNC_ECHO_NO_REVISION_BUMP_PROVED');

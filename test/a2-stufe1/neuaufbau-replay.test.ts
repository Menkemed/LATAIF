// ════════════════════════════════════════════════════════════════════════════
// A2-RECOVERY — Cursor-Verlust und Neuaufbau mit der Konstellation aus dem echten Bestand:
// eine alte Reparaturzeile (Position 2), später gelöscht und durch eine neue auf DERSELBEN Position ersetzt
// (#3944/#3951 am Primary), dazu ein fremder Eintrag früh in der Server-Historie (wie #918–#974) und neuere
// Werte NACH dem Konflikt. Echtes Schema (schema.sql + Migrationen), echter Startpunkt (`resolveCursorStart`),
// echte Stapel-Schleife (`applyChangesAtomic`) mit Quarantäne wie im Pull.
//
// Vorher: der Konflikt galt als „vorübergehend" → ganzer Stapel zurück, Abgleich hängt für immer, und die schon
// wieder eingespielten ÄLTEREN Stände bleiben stehen (Datenverlust, auf einer Kopie des echten Bestands
// nachgestellt). Jetzt: der eine Eintrag geht in Quarantäne, der Rest läuft, der Bestand ist wie vorher.
// Run: node test/a2-stufe1/neuaufbau-replay.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { applySyncChange, isUniqueConstraintFailure, SYNC_UNIQUE_CONFLICT, applyUpsert } from '../../src/core/sync/apply-change.ts';
import { applyChangesAtomic } from '../../src/core/sync/durable-cursor.ts';
import { CURSOR_DDL, resolveCursorStart } from '../../src/core/sync/cursor-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const SQL = await initSqlJs({ locateFile: () => join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

type Db = { run(s: string, p?: unknown[]): void; exec(s: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };
const src = (p: string) => readFileSync(join(repo, p), 'utf8');
function migrations(): string[] {
  const d = src('src/core/db/database.ts');
  const a = d.indexOf('const migrations: string[] = [');
  return [...d.slice(a, d.indexOf('\n  ];', a)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIG = migrations();
const NOW = '2026-11-01T00:00:00.000Z';
const FP = 'abcdefabcdefabcdefabcdefabcdef12';

const row = (o: Record<string, unknown>) => JSON.stringify(o);
const line = (id: string, pos: number, created: string, extra: Record<string, unknown> = {}) => row({
  id, branch_id: 'branch-main', repair_id: 'rep-1', position: pos, work_type: 'service', description: `Arbeit ${id}`,
  cost_amount: 10, status: 'open', created_at: created, updated_at: created, ...extra,
});
const product = (price: number, status: string, updated: string) => row({
  id: 'p1', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Rolex', name: 'Datejust', sku: 'SKU-1', quantity: 1,
  condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: price,
  stock_status: status, tax_scheme: 'VAT_10', images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: updated,
});

/** Die Historie in Server-Reihenfolge. Eigen = vom Primary gesendet (steht in seinem Ausgangskorb). */
const HIST: Array<{ eigen: boolean; table_name: string; record_id: string; action: string; data: string }> = [
  { eigen: true, table_name: 'products', record_id: 'p1', action: 'insert', data: product(150, 'in_stock', '2026-10-01T00:00:00.000Z') },
  { eigen: false, table_name: 'products', record_id: 'p9', action: 'insert', data: row({ id: 'p9', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'Seamaster', sku: 'SKU-9', quantity: 1, condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 50, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'VAT_10', images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW }) },
  { eigen: true, table_name: 'products', record_id: 'p1', action: 'update', data: product(160, 'with_agent', '2026-10-12T00:00:00.000Z') },
  { eigen: true, table_name: 'repair_lines', record_id: 'L1', action: 'insert', data: line('L1', 1, '2026-11-02T10:00:00.000Z') },
  { eigen: true, table_name: 'repair_lines', record_id: 'L2alt', action: 'insert', data: line('L2alt', 2, '2026-11-12T11:56:00.000Z') },
  { eigen: true, table_name: 'repair_lines', record_id: 'L2alt', action: 'delete', data: '{}' },
  { eigen: true, table_name: 'repair_lines', record_id: 'L2neu', action: 'insert', data: line('L2neu', 2, '2026-11-12T12:17:00.000Z') },
  { eigen: true, table_name: 'products', record_id: 'p1', action: 'update', data: product(200, 'sold', '2026-11-14T00:00:00.000Z') },
];

/** Zeile mit allen Pflichtspalten (NOT NULL ohne Vorgabe) — Zahlen 0, Zeitpunkte NOW, sonst ''. */
function einfuegen(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0].values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of info) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => info.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function welt(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const m of MIG) { try { db.run(m); } catch { /* schon da */ } }
  db.run(CURSOR_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
          VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  einfuegen(db, 'repairs', { id: 'rep-1', branch_id: 'branch-main', customer_id: 'cust-1', status: 'in_progress', created_at: NOW, updated_at: NOW });
  // Der HEUTIGE Stand = die ganze Historie schon angewandt (der Primary war vor dem Cursor-Verlust aktuell).
  for (const h of HIST) applySyncChange(db as never, h);
  // Eigener Ausgangskorb: genau die eigenen Einträge, gesendet.
  for (const h of HIST.filter((x) => x.eigen)) {
    db.run("INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,'branch-main',?,?,1,?)",
      [h.table_name, h.record_id, h.action, h.data, NOW]);
  }
  return db;
}
const bestand = (db: Db) => JSON.stringify([
  db.exec('SELECT id, position, created_at FROM repair_lines ORDER BY id')[0]?.values ?? [],
  db.exec('SELECT id, planned_sale_price, stock_status, updated_at FROM products ORDER BY id')[0]?.values ?? [],
]);

/** Der Pull nach Cursor-Verlust: Startpunkt, dann Stapel zu `groesse` mit Quarantäne wie in sync-service. */
function neuaufbau(db: Db, groesse: number): { cursor: number; quarantaene: string[]; haengt: string | null; start: unknown } {
  const server = HIST.map((h, i) => ({ id: i + 1, table_name: h.table_name, record_id: h.record_id, action: h.action, data: h.data }));
  const start = resolveCursorStart(db as never, FP, server, server.length, NOW);
  let cursor = (start as { cursor?: number }).cursor ?? 0;
  const quarantaene: string[] = [];
  let haengt: string | null = null;
  const rest = server.filter((c) => c.id > cursor);
  for (let i = 0; i < rest.length && !haengt; i += groesse) {
    const stapel = rest.slice(i, i + groesse);
    try {
      applyChangesAtomic(stapel as never, {
        begin: () => db.run('BEGIN'), commit: () => db.run('COMMIT'), rollback: () => db.run('ROLLBACK'),
        applyChange: (c) => applySyncChange(db as never, c as never),
        onPoison: (c, code) => { quarantaene.push(`${(c as { id: number }).id}:${code}`); },
      });
      cursor = stapel[stapel.length - 1].id;
    } catch (e) { haengt = String((e as Error).message).slice(0, 80); }
  }
  return { cursor, quarantaene, haengt, start };
}

// ── Gegenprobe: genau dieser Eintrag verletzt die Regel (UNIQUE(repair_id, position)) ──
{
  const db = welt();
  let msg = '';
  try { applyUpsert(db as never, 'repair_lines', 'L2alt', JSON.parse(HIST[4].data)); } catch (e) { msg = String((e as Error).message); }
  ok(isUniqueConstraintFailure(new Error(msg)) && /repair_lines/.test(msg), `Gegenprobe: die alte Zeile auf Position 2 verletzt die Regel (${msg.slice(0, 70)})`);
  ok(!isUniqueConstraintFailure(new Error('database is locked')) && !isUniqueConstraintFailure(new Error('NOT NULL constraint failed: x.y')),
    'nur diese Klasse wird zur Quarantäne — jede andere DB-Störung rollt weiter zurück');
}

// ── Neuaufbau nach Cursor-Verlust, Stapel zu 3 (der Konflikt liegt mitten in einem Stapel) ──
{
  const db = welt();
  const vorher = bestand(db);
  const r = neuaufbau(db, 3);
  ok((r.start as { kind: string }).kind === 'reconstructed' && (r.start as { cursor: number }).cursor === 1,
    `Startpunkt: eigener Anfang bis #1, ab dem fremden Eintrag wird alles erneut eingespielt (${JSON.stringify(r.start)})`);
  ok(r.haengt === null && r.cursor === HIST.length, `Neuaufbau läuft bis zum Ende durch (Cursor ${r.cursor}, hängt: ${r.haengt})`);
  ok(r.quarantaene.length === 1 && r.quarantaene[0] === `5:${SYNC_UNIQUE_CONFLICT}`, `genau der alte Eintrag in Quarantäne (${r.quarantaene.join(', ')})`);
  ok(bestand(db) === vorher, 'Bestand nach dem Neuaufbau exakt wie vorher: neue Zeile auf Position 2, neuester Preis und Status');
  const p1 = db.exec("SELECT planned_sale_price, stock_status FROM products WHERE id = 'p1'")[0].values[0];
  ok(p1[0] === 200 && p1[1] === 'sold', `jüngster Artikelstand bleibt (${JSON.stringify(p1)}) — keine Rückkehr zu „with_agent"`);
  ok(db.exec("SELECT COUNT(*) FROM products WHERE id = 'p9'")[0].values[0][0] === 1, 'der fremde gültige Eintrag ist übernommen');
}

// ── Fremde gültige Änderungen wirken weiter: neuer fremder Eintrag NACH dem Konflikt ─────────
{
  const db = welt();
  HIST.push({ eigen: false, table_name: 'customers', record_id: 'cust-1', action: 'update', data: row({ id: 'cust-1', phone: '+973 3333 4444' }) });
  const r = neuaufbau(db, 4);
  ok(r.haengt === null && db.exec("SELECT phone FROM customers WHERE id = 'cust-1'")[0].values[0][0] === '+973 3333 4444',
    'eine fremde Änderung nach dem Konflikt wird übernommen');
  HIST.pop();
}

console.log(fails.length ? `\nFAIL — a2-neuaufbau-replay: ${PASS} passed, ${fails.length} failed` : `\nPASS — a2-neuaufbau-replay: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);

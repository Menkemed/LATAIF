// ════════════════════════════════════════════════════════════════════════════
// A2-STUFE-1 — Echo-Schutz: ALTE Changelog-Einträge (mit Vektor oder `null`) können ein neueres Embedding in
// `products` nie überschreiben oder löschen — weder beim normalen Pull noch beim Cursor-Neuaufbau nach
// Cursor-Verlust. Echte Einspiel- und Cursor-Pfade (`applySyncChange`, `resolveCursorStart`), sql.js.
// Run: node test/a2-stufe1/echo-schutz.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import { applySyncChange, applyUpsert } from '../../src/core/sync/apply-change.ts';
import { CURSOR_DDL, resolveCursorStart, readCursor } from '../../src/core/sync/cursor-store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SQL = await initSqlJs({ locateFile: () => join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm') });
let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };

type Db = { run(s: string, p?: unknown[]): void; exec(s: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };
const vec = (seed: number) => JSON.stringify(Array.from({ length: 1536 }, (_, i) => Math.round(Math.sin(seed * 1000 + i) * 1e6) / 1e6));
const V_ALT = vec(1), V_NEU = vec(2);
const FP = '0123456789abcdef0123456789abcdef';

function frisch(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(`CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT, sku TEXT, name TEXT, planned_sale_price REAL,
            images TEXT DEFAULT '[]', image_hash TEXT, image_description TEXT, image_embedding TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, branch_id TEXT,
            action TEXT, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT)`);
  db.run(CURSOR_DDL);
  // Der heutige Stand: Artikel mit NEUEM Embedding (nach Weg A berechnet).
  db.run(`INSERT INTO products (id, branch_id, sku, name, planned_sale_price, image_hash, image_description, image_embedding, updated_at)
          VALUES ('p1','branch-main','SKU-1','Datejust',150,'h-neu','neu',?,'2026-11-20T00:00:00.000Z')`, [V_NEU]);
  return db;
}
const emb = (db: Db) => String(db.exec("SELECT image_embedding FROM products WHERE id = 'p1'")[0].values[0][0]);
const preis = (db: Db) => Number(db.exec("SELECT planned_sale_price FROM products WHERE id = 'p1'")[0].values[0][0]);
const zeile = (o: Record<string, unknown>) => JSON.stringify({ id: 'p1', branch_id: 'branch-main', sku: 'SKU-1', name: 'Datejust', ...o });

// ── 1) Normaler Pull: ein noch offener ALTER Eintrag kommt nach dem neuen Embedding an ─────────
{
  const db = frisch();
  applySyncChange(db as never, { table_name: 'products', record_id: 'p1', action: 'update', data: zeile({ planned_sale_price: 200, image_embedding: V_ALT }) });
  ok(emb(db) === V_NEU && preis(db) === 200, 'Pull: alter Eintrag mit Vektor — Preis wirkt wie bisher, das neuere Embedding bleibt');
  applySyncChange(db as never, { table_name: 'products', record_id: 'p1', action: 'update', data: zeile({ image_embedding: null, image_description: null }) });
  ok(emb(db) === V_NEU, 'Pull: alter Eintrag mit image_embedding = null — das Embedding wird NICHT gelöscht');
  // Ohne den Schutz (roh angewandt) hätte genau dieser Eintrag überschrieben — der Schutz trägt.
  const roh = frisch();
  applyUpsert(roh as never, 'products', 'p1', JSON.parse(zeile({ image_embedding: V_ALT })));
  ok(emb(roh) === V_ALT, 'Gegenprobe: roh angewandt hätte der alte Vektor das neue Embedding ersetzt');
  // Neuer Artikel über den Abgleich: Zeile entsteht, Embedding bleibt leer (wird lokal gerechnet), kein Fehler.
  applySyncChange(db as never, { table_name: 'products', record_id: 'p2', action: 'insert', data: JSON.stringify({ id: 'p2', sku: 'SKU-2', image_embedding: V_ALT }) });
  const p2 = db.exec("SELECT sku, image_embedding FROM products WHERE id = 'p2'")[0].values[0];
  ok(p2[0] === 'SKU-2' && p2[1] === null, 'Pull: neuer Artikel angelegt, Embedding nicht übernommen (lokal gerechnet)');
  // Der Vertrag selbst ist unverändert: ein Eintrag NUR mit dem Vektor ist gültig und bewirkt nichts.
  applySyncChange(db as never, { table_name: 'products', record_id: 'p1', action: 'update', data: JSON.stringify({ id: 'p1', image_embedding: V_ALT }) });
  ok(emb(db) === V_NEU, 'Eintrag nur mit Vektor: angenommen (Vertrag), ohne Wirkung');
}

// ── 2) Cursor-Verlust: Neuaufbau überspringt nur den belegten eigenen Anfang und spielt den Rest erneut ein ──
{
  const db = frisch();
  const eigen = (data: string, created: string) =>
    db.run(`INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES ('products','p1','branch-main','update',?,1,?)`, [data, created]);
  const e1 = zeile({ planned_sale_price: 120, image_embedding: V_ALT });           // alt, mit Vektor
  const e2 = zeile({ planned_sale_price: 130, image_embedding: null });             // alt, Bild gewechselt
  const e3 = zeile({ planned_sale_price: 150 });                                    // neu (Weg A), ohne Feld
  eigen(e1, '2026-10-01'); eigen(e2, '2026-10-02'); eigen(e3, '2026-11-20');
  // Die Server-Historie: eigener Eintrag, dann ein FREMDER (Handy), dann die übrigen eigenen.
  const server = [
    { id: 1, table_name: 'products', record_id: 'p1', action: 'update', data: e1 },
    { id: 2, table_name: 'products', record_id: 'p9', action: 'insert', data: JSON.stringify({ id: 'p9', sku: 'SKU-9' }) },
    { id: 3, table_name: 'products', record_id: 'p1', action: 'update', data: e2 },
    { id: 4, table_name: 'products', record_id: 'p1', action: 'update', data: e3 },
  ];
  ok(readCursor(db as never, FP) === null, 'Cursor-Verlust: kein gespeicherter Stand');
  const start = resolveCursorStart(db as never, FP, server, 4, '2026-11-21T00:00:00.000Z');
  ok(start.kind === 'reconstructed' && start.cursor === 1, `Neuaufbau: eigener Anfang bis #1, danach wird erneut eingespielt (${JSON.stringify(start)})`);
  for (const c of server.filter((x) => x.id > (start as { cursor: number }).cursor)) applySyncChange(db as never, c);
  ok(emb(db) === V_NEU && preis(db) === 150, 'Neuaufbau: alte Einträge (Vektor, null) erneut eingespielt — Embedding bleibt das neue, Preis endet beim jüngsten');
  ok(db.exec("SELECT sku FROM products WHERE id = 'p9'")[0].values[0][0] === 'SKU-9', 'Neuaufbau: der fremde Eintrag wird angewandt');
}

console.log(fails.length ? `\nFAIL — a2-echo-schutz: ${PASS} passed, ${fails.length} failed` : `\nPASS — a2-echo-schutz: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);

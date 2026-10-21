// ════════════════════════════════════════════════════════════════════════════
// PRODUCT-LEFTOVERS — beim Löschen eines Artikels gehen sein Upload-Beleg und seine Foto-Verknüpfungen mit.
// Run: node --experimental-strip-types test/product-leftovers/product-leftovers.test.ts
//
// Echte sql.js-Datenbank mit dem ECHTEN Medien-Schema (inkl. seiner Wächter-Trigger): die Testdaten müssen dieselben
// Regeln erfüllen wie die App. Die Frage „geht dieses Foto in die Sicherung?" beantwortet hier DIESELBE Abfrage wie in
// Rust — sie wird aus `src-tauri/src/media/reachability.rs` gelesen (REQUIRED), nicht abgeschrieben. Die Dateien selbst
// bleiben (PRESERVED: jede Generation), denn Generationen dürfen per Schema nicht gelöscht werden.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import {
  purgeProductLeftovers, purgeProductLeftoversSafely, productWasDeleted, sweepDeletedProductLeftovers, type LeftoverDb,
} from '../../src/core/products/product-leftovers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const WASM = join(repo, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void { if (cond) PASS++; else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); } }

// ── REQUIRED aus Rust: Zeilenfortsetzung `\` + Zeilenumbruch + Einrückung entfällt, wie im Rust-Literal ─────────────
const RUST = readFileSync(join(repo, 'src-tauri', 'src', 'media', 'reachability.rs'), 'utf8');
function rustConst(name: string): string {
  const m = new RegExp(`pub const ${name}: &str = "((?:[^"\\\\]|\\\\[\\s\\S])*)";`).exec(RUST);
  if (!m) throw new Error(`${name} not found in reachability.rs`);
  return m[1].replace(/\\\r?\n\s*/g, '');
}
const REQUIRED_MASTER_SQL = rustConst('REQUIRED_MASTER_SQL');
const REQUIRED_VARIANT_SQL = rustConst('REQUIRED_VARIANT_SQL');

const T = 'tenant-1', B = 'branch-main', NOW = '2026-10-21T08:00:00.000Z', LATER = '2026-10-21T09:00:00.000Z';
type Db = LeftoverDb & { close(): void };

function newDb(SQL: { Database: new () => Db }, withMedia = true): Db {
  const db = new SQL.Database();
  if (withMedia) applyMediaSchema(db as never);
  db.run(`CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, tenant_id TEXT)`);
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) db.run(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT, tenant_id TEXT${t.idCol === 'id' ? '' : `, ${t.idCol} TEXT`})`);
  db.run(`CREATE TABLE mobile_upload_receipts (tenant_id TEXT, branch_id TEXT, authenticated_user_id TEXT, upload_event_id TEXT, payload_hash TEXT, entity_id TEXT, create_batch_id TEXT, product_id TEXT, canonical_product_metadata_hash TEXT, prepared_manifest_hash TEXT, created_at TEXT)`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, action TEXT, data TEXT)`);
  db.run(`CREATE TABLE audit_log (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, action_type TEXT)`);
  db.run(`INSERT INTO tenants (id) VALUES (?)`, [T]);
  db.run(`INSERT INTO branches (id, tenant_id) VALUES (?, ?)`, [B, T]);
  return db;
}

const num = (db: Db, sql: string, p: unknown[] = []): number => Number(db.exec(sql, p)[0].values[0][0]);
const product = (db: Db, id: string): void => db.run(`INSERT INTO products (id, branch_id, tenant_id) VALUES (?, ?, ?)`, [id, B, T]);
/** Eine Datei: Generation (available) + Blob (present). Der Hash ist der Name. */
function blob(db: Db, key: string, size = 5000): string {
  const id = `blob-${key}`;
  db.run(`INSERT INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension, gen_status, created_at)
          VALUES (?, ?, 1, ?, ?, ?, 'raster_image', 'image/jpeg', 'jpg', 'available', ?)`, [T, id, `${T}/${key.slice(0, 2)}/${key}.jpg`, key, size, NOW]);
  db.run(`INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at) VALUES (?, ?, ?, 1, 'present', ?, ?)`, [T, id, `dedup-${key}`, NOW, NOW]);
  return id;
}
function medium(db: Db, mediaId: string, master: string, thumb: string): void {
  db.run(`INSERT INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type, ingest_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'normalized', 'upload_desktop', 'ready', ?, ?)`, [T, mediaId, B, master, NOW, NOW]);
  db.run(`INSERT INTO media_variants (tenant_id, variant_id, media_id, variant_type, transform_version, blob_id, created_at) VALUES (?, ?, ?, 'thumbnail', 1, ?, ?)`,
    [T, `variant-${mediaId}-thumbnail`, mediaId, thumb, NOW]);
}
function link(db: Db, entityId: string, mediaId: string, sort: number, deletedAt: string | null = null): void {
  db.run(`INSERT INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at, deleted_at)
          VALUES (?, ?, 'branch', ?, 'product', ?, ?, 'stock_image', ?, ?, ?, ?)`, [T, `link-${entityId}-${mediaId}`, B, entityId, mediaId, sort, sort === 0 && !deletedAt ? 1 : 0, NOW, deletedAt]);
}
function receipt(db: Db, productId: string, ev: string): void {
  db.run(`INSERT INTO mobile_upload_receipts (tenant_id, branch_id, authenticated_user_id, upload_event_id, payload_hash, entity_id, create_batch_id, product_id, canonical_product_metadata_hash, prepared_manifest_hash, created_at)
          VALUES (?, ?, 'u1', ?, 'ph', ?, 'batch', ?, 'h', 'h', ?)`, [T, B, ev, productId, productId, NOW]);
}
/** Ein Artikel mit `n` Fotos (je Original + Vorschau) und einem Beleg. */
function itemWithPhotos(db: Db, id: string, n: number): void {
  product(db, id);
  for (let i = 0; i < n; i++) {
    const m = `media-${id}-${i}`;
    medium(db, m, blob(db, `${id}m${i}`), blob(db, `${id}t${i}`, 900));
    link(db, id, m, i);
  }
  receipt(db, id, `ev-${id}`);
}
/** Wie die App: Zeile weg + Löschen protokolliert. */
function deleteRow(db: Db, id: string): void {
  db.run(`DELETE FROM products WHERE id = ?`, [id]);
  db.run(`INSERT INTO sync_changelog (table_name, record_id, action, data) VALUES ('products', ?, 'delete', '{}')`, [id]);
}
/** Was die Sicherung mitnimmt (REQUIRED, Rust-Abfrage): die Hashes der Dateien. */
function required(db: Db): Set<string> {
  const out = new Set<string>();
  for (const sql of [REQUIRED_MASTER_SQL, REQUIRED_VARIANT_SQL]) for (const r of db.exec(sql)[0]?.values ?? []) out.add(String(r[3]));
  return out;
}
/** Was nie gelöscht werden darf (PRESERVED): jede Generation. */
const preserved = (db: Db): number => num(db, `SELECT COUNT(*) FROM media_blob_generations`);
const MEDIA_TABLES = ['media_objects', 'media_variants', 'media_blobs', 'media_blob_generations'];
const mediaRows = (db: Db): string => MEDIA_TABLES.map((t) => `${t}=${num(db, `SELECT COUNT(*) FROM ${t}`)}`).join(' ');

async function main(): Promise<void> {
  const SQL = (await initSqlJs({ locateFile: () => WASM })) as unknown as { Database: new () => Db };
  ok(/l\.deleted_at IS NULL/.test(REQUIRED_MASTER_SQL) && /media_variants/.test(REQUIRED_VARIANT_SQL), 'REQUIRED-Abfragen aus reachability.rs gelesen');

  // ── 1 · Artikel mit zwei Fotos und Beleg gelöscht ───────────────────────────────────────────────────────────────
  {
    const db = newDb(SQL);
    itemWithPhotos(db, 'gone', 2);
    itemWithPhotos(db, 'kept', 1);
    deleteRow(db, 'gone');
    const vorherReq = required(db);
    const vorherMedia = mediaRows(db);
    // Negativkontrolle: so stand es vorher — die Fotos des gelöschten Artikels gehen in die Sicherung.
    ok(['gonem0', 'gonet0', 'gonem1', 'gonet1'].every((k) => vorherReq.has(k)), '1: OHNE Aufräumen gelten die Fotos des gelöschten Artikels als gebraucht (Sicherung)');
    const r = purgeProductLeftovers(db, ['gone'], LATER);
    ok(r.receipts === 1 && r.links === 2, `1: Beleg 1, Verknüpfungen 2 (${JSON.stringify(r)})`);
    ok(num(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE product_id = 'gone'`) === 0, '1: Beleg weg');
    ok(num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'gone' AND deleted_at = ? AND is_primary = 0`, [LATER]) === 2
      && num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'gone' AND deleted_at IS NULL`) === 0, '1: Verknüpfungen entfernt markiert (wie in der Galerie), nicht gelöscht');
    const nachherReq = required(db);
    ok(['gonem0', 'gonet0', 'gonem1', 'gonet1'].every((k) => !nachherReq.has(k)), '1: die Fotos des gelöschten Artikels gehen nicht mehr in die Sicherung');
    ok(nachherReq.has('keptm0') && nachherReq.has('keptt0') && nachherReq.size === 2, '1: die Fotos des anderen Artikels schon');
    ok(mediaRows(db) === vorherMedia && preserved(db) === 6, `1: Medium, Varianten, Blob und Generationen unberührt — die Dateien bleiben (${mediaRows(db)})`);
    ok(num(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE product_id = 'kept'`) === 1 && num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'kept' AND deleted_at IS NULL`) === 1,
      '1: der andere Artikel behält Beleg und Verknüpfung');
    const r2 = purgeProductLeftovers(db, ['gone'], '2026-10-22T00:00:00.000Z');
    ok(r2.receipts + r2.links === 0 && num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'gone' AND deleted_at = ?`, [LATER]) === 2,
      '1: ein zweiter Lauf ändert nichts (auch die Zeit der Entfernung nicht)');
    db.close();
  }

  // ── 2 · Was nicht zum gelöschten Artikel gehört, bleibt ─────────────────────────────────────────────────────────
  {
    const db = newDb(SQL);
    product(db, 'gone'); product(db, 'other');
    // dasselbe Medium hängt auch am anderen Artikel — dessen Verknüpfung bleibt aktiv, das Foto bleibt gebraucht
    medium(db, 'm-shared', blob(db, 'sm'), blob(db, 'st', 900));
    link(db, 'gone', 'm-shared', 0); link(db, 'other', 'm-shared', 0);
    // eine schon früher aus der Galerie entfernte Verknüpfung: bleibt wie sie ist
    medium(db, 'm-old', blob(db, 'om'), blob(db, 'ot', 900));
    link(db, 'gone', 'm-old', 1, NOW);
    deleteRow(db, 'gone');
    const r = purgeProductLeftovers(db, ['gone'], LATER);
    ok(r.links === 1, `2: nur die eine aktive Verknüpfung des gelöschten Artikels (${r.links})`);
    ok(num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'other' AND deleted_at IS NULL AND is_primary = 1`) === 1, '2: die Verknüpfung des anderen Artikels bleibt aktiv (auch als Titelbild)');
    ok(required(db).has('sm') && required(db).has('st'), '2: ein Foto, das noch ein anderer Artikel zeigt, bleibt gebraucht');
    ok(num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'gone' AND media_id = 'm-old' AND deleted_at = ?`, [NOW]) === 1, '2: früher entfernte Verknüpfung unverändert');
    db.close();
  }

  // ── 3 · Gelöscht? Nur was protokolliert gelöscht wurde ────────────────────────────────────────────────────────
  {
    const db = newDb(SQL);
    db.run(`INSERT INTO sync_changelog (table_name, record_id, action) VALUES ('products', 'p-sync', 'delete')`);
    db.run(`INSERT INTO audit_log (id, entity_type, entity_id, action_type) VALUES ('a1', 'products', 'p-audit', 'DELETE')`);
    db.run(`INSERT INTO sync_changelog (table_name, record_id, action) VALUES ('products', 'p-ins', 'insert')`);
    db.run(`INSERT INTO sync_changelog (table_name, record_id, action) VALUES ('tasks', 'p-task', 'delete')`);
    ok(productWasDeleted(db, 'p-sync') && productWasDeleted(db, 'p-audit'), '3: Löschen im Abgleich- oder im Änderungsprotokoll zählt');
    ok(!productWasDeleted(db, 'p-ins') && !productWasDeleted(db, 'p-task') && !productWasDeleted(db, 'nie') && !productWasDeleted(db, ''),
      '3: angelegt, andere Tabelle, unbekannt oder leer zählt nicht');
    db.close();
  }

  // ── 4 · Start-Aufräumung: nur Reste von protokolliert gelöschten Artikeln ────────────────────────────────────────
  {
    const db = newDb(SQL);
    itemWithPhotos(db, 'alt', 1);      // vor dem Fix gelöscht: Zeile weg + protokolliert, Reste stehen
    itemWithPhotos(db, 'halb', 1);     // Zeile fehlt OHNE Protokoll (z. B. mitten im Anlegen abgestürzt) — nicht anfassen
    itemWithPhotos(db, 'lebt', 1);     // existiert
    deleteRow(db, 'alt');
    db.run(`DELETE FROM products WHERE id = 'halb'`);
    const r = sweepDeletedProductLeftovers(db, LATER);
    ok(r.products === 1 && r.receipts === 1 && r.links === 1, `4: genau der gelöschte Artikel aufgeräumt (${JSON.stringify(r)})`);
    ok(!required(db).has('altm0') && required(db).has('lebtm0'), '4: sein Foto geht nicht mehr in die Sicherung, das des bestehenden schon');
    ok(num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'halb' AND deleted_at IS NULL`) === 1 && num(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE product_id = 'halb'`) === 1,
      '4: ohne protokolliertes Löschen bleibt alles stehen');
    const r2 = sweepDeletedProductLeftovers(db, '2026-10-22T00:00:00.000Z');
    ok(r2.products === 0 && r2.receipts + r2.links === 0, '4: ein zweiter Start findet nichts mehr');
    db.close();
  }

  // ── 5 · Scheitert das Aufräumen, bleibt alles wie vorher (Sicherungspunkt) ──────────────────────────────────────
  {
    const db = newDb(SQL);
    itemWithPhotos(db, 'gone', 1);
    deleteRow(db, 'gone');
    const state = (): string => `${num(db, `SELECT COUNT(*) FROM mobile_upload_receipts`)}/${num(db, `SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL`)}`;
    const vorher = state();
    const broken: LeftoverDb = {
      exec: (s, p) => db.exec(s, p),
      run: (s, p) => { if (/^UPDATE media_links/.test(s.trim())) throw new Error('disk full'); db.run(s, p); },
    };
    const r = purgeProductLeftoversSafely(broken, ['gone']);
    ok(r === null, '5: Fehler wird gemeldet (null), nicht geworfen');
    ok(state() === vorher && vorher === '1/1', `5: nichts halb erledigt — der schon gelöschte Beleg ist wieder da (${state()})`);
    const ok2 = purgeProductLeftoversSafely(db, ['gone']);
    ok(ok2 !== null && ok2.receipts === 1 && ok2.links === 1 && state() === '0/0', '5: ein späterer Lauf räumt es dann');
    // Innerhalb einer laufenden Transaktion (Fertigung löschen läuft so): verschachtelt, die äußere entscheidet.
    itemWithPhotos(db, 'innen', 1);
    db.run('BEGIN');
    deleteRow(db, 'innen');
    const inner = purgeProductLeftoversSafely(db, ['innen']);
    db.run('ROLLBACK');
    ok(inner !== null && inner.links === 1 && num(db, `SELECT COUNT(*) FROM products WHERE id = 'innen'`) === 1
      && num(db, `SELECT COUNT(*) FROM media_links WHERE entity_id = 'innen' AND deleted_at IS NULL`) === 1
      && num(db, `SELECT COUNT(*) FROM mobile_upload_receipts WHERE product_id = 'innen'`) === 1,
      '5: in einer äußeren Transaktion — deren Rollback nimmt auch das Aufräumen zurück');
    db.close();
  }

  // ── 6 · Datenbank ohne Medien-Tabellen: nur der Beleg, kein Fehler ──────────────────────────────────────────────
  {
    const db = newDb(SQL, false);
    receipt(db, 'p1', 'ev-1');
    let threw = false; let r: ReturnType<typeof purgeProductLeftovers> | null = null;
    try { r = purgeProductLeftovers(db, ['p1']); } catch { threw = true; }
    ok(!threw && r !== null && r.receipts === 1 && r.links === 0, '6: ohne Medien-Tabellen wird nur der Beleg entfernt');
    ok(!threw && sweepDeletedProductLeftovers(db).products === 0, '6: Start-Aufräumung läuft ohne Medien-Tabellen durch');
    ok(purgeProductLeftovers(db, []).receipts === 0 && purgeProductLeftovers(db, ['', '']).receipts === 0, '6: leere Liste ändert nichts');
    db.close();
  }

  console.log(`\nPRODUCT-LEFTOVERS: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });

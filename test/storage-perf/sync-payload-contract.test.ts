// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §11/§12 — product sync-payload contract.
// Run: node test/storage-perf/sync-payload-contract.test.ts
//
// §11 measures what a product save actually costs in `sync_changelog`, using the
// EXACT statement the producer runs (`trackChange` re-reads the whole row with
// `SELECT * FROM products WHERE id = ?` and stores it as JSON), against a real
// sql.js database holding a legacy product and a migrated one.
//
// §12 fixes the contract that follows from it. The measured answer is that the
// payload is blob-free BY CONSTRUCTION once the product is migrated — `images` is
// then `'[]'`. Stripping `images` from the snapshot instead would be a REGRESSION
// for peers: media tables are not in the sync allow-list, so for a not-yet
// migrated legacy product the snapshot is the ONLY carrier its peers have. This
// gate pins both halves of that reasoning so neither can drift.
//
// No production DB, no Tauri, no base64 ever printed.
// ════════════════════════════════════════════════════════════════════════════

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initSqlJs from 'sql.js';
import SYNC_BUSINESS_SCHEMA from '../../src/core/sync/sync-business-schema.json' with { type: 'json' };
import { applyUpsert } from '../../src/core/sync/apply-change.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = join(here, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let PASS = 0, FAIL = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) PASS++;
  else { FAIL++; failures.push(msg); console.log(`  ✗ ${msg}`); }
}

const IMAGE_B64_CHARS = 600_000;
function bigDataUrl(seed: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = seed >>> 0;
  const parts: string[] = [];
  for (let i = 0; i < IMAGE_B64_CHARS; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; parts.push(alpha[x % 64]); }
  return `data:image/jpeg;base64,${parts.join('')}`;
}

type AnyDb = { run(s: string, p?: unknown[]): void; exec(s: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };

/** The producer, verbatim: sync-service.ts trackChange re-reads the FULL row. */
function trackChangePayload(db: AnyDb, table: string, id: string): string {
  const res = db.exec(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const row: Record<string, unknown> = {};
  if (res.length && res[0].values.length) {
    res[0].columns.forEach((c, i) => { row[c] = res[0].values[0][i]; });
  }
  return JSON.stringify(row);
}

async function main(): Promise<void> {
  const SQL = await initSqlJs({ locateFile: () => WASM });
  const db = new SQL.Database() as unknown as AnyDb;
  db.run(`CREATE TABLE products (
     id TEXT PRIMARY KEY, branch_id TEXT, category_id TEXT, brand TEXT, name TEXT,
     purchase_price REAL, planned_sale_price REAL, images TEXT DEFAULT '[]',
     attributes TEXT, image_embedding TEXT, notes TEXT, updated_at TEXT)`);

  const legacyImages = JSON.stringify([bigDataUrl(1)]);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, planned_sale_price, images, attributes, notes, updated_at)
          VALUES ('legacy','b1','cat-watch','Rolex','Datejust 41', 8000, 9000, ?, '{"movement":"Cal. 3235"}', 'n', '2026-01-01T00:00:00.000Z')`, [legacyImages]);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, purchase_price, planned_sale_price, images, attributes, notes, updated_at)
          VALUES ('gallery','b1','cat-watch','Rolex','Datejust 41', 8000, 9000, '[]', '{"movement":"Cal. 3235"}', 'n', '2026-01-01T00:00:00.000Z')`);

  // ── §11 — a PRICE-ONLY edit re-embeds the whole image on a legacy product ──
  db.run(`UPDATE products SET purchase_price = 8001, updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'legacy'`);
  db.run(`UPDATE products SET purchase_price = 8001, updated_at = '2026-01-02T00:00:00.000Z' WHERE id = 'gallery'`);
  const legacyPayload = trackChangePayload(db, 'products', 'legacy');
  const galleryPayload = trackChangePayload(db, 'products', 'gallery');

  ok(legacyPayload.includes('base64,'), '§11 a legacy product\'s price-only save re-embeds the base64 image');
  ok(!galleryPayload.includes('base64,'), '§11 a migrated product\'s price-only save carries NO image bytes');
  ok(legacyPayload.length > IMAGE_B64_CHARS, `§11 legacy payload is image-sized (${legacyPayload.length}B)`);
  ok(galleryPayload.length < 1000, `§11 migrated payload is metadata-sized (${galleryPayload.length}B)`);
  const ratio = legacyPayload.length / galleryPayload.length;
  ok(ratio > 500, `§11 the same edit costs >500× more on a legacy product (${Math.round(ratio)}×)`);

  // Repeating the edit repeats the whole cost — this is the amplification.
  db.run(`UPDATE products SET purchase_price = 8002 WHERE id = 'legacy'`);
  const second = trackChangePayload(db, 'products', 'legacy');
  ok(second.length > IMAGE_B64_CHARS, '§11 every further edit embeds the image AGAIN (per-save cost, not one-off)');

  // ── §12 — media tables are NOT synced, so the snapshot is the only carrier ──
  const tables = Object.keys((SYNC_BUSINESS_SCHEMA as { tables?: Record<string, unknown> }).tables ?? SYNC_BUSINESS_SCHEMA as Record<string, unknown>);
  for (const t of ['media_links', 'media_objects', 'media_blobs', 'media_blob_generations']) {
    ok(!tables.includes(t), `§12 ${t} is NOT in the sync allow-list — gallery media does not replicate to peers`);
  }
  ok(tables.includes('products'), '§12 products IS synced');

  const productContract = ((SYNC_BUSINESS_SCHEMA as { tables?: Record<string, { allowed_fields: string[]; required_fields: string[] }> }).tables
    ?? SYNC_BUSINESS_SCHEMA as unknown as Record<string, { allowed_fields: string[]; required_fields: string[] }>).products;
  ok(productContract.allowed_fields.includes('images'), '§12 `images` is an ALLOWED product field (removing it is a protocol decision, not a bug fix)');
  ok(productContract.required_fields.length === 0, '§12 no product field is required — omitting one is contract-valid');

  // ── §12 — omitting `images` on a peer would NOT null it, but on a fresh
  //         INSERT the peer would fall back to the column default. Both facts
  //         matter for the decision, so both are pinned here.
  {
    const peer = new SQL.Database() as unknown as AnyDb;
    peer.run(`CREATE TABLE products (id TEXT PRIMARY KEY, brand TEXT, images TEXT DEFAULT '[]', purchase_price REAL)`);
    peer.run(`INSERT INTO products (id, brand, images, purchase_price) VALUES ('p','Rolex','["data:image/jpeg;base64,AAAA"]', 1)`);
    applyUpsert(peer as never, 'products', 'p', { brand: 'Omega', purchase_price: 2 });
    const after = peer.exec(`SELECT brand, images, purchase_price FROM products WHERE id='p'`);
    ok(String(after[0].values[0][0]) === 'Omega', 'applyUpsert applies the fields it was given');
    ok(String(after[0].values[0][1]).includes('base64'), 'a payload WITHOUT `images` leaves the peer\'s existing image untouched');
    applyUpsert(peer as never, 'products', 'newrow', { brand: 'Tudor', purchase_price: 3 });
    const ins = peer.exec(`SELECT images FROM products WHERE id='newrow'`);
    ok(String(ins[0].values[0][0]) === '[]', 'an INSERT without `images` falls back to the column default \'[]\' — never NULL');
    peer.close?.();
  }

  // ── §12 — the contract this slice ships: after migration, blob-free by
  //         construction. Proven on the migrated row, with no payload rewrite.
  ok(JSON.parse(galleryPayload).images === '[]', '§12 a migrated product syncs `images` as the empty gallery marker');
  ok(!JSON.stringify(JSON.parse(galleryPayload)).includes('data:'), '§12 no data: URL survives anywhere in a migrated snapshot');

  console.log(`\nsync-payload-contract: ${PASS} passed, ${FAIL} failed`);
  if (FAIL > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });

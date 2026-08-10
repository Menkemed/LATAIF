// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §3/§19/§24 — durable-save size scaling + legacy-vs-gallery harness.
// Run: node test/storage-perf/measure-storage.mjs [--max-mb=250] [--json=<path>]
//
// Builds ISOLATED fixture databases from the REAL product schema (never the
// production DB, never production media) in two variants:
//   A "inline"  — photos as base64 data URLs inside `products.images`, plus the
//                 changelog/audit copies a real save produces (the legacy shape).
//   B "gallery" — the same photos as durable blobs; `products.images` is '[]'.
//
// Then measures the EXACT production reload path for each:
//   sql.js load → db.export() → temp write → size verify → rename → reopen/parse
// which is what F5 runs (reload-orchestration → durableSave → atomic-persist).
//
// Reports absolute numbers only — no estimates, no extrapolation.
// ════════════════════════════════════════════════════════════════════════════

import { DatabaseSync } from 'node:sqlite';
import initSqlJs from 'sql.js';
import { applyMediaSchema, MEDIA_ENTITY_SCOPE } from '../../src/core/db/media-schema.ts';
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');
const WASM = join(REPO, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const OUT = join(REPO, 'test', 'storage-perf', '.artifacts');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const MAX_MB = Number(argOf('max-mb', '250'));
const JSON_OUT = argOf('json', join(OUT, 'storage-scaling.json'));

// ── fixture ────────────────────────────────────────────────────────────────
// One realistic photo size, taken from the MEASURED production average of the
// legacy inline images (see §1 baseline): ~450 KB decoded, ~600 KB as base64.
const DECODED_IMAGE_BYTES = 450_000;
// The durable gallery does not store the original: the media contract normalises
// every raster image to at most 100 KB (`main<=100000`, enforced by a CHECK on
// media_blob_generations). So variant B's blob is the normalised rendition — that
// cap is a real property of the pipeline, not a modelling choice.
const NORMALIZED_IMAGE_BYTES = 100_000;

function pseudoBase64(bytes, seed) {
  // A deterministic base64 body of the right LENGTH. Content does not matter for
  // storage/serialisation cost; size and incompressibility do.
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chars = Math.ceil(bytes / 3) * 4;
  const buf = Buffer.allocUnsafe(chars);
  let x = seed >>> 0;
  for (let i = 0; i < chars; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; buf[i] = alpha.charCodeAt(x % 64); }
  return buf.toString('latin1');
}

const SCHEMA_SQL = join(REPO, 'src', 'core', 'db', 'schema.sql');
const MEDIA_SCHEMA_TS = join(REPO, 'src', 'core', 'db', 'media-schema.ts');

function buildFixture(path, { products, variant }) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
  // Media triggers reference every entity-scope table; the ones schema.sql does
  // not define (runtime migrations create them) get a minimal stand-in so the
  // REAL media DDL applies unchanged.
  for (const t of Object.values(MEDIA_ENTITY_SCOPE)) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${t.table} (id TEXT PRIMARY KEY, branch_id TEXT)`);
  }
  // The REAL media DDL (same statements the app applies at startup).
  applyMediaSchema({ run: (sql) => db.exec(sql) });
  // `audit_log` is created by the runtime migration list in database.ts, not by
  // schema.sql — mirror its exact shape so the fixture writes the real columns.
  db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, branch_id TEXT, module TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, action_type TEXT NOT NULL, field_name TEXT, old_value TEXT,
    new_value TEXT, changed_by TEXT, changed_at TEXT NOT NULL)`);

  const TS0 = '2026-01-01T00:00:00.000Z';
  db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?)`).run('t1', 'T', 't', TS0, TS0);
  db.prepare(`INSERT OR IGNORE INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)`).run('branch-main', 't1', 'Main', TS0, TS0);
  db.prepare(`INSERT OR IGNORE INTO categories (id, branch_id, name, attributes, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run('cat-watch', 'branch-main', 'Watch', '[]', TS0, TS0);

  const insProduct = db.prepare(`INSERT INTO products
    (id, branch_id, category_id, brand, name, purchase_price, images, attributes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insChangelog = db.prepare(`INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,?,?,?,?,?)`);
  const insAudit = db.prepare(`INSERT INTO audit_log (id, branch_id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_by, changed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insLink = db.prepare(`INSERT INTO media_links (tenant_id, link_id, scope_kind, branch_id, entity_type, entity_id, media_id, media_role, sort_order, is_primary, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insObj = db.prepare(`INSERT INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type, security_class, retention_class, ingest_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insBlobNoPtr = db.prepare(`INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, blob_status, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
  const setPtr = db.prepare(`UPDATE media_blobs SET current_generation_no = ? WHERE blob_id = ?`);
  const setPresent = db.prepare(`UPDATE media_blobs SET blob_status = 'present' WHERE blob_id = ?`);
  const insGen = db.prepare(`INSERT INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension, is_encrypted, gen_status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const TS = '2026-01-01T00:00:00.000Z';
  db.exec('BEGIN');
  for (let i = 0; i < products; i++) {
    const id = `prod-${String(i).padStart(6, '0')}`;
    const attrs = JSON.stringify({ movement: 'Cal. 3235', diamonds: i % 3 === 0, case_diameter_mm: 41 });
    if (variant === 'inline') {
      const dataUrl = `data:image/jpeg;base64,${pseudoBase64(DECODED_IMAGE_BYTES, i + 1)}`;
      const images = JSON.stringify([dataUrl]);
      insProduct.run(id, 'branch-main', 'cat-watch', 'Rolex', `Datejust ${i}`, 500, images, attrs, TS, TS);
      // What a real save produces alongside the row (measured §1: the SAME image
      // lands in the changelog snapshot and in the audit new_value).
      const rowJson = JSON.stringify({ id, branch_id: 'branch-main', brand: 'Rolex', images, attributes: attrs });
      insChangelog.run('products', id, 'branch-main', 'insert', rowJson, 1, TS);
      insAudit.run(`aud-${id}`, 'branch-main', 'Product', 'products', id, 'CREATE', null, null, rowJson, 'u1', TS);
    } else {
      insProduct.run(id, 'branch-main', 'cat-watch', 'Rolex', `Datejust ${i}`, 500, '[]', attrs, TS, TS);
      const hash = `${String(i).padStart(8, '0')}${'a'.repeat(56)}`;
      const blobId = `blob-${hash}`;
      const mediaId = `media-${hash}`;
      // Generation FIRST: the media_blobs pointer trigger refuses a
      // current_generation_no whose generation row is not already 'available'.
      insBlobNoPtr.run('t1', blobId, hash, 'pending', TS, TS);
      insGen.run('t1', blobId, 1, `t1/${hash.slice(0, 2)}/${hash}.jpg`, hash, NORMALIZED_IMAGE_BYTES, 'raster_image', 'image/jpeg', 'jpg', 0, 'available', TS);
      setPtr.run(1, blobId);   // pointer only after the generation exists
      setPresent.run(blobId);  // then the CHECK (present ⇒ pointer set) holds
      insObj.run('t1', mediaId, 'branch-main', blobId, 'normalized', 'upload_desktop', 'internal', 'standard', 'ready', TS, TS);
      insLink.run('t1', `link-${hash}`, 'branch', 'branch-main', 'product', id, mediaId, 'stock_image', 0, 1, TS);
      const rowJson = JSON.stringify({ id, branch_id: 'branch-main', brand: 'Rolex', images: '[]', attributes: attrs });
      insChangelog.run('products', id, 'branch-main', 'insert', rowJson, 1, TS);
      insAudit.run(`aud-${id}`, 'branch-main', 'Product', 'products', id, 'CREATE', null, null, rowJson, 'u1', TS);
    }
  }
  db.exec('COMMIT');
  db.close();
  return statSync(path).size;
}

// ── the measured path ──────────────────────────────────────────────────────
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function measure(SQL, path) {
  const fileBytes = statSync(path).size;
  const rssBefore = process.memoryUsage().rss;

  let t = process.hrtime.bigint();
  const bytes = readFileSync(path);
  const readMs = ms(t);

  t = process.hrtime.bigint();
  const db = new SQL.Database(bytes);
  const openMs = ms(t);

  // A trivial query proves the DB is actually usable (parsing is lazy otherwise).
  t = process.hrtime.bigint();
  db.exec('SELECT COUNT(*) FROM products');
  const firstQueryMs = ms(t);

  t = process.hrtime.bigint();
  const exported = db.export();
  const exportMs = ms(t);

  const tmp = path + '.tmp';
  t = process.hrtime.bigint();
  writeFileSync(tmp, exported);
  const writeMs = ms(t);

  t = process.hrtime.bigint();
  const tmpSize = statSync(tmp).size;
  if (tmpSize !== exported.length) throw new Error('verify failed');
  const verifyMs = ms(t);

  const final = path + '.final';
  t = process.hrtime.bigint();
  renameSync(tmp, final);
  const renameMs = ms(t);

  // Reload = what the webview does after location.reload().
  t = process.hrtime.bigint();
  const reloaded = new SQL.Database(readFileSync(final));
  reloaded.exec('SELECT COUNT(*) FROM products');
  const reloadMs = ms(t);

  const rssPeak = process.memoryUsage().rss;
  reloaded.close();
  db.close();
  rmSync(final, { force: true });

  const durableSaveMs = exportMs + writeMs + verifyMs + renameMs;
  return {
    fileBytes,
    readMs: +readMs.toFixed(1),
    openMs: +openMs.toFixed(1),
    firstQueryMs: +firstQueryMs.toFixed(1),
    exportMs: +exportMs.toFixed(1),
    writeMs: +writeMs.toFixed(1),
    verifyMs: +verifyMs.toFixed(1),
    renameMs: +renameMs.toFixed(1),
    durableSaveMs: +durableSaveMs.toFixed(1),
    reloadMs: +reloadMs.toFixed(1),
    f5TotalMs: +(durableSaveMs + reloadMs).toFixed(1),
    rssDeltaMb: +((rssPeak - rssBefore) / 1048576).toFixed(1),
  };
}

// ── run ────────────────────────────────────────────────────────────────────
const mb = (n) => (n / 1048576).toFixed(1);

async function main() {
  mkdirSync(OUT, { recursive: true });
  const SQL = await initSqlJs({ locateFile: () => WASM });

  // Product counts chosen so variant A lands near the target file sizes.
  // ~0.6 MB base64 in the row + ~1.2 MB of changelog/audit copies ≈ 1.8 MB each.
  const cases = [
    { label: 'prod-like', products: 27 },
    { label: '100MB', products: 56 },
    { label: '250MB', products: 140 },
    { label: '500MB', products: 280 },
    { label: 'scale-200', products: 200 },
  ];

  const results = [];
  for (const c of cases) {
    for (const variant of ['inline', 'gallery']) {
      const path = join(OUT, `fx-${c.label}-${variant}.db`);
      const built = buildFixture(path, { products: c.products, variant });
      if (variant === 'inline' && built / 1048576 > MAX_MB + 60) {
        console.log(`SKIP ${c.label}/${variant} — ${mb(built)} MB exceeds --max-mb=${MAX_MB}`);
        rmSync(path, { force: true });
        continue;
      }
      let m = null, error = null;
      try { m = await measure(SQL, path); }
      catch (e) { error = e instanceof Error ? e.message : String(e); }
      rmSync(path, { force: true });
      const row = { case: c.label, products: c.products, variant, ...(m ?? {}), error };
      results.push(row);
      if (error) console.log(`${c.label.padEnd(10)} ${variant.padEnd(8)} ERROR ${error}`);
      else console.log(
        `${c.label.padEnd(10)} ${variant.padEnd(8)} file=${mb(m.fileBytes).padStart(7)}MB` +
        ` export=${String(m.exportMs).padStart(7)}ms write=${String(m.writeMs).padStart(7)}ms` +
        ` verify+rename=${String((m.verifyMs + m.renameMs).toFixed(1)).padStart(6)}ms` +
        ` durableSave=${String(m.durableSaveMs).padStart(8)}ms reload=${String(m.reloadMs).padStart(7)}ms` +
        ` F5total=${String(m.f5TotalMs).padStart(8)}ms rss+=${String(m.rssDeltaMb).padStart(6)}MB`);
    }
  }

  writeFileSync(JSON_OUT, JSON.stringify({ decodedImageBytes: DECODED_IMAGE_BYTES, normalizedImageBytes: NORMALIZED_IMAGE_BYTES, results }, null, 2), 'utf8');
  console.log(`\nwrote ${JSON_OUT}`);

  // A/B summary for the same product count.
  for (const c of cases) {
    const a = results.find((r) => r.case === c.label && r.variant === 'inline' && !r.error);
    const b = results.find((r) => r.case === c.label && r.variant === 'gallery' && !r.error);
    if (!a || !b) continue;
    console.log(
      `A/B ${c.label.padEnd(10)} products=${String(c.products).padStart(4)}` +
      ` size ${mb(a.fileBytes)}MB → ${mb(b.fileBytes)}MB (${(100 * (1 - b.fileBytes / a.fileBytes)).toFixed(1)}% smaller)` +
      ` | F5 ${a.f5TotalMs}ms → ${b.f5TotalMs}ms (${(100 * (1 - b.f5TotalMs / a.f5TotalMs)).toFixed(1)}% faster)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

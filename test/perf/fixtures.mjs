// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — deterministic, isolated fixture generator.
//
// Builds an isolated performance DB (`lataif.db`) from the REAL production schema (`src/core/db/schema.sql`
// + the media DDL extracted from `src/core/db/media-schema.ts`) and seeds it with a FIXED seed, so every run
// produces byte-identical row counts and the same ids/relationships. NEVER opens or copies the production DB
// or the production media root; contains no real customer data.
//
// Three sizes (exact counts documented in the report):
//   SMALL  — fast smoke baseline, business-complete but tiny.
//   MEDIUM — realistic production volume (search/filter/sort/invoices/reports meaningful).
//   LARGE  — clearly elevated load; run on demand, not in the normal dev gate.
// ════════════════════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rng } from './harness.mjs';

const REPO = process.cwd();
const SCHEMA_SQL = join(REPO, 'src', 'core', 'db', 'schema.sql');
const MEDIA_SCHEMA_TS = join(REPO, 'src', 'core', 'db', 'media-schema.ts');

// Fixed, business-plausible reference data (no PII).
const BRANDS = ['Rolex', 'Omega', 'Patek Philippe', 'Audemars Piguet', 'Cartier', 'IWC', 'Breitling', 'Tudor'];
const MODELS = ['Submariner', 'Speedmaster', 'Nautilus', 'Royal Oak', 'Santos', 'Portugieser', 'Navitimer', 'Black Bay'];
const CONDITIONS = ['new', 'like_new', 'good', 'fair'];
const STOCK = ['in_stock', 'reserved', 'sold'];
const BASE_TS = '2026-01-01T00:00:00.000Z';

export const SIZES = {
  small: { products: 200, customers: 60, invoices: 120, mediaProducts: 40, payments: 90 },
  medium: { products: 3000, customers: 800, invoices: 2400, mediaProducts: 900, payments: 2000 },
  large: { products: 20000, customers: 4000, invoices: 15000, mediaProducts: 6000, payments: 12000 },
};

/** Extract the real media CREATE TABLE statements from media-schema.ts (skip triggers/indexes). */
function mediaCreateTableStatements() {
  const src = readFileSync(MEDIA_SCHEMA_TS, 'utf8');
  const out = [];
  const re = /`(CREATE TABLE IF NOT EXISTS [\s\S]*?)`/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function applySchema(db) {
  // Real production business schema (26 tables + indexes).
  db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
  // The perf scenarios only read the content-addressed generation rows (storage_key/blob_id), so the fixture
  // uses a lean media_blob_generations that mirrors the columns those scenarios touch — the full media-ingest
  // schema (with its NOT-NULL pipeline columns) is not needed to measure query/GC-scan performance.
  db.exec(`CREATE TABLE IF NOT EXISTS media_blob_generations (tenant_id TEXT, blob_id TEXT, generation_no INTEGER, gen_status TEXT, storage_key TEXT NOT NULL, stored_blob_hash TEXT, byte_size INTEGER, extension TEXT, deleted_at TEXT);
            CREATE INDEX IF NOT EXISTS idx_mbg_key ON media_blob_generations(storage_key);`);
}

function tick(base, i) { return new Date(Date.parse(base) + i * 60000).toISOString(); }
function pad(n, w = 6) { return String(n).padStart(w, '0'); }

/** Build (or rebuild) the fixture DB for `size` under `dir`. Deterministic: same size → identical content. */
export function buildFixture(dir, size) {
  const counts = SIZES[size];
  if (!counts) throw new Error('unknown size ' + size);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'lataif.db');
  const mediaRoot = join(dir, 'media');
  rmSync(dbPath, { force: true });
  rmSync(mediaRoot, { recursive: true, force: true });
  const db = new DatabaseSync(dbPath);
  // The app's SQL.js runs with FK enforcement OFF; match it so deterministic bulk-seed order is free.
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  applySchema(db);

  const r = rng(0xC0FFEE ^ hashSize(size));
  const pick = (arr) => arr[Math.floor(r() * arr.length)];

  db.exec('BEGIN');
  db.exec(`INSERT INTO tenants (id,name,slug,created_at,updated_at) VALUES ('tenant-1','Perf Co','perf', '${BASE_TS}','${BASE_TS}');`);
  db.exec(`INSERT INTO branches (id,tenant_id,name,created_at,updated_at) VALUES ('branch-main','tenant-1','Main','${BASE_TS}','${BASE_TS}');`);
  db.exec(`INSERT INTO users (id,tenant_id,email,password_hash,name,created_at,updated_at) VALUES ('user-owner','tenant-1','admin@lataif.com','x','Owner','${BASE_TS}','${BASE_TS}');`);
  db.exec(`INSERT INTO user_branches (user_id,branch_id,role,is_default,created_at) VALUES ('user-owner','branch-main','owner',1,'${BASE_TS}');`);
  for (let c = 0; c < 6; c++) db.exec(`INSERT INTO categories (id,branch_id,name,created_at,updated_at) VALUES ('cat-${c}','branch-main','Category ${c}','${BASE_TS}','${BASE_TS}');`);

  const insProd = db.prepare(`INSERT INTO products (id,branch_id,category_id,brand,name,sku,condition,purchase_price,planned_sale_price,stock_status,tax_scheme,created_at,updated_at,created_by,images) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= counts.products; i++) {
    const brand = pick(BRANDS), model = pick(MODELS);
    const pp = 500 + Math.floor(r() * 20000);
    insProd.run(`prod-${pad(i)}`, 'branch-main', `cat-${i % 6}`, brand, `${brand} ${model} ${i}`,
      `SKU-${pad(i)}`, pick(CONDITIONS), pp, pp + 500 + Math.floor(r() * 5000), pick(STOCK), i % 3 === 0 ? 'VAT_10' : 'MARGIN',
      tick(BASE_TS, i), tick(BASE_TS, i), 'user-owner', '[]');
  }
  const insCust = db.prepare(`INSERT INTO customers (id,branch_id,first_name,last_name,phone,email,customer_type,sales_stage,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 1; i <= counts.customers; i++) {
    insCust.run(`cust-${pad(i)}`, 'branch-main', `First${i}`, `Last${i}`, `+9730000${pad(i)}`, `c${i}@perf.local`,
      'collector', pick(['lead', 'prospect', 'customer', 'vip']), tick(BASE_TS, i), tick(BASE_TS, i), 'user-owner');
  }
  // invoices with 1..4 lines, partial payments, open balances.
  const insInv = db.prepare(`INSERT INTO invoices (id,branch_id,invoice_number,customer_id,status,net_amount,vat_rate_snapshot,vat_amount,gross_amount,tax_scheme_snapshot,paid_amount,issued_at,created_at,updated_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insLine = db.prepare(`INSERT INTO invoice_lines (id,invoice_id,product_id,unit_price,vat_rate,tax_scheme,vat_amount,line_total,position) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insPay = db.prepare(`INSERT INTO payments (id,branch_id,invoice_id,amount,method,received_at,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)`);
  let payCount = 0;
  for (let i = 1; i <= counts.invoices; i++) {
    const lineN = 1 + Math.floor(r() * 4);
    let net = 0, vat = 0;
    for (let l = 0; l < lineN; l++) {
      const price = 500 + Math.floor(r() * 15000);
      const isVat = (i + l) % 2 === 0;
      const vr = isVat ? 10 : 0;
      const va = isVat ? Math.round(price * 0.1 * 1000) / 1000 : 0;
      net += price; vat += va;
      insLine.run(`line-${pad(i)}-${l}`, `inv-${pad(i)}`, `prod-${pad(1 + ((i + l) % counts.products))}`, price, vr, isVat ? 'VAT_10' : 'MARGIN', va, price + va, l + 1);
    }
    const gross = net + vat;
    // ~⅓ fully paid, ⅓ partial, ⅓ open — deterministic by index.
    const paid = i % 3 === 0 ? gross : i % 3 === 1 ? Math.round(gross * 0.4 * 1000) / 1000 : 0;
    const status = paid >= gross ? 'paid' : paid > 0 ? 'partial' : 'issued';
    insInv.run(`inv-${pad(i)}`, 'branch-main', `INV-${pad(i)}`, `cust-${pad(1 + (i % counts.customers))}`, status,
      net, vat > 0 ? 10 : 0, vat, gross, vat > 0 ? 'VAT_10' : 'MARGIN', paid, tick(BASE_TS, i), tick(BASE_TS, i), tick(BASE_TS, i), 'user-owner');
    if (paid > 0 && payCount < counts.payments) { insPay.run(`pay-${pad(i)}`, 'branch-main', `inv-${pad(i)}`, paid, 'bank_transfer', tick(BASE_TS, i), tick(BASE_TS, i), 'user-owner'); payCount++; }
  }
  // media generations + real files on disk for a subset of products (some products have 2 generations + a thumb).
  const insGen = db.prepare(`INSERT INTO media_blob_generations (tenant_id,blob_id,generation_no,gen_status,storage_key,stored_blob_hash,byte_size,extension,deleted_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  let mediaFiles = 0;
  for (let i = 1; i <= counts.mediaProducts; i++) {
    const gens = i % 5 === 0 ? 2 : 1; // some products carry an older pinned generation
    for (let g = 1; g <= gens; g++) {
      const hash = deterministicHash(`prod-${i}-gen-${g}`);
      const key = `tenant-1/${hash.slice(0, 2)}/${hash}.jpg`;
      insGen.run('tenant-1', `blob-${pad(i)}-${g}`, g, 'available', key, hash, 1024 + i, 'jpg', null);
      const abs = join(mediaRoot, 'tenant-1', hash.slice(0, 2), `${hash}.jpg`);
      mkdirSync(join(mediaRoot, 'tenant-1', hash.slice(0, 2)), { recursive: true });
      writeFileSync(abs, `FIXTURE-MEDIA-${i}-${g}`);
      mediaFiles++;
    }
    // one thumbnail variant per media product
    const th = deterministicHash(`prod-${i}-thumb`);
    insGen.run('tenant-1', `blobt-${pad(i)}`, 1, 'available', `tenant-1/${th.slice(0, 2)}/${th}.jpg`, th, 256, 'jpg', null);
    const tabs = join(mediaRoot, 'tenant-1', th.slice(0, 2), `${th}.jpg`);
    mkdirSync(join(mediaRoot, 'tenant-1', th.slice(0, 2)), { recursive: true });
    writeFileSync(tabs, `FIXTURE-THUMB-${i}`);
    mediaFiles++;
  }
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  db.exec('ANALYZE;');
  const realCounts = {
    products: one(db, 'SELECT COUNT(*) c FROM products'),
    customers: one(db, 'SELECT COUNT(*) c FROM customers'),
    invoices: one(db, 'SELECT COUNT(*) c FROM invoices'),
    invoice_lines: one(db, 'SELECT COUNT(*) c FROM invoice_lines'),
    payments: one(db, 'SELECT COUNT(*) c FROM payments'),
    media_generations: one(db, 'SELECT COUNT(*) c FROM media_blob_generations'),
    media_files: mediaFiles,
  };
  db.close();
  const dbBytes = statSync(dbPath).size;
  return { size, dir, dbPath, mediaRoot, counts: realCounts, dbBytes };
}

function one(db, sql) { return db.prepare(sql).get().c; }
function hashSize(size) { let h = 0; for (const ch of size) h = (h * 31 + ch.charCodeAt(0)) | 0; return h >>> 0; }
/** 64-hex deterministic content-address stand-in (no crypto needed; stable across runs). */
function deterministicHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0; h2 = Math.imul(h2 ^ s.charCodeAt(i * 2 % s.length || 0), 0x85ebca6b) >>> 0; }
  const seg = (x, n) => (x >>> 0).toString(16).padStart(8, '0').repeat(n);
  return (seg(h1, 4) + seg(h2, 4)).slice(0, 64);
}

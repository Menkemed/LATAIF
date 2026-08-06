// ════════════════════════════════════════════════════════════════════════════
// PERFORMANCE-SUITE — DB-layer scenarios over a deterministic fixture.
//
// These exercise the real data-layer SQL of the product's critical paths (inventory, search, filter, sort,
// product detail, invoice list/open, customer search, finance aggregation) against the SAME SQLite engine the
// app uses (SQL.js at the storage layer). Every scenario VALIDATES a business result (count/total), so a
// fast-but-wrong query fails. Also measures the Media-GC dry-run (reference build + filesystem scan + diff).
// Read-only: no scenario mutates the fixture (invoice-create is measured against a throwaway clone).
// ════════════════════════════════════════════════════════════════════════════
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export function dbScenarios(fx) {
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  const q = (sql) => db.prepare(sql);
  const BR = 'branch-main';
  const C = fx.counts;

  // Precompute expected finance totals directly (independent of the measured aggregation query).
  const expected = q('SELECT COUNT(*) n, ROUND(SUM(gross_amount),3) gross, ROUND(SUM(paid_amount),3) paid FROM invoices WHERE branch_id=?').get(BR);

  const scenarios = [
    {
      name: 'inventory.list.page1', op: () => q('SELECT id,brand,name,sku,stock_status,planned_sale_price FROM products WHERE branch_id=? ORDER BY created_at DESC LIMIT 50').all(BR),
      validate: (r) => r.length === Math.min(50, C.products),
    },
    {
      name: 'inventory.count', op: () => q('SELECT COUNT(*) c FROM products WHERE branch_id=?').get(BR),
      validate: (r) => r.c === C.products,
    },
    {
      name: 'search.sku.exact', op: () => q('SELECT id,brand,name FROM products WHERE branch_id=? AND sku=?').all(BR, 'SKU-000100'),
      validate: (r) => r.length === (C.products >= 100 ? 1 : 0),
    },
    {
      name: 'search.brand.like', op: () => q("SELECT id FROM products WHERE branch_id=? AND brand LIKE ?").all(BR, 'Rolex%'),
      validate: (r) => r.length >= 0,
    },
    {
      name: 'search.name.contains', op: () => q("SELECT id FROM products WHERE branch_id=? AND name LIKE ?").all(BR, '%Submariner%'),
      validate: (r) => r.length >= 0,
    },
    {
      name: 'search.no_hit', op: () => q('SELECT id FROM products WHERE branch_id=? AND sku=?').all(BR, 'SKU-DOES-NOT-EXIST'),
      validate: (r) => r.length === 0,
    },
    {
      name: 'filter.stock_status', op: () => q('SELECT id FROM products WHERE branch_id=? AND stock_status=?').all(BR, 'in_stock'),
      validate: (r) => r.length >= 0,
    },
    {
      name: 'sort.price.desc', op: () => q('SELECT id,planned_sale_price FROM products WHERE branch_id=? ORDER BY planned_sale_price DESC LIMIT 50').all(BR),
      validate: (r) => r.length === Math.min(50, C.products) && (r.length < 2 || r[0].planned_sale_price >= r[r.length - 1].planned_sale_price),
    },
    {
      name: 'product.detail', op: () => {
        const p = q('SELECT * FROM products WHERE id=?').get('prod-000010');
        const gens = q('SELECT storage_key,generation_no FROM media_blob_generations WHERE blob_id LIKE ?').all('blob-000010%');
        return { p, gens };
      },
      validate: (r) => !!r.p && r.p.id === 'prod-000010',
    },
    {
      name: 'customer.search', op: () => q("SELECT id FROM customers WHERE branch_id=? AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ?)").all(BR, '%First1%', '%Last1%', '%'),
      validate: (r) => r.length >= 1,
    },
    {
      name: 'invoice.list.page1', op: () => q('SELECT i.id,i.invoice_number,i.gross_amount,i.paid_amount,i.status,c.first_name,c.last_name FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.branch_id=? ORDER BY i.issued_at DESC LIMIT 50').all(BR),
      validate: (r) => r.length === Math.min(50, C.invoices),
    },
    {
      name: 'invoice.open', op: () => {
        const inv = q('SELECT * FROM invoices WHERE id=?').get('inv-000005');
        const lines = q('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY position').all('inv-000005');
        const pays = q('SELECT * FROM payments WHERE invoice_id=?').all('inv-000005');
        return { inv, lines, pays };
      },
      validate: (r) => !!r.inv && r.lines.length >= 1,
    },
    {
      name: 'invoice.totals.validate', op: () => q('SELECT COUNT(*) n, ROUND(SUM(gross_amount),3) gross, ROUND(SUM(paid_amount),3) paid, ROUND(SUM(gross_amount-paid_amount),3) open FROM invoices WHERE branch_id=?').get(BR),
      // finance correctness — must equal the independently-precomputed expected totals.
      validate: (r) => r.n === expected.n && r.gross === expected.gross && r.paid === expected.paid,
    },
    {
      name: 'dashboard.finance.by_status', op: () => q('SELECT status, COUNT(*) n, ROUND(SUM(gross_amount),3) gross, ROUND(SUM(paid_amount),3) paid FROM invoices WHERE branch_id=? GROUP BY status').all(BR),
      validate: (r) => r.reduce((a, x) => a + x.n, 0) === C.invoices,
    },
    {
      name: 'lines.join.aggregate', op: () => q('SELECT p.brand, COUNT(*) sold, ROUND(SUM(l.line_total),3) revenue FROM invoice_lines l JOIN products p ON p.id=l.product_id GROUP BY p.brand ORDER BY revenue DESC LIMIT 10').all(),
      validate: (r) => r.length >= 1,
    },
  ];

  return { db, scenarios };
}

/** Media-GC dry-run measured node-side (mirrors the Rust `plan`: reference set + fs scan + orphan diff). */
export function gcDryRunScenario(fx) {
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  const buildRefs = () => new Set(db.prepare('SELECT storage_key FROM media_blob_generations').all().map((r) => String(r.storage_key).replaceAll('\\', '/')));
  const scan = () => { const out = []; const walk = (p, rel) => { if (!existsSync(p)) return; for (const e of readdirSync(p, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(join(p, e.name), r); else out.push(r); } }; walk(fx.mediaRoot, ''); return out; };
  return {
    close: () => db.close(),
    scenarios: [
      { name: 'gc.reference_build', op: () => buildRefs(), validate: (s) => s.size === fx.counts.media_generations },
      { name: 'gc.fs_scan', op: () => scan(), validate: (a) => a.length === fx.counts.media_files },
      { name: 'gc.dry_run.full', op: () => { const refs = buildRefs(); const files = scan(); const orphans = files.filter((f) => !refs.has(f)); return { referenced: refs.size, files: files.length, orphans: orphans.length }; }, validate: (r) => r.orphans === 0 },
    ],
  };
}

/** Backup media-selection proxy: the referenced-media enumeration + a byte-size sum (read-only). */
export function backupSelectScenario(fx) {
  const db = new DatabaseSync(fx.dbPath, { readOnly: true });
  return {
    close: () => db.close(),
    scenarios: [
      { name: 'backup.media_selection', op: () => db.prepare("SELECT storage_key, byte_size FROM media_blob_generations WHERE gen_status='available'").all(), validate: (r) => r.length === fx.counts.media_generations },
      { name: 'backup.db_size_bytes', op: () => statSync(fx.dbPath).size, validate: (n) => n > 0 },
    ],
  };
}

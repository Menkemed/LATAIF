// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P5 (E12, Owner D-P5-1..3) — Kommissionsgruppe aus Einzelstücken: Aufnahme 1–50, Teilverkauf, je Stück.
// Run: node test/p5/consignment-quantities.test.ts
//
//   §1 Aufnahme 3 Stück (Primary, PC2): 3 Artikel + 3 Kommissionen, Gruppe, Stücknummern, Preis je Stück, Fotos 1× gespeichert
//   §2 Menge 1 / ohne Menge wie bisher; getippte SKU wird SKU-1 … SKU-N
//   §3 ungültige Menge ⇒ Nein (Primary, PC2, Handy), nichts angelegt
//   §4 atomar: vergebene SKU, Fehler im 3. Stück ⇒ nichts; dieselbe PC2-Kennung ⇒ einmal
//   §5 Teilverkauf 2 von 3 über Record Sale — Primary, PC2, Handy (items[]) buchen gleich; Rest 1
//   §6 Teilverkauf über die gemischte Rechnung (P3)
//   §7 je Stück: Post-Sale Return, Cancel Sale, P4-Korrektur (Entfernen, Preis)
//   §8 je Stück: Boden, E7, VAT-Periodensperre
//   §9 Rechte und Rumpf · §10 Helfer der Masken · §11 Migration auf v0.8.98 (zweimal) + Manifest · §12 Quelltext
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
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

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'], ['lataif_sync_token', 'test-token'],
]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
await import('../../src/core/bridge/read-commands.ts');
// Der echte invoice.paid-Handler (Artikel „sold" bei Vollzahlung) — registriert sich beim Laden.
await import('../../src/core/automation/automation-handlers.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const { createInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-create-house.ts');
const { toInvoiceLine } = await import('../../src/core/invoices/line-derivation.ts');
const mixedMod = await import('../../src/core/invoices/mixed-invoice.ts');
const finance = await import('../../src/core/consignment/consignment-finance.ts');
const conHouse = await import('../../src/core/consignment/consignment-finance-house.ts');
const { computeConsignmentSale } = await import('../../src/core/consignment/economics.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useExpenseStore } = await import('../../src/stores/expenseStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { todayIso } = await import('../../src/core/utils/business-date.ts');

type MixIn = import('../../src/core/invoices/mixed-invoice.ts').MixedInvoiceInput;
type Line = MixIn['ownLines'][number];

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-11-07T10:00:00.000Z';
const HEUTE = todayIso();

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Math.round(Number(one(db, sql, p) ?? 0) * 1000) / 1000;
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const a = dbSrc.indexOf('const migrations: string[] = ['); const b = dbSrc.indexOf('\n  ];', a);
  return [...dbSrc.slice(a, b).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = db.exec(`PRAGMA table_info(${table})`)[0].values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) { if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue; data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : ''); }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}
function reload(): void {
  useProductStore.getState().loadProducts(); useCustomerStore.getState().loadCustomers(); useInvoiceStore.getState().loadInvoices();
  useConsignmentStore.getState().loadConsignments(); usePurchaseStore.getState().loadPurchases(); useSupplierStore.getState().loadSuppliers();
  useExpenseStore.getState().loadExpenses();
}
function sitzung(role: string): void { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); }
function freshDb(): Db {
  resetDurabilityStateForTest(); resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const st of MIGRATIONS) { try { db.run(st); } catch { /* da */ } }
  for (const st of A1_UPGRADE_SQL) { try { db.run(st); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora'], ['cust-3', 'Sara']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  insert(db, 'suppliers', { id: 'sup-1', branch_id: 'branch-main', name: 'Händler', created_at: NOW, updated_at: NOW });
  applyMediaSchema(db as never); setTestDatabase(db as never); installWriteGuard(db as never); reload(); tauriState.reset();
  sitzung('ADMIN');
  return db;
}
function imHaus<T>(fn: () => T): T { posting.beginLedgerTransaction(); try { const o = fn(); posting.commitLedgerTransaction(); return o; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } }
const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* test */ }, now: () => NOW });
let seq = 0;
const ident = (op: string, role = 'ADMIN', x?: string) => {
  const k = x ?? String(++seq).padStart(4, '0');
  return { commandId: `0000${k}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role, op, payloadHash: `h${k}` };
};
interface Ausgang { ok: boolean; code: string; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value ?? {}, replayed: o.replayed === true } : { ok: false, code: o.code ?? '?', value: {}, replayed: false };
  } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)), value: {}, replayed: false }; }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)), value: {}, replayed: false }; }
}

// ── Die Welt: zwei eigene Artikel mit Einkauf, drei Kommissionen von zwei Einlieferern, ein Käufer ─────────────
function artikel(db: Db, id: string, name: string, scheme: string): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1500,'in_stock',?,0,'[]','{}','OWN',?,?)`, [id, name, 'SKU-' + id, scheme, NOW, NOW]);
}
function einkauf(pid: string, menge: number, preis: number, vat10: boolean): void {
  imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: menge, unitPrice: preis, taxScheme: vat10 ? 'VAT_10' as const : 'ZERO' as const, vatRate: vat10 ? 10 : 0 }],
  }));
  reload();
}
async function kommission(db: Db, consignorId: string, name: string, payout: Record<string, unknown>): Promise<string> {
  const c = await fern(() => cmd.runConsignmentCreate(deps(db), ident('consignments.create') as never, {
    consignorId, product: { brand: 'Patek', name, categoryId: 'cat-w' }, agreedPrice: 1000, payout,
  }));
  if (!c.ok) throw new Error('setup consignment: ' + c.code);
  reload();
  return String(c.value.consignmentId ?? '');
}
const PCT = { model: 'percent', commissionRate: 20 };
const FIX = { model: 'consignor_fixed' };
interface Welt { db: Db; k1: string; k2: string; k3: string }
async function welt(): Promise<Welt> {
  const db = freshDb();
  artikel(db, 'own-1', 'Datejust eigen', 'MARGIN'); einkauf('own-1', 1, 2000, false);
  artikel(db, 'own-2', 'Goldkette eigen', 'VAT_10'); einkauf('own-2', 2, 550, true);
  const k1 = await kommission(db, 'cust-1', 'Nautilus', PCT);
  const k2 = await kommission(db, 'cust-1', 'Aquanaut', PCT);
  const k3 = await kommission(db, 'cust-3', 'Calatrava', FIX);
  return { db, k1, k2, k3 };
}
const losVon = (db: Db, pid: string): string => s(db, "SELECT id FROM stock_lots WHERE product_id = ? AND qty_remaining > 0 ORDER BY acquired_at, id LIMIT 1", [pid]);
/** Die eigene Zeile so, wie die Maske am Primary sie baut (Los, Einstand des Loses, Steuerart). */
function eigeneZeile(db: Db, pid: string, scheme: 'VAT_10' | 'ZERO' | 'MARGIN', net: number, qty = 1): Line {
  const lot = losVon(db, pid);
  return toInvoiceLine({ productId: pid, lotId: lot, quantity: qty, unitPrice: net, costBasis: n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]), scheme: scheme }) as Line;
}
/** Dieselbe Zeile als ABSICHT, wie die Maske am zweiten Rechner sie schickt. */
function eigeneAbsicht(db: Db, pid: string, scheme: string, net: number, qty = 1): Record<string, unknown> {
  return { productId: pid, lotId: losVon(db, pid), quantity: qty, unitPrice: net, scheme };
}
const conRev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
type Item = MixIn['items'][number];
function standardItems(w: Welt): Item[] {
  return [
    { consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' },
    { consignmentId: w.k2, salePrice: 1100, acknowledgeShortfall: false, taxScheme: 'VAT_10', consignorTaxScheme: 'ZERO' },
    { consignmentId: w.k3, salePrice: 1050, acknowledgeShortfall: false, taxScheme: 'ZERO', consignorTaxScheme: 'VAT_10' },
  ];
}
interface Opt { items?: Item[]; payments?: MixIn['payments']; issuedDate?: string; notes?: string; staffId?: string; ownLines?: 'std' | 'none'; customerId?: string }
function amPrimary(w: Welt, o: Opt = {}): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  const ownLines = o.ownLines === 'none' ? [] : [eigeneZeile(w.db, 'own-1', 'MARGIN', 2500), eigeneZeile(w.db, 'own-2', 'VAT_10', 600)];
  return primary(() => conHouse.createMixedInvoiceOnPrimary({
    customerId: o.customerId ?? 'cust-2', ownLines, items: o.items ?? standardItems(w), issuedDate: o.issuedDate ?? HEUTE,
    notes: o.notes ?? 'Lieferung Freitag', ...(o.staffId ? { staffId: o.staffId } : {}), specialMark: false, ...(o.payments ? { payments: o.payments } : {}),
  }));
}
function rumpf(w: Welt, o: Opt = {}): Record<string, unknown> {
  const ownLines = o.ownLines === 'none' ? [] : [eigeneAbsicht(w.db, 'own-1', 'MARGIN', 2500), eigeneAbsicht(w.db, 'own-2', 'VAT_10', 600)];
  const items = o.items ?? standardItems(w);
  return mixedMod.mixedInvoiceBody({
    customerId: o.customerId ?? 'cust-2', items, issuedDate: o.issuedDate ?? HEUTE, notes: o.notes ?? 'Lieferung Freitag',
    ...(o.staffId ? { staffId: o.staffId } : {}), specialMark: false, ...(o.payments ? { payments: o.payments } : {}),
  }, ownLines, Object.fromEntries(items.map((it) => [it.consignmentId, conRev(w.db, it.consignmentId)])));
}
function amPC2(w: Welt, o: Opt = {}, role = 'ADMIN', x?: string): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  return fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale', role, x) as never, rumpf(w, o)));
}
const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM invoice_lines'), n(db, 'SELECT COUNT(*) FROM purchases'),
  n(db, 'SELECT COUNT(*) FROM expenses'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM payments'),
  all(db, 'SELECT status FROM consignments ORDER BY consignment_number'), all(db, 'SELECT product_id, qty_remaining FROM stock_lots ORDER BY product_id, id'),
  n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'mixed_invoice'")]);

// Was eine Rechnung fachlich ist — ohne Kennungen, Zeitstempel und Nummern (Primary und PC2 vergleichbar).
function bild(db: Db, invoiceId: string): Record<string, unknown> {
  const name = (pid: unknown): string => s(db, 'SELECT name FROM products WHERE id = ?', [pid]);
  const kopf = db.exec('SELECT customer_id, status, ROUND(net_amount,3), ROUND(vat_amount,3), ROUND(gross_amount,3), ROUND(paid_amount,3), tax_scheme_snapshot, notes, staff_id FROM invoices WHERE id = ?', [invoiceId])[0]?.values?.[0] ?? [];
  const zeilen = (db.exec(`SELECT product_id, quantity, ROUND(unit_price,3), ROUND(purchase_price_snapshot,3), tax_scheme, ROUND(vat_amount,3), ROUND(line_total,3), lot_id IS NOT NULL
      FROM invoice_lines WHERE invoice_id = ? ORDER BY position, rowid`, [invoiceId])[0]?.values ?? []).map((r) => [name(r[0]), ...r.slice(1)]);
  const einkaeufe = (db.exec(`SELECT p.supplier_id, ROUND(p.total_amount,3), ROUND(p.remaining_amount,3), p.status, p.purchase_date FROM purchases p
      WHERE p.supplier_id != 'sup-1' ORDER BY p.total_amount`)[0]?.values ?? []).map((r) => [s(db, 'SELECT name FROM suppliers WHERE id = ?', [r[0]]), ...r.slice(1)]);
  const elines = (db.exec(`SELECT pl.product_id, ROUND(pl.unit_price,3), pl.tax_scheme, ROUND(pl.vat_amount,3), ROUND(pl.line_total,3) FROM purchase_lines pl
      JOIN purchases p ON p.id = pl.purchase_id WHERE p.supplier_id != 'sup-1' ORDER BY pl.line_total, pl.product_id`)[0]?.values ?? []).map((r) => [name(r[0]), ...r.slice(1)]);
  const kons = (db.exec(`SELECT product_id, status, ROUND(sale_price,3), ROUND(commission_amount,3), ROUND(payout_amount,3), buyer_id, invoice_id = ? FROM consignments ORDER BY consignment_number`, [invoiceId])[0]?.values ?? [])
    .map((r) => [name(r[0]), ...r.slice(1)]);
  const konten = all(db, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net FROM ledger_entries GROUP BY account HAVING ABS(net) > 0.0005 ORDER BY account`);
  const bestand = all(db, "SELECT p.name, p.quantity, p.stock_status FROM products p ORDER BY p.name");
  return { kopf, zeilen, einkaeufe, elines, kons, konten, bestand };
}
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id, SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
/** Lager im Hauptbuch == Wert der aktiven Lose; AP == offene Einkäufe + offene Ausgaben; AR == offene Rechnungen; ausgeglichen. */
function abgleich(db: Db): string[] {
  const k = Object.fromEntries((db.exec(`SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries GROUP BY account`)[0]?.values ?? [])
    .map((r) => [String(r[0]), Number(r[1])]));
  const lose = n(db, "SELECT COALESCE(ROUND(SUM(qty_remaining * unit_cost), 3), 0) FROM stock_lots WHERE status = 'ACTIVE'");
  const ap = n(db, `SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
    + COALESCE((SELECT SUM(amount - paid_amount) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3)`);
  const ar = n(db, "SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) FROM invoices WHERE status != 'CANCELLED'");
  const out: string[] = [];
  if (!balanced(db)) out.push('unbalanced');
  if (Math.abs((k.INVENTORY ?? 0) - lose) > 0.005) out.push(`INVENTORY ${k.INVENTORY ?? 0} vs lots ${lose}`);
  if (Math.abs(-(k.ACCOUNTS_PAYABLE ?? 0) - ap) > 0.005) out.push(`AP ${-(k.ACCOUNTS_PAYABLE ?? 0)} vs domain ${ap}`);
  if (Math.abs((k.ACCOUNTS_RECEIVABLE ?? 0) - ar) > 0.005) out.push(`AR ${k.ACCOUNTS_RECEIVABLE ?? 0} vs invoices ${ar}`);
  return out;
}
const invVon = (r: Ausgang): string => String(r.value.invoiceId ?? '');

function faulty(db: Db, when: (sql: string, p?: unknown[]) => boolean) {
  const f = { armed: true, fired: false };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') return (sql: string, p?: unknown[]) => { if (f.armed && when(sql, p)) { f.fired = true; throw new Error('P3: injected failure'); } return (t as Db).run(sql, p); };
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}
// ════════════════════════════════════════════════════════════════════════════
// P4 — die Hilfen der Korrektur
// ════════════════════════════════════════════════════════════════════════════
const korr = await import('../../src/core/invoices/mixed-invoice-correction.ts');
const invLife = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { editInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-edit-house.ts');
const { recordSupplierCreditRefundInHouse, recordPurchasePaymentInHouse, recordExpensePaymentInHouse, applyOneCreditToPurchaseInHouse } = await import('../../src/core/payables/payables-house.ts');
type Korr = import('../../src/core/invoices/mixed-invoice.ts').MixedCorrectionItem;
type KorrIn = import('../../src/core/invoices/mixed-invoice-correction.ts').MixedInvoiceCorrectionInput;

const { creditNoteReceivableCancel } = await import('../../src/core/invoices/edit-lines.ts');
const ctxH = { branchId: 'branch-main', userId: 'user-test', now: NOW };
const konsProdukte = (db: Db, inv: string): string[] => (db.exec('SELECT product_id FROM consignments WHERE invoice_id = ?', [inv])[0]?.values ?? []).map((r) => String(r[0]));
/** Die eigenen Zeilen so, wie die Maske des Primary sie beim Ändern schickt (Zeilen-ID, Los, Einstand). */
function eigeneEdit(db: Db, inv: string, preis: Record<string, number> = {}): KorrIn['ownLines'] {
  const kp = new Set(konsProdukte(db, inv));
  return (db.exec(`SELECT id, product_id, lot_id, quantity, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total
      FROM invoice_lines WHERE invoice_id = ? ORDER BY position`, [inv])[0]?.values ?? [])
    .filter((r) => !kp.has(String(r[1])))
    .map((r) => ({ lineId: String(r[0]), productId: String(r[1]), lotId: String(r[2] ?? '') || undefined, quantity: Number(r[3]),
      unitPrice: preis[String(r[1])] ?? Number(r[4]), purchasePrice: Number(r[5]), taxScheme: String(r[6]), vatRate: Number(r[7]),
      vatAmount: Number(r[8]), lineTotal: Number(r[9]) }));
}
/** Dieselben eigenen Zeilen als Absicht (PC2). */
function eigeneAbsichtEdit(db: Db, inv: string, preis: Record<string, number> = {}): Array<Record<string, unknown>> {
  return eigeneEdit(db, inv, preis).map((l) => ({ lineId: l.lineId, productId: l.productId, lotId: l.lotId ?? null, quantity: l.quantity,
    unitPrice: l.unitPrice, scheme: l.taxScheme }));
}
/** Die Kommissionszeilen, wie sie stehen (Preis = Brutto der Zeile). */
function kommIst(db: Db, inv: string): Korr[] {
  return (db.exec(`SELECT c.id, il.line_total, il.tax_scheme FROM consignments c JOIN invoice_lines il ON il.invoice_id = c.invoice_id AND il.product_id = c.product_id
      WHERE c.invoice_id = ? ORDER BY il.position`, [inv])[0]?.values ?? [])
    .map((r) => ({ consignmentId: String(r[0]), salePrice: Math.round(Number(r[1]) * 1000) / 1000, taxScheme: String(r[2]) as Korr['taxScheme'] }));
}
function revisionen(db: Db, inv: string, extra: string[] = []): { consignmentRevisions: Record<string, number>; purchaseRevisions: Record<string, number> } {
  const cids = [...(db.exec('SELECT id FROM consignments WHERE invoice_id = ?', [inv])[0]?.values ?? []).map((r) => String(r[0])), ...extra];
  return {
    consignmentRevisions: Object.fromEntries(cids.map((id) => [id, conRev(db, id)])),
    purchaseRevisions: Object.fromEntries((db.exec("SELECT id, revision FROM purchases WHERE supplier_id != 'sup-1'")[0]?.values ?? []).map((r) => [String(r[0]), Number(r[1])])),
  };
}
interface KOpt {
  items?: (ist: Korr[]) => Korr[]; extra?: string[]; preis?: Record<string, number>; own?: 'none';
  customerId?: string; issuedAt?: string; reason?: string; confirmCustomerChange?: boolean; overpayChoice?: 'credit' | 'refund';
  purchaseTaxSchemes?: Record<string, 'ZERO' | 'VAT_10'>; consignorTaxSchemes?: Record<string, 'ZERO' | 'VAT_10'>;
  consignorOverpay?: Record<string, 'credit' | 'refund'>; lossOverpay?: Record<string, 'credit' | 'refund'>; revs?: (r: ReturnType<typeof revisionen>) => ReturnType<typeof revisionen>;
}
function korrekturTeil(db: Db, inv: string, o: KOpt) {
  const ist = kommIst(db, inv);
  const r0 = revisionen(db, inv, o.extra ?? []);
  const r = o.revs ? o.revs(r0) : r0;
  return {
    items: o.items ? o.items(ist) : ist, ...r,
    ...(o.purchaseTaxSchemes ? { purchaseTaxSchemes: o.purchaseTaxSchemes } : {}),
    ...(o.consignorTaxSchemes ? { consignorTaxSchemes: o.consignorTaxSchemes } : {}),
    ...(o.consignorOverpay ? { consignorOverpay: o.consignorOverpay } : {}),
    ...(o.lossOverpay ? { lossOverpay: o.lossOverpay } : {}),
  };
}
const invRev = (db: Db, inv: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
function korrPrimary(w: Welt, inv: string, o: KOpt = {}): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  return primary(() => korr.correctMixedInvoiceOnPrimary({
    invoiceId: inv, expectedRevision: invRev(w.db, inv), reason: o.reason ?? 'Fehler korrigiert',
    ownLines: o.own === 'none' ? [] : eigeneEdit(w.db, inv, o.preis ?? {}),
    ...(o.customerId ? { customerId: o.customerId } : {}), ...(o.issuedAt ? { issuedAt: o.issuedAt } : {}),
    ...(o.confirmCustomerChange ? { confirmCustomerChange: true } : {}), ...(o.overpayChoice ? { overpayChoice: o.overpayChoice } : {}),
    consignment: korrekturTeil(w.db, inv, o),
  }));
}
function korrRumpf(w: Welt, inv: string, o: KOpt = {}): Record<string, unknown> {
  const kopf = w.db.exec('SELECT customer_id FROM invoices WHERE id = ?', [inv])[0]?.values?.[0] ?? [];
  return {
    id: inv, expectedRevision: invRev(w.db, inv), reason: o.reason ?? 'Fehler korrigiert', customerId: o.customerId ?? String(kopf[0]),
    lines: o.own === 'none' ? [] : eigeneAbsichtEdit(w.db, inv, o.preis ?? {}),
    ...(o.issuedAt ? { issuedDate: o.issuedAt } : {}), ...(o.confirmCustomerChange ? { confirmCustomerChange: true } : {}),
    ...(o.overpayChoice ? { overpayChoice: o.overpayChoice } : {}),
    consignment: mixedMod.mixedCorrectionBody(korrekturTeil(w.db, inv, o)),
  };
}
function korrPC2(w: Welt, inv: string, o: KOpt = {}, role = 'ADMIN', x?: string): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  return fern(() => invLife.runInvoiceUpdate(deps(w.db), ident('invoices.update', role, x) as never, korrRumpf(w, inv, o)));
}
const korrWeg = (weg: 'primary' | 'pc2', w: Welt, inv: string, o: KOpt = {}): Promise<Ausgang> => (weg === 'primary' ? korrPrimary(w, inv, o) : korrPC2(w, inv, o));
/** Supplier-Credits im Hauptbuch == offene Guthaben; dazu der Abgleich aus P3. */
function abgleich4(db: Db): string[] {
  // AR: offene Rechnungen abzüglich Gutschriften (Retouren), dazu die Umgliederung einer Kundenüberzahlung (P1c).
  // AP: offene Einkäufe + offene Ausgaben, je Ausgabe nie unter 0 (eine Überzahlung lebt als Lieferanten-Guthaben — wie im
  // Gegenparteien-Abgleich des Hauses, `counterpartyAudit`: Zahlungen je Ausgabe auf ihren Betrag gedeckelt).
  const out = abgleich(db).filter((x) => !x.startsWith('AR ') && !x.startsWith('AP '));
  const apLedger = -n(db, "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE'");
  const apDom = n(db, `SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
    + COALESCE((SELECT SUM(MAX(0, amount - paid_amount)) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3)`);
  if (Math.abs(apLedger - apDom) > 0.005) out.push(`AP ${apLedger} vs domain ${apDom}`);
  const arLedger = n(db, "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE'");
  const offen = (db.exec("SELECT id, gross_amount - paid_amount FROM invoices WHERE status != 'CANCELLED'")[0]?.values ?? [])
    .reduce((x, r) => x + Number(r[1]) - creditNoteReceivableCancel(String(r[0])), 0);
  const umgegliedert = n(db, "SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE source_type = 'invoice_edit'");
  if (Math.abs(arLedger - (offen + umgegliedert)) > 0.005) out.push(`AR ${arLedger} vs invoices ${Math.round((offen + umgegliedert) * 1000) / 1000}`);
  const sc = n(db, `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'SUPPLIER_CREDIT'`);
  const dom = n(db, "SELECT COALESCE(ROUND(SUM(amount - used_amount), 3), 0) FROM supplier_credits WHERE status IN ('OPEN', 'REFUND_DUE')");
  if (Math.abs(sc - dom) > 0.005) out.push(`SUPPLIER_CREDIT ${sc} vs credits ${dom}`);
  return out;
}
const zaehler4 = (db: Db): string => S([zaehler(db), n(db, 'SELECT COUNT(*) FROM purchase_lines'), n(db, 'SELECT COUNT(*) FROM supplier_credits'),
  n(db, 'SELECT COUNT(*) FROM purchase_returns'), all(db, 'SELECT status, ROUND(total_amount,3), ROUND(remaining_amount,3) FROM purchases ORDER BY id'),
  all(db, 'SELECT ROUND(amount,3), status FROM expenses ORDER BY id'), all(db, 'SELECT ROUND(line_total,3), tax_scheme FROM invoice_lines ORDER BY id'),
  n(db, 'SELECT COUNT(*) FROM invoice_edits')]);
const einkaufVon = (db: Db, consignorId: string): string => s(db, `SELECT p.id FROM purchases p JOIN suppliers su ON su.id = p.supplier_id
  WHERE su.name = (SELECT first_name || ' ' || last_name FROM customers WHERE id = ?) AND p.status != 'CANCELLED' ORDER BY p.created_at LIMIT 1`, [consignorId]);
const einkaeufeVon = (db: Db, supplierLike: string): string => all(db, `SELECT p.status, ROUND(p.total_amount,3), ROUND(p.paid_amount,3), ROUND(p.remaining_amount,3) FROM purchases p
  WHERE p.supplier_id != 'sup-1' AND p.notes LIKE ? ORDER BY p.created_at, p.id`, [`%${supplierLike}%`]);
async function gemischt(): Promise<{ w: Welt; inv: string }> {
  const w = await welt();
  const r = await amPrimary(w);
  if (!r.ok) throw new Error('setup mixed invoice: ' + r.code);
  reload();
  return { w, inv: invVon(r) };
}
const nr = (db: Db, id: string): string => s(db, 'SELECT consignment_number FROM consignments WHERE id = ?', [id]);
const pidVon = (db: Db, cid: string): string => s(db, 'SELECT product_id FROM consignments WHERE id = ?', [cid]);
/** Der Einlieferer-Einkauf einer Kommission (Kopf oder Zeile). */
const einkaufDer = (db: Db, cid: string): string => s(db, `SELECT p.id FROM purchases p WHERE p.status != 'CANCELLED'
  AND (p.source_consignment_id = ? OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?)) ORDER BY p.created_at LIMIT 1`, [cid, cid]);
function bezahleEinkauf(db: Db, pid: string, betrag: number): void {
  setTestDatabase(db as never);
  imHaus(() => recordPurchasePaymentInHouse(pid, betrag, 'cash', ctxH));
  reload();
}


// ════════════════════════════════════════════════════════════════════════════
// P5 — die Hilfen der Gruppe
// ════════════════════════════════════════════════════════════════════════════
const { stageForTest } = await import('../bridge/_tauri-shim.ts');
const grp = await import('../../src/core/consignment/consignment-group.ts');
const conCreate = await import('../../src/core/consignment/consignment-create.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const { rowToConsignment } = await import('../../src/stores/consignmentStore.ts');
const { execFileSync } = await import('node:child_process');
const mobileBox: Record<string, unknown> = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js').replace(/\r\n/g, '\n'))(mobileBox);
new Function('self', src('src-tauri/src/sync/mobile_consignment_commands.js').replace(/\r\n/g, '\n'))(mobileBox);
const Mobile = mobileBox.MobileConsignment as {
  createBody(form: Record<string, unknown>, ids?: string[], o?: Record<string, unknown>): { ok: boolean; code?: string; body?: Record<string, unknown> };
  groupSaleBody(con: Record<string, unknown>, k: unknown, form: Record<string, unknown>, o?: Record<string, unknown>): { ok: boolean; code?: string; body?: Record<string, unknown> };
  availablePieces(con: Record<string, unknown>): Array<Record<string, unknown>>;
  MAX_GROUP: number;
};

/** Ein Bild, das der echten Ablage genügt — abgelegt für den Absender des PC2-Auftrags. */
function bildVon(seed: string, userId = 'user-pc2'): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i * 7) & 0xff;
  return stageForTest(bytes, { tenantId: 'tenant-1', branchId: 'branch-main', userId });
}
function dataUrlVon(seed: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i * 7) & 0xff;
  return 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
}
const GRUPPE = { consignorId: 'cust-1', product: { brand: 'Mikimoto', name: 'Perlenstecker', categoryId: 'cat-w' }, agreedPrice: 400, minimumPrice: 380,
  payout: { model: 'percent', commissionRate: 20 }, acknowledgeDuplicate: true };
const gruppenEingabe = (o: Record<string, unknown> = {}) => {
  const { product, ...rest } = o;
  return {
    consignorId: 'cust-1', product: { brand: 'Mikimoto', name: 'Perlenstecker', categoryId: 'cat-w', ...((product as object) ?? {}) },
    agreedPrice: 400, minimumPrice: 380, payout: { model: 'percent', commissionRate: 20 }, ...rest,
  } as never;
};
async function gruppePC2(db: Db, menge: unknown, o: Record<string, unknown> = {}, x?: string): Promise<Ausgang> {
  setTestDatabase(db as never); reload();
  const body: Record<string, unknown> = { ...GRUPPE, ...o, ...(menge === undefined ? {} : { quantity: menge }) };
  return fern(() => cmd.runConsignmentCreate(deps(db), ident('consignments.create', 'ADMIN', x) as never, body));
}
async function gruppePrimary(db: Db, menge: number | undefined, o: Record<string, unknown> = {}, bilder: string[] = []): Promise<Ausgang> {
  setTestDatabase(db as never); reload();
  return primary(() => conCreate.createConsignmentOnPrimary(gruppenEingabe({ ...o, ...(menge === undefined ? {} : { quantity: menge }) }), { kind: 'data_urls', images: bilder }));
}
const stuecke = (db: Db, gid: string): string[] => (db.exec('SELECT id FROM consignments WHERE group_id = ? ORDER BY group_seq', [gid])[0]?.values ?? []).map((r) => String(r[0]));
const zaehlerAnlage = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM products'), n(db, 'SELECT COUNT(*) FROM consignments'), n(db, 'SELECT COUNT(*) FROM media_links'),
  n(db, 'SELECT COUNT(*) FROM media_objects'), n(db, 'SELECT COUNT(*) FROM media_blobs'), all(db, 'SELECT * FROM sku_sequences ORDER BY 1'),
  n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'consignment_group_created'"), n(db, 'SELECT COUNT(*) FROM audit_log')]);
/** Was eine Aufnahme fachlich ist — ohne Kennungen und Zeitstempel (Primary und PC2 vergleichbar). */
function anlageBild(db: Db, gid: string): unknown {
  return {
    kons: (db.exec(`SELECT c.group_seq, c.group_quantity, c.status, c.agreed_price, c.minimum_price, c.commission_type, c.commission_rate, c.consignor_id,
        p.name, p.quantity, p.stock_status, p.source_type, ROUND(p.purchase_price,3)
      FROM consignments c JOIN products p ON p.id = c.product_id WHERE c.group_id = ? ORDER BY c.group_seq`, [gid])[0]?.values ?? []),
    links: n(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id IN (SELECT product_id FROM consignments WHERE group_id = ?) AND deleted_at IS NULL', [gid]),
    blobs: n(db, 'SELECT COUNT(DISTINCT mo.master_blob_id) FROM media_objects mo JOIN media_links ml ON ml.media_id = mo.media_id WHERE ml.entity_id IN (SELECT product_id FROM consignments WHERE group_id = ?)', [gid]),
  };
}
const ACT = (over: Record<string, unknown> = {}) => ({ commandId: '00000999-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', payloadHash: 'h999', ...over });
async function lies(op: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await executeCommand(op, { actor: ACT(), input }, undefined) as { kind: string; value?: Record<string, unknown>; code?: string };
  if (r.kind !== 'ok') throw new Error(`${op}: ${r.kind} ${r.code ?? ''}`);
  return r.value ?? {};
}
/** Die Welt für Verkäufe: ein eigener Artikel mit Einkauf und eine Gruppe von 3 Perlensteckern (Einlieferer Ali). */
async function gruppenWelt(weg: 'primary' | 'pc2' = 'pc2'): Promise<{ w: Welt; gid: string; teile: string[] }> {
  const db = freshDb();
  artikel(db, 'own-1', 'Datejust eigen', 'MARGIN'); einkauf('own-1', 1, 2000, false);
  const r = weg === 'pc2' ? await gruppePC2(db, 3) : await gruppePrimary(db, 3);
  if (!r.ok) throw new Error('setup group: ' + r.code);
  reload();
  const gid = String(r.value.groupId ?? '');
  return { w: { db, k1: '', k2: '', k3: '' }, gid, teile: stuecke(db, gid) };
}
const posten = (ids: string[], preis: number, o: Partial<Item> = {}): Item[] => ids.map((id) => ({ consignmentId: id, salePrice: preis, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO', ...o }) as Item);
const gruppenStand = (db: Db, gid: string): string => all(db, 'SELECT group_seq, status, invoice_id IS NOT NULL FROM consignments WHERE group_id = ? ORDER BY group_seq', [gid]);
function verkaufPrimary(w: Welt, items: Item[], buyerId = 'cust-2'): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  return primary(() => conHouse.recordConsignmentSalesOnPrimary({ items, buyerId, specialMark: false }));
}
function verkaufPC2(w: Welt, items: Item[], buyerId = 'cust-2', x?: string): Promise<Ausgang> {
  setTestDatabase(w.db as never); reload();
  const revs = Object.fromEntries(items.map((it) => [it.consignmentId, conRev(w.db, it.consignmentId)]));
  return fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale', 'ADMIN', x) as never, finance.consignmentSalesBody({ items, buyerId, specialMark: false }, revs)));
}
/** Was ein Verkauf fachlich ist (Rechnung, Einkauf, Kommissionen) — Primary und PC2 vergleichbar. */
function verkaufBild(db: Db, inv: string): unknown {
  const b = bild(db, inv) as Record<string, unknown>;
  return { zeilen: b.zeilen, einkaeufe: b.einkaeufe, elines: b.elines, konten: b.konten, kopf: (b.kopf as unknown[]).slice(0, 7),
    gruppe: all(db, 'SELECT group_seq, status, ROUND(sale_price,3), ROUND(payout_amount,3), buyer_id FROM consignments ORDER BY group_seq') };
}

// ══ §1 Aufnahme 3 Stück als Gruppe — Primary und PC2 gleich; Fotos einmal gespeichert, je Stück verknüpft ═══════════
{
  const bilder: unknown[] = [];
  for (const weg of ['primary', 'pc2'] as const) {
    const db = freshDb();
    tauriState.reset();
    const r = weg === 'primary'
      ? await gruppePrimary(db, 3, {}, [dataUrlVon('perle-a'), dataUrlVon('perle-b')])
      : await gruppePC2(db, 3, { stagingIds: [bildVon('perle-a'), bildVon('perle-b')] });
    reload();
    ok(r.ok, `§1 ${weg}: Aufnahme mit Menge 3 gelingt (${r.code || 'ok'})`);
    if (!r.ok) continue;
    const gid = String(r.value.groupId ?? (r.value as { groupId?: string }).groupId ?? '');
    const pieces = (r.value.pieces ?? []) as Array<Record<string, unknown>>;
    ok(gid !== '' && pieces.length === 3 && (weg === 'primary' || r.value.quantity === 3),
      `§1 ${weg}: die Antwort nennt Gruppe und alle 3 Stücke (${gid} / ${pieces.length})`);
    const ids = stuecke(db, gid);
    ok(ids.length === 3 && n(db, 'SELECT COUNT(*) FROM consignments') === 3 && n(db, "SELECT COUNT(*) FROM products WHERE source_type = 'CONSIGNMENT'") === 3,
      `§1 ${weg}: 3 Kommissionen und 3 eigene Artikel (${ids.length})`);
    ok(all(db, 'SELECT group_seq, group_quantity FROM consignments ORDER BY group_seq') === '[[1,3],[2,3],[3,3]]',
      `§1 ${weg}: Stücknummern 1..3, ursprüngliche Menge 3 (${all(db, 'SELECT group_seq, group_quantity FROM consignments ORDER BY group_seq')})`);
    const skus = (db.exec('SELECT p.sku FROM consignments c JOIN products p ON p.id = c.product_id ORDER BY c.group_seq')[0]?.values ?? []).map((v) => String(v[0]));
    ok(new Set(skus).size === 3 && skus.every((k) => k.length > 0), `§1 ${weg}: jede SKU eigen, aus dem Zähler (${skus.join(', ')})`);
    ok(all(db, 'SELECT DISTINCT agreed_price, minimum_price, commission_type, commission_rate, status FROM consignments') === '[[400,380,"percent",20,"active"]]',
      `§1 ${weg}: Preis und Minimum JE STÜCK (D-P5-2), dasselbe Modell, alle aktiv`);
    ok(all(db, "SELECT DISTINCT quantity, stock_status, ROUND(purchase_price,3) FROM products WHERE source_type = 'CONSIGNMENT'") === '[[1,"consignment",320]]',
      `§1 ${weg}: je Artikel Menge 1, Kommissionsbestand, erwarteter Einstand 320 je Stück`);
    const mb = anlageBild(db, gid) as { links: number; blobs: number };
    // Vergleich: dieselben 2 Fotos an EINER Einzelaufnahme — eine Gruppe darf keine einzige Datei mehr speichern.
    const ref = freshDb();
    tauriState.reset();
    const einzel = weg === 'primary'
      ? await gruppePrimary(ref, 1, {}, [dataUrlVon('perle-a'), dataUrlVon('perle-b')])
      : await gruppePC2(ref, 1, { stagingIds: [bildVon('perle-a'), bildVon('perle-b')] });
    const blobsEinzel = n(ref, 'SELECT COUNT(*) FROM media_blobs');
    setTestDatabase(db as never); reload();
    ok(einzel.ok && mb.links === 6 && mb.blobs === 2 && n(db, 'SELECT COUNT(*) FROM media_blobs') === blobsEinzel && blobsEinzel > 0,
      `§1 ${weg}: 2 Fotos je Stück verknüpft (6 Verknüpfungen), gespeichert wie bei EINEM Stück (${mb.links} / ${mb.blobs} / ${n(db, 'SELECT COUNT(*) FROM media_blobs')} = ${blobsEinzel})`);
    ok(n(db, 'SELECT COUNT(*) FROM media_links WHERE is_primary = 1') === 3, `§1 ${weg}: je Stück ein Hauptbild`);
    const audit = s(db, "SELECT new_value FROM audit_log WHERE field_name = 'consignment_group_created'");
    ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'consignment_group_created'") === 1 && JSON.parse(audit || '{}').quantity === 3
      && (JSON.parse(audit || '{}').consignments ?? []).length === 3 && JSON.parse(audit || '{}').groupId === gid,
      `§1 ${weg}: Protokoll der Gruppe (Menge, Stücke, Kennung) (${audit.slice(0, 120)})`);
    ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'consignments' AND action_type = 'CREATE' AND field_name IS NULL") === 3,
      `§1 ${weg}: jede Kommission wird einzeln angelegt und protokolliert (trackInsert je Stück) (${n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'consignments' AND action_type = 'CREATE' AND field_name IS NULL")})`);
    if (weg === 'pc2') ok(tauriState.discarded.length === 2, `§1 pc2: die Ablage ist nach dem Erfolg geräumt (${tauriState.discarded.length})`);
    // Lesemodell: Store, PC2-Liste und PC2-Auskunft tragen die Gruppe.
    const c2 = rowToConsignment(db.exec('SELECT * FROM consignments WHERE id = ?', [ids[1]])[0] ? Object.fromEntries(db.exec('SELECT * FROM consignments WHERE id = ?', [ids[1]])[0].columns.map((k, i) => [k, db.exec('SELECT * FROM consignments WHERE id = ?', [ids[1]])[0].values[0][i]])) : {});
    ok(c2.groupId === gid && c2.groupSeq === 2 && c2.groupQuantity === 3, `§1 ${weg}: der Store liest Gruppe, Stück 2 von 3`);
    const liste = await lies('consignments.list', {});
    const li = (liste.items as Array<Record<string, unknown>>).find((x) => x.id === ids[2]);
    ok(li?.groupId === gid && li?.groupSeq === 3 && li?.groupQuantity === 3, `§1 ${weg}: die PC2-Liste trägt Gruppe, Stück und Menge (${S(li).slice(0, 160)})`);
    const get = await lies('consignments.get', { id: ids[0] });
    const g = get.group as Array<Record<string, unknown>>;
    ok(Array.isArray(g) && g.length === 3 && S(g.map((x) => [x.groupSeq, x.status, typeof x.revision])) === S([[1, 'active', 'number'], [2, 'active', 'number'], [3, 'active', 'number']]),
      `§1 ${weg}: die PC2-Auskunft nennt alle Stücke mit Status und Fassung (${S(g).slice(0, 200)})`);
    const zs = grp.summarizeGroup(useConsignmentStore.getState().consignments.filter((c) => c.groupId === gid));
    ok(zs?.quantity === 3 && zs.available === 3 && grp.groupStatusLine(zs) === 'Group of 3 · 3 available', `§1 ${weg}: Anzeige „Group of 3 · 3 available" (${zs ? grp.groupStatusLine(zs) : '—'})`);
    bilder.push(anlageBild(db, gid));
  }
  if (bilder.length === 2) ok(S(bilder[0]) === S(bilder[1]), `§1 Primary und PC2 legen GLEICH an (${S(bilder[0]).slice(0, 200)} vs ${S(bilder[1]).slice(0, 200)})`);
}

// ══ §2 Menge 1 / ohne Menge = wie bisher; getippte SKU wird SKU-1 … SKU-N ══════════════════════════════════════
{
  const db = freshDb();
  const ohne = await gruppePC2(db, undefined, { product: { ...GRUPPE.product, sku: 'EINZEL-1' } });
  const eins = await gruppePrimary(db, 1, { product: { sku: 'EINZEL-2' } });
  reload();
  ok(ohne.ok && eins.ok && n(db, 'SELECT COUNT(*) FROM consignments') === 2 && n(db, 'SELECT COUNT(*) FROM consignments WHERE group_id IS NOT NULL OR group_seq IS NOT NULL OR group_quantity IS NOT NULL') === 0,
    `§2 ohne Menge und mit Menge 1: je EINE Kommission ohne Gruppe, wie bisher (${ohne.code || 'ok'} / ${eins.code || 'ok'})`);
  ok(!('groupId' in ohne.value) && !('pieces' in ohne.value) && n(db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'consignment_group_created'") === 0,
    '§2 …die Antwort einer Einzelaufnahme bleibt wie bisher (keine Gruppe, kein Gruppenprotokoll)');
  const req1 = conCreate.consignmentCreateRequest(gruppenEingabe({ quantity: 1 }), []);
  const req3 = conCreate.consignmentCreateRequest(gruppenEingabe({ quantity: 3 }), []);
  ok(!('quantity' in req1) && req3.quantity === 3, '§2 der PC2-Rumpf trägt die Menge nur ab 2 Stücken (ein älterer Primary weist eine Gruppe ab, statt still 1 anzulegen)');
  const getippt = await gruppePC2(db, 4, { product: { ...GRUPPE.product, sku: ' PRL ' } });
  reload();
  const skus = (db.exec('SELECT p.sku FROM consignments c JOIN products p ON p.id = c.product_id WHERE c.group_id = ? ORDER BY c.group_seq', [String(getippt.value.groupId ?? '')])[0]?.values ?? []).map((v) => String(v[0]));
  ok(getippt.ok && S(skus) === S(['PRL-1', 'PRL-2', 'PRL-3', 'PRL-4']) && (getippt.value.sku === 'PRL-1'),
    `§2 eine getippte SKU wird je Stück PRL-1 … PRL-4 (${skus.join(', ')})`);
  ok(conCreate.groupPieceSku('ABC', 2, 3) === 'ABC-2' && conCreate.groupPieceSku('ABC', 1, 1) === 'ABC', '§2 groupPieceSku: Suffix nur bei einer Gruppe');
  // Obergrenze: 50 Stück in EINEM Auftrag (mit Foto) — eine Transaktion, 50 Nummern, 50 SKUs; die Dauer wird ausgewiesen.
  const db50 = freshDb();
  tauriState.reset();
  const t0 = Date.now();
  const r50 = await gruppePC2(db50, 50, { stagingIds: [bildVon('perle-50')] });
  const dauer = Date.now() - t0;
  reload();
  ok(r50.ok && n(db50, 'SELECT COUNT(*) FROM consignments') === 50 && n(db50, 'SELECT COUNT(DISTINCT consignment_number) FROM consignments') === 50
    && n(db50, 'SELECT COUNT(DISTINCT p.sku) FROM products p') === 50 && n(db50, 'SELECT MAX(group_seq) FROM consignments') === 50
    && n(db50, 'SELECT COUNT(*) FROM media_links') === 50,
    `§2 Menge 50: 50 Kommissionen, 50 Nummern, 50 SKUs, 50 Verknüpfungen in EINEM Auftrag (${r50.code || 'ok'}, ${dauer} ms)`);
  console.log(`  (Info) Aufnahme von 50 Stück: ${dauer} ms`);
}

// ══ §3 Ungültige Menge ⇒ Nein, nichts angelegt (Primary, PC2, Handy) ═════════════════════════════════════════════
{
  const db = freshDb();
  const vorher = zaehlerAnlage(db);
  for (const q of [0, 51, 1.5, -2]) {
    const p = await gruppePrimary(db, q as number);
    ok(!p.ok && p.code === 'QUANTITY_INVALID', `§3 Primary Menge ${q} ⇒ QUANTITY_INVALID (${p.code})`);
  }
  for (const q of [0, 51, 1.5, '3', true, -1]) {
    const f = await gruppePC2(db, q);
    ok(!f.ok, `§3 PC2 Menge ${S(q)} ⇒ Nein (${f.code})`);
  }
  ok(zaehlerAnlage(db) === vorher, `§3 nichts angelegt (${zaehlerAnlage(db)})`);
  ok(conCreate.consignmentQuantityIssue(undefined) === null && conCreate.consignmentQuantityIssue(50) === null && conCreate.consignmentQuantityIssue(51) !== null,
    '§3 die Mengenregel: ohne Angabe 1, höchstens 50');
  const form = { consignorId: 'cust-1', categoryId: 'cat-w', agreedPrice: '400', payoutModel: 'percent', commissionRate: '20' };
  const m3 = Mobile.createBody({ ...form, quantity: '3' });
  const m1 = Mobile.createBody({ ...form, quantity: '1' });
  const mleer = Mobile.createBody({ ...form, quantity: '' });
  ok(m3.ok && m3.body?.quantity === 3 && m1.ok && !('quantity' in (m1.body ?? {})) && mleer.ok && !('quantity' in (mleer.body ?? {})),
    '§3 Handy: Menge 3 reist als Zahl, 1 oder leer reist nicht (wie bisher)');
  ok(['0', '51', '1.5', 'drei', '-1'].every((q) => Mobile.createBody({ ...form, quantity: q }).code === 'QUANTITY_INVALID') && Mobile.MAX_GROUP === conCreate.CONSIGNMENT_GROUP_MAX,
    '§3 Handy: 0, 51, 1,5, Text, −1 ⇒ QUANTITY_INVALID; dieselbe Obergrenze wie am Primary');
}

// ══ §4 Atomar: vergebene SKU, Fehler im 3. Stück ⇒ nichts; Wiederholung derselben PC2-Kennung ⇒ einmal ═══════════
{
  const db = freshDb();
  artikel(db, 'own-x', 'Fremd', 'MARGIN');
  db.run("UPDATE products SET sku = 'PRL-2' WHERE id = 'own-x'");
  reload();
  const vorher = zaehlerAnlage(db);
  const p = await gruppePrimary(db, 3, { product: { sku: 'PRL' } });
  const f = await gruppePC2(db, 3, { product: { ...GRUPPE.product, sku: 'PRL' } });
  ok(!p.ok && p.code === 'SKU_TAKEN' && !f.ok && f.code === 'SKU_TAKEN' && zaehlerAnlage(db) === vorher,
    `§4 PRL-2 ist vergeben ⇒ SKU_TAKEN (Primary ${p.code}, PC2 ${f.code}), kein Stück angelegt`);
  for (const weg of ['primary', 'pc2'] as const) {
    const db2 = freshDb();
    tauriState.reset();
    const vor = zaehlerAnlage(db2);
    let z = 0;
    const fa = faulty(db2, (sql) => /INSERT INTO consignments \(/i.test(sql) && ++z === 3);
    setTestDatabase(fa.db as never); reload();
    const r = weg === 'primary'
      ? await primary(() => conCreate.createConsignmentOnPrimary(gruppenEingabe({ quantity: 3 }), { kind: 'data_urls', images: [dataUrlVon('perle-f')] }))
      : await fern(() => cmd.runConsignmentCreate(deps(fa.db), ident('consignments.create', 'ADMIN', '7701') as never, { ...GRUPPE, quantity: 3, stagingIds: [bildVon('perle-f')] }));
    fa.f.armed = false;
    setTestDatabase(db2 as never); reload();
    ok(fa.f.fired && !r.ok && zaehlerAnlage(db2) === vor, `§4 ${weg}: Fehler beim 3. Stück ⇒ nichts bleibt (kein Artikel, keine Kommission, keine Verknüpfung, SKU-Zähler zurück) (${r.code}; ${zaehlerAnlage(db2)})`);
    if (weg === 'pc2') {
      const again = await fern(() => cmd.runConsignmentCreate(deps(db2), ident('consignments.create', 'ADMIN', '7701') as never, { ...GRUPPE, quantity: 3, stagingIds: [bildVon('perle-f')] }));
      reload();
      const replay = await fern(() => cmd.runConsignmentCreate(deps(db2), ident('consignments.create', 'ADMIN', '7701') as never, { ...GRUPPE, quantity: 3, stagingIds: [bildVon('perle-f')] }));
      ok(again.ok && replay.ok && replay.replayed && n(db2, 'SELECT COUNT(*) FROM consignments') === 3 && n(db2, 'SELECT COUNT(DISTINCT group_id) FROM consignments') === 1,
        `§4 pc2: dieselbe Kennung nach dem Fehler legt EINMAL an, die Wiederholung antwortet nur (${again.code || 'ok'} / replayed ${replay.replayed})`);
    }
  }
}

// ══ §5 Teilverkauf 2 von 3 über Record Sale — Primary, PC2 und Handy gleich ═══════════════════════════════════════
{
  const bilder: unknown[] = [];
  for (const weg of ['primary', 'pc2', 'handy'] as const) {
    const { w, gid, teile } = await gruppenWelt();
    const alle = useConsignmentStore.getState().consignments.filter((c) => c.groupId === gid);
    const zwei = grp.pickAvailablePieces(alle, 2).map((c) => c.id);
    ok(S(zwei) === S(teile.slice(0, 2)), `§5 ${weg}: gewählt werden die 2 verfügbaren Stücke mit der kleinsten Nummer`);
    let r: Ausgang;
    if (weg === 'primary') r = await verkaufPrimary(w, posten(zwei, 450));
    else if (weg === 'pc2') r = await verkaufPC2(w, posten(zwei, 450));
    else {
      const con = await lies('consignments.get', { id: teile[0] });
      const gebaut = Mobile.groupSaleBody(con, '2', { buyerId: 'cust-2', salePrice: '450', taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' });
      ok(gebaut.ok && Array.isArray(gebaut.body?.items) && (gebaut.body?.items as unknown[]).length === 2,
        `§5 handy: der Rumpf trägt 2 Stücke über items[] (${S(gebaut.body).slice(0, 200)})`);
      r = await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never, gebaut.body));
    }
    reload();
    ok(r.ok, `§5 ${weg}: Teilverkauf von 2 Stücken gebucht (${r.code || 'ok'})`);
    if (!r.ok) continue;
    const inv = invVon(r);
    ok(n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 2 && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 900,
      `§5 ${weg}: EINE Rechnung, eine Zeile je Stück (D-P5-3), 2 × 450 = 900`);
    ok(gruppenStand(w.db, gid) === '[[1,"sold",1],[2,"sold",1],[3,"active",0]]', `§5 ${weg}: Stück 1+2 verkauft, Stück 3 bleibt verfügbar (${gruppenStand(w.db, gid)})`);
    const ek = w.db.exec("SELECT p.id, ROUND(p.total_amount,3) FROM purchases p WHERE p.supplier_id != 'sup-1'")[0]?.values ?? [];
    ok(ek.length === 1 && Number(ek[0][1]) === 720 && n(w.db, 'SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = ?', [ek[0][0]]) === 2,
      `§5 ${weg}: EIN Einkauf beim Einlieferer mit 2 Zeilen (je 360 bei 20 % Provision) (${S(ek)})`);
    const zs = grp.summarizeGroup(useConsignmentStore.getState().consignments.filter((c) => c.groupId === gid));
    ok(zs?.available === 1 && zs.sold === 2 && zs.quantity === 3 && grp.groupStatusLine(zs) === 'Group of 3 · 1 available · 2 sold', `§5 ${weg}: Rest 1 von 3 (${zs ? grp.groupStatusLine(zs) : '—'})`);
    ok(abgleich(w.db).length === 0, `§5 ${weg}: Abgleich Lager/AP/AR/ausgeglichen (${abgleich(w.db).join('; ')})`);
    ok(n(w.db, "SELECT COUNT(*) FROM products p JOIN consignments c ON c.product_id = p.id WHERE c.status = 'sold' AND p.quantity = 0") === 2
      && n(w.db, "SELECT quantity FROM products p JOIN consignments c ON c.product_id = p.id WHERE c.group_seq = 3") === 1,
      `§5 ${weg}: Bestand je Stück: verkaufte 0, das dritte 1`);
    bilder.push(verkaufBild(w.db, inv));
    // Danach das dritte Stück einzeln — wie jede Kommission.
    const drei = await verkaufPrimary(w, posten([teile[2]], 470));
    reload();
    ok(drei.ok && gruppenStand(w.db, gid) === '[[1,"sold",1],[2,"sold",1],[3,"sold",1]]' && abgleich(w.db).length === 0,
      `§5 ${weg}: das letzte Stück lässt sich danach allein verkaufen (${drei.code || 'ok'})`);
  }
  if (bilder.length === 3) {
    ok(S(bilder[0]) === S(bilder[1]) && S(bilder[1]) === S(bilder[2]),
      `§5 Primary, PC2 und Handy buchen GLEICH (${S(bilder[0]).slice(0, 160)} | ${S(bilder[1]).slice(0, 160)} | ${S(bilder[2]).slice(0, 160)})`);
  }
  // Handy: mehr Stücke als verfügbar ⇒ kein Auftrag; das geöffnete Stück kommt zuerst.
  const { gid, teile } = await gruppenWelt();
  const con = await lies('consignments.get', { id: teile[2] });
  ok(Mobile.groupSaleBody(con, '4', { buyerId: 'cust-2', salePrice: '450', consignorTaxScheme: 'ZERO' }).code === 'SALE_QUANTITY_TOO_HIGH'
    && Mobile.groupSaleBody(con, '0', { buyerId: 'cust-2', salePrice: '450', consignorTaxScheme: 'ZERO' }).code === 'SALE_QUANTITY_INVALID',
    '§5 handy: 4 von 3 ⇒ SALE_QUANTITY_TOO_HIGH, 0 ⇒ SALE_QUANTITY_INVALID (nichts gesendet)');
  const zwei = Mobile.groupSaleBody(con, '2', { buyerId: 'cust-2', salePrice: '450', consignorTaxScheme: 'ZERO' });
  ok(S((zwei.body?.items as Array<Record<string, unknown>>).map((x) => x.consignmentId)) === S([teile[2], teile[0]]),
    '§5 handy: das geöffnete Stück zuerst, dann die kleinste Nummer');
  const einzeln = Mobile.groupSaleBody(con, '1', { buyerId: 'cust-2', salePrice: '450', consignorTaxScheme: 'ZERO' });
  ok(einzeln.ok && einzeln.body?.consignmentId === teile[2] && !('items' in (einzeln.body ?? {})), '§5 handy: 1 Stück bleibt der bisherige Einzelrumpf');
  void gid;
}

// ══ §6 Teilverkauf über die gemischte Rechnung (P3): 1 eigener Artikel + 2 Stücke der Gruppe ═══════════════════════
for (const weg of ['primary', 'pc2'] as const) {
  const { w, gid, teile } = await gruppenWelt();
  const items = posten(teile.slice(0, 2), 450);
  setTestDatabase(w.db as never); reload();
  const r = weg === 'primary'
    ? await primary(() => conHouse.createMixedInvoiceOnPrimary({ customerId: 'cust-2', ownLines: [eigeneZeile(w.db, 'own-1', 'MARGIN', 2500)], items, issuedDate: HEUTE, specialMark: false }))
    : await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never, mixedMod.mixedInvoiceBody(
      { customerId: 'cust-2', items, issuedDate: HEUTE, specialMark: false }, [eigeneAbsicht(w.db, 'own-1', 'MARGIN', 2500)],
      Object.fromEntries(items.map((it) => [it.consignmentId, conRev(w.db, it.consignmentId)])))));
  reload();
  const inv = invVon(r);
  ok(r.ok && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 3 && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 3400,
    `§6 ${weg}: gemischte Rechnung mit eigener Zeile + 2 Stücken (3 Zeilen, 3.400) (${r.code || 'ok'})`);
  ok(gruppenStand(w.db, gid) === '[[1,"sold",1],[2,"sold",1],[3,"active",0]]' && abgleich(w.db).length === 0,
    `§6 ${weg}: Rest 1 verfügbar, Abgleich ohne Abweichung (${gruppenStand(w.db, gid)} ${abgleich(w.db).join('; ')})`);
}

// ══ §7 Je Stück: Post-Sale Return, Cancel Sale, P4-Korrektur (Entfernen, Preis) ═══════════════════════════════════
{
  // Post-Sale Return EINES Stücks: nur dieses geht zurück an den Einlieferer.
  const { w, gid, teile } = await gruppenWelt();
  const v = await verkaufPrimary(w, posten(teile.slice(0, 2), 450));
  reload();
  setTestDatabase(w.db as never);
  const ret = await primary(() => conHouse.returnConsignmentAfterSaleOnPrimary(teile[0], { disposition: 'RETURN_TO_OWNER' }));
  reload();
  ok(v.ok && ret.ok && gruppenStand(w.db, gid).startsWith('[[1,"returned"') && /\[2,"sold",1\]/.test(gruppenStand(w.db, gid)) && /\[3,"active",0\]/.test(gruppenStand(w.db, gid)),
    `§7 Post-Sale Return von Stück 1: nur Stück 1 zurück, Stück 2 bleibt verkauft, Stück 3 verfügbar (${ret.code || 'ok'} ${gruppenStand(w.db, gid)})`);
  ok(abgleich4(w.db).length === 0, `§7 …Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  const zs = grp.summarizeGroup(useConsignmentStore.getState().consignments.filter((c) => c.groupId === gid));
  ok(zs?.available === 1 && zs.sold === 1 && zs.returned === 1, `§7 …die Gruppe zeigt 1 verfügbar, 1 verkauft, 1 zurück (${zs ? grp.groupStatusLine(zs) : '—'})`);
}
{
  // Cancel Sale eines Teilverkaufs: beide Stücke DIESER Rechnung zurück in die Gruppe (D2, wie heute je Rechnung).
  const { w, gid, teile } = await gruppenWelt();
  const v = await verkaufPC2(w, posten(teile.slice(1, 3), 450));
  reload();
  setTestDatabase(w.db as never);
  const c = await primary(() => conHouse.cancelConsignmentSaleOnPrimary(teile[1]));
  reload();
  ok(v.ok && c.ok && gruppenStand(w.db, gid) === '[[1,"active",0],[2,"active",0],[3,"active",0]]' && abgleich4(w.db).length === 0,
    `§7 Cancel Sale: beide verkauften Stücke wieder verfügbar, Gruppe 3 von 3 (${c.code || 'ok'} ${gruppenStand(w.db, gid)} ${abgleich4(w.db).join('; ')})`);
  const nochmal = await verkaufPrimary(w, posten([teile[1]], 455));
  reload();
  ok(nochmal.ok && abgleich4(w.db).length === 0, `§7 …und ein Stück lässt sich neu verkaufen (${nochmal.code || 'ok'})`);
}
for (const weg of ['primary', 'pc2'] as const) {
  // P4: aus einer gemischten Rechnung EIN Stück entfernen, den Preis eines anderen ändern — je Stück.
  const { w, gid, teile } = await gruppenWelt();
  setTestDatabase(w.db as never); reload();
  const anl = await primary(() => conHouse.createMixedInvoiceOnPrimary({ customerId: 'cust-2', ownLines: [eigeneZeile(w.db, 'own-1', 'MARGIN', 2500)], items: posten(teile, 450), issuedDate: HEUTE, specialMark: false }));
  reload();
  const inv = invVon(anl);
  const ek = einkaufDer(w.db, teile[0]);
  const r = await korrWeg(weg, w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== teile[1]).map((i) => (i.consignmentId === teile[2] ? { ...i, salePrice: 500 } : i)) });
  reload();
  ok(anl.ok && r.ok, `§7 ${weg} P4: Stück 2 entfernt, Preis von Stück 3 auf 500 (${anl.code || 'ok'} / ${r.code || 'ok'})`);
  ok(gruppenStand(w.db, gid) === '[[1,"sold",1],[2,"active",0],[3,"sold",1]]', `§7 ${weg} P4: Stück 2 wieder verfügbar, 1 und 3 bleiben verkauft (${gruppenStand(w.db, gid)})`);
  ok(n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 3 && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 3450,
    `§7 ${weg} P4: 3 Zeilen, Summe 2.500 + 450 + 500 = 3.450 (${n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv])})`);
  ok(S(w.db.exec('SELECT ROUND(pl.line_total,3) FROM purchase_lines pl WHERE pl.purchase_id = ? ORDER BY pl.line_total', [ek])[0]?.values) === S([[360], [400]]),
    `§7 ${weg} P4: der Einkauf beim Einlieferer folgt je Stück (360 für Stück 1, 400 für Stück 3; Stück 2 entfällt)`);
  ok(abgleich4(w.db).length === 0, `§7 ${weg} P4: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}

// ══ §8 Je Stück: Boden (Unterdeckung) und E7 (VAT 10 %) ════════════════════════════════════════════════════════════
{
  const { w, gid, teile } = await gruppenWelt();
  // Unter dem Minimum? Der Boden ist der vereinbarte Preis abzüglich Provision je Stück (Modell percent: kein Boden),
  // also ein Modell mit Boden: Agreed + Excess.
  w.db.run("UPDATE consignments SET commission_type = 'consignor_fixed', commission_rate = 0 WHERE group_id = ?", [gid]);
  reload();
  const vorher = zaehler(w.db);
  const ohne = await verkaufPC2(w, posten(teile.slice(0, 2), 390));
  ok(!ohne.ok && ohne.code === 'SALE_BELOW_FLOOR' && zaehler(w.db) === vorher, `§8 unter dem Boden ohne Bestätigung ⇒ Nein (${ohne.code}), nichts gebucht`);
  const mit = await verkaufPC2(w, posten(teile.slice(0, 2), 390, { acknowledgeShortfall: true }));
  reload();
  ok(mit.ok && n(w.db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss'") === 2 && n(w.db, "SELECT ROUND(SUM(amount),3) FROM expenses WHERE category = 'ConsignorLoss'") === 20,
    `§8 mit Bestätigung: je Stück eine Verlustbuchung (2 × 10) (${mit.code || 'ok'} ${n(w.db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss'")})`);
  ok(abgleich4(w.db).length === 0, `§8 …Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}
{
  // E7: VAT 10 % bei 5 % Provision macht das LATAIF-Ergebnis je Stück negativ ⇒ je Stück zu bestätigen.
  const { w, gid, teile } = await gruppenWelt();
  w.db.run('UPDATE consignments SET commission_rate = 5 WHERE group_id = ?', [gid]);
  reload();
  const vorher = zaehler(w.db);
  const ohne = await verkaufPrimary(w, posten(teile.slice(0, 2), 450, { taxScheme: 'VAT_10' }));
  const halb = await verkaufPrimary(w, posten(teile.slice(0, 2), 450, { taxScheme: 'VAT_10' }).map((it, i) => (i === 0 ? { ...it, acknowledgeVatShortfall: true } : it)));
  ok(!ohne.ok && ohne.code === 'VAT_SHORTFALL_UNCONFIRMED' && !halb.ok && halb.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler(w.db) === vorher,
    `§8 E7 ohne / mit nur einer Bestätigung ⇒ Nein (${ohne.code}/${halb.code}), nichts gebucht`);
  const mit = await verkaufPC2(w, posten(teile.slice(0, 2), 450, { taxScheme: 'VAT_10', acknowledgeVatShortfall: true }));
  reload();
  ok(mit.ok && gruppenStand(w.db, gid) === '[[1,"sold",1],[2,"sold",1],[3,"active",0]]' && abgleich4(w.db).length === 0,
    `§8 E7 je Stück bestätigt ⇒ gebucht (${mit.code || 'ok'})`);
}
{
  // Zugemachtes VAT-Quartal: der Teilverkauf auf einen Tag darin ⇒ Nein, nichts gebucht.
  const { w, teile } = await gruppenWelt();
  w.db.run("UPDATE consignments SET agreement_date = '2026-08-01'");
  insert(w.db, 'vat_filings', { id: 'vf-1', branch_id: 'branch-main', year: 2026, quarter: 3, filed_at: NOW, snapshot_json: '{}', created_at: NOW });
  reload();
  const vorher = zaehler(w.db);
  setTestDatabase(w.db as never);
  const r = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: posten(teile.slice(0, 2), 450), buyerId: 'cust-2', specialMark: false, saleDate: '2026-09-20' }));
  ok(!r.ok && /VAT|PERIOD|FILED|QUARTER/i.test(r.code) && zaehler(w.db) === vorher, `§8 VAT-Quartal zu ⇒ Nein (${r.code}), nichts gebucht`);
}

// ══ §9 Rechte und Rumpf ════════════════════════════════════════════════════════════════════════════════════════
{
  ok(perms.roleMayRunOp('SALES', 'consignments.create') === false && perms.roleMayRunOp('ADMIN', 'consignments.create') === true,
    '§9 die Aufnahme (auch als Gruppe) bleibt Admin/Manager (zentraler Rechte-Wächter)');
  const db = freshDb();
  const r = await executeCommand('consignments.create', { input: { ...GRUPPE, quantity: 3 } }, { ...ACT({ role: 'SALES', commandId: '00000998-0000-4000-8000-000000000000', payloadHash: 'h998' }) } as never) as { kind: string; code?: string };
  ok(r.kind === 'business_error' && r.code === 'PERMISSION_DENIED' && n(db, 'SELECT COUNT(*) FROM consignments') === 0, `§9 SALES fern ⇒ PERMISSION_DENIED, nichts angelegt (${r.kind}/${r.code})`);
  const fremd = await gruppePC2(db, 3, { unknownField: 1 });
  ok(!fremd.ok && n(db, 'SELECT COUNT(*) FROM consignments') === 0, `§9 ein unbekanntes Feld im Rumpf ⇒ Nein (${fremd.code})`);
}

// ══ §10 Reine Helfer der Masken ═══════════════════════════════════════════════════════════════════════════════
{
  const st = (id: string, seq: number, status = 'active', inv?: string) => ({ id, status, groupId: 'g', groupSeq: seq, groupQuantity: 4, consignmentNumber: 'CON-' + seq, invoiceId: inv });
  const g4 = [st('d', 4), st('b', 2, 'sold', 'i1'), st('a', 1), st('c', 3)];
  ok(S(grp.pickAvailablePieces(g4, 2).map((x) => x.id)) === S(['a', 'c']), '§10 pickAvailablePieces: verfügbare nach Stücknummer, verkaufte nie');
  ok(S(grp.pickAvailablePieces(g4, 9).map((x) => x.id)) === S(['a', 'c', 'd']) && grp.pickAvailablePieces(g4, 0).length === 0, '§10 …höchstens so viele, wie da sind');
  ok(S(grp.expandGroupSelection(['c'], g4, { g: 3 })) === S(['c', 'a', 'd']), '§10 expandGroupSelection: die gewählte zuerst, dann die kleinsten verfügbaren');
  ok(S(grp.expandGroupSelection(['x', 'c'], [...g4, { id: 'x', status: 'active' }], { g: 1 })) === S(['x', 'c']) && S(grp.expandGroupSelection(['c'], g4, {})) === S(['c']),
    '§10 …Einzelkommissionen bleiben, ohne Mengenwahl bleibt die Auswahl');
  const z = grp.summarizeGroup(g4)!;
  ok(z.quantity === 4 && z.available === 3 && z.sold === 1 && grp.groupStatusLine(z) === 'Group of 4 · 3 available · 1 sold', `§10 summarizeGroup (${grp.groupStatusLine(z)})`);
  ok(grp.pieceLabel(st('a', 1)) === 'piece 1 of 4' && grp.pieceLabel({ groupId: undefined }) === '' && grp.summarizeGroup([{ id: 'x', status: 'active' }]) === null,
    '§10 pieceLabel / Einzelkommission ohne Gruppe');
  ok(grp.groupsOf([...g4, { id: 'x', status: 'active' }]).size === 1, '§10 groupsOf: nur echte Gruppen');
}

// ══ §11 Migration: auf der v0.8.98-Datenbank (Quelle aus Git) additiv, Altzeilen unverändert, zweiter Lauf ohne Wirkung ══
{
  const alt = (p: string): string => execFileSync('git', ['show', `112c03be:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let altSchema = '', altDb = '';
  try { altSchema = alt('src/core/db/schema.sql'); altDb = alt('src/core/db/database.ts'); } catch (e) { ok(false, `§11 die v0.8.98-Quellen sind lesbar (${String(e).slice(0, 120)})`); }
  if (altSchema && altDb) {
    const a = altDb.indexOf('const migrations: string[] = ['); const b = altDb.indexOf('\n  ];', a);
    const altMig = [...altDb.slice(a, b).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
    ok(!altMig.some((m) => /consignments ADD COLUMN group_/.test(m)) && MIGRATIONS.some((m) => /consignments ADD COLUMN group_id/.test(m)),
      '§11 die alte Fassung kennt keine Gruppenspalten, die neue ergänzt sie');
    const db = new SQL.Database() as unknown as Db;
    db.run(altSchema);
    for (const st of altMig) { try { db.run(st); } catch { /* da */ } }
    for (const [i, status] of [[1, 'active'], [2, 'sold'], [3, 'returned']] as const) {
      insert(db, 'consignments', { id: `alt-${i}`, branch_id: 'branch-main', consignment_number: `CON-ALT-${i}`, consignor_id: 'cust-1', product_id: `p-${i}`,
        agreed_price: 100 * i, minimum_price: 90 * i, commission_rate: 15, status, agreement_date: '2026-01-0' + i, created_at: NOW, updated_at: NOW });
    }
    const spaltenAlt = (db.exec('PRAGMA table_info(consignments)')[0].values).map((v) => String(v[1]));
    const fp = (cols: string[]): string => all(db, `SELECT ${cols.join(', ')} FROM consignments ORDER BY id`);
    const vorher = fp(spaltenAlt);
    const lauf = (): void => { for (const st of MIGRATIONS) { try { db.run(st); } catch { /* da */ } } };
    lauf();
    const spaltenNeu = (db.exec('PRAGMA table_info(consignments)')[0].values).map((v) => String(v[1]));
    ok(['group_id', 'group_seq', 'group_quantity'].every((c) => spaltenNeu.includes(c)) && spaltenNeu.length === spaltenAlt.length + 3,
      `§11 nach der Migration: genau 3 neue Spalten (${spaltenNeu.filter((c) => !spaltenAlt.includes(c)).join(', ')})`);
    ok(fp(spaltenAlt) === vorher, '§11 jede Altzeile ist in jeder alten Spalte unverändert (Fingerabdruck)');
    ok(all(db, 'SELECT COUNT(*) FROM consignments WHERE group_id IS NULL AND group_seq IS NULL AND group_quantity IS NULL') === '[[3]]',
      '§11 Altzeilen haben keine Gruppe (= Gruppe aus einem Stück)');
    ok(n(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_consignments_group'") === 1, '§11 der Gruppenindex ist da');
    const ganz = fp(spaltenNeu);
    const rev = all(db, 'SELECT id, revision FROM consignments ORDER BY id');
    lauf();
    ok(fp(spaltenNeu) === ganz && all(db, 'SELECT id, revision FROM consignments ORDER BY id') === rev && (db.exec('PRAGMA table_info(consignments)')[0].values).length === spaltenNeu.length,
      '§11 ein zweiter Lauf ändert nichts (Spalten, Zeilen, Fassungen)');
    const alteZeile = Object.fromEntries(db.exec("SELECT * FROM consignments WHERE id = 'alt-2'")[0].columns.map((k, i) => [k, db.exec("SELECT * FROM consignments WHERE id = 'alt-2'")[0].values[0][i]]));
    const c = rowToConsignment(alteZeile);
    ok(c.groupId === undefined && c.groupSeq === undefined && c.groupQuantity === undefined && grp.pieceLabel(c) === '', '§11 eine Altzeile liest sich als Einzelkommission');
  }
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_fields: string[] }> };
  ok(['group_id', 'group_seq', 'group_quantity'].every((f) => manifest.tables.consignments.allowed_fields.includes(f)),
    '§11 das Sync-Manifest erlaubt die drei Gruppenfelder (Primary ↔ PC2)');
}

// ══ §12 Quelltext: P1–P4 und der Bestandskern bleiben, wie sie sind ═════════════════════════════════════════════
{
  const create = src('src/core/consignment/consignment-create.ts');
  ok(/quantity: 1,/.test(create) && /stockStatus: 'consignment'/.test(create), '§12 jedes Stück bleibt ein Artikel mit Menge 1 im Kommissionsbestand');
  const ui = src('src/pages/consignments/ConsignmentList.tsx') + src('src/components/consignments/ConsignmentSaleDialog.tsx') + src('src/components/invoices/ConsignmentInvoiceLines.tsx') + src('src/pages/consignments/ConsignmentDetail.tsx');
  // Die JSX-Falle: `\u…` außerhalb eines String-Literals ist im JSX-Text wörtlich sichtbar. Literale und Kommentare raus, dann suchen.
  const ohneLiterale = ui.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
    .map((l) => l.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''"));
  const falle = ohneLiterale.filter((l) => /\\u[0-9A-Fa-f]{4}/.test(l));
  ok(falle.length === 0, `§12 kein Unicode-Escape als JSX-Text in den P5-Masken (${falle.slice(0, 3).join(' | ')})`);
}


console.log(fails.length ? `\nFAIL — P5 consignment quantities: ${PASS} passed, ${fails.length} failed` : `\nPASS — P5 consignment quantities: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 — Kommissions-Sperren als VERHALTEN (Sicherheitsabschluss 10.11.2026): solange der Einkauf eines Einlieferers mit
// seiner eigenen Kundenrechnung verrechnet ist, weisen Mixed-Korrektur, „Cancel Sale" und „Return after sale" ab — Primary
// und PC2, ohne Wirkung; nach dem Aufheben der Verrechnung geht dieselbe Handlung. Gerüst: test/p4/mixed-invoice-correction.
// Run: node --experimental-strip-types test/customer-account/b23-consignment-guards.test.ts
// ════════════════════════════════════════════════════════════════════════════
/* eslint-disable @typescript-eslint/no-unused-vars -- Harness aus test/p4/mixed-invoice-correction übernommen (nicht jeder Helfer wird hier gebraucht). */
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
// B2/B3 — Kommissions-Sperren als VERHALTEN: der Einkauf des Einlieferers (aus „Record Sale" / gemischter Rechnung) ist mit
// seiner eigenen offenen Kundenrechnung verrechnet (Settle Balance, eine STL). Solange das wirkt, weisen Mixed-Korrektur,
// „Cancel Sale" und „Return after sale" ab — am Primary UND am PC2 —, ohne irgendetwas zu ändern. Gegenprobe: nach dem
// Aufheben der Verrechnung geht dieselbe Handlung.
// ════════════════════════════════════════════════════════════════════════════
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const st = await import('../../src/core/offsets/party-settlement.ts');
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const cl = await import('../../src/core/bridge/consignment-lifecycle-commands.ts');
const rules = await import('../../src/core/consignment/consignment-reversal.ts');
const TAB = ['invoices', 'invoice_lines', 'payments', 'purchases', 'purchase_lines', 'purchase_payments', 'purchase_returns', 'supplier_credits',
  'consignments', 'stock_lots', 'products', 'expenses', 'expense_payments', 'party_offsets', 'ledger_entries', 'credit_notes', 'customer_credits'];
const abdruck = (db: Db): string => S(TAB.map((t) => { try { return db.exec(`SELECT * FROM ${t} ORDER BY rowid`)[0]?.values ?? []; } catch { return 'n/a'; } }));
/** Die Lieferantenrolle des Einlieferers AUSDRÜCKLICH mit seinem Kundenkonto verknüpfen (wie „Link to client" am Lieferanten). */
function verknuepfe(db: Db, purchaseId: string, customerId: string): void {
  db.run('UPDATE suppliers SET linked_customer_id = ? WHERE id = (SELECT supplier_id FROM purchases WHERE id = ?)', [customerId, purchaseId]);
  reload();
}
let artNr = 0;
/** Eine offene Rechnung an den Einlieferer (eigener Artikel mit Einkauf und Los). */
function rechnungAn(db: Db, cid: string, preis: number): string {
  const pid = 'own-x' + (++artNr);
  artikel(db, pid, 'Ring ' + pid, 'ZERO'); einkauf(pid, 1, 50, false);
  const lot = losVon(db, pid);
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(cid, [{ productId: pid, lotId: lot, quantity: 1, unitPrice: preis, purchasePrice: 50,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: preis }] as never, 'B23-K', HEUTE).id);
  reload();
  return id;
}
/** „Settle Balance" am Primary: genau dieser Einkauf gegen genau diese Rechnung, eine STL. */
async function verrechne(db: Db, kunde: string, einkaufId: string, rechnung: string): Promise<Ausgang> {
  setTestDatabase(db as never); reload();
  const r = sr.settleBalanceFor({ branchId: 'branch-main' }, kunde);
  const sel = { invoiceIds: [rechnung], sourceIds: [einkaufId] };
  const pairs = sr.planSettlement(r.invoices, r.sources, sel);
  const fin = sr.finalizingInvoices(r.invoices, pairs).filter((i) => !i.finalized);
  return primary(() => st.settleBalanceOnPrimary({ customerId: kunde, ...sel, expectedStamp: r.stamp, settlementDate: HEUTE,
    expectedTotal: pairs.reduce((a, p) => a + p.amountF, 0) / 1000, ...(fin.length ? { finalNumbers: Object.fromEntries(fin.map((i) => [i.id, 'normal' as const])) } : {}) }));
}
const aktiv = (db: Db, pid: string): number => n(db, "SELECT COUNT(*) FROM party_offsets WHERE payable_type = 'PURCHASE' AND payable_id = ? AND status = 'ACTIVE'", [pid]);
async function aufheben(db: Db, pid: string): Promise<Ausgang> {
  setTestDatabase(db as never); reload();
  const stl = s(db, "SELECT settlement_number FROM party_offsets WHERE payable_type = 'PURCHASE' AND payable_id = ? AND status = 'ACTIVE' LIMIT 1", [pid]);
  return primary(() => st.reverseSettlementOnPrimary({ settlementNumber: stl }));
}
/** Ein reiner Kommissionsverkauf (nur k1 an cust-2) über denselben Weg wie „Record Sale". */
async function einzelverkauf(bezahlt: boolean): Promise<{ w: Welt; inv: string }> {
  const w = await welt();
  const items = [{ consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, taxScheme: 'MARGIN' as const, consignorTaxScheme: 'ZERO' as const }];
  const r = await amPrimary(w, { ownLines: 'none', items, ...(bezahlt ? { payments: [{ amount: 1200, method: 'cash' as const, paidDate: HEUTE }] } : {}) });
  if (!r.ok) throw new Error('setup sale: ' + r.code);
  reload();
  return { w, inv: invVon(r) };
}
/** Verkauf + Verknüpfung + offene Rechnung des Einlieferers + Verrechnung 300 gegen seinen Einkauf. */
async function mitVerrechnung(w: Welt, cid: string): Promise<string> {
  const ali = einkaufDer(w.db, cid);
  verknuepfe(w.db, ali, 'cust-1');
  const ir = rechnungAn(w.db, 'cust-1', 300);
  const v = await verrechne(w.db, 'cust-1', ali, ir);
  if (!v.ok || aktiv(w.db, ali) !== 1) throw new Error('setup offset: ' + v.code);
  return ali;
}

// ══ K1 Mixed-Korrektur (Preis der Kommissionszeile) ═══════════════════════════════
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const ali = await mitVerrechnung(w, w.k1);
  ok(aktiv(w.db, ali) === 1 && String(one(w.db, 'SELECT linked_customer_id FROM suppliers WHERE id = (SELECT supplier_id FROM purchases WHERE id = ?)', [ali])) === 'cust-1',
    `K1 ${weg}: Einkauf des Einlieferers (gemischte Rechnung) ist mit seiner eigenen Rechnung verrechnet`);
  const senken = { items: (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i)) };
  const vorher = abdruck(w.db);
  const r = await korrWeg(weg, w, inv, senken);
  ok(!r.ok && r.code === 'PURCHASE_HAS_OFFSET', `K1 ${weg}: Mixed-Korrektur → PURCHASE_HAS_OFFSET (${r.code || 'gebucht!'})`);
  ok(abdruck(w.db) === vorher, `K1 ${weg}: nichts geändert (Rechnung, Einkauf, Kommission, Los, Verrechnung, Hauptbuch)`);
  const u = await aufheben(w.db, ali);
  const r2 = await korrWeg(weg, w, inv, senken);
  ok(u.ok && r2.ok && aktiv(w.db, ali) === 0, `K1 ${weg}: Gegenprobe — nach dem Aufheben geht dieselbe Korrektur (${u.code || 'ok'} / ${r2.code || 'ok'})`);
  ok(abgleich4(w.db).length === 0, `K1 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}
marker('B23_CONSIGNMENT_GUARD_MIXED_PROVED');

// ══ K2 „Cancel Sale" ══════════════════════════════════════════════════════════
for (const weg of ['primary', 'pc2'] as const) {
  const { w } = await einzelverkauf(false);
  const ali = await mitVerrechnung(w, w.k1);
  const storno = (): Promise<Ausgang> => {
    setTestDatabase(w.db as never); reload();
    return weg === 'primary'
      ? primary(() => conHouse.cancelConsignmentSaleOnPrimary(w.k1))
      : fern(() => cl.runCancelSale(deps(w.db), ident('consignments.cancel_sale') as never, rules.consignmentCancelSaleBody(w.k1, conRev(w.db, w.k1))));
  };
  const vorher = abdruck(w.db);
  const r = await storno();
  ok(!r.ok && r.code === 'PURCHASE_HAS_OFFSET', `K2 ${weg}: Cancel Sale → PURCHASE_HAS_OFFSET (${r.code || 'gebucht!'})`);
  ok(abdruck(w.db) === vorher, `K2 ${weg}: nichts geändert`);
  const u = await aufheben(w.db, ali);
  const r2 = await storno();
  ok(u.ok && r2.ok && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.k1]) !== 'sold', `K2 ${weg}: Gegenprobe — nach dem Aufheben geht Cancel Sale (${u.code || 'ok'} / ${r2.code || 'ok'})`);
}
marker('B23_CONSIGNMENT_GUARD_CANCEL_SALE_PROVED');

// ══ K3 „Return after sale" (Rückgabe an den Einlieferer) ═════════════════════════
for (const weg of ['primary', 'pc2'] as const) {
  const { w } = await einzelverkauf(true);
  const ali = await mitVerrechnung(w, w.k1);
  const input = { disposition: 'RETURN_TO_OWNER' as const, refundMethod: 'cash' as const };
  const retoure = (): Promise<Ausgang> => {
    setTestDatabase(w.db as never); reload();
    return weg === 'primary'
      ? primary(() => conHouse.returnConsignmentAfterSaleOnPrimary(w.k1, input as never))
      : fern(() => cl.runReturnAfterSale(deps(w.db), ident('consignments.return_after_sale') as never, rules.consignmentReturnAfterSaleBody(w.k1, conRev(w.db, w.k1), input as never)));
  };
  const vorher = abdruck(w.db);
  const r = await retoure();
  ok(!r.ok && r.code === 'PURCHASE_HAS_OFFSET', `K3 ${weg}: Return after sale → PURCHASE_HAS_OFFSET (${r.code || 'gebucht!'})`);
  ok(abdruck(w.db) === vorher, `K3 ${weg}: nichts geändert`);
  const u = await aufheben(w.db, ali);
  const r2 = await retoure();
  ok(u.ok && r2.ok, `K3 ${weg}: Gegenprobe — nach dem Aufheben geht die Rückgabe (${u.code || 'ok'} / ${r2.code || 'ok'})`);
}
marker('B23_CONSIGNMENT_GUARD_RETURN_PROVED');

console.log(`\nb23 consignment guards: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('B23_CONSIGNMENT_GUARDS_PROVED');

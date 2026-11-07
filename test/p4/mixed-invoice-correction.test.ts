// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P4 — eine Rechnung mit Kommissionszeilen korrigieren + E7 Owner-Entscheidung A.
// Run: node test/p4/mixed-invoice-correction.test.ts
//
//   §0 E7 A: „Record Sale" (Primary, PC2) und der Handy-Verkauf verlangen die Bestätigung des negativen LATAIF-Ergebnisses
//   §1 eigene Zeilen einer gemischten Rechnung korrigieren (Korrektur und gewöhnlicher Weg), Einkäufe unberührt
//   §2 E5 Zeile entfernen, Einlieferer unbezahlt (Zeile an Ort und Stelle / Einkauf storniert, E11 auf dem Originaltag)
//   §3 E5+E2 Zeile entfernen, Einlieferer bezahlt: Pflichtwahl Guthaben / Rückforderung, „Record Repayment"
//   §4 E2/E9 Preis korrigieren: unbezahlt (Einkauf, Los, Wareneinsatz folgen), bezahlt (Überzahlung mit Wahl, Erhöhung)
//   §5 … weitere Abschnitte siehe unten
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

// ══ §0 E7 Owner A — „Record Sale" und Handy-Verkauf verlangen die Bestätigung ══════════════════════════════
{
  const w = await welt();
  const k5 = await kommission(w.db, 'cust-1', 'Golden Ellipse', { model: 'percent', commissionRate: 5 });
  const item = (ack: boolean) => ({ consignmentId: k5, salePrice: 1100, acknowledgeShortfall: false, taxScheme: 'VAT_10' as const, consignorTaxScheme: 'ZERO' as const,
    ...(ack ? { acknowledgeVatShortfall: true } : {}) });
  setTestDatabase(w.db as never); reload();
  const vorher = zaehler(w.db);
  const ohne = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [item(false)], buyerId: 'cust-2', specialMark: false }));
  ok(!ohne.ok && ohne.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler(w.db) === vorher,
    `§0 Record Sale am Primary: VAT 10 % mit 5 % Provision (−45,000) ohne Bestätigung ⇒ Nein, nichts gebucht (${ohne.code})`);
  // PC2 — der Einzelrumpf des Handys und der gemeinsame Rumpf.
  const einzel = (ack: boolean) => ({ consignmentId: k5, expectedRevision: conRev(w.db, k5), buyerId: 'cust-2', salePrice: 1100, taxScheme: 'VAT_10', consignorTaxScheme: 'ZERO',
    specialMark: false, ...(ack ? { acknowledgeVatShortfall: true } : {}) });
  const h1 = await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never, einzel(false)));
  ok(!h1.ok && h1.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler(w.db) === vorher, `§0 Handy (Einzelrumpf) ohne Bestätigung ⇒ Nein (${h1.code}), nichts gebucht`);
  const g1 = await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never,
    finance.consignmentSalesBody({ items: [item(false)], buyerId: 'cust-2', specialMark: false }, { [k5]: conRev(w.db, k5) })));
  ok(!g1.ok && g1.code === 'VAT_SHORTFALL_UNCONFIRMED', `§0 PC2 Record Sale (gemeinsamer Rumpf) ohne Bestätigung ⇒ Nein (${g1.code})`);
  const h2 = await fern(() => life.runRecordSale(deps(w.db), ident('consignments.record_sale') as never, einzel(true)));
  reload();
  ok(h2.ok && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [k5]) === 'sold' && abgleich(w.db).length === 0,
    `§0 Handy mit Bestätigung ⇒ gebucht, Abgleich ohne Abweichung (${h2.code || 'ok'})`);
  ok(n(w.db, "SELECT ROUND(vat_amount,3) FROM invoice_lines WHERE product_id = ?", [pidVon(w.db, k5)]) === 100
    && n(w.db, 'SELECT ROUND(commission_amount,3) FROM consignments WHERE id = ?', [k5]) === 55,
    '§0 die Rechnung bleibt dieselbe: VAT 100,000, Provision 55,000 (Margenberechnung unverändert)');
  // Primary mit Bestätigung, Rumpfgrenzen.
  const w2 = await welt();
  const k6 = await kommission(w2.db, 'cust-1', 'Golden Ellipse', { model: 'percent', commissionRate: 5 });
  setTestDatabase(w2.db as never); reload();
  const mit = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [{ ...item(true), consignmentId: k6 }], buyerId: 'cust-2', specialMark: false }));
  ok(mit.ok, `§0 Record Sale am Primary mit Bestätigung ⇒ gebucht (${mit.code || 'ok'})`);
  const fehlerVon = (raw: unknown): string => { try { life.parseRecordSale(raw); return ''; } catch (x) { return (x as Error).message; } };
  ok(fehlerVon({ consignmentId: 'c', expectedRevision: 1, salePrice: 1, buyerId: 'b', acknowledgeVatShortfall: 'ja' }) !== ''
    && fehlerVon({ items: [{ consignmentId: 'c', expectedRevision: 1, salePrice: 1, acknowledgeVatShortfall: true }], buyerId: 'b' }) === ''
    && life.parseRecordSale({ consignmentId: 'c', expectedRevision: 1, salePrice: 1, buyerId: 'b', acknowledgeVatShortfall: true }).acknowledgeVatShortfall === true,
    '§0 Rumpf: Bestätigung im Einzel- und im gemeinsamen Rumpf, nur ja/nein');
  const mobil = src('src-tauri/src/sync/mobile_consignment_commands.js') + src('src-tauri/src/sync/mobile_consignment_ui.js') + src('src-tauri/src/sync/mobile_consignment.html');
  ok(/acknowledgeVatShortfall/.test(mobil) && /VAT_SHORTFALL_UNCONFIRMED/.test(mobil) && /cnVatShortfallAck/.test(mobil),
    '§0 Handy: fragt nach dem Nein des Primary und schickt die Bestätigung');
  const dialog = src('src/components/consignments/ConsignmentSaleDialog.tsx');
  ok(/consignmentVatShortfall/.test(dialog) && /acknowledgeVatShortfall/.test(dialog), '§0 Record-Sale-Dialog: E7 je Artikel, Bestätigung reist mit');
}

// ══ §1 Eigene Zeilen einer gemischten Rechnung korrigieren (Primary und PC2, auch über den gewöhnlichen Weg) ════
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const einkaufVorher = all(w.db, "SELECT ROUND(total_amount,3), revision FROM purchases WHERE supplier_id != 'sup-1' ORDER BY id");
  const r = await korrWeg(weg, w, inv, { preis: { 'own-1': 2400 } });
  reload();
  ok(r.ok, `§1 ${weg}: eigene Zeile der gemischten Rechnung korrigiert (${r.code || 'ok'})`);
  ok(n(w.db, "SELECT ROUND(line_total,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = 'own-1'", [inv]) === 2400
    && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 6410
    && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 5,
    `§1 ${weg}: Zeile 2.400, Summe 6.410, alle 5 Zeilen bleiben`);
  ok(all(w.db, "SELECT ROUND(total_amount,3), revision FROM purchases WHERE supplier_id != 'sup-1' ORDER BY id") === einkaufVorher,
    `§1 ${weg}: die Einlieferer-Einkäufe bleiben unberührt (${einkaufVorher})`);
  ok(abgleich4(w.db).length === 0, `§1 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}
{
  // Der gewöhnliche Weg (ältere Maske): eigene Zeilen jetzt frei, Kommissionszeilen weiter gesperrt.
  const { w, inv } = await gemischt();
  setTestDatabase(w.db as never); reload();
  const kp = konsProdukte(w.db, inv);
  const alle = (db: Db) => (db.exec(`SELECT id, product_id, lot_id, quantity, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total
      FROM invoice_lines WHERE invoice_id = ? ORDER BY position`, [inv])[0]?.values ?? []).map((r) => ({ lineId: String(r[0]), productId: String(r[1]),
      lotId: String(r[2] ?? '') || undefined, quantity: Number(r[3]), unitPrice: Number(r[4]), purchasePrice: Number(r[5]), taxScheme: String(r[6]),
      vatRate: Number(r[7]), vatAmount: Number(r[8]), lineTotal: Number(r[9]) }));
  const ohneOwn2 = alle(w.db).filter((l) => l.productId !== 'own-2');
  const r = await primary(() => editInvoiceOnPrimary(inv, { lines: ohneOwn2, reason: 'Kette gehört nicht dazu' }, invRev(w.db, inv)));
  reload();
  ok(r.ok && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 4 && n(w.db, "SELECT SUM(qty_remaining) FROM stock_lots WHERE product_id = 'own-2'") === 2,
    `§1 gewöhnlicher Weg: eigene Zeile entfernt, Bestand zurück (${r.code || 'ok'})`);
  const ohneKomm = alle(w.db).filter((l) => l.productId !== kp[0]);
  const r2 = await primary(() => editInvoiceOnPrimary(inv, { lines: ohneKomm, reason: 'x' }, invRev(w.db, inv)));
  ok(!r2.ok && r2.code === 'CONSIGNMENT_INVOICE_LOCKED', `§1 gewöhnlicher Weg: eine Kommissionszeile entfernen bleibt gesperrt (${r2.code})`);
  ok(abgleich4(w.db).length === 0, `§1 gewöhnlicher Weg: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}

// ══ §2 E5 — Kommissionszeile entfernen, Einlieferer unbezahlt (gemeinsamer Einkauf: Zeile an Ort und Stelle; allein: Storno) ══
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k2);
  const sara = einkaufDer(w.db, w.k3);
  const r = await korrWeg(weg, w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k2 && i.consignmentId !== w.k3) });
  reload();
  ok(r.ok, `§2 ${weg}: zwei Kommissionszeilen entfernt (${r.code || 'ok'})`);
  ok(n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 3 && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 4360,
    `§2 ${weg}: die übrigen 3 Zeilen bleiben, Summe 4.360 (${n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv])})`);
  ok(S(w.db.exec('SELECT status, invoice_id IS NULL, sale_price IS NULL FROM consignments WHERE id IN (?, ?) ORDER BY consignment_number', [w.k2, w.k3])[0]?.values) === S([['active', 1, 1], ['active', 1, 1]])
    && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.k1]) === 'sold',
    `§2 ${weg}: entfernte Kommissionen wieder Active, ohne Verkaufsfelder; k1 bleibt verkauft`);
  ok(S(w.db.exec('SELECT stock_status, source_type, quantity FROM products WHERE id IN (?, ?)', [pidVon(w.db, w.k2), pidVon(w.db, w.k3)])[0]?.values) === S([['consignment', 'CONSIGNMENT', 1], ['consignment', 'CONSIGNMENT', 1]]),
    `§2 ${weg}: Artikel zurück im Kommissionsbestand (Menge 1)`);
  ok(S(w.db.exec('SELECT status, ROUND(total_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])[0]?.values?.[0]) === S(['UNPAID', 960, 960])
    && n(w.db, 'SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = ?', [ali]) === 1 && n(w.db, 'SELECT COUNT(*) FROM purchase_returns') === 0,
    `§2 ${weg}: gemeinsamer unbezahlter Einkauf: nur die Zeile geht (960 offen, keine Retoure)`);
  ok(s(w.db, 'SELECT status FROM purchases WHERE id = ?', [sara]) === 'CANCELLED', `§2 ${weg}: Einkauf, der nur dieser Kommission gehörte: storniert`);
  // E11 — die Gegenbuchungen der Einlieferer-Seite stehen auf dem Tag ihres Originals (nicht heute).
  const gegen = all(w.db, `SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id IN (?, ?) AND reverses_entry_id IS NOT NULL`, [ali, sara]);
  const orig = all(w.db, `SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id IN (?, ?) AND reverses_entry_id IS NULL`, [ali, sara]);
  ok(gegen === orig, `§2 ${weg}: Gegenbuchungen der Einkäufe auf dem Tag des Originals (${gegen} = ${orig})`);
  ok(abgleich4(w.db).length === 0, `§2 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  const audit = s(w.db, "SELECT new_value FROM audit_log WHERE field_name = 'mixed_invoice_correction' AND entity_id = ?", [inv]);
  ok(/"removed":\[/.test(audit) && JSON.parse(audit || '{}').removed?.length === 2 && n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'invoice_line_removed'") === 2,
    `§2 ${weg}: Audit der Korrektur und je Kommission (${audit.slice(0, 120)})`);
  // Ein entfernter Artikel ist wieder verkaufbar (Record Sale).
  setTestDatabase(w.db as never); reload();
  const wieder = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [{ consignmentId: w.k2, salePrice: 1100, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' }], buyerId: 'cust-2', specialMark: false }));
  ok(wieder.ok && abgleich4(w.db).length === 0, `§2 ${weg}: der entfernte Artikel lässt sich neu verkaufen (${wieder.code || 'ok'})`);
}

// ══ §3 E5 + E2 — Kommissionszeile entfernen, Einlieferer schon bezahlt: Pflichtwahl Guthaben / Rückforderung ══
for (const wahl of ['credit', 'refund'] as const) {
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k2);
  bezahleEinkauf(w.db, ali, 1840);
  const vorher = zaehler4(w.db);
  const ohne = await korrPrimary(w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k2) });
  ok(!ohne.ok && ohne.code === 'CONSIGNOR_OVERPAY_CHOICE_REQUIRED' && zaehler4(w.db) === vorher, `§3 ${wahl}: ohne Wahl ⇒ Nein, nichts geändert (${ohne.code})`);
  const r = await korrPrimary(w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k2), consignorOverpay: { [ali]: wahl } });
  reload();
  ok(r.ok, `§3 ${wahl}: entfernt (${r.code || 'ok'})`);
  const kredit = w.db.exec("SELECT id, ROUND(amount,3), status, source_return_id IS NOT NULL FROM supplier_credits ORDER BY created_at DESC LIMIT 1")[0]?.values?.[0] ?? [];
  ok(Number(kredit[1]) === 880 && kredit[2] === (wahl === 'credit' ? 'OPEN' : 'REFUND_DUE') && Number(kredit[3]) === 1,
    `§3 ${wahl}: die Zeile geht über die Lieferanten-Retoure zurück, 880 als ${wahl === 'credit' ? 'Guthaben (OPEN)' : 'Rückforderung (REFUND_DUE)'} (${S(kredit)})`);
  // Wie bei „Cancel Sale"/D3: die Zahlungszeile bleibt (Historie); der Kopf zeigt, was nach der Rückgabe als bezahlt zählt.
  ok(n(w.db, 'SELECT ROUND(SUM(amount),3) FROM purchase_payments WHERE purchase_id = ? AND voided_at IS NULL', [ali]) === 1840
    && S(w.db.exec('SELECT status, ROUND(total_amount,3), ROUND(paid_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])[0]?.values?.[0]) === S(['PAID', 960, 960, 0]),
    `§3 ${wahl}: die Zahlung (1.840) bleibt als Zeile; Einkauf danach 960, als bezahlt gezählt 960 (${all(w.db, 'SELECT status, ROUND(total_amount,3), ROUND(paid_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])})`);
  ok(abgleich4(w.db).length === 0, `§3 ${wahl}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  if (wahl === 'refund') {
    setTestDatabase(w.db as never);
    const rp = await primary(() => imHaus(() => recordSupplierCreditRefundInHouse({ creditId: String(kredit[0]), amount: 880, method: 'cash' }, ctxH)));
    ok(rp.ok && s(w.db, 'SELECT status FROM supplier_credits WHERE id = ?', [kredit[0]]) === 'REFUNDED' && abgleich4(w.db).length === 0,
      `§3 Rückforderung: „Record Repayment" zahlt sie ganz zurück ⇒ REFUNDED, Abgleich ok (${rp.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
  }
}

// ══ §4 E2/E9 — Preis einer Kommissionszeile korrigieren: unbezahlt (Einkauf folgt) und bezahlt (Überzahlung, Wahl) ══
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k1);
  const r = await korrWeg(weg, w, inv, { items: (ist) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i)) });
  reload();
  ok(r.ok, `§4 ${weg}: Preis k1 1.200 → 1.000 (${r.code || 'ok'})`);
  const zeile = w.db.exec('SELECT ROUND(line_total,3), ROUND(purchase_price_snapshot,3), tax_scheme, ROUND(vat_amount,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, pidVon(w.db, w.k1)])[0]?.values?.[0];
  ok(S(zeile) === S([1000, 800, 'MARGIN', 18.182]), `§4 ${weg}: Rechnungszeile 1.000, Einstand 800, Margen-VAT aus der Auszahlung (${S(zeile)})`);
  ok(S(w.db.exec('SELECT status, ROUND(total_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])[0]?.values?.[0]) === S(['UNPAID', 1680, 1680])
    && n(w.db, "SELECT ROUND(unit_cost,3) FROM stock_lots WHERE product_id = ?", [pidVon(w.db, w.k1)]) === 800,
    `§4 ${weg}: Einkauf 1.840 → 1.680 (Zeile 800), Los-Einstand 800`);
  ok(S(w.db.exec('SELECT ROUND(sale_price,3), ROUND(payout_amount,3), ROUND(commission_amount,3) FROM consignments WHERE id = ?', [w.k1])[0]?.values?.[0]) === S([1000, 800, 200]),
    `§4 ${weg}: Kommission: Verkaufspreis 1.000, Auszahlung 800, Provision 200`);
  const cogs = n(w.db, `SELECT ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),3) FROM ledger_entries WHERE account = 'COGS' AND source_module = 'INVOICE' AND source_id = ?`, [inv]);
  ok(cogs === 2000 + 500 + 800 + 880 + 909.091, `§4 ${weg}: Wareneinsatz der Rechnung folgt dem neuen Einstand (${cogs})`);
  ok(abgleich4(w.db).length === 0, `§4 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}
for (const wahl of ['credit', 'refund'] as const) {
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k1);
  bezahleEinkauf(w.db, ali, 1840);
  const vorher = zaehler4(w.db);
  const senken = (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i));
  const ohne = await korrPrimary(w, inv, { items: senken });
  ok(!ohne.ok && ohne.code === 'CONSIGNOR_OVERPAY_CHOICE_REQUIRED' && zaehler4(w.db) === vorher, `§4 bezahlt ${wahl}: ohne Wahl ⇒ Nein, nichts geändert (${ohne.code})`);
  const r = await korrPrimary(w, inv, { items: senken, consignorOverpay: { [ali]: wahl } });
  reload();
  const kredit = w.db.exec('SELECT ROUND(amount,3), status, source_purchase_id FROM supplier_credits WHERE source_purchase_id = ?', [ali])[0]?.values?.[0] ?? [];
  ok(r.ok && Number(kredit[0]) === 160 && kredit[1] === (wahl === 'credit' ? 'OPEN' : 'REFUND_DUE'),
    `§4 bezahlt ${wahl}: Überzahlung 160 als ${wahl === 'credit' ? 'Guthaben' : 'Rückforderung'} (${r.code || 'ok'} ${S(kredit)})`);
  ok(S(w.db.exec('SELECT status, ROUND(total_amount,3), ROUND(paid_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])[0]?.values?.[0]) === S(['PAID', 1680, 1840, 0]),
    `§4 bezahlt ${wahl}: Einkauf 1.680, bezahlt 1.840 (Zahlung bleibt), offen 0`);
  ok(abgleich4(w.db).length === 0, `§4 bezahlt ${wahl}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  if (wahl === 'refund') {
    setTestDatabase(w.db as never);
    const cid = s(w.db, 'SELECT id FROM supplier_credits WHERE source_purchase_id = ?', [ali]);
    const rp = await primary(() => imHaus(() => recordSupplierCreditRefundInHouse({ creditId: cid, amount: 100, method: 'bank' }, ctxH)));
    ok(rp.ok && s(w.db, 'SELECT status FROM supplier_credits WHERE id = ?', [cid]) === 'REFUND_DUE' && n(w.db, 'SELECT ROUND(used_amount,3) FROM supplier_credits WHERE id = ?', [cid]) === 100
      && abgleich4(w.db).length === 0, `§4 Rückforderung teilweise zurückgezahlt (100 von 160), offen bleibt 60 (${rp.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
    // Die Kommissionsansicht zeigt die Rückforderung mit ihrem Guthaben (für „Record Repayment"), am PC2 über denselben Lesebefehl.
    reload();
    const seite = useConsignmentStore.getState().consignments.find((c) => c.id === w.k1)?.consignorSide;
    const zeile = seite?.refunds.find((x) => x.creditId === cid);
    ok(!!zeile && zeile.mode === 'pending' && Math.abs(zeile.open - 60) < 0.001 && Math.abs(zeile.received - 100) < 0.001 && zeile.currentSale,
      `§4 Rückforderung in der Einlieferer-Seite der Kommission (offen 60, erhalten 100) (${S(zeile)})`);
  }
  // Eine überzahlte Einlieferer-Seite: „Cancel Sale" und das Entfernen der Zeile sagen ein klares Nein (nichts doppelt zurück).
  {
    setTestDatabase(w.db as never); reload();
    const v = zaehler4(w.db);
    const { cancelConsignmentSaleInHouse, localConsignmentActor } = await import('../../src/core/consignment/consignment-reversal-house.ts');
    const cs = await primary(() => imHaus(() => cancelConsignmentSaleInHouse(w.k1, localConsignmentActor(), 'branch-main')));
    const weg = await korrPrimary(w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k2), consignorOverpay: { [ali]: wahl } });
    ok(!cs.ok && cs.code === 'CONSIGNOR_OVERPAID' && !weg.ok && weg.code === 'CONSIGNOR_OVERPAID' && zaehler4(w.db) === v,
      `§4 bezahlt ${wahl}: überzahlter Einkauf ⇒ Cancel Sale und Zeile entfernen: Nein, nichts geändert (${cs.code}/${weg.code})`);
  }
}
{
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k1);
  bezahleEinkauf(w.db, ali, 1840);
  const r = await korrPrimary(w, inv, { items: (ist) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1300 } : i)) });
  reload();
  ok(r.ok && S(w.db.exec('SELECT status, ROUND(total_amount,3), ROUND(remaining_amount,3) FROM purchases WHERE id = ?', [ali])[0]?.values?.[0]) === S(['PARTIALLY_PAID', 1920, 80])
    && abgleich4(w.db).length === 0, `§4 bezahlt + Preis höher: Einkauf 1.920, 80 offen, keine Wahl nötig (${r.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
}

// ══ §5 E9 + E5/E9 Owner — Verlust-Ausgabe: unbezahlt direkt, teilbezahlt folgt die offene Schuld, Überzahlung mit Pflichtwahl (wie die Order-Kosten) ══
{
  const { w, inv } = await gemischt();
  const sara = einkaufDer(w.db, w.k3);
  const k3p = pidVon(w.db, w.k3);
  const preis = (p: number, ack = true) => (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k3 ? { ...i, salePrice: p, ...(ack ? { acknowledgeShortfall: true } : {}) } : i));
  const vorher = zaehler4(w.db);
  const ohne = await korrPrimary(w, inv, { items: preis(900, false) });
  ok(!ohne.ok && ohne.code === 'SALE_BELOW_FLOOR' && zaehler4(w.db) === vorher, `§5 unter den Boden ohne Bestätigung ⇒ Nein, nichts geändert (${ohne.code})`);
  const r = await korrPrimary(w, inv, { items: preis(900) });
  reload();
  const verlust = () => all(w.db, "SELECT ROUND(amount,3), status, expense_date FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED' ORDER BY created_at, id");
  ok(r.ok && verlust() === S([[100, 'PENDING', HEUTE]]).replace('PENDING', s(w.db, "SELECT status FROM expenses WHERE category = 'ConsignorLoss' LIMIT 1")),
    `§5 Preis 1.050 → 900 (Boden 1.000): Verlust-Ausgabe 100 am Rechnungsdatum (${r.code || 'ok'} ${verlust()})`);
  ok(S(w.db.exec('SELECT ROUND(line_total,3), tax_scheme, ROUND(vat_amount,3) FROM purchase_lines WHERE purchase_id = ?', [sara])[0]?.values?.[0]) === S([900, 'VAT_10', 81.818])
    && n(w.db, 'SELECT ROUND(unit_cost,3) FROM stock_lots WHERE product_id = ?', [k3p]) === 818.182
    && n(w.db, 'SELECT ROUND(purchase_price_snapshot,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, k3p]) === 818.182,
    '§5 Einkauf = Verkaufspreis 900 (VAT 81,818), Los und Wareneinsatz 818,182');
  ok(S(w.db.exec('SELECT ROUND(payout_amount,3), ROUND(commission_amount,3) FROM consignments WHERE id = ?', [w.k3])[0]?.values?.[0]) === S([1000, -100]),
    '§5 Kommission: Auszahlung bleibt 1.000 (Agreed), Provision −100');
  ok(abgleich4(w.db).length === 0, `§5 Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  const r2 = await korrPrimary(w, inv, { items: preis(950) });
  reload();
  ok(r2.ok && verlust().startsWith('[[50,') && n(w.db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss'") === 1 && abgleich4(w.db).length === 0,
    `§5 unbezahlt 950: dieselbe Ausgabe auf 50 angepasst, keine zweite (${r2.code || 'ok'} ${verlust()})`);
  // ── E5/E9 Owner-Entscheidung: dieselbe Logik wie die Custom-Order-Kosten ──
  const eid = s(w.db, "SELECT id FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'");
  setTestDatabase(w.db as never);
  imHaus(() => recordExpensePaymentInHouse(eid, 30, 'cash', ctxH));
  reload();
  const kredite = () => all(w.db, "SELECT ROUND(amount,3), status, ROUND(used_amount,3) FROM supplier_credits WHERE source_purchase_id IS NULL AND source_return_id IS NULL ORDER BY created_at, id");
  const ausgabe = () => all(w.db, 'SELECT ROUND(amount,3), ROUND(paid_amount,3), status FROM expenses WHERE id = ?', [eid]);
  // Fall 2 — teilweise bezahlt (30 von 50), keine Überzahlung: Preis 960 ⇒ Verlust 40, offene Schuld 10, ohne Dialog.
  const teil = await korrPrimary(w, inv, { items: preis(960) });
  reload();
  ok(teil.ok && ausgabe() === S([[40, 30, s(w.db, 'SELECT status FROM expenses WHERE id = ?', [eid])]]) && kredite() === '[]' && abgleich4(w.db).length === 0,
    `§5 teilbezahlt 30, Verlust 50 → 40: offene Schuld folgt (10), kein Dialog, kein Guthaben (${teil.code || 'ok'} ${ausgabe()} ${abgleich4(w.db).join('; ')})`);
  // Fall 3 — echte Überzahlung: Preis 990 ⇒ Verlust 10 < bezahlt 30. Ohne Wahl ⇒ Nein; mit Guthaben ⇒ 20 verrechenbar.
  const v2 = zaehler4(w.db);
  const ohneWahl = await korrPrimary(w, inv, { items: preis(990) });
  ok(!ohneWahl.ok && ohneWahl.code === 'CONSIGNOR_OVERPAY_CHOICE_REQUIRED' && zaehler4(w.db) === v2,
    `§5 Überzahlung (bezahlt 30, neuer Verlust 10) ohne Wahl ⇒ Nein, nichts geändert (${ohneWahl.code})`);
  const gut = await korrPrimary(w, inv, { items: preis(990), lossOverpay: { [w.k3]: 'credit' } });
  reload();
  ok(gut.ok && ausgabe() === S([[10, 30, s(w.db, 'SELECT status FROM expenses WHERE id = ?', [eid])]]) && kredite() === S([[20, 'OPEN', 0]])
    && n(w.db, 'SELECT ROUND(SUM(amount),3) FROM expense_payments WHERE expense_id = ?', [eid]) === 30,
    `§5 mit „Guthaben": Verlust 10, Zahlung 30 bleibt, 20 als verrechenbares Lieferanten-Guthaben (${gut.code || 'ok'} ${ausgabe()} ${kredite()})`);
  const meta = s(w.db, "SELECT metadata_json FROM ledger_entries WHERE source_module = 'ORDER_COST_OVERPAY' AND reverses_entry_id IS NULL LIMIT 1");
  ok(new RegExp(`"consignmentId":"${w.k3}"`).test(meta) && /"expenseId"/.test(meta) && /consignor_loss_overpay/.test(meta)
    && n(w.db, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'consignor_loss_overpay'") === 1,
    `§5 dieselbe Buchung wie die Order-Kosten (ORDER_COST_OVERPAY, mit Kommission und Ausgabe), Protokoll (${meta.slice(0, 120)})`);
  ok(abgleich4(w.db).length === 0, `§5 Abgleich nach der Überzahlung ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  // Fall 4 — die Kosten ganz weg (Preis 1.000 ⇒ Verlust 0): dieselbe Logik; die frühere Überzahlung wird angeglichen.
  const weg = await korrPrimary(w, inv, { items: preis(1000), lossOverpay: { [w.k3]: 'refund' } });
  reload();
  ok(weg.ok && s(w.db, 'SELECT status FROM expenses WHERE id = ?', [eid]) === 'CANCELLED' && kredite() === S([[30, 'REFUND_DUE', 0]])
    && n(w.db, 'SELECT ROUND(SUM(amount),3) FROM expense_payments WHERE expense_id = ?', [eid]) === 30 && abgleich4(w.db).length === 0,
    `§5 Verlust 0: Ausgabe storniert, Zahlung bleibt, 30 als Rückforderung (das frühere Guthaben 20 angeglichen) (${weg.code || 'ok'} ${kredite()} ${abgleich4(w.db).join('; ')})`);
  // Die Rückforderung: in der Einlieferer-Seite der Kommission, „Record Repayment" zahlt sie zurück.
  const claim = s(w.db, "SELECT id FROM supplier_credits WHERE status = 'REFUND_DUE' AND source_purchase_id IS NULL AND source_return_id IS NULL");
  reload();
  const zeileK3 = useConsignmentStore.getState().consignments.find((c) => c.id === w.k3)?.consignorSide?.refunds.find((x) => x.creditId === claim);
  ok(!!zeileK3 && zeileK3.mode === 'pending' && Math.abs(zeileK3.open - 30) < 0.001, `§5 die Rückforderung steht an der Kommission (offen 30) (${S(zeileK3)})`);
  setTestDatabase(w.db as never);
  const rp = await primary(() => imHaus(() => recordSupplierCreditRefundInHouse({ creditId: claim, amount: 30, method: 'cash' }, ctxH)));
  ok(rp.ok && s(w.db, 'SELECT status FROM supplier_credits WHERE id = ?', [claim]) === 'REFUNDED' && abgleich4(w.db).length === 0,
    `§5 „Record Repayment" ⇒ REFUNDED, Abgleich ok (${rp.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
  // Danach wieder ein Verlust (Preis 900): die alte Ausgabe bleibt storniert, ihre zurückgezahlte Rückforderung unberührt — der
  // neue Verlust ist eine NEUE, unbezahlte Ausgabe (der Einlieferer hat nichts mehr offen, wir schulden ihm 100).
  const neu = await korrPrimary(w, inv, { items: preis(900) });
  reload();
  ok(neu.ok && s(w.db, 'SELECT status FROM expenses WHERE id = ?', [eid]) === 'CANCELLED' && s(w.db, 'SELECT status FROM supplier_credits WHERE id = ?', [claim]) === 'REFUNDED'
    && all(w.db, "SELECT ROUND(amount,3), ROUND(paid_amount,3) FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'") === S([[100, 0]]) && abgleich4(w.db).length === 0,
    `§5 danach neuer Verlust 100 als neue Ausgabe; die alte (storniert) und ihre zurückgezahlte Rückforderung bleiben (${neu.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
}
// Eine schon verrechnete Überzahlung wird nicht still angeglichen (dieselbe Sperre wie bei den Order-Kosten).
{
  const { w, inv } = await gemischt();
  const preis = (p: number) => (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k3 ? { ...i, salePrice: p, acknowledgeShortfall: true } : i));
  await korrPrimary(w, inv, { items: preis(900) });
  reload();
  const eid = s(w.db, "SELECT id FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'");
  setTestDatabase(w.db as never);
  imHaus(() => recordExpensePaymentInHouse(eid, 100, 'cash', ctxH));
  reload();
  const g = await korrPrimary(w, inv, { items: preis(980), lossOverpay: { [w.k3]: 'credit' } });
  reload();
  const credit = s(w.db, "SELECT id FROM supplier_credits WHERE status = 'OPEN' AND source_purchase_id IS NULL AND source_return_id IS NULL");
  // Saras Einkauf (unbezahlt, 980) wird teilweise mit diesem Guthaben beglichen — die Überzahlung ist damit verrechnet.
  setTestDatabase(w.db as never);
  const off = await primary(() => imHaus(() => applyOneCreditToPurchaseInHouse(credit, einkaufDer(w.db, w.k3), 30, ctxH)));
  reload();
  const v3 = zaehler4(w.db);
  const zurueck = await korrPrimary(w, inv, { items: preis(1000), lossOverpay: { [w.k3]: 'credit' } });
  ok(g.ok && off.ok && !zurueck.ok && zurueck.code === 'ORDER_COST_OVERPAY_USED' && zaehler4(w.db) === v3 && abgleich4(w.db).length === 0,
    `§5 Überzahlung (80) schon zum Teil verrechnet (30) ⇒ der Verlust wird danach nicht mehr still geändert, nichts geändert (${g.code || 'ok'}/${off.code || 'ok'}/${zurueck.code})`);
}

// ══ §5b E5/E9 — Zeile mit bezahltem Verlust entfernen (Primary und PC2 gleich), Rollback ══
{
  const bilder5: string[] = [];
  for (const weg of ['primary', 'pc2'] as const) {
    const { w, inv } = await gemischt();
    const preis900 = (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k3 ? { ...i, salePrice: 900, acknowledgeShortfall: true } : i));
    const r0 = await korrWeg(weg, w, inv, { items: preis900 });
    reload();
    const eid = s(w.db, "SELECT id FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'");
    setTestDatabase(w.db as never);
    imHaus(() => recordExpensePaymentInHouse(eid, 100, 'cash', ctxH));
    reload();
    const sara = einkaufDer(w.db, w.k3);
    const v = zaehler4(w.db);
    const ohne = await korrWeg(weg, w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k3) });
    ok(r0.ok && !ohne.ok && ohne.code === 'CONSIGNOR_OVERPAY_CHOICE_REQUIRED' && zaehler4(w.db) === v,
      `§5b ${weg}: Zeile mit voll bezahltem Verlust (100) entfernen ohne Wahl ⇒ Nein, nichts geändert (${ohne.code})`);
    const r = await korrWeg(weg, w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k3), lossOverpay: { [w.k3]: 'refund' } });
    reload();
    ok(r.ok && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.k3]) === 'active' && s(w.db, 'SELECT status FROM expenses WHERE id = ?', [eid]) === 'CANCELLED'
      && s(w.db, 'SELECT status FROM purchases WHERE id = ?', [sara]) === 'CANCELLED'
      && all(w.db, "SELECT ROUND(amount,3), status FROM supplier_credits WHERE source_purchase_id IS NULL AND source_return_id IS NULL") === S([[100, 'REFUND_DUE']])
      && n(w.db, 'SELECT ROUND(SUM(amount),3) FROM expense_payments WHERE expense_id = ?', [eid]) === 100,
      `§5b ${weg}: entfernt — Kommission Active, unbezahlter Einkauf storniert, Verlust storniert, Zahlung 100 bleibt, 100 als Rückforderung (${r.code || 'ok'})`);
    ok(abgleich4(w.db).length === 0, `§5b ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
    bilder5.push(S([all(w.db, 'SELECT status, ROUND(amount,3), ROUND(paid_amount,3) FROM expenses ORDER BY amount'),
      all(w.db, 'SELECT ROUND(amount,3), status, used_amount FROM supplier_credits ORDER BY amount'),
      all(w.db, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS x FROM ledger_entries GROUP BY account HAVING ABS(x) > 0.0005 ORDER BY account`)]));
  }
  ok(bilder5.length === 2 && bilder5[0] === bilder5[1], `§5b Primary und PC2 buchen GLEICH (${bilder5[0]?.slice(0, 140)} …)`);
  // Rollback: ein Fehler beim Anlegen der Rückforderung ⇒ nichts geändert.
  const { w, inv } = await gemischt();
  const r0 = await korrPrimary(w, inv, { items: (ist) => ist.map((i) => (i.consignmentId === w.k3 ? { ...i, salePrice: 900, acknowledgeShortfall: true } : i)) });
  reload();
  const eid = s(w.db, "SELECT id FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'");
  setTestDatabase(w.db as never);
  imHaus(() => recordExpensePaymentInHouse(eid, 100, 'cash', ctxH));
  reload();
  const eingabe: KorrIn = { invoiceId: inv, expectedRevision: invRev(w.db, inv), reason: 'Rollback-Probe Verlust', ownLines: eigeneEdit(w.db, inv),
    consignment: korrekturTeil(w.db, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k3), lossOverpay: { [w.k3]: 'credit' } }) };
  const vorher = zaehler4(w.db);
  const { db: kaputt, f } = faulty4(w.db, (sql: string) => /INSERT INTO supplier_credits/i.test(sql));
  setTestDatabase(kaputt as never); reload();
  const rr = await primary(() => korr.correctMixedInvoiceOnPrimary(eingabe));
  f.armed = false;
  setTestDatabase(w.db as never); reload();
  ok(r0.ok && f.fired && !rr.ok && zaehler4(w.db) === vorher && abgleich4(w.db).length === 0,
    `§5b Fehler beim Anlegen des Guthabens ⇒ voller Rollback, nichts geändert (${rr.code.slice(0, 70)})`);
}

// ══ §6 E6 — neue Kommissionszeile: an den unbezahlten Einkauf desselben Einlieferers, sonst eigener Einkauf ══
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const k4 = await kommission(w.db, 'cust-1', 'Twenty-4', PCT);
  const k5 = await kommission(w.db, 'cust-3', 'Gondolo', FIX);
  const ali = einkaufDer(w.db, w.k1);
  const sara = einkaufDer(w.db, w.k3);
  ok(s(w.db, 'SELECT source_consignment_id FROM purchases WHERE id = ?', [sara]) === w.k3, `§6 ${weg}: Ausgang — Saras Einkauf trägt die Kommission am Kopf`);
  const dazu = (ist: Korr[]) => [...ist, { consignmentId: k4, salePrice: 1500, taxScheme: 'MARGIN' as const }, { consignmentId: k5, salePrice: 1200, taxScheme: 'ZERO' as const }];
  const r = await korrWeg(weg, w, inv, { items: dazu, extra: [k4, k5] });
  reload();
  ok(r.ok, `§6 ${weg}: zwei Kommissionszeilen hinzugefügt (${r.code || 'ok'})`);
  ok(n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 7 && n(w.db, 'SELECT ROUND(gross_amount,3) FROM invoices WHERE id = ?', [inv]) === 6510 + 1500 + 1200,
    `§6 ${weg}: Rechnung mit 7 Zeilen, Summe 9.210`);
  ok(n(w.db, 'SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = ?', [ali]) === 3 && n(w.db, 'SELECT ROUND(total_amount,3) FROM purchases WHERE id = ?', [ali]) === 1840 + 1200
    && n(w.db, "SELECT COUNT(*) FROM purchases WHERE supplier_id != 'sup-1'") === 2,
    `§6 ${weg}: Ali — an seinen unbezahlten Einkauf angehängt (3 Zeilen, 3.040), kein neuer Einkauf`);
  ok(s(w.db, 'SELECT source_consignment_id FROM purchases WHERE id = ?', [sara]) === ''
    && all(w.db, 'SELECT source_consignment_id FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [sara]) === S([[w.k3], [k5]])
    && S(w.db.exec('SELECT ROUND(line_total,3), tax_scheme FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [sara])[0]?.values) === S([[1000, 'VAT_10'], [1000, 'VAT_10']]),
    `§6 ${weg}: Sara — angehängt, Kopf leer, die Kommission an jeder Zeile, Einkaufs-VAT des Einkaufs übernommen`);
  ok(S(w.db.exec('SELECT status, invoice_id = ?, buyer_id FROM consignments WHERE id IN (?, ?) ORDER BY consignment_number', [inv, k4, k5])[0]?.values) === S([['sold', 1, 'cust-2'], ['sold', 1, 'cust-2']]),
    `§6 ${weg}: neue Kommissionen sold, an der Rechnung, Käufer`);
  setTestDatabase(w.db as never); reload();
  const seite = useConsignmentStore.getState().consignments.find((c) => c.id === k5)?.consignorSide;
  ok(Math.abs((seite?.open ?? -1) - 1000) < 0.001, `§6 ${weg}: Einlieferer-Seite je Kommission richtig (k5 offen 1.000: ${S(seite)})`);
  ok(abgleich4(w.db).length === 0, `§6 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
}
{
  // Bezahlter Einkauf ⇒ eigener neuer Einkauf; dessen Einkaufs-VAT ist Pflicht (D2).
  const { w, inv } = await gemischt();
  const k5 = await kommission(w.db, 'cust-3', 'Gondolo', FIX);
  const sara = einkaufDer(w.db, w.k3);
  bezahleEinkauf(w.db, sara, 500);
  const dazu = (ist: Korr[]) => [...ist, { consignmentId: k5, salePrice: 1200, taxScheme: 'ZERO' as const }];
  const vorher = zaehler4(w.db);
  const ohne = await korrPrimary(w, inv, { items: dazu, extra: [k5] });
  ok(!ohne.ok && ohne.code === 'CONSIGNOR_VAT_REQUIRED' && zaehler4(w.db) === vorher, `§6 bezahlter Einkauf: neuer Einkauf ohne Einkaufs-VAT ⇒ Nein (${ohne.code})`);
  const r = await korrPrimary(w, inv, { items: dazu, extra: [k5], consignorTaxSchemes: { 'cust-3': 'ZERO' } });
  reload();
  ok(r.ok && n(w.db, 'SELECT COUNT(*) FROM purchase_lines WHERE purchase_id = ?', [sara]) === 1
    && s(w.db, 'SELECT tax_scheme FROM purchase_lines WHERE source_consignment_id = ?', [k5]) === 'ZERO'
    && s(w.db, 'SELECT p.purchase_date FROM purchases p JOIN purchase_lines pl ON pl.purchase_id = p.id WHERE pl.source_consignment_id = ?', [k5]) === HEUTE
    && abgleich4(w.db).length === 0,
    `§6 bezahlter Einkauf bleibt unberührt, neuer Einkauf ohne VAT am Rechnungsdatum (${r.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
  // Sperren beim Hinzufügen: Käufer ist Einlieferer, nicht aktiv, E7.
  const w2 = await gemischt();
  const kc = await kommission(w2.w.db, 'cust-2', 'Eigene des Käufers', PCT);
  const kE7 = await kommission(w2.w.db, 'cust-1', 'Ellipse', { model: 'percent', commissionRate: 5 });
  const v2 = zaehler4(w2.w.db);
  const k1 = await korrPrimary(w2.w, w2.inv, { items: (ist) => [...ist, { consignmentId: kc, salePrice: 900, taxScheme: 'MARGIN' }], extra: [kc] });
  ok(!k1.ok && k1.code === 'BUYER_IS_CONSIGNOR' && zaehler4(w2.w.db) === v2, `§6 Kommission des Käufers selbst ⇒ Nein (${k1.code})`);
  const e7 = await korrPrimary(w2.w, w2.inv, { items: (ist) => [...ist, { consignmentId: kE7, salePrice: 1100, taxScheme: 'VAT_10' }], extra: [kE7] });
  ok(!e7.ok && e7.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler4(w2.w.db) === v2, `§6 E7 beim Hinzufügen ohne Bestätigung ⇒ Nein (${e7.code})`);
  const e7ok = await korrPrimary(w2.w, w2.inv, { items: (ist) => [...ist, { consignmentId: kE7, salePrice: 1100, taxScheme: 'VAT_10', acknowledgeVatShortfall: true }], extra: [kE7] });
  ok(e7ok.ok && abgleich4(w2.w.db).length === 0, `§6 E7 mit Bestätigung ⇒ hinzugefügt (${e7ok.code || 'ok'})`);
}

// ══ §7 E10 — Einkaufs-VAT eines unbezahlten Einkaufs ändern; nach der ersten Auszahlung gesperrt ══
{
  const { w, inv } = await gemischt();
  const sara = einkaufDer(w.db, w.k3);
  const k3p = pidVon(w.db, w.k3);
  const r = await korrPrimary(w, inv, { purchaseTaxSchemes: { [sara]: 'ZERO' } });
  reload();
  ok(r.ok && S(w.db.exec('SELECT tax_scheme, ROUND(vat_amount,3), ROUND(line_total,3) FROM purchase_lines WHERE purchase_id = ?', [sara])[0]?.values?.[0]) === S(['ZERO', 0, 1000])
    && n(w.db, 'SELECT ROUND(unit_cost,3) FROM stock_lots WHERE product_id = ?', [k3p]) === 1000
    && n(w.db, 'SELECT ROUND(purchase_price_snapshot,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, k3p]) === 1000,
    `§7 Einkaufs-VAT 10 % → ohne VAT: Zeile ohne Vorsteuer, Los und Wareneinsatz 1.000 (${r.code || 'ok'})`);
  ok(n(w.db, `SELECT COALESCE(ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),3),0) FROM ledger_entries WHERE account = 'VAT_INPUT' AND source_id = ?`, [sara]) === 0
    && n(w.db, 'SELECT ROUND(line_total,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, k3p]) === 1050,
    '§7 Vorsteuer des Einkaufs gegengebucht, die Rechnungszeile (Kunde) unverändert 1.050');
  ok(abgleich4(w.db).length === 0, `§7 Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
  bezahleEinkauf(w.db, sara, 100);
  const v = zaehler4(w.db);
  const zu = await korrPrimary(w, inv, { purchaseTaxSchemes: { [sara]: 'VAT_10' } });
  ok(!zu.ok && zu.code === 'CONSIGNOR_VAT_LOCKED' && zaehler4(w.db) === v, `§7 nach der ersten Auszahlung ⇒ Nein (${zu.code})`);
}

// ══ §8 E3 — Rechnungsdatum: unbezahlter Einkauf folgt, bezahlter behält seins; nie vor der Einlieferung / dem bezahlten Einkauf ══
{
  const { w, inv } = await gemischt();
  w.db.run("UPDATE consignments SET agreement_date = '2026-10-20'");
  const ali = einkaufDer(w.db, w.k1);
  const sara = einkaufDer(w.db, w.k3);
  const k3p = pidVon(w.db, w.k3);
  // Saras Einkauf ist bezahlt — ein Tag VOR seinem Datum geht nicht; Alis (unbezahlt) folgt.
  bezahleEinkauf(w.db, sara, 1000);
  const v = zaehler4(w.db);
  const frueh = await korrPrimary(w, inv, { issuedAt: '2026-11-02' });
  ok(!frueh.ok && frueh.code === 'SALE_BEFORE_PAID_PURCHASE' && zaehler4(w.db) === v, `§8 Datum vor dem bezahlten Einkauf ⇒ Nein (${frueh.code})`);
  const vorEin = await korrPrimary(w, inv, { issuedAt: '2026-10-18' });
  ok(!vorEin.ok && /SALE_BEFORE_CONSIGNMENT|SALE_BEFORE_PAID_PURCHASE/.test(vorEin.code) && zaehler4(w.db) === v, `§8 Datum vor der Einlieferung ⇒ Nein (${vorEin.code})`);
  // Ohne Saras Kommission (entfernt geht nicht — bezahlt; also eine frische Welt ohne Zahlung).
  const { w: w2, inv: inv2 } = await gemischt();
  w2.db.run("UPDATE consignments SET agreement_date = '2026-10-20'");
  const ali2 = einkaufDer(w2.db, w2.k1);
  const sara2 = einkaufDer(w2.db, w2.k3);
  bezahleEinkauf(w2.db, sara2, 1000);
  const spaeter = await korrPrimary(w2, inv2, { issuedAt: HEUTE });
  ok(spaeter.ok, `§8 unverändertes Datum ⇒ ok (${spaeter.code || 'ok'})`);
  const vorEinkauf = await korrPrimary(w2, inv2, { issuedAt: '2026-11-03', items: (ist) => ist.filter((i) => i.consignmentId !== w2.k3), consignorOverpay: { [sara2]: 'credit' } });
  reload();
  ok(vorEinkauf.ok, `§8 Saras Zeile (bezahlt) entfernt und Datum 03.11. (${vorEinkauf.code || 'ok'})`);
  ok(s(w2.db, 'SELECT substr(issued_at,1,10) FROM invoices WHERE id = ?', [inv2]) === '2026-11-03'
    && s(w2.db, 'SELECT purchase_date FROM purchases WHERE id = ?', [ali2]) === '2026-11-03'
    && all(w2.db, "SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ? AND reverses_entry_id IS NULL AND id NOT IN (SELECT reverses_entry_id FROM ledger_entries WHERE reverses_entry_id IS NOT NULL)", [ali2]) === S([['2026-11-03']]),
    `§8 unbezahlter Einkauf folgt dem Rechnungsdatum (Kopf und Buchung 03.11.)`);
  ok(abgleich4(w2.db).length === 0, `§8 Abgleich ohne Abweichung (${abgleich4(w2.db).join('; ')})`);
  void ali; void k3p;
}

// ══ §9 E4 — Kunde wechseln: Käufer der Kommissionen zieht mit, Käufer ≠ Einlieferer gegen den neuen Kunden ══
for (const weg of ['primary', 'pc2'] as const) {
  const { w, inv } = await gemischt();
  const v = zaehler4(w.db);
  const falsch = await korrWeg(weg, w, inv, { customerId: 'cust-1' });
  ok(!falsch.ok && falsch.code === 'BUYER_IS_CONSIGNOR' && zaehler4(w.db) === v, `§9 ${weg}: neuer Kunde ist Einlieferer ⇒ Nein (${falsch.code})`);
  w.db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-4','branch-main','Omar','Saleh','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  const r = await korrWeg(weg, w, inv, { customerId: 'cust-4' });
  reload();
  ok(r.ok && s(w.db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]) === 'cust-4'
    && all(w.db, 'SELECT DISTINCT buyer_id FROM consignments WHERE invoice_id = ?', [inv]) === S([['cust-4']]) && abgleich4(w.db).length === 0,
    `§9 ${weg}: Rechnung und alle Kommissionen beim neuen Kunden (${r.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
}

// ══ §10 bezahlte Rechnung korrigieren: Kundenüberzahlung mit Pflichtwahl (P1c), Einlieferer-Seite folgt ══
{
  const { w, inv } = await gemischt();
  setTestDatabase(w.db as never); reload();
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 6510, 'cash'));
  reload();
  ok(s(w.db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'FINAL', '§10 Ausgang: Rechnung voll bezahlt (FINAL)');
  const senken = (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i));
  const v = zaehler4(w.db);
  const ohne = await korrPrimary(w, inv, { items: senken });
  ok(!ohne.ok && ohne.code === 'OVERPAY_CHOICE_REQUIRED' && zaehler4(w.db) === v, `§10 Kunde überzahlt ohne Wahl ⇒ Nein, nichts geändert (${ohne.code})`);
  const r = await korrPrimary(w, inv, { items: senken, overpayChoice: 'credit' });
  reload();
  ok(r.ok && n(w.db, "SELECT ROUND(amount,3) FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]) === 200
    && n(w.db, 'SELECT ROUND(total_amount,3) FROM purchases WHERE id = ?', [einkaufDer(w.db, w.k1)]) === 1680 && abgleich4(w.db).length === 0,
    `§10 Kundenguthaben 200, Einlieferer-Einkauf 1.680, Abgleich ok (${r.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
}

// ══ §11 Sperren: zugemachtes Quartal, Fassungen, Rolle, leere Rechnung, eigene Zeile = Kommission; Rollback ══
{
  const { w, inv } = await gemischt();
  const ali = einkaufDer(w.db, w.k1);
  const senken = (ist: Korr[]) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i));
  const pruefe = async (was: string, code: RegExp, o: KOpt, rolle = 'ADMIN', vorbereiten?: () => void): Promise<void> => {
    vorbereiten?.();
    const v = zaehler4(w.db);
    sitzung(rolle);
    const r = await korrPrimary(w, inv, o);
    sitzung('ADMIN');
    ok(!r.ok && code.test(r.code) && zaehler4(w.db) === v, `§11 ${was} ⇒ Nein (${r.code}), nichts geändert`);
  };
  await pruefe('veraltete Fassung des Einkaufs (Auszahlung dazwischen)', /RECORD_CHANGED/, {
    items: senken, revs: (r) => ({ ...r, purchaseRevisions: { ...r.purchaseRevisions, [ali]: r.purchaseRevisions[ali] - 1 } }) });
  await pruefe('Fassung des Einkaufs fehlt', /CORRECTION_REVISION_REQUIRED/, {
    items: senken, revs: (r) => ({ ...r, purchaseRevisions: {} }) });
  await pruefe('veraltete Fassung einer Kommission', /RECORD_CHANGED/, {
    items: senken, revs: (r) => ({ ...r, consignmentRevisions: { ...r.consignmentRevisions, [w.k1]: r.consignmentRevisions[w.k1] - 1 } }) });
  await pruefe('Rolle SALES', /MIXED_INVOICE_NOT_PERMITTED/, { items: senken }, 'SALES');
  await pruefe('Rolle ACCOUNTANT', /MIXED_INVOICE_NOT_PERMITTED/, { items: senken }, 'ACCOUNTANT');
  await pruefe('leere Rechnung', /INVOICE_NEEDS_A_LINE/, { own: 'none', items: () => [] });
  await pruefe('Datum vor der Einlieferung', /SALE_BEFORE_CONSIGNMENT/, { issuedAt: '2026-11-01' }, 'ADMIN',
    () => { w.db.run('UPDATE consignments SET agreement_date = ? WHERE id = ?', [HEUTE, w.k2]); });
  // PC2: dieselbe Rolle des Absenders, veraltete Rechnungsfassung.
  const sales = await korrPC2(w, inv, { items: senken }, 'SALES');
  ok(!sales.ok && sales.code === 'MIXED_INVOICE_NOT_PERMITTED', `§11 PC2 Rolle SALES ⇒ Nein (${sales.code})`);
  ok(perms.roleMayRunOp('SALES', 'invoices.update') === false && perms.roleMayRunOp('ACCOUNTANT', 'invoices.update') === false && perms.roleMayRunOp('MANAGER', 'invoices.update') === true,
    '§11 PC2: invoices.update zentral nur ADMIN/MANAGER (SALES/ACCOUNTANT laufen gar nicht)');
  // Zugemachtes Quartal: die Rechnung steht im eingereichten Q4.
  insert(w.db, 'vat_filings', { id: 'vf-4', branch_id: 'branch-main', year: 2026, quarter: 4, filed_at: NOW, snapshot_json: '{}', created_at: NOW });
  const v = zaehler4(w.db);
  const zu = await korrPrimary(w, inv, { items: senken });
  ok(!zu.ok && /VAT|PERIOD|FILED|QUARTER|CLOSED/i.test(zu.code) && zaehler4(w.db) === v, `§11 eingereichtes VAT-Quartal ⇒ Nein (${zu.code}), nichts geändert`);
  w.db.run("DELETE FROM vat_filings WHERE id = 'vf-4'");
  // Eigene Zeile, die ein Kommissionsartikel ist.
  setTestDatabase(w.db as never); reload();
  const kz = w.db.exec('SELECT id, product_id, lot_id, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, pidVon(w.db, w.k1)])[0].values[0];
  const v3 = zaehler4(w.db);
  const doppelt = await primary(() => korr.correctMixedInvoiceOnPrimary({ invoiceId: inv, expectedRevision: invRev(w.db, inv), reason: 'x',
    ownLines: [...eigeneEdit(w.db, inv), { lineId: String(kz[0]), productId: String(kz[1]), lotId: String(kz[2]), quantity: 1, unitPrice: Number(kz[3]), purchasePrice: Number(kz[4]),
      taxScheme: String(kz[5]), vatRate: Number(kz[6]), vatAmount: Number(kz[7]), lineTotal: Number(kz[8]) }],
    consignment: korrekturTeil(w.db, inv, {}) }));
  ok(!doppelt.ok && doppelt.code === 'OWN_LINE_IS_CONSIGNMENT' && zaehler4(w.db) === v3, `§11 eigene Zeile = Kommissionsartikel ⇒ Nein (${doppelt.code})`);
}
function faulty4(db: Db, when: (sql: string, p?: unknown[]) => boolean) {
  const f = { armed: true, fired: false };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') return (sql: string, p?: unknown[]) => { if (f.armed && when(sql, p)) { f.fired = true; throw new Error('P4: injected failure'); } return (t as Db).run(sql, p); };
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}
for (const [wo, wann] of [
  ['beim Storno des Einkaufs', (sql: string) => /UPDATE purchases SET status = 'CANCELLED'/i.test(sql)],
  ['im Protokoll der Kommission', (sql: string, p?: unknown[]) => /INSERT INTO audit_log/i.test(sql) && Array.isArray(p) && p.includes('invoice_line_removed')],
  ['im Protokoll der ganzen Korrektur', (sql: string, p?: unknown[]) => /INSERT INTO audit_log/i.test(sql) && Array.isArray(p) && p.includes('mixed_invoice_correction')],
] as Array<[string, (sql: string, p?: unknown[]) => boolean]>) {
  const { w, inv } = await gemischt();
  const k4 = await kommission(w.db, 'cust-1', 'Twenty-4', PCT);
  reload();
  const eingabe: KorrIn = { invoiceId: inv, expectedRevision: invRev(w.db, inv), reason: 'Rollback-Probe', ownLines: eigeneEdit(w.db, inv, { 'own-1': 2300 }),
    consignment: korrekturTeil(w.db, inv, { extra: [k4],
      items: (ist) => [...ist.filter((i) => i.consignmentId !== w.k3).map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i)),
        { consignmentId: k4, salePrice: 1500, taxScheme: 'MARGIN' }] }) };
  const vorher = zaehler4(w.db);
  const { db: kaputt, f } = faulty4(w.db, wann);
  setTestDatabase(kaputt as never); reload();
  const r = await primary(() => korr.correctMixedInvoiceOnPrimary(eingabe));
  f.armed = false;
  setTestDatabase(w.db as never); reload();
  ok(f.fired && !r.ok && zaehler4(w.db) === vorher && abgleich4(w.db).length === 0,
    `§11 Fehler ${wo} ⇒ voller Rollback, nichts geändert (${r.code.slice(0, 70)})`);
  const heil = await primary(() => korr.correctMixedInvoiceOnPrimary({ ...eingabe, expectedRevision: invRev(w.db, inv) }));
  ok(heil.ok && abgleich4(w.db).length === 0, `§11 …danach geht dieselbe Korrektur sauber (${heil.code || 'ok'})`);
}

// ══ §12 PC2 = Primary für eine kombinierte Korrektur; Wiederholung bucht einmal ══
{
  const bilder4: Record<string, unknown>[] = [];
  for (const weg of ['primary', 'pc2'] as const) {
    const { w, inv } = await gemischt();
    const k4 = await kommission(w.db, 'cust-1', 'Twenty-4', PCT);
    const o: KOpt = { preis: { 'own-2': 550 }, extra: [k4],
      items: (ist) => [...ist.filter((i) => i.consignmentId !== w.k2).map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000, taxScheme: 'ZERO' as const } : i)),
        { consignmentId: k4, salePrice: 1500, taxScheme: 'MARGIN' }] };
    const r = await korrWeg(weg, w, inv, o);
    reload();
    ok(r.ok, `§12 ${weg}: kombinierte Korrektur (eigener Preis, Zeile weg, Preis+Steuerart, Zeile dazu) (${r.code || 'ok'})`);
    if (r.ok) bilder4.push(bild(w.db, inv));
    ok(abgleich4(w.db).length === 0, `§12 ${weg}: Abgleich ohne Abweichung (${abgleich4(w.db).join('; ')})`);
    if (weg === 'pc2') {
      const { w: w2, inv: inv2 } = await gemischt();
      const rumpf2 = korrRumpf(w2, inv2, { items: (ist) => ist.map((i) => (i.consignmentId === w2.k1 ? { ...i, salePrice: 1000 } : i)) });
      setTestDatabase(w2.db as never); reload();
      const a = await fern(() => invLife.runInvoiceUpdate(deps(w2.db), ident('invoices.update', 'ADMIN', '7777') as never, rumpf2));
      const nachA = zaehler4(w2.db);
      const b = await fern(() => invLife.runInvoiceUpdate(deps(w2.db), ident('invoices.update', 'ADMIN', '7777') as never, rumpf2));
      ok(a.ok && b.ok && b.replayed && zaehler4(w2.db) === nachA, `§12 PC2 Wiederholung desselben Auftrags ⇒ einmal gebucht (replayed ${b.replayed})`);
    }
  }
  if (bilder4.length === 2) ok(S(bilder4[0]) === S(bilder4[1]), `§12 Primary und PC2 buchen GLEICH (${S(bilder4[0]).slice(0, 160)} …)`);
}

// ══ §13 E7 in der Korrektur und am gewöhnlichen Weg (ältere Maske) ══
{
  const w = await welt();
  const k5 = await kommission(w.db, 'cust-1', 'Ellipse', { model: 'percent', commissionRate: 5 });
  const r0 = await amPrimary(w, { items: [...standardItems(w), { consignmentId: k5, salePrice: 1100, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' }] });
  reload();
  const inv = invVon(r0);
  ok(r0.ok, `§13 Ausgang: k5 (5 % Provision) als Margin verkauft (${r0.code || 'ok'})`);
  const umstellen = (ack: boolean) => (ist: Korr[]) => ist.map((i) => (i.consignmentId === k5 ? { ...i, taxScheme: 'VAT_10' as const, ...(ack ? { acknowledgeVatShortfall: true } : {}) } : i));
  const v = zaehler4(w.db);
  const ohne = await korrPrimary(w, inv, { items: umstellen(false) });
  ok(!ohne.ok && ohne.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler4(w.db) === v, `§13 Steuerart → VAT 10 % ohne Bestätigung ⇒ Nein (${ohne.code})`);
  // Die ältere Maske (gewöhnlicher Weg am PC2): dasselbe Nein, nichts gebucht.
  setTestDatabase(w.db as never); reload();
  const kp = pidVon(w.db, k5);
  const lines = w.db.exec('SELECT id, product_id, lot_id, quantity, unit_price, tax_scheme FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv])[0].values
    .map((r) => ({ lineId: String(r[0]), productId: String(r[1]), lotId: String(r[2] ?? '') || null, quantity: Number(r[3]),
      ...(String(r[1]) === kp ? { unitPrice: 1000, customerGross: 1100, scheme: 'VAT_10' } : { unitPrice: Number(r[4]), scheme: String(r[5]) }) }));
  const alt = await fern(() => invLife.runInvoiceUpdate(deps(w.db), ident('invoices.update') as never, {
    id: inv, expectedRevision: invRev(w.db, inv), reason: 'Steuerart', customerId: 'cust-2', lines }));
  ok(!alt.ok && alt.code === 'VAT_SHORTFALL_UNCONFIRMED' && zaehler4(w.db) === v, `§13 gewöhnlicher Weg (ältere Maske) ⇒ Nein, nichts gebucht (${alt.code})`);
  const mit = await korrPrimary(w, inv, { items: umstellen(true) });
  reload();
  ok(mit.ok && s(w.db, 'SELECT tax_scheme FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, kp]) === 'VAT_10'
    && n(w.db, 'SELECT ROUND(line_total,3) FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, kp]) === 1100 && abgleich4(w.db).length === 0,
    `§13 mit Bestätigung ⇒ VAT 10 %, Kundenpreis bleibt 1.100 (${mit.code || 'ok'})`);
}

// ══ §14 Bestehende Wege bleiben: Cancel Sale und Post-Sale Return nach einer Korrektur; reine Record-Sale-Rechnung ══
{
  const { w, inv } = await gemischt();
  const r = await korrPrimary(w, inv, { items: (ist) => ist.map((i) => (i.consignmentId === w.k1 ? { ...i, salePrice: 1000 } : i)) });
  ok(r.ok, `§14 Ausgang: korrigiert (${r.code || 'ok'})`);
  setTestDatabase(w.db as never); reload();
  const { returnConsignmentAfterSaleInHouse, cancelConsignmentSaleInHouse, localConsignmentActor } = await import('../../src/core/consignment/consignment-reversal-house.ts');
  const ret = await primary(() => imHaus(() => returnConsignmentAfterSaleInHouse(w.k2, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' } as never, 'branch-main')));
  reload();
  ok(ret.ok && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.k2]) === 'returned' && abgleich4(w.db).length === 0,
    `§14 Post-Sale Return einer Zeile nach der Korrektur geht wie bisher (${ret.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
  const lockRet = await korrPrimary(w, inv, { items: (ist) => ist.map((i) => (i.consignmentId === w.k2 ? { ...i, salePrice: 900 } : i)) });
  ok(!lockRet.ok && /CONSIGNMENT_LINE_LOCKED|EDIT_/.test(lockRet.code), `§14 eine zurückgegebene Kommission bleibt auf der Rechnung, wie sie ist (${lockRet.code})`);
  const weg = await korrPrimary(w, inv, { items: (ist) => ist.filter((i) => i.consignmentId !== w.k2) });
  ok(!weg.ok && /CONSIGNMENT_LINE_LOCKED/.test(weg.code), `§14 …und wird nicht über die Korrektur entfernt (die Rückgabe ist ein eigener Vorgang) (${weg.code})`);
  // Cancel Sale nach einer Korrektur (eigene Welt: nach einer Rückgabe aus einem gemeinsamen Einkauf sperrt Cancel Sale
  // schon heute — bestehendes Verhalten, nicht P4).
  const g2 = await gemischt();
  const r2 = await korrPrimary(g2.w, g2.inv, { items: (ist) => ist.filter((i) => i.consignmentId !== g2.w.k3).map((i) => (i.consignmentId === g2.w.k1 ? { ...i, salePrice: 1000 } : i)) });
  setTestDatabase(g2.w.db as never); reload();
  const cs = await primary(() => imHaus(() => cancelConsignmentSaleInHouse(g2.w.k1, localConsignmentActor(), 'branch-main')));
  reload();
  ok(r2.ok && cs.ok && s(g2.w.db, 'SELECT status FROM invoices WHERE id = ?', [g2.inv]) === 'CANCELLED' && abgleich4(g2.w.db).length === 0
    && s(g2.w.db, 'SELECT status FROM consignments WHERE id = ?', [g2.w.k3]) === 'active',
    `§14 Cancel Sale danach: die ganze Rechnung storniert, Abgleich ok (${cs.code || 'ok'} ${abgleich4(w.db).join('; ')})`);
}
{
  // Eine reine Record-Sale-Rechnung: Steuerartwechsel über den gewöhnlichen Weg wie bisher.
  const w = await welt();
  setTestDatabase(w.db as never); reload();
  const rs = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [{ consignmentId: w.k1, salePrice: 1200, acknowledgeShortfall: false, taxScheme: 'MARGIN', consignorTaxScheme: 'ZERO' }], buyerId: 'cust-2', specialMark: false }));
  reload();
  const inv = String((rs.value as { invoiceId?: string }).invoiceId ?? '');
  const l = w.db.exec('SELECT id, product_id, lot_id, quantity, unit_price, purchase_price_snapshot, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ?', [inv])[0].values[0];
  const r = await primary(() => editInvoiceOnPrimary(inv, { lines: [{ lineId: String(l[0]), productId: String(l[1]), lotId: String(l[2]), quantity: 1, unitPrice: 1200,
    purchasePrice: Number(l[5]), taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1200 }], reason: 'Export' }, invRev(w.db, inv)));
  reload();
  ok(rs.ok && r.ok && s(w.db, 'SELECT tax_scheme FROM invoice_lines WHERE invoice_id = ?', [inv]) === 'ZERO' && abgleich4(w.db).length === 0,
    `§14 reine Record-Sale-Rechnung: Steuerart Margin → Zero über den gewöhnlichen Weg wie bisher (${r.code || 'ok'})`);
}
// Quelltext: die Maske ändert eine Rechnung mit Kommissionszeilen über die Korrekturfolge (Primary + PC2).
{
  const maske = src('src/pages/invoices/InvoiceCreate.tsx') + src('src/components/invoices/ConsignmentInvoiceLines.tsx');
  ok(/correctMixedInvoiceOnPrimary/.test(maske) && /mixedCorrectionBody/.test(maske) && maske.split('confirmCustomerChange ? { confirmCustomerChange: true }').length === 3,
    '§14 Maske: Korrektur am Primary über correctMixedInvoiceOnPrimary, PC2 über invoices.update mit consignment; die Bestätigung eines Kundenwechsels reist an beiden Anschlüssen');
}

// ══ Ergebnis ══
console.log(fails.length ? `\nFAIL — P4 mixed invoice correction: ${PASS} passed, ${fails.length} failed` : `\nPASS — P4 mixed invoice correction: ${PASS} passed, 0 failed`);
if (fails.length) process.exit(1);

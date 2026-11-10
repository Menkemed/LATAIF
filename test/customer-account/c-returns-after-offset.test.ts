// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — Rückgaben, Gutschriften, Erstattungen und Storno NACH einer Verrechnung (Store Credit / We Borrowed).
// Je Fall: Geldfluss (Hauptbuch Kasse/Bank/Benefit/Karte), Darlehen, Store Credit, Forderung, Rechnungsstatus, Hauptbuch +
// Abstimmungen (je Konto, je Kunde), Receivables, Kundenkonto — und die WIRTSCHAFTLICHE BILANZ des Kunden:
//   Bilanz = Geld von LATAIF − Geld an LATAIF + Δ offenes Darlehen + Δ freies Guthaben − Δ offene Forderung
//   Erwartet: −(Wert der behaltenen Ware). Mehr = doppelte Begünstigung, weniger = verlorene Rückzahlung.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/c-settle-balance.test.ts.
// Run: node test/customer-account/c-returns-after-offset.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
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
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'],
  ['lataif_sync_token', 'test-token'],
]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

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
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useDebtStore, loadDebtPaymentsFor } = await import('../../src/stores/debtStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const recv = await import('../../src/core/finance/receivables.ts');
const payS = await import('../../src/stores/payablesStore.ts');
const banking = await import('../../src/stores/bankingStore.ts');
const analytics = await import('../../src/core/reports/analytics-snapshot.ts');
const recon = await import('../../src/core/reports/reconciliation-snapshot.ts');
const backfill = await import('../../src/core/ledger/backfill.ts');
await import('../../src/core/bridge/party-commands.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const ca = await import('../../src/core/parties/customer-account.ts');
const money = await import('../../src/core/finance/money-house.ts');
const po = await import('../../src/core/offsets/party-offsets.ts');
const lc = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const fc = await import('../../src/core/bridge/financial-commands.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-10-20T10:00:00.000Z';
const F = (x: number): number => Math.round(x * 1000);
const eq = (a: number, b: number): boolean => F(a) === F(b);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useDebtStore.getState().loadDebts();
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of realMigrations()) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  const kunde = (id: string, fn: string, ln: string): void => {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,?,'BH','en',0,'[]','collector','active',?,?)`, [id, fn, ln, NOW, NOW]);
  };
  kunde('cust-1', 'Ahmed', 'Karimi');
  kunde('cust-2', 'Other', 'Client');
  for (let i = 1; i <= 8; i++) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'Pre-Owned','[]',0,'BHD',1300,'in_stock','ZERO',0,'[]','{}','OWN',?,?)`,
    ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

const DB = freshDb();
const CTX = { branchId: 'branch-main' };
const HCTX = { branchId: 'branch-main', userId: 'user-test' };
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
const zeilen = (sql: string, p: unknown[] = []): string => S(DB.exec(sql, p)[0]?.values ?? []);
const bal = (account: string): number => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = ?`, [account]);
/** Kasse, Bank, Benefit, Karte — was eine Verrechnung NIE bewegen darf. */
const geld = (): string => S(['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING'].map((a) => F(bal(a))));
const ledgerBalanced = (): boolean => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries`) === 0
  || Math.abs(n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries`)) < 0.0005;
/** Alles, was eine abgelehnte Verrechnung NICHT ändern darf. */
const stand = (): string => S([
  zeilen('SELECT id, status, paid_amount, invoice_number, revision FROM invoices ORDER BY id'),
  zeilen('SELECT id, amount, method FROM payments ORDER BY id'),
  zeilen('SELECT id, status, revision FROM debts ORDER BY id'),
  zeilen('SELECT id, amount, source FROM debt_payments ORDER BY id'),
  zeilen('SELECT id, status FROM party_offsets ORDER BY id'),
  n(DB, 'SELECT COUNT(*) FROM ledger_entries'),
]);
const sale = (pid: string, price: number, date: string, customerId = 'cust-1'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, [{ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'B1-TEST', date).id);
  reload();
  return id;
};
const loan = (dir: 'we_borrow' | 'we_lend', amount: number, customerId: string, createdAt: string): string => {
  const r = imHaus(() => money.createDebtInHouse({ direction: dir, customerId, amount, source: 'cash' } as never, HCTX));
  DB.run('UPDATE debts SET created_at = ? WHERE id = ?', [createdAt, r.debt.id]);
  reload();
  return r.debt.id;
};
const inv = (id: string) => DB.exec('SELECT status, paid_amount, invoice_number, special_mark, revision FROM invoices WHERE id = ?', [id])[0].values[0];
const debtState = (id: string): { status: string; open: number; revision: number } => {
  const r = DB.exec('SELECT status, amount, revision FROM debts WHERE id = ?', [id])[0].values[0];
  const paid = n(DB, 'SELECT COALESCE(SUM(amount),0) FROM debt_payments WHERE debt_id = ?', [id]);
  return { status: String(r[0]), open: (F(Number(r[1])) - F(paid)) / 1000, revision: Number(r[2]) };
};
const invRev = (id: string): number => n(DB, 'SELECT revision FROM invoices WHERE id = ?', [id]);
/** Abstand Hauptbuch − Bestand je Konto (Testdaten ohne Buchung erzeugen einen festen Abstand; er darf sich nie ändern). */
const gap = (account: string): number => {
  const row = recon.reconciliationSnapshotFor(CTX as never).rows.find((x) => x.account === account);
  return row ? (F(Number(row.ledger)) - F(Number(row.domain))) / 1000 : NaN;
};
const create = (input: Record<string, unknown>) => imHaus(() => po.createDebtOffsetInHouse(input as never, HCTX));

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000b1`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = () => ({
  db: DB as never,
  begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {}, now: () => NOW,
});
type Outcome = { kind: string; code?: string; replayed?: boolean; value?: Record<string, unknown> };
async function fern(p: () => Promise<unknown>): Promise<Outcome & { thrown?: string }> {
  try { return await p() as Outcome; } catch (e) { return { kind: 'thrown', thrown: String((e as { code?: string }).code ?? (e as Error).message), code: String((e as { code?: string }).code ?? '') }; }
}
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();


const st = await import('../../src/core/offsets/party-settlement.ts');
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const pcmd = await import('../../src/core/bridge/party-commands.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { returnLineAmounts } = await import('../../src/core/returns/return-lines.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');

// ── Welt ────────────────────────────────────────────────────────────────────────────────────────────────────────
for (let i = 3; i <= 14; i++) {
  DB.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES (?, ?, 'Kunde', ?, 'BH', 'en', 0, '[]', 'collector', 'active', ?, ?)`, ['cust-' + i, i === 14 ? 'branch-other' : 'branch-main', String(i), NOW, NOW]);
}
for (let i = 9; i <= 60; i++) {
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?, 'branch-main', 'cat-w', 'Rolex', ?, ?, 1, 'Pre-Owned', '[]', 0, 'BHD', 1300, 'in_stock', 'ZERO', 0, '[]', '{}', 'OWN', ?, ?)`,
  ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, NOW, NOW]);
}
reload();
let pk = 9;
const neuerArtikel = (): string => 'pk' + (pk++);
const verkauf = (cid: string, price: number, date = '2026-10-20'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(cid, [{ productId: neuerArtikel(), quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'C-SETTLE', date).id);
  reload();
  return id;
};
/** Store-Guthaben über den vorhandenen Weg: Überzahlung einer kleinen Rechnung (Soll Kasse / Haben AR + CUSTOMER_CREDIT). */
const guthaben = (cid: string, betrag: number, date = '2026-10-18'): string => {
  const id = verkauf(cid, 10, date);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 10 + betrag, 'cash', 'overpay', undefined, undefined, undefined, undefined,
    { receivedAt: `${date}T09:00:00.000Z` } as never));
  reload();
  return s(DB, "SELECT id FROM customer_credits WHERE customer_id = ? AND source_type = 'overpayment' ORDER BY created_at DESC, rowid DESC LIMIT 1", [cid]);
};
const lese = (cid: string) => sr.settleBalanceFor(CTX, cid);
const snap = () => recon.reconciliationSnapshotFor(CTX as never);
/** Abstand Hauptbuch − Bestand je Konto (Fils) und je Kunde (AR). */
const abstaende = (cid: string): string => {
  const sn = snap();
  const k = sn.counterparty?.arByCustomer.rows.find((x) => x.id === cid);
  return S([...sn.rows.map((r) => `${r.account}:${F(Number(r.ledger)) - F(Number(r.domain))}`), `ARkunde:${k ? k.diffFils : 0}`]);
};
const geldKonten = (): string => S(['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING'].map((a) => F(bal(a))));
const TABELLEN = ['invoices', 'payments', 'customer_credits', 'credit_applications', 'debts', 'debt_payments', 'party_offsets', 'ledger_entries', 'audit_log', 'expenses'];
const abdruck = (): string => S(TABELLEN.map((t) => { try { return DB.exec(`SELECT * FROM ${t} ORDER BY rowid`)[0]?.values ?? []; } catch { return 'n/a'; } }));
const konto = (cid: string) => ca.customerAccountFor(CTX, cid);
const status = (id: string): string => String(inv(id)[0]);
const nummer = (id: string): string => String(inv(id)[2]);
const offen = (id: string): number => recv.receivablesBreakdown('branch-main').find((r) => r.sourceId === id)?.open ?? 0;
const kontoOffen = (cid: string, key: string): number => konto(cid).docs.find((d) => d.key === key)?.open ?? 0;
const settle = (req: Record<string, unknown>) => st.settleBalanceOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
const undo = (req: Record<string, unknown>) => st.reverseSettlementOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
/** Ein vollständiger Auftrag aus der Auskunft: alle angebotenen Posten angehakt, Summe und Stand wie gezeigt. */
const alles = (cid: string, extra: Record<string, unknown> = {}) => {
  const r = lese(cid);
  const sel = { invoiceIds: r.invoices.map((i) => i.id), sourceIds: r.sources.map((x) => x.id) };
  const pairs = sr.planSettlement(r.invoices, r.sources, sel);
  return { customerId: cid, ...sel, expectedStamp: r.stamp, expectedTotal: pairs.reduce((a, p) => a + p.amountF, 0) / 1000, ...extra };
};

const { cancelReturnInHouse } = await import('../../src/core/returns/return-cancel-house.ts');

// ── Werkzeuge der Rückgabe-Prüfung ───────────────────────────────────────────────────────────────────────────────
const fc2 = await import('../../src/core/bridge/financial-commands.ts');
const ccDb = (id: string) => DB.exec('SELECT amount, used_amount, status FROM customer_credits WHERE id = ?', [id])[0]?.values?.[0] ?? [];
const frei = (cid: string): number => n(DB, "SELECT COALESCE(SUM(amount - used_amount), 0) FROM customer_credits WHERE customer_id = ? AND status = 'OPEN'", [cid]);
const darlehenOffen = (cid: string): number => n(DB,
  `SELECT COALESCE(SUM(d.amount - COALESCE((SELECT SUM(amount) FROM debt_payments p WHERE p.debt_id = d.id), 0)), 0) FROM debts d
    WHERE d.customer_id = ? AND d.direction IN ('we_borrow','MONEY_RECEIVED') AND UPPER(d.status) != 'CANCELLED'`, [cid]);
/** Offene Forderung des Kunden laut Hauptbuch (AR mit Gegenpartei Kunde). */
const arHB = (cid: string): number => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [cid]);
/** Geld des Kunden laut Hauptbuch: was über Kasse/Bank/Benefit/Karte mit ihm floss (+ = an LATAIF). */
const geldVomKunden = (cid: string): number => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account IN ('CASH','BANK','BENEFIT','CARD_CLEARING') AND counterparty_id = ?`, [cid]);
interface Lage { geld: number; darlehen: number; guthaben: number; forderung: number }
const lage = (cid: string): Lage => ({ geld: geldVomKunden(cid), darlehen: darlehenOffen(cid), guthaben: frei(cid), forderung: arHB(cid) });
/** Wirtschaftliche Bilanz des Kunden zwischen zwei Lagen (siehe Kopf). */
const bilanz = (a: Lage, b: Lage): number => Math.round((-(b.geld - a.geld) + (b.darlehen - a.darlehen) + (b.guthaben - a.guthaben) - (b.forderung - a.forderung)) * 1000) / 1000;
/** Rechnung mit mehreren Zeilen (Preise), ZERO-VAT. */
const rechnung = (cid: string, preise: number[], date = '2026-10-20'): { id: string; zeilen: string[] } => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(cid, preise.map((price) => ({ productId: neuerArtikel(), quantity: 1, unitPrice: price,
    purchasePrice: 0, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price })) as never, 'C-RET', date).id);
  reload();
  return { id, zeilen: (DB.exec('SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id])[0]?.values ?? []).map((r) => String(r[0])) };
};
const bar = (id: string, betrag: number) => { imHaus(() => useInvoiceStore.getState().recordPayment(id, betrag, 'cash')); reload(); };
/** Rückgabe der Zeilen, freigegeben und erstattet (Weg wie die Maske „Refund now"); liefert die Rückgabe. */
const zurueck = (id: string, lineIds: string[], refundMethod = 'cash'): string => {
  const rid = imHaus(() => {
    const sx = useSalesReturnStore.getState();
    sx.loadReturns();
    const lines = lineIds.map((lid) => {
      const l = DB.exec('SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ?', [lid])[0].values[0];
      const a = returnLineAmounts({ quantity: Number(l[2]), lineTotal: Number(l[3]), vatAmount: Number(l[4]) }, Number(l[2]));
      return { invoiceLineId: String(l[0]), productId: String(l[1]), quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount };
    });
    const r = sx.createReturn({ invoiceId: id, refundMethod, productDisposition: 'IN_STOCK', notes: 'c-ret', lines } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().refundReturn(r);
    return r;
  });
  reload();
  return rid;
};
const erstattet = (rid: string): number => n(DB, 'SELECT COALESCE(refund_paid_amount, 0) FROM sales_returns WHERE id = ?', [rid]);
const offenRecv = (id: string): number => recv.receivablesBreakdown('branch-main').find((r) => r.sourceId === id)?.open ?? 0;
/** Die Sichten einer Rechnung einig: Hauptbuch-AR der Rechnung = Receivables = Kundenkonto. */
const arRechnung = (id: string): number => {
  const quellen = [id,
    ...(DB.exec('SELECT id FROM payments WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT receivable_payment_id FROM party_offsets WHERE receivable_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT id FROM sales_returns WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT id FROM credit_notes WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
  ];
  return n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
    WHERE source_id IN (${quellen.map(() => '?').join(',')}) AND account = 'ACCOUNTS_RECEIVABLE'`, quellen);
};
function einig(tag: string, id: string, cid: string, basis: string): void {
  const ar = arRechnung(id), rv = offenRecv(id), ko = kontoOffen(cid, `invoice:${id}`);
  ok(eq(ar, rv) && eq(ar, ko) && abstaende(cid) === basis && ledgerBalanced(),
    `${tag} Sichten einig: Hauptbuch-AR ${ar.toFixed(3)} = Receivables ${Number(rv).toFixed(3)} = Kundenkonto ${Number(ko).toFixed(3)}; Abstimmungen unverändert`);
}
const fall = (cid: string) => ({ start: lage(cid), basis: abstaende(cid) });

// ══ F1 — voll mit We Borrowed verrechnet, dann volle Rückgabe ═══════════════════════════════════════════════════
{
  const cid = 'cust-3';
  const L = loan('we_borrow', 1000, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  create({ invoiceId: r.id, debtId: L, amount: 1000 });
  reload();
  ok(status(r.id) === 'FINAL' && eq(darlehenOffen(cid), 0), 'F1a Rechnung durch Darlehen voll bezahlt (FINAL), Darlehen getilgt');
  const rid = zurueck(r.id, r.zeilen, 'cash');
  const b = lage(cid);
  ok(status(r.id) === 'FINAL' && eq(erstattet(rid), 1000) && eq(b.darlehen, 0) && eq(offenRecv(r.id), 0),
    `F1b volle Rückgabe: 1.000 BAR erstattet, das Darlehen bleibt durch die Verrechnung getilgt (Rechnung bleibt FINAL, offen 0) (${erstattet(rid)})`);
  ok(bilanz(f.start, b) === 0, `F1c Bilanz des Kunden 0 — Darlehen 1.000 ↦ 1.000 bar, nicht doppelt (${bilanz(f.start, b)})`);
  einig('F1d', r.id, cid, f.basis);
}
{
  // F1 mit Erstattung als Store Credit: dieselbe Bilanz, kein Geld.
  const cid = 'cust-4';
  const L = loan('we_borrow', 1000, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  create({ invoiceId: r.id, debtId: L, amount: 1000 });
  reload();
  zurueck(r.id, r.zeilen, 'credit');
  const b = lage(cid);
  ok(eq(b.guthaben, 1000) && eq(b.geld, f.start.geld) && bilanz(f.start, b) === 0, `F1e Erstattung als Store Credit 1.000, kein Geld, Bilanz 0 (${S(b)})`);
  einig('F1f', r.id, cid, f.basis);
}

// ══ F2 — voll mit Store Credit (Settle Balance), dann volle Rückgabe ═══════════════════════════════════════════
{
  const cid = 'cust-5';
  guthaben(cid, 1000, '2026-10-01');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  const s = await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  ok(s.ok && status(r.id) === 'FINAL', 'F2a Rechnung durch Store Credit voll bezahlt (STL)');
  const rid = zurueck(r.id, r.zeilen, 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 1000) && eq(b.guthaben, 0) && bilanz(f.start, b) === 0,
    `F2b volle Rückgabe: 1.000 bar erstattet, das Guthaben bleibt verbraucht — Bilanz 0 (Guthaben in Geld gewandelt) (${S(b)})`);
  einig('F2c', r.id, cid, f.basis);
}

// ══ F3 — teils bar, teils Darlehen, dann volle Rückgabe ════════════════════════════════════════════════════════
{
  const cid = 'cust-6';
  const L = loan('we_borrow', 700, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  bar(r.id, 300);
  create({ invoiceId: r.id, debtId: L, amount: 700 });
  reload();
  const rid = zurueck(r.id, r.zeilen, 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 1000) && eq(b.darlehen, 0) && bilanz(f.start, b) === 0,
    `F3 300 bar + 700 Darlehen, volle Rückgabe: 1.000 bar zurück, Darlehen bleibt getilgt — Bilanz 0 (${S(b)})`);
  einig('F3b', r.id, cid, f.basis);
}

// ══ F4 — bar + Store Credit + We Borrowed, dann Teilrückgabe ══════════════════════════════════════════════════
{
  const cid = 'cust-7';
  guthaben(cid, 300, '2026-10-01');
  loan('we_borrow', 500, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [400, 600]);
  bar(r.id, 200);
  const s = await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  ok(s.ok && status(r.id) === 'FINAL', 'F4a 200 bar + 300 Guthaben + 500 Darlehen (STL) = voll bezahlt');
  const rid = zurueck(r.id, [r.zeilen[0]], 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 400) && bilanz(f.start, b) === -600,
    `F4b Teilrückgabe 400: 400 bar zurück; behalten 600 — Bilanz −600 (${bilanz(f.start, b)}; ${S(b)})`);
  einig('F4c', r.id, cid, f.basis);
  const u = await undo({ settlementNumber: s.ok ? s.v.settlementNumber : '' });
  ok(!u.ok && u.code === 'OFFSET_HAS_LATER_RETURN', `F4d die STL ist nach der Rückgabe nicht mehr aufhebbar (keine doppelte Erstattung) (${u.ok ? 'DURCH' : u.code})`);
}

// ══ F5 — eine STL über zwei Rechnungen, Rückgabe EINER Rechnung ═══════════════════════════════════════════════
{
  const cid = 'cust-8';
  loan('we_borrow', 800, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const A = rechnung(cid, [500], '2026-10-05');
  const Bx = rechnung(cid, [300], '2026-10-06');
  const s = await settle(alles(cid, { finalNumbers: { [A.id]: 'normal', [Bx.id]: 'normal' } }));
  ok(s.ok, 'F5a STL über A 500 und B 300 mit einem Darlehen 800');
  const rid = zurueck(Bx.id, Bx.zeilen, 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 300) && status(A.id) === 'FINAL' && bilanz(f.start, b) === -500,
    `F5b Rückgabe B: 300 bar; A unberührt; behalten 500 — Bilanz −500 (${bilanz(f.start, b)})`);
  einig('F5c A', A.id, cid, f.basis);
  einig('F5c B', Bx.id, cid, f.basis);
  const ganz = await undo({ settlementNumber: s.ok ? s.v.settlementNumber : '' });
  ok(!ganz.ok && ganz.code === 'OFFSET_HAS_LATER_RETURN', `F5d ganze STL gesperrt (B hat eine spätere Rückgabe) (${ganz.ok ? '' : ganz.code})`);
  const zeileA = (await import('../../src/core/offsets/party-offset-reads.ts')).offsetsOfInvoice(A.id, 'branch-main')[0];
  const ea = await (await import('../../src/core/offsets/party-offsets.ts')).reverseDebtOffsetOnPrimary(zeileA.offsetId, 'test').then(() => '', (e: { code?: string }) => String(e.code ?? e));
  reload();
  const c = lage(cid);
  ok(ea === '' && status(A.id) === 'PARTIAL' && bilanz(f.start, c) === -500 && eq(c.forderung - b.forderung, 500),
    `F5e einzelne Zuordnung auf A aufhebbar: A wieder offen 500, Darlehen +500 — Bilanz weiter −500 (${ea || 'ok'}, ${bilanz(f.start, c)})`);
  einig('F5f A', A.id, cid, f.basis);
}

// ══ F6 — Rückgabe nach teilweise aufgehobener STL ════════════════════════════════════════════════════════════
{
  const cid = 'cust-9';
  loan('we_borrow', 800, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const A = rechnung(cid, [500], '2026-10-05');
  const Bx = rechnung(cid, [300], '2026-10-06');
  await settle(alles(cid, { finalNumbers: { [A.id]: 'normal', [Bx.id]: 'normal' } }));
  const zeileA = (await import('../../src/core/offsets/party-offset-reads.ts')).offsetsOfInvoice(A.id, 'branch-main')[0];
  await (await import('../../src/core/offsets/party-offsets.ts')).reverseDebtOffsetOnPrimary(zeileA.offsetId, 'test');
  reload();
  const rid = zurueck(A.id, A.zeilen, 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 0) && status(A.id) === 'RETURNED' && bilanz(f.start, b) === -300,
    `F6 A (Zuordnung aufgehoben, unbezahlt) zurück: KEIN Geld; behalten B 300 — Bilanz −300 (${bilanz(f.start, b)})`);
  einig('F6b', A.id, cid, f.basis);
}

// ══ F7 — Storno nach Verrechnung ═════════════════════════════════════════════════════════════════════════════
{
  // a) ohne Rückgabe: Darlehen wieder ganz offen, kein Geld.
  const cid = 'cust-10';
  const L = loan('we_borrow', 600, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  create({ invoiceId: r.id, debtId: L, amount: 600 });
  reload();
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: r.id, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  const b = lage(cid);
  ok(status(r.id) === 'CANCELLED' && eq(b.darlehen, 600) && eq(b.geld, f.start.geld) && bilanz(f.start, b) === 0,
    `F7a Storno: Verrechnung zurück ans Darlehen (600 offen), kein Bargeld — Bilanz 0 (${S(b)})`);
  einig('F7a', r.id, cid, f.basis);
}
for (const [tag, cid, barBetrag, verrechnet, erste] of [['F7b', 'cust-11', 300, 600, 300], ['F7c', 'cust-12', 100, 800, 300]] as Array<[string, string, number, number, number]>) {
  // Teilrückgabe 400 bei Bargeld + Darlehen (900 von 1.000); F7c: die Erstattung ist größer als das Bargeld.
  const L = loan('we_borrow', verrechnet, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [400, 600]);
  bar(r.id, barBetrag);
  create({ invoiceId: r.id, debtId: L, amount: verrechnet });
  reload();
  const rid = zurueck(r.id, [r.zeilen[0]], 'cash');
  ok(eq(erstattet(rid), erste) && status(r.id) === 'RETURNED',
    `${tag} Teilrückgabe 400 bei ${barBetrag} bar + ${verrechnet} Darlehen: ${erste} bar erstattet, Rechnung RETURNED (${erstattet(rid)}, ${status(r.id)})`);
  const vor = lage(cid);
  const e = wirft(() => imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: r.id, refundMethod: 'cash' } as never, 'branch-main')));
  reload();
  ok(e === 'INVOICE_NOT_CANCELLABLE' && S(lage(cid)) === S(vor) && status(r.id) === 'RETURNED',
    `${tag} Storno nach erstatteter Rückgabe gesperrt — die Verrechnung kann nicht zusätzlich ans Darlehen zurück (${e})`);
  const rid2 = zurueck(r.id, [r.zeilen[1]], 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid) + erstattet(rid2), barBetrag + verrechnet) && eq(b.darlehen, 0) && bilanz(f.start, b) === 0,
    `${tag} der Rest als Rückgabe: zusammen ${barBetrag + verrechnet} bar zurück (= Bargeld + Verrechnung), Darlehen bleibt getilgt — Bilanz 0 (${bilanz(f.start, b)})`);
  einig(`${tag}`, r.id, cid, f.basis);
}

// ══ F8 — Rückgabe / Gutschrift rückgängig machen ═══════════════════════════════════════════════════════════════
{
  const cid = 'cust-13';
  const L = loan('we_borrow', 1000, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [400, 600]);
  create({ invoiceId: r.id, debtId: L, amount: 1000 });
  reload();
  const rid = zurueck(r.id, [r.zeilen[0]], 'cash');
  ok(eq(erstattet(rid), 400), 'F8a Teilrückgabe nach voller Verrechnung: 400 bar erstattet');
  const cr = wirft(() => imHaus(() => (cancelReturnInHouse as (...a: unknown[]) => unknown)(rid, 'Prüfung', { userId: 'user-test', role: 'ADMIN' }, 'branch-main')));
  ok(cr === 'RETURN_REFUND_PAID_OUT', `F8b Rückgabe mit ausgezahlter Erstattung: Cancel Return gesperrt (${cr})`);
  const cn = s(DB, 'SELECT id FROM credit_notes WHERE sales_return_id = ?', [rid]);
  const dl = wirft(() => imHaus(() => { useCreditNoteStore.getState().loadCreditNotes(); useCreditNoteStore.getState().deleteCreditNote(cn); }));
  ok(dl === 'CREDIT_NOTE_VIA_RETURN', `F8c ihre Gutschrift: direktes Löschen gesperrt (${dl})`);
  // Ohne „Refund now" bleibt eine Rückgabe angelegt (REQUESTED, keine Gutschrift, keine Buchung); ihr Storno ändert nichts.
  const rid2 = imHaus(() => {
    const sx = useSalesReturnStore.getState(); sx.loadReturns();
    const l = DB.exec('SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ?', [r.zeilen[1]])[0].values[0];
    const a = returnLineAmounts({ quantity: Number(l[2]), lineTotal: Number(l[3]), vatAmount: Number(l[4]) }, Number(l[2]));
    return sx.createReturn({ invoiceId: r.id, refundMethod: 'cash', productDisposition: 'IN_STOCK', lines: [{ invoiceLineId: String(l[0]), productId: String(l[1]), quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount }] } as never).id;
  });
  reload();
  const vor = lage(cid);
  const cr2 = wirft(() => imHaus(() => (cancelReturnInHouse as (...a: unknown[]) => unknown)(rid2, 'Prüfung', { userId: 'user-test', role: 'ADMIN' }, 'branch-main')));
  reload();
  const b = lage(cid);
  ok(cr2 === '' && S(b) === S(vor) && bilanz(f.start, b) === -600,
    `F8d angelegte Rückgabe (ohne Auszahlung) storniert: kein Geld, Darlehen unberührt; behalten 600 — Bilanz −600 (${cr2 || 'ok'}, ${bilanz(f.start, b)})`);
  einig('F8e', r.id, cid, f.basis);
  // PC2: „Remove offset" über invoices.delete_payment nach der Rückgabe — dieselbe Sperre wie am Primary.
  const pay = s(DB, "SELECT id FROM payments WHERE invoice_id = ? AND method = 'debt_offset'", [r.id]);
  const fern2 = await fern(() => fc2.runDeletePayment(deps() as never, identity('801', 'invoices.delete_payment'), { invoiceId: r.id, paymentId: pay, expectedRevision: invRev(r.id) }));
  ok(fern2.code === 'OFFSET_HAS_LATER_RETURN', `F8f PC2 „Remove offset" nach Rückgabe gesperrt wie am Primary (${S({ kind: fern2.kind, code: fern2.code })})`);
}

// ══ F9 — PC2: Rückgabe nach Verrechnung über returns.create (Refund now) — dieselbe Hausfolge, derselbe Betrag ══════
{
  const rc = await import('../../src/core/bridge/return-commands.ts');
  const cid = 'cust-14b';
  DB.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES (?, 'branch-main', 'Kunde', 'PC2', 'BH', 'en', 0, '[]', 'collector', 'active', ?, ?)`, [cid, NOW, NOW]);
  reload();
  const L = loan('we_borrow', 800, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [1000]);
  bar(r.id, 200);
  create({ invoiceId: r.id, debtId: L, amount: 800 });
  reload();
  const o = await fern(() => rc.runCreateReturn(deps() as never, identity('901', 'returns.create'),
    { invoiceId: r.id, expectedRevision: invRev(r.id), lines: [{ invoiceLineId: r.zeilen[0], quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: true }));
  reload();
  const rid = s(DB, 'SELECT id FROM sales_returns WHERE invoice_id = ?', [r.id]);
  const b = lage(cid);
  ok(o.kind === 'ok' && eq(erstattet(rid), 1000) && eq(b.darlehen, 0) && bilanz(f.start, b) === 0,
    `F9 PC2: 200 bar + 800 Darlehen, volle Rückgabe → 1.000 bar, Darlehen bleibt getilgt, Bilanz 0 — wie am Primary (${S({ kind: o.kind, code: o.code })})`);
  einig('F9b', r.id, cid, f.basis);
}

void [geldKonten, abdruck, nummer, offen, ccDb, loadDebtPaymentsFor, payS, banking, analytics, backfill, executeCommand, lc, fc, money, po, geld, stand, sale, gap, TODAY, HCTX, readFileSync, existsSync, zeilen, src, insert, debtState, pcmd, perms, sr, st, useSupplierStore, usePurchaseStore];
console.log(`\nC returns after offset: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

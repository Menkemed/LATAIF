// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — Variante C (Owner 10.11.2026) und die Diagnose `returns.approve`.
//   V: Rückgabe einer Rechnung, die ganz mit Store-Guthaben bezahlt ist → „Store Credit" vorgeschlagen (nur Vorbelegung);
//      Geld weiter wählbar; gemischt → keine Vorbelegung, Hinweis; keine doppelte Erstattung/Guthaben; Primary = PC2.
//   D: Wann bucht eine Erstattung Geld? „Refund now", „Refund later" + spätere Auszahlung, PC2 `returns.approve` ohne
//      Auszahlung (Diagnose), Teilauszahlung, Storno vor der Auszahlung — Hauptbuch, Erstattungsstatus, Banking, Abstimmung.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/c-returns-after-offset.test.ts.
// Run: node test/customer-account/c-refund-suggestion.test.ts
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


const rcmd = await import('../../src/core/bridge/return-commands.ts');
const rcre = await import('../../src/core/returns/return-create.ts');
const rhouse = await import('../../src/core/returns/return-house.ts');
const { invoicePrintFor } = await import('../../src/core/data/page-reads.ts');
/** Die Zahlungen, wie die Rechnungsseite sie bekommt (`page.invoice_print.get` — Primary lokal, PC2 vom Primary). */
const seitenZahlungen = (id: string) => invoicePrintFor(CTX as never, id).payments;
const vorschlag = (id: string) => rcre.suggestReturnRefund(seitenZahlungen(id));
/** Rückgabe über den Weg der Maske (createReturnOnPrimary-Hausfolge), Weg und „Refund now" wie gewählt. */
const maske = (id: string, lineIds: string[], refundMethod: string, refundNow = true): string => {
  const r = imHaus(() => rhouse.createReturnInHouse({ invoiceId: id, lines: lineIds.map((l) => ({ invoiceLineId: l, quantity: 1 })), refundMethod,
    productDisposition: 'IN_STOCK', refundNow } as never, 'branch-main'));
  reload();
  return (r as { returnId: string }).returnId;
};
const rueck = (rid: string) => DB.exec('SELECT status, refund_status, refund_paid_amount, refund_method FROM sales_returns WHERE id = ?', [rid])[0]?.values?.[0] ?? [];
const cnVon = (rid: string) => DB.exec('SELECT cash_refund_amount, receivable_cancel_amount, refund_method FROM credit_notes WHERE sales_return_id = ?', [rid])[0]?.values?.[0] ?? [];
const kasse = (): number => bal('CASH') + bal('BANK');
/** Geld- und Forderungsbewegung einer Rückgabe im Hauptbuch (Quelle: ihre Gutschrift). */
const cnBuchung = (rid: string, konten: string[]): number => {
  const cn = s(DB, 'SELECT id FROM credit_notes WHERE sales_return_id = ?', [rid]);
  return n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
    WHERE source_module = 'CREDIT_NOTE' AND source_id = ? AND account IN (${konten.map(() => '?').join(',')})`, [cn, ...konten]);
};
const abstandKonto = (konto: string): number => {
  const row = snap().rows.find((x) => x.account === konto);
  return row ? F(Number(row.ledger)) - F(Number(row.domain)) : 0;
};
const quelle = src('src/pages/invoices/InvoiceDetail.tsx');
const { loadBankingFor } = await import('../../src/stores/bankingStore.ts');
/** Was die Seite Banking für diese Rückgabe als Abfluss zeigt (0 = keine Zeile). */
const bankingAbfluss = (rid: string): number => Number(loadBankingFor(CTX as never).transactions.find((t) => t.id === `sret-${rid}`)?.amount ?? 0);

// ══ V — Variante C: Vorschlag der Erstattungsart ═══════════════════════════════════════════════════════════════
{
  // Reine Regel.
  const v1 = rcre.suggestReturnRefund([{ method: 'credit', amount: 500 }]);
  const v2 = rcre.suggestReturnRefund([{ method: 'credit', amount: 200 }, { method: 'cash', amount: 300 }]);
  const v3 = rcre.suggestReturnRefund([{ method: 'credit', amount: 200 }, { method: 'debt_offset', amount: 300 }]);
  const v4 = rcre.suggestReturnRefund([{ method: 'cash', amount: 500 }]);
  const v5 = rcre.suggestReturnRefund([]);
  ok(v1.method === 'credit' && v1.basis === 'all_store_credit' && v2.method === 'bank' && v2.basis === 'mixed_store_credit'
    && v3.basis === 'mixed_store_credit' && v3.method === 'bank' && v4.basis === 'none' && v4.method === 'bank' && v5.method === 'bank',
  'V-1 Regel: nur Store Credit → „Store Credit"; gemischt (auch mit Darlehen) → keine Vorbelegung; sonst wie bisher „Bank"');
  ok(S(rcre.RETURN_REFUND_METHODS) === S(['cash', 'bank', 'card', 'benefit', 'credit', 'other']), 'V-2 alle Erstattungsarten bleiben wählbar (keine entfernt)');
  ok(/setReturnRefundMethod\(suggestReturnRefund\(zahlungen\)\.method\);/.test(quelle) && /data-return-refund-suggestion=\{v\.basis\}/.test(quelle)
    && !/setReturnRefundMethod\('bank'\);/.test(quelle),
  'V-3 die Maske (Primary und PC2, dieselbe Seite) belegt aus den Zahlungen der Seitenauskunft vor und zeigt den Hinweis');
}
{
  // Ganz mit Store Credit bezahlt (Settle Balance), volle Rückgabe mit dem Vorschlag → Guthaben, kein Geld.
  const cid = 'cust-3';
  const sc = guthaben(cid, 500, '2026-10-01');
  const f = fall(cid);
  const r = rechnung(cid, [500]);
  await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  const v = vorschlag(r.id);
  ok(v.method === 'credit' && v.basis === 'all_store_credit' && eq(v.storeCredit, 500), `V-4 Rechnung ganz mit Store Credit bezahlt → Vorschlag „Store Credit" (${S(v)})`);
  const k0 = kasse();
  const rid = maske(r.id, r.zeilen, v.method);
  const b = lage(cid);
  ok(eq(erstattet(rid), 500) && eq(kasse(), k0) && eq(b.guthaben, 500) && bilanz(f.start, b) === 0
    && Number(ccDb(sc)[1]) === 500,
  `V-5 volle Rückgabe mit dem Vorschlag: neues Guthaben 500, kein Geld, das verbrauchte Guthaben bleibt verbraucht (kein doppeltes) — Bilanz 0 (${S(b)})`);
  einig('V-5b', r.id, cid, f.basis);
}
{
  // Ganz mit Store Credit bezahlt, der Benutzer wählt ausdrücklich Bargeld → Geld, kein Guthaben.
  const cid = 'cust-4';
  guthaben(cid, 500, '2026-10-01');
  const f = fall(cid);
  const r = rechnung(cid, [200, 300]);
  await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  ok(vorschlag(r.id).method === 'credit', 'V-6 Vorschlag „Store Credit"');
  const k0 = kasse();
  const rid = maske(r.id, [r.zeilen[0]], 'cash');
  const b = lage(cid);
  ok(eq(erstattet(rid), 200) && eq(k0 - kasse(), 200) && eq(b.guthaben, 0) && bilanz(f.start, b) === -300,
    `V-7 Benutzer wählt Bargeld (Teilrückgabe 200): 200 bar, kein neues Guthaben; behalten 300 — Bilanz −300 (${S(b)})`);
  const rid2 = maske(r.id, [r.zeilen[1]], 'credit');
  const c = lage(cid);
  ok(eq(erstattet(rid2), 300) && eq(c.guthaben, 300) && bilanz(f.start, c) === 0, `V-8 Rest als Store Credit: 300 Guthaben — insgesamt Bilanz 0, nichts doppelt (${S(c)})`);
  einig('V-8b', r.id, cid, f.basis);
}
{
  // Gemischt: Bargeld + Store Credit + Darlehen → keine Vorbelegung (Bank), Hinweis; gewählte Art wirkt wie bisher.
  const cid = 'cust-5';
  guthaben(cid, 300, '2026-10-01');
  loan('we_borrow', 400, cid, '2026-09-10T09:00:00.000Z');
  const f = fall(cid);
  const r = rechnung(cid, [400, 600]);
  bar(r.id, 300);
  await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  const v = vorschlag(r.id);
  ok(v.method === 'bank' && v.basis === 'mixed_store_credit' && eq(v.storeCredit, 300) && eq(v.other, 700),
    `V-9 gemischt (300 bar + 300 Guthaben + 400 Darlehen): keine Vorbelegung, Hinweis mit den Anteilen (${S(v)})`);
  const rid = maske(r.id, [r.zeilen[0]], 'credit');
  const b = lage(cid);
  ok(eq(erstattet(rid), 400) && eq(b.guthaben, 400) && bilanz(f.start, b) === -600, `V-10 gewählt Store Credit (Teilrückgabe 400): 400 Guthaben — Bilanz −600 (${S(b)})`);
  const rid2 = maske(r.id, [r.zeilen[1]], 'cash');
  const c = lage(cid);
  ok(eq(erstattet(rid2), 600) && bilanz(f.start, c) === 0, `V-11 Rest bar 600 — vollständig zurück, Bilanz 0, keine doppelte Erstattung (${S(c)})`);
  einig('V-11b', r.id, cid, f.basis);
}
{
  // PC2: dieselbe Hausfolge mit dem Vorschlag (returns.create, refundMethod credit) — dasselbe Ergebnis.
  const cid = 'cust-6';
  guthaben(cid, 500, '2026-10-01');
  const f = fall(cid);
  const r = rechnung(cid, [500]);
  await settle(alles(cid, { finalNumbers: { [r.id]: 'normal' } }));
  const o = await fern(() => rcmd.runCreateReturn(deps() as never, identity('901', 'returns.create'),
    { invoiceId: r.id, expectedRevision: invRev(r.id), lines: [{ invoiceLineId: r.zeilen[0], quantity: 1 }], refundMethod: vorschlag(r.id).method, productDisposition: 'IN_STOCK', refundNow: true }));
  reload();
  const rid = s(DB, 'SELECT id FROM sales_returns WHERE invoice_id = ?', [r.id]);
  const b = lage(cid);
  ok(o.kind === 'ok' && eq(erstattet(rid), 500) && eq(b.guthaben, 500) && bilanz(f.start, b) === 0, `V-12 PC2: derselbe Vorschlag und dasselbe Ergebnis (${S({ kind: o.kind, code: o.code })})`);
  const w = await fern(() => rcmd.runCreateReturn(deps() as never, identity('901', 'returns.create'),
    { invoiceId: r.id, expectedRevision: invRev(r.id), lines: [{ invoiceLineId: r.zeilen[0], quantity: 1 }], refundMethod: 'credit', productDisposition: 'IN_STOCK', refundNow: true }));
  ok(w.replayed === true && n(DB, 'SELECT COUNT(*) FROM customer_credits WHERE customer_id = ? AND source_type = ?', [cid, 'sales_return']) === 1,
    `V-13 PC2-Wiederholung: kein zweites Guthaben (${S({ kind: w.kind, replayed: w.replayed })})`);
}

// ══ D — Diagnose: wann bucht eine Erstattung Geld? ═══════════════════════════════════════════════════════════════
{
  // D1 „Refund now" (Weg der Maske): Freigabe + Auszahlung in EINER Folge — Geld = ausgezahlt.
  const cid = 'cust-7';
  const r = rechnung(cid, [1000]);
  bar(r.id, 1000);
  const k0 = kasse();
  const rid = maske(r.id, r.zeilen, 'cash', true);
  ok(S(rueck(rid)) === S(['REFUNDED', 'REFUNDED', 1000, 'cash']) && eq(k0 - kasse(), 1000) && eq(cnBuchung(rid, ['CASH']), -1000) && abstandKonto('CASH') === 0,
    `D1 „Refund now": REFUNDED, 1.000 ausgezahlt = 1.000 Kassenbuchung; Abstimmung Kasse ohne Abstand (${S(rueck(rid))})`);
}
{
  // D2 „Refund later" (Weg der Maske): angelegt, keine Gutschrift, keine Buchung — erst die Auszahlung bucht.
  const cid = 'cust-8';
  const r = rechnung(cid, [1000]);
  bar(r.id, 1000);
  const k0 = kasse();
  const rid = maske(r.id, r.zeilen, 'cash', false);
  ok(rueck(rid)[0] === 'REQUESTED' && eq(kasse(), k0) && s(DB, 'SELECT id FROM credit_notes WHERE sales_return_id = ?', [rid]) === '',
    `D2 „Refund later": REQUESTED, keine Gutschrift, keine Geldbuchung im Hauptbuch (${S(rueck(rid))})`);
  console.log(`  D2 Banking zeigt für die offene Erstattung: ${bankingAbfluss(rid).toFixed(3)} Abfluss (ausgezahlt ${erstattet(rid)})`);
  ok(eq(bankingAbfluss(rid), 0), `D2b Banking zeigt die offene Erstattung nicht als Abfluss — wie das Hauptbuch (${bankingAbfluss(rid)})`);
  const o = await fern(() => rcmd.runRecordRefundPayment(deps() as never, identity('911', 'returns.record_refund_payment'),
    { returnId: rid, amount: 1000, method: 'cash', expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  ok(o.kind === 'ok' && rueck(rid)[0] === 'REFUNDED' && eq(k0 - kasse(), 1000) && abstandKonto('CASH') === 0,
    `D2b spätere Auszahlung (PC2 returns.record_refund_payment): Freigabe + Auszahlung zusammen, 1.000 Kassenbuchung (${S({ kind: o.kind, code: o.code })})`);
}
let approveBeleg = '';
{
  // D3 PC2 `returns.approve` OHNE Auszahlung — die Diagnose.
  const cid = 'cust-9';
  const r = rechnung(cid, [1000]);
  bar(r.id, 1000);
  const rid = maske(r.id, r.zeilen, 'cash', false);
  const k0 = kasse();
  const o = await fern(() => rcmd.runApproveReturn(deps() as never, identity('921', 'returns.approve'),
    { returnId: rid, expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  const kassenAbgang = k0 - kasse();
  approveBeleg = `Status ${S(rueck(rid))} · Gutschrift (bar, Forderung) ${S(cnVon(rid))} · Kasse im Hauptbuch −${kassenAbgang.toFixed(3)} · Abstand Kasse ${abstandKonto('CASH')} Fils · AR ${abstandKonto('ACCOUNTS_RECEIVABLE')} Fils`;
  console.log(`  D3 PC2 returns.approve ohne Auszahlung: ${approveBeleg}`);
  ok(o.kind === 'ok' && rueck(rid)[0] === 'APPROVED' && rueck(rid)[1] === 'PENDING_REFUND' && Number(rueck(rid)[2]) === 0,
    `D3a PC2 kann freigeben, ohne auszuzahlen: APPROVED, Erstattung offen, ausgezahlt 0 (${S(rueck(rid))})`);
  ok(eq(kassenAbgang, 1000) && eq(cnBuchung(rid, ['CASH']), -1000),
    `D3b BEFUND: die Gutschrift bucht die Erstattung schon bei der Freigabe aus der Kasse (−1.000), obwohl nichts ausgezahlt ist`);
  ok(abstandKonto('CASH') === 0 && eq(bankingAbfluss(rid), 0),
    `D3c BEFUND: Hauptbuch −1.000 Kasse, die Abstimmung zeigt KEINEN Abstand (ihr Bestand zählt die Erstattung der Gutschrift ebenso), Banking und Erstattungsstatus zeigen 0 ausgezahlt — Hauptbuch ≠ Banking bis zur Auszahlung (Abstand ${abstandKonto('CASH')} Fils, Banking ${bankingAbfluss(rid)})`);
  // Auszahlung danach: keine doppelte Kassenbuchung (die Gutschrift wird neu gebucht).
  const p = await fern(() => rcmd.runRecordRefundPayment(deps() as never, identity('922', 'returns.record_refund_payment'),
    { returnId: rid, amount: 1000, method: 'cash', expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  ok(p.kind === 'ok' && eq(k0 - kasse(), 1000) && abstandKonto('CASH') === 0 && rueck(rid)[0] === 'REFUNDED' && eq(bankingAbfluss(rid), 1000),
    `D3d nach der Auszahlung: insgesamt EINMAL 1.000 aus der Kasse, Abstimmung wieder ohne Abstand — keine doppelte Erstattung (${S(rueck(rid))})`);
}
{
  // D4 Teilauszahlung nach PC2-Freigabe: die Gutschrift folgt dem Ausgezahlten; der Rest steht als Guthaben in der Forderung.
  const cid = 'cust-10';
  const r = rechnung(cid, [1000]);
  bar(r.id, 1000);
  const rid = maske(r.id, r.zeilen, 'cash', false);
  const k0 = kasse();
  await fern(() => rcmd.runApproveReturn(deps() as never, identity('931', 'returns.approve'), { returnId: rid, expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  await fern(() => rcmd.runRecordRefundPayment(deps() as never, identity('932', 'returns.record_refund_payment'),
    { returnId: rid, amount: 400, method: 'cash', expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  ok(eq(k0 - kasse(), 400) && rueck(rid)[1] === 'PARTIALLY_REFUNDED' && eq(arRechnung(r.id), -600) && abstandKonto('CASH') === 0,
    `D4 Teilauszahlung 400: Kasse −400, offene Erstattung 600 als Forderung zugunsten des Kunden (AR −600), Kasse ohne Abstand (${S(rueck(rid))})`);
}
{
  // D5 Storno vor der Auszahlung (Erstattung offen): die verfrühte Kassenbuchung geht mit zurück.
  const cid = 'cust-11';
  const r = rechnung(cid, [1000]);
  bar(r.id, 1000);
  const rid = maske(r.id, r.zeilen, 'cash', false);
  const k0 = kasse();
  await fern(() => rcmd.runApproveReturn(deps() as never, identity('941', 'returns.approve'), { returnId: rid, expectedRevision: n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]) }));
  reload();
  const e = wirft(() => imHaus(() => (cancelReturnInHouse as (...a: unknown[]) => unknown)(rid, 'Prüfung', { userId: 'user-test', role: 'ADMIN' }, 'branch-main')));
  reload();
  ok(e === '' && eq(kasse(), k0) && abstandKonto('CASH') === 0 && rueck(rid)[0] === 'REJECTED',
    `D5 Cancel Return vor der Auszahlung: Kasse wieder wie vorher, kein Abstand (${e || 'ok'})`);
  ok(!/runApproveReturn|'returns\.approve'/.test(quelle), 'D6 keine Seite ruft die Freigabe allein (nur PC2-Befehl ohne Oberfläche)');
}
void approveBeleg;

void [cancelHouse, create, undo, geldKonten, abdruck, nummer, offen, kontoOffen, loadDebtPaymentsFor, payS, banking, analytics, backfill, executeCommand, lc, fc, money, po, geld, stand, sale, gap, TODAY, HCTX, readFileSync, existsSync, zeilen, insert, debtState, pcmd, perms, sr, st, useSupplierStore, usePurchaseStore, useCreditNoteStore, status, zurueck, fc2, darlehenOffen];
console.log(`\nC refund suggestion + approve diagnosis: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

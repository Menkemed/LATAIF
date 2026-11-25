// CUSTOMER-SUPPLIER-ROLE-LINK V3 — „Unlink Supplier“ (Owner 25.11.2026) mit Verrechnungsschutz.
// Harness übernommen aus test/customer-account/b23-purchase-offset.test.ts (dort aus c-settle-balance).
// Run: node test/role-link/supplier-unlink.test.ts
/* eslint-disable @typescript-eslint/no-unused-vars -- übernommener Harness (nicht jeder Helfer wird hier gebraucht). */
// CUSTOMER ACCOUNT C — „Settle Balance" im Kundenkonto (Owner 09.11.2026): Rechnungen gegen Store Credit und We Borrowed
// desselben Kunden, ohne Geld, unter EINER Nummer STL-…, in EINER Transaktion; Rückgängig je Zuordnung und als ganze STL.
//   Vorschlag (FIFO, Reihenfolge V7, Häkchen), Buchung (vorhandene Wege: Anrechnung 'credit' und B1 'debt_offset'),
//   Endnummern, VAT-Sperre, Fingerabdruck, Summe, Kunde/Filiale, PC2 + Wiederholung, Storno, spätere Rückgabe,
//   Hauptbuch + Abstimmungen + Kundenkonto, keine Geldbewegung, B1 unverändert, Einkauf/Kommission/Partner nicht angeboten.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/b1-followup.test.ts.
// Run: node test/customer-account/c-settle-balance.test.ts
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
    // Der Ankaufbeleg importiert das Logo (Vite liefert eine URL) — im Test eine leere Zeichenkette.
    if (specifier.endsWith('.png')) return { url: 'data:text/javascript,export default ""', shortCircuit: true };
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

const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const codeOf = (x: string): string => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 — Einkaufsverrechnung (normal + Kommission) über EINE Hausfolge (Stufe C, dritte Gruppe „Purchases").
// ════════════════════════════════════════════════════════════════════════════
const ps = await import('../../src/core/purchases/purchase-settled.ts');
const pe = await import('../../src/core/purchases/purchase-edit-house.ts');
const pl = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const ph = await import('../../src/core/payables/payables-house.ts');
const reads = await import('../../src/core/offsets/party-offset-reads.ts');
const cpa = await import('../../src/core/ledger/counterpartyAudit.ts');
const { query: dbq } = await import('../../src/core/db/helpers.ts');
const PCTX = { branchId: 'branch-main', userId: 'user-test', now: '2026-10-25T10:00:00.000Z' };
const K = 'cust-5';
const pur = (id: string) => DB.exec('SELECT status, paid_amount, remaining_amount, total_amount, supplier_id FROM purchases WHERE id = ?', [id])[0].values[0];
const purOpen = (id: string): number => ps.purchaseSettlementOf(id).openF / 1000;
const apSupplier = (sid: string): number => -n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_PAYABLE' AND counterparty_type = 'SUPPLIER' AND counterparty_id = ?`, [sid]);
const arCustomer = (cid: string): number => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_type = 'CUSTOMER' AND counterparty_id = ?`, [cid]);
const cpDiff = (side: 'apBySupplier' | 'arByCustomer', id: string): number => {
  const a = cpa.runCounterpartyAudit(dbq as never, 'branch-main');
  return Number(a[side].rows.find((x: { id: string }) => x.id === id)?.diffFils ?? 0);
};
const vatBal = (): string => S(['VAT_OUTPUT', 'MARGIN_VAT', 'VAT_INPUT'].map((a) => F(bal(a))));
const einkauf = (sid: string, preis: number, date: string): string => {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: sid, purchaseDate: date,
    lines: [{ productId: neuerArtikel(), quantity: 1, unitPrice: preis, taxScheme: 'ZERO', vatRate: 0 }] } as never)).id;
  reload();
  return id;
};


// ════════════════════════════════════════════════════════════════════════════
// V3 — nachträglich verknüpfen → verrechnen → Unlink gesperrt → Rücknahme (VAT-Sperre respektiert) → Unlink.
// ════════════════════════════════════════════════════════════════════════════
const md = await import('../../src/core/bridge/masterdata-commands.ts');
const supStore = await import('../../src/stores/supplierStore.ts');
const poff = await import('../../src/core/offsets/purchase-offsets.ts');
const KX = 'cust-7', KX2 = 'cust-8';
const custUpd = (cid: string): string => s(DB, 'SELECT updated_at FROM customers WHERE id = ?', [cid]);
const link = (sid: string): string | null => (one(DB, 'SELECT linked_customer_id FROM suppliers WHERE id = ?', [sid]) as string | null) ?? null;
const unlink = (sid: string, cid: string, reason: string, actor?: { userId?: string; branchId?: string }) =>
  wirft(() => imHaus(() => useSupplierStore.getState().unlinkSupplierFromCustomer(sid, cid, reason, actor)));
// Alles Geschäftliche (ohne Stammdaten und Protokoll) — das Lösen darf daran NICHTS ändern.
const GESCHAEFT = ['invoices', 'payments', 'customer_credits', 'credit_applications', 'debts', 'debt_payments', 'party_offsets', 'ledger_entries',
  'expenses', 'purchases', 'purchase_payments', 'purchase_lines'];
const geschaeft = (): string => S(GESCHAEFT.map((t) => { try { return DB.exec(`SELECT * FROM ${t} ORDER BY rowid`)[0]?.values ?? []; } catch { return 'n/a'; } }));
const lieferant = (sid: string): string => zeilen('SELECT * FROM suppliers WHERE id = ?', [sid]);
const auditLinks = (sid: string) => DB.exec(`SELECT old_value, new_value, changed_by FROM audit_log
  WHERE entity_type = 'suppliers' AND entity_id = ? AND field_name = 'linked_customer_id' AND new_value LIKE '%reason%' ORDER BY rowid`, [sid])[0]?.values ?? [];

// ── Welt: Lieferant OHNE Verknüpfung, mit zwei vorhandenen Einkäufen (einer teilbezahlt); Rechnung des Kunden ──
const SUP = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Kunde 7' } as never)).id;
const P1 = einkauf(SUP, 400, '2026-10-02');
const P2 = einkauf(SUP, 150, '2026-10-03');
imHaus(() => ph.recordPurchasePaymentInHouse(P2, 50, 'cash', PCTX));
reload();
const I1 = verkauf(KX, 500, '2026-10-05');   // = beide Einkäufe offen (400 + 100): die STL schließt die Rechnung → FINAL (VAT-Periode zählt)

// ── 1 Ohne Verknüpfung: nicht angeboten, und eine Verrechnung wird abgelehnt ──
{
  ok(!lese(KX).sources.some((x) => x.id === P1 || x.id === P2), 'L1 ohne Verknüpfung bietet Settle Balance die Einkäufe nicht an');
  const vor = geschaeft();
  const code = wirft(() => imHaus(() => poff.createPurchaseOffsetInHouse({ invoiceId: I1, purchaseId: P1, amount: 100, offsetDate: '2026-10-20' }, HCTX)));
  ok(code === poff.OFFSET_SUPPLIER_NOT_LINKED && geschaeft() === vor, `L2 Verrechnung ohne gültige Verknüpfung abgelehnt, nichts geändert (${code})`);
  ok(konto(KX).supplierRole === null && !konto(KX).docs.some((d) => d.key === `purchase:${P1}`), 'L3 Kundenkonto zählt die Einkäufe ohne Verknüpfung nicht');
}

// ── 2 Nachträglich verknüpfen (vorhandener Weg) → Konto + Angebot, keine Buchung ──
{
  const vor = geschaeft();
  const r = imHaus(() => useSupplierStore.getState().linkSupplierToCustomer(SUP, KX, custUpd(KX)));
  ok(!r.existing && link(SUP) === KX && geschaeft() === vor, 'L4 nachträglich verknüpft: nur linked_customer_id, keine Buchung');
  const a = konto(KX);
  ok(a.supplierRole?.id === SUP && eq(kontoOffen(KX, `purchase:${P1}`), 400) && eq(kontoOffen(KX, `purchase:${P2}`), 100),
    `L5 Kundenkonto zeigt jetzt die vorhandenen Einkäufe der Rolle (400, 100 offen) (${kontoOffen(KX, `purchase:${P1}`)}, ${kontoOffen(KX, `purchase:${P2}`)})`);
  ok(eq(a.net, 0), `L6 Nettosaldo = Rechnung 500 − Einkäufe 500 = 0 (${a.net})`);
  ok(S(lese(KX).sources.map((x) => x.id)) === S([P1, P2]), 'L7 Settle Balance bietet die vorhandenen Einkäufe an, älteste zuerst');
}

// ── 3 Verrechnen → Unlink gesperrt (Primary-Haus UND Fernweg), Meldung nennt die STL ──
let STL = '';
{
  const out = await settle(alles(KX, { finalNumbers: { [I1]: 'normal' }, settlementDate: '2026-10-20' }));
  ok(out.ok, `L8 Settle Balance mit der nachträglich verknüpften Rolle gebucht (${S(out).slice(0, 160)})`);
  if (out.ok) STL = out.v.settlementNumber;
  ok(/^STL-/.test(STL) && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND status = 'ACTIVE' AND payable_type = 'PURCHASE'", [STL]) === 2,
    'L9 zwei aktive Zuordnungen unter einer STL');
  const vorG = geschaeft(), vorL = lieferant(SUP), vorA = n(DB, 'SELECT COUNT(*) FROM audit_log');
  let msg = '';
  try { imHaus(() => useSupplierStore.getState().unlinkSupplierFromCustomer(SUP, KX, 'wrong client')); } catch (e) { msg = `${(e as { code?: string }).code} ${(e as Error).message}`; }
  ok(msg.startsWith(supStore.SUPPLIER_LINK_HAS_ACTIVE_OFFSETS) && msg.includes(STL), `L10 Unlink mit aktiver Verrechnung abgelehnt, Meldung nennt ${STL} (${msg})`);
  ok(geschaeft() === vorG && lieferant(SUP) === vorL && n(DB, 'SELECT COUNT(*) FROM audit_log') === vorA && link(SUP) === KX, 'L11 abgelehnt: nichts geändert, kein Protokolleintrag');
  const fernR = await fern(() => md.runSupplierUpdate(deps(), identity('u1', 'suppliers.update'), { id: SUP, unlinkCustomerId: KX, reason: 'wrong client' }));
  ok(fernR.kind === 'rejected' && fernR.code === supStore.SUPPLIER_LINK_HAS_ACTIVE_OFFSETS && link(SUP) === KX, `L12 PC2-Fernweg: ebenso abgelehnt (${fernR.kind} ${fernR.code})`);
}

// ── 4 Rücknahme im eingereichten VAT-Quartal unzulässig → Verknüpfung bleibt ──
{
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  insert(DB, 'vat_filings', { id: 'vf-ul', branch_id: 'branch-main', year: new Date().getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
  const g = await undo({ settlementNumber: STL, expectedActiveLines: 2, reason: 'test' });
  ok(!g.ok && /VAT_PERIOD_FILED|filed|quarter/i.test(g.code), `L13 eingereichtes VAT-Quartal: STL nicht aufhebbar (${g.ok ? 'DURCH' : g.code})`);
  ok(unlink(SUP, KX, 'wrong client') === supStore.SUPPLIER_LINK_HAS_ACTIVE_OFFSETS && link(SUP) === KX, 'L14 die Verknüpfung bleibt bestehen, Unlink weiter gesperrt');
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-ul'");
}

// ── 5 Teilweise Rücknahme reicht nicht; vollständige Rücknahme → Unlink erlaubt ──
{
  const zeile = String(one(DB, "SELECT receivable_payment_id FROM party_offsets WHERE settlement_number = ? AND status = 'ACTIVE' ORDER BY offset_number LIMIT 1", [STL]));
  imHaus(() => useInvoiceStore.getState().deletePayment(zeile, I1, { offsetReason: 'test partial' } as never));
  reload();
  ok(n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND status = 'ACTIVE'", [STL]) === 1, 'L15 eine Zuordnung zurückgenommen, eine bleibt aktiv');
  ok(unlink(SUP, KX, 'wrong client') === supStore.SUPPLIER_LINK_HAS_ACTIVE_OFFSETS, 'L16 solange noch eine Zuordnung aktiv ist: Unlink gesperrt');
  const ganz = await undo({ settlementNumber: STL, expectedActiveLines: 1, reason: 'test undo' });
  reload();
  ok(ganz.ok && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND status = 'ACTIVE'", [STL]) === 0, `L17 STL vollständig zurückgenommen (${ganz.ok ? '' : ganz.code})`);
}

// ── 6 Unlink: Pflichtgrund, Schutz gegen veralteten Stand, dann gelöst — nur die Verknüpfung, mit Protokoll ──
{
  ok(unlink(SUP, KX, '   ') === supStore.SUPPLIER_UNLINK_REASON_REQUIRED && link(SUP) === KX, 'L18 ohne Grund abgelehnt');
  const leer = await fern(() => md.runSupplierUpdate(deps(), identity('u2', 'suppliers.update'), { id: SUP, unlinkCustomerId: KX }));
  ok(leer.kind === 'thrown' && link(SUP) === KX, `L19 Fernweg ohne Grund: unbrauchbarer Auftrag (${leer.kind} ${leer.code || leer.thrown})`);
  ok(unlink(SUP, KX2, 'wrong client') === supStore.SUPPLIER_LINK_CHANGED && link(SUP) === KX, 'L20 veralteter Stand (zeigt auf einen anderen Kunden): abgelehnt');
  const vorG = geschaeft(), vorAp = apSupplier(SUP), vorAr = arCustomer(KX), vorRev = n(DB, 'SELECT revision FROM suppliers WHERE id = ?', [SUP]);
  const vorL = JSON.parse(lieferant(SUP))[0] as unknown[];
  const r = await fern(() => md.runSupplierUpdate(deps(), identity('u3', 'suppliers.update'), { id: SUP, unlinkCustomerId: KX, reason: 'linked to the wrong client' }));
  ok(r.kind === 'ok' && r.value?.changed === true && link(SUP) === null, `L21 PC2-Fernweg: Unlink nach vollständiger Rücknahme erlaubt (${r.kind} ${r.code ?? ''})`);
  ok(geschaeft() === vorG && eq(apSupplier(SUP), vorAp) && eq(arCustomer(KX), vorAr), 'L22 keine neue oder veränderte Geschäftsbuchung, Einkauf, Rechnung, Zahlung');
  const nachL = JSON.parse(lieferant(SUP))[0] as unknown[];
  const cols = DB.exec('PRAGMA table_info(suppliers)')[0].values.map((v) => String(v[1]));
  const anders = cols.filter((_c, i) => S(vorL[i]) !== S(nachL[i]));
  ok(S([...anders].sort()) === S(['linked_customer_id', 'revision', 'updated_at'].sort()) && n(DB, 'SELECT revision FROM suppliers WHERE id = ?', [SUP]) === vorRev + 1,
    `L23 am Lieferanten nur Verknüpfung, Stand und Zeitstempel (${S(anders)})`);
  const au = auditLinks(SUP);
  const nv = au.length ? JSON.parse(String(au[0][1])) : {};
  ok(au.length === 1 && String(au[0][0]).includes(KX) && nv.reason === 'linked to the wrong client' && nv.customerId === null && String(au[0][2]) === 'user-pc2',
    `L24 Protokoll: bisheriger Kunde, Grund, wirklicher Benutzer (PC2) (${S(au)})`);
  const again = await fern(() => md.runSupplierUpdate(deps(), identity('u3', 'suppliers.update'), { id: SUP, unlinkCustomerId: KX, reason: 'linked to the wrong client' }));
  ok(again.kind === 'ok' && again.replayed === true && auditLinks(SUP).length === 1, `L25 dieselbe Zustellung noch einmal: wirkt einmal (replayed), kein zweiter Eintrag (${again.kind} ${again.replayed})`);
  const nochmal = await fern(() => md.runSupplierUpdate(deps(), identity('u4', 'suppliers.update'), { id: SUP, unlinkCustomerId: KX, reason: 'again' }));
  ok(nochmal.kind === 'ok' && nochmal.value?.changed === false && auditLinks(SUP).length === 1, 'L26 schon gelöst: nichts zu tun, kein zweiter Eintrag');
}

// ── 7 Konto nach Unlink: getrennte Salden; Verrechnung wieder abgelehnt; neue Verknüpfung möglich ──
{
  const a = konto(KX);
  ok(a.supplierRole === null && !a.docs.some((d) => d.key === `purchase:${P1}` || d.key === `purchase:${P2}`), 'L27 Kundenkonto ohne die Einkäufe des Lieferanten');
  ok(eq(a.net, 500) && eq(offen(I1), 500), `L28 Kundenkonto: nur die Forderung 500 (Rechnung wieder voll offen) (${a.net}, ${offen(I1)})`);
  ok(eq(purOpen(P1), 400) && eq(purOpen(P2), 100), `L29 Lieferant: seine Einkäufe bleiben offen (400, 100) — getrennte Konten (${purOpen(P1)}, ${purOpen(P2)})`);
  ok(!lese(KX).sources.some((x) => x.id === P1 || x.id === P2), 'L30 Settle Balance bietet sie nicht mehr an');
  const code = wirft(() => imHaus(() => poff.createPurchaseOffsetInHouse({ invoiceId: I1, purchaseId: P1, amount: 100, offsetDate: '2026-10-20' }, HCTX)));
  ok(code === poff.OFFSET_SUPPLIER_NOT_LINKED, `L31 ein veralteter Verrechnungsauftrag nach Unlink: abgelehnt (${code})`);
  const r = imHaus(() => useSupplierStore.getState().linkSupplierToCustomer(SUP, KX2, custUpd(KX2)));
  ok(!r.existing && link(SUP) === KX2 && konto(KX2).supplierRole?.id === SUP, 'L32 danach über die vorhandene Link-Funktion einem anderen Kunden zugeordnet');
}

// ── 8 Quelltext: Prüfung im Schreibvorgang, Fernweg über suppliers.update, keine Buchungsfunktion ──
{
  const st0 = codeOf(src('src/stores/supplierStore.ts'));
  const fn = st0.slice(st0.indexOf('unlinkSupplierFromCustomer: (supplierId, expectedCustomerId'), st0.indexOf('updateSupplier: (id, data)'));
  ok(/activeSupplierOffsets\(/.test(fn) && fn.indexOf('activeSupplierOffsets(') < fn.indexOf('UPDATE suppliers SET linked_customer_id = NULL'),
    'Q1 die Verrechnungssperre wird im Schreibvorgang VOR dem Schreiben geprüft');
  ok(/WHERE id = \? AND linked_customer_id = \?/.test(fn) && /changes\(\)/.test(fn), 'Q2 bedingtes Schreiben (nur wenn noch auf diesen Kunden) + Prüfung der Wirkung');
  ok(!/ledger|recordPayment|deletePayment|INSERT INTO|DELETE FROM/i.test(fn.replace(/logAuditOrThrow\([\s\S]*?\}\);/, '')), 'Q3 keine Buchung, keine Zahlung, kein Einfügen/Löschen');
  const save = codeOf(src('src/core/masterdata/masterdata-save.ts'));
  ok(/unlinkCustomerId: customerId, reason: grund/.test(save) && /runOnPrimary\(\(\) => \{\s*const out = useSupplierStore\.getState\(\)\.unlinkSupplierFromCustomer/.test(save),
    'Q4 Primary in runOnPrimary, PC2 über suppliers.update');
}

console.log(`\nSUPPLIER UNLINK V3: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('SUPPLIER_UNLINK_OFFSET_GUARD_PROVED');

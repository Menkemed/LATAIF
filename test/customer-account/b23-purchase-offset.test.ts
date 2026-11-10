// B2/B3 — Einkaufsverrechnung. Harness übernommen aus test/customer-account/c-settle-balance.test.ts.
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

// ── Welt: Kunde K5 mit verknüpfter Lieferantenrolle; ein normaler und ein Kommissions-Einkauf; zwei Rechnungen ──
const supK = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Kunde 5' } as never, { linkedCustomerId: K } as never)).id;
const supFremd = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Kunde 5 Namensgleich' } as never)).id;
const PN = einkauf(supK, 400, '2026-10-02');
const PC = einkauf(supK, 300, '2026-10-03');
DB.run("UPDATE purchases SET source_consignment_id = 'con-x' WHERE id = ?", [PC]);
const PX = einkauf(supFremd, 999, '2026-10-02');       // Lieferant NICHT verknüpft (nur Name ähnlich) → nie angeboten
const PZ = einkauf(supK, 50, '2026-10-02');
imHaus(() => pl.cancelPurchaseInHouse(PZ, 'branch-main'));  // storniert → nie angeboten
imHaus(() => ph.recordPurchasePaymentInHouse(PN, 100, 'cash', PCTX));
reload();
const IA = verkauf(K, 500, '2026-10-05');
const IB = verkauf(K, 350, '2026-10-06');
{
  const r = lese(K);
  ok(S(r.sources.map((x) => x.id)) === S([PN, PC]) && r.sources.every((x) => x.kind === 'PURCHASE'),
    `B23-R1 angeboten: genau die offenen Einkäufe der VERKNÜPFTEN Rolle, älteste zuerst (${S(r.sources.map((x) => x.number + ':' + x.open))})`);
  ok(eq(r.sources[0].open, 300) && eq(r.sources[1].open, 300), 'B23-R2 nur der offene Rest (400 − 100 bar = 300; 300)');
  ok(r.sources[0].label === 'purchase' && r.sources[1].label === 'consignment purchase' && r.sources[1].consignment === true,
    'B23-R3 normal und Kommission klar gekennzeichnet');
  ok(!r.sources.some((x) => x.id === PX || x.id === PZ), 'B23-R4 nicht angeboten: fremder Lieferant (kein Abgleich über Name) und storniert');
  ok(S(sr.SETTLE_SOURCE_ORDER) === S(['STORE_CREDIT', 'LOAN_BORROWED', 'PURCHASE']), 'B23-R5 V7: Store Credit → We Borrowed → Purchases');
}
marker('B23_PURCHASE_OFFER_PROVED');

// ── Buchung: alles in einer STL, keine Geldbewegung, AP beim Lieferanten / AR beim Kunden ──
let STL = '';
{
  const geld0 = geldKonten(), vat0 = vatBal(), ap0 = apSupplier(supK), ar0 = arCustomer(K), paid0 = Number(pur(PN)[1]);
  const banking0 = S(banking.bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []).map((t) => t.id));
  const req = alles(K, { finalNumbers: { [IA]: 'normal' }, settlementDate: '2026-10-20' });
  ok(eq(Number(req.expectedTotal), 600), `B23-B0 Vorschlag 600 (IA←PN 300, IA←PC 200, IB←PC 100) (${req.expectedTotal})`);
  const out = await settle(req);
  ok(out.ok, `B23-B1 gebucht (${S(out).slice(0, 160)})`);
  if (out.ok) STL = out.v.settlementNumber;
  ok(/^STL-/.test(STL) && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND payable_type = 'PURCHASE' AND status = 'ACTIVE'", [STL]) === 3,
    'B23-B2 drei Zuordnungen unter EINER STL, payable_type PURCHASE');
  ok(geldKonten() === geld0, 'B23-B3 keine Geldbewegung (Kasse, Bank, Benefit, Karte unverändert)');
  ok(vatBal() === vat0, 'B23-B4 kein Steuertatbestand: VAT/Margin/Vorsteuer unverändert');
  ok(eq(ap0 - apSupplier(supK), 600) && eq(ar0 - arCustomer(K), 600), `B23-B5 Soll AP (Lieferant ${supK}) 600 / Haben AR (Kunde) 600`);
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'ACCOUNTS_PAYABLE' AND direction = 'DEBIT' AND source_module = 'PAYMENT' AND counterparty_type = 'CUSTOMER'") === 0,
    'B23-B6 nie AP mit dem Kunden als Gegenpartei');
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND source_id IN (SELECT id FROM purchase_payments WHERE method = 'offset')") === 0,
    'B23-B7 die Einkaufszeilen (offset) buchen nicht selbst — eine Buchung je Zuordnung');
  ok(eq(Number(pur(PN)[1]), paid0) && String(pur(PN)[0]) === 'PAID' && eq(Number(pur(PN)[2]), 0), `B23-B8 PN: paid_amount bleibt nur Geld (100), Status PAID, Rest 0 (${S(pur(PN))})`);
  ok(String(pur(PC)[0]) === 'PAID' && eq(purOpen(PC), 0), 'B23-B9 PC (Kommission): PAID');
  ok(status(IA) === 'FINAL' && eq(offen(IB), 250), `B23-B10 IA voll bezahlt (FINAL), IB Rest 250 (${status(IA)} ${offen(IB)})`);
  ok(ledgerBalanced(), 'B23-B11 Hauptbuch ausgeglichen');
  ok(cpDiff('apBySupplier', supK) === 0 && cpDiff('arByCustomer', K) === 0, `B23-B12 AP je Lieferant und AR je Kunde: Hauptbuch = Bestand (${cpDiff('apBySupplier', supK)}, ${cpDiff('arByCustomer', K)})`);
  ok(S(banking.bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []).map((t) => t.id)) === banking0,
    'B23-B13 Banking unverändert (weder Rechnungs- noch Einkaufszeile als Geld)');
  const audit = n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'party_offsets' AND action_type = 'CREATE' AND new_value LIKE '%ACCOUNTS_PAYABLE (supplier)%'");
  ok(audit === 3, `B23-B14 Protokoll: Belege, Beträge, Datum, Person, Restbeträge je Zuordnung (${audit})`);
  const o = reads.offsetsOfPurchase(PC, 'branch-main');
  ok(o.length === 2 && o.every((x) => /^consignment purchase /.test(x.sourceLabel)), 'B23-B15 die Rechnung zeigt den Gegenbeleg „consignment purchase …"');
  const kd = konto(K).docs.find((d) => d.key === `purchase:${PN}`);
  ok(!!kd && kd.open < 0.0045 && konto(K).statement.some((r) => r.docKey === `purchase:${PN}` && /Settled by offset STL-/.test(r.text)), 'B23-B16 Kundenkonto: Einkauf beglichen, Ereignis „Settled by offset STL-…"');
}
marker('B23_PURCHASE_BOOKING_PROVED');

// ── Sperren solange die Verrechnung wirkt (je ohne Teiländerung) ─────────────────
{
  const vorher = abdruck();
  const offRow = s(DB, "SELECT id FROM purchase_payments WHERE purchase_id = ? AND method = 'offset' LIMIT 1", [PN]);
  const faelle: Array<[string, () => unknown, string]> = [
    ['Storno Einkauf', () => imHaus(() => pl.cancelPurchaseInHouse(PN, 'branch-main')), 'PURCHASE_HAS_OFFSET'],
    ['Lieferanten-Retoure', () => imHaus(() => pl.returnToSupplierInHouse({ purchaseId: PN, refundMethod: 'cash', lines: [] } as never, PCTX)), 'PURCHASE_HAS_OFFSET'],
    ['Void der Verrechnungszeile', () => imHaus(() => pe.voidPurchasePaymentInHouse(PN, offRow, 'x', PCTX as never)), 'PAYMENT_IS_OFFSET'],
    ['Datum der Verrechnungszeile', () => imHaus(() => pe.correctPurchasePaymentDateInHouse(PN, offRow, '2026-10-21', 'x', PCTX as never)), 'PAYMENT_IS_OFFSET'],
    ['Lieferantenwechsel', () => imHaus(() => pe.editPurchaseInHouse({ purchaseId: PN, reason: 'x', supplierId: supFremd } as never, PCTX as never)), 'PURCHASE_HAS_OFFSET'],
    ['Zahlart offset von Hand', () => imHaus(() => ph.recordPurchasePaymentInHouse(PC, 1, 'offset', PCTX)), 'PAYMENT_METHOD_INVALID'],
  ];
  for (const [was, fn, code] of faelle) {
    const c = wirft(fn);
    ok(c === code, `B23-G ${was} → ${code} (${c})`);
  }
  const pid = s(DB, "SELECT id FROM payments WHERE invoice_id = ? AND method = 'purchase_offset' LIMIT 1", [IB]);
  ok(/offset with a purchase/.test(wirft(() => imHaus(() => useInvoiceStore.getState().updatePayment(pid, IB, { amount: 50 } as never)))),
    'B23-G Rechnungszahlung purchase_offset ist nicht änderbar (nur aufheben)');
  ok(abdruck() === vorher, 'B23-G kein Nein hat etwas geändert');
  const src2 = (p: string) => codeOf(src(p));
  ok(/purchaseHasActiveOffsets\(l\.id\)/.test(src2('src/core/consignment/consignment-reversal-house.ts'))
    && /purchaseHasActiveOffsets\(purchaseId\)/.test(src2('src/core/invoices/mixed-invoice-correction.ts')),
    'B23-G Kommission „Cancel Sale"/„Return after sale" und Mixed-Korrektur prüfen die Verrechnung (gemeinsame Einlieferer-Prüfung)');
}
marker('B23_PURCHASE_GUARDS_PROVED');

// ── Einzeln aufheben (PC2: invoices.delete_payment), dann ganze STL ───────────────
{
  const geld0 = geldKonten();
  const pid = s(DB, "SELECT id FROM payments WHERE invoice_id = ? AND method = 'purchase_offset' LIMIT 1", [IB]);
  const body = { invoiceId: IB, paymentId: pid, expectedRevision: invRev(IB) };
  const a = await fern(() => fc.runDeletePayment(deps() as never, identity('901', 'invoices.delete_payment'), body));
  const b = await fern(() => fc.runDeletePayment(deps() as never, identity('901', 'invoices.delete_payment'), body));
  ok(a.kind === 'ok' && b.kind === 'ok' && (b as { replayed?: boolean }).replayed === true, `B23-U1 PC2 „Remove offset" wirkt, Wiederholung einmal (${a.kind}/${b.kind})`);
  ok(eq(offen(IB), 350) && eq(purOpen(PC), 100) && String(pur(PC)[0]) === 'PARTIALLY_PAID', `B23-U2 IB wieder 350 offen, PC wieder 100 offen (${offen(IB)} ${purOpen(PC)} ${pur(PC)[0]})`);
  ok(n(DB, "SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ? AND method = 'offset' AND voided_at IS NOT NULL", [PC]) === 1
    && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND status = 'REVERSED'", [STL]) === 1,
    'B23-U3 die Einkaufszeile ist storniert (nicht gelöscht), die Zuordnung REVERSED');
  ok(geldKonten() === geld0 && ledgerBalanced() && cpDiff('apBySupplier', supK) === 0 && cpDiff('arByCustomer', K) === 0, 'B23-U4 kein Geld, Hauptbuch und Abgleich je Gegenpartei stimmen');
  const u = await undo({ settlementNumber: STL, expectedActiveLines: 2 });
  ok(u.ok, `B23-U5 ganze STL rückgängig (${S(u).slice(0, 120)})`);
  ok(eq(purOpen(PN), 300) && String(pur(PN)[0]) === 'PARTIALLY_PAID' && eq(Number(pur(PN)[1]), 100) && eq(purOpen(PC), 300) && String(pur(PC)[0]) === 'UNPAID',
    `B23-U6 PN wieder 300 offen (Geld 100 bleibt), PC wieder UNPAID (${S(pur(PN))} ${S(pur(PC))})`);
  ok(eq(offen(IA), 500) && geldKonten() === geld0 && ledgerBalanced() && cpDiff('apBySupplier', supK) === 0, 'B23-U7 IA wieder offen, kein Geld, Abgleich stimmt');
  ok((await undo({ settlementNumber: STL })).ok === false, 'B23-U8 nie zweimal aufheben');
  const neu = await settle(alles(K, { finalNumbers: { [IA]: 'normal', [IB]: 'normal' }, settlementDate: '2026-10-21' }));
  ok(neu.ok, 'B23-U9 danach erneut verrechenbar (die stornierten Zeilen zählen nicht)');
}
marker('B23_PURCHASE_UNDO_PROVED');

// ── Rechnungsstorno (teilbezahlt): die Verrechnung geht zurück an den Einkauf, nie Geld ────────────
{
  const geld0 = geldKonten();
  const pcVor = purOpen(PC);
  ok(n(DB, "SELECT COUNT(*) FROM party_offsets WHERE receivable_id = ? AND status = 'ACTIVE'", [IB]) === 1 && eq(offen(IB), 250),
    `B23-S0 IB teilbezahlt durch Verrechnung 100 (${offen(IB)})`);
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: IB, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  ok(status(IB) === 'CANCELLED' && geldKonten() === geld0, `B23-S1 Storno der Rechnung: keine Erstattung in Geld (${status(IB)})`);
  ok(n(DB, "SELECT COUNT(*) FROM party_offsets WHERE receivable_id = ? AND status = 'ACTIVE'", [IB]) === 0 && eq(purOpen(PC), pcVor + 100),
    `B23-S2 ihre Verrechnung ist aufgehoben, der Einkauf wieder um 100 offen (${pcVor} → ${purOpen(PC)})`);
  ok(ledgerBalanced() && cpDiff('apBySupplier', supK) === 0 && cpDiff('arByCustomer', K) === 0, 'B23-S3 Abgleich stimmt');
}
marker('B23_PURCHASE_CANCEL_PROVED');

// ── Eine Regel: keine Kopie mehr, die nur Guthaben zählt ────────────────────────
{
  const { readdirSync, statSync } = await import('node:fs');
  const alle: string[] = [];
  const lauf = (d: string): void => { for (const f of readdirSync(d)) { const p = d + '/' + f; if (statSync(p).isDirectory()) lauf(p); else if (/\.(ts|tsx)$/.test(f)) alle.push(p); } };
  lauf(resolvePath(repo, 'src'));
  const alt = alle.filter((p) => /FROM purchase_payments[^`]*method = 'credit' AND (pp\.)?voided_at IS NULL/.test(readFileSync(p, 'utf8')));
  ok(alt.length === 0, `B23-E1 keine Einkaufs-Restkopie zählt nur 'credit' (${S(alt.map((p) => p.slice(repo.length)))})`);
  ok(ps.PURCHASE_NON_CASH_SQL === "('credit', 'offset')", 'B23-E2 die eine Liste: Guthaben + Verrechnung');
}
marker('B23_ONE_RULE_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 NACHBESSERUNG (Owner 10.11.2026) — „Change amount": frei wählbarer Betrag je Zuordnung (voll/teilweise),
// Obergrenzen, FIFO für den Rest, Serverprüfung, PC2, Undo, Ankaufbeleg.
// ════════════════════════════════════════════════════════════════════════════
const pdf = await import('../../src/core/pdf/purchase-pdf.ts');
const K6 = 'cust-6';
const sup6 = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Kunde 6' } as never, { linkedCustomerId: K6 } as never)).id;
const P6a = einkauf(sup6, 200, '2026-10-02');
const P6b = einkauf(sup6, 300, '2026-10-03');
const J1 = verkauf(K6, 250, '2026-10-05');
const J2 = verkauf(K6, 400, '2026-10-06');
const key = sr.settlePairKey;
/** Ein Auftrag mit von Hand gesetzten Beträgen — Summe aus derselben Rechnung wie die Maske. */
const mitBetraegen = (cid: string, amounts: Array<{ invoiceId: string; sourceId: string; amount: number }>, sel?: { invoiceIds: string[]; sourceIds: string[] }, extra: Record<string, unknown> = {}) => {
  const r = lese(cid);
  const s0 = sel ?? { invoiceIds: r.invoices.map((i) => i.id), sourceIds: r.sources.map((x) => x.id) };
  const hand = Object.fromEntries(amounts.map((a) => [key(a.sourceId, a.invoiceId), Math.round(a.amount * 1000)]));
  const pairs = sr.planSettlement(r.invoices, r.sources, { ...s0, amounts: hand });
  const fin = sr.finalizingInvoices(r.invoices, pairs).filter((i) => !i.finalized);
  return { customerId: cid, ...s0, amounts, expectedStamp: r.stamp, expectedTotal: pairs.reduce((a, p) => a + p.amountF, 0) / 1000,
    settlementDate: '2026-10-22', ...(fin.length ? { finalNumbers: Object.fromEntries(fin.map((i) => [i.id, 'normal'])) } : {}), ...extra };
};
const pdfHtml = (pid: string): string => {
  usePurchaseStore.getState().loadPurchases();
  const p = usePurchaseStore.getState().getPurchase(pid)!;
  return pdf.generatePurchasePdfHtml({ purchase: p, products: [], categories: [] } as never);
};
{
  // N1 — ohne von Hand gesetzte Beträge genau der bisherige Vorschlag (zwei Zeiger), 400 Zufallsfälle.
  const alt = (iv: Array<{ id: string; open: number }>, sv: Array<{ id: string; open: number }>) => {
    const a2 = iv.map((x) => ({ id: x.id, left: F(x.open) })).filter((x) => x.left > 5);
    const b2 = sv.map((x) => ({ id: x.id, left: F(x.open) })).filter((x) => x.left > 5);
    const out: string[] = []; let a = 0, b = 0;
    while (a < a2.length && b < b2.length) {
      const m = Math.min(a2[a].left, b2[b].left); out.push(`${b2[b].id}>${a2[a].id}:${m}`);
      a2[a].left -= m; b2[b].left -= m; if (a2[a].left <= 5) a++; if (b2[b].left <= 5) b++;
    }
    return out;
  };
  let gleich = 0; let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let t = 0; t < 400; t++) {
    const iv = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({ id: 'i' + i, number: 'I' + i, date: '2026-10-0' + (i + 1), total: 0, paid: 0, open: Math.round(rnd() * 900000) / 1000, finalized: false, revision: 0 }));
    const sv = Array.from({ length: 1 + Math.floor(rnd() * 4) }, (_, i) => ({ kind: 'PURCHASE' as const, id: 's' + i, number: 'S' + i, date: '2026-10-0' + (i + 1), label: '', total: 0, open: Math.round(rnd() * 900000) / 1000, revision: 0 }));
    const neu = sr.planSettlement(iv, sv, { invoiceIds: iv.map((x) => x.id), sourceIds: sv.map((x) => x.id) }).map((p) => `${p.sourceId}>${p.invoiceId}:${p.amountF}`);
    if (S(neu) === S(alt(iv, sv))) gleich++;
  }
  ok(gleich === 400, `N1 ohne „Change amount" exakt der bisherige FIFO-Vorschlag (${gleich}/400)`);

  // N2 — Obergrenzen je Zeile.
  const r = lese(K6);
  const rows0 = sr.planSettlementRows(r.invoices, r.sources, { invoiceIds: [J1, J2], sourceIds: [P6a, P6b] });
  ok(S(rows0.map((x) => [x.sourceId === P6a ? 'a' : 'b', x.invoiceId === J1 ? 1 : 2, x.amountF, x.maxF])) === S([['a', 1, 200000, 200000], ['b', 1, 50000, 50000], ['b', 2, 250000, 250000]]),
    `N2 Vorschlag J1←P6a 200, J1←P6b 50, J2←P6b 250 mit Obergrenzen (${S(rows0.map((x) => [x.amountF, x.maxF]))})`);
  // N3 — P6a→J1 auf 120, P6a→J2 auf 0: Rest J1 geht an P6b, P6a bleibt teilweise offen.
  const hand = { [key(P6a, J1)]: 120000, [key(P6a, J2)]: 0 };
  const rows1 = sr.planSettlementRows(r.invoices, r.sources, { invoiceIds: [J1, J2], sourceIds: [P6a, P6b], amounts: hand });
  ok(S(rows1.map((x) => [x.sourceId === P6a ? 'a' : 'b', x.invoiceId === J1 ? 1 : 2, x.amountF, x.maxF, x.edited])) ===
    S([['a', 1, 120000, 200000, true], ['b', 1, 130000, 130000, false], ['a', 2, 0, 80000, true], ['b', 2, 170000, 170000, false]]),
    `N3 sofort neu gerechnet: 120 / 130 (Rest J1 an P6b) / 0 (ausgelassen) / 170 (${S(rows1.map((x) => [x.amountF, x.maxF]))})`);
  ok(sr.planSettlement(r.invoices, r.sources, { invoiceIds: [J1, J2], sourceIds: [P6a, P6b], amounts: hand }).length === 3, 'N3 die 0-Zeile wird nicht gebucht');
}
marker('B23_AMOUNT_PLAN_PROVED');

// ── N4–N9 Serverprüfung: zu hoch, ungültig, alles 0, falsche Summe — nichts geändert ──
{
  const vorher = abdruck();
  const faelle: Array<[string, Record<string, unknown>, string]> = [
    ['über der Obergrenze (P6a→J1 201 > 200)', mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 201 }]), 'SETTLE_AMOUNT_TOO_HIGH'],
    ['über der Obergrenze nach früherer Zeile (P6b→J1 131 > 130)', mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 120 }, { invoiceId: J1, sourceId: P6b, amount: 131 }]), 'SETTLE_AMOUNT_TOO_HIGH'],
    ['vier Nachkommastellen', mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 10.0005 }]), 'SETTLE_AMOUNT_INVALID'],
    ['negativ', { ...mitBetraegen(K6, []), amounts: [{ invoiceId: J1, sourceId: P6a, amount: -1 }] }, 'SETTLE_AMOUNT_INVALID'],
    ['nicht gewählte Rechnung', mitBetraegen(K6, [{ invoiceId: J2, sourceId: P6a, amount: 10 }], { invoiceIds: [J1], sourceIds: [P6a, P6b] }), 'SETTLE_AMOUNT_INVALID'],
    ['doppelt', { ...mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 10 }]), amounts: [{ invoiceId: J1, sourceId: P6a, amount: 10 }, { invoiceId: J1, sourceId: P6a, amount: 10 }] }, 'SETTLE_AMOUNT_INVALID'],
    ['keine Liste', { ...mitBetraegen(K6, []), amounts: 'x' }, 'SETTLE_AMOUNT_INVALID'],
    ['Zuordnung, die der Vorschlag nicht hat', mitBetraegen(K6, [{ invoiceId: J2, sourceId: P6a, amount: 10 }], { invoiceIds: [J1, J2], sourceIds: [P6a] }), 'SETTLE_AMOUNT_INVALID'],
    // Jede mögliche Zuordnung auf 0 (sonst ginge der Rest der Reihe nach an die nächste — FIFO, siehe N3).
    ['alles 0', mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 0 }, { invoiceId: J1, sourceId: P6b, amount: 0 },
      { invoiceId: J2, sourceId: P6a, amount: 0 }, { invoiceId: J2, sourceId: P6b, amount: 0 }]), 'SETTLE_NOTHING_TO_OFFSET'],
    // Mit P6a→J1 = 120 geht der Rest per FIFO weiter (Summe bleibt 500) — die Maske hätte 500 gezeigt, nicht 499.
    ['Summe passt nicht', { ...mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 120 }]), expectedTotal: 499 }, 'SETTLE_TOTAL_CHANGED'],
  ];
  for (const [was, req, code] of faelle) {
    const o = await settle(req);
    ok(!o.ok && o.code === code, `N4 ${was} → ${code} (${o.ok ? 'gebucht!' : o.code})`);
  }
  ok(abdruck() === vorher, 'N4 kein Nein hat etwas geändert (Rechnungen, Zahlungen, Verrechnungen, Hauptbuch, Protokoll)');
  ok(/Einkäufe der ausdrücklich verknüpften/.test(src('src/core/offsets/party-settlement-reads.ts')), 'N4 Kopf der Leseschicht beschreibt die dritte Gruppe');
}
marker('B23_AMOUNT_SERVER_CHECKS_PROVED');

// ── N5–N8 Buchen mit Teilbeträgen (Primary), Ankaufbeleg, PC2 gleich, Undo ──
let STL6 = '';
{
  const geld0 = geldKonten(), vat0 = vatBal(), ap0 = apSupplier(sup6), ar0 = arCustomer(K6);
  const req = mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6a, amount: 120 }, { invoiceId: J2, sourceId: P6a, amount: 0 }]);
  ok(eq(Number(req.expectedTotal), 420), `N5 Summe 420 (120 + 130 + 170) (${req.expectedTotal})`);
  const o = await settle(req);
  ok(o.ok, `N5 gebucht (${S(o).slice(0, 140)})`);
  if (o.ok) STL6 = o.v.settlementNumber;
  ok(zeilen("SELECT ROUND(amount,3) FROM party_offsets WHERE settlement_number = ? ORDER BY offset_number", [STL6]) === S([[120], [130], [170]]),
    'N5 genau die gewählten Beträge, eine STL, FIFO-Reihenfolge');
  ok(eq(purOpen(P6a), 80) && String(pur(P6a)[0]) === 'PARTIALLY_PAID' && eq(purOpen(P6b), 0) && String(pur(P6b)[0]) === 'PAID',
    `N5 P6a teilweise verrechnet (Rest 80, Partially paid), P6b bezahlt (${purOpen(P6a)} ${pur(P6a)[0]} / ${purOpen(P6b)} ${pur(P6b)[0]})`);
  ok(status(J1) === 'FINAL' && eq(offen(J2), 230), `N5 J1 voll bezahlt, J2 Rest 230 (${status(J1)} ${offen(J2)})`);
  ok(geldKonten() === geld0 && vatBal() === vat0 && eq(ap0 - apSupplier(sup6), 420) && eq(ar0 - arCustomer(K6), 420), 'N5 kein Geld, keine Steuer; Soll AP Lieferant / Haben AR Kunde je 420');
  ok(ledgerBalanced() && cpDiff('apBySupplier', sup6) === 0 && cpDiff('arByCustomer', K6) === 0, 'N5 Hauptbuch und Abgleich je Gegenpartei stimmen');
  ok(n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'party_settlements' AND entity_id = ? AND new_value LIKE '%changedAmounts%'", [STL6]) === 1,
    'N5 Protokoll nennt die von Hand gesetzten Beträge');
  // Ankaufbeleg: verrechneter Betrag und Rest nachvollziehbar.
  const html = pdfHtml(P6a);
  ok(/Settled by offset \(no cash\)<\/span><span[^>]*>120\.000 BHD/.test(html) && /Remaining after offset \(Payable\)<\/span>\s*<span[^>]*>80\.000 BHD/.test(html)
    && /Partly settled by offset: 120\.000 BHD offset against the client's invoice\(s\), 80\.000 BHD still payable\./.test(html),
    'N6 Ankaufbeleg P6a: „Settled by offset 120.000", „Remaining after offset 80.000", Hinweis Teilverrechnung');
  ok(/Settled by offset STL-/.test(html) && /Offset · no cash/.test(html), 'N6 Ankaufbeleg: Zeile „Settled by offset STL-… — invoice …"');
  const html2 = pdfHtml(P6b);
  ok(!/Remaining after offset/.test(html2) && /<span>Settled<\/span>/.test(html2), 'N6 voll verrechneter Einkauf: „Settled", kein Rest');
  // Undo der Teil-STL: beide Seiten wieder ganz offen.
  const u = await undo({ settlementNumber: STL6, expectedActiveLines: 3 });
  ok(u.ok && eq(purOpen(P6a), 200) && eq(purOpen(P6b), 300) && String(pur(P6a)[0]) === 'UNPAID' && eq(offen(J1), 250) && eq(offen(J2), 400),
    `N7 Undo der Teilverrechnung: alles wieder offen (${purOpen(P6a)} ${purOpen(P6b)} ${offen(J1)} ${offen(J2)})`);
  ok(geldKonten() === geld0 && ledgerBalanced() && cpDiff('apBySupplier', sup6) === 0, 'N7 kein Geld, Abgleich stimmt');
}
marker('B23_AMOUNT_BOOKING_PROVED');

// ── N8 PC2: derselbe Auftrag mit Beträgen, Wiederholung wirkt einmal; Rumpf und Prüfung ──
{
  const req = mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6b, amount: 50.5 }], { invoiceIds: [J1], sourceIds: [P6b] });
  const body = st.settleBalanceBody(req as never);
  ok(S((body as { amounts?: unknown }).amounts) === S([{ invoiceId: J1, sourceId: P6b, amount: 50.5 }]), 'N8 PC2-Rumpf trägt die Beträge');
  const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };
  ok(/amounts: amount must be 0 or more/.test(meldung(() => pcmd.parseSettleBalance({ ...body, amounts: [{ invoiceId: J1, sourceId: P6b, amount: -2 }] })))
    && /unknown field: x/.test(meldung(() => pcmd.parseSettleBalance({ ...body, amounts: [{ invoiceId: J1, sourceId: P6b, amount: 1, x: 1 }] }))),
    'N8 PC2-Prüfung: negativer Betrag und fremdes Feld abgewiesen');
  const a = await fern(() => pcmd.runSettleBalance(deps() as never, identity('961', 'customers.settle_balance'), body));
  const b = await fern(() => pcmd.runSettleBalance(deps() as never, identity('961', 'customers.settle_balance'), body));
  ok(a.kind === 'ok' && b.kind === 'ok' && (b as { replayed?: boolean }).replayed === true, `N8 PC2 bucht, Wiederholung einmal (${a.kind}/${b.kind})`);
  ok(eq(purOpen(P6b), 249.5) && eq(offen(J1), 199.5) && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE payable_id = ? AND status = 'ACTIVE'", [P6b]) === 1,
    `N8 PC2 genau 50.500 verrechnet (${purOpen(P6b)} ${offen(J1)})`);
  const zuHoch = mitBetraegen(K6, [{ invoiceId: J1, sourceId: P6b, amount: 199.501 }], { invoiceIds: [J1], sourceIds: [P6b] });
  const c = await fern(() => pcmd.runSettleBalance(deps() as never, identity('962', 'customers.settle_balance'), st.settleBalanceBody(zuHoch as never)));
  ok(c.kind !== 'ok' && /SETTLE_AMOUNT_TOO_HIGH/.test(S(c)), `N8 PC2 über der Obergrenze → SETTLE_AMOUNT_TOO_HIGH (${S(c).slice(0, 120)})`);
  ok(ledgerBalanced() && cpDiff('apBySupplier', sup6) === 0 && cpDiff('arByCustomer', K6) === 0, 'N8 Abgleich stimmt');
}
marker('B23_AMOUNT_PC2_PROVED');

// ── N9 Maske: „Change amount" je Zeile, Obergrenze, sofort neu, Einstieg Einkauf nur dieser Einkauf ──
{
  const m = codeOf(src('src/components/parties/SettleBalanceModal.tsx'));
  ok(/data-settle-amount-edit/.test(m) && /data-settle-amount-input/.test(m) && /data-settle-pair-max/.test(m) && /data-settle-amount-reset/.test(m),
    'N9 jede Zeile: „Change amount", Eingabe mit Obergrenze, Reset');
  ok(/\^\\d\+\(\\\.\\d\{0,3\}\)\?\$/.test(m) && /f > maxF/.test(m), 'N9 Eingabe: BHD mit höchstens drei Nachkommastellen, nie über der Obergrenze');
  ok(/planSettlementRows\(data\.invoices, data\.sources, \{ invoiceIds: \[\.\.\.invSel\], sourceIds: \[\.\.\.srcSel\], amounts: hand \}\)/.test(m),
    'N9 dieselbe Rechnung wie das Haus (planSettlementRows mit den Beträgen)');
  ok(/focus\?\.sourceId \? data\.sources\.filter\(\(s\) => s\.id === focus\.sourceId\)/.test(m), 'N9 Einstieg vom Einkauf: nur dieser Einkauf vorgewählt');
  ok(/focus=\{\{ sourceId: purchase\.id \}\}/.test(src('src/pages/purchases/PurchaseDetail.tsx')), 'N9 PurchaseDetail öffnet mit genau diesem Einkauf');
}
marker('B23_AMOUNT_UI_PROVED');

console.log(`\nb23 purchase offset: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('B23_PURCHASE_OFFSET_PROVED');

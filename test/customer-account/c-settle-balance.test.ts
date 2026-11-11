// ════════════════════════════════════════════════════════════════════════════
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

// ══ P — Vorschlag: FIFO, Reihenfolge V7, Häkchen, nur freigegebene Arten ═════════════════════════════════════════
const cA = 'cust-3';
const I1 = verkauf(cA, 500, '2026-10-05');
const I2 = verkauf(cA, 800, '2026-10-06');
const I3 = verkauf(cA, 300, '2026-10-07');
const SC1 = guthaben(cA, 200, '2026-10-01');
const SC2 = guthaben(cA, 100, '2026-10-02');
const L1 = loan('we_borrow', 600, cA, '2026-09-10T09:00:00.000Z');
const L2 = loan('we_borrow', 1000, cA, '2026-09-20T09:00:00.000Z');
loan('we_lend', 400, cA, '2026-09-21T09:00:00.000Z');                   // We Lent: nie angeboten
// Lieferantenrolle mit einem offenen Einkauf: im Konto sichtbar, in Settle Balance NICHT angeboten.
const supA = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Kunde 3' } as never, { linkedCustomerId: cA } as never)).id;
const purA = imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: supA, purchaseDate: '2026-10-03',
  lines: [{ productId: neuerArtikel(), quantity: 1, unitPrice: 250, taxScheme: 'ZERO', vatRate: 0 }] } as never)).id;
reload();
{
  const r = lese(cA);
  ok(S(r.invoices.map((i) => i.id)) === S([I1, I2, I3]), 'P-1 links die offenen Rechnungen, älteste zuerst (die Guthaben-Rechnungen sind bezahlt)');
  // B2/B3 (Owner 10.11.2026) — seither ist der offene Einkauf der verknüpften Rolle die dritte Gruppe (Test: b23-purchase-offset).
  ok(S(r.sources.map((x) => x.id)) === S([SC1, SC2, L1, L2, purA]) && S(r.sources.map((x) => x.kind)) === S(['STORE_CREDIT', 'STORE_CREDIT', 'LOAN_BORROWED', 'LOAN_BORROWED', 'PURCHASE']),
    `P-2 rechts Store Credit vor We Borrowed vor Purchases, je älteste zuerst; We Lent fehlt (${S(r.sources.map((x) => x.number + ':' + x.open))})`);
  ok(konto(cA).docs.some((d) => d.key === `purchase:${purA}` && d.open > 0) && r.sources.some((x) => x.id === purA && x.kind === 'PURCHASE'),
    'P-3 der Einkauf der verknüpften Lieferantenrolle steht im Konto und wird seit B2/B3 als dritte Gruppe angeboten');
  const pairs = sr.planSettlement(r.invoices, r.sources, { invoiceIds: [I1, I2, I3], sourceIds: [SC1, SC2, L1, L2] });
  ok(S(pairs.map((p) => [p.invoiceId === I1 ? 'I1' : p.invoiceId === I2 ? 'I2' : 'I3', ({ [SC1]: 'SC1', [SC2]: 'SC2', [L1]: 'L1', [L2]: 'L2' } as Record<string, string>)[p.sourceId], p.amountF / 1000]))
    === S([['I1', 'SC1', 200], ['I1', 'SC2', 100], ['I1', 'L1', 200], ['I2', 'L1', 400], ['I2', 'L2', 400], ['I3', 'L2', 300]]),
  `P-4 FIFO paarweise: I1←SC1 200, SC2 100, L1 200; I2←L1 400, L2 400; I3←L2 300 (${S(pairs.map((p) => p.amountF))})`);
  const ab = sr.planSettlement(r.invoices, r.sources, { invoiceIds: [I1, I3], sourceIds: [SC1, L2] });
  ok(S(ab.map((p) => p.amountF / 1000)) === S([200, 300, 300]) && ab[2].invoiceId === I3,
    `P-5 Häkchen abgewählt (I2, SC2, L1): sofort neu — I1←SC1 200, I1←L2 300, I3←L2 300 (${S(ab.map((p) => p.amountF))})`);
  const fin = sr.finalizingInvoices(r.invoices, pairs);
  ok(S(fin.map((i) => i.id)) === S([I1, I2, I3]) && sr.finalizingInvoices(r.invoices, ab).map((i) => i.id).join() === [I1, I3].join(),
    'P-6 voll bezahlt werden genau die Rechnungen mit Rest 0 (nur für sie die Endnummernwahl)');
}

// ══ B — Buchen: eine STL, alle Zuordnungen, ohne Geld; Endnummern; Hauptbuch und Abstimmungen ════════════════════
{
  const vorGeld = geldKonten();
  const vorAbstand = abstaende(cA);
  const vorNet = konto(cA).net;
  const vorAbdruck = abdruck();
  const ohneWahl = await settle(alles(cA));
  ok(!ohneWahl.ok && ohneWahl.code === st.FINAL_NUMBER_CHOICE_REQUIRED && abdruck() === vorAbdruck,
    `B-1 drei Rechnungen werden voll bezahlt — ohne Endnummernwahl abgelehnt, nichts geändert (${ohneWahl.ok ? 'DURCH' : ohneWahl.code})`);
  const falscheSumme = await settle(alles(cA, { expectedTotal: 1599, finalNumbers: { [I1]: 'normal', [I2]: 'special', [I3]: 'normal' } }));
  ok(!falscheSumme.ok && falscheSumme.code === st.SETTLE_TOTAL_CHANGED && abdruck() === vorAbdruck, `B-2 andere Summe als gezeigt → abgelehnt, nichts geändert (${falscheSumme.ok ? '' : falscheSumme.code})`);
  const zukunft = await settle(alles(cA, { settlementDate: '2099-01-01', finalNumbers: { [I1]: 'normal', [I2]: 'special', [I3]: 'normal' } }));
  ok(!zukunft.ok && zukunft.code === 'OFFSET_DATE_INVALID' && abdruck() === vorAbdruck, `B-3 Tag in der Zukunft → abgelehnt (${zukunft.ok ? '' : zukunft.code})`);
  const zuFrueh = await settle(alles(cA, { settlementDate: '2026-10-06', finalNumbers: { [I1]: 'normal', [I2]: 'special', [I3]: 'normal' } }));
  ok(!zuFrueh.ok && zuFrueh.code === 'OFFSET_DATE_TOO_EARLY' && abdruck() === vorAbdruck, `B-4 Tag vor einer beteiligten Rechnung → abgelehnt (${zuFrueh.ok ? '' : zuFrueh.code})`);
  const sales = (() => { useAuthStore.setState({ session: { userId: 'user-s', branchId: 'branch-main', role: 'SALES' } as never }); return settle(alles(cA, { finalNumbers: { [I1]: 'normal', [I2]: 'special', [I3]: 'normal' } })); })();
  const sv = await sales;
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
  ok(!sv.ok && sv.code === 'PERMISSION_DENIED' && abdruck() === vorAbdruck && perms.roleMayRunOp('ACCOUNTANT', sr.OP_CUSTOMERS_SETTLE_BALANCE),
    `B-5 Recht wie „Record Payment": Sales nein (${sv.ok ? '' : sv.code}), Accountant/Admin ja`);

  const r = await settle(alles(cA, { finalNumbers: { [I1]: 'normal', [I2]: 'special', [I3]: 'normal' } }));
  ok(r.ok, `B-6 Confirm settlement gebucht (${r.ok ? r.v.settlementNumber : r.code})`);
  if (r.ok) {
    const stl = r.v.settlementNumber;
    const rows = DB.exec("SELECT offset_number, settlement_number, payable_type, amount, status FROM party_offsets WHERE settlement_number = ? ORDER BY offset_number", [stl])[0]?.values ?? [];
    ok(/^STL-\d{4}-\d{6}$/.test(stl) && rows.length === 6 && rows.every((x) => x[1] === stl && x[4] === 'ACTIVE')
      && S(rows.map((x) => x[0])) === S([1, 2, 3, 4, 5, 6].map((n) => `${stl}/${n}`)) && r.v.total === 1600,
    `B-7 EINE gemeinsame Nummer ${stl}, sechs Zuordnungen /1…/6, Summe 1.600 (${S(rows.map((x) => [x[0], x[2], x[3]]))})`);
    ok(S([status(I1), status(I2), status(I3)]) === S(['FINAL', 'FINAL', 'FINAL']) && /^INV-/.test(nummer(I1)) && /^SINV-/.test(nummer(I2)) && /^INV-/.test(nummer(I3)),
      `B-8 alle drei Paid mit Endnummer nach Wahl (I2 Special): ${nummer(I1)} · ${nummer(I2)} · ${nummer(I3)}`);
    ok(eq(Number(DB.exec('SELECT used_amount FROM customer_credits WHERE id = ?', [SC1])[0].values[0][0]), 200)
      && eq(Number(DB.exec('SELECT used_amount FROM customer_credits WHERE id = ?', [SC2])[0].values[0][0]), 100)
      && debtState(L1).open === 0 && eq(debtState(L2).open, 300) && debtState(L1).status.toUpperCase() !== 'OPEN',
    `B-9 Guthaben verbraucht, L1 getilgt, L2 Rest 300 (${S([debtState(L1), debtState(L2)])})`);
    ok(geldKonten() === vorGeld, `B-10 keine Kassen-, Bank-, Benefit- oder Kartenbewegung (${geldKonten()})`);
    ok(abstaende(cA) === vorAbstand && ledgerBalanced(), 'B-11 Hauptbuch ausgeglichen, beide Abstimmungen (je Konto und je Kunde) unverändert');
    ok(eq(konto(cA).net, vorNet), `B-12 Nettosaldo unverändert (${vorNet} → ${konto(cA).net}): beide Seiten sanken um 1.600`);
    ok(offen(I1) === 0 && kontoOffen(cA, `invoice:${I1}`) === 0 && eq(kontoOffen(cA, `debt:${L2}`), 300) && kontoOffen(cA, `credit:${SC1}`) === 0,
      'B-13 Receivables und Kundenkonto zeigen den neuen Stand (Rechnungen 0, L2 300, Guthaben 0)');
    const pays = DB.exec("SELECT method, notes FROM payments WHERE invoice_id = ? ORDER BY rowid", [I1])[0].values;
    ok(pays.length === 3 && S(pays.map((x) => x[0])) === S(['credit', 'credit', 'debt_offset']) && pays.every((x) => String(x[1]).includes(stl) && /no cash/.test(String(x[1]))),
      `B-14 auf der Rechnung je Zuordnung eine Zeile mit STL, Gegenbeleg, „no cash" (${S(pays)})`);
    const dp = DB.exec("SELECT source, notes FROM debt_payments WHERE debt_id = ?", [L2])[0].values;
    ok(dp.every((x) => x[0] === 'offset' && String(x[1]).includes(stl)), `B-15 am Darlehen die Rückzahlungszeilen mit STL-Nummer und Rechnung (${S(dp)})`);
    const ov = sr.settlementsOf(cA, 'branch-main').find((x) => x.number === stl)!;
    ok(ov && ov.status === 'ACTIVE' && ov.lines.length === 6 && ov.total === 1600 && !ov.single, 'B-16 Kundenkonto: Settlement-Übersicht mit allen sechs Zuordnungen');
    const ev = konto(cA).docs.find((d) => d.key === `credit:${SC1}`);
    ok(!!ev, 'B-17 Store Credit steht im Konto (verbraucht), Ereignis mit Rechnung');
    const offs = (await import('../../src/core/offsets/party-offset-reads.ts')).offsetsOfInvoice(I1, 'branch-main');
    ok(offs.length === 3 && offs.every((o) => o.settlementNumber === stl) && offs.filter((o) => o.payableType === 'STORE_CREDIT').length === 2 && offs.some((o) => /^loan /.test(o.sourceLabel)),
      `B-18 Rechnungsseite: drei Gegenbelege mit Art und STL (${S(offs.map((o) => [o.offsetNumber, o.sourceLabel]))})`);
    const doppelt = await settle(alles(cA));
    ok(!doppelt.ok && (doppelt.code === st.SETTLE_NOTHING_TO_OFFSET || doppelt.code === 'OPEN_ITEMS_CHANGED' || doppelt.code === st.SETTLE_SELECTION_INVALID),
      `B-19 zweiter Klick: nichts mehr zu verrechnen, kein doppelter Verbrauch (${doppelt.ok ? 'DURCH' : doppelt.code})`);

    // ── U — Rückgängig: eine Zuordnung auf der Rechnung, dann die ganze STL ─────────────────────────────────────
    const einzel = offs.find((o) => o.payableType === 'STORE_CREDIT')!;
    const vorU = abstaende(cA);
    const u1 = await (await import('../../src/core/offsets/party-offsets.ts')).reverseDebtOffsetOnPrimary(einzel.offsetId, 'offset removed').then(() => '', (e: { code?: string }) => String(e.code ?? e));
    reload();
    ok(u1 === '' && status(I1) === 'PARTIAL' && nummer(I1).startsWith('INV-') && eq(offen(I1), einzel.amount)
      && eq(Number(DB.exec('SELECT used_amount FROM customer_credits WHERE id = ?', [einzel.debtId])[0].values[0][0]), 0),
    `U-1 eine Zuordnung entfernt: Rechnung wieder offen ${einzel.amount} (Endnummer bleibt ${nummer(I1)}), Guthaben wieder frei (${u1 || 'ok'})`);
    ok(abstaende(cA) === vorU && geldKonten() === vorGeld && ledgerBalanced(), 'U-2 Gegenbuchung ohne Geld, Abstimmungen unverändert');
    const ov2 = sr.settlementsOf(cA, 'branch-main').find((x) => x.number === stl)!;
    ok(ov2.status === 'PARTIAL' && ov2.activeLines === 5, `U-3 die STL ist teilweise aufgehoben (${ov2.status}, ${ov2.activeLines} wirksam)`);
    const veraltet = await undo({ settlementNumber: stl, expectedActiveLines: 6 });
    ok(!veraltet.ok && veraltet.code === 'RECORD_CHANGED', `U-4 ganze STL mit veraltetem Stand → abgelehnt (${veraltet.ok ? '' : veraltet.code})`);
    // VAT-Sperre: I3 ist FINAL im laufenden Quartal → mit eingereichtem Quartal keine Aufhebung, nichts geändert.
    const q = Math.floor(new Date().getMonth() / 3) + 1;
    insert(DB, 'vat_filings', { id: 'vf-c', branch_id: 'branch-main', year: new Date().getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
    const vAb = abdruck();
    const gesperrt = await undo({ settlementNumber: stl, expectedActiveLines: 5 });
    ok(!gesperrt.ok && /VAT_PERIOD_FILED|filed|quarter/i.test(gesperrt.code) && abdruck() === vAb, `U-5 eingereichtes VAT-Quartal: ganze STL nicht aufhebbar, nichts geändert (${gesperrt.ok ? 'DURCH' : gesperrt.code})`);
    DB.run("DELETE FROM vat_filings WHERE id = 'vf-c'");
    const ganz = await undo({ settlementNumber: stl, expectedActiveLines: 5, reason: 'test undo' });
    reload();
    ok(ganz.ok && ganz.v.reversedLines === 5 && sr.settlementsOf(cA, 'branch-main').find((x) => x.number === stl)!.status === 'REVERSED',
      `U-6 ganze STL rückgängig: fünf Zuordnungen in einem Zug (${ganz.ok ? S(ganz.v) : ganz.code})`);
    ok(S([status(I1), status(I2), status(I3)]) === S(['PARTIAL', 'PARTIAL', 'PARTIAL']) && /^SINV-/.test(nummer(I2))
      && eq(offen(I1), 500) && eq(offen(I2), 800) && eq(offen(I3), 300) && eq(debtState(L1).open, 600) && eq(debtState(L2).open, 1000)
      && eq(Number(DB.exec('SELECT used_amount FROM customer_credits WHERE id = ?', [SC2])[0].values[0][0]), 0),
    'U-7 alles wieder offen wie vorher — Endnummern bleiben (keine zweite), Guthaben und Darlehen ganz offen');
    ok(abstaende(cA) === vorAbstand && geldKonten() === vorGeld && ledgerBalanced() && eq(konto(cA).net, vorNet), 'U-8 Hauptbuch, Abstimmungen, Geld, Nettosaldo wie vor der Verrechnung');
    const nochmal = await undo({ settlementNumber: stl });
    ok(!nochmal.ok && nochmal.code === st.SETTLEMENT_ALREADY_REVERSED, `U-9 schon aufgehoben → abgelehnt (${nochmal.ok ? '' : nochmal.code})`);
    // Neu verrechnen geht wieder — dieselben Endnummern.
    const r2 = await settle(alles(cA));
    ok(r2.ok && nummer(I2).startsWith('SINV-') && S([status(I1), status(I2), status(I3)]) === S(['FINAL', 'FINAL', 'FINAL']),
      `U-10 erneut verrechnet ohne neue Wahl (Endnummern stehen schon): ${r2.ok ? r2.v.settlementNumber : r2.code}`);
  }
}

// ══ T — Teilverrechnung, Stand veraltet, Kunde/Filiale, Auswahl fremder Posten ═══════════════════════════════════
{
  const cB = 'cust-4';
  const J1 = verkauf(cB, 1000, '2026-10-05');
  const LB = loan('we_borrow', 400, cB, '2026-09-10T09:00:00.000Z');
  const r = lese(cB);
  const req = alles(cB);
  const vor = abdruck();
  imHaus(() => useInvoiceStore.getState().recordPayment(J1, 50, 'cash'));
  reload();
  const alt = await settle(req);
  ok(!alt.ok && alt.code === 'OPEN_ITEMS_CHANGED', `T-1 eine Zahlung dazwischen: Stand veraltet → abgelehnt, neu vorschlagen (${alt.ok ? '' : alt.code})`);
  void vor;
  const t = await settle(alles(cB));
  ok(t.ok && status(J1) === 'PARTIAL' && eq(offen(J1), 550) && debtState(LB).open === 0,
    `T-2 Teilverrechnung: Rechnung bleibt Partially Paid (offen 550), Darlehen getilgt (${t.ok ? t.v.total : t.code})`);
  const fremd = loan('we_borrow', 300, 'cust-5', '2026-09-10T09:00:00.000Z');
  const L5 = { ...alles(cB), sourceIds: [fremd] };
  const f = await settle(L5);
  ok(!f.ok && f.code === st.SETTLE_SELECTION_INVALID, `T-3 Darlehen eines anderen Kunden gewählt → abgelehnt (${f.ok ? '' : f.code})`);
  const p = await settle({ ...alles(cB), sourceIds: [purA] });
  ok(!p.ok && p.code === st.SETTLE_SELECTION_INVALID, `T-4 ein Einkauf als Gegenposten → abgelehnt, nicht freigegeben (${p.ok ? '' : p.code})`);
  const filiale = await settle({ ...alles(cB), customerId: 'cust-14' });
  ok(!filiale.ok && filiale.code === 'CUSTOMER_NOT_FOUND', `T-5 Kunde einer anderen Filiale → abgelehnt (${filiale.ok ? '' : filiale.code})`);
  // Ein Darlehen ohne Kundenzuordnung wird nicht angeboten.
  DB.run("UPDATE debts SET customer_id = NULL WHERE id = ?", [loan('we_borrow', 200, cB, '2026-09-11T09:00:00.000Z')]);
  ok(!lese(cB).sources.some((x) => x.kind === 'LOAN_BORROWED' && x.open === 200), 'T-6 Darlehen ohne Kundenzuordnung: nicht angeboten');
  void r;
}

// ══ V — VAT-Periodensperre beim Buchen: alles oder nichts ═════════════════════════════════════════════════════════
{
  const cC = 'cust-6';
  verkauf(cC, 200, '2026-10-05');
  verkauf(cC, 300, '2026-10-06');
  loan('we_borrow', 1000, cC, '2026-09-10T09:00:00.000Z');
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  insert(DB, 'vat_filings', { id: 'vf-v', branch_id: 'branch-main', year: new Date().getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
  const req = alles(cC, { finalNumbers: Object.fromEntries(lese(cC).invoices.map((i) => [i.id, 'normal'])) });
  const vor = abdruck();
  const v = await settle(req);
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-v'");
  ok(!v.ok && abdruck() === vor, `V-1 die zweite Rechnung würde in ein eingereichtes Quartal fallen → NICHTS gebucht, auch nicht die erste (${v.ok ? 'DURCH' : v.code})`);
}

// ══ S — Storno einer verrechneten Rechnung; spätere Rückgabe schützt vor doppelter Erstattung ═══════════════════
{
  const cD = 'cust-7';
  const K1 = verkauf(cD, 900, '2026-10-05');
  const SCd = guthaben(cD, 100, '2026-10-01');
  const LD = loan('we_borrow', 500, cD, '2026-09-10T09:00:00.000Z');
  const vorGeld = geldKonten();
  const vorAbstand = abstaende(cD);
  const r = await settle(alles(cD));
  ok(r.ok && status(K1) === 'PARTIAL', 'S-1 verrechnet (Store Credit 100 + Darlehen 500), Rechnung teilweise offen 300');
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: K1, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  ok(status(K1) === 'CANCELLED' && eq(Number(DB.exec('SELECT used_amount FROM customer_credits WHERE id = ?', [SCd])[0].values[0][0]), 0) && eq(debtState(LD).open, 500),
    `S-2 Storno: Guthaben und Darlehen wieder ganz offen (${S([debtState(LD)])})`);
  ok(geldKonten() === vorGeld, `S-3 kein Bargeld-Refund für die Verrechnung (${geldKonten()} vs ${vorGeld})`);
  ok(abstaende(cD) === vorAbstand && ledgerBalanced(), 'S-4 Hauptbuch und Abstimmungen wie vorher');
  ok(sr.settlementsOf(cD, 'branch-main')[0].status === 'REVERSED', 'S-5 die STL steht auf REVERSED (Grund: invoice cancelled)');

  // Spätere Rückgabe: verrechnet, dann Rückgabe mit Gutschrift → Aufheben gesperrt (keine doppelte Erstattung).
  const K2 = verkauf(cD, 400, '2026-10-07');
  const r2 = await settle(alles(cD, { finalNumbers: { [K2]: 'normal' } }));
  ok(r2.ok, 'S-6 zweite Verrechnung');
  imHaus(() => {
    const sx = useSalesReturnStore.getState();
    sx.loadReturns();
    const l = DB.exec('SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE invoice_id = ?', [K2])[0].values[0];
    const a = returnLineAmounts({ quantity: Number(l[2]), lineTotal: Number(l[3]), vatAmount: Number(l[4]) }, Number(l[2]));
    const rid = sx.createReturn({ invoiceId: K2, refundMethod: 'cash', productDisposition: 'IN_STOCK', lines: [{ invoiceLineId: String(l[0]), productId: String(l[1]), quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount }] } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
  });
  reload();
  const vor = abdruck();
  const g = r2.ok ? await undo({ settlementNumber: r2.v.settlementNumber }) : { ok: false as const, code: 'x' };
  ok(!g.ok && g.code === st.OFFSET_HAS_LATER_RETURN && abdruck() === vor, `S-7 Rückgabe nach der Verrechnung: Aufheben gesperrt, nichts geändert (${g.ok ? 'DURCH' : g.code})`);
  void useCreditNoteStore;
}

// ══ R — PC2: dieselbe Hausfolge, Wiederholung wirkt einmal, konkurrierende Änderung ═════════════════════════════
{
  const cE = 'cust-8';
  const M1 = verkauf(cE, 600, '2026-10-05');
  const M2 = verkauf(cE, 200, '2026-10-06');
  guthaben(cE, 150, '2026-10-01');
  loan('we_borrow', 1000, cE, '2026-09-10T09:00:00.000Z');
  const body = st.settleBalanceBody(alles(cE, { finalNumbers: { [M1]: 'special', [M2]: 'normal' } }) as never);
  const vorGeld = geldKonten();
  const vorAbstand = abstaende(cE);
  const a = await fern(() => pcmd.runSettleBalance(deps() as never, identity('701', sr.OP_CUSTOMERS_SETTLE_BALANCE), body));
  reload();
  const stlE = String((a.value as { settlementNumber?: string } | undefined)?.settlementNumber ?? '');
  ok(a.kind === 'ok' && /^STL-/.test(stlE) && status(M1) === 'FINAL' && /^SINV-/.test(nummer(M1)) && status(M2) === 'FINAL', `R-1 PC2 verrechnet am Primary (${S({ kind: a.kind, code: a.code, stlE })})`);
  const vor = abdruck();
  const b = await fern(() => pcmd.runSettleBalance(deps() as never, identity('701', sr.OP_CUSTOMERS_SETTLE_BALANCE), body));
  ok(b.kind === 'ok' && b.replayed === true && abdruck() === vor, `R-2 dieselbe Kennung noch einmal: Antwort wiederholt, nichts doppelt (${S({ kind: b.kind, replayed: b.replayed })})`);
  const c = await fern(() => pcmd.runSettleBalance(deps() as never, identity('702', sr.OP_CUSTOMERS_SETTLE_BALANCE), body));
  ok(c.kind === 'rejected' && c.code === 'OPEN_ITEMS_CHANGED' && abdruck() === vor, `R-3 zweiter Rechner mit demselben Stand: abgelehnt (${S({ kind: c.kind, code: c.code })})`);
  ok(geldKonten() === vorGeld && abstaende(cE) === vorAbstand && ledgerBalanced(), 'R-4 PC2: ohne Geld, Hauptbuch und Abstimmungen in Ordnung');
  const fremdFeld = await fern(() => pcmd.runSettleBalance(deps() as never, identity('703', sr.OP_CUSTOMERS_SETTLE_BALANCE), { ...body, amount: 5 }));
  ok(fremdFeld.kind !== 'ok', `R-5 ein fremdes Feld im Rumpf wird abgelehnt (${S({ kind: fremdFeld.kind, code: fremdFeld.code, t: fremdFeld.thrown })})`);
  const u = await fern(() => pcmd.runSettlementReverse(deps() as never, identity('704', sr.OP_CUSTOMERS_SETTLEMENT_REVERSE), st.settlementReverseBody({ settlementNumber: stlE, expectedActiveLines: 3 })));
  reload();
  ok(u.kind === 'ok' && status(M1) === 'PARTIAL' && /^SINV-/.test(nummer(M1)) && abstaende(cE) === vorAbstand && geldKonten() === vorGeld,
    `R-6 PC2 hebt die ganze STL auf (Endnummer bleibt) (${S({ kind: u.kind, code: u.code })})`);
  const w = await fern(() => pcmd.runSettlementReverse(deps() as never, identity('704', sr.OP_CUSTOMERS_SETTLEMENT_REVERSE), st.settlementReverseBody({ settlementNumber: stlE, expectedActiveLines: 3 })));
  ok(w.kind === 'ok' && w.replayed === true, `R-7 Wiederholung der Aufhebung wirkt einmal (${S({ kind: w.kind, replayed: w.replayed })})`);
  ok(perms.permissionForOp(sr.OP_CUSTOMERS_SETTLE_BALANCE)?.kind === 'permissionOrAdmin' && perms.permissionForOp(sr.OP_CUSTOMERS_SETTLEMENT_REVERSE)?.kind === 'permissionOrAdmin',
    'R-8 Rechte am PC2 wie „Record Payment" (payments.* oder Admin/Manager)');
}

// ══ E — B1 bleibt: Einzelverrechnung auf der Rechnung, eigene Nummer, als Einzelposten in der Übersicht ═════════════
{
  const cF = 'cust-9';
  const N1 = verkauf(cF, 700, '2026-10-05');
  const LF = loan('we_borrow', 500, cF, '2026-09-10T09:00:00.000Z');
  const b1 = create({ invoiceId: N1, debtId: LF, amount: 300 });
  ok(/^STL-\d{4}-\d{6}$/.test(b1.offsetNumber) && status(N1) === 'PARTIAL' && eq(debtState(LF).open, 200), `E-1 B1 unverändert: eigene Nummer ${b1.offsetNumber}, Teilverrechnung`);
  const ov = sr.settlementsOf(cF, 'branch-main');
  ok(ov.length === 1 && ov[0].single && ov[0].number === b1.offsetNumber, 'E-2 in der Übersicht als Einzelverrechnung');
  const u = await undo({ settlementNumber: b1.offsetNumber });
  reload();
  ok(u.ok && status(N1) === 'PARTIAL' && eq(Number(inv(N1)[1]), 0) && eq(debtState(LF).open, 500), `E-3 auch sie aus dem Konto aufhebbar (${u.ok ? '' : u.code})`);
}

// ══ Q — Quelltext: Sync-Feld, Befehle registriert, keine Einkaufs-/Kommissionsart ═══════════════════════════════
{
  const m = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_fields: string[] }> };
  ok(m.tables.party_offsets.allowed_fields.includes('settlement_number'), 'Q-1 Sync-Manifest kennt settlement_number');
  const reg = src('src/core/bridge/command-registry.ts');
  ok(reg.includes("'customers.settle_balance', 'customers.settlement_reverse',") && src('src-tauri/src/bridge.rs').includes('OP_CUSTOMERS_SETTLE_BALANCE,'),
    'Q-2 beide Befehle namentlich freigegeben (TS und Rust)');
  ok(S(sr.SETTLE_SOURCE_ORDER) === S(['STORE_CREDIT', 'LOAN_BORROWED', 'PURCHASE', 'PARTNER_ITEM']), 'Q-3 Store Credit, We Borrowed, seit B2/B3 Einkäufe, seit S4 auszahlbare Partnerguthaben (Anzahlung, Eröffnung, Gold nicht)');
}

void [loadDebtPaymentsFor, payS, banking, analytics, backfill, executeCommand, lc, fc, money, po, geld, stand, sale, gap, TODAY, invRev, HCTX, readFileSync, existsSync, zeilen, wirft, n];
console.log(`\nC settle balance: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

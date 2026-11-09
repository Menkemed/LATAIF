// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — Verkaufsrechnung ↔ Darlehen „We Borrowed" verrechnen (ohne Geld): zentrale Hausfolge
// (`party-offsets.ts`), Buchung Soll LOAN_PAYABLE / Haben AR über den vorhandenen Zahlungsweg, Verbindung in
// `party_offsets`, Schutz (Kunde, Filiale, Beträge, Fassungen, Tag, VAT, Rechte über die Zahlungs-Operation),
// PC2 über `invoices.record_payment` (Transaktion + Wiederholungsschutz), Aufheben/Storno/Löschen/Korrektur-Sperren,
// keine Kassen-/Bankbewegung, gleiche Anzeigen in Kundenkonto, Rechnung, Darlehen, Analytics, Banking, Abstimmung.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/a2-links.test.ts.
// Run: node test/customer-account/b1-offset.test.ts
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

// ── Welt ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const A = sale('pk1', 1000, '2026-10-20');
const L1 = loan('we_borrow', 600, 'cust-1', '2026-10-16T09:00:00.000Z');
const L2 = loan('we_borrow', 800, 'cust-1', '2026-10-18T09:00:00.000Z');
const L3 = loan('we_borrow', 500, 'cust-2', '2026-10-16T09:00:00.000Z');
const L4 = loan('we_lend', 300, 'cust-1', '2026-10-16T09:00:00.000Z');
insert(DB, 'debts', { id: 'd-b2', branch_id: 'branch-2', loan_number: 'LOA-B2', direction: 'we_borrow', counterparty: 'Ahmed Karimi', customer_id: 'cust-1',
  amount: 900, source: 'cash', status: 'OPEN', revision: 1, created_at: '2026-10-16T09:00:00.000Z', updated_at: NOW });
insert(DB, 'debts', { id: 'd-none', branch_id: 'branch-main', loan_number: 'LOA-NONE', direction: 'we_borrow', counterparty: 'Ahmed Karimi', customer_id: null,
  amount: 100, source: 'cash', status: 'OPEN', revision: 1, created_at: '2026-10-16T09:00:00.000Z', updated_at: NOW });
reload();
const loanNr = (id: string): string => s(DB, 'SELECT loan_number FROM debts WHERE id = ?', [id]);

// ══ K — Kandidaten (nur dieser Kunde, diese Filiale, „We Borrowed", offen; älteste zuerst) ══════════════════════════
{
  const c = po.debtOffsetCandidatesFor(CTX, A);
  ok(S(c.candidates.map((x) => x.debtId)) === S([L1, L2]) && eq(c.invoiceOpen, 1000) && eq(c.suggested, 600),
    `K-1 Kandidaten = L1, L2 (älteste zuerst), Vorschlag 600 (${S(c.candidates.map((x) => x.loanNumber))} ${c.suggested})`);
  ok(!c.candidates.some((x) => [L3, L4, 'd-b2', 'd-none'].includes(x.debtId)), 'K-2 fremder Kunde, „We Lent", andere Filiale, ohne Kunde: nie angeboten');
}

// ══ R — Ablehnungen: nichts geschrieben ════════════════════════════════════════════════════════════════════════════
{
  const vorher = stand();
  const geldVor = geld();
  const nein = (input: Record<string, unknown>): string => wirft(() => create({ invoiceId: A, debtId: L1, amount: 100, ...input }));
  ok(nein({ debtId: L3 }) === 'OFFSET_CUSTOMER_MISMATCH', 'R-1 Darlehen eines anderen Kunden abgelehnt');
  ok(nein({ debtId: 'd-none' }) === 'OFFSET_CUSTOMER_MISMATCH', 'R-2 Darlehen ohne Kunde abgelehnt (erst zuordnen)');
  ok(nein({ debtId: L4 }) === 'OFFSET_NOT_WE_BORROWED', 'R-3 „We Lent" abgelehnt');
  ok(nein({ debtId: 'd-b2' }) === 'OFFSET_DEBT_NOT_FOUND', 'R-4 Darlehen einer anderen Filiale abgelehnt');
  ok(wirft(() => imHaus(() => po.createDebtOffsetInHouse({ invoiceId: A, debtId: L1, amount: 100 } as never, { branchId: 'branch-2' }))) === 'BRANCH_MISMATCH',
    'R-5 eine Filiale, deren Bücher hier nicht liegen, wird abgelehnt');
  ok(nein({ amount: 1000.001 }) === 'OFFSET_EXCEEDS_INVOICE', 'R-6 mehr als der Rechnungsrest abgelehnt');
  ok(nein({ amount: 600.001 }) === 'OFFSET_EXCEEDS_DEBT', 'R-7 mehr als der Darlehensrest abgelehnt');
  ok(nein({ amount: 0 }) === 'OFFSET_AMOUNT_INVALID' && nein({ amount: 10.0005 }) === 'OFFSET_AMOUNT_INVALID' && nein({ amount: -5 }) === 'OFFSET_AMOUNT_INVALID',
    'R-8 Betrag 0, negativ, mehr als 3 Nachkommastellen abgelehnt');
  ok(nein({ offsetDate: '2026-10-14' }) === 'OFFSET_DATE_TOO_EARLY', 'R-9 vor Rechnung/Darlehen/Eröffnungsstichtag abgelehnt');
  ok(nein({ offsetDate: '2099-01-01' }) === 'OFFSET_DATE_INVALID', 'R-10 Zukunftsdatum abgelehnt');
  ok(nein({ expectedInvoiceRevision: invRev(A) + 5 }) === 'RECORD_CHANGED', 'R-11 veraltete Fassung der Rechnung abgelehnt');
  ok(nein({ expectedDebtRevision: debtState(L1).revision + 5 }) === 'RECORD_CHANGED', 'R-12 veraltete Fassung des Darlehens abgelehnt');
  ok(nein({ invoiceId: 'nope' }) === 'INVOICE_NOT_FOUND', 'R-13 unbekannte Rechnung abgelehnt');
  ok(stand() === vorher && geld() === geldVor, 'R-14 nach allen Ablehnungen: Rechnungen, Zahlungen, Darlehen, Verrechnungen, Hauptbuch, Geld unverändert');
  // VAT: ein eingereichtes Quartal (das laufende, hier künstlich) — eine Verrechnung, die eine Rechnung HEUTE abschließt,
  // fügte sie dem gemeldeten Quartal hinzu: dieselbe Regel wie jede Zahlung.
  const B0 = sale('pk3', 200, '2026-10-20');
  const vorVat = stand();
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  insert(DB, 'vat_filings', { id: 'vf-test', branch_id: 'branch-main', year: new Date().getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
  const vatClose = wirft(() => create({ invoiceId: B0, debtId: L2, amount: 200 }));
  const nachVat = stand();
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-test'");
  ok(vatClose === 'VAT_PERIOD_FILED' && nachVat === vorVat, `R-15 eingereichtes Quartal: schließende Verrechnung abgelehnt, nichts geschrieben (${vatClose})`);
  imHaus(() => useInvoiceStore.getState().deleteInvoice(B0));
  reload();
  ok(debtState(L1).open === 600 && debtState(L2).open === 800 && eq(Number(inv(A)[1]), 0), 'R-16 Rechnung und Darlehen unverändert offen');
}

// ══ T — Teilverrechnung am Primary: Rechnung A (1.000) mit L1 (600) ═════════════════════════════════════════════════
const geld0 = geld();
const lp0 = bal('LOAN_PAYABLE');
const ar0 = bal('ACCOUNTS_RECEIVABLE');
const fin0 = analytics.financeFor(CTX as never) as Record<string, number>;
const acc0 = ca.customerAccountFor(CTX, 'cust-1');
const gapAr0 = gap('ACCOUNTS_RECEIVABLE');
const gapLp0 = gap('LOAN_PAYABLE');
const T = create({ invoiceId: A, debtId: L1, amount: 600, expectedInvoiceRevision: invRev(A), expectedDebtRevision: debtState(L1).revision });
reload();
{
  ok(/^STL-\d{4}-\d{6}$/.test(T.offsetNumber) && T.invoiceStatus === 'PARTIAL' && eq(T.invoiceOpen, 400) && T.debtStatus === 'REPAID' && eq(T.debtOpen, 0),
    `T-1 Teilverrechnung: ${T.offsetNumber}, Rechnung PARTIAL Rest 400, Darlehen REPAID (${S([T.invoiceStatus, T.invoiceOpen, T.debtStatus])})`);
  const pay = DB.exec('SELECT method, amount, notes FROM payments WHERE id = ?', [T.paymentId])[0].values[0];
  ok(pay[0] === 'debt_offset' && eq(Number(pay[1]), 600) && String(pay[2]).includes(T.offsetNumber) && String(pay[2]).includes(loanNr(L1)) && String(pay[2]).includes('no cash'),
    `T-2 Rechnungszahlung 'debt_offset' 600 nennt ${T.offsetNumber}, das Darlehen und „no cash" (${String(pay[2])})`);
  const dp = DB.exec('SELECT source, amount, notes FROM debt_payments WHERE id = ?', [T.debtPaymentId])[0].values[0];
  ok(dp[0] === 'offset' && eq(Number(dp[1]), 600) && String(dp[2]).includes(T.offsetNumber) && String(dp[2]).includes(T.invoiceNumber) && String(dp[2]).includes('no cash'),
    `T-3 Darlehens-Rückzahlung (Quelle offset) nennt ${T.offsetNumber}, die Rechnung und „no cash" (${String(dp[2])})`);
  const legs = DB.exec("SELECT account, direction, amount FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ? ORDER BY account", [T.paymentId])[0]?.values ?? [];
  ok(S(legs) === S([['ACCOUNTS_RECEIVABLE', 'CREDIT', 600], ['LOAN_PAYABLE', 'DEBIT', 600]]),
    `T-4 Buchung genau Soll LOAN_PAYABLE 600 / Haben AR 600 (${S(legs)})`);
  ok(geld() === geld0 && eq(bal('LOAN_PAYABLE'), lp0 + 600) && eq(bal('ACCOUNTS_RECEIVABLE'), ar0 - 600) && ledgerBalanced(),
    'T-5 Kasse/Bank/Benefit/Karte unverändert; Darlehensschuld −600, Forderung −600; Hauptbuch ausgeglichen');
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'LOAN_PAYMENT'") === 0, 'T-6 die Darlehenszeile bucht NICHT selbst (keine Doppelbuchung)');
  const o = DB.exec('SELECT status, customer_id, receivable_id, receivable_payment_id, payable_id, payable_payment_id, amount, offset_date FROM party_offsets WHERE id = ?', [T.offsetId])[0].values[0];
  ok(S(o) === S(['ACTIVE', 'cust-1', A, T.paymentId, L1, T.debtPaymentId, 600, TODAY]), `T-7 party_offsets verbindet beide Zeilen dauerhaft (${S(o)})`);
  ok(n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'party_offsets' AND entity_id = ? AND action_type = 'CREATE' AND new_value LIKE '%DR LOAN_PAYABLE / CR ACCOUNTS_RECEIVABLE%'", [T.offsetId]) === 1,
    'T-8 Protokoll: CREATE');
  ok(n(DB, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'party_offsets' AND record_id = ?", [T.offsetId]) >= 1
    && n(DB, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'debt_payments' AND record_id = ?", [T.debtPaymentId]) >= 1,
    'T-9 Verrechnung und Darlehenszeile reisen im Abgleich');
  const c = po.debtOffsetCandidatesFor(CTX, A);
  ok(S(c.candidates.map((x) => x.debtId)) === S([L2]) && eq(c.suggested, 400), `T-10 danach nur noch L2, Vorschlag 400 (${c.suggested})`);
  // Anzeigen: Kundenkonto, Receivables, Payables, Banking, Analytics, Abstimmung, Darlehen.
  const acc1 = ca.customerAccountFor(CTX, 'cust-1');
  const invDoc = acc1.docs.find((d) => d.key.endsWith(A));
  ok(invDoc && eq(invDoc.open, 400) && eq(acc1.docs.find((d) => d.key === `debt:${L1}`)?.open ?? 0, 0) && eq(acc1.net, acc0.net)
    && eq(acc1.owesUs.total, acc0.owesUs.total - 600) && eq(acc1.weOwe.total, acc0.weOwe.total - 600),
    `T-11 Kundenkonto: Rechnung Rest 400, L1 erledigt, Netto unverändert (${acc0.net} → ${acc1.net})`);
  ok(acc1.statement.some((r) => /Offset STL-/.test(S(r)) && /no cash/.test(S(r))), 'T-12 Kontoauszug zeigt die Verrechnung mit Gegenbeleg und „no cash"');
  ok(eq(recv.receivablesBreakdown('branch-main').filter((r) => r.sourceId === A).reduce((t, r) => t + F(r.open), 0) / 1000, 400), 'T-13 Receivables: Rechnung A offen 400');
  ok(!payS.loadPayablesFor(CTX as never).payables.some((x) => x.id === L1 || x.id === `loan-${L1}` || String(x.id).includes(L1)), 'T-14 Payables: L1 nicht mehr offen');
  const tx = banking.loadBankingFor(CTX as never).transactions;
  ok(!tx.some((t) => t.id.includes(T.paymentId) || t.id.includes(T.debtPaymentId)), 'T-15 Banking: weder Rechnungs- noch Darlehenszeile der Verrechnung');
  const fin1 = analytics.financeFor(CTX as never) as Record<string, number>;
  const k = ['cashReceived', 'bankReceived', 'cardReceived', 'benefitReceived', 'otherReceived', 'debtRepaidByUsCash', 'debtRepaidByUsBank'];
  ok(S(k.map((x) => F(Number(fin1?.[x] ?? 0)))) === S(k.map((x) => F(Number(fin0?.[x] ?? 0)))), `T-16 Analytics: kein Geldeingang, keine Darlehensrückzahlung in Kasse/Bank (${S(k.map((x) => fin1?.[x]))})`);
  ok(eq(gap('ACCOUNTS_RECEIVABLE'), gapAr0) && eq(gap('LOAN_PAYABLE'), gapLp0) && eq(gapAr0, 0),
    `T-17 Abstimmung: AR stimmt, der Abstand Loan Payable bleibt (nur das Test-Darlehen ohne Buchung) (${gapAr0} / ${gapLp0} → ${gap('ACCOUNTS_RECEIVABLE')} / ${gap('LOAN_PAYABLE')})`);
  const dps = loadDebtPaymentsFor(CTX as never, L1).payments;
  ok(dps.length === 1 && String(dps[0].source) === 'offset' && String(dps[0].notes).includes(T.offsetNumber), 'T-18 Darlehensseite zeigt die Verrechnung mit Gegenbeleg');
  const bf = backfill.backfillDebtPayments('branch-main');
  ok(bf.total === 0 && n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'LOAN_PAYMENT'") === 0, `T-19 Nachbuchung lässt Verrechnungszeilen aus (${bf.total})`);
}

// ══ P — PC2: schon teilbezahlte Rechnung B mit teilweise zurückgezahltem L2, Endnummer, Wiederholung, Gleichzeitigkeit ═
const B = sale('pk2', 500, '2026-10-21');
imHaus(() => useInvoiceStore.getState().recordPayment(B, 100, 'cash'));
imHaus(() => money.recordDebtPaymentInHouse({ debtId: L2, amount: 200, source: 'cash', paidAt: TODAY } as never, HCTX));
reload();
{
  ok(eq(debtState(L2).open, 600) && Number(inv(B)[1]) === 100, 'P-0 Ausgang: B bezahlt 100 bar (Rest 400), L2 bar 200 zurück (Rest 600)');
  const revB = invRev(B); const revL2 = debtState(L2).revision;
  const geldVor = geld();
  const body = po.debtOffsetBody({ invoiceId: B, debtId: L2, amount: 400, specialMarkOnFinal: true, expectedInvoiceRevision: revB, expectedDebtRevision: revL2 });
  const a = await fern(() => lc.runInvoicePayment(deps() as never, identity('301', 'invoices.record_payment'), body));
  const v = a.value as Record<string, unknown> | undefined;
  const nach = inv(B);
  ok(a.kind === 'ok' && v?.invoiceStatus === 'FINAL' && nach[0] === 'FINAL' && !String(nach[2]).startsWith('PINV') && Number(nach[3]) === 1,
    `P-1 PC2: Verrechnung schließt B → FINAL, Endnummer aus dem Sonderkreis (${a.kind} ${a.code ?? ''} ${S(nach)})`);
  ok(eq(debtState(L2).open, 200) && debtState(L2).status === 'PARTIALLY_REPAID' && geld() === geldVor, 'P-2 L2 Rest 200 (PARTIALLY_REPAID); kein Geld bewegt');
  const b = await fern(() => lc.runInvoicePayment(deps() as never, identity('301', 'invoices.record_payment'), body));
  ok(b.kind === 'ok' && b.replayed === true && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE receivable_id = ?", [B]) === 1,
    'P-3 dieselbe Kennung erneut → Wiedergabe, keine zweite Verrechnung');
  // Gleichzeitig: A (Rest 400) gegen L2 (Rest 200) mit der vor P-1 gesehenen Fassung → Nein; mehr als der Rest → Nein.
  const stale = await fern(() => lc.runInvoicePayment(deps() as never, identity('302', 'invoices.record_payment'),
    po.debtOffsetBody({ invoiceId: A, debtId: L2, amount: 100, expectedDebtRevision: revL2 })));
  ok(stale.code === 'RECORD_CHANGED', `P-4 zwei Rechner, dieselbe Darlehensfassung: der zweite wird abgelehnt (${stale.kind} ${stale.code})`);
  const zuviel = await fern(() => lc.runInvoicePayment(deps() as never, identity('303', 'invoices.record_payment'),
    po.debtOffsetBody({ invoiceId: A, debtId: L2, amount: 300 })));
  ok(zuviel.code === 'OFFSET_EXCEEDS_DEBT', `P-5 mehr als der frische Darlehensrest → abgelehnt (${zuviel.kind} ${zuviel.code})`);
  const fremd = await fern(() => lc.runInvoicePayment(deps() as never, identity('304', 'invoices.record_payment'),
    { ...po.debtOffsetBody({ invoiceId: A, debtId: L2, amount: 10 }), customerId: 'cust-2' }));
  ok(fremd.kind === 'thrown' || fremd.kind === 'rejected', `P-6 ein Kunde vom Client wird nicht angenommen (${fremd.kind} ${fremd.thrown ?? fremd.code ?? ''})`);
  const ohneDarlehen = await fern(() => lc.runInvoicePayment(deps() as never, identity('305', 'invoices.record_payment'), { invoiceId: A, amount: 10, method: 'debt_offset' }));
  ok(ohneDarlehen.kind === 'thrown' || ohneDarlehen.kind === 'rejected', 'P-7 debt_offset ohne Darlehen abgelehnt');
  const anderer = await fern(() => lc.runInvoicePayment(deps() as never, identity('306', 'invoices.record_payment'), po.debtOffsetBody({ invoiceId: A, debtId: L3, amount: 10 })));
  ok(anderer.code === 'OFFSET_CUSTOMER_MISMATCH', `P-8 PC2: fremdes Darlehen am Primary abgelehnt (${anderer.code})`);
  const offB = DB.exec('SELECT receivable_payment_id FROM party_offsets WHERE receivable_id = ?', [B])[0].values[0][0] as string;
  const upd = await fern(() => fc.runUpdatePayment(deps() as never, identity('307', 'invoices.update_payment'), { invoiceId: B, paymentId: offB, expectedRevision: invRev(B), amount: 300 }));
  ok(upd.code === 'PAYMENT_IS_DEBT_OFFSET', `P-9 eine Verrechnung wird nicht als Zahlung geändert (${upd.kind} ${upd.code})`);
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().updatePayment(offB, B, { amount: 300 } as never))) !== '', 'P-10 auch am Primary nicht änderbar');
  // Lesebefehl (PC2-Rechnungsseite): Verrechnungen und Kandidaten vom Primary.
  const r = await executeCommand('invoices.get', { actor: ACTOR, input: { id: A, stand: 'x' } }, undefined) as { kind: string; value: Record<string, unknown> & { data?: Record<string, unknown> } };
  const d = (r.value?.data ?? r.value) as { offsets?: Array<{ status: string; loanNumber: string }>; debtOffset?: { candidates: Array<{ debtId: string }>; suggested: number }; payments?: Array<{ method: string; editable: boolean }> };
  ok(r.kind === 'ok' && d.offsets?.length === 1 && d.offsets[0].loanNumber === loanNr(L1) && S(d.debtOffset?.candidates.map((x) => x.debtId)) === S([L2]) && eq(d.debtOffset?.suggested ?? 0, 200)
    && d.payments?.some((p) => p.method === 'debt_offset' && p.editable === false),
    `P-11 invoices.get liefert Verrechnungen, Kandidaten (L2, 200) und die Zahlung als nicht änderbar (${r.kind})`);
  // Die Rechnungsseite (Primary und PC2) liest beides aus `page.invoice_print.get` — dort im Feld `data` (useSharedRead).
  const pr = await executeCommand('page.invoice_print.get', { actor: ACTOR, input: { invoiceId: A, stand: 'x' } }, undefined) as { kind: string; value: { data?: { offsets?: Array<{ offsetNumber: string }>; debtOffset?: { candidates: Array<{ debtId: string }> }; payments?: unknown[] } } };
  ok(pr.kind === 'ok' && pr.value?.data?.offsets?.length === 1 && S(pr.value.data.debtOffset?.candidates.map((x) => x.debtId)) === S([L2]),
    `P-12 page.invoice_print.get (Seitenauskunft, data) liefert Verrechnungen und Kandidaten (${pr.kind})`);
  const fremdeFiliale = await executeCommand('page.invoice_print.get', { actor: { ...ACTOR, branchId: 'branch-2' }, input: { invoiceId: A } }, undefined) as { kind: string; value: { data?: { offsets?: unknown[]; debtOffset?: { candidates: unknown[] } } } };
  ok(fremdeFiliale.kind !== 'ok' || ((fremdeFiliale.value?.data?.offsets?.length ?? 0) === 0 && (fremdeFiliale.value?.data?.debtOffset?.candidates.length ?? 0) === 0),
    'P-13 andere Filiale sieht keine Verrechnungen und keine Darlehen');
}

// ══ U — Aufheben, Storno, Löschen, Korrektur- und Löschsperren ═══════════════════════════════════════════════════════
{
  // Sperren, solange die Verrechnung wirkt.
  const lines = (id: string, price?: number) => useInvoiceStore.getState().getInvoice(id)!.lines.map((l) => ({
    lineId: l.id, productId: l.productId, lotId: l.lotId ?? undefined, quantity: l.quantity, unitPrice: price ?? l.unitPrice, purchasePrice: l.purchasePriceSnapshot ?? 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price ?? l.lineTotal,
  }));
  useInvoiceStore.getState().loadInvoices();
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(A, { lines: lines(A) as never, customerId: 'cust-2', confirmCustomerChange: true, reason: 'test' }))) === 'INVOICE_HAS_OFFSET',
    'U-1 Kundenwechsel einer Rechnung mit wirksamer Verrechnung abgelehnt');
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(A, { lines: lines(A, 500) as never, reason: 'test', overpayChoice: 'credit' }))) === 'INVOICE_HAS_OFFSET',
    'U-2 Korrektur unter den verrechneten Betrag (würde Guthaben/Auszahlung) abgelehnt');
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(A, { lines: lines(A, 900) as never, reason: 'test' }))) === ''
    && eq(Number(inv(A)[1]), 600), 'U-3 Korrektur oberhalb des Verrechneten bleibt möglich (Rest neu)');
  reload();
  ok(/remove the offset/i.test(wirft(() => imHaus(() => useDebtStore.getState().deleteDebt(L1)))) && n(DB, 'SELECT COUNT(*) FROM debts WHERE id = ?', [L1]) === 1,
    'U-4 Darlehen mit wirksamer Verrechnung wird nicht gelöscht');
  ok(/remove the offset/i.test(wirft(() => imHaus(() => useDebtStore.getState().updateDebt(L1, { status: 'CANCELLED' } as never)))) && debtState(L1).status === 'REPAID',
    'U-5 … und nicht storniert');
  ok(/remove the offset/i.test(wirft(() => imHaus(() => useDebtStore.getState().updateDebt(L1, { direction: 'we_lend' } as never)))), 'U-6 … und die Richtung bleibt');

  // Aufheben am Primary (Rechnung A ↔ L1): Gegenbuchung, Gegenzeile, REVERSED, nie zweimal.
  const geldVor = geld();
  const lpVor = bal('LOAN_PAYABLE');
  const r = imHaus(() => po.reverseDebtOffsetInHouse({ offsetId: T.offsetId, reason: 'wrong loan' }, HCTX));
  reload();
  const o = DB.exec('SELECT status, reverse_reason, reversal_payment_id, reversed_by FROM party_offsets WHERE id = ?', [T.offsetId])[0].values[0];
  ok(r.offsetNumber === T.offsetNumber && o[0] === 'REVERSED' && o[1] === 'wrong loan' && o[3] === 'user-test', `U-7 aufgehoben: REVERSED, Grund und Person (${S(o)})`);
  ok(n(DB, 'SELECT COUNT(*) FROM payments WHERE id = ?', [T.paymentId]) === 0 && posting.hasReversalFor('PAYMENT', T.paymentId) && eq(bal('LOAN_PAYABLE'), lpVor - 600),
    'U-8 Rechnungszahlung entfernt, Buchung gegengebucht (Darlehensschuld wieder +600)');
  const rev = DB.exec('SELECT source, amount FROM debt_payments WHERE id = ?', [String(o[2])])[0].values[0];
  ok(rev[0] === 'offset_reversal' && eq(Number(rev[1]), -600) && debtState(L1).status === 'OPEN' && eq(debtState(L1).open, 600),
    'U-9 Darlehen: Gegenzeile −600 (offset_reversal), wieder OPEN mit 600');
  ok(eq(Number(inv(A)[1]), 0) && inv(A)[0] === 'PARTIAL' && geld() === geldVor && ledgerBalanced(), `U-10 Rechnung A wieder offen (PARTIAL, nicht Pending/DRAFT); kein Geld bewegt; Hauptbuch ausgeglichen (${inv(A)[0]})`);
  ok(wirft(() => imHaus(() => po.reverseDebtOffsetInHouse({ offsetId: T.offsetId }, HCTX))) === 'OFFSET_ALREADY_REVERSED', 'U-11 nie zweimal aufheben');
  ok(n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'party_offsets' AND entity_id = ? AND action_type = 'STATUS_CHANGE'", [T.offsetId]) === 1, 'U-12 Protokoll: STATUS_CHANGE');
  ok(!banking.loadBankingFor(CTX as never).transactions.some((t) => t.id.includes(String(o[2]))), 'U-13 Banking: auch die Gegenzeile nicht');

  // PC2 hebt die Verrechnung von B auf (invoices.delete_payment): Endnummer bleibt, Darlehen offen, Wiedergabe sicher.
  const offB = DB.exec("SELECT id, receivable_payment_id FROM party_offsets WHERE receivable_id = ? AND status = 'ACTIVE'", [B])[0].values[0];
  const nrB = String(inv(B)[2]);
  const del = await fern(() => fc.runDeletePayment(deps() as never, identity('401', 'invoices.delete_payment'), { invoiceId: B, paymentId: String(offB[1]), expectedRevision: invRev(B) }));
  ok(del.kind === 'ok' && s(DB, 'SELECT status FROM party_offsets WHERE id = ?', [String(offB[0])]) === 'REVERSED' && eq(debtState(L2).open, 600)
    && String(inv(B)[2]) === nrB && inv(B)[0] === 'PARTIAL' && eq(Number(inv(B)[1]), 100),
    `U-14 PC2 entfernt die Verrechnung: B wieder PARTIAL (100 bar bleiben), Endnummer bleibt, L2 wieder 600 (${del.kind} ${del.code ?? ''})`);
  const again = await fern(() => fc.runDeletePayment(deps() as never, identity('401', 'invoices.delete_payment'), { invoiceId: B, paymentId: String(offB[1]), expectedRevision: invRev(B) }));
  ok(again.kind === 'ok' && again.replayed === true && n(DB, "SELECT COUNT(*) FROM debt_payments WHERE debt_id = ? AND source = 'offset_reversal'", [L2]) === 1,
    'U-15 Wiedergabe: keine zweite Gegenzeile');

  // Storno: A (1.000) zahlt 300 bar + Verrechnung 500 mit L1 → Storno erstattet NUR die 300, L1 wieder offen.
  imHaus(() => useInvoiceStore.getState().recordPayment(A, 300, 'cash'));
  const T2 = create({ invoiceId: A, debtId: L1, amount: 500 });
  reload();
  const cashVor = bal('CASH');
  const gapVorStorno = gap('ACCOUNTS_RECEIVABLE');
  ok(eq(gapVorStorno, 0) && eq(gap('LOAN_PAYABLE'), gapLp0), 'U-15a vor dem Storno: AR stimmt, Loan-Payable-Abstand unverändert');
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: A, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  const o2 = DB.exec('SELECT status, reverse_reason FROM party_offsets WHERE id = ?', [T2.offsetId])[0].values[0];
  const refund = n(DB, "SELECT COALESCE(SUM(refund_amount),0) FROM sales_returns WHERE invoice_id = ?", [A]) || n(DB, "SELECT COALESCE(SUM(total_amount),0) FROM sales_returns WHERE invoice_id = ?", [A]);
  ok(inv(A)[0] === 'CANCELLED' && o2[0] === 'REVERSED' && o2[1] === 'invoice cancelled' && eq(debtState(L1).open, 600) && eq(bal('CASH'), cashVor - 300),
    `U-16 Storno: Verrechnung aufgehoben (Grund „invoice cancelled"), L1 wieder 600, erstattet nur die 300 bar (Kasse −${(cashVor - bal('CASH')).toFixed(3)}; Retoure ${refund})`);
  ok(ledgerBalanced() && posting.hasReversalFor('PAYMENT', T2.paymentId), 'U-17 Storno bucht die Verrechnung gegen, Hauptbuch ausgeglichen');

  // Löschen: Rechnung C mit Verrechnung → abgelehnt (der Löschpfad ist nicht der sichere Umkehrweg); nach „Remove offset" geht es.
  const C = sale('pk4', 250, '2026-10-22');
  const T3 = create({ invoiceId: C, debtId: L1, amount: 250 });
  reload();
  const vorLoeschen = stand();
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(C))) === 'INVOICE_HAS_OFFSET' && stand() === vorLoeschen,
    'U-18 Rechnung mit wirksamer Verrechnung wird nicht gelöscht, nichts geändert');
  imHaus(() => po.reverseDebtOffsetInHouse({ offsetId: T3.offsetId }, HCTX));
  reload();
  ok(wirft(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(C))) === '' && n(DB, 'SELECT COUNT(*) FROM invoices WHERE id = ?', [C]) === 0
    && s(DB, 'SELECT status FROM party_offsets WHERE id = ?', [T3.offsetId]) === 'REVERSED' && eq(debtState(L1).open, 600) && ledgerBalanced(),
    'U-18b nach „Remove offset" löschbar; L1 wieder 600, Verrechnung bleibt als REVERSED');
  ok(wirft(() => imHaus(() => useDebtStore.getState().deleteDebt(L3))) === '', 'U-19 ein Darlehen ohne wirksame Verrechnung bleibt löschbar');
  // Kontrollfall OHNE Verrechnung: dieselbe Rechnung (900, 300 bar) storniert — der AR-Abstand der bestehenden Storno-Regel
  // (stornierte Zahlung + Gutschrift) ist genau derselbe wie mit Verrechnung; die Verrechnung fügt nichts hinzu.
  const gapNachStorno = gap('ACCOUNTS_RECEIVABLE');
  const D = sale('pk5', 900, '2026-10-22');
  imHaus(() => useInvoiceStore.getState().recordPayment(D, 300, 'cash'));
  reload();
  const gapVorD = gap('ACCOUNTS_RECEIVABLE');
  imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: D, refundMethod: 'cash' } as never, 'branch-main'));
  reload();
  ok(eq(gapNachStorno - gapVorStorno, gap('ACCOUNTS_RECEIVABLE') - gapVorD) && eq(gap('LOAN_PAYABLE'), gapLp0),
    `U-20 Abstimmung: Storno mit Verrechnung = Storno ohne (AR-Abstand je ${(gapNachStorno - gapVorStorno).toFixed(3)}); Loan Payable unverändert`);
  ok(n(DB, "SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module = 'LOAN_PAYMENT'") === 1, 'U-21 einzige Darlehens-Rückzahlungsbuchung ist die echte Barzahlung an L2');
}

// ══ S — Status nach „Remove offset" (Owner-Beispiel: Rechnung 600, voll verrechnet, dann aufgehoben, keine echte Zahlung) ══
// Eine frisch ausgestellte, unbezahlte Rechnung steht als PARTIAL mit bezahlt 0 (Anzeige „Unpaid": InvoiceList/InvoiceDetail
// leiten aus paid_amount ab; „Record Payment" und „Settle Balance" sichtbar). Genau diesen Stand muss das Aufheben herstellen —
// nicht DRAFT („Pending", ohne Zahlungserfassung) und keine vorgetäuschte Teilzahlung.
{
  const frischId = sale('pk7', 600, '2026-10-23');
  const frisch = S(DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [frischId])[0].values[0]);
  const l2Vor = debtState(L2).open;
  const E = sale('pk6', 600, '2026-10-23');
  const T5 = create({ invoiceId: E, debtId: L2, amount: 600 });
  reload();
  const nrFinal = String(inv(E)[2]);
  ok(inv(E)[0] === 'FINAL' && !nrFinal.startsWith('PINV') && eq(Number(inv(E)[1]), 600), `S-1 voll verrechnet: FINAL mit Endnummer ${nrFinal}`);
  imHaus(() => po.reverseDebtOffsetInHouse({ offsetId: T5.offsetId }, HCTX));
  reload();
  const e = DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [E])[0].values[0];
  ok(S(e) === frisch && e[0] === 'PARTIAL' && eq(Number(e[1]), 0) && n(DB, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [E]) === 0,
    `S-2 nach „Remove offset": genau der Stand einer frisch ausgestellten unbezahlten Rechnung (${S(e)} = ${frisch}), keine Zahlung übrig`);
  ok(String(inv(E)[2]) === nrFinal && eq(debtState(L2).open, l2Vor), 'S-3 Endnummer bleibt (einmal vergeben), L2 wieder ganz offen');
  ok(!['DRAFT', 'CANCELLED', 'FINAL', 'RETURNED'].includes(String(e[0])) && eq(po.invoiceOpenFils(E) / 1000, 600),
    'S-4 Zahlungserfassung wieder möglich (dieselbe Regel wie „Record Payment": nicht DRAFT/CANCELLED/FINAL/RETURNED, offen 600)');
  const c = po.debtOffsetCandidatesFor(CTX, E);
  ok(c.candidates.some((x) => x.debtId === L2) && eq(c.invoiceOpen, 600) && eq(c.suggested, 600), 'S-5 wieder verrechenbar (L2, Vorschlag 600)');
  imHaus(() => useInvoiceStore.getState().recordPayment(E, 600, 'cash'));
  ok(inv(E)[0] === 'FINAL' && String(inv(E)[2]) === nrFinal, 'S-6 erneut bar bezahlt: FINAL, keine zweite Nummer');
  // Derselbe Fall über PC2 (invoices.record_payment → invoices.delete_payment).
  const P = sale('pk8', 600, '2026-10-23');
  const a = await fern(() => lc.runInvoicePayment(deps() as never, identity('601', 'invoices.record_payment'), po.debtOffsetBody({ invoiceId: P, debtId: L2, amount: 600, specialMarkOnFinal: false })));
  const payP = s(DB, "SELECT id FROM payments WHERE invoice_id = ? AND method = 'debt_offset'", [P]);
  const d = await fern(() => fc.runDeletePayment(deps() as never, identity('602', 'invoices.delete_payment'), { invoiceId: P, paymentId: payP, expectedRevision: invRev(P) }));
  const pz = DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [P])[0].values[0];
  ok(a.kind === 'ok' && d.kind === 'ok' && S(pz) === frisch && eq(debtState(L2).open, l2Vor),
    `S-7 PC2: verrechnet und aufgehoben → derselbe Stand wie frisch (${S(pz)}), L2 wieder ganz offen (${a.kind}/${d.kind})`);
  const again = await fern(() => lc.runInvoicePayment(deps() as never, identity('603', 'invoices.record_payment'), { invoiceId: P, amount: 600, method: 'cash' }));
  ok(again.kind === 'ok' && inv(P)[0] === 'FINAL', 'S-8 PC2: danach regulär bar bezahlbar');
}

// ══ Q — Quelltext: keine zweite Buchungslogik je Oberfläche ═══════════════════════════════════════════════════════════
{
  const ui = src('src/components/invoices/SettleBalance.tsx');
  ok(/createDebtOffsetOnPrimary/.test(ui) && /debtOffsetBody/.test(ui) && !/recordPayment\(|ledger|postInvoicePayment/.test(ui),
    'Q-1 die Maske ruft nur die Hausfolge (Primary) bzw. ihren Rumpf (PC2) — keine eigene Buchung');
  ok(/runDebtOffset/.test(src('src/core/bridge/invoice-lifecycle-commands.ts')) && /createDebtOffsetInHouse/.test(src('src/core/bridge/invoice-lifecycle-commands.ts')),
    'Q-2 PC2 läuft über dieselbe Hausfolge (invoices.record_payment → createDebtOffsetInHouse)');
  const m = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_operations: string[] }> };
  ok(S(m.tables.party_offsets?.allowed_operations) === S(['insert', 'update']), 'Q-3 Abgleich: party_offsets nur einfügen/ändern, nie löschen');
}

console.log(`\nB1 offset: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

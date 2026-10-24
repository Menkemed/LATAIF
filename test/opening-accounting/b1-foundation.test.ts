// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING FOUNDATION — Eröffnungsbilanz zum 15.10.2026: Erfassung und Abstimmung, KEINE Buchung.
// Settings-Eröffnung (01.01.2000) erhalten und eingefroren, Entwurfsbelege (Kasse gezählt, Darlehen, sonstige Posten,
// VAT), Übersicht mit Abgleich, Stichtagsliste, Saldenliste und Bilanzvorschau, Owner am Primary und PC2, Wiederholung,
// veralteter Stand, Rollback, Sync, keine Hauptbuch- oder VAT-Mutation. Nur künstliche Testdaten.
// Gerüst aus test/opening-balances/opening-balances-bundle.test.ts (echte sql.js-Datenbank, echte Migrationen, Stores).
// Run: node test/opening-accounting/b1-foundation.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

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
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { capitalizedLineCost, purchaseLotUnitCost, inventoryCostBasis } = await import('../../src/core/lots/lot-cost.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-07T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

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
const MIGRATIONS = realMigrations();

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
}

/** Artikel ohne Los; `price` = sein (Brutto-)Einkaufspreis wie nach einem Einkauf. */
function product(db: Db, id: string, price: number, qty = 0): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Silver',?,?,?,'New','[]',?,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
  [id, 'Item ' + id, 'SKU-' + id, qty, price, NOW, NOW]);
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const OWNER_ACTOR = { userId: 'user-test', role: 'ADMIN' };
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
async function meldungAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}

// ════════════════════════════════════════════════════════════════════════════
// Gemeinsame Werkzeuge
// ════════════════════════════════════════════════════════════════════════════
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
const ledgerCount = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const audits = (db: Db): number => n(db, 'SELECT COUNT(*) FROM audit_log');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
const rolle = (role: string): void => { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); };
/** Verkauf an cust-1 über den echten Rechnungsweg (Forderung im Hauptbuch), optional mit Geschäftsdatum. */
function verkauf(pid: string, price: number, issuedAt?: string, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, [{ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'OB-TEST', issuedAt).id);
  reload();
  return id;
}
const inv = (db: Db, id: string): Record<string, unknown> => {
  const r = db.exec('SELECT * FROM invoices WHERE id = ?', [id])[0];
  return r ? Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]])) : {};
};
const ar = (db: Db, cid = 'cust-1'): number => Number(one(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_type = 'CUSTOMER' AND counterparty_id = ?`, [cid]) ?? 0);
const imbalance = (db: Db): number => Number(one(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries`) ?? 0);
const XID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000ee`;
const ident = (x: string, op: string, hash = 'h' + x) => ({ commandId: XID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', op, payloadHash: hash });
const dps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
const RCTX = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
let seqA = 0;
const act = (): string => `ob-action-${++seqA}-xxxxxxxx`;
/** Scheitert beim n-ten passenden Schreibvorgang (Fehlerinjektion, wie r6d/payables-parity). */
function failOn(db: Db, pattern: RegExp, nth = 1): Db {
  let seen = 0;
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (pattern.test(sql) && ++seen === nth) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  setTestDatabase(proxy as never);
  return proxy;
}
const unfail = (db: Db): void => { setTestDatabase(db as never); };

// ════════════════════════════════════════════════════════════════════════════
// B1 — Werkzeuge
// ════════════════════════════════════════════════════════════════════════════
const oa = await import('../../src/core/accounting/opening-accounting.ts');
const ls = await import('../../src/core/accounting/ledger-statements.ts');
const ac = await import('../../src/core/ledger/account-classes.ts');
const backfill = await import('../../src/core/ledger/backfill.ts');
const ob = await import('../../src/core/parties/opening-balances.ts');
const cs = await import('../../src/core/parties/customer-settlement.ts');
const cmdO = await import('../../src/core/bridge/opening-accounting-commands.ts');
// Die Eröffnungsliste der Parteiposten (`page.opening_balances.get`) — für die Lesesperre in H1.
await import('../../src/core/bridge/party-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const sa = await import('../../src/core/stock/stock-adjustment.ts');
const OCTX = { branchId: 'branch-main', userId: 'user-test', now: NOW, role: 'ADMIN' };
const CUT = '2026-10-15';
const vor = (db: Db): string => S({
  items: db.exec('SELECT * FROM opening_account_items ORDER BY id')[0]?.values, ledger: ledgerCount(db), audit: audits(db), log: changelog(db),
  seq: db.exec("SELECT * FROM document_sequences WHERE doc_type = 'OB'")[0]?.values,
});
const ledgerBild = (db: Db): string => S(db.exec('SELECT * FROM ledger_entries ORDER BY id')[0]?.values ?? []);
const vatBild = (db: Db): string => S({
  inv: db.exec('SELECT id, status, gross_amount, vat_amount, paid_amount, invoice_number FROM invoices ORDER BY id')[0]?.values ?? [],
  filings: n(db, 'SELECT COUNT(*) FROM vat_filings'), tax: n(db, 'SELECT COUNT(*) FROM tax_payments'),
});
function rec(input: Record<string, unknown>, ctx: Record<string, unknown> = OCTX): { ok: boolean; code: string; item: Record<string, any> } {
  try { return { ok: true, code: '', item: imHaus(() => oa.recordOpeningAccountItemInHouse({ actionId: act(), ...input } as never, ctx as never)) as never }; }
  catch (e) { return { ok: false, code: String((e as { code?: string }).code ?? (e as Error).message), item: {} }; }
}
function storno(input: Record<string, unknown>): { ok: boolean; code: string; item: Record<string, any> } {
  try { return { ok: true, code: '', item: imHaus(() => oa.cancelOpeningAccountItemInHouse(input as never, OCTX as never)) as never }; }
  catch (e) { return { ok: false, code: String((e as { code?: string }).code ?? (e as Error).message), item: {} }; }
}
/** Eine Buchung, wie sie ein früherer Stand gebucht hat (die Settings-Eröffnung auf den 01.01.2000). */
function altEroeffnung(cash: number): void {
  imHaus(() => posting.postEntries([
    { account: 'CASH', direction: 'DEBIT', amount: cash, metadata: { kind: 'opening_balance' } },
    { account: 'OPENING_BALANCE_EQUITY', direction: 'CREDIT', amount: cash, metadata: { kind: 'opening_balance' } },
  ], { occurredAt: '2000-01-01T00:00:00.000Z', sourceModule: 'OPENING_BALANCE', sourceId: 'opening:branch-main', branchId: 'branch-main', userId: 'user-test' }));
}
function setting(db: Db, key: string, value: string): void {
  db.run('DELETE FROM settings WHERE branch_id = ? AND key = ?', ['branch-main', key]);
  insert(db, 'settings', { id: 'set-' + key, branch_id: 'branch-main', key, value, category: 'finance', updated_at: NOW });
}
const row = (r: ReturnType<typeof oa.openingAccountingFor>, key: string) => r.rows.find((x) => x.key === key)!;
const CASH = { kind: 'CASH_BALANCE', reference: 'Cash count 15.10.2026', reason: 'counted in the safe at opening' };

// ══ A — die vorhandene Settings-Eröffnung (01.01.2000): erhalten, eingefroren, keine Neubuchung ══════════════════
{
  const db = freshDb();
  setting(db, 'finance.opening_cash', '1000');
  altEroeffnung(1000);
  const l0 = ledgerBild(db);
  const st = oa.legacyCashOpeningFor('branch-main');
  const same = imHaus(() => posting.postOpeningBalances('branch-main', 'user-test'));
  ok(st.inSync && eq(st.ledger.cash, 1000) && eq(st.settings.cash, 1000) && same === false && ledgerBild(db) === l0,
    'A1 Settings und gebuchte Eröffnung (01.01.2000) stimmen überein: nichts zu tun, Hauptbuch unverändert');
  setting(db, 'finance.opening_cash', '1500');
  let frozen = '';
  try { imHaus(() => posting.postOpeningBalances('branch-main', 'user-test')); } catch (e) { frozen = String((e as { code?: string }).code); }
  const bf = backfill.backfillOpeningBalances('branch-main');
  ok(frozen === 'LEGACY_OPENING_FROZEN' && ledgerBild(db) === l0 && bf.skipped === 1 && bf.failed === 0 && bf.posted === 0 && /skipped/.test(bf.errors[0] ?? ''),
    'A2 eine spätere Settings-Änderung wird nicht mehr still umgebucht (kein Storno, keine Neubuchung) — auch nicht über Backfill');
  setting(db, 'finance.opening_bank', '-50');
  let neg = '';
  try { imHaus(() => posting.postOpeningBalances('branch-main', 'user-test')); } catch (e) { neg = String((e as { code?: string }).code); }
  const st2 = oa.legacyCashOpeningFor('branch-main');
  ok(neg === 'LEGACY_OPENING_FROZEN' && ledgerBild(db) === l0 && st2.invalid.includes('bank') && st2.notBooked.includes('cash') && !st2.inSync && Math.abs(imbalance(db)) < 0.0005,
    'A3 ein negativer Settings-Wert erzeugt keine (unausgeglichene) Buchung; er wird als ungültig gemeldet');
  const r = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(eq(row(r, 'CASH_BALANCE').booked, 1000) && row(r, 'CASH_BALANCE').status === 'MISSING'
    && row(r, 'CASH_BALANCE').notes.some((x) => /01\.01\.2000/.test(x)) && row(r, 'CASH_BALANCE').notes.some((x) => /not in the ledger/.test(x))
    && r.issues.some((x) => /invalid or negative/.test(x)) && eq(r.equity.openingBooked, 1000),
    'A4 Übersicht: die 01.01.2000-Eröffnung zählt einmal (im Buchsaldo), der abweichende Settings-Wert zählt nirgends, Zählung fehlt');
  const sp = src('src/pages/settings/SettingsPage.tsx');
  ok(/if \(\/\^finance\\\.opening_\(cash\|bank\|benefit\)\$\/\.test\(key\)\) \{\s*throw new Error/.test(sp)
    && !/setSetting\(branchId, 'finance\.opening_(cash|bank|benefit)'/.test(sp) && /data-legacy-opening-frozen/.test(sp)
    && /case 'opening': return <OpeningAccountingPanel \/>;/.test(sp),
    'A5 Settings: die alten Felder sind nur noch Anzeige, setSetting weist sie ab; neuer Tab „Opening Balances"');
}

// ══ B — Entwurfsbelege: Erfassung ohne Buchung, Prüfungen, Korrektur, Storno, Wiederholung, Rollback ═══════════════
{
  const db = freshDb();
  altEroeffnung(1000);
  const l0 = ledgerBild(db);
  const v0 = vatBild(db);
  const c1 = rec({ ...CASH, amount: 1200 });
  const it = c1.item;
  ok(c1.ok && /^OB-/.test(it.itemNumber) && it.status === 'RECORDED' && it.accounting === 'PENDING' && eq(it.amount, 1200) && it.cutoffDate === CUT
    && ledgerBild(db) === l0 && vatBild(db) === v0
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'opening_account_items' AND entity_id = ? AND action_type = 'CREATE'", [it.id]) === 1
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'opening_account_items' AND record_id = ?", [it.id]) >= 1,
    `B1 gezählter Kassenstand erfasst: OB-Beleg, PENDING, Protokoll, Sync — kein Hauptbuch, keine VAT (${c1.code || it.itemNumber})`);
  const r1 = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(eq(row(r1, 'CASH_BALANCE').booked, 1000) && eq(row(r1, 'CASH_BALANCE').target!, 1200) && eq(row(r1, 'CASH_BALANCE').adjustment!, 200)
    && row(r1, 'CASH_BALANCE').status === 'PROVISIONAL' && r1.status === 'PROVISIONAL' && r1.booking.active === false,
    'B2 Abgleich Kasse: Buchsaldo 1000 (inkl. 01.01.2000), gezählt 1200 → Differenz 200 sichtbar, nicht gebucht, PROVISIONAL');

  const vorF = vor(db);
  rolle('MANAGER');
  const m = rec({ ...CASH, kind: 'BANK_BALANCE', amount: 5 }, { ...OCTX, role: 'MANAGER' });
  rolle('ADMIN');
  insert(db, 'debts', { id: 'loan-1', branch_id: 'branch-main', loan_number: 'LOA-2026-000001', direction: 'we_lend', counterparty: 'X', customer_id: 'cust-1', amount: 10, source: 'cash', created_at: NOW, updated_at: NOW });
  const vorF2 = vor(db);
  const faelle: Array<[string, Record<string, unknown>, string]> = [
    ['Fils', { ...CASH, kind: 'BANK_BALANCE', amount: 1.2345 }, 'AMOUNT_INVALID'],
    ['Kasse negativ', { ...CASH, kind: 'BENEFIT_BALANCE', amount: -1 }, 'AMOUNT_INVALID'],
    ['ohne Grund', { ...CASH, kind: 'BANK_BALANCE', amount: 5, reason: ' ' }, 'REASON_REQUIRED'],
    ['ohne Referenz', { ...CASH, kind: 'BANK_BALANCE', amount: 5, reference: '' }, 'REFERENCE_REQUIRED'],
    ['zweite Zählung', { ...CASH, amount: 900 }, 'COUNT_EXISTS'],
    ['Darlehen ohne Gegenpartei', { kind: 'LOAN_RECEIVABLE', amount: 50, reference: 'Loan A', reason: 'old loan' }, 'COUNTERPARTY_REQUIRED'],
    ['Darlehen ohne Bestätigung', { kind: 'LOAN_RECEIVABLE', amount: 50, reference: 'Loan A', reason: 'old loan', counterpartyType: 'CUSTOMER', counterpartyId: 'cust-1' }, 'CONFIRM_NOT_IN_LATAIF'],
    ['Darlehen = LATAIF-Beleg', { kind: 'LOAN_RECEIVABLE', amount: 50, reference: 'loa-2026-000001', reason: 'old loan', counterpartyType: 'CUSTOMER', counterpartyId: 'cust-1', confirmNotInLataif: true }, 'REFERENCE_IS_LATAIF_DOCUMENT'],
    ['VAT mit Gegenpartei', { kind: 'VAT_PAYABLE', amount: 30, reference: 'Q3 2026', reason: 'not yet filed', counterpartyType: 'OTHER', counterpartyName: 'NBR' }, 'COUNTERPARTY_NOT_ALLOWED'],
    ['unbekannter Kunde', { kind: 'OTHER_ASSET', amount: 30, reference: 'Deposit', reason: 'rent deposit', counterpartyType: 'CUSTOMER', counterpartyId: 'nope' }, 'COUNTERPARTY_NOT_FOUND'],
    ['Art unbekannt', { kind: 'EQUITY', amount: 30, reference: 'x', reason: 'y' }, 'KIND_INVALID'],
    ['Darlehen 0', { kind: 'LOAN_PAYABLE', amount: 0, reference: 'Loan B', reason: 'x', counterpartyType: 'OTHER', counterpartyName: 'Bank' }, 'AMOUNT_INVALID'],
  ];
  const bad: string[] = [];
  for (const [name, input, code] of faelle) { const r = rec(input); if (r.ok || r.code !== code) bad.push(`${name}: ${r.code || 'ok'}`); }
  ok(!m.ok && m.code === 'PERMISSION_DENIED' && vor(db) === vorF2 && vorF !== '' && bad.length === 0,
    `B3 nur der Owner; Fils, Vorzeichen, Pflichtfelder, eine Zählung je Konto, Gegenpartei, Darlehen nicht schon in LATAIF — nichts geschrieben (${bad.join('; ') || 'alle dreizehn'})`);
  const bank = rec({ ...CASH, kind: 'BANK_BALANCE', amount: -250.5, reference: 'Statement 14.10.' });
  const loan = rec({ kind: 'LOAN_PAYABLE', amount: 4000, reference: 'Loan from uncle', reason: 'private loan before LATAIF', counterpartyType: 'OTHER', counterpartyName: 'Uncle', confirmNotInLataif: true });
  const vat = rec({ kind: 'VAT_PAYABLE', amount: 120.125, reference: 'Q3 2026 return', reason: 'filed late, not yet paid' });
  const dup = rec({ kind: 'LOAN_PAYABLE', amount: 1, reference: 'LOAN FROM  uncle', reason: 'x', counterpartyType: 'OTHER', counterpartyName: 'Uncle', confirmNotInLataif: true });
  ok(bank.ok && eq(bank.item.amount, -250.5) && loan.ok && loan.item.counterpartyName === 'Uncle' && vat.ok && eq(vat.item.amount, 120.125)
    && !dup.ok && dup.code === 'DUPLICATE_REFERENCE' && ledgerBild(db) === l0,
    'B4 Bank darf überzogen sein, Darlehen mit Gegenpartei, VAT in Fils genau; dieselbe Referenz zweimal abgewiesen; keine Buchung');

  // kontrollierte Korrektur: gegen den gesehenen Stand, alter Beleg storniert und verknüpft — in einer Transaktion
  const stale = rec({ ...CASH, amount: 1000, correctsId: it.id, expectedCorrectsRevision: 7 });
  const vorK = vor(db);
  const k = rec({ ...CASH, amount: 1000, reason: 'recount: 200 belonged to the owner', correctsId: it.id, expectedCorrectsRevision: 0 });
  const alt = db.exec('SELECT status, cancel_reason, revision FROM opening_account_items WHERE id = ?', [it.id])[0].values[0];
  const r2 = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(!stale.ok && stale.code === 'ITEM_CHANGED' && vorK !== vor(db) && k.ok && k.item.correctsId === it.id && alt[0] === 'CANCELLED'
    && String(alt[1]).startsWith(`corrected by ${k.item.itemNumber}`) && Number(alt[2]) === 1
    && row(r2, 'CASH_BALANCE').status === 'RECONCILED' && eq(row(r2, 'CASH_BALANCE').adjustment!, 0) && ledgerBild(db) === l0,
    'B5 Korrektur nur gegen den gesehenen Stand (veraltet → abgewiesen); alter Beleg storniert mit Verweis, neuer verknüpft; Kasse jetzt abgestimmt');

  const s1 = storno({ itemId: vat.item.id, reason: 'paid already', expectedRevision: 3 });
  const s2 = storno({ itemId: vat.item.id, reason: 'paid already', expectedRevision: 0 });
  const s3 = storno({ itemId: vat.item.id, reason: 'again', expectedRevision: 1 });
  const s4 = storno({ itemId: loan.item.id, reason: '', expectedRevision: 0 });
  ok(!s1.ok && s1.code === 'ITEM_CHANGED' && s2.ok && s2.item.status === 'CANCELLED' && !s3.ok && s3.code === 'ALREADY_CANCELLED' && !s4.ok && s4.code === 'REASON_REQUIRED'
    && n(db, "SELECT COUNT(*) FROM opening_account_items WHERE id = ?", [vat.item.id]) === 1 && ledgerBild(db) === l0,
    'B6 Storno nur gegen den gesehenen Stand und mit Grund; zweimal geht nicht; gelöscht wird nie; keine Buchung');

  const body = { actionId: 'b1-fixed-action-01', kind: 'OTHER_ASSET', amount: 75, reference: 'Rent deposit', reason: 'deposit paid 2024' };
  const a1 = imHaus(() => oa.recordOpeningAccountItemInHouse(body as never, OCTX as never));
  const vorW = vor(db);
  const a2 = imHaus(() => oa.recordOpeningAccountItemInHouse(body as never, OCTX as never));
  let konflikt = '';
  try { imHaus(() => oa.recordOpeningAccountItemInHouse({ ...body, amount: 76 } as never, OCTX as never)); } catch (e) { konflikt = String((e as { code?: string }).code); }
  ok(a1.id === a2.id && vor(db) === vorW && konflikt === 'ACTION_ID_CONFLICT', 'B7 dieselbe Aktion zweimal: derselbe Beleg; dieselbe Kennung mit anderem Inhalt: abgewiesen');

  const vorR = vor(db);
  const bad1 = failOn(db, /INSERT INTO audit_log/);
  let rb = '';
  try { imHaus(() => oa.recordOpeningAccountItemInHouse({ actionId: act(), kind: 'OTHER_LIABILITY', amount: 9, reference: 'Rollback', reason: 'x' } as never, OCTX as never)); } catch (e) { rb = (e as Error).message; }
  unfail(db);
  const vorR2 = vor(db);
  const cash = db.exec("SELECT id, revision FROM opening_account_items WHERE kind = 'CASH_BALANCE' AND status = 'RECORDED'")[0].values[0];
  failOn(db, /INSERT INTO opening_account_items/);
  let rb2 = '';
  try { imHaus(() => oa.recordOpeningAccountItemInHouse({ actionId: act(), ...CASH, amount: 999, correctsId: String(cash[0]), expectedCorrectsRevision: Number(cash[1]) } as never, OCTX as never)); } catch (e) { rb2 = (e as Error).message; }
  unfail(db);
  ok(/INJECTED/.test(rb) && vorR === vorR2 && /INJECTED/.test(rb2) && vor(db) === vorR2 && bad1 !== null
    && s(db, 'SELECT status FROM opening_account_items WHERE id = ?', [String(cash[0])]) === 'RECORDED',
    'B8 Rollback: scheitert das Protokoll oder der neue Beleg einer Korrektur, bleibt alles wie vorher (auch der alte Beleg, die Nummer, der Sync)');
  ok(n(db, "SELECT COUNT(*) FROM opening_account_items WHERE accounting != 'PENDING'") === 0 && ledgerBild(db) === l0 && vatBild(db) === v0,
    'B9 kein Weg zu POSTED: alle Belege PENDING, Hauptbuch und VAT unverändert');
}

// ══ C — PC2: Owner über den Primary, Manager eingefroren, Wiederholung, veralteter Stand, strenger Rumpf, Auskunft ══
{
  const db = freshDb();
  const XID2 = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000b1`;
  const id2 = (x: string, op: string) => ({ commandId: XID2(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', op, payloadHash: 'h' + x });
  const body = { actionId: 'pc2-b1-action-01', kind: 'CASH_BALANCE', amount: 300, reference: 'Count PC2', reason: 'counted by owner at PC2' };
  const v0 = vor(db);
  const m = await cmdO.runOpeningAccountAction(oa.recordOpeningAccountItemInHouse as never, cmdO.OPENING_ACCOUNT_CREATE_KEYS, dps(db), id2('1', 'opening_accounts.create'), 'MANAGER', body);
  ok(m.kind === 'rejected' && (m as { code: string }).code === 'PERMISSION_DENIED' && (m as { frozen: boolean }).frozen && vor(db) === v0, 'C1 PC2 als Manager: abgewiesen, eingefroren, nichts geschrieben');
  const o1 = await cmdO.runOpeningAccountAction(oa.recordOpeningAccountItemInHouse as never, cmdO.OPENING_ACCOUNT_CREATE_KEYS, dps(db), id2('2', 'opening_accounts.create'), 'ADMIN', body);
  const nach = vor(db);
  const o2 = await cmdO.runOpeningAccountAction(oa.recordOpeningAccountItemInHouse as never, cmdO.OPENING_ACCOUNT_CREATE_KEYS, dps(db), id2('2', 'opening_accounts.create'), 'ADMIN', body);
  const item = (o1 as { value: Record<string, any> }).value;
  ok(o1.kind === 'ok' && (o2 as { replayed?: boolean }).replayed === true && vor(db) === nach && item.createdBy === 'user-pc2' && ledgerCount(db) === 0,
    'C2 PC2 als Owner: Beleg am Primary (Akteur PC2), Wiederholung derselben Kennung ändert nichts, keine Buchung');
  const stale = await cmdO.runOpeningAccountAction(oa.cancelOpeningAccountItemInHouse as never, cmdO.OPENING_ACCOUNT_CANCEL_KEYS, dps(db), id2('3', 'opening_accounts.cancel'), 'ADMIN', { itemId: item.id, reason: 'x', expectedRevision: 5 });
  let feld = '';
  try { await cmdO.runOpeningAccountAction(oa.recordOpeningAccountItemInHouse as never, cmdO.OPENING_ACCOUNT_CREATE_KEYS, dps(db), id2('4', 'opening_accounts.create'), 'ADMIN', { ...body, actionId: 'pc2-b1-action-02', accounting: 'POSTED' }); }
  catch (e) { feld = (e as Error).message; }
  ok(stale.kind === 'rejected' && (stale as { code: string }).code === 'ITEM_CHANGED' && /unknown field: accounting/.test(feld) && vor(db) === nach,
    'C3 ein veraltetes Fenster storniert nicht; der Rumpf ist streng (Buchungslage, Nummer, Akteur bestimmt der Primary)');
  const actor = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const remote = await registry.executeCommand('page.opening_accounting.get', { actor, input: { asOfDate: CUT } }, undefined) as { kind: string; value: { data: ReturnType<typeof oa.openingAccountingFor> } };
  const local = oa.openingAccountingFor({ branchId: 'branch-main' }, { asOfDate: CUT });
  ok(remote.kind === 'ok' && S(remote.value.data.rows) === S(local.rows) && S(remote.value.data.balanceSheet) === S(local.balanceSheet) && remote.value.data.items.length === 1,
    'C4 PC2 liest dieselbe Übersicht, Saldenliste und Bilanzvorschau wie der Primary (Auskunft page.opening_accounting.get)');
}

// ══ D — Stichtag: Übersicht, Abgleich, Stichtagsliste ═══════════════════════════════════════════════════════════
{
  const db = freshDb();
  altEroeffnung(1000);
  product(db, 'p1', 0, 1); product(db, 'p2', 0, 1); reload();
  const vorher = verkauf('p1', 500, '2026-10-10T12:00:00.000Z');
  const nachher = verkauf('p2', 800, '2026-10-20T12:00:00.000Z');
  imHaus(() => ob.recordOpeningItemInHouse({ actionId: act(), partyType: 'CUSTOMER', partyId: 'cust-1', kind: 'CUSTOMER_RECEIVABLE', scope: 'REMAINDER', amount: 300, confirmNotInLataif: true } as never, OCTX as never));
  const neu = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Rolex', name: 'Old', quantity: 2, purchasePrice: 100 } as never));
  reload();
  const r = oa.openingAccountingFor({ branchId: 'branch-main' }, { view: 'transactions' });
  const recv = row(r, 'CUSTOMER_RECEIVABLES');
  const stock = row(r, 'OLD_STOCK');
  ok(eq(recv.booked, 500) && eq(recv.draft!, 300) && eq(recv.adjustment!, 300) && recv.status === 'PROVISIONAL',
    'D1 Kundenforderungen: gebucht vor dem Stichtag nur die Rechnung vom 10.10. (500), die vom 20.10. nicht; Eröffnungsposten 300 getrennt als Entwurf');
  ok(stock.range !== null && eq(stock.range.low, 200) && eq(stock.range.high, 200) && stock.status === 'NOT_VERIFIED' && stock.valuation === 'CURRENT_NOT_VERIFIED'
    && stock.adjustment === null && /^CURRENT value/.test(stock.notes[0]) && r.oldStock.valuation === 'CURRENT' && r.oldStock.asOfCutoff === 'PENDING_NOT_VERIFIED'
    && r.oldStock.candidates === 1 && !!neu,
    'D2 Altbestand aus Collection: heutiger Wert 2 × 100 = 200 (V2 … V1), als CURRENT gekennzeichnet, zum Stichtag NOT VERIFIED, nicht gebucht');
  const tx = r.transactions!;
  const invNr = s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [vorher]);
  const invNr2 = s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [nachher]);
  const t1 = tx.rows.find((t) => t.document === invNr);
  ok(!!t1 && t1.status === 'ACTIVE' && t1.sourceModule === 'INVOICE' && eq(t1.amount, 500)
    && S(t1.effect.find((e) => e.group === 'RECEIVABLES')) === S({ group: 'RECEIVABLES', delta: 500 })
    && !tx.rows.some((t) => t.document === invNr2) && tx.rows.some((t) => t.document === 'Opening (settings)' && t.status === 'ACTIVE')
    && tx.rows.every((t) => t.occurredAt < tx.boundaryIso) && tx.total === tx.rows.length && !tx.truncated,
    `D3 Stichtagsliste: Datum, Beleg (${invNr}), Herkunft, Status, Soll/Haben, Betrag und Wirkung je Gruppe; nur Buchungen vor dem Stichtag`);
  const a = imHaus(() => posting.postEntries([
    { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 40 }, { account: 'CASH', direction: 'CREDIT', amount: 40 },
  ], { occurredAt: '2026-10-01T12:00:00.000Z', sourceModule: 'EXPENSE', sourceId: 'exp-x', branchId: 'branch-main' }));
  const b = imHaus(() => posting.postEntries([
    { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 15 }, { account: 'CASH', direction: 'CREDIT', amount: 15 },
  ], { occurredAt: '2026-10-02T12:00:00.000Z', sourceModule: 'EXPENSE', sourceId: 'exp-y', branchId: 'branch-main' }));
  imHaus(() => posting.reverseTransaction(a.transactionId, '2026-10-05T12:00:00.000Z'));
  imHaus(() => posting.reverseTransaction(b.transactionId, '2026-10-25T12:00:00.000Z'));
  const tx2 = oa.openingAccountingFor({ branchId: 'branch-main' }, { view: 'transactions' }).transactions!;
  const st = (id: string) => tx2.rows.find((t) => t.transactionId === id)?.status;
  ok(st(a.transactionId) === 'REVERSED' && st(b.transactionId) === 'REVERSED_AFTER_CUTOFF' && tx2.rows.filter((t) => t.status === 'REVERSAL').length === 1,
    'D4 Storno sichtbar: vor dem Stichtag storniert (wirkt zusammen 0), nach dem Stichtag storniert (wirkt am Stichtag), der Storno selbst');
  ok(ls.cutoffBoundaryIso(CUT) === new Date('2026-10-15T00:00:00').toISOString()
    && tx2.rows.every((t) => new Date(t.occurredAt).getTime() < new Date('2026-10-15T00:00:00').getTime())
    && meldung(() => ls.cutoffBoundaryIso('2026-02-30')).startsWith('AS_OF_DATE_INVALID'),
    'D5 Stichtag = 00:00 Uhr Ortszeit des 15.10. (wie der NBR-Export); ungültige Daten abgewiesen');
  const ia = oa.openingAccountingFor({ branchId: 'branch-main' }, { asOfDate: '2026-10-21' });
  ok(eq(ia.trialBalance.lines.find((l) => l.account === 'ACCOUNTS_RECEIVABLE')!.balance, 1300) && eq(row(ia, 'CUSTOMER_RECEIVABLES').booked, 500)
    && ia.issues.some((x) => /not the opening cutoff/.test(x)),
    'D6 Saldenliste zu einem gewählten Datum (21.10.: 1300); die Eröffnungsübersicht bleibt am Stichtag (500) und sagt es');
}

// ══ E — Saldenliste, Bilanzvorschau, Kontenklassen, Eigenkapital ════════════════════════════════════════════════
{
  const db = freshDb();
  altEroeffnung(1000);
  product(db, 'q1', 0, 1); reload();
  verkauf('q1', 500, '2026-10-10T12:00:00.000Z');
  imHaus(() => posting.postEntries([
    { account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: 120 }, { account: 'CASH', direction: 'CREDIT', amount: 120 },
  ], { occurredAt: '2026-10-03T12:00:00.000Z', sourceModule: 'EXPENSE', sourceId: 'exp-e1', branchId: 'branch-main' }));
  imHaus(() => posting.postEntries([
    { account: 'PARTNER_EQUITY', direction: 'CREDIT', amount: 2000 }, { account: 'BANK', direction: 'DEBIT', amount: 2000 },
  ], { occurredAt: '2026-09-01T12:00:00.000Z', sourceModule: 'PARTNER_TX', sourceId: 'ptx-1', branchId: 'branch-main' }));
  const tb = ls.trialBalanceAt({ branchId: 'branch-main' }, CUT);
  const bs = ls.balanceSheetAt({ branchId: 'branch-main' }, CUT);
  const rev = tb.lines.find((l) => l.account === 'REVENUE')?.balance ?? 0;
  const cogs = tb.lines.find((l) => l.account === 'EXPENSES_OPERATING')?.balance ?? 0;
  ok(eq(tb.totalDebit, tb.totalCredit) && eq(tb.imbalance, 0) && tb.unclassified.length === 0
    && eq(bs.difference, 0) && eq(bs.totals.assets, bs.totals.liabilities + bs.totals.equityAndResult)
    && eq(bs.equity.opening, 1000) && eq(bs.equity.partner, 2000) && eq(bs.equity.result, rev - cogs) && eq(rev, 500) && eq(cogs, 120) && bs.status === 'PROVISIONAL',
    `E1 Saldenliste ausgeglichen; Bilanz: Aktiva = Passiva + Eigenkapital + Ergebnis; Eröffnung 1000, Partner 2000, Ergebnis 500 − 120 getrennt (${bs.equity.result})`);
  const r = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(eq(r.equity.assetsBooked, bs.totals.assets) && eq(r.equity.liabilitiesBooked, bs.totals.liabilities) && eq(r.equity.openingBooked, 1000)
    && eq(r.equity.resultBooked, 380) && eq(r.equity.partnerBooked, 2000),
    'E2 jede Bilanzposition steht in genau einer Zeile der Übersicht (Summen gleich der Bilanzvorschau)');
  rec({ ...CASH, amount: 1200 });
  rec({ kind: 'LOAN_PAYABLE', amount: 4000, reference: 'Loan', reason: 'old', counterpartyType: 'OTHER', counterpartyName: 'Bank', confirmNotInLataif: true });
  const r2 = oa.openingAccountingFor({ branchId: 'branch-main' });
  const cashBooked = row(r2, 'CASH_BALANCE').booked;
  ok(eq(r2.equity.draftNet, (1200 - cashBooked) - 4000) && eq(r2.equity.provisionalOpening.withoutOldStock, 1000 + (1200 - cashBooked) - 4000),
    `E3 rechnerisches Eröffnungskapital = gebuchte Eröffnung + Wirkung der Entwürfe (Kasse ${(1200 - cashBooked).toFixed(3)}, Darlehen −4000) — nichts erfunden`);
  const posted = posting.LEGACY_OPENING_FROZEN;
  const union = [...new Set([...src('src/core/ledger/posting.ts').slice(src('src/core/ledger/posting.ts').indexOf('export type LedgerAccount'), src('src/core/ledger/posting.ts').indexOf('export type LedgerDirection')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]))];
  const q = src('src/core/ledger/queries.ts');
  const natural = [...q.slice(q.indexOf('const NATURAL_DEBIT'), q.indexOf(']);', q.indexOf('const NATURAL_DEBIT'))).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
  const widersprueche = union.filter((acc) => {
    const info = ac.accountClassOf(acc);
    if (!info) return true;
    const debitNatur = info.klass === 'ASSET' || info.klass === 'EXPENSE';
    return info.contra ? debitNatur === natural.includes(acc) : debitNatur !== natural.includes(acc);
  });
  ok(union.length === 31 && widersprueche.length === 0 && Object.keys(ac.ACCOUNT_CLASSES).length === union.length && posted === 'LEGACY_OPENING_FROZEN',
    `E4 jedes Hauptbuchkonto hat eine Klasse, passend zu seiner Soll-/Haben-Natur (Gegenkonten TAX_PAID, REFUNDS ausdrücklich) (${widersprueche.join(',') || union.length})`);
  insert(db, 'ledger_entries', { id: 'le-m1', branch_id: 'branch-main', entry_no: 9001, transaction_id: 'tx-m', account: 'MYSTERY', direction: 'DEBIT', amount: 7, source_module: 'MANUAL', source_id: 'm', occurred_at: '2026-10-01T12:00:00.000Z', recorded_at: NOW, currency: 'BHD' });
  insert(db, 'ledger_entries', { id: 'le-m2', branch_id: 'branch-main', entry_no: 9002, transaction_id: 'tx-m', account: 'CASH', direction: 'CREDIT', amount: 7, source_module: 'MANUAL', source_id: 'm', occurred_at: '2026-10-01T12:00:00.000Z', recorded_at: NOW, currency: 'BHD' });
  const r3 = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(r3.trialBalance.unclassified.includes('MYSTERY') && r3.balanceSheet.unclassified.some((u) => u.account === 'MYSTERY') && eq(r3.balanceSheet.difference, -7)
    && r3.issues.some((x) => /without a class/.test(x)) && r3.issues.some((x) => /unexplained/.test(x)),
    'E5 ein Konto ohne Klasse wird nie still zugeordnet: Saldenliste, Bilanzvorschau und Hinweise zeigen es und die offene Differenz');
}

// ══ F — Integrität: Eröffnungsposten, Bestandskorrekturen, Sync, Löschsperre ═══════════════════════════════════
{
  const db = freshDb();
  product(db, 'r1', 0, 1); reload();
  const inv1 = verkauf('r1', 400, '2026-10-10T12:00:00.000Z');
  const opp = imHaus(() => ob.recordOpeningItemInHouse({ actionId: act(), partyType: 'CUSTOMER', partyId: 'cust-1', kind: 'CUSTOMER_RECEIVABLE', scope: 'DOCUMENT', reference: 'OLD-77', amount: 250, confirmNotInLataif: true } as never, OCTX as never));
  const openBefore = S(cs.customerSettlementInvoices('cust-1', 'branch-main'));
  rec({ kind: 'LOAN_RECEIVABLE', amount: 90, reference: 'Loan to customer', reason: 'lent in 2025', counterpartyType: 'CUSTOMER', counterpartyId: 'cust-1', confirmNotInLataif: true });
  oa.openingAccountingFor({ branchId: 'branch-main' }, { view: 'transactions' });
  ok(s(db, 'SELECT accounting FROM opening_balance_items WHERE id = ?', [opp.id]) === 'PENDING' && S(cs.customerSettlementInvoices('cust-1', 'branch-main')) === openBefore
    && !cs.customerSettlementInvoices('cust-1', 'branch-main').some((i: { id: string }) => i.id === opp.id) && !!inv1,
    'F1 Kunden-/Lieferanten-Eröffnungsposten bleiben PENDING und unbezahlbar (nicht in Receive Payment)');
  const pid = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Omega', name: 'Typo', quantity: 5, purchasePrice: 100 } as never)).id;
  reload();
  const korr = await sa.correctInitialQtyOnPrimary({ actionId: act(), productId: pid, newQuantity: 3, expectedQuantity: 5, reason: 'typo' } as never, reload);
  const r = oa.openingAccountingFor({ branchId: 'branch-main' });
  ok(korr.qtyAfter === 3 && eq(row(r, 'OLD_STOCK').range!.low, 300) && ledgerCount(db) === n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    'F2 Bestandskorrekturen arbeiten weiter; die Übersicht rechnet mit der berichtigten Menge (3 × 100)');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_operations: string[]; allowed_fields: string[] }> };
  const t = manifest.tables.opening_account_items;
  const cols = (db.exec('PRAGMA table_info(opening_account_items)')[0]?.values ?? []).map((v) => String(v[1])).sort();
  ok(!!t && S(t.allowed_operations) === S(['insert', 'update']) && S([...t.allowed_fields].sort()) === S(cols)
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'opening_account_items'") >= 1,
    'F3 Sync: opening_account_items reist zum Spiegel (insert/update, nie delete), alle Spalten im Manifest');
  let geloescht = '';
  try { useCustomerStore.getState().deleteCustomer('cust-1'); } catch (e) { geloescht = (e as Error).message; }
  ok(n(db, "SELECT COUNT(*) FROM customers WHERE id = 'cust-1'") === 1 && /opening balances/.test(geloescht),
    `F4 ein Kunde mit Eröffnungsbeleg (Darlehen) wird nicht gelöscht (${geloescht.slice(0, 60)})`);
  ok(Math.abs(imbalance(db)) < 0.0005 && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'OPENING_BALANCE'") === 0,
    'F5 Hauptbuch ausgeglichen; B1 hat keine Eröffnungsbuchung erzeugt');
}

// ══ G — Namen überall gleich, Oberfläche ════════════════════════════════════════════════════════════════════════
{
  const MUT = ['opening_accounts.create', 'opening_accounts.cancel'];
  const READ = ['page.opening_accounting.get'];
  const rs = src('src-tauri/src/bridge.rs');
  const rustNames = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rs)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)]
    .map((m) => new RegExp(`pub const ${m[0]}: &str = "([^"]+)"`).exec(rs)?.[1] ?? m[0]);
  const known = registry.knownCommands();
  const fehler: string[] = [];
  for (const op of MUT) {
    if (!registry.ALLOWED_MUTATIONS.includes(op)) fehler.push(`${op}: nicht freigegeben`);
    if (perms.permissionForOp(op)?.kind !== 'isOwner') fehler.push(`${op}: nicht nur Owner`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  for (const op of READ) {
    if (!readOps.STORE_READ_OPS.includes(op) || !(op in perms.READ_PERMISSIONS)) fehler.push(`${op}: Auskunft nicht katalogisiert`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  ok(fehler.length === 0 && rustNames.slice(-8, -5).join(',') === [...MUT, ...READ].join(',') && registry.ALLOWED_MUTATIONS.slice(-5, -3).join(',') === MUT.join(',')
    && !perms.roleMayRunOp('MANAGER', 'opening_accounts.create') && perms.roleMayRunOp('ADMIN', 'opening_accounts.cancel'),
    `G1 zwei Buchungen (nur Owner) und eine Auskunft überall gleich (Freigabe, Recht, Anmeldung, Katalog, Rust, am Ende der Listen) (${fehler.join('; ') || 'konsistent'})`);
  const ui = src('src/components/finance/OpeningAccountingPanel.tsx');
  ok(/w\.save<OpeningAccountItem>\('opening_accounts\.create'/.test(ui) && /w\.save<OpeningAccountItem>\('opening_accounts\.cancel'/.test(ui)
    && /useSharedRead<OpeningAccountingRead \| null>\(\s*OP_PAGE_OPENING_ACCOUNTING_GET/.test(ui) && /if \(!perm\.isOwner\)/.test(ui)
    && /sending\.current/.test(ui) && /data-opening-status/.test(ui) && /data-trial-balance/.test(ui) && /data-cutoff-transactions/.test(ui)
    && !/\bquery\(|getDatabase\(/.test(ui) && /navigate\('\/settings\?tab=opening'\)/.test(src('src/pages/finance/OpeningBalancesPage.tsx')),
    'G2 Oberfläche: nur Owner, Primary und PC2 über dieselben Befehle, Doppelklick-Sperre, PROVISIONAL sichtbar, keine direkte Datenbank');
  // PRE-RELEASE GATE — am PC2 gibt es keine Settings (App.tsx: PrimaryOnlyNotice); die Eröffnungsbilanz steht deshalb auch
  // auf der Seite „Opening balances", die beide Rechner öffnen; der Link zu den Settings nur am Primary.
  const page = src('src/pages/finance/OpeningBalancesPage.tsx');
  ok(/<OpeningAccountingPanel \/>/.test(page) && /\{!isClientMode\(\) && <button onClick=\{\(\) => navigate\('\/settings\?tab=opening'\)\}/.test(page)
    && /path="\/settings" element=\{clientMode \? \(\s*<PrimaryOnlyNotice/.test(src('src/App.tsx')) && /path="\/opening-balances" element=\{<OpeningBalancesPage \/>\}/.test(src('src/App.tsx')),
    'G2b PC2 erreicht die Eröffnungsbilanz über „Opening balances" (Settings gibt es dort nicht); der Settings-Link nur am Primary');
  ok(!/postEntries|postOpening|reverseTransaction|reverseSource/.test(src('src/core/accounting/opening-accounting.ts').replace(/\/\/.*$/gm, ''))
    && !/postEntries|reverseTransaction|reverseSource|INSERT|UPDATE|DELETE/.test(src('src/core/accounting/ledger-statements.ts').replace(/\/\/.*$/gm, '')),
    'G3 die B1-Module enthalten keinen Buchungs- oder Storno-Aufruf; die Abschlüsse lesen nur');
}

// ══ H — B1 FINAL GATE: Lesen nur der Owner (am Primary geprüft), Altbestand nur CURRENT, Card Clearing offen ═══════
{
  freshDb();
  altEroeffnung(1000);
  rec({ ...CASH, amount: 1000 });
  const pid = imHaus(() => useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'Cartier', name: 'Old', quantity: 4, purchasePrice: 250 } as never)).id;
  reload();
  const lies = async (op: string, role: string) => registry.executeCommand(op, { actor: { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role }, input: {} }, undefined) as Promise<{ kind: string; code?: string; value?: { data: Record<string, unknown> } }>;
  const durch: string[] = [];
  for (const op of ['page.opening_accounting.get', 'page.opening_balances.get']) {
    for (const role of ['MANAGER', 'SALES', 'ACCOUNTANT', '', 'admin ']) {
      const r = await lies(op, role);
      if (r.kind !== 'business_error' || r.code !== 'PERMISSION_DENIED' || r.value) durch.push(`${op}/${role || '(none)'}: ${r.kind}`);
    }
  }
  const owner = await lies('page.opening_accounting.get', 'ADMIN');
  const owner2 = await lies('page.opening_balances.get', 'ADMIN');
  ok(durch.length === 0 && owner.kind === 'ok' && owner2.kind === 'ok' && Array.isArray((owner.value?.data as { rows?: unknown[] }).rows),
    `H1 Eröffnungsbilanz und Eröffnungsliste liest am PC2 nur der Owner: Manager, Verkauf, Buchhaltung, ohne Rolle — am Primary abgewiesen, keine Daten (${durch.join('; ') || 'alle zehn abgewiesen'})`);
  ok(/if \(!mayReadOpeningAccounting\(ctx\.role\)\) throw new BusinessError\('PERMISSION_DENIED'/.test(src('src/core/bridge/opening-accounting-commands.ts'))
    && /if \(!mayReadOpeningAccounting\(ctx\.role\)\) throw new BusinessError\('PERMISSION_DENIED'/.test(src('src/core/bridge/party-commands.ts'))
    && /"role": claims\.role/.test(src('src-tauri/src/sync/routes.rs'))
    && /perm\.isOwner \? openingAccountingFor\(ctx, input\) : null/.test(src('src/components/finance/OpeningAccountingPanel.tsx')),
    'H2 die Rolle kommt aus dem geprüften Token (Rust setzt actor, nicht der Client); auch am Primary rechnet die Maske nur für den Owner');
  const r = oa.openingAccountingFor({ branchId: 'branch-main' });
  const stock = row(r, 'OLD_STOCK');
  const sheet = ls.balanceSheetAt({ branchId: 'branch-main' }, CUT);
  ok(eq(stock.range!.low, 1000) && stock.status === 'NOT_VERIFIED' && stock.adjustment === null
    && eq(r.equity.provisionalOpening.withoutOldStock, r.equity.openingBooked + r.equity.draftNet) && r.equity.provisionalOpening.oldStock.included === false
    && r.equity.provisionalOpening.oldStock.verifiedAtCutoff === false && eq(r.equity.provisionalOpening.oldStock.low, 1000)
    && !('withOldStockLow' in r.equity.provisionalOpening) && eq(r.equity.assetsBooked, sheet.totals.assets)
    && r.issues.some((x) => /only the CURRENT value .* NOT VERIFIED and not included in the opening equity/.test(x)) && !!pid,
    'H3 der heutige Altbestandswert (1000) steht nur als CURRENT/NOT VERIFIED da: nicht im rechnerischen Eröffnungskapital, nicht in der Stichtagsbilanz, als offener Punkt gemeldet');
  const card = row(r, 'CARD_CLEARING');
  ok(card.status === 'NOT_VERIFIED' && card.adjustment === null && r.issues.some((x) => /^Card clearing: .* open reconciliation point/.test(x)),
    'H4 Card Clearing ohne Abrechnungsstand zum Stichtag bleibt offener Abstimmungspunkt (NOT VERIFIED), nie abgestimmt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — B1 opening accounting foundation: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

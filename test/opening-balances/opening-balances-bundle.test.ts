// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES & SETTLEMENT BUNDLE — S0 Salden am PC2 vom Primary, S1 Eröffnungsposten von Kunden/Lieferanten
// (Beleg, keine Buchung, strenge Prüfungen, Owner am Primary und PC2), S2 „Receive Payment" über offene Rechnungen
// (FIFO/manuell über den vorhandenen Zahlungsweg), kein stilles Überzahlen (Kunde und Lieferant), Erlass gesperrt.
// Nur künstliche Testdaten. Gerüst aus test/old-stock/old-stock-foundation.test.ts (echte sql.js-Datenbank,
// echte Migrationen, Stores, Hauptbuch).
// Run: node test/opening-balances/opening-balances-bundle.test.ts
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
/** PAYMENT FINAL VERIFICATION — der Stand, den eine Maske jetzt zeigen würde (Kunde bzw. Lieferant). */
const cst = (cid = 'cust-1'): string => cs.customerOpenStamp(cs.customerSettlementInvoices(cid, 'branch-main'));
const sst = (sid = 'sup-1'): string => payHouse.supplierOpenStamp(payHouse.openSupplierItems(sid, 'branch-main'));
async function tryRun(fn: () => Promise<{ kind: string }>): Promise<{ kind: string }> { try { return await fn(); } catch (e) { return { kind: 'thrown:' + (e as Error).message }; } }

const pb = await import('../../src/core/parties/party-balances.ts');
const ob = await import('../../src/core/parties/opening-balances.ts');
const cs = await import('../../src/core/parties/customer-settlement.ts');
const pa = await import('../../src/core/parties/party-account.ts');
const cmdP = await import('../../src/core/bridge/party-commands.ts');
const payHouse = await import('../../src/core/payables/payables-house.ts');
const payCmds = await import('../../src/core/bridge/payables-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const { remoteReadContext } = await import('../../src/core/data/read-context.ts');
const cpa = await import('../../src/core/ledger/counterpartyAudit.ts');
const OCTX = { branchId: 'branch-main', userId: 'user-test', now: NOW, role: 'ADMIN' };

function obIn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { actionId: act(), partyType: 'CUSTOMER', partyId: 'cust-1', kind: 'CUSTOMER_RECEIVABLE', scope: 'DOCUMENT',
    reference: 'ALT-1001', documentDate: '2026-09-30', amount: 1000, priorVat: 'DECLARED_BEFORE', confirmNotInLataif: true, ...over };
}
function rec(over: Record<string, unknown> = {}, ctx: Record<string, unknown> = OCTX): { ok: boolean; code: string; r: Record<string, any> } {
  try { return { ok: true, code: '', r: imHaus(() => ob.recordOpeningItemInHouse(obIn(over) as never, ctx as never)) as never }; }
  catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), r: {} }; }
}
function obState(db: Db): string {
  return S({ items: db.exec('SELECT * FROM opening_balance_items ORDER BY id')[0]?.values, ledger: ledgerCount(db), log: changelog(db),
    audit: audits(db), seq: db.exec("SELECT * FROM document_sequences WHERE doc_type = 'OB'")[0]?.values });
}

// ══ S0 — PC2-Salden: EINE Rechnung am Primary und für die Fernauskunft; unbekannt ist nie 0 ═══════════════════
{
  const cd = src('src/pages/customers/CustomerDetail.tsx');
  const cl = src('src/pages/customers/CustomerList.tsx');
  const sd = src('src/pages/suppliers/SupplierDetail.tsx');
  const id = src('src/pages/invoices/InvoiceDetail.tsx');
  const lokal = /getCustomerStats\(|getAvailableCredit\(|getLedger\(|getSupplierLedger\(/;
  ok(!lokal.test(cd) && !lokal.test(cl) && !lokal.test(sd.replace(/\/\/.*$/gm, '')) && !lokal.test(id),
    'S0-1 Kundendetail, Kundenliste, Lieferantendetail und Rechnung rechnen Salden nicht mehr lokal (getCustomerStats/getAvailableCredit/getLedger)');
  ok([cd, cl, sd, id].every((t) => /usePartyBalances\(/.test(t)) && /data-balance-unknown/.test(cd) && /data-balance-unknown/.test(cl) && /'n\/a'/.test(sd),
    'S0-2 alle vier lesen `parties.balances.get`; ohne Antwort steht „n/a" statt 0,000');
  const hook = src('src/core/parties/use-party-balances.ts');
  ok(/useSharedRead<PartyBalances \| null>\(\s*OP_PARTIES_BALANCES_GET/.test(hook) && /null,\s*\[/.test(hook),
    'S0-3 die Auskunft fällt bei Fehler oder Ladezeit auf null (unbekannt) zurück, nie auf leere Zahlen');

  const db = freshDb();
  product(db, 'p1', 100, 1); product(db, 'p2', 100, 1); reload();
  verkauf('p1', 500);
  const i2 = verkauf('p2', 300);
  imHaus(() => useInvoiceStore.getState().recordPayment(i2, 100, 'cash'));
  insert(db, 'customer_credits', { id: 'cc-1', branch_id: 'branch-main', customer_id: 'cust-1', source_type: 'overpayment', source_id: 'x', amount: 40, used_amount: 0, status: 'OPEN', created_at: NOW });
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-x','branch-2','Fremd','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  reload();
  const lokalStats = useCustomerStore.getState().getCustomerStats('cust-1');
  const fernCtx = remoteReadContext({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' });
  const fern = pb.partyBalancesFor(fernCtx, { customerIds: ['cust-1', 'cust-x', 'nope'], supplierIds: ['sup-1'] });
  const c = new Map(fern.customers).get('cust-1')!;
  ok(fern.customers.length === 1 && eq(c.invoiceOutstanding, 700) && eq(c.outstanding, 700) && eq(c.storeCredit, 40) && c.openInvoiceCount === 2
    && S({ ...lokalStats }) === S(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'storeCredit'))),
    `S0-4 PC2 bekommt dieselben Zahlen wie der Primary (offen 700, Guthaben 40) — fremde Filiale und Unbekanntes fehlen statt 0 (${S(c)})`);
  const sup = new Map(fern.suppliers).get('sup-1')!;
  const supLokal = useSupplierStore.getState().getLedger('sup-1');
  ok(!!sup && S(sup) === S(supLokal), `S0-5 Lieferant: dieselbe Rechnung wie getLedger am Primary (${S(sup)})`);
  let fehler = '';
  try { pb.partyBalancesFor(fernCtx, { customerIds: 'cust-1' }); } catch (e) { fehler = (e as { code?: string }).code ?? ''; }
  let zuViele = '';
  try { pb.partyBalancesFor(fernCtx, { customerIds: Array.from({ length: 5001 }, (_, k) => 'c' + k) }); } catch (e) { zuViele = (e as { code?: string }).code ?? ''; }
  ok(fehler === 'PARTY_BALANCES_INPUT_INVALID' && zuViele === 'PARTY_BALANCES_INPUT_INVALID', 'S0-6 Eingaben streng: Liste statt Text, höchstens 5000 Kennungen');
  ok(registry.knownCommands().includes('parties.balances.get') && readOps.STORE_READ_OPS.includes('parties.balances.get')
    && perms.isOperationCovered('parties.balances.get'), 'S0-7 die Auskunft ist angemeldet und katalogisiert');
  const vorher = useCustomerStore.getState().getAvailableCredit('cust-1');
  ok(eq(vorher, 40), `S0-8 getAvailableCredit am Primary unverändert (Deckel beim Einlösen) (${vorher})`);
}

// ══ S1 — Eröffnungsposten: Beleg, keine Buchung, strenge Prüfungen, Replay, Storno ═══════════════════════════
{
  const db = freshDb();
  product(db, 'p1', 100, 1); reload();
  const invId = verkauf('p1', 250);
  const invNr = s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [invId]);
  const l0 = ledgerCount(db);
  const ar0 = ar(db);
  const a1 = rec();
  const row = a1.ok ? db.exec('SELECT * FROM opening_balance_items WHERE id = ?', [a1.r.id])[0] : null;
  const zeile = row ? Object.fromEntries(row.columns.map((c, i) => [c, row.values[0][i]])) : {};
  ok(a1.ok && /^OB-/.test(String(a1.r.itemNumber)) && zeile.status === 'RECORDED' && zeile.accounting === 'PENDING' && zeile.cutoff_date === '2026-10-15'
    && zeile.reference_key === 'ALT-1001' && Number(zeile.amount) === 1000 && zeile.prior_vat === 'DECLARED_BEFORE',
    `S1-1 Einzelposten (alte Rechnung ALT-1001, 1000 BHD) wird ein nummerierter Beleg, Stichtag 15.10.2026, accounting PENDING (${a1.code || a1.r.itemNumber})`);
  ok(ledgerCount(db) === l0 && eq(ar(db), ar0) && n(db, 'SELECT COUNT(*) FROM invoices') === 1 && n(db, 'SELECT COUNT(*) FROM payments') === 0
    && n(db, 'SELECT COUNT(*) FROM purchases') === 0,
    'S1-2 keine Buchung, keine Rechnung, keine Zahlung, kein Einkauf — die Forderung im Hauptbuch bleibt die der echten Rechnung');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'opening_balance_items'") >= 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'opening_balance_items' AND action_type = 'CREATE'") === 1,
    'S1-3 Sync und Protokoll in derselben Transaktion');

  const vor = obState(db);
  const fails: Array<[string, Record<string, unknown>, string]> = [
    ['ohne Bestätigung', { confirmNotInLataif: false, reference: 'ALT-2' }, 'CONFIRM_NOT_IN_LATAIF'],
    ['ohne Referenz', { reference: '' }, 'REFERENCE_REQUIRED'],
    ['doppelte Referenz (Schreibweise)', { reference: '  alt-1001 ' }, 'DUPLICATE_REFERENCE'],
    ['LATAIF-Rechnungsnummer', { reference: invNr.toLowerCase() }, 'REFERENCE_IS_LATAIF_DOCUMENT'],
    ['falsche Art für Kunden', { kind: 'SUPPLIER_PAYABLE', reference: 'ALT-3' }, 'KIND_INVALID'],
    ['Datum am Stichtag', { documentDate: '2026-10-15', reference: 'ALT-4' }, 'DATE_NOT_BEFORE_CUTOFF'],
    ['Datum in der Zukunft', { documentDate: '2099-01-01', reference: 'ALT-5' }, 'INVALID_DATE'],
    ['vier Nachkommastellen', { amount: 10.0005, reference: 'ALT-6' }, 'AMOUNT_INVALID'],
    ['Betrag 0', { amount: 0, reference: 'ALT-7' }, 'AMOUNT_INVALID'],
    ['fremde Partei', { partyId: 'nope', reference: 'ALT-8' }, 'PARTY_NOT_FOUND'],
    ['unbekannte VAT-Angabe', { priorVat: 'MAYBE', reference: 'ALT-9' }, 'PRIOR_VAT_INVALID'],
  ];
  const bad: string[] = [];
  for (const [name, over, code] of fails) { const r = rec(over); if (r.ok || r.code !== code) bad.push(`${name}: ${r.code || 'ok'}`); }
  ok(bad.length === 0 && obState(db) === vor, `S1-4 jede unzulässige Eingabe wird abgewiesen, nichts geschrieben (${bad.join('; ') || 'alle elf'})`);
  rolle('MANAGER');
  const m = rec({ reference: 'ALT-10' }, { ...OCTX, role: 'MANAGER' });
  rolle('ADMIN');
  ok(!m.ok && m.code === 'PERMISSION_DENIED' && obState(db) === vor, 'S1-5 nur der Owner (Manager abgewiesen, nichts geschrieben)');

  // Restbetrag neben Einzelposten: nur mit ausdrücklicher Bestätigung, höchstens einer
  const r1 = rec({ scope: 'REMAINDER', reference: '', amount: 2500.5 });
  const r2 = rec({ scope: 'REMAINDER', reference: '', amount: 2500.5, confirmNoOverlap: true });
  const r3 = rec({ scope: 'REMAINDER', reference: 'Rest 2', amount: 10, confirmNoOverlap: true });
  const d2 = rec({ reference: 'ALT-11', amount: 300 });
  const d3 = rec({ reference: 'ALT-11b', amount: 300, confirmNoOverlap: true });
  ok(!r1.ok && r1.code === 'CONFIRM_NO_OVERLAP' && r2.ok && !r3.ok && r3.code === 'REMAINDER_EXISTS' && !d2.ok && d2.code === 'CONFIRM_NO_OVERLAP' && d3.ok,
    `S1-6 Einzelposten + Restbetrag nur ausdrücklich ohne Überschneidung, höchstens ein Restbetrag je Art (${r1.code}/${r2.code}/${r3.code}/${d2.code}/${d3.code})`);
  const adv = rec({ kind: 'CUSTOMER_ADVANCE', scope: 'REMAINDER', reference: '', amount: 150, priorVat: 'UNKNOWN' });
  ok(adv.ok && adv.r.kind === 'CUSTOMER_ADVANCE', 'S1-7 Kundenvorauszahlung als eigene Art, neben der Forderung, nicht verrechnet');

  // Replay und Konflikt der Aktionskennung
  const same = obIn({ reference: 'ALT-20', amount: 77, confirmNoOverlap: true });
  const x1 = imHaus(() => ob.recordOpeningItemInHouse(same as never, OCTX as never));
  const nach1 = obState(db);
  const x2 = imHaus(() => ob.recordOpeningItemInHouse(same as never, OCTX as never));
  let konflikt = '';
  try { imHaus(() => ob.recordOpeningItemInHouse({ ...same, amount: 78 } as never, OCTX as never)); } catch (e) { konflikt = (e as { code?: string }).code ?? ''; }
  ok(x1.id === x2.id && obState(db) === nach1 && konflikt === 'ACTION_ID_CONFLICT',
    'S1-8 dieselbe Aktion zweimal: derselbe Beleg, keine zweite Zeile; dieselbe Kennung mit anderem Betrag: abgewiesen');

  // Lieferant: Verbindlichkeit und Vorauszahlung; Einkaufsnummer ist kein Eröffnungsposten
  const sp = rec({ partyType: 'SUPPLIER', partyId: 'sup-1', kind: 'SUPPLIER_PAYABLE', reference: 'LF-77', amount: 850 });
  const sa = rec({ partyType: 'SUPPLIER', partyId: 'sup-1', kind: 'SUPPLIER_ADVANCE', scope: 'REMAINDER', reference: '', amount: 120 });
  const sx = rec({ partyType: 'SUPPLIER', partyId: 'sup-1', kind: 'CUSTOMER_RECEIVABLE', reference: 'LF-78' });
  ok(sp.ok && sa.ok && !sx.ok && sx.code === 'KIND_INVALID' && ledgerCount(db) === l0,
    `S1-9 Lieferant: Verbindlichkeit 850 und Vorauszahlung 120 als Belege, keine Buchung; Kundenarten abgewiesen (${sp.code}/${sa.code}/${sx.code})`);

  // Storno
  const sv = obState(db);
  let ohneGrund = '';
  try { imHaus(() => ob.cancelOpeningItemInHouse({ itemId: a1.r.id, reason: ' ' } as never, OCTX as never)); } catch (e) { ohneGrund = (e as { code?: string }).code ?? ''; }
  let alsManager = '';
  try { imHaus(() => ob.cancelOpeningItemInHouse({ itemId: a1.r.id, reason: 'wrong' } as never, { ...OCTX, role: 'MANAGER' } as never)); } catch (e) { alsManager = (e as { code?: string }).code ?? ''; }
  ok(ohneGrund === 'REASON_REQUIRED' && alsManager === 'PERMISSION_DENIED' && obState(db) === sv, 'S1-10 Storno nur mit Grund und nur durch den Owner');
  const st = imHaus(() => ob.cancelOpeningItemInHouse({ itemId: a1.r.id, reason: 'entered twice' } as never, OCTX as never));
  let zweimal = '';
  try { imHaus(() => ob.cancelOpeningItemInHouse({ itemId: a1.r.id, reason: 'again' } as never, OCTX as never)); } catch (e) { zweimal = (e as { code?: string }).code ?? ''; }
  const neu = rec({ reference: 'ALT-1001', amount: 900, confirmNoOverlap: true });
  ok(st.status === 'CANCELLED' && zweimal === 'ALREADY_CANCELLED' && neu.ok && ledgerCount(db) === l0
    && n(db, 'SELECT COUNT(*) FROM opening_balance_items WHERE id = ?', [a1.r.id]) === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'opening_balance_items' AND action_type = 'STATUS_CHANGE'") === 1,
    `S1-11 Storno: Zeile bleibt (CANCELLED, Grund, Protokoll), kein Hauptbuch; danach darf dieselbe Referenz neu erfasst werden (${neu.code || 'ok'})`);
  db.run("UPDATE opening_balance_items SET accounting = 'POSTED' WHERE id = ?", [neu.r.id]);
  let gebucht = '';
  try { imHaus(() => ob.cancelOpeningItemInHouse({ itemId: neu.r.id, reason: 'x' } as never, OCTX as never)); } catch (e) { gebucht = (e as { code?: string }).code ?? ''; }
  db.run("UPDATE opening_balance_items SET accounting = 'PENDING' WHERE id = ?", [neu.r.id]);
  ok(gebucht === 'BOOKED_NEEDS_REVERSAL', 'S1-12 ein (künftig) gebuchter Posten wird hier nie storniert — nur über eine Gegenbuchung');

  // Teilindizes als letzte Sperre (auch an der Hausfolge vorbei)
  let dupIdx = '';
  try { db.run(`INSERT INTO opening_balance_items (id, branch_id, item_number, party_type, party_id, kind, scope, reference, reference_key, amount, cutoff_date, action_id, payload_hash, created_at)
    VALUES ('dup','branch-main','OB-X','CUSTOMER','cust-1','CUSTOMER_RECEIVABLE','DOCUMENT','alt-1001','ALT-1001',1,'2026-10-15','act-dup','h',?)`, [NOW]); } catch (e) { dupIdx = (e as Error).message; }
  let remIdx = '';
  try { db.run(`INSERT INTO opening_balance_items (id, branch_id, item_number, party_type, party_id, kind, scope, amount, cutoff_date, action_id, payload_hash, created_at)
    VALUES ('rem','branch-main','OB-Y','CUSTOMER','cust-1','CUSTOMER_RECEIVABLE','REMAINDER',1,'2026-10-15','act-rem','h',?)`, [NOW]); } catch (e) { remIdx = (e as Error).message; }
  ok(/UNIQUE/.test(dupIdx) && /UNIQUE/.test(remIdx), 'S1-13 die Datenbank selbst verbietet eine doppelte Referenz und einen zweiten Restbetrag');

  // Bereich der Partei (Auskunft): Posten, Summen je Art, offene LATAIF-Belege, Vorschlag, Vorschau
  const acc = pa.partyAccountReadFor(remoteReadContext({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' }),
    { partyType: 'CUSTOMER', partyId: 'cust-1', preview: { kind: 'CUSTOMER_RECEIVABLE', scope: 'DOCUMENT', reference: 'ALT-1001', amount: 5 } });
  const recv = acc.totals.find((t) => t.kind === 'CUSTOMER_RECEIVABLE')!;
  ok(acc.booking.active === false && eq(recv.amount, 2500.5 + 300 + 77 + 900) && recv.count === 4
    && acc.lataifOpen.length === 1 && acc.lataifOpen[0].number === invNr && eq(acc.lataifOpenTotal, 250)
    && S(recv.proposed) === S([{ account: 'ACCOUNTS_RECEIVABLE', side: 'DEBIT', counterparty: 'CUSTOMER' }, { account: 'OPENING_BALANCE_EQUITY', side: 'CREDIT', counterparty: null }])
    && acc.preview?.code === 'DUPLICATE_REFERENCE' && acc.settlement !== null && acc.settlement.openingItems.length >= 4,
    `S1-14 Auskunft: Summen je Art (nur erfasste), offene LATAIF-Rechnung daneben, Buchungsvorschlag nur als Vorschlag, Vorschau prüft wie das Haus (${S({ a: recv.amount, c: recv.count, p: acc.preview?.code })})`);
  const ov = ob.openingOverviewFor({ branchId: 'branch-main' });
  ok(ov.totals.length === 4 && ov.cancelledCount === 1 && ov.parties.some((p) => p.partyId === 'sup-1' && p.kind === 'SUPPLIER_PAYABLE' && eq(p.amount, 850))
    && ov.cashOpening.bookedOn === '2000-01-01',
    'S1-15 Abstimmungsliste: alle Arten, Lieferanten und Kunden, Stornos gezählt; der Kassen-Anfangsbestand bleibt beim 01.01.2000');
  ok(Math.abs(imbalance(db)) < 0.0005, 'S1-16 das Hauptbuch bleibt ausgeglichen');
  const audit1 = cpa.runCounterpartyAudit((sql, p) => { const r = db.exec(sql, p as never[])[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; }, 'branch-main');
  ok(audit1.arByCustomer.ok && audit1.apBySupplier.ok && audit1.customerCreditByCustomer.ok && audit1.supplierCreditBySupplier.ok,
    'S1-16b Abgleich je Kunde/Lieferant ohne Abweichung: ein nicht gebuchter Eröffnungsposten stört ihn nicht');

  // Kontaktdaten speichern: keine Saldo-Felder, kein Weg in die Eröffnung
  const custCmd = await import('../../src/core/bridge/customer-commands.ts');
  let custFeld = '';
  try { custCmd.parseCustomerFields({ firstName: 'A', openingBalance: 100 }); } catch (e) { custFeld = (e as Error).message; }
  const mr = await import('../../src/core/masterdata/masterdata-rules.ts');
  const supIn = mr.supplierUpdateInput({ name: 'L', openingBalance: 100, amount: 5 } as never) as Record<string, unknown>;
  ok(/unknown field: openingBalance/.test(custFeld) && !('openingBalance' in supIn) && !('amount' in supIn),
    'S1-17 „Save" der Kontaktdaten kennt kein Saldo-Feld (Kunde: abgewiesen; Lieferant: nicht übernommen)');
  const l1 = ledgerCount(db); const o1 = obState(db);
  imHaus(() => useCustomerStore.getState().updateCustomer('cust-1', { notes: 'changed' } as never));
  imHaus(() => useSupplierStore.getState().updateSupplier('sup-1', { phone: '123' } as never));
  ok(ledgerCount(db) === l1 && S(db.exec('SELECT * FROM opening_balance_items ORDER BY id')[0]?.values) === S(JSON.parse(o1).items),
    'S1-18 Kontaktdaten ändern: keine Buchung, kein Eröffnungsposten verändert');
  const cdSrc = src('src/pages/customers/CustomerDetail.tsx');
  const sdSrc = src('src/pages/suppliers/SupplierDetail.tsx');
  ok(/editing && perm\.isOwner && \(\s*<OpeningBalancesSection partyType="CUSTOMER"[^>]*mode="edit"/.test(cdSrc)
    && /editing && perm\.isOwner && \(\s*<OpeningBalancesSection partyType="SUPPLIER"[^>]*mode="edit"/.test(sdSrc)
    && /openingDirty && !\(await window\.confirm\(/.test(cdSrc) && /openingDirty && !\(await window\.confirm\(/.test(sdSrc),
    'S1-19 Edit Client / Supplier Edit: eigener Bereich nur für den Owner; „Save" hält bei nicht erfasster Eingabe an');
  let kundeLoeschen = '';
  try { useCustomerStore.getState().deleteCustomer('cust-1'); } catch (e) { kundeLoeschen = (e as Error).message; }
  let lieferantLoeschen = '';
  try { useSupplierStore.getState().deleteSupplier('sup-1'); } catch (e) { lieferantLoeschen = (e as Error).message; }
  ok(/opening balances/.test(kundeLoeschen) && /opening balance/.test(lieferantLoeschen),
    `S1-20 Kunde/Lieferant mit Eröffnungsposten lässt sich nicht löschen (${kundeLoeschen.slice(0, 60)} | ${lieferantLoeschen.slice(0, 60)})`);
  ok(/accounting: 'PENDING'/.test(src('src/core/parties/opening-balances.ts')) && !/postEntries|postOpening|ACCOUNTS_RECEIVABLE', side: 'DEBIT'.*postEntries/.test(src('src/core/parties/opening-balances.ts').replace(/\/\/.*$/gm, '').replace(/proposedBookingOf[\s\S]*?\n}\n/, ''))
    && ob.OPENING_BOOKING.active === false,
    'S1-21 im Code gibt es keinen Weg, der einen Eröffnungsposten bucht (OPENING_BOOKING aus)');

  // PUSH-GATE 1 — ein erfasster, nicht gebuchter Eröffnungsposten (hier: Forderung 3777,5, Kundenvorauszahlung 150,
  // Lieferantenschuld 850, Lieferantenvorauszahlung 120) steht in KEINEM gebuchten Saldo und auf KEINEM Zahlungsweg.
  const leser = new Set<string>();
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel)) continue;
    const p = 'src/' + rel.replace(/\\/g, '/');
    if (/\bopening_balance_items\b/.test(src(p).replace(/\/\/.*$/gm, ''))) leser.add(p);
  }
  ok(S([...leser].sort()) === S(['src/core/db/database.ts', 'src/core/parties/opening-balances.ts', 'src/stores/customerStore.ts', 'src/stores/supplierStore.ts']),
    `G1-1 die Tabelle lesen nur: Schema, das Eröffnungsmodul, die Löschsperren von Kunde/Lieferant — kein Saldo, kein Zahlungsweg, kein Bericht (${S([...leser].sort())})`);
  const obCode = src('src/core/parties/opening-balances.ts').replace(/\/\/.*$/gm, '');
  ok(!/INSERT INTO (ledger_entries|payments|purchase_payments|expense_payments|customer_credits|supplier_credits|invoices|purchases|expenses|debts)\b/.test(obCode)
    && !/\bpost[A-Z]\w*\(/.test(obCode) && !/\breverse(Source|Transaction)\(/.test(obCode),
    'G1-2 das Eröffnungsmodul schreibt weder Hauptbuch noch Zahlung, Guthaben, Rechnung, Einkauf, Ausgabe oder Darlehen');
  const gesamt = (t: { kind: string; amount: number }[], k: string): number => t.find((x) => x.kind === k)?.amount ?? 0;
  const acc2 = pa.partyAccountReadFor({ branchId: 'branch-main' }, { partyType: 'CUSTOMER', partyId: 'cust-1' });
  const accS = pa.partyAccountReadFor({ branchId: 'branch-main' }, { partyType: 'SUPPLIER', partyId: 'sup-1' });
  ok(gesamt(acc2.totals, 'CUSTOMER_RECEIVABLE') > 0 && gesamt(acc2.totals, 'CUSTOMER_ADVANCE') > 0 && gesamt(accS.totals, 'SUPPLIER_PAYABLE') > 0 && gesamt(accS.totals, 'SUPPLIER_ADVANCE') > 0
    && acc2.items.every((i) => i.accounting === 'PENDING') && accS.items.every((i) => i.accounting === 'PENDING'),
    'G1-3 Ausgangslage: alle vier Arten erfasst, jeder Posten accounting = PENDING (ungebucht erkennbar)');
  const bal = pb.partyBalancesFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' }, { customerIds: ['cust-1'], supplierIds: ['sup-1'] });
  const cb = new Map(bal.customers).get('cust-1')!;
  const sb = new Map(bal.suppliers).get('sup-1')!;
  ok(eq(cb.invoiceOutstanding, ar(db)) && eq(cb.invoiceOutstanding, 250) && eq(cb.storeCredit, 0) && eq(sb.outstandingBalance, 0) && eq(sb.creditBalance, 0),
    `G1-4 gebuchte Salden ohne Eröffnung: Kundenforderung = Hauptbuch 250 (nur die echte Rechnung), Guthaben 0, Lieferant offen 0, Lieferantenguthaben 0 (${S({ ar: cb.invoiceOutstanding, sc: cb.storeCredit, ap: sb.outstandingBalance, scr: sb.creditBalance })})`);
  const { receivablesBreakdown } = await import('../../src/core/finance/receivables.ts');
  const { loadPayablesFor } = await import('../../src/stores/payablesStore.ts');
  const rec2 = receivablesBreakdown('branch-main');
  const pay2 = loadPayablesFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' }).payables;
  ok(rec2.length === 1 && rec2[0].source === 'INVOICE' && eq(rec2.reduce((x, r) => x + r.open, 0), 250) && pay2.every((r) => r.counterpartyId !== 'sup-1'),
    `G1-5 Receivables zeigt nur die echte Rechnung (250), Payables nichts vom Lieferanten (${rec2.length}/${pay2.length})`);
  ok(cs.customerSettlementInvoices('cust-1', 'branch-main').length === 1 && payHouse.openSupplierItems('sup-1', 'branch-main').length === 0,
    'G1-6 „Receive Payment" bietet nur die echte Rechnung an, „Pay Supplier" hat nichts Offenes — Eröffnungsposten sind nicht bezahlbar');
  let payCode = '';
  try { imHaus(() => payHouse.paySupplierInHouse({ supplierId: 'sup-1', expectedOpenStamp: sst(), amount: 850, method: 'cash', mode: 'fifo', confirmExcessAsCredit: true }, { branchId: 'branch-main', userId: 'user-test', now: NOW } as never)); }
  catch (e) { payCode = String((e as { code?: string }).code); }
  let creditCode = '';
  try { imHaus(() => payHouse.applySupplierCreditToExpensesInHouse('sup-1', 120, { branchId: 'branch-main', userId: 'user-test', now: NOW } as never)); }
  catch (e) { creditCode = String((e as { code?: string }).code ?? (e as Error).message); }
  const l9 = ledgerCount(db);
  const custCredit = useCustomerStore.getState().getAvailableCredit('cust-1');
  ok(payCode === 'SUPPLIER_NOTHING_OPEN' && creditCode !== '' && eq(custCredit, 0) && ledgerCount(db) === l9,
    `G1-7 auch mit Gewalt nicht: Lieferantenzahlung 850 (${payCode}), Verrechnung der Vorauszahlung 120 (${creditCode.slice(0, 30)}), Kundenguthaben 0 — keine Buchung`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account IN ('VAT_OUTPUT','VAT_INPUT','MARGIN_VAT','CASH','BANK','BENEFIT','OPENING_BALANCE_EQUITY') AND source_module NOT IN ('INVOICE','PAYMENT')") === 0,
    'G1-8 keine VAT-, Kassen-, Bank-, Benefit- oder Eröffnungskonto-Zeile außer der echten Rechnung');
}

// ══ S1-PC2 — dieselbe Hausfolge über die Fernbefehle: Rolle des Absenders, Replay, Rollback ════════════════════
{
  const db = freshDb();
  reload();
  const d = dps(db);
  const body = { actionId: 'pc2-ob-1-xxxxxxxx', partyType: 'CUSTOMER', partyId: 'cust-1', kind: 'CUSTOMER_RECEIVABLE', scope: 'REMAINDER', amount: 640, confirmNotInLataif: true };
  const vor = obState(db);
  const m = await cmdP.runOpeningAction(ob.recordOpeningItemInHouse as never, cmdP.OPENING_CREATE_KEYS, d, ident('1', 'opening_balances.create'), 'MANAGER', body);
  ok(m.kind === 'rejected' && (m as { code: string }).code === 'PERMISSION_DENIED' && (m as { frozen: boolean }).frozen && obState(db) === vor,
    'P1 PC2 als Manager: abgewiesen und eingefroren, nichts geschrieben');
  const r1 = await cmdP.runOpeningAction(ob.recordOpeningItemInHouse as never, cmdP.OPENING_CREATE_KEYS, d, ident('2', 'opening_balances.create'), 'ADMIN', body);
  const nach = obState(db);
  const r2 = await cmdP.runOpeningAction(ob.recordOpeningItemInHouse as never, cmdP.OPENING_CREATE_KEYS, d, ident('2', 'opening_balances.create'), 'ADMIN', body);
  ok(r1.kind === 'ok' && r2.kind === 'ok' && (r2 as { replayed: boolean }).replayed && obState(db) === nach
    && n(db, "SELECT COUNT(*) FROM opening_balance_items WHERE created_by = 'user-pc2'") === 1,
    'P2 PC2 als Owner: ein Beleg; dieselbe Kennung noch einmal (verlorene Antwort) liefert ihn wieder, keine zweite Zeile');
  let feld = '';
  try { await cmdP.runOpeningAction(ob.recordOpeningItemInHouse as never, cmdP.OPENING_CREATE_KEYS, d, ident('3', 'opening_balances.create'), 'ADMIN', { ...body, actionId: 'pc2-ob-3-xxxxxxxx', accounting: 'POSTED' }); }
  catch (e) { feld = (e as Error).message; }
  ok(/unknown field: accounting/.test(feld), 'P3 der Rumpf ist streng: Buchungslage, Nummer und Wert bestimmt der Primary');
  const vorRb = obState(db);
  const bad = failOn(db, /INSERT INTO audit_log/);
  const rb = await tryRun(() => cmdP.runOpeningAction(ob.recordOpeningItemInHouse as never, cmdP.OPENING_CREATE_KEYS, dps(bad), ident('4', 'opening_balances.create'), 'ADMIN',
    { ...body, actionId: 'pc2-ob-4-xxxxxxxx', scope: 'DOCUMENT', reference: 'RB-1', confirmNoOverlap: true }));
  unfail(db);
  ok(rb.kind !== 'ok' && obState(db) === vorRb, `P4 scheitert das Protokoll, ist auch der Beleg samt Nummer nicht da (Rollback) (${rb.kind})`);
  const id1 = (r1 as { value: Record<string, unknown> }).value.id as string;
  const c1 = await cmdP.runOpeningAction(ob.cancelOpeningItemInHouse as never, cmdP.OPENING_CANCEL_KEYS, d, ident('5', 'opening_balances.cancel'), 'ADMIN', { itemId: id1, reason: 'PC2 test' });
  ok(c1.kind === 'ok' && s(db, 'SELECT status FROM opening_balance_items WHERE id = ?', [id1]) === 'CANCELLED', 'P5 Storno vom PC2 (Owner)');
  ok(perms.permissionForOp('opening_balances.create')?.kind === 'isOwner' && perms.permissionForOp('opening_balances.cancel')?.kind === 'isOwner'
    && perms.roleMayRunOp('ADMIN', 'opening_balances.create') && !perms.roleMayRunOp('MANAGER', 'opening_balances.create') && !perms.roleMayRunOp('', 'opening_balances.cancel'),
    'P6 am Netz entscheidet dieselbe Owner-Regel wie an der Maske');
  const loc = src('src/core/parties/opening-balances.ts');
  ok(/if \(isClientMode\(\)\) return nurPrimary\(\);\s*return runOnPrimary\(\(\) => recordOpeningItemInHouse/.test(loc)
    && /if \(isClientMode\(\)\) return nurPrimary\(\);\s*return runOnPrimary\(\(\) => cancelOpeningItemInHouse/.test(loc),
    'P7 der lokale Anschluss schreibt am PC2 nie selbst (nur über den Primary)');
}

// ══ S2 — „Receive Payment" am Kunden: FIFO / manuell über den vorhandenen Zahlungsweg ════════════════════════
{
  const db = freshDb();
  for (const p of ['a', 'b', 'c']) product(db, p, 100, 1);
  reload();
  const ia = verkauf('a', 400, '2026-09-01T10:00:00.000Z');
  const ib = verkauf('b', 300, '2026-09-10T10:00:00.000Z');
  const ic = verkauf('c', 200, '2026-10-01T10:00:00.000Z');
  imHaus(() => useInvoiceStore.getState().recordPayment(ia, 100, 'cash'));
  const offen0 = ar(db);
  const rev0 = Number(one(db, "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = 'REVENUE'") ?? 0);
  const items = cs.customerSettlementInvoices('cust-1', 'branch-main');
  ok(items.map((i) => i.id).join(',') === [ia, ib, ic].join(',') && items.map((i) => i.openF).join(',') === '300000,300000,200000',
    'S2-1 offene Rechnungen, älteste zuerst, mit ihrem Offenen (400−100, 300, 200)');
  const plan = cs.planCustomerSettlement(items, 450_000, 'fifo');
  ok(S(plan.allocations.map((a) => [a.invoiceId === ia ? 'a' : a.invoiceId === ib ? 'b' : 'c', a.amountF])) === S([['a', 300000], ['b', 150000]]) && plan.excessF === 0,
    'S2-2 FIFO-Vorschau: 450 → Rechnung a voll (300), b teilweise (150)');
  const r = await cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount: 450, method: 'cash', mode: 'fifo' });
  reload();
  ok(r.allocations.length === 2 && inv(db, ia).status === 'FINAL' && eq(Number(inv(db, ia).paid_amount), 400) && inv(db, ib).status === 'PARTIAL'
    && eq(Number(inv(db, ib).paid_amount), 150) && eq(Number(inv(db, ic).paid_amount), 0) && n(db, 'SELECT COUNT(*) FROM payments') === 3,
    `S2-3 zwei gewöhnliche Rechnungszahlungen: a vollständig (FINAL, Endnummer ${r.allocations[0]?.invoiceNumber}), b teilweise, c unberührt`);
  const rev1 = Number(one(db, "SELECT COALESCE(SUM(CASE WHEN direction='CREDIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = 'REVENUE'") ?? 0);
  ok(eq(ar(db), offen0 - 450) && eq(rev1, rev0) && Math.abs(imbalance(db)) < 0.0005
    && eq(Number(one(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = 'CASH'") ?? 0), 550),
    'S2-4 Hauptbuch: Forderung −450, Kasse +450 (insgesamt 550), kein neuer Umsatz, ausgeglichen');
  // manuell
  const vorM = S(db.exec('SELECT * FROM payments ORDER BY id')[0]?.values);
  const fehler: string[] = [];
  for (const [allocs, amount, code] of [
    [[{ invoiceId: ic, amount: 50 }], 60, 'ALLOCATION_SUM_MISMATCH'],
    [[{ invoiceId: ic, amount: 250 }], 250, 'ALLOCATION_EXCEEDS_REMAINING'],
    [[{ invoiceId: ia, amount: 10 }], 10, 'ALLOCATION_UNKNOWN_ITEM'],
    [[{ invoiceId: ic, amount: 10 }, { invoiceId: ic, amount: 10 }], 20, 'ALLOCATION_DUPLICATE'],
  ] as Array<[Array<{ invoiceId: string; amount: number }>, number, string]>) {
    const code2 = await meldungAsync(() => cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount, method: 'bank_transfer', mode: 'manual', allocations: allocs }));
    if (!code2.startsWith(code + '|')) fehler.push(`${code}: ${code2.slice(0, 40)}`);
  }
  ok(fehler.length === 0 && S(db.exec('SELECT * FROM payments ORDER BY id')[0]?.values) === vorM, `S2-5 manuell: falsche Verteilungen abgewiesen, nichts gezahlt (${fehler.join('; ') || 'alle vier'})`);
  const mok = await cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount: 120, method: 'bank_transfer', mode: 'manual', allocations: [{ invoiceId: ic, amount: 100 }, { invoiceId: ib, amount: 20 }] });
  reload();
  ok(mok.allocations.length === 2 && eq(Number(inv(db, ic).paid_amount), 100) && eq(Number(inv(db, ib).paid_amount), 170),
    'S2-6 manuell: der Benutzer verteilt selbst (c 100, b 20) — Teilzahlungen, korrekte Reste');
  // Überzahlung: nie still
  const vorX = S(db.exec('SELECT * FROM payments ORDER BY id')[0]?.values);
  const offenJetzt = cs.customerSettlementInvoices('cust-1', 'branch-main').reduce((x, i) => x + i.openF, 0) / 1000;
  const still = await meldungAsync(() => cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount: offenJetzt + 25, method: 'cash', mode: 'fifo' }));
  ok(still.startsWith('PAYMENT_EXCEEDS_OPEN|') && S(db.exec('SELECT * FROM payments ORDER BY id')[0]?.values) === vorX,
    `S2-7 mehr als alles Offene (${offenJetzt} + 25) ohne Wahl: abgewiesen, nichts gezahlt`);
  const cc0 = n(db, 'SELECT COUNT(*) FROM customer_credits');
  const xr = await cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount: offenJetzt + 25, method: 'cash', mode: 'fifo', confirmExcessAsCredit: true });
  reload();
  ok(xr.excessTo === 'store_credit' && eq(xr.excessAmount, 25) && n(db, 'SELECT COUNT(*) FROM customer_credits') === cc0 + 1
    && eq(Number(one(db, "SELECT amount FROM customer_credits WHERE source_type = 'overpayment' ORDER BY created_at DESC LIMIT 1") ?? 0), 25)
    && eq(ar(db), 0) && cs.customerSettlementInvoices('cust-1', 'branch-main').length === 0 && Math.abs(imbalance(db)) < 0.0005,
    'S2-8 mit ausdrücklicher Wahl: Rest 25 wird Store-Guthaben nach der bestehenden Überzahlungsregel; alles bezahlt, Forderung 0');
  const audit = cpa.runCounterpartyAudit((sql, p) => { const r = db.exec(sql, p as never[])[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; }, 'branch-main');
  ok(audit.arByCustomer.ok && audit.customerCreditByCustomer.ok && audit.apBySupplier.ok && audit.supplierCreditBySupplier.ok,
    `S2-10 Abgleich Hauptbuch ↔ Belege je Kunde/Lieferant nach Sammelzahlung und Guthaben ohne Abweichung (${S([audit.arByCustomer.mismatches, audit.customerCreditByCustomer.mismatches, audit.apBySupplier.mismatches, audit.supplierCreditBySupplier.mismatches])})`);
  const nichts = await meldungAsync(() => cs.settleCustomerOnPrimary({ customerId: 'cust-1', expectedOpenStamp: cst(), amount: 5, method: 'cash', mode: 'fifo' }));
  ok(nichts.startsWith('CUSTOMER_NOTHING_OPEN|'), 'S2-9 ohne offene Rechnung keine Zahlung (eine Vorauszahlung hat ihren eigenen Weg)');
}

// ══ S2-PC2, Atomarität, VAT-Periodenschutz, Erlass gesperrt ════════════════════════════════════════════════════
{
  const db = freshDb();
  for (const p of ['a', 'b']) product(db, p, 100, 1);
  reload();
  const ia = verkauf('a', 100, '2026-09-01T10:00:00.000Z');
  const ib = verkauf('b', 100, '2026-09-02T10:00:00.000Z');
  const d = dps(db);
  const state = (): string => S({ p: db.exec('SELECT * FROM payments ORDER BY id')[0]?.values, i: db.exec('SELECT id, paid_amount, status, invoice_number FROM invoices ORDER BY id')[0]?.values, l: ledgerCount(db) });
  const st11 = cst();
  const r1 = await cmdP.runCustomerSettle(d, ident('11', 'customers.settle'), { customerId: 'cust-1', expectedOpenStamp: st11, amount: 150, method: 'cash', mode: 'fifo' });
  reload();
  const nach = state();
  const r2 = await cmdP.runCustomerSettle(d, ident('11', 'customers.settle'), { customerId: 'cust-1', expectedOpenStamp: st11, amount: 150, method: 'cash', mode: 'fifo' });
  ok(r1.kind === 'ok' && (r2 as { replayed?: boolean }).replayed === true && state() === nach && eq(Number(inv(db, ia).paid_amount), 100) && eq(Number(inv(db, ib).paid_amount), 50),
    'Z1 PC2 „Receive Payment": dieselbe Verteilung am Primary; dieselbe Kennung noch einmal zahlt nichts doppelt');
  let waiver = '';
  try { cmdP.parseCustomerSettle({ customerId: 'cust-1', amount: 10, method: 'cash', mode: 'fifo', waiver: 5 }); } catch (e) { waiver = String((e as { code?: string }).code); }
  let writeOff = '';
  try { cmdP.parseCustomerSettle({ customerId: 'cust-1', amount: 10, method: 'cash', mode: 'fifo', writeOffAmount: 5 }); } catch (e) { writeOff = String((e as { code?: string }).code); }
  ok(waiver === 'WAIVER_BOOKING_BLOCKED' && writeOff === 'WAIVER_BOOKING_BLOCKED' && cs.WAIVER_BOOKING.active === false
    && !registry.ALLOWED_MUTATIONS.some((op) => /waiver|write_off|writeoff/i.test(op) && !op.startsWith('bulk_metals.')),
    'Z2 Erlass gesperrt: kein Feld, kein Fernbefehl (fail-closed bis W1–W3)');
  const wv = cs.previewPaymentAndWaiver(1_000_000, 900_000, 100_000);
  const wv2 = cs.previewPaymentAndWaiver(1_000_000, 850_000, 150_000);
  ok(wv.paidF === 900_000 && wv.waivedF === 100_000 && wv.restF === 0 && wv2.paidF === 850_000 && wv2.waivedF === 150_000 && wv2.restF === 0,
    'Z3 Vorschau Zahlung + Erlass rechnet getrennt (1000 = 900 gezahlt + 100 erlassen; 1000 = 850 + 150), Erlass gilt nie als gezahlt');
  // Atomar: die zweite Teilzahlung scheitert → auch die erste ist nicht da
  product(db, 'c', 100, 1); reload();
  verkauf('c', 100, '2026-09-03T10:00:00.000Z');
  const vor = state();
  const bad = failOn(db, /INSERT INTO payments/, 2);
  const rb = await tryRun(() => cmdP.runCustomerSettle(dps(bad), ident('12', 'customers.settle'), { customerId: 'cust-1', expectedOpenStamp: cst(), amount: 100, method: 'cash', mode: 'fifo' }));
  unfail(db);
  reload();
  ok(rb.kind !== 'ok' && state() === vor, `Z4 scheitert die zweite Teilzahlung, ist auch die erste nicht da (Rollback der ganzen Verteilung) (${rb.kind})`);
  // VAT-Periodenschutz wird geerbt: eine Zahlung, die heute eine Rechnung abschließt, in einem gemeldeten Quartal
  const heute = new Date();
  const q = Math.floor(heute.getMonth() / 3) + 1;
  insert(db, 'vat_filings', { id: 'vf-1', branch_id: 'branch-main', year: heute.getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
  const vorV = state();
  const vat = await cmdP.runCustomerSettle(d, ident('14', 'customers.settle'), { customerId: 'cust-1', expectedOpenStamp: cst(), amount: 50, method: 'cash', mode: 'fifo' });
  reload();
  ok(vat.kind === 'rejected' && (vat as { code: string }).code === 'VAT_PERIOD_FILED' && state() === vorV,
    `Z5 VAT-Periodenschutz wie bei der Einzelzahlung: schließt die Zahlung eine Rechnung in ein gemeldetes Quartal, wird nichts gezahlt (${(vat as { code?: string }).code})`);
  ok(perms.permissionForOp('customers.settle') === perms.permissionForOp('invoices.record_payment') && registry.knownCommands().includes('customers.settle'),
    'Z6 „Receive Payment" verlangt dasselbe Recht wie „Record Payment" auf der Rechnung');
}

// ══ S2-Lieferant — Pay Supplier: kein stilles Überzahlen mehr ═════════════════════════════════════════════════
{
  const db = freshDb();
  reload();
  insert(db, 'expenses', { id: 'e1', branch_id: 'branch-main', expense_number: 'EXP-1', category: 'Repair', amount: 40, paid_amount: 0, status: 'PENDING', supplier_id: 'sup-1', expense_date: '2026-10-01', created_at: NOW });
  const vor = S({ e: db.exec('SELECT * FROM expenses')[0]?.values, l: ledgerCount(db), c: n(db, 'SELECT COUNT(*) FROM supplier_credits') });
  const still = await (async () => { try { imHaus(() => payHouse.paySupplierInHouse({ supplierId: 'sup-1', expectedOpenStamp: sst(), amount: 50, method: 'cash', mode: 'fifo' }, { branchId: 'branch-main', userId: 'user-test', now: NOW } as never)); return ''; } catch (e) { return String((e as { code?: string }).code); } })();
  ok(still === 'PAYMENT_EXCEEDS_OPEN' && S({ e: db.exec('SELECT * FROM expenses')[0]?.values, l: ledgerCount(db), c: n(db, 'SELECT COUNT(*) FROM supplier_credits') }) === vor,
    'L1 Pay Supplier über allem Offenen ohne Wahl: abgewiesen, nichts gezahlt');
  const okR = imHaus(() => payHouse.paySupplierInHouse({ supplierId: 'sup-1', expectedOpenStamp: sst(), amount: 50, method: 'cash', mode: 'fifo', confirmExcessAsCredit: true }, { branchId: 'branch-main', userId: 'user-test', now: NOW } as never));
  ok(okR.excessTo === 'standalone_credit' && eq(okR.excessAmount, 10), 'L2 mit ausdrücklicher Wahl: Rest 10 wird Lieferantenguthaben (bestehende Regel)');
  let typ = '';
  try { payCmds.parseSupplierPay({ supplierId: 'sup-1', amount: 5, method: 'cash', mode: 'fifo', confirmExcessAsCredit: 'yes' }); } catch (e) { typ = (e as Error).message; }
  ok(/true or false/.test(typ) && payCmds.parseSupplierPay({ supplierId: 'sup-1', amount: 5, method: 'cash', mode: 'fifo', confirmExcessAsCredit: true }).confirmExcessAsCredit === true,
    'L3 der Rumpf trägt die Wahl als Ja/Nein');
  ok(/confirmExcessAsCredit: true/.test(src('src/components/expenses/PaySupplierModal.tsx')) && /data-supplier-pay-locked/.test(src('src/components/expenses/PaySupplierModal.tsx')),
    'L4 die Maske fragt bei jedem Überschuss ausdrücklich und zeigt: Eröffnungsposten und Erlass noch gesperrt');
  // PUSH-GATE 2 — im Browser zahlte ein Doppelklick auf „Receive payment" zweimal (zwei Rückfragen, zwei Zahlungen).
  // Beide Zahlmasken sperren jetzt VOR der Rückfrage: eine Absicht, ein Vorgang.
  const csm = src('src/components/parties/CustomerSettlementModal.tsx');
  const psm = src('src/components/expenses/PaySupplierModal.tsx');
  ok(/if \(sending\.current \|\| !planOk \|\| waiverF > 0\) return;\s*sending\.current = true;/.test(csm) && /if \(!done\) sending\.current = false;/.test(csm)
    && csm.indexOf('sending.current = true') < csm.indexOf('window.confirm(')
    && /if \(sending\.current \|\| busy \|\| !supplierId \|\| totalAmount <= 0\) return;\s*sending\.current = true;/.test(psm)
    && psm.indexOf('sending.current = true') < psm.indexOf('window.confirm('),
    'L5 Doppelklick-Sperre in „Receive payment" und „Pay Supplier": gesperrt vor der Rückfrage, nach Erfolg bleibt sie zu');
  ok(/useCustomerReads\(id, balanceTick\)/.test(src('src/pages/customers/CustomerDetail.tsx')),
    'L6 nach „Receive Payment" lädt die Zahlungsliste der Kundenseite neu (vorher stand sie still)');
}

// ══ PAYMENT FINAL VERIFICATION — doppelte/wiederholte Zahlungsaufträge serverseitig sicher ═══════════════════════
// Dieselbe Kennung (Netzwiederholung vom PC2) → Antwort aus dem durablen Nachweis (Z1, L-Replay). Eine NEUE Kennung oder der
// Primary selbst (keine Kennung) mit DERSELBEN Absicht → der gesehene Stand passt nicht mehr → abgewiesen, nichts gezahlt.
{
  const db = freshDb();
  for (const p of ['a', 'b']) product(db, p, 100, 1);
  reload();
  verkauf('a', 1980, '2026-09-01T10:00:00.000Z');
  const ib = verkauf('b', 4620, '2026-09-02T10:00:00.000Z');
  const zahlungen = (): number => n(db, 'SELECT COUNT(*) FROM payments');
  const zustand = (): string => S({ p: db.exec('SELECT id, amount FROM payments ORDER BY id')[0]?.values, l: ledgerCount(db), i: db.exec('SELECT id, paid_amount FROM invoices ORDER BY id')[0]?.values });
  // Primary: zweimal derselbe Auftrag (z. B. Doppelklick an der Sperre vorbei)
  const st = cst();
  const body = { customerId: 'cust-1', amount: 500, method: 'cash', mode: 'manual' as const, allocations: [{ invoiceId: ib, amount: 500 }], expectedOpenStamp: st };
  await cs.settleCustomerOnPrimary(body);
  const nach1 = zustand();
  const zweit = await meldungAsync(() => cs.settleCustomerOnPrimary(body));
  ok(zweit.startsWith('OPEN_ITEMS_CHANGED|') && zustand() === nach1 && zahlungen() === 1 && eq(Number(inv(db, ib).paid_amount), 500),
    `X1 Primary: derselbe Auftrag ein zweites Mal → abgewiesen (OPEN_ITEMS_CHANGED), genau EINE Zahlung, B 500 bezahlt (${zweit.split('|')[0]})`);
  const ohne = await meldungAsync(() => cs.settleCustomerOnPrimary({ ...body, expectedOpenStamp: undefined }));
  ok(ohne.startsWith('OPEN_STAMP_REQUIRED|') && zustand() === nach1, 'X2 ohne gesehenen Stand keine Zahlung (OPEN_STAMP_REQUIRED)');
  // PC2: zwei Fenster / zwei Kennungen mit derselben Absicht
  const d = dps(db);
  const st2 = cst();
  const fern1 = await cmdP.runCustomerSettle(d, ident('31', 'customers.settle'), { customerId: 'cust-1', amount: 300, method: 'cash', mode: 'fifo', expectedOpenStamp: st2 });
  reload();
  const nachF = zustand();
  const fern2 = await cmdP.runCustomerSettle(d, ident('32', 'customers.settle'), { customerId: 'cust-1', amount: 300, method: 'cash', mode: 'fifo', expectedOpenStamp: st2 });
  const fern1b = await cmdP.runCustomerSettle(d, ident('31', 'customers.settle'), { customerId: 'cust-1', amount: 300, method: 'cash', mode: 'fifo', expectedOpenStamp: st2 });
  reload();
  ok(fern1.kind === 'ok' && fern2.kind === 'rejected' && (fern2 as { code: string }).code === 'OPEN_ITEMS_CHANGED' && (fern2 as { frozen: boolean }).frozen
    && (fern1b as { replayed?: boolean }).replayed === true && zustand() === nachF && zahlungen() === 2,
    'X3 PC2: zweite Kennung mit derselben Absicht abgewiesen (eingefroren); Wiederholung der ersten Kennung = Antwort aus dem Nachweis; insgesamt zwei Zahlungen (500 + 300)');
  let lang = '';
  try { cmdP.parseCustomerSettle({ customerId: 'cust-1', amount: 1, method: 'cash', mode: 'fifo', expectedOpenStamp: 'x'.repeat(65) }); } catch (e) { lang = (e as Error).message; }
  ok(/expectedOpenStamp must be text/.test(lang), 'X4 der gesehene Stand ist ein kurzer Text');

  // Lieferant: dieselben Fälle über „Pay Supplier — Bulk"
  insert(db, 'expenses', { id: 'e1', branch_id: 'branch-main', expense_number: 'EXP-1', category: 'Repair', amount: 40, paid_amount: 0, status: 'PENDING', supplier_id: 'sup-1', expense_date: '2026-10-01', created_at: NOW });
  insert(db, 'expenses', { id: 'e2', branch_id: 'branch-main', expense_number: 'EXP-2', category: 'Repair', amount: 60, paid_amount: 0, status: 'PENDING', supplier_id: 'sup-1', expense_date: '2026-10-02', created_at: NOW });
  const HC = { branchId: 'branch-main', userId: 'user-test', now: NOW } as never;
  const ss = sst();
  const sb = { supplierId: 'sup-1', amount: 30, method: 'cash', mode: 'fifo' as const, expectedOpenStamp: ss };
  imHaus(() => payHouse.paySupplierInHouse(sb, HC));
  const ep = (): number => n(db, 'SELECT COUNT(*) FROM expense_payments');
  let lz = '';
  try { imHaus(() => payHouse.paySupplierInHouse(sb, HC)); } catch (e) { lz = String((e as { code?: string }).code); }
  let lo = '';
  try { imHaus(() => payHouse.paySupplierInHouse({ ...sb, expectedOpenStamp: undefined }, HC)); } catch (e) { lo = String((e as { code?: string }).code); }
  ok(lz === 'OPEN_ITEMS_CHANGED' && lo === 'OPEN_STAMP_REQUIRED' && ep() === 1, `X5 Lieferant am Primary: derselbe Auftrag zweimal → eine Zahlung; ohne gesehenen Stand keine (${lz}/${lo}/${ep()})`);
  const ss2 = sst();
  const p1 = await payCmds.runSupplierPay(d, ident('41', 'suppliers.pay'), { supplierId: 'sup-1', amount: 20, method: 'cash', mode: 'fifo', expectedOpenStamp: ss2 });
  const p2 = await payCmds.runSupplierPay(d, ident('42', 'suppliers.pay'), { supplierId: 'sup-1', amount: 20, method: 'cash', mode: 'fifo', expectedOpenStamp: ss2 });
  const p1b = await payCmds.runSupplierPay(d, ident('41', 'suppliers.pay'), { supplierId: 'sup-1', amount: 20, method: 'cash', mode: 'fifo', expectedOpenStamp: ss2 });
  ok(p1.kind === 'ok' && p2.kind === 'rejected' && (p2 as { code: string }).code === 'OPEN_ITEMS_CHANGED' && (p1b as { replayed?: boolean }).replayed === true && ep() === 3
    && eq(Number(one(db, "SELECT paid_amount FROM expenses WHERE id = 'e1'")), 40) && eq(Number(one(db, "SELECT paid_amount FROM expenses WHERE id = 'e2'")), 10),
    'X6 Lieferant am PC2: zweite Kennung abgewiesen, Wiederholung der ersten = Antwort aus dem Nachweis; nur 30 + 20 gezahlt (e1 40, e2 10; drei Zuordnungszeilen)');
  ok(/expectedOpenStamp: supplierOpenStamp\(openItems\)/.test(src('src/components/expenses/PaySupplierModal.tsx'))
    && /expectedOpenStamp: data\?\.settlement\?\.openStamp/.test(src('src/components/parties/CustomerSettlementModal.tsx')),
    'X7 beide Masken schicken den Stand mit, den sie zeigen');
  ok(Math.abs(imbalance(db)) < 0.0005, 'X8 Hauptbuch ausgeglichen');
}

// ══ N — Namen überall gleich: Freigabe, Recht, Anmeldung, Katalog, Rust ═══════════════════════════════════════
{
  const MUT = ['opening_balances.create', 'opening_balances.cancel', 'customers.settle'];
  const READ = ['parties.balances.get', 'parties.account.get', 'page.opening_balances.get'];
  const rs = src('src-tauri/src/bridge.rs');
  const rustNames = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rs)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)]
    .map((m) => new RegExp(`pub const ${m[0]}: &str = "([^"]+)"`).exec(rs)?.[1] ?? m[0]);
  const known = registry.knownCommands();
  const fehler: string[] = [];
  for (const op of MUT) {
    if (!registry.ALLOWED_MUTATIONS.includes(op)) fehler.push(`${op}: nicht freigegeben`);
    if (!perms.OPERATION_PERMISSIONS[op]) fehler.push(`${op}: kein Recht`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  for (const op of READ) {
    if (!readOps.STORE_READ_OPS.includes(op) || !(op in perms.READ_PERMISSIONS)) fehler.push(`${op}: Auskunft nicht katalogisiert`);
    if (!known.includes(op)) fehler.push(`${op}: nicht angemeldet`);
    if (!rustNames.includes(op)) fehler.push(`${op}: Rust kennt es nicht`);
  }
  ok(fehler.length === 0 && rustNames.slice(-7, -1).join(',') === [...MUT, ...READ].join(',') && registry.ALLOWED_MUTATIONS.slice(-4, -1).join(',') === MUT.join(','),
    `N1 drei Buchungen und drei Auskünfte überall gleich (Freigabe, Recht, Anmeldung, Katalog, Rust) (${fehler.join('; ') || 'konsistent'})`);
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_operations: string[]; allowed_fields: string[] }> };
  const t = manifest.tables.opening_balance_items;
  const cols = (freshDb().exec('PRAGMA table_info(opening_balance_items)')[0]?.values ?? []).map((v) => String(v[1])).sort();
  ok(!!t && S(t.allowed_operations) === S(['insert', 'update']) && S([...t.allowed_fields].sort()) === S(cols),
    'N2 Sync: opening_balance_items reist zum Spiegel (insert/update, nie delete), alle Spalten im Manifest');
}

console.log(`
${fails.length === 0 ? 'PASS' : 'FAIL'} — opening balances bundle: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

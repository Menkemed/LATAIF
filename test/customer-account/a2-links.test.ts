// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A2 — Partner ↔ Kunde (P1) und Darlehen → Kunde (P2): ausdrückliche Verknüpfung mit Rückfrage,
// Protokoll, Sperren gegen Doppel-/Umzuordnung, Primary und PC2 (Transaktion, Wiederholungsschutz), und das Kundenkonto
// zählt danach genau einmal — ohne Änderung an Beteiligungen, Abrechnungen, Beträgen, Status oder Buchungen.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/customer-account.test.ts.
// Run: node test/customer-account/a2-links.test.ts
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
const { useCustomerStore, customerStatsFor, customerStoreCreditFor } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { usePartnerStore } = await import('../../src/stores/partnerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const house = await import('../../src/core/partners/item-participation-house.ts');
const save = await import('../../src/core/partners/item-participation-save.ts');
const recv = await import('../../src/core/finance/receivables.ts');
const payS = await import('../../src/stores/payablesStore.ts');
const pageReads = await import('../../src/core/data/page-reads.ts');
await import('../../src/core/bridge/party-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const ca = await import('../../src/core/parties/customer-account.ts');
const pa = await import('../../src/core/parties/party-account.ts');

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
  export(): Uint8Array;
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
  useInvoiceStore.getState().loadInvoices();
  usePurchaseStore.getState().loadPurchases();
  usePartnerStore.getState().loadPartners();
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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  const kunde = (id: string, branch: string, fn: string, ln: string, phone: string | null): void => {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, phone, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,?,?,'BH','en',0,'[]','collector','active',?,?)`, [id, branch, fn, ln, phone, NOW, NOW]);
  };
  kunde('cust-1', 'branch-main', 'Ahmed', 'Karimi', '+973 3300 0001');
  kunde('cust-2', 'branch-main', 'Other', 'Client', '+973 3999 9999');
  kunde('cust-x', 'branch-2', 'Fremd', 'Kunde', null);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, phone, linked_customer_id, active, created_at, updated_at) VALUES ('sup-ak','branch-main','Ahmed Karimi','+97333000001','cust-1',1,?,?)", [NOW, NOW]);
  for (const [id, name, phone] of [['pa-ak', 'Bashir Partner', '+97333000001'], ['pa-b', 'Bashir', null]] as Array<[string, string, string | null]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, phone, share_percentage, active, created_at, updated_at)
      VALUES (?, 'branch-main', ?, ?, 0, 1, ?, ?)`, [id, name, phone, NOW, NOW]);
  }
  for (let i = 1; i <= 12; i++) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',0,'BHD',1300,?,'ZERO',0,'[]','{}','OWN',?,?)`,
    // pk1–pk4 liegen zum Verkauf bereit; pk5–pk12 kommen erst über einen Einkauf ins Lager (wie im Partnertest).
    ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, i <= 4 ? 1 : 0, i <= 4 ? 'in_stock' : 'sold', NOW, NOW]);
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
const ar = (db: Db, cid = 'cust-1'): number => n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
  WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_type = 'CUSTOMER' AND counterparty_id = ?`, [cid]);

const DB = freshDb();
const CTX = { branchId: 'branch-main' };
const acc = () => ca.customerAccountFor(CTX, 'cust-1');
const sumOpen = (a: ReturnType<typeof acc>, pred: (d: ReturnType<typeof acc>['docs'][number]) => boolean): number =>
  a.docs.filter(pred).reduce((t, d) => t + F(d.open), 0) / 1000;
const sale = (pid: string, price: number, date: string, customerId = 'cust-1'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, [{ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'CA-TEST', date).id);
  reload();
  return id;
};

void ar; void sale;
const md = await import('../../src/core/bridge/masterdata-commands.ts');
const mc = await import('../../src/core/bridge/money-commands.ts');
const money = await import('../../src/core/finance/money-house.ts');
const { usePartnerStore: PS } = await import('../../src/stores/partnerStore.ts');

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000a2`;
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
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
const zeilen = (sql: string, p: unknown[] = []): string => S(DB.exec(sql, p)[0]?.values ?? []);
const audits = (entity: string, id: string): number => n(DB, 'SELECT COUNT(*) FROM audit_log WHERE entity_type = ? AND entity_id = ? AND field_name = ?', [entity, id, entity === 'partners' ? 'linked_customer_id' : 'customer_id']);
/** Was eine Verknüpfung NIE berühren darf: Beteiligungen, Bewegungen, Buchungen, Darlehenszahlen und -zahlungen. */
const unberuehrt = (): string => S([
  zeilen('SELECT * FROM item_participations ORDER BY id'), zeilen('SELECT * FROM item_partner_movements ORDER BY id'),
  zeilen('SELECT id, account, direction, amount, counterparty_type, counterparty_id FROM ledger_entries ORDER BY rowid'),
  zeilen('SELECT id, amount, status, counterparty, direction, source FROM debts ORDER BY id'), zeilen('SELECT * FROM debt_payments ORDER BY id'),
  zeilen('SELECT id, name, phone, share_percentage, active FROM partners ORDER BY id'),
]);
const linkOf = (pid: string): string => s(DB, "SELECT COALESCE(linked_customer_id, '') FROM partners WHERE id = ?", [pid]);
const debtCustomer = (id: string): string => s(DB, "SELECT COALESCE(customer_id, '') FROM debts WHERE id = ?", [id]);
const HCTX = { branchId: 'branch-main', userId: 'user-test' };

// ── Welt: Ahmed (cust-1, Telefon wie Partner pa-ak), ein zweiter Kunde, ein Kunde einer anderen Filiale, ein System-Kunde.
DB.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
  VALUES ('sys-walkin','branch-main','Walk','In','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
insert(DB, 'partners', { id: 'pa-c', branch_id: 'branch-main', name: 'Chalid', share_percentage: 0, active: 1, created_at: NOW, updated_at: NOW });
const customerUpdatedAt = (id: string): string => s(DB, 'SELECT updated_at FROM customers WHERE id = ?', [id]);
// Partner pa-ak: gemeinsamer Einkauf 1.000 (50 %), noch nichts eingezahlt → schuldet 500 (Kostenanteil, wie Receivables).
const EINKAUF = (pid: string, price: number) => ({
  supplierId: 'sup-1', purchaseDate: '2026-10-12', taxScheme: 'ZERO', paymentAmount: price, paymentMethod: 'bank', notes: '', staffId: '',
  lines: [{ mode: 'existing', productId: pid, brand: 'Rolex', name: 'Sub ' + pid, sku: 'SKU-' + pid, categoryId: 'cat-w', quantity: 1, unitPrice: price,
    partnerShares: [{ partnerId: 'pa-ak', sharePct: 50 }] }],
});
const K = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF('pk9', 1000) as never)).id;
const LINE = s(DB, 'SELECT id FROM purchase_lines WHERE purchase_id = ?', [K]);
// Darlehen ohne Kunde: eines mit Ahmeds Namen (Hinweis), eines mit fremdem Namen, eines storniert.
const debt = (id: string, dir: string, amount: number, status: string, counterparty: string, nr: string): void =>
  insert(DB, 'debts', { id, branch_id: 'branch-main', loan_number: nr, direction: dir, counterparty, customer_id: null, amount, source: 'cash', status,
    revision: 1, created_at: '2026-09-14T09:00:00.000Z', updated_at: NOW });
debt('d-hint', 'we_borrow', 250, 'OPEN', 'Ahmed Karimi', 'LOA-2026-000101');
debt('d-other', 'we_lend', 90, 'OPEN', 'Someone Else', 'LOA-2026-000102');
debt('d-void', 'we_lend', 60, 'CANCELLED', 'Ahmed Karimi', 'LOA-2026-000103');
reload();

// ══ P1 — Partner mit Kunde verknüpfen ═══════════════════════════════════════════════════════════════════════════
const A0 = acc();
{
  ok(A0.partners.length === 0 && A0.hints.partners.length === 1 && A0.hints.partners[0].partnerId === 'pa-ak' && !A0.docs.some((d) => d.kind.startsWith('PARTNER')),
    'P1-0 Ausgang: pa-ak nur Hinweis (gleiches Telefon), nicht gezählt');
  const vorher = unberuehrt();
  const recvVor = S(recv.receivablesBreakdown('branch-main').map((r) => [r.id, r.open]).sort());
  const payVor = S(payS.loadPayablesFor(CTX as never).payables.map((r) => [r.id, r.outstanding]).sort());
  const r = imHaus(() => PS.getState().linkPartnerToCustomer('pa-ak', 'cust-1', customerUpdatedAt('cust-1')));
  ok(r.existing === false && linkOf('pa-ak') === 'cust-1' && audits('partners', 'pa-ak') === 1,
    'P1-1 „Link to client" am Primary: nur linked_customer_id gesetzt, ein Protokolleintrag');
  ok(n(DB, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'partners' AND record_id = 'pa-ak'") >= 1, 'P1-2 die Verknüpfung reist im Abgleich (partners)');
  ok(unberuehrt() === vorher, 'P1-3 Beteiligungen, Bewegungen, Buchungen, Darlehen und Partner-Stammdaten unverändert');
  const A1 = acc();
  const pd = A1.docs.filter((d) => d.kind.startsWith('PARTNER'));
  ok(A1.partners.length === 1 && A1.partners[0].link === 'LINKED' && A1.hints.partners.length === 0 && pd.length === 1 && pd[0].kind === 'PARTNER_RECEIVABLE' && eq(pd[0].open, 500),
    `P1-4 Kundenkonto: Partner verknüpft, genau EINE Partnerzeile (Kostenanteil 500, schuldet uns) (${S(pd.map((d) => [d.kind, d.open]))})`);
  ok(eq(A1.owesUs.total, A0.owesUs.total + 500) && eq(A1.weOwe.total, A0.weOwe.total) && eq(A1.net, A0.net + 500),
    'P1-5 Saldo genau um den offenen Partnerbetrag geändert, nichts doppelt');
  ok(S(recv.receivablesBreakdown('branch-main').map((x) => [x.id, x.open]).sort()) === recvVor && S(payS.loadPayablesFor(CTX as never).payables.map((x) => [x.id, x.outstanding]).sort()) === payVor,
    'P1-6 Receivables und Payables unverändert (die Partnerzeile steht dort weiter genau einmal)');
  const again = imHaus(() => PS.getState().linkPartnerToCustomer('pa-ak', 'cust-1', customerUpdatedAt('cust-1')));
  ok(again.existing === true && audits('partners', 'pa-ak') === 1, 'P1-7 dieselbe Verknüpfung noch einmal: nichts zu tun, kein zweiter Protokolleintrag');
}
// Abgerechnet → LATAIF schuldet dem Partner: die Zeile wechselt die Seite, ein erwarteter Gewinn zählt vorher nie.
{
  await save.recordItemMovementOnPrimary({ purchaseLineId: LINE, partnerId: 'pa-ak', kind: 'CONTRIBUTION', amount: 500, method: 'bank', date: '2026-10-18' });
  ok(!acc().docs.some((d) => d.kind.startsWith('PARTNER')), 'P1-8 Beitrag eingezahlt → nichts offen, keine Partnerzeile');
  const lot = s(DB, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [LINE]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [{ productId: 'pk9', quantity: 1, unitPrice: 1300,
    purchasePrice: n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]), taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1300, lotId: lot }] as never, 'P').id);
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 1300, 'cash'));
  reload();
  const vorAbrechnung = acc();
  ok(!vorAbrechnung.docs.some((d) => d.kind.startsWith('PARTNER')) && vorAbrechnung.partners[0].items[0].profitNotSettled > 0,
    `P1-9 verkauft, nicht abgerechnet: rechnerischer Anteil ${vorAbrechnung.partners[0].items[0].profitNotSettled} wird gezeigt, zählt aber nicht`);
  await save.settleSaleOnPrimary(s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]));
  const A2 = acc();
  const pd = A2.docs.filter((d) => d.kind.startsWith('PARTNER'));
  const pay = payS.loadPayablesFor(CTX as never).payables.filter((x) => x.type === 'partner' && x.counterpartyId === 'pa-ak').reduce((t, x) => t + F(x.outstanding), 0) / 1000;
  ok(pd.length === 1 && pd[0].kind === 'PARTNER_PAYABLE' && pd[0].side === 'WE_OWE' && eq(pd[0].open, pay) && eq(pay, 650),
    `P1-10 abgerechnet: LATAIF schuldet 650 (Beitrag + Gewinnanteil) = Payables „Partner", einmal im Konto (${S(pd.map((d) => [d.kind, d.open]))})`);
  const last = A2.statement[A2.statement.length - 1];
  ok(eq(last.balance, A2.net), 'P1-11 Kontoauszug endet weiter genau beim Netto');
}
// Sperren gegen falsche und doppelte Zuordnung.
{
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-b', 'cust-1', customerUpdatedAt('cust-1')))) === 'CUSTOMER_ALREADY_PARTNER', 'P1-12 zweiter Partner für denselben Kunden abgelehnt');
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-ak', 'cust-2', customerUpdatedAt('cust-2')))) === 'PARTNER_ALREADY_LINKED', 'P1-13 verknüpfter Partner wird nicht still umgehängt');
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-b', 'cust-x'))) === 'CUSTOMER_BRANCH_MISMATCH', 'P1-14 Kunde einer anderen Filiale abgelehnt');
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-b', 'sys-walkin'))) === 'CUSTOMER_NOT_FOUND', 'P1-15 System-Kunde abgelehnt');
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-b', 'cust-2', '2000-01-01T00:00:00.000Z'))) === 'CUSTOMER_CHANGED', 'P1-16 veralteter Kundenstand abgelehnt');
  ok(wirft(() => imHaus(() => PS.getState().linkPartnerToCustomer('pa-nope', 'cust-2'))) === 'PARTNER_NOT_FOUND', 'P1-17 unbekannter Partner abgelehnt');
  ok(wirft(() => DB.run("UPDATE partners SET linked_customer_id = 'cust-1' WHERE id = 'pa-b'")) !== '' && linkOf('pa-b') === '',
    'P1-18 die Datenbank selbst verbietet zwei Partner je Kunde und Filiale (eindeutiger Index)');
  ok(audits('partners', 'pa-b') === 0, 'P1-19 abgelehnte Versuche hinterlassen keinen Protokolleintrag');
}
// PC2: derselbe Weg über `partners.update` — Transaktion, Wiederholungsschutz, Prüfungen am Primary.
{
  const ein = { id: 'pa-b', linkedCustomerId: 'cust-2', linkedCustomerUpdatedAt: customerUpdatedAt('cust-2') };
  const a = await fern(() => md.runPartnerUpdate(deps() as never, identity('201', 'partners.update'), ein));
  ok(a.kind === 'ok' && a.value?.linkedCustomerId === 'cust-2' && linkOf('pa-b') === 'cust-2' && audits('partners', 'pa-b') === 1,
    `P1-20 PC2 verknüpft über partners.update am Primary (${a.kind} ${a.code ?? ''})`);
  const b = await fern(() => md.runPartnerUpdate(deps() as never, identity('201', 'partners.update'), ein));
  ok(b.kind === 'ok' && b.replayed === true && audits('partners', 'pa-b') === 1, 'P1-21 dieselbe Kennung erneut → Wiedergabe, kein zweiter Lauf');
  const x = await fern(() => md.runPartnerUpdate(deps() as never, identity('202', 'partners.update'), { id: 'pa-c', linkedCustomerId: 'cust-x', linkedCustomerUpdatedAt: NOW }));
  ok(x.code === 'CUSTOMER_BRANCH_MISMATCH' && linkOf('pa-c') === '', `P1-22 PC2: fremde Filiale am Primary abgelehnt (${x.kind} ${x.code})`);
  const falsch = await fern(() => md.runPartnerUpdate(deps() as never, identity('203', 'partners.update'), { id: 'pa-b', unlinkCustomerId: 'cust-1' }));
  ok(falsch.code === 'PARTNER_LINK_CHANGED' && linkOf('pa-b') === 'cust-2', `P1-23 Lösen nur, wenn die Verknüpfung noch auf den genannten Kunden zeigt (${falsch.kind} ${falsch.code})`);
  const los = await fern(() => md.runPartnerUpdate(deps() as never, identity('204', 'partners.update'), { id: 'pa-b', unlinkCustomerId: 'cust-2' }));
  ok(los.kind === 'ok' && linkOf('pa-b') === '' && audits('partners', 'pa-b') === 2, 'P1-24 Lösen über PC2: Verknüpfung weg, protokolliert');
  const gemischt = await fern(() => md.runPartnerUpdate(deps() as never, identity('205', 'partners.update'), { id: 'pa-b', linkedCustomerId: 'cust-2', linkedCustomerUpdatedAt: NOW, name: 'X' }));
  ok(gemischt.kind !== 'ok' && linkOf('pa-b') === '' && s(DB, 'SELECT name FROM partners WHERE id = ?', ['pa-b']) === 'Bashir',
    `P1-25 Verknüpfen reist allein — ein Stammdatenfeld im selben Auftrag wird abgewiesen (${gemischt.kind} ${gemischt.code ?? gemischt.thrown ?? ''})`);
}

// ══ P2 — Darlehen ohne Kunde zuordnen ═══════════════════════════════════════════════════════════════════════════
{
  const B0 = acc();
  ok(B0.hints.debts.some((h) => h.id === 'd-hint') && !B0.docs.some((d) => d.key === 'debt:d-hint'), 'P2-0 Ausgang: d-hint nur Hinweis');
  const vorDebt = zeilen("SELECT id, amount, status, counterparty, direction, source, loan_number FROM debts WHERE id = 'd-hint'");
  const ledgerVor = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  const zahlVor = zeilen('SELECT * FROM debt_payments ORDER BY id');
  const r = imHaus(() => money.updateDebtInHouse({ debtId: 'd-hint', assignCustomerId: 'cust-1' } as never, HCTX));
  ok(r.changed === true && debtCustomer('d-hint') === 'cust-1' && audits('debts', 'd-hint') === 1, 'P2-1 „Assign to this client": nur customer_id gesetzt, ein Protokolleintrag');
  ok(zeilen("SELECT id, amount, status, counterparty, direction, source, loan_number FROM debts WHERE id = 'd-hint'") === vorDebt
    && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === ledgerVor && zeilen('SELECT * FROM debt_payments ORDER BY id') === zahlVor,
    'P2-2 Betrag, Status, Freitext der Gegenpartei, Richtung, Konto, Zahlungen und Buchungen unverändert');
  const B1 = acc();
  ok(B1.docs.some((d) => d.key === 'debt:d-hint' && d.kind === 'LOAN_BORROWED' && eq(d.open, 250)) && !B1.hints.debts.some((h) => h.id === 'd-hint')
    && eq(B1.weOwe.total, B0.weOwe.total + 250) && eq(B1.net, B0.net - 250), 'P2-3 Kundenkonto: Darlehen jetzt gezählt (250), nicht mehr Hinweis — Saldo genau −250');
  const p = payS.loadPayablesFor(CTX as never).payables.filter((x) => x.type === 'loan' && x.counterpartyId === 'cust-1').reduce((t, x) => t + F(x.outstanding), 0) / 1000;
  ok(eq(sumOpen(B1, (d) => d.kind === 'LOAN_BORROWED'), p), `P2-4 dieselbe Zahl wie Payables des Kunden (${p})`);
  ok(wirft(() => imHaus(() => money.updateDebtInHouse({ debtId: 'd-hint', assignCustomerId: 'cust-2' } as never, HCTX))) === 'DEBT_ALREADY_ASSIGNED',
    'P2-5 ein zugeordnetes Darlehen wird nie still auf einen anderen Kunden umgestellt');
  const gleich = imHaus(() => money.updateDebtInHouse({ debtId: 'd-hint', assignCustomerId: 'cust-1' } as never, HCTX));
  ok(gleich.changed === false && audits('debts', 'd-hint') === 1, 'P2-6 derselbe Kunde noch einmal: nichts zu tun');
  ok(wirft(() => money.debtUpdateInput({ debtId: 'd-other', assignCustomerId: 'cust-1', amount: 5 })) === 'DEBT_ASSIGN_ALONE', 'P2-7 Zuordnen nie zusammen mit Betrag oder anderen Feldern');
  ok(wirft(() => imHaus(() => money.updateDebtInHouse({ debtId: 'd-void', assignCustomerId: 'cust-1' } as never, HCTX))) === 'DEBT_CANCELLED', 'P2-8 ein storniertes Darlehen wird nicht zugeordnet');
  ok(wirft(() => imHaus(() => money.updateDebtInHouse({ debtId: 'd-other', assignCustomerId: 'cust-x' } as never, HCTX))) === 'CUSTOMER_NOT_FOUND'
    && wirft(() => imHaus(() => money.updateDebtInHouse({ debtId: 'd-other', assignCustomerId: 'sys-walkin' } as never, HCTX))) === 'CUSTOMER_NOT_FOUND'
    && debtCustomer('d-other') === '', 'P2-9 fremde Filiale und System-Kunde abgelehnt');
}
// PC2: `debts.update` mit assignCustomerId und gesehener Fassung.
{
  const rev = n(DB, 'SELECT revision FROM debts WHERE id = ?', ['d-other']);
  const alt = await fern(() => mc.runDebtUpdate(deps() as never, identity('301', 'debts.update'), { debtId: 'd-other', expectedRevision: rev + 5, assignCustomerId: 'cust-2' }));
  ok(alt.code === 'RECORD_CHANGED' && debtCustomer('d-other') === '', `P2-10 PC2 mit veralteter Fassung abgelehnt (${alt.kind} ${alt.code})`);
  const a = await fern(() => mc.runDebtUpdate(deps() as never, identity('302', 'debts.update'), { debtId: 'd-other', expectedRevision: rev, assignCustomerId: 'cust-2' }));
  ok(a.kind === 'ok' && debtCustomer('d-other') === 'cust-2' && audits('debts', 'd-other') === 1, `P2-11 PC2 ordnet zu (${a.kind} ${a.code ?? ''})`);
  const b = await fern(() => mc.runDebtUpdate(deps() as never, identity('302', 'debts.update'), { debtId: 'd-other', expectedRevision: rev, assignCustomerId: 'cust-2' }));
  ok(b.kind === 'ok' && b.replayed === true && audits('debts', 'd-other') === 1, 'P2-12 dieselbe Kennung erneut → Wiedergabe');
  const um = await fern(() => mc.runDebtUpdate(deps() as never, identity('303', 'debts.update'), { debtId: 'd-other', expectedRevision: n(DB, 'SELECT revision FROM debts WHERE id = ?', ['d-other']), assignCustomerId: 'cust-1' }));
  ok(um.code === 'DEBT_ALREADY_ASSIGNED' && debtCustomer('d-other') === 'cust-2', `P2-13 PC2 kann nicht umhängen (${um.kind} ${um.code})`);
}

// ══ Primary = PC2 im Kundenkonto; Quelltext ═══════════════════════════════════════════════════════════════════════
{
  imHaus(() => PS.getState().linkPartnerToCustomer('pa-b', 'cust-2', customerUpdatedAt('cust-2')));
  const lokal = pa.partyAccountReadFor(CTX, { partyType: 'CUSTOMER', partyId: 'cust-1', view: ca.CUSTOMER_ACCOUNT_VIEW });
  const fern2 = await executeCommand('parties.account.get', { actor: { ...ACTOR, role: 'SALES' }, input: { partyType: 'CUSTOMER', partyId: 'cust-1', view: 'customer_account' } }, undefined) as { kind: string; value: { data: typeof lokal } };
  ok(fern2.kind === 'ok' && S(fern2.value.data.customerAccount) === S(lokal.customerAccount) && lokal.customerAccount!.partners[0]?.partnerId === 'pa-ak',
    'X1 PC2 liest nach den Verknüpfungen genau dasselbe Kundenkonto');
  const andere = ca.customerAccountFor(CTX, 'cust-2');
  ok(andere.partners.length === 1 && andere.partners[0].partnerId === 'pa-b' && !andere.hints.partners.some((p) => p.partnerId === 'pa-ak'),
    'X2 ein mit einem anderen Kunden verknüpfter Partner ist dort gezählt und hier nie ein Hinweis');
  const page = src('src/pages/customers/CustomerAccountPage.tsx');
  ok(/data-hint-debt-assign/.test(page) && /data-partner-link-here/.test(page) && (page.match(/await window\.confirm\(/g) ?? []).length >= 2,
    'X3 Konto: „Assign to this client" und „Link to this client" je mit Rückfrage');
  ok(/PartnerClientLink/.test(src('src/pages/partners/PartnersPage.tsx')) && /!detail\.customerId && canonicalLoanStatus\(detail\.status\) !== 'CANCELLED'/.test(src('src/pages/debts/DebtsPage.tsx')),
    'X4 Partner-Dialog verknüpft/löst; Darlehen-Detail bietet Zuordnen nur ohne Kunde');
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables?: Record<string, { allowed_fields: string[] }> } & Record<string, unknown>;
  const tbl = (manifest.tables ?? manifest) as Record<string, { allowed_fields?: string[] }>;
  ok((tbl.partners?.allowed_fields ?? []).includes('linked_customer_id'), 'X5 Abgleich kennt partners.linked_customer_id');
}

console.log(`\nCUSTOMER ACCOUNT A2: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

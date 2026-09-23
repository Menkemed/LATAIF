// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S4 — `invoice.paid` bei Rechnungen, die nach einem Edit (wieder) voll bezahlt werden.
// Run: node --experimental-strip-types test/invoice-edit/invoice-paid.test.ts
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
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
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
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void useCreditNoteStore; void voll; void insert; void rechnung; void S; void src;

// ── Messgrößen ─────────────────────────────────────────────────────────────────────────────
const paidEvents: string[] = [];
eventBus.on('invoice.paid', (e) => { paidEvents.push(e.entityId); });
const events = (inv: string): number => eventBus.getLog().filter((e) => e.type === 'invoice.paid' && e.entityId === inv).length;

/** Rechnung für Ali: ein Artikel (Los, 1 Stück), netto `preis` VAT_10 → brutto preis × 1,1. */
function welt(preis: number): { db: Db; inv: string; z: string } {
  const db = neu();
  product(db, 'pA', 1);
  reload();
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ ...LINE('pA', 1, preis), lotId: 'lot-pA' }] as never, 'S4').id);
  reload();
  db.run(`INSERT INTO tasks (id, branch_id, title, type, priority, status, linked_entity_type, linked_entity_id, created_at)
    VALUES ('t-rem','branch-main','Payment reminder','payment_reminder','medium','open','invoice',?,?)`, [inv, NOW]);
  return { db, inv, z: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}
function zahle(inv: string, betrag: number): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, 'cash'));
  reload();
  return id;
}
function aendere(inv: string, z: string, preis: number, delta?: number): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ lineId: z, ...LINE('pA', 1, preis), lotId: 'lot-pA' }] as never, reason: 'S4',
    ...(delta ? { deltaPayment: { amount: delta, method: 'cash' } } : {}),
  } as never)));
  reload();
  return m;
}
const st = (db: Db, inv: string) => ({
  status: s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]),
  nr: s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv]),
  fin: s(db, 'SELECT number_finalized_at FROM invoices WHERE id = ?', [inv]),
  paid: n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]),
  gross: n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]),
  pay: n(db, 'SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = ?', [inv]),
  prod: s(db, "SELECT stock_status FROM products WHERE id = 'pA'"),
  task: s(db, "SELECT status FROM tasks WHERE id = 't-rem'"),
  lpa: s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-1'"),
  ev: events(inv),
});

const cash = (db: Db): number => n(db,
  "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'CASH'");
const arKunde = (db: Db, cust: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries
    WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [cust]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
/** Was ein zweites `invoice.paid` doppelt machen könnte: Bestand, Aufgaben, Guthaben, Zahlungszeilen. */
const effekte = (db: Db, inv: string): string => all(db,
  `SELECT (SELECT quantity FROM products WHERE id = 'pA'), (SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pA'),
          (SELECT COUNT(*) FROM tasks WHERE linked_entity_id = ?), (SELECT COUNT(*) FROM customer_credits),
          (SELECT COUNT(*) FROM payments WHERE invoice_id = ?)`, [inv, inv]);

// 1) Das Szenario: 300 voll bezahlt → auf 350 erhöht (PARTIAL) → 50 nachgezahlt (wieder FINAL).
{
  const { db, inv, z } = welt(300 / 1.1);
  zahle(inv, 300);
  const a = st(db, inv);
  ok(a.status === 'FINAL' && a.nr.startsWith('INV-') && a.ev === 1 && a.prod === 'sold' && a.task === 'completed' && a.lpa !== '',
    `1 300 bezahlt: FINAL ${a.nr}, invoice.paid 1×, Produkt sold, Erinnerung erledigt, letzter Kauf gesetzt`);
  const m = aendere(inv, z, 350 / 1.1);
  const b = st(db, inv);
  ok(m === '' && b.status === 'PARTIAL' && b.nr === a.nr && b.fin === a.fin && b.ev === 1 && b.gross === 350,
    `1 …auf 350 erhöht: PARTIAL, Nummer ${b.nr} bleibt, kein Ereignis (${m})`);
  const vorEffekte = effekte(db, inv);
  zahle(inv, 50);
  const c = st(db, inv);
  ok(c.status === 'FINAL' && c.nr === a.nr && c.fin === a.fin && c.pay === 350 && c.paid === 350,
    `1 …50 nachgezahlt: FINAL, dieselbe Nummer ${c.nr} und Abschlusszeit, Zahlungen genau 350 (${c.pay})`);
  ok(c.ev === 2 && c.lpa >= a.lpa,
    `1 …zweites invoice.paid gehört zur echten neuen Zahlung (letzter Kauf ${c.lpa.slice(11, 23)} ≥ ${a.lpa.slice(11, 23)})`);
  const nachEffekte = effekte(db, inv);
  const [vorE, nachE] = [JSON.parse(vorEffekte)[0] as number[], JSON.parse(nachEffekte)[0] as number[]];
  ok(nachE.slice(0, 4).join() === vorE.slice(0, 4).join() && vorE[4] === 1 && nachE[4] === 2,
    `1 …kein doppelter Effekt: Bestand, Aufgaben, Guthaben unverändert, genau 2 Zahlungszeilen (${nachEffekte})`);
  ok(cash(db) === 350 && arKunde(db, 'cust-1') === 0 && ausgeglichen(db), `1 …Hauptbuch: Kasse 350, Forderung 0 (${cash(db)})`);
}

// 2) Preis gesenkt → dadurch voll bezahlt → danach Zahlung geändert (Methode).
{
  const { db, inv, z } = welt(300);
  const p = zahle(inv, 200);
  const m = aendere(inv, z, 200 / 1.1);
  const a = st(db, inv);
  ok(m === '' && a.status === 'FINAL' && a.nr.startsWith('INV-') && a.ev === 1 && a.prod === 'sold' && a.task === 'completed' && a.lpa !== '',
    `2 Preissenkung macht die Rechnung voll bezahlt: invoice.paid 1× (vorher 0×), Produkt sold, Erinnerung erledigt (${a.prod}/${a.task})`);
  imHaus(() => useInvoiceStore.getState().updatePayment(p, inv, { method: 'bank_transfer' }));
  reload();
  const b = st(db, inv);
  ok(b.status === 'FINAL' && b.ev === 1 && b.nr === a.nr && b.pay === 200,
    `2 …danach Zahlungsart geändert: bleibt FINAL, kein weiteres Ereignis, Nummer bleibt (${b.ev})`);
}

// 3) Erhöhen + Delta-Zahlung im selben Speichern (Maske am Primary).
{
  // a) Delta reicht nicht: PARTIAL, KEINE Endnummer, kein Ereignis (vorher: Endnummer + invoice.paid).
  const { db, inv, z } = welt(300);
  zahle(inv, 200);
  const m = aendere(inv, z, 400, 150);
  const a = st(db, inv);
  ok(m === '' && a.status === 'PARTIAL' && a.nr.startsWith('PINV-') && a.fin === '' && a.ev === 0 && a.prod === 'reserved' && a.task === 'open',
    `3a erhöht auf 440, 150 nachgezahlt (350): PARTIAL, vorläufige Nummer ${a.nr}, kein invoice.paid (${a.ev})`);
}
{
  // b) Delta reicht genau: FINAL, genau EIN Ereignis (Zahlung meldet es, der Edit nicht noch einmal).
  const { db, inv, z } = welt(300);
  zahle(inv, 200);
  const m = aendere(inv, z, 400, 240);
  const a = st(db, inv);
  ok(m === '' && a.status === 'FINAL' && a.nr.startsWith('INV-') && a.ev === 1 && a.pay === 440 && a.prod === 'sold',
    `3b erhöht auf 440, 240 nachgezahlt: FINAL, invoice.paid genau 1× (${a.ev}), Zahlungen 440`);
}

// 4) Zahlung geändert → dadurch voll bezahlt.
{
  const { db, inv } = welt(100);
  const p = zahle(inv, 50);
  imHaus(() => useInvoiceStore.getState().updatePayment(p, inv, { amount: 110 }));
  reload();
  const a = st(db, inv);
  ok(a.status === 'FINAL' && a.ev === 1 && a.prod === 'sold' && a.task === 'completed' && a.pay === 110,
    `4 Zahlung von 50 auf 110 geändert: FINAL, invoice.paid 1× (vorher 0×), Produkt sold, Erinnerung erledigt`);
}

// 5) Zahlung löschen und erneut erfassen.
{
  const { db, inv } = welt(100);
  const p = zahle(inv, 110);
  const nr = st(db, inv).nr;
  imHaus(() => useInvoiceStore.getState().deletePayment(p, inv));
  reload();
  const a = st(db, inv);
  const p2 = zahle(inv, 110);
  const b = st(db, inv);
  ok(a.ev === 1 && a.pay === 0 && b.status === 'FINAL' && b.ev === 2 && b.nr === nr && b.pay === 110
    && n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 1 && p2 !== p,
    `5 gelöscht und neu erfasst: eine Zahlungszeile (neue Referenz), Nummer ${b.nr} bleibt, Ereignis je echter Vollzahlung (${b.ev})`);
  ok(cash(db) === 110 && arKunde(db, 'cust-1') === 0 && ausgeglichen(db), `5 …Hauptbuch: Kasse 110, Forderung 0 (${cash(db)})`);
}

// 6) PC2 — derselbe Zahlungsauftrag zweimal zugestellt: eine Zahlung, ein Ereignis.
{
  const { db, inv } = welt(100);
  const { runInvoicePayment } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ident = { commandId: '00000071-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.record_payment', payloadKind: 'x', payloadHash: 'h71' };
  const body = { invoiceId: inv, amount: 110, method: 'cash' };
  const r1 = await runInvoicePayment(d as never, ident as never, body);
  reload();
  const r2 = await runInvoicePayment(d as never, ident as never, body);
  reload();
  const a = st(db, inv);
  ok(r1.kind === 'ok' && r2.kind === 'ok' && a.status === 'FINAL' && a.ev === 1 && a.pay === 110
    && n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 1,
    `6 PC2 Zahlung doppelt zugestellt: eine Zahlung, invoice.paid 1× (${r1.kind}/${r2.kind}, ${a.ev})`);
}

// 7) Kundenwechsel an einer bezahlten Rechnung: „letzter Kauf" zieht mit.
{
  const { db, inv, z } = welt(100);
  zahle(inv, 110);
  const fin = st(db, inv).fin;
  ok(s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-1'") !== '' && s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-2'") === '',
    '7 SETUP Ali hat den Kauf, Nora nicht');
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ lineId: z, ...LINE('pA', 1, 100), lotId: 'lot-pA' }] as never, customerId: 'cust-2', reason: 'Falscher Kunde', confirmCustomerChange: true,
  } as never)));
  reload();
  ok(m === '' && s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-2'") === fin
    && s(db, "SELECT sales_stage FROM customers WHERE id = 'cust-2'") === 'active',
    `7 Nora: letzter Kauf = Abschluss der Rechnung ${fin.slice(0, 19)}, Stufe active (${m})`);
  ok(s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-1'") === '' && st(db, inv).ev === 1,
    '7 …Ali: kein anderer Kauf → letzter Kauf leer; kein neues invoice.paid');
}
{
  // Ali hat einen SPÄTEREN eigenen Kauf: sein letzter Kauf bleibt.
  const { db, inv, z } = welt(100);
  zahle(inv, 110);
  db.run("UPDATE invoices SET number_finalized_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", [inv]);
  db.run("UPDATE customers SET last_purchase_at = '2026-06-01T00:00:00.000Z' WHERE id = 'cust-1'");
  insert(db, 'invoices', { id: 'inv-spaeter', branch_id: 'branch-main', invoice_number: 'INV-X', customer_id: 'cust-1', status: 'FINAL', number_finalized_at: '2026-06-01T00:00:00.000Z' });
  reload();
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ lineId: z, ...LINE('pA', 1, 100), lotId: 'lot-pA' }] as never, customerId: 'cust-2', reason: 'Falscher Kunde', confirmCustomerChange: true,
  } as never)));
  reload();
  ok(m === '' && s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-1'") === '2026-06-01T00:00:00.000Z'
    && s(db, "SELECT last_purchase_at FROM customers WHERE id = 'cust-2'") === '2026-01-01T00:00:00.000Z',
    `7 …Ali mit späterem eigenem Kauf behält ihn; Nora bekommt den Abschluss der Rechnung (${m})`);
}

// 8) Quelltext — ein Übergang, eine Meldung.
{
  const store = src('src/stores/invoiceStore.ts');
  ok((store.match(/eventBus\.emit\('invoice\.paid'/g) ?? []).length === 4, 'Q invoice.paid: Zahlen, Edit, Zahlung ändern, Alt-Update');
  ok(/paidEventCount\(id\) === paidEventsBefore/.test(store) && /if \(becameFinal\) eventBus\.emit/.test(store),
    'Q Edit meldet nur, wenn die Delta-Zahlung es nicht schon tat; Zahlung ändern nur beim Übergang');
  ok((store.match(/freshInvoice\(invoiceId\)/g) ?? []).length >= 4, 'Q Zahlen rechnet gegen den Stand der Datenbank, nicht den Store');
}
void current; void paidEvents;

console.log(`\ninvoice-edit-invoice-paid: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

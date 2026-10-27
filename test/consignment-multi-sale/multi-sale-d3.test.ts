// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT MULTI-SALE + D3 — mehrere Kommissionen auf EINER Rechnung (auch verschiedener Einlieferer), Zahlungen
// beim Verkauf (D5), Rechnungsdatum = Verkaufstag (D1), Einzelretoure und Cancel Sale der ganzen Rechnung (D2),
// der schon bezahlte Einlieferer (D3: Keep / Rückgabe mit Geld sofort / Rückgabe mit offener Rückforderung),
// Receivables je Rechnung und Payables ohne doppelte Consignor-Zeile (D4).
// Run: node --experimental-strip-types test/consignment-multi-sale/multi-sale-d3.test.ts
//
// Gefahren werden die ECHTEN Folgen (Haus am Primary über runOnPrimary, PC2 über runRemoteCommand mit durablem
// Nachweis) auf dem echten Schema samt Hauptbuch — dieselbe Umgebung wie test/r6f/consignment-parity.
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
  // Abgleich eingeschaltet: `trackChange` schreibt ins Änderungsprotokoll — messbar, auch im Rollback.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
await import('../../src/core/bridge/read-commands.ts');
const cust = await import('../../src/core/bridge/customer-commands.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const cl = await import('../../src/core/bridge/consignment-lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useExpenseStore } = await import('../../src/stores/expenseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const conHouse = await import('../../src/core/consignment/consignment-finance-house.ts');
const revHouse = await import('../../src/core/consignment/consignment-reversal-house.ts');
const rules = await import('../../src/core/consignment/consignment-reversal.ts');
const returnHouse = await import('../../src/core/returns/return-house.ts');
const invoiceCancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
const invRev = await import('../../src/core/invoices/invoice-reversal.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

type SI = import('../../src/core/consignment/consignment-finance.ts').ConsignmentSaleInput;
type RI = import('../../src/core/consignment/consignment-reversal.ts').ConsignmentReturnAfterSaleInput;
type CR = import('../../src/core/consignment/consignment-reversal.ts').ConsignorRefundChoice;

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const OP_R = 'consignments.return_after_sale';
const OP_C = 'consignments.cancel_sale';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}
const row = (db: Db, sql: string, p: unknown[] = []): Record<string, unknown> => rows(db, sql, p)[0] ?? {};
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
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useConsignmentStore.getState().loadConsignments();
  usePurchaseStore.getState().loadPurchases();
  useSupplierStore.getState().loadSuppliers();
  useExpenseStore.getState().loadExpenses();
  useCreditNoteStore.getState().loadCreditNotes();
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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-x', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)", [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

// Der Mensch am Primary ist der Owner (Rolle wie bei „Cancel Return").
function sitzung(role: string): void {
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never });
}
sitzung('ADMIN');

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, over: Partial<typeof ACTOR> = {}) =>
  ({ commandId: ID(x), ...ACTOR, ...over, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
let seq = 5000;
const nx = (): string => String(++seq);

interface Ausgang { ok: boolean; code: string; frozen: boolean; thrown: boolean; value: Record<string, unknown>; replayed: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean; frozen?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, thrown: false, value: o.value ?? {}, replayed: o.replayed === true };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, thrown: false, value: {}, replayed: false };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false };
  }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', frozen: false, thrown: false, value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: unknown, b: unknown, wo: string): string[] => {
  if (S(a) === S(b)) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const x = a as Record<string, unknown>; const y = b as Record<string, unknown>;
    return Object.keys({ ...x, ...y }).filter((k) => S(x[k] ?? null) !== S(y[k] ?? null)).map((k) => `${wo}.${k}: ${S(x[k])} vs ${S(y[k])}`.slice(0, 400));
  }
  return [`${wo}: ${S(a).slice(0, 300)} vs ${S(b).slice(0, 300)}`];
};
const diffAll = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).flatMap((k) => unterschiede(a[k], b[k], k));
const buchungen = (db: Db): string =>
  all(db, 'SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction');
/** Der Saldo je Konto und Gegenpartei — was ein Bericht zeigt. */
const salden = (db: Db): string => all(db,
  `SELECT account, COALESCE(counterparty_id, '') AS cp, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
     FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`);
/** Der Saldo je Konto (ohne Gegenpartei). */
function konten(db: Db): Record<string, number> {
  return Object.fromEntries(rows(db,
    `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
       FROM ledger_entries GROUP BY account HAVING ABS(net) > 0.0005 ORDER BY account`).map((r) => [String(r.account), Number(r.net)]));
}
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const changelog = (db: Db): number => n(db, 'SELECT COUNT(*) FROM sync_changelog');
const audits = (db: Db, field: string): number => n(db, 'SELECT COUNT(*) FROM audit_log WHERE field_name = ?', [field]);
function balanced(db: Db): boolean {
  const t = db.exec(`SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END),
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END)
    FROM ledger_entries GROUP BY transaction_id`)[0]?.values ?? [];
  return t.length > 0 && t.every((r) => Number(r[1]) === Number(r[2]));
}
/** Ein Datenbank-Proxy, der an GENAU einer Stelle scheitert — und festhält, wie es in dem Moment aussah. */
function faulty(db: Db, when: (sql: string, p?: unknown[]) => boolean, onFire?: () => void) {
  const f = { armed: true, fired: false };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && when(sql, p)) {
            f.fired = true;
            onFire?.();
            throw new Error('R6F: injected failure');
          }
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

// ════════════════════════════════════════════════════════════════════════════
// Die Welten: Kommissionen anlegen (Patek/Rolex/Omega …, vereinbart 1000, 20 % Provision), dann gemeinsam verkaufen.
// ════════════════════════════════════════════════════════════════════════════
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const finance = await import('../../src/core/consignment/consignment-finance.ts');
const { receivablesBreakdown } = await import('../../src/core/finance/receivables.ts');
const { loadPayablesFor } = await import('../../src/stores/payablesStore.ts');
const { loadConsignmentsFor } = await import('../../src/stores/consignmentStore.ts');
type MI = import('../../src/core/consignment/consignment-finance.ts').ConsignmentMultiSaleInput;
const OP_S = 'consignments.record_sale';
type Weg = 'primary' | 'fern';
/** Jede Welt hat ihre eigene Datenbank — der Primary-Anschluss fragt `getDatabase()`, also wird sie vorher gesetzt. */
function nimm(db: Db): void {
  setTestDatabase(db as never);
  reload();
}
const CTX = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };

const MODELLE: Record<string, Record<string, unknown>> = {
  percent: { model: 'percent', commissionRate: 20 },
  fixed: { model: 'consignor_fixed' },
};
async function kommission(db: Db, consignorId: string, name: string, payout: Record<string, unknown> = MODELLE.percent): Promise<string> {
  const c = await fern(() => cmd.runConsignmentCreate(deps(db), identity(nx(), 'consignments.create'), {
    consignorId, product: { brand: 'Patek', name, categoryId: 'cat-w' }, agreedPrice: 1000, payout,
  }));
  if (!c.ok) throw new Error('setup consignment: ' + c.code);
  useConsignmentStore.getState().loadConsignments();
  return String(c.value.consignmentId ?? '');
}
function dritterKunde(db: Db): void {
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-3','branch-main','Sara','Khalil','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  useCustomerStore.getState().loadCustomers();
}
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
function verkauf(weg: Weg, db: Db, input: MI, x = nx()): Promise<Ausgang> {
  nimm(db);
  if (weg === 'primary') return primary(() => conHouse.recordConsignmentSalesOnPrimary(input));
  const revs = Object.fromEntries(input.items.map((it) => [it.consignmentId, rev(db, it.consignmentId)]));
  return fern(() => life.runRecordSale(deps(db), identity(x, OP_S), finance.consignmentSalesBody(input, revs)));
}
function rueckgabeK(weg: Weg, db: Db, cid: string, input: RI): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => conHouse.returnConsignmentAfterSaleOnPrimary(cid, input))
    : fern(() => cl.runReturnAfterSale(deps(db), identity(nx(), OP_R), rules.consignmentReturnAfterSaleBody(cid, rev(db, cid), input)));
}
function stornoK(weg: Weg, db: Db, cid: string, erstattung?: Record<string, CR>): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => conHouse.cancelConsignmentSaleOnPrimary(cid, erstattung))
    : fern(() => cl.runCancelSale(deps(db), identity(nx(), OP_C), rules.consignmentCancelSaleBody(cid, rev(db, cid), erstattung)));
}
const einkaufVon = (db: Db, cid: string): string => s(db, "SELECT id FROM purchases WHERE source_consignment_id = ? AND status != 'CANCELLED' ORDER BY rowid DESC LIMIT 1", [cid]);
function bezahleEinlieferer(db: Db, cid: string, betrag: number, weg = 'cash'): void {
  nimm(db);
  usePurchaseStore.getState().loadPurchases();
  imHaus(() => usePurchaseStore.getState().addPayment(einkaufVon(db, cid), betrag, weg));
  reload();
}
/** Lager im Hauptbuch == Wert der aktiven Lose; Verbindlichkeit == offene Einkäufe + offene Ausgaben. */
function abgleich(db: Db): string[] {
  const k = konten(db);
  const lose = n(db, "SELECT COALESCE(ROUND(SUM(qty_remaining * unit_cost), 3), 0) FROM stock_lots WHERE status = 'ACTIVE'");
  const apDomain = n(db, `SELECT ROUND(COALESCE((SELECT SUM(remaining_amount) FROM purchases WHERE status NOT IN ('CANCELLED','DRAFT')), 0)
    + COALESCE((SELECT SUM(amount - paid_amount) FROM expenses WHERE status != 'CANCELLED' AND supplier_id IS NOT NULL), 0), 3)`);
  const sc = n(db, "SELECT COALESCE(ROUND(SUM(amount - used_amount), 3), 0) FROM supplier_credits WHERE status != 'CANCELLED'");
  const out: string[] = [];
  if (!balanced(db)) out.push('unbalanced');
  if (Math.abs((k.INVENTORY ?? 0) - lose) > 0.005) out.push(`INVENTORY ${k.INVENTORY ?? 0} vs lots ${lose}`);
  if (Math.abs(-(k.ACCOUNTS_PAYABLE ?? 0) - apDomain) > 0.005) out.push(`AP ${-(k.ACCOUNTS_PAYABLE ?? 0)} vs domain ${apDomain}`);
  if (Math.abs((k.SUPPLIER_CREDIT ?? 0) - sc) > 0.005) out.push(`SUPPLIER_CREDIT ${k.SUPPLIER_CREDIT ?? 0} vs domain ${sc}`);
  return out;
}

// ══ §1 — zwei Artikel EINES Einlieferers, eine Rechnung (Primary == PC2) ══════
{
  const bilder: string[] = [];
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const a = await kommission(db, 'cust-1', 'Nautilus');
    const b = await kommission(db, 'cust-1', 'Aquanaut');
    const r = await verkauf(weg, db, { items: [
      { consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
      { consignmentId: b, salePrice: 1500, acknowledgeShortfall: false },
    ], buyerId: 'cust-2', saleDate: '2026-09-10', specialMark: false });
    ok(r.ok, `S1 ${weg}: zwei Artikel → ein Verkauf (${r.code || 'ok'})`);
    const invs = rows(db, 'SELECT id, issued_at, gross_amount, status FROM invoices');
    const inv = String(invs[0]?.id ?? '');
    ok(invs.length === 1 && n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 2
      && Math.abs(Number(invs[0].gross_amount) - 2700) < 0.001,
    `S1 ${weg}: EINE Rechnung mit zwei Zeilen, Summe 2700 (${S(invs)})`);
    ok(String(invs[0]?.issued_at ?? '').startsWith('2026-09-10'), `S1 ${weg}: D1 Rechnungsdatum = Verkaufstag (${String(invs[0]?.issued_at)})`);
    const ps = rows(db, 'SELECT source_consignment_id, total_amount, purchase_date, supplier_id FROM purchases ORDER BY total_amount');
    ok(ps.length === 2 && Math.abs(Number(ps[0].total_amount) - 960) < 0.001 && Math.abs(Number(ps[1].total_amount) - 1200) < 0.001
      && ps[0].supplier_id === ps[1].supplier_id && ps.every((p) => String(p.purchase_date).startsWith('2026-09-10')),
    `S1 ${weg}: je Artikel ein Einkauf beim (selben) Einlieferer, getrennt (960 / 1200) (${S(ps)})`);
    ok(n(db, "SELECT COUNT(*) FROM consignments WHERE status = 'sold' AND invoice_id = ?", [inv]) === 2,
      `S1 ${weg}: beide Kommissionen sold und an DIESER Rechnung`);
    ok(abgleich(db).length === 0, `S1 ${weg}: Hauptbuch ausgeglichen, Lager == Lose, AP == Einkäufe (${abgleich(db).join(' | ') || 'ok'})`);
    // D4 — Payables: keine zweite „Consignor payout"-Zeile neben den Einkäufen.
    const pay = loadPayablesFor(CTX).payables;
    ok(!pay.some((p) => p.sourceTable === 'consignments') && pay.filter((p) => p.sourceTable === 'purchases').length === 2,
      `S1 ${weg}: D4 Payables zeigt die zwei Einkäufe, keine doppelte Consignor-Payout-Zeile (${S(pay.map((p) => p.sourceTable))})`);
    // Receivables: EINE Forderung je Rechnung.
    const rec = receivablesBreakdown('branch-main');
    ok(rec.length === 1 && Math.abs(rec[0].open - 2700) < 0.001, `S1 ${weg}: Receivables eine Zeile, offen 2700 (${S(rec.map((x) => [x.source, x.open]))})`);
    bilder.push(S({
      inv: all(db, 'SELECT status, gross_amount, paid_amount FROM invoices'),
      lines: all(db, 'SELECT tax_scheme, quantity, line_total, vat_amount FROM invoice_lines ORDER BY line_total'),
      pur: all(db, 'SELECT status, total_amount, remaining_amount FROM purchases ORDER BY total_amount'),
      kons: all(db, 'SELECT status, sale_price, commission_amount, payout_amount FROM consignments ORDER BY sale_price'),
      konten: konten(db),
    }));
  }
  ok(bilder[0] === bilder[1], 'S1 PARITY Primary == PC2 (Rechnung, Zeilen, Einkäufe, Kommissionen, Konten)');
}
marker('CONSIGNMENT_MULTI_SALE_SAME_CONSIGNOR_PROVED');

// ══ §2 — drei Artikel ZWEIER Einlieferer, gemischte Teilzahlung, neuer Käufer ════
{
  const db = freshDb();
  dritterKunde(db);
  const a = await kommission(db, 'cust-1', 'Nautilus');
  const b = await kommission(db, 'cust-1', 'Calatrava');
  const c = await kommission(db, 'cust-3', 'Daytona');
  // „+ New Client": der Käufer wird im Dialog angelegt (derselbe Weg wie QuickCustomerModal) und sofort gewählt.
  const neu = await fern(() => cust.runCustomerCreate(deps(db), identity(nx(), 'customers.create'), { firstName: 'Neu', lastName: 'Kunde', phone: '+97333334444' }));
  const buyer = String(neu.value.customerId ?? neu.value.id ?? '');
  ok(neu.ok && buyer !== '', `S2 neuer Käufer im Dialog angelegt (${neu.code || 'ok'})`);
  useCustomerStore.getState().loadCustomers();
  const input: MI = { items: [
    { consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: b, salePrice: 1000, acknowledgeShortfall: false },
    { consignmentId: c, salePrice: 2000, acknowledgeShortfall: false },
  ], buyerId: buyer, saleDate: '2026-09-11', specialMark: false, payments: [
    { amount: 1000, method: 'cash', paidDate: '2026-09-11' },
    { amount: 500, method: 'card', cardBrand: 'normal', paidDate: '2026-09-12' },
    { amount: 300, method: 'bank_transfer' },
    { amount: 200, method: 'card', cardBrand: 'amex' },
    { amount: 100, method: 'benefit' },
  ] };
  const r = await verkauf('fern', db, input);
  ok(r.ok, `S2 drei Artikel, zwei Einlieferer, fünf Zahlungen (PC2) (${r.code || 'ok'})`);
  const inv = row(db, 'SELECT id, status, gross_amount, paid_amount FROM invoices');
  ok(Math.abs(Number(inv.gross_amount) - 4200) < 0.001 && Math.abs(Number(inv.paid_amount) - 2100) < 0.001 && inv.status === 'PARTIAL',
    `S2 eine Rechnung 4200, bezahlt 2100, PARTIAL (${S(inv)})`);
  const zahlungen = rows(db, 'SELECT method, amount, card_brand, received_at FROM payments ORDER BY received_at, amount');
  ok(zahlungen.length === 5 && zahlungen.some((z) => z.method === 'card' && z.card_brand === 'amex')
    && zahlungen.some((z) => String(z.received_at).startsWith('2026-09-12')),
  `S2 alle Zahlungen mit Weg, Kartenart und Tag gebucht (${S(zahlungen)})`);
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE status != 'CANCELLED'") >= 2,
    `S2 Kartengebühren (normal + amex) als Ausgaben gebucht (${n(db, 'SELECT COUNT(*) FROM expenses')})`);
  const lief = rows(db, `SELECT p.supplier_id, ROUND(SUM(p.remaining_amount), 3) AS offen, COUNT(*) AS n FROM purchases p GROUP BY p.supplier_id ORDER BY offen`);
  ok(lief.length === 2 && Number(lief[0].offen) === 1600 && Number(lief[1].offen) === 1760,
    `S2 getrennte Verbindlichkeiten je Einlieferer (cust-3: 1600; cust-1: 960+800=1760) (${S(lief)})`);
  ok(abgleich(db).length === 0, `S2 Abgleich (${abgleich(db).join(' | ') || 'ok'})`);
  const rec = receivablesBreakdown('branch-main');
  ok(rec.length === 1 && Math.abs(rec[0].open - 2100) < 0.001 && /3 items/.test(rec[0].detailLabel),
    `S2 Receivables EINE Zeile (offen 2100), nicht drei (${S(rec.map((x) => [x.reference, x.open, x.detailLabel]))})`);
  const seiten = loadConsignmentsFor(CTX).consignments.filter((k) => k.status === 'sold').map((k) => k.consignorSide?.open ?? -1).sort((x, y) => x - y);
  ok(S(seiten) === S([800, 960, 1600]), `S2 Einlieferer-Seite je Kommission offen 800/960/1600 (${S(seiten)})`);
  // Zahlungstag vor dem Verkaufstag → abgewiesen, nichts geschrieben.
  const db2 = freshDb();
  const x = await kommission(db2, 'cust-1', 'Nautilus');
  const vor = lc(db2);
  const frueh = await verkauf('primary', db2, { items: [{ consignmentId: x, salePrice: 1200, acknowledgeShortfall: false }],
    buyerId: 'cust-2', saleDate: '2026-09-11', specialMark: false, payments: [{ amount: 100, method: 'cash', paidDate: '2026-09-10' }] });
  ok(!frueh.ok && frueh.code === 'PAYMENT_DATE_BEFORE_INVOICE' && lc(db2) === vor && n(db2, 'SELECT COUNT(*) FROM purchases') === 0,
    `S2 Zahlung vor dem Verkaufstag → abgewiesen, nichts gebucht (${frueh.code})`);
  const zuviel = await verkauf('fern', db2, { items: [{ consignmentId: x, salePrice: 1200, acknowledgeShortfall: false }],
    buyerId: 'cust-2', saleDate: '2026-09-11', specialMark: false, payments: [{ amount: 1300, method: 'cash' }] });
  ok(!zuviel.ok && zuviel.code === 'PAYMENT_EXCEEDS_TOTAL' && lc(db2) === vor, `S2 Überzahlung → abgewiesen (${zuviel.code})`);
  const zukunft = await verkauf('primary', db2, { items: [{ consignmentId: x, salePrice: 1200, acknowledgeShortfall: false }],
    buyerId: 'cust-2', saleDate: '2099-01-01', specialMark: false });
  ok(!zukunft.ok && zukunft.code === 'INVALID_DATE' && lc(db2) === vor, `S2 Verkaufstag in der Zukunft → abgewiesen (${zukunft.code})`);
  // Vollzahlung mit Sonderkreis → FINAL.
  const voll = await verkauf('primary', db2, { items: [{ consignmentId: x, salePrice: 1200, acknowledgeShortfall: false }],
    buyerId: 'cust-2', saleDate: '2026-09-11', specialMark: true, payments: [{ amount: 1200, method: 'bank_transfer' }] });
  ok(voll.ok && s(db2, 'SELECT status FROM invoices') === 'FINAL' && n(db2, 'SELECT special_mark FROM invoices') === 1,
    `S2 Einzelverkauf mit Vollzahlung im Sonderkreis → FINAL (${voll.code || 'ok'})`);
}
marker('CONSIGNMENT_MULTI_SALE_TWO_CONSIGNORS_PAYMENTS_PROVED');

// ══ §3 — Sperren: Käufer = Einlieferer, Unterdeckung je Artikel, doppelt, schon verkauft, Doppelklick ══
{
  const db = freshDb();
  dritterKunde(db);
  const a = await kommission(db, 'cust-1', 'Nautilus');
  const b = await kommission(db, 'cust-3', 'Daytona', MODELLE.fixed);
  const vor = lc(db);
  const selbst = await verkauf('fern', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: b, salePrice: 1200, acknowledgeShortfall: false }], buyerId: 'cust-3', specialMark: false });
  ok(!selbst.ok && selbst.code === 'BUYER_IS_CONSIGNOR' && lc(db) === vor, `S3 Käufer = Einlieferer eines Artikels → abgewiesen (${selbst.code})`);
  const unter = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: b, salePrice: 800, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  ok(!unter.ok && unter.code === 'SALE_BELOW_FLOOR' && lc(db) === vor && n(db, 'SELECT COUNT(*) FROM purchases') === 0,
    `S3 Unterdeckung eines Artikels ohne Bestätigung → ganzer Verkauf abgewiesen, kein Einkauf (${unter.code})`);
  const doppelt = await verkauf('fern', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: a, salePrice: 1200, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  ok(!doppelt.ok && lc(db) === vor, `S3 dieselbe Kommission zweimal → abgewiesen (${doppelt.code})`);
  // Doppelklick / verlorene Antwort: derselbe Auftrag zweimal → genau EIN Verkauf, die Wiederholung ist ein Replay.
  const input: MI = { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: b, salePrice: 800, acknowledgeShortfall: true }], buyerId: 'cust-2', specialMark: false };
  const x = nx();
  const revs = { [a]: rev(db, a), [b]: rev(db, b) };
  nimm(db);
  const r1 = await fern(() => life.runRecordSale(deps(db), identity(x, OP_S), finance.consignmentSalesBody(input, revs)));
  const r2 = await fern(() => life.runRecordSale(deps(db), identity(x, OP_S), finance.consignmentSalesBody(input, revs)));
  ok(r1.ok && r2.ok && r2.replayed && n(db, 'SELECT COUNT(*) FROM invoices') === 1 && n(db, 'SELECT COUNT(*) FROM purchases') === 2,
    `S3 PC2 derselbe Auftrag zweimal → ein Verkauf, Wiederholung = Replay (${r1.code || 'ok'}/${r2.code || 'ok'} replay=${r2.replayed})`);
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss' AND related_entity_id = ?", [b]) === 1
    && n(db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss'") === 1,
  'S3 Verlust-Ausgabe NUR für den bestätigten Artikel unter dem Boden');
  // Ein zweiter, neuer Auftrag über dieselben Kommissionen (zweiter Klick, andere Kennung) → schon verkauft.
  const r3 = await verkauf('fern', db, input);
  ok(!r3.ok && ['CONSIGNMENT_NOT_ACTIVE', 'RECORD_CHANGED'].includes(r3.code) && n(db, 'SELECT COUNT(*) FROM invoices') === 1,
    `S3 neuer Auftrag über verkaufte Kommissionen → abgewiesen, keine zweite Rechnung (${r3.code})`);
  ok(abgleich(db).length === 0, `S3 Abgleich (${abgleich(db).join(' | ') || 'ok'})`);
  // Rollback: scheitert der Status des ZWEITEN Artikels (nach Rechnung, Zahlungen und beiden Einkäufen), bleibt nichts.
  const db2 = freshDb();
  const p1 = await kommission(db2, 'cust-1', 'Nautilus');
  const p2 = await kommission(db2, 'cust-1', 'Aquanaut');
  const vorher = S([lc(db2), n(db2, 'SELECT COUNT(*) FROM purchases'), n(db2, 'SELECT COUNT(*) FROM invoices'), all(db2, 'SELECT status FROM consignments ORDER BY id')]);
  let zeilen = 0;
  const { db: kaputt, f } = faulty(db2, (sql) => /UPDATE consignments SET/i.test(sql) && ++zeilen === 2);
  setTestDatabase(kaputt as never);
  reload();
  const roll = await primary(() => conHouse.recordConsignmentSalesOnPrimary({ items: [
    { consignmentId: p1, salePrice: 1200, acknowledgeShortfall: false }, { consignmentId: p2, salePrice: 1300, acknowledgeShortfall: false },
  ], buyerId: 'cust-2', specialMark: false, payments: [{ amount: 300, method: 'cash' }] }));
  f.armed = false;
  nimm(db2);
  const nachher = S([lc(db2), n(db2, 'SELECT COUNT(*) FROM purchases'), n(db2, 'SELECT COUNT(*) FROM invoices'), all(db2, 'SELECT status FROM consignments ORDER BY id')]);
  ok(f.fired && !roll.ok && nachher === vorher, `S3 ROLLBACK Fehler beim 2. Artikel → nichts bleibt, keine Rechnung, kein Einkauf, keine Zahlung (${roll.code.slice(0, 60)}; ${nachher === vorher ? 'gleich' : vorher + ' → ' + nachher})`);
  const heil = await verkauf('primary', db2, { items: [{ consignmentId: p1, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: p2, salePrice: 1300, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  ok(heil.ok && n(db2, 'SELECT COUNT(*) FROM invoices') === 1 && n(db2, 'SELECT COUNT(*) FROM purchases') === 2,
    `S3 danach gelingt derselbe Verkauf genau einmal (${heil.code || 'ok'})`);
}
marker('CONSIGNMENT_MULTI_SALE_GUARDS_IDEMPOTENCY_ROLLBACK_PROVED');

// ══ §4 — Einzelretoure auf der gemeinsamen Rechnung: nur DIESE Kommission ═════
{
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    const a = await kommission(db, 'cust-1', 'Nautilus');
    const b = await kommission(db, 'cust-1', 'Aquanaut');
    const r = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
      { consignmentId: b, salePrice: 1500, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false,
      payments: [{ amount: 1000, method: 'cash' }] });
    if (!r.ok) { ok(false, `S4 setup ${r.code}`); continue; }
    const bVor = S([row(db, 'SELECT status, invoice_id, sale_price FROM consignments WHERE id = ?', [b]),
      row(db, "SELECT status, total_amount, remaining_amount FROM purchases WHERE source_consignment_id = ?", [b])]);
    const ret = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' });
    ok(ret.ok, `S4 ${weg}: Rückgabe EINES Artikels der Sammelrechnung (${ret.code || 'ok'})`);
    const bNach = S([row(db, 'SELECT status, invoice_id, sale_price FROM consignments WHERE id = ?', [b]),
      row(db, "SELECT status, total_amount, remaining_amount FROM purchases WHERE source_consignment_id = ?", [b])]);
    ok(bVor === bNach, `S4 ${weg}: der andere Artikel bleibt unverändert verkauft, sein Einkauf offen (${bNach})`);
    ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [a]) === 'returned'
      && s(db, 'SELECT status FROM purchases WHERE source_consignment_id = ?', [a]) === 'CANCELLED',
    `S4 ${weg}: der zurückgegebene Artikel → returned, sein (unbezahlter) Einkauf storniert`);
    const inv = row(db, 'SELECT status, gross_amount, paid_amount FROM invoices');
    // Käufer hatte 1000 von 2700 bezahlt; nach der Retoure von 1200 schuldet er 1500 → keine Barerstattung, offen 500.
    const cn = row(db, 'SELECT cash_refund_amount, receivable_cancel_amount FROM credit_notes');
    ok(Number(cn.cash_refund_amount) < 0.005 && Math.abs(Number(cn.receivable_cancel_amount) - 1200) < 0.005,
      `S4 ${weg}: Erstattung nur, was über die neue Schuld hinaus bezahlt war (hier 0; Forderung −1200) (${S(cn)})`);
    const rec = receivablesBreakdown('branch-main');
    ok(rec.length === 1 && Math.abs(rec[0].open - 500) < 0.005, `S4 ${weg}: Receivables offen 500 (${S(rec.map((x) => x.open))}) — Rechnung ${S(inv)}`);
    ok(abgleich(db).length === 0, `S4 ${weg}: Abgleich (${abgleich(db).join(' | ') || 'ok'})`);
    // Gegenprobe: eine gewöhnliche Retoure (In Stock) des ZWEITEN Artikels von der Rechnung aus → gesperrt (alle gebunden).
    const lineB = s(db, 'SELECT il.id FROM invoice_lines il JOIN consignments c ON c.product_id = il.product_id WHERE c.id = ?', [b]);
    const lineRow = row(db, 'SELECT quantity, line_total, vat_amount FROM invoice_lines WHERE id = ?', [lineB]);
    const instock = await primary(() => returnHouse.createReturnOnPrimary({ invoiceId: s(db, 'SELECT id FROM invoices'),
      lines: [{ invoiceLineId: lineB, quantity: Number(lineRow.quantity) || 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: true } as never));
    ok(!instock.ok && instock.code === 'CONSIGNMENT_RETURN_VIA_CONSIGNMENT', `S4 ${weg}: „Back to Stock" für den 2. Kommissionsartikel → gesperrt (${instock.code})`);
  }
}
marker('CONSIGNMENT_MULTI_SALE_SINGLE_RETURN_PROVED');

// ══ §5 — Cancel Sale der GANZEN Rechnung (D2) ═════════════════════════════════
{
  for (const weg of ['primary', 'fern'] as const) {
    const db = freshDb();
    dritterKunde(db);
    const a = await kommission(db, 'cust-1', 'Nautilus');
    const b = await kommission(db, 'cust-3', 'Daytona', MODELLE.fixed);
    const r = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
      { consignmentId: b, salePrice: 800, acknowledgeShortfall: true }], buyerId: 'cust-2', specialMark: false,
      payments: [{ amount: 500, method: 'cash' }] });
    if (!r.ok) { ok(false, `S5 setup ${r.code}`); continue; }
    // Vorher eine Einzelretoure des ersten Artikels — der Storno nimmt auch sie mit (eigene Retoure der Kommission).
    const ret = await rueckgabeK('primary', db, a, { disposition: 'KEEP_AS_OWN', refundMethod: 'cash' });
    ok(ret.ok, `S5 ${weg}: Keep des ersten Artikels vor dem Storno (${ret.code || 'ok'})`);
    const st = await stornoK(weg, db, b);
    ok(st.ok && S((st.value.consignmentIds as string[] ?? []).slice().sort()) === S([a, b].sort()),
      `S5 ${weg}: Cancel Sale von EINER Kommission aus nimmt die GANZE Rechnung mit beiden zurück (${st.code || 'ok'})`);
    ok(n(db, "SELECT COUNT(*) FROM consignments WHERE status = 'active' AND invoice_id IS NULL") === 2
      && s(db, 'SELECT status FROM invoices') === 'CANCELLED'
      && n(db, "SELECT COUNT(*) FROM purchases WHERE status != 'CANCELLED'") === 0
      && n(db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss' AND status != 'CANCELLED'") === 0
      && n(db, "SELECT COUNT(*) FROM sales_returns WHERE status != 'REJECTED'") === 0,
    `S5 ${weg}: beide Kommissionen active, Rechnung CANCELLED, Einkäufe + Verlust storniert, Retoure REJECTED`);
    ok(Object.keys(konten(db)).every((k) => ['CASH', 'EXPENSES_OPERATING', 'CARD_FEES', 'BANK_FEES'].includes(k)) && balanced(db),
      `S5 ${weg}: Umsatz, Lager, Forderung, Verbindlichkeit, Steuer — null (${S(konten(db))})`);
    ok(audits(db, 'cancel_sale') === 2, `S5 ${weg}: je Kommission ein Protokoll (${audits(db, 'cancel_sale')})`);
  }
}
marker('CONSIGNMENT_MULTI_SALE_CANCEL_WHOLE_INVOICE_PROVED');

// ══ §6 — D3: Einlieferer schon bezahlt ════════════════════════════════════════
async function bezahlteWelt(weg: Weg): Promise<{ db: Db; a: string; b: string }> {
  const db = freshDb();
  const a = await kommission(db, 'cust-1', 'Nautilus');
  const b = await kommission(db, 'cust-1', 'Aquanaut');
  const r = await verkauf(weg, db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false },
    { consignmentId: b, salePrice: 1500, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false,
    payments: [{ amount: 2700, method: 'cash' }] });
  if (!r.ok) throw new Error('setup paid world: ' + r.code);
  bezahleEinlieferer(db, a, 960, 'bank');
  return { db, a, b };
}
const kasse = (db: Db, konto: string): number => konten(db)[konto] ?? 0;
for (const weg of ['primary', 'fern'] as const) {
  // (10) Keep: die Auszahlung bleibt, die Uhr ist eigene Ware zum bezahlten Einstand, nichts Fiktives.
  {
    const { db, a } = await bezahlteWelt(weg);
    const bank = kasse(db, 'BANK');
    const r = await rueckgabeK(weg, db, a, { disposition: 'KEEP_AS_OWN', refundMethod: 'cash' });
    const p = row(db, 'SELECT stock_status, source_type, purchase_price FROM products WHERE id = (SELECT product_id FROM consignments WHERE id = ?)', [a]);
    ok(r.ok && s(db, 'SELECT status FROM purchases WHERE source_consignment_id = ?', [a]) === 'PAID'
      && p.source_type === 'OWN' && p.stock_status === 'in_stock' && Math.abs(Number(p.purchase_price) - 960) < 0.005
      && kasse(db, 'BANK') === bank && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
    `D3 ${weg} (10) bezahlt → Keep: Einkauf bleibt PAID, Uhr OWN zum Einstand 960, Bank unverändert, keine Rückbuchung (${r.code || 'ok'} ${S(p)})`);
    ok(abgleich(db).length === 0, `D3 ${weg} (10) Abgleich nach Keep (${abgleich(db).join(' | ') || 'ok'})`);
  }
  // (11) Return to Consignor — Geld sofort zurück (Bank), mit tatsächlichem Eingang.
  {
    const { db, a, b } = await bezahlteWelt(weg);
    const vor = S([lc(db), all(db, 'SELECT status FROM consignments ORDER BY id')]);
    const ohne = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' });
    ok(!ohne.ok && ohne.code === 'CONSIGNOR_REFUND_REQUIRED' && S([lc(db), all(db, 'SELECT status FROM consignments ORDER BY id')]) === vor,
      `D3 ${weg} (11) bezahlt → Return ohne Wahl: abgewiesen, nichts verändert (${ohne.code})`);
    const bank = kasse(db, 'BANK');
    const r = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', consignorRefund: { mode: 'received', method: 'bank' } });
    const pret = row(db, "SELECT status, refund_method, refund_amount, notes FROM purchase_returns");
    ok(r.ok && pret.status === 'COMPLETED' && pret.refund_method === 'bank' && Math.abs(Number(pret.refund_amount) - 960) < 0.005,
      `D3 ${weg} (11) Rückgabe mit „received/bank": Lieferanten-Retoure COMPLETED, 960 per Bank (${r.code || 'ok'} ${S(pret)})`);
    ok(Math.abs(kasse(db, 'BANK') - bank - 960) < 0.005 && n(db, "SELECT COUNT(*) FROM purchase_payments") === 1
      && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
    `D3 ${weg} (11) Bank +960 als echter Eingang; die ursprüngliche Auszahlung bleibt in der Historie, keine Umkehrbuchung`);
    ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [b]) === 'sold', `D3 ${weg} (11) der andere Artikel bleibt verkauft`);
    ok(abgleich(db).length === 0 && Math.abs(Math.abs(konten(db).ACCOUNTS_PAYABLE ?? 0) - 1200) < 0.005,
      `D3 ${weg} (11) Abgleich; AP nur noch die 1200 des anderen Artikels (${abgleich(db).join(' | ') || S(konten(db))})`);
    const side = loadConsignmentsFor(CTX).consignments.find((k) => k.id === a)?.consignorSide;
    ok(side?.refunds.length === 1 && side.refunds[0].mode === 'received' && side.refunds[0].method === 'bank' && side.refundOpen === 0,
      `D3 ${weg} (11) Anzeige: Rückzahlung erhalten (bank), nichts offen (${S(side)})`);
    // Danach ist der Verkauf nicht mehr still stornierbar (die Ware ist beim Einlieferer, das Geld zurück).
    const st = await stornoK(weg, db, a, { [a]: { mode: 'received', method: 'cash' } });
    ok(!st.ok && st.code === 'CONSIGNMENT_CONSIGNOR_SETTLED', `D3 ${weg} (11) Cancel Sale danach → abgewiesen (${st.code})`);
  }
  // (12) Return to Consignor — Rückzahlung offen (pending), später teilweise verrechnet.
  {
    const { db, a } = await bezahlteWelt(weg);
    const cash = kasse(db, 'CASH'); const bank = kasse(db, 'BANK');
    const r = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', consignorRefund: { mode: 'pending' } });
    const sc = row(db, 'SELECT amount, used_amount, status, source_return_id IS NOT NULL AS r FROM supplier_credits');
    ok(r.ok && Math.abs(Number(sc.amount) - 960) < 0.005 && Number(sc.used_amount) === 0 && sc.status === 'OPEN' && Number(sc.r) === 1,
      `D3 ${weg} (12) „pending": offene Rückforderung 960 als Lieferanten-Guthaben beim Einlieferer (${r.code || 'ok'} ${S(sc)})`);
    ok(Math.abs(kasse(db, 'CASH') - cash + 1200) < 0.005 && kasse(db, 'BANK') === bank,
      `D3 ${weg} (12) kein fiktiver Geldeingang: Bank unverändert (nur die Barerstattung an den Käufer floss) (${S(konten(db))})`);
    ok(abgleich(db).length === 0, `D3 ${weg} (12) Abgleich mit offener Rückforderung (${abgleich(db).join(' | ') || 'ok'})`);
    let side = loadConsignmentsFor(CTX).consignments.find((k) => k.id === a)?.consignorSide;
    ok(side?.refunds[0]?.mode === 'pending' && side.refundOpen === 960, `D3 ${weg} (12) Anzeige: Pending, offen 960 (${S(side)})`);
    // Verrechnung (bestehende Regel): ein neuer Verkauf desselben Einlieferers, sein Einkauf teilweise mit dem Guthaben bezahlt.
    const c = await kommission(db, 'cust-1', 'Calatrava');
    const v = await verkauf('primary', db, { items: [{ consignmentId: c, salePrice: 625, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
    ok(v.ok, `D3 ${weg} (12) neuer Verkauf desselben Einlieferers (${v.code || 'ok'})`);
    nimm(db);
    imHaus(() => useSupplierStore.getState().applyCreditToPurchase(s(db, 'SELECT id FROM supplier_credits'), einkaufVon(db, c), 500));
    reload();
    side = loadConsignmentsFor(CTX).consignments.find((k) => k.id === a)?.consignorSide;
    ok(side?.refundOpen === 460 && kasse(db, 'BANK') === bank, `D3 ${weg} (12) 500 verrechnet → offen 460, kein Geldfluss (${S(side?.refunds)})`);
    ok(abgleich(db).length === 0, `D3 ${weg} (12) Abgleich nach Verrechnung (${abgleich(db).join(' | ') || 'ok'})`);
  }
  // (9) Einlieferer noch nicht bezahlt → wie bisher (Storno des Einkaufs), keine Wahl nötig.
  {
    const db = freshDb();
    const a = await kommission(db, 'cust-1', 'Nautilus');
    await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1200, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
    const r = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER' });
    ok(r.ok && s(db, 'SELECT status FROM purchases') === 'CANCELLED' && n(db, 'SELECT COUNT(*) FROM purchase_returns') === 0
      && Object.keys(konten(db)).length === 0,
    `D3 ${weg} (9) unbezahlt → Return wie bisher: Einkauf storniert, alle Konten 0 (${r.code || 'ok'} ${S(konten(db))})`);
  }
  // Cancel Sale mit EINEM bezahlten Einlieferer auf der Sammelrechnung: Wahl je Kommission.
  {
    const { db, a, b } = await bezahlteWelt(weg);
    const ohne = await stornoK(weg, db, b);
    ok(!ohne.ok && ohne.code === 'CONSIGNOR_REFUND_REQUIRED', `D3 ${weg} Cancel Sale ohne Wahl für den bezahlten Einlieferer → abgewiesen (${ohne.code})`);
    const bank = kasse(db, 'BANK');
    const st = await stornoK(weg, db, b, { [a]: { mode: 'pending' } });
    ok(st.ok && n(db, "SELECT COUNT(*) FROM consignments WHERE status = 'active'") === 2
      && s(db, "SELECT status FROM purchases WHERE source_consignment_id = ?", [b]) === 'CANCELLED'
      && n(db, "SELECT COUNT(*) FROM supplier_credits WHERE status = 'OPEN' AND ABS(amount - 960) < 0.001") === 1
      && kasse(db, 'BANK') === bank,
    `D3 ${weg} Cancel Sale: unbezahlter Einkauf storniert, bezahlter → offene Rückforderung 960, Bank unverändert (${st.code || 'ok'})`);
    ok(abgleich(db).length === 0, `D3 ${weg} Cancel Sale Abgleich (${abgleich(db).join(' | ') || 'ok'})`);
    // Neu verkauft: der frühere, über die Lieferanten-Retoure zurückgenommene Einkauf gehört NICHT zum neuen Verkauf —
    // Rückgabe und Storno des neuen Verkaufs gehen wie gewohnt (vorher hätte der alte Einkauf sie gesperrt).
    let side = loadConsignmentsFor(CTX).consignments.find((k) => k.id === a)?.consignorSide;
    ok(side?.refunds.length === 1 && side.refunds[0].currentSale === false && side.refundOpen === 960,
      `D3 ${weg} nach dem Storno: die offene Rückforderung bleibt sichtbar, gehört zu keinem jetzigen Verkauf (${S(side?.refunds)})`);
    const neu = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1300, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
    ok(neu.ok, `D3 ${weg} derselbe Artikel wird neu verkauft (${neu.code || 'ok'})`);
    const st2 = await stornoK(weg, db, a);
    ok(st2.ok && s(db, 'SELECT status FROM consignments WHERE id = ?', [a]) === 'active'
      && n(db, "SELECT COUNT(*) FROM supplier_credits WHERE status = 'OPEN' AND ABS(amount - 960) < 0.001") === 1,
    `D3 ${weg} Cancel Sale des neuen (unbezahlten) Verkaufs geht; die alte Rückforderung bleibt unberührt (${st2.code || 'ok'})`);
    const neu2 = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1300, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
    const ret2 = await rueckgabeK(weg, db, a, { disposition: 'RETURN_TO_OWNER' });
    side = loadConsignmentsFor(CTX).consignments.find((k) => k.id === a)?.consignorSide;
    ok(neu2.ok && ret2.ok && s(db, 'SELECT status FROM consignments WHERE id = ?', [a]) === 'returned'
      && n(db, "SELECT COUNT(*) FROM purchase_returns WHERE status != 'CANCELLED'") === 1,
    `D3 ${weg} Rückgabe des neuen (unbezahlten) Verkaufs geht wie bisher — Einkauf storniert, keine zweite Lieferanten-Retoure (${neu2.code || 'ok'}/${ret2.code || 'ok'})`);
    ok(abgleich(db).length === 0, `D3 ${weg} Abgleich nach Neuverkauf und Rückgabe (${abgleich(db).join(' | ') || 'ok'})`);
  }
}
marker('CONSIGNMENT_D3_PAID_CONSIGNOR_PROVED');

// ══ §7 — Quelltext: der Einzelverkauf IST der gemeinsame; keine zweite Zahlungslogik ══
{
  const store = codeOf(src('src/stores/consignmentStore.ts'));
  ok(/recordSale: \(id, params\) => \{\s*const r = get\(\)\.recordSales\(/.test(store), 'SRC der Einzelverkauf ruft recordSales (ein Weg)');
  ok(/createInvoiceInHouse\(/.test(store) && !/\.recordPayment\(/.test(store), 'SRC Zahlungen über createInvoiceInHouse — kein eigenes recordPayment');
  const rev2 = codeOf(src('src/core/consignment/consignment-reversal-house.ts'));
  ok(/confirmPurchaseReturnInHouse\(/.test(rev2) && !/postEntries\(|reverseSource\(/.test(rev2),
    'SRC D3 bucht über die vorhandene Lieferanten-Retoure — keine eigene Buchung');
}

console.log(fails.length === 0
  ? `PASS — consignment multi-sale + D3: ${PASS} passed, 0 failed\nCONSIGNMENT_MULTI_SALE_D3_PROVED`
  : `FAIL — consignment multi-sale + D3: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

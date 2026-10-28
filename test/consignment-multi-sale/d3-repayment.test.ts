// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT D3 — die spätere tatsächliche Rückzahlung einer offenen Rückforderung: der Einlieferer bekam seine
// Auszahlung (850), die Ware ging nach der Kundenretoure an ihn zurück, das Geld kommt später — in Teilen, mit Tag und
// Weg (DR Kasse/Bank/Benefit / CR SUPPLIER_CREDIT, dieselbe Paarung wie „Refund Credit"). Verrechnung, Wiederholung,
// Überzahlung, doppelte Verwendung, Tag-/Quartalssperren, Rollback, Banking, Gegenpartei-Prüfung, Primary == PC2.
// Run: node --experimental-strip-types test/consignment-multi-sale/d3-repayment.test.ts
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

// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT D3 — spätere tatsächliche Rückzahlung einer offenen Rückforderung (Teil, Rest, Verrechnung, Sperren).
// ════════════════════════════════════════════════════════════════════════════
const payables = await import('../../src/core/payables/payables-house.ts');
const pcmd = await import('../../src/core/bridge/payables-commands.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const { loadBankingFor } = await import('../../src/stores/bankingStore.ts');
const OP_REF = 'suppliers.refund_credit';
/** Fern mit der echten Uhr: die Rückforderung entstand heute (Primary), der Eingang wird gegen heute geprüft. */
const jetzt = (db: Db) => ({ ...deps(db), now: () => new Date().toISOString() });
const heute = (): string => new Date().toISOString().slice(0, 10);
const gestern = (): string => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/** 850 an den Einlieferer ausgezahlt, Ware nach der Kundenretoure an ihn zurück, Rückzahlung offen (pending). */
async function offeneRueckforderung(): Promise<{ db: Db; cid: string; creditId: string; supplierId: string }> {
  const db = freshDb();
  const cid = await kommission(db, 'cust-1', 'Nautilus');
  const v = await verkauf('primary', db, { items: [{ consignmentId: cid, salePrice: 1062.5, acknowledgeShortfall: false }],
    buyerId: 'cust-2', saleDate: gestern(), specialMark: false, payments: [{ amount: 1062.5, method: 'cash', paidDate: gestern() }] });
  if (!v.ok) throw new Error('setup sale: ' + v.code);
  bezahleEinlieferer(db, cid, 850, 'bank');
  const r = await rueckgabeK('primary', db, cid, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', consignorRefund: { mode: 'pending' } });
  if (!r.ok) throw new Error('setup return: ' + r.code);
  const sc = row(db, 'SELECT id, supplier_id FROM supplier_credits');
  return { db, cid, creditId: String(sc.id), supplierId: String(sc.supplier_id) };
}
function zahleZurueck(weg: Weg, db: Db, body: Record<string, unknown>, x = nx()): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => imHaus(() => payables.recordSupplierCreditRefundInHouse(body as never, payables.localHouseCtx())))
    : fern(() => pcmd.runSupplierRefund(jetzt(db), identity(x, OP_REF), body));
}
const seite = (cid: string) => loadConsignmentsFor(CTX).consignments.find((k) => k.id === cid)?.consignorSide;
const konto = (db: Db, a: string): number => konten(db)[a] ?? 0;
const bankingIn = () => loadBankingFor(CTX).transactions.filter((t) => t.type === 'REFUND' && t.flow === 'in')
  .map((t) => [t.account, t.amount, t.description.split(' · ')[0]]);
const pruefung = (db: Db) => runCounterpartyAudit((sql, p) => rows(db, sql, p ?? []), 'branch-main').issues
  .filter((i) => i.side === 'supplier' && i.severity !== 'warning' || i.kind === 'used_drift');

// ══ §1 — Teil-, dann Restzahlung (Primary == PC2) ═══════════════════════════
{
  const bilder: string[] = [];
  for (const weg of ['primary', 'fern'] as const) {
    const { db, cid, creditId, supplierId } = await offeneRueckforderung();
    const kasse0 = konto(db, 'CASH'); const bank0 = konto(db, 'BANK');
    ok(Math.abs(konto(db, 'SUPPLIER_CREDIT') - 850) < 0.005 && seite(cid)?.refunds[0]?.open === 850 && S(bankingIn()) === '[]',
      `R1 ${weg}: offene Rückforderung 850, KEIN Geldeingang in der Banking-Liste (${S(bankingIn())})`);
    // 500 bar, gestern erhalten.
    const t1 = await zahleZurueck(weg, db, { creditId, amount: 500, method: 'cash', receivedDate: heute(), reference: 'Q-1' });
    const s1 = seite(cid)?.refunds[0];
    ok(t1.ok && s1?.open === 350 && s1?.received === 500 && s1?.receipts.length === 1 && s1.receipts[0].method === 'cash' && s1.receipts[0].date === heute(),
      `R2 ${weg}: 500 bar erhalten → offen 350, Eingang mit Tag und Weg (${t1.code || 'ok'} ${S(s1)})`);
    ok(Math.abs(konto(db, 'CASH') - kasse0 - 500) < 0.005 && Math.abs(konto(db, 'SUPPLIER_CREDIT') - 350) < 0.005 && konto(db, 'BANK') === bank0,
      `R2 ${weg}: Hauptbuch DR Kasse 500 / CR Lieferanten-Guthaben 500 (${S(konten(db))})`);
    const l1 = rows(db, "SELECT account, direction, amount, counterparty_id, substr(occurred_at, 1, 10) AS tag FROM ledger_entries WHERE source_module = 'SUPPLIER_CREDIT_REFUND' ORDER BY direction");
    ok(l1.length === 2 && l1.every((l) => l.counterparty_id === supplierId && l.tag === heute()),
      `R2 ${weg}: eigene Quelle SUPPLIER_CREDIT_REFUND, Gegenpartei = Einlieferer, gebucht am Tag des Eingangs (${S(l1)})`);
    ok(S(bankingIn()) === S([['cash', 500, 'Repayment received']]), `R2 ${weg}: Banking zeigt den tatsächlichen Eingang (${S(bankingIn())})`);
    ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'supplier_credits' AND field_name = 'repayment_received'") === 1,
      `R2 ${weg}: Protokoll des Eingangs`);
    // Überzahlung → Nein, nichts verändert.
    const vor = S([lc(db), n(db, 'SELECT used_amount FROM supplier_credits'), n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds')]);
    const zuviel = await zahleZurueck(weg, db, { creditId, amount: 350.001, method: 'cash' });
    ok(!zuviel.ok && zuviel.code === 'SUPPLIER_CREDIT_REFUND_EXCEEDS_OPEN'
      && S([lc(db), n(db, 'SELECT used_amount FROM supplier_credits'), n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds')]) === vor,
    `R3 ${weg}: mehr als offen (350.001) → abgewiesen, nichts gebucht (${zuviel.code})`);
    // Rest 350 per Bank, heute.
    const t2 = await zahleZurueck(weg, db, { creditId, amount: 350, method: 'bank' });
    const s2 = seite(cid)?.refunds[0];
    ok(t2.ok && s2?.open === 0 && s2?.received === 850 && s2?.offset === 0 && s(db, 'SELECT status FROM supplier_credits') === 'USED',
      `R4 ${weg}: Rest 350 per Bank → vollständig zurückgezahlt, Guthaben USED (${t2.code || 'ok'} ${S(s2)})`);
    ok(Math.abs(konto(db, 'BANK') - bank0 - 350) < 0.005 && Math.abs(konto(db, 'SUPPLIER_CREDIT')) < 0.005
      && Math.abs(konto(db, 'CASH') - kasse0 - 500) < 0.005,
    `R4 ${weg}: Bank +350, Lieferanten-Guthaben 0 (${S(konten(db))})`);
    const weiter = await zahleZurueck(weg, db, { creditId, amount: 1, method: 'cash' });
    ok(!weiter.ok && weiter.code === 'SUPPLIER_CREDIT_NOT_OPEN', `R5 ${weg}: nach vollständiger Rückzahlung kein weiterer Eingang (${weiter.code})`);
    // Die ursprüngliche Auszahlung bleibt — nie umgebucht.
    ok(n(db, "SELECT COUNT(*) FROM purchase_payments") === 1
      && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND reverses_entry_id IS NOT NULL") === 0,
    `R6 ${weg}: die Auszahlung 850 bleibt in der Historie, keine Umkehrbuchung`);
    ok(abgleich(db).length === 0 && pruefung(db).length === 0,
      `R7 ${weg}: Abgleich (Lager, AP, Guthaben) und Gegenpartei-Prüfung ohne Befund (${abgleich(db).join(' | ') || S(pruefung(db))})`);
    bilder.push(S({ konten: konten(db), sc: all(db, 'SELECT amount, used_amount, status FROM supplier_credits'),
      ref: all(db, 'SELECT amount, method, substr(received_at,1,10), reference FROM supplier_credit_refunds ORDER BY amount') }));
  }
  ok(bilder[0] === bilder[1], 'R8 PARITY Primary == PC2 (Konten, Guthaben, Eingänge)');
}
marker('CONSIGNMENT_D3_REPAYMENT_PARTIAL_FULL_PROVED');

// ══ §2 — Verrechnung + Eingang; Wiederholung; gleichzeitiger zweiter Eingang ══
{
  const { db, cid, creditId } = await offeneRueckforderung();
  // 300 mit dem nächsten Verkauf desselben Einlieferers verrechnet (bestehende Regel: Zahlweg „Credit").
  const k2 = await kommission(db, 'cust-1', 'Calatrava');
  await verkauf('primary', db, { items: [{ consignmentId: k2, salePrice: 375, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  nimm(db);
  imHaus(() => useSupplierStore.getState().applyCreditToPurchase(creditId, einkaufVon(db, k2), 300));
  reload();
  // Wiederholung: derselbe PC2-Auftrag zweimal → EIN Eingang, die zweite Antwort ist ein Replay.
  const x = nx();
  const a = await zahleZurueck('fern', db, { creditId, amount: 200, method: 'benefit' }, x);
  const b = await zahleZurueck('fern', db, { creditId, amount: 200, method: 'benefit' }, x);
  ok(a.ok && b.ok && b.replayed && n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds') === 1,
    `V1 derselbe Auftrag zweimal → ein Eingang, Replay (${a.code || 'ok'}/${b.code || 'ok'} replay=${b.replayed})`);
  // Zwei verschiedene Aufträge über denselben Rest (Doppelklick auf zwei Rechnern): nur der erste.
  const c1 = await zahleZurueck('fern', db, { creditId, amount: 350, method: 'cash' });
  const c2 = await zahleZurueck('primary', db, { creditId, amount: 350, method: 'cash' });
  ok(c1.ok && !c2.ok && ['SUPPLIER_CREDIT_NOT_OPEN', 'SUPPLIER_CREDIT_REFUND_EXCEEDS_OPEN'].includes(c2.code),
    `V2 derselbe Rest zweimal → nur einmal gebucht, keine doppelte Verwendung (${c1.code || 'ok'}/${c2.code})`);
  const sd = seite(cid)?.refunds[0];
  ok(sd?.open === 0 && sd?.received === 550 && sd?.offset === 300 && s(db, 'SELECT status FROM supplier_credits WHERE id = ?', [creditId]) === 'USED',
    `V3 300 verrechnet + 200 Benefit + 350 bar = 850 → ausgeglichen (${S(sd)})`);
  ok(abgleich(db).length === 0 && pruefung(db).length === 0, `V4 Abgleich und Gegenpartei-Prüfung (Verrechnung + Eingänge = verbraucht) (${abgleich(db).join(' | ') || S(pruefung(db))})`);
}
marker('CONSIGNMENT_D3_REPAYMENT_OFFSET_REPEAT_PROVED');

// ══ §3 — Sperren: Tag, Quartal, falsches Guthaben, Weg, Betrag; Rollback ═════
{
  const { db, creditId } = await offeneRueckforderung();
  const vor = S([lc(db), n(db, 'SELECT used_amount FROM supplier_credits'), n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds')]);
  const morgen = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const zukunft = await zahleZurueck('fern', db, { creditId, amount: 100, method: 'cash', receivedDate: morgen });
  ok(!zukunft.ok && zukunft.code === 'PAYMENT_DATE_INVALID', `P1 Tag in der Zukunft → abgewiesen (${zukunft.code})`);
  const zufrueh = await zahleZurueck('primary', db, { creditId, amount: 100, method: 'cash', receivedDate: '2026-01-02' });
  ok(!zufrueh.ok && zufrueh.code === 'PAYMENT_DATE_BEFORE_CLAIM', `P2 vor der Rückgabe → abgewiesen (${zufrueh.code})`);
  const weg = await zahleZurueck('fern', db, { creditId, amount: 100, method: 'credit' });
  ok(!weg.ok && weg.code === 'PAYMENT_METHOD_INVALID', `P3 Weg „credit" ist kein Geldeingang → abgewiesen (${weg.code})`);
  const null0 = await zahleZurueck('primary', db, { creditId, amount: 0, method: 'cash' });
  ok(!null0.ok && null0.code === 'PAYMENT_AMOUNT_INVALID', `P4 Betrag 0 → abgewiesen (${null0.code})`);
  // Eingereichtes VAT-Quartal des Eingangstags.
  const [y, mo] = heute().split('-').map(Number);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf-d3','branch-main',?,?,?, 'user-test', 0, '{}', ?)`, [y, Math.ceil(mo / 3), NOW, NOW]);
  const quartal = await zahleZurueck('fern', db, { creditId, amount: 100, method: 'cash' });
  ok(!quartal.ok && quartal.code === 'VAT_PERIOD_FILED', `P5 Tag in einem eingereichten Quartal → abgewiesen (${quartal.code})`);
  db.run("DELETE FROM vat_filings WHERE id = 'vf-d3'");
  ok(S([lc(db), n(db, 'SELECT used_amount FROM supplier_credits'), n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds')]) === vor,
    'P6 kein abgewiesener Versuch hat etwas gebucht');
  // Ein Standalone-Guthaben ist keine Rückforderung aus einer Retoure: Betrag → Nein; der bisherige „Refund Credit" (ohne
  // Betrag) bleibt unverändert.
  nimm(db);
  const sid = s(db, 'SELECT supplier_id FROM supplier_credits WHERE id = ?', [creditId]);
  const vorab = imHaus(() => payables.grantStandaloneCreditInHouse(sid, 40, 'cash', 'Vorauszahlung', payables.localHouseCtx()));
  const falsch = await zahleZurueck('fern', db, { creditId: vorab, amount: 10, method: 'cash' });
  ok(!falsch.ok && falsch.code === 'SUPPLIER_CREDIT_NOT_A_RETURN_CREDIT', `P7 Standalone-Guthaben über „Record Repayment" → abgewiesen (${falsch.code})`);
  const alt = await fern(() => pcmd.runSupplierRefund(deps(db), identity(nx(), OP_REF), { creditId: vorab }));
  ok(alt.ok && n(db, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [vorab]) === 0, `P8 der bisherige „Refund Credit" (nur creditId) arbeitet wie zuvor (${alt.code || 'ok'})`);
  // Rollback: scheitert die Buchung, bleibt weder Beleg noch verbrauchtes Guthaben.
  const { db: kaputt, f } = faulty(db, (sql) => /INSERT INTO ledger_entries/i.test(sql));
  setTestDatabase(kaputt as never);
  const roll = await primary(() => imHaus(() => payables.recordSupplierCreditRefundInHouse({ creditId, amount: 100, method: 'cash' }, payables.localHouseCtx())));
  f.armed = false;
  nimm(db);
  ok(f.fired && !roll.ok && n(db, 'SELECT COUNT(*) FROM supplier_credit_refunds') === 0 && n(db, 'SELECT used_amount FROM supplier_credits WHERE id = ?', [creditId]) === 0,
    `P9 ROLLBACK Buchungsfehler → kein Beleg, Guthaben unverändert (${roll.code.slice(0, 60)})`);
  // Rumpf: unbekanntes Feld / Weg fehlt → unbrauchbarer Rumpf.
  let rumpf = '';
  try { pcmd.parseSupplierRefund({ creditId, amount: 10 }); } catch (e) { rumpf = (e as Error).message; }
  ok(/method is required/.test(rumpf), `P10 Rumpf mit Betrag ohne Weg → unbrauchbar (${rumpf})`);
}
marker('CONSIGNMENT_D3_REPAYMENT_GUARDS_PROVED');

console.log(fails.length === 0
  ? `PASS — consignment D3 repayment: ${PASS} passed, 0 failed\nCONSIGNMENT_D3_REPAYMENT_PROVED`
  : `FAIL — consignment D3 repayment: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

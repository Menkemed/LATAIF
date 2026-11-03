// ════════════════════════════════════════════════════════════════════════════
// HOTFIX B6 — Startmigration: die Kopf-Kommission eines Einkaufs nur, wo er GENAU EINER Kommission gehört.
// Run: node test/hotfix-b6/b6-joint-purchase.test.ts
//   §A gemeinsamer Einkauf (Primary + PC2): Kopf bleibt leer, auch nach wiederholtem Start; alter Nachtrag zum Vergleich
//   §B Auszahlung und Rückforderung bleiben bei der richtigen Kommission   §C Einzel-Einkauf unverändert
//   §D Altbestand: eindeutig → nachgetragen, mehrdeutig → leer   §E Fehler mitten im Nachtrag → keine Teiländerung
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
// CONSIGNOR-JOINT-PURCHASE — der Einkauf einer Kommission: an der Spalte des Einkaufs (allein) oder an seiner Zeile (gemeinsam).
const einkaufVon = (db: Db, cid: string): string => s(db, `SELECT p.id FROM purchases p WHERE p.status != 'CANCELLED'
  AND (p.source_consignment_id = ? OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?))
  ORDER BY p.rowid DESC LIMIT 1`, [cid, cid]);
function bezahleEinlieferer(db: Db, cid: string, betrag: number, weg = 'cash'): void {
  nimm(db);
  usePurchaseStore.getState().loadPurchases();
  imHaus(() => usePurchaseStore.getState().addPayment(einkaufVon(db, cid), betrag, weg));
  reload();
}

// ════════════════════════════════════════════════════════════════════════════
// B6 — der Nachtrag, wie er jetzt in den Startmigrationen steht, und der bisherige (bis ce947d32) zum Vergleich.
// ════════════════════════════════════════════════════════════════════════════
const B6 = MIGRATIONS.find((m) => m.includes('UPDATE purchases SET source_consignment_id'))!;
const ALT_B6 = `UPDATE purchases SET source_consignment_id = (
        SELECT c.id FROM consignments c
         WHERE c.branch_id = purchases.branch_id
           AND purchases.notes LIKE '%' || c.consignment_number || '%'
           AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = purchases.id AND pl.product_id = c.product_id)
         ORDER BY LENGTH(c.consignment_number) DESC, c.id LIMIT 1)
      WHERE source_consignment_id IS NULL AND notes LIKE 'Consignor payout%'
        AND EXISTS (
          SELECT 1 FROM consignments c
           WHERE c.branch_id = purchases.branch_id
             AND purchases.notes LIKE '%' || c.consignment_number || '%'
             AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = purchases.id AND pl.product_id = c.product_id))`;
/** Ein App-Start: ALLE Startmigrationen in ihrer Reihenfolge (jede für sich; was schon da ist, scheitert still — wie runMigrations). */
function neustart(db: Db): void { for (const st of MIGRATIONS) { try { db.run(st); } catch { /* schon da */ } } }
const kopf = (db: Db, pid: string): string => s(db, "SELECT COALESCE(source_consignment_id, '-') FROM purchases WHERE id = ?", [pid]);
const fassung = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);
const seiteVon = (cid: string) => loadConsignmentsFor(CTX).consignments.find((k) => k.id === cid)?.consignorSide;
const gemeinsamerEinkauf = (db: Db, a: string, b: string): string => s(db, `SELECT p.id FROM purchases p WHERE p.status != 'CANCELLED'
  AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?)
  AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?)`, [a, b]);
async function gemeinsamerVerkauf(weg: Weg) {
  const db = freshDb();
  const a = await kommission(db, 'cust-1', 'Rolex');
  const b = await kommission(db, 'cust-1', 'Omega');
  const r = await verkauf(weg, db, { items: [
    { consignmentId: a, salePrice: 1000, acknowledgeShortfall: false }, { consignmentId: b, salePrice: 500, acknowledgeShortfall: false },
  ], buyerId: 'cust-2', saleDate: '2026-09-12', specialMark: false });
  nimm(db);
  return { db, a, b, r, pid: gemeinsamerEinkauf(db, a, b) };
}

// ── §A gemeinsamer Einkauf ──────────────────────────────────────────────────────────────────────
{
  const bild: string[] = [];
  for (const weg of ['primary', 'fern'] as const) {
    const { db, a, b, r, pid } = await gemeinsamerVerkauf(weg);
    ok(r.ok && !!pid && kopf(db, pid) === '-', `§A ${weg}: ein gemeinsamer Einkauf, Kopf leer, beide Zeilen nennen ihre Kommission (${r.code || 'ok'})`);
    const v0 = fassung(db, pid);
    neustart(db); neustart(db); nimm(db);
    ok(kopf(db, pid) === '-' && fassung(db, pid) === v0, `§A ${weg}: zwei Neustarts — Kopf bleibt leer, keine neue Fassung (${kopf(db, pid)} ${v0}→${fassung(db, pid)})`);
    const sa = seiteVon(a), sb = seiteVon(b);
    ok(sa?.open === 800 && sb?.open === 400, `§A ${weg}: Einlieferer-Seite je Kommission richtig: offen 800 / 400 (${S([sa?.open, sb?.open])})`);
    bild.push(S([kopf(db, pid), all(db, 'SELECT quantity, line_total FROM purchase_lines WHERE purchase_id = ? ORDER BY position', [pid]), sa?.open, sb?.open]));
  }
  ok(bild[0] === bild[1], `§A Primary = PC2 (${bild.join(' | ')})`);
  // Zum Vergleich: der bisherige Nachtrag setzt den Kopf auf EINE der beiden — dann fehlt der anderen ihre Seite.
  const { db, a, b, pid } = await gemeinsamerVerkauf('primary');
  db.run(ALT_B6); nimm(db);
  const falsch = kopf(db, pid);
  const verloren = [a, b].filter((k) => !seiteVon(k));
  ok((falsch === a || falsch === b) && verloren.length === 1,
    `§A Gegenprobe alter Nachtrag: Kopf willkürlich auf ${falsch === a ? 'A' : 'B'}, der anderen Kommission fehlt die Seite (bisheriger Fehler, R4)`);
}

// ── §B Auszahlung und Rückforderung ─────────────────────────────────────────────────────────────
{
  const { db, a, b, pid } = await gemeinsamerVerkauf('primary');
  bezahleEinlieferer(db, a, 1200);
  const ret = await rueckgabeK('primary', db, a, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', consignorRefund: { mode: 'pending' } });
  nimm(db);
  const geld = (): string => S([row(db, 'SELECT status, paid_amount, remaining_amount FROM purchases WHERE id = ?', [pid]),
    n(db, 'SELECT COALESCE(ROUND(SUM(amount), 3), 0) FROM purchase_payments WHERE purchase_id = ? AND voided_at IS NULL', [pid]),
    all(db, 'SELECT ROUND(amount, 3), used_amount, status FROM supplier_credits')]);
  const vor = S([seiteVon(a)?.refunds.map((x) => [x.mode, x.amount, x.open]), seiteVon(b)?.refunds.length, seiteVon(b)?.open]);
  const geldVor = geld();
  neustart(db); neustart(db); nimm(db);
  const nach = S([seiteVon(a)?.refunds.map((x) => [x.mode, x.amount, x.open]), seiteVon(b)?.refunds.length, seiteVon(b)?.open]);
  ok(ret.ok && kopf(db, pid) === '-' && vor === nach && (seiteVon(a)?.refunds.length ?? 0) === 1 && (seiteVon(b)?.refunds.length ?? 0) === 0,
    `§B Rückgabe von A nach bezahltem Einkauf: Rückforderung bei A, B ohne — nach zwei Neustarts unverändert (${ret.code || 'ok'} ${vor} → ${nach})`);
  ok(geld() === geldVor && n(db, 'SELECT COALESCE(ROUND(SUM(amount), 3), 0) FROM purchase_payments WHERE purchase_id = ? AND voided_at IS NULL', [pid]) === 1200,
    `§B Auszahlung (1200 am gemeinsamen Einkauf), Einkaufsstand und Rückforderung durch die Neustarts unverändert (${geldVor})`);
}

// ── §C Einzel-Einkauf ───────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const a = await kommission(db, 'cust-1', 'Nautilus');
  const r = await verkauf('fern', db, { items: [{ consignmentId: a, salePrice: 1000, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  nimm(db);
  const pid = einkaufVon(db, a); const v0 = fassung(db, pid);
  ok(r.ok && kopf(db, pid) === a, `§C ein Einkauf einer Kommission: Kopf beim Anlegen gesetzt (${r.code || 'ok'})`);
  neustart(db); neustart(db);
  ok(kopf(db, pid) === a && fassung(db, pid) === v0, '§C nach zwei Neustarts unverändert, keine neue Fassung');
  db.run('UPDATE purchases SET source_consignment_id = NULL WHERE id = ?', [pid]);
  neustart(db);
  ok(kopf(db, pid) === a, '§C Kopf fehlt, die eine Zeile nennt ihre Kommission → nachgetragen');
}

// ── §D Altbestand (Zeilen ohne Kommission, nur der Vermerk) ───────────────────────────────────────
{
  const db = freshDb();
  const a = await kommission(db, 'cust-1', 'Alt A');
  const b = await kommission(db, 'cust-1', 'Alt B');
  const ra = await verkauf('primary', db, { items: [{ consignmentId: a, salePrice: 1000, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  const rb = await verkauf('primary', db, { items: [{ consignmentId: b, salePrice: 900, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
  nimm(db);
  const pa = einkaufVon(db, a), pb = einkaufVon(db, b);
  const nr = (cid: string): string => s(db, 'SELECT consignment_number FROM consignments WHERE id = ?', [cid]);
  // wie vor CONSIGNOR-JOINT-PURCHASE: Zeile ohne Kommission, Kopf leer
  db.run('UPDATE purchase_lines SET source_consignment_id = NULL WHERE purchase_id IN (?, ?)', [pa, pb]);
  db.run('UPDATE purchases SET source_consignment_id = NULL WHERE id IN (?, ?)', [pa, pb]);
  neustart(db);
  ok(ra.ok && rb.ok && kopf(db, pa) === a && kopf(db, pb) === b, `§D Altbestand eindeutig: aus dem Vermerk nachgetragen (${kopf(db, pa) === a} ${kopf(db, pb) === b})`);
  // mehrdeutig: ein Vermerk nennt BEIDE Nummern und beide Artikel stehen auf den Zeilen — nichts raten.
  db.run('UPDATE purchases SET source_consignment_id = NULL, notes = ? WHERE id = ?', [`Consignor payout · ${nr(a)}, ${nr(b)}`, pa]);
  db.run(`INSERT INTO purchase_lines (id, purchase_id, product_id, quantity, unit_price, line_total, position)
          SELECT 'pl-zusatz', ?, product_id, 1, 1, 1, 9 FROM consignments WHERE id = ?`, [pa, b]);
  const v0 = fassung(db, pa);
  neustart(db); neustart(db);
  ok(kopf(db, pa) === '-' && fassung(db, pa) === v0, '§D Altbestand mehrdeutig (zwei Kommissionen): Kopf bleibt leer, keine neue Fassung');
  db.run(ALT_B6);
  ok(kopf(db, pa) !== '-', '§D Gegenprobe: der alte Nachtrag hätte hier eine der beiden gesetzt');
}

// ── §E Fehler mitten im Nachtrag ────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const ids: string[] = [];
  for (const name of ['E1', 'E2', 'E3']) {
    const k = await kommission(db, 'cust-1', name);
    await verkauf('primary', db, { items: [{ consignmentId: k, salePrice: 700, acknowledgeShortfall: false }], buyerId: 'cust-2', specialMark: false });
    nimm(db); ids.push(einkaufVon(db, k));
  }
  db.run(`UPDATE purchases SET source_consignment_id = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  db.run(`CREATE TRIGGER b6_bruch BEFORE UPDATE OF source_consignment_id ON purchases WHEN NEW.id = '${ids[2]}' BEGIN SELECT RAISE(ABORT, 'b6 injected'); END`);
  let fehler = '';
  try { db.run(B6); } catch (e) { fehler = String((e as Error).message); }
  ok(/b6 injected/.test(fehler) && ids.every((pid) => kopf(db, pid) === '-'),
    `§E bricht der Nachtrag beim dritten Einkauf ab, bleibt KEINER geändert (ganz oder gar nicht) (${fehler.slice(0, 40)} ${ids.map((p) => kopf(db, p)).join(',')})`);
  db.run('DROP TRIGGER b6_bruch');
  neustart(db);
  ok(ids.every((pid, i) => kopf(db, pid) !== '-') , '§E beim nächsten Start läuft er vollständig');
}

// ── §F Quelltext ───────────────────────────────────────────────────────────────────────────────
{
  const iB6 = MIGRATIONS.indexOf(B6);
  const iZeile = MIGRATIONS.findIndex((m) => /ALTER TABLE purchase_lines ADD COLUMN source_consignment_id/.test(m));
  ok(iB6 > iZeile && iZeile >= 0, `§F der Nachtrag steht hinter der Zeilen-Spalte (${iZeile} < ${iB6})`);
  ok(MIGRATIONS.filter((m) => m.includes('SET source_consignment_id')).length === 1, '§F genau EIN Nachtrag in den Migrationen (der alte ist weg)');
  ok(/sourceConsignmentId: gruppe\.length === 1 \? gruppe\[0\]\.con\.id : undefined/.test(src('src/stores/consignmentStore.ts')),
    '§F Anlegen: der Kopf nur beim Einkauf GENAU einer Kommission (unverändert)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — hotfix B6 joint purchase: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('HOTFIX_B6_JOINT_PURCHASE_PROVED');

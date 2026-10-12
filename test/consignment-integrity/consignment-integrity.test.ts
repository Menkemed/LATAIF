// CONSIGNMENT-INTEGRITY — Verkauf und Rückgabe von Kommissionsware (F7, F6, Storno-Pfad, RTO-Snapshot, Sync).
// Gerüst (Welt, Fern-/Primary-Anschluss, Bild) wie test/r6f/consignment-parity.test.ts; die Prüfungen stehen unten.
// Run: node test/consignment-integrity/consignment-integrity.test.ts
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
await import('../../src/core/bridge/customer-commands.ts');
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
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

type SI = import('../../src/core/consignment/consignment-finance.ts').ConsignmentSaleInput;
type RI = import('../../src/core/consignment/consignment-reversal.ts').ConsignmentReturnAfterSaleInput;

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
// Die Welt einer Kommission: angelegt (Patek, vereinbart 1000, 20 % Provision), verkauft an cust-2 für
// 1200 (Auszahlung 960) — optional bezahlt, der Einlieferer bezahlt, Altweg ohne Rechnung, VAT_10.
// ════════════════════════════════════════════════════════════════════════════
const CONSIGN = { consignorId: 'cust-1', product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' }, agreedPrice: 1000,
  payout: { model: 'percent', commissionRate: 20 } };
const FIXED = { ...CONSIGN, payout: { model: 'consignor_fixed' } };
const SALE: SI = { salePrice: 1200, buyerId: 'cust-2', saleDate: '2026-09-13', acknowledgeShortfall: false, specialMark: false };
const SHORT: SI = { salePrice: 800, buyerId: 'cust-2', saleDate: '2026-09-13', acknowledgeShortfall: true, specialMark: false };

async function kommission(db: Db, body: Record<string, unknown> = CONSIGN): Promise<string> {
  const c = await fern(() => cmd.runConsignmentCreate(deps(db), identity(nx(), 'consignments.create'), body));
  if (!c.ok) throw new Error('setup consignment: ' + c.code);
  useConsignmentStore.getState().loadConsignments();
  return String(c.value.consignmentId ?? '');
}

/** Der Stand, der nach „Cancel Sale" wieder gelten muss — Kommission, Artikel, Bestand, Guthaben, Salden. */
function zustand(db: Db, cid: string) {
  const k = row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]);
  const pid = String(k.product_id ?? '');
  return {
    kommission: ohne(k, ['revision']),
    // `last_sale_price` merkt sich der Verkauf; sein Vorwert ist nirgends festgehalten (Befund im Bericht).
    produkt: ohne(row(db, 'SELECT * FROM products WHERE id = ?', [pid]), ['last_sale_price']),
    verfuegbar: n(db, "SELECT COALESCE(SUM(qty_remaining), 0) FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED'", [pid]),
    guthaben: n(db, "SELECT COALESCE(SUM(amount - used_amount), 0) FROM customer_credits WHERE status != 'CANCELLED'"),
    salden: salden(db),
  };
}
type Zustand = ReturnType<typeof zustand>;

interface Welt { db: Db; cid: string; pid: string; invId: string; vor: Zustand }
async function welt(o: { body?: Record<string, unknown>; sale?: SI | null; bezahlt?: number; einlieferer?: number; alt?: boolean; vat10?: boolean } = {}): Promise<Welt> {
  const db = freshDb();
  const cid = await kommission(db, o.body ?? CONSIGN);
  const pid = s(db, 'SELECT product_id FROM consignments WHERE id = ?', [cid]);
  if (o.vat10) { db.run("UPDATE products SET tax_scheme = 'VAT_10' WHERE id = ?", [pid]); useProductStore.getState().loadProducts(); }
  const vor = zustand(db, cid);
  if (o.alt) {
    // Der Altweg: Verkauf ohne Rechnung (markSold) und die ganze Auszahlung (M-22-Buchung).
    useConsignmentStore.getState().loadConsignments();
    useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
    useConsignmentStore.getState().loadConsignments();
    useConsignmentStore.getState().recordPartialPayout(cid, n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]), 'cash');
  } else if (o.sale !== null) {
    const r = await primary(() => conHouse.recordConsignmentSaleOnPrimary(cid, o.sale ?? SALE));
    if (!r.ok) throw new Error('setup sale: ' + r.code);
  }
  const invId = s(db, 'SELECT invoice_id FROM consignments WHERE id = ?', [cid]);
  if (o.bezahlt) {
    useInvoiceStore.getState().loadInvoices();
    imHaus(() => useInvoiceStore.getState().recordPayment(invId, o.bezahlt!, 'cash'));
  }
  if (o.einlieferer) {
    const pur = s(db, "SELECT id FROM purchases WHERE status != 'CANCELLED' ORDER BY rowid LIMIT 1");
    usePurchaseStore.getState().loadPurchases();
    usePurchaseStore.getState().addPayment(pur, o.einlieferer, 'cash');
  }
  reload();
  return { db, cid, pid, invId, vor };
}
const crev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);

/** Was eine Rücknahme im Haus hinterlässt — ohne Kennungen, Zeitpunkte und Urheber (die unterscheiden sich gewollt). */
function bild(db: Db, cid: string) {
  const k = row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]);
  const pid = String(k.product_id ?? '');
  return {
    kommission: { ...ohne(k, ['product_id', 'invoice_id', 'revision']), hatRechnung: String(k.invoice_id ?? '') !== '' },
    produkt: ohne(row(db, 'SELECT * FROM products WHERE id = ?', [pid])),
    lose: all(db, 'SELECT qty_total, qty_remaining, status, unit_cost, purchase_id IS NULL FROM stock_lots WHERE product_id = ? ORDER BY rowid', [pid]),
    rechnungen: rows(db, 'SELECT * FROM invoices ORDER BY invoice_number').map((r) => ohne(r)),
    retouren: rows(db, 'SELECT * FROM sales_returns ORDER BY return_number').map((r) => ohne(r, ['invoice_id', 'created_by'])),
    retourZeilen: rows(db, 'SELECT quantity, unit_price, vat_amount, line_total FROM sales_return_lines ORDER BY rowid'),
    gutschriften: rows(db, 'SELECT * FROM credit_notes ORDER BY credit_note_number').map((r) => ohne(r, ['invoice_id', 'sales_return_id', 'created_by', 'cancelled_by'])),
    guthaben: rows(db, 'SELECT amount, used_amount, status, source_type FROM customer_credits ORDER BY rowid'),
    einkaeufe: rows(db, 'SELECT purchase_number, status, total_amount, paid_amount, remaining_amount FROM purchases ORDER BY purchase_number'),
    ausgaben: rows(db, 'SELECT category, amount, paid_amount, status FROM expenses ORDER BY rowid'),
    buchungen: buchungen(db),
    // Der Einlieferer-Lieferant entsteht beim Verkauf mit eigener Kennung je Welt — verglichen wird sein Name.
    salden: all(db,
      `SELECT account, COALESCE((SELECT 'supplier:' || name FROM suppliers WHERE id = counterparty_id), counterparty_id, '') AS cp,
              ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
         FROM ledger_entries GROUP BY account, cp HAVING ABS(net) > 0.0005 ORDER BY account, cp`),
  };
}
const stand = (w: Welt): string => S({ bild: bild(w.db, w.cid), lc: lc(w.db), log: changelog(w.db),
  audit: n(w.db, 'SELECT COUNT(*) FROM audit_log'), rev: crev(w.db, w.cid) });

type Weg = 'primary' | 'fern';
/** Jede Welt hat ihre eigene Datenbank — der Primary-Anschluss fragt `getDatabase()`, also wird sie vorher gesetzt. */
function nimm(db: Db): void {
  setTestDatabase(db as never);
  reload();
}
function rueckgabe(weg: Weg, w: Welt, input: RI, x = nx(), over: Partial<typeof ACTOR> = {}, db: Db = w.db): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => conHouse.returnConsignmentAfterSaleOnPrimary(w.cid, input))
    : fern(() => cl.runReturnAfterSale(deps(db), identity(x, OP_R, over), rules.consignmentReturnAfterSaleBody(w.cid, crev(w.db, w.cid), input)));
}
function storno(weg: Weg, w: Welt, x = nx(), over: Partial<typeof ACTOR> = {}, db: Db = w.db): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => conHouse.cancelConsignmentSaleOnPrimary(w.cid))
    : fern(() => cl.runCancelSale(deps(db), identity(x, OP_C, over), rules.consignmentCancelSaleBody(w.cid, crev(w.db, w.cid))));
}

// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT-INTEGRITY — Verkauf und Rückgabe von Kommissionsware: EIN Vertrag.
//   A  autoritative Zuordnung Rechnungszeile → Kommission (nie product_id allein)
//   B  F7: keine Kommissionsware auf einer gewöhnlichen Rechnung (kein zweiter Verkauf)
//   C  F6: Rückgabe an den Einlieferer / Keep von der Rechnung == von der Kommission (Endzustand, Buchhaltung)
//   D  direkter Storno einer Rückgabe an den Einlieferer → abgewiesen; „Cancel Sale" ist der Rückweg
//   E  RTO-Snapshot (Kommission + Status davor), veränderte Kommission sperrt
//   F  Altbestand ohne Snapshot: nichts geraten
//   G  mehrere Kommissionen desselben Artikels: nur die zugeordnete ändert sich
//   H  Sync: der Status kommt auf einer zweiten Datenbank an
// Die Prüfungen sind so geschrieben, dass sie gegen den ALTEN Code laufen (Gegenprobe) und dort scheitern.
// ════════════════════════════════════════════════════════════════════════════
const ret = await import('../../src/core/bridge/return-commands.ts');
const rev = await import('../../src/core/bridge/sales-reversal-commands.ts');
const invCmd = await import('../../src/core/bridge/invoice-command.ts');
const returnRules = await import('../../src/core/returns/return-create.ts');
const cancelHouse = await import('../../src/core/returns/return-cancel-house.ts');
const ac = await import('../../src/core/sync/apply-change.ts');
// Nur im neuen Code vorhanden — die Gegenprobe gegen den alten Code darf daran nicht abbrechen.
const link = await import('../../src/core/consignment/consignment-sale-link.ts').catch(() => null);
type RCI = import('../../src/core/returns/return-create.ts').ReturnCreateInput;

const OWNER = { userId: 'user-test', role: 'ADMIN' };
/** Gibt es die Snapshot-Spalten (neuer Code)? Die Gegenprobe gegen den alten Code läuft dann trotzdem weiter. */
const hatRto = (db: Db): boolean => rows(db, 'PRAGMA table_info(sales_return_lines)').some((c) => c.name === 'rto_consignment_id');
const lineOf = (db: Db, invId: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid LIMIT 1', [invId]);
const kstatus = (db: Db, cid: string): string => s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]);
const rechnungsEingabe = (w: Welt, disposition: string, refundNow = true): RCI => ({
  invoiceId: w.invId, lines: [{ invoiceLineId: lineOf(w.db, w.invId), quantity: 1 }], refundMethod: 'cash',
  productDisposition: disposition as RCI['productDisposition'], reason: 'Kunde bringt es zurück', refundNow,
});
async function viaRechnung(weg: Weg, w: Welt, input: RCI, x = nx()): Promise<Ausgang> {
  nimm(w.db);
  return weg === 'primary'
    ? primary(() => returnHouse.createReturnOnPrimary(input))
    : fern(() => ret.runCreateReturn(deps(w.db), identity(x, 'returns.create'),
      returnRules.returnCreateBody(input, n(w.db, 'SELECT revision FROM invoices WHERE id = ?', [input.invoiceId]))));
}
async function retourenStorno(weg: Weg, w: Welt, rid: string, x = nx()): Promise<Ausgang> {
  nimm(w.db);
  return weg === 'primary'
    ? primary(() => imHaus(() => cancelHouse.cancelReturnInHouse(rid, 'Storno', OWNER, 'branch-main')))
    : fern(() => rev.runReturnCancel(deps(w.db), identity(x, 'returns.cancel'),
      { returnId: rid, expectedRevision: n(w.db, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]), reason: 'Storno' }));
}
const retoureVon = (w: Welt): string => s(w.db, 'SELECT id FROM sales_returns WHERE invoice_id = ? ORDER BY rowid DESC LIMIT 1', [w.invId]);
/** Alles, was eine abgewiesene Handlung NICHT verändern darf. */
const unberuehrt = (w: Welt): string => S({
  stand: stand(w), kons: all(w.db, 'SELECT id, status, invoice_id, payout_status FROM consignments ORDER BY id'),
  inv: all(w.db, 'SELECT COUNT(*), COALESCE(SUM(gross_amount), 0) FROM invoices'), lines: n(w.db, 'SELECT COUNT(*) FROM invoice_lines'),
  ret: all(w.db, 'SELECT id, status FROM sales_returns ORDER BY id'), lots: all(w.db, 'SELECT id, status, qty_remaining, unit_cost FROM stock_lots ORDER BY id'),
  pur: all(w.db, 'SELECT id, status FROM purchases ORDER BY id'),
});
const ZEILE = (pid: string, preis = 1000) => ({ productId: pid, quantity: 1, unitPrice: preis, purchasePrice: 0, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: preis });
function eigenerArtikel(db: Db, id: string): void {
  insert(db, 'products', {
    id, branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'Eigen ' + id, sku: 'SKU-' + id, quantity: 1,
    condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 100, purchase_currency: 'BHD', planned_sale_price: 300,
    stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW,
  });
  useProductStore.getState().loadProducts();
}

// ══ A — autoritative Zuordnung ═══════════════════════════════════════════════
{
  const w = await welt();
  const L = lineOf(w.db, w.invId);
  ok(n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [w.invId]) === 1,
    'A1 „Record Sale" legt eine eigene Rechnung mit genau einer Zeile an');
  const m1 = link?.saleConsignmentOfLine(L, 'branch-main');
  ok(m1?.kind === 'one' && m1.id === w.cid, `A1 Rechnungszeile → genau die Kommission dieses Verkaufs (${S(m1)})`);
  // Geschichte desselben Artikels: eine frühere, zurückgegebene Kommission und ein alter Verkauf mit anderer Rechnung.
  insert(w.db, 'consignments', { id: 'cons-hist-1', branch_id: 'branch-main', consignment_number: 'CN-H1', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'returned', agreement_date: '2026-01-01', created_at: NOW, updated_at: NOW });
  insert(w.db, 'consignments', { id: 'cons-hist-2', branch_id: 'branch-main', consignment_number: 'CN-H2', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'sold', invoice_id: null, agreement_date: '2026-02-01', created_at: NOW, updated_at: NOW });
  const m2 = link?.saleConsignmentOfLine(L, 'branch-main');
  ok(m2?.kind === 'one' && m2.id === w.cid, `A2 mehrere Kommissionen desselben Artikels → trotzdem genau die zugeordnete (${S(m2)})`);
  ok(link?.saleConsignmentOfLine(L, 'branch-other')?.kind === 'none', 'A3 fremde Filiale → keine Zuordnung');
  // Quelltext: die Verknüpfung schreibt nur „Record Sale", und nur „Cancel Sale" löscht sie.
  const files = ['src/stores/consignmentStore.ts', 'src/core/consignment/consignment-reversal-house.ts', 'src/core/consignment/consignment-finance-house.ts',
    'src/core/bridge/commercial-commands.ts', 'src/core/bridge/consignment-lifecycle-commands.ts', 'src/pages/consignments/ConsignmentDetail.tsx'];
  const setzer = files.flatMap((f) => [...codeOf(src(f)).matchAll(/invoiceId:\s*invoice\.id|invoice_id\s*=\s*NULL|invoiceId:\s*[a-z]/g)].map((m) => `${f}:${m[0]}`))
    .filter((x) => !/invoiceId:\s*(invoice\.id|invoiceId|inv)/.test(x) || /consignmentStore/.test(x));
  ok(/withConsignmentSalePermit\(con\.productId/.test(src('src/stores/consignmentStore.ts')) && (codeOf(src('src/core/consignment/consignment-reversal-house.ts')).match(/invoice_id = NULL/g) ?? []).length === 1,
    `A4 Quelltext: Verknüpfung setzt nur „Record Sale" (mit seiner Erlaubnis), löscht nur „Cancel Sale" (${setzer.length})`);
  // Mehrdeutig (künstlich): zwei Kommissionen mit DERSELBEN Rechnung → nichts darf sich ändern.
  insert(w.db, 'consignments', { id: 'cons-dup', branch_id: 'branch-main', consignment_number: 'CN-D', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'sold', invoice_id: w.invId, agreement_date: '2026-03-01', created_at: NOW, updated_at: NOW });
  const vor = unberuehrt(w);
  const r = await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER'));
  ok(!r.ok && r.code === 'CONSIGNMENT_RETURN_AMBIGUOUS' && unberuehrt(w) === vor,
    `A5 zwei Kommissionen an derselben Rechnungszeile → abgewiesen, nichts verändert (${r.code})`);
}

// ══ B — F7: kein zweiter Verkauf derselben Kommissionsware ════════════════════
{
  const w = await welt({ sale: null });   // eingeliefert, noch nicht verkauft
  const vor = unberuehrt(w);
  const direkt = wirft(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [ZEILE(w.pid)] as never, 'direkt')));
  reload();
  ok(direkt === 'CONSIGNMENT_SELL_VIA_CONSIGNMENT' && unberuehrt(w) === vor,
    `B1 gewöhnliche Rechnung mit Kommissionsware → abgewiesen, nichts geschrieben (${direkt || 'ANGELEGT'})`);
  const fernRechnung = await fern(() => invCmd.runInvoiceCreate(deps(w.db), identity(nx(), 'invoices.create'),
    { customerId: 'cust-2', lines: [{ productId: w.pid, quantity: 1, unitPrice: 1000 }], specialMark: false }));
  ok(!fernRechnung.ok && fernRechnung.code === 'CONSIGNMENT_SELL_VIA_CONSIGNMENT' && unberuehrt(w) === vor,
    `B2 PC2 invoices.create mit Kommissionsware → dasselbe fachliche Nein (${fernRechnung.code})`);
  const verkauf = await primary(() => conHouse.recordConsignmentSaleOnPrimary(w.cid, SALE));
  reload();
  ok(verkauf.ok && n(w.db, "SELECT COUNT(DISTINCT invoice_id) FROM invoice_lines WHERE product_id = ?", [w.pid]) === 1
    && kstatus(w.db, w.cid) === 'sold' && s(w.db, 'SELECT invoice_id FROM consignments WHERE id = ?', [w.cid]) !== '',
    `B3 „Record Sale" bleibt der eine Weg: genau eine Rechnung, Kommission sold und verknüpft (${verkauf.code || 'ok'})`);
  const nochmal = await primary(() => conHouse.recordConsignmentSaleOnPrimary(w.cid, SALE));
  ok(!nochmal.ok && nochmal.code === 'CONSIGNMENT_NOT_ACTIVE', `B4 zweiter „Record Sale" → abgewiesen (${nochmal.code})`);
  const danach = wirft(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [ZEILE(w.pid)] as never, 'danach')));
  reload();
  ok(danach === 'CONSIGNMENT_SELL_VIA_CONSIGNMENT' && n(w.db, 'SELECT COUNT(DISTINCT invoice_id) FROM invoice_lines WHERE product_id = ?', [w.pid]) === 1,
    `B5 auch nach dem Verkauf keine zweite Rechnung über dasselbe Stück (${danach || 'ANGELEGT'})`);
  // Ändern: Kommissionsware kommt nicht als neue Zeile auf eine andere Rechnung.
  const w2 = await welt({ sale: null });
  eigenerArtikel(w2.db, 'p-eigen');
  const eigen = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [ZEILE('p-eigen', 300)] as never, 'eigen'));
  reload();
  const eL = lineOf(w2.db, eigen.id);
  const aend = wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(eigen.id, {
    reason: 'Ergänzung', lines: [{ lineId: eL, ...ZEILE('p-eigen', 300) }, ZEILE(w2.pid)] as never })));
  reload();
  ok(aend === 'CONSIGNMENT_SELL_VIA_CONSIGNMENT' && n(w2.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [eigen.id]) === 1,
    `B6 Rechnung ändern: Kommissionsware als neue Zeile → abgewiesen (${aend || 'GEÄNDERT'})`);
  const preis = wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(eigen.id, {
    reason: 'Preis', lines: [{ lineId: eL, ...ZEILE('p-eigen', 320) }] as never })));
  reload();
  ok(preis === '', `B7 eine Rechnung ohne Kommissionsware ändert sich wie bisher (${preis || 'ok'})`);
  // Die Maske zeigt Kommissionsware gar nicht erst an.
  ok(/p\.sourceType !== 'CONSIGNMENT' && p\.stockStatus !== 'consignment'/.test(src('src/pages/invoices/InvoiceCreate.tsx')),
    'B8 Maske „New Invoice": Kommissionsware ist nicht auswählbar');
}

// ══ C — F6: von der Rechnung == von der Kommission ════════════════════════════
for (const [was, o, disp] of [
  ['unbezahlt, Return to Owner', {}, 'RETURN_TO_OWNER'],
  ['bezahlt, Return to Owner', { bezahlt: 1200 }, 'RETURN_TO_OWNER'],
  ['unbezahlt, Keep', {}, 'KEEP_AS_OWN'],
  ['bezahlt, Keep', { bezahlt: 1200 }, 'KEEP_AS_OWN'],
] as Array<[string, { bezahlt?: number }, string]>) {
  const wR = await welt(o);
  const aR = await viaRechnung('primary', wR, rechnungsEingabe(wR, disp));
  const wK = await welt(o);
  const aK = await rueckgabe('primary', wK, { disposition: disp as never, refundMethod: 'cash', reason: 'Kunde bringt es zurück' });
  const d = diffAll(bild(wR.db, wR.cid), bild(wK.db, wK.cid));
  ok(aR.ok && aK.ok && d.length === 0, `C ${was}: von der Rechnung ≡ von der Kommission (${aR.code || 'ok'}/${aK.code || 'ok'}; ${d.slice(0, 3).join(' | ') || 'gleich'})`);
  const k = konten(wR.db);
  ok(balanced(wR.db) && (disp !== 'RETURN_TO_OWNER' || Object.keys(k).length === 0),
    `C ${was}: Hauptbuch ausgeglichen${disp === 'RETURN_TO_OWNER' ? ', alle Konten 0 (Umsatz, Wareneinsatz, Lager, Verbindlichkeit, Kasse)' : ''} (${S(k)})`);
  if (disp === 'RETURN_TO_OWNER') {
    ok(s(wR.db, 'SELECT status FROM purchases ORDER BY rowid LIMIT 1') === 'CANCELLED' && kstatus(wR.db, wR.cid) === 'returned',
      `C ${was}: Einkauf beim Einlieferer storniert, Kommission returned`);
  } else {
    const kost = n(wR.db, "SELECT unit_cost FROM stock_lots WHERE product_id = ? AND purchase_id IS NULL AND status = 'ACTIVE'", [wR.pid]);
    ok(Math.abs(kost - n(wR.db, 'SELECT payout_amount FROM consignments WHERE id = ?', [wR.cid])) < 0.005,
      `C ${was}: Keep-Los zum Einstand = Auszahlung an den Einlieferer (${kost})`);
  }
  // PC2: derselbe Weg, dasselbe Ergebnis.
  const wF = await welt(o);
  const aF = await viaRechnung('fern', wF, rechnungsEingabe(wF, disp));
  const dF = diffAll(bild(wF.db, wF.cid), bild(wK.db, wK.cid));
  ok(aF.ok && dF.length === 0, `C ${was}: PC2 returns.create ≡ Primary (${aF.code || 'ok'}; ${dF.slice(0, 2).join(' | ') || 'gleich'})`);
}
{
  const w = await welt();
  const spaet = await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER', false));
  ok(!spaet.ok && spaet.code === 'CONSIGNMENT_RETURN_REFUNDS_NOW', `C „später erstatten" für Kommissionsware → abgewiesen (${spaet.code})`);
  // Beide Seiten schon bezahlt (Käufer bar, Einlieferer bar): der bestehende Vertrag des Kommissionswegs gilt
  // unverändert auch von der Rechnung aus (PC2) — derselbe Endzustand.
  const w2 = await welt({ bezahlt: 1200, einlieferer: 960 });
  const a2 = await viaRechnung('fern', w2, rechnungsEingabe(w2, 'RETURN_TO_OWNER'));
  const w3 = await welt({ bezahlt: 1200, einlieferer: 960 });
  const a3 = await rueckgabe('fern', w3, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', reason: 'Kunde bringt es zurück' });
  const d2 = diffAll(bild(w2.db, w2.cid), bild(w3.db, w3.cid));
  ok(a2.ok && a3.ok && d2.length === 0 && balanced(w2.db),
    `C beide Seiten bezahlt: von der Rechnung ≡ von der Kommission (PC2) (${a2.code || 'ok'}/${a3.code || 'ok'}; ${d2.slice(0, 2).join(' | ') || 'gleich'})`);
}

// ══ D — direkter Storno einer Rückgabe an den Einlieferer ═════════════════════
for (const [weg, von] of [['primary', 'kommission'], ['fern', 'kommission'], ['primary', 'rechnung'], ['fern', 'rechnung']] as Array<[Weg, string]>) {
  const w = await welt();   // unbezahlt: die Erstattung storniert nur die Forderung — der Storno wäre sonst schon gesperrt
  if (von === 'rechnung') await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER'));
  else await rueckgabe('primary', w, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash', reason: 'Kunde bringt es zurück' });
  const rid = retoureVon(w);
  const vor = unberuehrt(w);
  const st = await retourenStorno(weg, w, rid);
  ok(!st.ok && st.code === 'RETURN_VIA_CANCEL_SALE' && unberuehrt(w) === vor && konten(w.db)['INVENTORY'] === undefined,
    `D ${weg}/${von}: „Cancel Return" auf der Rückgabe an den Einlieferer → abgewiesen, kein halber Stand (${st.code || 'STORNIERT'}; INVENTORY ${konten(w.db)['INVENTORY'] ?? 0})`);
  const cs = await storno(weg, w);
  const z = zustand(w.db, w.cid);
  ok(cs.ok && kstatus(w.db, w.cid) === 'active' && s(w.db, 'SELECT status FROM sales_returns WHERE id = ?', [rid]) === 'REJECTED'
    && Object.keys(konten(w.db)).length === 0 && diffAll(z, w.vor).length === 0,
    `D ${weg}/${von}: „Cancel Sale" bleibt der Rückweg — Stand wie vor dem Verkauf (${cs.code || 'ok'}; ${diffAll(z, w.vor).slice(0, 2).join(' | ') || 'gleich'})`);
}
{
  // Gegenprobe-Szenario „RTO-Storno lässt den Status hängen": nach einem Storno darf keine Kommission auf
  // RETURNED_TO_OWNER stehen, während ihr Verkauf wieder gilt.
  const w = await welt();
  await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER'));
  await retourenStorno('primary', w, retoureVon(w));
  const haengt = kstatus(w.db, w.cid) === 'RETURNED_TO_OWNER' && s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId]) !== 'CANCELLED';
  ok(!haengt, `D kein hängender Status: Kommission ${kstatus(w.db, w.cid)} bei Rechnung ${s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId])}`);
}

// ══ E — Snapshot der Rückgabe an den Einlieferer ═════════════════════════════
{
  const w = await welt();
  const vorStatus = kstatus(w.db, w.cid);
  await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER'));
  const rid = retoureVon(w);
  const snap = row(w.db, "SELECT * FROM sales_return_lines WHERE return_id = ?", [rid]);
  ok(snap.rto_consignment_id === w.cid && snap.rto_prev_status === vorStatus && !!snap.rto_snapshot_at,
    `E1 Snapshot: genau diese Kommission und ihr Status davor (${S([snap.rto_consignment_id, snap.rto_prev_status, !!snap.rto_snapshot_at])})`);
  const srl = s(w.db, "SELECT data FROM sync_changelog WHERE table_name = 'sales_return_lines' ORDER BY id DESC LIMIT 1");
  ok(/rto_consignment_id/.test(srl) && ac.changeContractViolation('sales_return_lines', 'insert', srl) === null,
    'E2 Sync-Feldvertrag: die Retourenzeile reist mit Snapshot und wird angenommen');
  // Kommission seither verändert → „Cancel Sale" scheitert an der Retoure, nichts verändert.
  w.db.run("UPDATE consignments SET status = 'paid_out' WHERE id = ?", [w.cid]);
  reload();
  const vor = unberuehrt(w);
  const cs = await storno('primary', w);
  ok(!cs.ok && cs.code === 'RETURN_RTO_CONSIGNMENT_CHANGED' && unberuehrt(w) === vor,
    `E3 Kommission seither verändert → abgewiesen, nichts überschrieben (${cs.code || 'DURCH'})`);
  // Snapshot zeigt auf eine andere Kommission → ebenso.
  w.db.run("UPDATE consignments SET status = 'returned' WHERE id = ?", [w.cid]);
  if (hatRto(w.db)) w.db.run("UPDATE sales_return_lines SET rto_consignment_id = 'cons-fremd' WHERE return_id = ?", [rid]);
  reload();
  const cs2 = await storno('fern', w);
  ok(!cs2.ok && cs2.code === 'RETURN_RTO_CONSIGNMENT_CHANGED', `E4 Snapshot einer anderen Kommission → abgewiesen (PC2: ${cs2.code || 'DURCH'})`);
}

// ══ F — Altbestand ohne Snapshot ═════════════════════════════════════════════
{
  const w = await welt();
  await viaRechnung('primary', w, rechnungsEingabe(w, 'RETURN_TO_OWNER'));
  const rid = retoureVon(w);
  if (hatRto(w.db)) w.db.run('UPDATE sales_return_lines SET rto_snapshot_at = NULL, rto_consignment_id = NULL, rto_prev_status = NULL WHERE return_id = ?', [rid]);
  reload();
  const vor = unberuehrt(w);
  const st = await retourenStorno('primary', w, rid);
  ok(!st.ok && st.code === 'RETURN_RTO_NOT_RESTORABLE' && unberuehrt(w) === vor, `F1 Altbestand ohne Snapshot → nicht stornierbar, nichts geraten (${st.code || 'STORNIERT'})`);
  const cs = await storno('primary', w);
  ok(cs.ok && kstatus(w.db, w.cid) === 'active' && Object.keys(konten(w.db)).length === 0,
    `F2 „Cancel Sale" räumt den Altbestand weiter auf (setzt alles selbst neu) (${cs.code || 'ok'})`);
  const view = cancelHouse.returnCancelability({ id: rid, status: 'REFUNDED', refundPaidAmount: 0, productDisposition: 'RETURN_TO_OWNER' });
  ok(view.canCancel === false && /cannot be undone/.test(String(view.blockReason)), `F3 die Maske bietet „Cancel Return" nicht an (${view.blockReason})`);
}

// ══ G — mehrere Kommissionen desselben Artikels ══════════════════════════════
for (const disp of ['RETURN_TO_OWNER', 'KEEP_AS_OWN']) {
  const w = await welt();
  insert(w.db, 'consignments', { id: 'cons-alt-sold', branch_id: 'branch-main', consignment_number: 'CN-AS', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'sold', invoice_id: 'inv-alt', agreement_date: '2026-01-01', created_at: NOW, updated_at: NOW });
  insert(w.db, 'consignments', { id: 'cons-alt-paid', branch_id: 'branch-main', consignment_number: 'CN-AP', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'paid_out', agreement_date: '2026-01-02', created_at: NOW, updated_at: NOW });
  reload();
  const a = await viaRechnung('primary', w, rechnungsEingabe(w, disp));
  ok(a.ok && kstatus(w.db, 'cons-alt-sold') === 'sold' && kstatus(w.db, 'cons-alt-paid') === 'paid_out' && ['returned'].includes(kstatus(w.db, w.cid)),
    `G ${disp}: nur die zugeordnete Kommission ändert sich (${kstatus(w.db, w.cid)}), die anderen bleiben (${kstatus(w.db, 'cons-alt-sold')}/${kstatus(w.db, 'cons-alt-paid')})`);
}

// ══ H — Sync: der Kommissionsstatus kommt auf einer zweiten Datenbank an ══════
for (const disp of ['RETURN_TO_OWNER', 'KEEP_AS_OWN']) {
  const w = await welt();
  const peer = new SQL.Database((w.db as unknown as { export(): Uint8Array }).export()) as unknown as Db;
  const bis = n(w.db, 'SELECT COALESCE(MAX(id), 0) FROM sync_changelog');
  await viaRechnung('primary', w, rechnungsEingabe(w, disp));
  const neu = rows(w.db, 'SELECT table_name, record_id, action, data FROM sync_changelog WHERE id > ? ORDER BY id', [bis]);
  const gift: string[] = [];
  for (const c of neu) {
    try { ac.applySyncChange(peer as never, { table_name: String(c.table_name), record_id: String(c.record_id), action: String(c.action), data: String(c.data) }); }
    catch (e) { gift.push(`${c.table_name}:${(e as { code?: string }).code ?? e}`); }
  }
  const hier = kstatus(w.db, w.cid); const dort = kstatus(peer, w.cid);
  ok(hier === dort && neu.some((c) => c.table_name === 'consignments' && c.record_id === w.cid) && !gift.some((g) => /^(consignments|sales_return_lines):/.test(g)),
    `H ${disp}: zweite Datenbank hat denselben Kommissionsstatus (${hier} / ${dort}; Quarantäne: ${gift.join(', ') || 'keine'})`);
}

// ══ I — die Verkaufsrechnung einer Kommission (Lebenslauf) ═════════════════════
{
  const lc2 = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  const ic = await import('../../src/core/bridge/invoice-cancel-command.ts');
  const icRules = await import('../../src/core/invoices/invoice-cancel.ts');
  const icHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
  const basis = (w: Welt) => row(w.db, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [w.invId]);
  /** Die Zeile, wie die Maske sie beim Ändern schickt — mit den gespeicherten Werten, optional verändert. */
  const zeile = (w: Welt, over: Record<string, unknown> = {}) => {
    const b = basis(w);
    return { lineId: String(b.id), productId: String(b.product_id), lotId: (b.lot_id as string | null) ?? undefined, quantity: Number(b.quantity),
      unitPrice: Number(b.unit_price), purchasePrice: Number(b.purchase_price_snapshot), taxScheme: String(b.tax_scheme),
      vatRate: Number(b.vat_rate), vatAmount: Number(b.vat_amount), lineTotal: Number(b.line_total), ...over };
  };
  const aendern = (w: Welt, lines: unknown[], extra: Record<string, unknown> = {}): string => {
    nimm(w.db);
    const m = wirft(() => imHaus(() => useInvoiceStore.getState().editInvoice(w.invId, { reason: 'Korrektur', lines: lines as never, ...extra })));
    reload();
    return m;
  };
  /** Zwei Wahrheiten? Rechnungssumme gegen Verkaufspreis der Kommission (beide brutto). */
  const zweiWahrheiten = (w: Welt): string => {
    const g = n(w.db, 'SELECT gross_amount FROM invoices WHERE id = ?', [w.invId]);
    const k = n(w.db, 'SELECT sale_price FROM consignments WHERE id = ?', [w.cid]);
    return Math.abs(g - k) > 0.005 ? `Rechnung ${g} ≠ Kommission ${k}` : '';
  };

  { // I1–I5 am Primary
    const w = await welt();
    let vor = unberuehrt(w);
    const p = aendern(w, [zeile(w, { unitPrice: 1500, lineTotal: 1500 })]);
    ok(p === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor && zweiWahrheiten(w) === '',
      `I1 Preis der Kommissionszeile ändern → abgewiesen, nichts verändert (${p || 'GEÄNDERT'}; ${zweiWahrheiten(w) || 'eine Wahrheit'})`);
    const q = aendern(w, [zeile(w, { quantity: 2, lineTotal: Number(basis(w).line_total) * 2 })]);
    ok(q === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I2 Menge ändern → abgewiesen (${q || 'GEÄNDERT'})`);
    eigenerArtikel(w.db, 'p-eigen-i');
    vor = unberuehrt(w);
    const ersetzt = aendern(w, [ZEILE('p-eigen-i', 1200)]);
    ok(ersetzt === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I3 Zeile ersetzen/entfernen → abgewiesen (${ersetzt || 'GEÄNDERT'})`);
    const dazu = aendern(w, [zeile(w), ZEILE('p-eigen-i', 300)]);
    ok(dazu === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I3 Zeile hinzufügen → abgewiesen (${dazu || 'GEÄNDERT'})`);
    insert(w.db, 'customers', { id: 'cust-3', branch_id: 'branch-main', first_name: 'Dritte', last_name: 'K', country: 'BH', language: 'en',
      vip_level: 0, preferences: '[]', customer_type: 'collector', sales_stage: 'active', created_at: NOW, updated_at: NOW });
    reload();
    vor = unberuehrt(w);
    const kunde = aendern(w, [zeile(w)], { customerId: 'cust-3', confirmCustomerChange: true });
    ok(kunde === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I4 Käufer wechseln → abgewiesen (Käufer gehört zur Kommission) (${kunde || 'GEÄNDERT'})`);
    const notiz = aendern(w, [zeile(w)], { notes: 'Lieferung abgeholt' });
    ok(notiz === '' && s(w.db, 'SELECT notes FROM invoices WHERE id = ?', [w.invId]) === 'Lieferung abgeholt' && zweiWahrheiten(w) === ''
      && kstatus(w.db, w.cid) === 'sold', `I5 Notiz ändern (Zeile unverändert) → erlaubt, Kommission unberührt (${notiz || 'ok'})`);
  }

  { // I6 PC2 invoices.update — dasselbe Nein
    const w = await welt();
    const vor = unberuehrt(w);
    const b = basis(w);
    const r = await fern(() => lc2.runInvoiceUpdate(deps(w.db), identity(nx(), 'invoices.update'), {
      id: w.invId, expectedRevision: n(w.db, 'SELECT revision FROM invoices WHERE id = ?', [w.invId]), reason: 'Korrektur',
      customerId: 'cust-2', specialMark: false,
      lines: [{ lineId: String(b.id), productId: String(b.product_id), quantity: 1, unitPrice: 1500 }],
    }));
    ok(!r.ok && r.code === 'CONSIGNMENT_INVOICE_LOCKED' && !r.thrown && unberuehrt(w) === vor,
      `I6 PC2 invoices.update Preis → dasselbe fachliche Nein, nichts verändert (${r.code})`);
  }

  { // I7 Löschen, I8 Stornieren (Primary + PC2)
    const w = await welt();
    const vor = unberuehrt(w);
    nimm(w.db);
    const del = wirft(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(w.invId)));
    reload();
    ok(del === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor && n(w.db, 'SELECT COUNT(*) FROM invoices WHERE id = ?', [w.invId]) === 1,
      `I7 Rechnung löschen → abgewiesen (${del || 'GELÖSCHT'})`);
  }
  {
    const w = await welt();   // eigene Welt — unabhängig vom Löschversuch oben
    const vor = unberuehrt(w);
    nimm(w.db);
    const can = wirft(() => imHaus(() => icHouse.cancelInvoiceInHouse({ invoiceId: w.invId, refundMethod: 'cash' }, 'branch-main')));
    reload();
    ok(can === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I8 Rechnung stornieren (Primary) → abgewiesen, „Cancel Sale" ist der Weg (${can || 'STORNIERT'})`);
    const canF = await fern(() => ic.runCancelInvoice(deps(w.db), identity(nx(), 'invoices.cancel'),
      icRules.invoiceCancelBody({ invoiceId: w.invId, refundMethod: 'cash' }, n(w.db, 'SELECT revision FROM invoices WHERE id = ?', [w.invId]))));
    ok(!canF.ok && canF.code === 'CONSIGNMENT_INVOICE_LOCKED' && unberuehrt(w) === vor, `I8 PC2 invoices.cancel → dasselbe Nein (${canF.code})`);
  }

  { // I9 Retoure ohne Kommissionsweg („Back to Stock", „Write Off")
    for (const [weg, disp] of [['primary', 'IN_STOCK'], ['fern', 'WRITE_OFF'], ['primary', 'UNDER_REPAIR']] as Array<[Weg, string]>) {
      const w = await welt({ bezahlt: 1200 });
      const vor = unberuehrt(w);
      const r = await viaRechnung(weg, w, rechnungsEingabe(w, disp));
      ok(!r.ok && r.code === 'CONSIGNMENT_RETURN_VIA_CONSIGNMENT' && unberuehrt(w) === vor,
        `I9 ${weg} Retoure „${disp}" auf der Kommissions-Verkaufsrechnung → abgewiesen, nichts verändert (${r.code || 'ANGELEGT'})`);
    }
  }

  { // I10 erlaubt bleibt: der Käufer zahlt; „Cancel Sale" danach wie bisher
    const w = await welt();
    nimm(w.db);
    const pay = wirft(() => imHaus(() => useInvoiceStore.getState().recordPayment(w.invId, 500, 'cash')));
    reload();
    ok(pay === '' && n(w.db, 'SELECT paid_amount FROM invoices WHERE id = ?', [w.invId]) === 500 && kstatus(w.db, w.cid) === 'sold',
      `I10 Zahlung des Käufers auf die Kommissions-Verkaufsrechnung → wie bisher (${pay || 'ok'})`);
  }
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — consignment sale/return integrity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

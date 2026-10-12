// CONSIGNMENT-AGENT — Kommissionsware und der Agentenweg (Übergabe, Verkauf, Abrechnung, Rückgabe, Löschen).
// Gerüst (Welt, Fern-/Primary-Anschluss) wie test/r6f/consignment-parity.test.ts; die Prüfungen stehen unten.
// Run: node test/consignment-integrity/agent-handoff.test.ts
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
const invRev = await import('../../src/core/invoices/invoice-reversal.ts');
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
/** CONSIGNMENT-INTEGRITY — Altbestand: eine gewöhnliche Retoure auf der Kommissions-Verkaufsrechnung, wie es sie VOR der
 *  Sperre geben konnte (heute weist das Retourenhaus sie ab). Über den Store, so wie das Haus damals schrieb. */
function altRetoure(w: Welt): void {
  nimm(w.db);
  const l = row(w.db, 'SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE invoice_id = ?', [w.invId]);
  imHaus(() => { useSalesReturnStore.getState().loadReturns(); useSalesReturnStore.getState().createReturn({ invoiceId: w.invId, refundMethod: 'cash', productDisposition: 'IN_STOCK',
    lines: [{ invoiceLineId: String(l.id), productId: String(l.product_id), quantity: 1, unitPrice: Number(l.line_total) / (Number(l.quantity) || 1), vatAmount: Number(l.vat_amount) }] } as never); });
  reload();
}

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
// CONSIGNMENT-AGENT — Kommissionsware und der Agentenweg.
//   N  neue Übergabe von Kommissionsware → abgewiesen (auch nach Status „in stock" von Hand), Primary == PC2
//   L  Altbestand: Kommissionsware schon beim Agenten → Verkauf/Abrechnung abgewiesen, Rückgabe/Löschen → CONSIGNMENT
//   O  eigene Ware: Übergabe → Rückgabe/Löschen/Verkauf wie bisher (Löschen lässt kein AGENT mehr stehen)
//   U  unklare Relation → Rückgabe abgewiesen, nichts geschrieben
// Die Prüfungen laufen auch gegen den ALTEN Code (Gegenprobe) und scheitern dort.
// ════════════════════════════════════════════════════════════════════════════
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const th = await import('../../src/core/agents/transfer-house.ts');
const svc = await import('../../src/core/bridge/service-commands.ts');
const finc = await import('../../src/core/bridge/financial-commands.ts');

const prodS = (db: Db, pid: string): string => S(db.exec('SELECT source_type, stock_status, quantity FROM products WHERE id = ?', [pid])[0]?.values?.[0] ?? []);
const kst = (db: Db, cid: string): string => s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]);
const tidOf = (db: Db, pid: string): string => s(db, 'SELECT id FROM agent_transfers WHERE product_id = ? ORDER BY rowid DESC LIMIT 1', [pid]);
const trev = (db: Db, id: string): number => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);
/** Alles, was eine abgewiesene Handlung nicht verändern darf. */
const ruhe = (db: Db, pid: string): string => S({
  p: all(db, 'SELECT source_type, stock_status, quantity, last_sale_price FROM products WHERE id = ?', [pid]),
  t: all(db, 'SELECT id, status, stock_taken, settlement_paid_amount, invoice_id FROM agent_transfers ORDER BY id'),
  k: all(db, 'SELECT id, status, invoice_id FROM consignments ORDER BY id'),
  inv: n(db, 'SELECT COUNT(*) FROM invoices'), lots: all(db, 'SELECT id, status, qty_remaining FROM stock_lots ORDER BY id'),
  led: lc(db), log: changelog(db), audit: n(db, 'SELECT COUNT(*) FROM audit_log'),
  pay: n(db, 'SELECT COUNT(*) FROM agent_settlement_payments'),
});
function agentKunde(db: Db): void {
  db.run(`INSERT OR IGNORE INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-agent','branch-main','Agent','Ali','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  reload(); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
}
async function uebergabe(weg: Weg, db: Db, pid: string): Promise<Ausgang> {
  nimm(db);
  return weg === 'primary'
    ? primary(() => imHaus(() => th.createTransferInHouse({ customerId: 'cust-agent', productId: pid, ourPrice: 1100, settlementModel: 'full' }, 'branch-main')))
    : fern(() => svc.runTransferCreate(deps(db), identity(nx(), 'transfers.create'), { customerId: 'cust-agent', productId: pid, agentPrice: 1100 }));
}
async function agentVerkauf(weg: Weg, db: Db, t: string): Promise<Ausgang> {
  nimm(db); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
  return weg === 'primary'
    ? primary(() => imHaus(() => useAgentStore.getState().markTransferSold(t, 1300, 'Käufer X')))
    : fern(() => finc.runMarkSold(deps(db), identity(nx(), 'transfers.mark_sold'), { transferId: t, salePrice: 1300, expectedRevision: trev(db, t) }));
}
async function abrechnung(weg: Weg, db: Db, t: string): Promise<Ausgang> {
  nimm(db); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
  return weg === 'primary'
    ? primary(() => imHaus(() => useAgentStore.getState().markTransferSettled(t, 1300, 'cash')))
    : fern(() => finc.runMarkSettled(deps(db), identity(nx(), 'transfers.mark_settled'), { transferId: t, amount: 1300, method: 'cash', expectedRevision: trev(db, t) }));
}
async function rueckgabeVomAgenten(weg: Weg, db: Db, t: string): Promise<Ausgang> {
  nimm(db); useAgentStore.getState().loadTransfers();
  return weg === 'primary'
    ? primary(() => imHaus(() => useAgentStore.getState().markTransferReturned(t)))
    : fern(() => svc.runTransferReturn(deps(db), identity(nx(), 'transfers.mark_returned'), { id: t, expectedRevision: trev(db, t) }));
}
function loeschen(db: Db, t: string): string {
  nimm(db); useAgentStore.getState().loadTransfers();
  const m = wirft(() => imHaus(() => useAgentStore.getState().deleteTransfer(t)));
  reload();
  return m;
}
/** Kommissionsware von Hand auf „in stock" (die Status-Knöpfe der Artikelmaske). */
const vonHand = (db: Db, pid: string): void => { nimm(db); useProductStore.getState().updateProduct(pid, { stockStatus: 'in_stock' } as never); reload(); };
/** Altbestand: Kommissionsware ist schon beim Agenten (vor dieser Sperre entstanden) — so, wie `createTransfer` schrieb. */
function altUebergabe(db: Db, pid: string): string {
  nimm(db); useAgentStore.getState().loadAgents();
  const agent = useAgentStore.getState().findOrCreateAgentForCustomer('cust-agent');
  const t = imHaus(() => useAgentStore.getState().createTransfer({ agentId: agent.id, productId: pid, agentPrice: 1100, settlementModel: 'full' } as never));
  reload(); useAgentStore.getState().loadTransfers();
  return t.id;
}

// ══ N — neue Übergabe von Kommissionsware ═════════════════════════════════════
for (const weg of ['primary', 'fern'] as Weg[]) {
  const w = await welt({ sale: null });
  agentKunde(w.db);
  vonHand(w.db, w.pid);   // die Umgehung von heute
  const vor = ruhe(w.db, w.pid);
  const u = await uebergabe(weg, w.db, w.pid);
  ok(!u.ok && u.code === 'CONSIGNMENT_NOT_TRANSFERABLE' && ruhe(w.db, w.pid) === vor,
    `N ${weg}: Kommissionsware (Status von Hand „in stock") an einen Agenten → abgewiesen, nichts geschrieben (${u.code || 'ÜBERGEBEN'}; ${prodS(w.db, w.pid)})`);
}
{
  const w = await welt({ sale: null });
  agentKunde(w.db);
  const u = await uebergabe('primary', w.db, w.pid);
  ok(!u.ok && u.code === 'CONSIGNMENT_NOT_TRANSFERABLE', `N auch ohne Statusänderung: dieselbe Regel zuerst (${u.code})`);
  // Nach „Record Sale" (verkauft) und Status von Hand → ebenso abgewiesen.
  const w2 = await welt();
  agentKunde(w2.db); vonHand(w2.db, w2.pid);
  const u2 = await uebergabe('fern', w2.db, w2.pid);
  ok(!u2.ok && u2.code === 'CONSIGNMENT_NOT_TRANSFERABLE', `N verkaufte Kommissionsware (Status von Hand) → abgewiesen (${u2.code || 'ÜBERGEBEN'})`);
}

// ══ L — Altbestand: Kommissionsware schon beim Agenten ════════════════════════
for (const weg of ['primary', 'fern'] as Weg[]) {
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  ok(JSON.parse(prodS(w.db, w.pid))[0] === 'AGENT' && kst(w.db, w.cid) === 'active', `L ${weg} Ausgangslage: AGENT/with_agent, Kommission active (${prodS(w.db, w.pid)})`);
  let vor = ruhe(w.db, w.pid);
  const v = await agentVerkauf(weg, w.db, t);
  ok(!v.ok && v.code === 'CONSIGNMENT_NOT_TRANSFERABLE' && ruhe(w.db, w.pid) === vor,
    `L ${weg}: Agentenverkauf der Kommissionsware → abgewiesen, keine Forderung/Buchung/Bestandsänderung (${v.code || 'VERKAUFT'}; Konten ${S(konten(w.db))})`);
  const r = await rueckgabeVomAgenten(weg, w.db, t);
  reload();
  ok(r.ok && JSON.parse(prodS(w.db, w.pid))[0] === 'CONSIGNMENT' && JSON.parse(prodS(w.db, w.pid))[1] === 'consignment' && kst(w.db, w.cid) === 'active',
    `L ${weg}: Rückgabe vom Agenten → wieder CONSIGNMENT/consignment, nicht OWN (${r.code || 'ok'}; ${prodS(w.db, w.pid)})`);
  // Danach ist „Record Sale" wieder der eine Weg — genau ein Verkauf.
  vor = ruhe(w.db, w.pid);
  const rs = await primary(() => conHouse.recordConsignmentSaleOnPrimary(w.cid, SALE));
  ok(rs.ok && n(w.db, "SELECT COUNT(*) FROM agent_transfers WHERE product_id = ? AND status IN ('sold','settled')", [w.pid]) === 0
    && n(w.db, 'SELECT COUNT(DISTINCT invoice_id) FROM invoice_lines WHERE product_id = ?', [w.pid]) === 1,
    `L ${weg}: danach genau EIN Verkauf über „Record Sale" (${rs.code || 'ok'})`);
}
{ // Altbestand schon verkauft (vor der Sperre): Abrechnung abgewiesen; Löschen stellt CONSIGNMENT her
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  // So verkaufte der alte Weg: Status sold + Nachweis — hier direkt gesetzt (der Verkauf selbst ist jetzt gesperrt).
  w.db.run("UPDATE agent_transfers SET status = 'sold', actual_sale_price = 1300, settlement_amount = 1300, stock_taken = 1 WHERE id = ?", [t]);
  w.db.run("UPDATE products SET stock_status = 'sold', quantity = 0 WHERE id = ?", [w.pid]);
  reload(); useAgentStore.getState().loadTransfers();
  for (const weg of ['primary', 'fern'] as Weg[]) {
    const vor = ruhe(w.db, w.pid);
    const a = await abrechnung(weg, w.db, t);
    ok(!a.ok && a.code === 'CONSIGNMENT_NOT_TRANSFERABLE' && ruhe(w.db, w.pid) === vor,
      `L ${weg}: Abrechnung eines (Alt-)Agentenverkaufs von Kommissionsware → abgewiesen, kein Geld, keine Buchung (${a.code || 'ABGERECHNET'})`);
  }
  const d = loeschen(w.db, t);
  ok(d === '' && JSON.parse(prodS(w.db, w.pid))[0] === 'CONSIGNMENT' && JSON.parse(prodS(w.db, w.pid))[1] === 'consignment' && JSON.parse(prodS(w.db, w.pid))[2] === 1,
    `L Löschen des (verkauften) Alt-Vorgangs → Stück zurück, CONSIGNMENT/consignment (${d || 'ok'}; ${prodS(w.db, w.pid)})`);
}
{ // Altbestand noch draußen → Löschen stellt CONSIGNMENT her (vorher blieb AGENT stehen)
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  const d = loeschen(w.db, t);
  ok(d === '' && JSON.parse(prodS(w.db, w.pid))[0] === 'CONSIGNMENT' && JSON.parse(prodS(w.db, w.pid))[1] === 'consignment',
    `L Löschen des Alt-Vorgangs (draußen) → CONSIGNMENT/consignment, kein AGENT mehr (${d || 'ok'}; ${prodS(w.db, w.pid)})`);
}

// ══ O — eigene Ware: wie bisher (und Löschen lässt kein AGENT stehen) ══════════
for (const weg of ['primary', 'fern'] as Weg[]) {
  const db = freshDb();
  agentKunde(db);
  insert(db, 'products', { id: 'p-own', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'Eigen', sku: 'SKU-OWN', quantity: 1,
    condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 300, purchase_currency: 'BHD', planned_sale_price: 500,
    stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW });
  reload();
  const u = await uebergabe(weg, db, 'p-own');
  ok(u.ok && JSON.parse(prodS(db, 'p-own'))[0] === 'AGENT', `O ${weg}: eigene Ware geht wie bisher an den Agenten (${u.code || 'ok'}; ${prodS(db, 'p-own')})`);
  const t = tidOf(db, 'p-own');
  const r = await rueckgabeVomAgenten(weg, db, t);
  reload();
  ok(r.ok && prodS(db, 'p-own') === S(['OWN', 'in_stock', 1]), `O ${weg}: Rückgabe → OWN/in_stock wie bisher (${prodS(db, 'p-own')})`);
  const u2 = await uebergabe(weg, db, 'p-own');
  const t2 = tidOf(db, 'p-own');
  const d = loeschen(db, t2);
  ok(u2.ok && d === '' && prodS(db, 'p-own') === S(['OWN', 'in_stock', 1]), `O ${weg}: Übergabe löschen → OWN/in_stock (vorher blieb AGENT) (${d || 'ok'}; ${prodS(db, 'p-own')})`);
  const u3 = await uebergabe(weg, db, 'p-own');
  const t3 = tidOf(db, 'p-own');
  const v = await agentVerkauf(weg, db, t3);
  const a = await abrechnung(weg, db, t3);
  ok(u3.ok && v.ok && a.ok && s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [t3]) === 'settled' && balanced(db),
    `O ${weg}: eigene Ware — Agentenverkauf und Abrechnung wie bisher (${v.code || 'ok'}/${a.code || 'ok'})`);
}

// ══ U — unklare Relation: nichts raten ═══════════════════════════════════════
{
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  insert(w.db, 'consignments', { id: 'cons-zweite', branch_id: 'branch-main', consignment_number: 'CN-Z', consignor_id: 'cust-1',
    product_id: w.pid, agreed_price: 500, commission_rate: 10, status: 'active', agreement_date: '2026-01-01', created_at: NOW, updated_at: NOW });
  reload();
  const vor = ruhe(w.db, w.pid);
  const r = await rueckgabeVomAgenten('fern', w.db, t);
  ok(!r.ok && r.code === 'AGENT_RETURN_OWNERSHIP_UNCLEAR' && ruhe(w.db, w.pid) === vor,
    `U zwei offene Kommissionen zum Stück → Rückgabe abgewiesen, nichts geschrieben (${r.code || 'ZURÜCK'})`);
  const d = loeschen(w.db, t);
  ok(d === 'AGENT_RETURN_OWNERSHIP_UNCLEAR' && ruhe(w.db, w.pid) === vor, `U …Löschen ebenso (${d || 'GELÖSCHT'})`);
}

// ══ V — verkaufter Altbestand MIT seinen echten Folgen (Forderung, Wareneinsatz, Zahlung, Rechnung) ══════════
//   Rückgabe: nur ein Vorgang, der noch draußen ist (Primary wie PC2) — sonst bliebe Zahlung/Rechnung stehen,
//   während das Stück wieder verkaufbar wäre. Löschen: der ganze Verkauf geht zurück, oder (Rechnung) gar nichts.
/** So verkaufte, rechnete ab und wandelte der ALTE Weg Kommissionsware über den Agenten — mit genau seinen
 *  Buchungen. Die neue Sperre wird dafür kurz umgangen: die Kommission ist währenddessen „unsichtbar". */
async function altVerkauf(w: Welt, t: string, o: { abrechnen?: boolean; umwandeln?: boolean } = {}): Promise<boolean> {
  w.db.run("UPDATE consignments SET status = 'legacy' WHERE id = ?", [w.cid]);
  const v = await agentVerkauf('primary', w.db, t);
  const a = o.abrechnen ? await abrechnung('primary', w.db, t) : v;
  let c = '';
  if (o.umwandeln) { nimm(w.db); useAgentStore.getState().loadTransfers(); c = wirft(() => imHaus(() => useAgentStore.getState().convertTransferToInvoice(t, 'cust-agent'))); }
  w.db.run("UPDATE consignments SET status = 'active' WHERE id = ?", [w.cid]);
  nimm(w.db); useAgentStore.getState().loadTransfers();
  return v.ok && a.ok && c === '';
}
/** Die Maske zeigt den Vorgang noch als „draußen" (veraltet) — so ruft der Primary die Rückgabe trotzdem. */
async function rueckgabeVeraltet(db: Db, t: string): Promise<Ausgang> {
  nimm(db); useAgentStore.getState().loadTransfers();
  useAgentStore.setState({ transfers: useAgentStore.getState().transfers.map((x) => (x.id === t ? { ...x, status: 'transferred' } : x)) });
  return primary(() => imHaus(() => useAgentStore.getState().markTransferReturned(t)));
}
for (const fall of [{ name: 'verkauft', abrechnen: false }, { name: 'abgerechnet', abrechnen: true }]) {
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  const kontenVorher = S(konten(w.db));
  const ok0 = await altVerkauf(w, t, { abrechnen: fall.abrechnen });
  const zahl = n(w.db, 'SELECT COUNT(*) FROM agent_settlement_payments WHERE transfer_id = ?', [t]);
  ok(ok0 && n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND account = 'COGS'") > 0
    && (fall.abrechnen ? zahl === 1 && (konten(w.db).CASH ?? 0) > 0 : zahl === 0) && prodS(w.db, w.pid) === S(['AGENT', 'sold', 0]),
    `V ${fall.name} Ausgangslage: Alt-Agentenverkauf mit Forderung + Wareneinsatz${fall.abrechnen ? ' + Zahlung' : ''}, Stück weg (${prodS(w.db, w.pid)}; ${S(konten(w.db))})`);
  // Rückgabe: Primary (auch mit veralteter Maske) und PC2 → abgewiesen, nichts geschrieben.
  for (const weg of ['primary', 'fern'] as Weg[]) {
    const vor = ruhe(w.db, w.pid);
    const r = weg === 'primary' ? await rueckgabeVeraltet(w.db, t) : await rueckgabeVomAgenten('fern', w.db, t);
    reload();
    ok(!r.ok && r.code === 'TRANSFER_NOT_OPEN' && ruhe(w.db, w.pid) === vor,
      `V ${fall.name} ${weg}: Rückgabe eines verkauften Vorgangs → abgewiesen, Stück bleibt weg, Forderung/Zahlung unberührt (${r.code || 'ZURÜCK'}; ${prodS(w.db, w.pid)}; ${S(konten(w.db))})`);
  }
  // Löschen: der GANZE Verkauf geht zurück — Stück, Forderung, Wareneinsatz, Zahlung —, dann genau ein Verkauf.
  const d = loeschen(w.db, t);
  ok(d === '' && prodS(w.db, w.pid) === S(['CONSIGNMENT', 'consignment', 1]) && kst(w.db, w.cid) === 'active'
    && S(konten(w.db)) === kontenVorher && balanced(w.db)
    && n(w.db, 'SELECT COUNT(*) FROM agent_transfers WHERE id = ?', [t]) === 0
    && n(w.db, 'SELECT COUNT(*) FROM agent_settlement_payments WHERE transfer_id = ?', [t]) === 0,
    `V ${fall.name}: Löschen nimmt den ganzen Verkauf zurück — Stück da, Konten wie vor dem Verkauf, keine Zahlung mehr (${d || 'ok'}; ${prodS(w.db, w.pid)}; ${S(konten(w.db))} vs ${kontenVorher})`);
  const rs = await primary(() => conHouse.recordConsignmentSaleOnPrimary(w.cid, SALE));
  ok(rs.ok && n(w.db, 'SELECT COUNT(DISTINCT invoice_id) FROM invoice_lines WHERE product_id = ?', [w.pid]) === 1
    && n(w.db, 'SELECT COUNT(*) FROM agent_transfers WHERE product_id = ?', [w.pid]) === 0 && balanced(w.db),
    `V ${fall.name}: danach genau EIN Verkauf über „Record Sale", kein Agentenverkauf mehr daneben (${rs.code || 'ok'})`);
}
{ // umgewandelt (Rechnung): weder Rückgabe noch Löschen
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  const ok0 = await altVerkauf(w, t, { umwandeln: true });
  ok(ok0 && s(w.db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t]) !== '', `V umgewandelt Ausgangslage: Alt-Agentenverkauf auf einer Rechnung (${prodS(w.db, w.pid)})`);
  for (const weg of ['primary', 'fern'] as Weg[]) {
    const vor = ruhe(w.db, w.pid);
    const r = weg === 'primary' ? await rueckgabeVeraltet(w.db, t) : await rueckgabeVomAgenten('fern', w.db, t);
    reload();
    ok(!r.ok && r.code === 'TRANSFER_NOT_OPEN' && ruhe(w.db, w.pid) === vor,
      `V umgewandelt ${weg}: Rückgabe → abgewiesen, Stück bleibt verkauft, Rechnung unberührt (${r.code || 'ZURÜCK'}; ${prodS(w.db, w.pid)})`);
  }
  const vor = ruhe(w.db, w.pid);
  const d = loeschen(w.db, t);
  ok(d !== '' && ruhe(w.db, w.pid) === vor, `V umgewandelt: Löschen → abgewiesen, nichts geschrieben (${d || 'GELÖSCHT'})`);
}
{ // eigene Ware, verkauft + abgerechnet: Rückgabe abgewiesen (wie am PC2), Löschen nimmt alles zurück → OWN/in_stock
  const db = freshDb();
  agentKunde(db);
  insert(db, 'products', { id: 'p-own2', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'Eigen', sku: 'SKU-OWN2', quantity: 1,
    condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 300, purchase_currency: 'BHD', planned_sale_price: 500,
    stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW });
  reload();
  const kontenVorher = S(konten(db));
  const u = await uebergabe('primary', db, 'p-own2');
  const t = tidOf(db, 'p-own2');
  const v = await agentVerkauf('primary', db, t);
  const a = await abrechnung('primary', db, t);
  const vor = ruhe(db, 'p-own2');
  const r = await rueckgabeVeraltet(db, t);
  reload();
  ok(u.ok && v.ok && a.ok && !r.ok && r.code === 'TRANSFER_NOT_OPEN' && ruhe(db, 'p-own2') === vor,
    `V eigene Ware abgerechnet: Rückgabe (veraltete Maske) → abgewiesen, Zahlung bleibt nicht als Kundenguthaben neben dem Stück stehen (${r.code || 'ZURÜCK'}; ${S(konten(db))})`);
  const d = loeschen(db, t);
  ok(d === '' && prodS(db, 'p-own2') === S(['OWN', 'in_stock', 1]) && S(konten(db)) === kontenVorher && balanced(db),
    `V eigene Ware: Löschen nimmt Verkauf + Zahlung zurück → OWN/in_stock, Konten wie vorher (${d || 'ok'}; ${prodS(db, 'p-own2')})`);
}
{ // zurückgegebener Alt-Vorgang, Kommission danach verkauft: Löschen fasst das Stück nicht an (und ist erlaubt)
  const w = await welt({ sale: null });
  agentKunde(w.db); vonHand(w.db, w.pid);
  const t = altUebergabe(w.db, w.pid);
  const r = await rueckgabeVomAgenten('primary', w.db, t);
  const rs = await primary(() => conHouse.recordConsignmentSaleOnPrimary(w.cid, SALE));
  reload();
  const p0 = prodS(w.db, w.pid);
  const k0 = all(w.db, 'SELECT status, invoice_id FROM consignments ORDER BY id');
  const l0 = S(konten(w.db));
  const d = loeschen(w.db, t);
  ok(r.ok && rs.ok && d === '' && prodS(w.db, w.pid) === p0 && all(w.db, 'SELECT status, invoice_id FROM consignments ORDER BY id') === k0
    && S(konten(w.db)) === l0 && n(w.db, 'SELECT COUNT(*) FROM agent_transfers WHERE id = ?', [t]) === 0,
    `V zurückgegebener Vorgang löschen (Kommission inzwischen verkauft) → erlaubt, Stück/Kommission/Konten unberührt (${d || 'ok'}; ${p0} → ${prodS(w.db, w.pid)})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — consignment agent handoff: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

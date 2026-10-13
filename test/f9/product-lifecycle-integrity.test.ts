// F9 — PRODUCT-LIFECYCLE-INTEGRITY — Menge, Bestandsstatus und Herkunft folgen aus den Vorgängen, nie aus der Artikelmaske.
// Gerüst (Welt, Fern-/Primary-Anschluss) wie test/consignment-integrity/agent-handoff.test.ts; die Prüfungen stehen unten.
// Run: node test/f9/product-lifecycle-integrity.test.ts
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
// F9 — die im Audit belegten Umgehungen (P1–P9), Primary und PC2:
//   P1  Notiz speichern setzt Menge 0 auf 1 (versteckter Reset) → zweiter Verkauf
//   P2  „sold" → „in stock" von Hand → zweiter Verkauf        P3  dasselbe mit Los
//   P4  „sold" von Hand ohne Verkauf                           P5  Menge frei erhöhen
//   P6  beim Agenten → „in stock" → Verkauf an Dritte         P7  PC2: Status/Herkunft, auch Fantasiewerte
//   P8  Kommissionsware (bleibt gesperrt)                      P9  Duplikat zusammenführen
//   S   Stammdaten bleiben editierbar (Primary und PC2)        M   Masken-Pins (Artikelseite, Duplikate)
// Die Prüfungen laufen auch gegen den ALTEN Code (Gegenprobe) und scheitern dort.
// ════════════════════════════════════════════════════════════════════════════
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const th = await import('../../src/core/agents/transfer-house.ts');
const pc = await import('../../src/core/bridge/product-commands.ts');
const ich = await import('../../src/core/invoices/invoice-create-house.ts');

const zeile = (db: Db, pid: string): string => S(db.exec('SELECT source_type, stock_status, quantity FROM products WHERE id = ?', [pid])[0]?.values?.[0] ?? []);
/** Alles, was eine abgewiesene Bearbeitung nicht verändern darf. */
const ruhig = (db: Db, pid: string): string => S({
  p: all(db, 'SELECT * FROM products WHERE id = ?', [pid]),
  lose: all(db, 'SELECT id, status, qty_remaining FROM stock_lots WHERE product_id = ? ORDER BY id', [pid]),
  log: changelog(db), audit: n(db, 'SELECT COUNT(*) FROM audit_log'), inv: n(db, 'SELECT COUNT(*) FROM invoices'),
});
const rechnungen = (db: Db, pid: string): number =>
  n(db, "SELECT COUNT(DISTINCT il.invoice_id) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id WHERE il.product_id = ? AND i.status != 'CANCELLED'", [pid]);
function artikel(db: Db, pid: string, mitLos: boolean, qty = 1): void {
  insert(db, 'products', { id: pid, branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'F9 ' + pid, sku: 'SKU-' + pid, quantity: qty,
    condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 300, purchase_currency: 'BHD', planned_sale_price: 500,
    stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW });
  if (mitLos) insert(db, 'stock_lots', { id: 'lot-' + pid, branch_id: 'branch-main', product_id: pid, unit_cost: 300, qty_total: qty, qty_remaining: qty,
    status: 'ACTIVE', acquired_at: NOW, created_at: NOW, unit: 'pcs' });
  reload();
}
/** Ein Verkauf über die Hausfolge (derselbe Weg wie „Save Invoice" am Primary und `invoices.create` vom PC2). */
async function verkaufe(db: Db, pid: string): Promise<Ausgang> {
  nimm(db);
  return primary(() => ich.createInvoiceOnPrimary({ customerId: 'cust-2', specialMark: false,
    lines: [{ productId: pid, unitPrice: 500, purchasePrice: 300, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 18.182, lineTotal: 500 } as never] }));
}
/** Speichern auf der Artikelseite am Primary: was die Maske dem Haus übergibt — das Formular (aus dem geladenen Artikel) + Änderung. */
async function maske(db: Db, pid: string, aenderung: Record<string, unknown>): Promise<string> {
  nimm(db);
  const p = useProductStore.getState().products.find((x) => x.id === pid);
  if (!p) return 'NICHT_GELADEN';
  const { images: _i, ...text } = { ...p, ...aenderung } as Record<string, unknown>;
  const r = await useProductStore.getState().editProductTextDurably(pid, text as never) as { status: string; errorCode?: string };
  reload();
  return r.status + (r.errorCode ? ':' + r.errorCode : '');
}
async function pc2(db: Db, pid: string, felder: Record<string, unknown>): Promise<Ausgang> {
  nimm(db);
  return fern(() => pc.runProductUpdate(deps(db), identity(nx(), 'products.update'), { id: pid, ...felder }));
}
const GESPERRT = /PRODUCT_LIFECYCLE_LOCKED/;

// ══ P1 — versteckter Mengen-Reset ════════════════════════════════════════════
{
  const db = freshDb(); artikel(db, 'p1', false);
  const v1 = await verkaufe(db, 'p1');
  const nach1 = zeile(db, 'p1');
  const m = await maske(db, 'p1', { notes: 'nur eine Notiz' });
  const nachNotiz = zeile(db, 'p1');
  const v2 = await verkaufe(db, 'p1');
  ok(v1.ok && m === 'edited' && nachNotiz === nach1 && s(db, "SELECT notes FROM products WHERE id = 'p1'") === 'nur eine Notiz',
    `P1 verkaufter Artikel ohne Los: nur Notiz gespeichert → Notiz da, Menge bleibt 0 (${nach1} → ${nachNotiz}; ${m})`);
  ok(!v2.ok && rechnungen(db, 'p1') === 1, `P1 …kein zweiter Verkauf (${v2.code.slice(0, 60) || 'VERKAUFT'}; Rechnungen ${rechnungen(db, 'p1')})`);
  ok(useProductStore.getState().products.find((x) => x.id === 'p1')?.quantity === 0, 'P1 die Liste zeigt die echte Menge 0 (nicht 1)');
}
// ══ P2–P5 — Status und Menge von Hand ═════════════════════════════════════════
for (const [name, mitLos, vorher, aenderung] of [
  ['P2 verkauft (ohne Los) → „in stock"', false, 'verkauf', { stockStatus: 'in_stock' }],
  ['P3 verkauft (mit Los) → „in stock"', true, 'verkauf', { stockStatus: 'in_stock' }],
  ['P4 „sold" ohne Verkauf (mit Los)', true, '', { stockStatus: 'sold' }],
  ['P5 Menge 1 → 3 ohne Einkauf', false, '', { quantity: 3 }],
  ['P5 Menge 1 → 2,5', false, '', { quantity: 2.5 }],
  ['P7 Herkunft OWN → CONSIGNMENT am Primary', false, '', { sourceType: 'CONSIGNMENT' }],
] as Array<[string, boolean, string, Record<string, unknown>]>) {
  const db = freshDb(); artikel(db, 'px', mitLos);
  if (vorher === 'verkauf') await verkaufe(db, 'px');
  const vor = ruhig(db, 'px');
  const m = await maske(db, 'px', aenderung);
  ok(GESPERRT.test(m) && ruhig(db, 'px') === vor, `${name}: am Haus abgewiesen, nichts geschrieben (${m}; ${zeile(db, 'px')})`);
  if (name.startsWith('P5 Menge 1 → 3')) {
    const vs = [await verkaufe(db, 'px'), await verkaufe(db, 'px')];
    ok(vs[0].ok && !vs[1].ok && rechnungen(db, 'px') === 1, `P5 …es bleibt bei einem verkaufbaren Stück (${vs.map((v) => (v.ok ? 'OK' : 'NEIN')).join('/')})`);
  }
  if (vorher === 'verkauf') {
    const v2 = await verkaufe(db, 'px');
    ok(!v2.ok && rechnungen(db, 'px') === 1, `${name}: …kein zweiter Verkauf (${v2.code.slice(0, 50) || 'VERKAUFT'})`);
  }
}
// ══ P6 — beim Agenten ════════════════════════════════════════════════════════
{
  const db = freshDb();
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-agent','branch-main','Agent','Ali','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  artikel(db, 'p6', false);
  nimm(db); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
  const u = await primary(() => imHaus(() => th.createTransferInHouse({ customerId: 'cust-agent', productId: 'p6', ourPrice: 1100, settlementModel: 'full' }, 'branch-main')));
  const vor = ruhig(db, 'p6');
  const m = await maske(db, 'p6', { stockStatus: 'in_stock' });
  ok(u.ok && GESPERRT.test(m) && ruhig(db, 'p6') === vor, `P6 beim Agenten: Status „in stock" von Hand abgewiesen (${m}; ${zeile(db, 'p6')})`);
  // Altbestand: der Status steht schon (von früher, von Hand) auf „in stock", der Vorgang ist offen.
  db.run("UPDATE products SET stock_status = 'in_stock' WHERE id = 'p6'");
  reload();
  const v = await verkaufe(db, 'p6');
  ok(!v.ok && rechnungen(db, 'p6') === 0 && s(db, "SELECT status FROM agent_transfers WHERE product_id = 'p6'") === 'transferred',
    `P6 …und auch mit Status „in stock" (Altbestand): Verkauf an Dritte abgewiesen, solange der Agentenvorgang offen ist (${v.code.slice(0, 60) || 'VERKAUFT'})`);
}
// ══ P7 — PC2: Status und Herkunft, auch Fantasiewerte ═════════════════════════
{
  const db = freshDb(); artikel(db, 'p7', false);
  await verkaufe(db, 'p7');
  const vor = ruhig(db, 'p7');
  const r = [
    await pc2(db, 'p7', { stockStatus: 'in_stock' }),
    await pc2(db, 'p7', { sourceType: 'CONSIGNMENT' }),
    await pc2(db, 'p7', { stockStatus: 'banana', sourceType: 'XYZ' }),
    await pc2(db, 'p7', { quantity: 5 }),
  ];
  ok(r.every((x) => !x.ok && x.code === 'PRODUCT_PAYLOAD_INVALID') && ruhig(db, 'p7') === vor,
    `P7 PC2: Status, Herkunft, Fantasiewerte und Menge abgewiesen, nichts geschrieben (${r.map((x) => x.code || 'OK').join('/')}; ${zeile(db, 'p7')})`);
}
// ══ P8 — Kommissionsware ═════════════════════════════════════════════════════
{
  const w = await welt({ sale: null });
  const vor = ruhig(w.db, w.pid);
  const m = await maske(w.db, w.pid, { stockStatus: 'in_stock' });
  const v = await verkaufe(w.db, w.pid);
  ok(GESPERRT.test(m) && ruhig(w.db, w.pid) === vor && !v.ok && v.code === 'CONSIGNMENT_SELL_VIA_CONSIGNMENT',
    `P8 Kommissionsware: Status von Hand abgewiesen, Direktverkauf weiter gesperrt (${m}; ${v.code})`);
}
// ══ P9 — Duplikat zusammenführen ═════════════════════════════════════════════
{
  const merge = (db: Db, a: string, b: string): string => { nimm(db); const e = wirft(() => useProductStore.getState().mergeIntoExisting(a, b)); reload(); return e; };
  // (a) die Quelle hat einen Beleg (Rechnung) → abgewiesen, nichts gelöscht, Ziel unverändert
  const db = freshDb(); artikel(db, 'q1', false); artikel(db, 'z1', false);
  await verkaufe(db, 'q1');
  const vorZ = ruhig(db, 'z1');
  const e1 = merge(db, 'q1', 'z1');
  ok(e1 !== '' && n(db, "SELECT COUNT(*) FROM products WHERE id = 'q1'") === 1 && ruhig(db, 'z1') === vorZ,
    `P9 Quelle mit Rechnung: Zusammenführen abgewiesen, Quelle bleibt, Ziel unverändert (${e1.slice(0, 70) || 'GELÖSCHT'})`);
  // (b) Quelle ohne Beleg, Menge 0 → keine Phantom-Menge am Ziel
  const db2 = freshDb(); artikel(db2, 'q2', false, 0); artikel(db2, 'z2', false);
  const e2 = merge(db2, 'q2', 'z2');
  ok(e2 === '' && n(db2, "SELECT COUNT(*) FROM products WHERE id = 'q2'") === 0 && n(db2, "SELECT quantity FROM products WHERE id = 'z2'") === 1,
    `P9 Quelle ohne Beleg, Menge 0: zusammengeführt, Ziel bleibt bei 1 (keine Phantom-Menge) (${e2 || 'ok'}; ${zeile(db2, 'z2')})`);
  // (c) Ziel mit Losen, Quelle mit Menge → abgewiesen (die Menge stünde neben den Losen und verschwände beim nächsten Abgleich)
  const db3 = freshDb(); artikel(db3, 'q3', false); artikel(db3, 'z3', true);
  const vor3 = ruhig(db3, 'z3');
  const e3 = merge(db3, 'q3', 'z3');
  ok(e3 !== '' && n(db3, "SELECT COUNT(*) FROM products WHERE id = 'q3'") === 1 && ruhig(db3, 'z3') === vor3,
    `P9 Ziel mit Losen: Zusammenführen mit Menge abgewiesen, nichts verändert (${e3.slice(0, 70) || 'ZUSAMMENGEFÜHRT'})`);
  // (d) beide ohne Los und ohne Beleg → wie bisher: Mengen addiert, Quelle entfernt
  const db4 = freshDb(); artikel(db4, 'q4', false); artikel(db4, 'z4', false);
  const e4 = merge(db4, 'q4', 'z4');
  ok(e4 === '' && n(db4, "SELECT COUNT(*) FROM products WHERE id = 'q4'") === 0 && n(db4, "SELECT quantity FROM products WHERE id = 'z4'") === 2,
    `P9 beide ohne Los und Beleg: wie bisher zusammengeführt, Menge 1 + 1 = 2 (${e4 || 'ok'})`);
  // (e–i) BEIDE Artikel zählen: eine Menge geht nur von freier eigener Ware auf freie eigene Ware über.
  /** Abgewiesen, Quelle bleibt, Ziel und Quelle unverändert. */
  const abgewiesen = (dbx: Db, a: string, b: string, name: string): void => {
    const vorQ = ruhig(dbx, a), vorZ = ruhig(dbx, b);
    const e = merge(dbx, a, b);
    ok(/MERGE_STOCK_NOT_FREE|not free stock|not in stock|not own stock|with an agent/.test(e) && ruhig(dbx, a) === vorQ && ruhig(dbx, b) === vorZ,
      `P9 ${name}: abgewiesen, Quelle bleibt, nichts verändert (${e.slice(0, 80) || 'ZUSAMMENGEFÜHRT ' + zeile(dbx, b)})`);
  };
  // (e) Ziel verkauft (ohne Los, Menge 0, „sold") — vorher: Menge 1 bei Status „sold"
  const db5 = freshDb(); artikel(db5, 'q5', false); artikel(db5, 'z5', false);
  await verkaufe(db5, 'z5');
  abgewiesen(db5, 'q5', 'z5', 'Ziel verkauft');
  // … eine Quelle mit Menge 0 darf trotzdem in ein verkauftes Ziel aufgehen (es geht keine Menge über)
  db5.run("UPDATE products SET quantity = 0 WHERE id = 'q5'"); reload();
  const vor5 = zeile(db5, 'z5');
  const e5b = merge(db5, 'q5', 'z5');
  ok(e5b === '' && n(db5, "SELECT COUNT(*) FROM products WHERE id = 'q5'") === 0 && zeile(db5, 'z5') === vor5 && n(db5, "SELECT quantity FROM products WHERE id = 'z5'") === 0,
    `P9 Quelle mit Menge 0 in verkauftes Ziel: zusammengeführt, Ziel unverändert mit Menge 0 (${e5b || 'ok'}; ${vor5} → ${zeile(db5, 'z5')})`);
  // (f) Ziel beim Agenten (ohne Los) — vorher: Menge 2 „with_agent", der Agentenverkauf nähme das zweite Stück mit
  const db6 = freshDb();
  db6.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-agent','branch-main','Agent','Ali','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  artikel(db6, 'q6', false); artikel(db6, 'z6', false);
  nimm(db6); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
  const u6 = await primary(() => imHaus(() => th.createTransferInHouse({ customerId: 'cust-agent', productId: 'z6', ourPrice: 1100, settlementModel: 'full' }, 'branch-main')));
  ok(u6.ok, `P9 (Vorbereitung) Ziel an den Agenten übergeben (${u6.code || 'ok'})`);
  abgewiesen(db6, 'q6', 'z6', 'Ziel beim Agenten');
  // … auch wenn sein Status (Altbestand, von Hand) schon wieder „in stock"/OWN sagt, solange der Vorgang offen ist
  db6.run("UPDATE products SET stock_status = 'in_stock', source_type = 'OWN' WHERE id = 'z6'"); reload();
  abgewiesen(db6, 'q6', 'z6', 'Ziel beim Agenten mit Altbestand-Status „in stock"');
  // (g) Ziel Kommissionsware — vorher: eigene Ware dem Einlieferer zugeschlagen
  const w7 = await welt({ sale: null });
  artikel(w7.db, 'q7', false);
  abgewiesen(w7.db, 'q7', w7.pid, 'Ziel Kommissionsware');
  // … auch wenn Status und Herkunft (Altbestand) „in stock"/OWN sagen, solange die Kommission offen ist
  w7.db.run("UPDATE products SET stock_status = 'in_stock', source_type = 'OWN' WHERE id = ?", [w7.pid]); reload();
  abgewiesen(w7.db, 'q7', w7.pid, 'Ziel mit offener Kommission, Status/Herkunft „in stock"/OWN');
  // (h) Herkunft verschieden: Quelle CONSIGNMENT (ohne Beleg, z. B. Import) → eigenes Ziel
  const db8 = freshDb(); artikel(db8, 'q8', false); artikel(db8, 'z8', false);
  db8.run("UPDATE products SET source_type = 'CONSIGNMENT' WHERE id = 'q8'"); reload();
  abgewiesen(db8, 'q8', 'z8', 'Quelle CONSIGNMENT → Ziel OWN');
  // (i) Quelle nicht frei (früher von Hand „sold", Menge 1, ohne Beleg) — vorher: Phantom-Stück am Ziel
  const db9 = freshDb(); artikel(db9, 'q9', false); artikel(db9, 'z9', false);
  db9.run("UPDATE products SET stock_status = 'sold' WHERE id = 'q9'"); reload();
  abgewiesen(db9, 'q9', 'z9', 'Quelle „sold" von Hand');
  // (j) Ziel ohne gespeicherte Menge (NULL, angezeigt als 1) + Quelle 1 → 2, kein angezeigtes Stück geht verloren
  const db10 = freshDb(); artikel(db10, 'q10', false); artikel(db10, 'z10', false);
  db10.run("UPDATE products SET quantity = NULL WHERE id = 'z10'"); reload();
  const e10 = merge(db10, 'q10', 'z10');
  ok(e10 === '' && n(db10, "SELECT quantity FROM products WHERE id = 'z10'") === 2, `P9 Ziel ohne gespeicherte Menge (angezeigt 1) + 1 = 2 (${e10 || 'ok'}; ${zeile(db10, 'z10')})`);
}
// ══ S — Stammdaten bleiben editierbar ════════════════════════════════════════
{
  const db = freshDb(); artikel(db, 'ps', false);
  const m = await maske(db, 'ps', { notes: 'Primary-Notiz', plannedSalePrice: 650, condition: 'Unworn' });
  const r = await pc2(db, 'ps', { notes: 'PC2-Notiz', storageLocation: 'Vitrine 2' });
  ok(m === 'edited' && r.ok && s(db, "SELECT notes FROM products WHERE id = 'ps'") === 'PC2-Notiz'
    && n(db, "SELECT planned_sale_price FROM products WHERE id = 'ps'") === 650 && s(db, "SELECT storage_location FROM products WHERE id = 'ps'") === 'Vitrine 2'
    && zeile(db, 'ps') === S(['OWN', 'in_stock', 1]),
    `S Stammdaten: Primary (Notiz, Preis, Zustand) und PC2 (Notiz, Lagerort) gespeichert, Bestand unberührt (${m}/${r.code || 'ok'})`);
}
// ══ M — Masken ═══════════════════════════════════════════════════════════════
{
  const pd = src('src/pages/watches/ProductDetail.tsx');
  ok(!/setForm\(\{ \.\.\.form, stockStatus/.test(pd) && !/setForm\(\{ \.\.\.form, quantity/.test(pd),
    'M Artikelseite: keine Status-Knöpfe und kein Mengenfeld mehr zum Setzen');
  ok(/quantity: _\w*, stockStatus: _\w*, sourceType: _\w*, \.\.\.\w+\s*\}\s*=\s*form/.test(pd),
    'M Artikelseite: die Maske schickt Menge, Status und Herkunft nicht mit');
  const wp = src('src/core/data/write-payloads.ts');
  const upd = wp.slice(wp.indexOf('export const PRODUCT_UPDATE_FIELDS'), wp.indexOf('] as const;', wp.indexOf('export const PRODUCT_UPDATE_FIELDS')));
  ok(!/'stockStatus'|'sourceType'|'quantity'/.test(upd), 'M PC2: products.update kennt Status, Herkunft und Menge nicht mehr als Felder');
  const sp = src('src/pages/settings/SettingsPage.tsx');
  const mergeFn = sp.slice(sp.indexOf('function handleMergeAllIntoMaster'), sp.indexOf('function handleDeleteAllExceptMaster'));
  ok(!/for \(const m of group\.members\)/.test(mergeFn) && /memberIds\.includes\(m\.id\)/.test(mergeFn) && /window\.confirm/.test(mergeFn),
    'M Duplikate: „Alle in Master mergen" nimmt nur die sichtbaren Mitglieder und fragt vorher nach');
  const delFn = sp.slice(sp.indexOf('function handleDeleteAllExceptMaster'), sp.indexOf('const visibleGroups', sp.indexOf('function handleDeleteAllExceptMaster')));
  ok(!/for \(const m of group\.members\)/.test(delFn) && /memberIds\.includes/.test(delFn), 'M Duplikate: „Alle außer Master löschen" nimmt nur die sichtbaren Mitglieder');
  ok(/deleteProduct\(m\.id\)/.test(delFn) && /failed\.push/.test(delFn) && /if \(failed\.length === 0\) setGroups/.test(delFn),
    'M Duplikate: „Alle außer Master löschen" läuft über die Löschprüfung des Stores und meldet Abgewiesene, statt die Gruppe als erledigt zu entfernen');
  ok(/onMergeAllIntoMaster\(masterProduct\.id, visibleMembers\.map/.test(sp) && /onDeleteAllExceptMaster\(masterProduct\.id, visibleMembers\.map/.test(sp),
    'M Duplikate: die Karte übergibt den sichtbaren Master und die sichtbaren Mitglieder');
  // Der direkte Store-Weg `updateProduct` (kein Fernbefehl): Menge/Status/Herkunft setzt dort nur ein Geschäftsvorgang
  // (der Storno alter Rechnungszeilen ohne Los) — keine Maske.
  const { readdirSync } = await import('node:fs');
  const treffer: string[] = [];
  for (const rel of readdirSync(resolvePath(repo, 'src'), { recursive: true, encoding: 'utf8' })) {
    if (!/\.(ts|tsx)$/.test(rel) || /stores[\\/]productStore\.ts$/.test(rel)) continue;
    const t = src('src/' + rel.replace(/\\/g, '/'));
    for (const m of t.matchAll(/updateProduct\([^)]*?\{([^}]*)\}/g)) if (/\b(quantity|stockStatus|sourceType)\s*:/.test(m[1])) treffer.push(rel.replace(/\\/g, '/'));
  }
  ok(treffer.length === 1 && treffer[0] === 'core/invoices/invoice-cancel-house.ts',
    `M updateProduct mit Menge/Status/Herkunft nur aus dem Rechnungsstorno (${treffer.join(', ') || 'keiner'})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — f9 product lifecycle integrity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

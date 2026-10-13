// STARTUP-MIGRATION-INTEGRITY — ein Programmstart verändert keine Bestände (Lose, Mengen, Status, Herkunft).
// Gerüst (Welt, Fern-/Primary-Anschluss) wie test/consignment-integrity/agent-handoff.test.ts; die Prüfungen stehen unten.
// Run: node test/startup-migration/startup-migration-integrity.test.ts
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
// STARTUP-MIGRATION-INTEGRITY — historische Bestandskorrekturen liefen im Migrationsblock, der bei JEDEM Start
// läuft: sie rechneten Lose, Mengen, Status und Herkunft aus Rechnungszeilen neu — über alles hinweg, was seitdem
// geschah. Hier: ein Neustart (derselbe Ablauf wie `runMigrations`) lässt jeden Bestand, wie er ist.
//   B  Edelmetall-Los (Gewicht, Stückmenge 0) nach Teilabschreibung
//   A  Agentenverkauf (Los verbraucht, keine Rechnungszeile)
//   K  Kommission „Keep" (eigene Ware)          R  Kommission „Return to Owner"
//   P  Produktion (Eingang verbraucht)          S  Rücksendung an den Lieferanten
//   N  gewöhnlicher Artikel, eingekauft und teilweise verkauft
//   F  neue Datenbank                           U  Aktualisierung einer alten Datenbank (vor den Losen)
// Die Prüfungen laufen auch gegen den ALTEN Code (Gegenprobe) und scheitern dort.
// ════════════════════════════════════════════════════════════════════════════
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const th = await import('../../src/core/agents/transfer-house.ts');
const { createPurchaseDetailedInHouse } = await import('../../src/core/purchases/purchase-house.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const bm = await import('../../src/core/bulk/bulk-math.ts');
const lh = await import('../../src/core/bulk/bulk-lot-house.ts');
// Die einmalige Altkorrektur — im alten Code (Gegenprobe) gibt es sie nicht: dort steht alles im Startblock.
const legacy = await import('../../src/core/db/legacy-stock-repair.ts').catch(() => null) as null | {
  runLegacyStockRepairsOnce(db: unknown, hadStockLotsBefore: boolean): string;
  hasStockLotsTable(db: unknown): boolean;
  LEGACY_STOCK_REPAIR_FLAG: string;
  LEGACY_STOCK_REPAIRS: readonly string[];
};

const hatTabelle = (db: Db, t: string): boolean => n(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [t]) > 0;
/** Ein Programmstart auf einer VORHANDENEN Datenbank: was `runMigrations` tut — Stand vorher merken, Block, Altkorrektur. */
function neustart(db: Db): void {
  const hatteLose = hatTabelle(db, 'stock_lots');
  for (const m of MIGRATIONS) { try { db.run(m); } catch { /* wie runMigrations */ } }
  if (legacy) legacy.runLegacyStockRepairsOnce(db, hatteLose);
  nimm(db);
}
/** Alles, was ein Neustart an einem Artikel nicht verändern darf. */
const bestand = (db: Db, pid: string): string => S({
  p: all(db, 'SELECT source_type, stock_status, quantity, purchase_price FROM products WHERE id = ?', [pid]),
  lose: all(db, `SELECT id, status, qty_total, qty_remaining, COALESCE(remaining_weight_mg, -1), COALESCE(remaining_value_fils, -1)
                   FROM stock_lots WHERE product_id = ? ORDER BY id`, [pid]),
  zeilen: all(db, 'SELECT id, lot_id FROM invoice_lines WHERE product_id = ? ORDER BY id', [pid]),
  k: all(db, 'SELECT id, status FROM consignments WHERE product_id = ? ORDER BY id', [pid]),
  buch: { zeilen: lc(db), konten: konten(db) },
});
const dreimal = (db: Db): void => { neustart(db); neustart(db); neustart(db); };
function agentKunde(db: Db): void {
  db.run(`INSERT OR IGNORE INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-agent','branch-main','Agent','Ali','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  reload(); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
}
function lieferant(db: Db): void {
  db.run("INSERT OR IGNORE INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  reload();
}
function artikel(db: Db, pid: string): void {
  insert(db, 'products', { id: pid, branch_id: 'branch-main', category_id: 'cat-w', brand: 'Omega', name: 'Start ' + pid, sku: 'SKU-' + pid, quantity: 0,
    condition: 'Pre-Owned', scope_of_delivery: '[]', purchase_price: 300, purchase_currency: 'BHD', planned_sale_price: 500,
    stock_status: 'in_stock', tax_scheme: 'MARGIN', days_in_stock: 0, images: '[]', attributes: '{}', source_type: 'OWN', created_at: NOW, updated_at: NOW });
  reload();
}
/** Einkauf über den Weg der Maske: das Los entsteht dort. */
function kauf(pid: string, qty: number): string {
  const id = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-1', lines: [{ productId: pid, quantity: qty, unitPrice: 300, taxScheme: 'ZERO' as const, vatRate: 0 }],
  } as never).id);
  reload();
  return id;
}
function verkauf(pid: string, qty = 1): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [{ productId: pid, quantity: qty, unitPrice: 500, purchasePrice: 0,
    taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 500 * qty }] as never, 'Start').id);
  reload();
  return id;
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}

// ══ B — Edelmetall-Los ════════════════════════════════════════════════════════
{
  const db = freshDb(); lieferant(db);
  const r = imHaus(() => createPurchaseDetailedInHouse({ supplierId: 'sup-1', purchaseDate: '2026-09-13', taxScheme: 'ZERO', paymentAmount: 0,
    paymentMethod: 'cash', notes: '', staffId: '', lines: [{ mode: 'bulk', brand: '', name: '', sku: '', categoryId: '', quantity: 1, unitPrice: 1000,
      bulk: { metal: 'silver', fineness: '925', weightMg: bm.parseGramsToMg('500'), lineTotalFils: bm.parseBhdToFils('1000'), saleTaxScheme: 'MARGIN' } }] } as never,
    'branch-main', 'user-test'));
  reload();
  const lotId = s(db, "SELECT id FROM stock_lots WHERE purchase_id = ? AND unit = 'mg'", [r.purchase.id]);
  const pid = s(db, 'SELECT product_id FROM stock_lots WHERE id = ?', [lotId]);
  const MGR = { branchId: 'branch-main', userId: 'user-test', now: NOW, role: 'MANAGER' };
  const ab = (g: number): string => wirft(() => imHaus(() => lh.writeOffInHouse({ actionId: `wo-${nx()}-xxxxxxxx`, lotId, expectedRevision: lh.getBulkLot(lotId)!.revision,
    weightMg: g, reason: 'Waage' } as never, MGR as never)));
  const a1 = ab(1000);
  const vor = bestand(db, pid);
  dreimal(db);
  const L = lh.getBulkLot(lotId)!;
  ok(a1 === '' && bestand(db, pid) === vor && L.status === 'ACTIVE' && L.remainingWeightMg === 499000,
    `B Edelmetall: nach dreimaligem Neustart unverändert ACTIVE 499 g (${L.status} ${L.remainingWeightMg} mg)`);
  const a2 = ab(1000);
  let inv = '';
  try { lh.assertBulkLotInvariants(lotId); } catch (e) { inv = (e as Error).message; }
  ok(a2 === '' && inv === '' && lh.getBulkLot(lotId)!.remainingWeightMg === 498000,
    `B Edelmetall: danach geht die nächste Abschreibung, Invarianten halten (${a2 || 'ok'}; ${inv || 'Invarianten ok'})`);
  // Selbst ein (erzwungener) Lauf der Altkorrektur fasst ein Edelmetall-Los nicht an — es führt seinen Bestand im Gewicht.
  const vorZwang = bestand(db, pid);
  if (legacy) for (const sql of legacy.LEGACY_STOCK_REPAIRS) db.run(sql);
  ok(!!legacy && bestand(db, pid) === vorZwang && lh.getBulkLot(lotId)!.status === 'ACTIVE',
    `B Edelmetall: auch ein erzwungener Lauf der Altkorrektur lässt das Los ACTIVE (${lh.getBulkLot(lotId)!.status})`);
}
// ══ A — Agentenverkauf ════════════════════════════════════════════════════════
{
  const db = freshDb(); lieferant(db); agentKunde(db); artikel(db, 'pa');
  kauf('pa', 1);
  nimm(db);
  const u = await primary(() => imHaus(() => th.createTransferInHouse({ customerId: 'cust-agent', productId: 'pa', ourPrice: 1100, settlementModel: 'full' }, 'branch-main')));
  const tid = s(db, "SELECT id FROM agent_transfers WHERE product_id = 'pa'");
  nimm(db); useAgentStore.getState().loadAgents(); useAgentStore.getState().loadTransfers();
  const v = await primary(() => imHaus(() => useAgentStore.getState().markTransferSold(tid, 1300)));
  const vor = bestand(db, 'pa');
  dreimal(db);
  ok(u.ok && v.ok && bestand(db, 'pa') === vor, `A Agentenverkauf: Los bleibt verbraucht, Menge 0 — kein Phantom-Bestand (${vor} → ${bestand(db, 'pa')})`);
  const m = wirft(() => verkauf('pa'));
  ok(m !== '', `A Agentenverkauf: nach dem Neustart nicht erneut verkaufbar (${m.slice(0, 60) || 'VERKAUFT'})`);
}
// ══ K / R — Kommission: Keep und Return to Owner ══════════════════════════════
for (const [name, disp] of [['K Keep', 'KEEP_AS_OWN'], ['R Return to Owner', 'RETURN_TO_OWNER']]) {
  const w = await welt();
  const a = await rueckgabe('primary', w, { disposition: disp as never, refundMethod: 'cash', reason: 'Kunde bringt es zurück' });
  const vor = bestand(w.db, w.pid);
  dreimal(w.db);
  ok(a.ok && bestand(w.db, w.pid) === vor, `${name}: Menge, Lose, Herkunft und Kommission unverändert (${a.code || 'ok'}; ${vor} → ${bestand(w.db, w.pid)})`);
}
// ══ P — Produktion ═══════════════════════════════════════════════════════════
{
  const db = freshDb(); lieferant(db); artikel(db, 'pp');
  kauf('pp', 1);
  nimm(db);
  let pr = '';
  try {
    await imHausAsync(() => Promise.resolve(createProductionInHouse({ inputProductIds: ['pp'],
      outputs: [{ spec: { brand: 'Eigen', name: 'Ring aus pp', categoryId: 'cat-w', condition: 'New', taxScheme: 'MARGIN', scopeOfDelivery: [], attributes: {} }, value: 300 }] } as never,
      { branchId: 'branch-main', userId: 'user-test' })));
  } catch (e) { pr = (e as Error).message; }
  reload();
  const vor = bestand(db, 'pp');
  dreimal(db);
  ok(pr === '' && s(db, "SELECT status FROM stock_lots WHERE product_id = 'pp'") === 'EXHAUSTED' && bestand(db, 'pp') === vor,
    `P Produktion: verbrauchter Eingang bleibt verbraucht (${pr || 'ok'}; ${vor} → ${bestand(db, 'pp')})`);
}
// ══ S — Rücksendung an den Lieferanten ═══════════════════════════════════════
{
  const db = freshDb(); lieferant(db); artikel(db, 'ps');
  const pid = kauf('ps', 2);
  const plId = s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ?', [pid]);
  const r = wirft(() => imHaus(() => life.returnToSupplierInHouse({ purchaseId: pid, refundMethod: 'cash', lines: [{ purchaseLineId: plId, quantity: 1, unitPrice: 300 }] } as never,
    { branchId: 'branch-main', userId: 'user-test', now: NOW } as never)));
  reload();
  const vor = bestand(db, 'ps');
  dreimal(db);
  ok(r === '' && n(db, "SELECT qty_remaining FROM stock_lots WHERE product_id = 'ps'") === 1 && bestand(db, 'ps') === vor,
    `S Lieferantenrückgabe: Los bleibt 2→1, Menge 1 (${r || 'ok'}; ${vor} → ${bestand(db, 'ps')})`);
}
// ══ N — gewöhnlicher Artikel ═════════════════════════════════════════════════
{
  const db = freshDb(); lieferant(db); artikel(db, 'pn');
  kauf('pn', 3);
  const inv = verkauf('pn');
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [inv]);
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, offen, 'cash'));
  reload();
  const vor = bestand(db, 'pn');
  dreimal(db);
  ok(bestand(db, 'pn') === vor && n(db, "SELECT quantity FROM products WHERE id = 'pn'") === 2, `N gewöhnlicher Artikel: 3 eingekauft, 1 verkauft → bleibt 2 (${vor} → ${bestand(db, 'pn')})`);
}
// ══ F — neue Datenbank ═══════════════════════════════════════════════════════
{
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  const hatteLose = hatTabelle(db, 'stock_lots');
  for (const m of MIGRATIONS) { try { db.run(m); } catch { /* wie runMigrations */ } }
  const ergebnis = legacy ? legacy.runLegacyStockRepairsOnce(db, hatteLose) : '(kein Modul)';
  const flag = s(db, 'SELECT value FROM settings WHERE key = ?', [legacy?.LEGACY_STOCK_REPAIR_FLAG ?? '-']);
  const zweit = legacy ? legacy.runLegacyStockRepairsOnce(db, hatTabelle(db, 'stock_lots')) : '(kein Modul)';
  ok(!hatteLose && hatTabelle(db, 'stock_lots') && ergebnis === 'applied' && flag === '1' && zweit === 'already-done',
    `F neue Datenbank: Schema vollständig, Altkorrektur einmal (leer) gelaufen, Merker gesetzt, zweiter Start tut nichts (${ergebnis}/${flag || 'kein Merker'}/${zweit})`);
}
// ══ U — Aktualisierung einer alten Datenbank (vor den Losen) ═════════════════
{
  // Eine Datenbank aus der Zeit vor den Losen: Grundschema, ein Artikel mit offener Kommission, Herkunft noch OWN.
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  // Nur die Spalten, die das Grundschema hat (Menge, Herkunft usw. kommen erst mit dem Migrationsblock).
  insert(db, 'products', { id: 'pu', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Rolex', name: 'Alt', condition: 'Pre-Owned',
    scope_of_delivery: '[]', purchase_price: 800, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN', images: '[]', attributes: '{}',
    created_at: NOW, updated_at: NOW });
  insert(db, 'consignments', { id: 'cu', branch_id: 'branch-main', consignment_number: 'CN-U', consignor_id: 'cust-1', product_id: 'pu',
    agreed_price: 1000, commission_rate: 15, status: 'active', agreement_date: '2026-01-01', created_at: NOW, updated_at: NOW });
  const hatteLose = hatTabelle(db, 'stock_lots');
  for (const m of MIGRATIONS) { try { db.run(m); } catch { /* wie runMigrations */ } }
  const erst = legacy ? legacy.runLegacyStockRepairsOnce(db, hatteLose) : '(kein Modul)';
  const nachErstemStart = s(db, "SELECT source_type FROM products WHERE id = 'pu'");
  // Danach eine fachliche Änderung (die Kommission wird als eigene Ware behalten) — ein weiterer Start darf sie nicht zurückdrehen.
  db.run("UPDATE products SET source_type = 'OWN' WHERE id = 'pu'");
  db.run("UPDATE consignments SET status = 'RETURNED' WHERE id = 'cu'");
  neustart(db);
  ok(!hatteLose && nachErstemStart === 'CONSIGNMENT' && s(db, "SELECT source_type FROM products WHERE id = 'pu'") === 'OWN',
    `U alte Datenbank: die Altkorrektur läuft beim ersten Start einmal (Herkunft → ${nachErstemStart}), ein weiterer Start dreht eine spätere Änderung nicht zurück (${s(db, "SELECT source_type FROM products WHERE id = 'pu'")}; ${erst})`);
}
// ══ T — Merker und Korrektur: ganz oder gar nicht ═════════════════════════════════════════
{
  // Alte Datenbank wie in U; das Setzen des Merkers scheitert → die schon gelaufene Korrektur geht mit zurück.
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  insert(db, 'products', { id: 'pt', branch_id: 'branch-main', category_id: 'cat-w', brand: 'Rolex', name: 'Alt', condition: 'Pre-Owned',
    scope_of_delivery: '[]', purchase_price: 800, purchase_currency: 'BHD', stock_status: 'in_stock', tax_scheme: 'MARGIN', images: '[]', attributes: '{}',
    created_at: NOW, updated_at: NOW });
  insert(db, 'consignments', { id: 'ct', branch_id: 'branch-main', consignment_number: 'CN-T', consignor_id: 'cust-1', product_id: 'pt',
    agreed_price: 1000, commission_rate: 15, status: 'active', agreement_date: '2026-01-01', created_at: NOW, updated_at: NOW });
  const hatteLose = hatTabelle(db, 'stock_lots');
  for (const m of MIGRATIONS) { try { db.run(m); } catch { /* wie runMigrations */ } }
  db.run(`CREATE TRIGGER t_inj BEFORE INSERT ON settings WHEN NEW.key = '${legacy?.LEGACY_STOCK_REPAIR_FLAG ?? '-'}' BEGIN SELECT RAISE(ABORT, 'INJECTED'); END`);
  const r1 = legacy ? legacy.runLegacyStockRepairsOnce(db, hatteLose) : '(kein Modul)';
  const nachFehler = s(db, "SELECT source_type FROM products WHERE id = 'pt'");
  const merker1 = n(db, 'SELECT COUNT(*) FROM settings WHERE key = ?', [legacy?.LEGACY_STOCK_REPAIR_FLAG ?? '-']);
  db.run('DROP TRIGGER t_inj');
  const r2 = legacy ? legacy.runLegacyStockRepairsOnce(db, hatteLose) : '(kein Modul)';
  ok(r1 === 'failed' && nachFehler === 'OWN' && merker1 === 0 && r2 === 'applied' && s(db, "SELECT source_type FROM products WHERE id = 'pt'") === 'CONSIGNMENT',
    `T Merker scheitert → Korrektur zurückgerollt, kein Merker; nächster Start holt beides nach (${r1}: ${nachFehler}/${merker1} → ${r2})`);
}
// ══ Q — der Startblock enthält keine Bestandskorrektur mehr; runMigrations ruft die einmalige ═══════════════
{
  const treffer = MIGRATIONS.filter((m) => /^\s*UPDATE\s+(products|stock_lots|invoice_lines)\b[\s\S]*\bSET\b[\s\S]*\b(quantity|qty_remaining|stock_status|source_type|lot_id|purchase_price)\s*=/i.test(m));
  ok(treffer.length === 0, `Q Startblock: keine UPDATE auf Menge/Los/Status/Herkunft/Einstand mehr (${treffer.length}: ${treffer.map((m) => m.replace(/\s+/g, ' ').slice(0, 60)).join(' | ')})`);
  const dbSrc = src('src/core/db/database.ts');
  const rm = dbSrc.slice(dbSrc.indexOf('function runMigrations('), dbSrc.indexOf('const migrations: string[] = ['));
  const nach = dbSrc.slice(dbSrc.indexOf('for (const sql of migrations)'), dbSrc.indexOf('classifyLegacyInvoiceLines(database)'));
  ok(/hasStockLotsTable\(database\)/.test(rm) && /runLegacyStockRepairsOnce\(database, /.test(nach),
    'Q runMigrations merkt VOR dem Block, ob es Lose gab, und ruft danach die einmalige Altkorrektur');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — startup migration integrity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }


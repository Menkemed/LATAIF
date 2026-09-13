// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — eine Kommission NACH dem Verkauf: „Post-Sale Return"
// (`consignments.return_after_sale`) und „Cancel Sale" (`consignments.cancel_sale`) — EINE Hausfolge
// (`consignment-reversal-house`) für die Maske des Primary und für PC2.
// Run: node test/r6f/consignment-parity.test.ts
//
// Gefahren werden die ECHTEN Folgen: Kommission anlegen (`consignments.create`), verkaufen
// (`recordConsignmentSaleOnPrimary`), die Rücknahmen über `…OnPrimary` (runOnPrimary) und über den
// Fernbefehl (runRemoteCommand, durabler Nachweis), das Retourenhaus, der Retourenstorno, die
// Rechnungsgrundlage, der Einkaufsstorno — auf dem echten Schema samt Hauptbuch. Gestellt sind nur das
// Speichern und — im Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 Rückgabe: Primary == PC2   §3 Rückgabe: Wiederholung, Fassung, Zustände, Altweg
//   §4 Rückgabe: Fehlerinjektion   §5 Rückgabe: Autorität und Rumpf   §6 Storno: Primary == PC2 und der
//   Stand VOR dem Verkauf   §7 Storno: weitere Welten   §8 Storno: Wiederholung, Fassung, Sperren,
//   Autorität   §9 Storno: Fehlerinjektion an vier Stellen + Buchung   §10 Client   §11 Oberfläche/Quelle
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

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  for (const op of [OP_R, OP_C]) {
    ok(registry.ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist namentlich freigegeben`);
    ok(registry.knownCommands().includes(op), `SCOPE ${op} ist registriert`);
    ok(perms.OPERATION_PERMISSIONS[op]?.kind === 'isAdmin' && perms.roleMayRunOp('MANAGER', op) && perms.roleMayRunOp('ADMIN', op)
      && !perms.roleMayRunOp('SALES', op), `SCOPE ${op}: das Recht der Maske (perm.canManageConsignments = Manager/Owner)`);
  }
  ok(S([...cl.CONSIGNMENT_LIFECYCLE_OPS].sort()) === S([OP_C, OP_R].sort()), 'SCOPE die Befehlsdatei kennt genau diese zwei');
  const reg = codeOf(src('src/core/bridge/consignment-lifecycle-commands.ts'));
  ok((reg.match(/registerCommand\(/g) || []).length === 2 && !/for \(|forEach/.test(reg.slice(reg.indexOf('registerCommand('))),
    'SCOPE zwei ausdrückliche Anmeldungen, keine Schleife');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_SCOPE_PROVED');

// ══ §2 — Rückgabe nach dem Verkauf: Primary == PC2 ══════════════════════════
const RFAELLE: Array<[string, RI, { bezahlt?: number; vat10?: boolean }]> = [
  ['Return to Owner, unbezahlt', { disposition: 'RETURN_TO_OWNER', reason: ' Kunde will nicht mehr ' }, {}],
  ['Keep, unbezahlt', { disposition: 'KEEP_AS_OWN' }, {}],
  ['Return to Owner, bar bezahlt', { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' }, { bezahlt: 1200 }],
  ['Return to Owner, VAT_10', { disposition: 'RETURN_TO_OWNER' }, { vat10: true }],
];
for (const [was, input, o] of RFAELLE) {
  const wP = await welt(o);
  const wR = await welt(o);
  const payout = n(wR.db, 'SELECT payout_amount FROM consignments WHERE id = ?', [wR.cid]);
  const gross = n(wR.db, 'SELECT gross_amount FROM invoices WHERE id = ?', [wR.invId]);
  const p = await rueckgabe('primary', wP, input);
  const r = await rueckgabe('fern', wR, input);
  ok(p.ok && r.ok, `RETURN ${was}: beide Wege buchen die Rückgabe (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const d = diffAll(bild(wP.db, wP.cid), bild(wR.db, wR.cid));
  ok(d.length === 0, `PARITY ${was}: lokal == fern — Kommission, Artikel, Lose, Rechnung, Retoure, Gutschrift, Einkauf, Ausgaben, Buchungen, Salden (${d.join(' · ') || 'gleich'})`);
  const ret = row(wR.db, 'SELECT * FROM sales_returns');
  ok(n(wR.db, 'SELECT COUNT(*) FROM sales_returns') === 1 && ret.status === 'REFUNDED' && ret.product_disposition === input.disposition
    && String(ret.notes).includes(`Consignment post-sale return (${s(wR.db, 'SELECT consignment_number FROM consignments WHERE id = ?', [wR.cid])})`),
  `RETURN ${was}: EINE Retoure über das Retourenhaus, REFUNDED, mit dem alten Vermerk (${S([ret.status, ret.product_disposition])})`);
  ok(/^RET/.test(String(ret.return_number)) && !/^RET-[0-9A-Z]{6}$/.test(String(ret.return_number)) && ret.return_number === row(wP.db, 'SELECT return_number FROM sales_returns').return_number,
    `RETURN ${was}: die Nummer kommt aus dem durablen Zähler, nicht mehr aus der Uhrzeit (${String(ret.return_number)})`);
  const cn = row(wR.db, 'SELECT * FROM credit_notes');
  ok(Math.abs(Number(cn.total_amount) - gross) < 0.0005 && Math.abs(Number(ret.total_amount) - gross) < 0.0005 && cn.status === 'ISSUED',
    `RETURN ${was}: Gutschrift und Retoure zum BRUTTO der Rechnung (${S([cn.total_amount, ret.total_amount, gross])}) — vorher Netto`);
  const inv = row(wR.db, 'SELECT status, vat_amount FROM invoices WHERE id = ?', [wR.invId]);
  ok(inv.status === (o.bezahlt ? 'FINAL' : 'RETURNED') && Math.abs(Number(inv.vat_amount)) < 0.0005,
    `RETURN ${was}: die Rechnung ist ${o.bezahlt ? 'bezahlt und bleibt FINAL' : 'RETURNED (aus den offenen Posten)'}, Steuer korrigiert (${S(inv)})`);
  const k = row(wR.db, 'SELECT status, payout_status FROM consignments WHERE id = ?', [wR.cid]);
  ok(k.status === 'returned', `RETURN ${was}: die Kommission steht auf „returned" (${S(k)})`);
  const prod = row(wR.db, 'SELECT quantity, stock_status, source_type, purchase_price FROM products WHERE id = ?', [wR.pid]);
  const kt = konten(wR.db);
  if (input.disposition === 'RETURN_TO_OWNER') {
    ok(prod.stock_status === 'returned' && Number(prod.quantity) === 0 && s(wR.db, 'SELECT status FROM purchases') === 'CANCELLED',
      `RETURN ${was}: die Ware ist beim Einlieferer, sein Auto-Einkauf storniert (${S(prod)})`);
    ok(Object.keys(kt).length === 0 && salden(wR.db) === '[]',
      `LEDGER ${was}: jedes Konto steht auf null — keine Lagerwirkung, keine Schuld, keine Forderung, kein Umsatz (vorher INVENTORY −${payout} / COGS +${payout}) (${S(kt)})`);
  } else {
    const lot = row(wR.db, "SELECT unit_cost, qty_remaining, status FROM stock_lots WHERE product_id = ? AND purchase_id IS NULL", [wR.pid]);
    ok(prod.stock_status === 'in_stock' && prod.source_type === 'OWN' && Number(prod.quantity) === 1 && Number(prod.purchase_price) === payout
      && Number(lot.unit_cost) === payout && lot.status === 'ACTIVE' && s(wR.db, 'SELECT status FROM purchases') === 'UNPAID',
    `RETURN ${was}: eigene Ware zum Einstand = Auszahlung (${payout}), ein aktives Los, der Einkauf bleibt offen (${S([prod, lot])})`);
    ok(S(kt) === S({ ACCOUNTS_PAYABLE: -payout, INVENTORY: payout }),
      `LEDGER ${was}: Bestand ${payout} steht dem Los gegenüber, die Schuld an den Einlieferer bleibt — sonst null (vorher Bestand 0, COGS ${payout}) (${S(kt)})`);
  }
  if (o.bezahlt) {
    ok(Number(ret.refund_paid_amount) === 1200 && ret.refund_status === 'REFUNDED' && Number(cn.cash_refund_amount) === 1200,
      `RETURN ${was}: die Barerstattung steht jetzt auch an der Retoure (refund_paid_amount ${String(ret.refund_paid_amount)})`);
  }
  ok(balanced(wP.db) && balanced(wR.db), `LEDGER ${was}: jede Buchung gleicht sich aus (Primary und PC2)`);
  const aP = row(wP.db, "SELECT changed_by FROM audit_log WHERE field_name = 'return_after_sale'");
  const aR = row(wR.db, "SELECT changed_by, branch_id, new_value FROM audit_log WHERE field_name = 'return_after_sale'");
  ok(aP.changed_by === 'user-test' && aR.changed_by === 'user-pc2' && aR.branch_id === 'branch-main'
    && s(wP.db, 'SELECT created_by FROM sales_returns') === 'user-test' && s(wR.db, 'SELECT created_by FROM sales_returns') === 'user-pc2',
  `ACTOR ${was}: Protokoll und Retoure nennen lokal die Sitzung, fern den Absender (${S([aP.changed_by, aR.changed_by])})`);
  if (input.reason) ok(/"reason":"Kunde will nicht mehr"/.test(String(aR.new_value)) && ret.reason === 'Kunde will nicht mehr', `RETURN ${was}: der Grund (getrimmt) steht an Retoure und Protokoll`);
  ok(r.value.status === 'returned' && r.value.disposition === input.disposition && String(r.value.returnNumber) === String(ret.return_number)
    && Number(r.value.revision) === crev(wR.db, wR.cid), `RESULT ${was}: Status, Weg, Retourennummer, neue Fassung (${S(r.value).slice(0, 200)})`);
}
// Der Store-Anschluss ist dieselbe Folge (programmatische Aufrufer): dasselbe Bild wie die Maske.
{
  const wA = await welt();
  const wB = await welt();
  nimm(wA.db);
  const a = await primary(() => useConsignmentStore.getState().markReturnedAfterSale(wA.cid, 'RETURN_TO_OWNER'));
  const b = await rueckgabe('primary', wB, { disposition: 'RETURN_TO_OWNER' });
  const d = diffAll(bild(wA.db, wA.cid), bild(wB.db, wB.cid));
  ok(a.ok && b.ok && d.length === 0, `ONE Store-Aktion und Maske ergeben dasselbe Bild (${d.join(' · ') || 'gleich'})`);
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_RETURN_PARITY_PROVED');

// ══ §3 — Rückgabe: Wiederholung, Fassung, Zustände, Altweg ════════════════════
{
  const w = await welt();
  const x = nx();
  const body = rules.consignmentReturnAfterSaleBody(w.cid, crev(w.db, w.cid), { disposition: 'RETURN_TO_OWNER' });
  const a = await fern(() => cl.runReturnAfterSale(deps(w.db), identity(x, OP_R), body));
  const nachA = S([lc(w.db), audits(w.db, 'return_after_sale'), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM sales_returns'), n(w.db, 'SELECT COUNT(*) FROM credit_notes')]);
  const b = await fern(() => cl.runReturnAfterSale(deps(w.db), identity(x, OP_R), body));
  ok(a.ok && b.ok && b.replayed && S(b.value.revision) === S(a.value.revision), 'LOST dieselbe Kennung: die eingefrorene Antwort, kein zweiter Lauf');
  ok(S([lc(w.db), audits(w.db, 'return_after_sale'), changelog(w.db), n(w.db, 'SELECT COUNT(*) FROM sales_returns'), n(w.db, 'SELECT COUNT(*) FROM credit_notes')]) === nachA,
    'LOST …genau eine Wirkung: Buchungen, Protokoll, Abgleich, Retouren, Gutschriften unverändert');
  const again = await fern(() => cl.runReturnAfterSale(deps(w.db), identity(nx(), OP_R), rules.consignmentReturnAfterSaleBody(w.cid, crev(w.db, w.cid), { disposition: 'RETURN_TO_OWNER' })));
  const againP = await rueckgabe('primary', w, { disposition: 'KEEP_AS_OWN' });
  ok(again.code === 'CONSIGNMENT_ALREADY_RETURNED' && again.frozen && againP.code === 'CONSIGNMENT_ALREADY_RETURNED' && S([lc(w.db), n(w.db, 'SELECT COUNT(*) FROM sales_returns')]) === S([JSON.parse(nachA)[0], 1]),
    `ALREADY eine zweite Absicht: dasselbe Nein auf beiden Wegen — vorher ein stilles Nichts (${again.code} / ${againP.code})`);
  // Alte Fassung
  const w2 = await welt();
  const vor2 = stand(w2);
  const stale = await fern(() => cl.runReturnAfterSale(deps(w2.db), identity(nx(), OP_R), { ...rules.consignmentReturnAfterSaleBody(w2.cid, crev(w2.db, w2.cid), { disposition: 'KEEP_AS_OWN' }), expectedRevision: crev(w2.db, w2.cid) + 1 }));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && stand(w2) === vor2, `STALE eine andere Fassung als die gesehene: RECORD_CHANGED, nichts geschrieben (${stale.code})`);
  // Nicht verkauft
  const w3 = await welt({ sale: null });
  const vor3 = stand(w3);
  const nichtF = await rueckgabe('fern', w3, { disposition: 'RETURN_TO_OWNER' });
  const nichtP = await rueckgabe('primary', w3, { disposition: 'RETURN_TO_OWNER' });
  ok(nichtF.code === 'CONSIGNMENT_NOT_SOLD' && nichtP.code === 'CONSIGNMENT_NOT_SOLD' && stand(w3) === vor3,
    `STATE eine unverkaufte Kommission kommt nicht „nach dem Verkauf" zurück (${nichtF.code} / ${nichtP.code})`);
  // Die Ware kam schon über eine gewöhnliche Retoure zurück.
  const w4 = await welt();
  const line = s(w4.db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [w4.invId]);
  const gen = await primary(() => returnHouse.createReturnOnPrimary({ invoiceId: w4.invId, lines: [{ invoiceLineId: line, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false }));
  const vor4 = stand(w4);
  const doppelt = await rueckgabe('fern', w4, { disposition: 'RETURN_TO_OWNER' });
  ok(gen.ok && doppelt.code === 'CONSIGNMENT_ALREADY_RETURNED' && stand(w4) === vor4,
    `STATE die Ware ist über eine gewöhnliche Retoure schon zurück: kein zweites Mal (${doppelt.code})`);
  // Altweg ohne Rechnung: die schlichte Rückgabe, wie bisher.
  const w5 = await welt({ alt: true });
  const lcAlt = lc(w5.db);
  const alt = await rueckgabe('fern', w5, { disposition: 'RETURN_TO_OWNER' });
  const k5 = row(w5.db, 'SELECT status, payout_status FROM consignments WHERE id = ?', [w5.cid]);
  ok(alt.ok && alt.value.withoutInvoice === true && k5.status === 'returned' && k5.payout_status === 'returned'
    && s(w5.db, 'SELECT stock_status FROM products WHERE id = ?', [w5.pid]) === 'returned'
    && n(w5.db, 'SELECT COUNT(*) FROM sales_returns') === 0 && lc(w5.db) === lcAlt && audits(w5.db, 'return_after_sale') === 1,
  `LEGACY ein Verkauf ohne Rechnung: die schlichte Rückgabe wie bisher — keine Retoure, keine Buchung, ein Protokoll (${S(k5)})`);
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_RETURN_REPLAY_PROVED');

// ══ §4 — Rückgabe: Fehlerinjektion → vollständiger Rollback ══════════════════
{
  const PUNKTE: Array<[string, (sql: string, p?: unknown[]) => boolean, RI]> = [
    ['eine Buchung (Gutschrift/Wareneinsatz)', (q) => /INSERT INTO ledger_entries/.test(q), { disposition: 'RETURN_TO_OWNER' }],
    ['der Einkaufsstorno nach der Retoure', (q) => /UPDATE purchases SET status = 'CANCELLED'/.test(q), { disposition: 'RETURN_TO_OWNER' }],
    ['das Los des Einstands („Keep")', (q) => /UPDATE stock_lots SET unit_cost = \?/.test(q), { disposition: 'KEEP_AS_OWN' }],
    ['der Status der Kommission', (q) => /UPDATE consignments SET status = 'returned'/.test(q), { disposition: 'RETURN_TO_OWNER' }],
    ['das Protokoll (vor dem Commit)', (q, p) => /INSERT INTO audit_log/.test(q) && p?.[6] === 'return_after_sale', { disposition: 'KEEP_AS_OWN' }],
  ];
  for (const [wo, when, input] of PUNKTE) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = await welt();
      const vor = stand(w);
      const { db: bad, f } = faulty(w.db, when);
      setTestDatabase(bad as never);
      const x = nx();
      let aus: Ausgang;
      try { aus = await rueckgabe(weg, w, input, x, {}, bad); }
      finally { setTestDatabase(w.db as never); }
      reload();
      ok(f.fired && !aus.ok && stand(w) === vor, `ATOMIC RETURN ${weg} — ${wo} scheitert: nichts bleibt halb stehen (${aus.code.slice(0, 60)})`);
      if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, OP_R)).kind === 'fresh', `ATOMIC RETURN fern — ${wo}: die Kennung bleibt frei`);
      const heil = await rueckgabe(weg, w, input, x);
      ok(heil.ok && s(w.db, 'SELECT status FROM consignments WHERE id = ?', [w.cid]) === 'returned' && n(w.db, 'SELECT COUNT(*) FROM sales_returns') === 1,
        `ATOMIC RETURN ${weg} — ${wo}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
    }
  }
  const h = codeOf(src('src/core/consignment/consignment-reversal-house.ts'));
  ok(!/beginLedgerTransaction|commitLedgerTransaction|rollbackLedgerTransaction|saveDatabaseDurably|saveDatabase\(|'BEGIN'|'ROLLBACK'|'COMMIT'/.test(h),
    'ATOMIC die Hausfolge öffnet, schließt, speichert und rollt nie selbst zurück (die äußere Klammer entscheidet)');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_RETURN_ATOMIC_PROVED');

// ══ §5 — Rückgabe: Autorität und Rumpf ═══════════════════════════════════════
{
  const w = await welt();
  const vor = stand(w);
  const rumpf = rules.consignmentReturnAfterSaleBody(w.cid, crev(w.db, w.cid), { disposition: 'RETURN_TO_OWNER' });
  const ausweis = await fern(() => cl.runReturnAfterSale(deps(w.db), identity(nx(), OP_R, { branchId: 'branch-other' }), rumpf));
  ok(ausweis.code === 'BRANCH_MISMATCH' && ausweis.frozen, `AUTH ein Ausweis einer fremden Filiale schreibt nicht in diese Bücher (${ausweis.code})`);
  insert(w.db, 'products', { id: 'p-x', branch_id: 'branch-other', category_id: 'cat-x', brand: 'X', name: 'X', stock_status: 'consignment', source_type: 'CONSIGNMENT', created_at: NOW, updated_at: NOW });
  insert(w.db, 'consignments', { id: 'con-x', branch_id: 'branch-other', consignment_number: 'CON-X', consignor_id: 'cust-x', product_id: 'p-x', agreed_price: 1, status: 'sold', created_at: NOW, updated_at: NOW });
  const fremdF = await fern(() => cl.runReturnAfterSale(deps(w.db), identity(nx(), OP_R), { consignmentId: 'con-x', expectedRevision: crev(w.db, 'con-x') || 1, disposition: 'RETURN_TO_OWNER' }));
  const fremdP = await primary(() => conHouse.returnConsignmentAfterSaleOnPrimary('con-x', { disposition: 'RETURN_TO_OWNER' }));
  ok(fremdF.code === 'CONSIGNMENT_NOT_FOUND' && fremdP.code === 'CONSIGNMENT_NOT_FOUND', `AUTH eine Kommission einer fremden Filiale gibt es hier nicht (${fremdF.code} / ${fremdP.code})`);
  w.db.run("DELETE FROM consignments WHERE id = 'con-x'");
  w.db.run("DELETE FROM products WHERE id = 'p-x'");
  for (const [k, v] of [['status', 'returned'], ['invoiceId', w.invId], ['invoiceLineId', 'l'], ['lines', []], ['quantity', 1], ['unitPrice', 1],
    ['totalAmount', 1], ['vatAmount', 0], ['refundAmount', 1], ['cashRefundAmount', 1], ['receivableCancelAmount', 0], ['creditNoteId', 'c'],
    ['returnId', 'r'], ['returnNumber', 'RET-1'], ['purchaseId', 'p'], ['expenseId', 'e'], ['costBasis', 1], ['purchasePrice', 1],
    ['payoutAmount', 1], ['salePrice', 1], ['productId', 'p'], ['stockStatus', 'in_stock'], ['notes', 'x'],
    ['account', 'CASH'], ['debit', 1], ['amount', 1], ['branchId', 'branch-other'], ['revision', 9], ['id', 'x'], ['createdAt', NOW]] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => cl.parseReturnAfterSale({ ...rumpf, [k]: v }))), `PAYLOAD return: ${k} bestimmt der Primary`);
  }
  for (const k of ['userId', 'createdBy', 'created_by', 'actor', 'role', 'changedBy']) {
    ok(/the primary decides/.test(meldung(() => cl.parseReturnAfterSale({ ...rumpf, [k]: 'user-owner' }))), `SPOOF return: ${k} kommt nie aus dem Rumpf`);
  }
  ok(/unknown field/.test(meldung(() => cl.parseReturnAfterSale({ ...rumpf, foo: 1 }))), 'PAYLOAD return: ein unbekanntes Feld wird abgewiesen');
  ok(/expectedRevision is required/.test(meldung(() => cl.parseReturnAfterSale({ consignmentId: w.cid, disposition: 'KEEP_AS_OWN' }))), 'PAYLOAD return: ohne gesehene Fassung kein Auftrag');
  ok(/disposition is one of/.test(meldung(() => cl.parseReturnAfterSale({ ...rumpf, disposition: 'IN_STOCK' }))), 'PAYLOAD return: nur die zwei Wege des Dialogs');
  ok(/refundMethod is one of/.test(meldung(() => cl.parseReturnAfterSale({ ...rumpf, refundMethod: 'bitcoin' }))), 'PAYLOAD return: nur die Erstattungswege der Retourenmaske');
  ok(wirft(() => imHaus(() => revHouse.returnConsignmentAfterSaleInHouse(w.cid, { disposition: 'IN_STOCK' as never }, 'branch-main'))) === 'INVALID_INPUT',
    'PAYLOAD return: die Hausfolge prüft dieselben Werte (INVALID_INPUT)');
  ok(stand(w) === vor, 'AUTH …nach all dem: nichts geschrieben');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_RETURN_AUTHORITY_PROVED');
marker('CENTRAL_UI_R6F_CONSIGNMENT_RETURN_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// „Cancel Sale" — der Stand VOR dem Verkauf ist das Ziel.
// ════════════════════════════════════════════════════════════════════════════
function nachStorno(w: Welt, was: string, auch: { erlaubt?: string[] } = {}): void {
  const nach = zustand(w.db, w.cid);
  const d = diffAll(w.vor as unknown as Record<string, unknown>, nach as unknown as Record<string, unknown>)
    .filter((x) => !(auch.erlaubt ?? []).some((e) => x.startsWith(e)));
  ok(d.length === 0, `STATE ${was}: Kommission, Artikel, Bestand, Guthaben und Salden je Konto/Gegenpartei == vor dem Verkauf (${d.join(' · ') || 'gleich'})`);
  ok(Object.keys(konten(w.db)).length === 0, `LEDGER ${was}: Einlieferer, Käufer, Lager, Umsatz, Kasse — jedes Konto auf null (${S(konten(w.db))})`);
  ok(balanced(w.db), `LEDGER ${was}: jede Buchung gleicht sich aus`);
  if (w.invId) {
    ok(s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId]) === 'CANCELLED' && n(w.db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [w.invId]) === 1,
      `NO-DELETE ${was}: die Käuferrechnung bleibt mit Nummer und Zeile als CANCELLED stehen`);
  }
  ok(n(w.db, "SELECT COUNT(*) FROM credit_notes WHERE status != 'CANCELLED'") === 0 && n(w.db, "SELECT COUNT(*) FROM sales_returns WHERE status != 'REJECTED'") === 0,
    `NO-DELETE ${was}: keine wirksame Gutschrift, keine wirksame Retoure mehr`);
  ok(n(w.db, "SELECT COUNT(*) FROM purchases WHERE status != 'CANCELLED'") === 0 && n(w.db, "SELECT COUNT(*) FROM expenses WHERE status != 'CANCELLED'") === 0,
    `STATE ${was}: Auto-Einkauf und Verlust-Ausgabe CANCELLED (stehen als Historie)`);
}

// ══ §6 — Storno: Primary == PC2 und exakt der Stand vor dem Verkauf ═══════════
{
  const wP = await welt();
  const wR = await welt();
  const lcVor = lc(wR.db);
  const p = await storno('primary', wP);
  const r = await storno('fern', wR);
  ok(p.ok && r.ok, `CANCEL beide Wege nehmen den Verkauf zurück (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const d = diffAll(bild(wP.db, wP.cid), bild(wR.db, wR.cid));
  ok(d.length === 0, `PARITY lokal == fern: Kommission, Artikel, Lose, Rechnung, Einkauf, Ausgaben, Buchungen, Salden (${d.join(' · ') || 'gleich'})`);
  nachStorno(wP, 'Primary');
  nachStorno(wR, 'PC2');
  ok(lc(wR.db) > lcVor && n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND reverses_entry_id IS NOT NULL") > 0
    && n(wR.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND reverses_entry_id IS NOT NULL") > 0,
  'LEDGER es wurde storniert, nicht gelöscht: Umkehrzeilen für Rechnung und Einkauf');
  const aP = row(wP.db, "SELECT changed_by FROM audit_log WHERE field_name = 'cancel_sale'");
  const aR = row(wR.db, "SELECT changed_by, branch_id, new_value FROM audit_log WHERE field_name = 'cancel_sale'");
  ok(aP.changed_by === 'user-test' && aR.changed_by === 'user-pc2' && aR.branch_id === 'branch-main' && /"invoiceStatus":"CANCELLED"/.test(String(aR.new_value)),
    `AUDIT das Protokoll nennt lokal die Sitzung, fern den Absender — atomar mit der Wirkung (${S([aP.changed_by, aR.changed_by])})`);
  ok(r.value.status === 'active' && r.value.invoiceStatus === 'CANCELLED' && r.value.invoiceReversed === true && Number(r.value.cancelledPurchases) === 1
    && Number(r.value.revision) === crev(wR.db, wR.cid), `RESULT Status, Rechnungsstatus, Einkauf, neue Fassung (${S(r.value).slice(0, 220)})`);
  // Und wieder verkaufen: der zurückgenommene Verkauf hinterlässt keinen Rest, der den nächsten stört.
  const nochmal = await primary(() => conHouse.recordConsignmentSaleOnPrimary(wR.cid, SALE));
  ok(nochmal.ok && s(wR.db, 'SELECT status FROM consignments WHERE id = ?', [wR.cid]) === 'sold' && balanced(wR.db),
    `CYCLE nach dem Storno lässt sich dieselbe Kommission wieder verkaufen (${nochmal.code || 'ok'})`);
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_PARITY_PROVED');

// ══ §7 — Storno: weitere Welten, jede zurück auf den Stand vor dem Verkauf ═══
{
  const WELTEN: Array<[string, Parameters<typeof welt>[0], RI | null, string[]]> = [
    ['beide Seiten bezahlt (Käufer bar, Einlieferer bar)', { bezahlt: 1200, einlieferer: 960 }, null, []],
    ['nach „Return to Owner" (cleanup)', {}, { disposition: 'RETURN_TO_OWNER' }, []],
    // Befund (bekannt, R6E `revertDisposition`): der Einstand, den „Keep" setzte, bleibt am Artikel.
    ['nach „Keep" (cleanup)', {}, { disposition: 'KEEP_AS_OWN' }, ['produkt.purchase_price']],
    ['Unterdeckung mit Verlust-Ausgabe', { body: FIXED, sale: SHORT }, null, []],
    ['Altweg ausbezahlt, ohne Rechnung', { alt: true }, null, []],
    ['VAT_10-Ware', { vat10: true }, null, []],
  ];
  for (const [was, o, vorab, erlaubt] of WELTEN) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = await welt(o);
      if (vorab) {
        const r0 = await rueckgabe('primary', w, vorab);
        if (!r0.ok) { ok(false, `SETUP ${was}: ${r0.code}`); continue; }
      }
      const gutschriften = n(w.db, 'SELECT COUNT(*) FROM credit_notes');
      const aus = await storno(weg, w);
      ok(aus.ok, `CANCEL ${was} (${weg}) gelingt (${aus.code || 'ok'})`);
      nachStorno(w, `${was} (${weg})`, { erlaubt });
      ok(n(w.db, 'SELECT COUNT(*) FROM credit_notes') === gutschriften,
        `NO-DELETE ${was} (${weg}): keine Gutschrift gelöscht (${gutschriften} → ${n(w.db, 'SELECT COUNT(*) FROM credit_notes')})`);
      if (vorab) {
        ok(s(w.db, 'SELECT status FROM sales_returns') === 'REJECTED' && s(w.db, 'SELECT status FROM credit_notes') === 'CANCELLED'
          && n(w.db, 'SELECT COUNT(*) FROM sales_return_lines') === 1,
        `NO-DELETE ${was} (${weg}): die Rückgabe bleibt als REJECTED, ihre Gutschrift als CANCELLED stehen (vorher hart gelöscht)`);
      }
      if (vorab?.disposition === 'KEEP_AS_OWN') {
        ok(n(w.db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED' AND qty_remaining > 0", [w.pid]) === 0,
          `STOCK ${was} (${weg}): das „Keep"-Los ist storniert — kein Bestand ohne Einkauf (vorher blieb es aktiv)`);
      }
    }
  }
  // Die Rechnung wurde vorher schon über „Cancel Invoice" storniert: sie wird nicht ein zweites Mal angefasst.
  for (const weg of ['primary', 'fern'] as const) {
    const w = await welt();
    const c = await primary(() => invoiceCancelHouse.cancelInvoiceOnPrimary({ invoiceId: w.invId, refundMethod: 'cash' }));
    const umkehr = n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND reverses_entry_id IS NOT NULL");
    const aus = await storno(weg, w);
    ok(c.ok && aus.ok && aus.value.invoiceReversed !== true
      && n(w.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND reverses_entry_id IS NOT NULL") === umkehr,
    `CANCEL Rechnung schon storniert (${weg}): kein zweiter Rechnungsstorno (${aus.code || 'ok'})`);
    nachStorno(w, `nach „Cancel Invoice" (${weg})`);
  }
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_STATE_PROVED');

// ══ §8 — Storno: Wiederholung, Fassung, Sperren, Autorität ════════════════════
{
  // Verlorene Antwort
  const w = await welt();
  const x = nx();
  const body = rules.consignmentCancelSaleBody(w.cid, crev(w.db, w.cid));
  const a = await fern(() => cl.runCancelSale(deps(w.db), identity(x, OP_C), body));
  const nachA = S([lc(w.db), audits(w.db, 'cancel_sale'), changelog(w.db), zustand(w.db, w.cid)]);
  const b = await fern(() => cl.runCancelSale(deps(w.db), identity(x, OP_C), body));
  ok(a.ok && b.ok && b.replayed && S(b.value.revision) === S(a.value.revision) && S(b.value.invoiceId) === S(a.value.invoiceId),
    'LOST dieselbe Kennung: die eingefrorene Antwort, kein zweiter Lauf');
  ok(S([lc(w.db), audits(w.db, 'cancel_sale'), changelog(w.db), zustand(w.db, w.cid)]) === nachA, 'LOST …genau eine Wirkung');
  // Eine neue Absicht auf die zurückgenommene Kommission
  const neu = await fern(() => cl.runCancelSale(deps(w.db), identity(nx(), OP_C), rules.consignmentCancelSaleBody(w.cid, crev(w.db, w.cid))));
  const neuP = await storno('primary', w);
  ok(neu.code === 'CONSIGNMENT_SALE_NOT_CANCELLABLE' && neu.frozen && neuP.code === 'CONSIGNMENT_SALE_NOT_CANCELLABLE' && S([lc(w.db), audits(w.db, 'cancel_sale')]) === S([JSON.parse(nachA)[0], 1]),
    `ALREADY eine aktive Kommission hat keinen Verkauf mehr (${neu.code} / ${neuP.code})`);
  // Alte Fassung
  const w2 = await welt();
  const vor2 = stand(w2);
  const stale = await fern(() => cl.runCancelSale(deps(w2.db), identity(nx(), OP_C), { consignmentId: w2.cid, expectedRevision: crev(w2.db, w2.cid) + 1 }));
  ok(stale.code === 'RECORD_CHANGED' && stale.frozen && stand(w2) === vor2, `STALE eine andere Fassung: RECORD_CHANGED, nichts geschrieben (${stale.code})`);
  // Unverkauft / verkauft OHNE Rechnung (die Maske bietet dort kein „Cancel Sale")
  const w3 = await welt({ sale: null });
  const vor3 = stand(w3);
  ok((await storno('fern', w3)).code === 'CONSIGNMENT_SALE_NOT_CANCELLABLE' && (await storno('primary', w3)).code === 'CONSIGNMENT_SALE_NOT_CANCELLABLE' && stand(w3) === vor3,
    'STATE eine unverkaufte Kommission: nichts zu stornieren');
  const w3b = await welt({ sale: null });
  useConsignmentStore.getState().loadConsignments();
  useConsignmentStore.getState().markSold(w3b.cid, 1200, undefined, 'cash');
  const vor3b = stand(w3b);
  ok((await storno('fern', w3b)).code === 'CONSIGNMENT_SALE_NOT_CANCELLABLE' && stand(w3b) === vor3b,
    'STATE verkauft ohne Rechnung und nicht ausbezahlt: dieselbe Regel wie die Knöpfe der Maske');
  // Eine fremde Retoure an der Rechnung sperrt — erst sie stornieren.
  const w4 = await welt();
  const line = s(w4.db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [w4.invId]);
  await primary(() => returnHouse.createReturnOnPrimary({ invoiceId: w4.invId, lines: [{ invoiceLineId: line, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false }));
  const vor4 = stand(w4);
  const f4 = await storno('fern', w4);
  const p4 = await storno('primary', w4);
  ok(f4.code === 'CONSIGNMENT_INVOICE_HAS_RETURNS' && f4.frozen && p4.code === 'CONSIGNMENT_INVOICE_HAS_RETURNS' && stand(w4) === vor4,
    `BLOCK eine fremde Retoure an der Rechnung: erst sie stornieren (${f4.code} / ${p4.code})`);
  // Die eigene Rückgabe wurde schon bar erstattet: der Retourenstorno sperrt (echtes Geld ist hinaus).
  const w5 = await welt({ bezahlt: 1200 });
  await rueckgabe('primary', w5, { disposition: 'RETURN_TO_OWNER', refundMethod: 'cash' });
  const vor5 = stand(w5);
  const f5 = await storno('fern', w5);
  const p5 = await storno('primary', w5);
  ok(f5.code === 'RETURN_REFUND_PAID_OUT' && f5.frozen && p5.code === 'RETURN_REFUND_PAID_OUT' && stand(w5) === vor5,
    `BLOCK die Erstattung der Rückgabe ist ausgezahlt — vorher kehrte „cleanup" sie still im Hauptbuch um (${f5.code} / ${p5.code})`);
  // Rolle: die eigene Rückgabe zu stornieren ist Sache des Owners (Regel von „Cancel Return") — am Absender gemessen.
  const w6 = await welt();
  await rueckgabe('primary', w6, { disposition: 'RETURN_TO_OWNER' });
  const vor6 = stand(w6);
  const f6 = await storno('fern', w6, nx(), { role: 'MANAGER' });
  sitzung('MANAGER');
  const p6 = await storno('primary', w6);
  sitzung('ADMIN');
  ok(f6.code === 'RETURN_OWNER_ONLY' && f6.frozen && p6.code === 'RETURN_OWNER_ONLY' && stand(w6) === vor6,
    `AUTH ein Manager storniert keine Rückgabe mit — fern die Rolle des Absenders, lokal die der Sitzung (${f6.code} / ${p6.code})`);
  const w7 = await welt();
  const f7 = await storno('fern', w7, nx(), { role: 'MANAGER' });
  ok(f7.ok, `AUTH ohne Rückgabe darf der Manager (perm.canManageConsignments) den Verkauf stornieren (${f7.code || 'ok'})`);
  // Fremde Filiale
  const w8 = await welt();
  const vor8 = stand(w8);
  const ausweis = await storno('fern', w8, nx(), { branchId: 'branch-other' });
  ok(ausweis.code === 'BRANCH_MISMATCH' && stand(w8) === vor8, `AUTH ein Ausweis einer fremden Filiale: BRANCH_MISMATCH (${ausweis.code})`);
  insert(w8.db, 'products', { id: 'p-x', branch_id: 'branch-other', category_id: 'cat-x', brand: 'X', name: 'X', stock_status: 'consignment', source_type: 'CONSIGNMENT', created_at: NOW, updated_at: NOW });
  insert(w8.db, 'consignments', { id: 'con-x', branch_id: 'branch-other', consignment_number: 'CON-X', consignor_id: 'cust-x', product_id: 'p-x', agreed_price: 1, status: 'paid_out', created_at: NOW, updated_at: NOW });
  const fremd = await fern(() => cl.runCancelSale(deps(w8.db), identity(nx(), OP_C), { consignmentId: 'con-x', expectedRevision: crev(w8.db, 'con-x') || 1 }));
  const fremdP = await primary(() => conHouse.cancelConsignmentSaleOnPrimary('con-x'));
  ok(fremd.code === 'CONSIGNMENT_NOT_FOUND' && fremdP.code === 'CONSIGNMENT_NOT_FOUND', `AUTH eine Kommission einer fremden Filiale gibt es hier nicht (${fremd.code} / ${fremdP.code})`);
  // Was der Primary entscheidet, reist nicht im Rumpf.
  const rumpf = rules.consignmentCancelSaleBody(w8.cid, crev(w8.db, w8.cid));
  for (const [k, v] of [['status', 'active'], ['invoiceId', w8.invId], ['purchaseId', 'p'], ['purchaseIds', []], ['expenseIds', []], ['returnIds', []],
    ['creditNoteIds', []], ['salePrice', 1], ['payoutAmount', 1], ['payoutPaidAmount', 0], ['productId', 'p'], ['stockStatus', 'consignment'],
    ['quantity', 1], ['reason', 'x'], ['account', 'AR'], ['credit', 1], ['amount', 1], ['branchId', 'b'], ['revision', 3], ['id', 'x']] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(meldung(() => cl.parseCancelSale({ ...rumpf, [k]: v }))), `PAYLOAD cancel: ${k} bestimmt der Primary`);
  }
  for (const k of ['userId', 'createdBy', 'created_by', 'actor', 'role', 'changedBy']) {
    ok(/the primary decides/.test(meldung(() => cl.parseCancelSale({ ...rumpf, [k]: 'user-owner' }))), `SPOOF cancel: ${k} kommt nie aus dem Rumpf`);
  }
  ok(/unknown field/.test(meldung(() => cl.parseCancelSale({ ...rumpf, foo: 1 }))), 'PAYLOAD cancel: ein unbekanntes Feld wird abgewiesen');
  ok(/expectedRevision is required/.test(meldung(() => cl.parseCancelSale({ consignmentId: w8.cid }))), 'PAYLOAD cancel: ohne gesehene Fassung kein Auftrag');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_AUTHORITY_PROVED');

// ══ §9 — Storno: Fehlerinjektion an den kritischen Stellen → vollständiger Rollback ══
{
  interface Punkt { wo: string; when: (sql: string, p?: unknown[]) => boolean; beweis: (db: Db, w: Welt) => boolean; beweisText: string }
  const PUNKTE: Punkt[] = [
    { wo: 'nach dem Rechnungsstorno (am Einkauf)', when: (q) => /UPDATE purchases SET status = 'CANCELLED'/.test(q),
      beweis: (db, w) => s(db, 'SELECT status FROM invoices WHERE id = ?', [w.invId]) === 'CANCELLED'
        && n(db, "SELECT COALESCE(SUM(qty_remaining), 0) FROM stock_lots WHERE product_id = ? AND status != 'CANCELLED'", [w.pid]) === 1,
      beweisText: 'Rechnung schon CANCELLED, Los schon zurück' },
    { wo: 'nach der Einlieferer-Seite (am Bestand)', when: (q) => /UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT'/.test(q),
      beweis: (db) => s(db, 'SELECT status FROM purchases') === 'CANCELLED' && s(db, 'SELECT status FROM expenses') !== 'PENDING',
      beweisText: 'Einkauf schon CANCELLED' },
    { wo: 'nach dem Bestand (an der Kommission)', when: (q) => /UPDATE consignments SET\s+status = 'active'/.test(q),
      beweis: (db, w) => s(db, 'SELECT stock_status FROM products WHERE id = ?', [w.pid]) === 'consignment' && n(db, 'SELECT quantity FROM products WHERE id = ?', [w.pid]) === 1,
      beweisText: 'Artikel schon zurück im Kommissionsbestand' },
    { wo: 'vor dem Commit (am Protokoll)', when: (q, p) => /INSERT INTO audit_log/.test(q) && p?.[6] === 'cancel_sale',
      beweis: (db, w) => s(db, 'SELECT status FROM consignments WHERE id = ?', [w.cid]) === 'active',
      beweisText: 'Kommission schon „active"' },
    { wo: 'an einer Stornobuchung', when: (q) => /INSERT INTO ledger_entries/.test(q), beweis: () => true, beweisText: 'Buchung' },
  ];
  for (const pt of PUNKTE) {
    for (const weg of ['primary', 'fern'] as const) {
      const w = await welt({ sale: pt.wo.startsWith('nach der Einlieferer') ? SHORT : SALE, body: pt.wo.startsWith('nach der Einlieferer') ? FIXED : CONSIGN });
      const vor = stand(w);
      let imFehler = false;
      const { db: bad, f } = faulty(w.db, pt.when, () => { imFehler = pt.beweis(w.db, w); });
      setTestDatabase(bad as never);
      const x = nx();
      let aus: Ausgang;
      try { aus = await storno(weg, w, x, {}, bad); }
      finally { setTestDatabase(w.db as never); }
      reload();
      ok(f.fired && imFehler, `ATOMIC CANCEL ${weg} — ${pt.wo}: im Fehler war ${pt.beweisText}`);
      ok(!aus.ok && stand(w) === vor, `ATOMIC CANCEL ${weg} — ${pt.wo}: Rechnung, Retoure, Einkauf, Ausgabe, Lose, Artikel, Kommission, Buchungen, Abgleich, Protokoll unverändert (${aus.code.slice(0, 60)})`);
      if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, OP_C)).kind === 'fresh', `ATOMIC CANCEL fern — ${pt.wo}: die Kennung bleibt frei`);
      const heil = await storno(weg, w, x);
      ok(heil.ok, `ATOMIC CANCEL ${weg} — ${pt.wo}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
      nachStorno(w, `nach der Heilung ${weg} — ${pt.wo}`);
    }
  }
  // Auch mit der eigenen Rückgabe davor: ein Fehler NACH ihrem Storno nimmt auch ihn zurück.
  for (const weg of ['primary', 'fern'] as const) {
    const w = await welt();
    await rueckgabe('primary', w, { disposition: 'KEEP_AS_OWN' });
    const vor = stand(w);
    let imFehler = '';
    const { db: bad } = faulty(w.db, (q) => /UPDATE purchases SET status = 'CANCELLED'/.test(q),
      () => { imFehler = S([s(w.db, 'SELECT status FROM sales_returns'), s(w.db, 'SELECT status FROM credit_notes'), s(w.db, 'SELECT status FROM invoices WHERE id = ?', [w.invId])]); });
    setTestDatabase(bad as never);
    let aus: Ausgang;
    try { aus = await storno(weg, w, nx(), {}, bad); }
    finally { setTestDatabase(w.db as never); }
    reload();
    ok(imFehler === S(['REJECTED', 'CANCELLED', 'CANCELLED']) && !aus.ok && stand(w) === vor,
      `ATOMIC CANCEL ${weg} — nach Retourenstorno und Rechnungsstorno scheitert der Einkauf: alles zurück, Retoure wieder wirksam (${imFehler})`);
  }
  const st = codeOf(src('src/stores/consignmentStore.ts'));
  ok(!/DELETE FROM (credit_notes|sales_returns|sales_return_lines)/.test(st) && !/\bcredit_notes\b/.test(st),
    'NO-DELETE der Store löscht keine Gutschrift und keine Retoure mehr (und liest keine Gutschriften)');
  const h = codeOf(src('src/core/consignment/consignment-reversal-house.ts'));
  ok(!/DELETE FROM/.test(h) && !/\bcredit_notes\b/.test(h), 'NO-DELETE die Hausfolge löscht nichts');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_ROLLBACK_PROVED');

// ══ §10 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const db = freshDb();
  let touched = 0;
  const counting = new Proxy(db as object, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (k === 'run' || k === 'exec') return (...a: unknown[]) => { touched++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  setTestDatabase(counting as never);
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, value: { replayed: false } }), { status: 200 });
  }) as never;
  try {
    const a = await primary(() => conHouse.returnConsignmentAfterSaleOnPrimary('c1', { disposition: 'RETURN_TO_OWNER' }));
    const b = await primary(() => conHouse.cancelConsignmentSaleOnPrimary('c1'));
    const c = wirft(() => revHouse.returnConsignmentAfterSaleInHouse('c1', { disposition: 'RETURN_TO_OWNER' }, 'branch-main'));
    const d = wirft(() => revHouse.cancelConsignmentSaleInHouse('c1', { userId: 'u', role: 'ADMIN' }, 'branch-main'));
    const e = wirft(() => useConsignmentStore.getState().cancelSale('c1'));
    ok(a.code === 'CONSIGNMENT_PRIMARY_ONLY' && b.code === 'CONSIGNMENT_PRIMARY_ONLY' && c === 'CONSIGNMENT_PRIMARY_ONLY' && d === 'CONSIGNMENT_PRIMARY_ONLY'
      && e === 'CLIENT_HAS_NO_BOOKS' && touched === 0,
    `CLIENT jeder Primary-Anschluss verweigert, bevor er eine Datenbank anfasst (${S([a.code, b.code, c, d, e])}, Zugriffe ${touched})`);
    const write = (op: string) => new CommandSaveController<Record<string, unknown>>(op).beginAttempt();
    const input: RI = { disposition: 'KEEP_AS_OWN', refundMethod: 'bank', reason: 'x' };
    const r1 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => rules.consignmentReturnAfterSaleBody('c-pc2', 4, input) }, write(OP_R));
    const r2 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => rules.consignmentCancelSaleBody('c-pc2', 5) }, write(OP_C));
    const sent1 = calls.find((x) => x.body.op === OP_R);
    const sent2 = calls.find((x) => x.body.op === OP_C);
    ok(r1.kind === 'ok' && r2.kind === 'ok' && !!sent1 && !!sent2
      && S(Object.keys(sent1.body.payload as object).sort()) === S(['consignmentId', 'disposition', 'expectedRevision', 'reason', 'refundMethod'])
      && S(Object.keys(sent2.body.payload as object).sort()) === S(['consignmentId', 'expectedRevision']) && touched === 0,
    `CLIENT je EIN geprüfter Auftrag mit der gesehenen Fassung — nur die Wahl des Dialogs, keine lokale Wirkung (${S(sent1?.body.payload)} · ${S(sent2?.body.payload)})`);
    ok(S(Object.keys(rules.consignmentReturnAfterSaleBody('c', 1, { disposition: 'RETURN_TO_OWNER' })).sort()) === S(['consignmentId', 'disposition', 'expectedRevision']),
      'CLIENT ohne Geld und ohne Grund: nur Kommission, Fassung, Warenweg');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_CLIENT_PROVED');

// ══ §11 — Oberfläche und Quelle: jede Maske ein Anschluss, EINE Folge ════════
{
  const ui = codeOf(src('src/pages/consignments/ConsignmentDetail.tsx'));
  ok(/w\.ok\('consignments\.return_after_sale'/.test(ui) && /returnConsignmentAfterSaleOnPrimary\(/.test(ui) && /consignmentReturnAfterSaleBody\(/.test(ui),
    'UI „Post-Sale Return" über die gemeinsame Weiche — Primary-Anschluss und Fernrumpf aus der geteilten Domäne');
  ok(/w\.ok\('consignments\.cancel_sale'/.test(ui) && /cancelConsignmentSaleOnPrimary\(/.test(ui) && /consignmentCancelSaleBody\(/.test(ui),
    'UI „Cancel Sale" über die gemeinsame Weiche');
  ok(!/\bcancelSale\(|\bmarkReturnedAfterSale\(/.test(ui) && !/Cancel Sale failed/.test(ui), 'UI die Store-Aktionen werden nicht mehr direkt gerufen, kein lokaler try/alert-Pfad');
  for (const attr of ['data-consignment-return-after-sale', 'data-consignment-return-after-sale-confirm', 'data-consignment-return-disposition',
    'data-consignment-return-refund-method', 'data-consignment-return-reason', 'data-consignment-cancel-sale', 'data-consignment-cancel-sale-confirm']) {
    ok(ui.includes(attr), `UI ${attr}`);
  }
  ok(/onClick=\{\(\) => void handlePostSaleReturn\(\)\} disabled=\{w\.busy\}/.test(ui) && /onClick=\{\(\) => void handleCancelSale\(\)\} disabled=\{w\.busy\}/.test(ui),
    'UI beide Bestätigungen während des Laufs gesperrt');
  ok(!/NOT auto-refunded/.test(ui) && !/stay booked/.test(ui) && (ui.match(/reversed in the books/g) ?? []).length >= 3,
    'UI die Rückfrage sagt, was gebucht wird: Zahlungen werden im Hauptbuch umgekehrt (vorher „NOT auto-refunded" / „stay booked")');
  const st = codeOf(src('src/stores/consignmentStore.ts'));
  const cStart = st.indexOf('cancelSale: (id) =>');
  const rStart = st.indexOf('markReturnedAfterSale: (id, disposition) =>');
  const cancelBody = st.slice(cStart, st.indexOf('markPaidOut:', cStart));
  const returnBody = st.slice(rStart, st.indexOf('deleteConsignment:', rStart));
  ok(/atomar\(\(\) => cancelConsignmentSaleInHouse\(/.test(cancelBody) && !/db\.run|updateInvoice|cancelPurchase/.test(cancelBody),
    'ONE der Store-Storno ist nur noch der Anschluss an die Hausfolge');
  ok(/atomar\(\(\) => returnConsignmentAfterSaleInHouse\(/.test(returnBody) && !/db\.run|INSERT INTO|postCreditNote/.test(returnBody),
    'ONE die Store-Rückgabe ist nur noch der Anschluss an die Hausfolge');
  const h = codeOf(src('src/core/consignment/consignment-reversal-house.ts'));
  ok(/createReturnInHouse\(/.test(h) && /cancelReturnInHouse\(/.test(h) && /reverseInvoiceInHouse\(/.test(h) && /cancelPurchaseInHouse\(/.test(h)
    && !/\.createReturn\(|\.approveReturn\(|\.refundReturn\(|updateInvoice\(|postCreditNote|returnLineAmounts/.test(h),
  'DOMAIN keine zweite Retouren-, Gutschrift- oder Rechnungslogik — die Hausfolge ruft die vorhandenen Folgen');
  ok(!/stores\/consignmentStore/.test(h), 'DOMAIN die Hausfolge importiert den Kommissions-Store nicht (er ruft sie — kein Kreis)');
  const cmdSrc = codeOf(src('src/core/bridge/consignment-lifecycle-commands.ts'));
  ok(/returnConsignmentAfterSaleInHouse\(/.test(cmdSrc) && /cancelConsignmentSaleInHouse\(/.test(cmdSrc) && !/\.markReturnedAfterSale\(|\.cancelSale\(/.test(cmdSrc)
    && /assertHouseBranch\(identity\)/.test(cmdSrc), 'DOMAIN der Fernbefehl ruft dieselbe Folge — nie die Store-Aktion');
}
marker('CENTRAL_UI_R6F_CONSIGNMENT_UI_PROVED');
marker('CENTRAL_UI_R6F_CONSIGNMENT_CANCEL_SALE_ATOMIC_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6f consignment after the sale: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

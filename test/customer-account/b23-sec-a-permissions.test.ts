// B2/B3 SICHERHEIT A — Harness übernommen aus test/r6d/payables-parity.test.ts.
/* eslint-disable @typescript-eslint/no-unused-vars -- Harness aus test/r6d/payables-parity übernommen (nicht jeder Helfer wird hier gebraucht). */
// CENTRAL-UI-PARITY R6D — Verbindlichkeiten (Domäne B): Ausgaben, Daueraufträge, Einkaufszahlungen,
// Lieferanten-Guthaben und Sammelzahlung. EINE Hausfolge für Primary und PC2.
// Run: node test/r6d/payables-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge (`core/payables/payables-house.ts`), die echten Fernbefehle
// (`payables-commands.ts`), die echte C3A-Maschine mit durablem Nachweis, das echte Schema samt
// Migrationen und die echten Buchungsfunktionen. Gestellt sind nur das Speichern und das Netz.
//
//   §1 Umfang      §2 expenses.create      §3 expenses.update      §4 expenses.record_payment
//   §5 template_create      §6 template_update (Resume ohne Nachholen)      §7 purchases.record_payment
//   §8 purchases.apply_credit      §9 suppliers.refund_credit      §10 suppliers.pay
//   §11 suppliers.apply_credit      §12 suppliers.credits.get      §13 Primary-Maske (runOnPrimary)
//   §14 Client ohne Bücher      §15 Oberfläche
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/commercial-commands.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const house = await import('../../src/core/payables/payables-house.ts');
const cmds = await import('../../src/core/bridge/payables-commands.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const save = await import('../../src/core/payables/payables-save.ts');
const { useExpenseStore } = await import('../../src/stores/expenseStore.ts');
const { useRecurringExpenseStore } = await import('../../src/stores/recurringExpenseStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { supplierCreditsFor } = await import('../../src/stores/supplierStore.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
let sectionFails = 0;
const marker = (m: string): void => { if (fails.length === sectionFails) console.log(m); sectionFails = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
const at = (iso: string) => ({ ...CTX, now: iso });

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile mit allen NOT-NULL-Spalten, damit ein Test nicht an einer Schema-Kleinigkeit scheitert. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    const t = String(c.type || '').toUpperCase();
    data[name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}

let current: Db;
function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-2', 'branch-main'], ['sup-x', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)', [id, branch, 'Lieferant ' + id, NOW, NOW]);
  }
  for (const [id, branch] of [['emp-1', 'branch-main'], ['emp-x', 'branch-other']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: 'active', created_at: NOW, updated_at: NOW });
  }
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  current = db;
  return db;
}

/** Scheitert beim n-ten passenden Schreibvorgang — die Fehlerinjektion der Tests (vgl. r6c/inventory). */
function failOn(db: Db, pattern: RegExp, nth = 1): { db: Db; state: { armed: boolean } } {
  let seen = 0;
  const state = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (state.armed && pattern.test(sql) && ++seen === nth) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  setTestDatabase(proxy as never);
  return { db: proxy, state };
}
const unfail = (): void => { setTestDatabase(current as never); };

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});
/** Die Hausfolge liest `getDatabase()` — Tests mit mehreren Datenbanken zeigen vor Handlungen am Primary darauf. */
const nimm = (db: Db): Db => { setTestDatabase(db as never); current = db; return db; };
function deps(db: Db) {
  return {
    db: db as never,
    // Jede Klammer eines Auftrags zeigt auf SEINE Datenbank (auch die Klammer, die ein Nein einfriert).
    begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
type Fern = { kind: 'ok' | 'rejected' | 'thrown'; value: Record<string, unknown>; replayed: boolean; code: string; frozen: boolean };
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>): Promise<Fern> {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok', value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected', code: String(o.code), frozen: o.frozen === true, value: {}, replayed: false };
  } catch (e) {
    return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {}, replayed: false, frozen: false };
  }
}
/** Die Hausfolge am Primary: in EINER Klammer, wie `runOnPrimary`. */
function primary<T>(fn: () => T): { ok: boolean; code: string; value: T } {
  posting.beginLedgerTransaction();
  try {
    const v = fn();
    posting.commitLedgerTransaction();
    return { ok: true, code: '', value: v };
  } catch (e) {
    posting.rollbackLedgerTransaction();
    return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message), value: undefined as unknown as T };
  }
}
function parseFails(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

// ── Schnappschüsse (ohne Kennungen/Zeitstempel) ─────────────────────────────
const LEDGER = (db: Db) => rows(db, `SELECT source_module, account, direction, ROUND(amount, 3) AS amount, counterparty_type, counterparty_id,
  (reverses_entry_id IS NOT NULL) AS rev FROM ledger_entries ORDER BY source_module, account, direction, amount, rev`);
const EXPENSES = (db: Db) => rows(db, `SELECT branch_id, expense_number, category, amount, paid_amount, payment_method, expense_date,
  description, related_module, supplier_id, employee_id, status, created_by, (recurring_template_id IS NOT NULL) AS rec
  FROM expenses ORDER BY expense_date, expense_number`);
const EXPENSE_PAYMENTS = (db: Db) => rows(db, `SELECT e.expense_number, ep.amount, ep.method, ep.paid_at, ep.note, (ep.reference IS NOT NULL) AS ref
  FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id ORDER BY e.expense_number, ep.method, ep.amount`);
const TEMPLATES = (db: Db) => rows(db, `SELECT branch_id, category, amount, payment_method, pay_now_default, description, day_of_month,
  start_date, end_date, active, last_generated_period, employee_id FROM recurring_expense_templates ORDER BY start_date`);
const PURCHASES = (db: Db) => rows(db, 'SELECT id, status, total_amount, paid_amount, remaining_amount FROM purchases ORDER BY id');
const PURCHASE_PAYMENTS = (db: Db) => rows(db, `SELECT purchase_id, amount, method, paid_at, reference, note FROM purchase_payments
  ORDER BY purchase_id, method, amount, reference`);
const CREDITS = (db: Db) => rows(db, `SELECT supplier_id, branch_id, amount, used_amount, status, source_purchase_id, (source_return_id IS NOT NULL) AS ret, note
  FROM supplier_credits ORDER BY supplier_id, amount, used_amount`);
/** Σ Soll == Σ Haben je Buchungstransaktion. */
const unbalanced = (db: Db): number => n(db, `SELECT COUNT(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
  HAVING ABS(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)) > 0.0005)`);
const net = (db: Db, account: string, source?: string): number => Math.round(1000 * n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${source ? ' AND source_module = ?' : ''}`,
  source ? [account, source] : [account])) / 1000;
const expSeq = (db: Db): unknown => one(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'EXP'") ?? null;

function seedPurchase(db: Db, id: string, total: number, o: { supplier?: string; branch?: string; status?: string; date?: string } = {}): void {
  insert(db, 'purchases', {
    id, branch_id: o.branch ?? 'branch-main', purchase_number: 'PUR-' + id, supplier_id: o.supplier ?? 'sup-1',
    status: o.status ?? 'UNPAID', total_amount: total, paid_amount: 0, remaining_amount: total,
    purchase_date: o.date ?? '2026-09-02', created_at: NOW, updated_at: NOW,
  });
}
function seedCredit(db: Db, id: string, amount: number, o: { supplier?: string; branch?: string; created?: string; used?: number } = {}): void {
  // Ein Retouren-Guthaben (source_return_id gesetzt) — braucht fuer das Einloesen keine Ursprungsbuchung.
  insert(db, 'supplier_credits', {
    id, branch_id: o.branch ?? 'branch-main', supplier_id: o.supplier ?? 'sup-1', source_return_id: 'ret-' + id,
    source_purchase_id: 'pur-src', amount, used_amount: o.used ?? 0, status: 'OPEN', note: 'seed', created_at: o.created ?? NOW,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 SICHERHEIT A — Einkaufs- und Lieferantenzahlungen verlangen `payments.*` oder Admin (wie eine Rechnungszahlung).
// Fern (`executeCommand`), lokal (`payables-save`) und an den Knöpfen dieselbe Regel; ein Nein hat null Wirkung.
// ════════════════════════════════════════════════════════════════════════════
const { executeCommand } = registry;
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const GATED = ['purchases.record_payment', 'purchases.apply_credit', 'suppliers.pay', 'suppliers.apply_credit'];
const ACT = (role: string | undefined, k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role, payloadHash: 'h' + k });
const zustand = (db: Db) => S({ p: PURCHASES(db), pp: PURCHASE_PAYMENTS(db), c: CREDITS(db), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
  e: n(db, 'SELECT COUNT(*) FROM expense_payments'), cl: n(db, 'SELECT COUNT(*) FROM remote_command_ledger') });
const als = (role: string) => useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never });

// ── §1 Tabelle: dieselbe Regel wie „Record Payment" an der Rechnung ─────────────
{
  for (const op of GATED) {
    const r = perms.permissionForOp(op) as { kind: string; permission?: string } | null;
    ok(r?.kind === 'permissionOrAdmin' && r.permission === 'payments.*', `A1 ${op}: payments.* oder Admin (${S(r)})`);
    ok(!perms.roleMayRunOp('SALES', op) && !perms.roleMayRunOp('viewer', op) && !perms.roleMayRunOp(undefined, op) && !perms.roleMayRunOp('', op),
      `A1 ${op}: Verkäufer, Leser, ohne Rolle → nein`);
    ok(perms.roleMayRunOp('ACCOUNTANT', op) && perms.roleMayRunOp('MANAGER', op) && perms.roleMayRunOp('ADMIN', op),
      `A1 ${op}: Buchhaltung, Manager, Owner → ja (wie invoices.record_payment)`);
    ok(['SALES', 'ACCOUNTANT', 'MANAGER', 'ADMIN', 'viewer'].every((r2) => perms.roleMayRunOp(r2, op) === perms.roleMayRunOp(r2, 'invoices.record_payment')),
      `A1 ${op}: für jede Rolle genau wie die Rechnungszahlung`);
  }
  // B2/B3 Sicherheitsabschluss (10.11.2026): beide seither mit demselben Tor — siehe §4/§5.
  ok(['suppliers.refund_credit', 'expenses.record_payment'].every((op) => (perms.permissionForOp(op) as { permission?: string } | null)?.permission === 'payments.*'),
    'A1 Rückzahlung eines Lieferantenguthabens und Ausgabenzahlung: payments.* oder Admin (Sicherheitsabschluss)');
  const ps = codeOf(src('src/pages/purchases/PurchaseDetail.tsx'));
  const sd = codeOf(src('src/pages/suppliers/SupplierDetail.tsx'));
  ok(/const canPay = !!purchase && perm\.canRecordPayments &&/.test(ps), 'A1 Primary-Knopf „Add Payment" nur mit perm.canRecordPayments');
  ok(/\{perm\.canRecordPayments && \(workshopExpenses/.test(sd), 'A1 Primary-Knopf „Pay Supplier — Bulk" nur mit perm.canRecordPayments');
}
marker('B23_SEC_A_TABLE_PROVED');

// ── §2 Fernweg: ein Verkäufer bezahlt nichts; derselbe Rumpf als Admin wirkt einmal ────
{
  const db = freshDb();
  seedPurchase(db, 'P1', 100);
  seedPurchase(db, 'P2', 80);
  seedCredit(db, 'C1', 30);
  const rev = (id: string) => n(db, 'SELECT revision FROM purchases WHERE id = ?', [id]);
  const faelle: Array<[string, Record<string, unknown>]> = [
    ['purchases.record_payment', { purchaseId: 'P1', expectedRevision: rev('P1'), amount: 40, method: 'cash' }],
    ['purchases.apply_credit', { purchaseId: 'P2', expectedRevision: rev('P2'), amount: 10 }],
    ['suppliers.pay', { supplierId: 'sup-1', amount: 20, method: 'bank', mode: 'auto' }],
    ['suppliers.apply_credit', { supplierId: 'sup-1', amount: 5 }],
  ];
  let k = 100;
  for (const [op, input] of faelle) {
    for (const role of ['SALES', 'viewer', undefined]) {
      const vorher = zustand(db);
      const r = await executeCommand(op, { input }, ACT(role, ++k) as never);
      ok(r.kind === 'business_error' && (r as { code: string }).code === 'PERMISSION_DENIED',
        `A2 fern ${op} als ${role ?? 'ohne Rolle'}: PERMISSION_DENIED (${S(r).slice(0, 120)})`);
      ok(zustand(db) === vorher, `A2 fern ${op} als ${role ?? 'ohne Rolle'}: keine Zahlung, keine Buchung, kein Nachweis`);
    }
  }
  const vorher = n(db, 'SELECT COUNT(*) FROM purchase_payments');
  const r = await executeCommand('purchases.record_payment', { input: faelle[0][1] }, ACT('ACCOUNTANT', ++k) as never);
  ok(r.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM purchase_payments') === vorher + 1 && Number(one(db, "SELECT paid_amount FROM purchases WHERE id = 'P1'")) === 40,
    `A2 fern dieselbe Zahlung als Buchhaltung (payments.*) wirkt einmal (${S(r).slice(0, 100)})`);
  const r2 = await executeCommand('purchases.apply_credit', { input: faelle[1][1] }, ACT('MANAGER', ++k) as never);
  ok(r2.kind === 'ok' && n(db, "SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = 'P2' AND method = 'credit'") === 1,
    'A2 fern Guthaben auf Einkauf als Manager wirkt');
  ok(unbalanced(db) === 0, 'A2 Hauptbuch ausgeglichen');
}
marker('B23_SEC_A_REMOTE_PROVED');

// ── §3 Primary-Maske: dieselbe Regel vor jeder Wirkung ──────────────────────────
{
  const db = freshDb();
  seedPurchase(db, 'P1', 100);
  seedCredit(db, 'C1', 30);
  const local = { remote: false, save: <T,>(a: never) => runSharedWrite<T>(false, a, null) };
  const purchase = { id: 'P1', revision: n(db, "SELECT revision FROM purchases WHERE id = 'P1'") } as never;
  for (const role of ['SALES', 'viewer']) {
    als(role);
    const vorher = zustand(db);
    const a = await save.savePurchasePayment(local as never, purchase, 10, 'cash');
    const b = await save.savePurchaseCredit(local as never, purchase, 5);
    const c = await save.saveSupplierPay(local as never, { supplierId: 'sup-1', amount: 10, method: 'cash', mode: 'auto' } as never);
    const d = await save.saveSupplierCredit(local as never, 'sup-1', 5);
    ok([a, b, c, d].every((x) => x.kind === 'business_error' && (x as { code: string }).code === 'PERMISSION_DENIED'),
      `A3 lokal als ${role}: alle vier Zahlungswege → PERMISSION_DENIED (${[a, b, c, d].map((x) => (x as { code?: string }).code).join(',')})`);
    ok(zustand(db) === vorher, `A3 lokal als ${role}: nichts geschrieben`);
  }
  als('ACCOUNTANT');
  const ok1 = await save.savePurchasePayment(local as never, purchase, 10, 'cash');
  ok(ok1.kind === 'ok' && Number(one(db, "SELECT paid_amount FROM purchases WHERE id = 'P1'")) === 10, `A3 lokal als Buchhaltung wirkt (${S(ok1).slice(0, 80)})`);
  als('ADMIN');
}
marker('B23_SEC_A_LOCAL_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 SICHERHEITSABSCHLUSS (10.11.2026) — Rückzahlung von Lieferantenguthaben, Ausgabenzahlung, „Pay now"/„Partial" beim
// Anlegen einer Ausgabe, Dauerauftrag mit Sofortzahlung, Anzahlung beim Anlegen eines Einkaufs: dasselbe Recht wie jede
// Zahlung (payments.* oder Admin). Anlegen OHNE Zahlung bleibt frei. Fern und lokal; ein Nein hat null Wirkung.
// ════════════════════════════════════════════════════════════════════════════
const ZUSTAND2 = (db: Db) => S({ z: zustand(db), x: EXPENSES(db), xp: EXPENSE_PAYMENTS(db), t: TEMPLATES(db), c: CREDITS(db), seq: expSeq(db) });
// ── §4 Tabelle und Rumpfregel ─────────────────────────────────────────────────
{
  const p = perms.paymentOpForPayload;
  ok(p('purchases.create', { paymentAmount: 10 }) === 'purchases.record_payment' && p('purchases.create', { initialPayment: { amount: 5, method: 'cash' } }) === 'purchases.record_payment'
    && p('purchases.create', { payments: [{ amount: 0 }, { amount: 3 }] }) === 'purchases.record_payment', 'A4 Einkauf mit Anzahlung (alle drei Rumpfformen) → Recht der Einkaufszahlung');
  ok(p('purchases.create', { paymentAmount: 0 }) === null && p('purchases.create', { payments: [{ amount: 0 }] }) === null && p('purchases.create', {}) === null,
    'A4 Einkauf ohne Zahlung → kein Tor');
  ok(p('expenses.create', { timing: 'now' }) === 'expenses.record_payment' && p('expenses.create', { timing: 'partial' }) === 'expenses.record_payment'
    && p('expenses.create', { timing: 'later' }) === null, 'A4 Ausgabe: Pay now / Partial → Recht der Ausgabenzahlung; Pay later frei');
  ok(p('expenses.template_create', { payNowDefault: true }) === 'expenses.record_payment' && p('expenses.template_create', { payNowDefault: false }) === null
    && p('expenses.template_update', { payNowDefault: true }) === 'expenses.record_payment' && p('expenses.template_update', { amount: 5 }) === null,
    'A4 Dauerauftrag mit Sofortzahlung → Recht der Ausgabenzahlung; ohne frei');
  ok(p('customers.create', { paymentAmount: 10 }) === null, 'A4 andere Operationen unberührt');
  for (const op of ['suppliers.refund_credit', 'expenses.record_payment']) {
    ok(['SALES', 'ACCOUNTANT', 'MANAGER', 'ADMIN', 'viewer'].every((r2) => perms.roleMayRunOp(r2, op) === perms.roleMayRunOp(r2, 'invoices.record_payment')),
      `A4 ${op}: für jede Rolle genau wie die Rechnungszahlung`);
  }
}
marker('B23_SEC_CLOSE_TABLE_PROVED');

// ── §5 Fernweg ────────────────────────────────────────────────────────────────
{
  const db = nimm(freshDb());
  seedCredit(db, 'C1', 30);
  insert(db, 'supplier_credits', { id: 'C2', branch_id: 'branch-main', supplier_id: 'sup-1', source_purchase_id: 'pur-src', amount: 25, used_amount: 0,
    status: 'OPEN', note: 'standalone', created_at: NOW });
  let k = 500;
  const nein = async (op: string, input: Record<string, unknown>, role: string | undefined, was: string) => {
    const vorher = ZUSTAND2(db);
    const r = await executeCommand(op, { input }, ACT(role, ++k) as never);
    ok(r.kind === 'business_error' && (r as { code: string }).code === 'PERMISSION_DENIED', `A5 fern ${was} als ${role ?? 'ohne Rolle'}: PERMISSION_DENIED (${S(r).slice(0, 110)})`);
    ok(ZUSTAND2(db) === vorher, `A5 fern ${was} als ${role ?? 'ohne Rolle'}: nichts geschrieben, kein Nachweis`);
  };
  const ausgabe = (timing: string) => ({ category: 'Rent', amount: 50, paymentMethod: 'cash', expenseDate: '2026-09-02', timing });
  const vorlage = (payNowDefault: boolean) => ({ category: 'Rent', amount: 40, paymentMethod: 'bank', payNowDefault, dayOfMonth: 2, startDate: '2026-09-02' });
  for (const role of ['SALES', 'viewer', undefined]) {
    await nein('expenses.create', ausgabe('now'), role, 'Ausgabe „Pay now"');
    await nein('expenses.create', { ...ausgabe('partial'), partialAmount: 10 }, role, 'Ausgabe „Partial"');
    await nein('expenses.template_create', vorlage(true), role, 'Dauerauftrag mit Sofortzahlung');
    await nein('suppliers.refund_credit', { creditId: 'C2' }, role, 'Refund Credit');
    await nein('purchases.create', { supplierId: 'sup-1', purchaseDate: '2026-09-02', lines: [], paymentAmount: 10, paymentMethod: 'cash' }, role, 'Einkauf mit Anzahlung');
    await nein('purchases.create', { supplierId: 'sup-1', purchaseDate: '2026-09-02', lines: [], payments: [{ amount: 10, method: 'cash', paidDate: '2026-09-02' }] }, role, 'Einkauf mit Zahlungen');
  }
  // Ohne Zahlung bleibt das Anlegen frei: der Verkäufer legt die Ausgabe offen an.
  const offen = await executeCommand('expenses.create', { input: ausgabe('later') }, ACT('SALES', ++k) as never);
  ok(offen.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM expenses WHERE paid_amount = 0') === 1 && n(db, 'SELECT COUNT(*) FROM expense_payments') === 0,
    `A5 fern Verkäufer: Ausgabe „Pay later" wird angelegt, ohne Zahlung (${S(offen).slice(0, 100)})`);
  const ohneZahlung = await executeCommand('purchases.create', { input: { supplierId: 'sup-1', purchaseDate: '2026-09-02', lines: [] } }, ACT('SALES', ++k) as never);
  ok(!(ohneZahlung.kind === 'business_error' && (ohneZahlung as { code: string }).code === 'PERMISSION_DENIED'),
    `A5 fern Verkäufer: Einkauf ohne Zahlung trifft kein Rechte-Tor (${S(ohneZahlung).slice(0, 100)})`);
  const eid = s(db, 'SELECT id FROM expenses LIMIT 1');
  const erev = n(db, 'SELECT revision FROM expenses WHERE id = ?', [eid]);
  for (const role of ['SALES', 'viewer', undefined]) await nein('expenses.record_payment', { expenseId: eid, expectedRevision: erev, amount: 50, method: 'cash' }, role, 'Ausgabenzahlung');
  const bezahlt = await executeCommand('expenses.record_payment', { input: { expenseId: eid, expectedRevision: erev, amount: 50, method: 'cash' } }, ACT('ACCOUNTANT', ++k) as never);
  ok(bezahlt.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM expense_payments') === 1, `A5 fern Buchhaltung: Ausgabenzahlung wirkt (${S(bezahlt).slice(0, 100)})`);
  const sofort = await executeCommand('expenses.create', { input: ausgabe('now') }, ACT('MANAGER', ++k) as never);
  ok(sofort.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM expense_payments') === 2, `A5 fern Manager: „Pay now" wirkt (${S(sofort).slice(0, 100)})`);
  const refund = await executeCommand('suppliers.refund_credit', { input: { creditId: 'C2' } }, ACT('ADMIN', ++k) as never);
  ok(refund.kind !== 'business_error' || (refund as { code: string }).code !== 'PERMISSION_DENIED', `A5 fern Owner: Refund Credit trifft kein Rechte-Tor (${S(refund).slice(0, 100)})`);
  ok(unbalanced(db) === 0, 'A5 Hauptbuch ausgeglichen');
}
marker('B23_SEC_CLOSE_REMOTE_PROVED');

// ── §6 Primary-Masken: dieselbe Regel vor jeder Wirkung ─────────────────────────
{
  const db = nimm(freshDb());
  seedCredit(db, 'C1', 30);
  const local = { remote: false, save: <T,>(a: never) => runSharedWrite<T>(false, a, null) };
  const ph = await import('../../src/core/purchases/purchase-house.ts');
  als('ACCOUNTANT');
  const angelegt = await save.saveExpenseCreate(local as never, { category: 'Rent', amount: 50, paymentMethod: 'cash', expenseDate: '2026-09-02', timing: 'later' } as never);
  const eid = s(db, 'SELECT id FROM expenses LIMIT 1');
  const expense = { id: eid, revision: n(db, 'SELECT revision FROM expenses WHERE id = ?', [eid]) } as never;
  for (const role of ['SALES', 'viewer']) {
    als(role);
    const vorher = ZUSTAND2(db);
    const a = await save.saveExpensePayment(local as never, expense, 10, 'cash');
    const b = await save.saveExpenseCreate(local as never, { category: 'Rent', amount: 20, paymentMethod: 'cash', expenseDate: '2026-09-02', timing: 'now' } as never);
    const c = await save.saveTemplateCreate(local as never, { category: 'Rent', amount: 40, paymentMethod: 'bank', payNowDefault: true, dayOfMonth: 2, startDate: '2026-09-02' });
    const d = await save.saveSupplierRefund(local as never, 'C1');
    const e = await save.saveSupplierCreditRepayment(local as never, { creditId: 'C1', amount: 5, method: 'cash' });
    let f = '';
    try { await ph.createPurchaseOnPrimary({ supplierId: 'sup-1', purchaseDate: '2026-09-02', lines: [], paymentAmount: 10, paymentMethod: 'cash' } as never); f = 'gebucht'; }
    catch (x) { f = String((x as { code?: string }).code ?? (x as Error).message); }
    ok([a, b, c, d, e].every((x) => x.kind === 'business_error' && (x as { code: string }).code === 'PERMISSION_DENIED') && f === 'PERMISSION_DENIED',
      `A6 lokal als ${role}: Ausgabenzahlung, „Pay now", Dauerauftrag mit Sofortzahlung, Refund, Rückzahlung, Einkauf mit Anzahlung → PERMISSION_DENIED (${[a, b, c, d, e].map((x) => (x as { code?: string }).code).join(',')},${f})`);
    ok(ZUSTAND2(db) === vorher, `A6 lokal als ${role}: nichts geschrieben`);
    const spaeter = await save.saveExpenseCreate(local as never, { category: 'Rent', amount: 20, paymentMethod: 'cash', expenseDate: '2026-09-02', timing: 'later' } as never);
    ok(spaeter.kind === 'ok', `A6 lokal als ${role}: „Pay later" bleibt erlaubt (${S(spaeter).slice(0, 80)})`);
  }
  als('ACCOUNTANT');
  const zahlt = await save.saveExpensePayment(local as never, expense, 10, 'cash');
  ok(angelegt.kind === 'ok' && zahlt.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM expense_payments') === 1, `A6 lokal als Buchhaltung: Ausgabenzahlung wirkt (${S(zahlt).slice(0, 80)})`);
  als('ADMIN');
  // Die Masken bieten nichts an, was danach abgewiesen würde.
  const pem = codeOf(src('src/components/expenses/PayExpenseModal.tsx'));
  const el = codeOf(src('src/pages/expenses/ExpenseList.tsx'));
  const pc = codeOf(src('src/pages/purchases/PurchaseCreate.tsx'));
  const sd = codeOf(src('src/pages/suppliers/SupplierDetail.tsx'));
  const cd = codeOf(src('src/pages/consignments/ConsignmentDetail.tsx'));
  ok(/disabled=\{amount <= 0 \|\| zahlen\.busy \|\| !perm\.canRecordPayments\}/.test(pem) && /data-expense-pay-no-right/.test(pem), 'A6 Maske: „Record Payment" der Ausgabe nur mit perm.canRecordPayments');
  ok(/disabled=\{t !== 'later' && !perm\.canRecordPayments\}/.test(el) && /const payTiming: PayTiming = perm\.canRecordPayments \? payTimingWahl : 'later';/.test(el),
    'A6 Maske: „Pay now"/„Partial" nur mit perm.canRecordPayments, sonst „Pay later"');
  ok(/\{!perm\.canRecordPayments \? \(\s*<p[^>]*data-purchase-pay-no-right/.test(pc), 'A6 Maske: Zahlungen beim Anlegen eines Einkaufs nur mit perm.canRecordPayments');
  ok(/\{!perm\.canRecordPayments \? \(\s*<span/.test(sd) && /perm\.canManageConsignments && perm\.canRecordPayments &&/.test(cd),
    'A6 Maske: „Refund Credit"/„Record Repayment" (Lieferant, Kommission) nur mit perm.canRecordPayments');
}
marker('B23_SEC_CLOSE_LOCAL_PROVED');

console.log(`\nb23 security A: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('B23_SECURITY_A_PURCHASE_PAYMENT_PERMISSION_PROVED');

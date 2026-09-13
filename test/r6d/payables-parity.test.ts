// ════════════════════════════════════════════════════════════════════════════
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
const expenseIntent = (over: Record<string, unknown> = {}) => ({
  category: 'Rent', amount: 120, paymentMethod: 'bank', expenseDate: '2026-09-01', description: 'Sept rent', timing: 'partial', partialAmount: 50, ...over,
});
function makeExpense(over: Partial<Record<string, unknown>> = {}, c = CTX): string {
  const r = primary(() => house.createExpenseInHouse({
    category: 'RepairCosts', amount: 100, paymentMethod: 'cash', expenseDate: '2026-09-01', initialPaid: 0, supplierId: 'sup-1', ...over,
  } as never, c));
  if (!r.ok) throw new Error('seed expense failed: ' + r.code);
  return r.value.expenseId;
}
const rev = (db: Db, table: string, id: string): number => n(db, `SELECT revision FROM ${table} WHERE id = ?`, [id]);

const OPS = ['expenses.create', 'expenses.update', 'expenses.record_payment', 'expenses.template_create', 'expenses.template_update',
  'purchases.record_payment', 'purchases.apply_credit', 'suppliers.refund_credit', 'suppliers.pay', 'suppliers.apply_credit'];

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die zehn Verbindlichkeits-Buchungen sind namentlich freigegeben');
  ok(OPS.every((op) => registry.knownCommands().includes(op)), 'SCOPE und registriert (payables-commands.ts)');
  ok(S([...cmds.PAYABLES_OPS].sort()) === S([...OPS].sort()), 'SCOPE genau diese zehn, keine elfte');
  ok(OPS.every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null), 'SCOPE kein erfundenes Recht (die Masken haben kein Tor)');
  ok(registry.knownCommands().includes('suppliers.credits.get'), 'SCOPE die Auskunft suppliers.credits.get ist angemeldet');
}
marker('CENTRAL_UI_R6D_PAYABLES_SCOPE_PROVED');

// ══ §2 — expenses.create ════════════════════════════════════════════════════
{
  // Primary == PC2
  const dbP = freshDb();
  const p = primary(() => house.createExpenseFromIntent(house.expenseCreateIntent(expenseIntent()), CTX));
  const snapP = { e: EXPENSES(dbP), ep: EXPENSE_PAYMENTS(dbP), l: LEDGER(dbP) };
  const dbC = freshDb();
  const d = deps(dbC);
  const idA = nextId();
  const a = await fern(() => cmds.runExpenseCreate(d, identity(idA, 'expenses.create'), expenseIntent()));
  const snapC = { e: EXPENSES(dbC), ep: EXPENSE_PAYMENTS(dbC), l: LEDGER(dbC) };
  ok(p.ok && a.kind === 'ok', `CREATE Primary und PC2 legen an (${p.code}/${a.code})`);
  ok(S(snapP) === S(snapC), `PARITY Beleg, Erstzahlung und Buchungen sind gleich${S(snapP) === S(snapC) ? '' : ` (${S(snapP).slice(0, 400)} / ${S(snapC).slice(0, 400)})`}`);
  const e = snapC.e[0] ?? {};
  ok(Number(e.amount) === 120 && Number(e.paid_amount) === 50 && e.status === 'PENDING' && e.branch_id === 'branch-main' && e.created_by === 'user-test',
    'CREATE die Erstzahlung leitet der Primary aus „partial 50" ab — Status PENDING');
  ok(net(dbC, 'EXPENSES_OPERATING', 'EXPENSE') === 120 && net(dbC, 'ACCOUNTS_PAYABLE') === -70 && net(dbC, 'BANK', 'EXPENSE_PAYMENT') === -50,
    'LEDGER DR Aufwand 120 / CR AP 120, dann DR AP 50 / CR Bank 50 (source EXPENSE / EXPENSE_PAYMENT)');
  const ledgerRows = n(dbC, 'SELECT COUNT(*) FROM ledger_entries');
  const b = await fern(() => cmds.runExpenseCreate(d, identity(idA, 'expenses.create'), expenseIntent()));
  ok(b.kind === 'ok' && b.replayed && b.value.expenseId === a.value.expenseId && n(dbC, 'SELECT COUNT(*) FROM expenses') === 1
    && n(dbC, 'SELECT COUNT(*) FROM ledger_entries') === ledgerRows, 'LOST verlorene Antwort, dieselbe Kennung: genau EINE Ausgabe, keine zweite Buchung');

  // Gehalt ohne Mitarbeiter: Nein VOR der Nummer
  const seqBefore = expSeq(dbC);
  const s1 = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create'), expenseIntent({ category: 'Salary', partialAmount: undefined, timing: 'later' })));
  ok(s1.kind === 'rejected' && s1.code === 'EXPENSE_SALARY_NEEDS_EMPLOYEE' && s1.frozen && expSeq(dbC) === seqBefore,
    `PRIMARY-FIX Gehalt ohne Mitarbeiter wird abgewiesen, BEVOR eine Belegnummer verbrannt wird (${s1.code})`);
  const s2 = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create'), expenseIntent({ category: 'Salary', employeeId: 'emp-x', timing: 'later', partialAmount: undefined })));
  ok(s2.code === 'EMPLOYEE_NOT_FOUND' && expSeq(dbC) === seqBefore, 'SECURITY ein Mitarbeiter einer anderen Filiale ist hier nicht vorhanden');
  const s3 = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create'), expenseIntent({ supplierId: 'sup-x' })));
  ok(s3.code === 'SUPPLIER_NOT_FOUND', 'SECURITY ein Lieferant einer anderen Filiale ist hier nicht vorhanden');
  const s4 = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create'), expenseIntent({ category: 'Salary', employeeId: 'emp-1', timing: 'later', partialAmount: undefined })));
  ok(s4.kind === 'ok' && one(dbC, 'SELECT employee_id FROM expenses WHERE id = ?', [s4.value.expenseId]) === 'emp-1', 'CREATE Gehalt MIT Mitarbeiter der Filiale geht');

  for (const [over, code] of [
    [{ partialAmount: 130 }, 'EXPENSE_PARTIAL_INVALID'], [{ partialAmount: 0 }, 'EXPENSE_PARTIAL_INVALID'],
    [{ timing: 'now', partialAmount: 10 }, 'EXPENSE_PARTIAL_INVALID'], [{ amount: 0 }, 'EXPENSE_AMOUNT_INVALID'],
    [{ amount: -5 }, 'EXPENSE_AMOUNT_INVALID'], [{ category: 'Bribes' }, 'EXPENSE_CATEGORY_INVALID'],
    [{ paymentMethod: 'credit' }, 'PAYMENT_METHOD_INVALID'], [{ expenseDate: '2026-02-30' }, 'EXPENSE_DATE_INVALID'],
  ] as Array<[Record<string, unknown>, string]>) {
    const before = n(dbC, 'SELECT COUNT(*) FROM expenses');
    const r = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create'), expenseIntent(over)));
    ok(r.kind === 'rejected' && r.code === code && n(dbC, 'SELECT COUNT(*) FROM expenses') === before, `RULE ${S(over)} → ${code} (${r.code}), nichts angelegt`);
  }
  for (const k of ['paidAmount', 'initialPaid', 'status', 'expenseNumber', 'branchId', 'ledger', 'relatedModule', 'recurringTemplateId', 'payNow', 'account']) {
    ok(/the primary decides/.test(parseFails(() => cmds.parseExpenseCreate({ ...expenseIntent(), [k]: 1 }))), `PAYLOAD expenses.create: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(parseFails(() => cmds.parseExpenseCreate({ ...expenseIntent(), bogus: 1 }))), 'PAYLOAD ein unbekanntes Feld wird abgewiesen');
  ok(parseFails(() => cmds.parseExpenseCreate({ ...expenseIntent(), amount: '120' })) !== '', 'PAYLOAD ein Betrag als Text ist kein Betrag');
  const br = await fern(() => cmds.runExpenseCreate(d, identity(nextId(), 'expenses.create', 'branch-other'), expenseIntent()));
  ok(br.kind === 'rejected' && br.code === 'BRANCH_MISMATCH', 'SECURITY ein Ausweis einer anderen Filiale legt nichts an');

  // Fehler in der Buchung → nichts
  const dbF = freshDb();
  const seqF = expSeq(dbF);
  // Die dritte Ledger-Zeile ist das erste Bein der Zahlungsbuchung (die Aufwandsbuchung hat zwei).
  const { db: bad } = failOn(dbF, /INSERT INTO ledger_entries/, 3);
  const idF = nextId();
  const f = await fern(() => cmds.runExpenseCreate(deps(bad), identity(idF, 'expenses.create'), expenseIntent()));
  unfail();
  ok(f.kind === 'thrown' && n(dbF, 'SELECT COUNT(*) FROM expenses') === 0 && n(dbF, 'SELECT COUNT(*) FROM expense_payments') === 0
    && n(dbF, 'SELECT COUNT(*) FROM ledger_entries') === 0 && expSeq(dbF) === seqF && lookupCommand(dbF as never, identity(idF, 'expenses.create')).kind === 'fresh',
  'ATOMIC scheitert die Zahlungsbuchung, gibt es weder Ausgabe noch Zahlung noch Aufwandsbuchung — und keine verbrannte Nummer (vorher drei getrennte Commits + verschluckter Post)');
  ok(unbalanced(dbC) === 0 && unbalanced(dbP) === 0, 'LEDGER jede Transaktion ausgeglichen');

  // Die Store-Aktion der anderen Module (Metall, Kommission): Signatur unverändert, jetzt atomar
  const dbS = freshDb();
  const exp = useExpenseStore.getState().createExpense({ category: 'Inventory', amount: 10, supplierId: 'sup-1', payNow: false, relatedModule: 'metal', relatedEntityId: 'm1', expenseDate: '2026-09-01' });
  ok(exp && exp.status === 'PENDING' && exp.relatedModule === 'metal' && net(dbS, 'EXPENSES_OPERATING') === 10 && n(dbS, 'SELECT COUNT(*) FROM expense_payments') === 0,
    'STORE createExpense (Metall/Kommission) liefert wie bisher die Ausgabe — gebucht, ohne Zahlung');
  posting.beginLedgerTransaction();
  useExpenseStore.getState().createExpense({ category: 'Inventory', amount: 7, supplierId: 'sup-1', payNow: false, expenseDate: '2026-09-01' });
  posting.rollbackLedgerTransaction();
  ok(n(dbS, 'SELECT COUNT(*) FROM expenses') === 1 && net(dbS, 'EXPENSES_OPERATING') === 10, 'STORE innerhalb einer fremden Klammer ist createExpense ein Teil davon — deren Rollback nimmt sie mit');
}
marker('CENTRAL_UI_R6D_PAYABLES_EXPENSE_CREATE_PROVED');

// ══ §3 — expenses.update ════════════════════════════════════════════════════
{
  const setup = (): { db: Db; id: string } => {
    const db = freshDb();
    const id = makeExpense({ amount: 100, initialPaid: 30, expenseDate: '2026-09-01', category: 'Utilities', description: 'Strom' });
    return { db, id };
  };
  const body = (id: string, r: number) => ({ expenseId: id, expectedRevision: r, amount: 80, expenseDate: '2026-09-05', description: 'Strom Sept' });
  const P = setup();
  const pr = primary(() => house.updateExpenseInHouse(P.id, house.expenseEditFields({ amount: 80, expenseDate: '2026-09-05', description: 'Strom Sept' }), CTX, rev(P.db, 'expenses', P.id)));
  const snapP = { e: EXPENSES(P.db), l: LEDGER(P.db) };
  const C = setup();
  const d = deps(C.db);
  const r0 = rev(C.db, 'expenses', C.id);
  const idU = nextId();
  const u = await fern(() => cmds.runExpenseUpdate(d, identity(idU, 'expenses.update'), body(C.id, r0)));
  const snapC = { e: EXPENSES(C.db), l: LEDGER(C.db) };
  ok(pr.ok && u.kind === 'ok' && S(snapP) === S(snapC), `PARITY Aendern: dieselbe Zeile, dieselben Buchungen (${pr.code}/${u.code})`);
  ok(net(C.db, 'EXPENSES_OPERATING', 'EXPENSE') === 80 && one(C.db, `SELECT occurred_at FROM ledger_entries WHERE source_module = 'EXPENSE' AND reverses_entry_id IS NULL
      AND account = 'EXPENSES_OPERATING' AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = ledger_entries.id)`) === '2026-09-05',
  'PRIMARY-FIX Betrag/Datum geändert → Aufwandsbuchung storniert und neu gebucht (80, am 05.09.; vorher blieb sie bei 100)');
  ok(Number(u.value.revision) > r0 && one(C.db, 'SELECT status FROM expenses WHERE id = ?', [C.id]) === 'PENDING', 'UPDATE neue Fassung, Status aus cash + credit');
  const again = await fern(() => cmds.runExpenseUpdate(d, identity(idU, 'expenses.update'), body(C.id, r0)));
  ok(again.replayed && n(C.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE'") === snapC.l.filter((x) => x.source_module === 'EXPENSE').length,
    'LOST dieselbe Kennung: kein zweites Storno');
  const stale = await fern(() => cmds.runExpenseUpdate(d, identity(nextId(), 'expenses.update'), { expenseId: C.id, expectedRevision: r0, amount: 90 }));
  ok(stale.code === 'RECORD_CHANGED' && Number(one(C.db, 'SELECT amount FROM expenses WHERE id = ?', [C.id])) === 80, 'STALE eine veraltete Fassung ändert nichts');
  const r1 = rev(C.db, 'expenses', C.id);
  const low = await fern(() => cmds.runExpenseUpdate(d, identity(nextId(), 'expenses.update'), { expenseId: C.id, expectedRevision: r1, amount: 20 }));
  ok(low.code === 'EXPENSE_AMOUNT_BELOW_SETTLED' && Number(one(C.db, 'SELECT amount FROM expenses WHERE id = ?', [C.id])) === 80,
    'PRIMARY-FIX der Betrag geht nie unter das Bezahlte (30) — vorher nur bei Guthaben-Einlösung geprüft');
  const zero = await fern(() => cmds.runExpenseUpdate(d, identity(nextId(), 'expenses.update'), { expenseId: C.id, expectedRevision: r1, amount: 0 }));
  ok(zero.code === 'EXPENSE_AMOUNT_INVALID', 'RULE Betrag 0 ist kein Betrag (vorher angenommen)');
  for (const k of ['supplierId', 'employeeId', 'status', 'paidAmount', 'relatedModule']) {
    ok(/the primary decides/.test(parseFails(() => cmds.parseExpenseUpdate({ expenseId: C.id, expectedRevision: r1, amount: 50, [k]: 'x' }))), `PAYLOAD expenses.update: ${k} ändert ein Bearbeiten nie`);
  }
  ok(/expectedRevision/.test(parseFails(() => cmds.parseExpenseUpdate({ expenseId: C.id, amount: 50 }))), 'PAYLOAD ändern verlangt die gesehene Fassung');
  ok(/must change something/.test(parseFails(() => cmds.parseExpenseUpdate({ expenseId: C.id, expectedRevision: r1 }))), 'PAYLOAD ein leeres Ändern ist keine Absicht');
  // Storniert → Nein
  nimm(C.db);
  useExpenseStore.getState().loadExpenses();
  useExpenseStore.getState().updateExpense(C.id, { status: 'CANCELLED' });
  const canc = await fern(() => cmds.runExpenseUpdate(d, identity(nextId(), 'expenses.update'), { expenseId: C.id, expectedRevision: rev(C.db, 'expenses', C.id), amount: 70 }));
  ok(canc.code === 'EXPENSE_CANCELLED', 'RULE eine stornierte Ausgabe wird nicht bearbeitet');
  // Der Stand beim Öffnen wird nicht mehr zurückgeschrieben
  const E = setup();
  useExpenseStore.getState().loadExpenses();
  const snap = useExpenseStore.getState().getExpense(E.id)!;
  let thrown = '';
  try { useExpenseStore.getState().updateExpense(E.id, { ...snap, supplierId: 'sup-2' }); } catch (e) { thrown = String((e as { code?: string }).code); }
  ok(thrown === 'EXPENSE_FIELD_NOT_EDITABLE' && one(E.db, 'SELECT supplier_id FROM expenses WHERE id = ?', [E.id]) === 'sup-1',
    'PRIMARY-FIX der Store schreibt Lieferant/Status aus einem Formular-Stand nicht mehr still zurück');
  useExpenseStore.getState().updateExpense(E.id, { ...snap, description: 'neu' });
  ok(one(E.db, 'SELECT description FROM expenses WHERE id = ?', [E.id]) === 'neu', 'STORE ein unveränderter Stand + neue Beschreibung geht durch die Hausfolge');
  const foreign = freshDb();
  insert(foreign, 'expenses', { id: 'e-x', branch_id: 'branch-other', expense_number: 'EXP-X', category: 'Rent', amount: 10, paid_amount: 0, status: 'PENDING', expense_date: '2026-09-01', created_at: NOW });
  const fx = await fern(() => cmds.runExpenseUpdate(deps(foreign), identity(nextId(), 'expenses.update'), { expenseId: 'e-x', expectedRevision: 1, amount: 5 }));
  ok(fx.code === 'EXPENSE_NOT_FOUND', 'SECURITY eine Ausgabe einer anderen Filiale ist hier nicht vorhanden');
  ok(unbalanced(C.db) === 0 && unbalanced(P.db) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_EXPENSE_UPDATE_PROVED');

// ══ §4 — expenses.record_payment ════════════════════════════════════════════
{
  const setup = (): { db: Db; id: string } => { const db = freshDb(); return { db, id: makeExpense({ amount: 100, initialPaid: 0 }) }; };
  const P = setup();
  const pr = primary(() => house.recordExpensePaymentInHouse(P.id, 40, 'bank', CTX, { expectedRevision: rev(P.db, 'expenses', P.id) }));
  const C = setup();
  const d = deps(C.db);
  const idP = nextId();
  const r = await fern(() => cmds.runExpensePayment(d, identity(idP, 'expenses.record_payment'), { expenseId: C.id, expectedRevision: rev(C.db, 'expenses', C.id), amount: 40, method: 'bank' }));
  const same = S({ e: EXPENSES(P.db), ep: EXPENSE_PAYMENTS(P.db), l: LEDGER(P.db) }) === S({ e: EXPENSES(C.db), ep: EXPENSE_PAYMENTS(C.db), l: LEDGER(C.db) });
  ok(pr.ok && r.kind === 'ok' && same, `PARITY Zahlung: dieselbe Zeile, dieselbe Buchung (${pr.code}/${r.code})`);
  ok(net(C.db, 'BANK', 'EXPENSE_PAYMENT') === -40 && Number(r.value.remainingAmount) === 60 && r.value.status === 'PENDING', 'LEDGER DR AP 40 / CR Bank 40; Rest 60');
  const payRows = n(C.db, 'SELECT COUNT(*) FROM expense_payments');
  const again = await fern(() => cmds.runExpensePayment(d, identity(idP, 'expenses.record_payment'), { expenseId: C.id, expectedRevision: 1, amount: 40, method: 'bank' }));
  ok(again.replayed && n(C.db, 'SELECT COUNT(*) FROM expense_payments') === payRows, 'LOST dieselbe Kennung: genau EINE Zahlung');
  const r1 = rev(C.db, 'expenses', C.id);
  const over = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: r1, amount: 70, method: 'cash' }));
  ok(over.kind === 'rejected' && over.code === 'EXPENSE_OVERPAYMENT' && n(C.db, 'SELECT COUNT(*) FROM expense_payments') === payRows,
    'PRIMARY-FIX 70 auf offene 60 wird ABGEWIESEN (vorher still auf 60 gekappt, die Maske meldete 70)');
  // Guthabenbewusst: 30 Guthaben einlösen → offen 30
  nimm(C.db);
  primary(() => house.grantStandaloneCreditInHouse('sup-1', 30, 'cash', undefined, CTX));
  primary(() => house.applySupplierCreditToExpensesInHouse('sup-1', 30, CTX));
  const r2 = rev(C.db, 'expenses', C.id);
  const over2 = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: r2, amount: 31, method: 'cash' }));
  ok(over2.code === 'EXPENSE_OVERPAYMENT', 'RULE der Rest ist guthabenbewusst: 31 auf offene 30 (100 − 40 bar − 30 Guthaben) → Nein');
  const full = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: r2, amount: 30, method: 'cash' }));
  ok(full.kind === 'ok' && full.value.status === 'PAID' && Number(one(C.db, 'SELECT paid_amount FROM expenses WHERE id = ?', [C.id])) === 70, 'PAY genau der Rest → PAID (paid_amount bleibt cash-only: 70)');
  const done = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: rev(C.db, 'expenses', C.id), amount: 1, method: 'cash' }));
  ok(done.code === 'EXPENSE_ALREADY_PAID', 'RULE voll bezahlt → Nein');
  const stale = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: 1, amount: 1, method: 'cash' }));
  ok(stale.code === 'RECORD_CHANGED', 'STALE veraltete Fassung → Nein');
  for (const [b, what] of [[{ amount: -1 }, 'negativ'], [{ amount: 0 }, 'null'], [{ method: 'credit' }, 'Guthaben als Zahlart']] as Array<[Record<string, unknown>, string]>) {
    const x = await fern(() => cmds.runExpensePayment(d, identity(nextId(), 'expenses.record_payment'), { expenseId: C.id, expectedRevision: 9, amount: 5, method: 'cash', ...b }));
    ok(x.kind === 'rejected' && /PAYMENT_(AMOUNT|METHOD)_INVALID/.test(x.code), `RULE Betrag/Methode ${what} → ${x.code}`);
  }
  ok(/the primary decides paidAt/.test(parseFails(() => cmds.parseExpensePayment({ expenseId: C.id, expectedRevision: 1, amount: 1, method: 'cash', paidAt: '2020-01-01' }))), 'PAYLOAD das Zahldatum bestimmt der Primary');
  // Fehler in der Buchung → keine Zahlung
  const F = setup();
  const { db: bad } = failOn(F.db, /INSERT INTO ledger_entries/);
  const idF = nextId();
  const f = await fern(() => cmds.runExpensePayment(deps(bad), identity(idF, 'expenses.record_payment'), { expenseId: F.id, expectedRevision: 1, amount: 10, method: 'cash' }));
  unfail();
  ok(f.kind === 'thrown' && n(F.db, 'SELECT COUNT(*) FROM expense_payments') === 0 && Number(one(F.db, 'SELECT paid_amount FROM expenses WHERE id = ?', [F.id])) === 0
    && lookupCommand(F.db as never, identity(idF, 'expenses.record_payment')).kind === 'fresh', 'ATOMIC scheitert die Buchung, gibt es keine Zahlung (vorher blieb sie ungebucht stehen)');
  // Store-Signatur für die anderen Module: unverändert, jetzt strikt
  useExpenseStore.getState().loadExpenses();
  let code = '';
  try { useExpenseStore.getState().recordExpensePayment(F.id, 500, 'cash'); } catch (e) { code = String((e as { code?: string }).code); }
  ok(code === 'EXPENSE_OVERPAYMENT', 'STORE recordExpensePayment(id, amount, method) weist die Überzahlung ebenso ab');
  useExpenseStore.getState().recordExpensePayment(F.id, 25, 'benefit');
  ok(Number(one(F.db, 'SELECT paid_amount FROM expenses WHERE id = ?', [F.id])) === 25 && net(F.db, 'BENEFIT') === -25, 'STORE die Signatur trägt weiter (RepairDetail/OrderDetail/SupplierDetail öffnen dasselbe Modal)');
  ok(unbalanced(C.db) === 0 && unbalanced(F.db) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_EXPENSE_PAYMENT_PROVED');

// ══ §5 — expenses.template_create ═══════════════════════════════════════════
{
  const tpl = { category: 'Utilities', amount: 25, paymentMethod: 'cash', payNowDefault: true, description: 'Strom', dayOfMonth: 5, startDate: '2026-07-05' };
  const dbP = freshDb();
  const pr = primary(() => house.createTemplateInHouse(house.templateCreateIntent(tpl), CTX));
  const dbC = freshDb();
  const d = deps(dbC);
  const idT = nextId();
  const r = await fern(() => cmds.runTemplateCreate(d, identity(idT, 'expenses.template_create'), tpl));
  const snap = (db: Db) => ({ t: TEMPLATES(db), e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), l: LEDGER(db) });
  ok(pr.ok && r.kind === 'ok' && S(snap(dbP)) === S(snap(dbC)), `PARITY Vorlage + fällige Monate: gleich (${pr.code}/${r.code})`);
  ok(Number(r.value.created) === 3 && S(EXPENSES(dbC).map((x) => x.expense_date)) === S(['2026-07-05', '2026-08-05', '2026-09-05'])
    && one(dbC, 'SELECT last_generated_period FROM recurring_expense_templates') === '2026-09',
  'ATOMIC Juli, August, September in DERSELBEN Buchung wie die Vorlage (vorher danach, mit verschlucktem Fehler)');
  ok(net(dbC, 'CASH', 'EXPENSE_PAYMENT') === -75 && net(dbC, 'EXPENSES_OPERATING') === 75, 'LEDGER je Monat Aufwand + Barzahlung (payNow)');
  const again = await fern(() => cmds.runTemplateCreate(d, identity(idT, 'expenses.template_create'), tpl));
  ok(again.replayed && n(dbC, 'SELECT COUNT(*) FROM recurring_expense_templates') === 1 && n(dbC, 'SELECT COUNT(*) FROM expenses') === 3, 'LOST dieselbe Kennung: eine Vorlage, drei Monate');
  const z = await fern(() => cmds.runTemplateCreate(d, identity(nextId(), 'expenses.template_create'), { ...tpl, amount: 0 }));
  ok(z.code === 'TEMPLATE_AMOUNT_INVALID' && n(dbC, 'SELECT COUNT(*) FROM recurring_expense_templates') === 1, 'PRIMARY-FIX Betrag 0 wird beim Anlegen abgewiesen (vorher angenommen, der Generator scheiterte später still)');
  const dd = await fern(() => cmds.runTemplateCreate(d, identity(nextId(), 'expenses.template_create'), { ...tpl, dayOfMonth: 32 }));
  ok(dd.code === 'TEMPLATE_DAY_INVALID', 'RULE der Tag ist 1..31');
  const sal = await fern(() => cmds.runTemplateCreate(d, identity(nextId(), 'expenses.template_create'), { ...tpl, category: 'Salary' }));
  ok(sal.code === 'EXPENSE_SALARY_NEEDS_EMPLOYEE', 'RULE ein Gehalts-Dauerauftrag braucht einen Mitarbeiter');
  for (const k of ['lastGeneratedPeriod', 'active', 'supplierId', 'branchId']) {
    ok(/the primary decides/.test(parseFails(() => cmds.parseTemplateCreate({ ...tpl, [k]: 'x' }))), `PAYLOAD template_create: ${k} bestimmt der Primary`);
  }
  // Fehler beim zweiten Monat → keine Vorlage, kein Monat
  const dbF = freshDb();
  const { db: bad } = failOn(dbF, /INSERT INTO expenses/, 2);
  const f = await fern(() => cmds.runTemplateCreate(deps(bad), identity(nextId(), 'expenses.template_create'), tpl));
  unfail();
  ok(f.kind === 'thrown' && n(dbF, 'SELECT COUNT(*) FROM recurring_expense_templates') === 0 && n(dbF, 'SELECT COUNT(*) FROM expenses') === 0
    && n(dbF, 'SELECT COUNT(*) FROM ledger_entries') === 0, 'ATOMIC scheitert der zweite Monat, gibt es weder Vorlage noch Monate noch Buchungen');
  ok(unbalanced(dbC) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_TEMPLATE_CREATE_PROVED');

// ══ §6 — expenses.template_update (Pause/Resume/Edit) ═══════════════════════
{
  const setup = (): { db: Db; id: string } => {
    const db = freshDb();
    // Vor der Pause lief der Auftrag bis Juni — seitdem pausiert (Juli, August fehlen absichtlich).
    const t = primary(() => house.createTemplateInHouse(house.templateCreateIntent({
      category: 'Rent', amount: 100, paymentMethod: 'bank', payNowDefault: true, dayOfMonth: 10, startDate: '2026-06-10',
    }), CTX, { active: false }));
    db.run("UPDATE recurring_expense_templates SET last_generated_period = '2026-06' WHERE id = ?", [t.value.templateId]);
    return { db, id: t.value.templateId };
  };
  const C = setup();
  const d = deps(C.db);
  ok(n(C.db, 'SELECT COUNT(*) FROM expenses') === 0 && n(C.db, 'SELECT active FROM recurring_expense_templates') === 0, 'SETUP pausiert, zuletzt Juni');
  const idR = nextId();
  const r0 = rev(C.db, 'recurring_expense_templates', C.id);
  const res = await fern(() => cmds.runTemplateUpdate(d, identity(idR, 'expenses.template_update'), { templateId: C.id, expectedRevision: r0, active: true }));
  ok(res.kind === 'ok' && res.value.resumed === true && Number(res.value.created) === 1
    && S(EXPENSES(C.db).map((x) => x.expense_date)) === S(['2026-09-10']) && one(C.db, 'SELECT last_generated_period FROM recurring_expense_templates') === '2026-09',
  `PRIMARY-FIX Resume holt die Pausenmonate NICHT nach — nur September (vorher Juli, August, September samt Bankzahlungen) (${S(EXPENSES(C.db).map((x) => x.expense_date))})`);
  const again = await fern(() => cmds.runTemplateUpdate(d, identity(idR, 'expenses.template_update'), { templateId: C.id, expectedRevision: r0, active: true }));
  ok(again.replayed && n(C.db, 'SELECT COUNT(*) FROM expenses') === 1, 'LOST dieselbe Kennung: Resume einmal');
  const r1 = rev(C.db, 'recurring_expense_templates', C.id);
  const idPa = nextId();
  const pa = await fern(() => cmds.runTemplateUpdate(d, identity(idPa, 'expenses.template_update'), { templateId: C.id, expectedRevision: r1, active: false }));
  const r2 = rev(C.db, 'recurring_expense_templates', C.id);
  const pa2 = await fern(() => cmds.runTemplateUpdate(d, identity(nextId(), 'expenses.template_update'), { templateId: C.id, expectedRevision: r2, active: false }));
  ok(pa.kind === 'ok' && pa2.kind === 'ok' && S(pa2.value.changed) === '[]' && rev(C.db, 'recurring_expense_templates', C.id) === r2
    && n(C.db, 'SELECT active FROM recurring_expense_templates') === 0, 'TARGET „Pause" ist ein Zielwert: ein zweites Pause schaltet NICHT zurück');
  const stale = await fern(() => cmds.runTemplateUpdate(d, identity(nextId(), 'expenses.template_update'), { templateId: C.id, expectedRevision: r0, amount: 5 }));
  ok(stale.code === 'RECORD_CHANGED' && Number(one(C.db, 'SELECT amount FROM recurring_expense_templates')) === 100, 'STALE ein Formular-Stand von vorher schreibt nichts zurück');
  const zero = await fern(() => cmds.runTemplateUpdate(d, identity(nextId(), 'expenses.template_update'), { templateId: C.id, expectedRevision: r2, amount: 0 }));
  ok(zero.code === 'TEMPLATE_AMOUNT_INVALID', 'PRIMARY-FIX Betrag 0 beim Bearbeiten wird abgewiesen');
  ok(/the primary decides lastGeneratedPeriod/.test(parseFails(() => cmds.parseTemplateUpdate({ templateId: C.id, expectedRevision: r2, lastGeneratedPeriod: '2020-01' }))),
    'PAYLOAD lastGeneratedPeriod kommt NIE vom Client');
  const nb = await fern(() => cmds.runTemplateUpdate(d, identity(nextId(), 'expenses.template_update'), { templateId: C.id, expectedRevision: r2, active: 'yes' }));
  ok(nb.code === 'FIELD_INVALID', 'RULE active ist ein Zielwert true/false');
  // Edit: Primary == PC2
  const P2 = setup();
  const ep = primary(() => house.updateTemplateInHouse(P2.id, house.templateEditFields({ amount: 120, description: 'Miete neu', dayOfMonth: 1 }), CTX, rev(P2.db, 'recurring_expense_templates', P2.id)));
  const C2 = setup();
  const ec = await fern(() => cmds.runTemplateUpdate(deps(C2.db), identity(nextId(), 'expenses.template_update'),
    { templateId: C2.id, expectedRevision: rev(C2.db, 'recurring_expense_templates', C2.id), amount: 120, description: 'Miete neu', dayOfMonth: 1 }));
  ok(ep.ok && ec.kind === 'ok' && S(TEMPLATES(P2.db)) === S(TEMPLATES(C2.db)) && one(C2.db, 'SELECT last_generated_period FROM recurring_expense_templates') === '2026-06'
    && n(C2.db, 'SELECT COUNT(*) FROM expenses') === 0, 'PARITY Bearbeiten: nur die Formularfelder, last_generated_period und active bleiben');
  // Store: setActive ist dieselbe Hausfolge
  const S3 = setup();
  useRecurringExpenseStore.getState().setActive(S3.id, true);
  ok(n(S3.db, 'SELECT COUNT(*) FROM expenses') === 1, 'STORE setActive(true) = dieselbe Resume-Regel am Primary');
  const gen = useRecurringExpenseStore.getState().runDueGenerator();
  ok(gen.created === 0 && gen.errors.length === 0 && n(S3.db, 'SELECT COUNT(*) FROM expenses') === 1, 'STORE der Tageslauf danach erzeugt nichts doppelt');
  ok(unbalanced(C.db) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_TEMPLATE_UPDATE_PROVED');

// ══ §7 — purchases.record_payment ═══════════════════════════════════════════
{
  const pay = (id: string, r: number, amount: number, method = 'cash') => ({ purchaseId: id, expectedRevision: r, amount, method });
  const dbP = freshDb(); seedPurchase(dbP, 'P1', 100);
  const pr = primary(() => house.recordPurchasePaymentInHouse('P1', 40, 'cash', CTX, { expectedRevision: 1 }));
  const dbC = freshDb(); seedPurchase(dbC, 'P1', 100);
  const d = deps(dbC);
  const idP = nextId();
  const r = await fern(() => cmds.runPurchasePayment(d, identity(idP, 'purchases.record_payment'), pay('P1', 1, 40)));
  const snap = (db: Db) => ({ p: PURCHASES(db), pp: PURCHASE_PAYMENTS(db), c: CREDITS(db), l: LEDGER(db) });
  ok(pr.ok && r.kind === 'ok' && S(snap(dbP)) === S(snap(dbC)), `PARITY Einkaufszahlung gleich (${pr.code}/${r.code})`);
  ok(r.value.status === 'PARTIALLY_PAID' && Number(r.value.remainingAmount) === 60 && net(dbC, 'CASH', 'PURCHASE_PAYMENT') === -40, 'LEDGER DR AP 40 / CR Kasse 40 (PURCHASE_PAYMENT)');
  const again = await fern(() => cmds.runPurchasePayment(d, identity(idP, 'purchases.record_payment'), pay('P1', 1, 40)));
  ok(again.replayed && n(dbC, 'SELECT COUNT(*) FROM purchase_payments') === 1, 'LOST dieselbe Kennung: eine Zahlung');
  const stale = await fern(() => cmds.runPurchasePayment(d, identity(nextId(), 'purchases.record_payment'), pay('P1', 1, 10)));
  ok(stale.code === 'RECORD_CHANGED', 'STALE veraltete Fassung → Nein');

  // Guthabenbewusster Rest (der bestätigte Befund)
  const dbK = freshDb(); seedPurchase(dbK, 'PK', 100); seedCredit(dbK, 'CK', 30);
  const dk = deps(dbK);
  const ac = await fern(() => cmds.runPurchaseCredit(dk, identity(nextId(), 'purchases.apply_credit'), { purchaseId: 'PK', expectedRevision: 1, amount: 30 }));
  const pk1 = await fern(() => cmds.runPurchasePayment(dk, identity(nextId(), 'purchases.record_payment'), pay('PK', rev(dbK, 'purchases', 'PK'), 20)));
  ok(ac.kind === 'ok' && pk1.kind === 'ok' && Number(one(dbK, "SELECT remaining_amount FROM purchases WHERE id = 'PK'")) === 50
    && one(dbK, "SELECT status FROM purchases WHERE id = 'PK'") === 'PARTIALLY_PAID',
  'PRIMARY-FIX nach 30 Guthaben + 20 bar ist der Rest 50 (vorher überschrieb die Zahlung ihn mit total − cash = 80)');
  const ov = await fern(() => cmds.runPurchasePayment(dk, identity(nextId(), 'purchases.record_payment'), pay('PK', rev(dbK, 'purchases', 'PK'), 60)));
  ok(ov.code === 'PURCHASE_OVERPAYMENT_WITH_CREDIT' && n(dbK, "SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = 'PK'") === 2,
    'RULE auf einem teils mit Guthaben beglichenen Einkauf wird mehr als offen abgewiesen (sonst verlorenes AP-Soll, keine Gutschrift)');
  const pk2 = await fern(() => cmds.runPurchasePayment(dk, identity(nextId(), 'purchases.record_payment'), pay('PK', rev(dbK, 'purchases', 'PK'), 50)));
  ok(pk2.kind === 'ok' && pk2.value.status === 'PAID' && Number(pk2.value.remainingAmount) === 0 && Number(pk2.value.overpayCredit) === 0, 'PAY genau der Rest → PAID, keine Scheingutschrift');

  // Überzahlung ohne Guthaben → Lieferanten-Guthaben, dieselbe Transaktion
  seedPurchase(dbC, 'P2', 50);
  const o = await fern(() => cmds.runPurchasePayment(d, identity(nextId(), 'purchases.record_payment'), pay('P2', 1, 60)));
  ok(o.kind === 'ok' && o.value.status === 'PAID' && Number(o.value.overpayCredit) === 10
    && n(dbC, "SELECT COUNT(*) FROM supplier_credits WHERE source_purchase_id = 'P2' AND source_return_id IS NULL AND amount = 10 AND status = 'OPEN'") === 1
    && net(dbC, 'SUPPLIER_CREDIT', 'PURCHASE_OVERPAY') === 10, 'OVERPAY 10 zu viel → Lieferanten-Guthaben 10 (DR SUPPLIER_CREDIT / CR AP, PURCHASE_OVERPAY)');
  const dbF = freshDb(); seedPurchase(dbF, 'P3', 50);
  const { db: bad } = failOn(dbF, /INSERT INTO supplier_credits/);
  const f = await fern(() => cmds.runPurchasePayment(deps(bad), identity(nextId(), 'purchases.record_payment'), pay('P3', 1, 60)));
  unfail();
  ok(f.kind === 'thrown' && n(dbF, 'SELECT COUNT(*) FROM purchase_payments') === 0 && Number(one(dbF, "SELECT paid_amount FROM purchases WHERE id = 'P3'")) === 0
    && n(dbF, 'SELECT COUNT(*) FROM ledger_entries') === 0, 'ATOMIC scheitert die Gutschrift, gibt es auch die Zahlung nicht (vorher eigene Klammer danach)');

  seedPurchase(dbC, 'P4', 30, { status: 'CANCELLED' });
  const cx = await fern(() => cmds.runPurchasePayment(d, identity(nextId(), 'purchases.record_payment'), pay('P4', 1, 10)));
  ok(cx.code === 'PURCHASE_CANCELLED', 'PRIMARY-FIX storniert → Nein (vorher stilles Nichts, die Maske schloss als Erfolg)');
  seedPurchase(dbC, 'P5', 30);
  for (const [b, code] of [[{ amount: 0 }, 'PAYMENT_AMOUNT_INVALID'], [{ amount: -3 }, 'PAYMENT_AMOUNT_INVALID'], [{ method: 'credit' }, 'PAYMENT_METHOD_INVALID']] as Array<[Record<string, unknown>, string]>) {
    const x = await fern(() => cmds.runPurchasePayment(d, identity(nextId(), 'purchases.record_payment'), { ...pay('P5', 1, 10), ...b }));
    ok(x.code === code, `RULE ${S(b)} → ${code} (${x.code})`);
  }
  seedPurchase(dbC, 'PX', 30, { branch: 'branch-other', supplier: 'sup-x' });
  const fx = await fern(() => cmds.runPurchasePayment(d, identity(nextId(), 'purchases.record_payment'), pay('PX', 1, 10)));
  ok(fx.code === 'PURCHASE_NOT_FOUND', 'SECURITY ein Einkauf einer anderen Filiale ist hier nicht vorhanden');
  for (const k of ['paidAmount', 'remainingAmount', 'status', 'totalAmount', 'paidAt', 'creditId']) {
    ok(/the primary decides/.test(parseFails(() => cmds.parsePurchasePayment({ ...pay('P5', 1, 1), [k]: 1 }))), `PAYLOAD purchases.record_payment: ${k} bestimmt der Primary`);
  }
  // purchases.create (R5E) bleibt unberührt: die Store-Aktion addPayment trägt die Signatur weiter
  nimm(dbC);
  usePurchaseStore.getState().loadPurchases();
  usePurchaseStore.getState().addPayment('P5', 5, 'bank', 'REF-1');
  ok(Number(one(dbC, "SELECT paid_amount FROM purchases WHERE id = 'P5'")) === 5 && one(dbC, "SELECT reference FROM purchase_payments WHERE purchase_id = 'P5'") === 'REF-1',
    'STORE addPayment(id, amount, method, reference) läuft durch dieselbe Hausfolge');
  ok(unbalanced(dbC) === 0 && unbalanced(dbK) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_PURCHASE_PAYMENT_PROVED');

// ══ §8 — purchases.apply_credit ═════════════════════════════════════════════
{
  const setup = (): Db => {
    const db = freshDb();
    seedPurchase(db, 'P1', 100);
    seedCredit(db, 'C1', 20, { created: '2026-09-01T00:00:00.000Z' });
    seedCredit(db, 'C2', 30, { created: '2026-09-02T00:00:00.000Z' });
    // Älter und größer — aber in einer ANDEREN Filiale: die alte Maskenschleife hätte es zuerst genommen.
    seedCredit(db, 'CX', 100, { branch: 'branch-other', created: '2026-08-01T00:00:00.000Z' });
    return db;
  };
  const dbP = setup();
  const pr = primary(() => house.applyCreditToPurchaseInHouse('P1', 40, CTX, 1));
  const dbC = setup();
  const d = deps(dbC);
  const idA = nextId();
  const r = await fern(() => cmds.runPurchaseCredit(d, identity(idA, 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: 1, amount: 40 }));
  const snap = (db: Db) => ({ p: PURCHASES(db), pp: PURCHASE_PAYMENTS(db), c: CREDITS(db), l: LEDGER(db) });
  ok(pr.ok && r.kind === 'ok' && S(snap(dbP)) === S(snap(dbC)), `PARITY Guthaben auf Einkauf gleich (${pr.code}/${r.code})`);
  const cr = Object.fromEntries(rows(dbC, 'SELECT id, used_amount, status FROM supplier_credits').map((x) => [x.id, `${x.used_amount}/${x.status}`]));
  ok(cr.C1 === '20/USED' && cr.C2 === '20/OPEN' && cr.CX === '0/OPEN', `FIFO C1 ganz, dann C2 — das fremde Guthaben bleibt unberührt (${S(cr)})`);
  ok(S(PURCHASE_PAYMENTS(dbC).map((x) => [x.amount, x.method, x.reference])) === S([[20, 'credit', 'C1'], [20, 'credit', 'C2']])
    && net(dbC, 'SUPPLIER_CREDIT', 'PURCHASE_PAYMENT') === -40 && Number(r.value.remainingAmount) === 60,
  'LEDGER DR AP 40 / CR SUPPLIER_CREDIT 40; je Guthabenzeile eine Zahlungszeile mit Verweis');
  const again = await fern(() => cmds.runPurchaseCredit(d, identity(idA, 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: 1, amount: 40 }));
  ok(again.replayed && n(dbC, 'SELECT COUNT(*) FROM purchase_payments') === 2, 'LOST dieselbe Kennung: einmal eingelöst');
  const r2 = rev(dbC, 'purchases', 'P1');
  const insuf = await fern(() => cmds.runPurchaseCredit(d, identity(nextId(), 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: r2, amount: 20 }));
  ok(insuf.code === 'SUPPLIER_CREDIT_INSUFFICIENT' && n(dbC, 'SELECT COUNT(*) FROM purchase_payments') === 2,
    'PRIMARY-FIX 20 bei verfügbaren 10 (in DIESER Filiale) → ganz abgewiesen, kein stiller Teilbetrag');
  const exc = await fern(() => cmds.runPurchaseCredit(d, identity(nextId(), 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: r2, amount: 70 }));
  ok(exc.code === 'PURCHASE_CREDIT_EXCEEDS_OPEN', 'RULE mehr als offen (60) → Nein');
  const st = await fern(() => cmds.runPurchaseCredit(d, identity(nextId(), 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: 1, amount: 5 }));
  ok(st.code === 'RECORD_CHANGED', 'STALE veraltete Fassung → Nein');
  ok(/the primary decides creditId/.test(parseFails(() => cmds.parsePurchaseCredit({ purchaseId: 'P1', expectedRevision: 1, amount: 5, creditId: 'CX' }))),
    'PAYLOAD welche Guthabenzeile, entscheidet der Primary (FIFO) — kein creditId vom Client');
  const dbF = setup();
  const { db: bad } = failOn(dbF, /UPDATE supplier_credits/, 2);
  const f = await fern(() => cmds.runPurchaseCredit(deps(bad), identity(nextId(), 'purchases.apply_credit'), { purchaseId: 'P1', expectedRevision: 1, amount: 40 }));
  unfail();
  ok(f.kind === 'thrown' && n(dbF, 'SELECT used_amount FROM supplier_credits WHERE id = ?', ['C1']) === 0 && n(dbF, 'SELECT COUNT(*) FROM purchase_payments') === 0
    && n(dbF, 'SELECT COUNT(*) FROM ledger_entries') === 0, 'ATOMIC scheitert die zweite Guthabenzeile, ist auch die erste nicht verbraucht (vorher eine Schleife ohne Klammer)');
  ok(unbalanced(dbC) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_PURCHASE_CREDIT_PROVED');

// ══ §9 — suppliers.refund_credit ════════════════════════════════════════════
{
  const setup = (): { db: Db; creditId: string } => {
    const db = freshDb();
    const g = primary(() => house.grantStandaloneCreditInHouse('sup-1', 25, 'bank', undefined, CTX));
    return { db, creditId: g.value };
  };
  const P = setup();
  const pr = primary(() => house.refundStandaloneCreditInHouse(P.creditId, CTX));
  const C = setup();
  const d = deps(C.db);
  const idR = nextId();
  const r = await fern(() => cmds.runSupplierRefund(d, identity(idR, 'suppliers.refund_credit'), { creditId: C.creditId }));
  ok(pr.ok && r.kind === 'ok' && S({ c: CREDITS(P.db), l: LEDGER(P.db) }) === S({ c: CREDITS(C.db), l: LEDGER(C.db) }), `PARITY Rückbuchung gleich (${pr.code}/${r.code})`);
  ok(n(C.db, 'SELECT COUNT(*) FROM supplier_credits') === 0 && net(C.db, 'BANK', 'SUPPLIER_PREPAYMENT') === 0 && net(C.db, 'SUPPLIER_CREDIT') === 0
    && r.value.method === 'Bank', 'LEDGER reverseSource SUPPLIER_PREPAYMENT: das Geld ist zurück auf der Bank, das Guthaben weg');
  const ledgerRows = n(C.db, 'SELECT COUNT(*) FROM ledger_entries');
  const again = await fern(() => cmds.runSupplierRefund(d, identity(idR, 'suppliers.refund_credit'), { creditId: C.creditId }));
  ok(again.replayed && n(C.db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerRows, 'LOST dieselbe Kennung: EINE Rückbuchung');
  const twice = await fern(() => cmds.runSupplierRefund(d, identity(nextId(), 'suppliers.refund_credit'), { creditId: C.creditId }));
  ok(twice.code === 'SUPPLIER_CREDIT_NOT_FOUND', 'RULE ein zweiter Refund (neue Kennung) findet nichts mehr');
  const U = setup();
  U.db.run('UPDATE supplier_credits SET used_amount = 5 WHERE id = ?', [U.creditId]);
  const used = await fern(() => cmds.runSupplierRefund(deps(U.db), identity(nextId(), 'suppliers.refund_credit'), { creditId: U.creditId }));
  ok(used.code === 'SUPPLIER_CREDIT_REDEEMED' && n(U.db, 'SELECT COUNT(*) FROM supplier_credits') === 1, 'RULE ein (teil-)eingelöstes Guthaben wird nicht zurückgebucht');
  const X = setup();
  X.db.run("UPDATE supplier_credits SET branch_id = 'branch-other' WHERE id = ?", [X.creditId]);
  const fx = await fern(() => cmds.runSupplierRefund(deps(X.db), identity(nextId(), 'suppliers.refund_credit'), { creditId: X.creditId }));
  ok(fx.code === 'SUPPLIER_CREDIT_NOT_FOUND' && n(X.db, 'SELECT COUNT(*) FROM supplier_credits') === 1, 'SECURITY neu: ein Guthaben einer anderen Filiale ist hier nicht vorhanden');
  ok(/unknown field/.test(parseFails(() => cmds.parseSupplierRefund({ creditId: 'x', amount: 5 }))) || /the primary decides/.test(parseFails(() => cmds.parseSupplierRefund({ creditId: 'x', amount: 5 }))),
    'PAYLOAD der Refund trägt nur die Kennung');
  ok(unbalanced(C.db) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_REFUND_PROVED');

// ══ §10 — suppliers.pay ═════════════════════════════════════════════════════
{
  const setup = (): { db: Db; e1: string } => {
    const db = freshDb();
    const e1 = makeExpense({ amount: 100, expenseDate: '2026-09-01' }, at('2026-09-01T08:00:00.000Z'));
    primary(() => house.grantStandaloneCreditInHouse('sup-1', 30, 'cash', undefined, CTX));
    primary(() => house.applySupplierCreditToExpensesInHouse('sup-1', 30, CTX));
    seedPurchase(db, 'P1', 50, { date: '2026-09-02' });
    return { db, e1 };
  };
  const P = setup();
  const pr = primary(() => house.paySupplierInHouse({ supplierId: 'sup-1', amount: 150, method: 'cash', mode: 'fifo' }, CTX));
  const C = setup();
  const d = deps(C.db);
  const idS = nextId();
  const r = await fern(() => cmds.runSupplierPay(d, identity(idS, 'suppliers.pay'), { supplierId: 'sup-1', amount: 150, method: 'cash', mode: 'fifo' }));
  const snap = (db: Db) => ({ e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), p: PURCHASES(db), pp: PURCHASE_PAYMENTS(db), c: CREDITS(db), l: LEDGER(db) });
  ok(pr.ok && r.kind === 'ok' && S(snap(P.db)) === S(snap(C.db)), `PARITY Sammelzahlung gleich (${pr.code}/${r.code})`);
  const alloc = (r.value.allocations as Array<{ kind: string; amount: number }>).map((a) => `${a.kind}:${a.amount}`);
  ok(S(alloc) === S(['expense:70', 'purchase:50']) && Number(r.value.excessAmount) === 30 && r.value.excessTo === 'purchase_overpay',
    `PRIMARY-FIX FIFO rechnet den Rest der Ausgabe guthabenbewusst: 70 (nicht 100), dann der Einkauf 50, Überschuss 30 (${S(alloc)})`);
  ok(one(C.db, 'SELECT status FROM expenses WHERE id = ?', [C.e1]) === 'PAID' && Number(one(C.db, 'SELECT paid_amount FROM expenses WHERE id = ?', [C.e1])) === 70
    && n(C.db, "SELECT COUNT(*) FROM supplier_credits WHERE source_purchase_id = 'P1' AND source_return_id IS NULL AND amount = 30") === 1,
  'PRIMARY-FIX der Überschuss geht nicht verloren: Einkauf überzahlt → 30 Lieferanten-Guthaben (vorher kappte die Zahlung still, 30 verschwanden)');
  const counts = (db: Db) => [n(db, 'SELECT COUNT(*) FROM expense_payments'), n(db, 'SELECT COUNT(*) FROM purchase_payments'), n(db, 'SELECT COUNT(*) FROM ledger_entries')].join('/');
  const before = counts(C.db);
  const again = await fern(() => cmds.runSupplierPay(d, identity(idS, 'suppliers.pay'), { supplierId: 'sup-1', amount: 150, method: 'cash', mode: 'fifo' }));
  ok(again.replayed && counts(C.db) === before, 'PRIMARY-FIX verlorene Antwort, dieselbe Kennung: nichts wird zweimal gezahlt (vorher zahlte ein Wiederholen die ersten Posten doppelt)');
  // Manuell
  const M = setup();
  const dm = deps(M.db);
  for (const [allocs, amount, code] of [
    [[{ kind: 'expense', id: M.e1, amount: 70 }], 100, 'ALLOCATION_SUM_MISMATCH'],
    [[{ kind: 'expense', id: M.e1, amount: 80 }], 80, 'ALLOCATION_EXCEEDS_REMAINING'],
    [[{ kind: 'purchase', id: 'nope', amount: 10 }], 10, 'ALLOCATION_UNKNOWN_ITEM'],
    [[{ kind: 'expense', id: M.e1, amount: 10 }, { kind: 'expense', id: M.e1, amount: 10 }], 20, 'ALLOCATION_DUPLICATE'],
  ] as Array<[Array<Record<string, unknown>>, number, string]>) {
    const x = await fern(() => cmds.runSupplierPay(dm, identity(nextId(), 'suppliers.pay'), { supplierId: 'sup-1', amount, method: 'bank', mode: 'manual', allocations: allocs }));
    ok(x.code === code, `MANUAL ${code} (${x.code})`);
  }
  const mOk = await fern(() => cmds.runSupplierPay(dm, identity(nextId(), 'suppliers.pay'),
    { supplierId: 'sup-1', amount: 60, method: 'bank', mode: 'manual', allocations: [{ kind: 'expense', id: M.e1, amount: 20 }, { kind: 'purchase', id: 'P1', amount: 40 }] }));
  ok(mOk.kind === 'ok' && Number(one(M.db, "SELECT paid_amount FROM purchases WHERE id = 'P1'")) === 40 && Number(mOk.value.excessAmount) === 0, 'MANUAL gültige Verteilung, Σ = Betrag');
  ok(/FIFO/.test(parseFails(() => cmds.parseSupplierPay({ supplierId: 'sup-1', amount: 5, method: 'cash', mode: 'fifo', allocations: [] }))), 'PAYLOAD bei FIFO verteilt der Primary');
  ok(/names its allocations/.test(parseFails(() => cmds.parseSupplierPay({ supplierId: 'sup-1', amount: 5, method: 'cash', mode: 'manual' }))), 'PAYLOAD manuell nennt die Verteilung');
  for (const k of ['excess', 'overpayCredit', 'creditId', 'paidAmount']) {
    ok(/the primary decides/.test(parseFails(() => cmds.parseSupplierPay({ supplierId: 'sup-1', amount: 5, method: 'cash', mode: 'fifo', [k]: 1 }))), `PAYLOAD suppliers.pay: ${k} bestimmt der Primary`);
  }
  const none = await fern(() => cmds.runSupplierPay(dm, identity(nextId(), 'suppliers.pay'), { supplierId: 'sup-2', amount: 10, method: 'cash', mode: 'fifo' }));
  ok(none.code === 'SUPPLIER_NOTHING_OPEN', 'RULE ohne offenen Posten keine Zahlung (die Maske zeigt dann „Nothing open")');
  const fx = await fern(() => cmds.runSupplierPay(dm, identity(nextId(), 'suppliers.pay'), { supplierId: 'sup-x', amount: 10, method: 'cash', mode: 'fifo' }));
  ok(fx.code === 'SUPPLIER_NOT_FOUND', 'SECURITY ein Lieferant einer anderen Filiale ist hier nicht vorhanden');
  // Überschuss ohne Einkauf → Standalone-Guthaben
  const dbE = freshDb();
  makeExpense({ supplierId: 'sup-2', amount: 40 });
  const ex = await fern(() => cmds.runSupplierPay(deps(dbE), identity(nextId(), 'suppliers.pay'), { supplierId: 'sup-2', amount: 50, method: 'cash', mode: 'fifo' }));
  ok(ex.kind === 'ok' && ex.value.excessTo === 'standalone_credit' && net(dbE, 'SUPPLIER_CREDIT', 'SUPPLIER_PREPAYMENT') === 10 && net(dbE, 'CASH') === -50,
    'EXCESS ohne tragfähigen Einkauf → 10 Standalone-Guthaben (DR SUPPLIER_CREDIT / CR Kasse, SUPPLIER_PREPAYMENT)');
  // Atomar: der Einkauf scheitert → auch die Ausgabenzahlung ist nicht da
  const F = setup();
  const fBefore = counts(F.db);
  const { db: bad } = failOn(F.db, /INSERT INTO purchase_payments/);
  const f = await fern(() => cmds.runSupplierPay(deps(bad), identity(nextId(), 'suppliers.pay'), { supplierId: 'sup-1', amount: 150, method: 'cash', mode: 'fifo' }));
  unfail();
  ok(f.kind === 'thrown' && counts(F.db) === fBefore && Number(one(F.db, 'SELECT paid_amount FROM expenses WHERE id = ?', [F.e1])) === 0,
    'ATOMIC scheitert der zweite Posten, ist auch der erste nicht bezahlt (vorher blieb er stehen)');
  ok(unbalanced(C.db) === 0 && unbalanced(dbE) === 0 && unbalanced(M.db) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_SUPPLIER_PAY_PROVED');

// ══ §11 — suppliers.apply_credit ════════════════════════════════════════════
{
  const setup = (credit = 80): Db => {
    const db = freshDb();
    primary(() => house.grantStandaloneCreditInHouse('sup-1', credit, 'bank', undefined, CTX));
    makeExpense({ amount: 30, expenseDate: '2026-09-01' }, at('2026-09-01T08:00:00.000Z'));
    makeExpense({ amount: 40, expenseDate: '2026-09-03' }, at('2026-09-03T08:00:00.000Z'));
    return db;
  };
  const dbP = setup();
  const pr = primary(() => house.applySupplierCreditToExpensesInHouse('sup-1', 60, CTX));
  const dbC = setup();
  const d = deps(dbC);
  const idC = nextId();
  const r = await fern(() => cmds.runSupplierCredit(d, identity(idC, 'suppliers.apply_credit'), { supplierId: 'sup-1', amount: 60 }));
  const snap = (db: Db) => ({ e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), c: CREDITS(db), l: LEDGER(db) });
  ok(pr.ok && r.kind === 'ok' && S(snap(dbP)) === S(snap(dbC)), `PARITY Guthaben gegen Ausgaben gleich (${pr.code}/${r.code})`);
  ok(S(EXPENSES(dbC).map((x) => x.status)) === S(['PAID', 'PENDING']) && S(EXPENSE_PAYMENTS(dbC).map((x) => [x.amount, x.method])) === S([[30, 'credit'], [30, 'credit']])
    && Number(one(dbC, 'SELECT used_amount FROM supplier_credits')) === 60, 'FIFO älteste Ausgabe zuerst: 30 (bezahlt), dann 30 von 40');
  ok(net(dbC, 'SUPPLIER_CREDIT', 'EXPENSE_PAYMENT') === -60 && net(dbC, 'ACCOUNTS_PAYABLE', 'EXPENSE_PAYMENT') === 60, 'LEDGER DR AP 60 / CR SUPPLIER_CREDIT 60 (postExpenseSupplierCreditPayment)');
  let b1 = -1;
  try { b1 = n(dbC, 'SELECT COUNT(*) FROM b1_operations'); } catch { b1 = 0; }
  ok(b1 === 0, 'PRIMARY-FIX kein Alt-Sync-Server, keine „pending"-Zeile in b1_operations — der atomare lokale Schreiber (vorher kam es am Primary NIE an)');
  const again = await fern(() => cmds.runSupplierCredit(d, identity(idC, 'suppliers.apply_credit'), { supplierId: 'sup-1', amount: 60 }));
  ok(again.replayed && n(dbC, "SELECT COUNT(*) FROM expense_payments WHERE method = 'credit'") === 2, 'LOST dieselbe Kennung: einmal eingelöst');
  const exOpen = await fern(() => cmds.runSupplierCredit(d, identity(nextId(), 'suppliers.apply_credit'), { supplierId: 'sup-1', amount: 20 }));
  ok(exOpen.code === 'SUPPLIER_CREDIT_EXCEEDS_OPEN', 'RULE mehr als die offenen Ausgaben (10) → Nein');
  const low = setup(20);
  const exCr = await fern(() => cmds.runSupplierCredit(deps(low), identity(nextId(), 'suppliers.apply_credit'), { supplierId: 'sup-1', amount: 30 }));
  ok(exCr.code === 'SUPPLIER_CREDIT_INSUFFICIENT' && n(low, "SELECT COUNT(*) FROM expense_payments WHERE method = 'credit'") === 0, 'RULE mehr als verfügbar (20) → Nein, nichts eingelöst');
  const fx = await fern(() => cmds.runSupplierCredit(d, identity(nextId(), 'suppliers.apply_credit'), { supplierId: 'sup-x', amount: 1 }));
  ok(fx.code === 'SUPPLIER_NOT_FOUND', 'SECURITY ein Lieferant einer anderen Filiale ist hier nicht vorhanden');
  ok(/the primary decides/.test(parseFails(() => cmds.parseSupplierCredit({ supplierId: 'sup-1', amount: 1, allocations: [] }))) || /unknown field/.test(parseFails(() => cmds.parseSupplierCredit({ supplierId: 'sup-1', amount: 1, allocations: [] }))),
    'PAYLOAD die Verteilung des Guthabens gibt der Client nicht vor');
  const F = setup();
  // Die dritte Ledger-Zeile ist das erste Bein der ZWEITEN Einlösungsbuchung.
  const { db: bad } = failOn(F, /INSERT INTO ledger_entries/, 3);
  const f = await fern(() => cmds.runSupplierCredit(deps(bad), identity(nextId(), 'suppliers.apply_credit'), { supplierId: 'sup-1', amount: 60 }));
  unfail();
  ok(f.kind === 'thrown' && n(F, "SELECT COUNT(*) FROM expense_payments WHERE method = 'credit'") === 0 && n(F, 'SELECT used_amount FROM supplier_credits') === 0,
    'ATOMIC scheitert die zweite Einlösungsbuchung, ist nichts eingelöst');
  ok(unbalanced(dbC) === 0, 'LEDGER jede Transaktion ausgeglichen');
}
marker('CENTRAL_UI_R6D_PAYABLES_SUPPLIER_CREDIT_PROVED');

// ══ §12 — suppliers.credits.get ═════════════════════════════════════════════
{
  const db = freshDb();
  seedCredit(db, 'C1', 20);
  seedCredit(db, 'C2', 30, { used: 5 });
  seedCredit(db, 'CX', 100, { branch: 'branch-other' });
  const main = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
  const reply = await registry.executeCommand('suppliers.credits.get', { actor: main, input: { supplierId: 'sup-1' } });
  const v = reply.kind === 'ok' ? (reply.value as { data: { credits: Array<{ id: string }>; availableAmount: number } }).data : null;
  ok(!!v && S(v.credits.map((c) => c.id).sort()) === S(['C1', 'C2']) && v.availableAmount === 45, `READ nur die Guthaben DIESER Filiale, verfügbar 45 (${S(v)})`);
  const other = supplierCreditsFor({ ...main, branchId: 'branch-other' }, 'sup-1');
  ok(S(other.credits.map((c) => c.id)) === S(['CX']), 'READ ein Anfragender einer anderen Filiale sieht nur seine');
  const noId = await registry.executeCommand('suppliers.credits.get', { actor: main, input: {} });
  ok(noId.kind === 'business_error' && noId.code === 'INPUT_REQUIRED', 'READ ohne Lieferant: ein Nein, kein Leerlauf');
}
marker('CENTRAL_UI_R6D_PAYABLES_CREDITS_READ_PROVED');

// ══ §13 — die Primary-Maske: runOnPrimary ═══════════════════════════════════
{
  const db = freshDb();
  const local = { remote: false, save: <T,>(a: never) => runSharedWrite<T>(false, a, null) };
  const r = await save.saveExpenseCreate(local as never, { category: 'Transport', amount: 12, paymentMethod: 'cash', expenseDate: '2026-09-02', timing: 'now' });
  ok(r.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM expenses') === 1 && Number(one(db, 'SELECT paid_amount FROM expenses')) === 12
    && useExpenseStore.getState().expenses.length === 1, 'UI am Primary: Hausfolge in der Schreibreihenfolge, danach ist die Liste frisch');
  const bad = await save.saveExpenseCreate(local as never, { category: 'Transport', amount: 12, paymentMethod: 'cash', expenseDate: '2026-09-02', timing: 'partial', partialAmount: 20 });
  ok(bad.kind === 'business_error' && (bad as { code: string }).code === 'EXPENSE_PARTIAL_INVALID' && n(db, 'SELECT COUNT(*) FROM expenses') === 1,
    'UI dieselbe Regel VOR dem Schreiben: 20 „jetzt bezahlt" auf 12 → Nein (vorher still gekappt)');
  const exp = useExpenseStore.getState().expenses[0];
  const over = await save.saveExpensePayment(local as never, { ...exp, paidAmount: 0 } as never, 1, 'cash');
  ok(over.kind === 'business_error' && (over as { code: string }).code === 'EXPENSE_ALREADY_PAID', 'UI das Nein des Hauses erreicht die Maske als Meldung (kein Schließen)');
  const stale = await save.saveExpenseUpdate(local as never, { ...exp, revision: 99 } as never, { ...exp, amount: 15 });
  ok(stale.kind === 'business_error' && (stale as { code: string }).code === 'RECORD_CHANGED', 'UI auch am Primary wird eine veraltete Fassung abgewiesen');
  const same = await save.saveExpenseUpdate(local as never, exp, { ...exp });
  ok(same.kind === 'ok' && S((same as { value: { changed: unknown } }).value.changed) === '[]', 'UI unverändertes Formular: keine Buchung');
  const gen = await save.runDueGeneratorOnPrimary();
  ok(gen.errors.length === 0, 'UI der Tageslauf der Ausgabenliste läuft exklusiv');
}
marker('CENTRAL_UI_R6D_PAYABLES_PRIMARY_UI_PROVED');

// ══ §14 — Client ohne Bücher ════════════════════════════════════════════════
{
  const db = freshDb();
  const e1 = makeExpense({ amount: 50 });
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (body.op === 'expenses.record_payment') return new Response(JSON.stringify({ ok: true, value: { expenseId: e1, status: 'PENDING', replayed: false } }), { status: 200 });
    if (String(body.op).startsWith('store.')) return new Response(JSON.stringify({ ok: true, value: { data: {} } }), { status: 200 });
    return new Response('{}', { status: 500 });
  }) as never;
  try {
    const before = S({ e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), l: n(db, 'SELECT COUNT(*) FROM ledger_entries') });
    const ctl = new CommandSaveController<Record<string, unknown>>('expenses.record_payment');
    const write = { remote: true, save: <T,>(a: never) => runSharedWrite<T>(true, a, ctl.beginAttempt()) };
    const r = await save.saveExpensePayment(write as never, { id: e1, revision: 1 } as never, 20, 'cash');
    const cmd = calls.find((c) => c.body.op === 'expenses.record_payment');
    ok(r.kind === 'ok' && !!cmd && S(Object.keys(cmd.body.payload as object).sort()) === S(['amount', 'expectedRevision', 'expenseId', 'method']),
      `CLIENT die Maske schickt die Absicht über die Brücke — Betrag, Methode, Fassung, sonst nichts (${S(cmd?.body.payload)})`);
    ok(S({ e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), l: n(db, 'SELECT COUNT(*) FROM ledger_entries') }) === before, 'CLIENT keine lokale Zeile, keine lokale Buchung');
    const noRev = await save.saveExpensePayment(write as never, { id: e1 } as never, 20, 'cash');
    ok(noRev.kind === 'business_error' && (noRev as { code: string }).code === 'REVISION_UNKNOWN', 'CLIENT ohne gesehene Fassung wird nicht geschickt');
    let code = '';
    try { useExpenseStore.getState().recordExpensePayment(e1, 5, 'cash'); } catch (e) { code = String((e as { code?: string }).code); }
    ok(code === 'CLIENT_HAS_NO_BOOKS', 'CLIENT die Store-Aktion verweigert den lokalen Schreibweg');
    let code2 = '';
    try { house.createExpenseInHouse({ category: 'Rent', amount: 1, paymentMethod: 'cash', expenseDate: '2026-09-01', initialPaid: 0 }, CTX); } catch (e) { code2 = String((e as { code?: string }).code); }
    ok(code2 === 'CLIENT_HAS_NO_BOOKS', 'CLIENT auch die Hausfolge selbst schreibt auf einem Rechner ohne Bücher nichts');
    const gen = useRecurringExpenseStore.getState().runDueGenerator();
    ok(gen.created === 0 && S({ e: EXPENSES(db), ep: EXPENSE_PAYMENTS(db), l: n(db, 'SELECT COUNT(*) FROM ledger_entries') }) === before, 'CLIENT kein Tageslauf auf PC2');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
  }
}
marker('CENTRAL_UI_R6D_PAYABLES_CLIENT_NO_LOCAL_WRITE_PROVED');

// ══ §15 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  const pe = codeOf(src('src/components/expenses/PayExpenseModal.tsx'));
  ok(/saveExpensePayment\(zahlen, exp, amount, method\)/.test(pe) && !/recordExpensePayment\(/.test(pe) && /data-expense-pay-save/.test(pe) && /data-expense-pay-amount/.test(pe) && /data-expense-pay-method/.test(pe),
    'UI PayExpenseModal: EINE Buchung — erbt ExpenseList, SupplierDetail, RepairDetail, OrderDetail');
  const el = codeOf(src('src/pages/expenses/ExpenseList.tsx'));
  ok(/saveExpenseCreate\(/.test(el) && /saveTemplateCreate\(/.test(el) && /saveTemplateUpdate\(/.test(el) && /saveExpenseUpdate\(/.test(el)
    && !/\bcreateExpense\(|\bupdateExpense\(|setRecurringActive\(|createRecurringTemplate\(|updateRecurringTemplate\(|runRecurringGenerator\(/.test(el),
  'UI ExpenseList: Anlegen, Aendern, Vorlage, Pause/Resume — kein direkter Store-Schreibweg mehr');
  ok(/active: !t\.active/.test(el) && /lastGeneratedPeriod: _haus/.test(el), 'UI Pause/Resume schickt den Zielwert; das Bearbeiten lässt active/lastGeneratedPeriod weg');
  for (const a of ['data-expense-create-save', 'data-expense-amount', 'data-expense-timing', 'data-expense-partial', 'data-expense-method', 'data-template-toggle', 'data-template-save', 'data-expense-edit-save']) {
    ok(el.includes(a), `UI ExpenseList trägt ${a}`);
  }
  const pd = codeOf(src('src/pages/purchases/PurchaseDetail.tsx'));
  ok(/savePurchasePayment\(/.test(pd) && /savePurchaseCredit\(/.test(pd) && !/\baddPayment\(|applyCreditToPurchase\(|getOpenCredits\(/.test(pd)
    && /'suppliers\.credits\.get'/.test(pd) && /data-purchase-pay-save/.test(pd) && /data-purchase-credit-save/.test(pd),
  'UI PurchaseDetail: Zahlung und Credit-Modus je EINE Buchung, Guthaben aus der Auskunft — keine Schleife in der Maske');
  const sd = codeOf(src('src/pages/suppliers/SupplierDetail.tsx'));
  ok(/saveSupplierRefund\(erstatten, refundCredit\.id\)/.test(sd) && !/deleteStandaloneSupplierCredit\(|getSupplierCreditsForDisplay\(/.test(sd)
    && /data-supplier-refund-save/.test(sd) && /data-supplier-pay-open/.test(sd) && /Return gold/.test(sd),
  'UI SupplierDetail: Refund ist EINE Buchung; die Gold-Knöpfe sind unberührt');
  const ps = codeOf(src('src/components/expenses/PaySupplierModal.tsx'));
  ok(/saveSupplierPay\(/.test(ps) && /saveSupplierCredit\(/.test(ps)
    && !/applySupplierCreditViaServer|recordExpensePayment\(|addPurchasePayment\(|grantStandaloneCredit\(|getOpenCredits\(/.test(ps)
    && /planSupplierPayment\(/.test(ps) && /data-supplier-pay-save/.test(ps) && /data-supplier-credit-save/.test(ps) && /data-supplier-pay-mode/.test(ps),
  'UI PaySupplierModal: Zahlung und Guthaben je EINE Buchung, Vorschau mit DEMSELBEN Planer wie das Haus, kein Alt-Sync-Server');
  const houseSrc = codeOf(src('src/core/payables/payables-house.ts'));
  ok(!/safePost|'branch-main'|beginLedgerTransaction\(\);\s*try \{\s*const out/.test(houseSrc.replace(/export function atomar[\s\S]*?\n}\n/, '')), 'DOMAIN die Hausfolge bucht strikt, ohne stilles branch-main, ohne eigene Klammer (ausser `atomar` für Altaufrufer)');
  const stores = ['src/stores/expenseStore.ts', 'src/stores/purchaseStore.ts', 'src/stores/supplierStore.ts', 'src/stores/recurringExpenseStore.ts'].map((f) => codeOf(src(f))).join('\n');
  ok(/createExpenseInHouse\(/.test(stores) && /recordExpensePaymentInHouse\(/.test(stores) && /recordPurchasePaymentInHouse\(/.test(stores)
    && /refundStandaloneCreditInHouse\(/.test(stores) && /applySupplierCreditToExpensesInHouse\(/.test(stores) && /updateTemplateInHouse\(/.test(stores),
  'DOMAIN die Store-Aktionen (Signaturen unverändert) rufen dieselbe Hausfolge — EINE Implementierung');
}
marker('CENTRAL_UI_R6D_PAYABLES_UI_WIRED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d payables parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_PAYABLES_PROVED');

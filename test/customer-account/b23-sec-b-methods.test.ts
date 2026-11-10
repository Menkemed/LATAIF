// B2/B3 SICHERHEIT B — Harness übernommen aus test/r6d/payables-parity.test.ts.
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

// ════════════════════════════════════════════════════════════════════════════
// B2/B3 SICHERHEIT B — eine unbekannte Einkaufszahlart wird nie still als Bank behandelt: nicht in der Buchung, nicht in
// der Nachbuchung, nicht im Banking. 'offset' (Verrechnung) steht nie als Geld. Die echten Wege bleiben unverändert.
// ════════════════════════════════════════════════════════════════════════════
const backfill = await import('../../src/core/ledger/backfill.ts');
const banking = await import('../../src/stores/bankingStore.ts');
const RCTX = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const codeVon = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); } };
const pay = (id: string, purchaseId: string, amount: number, method: string) =>
  ({ id, purchaseId, amount, method, paidAt: '2026-09-05', createdAt: NOW }) as never;
const liveAcc = (db: Db, id: string): string[] => rows(db, `SELECT account FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND source_id = ?
  AND direction = 'CREDIT' ORDER BY account`, [id]).map((r) => String(r.account));

// ── §1 Buchung: die vier echten Wege wie bisher; alles andere bucht nichts ───────
{
  const db = freshDb();
  seedPurchase(db, 'P1', 1000);
  const echt: Array<[string, string]> = [['cash', 'CASH'], ['bank', 'BANK'], ['benefit', 'BENEFIT'], ['credit', 'SUPPLIER_CREDIT']];
  for (const [m, acc] of echt) {
    const r = primary(() => posting.postPurchasePayment(pay('pp-' + m, 'P1', 10, m), 'sup-1'));
    ok(r.ok && S(liveAcc(db, 'pp-' + m)) === S([acc]), `B1 ${m} → ${acc} (unverändert)`);
  }
  for (const m of ['offset', 'card', 'bank_transfer', '', 'transfer', 'BANK']) {
    const vorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
    const code = codeVon(() => posting.postPurchasePayment(pay('px-' + m, 'P1', 10, m), 'sup-1'));
    ok(code === 'PURCHASE_PAYMENT_METHOD_UNKNOWN' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher,
      `B1 „${m}" → PURCHASE_PAYMENT_METHOD_UNKNOWN, keine Buchung (vorher still BANK) (${code})`);
  }
  // Die Hausfolge lehnt unbekannte Wege schon vorher ab — auch 'offset' (eine Verrechnung entsteht nur über Settle Balance).
  for (const m of ['offset', 'card', '']) {
    const r = primary(() => house.recordPurchasePaymentInHouse('P1', 5, m, CTX));
    ok(!r.ok && r.code === 'PAYMENT_METHOD_INVALID', `B1 Add Payment „${m}" → PAYMENT_METHOD_INVALID (${r.code})`);
  }
  ok(unbalanced(db) === 0, 'B1 Hauptbuch ausgeglichen');
}
marker('B23_SEC_B_POSTING_PROVED');

// ── §2 Nachbuchung: 'offset' nie, unbekannt nie als Bank ─────────────────────────
{
  const db = freshDb();
  seedPurchase(db, 'P1', 1000);
  const zeile = (id: string, method: string | null, amount: number) => insert(db, 'purchase_payments',
    { id, purchase_id: 'P1', amount, method, paid_at: '2026-09-05', created_at: NOW });
  zeile('b-cash', 'cash', 10);
  zeile('b-offset', 'offset', 20);
  zeile('b-weird', 'weird', 30);
  zeile('b-leer', '', 40);
  const r = backfill.backfillPurchasePayments('branch-main');
  ok(r.total === 4 && r.posted === 1 && r.skipped === 1 && r.failed === 2, `B2 Lauf: 1 nachgebucht (cash), 1 übersprungen (offset), 2 gemeldet (${S(r)})`);
  ok(S(liveAcc(db, 'b-cash')) === S(['CASH']), 'B2 cash → CASH');
  ok(liveAcc(db, 'b-offset').length === 0 && liveAcc(db, 'b-weird').length === 0 && liveAcc(db, 'b-leer').length === 0,
    'B2 offset / unbekannt / leer: keine Buchung');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'BANK'") === 0, 'B2 nichts auf der Bank (vorher 3 Zeilen still BANK)');
  ok(r.errors.every((e) => /never silently Bank/.test(e)), `B2 die Meldung nennt den Grund (${r.errors[0] ?? ''})`);
  const again = backfill.backfillPurchasePayments('branch-main');
  ok(again.posted === 0 && again.skipped === 2 && again.failed === 2, `B2 Wiederholung bucht nichts doppelt (${S(again)})`);
}
marker('B23_SEC_B_BACKFILL_PROVED');

// ── §3 Banking: Verrechnung und Guthaben nie als Geld; unbekannt nur mit lebender Geldbuchung ──
{
  const db = freshDb();
  seedPurchase(db, 'P1', 1000);
  const zeile = (id: string, method: string, amount: number) => insert(db, 'purchase_payments',
    { id, purchase_id: 'P1', amount, method, paid_at: '2026-09-05', created_at: NOW });
  zeile('k-cash', 'cash', 11); primary(() => posting.postPurchasePayment(pay('k-cash', 'P1', 11, 'cash'), 'sup-1'));
  zeile('k-benefit', 'benefit', 12); primary(() => posting.postPurchasePayment(pay('k-benefit', 'P1', 12, 'benefit'), 'sup-1'));
  zeile('k-credit', 'credit', 13);
  zeile('k-offset', 'offset', 14);
  // Altzeile: unbekannte Zahlart, früher still auf BANK gebucht → sie zeigt das Konto ihrer lebenden Buchung.
  zeile('k-alt', 'bank_transfer', 15);
  posting.beginLedgerTransaction();
  posting.postEntries([
    { account: 'ACCOUNTS_PAYABLE', direction: 'DEBIT', amount: 15, counterpartyType: 'SUPPLIER', counterpartyId: 'sup-1' },
    { account: 'BANK', direction: 'CREDIT', amount: 15, counterpartyType: 'SUPPLIER', counterpartyId: 'sup-1' },
  ], { occurredAt: '2026-09-05', sourceModule: 'PURCHASE_PAYMENT', sourceId: 'k-alt' });
  posting.commitLedgerTransaction();
  // Unbekannt und nie gebucht → nirgends.
  zeile('k-zzz', 'zzz', 16);
  insert(db, 'invoices', { id: 'I1', branch_id: 'branch-main', invoice_number: 'INV-1', customer_id: 'c1', status: 'FINAL', gross_amount: 50, created_at: NOW, updated_at: NOW });
  for (const [id, m] of [['i-cash', 'cash'], ['i-po', 'purchase_offset'], ['i-debt', 'debt_offset']]) {
    insert(db, 'payments', { id, branch_id: 'branch-main', invoice_id: 'I1', amount: 5, method: m, received_at: '2026-09-05', created_at: NOW });
  }
  const tx = banking.bankTransactionsFor(RCTX as never, []);
  const out = Object.fromEntries(tx.filter((t) => t.type === 'PURCHASE_OUT').map((t) => [t.id, t.account]));
  ok(out['ppay-k-cash'] === 'cash' && out['ppay-k-benefit'] === 'benefit', `B3 cash/benefit wie bisher (${S(out)})`);
  ok(!('ppay-k-credit' in out) && !('ppay-k-offset' in out), 'B3 Lieferantenguthaben und Verrechnung erscheinen nie als Geld');
  ok(out['ppay-k-alt'] === 'bank', 'B3 Altzeile mit unbekannter Zahlart: Konto der lebenden Buchung (BANK) — Banking = Hauptbuch');
  ok(!('ppay-k-zzz' in out), 'B3 unbekannt ohne Geldbuchung: nicht als Bank gezeigt (vorher still „bank")');
  const ein = tx.filter((t) => t.type === 'SALES_IN').map((t) => t.id);
  ok(ein.includes('pay-i-cash') && !ein.includes('pay-i-po') && !ein.includes('pay-i-debt'), `B3 Rechnungsseite: Verrechnungen ('purchase_offset', 'debt_offset') nie als Geld (${S(ein)})`);
  ok(banking.purchasePaymentBankAccount('offset', 'BANK') === null && banking.purchasePaymentBankAccount('credit', 'BANK') === null,
    'B3 offset/credit nie Geld, auch wenn irgendwo eine Buchung stünde');
}
marker('B23_SEC_B_BANKING_PROVED');

// ── §4 Lieferanten-Retoure: Erstattung ohne bekannten Weg bucht nichts ──────────
{
  const lc = codeOf(src('src/core/purchases/purchase-lifecycle-house.ts'));
  const fn = lc.slice(lc.indexOf('function refundAccountFor'), lc.indexOf('function refundAccountFor') + 700);
  ok(/default: throw nein\('PURCHASE_RETURN_METHOD_INVALID'/.test(fn) && !/default: return 'BANK'/.test(fn),
    'B4 refundAccountFor: kein BANK-Rückfall mehr, sondern PURCHASE_RETURN_METHOD_INVALID');
  const ps = codeOf(src('src/core/ledger/posting.ts'));
  const pf = ps.slice(ps.indexOf('function purchaseCashAccountFor'), ps.indexOf('export function postPurchasePayment'));
  ok(!/return 'BANK';\s*\n\s*\}/.test(pf.split("case 'bank'")[1] ?? '') && /PURCHASE_PAYMENT_METHOD_UNKNOWN/.test(pf), 'B4 purchaseCashAccountFor: kein default → BANK');
}
marker('B23_SEC_B_RETURN_PROVED');

console.log(`\nb23 security B: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('B23_SECURITY_B_NO_SILENT_BANK_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — Geld ohne Beleg: Steuerzahlung, Umbuchung, Gesellschafterbewegung,
// Darlehen anlegen / zurückzahlen / berichtigen — EINE Hausfolge für Primary und PC2.
// Run: node test/r6d/money-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge (`money-house.ts`), die echten Primary-Anschlüsse
// (`money-save.ts` → `runOnPrimary`), die echte C3A-Maschine mit durablem Nachweis und das echte
// Schema samt Hauptbuch. Gestellt sind nur das Speichern und — im Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 tax.record_payment   §3 banking.transfer   §4 partners.record_tx
//   §5 debts.create   §6 debts.record_payment   §7 debts.update   §8 debts.payments.get
//   §9 Client (keine lokale Datenbank)   §10 Oberfläche (jede Maske ein Anschluss)
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
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const house = await import('../../src/core/finance/money-house.ts');
const cmd = await import('../../src/core/bridge/money-commands.ts');
const save = await import('../../src/core/finance/money-save.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { useBankingStore } = await import('../../src/stores/bankingStore.ts');
const { usePartnerStore } = await import('../../src/stores/partnerStore.ts');
const { useDebtStore } = await import('../../src/stores/debtStore.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

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

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Maya', last_name: 'Main', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'c2', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'sys-walkin', branch_id: 'branch-main', first_name: 'Walk', last_name: 'In', created_at: NOW, updated_at: NOW });
  insert(db, 'partners', { id: 'pa1', branch_id: 'branch-main', name: 'Pia', share_percentage: 50, active: 1, created_at: NOW, updated_at: NOW });
  insert(db, 'partners', { id: 'pa2', branch_id: 'branch-other', name: 'Paul', share_percentage: 50, active: 1, created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'e1', branch_id: 'branch-main', name: 'Emma', employment_status: 'active', created_at: NOW, updated_at: NOW });
  insert(db, 'employees', { id: 'e2', branch_id: 'branch-other', name: 'Erik', employment_status: 'active', created_at: NOW, updated_at: NOW });
  // Umsatzsteuer: Q2/2026 schuldet 100 BHD (eine Rechnung), Q3/2026 ist ein Erstattungsquartal (nur Vorsteuer).
  insert(db, 'invoices', { id: 'inv1', branch_id: 'branch-main', invoice_number: 'INV-1', customer_id: 'c1', status: 'FINAL', vat_amount: 100, gross_amount: 1100, net_amount: 1000, issued_at: '2026-05-15T12:00:00.000Z', butterfly: 0, created_at: NOW, updated_at: NOW });
  insert(db, 'purchases', { id: 'pu1', branch_id: 'branch-main', purchase_number: 'PUR-1', status: 'RECEIVED', purchase_date: '2026-08-15T12:00:00.000Z', created_at: NOW, updated_at: NOW });
  insert(db, 'purchase_lines', { id: 'pl1', purchase_id: 'pu1', vat_amount: 50, created_at: NOW });
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), message: (e as Error).message, value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}
async function primary<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function parseMsg(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

/** Eine Datenbank, die an EINER Stelle scheitert — Fehlerinjektion an echten Wirkungspunkten. */
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

/** Das Hauptbuch einer Quelle, ohne Kennungen und Zeitpunkte — vergleichbar zwischen zwei Datenbanken. */
const ledgerSig = (db: Db, mod: string, id: string): string => S(rows(db,
  `SELECT account, direction, amount, counterparty_type, CASE WHEN reverses_entry_id IS NULL THEN 0 ELSE 1 END AS rev
     FROM ledger_entries WHERE source_module = ? AND source_id = ? ORDER BY rev, account, direction`, [mod, id])
  .map((r) => [r.account, r.direction, r.amount, r.counterparty_type, r.rev]));
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
/** Jede Buchung gleicht sich aus: Soll == Haben, je Transaktion, in Fils. */
function balanced(db: Db): boolean {
  const t = rows(db, `SELECT transaction_id,
      SUM(CASE WHEN direction = 'DEBIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS d,
      SUM(CASE WHEN direction = 'CREDIT' THEN CAST(ROUND(amount * 1000) AS INTEGER) ELSE 0 END) AS c
    FROM ledger_entries GROUP BY transaction_id`);
  return t.length > 0 && t.every((r) => Number(r.d) === Number(r.c));
}
/** Eine Zeile ohne Kennung und Zeitstempel (Zeitpunkte zählen nur als „gesetzt"). */
const norm = (r: Record<string, unknown> | undefined): string => S(Object.fromEntries(Object.entries(r ?? {})
  .filter(([k]) => !/^(id|debt_id|created_at|updated_at)$/.test(k))
  .map(([k, v]) => [k, /^(paid_at_actual|settled_at)$/.test(k) ? (v ? 'set' : null) : v])
  .sort(([a], [b]) => a.localeCompare(b))));
const netOf = (db: Db, mod: string, id: string, account: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries
    WHERE source_module = ? AND source_id = ? AND account = ?`, [mod, id, account]);

const OPS = ['tax.record_payment', 'banking.transfer', 'partners.record_tx', 'debts.create', 'debts.update', 'debts.record_payment'];

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die sechs Geldaktionen sind namentlich freigegeben');
  ok(OPS.every((op) => registry.knownCommands().includes(op)), `SCOPE und registriert (${OPS.filter((op) => !registry.knownCommands().includes(op)).join(',') || 'alle'})`);
  ok(S([...cmd.MONEY_OPS].sort()) === S([...OPS].sort()), 'SCOPE die Befehlsdatei kennt genau diese sechs');
  ok(OPS.every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null), 'SCOPE kein erfundenes Recht (die Masken des Primary haben kein Tor)');
  ok(readOps.STORE_READ_OPS.includes('debts.payments.get') && registry.knownCommands().includes('debts.payments.get'), 'SCOPE die Rückzahlungen eines Darlehens sind eine Auskunft');
  ok(!registry.ALLOWED_MUTATIONS.some((op) => /^(debts\.(delete|cancel)|banking\.(delete|undo)|partners\.(delete_tx|mark_paid|delete_transaction)|tax\.(delete|reverse))/.test(op)),
    'SCOPE Löschen und Stornieren bleiben am Primary (nicht verdrahtet)');
}
marker('CENTRAL_UI_R6D_MONEY_SCOPE_PROVED');

// ══ §2 — tax.record_payment ═════════════════════════════════════════════════
{
  const form = { year: 2026, quarter: 2, amount: 40, source: 'bank', paidAt: '2026-07-10', note: ' NBR-1 ' };
  // Primary == PC2
  const dbP = freshDb();
  const p = await primary(() => save.recordTaxPaymentOnPrimary(house.taxPaymentInput(form)));
  const rowP = rows(dbP, 'SELECT * FROM tax_payments')[0];
  const ledP = p.ok ? ledgerSig(dbP, 'TAX_PAYMENT', p.value.taxPaymentId) : '';
  const dbC = freshDb();
  const c = await fern(() => cmd.runTaxPayment(deps(dbC), identity(nextId(), 'tax.record_payment'), form));
  const rowC = rows(dbC, 'SELECT * FROM tax_payments')[0];
  const ledC = ledgerSig(dbC, 'TAX_PAYMENT', String(c.value.taxPaymentId));
  ok(p.ok && c.kind === 'ok' && norm(rowP) === norm(rowC), `PARITY Steuerzahlung: Primary == PC2 (${norm(rowP)} / ${norm(rowC)})`);
  ok(ledP === ledC && ledP === S([['BANK', 'CREDIT', 40, null, 0], ['TAX_PAID', 'DEBIT', 40, null, 0]]), `LEDGER TAX_PAID an Bank, Quelle TAX_PAYMENT (${ledP})`);
  ok(rowP?.branch_id === 'branch-main' && rowP?.paid_at === '2026-07-10T00:00:00Z' && rowP?.note === 'NBR-1' && rowP?.created_by === 'user-test' && Number(rowP?.amount) === 40,
    'TAX Filiale aus der Sitzung, Datum als Tag, Notiz getrimmt, Benutzer vermerkt');
  ok(balanced(dbP) && balanced(dbC), 'LEDGER jede Buchung gleicht sich aus (Primary und PC2)');

  // verlorene Antwort, Teilzahlung, beglichen, Überzahlung
  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const a = await fern(() => cmd.runTaxPayment(d, identity(idA, 'tax.record_payment'), form));
  const b = await fern(() => cmd.runTaxPayment(d, identity(idA, 'tax.record_payment'), form));
  ok(a.kind === 'ok' && b.replayed && b.value.taxPaymentId === a.value.taxPaymentId && n(db, 'SELECT COUNT(*) FROM tax_payments') === 1 && lc(db) === 2,
    'LOST verlorene Antwort, dieselbe Kennung: genau eine Zahlung, genau eine Buchung');
  const rest = await fern(() => cmd.runTaxPayment(d, identity(nextId(), 'tax.record_payment'), { ...form, amount: 60 }));
  ok(rest.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM tax_payments') === 2, 'TAX Teilzahlung erlaubt — der Rest danach ebenso');
  const settled = await fern(() => cmd.runTaxPayment(d, identity(nextId(), 'tax.record_payment'), { ...form, amount: 1 }));
  ok(settled.kind === 'rejected' && settled.code === house.TAX_QUARTER_SETTLED && settled.frozen && n(db, 'SELECT COUNT(*) FROM tax_payments') === 2 && lc(db) === 4,
    `TAX ein beglichenes Quartal nimmt keine Zahlung mehr (dieselbe Regel wie der Knopf) (${settled.code})`);
  const refund = await fern(() => cmd.runTaxPayment(d, identity(nextId(), 'tax.record_payment'), { ...form, quarter: 3 }));
  ok(refund.kind === 'rejected' && refund.code === house.TAX_QUARTER_REFUND_DUE, 'TAX ein Erstattungsquartal wird nicht bezahlt');
  const nothing = await fern(() => cmd.runTaxPayment(d, identity(nextId(), 'tax.record_payment'), { ...form, year: 2025, quarter: 1 }));
  ok(nothing.kind === 'rejected' && nothing.code === house.TAX_QUARTER_SETTLED, 'TAX ein Quartal ohne Schuld ist beglichen (die Anzeige zeigt dort keinen Knopf)');
  const dbO = freshDb();
  const over = await fern(() => cmd.runTaxPayment(deps(dbO), identity(nextId(), 'tax.record_payment'), { ...form, amount: 150 }));
  ok(over.kind === 'ok' && Number(one(dbO, 'SELECT amount FROM tax_payments')) === 150, 'TAX keine erfundene Obergrenze: der Vertrag kennt keine (Befund, offene Entscheidung)');

  // Sicherheit
  for (const [k, v] of [['id', 'x'], ['branchId', 'b'], ['status', 'PAID'], ['paid', 1], ['remaining', 1], ['netVat', 1], ['account', 'CASH'], ['debit', 1], ['ledger', []], ['createdBy', 'u']] as Array<[string, unknown]>) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseTaxPayment({ ...form, [k]: v }))), `PAYLOAD tax: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(parseMsg(() => cmd.parseTaxPayment({ ...form, foo: 1 }))), 'PAYLOAD tax: ein unbekanntes Feld wird abgewiesen');
  for (const amount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '40', 0.0004]) {
    ok(wirft(() => cmd.parseTaxPayment({ ...form, amount })) === house.MONEY_AMOUNT_INVALID, `PAYLOAD tax: Betrag ${String(amount)} abgewiesen`);
  }
  for (const paidAt of ['', 'T00:00:00Z', '2026-02-30', '2026-9-1', undefined]) {
    ok(wirft(() => cmd.parseTaxPayment({ ...form, paidAt })) === house.MONEY_DATE_INVALID, `PAYLOAD tax: Datum ${S(paidAt)} abgewiesen (vorher wurde ein leeres Datum zu 'T00:00:00Z')`);
  }
  ok(wirft(() => cmd.parseTaxPayment({ ...form, quarter: 5 })) === house.TAX_PERIOD_INVALID && wirft(() => cmd.parseTaxPayment({ ...form, year: 2026.5 })) === house.TAX_PERIOD_INVALID,
    'PAYLOAD tax: Quartal 1–4, Jahr ganzzahlig');
  ok(wirft(() => cmd.parseTaxPayment({ ...form, source: 'benefit' })) === house.MONEY_SOURCE_INVALID, 'PAYLOAD tax: nur Kasse oder Bank (wie die Maske und postTaxPayment)');
  const foreign = await fern(() => cmd.runTaxPayment(d, identity(nextId(), 'tax.record_payment', 'branch-other'), form));
  ok(foreign.kind === 'rejected' && foreign.code === 'BRANCH_MISMATCH' && n(db, 'SELECT COUNT(*) FROM tax_payments') === 2, 'SECURITY ein Ausweis einer anderen Filiale bucht nichts');

  // Fehler an der Buchung: nichts bleibt stehen — fern und am Primary
  const dbF = freshDb();
  const { db: bad } = faulty(dbF, /INSERT INTO ledger_entries/);
  setTestDatabase(bad as never);
  const idF = nextId();
  const f1 = await fern(() => cmd.runTaxPayment(deps(bad), identity(idF, 'tax.record_payment'), form));
  const f2 = await primary(() => save.recordTaxPaymentOnPrimary(house.taxPaymentInput(form)));
  setTestDatabase(dbF as never);
  ok(f1.kind === 'thrown' && !f2.ok && n(dbF, 'SELECT COUNT(*) FROM tax_payments') === 0 && lc(dbF) === 0 && lookupCommand(dbF as never, identity(idF, 'tax.record_payment')).kind === 'fresh',
    'ATOMIC scheitert die Buchung, gibt es keine Steuerzahlung (vorher: Zeile ohne Buchung) — fern und am Primary, die Kennung bleibt frei');
  ok(!/trackInsert\('tax_payments'/.test(codeOf(src('src/core/finance/money-house.ts'))), 'SYNC tax_payments wird nicht abgeglichen (steht nicht im Abgleichsvertrag)');
}
marker('CENTRAL_UI_R6D_TAX_PAYMENT_PROVED');

// ══ §3 — banking.transfer ═══════════════════════════════════════════════════
{
  const form = { direction: 'CASH_TO_BANK', amount: 25.5, transferDate: '2026-09-01', notes: ' move ' };
  const dbP = freshDb();
  const p = await primary(() => save.createBankTransferOnPrimary(house.bankTransferInput(form)));
  const dbC = freshDb();
  const c = await fern(() => cmd.runBankTransfer(deps(dbC), identity(nextId(), 'banking.transfer'), form));
  const rowP = rows(dbP, 'SELECT * FROM bank_transfers')[0];
  const rowC = rows(dbC, 'SELECT * FROM bank_transfers')[0];
  const ledP = p.ok ? ledgerSig(dbP, 'BANK_TRANSFER', p.value.id) : '';
  ok(p.ok && c.kind === 'ok' && norm(rowP) === norm(rowC), `PARITY Umbuchung: Primary == PC2 (${norm(rowP)} / ${norm(rowC)})`);
  ok(ledP === ledgerSig(dbC, 'BANK_TRANSFER', String(c.value.transferId)) && ledP === S([['BANK', 'DEBIT', 25.5, 'INTERNAL', 0], ['CASH', 'CREDIT', 25.5, 'INTERNAL', 0]]),
    `LEDGER Bank an Kasse, Quelle BANK_TRANSFER (${ledP})`);
  ok(rowP?.notes === 'move' && rowP?.transfer_date === '2026-09-01' && rowP?.created_by === 'user-test' && balanced(dbP) && balanced(dbC), 'TRANSFER Datum, Notiz, Benutzer; ausgeglichen');

  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const a = await fern(() => cmd.runBankTransfer(d, identity(idA, 'banking.transfer'), form));
  const b = await fern(() => cmd.runBankTransfer(d, identity(idA, 'banking.transfer'), form));
  ok(a.kind === 'ok' && b.replayed && n(db, 'SELECT COUNT(*) FROM bank_transfers') === 1 && lc(db) === 2, 'LOST verlorene Antwort: genau eine Umbuchung, eine Buchung');
  for (const dir of ['BENEFIT_TO_BANK', 'BANK_TO_BENEFIT', 'CASH_TO_BENEFIT', 'BENEFIT_TO_CASH', 'BANK_TO_CASH']) {
    ok((await fern(() => cmd.runBankTransfer(d, identity(nextId(), 'banking.transfer'), { ...form, direction: dir }))).kind === 'ok', `TRANSFER Richtung ${dir}`);
  }
  ok(balanced(db), 'LEDGER alle sechs Richtungen gleichen sich aus');
  ok(wirft(() => cmd.parseBankTransfer({ ...form, direction: 'CASH_TO_CASH' })) === house.BANK_TRANSFER_DIRECTION_INVALID, 'PAYLOAD eine siebte Richtung gibt es nicht');
  for (const k of ['from', 'to', 'transferId', 'branchId', 'account', 'credit', 'createdAt']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseBankTransfer({ ...form, [k]: 'x' }))), `PAYLOAD transfer: ${k} bestimmt der Primary`);
  }
  ok(wirft(() => cmd.parseBankTransfer({ ...form, amount: -1 })) === house.MONEY_AMOUNT_INVALID && wirft(() => cmd.parseBankTransfer({ ...form, transferDate: '' })) === house.MONEY_DATE_INVALID,
    'PAYLOAD transfer: Betrag > 0, Datum Pflicht');
  ok((await fern(() => cmd.runBankTransfer(d, identity(nextId(), 'banking.transfer', 'branch-other'), form))).code === 'BRANCH_MISMATCH', 'SECURITY fremde Filiale: Nein');

  const dbF = freshDb();
  const { db: bad } = faulty(dbF, /INSERT INTO ledger_entries/);
  setTestDatabase(bad as never);
  const f1 = await fern(() => cmd.runBankTransfer(deps(bad), identity(nextId(), 'banking.transfer'), form));
  const f2 = await primary(() => save.createBankTransferOnPrimary(house.bankTransferInput(form)));
  const f3 = wirft(() => useBankingStore.getState().createTransfer({ amount: 5, direction: 'CASH_TO_BANK', transferDate: '2026-09-01' }));
  setTestDatabase(dbF as never);
  ok(f1.kind === 'thrown' && !f2.ok && f3 !== '' && n(dbF, 'SELECT COUNT(*) FROM bank_transfers') === 0 && lc(dbF) === 0,
    'ATOMIC scheitert die Buchung, gibt es keine Umbuchung — fern, am Primary und über den alten Store-Aufruf (vorher: Zeile ohne Buchung)');
  const s = useBankingStore.getState().createTransfer({ amount: 7, direction: 'BANK_TO_CASH' });
  ok(one(dbF, 'SELECT transfer_date FROM bank_transfers WHERE id = ?', [s.id]) === new Date().toISOString().split('T')[0] && lc(dbF) === 2,
    'STORE der alte Aufruf ohne Datum bucht heute (wie bisher) — jetzt mit Buchung in einer Klammer');
}
marker('CENTRAL_UI_R6D_BANK_TRANSFER_PROVED');

// ══ §4 — partners.record_tx ═════════════════════════════════════════════════
{
  const inv = { partnerId: 'pa1', kind: 'INVESTMENT', amount: 1000, method: 'bank', date: '2026-09-02', notes: ' capital ' };
  const dbP = freshDb();
  const p = await primary(() => save.recordPartnerTxOnPrimary(house.partnerTxInput(inv)));
  const dbC = freshDb();
  const c = await fern(() => cmd.runPartnerTx(deps(dbC), identity(nextId(), 'partners.record_tx'), inv));
  const rowP = rows(dbP, 'SELECT * FROM partner_transactions')[0];
  const rowC = rows(dbC, 'SELECT * FROM partner_transactions')[0];
  ok(p.ok && c.kind === 'ok' && norm(rowP) === norm(rowC), `PARITY Einlage: Primary == PC2 (${norm(rowP)} / ${norm(rowC)})`);
  ok(/^PST-/.test(String(rowP?.transaction_number)) && rowP?.payment_status === 'PENDING' && rowP?.paid_at_actual === null && rowP?.notes === 'capital',
    'PARTNER Nummer PST, Bank = PENDING (bis zur Bestätigung) — der Primary entscheidet');
  const ledP = p.ok ? ledgerSig(dbP, 'PARTNER_TX', p.value.id) : '';
  ok(ledP === ledgerSig(dbC, 'PARTNER_TX', String(c.value.transactionId)) && ledP === S([['BANK', 'DEBIT', 1000, 'PARTNER', 0], ['PARTNER_EQUITY', 'CREDIT', 1000, 'PARTNER', 0]]),
    `LEDGER Einlage: Bank an Eigenkapital (${ledP})`);

  const db = freshDb();
  const d = deps(db);
  const wd = await fern(() => cmd.runPartnerTx(d, identity(nextId(), 'partners.record_tx'), { ...inv, kind: 'WITHDRAWAL', method: 'cash', amount: 200 }));
  const pd = await fern(() => cmd.runPartnerTx(d, identity(nextId(), 'partners.record_tx'), { ...inv, kind: 'PROFIT_DISTRIBUTION', method: 'benefit', amount: 50 }));
  const wRow = rows(db, 'SELECT * FROM partner_transactions WHERE id = ?', [wd.value.transactionId])[0];
  const pRow = rows(db, 'SELECT * FROM partner_transactions WHERE id = ?', [pd.value.transactionId])[0];
  ok(wd.kind === 'ok' && wRow?.payment_status === 'PAID' && !!wRow?.paid_at_actual && /^PWD-/.test(String(wRow?.transaction_number)), 'PARTNER Entnahme bar: sofort PAID, Nummer PWD');
  ok(pd.kind === 'ok' && /^PWD-.*000002$/.test(String(pRow?.transaction_number)), `PARTNER Gewinnausschüttung zieht aus dem PWD-Kreis (Befund, belassen) (${String(pRow?.transaction_number)})`);
  ok(ledgerSig(db, 'PARTNER_TX', String(wd.value.transactionId)) === S([['CASH', 'CREDIT', 200, 'PARTNER', 0], ['PARTNER_EQUITY', 'DEBIT', 200, 'PARTNER', 0]])
    && ledgerSig(db, 'PARTNER_TX', String(pd.value.transactionId)) === S([['BENEFIT', 'CREDIT', 50, 'PARTNER', 0], ['PARTNER_EQUITY', 'DEBIT', 50, 'PARTNER', 0]]) && balanced(db),
  'LEDGER Entnahme und Ausschüttung: Eigenkapital an Kasse/Benefit, ausgeglichen');
  const idA = nextId();
  const a = await fern(() => cmd.runPartnerTx(d, identity(idA, 'partners.record_tx'), inv));
  const b = await fern(() => cmd.runPartnerTx(d, identity(idA, 'partners.record_tx'), inv));
  ok(a.kind === 'ok' && b.replayed && b.value.transactionNumber === a.value.transactionNumber && n(db, 'SELECT COUNT(*) FROM partner_transactions') === 3, 'LOST verlorene Antwort: eine Bewegung, eine Nummer');
  const seqBefore = n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'PST'");
  const foreign = await fern(() => cmd.runPartnerTx(d, identity(nextId(), 'partners.record_tx'), { ...inv, partnerId: 'pa2' }));
  ok(foreign.kind === 'rejected' && foreign.code === house.PARTNER_NOT_FOUND && foreign.frozen && n(db, 'SELECT COUNT(*) FROM partner_transactions') === 3
    && n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'PST'") === seqBefore, 'SECURITY ein Partner einer anderen Filiale ist nicht da — keine Zeile, keine Nummer verbraucht');
  for (const k of ['transactionNumber', 'paymentStatus', 'paidAtActual', 'balance', 'totalInvested', 'account', 'branchId', 'status']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parsePartnerTx({ ...inv, [k]: 'x' }))), `PAYLOAD partner: ${k} bestimmt der Primary`);
  }
  ok(wirft(() => cmd.parsePartnerTx({ ...inv, kind: 'LOAN' })) === house.PARTNER_TX_KIND_INVALID && wirft(() => cmd.parsePartnerTx({ ...inv, method: 'card' })) === house.MONEY_SOURCE_INVALID,
    'PAYLOAD partner: nur die drei Arten, nur die drei Kassen');

  const dbF = freshDb();
  for (const pat of [/INSERT INTO partner_transactions/, /INSERT INTO ledger_entries/]) {
    const { db: bad } = faulty(dbF, pat);
    setTestDatabase(bad as never);
    const f = await fern(() => cmd.runPartnerTx(deps(bad), identity(nextId(), 'partners.record_tx'), inv));
    const fp = await primary(() => save.recordPartnerTxOnPrimary(house.partnerTxInput(inv)));
    setTestDatabase(dbF as never);
    ok(f.kind === 'thrown' && !fp.ok && n(dbF, 'SELECT COUNT(*) FROM partner_transactions') === 0 && lc(dbF) === 0
      && n(dbF, "SELECT COALESCE(MAX(next_number), 1) FROM document_sequences WHERE doc_type = 'PST'") <= 1,
    `ATOMIC Fehler bei ${pat}: keine Bewegung, keine Buchung, keine verbrannte Belegnummer`);
  }
  const st = usePartnerStore.getState().recordWithdrawal('pa1', 10, 'cash');
  ok(!!st && st.transactionNumber.startsWith('PWD-') && lc(dbF) === 2, 'STORE der alte Aufruf läuft durch dieselbe Hausfolge (Zeile + Buchung)');
}
marker('CENTRAL_UI_R6D_PARTNER_TX_PROVED');

// ══ §5 — debts.create ═══════════════════════════════════════════════════════
const debtForm = { direction: 'we_lend', customerId: 'c1', amount: 500, source: 'cash', dueDate: '2026-12-31', notes: ' short term ', staffId: 'e1' };
{
  const dbP = freshDb();
  const p = await primary(() => save.createDebtOnPrimary(house.debtCreateInput(debtForm)));
  const dbC = freshDb();
  const c = await fern(() => cmd.runDebtCreate(deps(dbC), identity(nextId(), 'debts.create'), debtForm));
  const rowP = rows(dbP, 'SELECT * FROM debts')[0];
  const rowC = rows(dbC, 'SELECT * FROM debts')[0];
  ok(p.ok && c.kind === 'ok' && norm(rowP) === norm(rowC), `PARITY Darlehen: Primary == PC2 (${norm(rowP)} / ${norm(rowC)})`);
  ok(rowP?.counterparty === 'Maya Main' && /^LOA-/.test(String(rowP?.loan_number)) && rowP?.status === 'OPEN' && Number(rowP?.revision) === 1
    && rowP?.staff_id === 'e1' && rowP?.notes === 'short term' && rowP?.due_date === '2026-12-31' && rowP?.created_by === 'user-test',
  'DEBT Gegenpartei aus dem Kunden, Nummer vom Primary, OPEN, Fassung 1');
  const ledP = p.ok ? ledgerSig(dbP, 'LOAN', p.value.debt.id) : '';
  ok(ledP === ledgerSig(dbC, 'LOAN', String(c.value.debtId)) && ledP === S([['CASH', 'CREDIT', 500, null, 0], ['LOAN_RECEIVABLE', 'DEBIT', 500, null, 0]]),
    `LEDGER verliehen: Forderung an Kasse, Quelle LOAN (${ledP})`);
  const bor = await fern(() => cmd.runDebtCreate(deps(dbC), identity(nextId(), 'debts.create'), { ...debtForm, direction: 'we_borrow', source: 'bank', amount: 300 }));
  ok(ledgerSig(dbC, 'LOAN', String(bor.value.debtId)) === S([['BANK', 'DEBIT', 300, null, 0], ['LOAN_PAYABLE', 'CREDIT', 300, null, 0]]) && balanced(dbC),
    'LEDGER geliehen: Bank an Verbindlichkeit, ausgeglichen');

  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const a = await fern(() => cmd.runDebtCreate(d, identity(idA, 'debts.create'), debtForm));
  const b = await fern(() => cmd.runDebtCreate(d, identity(idA, 'debts.create'), debtForm));
  ok(a.kind === 'ok' && b.replayed && b.value.loanNumber === a.value.loanNumber && n(db, 'SELECT COUNT(*) FROM debts') === 1 && lc(db) === 2, 'LOST verlorene Antwort: ein Darlehen, eine Nummer, eine Buchung');
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [{ ...debtForm, customerId: 'c2' }, house.CUSTOMER_NOT_FOUND, 'ein Kunde einer anderen Filiale'],
    [{ ...debtForm, customerId: 'sys-walkin' }, house.CUSTOMER_NOT_FOUND, 'ein System-Kunde (steht in keiner Auswahl)'],
    [{ ...debtForm, staffId: 'e2' }, house.EMPLOYEE_NOT_FOUND, 'ein Mitarbeiter einer anderen Filiale'],
  ];
  for (const [body, code, what] of cases) {
    const r = await fern(() => cmd.runDebtCreate(d, identity(nextId(), 'debts.create'), body));
    ok(r.kind === 'rejected' && r.code === code && r.frozen && n(db, 'SELECT COUNT(*) FROM debts') === 1, `SECURITY ${what}: ${code}, nichts angelegt`);
  }
  ok(wirft(() => cmd.parseDebtCreate({ ...debtForm, customerId: '' })) === house.CUSTOMER_REQUIRED, 'PAYLOAD ohne Kunden kein Darlehen (die Regel der Maske)');
  ok(wirft(() => cmd.parseDebtCreate({ ...debtForm, direction: 'sideways' })) === house.DEBT_DIRECTION_INVALID, 'PAYLOAD nur die bekannten Richtungen');
  for (const k of ['counterparty', 'loanNumber', 'paidAmount', 'remaining', 'status', 'revision', 'account', 'settledAt']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseDebtCreate({ ...debtForm, [k]: 'x' }))), `PAYLOAD debt: ${k} bestimmt der Primary`);
  }

  const dbF = freshDb();
  const { db: bad } = faulty(dbF, /INSERT INTO ledger_entries/);
  setTestDatabase(bad as never);
  const f = await fern(() => cmd.runDebtCreate(deps(bad), identity(nextId(), 'debts.create'), debtForm));
  const fs = wirft(() => useDebtStore.getState().createDebt({ ...debtForm, direction: 'we_lend', source: 'cash' } as never));
  setTestDatabase(dbF as never);
  ok(f.kind === 'thrown' && fs !== '' && n(dbF, 'SELECT COUNT(*) FROM debts') === 0 && lc(dbF) === 0
    && n(dbF, "SELECT COALESCE(MAX(next_number), 1) FROM document_sequences WHERE doc_type = 'LOA'") <= 1,
  'ATOMIC scheitert die Buchung, gibt es kein Darlehen und keine verbrannte Nummer — fern und über den alten Store-Aufruf');
}
marker('CENTRAL_UI_R6D_DEBT_CREATE_PROVED');

async function mkDebt(over: Record<string, unknown> = {}) {
  const r = await save.createDebtOnPrimary(house.debtCreateInput({ ...debtForm, ...over }));
  return { id: r.debt.id, revision: r.revision };
}
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM debts WHERE id = ?', [id]);

// ══ §6 — debts.record_payment ═══════════════════════════════════════════════
{
  const pay = { amount: 200, source: 'bank', paidAt: '2026-09-10', notes: ' first ' };
  const dbP = freshDb();
  const dp = await mkDebt();
  const p = await primary(() => save.recordDebtPaymentOnPrimary(house.debtPaymentInput({ debtId: dp.id, expectedRevision: dp.revision, ...pay })));
  const dbC = freshDb();
  const dc = await mkDebt();
  const c = await fern(() => cmd.runDebtPayment(deps(dbC), identity(nextId(), 'debts.record_payment'), { debtId: dc.id, expectedRevision: dc.revision, ...pay }));
  ok(p.ok && c.kind === 'ok' && norm(rows(dbP, 'SELECT * FROM debt_payments')[0]) === norm(rows(dbC, 'SELECT * FROM debt_payments')[0])
    && norm(rows(dbP, 'SELECT * FROM debts')[0]) === norm(rows(dbC, 'SELECT * FROM debts')[0]), 'PARITY Rückzahlung: Zeile und Darlehen, Primary == PC2');
  const payId = p.ok ? p.value.payment.id : '';
  ok(ledgerSig(dbP, 'LOAN_PAYMENT', payId) === ledgerSig(dbC, 'LOAN_PAYMENT', String(c.value.paymentId))
    && ledgerSig(dbP, 'LOAN_PAYMENT', payId) === S([['BANK', 'DEBIT', 200, null, 0], ['LOAN_RECEIVABLE', 'CREDIT', 200, null, 0]]),
  'LEDGER Rückzahlung eines verliehenen Darlehens: Bank an Forderung, Quelle LOAN_PAYMENT');
  ok(c.value.status === 'PARTIALLY_REPAID' && c.value.remaining === 300 && c.value.revision === 2 && one(dbC, 'SELECT paid_at FROM debt_payments') === '2026-09-10T00:00:00Z',
    `PAYMENT Status, Rest und neue Fassung vom Primary (${S(c.value)})`);
  ok(n(dbC, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'debts' AND entity_id = ? AND field_name = 'status'", [dc.id]) >= 1,
    'SYNC der Statuswechsel wird gemeldet (vorher: nie trackUpdate — der zweite Rechner sah ihn nicht)');

  const db = dbC;
  const d = deps(db);
  const r2 = c.value.revision as number;
  const over = await fern(() => cmd.runDebtPayment(d, identity(nextId(), 'debts.record_payment'), { debtId: dc.id, expectedRevision: r2, ...pay, amount: 300.001 }));
  ok(over.kind === 'rejected' && over.code === house.DEBT_OVERPAYMENT && over.frozen && n(db, 'SELECT COUNT(*) FROM debt_payments') === 1 && rev(db, dc.id) === r2,
    'OVERPAY mehr als der offene Rest: Nein, nichts geschrieben (vorher: REPAID und die Forderung lief über null)');
  const stale = await fern(() => cmd.runDebtPayment(d, identity(nextId(), 'debts.record_payment'), { debtId: dc.id, expectedRevision: 1, ...pay }));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && n(db, 'SELECT COUNT(*) FROM debt_payments') === 1, 'STALE eine alte Fassung: RECORD_CHANGED, nichts geschrieben');
  const idA = nextId();
  const a = await fern(() => cmd.runDebtPayment(d, identity(idA, 'debts.record_payment'), { debtId: dc.id, expectedRevision: r2, ...pay, amount: 300 }));
  const b = await fern(() => cmd.runDebtPayment(d, identity(idA, 'debts.record_payment'), { debtId: dc.id, expectedRevision: r2, ...pay, amount: 300 }));
  ok(a.kind === 'ok' && b.replayed && a.value.status === 'REPAID' && n(db, 'SELECT COUNT(*) FROM debt_payments') === 2 && !!one(db, 'SELECT settled_at FROM debts WHERE id = ?', [dc.id]),
    'LOST der Rest genau: REPAID; verlorene Antwort zahlt nicht zweimal');
  const after = await fern(() => cmd.runDebtPayment(d, identity(nextId(), 'debts.record_payment'), { debtId: dc.id, expectedRevision: rev(db, dc.id), ...pay, amount: 1 }));
  ok(after.kind === 'rejected' && after.code === house.DEBT_REPAID, 'REPAID ein getilgtes Darlehen nimmt keine Zahlung');
  setTestDatabase(db as never);
  const cx = await mkDebt();
  db.run("UPDATE debts SET status = 'CANCELLED' WHERE id = ?", [cx.id]);
  const canc = await fern(() => cmd.runDebtPayment(d, identity(nextId(), 'debts.record_payment'), { debtId: cx.id, expectedRevision: rev(db, cx.id), ...pay }));
  ok(canc.kind === 'rejected' && canc.code === house.DEBT_CANCELLED && n(db, 'SELECT COUNT(*) FROM debt_payments WHERE debt_id = ?', [cx.id]) === 0,
    'CANCELLED auf ein storniertes Darlehen wird nicht gezahlt (vorher: angenommen)');
  insert(db, 'debts', { id: 'dx', branch_id: 'branch-other', direction: 'we_lend', counterparty: 'X', amount: 100, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW });
  const fr = await fern(() => cmd.runDebtPayment(d, identity(nextId(), 'debts.record_payment'), { debtId: 'dx', expectedRevision: 1, ...pay, amount: 10 }));
  ok(fr.kind === 'rejected' && fr.code === house.DEBT_NOT_FOUND, 'SECURITY ein Darlehen einer anderen Filiale ist nicht da');
  for (const k of ['direction', 'paidAmount', 'remaining', 'status', 'account', 'loanNumber']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseDebtPayment({ debtId: 'x', expectedRevision: 1, ...pay, [k]: 'x' }))), `PAYLOAD payment: ${k} bestimmt der Primary`);
  }
  ok(/expectedRevision is required/.test(parseMsg(() => cmd.parseDebtPayment({ debtId: 'x', ...pay }))), 'PAYLOAD payment: ohne gesehene Fassung keine Zahlung');

  // Der Store las Richtung und Betrag aus der GELADENEN Liste — jetzt aus der Datenbank.
  const dbS = freshDb();
  const ds = await mkDebt();
  useDebtStore.setState({ debts: [] });
  const sp = useDebtStore.getState().recordDebtPayment(ds.id, 50, 'cash', '2026-09-11T00:00:00Z');
  ok(ledgerSig(dbS, 'LOAN_PAYMENT', sp.id) === S([['CASH', 'DEBIT', 50, null, 0], ['LOAN_RECEIVABLE', 'CREDIT', 50, null, 0]])
    && one(dbS, 'SELECT status FROM debts WHERE id = ?', [ds.id]) === 'PARTIALLY_REPAID',
  'STORE ohne geladene Liste: richtige Richtung, richtiger Status (vorher: Betrag 0 → REPAID, Richtung geraten)');
  ok(wirft(() => useDebtStore.getState().recordDebtPayment(ds.id, 10, 'cash', 'T00:00:00Z')) === house.MONEY_DATE_INVALID
    && wirft(() => useDebtStore.getState().recordDebtPayment(ds.id, 10, 'cash', '')) === house.MONEY_DATE_INVALID, 'STORE ein leeres Datum wird abgewiesen');

  for (const pat of [/UPDATE debts SET status/, /INSERT INTO ledger_entries/]) {
    const dbF = freshDb();
    const df = await mkDebt();
    const before = { l: lc(dbF), r: rev(dbF, df.id) };
    const { db: bad } = faulty(dbF, pat);
    setTestDatabase(bad as never);
    const f = await fern(() => cmd.runDebtPayment(deps(bad), identity(nextId(), 'debts.record_payment'), { debtId: df.id, expectedRevision: df.revision, ...pay }));
    const fp = await primary(() => save.recordDebtPaymentOnPrimary(house.debtPaymentInput({ debtId: df.id, expectedRevision: df.revision, ...pay })));
    setTestDatabase(dbF as never);
    ok(f.kind === 'thrown' && !fp.ok && n(dbF, 'SELECT COUNT(*) FROM debt_payments') === 0 && lc(dbF) === before.l && rev(dbF, df.id) === before.r
      && one(dbF, 'SELECT status FROM debts WHERE id = ?', [df.id]) === 'OPEN', `ATOMIC Fehler bei ${pat}: keine Zahlung, kein Status, keine Buchung`);
  }
  ok(balanced(dbC) && balanced(dbS), 'LEDGER jede Rückzahlung gleicht sich aus');
}
marker('CENTRAL_UI_R6D_DEBT_PAYMENT_PROVED');

// ══ §7 — debts.update ═══════════════════════════════════════════════════════
{
  const setup = async () => {
    const db = freshDb();
    const dd = await mkDebt();
    await save.recordDebtPaymentOnPrimary(house.debtPaymentInput({ debtId: dd.id, expectedRevision: dd.revision, amount: 100, source: 'cash', paidAt: '2026-09-10' }));
    return { db, id: dd.id, revision: rev(db, dd.id) };
  };
  const edit = { amount: 600, source: 'bank', notes: null };
  const P = await setup();
  const p = await primary(() => save.updateDebtOnPrimary(house.debtUpdateInput({ debtId: P.id, expectedRevision: P.revision, ...edit })));
  const C = await setup();
  const c = await fern(() => cmd.runDebtUpdate(deps(C.db), identity(nextId(), 'debts.update'), { debtId: C.id, expectedRevision: C.revision, ...edit }));
  ok(p.ok && c.kind === 'ok' && norm(rows(P.db, 'SELECT * FROM debts')[0]) === norm(rows(C.db, 'SELECT * FROM debts')[0]), 'PARITY Berichtigung: Primary == PC2');
  const sig = ledgerSig(C.db, 'LOAN', C.id);
  ok(sig === ledgerSig(P.db, 'LOAN', P.id) && sig === S([
    ['BANK', 'CREDIT', 600, null, 0], ['CASH', 'CREDIT', 500, null, 0], ['LOAN_RECEIVABLE', 'DEBIT', 500, null, 0], ['LOAN_RECEIVABLE', 'DEBIT', 600, null, 0],
    ['CASH', 'DEBIT', 500, null, 1], ['LOAN_RECEIVABLE', 'CREDIT', 500, null, 1],
  ]), `LEDGER Betrag/Konto geändert: die alte Darlehensbuchung gespiegelt, die neue gebucht (vorher: Hauptbuch lief auseinander) (${sig})`);
  ok(netOf(C.db, 'LOAN', C.id, 'LOAN_RECEIVABLE') === 600 && netOf(C.db, 'LOAN', C.id, 'CASH') === 0 && netOf(C.db, 'LOAN', C.id, 'BANK') === -600 && balanced(C.db),
    'LEDGER netto: Forderung 600 aus der Bank, die Kasse unberührt — ausgeglichen');
  ok(c.value.status === 'PARTIALLY_REPAID' && c.value.reposted === true && one(C.db, 'SELECT notes FROM debts WHERE id = ?', [C.id]) === null && Number(c.value.revision) > C.revision,
    'UPDATE Status neu abgeleitet, Notiz gelöscht (null), neue Fassung');

  const d = deps(C.db);
  const r1 = Number(c.value.revision);
  const below = await fern(() => cmd.runDebtUpdate(d, identity(nextId(), 'debts.update'), { debtId: C.id, expectedRevision: r1, amount: 50 }));
  ok(below.kind === 'rejected' && below.code === house.DEBT_AMOUNT_BELOW_PAID && Number(one(C.db, 'SELECT amount FROM debts WHERE id = ?', [C.id])) === 600, 'UPDATE nie unter das Gezahlte (vorhandene Regel)');
  ok(wirft(() => cmd.parseDebtUpdate({ debtId: C.id, expectedRevision: r1, amount: 0 })) === house.MONEY_AMOUNT_INVALID, 'PAYLOAD Betrag 0: ein Nein (die Maske warf vorher ungefangen)');
  const stale = await fern(() => cmd.runDebtUpdate(d, identity(nextId(), 'debts.update'), { debtId: C.id, expectedRevision: C.revision, counterparty: 'X' }));
  ok(stale.kind === 'rejected' && stale.code === 'RECORD_CHANGED' && one(C.db, 'SELECT counterparty FROM debts WHERE id = ?', [C.id]) === 'Maya Main', 'STALE alte Fassung: Nein, nichts geändert');
  const lBefore = lc(C.db);
  const cp = await fern(() => cmd.runDebtUpdate(d, identity(nextId(), 'debts.update'), { debtId: C.id, expectedRevision: r1, counterparty: ' Maya M. ', dueDate: null }));
  ok(cp.kind === 'ok' && cp.value.reposted === false && lc(C.db) === lBefore && one(C.db, 'SELECT counterparty FROM debts WHERE id = ?', [C.id]) === 'Maya M.'
    && one(C.db, 'SELECT due_date FROM debts WHERE id = ?', [C.id]) === null, 'UPDATE nur Gegenpartei/Fälligkeit: keine Buchung, Fälligkeit gelöscht');
  const idA = nextId();
  const r2 = Number(cp.value.revision);
  const a = await fern(() => cmd.runDebtUpdate(d, identity(idA, 'debts.update'), { debtId: C.id, expectedRevision: r2, amount: 700 }));
  const b = await fern(() => cmd.runDebtUpdate(d, identity(idA, 'debts.update'), { debtId: C.id, expectedRevision: r2, amount: 700 }));
  ok(a.kind === 'ok' && b.replayed && netOf(C.db, 'LOAN', C.id, 'LOAN_RECEIVABLE') === 700 && balanced(C.db), 'LOST verlorene Antwort: genau eine Neubuchung (Forderung 700)');
  ok(/an edit must change something/.test(parseMsg(() => cmd.parseDebtUpdate({ debtId: C.id, expectedRevision: 1 }))), 'PAYLOAD ein leeres Ändern ist keine Absicht');
  for (const k of ['loanNumber', 'paidAmount', 'remaining', 'status', 'account', 'settledAt']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseDebtUpdate({ debtId: C.id, expectedRevision: 1, amount: 5, [k]: 'x' }))), `PAYLOAD update: ${k} bestimmt der Primary`);
  }
  ok(/unknown field/.test(parseMsg(() => cmd.parseDebtUpdate({ debtId: C.id, expectedRevision: 1, direction: 'we_borrow' }))), 'PAYLOAD update: die Richtung ist nicht änderbar');

  setTestDatabase(C.db as never);
  const cx = await mkDebt();
  C.db.run("UPDATE debts SET status = 'CANCELLED' WHERE id = ?", [cx.id]);
  const canc = await fern(() => cmd.runDebtUpdate(d, identity(nextId(), 'debts.update'), { debtId: cx.id, expectedRevision: rev(C.db, cx.id), amount: 900 }));
  const cancStore = wirft(() => useDebtStore.getState().updateDebt(cx.id, { amount: 900 }));
  ok(canc.kind === 'rejected' && canc.code === house.DEBT_CANCELLED && cancStore === house.DEBT_CANCELLED
    && one(C.db, 'SELECT status FROM debts WHERE id = ?', [cx.id]) === 'CANCELLED' && Number(one(C.db, 'SELECT amount FROM debts WHERE id = ?', [cx.id])) === 500,
  'CANCELLED ein storniertes Darlehen wird nicht berichtigt und bleibt storniert (vorher: still wieder OPEN)');
  insert(C.db, 'debts', { id: 'legacy', branch_id: 'branch-main', direction: 'we_lend', counterparty: 'Old', amount: 100, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW });
  const lg = await fern(() => cmd.runDebtUpdate(d, identity(nextId(), 'debts.update'), { debtId: 'legacy', expectedRevision: 1, amount: 150 }));
  ok(lg.kind === 'ok' && lg.value.reposted === false && n(C.db, "SELECT COUNT(*) FROM ledger_entries WHERE source_id = 'legacy'") === 0,
    'LEGACY ein Darlehen ohne Buchung (vor dem Hauptbuch) bekommt beim Berichtigen keine nachträglich (Befund, belassen)');

  const F = await setup();
  const { db: bad } = faulty(F.db, /INSERT INTO ledger_entries/);
  const lF = lc(F.db);
  setTestDatabase(bad as never);
  const f = await fern(() => cmd.runDebtUpdate(deps(bad), identity(nextId(), 'debts.update'), { debtId: F.id, expectedRevision: F.revision, amount: 800 }));
  const fp = await primary(() => save.updateDebtOnPrimary(house.debtUpdateInput({ debtId: F.id, expectedRevision: F.revision, source: 'benefit' })));
  setTestDatabase(F.db as never);
  ok(f.kind === 'thrown' && !fp.ok && Number(one(F.db, 'SELECT amount FROM debts WHERE id = ?', [F.id])) === 500 && one(F.db, 'SELECT source FROM debts WHERE id = ?', [F.id]) === 'cash'
    && lc(F.db) === lF && rev(F.db, F.id) === F.revision, 'ATOMIC scheitert die Spiegel-/Neubuchung, bleiben Betrag, Konto, Fassung und Hauptbuch unverändert');
}
marker('CENTRAL_UI_R6D_DEBT_UPDATE_PROVED');

// ══ §8 — debts.payments.get ═════════════════════════════════════════════════
{
  const db = freshDb();
  const dd = await mkDebt();
  await save.recordDebtPaymentOnPrimary(house.debtPaymentInput({ debtId: dd.id, expectedRevision: dd.revision, amount: 20, source: 'benefit', paidAt: '2026-09-12' }));
  insert(db, 'debts', { id: 'dx', branch_id: 'branch-other', direction: 'we_lend', counterparty: 'X', amount: 100, source: 'cash', status: 'OPEN', created_at: NOW, updated_at: NOW });
  insert(db, 'debt_payments', { id: 'dxp', debt_id: 'dx', amount: 10, source: 'cash', paid_at: NOW, created_at: NOW });
  // Wie die Route: der geprüfte Absender im Umschlag, die Eingabe des Clients getrennt davon.
  const read = (input: Record<string, unknown>, branchId: string) => {
    const actor = { tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN' };
    return registry.executeCommand('debts.payments.get', { actor, input }, actor as never) as Promise<{ kind: string; value?: { data?: { payments?: Array<Record<string, unknown>> } } }>;
  };
  const mine = await read({ debtId: dd.id }, 'branch-main');
  const paysMine = mine.value?.data?.payments ?? [];
  ok(mine.kind === 'ok' && paysMine.length === 1 && paysMine[0].source === 'benefit' && Number(paysMine[0].amount) === 20, `READ die Rückzahlungen eines eigenen Darlehens (${S(mine)})`);
  const foreign = await read({ debtId: 'dx' }, 'branch-main');
  ok(foreign.kind === 'ok' && (foreign.value?.data?.payments ?? []).length === 0, 'READ ein Darlehen einer fremden Filiale liefert nichts');
  const other = await read({ debtId: dd.id }, 'branch-other');
  ok(other.kind === 'ok' && (other.value?.data?.payments ?? []).length === 0, 'READ …und umgekehrt: ein fremder Ausweis sieht unsere nicht');
  const missing = await read({}, 'branch-main');
  ok(missing.kind === 'business_error', 'READ ohne Darlehenskennung: ein Nein');
}
marker('CENTRAL_UI_R6D_DEBT_PAYMENTS_READ_PROVED');

// ══ §9 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
  const db = freshDb();
  const dd = await mkDebt();
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
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (body.op === 'debts.payments.get') return new Response(JSON.stringify({ ok: true, value: { data: { payments: [{ id: 'rp1', debtId: dd.id, amount: 5, source: 'cash', paidAt: '2026-09-12T00:00:00Z', createdAt: NOW }] } } }), { status: 200 });
    if (body.op === 'debts.record_payment') return new Response(JSON.stringify({ ok: true, value: { paymentId: 'rp2', replayed: false } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, value: { data: {} } }), { status: 200 });
  }) as never;
  try {
    const refusals = [
      wirft(() => useBankingStore.getState().createTransfer({ amount: 5, direction: 'CASH_TO_BANK', transferDate: '2026-09-01' })),
      wirft(() => usePartnerStore.getState().recordInvestment('pa1', 5, 'cash', '2026-09-01')),
      wirft(() => useDebtStore.getState().createDebt({ ...debtForm } as never)),
      wirft(() => useDebtStore.getState().recordDebtPayment(dd.id, 5, 'cash', '2026-09-01')),
      wirft(() => useDebtStore.getState().updateDebt(dd.id, { amount: 900 })),
      wirft(() => house.recordTaxPaymentInHouse({ year: 2026, quarter: 2, amount: 5, source: 'bank', paidAt: '2026-09-01' }, { branchId: 'branch-main', userId: 'u' })),
    ];
    ok(refusals.every((c) => c === house.MONEY_PRIMARY_ONLY) && touched === 0,
      `CLIENT jede Geldaktion verweigert die lokale Datenbank, bevor sie sie anfasst (${S(refusals)}, Zugriffe ${touched})`);
    useDebtStore.getState().loadPaymentsForDebt(dd.id);
    await new Promise((r) => setTimeout(r, 20));
    const shown = useDebtStore.getState().paymentsByDebt[dd.id] ?? [];
    ok(calls.some((c) => c.body.op === 'debts.payments.get') && shown.length === 1 && shown[0].id === 'rp1' && touched === 0,
      'CLIENT die Rückzahlungen kommen vom Primary (vorher: lokal gefragt, still „keine")');
    const write = { remote: true, save: <T,>(op: string, a: never) => runSharedWrite<T>(true, a, new CommandSaveController<Record<string, unknown>>(op).beginAttempt()) };
    const base = { ...useDebtStore.getState().debts[0], id: dd.id, revision: 2, amount: 500, paidAmount: 0 } as never;
    const r = await save.saveDebtPayment(write as never, base, { amount: '12.5', source: 'benefit', paidAt: '2026-09-12', notes: ' x ' });
    const sent = calls.find((c) => c.body.op === 'debts.record_payment');
    ok(r.kind === 'ok' && !!sent && S(Object.keys(sent.body.payload as object).sort()) === S(['amount', 'debtId', 'expectedRevision', 'notes', 'paidAt', 'source'])
      && (sent.body.payload as Record<string, unknown>).amount === 12.5 && (sent.body.payload as Record<string, unknown>).notes === 'x' && touched === 0,
    `CLIENT die Maske schickt EINEN geprüften Auftrag mit der gesehenen Fassung — keine lokale Wirkung (${S(sent?.body.payload)})`);
    const before = calls.length;
    const bad = await save.saveDebtPayment(write as never, base, { amount: '', source: 'cash', paidAt: '2026-09-12' });
    ok(bad.kind === 'business_error' && (bad as { code: string }).code === house.MONEY_AMOUNT_INVALID && calls.length === before,
      'CLIENT dieselbe Eingaberegel VOR dem Schicken: kein Netz, dieselbe Antwort wie am Primary');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6D_MONEY_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §10 — Oberfläche: jede Maske ein Anschluss ══════════════════════════════
{
  const an = codeOf(src('src/pages/analytics/AnalyticsPage.tsx'));
  ok(!/getDatabase\(|saveDatabase\(|INSERT INTO tax_payments/.test(an) && /saveTaxPayment\(w,/.test(an) && !/readsFromPrimary\(\)/.test(an) && /vatQuarterState\(q\)/.test(an),
    'UI Auswertung: keine eigene Zeile mehr, der Knopf steht auf beiden Rechnern, dieselbe Quartalsregel wie das Haus');
  ok(/disabled=\{w\.busy\}/.test(an) && /<WriteError text=\{taxPayFehler\}/.test(an) && /if \(r\.kind !== 'ok'\) \{ setTaxPayFehler/.test(an), 'UI Auswertung: gesperrt solange es läuft, Fehler bleibt sichtbar, Maske schließt nur bei Erfolg');
  const bk = codeOf(src('src/pages/banking/BankingPage.tsx'));
  ok(!/createTransfer\(/.test(bk) && /saveBankTransfer\(w,/.test(bk) && /<WriteError text=\{transferFehler\}/.test(bk), 'UI Bank: ein Anschluss, Fehler sichtbar');
  const pp = codeOf(src('src/pages/partners/PartnersPage.tsx'));
  ok(!/recordInvestment\(|recordWithdrawal\(|recordProfitDistribution\(/.test(pp) && /savePartnerTx\(w,/.test(pp) && !/R6E/.test(src('src/pages/partners/PartnersPage.tsx')),
    'UI Partner: die Bewegungen gehen durch den Anschluss (die „R6E"-Vertagung ist weg)');
  ok(/savePartnerCreate\(/.test(pp) && /savePartnerUpdate\(/.test(pp), 'UI Partner: Anlegen/Ändern aus R6C bleibt');
  const dp = codeOf(src('src/pages/debts/DebtsPage.tsx'));
  ok(!/createDebt\(|recordDebtPayment\(|updateDebt\(/.test(dp) && /saveDebtCreate\(w,/.test(dp) && /saveDebtPayment\(w, detail,/.test(dp) && /saveDebtUpdate\(w, detail, editForm\)/.test(dp),
    'UI Darlehen: anlegen, zurückzahlen, berichtigen — je ein Anschluss, kein Store-Aufruf');
  ok(!/alert\('Please select a client/.test(dp) && (dp.match(/s === 'bank' \? 'Bank' : 'Benefit'/g) ?? []).length >= 3, 'UI Darlehen: kein alert() mehr; der Benefit-Knopf heißt Benefit (vorher „Bank")');
  const ms = codeOf(src('src/core/finance/money-save.ts'));
  ok((ms.match(/runOnPrimary\(\(\) =>/g) ?? []).length === 6, 'UI am Primary läuft jede der sechs Aktionen in der Schreibreihenfolge (runOnPrimary)');
  const stores = ['src/stores/bankingStore.ts', 'src/stores/partnerStore.ts', 'src/stores/debtStore.ts'].map((f) => codeOf(src(f))).join('\n');
  ok(!/postBankTransfer\(|postPartnerTransaction\(|postLoanCreated\(|postLoanPayment\(/.test(stores), 'STORE keine verschluckte Anlage-Buchung mehr im Store — sie steht streng in der Hausfolge');
  ok(!/'branch-main'/.test(codeOf(src('src/core/finance/money-house.ts'))), "HOUSE kein stilles 'branch-main' mehr");
  const all = src('src/pages/analytics/AnalyticsPage.tsx') + src('src/pages/banking/BankingPage.tsx') + src('src/pages/partners/PartnersPage.tsx') + src('src/pages/debts/DebtsPage.tsx');
  const hooks = ['data-tax-pay-open', 'data-tax-pay-amount', 'data-tax-pay-date', 'data-tax-pay-source', 'data-tax-pay-note', 'data-tax-pay-save',
    'data-bank-transfer-open', 'data-bank-transfer-from', 'data-bank-transfer-to', 'data-bank-transfer-amount', 'data-bank-transfer-date', 'data-bank-transfer-notes', 'data-bank-transfer-save',
    'data-partner-tx-open', 'data-partner-tx-amount', 'data-partner-tx-method', 'data-partner-tx-date', 'data-partner-tx-notes', 'data-partner-tx-save',
    'data-debt-create-open', 'data-debt-create-direction', 'data-debt-create-customer', 'data-debt-create-amount', 'data-debt-create-source', 'data-debt-create-due', 'data-debt-create-notes', 'data-debt-create-save',
    'data-debt-row', 'data-debt-pay-amount', 'data-debt-pay-source', 'data-debt-pay-date', 'data-debt-pay-note', 'data-debt-pay-save',
    'data-debt-edit-open', 'data-debt-edit-counterparty', 'data-debt-edit-amount', 'data-debt-edit-due', 'data-debt-edit-source', 'data-debt-edit-notes', 'data-debt-edit-save'];
  const missing = hooks.filter((h) => !all.includes(h));
  ok(missing.length === 0, `UI jede verdrahtete Stelle trägt ihren E2E-Haken (${missing.join(', ') || 'alle'})`);
  const cmds = codeOf(src('src/core/bridge/money-commands.ts'));
  ok(['recordTaxPaymentInHouse(', 'createBankTransferInHouse(', 'recordPartnerTxInHouse(', 'createDebtInHouse(', 'recordDebtPaymentInHouse(', 'updateDebtInHouse('].every((f) => cmds.includes(f))
    && (cmds.match(/assertHouseBranch\(identity\)/g) ?? []).length === 6, 'UI der Fernbefehl ruft DIESELBE Hausfolge wie die Maske — in der Filiale, deren Bücher der Primary führt');
}
marker('CENTRAL_UI_R6D_MONEY_UI_WIRED_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6d money parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6D_MONEY_PROVED');

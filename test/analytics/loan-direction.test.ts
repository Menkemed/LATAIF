// ════════════════════════════════════════════════════════════════════════════
// ANALYTICS — Geldfluss der Darlehen nach Richtung (CUSTOMER ACCOUNT A2, kleiner Befund).
// Ein Darlehen trägt die Richtung in zwei Schreibweisen: we_lend/we_borrow (Maske) und MONEY_GIVEN/MONEY_RECEIVED
// (kanonisch) — `createDebtInHouse` nimmt beide an. Der Geldfluss in Analytics zählte nur `we_lend` als verliehen; ein
// kanonisch gespeichertes MONEY_GIVEN landete bei „geliehen", seine Rückzahlungen bei „von uns zurückgezahlt".
// Hier: beide Richtungen in beiden Schreibweisen über den echten Schreibweg, mit Rückzahlungen.
// Nur künstliche Testdaten (In-Memory-sql.js). Run: node test/analytics/loan-direction.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    if (specifier === '@/core/db/database' || specifier === '../db/database.ts') return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const money = await import('../../src/core/finance/money-house.ts');
const { financeFor } = await import('../../src/core/reports/analytics-snapshot.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-10-20T10:00:00.000Z';
const eq = (a: number, b: number): boolean => Math.round(a * 1000) === Math.round(b * 1000);

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const dbSrc = src('src/core/db/database.ts');
const start = dbSrc.indexOf('const migrations: string[] = [');
const MIGRATIONS = [...dbSrc.slice(start, dbSrc.indexOf('\n  ];', start)).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
resetDurabilityStateForTest();
resetTransactionHealthForTest();
const DB = new SQL.Database() as unknown as Db;
DB.run(src('src/core/db/schema.sql'));
for (const s of MIGRATIONS) { try { DB.run(s); } catch { /* schon da */ } }
for (const s of A1_UPGRADE_SQL) { try { DB.run(s); } catch { /* schon da */ } }
DB.run(COMMAND_LEDGER_DDL); DB.run(COMMAND_LEDGER_INDEX); DB.run(SKU_SEQUENCES_DDL);
DB.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
DB.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
  VALUES ('cust-1','branch-main','Ahmed','Karimi','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
applyMediaSchema(DB as never);
setTestDatabase(DB as never);
installWriteGuard(DB as never);
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; } catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
const CTX = { branchId: 'branch-main', userId: 'user-test' };
const darlehen = (direction: string, amount: number, source: string): string =>
  imHaus(() => money.createDebtInHouse({ direction, customerId: 'cust-1', amount, source } as never, CTX)).debt.id;
const rueck = (debtId: string, amount: number, source: string): void => {
  imHaus(() => money.recordDebtPaymentInHouse({ debtId, amount, source, paidAt: '2026-10-21' } as never, CTX));
};
const fluss = () => {
  const f = financeFor({ branchId: 'branch-main' } as never)! as unknown as Record<string, number>;
  return { lentCash: f.lentOutCash, lentBank: f.lentOutBank, borrowedCash: f.borrowedInCash, borrowedBank: f.borrowedInBank,
    toUsCash: f.debtRepaidToUsCash, toUsBank: f.debtRepaidToUsBank, byUsCash: f.debtRepaidByUsCash, byUsBank: f.debtRepaidByUsBank };
};

// Beide Richtungen in beiden Schreibweisen — über den echten Schreibweg (Darlehen + Buchung).
const L1 = darlehen('we_lend', 100, 'cash');
const L2 = darlehen('MONEY_GIVEN', 40, 'bank');
const B1 = darlehen('we_borrow', 200, 'cash');
const B2 = darlehen('MONEY_RECEIVED', 70, 'bank');
const gespeichert = (id: string): string => String(DB.exec('SELECT direction FROM debts WHERE id = ?', [id])[0]?.values?.[0]?.[0]);
ok(gespeichert(L2) === 'MONEY_GIVEN' && gespeichert(B2) === 'MONEY_RECEIVED' && gespeichert(L1) === 'we_lend',
  'A1 der Schreibweg speichert die Richtung so, wie sie kommt (beide Schreibweisen kommen in der Datenbank vor)');
const konto = (acc: string): number => Number(DB.exec(`SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = ?`, [acc])[0]?.values?.[0]?.[0] ?? 0);
ok(eq(konto('LOAN_RECEIVABLE'), 140) && eq(konto('LOAN_PAYABLE'), -270),
  `A2 die Buchung kennt beide Schreibweisen schon richtig: verliehen 140 (Forderung), geliehen 270 (Verbindlichkeit) (${konto('LOAN_RECEIVABLE')} / ${konto('LOAN_PAYABLE')})`);

let f = fluss();
ok(eq(f.lentCash, 100) && eq(f.lentBank, 40) && eq(f.borrowedCash, 200) && eq(f.borrowedBank, 70),
  `B1 Analytics: verliehen 100 bar + 40 Bank (MONEY_GIVEN), geliehen 200 bar + 70 Bank (MONEY_RECEIVED) (${JSON.stringify(f)})`);

// Rückzahlungen in beiden Richtungen.
rueck(L1, 30, 'cash');
rueck(L2, 15, 'bank');
rueck(B1, 50, 'cash');
rueck(B2, 20, 'bank');
f = fluss();
ok(eq(f.toUsCash, 30) && eq(f.toUsBank, 15) && eq(f.byUsCash, 50) && eq(f.byUsBank, 20),
  `B2 Rückzahlungen: an uns 30 bar + 15 Bank (MONEY_GIVEN), von uns 50 bar + 20 Bank (MONEY_RECEIVED) (${JSON.stringify(f)})`);
ok(eq(konto('LOAN_RECEIVABLE'), 95) && eq(konto('LOAN_PAYABLE'), -200), 'B3 Hauptbuch unverändert in seiner Logik: Forderung 95, Verbindlichkeit 200');

// Lesen ändert nichts.
const vorher = DB.exec('SELECT COUNT(*) FROM ledger_entries')[0].values[0][0];
fluss();
ok(DB.exec('SELECT COUNT(*) FROM ledger_entries')[0].values[0][0] === vorher, 'C1 Analytics liest nur');
ok(/isLoanGiven\(d\.direction as string\)/.test(src('src/core/reports/analytics-snapshot.ts')) && !/direction === 'we_lend'/.test(src('src/core/reports/analytics-snapshot.ts')),
  'C2 Quelltext: die Richtung kommt aus isLoanGiven (eine Regel mit Buchung, Kundenkonto, Kundenkennzahlen)');

console.log(`\nanalytics loan direction: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const x of fails) console.log('  FAIL ' + x); process.exit(1); }

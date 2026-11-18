// ═════════════════════════════════════════════════════════════════════════════
// ACCOUNTING-OPENING-DATE — der Buchungsstichtag JE DATENBANK (Settings → Accounting).
// Echte sql.js-Datenbanken (schema.sql + echte Migrationen), echte Sperrwege (Korrektur-Tage, Einkaufs-Bearbeitung).
// Run: node test/opening-date/opening-date.test.ts
//
//   D1 bestehende Datenbank behält 2026-10-15      D2 Speichern + Neustart       D3 unabhängige Datenbanken
//   D4 vor dem neuen Stichtag gesperrt             D5 ab dem neuen Stichtag offen D6 eingereichte VAT bleibt gesperrt
//   D7 nicht autorisiert abgelehnt                 D8 PC2 nutzt den Wert des Primary
//   K  Konflikte vor dem Speichern (Eröffnungsposten, späterer Stichtag mit Vorgängen, Zukunft, ungültig, unverändert)
// ═════════════════════════════════════════════════════════════════════════════
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-owner' })]]);
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
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const od = await import('../../src/core/accounting/opening-date.ts');
const house = await import('../../src/core/accounting/opening-date-house.ts');
const { correctionDateIssue, CORRECTION_BEFORE_OPENING_CUTOFF } = await import('../../src/core/ledger/correction-dates.ts');
const { purchaseEditCheck } = await import('../../src/core/purchases/purchase-edit-house.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = JSON.stringify;
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-11-18T10:00:00.000Z';
interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-owner','branch-main','owner',?)", [NOW]);
  db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-sales','branch-main','sales',?)", [NOW]);
  db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-admin2','branch-main','ADMIN',?)", [NOW]);
  db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-manager','branch-main','MANAGER',?)", [NOW]);
  db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-acc','branch-main','ACCOUNTANT',?)", [NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  return db;
}
const OWNER = { branchId: 'branch-main', userId: 'user-owner', now: NOW, role: 'owner' };
const setze = (date: string, ctx: typeof OWNER = OWNER) => house.setAccountingOpeningDateInHouse({ date }, ctx);
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; } };
const code = (m: string): string => m.split('|')[0];
const o1 = (day: string): string => correctionDateIssue('branch-main', [{ iso: `${day}T12:00:00.000Z`, what: 'the invoice' }])?.code ?? '';
let lauf = 0;
function einkauf(db: Db, datum: string, scheme = 'ZERO'): string {
  const id = `pu-${++lauf}`;
  db.run("INSERT INTO purchases (id, branch_id, purchase_number, supplier_id, status, total_amount, purchase_date, created_at, updated_at) VALUES (?,'branch-main',?,'s1','PAID',0,?,?,?)",
    [id, 'PUR-' + lauf, datum, NOW, NOW]);
  db.run("INSERT INTO purchase_lines (id, purchase_id, description, quantity, unit_price, line_total, position, tax_scheme) VALUES (?,?,'Ring',1,0,0,0,?)",
    [id + '-l', id, scheme]);
  return id;
}
const preisSperre = (id: string): string => { const l = purchaseEditCheck(id, 'branch-main', NOW).lines[0].price; return l.allowed ? 'OFFEN' : String(l.code); };

useAuthStore.setState({ session: { userId: 'user-owner', branchId: 'branch-main', role: 'owner' } as never });

// ── D1 bestehende Datenbank: ohne Eintrag gilt weiter 2026-10-15 ──
const dbAlt = freshDb();
{
  ok(od.accountingOpeningDate() === '2026-10-15' && od.accountingOpeningDateInfo().source === 'default',
    `D1 bestehende Datenbank ohne Eintrag: Stichtag 2026-10-15 (Standard) (${S(od.accountingOpeningDateInfo())})`);
  ok(o1('2026-10-10') === CORRECTION_BEFORE_OPENING_CUTOFF && o1('2026-10-20') === '', 'D1 …Korrektur vor dem 15.10. gesperrt, danach offen (wie bisher)');
  const p = einkauf(dbAlt, '2026-08-10');
  ok(preisSperre(p) === 'PURCHASE_EDIT_BEFORE_CUTOVER', `D1 …Einkauf vom 10.08. bleibt mit 15.10. gesperrt (${preisSperre(p)})`);
}

// ── D2 Speichern, Audit, Neustart ──
const dbA = freshDb();
{
  const r = setze('2026-01-01');
  ok(r.changed && r.previous === '2026-10-15' && r.previousSource === 'default' && od.accountingOpeningDate() === '2026-01-01',
    `D2 Owner setzt 2026-01-01 (${S(r)})`);
  ok(n(dbA, "SELECT COUNT(*) FROM settings WHERE key = 'accounting.opening_date' AND value = '2026-01-01' AND branch_id = 'branch-main'") === 1,
    'D2 …gespeichert in settings DIESER Datenbank');
  const a = dbA.exec("SELECT old_value, new_value, changed_by, module, field_name FROM audit_log WHERE field_name = 'accounting.opening_date'")[0]?.values ?? [];
  ok(a.length === 1 && a[0][0] === '2026-10-15 (default)' && a[0][1] === '2026-01-01' && a[0][2] === 'user-owner' && a[0][3] === 'Settings',
    `D2 …Audit: Benutzer, alter und neuer Wert (${S(a[0])})`);
  const neustart = new SQL.Database(dbA.export()) as unknown as Db;   // Datei neu geladen = Neustart
  setTestDatabase(neustart as never);
  ok(od.accountingOpeningDate() === '2026-01-01' && od.accountingOpeningDateInfo().source === 'database', 'D2 …nach dem Neustart unverändert 2026-01-01');
  setTestDatabase(dbA as never);
}

// ── D3 unabhängige Datenbanken ──
const dbB = freshDb();
{
  setze('2026-07-01');
  setTestDatabase(dbA as never); const a = od.accountingOpeningDate();
  setTestDatabase(dbB as never); const b = od.accountingOpeningDate();
  setTestDatabase(dbAlt as never); const alt = od.accountingOpeningDate();
  ok(a === '2026-01-01' && b === '2026-07-01' && alt === '2026-10-15', `D3 drei Datenbanken, drei Stichtage (${a} / ${b} / ${alt})`);
  ok(!/"settings"\s*:/.test(src('src/core/sync/sync-business-schema.json')), 'D3 …settings gehört nicht zum Sync-Vertrag (kein anderer Rechner übernimmt den Wert)');
  setTestDatabase(dbB as never);
}

// ── D4/D5 Sperre am neuen Stichtag (dbB: 2026-07-01) ──
{
  ok(o1('2026-06-10') === CORRECTION_BEFORE_OPENING_CUTOFF, 'D4 Rechnungskorrektur vom 10.06. (vor 01.07.) bleibt gesperrt');
  ok(o1('2026-08-10') === '', 'D5 Rechnungskorrektur vom 10.08. (ab 01.07.) wird nicht mehr durch den Stichtag gesperrt');
  const vor = einkauf(dbB, '2026-06-10'), nach = einkauf(dbB, '2026-08-10');
  ok(preisSperre(vor) === 'PURCHASE_EDIT_BEFORE_CUTOVER', `D4 Einkauf vom 10.06. bleibt gesperrt (${preisSperre(vor)})`);
  ok(preisSperre(nach) === 'OFFEN', `D5 Einkauf vom 10.08. ist bearbeitbar (${preisSperre(nach)})`);
  ok(purchaseEditCheck(nach, 'branch-main', NOW).cutoverDate === '2026-07-01', 'D5 …die Einkaufsmaske zeigt den Stichtag der Datenbank');
}

// ── D6 eingereichte VAT bleibt gesperrt ──
{
  dbB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at) VALUES ('vf-q3','branch-main',2026,3,?, 'user-owner',0,'{}',?)", [NOW, NOW]);
  ok(o1('2026-08-10') === 'VAT_PERIOD_FILED', `D6 nach Einreichen von Q3: Korrektur vom 10.08. wieder gesperrt (VAT) (${o1('2026-08-10')})`);
  const v = einkauf(dbB, '2026-08-12', 'VAT_10');
  ok(preisSperre(v) === 'PURCHASE_EDIT_VAT_PERIOD', `D6 …Einkauf mit Vorsteuer im eingereichten Q3 gesperrt (${preisSperre(v)})`);
  dbB.run("DELETE FROM vat_filings WHERE id = 'vf-q3'");
}

// ── D7 nicht autorisiert ──
{
  const vorher = S(dbB.exec("SELECT * FROM settings WHERE key = 'accounting.opening_date'"));
  const m1 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'sales', userId: 'user-sales' }));
  const m2 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'owner', userId: 'user-sales' }));   // Rolle im Ausweis gefälscht
  const m3 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'owner', userId: 'user-unbekannt' }));
  ok(code(m1) === 'PERMISSION_DENIED' && code(m2) === 'PERMISSION_DENIED' && code(m3) === 'PERMISSION_DENIED',
    `D7 Verkäufer, gefälschte Owner-Rolle, unbekannter Benutzer: abgelehnt (${code(m1)}/${code(m2)}/${code(m3)})`);
  const m5 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'MANAGER', userId: 'user-manager' }));
  const m6 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'ACCOUNTANT', userId: 'user-acc' }));
  const m7 = meldung(() => setze('2026-05-01', { ...OWNER, role: 'ADMIN', userId: 'user-manager' }));   // ADMIN im Ausweis, MANAGER in der DB
  ok(code(m5) === 'PERMISSION_DENIED' && code(m6) === 'PERMISSION_DENIED' && code(m7) === 'PERMISSION_DENIED',
    `D7 …Manager, Buchhaltung, gefälschte ADMIN-Rolle: abgelehnt (${code(m5)}/${code(m6)}/${code(m7)})`);
  store.set('lataif_runtime_mode', 'client');
  let m4 = '';
  try { await house.setAccountingOpeningDateOnPrimary('2026-05-01'); } catch (e) { m4 = String((e as { code?: unknown }).code); }
  store.delete('lataif_runtime_mode');
  ok(m4 === 'PRIMARY_ONLY', `D7 …am zweiten Rechner gibt es den Weg nicht (${m4})`);
  ok(S(dbB.exec("SELECT * FROM settings WHERE key = 'accounting.opening_date'")) === vorher && od.accountingOpeningDate() === '2026-07-01',
    'D7 …nichts geändert');
  // Ein ZWEITER Administrator (Rolle 'ADMIN', nicht der ursprüngliche Owner) darf ändern — „owner" ist nur der alte Name.
  const rA = setze('2026-06-15', { ...OWNER, role: 'ADMIN', userId: 'user-admin2' });
  const aA = dbB.exec("SELECT changed_by, old_value, new_value FROM audit_log WHERE field_name = 'accounting.opening_date' ORDER BY rowid DESC LIMIT 1")[0]?.values?.[0] ?? [];
  ok(rA.changed && od.accountingOpeningDate() === '2026-06-15' && aA[0] === 'user-admin2' && aA[1] === '2026-07-01' && aA[2] === '2026-06-15',
    `D7 …ein zweiter ADMIN ändert 07-01 → 06-15, Audit nennt ihn (${S(aA)})`);
  setze('2026-07-01');   // zurück, für die folgenden Fälle
}

// ── D8 PC2 nutzt den Stichtag des Primary ──
{
  const reply = await executeCommand('session.context.get', { actor: { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-owner', role: 'owner' } },
    { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-owner', role: 'owner' } as never);
  ok(S(reply).includes('"accountingOpeningDate":"2026-07-01"'), `D8 die Sitzungsauskunft des Primary nennt seinen Stichtag (${S(reply).slice(0, 160)})`);
  store.set('lataif_runtime_mode', 'client');
  od.setClientAccountingOpeningDate('2026-07-01');
  const cWert = od.accountingOpeningDate(), cQuelle = od.accountingOpeningDateInfo().source;
  od.setClientAccountingOpeningDate('kaputt');
  const cLeer = od.accountingOpeningDate();
  store.delete('lataif_runtime_mode');
  ok(cWert === '2026-07-01' && cQuelle === 'primary', `D8 …der zweite Rechner zeigt den Wert des Primary (${cWert}, ${cQuelle})`);
  ok(cLeer === '2026-10-15', 'D8 …ohne gültigen Wert vom Primary: Standard, nie ein erfundener Tag');
  ok(/accountingOpeningDate: accountingOpeningDate\(\)/.test(src('src/core/bridge/store-read-commands.ts'))
    && /setClientAccountingOpeningDate\(ctx\?\.data\?\.accountingOpeningDate\)/.test(src('src/core/auth/client-session.ts')),
    'D8 …die Sperren selbst prüft die Hausfunktion am Primary; PC2 übernimmt den Wert nur zur Anzeige');
}

// ── K Konflikte vor dem Speichern ──
{
  // K1 Eröffnungsposten auf dem alten Stichtag
  const dbK = freshDb();
  dbK.run(`INSERT INTO opening_balance_items (id, branch_id, item_number, party_type, party_id, kind, scope, amount, cutoff_date, action_id, payload_hash, created_at)
    VALUES ('ob1','branch-main','OB-1','CUSTOMER','c1','CUSTOMER_RECEIVABLE','REMAINDER',100,'2026-10-15','a1','h1',?)`, [NOW]);
  const k1 = meldung(() => setze('2026-01-01'));
  ok(code(k1) === 'OPENING_DATE_UNSAFE' && /1 party opening balance is recorded as of 2026-10-15 \(customer or supplier page/.test(k1)
    && /cancel it first, or keep the opening date 2026-10-15\. Nothing was changed\./.test(k1) && od.accountingOpeningDate() === '2026-10-15',
    `K1 Eröffnungsposten zum 15.10. vorhanden: Stichtag nicht verschiebbar („${k1.slice(0, 110)}…")`);
  dbK.run("UPDATE opening_balance_items SET status = 'CANCELLED' WHERE id = 'ob1'");
  ok(meldung(() => setze('2026-01-01')) === '' && od.accountingOpeningDate() === '2026-01-01', 'K1 …nach dem Storno des Postens geht es');
  // K2 späterer Stichtag mit Vorgängen dazwischen
  setTestDatabase(dbB as never);
  const k2 = meldung(() => setze('2026-09-01'));
  ok(code(k2) === 'OPENING_DATE_UNSAFE' && /purchases/.test(k2) && od.accountingOpeningDate() === '2026-07-01',
    `K2 später (01.07. → 01.09.) mit Einkäufen dazwischen: abgelehnt („${k2.slice(0, 110)}…")`);
  const dbLeer = freshDb();
  setze('2026-03-01');
  ok(meldung(() => setze('2026-06-01')) === '' && od.accountingOpeningDate() === '2026-06-01', 'K2 …später ohne Vorgänge dazwischen: erlaubt');
  // K3 Zukunft / ungültig / unverändert
  const k3 = meldung(() => setze('2026-12-24'));
  const k4 = meldung(() => setze('2026-02-30'));
  ok(code(k3) === 'OPENING_DATE_UNSAFE' && /future/.test(k3) && code(k4) === 'OPENING_DATE_UNSAFE', `K3 Zukunft und erfundener Tag abgelehnt (${code(k3)}/${code(k4)})`);
  const audits = n(dbLeer, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'accounting.opening_date'");
  const r = setze('2026-06-01');
  ok(!r.changed && n(dbLeer, "SELECT COUNT(*) FROM audit_log WHERE field_name = 'accounting.opening_date'") === audits, 'K3 …derselbe Tag: nichts geschrieben, kein Audit');
  // K4 keine Rechnung, Zahlung, Buchung angefasst
  const tabellen = ['invoices', 'payments', 'ledger_entries', 'purchases', 'purchase_payments', 'opening_balance_items'];
  const vorher = S(tabellen.map((t) => n(dbB, `SELECT COUNT(*) FROM ${t}`)));
  setTestDatabase(dbB as never);
  setze('2026-02-01');
  ok(S(tabellen.map((t) => n(dbB, `SELECT COUNT(*) FROM ${t}`))) === vorher && od.accountingOpeningDate() === '2026-02-01',
    'K4 früherer Stichtag gespeichert — Rechnungen, Zahlungen, Buchungen, Einkäufe unverändert');
}

// ── Code: eine Quelle, keine feste Konstante mehr ──
{
  const dateien = ['src/core/parties/opening-balances.ts', 'src/core/accounting/opening-accounting.ts', 'src/core/purchases/purchase-edit-house.ts',
    'src/core/ledger/correction-dates.ts', 'src/core/repairs/repair-cost-date.ts', 'src/components/expenses/PayExpenseModal.tsx',
    'src/components/expenses/PaySupplierModal.tsx', 'src/core/offsets/party-settlement.ts'];
  ok(dateien.every((f) => !/OPENING_CUTOFF_DATE/.test(src(f))), 'Q keine feste Konstante OPENING_CUTOFF_DATE mehr in den Sperrwegen');
  ok(/accountingOpeningDate\(\)/.test(src('src/core/ledger/correction-dates.ts')), 'Q die Korrektur-Sperre (O1) liest den Stichtag der Datenbank');
}

console.log(`\nopening-date: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

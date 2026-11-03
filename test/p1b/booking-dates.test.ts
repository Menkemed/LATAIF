// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1b — Buchungsdaten (E11), Kundenwechsel rückwirkend (W1), Eröffnungsstichtag (O1),
// VAT-Periodenschutz (O2). Run: node test/p1b/booking-dates.test.ts
//
//   §1 E11  Preis einer Rechnung vom 20.10. am 05.11. korrigiert → Stichtag 01.11. zeigt den KORRIGIERTEN Wert
//   §2 E11  Datum 20.10. → 25.10.: Gegenbuchung 20.10., Neubuchung 25.10.
//   §3 O1   Original vor dem Eröffnungsstichtag (echte Konstante) → abgewiesen, nichts geändert; neutral geht
//   §4 O2   eingereichtes / VAT-bezahltes Quartal (auch unbezahlte Rechnung, auch über Datumswechsel) → abgewiesen
//   §5 W1   Kundenwechsel mit Teilzahlungen: jede Buchung auf ihrem Tag; keine doppelte Kasse/Bank; Grenzen je Datum
//   §6      Primary (editInvoiceOnPrimary) und PC2 (invoices.update) → dasselbe Hauptbuch
//   §7      Überzahlungs-Gutschrift auf dem Tag ihrer Entstehung; Fehler darin → vollständiger Rollback
// Jede Szene endet mit Kundenkonten-Abgleich (Counterparty-Audit) und ausgeglichenem Hauptbuch.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

// Die Uhr des Tests: „heute" ist ein fester Tag (Korrektur am 05.11.2026); einzelne Szenen stellen sie weiter.
const RealDate = Date;
let FIXED = RealDate.parse('2026-11-05T10:00:00.000Z');
class TestDate extends RealDate {
  constructor(...a: unknown[]) { if (a.length === 0) super(FIXED); else super(...(a as [string])); }
  static now(): number { return FIXED; }
}
(globalThis as { Date: DateConstructor }).Date = TestDate as unknown as DateConstructor;
const heute = (iso: string): void => { FIXED = RealDate.parse(iso); };
/** Die Korrektur geschieht eine Stunde nach dem Aufbau (am selben Tag) — so trennt `recorded_at` beides. */
const korrekturZeit = (): string => { FIXED += 3600_000; return new RealDate(FIXED).toISOString(); };

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

const store = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
  ['lataif_sync_url', 'http://127.0.0.1:9/sync'], ['lataif_sync_token', 'test-token'],
]);
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); }, removeItem: (k: string) => { store.delete(k); } };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const tc = await import('../../src/core/db/transaction-context.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { editInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-edit-house.ts');
const { runInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { trialBalanceAt } = await import('../../src/core/accounting/ledger-statements.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const { OPENING_CUTOFF_DATE } = await import('../../src/core/parties/opening-balances.ts');
const { CORRECTION_BEFORE_OPENING_CUTOFF } = await import('../../src/core/ledger/correction-dates.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const SETUP_AT = '2026-10-16T08:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Math.round(Number(one(db, sql, p) ?? 0) * 1000) / 1000;
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const a = dbSrc.indexOf('const migrations: string[] = ['); const b = dbSrc.indexOf('\n  ];', a);
  return [...dbSrc.slice(a, b).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = db.exec(`PRAGMA table_info(${table})`)[0].values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) { if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue; data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? SETUP_AT : ''); }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}
function reload(): void { useProductStore.getState().loadProducts(); useCustomerStore.getState().loadCustomers(); useInvoiceStore.getState().loadInvoices(); }
function freshDb(): Db {
  resetDurabilityStateForTest(); resetTransactionHealthForTest(); tc.resetTransactionContext();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const st of MIGRATIONS) { try { db.run(st); } catch { /* da */ } }
  for (const st of A1_UPGRADE_SQL) { try { db.run(st); } catch { /* da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [SETUP_AT, SETUP_AT]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [SETUP_AT, SETUP_AT]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, SETUP_AT, SETUP_AT]);
  }
  applyMediaSchema(db as never); setTestDatabase(db as never); installWriteGuard(db as never); reload(); tauriState.reset();
  return db;
}
function product(db: Db, id: string): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [id, 'M ' + id, 'SKU-' + id, SETUP_AT, SETUP_AT]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES (?,'branch-main',?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, id, SETUP_AT, SETUP_AT]);
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
function imHaus<T>(fn: () => T): T { posting.beginLedgerTransaction(); try { const o = fn(); posting.commitLedgerTransaction(); return o; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } }
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; } };
const LINE = (pid: string, price: number, lineId?: string) => ({ ...(lineId ? { lineId } : {}), productId: pid, lotId: 'lot-' + pid, quantity: 1, unitPrice: price,
  purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: price / 10, lineTotal: price * 1.1 });
function rechnung(db: Db, pid: string, datum: string, kunde = 'cust-1'): string {
  product(db, pid); reload();
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(kunde, [LINE(pid, 1000)] as never, 'P1b', datum).id);
  reload(); return id;
}
function zahlung(inv: string, betrag: number, tag: string, art = 'cash'): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, art, undefined, undefined, undefined, undefined, undefined, { receivedAt: `${tag}T09:00:00.000Z` } as never));
  reload(); return id;
}
const zeile = (db: Db, inv: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
const edit = (inv: string, input: Record<string, unknown>): string => {
  const m = meldung(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'P1b Korrektur', ...input } as never)); reload(); return m;
};
/** Kontostand zum Stichtag (Stand 00:00 Ortszeit des Tages) — die echte Stichtagsliste. */
const stichtag = (tag: string, konto: string): number => trialBalanceAt({ branchId: 'branch-main' }, tag).lines.find((l: { account: string }) => l.account === konto)?.balance ?? 0;
const arKunde = (db: Db, kunde: string, tag: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
    WHERE account='ACCOUNTS_RECEIVABLE' AND counterparty_id=? AND occurred_at < ?`, [kunde, new RealDate(`${tag}T00:00:00`).toISOString()]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries")) < 0.005;
function kontenOk(db: Db): string {
  const run = (sql: string, p: unknown[] = []) => { const r = db.exec(sql, p)[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
  const a = runCounterpartyAudit(run as never, 'branch-main');
  const bad = [...a.arByCustomer.rows, ...a.customerCreditByCustomer.rows].filter((r: { status: string }) => r.status !== 'ok');
  return bad.map((r: { account: string; id: string; diffFils: number }) => `${r.account}:${r.id} ${r.diffFils}`).join(', ') + (a.issues.length ? ` issues:${a.issues.map((i: { kind: string }) => i.kind).join('/')}` : '');
}
function zustand(db: Db, inv: string): string {
  return S([db.exec('SELECT gross_amount, paid_amount, status, revision, customer_id, issued_at FROM invoices WHERE id = ?', [inv])[0]?.values,
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]), all(db, 'SELECT id, amount, received_at FROM payments ORDER BY id'),
    all(db, 'SELECT id, customer_id FROM credit_notes ORDER BY id')]);
}
/** Die Tage (JJJJ-MM-TT), an denen eine Quelle seit `ab` (Aufzeichnungszeit) gebucht wurde. */
const tageSeit = (db: Db, quelle: string, id: string, ab: string): string => all(db,
  "SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = ? AND source_id = ? AND recorded_at >= ? ORDER BY 1", [quelle, id, ab]);
const filed = (db: Db, y: number, q: number): void => insert(db, 'vat_filings', { id: `vf-${y}-${q}`, branch_id: 'branch-main', year: y, quarter: q, filed_at: new RealDate(FIXED).toISOString() });

// ── §1 E11: Preis korrigiert, Stichtag zwischen Original und Korrektur ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p1', '2026-10-20');
  ok(stichtag('2026-11-01', 'ACCOUNTS_RECEIVABLE') === 1100, '§1 vorher: Stichtag 01.11. Forderung 1100');
  const ab = korrekturZeit();
  const m = edit(inv, { lines: [LINE('p1', 900, zeile(db, inv))] });
  ok(m === '' && Math.abs(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) - 990) < 0.001, `§1 Korrektur am 05.11. gespeichert (${m})`);
  ok(stichtag('2026-11-01', 'ACCOUNTS_RECEIVABLE') === 990 && stichtag('2026-11-01', 'REVENUE') === 900,
    `§1 Stichtag 01.11. zeigt den KORRIGIERTEN Wert (Forderung ${stichtag('2026-11-01', 'ACCOUNTS_RECEIVABLE')}, Umsatz ${stichtag('2026-11-01', 'REVENUE')}; vorher fälschlich 2090)`);
  ok(stichtag('2026-10-20', 'ACCOUNTS_RECEIVABLE') === 0 && stichtag('2026-10-21', 'ACCOUNTS_RECEIVABLE') === 990, '§1 …vor dem Rechnungstag 0, ab dem Folgetag 990');
  ok(tageSeit(db, 'INVOICE', inv, ab) === S([['2026-10-20']]), `§1 Gegen- UND Neubuchung auf dem Rechnungsdatum (${tageSeit(db, 'INVOICE', inv, ab)})`);
  ok(s(db, 'SELECT substr(MIN(recorded_at),1,10) FROM ledger_entries WHERE recorded_at >= ?', [ab]) === '2026-11-05'
    && s(db, 'SELECT substr(edited_at,1,10) FROM invoice_edits WHERE invoice_id = ?', [inv]) === '2026-11-05',
    '§1 Audit: der tatsächliche Änderungstag (05.11.) steht in recorded_at und invoice_edits');
  ok(kontenOk(db) === '' && ausgeglichen(db), `§1 Kundenkonten abgestimmt, Hauptbuch ausgeglichen ${kontenOk(db)}`);
  // zweite Korrektur: das Original ist jetzt selbst eine Neubuchung — gespiegelt wird wieder auf dessen Tag
  const m2 = edit(inv, { lines: [LINE('p1', 800, zeile(db, inv))] });
  ok(m2 === '' && stichtag('2026-11-01', 'ACCOUNTS_RECEIVABLE') === 880 && kontenOk(db) === '' && ausgeglichen(db), '§1 zweite Korrektur ebenso periodengerecht (880)');
}

// ── §2 E11: Datumswechsel 20.10. → 25.10. ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p2', '2026-10-20');
  const ab = korrekturZeit();
  const m = edit(inv, { lines: [LINE('p2', 1000, zeile(db, inv))], issuedAt: '2026-10-25' });
  const gegen = all(db, "SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_id = ? AND reverses_entry_id IS NOT NULL AND recorded_at >= ?", [inv, ab]);
  const neuB = all(db, "SELECT DISTINCT substr(occurred_at,1,10) FROM ledger_entries WHERE source_id = ? AND reverses_entry_id IS NULL AND recorded_at >= ?", [inv, ab]);
  ok(m === '' && gegen === S([['2026-10-20']]) && neuB === S([['2026-10-25']]), `§2 Gegenbuchung 20.10. (${gegen}), Neubuchung 25.10. (${neuB})`);
  ok(stichtag('2026-10-23', 'ACCOUNTS_RECEIVABLE') === 0 && stichtag('2026-10-26', 'ACCOUNTS_RECEIVABLE') === 1100, '§2 Stichtag 23.10. leer, ab 26.10. 1100');
  ok(kontenOk(db) === '' && ausgeglichen(db), '§2 abgestimmt, ausgeglichen');
}

// ── §3 O1: vor dem Eröffnungsstichtag (echte Konstante) ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  ok(OPENING_CUTOFF_DATE === '2026-10-15', `§3 Stichtag aus der Owner-Konstante (${OPENING_CUTOFF_DATE})`);
  const vorAlt = rechnung(db, 'p3', '2026-10-10');
  const z0 = zustand(db, vorAlt);
  const m = edit(vorAlt, { lines: [LINE('p3', 900, zeile(db, vorAlt))] });
  ok(m.startsWith(CORRECTION_BEFORE_OPENING_CUTOFF + '|') && zustand(db, vorAlt) === z0, `§3 Preis einer Rechnung vom 10.10. → abgewiesen, nichts geändert (${m.slice(0, 60)})`);
  const vor = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const mn = edit(vorAlt, { lines: [LINE('p3', 1000, zeile(db, vorAlt))], notes: 'nur eine Notiz' });
  ok(mn === '' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vor && s(db, 'SELECT notes FROM invoices WHERE id = ?', [vorAlt]) === 'nur eine Notiz'
    && n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [vorAlt]) === 1,
    '§3 eine reine Notizänderung bleibt erlaubt — KEINE Hauptbuchzeile entsteht, nur Feld und Protokoll');
  const spaet = rechnung(db, 'p3b', '2026-10-20');
  const z1 = zustand(db, spaet);
  const md = edit(spaet, { lines: [LINE('p3b', 1000, zeile(db, spaet))], issuedAt: '2026-10-12' });
  ok(md.startsWith(CORRECTION_BEFORE_OPENING_CUTOFF + '|') && zustand(db, spaet) === z1, '§3 Datum 20.10. → 12.10. (vor den Stichtag) → abgewiesen, nichts geändert');
  ok(kontenOk(db) === '' && ausgeglichen(db), '§3 abgestimmt, ausgeglichen');
}

// ── §4 O2: eingereichte / bezahlte Quartale ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p4', '2026-10-20');                  // unbezahlt, nie exportiert
  filed(db, 2026, 4);
  const z = zustand(db, inv);
  const m = edit(inv, { lines: [LINE('p4', 900, zeile(db, inv))] });
  ok(m.startsWith('VAT_PERIOD_FILED|') && zustand(db, inv) === z, `§4 unbezahlte, nicht exportierte Rechnung im eingereichten Q4: Preis → abgewiesen, keine Mutation (${m.slice(0, 50)})`);
  const le4 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  ok(edit(inv, { lines: [LINE('p4', 1000, zeile(db, inv))], notes: 'Notiz', staffId: 'staff-1' }) === '' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === le4
    && s(db, 'SELECT staff_id FROM invoices WHERE id = ?', [inv]) === 'staff-1', '§4 …Notiz und Mitarbeiter bleiben erlaubt, ohne jede Hauptbuchzeile');
  const zd = zustand(db, inv);
  const mdesc = edit(inv, { lines: [{ ...LINE('p4', 1000, zeile(db, inv)), description: 'Neue Bezeichnung' }] });
  ok(mdesc.startsWith('VAT_PERIOD_FILED|') && zustand(db, inv) === zd && s(db, "SELECT COALESCE(description,'') FROM invoice_lines WHERE invoice_id = ?", [inv]) === '',
    `§4 …eine geänderte ZEILENBEZEICHNUNG im eingereichten Quartal → abgewiesen (nur Notiz/Mitarbeiter sind frei) (${mdesc.slice(0, 40)})`);
  // Datumswechsel aus einem offenen IN ein zugemachtes Quartal und umgekehrt (eigene Uhr: Februar 2027)
  heute('2027-02-10T10:00:00.000Z');
  const db2 = freshDb();
  const imOffenen = rechnung(db2, 'p5', '2027-01-20');
  const imZu = rechnung(db2, 'p6', '2026-12-15');
  db2.run("INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, created_at) VALUES ('tp-q4','branch-main',2026,4,10,'VAT',?,?)", [SETUP_AT, SETUP_AT]);
  const za = zustand(db2, imOffenen), zb = zustand(db2, imZu);
  const ma = edit(imOffenen, { lines: [LINE('p5', 1000, zeile(db2, imOffenen))], issuedAt: '2026-12-20' });
  const mb = edit(imZu, { lines: [LINE('p6', 1000, zeile(db2, imZu))], issuedAt: '2027-01-25' });
  ok(ma.startsWith('VAT_PERIOD_FILED|') && zustand(db2, imOffenen) === za, '§4 Datum aus dem offenen Q1/2027 in das VAT-bezahlte Q4/2026 → abgewiesen');
  ok(mb.startsWith('VAT_PERIOD_FILED|') && zustand(db2, imZu) === zb, '§4 Datum aus dem VAT-bezahlten Q4/2026 hinaus → abgewiesen (die Gegenbuchung läge im zugemachten Quartal)');
  ok(kontenOk(db2) === '' && ausgeglichen(db2), '§4 abgestimmt, ausgeglichen');
}

// ── §5 W1: Kundenwechsel mit Teilzahlungen ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p7', '2026-10-20');
  const p1 = zahlung(inv, 300, '2026-10-22', 'cash');
  const p2 = zahlung(inv, 400, '2026-11-03', 'bank_transfer');
  const kasse = n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='CASH'");
  const bank = n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='BANK'");
  const k23 = stichtag('2026-10-23', 'CASH'), b04 = stichtag('2026-11-04', 'BANK');
  const ab = korrekturZeit();
  const m = edit(inv, { lines: [LINE('p7', 1000, zeile(db, inv))], customerId: 'cust-2', confirmCustomerChange: true });
  ok(m === '' && s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]) === 'cust-2', `§5 Kundenwechsel gespeichert (${m})`);
  ok(arKunde(db, 'cust-2', '2026-10-21') === 1100 && arKunde(db, 'cust-2', '2026-10-23') === 800 && arKunde(db, 'cust-2', '2026-11-04') === 400
    && arKunde(db, 'cust-1', '2026-10-21') === 0 && arKunde(db, 'cust-1', '2026-10-23') === 0 && arKunde(db, 'cust-1', '2026-11-04') === 0,
    `§5 rückwirkend: Nora 1100 → 800 → 400 an den Stichtagen 21.10./23.10./04.11., Ali immer 0`);
  ok(tageSeit(db, 'INVOICE', inv, ab) === S([['2026-10-20']]) && tageSeit(db, 'PAYMENT', p1, ab) === S([['2026-10-22']]) && tageSeit(db, 'PAYMENT', p2, ab) === S([['2026-11-03']]),
    '§5 Rechnung auf 20.10., Zahlungen auf 22.10. und 03.11. umgebucht — keine Buchung am Wechseltag');
  ok(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='CASH'") === kasse && kasse === 300
    && n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='BANK'") === bank && bank === 400
    && stichtag('2026-10-23', 'CASH') === k23 && stichtag('2026-11-04', 'BANK') === b04,
    '§5 Kasse 300 und Bank 400 unverändert, auch an jedem Stichtag — keine doppelte Geldwirkung');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 2 && kontenOk(db) === '' && ausgeglichen(db), `§5 zwei Zahlungen, abgestimmt, ausgeglichen ${kontenOk(db)}`);
  // Grenzen je Datum: Zahlung vor dem Stichtag (z. B. eine Anzahlung vom 14.10.)
  const inv2 = rechnung(db, 'p8', '2026-10-16');
  const pv = zahlung(inv2, 200, '2026-10-17');
  db.run("UPDATE payments SET received_at = '2026-10-14T09:00:00.000Z' WHERE id = ?", [pv]);
  db.run("UPDATE ledger_entries SET occurred_at = '2026-10-14T09:00:00.000Z' WHERE source_module = 'PAYMENT' AND source_id = ?", [pv]);
  reload();
  const z2 = zustand(db, inv2);
  const mv = edit(inv2, { lines: [LINE('p8', 1000, zeile(db, inv2))], customerId: 'cust-2', confirmCustomerChange: true });
  ok(mv.startsWith(CORRECTION_BEFORE_OPENING_CUTOFF + '|') && zustand(db, inv2) === z2, `§5 eine Zahlung vor dem Stichtag sperrt den Wechsel, nichts geändert (${mv.slice(0, 60)})`);
  // Rechnungsquartal offen, Zahlungsquartal geschlossen
  heute('2027-02-10T10:00:00.000Z');
  const db3 = freshDb();
  const inv3 = rechnung(db3, 'p9', '2026-12-20');
  zahlung(inv3, 500, '2027-01-15');
  filed(db3, 2027, 1);
  const z3 = zustand(db3, inv3);
  const m3 = edit(inv3, { lines: [LINE('p9', 1000, zeile(db3, inv3))], customerId: 'cust-2', confirmCustomerChange: true });
  ok(m3.startsWith('VAT_PERIOD_FILED|') && zustand(db3, inv3) === z3, `§5 Rechnungsquartal offen, Zahlungsquartal eingereicht → abgewiesen, nichts geändert (${m3.slice(0, 50)})`);
}

// ── §6 Primary und PC2: dasselbe Hauptbuch ──
{
  heute('2026-11-05T10:00:00.000Z');
  const sig = (db: Db, inv: string): string => all(db,
    "SELECT account, direction, ROUND(amount,3), substr(occurred_at,1,10), COALESCE(counterparty_id,''), reverses_entry_id IS NOT NULL FROM ledger_entries WHERE source_id IN (?, (SELECT id FROM payments WHERE invoice_id = ? LIMIT 1)) ORDER BY 1,2,3,4,5,6", [inv, inv]);
  const dbA = freshDb();
  const a = rechnung(dbA, 'p10', '2026-10-20');
  zahlung(a, 300, '2026-10-22');
  await editInvoiceOnPrimary(a, { lines: [LINE('p10', 900, zeile(dbA, a))] as never, customerId: 'cust-2', confirmCustomerChange: true, reason: 'P1b' } as never,
    n(dbA, 'SELECT revision FROM invoices WHERE id = ?', [a]));
  const sigA = sig(dbA, a);
  const dbB = freshDb();
  const b = rechnung(dbB, 'p10', '2026-10-20');
  zahlung(b, 300, '2026-10-22');
  const deps = { db: dbB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* test */ }, now: () => new RealDate(FIXED).toISOString() };
  const r = await runInvoiceUpdate(deps as never, { commandId: '00000b01-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main',
    userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'hb01' } as never, {
    id: b, expectedRevision: n(dbB, 'SELECT revision FROM invoices WHERE id = ?', [b]), reason: 'P1b', customerId: 'cust-2', confirmCustomerChange: true,
    lines: [{ lineId: zeile(dbB, b), productId: 'p10', lotId: 'lot-p10', quantity: 1, unitPrice: 900 }],
  });
  reload();
  ok(r.kind === 'ok' && sigA === sig(dbB, b) && sigA.length > 20, `§6 Primary und PC2: dasselbe Hauptbuch (Konten, Beträge, Tage, Kunde) (${r.kind})`);
  ok(kontenOk(dbB) === '' && ausgeglichen(dbB), '§6 abgestimmt, ausgeglichen');
}

// ── §7 Überzahlung: Gutschrift am Tag ihrer Entstehung; Fehler darin → Rollback ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p11', '2026-10-20');
  zahlung(inv, 1100, '2026-10-28');
  const ab = korrekturZeit();
  const m = edit(inv, { lines: [LINE('p11', 900, zeile(db, inv))] });
  const credit = all(db, "SELECT substr(occurred_at,1,10), ROUND(amount,3) FROM ledger_entries WHERE source_id = ? AND account = 'CUSTOMER_CREDIT' AND recorded_at >= ?", [inv, ab]);
  ok(m === '' && credit === S([['2026-10-28', 110]]), `§7 Überzahlung 110 als Guthaben am 28.10. (Tag der Zahlung), nicht am Korrekturtag (${credit})`);
  ok(arKunde(db, 'cust-1', '2026-10-29') === 0 && kontenOk(db) === '' && ausgeglichen(db), '§7 Stichtag 29.10.: Forderung 0 (keine negative Forderung dazwischen), abgestimmt');
  // Zahlung in einem eingereichten Quartal: die Gutschrift läge dort → abgewiesen, vollständiger Rollback
  heute('2027-02-10T10:00:00.000Z');
  const db2 = freshDb();
  const inv2 = rechnung(db2, 'p12', '2026-12-20');
  zahlung(inv2, 1100, '2027-01-05');
  filed(db2, 2027, 1);
  const z = zustand(db2, inv2);
  const m2 = edit(inv2, { lines: [LINE('p12', 900, zeile(db2, inv2))] });
  ok(m2.startsWith('VAT_PERIOD_FILED|') && zustand(db2, inv2) === z && tc.transactionDepth() === 0,
    `§7 Gutschrift läge im eingereichten Q1/2027 → abgewiesen, Rechnung/Hauptbuch/Zahlungen unverändert (${m2.slice(0, 50)})`);
}

// ── §8 Änderungen ohne Buchungswirkung im OFFENEN Zeitraum: kein Hauptbuch, nur Felder + Protokoll ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p13', '2026-10-20');
  zahlung(inv, 1210, '2026-10-21');                                  // überzahlt (1100 + 110 Guthaben)
  const m0 = edit(inv, { lines: [LINE('p13', 900, zeile(db, inv))] }); // macht ein Edit-Guthaben (Buchung + Zeile)
  const le = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const cc = all(db, 'SELECT id, amount, used_amount FROM customer_credits ORDER BY id');
  const m = edit(inv, { lines: [{ ...LINE('p13', 900, zeile(db, inv)), description: 'Bezeichnung korrigiert' }], notes: 'Notiz', staffId: 'staff-2' });
  ok(m0 === '' && m === '' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === le && all(db, 'SELECT id, amount, used_amount FROM customer_credits ORDER BY id') === cc
    && s(db, 'SELECT description FROM invoice_lines WHERE invoice_id = ?', [inv]) === 'Bezeichnung korrigiert' && s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv]) === 'Notiz',
    `§8 Bezeichnung, Notiz, Mitarbeiter (offener Zeitraum): Felder geändert, KEINE Hauptbuchzeile, Guthaben samt Buchung unverändert (${m0}|${m})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]) === 2 && kontenOk(db) === '' && ausgeglichen(db),
    '§8 …das Protokoll hält die Änderung fest; abgestimmt, ausgeglichen');
}

// ── §9 TOCTOU: Stichtag und VAT-Sperre gelten zum SCHREIBZEITPUNKT, im exklusiven Platz ──
{
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  const inv = rechnung(db, 'p14', '2026-10-20');
  const gesehen = n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);   // Maske geöffnet
  filed(db, 2026, 4);                                                            // danach eingereicht
  const z = zustand(db, inv);
  let m = '';
  try { await editInvoiceOnPrimary(inv, { lines: [LINE('p14', 900, zeile(db, inv))], reason: 'alt geöffnet' } as never, gesehen); } catch (e) { m = String((e as { code?: unknown }).code ?? ''); }
  ok(m === 'VAT_PERIOD_FILED' && zustand(db, inv) === z, `§9 Primary: Einreichung NACH dem Öffnen, VOR dem Speichern → abgewiesen, nichts geändert (${m})`);
  const deps = { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* test */ }, now: () => new RealDate(FIXED).toISOString() };
  const r = await runInvoiceUpdate(deps as never, { commandId: '00000c01-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main',
    userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'hc01' } as never, {
    id: inv, expectedRevision: gesehen, reason: 'PC2 alt', customerId: 'cust-1', lines: [{ lineId: zeile(db, inv), productId: 'p14', lotId: 'lot-p14', quantity: 1, unitPrice: 900 }],
  });
  ok(r.kind === 'rejected' && (r as { code?: string }).code === 'VAT_PERIOD_FILED' && zustand(db, inv) === z, `§9 PC2: dasselbe — endgültiges Nein, nichts geändert (${r.kind}:${(r as { code?: string }).code})`);
  // Gleichzeitig angestoßen: Korrektur und Einreichung laufen nacheinander im exklusiven Platz, nie verschränkt.
  // (Eingereicht werden darf nur ein abgelaufenes Quartal → die Uhr steht hier im Januar 2027.)
  heute('2027-01-10T10:00:00.000Z');
  const db2 = freshDb();
  const inv2 = rechnung(db2, 'p15', '2026-12-20');
  const { runOnPrimary } = await import('../../src/core/data/primary-action.ts');
  const { markVatQuarterFiled } = await import('../../src/core/tax/vat-period-lock.ts');
  const [a, b] = await Promise.allSettled([
    editInvoiceOnPrimary(inv2, { lines: [LINE('p15', 900, zeile(db2, inv2))], reason: 'gleichzeitig' } as never, n(db2, 'SELECT revision FROM invoices WHERE id = ?', [inv2])),
    runOnPrimary(() => markVatQuarterFiled({ branchId: 'branch-main', year: 2026, quarter: 4, userId: 'user-test' }), reload),
  ]);
  reload();
  const brutto = n(db2, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv2]);
  const korrekturZuerst = a.status === 'fulfilled' && Math.abs(brutto - 990) < 0.001;
  const einreichungZuerst = a.status === 'rejected' && String((a.reason as { code?: unknown })?.code) === 'VAT_PERIOD_FILED' && Math.abs(brutto - 1100) < 0.001;
  ok(b.status === 'fulfilled' && n(db2, 'SELECT COUNT(*) FROM vat_filings') === 1 && (korrekturZuerst || einreichungZuerst)
    && stichtag('2026-12-31', 'ACCOUNTS_RECEIVABLE') === brutto && kontenOk(db2) === '' && ausgeglichen(db2),
    `§9 gleichzeitig angestoßen: streng nacheinander (${korrekturZuerst ? 'erst Korrektur, dann Einreichung' : einreichungZuerst ? 'erst Einreichung, Korrektur abgewiesen' : 'VERSCHRÄNKT'}; ${a.status}/${b.status}, ${brutto})`);
  const st = src('src/stores/invoiceStore.ts');
  const edAt = st.indexOf('  editInvoice: (id, input) => {');
  const ed = st.slice(edAt, st.indexOf('  recordPayment: (invoiceId', edAt));
  const code = ed.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/\bawait\b/.test(code) && ed.indexOf('beginLedgerTransaction();') < ed.indexOf('const tageNein = correctionDateIssue(')
    && ed.indexOf('const tageNein = correctionDateIssue(') < ed.indexOf("reverseSource('INVOICE', id, now"),
    '§9 Quelltext: editInvoice ist synchron (kein await); die Perioden-/Stichtagsprüfung steht IN der Transaktion, vor dem ersten Schreiben');
}

// ── §10 Test-Schalter des Stichtags ──
{
  const cd = src('src/core/ledger/correction-dates.ts');
  const { readdirSync, statSync } = await import('node:fs');
  const dateien = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = resolvePath(dir, f);
    return statSync(p).isDirectory() ? dateien(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
  const aufrufer = dateien(resolvePath(repo, 'src')).filter((p) => readFileSync(p, 'utf8').includes('setOpeningCutoffForTest'))
    .map((p) => p.slice(repo.length + 1).replace(/\\/g, '/'));
  ok(S(aufrufer) === S(['src/core/ledger/correction-dates.ts']), `§10 im Produktionscode ruft niemand den Test-Schalter (nur seine Definition: ${aufrufer.join(',')})`);
  ok(/const nurNodeTest = \(\): boolean => typeof import\.meta\.env === 'undefined';/.test(cd)
    && /if \(!nurNodeTest\(\)\) throw new Error\(/.test(cd)
    && /nurNodeTest\(\) && cutoffForTest !== null \? cutoffForTest : OPENING_CUTOFF_DATE/.test(cd),
    '§10 in der App (Vite setzt import.meta.env) wirft das Setzen, und gelesen wird immer die Owner-Konstante');
}

console.log(`\np1b-booking-dates: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1c — Rechnungsmaske: Brutto beim Steuerartwechsel, Kundenüberzahlung (Guthaben ODER Rückzahlung),
// Teilretoure (Zeilenteilung). Run: node test/p1c/invoice-correction.test.ts
//
//   §A Steuerartwechsel MARGIN ↔ VAT 10 % ↔ ZERO: Kundenbrutto bleibt, VAT und Hauptbuch neu; Primary = PC2
//   §B Überzahlung: Pflichtwahl; Guthaben (einlösbar) / Rückzahlungsanspruch (nicht einlösbar, kein Geld);
//      spätere Auszahlung (Teil, Rest, Wiederholung, zu viel, falscher Tag, Weg); „Paid out now"; Rollback;
//      gleiche Überzahlung behält ihre Wahl; nach Auszahlung gesperrt; zugemachte Periode; Primary = PC2
//   §C Teilretoure 3 Stück, 1 retourniert: nur die 2 übrigen korrigierbar (Zeilenteilung) — Retoure, Los,
//      Einstand, Lager, Gutschrift unverändert; ohne Änderung keine Teilung; Grenzen; Rest entfernen; Primary = PC2
//   §D Rechte, Fernvertrag, Quelltext der Maske
// Jede Szene endet mit Kundenkonten-Abgleich (Counterparty-Audit) und ausgeglichenem Hauptbuch.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const RealDate = Date;
let FIXED = RealDate.parse('2026-11-05T10:00:00.000Z');
class TestDate extends RealDate {
  constructor(...a: unknown[]) { if (a.length === 0) super(FIXED); else super(...(a as [string])); }
  static now(): number { return FIXED; }
}
(globalThis as { Date: DateConstructor }).Date = TestDate as unknown as DateConstructor;
const heute = (iso: string): void => { FIXED = RealDate.parse(iso); };

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
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { loadPayablesFor } = await import('../../src/stores/payablesStore.ts').catch(() => ({ loadPayablesFor: undefined }));
const { editInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-edit-house.ts');
const { runInvoiceUpdate, parseInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { runRecordRefundPayment } = await import('../../src/core/bridge/return-commands.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const { unitNetKeepingGross } = await import('../../src/core/invoices/line-derivation.ts');
const refund = await import('../../src/core/invoices/invoice-refund.ts');
const { EDIT_SPLIT_INVALID } = await import('../../src/core/invoices/edit-lines.ts');
const { OPERATION_PERMISSIONS } = await import('../../src/core/bridge/command-permissions.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');

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
function reload(): void {
  useProductStore.getState().loadProducts(); useCustomerStore.getState().loadCustomers(); useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
}
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
function product(db: Db, id: string, qty = 1, cost = 100, scheme = 'VAT_10'): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',150,'in_stock',?,0,'[]','{}','OWN',?,?)`, [id, 'M ' + id, 'SKU-' + id, qty, cost, scheme, SETUP_AT, SETUP_AT]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES (?,'branch-main',?,?,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, cost, qty, qty, SETUP_AT, SETUP_AT]);
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
function imHaus<T>(fn: () => T): T { posting.beginLedgerTransaction(); try { const o = fn(); posting.commitLedgerTransaction(); return o; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } }
const meldung = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; } };
const ameldung = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; } };
/** Eine Zeile wie die Maske sie schickt (Netto pro Stück), aus `toInvoiceLine`-Werten. */
const LINE = (pid: string, net: number, qty = 1, scheme = 'VAT_10', cost = 100, extra: Record<string, unknown> = {}) => {
  const rate = scheme === 'ZERO' ? 0 : 10;
  const gross = scheme === 'VAT_10' ? net * qty * 1.1 : net * qty;
  const vat = scheme === 'VAT_10' ? net * qty * 0.1 : scheme === 'MARGIN' ? Math.max(0, gross - cost * qty) / 11 : 0;
  return { productId: pid, lotId: 'lot-' + pid, quantity: qty, unitPrice: net, purchasePrice: cost, taxScheme: scheme, vatRate: rate, vatAmount: vat, lineTotal: gross, ...extra };
};
function rechnung(pid: string, net: number, datum: string, qty = 1, kunde = 'cust-1', cost = 100): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(kunde, [LINE(pid, net, qty, 'VAT_10', cost)] as never, 'P1c', datum).id);
  reload(); return id;
}
function zahlung(inv: string, betrag: number, tag: string, art = 'cash'): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, art, undefined, undefined, undefined, undefined, undefined, { receivedAt: `${tag}T09:00:00.000Z` } as never));
  reload(); return id;
}
const zeile = (db: Db, inv: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY position LIMIT 1', [inv]);
const rev = (db: Db, inv: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
const edit = (inv: string, input: Record<string, unknown>): string => {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { reason: 'P1c Korrektur', ...input } as never))); reload(); return m;
};
const konto = (db: Db, acc: string): number => n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = ?", [acc]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db, "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries")) < 0.005;
function kontenOk(db: Db): string {
  const run = (sql: string, p: unknown[] = []) => { const r = db.exec(sql, p)[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; };
  const a = runCounterpartyAudit(run as never, 'branch-main');
  const bad = [...a.arByCustomer.rows, ...a.customerCreditByCustomer.rows].filter((r: { status: string }) => r.status !== 'ok');
  return bad.map((r: { account: string; id: string; diffFils: number }) => `${r.account}:${r.id} ${r.diffFils}`).join(', ') + (a.issues.length ? ` issues:${a.issues.map((i: { kind: string; detail?: string }) => `${i.kind}(${i.detail ?? ''})`).join('/')}` : '');
}
function zustand(db: Db, inv: string): string {
  return S([all(db, 'SELECT gross_amount, vat_amount, paid_amount, status, revision FROM invoices WHERE id = ?', [inv]),
    all(db, 'SELECT id, quantity, unit_price, tax_scheme, line_total, lot_id, stock_taken FROM invoice_lines WHERE invoice_id = ? ORDER BY id', [inv]),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM invoice_edits'), all(db, 'SELECT id, amount, used_amount, status FROM customer_credits ORDER BY id'),
    n(db, 'SELECT COUNT(*) FROM customer_credit_refunds'), all(db, 'SELECT id, qty_remaining FROM stock_lots ORDER BY id'), all(db, 'SELECT id, quantity FROM products ORDER BY id')]);
}
const deps = (db: Db) => ({ db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => { /* test */ }, now: () => new RealDate(FIXED).toISOString() });
let cmdSeq = 0;
const ident = (op: string, id?: string) => ({ commandId: id ?? `00000c${String(++cmdSeq).padStart(2, '0')}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId: 'branch-main',
  userId: 'user-test', role: 'ADMIN', op, payloadKind: 'x', payloadHash: `h${cmdSeq}` });
/** Die Buchungen einer Rechnung als Vergleichszeile (Konto, Richtung, Betrag, Tag, Kunde, Gegenbuchung). */
const sig = (db: Db, inv: string): string => all(db,
  "SELECT account, direction, ROUND(amount,3), substr(occurred_at,1,10), COALESCE(counterparty_id,''), reverses_entry_id IS NOT NULL FROM ledger_entries WHERE source_id = ? ORDER BY 1,2,3,4,5,6", [inv]);
const claimOf = (db: Db, inv: string): string => all(db, "SELECT amount, used_amount, status FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]);

// ── §A Steuerartwechsel: Kundenbrutto bleibt ─────────────────────────────────────────────────
{
  const nah = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;
  ok(nah(unitNetKeepingGross(1100, 1, 'VAT_10', 10), 1000) && nah(unitNetKeepingGross(1100, 2, 'MARGIN', 10), 550) && nah(unitNetKeepingGross(990, 1, 'ZERO', 0), 990),
    '§A Regel: netto aus brutto (VAT 10 % / 1,1; Margin und Zero-rated = brutto)');
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb();
  product(db, 'pT', 1, 600);
  reload();
  const inv = rechnung('pT', 1000, '2026-10-20', 1, 'cust-1', 600);
  zahlung(inv, 1100, '2026-10-21');
  const L = zeile(db, inv);
  const schritt = (scheme: string): string => edit(inv, { lines: [LINE('pT', unitNetKeepingGross(1100, 1, scheme as never, scheme === 'ZERO' ? 0 : 10), 1, scheme, 600, { lineId: L })] });
  const mM = schritt('MARGIN');
  ok(mM === '' && n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 1100 && n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) === 45.455
    && konto(db, 'VAT_OUTPUT') === 0 && konto(db, 'MARGIN_VAT') === -45.455,
    `§A VAT 10 % → Margin: Brutto bleibt 1100, Margin-VAT (1100−600)/11 = 45,455, keine VAT 10 % mehr (${mM})`);
  const mZ = schritt('ZERO');
  ok(mZ === '' && n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 1100 && n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) === 0
    && konto(db, 'MARGIN_VAT') === 0 && konto(db, 'VAT_OUTPUT') === 0 && konto(db, 'REVENUE') === -1100,
    `§A Margin → Zero-rated: Brutto 1100, VAT 0, Erlös 1100 (${mZ})`);
  const mV = schritt('VAT_10');
  ok(mV === '' && n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 1100 && n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) === 100
    && konto(db, 'VAT_OUTPUT') === -100 && konto(db, 'REVENUE') === -1000,
    `§A Zero-rated → VAT 10 %: Brutto 1100, VAT 100, Erlös 1000 (${mV})`);
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'FINAL' && n(db, 'SELECT COUNT(*) FROM customer_credits') === 0
    && konto(db, 'ACCOUNTS_RECEIVABLE') === 0 && konto(db, 'CASH') === 1100 && kontenOk(db) === '' && ausgeglichen(db),
    `§A bleibt voll bezahlt, keine Überzahlung, Kasse 1100, Forderung 0, abgestimmt ${kontenOk(db)}`);
  // Primary = PC2: derselbe Wechsel über den Fernauftrag
  const dbA = freshDb(); product(dbA, 'pT', 1, 600); reload();
  const a = rechnung('pT', 1000, '2026-10-20', 1, 'cust-1', 600); zahlung(a, 1100, '2026-10-21');
  await editInvoiceOnPrimary(a, { lines: [LINE('pT', 1100, 1, 'MARGIN', 600, { lineId: zeile(dbA, a) })] as never, reason: 'P1c' } as never, rev(dbA, a));
  const sigA = sig(dbA, a);
  const dbB = freshDb(); product(dbB, 'pT', 1, 600); reload();
  const b = rechnung('pT', 1000, '2026-10-20', 1, 'cust-1', 600); zahlung(b, 1100, '2026-10-21');
  const r = await runInvoiceUpdate(deps(dbB) as never, ident('invoices.update') as never, {
    id: b, expectedRevision: rev(dbB, b), reason: 'P1c', customerId: 'cust-1',
    lines: [{ lineId: zeile(dbB, b), productId: 'pT', lotId: 'lot-pT', quantity: 1, unitPrice: unitNetKeepingGross(1100, 1, 'MARGIN', 10), scheme: 'MARGIN' }],
  });
  reload();
  ok(r.kind === 'ok' && sigA === sig(dbB, b) && n(dbB, 'SELECT gross_amount FROM invoices WHERE id = ?', [b]) === 1100,
    `§A Primary und PC2: dasselbe Hauptbuch, Brutto 1100 (${r.kind})`);
  // P1c-Final B — direkte Aufrufe ohne die Maske: was die Preisangabe bedeutet, entscheidet das Haus.
  const bruttoVon = (d: Db, i: string): number => n(d, 'SELECT gross_amount FROM invoices WHERE id = ?', [i]);
  const neu = (net: number, cost = 600): { d: Db; i: string } => { const d = freshDb(); product(d, 'pT', 1, cost); reload(); const i = rechnung('pT', net, '2026-10-20', 1, 'cust-1', cost); return { d, i }; };
  // B1 reiner Steuerartwechsel (Netto unverändert mitgeschickt, ältere Gegenstelle / direkter Aufruf) → Brutto bleibt
  { const { d, i } = neu(1000);
    const m = edit(i, { lines: [LINE('pT', 1000, 1, 'MARGIN', 600, { lineId: zeile(d, i) })] });
    ok(m === '' && bruttoVon(d, i) === 1100 && n(d, 'SELECT unit_price FROM invoice_lines WHERE invoice_id = ?', [i]) === 1100 && n(d, 'SELECT vat_amount FROM invoices WHERE id = ?', [i]) === 45.455,
      `§A direkter Aufruf (Primary-Haus): nur die Steuerart VAT 10 % → Margin, Netto unverändert → Brutto bleibt 1100 (${m} ${bruttoVon(d, i)})`); }
  { const { d, i } = neu(1000);
    const r2 = await runInvoiceUpdate(deps(d) as never, ident('invoices.update') as never, { id: i, expectedRevision: rev(d, i), reason: 'P1c', customerId: 'cust-1',
      lines: [{ lineId: zeile(d, i), productId: 'pT', lotId: 'lot-pT', quantity: 1, unitPrice: 1000, scheme: 'ZERO' }] });
    reload();
    ok(r2.kind === 'ok' && bruttoVon(d, i) === 1100 && n(d, 'SELECT vat_amount FROM invoices WHERE id = ?', [i]) === 0,
      `§A direkter PC2-Auftrag ohne Bruttoangabe: nur die Steuerart VAT 10 % → Zero-rated → Brutto bleibt 1100 (${r2.kind} ${bruttoVon(d, i)})`); }
  // B2 Steuerart UND ausdrücklicher Preis: das gesendete Brutto ist verbindlich — auch wenn sein Netto zufällig dem alten gleicht
  { const { d, i } = neu(1000);
    edit(i, { lines: [LINE('pT', 1100, 1, 'MARGIN', 600, { lineId: zeile(d, i) })] });   // jetzt Margin 1100
    const m = edit(i, { lines: [LINE('pT', 1100, 1, 'VAT_10', 600, { lineId: zeile(d, i), customerGross: 1210 })] });
    ok(m === '' && bruttoVon(d, i) === 1210 && n(d, 'SELECT unit_price FROM invoice_lines WHERE invoice_id = ?', [i]) === 1100,
      `§A Margin 1100 → VAT 10 % mit ausdrücklichem Kundenpreis 1210 („VAT obendrauf", Netto gleich dem alten) → 1210 gilt (${m} ${bruttoVon(d, i)})`); }
  { const { d, i } = neu(1000);
    const r3 = await runInvoiceUpdate(deps(d) as never, ident('invoices.update') as never, { id: i, expectedRevision: rev(d, i), reason: 'P1c', customerId: 'cust-1',
      lines: [{ lineId: zeile(d, i), productId: 'pT', lotId: 'lot-pT', quantity: 1, unitPrice: 0, customerGross: 1300, scheme: 'MARGIN' }] });
    reload();
    ok(r3.kind === 'ok' && bruttoVon(d, i) === 1300 && n(d, 'SELECT unit_price FROM invoice_lines WHERE invoice_id = ?', [i]) === 1300,
      `§A PC2 mit Steuerart und ausdrücklichem Kundenpreis 1300 → 1300 gilt, das Netto rechnet der Primary (${r3.kind} ${bruttoVon(d, i)})`); }
  // B3 Steuerart und anderes Netto ohne Bruttoangabe: das Netto ist der ausdrücklich geänderte Preis
  { const { d, i } = neu(1000);
    const m = edit(i, { lines: [LINE('pT', 1200, 1, 'MARGIN', 600, { lineId: zeile(d, i) })] });
    ok(m === '' && bruttoVon(d, i) === 1200, `§A direkter Aufruf mit Steuerart und neuem Preis (Netto 1200, Margin) → Brutto 1200 (${m} ${bruttoVon(d, i)})`); }
}

// ── §B Kundenüberzahlung: Guthaben ODER Rückzahlung ──────────────────────────────────────────
const ueberzahlt = (): { db: Db; inv: string; L: string } => {
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb(); product(db, 'pO', 1, 500); product(db, 'pZ', 1, 500); reload();
  const inv = rechnung('pO', 1000, '2026-10-27');
  zahlung(inv, 1100, '2026-10-28');
  return { db, inv, L: zeile(db, inv) };
};
{
  // B1 — ohne Wahl: nichts geändert
  const { db, inv, L } = ueberzahlt();
  const z = zustand(db, inv);
  const m = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })] });
  ok(m.startsWith(refund.OVERPAY_CHOICE_REQUIRED + '|') && zustand(db, inv) === z, `§B1 Preis 1100 → 990 ohne Wahl → abgewiesen, nichts geändert (${m.slice(0, 40)})`);
  // B2 — Guthaben
  const kasse = konto(db, 'CASH');
  const m2 = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'credit' });
  ok(m2 === '' && claimOf(db, inv) === S([[110, 0, 'OPEN']]) && useCustomerStore.getState().getAvailableCredit('cust-1') === 110,
    `§B2 Wahl Guthaben: 110 als einlösbares Guthaben (${m2} ${claimOf(db, inv)})`);
  ok(konto(db, 'CASH') === kasse && konto(db, 'CUSTOMER_CREDIT') === -110 && konto(db, 'ACCOUNTS_RECEIVABLE') === 0 && kontenOk(db) === '' && ausgeglichen(db),
    `§B2 kein Geldfluss, Kundenguthaben 110, Forderung 0, abgestimmt ${kontenOk(db)}`);
}
{
  // B3 — Rückzahlung: Anspruch ohne Geld, nicht einlösbar; spätere Auszahlung in Teilen
  const { db, inv, L } = ueberzahlt();
  const kasse = konto(db, 'CASH');
  const m = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund' });
  ok(m === '' && claimOf(db, inv) === S([[110, 0, refund.REFUND_DUE]]) && useCustomerStore.getState().getAvailableCredit('cust-1') === 0,
    `§B3 Wahl Rückzahlung: offener Anspruch 110, NICHT als Guthaben einlösbar (${m} ${claimOf(db, inv)})`);
  ok(konto(db, 'CASH') === kasse && konto(db, 'BANK') === 0 && konto(db, 'CUSTOMER_CREDIT') === -110 && konto(db, 'ACCOUNTS_RECEIVABLE') === 0
    && n(db, 'SELECT COUNT(*) FROM customer_credit_refunds') === 0 && kontenOk(db) === '' && ausgeglichen(db),
    `§B3 kein Kasse-/Bankabfluss vor der Auszahlung; Anspruch als Verbindlichkeit 110; abgestimmt ${kontenOk(db)}`);
  const invObj = useInvoiceStore.getState().invoices.find((i) => i.id === inv);
  ok(invObj?.editOverpay?.kind === 'refund' && invObj.editOverpay.open === 110 && invObj.editOverpay.payouts.length === 0,
    '§B3 die Rechnung zeigt (an beiden Rechnern derselbe Lader) „Refund owed 110"');
  // nicht einlösbar: eine zweite Rechnung desselben Kunden bekommt nichts davon
  const inv2 = rechnung('pZ', 500, '2026-11-01');
  const used = imHaus(() => useInvoiceStore.getState().applyCreditToInvoice(inv2, 110));
  reload();
  ok(used === 0 && claimOf(db, inv) === S([[110, 0, refund.REFUND_DUE]]), `§B3 Einlösen auf einer anderen Rechnung: 0 (der Anspruch bleibt Auszahlung) (${used})`);
  const offene = (loadPayablesFor as unknown as ((c: unknown) => unknown) | undefined);
  if (offene) {
    const rows = (offene({ branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-test' } as never) as unknown as { payables: Array<{ sourceTable: string; sourceId: string }> }).payables ?? [];
    ok(rows.some((r) => r.sourceTable === 'customer_credits'), '§B3 die offene Rückzahlung steht unter den Verbindlichkeiten (Refund Payables)');
  } else ok(src('src/stores/payablesStore.ts').includes("cc.status = 'REFUND_DUE'"), '§B3 Refund Payables führt den offenen Anspruch (Quelltext)');
  const credit = s(db, "SELECT id FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]);
  // Grenzen der Auszahlung (am Primary)
  const reload2 = (): void => reload();
  const mVor = await ameldung(() => refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 40, method: 'cash', paidDate: '2026-10-27' }, reload2));
  const mZuk = await ameldung(() => refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 40, method: 'cash', paidDate: '2026-11-06' }, reload2));
  const mWeg = await ameldung(() => refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 40, method: 'card', paidDate: '2026-11-04' }, reload2));
  const mZuv = await ameldung(() => refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 111, method: 'cash', paidDate: '2026-11-04' }, reload2));
  ok(mVor.startsWith(refund.REFUND_DATE_BEFORE_CLAIM + '|') && mZuk.startsWith(refund.REFUND_DATE_INVALID + '|') && mWeg.startsWith(refund.REFUND_METHOD_INVALID + '|')
    && mZuv.startsWith(refund.REFUND_EXCEEDS_OPEN + '|') && n(db, 'SELECT COUNT(*) FROM customer_credit_refunds') === 0 && konto(db, 'CASH') === kasse,
    `§B3 Auszahlung vor dem Anspruch / in der Zukunft / per Karte / mehr als offen → abgewiesen, nichts gebucht`);
  // Teil 40 bar am 04.11. (Primary)
  const r1 = await refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 40, method: 'cash', paidDate: '2026-11-04' }, reload2);
  ok(r1.openAmount === 70 && r1.status === refund.REFUND_DUE && konto(db, 'CASH') === kasse - 40
    && s(db, "SELECT substr(occurred_at,1,10) FROM ledger_entries WHERE source_module = 'CUSTOMER_CREDIT_REFUND' AND account = 'CASH'") === '2026-11-04'
    && kontenOk(db) === '' && ausgeglichen(db),
    `§B3 Teilauszahlung 40 bar am 04.11.: Kasse −40 an diesem Tag, offen 70, abgestimmt ${kontenOk(db)}`);
  // Rest 70 per Bank über PC2 (dieselbe Handlung „Erstattung auszahlen")
  const idR = ident('returns.record_refund_payment');
  const body = { invoiceId: inv, creditId: credit, amount: 70, method: 'bank' };
  const pc = await runRecordRefundPayment(deps(db) as never, idR as never, body);
  reload();
  ok(pc.kind === 'ok' && claimOf(db, inv) === S([[110, 110, refund.REFUNDED]]) && konto(db, 'BANK') === -70 && konto(db, 'CUSTOMER_CREDIT') === 0
    && kontenOk(db) === '' && ausgeglichen(db),
    `§B3 PC2 zahlt den Rest 70 per Bank aus: Anspruch REFUNDED, Kundenverbindlichkeit 0, abgestimmt (${pc.kind}) ${kontenOk(db)}`);
  const wdh = await runRecordRefundPayment(deps(db) as never, idR as never, body);
  const noch = await runRecordRefundPayment(deps(db) as never, ident('returns.record_refund_payment') as never, { ...body, amount: 10 });
  reload();
  ok((wdh as { kind: string; replayed?: boolean }).kind === 'ok' && n(db, 'SELECT COUNT(*) FROM customer_credit_refunds') === 2 && konto(db, 'BANK') === -70
    && noch.kind === 'rejected' && (noch as { code?: string }).code === refund.REFUND_CLAIM_SETTLED,
    `§B3 Wiederholung desselben Auftrags: keine zweite Auszahlung; neuer Auftrag nach voller Auszahlung → ${(noch as { code?: string }).code}`);
  // nach einer Auszahlung: Ändern und Kundenwechsel gesperrt
  const z = zustand(db, inv);
  const mE = edit(inv, { lines: [LINE('pO', 800, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund' });
  const mK = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], customerId: 'cust-2', confirmCustomerChange: true, overpayChoice: 'refund' });
  ok(/already been paid out/.test(mE) && /refund from this invoice was already paid out/.test(mK) && zustand(db, inv) === z,
    `§B3 nach der Auszahlung: Ändern und Kundenwechsel abgewiesen, nichts geändert (${mE.slice(0, 40)} / ${mK.slice(0, 50)})`);
  // P1c-Final A — eine reine Verwaltungsänderung (Notiz, Mitarbeiter) bleibt nach der Auszahlung möglich: sie bucht nichts,
  // berührt Anspruch und Auszahlungen nicht (Primary und PC2). Finanzielle Änderungen bleiben gesperrt (oben).
  insert(db, 'employees', { id: 'emp-1', branch_id: 'branch-main' });
  const le0 = n(db, 'SELECT COUNT(*) FROM ledger_entries'); const cl0 = claimOf(db, inv); const rf0 = n(db, 'SELECT COUNT(*) FROM customer_credit_refunds');
  const mA = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], notes: 'nach der Auszahlung', staffId: 'emp-1' });
  ok(mA === '' && s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv]) === 'nach der Auszahlung' && s(db, 'SELECT staff_id FROM invoices WHERE id = ?', [inv]) === 'emp-1'
    && n(db, 'SELECT COUNT(*) FROM ledger_entries') === le0 && claimOf(db, inv) === cl0 && n(db, 'SELECT COUNT(*) FROM customer_credit_refunds') === rf0,
    `§B3 nach der Auszahlung: Notiz und Mitarbeiter (Primary) gespeichert, keine Buchung, Anspruch und Auszahlungen unverändert (${mA.slice(0, 60)})`);
  const pcA = await runInvoiceUpdate(deps(db) as never, ident('invoices.update') as never, {
    id: inv, expectedRevision: rev(db, inv), reason: 'Notiz', customerId: 'cust-1', notes: 'PC2 Notiz', staffId: 'emp-1',
    lines: [{ lineId: L, productId: 'pO', lotId: 'lot-pO', quantity: 1, unitPrice: 900 }],
  });
  reload();
  ok(pcA.kind === 'ok' && s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv]) === 'PC2 Notiz' && n(db, 'SELECT COUNT(*) FROM ledger_entries') === le0
    && claimOf(db, inv) === cl0 && kontenOk(db) === '' && ausgeglichen(db),
    `§B3 nach der Auszahlung: dieselbe Verwaltungsänderung über PC2, keine Buchung, abgestimmt (${pcA.kind} ${(pcA as { code?: string }).code ?? ''})`);
}
{
  // B4 — „Paid out now" mit Weg und Tag
  const { db, inv, L } = ueberzahlt();
  const kasse = konto(db, 'CASH');
  const m = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund', refundNow: { method: 'cash', paidDate: '2026-11-05' } });
  ok(m === '' && claimOf(db, inv) === S([[110, 110, refund.REFUNDED]]) && konto(db, 'CASH') === kasse - 110 && konto(db, 'CUSTOMER_CREDIT') === 0
    && n(db, "SELECT COUNT(*) FROM customer_credit_refunds WHERE substr(paid_at,1,10) = '2026-11-05' AND method = 'cash' AND amount = 110") === 1
    && kontenOk(db) === '' && ausgeglichen(db),
    `§B4 sofort ausgezahlt (bar, 05.11.): Kasse −110 am bestätigten Tag, Anspruch erledigt (${m}) ${kontenOk(db)}`);
  const snap = JSON.parse(s(db, 'SELECT new_snapshot FROM invoice_edits WHERE invoice_id = ? ORDER BY revision DESC LIMIT 1', [inv]));
  ok(snap.overpayment?.mode === 'refund' && snap.overpayment?.amount === 110 && snap.overpayment?.paidOutNow?.method === 'cash',
    '§B4 das Protokoll hält Wahl, Betrag und sofortige Auszahlung fest');
}
{
  // B5 — Rollback: eine scheiternde Sofort-Auszahlung nimmt den ganzen Edit zurück; Auszahlung ohne Rückzahlung
  const { db, inv, L } = ueberzahlt();
  const z = zustand(db, inv);
  const m = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund', refundNow: { method: 'cash', paidDate: '2026-10-27' } });
  const m2 = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'credit', refundNow: { method: 'cash' } });
  const m3 = edit(inv, { lines: [LINE('pO', 1000, 1, 'VAT_10', 500, { lineId: L })], staffId: 'x', refundNow: { method: 'cash' } });
  ok(m.startsWith(refund.REFUND_DATE_BEFORE_CLAIM + '|') && m2.startsWith(refund.OVERPAY_CHOICE_REQUIRED + '|') && m3.startsWith(refund.REFUND_NOTHING_OWED + '|')
    && zustand(db, inv) === z,
    `§B5 Auszahlung vor dem Anspruch / bei Guthaben / ohne Überzahlung → abgewiesen, Rechnung, Hauptbuch, Anspruch unverändert`);
}
{
  // B6 — gleiche Überzahlung behält ihre Wahl; geänderte verlangt eine neue
  const { db, inv, L } = ueberzahlt();
  edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund' });
  const m = edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], issuedAt: '2026-10-26' });
  ok(m === '' && claimOf(db, inv) === S([[110, 0, refund.REFUND_DUE]]) && n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type = 'invoice_edit'") === 1,
    `§B6 erneuter Edit mit derselben Überzahlung (Datum 27.10. → 26.10.): bleibt Rückzahlungsanspruch, genau eine Zeile (${m})`);
  const z = zustand(db, inv);
  const m2 = edit(inv, { lines: [LINE('pO', 800, 1, 'VAT_10', 500, { lineId: L })] });
  ok(m2.startsWith(refund.OVERPAY_CHOICE_REQUIRED + '|') && zustand(db, inv) === z, `§B6 andere Überzahlung (220) ohne Wahl → abgewiesen, nichts geändert`);
  const m3 = edit(inv, { lines: [LINE('pO', 800, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'credit' });
  ok(m3 === '' && claimOf(db, inv) === S([[220, 0, 'OPEN']]) && n(db, "SELECT COUNT(*) FROM customer_credits WHERE source_type = 'invoice_edit'") === 1
    && konto(db, 'CUSTOMER_CREDIT') === -220 && kontenOk(db) === '' && ausgeglichen(db),
    `§B6 neue Wahl Guthaben: EINE Zeile 220 OPEN — nie Guthaben und Anspruch für denselben Betrag ${kontenOk(db)}`);
}
{
  // B7 — zugemachte Periode: keine Auszahlung in ein eingereichtes Quartal
  const { db, inv, L } = ueberzahlt();
  edit(inv, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: L })], overpayChoice: 'refund' });
  heute('2027-01-10T10:00:00.000Z');
  insert(db, 'vat_filings', { id: 'vf-2026-4', branch_id: 'branch-main', year: 2026, quarter: 4, filed_at: new RealDate(FIXED).toISOString() });
  const credit = s(db, "SELECT id FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv]);
  const mQ = await ameldung(() => refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 110, method: 'cash', paidDate: '2026-12-20' }, reload));
  ok(mQ.startsWith('VAT_PERIOD_FILED|') && n(db, 'SELECT COUNT(*) FROM customer_credit_refunds') === 0, `§B7 Auszahlung datiert ins eingereichte Q4 → abgewiesen (${mQ.slice(0, 30)})`);
  const r = await refund.recordInvoiceRefundOnPrimary({ creditId: credit, amount: 110, method: 'cash', paidDate: '2027-01-10' }, reload);
  ok(r.status === refund.REFUNDED && kontenOk(db) === '' && ausgeglichen(db), '§B7 Auszahlung im offenen Q1/2027 → gebucht, abgestimmt');
}
{
  // B8 — Primary = PC2 für den Edit mit Rückzahlung und Sofort-Auszahlung
  heute('2026-11-05T10:00:00.000Z');
  const dbA = freshDb(); product(dbA, 'pO', 1, 500); reload();
  const a = rechnung('pO', 1000, '2026-10-27'); zahlung(a, 1100, '2026-10-28');
  await editInvoiceOnPrimary(a, { lines: [LINE('pO', 900, 1, 'VAT_10', 500, { lineId: zeile(dbA, a) })] as never, reason: 'P1c',
    overpayChoice: 'refund', refundNow: { method: 'bank', paidDate: '2026-11-04' } } as never, rev(dbA, a));
  const ccA = konto(dbA, 'CUSTOMER_CREDIT'); const bankA = konto(dbA, 'BANK'); const sigA = sig(dbA, a); const clA = claimOf(dbA, a);
  const dbB = freshDb(); product(dbB, 'pO', 1, 500); reload();
  const b = rechnung('pO', 1000, '2026-10-27'); zahlung(b, 1100, '2026-10-28');
  const idB = ident('invoices.update');
  const bodyB = {
    id: b, expectedRevision: rev(dbB, b), reason: 'P1c', customerId: 'cust-1', overpayChoice: 'refund', refundNow: { method: 'bank', paidDate: '2026-11-04' },
    lines: [{ lineId: zeile(dbB, b), productId: 'pO', lotId: 'lot-pO', quantity: 1, unitPrice: 900 }],
  };
  const r = await runInvoiceUpdate(deps(dbB) as never, idB as never, bodyB);
  reload();
  const wdh = await runInvoiceUpdate(deps(dbB) as never, idB as never, bodyB);
  reload();
  ok(wdh.kind === 'ok' && n(dbB, 'SELECT COUNT(*) FROM customer_credit_refunds') === 1 && n(dbB, 'SELECT COUNT(*) FROM invoice_edits') === 1 && konto(dbB, 'BANK') === -110,
    `§B8 derselbe Auftrag (verlorene Antwort) noch einmal: keine zweite Korrektur, keine zweite Auszahlung (${wdh.kind})`);
  ok(r.kind === 'ok' && sigA === sig(dbB, b) && clA === claimOf(dbB, b) && ccA === konto(dbB, 'CUSTOMER_CREDIT') && bankA === konto(dbB, 'BANK') && bankA === -110,
    `§B8 Primary und PC2: dieselbe Rechnung, derselbe Anspruch, dieselbe Auszahlung (Bank −110) (${r.kind})`);
  const stale = await runInvoiceUpdate(deps(dbB) as never, ident('invoices.update') as never, {
    id: b, expectedRevision: rev(dbB, b) - 1, reason: 'P1c', customerId: 'cust-1', overpayChoice: 'credit',
    lines: [{ lineId: zeile(dbB, b), productId: 'pO', lotId: 'lot-pO', quantity: 1, unitPrice: 800 }],
  });
  ok(stale.kind === 'rejected' && (stale as { code?: string }).code === 'INVOICE_CHANGED', `§B8 veraltete Fassung am PC2 → INVOICE_CHANGED (${(stale as { code?: string }).code})`);
  const pay = (raw: unknown): string => { try { parseInvoiceUpdate(raw); return ''; } catch (e) { return (e as Error).message; } };
  const base = { id: b, expectedRevision: 3, reason: 'x', customerId: 'cust-1', lines: [{ productId: 'pO', unitPrice: 1 }] };
  ok(/overpayChoice/.test(pay({ ...base, overpayChoice: 'cash' })) && /refundNow\.method/.test(pay({ ...base, overpayChoice: 'refund', refundNow: { method: 'card' } }))
    && /unknown field in refundNow/.test(pay({ ...base, overpayChoice: 'refund', refundNow: { method: 'cash', amount: 5 } })),
    '§B8 Fernvertrag: unbekannte Wahl, Karte als Auszahlungsweg und fremde Felder werden abgewiesen');
}

// ── §C Teilretoure: nur der nicht retournierte Rest ist korrigierbar ───────────────────────────
function retoure(db: Db, inv: string, lid: string, pid: string, menge: number, brutto: number, vat: number): string {
  const rid = imHaus(() => {
    const rs = useSalesReturnStore.getState(); rs.loadReturns();
    const id = rs.createReturn({ invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'P1c',
      lines: [{ invoiceLineId: lid, productId: pid, quantity: menge, unitPrice: brutto, vatAmount: vat }] } as never).id;
    useSalesReturnStore.getState().loadReturns(); useSalesReturnStore.getState().approveReturn(id);
    return id;
  });
  reload(); return rid;
}
const teilretoure = (): { db: Db; inv: string; X: string; rid: string } => {
  heute('2026-11-05T10:00:00.000Z');
  const db = freshDb(); product(db, 'pR', 3, 100); product(db, 'pS', 1, 100); reload();
  const inv = rechnung('pR', 1000, '2026-10-20', 3);
  const X = zeile(db, inv);
  const rid = retoure(db, inv, X, 'pR', 1, 1100, 100);
  return { db, inv, X, rid };
};
const cogs = (db: Db): number => konto(db, 'COGS');
{
  const { db, inv, X, rid } = teilretoure();
  const vor = { lot: n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pR'"), qty: n(db, "SELECT quantity FROM products WHERE id = 'pR'"),
    srl: all(db, 'SELECT * FROM sales_return_lines ORDER BY id'), cn: all(db, 'SELECT id, total_amount, receivable_cancel_amount, status FROM credit_notes ORDER BY id'),
    cogs: cogs(db), rcogs: n(db, "SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND account = 'COGS'") };
  ok(vor.lot === 1 && vor.cogs === 200, `§C Aufbau: 3 verkauft, 1 retourniert (Los ${vor.lot}, Wareneinsatz ${vor.cogs})`);
  // die 2 übrigen zu 900 statt 1000 — Zeilenteilung
  const m = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X }), LINE('pR', 900, 2, 'VAT_10', 100, { splitOf: X })] });
  const zeilen = db.exec('SELECT id, quantity, unit_price, line_total, lot_id, purchase_price_snapshot, stock_taken FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv])[0]?.values ?? [];
  ok(m === '' && zeilen.length === 2 && zeilen[0][0] === X && Number(zeilen[0][1]) === 1 && Number(zeilen[0][2]) === 1000 && Number(zeilen[0][3]) === 1100
    && zeilen[0][4] === 'lot-pR' && Number(zeilen[0][5]) === 100,
    `§C die retournierte Zeile behält ID, 1 Stück, Preis 1000/1100, Los, Einstand (${m} ${S(zeilen[0])})`);
  ok(zeilen[1][0] !== X && Number(zeilen[1][1]) === 2 && Number(zeilen[1][2]) === 900 && Math.abs(Number(zeilen[1][3]) - 1980) < 0.0005
    && zeilen[1][4] === 'lot-pR' && Number(zeilen[1][5]) === 100 && Number(zeilen[1][6]) === 2,
    `§C die 2 übrigen als eigene Zeile zu 900 (1980 brutto), dasselbe Los und derselbe Einstand, Bestand mitgenommen (${S(zeilen[1])})`);
  ok(n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pR'") === vor.lot && n(db, "SELECT quantity FROM products WHERE id = 'pR'") === vor.qty
    && all(db, 'SELECT * FROM sales_return_lines ORDER BY id') === vor.srl && s(db, 'SELECT invoice_line_id FROM sales_return_lines WHERE return_id = ?', [rid]) === X
    && all(db, 'SELECT id, total_amount, receivable_cancel_amount, status FROM credit_notes ORDER BY id') === vor.cn,
    '§C Lager, Los, Retourenzeile (an der Ursprungszeile) und Gutschrift unverändert');
  ok(cogs(db) === vor.cogs && n(db, "SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND account = 'COGS'") === vor.rcogs
    && n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 3080 && n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) === 280
    && konto(db, 'ACCOUNTS_RECEIVABLE') === 1980 && kontenOk(db) === '' && ausgeglichen(db),
    `§C Wareneinsatz netto ${cogs(db)} unverändert; Rechnung 1100 + 1980 = 3080, VAT 280; Forderung 3080 − Gutschrift 1100 = 1980; abgestimmt ${kontenOk(db)}`);
}
{
  // ohne Änderung des Rests: keine Teilung, keine Buchung
  const { db, inv, X } = teilretoure();
  const le = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const m = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X }), LINE('pR', 1000, 2, 'VAT_10', 100, { splitOf: X })], notes: 'nur Notiz' });
  ok(m === '' && n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv]) === 1 && n(db, 'SELECT quantity FROM invoice_lines WHERE id = ?', [X]) === 3
    && n(db, 'SELECT COUNT(*) FROM ledger_entries') === le,
    `§C Rest unverändert (gleicher Preis, gleiche Steuer): eine Zeile mit 3 Stück, keine Hauptbuchzeile (${m})`);
  // Grenzen
  const z = zustand(db, inv);
  const mMehr = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X }), LINE('pR', 900, 3, 'VAT_10', 100, { splitOf: X })] });
  const mX = edit(inv, { lines: [LINE('pR', 1000, 2, 'VAT_10', 100, { lineId: X }), LINE('pR', 900, 1, 'VAT_10', 100, { splitOf: X })] });
  const mFremd = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X }), LINE('pS', 900, 2, 'VAT_10', 100, { splitOf: X })] });
  const mBeide = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X }), LINE('pR', 900, 2, 'VAT_10', 100, { splitOf: X, lineId: X })] });
  ok([mMehr, mX, mFremd, mBeide].every((x) => x.startsWith(EDIT_SPLIT_INVALID + '|')) && zustand(db, inv) === z,
    `§C mehr Stücke als übrig / Ursprungszeile ≠ retournierte Menge / anderer Artikel / Teilung mit Zeilen-ID → abgewiesen, nichts geändert`);
  // Teilzeile ohne Retoure
  const inv2 = rechnung('pS', 500, '2026-10-21');
  const L2 = zeile(db, inv2);
  const mOhne = edit(inv2, { lines: [LINE('pS', 500, 1, 'VAT_10', 100, { lineId: L2 }), LINE('pS', 400, 1, 'VAT_10', 100, { splitOf: L2 })] });
  ok(mOhne.startsWith(EDIT_SPLIT_INVALID + '|'), `§C Teilung einer Zeile ohne Teilretoure → abgewiesen (${mOhne.slice(0, 40)})`);
  // Rest von der Rechnung nehmen: die 2 Stücke gehen ins Lager, die retournierte bleibt
  const lot = n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pR'");
  const mWeg = edit(inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: X })] });
  ok(mWeg === '' && n(db, 'SELECT quantity FROM invoice_lines WHERE id = ?', [X]) === 1 && n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pR'") === lot + 2
    && s(db, 'SELECT invoice_line_id FROM sales_return_lines') === X && kontenOk(db) === '' && ausgeglichen(db),
    `§C die 2 nicht retournierten Stücke entfernt: zurück ins Los (+2), die Retoure bleibt an ihrer Zeile (${mWeg}) ${kontenOk(db)}`);
}
{
  // Primary = PC2 für die Zeilenteilung
  const A = teilretoure();
  await editInvoiceOnPrimary(A.inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: A.X }), LINE('pR', 900, 2, 'VAT_10', 100, { splitOf: A.X })] as never, reason: 'P1c' } as never, rev(A.db, A.inv));
  const formA = all(A.db, 'SELECT quantity, unit_price, line_total, lot_id, purchase_price_snapshot, stock_taken FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [A.inv]);
  const sigA = sig(A.db, A.inv).replace(new RegExp(A.inv, 'g'), '');
  const B = teilretoure();
  const r = await runInvoiceUpdate(deps(B.db) as never, ident('invoices.update') as never, {
    id: B.inv, expectedRevision: rev(B.db, B.inv), reason: 'P1c', customerId: 'cust-1',
    lines: [{ lineId: B.X, productId: 'pR', lotId: 'lot-pR', quantity: 1, unitPrice: 1000 }, { splitOf: B.X, productId: 'pR', quantity: 2, unitPrice: 900 }],
  });
  reload();
  ok(r.kind === 'ok' && formA === all(B.db, 'SELECT quantity, unit_price, line_total, lot_id, purchase_price_snapshot, stock_taken FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [B.inv])
    && sigA === sig(B.db, B.inv).replace(new RegExp(B.inv, 'g'), '') && kontenOk(B.db) === '',
    `§C Primary und PC2: dieselben Zeilen und dasselbe Hauptbuch (${r.kind})`);
  // zugemachte Periode: Teilung abgewiesen, nur Notiz geht
  heute('2027-01-10T10:00:00.000Z');
  insert(B.db, 'vat_filings', { id: 'vf-2026-4', branch_id: 'branch-main', year: 2026, quarter: 4, filed_at: new RealDate(FIXED).toISOString() });
  const C = { db: B.db, inv: B.inv };
  const lines = useInvoiceStore.getState().invoices.find((i) => i.id === C.inv)!.lines;
  const z = zustand(C.db, C.inv);
  const mQ = edit(C.inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: lines[0].id }), LINE('pR', 800, 2, 'VAT_10', 100, { lineId: lines[1].id })] });
  ok(mQ.startsWith('VAT_PERIOD_FILED|') && zustand(C.db, C.inv) === z, `§C eingereichtes Quartal: Preisänderung des Rests abgewiesen, nichts geändert (${mQ.slice(0, 30)})`);
  const mN = edit(C.inv, { lines: [LINE('pR', 1000, 1, 'VAT_10', 100, { lineId: lines[0].id }), LINE('pR', 900, 2, 'VAT_10', 100, { lineId: lines[1].id })], notes: 'Notiz' });
  ok(mN === '' && s(C.db, 'SELECT notes FROM invoices WHERE id = ?', [C.inv]) === 'Notiz', `§C eingereichtes Quartal: Notiz geht (${mN})`);
}

// ── §D Rechte, Fernvertrag, Maske ───────────────────────────────────────────────────────────────
{
  const p = OPERATION_PERMISSIONS as Record<string, { kind: string; permission?: string } | null>;
  ok(p['returns.record_refund_payment']?.kind === 'permissionOrAdmin' && p['returns.record_refund_payment']?.permission === 'payments.*'
    && p['invoices.update']?.kind === 'isAdmin',
    '§D Auszahlung: dieselben Rechte wie die Erstattung einer Rückgabe (payments.* oder Admin/Manager); Ändern: Admin/Manager');
  ok(ALLOWED_MUTATIONS.length === 127 && ALLOWED_MUTATIONS.includes('returns.record_refund_payment'),
    '§D kein neuer Fernauftrag — dieselbe Liste (auch in Rust), die Auszahlung nutzt „returns.record_refund_payment"');
  const m = src('src/pages/invoices/InvoiceCreate.tsx');
  ok(/unitPrice: unitNetFromGross\(c\.gross, l\.quantity, resolvedNext, rateNext\)/.test(m) && /unitNetKeepingGross\(gross, qty, scheme, vatRate\)/.test(m),
    '§D Maske: der Steuerartwechsel rechnet das Netto aus dem gehaltenen Brutto (dieselbe Regel wie der Test oben)');
  ok(/splitOf: l\.restOf/.test(m) && /data-invoice-overpay="refund"/.test(m) && /data-invoice-refund-now/.test(m) && /r\.code === OVERPAY_CHOICE_REQUIRED/.test(m),
    '§D Maske: Teilzeile, Pflichtwahl Guthaben/Rückzahlung, „Paid out now" — an Primary und PC2 derselbe Rumpf');
  ok(!/disabled=\{[^}]*buyVat|MARGIN — not allowed/.test(m), '§D Maske: keine Sperre von Margin wegen der Einkaufs-VAT (E10 neu)');
}

console.log(`\np1c-invoice-correction: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

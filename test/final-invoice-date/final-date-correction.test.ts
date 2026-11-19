// ════════════════════════════════════════════════════════════════════════════
// Owner 19.11.2026 — „Correct final invoice date" (nur ADMIN): abschließende Zahlung und festes Endrechnungsdatum
// gemeinsam berichtigen; Nummer bleibt; Stichtag, eingereichte Quartale, Nummernjahr geschützt; Primary == PC2.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen), echte Zahlungswege (Gerüst wie final-invoice-date).
// Run: node test/final-invoice-date/final-date-correction.test.ts
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
await import('../../src/core/automation/automation-handlers.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { invoiceFinalizationDate } = await import('../../src/core/tax/nbr-export.ts');
const { vatFingerprint } = await import('../../src/core/tax/vat-period-lock.ts');
const { invoiceDocumentDate } = await import('../../src/core/invoices/invoice-document-date.ts');
const { fullPaymentDate } = await import('../../src/core/invoices/finalization-date.ts');
const { buildInvoiceA5Data, invoiceDateText } = await import('../../src/core/pdf/invoice-a5.ts');
const { setOpeningCutoffForTest } = await import('../../src/core/ledger/correction-dates.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

function product(db: Db, id: string, qty: number): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
  [id, 'M ' + id, 'SKU-' + id, qty, NOW, NOW]);
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
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (let i = 1; i <= 12; i++) product(db, 'p' + i, 5);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}

// Eine Zeile 1000 + 10 % VAT = 1100 brutto.
const LINE = (productId: string, price = 1000) => ({
  productId, quantity: 1, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: price / 10, lineTotal: price * 1.1,
});
let lauf = 0;
function rechnung(issued: string, price = 1000): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('p' + (++lauf), price)] as never, 'FID', issued).id);
  reload();
  return id;
}
function zahle(inv: string, betrag: number, receivedAt?: string): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, 'cash', undefined, undefined, undefined, undefined, undefined,
    receivedAt ? { receivedAt } : undefined));
  reload();
  return id;
}
const kopf = (db: Db, inv: string) => {
  const r = db.exec('SELECT invoice_number, status, issued_at, final_issued_at, number_finalized_at FROM invoices WHERE id = ?', [inv])[0].values[0];
  return { nummer: String(r[0]), status: String(r[1]), issued: String(r[2]), final: r[3] === null ? null : String(r[3]), merker: r[4] === null ? null : String(r[4]) };
};
const zahlungen = (db: Db, inv: string) =>
  (db.exec('SELECT received_at, amount, method FROM payments WHERE invoice_id = ?', [inv])[0]?.values ?? [])
    .map((v) => ({ receivedAt: String(v[0]), amount: Number(v[1]), method: String(v[2]) }));
const storeInv = (inv: string) => useInvoiceStore.getState().getInvoice(inv)!;
const zaehler = (db: Db, doc: string): number => n(db, 'SELECT next_number FROM document_sequences WHERE doc_type = ?', [doc]);
const vergaben = (db: Db, inv: string): number =>
  n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'invoices' AND entity_id = ? AND field_name = 'invoice_number'", [inv]);
const payIds = (db: Db, inv: string): string[] =>
  (db.exec('SELECT id FROM payments WHERE invoice_id = ? ORDER BY created_at, id', [inv])[0]?.values ?? []).map((v) => String(v[0]));
const day = (iso: string | null): string => String(iso ?? '').slice(0, 10);

const { correctFinalInvoiceDateInHouse, checkFinalDateCorrection } = await import('../../src/core/invoices/final-date-correction.ts');
const { runFinalDateCorrection, parseFinalDateCorrection } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
const { OPERATION_PERMISSIONS } = await import('../../src/core/bridge/command-permissions.ts');

const db = freshDb();
db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-test','branch-main','ADMIN',?)", [NOW]);
db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-mgr','branch-main','MANAGER',?)", [NOW]);
db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-fake','branch-main','sales',?)", [NOW]);
setOpeningCutoffForTest('2025-01-01');

const HEUTE = new Date().toISOString();
const CTX = { branchId: 'branch-main', userId: 'user-test', now: HEUTE, role: 'ADMIN' };
const rev = (inv: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
const korrigiere = (inv: string, newDate: string, reason = 'payment date typed wrongly', ctx = CTX, expectedRevision?: number) =>
  imHaus(() => correctFinalInvoiceDateInHouse({ invoiceId: inv, newDate, reason, expectedRevision: expectedRevision ?? rev(inv) }, ctx));
const nein = (fn: () => unknown): string => { const m = meldung(fn); return m.split('|')[0]; };
/** Die lebenden Buchungen einer Quelle: Konto Richtung Betrag Tag. */
const lebend = (mod: string, id: string): string[] =>
  (db.exec(`SELECT e1.account, e1.direction, e1.amount, substr(e1.occurred_at, 1, 10) FROM ledger_entries e1
     WHERE e1.source_module = ? AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [mod, id])[0]?.values ?? [])
    .map((v) => `${v[0]} ${v[1]} ${Number(v[2])} ${v[3]}`);
const gegen = (mod: string, id: string): string[] =>
  (db.exec(`SELECT DISTINCT substr(e2.occurred_at, 1, 10) FROM ledger_entries e2 JOIN ledger_entries e1 ON e1.id = e2.reverses_entry_id
     WHERE e1.source_module = ? AND e1.source_id = ?`, [mod, id])[0]?.values ?? []).map((v) => String(v[0]));
const stand = (inv: string): string => JSON.stringify({ k: kopf(db, inv), z: zahlungen(db, inv), l: lebend('PAYMENT', payIds(db, inv)[0] ?? ''),
  e: n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]), r: rev(inv) });

// ── K1 Primary: die abschließende Zahlung 10.11. war falsch (richtig 08.11.) ─────────────────────────────────────────────
{
  const A = rechnung('2026-11-02');
  zahle(A, 1100, '2026-11-10T12:00:00.000Z');
  const vor = kopf(db, A);
  const pay = payIds(db, A)[0];
  ok(vor.status === 'FINAL' && day(vor.final) === '2026-11-10', `K1 Ausgang: FINAL, Endrechnungsdatum 10.11. (${vor.final})`);
  const r = korrigiere(A, '2026-11-08');
  reload();
  const nach = kopf(db, A);
  ok(r.paymentId === pay && r.oldDate === '2026-11-10' && r.newDate === '2026-11-08' && day(nach.final) === '2026-11-08'
    && day(zahlungen(db, A)[0].receivedAt) === '2026-11-08',
  `K1 Zahlung und Endrechnungsdatum gemeinsam auf 08.11. (${nach.final}, Zahlung ${zahlungen(db, A)[0].receivedAt})`);
  ok(nach.nummer === vor.nummer && vergaben(db, A) === 1, `K1 Nummer unverändert (${nach.nummer})`);
  ok(JSON.stringify(lebend('PAYMENT', pay)) === JSON.stringify(['ACCOUNTS_RECEIVABLE CREDIT 1100 2026-11-08', 'CASH DEBIT 1100 2026-11-08'])
    && JSON.stringify(gegen('PAYMENT', pay)) === JSON.stringify(['2026-11-10']),
  `K1 Hauptbuch: neu am 08.11., die alte Buchung am 10.11. zurückgenommen (${lebend('PAYMENT', pay).join(' / ')} · Gegen ${gegen('PAYMENT', pay)})`);
  const inv = storeInv(A);
  const dd = invoiceDocumentDate(inv, zahlungen(db, A));
  ok(day(dd.date) === '2026-11-08' && day(invoiceFinalizationDate(inv, zahlungen(db, A))) === '2026-11-08'
    && vatFingerprint(A)?.month === '2026-11',
  `K1 Liste/Detail/PDF (invoiceDocumentDate) und NBR (invoiceFinalizationDate) zeigen 08.11. (${dd.date})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ? AND reason = ?', [A, 'payment date typed wrongly']) === 1
    && /"kind":"FINAL_DATE"/.test(s(db, 'SELECT new_snapshot FROM invoice_edits WHERE invoice_id = ?', [A]))
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'final_issued_at' AND new_value LIKE '%payment date typed wrongly%'", [A]) === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'received_at'", [pay]) === 1,
  'K1 Protokoll: invoice_edits mit Grund, Audit für Endrechnungsdatum und Zahlung');
  ok(rev(A) > Number(vor.issued ? 0 : 0) && r.revision === rev(A), `K1 Fassung erhöht (${r.revision})`);
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE category = 'CardFees'") === 0, 'K1 keine Kartengebühr berührt (Barzahlung)');
}

// ── K2 Recht, Grund, Fassung ─────────────────────────────────────────────────────────────────────────────────────────
{
  const B = rechnung('2026-11-02');
  zahle(B, 1100, '2026-11-10T12:00:00.000Z');
  const vor = stand(B);
  ok(nein(() => korrigiere(B, '2026-11-08', 'x y z', { ...CTX, role: 'MANAGER', userId: 'user-mgr' })) === 'FINAL_DATE_PERMISSION_DENIED'
    && nein(() => korrigiere(B, '2026-11-08', 'x y z', { ...CTX, role: 'ADMIN', userId: 'user-fake' })) === 'FINAL_DATE_PERMISSION_DENIED'
    && nein(() => korrigiere(B, '2026-11-08', 'x y z', { ...CTX, role: undefined as never })) === 'FINAL_DATE_PERMISSION_DENIED',
  'K2 nur ADMIN (Sitzung UND user_branches): MANAGER, vorgetäuschte Rolle, ohne Rolle → Nein');
  ok(nein(() => korrigiere(B, '2026-11-08', '  ')) === 'FINAL_DATE_REASON_REQUIRED', 'K2 ohne Grund → Nein');
  ok(nein(() => korrigiere(B, '2026-11-08', 'typo', CTX, rev(B) - 1)) === 'INVOICE_CHANGED', 'K2 alte Fassung → Nein');
  ok(stand(B) === vor, 'K2 …nichts geschrieben');
}

// ── K3 Tag: Zukunft, vor dem Rechnungstag, gleich ────────────────────────────────────────────────────────────────────
{
  const C = rechnung('2026-11-02');
  zahle(C, 1100, '2026-11-10T12:00:00.000Z');
  const vor = stand(C);
  const morgen2 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  ok(nein(() => korrigiere(C, morgen2)) === 'FINAL_DATE_INVALID', `K3 künftiger Tag (${morgen2}) → Nein`);
  ok(nein(() => korrigiere(C, '2026-11-01')) === 'FINAL_DATE_BEFORE_INVOICE', 'K3 vor dem Rechnungstag → Nein');
  ok(nein(() => korrigiere(C, '2026-11-10')) === 'FINAL_DATE_UNCHANGED', 'K3 derselbe Tag → Nein');
  ok(stand(C) === vor, 'K3 …nichts geschrieben');
}

// ── K4 Abschließende Zahlung nicht eindeutig / andere Zahlung danach / Teilrechnung ──────────────────────────────────
{
  const D = rechnung('2026-11-02');
  zahle(D, 500, '2026-11-03T12:00:00.000Z');
  zahle(D, 600, '2026-11-10T12:00:00.000Z');
  const vor = stand(D);
  ok(nein(() => korrigiere(D, '2026-11-02')) === 'FINAL_DATE_LATER_PAYMENT', 'K4 neuer Tag vor einer anderen nötigen Zahlung (03.11.) → Nein');
  ok(stand(D) === vor, 'K4 …nichts geschrieben');
  const r = korrigiere(D, '2026-11-05');
  ok(day(kopf(db, D).final) === '2026-11-05' && zahlungen(db, D).map((z) => day(z.receivedAt)).sort().join(',') === '2026-11-03,2026-11-05',
    `K4 Teilzahlungen: nur die abschließende (600) wandert, die erste bleibt (${r.paymentId?.slice(0, 8)})`);
  const E = rechnung('2026-11-02');
  zahle(E, 500, '2026-11-10T09:00:00.000Z');
  zahle(E, 600, '2026-11-10T15:00:00.000Z');
  ok(nein(() => korrigiere(E, '2026-11-08')) === 'FINAL_DATE_PAYMENT_UNCLEAR', 'K4 zwei Zahlungen am Endrechnungstag → Nein (nicht eindeutig)');
  const P = rechnung('2026-11-02');
  zahle(P, 500, '2026-11-04T12:00:00.000Z');
  ok(nein(() => korrigiere(P, '2026-11-03')) === 'FINAL_DATE_NOT_FINAL', 'K4 Teilrechnung (PARTIAL) → Nein');
}

// ── K5 Buchungsstichtag und eingereichtes Quartal ────────────────────────────────────────────────────────────────────
{
  const F = rechnung('2026-11-02');
  zahle(F, 1100, '2026-11-10T12:00:00.000Z');
  const vor = stand(F);
  setOpeningCutoffForTest('2026-11-06');
  ok(nein(() => korrigiere(F, '2026-11-04')) === 'FINAL_DATE_BEFORE_OPENING', 'K5 neuer Tag vor dem Buchungsstichtag → Nein');
  setOpeningCutoffForTest('2026-11-12');
  ok(nein(() => korrigiere(F, '2026-11-12')) === 'FINAL_DATE_BEFORE_OPENING', 'K5 alter Tag vor dem Buchungsstichtag → Nein');
  setOpeningCutoffForTest('2025-01-01');
  ok(stand(F) === vor, 'K5 …nichts geschrieben');

  const G = rechnung('2026-09-20');
  zahle(G, 1100, '2026-10-02T12:00:00.000Z');          // Q4 — richtig wäre der 28.09. (Q3)
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, invoice_count, snapshot_json, created_at)
          VALUES ('vf-q3','branch-main',2026,3,'2026-10-15T00:00:00.000Z',1,'[]','2026-10-15T00:00:00.000Z')`);
  const vorG = stand(G);
  ok(nein(() => korrigiere(G, '2026-09-28')) === 'VAT_PERIOD_FILED', 'K5 neuer Tag im eingereichten Q3 → Nein');
  ok(stand(G) === vorG, 'K5 …nichts geschrieben');
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, invoice_count, snapshot_json, created_at)
          VALUES ('vf-q4','branch-main',2026,4,'2027-01-15T00:00:00.000Z',1,'[]','2027-01-15T00:00:00.000Z')`);
  ok(nein(() => korrigiere(F, '2026-11-08')) === 'VAT_PERIOD_FILED', 'K5 alter und neuer Tag im eingereichten Q4 → Nein');
  db.run("DELETE FROM vat_filings WHERE id IN ('vf-q3','vf-q4')");
}

// ── K6 Jahreswechsel: die Endnummer trägt ihr Jahr, die Nummer wird nie geändert ────────────────────────────────────
{
  const jahr = new Date().getFullYear();
  const H = rechnung(`${jahr - 1}-12-20`);
  zahle(H, 1100, `${jahr - 1}-12-28T12:00:00.000Z`);   // Endnummer heute vergeben → trägt das Jahr ${jahr}
  const nr = kopf(db, H).nummer;
  ok(new RegExp(`-${jahr}-\\d+$`).test(nr), `K6 Endnummer trägt das Vergabejahr (${nr})`);
  ok(nein(() => korrigiere(H, `${jahr - 1}-12-27`)) === 'FINAL_DATE_NUMBER_YEAR', 'K6 neuer Tag im Vorjahr der Nummer → Nein');
  const r = korrigiere(H, `${jahr}-01-02`);
  ok(day(kopf(db, H).final) === `${jahr}-01-02` && kopf(db, H).nummer === nr && r.oldDate === `${jahr - 1}-12-28`,
    `K6 über den Jahreswechsel ins Jahr der Nummer: erlaubt, Nummer bleibt (${nr}, ${kopf(db, H).final})`);
}

// ── K7 Zahlung schon über „Manage payments" umdatiert → nur das Datum zieht nach ─────────────────────────────────────
{
  const J = rechnung('2026-11-02');
  zahle(J, 1100, '2026-11-10T12:00:00.000Z');
  const pay = payIds(db, J)[0];
  imHaus(() => useInvoiceStore.getState().updatePayment(pay, J, { receivedAt: '2026-11-07T00:00:00.000Z' }));
  reload();
  ok(day(kopf(db, J).final) === '2026-11-10', 'K7 Ausgang: Zahlung 07.11., Endrechnungsdatum bleibt 10.11.');
  ok(nein(() => korrigiere(J, '2026-11-06')) === 'FINAL_DATE_PAYMENT_UNCLEAR', 'K7 anderer Tag als die abschließende Zahlung → Nein');
  const buch = JSON.stringify(lebend('PAYMENT', pay));
  const r = korrigiere(J, '2026-11-07');
  ok(r.paymentId === null && day(kopf(db, J).final) === '2026-11-07' && JSON.stringify(lebend('PAYMENT', pay)) === buch,
    'K7 nur das Endrechnungsdatum zieht auf die Zahlung (07.11.), Hauptbuch unverändert');
}

// ── K8 PC2: derselbe Weg, geprüft und gespeichert am Primary ────────────────────────────────────────────────────────
{
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000fd`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
  const ident = (x: string, actor = ACTOR) => ({ commandId: ID(x), ...actor, op: 'invoices.correct_final_date', payloadHash: 'h' + x });
  let saves = 0;
  const deps = { db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { saves += 1; }, now: () => HEUTE };
  const K = rechnung('2026-11-02');
  zahle(K, 1100, '2026-11-10T12:00:00.000Z');
  const pay = payIds(db, K)[0];
  const body = { invoiceId: K, newDate: '2026-11-08', reason: 'typed 10 instead of 08', expectedRevision: rev(K) };
  const a = await runFinalDateCorrection(deps as never, ident('1') as never, body);
  reload();
  ok(a.kind === 'ok' && day(kopf(db, K).final) === '2026-11-08' && day(zahlungen(db, K)[0].receivedAt) === '2026-11-08'
    && JSON.stringify(lebend('PAYMENT', pay)) === JSON.stringify(['ACCOUNTS_RECEIVABLE CREDIT 1100 2026-11-08', 'CASH DEBIT 1100 2026-11-08'])
    && saves === 1,
  `K8 PC2 → Primary: dieselbe Wirkung wie K1 (${a.kind}, ${kopf(db, K).final})`);
  const b = await runFinalDateCorrection(deps as never, ident('1') as never, body);
  ok(b.kind === 'ok' && (b as { replayed?: boolean }).replayed === true && n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [K]) === 1
    && gegen('PAYMENT', pay).length === 1,
  'K8 Wiederholung derselben Kennung: dieselbe Antwort, nichts doppelt');
  const L = rechnung('2026-11-02');
  zahle(L, 1100, '2026-11-10T12:00:00.000Z');
  const vorL = stand(L);
  const c = await runFinalDateCorrection(deps as never, ident('2', { ...ACTOR, userId: 'user-mgr', role: 'MANAGER' }) as never,
    { invoiceId: L, newDate: '2026-11-08', reason: 'typo typo', expectedRevision: rev(L) });
  ok(c.kind === 'rejected' && (c as { code?: string }).code === 'FINAL_DATE_PERMISSION_DENIED' && stand(L) === vorL,
    `K8 PC2 als MANAGER: Nein am Primary, nichts geschrieben (${(c as { code?: string }).code})`);
  let roh = '';
  try { parseFinalDateCorrection({ ...body, paymentId: 'x' }); } catch (e) { roh = String((e as { code?: string }).code ?? ''); }
  ok(roh === 'INVOICE_PAYLOAD_INVALID', 'K8 enger Rumpf: ein fremdes Feld (paymentId) wird abgewiesen');
  ok(ALLOWED_MUTATIONS.includes('invoices.correct_final_date')
    && (OPERATION_PERMISSIONS as Record<string, { kind?: string } | null>)['invoices.correct_final_date']?.kind === 'isOwner',
  'K8 freigegeben und nur für ADMIN (isOwner) eingetragen');
  const rust = src('src-tauri/src/bridge.rs');
  ok(/OP_INVOICES_CORRECT_FINAL_DATE: &str = "invoices\.correct_final_date"/.test(rust) && /\n\s+OP_INVOICES_CORRECT_FINAL_DATE,\n\];/.test(rust),
    'K8 Rust-Brücke lässt den Befehl durch (REMOTE_OPS)');
}

// ── K9 Maske: ADMIN-Knopf, Weiche Primary/PC2 ───────────────────────────────────────────────────────────────────────
{
  const detail = src('src/pages/invoices/InvoiceDetail.tsx');
  ok(/perm\.isOwner && invoice\.status === 'FINAL' && !!invoice\.numberFinalizedAt/.test(detail)
    && /w\.ok\('invoices\.correct_final_date', \{\s*local: \(\) => correctFinalInvoiceDateOnPrimary\(eingabe/.test(detail)
    && /remote: \(\) => eingabe/.test(detail),
  'K9 Detailseite: Knopf nur für ADMIN bei Endrechnung; Primary = Hausfolge, PC2 = derselbe Auftrag');
  const chk = checkFinalDateCorrection({ invoiceId: 'nope', newDate: '2026-11-08', reason: 'abc' }, CTX);
  ok(chk?.code === 'INVOICE_NOT_FOUND', 'K9 Vorprüfung ohne Schreiben');
}

console.log(fails.length ? `\nFAIL — final-date-correction: ${PASS} passed, ${fails.length} failed` : `\nPASS — final-date-correction: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);

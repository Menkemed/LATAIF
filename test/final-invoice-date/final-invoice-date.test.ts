// ════════════════════════════════════════════════════════════════════════════
// FINAL-INVOICE-DATE — die Endrechnung trägt den Tag ihrer ERSTEN Vollzahlung (received_at), einmal
// festgehalten; Liste, Detailseite, PDF, NBR-Export und VAT-Sperre zeigen denselben Tag.
// Echte sql.js-Datenbank (schema.sql + echte Migrationen), echte Zahlungswege (Harness wie number-freeze).
// Run: node test/final-invoice-date/final-invoice-date.test.ts
//
//   F1 vorläufige Rechnung          F2 Teilzahlung → Vollzahlung      F3 rückdatierte Zahlung
//   F4 nachträgliche Korrektur      F5 Preisreduzierung               F6 VAT-Periodensperre
//   F7 gleiche Anzeige Liste / Detail / PDF / NBR (auch Altbestand)
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

const db = freshDb();

// ── F0 — Spalte, Sync-Vertrag ───────────────────────────────────────────────────────────────
ok(n(db, "SELECT COUNT(*) FROM pragma_table_info('invoices') WHERE name = 'final_issued_at'") === 1, 'F0 Migration legt invoices.final_issued_at an');
ok((JSON.parse(src('src/core/sync/sync-business-schema.json')).tables?.invoices?.allowed_fields
  ?? JSON.parse(src('src/core/sync/sync-business-schema.json')).invoices?.allowed_fields ?? []).includes('final_issued_at')
  || /"invoices": \{[\s\S]*?"final_issued_at"[\s\S]*?"required_fields"/.test(src('src/core/sync/sync-business-schema.json')),
'F0 Sync-Vertrag kennt final_issued_at (Primary ↔ PC2)');

// ── F1 — vorläufige Rechnung ────────────────────────────────────────────────────────────────
const A = rechnung('2026-11-02');
{
  const k = kopf(db, A);
  const d = invoiceDocumentDate(storeInv(A), zahlungen(db, A));
  ok(/^PINV-/.test(k.nummer) && k.final === null && day(k.issued) === '2026-11-02' && d.kind === 'issued' && day(d.date) === '2026-11-02',
    `F1 vorläufig: PINV, kein Endrechnungsdatum, Anzeige = Rechnungstag (${k.nummer}/${k.final}/${d.date})`);
  zahle(A, 500, '2026-11-03T10:00:00.000Z');
  const k2 = kopf(db, A); const d2 = invoiceDocumentDate(storeInv(A), zahlungen(db, A));
  ok(k2.status === 'PARTIAL' && /^PINV-/.test(k2.nummer) && k2.final === null && day(d2.date) === '2026-11-02',
    `F1 Teilzahlung: bleibt vorläufig mit ihrem Datum (${k2.status}/${k2.nummer}/${d2.date})`);
}

// ── F2 — Teilzahlung, dann Vollzahlung (Beispiel des Owners) ────────────────────────────────
{
  const vorher = zaehler(db, 'INV');
  zahle(A, 600, '2026-11-05T09:00:00.000Z');          // Rest am 05.11. bezahlt, heute erfasst
  const k = kopf(db, A);
  ok(k.status === 'FINAL' && /^INV-/.test(k.nummer) && k.final === '2026-11-05T09:00:00.000Z',
    `F2 Vollzahlung: Endnummer + Endrechnungsdatum = Tag der Restzahlung (${k.nummer}/${k.final})`);
  ok(day(k.issued) === '2026-11-02', `F2 …das Datum der vorläufigen Rechnung bleibt gespeichert (${k.issued})`);
  ok(day(k.merker) !== '2026-11-05', `F2 …Endrechnungsdatum ist das Zahlungsdatum, nicht der Erfassungszeitpunkt (${k.merker})`);
  ok(zaehler(db, 'INV') === vorher + 1 && vergaben(db, A) === 1, 'F2 …genau eine Endnummer gezogen');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'final_issued_at' AND new_value = ?", [A, k.final]) === 1,
    'F2 …im Änderungsprotokoll festgehalten');
  ok(invoiceFinalizationDate(storeInv(A), zahlungen(db, A)) === k.final && vatFingerprint(A)?.row.finalizedAt === k.final && vatFingerprint(A)?.month === '2026-11',
    'F2 …NBR-Export und VAT-Sperre datieren gleich');
}

// ── F3 — rückdatierte Zahlung ───────────────────────────────────────────────────────────────
{
  const B = rechnung('2026-11-02');
  zahle(B, 1100, '2026-11-04T00:00:00.000Z');          // heute erfasst, am 04.11. erhalten
  ok(kopf(db, B).final === '2026-11-04T00:00:00.000Z', `F3 rückdatiert: Endrechnungsdatum = received_at 04.11. (${kopf(db, B).final})`);
  // Restzahlung, die VOR der Teilzahlung erhalten wurde: voll war die Rechnung erst mit der späteren.
  const C = rechnung('2026-11-02');
  zahle(C, 500, '2026-11-06T00:00:00.000Z');
  zahle(C, 600, '2026-11-04T00:00:00.000Z');
  ok(kopf(db, C).final === '2026-11-06T00:00:00.000Z', `F3 rückdatiert vor die Teilzahlung: voll erst am 06.11. (${kopf(db, C).final})`);
}

// ── F4 — nachträgliche Korrekturen ändern das Datum nicht still ─────────────────────────────
{
  const fest = kopf(db, A).final;
  const nummer = kopf(db, A).nummer;
  const zaehlerVorher = zaehler(db, 'INV');
  const rest = payIds(db, A)[1];
  useInvoiceStore.getState().updatePayment(rest, A, { receivedAt: '2026-11-10T09:00:00.000Z' }); reload();
  ok(kopf(db, A).final === fest && kopf(db, A).nummer === nummer, `F4 Zahlungsdatum geändert: Endrechnungsdatum bleibt ${day(fest)} (${kopf(db, A).final})`);
  ok(invoiceFinalizationDate(storeInv(A), zahlungen(db, A)) === fest && fullPaymentDate(storeInv(A), zahlungen(db, A)) !== fest,
    'F4 …NBR bleibt beim festgehaltenen Tag (die bloße Berechnung aus den Zahlungen wäre gewandert)');
  useInvoiceStore.getState().deletePayment(rest, A); reload();
  ok(kopf(db, A).status === 'PARTIAL' && kopf(db, A).nummer === nummer && kopf(db, A).final === fest,
    `F4 Zahlung gelöscht: PARTIAL, Endnummer und Endrechnungsdatum bleiben (${kopf(db, A).status}/${kopf(db, A).final})`);
  ok(invoiceDocumentDate(storeInv(A), zahlungen(db, A)).date === fest, 'F4 …die zurückgefallene Endrechnung zeigt weiter ihr Datum');
  zahle(A, 600, '2026-11-12T09:00:00.000Z');
  ok(kopf(db, A).status === 'FINAL' && kopf(db, A).nummer === nummer && kopf(db, A).final === fest
    && zaehler(db, 'INV') === zaehlerVorher && vergaben(db, A) === 1,
  `F4 erneut voll bezahlt: dieselbe Nummer, kein zweites Datum, keine zweite Nummer (${kopf(db, A).final})`);
  zahle(A, 50, '2026-11-14T09:00:00.000Z');               // Überzahlung nach der Endrechnung → Kundenguthaben
  ok(kopf(db, A).status === 'FINAL' && kopf(db, A).final === fest && invoiceFinalizationDate(storeInv(A), zahlungen(db, A)) === fest,
    `F4 Überzahlung danach: Endrechnungsdatum und NBR-Datum bleiben ${day(fest)} (${kopf(db, A).final})`);
}

// ── F5 — Vollzahlung durch Preisreduzierung ─────────────────────────────────────────────────
{
  const D = rechnung('2026-11-02');
  zahle(D, 1000, '2026-11-03T10:00:00.000Z');
  imHaus(() => useInvoiceStore.getState().editInvoice(D, {
    lines: [LINE('p' + lauf, 900)] as never, reason: 'FID Reduzierung', overpayChoice: 'credit',
  } as never));
  reload();
  const k = kopf(db, D);
  ok(k.status === 'FINAL' && /^INV-/.test(k.nummer) && k.final === '2026-11-03T10:00:00.000Z',
    `F5 Preisreduzierung macht voll: Endnummer, Datum = späteste Zahlung wie im NBR (${k.nummer}/${k.final})`);
  ok(vergaben(db, D) === 1, 'F5 …genau eine Endnummer');
}

// ── F6 — VAT-Periodensperre ─────────────────────────────────────────────────────────────────
{
  const E = rechnung('2026-09-01');                     // Q3
  zahle(E, 1100, '2026-09-10T10:00:00.000Z');
  const fest = kopf(db, E).final;
  ok(fest === '2026-09-10T10:00:00.000Z', `F6 Endrechnung im Q3: ${fest}`);
  const G = rechnung('2026-09-01');
  zahle(G, 1100, '2026-09-12T10:00:00.000Z');
  useInvoiceStore.getState().deletePayment(payIds(db, E)[0], E); reload();   // fällt zurück, solange Q3 offen ist
  ok(kopf(db, E).status === 'PARTIAL' && kopf(db, E).final === fest, 'F6 …zurückgefallen, Datum bleibt Q3');
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, invoice_count, snapshot_json, created_at)
          VALUES ('vf-q3','branch-main',2026,3,'2026-10-15T00:00:00.000Z',1,'[]','2026-10-15T00:00:00.000Z')`);
  const zahlungenVorher = payIds(db, E).length;
  const m = meldung(() => zahle(E, 1100));                // heute bezahlt — die Endrechnung stünde aber im Q3
  ok(m.startsWith('VAT_PERIOD_FILED|') && payIds(db, E).length === zahlungenVorher && kopf(db, E).status === 'PARTIAL',
    `F6 Restzahlung heute auf eine Endrechnung mit Datum im eingereichten Q3: abgelehnt, nichts geschrieben (${m.slice(0, 60)})`);
  const m2 = meldung(() => { useInvoiceStore.getState().updatePayment(payIds(db, G)[0], G, { receivedAt: new Date().toISOString() }); });
  ok(m2.startsWith('VAT_PERIOD_FILED|') && kopf(db, G).final === '2026-09-12T10:00:00.000Z',
    `F6 Zahlung einer gemeldeten Endrechnung umdatieren: abgelehnt, Datum bleibt (${m2.slice(0, 40)})`);
  const H = rechnung('2026-11-02');
  const m3 = meldung(() => zahle(H, 1100, '2026-09-20T10:00:00.000Z'));
  ok(m3.startsWith('VAT_PERIOD_FILED|') && kopf(db, H).final === null, 'F6 Vollzahlung rückdatiert ins eingereichte Q3: abgelehnt');
}

// ── F7 — dieselbe Anzeige in Liste, Detailseite, PDF und NBR ────────────────────────────────
{
  const inv = storeInv(A);
  const pays = zahlungen(db, A);
  const d = invoiceDocumentDate(inv, pays);
  ok(d.kind === 'final' && d.fixed && d.date === kopf(db, A).final && d.differs && day(d.issued) === '2026-11-02',
    `F7 Endrechnung: Datum = festgehaltenes, Datum der vorläufigen daneben (${d.date} / ${d.issued})`);
  const pdf = buildInvoiceA5Data({
    company: { nameEn: 'X', nameAr: 'X', crNumber: '', vatNumber: '', address: '', phone: '', email: '', instagram: '', terms: '' },
    invoice: { number: inv.invoiceNumber, status: inv.status, issuedAt: d.date, createdAt: inv.createdAt, grossAmount: inv.grossAmount, paidAmount: inv.paidAmount, lines: [] },
    customer: null, products: [], paymentMethods: [],
  } as never);
  ok(pdf.invoice.find((r: [string, string]) => r[0] === 'Date')?.[1] === invoiceDateText(kopf(db, A).final),
    `F7 PDF druckt das Endrechnungsdatum (${pdf.invoice.find((r: [string, string]) => r[0] === 'Date')?.[1]})`);
  ok(invoiceFinalizationDate(inv, pays) === d.date, 'F7 NBR-Export = Anzeige');

  // Altbestand: Endrechnung von vor dem Vertrag (kein festgehaltenes Datum) — Anzeige wie NBR, DB unverändert.
  const alt = rechnung('2026-11-01');
  zahle(alt, 1100, '2026-11-07T08:00:00.000Z');
  db.run('UPDATE invoices SET final_issued_at = NULL WHERE id = ?', [alt]); reload();
  const da = invoiceDocumentDate(storeInv(alt), zahlungen(db, alt));
  ok(da.kind === 'final' && !da.fixed && da.date === '2026-11-07T08:00:00.000Z' && da.date === invoiceFinalizationDate(storeInv(alt), zahlungen(db, alt))
    && kopf(db, alt).final === null,
  `F7 Altbestand: Anzeige = NBR-Berechnung (07.11.), Datenbank bleibt leer (${da.date})`);

  const list = src('src/pages/invoices/InvoiceList.tsx');
  const detail = src('src/pages/invoices/InvoiceDetail.tsx');
  ok(/invoiceDocumentDate\(inv, nbrPaymentsByInvoice\.get\(inv\.id\)\)/.test(list)
    && /date: invoiceDocumentDate\(inv, nbrPaymentsByInvoice\.get\(inv\.id\)\)\.date/.test(list),
  'F7 Liste: Spalte und CSV aus invoiceDocumentDate');
  ok(/const belegDatum = invoiceDocumentDate\(invoice, zahlungen\)/.test(detail)
    && /renderField\('Issued', <span data-invoice-detail-date=\{belegDatum\.kind\}>\{fmtDate\(belegDatum\.date\)\}/.test(detail)
    && /issuedAt: belegDatum\.date/.test(detail)
    && /<span>Date:<\/span><span>\{fmtDate\(belegDatum\.date\)\}/.test(detail)
    && !/fmtDate\(invoice\.issuedAt/.test(detail),
  'F7 Detailseite: Feld, PDF, Beleg und CSV aus derselben Quelle');
}

console.log(fails.length ? `\nFAIL — final-invoice-date: ${PASS} passed, ${fails.length} failed` : `\nPASS — final-invoice-date: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);

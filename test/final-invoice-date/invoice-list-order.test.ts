// ════════════════════════════════════════════════════════════════════════════
// INVOICE-LIST-ORDER — die Rechnungsübersicht steht nach dem Datum, das jede Zeile ZEIGT, neueste zuerst.
// Vorher: Ladereihenfolge `created_at` (17 → 17 → 16 → 17 → 14 → 12 → 15 Nov).
// Echte sql.js-Datenbank (schema.sql + echte Migrationen), echte Rechnungs-/Zahlungs-/Korrekturwege.
// Run: node test/final-invoice-date/invoice-list-order.test.ts
//
//   L1 reine Regel: Beispiel aus der Oberfläche          L2 feste Zweitsortierung, Eingabe unverändert
//   L3 Endrechnung: Endrechnungsdatum, nicht vorläufig    L4 Altbestand-Endrechnung aus den Zahlungen
//   L5 alle Status, fehlendes Datum am Ende               L6 Tag = angezeigter Tag (auch um Mitternacht)
//   L7 Primary: echte Rechnungen (Verkauf + Reparatur)    L8 PC2: derselbe Ladeweg über den Primary
//   L9 „Correct final date" ordnet neu (Primary + PC2)    L10 Liste: Sortierung nach allen Filtern
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
const { invoiceDocumentDate } = await import('../../src/core/invoices/invoice-document-date.ts');
const { sortInvoicesByDisplayedDate, displayedDayKey } = await import('../../src/core/invoices/invoice-list-order.ts');
const { setOpeningCutoffForTest } = await import('../../src/core/ledger/correction-dates.ts');
const { correctFinalInvoiceDateInHouse } = await import('../../src/core/invoices/final-date-correction.ts');
const { invoiceListExtrasFor } = await import('../../src/core/data/page-reads.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/store-read-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-21T10:00:00.000Z';
const S = (v: unknown): string => JSON.stringify(v);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

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

// ════════════════════════════════════════════════════════════════════════════
// Reine Regel (ohne Datenbank)
// ════════════════════════════════════════════════════════════════════════════
type T = { id: string; status: string; issuedAt: string; createdAt: string; finalIssuedAt?: string };
const ids = (xs: readonly { id: string }[]): string => xs.map((x) => x.id).join(',');
const keine = (): undefined => undefined;
/** Wie die Liste das Datum zeigt (`fmtDate` in InvoiceList.tsx). */
const fmt = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

// ── L1 Beispiel aus der Oberfläche: Ladereihenfolge 17, 17, 16, 17, 14, 12, 15 ──────────────────────────────────────
{
  const tage = ['17', '17', '16', '17', '14', '12', '15'];
  // Die Ladereihenfolge war `created_at` absteigend: a wurde zuletzt angelegt, g zuerst.
  const geladen: T[] = tage.map((t, i) => ({ id: 'abcdefg'[i], status: 'PARTIAL', issuedAt: `2026-11-${t}`,
    createdAt: `2026-11-20T10:0${6 - i}:00.000Z` }));
  ok(geladen.map((x) => fmt(x.issuedAt).slice(0, 2)).join(',') === tage.join(','), 'L1 Ausgang: die Ladereihenfolge zeigt 17,17,16,17,14,12,15');
  const r = sortInvoicesByDisplayedDate(geladen, keine);
  ok(r.map((x) => fmt(x.issuedAt).slice(0, 2)).join(',') === '17,17,17,16,15,14,12', `L1 sortiert: 17,17,17,16,15,14,12 (${r.map((x) => fmt(x.issuedAt).slice(0, 2))})`);
  ok(ids(r) === 'a,b,d,c,g,e,f', `L1 gleicher Tag 17: zuletzt angelegte zuerst (a,b,d) (${ids(r)})`);
}

// ── L2 feste Zweitsortierung; Eingabe unverändert ─────────────────────────────────────────────────────────────────────
{
  const basis: T[] = [
    { id: 'x1', status: 'PARTIAL', issuedAt: '2026-11-17', createdAt: '2026-11-17T08:00:00.000Z' },
    { id: 'x2', status: 'PARTIAL', issuedAt: '2026-11-17', createdAt: '2026-11-17T09:00:00.000Z' },
    { id: 'x3', status: 'PARTIAL', issuedAt: '2026-11-17', createdAt: '2026-11-17T09:00:00.000Z' },
    { id: 'x4', status: 'PARTIAL', issuedAt: '2026-11-16', createdAt: '2026-11-18T09:00:00.000Z' },
  ];
  const kopie = S(basis);
  const r = sortInvoicesByDisplayedDate(basis, keine);
  ok(ids(r) === 'x3,x2,x1,x4', `L2 gleicher Tag: created_at absteigend, dann id absteigend (${ids(r)})`);
  ok(S(basis) === kopie && r !== (basis as unknown), 'L2 Eingabe unverändert, neues Feld');
  // Jede Eingabereihenfolge ergibt dieselbe Ausgabe.
  const reihen = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]].map((o) => ids(sortInvoicesByDisplayedDate(o.map((i) => basis[i]), keine)));
  ok(new Set(reihen).size === 1, `L2 stabil: jede Eingabereihenfolge ergibt dieselbe Liste (${[...new Set(reihen)].join(' | ')})`);
}

// ── L3 Endrechnung: Endrechnungsdatum zählt, nicht das vorläufige Rechnungsdatum ──────────────────────────────────────
{
  const xs: T[] = [
    { id: 'neu-offen', status: 'PARTIAL', issuedAt: '2026-11-16', createdAt: '2026-11-16T10:00:00.000Z' },
    // Reparaturrechnung: vorläufig 09.11., Endrechnung 17.11.
    { id: 'rep-final', status: 'FINAL', issuedAt: '2026-11-09', createdAt: '2026-11-09T10:00:00.000Z', finalIssuedAt: '2026-11-17' },
    // Endrechnung, später wieder teilbezahlt: trägt weiter ihr Endrechnungsdatum.
    { id: 'zurueck-teil', status: 'PARTIAL', issuedAt: '2026-11-01', createdAt: '2026-11-01T10:00:00.000Z', finalIssuedAt: '2026-11-15' },
  ];
  const r = sortInvoicesByDisplayedDate(xs, keine);
  ok(ids(r) === 'rep-final,neu-offen,zurueck-teil', `L3 Endrechnungsdatum 17 vor 16 vor 15 (nicht vorläufig 09/01) (${ids(r)})`);
  ok(r.every((x) => invoiceDocumentDate(x, undefined).date === (x.finalIssuedAt || x.issuedAt)), 'L3 Sortierschlüssel = angezeigtes Datum (invoiceDocumentDate)');
}

// ── L4 Altbestand-Endrechnung (FINAL ohne festgehaltenes Datum): Tag der Vollzahlung aus den Zahlungen ───────────────
{
  const xs: T[] = [
    { id: 'alt', status: 'FINAL', issuedAt: '2026-11-02', createdAt: '2026-11-02T10:00:00.000Z' },
    { id: 'mitte', status: 'PARTIAL', issuedAt: '2026-11-10', createdAt: '2026-11-10T10:00:00.000Z' },
  ];
  const zahlungen = new Map([['alt', [{ receivedAt: '2026-11-05' }, { receivedAt: '2026-11-14' }]]]);
  ok(ids(sortInvoicesByDisplayedDate(xs, (id) => zahlungen.get(id))) === 'alt,mitte', 'L4 mit Zahlungen: Altbestand steht am Tag der Vollzahlung (14.)');
  ok(ids(sortInvoicesByDisplayedDate(xs, keine)) === 'mitte,alt', 'L4 ohne Zahlungen: dieselbe Rückfallregel wie die Anzeige (Rechnungstag 02.)');
}

// ── L5 alle Status; fehlendes / ungültiges Datum am Ende ───────────────────────────────────────────────────────────────
{
  const xs: T[] = [
    { id: 'leer', status: 'DRAFT', issuedAt: '', createdAt: '' },
    { id: 'storno', status: 'CANCELLED', issuedAt: '2026-11-13', createdAt: '2026-11-13T10:00:00.000Z' },
    { id: 'entwurf', status: 'DRAFT', issuedAt: '2026-11-11', createdAt: '2026-11-11T10:00:00.000Z' },
    { id: 'kaputt', status: 'PARTIAL', issuedAt: 'kein-datum', createdAt: '2026-11-19T10:00:00.000Z' },
    { id: 'final', status: 'FINAL', issuedAt: '2026-11-01', createdAt: '2026-11-01T10:00:00.000Z', finalIssuedAt: '2026-11-12' },
  ];
  const r = sortInvoicesByDisplayedDate(xs, keine);
  ok(ids(r) === 'storno,final,entwurf,kaputt,leer', `L5 jeder Status nach seinem Datum, ohne Datum am Ende (${ids(r)})`);
  ok(displayedDayKey('') === -1 && displayedDayKey(undefined) === -1 && displayedDayKey('x') === -1, 'L5 kein Datum = -1');
}

// ── L6 der Schlüssel ist der ANGEZEIGTE Tag (Ortszeit wie fmtDate), auch um Mitternacht ──────────────────────────────
{
  const werte = ['2026-11-16T22:30:00.000Z', '2026-11-17T01:00:00.000Z', '2026-11-16T23:59:59.000Z', '2026-11-17',
    '2026-11-16', '2026-11-17T21:15:00.000Z', '2026-11-15T23:00:00.000Z', '2026-11-16T00:30:00+03:00'];
  const tagText = (k: number): string => fmt(new Date(Math.floor(k / 10000), Math.floor(k / 100) % 100 - 1, k % 100, 12).toISOString());
  ok(werte.every((w) => tagText(displayedDayKey(w)) === fmt(w)), `L6 Schlüssel = angezeigter Tag für jede Schreibweise (${werte.filter((w) => tagText(displayedDayKey(w)) !== fmt(w))})`);
  const xs: T[] = werte.map((w, i) => ({ id: 'm' + i, status: 'PARTIAL', issuedAt: w, createdAt: `2026-11-20T10:00:0${i}.000Z` }));
  const r = sortInvoicesByDisplayedDate(xs, keine);
  const keys = r.map((x) => displayedDayKey(x.issuedAt));
  ok(keys.every((k, i) => i === 0 || keys[i - 1] >= k), `L6 die angezeigten Tage fallen nie wieder an (${r.map((x) => fmt(x.issuedAt))})`);
}

// ════════════════════════════════════════════════════════════════════════════
// Echte Datenbank — Primary und PC2
// ════════════════════════════════════════════════════════════════════════════
const db = freshDb();
db.run("INSERT INTO user_branches (user_id, branch_id, role, created_at) VALUES ('user-test','branch-main','ADMIN',?)", [NOW]);
setOpeningCutoffForTest('2025-01-01');

const LINE = (productId: string, price = 1000) => ({
  productId, quantity: 1, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: price / 10, lineTotal: price * 1.1,
});
let lauf = 0;
function rechnung(issued: string, numbering?: 'repair'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('p' + (++lauf))] as never, 'ORDER', issued, numbering).id);
  // Die Reihenfolge der Erfassung festlegen (sonst gleiche Millisekunde).
  db.run('UPDATE invoices SET created_at = ? WHERE id = ?', [`2026-11-19T08:00:0${lauf}.000Z`, id]);
  reload();
  return id;
}
function zahle(inv: string, betrag: number, receivedAt: string): void {
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, 'cash', undefined, undefined, undefined, undefined, undefined, { receivedAt }));
  reload();
}
const HEUTE = new Date().toISOString();
const CTX = { branchId: 'branch-main', userId: 'user-test', now: HEUTE, role: 'ADMIN' };
const rev = (inv: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
const korrigiere = (inv: string, newDate: string) =>
  imHaus(() => correctFinalInvoiceDateInHouse({ invoiceId: inv, newDate, reason: 'payment day typed wrongly', expectedRevision: rev(inv) }, CTX));

const R1 = rechnung('2026-11-14');                  // offen, 14.
const R2 = rechnung('2026-11-12');                  // offen, 12.
const R3 = rechnung('2026-11-10');                  // vorläufig 10., Endrechnung 17.
zahle(R3, 1100, '2026-11-17T12:00:00.000Z');
const R4 = rechnung('2026-11-09', 'repair');        // Reparaturrechnung: vorläufig 09., Endrechnung 16.
zahle(R4, 1100, '2026-11-16T09:00:00.000Z');
const R5 = rechnung('2026-11-15');                  // teilbezahlt am 18. — zeigt weiter den Rechnungstag 15.
zahle(R5, 500, '2026-11-18T09:00:00.000Z');
const R6 = rechnung('2026-11-17');                  // offen, 17. (zuletzt angelegt unter den 17ern)
const R7 = rechnung('2026-11-05');                  // Altbestand: Vollzahlung 13., kein festgehaltenes Datum
zahle(R7, 1100, '2026-11-13T09:00:00.000Z');
db.run('UPDATE invoices SET final_issued_at = NULL WHERE id = ?', [R7]); reload();
const NAME: Record<string, string> = { [R1]: 'R1', [R2]: 'R2', [R3]: 'R3', [R4]: 'R4', [R5]: 'R5', [R6]: 'R6', [R7]: 'R7' };
const namen = (xs: readonly { id: string }[]): string => xs.map((x) => NAME[x.id] ?? '?').join(',');

// Die Zahlungen, mit denen die Liste ihr Datum zeigt (dieselbe Abfrage wie `page.invoice_list.get`).
function zahlungenAus(extras: { payments: { invoiceId: string; receivedAt: string }[] }): Map<string, { receivedAt: string }[]> {
  const m = new Map<string, { receivedAt: string }[]>();
  for (const p of extras.payments) { const a = m.get(p.invoiceId) || []; a.push({ receivedAt: p.receivedAt }); m.set(p.invoiceId, a); }
  return m;
}
const CTXR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const ERWARTET = 'R6,R3,R4,R5,R1,R7,R2';

// ── L7 Primary ────────────────────────────────────────────────────────────────────────────────────────────────────────
let primaryListe = '';
{
  const k = (inv: string) => db.exec('SELECT status, final_issued_at, invoice_number FROM invoices WHERE id = ?', [inv])[0].values[0];
  ok(k(R3)[0] === 'FINAL' && String(k(R3)[1]).slice(0, 10) === '2026-11-17', `L7 Ausgang: R3 Endrechnung 17.11. (${S(k(R3))})`);
  ok(k(R4)[0] === 'FINAL' && String(k(R4)[1]).slice(0, 10) === '2026-11-16', `L7 Ausgang: R4 Reparatur-Endrechnung 16.11. (${S(k(R4))})`);
  ok(k(R5)[0] === 'PARTIAL' && k(R5)[1] === null && k(R7)[1] === null, 'L7 Ausgang: R5 teilbezahlt, R7 Altbestand ohne festgehaltenes Datum');
  const geladen = useInvoiceStore.getState().invoices;
  ok(namen(geladen) === 'R7,R6,R5,R4,R3,R2,R1', `L7 Ausgang: die Ladefolge ist created_at (der Fehler) (${namen(geladen)})`);
  const pay = zahlungenAus(invoiceListExtrasFor(CTXR));
  const r = sortInvoicesByDisplayedDate(geladen, (id) => pay.get(id));
  primaryListe = namen(r);
  ok(primaryListe === ERWARTET, `L7 Primary: 17 (R6, R3 Endrechnung), 16 (R4 Reparatur), 15, 14, 13 (Altbestand), 12 (${primaryListe})`);
  const tage = r.map((x) => fmt(invoiceDocumentDate(x, pay.get(x.id)).date).slice(0, 2)).join(',');
  ok(tage === '17,17,16,15,14,13,12', `L7 die angezeigten Tage fallen (${tage})`);
  const nachVorlaeufig = [...geladen].sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  ok(namen(nachVorlaeufig) !== ERWARTET, 'L7 Gegenprobe: nach dem vorläufigen Datum stünde die Liste anders');
}

// ── L8 PC2: derselbe Ladeweg über den Primary (store.invoices.get + page.invoice_list.get, über das Netz serialisiert) ─
async function pc2Liste(): Promise<{ liste: string; finalVon: (id: string) => unknown }> {
  const env = { actor: { commandId: 'read-1', ...CTXR, payloadHash: 'h' }, input: {} };
  const a = await executeCommand('store.invoices.get', env, undefined);
  const b = await executeCommand('page.invoice_list.get', env, undefined);
  if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('PC2-Lesen: ' + S(a) + ' ' + S(b));
  const invs = JSON.parse(S((a.value as { data: unknown }).data)).invoices as Array<T & { finalIssuedAt?: string }>;
  const extras = JSON.parse(S((b.value as { data: unknown }).data));
  const pay = zahlungenAus(extras);
  return { liste: namen(sortInvoicesByDisplayedDate(invs, (id) => pay.get(id))), finalVon: (id) => invs.find((x) => x.id === id)?.finalIssuedAt };
}
{
  const c = await pc2Liste();
  ok(c.liste === primaryListe, `L8 PC2 zeigt dieselbe Reihenfolge wie der Primary (${c.liste})`);
  ok(String(c.finalVon(R3)).slice(0, 10) === '2026-11-17' && String(c.finalVon(R4)).slice(0, 10) === '2026-11-16',
    'L8 PC2 bekommt das Endrechnungsdatum mitgeliefert');
}

// ── L9 „Correct final date" ordnet neu — Primary und PC2 ─────────────────────────────────────────────────────────────
{
  korrigiere(R3, '2026-11-11');
  reload();
  const pay = zahlungenAus(invoiceListExtrasFor(CTXR));
  const p = namen(sortInvoicesByDisplayedDate(useInvoiceStore.getState().invoices, (id) => pay.get(id)));
  ok(p === 'R6,R4,R5,R1,R7,R2,R3', `L9 Primary: R3 (jetzt 11.11.) steht hinter dem 12. (${p})`);
  const c = await pc2Liste();
  ok(c.liste === p && String(c.finalVon(R3)).slice(0, 10) === '2026-11-11', `L9 PC2 nach der Korrektur ebenso (${c.liste})`);
  korrigiere(R4, '2026-11-18');
  reload();
  const pay2 = zahlungenAus(invoiceListExtrasFor(CTXR));
  const p2 = namen(sortInvoicesByDisplayedDate(useInvoiceStore.getState().invoices, (id) => pay2.get(id)));
  ok(p2 === 'R4,R6,R5,R1,R7,R2,R3', `L9 Reparatur-Endrechnung auf 18.11. → ganz oben (${p2})`);
  ok((await pc2Liste()).liste === p2, 'L9 PC2 ebenso');
}

// ── L10 Rechnungsübersicht: dieselbe Regel nach ALLEN Filtern, dieselben Zahlungen wie die Datumsspalte ──────────────
{
  const list = src('src/pages/invoices/InvoiceList.tsx');
  const memo = list.slice(list.indexOf('const filtered = useMemo(() => {'), list.indexOf('const acceptedOffers'));
  ok(/import \{ sortInvoicesByDisplayedDate \} from '@\/core\/invoices\/invoice-list-order';/.test(list), 'L10 Liste nutzt die gemeinsame Regel');
  ok(/return sortInvoicesByDisplayedDate\(r, \(invId\) => nbrPaymentsByInvoice\.get\(invId\)\);\s*\}, \[[^\]]*nbrPaymentsByInvoice\]\);/.test(memo),
    'L10 Sortierung ist der letzte Schritt von `filtered` (nach Kunde, Mitarbeiter, Status, Rückgabe, Suche) und hängt an den Zahlungen');
  ok((memo.match(/return r;/g) || []).length === 0 && /filterStatus === 'RETURNED'[\s\S]*filterStatus === 'returns'[\s\S]*filterStatus === 'OPEN'[\s\S]*searchQuery/.test(memo),
    'L10 kein Filterzweig gibt unsortiert zurück');
  ok(/\{filtered\.map\(inv => \{/.test(list) && /const d = invoiceDocumentDate\(inv, nbrPaymentsByInvoice\.get\(inv\.id\)\);/.test(list),
    'L10 die Zeilen kommen aus `filtered`, die Datumsspalte aus denselben Zahlungen');
  const regel = src('src/core/invoices/invoice-list-order.ts');
  ok(!/\b(db\.run|query\(|INSERT|UPDATE|DELETE|ledger|vat|payment)\b/i.test(regel.replace(/\/\/.*$/gm, '').replace(/import[^;]*;/g, '').replace(/DatedPayment|paymentsOf/g, '')),
    'L10 die Regel liest und schreibt nichts (keine Buchung, Zahlung, VAT)');
}

console.log(fails.length ? `\nFAIL — invoice-list-order: ${PASS} passed, ${fails.length} failed` : `\nPASS — invoice-list-order: ${PASS} passed, 0 failed`);
process.exit(fails.length ? 1 : 0);

// ════════════════════════════════════════════════════════════════════════════
// PURCHASE-EDIT PHASE 2 — einen bestehenden Einkauf bearbeiten (Owner-Entscheide D1–D14).
// Echte sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema), echte Stores,
// echte Hausfolgen, echtes Hauptbuch — wie lot-vat-cost / stock-lot-integrity.
// Run: node --experimental-strip-types test/purchase-edit/purchase-edit.test.ts
//
//   A  Notiz + Datum: Lose, Artikeldatum, Hauptbuch unverändert, Protokoll, Fassung
//   B  Preis 550 → 500, unverkauft/unbezahlt: Zeile, Los, Artikel (D13), Gegen- und Neubuchung
//   C  Preis 550 → 500 nach dem Verkauf (Rolex): Korrekturart, Einstandskorrektur (D1), Rechnung
//      unverändert, Gewinn wirtschaftlich korrigiert, Überzahlung → Guthaben, Zahlung stornieren (D14)
//      und neu erfassen, Kunden-Retoure zum berichtigten Einstand
//   D  Rechnung stornieren nimmt die Einstandskorrektur mit; Rechnung bearbeiten sperrt die Menge
//   E  Lieferantenwechsel (D5): Bestätigung, Hauptbuch und Zahlungen umgebucht, Momentaufnahme
//   F  Menge (unberührt / nach Verkauf gesperrt)
//   G  Sperren: storniert, Kommission, Stichtag, Datum über den Stichtag, Vorsteuer-Quartal, eingereicht,
//      Partner, Rückgabe, alte Fassung, ohne Grund, nichts geändert, Rabatt
//   H  B1 Vorsteuer-Split nach Neubuchung; B5 Storno-Riegel; B6 Kommissions-Spalte; B7 strikte Buchung
//   I  D10 Ausweisfoto ersetzen (verborgen aufbewahrt); D13 Artikel-Sperre; D14 Guthaben-Zahlung stornieren
// Invariante überall: Σ Restmenge × Einstand aller Lose == Saldo INVENTORY.
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
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

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
const { useInvoiceStore, loadInvoicesFor } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const edit = await import('../../src/core/purchases/purchase-edit-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const { computeSalesMetrics } = await import('../../src/core/reports/sales-metrics.ts');
const { loadSalesData } = await import('../../src/core/reports/sales-metrics-loader.ts');
const { costCorrectionBridge, costCorrectionRows } = await import('../../src/core/purchases/cost-correction-read.ts');
const { purchaseBoundRefusal, soldItemEditNeedsReason } = await import('../../src/core/products/purchase-bound.ts');
const { vatFingerprint } = await import('../../src/core/tax/vat-period-lock.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-24T10:00:00.000Z';
const PDATE = '2026-10-20';   // nach dem Eröffnungsstichtag 15.10.2026
const SDATE = '2026-10-21';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

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
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
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
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant A',1,?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-2','branch-main','Lieferant B',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const code = (m: string): string => m.split('|')[0];

/** Einkauf eines NEUEN Artikels (der Einkauf legt ihn an → D13). Stückpreis brutto. */
function kaufNeu(opts: { price: number; qty?: number; vat?: boolean; date?: string; paid?: number; supplier?: string; sku?: string }): { pid: string; productId: string; lineId: string } {
  const p = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: opts.supplier ?? 'sup-1',
    purchaseDate: opts.date ?? PDATE,
    lines: [{
      newProduct: { categoryId: 'cat-w', brand: 'Rolex', name: 'Submariner', sku: opts.sku ?? `SKU-${Math.random().toString(36).slice(2, 8)}`, taxScheme: 'MARGIN', plannedSalePrice: 900 } as never,
      quantity: opts.qty ?? 1, unitPrice: opts.price,
      taxScheme: opts.vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: opts.vat ? 10 : 0,
    }],
    ...(opts.paid ? { initialPayment: { amount: opts.paid, method: 'cash' as const } } : {}),
  }));
  reload();
  return { pid: p.id, productId: p.lines[0].productId!, lineId: p.lines[0].id };
}
const LINE = (productId: string, qty = 1, price = 700, scheme: 'VAT_10' | 'MARGIN' = 'MARGIN') => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: scheme, vatRate: 10,
  vatAmount: scheme === 'VAT_10' ? (price * qty) / 10 : 0, lineTotal: scheme === 'VAT_10' ? price * qty * 1.1 : price * qty,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, date = SDATE): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', lines as never, 'PE', `${date}T12:00:00.000Z`).id);
  reload();
  return id;
}
function voll(db: Db, invId: string): void {
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
}
const rev = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);
const editIt = (db: Db, req: Record<string, unknown>, ctx = CTX) => {
  const out = imHaus(() => edit.editPurchaseInHouse(req as never, ctx, rev(db, String(req.purchaseId))));
  reload();
  return out;
};

// ── Messgrößen ──
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const lotsValue = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
const balance = (db: Db, account: string, extra = '', p: unknown[] = []): number =>
  r3(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? ${extra}`, [account, ...p]));
const apOf = (db: Db, supplierId: string): number => -balance(db, 'ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [supplierId]);
const invariant = (db: Db, tag: string): void => {
  const a = inventory(db); const b = lotsValue(db);
  ok(eq(a, b), `${tag} Invariante: INVENTORY ${a} == Restwert der Lose ${b}`);
};
const lotOfLine = (db: Db, lineId: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [lineId]);
const unitCost = (db: Db, lot: string): number => n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]);
const purchaseLive = (db: Db, pid: string, account: string, dir: string): number =>
  r3(n(db, `SELECT COALESCE(SUM(e1.amount), 0) FROM ledger_entries e1 WHERE e1.source_module = 'PURCHASE' AND e1.source_id = ? AND e1.account = ? AND e1.direction = ?
             AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [pid, account, dir]));

// ══ A — Notiz + Datum ════════════════════════════════════════════════════════
{
  const db = freshDb();
  const { pid, productId, lineId } = kaufNeu({ price: 550 });
  ok(n(db, 'SELECT created_product FROM purchase_lines WHERE id = ?', [lineId]) === 1, 'A die Zeile hat ihren Artikel angelegt (created_product = 1)');
  const r0 = rev(db, pid);
  const ledger0 = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const out = editIt(db, { purchaseId: pid, reason: 'falsches Datum', notes: 'Bon 4711', purchaseDate: '2026-10-19' });
  ok(S(out.kinds) === S(['NOTES', 'DATE']), `A Arten NOTES+DATE (${S(out.kinds)})`);
  ok(s(db, 'SELECT purchase_date FROM purchases WHERE id = ?', [pid]) === '2026-10-19' && s(db, 'SELECT notes FROM purchases WHERE id = ?', [pid]) === 'Bon 4711',
    'A Kopf: neues Datum und Notiz');
  ok(s(db, 'SELECT acquired_at FROM stock_lots WHERE purchase_line_id = ?', [lineId]) === '2026-10-19', 'A das Los trägt das neue Datum (FIFO)');
  ok(s(db, 'SELECT purchase_date FROM products WHERE id = ?', [productId]).slice(0, 10) === '2026-10-19', 'A der Artikel folgt (D13: von der Zeile angelegt)');
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledger0, 'A das Hauptbuch bleibt unberührt (D4: kein Verschieben, keine Rückdatierung)');
  ok(rev(db, pid) === r0 + 1 && out.revision === r0 + 1, `A die Fassung steigt genau einmal (${r0} → ${rev(db, pid)})`);
  ok(n(db, 'SELECT COUNT(*) FROM purchase_edits WHERE purchase_id = ?', [pid]) === 1
    && s(db, 'SELECT reason FROM purchase_edits WHERE purchase_id = ?', [pid]) === 'falsches Datum',
    'A Protokoll purchase_edits mit Grund');
  const oldSnap = JSON.parse(s(db, 'SELECT old_snapshot FROM purchase_edits WHERE purchase_id = ?', [pid]));
  ok(oldSnap.header.purchaseDate === PDATE && oldSnap.header.notes === null, 'A Vorher-Stand im Protokoll');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'purchases' AND entity_id = ? AND action_type = 'UPDATE'", [pid]) === 1, 'A Feldprotokoll im audit_log');
  invariant(db, 'A');
}

// ══ B — Preis 550 → 500, unverkauft, unbezahlt ═════════════════════════════════
{
  const db = freshDb();
  const { pid, productId, lineId } = kaufNeu({ price: 550 });
  ok(apOf(db, 'sup-1') === 550, `B vorher A/P 550 (${apOf(db, 'sup-1')})`);
  const m = meldung(() => editIt(db, { purchaseId: pid, reason: 'Tippfehler', lines: [{ lineId, unitPrice: 500 }] }));
  ok(code(m) === 'PURCHASE_EDIT_CORRECTION_KIND_REQUIRED', `B ohne Korrekturart: Nein (${m})`);
  const out = editIt(db, { purchaseId: pid, reason: 'Tippfehler', lines: [{ lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' });
  ok(out.totalAmount === 500 && out.status === 'UNPAID' && out.remainingAmount === 500, `B Kopf 500 / UNPAID / offen 500 (${S(out)})`);
  ok(n(db, 'SELECT unit_price FROM purchase_lines WHERE id = ?', [lineId]) === 500 && n(db, 'SELECT line_total FROM purchase_lines WHERE id = ?', [lineId]) === 500, 'B Zeile 500');
  ok(eq(unitCost(db, lotOfLine(db, lineId)), 500), `B Los-Einstand 500 (${unitCost(db, lotOfLine(db, lineId))})`);
  ok(eq(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [productId]), 500), 'B Artikel-Einkaufspreis folgt (D13)');
  ok(eq(n(db, 'SELECT expected_margin FROM products WHERE id = ?', [productId]), 400), 'B erwartete Marge neu (900 − 500), Verkaufspreis unverändert');
  ok(n(db, 'SELECT planned_sale_price FROM products WHERE id = ?', [productId]) === 900, 'B Verkaufspreis bleibt (D13)');
  ok(purchaseLive(db, pid, 'INVENTORY', 'DEBIT') === 500 && purchaseLive(db, pid, 'ACCOUNTS_PAYABLE', 'CREDIT') === 500, 'B Neubuchung INVENTORY/AP 500');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ? AND reverses_entry_id IS NOT NULL", [pid]) > 0,
    'B die alte Buchung ist gegengebucht, nicht überschrieben');
  ok(s(db, "SELECT MAX(occurred_at) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ?", [pid]).slice(0, 10) === NOW.slice(0, 10),
    'B Gegen- und Neubuchung tragen das Korrekturdatum (D3)');
  ok(apOf(db, 'sup-1') === 500, `B A/P 500 (${apOf(db, 'sup-1')})`);
  ok(n(db, 'SELECT COUNT(*) FROM cost_corrections') === 0, 'B nichts verkauft → keine Einstandskorrektur');
  invariant(db, 'B');
}

// ══ C — Rolex: Preis 550 → 500 nach dem Verkauf für 700, bezahlt 550 ═══════════
{
  const db = freshDb();
  const { pid, productId, lineId } = kaufNeu({ price: 550, paid: 550 });
  const inv = rechnung([LINE(productId, 1, 700, 'MARGIN')]);
  voll(db, inv);
  const ilId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const fpVorher = S(vatFingerprint(inv));
  const metricsVorher = computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, []);
  ok(eq(metricsVorher.profit, 150), `C Gewinn vor der Korrektur 150 (${metricsVorher.profit})`);
  invariant(db, 'C vorher');

  const rabatt = meldung(() => editIt(db, { purchaseId: pid, reason: 'Rabatt', lines: [{ lineId, unitPrice: 500 }], correctionKind: 'SUPPLIER_DISCOUNT' }));
  ok(code(rabatt) === 'PURCHASE_EDIT_DISCOUNT_NOT_ENABLED', `C ein späterer Rabatt ist gesperrt (${rabatt})`);
  const check = edit.purchaseEditCheck(pid, 'branch-main', NOW);
  ok(check.lines[0].price.allowed && check.lines[0].soldUnits === 1, `C Prüfauskunft: Preis änderbar, 1 verkauft (${S(check.lines[0])})`);
  ok(!check.lines[0].quantityLock.allowed && check.lines[0].quantityLock.code === 'PURCHASE_EDIT_QTY_STOCK_USED', 'C Menge gesperrt (verkauft)');

  const out = editIt(db, { purchaseId: pid, reason: 'Einkaufspreis falsch erfasst', lines: [{ lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' });
  ok(out.corrections.length === 1 && eq(out.corrections[0].amount, -50), `C eine Einstandskorrektur −50 (${S(out.corrections)})`);
  const cc = db.exec('SELECT * FROM cost_corrections')[0];
  const row = Object.fromEntries(cc.columns.map((c, i) => [c, cc.values[0][i]]));
  ok(row.invoice_line_id === ilId && row.kind === 'ENTRY_ERROR' && row.status === 'ACTIVE' && row.vat_status === 'REVIEW', 'C Beleg: Rechnungszeile, Erfassungsfehler, wirksam, VAT zur Prüfung');
  ok(row.economic_date === SDATE && row.booking_date === NOW.slice(0, 10), `C zwei Daten: wirtschaftlich ${row.economic_date}, gebucht ${row.booking_date} (D1-B)`);
  ok(eq(Number(row.vat_estimate), 4.545), `C mögliche Margen-VAT-Wirkung +4,545 gekennzeichnet (${row.vat_estimate})`);
  ok(eq(Number(row.old_unit_cost), 550) && eq(Number(row.new_unit_cost), 500), 'C alter und neuer Einstand im Beleg');
  ok(String(row.correction_number).startsWith('CC-'), `C Belegnummer ${row.correction_number}`);
  // Die Rechnung bleibt unverändert.
  ok(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE id = ?', [ilId]) === 550 && eq(n(db, 'SELECT margin_snapshot FROM invoices WHERE id = ?', [inv]), 150),
    'C die Rechnung trägt weiter ihren Verkaufsstand (550 / Marge 150)');
  ok(S(vatFingerprint(inv)) === fpVorher, 'C der VAT-Fingerabdruck der Rechnung ist unverändert (nichts geht in eine Erklärung)');
  // Hauptbuch: Wareneinsatz netto 500, kein VAT-Konto berührt.
  ok(balance(db, 'COGS') === 500, `C Wareneinsatz netto 500 (${balance(db, 'COGS')})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'COST_CORRECTION' AND account IN ('VAT_OUTPUT','MARGIN_VAT','VAT_INPUT')") === 0,
    'C die Korrekturbuchung berührt kein VAT-Konto');
  invariant(db, 'C nach Korrektur');
  // Gewinn wirtschaftlich korrigiert (+50) — in der Periode des Verkaufs.
  const metrics = computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, []);
  ok(eq(metrics.profit, 200), `C Gewinnbericht 200 statt 150 (${metrics.profit})`);
  const okt = computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, [], { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' });
  ok(eq(okt.profit, 200), `C …im Monat des Verkaufs (${okt.profit})`);
  const invStore = loadInvoicesFor({ branchId: 'branch-main' } as never).invoices.find((i) => i.id === inv)!;
  ok(eq(invStore.costCorrection ?? 0, -50) && eq(invStore.lines[0].costCorrection ?? 0, -50), 'C die Rechnung im Store trägt die Korrektur (Kopf und Zeile)');
  const bridge = costCorrectionBridge('branch-main');
  ok(bridge.length === 1 && eq(bridge[0].booked, -50) && eq(bridge[0].attributed, -50), `C Überleitung: gebucht und zugeordnet im selben Monat (${S(bridge)})`);
  ok(costCorrectionRows('branch-main').length === 1, 'C Überleitungsansicht listet die Korrektur genau einmal');
  // Bezahlt 550 > neue Summe 500 → 50 Lieferantenguthaben (Slice 4b).
  ok(out.status === 'PAID' && eq(out.overpayCredit, 50), `C bezahlt 550 > 500: PAID + 50 Guthaben (${S(out)})`);
  ok(apOf(db, 'sup-1') === 0, `C A/P 0 (${apOf(db, 'sup-1')})`);

  // D14 — die Zahlung war falsch erfasst (bezahlt wurden wirklich 500): stornieren, neu erfassen.
  const payId = s(db, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [pid]);
  const ohneGrund = meldung(() => imHaus(() => edit.voidPurchasePaymentInHouse(pid, payId, ' ', CTX, rev(db, pid))));
  ok(code(ohneGrund) === 'PURCHASE_EDIT_REASON_REQUIRED', 'C Storno einer Zahlung braucht einen Grund');
  const v = imHaus(() => edit.voidPurchasePaymentInHouse(pid, payId, 'Betrag falsch erfasst', CTX, rev(db, pid)));
  reload();
  ok(v.paidAmount === 0 && v.status === 'UNPAID' && v.remainingAmount === 500, `C nach dem Storno: 0 bezahlt, offen 500 (${S(v)})`);
  ok(s(db, 'SELECT voided_at FROM purchase_payments WHERE id = ?', [payId]) === NOW && n(db, 'SELECT amount FROM purchase_payments WHERE id = ?', [payId]) === 550,
    'C die Zahlung bleibt als Zeile (Nachweis), mit Storno');
  ok(n(db, 'SELECT COUNT(*) FROM supplier_credits WHERE source_purchase_id = ?', [pid]) === 0, 'C das Überzahlungsguthaben ist wieder weg');
  ok(balance(db, 'CASH') === r3(700 - 0), `C Kasse: nur der Verkauf (${balance(db, 'CASH')})`);
  const nochmal = meldung(() => imHaus(() => edit.voidPurchasePaymentInHouse(pid, payId, 'x', CTX, rev(db, pid))));
  ok(code(nochmal) === 'PAYMENT_ALREADY_VOIDED', 'C zweimal stornieren: Nein');
  imHaus(() => payables.recordPurchasePaymentInHouse(pid, 500, 'cash', CTX, { expectedRevision: rev(db, pid) }));
  reload();
  ok(s(db, 'SELECT status FROM purchases WHERE id = ?', [pid]) === 'PAID' && apOf(db, 'sup-1') === 0, 'C neu erfasst 500: PAID, A/P 0');
  ok(usePurchaseStore.getState().getPurchase(pid)!.payments.some((p) => p.voidedAt), 'C die Maske sieht die stornierte Zahlung als solche');

  // Kunden-Retoure: das Stück kommt zum berichtigten Einstand zurück.
  const rid = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const r = rs.createReturn({
      invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'zurück',
      lines: [{ invoiceLineId: ilId, productId, quantity: 1, unitPrice: 700, vatAmount: 0 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(r);
    return r;
  });
  reload();
  ok(r3(n(db, "SELECT COALESCE(SUM(amount),0) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND source_id = ? AND account = 'COGS' AND direction = 'CREDIT'", [rid])) === 500,
    'C die Retoure dreht 500 Wareneinsatz zurück (Verkaufstag 550 + Korrektur −50)');
  ok(eq(unitCost(db, lotOfLine(db, lineId)), 500) && n(db, 'SELECT qty_remaining FROM stock_lots WHERE purchase_line_id = ?', [lineId]) === 1, 'C das Stück liegt wieder im Los, zu 500');
  ok(balance(db, 'COGS') === 0, `C Wareneinsatz danach 0 (${balance(db, 'COGS')})`);
  invariant(db, 'C nach Retoure');
}

// ══ D — Rechnung stornieren nimmt die Korrektur mit; Rechnung bearbeiten sperrt die Menge ═══
{
  const db = freshDb();
  const { pid, productId, lineId } = kaufNeu({ price: 550, qty: 2 });
  const inv = rechnung([LINE(productId, 1, 700, 'MARGIN')]);
  editIt(db, { purchaseId: pid, reason: 'falsch', lines: [{ lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' });
  ok(n(db, "SELECT COUNT(*) FROM cost_corrections WHERE status = 'ACTIVE'") === 1, 'D eine wirksame Korrektur (1 von 2 verkauft)');
  ok(eq(unitCost(db, lotOfLine(db, lineId)), 500) && n(db, 'SELECT qty_remaining FROM stock_lots WHERE purchase_line_id = ?', [lineId]) === 1, 'D das unverkaufte Stück steht zu 500 im Los');
  invariant(db, 'D nach Korrektur');
  // Rechnung bearbeiten: Menge der korrigierten Zeile bleibt gesperrt.
  const il = useInvoiceStore.getState().getInvoice(inv)!.lines[0];
  const editNein = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    reason: 'Menge', lines: [{ ...LINE(productId, 2, 700, 'MARGIN'), lineId: il.id }],
  } as never)));
  ok(code(editNein) === 'INVOICE_LINE_COST_CORRECTED', `D Rechnung bearbeiten: Menge der korrigierten Zeile gesperrt (${editNein.slice(0, 80)})`);
  // Storno der Rechnung: Korrektur gegengebucht, Stück zum berichtigten Einstand zurück.
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'CANCELLED' }));
  reload();
  ok(s(db, 'SELECT status FROM cost_corrections') === 'REVERSED' && s(db, 'SELECT reversed_reason FROM cost_corrections') === 'invoice cancelled', 'D Storno: Korrektur REVERSED');
  ok(n(db, 'SELECT qty_remaining FROM stock_lots WHERE purchase_line_id = ?', [lineId]) === 2, 'D beide Stücke wieder im Los');
  ok(balance(db, 'COGS') === 0, `D Wareneinsatz 0 (${balance(db, 'COGS')})`);
  invariant(db, 'D nach Storno');
  ok(eq(computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, []).profit, 0), 'D die stornierte Rechnung zählt im Gewinn nicht mehr');
  // Überleitung: das Hauptbuch hat Korrektur und Gegenbuchung, der Gewinnbericht nichts mehr — beide 0.
  const br = costCorrectionBridge('branch-main');
  ok(br.reduce((a, r) => a + r.booked, 0) === 0 && br.reduce((a, r) => a + r.attributed, 0) === 0
    && br.every((r) => eq(r.difference, r.attributed - r.booked)), `D Überleitung nach Storno: gebucht 0, zugeordnet 0 (${S(br)})`);
}

// ══ E — Lieferantenwechsel (D5) ════════════════════════════════════════════════
{
  const db = freshDb();
  const { pid } = kaufNeu({ price: 550, paid: 200 });
  ok(apOf(db, 'sup-1') === 350 && apOf(db, 'sup-2') === 0, 'E vorher: A/P A 350, B 0');
  const ohne = meldung(() => editIt(db, { purchaseId: pid, reason: 'falscher Lieferant', supplierId: 'sup-2' }));
  ok(code(ohne) === 'PURCHASE_EDIT_CONFIRM_PAYMENTS', `E mit Zahlung: Bestätigung nötig (${ohne.slice(0, 60)})`);
  const out = editIt(db, { purchaseId: pid, reason: 'falscher Lieferant', supplierId: 'sup-2', confirmPaymentsToNewSupplier: true });
  ok(S(out.kinds) === S(['SUPPLIER']), 'E Art SUPPLIER');
  ok(s(db, 'SELECT supplier_id FROM purchases WHERE id = ?', [pid]) === 'sup-2', 'E Einkauf steht beim neuen Lieferanten');
  ok(apOf(db, 'sup-1') === 0 && apOf(db, 'sup-2') === 350, `E A/P umgebucht: A ${apOf(db, 'sup-1')}, B ${apOf(db, 'sup-2')}`);
  ok(n(db, 'SELECT amount FROM purchase_payments WHERE purchase_id = ?', [pid]) === 200 && s(db, 'SELECT paid_at FROM purchase_payments WHERE purchase_id = ?', [pid]) === PDATE,
    'E die Zahlung selbst bleibt (Betrag, Datum)');
  const snap = JSON.parse(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [pid]));
  ok(snap.name === 'Lieferant B' && snap.previousSuppliers?.[0]?.supplierId === 'sup-1', 'E Momentaufnahme neu, der alte Lieferant im Verlauf');
  ok(useSupplierStore.getState().suppliers.length >= 2, 'E Lieferanten unverändert vorhanden');
}

// ══ F — Menge ══════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const { pid, productId, lineId } = kaufNeu({ price: 100, qty: 1 });
  const out = editIt(db, { purchaseId: pid, reason: 'zwei Stück', lines: [{ lineId, quantity: 2 }] });
  ok(out.totalAmount === 200 && n(db, 'SELECT qty_total FROM stock_lots WHERE purchase_line_id = ?', [lineId]) === 2
    && n(db, 'SELECT quantity FROM products WHERE id = ?', [productId]) === 2, 'F unberührt: Menge 2, Los 2, Artikel 2');
  invariant(db, 'F');
  const halb = meldung(() => editIt(db, { purchaseId: pid, reason: 'x', lines: [{ lineId, quantity: 1.5 }] }));
  ok(code(halb) === 'PURCHASE_EDIT_QTY_INVALID', 'F keine halben Stücke');
  rechnung([LINE(productId, 1, 300, 'MARGIN')]);
  const nein = meldung(() => editIt(db, { purchaseId: pid, reason: 'x', lines: [{ lineId, quantity: 3 }] }));
  ok(code(nein) === 'PURCHASE_EDIT_QTY_STOCK_USED', `F nach Verkauf: Menge gesperrt (${nein.slice(0, 60)})`);
}

// ══ G — Sperren ═════════════════════════════════════════════════════════════════
{
  // Stichtag
  let db = freshDb();
  let k = kaufNeu({ price: 300, date: '2026-10-10' });
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', lines: [{ lineId: k.lineId, unitPrice: 250 }], correctionKind: 'ENTRY_ERROR' })))
    === 'PURCHASE_EDIT_BEFORE_CUTOVER', 'G vor dem Stichtag: Preis gesperrt');
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', purchaseDate: '2026-10-16' }))) === 'PURCHASE_EDIT_BEFORE_CUTOVER', 'G Datum nicht über den Stichtag');
  ok(editIt(db, { purchaseId: k.pid, reason: 'Datum', purchaseDate: '2026-10-09' }).kinds.includes('DATE'), 'G Datum vor dem Stichtag bleibt vor dem Stichtag: erlaubt');
  ok(editIt(db, { purchaseId: k.pid, reason: 'Notiz', notes: 'ok' }).kinds.includes('NOTES'), 'G Notiz geht immer');
  // Vorsteuer: nur im laufenden, offenen Quartal
  db = freshDb();
  k = kaufNeu({ price: 110, vat: true });
  const naechstesQuartal = { ...CTX, now: '2027-01-05T10:00:00.000Z' };
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', lines: [{ lineId: k.lineId, unitPrice: 99 }], correctionKind: 'ENTRY_ERROR' }, naechstesQuartal)))
    === 'PURCHASE_EDIT_VAT_PERIOD', 'G Vorsteuer in einem früheren Quartal: gesperrt');
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf1','branch-main',2026,4,?, '{}', ?)`, [NOW, NOW]);
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', lines: [{ lineId: k.lineId, unitPrice: 99 }], correctionKind: 'ENTRY_ERROR' })))
    === 'PURCHASE_EDIT_VAT_PERIOD', 'G eingereichtes Quartal: gesperrt');
  db.run("DELETE FROM vat_filings");
  const vatOut = editIt(db, { purchaseId: k.pid, reason: 'x', lines: [{ lineId: k.lineId, unitPrice: 99 }], correctionKind: 'ENTRY_ERROR' });
  ok(vatOut.totalAmount === 99 && eq(purchaseLive(db, k.pid, 'VAT_INPUT', 'DEBIT'), 9), `G laufendes Quartal: Vorsteuer neu 9 (${purchaseLive(db, k.pid, 'VAT_INPUT', 'DEBIT')})`);
  ok(eq(unitCost(db, lotOfLine(db, k.lineId)), 90), `G Los netto 90 (${unitCost(db, lotOfLine(db, k.lineId))})`);
  invariant(db, 'G Vorsteuer');
  // B1 — eine Rückgabe danach dreht genau die NEUE Vorsteuer zurück (nicht doppelt).
  const split = posting.getPurchaseLineInputSplit(k.lineId);
  ok(eq(split.net, 90) && eq(split.vat, 9), `H B1 Split nach Neubuchung 90/9 (${S(split)})`);
  imHaus(() => life.returnToSupplierInHouse({ purchaseId: k.pid, refundMethod: 'cash', lines: [{ purchaseLineId: k.lineId, quantity: 1, unitPrice: 99 }] }, CTX, rev(db, k.pid)));
  reload();
  ok(eq(balance(db, 'VAT_INPUT'), 0), `H B1 nach der Rückgabe: Vorsteuer 0 (${balance(db, 'VAT_INPUT')})`);
  invariant(db, 'H B1');
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', notes: 'n', lines: [{ lineId: k.lineId, unitPrice: 50 }], correctionKind: 'ENTRY_ERROR' })))
    === 'PURCHASE_EDIT_HAS_RETURN', 'G mit Rückgabe: Finanzkorrektur gesperrt');
  ok(editIt(db, { purchaseId: k.pid, reason: 'Notiz', notes: 'trotz Rückgabe' }).kinds.includes('NOTES'), 'G …die Notiz bleibt frei');
  // Kommission, Partner, Storno, Fassung, Grund, nichts
  db = freshDb();
  k = kaufNeu({ price: 400 });
  db.run("UPDATE purchases SET source_consignment_id = 'con-x' WHERE id = ?", [k.pid]);
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', purchaseDate: '2026-10-19' }))) === 'PURCHASE_EDIT_CONSIGNMENT', 'G Kommissions-Einkauf: gesperrt');
  ok(editIt(db, { purchaseId: k.pid, reason: 'Notiz', notes: 'mit Spalte' }).kinds.includes('NOTES'), 'G B6 mit Kommissions-Spalte darf die Notiz sich ändern');
  db = freshDb();
  k = kaufNeu({ price: 400 });
  db.run(`INSERT INTO partners (id, branch_id, name, active, created_at, updated_at) VALUES ('par-1','branch-main','Partner',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO item_participations (id, branch_id, purchase_id, purchase_line_id, product_id, party, partner_id, share_bp, cost_share, line_total, quantity, created_at)
          VALUES ('ip1','branch-main',?,?,?,'PARTNER','par-1',5000,200,400,1,?)`, [k.pid, k.lineId, k.productId, NOW]);
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', lines: [{ lineId: k.lineId, unitPrice: 300 }], correctionKind: 'ENTRY_ERROR' })))
    === 'PURCHASE_EDIT_PARTNER_LINE', 'G Partnerzeile: Preis gesperrt (D9)');
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: '   ', notes: 'x' }))) === 'PURCHASE_EDIT_REASON_REQUIRED', 'G ohne Grund: Nein');
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x' }))) === 'PURCHASE_EDIT_NOTHING', 'G nichts geändert: Nein');
  const alt = meldung(() => imHaus(() => edit.editPurchaseInHouse({ purchaseId: k.pid, reason: 'x', notes: 'y' } as never, CTX, rev(db, k.pid) - 1)));
  ok(code(alt) === 'RECORD_CHANGED', 'G alte Fassung: RECORD_CHANGED, nichts geschrieben');
  ok(s(db, 'SELECT COALESCE(notes, \'\') FROM purchases WHERE id = ?', [k.pid]) === '', 'G …und wirklich nichts geschrieben');
  imHaus(() => life.cancelPurchaseInHouse(k.pid, 'branch-main', {}));
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', notes: 'y' }))) === 'PURCHASE_CANCELLED', 'G storniert: Nein');
}

// ══ H — B5 / B6 / B7 ════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const k = kaufNeu({ price: 400 });
  db.run('UPDATE stock_lots SET unit_cost = unit_cost + 25 WHERE purchase_line_id = ?', [k.lineId]);
  const m = meldung(() => imHaus(() => life.cancelPurchaseInHouse(k.pid, 'branch-main', {})));
  ok(code(m) === 'PURCHASE_LOT_COST_CHANGED', `H B5 Storno nach Einstandsänderung (Reparatur) gesperrt (${m.slice(0, 60)})`);
  db.run('UPDATE stock_lots SET unit_cost = unit_cost - 25 WHERE purchase_line_id = ?', [k.lineId]);
  db.run(`INSERT INTO stock_adjustments (id, branch_id, adjustment_number, product_id, direction, quantity, qty_before, qty_after, status_before, status_after,
            accounting, value_booked, lots_json, reason_category, reason, business_date, status, action_id, payload_hash, created_at, revision)
          VALUES ('adj1','branch-main','ADJ-1',?, 'ISSUE', 1, 1, 0, 'in_stock', 'write_off', 'BOOKED', 400, ?, 'LOSS', 'x', ?, 'POSTED', 'a1', 'h', ?, 0)`,
    [k.productId, JSON.stringify([{ lotId: lotOfLine(db, k.lineId), take: 1, unitCost: 400, qtyBefore: 1, statusBefore: 'ACTIVE' }]), PDATE, NOW]);
  ok(code(meldung(() => imHaus(() => life.cancelPurchaseInHouse(k.pid, 'branch-main', {})))) === 'PURCHASE_STOCK_ADJUSTED', 'H B5 Storno nach Bestandsabgang gesperrt');
  // B6 — der Bestand bekommt seine Kommissions-Spalte aus dem Vermerk.
  db.run(`INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id, agreed_price, commission_rate, status, agreement_date, created_at, updated_at)
          VALUES ('con-1','branch-main','CON-2026-0001','cust-1',?,500,15,'sold',?,?,?)`, [k.productId, PDATE, NOW, NOW]);
  db.run("UPDATE purchases SET notes = 'Consignor payout · CON-2026-0001', source_consignment_id = NULL WHERE id = ?", [k.pid]);
  const backfill = MIGRATIONS.find((m) => m.includes('UPDATE purchases SET source_consignment_id'))!;
  db.run(backfill);
  ok(s(db, 'SELECT source_consignment_id FROM purchases WHERE id = ?', [k.pid]) === 'con-1', 'H B6 Bestand: Kommission aus dem Vermerk nachgetragen');
  // B7 — keine verschluckte Buchung mehr im Anlegen.
  ok(!/safePost/.test(src('src/stores/purchaseStore.ts')), 'H B7 createPurchase bucht strikt (kein safePost)');
  const nullKauf = imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: 'sup-1', purchaseDate: PDATE, lines: [{ productId: k.productId, quantity: 1, unitPrice: 0 }] }));
  ok(!posting.hasLedgerEntries('PURCHASE', nullKauf.id), 'H B7 ein Einkauf mit Summe 0 legt an, ohne zu buchen');
}

// ══ I — D10 Ausweisfoto, D13 Artikel, D14 Guthaben-Zahlung ═══════════════════════
{
  const db = freshDb();
  const k = kaufNeu({ price: 300 });
  // zwei fertige Medien: das alte Ausweisfoto (Einkauf) und das neue.
  for (const [mid, bid, hash] of [['m-alt', 'b-alt', 'a'.repeat(64)], ['m-neu', 'b-neu', 'b'.repeat(64)]]) {
    db.run(`INSERT INTO media_blobs (tenant_id, blob_id, dedup_token, current_generation_no, blob_status, created_at, updated_at) VALUES ('tenant-1',?,?,NULL,'pending',?,?)`, [bid, 'd-' + bid, NOW, NOW]);
    db.run(`INSERT INTO media_blob_generations (tenant_id, blob_id, generation_no, storage_key, stored_blob_hash, byte_size, content_kind, mime_type, extension, gen_status, created_at)
            VALUES ('tenant-1',?,1,?,?,1000,'raster_image','image/jpeg','jpg','available',?)`, [bid, `tenant-1/${hash.slice(0, 2)}/${hash}.jpg`, hash, NOW]);
    db.run(`UPDATE media_blobs SET current_generation_no = 1, blob_status = 'present' WHERE tenant_id = 'tenant-1' AND blob_id = ?`, [bid]);
    db.run(`INSERT INTO media_objects (tenant_id, media_id, origin_branch_id, master_blob_id, master_kind, source_type, security_class, ingest_status, created_at, updated_at)
            VALUES ('tenant-1',?, 'branch-main', ?, 'normalized', 'upload', 'sensitive', 'ready', ?, ?)`, [mid, bid, NOW, NOW]);
  }
  db.run(`UPDATE purchases SET supplier_snapshot = ? WHERE id = ?`, [JSON.stringify({ name: 'Lieferant A', snapshotAt: NOW, identity: {
    mediaId: 'm-alt', generationNo: 1, blobHash: 'a'.repeat(64), byteSize: 1000, storageKey: `tenant-1/aa/${'a'.repeat(64)}.jpg`, extension: 'jpg', ownerType: 'supplier', ownerId: 'sup-1' } }), k.pid]);
  const out = editIt(db, { purchaseId: k.pid, reason: 'Ausweis unscharf', identityPhoto: { mediaId: 'm-neu' } });
  ok(S(out.kinds) === S(['IDENTITY_PHOTO']), 'I Art IDENTITY_PHOTO');
  const snap = JSON.parse(s(db, 'SELECT supplier_snapshot FROM purchases WHERE id = ?', [k.pid]));
  ok(snap.identity?.mediaId === 'm-neu' && snap.identity.blobHash === 'b'.repeat(64), 'I der Einkauf zeigt nur noch das neue Foto');
  ok(snap.identityRetired?.length === 1 && snap.identityRetired[0].mediaId === 'm-alt' && snap.identityRetired[0].generationNo === 1,
    'I das alte Foto ist verborgen aufbewahrt (identityRetired, Fassung + Hash)');
  ok(!s(db, 'SELECT old_snapshot FROM purchase_edits WHERE purchase_id = ?', [k.pid]).includes('data:'), 'I keine Bildbytes im Protokoll');
  ok(src('src-tauri/src/media/reachability.rs').includes("'$.identityRetired'"), 'I Sicherung und Speicher halten die verborgene Fassung (REQUIRED)');
  ok(code(meldung(() => editIt(db, { purchaseId: k.pid, reason: 'x', identityPhoto: { mediaId: 'gibt-es-nicht' } }))) === 'IDENTITY_PHOTO_NOT_FOUND', 'I ein fehlendes Medium: Nein');
  // D13 — Einkaufspreis/-datum eines einkaufsgebundenen Artikels nur über Purchase → Edit.
  const pb = purchaseBoundRefusal(k.productId, [['purchase_price', 1]]);
  ok(pb?.code === 'PRODUCT_PURCHASE_BOUND', 'I D13 Artikelseite: Einkaufspreis gesperrt');
  ok(purchaseBoundRefusal(k.productId, [['planned_sale_price', 1]]) === null, 'I D13 Verkaufspreis bleibt frei');
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
            stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
          VALUES ('p-alt','branch-main','cat-w','Omega','Alt','SKU-ALT',1,'New','[]',100,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  ok(purchaseBoundRefusal('p-alt', [['purchase_price', 1]]) === null, 'I D13 unabhängiger Artikel: nicht gesperrt');
  ok(soldItemEditNeedsReason(k.productId, [['brand', 'X']]) === false, 'I D7 unverkauft: keine Begründung nötig');
  rechnung([LINE(k.productId, 1, 500, 'MARGIN')]);
  ok(soldItemEditNeedsReason(k.productId, [['brand', 'X']]) === true && soldItemEditNeedsReason(k.productId, [['notes', 'x']]) === false,
    'I D7 verkauft: Druckangaben nur mit Begründung, Notizen frei');
  // D14 — eine Guthaben-Zahlung stornieren gibt das Guthaben zurück.
  const k2 = kaufNeu({ price: 200 });
  db.run(`INSERT INTO supplier_credits (id, branch_id, supplier_id, amount, used_amount, status, created_at) VALUES ('sc1','branch-main','sup-1',300,0,'OPEN',?)`, [NOW]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(k2.pid, 200, CTX, rev(db, k2.pid)));
  reload();
  ok(n(db, "SELECT used_amount FROM supplier_credits WHERE id = 'sc1'") === 200, 'I D14 Guthaben 200 eingelöst');
  const credPay = s(db, "SELECT id FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'", [k2.pid]);
  const v = imHaus(() => edit.voidPurchasePaymentInHouse(k2.pid, credPay, 'falsch verrechnet', CTX, rev(db, k2.pid)));
  reload();
  ok(n(db, "SELECT used_amount FROM supplier_credits WHERE id = 'sc1'") === 0 && v.restoredCreditId === 'sc1', 'I D14 Storno: Guthaben zurückgegeben');
  ok(v.status === 'UNPAID' && v.remainingAmount === 200, `I D14 Einkauf wieder offen (${S(v)})`);
  invariant(db, 'I');
}

// ══ J — PC2: derselbe Befehl fern (Primary == PC2), alte Fassung, Rechte, Rollback, Wiederholung ═══
{
  const cmds = await import('../../src/core/bridge/purchase-edit-commands.ts');
  const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
  const perms = await import('../../src/core/bridge/command-permissions.ts');
  const { lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
  const deps = (db: Db) => ({
    db: db as never,
    begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    // Dieselbe Uhr wie der Primary-Vergleichslauf (echte Zeit) — mit dem festen NOW war J nur am 24.10.2026 grün.
    now: () => new Date().toISOString(),
  });
  type Aus = { ok: boolean; code: string; value: Record<string, unknown>; replayed: boolean };
  const fern = async (p: () => Promise<unknown>): Promise<Aus> => {
    try {
      const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
      return { ok: o.kind === 'ok', code: o.code ?? '', value: o.value ?? {}, replayed: o.replayed === true };
    } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? e), value: {}, replayed: false }; }
  };
  const primary = async (p: () => Promise<unknown>): Promise<Aus> => {
    try { return { ok: true, code: '', value: (await p() ?? {}) as Record<string, unknown>, replayed: false }; }
    catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? e), value: {}, replayed: false }; }
  };
  const all = (db: Db, sql: string, p: unknown[] = []): string => S(db.exec(sql, p)[0]?.values ?? []);
  /** Was eine Bearbeitung hinterlässt — ohne Kennungen, Zeiten und Urheber. */
  const bild = (db: Db, pid: string) => ({
    einkauf: all(db, 'SELECT total_amount, paid_amount, remaining_amount, status, revision FROM purchases WHERE id = ?', [pid]),
    lose: all(db, 'SELECT unit_cost, qty_total, qty_remaining, status FROM stock_lots WHERE purchase_id = ? ORDER BY unit_cost', [pid]),
    korrekturen: all(db, 'SELECT kind, quantity, old_unit_cost, new_unit_cost, amount, economic_date, booking_date, vat_status, ROUND(vat_estimate, 3), status FROM cost_corrections ORDER BY amount'),
    guthaben: all(db, 'SELECT amount, used_amount, status FROM supplier_credits ORDER BY amount'),
    artikel: all(db, 'SELECT purchase_price, planned_sale_price FROM products ORDER BY purchase_price'),
    protokoll: all(db, 'SELECT edit_no, reason, kinds, correction_kind FROM purchase_edits ORDER BY edit_no'),
    salden: all(db, `SELECT account, COALESCE(counterparty_id, ''), ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS net
                       FROM ledger_entries GROUP BY 1, 2 HAVING ABS(net) > 0.0005 ORDER BY 1, 2`),
  });
  const zaehler = (db: Db, pid: string) => S({
    ...bild(db, pid), l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), a: n(db, 'SELECT COUNT(*) FROM audit_log'),
    pe: n(db, 'SELECT COUNT(*) FROM purchase_edits'), log: n(db, 'SELECT COUNT(*) FROM sync_changelog'),
    num: all(db, 'SELECT doc_type, next_number FROM document_sequences ORDER BY doc_type'),
  });
  /** Die Welt: 2 × 550 bar bezahlt, ein Stück für 700 verkauft. */
  const welt = () => {
    const db = freshDb();
    const k = kaufNeu({ price: 550, qty: 2, paid: 1100 });
    rechnung([LINE(k.productId, 1, 700, 'MARGIN')]);
    return { db, ...k };
  };
  const rumpf = (w: { db: Db; pid: string; lineId: string }, over: Record<string, unknown> = {}) => ({
    purchaseId: w.pid, expectedRevision: rev(w.db, w.pid), reason: 'Preis falsch erfasst',
    lines: [{ lineId: w.lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR', ...over,
  });

  // (1) Parität: dieselbe Berichtigung am Primary und fern hinterlässt dasselbe.
  const wP = welt();
  const p = await primary(() => purchaseHouse.editPurchaseOnPrimary(wP.pid,
    { reason: 'Preis falsch erfasst', lines: [{ lineId: wP.lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' }, rev(wP.db, wP.pid)));
  const bP = bild(wP.db, wP.pid);
  const wR = welt();
  const r = await fern(() => cmds.runPurchaseEdit(deps(wR.db), identity('901', 'purchases.correct'), rumpf(wR), true));
  const bR = bild(wR.db, wR.pid);
  ok(p.ok && r.ok, `J beide Wege speichern (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = (Object.keys(bP) as Array<keyof typeof bP>).filter((key) => bP[key] !== bR[key]).map((key) => `${key}: ${bP[key]} vs ${bR[key]}`);
  ok(diff.length === 0, `J Primary == PC2: Einkauf, Lose, Korrektur, Guthaben, Artikel, Protokoll, Salden (${diff.join(' · ') || 'gleich'})`);
  ok(bR.korrekturen.includes('-50') && bR.guthaben === S([[100, 0, 'OPEN']]), `J fern: Korrektur −50 und Überzahlung 100 als Guthaben (${bR.korrekturen} / ${bR.guthaben})`);
  ok(s(wR.db, 'SELECT edited_by FROM purchase_edits') === 'user-pc2' && s(wP.db, 'SELECT edited_by FROM purchase_edits') === 'user-test',
    'J das Protokoll nennt den, der bearbeitet hat (PC2-Absender / Primary-Anmeldung)');
  invariant(wR.db, 'J fern');

  // (2) Wiederholung desselben Auftrags: gespeicherte Antwort, keine zweite Wirkung.
  const vorWdh = zaehler(wR.db, wR.pid);
  const r2 = await fern(() => cmds.runPurchaseEdit(deps(wR.db), identity('901', 'purchases.correct'), rumpf(wR, { expectedRevision: Number(r.value.revision) - 1 }), true));
  ok(r2.ok && r2.replayed && zaehler(wR.db, wR.pid) === vorWdh, `J Wiederholung: Antwort aus dem Auftragsbuch, nichts doppelt (${r2.code || 'replayed'})`);

  // (3) Alte Fassung: ein zweiter Auftrag mit der vorigen Fassung → Nein, nichts geändert.
  const vorAlt = zaehler(wR.db, wR.pid);
  const alt = await fern(() => cmds.runPurchaseEdit(deps(wR.db), identity('902', 'purchases.correct'),
    rumpf(wR, { expectedRevision: rev(wR.db, wR.pid) - 1, lines: [{ lineId: wR.lineId, unitPrice: 450 }] }), true));
  ok(!alt.ok && alt.code === 'RECORD_CHANGED' && zaehler(wR.db, wR.pid) === vorAlt, `J alte Fassung: RECORD_CHANGED, nichts geändert (${alt.code})`);
  const altVoid = await fern(() => cmds.runPurchaseVoidPayment(deps(wR.db), identity('903', 'purchases.void_payment'), {
    purchaseId: wR.pid, paymentId: s(wR.db, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [wR.pid]), expectedRevision: rev(wR.db, wR.pid) - 1, reason: 'x',
  }));
  ok(!altVoid.ok && altVoid.code === 'RECORD_CHANGED' && zaehler(wR.db, wR.pid) === vorAlt, `J alte Fassung beim Zahlungsstorno: Nein, nichts geändert (${altVoid.code})`);

  // (4) Rechte und Rumpf: Geld nur Owner; `purchases.update` nimmt keine Geldfelder an.
  ok(perms.roleMayRunOp('ADMIN', 'purchases.correct') && !perms.roleMayRunOp('SALES', 'purchases.correct') && !perms.roleMayRunOp('MANAGER', 'purchases.correct'),
    'J purchases.correct nur Owner');
  ok(perms.roleMayRunOp('SALES', 'purchases.update') && !perms.roleMayRunOp('SALES', 'purchases.void_payment'), 'J purchases.update unter den Einkaufsrechten, void_payment nur Owner');
  ok(/unknown field|not allowed|primary decides/i.test(meldung(() => cmds.parsePurchaseEdit(rumpf(wR), false))), 'J purchases.update mit Preiszeilen: Rumpf abgewiesen');
  ok(/expectedRevision/i.test(meldung(() => { const { expectedRevision: _x, ...b } = rumpf(wR); cmds.parsePurchaseEdit(b, true); })), 'J ohne Fassung: Rumpf abgewiesen');
  ok(meldung(() => cmds.parsePurchaseEdit({ ...rumpf(wR), totalAmount: 1 }, true)) !== '', 'J eine Summe bestimmt der Primary, nicht der Rumpf');

  // (5) Rollback: das Protokoll scheitert als letzter Schritt — Buchungen, Lose, Korrektur, Guthaben bleiben unberührt.
  for (const weg of ['primary', 'fern'] as const) {
    const w = welt();
    const vor = zaehler(w.db, w.pid);
    w.db.run("CREATE TRIGGER pe_bruch BEFORE INSERT ON purchase_edits BEGIN SELECT RAISE(ABORT, 'PE: injected'); END");
    const x = weg === 'primary' ? '' : '911';
    const aus = weg === 'primary'
      ? await primary(() => purchaseHouse.editPurchaseOnPrimary(w.pid,
        { reason: 'Preis falsch erfasst', lines: [{ lineId: w.lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' }, rev(w.db, w.pid)))
      : await fern(() => cmds.runPurchaseEdit(deps(w.db), identity(x, 'purchases.correct'), rumpf(w), true));
    setTestDatabase(w.db as never);
    ok(!aus.ok && zaehler(w.db, w.pid) === vor, `J Rollback ${weg}: nichts geschrieben (${aus.code.slice(0, 60)})`);
    if (weg === 'fern') ok(lookupCommand(w.db as never, identity(x, 'purchases.correct') as never).kind === 'fresh', 'J Rollback fern: die Kennung bleibt frei');
    w.db.run('DROP TRIGGER pe_bruch');
    const heil = weg === 'primary'
      ? await primary(() => purchaseHouse.editPurchaseOnPrimary(w.pid,
        { reason: 'Preis falsch erfasst', lines: [{ lineId: w.lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' }, rev(w.db, w.pid)))
      : await fern(() => cmds.runPurchaseEdit(deps(w.db), identity(x, 'purchases.correct'), rumpf(w), true));
    ok(heil.ok && n(w.db, "SELECT COUNT(*) FROM cost_corrections WHERE status = 'ACTIVE'") === 1, `J Rollback ${weg}: danach gelingt es genau einmal (${heil.code || 'ok'})`);
    invariant(w.db, `J Rollback ${weg}`);
  }

  // (6) Zahlungsstorno fern: gegengebucht, Zeile bleibt, Überzahlungs-Guthaben folgt.
  const vPay = s(wR.db, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [wR.pid]);
  const vd = await fern(() => cmds.runPurchaseVoidPayment(deps(wR.db), identity('921', 'purchases.void_payment'), {
    purchaseId: wR.pid, paymentId: vPay, expectedRevision: rev(wR.db, wR.pid), reason: 'Betrag falsch',
  }));
  setTestDatabase(wR.db as never);
  ok(vd.ok && s(wR.db, 'SELECT void_reason FROM purchase_payments WHERE id = ?', [vPay]) === 'Betrag falsch'
    && all(wR.db, 'SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [wR.pid]) === S([[1000, 0, 1000, 'UNPAID']])
    && n(wR.db, "SELECT COALESCE(SUM(amount - used_amount), 0) FROM supplier_credits WHERE status = 'OPEN'") === 0,
  `J Zahlungsstorno fern: Zeile storniert, Einkauf offen 1000, kein Überzahlungs-Guthaben mehr (${vd.code || 'ok'})`);
  ok(apOf(wR.db, 'sup-1') === 1000 && balance(wR.db, 'CASH') === 0, `J Hauptbuch: AP 1000, die stornierte Barzahlung ist aus der Kasse heraus (${apOf(wR.db, 'sup-1')} / ${balance(wR.db, 'CASH')})`);
  invariant(wR.db, 'J nach Zahlungsstorno');
}

// ══ K — D13: derselbe Artikel zweimal eingekauft — nur das betroffene Los ═══════════
{
  const db = freshDb();
  const k1 = kaufNeu({ price: 550 });
  const p2 = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: 'sup-2', purchaseDate: SDATE, lines: [{ productId: k1.productId, quantity: 1, unitPrice: 600 }],
  }));
  reload();
  const l2 = p2.lines[0].id;
  ok(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [k1.productId]) === 550, 'K der zweite Einkauf ändert den Artikelpreis nicht (Ausgang)');
  const chk2 = edit.purchaseEditCheck(p2.id, 'branch-main', NOW);
  const chk1 = edit.purchaseEditCheck(k1.pid, 'branch-main', NOW);
  ok(chk2.lines[0].productFollows === false && chk1.lines[0].productFollows === true, 'K nur die anlegende Zeile führt den Artikelpreis');
  editIt(db, { purchaseId: p2.id, reason: 'zweiter Kauf falsch', lines: [{ lineId: l2, unitPrice: 580 }], correctionKind: 'ENTRY_ERROR' });
  ok(unitCost(db, lotOfLine(db, l2)) === 580 && unitCost(db, lotOfLine(db, k1.lineId)) === 550 && n(db, 'SELECT purchase_price FROM products WHERE id = ?', [k1.productId]) === 550,
    'K zweiter Einkauf berichtigt: nur sein Los 600 → 580; erstes Los und Artikelpreis bleiben 550');
  editIt(db, { purchaseId: k1.pid, reason: 'erster Kauf falsch', lines: [{ lineId: k1.lineId, unitPrice: 540 }], correctionKind: 'ENTRY_ERROR' });
  ok(unitCost(db, lotOfLine(db, k1.lineId)) === 540 && unitCost(db, lotOfLine(db, l2)) === 580 && n(db, 'SELECT purchase_price FROM products WHERE id = ?', [k1.productId]) === 540,
    'K erster Einkauf berichtigt: sein Los 540, der Artikelpreis folgt (540), das zweite Los bleibt 580');
  ok(n(db, 'SELECT planned_sale_price FROM products WHERE id = ?', [k1.productId]) === 900, 'K der Verkaufspreis bleibt (900)');
  ok(useProductStore.getState().products.find((x) => x.id === k1.productId)?.purchasePrice === 540, 'K Collections (Store) zeigt denselben Artikel mit 540 — keine Kopie');
  invariant(db, 'K');
}

// ══ L — D7/D13 an der Artikelseite: Grund, Einfrieren der Rechnungsangaben, gebundener Einkaufspreis ═══
{
  const db = freshDb();
  const k = kaufNeu({ price: 400, qty: 2 });
  const inv = rechnung([LINE(k.productId, 1, 600, 'MARGIN')]);
  const ilId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const ps = useProductStore.getState();
  const ohneGrund = await ps.editProductTextDurably(k.productId, { brand: 'Omega' });
  ok(ohneGrund.status === 'blocked' && (ohneGrund as { errorCode?: string }).errorCode === 'PRODUCT_EDIT_REASON_REQUIRED'
    && s(db, 'SELECT brand FROM products WHERE id = ?', [k.productId]) === 'Rolex', `L verkaufter Artikel ohne Grund: Nein, nichts geändert (${S(ohneGrund)})`);
  const preis = await ps.editProductTextDurably(k.productId, { purchasePrice: 1 }, { editReason: 'x' });
  ok(preis.status === 'blocked' && n(db, 'SELECT purchase_price FROM products WHERE id = ?', [k.productId]) === 400,
    `L D13 Einkaufspreis an der Artikelseite gesperrt (${S(preis)})`);
  const mitGrund = await ps.editProductTextDurably(k.productId, { brand: 'Omega' }, { editReason: 'Marke falsch erfasst' });
  reload();
  const snap = JSON.parse(s(db, 'SELECT product_snapshot FROM invoice_lines WHERE id = ?', [ilId]) || 'null');
  ok(mitGrund.status === 'edited' && s(db, 'SELECT brand FROM products WHERE id = ?', [k.productId]) === 'Omega'
    && snap?.brand === 'Rolex' && snap?.name === 'Submariner', `L mit Grund: Artikel geändert, die Rechnungszeile behält „Rolex Submariner" (${S(snap)})`);
  const audit = s(db, "SELECT new_value FROM audit_log WHERE entity_type = 'products' AND entity_id = ? ORDER BY rowid DESC LIMIT 1", [k.productId]);
  ok(audit.includes('Marke falsch erfasst'), 'L der Grund steht im Protokoll');
  await ps.editProductTextDurably(k.productId, { brand: 'Cartier' }, { editReason: 'nochmal' });
  ok(JSON.parse(s(db, 'SELECT product_snapshot FROM invoice_lines WHERE id = ?', [ilId])).brand === 'Rolex', 'L eine zweite Änderung überschreibt den eingefrorenen Stand nicht');
  ok(useInvoiceStore.getState().getInvoice(inv)?.lines[0].productSnapshot?.brand === 'Rolex', 'L die Rechnung (Store/Nachdruck) liest den eingefrorenen Stand');
  ok(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) === 600, 'L Betrag und Inhalt der Rechnung unverändert');
  // Purchase → Edit → „Edit item": Modell, Merkmale (Gewicht, Karat, Steine), Zustand, Beschreibung am SELBEN Artikel.
  const stones = [{ type: 'Diamond', count: 3, weight: 0.45 }];
  const voll = await ps.editProductTextDurably(k.productId, {
    name: 'Submariner Date', condition: 'Pre-Owned', notes: 'Kratzer an der Lünette',
    attributes: { weight: 12.5, karat: '18K Yellow', stones } as never,
  }, { editReason: 'Angaben ergänzt' });
  reload();
  const row = db.exec('SELECT name, condition, notes, attributes FROM products WHERE id = ?', [k.productId])[0].values[0];
  const attrs = JSON.parse(String(row[3]));
  ok(voll.status === 'edited' && row[0] === 'Submariner Date' && row[1] === 'Pre-Owned' && row[2] === 'Kratzer an der Lünette'
    && attrs.weight === 12.5 && attrs.karat === '18K Yellow' && S(attrs.stones) === S(stones),
  `L Modell, Zustand, Beschreibung, Gewicht, Karat, Steine gespeichert (${S(voll)} / ${S(row)})`);
  const inColl = useProductStore.getState().products.filter((x) => x.id === k.productId);
  ok(inColl.length === 1 && inColl[0].name === 'Submariner Date' && inColl[0].condition === 'Pre-Owned'
    && (inColl[0].attributes as Record<string, unknown>).karat === '18K Yellow' && inColl[0].brand === 'Cartier',
  'L Collections (Store) zeigt genau diesen einen Artikel mit allen Änderungen — keine Kopie');
  ok(n(db, 'SELECT purchase_price FROM products WHERE id = ?', [k.productId]) === 400 && n(db, 'SELECT COUNT(*) FROM products') === 1,
    'L Einkaufspreis unberührt, kein zweiter Artikel entstanden');
}

// ══ M — B6 Altbestand: Kommissions-Einkäufe von vor der Spalte (Sonderfälle) ═══════════
{
  const { consignorPurchases } = await import('../../src/core/consignment/consignment-reversal-house.ts');
  const nachtrag = MIGRATIONS.find((m) => m.includes('UPDATE purchases SET source_consignment_id'))!;
  /** Was der Leser VOR Phase 2 fand: nur der Vermerk + Artikel der Zeile. */
  const alterLeser = (db: Db, nummer: string, productId: string): string[] =>
    (db.exec(`SELECT p.id FROM purchases p WHERE p.branch_id = 'branch-main' AND p.status != 'CANCELLED' AND p.notes LIKE ?
                AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.product_id = ?) ORDER BY p.created_at, p.id`,
    [`%${nummer}%`, productId])[0]?.values ?? []).map((v) => String(v[0]));
  const db = freshDb();
  // Derselbe Artikel zweimal in Kommission (alte Nummern ohne Nullen: CON-1 und CON-10) + eine dritte ohne Gegenstück.
  const a = kaufNeu({ price: 300 });
  const b = imHaus(() => usePurchaseStore.getState().createPurchase({ supplierId: 'sup-1', purchaseDate: PDATE, lines: [{ productId: a.productId, quantity: 1, unitPrice: 350 }] }));
  const c = kaufNeu({ price: 200 });
  reload();
  for (const [id, nr, pid] of [['con-1', 'CON-1', a.productId], ['con-10', 'CON-10', a.productId]] as const) {
    db.run(`INSERT INTO consignments (id, branch_id, consignment_number, consignor_id, product_id, agreed_price, commission_rate, status, agreement_date, created_at, updated_at)
            VALUES (?,'branch-main',?,'cust-1',?,500,15,'sold',?,?,?)`, [id, nr, pid, PDATE, NOW, NOW]);
  }
  db.run("UPDATE purchases SET notes = 'Consignor payout · CON-1', source_consignment_id = NULL WHERE id = ?", [a.pid]);
  db.run("UPDATE purchases SET notes = 'Consignor payout · CON-10 · bar', source_consignment_id = NULL WHERE id = ?", [b.id]);
  db.run("UPDATE purchases SET notes = 'Consignor payout · CON-77', source_consignment_id = NULL WHERE id = ?", [c.pid]);
  const vorher = { con1: alterLeser(db, 'CON-1', a.productId), con10: alterLeser(db, 'CON-10', a.productId) };
  ok(vorher.con1.length === 2 && vorher.con10.length === 1, `M Ausgang: der alte Leser findet für CON-1 auch den Einkauf von CON-10 (bekannter Fehltreffer) (${S(vorher)})`);
  // Vor dem Nachtrag (Spalte leer) liefert der neue Leser genau, was der alte lieferte — nichts geht verloren.
  ok(S(consignorPurchases('con-1', 'CON-1', a.productId, 'branch-main')) === S(vorher.con1)
    && S(consignorPurchases('con-10', 'CON-10', a.productId, 'branch-main')) === S(vorher.con10),
  'M ohne Nachtrag: neuer Leser == alter Leser (Vermerk als Rückfall)');
  db.run(nachtrag);
  ok(s(db, 'SELECT source_consignment_id FROM purchases WHERE id = ?', [a.pid]) === 'con-1'
    && s(db, 'SELECT source_consignment_id FROM purchases WHERE id = ?', [b.id]) === 'con-10',
  'M Nachtrag: CON-1 → con-1, CON-10 → con-10 (längste passende Nummer, gleicher Artikel)');
  ok(s(db, "SELECT COALESCE(source_consignment_id, '-') FROM purchases WHERE id = ?", [c.pid]) === '-',
    'M ohne passende Kommission (CON-77): die Spalte bleibt leer — nichts geraten');
  ok(S(consignorPurchases('con-1', 'CON-1', a.productId, 'branch-main')) === S([a.pid])
    && S(consignorPurchases('con-10', 'CON-10', a.productId, 'branch-main')) === S([b.id]),
  'M nach dem Nachtrag: jede Kommission findet genau ihren Einkauf (der Fehltreffer ist weg, keiner fehlt)');
  // Sperren: wer nur am Vermerk hängt, bleibt Kommission (Geld UND Notiz gesperrt, damit der Rückfall nicht bricht).
  const ck = edit.purchaseEditCheck(c.pid, 'branch-main', NOW);
  ok(!ck.notes.allowed && ck.notes.code === 'PURCHASE_EDIT_CONSIGNMENT_NOTE' && !ck.date.allowed && !ck.lines[0].price.allowed,
    `M nur Vermerk: Notiz, Datum, Preis gesperrt (${S([ck.notes, ck.date, ck.lines[0].price])})`);
  ok(code(meldung(() => editIt(db, { purchaseId: c.pid, reason: 'x', notes: 'weg damit' }))) === 'PURCHASE_EDIT_CONSIGNMENT_NOTE'
    && s(db, 'SELECT notes FROM purchases WHERE id = ?', [c.pid]) === 'Consignor payout · CON-77', 'M …und die Hausfolge lässt den Vermerk wirklich stehen');
  ok(!edit.purchaseEditCheck(a.pid, 'branch-main', NOW).lines[0].price.allowed, 'M mit Spalte: weiter Kommission, Geld gesperrt');
}

// ══ N — D1-B: Verkauf Monat A (Okt 2026, Quartal eingereicht), Korrektur Monat B (Jan 2027) ═══════════
{
  const { liveVatQuarters, nbrInvoicesFromDb } = await import('../../src/core/tax/vat-quarter-overview.ts');
  const { nbrMonthTotals } = await import('../../src/core/tax/nbr-export.ts');
  const db = freshDb();
  const k = kaufNeu({ price: 550, paid: 550 });
  const inv = rechnung([LINE(k.productId, 1, 700, 'MARGIN')]);
  voll(db, inv);                                  // FINAL → im NBR-Export (Monat der Vollzahlung)
  const nbrInput = (): string => { const x = nbrInvoicesFromDb('branch-main', 'FINAL'); return S([x.invoices, [...x.payments.entries()]]); };
  const nbrTotals = (): string => { const x = nbrInvoicesFromDb('branch-main', 'FINAL'); return S(nbrMonthTotals(x.invoices, x.payments)); };
  const q4Vorher = S(liveVatQuarters('branch-main').get('2026-Q4'));
  ok(JSON.parse(q4Vorher)?.invoiceCount === 1 && eq(JSON.parse(q4Vorher).marginVat, 13.636), `N Ausgang: Q4 2026 trägt die Rechnung, Margen-VAT 13,636 (${q4Vorher})`);
  db.run(`INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, filed_by, invoice_count, snapshot_json, created_at)
          VALUES ('vf-q4','branch-main',2026,4,?, 'user-test', 1, ?, ?)`, [NOW, q4Vorher, NOW]);
  const vorher = {
    nbr: nbrInput(), totals: nbrTotals(), fp: S(vatFingerprint(inv)), filing: S(db.exec("SELECT * FROM vat_filings")[0].values),
    oktLedger: S(db.exec(`SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries WHERE occurred_at < '2026-11-01' GROUP BY 1, 2 ORDER BY 1, 2`)[0].values),
  };
  const okt = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };
  const jan = { from: '2027-01-01T00:00:00.000Z', to: '2027-01-31T23:59:59.999Z' };
  ok(eq(computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, [], okt).profit, 150), 'N Oktober vorher: Gewinn 150');

  // Die Korrektur am 10.01.2027 (Monat B, neues Quartal): Einkaufspreis war falsch erfasst, 550 → 500.
  const ctxJan = { ...CTX, now: '2027-01-10T10:00:00.000Z' };
  const out = editIt(db, { purchaseId: k.pid, reason: 'Einkaufspreis falsch erfasst', lines: [{ lineId: k.lineId, unitPrice: 500 }], correctionKind: 'ENTRY_ERROR' }, ctxJan);
  ok(out.corrections.length === 1 && eq(out.corrections[0].amount, -50) && out.corrections[0].economicDate === SDATE,
    `N eine Korrektur −50, wirtschaftlich am Verkaufstag (${S(out.corrections)})`);
  const cc = db.exec('SELECT booking_date, economic_date, vat_status, ROUND(vat_estimate, 3) FROM cost_corrections')[0].values[0];
  ok(S(cc) === S(['2027-01-10', SDATE, 'REVIEW', 4.545]), `N zwei Daten: gebucht 10.01.2027, zugeordnet ${SDATE}; VAT nur gekennzeichnet (${S(cc)})`);

  // Gewinn: Monat A trägt die Korrektur, Monat B nicht.
  ok(eq(computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, [], okt).profit, 200), 'N Oktober nachher: Gewinn 200 (Monat A)');
  ok(eq(computeSalesMetrics(loadSalesData({ branchId: 'branch-main' }).invoices, [], jan).profit, 0), 'N Januar: kein zusätzlicher Gewinn (+50 nicht doppelt)');

  // Hauptbuch: der Oktober bleibt Buchstabe für Buchstabe; die Korrektur steht im Januar, ohne VAT-Konto.
  ok(S(db.exec(`SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries WHERE occurred_at < '2026-11-01' GROUP BY 1, 2 ORDER BY 1, 2`)[0].values) === vorher.oktLedger,
    'N Hauptbuch Oktober unverändert (nichts zurückdatiert — auch das Überzahlungs-Guthaben steht am Korrekturtag)');
  ok(S(db.exec("SELECT DISTINCT substr(occurred_at, 1, 7) FROM ledger_entries WHERE source_module = 'PURCHASE_OVERPAY'")[0].values) === S([['2027-01']]),
    'N die Überzahlung (Lieferantenguthaben 50) ist im Januar gebucht');
  ok(S(db.exec("SELECT DISTINCT substr(occurred_at, 1, 7) FROM ledger_entries WHERE source_module = 'COST_CORRECTION'")[0].values) === S([['2027-01']])
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'COST_CORRECTION' AND account LIKE 'VAT%'") === 0,
  'N die Korrektur ist im Januar gebucht und berührt kein VAT-Konto');

  // Eingereichtes Quartal: Export-Grundlage, Summen, Fingerabdruck, Einreichung — alles wie vorher.
  ok(nbrInput() === vorher.nbr, 'N NBR-Export: dieselbe Grundlage (Rechnungen, Zeilen, Zahlungen)');
  ok(nbrTotals() === vorher.totals && S(liveVatQuarters('branch-main').get('2026-Q4')) === q4Vorher, 'N NBR-Export: dieselben Monats- und Q4-Summen');
  ok(!liveVatQuarters('branch-main').has('2027-Q1'), 'N in Q1 2027 entsteht keine VAT-Zeile (keine automatische Übertragung)');
  ok(S(vatFingerprint(inv)) === vorher.fp && S(db.exec('SELECT * FROM vat_filings')[0].values) === vorher.filing,
    'N VAT-Fingerabdruck der Rechnung und die Einreichung unverändert');

  // Überleitung: Januar gebucht −50, Oktober zugeordnet −50, Summe 0 — und sie behauptet keine Vollabstimmung.
  const br = costCorrectionBridge('branch-main');
  const m = (x: string) => br.find((r) => r.month === x);
  ok(eq(m('2026-10')?.booked ?? 99, 0) && eq(m('2026-10')?.attributed ?? 99, -50) && eq(m('2027-01')?.booked ?? 99, -50) && eq(m('2027-01')?.attributed ?? 99, 0)
    && eq(br.reduce((a, r) => a + r.difference, 0), 0), `N Überleitung: Okt zugeordnet −50, Jan gebucht −50, Summe 0 (${S(br)})`);
  const card = src('src/components/finance/CostCorrectionsCard.tsx');
  ok(/nur Einstandskorrekturen/.test(card) && /keine vollständige Abstimmung von Hauptbuch und Gewinnbericht/.test(card),
    'N die Karte sagt ausdrücklich: nur Einstandskorrekturen, keine Vollabstimmung');
  invariant(db, 'N');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — purchase edit phase 2: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

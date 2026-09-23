// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S2 — Rechnung bearbeiten trotz Retoure: Zeilen behalten ihre ID, Grenzen nur dort,
// wo eine Retoure oder Gutschrift sie braucht. Echte sql.js-Datenbank (Harness wie stock-lot-integrity).
// Run: node --experimental-strip-types test/invoice-edit/edit-with-returns.test.ts
//
//   1 Preis am nicht retournierten Artikel · 2 Artikel hinzu/weg · 3 Menge über der Retourenmenge
//   4/5/6 Menge darunter, Preis, Artikelwechsel/Entfernen der retournierten Zeile → gezieltes Nein
//   7 Retoure NACH Edits: Wareneinsatz einmal · 8 Rollback · 9 Gutschriften-Deckel
//   10 PC2: endgültige Absagen · 11 per Retoure erledigte Rechnung (RETURNED) + Guthaben
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
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}

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

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const OWNER_ACTOR = { userId: 'user-test', role: 'ADMIN' };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
const { runInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const {
  EDIT_LINE_HAS_RETURN, EDIT_BELOW_RETURNED_QTY, EDIT_RETURNED_LINE_PRICE_LOCKED, EDIT_BELOW_CREDIT_NOTES,
} = await import('../../src/core/invoices/edit-lines.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus;

const lineId = (db: Db, inv: string, pid: string): string =>
  s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ? ORDER BY position LIMIT 1', [inv, pid]);
const lineIds = (db: Db, inv: string): string => all(db, 'SELECT id, product_id FROM invoice_lines WHERE invoice_id = ? ORDER BY id', [inv]);
const lotRest = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const qty = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
const nummer = (db: Db, inv: string): string => s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv]);
const status = (db: Db, inv: string): string => s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]);
const zahlungen = (db: Db, inv: string): string => all(db, 'SELECT id, amount, method FROM payments WHERE invoice_id = ? ORDER BY id', [inv]);
/** Wareneinsatz einer Rechnungszeile netto (Verkauf minus Retouren-Rückbuchung), aus dem Hauptbuch. */
const cogsNetto = (db: Db, lid: string): number => n(db,
  "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'COGS' AND source_line_id = ?", [lid]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
const forderung = (db: Db, cust: string): number => n(db,
  "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?", [cust]);
/** Was ein abgelehnter Vorgang nicht verändern darf. */
function zustand(db: Db): string {
  return S({
    inv: all(db, 'SELECT * FROM invoices ORDER BY id'),
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    pay: all(db, 'SELECT * FROM payments ORDER BY id'),
    lots: all(db, 'SELECT id, qty_remaining, status FROM stock_lots ORDER BY id'),
    prod: all(db, 'SELECT id, quantity, stock_status FROM products ORDER BY id'),
    le: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    srl: all(db, 'SELECT * FROM sales_return_lines ORDER BY id'),
    cn: all(db, 'SELECT id, total_amount, status FROM credit_notes ORDER BY id'),
    cc: all(db, 'SELECT id, amount, source_type FROM customer_credits ORDER BY id'),
    edits: n(db, 'SELECT COUNT(*) FROM invoice_edits'),
  });
}
function aendern(inv: string, lines: Array<ReturnType<typeof LINE>>): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { lines: lines as never, reason: 'S2 Test' } as never)));
  reload();
  return m;
}
function retoure(db: Db, inv: string, pid: string, menge: number, preisBrutto: number, vat: number): string {
  const lid = lineId(db, inv, pid);
  const rid = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'S2',
      lines: [{ invoiceLineId: lid, productId: pid, quantity: menge, unitPrice: preisBrutto, vatAmount: vat }],
    } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
    return id;
  });
  reload();
  return rid;
}
const retourKosten = (db: Db, rid: string): number => n(db,
  "SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE source_module = 'SALES_RETURN_COGS' AND source_id = ? AND account = 'COGS' AND direction = 'CREDIT'", [rid]);

// ══ Welt: bezahlte Rechnung mit zwei Artikeln, einer davon teilweise retourniert ═════════════
const db = neu();
product(db, 'pA', 5);           // mit Einkaufslos (5 Stück à 100)
product(db, 'pB', null, 5);     // ohne Los
product(db, 'pC', null, 2);
product(db, 'pD', null, 2);
reload();
const inv = rechnung([LINE('pA', 3, 1000), LINE('pB', 1, 500)]);
voll(inv);
const NR = nummer(db, inv);
const A = lineId(db, inv, 'pA'), B = lineId(db, inv, 'pB');
const r1 = retoure(db, inv, 'pA', 1, 1100, 100);
ok(/^INV-/.test(NR) && lotRest(db, 'lot-pA') === 3 && qty(db, 'pB') === 4,
  `SETUP bezahlt ${NR}, 1 von 3 A retourniert (Los ${lotRest(db, 'lot-pA')}), B 5→4`);
ok(n(db, "SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'", [inv]) === 1,
  'SETUP …die Retoure hat eine Gutschrift');
const PAY = zahlungen(db, inv);

// ── 1) Preis am NICHT retournierten Artikel: erlaubt ────────────────────────────────────────
{
  const m = aendern(inv, [LINE('pA', 3, 1000), LINE('pB', 1, 600)]);
  ok(m === '', `1 Preis B 500 → 600 trotz Retoure auf A: erlaubt (${m})`);
  ok(lineId(db, inv, 'pA') === A && lineId(db, inv, 'pB') === B, '1 …beide Zeilen behalten ihre ID');
  ok(s(db, 'SELECT invoice_line_id FROM sales_return_lines WHERE return_id = ?', [r1]) === A,
    '1 …die Retourenzeile zeigt weiter auf die Zeile A');
  ok(nummer(db, inv) === NR && zahlungen(db, inv) === PAY, '1 …Nummer und Zahlungen unverändert');
  ok(lotRest(db, 'lot-pA') === 3 && qty(db, 'pB') === 4, `1 …Bestand unverändert (Los A ${lotRest(db, 'lot-pA')}, B ${qty(db, 'pB')})`);
  ok(Math.abs(cogsNetto(db, A) - 200) < 0.005, `1 …Wareneinsatz A netto 3×100 − 1×100 = 200 (${cogsNetto(db, A)})`);
  ok(status(db, inv) === 'PARTIAL' && ausgeglichen(db), `1 …Erhöhung: PARTIAL, Hauptbuch ausgeglichen (${status(db, inv)})`);
}

// ── 2) Artikel hinzufügen und wieder entfernen ────────────────────────────────────────────
{
  let m = aendern(inv, [LINE('pA', 3, 1000), LINE('pB', 1, 600), LINE('pC', 1, 200)]);
  const C = lineId(db, inv, 'pC');
  ok(m === '' && !!C && qty(db, 'pC') === 1 && lineId(db, inv, 'pA') === A && lineId(db, inv, 'pB') === B,
    `2 Artikel C hinzugefügt: neue Zeile, C 2→1, A/B behalten ihre ID (${m})`);
  m = aendern(inv, [LINE('pA', 3, 1000), LINE('pB', 1, 600)]);
  ok(m === '' && !lineId(db, inv, 'pC') && qty(db, 'pC') === 2 && n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE id = ?', [C]) === 0,
    `2 C wieder entfernt: Zeile gelöscht, Bestand 1→2 (${m})`);
}

// ── 3) Menge der retournierten Zeile ÜBER der Retourenmenge ändern ────────────────────────
{
  const m = aendern(inv, [LINE('pA', 4, 1000), LINE('pB', 1, 600)]);
  ok(m === '' && lotRest(db, 'lot-pA') === 2 && lineId(db, inv, 'pA') === A,
    `3 Menge A 3 → 4: erlaubt, Los 3→2, dieselbe Zeile (${m})`);
  ok(n(db, 'SELECT stock_taken FROM invoice_lines WHERE id = ?', [A]) === 4, '3 …Zeile A hat jetzt 4 genommen');
  ok(Math.abs(cogsNetto(db, A) - 300) < 0.005, `3 …Wareneinsatz A netto 4×100 − 1×100 = 300 (${cogsNetto(db, A)})`);
}

// ── 4/5/6) Gezielte Neins — jedes lässt ALLES unverändert ─────────────────────────────────
retoure(db, inv, 'pA', 1, 1100, 100);   // jetzt 2 von 4 zurück
ok(lotRest(db, 'lot-pA') === 3, `SETUP zweite Retoure A: 2 von 4 zurück, Los ${lotRest(db, 'lot-pA')}`);
for (const [name, lines, code] of [
  ['4 Menge A unter die Retourenmenge (4 → 1, zurück sind 2)', [LINE('pA', 1, 1000), LINE('pB', 1, 600)], EDIT_BELOW_RETURNED_QTY],
  ['5 Preis der retournierten Zeile A (1000 → 1200)', [LINE('pA', 4, 1200), LINE('pB', 1, 600)], EDIT_RETURNED_LINE_PRICE_LOCKED],
  ['6 Artikelwechsel der retournierten Zeile (A → D)', [LINE('pD', 4, 1000), LINE('pB', 1, 600)], EDIT_LINE_HAS_RETURN],
  ['6 Entfernen der retournierten Zeile A', [LINE('pB', 1, 600)], EDIT_LINE_HAS_RETURN],
] as Array<[string, Array<ReturnType<typeof LINE>>, string]>) {
  const vor = zustand(db);
  const m = aendern(inv, lines);
  ok(m.startsWith(code + '|') && zustand(db) === vor, `${name}: abgewiesen (${code}), nichts geändert — „${m.split('|')[1]?.slice(0, 90)}"`);
  ok(!/INVOICE_|_QTY|LOCKED|\bcode\b/.test(m.split('|')[1] ?? ''), `${name}: …die Meldung trägt keinen Fehlercode`);
}
// Die Menge genau AUF der Retourenmenge ist erlaubt.
{
  const m = aendern(inv, [LINE('pA', 2, 1000), LINE('pB', 1, 600)]);
  ok(m === '' && lotRest(db, 'lot-pA') === 5 && n(db, 'SELECT quantity FROM invoice_lines WHERE id = ?', [A]) === 2,
    `4b Menge A auf genau die Retourenmenge 2: erlaubt, Los 3→5 (${m})`);
  aendern(inv, [LINE('pA', 4, 1000), LINE('pB', 1, 600)]);
}

// ── 7) Eine Retoure NACH den Edits bucht den Wareneinsatz einmal, nicht mehrfach ──────────
{
  const r3 = retoure(db, inv, 'pA', 1, 1100, 100);
  ok(Math.abs(retourKosten(db, r3) - 100) < 0.005, `7 dritte Retoure nach 7 Edits: Wareneinsatz-Rückbuchung 100 (${retourKosten(db, r3)})`);
  ok(Math.abs(cogsNetto(db, A) - 100) < 0.005, `7 …Zeile A netto 4×100 − 3×100 = 100 (${cogsNetto(db, A)})`);
  ok(ausgeglichen(db), '7 …Hauptbuch ausgeglichen');
}

// ── 8) Fehler mitten in der Transaktion: vollständiger Rollback ───────────────────────────
{
  const vor = zustand(db);
  const m = aendern(inv, [LINE('pA', 20, 1000), LINE('pB', 1, 600)]);
  ok(m !== '' && zustand(db) === vor, `8 Menge A 4 → 20 (Los reicht nicht): abgewiesen NACH der Rückbuchung, alles zurückgerollt (${m.slice(0, 60)})`);
}

// ── 9) Gutschriften-Deckel ────────────────────────────────────────────────────────────────
{
  const cnId = s(db, "SELECT id FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED' LIMIT 1", [inv]);
  const alt = n(db, 'SELECT total_amount FROM credit_notes WHERE id = ?', [cnId]);
  db.run('UPDATE credit_notes SET total_amount = 99999 WHERE id = ?', [cnId]);
  const vor = zustand(db);
  const m = aendern(inv, [LINE('pA', 4, 1000), LINE('pB', 1, 500)]);
  ok(m.startsWith(EDIT_BELOW_CREDIT_NOTES + '|') && zustand(db) === vor, `9 Summe unter die Gutschriften: abgewiesen (${m.slice(0, 80)})`);
  db.run('UPDATE credit_notes SET total_amount = ? WHERE id = ?', [alt, cnId]);
}

// ── 10) PC2: die neuen Neins sind endgültige Absagen, keine Störung ───────────────────────
{
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadHash: 'h' + x });
  const rev = (): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
  const vor = zustand(db);
  const nein = await runInvoiceUpdate(d as never, ident('71'), {
    id: inv, expectedRevision: rev(), reason: 'PC2 Preis A', customerId: 'cust-1',
    lines: [{ productId: 'pA', quantity: 4, unitPrice: 1300 }, { productId: 'pB', quantity: 1, unitPrice: 600 }],
  });
  reload();
  ok(nein.kind === 'rejected' && (nein as { code: string }).code === EDIT_RETURNED_LINE_PRICE_LOCKED && (nein as { frozen: boolean }).frozen === true,
    `10 PC2 Preis der retournierten Zeile: endgültige Absage ${S(nein).slice(0, 140)}`);
  ok(zustand(db) === vor, '10 …nichts geändert');
  const weg = await runInvoiceUpdate(d as never, ident('72'), {
    id: inv, expectedRevision: rev(), reason: 'PC2 A entfernen', customerId: 'cust-1',
    lines: [{ productId: 'pB', quantity: 1, unitPrice: 600 }],
  });
  reload();
  ok(weg.kind === 'rejected' && (weg as { code: string }).code === EDIT_LINE_HAS_RETURN && (weg as { frozen: boolean }).frozen === true,
    `10 PC2 Zeile mit Retoure entfernen: endgültige Absage (${(weg as { code?: string }).code})`);
  const ja = await runInvoiceUpdate(d as never, ident('73'), {
    id: inv, expectedRevision: rev(), reason: 'PC2 Preis B', customerId: 'cust-1',
    lines: [{ productId: 'pA', quantity: 4, unitPrice: 1000 }, { productId: 'pB', quantity: 1, unitPrice: 650 }],
  });
  reload();
  ok(ja.kind === 'ok' && lineId(db, inv, 'pA') === A && lineId(db, inv, 'pB') === B && ausgeglichen(db),
    `10 PC2 Preis am nicht retournierten Artikel: geht durch, IDs bleiben (${ja.kind})`);
}

// ── 11) Per Retoure erledigte Rechnung (RETURNED): Status und Guthaben stimmen nach dem Edit ─
{
  const db2 = neu();
  product(db2, 'pX', null, 3);
  product(db2, 'pY', null, 3);
  reload();
  const inv2 = rechnung([LINE('pX', 1, 1000), LINE('pY', 1, 500)]);          // 1100 + 550 = 1650
  imHaus(() => useInvoiceStore.getState().recordPayment(inv2, 1100, 'cash')); reload();
  const Y = lineId(db2, inv2, 'pY');
  retoure(db2, inv2, 'pY', 1, 550, 50);
  const cancel = n(db2, "SELECT COALESCE(SUM(receivable_cancel_amount), 0) FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'", [inv2]);
  ok(status(db2, inv2) === 'RETURNED' && Math.abs(cancel - 550) < 0.005 && Math.abs(forderung(db2, 'cust-1')) < 0.005,
    `SETUP bezahlt 1100 + Gutschrift mindert 550 → RETURNED, Forderung 0 (${status(db2, inv2)}, ${cancel})`);
  const m = aendern(inv2, [LINE('pX', 1, 900), LINE('pY', 1, 500)]);        // 990 + 550 = 1540
  const cc = n(db2, "SELECT COALESCE(SUM(amount), 0) FROM customer_credits WHERE source_type = 'invoice_edit' AND source_id = ?", [inv2]);
  ok(m === '' && status(db2, inv2) === 'RETURNED', `11 Preis X gesenkt: bleibt RETURNED, nicht PARTIAL (${m} ${status(db2, inv2)})`);
  ok(Math.abs(cc - 110) < 0.005 && Math.abs(forderung(db2, 'cust-1')) < 0.005,
    `11 …1100 bezahlt + 550 gutgeschrieben − 1540 = 110 Guthaben, Forderung 0 (${cc}, AR ${forderung(db2, 'cust-1')})`);
  ok(lineId(db2, inv2, 'pY') === Y && ausgeglichen(db2), '11 …retournierte Zeile behält ihre ID, Hauptbuch ausgeglichen');
}

// ── Quelltext ─────────────────────────────────────────────────────────────────────────────
{
  const store = src('src/stores/invoiceStore.ts');
  const edit = store.slice(store.indexOf('  editInvoice: (id, input) => {'), store.indexOf('  recordPayment: (invoiceId'));
  ok(!/DELETE FROM invoice_lines WHERE invoice_id = \?/.test(edit), 'Q editInvoice löscht nicht mehr alle Zeilen');
  ok(!/Cannot edit invoice lines —/.test(store), 'Q die Pauschalsperre „Retoure/Gutschrift" ist weg');
  const cmd = src('src/core/bridge/invoice-lifecycle-commands.ts');
  ok(/EDIT_CODE_VERDICTS/.test(cmd) && ['EDIT_LINE_HAS_RETURN', 'EDIT_BELOW_RETURNED_QTY', 'EDIT_RETURNED_LINE_PRICE_LOCKED', 'EDIT_BELOW_CREDIT_NOTES', 'LEGACY_STOCK_LINES'].every((c) => cmd.includes(c)),
    'Q die Urteilsliste von invoices.edit kennt die neuen Neins (und LEGACY_STOCK_LINES)');
  ok(/NOT EXISTS \(SELECT 1 FROM ledger_entries e2 WHERE e2\.reverses_entry_id = e1\.id\)/.test(src('src/core/ledger/posting.ts')),
    'Q der Wareneinsatz einer Rechnungszeile zählt gegengebuchte Originale nicht mit');
}
void current; void insert; void lineIds;

console.log(`\ninvoice-edit-returns: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S2 (Identität) — welche gespeicherte Zeile eine neue fortsetzt, sagt die ZEILEN-ID.
// Zwei gleiche Artikel, gleicher Preis, VERSCHIEDENE Lose, nur einer retourniert.
// Run: node --experimental-strip-types test/invoice-edit/line-identity.test.ts
//
//   1 umstellen · 2 die andere Zeile entfernen · 3/4 die retournierte entfernen/ersetzen
//   5 Preis, Steuerart, Rabatt der retournierten Zeile · 6 unbekannte/doppelte/fremde IDs
//   7 ältere Gegenstelle ohne IDs · 8 retournierte Zeile ohne Los · 9 PC2 · 10 Zuordnung pur
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
  EDIT_LINE_HAS_RETURN, EDIT_RETURNED_LINE_PRICE_LOCKED, EDIT_LINE_ID_INVALID,
  EDIT_AMBIGUOUS_RETURNED_LINE, EDIT_RETURNED_LINE_LOT_UNKNOWN, matchEditLines, loadEditBaseLines,
} = await import('../../src/core/invoices/edit-lines.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void insert; void useCreditNoteStore;

const zeilen = (db: Db, inv: string): Array<{ id: string; lot: string; qty: number; preis: number }> =>
  (db.exec('SELECT id, lot_id, quantity, unit_price FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv])[0]?.values ?? [])
    .map((v) => ({ id: String(v[0]), lot: String(v[1] ?? ''), qty: Number(v[2]), preis: Number(v[3]) }));
const retZeile = (db: Db, rid: string): string => s(db, 'SELECT invoice_line_id FROM sales_return_lines WHERE return_id = ?', [rid]);
const lotRest = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const cogs = (db: Db, lid: string): number => n(db,
  "SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = 'COGS' AND source_line_id = ?", [lid]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
function zustand(db: Db): string {
  return S({
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    lots: all(db, 'SELECT id, qty_remaining FROM stock_lots ORDER BY id'),
    srl: all(db, 'SELECT * FROM sales_return_lines ORDER BY id'),
    cn: all(db, 'SELECT id, total_amount, vat_amount, status FROM credit_notes ORDER BY id'),
    le: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
  });
}
/** Zeile für den Edit: mit ID (wie Maske/PC2) oder ohne (ältere Gegenstelle). */
const L = (pid: string, qty: number, preis: number, lineId?: string) => ({
  ...(lineId ? { lineId } : {}), ...LINE(pid, qty, preis),
});
function aendern(inv: string, lines: Array<ReturnType<typeof L>>): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, { lines: lines as never, reason: 'S2-ID Test' } as never)));
  reload();
  return m;
}
function retoure(db: Db, inv: string, lid: string, pid: string, menge: number, brutto: number, vat: number): string {
  const rid = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'S2-ID',
      lines: [{ invoiceLineId: lid, productId: pid, quantity: menge, unitPrice: brutto, vatAmount: vat }],
    } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
    return id;
  });
  reload();
  return rid;
}

// ══ Welt: DERSELBE Artikel zweimal, zwei verschiedene Lose, nur die erste Zeile retourniert ══
// Zeile 1: Los A (Einstand 100), retourniert · Zeile 2: Los B (Einstand 300), nicht retourniert.
function welt(): { db: Db; inv: string; z1: string; z2: string; rid: string } {
  const db = neu();
  product(db, 'pG', 1);                       // Los A, 1 Stück à 100
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-pG-b','branch-main','pG',300,1,1,'ACTIVE',?,?)`, [NOW, NOW]);
  db.run("UPDATE products SET quantity = 2 WHERE id = 'pG'");
  product(db, 'pZ', null, 3);
  reload();
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [
    { ...LINE('pG', 1, 1000), lotId: 'lot-pG' },
    { ...LINE('pG', 1, 1000), lotId: 'lot-pG-b', purchasePrice: 300 },
  ] as never, 'S2-ID').id);
  reload();
  voll(inv);
  const z = zeilen(db, inv);
  const rid = retoure(db, inv, z[0].id, 'pG', 1, 1100, 100);
  return { db, inv, z1: z[0].id, z2: z[1].id, rid };
}

{
  const { db, inv, z1, z2, rid } = welt();
  ok(z1 !== z2 && lotRest(db, 'lot-pG') === 1 && lotRest(db, 'lot-pG-b') === 0,
    `SETUP zwei gleiche Artikel, gleicher Preis, verschiedene Lose; Zeile 1 (Los A) retourniert (A ${lotRest(db, 'lot-pG')}, B ${lotRest(db, 'lot-pG-b')})`);
  ok(retZeile(db, rid) === z1 && Math.abs(cogs(db, z1)) < 0.005 && Math.abs(cogs(db, z2) - 300) < 0.005,
    `SETUP …Wareneinsatz: Zeile 1 zurückgebucht (${cogs(db, z1)}), Zeile 2 unverändert 300 (${cogs(db, z2)})`);

  // 1) Zeilen UMSTELLEN — mit IDs folgt die Zuordnung der ID, nicht der Reihenfolge.
  let m = aendern(inv, [L('pG', 1, 1000, z2), L('pG', 1, 1000, z1)]);
  let z = zeilen(db, inv);
  ok(m === '' && z.length === 2 && z[0].id === z2 && z[1].id === z1,
    `1 Zeilen umgestellt: die IDs wandern mit (${m}; ${z.map((x) => x.id === z1 ? 'z1' : 'z2').join(',')})`);
  ok(z[0].lot === 'lot-pG-b' && z[1].lot === 'lot-pG' && retZeile(db, rid) === z1,
    '1 …jede Zeile behält ihr Los, die Retoure zeigt weiter auf Zeile 1');
  ok(Math.abs(cogs(db, z1)) < 0.005 && Math.abs(cogs(db, z2) - 300) < 0.005 && ausgeglichen(db),
    `1 …Wareneinsatz je Zeile unverändert (${cogs(db, z1)}/${cogs(db, z2)})`);

  // 2) Die NICHT retournierte Zeile entfernen — erlaubt, und es trifft genau sie.
  const vor2 = lotRest(db, 'lot-pG-b');
  m = aendern(inv, [L('pG', 1, 1000, z1)]);
  z = zeilen(db, inv);
  ok(m === '' && z.length === 1 && z[0].id === z1 && z[0].lot === 'lot-pG',
    `2 Zeile 2 entfernt: übrig bleibt Zeile 1 mit Los A (${m}; ${z.map((x) => x.lot).join(',')})`);
  ok(lotRest(db, 'lot-pG-b') === vor2 + 1 && retZeile(db, rid) === z1,
    `2 …Los B bekommt sein Stück zurück (${lotRest(db, 'lot-pG-b')}), die Retoure bleibt an Zeile 1`);
  ok(Math.abs(cogs(db, z2)) < 0.005 && ausgeglichen(db), `2 …Wareneinsatz der entfernten Zeile zurückgedreht (${cogs(db, z2)})`);
}

// 3) Die RETOURNIERTE Zeile entfernen — abgelehnt, auch wenn die andere gleich aussieht.
{
  const { db, inv, z1, z2 } = welt();
  const vor = zustand(db);
  const m = aendern(inv, [L('pG', 1, 1000, z2)]);
  ok(m.startsWith(EDIT_LINE_HAS_RETURN + '|') && zustand(db) === vor,
    `3 retournierte Zeile entfernen: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 70)})`);
  void z1;
}

// 4) Artikel unter der ID der retournierten Zeile wechseln = Ersetzen → abgelehnt.
{
  const { db, inv, z1, z2 } = welt();
  const vor = zustand(db);
  const m = aendern(inv, [L('pZ', 1, 1000, z1), L('pG', 1, 1000, z2)]);
  ok(m.startsWith(EDIT_LINE_HAS_RETURN + '|') && zustand(db) === vor,
    `4 Artikelwechsel unter der ID der retournierten Zeile: abgewiesen (${m.split('|')[1]?.slice(0, 70)})`);
}

// 5) Preis NUR der anderen Zeile ändern — erlaubt; die retournierte bleibt unberührt.
{
  const { db, inv, z1, z2, rid } = welt();
  const cnVor = all(db, 'SELECT total_amount, vat_amount FROM credit_notes ORDER BY id');
  const m = aendern(inv, [L('pG', 1, 1000, z1), L('pG', 1, 1400, z2)]);
  const z = zeilen(db, inv);
  ok(m === '' && z.find((x) => x.id === z1)?.preis === 1000 && z.find((x) => x.id === z2)?.preis === 1400,
    `5 Preis nur der nicht retournierten Zeile: erlaubt (${m})`);
  ok(all(db, 'SELECT total_amount, vat_amount FROM credit_notes ORDER BY id') === cnVor && retZeile(db, rid) === z1,
    '5 …die Gutschrift bleibt unverändert');
  // …und der Preis der retournierten Zeile bleibt gesperrt.
  const vor = zustand(db);
  const m2 = aendern(inv, [L('pG', 1, 1200, z1), L('pG', 1, 1400, z2)]);
  ok(m2.startsWith(EDIT_RETURNED_LINE_PRICE_LOCKED + '|') && zustand(db) === vor,
    `5 Preis der retournierten Zeile: abgewiesen (${m2.split('|')[1]?.slice(0, 60)})`);
  // Steuerart und Steuersatz ebenso.
  const m3 = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ ...L('pG', 1, 1000, z1), taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1000 }, L('pG', 1, 1400, z2)] as never,
    reason: 'Steuerart',
  } as never)));
  reload();
  ok(m3.startsWith(EDIT_RETURNED_LINE_PRICE_LOCKED + '|') && zustand(db) === vor,
    `5 Steuerart der retournierten Zeile: abgewiesen (${m3.split('|')[1]?.slice(0, 60)})`);
  // Ein „Rabatt" auf den Zeilenbetrag bei gleichem Stückpreis ebenfalls.
  const m4 = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ ...L('pG', 1, 1000, z1), lineTotal: 900 }, L('pG', 1, 1400, z2)] as never, reason: 'Rabatt',
  } as never)));
  reload();
  ok(m4.startsWith(EDIT_RETURNED_LINE_PRICE_LOCKED + '|') && zustand(db) === vor,
    `5 Rabatt auf den Zeilenbetrag der retournierten Zeile: abgewiesen (${m4.split('|')[1]?.slice(0, 60)})`);
}

// 6) Fremde, doppelte und unbekannte IDs ───────────────────────────────────────────────────
{
  const { db, inv, z1, z2 } = welt();
  const vor = zustand(db);
  for (const [name, lines] of [
    ['6 unbekannte Zeilen-ID', [L('pG', 1, 1000, z1), L('pG', 1, 1000, 'gibt-es-nicht')]],
    ['6 dieselbe ID zweimal', [L('pG', 1, 1000, z1), L('pG', 1, 1000, z1)]],
  ] as Array<[string, Array<ReturnType<typeof L>>]>) {
    const m = aendern(inv, lines);
    ok(m.startsWith(EDIT_LINE_ID_INVALID + '|') && zustand(db) === vor, `${name}: abgewiesen (${m.split('|')[1]?.slice(0, 60)})`);
  }
  // Eine ID aus einer FREMDEN Rechnung.
  const inv2 = rechnung([LINE('pZ', 1, 500)]);
  const fremd = zeilen(db, inv2)[0].id;
  const m = aendern(inv, [L('pG', 1, 1000, z1), L('pG', 1, 1000, fremd)]);
  ok(m.startsWith(EDIT_LINE_ID_INVALID + '|'), `6 ID einer fremden Rechnung: abgewiesen (${m.split('|')[1]?.slice(0, 60)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE id = ?', [fremd]) === 1
    && s(db, 'SELECT invoice_id FROM invoice_lines WHERE id = ?', [fremd]) === inv2,
    '6 …die fremde Zeile blieb, wo sie war');
  // Eine neue Zeile OHNE ID neben Zeilen MIT ID: sie ist einfach neu.
  const m2 = aendern(inv, [L('pG', 1, 1000, z1), L('pG', 1, 1000, z2), L('pZ', 1, 300)]);
  const z = zeilen(db, inv);
  ok(m2 === '' && z.length === 3 && z[0].id === z1 && z[1].id === z2 && ![z1, z2].includes(z[2].id),
    `6 neue Zeile ohne ID neben zweien mit ID: sie bekommt eine neue ID (${m2})`);
}

// 7) Ältere Gegenstelle (ohne IDs) ───────────────────────────────────────────────────────────
{
  const { db, inv, z1, z2 } = welt();
  const vor = zustand(db);
  const m = aendern(inv, [L('pG', 1, 1000), L('pG', 1, 1000)]);
  ok(m.startsWith(EDIT_AMBIGUOUS_RETURNED_LINE + '|') && zustand(db) === vor,
    `7 ohne IDs, derselbe Artikel zweimal mit Retoure: abgewiesen statt geraten (${m.split('|')[1]?.slice(0, 80)})`);
  ok(!/INVOICE_|_QTY|LOCKED/.test(m.split('|')[1] ?? ''), '7 …die Meldung trägt keinen Fehlercode');
  void z1; void z2;

  // Ohne Mehrdeutigkeit bleibt die alte Zuordnung erlaubt (eine Rechnung, ein Artikel, eine Retoure).
  const db2 = neu();
  product(db2, 'pH', 3); reload();
  const inv2 = rechnung([LINE('pH', 2, 1000)]);
  voll(inv2);
  const zz = zeilen(db2, inv2)[0];
  retoure(db2, inv2, zz.id, 'pH', 1, 1100, 100);
  const m2 = aendern(inv2, [L('pH', 2, 1000)]);
  ok(m2 === '' && zeilen(db2, inv2)[0].id === zz.id,
    `7 ohne IDs, eindeutige Zeile mit Retoure: weiterhin erlaubt, ID bleibt (${m2})`);
}

// 8) Eine retournierte Zeile OHNE bekanntes Los (Artikel mit Losen) ──────────────────────────
{
  const db2 = neu();
  product(db2, 'pI', 3); reload();
  const inv = rechnung([LINE('pI', 1, 1000)]);
  voll(inv);
  const zz = zeilen(db2, inv)[0];
  retoure(db2, inv, zz.id, 'pI', 1, 1100, 100);
  db2.run('UPDATE invoice_lines SET lot_id = NULL WHERE id = ?', [zz.id]);   // wie eine Zeile von vor dem Losvertrag
  reload();
  const vor = zustand(db2);
  const m = aendern(inv, [L('pI', 1, 1000, zz.id)]);
  ok(m.startsWith(EDIT_RETURNED_LINE_LOT_UNKNOWN + '|') && zustand(db2) === vor,
    `8 retournierte Zeile ohne bekanntes Los: abgewiesen (${m.split('|')[1]?.slice(0, 70)})`);
}

// 9) PC2 schickt die IDs mit — und bekommt bei Verstößen eine endgültige Absage ──────────────
{
  const { db, inv, z1, z2, rid } = welt();
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h' + x });
  const rev = (): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
  const vor = zustand(db);
  const nein = await runInvoiceUpdate(d as never, ident('81') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 tauscht', customerId: 'cust-1',
    lines: [{ lineId: z2, productId: 'pG', quantity: 1, unitPrice: 1000 }],
  });
  reload();
  ok(nein.kind === 'rejected' && (nein as { code: string }).code === EDIT_LINE_HAS_RETURN && (nein as { frozen: boolean }).frozen === true && zustand(db) === vor,
    `9 PC2 entfernt die retournierte Zeile (ID der anderen mitgeschickt): endgültige Absage (${(nein as { code?: string }).code})`);
  const falsch = await runInvoiceUpdate(d as never, ident('82') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 fremde ID', customerId: 'cust-1',
    lines: [{ lineId: 'fremd-1', productId: 'pG', quantity: 1, unitPrice: 1000 }, { lineId: z2, productId: 'pG', quantity: 1, unitPrice: 1000 }],
  });
  reload();
  ok(falsch.kind === 'rejected' && (falsch as { code: string }).code === EDIT_LINE_ID_INVALID && zustand(db) === vor,
    `9 PC2 mit unbekannter ID: endgültige Absage (${(falsch as { code?: string }).code})`);
  const ja = await runInvoiceUpdate(d as never, ident('83') as never, {
    id: inv, expectedRevision: rev(), reason: 'PC2 Preis der anderen Zeile', customerId: 'cust-1',
    lines: [{ lineId: z1, productId: 'pG', quantity: 1, unitPrice: 1000 }, { lineId: z2, productId: 'pG', quantity: 1, unitPrice: 1500 }],
  });
  reload();
  const z = zeilen(db, inv);
  ok(ja.kind === 'ok' && z[0].id === z1 && z[1].id === z2 && z[1].preis === 1500 && retZeile(db, rid) === z1 && ausgeglichen(db),
    `9 PC2 ändert den Preis der anderen Zeile: geht durch, IDs und Retoure bleiben (${ja.kind})`);
  // Beim ANLEGEN darf eine mitgeschickte ID nichts übernehmen.
  const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
  const neuInv = await runInvoiceCreate(d as never, ident('84') as never, {
    customerId: 'cust-1', lines: [{ lineId: z1, productId: 'pZ', quantity: 1, unitPrice: 200 }],
  });
  reload();
  ok(neuInv.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE id = ?', [z1]) === 1
    && s(db, 'SELECT invoice_id FROM invoice_lines WHERE id = ?', [z1]) === inv,
    `9 Anlegen mit fremder lineId: die fremde Zeile bleibt unberührt (${neuInv.kind})`);
}

// 10) Die Zuordnung selbst, ohne Datenbank ──────────────────────────────────────────────────
{
  const db2 = neu();
  product(db2, 'pJ', null, 4); reload();
  const inv = rechnung([LINE('pJ', 1, 100), LINE('pJ', 1, 100)]);
  const base = loadEditBaseLines(inv);
  const [a, b] = base.map((x) => x.id);
  ok(S(matchEditLines(base, [{ lineId: b, productId: 'pJ', unitPrice: 100, taxScheme: 'VAT_10', lineTotal: 110 },
    { lineId: a, productId: 'pJ', unitPrice: 100, taxScheme: 'VAT_10', lineTotal: 110 }])) === S([b, a]),
    '10 mit IDs: die Reihenfolge ist egal');
  ok(S(matchEditLines(base, [{ productId: 'pJ', unitPrice: 100, taxScheme: 'VAT_10', lineTotal: 110 }])) === S([a]),
    '10 ohne IDs und ohne Retoure: die erste passende Zeile (wie bisher)');
  ok(S(matchEditLines(base, [{ lineId: a, productId: 'pK', unitPrice: 100, taxScheme: 'VAT_10', lineTotal: 110 }])) === S([null]),
    '10 ID mit anderem Artikel = Ersetzen → neue Zeile');
}

// ── Quelltext ───────────────────────────────────────────────────────────────────────────────
{
  ok(/lineId/.test(src('src/pages/invoices/InvoiceCreate.tsx')), 'Q die Maske führt die Zeilen-ID mit');
  const cmd = src('src/core/bridge/invoice-command.ts');
  ok(/LINE_KEYS = new Set\(\['lineId'/.test(cmd), 'Q der Fernweg lässt lineId als Zeilenfeld zu');
  ok((cmd.match(/lineId: undefined/g) ?? []).length === 1 && /runInvoiceCreate/.test(cmd), 'Q …und verwirft sie auf dem Anlege-Weg');
}
void current;

console.log(`\ninvoice-edit-line-identity: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

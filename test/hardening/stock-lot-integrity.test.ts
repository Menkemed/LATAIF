// ════════════════════════════════════════════════════════════════════════════
// STOCK-LOT-INTEGRITY — der Bestandsvertrag eines Verkaufs, an echten Zeilen einer echten
// sql.js-Datenbank (schema.sql + echte Migrationen + A1 + Medienschema, wie post-0858-guards).
// Run: node --experimental-strip-types test/hardening/stock-lot-integrity.test.ts
//
//   1 Los-Artikel (Einkaufslos 3): qty 1 / qty 2, Storno, Löschen, Ändern 2→1
//   2 Artikel ohne Los (Menge 3): Verbrauch beim Verkauf, STOCK_UNAVAILABLE, FINAL ohne Abzug,
//     Zahlung löschen + erneut FINAL, Storno unbezahlt, Einzelstück reserved → sold
//   3 Übergang Altzeilen: A pending → genau ein Abzug; B deducted → keiner mehr; C qty>1 → nie qty
//   4 Reparatur-Serviceprodukt svc-repair-*: stock_taken 0, Menge unberührt
//   5 Auftrags-Einzelstück (Menge 1, ohne Los, 'reserved') — über createDirectInvoice simuliert
//   6 Kommission: recordSale (Auto-Einkauf → Los → Rechnung)
//   7 Agentenverkauf Los-Artikel: markTransferSold, Doppelaufruf, Umwandlung, Undo, Löschen
//   8 Agentenverkauf ohne Los (Menge 1): Umwandlung + FINAL ohne zweiten Abzug
//   9 Produktion: lot_consumption, exakte Rückgabe, Altproduktion gesperrt, fremdes Los unberührt
//   10 Hauptbuch: keine Doppelbuchung (Umwandlung, wiederholtes FINAL)
//   11 Retoure (Artikel ohne Los): IN_STOCK gibt zurück, Retoure-Storno nimmt wieder / RESOLD
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
let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };

const qty = (db: Db, pid: string): number => n(db, 'SELECT quantity FROM products WHERE id = ?', [pid]);
const st = (db: Db, pid: string): string => s(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]);
const lotRem = (db: Db, lot: string): number => n(db, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lot]);
const taken = (db: Db, invId: string): unknown => one(db, 'SELECT stock_taken FROM invoice_lines WHERE invoice_id = ?', [invId]);
const invStatus = (db: Db, invId: string): string => s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]);
const le = (db: Db, mod: string, id: string): number =>
  n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE source_module = ? AND source_id = ?', [mod, id]);

/** Was ein abgelehnter Vorgang nicht verändern darf. */
function zustand(db: Db): string {
  return S({
    inv: all(db, 'SELECT * FROM invoices ORDER BY id'),
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    pay: all(db, 'SELECT * FROM payments ORDER BY id'),
    lots: all(db, 'SELECT * FROM stock_lots ORDER BY id'),
    prod: all(db, 'SELECT id, quantity, stock_status FROM products ORDER BY id'),
    tr: all(db, 'SELECT * FROM agent_transfers ORDER BY id'),
    prin: all(db, 'SELECT * FROM production_inputs ORDER BY id'),
    prrec: all(db, 'SELECT id, status FROM production_records ORDER BY id'),
    le: all(db, 'SELECT id, account, direction, amount, source_module, source_id FROM ledger_entries ORDER BY id'),
  });
}

// ══ 1 — Los-Artikel (Einkaufslos 3) ═══════════════════════════════════════════
{
  const db = neu();
  product(db, 'pL', 3); reload();
  const inv1 = rechnung([LINE('pL', 1)]);
  ok(lotRem(db, 'lot-pL') === 2 && qty(db, 'pL') === 2, `1 qty 1: Los 3→2, Menge 2 (${lotRem(db, 'lot-pL')}/${qty(db, 'pL')})`);
  ok(taken(db, inv1) === 1 && s(db, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [inv1]) === 'lot-pL',
    `1 …stock_taken 1, lot_id lot-pL (${S(taken(db, inv1))})`);
  const inv2 = rechnung([LINE('pL', 2)]);
  ok(lotRem(db, 'lot-pL') === 0 && qty(db, 'pL') === 0 && taken(db, inv2) === 2,
    `1 qty 2: Los 2→0, Menge 0, stock_taken 2 (${lotRem(db, 'lot-pL')}/${qty(db, 'pL')}/${S(taken(db, inv2))})`);
  ok(st(db, 'pL') === 'reserved', `1 …ausverkauft → reserved (${st(db, 'pL')})`);
  ok(le(db, 'INVOICE', inv1) > 0 && le(db, 'INVOICE', inv2) > 0, '1 …beide Rechnungen gebucht');
  // Negativkontrolle: dritte Rechnung ohne Bestand → abgelehnt, nichts geschrieben.
  const vor = zustand(db);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE('pL', 1)] as never, 'x')));
  ok(m.includes(STOCK_UNAVAILABLE_MESSAGE) && zustand(db) === vor, `1 NEG Los leer: dritte Rechnung abgelehnt, nichts geändert (${m})`);

  const c = meldung(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: inv2, refundMethod: 'cash' }, 'branch-main')));
  reload();
  ok(c === '' && invStatus(db, inv2) === 'CANCELLED', `1 Storno inv2 läuft (${c})`);
  ok(lotRem(db, 'lot-pL') === 2 && qty(db, 'pL') === 2 && st(db, 'pL') === 'in_stock',
    `1 …gibt genau 2 zurück: Los 2, Menge 2, in_stock (${lotRem(db, 'lot-pL')}/${qty(db, 'pL')}/${st(db, 'pL')})`);

  const d = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(inv1)));
  reload();
  ok(d === '' && lotRem(db, 'lot-pL') === 3 && qty(db, 'pL') === 3,
    `1 Löschen inv1 gibt genau 1 zurück: Los 3, Menge 3 (${d} ${lotRem(db, 'lot-pL')}/${qty(db, 'pL')})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [inv1]) === 0, '1 …Zeilen gelöscht');

  const inv3 = rechnung([LINE('pL', 2)]);
  ok(lotRem(db, 'lot-pL') === 1, `1 SETUP Rechnung qty 2: Los 1 (${lotRem(db, 'lot-pL')})`);
  const e = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv3, {
    lines: [{ ...LINE('pL', 1), lotId: 'lot-pL' }] as never, reason: 'Menge korrigiert',
  })));
  reload();
  ok(e === '' && lotRem(db, 'lot-pL') === 2 && qty(db, 'pL') === 2,
    `1 Ändern qty 2→1 gibt genau 1 zurück: Los 2, Menge 2 (${e} ${lotRem(db, 'lot-pL')}/${qty(db, 'pL')})`);
  ok(taken(db, inv3) === 1 && n(db, 'SELECT quantity FROM invoice_lines WHERE invoice_id = ?', [inv3]) === 1,
    `1 …neue Zeile qty 1, stock_taken 1 (${S(taken(db, inv3))})`);
}

// ══ 2 — Artikel ohne Los (Menge 3) ═════════════════════════════════════════════
{
  const db = neu();
  product(db, 'pM', null, 3); reload();
  const inv = rechnung([LINE('pM', 2)]);
  ok(qty(db, 'pM') === 1 && taken(db, inv) === 2 && st(db, 'pM') === 'in_stock',
    `2 qty 2: Menge 3→1, stock_taken 2, in_stock (${qty(db, 'pM')}/${S(taken(db, inv))}/${st(db, 'pM')})`);
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'pM'") === 0, '2 …kein Los angelegt');
  const vor = zustand(db);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [LINE('pM', 2)] as never, 'x')));
  ok(m.includes(STOCK_UNAVAILABLE_MESSAGE), `2 zweite Rechnung qty 2 bei Menge 1: STOCK_UNAVAILABLE (${m})`);
  ok(zustand(db) === vor, '2 …nichts geschrieben');

  const invLe = le(db, 'INVOICE', inv);
  const pay1 = voll(inv);
  ok(invStatus(db, inv) === 'FINAL' && qty(db, 'pM') === 1 && taken(db, inv) === 2,
    `2 voll bezahlt (FINAL): kein weiterer Abzug, Menge 1 (${invStatus(db, inv)}/${qty(db, 'pM')})`);
  ok(st(db, 'pM') === 'in_stock', `2 …Restbestand 1 → Status bleibt in_stock (${st(db, 'pM')})`);
  imHaus(() => useInvoiceStore.getState().deletePayment(pay1, inv));
  reload();
  ok(invStatus(db, inv) !== 'FINAL' && qty(db, 'pM') === 1, `2 Zahlung gelöscht (${invStatus(db, inv)}): Menge 1`);
  const pay2 = voll(inv);
  await tick();
  ok(invStatus(db, inv) === 'FINAL' && qty(db, 'pM') === 1 && taken(db, inv) === 2,
    `2 erneut FINAL: immer noch kein Abzug, Menge 1 (${qty(db, 'pM')})`);
  ok(le(db, 'INVOICE', inv) === invLe, `10 wiederholtes FINAL: INVOICE-Buchung unverändert (${invLe}→${le(db, 'INVOICE', inv)})`);
  ok(le(db, 'PAYMENT', pay1) === 2 * le(db, 'PAYMENT', pay2) && le(db, 'PAYMENT', pay2) > 0,
    `10 …Zahlung 1 gebucht + storniert (${le(db, 'PAYMENT', pay1)}), Zahlung 2 einmal (${le(db, 'PAYMENT', pay2)})`);
  imHaus(() => useInvoiceStore.getState().deletePayment(pay2, inv));
  reload();
  const c = meldung(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: inv, refundMethod: 'cash' }, 'branch-main')));
  reload();
  ok(c === '' && invStatus(db, inv) === 'CANCELLED' && qty(db, 'pM') === 3 && st(db, 'pM') === 'in_stock',
    `2 Storno unbezahlt: Menge genau zurück 1→3, in_stock (${c} ${qty(db, 'pM')}/${st(db, 'pM')})`);

  // Einzelstück: reserved beim Verkauf, sold beim FINAL.
  product(db, 'p1', null, 1); reload();
  const inv1 = rechnung([LINE('p1', 1)]);
  ok(qty(db, 'p1') === 0 && st(db, 'p1') === 'reserved' && taken(db, inv1) === 1,
    `2 Einzelstück: Menge 0, reserved, stock_taken 1 (${qty(db, 'p1')}/${st(db, 'p1')})`);
  voll(inv1);
  ok(qty(db, 'p1') === 0 && st(db, 'p1') === 'sold', `2 …FINAL → sold, Menge 0 (${qty(db, 'p1')}/${st(db, 'p1')})`);
}

// ══ 3 — Übergang: Rechnungszeilen von VOR dem Bestandsvertrag (ohne Los) ════════════
// Alt-Vertrag: beim Anlegen nichts, beim Übergang auf FINAL genau 1 Stück (egal welche Menge).
// Die Einordnung beim Start (`classifyLegacyInvoiceLines`) setzt den Merker `legacy_stock`.
const legacyStock = (db: Db, invId: string): unknown => one(db, 'SELECT legacy_stock FROM invoice_lines WHERE invoice_id = ?', [invId]);
/** Eine Altzeile simulieren: Nachweis weg, Bestand wie der alte Vertrag ihn hinterlassen hätte. */
function altRechnung(db: Db, pid: string, lineQty: number, qtyNachAltvertrag: number, status?: string): string {
  const inv = rechnung([LINE(pid, lineQty)]);
  db.run('UPDATE invoice_lines SET stock_taken = NULL, legacy_stock = NULL WHERE invoice_id = ?', [inv]);
  db.run('UPDATE products SET quantity = ?, stock_status = ? WHERE id = ?', [qtyNachAltvertrag, 'in_stock', pid]);
  if (status) db.run('UPDATE invoices SET status = ? WHERE id = ?', [status, inv]);
  reload();
  return inv;
}
{
  // A — alte UNBEZAHLTE Rechnung (qty 2): der alte Abzug steht noch aus.
  const db = neu();
  product(db, 'pA', null, 3); reload();
  const inv = altRechnung(db, 'pA', 2, 3);
  classifyLegacyInvoiceLines(db as never);
  ok(legacyStock(db, inv) === 'pending' && taken(db, inv) === null && qty(db, 'pA') === 3,
    `3A Einordnung: pending, kein Nachweis, Menge 3 (${S(legacyStock(db, inv))})`);
  classifyLegacyInvoiceLines(db as never);
  ok(legacyStock(db, inv) === 'pending', '3A …zweiter Start ordnet nicht neu ein (idempotent)');
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'FINAL' }));
  await tick();
  ok(qty(db, 'pA') === 2 && legacyStock(db, inv) === 'deducted' && taken(db, inv) === null,
    `3A erstes FINAL: alter Vertrag genau EINMAL (1 Stück trotz qty 2), Merker deducted (${qty(db, 'pA')}/${S(legacyStock(db, inv))})`);
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'PARTIAL' }));
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'FINAL' }));
  await tick();
  imHaus(() => { void eventBus.emit('invoice.paid', 'invoice', inv, {}); });
  await tick();
  ok(qty(db, 'pA') === 2, `3A erneutes FINAL + direktes invoice.paid: kein weiterer Abzug (${qty(db, 'pA')})`);

  // A' — alte unbezahlte Rechnung wird storniert, BEVOR sie je FINAL war: es war nichts genommen.
  product(db, 'pA2', null, 3); reload();
  const inv2 = altRechnung(db, 'pA2', 2, 3);
  classifyLegacyInvoiceLines(db as never);
  const c = meldung(() => imHaus(() => cancelInvoiceInHouse({ invoiceId: inv2, refundMethod: 'cash' }, 'branch-main')));
  reload();
  ok(c === '' && qty(db, 'pA2') === 3, `3A' Storno ohne früheren Abzug: Menge bleibt 3 (früher +1 → 4) (${c} ${qty(db, 'pA2')})`);
}
{
  // B — alte, bereits FINALe Rechnung: der alte Abzug lief schon (3→2).
  const db = neu();
  product(db, 'pB', null, 3); reload();
  const inv = altRechnung(db, 'pB', 2, 2, 'FINAL');
  classifyLegacyInvoiceLines(db as never);
  ok(legacyStock(db, inv) === 'deducted', `3B Einordnung FINAL: deducted (${S(legacyStock(db, inv))})`);
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'PARTIAL' }));
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv, { status: 'FINAL' }));
  await tick();
  imHaus(() => { void eventBus.emit('invoice.paid', 'invoice', inv, {}); });
  await tick();
  ok(qty(db, 'pB') === 2, `3B erneutes Speichern/FINAL/invoice.paid: KEIN zweiter Abzug (${qty(db, 'pB')})`);

  // B' — heute PARTIAL, aber das Protokoll zeigt einen früheren Übergang auf FINAL.
  product(db, 'pB2', null, 3); reload();
  const inv2 = altRechnung(db, 'pB2', 1, 2, 'PARTIAL');
  db.run(`INSERT INTO audit_log (id, module, entity_type, entity_id, action_type, field_name, old_value, new_value, changed_at)
    VALUES ('a-b2','Sales','invoices',?,'STATUS_CHANGE','status','PARTIAL','FINAL',?)`, [inv2, NOW]);
  classifyLegacyInvoiceLines(db as never);
  ok(legacyStock(db, inv2) === 'deducted', `3B' Protokoll zeigt früheres FINAL: deducted (${S(legacyStock(db, inv2))})`);
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv2, { status: 'FINAL' }));
  await tick();
  ok(qty(db, 'pB2') === 2, `3B' FINAL danach: kein zweiter Abzug (${qty(db, 'pB2')})`);
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv2, { status: 'PARTIAL' }));
  const c = meldung(() => imHaus(() => useInvoiceStore.getState().updateInvoice(inv2, { status: 'CANCELLED' })));
  ok(c === '' && qty(db, 'pB2') === 3 && legacyStock(db, inv2) === 'released',
    `3B' Storno gibt genau den EINEN alten Abzug zurück (2→3), Merker released (${qty(db, 'pB2')}/${S(legacyStock(db, inv2))})`);
}
{
  // C — alte Zeile qty 3, alter Abzug nur 1 (5→4). Nichts darf so tun, als wären 3 genommen.
  const db = neu();
  product(db, 'pC', null, 5); reload();
  const inv = altRechnung(db, 'pC', 3, 4, 'FINAL');
  classifyLegacyInvoiceLines(db as never);
  ok(legacyStock(db, inv) === 'deducted' && qty(db, 'pC') === 4, '3C SETUP deducted, Menge 4');
  // Retoure IN_STOCK der 3 Stück: Alt-Semantik (Status), KEIN Zurückbuchen von 3.
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  useSalesReturnStore.getState().loadReturns();
  const r = meldung(() => imHaus(() => useSalesReturnStore.getState().createReturn({
    invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', notes: 'C',
    lines: [{ invoiceLineId: lineId, productId: 'pC', quantity: 3, unitPrice: 1000, vatAmount: 300 }],
  } as never)));
  reload();
  ok(r === '' && qty(db, 'pC') === 4, `3C Retoure qty 3: Menge bleibt 4 (kein +3 für nie Genommenes) (${r} ${qty(db, 'pC')})`);
  // Ändern: fail-closed, nichts geändert.
  product(db, 'pC2', null, 5); reload();
  const inv2 = altRechnung(db, 'pC2', 3, 5);
  classifyLegacyInvoiceLines(db as never);
  const vor = zustand(db);
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv2, { lines: [LINE('pC2', 1)] as never, reason: 'x' })));
  ok(/^LEGACY_STOCK_LINES\|/.test(m) && zustand(db) === vor, `3C Ändern einer Altzeile: fail-closed, nichts geändert (${m.slice(0, 60)})`);
  // Die Kennung bleibt INTERN (Urteil/Protokoll); der Satz, den ein Mensch liest, trägt sie nicht.
  ok(m.split('|').slice(1).join('|') === LEGACY_STOCK_LINES_MESSAGE && !/LEGACY_STOCK_LINES/.test(LEGACY_STOCK_LINES_MESSAGE)
    && /cancel this invoice/i.test(LEGACY_STOCK_LINES_MESSAGE),
    `3C …die Meldung erklärt es in normalen Worten, ohne Fehlercode (${LEGACY_STOCK_LINES_MESSAGE.slice(0, 60)}…)`);
  // Löschen einer FINALen Altzeile (qty 3): genau 1 zurück, nicht 3.
  product(db, 'pC3', null, 5); reload();
  const inv3 = altRechnung(db, 'pC3', 3, 4, 'FINAL');
  classifyLegacyInvoiceLines(db as never);
  const d = meldung(() => imHaus(() => useInvoiceStore.getState().deleteInvoice(inv3)));
  reload();
  ok(d === '' && qty(db, 'pC3') === 5, `3C Löschen: genau der eine alte Abzug zurück (4→5), nicht 3 (${d} ${qty(db, 'pC3')})`);
}

// ══ 4 — Reparatur-Serviceprodukt ═══════════════════════════════════════════════
{
  const db = neu();
  // Wie repairStore es anlegt: quantity fällt auf den Spalten-Default.
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery,
      purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('svc-repair-branch-main','branch-main','cat-w','','Repair Service',NULL,'','[]',0,'BHD','in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  reload();
  const q0 = qty(db, 'svc-repair-branch-main');
  const inv = rechnung([LINE('svc-repair-branch-main', 1)]);
  ok(taken(db, inv) === 0 && qty(db, 'svc-repair-branch-main') === q0,
    `4 Service-Zeile: stock_taken 0, Menge unberührt (${S(taken(db, inv))}, ${q0}→${qty(db, 'svc-repair-branch-main')})`);
  const inv2 = rechnung([LINE('svc-repair-branch-main', 3)]);
  ok(taken(db, inv2) === 0 && qty(db, 'svc-repair-branch-main') === q0, '4 …auch qty 3: nichts genommen');
  voll(inv);
  ok(qty(db, 'svc-repair-branch-main') === q0 && st(db, 'svc-repair-branch-main') === 'in_stock',
    `4 …FINAL: Menge ${qty(db, 'svc-repair-branch-main')}, Status ${st(db, 'svc-repair-branch-main')}`);
  imHaus(() => useInvoiceStore.getState().updateInvoice(inv2, { status: 'CANCELLED' }));
  ok(qty(db, 'svc-repair-branch-main') === q0, '4 …Storno gibt nichts zurück');
  const lineId = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  useSalesReturnStore.getState().loadReturns();
  const r = meldung(() => imHaus(() => useSalesReturnStore.getState().createReturn({
    invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', notes: 'svc',
    lines: [{ invoiceLineId: lineId, productId: 'svc-repair-branch-main', quantity: 1, unitPrice: 1000, vatAmount: 100 }],
  } as never)));
  reload();
  ok(r === '' && qty(db, 'svc-repair-branch-main') === q0, `4 …Retoure: Menge unberührt (${r} ${qty(db, 'svc-repair-branch-main')})`);
  ok(n(db, "SELECT COUNT(*) FROM stock_lots WHERE product_id = 'svc-repair-branch-main'") === 0,
    '4 …über Rechnung, Zahlung, Storno und Retoure kein einziges Los entstanden');
  // „Neue Artikel mindestens Menge 1“ ändert nichts: die Ausnahme hängt an der Kennung, nicht an der Menge.
  db.run("UPDATE products SET quantity = 7 WHERE id = 'svc-repair-branch-main'");
  const inv3 = rechnung([LINE('svc-repair-branch-main', 2)]);
  ok(taken(db, inv3) === 0 && qty(db, 'svc-repair-branch-main') === 7, '4 …auch mit Menge 7: kein Lagerartikel, nichts genommen');
}

// ══ 5 — Auftrags-Einzelstück (Menge 1, ohne Los, 'reserved') ═══════════════════
// Simuliert über createDirectInvoice: der Auftragsweg legt das Stück per createProduct mit
// stockStatus 'reserved' an (order-invoice-lines) und ruft dann dieselbe createDirectInvoice.
{
  const db = neu();
  const p = useProductStore.getState().createProduct({
    categoryId: 'cat-w', brand: 'Eigen', name: 'Ring', images: [], stockStatus: 'reserved', sourceType: 'OWN', taxScheme: 'VAT_10',
  } as never);
  reload();
  ok(qty(db, p.id) === 1 && st(db, p.id) === 'reserved', `5 SETUP Auftragsstück: Menge 1, reserved (${qty(db, p.id)}/${st(db, p.id)})`);
  const inv = rechnung([LINE(p.id, 1)]);
  ok(qty(db, p.id) === 0 && taken(db, inv) === 1 && st(db, p.id) === 'reserved',
    `5 Rechnung nimmt 1: Menge 0, stock_taken 1, reserved (${qty(db, p.id)}/${S(taken(db, inv))}/${st(db, p.id)})`);
  voll(inv);
  ok(qty(db, p.id) === 0 && st(db, p.id) === 'sold', `5 …FINAL → sold, kein zweiter Abzug (${qty(db, p.id)}/${st(db, p.id)})`);
}

// ══ 6 — Kommission: recordSale ═════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'pC', null, 1, { status: 'consignment', source: 'CONSIGNMENT' });
  db.run("UPDATE products SET purchase_price = 0 WHERE id = 'pC'");
  insert(db, 'consignments', {
    id: 'cons-1', branch_id: 'branch-main', consignment_number: 'CN-1', consignor_id: 'cust-1', product_id: 'pC',
    agreed_price: 1000, commission_rate: 15, commission_type: 'percent', status: 'active', agreement_date: '2026-09-01',
    created_at: NOW, updated_at: NOW,
  });
  reload();
  useConsignmentStore.getState().loadConsignments();
  let res: { invoiceId: string; purchaseId: string } | null = null;
  const m = meldung(() => { res = imHaus(() => useConsignmentStore.getState().recordSale('cons-1', { salePrice: 1000, buyerId: 'cust-2' })); });
  reload();
  const r = res as { invoiceId: string; purchaseId: string } | null;
  ok(m === '' && !!r, `6 recordSale läuft (${m})`);
  if (r) {
    const lot = s(db, 'SELECT id FROM stock_lots WHERE purchase_id = ?', [r.purchaseId]);
    ok(lot !== '' && s(db, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [r.invoiceId]) === lot,
      '6 …Auto-Einkauf legt ein Los an, die Rechnung verbraucht genau dieses (Los-Weg)');
    ok(lotRem(db, lot) === 0 && qty(db, 'pC') === 0 && taken(db, r.invoiceId) === 1,
      `6 …Los 0, Menge 0, stock_taken 1 (${lotRem(db, lot)}/${qty(db, 'pC')}/${S(taken(db, r.invoiceId))})`);
    ok(st(db, 'pC') === 'consignment_reserved', `6 …Status consignment_reserved (${st(db, 'pC')})`);
    voll(r.invoiceId);
    ok(qty(db, 'pC') === 0 && lotRem(db, lot) === 0 && st(db, 'pC') === 'sold', `6 …FINAL → sold, kein zweiter Abzug (${qty(db, 'pC')}/${st(db, 'pC')})`);
  }
}

// ══ 7 — Agentenverkauf, Los-Artikel ═══════════════════════════════════════════
function transfer(pid: string, agentCustomer = 'cust-1'): string {
  const t = imHaus(() => useAgentStore.getState().createTransferForCustomer({ customerId: agentCustomer, productId: pid, ourPrice: 1000 }));
  reload();
  return t.id;
}
const tr = (db: Db, id: string, col: string): unknown => one(db, `SELECT ${col} FROM agent_transfers WHERE id = ?`, [id]);
{
  const db = neu();
  product(db, 'pAg', 2); reload();
  const t = transfer('pAg');
  ok(st(db, 'pAg') === 'with_agent', '7 SETUP Transfer: with_agent');
  const m = meldung(() => imHaus(() => useAgentStore.getState().markTransferSold(t, 1000)));
  reload();
  ok(m === '' && lotRem(db, 'lot-pAg') === 1 && qty(db, 'pAg') === 1,
    `7 markTransferSold verbraucht genau 1 Los-Stück: Los 2→1, Menge 1 (${m} ${lotRem(db, 'lot-pAg')}/${qty(db, 'pAg')})`);
  ok(tr(db, t, 'stock_taken') === 1 && tr(db, t, 'stock_lot_id') === 'lot-pAg' && tr(db, t, 'status') === 'sold',
    `7 …stock_taken 1, stock_lot_id lot-pAg, sold (${S(tr(db, t, 'stock_taken'))}/${S(tr(db, t, 'stock_lot_id'))})`);
  const soldLe = le(db, 'AGENT_TRANSFER_SOLD', t);
  ok(soldLe > 0 && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module='AGENT_TRANSFER_SOLD' AND source_id=? AND account='COGS' AND amount=100", [t]) === 1,
    `7 …Verkauf gebucht (${soldLe} Beine), COGS = Einstand des verbrauchten Loses (100)`);

  const vor = zustand(db);
  const m2 = meldung(() => imHaus(() => useAgentStore.getState().markTransferSold(t, 1000)));
  ok(/TRANSFER_NOT_OPEN/.test(m2) && zustand(db) === vor, `7 zweiter markTransferSold: abgelehnt, nichts geändert (${m2})`);

  const conv = imHaus(() => convertTransferInHouse(t, { customerId: 'cust-2' }, 'branch-main'));
  reload();
  const inv = conv.invoiceId;
  ok(taken(db, inv) === 0 && s(db, 'SELECT lot_id FROM invoice_lines WHERE invoice_id = ?', [inv]) === 'lot-pAg',
    `7 Umwandlung: Rechnungszeile stock_taken 0, lot_id lot-pAg (${S(taken(db, inv))})`);
  ok(lotRem(db, 'lot-pAg') === 1 && qty(db, 'pAg') === 1, `7 …Los unverändert 1, Menge 1 (${lotRem(db, 'lot-pAg')}/${qty(db, 'pAg')})`);
  ok(n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [inv]) === 100, '7 …Einstand der Zeile = Los-Einstand 100');
  ok(le(db, 'AGENT_TRANSFER_SOLD', t) === 2 * soldLe && le(db, 'INVOICE', inv) > 0,
    `10 Umwandlung: AGENT_TRANSFER_SOLD genau einmal storniert (${soldLe}→${le(db, 'AGENT_TRANSFER_SOLD', t)}), INVOICE gebucht (${le(db, 'INVOICE', inv)})`);
  const invLe = le(db, 'INVOICE', inv);

  // Löschen, solange umgewandelt → abgelehnt.
  const vorDel = zustand(db);
  const md = meldung(() => imHaus(() => useAgentStore.getState().deleteTransfer(t)));
  ok(/undo the conversion first/.test(md) && zustand(db) === vorDel, `7 deleteTransfer umgewandelt: abgelehnt, nichts geändert (${md})`);

  const mu = meldung(() => imHaus(() => undoTransferConversionInHouse(t, 'branch-main')));
  reload();
  ok(mu === '' && invStatus(db, inv) === 'CANCELLED' && !tr(db, t, 'invoice_id') && tr(db, t, 'status') === 'sold',
    `7 Undo: Rechnung CANCELLED, Transfer wieder sold ohne Rechnung (${mu} ${invStatus(db, inv)})`);
  ok(lotRem(db, 'lot-pAg') === 1 && qty(db, 'pAg') === 1 && tr(db, t, 'stock_taken') === 1,
    `7 …Los bleibt verbraucht: Los 1, Menge 1, stock_taken 1 (${lotRem(db, 'lot-pAg')}/${qty(db, 'pAg')})`);
  ok(le(db, 'AGENT_TRANSFER_SOLD', t) === 3 * soldLe && le(db, 'INVOICE', inv) === 2 * invLe,
    `10 Undo: Verkaufsforderung einmal neu (${le(db, 'AGENT_TRANSFER_SOLD', t)}), INVOICE einmal storniert (${le(db, 'INVOICE', inv)})`);

  const md2 = meldung(() => imHaus(() => useAgentStore.getState().deleteTransfer(t)));
  reload();
  ok(md2 === '' && lotRem(db, 'lot-pAg') === 2 && qty(db, 'pAg') === 2,
    `7 deleteTransfer verkauft/nicht umgewandelt: Los genau zurück 1→2, Menge 2 (${md2} ${lotRem(db, 'lot-pAg')}/${qty(db, 'pAg')})`);
  const arNet = n(db, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
    WHERE source_module='AGENT_TRANSFER_SOLD' AND source_id=? AND account='ACCOUNTS_RECEIVABLE'`, [t]);
  ok(st(db, 'pAg') === 'in_stock', `7 nach Undo+Delete: Stück wieder verkaufbar (${st(db, 'pAg')}), Forderung netto ${arNet}`);

  // Beobachtung (keine Vertragsprüfung): Einzelstück-Los verkauft, Transfer gelöscht → Status?
  product(db, 'pAg1', 1); reload();
  const t1 = transfer('pAg1');
  imHaus(() => useAgentStore.getState().markTransferSold(t1, 1000));
  reload();
  const stSold = st(db, 'pAg1');
  imHaus(() => useAgentStore.getState().deleteTransfer(t1));
  reload();
  ok(lotRem(db, 'lot-pAg1') === 1 && qty(db, 'pAg1') === 1, `7 Einzelstück: deleteTransfer gibt das Los zurück (${lotRem(db, 'lot-pAg1')}/${qty(db, 'pAg1')})`);
  ok(stSold === 'sold' && st(db, 'pAg1') === 'in_stock', `7 Einzelstück: nach Verkauf '${stSold}', nach deleteTransfer '${st(db, 'pAg1')}' (verkaufbar)`);

  // Kein offenes Los → STOCK_UNAVAILABLE, nichts geändert.
  product(db, 'pAg0', 1); reload();
  const t0 = transfer('pAg0');
  db.run("UPDATE stock_lots SET qty_remaining = 0, status = 'EXHAUSTED' WHERE id = 'lot-pAg0'");
  db.run("UPDATE products SET quantity = 0 WHERE id = 'pAg0'");
  reload();
  const vor0 = zustand(db);
  const m0 = meldung(() => imHaus(() => useAgentStore.getState().markTransferSold(t0, 1000)));
  ok(m0.includes(STOCK_UNAVAILABLE_MESSAGE) && zustand(db) === vor0,
    `7 markTransferSold ohne offenes Los: STOCK_UNAVAILABLE, nichts geändert (${m0})`);
  ok(tr(db, t0, 'status') === 'transferred', '7 …Transfer bleibt transferred');
}

// ══ 8 — Agentenverkauf ohne Los (Menge 1) ══════════════════════════════════════
{
  const db = neu();
  product(db, 'pAL', null, 1); reload();
  const t = transfer('pAL');
  imHaus(() => useAgentStore.getState().markTransferSold(t, 1000));
  reload();
  ok(qty(db, 'pAL') === 0 && st(db, 'pAL') === 'sold' && tr(db, t, 'stock_taken') === 1 && tr(db, t, 'stock_lot_id') === null,
    `8 markTransferSold: Menge 1→0, sold, stock_taken 1, kein Los (${qty(db, 'pAL')}/${st(db, 'pAL')})`);
  const soldLe = le(db, 'AGENT_TRANSFER_SOLD', t);
  const conv = imHaus(() => convertTransferInHouse(t, { customerId: 'cust-2' }, 'branch-main'));
  reload();
  ok(taken(db, conv.invoiceId) === 0 && qty(db, 'pAL') === 0 && st(db, 'pAL') === 'sold',
    `8 Umwandlung: stock_taken 0, kein zweiter Abzug (Menge ${qty(db, 'pAL')}, ${st(db, 'pAL')})`);
  ok(le(db, 'AGENT_TRANSFER_SOLD', t) === 2 * soldLe, `10 Umwandlung: AGENT_TRANSFER_SOLD genau einmal storniert (${le(db, 'AGENT_TRANSFER_SOLD', t)})`);
  const invLe = le(db, 'INVOICE', conv.invoiceId);
  voll(conv.invoiceId);
  await tick();
  ok(invStatus(db, conv.invoiceId) === 'FINAL' && qty(db, 'pAL') === 0 && st(db, 'pAL') === 'sold',
    `8 FINAL: kein Abzug, Menge 0 (nicht negativ), sold (${qty(db, 'pAL')})`);
  ok(le(db, 'INVOICE', conv.invoiceId) === invLe && le(db, 'AGENT_TRANSFER_SOLD', t) === 2 * soldLe,
    '10 FINAL nach Umwandlung: INVOICE und AGENT_TRANSFER_SOLD unverändert');
  const cogs = (mod: string, id: string): number => n(db,
    "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'COGS' AND source_module = ? AND source_id = ? AND reverses_entry_id IS NULL", [mod, id]);
  ok(cogs('AGENT_TRANSFER_SOLD', t) === 100, `8 Einstand Agentenverkauf ohne Los = purchase_price 100 (${cogs('AGENT_TRANSFER_SOLD', t)})`);
  ok(cogs('INVOICE', conv.invoiceId) === 100, `8 …Einstand der umgewandelten Rechnung ebenfalls 100 (${cogs('INVOICE', conv.invoiceId)})`);
}
{
  // 8b — ohne Los: Undo gibt nichts zurück (der Verkauf hält), Löschen danach genau 1.
  const db = neu();
  product(db, 'pAU', null, 2); reload();
  const t = transfer('pAU');
  imHaus(() => useAgentStore.getState().markTransferSold(t, 1000));
  reload();
  ok(qty(db, 'pAU') === 1, `8b Verkauf: Menge 2→1 (${qty(db, 'pAU')})`);
  imHaus(() => convertTransferInHouse(t, { customerId: 'cust-2' }, 'branch-main'));
  reload();
  ok(qty(db, 'pAU') === 1, `8b Umwandlung: kein zweiter Abzug (${qty(db, 'pAU')})`);
  imHaus(() => undoTransferConversionInHouse(t, 'branch-main'));
  reload(); useAgentStore.getState().loadTransfers();
  ok(qty(db, 'pAU') === 1 && tr(db, t, 'stock_taken') === 1, `8b Undo: Menge bleibt 1, der Verkauf hält das Stück (${qty(db, 'pAU')})`);
  imHaus(() => useAgentStore.getState().deleteTransfer(t));
  reload();
  ok(qty(db, 'pAU') === 2 && st(db, 'pAU') === 'in_stock', `8b Löschen: genau 1 zurück 1→2, in_stock (${qty(db, 'pAU')}/${st(db, 'pAU')})`);
}

// ══ 9 — Produktion ═════════════════════════════════════════════════════════════
{
  const db = neu();
  product(db, 'pIn', 1);
  // Ein zweites Los desselben Eingangs, anderswo verkauft (leer) — darf NIE aufgefüllt werden.
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-pIn-old','branch-main','pIn',100,1,0,'EXHAUSTED',?,?)`, ['2026-01-01T00:00:00.000Z', NOW]);
  product(db, 'pLess', null, 1);
  reload();
  useProductStore.getState().loadCategories();
  const OUT = { spec: { categoryId: 'cat-w', brand: 'Custom', name: 'Ring X', condition: 'New', taxScheme: 'MARGIN', attributes: {}, images: [] }, value: 200 };
  const made = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn', 'pLess'], outputs: [OUT] as never }, { branchId: 'branch-main', userId: 'user-test' }));
  const cons = (pid: string): unknown => JSON.parse(s(db, 'SELECT lot_consumption FROM production_inputs WHERE record_id = ? AND product_id = ?', [made.recordId, pid]) || 'null');
  ok(S(cons('pIn')) === S({ lots: [{ lotId: 'lot-pIn', qty: 1 }], qty: 0, prevStatus: 'in_stock' }), `9 lot_consumption Los-Eingang ${S(cons('pIn'))}`);
  ok(S(cons('pLess')) === S({ lots: [], qty: 1, prevStatus: 'in_stock' }), `9 lot_consumption ohne Los ${S(cons('pLess'))}`);
  ok(lotRem(db, 'lot-pIn') === 0 && qty(db, 'pIn') === 0 && st(db, 'pIn') === 'consumed', '9 …Los-Eingang verbraucht (Los 0, Menge 0, consumed)');
  ok(qty(db, 'pLess') === 0 && st(db, 'pLess') === 'consumed', `9 …Eingang ohne Los: Menge 1→0, consumed (${qty(db, 'pLess')})`);
  ok(lotRem(db, 'lot-pIn-old') === 0, '9 …fremdes altes Los unberührt 0');

  useProductionStore.getState().loadRecords();
  const md = meldung(() => imHaus(() => useProductionStore.getState().deleteRecord(made.recordId)));
  reload();
  ok(md === '' && n(db, 'SELECT COUNT(*) FROM production_records WHERE id = ?', [made.recordId]) === 0, `9 Löschen läuft (${md})`);
  ok(lotRem(db, 'lot-pIn') === 1 && qty(db, 'pIn') === 1 && st(db, 'pIn') === 'in_stock',
    `9 …Los-Eingang genau zurück: Los 1, Menge 1, in_stock (${lotRem(db, 'lot-pIn')}/${qty(db, 'pIn')}/${st(db, 'pIn')})`);
  ok(lotRem(db, 'lot-pIn-old') === 0 && s(db, "SELECT status FROM stock_lots WHERE id = 'lot-pIn-old'") === 'EXHAUSTED',
    `9 …das anderswo verkaufte Los wird NICHT aufgefüllt (${lotRem(db, 'lot-pIn-old')})`);
  ok(qty(db, 'pLess') === 1 && st(db, 'pLess') === 'in_stock', `9 …Eingang ohne Los: Menge genau 1, in_stock (${qty(db, 'pLess')}/${st(db, 'pLess')})`);
  ok(n(db, 'SELECT COUNT(*) FROM products WHERE id = ?', [made.outputProductIds[0]]) === 0, '9 …Ausgang entfernt');

  // Altproduktion ohne Nachweis → Löschen abgelehnt, nichts geändert.
  const made2 = await imHausAsync(() => createProductionInHouse(
    { inputProductIds: ['pIn'], outputs: [{ ...OUT, value: 100 }] as never }, { branchId: 'branch-main', userId: 'user-test' }));
  db.run('UPDATE production_inputs SET lot_consumption = NULL WHERE record_id = ?', [made2.recordId]);
  useProductionStore.getState().loadRecords();
  const vor = zustand(db);
  const ml = meldung(() => imHaus(() => useProductionStore.getState().deleteRecord(made2.recordId)));
  ok(/PRODUCTION_LEGACY_NO_CONSUMPTION/.test(ml) && zustand(db) === vor, `9 Altproduktion (NULL): Löschen abgelehnt, nichts geändert (${ml.slice(0, 60)})`);
  ok(lotRem(db, 'lot-pIn') === 0 && lotRem(db, 'lot-pIn-old') === 0, '9 …kein Los aufgefüllt');
}

// ══ 11 — Retoure eines Artikels ohne Los ═══════════════════════════════════════
function retoure(invId: string, productId: string): string {
  const lineId = s(current(), 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [invId]);
  const id = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const rid = rs.createReturn({
      invoiceId: invId, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defekt',
      lines: [{ invoiceLineId: lineId, productId, quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    }).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    return rid;
  });
  reload();
  return id;
}
{
  const db = neu();
  product(db, 'pR', null, 1); reload();
  const inv = rechnung([LINE('pR', 1)]);
  voll(inv);
  ok(qty(db, 'pR') === 0 && st(db, 'pR') === 'sold', '11 SETUP verkauft + bezahlt: Menge 0, sold');
  const rid = retoure(inv, 'pR');
  ok(qty(db, 'pR') === 1 && st(db, 'pR') === 'in_stock', `11 Retoure IN_STOCK: Menge genau 0→1, in_stock (${qty(db, 'pR')}/${st(db, 'pR')})`);
  const c = meldung(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid, 'Storno', OWNER_ACTOR, 'branch-main')));
  reload();
  ok(c === '' && qty(db, 'pR') === 0, `11 Retoure-Storno nimmt das Stück genau wieder: Menge 0 (${c} ${qty(db, 'pR')}/${st(db, 'pR')})`);

  // Wiederverkauft → Retoure-Storno abgelehnt, nichts geändert.
  const db2 = neu();
  product(db2, 'pR', null, 1); reload();
  const inv2 = rechnung([LINE('pR', 1)]);
  voll(inv2);
  const rid2 = retoure(inv2, 'pR');
  rechnung([LINE('pR', 1)], 'cust-2');
  ok(qty(db2, 'pR') === 0, '11 SETUP zurückgenommenes Stück wiederverkauft: Menge 0');
  const vor = zustand(db2);
  const c2 = meldung(() => imHaus(() => cancelReturnHouse.cancelReturnInHouse(rid2, 'Storno', OWNER_ACTOR, 'branch-main')));
  ok(/RETURN_STOCK_RESOLD/.test(c2) && zustand(db2) === vor, `11 Retoure-Storno nach Wiederverkauf: RETURN_STOCK_RESOLD, nichts geändert (${c2.slice(0, 40)})`);
}

console.log(`\nstock-lot-integrity: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

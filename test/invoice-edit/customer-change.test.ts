// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S3 — Kundenwechsel an Rechnungen mit Zahlungen: die Zahlungsbeine ziehen mit um.
// Run: node --experimental-strip-types test/invoice-edit/customer-change.test.ts
//
//   1 unbezahlt · 2 teilbezahlt bar (Bestätigung) · 3 voll bezahlt Bank + Karte · 4 Sperren
//   (Guthaben, Guthaben-Zahlung, Retoure/Gutschrift, neue Zahlung, fremder Kunde, Auftrag)
//   5 Rollback · 6 PC2 · 7 Maske (Quelltext)
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
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const {
  CUSTOMER_CHANGE_NEEDS_CONFIRMATION, CUSTOMER_CHANGE_WITH_NEW_PAYMENT, CUSTOMER_CHANGE_HAS_CREDIT,
  CUSTOMER_CHANGE_HAS_RETURN, CUSTOMER_CHANGE_FROM_ORDER, CUSTOMER_NOT_FOUND,
} = await import('../../src/core/invoices/customer-change.ts');
const { EDIT_KEPT_LINE_LOT_SHORT } = await import('../../src/core/invoices/edit-lines.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void useCreditNoteStore; void voll;

// ── Messgrößen ─────────────────────────────────────────────────────────────────────────────
/** Forderung eines Kunden im Hauptbuch (Soll − Haben). */
const arBuch = (db: Db, cust: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries
    WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [cust]);
/** Forderung eines Kunden aus den Rechnungen (Brutto − Bezahlt, ohne Storno). */
const arRechnung = (db: Db, cust: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(gross_amount - paid_amount), 3), 0) FROM invoices WHERE customer_id = ? AND status NOT IN ('CANCELLED', 'DRAFT')`, [cust]);
const konto = (db: Db, acc: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries WHERE account = ?`, [acc]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
function kundenkontenOk(db: Db): string {
  const run = (sql: string, p: unknown[] = []) => {
    const r = db.exec(sql, p)[0];
    return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
  };
  const a = runCounterpartyAudit(run as never, 'branch-main');
  const bad = [...a.arByCustomer.rows, ...a.customerCreditByCustomer.rows].filter((r) => r.status !== 'ok');
  return bad.map((r) => `${r.account}:${r.id} ${r.diffFils}`).join(', ') + (a.issues.length ? ` issues:${a.issues.map((i) => i.kind).join('/')}` : '');
}
/** Die Zahlungszeilen, wie sie gespeichert sind — der Nachweis darf sich nicht ändern. */
const zahlungen = (db: Db, inv: string): string =>
  all(db, 'SELECT id, amount, method, reference, received_at, notes, created_at, created_by, card_brand FROM payments WHERE invoice_id = ? ORDER BY id', [inv]);
function zustand(db: Db): string {
  return S({
    inv: all(db, 'SELECT id, customer_id, invoice_number, status, gross_amount, paid_amount FROM invoices ORDER BY id'),
    pay: all(db, 'SELECT * FROM payments ORDER BY id'),
    lines: all(db, 'SELECT * FROM invoice_lines ORDER BY id'),
    lots: all(db, 'SELECT id, qty_remaining FROM stock_lots ORDER BY id'),
    cc: all(db, 'SELECT id, customer_id, amount, used_amount FROM customer_credits ORDER BY id'),
    le: n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    ed: n(db, 'SELECT COUNT(*) FROM invoice_edits'),
  });
}

/** Eine Rechnung für Ali (cust-1): ein Artikel à 1000 netto, 1100 brutto, Los mit `menge` Stück. */
function welt(menge = 1): { db: Db; inv: string; z: string } {
  const db = neu();
  product(db, 'pA', menge);
  reload();
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ ...LINE('pA', 1, 1000), lotId: 'lot-pA' }] as never, 'S3').id);
  reload();
  return { db, inv, z: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}
function zahle(inv: string, betrag: number, art: string, brand?: string): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, art, 'S3-Zahlung', undefined, brand as never));
  reload();
  return id;
}
const ZEILE = (z: string, qty = 1) => ({ lineId: z, ...LINE('pA', qty, 1000), lotId: 'lot-pA' });
function wechsel(inv: string, z: string, kunde: string, opts: { confirm?: boolean; delta?: number; qty?: number } = {}): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [ZEILE(z, opts.qty ?? 1)] as never, customerId: kunde, reason: 'Falscher Kunde',
    ...(opts.confirm ? { confirmCustomerChange: true } : {}),
    ...(opts.delta ? { deltaPayment: { amount: opts.delta, method: 'cash' } } : {}),
  } as never)));
  reload();
  return m;
}
const kunde = (db: Db, inv: string): string => s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]);
const nummer = (db: Db, inv: string): string => s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [inv]);

// 1) Unbezahlt — wie bisher, ohne Bestätigung.
{
  const { db, inv, z } = welt();
  const nr = nummer(db, inv);
  const m = wechsel(inv, z, 'cust-2');
  ok(m === '' && kunde(db, inv) === 'cust-2' && nummer(db, inv) === nr,
    `1 unbezahlt: Kunde gewechselt ohne Bestätigung, Nummer bleibt ${nr} (${m})`);
  ok(arBuch(db, 'cust-1') === 0 && arBuch(db, 'cust-2') === 1100 && kundenkontenOk(db) === '' && ausgeglichen(db),
    `1 …Forderung ganz bei Nora (Ali ${arBuch(db, 'cust-1')}, Nora ${arBuch(db, 'cust-2')}) ${kundenkontenOk(db)}`);
}

// 2) Teilbezahlt bar — nur mit Bestätigung; Zahlung zieht mit, Nachweis bleibt.
{
  const { db, inv, z } = welt();
  const pid = zahle(inv, 400, 'cash');
  const nr = nummer(db, inv);
  const nachweis = zahlungen(db, inv);
  const empfangen = s(db, 'SELECT received_at FROM payments WHERE id = ?', [pid]);
  const vor = zustand(db);
  const m0 = wechsel(inv, z, 'cust-2');
  ok(m0.startsWith(CUSTOMER_CHANGE_NEEDS_CONFIRMATION + '|') && zustand(db) === vor && /Ali Hassan to Nora Hassan/.test(m0),
    `2 ohne Bestätigung: abgewiesen, nichts geändert (${m0.split('|')[1]?.slice(0, 80)})`);
  const lot = n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pA'");
  const m = wechsel(inv, z, 'cust-2', { confirm: true });
  ok(m === '' && kunde(db, inv) === 'cust-2' && nummer(db, inv) === nr && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'PARTIAL',
    `2 bestätigt: Kunde Nora, Nummer ${nr} bleibt, Status PARTIAL (${m})`);
  ok(zahlungen(db, inv) === nachweis, '2 …Zahlungsnachweis unverändert (ID, Betrag, Art, Referenz, Datum, Notiz)');
  ok(arBuch(db, 'cust-1') === 0 && arBuch(db, 'cust-2') === 700 && arRechnung(db, 'cust-2') === 700 && arRechnung(db, 'cust-1') === 0,
    `2 …Forderung: Ali 0, Nora 700 in Buch und Rechnung (${arBuch(db, 'cust-1')}/${arBuch(db, 'cust-2')})`);
  ok(konto(db, 'CASH') === 400 && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'CASH' AND occurred_at != ?", [empfangen]) === 0,
    `2 …Kasse 400, alle Kassenbuchungen auf dem Zahlungsdatum (keine Doppel-Kasse zwischendurch) (${konto(db, 'CASH')})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PAYMENT' AND source_id = ? AND reverses_entry_id IS NULL AND counterparty_id = 'cust-2'", [pid]) === 2,
    '2 …die Zahlung ist beim neuen Kunden gebucht (Storno beim alten bleibt als Spur)');
  ok(kundenkontenOk(db) === '' && ausgeglichen(db) && n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-pA'") === lot,
    `2 …Kundenkonten stimmen je Kunde, Hauptbuch ausgeglichen, Bestand unberührt ${kundenkontenOk(db)}`);
  const snap = s(db, 'SELECT new_snapshot FROM invoice_edits WHERE invoice_id = ? ORDER BY revision DESC LIMIT 1', [inv]);
  ok(/"customerChange":\{"from":"cust-1","to":"cust-2","paymentsMoved":\["/.test(snap) && snap.includes(pid)
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name LIKE 'customer (rev %'", [inv]) === 1,
    '2 …Audit: Revision nennt alten/neuen Kunden und die umgebuchte Zahlung, Verlaufseintrag „customer"');
  // Danach wirkt alles beim RICHTIGEN Kunden: Zahlung löschen bucht bei Nora zurück.
  imHaus(() => useInvoiceStore.getState().deletePayment(pid, inv));
  reload();
  ok(arBuch(db, 'cust-1') === 0 && arBuch(db, 'cust-2') === 1100 && kundenkontenOk(db) === '' && ausgeglichen(db),
    `2 …Zahlung danach gelöscht: Nora wieder 1100, Ali bleibt 0 (${arBuch(db, 'cust-1')}/${arBuch(db, 'cust-2')})`);
}

// 3) Voll bezahlt per Bank (plus Karte) — Endnummer bleibt, Kartengebühr unberührt.
{
  const { db, inv, z } = welt();
  zahle(inv, 600, 'bank_transfer');
  zahle(inv, 500, 'card', 'normal');
  const nr = nummer(db, inv);
  const gebuehr = all(db, "SELECT id, amount, status FROM expenses WHERE category = 'CardFees' ORDER BY id");
  const nachweis = zahlungen(db, inv);
  const bank = konto(db, 'BANK'); const karte = konto(db, 'CARD_CLEARING');
  const m = wechsel(inv, z, 'cust-2', { confirm: true });
  ok(m === '' && kunde(db, inv) === 'cust-2' && nummer(db, inv) === nr && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'FINAL',
    `3 voll bezahlt: Nora, Endnummer ${nr} bleibt, FINAL (${m})`);
  ok(zahlungen(db, inv) === nachweis && all(db, "SELECT id, amount, status FROM expenses WHERE category = 'CardFees' ORDER BY id") === gebuehr,
    '3 …beide Zahlungsnachweise und die Kartengebühr unverändert');
  ok(konto(db, 'BANK') === bank && konto(db, 'CARD_CLEARING') === karte && bank === 600,
    `3 …Bank ${konto(db, 'BANK')}, Karte ${konto(db, 'CARD_CLEARING')} unverändert`);
  ok(arBuch(db, 'cust-1') === 0 && arBuch(db, 'cust-2') === 0 && kundenkontenOk(db) === '' && ausgeglichen(db),
    `3 …Forderung beider Kunden 0, je Kunde stimmig ${kundenkontenOk(db)}`);
  // Zurück zu Ali — derselbe Weg, zweiter Zyklus.
  const m2 = wechsel(inv, z, 'cust-1', { confirm: true });
  ok(m2 === '' && kunde(db, inv) === 'cust-1' && zahlungen(db, inv) === nachweis && kundenkontenOk(db) === '' && ausgeglichen(db),
    `3 …und zurück zu Ali: zweiter Zyklus sauber (${m2})`);
}

// 4) Sperren — jeweils nichts geändert.
{
  // a) Überzahlungsguthaben aus dieser Rechnung.
  const { db, inv, z } = welt();
  zahle(inv, 1300, 'cash');
  const vor = zustand(db);
  const m = wechsel(inv, z, 'cust-2', { confirm: true });
  ok(m.startsWith(CUSTOMER_CHANGE_HAS_CREDIT + '|') && zustand(db) === vor,
    `4a Überzahlungsguthaben: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 70)})`);
}
{
  // b) Rate mit Kundenguthaben bezahlt (Guthaben des alten Kunden, als Zahlungszeile 'credit').
  const b = welt();
  const db2 = b.db;
  db2.run(`INSERT INTO customer_credits (id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, note, created_at, created_by)
    VALUES ('cc-1','branch-main','cust-1','manual','x',200,200,'USED','Test',?, 'user-test')`, [NOW]);
  db2.run(`INSERT INTO payments (id, branch_id, invoice_id, amount, method, reference, received_at, notes, created_at, created_by)
    VALUES ('pay-credit','branch-main',?,200,'credit','cc-1',?,NULL,?, 'user-test')`, [b.inv, NOW, NOW]);
  db2.run('UPDATE invoices SET paid_amount = 200 WHERE id = ?', [b.inv]);
  reload();
  const vor = zustand(db2);
  const m = wechsel(b.inv, b.z, 'cust-2', { confirm: true });
  ok(m.startsWith(CUSTOMER_CHANGE_HAS_CREDIT + '|') && zustand(db2) === vor,
    `4b mit Guthaben bezahlte Rate: abgewiesen, nichts geändert (${m.slice(0, 50)})`);
}
{
  // c) Retoure/Gutschrift — auch ohne weitere Prüfung der Zahlungen gesperrt.
  const { db, inv, z } = welt(2);
  zahle(inv, 1100, 'cash');
  imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: inv, refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'S3',
      lines: [{ invoiceLineId: z, productId: 'pA', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
  });
  reload();
  const vor = zustand(db);
  const m = wechsel(inv, z, 'cust-2', { confirm: true });
  ok(m.startsWith(CUSTOMER_CHANGE_HAS_RETURN + '|') && zustand(db) === vor,
    `4c Retoure/Gutschrift: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 70)})`);
}
{
  // d) Neue Zahlung im selben Speichern · e) fremder / unbekannter Kunde · f) Rechnung aus Auftrag.
  const { db, inv, z } = welt();
  zahle(inv, 400, 'cash');
  const vor = zustand(db);
  const md = wechsel(inv, z, 'cust-2', { confirm: true, delta: 100 });
  ok(md.startsWith(CUSTOMER_CHANGE_WITH_NEW_PAYMENT + '|') && zustand(db) === vor, `4d Wechsel + neue Zahlung: abgewiesen (${md.slice(0, 50)})`);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zweig',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-x','branch-2','Fremd','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  const vor2 = zustand(db);
  const me = wechsel(inv, z, 'cust-x', { confirm: true });
  const mu = wechsel(inv, z, 'cust-gibtsnicht', { confirm: true });
  ok(me.startsWith(CUSTOMER_NOT_FOUND + '|') && mu.startsWith(CUSTOMER_NOT_FOUND + '|') && zustand(db) === vor2,
    `4e Kunde einer anderen Filiale / unbekannt: abgewiesen (${me.slice(0, 30)} / ${mu.slice(0, 30)})`);
  insert(db, 'order_lines', { id: 'ol-1', order_id: 'ord-1', invoice_id: inv });
  const mf = wechsel(inv, z, 'cust-2', { confirm: true });
  ok(mf.startsWith(CUSTOMER_CHANGE_FROM_ORDER + '|') && zustand(db) === vor2, `4f Rechnung aus Auftrag mit Zahlung: abgewiesen (${mf.slice(0, 40)})`);
}

// 5) Rollback — scheitert der Edit NACH dem Umbuchen der Zahlungen, bleibt alles beim Alten.
{
  const { db, inv, z } = welt();
  zahle(inv, 400, 'cash');
  const vor = zustand(db);
  const m = wechsel(inv, z, 'cust-2', { confirm: true, qty: 2 });   // Los hat kein zweites Stück
  ok(m.startsWith(EDIT_KEPT_LINE_LOT_SHORT + '|') && zustand(db) === vor && arBuch(db, 'cust-1') === 700 && arBuch(db, 'cust-2') === 0,
    `5 Fehler nach dem Umbuchen: voller Rollback — Kunde, Zahlungen, Buchungen unverändert (${m.slice(0, 40)})`);
  ok(kundenkontenOk(db) === '' && ausgeglichen(db), '5 …Kundenkonten stimmen weiter');
}

// 6) PC2 — dieselbe Regel, fachliche Neins endgültig.
{
  const { db, inv, z } = welt();
  zahle(inv, 400, 'cash');
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h' + x });
  const rev = (): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
  const body = (extra: Record<string, unknown> = {}) => ({
    id: inv, expectedRevision: rev(), reason: 'PC2 Kundenwechsel', customerId: 'cust-2',
    lines: [{ lineId: z, productId: 'pA', lotId: 'lot-pA', quantity: 1, unitPrice: 1000 }], ...extra,
  });
  const vor = zustand(db);
  const a = await runInvoiceUpdate(d as never, ident('61') as never, body());
  reload();
  ok(a.kind === 'rejected' && (a as { code: string }).code === CUSTOMER_CHANGE_NEEDS_CONFIRMATION && (a as { frozen: boolean }).frozen === true
    && zustand(db) === vor, `6 PC2 ohne Bestätigung: endgültige Absage (${(a as { code?: string }).code})`);
  let typfehler = '';
  try { await runInvoiceUpdate(d as never, ident('62') as never, body({ confirmCustomerChange: 'ja' })); } catch (e) { typfehler = (e as Error).message; }
  ok(/confirmCustomerChange must be true or false/.test(typfehler), `6 PC2 Bestätigung kein Wahrheitswert: Rumpf abgewiesen (${typfehler})`);
  const b = await runInvoiceUpdate(d as never, ident('63') as never, body({ confirmCustomerChange: true }));
  reload();
  ok(b.kind === 'ok' && kunde(db, inv) === 'cust-2' && arBuch(db, 'cust-1') === 0 && arBuch(db, 'cust-2') === 700
    && kundenkontenOk(db) === '' && ausgeglichen(db),
    `6 PC2 mit Bestätigung: wie am Primary (Ali ${arBuch(db, 'cust-1')}, Nora ${arBuch(db, 'cust-2')}) (${b.kind})`);
  // Guthaben-Sperre über PC2.
  const w = welt();
  zahle(w.inv, 1300, 'cash');
  const d2 = { ...d, db: w.db as never };
  const vor2 = zustand(w.db);
  const c = await runInvoiceUpdate(d2 as never, ident('64') as never, {
    id: w.inv, expectedRevision: n(w.db, 'SELECT revision FROM invoices WHERE id = ?', [w.inv]), reason: 'PC2', customerId: 'cust-2',
    confirmCustomerChange: true, lines: [{ lineId: w.z, productId: 'pA', lotId: 'lot-pA', quantity: 1, unitPrice: 1000 }],
  });
  reload();
  ok(c.kind === 'rejected' && (c as { code: string }).code === CUSTOMER_CHANGE_HAS_CREDIT && (c as { frozen: boolean }).frozen === true
    && zustand(w.db) === vor2, `6 PC2 mit Guthaben: endgültige Absage (${(c as { code?: string }).code})`);
}

// 7) Maske — Bestätigung vor dem Speichern, dieselbe Absicht an beide Anschlüsse.
{
  const m = src('src/pages/invoices/InvoiceCreate.tsx');
  ok(/customerChanges && originalPaid > 0\.005/.test(m) && /window\.confirm\(/.test(m), 'Q Maske fragt bei Zahlungen ausdrücklich nach');
  ok((m.match(/\.\.\.\(confirmCustomerChange \? \{ confirmCustomerChange \} : \{\}\)/g) ?? []).length === 2,
    'Q …und reicht die Bestätigung an Primary und PC2 weiter');
  ok(/save the customer change first, then record the payment/.test(m), 'Q …neue Zahlung im selben Speichern wird vorher gemeldet');
  const store = src('src/stores/invoiceStore.ts');
  ok(!/Cannot change the customer of an invoice that has payments/.test(store) && /moveInvoicePayments\(customerPlan\)/.test(store),
    'Q die alte Pauschalsperre ist ersetzt; Umbuchen läuft in der Edit-Transaktion');
}
void current;

console.log(`\ninvoice-edit-customer-change: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

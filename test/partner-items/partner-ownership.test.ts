// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — Lieferantenrückgabe mit Partnerauflösung, Übernahme durch LATAIF, Partnerwechsel,
// Rückkehr nach Übernahme, Kundenreparatur-Sperre, PC2-Befehle.
// Run: node --experimental-strip-types test/partner-items/partner-ownership.test.ts
// ════════════════════════════════════════════════════════════════════════════
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
const { usePurchaseStore, loadPurchasesFor } = await import('../../src/stores/purchaseStore.ts');
const { usePartnerStore, loadPartnersFor } = await import('../../src/stores/partnerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const rules = await import('../../src/core/partners/item-participation.ts');
const house = await import('../../src/core/partners/item-participation-house.ts');
const save = await import('../../src/core/partners/item-participation-save.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-26T10:00:00.000Z';

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
  usePurchaseStore.getState().loadPurchases();
  usePartnerStore.getState().loadPartners();
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
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  for (const [id, name, active] of [['pa-b', 'Bashir', 1], ['pa-c', 'Chalid', 1], ['pa-off', 'Old Partner', 0]] as Array<[string, string, number]>) {
    db.run(`INSERT INTO partners (id, branch_id, name, share_percentage, active, created_at, updated_at)
      VALUES (?, 'branch-main', ?, 0, ?, ?, ?)`, [id, name, active, NOW, NOW]);
  }
  for (const pid of ['pw1', 'pw2', 'pw3', 'pw4', 'pw5']) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
    [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
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
async function code(p: () => unknown): Promise<string> {
  try { await p(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)); }
}
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };
type PI = import('../../src/core/purchases/purchase-create.ts').PurchaseCreateInput;
const EINKAUF = (lines: PI['lines'], pay = 0): PI => ({
  supplierId: 'sup-1', purchaseDate: '2026-09-20', taxScheme: 'ZERO', lines,
  paymentAmount: pay, paymentMethod: 'bank', notes: '', staffId: '',
});
const ZEILE = (productId: string, price = 1000, partnerShares?: Array<{ partnerId: string; sharePct: number }>, qty = 1): PI['lines'][number] => ({
  mode: 'existing', productId, brand: 'Rolex', name: 'Sub ' + productId, sku: 'SKU-' + productId, categoryId: 'cat-w',
  quantity: qty, unitPrice: price, ...(partnerShares ? { partnerShares } : {}),
});
const lineOf = (db: Db, purchaseId: string, productId: string): string =>
  s(db, 'SELECT id FROM purchase_lines WHERE purchase_id = ? AND product_id = ?', [purchaseId, productId]);
const lotOf = (db: Db, purchaseLineId: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [purchaseLineId]);
const open = (lineId: string, partnerId = 'pa-b'): number => house.partnerItemOpen(lineId, partnerId, 'branch-main');
const bal = (account: string): number => {
  const db = DB;
  return n(db, `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?`, [account]);
};
const move = (lineId: string, kind: 'CONTRIBUTION' | 'PAYOUT', amount: number, partnerId = 'pa-b', method: 'cash' | 'bank' | 'benefit' = 'bank') =>
  save.recordItemMovementOnPrimary({ purchaseLineId: lineId, partnerId, kind, amount, method, date: '2026-09-21' });

function verkauf(db: Db, productId: string, lotId: string, price: number, pay: 'none' | 'part' | 'full', qty = 1): { inv: string; il: string } {
  // Wie die Maske: mit gewähltem Los reist dessen Einstand als purchasePrice mit.
  const unitCost = n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotId]);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId, quantity: qty, unitPrice: price, purchasePrice: unitCost, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0,
    lineTotal: price * qty, lotId,
  }] as never, 'P').id);
  reload();
  const brutto = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  if (pay !== 'none') imHaus(() => useInvoiceStore.getState().recordPayment(inv, pay === 'full' ? brutto : brutto / 2, 'cash'));
  reload();
  return { inv, il: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]) };
}


const cmd2 = await import('../../src/core/bridge/partner-item-commands.ts');
const plc = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const { createReturnInHouse } = await import('../../src/core/returns/return-house.ts');
const { returnToSupplierInHouse, cancelPurchaseInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { localHouseCtx, applyCreditToPurchaseInHouse } = await import('../../src/core/payables/payables-house.ts');
const { shiftOwnRepairCost } = await import('../../src/core/repairs/repair-cost-booking.ts');
const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
void CTX; void cmd; void loadPartnersFor; void bankTransactionsFor; void purchaseRules;

const DB = freshDb();
for (let i = 6; i <= 30; i++) {
  const pid = 'pw' + i;
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
const kauf = async (pid: string, price: number, shares: Array<{ partnerId: string; sharePct: number }> | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, refundMethod = 'cash') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice }] }, localHouseCtx()));
const supplierPayments = () => n(DB, 'SELECT COUNT(*) FROM purchase_payments');
const view = (line: string, partnerId = 'pa-b') => house.partnerItemsOverview('branch-main', partnerId)[0]?.items.find((i) => i.purchaseLineId === line);
const own = (line: string) => house.ownershipViewOf(line, 'branch-main');
const takeOver = (line: string, value: number) => save.takeOverOnPrimary({ purchaseLineId: line, expectedValue: value });
const change = (line: string, value: number, partnerShares: Array<{ partnerId: string; sharePct: number }>) =>
  save.changePartnersOnPrimary({ purchaseLineId: line, expectedValue: value, partnerShares });
const PB = [{ partnerId: 'pa-b', sharePct: 50 }];

// ── 1 Lieferantenrückgabe: volle Erstattung (Beispiel des Nutzers) ──────────
{
  const a = await kauf('pw6', 1000, PB, 1, 600);
  await move(a.line, 'CONTRIBUTION', 400);
  ok(open(a.line) === -100, 'RÜCKGABE vorher: B schuldet 100');
  const pays = supplierPayments();
  const r = ret(a.id, a.line, 1, 1000, 'cash');
  ok(r.status === 'COMPLETED' && r.refundAmount === 600, `RÜCKGABE über den bestehenden Weg: 600 zurück, 400 Lieferantenschuld entfällt (${S([r.status, r.refundAmount])})`);
  ok(open(a.line) === 400, `RÜCKGABE B bekommt seine 400 zurück, die offenen 100 entfallen (${open(a.line)})`);
  ok(supplierPayments() === pays, 'RÜCKGABE keine zusätzliche Lieferantenzahlung');
  ok(n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'SUPPLIER_RETURN' AND purchase_line_id = ? AND amount = 0", [a.line]) === 1,
    'RÜCKGABE Partneranteil am Ergebnis 0 (Erstattung = Einstand)');
  ok(n(DB, "SELECT COUNT(*) FROM invoices") === 0, 'RÜCKGABE kein Kundenverkauf, keine Rechnung');
  await move(a.line, 'PAYOUT', 400, 'pa-b', 'bank');
  ok(open(a.line) === 0, 'RÜCKGABE Auszahlung 400 → ausgeglichen');
  // Rücknahme der Rückgabe (Storno des Einkaufs) nach der Auszahlung: sicher gesperrt.
  const storno = await code(() => imHaus(() => cancelPurchaseInHouse(a.id, 'branch-main', {})));
  ok(storno === 'PARTNER_OWNERSHIP_BLOCKED', `RÜCKGABE nach Auszahlung nicht mehr zurücknehmbar (${storno})`);
}

// ── 2 Teilerstattung 900 ────────────────────────────────────────────────────
{
  const a = await kauf('pw7', 1000, PB, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 400);
  ret(a.id, a.line, 1, 900, 'bank');
  ok(open(a.line) === 350, `TEIL Erstattung 900: Verlust 100, B trägt 50 → 350 (${open(a.line)})`);
  ok(-bal('PARTNER_ITEM_PROFIT_SHARE') === -50 || bal('PARTNER_ITEM_PROFIT_SHARE') === 50, 'TEIL Verlustanteil 50 gebucht (Aufwandskonto im Haben)');
}

// ── 3 Gutschrift statt Geld: Auszahlung erst nach vollständiger Verwendung ──
{
  const a = await kauf('pw8', 1000, PB, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  const r = ret(a.id, a.line, 1, 1000, 'credit');
  ok(r.status === 'CONFIRMED' && !!r.supplierCreditId, 'GUTSCHRIFT Rückgabe als Lieferantengutschrift erfasst');
  ok(open(a.line) === 500, `GUTSCHRIFT Anspruch 500 vorbereitet (${open(a.line)})`);
  ok(await code(() => move(a.line, 'PAYOUT', 500)) === rules.PARTNER_SUPPLIER_REFUND_PENDING, 'GUTSCHRIFT Auszahlung wartet');
  const b = await kauf('pw9', 2000, undefined, 1, 0);
  imHaus(() => applyCreditToPurchaseInHouse(b.id, 600, localHouseCtx()));
  ok(await code(() => move(a.line, 'PAYOUT', 500)) === rules.PARTNER_SUPPLIER_REFUND_PENDING, 'GUTSCHRIFT teilweise verwendet → wartet weiter');
  imHaus(() => applyCreditToPurchaseInHouse(b.id, 400, localHouseCtx()));
  ok(open(a.line) === 500 && await code(() => move(a.line, 'PAYOUT', 500)) === '', 'GUTSCHRIFT vollständig verwendet → Auszahlung erst jetzt, ausdrücklich');
}

// ── 4 Mehrere Stücke, Teilrückgabe mengen- und wertanteilig ─────────────────
{
  const a = await kauf('pw10', 500, PB, 2, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  ret(a.id, a.line, 1, 450, 'cash');
  ok(open(a.line) === 225, `TEILRÜCKGABE 1 von 2 zu 450: B −25, unverkauftes Stück schuldet 250 → 225 (${open(a.line)})`);
}

// ── 4b Rückgabe an den Lieferanten NACH Verkauf, Auszahlung, Kundenretoure und Nachabrechnung ──
{
  const a = await kauf('pw20', 1000, PB, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  const v = verkauf(DB, 'pw20', lotOf(DB, a.line), 1300, 'full');
  await save.settleSaleOnPrimary(v.il);
  await move(a.line, 'PAYOUT', 650);
  imHaus(() => createReturnInHouse({ invoiceId: v.inv, lines: [{ invoiceLineId: v.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'x', refundNow: true }, 'branch-main'));
  reload();
  await save.settleSaleOnPrimary(v.il);
  ok(open(a.line) === -650, `NACH AUSZAHLUNG Kundenretoure + Nachabrechnung: B schuldet 650 (${open(a.line)})`);
  const payouts = n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'PAYOUT' AND cancelled_at IS NULL AND purchase_line_id = ?", [a.line]);
  ret(a.id, a.line, 1, 1000, 'cash');
  ok(open(a.line) === -150 && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'PAYOUT' AND cancelled_at IS NULL AND purchase_line_id = ?", [a.line]) === payouts,
    `NACH AUSZAHLUNG Rückgabe an den Lieferanten: B hat 500 gezahlt und 650 bekommen → schuldet 150; die Auszahlung bleibt (${open(a.line)})`);
}

// ── 5 Übernahme durch LATAIF (Beispiel: 400 zurück), Wertsperre, Weiterverkauf ohne Partner ──
{
  const a = await kauf('pw11', 1000, PB, 1, 600);
  await move(a.line, 'CONTRIBUTION', 400);
  const o = own(a.line);
  ok(o.canTakeOver && o.value === 1000 && o.qty === 1, `ÜBERNAHME angezeigt: 1 Stück zum Einstand 1000 (${S(o)})`);
  ok(await code(() => takeOver(a.line, 1200)) === rules.PARTNER_OWNERSHIP_VALUE_MISMATCH, 'ÜBERNAHME anderer Wert (1200) → gesperrt');
  const lotVorher = S(DB.exec('SELECT qty_remaining, unit_cost FROM stock_lots WHERE purchase_line_id = ?', [a.line])[0].values);
  const le = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  const pays = supplierPayments();
  await takeOver(a.line, 1000);
  ok(open(a.line) === 400, `ÜBERNAHME B erhält seine 400 als Anspruch (${open(a.line)})`);
  ok(S(DB.exec('SELECT qty_remaining, unit_cost FROM stock_lots WHERE purchase_line_id = ?', [a.line])[0].values) === lotVorher
    && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === le && supplierPayments() === pays && n(DB, 'SELECT COUNT(*) FROM purchases WHERE id != ?', [a.id]) >= 0,
    'ÜBERNAHME kein Lagerzugang, keine Neubewertung, keine Buchung, keine Lieferantenzahlung');
  ok(own(a.line).mode === 'LATAIF_ONLY' && view(a.line)?.participating === false, 'ÜBERNAHME LATAIF hält allein; der Partner steht im Verlauf');
  const v = verkauf(DB, 'pw11', lotOf(DB, a.line), 1500, 'full');
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_NOT_FOUND, 'ÜBERNAHME Weiterverkauf: keine Partnerabrechnung mehr');
  await move(a.line, 'PAYOUT', 400);
  ok(open(a.line) === 0, 'ÜBERNAHME Anspruch ausgezahlt');
}

// ── 6 Übernahme gesperrt bei offenem Verkauf, aktivierte Kosten im Wert ─────
{
  const a = await kauf('pw12', 1000, PB, 2, 2000);
  await move(a.line, 'CONTRIBUTION', 1000);
  const v = verkauf(DB, 'pw12', lotOf(DB, a.line), 1300, 'full');
  ok(!own(a.line).canTakeOver && /not settled/.test(String(own(a.line).blocker)), 'SPERRE Übernahme bei nicht abgerechnetem Verkauf');
  await save.settleSaleOnPrimary(v.il);
  imHaus(() => shiftOwnRepairCost({ id: 'rep-x', productId: 'pw12', lotId: lotOf(DB, a.line) } as never, 100, NOW, 'Reparatur'));
  const o = own(a.line);
  ok(o.canTakeOver && o.qty === 1 && o.value === 1100, `KOSTEN Übernahmewert = aktueller Einstand inkl. Reparatur (${S(o)})`);
  const vor = open(a.line);
  await takeOver(a.line, 1100);
  // B: 1000 − 0 + 150 (Gewinn) − 0 = 1150; vorher schuldete er noch 50 Reparaturanteil für das Lagerstück.
  // vorher: 1000 Beitrag + 150 Gewinn − 500 Kostenanteil des Lagerstücks − 50 Reparaturanteil = 600
  ok(vor === 600 && open(a.line) === 1150, `KOSTEN B vorher ${vor} (inkl. 50 Reparaturanteil), nach Übernahme 1150 (Beitrag 1000 + Gewinnanteil 150)`);
}

// ── 7 Rückkehr nach Übernahme: Zwischenstatus, sicher gesperrt, Übernahme löst ──
{
  const a = await kauf('pw13', 1000, PB, 2, 2000);
  await move(a.line, 'CONTRIBUTION', 1000);
  const v = verkauf(DB, 'pw13', lotOf(DB, a.line), 1200, 'full');
  await save.settleSaleOnPrimary(v.il);
  await takeOver(a.line, 1000);
  ok(open(a.line) === 1100, `RÜCKKEHR vorher: B 1000 + 100 Gewinn (${open(a.line)})`);
  imHaus(() => createReturnInHouse({ invoiceId: v.inv, lines: [{ invoiceLineId: v.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'x', refundNow: true }, 'branch-main'));
  reload();
  await save.settleSaleOnPrimary(v.il);
  const o = own(a.line);
  ok(o.mode === 'RETURNED_AFTER_END' && o.canTakeOver && !o.canChange && o.qty === 1, `RÜCKKEHR Zwischenstatus: das Stück gehört wieder der alten Beteiligung (${S(o)})`);
  ok(await code(() => move(a.line, 'PAYOUT', 1)) === rules.PARTNER_SALE_NEEDS_CORRECTION, 'RÜCKKEHR Auszahlung gesperrt');
  ok(await code(() => change(a.line, 1000, [{ partnerId: 'pa-c', sharePct: 50 }])) === rules.PARTNER_OWNERSHIP_BLOCKED, 'RÜCKKEHR Partnerwechsel gesperrt');
  await takeOver(a.line, 1000);
  ok(own(a.line).mode === 'LATAIF_ONLY' && open(a.line) === 1000, `RÜCKKEHR erneute Übernahme löst; B wieder bei seinen 1000 (${open(a.line)})`);
}

// ── 8 Partnerwechsel: B 50 → B 30 + C 20, ohne Geldbewegung ─────────────────
{
  const a = await kauf('pw14', 1000, PB, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  const le = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  ok(await code(() => change(a.line, 1000, [{ partnerId: 'pa-b', sharePct: 50 }])) === rules.PARTNER_OWNERSHIP_UNCHANGED, 'WECHSEL gleiche Anteile → nichts zu tun');
  await change(a.line, 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }]);
  ok(open(a.line, 'pa-b') === 200 && open(a.line, 'pa-c') === -200, `WECHSEL B: Anspruch 200, C schuldet 200 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  ok(n(DB, 'SELECT COUNT(*) FROM ledger_entries') === le, 'WECHSEL keine Kassen-/Bankbuchung');
  const v = verkauf(DB, 'pw14', lotOf(DB, a.line), 1500, 'full');
  const r = await save.settleSaleOnPrimary(v.il);
  const sb = r.shares.find((x) => x.partnerId === 'pa-b')?.amount; const sc = r.shares.find((x) => x.partnerId === 'pa-c')?.amount;
  ok(sb === 150 && sc === 100, `WECHSEL Verkauf danach nach den NEUEN Anteilen: B 30 % = 150, C 20 % = 100 (${S(r.shares)})`);
  const pur = loadPurchasesFor({ branchId: 'branch-main' } as never).purchases.find((p) => p.id === a.id)!;
  ok((pur.participations?.[0]?.history ?? []).length === 1, 'WECHSEL frühere Beteiligung bleibt im Verlauf');
}

// ── 9 Partner zu einem allein gekauften Artikel ─────────────────────────────
{
  const a = await kauf('pw15', 800, undefined, 2, 1600);
  const v1 = verkauf(DB, 'pw15', lotOf(DB, a.line), 1000, 'full');
  const o = own(a.line);
  ok(o.mode === 'LATAIF_ONLY' && o.canChange && o.qty === 1 && o.value === 800, `ALLEIN 1 unverkauftes Stück zum Einstand 800 (${S(o)})`);
  await change(a.line, 800, [{ partnerId: 'pa-c', sharePct: 25 }]);
  ok(open(a.line, 'pa-c') === -200, 'ALLEIN C steigt mit 25 % ein und schuldet 200');
  ok(await code(() => save.settleSaleOnPrimary(v1.il)) === rules.PARTNER_SALE_NOT_FOUND, 'ALLEIN der frühere Verkauf bleibt LATAIF allein');
}

// ── 10 Kundenreparatur bleibt Reparatur; „Under repair" bleibt gesperrt ─────
{
  const a = await kauf('pw16', 1000, PB, 1, 1000);
  const v = verkauf(DB, 'pw16', lotOf(DB, a.line), 1300, 'full');
  const r = await code(() => imHaus(() => createReturnInHouse({ invoiceId: v.inv, lines: [{ invoiceLineId: v.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'UNDER_REPAIR' as never, reason: 'x', refundNow: true }, 'branch-main')));
  ok(r === 'PARTNER_ITEM_JOINT_BLOCKED', `REPARATUR „Under repair" bleibt gesperrt (${r})`);
  ok(/Back to Stock|In stock/.test(house.JOINT_BLOCK.salesReturnDisposition) && src('src/pages/invoices/InvoiceDetail.tsx').includes('data-return-under-repair-hint'),
    'REPARATUR Hinweis auf den sicheren Weg in Meldung und Maske');
}

// ── 11 PC2: Übernahme/Wechsel/Rückgabe über die Befehle, Wiederholung, Konflikt, gleichzeitig ──
{
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-00000000beef`;
  const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
  const deps = () => ({ db: DB as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() });
  const a = await kauf('pw17', 1000, PB, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  const body = { purchaseLineId: a.line, expectedValue: 1000 };
  const [t1, t2] = await Promise.all([
    runExclusive(() => cmd2.runTakeOver(deps(), identity('1', 'partner_items.take_over'), body)),
    runExclusive(() => cmd2.runTakeOver(deps(), identity('2', 'partner_items.take_over'), body)),
  ]);
  ok([t1.kind, t2.kind].sort().join() === 'ok,rejected'
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'TAKEOVER' AND purchase_line_id = ?", [a.line]) === 1,
    `PC2 zwei gleichzeitige Übernahmen → genau eine (${S([t1.kind, t2.kind])})`);
  const replay = await cmd2.runTakeOver(deps(), identity(t1.kind === 'ok' ? '1' : '2', 'partner_items.take_over'), body);
  ok(replay.kind === 'ok' && replay.replayed === true, 'PC2 verlorene Antwort: Wiederholung liefert das Ergebnis, keine zweite Übernahme');
  const conflict = await cmd2.runTakeOver(deps(), identity('1', 'partner_items.take_over', 'anders'), { ...body, expectedValue: 999 }).catch((e) => ({ kind: 'thrown', code: (e as { code?: string }).code }));
  ok((conflict as { code?: string }).code === 'COMMAND_ID_CONFLICT', 'PC2 Kennungskonflikt');
  const b = await kauf('pw18', 1000, PB, 1, 1000);
  const ch = await cmd2.runChangePartners(deps(), identity('3', 'partner_items.change_partners'),
    { purchaseLineId: b.line, expectedValue: 1000, partnerShares: [{ partnerId: 'pa-c', sharePct: 40 }] });
  ok(ch.kind === 'ok' && open(b.line, 'pa-c') === -400 && open(b.line, 'pa-b') === 0, `PC2 Partnerwechsel: C schuldet 400, B scheidet ohne Schuld aus (${S(ch)})`);
  let feld = '';
  try { cmd2.parseTakeOver({ ...body, value: 1 }); } catch (e) { feld = String((e as Error).message); }
  ok(/unknown field/.test(feld), 'PC2 ein anderer Wert als „expectedValue" wird nicht angenommen');
  const c = await kauf('pw19', 1000, PB, 1, 1000);
  await move(c.line, 'CONTRIBUTION', 500);
  const REV = n(DB, 'SELECT revision FROM purchases WHERE id = ?', [c.id]);
  const rv = await plc.runPurchaseReturn(deps(), identity('4', 'purchases.return_to_supplier'),
    { purchaseId: c.id, expectedRevision: REV, refundMethod: 'cash', lines: [{ purchaseLineId: c.line, quantity: 1, unitPrice: 1000 }] });
  const rv2 = await plc.runPurchaseReturn(deps(), identity('4', 'purchases.return_to_supplier'),
    { purchaseId: c.id, expectedRevision: REV, refundMethod: 'cash', lines: [{ purchaseLineId: c.line, quantity: 1, unitPrice: 1000 }] });
  ok(rv.kind === 'ok' && rv2.replayed === true && open(c.line) === 500
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'SUPPLIER_RETURN' AND purchase_line_id = ?", [c.line]) === 1,
    'PC2 Lieferantenrückgabe über den bestehenden Befehl: Partner in derselben Transaktion, Wiederholung ohne zweite Buchung');
}

// ── Abgleich, Hauptbuch, Lieferantenseite ───────────────────────────────────
{
  const rec = reconciliationSnapshotFor({ branchId: 'branch-main' } as never);
  const row = rec.rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE')!;
  ok(Math.abs(row.ledger - row.domain) < 0.0005, `ABGLEICH Partner-Ausgleichskonto Hauptbuch ${row.ledger} = Domäne ${row.domain}`);
  ok(n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0, 'ABGLEICH Hauptbuch ausgeglichen');
  const apRow = rec.rows.find((x) => x.account === 'ACCOUNTS_PAYABLE')!;
  ok(Math.abs(apRow.ledger - apRow.domain) < 0.0005, `ABGLEICH Lieferantenschuld Hauptbuch = Domäne (${apRow.ledger}/${apRow.domain})`);
  const reg = src('src/core/bridge/command-registry.ts');
  ok(reg.includes("'partner_items.take_over', 'partner_items.change_partners'") && src('src-tauri/src/bridge.rs').includes('"partner_items.change_partners"'),
    'REGISTRY die zwei neuen Befehle in TS und Rust; Lieferantenrückgabe ohne neuen Befehl');
}

console.log(`\npartner-ownership: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 — Lieferantenrückgabe mit aktivierten Zusatzkosten (Erstattung, Verlust, Partner, Storno)
// Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/supplier-return-added-costs.test.ts
/* eslint-disable @typescript-eslint/no-unused-vars -- übernommener Harness (nicht jeder Helfer wird hier gebraucht). */
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

// ════════════════════════════════════════════════════════════════════════════
// Lieferantenrückgabe mit aktivierten Zusatzkosten (Owner 11.11.2026): Buchwert, tatsächliche Erstattung (Rücknahmepreis +
// getrennt erstattete Zusatzkosten), Verlust auf INVENTORY_LOSS; kein Lagerrest; Partneranteil am Verlust; Storno.
// Nach jedem Fall: Hauptbuch INVENTORY = Bestand (Σ Restmenge × Einstand), Hauptbuch ausgeglichen.
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
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
type Shares = Array<{ partnerId: string; sharePct: number }>;
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0, scheme: 'ZERO' | 'VAT_10' = 'ZERO') => {
  const id = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE(pid, price, shares, qty)], pay), taxScheme: scheme })).id;
  return { id, line: lineOf(DB, id, pid) };
};
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, addedCostRefund = 0, refundMethod = 'cash') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice, ...(addedCostRefund ? { addedCostRefund } : {}) }] }, localHouseCtx()));
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const soll = (acc: string): number => r3(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [acc]));
const lagerHB = (): number => soll('INVENTORY');
const lagerBestand = (): number => r3(n(DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED'"));
const geld = (): number => r3(soll('CASH') + soll('BANK') + soll('BENEFIT'));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const abgleich = (tag: string) => {
  const hb = lagerHB(), be = lagerBestand();
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE');
  ok(Math.abs(hb - be) < 0.0015 && ausgeglichen() && (!row || Math.abs(Number(row.ledger) - Number(row.domain)) < 0.0005),
    `${tag} Abgleich: Hauptbuch INVENTORY ${hb} = Bestand ${be}, Partnerkonto = Domäne, ausgeglichen`);
};
async function reparaturFertig(pid: string, lot: string, kosten: number, partnerZahlt?: string): Promise<void> {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten } as never)).id;
  await repairs.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  const ex = s(DB, "SELECT expense_id FROM repair_lines WHERE repair_id = ? LIMIT 1", [id]);
  imHaus(() => payables.recordExpensePaymentInHouse(ex, kosten, partnerZahlt ? 'partner' : 'bank', localHouseCtx(), partnerZahlt ? { partnerId: partnerZahlt } : {}));
  await repairs.updateRepairStatusOnPrimary(id, 'ready' as never);
}
const verlust = (): number => soll('INVENTORY_LOSS');

// ── Z1 Einkauf 1000 + Reparatur 100 = Buchwert 1100; Erstattung nur 1000 → Verlust 100 ──
{
  const a = await kauf('pw6', 1000, undefined, 1, 1000);
  await reparaturFertig('pw6', lotOf(DB, a.line), 100);
  const v0 = verlust(), g0 = geld(), h0 = lagerHB();
  const r = ret(a.id, a.line, 1, 1000);
  ok(r.status === 'COMPLETED' && r3(geld() - g0) === 1000 && r3(verlust() - v0) === 100 && r3(h0 - lagerHB()) === 1100,
    `Z1 Erstattung 1000: Kasse +1000, Verlust 100 (INVENTORY_LOSS), Lager −1100 (${r3(geld() - g0)}/${r3(verlust() - v0)}/${r3(h0 - lagerHB())})`);
  abgleich('Z1');
}

// ── Z2 Erstattung 1000 + Zusatzkosten 100 (getrennt) → kein Verlust ─────────────
{
  const a = await kauf('pw7', 1000, undefined, 1, 1000);
  await reparaturFertig('pw7', lotOf(DB, a.line), 100);
  const v0 = verlust(), g0 = geld();
  const r = ret(a.id, a.line, 1, 1000, 100);
  ok(r3(geld() - g0) === 1100 && r3(verlust() - v0) === 0 && r3(n(DB, 'SELECT added_cost_refund FROM purchase_returns WHERE purchase_id = ?', [a.id])) === 100,
    'Z2 Erstattung 1100 (1000 Rücknahme + 100 Zusatzkosten): Kasse +1100, kein Verlust, getrennt erfasst');
  const { bankTransactionsFor } = await import('../../src/stores/bankingStore.ts');
  const bt = bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, [])
    .find((t: { id: string }) => t.id === 'pret-' + r.returnId) as { amount?: number; flow?: string } | undefined;
  ok(bt?.amount === 1100 && bt?.flow === 'in', `Z2 Banking zeigt den Geldeingang 1100 (Rücknahme + Zusatzkosten) wie das Hauptbuch (${S(bt?.amount)})`);
  abgleich('Z2');
}

// ── Z3 Erstattung 1000 + 50 → Verlust 50 ─────────────────────────────────────
{
  const a = await kauf('pw8', 1000, undefined, 1, 1000);
  await reparaturFertig('pw8', lotOf(DB, a.line), 100);
  const v0 = verlust();
  ret(a.id, a.line, 1, 1000, 50);
  ok(r3(verlust() - v0) === 50, `Z3 Erstattung 1050: Verlust 50 (${r3(verlust() - v0)})`);
  abgleich('Z3');
}

// ── Z4 Rücknahmegebühr: Rücknahmepreis 900, keine Zusatzkosten erstattet → Verlust 200 (Gebühr 100 + Reparatur 100) ──
{
  const a = await kauf('pw9', 1000, undefined, 1, 1000);
  await reparaturFertig('pw9', lotOf(DB, a.line), 100);
  const v0 = verlust();
  ret(a.id, a.line, 1, 900);
  ok(r3(verlust() - v0) === 200, `Z4 Rücknahmepreis 900: Verlust 200 (${r3(verlust() - v0)})`);
  abgleich('Z4');
}

// ── Z5 Nicht unterstützt: Zusatzkosten-Erstattung über den Zusatzkosten, Preis über Einkauf → abgewiesen, nichts geschrieben ──
{
  const a = await kauf('pw10', 1000, undefined, 1, 1000);
  await reparaturFertig('pw10', lotOf(DB, a.line), 100);
  const h0 = lagerHB(), v0 = verlust();
  ok(await code(() => Promise.resolve(ret(a.id, a.line, 1, 1000, 100.001))) === 'PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH', 'Z5 Erstattung über den Zusatzkosten (Gewinn) abgewiesen');
  ok(await code(() => Promise.resolve(ret(a.id, a.line, 1, 1000.5))) === 'PURCHASE_RETURN_EXCEEDS_PURCHASE', 'Z5 Rückgabe über dem Einkaufswert abgewiesen (bestehender Code)');
  ok(lagerHB() === h0 && verlust() === v0 && n(DB, "SELECT COUNT(*) FROM purchase_returns WHERE purchase_id = ? AND status != 'DRAFT'", [a.id]) === 0, 'Z5 nichts geschrieben');
  abgleich('Z5');
}

// ── Z6 Mehrere Stücke: 2 × 500, Reparatur 100 auf das Los (je 550); 1 Stück zurück zu 500 + 20 → Verlust 30 ──
{
  const a = await kauf('pw11', 500, undefined, 2, 1000);
  await reparaturFertig('pw11', lotOf(DB, a.line), 100);
  const v0 = verlust();
  ret(a.id, a.line, 1, 500, 20);
  ok(r3(verlust() - v0) === 30 && r3(n(DB, 'SELECT qty_remaining * unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)])) === 550,
    `Z6 Teilrückgabe 1 von 2: Verlust 30, verbleibendes Stück trägt 550 (${r3(verlust() - v0)})`);
  abgleich('Z6');
}
// ── Z6b Beide Stücke in einer Rückgabe: höchstens 2 × 50 Zusatzkosten; 2 × 500 + 100 → kein Verlust, Los leer ──
{
  const a = await kauf('pw19', 500, undefined, 2, 1000);
  await reparaturFertig('pw19', lotOf(DB, a.line), 100);
  const c5 = await code(() => Promise.resolve(ret(a.id, a.line, 1, 600)));
  ok(c5 === 'PURCHASE_RETURN_PRICE_ABOVE_PURCHASE', 'Z6b Rücknahmepreis 600 über dem Stückpreis 500 abgewiesen — Zusatzkosten gehören ins eigene Feld (' + c5 + ')');
  const c6 = await code(() => Promise.resolve(ret(a.id, a.line, 2, 500, 100.001)));
  ok(c6 === 'PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH', 'Z6b Erstattung über 2 × 50 Zusatzkosten abgewiesen (' + c6 + ')');
  const v0 = verlust(), h0 = lagerHB();
  ret(a.id, a.line, 2, 500, 100);
  ok(r3(verlust() - v0) === 0 && r3(h0 - lagerHB()) === 1100 && n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 0,
    'Z6b beide Stücke: Lager −1100, kein Verlust, Los leer');
  abgleich('Z6b');
}

// ── Z7 VAT_10: 110 brutto (100 + 10 VAT), Reparatur 10 → Buchwert 110; Rückgabe 110 → Vorsteuer 10 zurück, Verlust 10 ──
{
  const a = await kauf('pw12', 110, undefined, 1, 110, 'VAT_10');
  await reparaturFertig('pw12', lotOf(DB, a.line), 10);
  const v0 = verlust(), vat0 = soll('VAT_INPUT');
  ret(a.id, a.line, 1, 110);
  ok(r3(verlust() - v0) === 10 && r3(vat0 - soll('VAT_INPUT')) === 10, `Z7 VAT_10: Vorsteuer 10 zurückgebucht, Verlust 10 (die Reparatur) (${r3(verlust() - v0)})`);
  const b = await kauf('pw13', 110, undefined, 1, 110, 'VAT_10');
  await reparaturFertig('pw13', lotOf(DB, b.line), 10);
  const v1 = verlust();
  ret(b.id, b.line, 1, 110, 10);
  ok(r3(verlust() - v1) === 0, 'Z7 VAT_10 mit Erstattung der Zusatzkosten 10 (ohne VAT, wie ihre Aktivierung): kein Verlust');
  abgleich('Z7');
}

// ── Z8 Teilweise bezahlter Einkauf: 600 bezahlt, 400 offen → Schuld fällt 400, Erstattung 600 + Zusatzkosten 100 ──
{
  const a = await kauf('pw14', 1000, undefined, 1, 600);
  await reparaturFertig('pw14', lotOf(DB, a.line), 100);
  const g0 = geld(), ap0 = soll('ACCOUNTS_PAYABLE'), v0 = verlust();
  ret(a.id, a.line, 1, 1000, 100);
  const p = DB.exec('SELECT status, total_amount, paid_amount, remaining_amount FROM purchases WHERE id = ?', [a.id])[0].values[0];
  ok(r3(geld() - g0) === 700 && r3(verlust() - v0) === 0 && Number(p[3]) === 0, `Z8 Kasse +700 (600 Geld zurück + 100 Zusatzkosten), Einkauf ohne Rest (${S(p)}, AP ${r3(soll('ACCOUNTS_PAYABLE') - ap0)})`);
  abgleich('Z8');
}

// ── Z9 Erstattung als Lieferantenguthaben: Guthaben = Rücknahme + Zusatzkosten ──
{
  const a = await kauf('pw15', 1000, undefined, 1, 1000);
  await reparaturFertig('pw15', lotOf(DB, a.line), 100);
  const r = ret(a.id, a.line, 1, 1000, 60, 'credit');
  ok(r3(n(DB, 'SELECT amount FROM supplier_credits WHERE id = ?', [String(r.supplierCreditId)])) === 1060, 'Z9 Lieferantenguthaben 1060 (1000 + 60), Verlust 40');
  abgleich('Z9');
}

// ── Z10 Partner 50/50: Erstattung 1000 + 50 → Verlust 50, B trägt 25 ─────────────
{
  const a = await kauf('pw16', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  await reparaturFertig('pw16', lotOf(DB, a.line), 100);
  await move(a.line, 'CONTRIBUTION', 50);
  ok(open(a.line) === 0, 'Z10 B hat seinen Anteil an Einkauf und Reparatur bezahlt (550)');
  const v0 = verlust();
  ret(a.id, a.line, 1, 1000, 50);
  ok(r3(verlust() - v0) === 50 && open(a.line) === 525 && r3(n(DB, "SELECT amount FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN'", [a.line])) === -25,
    `Z10 Verlust 50, B trägt 25 → bekommt 550 − 25 = 525 (${open(a.line)})`);
  abgleich('Z10');
}

// ── Z11 Partner 60/40 mit Direktzahlung: B zahlte die Reparatur 100 selbst; Erstattung 1000 → Verlust 100, B trägt 40 ──
{
  const a = await kauf('pw17', 1000, [{ partnerId: 'pa-b', sharePct: 40 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 400);
  await reparaturFertig('pw17', lotOf(DB, a.line), 100, 'pa-b');
  ok(open(a.line) === 60, `Z11 vor der Rückgabe: Anspruch 60 (Direktzahlung 100 − Anteil 40) (${open(a.line)})`);
  ret(a.id, a.line, 1, 1000);
  ok(open(a.line) === 460, `Z11 Rückgabe: B hat 500 gezahlt, trägt 40 Verlust → 460, kein doppelter Anspruch (${open(a.line)})`);
  await move(a.line, 'PAYOUT', 460, 'pa-b', 'bank');
  ok(open(a.line) === 0 && await code(() => move(a.line, 'PAYOUT', 1)) !== '', 'Z11 ausgezahlt; keine zweite Auszahlung');
  abgleich('Z11');
}

// ── Z12 Rückgängig. a) Einkauf mit aktivierter Reparatur: der Storno bleibt gesperrt (bestehender Schutz), nichts geschrieben.
//    b) Die Rückbuchung der Rückgabe (derselbe Weg wie im Storno): Verlust, Zusatzkosten-Erstattung, Kasse, Los, Partner zurück.
//    c) Einkauf ohne Zusatzkosten, Rückgabe unter Einstand (Verlust 100), dann Einkaufs-Storno: alles gegengebucht. ──
const { reverseConfirmedPurchaseReturnInHouse } = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
{
  const a = await kauf('pw18', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 500);
  await reparaturFertig('pw18', lotOf(DB, a.line), 100);
  await move(a.line, 'CONTRIBUTION', 50);
  const v0 = verlust(), g0 = geld(), h0 = lagerHB(), o0 = open(a.line);
  const r = ret(a.id, a.line, 1, 1000, 50);
  ok(r3(verlust() - v0) === 50 && r3(geld() - g0) === 1050 && open(a.line) === 525, 'Z12 Rückgabe: Verlust 50, Kasse +1050, B 525');
  const v1 = verlust(), h1 = lagerHB(), led1 = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  const c = await code(() => Promise.resolve(imHaus(() => cancelPurchaseInHouse(a.id, 'branch-main', {}))));
  ok(c === 'PURCHASE_LOT_COST_CHANGED' && verlust() === v1 && lagerHB() === h1 && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === led1,
    `Z12a Storno eines reparierten Einkaufs bleibt gesperrt, nichts geschrieben (${c})`);
  imHaus(() => reverseConfirmedPurchaseReturnInHouse(r.returnId, NOW));
  ok(r3(verlust() - v0) === 0 && r3(geld() - g0) === 0 && lagerHB() === h0 && open(a.line) === o0
     && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'SUPPLIER_RETURN' AND cancelled_at IS NULL", [a.line]) === 0
     && n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 1,
    `Z12b Rückbuchung: Verlust 0, Kasse zurück, Lager wieder 1100, Partner wie vorher (${r3(verlust() - v0)}/${r3(geld() - g0)}/${open(a.line)})`);
  abgleich('Z12b');
}
{
  const a = await kauf('pw20', 1000, undefined, 1, 400);
  const v0 = verlust(), g0 = geld();
  ret(a.id, a.line, 1, 900);
  ok(r3(verlust() - v0) === 100, 'Z12c Rückgabe unter Einstand (900 von 1000): Verlust 100, kein Lagerrest');
  abgleich('Z12c Rückgabe');
  const c = await code(() => Promise.resolve(imHaus(() => cancelPurchaseInHouse(a.id, 'branch-main', {}))));
  ok(c === '' && r3(verlust() - v0) === 0, `Z12c Einkaufs-Storno nimmt die Rückgabe samt Verlust zurück (${c || 'ok'}, Verlust ${r3(verlust() - v0)}, Kasse ${r3(geld() - g0)})`);
  abgleich('Z12c Storno');
}

console.log(`\nsupplier-return-added-costs: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('SUPPLIER_RETURN_ADDED_COSTS_PROVED');

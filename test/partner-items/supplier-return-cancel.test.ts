// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 — Storno einer gebuchten Lieferantenrückgabe (Geld, Guthaben, Partner, Lager, PC2)
// Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/supplier-return-cancel.test.ts
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
// „Cancel return" (Owner 11.11.2026): eine gebuchte Lieferantenrückgabe vollständig zurücknehmen, der Einkauf bleibt.
// Nach jedem Storno gilt: jeder Hauptbuchsaldo, der Lagerwert der Lose, die Einkaufssummen und die Partneransprüche stehen
// wieder genau wie VOR der Rückgabe (Geld: Eingang beim Rückgeben, bestätigte Rückzahlung beim Storno).
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const lifecycle = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const purchaseSave = await import('../../src/core/purchases/purchase-house.ts');
const DB = freshDb();
for (let i = 6; i <= 40; i++) {
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
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, addedCostRefund = 0, refundMethod = 'bank') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice, ...(addedCostRefund ? { addedCostRefund } : {}) }] }, localHouseCtx()));
const storno = (purchaseId: string, returnId: string, refundRepaid = false, reason = 'supplier sent the item back') =>
  imHaus(() => lifecycle.cancelPurchaseReturnInHouse({ purchaseId, returnId, reason, refundRepaid }, localHouseCtx()));
const stornoNein = async (purchaseId: string, returnId: string, refundRepaid = false): Promise<{ code: string; msg: string }> => {
  try { storno(purchaseId, returnId, refundRepaid); return { code: '', msg: '' }; } catch (e) {
    return { code: String((e as { code?: unknown }).code ?? 'THROWN'), msg: String((e as Error).message) };
  }
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const soll = (acc: string): number => r3(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [acc]));
const lagerHB = (): number => soll('INVENTORY');
const lagerBestand = (): number => r3(n(DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED'"));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const KONTEN = ['INVENTORY', 'INVENTORY_LOSS', 'VAT_INPUT', 'ACCOUNTS_PAYABLE', 'CASH', 'BANK', 'BENEFIT', 'SUPPLIER_CREDIT', 'PARTNER_ITEM_BALANCE', 'PARTNER_ITEM_PROFIT_SHARE'];
const stand = () => S({ konten: KONTEN.map((k) => [k, soll(k)]), lose: lagerBestand() });
const einkauf = (id: string) => S(DB.exec('SELECT status, total_amount, paid_amount, remaining_amount FROM purchases WHERE id = ?', [id])[0].values[0]);
const nichts = () => S({ le: n(DB, 'SELECT COUNT(*) FROM ledger_entries'), au: n(DB, 'SELECT COUNT(*) FROM audit_log'),
  st: DB.exec('SELECT id, status FROM purchase_returns ORDER BY id')[0]?.values ?? [], lo: lagerBestand(),
  pm: n(DB, 'SELECT COUNT(*) FROM item_partner_movements WHERE cancelled_at IS NULL'), sc: n(DB, 'SELECT COUNT(*) FROM supplier_credits') });
const abgleich = (tag: string) => {
  const hb = lagerHB(), be = lagerBestand();
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE');
  ok(Math.abs(hb - be) < 0.0015 && ausgeglichen() && (!row || Math.abs(Number(row.ledger) - Number(row.domain)) < 0.0005),
    `${tag} Abgleich: Hauptbuch INVENTORY ${hb} = Lose ${be}, Partnerkonto = Domäne, Hauptbuch ausgeglichen`);
};
async function reparaturFertig(pid: string, lot: string, kosten: number, partnerZahlt?: string): Promise<void> {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten } as never)).id;
  await repairs.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  const ex = s(DB, "SELECT expense_id FROM repair_lines WHERE repair_id = ? LIMIT 1", [id]);
  imHaus(() => payables.recordExpensePaymentInHouse(ex, kosten, partnerZahlt ? 'partner' : 'bank', localHouseCtx(), partnerZahlt ? { partnerId: partnerZahlt } : {}));
  await repairs.updateRepairStatusOnPrimary(id, 'ready' as never);
}
const retStatus = (rid: string): string => s(DB, 'SELECT status FROM purchase_returns WHERE id = ?', [rid]);

// ── C1 Rückgabe ohne Reparatur, Erstattung per Bank: ohne bestätigte Rückzahlung Nein mit offenem Betrag; dann vollständig ──
{
  const a = await kauf('pw6', 1000, undefined, 1, 1000);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 1000);
  ok(r.status === 'COMPLETED' && s(DB, 'SELECT unit_cost_at_return FROM purchase_return_lines WHERE return_id = ?', [r.returnId]) !== '',
    'C1 Rückgabe gebucht, Einstand je Stück festgehalten');
  const v = nichts();
  const nein = await stornoNein(a.id, r.returnId, false);
  ok(nein.code === 'PURCHASE_RETURN_REFUND_NOT_REPAID' && /1000\.000 BHD back by bank/.test(nein.msg) && nichts() === v,
    `C1 ohne bestätigte Rückzahlung: Nein mit Betrag und Weg, nichts geschrieben (${nein.msg.slice(0, 120)})`);
  const out = storno(a.id, r.returnId, true);
  ok(out.moneyRepaid === 1000 && out.repaidMethod === 'bank' && out.restoredBookValue === 1000 && out.reversedLoss === 0,
    `C1 Storno: Rückzahlung 1000 per Bank, Buchwert 1000 zurück (${S(out)})`);
  ok(stand() === s0 && einkauf(a.id) === p0, `C1 alle Konten, Lose und der Einkauf wie vor der Rückgabe (${einkauf(a.id)})`);
  const row = DB.exec('SELECT status, refund_repaid_amount, cancel_reason, cancelled_at IS NOT NULL, total_amount, refund_amount FROM purchase_returns WHERE id = ?', [r.returnId])[0].values[0];
  ok(row[0] === 'CANCELLED' && Number(row[1]) === 1000 && row[2] === 'supplier sent the item back' && row[3] === 1 && Number(row[4]) === 1000 && Number(row[5]) === 1000,
    `C1 Rückgabe bleibt als CANCELLED mit Nummer und Beträgen (Historie), Rückzahlung vermerkt (${S(row)})`);
  const bt = bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []) as Array<{ id: string; amount: number; flow: string }>;
  const ein = bt.find((t) => t.id === 'pret-' + r.returnId), aus = bt.find((t) => t.id === 'pret-repay-' + r.returnId);
  ok(ein?.amount === 1000 && ein.flow === 'in' && aus?.amount === 1000 && aus.flow === 'out',
    'C1 Banking: der echte Eingang bleibt sichtbar, die Rückzahlung steht als eigener Ausgang');
  const au = s(DB, "SELECT new_value FROM audit_log WHERE entity_type = 'purchase_returns' AND entity_id = ? AND new_value LIKE '%CANCELLED%' ORDER BY rowid DESC LIMIT 1", [r.returnId]);
  ok(/"moneyRepaid":\{"amount":1000,"method":"bank"/.test(au) && /"restoredBookValue":1000/.test(au) && /"reason":"supplier sent the item back"/.test(au),
    'C1 Protokoll: Geldbewegung getrennt von den Gegenbuchungen, Grund, Buchwert');
  ok(n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 1 && s(DB, 'SELECT stock_status FROM products WHERE id = ?', ['pw6']) === 'in_stock',
    'C1 die Uhr ist wieder im Lager');
  abgleich('C1');
  // Wiederholter Storno: Nein, nichts geschrieben. Danach ist eine neue Rückgabe wieder möglich.
  const v2 = nichts();
  const zwei = await stornoNein(a.id, r.returnId, true);
  ok(zwei.code === 'PURCHASE_RETURN_ALREADY_CANCELLED' && nichts() === v2, `C1 zweiter Storno: ${zwei.code}, nichts geschrieben`);
  const r2 = ret(a.id, a.line, 1, 1000);
  ok(r2.status === 'COMPLETED' && r2.returnId !== r.returnId, 'C1 nach dem Storno ist eine neue Rückgabe möglich (der Einkauf blieb)');
  abgleich('C1 neue Rückgabe');
}

// ── C2 Owner-Beispiel: Einkauf 1000 + Reparatur 100 = 1100; Erstattung 1050 per Bank (Verlust 50) → Storno ──────
{
  const a = await kauf('pw7', 1000, undefined, 1, 1000);
  await reparaturFertig('pw7', lotOf(DB, a.line), 100);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 1000, 50);
  ok(r3(soll('INVENTORY_LOSS')) > 0 && n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 0, 'C2 Rückgabe: Verlust gebucht, Los leer');
  const out = storno(a.id, r.returnId, true);
  ok(out.restoredBookValue === 1100 && out.reversedLoss === 50 && out.moneyRepaid === 1050,
    `C2 Storno: Rolex wieder mit 1100 im Lager, Verlust 50 gegengebucht, Rückzahlung 1050 (${S(out)})`);
  ok(r3(n(DB, 'SELECT qty_remaining * unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)])) === 1100, 'C2 das Los trägt wieder 1100');
  ok(stand() === s0 && einkauf(a.id) === p0, 'C2 Hauptbuch (Lager, Verlust, Bank), Lose und Einkauf wie vor der Rückgabe');
  abgleich('C2');
}

// ── C3 Volle Zusatzkosten-Erstattung (1000 + 100) per Kasse → Storno ─────────────────────────────────────────
{
  const a = await kauf('pw8', 1000, undefined, 1, 1000);
  await reparaturFertig('pw8', lotOf(DB, a.line), 100);
  const s0 = stand(), p0 = einkauf(a.id), kasse0 = soll('CASH');
  const r = ret(a.id, a.line, 1, 1000, 100, 'cash');
  ok(r3(soll('CASH') - kasse0) === 1100, 'C3 Rückgabe: Kasse +1100');
  const out = storno(a.id, r.returnId, true);
  ok(out.moneyRepaid === 1100 && out.repaidMethod === 'cash' && out.reversedLoss === 0 && stand() === s0 && einkauf(a.id) === p0,
    `C3 Storno: 1100 per Kasse zurück, kein Verlust, alles wie vorher (${S(out)})`);
  abgleich('C3');
}

// ── C4 Teilrückgabe (1 von 2) mit Lieferantenguthaben: Guthaben unbenutzt → entfernt; Restlos und Rückgabestück stimmen ──
{
  const a = await kauf('pw9', 500, undefined, 2, 1000);
  await reparaturFertig('pw9', lotOf(DB, a.line), 100);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 500, 20, 'credit');
  const cid = String(r.supplierCreditId);
  ok(r3(n(DB, 'SELECT amount FROM supplier_credits WHERE id = ?', [cid])) === 520, 'C4 Teilrückgabe: Guthaben 520, Verlust 30');
  const v = nichts();
  const out = storno(a.id, r.returnId, false);
  ok(out.moneyRepaid === 0 && out.supplierCreditRemoved === 520 && out.restoredBookValue === 550 && out.reversedLoss === 30 && v !== nichts(),
    `C4 Storno ohne Geld: Guthaben 520 entfernt, Stück mit 550 zurück, Verlust 30 gegengebucht (${S(out)})`);
  ok(n(DB, 'SELECT COUNT(*) FROM supplier_credits WHERE id = ?', [cid]) === 0 && n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 2,
    'C4 Guthaben weg, beide Stücke im Los');
  ok(stand() === s0 && einkauf(a.id) === p0, 'C4 alle Konten (auch Lieferantenguthaben), Lose und Einkauf wie vor der Rückgabe');
  abgleich('C4');
}

// ── C5 Einstand nach einer Teilrückgabe geändert (Reparatur am Reststück) → Nein mit damals/jetzt, nichts geschrieben ──
{
  const a = await kauf('pw10', 500, undefined, 2, 0);
  const r = ret(a.id, a.line, 1, 500, 0, 'bank');
  await reparaturFertig('pw10', lotOf(DB, a.line), 100);
  const v = nichts();
  const nein = await stornoNein(a.id, r.returnId, false);
  ok(nein.code === 'PURCHASE_RETURN_COST_CHANGED' && /then 500\.000, now 600\.000/.test(nein.msg) && nichts() === v,
    `C5 Kostenänderung nach der Rückgabe: ${nein.code}, nichts geschrieben (${nein.msg.slice(0, 110)})`);
  abgleich('C5');
}

// ── C6 Unbezahlter Einkauf (Rückgabe senkte nur die Schuld): kein Geld, Storno stellt A/P her ───────────────────
{
  const a = await kauf('pw11', 800, undefined, 1, 0);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 800, 0, 'bank');
  ok(n(DB, 'SELECT refund_amount FROM purchase_returns WHERE id = ?', [r.returnId]) === 0, 'C6 Rückgabe ohne Erstattung (nur Schuld gesenkt)');
  const out = storno(a.id, r.returnId, false);
  ok(out.moneyRepaid === 0 && stand() === s0 && einkauf(a.id) === p0, `C6 Storno ohne Geld: A/P und Einkauf wieder offen 800 (${einkauf(a.id)})`);
  abgleich('C6');
}

// ── C7 Gemeinsamer Artikel mit zwei Partnern (B 30 %, C 20 %): Verlust 50 geteilt, Storno setzt alle Anteile zurück ──
{
  const a = await kauf('pw12', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 300, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 200, 'pa-c');
  await reparaturFertig('pw12', lotOf(DB, a.line), 100);
  await move(a.line, 'CONTRIBUTION', 30, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 20, 'pa-c');
  const s0 = stand(), p0 = einkauf(a.id), b0 = open(a.line, 'pa-b'), c0 = open(a.line, 'pa-c');
  const r = ret(a.id, a.line, 1, 1000, 50);
  ok(open(a.line, 'pa-b') === r3(b0 + 330 - 15) && open(a.line, 'pa-c') === r3(c0 + 220 - 10),
    `C7 Rückgabe: B trägt 15, C trägt 10 vom Verlust 50 (B ${open(a.line, 'pa-b')}, C ${open(a.line, 'pa-c')})`);
  // Später ausgezahlt → Storno gesperrt (keine doppelte Auszahlung), konkret genannt.
  await move(a.line, 'PAYOUT', 315, 'pa-b', 'bank');
  const v = nichts();
  const nein = await stornoNein(a.id, r.returnId, true);
  ok(nein.code === 'PURCHASE_RETURN_PARTNER_LATER' && /Bashir payout 315\.000 BHD/.test(nein.msg) && nichts() === v,
    `C7 nach Auszahlung an B: Nein mit Partner, Art und Betrag, nichts geschrieben (${nein.msg.slice(0, 120)})`);
  // Die Auszahlung zurücknehmen (Erfassungsfehler), dann geht der Storno.
  const pay = s(DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' AND cancelled_at IS NULL", [a.line]);
  await save.cancelItemMovementOnPrimary(pay);
  const out = storno(a.id, r.returnId, true);
  ok(out.partnerMovementsReversed === 2 && open(a.line, 'pa-b') === b0 && open(a.line, 'pa-c') === c0,
    `C7 Storno: beide Partnerbuchungen (B, C) gegengebucht, Ansprüche wie vorher (B ${open(a.line, 'pa-b')}, C ${open(a.line, 'pa-c')})`);
  ok(stand() === s0 && einkauf(a.id) === p0, 'C7 Hauptbuch inkl. Partnerkonto, Lose und Einkauf wie vor der Rückgabe');
  abgleich('C7');
}

// ── C8 Bereits ausgeglichene Erstattung: Guthaben auf einen anderen Einkauf verrechnet → Nein mit Einkauf und Betrag ──
{
  const a = await kauf('pw13', 1000, undefined, 1, 1000);
  const r = ret(a.id, a.line, 1, 1000, 0, 'credit');
  const b = await kauf('pw14', 700, undefined, 1, 0);
  imHaus(() => payables.applyCreditToPurchaseInHouse(b.id, 400, localHouseCtx()));
  const pn = s(DB, 'SELECT purchase_number FROM purchases WHERE id = ?', [b.id]);
  const v = nichts();
  const nein = await stornoNein(a.id, r.returnId, false);
  ok(nein.code === 'PURCHASE_RETURN_CREDIT_USED' && nein.msg.includes(`400.000 BHD applied to ${pn}`) && nichts() === v,
    `C8 Guthaben verrechnet: Nein nennt ${pn} und 400, nichts geschrieben (${nein.msg.slice(0, 120)})`);
  abgleich('C8');
}

// ── C9 VAT_10: Vorsteuerkorrektur der Rückgabe bleibt in ihrem Tag, der Storno bucht heute zurück ──────────────
{
  const a = await kauf('pw15', 110, undefined, 1, 110, 'VAT_10');
  await reparaturFertig('pw15', lotOf(DB, a.line), 10);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 110, 0, 'benefit');
  const vatTag = s(DB, "SELECT occurred_at FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND account = 'VAT_INPUT' AND direction = 'CREDIT' ORDER BY rowid LIMIT 1", [r.returnId]);
  const out = storno(a.id, r.returnId, true);
  ok(out.moneyRepaid === 110 && out.repaidMethod === 'benefit' && out.reversedLoss === 10 && stand() === s0 && einkauf(a.id) === p0,
    `C9 VAT_10 per Benefit: Vorsteuer, Verlust, Geld und Einkauf wie vorher (${S(out)})`);
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND account = 'VAT_INPUT' AND direction = 'CREDIT' AND occurred_at = ?", [r.returnId, vatTag]) === 1,
    'C9 die ursprüngliche Vorsteuerkorrektur bleibt unverändert an ihrem Tag');
  abgleich('C9');
}

// ── C10 Geschützte Fälle: Kommission, ältere Rückgabe ohne Einstand, eingereichtes Quartal ──────────────────────
{
  // Ältere Rückgabe eines reparierten Stücks ohne festgehaltenen Einstand → nicht beweisbar, gesperrt.
  const a = await kauf('pw16', 1000, undefined, 1, 0);
  await reparaturFertig('pw16', lotOf(DB, a.line), 100);
  const r = ret(a.id, a.line, 1, 1000, 100, 'bank');
  DB.run('UPDATE purchase_return_lines SET unit_cost_at_return = NULL WHERE return_id = ?', [r.returnId]);
  const v = nichts();
  const nein = await stornoNein(a.id, r.returnId, true);
  ok(nein.code === 'PURCHASE_RETURN_COST_UNKNOWN' && nichts() === v, `C10 ältere Rückgabe eines reparierten Stücks: ${nein.code}, nichts geschrieben`);
  // Ältere Rückgabe ohne Zusatzkosten → sicher (Los trägt den Einkaufseinstand), Storno geht.
  const b = await kauf('pw17', 600, undefined, 1, 0);
  const s0 = stand(), p0 = einkauf(b.id);
  const rb = ret(b.id, b.line, 1, 600, 0, 'bank');
  DB.run('UPDATE purchase_return_lines SET unit_cost_at_return = NULL WHERE return_id = ?', [rb.returnId]);
  storno(b.id, rb.returnId, false);
  ok(stand() === s0 && einkauf(b.id) === p0, 'C10 ältere Rückgabe ohne Zusatzkosten: Storno vollständig');
  // Kommission → beim Kommissionsweg.
  const c = await kauf('pw18', 500, undefined, 1, 0);
  const rc = ret(c.id, c.line, 1, 500, 0, 'bank');
  DB.run("UPDATE purchases SET source_consignment_id = 'con-x' WHERE id = ?", [c.id]);
  const nk = await stornoNein(c.id, rc.returnId, false);
  ok(nk.code === 'PURCHASE_RETURN_CONSIGNMENT', `C10 Kommissionsrückgabe: ${nk.code}`);
  DB.run('UPDATE purchases SET source_consignment_id = NULL WHERE id = ?', [c.id]);
  // Das heutige Quartal ist eingereicht → die Gegenbuchung heute ginge in ein geschlossenes Quartal: Nein.
  const d = new Date();
  DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf-heute', 'branch-main', ?, ?, ?, '{}', ?)",
    [d.getFullYear(), Math.floor(d.getMonth() / 3) + 1, NOW, NOW]);
  const nv = await stornoNein(c.id, rc.returnId, false);
  ok(nv.code === 'VAT_PERIOD_FILED', `C10 eingereichtes Quartal: ${nv.code} (${nv.msg.slice(0, 80)})`);
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-heute'");
  ok(await stornoNein(c.id, rc.returnId, false).then((x) => x.code === ''), 'C10 nach Öffnen des Quartals: Storno geht');
  abgleich('C10');
}

// ── C11 Primary und PC2: Recht nur Owner; Fernweg mit Fassung; Wiederholung wirkt einmal; Rumpf ohne fremde Felder ──
{
  const a = await kauf('pw19', 900, undefined, 1, 900);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 900);
  const rev = n(DB, 'SELECT revision FROM purchases WHERE id = ?', [a.id]);
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000c1`;
  const ACT = (role: string | undefined, k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role, payloadHash: 'h' + k });
  const body = { purchaseId: a.id, returnId: r.returnId, expectedRevision: rev, reason: 'supplier sent it back', refundRepaid: true };
  for (const role of ['SALES', 'MANAGER', 'ACCOUNTANT', undefined]) {
    const v = nichts();
    const x = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT(role, 900 + (role?.length ?? 0)) as never);
    ok(x.kind === 'business_error' && (x as { code: string }).code === 'PERMISSION_DENIED' && nichts() === v, `C11 PC2 als ${role ?? 'ohne Rolle'}: PERMISSION_DENIED, nichts geschrieben`);
  }
  const f = await registry.executeCommand('purchases.cancel_return', { input: { ...body, refundAmount: 0 } }, ACT('ADMIN', 950) as never);
  ok(f.kind === 'business_error' && /primary decides refundAmount/.test(S(f)), 'C11 PC2: ein Rumpf mit Beträgen wird abgewiesen');
  const ohne = await registry.executeCommand('purchases.cancel_return', { input: { ...body, refundRepaid: false } }, ACT('ADMIN', 951) as never);
  ok(ohne.kind === 'business_error' && (ohne as { code: string }).code === 'PURCHASE_RETURN_REFUND_NOT_REPAID', 'C11 PC2 ohne bestätigte Rückzahlung: dasselbe Nein');
  const x1 = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT('ADMIN', 952) as never);
  const nachEins = nichts();
  const x2 = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT('ADMIN', 952) as never);
  ok(x1.kind === 'ok' && x2.kind === 'ok' && (x2 as { value?: { replayed?: boolean } }).value?.replayed === true && nichts() === nachEins,
    `C11 PC2 als Owner: Storno, dieselbe Auftragskennung wirkt nur einmal (${S(x2).slice(0, 100)})`);
  ok(stand() === s0 && einkauf(a.id) === p0 && retStatus(r.returnId) === 'CANCELLED', 'C11 PC2: alles wie vor der Rückgabe');
  // Primary: die Speicherfolge prüft das Recht der Sitzung (wie PC2).
  const b = await kauf('pw20', 400, undefined, 1, 0);
  const rb = ret(b.id, b.line, 1, 400, 0, 'bank');
  const lokal = { remote: false, save: async (ad: { local: () => Promise<unknown> }) => ({ kind: 'ok', value: await ad.local() }) };
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'SALES' } as never });
  const v = nichts();
  const ns = await purchaseSave.savePurchaseReturnCancel(lokal as never, { id: b.id }, { returnId: rb.returnId, reason: 'x', refundRepaid: false });
  ok(ns.kind === 'business_error' && (ns as { code: string }).code === 'PERMISSION_DENIED' && nichts() === v, 'C11 Primary als SALES: PERMISSION_DENIED, nichts geschrieben');
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
  const ja = await purchaseSave.savePurchaseReturnCancel(lokal as never, { id: b.id }, { returnId: rb.returnId, reason: 'entry error', refundRepaid: false });
  ok(ja.kind === 'ok' && retStatus(rb.returnId) === 'CANCELLED', `C11 Primary als Owner: Storno (${S(ja).slice(0, 80)})`);
  abgleich('C11');
}

console.log(`\nsupplier-return-cancel: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('SUPPLIER_RETURN_CANCEL_PROVED');

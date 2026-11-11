// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 — Storno einer Lieferantenrückgabe: Erfassungsfehler und echte Rückgabe (Geld, Guthaben, Partner, Lager, Perioden, PC2)
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
// „Cancel return" (Owner 11.11.2026): zwei Arten.
//   A entry_error — versehentlich erfasst, nichts erstattet: die falsch gebuchte Erstattung wird KORRIGIERT, keine Zahlung.
//   B reversed    — echte Rückgabe rückgängig: Geld nur mit nachgewiesener Rückzahlung (Bestätigung + Beleg), genau einmal.
// Nach jedem Storno: alle Hauptbuchsalden, Lose, Einkaufssummen und Partneransprüche wie VOR der Rückgabe; Banking zeigt nur
// echte Geldbewegungen; Original und Gegenbuchung bleiben im Hauptbuch (nichts gelöscht).
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const lifecycle = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const purchaseSave = await import('../../src/core/purchases/purchase-house.ts');
const DB = freshDb();
for (let i = 6; i <= 45; i++) {
  const pid = 'pw' + i;
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
type Shares = Array<{ partnerId: string; sharePct: number }>;
type Art = { kind?: string; repaid?: boolean; ref?: string };
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0, scheme: 'ZERO' | 'VAT_10' = 'ZERO') => {
  const id = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE(pid, price, shares, qty)], pay), taxScheme: scheme })).id;
  return { id, line: lineOf(DB, id, pid) };
};
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, addedCostRefund = 0, refundMethod = 'bank') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice, ...(addedCostRefund ? { addedCostRefund } : {}) }] }, localHouseCtx()));
const FEHLER: Art = { kind: 'entry_error' };
const ZURUECK = (ref = 'TRX-4711'): Art => ({ kind: 'reversed', repaid: true, ref });
const storno = (purchaseId: string, returnId: string, art: Art, reason = 'supplier sent the item back') =>
  imHaus(() => lifecycle.cancelPurchaseReturnInHouse({ purchaseId, returnId, reason, kind: art.kind as never, refundRepaid: art.repaid, repaymentReference: art.ref }, localHouseCtx()));
const stornoNein = async (purchaseId: string, returnId: string, art: Art): Promise<{ code: string; msg: string }> => {
  try { storno(purchaseId, returnId, art); return { code: '', msg: '' }; } catch (e) {
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
const BT = () => bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []) as Array<{ id: string; amount: number; flow: string; description?: string }>;
const abgleich = (tag: string) => {
  const hb = lagerHB(), be = lagerBestand();
  const rows = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows;
  const diff = (acc: string) => { const r = rows.find((x) => x.account === acc); return r ? Math.abs(Number(r.ledger) - Number(r.domain)) : 0; };
  ok(Math.abs(hb - be) < 0.0015 && ausgeglichen() && diff('PARTNER_ITEM_BALANCE') < 0.0005 && diff('ACCOUNTS_PAYABLE') < 0.0015 && diff('SUPPLIER_CREDIT') < 0.0015,
    `${tag} Abgleich: INVENTORY ${hb} = Lose ${be}; Partnerkonto, A/P und Lieferantenguthaben = Domäne; Hauptbuch ausgeglichen`);
};
async function reparaturFertig(pid: string, lot: string, kosten: number): Promise<void> {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten } as never)).id;
  await repairs.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  const ex = s(DB, "SELECT expense_id FROM repair_lines WHERE repair_id = ? LIMIT 1", [id]);
  imHaus(() => payables.recordExpensePaymentInHouse(ex, kosten, 'bank', localHouseCtx(), {}));
  await repairs.updateRepairStatusOnPrimary(id, 'ready' as never);
}
const retStatus = (rid: string): string => s(DB, 'SELECT status FROM purchase_returns WHERE id = ?', [rid]);
const originale = (rid: string): number => n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND reverses_entry_id IS NULL", [rid]);
const gegen = (rid: string): Array<Record<string, unknown>> => (DB.exec(
  "SELECT account, direction, amount, metadata_json, occurred_at FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND reverses_entry_id IS NOT NULL", [rid],
)[0]?.values ?? []).map((v) => ({ account: v[0], direction: v[1], amount: v[2], meta: JSON.parse(String(v[3] ?? '{}')), at: v[4] }));

// ── 1 Erfassungsfehler ohne echte Geldbewegung (als Bank-Erstattung gebucht) → korrigiert, keine Zahlung ──────────
{
  const a = await kauf('pw6', 1000, undefined, 1, 1000);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 1000);
  const orig = originale(r.returnId);
  const out = storno(a.id, r.returnId, FEHLER, 'recorded on the wrong purchase');
  ok(out.kind === 'entry_error' && out.moneyRepaid === 0 && out.repaidMethod === null && out.entryErrorCorrected === 1000,
    `1 Erfassungsfehler: keine Rückzahlung, die gebuchte Erstattung 1000 korrigiert (${S(out)})`);
  ok(stand() === s0 && einkauf(a.id) === p0, '1 alle Konten (auch Bank), Lose und der Einkauf wie vor der Rückgabe');
  const bt = BT();
  ok(!bt.some((t) => t.id === 'pret-' + r.returnId) && !bt.some((t) => t.id === 'pret-repay-' + r.returnId),
    '1 Banking: weder ein Eingang noch eine Rückzahlung (nie geflossen; wie eine stornierte Zahlung)');
  const g = gegen(r.returnId);
  ok(originale(r.returnId) === orig && g.length === orig && g.every((e) => e.meta.reversal === true && e.meta.purchaseReturnCancel === 'ENTRY_ERROR')
    && g.some((e) => e.account === 'BANK' && e.direction === 'CREDIT' && Number(e.amount) === 1000 && e.meta.money === 'entry-error-correction'),
    `1 Hauptbuch: Original bleibt (${orig}), jede Gegenbuchung als ENTRY_ERROR gekennzeichnet, die Bankzeile als Korrektur`);
  const row = DB.exec('SELECT status, cancel_kind, refund_repaid_amount, refund_repaid_reference, refund_amount, total_amount FROM purchase_returns WHERE id = ?', [r.returnId])[0].values[0];
  ok(S(row) === S(['CANCELLED', 'ENTRY_ERROR', 0, null, 1000, 1000]), `1 Rückgabe: CANCELLED, ENTRY_ERROR, keine Rückzahlung, Beträge bleiben (${S(row)})`);
  const au = s(DB, "SELECT new_value FROM audit_log WHERE entity_type = 'purchase_returns' AND entity_id = ? AND new_value LIKE '%CANCELLED%' ORDER BY rowid DESC LIMIT 1", [r.returnId]);
  ok(/"kind":"ENTRY_ERROR"/.test(au) && /"moneyRepaid":null/.test(au) && /"entryErrorCorrected":\{"amount":1000,"method":"bank"/.test(au) && /"reason":"recorded on the wrong purchase"/.test(au),
    '1 Protokoll: Art, Korrektur der falschen Erstattung (keine Zahlung), Grund');
  abgleich('1');
}

// ── 2 Tatsächliche Erstattung mit anschließender Rückzahlung (Bank, Beleg) ─────────────────────────────────────
{
  const a = await kauf('pw7', 1000, undefined, 1, 1000);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 1000);
  const out = storno(a.id, r.returnId, ZURUECK('TRX-0815'));
  ok(out.kind === 'reversed' && out.moneyRepaid === 1000 && out.repaidMethod === 'bank' && out.entryErrorCorrected === 0, `2 echte Rückzahlung 1000 per Bank (${S(out)})`);
  ok(stand() === s0 && einkauf(a.id) === p0, '2 alle Konten, Lose und der Einkauf wie vor der Rückgabe');
  const bt = BT();
  const ein = bt.find((t) => t.id === 'pret-' + r.returnId), aus = bt.find((t) => t.id === 'pret-repay-' + r.returnId);
  ok(ein?.amount === 1000 && ein.flow === 'in' && aus?.amount === 1000 && aus.flow === 'out' && /ref TRX-0815/.test(String(aus.description)),
    '2 Banking: echter Eingang bleibt, Rückzahlung als eigener Ausgang mit Beleg');
  const g = gegen(r.returnId);
  ok(g.every((e) => e.meta.purchaseReturnCancel === 'REVERSED') && g.some((e) => e.account === 'BANK' && e.direction === 'CREDIT' && e.meta.money === 'repaid-to-supplier' && e.meta.repaymentReference === 'TRX-0815'),
    '2 Hauptbuch: Gegenbuchung als REVERSED, die Bankzeile als echte Rückzahlung mit Beleg');
  ok(S(DB.exec('SELECT cancel_kind, refund_repaid_amount, refund_repaid_reference FROM purchase_returns WHERE id = ?', [r.returnId])[0].values[0]) === S(['REVERSED', 1000, 'TRX-0815']),
    '2 Rückgabe vermerkt REVERSED, 1000, Beleg');
  // Eine Rückzahlung wird genau einmal erfasst.
  const v = nichts();
  const zwei = await stornoNein(a.id, r.returnId, ZURUECK('TRX-0816'));
  ok(zwei.code === 'PURCHASE_RETURN_ALREADY_CANCELLED' && nichts() === v, `2 zweite Rückzahlung: ${zwei.code}, nichts geschrieben`);
  abgleich('2');
}

// ── 3 Erstattung erfolgt, Rückzahlung noch nicht → sichere Ablehnung; widersprüchliche Angaben ebenso ─────────────
{
  const a = await kauf('pw8', 1000, undefined, 1, 1000);
  const r = ret(a.id, a.line, 1, 1000, 0, 'cash');
  const v = nichts();
  const ohne = await stornoNein(a.id, r.returnId, { kind: 'reversed' });
  ok(ohne.code === 'PURCHASE_RETURN_REFUND_NOT_REPAID' && /paid 1000\.000 BHD back by cash/.test(ohne.msg) && /entry error instead/.test(ohne.msg) && nichts() === v,
    `3 ohne Rückzahlung: Nein mit Betrag, Weg und Hinweis auf Erfassungsfehler, nichts geschrieben (${ohne.msg.slice(0, 100)})`);
  const ohneBeleg = await stornoNein(a.id, r.returnId, { kind: 'reversed', repaid: true });
  ok(ohneBeleg.code === 'PURCHASE_RETURN_REFUND_NOT_REPAID' && /reference is missing/.test(ohneBeleg.msg) && nichts() === v, '3 Rückzahlung ohne Beleg: Nein, nichts geschrieben');
  const ohneArt = await stornoNein(a.id, r.returnId, {});
  ok(ohneArt.code === 'PURCHASE_RETURN_CANCEL_KIND_REQUIRED' && nichts() === v, '3 ohne Angabe der Art: Nein, nichts geschrieben');
  const widerspruch = await stornoNein(a.id, r.returnId, { kind: 'entry_error', repaid: true, ref: 'X' });
  ok(widerspruch.code === 'PURCHASE_RETURN_KIND_CONFLICT' && nichts() === v, '3 Erfassungsfehler mit Rückzahlung: Widerspruch, nichts geschrieben');
  ok(retStatus(r.returnId) === 'COMPLETED', '3 die Rückgabe bleibt gebucht');
  abgleich('3');
}

// ── 4 Reparierter Artikel mit Verlust: 1000 + 100 = 1100, Erstattung 1050 — einmal als Erfassungsfehler, einmal echt ──
for (const [pid, art, tag] of [['pw9', FEHLER, '4a Erfassungsfehler'], ['pw10', ZURUECK('BEN-77'), '4b echte Rückgabe']] as Array<[string, Art, string]>) {
  const a = await kauf(pid, 1000, undefined, 1, 1000);
  await reparaturFertig(pid, lotOf(DB, a.line), 100);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 1000, 50, 'benefit');
  const out = storno(a.id, r.returnId, art);
  ok(out.restoredBookValue === 1100 && out.reversedLoss === 50 && (art.kind === 'entry_error' ? out.entryErrorCorrected === 1050 && out.moneyRepaid === 0 : out.moneyRepaid === 1050),
    `${tag}: Rolex wieder mit 1100, Verlust 50 gegengebucht, Geld ${art.kind === 'entry_error' ? 'korrigiert' : 'zurückgezahlt'} (${S(out)})`);
  ok(stand() === s0 && einkauf(a.id) === p0 && r3(n(DB, 'SELECT qty_remaining * unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)])) === 1100,
    `${tag}: Hauptbuch (Lager, Verlust, Benefit), Lose und Einkauf wie vorher`);
  abgleich(tag);
}

// ── 5 Teilrückgabe (1 von 2) mit Lieferantenguthaben → unbenutzt entfernt, vollständig im Protokoll ───────────────
{
  const a = await kauf('pw11', 500, undefined, 2, 1000);
  await reparaturFertig('pw11', lotOf(DB, a.line), 100);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 500, 20, 'credit');
  const cid = String(r.supplierCreditId);
  const ja = await stornoNein(a.id, r.returnId, { kind: 'reversed', repaid: true, ref: 'X' });
  ok(ja.code === 'PURCHASE_RETURN_NOTHING_TO_REPAY', '5 Guthaben-Erstattung: es gibt keine Rückzahlung zu erfassen (Nein)');
  const out = storno(a.id, r.returnId, { kind: 'reversed' });
  ok(out.moneyRepaid === 0 && out.supplierCreditRemoved === 520 && out.restoredBookValue === 550 && out.reversedLoss === 30,
    `5 Storno ohne Geld: Guthaben 520 entfernt, Stück mit 550 zurück, Verlust 30 gegengebucht (${S(out)})`);
  ok(stand() === s0 && einkauf(a.id) === p0 && n(DB, 'SELECT qty_remaining FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === 2, '5 alles wie vorher, beide Stücke im Los');
  const au = s(DB, "SELECT new_value FROM audit_log WHERE entity_type = 'purchase_returns' AND entity_id = ? AND new_value LIKE '%CANCELLED%' ORDER BY rowid DESC LIMIT 1", [r.returnId]);
  ok(au.includes(`"supplierCreditRows":[{"id":"${cid}","amount":520,"usedAmount":0`), '5 Protokoll hält die entfernte, ungenutzte Guthabenzeile vollständig fest');
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_RETURN' AND source_id = ? AND account = 'SUPPLIER_CREDIT'", [r.returnId]) === 4,
    '5 die Guthabenbuchung und ihre Gegenbuchung bleiben im Hauptbuch (nichts gelöscht)');
  abgleich('5');
}

// ── 6 Mehrere Partner (B 30 %, C 20 %): Verlust geteilt; spätere Auszahlung sperrt beide Arten; danach Erfassungsfehler ──
{
  const a = await kauf('pw12', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 300, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 200, 'pa-c');
  await reparaturFertig('pw12', lotOf(DB, a.line), 100);
  await move(a.line, 'CONTRIBUTION', 30, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 20, 'pa-c');
  const s0 = stand(), p0 = einkauf(a.id), b0 = open(a.line, 'pa-b'), c0 = open(a.line, 'pa-c');
  const r = ret(a.id, a.line, 1, 1000, 50);
  ok(open(a.line, 'pa-b') === r3(b0 + 315) && open(a.line, 'pa-c') === r3(c0 + 210), `6 Rückgabe: B trägt 15, C trägt 10 (B ${open(a.line, 'pa-b')}, C ${open(a.line, 'pa-c')})`);
  await move(a.line, 'PAYOUT', 315, 'pa-b', 'bank');
  const v = nichts();
  for (const art of [FEHLER, ZURUECK()]) {
    const nein = await stornoNein(a.id, r.returnId, art);
    ok(nein.code === 'PURCHASE_RETURN_PARTNER_LATER' && /Bashir payout 315\.000 BHD/.test(nein.msg) && nichts() === v, `6 nach Auszahlung an B (${art.kind}): Nein mit Partner und Betrag, nichts geschrieben`);
  }
  const pay = s(DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' AND cancelled_at IS NULL", [a.line]);
  await save.cancelItemMovementOnPrimary(pay);
  const out = storno(a.id, r.returnId, FEHLER);
  ok(out.partnerMovementsReversed === 2 && open(a.line, 'pa-b') === b0 && open(a.line, 'pa-c') === c0 && stand() === s0 && einkauf(a.id) === p0,
    `6 Erfassungsfehler: beide Partnerbuchungen gegengebucht, Ansprüche, Hauptbuch und Einkauf wie vorher (B ${open(a.line, 'pa-b')}, C ${open(a.line, 'pa-c')})`);
  abgleich('6');
}

// ── 7 Bereits verwendetes Lieferantenguthaben → beide Arten gesperrt, mit Einkauf und Betrag ─────────────────────
{
  const a = await kauf('pw13', 1000, undefined, 1, 1000);
  const r = ret(a.id, a.line, 1, 1000, 0, 'credit');
  const b = await kauf('pw14', 700, undefined, 1, 0);
  imHaus(() => payables.applyCreditToPurchaseInHouse(b.id, 400, localHouseCtx()));
  const pn = s(DB, 'SELECT purchase_number FROM purchases WHERE id = ?', [b.id]);
  const v = nichts();
  for (const art of [FEHLER, { kind: 'reversed' }]) {
    const nein = await stornoNein(a.id, r.returnId, art);
    ok(nein.code === 'PURCHASE_RETURN_CREDIT_USED' && nein.msg.includes(`400.000 BHD applied to ${pn}`) && nichts() === v, `7 Guthaben verrechnet (${art.kind}): Nein nennt ${pn} und 400`);
  }
  abgleich('7');
}

// ── 8 Wiederholte PC2-Aufträge: Recht nur Owner (ADMIN); dieselbe Kennung wirkt einmal; neue Kennung danach: schon storniert ──
{
  const a = await kauf('pw15', 900, undefined, 1, 900);
  const s0 = stand(), p0 = einkauf(a.id);
  const r = ret(a.id, a.line, 1, 900);
  const rev = n(DB, 'SELECT revision FROM purchases WHERE id = ?', [a.id]);
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000d2`;
  const ACT = (role: string | undefined, k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role, payloadHash: 'h' + k });
  const body = { purchaseId: a.id, returnId: r.returnId, expectedRevision: rev, reason: 'booked twice by mistake', kind: 'entry_error' };
  for (const role of ['SALES', 'MANAGER', 'ACCOUNTANT', undefined]) {
    const v = nichts();
    const x = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT(role, 700 + (role?.length ?? 0)) as never);
    ok(x.kind === 'business_error' && (x as { code: string }).code === 'PERMISSION_DENIED' && nichts() === v, `8 PC2 als ${role ?? 'ohne Rolle'}: PERMISSION_DENIED`);
  }
  const ohneArt = await registry.executeCommand('purchases.cancel_return', { input: { ...body, kind: undefined } }, ACT('ADMIN', 760) as never);
  ok(ohneArt.kind === 'business_error' && (ohneArt as { code: string }).code === 'PURCHASE_RETURN_CANCEL_KIND_REQUIRED', '8 PC2 ohne Art: Nein');
  const f = await registry.executeCommand('purchases.cancel_return', { input: { ...body, refundAmount: 0 } }, ACT('ADMIN', 761) as never);
  ok(f.kind === 'business_error' && /primary decides refundAmount/.test(S(f)), '8 PC2: ein Rumpf mit Beträgen wird abgewiesen');
  const x1 = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT('ADMIN', 762) as never);
  const nachEins = nichts();
  const x2 = await registry.executeCommand('purchases.cancel_return', { input: body }, ACT('ADMIN', 762) as never);
  ok(x1.kind === 'ok' && x2.kind === 'ok' && (x2 as { value?: { replayed?: boolean } }).value?.replayed === true && nichts() === nachEins,
    '8 PC2 als Owner: Erfassungsfehler gebucht; dieselbe Kennung erneut: nur die eingefrorene Antwort');
  const x3 = await registry.executeCommand('purchases.cancel_return', { input: { ...body, expectedRevision: n(DB, 'SELECT revision FROM purchases WHERE id = ?', [a.id]) } }, ACT('ADMIN', 763) as never);
  ok(x3.kind === 'business_error' && (x3 as { code: string }).code === 'PURCHASE_RETURN_ALREADY_CANCELLED' && nichts() === nachEins, '8 neue Kennung danach: schon storniert, nichts geschrieben');
  ok(stand() === s0 && einkauf(a.id) === p0 && !BT().some((t) => t.id === 'pret-' + r.returnId), '8 alles wie vor der Rückgabe, Banking ohne Geldzeile');
  // Primary: Speicherfolge mit dem Recht der Sitzung.
  const b = await kauf('pw16', 400, undefined, 1, 0);
  const rb = ret(b.id, b.line, 1, 400, 0, 'bank');
  const lokal = { remote: false, save: async (ad: { local: () => Promise<unknown> }) => ({ kind: 'ok', value: await ad.local() }) };
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'SALES' } as never });
  const v = nichts();
  const ns = await purchaseSave.savePurchaseReturnCancel(lokal as never, { id: b.id }, { returnId: rb.returnId, reason: 'x', kind: 'entry_error', refundRepaid: false });
  ok(ns.kind === 'business_error' && (ns as { code: string }).code === 'PERMISSION_DENIED' && nichts() === v, '8 Primary als SALES: PERMISSION_DENIED');
  useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
  const ja = await purchaseSave.savePurchaseReturnCancel(lokal as never, { id: b.id }, { returnId: rb.returnId, reason: 'entry error', kind: 'entry_error', refundRepaid: false });
  ok(ja.kind === 'ok' && retStatus(rb.returnId) === 'CANCELLED', '8 Primary als Owner (ADMIN): Storno');
  abgleich('8');
}

// ── 9 Banking, Hauptbuch und Lager zusammen: Kasse-Erfassungsfehler und Bank-Rückgabe nebeneinander ──────────────
{
  const geld0 = (acc: string) => soll(acc);
  const k0 = geld0('CASH'), b0 = geld0('BANK');
  const a = await kauf('pw17', 300, undefined, 1, 0);
  const ra = ret(a.id, a.line, 1, 300, 0, 'cash');          // unbezahlt: nur Schuld gesenkt → kein Geld
  const b = await kauf('pw18', 400, undefined, 1, 400);
  const rb = ret(b.id, b.line, 1, 400, 0, 'bank');
  storno(a.id, ra.returnId, FEHLER);
  storno(b.id, rb.returnId, ZURUECK('TRX-9'));
  const bt = BT();
  const zeilen = bt.filter((t) => [ra.returnId, rb.returnId].some((id) => t.id.endsWith(id)));
  ok(S(zeilen.map((t) => [t.id.replace(/-[0-9a-f-]{36}$/, ''), t.flow, t.amount]).sort()) === S([['pret', 'in', 400], ['pret-repay', 'out', 400]].sort()),
    `9 Banking zeigt nur die echte Bewegung der Bank-Rückgabe (Eingang + Rückzahlung) (${S(zeilen.map((t) => t.id.slice(0, 12)))})`);
  ok(soll('CASH') === k0 && r3(soll('BANK') - b0) === -400, '9 Hauptbuch: Kasse unverändert, Bank −400 (Kauf), Rückgabe und Rückzahlung heben sich auf');
  abgleich('9');
}

// ── 10 Getrennte Buchungsperioden: Rückgabe in Q3 (eingereicht), Storno heute → Q3 bleibt unberührt; heutiges Quartal zu → Nein ──
{
  const a = await kauf('pw19', 1100, undefined, 1, 1100, 'VAT_10');
  const r = ret(a.id, a.line, 1, 1100, 0, 'bank');
  const q3 = '2026-08-15T10:00:00.000Z';
  DB.run("UPDATE ledger_entries SET occurred_at = ? WHERE source_module = 'PURCHASE_RETURN' AND source_id = ?", [q3, r.returnId]);
  DB.run('UPDATE purchase_returns SET return_date = ? WHERE id = ?', ['2026-08-15', r.returnId]);
  DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf-q3', 'branch-main', 2026, 3, ?, '{}', ?)", [NOW, NOW]);
  const q3vor = S(DB.exec("SELECT account, direction, amount, occurred_at FROM ledger_entries WHERE occurred_at < '2026-10-01' ORDER BY id")[0]?.values ?? []);
  const out = storno(a.id, r.returnId, FEHLER);
  const heute = new Date().toISOString().slice(0, 10);
  ok(out.entryErrorCorrected === 1100 && gegen(r.returnId).every((e) => String(e.at).slice(0, 10) === heute),
    `10 Q3 eingereicht: Storno erlaubt, die Gegenbuchung steht heute (${heute})`);
  ok(S(DB.exec("SELECT account, direction, amount, occurred_at FROM ledger_entries WHERE occurred_at < '2026-10-01' ORDER BY id")[0]?.values ?? []) === q3vor,
    '10 das eingereichte Q3 bleibt unverändert (Vorsteuerkorrektur und Bank am Ursprungstag)');
  // Heutiges Quartal eingereicht → die Gegenbuchung ginge in ein geschlossenes Quartal: Nein.
  const c = await kauf('pw20', 500, undefined, 1, 500);
  const rc = ret(c.id, c.line, 1, 500, 0, 'bank');
  const d = new Date();
  DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('vf-heute', 'branch-main', ?, ?, ?, '{}', ?)",
    [d.getFullYear(), Math.floor(d.getMonth() / 3) + 1, NOW, NOW]);
  const v = nichts();
  for (const art of [FEHLER, ZURUECK()]) {
    const nv = await stornoNein(c.id, rc.returnId, art);
    ok(nv.code === 'VAT_PERIOD_FILED' && nichts() === v, `10 heutiges Quartal eingereicht (${art.kind}): ${nv.code}, nichts geschrieben`);
  }
  DB.run("DELETE FROM vat_filings WHERE id IN ('vf-heute', 'vf-q3')");
  abgleich('10');
}

// ── 11 Geschützte Altfälle (unverändert): ältere Rückgabe mit Zusatzkosten ohne Einstand, Kommission, Kostenänderung ──
{
  const a = await kauf('pw21', 1000, undefined, 1, 0);
  await reparaturFertig('pw21', lotOf(DB, a.line), 100);
  const r = ret(a.id, a.line, 1, 1000, 100, 'bank');
  DB.run('UPDATE purchase_return_lines SET unit_cost_at_return = NULL WHERE return_id = ?', [r.returnId]);
  ok((await stornoNein(a.id, r.returnId, FEHLER)).code === 'PURCHASE_RETURN_COST_UNKNOWN', '11 ältere Rückgabe eines reparierten Stücks: COST_UNKNOWN');
  const c = await kauf('pw22', 500, undefined, 2, 0);
  const rc = ret(c.id, c.line, 1, 500, 0, 'bank');
  await reparaturFertig('pw22', lotOf(DB, c.line), 100);
  const nk = await stornoNein(c.id, rc.returnId, FEHLER);
  ok(nk.code === 'PURCHASE_RETURN_COST_CHANGED' && /then 500\.000, now 600\.000/.test(nk.msg), '11 Kostenänderung nach Teilrückgabe: COST_CHANGED mit damals/jetzt');
  const k = await kauf('pw23', 500, undefined, 1, 0);
  const rk = ret(k.id, k.line, 1, 500, 0, 'bank');
  DB.run("UPDATE purchases SET source_consignment_id = 'con-x' WHERE id = ?", [k.id]);
  ok((await stornoNein(k.id, rk.returnId, FEHLER)).code === 'PURCHASE_RETURN_CONSIGNMENT', '11 Kommission: beim Kommissionsweg');
  DB.run('UPDATE purchases SET source_consignment_id = NULL WHERE id = ?', [k.id]);
  abgleich('11');
}

console.log(`\nsupplier-return-cancel: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('SUPPLIER_RETURN_CANCEL_PROVED');

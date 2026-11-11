// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S3 (v0.8.101) — tatsächlicher Zahler artikelbezogener Kosten (LATAIF, Partner direkt, beide teilweise)
// und Werkstattgold an gemeinsamen Artikeln. Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-direct-payer.test.ts
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
// S3 — tatsächlicher Zahler einer artikelbezogenen Kostenstelle (Owner E1): LATAIF ganz, Partner ganz direkt an die
// Werkstatt, beide teilweise; zwei Partner; Storno; nicht zuordenbare Kosten; PC2 + Wiederholung; Werkstattgold (E2).
// Buchung der Direktzahlung: Soll A/P (Werkstatt) / Haben PARTNER_ITEM_BALANCE (Partner) — kein Geldkonto von LATAIF.
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const pcmds = await import('../../src/core/bridge/payables-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const goldSettle = await import('../../src/core/gold/gold-settle.ts');
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
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const saldo = (account: string, cp?: string): number => r3(n(DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${cp ? ' AND counterparty_id = ?' : ''}`,
  cp ? [account, cp] : [account]));
const geld = (): number => r3(-(saldo('CASH') + saldo('BANK') + saldo('BENEFIT')));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const gap = (account: string): number => {
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === account);
  return row ? r3(Number(row.ledger) - Number(row.domain)) : NaN;
};
const view = (line: string, partnerId = 'pa-b') => house.partnerItemsOverview('branch-main', partnerId)[0]?.items.find((i) => i.purchaseLineId === line);
const losKosten = (lot: string): number => r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]));
async function reparatur(pid: string, lotId: string | undefined, kosten: number, scope: 'OWN' | 'CUSTOMER' = 'OWN'): Promise<string> {
  return (await repairs.createRepairOnPrimary(scope === 'OWN'
    ? { repairScope: 'OWN', productId: pid, ...(lotId ? { lotId } : {}), issueDescription: 'Service', repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten } as never
    : { repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', chargeToCustomer: 300, taxScheme: 'ZERO', repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten,
        itemCategoryId: 'cat-w', itemBrand: 'Rolex', itemModel: 'X', itemReference: 'R' } as never)).id;
}
const status = (id: string, st: string) => repairs.updateRepairStatusOnPrimary(id, st as never);
const ausgabe = (repairId: string): string => s(DB, "SELECT expense_id FROM repair_lines WHERE repair_id = ? AND status = 'OPEN' LIMIT 1", [repairId]);
const exp = (id: string) => DB.exec('SELECT paid_amount, status, payment_method FROM expenses WHERE id = ?', [id])[0].values[0];
const zahlt = (exId: string, amount: number, method: string, partnerId?: string) =>
  imHaus(() => payables.recordExpensePaymentInHouse(exId, amount, method, localHouseCtx(), partnerId ? { partnerId } : {}));
const apWerkstatt = (): number => saldo('ACCOUNTS_PAYABLE', 'sup-1');
const banking = (): string => S(bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, [])
  .filter((t: { relatedModule?: string }) => t.relatedModule === 'expense').map((t: { id: string; amount: number }) => [t.id, t.amount]));
const PB40 = [{ partnerId: 'pa-b', sharePct: 40 }];

// ── D1 Partner zahlt die ganze Reparatur 100 direkt an die Werkstatt (60/40) ─────
{
  const a = await kauf('pw6', 1000, PB40, 1, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw6', lot, 100);
  await status(rid, 'in_progress');
  const ex = ausgabe(rid);
  ok(view(a.line)!.costDocs.some((d) => d.expenseId === ex && d.open === 100), 'D1 die offene Werkstattkosten steht am Partnerartikel zur Direktzahlung');
  const g0 = geld(), ap0 = apWerkstatt(), pb0 = saldo('PARTNER_ITEM_BALANCE', 'pa-b'), bank0 = banking();
  zahlt(ex, 100, 'partner', 'pa-b');
  const e = exp(ex);
  ok(Number(e[0]) === 100 && String(e[1]) === 'PAID' && String(e[2]) !== 'partner', `D1 Werkstattschuld beglichen (100, PAID), Geldweg der Ausgabe unverändert (${S(e)})`);
  ok(geld() === g0, 'D1 KEINE Geldbewegung von LATAIF (Kasse/Bank/Benefit unverändert)');
  ok(r3(ap0 - apWerkstatt()) === 100, `D1 Soll A/P Werkstatt 100 — die externe Werkstattschuld ist ausgeglichen (${r3(ap0 - apWerkstatt())})`);
  ok(r3(saldo('PARTNER_ITEM_BALANCE', 'pa-b') - pb0) === 100, 'D1 Haben PARTNER_ITEM_BALANCE (Partner) 100 — LATAIF schuldet ihm, was er für LATAIF bezahlt hat');
  ok(banking() === bank0, 'D1 Banking zeigt keinen Ausgabenabgang (die Zahlung war nicht von LATAIF)');
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'EXPENSE_PAYMENT'") === 0, 'D1 keine Geld-Buchung der Ausgabenzahlung');
  ok(open(a.line) === 60 && view(a.line)!.repairPending && await code(() => move(a.line, 'PAYOUT', 1)) === 'PARTNER_REPAIR_PENDING',
    `D1 vor „ready": Anspruch 60 (Anteil an der gebuchten Reparatur zählt schon), Auszahlung wartet bis „ready" (${open(a.line)})`);
  await status(rid, 'ready');
  ok(losKosten(lot) === 1100 && open(a.line) === 60 && !view(a.line)!.repairPending,
    `D1 „ready": Kostenanteil 40 von 100 → zugunsten des Partners 60 (${open(a.line)})`);
  ok(gap('ACCOUNTS_PAYABLE') === 0 && gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'D1 A/P und Partnerkonto: Hauptbuch = Bestand, ausgeglichen');
  await move(a.line, 'PAYOUT', 60, 'pa-b', 'bank');
  const v1 = verkauf(DB, 'pw6', lot, 1500, 'full');
  await save.settleSaleOnPrimary(v1.il);
  ok(open(a.line) === 600, `D1 Verkauf 1500 − 1100 = 400 Gewinn, B 160 → Kapital 440 + 160 = 600, Reparatur genau einmal (${open(a.line)})`);
}

// ── D2 Beide zahlen teilweise: LATAIF 70 bar, Partner 30 direkt ───────────────
{
  const a = await kauf('pw7', 1000, PB40, 1, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw7', lot, 100);
  await status(rid, 'in_progress');
  const ex = ausgabe(rid);
  const g0 = geld();
  zahlt(ex, 70, 'cash');
  zahlt(ex, 30, 'partner', 'pa-b');
  ok(r3(g0 - geld()) === 70 && Number(exp(ex)[0]) === 100 && String(exp(ex)[1]) === 'PAID', 'D2 Werkstatt voll bezahlt: 70 von LATAIF (Kasse), 30 vom Partner (kein Geld von LATAIF)');
  await status(rid, 'ready');
  ok(open(a.line) === -10, `D2 Partner trägt 40, hat 30 gezahlt → schuldet 10 (${open(a.line)})`);
  ok(await code(() => zahlt(ex, 1, 'partner', 'pa-b')) === 'EXPENSE_ALREADY_PAID', 'D2 keine zweite Zahlung auf eine beglichene Kostenstelle');
  ok(gap('ACCOUNTS_PAYABLE') === 0 && gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'D2 Abgleich ohne Differenz');
}

// ── D3 Storno der Direktzahlung: Werkstattschuld wieder offen, Partnerbuchung gedreht ──
{
  const a = await kauf('pw8', 1000, PB40, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw8', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  const ex = ausgabe(rid);
  const ap0 = apWerkstatt(), pb0 = saldo('PARTNER_ITEM_BALANCE', 'pa-b');
  zahlt(ex, 100, 'partner', 'pa-b');
  const mid = s(DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'direct'", [a.line]);
  ok(s(DB, "SELECT reference FROM expense_payments WHERE expense_id = ? AND method = 'partner'", [ex]) === mid, 'D3 Zahlungszeile verweist auf die Partnerbewegung');
  await save.cancelItemMovementOnPrimary(mid);
  ok(Number(exp(ex)[0]) === 0 && String(exp(ex)[1]) !== 'PAID' && n(DB, "SELECT COUNT(*) FROM expense_payments WHERE expense_id = ?", [ex]) === 0,
    `D3 Ausgabe wieder offen, Zahlungszeile entfernt (${S(exp(ex))})`);
  ok(apWerkstatt() === ap0 && saldo('PARTNER_ITEM_BALANCE', 'pa-b') === pb0 && open(a.line) === -40,
    `D3 A/P und Partnerkonto wie vorher; Partner schuldet seinen Anteil 40 an der gebuchten Reparatur (${open(a.line)})`);
  ok(gap('ACCOUNTS_PAYABLE') === 0 && gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'D3 Abgleich ohne Differenz');
}

// ── D4 Nicht zuordenbar: Kundenreparatur, fremder Partner, Überzahlung ───────────
{
  const a = await kauf('pw9', 1000, PB40, 1, 1000);
  const rid = await reparatur('pw9', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  const ex = ausgabe(rid);
  ok(await code(() => zahlt(ex, 10, 'partner', 'pa-c')) === 'PARTNER_COST_NOT_LINKED', 'D4 ein nicht beteiligter Partner darf nicht zahlen');
  ok(await code(() => zahlt(ex, 100.001, 'partner', 'pa-b')) === 'EXPENSE_OVERPAYMENT', 'D4 nie mehr als die offene Kostenstelle');
  ok(await code(() => zahlt(ex, 10, 'partner')) === 'PAYMENT_PARTNER_REQUIRED', 'D4 ohne Partner kein Zahlweg „partner"');
  const k = await reparatur('pw10', undefined, 50, 'CUSTOMER');
  await status(k, 'in_progress');
  ok(await code(() => zahlt(ausgabe(k), 10, 'partner', 'pa-b')) === 'PARTNER_COST_NOT_LINKED', 'D4 Kundenreparatur ist keine Artikelkosten eines gemeinsamen Artikels');
}

// ── D5 Zwei Partner (30/20), B zahlt die Reparatur 100 ganz ─────────────────────
{
  const a = await kauf('pw11', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 300, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 200, 'pa-c');
  const rid = await reparatur('pw11', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  zahlt(ausgabe(rid), 100, 'partner', 'pa-b');
  await status(rid, 'ready');
  ok(open(a.line, 'pa-b') === 70 && open(a.line, 'pa-c') === -20, `D5 B: +100 − 30 = +70; C trägt 20 → schuldet 20 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  ok(gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'D5 Abgleich ohne Differenz');
}

// ── D6 PC2 + Wiederholung; SALES ohne Wirkung ───────────────────────────────────
{
  const a = await kauf('pw12', 1000, PB40, 1, 1000);
  const rid = await reparatur('pw12', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  const ex = ausgabe(rid);
  const rev = n(DB, 'SELECT revision FROM expenses WHERE id = ?', [ex]);
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000d6`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
  const ident = (k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'expenses.record_payment', payloadHash: 'h' + k });
  const body = { expenseId: ex, expectedRevision: rev, amount: 100, method: 'partner', partnerId: 'pa-b' };
  const x1 = await pcmds.runExpensePayment(deps() as never, ident(1) as never, body) as { kind: string };
  const x2 = await pcmds.runExpensePayment(deps() as never, ident(1) as never, body) as { kind: string; replayed?: boolean };
  ok(x1.kind === 'ok' && x2.kind === 'ok' && x2.replayed === true && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'direct'", [a.line]) === 1,
    `D6 PC2 bucht genau einmal, Wiederholung ohne zweite Wirkung (${x1.kind}/${x2.kind})`);
  const sales = await registry.executeCommand('expenses.record_payment', { input: { ...body, amount: 1 } },
    { commandId: ID(9), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'SALES', payloadHash: 'h9' } as never) as { kind: string; code?: string };
  ok(sales.kind === 'business_error' && sales.code === 'PERMISSION_DENIED', 'D6 SALES: PERMISSION_DENIED (Zahlungsrecht wie jede Zahlung)');
}

// ── D7 Werkstattgold (E2): an gemeinsamem Artikel aktiviert und geteilt; sonst unverändert Betriebsausgabe ──
{
  const a = await kauf('pw13', 1000, PB40, 1, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw13', lot, 10);
  const gp = goldSettle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 2, karat: '18K', sourceRepairId: rid });
  const inv0 = -saldo('INVENTORY'), op0 = saldo('EXPENSES_OPERATING');
  const r = imHaus(() => goldSettle.settleGoldPayable({ branchId: 'branch-main', userId: 'user-test' }, { payableId: gp, mode: 'money', agreedBhd: 50 } as never));
  const cat = s(DB, 'SELECT category FROM expenses WHERE id = ?', [r.expenseId]);
  ok(cat === 'Inventory' && r3(-saldo('INVENTORY') - inv0) === 50 && losKosten(lot) === 1050 && open(a.line) === -20,
    `D7 gemeinsamer Artikel: Werkstattgold 50 aktiviert (Soll INVENTORY, Los 1050), B trägt 20 (${cat}, ${losKosten(lot)}, ${open(a.line)})`);
  ok(view(a.line)!.costDocs.some((d) => d.expenseId === r.expenseId && d.open === 50), 'D7 die Goldabrechnung ist eine offene Kostenstelle, die der Partner direkt zahlen darf');
  const b = await kauf('pw14', 800, undefined, 1, 800);
  const rid2 = await reparatur('pw14', lotOf(DB, b.line), 10);
  const gp2 = goldSettle.insertGoldPayable('branch-main', { supplierId: 'sup-1', weightGrams: 1, karat: '18K', sourceRepairId: rid2 });
  const r2 = imHaus(() => goldSettle.settleGoldPayable({ branchId: 'branch-main', userId: 'user-test' }, { payableId: gp2, mode: 'money', agreedBhd: 30 } as never));
  ok(s(DB, 'SELECT category FROM expenses WHERE id = ?', [r2.expenseId]) === 'RepairCosts' && losKosten(lotOf(DB, b.line)) === 800,
    'D7 eigener (nicht gemeinsamer) Artikel: Werkstattgold bleibt Betriebsausgabe, Los unverändert (keine pauschale Änderung)');
  void op0;
  ok(gap('ACCOUNTS_PAYABLE') === 0 && gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'D7 A/P (Werkstatt) und Partnerkonto: Hauptbuch = Bestand, ausgeglichen');
}

// ════════════════════════════════════════════════════════════════════════════
// ABSCHLUSSPRÜFUNG (Owner 11.11.2026): wirtschaftlicher Anspruch gegen Hauptbuch — nie 100 als frei verfügbar, wenn
// wirtschaftlich nur 60 geschuldet sind; vor/nach „ready", nach Verkauf, Auszahlung, S4-Verrechnung, Rückgängig, Übernahme.
// ════════════════════════════════════════════════════════════════════════════
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const st4 = await import('../../src/core/offsets/party-settlement.ts');
const { partnerOpenRows } = await import('../../src/core/partners/partner-open-balances.ts');
DB.run("UPDATE partners SET linked_customer_id = 'cust-1' WHERE id = 'pa-b'");
const angebotS4 = (line: string): number => sr.settleBalanceFor({ branchId: 'branch-main' }, 'cust-1').sources.find((x) => x.kind === 'PARTNER_ITEM' && x.id === line)?.open ?? 0;
const payableRow = (line: string, pid = 'pa-b') => partnerOpenRows(house.partnerItemsOverview('branch-main', pid)).find((r) => r.purchaseLineId === line);

// ── F1 60/40, Partner zahlt 100 direkt: Kette Werkstattschuld → Partnerkonto → Anteil 40 → Anspruch 60 ──
{
  const a = await kauf('pw20', 1000, PB40, 1, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const ap0 = apWerkstatt(), pb0 = saldo('PARTNER_ITEM_BALANCE', 'pa-b'), g0 = geld();
  const rid = await reparatur('pw20', lot, 100);
  await status(rid, 'in_progress');
  ok(r3(apWerkstatt() - ap0) === 100, 'F1 „in Arbeit": Werkstattschuld 100 (Haben A/P)');
  zahlt(ausgabe(rid), 100, 'partner', 'pa-b');
  ok(r3(apWerkstatt() - ap0) === 0 && r3(saldo('PARTNER_ITEM_BALANCE', 'pa-b') - pb0) === 100 && geld() === g0,
    'F1 nach Zahlung: Werkstattschuld 0, Partnerkonto +100 (Haben), kein Geld von LATAIF');
  // Vor „ready": wirtschaftlich schuldet LATAIF 60 — nie 100.
  const v = view(a.line)!;
  ok(open(a.line) === 60 && v.owedCost === 440, `F1 vor „ready": Anspruch 60 (Anteil 40 an der gebuchten Reparatur zählt schon), nie 100 (${open(a.line)}/${v.owedCost})`);
  ok(payableRow(a.line)?.open === 60 && payableRow(a.line)?.onHold === true, `F1 vor „ready": Verbindlichkeit 60, gesperrt (${S(payableRow(a.line))})`);
  ok(angebotS4(a.line) === 0, 'F1 vor „ready": in Settle Balance NICHT angeboten');
  ok(await code(() => move(a.line, 'PAYOUT', 1)) === 'PARTNER_REPAIR_PENDING', 'F1 vor „ready": Auszahlung gesperrt');
  ok(await code(() => save.takeOverOnPrimary({ purchaseLineId: a.line, expectedValue: 1000 })) !== '' && open(a.line) === 60,
    'F1 vor „ready": Übernahme durch LATAIF gesperrt (sonst entginge der Partner seinem Anteil)');
  await status(rid, 'ready');
  ok(open(a.line) === 60 && angebotS4(a.line) === 60 && payableRow(a.line)?.onHold === false,
    `F1 nach „ready": Anspruch 60, in Settle Balance genau 60 angeboten (${open(a.line)}/${angebotS4(a.line)})`);
  ok(await code(() => move(a.line, 'PAYOUT', 60.001)) === rules.PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, 'F1 Auszahlung über 60 abgewiesen');
  // S4: 60 gegen eine Rechnung, dann rückgängig.
  const lotR = s(DB, "SELECT id FROM stock_lots WHERE product_id = 'pw25' AND status = 'ACTIVE' LIMIT 1");
  void lotR;
  await kauf('pw25', 50, undefined, 1, 50);
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: 'pw25', quantity: 1, unitPrice: 200, purchasePrice: 50,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 200, lotId: s(DB, "SELECT id FROM stock_lots WHERE product_id = 'pw25' LIMIT 1") }] as never, 'P').id);
  reload();
  const r = sr.settleBalanceFor({ branchId: 'branch-main' }, 'cust-1');
  const sel = { invoiceIds: [inv], sourceIds: [a.line] };
  const pairs = sr.planSettlement(r.invoices, r.sources, sel);
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  const res = await st4.settleBalanceOnPrimary({ customerId: 'cust-1', ...sel, expectedStamp: r.stamp, expectedTotal: pairs.reduce((x, p) => x + p.amountF, 0) / 1000, settlementDate: today } as never);
  ok(res.total === 60 && open(a.line) === 0 && angebotS4(a.line) === 0, `F1 S4: genau 60 gegen die Rechnung verrechnet (${res.total})`);
  await st4.reverseSettlementOnPrimary({ settlementNumber: res.settlementNumber, expectedActiveLines: 1 } as never);
  ok(open(a.line) === 60, 'F1 S4 rückgängig: Anspruch wieder 60');
  // Verkauf: Kapital 440 + Gewinn 160 + Vorschuss 60 = 660; Partnerkonto = Domäne.
  const vk = verkauf(DB, 'pw20', lot, 1500, 'full');
  await save.settleSaleOnPrimary(vk.il);
  ok(open(a.line) === 660 && gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(),
    `F1 nach Verkauf 1500 (Einstand 1100): Kapital 440 + Gewinn 160 + vorgestreckte 60 = 660, Abgleich ohne Differenz (${open(a.line)})`);
}

// ── F2 Gegenprobe 70/30: LATAIF 70 bar, Partner 30 direkt → er schuldet 10 (nicht +30) ──
{
  const a = await kauf('pw21', 1000, PB40, 1, 1000);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw21', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  zahlt(ausgabe(rid), 70, 'cash');
  zahlt(ausgabe(rid), 30, 'partner', 'pa-b');
  ok(open(a.line) === -10 && angebotS4(a.line) === 0 && !payableRow(a.line) || payableRow(a.line)?.side === 'RECEIVABLE',
    `F2 vor „ready": Partner schuldet 10 (nie +30 als Verbindlichkeit) (${open(a.line)})`);
  await status(rid, 'ready');
  ok(open(a.line) === -10 && sr.settleBalanceFor({ branchId: 'branch-main' }, 'cust-1').invoices.every((i) => i.id !== a.line),
    'F2 nach „ready": schuldet 10 — offener Kostenanteil, nie als gebuchte Forderung verrechnet');
}

// ── F3 Mehrere Partner (30/20), B zahlt 100 direkt: B +70, C −20 — schon vor „ready" ──
{
  const a = await kauf('pw22', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  await move(a.line, 'CONTRIBUTION', 300, 'pa-b');
  await move(a.line, 'CONTRIBUTION', 200, 'pa-c');
  const rid = await reparatur('pw22', lotOf(DB, a.line), 100);
  await status(rid, 'in_progress');
  zahlt(ausgabe(rid), 100, 'partner', 'pa-b');
  ok(open(a.line, 'pa-b') === 70 && open(a.line, 'pa-c') === -20, `F3 vor „ready": B +70, C −20 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  await status(rid, 'ready');
  ok(open(a.line, 'pa-b') === 70 && open(a.line, 'pa-c') === -20 && gap('PARTNER_ITEM_BALANCE') === 0, 'F3 nach „ready": unverändert, Abgleich ohne Differenz');
}

console.log(`\npartner-direct-payer: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_DIRECT_PAYER_PROVED');

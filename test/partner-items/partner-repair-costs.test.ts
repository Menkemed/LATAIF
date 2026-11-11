// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S3 (v0.8.101) — Reparaturkosten am gemeinsamen Artikel über den echten Reparaturweg; Absicherungen
// verkaufter Artikel und gemischte Lose. Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-repair-costs.test.ts
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
// S3 — Reparaturkosten am gemeinsamen Artikel über den ECHTEN Reparaturweg (Anlage, „in Arbeit", „ready", Werkstattzahlung,
// Storno der Zeile): Partneranteil = Anteil × aktivierte Kosten des Loses, ein Schlüssel für Kosten und Gewinn, keine
// doppelte Belastung. Dazu die zwei Absicherungen: verkaufter Artikel → keine eigene Reparatur; gemischte Lose → Los Pflicht.
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
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const saldo = (account: string, cp?: string): number => r3(n(DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${cp ? ' AND counterparty_id = ?' : ''}`,
  cp ? [account, cp] : [account]));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const abgleich = (): number => {
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE')!;
  return r3(row.ledger - row.domain);
};
const view = (line: string, partnerId = 'pa-b') => house.partnerItemsOverview('branch-main', partnerId)[0]?.items.find((i) => i.purchaseLineId === line);
const losKosten = (lot: string): number => r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]));
async function reparatur(pid: string, lotId: string | undefined, kosten: number): Promise<string> {
  return (await repairs.createRepairOnPrimary({
    repairScope: 'OWN', productId: pid, ...(lotId ? { lotId } : {}), issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: kosten,
  } as never)).id;
}
const status = (id: string, st: string) => repairs.updateRepairStatusOnPrimary(id, st as never);
const werkstattAusgabe = (repairId: string): string => s(DB, "SELECT expense_id FROM repair_lines WHERE repair_id = ? AND status = 'OPEN' LIMIT 1", [repairId]);
const PB40 = [{ partnerId: 'pa-b', sharePct: 40 }];

// ── R1 LATAIF zahlt die Reparatur ganz: Partner trägt 40 % genau einmal ─────────
{
  const a = await kauf('pw6', 1000, PB40, 1, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const inv0 = saldo('INVENTORY'), ap0 = saldo('ACCOUNTS_PAYABLE', 'sup-1');
  const rid = await reparatur('pw6', lot, 100);
  await status(rid, 'in_progress');
  ok(r3(saldo('INVENTORY') - inv0) === 100 && r3(ap0 - saldo('ACCOUNTS_PAYABLE', 'sup-1')) === 100 && losKosten(lot) === 1000 && open(a.line) === -40,
    `R1 „in Arbeit": Soll INVENTORY 100 / Haben A/P Werkstatt 100; Los noch 1000, Partneranteil 40 an der gebuchten Reparatur zählt schon (${losKosten(lot)}, ${open(a.line)})`);
  await status(rid, 'ready');
  const v = view(a.line)!;
  ok(losKosten(lot) === 1100 && open(a.line) === -40 && v.extraCosts === 100 && v.extraCostShare === 40,
    `R1 „ready": Los 1100, B trägt 40 von 100 → schuldet 40 (${losKosten(lot)}, ${open(a.line)}, ${v.extraCosts}/${v.extraCostShare})`);
  const ex = werkstattAusgabe(rid);
  imHaus(() => payables.recordExpensePaymentInHouse(ex, 100, 'cash', localHouseCtx()));
  ok(open(a.line) === -40 && r3(saldo('ACCOUNTS_PAYABLE', 'sup-1') - ap0) === 0, 'R1 LATAIF bezahlt die Werkstatt bar: A/P 0, Partneranteil unverändert 40 (keine Doppelbelastung)');
  await move(a.line, 'CONTRIBUTION', 40);
  ok(open(a.line) === 0, 'R1 B zahlt seine 40 ein → ausgeglichen');
  ok(await code(() => move(a.line, 'CONTRIBUTION', 1)) === rules.PARTNER_ITEM_NOTHING_OWED, 'R1 kein zweites Einfordern: B schuldet nichts mehr');
  const v1 = verkauf(DB, 'pw6', lot, 1500, 'full');
  await save.settleSaleOnPrimary(v1.il);
  ok(open(a.line) === 600, `R1 Verkauf 1500 − Einstand 1100 = 400 Gewinn, B 160 → Kapital 440 + 160 = 600 (${open(a.line)})`);
  ok(abgleich() === 0 && ausgeglichen(), 'R1 Hauptbuch = Domäne, ausgeglichen');
  // Reparatur nach Verkauf und Abrechnung: verkaufter Artikel → keine eigene Reparatur (vorher still „in_repair").
  const c = await code(() => reparatur('pw6', undefined, 50));
  ok(c === 'PRODUCT_SOLD' && s(DB, "SELECT stock_status FROM products WHERE id = 'pw6'") === 'sold', `R1 nach Verkauf: eigene Reparatur abgewiesen, Artikel bleibt „sold" (${c})`);
}

// ── R2 Zwei Partner, Polieren + Ersatzteil als zwei Zeilen ──────────────────
{
  const a = await kauf('pw7', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  const lot = lotOf(DB, a.line);
  const rid = await reparatur('pw7', lot, 60);
  await repairs.addRepairLineOnPrimary(rid, { supplierId: 'sup-1', workType: 'polishing' as never, costAmount: 40 });
  await status(rid, 'in_progress');
  await status(rid, 'ready');
  ok(losKosten(lot) === 1100 && open(a.line, 'pa-b') === -330 && open(a.line, 'pa-c') === -220,
    `R2 Reparatur 60 + Polieren 40: B 300 + 30, C 200 + 20 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  // Storno einer Zeile nach „ready": der Einstand und die Anteile gehen genau zurück.
  const zeile = s(DB, "SELECT id FROM repair_lines WHERE repair_id = ? AND cost_amount = 40 AND status = 'OPEN'", [rid]);
  await repairs.cancelRepairLineOnPrimary(zeile);
  ok(losKosten(lot) === 1060 && open(a.line, 'pa-b') === -318 && open(a.line, 'pa-c') === -212,
    `R2 Zeile 40 storniert: B 318, C 212 (${open(a.line, 'pa-b')}/${open(a.line, 'pa-c')})`);
  ok(abgleich() === 0 && ausgeglichen(), 'R2 Abgleich ohne Differenz');
}

// ── R3 Mehrere Stücke in einem Los: die Reparatur verteilt sich auf die Stücke im Lager, der Anteil bleibt genau ──
{
  const a = await kauf('pw8', 500, PB40, 2, 1000);
  const lot = lotOf(DB, a.line);
  await move(a.line, 'CONTRIBUTION', 400);
  const rid = await reparatur('pw8', lot, 100);
  await status(rid, 'in_progress');
  await status(rid, 'ready');
  ok(losKosten(lot) === 550 && open(a.line) === -40, `R3 2 Stücke à 500, Reparatur 100: Los 550 je Stück, B schuldet 40 (${losKosten(lot)}, ${open(a.line)})`);
  await move(a.line, 'CONTRIBUTION', 40);
  const v3 = verkauf(DB, 'pw8', lot, 800, 'full');
  await save.settleSaleOnPrimary(v3.il);
  ok(open(a.line) === 320, `R3 1 Stück für 800 (Einstand 550): Gewinn 250, B 100; offen 440 + 100 − 220 = 320 (${open(a.line)})`);
  ok(abgleich() === 0 && ausgeglichen(), 'R3 Abgleich ohne Differenz');
}

// ── R4 Gemischte Lose (eigen + gemeinsam): ohne Los keine stille Zuordnung ──────
{
  const j = await kauf('pw9', 1000, PB40, 1, 1000);
  const o = await kauf('pw9', 900, undefined, 1, 900);
  const lotJ = lotOf(DB, j.line), lotO = lotOf(DB, o.line);
  ok(house.repairLotChoiceRequired('pw9') && !house.repairLotChoiceRequired('pw7'), 'R4 Los-Pflicht nur bei mehreren Losen mit einem gemeinsamen');
  const ohne = await code(() => reparatur('pw9', undefined, 100));
  ok(ohne === 'REPAIR_LOT_REQUIRED', `R4 ohne Los abgewiesen (${ohne})`);
  const rO = await reparatur('pw9', lotO, 100);
  await status(rO, 'in_progress');
  await status(rO, 'ready');
  ok(losKosten(lotO) === 1000 && losKosten(lotJ) === 1000 && open(j.line) === -400, `R4 Reparatur am eigenen Los: Partner unberührt (${losKosten(lotO)}/${losKosten(lotJ)}, ${open(j.line)})`);
  const rJ = await reparatur('pw9', lotJ, 50);
  await status(rJ, 'in_progress');
  await status(rJ, 'ready');
  ok(losKosten(lotJ) === 1050 && open(j.line) === -420, `R4 Reparatur am gemeinsamen Los: B +20 (${losKosten(lotJ)}, ${open(j.line)})`);
  // Sicherheitsnetz bei „ready": eine Reparatur, deren Los später gelöscht wurde, landet nicht still per FIFO.
  const rX = await reparatur('pw9', lotJ, 30);
  DB.run('UPDATE repairs SET lot_id = NULL WHERE id = ?', [rX]);
  await status(rX, 'in_progress');
  const st = await code(() => status(rX, 'ready'));
  ok(st === 'REPAIR_LOT_REQUIRED' && losKosten(lotJ) === 1050 && losKosten(lotO) === 1000, `R4 „ready" ohne Los bei gemischten Losen: abgewiesen, kein Los verändert (${st})`);
}

// ── R5 Code: die Maske kennt die Absage; die Anlage prüft vor jeder Wirkung ────
{
  ok(/productSold: \(id\) =>/.test(src('src/core/repairs/repair-house.ts')) && /lotChoiceRequired: \(productId\) => repairLotChoiceRequired/.test(src('src/core/repairs/repair-house.ts')),
    'R5 Primary-Anlage (auch PC2/Handy über dieselbe Hausfolge) prüft verkauft und Los-Pflicht');
}

console.log(`\npartner-repair-costs: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_REPAIR_COSTS_PROVED');

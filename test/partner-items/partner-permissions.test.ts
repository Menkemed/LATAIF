// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S2 (v0.8.101) — Partnergeld (Beitrag, Rückzahlung, Auszahlung, Storno, Gesellschafterbuchung) nur mit
// Zahlungsrecht; Primary und PC2 gleich; SALES ohne Wirkung abgewiesen. Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-permissions.test.ts
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
// S2 — Partnergeld nur mit Zahlungsrecht (`payments.*` oder Admin/Manager), am Primary (Maske + Speicherfolge) und am
// PC2 (`executeCommand`) gleich. SALES und ohne Rolle: PERMISSION_DENIED ohne jede Wirkung. Abrechnen, Verrechnen,
// Übernahme, Partnerwechsel bewegen kein Geld und bleiben frei.
// ════════════════════════════════════════════════════════════════════════════
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/money-commands.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const moneySave = await import('../../src/core/finance/money-save.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { executeCommand } = registry;
const DB = freshDb();
for (let i = 6; i <= 20; i++) {
  const pid = 'pw' + i;
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
  [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
}
reload();
const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACT = (role: string | undefined, k: number) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role, payloadHash: 'h' + k });
const als = (role: string) => useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never });
const zustand = () => S({
  m: DB.exec('SELECT id, kind, amount, cancelled_at FROM item_partner_movements ORDER BY rowid')[0]?.values ?? [],
  t: DB.exec('SELECT id, type, amount FROM partner_transactions ORDER BY rowid')[0]?.values ?? [],
  l: n(DB, 'SELECT COUNT(*) FROM ledger_entries'),
  c: n(DB, 'SELECT COUNT(*) FROM remote_command_ledger'),
});
const kauf = async (pid: string, price: number) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, [{ partnerId: 'pa-b', sharePct: 40 }])], price))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const GELD = ['partner_items.record_movement', 'partner_items.cancel_movement', 'partners.record_tx'];
const FREI = ['partner_items.settle_sale', 'partner_items.offset', 'partner_items.take_over', 'partner_items.change_partners'];
let k = 500;

// ── P1 Tabelle: dieselbe Regel wie „Record Payment" an der Rechnung ──────────
{
  for (const op of GELD) {
    const r = perms.permissionForOp(op) as { kind: string; permission?: string } | null;
    ok(r?.kind === 'permissionOrAdmin' && r.permission === 'payments.*', `P1 ${op}: payments.* oder Admin/Manager (${S(r)})`);
    ok(['SALES', 'ACCOUNTANT', 'MANAGER', 'ADMIN', 'owner', 'viewer', '', undefined].every((role) => perms.roleMayRunOp(role as never, op) === perms.roleMayRunOp(role as never, 'invoices.record_payment')),
      `P1 ${op}: für jede Rolle genau wie invoices.record_payment`);
    ok(!perms.roleMayRunOp('SALES', op) && !perms.roleMayRunOp(undefined, op) && ['ACCOUNTANT', 'MANAGER', 'ADMIN', 'owner'].every((role) => perms.roleMayRunOp(role, op)),
      `P1 ${op}: SALES/ohne Rolle nein; Buchhaltung, Manager, Admin (= Owner) ja`);
  }
  ok(FREI.every((op) => perms.permissionForOp(op) === null && perms.roleMayRunOp('SALES', op)), 'P1 ohne Geld (Abrechnen, Verrechnen, Übernahme, Wechsel): kein neues Tor');
}

// ── P2 Fernweg (PC2): SALES zahlt nichts ein und nichts aus, Storno ebenso; derselbe Rumpf als Buchhaltung wirkt einmal ──
{
  const a = await kauf('pw6', 1000);
  const body = { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'CONTRIBUTION', amount: 400, method: 'bank', date: '2026-09-21' };
  for (const role of ['SALES', 'viewer', undefined]) {
    const vorher = zustand();
    const r = await executeCommand('partner_items.record_movement', { input: body }, ACT(role, ++k) as never);
    ok(r.kind === 'business_error' && (r as { code: string }).code === 'PERMISSION_DENIED', `P2 fern Beitrag als ${role ?? 'ohne Rolle'}: PERMISSION_DENIED (${S(r).slice(0, 100)})`);
    ok(zustand() === vorher, `P2 fern als ${role ?? 'ohne Rolle'}: keine Bewegung, keine Buchung, kein Nachweis`);
  }
  const r = await executeCommand('partner_items.record_movement', { input: body }, ACT('ACCOUNTANT', ++k) as never);
  ok(r.kind === 'ok' && open(a.line) === 0 && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE kind = 'CONTRIBUTION' AND purchase_line_id = ?", [a.line]) === 1,
    `P2 fern Beitrag als Buchhaltung wirkt einmal (${S(r).slice(0, 80)})`);
  const mid = s(DB, "SELECT id FROM item_partner_movements WHERE kind = 'CONTRIBUTION' AND purchase_line_id = ?", [a.line]);
  const vorher = zustand();
  const c = await executeCommand('partner_items.cancel_movement', { input: { movementId: mid } }, ACT('SALES', ++k) as never);
  ok(c.kind === 'business_error' && (c as { code: string }).code === 'PERMISSION_DENIED' && zustand() === vorher, 'P2 fern Storno als SALES: PERMISSION_DENIED, nichts zurückgenommen');
  const tx = { partnerId: 'pa-b', kind: 'INVESTMENT', amount: 50, method: 'cash', date: '2026-09-21' };
  const t1 = await executeCommand('partners.record_tx', { input: tx }, ACT('SALES', ++k) as never);
  ok(t1.kind === 'business_error' && (t1 as { code: string }).code === 'PERMISSION_DENIED' && n(DB, 'SELECT COUNT(*) FROM partner_transactions') === 0,
    'P2 fern Gesellschafter-Einlage als SALES: PERMISSION_DENIED');
  const t2 = await executeCommand('partners.record_tx', { input: tx }, ACT('MANAGER', ++k) as never);
  ok(t2.kind === 'ok' && n(DB, 'SELECT COUNT(*) FROM partner_transactions') === 1, `P2 fern Einlage als Manager wirkt (${S(t2).slice(0, 80)})`);
  // Ohne Geld: Übernahme durch LATAIF bleibt für SALES möglich (kein neues Tor).
  const b = await kauf('pw7', 1000);
  const tk = await executeCommand('partner_items.take_over', { input: { purchaseLineId: b.line, expectedValue: 1000 } }, ACT('SALES', ++k) as never);
  ok(!(tk.kind === 'business_error' && (tk as { code: string }).code === 'PERMISSION_DENIED'), `P2 fern Übernahme (kein Geld) als SALES: kein Rechte-Tor (${S(tk).slice(0, 80)})`);
}

// ── P3 Primary-Maske: dieselbe Regel vor jeder Wirkung ─────────────────────
{
  const a = await kauf('pw8', 1000);
  const local = { remote: false, save: <T,>(_op: string, x: never) => runSharedWrite<T>(false, x, null) };
  for (const role of ['SALES', 'viewer']) {
    als(role);
    const vorher = zustand();
    const m = await save.saveItemMovement(local as never, { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'CONTRIBUTION', amount: 100, method: 'cash', date: '2026-09-21' });
    const t = await moneySave.savePartnerTx(local as never, { partnerId: 'pa-b', kind: 'WITHDRAWAL', amount: 10, method: 'cash', date: '2026-09-21' } as never);
    const mid = s(DB, "SELECT id FROM item_partner_movements WHERE kind = 'CONTRIBUTION' LIMIT 1");
    const c = await save.saveCancelMovement(local as never, mid);
    ok([m, t, c].every((x) => x.kind === 'business_error' && (x as { code: string }).code === 'PERMISSION_DENIED'),
      `P3 lokal als ${role}: Beitrag, Gesellschafter-Entnahme, Storno → PERMISSION_DENIED (${[m, t, c].map((x) => (x as { code?: string }).code).join(',')})`);
    ok(zustand() === vorher, `P3 lokal als ${role}: nichts geschrieben`);
  }
  als('ACCOUNTANT');
  const ok1 = await save.saveItemMovement(local as never, { purchaseLineId: a.line, partnerId: 'pa-b', kind: 'CONTRIBUTION', amount: 100, method: 'cash', date: '2026-09-21' });
  ok(ok1.kind === 'ok' && open(a.line) === -300, `P3 lokal als Buchhaltung wirkt (${S(ok1).slice(0, 80)} ${open(a.line)})`);
  als('ADMIN');
  const ok2 = await moneySave.savePartnerTx(local as never, { partnerId: 'pa-b', kind: 'INVESTMENT', amount: 10, method: 'cash', date: '2026-09-21' } as never);
  ok(ok2.kind === 'ok', 'P3 lokal Gesellschafter-Einlage als Admin (= Owner) wirkt');
}

// ── P4 Masken: Geldknöpfe nur mit Zahlungsrecht ─────────────────────────────
{
  const panel = src('src/components/partners/PartnerItemsPanel.tsx');
  ok(/canRecordPayments: canPay/.test(panel) && /canPay && \(it\.moneyAction === 'PAYS_IN'/.test(panel) && /canPay && it\.moneyAction === 'PAY_OUT'/.test(panel)
    && /canPay && !m\.cancelled/.test(panel) && /\} else if \(canPay\) \{/.test(panel), 'P4 Artikeltabelle: Pays in/Repays/Pay out/reverse nur mit Zahlungsrecht, auch aus der Karte');
  const karte = src('src/components/partners/PartnerCardItems.tsx');
  ok(/: !canPay \? null/.test(karte) && /\['Settle', 'SETTLE'\]/.test(karte), 'P4 Partnerkarte: Geldhandlung nur mit Zahlungsrecht, „Settle" bleibt');
  const seite = src('src/pages/partners/PartnersPage.tsx');
  ok(/\{canPay && <>[\s\S]{0,400}data-partner-tx-open="INVESTMENT"[\s\S]{0,400}data-partner-tx-open="PROFIT_DISTRIBUTION"/.test(seite), 'P4 Partnerseite: Invest/Withdraw/Profit Share nur mit Zahlungsrecht');
}

console.log(`\npartner-permissions: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_PAYMENT_PERMISSIONS_PROVED');

// v0.8.101 Release-Abstimmung (A Partner, B Settle Balance, C Lieferantenrückgaben auf einer DB) — Harness aus partner-ownership.
/* eslint-disable @typescript-eslint/no-unused-vars -- übernommener Harness */
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
// v0.8.101 Release-Abstimmung — A Partnerartikel, B Settle Balance, C Lieferantenrückgaben nacheinander auf EINER Datenbank.
// Nach jedem Block: jede Abgleichzeile (Hauptbuch − Bestand) unverändert gegenüber dem Start, INVENTORY = Σ Lose,
// Hauptbuch ausgeglichen, Gegenpartei-Audit ohne Drift; Settle Balance bewegt kein Geld. Am Ende alle Salden ausgedruckt.
// ════════════════════════════════════════════════════════════════════════════
const st = await import('../../src/core/offsets/party-settlement.ts');
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const po = await import('../../src/core/offsets/party-offsets.ts');
const money = await import('../../src/core/finance/money-house.ts');
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const lifecycle = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
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
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
type Shares = Array<{ partnerId: string; sharePct: number }>;
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0, scheme: 'ZERO' | 'VAT_10' = 'ZERO') => {
  const id = (await purchaseHouse.createPurchaseOnPrimary({ ...EINKAUF([ZEILE(pid, price, shares, qty)], pay), taxScheme: scheme })).id;
  return { id, line: lineOf(DB, id, pid) };
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const soll = (acc: string, cp?: string): number => r3(n(DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${cp ? ' AND counterparty_id = ?' : ''}`,
  cp ? [acc, cp] : [acc]));
const geld = (): number => r3(soll('CASH') + soll('BANK') + soll('BENEFIT') + soll('CARD_CLEARING'));
const lose = (): number => r3(n(DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED'"));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const zeilen = () => reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.map((r) => ({ account: String(r.account), ledger: r3(Number(r.ledger)), domain: r3(Number(r.domain)), gap: r3(Number(r.ledger) - Number(r.domain)) }));
const audit = () => runCounterpartyAudit(((sql: string, p?: unknown[]) => { const r = DB.exec(sql, p ?? [])[0]; return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : []; }) as never, 'branch-main')
  .issues.filter((i: { kind: string }) => i.kind === 'used_drift' || i.kind === 'overused' || i.kind === 'inconsistent_status');
const START = S(zeilen().map((z) => [z.account, z.gap]));
const pruefe = (tag: string) => {
  const z = zeilen();
  const diff = z.filter((x) => x.gap !== (JSON.parse(START) as Array<[string, number]>).find(([a]) => a === x.account)?.[1]);
  const inv = soll('INVENTORY'), lo = lose(), au = audit();
  ok(diff.length === 0 && Math.abs(inv - lo) < 0.0015 && ausgeglichen() && au.length === 0,
    `${tag} ABSTIMMUNG: 11 Abgleichzeilen Hauptbuch = Bestand (Abweichung ${S(diff.map((x) => [x.account, x.ledger, x.domain]))}), INVENTORY ${inv} = Lose ${lo}, ausgeglichen, Audit ${au.length}`);
};
const lese = (cid: string) => sr.settleBalanceFor({ branchId: 'branch-main' }, cid);
const auftrag = (cid: string, amounts: Array<{ invoiceId: string; sourceId: string; amount: number }> = [], sel?: { invoiceIds: string[]; sourceIds: string[] }) => {
  const r = lese(cid);
  const s0 = sel ?? { invoiceIds: r.invoices.map((i) => i.id), sourceIds: r.sources.map((x) => x.id) };
  const hand = Object.fromEntries(amounts.map((a) => [sr.settlePairKey(a.sourceId, a.invoiceId), Math.round(a.amount * 1000)]));
  const pairs = sr.planSettlement(r.invoices, r.sources, { ...s0, amounts: hand });
  const fin = sr.finalizingInvoices(r.invoices, pairs).filter((i) => !i.finalized);
  return { customerId: cid, ...s0, ...(amounts.length ? { amounts } : {}), expectedStamp: r.stamp, expectedTotal: pairs.reduce((a, p) => a + p.amountF, 0) / 1000,
    settlementDate: TODAY, ...(fin.length ? { finalNumbers: Object.fromEntries(fin.map((i) => [i.id, 'normal'])) } : {}) };
};
const settle = (req: Record<string, unknown>) => st.settleBalanceOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
const undo = (req: Record<string, unknown>) => st.reverseSettlementOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
const offenR = (inv: string): number => r3(n(DB, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [inv]));
function rechnung(pid: string, price: number): string {
  const lot = s(DB, "SELECT id FROM stock_lots WHERE product_id = ? AND status = 'ACTIVE' LIMIT 1", [pid]);
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId: pid, quantity: 1, unitPrice: price, purchasePrice: n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]),
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price, lotId: lot,
  }] as never, 'P').id);
  reload();
  return id;
}
async function reparatur(pid: string, lot: string, kosten: number, partnerTeil = 0): Promise<void> {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-2', estimatedCost: kosten } as never)).id;
  await repairs.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  const ex = s(DB, 'SELECT expense_id FROM repair_lines WHERE repair_id = ? LIMIT 1', [id]);
  if (partnerTeil > 0) imHaus(() => payables.recordExpensePaymentInHouse(ex, partnerTeil, 'partner', localHouseCtx(), { partnerId: 'pa-b' }));
  if (kosten - partnerTeil > 0) imHaus(() => payables.recordExpensePaymentInHouse(ex, kosten - partnerTeil, 'bank', localHouseCtx(), {}));
  await repairs.updateRepairStatusOnPrimary(id, 'ready' as never);
}
const ret = (purchaseId: string, line: string, qty: number, unitPrice: number, addedCostRefund = 0, refundMethod = 'bank') =>
  imHaus(() => returnToSupplierInHouse({ purchaseId, refundMethod: refundMethod as never, lines: [{ purchaseLineId: line, quantity: qty, unitPrice, ...(addedCostRefund ? { addedCostRefund } : {}) }] }, localHouseCtx()));
const storno = (purchaseId: string, returnId: string, kind: 'entry_error' | 'reversed', ref?: string) =>
  imHaus(() => lifecycle.cancelPurchaseReturnInHouse({ purchaseId, returnId, reason: 'audit', kind, refundRepaid: !!ref, repaymentReference: ref }, localHouseCtx()));
// Ein zweiter Lieferant als Werkstatt (sup-1 ist mit dem Kunden verknüpft und trägt die Einkaufsverrechnung).
DB.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-2', 'branch-main', 'Workshop', 1, ?, ?)", [NOW, NOW]);
DB.run("UPDATE partners SET linked_customer_id = 'cust-1' WHERE id = 'pa-b'");
DB.run("UPDATE suppliers SET linked_customer_id = 'cust-1' WHERE id = 'sup-1'");
reload();
pruefe('START');

// ══ A Partnerartikel ═════════════════════════════════════════════════════════
// A1 VAT_10 gemeinsam 1100 (netto 1000 + VAT 100), B 50 %; B zahlt seinen Bruttoanteil 550. Reparatur 100: B zahlt 60 direkt an
// die Werkstatt, LATAIF 40 per Bank. Verkauf 1700 bar, Abrechnung, Teilauszahlung an B 200.
const A1 = await kauf('pw6', 1100, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1100, 'VAT_10');
ok(r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, A1.line)])) === 1000 && r3(soll('VAT_INPUT')) === 100,
  'A1 VAT_10: Einstand netto 1000, abziehbare Vorsteuer 100');
await move(A1.line, 'CONTRIBUTION', 550);
const geldA = geld();
await reparatur('pw6', lotOf(DB, A1.line), 100, 60);
ok(r3(n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, A1.line)])) === 1100 && r3(geld() - geldA) === -40,
  'A1 Reparatur 100 aktiviert (Einstand 1100); LATAIF zahlt nur 40, B 60 direkt (kein Geld von LATAIF dafür)');
const claimVor = open(A1.line);
const vA1 = verkauf(DB, 'pw6', lotOf(DB, A1.line), 1700, 'full');
await save.settleSaleOnPrimary(vA1.il);
ok(open(A1.line) > claimVor, `A1 Verkauf 1700 abgerechnet: Anspruch von B steigt um seinen Gewinnanteil (${claimVor} → ${open(A1.line)})`);
await move(A1.line, 'PAYOUT', 200, 'pa-b', 'bank');
pruefe('A');

// ══ B Settle Balance ════════════════════════════════════════════════════════
// B1 (S4) Auszahlbares Partnerguthaben gegen eine Rechnung des verknüpften Kunden: Teilbetrag, Einzel-Reversal, erneut.
await kauf('pw10', 300, undefined, 1, 300);
const I1 = rechnung('pw10', 400);
{
  const g0 = geld();
  const r1 = await settle(auftrag('cust-1', [{ invoiceId: I1, sourceId: A1.line, amount: 120.5 }], { invoiceIds: [I1], sourceIds: [A1.line] }));
  ok(r1.ok && offenR(I1) === 279.5 && geld() === g0, `B1 Partnerguthaben 120.500 gegen Rechnung (frei gewählt), kein Geld (${r1.ok ? r1.v.settlementNumber : S(r1)})`);
  const o = s(DB, "SELECT id FROM party_offsets WHERE payable_type = 'PARTNER_ITEM' AND status = 'ACTIVE' LIMIT 1");
  await po.reverseDebtOffsetOnPrimary(o, 'audit');
  ok(offenR(I1) === 400 && geld() === g0, 'B1 Einzel-Reversal: Rechnung wieder 400, kein Geld');
  const r2 = await settle(auftrag('cust-1', [], { invoiceIds: [I1], sourceIds: [A1.line] }));
  ok(r2.ok && geld() === g0, `B1 erneut verrechnet (${r2.ok ? r2.v.settlementNumber : S(r2)})`);
}
pruefe('B1');
// B2 (S5) Gebuchte Partnerforderung (B hat 150 zu viel bekommen) gegen Store Credit (geteilt), We Borrowed und Einkauf.
const A2 = await kauf('pw11', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
await move(A2.line, 'CONTRIBUTION', 500);
const vA2 = verkauf(DB, 'pw11', lotOf(DB, A2.line), 1300, 'full');
await save.settleSaleOnPrimary(vA2.il);
await move(A2.line, 'PAYOUT', 650, 'pa-b', 'bank');
imHaus(() => createReturnInHouse({ invoiceId: vA2.inv, lines: [{ invoiceLineId: vA2.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'x', refundNow: true }, 'branch-main'));
reload();
await save.settleSaleOnPrimary(vA2.il);
const D = imHaus(() => money.createDebtInHouse({ direction: 'we_borrow', customerId: 'cust-1', amount: 80, source: 'cash' } as never, { branchId: 'branch-main', userId: 'user-test' })).debt.id;
const P = await kauf('pw12', 100, undefined, 1, 0);
await kauf('pw13', 30, undefined, 1, 30);
const lot13 = s(DB, "SELECT id FROM stock_lots WHERE product_id = 'pw13' LIMIT 1");
const iu = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ productId: 'pw13', quantity: 1, unitPrice: 50, purchasePrice: 30,
  taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 50, lotId: lot13 }] as never, 'P').id);
reload();
imHaus(() => useInvoiceStore.getState().recordPayment(iu, 90, 'cash'));
reload();
const cc = s(DB, "SELECT id FROM customer_credits WHERE customer_id = 'cust-1' AND status = 'OPEN' ORDER BY created_at DESC LIMIT 1");
{
  const rec = () => lese('cust-1').invoices.find((i) => i.kind === 'PARTNER_ITEM' && i.id === A2.line)?.open ?? 0;
  ok(rec() === 150 && r3(n(DB, 'SELECT amount FROM customer_credits WHERE id = ?', [cc])) === 40, `B2 gebuchte Partnerforderung 150, freies Store Credit 40 (${rec()})`);
  const g0 = geld();
  // Store Credit nur 30 von 40 (Rest 10 bleibt gemeinsam verfügbar), We Borrowed 80, Einkauf 40.
  const r = await settle(auftrag('cust-1', [
    { invoiceId: A2.line, sourceId: cc, amount: 30 }, { invoiceId: A2.line, sourceId: D, amount: 80 }, { invoiceId: A2.line, sourceId: P.id, amount: 40 },
  ], { invoiceIds: [A2.line], sourceIds: [cc, D, P.id] }));
  const c = DB.exec('SELECT used_amount, status FROM customer_credits WHERE id = ?', [cc])[0].values[0];
  ok(r.ok && rec() === 0 && r3(Number(c[0])) === 30 && String(c[1]) === 'OPEN' && geld() === g0
    && (lese('cust-1').sources.find((x) => x.id === cc)?.open ?? 0) === 10,
    `B2 eine STL mit drei Zuordnungen (30 + 80 + 40), Store-Credit-Rest 10 bleibt verfügbar, kein Geld (${r.ok ? r.v.settlementNumber : S(r)})`);
  pruefe('B2 gebucht');
  const u = await undo({ settlementNumber: r.ok ? r.v.settlementNumber : '', expectedActiveLines: 3, reason: 'audit' });
  ok(u.ok && rec() === 150 && r3(n(DB, 'SELECT used_amount FROM customer_credits WHERE id = ?', [cc])) === 0 && geld() === g0, 'B2 STL-Reversal: alles zurück, kein Geld');
  const r2 = await settle(auftrag('cust-1', [{ invoiceId: A2.line, sourceId: D, amount: 80 }], { invoiceIds: [A2.line], sourceIds: [D] }));
  ok(r2.ok && rec() === 70, 'B2 erneut: Darlehen 80 verrechnet, Forderung 70 bleibt');
}
pruefe('B2');

// ══ C Lieferantenrückgaben ══════════════════════════════════════════════════
// C1 Gemeinsam (B 50 %), Reparatur 100: Rückgabe 1000 + 50 per Bank → Verlust 50 (B trägt 25); bleibt gebucht.
const C1 = await kauf('pw20', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
await move(C1.line, 'CONTRIBUTION', 500);
await reparatur('pw20', lotOf(DB, C1.line), 100, 0);
await move(C1.line, 'CONTRIBUTION', 50);
{ const v0 = soll('INVENTORY_LOSS'); ret(C1.id, C1.line, 1, 1000, 50); ok(r3(soll('INVENTORY_LOSS') - v0) === 50, 'C1 Rückgabe mit Zusatzkosten: Verlust 50 auf INVENTORY_LOSS'); }
pruefe('C1');
// C2 Eigen, Reparatur 100: Rückgabe 1000 ohne Zusatzkosten (Verlust 100), dann Storno als Erfassungsfehler.
const C2 = await kauf('pw21', 1000, undefined, 1, 1000);
await reparatur('pw21', lotOf(DB, C2.line), 100, 0);
{ const r = ret(C2.id, C2.line, 1, 1000); storno(C2.id, r.returnId, 'entry_error'); ok(r3(lose()) === r3(soll('INVENTORY')), 'C2 Erfassungsfehler storniert: Stück wieder mit 1100'); }
pruefe('C2');
// C3 Eigen: Rückgabe 600 per Bank, Storno als echte Rückgabe mit Beleg.
const C3 = await kauf('pw22', 600, undefined, 1, 600);
{ const r = ret(C3.id, C3.line, 1, 600); const o = storno(C3.id, r.returnId, 'reversed', 'TRX-AUDIT'); ok(o.moneyRepaid === 600, 'C3 echte Rückzahlung 600 mit Beleg'); }
pruefe('C3');
// C4 Teilrückgabe 1 von 2 als Guthaben, Guthaben teilweise auf einen anderen Einkauf verrechnet; Storno dann gesperrt.
const C4 = await kauf('pw23', 400, undefined, 2, 800);
{
  const r = ret(C4.id, C4.line, 1, 400, 0, 'credit');
  const b = await kauf('pw24', 300, undefined, 1, 0);
  imHaus(() => payables.applyCreditToPurchaseInHouse(b.id, 150, localHouseCtx()));
  const nein = await code(() => Promise.resolve(storno(C4.id, r.returnId, 'entry_error')));
  ok(nein === 'PURCHASE_RETURN_CREDIT_USED', `C4 Teilrückgabe als Guthaben, teilweise verrechnet: Storno gesperrt (${nein})`);
}
pruefe('C4');
// C5 Gewinn bleibt gesperrt; Preis über dem Einkauf ebenso.
const C5 = await kauf('pw25', 500, undefined, 2, 1000);
await reparatur('pw25', lotOf(DB, C5.line), 100, 0);
{
  const v = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  ok(await code(() => Promise.resolve(ret(C5.id, C5.line, 1, 500, 50.001))) === 'PURCHASE_RETURN_ADDED_REFUND_TOO_HIGH'
    && await code(() => Promise.resolve(ret(C5.id, C5.line, 1, 600))) === 'PURCHASE_RETURN_PRICE_ABOVE_PURCHASE'
    && n(DB, 'SELECT COUNT(*) FROM ledger_entries') === v, 'C5 Gewinn und Preis über Einkauf abgewiesen, nichts gebucht');
}
pruefe('ENDE');

// Ausdruck für den Bericht: alle Abgleichzeilen und Bestände.
console.log('\nABSTIMMUNG ENDE (Hauptbuch / Bestand):');
for (const z of zeilen()) console.log(`  ${z.account.padEnd(24)} ${String(z.ledger).padStart(12)} ${String(z.domain).padStart(12)}  Δ ${z.gap}`);
console.log(`  ${'INVENTORY (Lose)'.padEnd(24)} ${String(soll('INVENTORY')).padStart(12)} ${String(lose()).padStart(12)}`);
console.log(`  Partner B offen: A1 ${open(A1.line)} · A2 ${open(A2.line)} · C1 ${open(C1.line)}; Geld ${geld()}; INVENTORY_LOSS ${soll('INVENTORY_LOSS')}; ausgeglichen ${ausgeglichen()}`);

console.log(`\nrelease-reconciliation: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('RELEASE_RECONCILIATION_V0101_PROVED');

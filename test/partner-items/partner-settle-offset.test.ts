// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S4 (v0.8.101) — auszahlbares Partnerguthaben gegen Kundenrechnungen in Settle Balance (STL, FIFO,
// Teilbeträge, Rückgängig, Storno, Sperren, PC2). Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-settle-offset.test.ts
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
// S4 — auszahlbares Partnerguthaben gegen offene Rechnungen DESSELBEN Menschen (Partner ausdrücklich mit dem Kunden
// verknüpft) in „Settle Balance": eine STL, FIFO, Teilbeträge, keine Geldbewegung, Buchung Soll PARTNER_ITEM_BALANCE
// (Partner) / Haben AR (Kunde), Partnerkonto = Kundenkonto = Hauptbuch, Rückgängig je Zuordnung und als ganze STL,
// Storno der Rechnung, Sperren, PC2 + Wiederholung. Nie angeboten: Kostenanteil, Rückforderung, gesperrtes Guthaben.
// ════════════════════════════════════════════════════════════════════════════
const st = await import('../../src/core/offsets/party-settlement.ts');
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const po = await import('../../src/core/offsets/party-offsets.ts');
const pcmd = await import('../../src/core/bridge/party-commands.ts');
const ca = await import('../../src/core/parties/customer-account.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
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
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
type Shares = Array<{ partnerId: string; sharePct: number }>;
const kauf = async (pid: string, price: number, shares: Shares | undefined, qty = 1, pay = 0) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares, qty)], pay))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const saldo = (account: string, cp?: string): number => r3(n(DB,
  `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?${cp ? ' AND counterparty_id = ?' : ''}`,
  cp ? [account, cp] : [account]));
const geld = (): string => S(['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING'].map((a) => saldo(a)));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const gap = (account: string): number => {
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === account);
  return row ? r3(Number(row.ledger) - Number(row.domain)) : NaN;
};
const offenR = (inv: string): number => r3(n(DB, `SELECT gross_amount - paid_amount FROM invoices WHERE id = ?`, [inv]));
const lese = (cid: string) => sr.settleBalanceFor({ branchId: 'branch-main' }, cid);
const key = sr.settlePairKey;
const auftrag = (cid: string, amounts: Array<{ invoiceId: string; sourceId: string; amount: number }> = [], sel?: { invoiceIds: string[]; sourceIds: string[] }) => {
  const r = lese(cid);
  const s0 = sel ?? { invoiceIds: r.invoices.map((i) => i.id), sourceIds: r.sources.map((x) => x.id) };
  const hand = Object.fromEntries(amounts.map((a) => [key(a.sourceId, a.invoiceId), Math.round(a.amount * 1000)]));
  const pairs = sr.planSettlement(r.invoices, r.sources, { ...s0, amounts: hand });
  const fin = sr.finalizingInvoices(r.invoices, pairs).filter((i) => !i.finalized);
  return { customerId: cid, ...s0, ...(amounts.length ? { amounts } : {}), expectedStamp: r.stamp, expectedTotal: pairs.reduce((a, p) => a + p.amountF, 0) / 1000,
    settlementDate: TODAY, ...(fin.length ? { finalNumbers: Object.fromEntries(fin.map((i) => [i.id, 'normal'])) } : {}) };
};
const settle = (req: Record<string, unknown>) => st.settleBalanceOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
const undo = (req: Record<string, unknown>) => st.reverseSettlementOnPrimary(req as never).then((v) => ({ ok: true as const, v }), (e: { code?: string; message?: string }) => ({ ok: false as const, code: String(e.code ?? e.message) }));
function rechnung(pid: string, price: number): string {
  const lot = s(DB, "SELECT id FROM stock_lots WHERE product_id = ? AND status = 'ACTIVE' LIMIT 1", [pid]);
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{
    productId: pid, quantity: 1, unitPrice: price, purchasePrice: n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]),
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price, lotId: lot,
  }] as never, 'P').id);
  reload();
  return id;
}
const bewegungen = (line: string) => DB.exec("SELECT kind, amount, method, invoice_id, cancelled_at FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'PAYOUT' ORDER BY rowid", [line])[0]?.values ?? [];
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000c4`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = () => ({
  db: DB as never,
  begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {}, now: () => NOW,
});
async function fern(p: () => Promise<unknown>): Promise<{ kind: string; code?: string; replayed?: boolean }> {
  try { return await p() as never; } catch (e) { return { kind: 'thrown', code: String((e as { code?: string }).code ?? (e as Error).message) }; }
}

// ── Aufbau: Partner B ↔ Kunde verknüpft; B: Artikel A verkauft + abgerechnet (LATAIF schuldet 650), Artikel K (B schuldet Kostenanteil) ──
const A = await kauf('pw6', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
await move(A.line, 'CONTRIBUTION', 500);
const vA = verkauf(DB, 'pw6', lotOf(DB, A.line), 1300, 'full');
await save.settleSaleOnPrimary(vA.il);
const KO = await kauf('pw7', 600, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 600);
await kauf('pw10', 300, undefined, 1, 300);
await kauf('pw11', 200, undefined, 1, 200);
await kauf('pw12', 100, undefined, 1, 100);
const I1 = rechnung('pw10', 400);
const I2 = rechnung('pw11', 300);
ok(open(A.line) === 650 && open(KO.line) === -300 && offenR(I1) === 400 && offenR(I2) === 300, `AUFBAU B: +650 an A, −300 an K; Rechnungen 400/300 offen (${open(A.line)}/${open(KO.line)})`);

// ── T1 Ohne Verknüpfung: nichts angeboten ──────────────────────────────────
{
  const r = lese('cust-1');
  ok(!r.sources.some((x) => x.kind === 'PARTNER_ITEM'), 'T1 Partner nicht mit dem Kunden verknüpft → kein Partnerguthaben angeboten (kein Abgleich über Namen)');
  DB.run("UPDATE partners SET linked_customer_id = 'cust-1' WHERE id = 'pa-b'");
}

// ── T2 Angebot: nur das auszahlbare Guthaben, gekennzeichnet; nie der Kostenanteil ──
{
  const r = lese('cust-1');
  const p = r.sources.filter((x) => x.kind === 'PARTNER_ITEM');
  ok(p.length === 1 && p[0].id === A.line && p[0].open === 650 && p[0].partnerId === 'pa-b' && /^partner balance · /.test(p[0].label),
    `T2 genau EIN Partnerguthaben: Artikel A, 650, Partner B (${S(p.map((x) => [x.id === A.line, x.open, x.label]))})`);
  ok(!r.sources.some((x) => x.id === KO.line), 'T2 Kostenanteil, den B schuldet (K, −300), wird nie angeboten');
  ok(sr.SETTLE_SOURCE_ORDER.at(-1) === 'PARTNER_ITEM' && sr.SETTLE_SOURCE_LABEL.PARTNER_ITEM === 'Partner balances', 'T2 vierte Gruppe „Partner balances"');
}

// ── T3 Verrechnen: FIFO über zwei Rechnungen, eine STL, kein Geld, Hauptbuch und Abgleich ──
let STL = '';
{
  const geld0 = geld(), pib0 = saldo('PARTNER_ITEM_BALANCE', 'pa-b'), ar0 = saldo('ACCOUNTS_RECEIVABLE', 'cust-1');
  const gP0 = gap('PARTNER_ITEM_BALANCE'), gA0 = gap('ACCOUNTS_RECEIVABLE');
  const banking0 = S(bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []).map((t: { id: string }) => t.id));
  const res = await settle(auftrag('cust-1'));
  ok(res.ok, `T3 gebucht (${S(res).slice(0, 160)})`);
  STL = res.ok ? res.v.settlementNumber : '';
  ok(offenR(I1) === 0 && offenR(I2) === 50 && open(A.line) === 0, `T3 I1 400 voll, I2 250 von 300, Partner 650 → 0 (${offenR(I1)}/${offenR(I2)}/${open(A.line)})`);
  ok(geld() === geld0, 'T3 keine Geldbewegung (Kasse, Bank, Benefit, Karte unverändert)');
  ok(r3(saldo('PARTNER_ITEM_BALANCE', 'pa-b') - pib0) === -650 && r3(saldo('ACCOUNTS_RECEIVABLE', 'cust-1') - ar0) === 650,
    'T3 Soll PARTNER_ITEM_BALANCE (Partner B) 650 / Haben AR (Kunde) 650');
  ok(gap('PARTNER_ITEM_BALANCE') === gP0 && gap('ACCOUNTS_RECEIVABLE') === gA0 && ausgeglichen(), 'T3 Partnerkonto und AR: Hauptbuch = Bestand, ausgeglichen');
  const b = bewegungen(A.line);
  ok(b.length === 2 && b.every((m) => m[0] === 'PAYOUT' && m[2] === 'offset' && m[4] === null) && r3(b.reduce((a, m) => a + Number(m[1]), 0)) === 650,
    `T3 am Partnerartikel: zwei Auszahlungen per Verrechnung (400 + 250), Bezug Rechnung (${S(b)})`);
  ok(n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PARTNER_ITEM' AND source_id IN (SELECT id FROM item_partner_movements WHERE method = 'offset')") === 0,
    'T3 die Auszahlungszeilen buchen nicht selbst — EINE Buchung je Zuordnung (an der Rechnungszahlung)');
  ok(n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND payable_type = 'PARTNER_ITEM' AND status = 'ACTIVE'", [STL]) === 2, 'T3 zwei Zuordnungen unter EINER STL');
  ok(S(bankTransactionsFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'ADMIN' } as never, []).map((t: { id: string }) => t.id)) === banking0, 'T3 Banking unverändert');
  const k = ca.customerAccountFor({ branchId: 'branch-main' } as never, 'cust-1');
  ok(k.statement.some((x) => x.docKey === `invoice:${I1}` && /· partner balance \S+ · no cash$/.test(x.text)), 'T3 Kontoauszug: Gegenbeleg „partner balance …"');
  ok(!k.docs.some((d) => d.key === `partner:pa-b:${A.line}`), 'T3 Kundenkonto: das Partnerguthaben an A ist erledigt (kein offener Posten mehr)');
  const lines = sr.settlementsOf('cust-1', 'branch-main').flatMap((x) => x.lines).filter((l) => l.sourceKind === 'PARTNER_ITEM');
  ok(lines.length === 2 && lines.every((l) => l.partnerId === 'pa-b' && l.sourceId === A.line), 'T3 Verrechnungsliste: Quelle PARTNER_ITEM mit Partner und Artikel');
  ok(await code(() => move(A.line, 'PAYOUT', 1)) === rules.PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, 'T3 keine zweite Auszahlung desselben Guthabens');
  const mid = s(DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'offset' LIMIT 1", [A.line]);
  ok(await code(() => save.cancelItemMovementOnPrimary(mid)) === 'PARTNER_MOVEMENT_IS_OFFSET', 'T3 die Auszahlung per Verrechnung ist nicht einzeln stornierbar (nur über die Rechnung)');
}

// ── T4 Eine Zuordnung rückgängig („Remove offset" an der Rechnung) ─────────
{
  const o = DB.exec("SELECT id FROM party_offsets WHERE settlement_number = ? AND receivable_id = ? AND status = 'ACTIVE'", [STL, I2])[0].values[0][0] as string;
  await po.reverseDebtOffsetOnPrimary(o, 'test');
  ok(offenR(I2) === 300 && open(A.line) === 250 && String(one(DB, 'SELECT status FROM party_offsets WHERE id = ?', [o])) === 'REVERSED',
    `T4 I2 wieder 300 offen, Partner wieder 250 auszahlbar, Zuordnung REVERSED (${offenR(I2)}/${open(A.line)})`);
  ok(n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'offset' AND cancelled_at IS NOT NULL", [A.line]) === 1, 'T4 die Auszahlung per Verrechnung ist storniert (nicht gelöscht)');
  ok(gap('PARTNER_ITEM_BALANCE') === 0 || ausgeglichen(), 'T4 ausgeglichen');
}

// ── T5 Ganze STL rückgängig ─────────────────────────────────────────────────
{
  const res = await undo({ settlementNumber: STL, expectedActiveLines: 1, reason: 'test' });
  ok(res.ok && offenR(I1) === 400 && offenR(I2) === 300 && open(A.line) === 650, `T5 STL zurück: Rechnungen 400/300, Partner 650 (${S(res).slice(0, 80)})`);
  ok(saldo('PARTNER_ITEM_BALANCE', 'pa-b') === 650 && ausgeglichen(), 'T5 Partnerkonto wieder 650 (Haben), ausgeglichen');
}

// ── T6 Teilbetrag („Change amount") und freie Auswahl ──────────────────────
{
  const req = auftrag('cust-1', [{ invoiceId: I1, sourceId: A.line, amount: 120.5 }], { invoiceIds: [I1], sourceIds: [A.line] });
  const res = await settle(req);
  ok(res.ok && offenR(I1) === 279.5 && open(A.line) === 529.5, `T6 frei gewählt 120.500: I1 279.5, Partner 529.5 (${offenR(I1)}/${open(A.line)})`);
  const zuViel = auftrag('cust-1', [{ invoiceId: I2, sourceId: A.line, amount: 300.001 }], { invoiceIds: [I2], sourceIds: [A.line] });
  const r2 = await settle(zuViel);
  ok(!r2.ok && /SETTLE_AMOUNT_TOO_HIGH/.test(r2.code ?? ''), `T6 über der Obergrenze → SETTLE_AMOUNT_TOO_HIGH (${r2.ok ? 'ok' : r2.code})`);
  ok(res.ok && (await undo({ settlementNumber: res.v.settlementNumber, expectedActiveLines: 1 })).ok && open(A.line) === 650, 'T6 zurückgesetzt');
}

// ── T7 Gesperrtes Guthaben wird nicht angeboten und nicht gebucht ───────────
{
  const req = auftrag('cust-1', [], { invoiceIds: [I1], sourceIds: [A.line] });
  imHaus(() => createReturnInHouse({ invoiceId: vA.inv, lines: [{ invoiceLineId: vA.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'x', refundNow: true }, 'branch-main'));
  reload();
  ok(!lese('cust-1').sources.some((x) => x.kind === 'PARTNER_ITEM'), 'T7 Nachabrechnung offen (Kundenretoure) → Partnerguthaben nicht angeboten');
  const r = await settle(req);
  ok(!r.ok && open(A.line) === 650 && offenR(I1) === 400, `T7 eine alte Ansicht bucht nichts (${r.ok ? 'ok' : r.code})`);
  await save.settleSaleOnPrimary(vA.il);
  ok(open(A.line) === 0 && !lese('cust-1').sources.some((x) => x.kind === 'PARTNER_ITEM'), `T7 nach der Nachabrechnung: kein Gewinn, Kapital gegen Kostenanteil → nichts auszahlbar (${open(A.line)})`);
}

// ── T8 Neues Guthaben (zweiter Verkauf) + PC2 mit Wiederholung ─────────────
{
  const v2 = verkauf(DB, 'pw6', lotOf(DB, A.line), 1500, 'full');
  await save.settleSaleOnPrimary(v2.il);
  ok(open(A.line) === 750, `T8 Verkauf 1500: Kapital 500 + Gewinn 250 = 750 (${open(A.line)})`);
  const req = auftrag('cust-1', [], { invoiceIds: [I1], sourceIds: [A.line] });
  const body = st.settleBalanceBody(req as never);
  const a = await fern(() => pcmd.runSettleBalance(deps() as never, identity('971', 'customers.settle_balance'), body));
  const b = await fern(() => pcmd.runSettleBalance(deps() as never, identity('971', 'customers.settle_balance'), body));
  ok(a.kind === 'ok' && b.kind === 'ok' && b.replayed === true, `T8 PC2 bucht, Wiederholung einmal (${a.kind}/${b.kind}/${String(b.replayed)})`);
  ok(offenR(I1) === 0 && open(A.line) === 350 && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE payable_id = ? AND status = 'ACTIVE'", [A.line]) === 1,
    `T8 genau EINMAL 400 verrechnet (${offenR(I1)}/${open(A.line)})`);
  ok(gap('PARTNER_ITEM_BALANCE') === 0 && ausgeglichen(), 'T8 Partnerkonto: Hauptbuch = Bestand');
}

// ── T9 Rechnungsstorno nach Verrechnung: das Partnerguthaben ist wieder offen, nie bar erstattet ──
{
  const r = await settle(auftrag('cust-1', [{ invoiceId: I2, sourceId: A.line, amount: 100 }], { invoiceIds: [I2], sourceIds: [A.line] }));
  ok(r.ok && offenR(I2) === 200 && open(A.line) === 250, `T9 I2 teilweise mit 100 verrechnet (${offenR(I2)}/${open(A.line)})`);
  const geld0 = geld();
  imHaus(() => cancelInvoiceInHouse({ invoiceId: I2, refundMethod: 'cash' }, 'branch-main'));
  reload();
  ok(String(one(DB, 'SELECT status FROM invoices WHERE id = ?', [I2])) === 'CANCELLED' && open(A.line) === 350
    && n(DB, "SELECT COUNT(*) FROM party_offsets WHERE receivable_id = ? AND status = 'ACTIVE'", [I2]) === 0,
    `T9 Storno I2: Verrechnung aufgehoben, Partner wieder 350 (${open(A.line)})`);
  ok(geld() === geld0 && ausgeglichen() && gap('PARTNER_ITEM_BALANCE') === 0, 'T9 keine Erstattung in bar, ausgeglichen, Abgleich ohne Differenz');
}

// ── T10 Code: Zahlart bekannt, nie bar, nie editierbar; Undo-Wege ─────────
{
  ok((posting.INVOICE_PAYMENT_METHODS_KNOWN as readonly string[]).includes('partner_offset'), 'T10 partner_offset ist eine bekannte Rechnungszahlart');
  ok(/NOT IN \('order_deposit', 'credit', 'debt_offset', 'purchase_offset', 'partner_offset'\)/.test(src('src/stores/bankingStore.ts')), 'T10 Banking zählt sie nie als Geld');
  ok(/m === 'partner_offset'\) continue/.test(src('src/core/reports/analytics-snapshot.ts')), 'T10 Analytics zählt sie nie als Geldeingang');
  ok(/PAYMENT_IS_PARTNER_OFFSET/.test(src('src/core/bridge/financial-commands.ts')) && /offset with a partner balance — remove the offset/.test(src('src/stores/invoiceStore.ts')),
    'T10 nie geändert, nur als Ganzes aufgehoben (PC2 und Primary)');
}

console.log(`\npartner-settle-offset: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_SETTLE_OFFSET_PROVED');

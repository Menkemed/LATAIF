// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS S5 (v0.8.101) — gebuchte Partnerforderung gegen We Borrowed und offene Einkäufe in Settle Balance
// (STL, FIFO, Teilbetrag, Rückgängig, Sperren, PC2). Harness aus partner-ownership.test.ts.
// Run: node test/partner-items/partner-receivable-offset.test.ts
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
// S5 — GEBUCHTE Partnerforderung gegen „We Borrowed" und offene Einkäufe derselben Person (Owner E3), in der STL-Engine:
// FIFO, Teilbeträge, eine STL, kein Geld, Hauptbuch = Bestand, Rückgängig je Zeile und ganze STL, Sperren, PC2.
// Nie: nur berechneter Kostenanteil, gesperrte Beträge; Store Credit nicht gegen Partnerforderungen (Owner-Entscheidung offen).
// ════════════════════════════════════════════════════════════════════════════
const st = await import('../../src/core/offsets/party-settlement.ts');
const sr = await import('../../src/core/offsets/party-settlement-reads.ts');
const po = await import('../../src/core/offsets/party-offsets.ts');
const pcmd = await import('../../src/core/bridge/party-commands.ts');
const money = await import('../../src/core/finance/money-house.ts');
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
const geld = (): number => r3(-(saldo('CASH') + saldo('BANK') + saldo('BENEFIT')));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
const gap = (account: string): number => {
  const row = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows.find((x) => x.account === account);
  return row ? r3(Number(row.ledger) - Number(row.domain)) : NaN;
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
const loanOpen = (id: string): number => r3(n(DB, 'SELECT amount FROM debts WHERE id = ?', [id]) - n(DB, 'SELECT COALESCE(SUM(amount), 0) FROM debt_payments WHERE debt_id = ?', [id]));
const purOpen = (id: string): number => r3(n(DB, 'SELECT remaining_amount FROM purchases WHERE id = ?', [id]));
const rec = (line: string): number => lese('cust-1').invoices.find((i) => i.kind === 'PARTNER_ITEM' && i.id === line)?.open ?? 0;

// ── Aufbau: B (50 %) hat nach Verkauf, Auszahlung, Kundenretoure und Lieferantenrückgabe 150 zu viel bekommen (Rückforderung) ──
DB.run("UPDATE partners SET linked_customer_id = 'cust-1' WHERE id = 'pa-b'");
DB.run("UPDATE suppliers SET linked_customer_id = 'cust-1' WHERE id = 'sup-1'");
const A = await kauf('pw6', 1000, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 1000);
await move(A.line, 'CONTRIBUTION', 500);
const vA = verkauf(DB, 'pw6', lotOf(DB, A.line), 1300, 'full');
await save.settleSaleOnPrimary(vA.il);
await move(A.line, 'PAYOUT', 650, 'pa-b', 'bank');
imHaus(() => createReturnInHouse({ invoiceId: vA.inv, lines: [{ invoiceLineId: vA.il, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'x', refundNow: true }, 'branch-main'));
reload();
await save.settleSaleOnPrimary(vA.il);
// Stand jetzt: B schuldet 650 = 500 offener Kostenanteil (nur berechnet) + 150 Rückforderung (gebucht).
ok(open(A.line) === -650, `AUFBAU B schuldet 650 (500 Kostenanteil + 150 Rückforderung) (${open(A.line)})`);
// Ein zweiter Artikel, an dem B NUR einen Kostenanteil schuldet (nie verrechenbar).
const K = await kauf('pw7', 400, [{ partnerId: 'pa-b', sharePct: 50 }], 1, 400);
// Gegenposten derselben Person: „We Borrowed" 80 und ein offener Einkauf 100 (Lieferantenrolle verknüpft).
const D = imHaus(() => money.createDebtInHouse({ direction: 'we_borrow', customerId: 'cust-1', amount: 80, source: 'cash' } as never, { branchId: 'branch-main', userId: 'user-test' })).debt.id;
const P = await kauf('pw10', 100, undefined, 1, 0);
reload();
const KONTEN = ['PARTNER_ITEM_BALANCE', 'ACCOUNTS_PAYABLE', 'LOAN_PAYABLE'];
const GAPS0 = S(KONTEN.map(gap));

// ── R1 Angebot: nur die GEBUCHTE Forderung 150, nie der Kostenanteil; Gegenposten Darlehen + Einkauf ──
{
  const r = lese('cust-1');
  const links = r.invoices.filter((i) => i.kind === 'PARTNER_ITEM');
  ok(links.length === 1 && links[0].id === A.line && links[0].open === 150 && links[0].partnerName === 'Bashir',
    `R1 links genau die gebuchte Rückforderung 150 an A (nicht 650, nicht der Kostenanteil an K) (${S(links.map((x) => [x.number, x.open]))})`);
  ok(!r.invoices.some((i) => i.id === K.line), 'R1 ein nur berechneter Kostenanteil (K) wird nie angeboten');
  ok(r.sources.some((x) => x.kind === 'LOAN_BORROWED' && x.id === D) && r.sources.some((x) => x.kind === 'PURCHASE' && x.id === P.id), 'R1 rechts We Borrowed 80 und offener Einkauf 100');
}

// ── R2 Verrechnen: FIFO Darlehen 80, dann Einkauf 70 — eine STL, kein Geld, Hauptbuch = Bestand ──
let STL = '';
{
  const g0 = geld(), pb0 = saldo('PARTNER_ITEM_BALANCE', 'pa-b'), lp0 = saldo('LOAN_PAYABLE', 'cust-1'), ap0 = saldo('ACCOUNTS_PAYABLE', 'sup-1');
  const gaps0 = ['PARTNER_ITEM_BALANCE', 'ACCOUNTS_PAYABLE', 'LOAN_PAYABLE'].map(gap);
  const res = await settle(auftrag('cust-1'));
  ok(res.ok, `R2 gebucht (${S(res).slice(0, 160)})`);
  STL = res.ok ? res.v.settlementNumber : '';
  ok(rec(A.line) === 0 && open(A.line) === -500 && loanOpen(D) === 0 && purOpen(P.id) === 30,
    `R2 Rückforderung 150 → 0 (Kostenanteil 500 bleibt), Darlehen 0, Einkauf 30 offen (${rec(A.line)}/${open(A.line)}/${loanOpen(D)}/${purOpen(P.id)})`);
  ok(geld() === g0, 'R2 keine Geldbewegung');
  ok(r3(saldo('PARTNER_ITEM_BALANCE', 'pa-b') - pb0) === 150 && r3(lp0 - saldo('LOAN_PAYABLE', 'cust-1')) === 80 && r3(ap0 - saldo('ACCOUNTS_PAYABLE', 'sup-1')) === 70,
    'R2 Soll LOAN_PAYABLE (Kunde) 80 + Soll A/P (Lieferant) 70 / Haben PARTNER_ITEM_BALANCE (Partner) 150');
  ok(S(['PARTNER_ITEM_BALANCE', 'ACCOUNTS_PAYABLE', 'LOAN_PAYABLE'].map(gap)) === S(gaps0) && ausgeglichen(), `R2 Hauptbuch = Bestand je Konto, ausgeglichen (${S(['PARTNER_ITEM_BALANCE', 'ACCOUNTS_PAYABLE', 'LOAN_PAYABLE'].map(gap))})`);
  ok(n(DB, "SELECT COUNT(*) FROM party_offsets WHERE settlement_number = ? AND receivable_type = 'PARTNER_ITEM' AND status = 'ACTIVE'", [STL]) === 2, 'R2 zwei Zuordnungen unter EINER STL');
  ok(n(DB, "SELECT COUNT(*) FROM debt_payments WHERE debt_id = ? AND source = 'offset'", [D]) === 1 && n(DB, "SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ? AND method = 'offset' AND voided_at IS NULL", [P.id]) === 1,
    'R2 am Darlehen und am Einkauf je eine Zeile „offset" ohne eigene Buchung');
  const lines = sr.settlementsOf('cust-1', 'branch-main').flatMap((x) => x.lines).filter((l) => l.receivableKind === 'PARTNER_ITEM');
  ok(lines.length === 2 && lines.every((l) => l.receivablePartnerId === 'pa-b' && l.invoiceId === A.line), 'R2 Verrechnungsliste: linke Seite Partnerforderung mit Partner');
  const mid = s(DB, "SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND kind = 'CONTRIBUTION' AND method = 'offset' LIMIT 1", [A.line]);
  ok(await code(() => save.cancelItemMovementOnPrimary(mid)) === 'PARTNER_MOVEMENT_IS_OFFSET', 'R2 die Rückzahlung per Verrechnung ist nicht einzeln am Partnerartikel stornierbar');
}

// ── R3 Eine Zuordnung zurück (Einkauf), dann die ganze STL ──────────────────
{
  const o = s(DB, "SELECT id FROM party_offsets WHERE settlement_number = ? AND payable_type = 'PURCHASE' AND status = 'ACTIVE'", [STL]);
  await po.reverseDebtOffsetOnPrimary(o, 'test');
  ok(purOpen(P.id) === 100 && rec(A.line) === 70 && String(one(DB, 'SELECT status FROM party_offsets WHERE id = ?', [o])) === 'REVERSED',
    `R3 einzeln: Einkauf wieder 100, Rückforderung wieder 70 (${purOpen(P.id)}/${rec(A.line)})`);
  const res = await undo({ settlementNumber: STL, expectedActiveLines: 1, reason: 'test' });
  ok(res.ok && loanOpen(D) === 80 && rec(A.line) === 150 && open(A.line) === -650, `R3 ganze STL: Darlehen 80, Rückforderung 150 (${S(res).slice(0, 80)})`);
  ok(S(KONTEN.map(gap)) === GAPS0 && ausgeglichen()
    && n(DB, "SELECT COUNT(*) FROM item_partner_movements WHERE purchase_line_id = ? AND method = 'offset' AND cancelled_at IS NULL", [A.line]) === 0,
    'R3 Partnerbewegungen storniert (nicht gelöscht), ausgeglichen');
}

// ── R4 Teilbetrag und Obergrenze ────────────────────────────────────────────
{
  const res = await settle(auftrag('cust-1', [{ invoiceId: A.line, sourceId: D, amount: 25.5 }], { invoiceIds: [A.line], sourceIds: [D] }));
  ok(res.ok && loanOpen(D) === 54.5 && rec(A.line) === 124.5, `R4 frei gewählt 25.500 (${loanOpen(D)}/${rec(A.line)})`);
  const zuViel = await settle(auftrag('cust-1', [{ invoiceId: A.line, sourceId: P.id, amount: 124.501 }], { invoiceIds: [A.line], sourceIds: [P.id] }));
  ok(!zuViel.ok && /SETTLE_AMOUNT_TOO_HIGH/.test(zuViel.code ?? ''), `R4 über der Obergrenze abgewiesen (${zuViel.ok ? 'ok' : zuViel.code})`);
  ok(res.ok && (await undo({ settlementNumber: res.v.settlementNumber, expectedActiveLines: 1 })).ok && rec(A.line) === 150, 'R4 zurückgesetzt');
}

// ── R5 Store Credit wird nicht gegen eine Partnerforderung gepaart; Partnerguthaben nie gegen Partnerforderung ──
{
  DB.run(`INSERT INTO customer_credits (id, branch_id, customer_id, amount, used_amount, status, source_type, source_id, created_at)
          VALUES ('cc-1', 'branch-main', 'cust-1', 40, 0, 'OPEN', 'overpayment', 'x', ?)`, [NOW]);
  const r = lese('cust-1');
  const pairs = sr.planSettlement(r.invoices, r.sources, { invoiceIds: [A.line], sourceIds: ['cc-1'] });
  ok(pairs.length === 0, 'R5 Store Credit ↔ Partnerforderung: keine Zuordnung (Verbrauch ohne Rechnung = Owner-Entscheidung)');
}

// ── R6 PC2 + Wiederholung ───────────────────────────────────────────────────
{
  const req = auftrag('cust-1', [], { invoiceIds: [A.line], sourceIds: [D] });
  const body = st.settleBalanceBody(req as never);
  const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000e5`;
  const ident = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op: 'customers.settle_balance', payloadHash: 'h' + x });
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW });
  const a = await pcmd.runSettleBalance(deps() as never, ident('1') as never, body) as { kind: string };
  const b = await pcmd.runSettleBalance(deps() as never, ident('1') as never, body) as { kind: string; replayed?: boolean };
  ok(a.kind === 'ok' && b.kind === 'ok' && b.replayed === true && loanOpen(D) === 0 && rec(A.line) === 70,
    `R6 PC2 bucht genau einmal, Wiederholung ohne Wirkung (${a.kind}/${b.kind}; ${loanOpen(D)}/${rec(A.line)})`);
  ok(S(KONTEN.map(gap)) === GAPS0 && ausgeglichen(), 'R6 Hauptbuch = Bestand je Konto, ausgeglichen');
}

// ── R7 Gesperrt: eine eigene Reparatur des Artikels ist in Arbeit → nicht angeboten, nicht buchbar ──
{
  const repairs = await import('../../src/core/repairs/repair-house.ts');
  const prc = await import('../../src/core/offsets/partner-receivable-offsets.ts');
  const rid = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: 'pw6', lotId: lotOf(DB, A.line), issueDescription: 'Service',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 10 } as never)).id;
  await repairs.updateRepairStatusOnPrimary(rid, 'in_progress' as never);
  ok(!lese('cust-1').invoices.some((i) => i.kind === 'PARTNER_ITEM' && i.id === A.line), 'R7 Reparatur in Arbeit: die Partnerforderung wird nicht angeboten (Betrag kann sich ändern)');
  const w = await code(() => Promise.resolve(imHaus(() => prc.createPartnerReceivableOffsetInHouse(
    { customerId: 'cust-1', purchaseLineId: A.line, counterKind: 'PURCHASE', counterId: P.id, amount: 10 }, { branchId: 'branch-main' }))));
  ok(w === 'OFFSET_PARTNER_NOT_RECEIVABLE', `R7 direkt gebucht: abgewiesen (${w})`);
}

console.log(`\npartner-receivable-offset: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_RECEIVABLE_OFFSET_PROVED');

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

void cmd2; void plc; void cancelPurchaseInHouse; void applyCreditToPurchaseInHouse; void shiftOwnRepairCost; void runExclusive;
void supplierPayments; void own; void change; void reconciliationSnapshotFor;

// ════════════════════════════════════════════════════════════════════════════
// PARTNER RECEIVABLES & PAYABLES — der offene Stand der Partnerlogik in Receivables und Payables.
//   Partner schuldet LATAIF → Receivable (Art „Partner"); LATAIF schuldet Partner → Payable (Art „Partner").
//   Nichts wird neu gerechnet oder gebucht: die Zeilen sind `open`/`moneyAction` der Partnerübersicht.
// Run: node test/partner-items/partner-open-balances.test.ts
// ════════════════════════════════════════════════════════════════════════════
const recv = await import('../../src/core/finance/receivables.ts');
const payS = await import('../../src/stores/payablesStore.ts');
const dr = await import('../../src/core/data/domain-reads.ts');
const pob = await import('../../src/core/partners/partner-open-balances.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');

const R = () => recv.receivablesBreakdown('branch-main');
const P = () => payS.loadPayablesFor({ branchId: 'branch-main' } as never).payables;
const rP = (line?: string) => R().filter((r) => r.source === 'PARTNER' && (!line || r.sourceId === line));
const pP = (line?: string) => P().filter((r) => r.type === 'partner' && (!line || r.sourceId === line));
const kundenR = () => S(R().filter((r) => r.source !== 'PARTNER').map((r) => [r.id, r.open]).sort());
const andereP = () => S(P().filter((r) => r.type !== 'partner').map((r) => [r.id, r.outstanding]).sort());
const letzte = (line: string, kind: string): string =>
  s(DB, 'SELECT id FROM item_partner_movements WHERE purchase_line_id = ? AND kind = ? AND cancelled_at IS NULL ORDER BY rowid DESC LIMIT 1', [line, kind]);
const ledgerZeilen = () => n(DB, 'SELECT COUNT(*) FROM ledger_entries');
const bewegungen = () => n(DB, 'SELECT COUNT(*) FROM item_partner_movements');
function retoure(inv: string, il: string, disposition: string): string {
  return String(imHaus(() => createReturnInHouse({
    invoiceId: inv, lines: [{ invoiceLineId: il, quantity: 1 }], refundMethod: 'cash', productDisposition: disposition as never,
    reason: 'Test', refundNow: true,
  }, 'branch-main')).returnId);
}

// ── 0 Ausgangslage: normale Kundenforderung und Lieferantenschuld, keine Partnerzeilen ──
const N0 = await kauf('pw30', 800, undefined, 1, 300);          // ohne Partner, Lieferant bekommt 300 von 800
const vN = verkauf(DB, 'pw30', lotOf(DB, N0.line), 900, 'part');  // Kunde zahlt die Hälfte
{
  ok(rP().length === 0 && pP().length === 0, 'AUSGANG ohne gemeinsame Artikel keine Partnerzeile in Receivables/Payables');
  const inv = R().find((r) => r.source === 'INVOICE' && r.sourceId === vN.inv);
  const sup = P().find((r) => r.type === 'supplier' && r.sourceId === N0.id);
  ok(inv?.open === 450 && sup?.outstanding === 500, `AUSGANG Kundenforderung 450 und Lieferantenschuld 500 wie bisher (${inv?.open}/${sup?.outstanding})`);
}

// ── 1 Partner schuldet seinen Kostenanteil → Receivable ─────────────────────
const A = await kauf('pw6', 1000, PB, 1, 600);
{
  const lesenVor = [ledgerZeilen(), bewegungen()];
  const z = rP(A.line);
  ok(z.length === 1 && z[0].open === 500 && pP(A.line).length === 0, `KOSTENANTEIL B schuldet 500 → eine Receivable-Zeile, keine Payable (${S(z.map((r) => r.open))})`);
  const r = z[0];
  ok(r.customerName === 'Bashir' && r.partnerId === 'pa-b' && r.customerId === '' && r.source === 'PARTNER',
    `KOSTENANTEIL Partnername, Partner-Kennung — kein Kunde (${S([r.customerName, r.partnerId, r.customerId])})`);
  ok(r.reference === s(DB, 'SELECT purchase_number FROM purchases WHERE id = ?', [A.id]) && /^Cost share · /.test(r.detailLabel) && /Sub pw6/.test(r.detailLabel),
    `KOSTENANTEIL Bezug = Einkauf, Ursprung „Cost share", Artikel (${r.reference} · ${r.detailLabel})`);
  ok(r.totalAmount === 500 && r.paidAmount === 0 && r.issuedAt === '2026-09-20' && r.dueAt === null && r.daysOverdue === 0 && recv.bucketFor(r.daysOverdue) === 'current',
    `KOSTENANTEIL Betrag 500, Datum des Einkaufs, kein Fälligkeitsdatum — nie überfällig (${S([r.totalAmount, r.paidAmount, r.issuedAt])})`);
  ok(r.navigateTo === `/partners?partner=pa-b&item=${A.line}` && r.counterpartyHref === r.navigateTo, `KOSTENANTEIL Verknüpfung zur Partner-/Artikelansicht (${r.navigateTo})`);
  ok(S([ledgerZeilen(), bewegungen()]) === S(lesenVor), 'LESEN erzeugt keine Buchung und keine Bewegung');
  const sup = P().find((x) => x.type === 'supplier' && x.sourceId === A.id);
  ok(sup?.outstanding === 400 && sup.counterpartyName === 'Lieferant', 'KOSTENANTEIL die Lieferantenschuld des Einkaufs bleibt eine normale Supplier-Payable (400)');
}

// ── 2 Pay in reduziert, OPEN = 0 verschwindet, Storno stellt wieder her ─────
{
  const vorK = kundenR(), vorP = andereP();
  await move(A.line, 'CONTRIBUTION', 400);
  const z = rP(A.line);
  ok(z.length === 1 && z[0].open === 100 && z[0].totalAmount === 500 && z[0].paidAmount === 400, `PAY IN 400 → offen 100 von 500 (${S(z.map((r) => [r.open, r.totalAmount, r.paidAmount]))})`);
  await move(A.line, 'CONTRIBUTION', 100, 'pa-b', 'cash');
  ok(rP(A.line).length === 0 && pP(A.line).length === 0, 'PAY IN Rest 100 → OPEN = 0: keine Zeile mehr, weder Receivable noch Payable');
  await save.cancelItemMovementOnPrimary(letzte(A.line, 'CONTRIBUTION'));
  ok(rP(A.line)[0]?.open === 100, `STORNO des Beitrags → die 100 stehen wieder offen (${rP(A.line)[0]?.open})`);
  await move(A.line, 'CONTRIBUTION', 100, 'pa-b', 'cash');
  ok(kundenR() === vorK && andereP() === vorP, 'TRENNUNG Partnerbewegungen ändern keine Kundenforderung und keine Lieferanten-/sonstige Payable');
}

// ── 3 Verkauf + Abrechnung → LATAIF schuldet dem Partner → Payable; Pay out, Storno ──
let VA = { inv: '', il: '' };
{
  VA = verkauf(DB, 'pw6', lotOf(DB, A.line), 1300, 'full');
  ok(rP(A.line).length === 0 && pP(A.line).length === 0, 'VERKAUF vor der Abrechnung ist nichts offen');
  await save.settleSaleOnPrimary(VA.il);
  const z = pP(A.line);
  ok(z.length === 1 && z[0].outstanding === 650 && rP(A.line).length === 0, `ABRECHNUNG LATAIF schuldet B 650 → eine Payable-Zeile, keine Receivable (${S(z.map((r) => r.outstanding))})`);
  const p = z[0];
  ok(p.type === 'partner' && p.counterpartyName === 'Bashir' && p.counterpartyId === 'pa-b' && /^Pay out · /.test(p.detailLabel) && p.sourceTable === 'item_participations',
    `PAYABLE Art „Partner", Partnername, Ursprung „Pay out" — kein Lieferant (${p.detailLabel})`);
  ok(p.daysOverdue === 0 && p.ageBucket === 'current' && !p.dueAt && p.navigateTo === `/partners?partner=pa-b&item=${A.line}` && p.counterpartyHref === p.navigateTo,
    'PAYABLE kein Fälligkeitsdatum, nie überfällig, Verknüpfung zur Partneransicht');
  await move(A.line, 'PAYOUT', 250);
  ok(pP(A.line)[0]?.outstanding === 400, `PAY OUT 250 → noch 400 offen (${pP(A.line)[0]?.outstanding})`);
  await move(A.line, 'PAYOUT', 400);
  ok(pP(A.line).length === 0 && rP(A.line).length === 0, 'PAY OUT Rest → OPEN = 0: verschwindet aus Payables');
  await save.cancelItemMovementOnPrimary(letzte(A.line, 'PAYOUT'));
  ok(pP(A.line)[0]?.outstanding === 400, `STORNO der Auszahlung → 400 stehen wieder als Payable (${pP(A.line)[0]?.outstanding})`);
  await move(A.line, 'PAYOUT', 400);
}

// ── 4 Abrechnung verrechnet eine offene Forderung mit dem Verkaufserlös ─────
{
  const b = await kauf('pw7', 1000, PB, 1, 1000);
  ok(rP(b.line)[0]?.open === 500, 'VERRECHNUNG B hat nichts eingezahlt → Receivable 500');
  const v = verkauf(DB, 'pw7', lotOf(DB, b.line), 1300, 'full');
  ok(rP(b.line)[0]?.open === 500, 'VERRECHNUNG verkauft, aber noch nicht abgerechnet → die Forderung bleibt offen');
  await save.settleSaleOnPrimary(v.il);
  ok(rP(b.line).length === 0 && pP(b.line)[0]?.outstanding === 150,
    `VERRECHNUNG Abrechnung: Kostenanteil aus dem Erlös gedeckt — Receivable weg, Payable 150 Gewinnanteil (${S([rP(b.line).length, pP(b.line)[0]?.outstanding])})`);
}

// ── 5 Nachabrechnung → Rückforderung; Rückzahlung entfernt sie ──────────────
{
  retoure(VA.inv, VA.il, 'IN_STOCK');
  reload();
  await save.settleSaleOnPrimary(VA.il);
  const z = rP(A.line);
  ok(open(A.line) === -650 && z.length === 1 && z[0].open === 650 && pP(A.line).length === 0,
    `NACHABRECHNUNG Retoure nach Auszahlung → B schuldet 650 → Receivable (${S(z.map((r) => [r.open, r.detailLabel]))})`);
  // LATAIF übernimmt das zurückgekommene Stück: die Beteiligung endet, der Kostenanteil entfällt — die
  // zu viel erhaltenen 150 bleiben als Restschuld offen und sichtbar.
  await takeOver(A.line, 1000);
  const rest = rP(A.line);
  ok(view(A.line)?.participating === false && view(A.line)?.moneyAction === 'REPAYS' && rest.length === 1 && rest[0].open === 150 && /^Repayment · /.test(rest[0].detailLabel),
    `BEENDET Beteiligung beendet, Restschuld 150 bleibt als Receivable „Repayment" sichtbar (${S(rest.map((r) => [r.open, r.detailLabel]))})`);
  await move(A.line, 'CONTRIBUTION', 150, 'pa-b', 'cash');
  ok(rP(A.line).length === 0 && pP(A.line).length === 0, 'RÜCKZAHLUNG 150 → die Rückforderung ist erledigt, nichts mehr offen');
}

// ── 6 Beendete Beteiligung mit Restschuld bleibt sichtbar („Partner repays") ──
{
  const r = await kauf('pw22', 1000, PB, 1, 1000);
  ret(r.id, r.line, 1, 800, 'bank');
  const z = rP(r.line);
  ok(view(r.line)?.moneyAction === 'REPAYS' && view(r.line)?.owedCost === 0 && z.length === 1 && z[0].open === 100 && /^Repayment · /.test(z[0].detailLabel),
    `BEENDET Lieferantenrückgabe mit Verlust: B schuldet 100 → Receivable „Repayment" obwohl das Stück nicht mehr da ist (${S(z.map((x) => [x.open, x.detailLabel]))})`);
}

// ── 7 Übernahme durch LATAIF mit Guthaben → Payable; Verrechnung zweier Artikel ──
{
  const t = await kauf('pw21', 1000, PB, 1, 1000);
  await move(t.line, 'CONTRIBUTION', 500);
  await takeOver(t.line, 1000);
  ok(pP(t.line)[0]?.outstanding === 500 && view(t.line)?.participating === false, 'ÜBERNAHME LATAIF schuldet B seinen Beitrag 500 → Payable, auch nach Ende der Beteiligung');
  const u = await kauf('pw23', 1000, PB, 1, 1000);
  ok(rP(u.line)[0]?.open === 500, 'VERRECHNUNG zweiter Artikel: B schuldet 500');
  await save.offsetItemsOnPrimary({ partnerId: 'pa-b', fromPurchaseLineId: t.line, toPurchaseLineId: u.line, amount: 300, date: '2026-09-22' });
  ok(pP(t.line)[0]?.outstanding === 200 && rP(u.line)[0]?.open === 200, `VERRECHNUNG 300 zwischen den Artikeln → Payable 200, Receivable 200 (${S([pP(t.line)[0]?.outstanding, rP(u.line)[0]?.open])})`);
}

// ── 8 Zwei Partner an einem Artikel: je eine eigene Zeile ───────────────────
{
  const m = await kauf('pw24', 1000, [{ partnerId: 'pa-b', sharePct: 30 }, { partnerId: 'pa-c', sharePct: 20 }], 1, 1000);
  const z = rP(m.line);
  ok(z.length === 2 && new Set(z.map((r) => r.id)).size === 2 && S(z.map((r) => [r.customerName, r.open]).sort()) === S([['Bashir', 300], ['Chalid', 200]]),
    `MEHRERE Partner: je Partner eine Zeile mit eigener Kennung (${S(z.map((r) => [r.customerName, r.open]))})`);
}

// ── 9 Summen: jede Zeile genau einmal, gleich dem Partner-Modul ─────────────
{
  const alle = R();
  const split = recv.receivablesSplit(alle);
  const ov = house.partnerItemsOverview('branch-main');
  const owedBy = ov.reduce((t, p) => t + p.owedByPartner, 0);
  const owedTo = ov.reduce((t, p) => t + p.owedToPartner, 0);
  const pPartner = payS.payablesTotal(pP());
  ok(split.partners > 0 && pPartner > 0 && Math.abs(split.partners - owedBy) < 0.0005 && Math.abs(pPartner - owedTo) < 0.0005,
    `SUMMEN Partner-Receivables ${split.partners} = „owed by partner" ${owedBy}; Partner-Payables ${pPartner} = „owed to partner" ${owedTo}`);
  ok(Math.abs(split.total - recv.receivablesTotal(alle)) < 0.0005 && Math.abs(split.customers + split.partners - split.total) < 0.0005 && split.customers === 450,
    `SUMMEN Gesamt = Kunden (450, unverändert) + Partner, jede Zeile einmal (${S(split)})`);
  ok(new Set(alle.map((r) => r.id)).size === alle.length && new Set(P().map((r) => r.id)).size === P().length, 'SUMMEN keine doppelte Zeilenkennung in beiden Listen');
  const zeilen = pob.partnerOpenRows(ov);
  ok(zeilen.every((z) => z.open > 0) && zeilen.filter((z) => z.side === 'RECEIVABLE').length === rP().length && zeilen.filter((z) => z.side === 'PAYABLE').length === pP().length,
    'ABLEITUNG dieselbe eine Ableitung speist beide Listen');
  ok(pob.partnerOpenRows([{ partnerId: 'x', name: 'X', active: true, items: [
    { purchaseLineId: 'l1', purchaseId: 'p', purchaseNumber: 'PUR-1', purchaseDate: '2026-01-01', productLabel: 'Item', open: 0, moneyAction: 'NONE', owedCost: 0, movements: [], correctionPending: false, refundPending: false, participating: true },
    { purchaseLineId: 'l2', purchaseId: 'p', purchaseNumber: 'PUR-1', purchaseDate: '2026-01-01', productLabel: 'Item', open: 10, moneyAction: 'PAY_OUT', owedCost: 0, movements: [], correctionPending: true, refundPending: false, participating: true },
  ] } as never]).map((z) => [z.purchaseLineId, z.side, z.onHold]).join() === 'l2,PAYABLE,true', 'ABLEITUNG nichts offen → keine Zeile; wartende Auszahlung als „on hold"');
  // Eine unbezahlte Rechnung über ein gemeinsames Stück bleibt eine KUNDEN-Forderung — nicht zusätzlich Partner.
  const w = await kauf('pw25', 1000, PB, 1, 1000);
  await move(w.line, 'CONTRIBUTION', 500);
  const vw = verkauf(DB, 'pw25', lotOf(DB, w.line), 1300, 'none');
  const inv = R().filter((r) => r.sourceId === vw.inv || r.sourceId === w.line);
  ok(inv.length === 1 && inv[0].source === 'INVOICE' && inv[0].open === 1300, `TRENNUNG offene Kundenrechnung eines gemeinsamen Stücks: nur die Rechnung, kein Partnerbetrag (${S(inv.map((r) => [r.source, r.open]))})`);
}

// ── 10 PC2 liest denselben Stand über die bestehenden Lesewege ──────────────
{
  const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
  const fern = await executeCommand('finance.receivables.get', { actor: ACTOR, input: {} }, ACTOR as never);
  const lokal = dr.receivableRowsFor({ branchId: 'branch-main' } as never);
  const fernRows = fern.kind === 'ok' ? (JSON.parse(JSON.stringify(fern.value)) as { data: { rows: Array<{ source: string }> } }).data.rows : [];
  ok(fern.kind === 'ok' && S(fernRows) === S(JSON.parse(JSON.stringify(lokal.rows))) && fernRows.filter((r) => r.source === 'PARTNER').length === rP().length && rP().length > 0,
    `PC2 finance.receivables.get liefert dieselben Zeilen wie der Primary, inkl. ${rP().length} Partnerzeilen (${fern.kind})`);
  const fernP = await executeCommand('store.payables.get', { actor: ACTOR, input: {} }, ACTOR as never);
  const lokalP = payS.loadPayablesFor({ branchId: 'branch-main' } as never);
  const fernPay = fernP.kind === 'ok' ? (JSON.parse(JSON.stringify(fernP.value)) as { data: { payables: Array<{ type: string }> } }).data.payables : [];
  ok(fernP.kind === 'ok' && S(fernPay) === S(JSON.parse(JSON.stringify(lokalP.payables))) && fernPay.filter((r) => r.type === 'partner').length === pP().length && pP().length > 0,
    `PC2 store.payables.get liefert dieselben Zeilen wie der Primary, inkl. ${pP().length} Partnerzeilen (${fernP.kind})`);
  const fremd = await executeCommand('finance.receivables.get', { actor: { ...ACTOR, branchId: 'branch-other' }, input: {} }, { ...ACTOR, branchId: 'branch-other' } as never);
  ok(fremd.kind === 'ok' && (fremd.value as { data: { rows: unknown[] } }).data.rows.length === 0, 'PC2 eine andere Filiale sieht keine dieser Zeilen');
  const seiten = src('src/pages/receivables/ReceivablesPage.tsx') + src('src/pages/payables/PayablesPage.tsx');
  ok(/useSharedRead\('finance\.receivables\.get'/.test(seiten) && /hydrateFromPrimary\('store\.payables\.get'/.test(src('src/stores/payablesStore.ts')) && !/partnerOpenRows|partnerItemsOverview/.test(seiten),
    'PC2 die Seiten rechnen nichts selbst — sie lesen die fertigen Zeilen des Primary');
}

// ── 11 Bericht, Übersicht, Seiten: keine Doppelzählung ──────────────────────
{
  const bericht = src('src/pages/reports/BusinessReportsPage.tsx');
  ok(/const rows = forderungen\.rows\.filter\(\(r\) => r\.source !== 'PARTNER'\);/.test(bericht) && /if \(r\.source !== 'PARTNER'\) continue;/.test(bericht)
    && /OWED BY PARTNERS/.test(bericht) && /OWED TO PARTNERS/.test(bericht) && /if \(r\.side !== 'PAYABLE'\) continue;/.test(bericht),
    'BERICHT Kunden- und Lieferantensumme unverändert; Partner getrennt, jede Zeile in genau einer Summe');
  const dash = src('src/pages/dashboard/Dashboard.tsx');
  ok(/const customerReceivables = salden\.receivables;/.test(dash) && /partnersOwe > 0 \? ` · \+\$\{fmt\(partnersOwe\)\} partners` : ''/.test(dash)
    && !/customerReceivables \+ partnersOwe|partnersOwe \+ customerReceivables/.test(dash),
    'ÜBERSICHT Receivables-Karte bleibt die Kundenzahl; Partner nur als getrennte Info, nie addiert');
  ok(/payablesTotal\(payables\)/.test(dash), 'ÜBERSICHT „Total Payables" kommt aus der Liste — Partner dort genau einmal');
  const rSeite = src('src/pages/receivables/ReceivablesPage.tsx'), pSeite = src('src/pages/payables/PayablesPage.tsx');
  ok(/'REPAIR', 'PARTNER'\]/.test(rSeite) && /'loan', 'partner'\]/.test(pSeite) && recv.RECEIVABLE_SOURCE_LABELS.PARTNER === 'Partner' && payS.PAYABLE_TYPE_LABELS.partner === 'Partner',
    'SEITEN eigene Art „Partner" in beiden Filtern');
  ok(/searchParams\.get\('partner'\)/.test(src('src/pages/partners/PartnersPage.tsx')) && /data-partner-item-key=\{key\}/.test(src('src/components/partners/PartnerItemsPanel.tsx')),
    'SEITEN die Verknüpfung öffnet die Artikelzeile im Partner-Modul');
}

console.log(`\npartner-open-balances: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('PARTNER_OPEN_BALANCES_PROVED');

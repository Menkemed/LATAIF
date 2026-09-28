// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — gemeinsamer Einkauf mit Partnern: Anteile, Beiträge, Ausgleich, Verkauf, Gewinnanteil.
// Run: node --experimental-strip-types test/partner-items/partner-purchase.test.ts
//
// An einer echten sql.js-Datenbank mit den echten Migrationen:
//   §1 Einkauf OHNE Partner: keine Beteiligung, dieselben Buchungen wie bisher.
//   §2 Anteile: 50/50-Vorschlag, >100 %, doppelt, inaktiv, zwei Nachkommastellen, drei Beteiligte.
//   §3 Beitrag/Ausgleich: 1000 → B zahlt 0 (schuldet 500), 400 (schuldet 100), 600 (LATAIF schuldet 100);
//      Lieferantenschuld und Lieferantenzahlungen bleiben unberührt; Überfinanzierung; Auszahlung ≤ offen.
//   §4 Verkauf 1300: erst voll bezahlt, dann Gewinn 300 → 150 je Seite, 550 an B, 750 bleiben; einmal.
//   §5 Retoure sperrt, Verlust, Storno-Reihenfolge, Abgleich Hauptbuch = Domäne, Bank-Liste.
//   §6 PC2-Rumpf trägt die Anteile, Lesewege (Einkauf, Partner inkl. inaktiv), Partner nicht löschbar.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/plugin-dialog') {
      return { url: 'data:text/javascript,export const confirm = (...a) => globalThis.__dialogConfirm(...a);', shortCircuit: true };
    }
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

// ── §2 die reinen Regeln ────────────────────────────────────────────────────
{
  const p = rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 50 }], 1_000_000);
  ok(S(p.map((x) => [x.party, x.partnerId, x.shareBp, x.costShareF])) === S([['HOUSE', null, 5000, 500000], ['PARTNER', 'pa-b', 5000, 500000]]),
    `RULE 50/50: LATAIF 50 % / 500, Partner 50 % / 500 (${S(p)})`);
  ok(S(rules.suggestedPartnerPcts(1)) === S([50]) && S(rules.suggestedPartnerPcts(2)) === S([33.33, 33.33]), 'RULE Vorschlag: 50/50, bei zwei Partnern je 33,33 (LATAIF 33,34)');
  const drei = rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 33.33 }, { partnerId: 'pa-c', sharePct: 33.33 }], 1_000_000);
  ok(drei.reduce((a, x) => a + x.shareBp, 0) === 10000 && drei.reduce((a, x) => a + x.costShareF, 0) === 1_000_000 && drei[0].shareBp === 3334,
    `RULE drei Beteiligte: genau 100 % und genau der Zeilenbetrag (${S(drei.map((x) => [x.shareBp, x.costShareF]))})`);
  const nein = (f: () => unknown): string => { try { f(); return ''; } catch (e) { return String((e as { code?: string }).code); } };
  ok(nein(() => rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 60 }, { partnerId: 'pa-c', sharePct: 50 }], 1000)) === rules.PARTNER_SHARES_INVALID, 'RULE über 100 % → Nein');
  ok(nein(() => rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 20 }, { partnerId: 'pa-b', sharePct: 20 }], 1000)) === rules.PARTNER_DUPLICATE, 'RULE derselbe Partner zweimal → Nein');
  ok(nein(() => rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 0 }], 1000)) === rules.PARTNER_SHARES_INVALID, 'RULE 0 % → Nein');
  ok(nein(() => rules.planLineParticipation([{ partnerId: 'pa-b', sharePct: 33.333 }], 1000)) === rules.PARTNER_SHARES_INVALID, 'RULE drei Nachkommastellen → Nein');
  ok(nein(() => rules.planLineParticipation([], 1000)) === rules.PARTNER_SHARES_INVALID, 'RULE ohne Partner ist keine gemeinsame Zeile');
  const g = rules.saleLineProfitF({ lineTotal: 1300, vatAmount: 0, costSnapshot: 1000, quantity: 1 });
  ok(g.profitF === 300_000 && rules.profitShareF(g.profitF, 5000) === 150_000, 'RULE Gewinn = Netto − Einstand (1300 − 1000 = 300; 50 % = 150)');
  const m = rules.saleLineProfitF({ lineTotal: 1300, vatAmount: 27.273, costSnapshot: 1000, quantity: 1 });
  ok(m.netF === 1_272_727 && m.profitF === 272_727, 'RULE bei Margen-VAT zählt der Nettoerlös wie im Hauptbuch (REVENUE)');
}

const DB = freshDb();

// ── §1 Einkauf ohne Partner — unverändert ───────────────────────────────────
let P0 = '';
{
  const leDavor = n(DB, 'SELECT COUNT(*) FROM ledger_entries');
  P0 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw1', 1000)], 400))).id;
  ok(n(DB, 'SELECT COUNT(*) FROM item_participations') === 0, 'OHNE Partner entsteht keine Beteiligung');
  const mods = s(DB, `SELECT GROUP_CONCAT(DISTINCT source_module) FROM (SELECT source_module FROM ledger_entries ORDER BY source_module)`);
  ok(mods === 'PURCHASE,PURCHASE_PAYMENT', `OHNE Partner: nur Einkauf + Lieferantenzahlung gebucht (${mods})`);
  ok(n(DB, 'SELECT COUNT(*) FROM ledger_entries') - leDavor > 0 && bal('PARTNER_ITEM_BALANCE') === 0, 'OHNE Partner: kein Partner-Ausgleich');
  const kopf = DB.exec('SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [P0])[0].values[0];
  ok(S(kopf) === S([1000, 400, 600, 'PARTIALLY_PAID']), `OHNE Partner: Beleg wie bisher (${S(kopf)})`);
  const lp = loadPurchasesFor({ branchId: 'branch-main' } as never).purchases.find((p) => p.id === P0);
  ok(lp && lp.participations === undefined, 'OHNE Partner: der Einkauf trägt keine Beteiligungsangabe');
}

// ── §3 gemeinsamer Einkauf, Beiträge, Ausgleich ─────────────────────────────
// Einkauf 1: pw2 für 1000, 50/50 mit Bashir; LATAIF zahlt dem Lieferanten 600 (bank).
const P1 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw2', 1000, [{ partnerId: 'pa-b', sharePct: 50 }])], 600))).id;
const L1 = lineOf(DB, P1, 'pw2');
{
  const rowsP = DB.exec('SELECT party, partner_id, share_bp, cost_share, line_total FROM item_participations WHERE purchase_line_id = ? ORDER BY party', [L1])[0]?.values;
  ok(S(rowsP) === S([['HOUSE', null, 5000, 500, 1000], ['PARTNER', 'pa-b', 5000, 500, 1000]]), `SHARE Beteiligung gespeichert: Anteil und Kostenanteil getrennt (${S(rowsP)})`);
  ok(open(L1) === -500, `AUSGLEICH B hat nichts gezahlt → schuldet LATAIF 500 (${open(L1)})`);
  const apVor = S(DB.exec('SELECT paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [P1])[0].values[0]);
  const zahlVor = n(DB, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [P1]);
  const apLedgerVor = n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='ACCOUNTS_PAYABLE'");
  const bankVor = n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='BANK'");
  await move(L1, 'CONTRIBUTION', 400);
  ok(open(L1) === -100, `AUSGLEICH B zahlt 400 → schuldet noch 100 (${open(L1)})`);
  ok(S(DB.exec('SELECT paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [P1])[0].values[0]) === apVor
    && n(DB, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [P1]) === zahlVor,
    'TRENNUNG der Partnerbeitrag ist KEINE Lieferantenzahlung: Einkauf und Zahlungen unverändert');
  ok(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='ACCOUNTS_PAYABLE'") === apLedgerVor,
    'TRENNUNG Lieferantenschuld im Hauptbuch unverändert');
  ok(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account='BANK'") - bankVor === 400
    && bal('PARTNER_ITEM_BALANCE') === 400, 'BUCHUNG Bank +400 / Partner-Ausgleichskonto 400 (Firma schuldet B den Beitrag)');
  ok(bal('PARTNER_EQUITY') === 0, 'TRENNUNG das Gesellschafterkapital bleibt unberührt');
  ok(await code(() => move(L1, 'PAYOUT', 1)) === rules.PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, 'AUSZAHLUNG solange B schuldet, wird nichts ausgezahlt');
  ok(await code(() => move(L1, 'CONTRIBUTION', 600.001)) === rules.PARTNER_ITEM_OVERFUNDED, 'BEITRAG über den offenen Kostenanteil (100) hinaus → Nein');
  const bank = bankTransactionsFor({ branchId: 'branch-main' } as never, []).filter((t) => t.id.startsWith('ipm-'));
  ok(bank.length === 1 && bank[0].flow === 'in' && bank[0].amount === 400 && bank[0].account === 'bank', `BANK der Beitrag erscheint als Geldeingang (${S(bank)})`);
}
// Einkauf 2: pw3 für 1000, 50/50; B kann nur seinen Kostenanteil 500 einzahlen, nicht mehr.
const P2 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw3', 1000, [{ partnerId: 'pa-b', sharePct: 50 }])]))).id;
const L2 = lineOf(DB, P2, 'pw3');
{
  ok(await code(() => move(L2, 'CONTRIBUTION', 600, 'pa-b', 'cash')) === rules.PARTNER_ITEM_OVERFUNDED && open(L2) === -500,
    'BEITRAG höchstens der offene Kostenanteil: 600 statt 500 → Nein, nichts gebucht');
  await move(L2, 'CONTRIBUTION', 500, 'pa-b', 'cash');
  ok(open(L2) === 0, `AUSGLEICH B zahlt seinen Kostenanteil 500 → nichts offen (${open(L2)})`);
  ok(await code(() => move(L2, 'CONTRIBUTION', 0.001, 'pa-b', 'cash')) === rules.PARTNER_ITEM_NOTHING_OWED, 'BEITRAG nichts mehr offen → Nein');
  ok(await code(() => move(L2, 'PAYOUT', 0.001)) === rules.PARTNER_ITEM_PAYOUT_EXCEEDS_OPEN, 'AUSZAHLUNG nichts offen → Nein');
}

// ── §4 Verkauf und Gewinnverteilung ─────────────────────────────────────────
{
  // pw2 (Einkauf 1, B hat 400 gezahlt) wird für 1300 verkauft — erst halb, dann voll bezahlt.
  const v = verkauf(DB, 'pw2', lotOf(DB, L1), 1300, 'part');
  ok(n(DB, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE id = ?', [v.il]) === 1000, 'VERKAUF der Einstand kommt aus dem Los des gemeinsamen Einkaufs');
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_NOT_PAID, 'ABRECHNUNG vor voller Zahlung → Nein (kein vorzeitiger Gewinn)');
  const offen = n(DB, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [v.inv]);
  imHaus(() => useInvoiceStore.getState().recordPayment(v.inv, offen, 'cash'));
  reload();
  ok(s(DB, 'SELECT status FROM invoices WHERE id = ?', [v.inv]) === 'FINAL', 'VERKAUF jetzt voll bezahlt');
  const ov = house.partnerItemsOverview('branch-main', 'pa-b')[0].items.find((i) => i.purchaseLineId === L1)!;
  ok(ov.sales.length === 1 && ov.sales[0].settleable && ov.sales[0].profit === 300 && ov.sales[0].partnerShare === 150,
    `ÜBERSICHT Vorschlag: Gewinn 300, Anteil B 150 (${S(ov.sales)})`);
  const r = await save.settleSaleOnPrimary(v.il);
  ok(r.profit === 300 && r.shares.length === 1 && r.shares[0].amount === 150, `ABRECHNUNG Gewinn 300 → B 150 (${S(r)})`);
  ok(open(L1) === 550, `ABRECHNUNG B bekommt 400 + 150 = 550 (${open(L1)})`);
  ok(1300 - open(L1) === 750, 'ABRECHNUNG LATAIF behält 750 (600 vorgestreckt + 150 Gewinn)');
  // Das Ausgleichskonto trägt zusätzlich die 500 aus Einkauf 2 (600 Beitrag − 100 Auszahlung).
  ok(bal('PARTNER_ITEM_PROFIT_SHARE') === -150 && bal('PARTNER_ITEM_BALANCE') === 550 + 500,
    `BUCHUNG Gewinnanteil 150 als Aufwand, Partner-Ausgleichskonto 550 (+500 Einkauf 2) (${bal('PARTNER_ITEM_BALANCE')})`);
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_ALREADY_SETTLED, 'ABRECHNUNG kein zweites Mal');
  let doppelt = '';
  try { imHaus(() => DB.run(`INSERT INTO item_partner_movements (id, branch_id, purchase_id, purchase_line_id, partner_id, kind, amount, occurred_at, invoice_line_id, created_at)
    VALUES ('x', 'branch-main', ?, ?, 'pa-b', 'PROFIT_SHARE', 150, '2026-09-26', ?, ?)`, [P1, L1, v.il, NOW])); } catch (e) { doppelt = String(e); }
  ok(/UNIQUE/i.test(doppelt), 'ABRECHNUNG auch die Datenbank lässt keine zweite zu');
  const rev = n(DB, "SELECT COUNT(*) FROM ledger_entries WHERE source_module IN ('INVOICE','PAYMENT') AND source_id IN (?, (SELECT id FROM payments WHERE invoice_id = ? LIMIT 1))", [v.inv, v.inv]);
  ok(rev > 0 && bal('REVENUE') === 1300 && bal('COGS') === -1000, `ERP Umsatz 1300 und Wareneinsatz 1000 bleiben nach den Regeln des ERP gebucht (${bal('REVENUE')}/${bal('COGS')})`);
  // Storno-Reihenfolge: nach einer Auszahlung zuerst die Auszahlung.
  await move(L1, 'PAYOUT', 550, 'pa-b', 'bank');
  ok(open(L1) === 0 && bal('PARTNER_ITEM_BALANCE') === 500, 'AUSZAHLUNG 550 → B ist an diesem Artikel abgerechnet (Konto: nur noch Einkauf 2)');
  const settleId = s(DB, "SELECT id FROM item_partner_movements WHERE kind = 'PROFIT_SHARE' AND invoice_line_id = ?", [v.il]);
  const payoutId = s(DB, "SELECT id FROM item_partner_movements WHERE kind = 'PAYOUT' AND purchase_line_id = ?", [L1]);
  ok(await code(() => save.cancelItemMovementOnPrimary(settleId)) === rules.PARTNER_MOVEMENT_CANCELLED, 'STORNO Abrechnung erst nach Storno der späteren Auszahlung');
  await save.cancelItemMovementOnPrimary(payoutId);
  await save.cancelItemMovementOnPrimary(settleId);
  ok(open(L1) === -100 && bal('PARTNER_ITEM_BALANCE') === 400 + 500 && bal('PARTNER_ITEM_PROFIT_SHARE') === 0,
    `STORNO zurück auf den Stand vor dem Verkauf (offen ${open(L1)})`);
  ok(n(DB, 'SELECT COUNT(*) FROM item_partner_movements WHERE cancelled_at IS NOT NULL') === 2, 'STORNO die Zeilen bleiben als Verlauf');
  const again = await save.settleSaleOnPrimary(v.il);
  ok(again.shares[0].amount === 150 && open(L1) === 550, 'ABRECHNUNG nach Storno wieder möglich — genau einmal aktiv');
}

// ── §5 Retoure, Verlust, drei Beteiligte, Abgleich ──────────────────────────
{
  // Retoure sperrt: pw3 (Einkauf 2) verkauft und voll bezahlt, Retoure angelegt.
  const v = verkauf(DB, 'pw3', lotOf(DB, L2), 1200, 'full');
  DB.run(`INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount, return_date, created_at)
    VALUES ('ret-1','branch-main','RET-1',?,'cust-1','REQUESTED',1200,'2026-09-26',?)`, [v.inv, NOW]);
  DB.run("INSERT INTO sales_return_lines (id, return_id, invoice_line_id, product_id, quantity, unit_price, line_total) VALUES ('rl-1','ret-1',?,'pw3',1,1200,1200)", [v.il]);
  ok(await code(() => save.settleSaleOnPrimary(v.il)) === rules.PARTNER_SALE_PENDING, "RETOURE (noch nicht entschieden) auf der Zeile → keine Abrechnung");
  DB.run("UPDATE sales_returns SET status = 'REJECTED' WHERE id = 'ret-1'");
  const r = await save.settleSaleOnPrimary(v.il);
  // B hat 600 gezahlt und 100 zurückbekommen; mit dem Verkauf gehört B sein Kapital (500) + Gewinn 100.
  ok(r.shares[0].amount === 100 && open(L2) === 600, `RETOURE abgelehnt → Abrechnung (Gewinn 200, B 100; LATAIF schuldet B 600) (${open(L2)})`);

  // Verlust: pw4 für 1000, 50/50, B zahlt 500; Verkauf 800 → Verlust 200, B −100 → LATAIF schuldet B 400.
  const P3 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw4', 1000, [{ partnerId: 'pa-b', sharePct: 50 }])], 1000))).id;
  const L3 = lineOf(DB, P3, 'pw4');
  await move(L3, 'CONTRIBUTION', 500);
  const vv = verkauf(DB, 'pw4', lotOf(DB, L3), 800, 'full');
  const rv = await save.settleSaleOnPrimary(vv.il);
  ok(rv.profit === -200 && rv.shares[0].amount === -100 && open(L3) === 400, `VERLUST 200 → B trägt 100, bekommt 400 zurück (${open(L3)})`);

  // Drei Beteiligte, zwei Stück, Teilverkauf: pw5 2 × 900, Bashir 33,33 %, Chalid 33,33 %.
  const P4 = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw5', 900, [
    { partnerId: 'pa-b', sharePct: 33.33 }, { partnerId: 'pa-c', sharePct: 33.33 }], 2)], 1800))).id;
  const L4 = lineOf(DB, P4, 'pw5');
  const kosten = DB.exec('SELECT party, partner_id, share_bp, cost_share FROM item_participations WHERE purchase_line_id = ? ORDER BY party, partner_id', [L4])[0].values;
  ok(S(kosten) === S([['HOUSE', null, 3334, 600.12], ['PARTNER', 'pa-b', 3333, 599.94], ['PARTNER', 'pa-c', 3333, 599.94]]),
    `DREI Kostenanteile ergeben genau 1800 (${S(kosten)})`);
  const v1 = verkauf(DB, 'pw5', lotOf(DB, L4), 1200, 'full');
  const r1 = await save.settleSaleOnPrimary(v1.il);
  ok(r1.shares.length === 2 && r1.shares.every((x) => x.amount === 99.99), `TEILVERKAUF 1 von 2: Gewinn 300 → je 99,99 (${S(r1.shares)})`);
  ok(open(L4, 'pa-b') === Math.round((99.99 - 599.94 / 2) * 1000) / 1000, `TEILVERKAUF der Kostenanteil des unverkauften Stücks bleibt offen (${open(L4, 'pa-b')})`);

  // Abgleich Hauptbuch = Domäne, Hauptbuch ausgeglichen.
  const rec = reconciliationSnapshotFor({ branchId: 'branch-main' } as never);
  const row = rec.rows.find((x) => x.account === 'PARTNER_ITEM_BALANCE')!;
  ok(row && Math.abs(row.ledger - row.domain) < 0.0005, `ABGLEICH Partner-Ausgleichskonto: Hauptbuch ${row?.ledger} = Domäne ${row?.domain}`);
  ok(n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0, 'ABGLEICH Hauptbuch insgesamt ausgeglichen');
  ok(!rec.orphans.some((o) => o.sourceModule === 'PARTNER_ITEM'), 'ABGLEICH keine verwaisten Partnerbuchungen');
}

// ── §6 PC2-Rumpf, Lesewege, Partner löschen ─────────────────────────────────
{
  const input = EINKAUF([ZEILE('pw1', 500, [{ partnerId: 'pa-b', sharePct: 40 }])]);
  const body = await purchaseRules.purchaseCreateBody(input, async () => []);
  ok(S((body.lines as Array<Record<string, unknown>>)[0].partnerShares) === S([{ partnerId: 'pa-b', sharePct: 40 }]), 'PC2 der Rumpf trägt die Anteile je Zeile');
  const parsed = cmd.parsePurchaseCreate(body);
  ok(S(parsed.lines[0].partnerShares) === S([{ partnerId: 'pa-b', sharePct: 40 }]), 'PC2 der Primary liest die Anteile');
  let fremd = '';
  try { cmd.parsePurchaseCreate({ ...body, lines: [{ ...(body.lines as unknown[])[0] as object, partnerShares: [{ partnerId: 'pa-b', sharePct: 40, costShare: 1 }] }] }); } catch (e) { fremd = String(e); }
  ok(/costShare/.test(fremd), 'PC2 ein Kostenanteil vom Client wird abgewiesen (das Haus rechnet)');
  const plainBody = await purchaseRules.purchaseCreateBody(EINKAUF([ZEILE('pw1', 500)]), async () => []);
  ok(!('partnerShares' in (plainBody.lines as Array<Record<string, unknown>>)[0]), 'PC2 ohne Partner: der Rumpf ist unverändert');
  ok(purchaseRules.purchaseCreateIssue(EINKAUF([ZEILE('pw1', 500, [{ partnerId: 'pa-b', sharePct: 120 }])]))?.code === rules.PARTNER_SHARES_INVALID,
    'MASKE die Anteilsregel prüft schon vor dem Schicken');
  const vorher = S([n(DB, 'SELECT COUNT(*) FROM purchases'), n(DB, 'SELECT COUNT(*) FROM stock_lots'), n(DB, 'SELECT COUNT(*) FROM ledger_entries')]);
  const inaktiv = await code(() => purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE('pw1', 500, [{ partnerId: 'pa-off', sharePct: 50 }])])));
  ok(inaktiv === 'PARTNER_NOT_ACTIVE', `INAKTIV ein deaktivierter Partner bekommt keine neue Beteiligung (${inaktiv})`);
  ok(S([n(DB, 'SELECT COUNT(*) FROM purchases'), n(DB, 'SELECT COUNT(*) FROM stock_lots'), n(DB, 'SELECT COUNT(*) FROM ledger_entries')]) === vorher,
    'INAKTIV …und es entsteht kein halber Einkauf (kein Beleg, kein Los, keine Buchung)');
  // Atomar auch hinter der Vorprüfung: scheitert die Beteiligung beim Anlegen, gibt es den Einkauf nicht.
  const port = purchaseHouse.housePurchasePort('branch-main');
  const ohnePruefung = { ...port, partnerActive: () => true };
  const plan = purchaseRules.planPurchaseCreate(EINKAUF([ZEILE('pw1', 500, [{ partnerId: 'pa-off', sharePct: 50 }])]), ohnePruefung);
  const tief = await code(() => imHaus(() => usePurchaseStore.getState().createPurchase(plan as never)));
  ok(tief === 'PARTNER_NOT_ACTIVE' && S([n(DB, 'SELECT COUNT(*) FROM purchases'), n(DB, 'SELECT COUNT(*) FROM stock_lots'), n(DB, 'SELECT COUNT(*) FROM ledger_entries')]) === vorher,
    `ATOMAR die Hausfolge selbst weist ab und rollt Beleg und Zeilen zurück (${tief})`);

  // Deaktivierter Partner bleibt in historischen Beteiligungen sichtbar.
  DB.run("UPDATE partners SET active = 0 WHERE id = 'pa-c'");
  const lp = loadPartnersFor({ branchId: 'branch-main' } as never);
  const chalid = lp.itemOverview.find((p) => p.partnerId === 'pa-c');
  ok(chalid && !chalid.active && chalid.items.length === 1, 'HISTORIE deaktivierter Partner erscheint weiter in der Übersicht');
  const bashir = lp.itemOverview.find((p) => p.partnerId === 'pa-b')!;
  const summe = Math.round(bashir.items.reduce((a, i) => a + i.open, 0) * 1000) / 1000;
  ok(bashir.items.length === 4 && Math.abs(bashir.openTotal - summe) < 0.0005, `GESAMTSALDO je Partner = Summe der Artikel (${bashir.openTotal} / ${summe})`);
  const pur = loadPurchasesFor({ branchId: 'branch-main' } as never).purchases.find((p) => p.lines.some((l) => l.id === L1))!;
  ok(pur.participations?.[0]?.parties.map((x) => `${x.name}:${x.sharePct}`).join(',') === 'LATAIF:50,Bashir:50', `EINKAUF zeigt die Beteiligten (${S(pur.participations)})`);
  let loeschen = '';
  try { usePartnerStore.getState().deletePartner('pa-c'); } catch (e) { loeschen = String(e); }
  ok(/jointly bought/.test(loeschen) && n(DB, "SELECT COUNT(*) FROM partners WHERE id = 'pa-c'") === 1, 'LÖSCHEN ein Partner mit Beteiligung wird nicht gelöscht');
}

// ── Kartengebühr: anteilig vom Gewinn, bevor geteilt wird ───────────────────
{
  for (const pid of ['pf1', 'pf2']) {
    DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,0,'Pre-Owned','[]',0,'BHD',1300,'sold','ZERO',0,'[]','{}','OWN',?,?)`,
    [pid, 'Sub ' + pid, 'SKU-' + pid, NOW, NOW]);
  }
  const PF = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([
    ZEILE('pf1', 1000, [{ partnerId: 'pa-b', sharePct: 40 }]), ZEILE('pf2', 500, [{ partnerId: 'pa-b', sharePct: 40 }]),
  ]))).id;
  const LF1 = lineOf(DB, PF, 'pf1'), LF2 = lineOf(DB, PF, 'pf2');
  // EINE Rechnung über beide Stücke (1500 + 1000), voll per Karte bezahlt: Gebühr 2,2 % = 55.
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [
    { productId: 'pf1', quantity: 1, unitPrice: 1500, purchasePrice: 1000, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1500, lotId: lotOf(DB, LF1) },
    { productId: 'pf2', quantity: 1, unitPrice: 1000, purchasePrice: 500, taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: 1000, lotId: lotOf(DB, LF2) },
  ] as never, 'P').id);
  reload();
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 2500, 'card', undefined, undefined, 'normal'));
  reload();
  const fee = n(DB, "SELECT COALESCE(SUM(amount),0) FROM expenses WHERE category = 'CardFees' AND related_entity_id = ? AND status != 'CANCELLED'", [inv]);
  const il1 = s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, 'pf1']);
  const il2 = s(DB, 'SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = ?', [inv, 'pf2']);
  const b1 = house.saleBasisOf(il1, 'branch-main'), b2 = house.saleBasisOf(il2, 'branch-main');
  ok(fee === 55 && b1.feeF === 33000 && b2.feeF === 22000 && b1.feeF + b2.feeF === 55000, `GEBÜHR nach Zeilenwert verteilt, Summe = Gebühr (${fee}: ${b1.feeF}/${b2.feeF})`);
  ok(b1.profitF === 1500000 - 1000000 - 33000, `GEWINN = netto − Einstand − Gebühr (${b1.profitF})`);
  const sale = () => loadPartnersFor({ branchId: 'branch-main' } as never).itemOverview.find((p) => p.partnerId === 'pa-b')!
    .items.find((i) => i.purchaseLineId === LF1)!.sales[0];
  const v = sale();
  ok(v.net === 1500 && v.cost === 1000 && v.cardFee === 33 && v.profit === 467 && v.partnerShare === 186.8 && v.lataifShare === 280.2,
    `ANSICHT netto/Einstand/Gebühr/Gewinn, Partner- und LATAIF-Anteil (${S(v)})`);
  const r = await save.settleSaleOnPrimary(il1);
  ok(r.shares[0].amount === 186.8, `ABRECHNUNG mit Gebühr: 40 % von 467 = 186.8 (${S(r.shares)})`);
  const basis = JSON.parse(s(DB, "SELECT basis_json FROM item_partner_movements WHERE invoice_line_id = ? AND kind = 'PROFIT_SHARE'", [il1]));
  ok(basis.fee === 33, `GRUNDLAGE hält die Gebühr fest (${S(basis)})`);
  ok(sale().state === 'SETTLED', 'ABGERECHNET und unverändert');
  // Gebühr ändert sich (anteilige Rückholung bei einer Erstattung) → Nachabrechnung nötig, nur die Differenz.
  const { refundCardFeePortion } = await import('../../src/core/finance/card-fee-booking.ts');
  imHaus(() => refundCardFeePortion({ branchId: 'branch-main', userId: 'user-test', invoiceId: inv, feeAmount: 11, debitAccount: 'CARD_CLEARING', sourceId: 'rf-test', occurredAt: NOW }));
  reload();
  const v2 = sale();
  ok(v2.state === 'NEEDS_CORRECTION' && v2.cardFee === 26.4, `GEBÜHR geändert → Nachabrechnung fällig (${v2.state}, ${v2.cardFee})`);
  const k = await save.settleSaleOnPrimary(il1);
  ok(k.mode === 'CORRECTION' && k.shares[0].amount === 2.64 && k.shares[0].total === 189.44, `NACHABRECHNUNG nur die Differenz (${S(k.shares)})`);
}

// ── Quelltext: die Maske ────────────────────────────────────────────────────
{
  const sec = src('src/components/purchases/PurchasePartnerSection.tsx');
  ok(/if \(active\.length === 0\) return null;/.test(sec), 'MASKE ohne aktive Partner kein Partnerfeld');
  ok(/useState\(false\)/.test(sec) && /Add partner/.test(sec), 'MASKE „Add partner" ist standardmäßig geschlossen');
  const panel = src('src/components/partners/PartnerItemsPanel.tsx');
  ok(!/[^t] window\.confirm\(/.test(panel.replace(/await window\.confirm\(/g, '')), 'MASKE jede Rückfrage wird abgewartet');
  // Rückfragen im Dialog der App (ConfirmHost); vor dessen Render das Plugin (2.7 kennt `plugin:dialog|confirm` nicht mehr).
  const main = src('src/main.tsx'), nc = src('src/core/platform/native-confirm.ts'), host = src('src/components/shared/ConfirmHost.tsx');
  ok(main.indexOf('installNativeConfirm();') > 0 && main.indexOf('installNativeConfirm();') < main.indexOf('createRoot(') && /<ConfirmHost \/>/.test(main),
    'RÜCKFRAGE window.confirm vor dem ersten Render ersetzt, Dialog der App eingehängt');
  ok(/import \{ confirm as nativeConfirm \} from '@tauri-apps\/plugin-dialog'/.test(nc) && !/plugin:dialog\|confirm/.test(nc.replace(/^\/\/.*$/gm, '')) && /return false;/.test(nc),
    'RÜCKFRAGE Rückfall über die Plugin-Funktion confirm; Fehler gilt als Cancel');
  ok(/registerConfirmHost\(/.test(host) && /data-app-confirm-ok/.test(host) && /stopImmediatePropagation/.test(host), 'RÜCKFRAGE Dialog der App mit OK / Cancel, Esc nur für die Rückfrage');
  const settleModal = src('src/components/partners/SettleSaleModal.tsx');
  ok(!/window\.confirm/.test(settleModal) && /data-settle-confirm/.test(settleModal) && /saveSettleSale/.test(settleModal) && /setSettleFor\(/.test(panel) && !/saveSettleSale/.test(panel),
    'SETTLE eigener Dialog der App mit Aufstellung; gebucht erst mit „Settle"');
  ok(/data-purchase-partner-amount=/.test(sec) && /pctOfAmount/.test(sec), 'MASKE Anteil auch als Betrag (BHD) eingebbar');
  ok(!/Record contribution/.test(panel) && /'Partner pays in'/.test(panel) && /'Partner repays'/.test(panel)
    && /Settled — nothing open/.test(panel) && /Taken over by LATAIF — settled/.test(panel) && /it\.moneyAction === 'PAY_OUT'/.test(panel),
    'MASKE nur die passende Geldhandlung (pays in / repays / pay out), sonst Status');
}

// ── Rückfrage: Dialog der App, Rückfall aufs Plugin, Dialogfehler (der installierte window.confirm) ─────
{
  const w = globalThis.window as unknown as { __TAURI_INTERNALS__?: unknown; confirm?: (m?: string) => Promise<boolean> };
  const vorher = w.confirm;
  const nc = await import('../../src/core/platform/native-confirm.ts');
  w.__TAURI_INTERNALS__ = {};
  nc.installNativeConfirm();
  const g = globalThis as unknown as { __dialogConfirm: (m: string, o: unknown) => Promise<boolean> };
  // Ohne Dialog der App (vor dessen Render): das Plugin.
  let gefragt: unknown[] = [];
  g.__dialogConfirm = async (m, o) => { gefragt = [m, o]; return true; };
  const ja = await w.confirm!('Settle?');
  g.__dialogConfirm = async () => false;
  const nein = await w.confirm!('Settle?');
  const oe = console.error; console.error = () => {};
  g.__dialogConfirm = async () => { throw new Error('dialog.confirm not allowed. Command not found'); };
  const fehler = await w.confirm!('Settle?');
  ok(ja === true && nein === false && S(gefragt) === S(['Settle?', { title: 'LATAIF', kind: 'warning' }]), 'RÜCKFALL Plugin: OK → true, Cancel → false');
  ok(fehler === false, 'RÜCKFRAGE-FEHLER ein scheiternder Dialog gilt als Cancel (keine Aktion)');
  // Mit Dialog der App: dessen Antwort zählt; ein Fehler dort ebenfalls als Cancel.
  let host = '';
  nc.registerConfirmHost(async (t) => { host = t; return true; });
  const hJa = await w.confirm!('Delete partner?');
  nc.registerConfirmHost(async () => { throw new Error('host broken'); });
  const hFehler = await w.confirm!('Delete partner?');
  nc.registerConfirmHost(null);
  console.error = oe;
  ok(hJa === true && host === 'Delete partner?' && hFehler === false, 'DIALOG DER APP beantwortet die Rückfrage; Fehler = Cancel');
  delete w.__TAURI_INTERNALS__; w.confirm = vorher;
}

console.log(`\npartner-purchase: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

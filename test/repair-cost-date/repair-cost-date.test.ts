// ════════════════════════════════════════════════════════════════════════════
// Owner 12.11.2026 — Reparatur-Kostendatum: Vorgabe Annahmetag, Buchung am Kostendatum, „Edit Cost Date" mit Grund
// (auch nach Zahlung), Periodenschutz, Lager, Partneranteile, Hauptbuch, PC2.
// Harness aus partner-ownership.test.ts.
// Run: node test/repair-cost-date/repair-cost-date.test.ts
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
  for (const pid of ['pw1', 'pw2', 'pw3', 'pw4', 'pw5', 'pw6', 'pw7', 'pw8', 'pw9', 'pw10', 'pw11', 'pw12', 'pw13', 'pw14', 'pw15']) {
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
// Owner 12.11.2026 — REPAIR COST DATE: ein Kostendatum je Kostenzeile (Arbeit, Material, In-house).
//   Vorgabe = Annahmetag; Ausgabe und Kostenbuchung am Kostendatum; Zahlungstag unabhängig;
//   „Edit Cost Date" auch nach Zahlung mit Pflichtgrund — Storno am alten, Neubuchung am neuen Tag;
//   geschlossene Perioden, Lager, Partneranteile und Hauptbuch geschützt; Primary und PC2 gleich.
// Die Wege des Hauses laufen mit der echten Uhr (heute) — die Tage hier liegen nach dem Eröffnungsstichtag (15.10.2026).
// ════════════════════════════════════════════════════════════════════════════
const repairs = await import('../../src/core/repairs/repair-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const gold = await import('../../src/core/gold/gold-house.ts');
const lc = await import('../../src/core/bridge/lifecycle-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const svc = await import('../../src/core/bridge/service-commands.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const pd = await import('../../src/core/utils/payment-date.ts');
const DB = freshDb();
const HEUTE = pd.bahrainTodayIso();
const MORGEN = pd.bahrainTodayIso(Date.now() + 86_400_000);
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const fehler = async (p: () => unknown): Promise<string> => {
  try { await p(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? 'THROWN:' + String(e)); }
};
const meldung = async (p: () => unknown): Promise<string> => { try { await p(); return ''; } catch (e) { return String((e as Error).message); } };
const soll = (acc: string): number => r3(n(DB, "SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ?", [acc]));
const lose = (): number => r3(n(DB, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED'"));
const ausgeglichen = (): boolean => n(DB, "SELECT ROUND(COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END),0), 3) FROM ledger_entries") === 0;
// Eigene Ware in Arbeit: die gebuchten Reparaturkosten stehen schon im Hauptbuch (INVENTORY), im Los erst ab „Ready".
const inArbeit = (): number => r3(n(DB, `SELECT COALESCE(SUM(l.cost_amount), 0) FROM repair_lines l JOIN repairs r ON r.id = l.repair_id
   WHERE l.status = 'OPEN' AND r.repair_scope = 'OWN' AND LOWER(r.status) NOT IN ('ready', 'picked_up', 'delivered')
     AND (l.expense_id IS NOT NULL OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.source_module = 'REPAIR_OWN_WORK' AND e.source_id = l.id))`));
const abgleich = (tag: string) => {
  const rows = reconciliationSnapshotFor({ branchId: 'branch-main' } as never).rows;
  const diff = (acc: string) => { const r = rows.find((x) => x.account === acc); return r ? Math.abs(Number(r.ledger) - Number(r.domain)) : 0; };
  ok(ausgeglichen() && Math.abs(soll('INVENTORY') - lose() - inArbeit()) < 0.0015 && diff('ACCOUNTS_PAYABLE') < 0.0015 && diff('PARTNER_ITEM_BALANCE') < 0.0005,
    `${tag} Abgleich: Hauptbuch ausgeglichen, INVENTORY ${soll('INVENTORY')} = Lose ${lose()} + in Arbeit ${inArbeit()}, A/P und Partnerkonto = Domäne`);
};
const stand = () => S({ zeilen: n(DB, 'SELECT COUNT(*) FROM repair_lines'), le: n(DB, 'SELECT COUNT(*) FROM ledger_entries'),
  ex: n(DB, 'SELECT COUNT(*) FROM expenses'), tage: DB.exec('SELECT id, cost_date FROM repair_lines ORDER BY id')[0]?.values ?? [] });
const kauf = async (pid: string, price: number, shares?: Array<{ partnerId: string; sharePct: number }>) => {
  const id = (await purchaseHouse.createPurchaseOnPrimary(EINKAUF([ZEILE(pid, price, shares)], price))).id;
  return { id, line: lineOf(DB, id, pid) };
};
const reparatur = async (pid: string, lot: string, received = '2026-10-20'): Promise<string> => {
  const id = (await repairs.createRepairOnPrimary({ repairScope: 'OWN', productId: pid, lotId: lot, issueDescription: 'Service' } as never)).id;
  DB.run('UPDATE repairs SET received_at = ? WHERE id = ?', [`${received}T09:00:00.000Z`, id]);
  reload();
  return id;
};
const rev = (rid: string): number => n(DB, 'SELECT revision FROM repairs WHERE id = ?', [rid]);
const zeileNeu = async (rid: string, data: Record<string, unknown>): Promise<string> => {
  const vor = new Set((DB.exec('SELECT id FROM repair_lines WHERE repair_id = ?', [rid])[0]?.values ?? []).map((v) => String(v[0])));
  await repairs.addRepairLineOnPrimary(rid, data as never);
  return String((DB.exec('SELECT id FROM repair_lines WHERE repair_id = ?', [rid])[0]?.values ?? []).map((v) => String(v[0])).find((x) => !vor.has(x)) ?? '');
};
const status = (rid: string, st: string) => repairs.updateRepairStatusOnPrimary(rid, st as never);
const tagDerZeile = (lid: string): string => s(DB, 'SELECT cost_date FROM repair_lines WHERE id = ?', [lid]);
const ausgabeDer = (lid: string): string => s(DB, 'SELECT expense_id FROM repair_lines WHERE id = ?', [lid]);
const buchungen = (mod: string, sid: string): string[] => (DB.exec(
  `SELECT account, direction, amount, substr(occurred_at, 1, 10), CASE WHEN reverses_entry_id IS NULL THEN 'orig' ELSE 'storno' END
     FROM ledger_entries WHERE source_module = ? AND source_id = ? ORDER BY occurred_at, reverses_entry_id IS NOT NULL, account, direction`, [mod, sid])[0]?.values ?? [])
  .map((v) => `${v[4]} ${v[0]} ${v[1]} ${Number(v[2])} ${v[3]}`);
const lebend = (mod: string, sid: string): string[] => (DB.exec(
  `SELECT e1.account, e1.direction, e1.amount, substr(e1.occurred_at, 1, 10) FROM ledger_entries e1
    WHERE e1.source_module = ? AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [mod, sid])[0]?.values ?? [])
  .map((v) => `${v[0]} ${v[1]} ${Number(v[2])} ${v[3]}`);
const aendern = (rid: string, lid: string, tag: string, grund: string) => repairs.changeRepairLineCostDateOnPrimary(rid, lid, tag, grund, rev(rid));
const quartalZu = (y: number, q: number) => DB.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES (?, 'branch-main', ?, ?, ?, '{}', ?)",
  [`vf-${y}-${q}`, y, q, NOW, NOW]);
const quartalAuf = (y: number, q: number) => DB.run('DELETE FROM vat_filings WHERE id = ?', [`vf-${y}-${q}`]);

// ── R1 Werkstattzeile ohne Datum: Vorgabe = Annahmetag; Ausgabe + Buchung am Kostendatum; Zahlung heute, unabhängig ─────
let R1 = '', L1 = '', E1 = '';
{
  const a = await kauf('pw1', 1000);
  R1 = await reparatur('pw1', lotOf(DB, a.line), '2026-10-20');
  L1 = await zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 100 });
  ok(tagDerZeile(L1) === '2026-10-20', `R1 Vorgabe: Kostendatum = Annahmetag 20.10. (${tagDerZeile(L1)})`);
  await status(R1, 'in_progress');
  E1 = ausgabeDer(L1);
  ok(s(DB, 'SELECT expense_date FROM expenses WHERE id = ?', [E1]) === '2026-10-20' && S(lebend('EXPENSE', E1)) === S(['ACCOUNTS_PAYABLE CREDIT 100 2026-10-20', 'INVENTORY DEBIT 100 2026-10-20']),
    `R1 Ausgabe und Kostenbuchung am Kostendatum (${S(lebend('EXPENSE', E1))})`);
  imHaus(() => payables.recordExpensePaymentInHouse(E1, 100, 'bank', payables.localHouseCtx(), {}));
  ok(s(DB, 'SELECT substr(paid_at, 1, 10) FROM expense_payments WHERE expense_id = ?', [E1]) === pd.bahrainTodayIso(Date.now() - 3 * 3600_000).slice(0, 10)
    || s(DB, 'SELECT substr(paid_at, 1, 10) FROM expense_payments WHERE expense_id = ?', [E1]) === new Date().toISOString().slice(0, 10),
    'R1 Zahlung ohne Tag: heute — unabhängig vom Kostendatum');
  const rl = useRepairStore.getState().getRepairLines(R1).find((l) => l.id === L1);
  ok(rl?.costDate === '2026-10-20', `R1 die Zeile im Store trägt das Kostendatum (${rl?.costDate})`);
  abgleich('R1');
}

// ── R2 In-house-Zeile mit gewähltem Datum: aktivierte Eigenleistung am Kostendatum ────────────────────────────────────
let L2 = '';
{
  L2 = await zeileNeu(R1, { workType: 'polishing', costAmount: 30, costDate: '2026-10-22' });
  ok(tagDerZeile(L2) === '2026-10-22' && S(lebend('REPAIR_OWN_WORK', L2)) === S(['EXPENSES_OPERATING CREDIT 30 2026-10-22', 'INVENTORY DEBIT 30 2026-10-22']),
    `R2 In-house 30 am 22.10.: Eigenleistung am Kostendatum (${S(lebend('REPAIR_OWN_WORK', L2))})`);
  abgleich('R2');
}

// ── R3 Anlegen abgewiesen — nichts geschrieben ─────────────────────────────────────────────────────────────────────────
{
  const v = stand();
  ok(await fehler(() => zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 10, costDate: '2099-01-01' })) === 'REPAIR_COST_DATE_INVALID' && stand() === v,
    'R3 Kostendatum in der Zukunft: abgewiesen, nichts geschrieben');
  ok(await fehler(() => zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 10, costDate: MORGEN })) === 'REPAIR_COST_DATE_INVALID' && stand() === v,
    'R3 morgen in Bahrain: abgewiesen');
  ok(await fehler(() => zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 10, costDate: '2026-10-10' })) === 'REPAIR_COST_DATE_BEFORE_OPENING' && stand() === v,
    'R3 vor dem Eröffnungsstichtag: abgewiesen');
  quartalZu(2026, 4);
  ok(await fehler(() => zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 10, costDate: '2026-10-25' })) === 'VAT_PERIOD_FILED' && stand() === v,
    'R3 im eingereichten VAT-Quartal: abgewiesen');
  quartalAuf(2026, 4);
  ok(await fehler(() => zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 10, costDate: '2026-02-30' })) === 'REPAIR_COST_DATE_INVALID' && stand() === v,
    'R3 kein echter Tag: abgewiesen');
}

// ── R4 „Edit Cost Date" nach Zahlung: Storno am alten Tag, Neubuchung am neuen; Zahlung, Betrag, Lager unverändert ─────
{
  const inv0 = soll('INVENTORY'), ap0 = soll('ACCOUNTS_PAYABLE'), lose0 = lose(), zahl0 = S(DB.exec('SELECT amount, method, paid_at FROM expense_payments WHERE expense_id = ?', [E1])[0]?.values);
  const au0 = n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'cost_date'", [L1]);
  await aendern(R1, L1, '2026-10-18', 'workshop invoice is dated 18.10.');
  ok(tagDerZeile(L1) === '2026-10-18' && s(DB, 'SELECT expense_date FROM expenses WHERE id = ?', [E1]) === '2026-10-18', 'R4 Zeile und Ausgabe tragen das neue Kostendatum');
  const b = buchungen('EXPENSE', E1);
  ok(S(lebend('EXPENSE', E1)) === S(['ACCOUNTS_PAYABLE CREDIT 100 2026-10-18', 'INVENTORY DEBIT 100 2026-10-18'])
    && b.filter((x) => x.startsWith('storno')).every((x) => x.endsWith('2026-10-20')) && b.filter((x) => x.startsWith('storno')).length === 2,
    `R4 Hauptbuch: Gegenbuchung am ALTEN Tag (20.10.), Neubuchung am neuen (18.10.) (${S(b)})`);
  ok(soll('INVENTORY') === inv0 && soll('ACCOUNTS_PAYABLE') === ap0 && lose() === lose0, 'R4 Beträge unverändert: INVENTORY, A/P, Lose');
  ok(S(DB.exec('SELECT amount, method, paid_at FROM expense_payments WHERE expense_id = ?', [E1])[0]?.values) === zahl0, 'R4 Zahlung und Zahlungstag unverändert');
  ok(n(DB, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'cost_date'", [L1]) === au0 + 1
    && /workshop invoice is dated 18\.10\./.test(s(DB, "SELECT new_value FROM audit_log WHERE entity_id = ? AND field_name = 'cost_date' ORDER BY rowid DESC LIMIT 1", [L1])),
    'R4 Protokoll: altes/neues Datum mit Grund');
  abgleich('R4');
}

// ── R5 „Edit Cost Date" verständlich abgewiesen — nichts geschrieben ───────────────────────────────────────────────────
{
  const v = stand();
  ok(await fehler(() => aendern(R1, L1, '2026-10-19', '')) === 'REPAIR_COST_DATE_REASON_REQUIRED' && stand() === v, 'R5 ohne Grund: abgewiesen');
  ok(await fehler(() => aendern(R1, L1, '2026-10-18', 'same day')) === 'REPAIR_COST_DATE_UNCHANGED' && stand() === v, 'R5 derselbe Tag: abgewiesen');
  ok(await fehler(() => aendern(R1, L1, MORGEN, 'later')) === 'REPAIR_COST_DATE_INVALID' && stand() === v, 'R5 morgen: abgewiesen');
  ok(await fehler(() => aendern(R1, L1, '2026-10-12', 'before opening')) === 'REPAIR_COST_DATE_BEFORE_OPENING' && stand() === v, 'R5 vor der Eröffnung: abgewiesen');
  quartalZu(2026, 4);
  ok(await fehler(() => aendern(R1, L1, '2026-10-19', 'quarter filed')) === 'VAT_PERIOD_FILED' && stand() === v, 'R5 im eingereichten Quartal: abgewiesen');
  quartalAuf(2026, 4);
  // Eine Werkstattzeile, bezahlt mit gewähltem Tag 21.10. — das Kostendatum darf nicht danach liegen.
  const Lz = await zeileNeu(R1, { supplierId: 'sup-1', workType: 'service', costAmount: 40, costDate: '2026-10-20' });
  imHaus(() => payables.recordExpensePaymentInHouse(ausgabeDer(Lz), 40, 'cash', payables.localHouseCtx(), { paidAt: '2026-10-21' }));
  const v2 = stand();
  const m = await meldung(() => aendern(R1, Lz, '2026-10-23', 'invoice later'));
  ok(await fehler(() => aendern(R1, Lz, '2026-10-23', 'invoice later')) === 'REPAIR_COST_DATE_AFTER_PAYMENT' && /2026-10-21/.test(m) && stand() === v2,
    `R5 nach der Zahlung (21.10.): abgewiesen, Zahlungstag genannt (${m.slice(0, 90)})`);
  await aendern(R1, Lz, '2026-10-21', 'same day as payment');
  ok(tagDerZeile(Lz) === '2026-10-21', 'R5 am Zahlungstag selbst: erlaubt');
  DB.run("UPDATE repairs SET invoice_id = 'inv-x' WHERE id = ?", [R1]);
  ok(await fehler(() => aendern(R1, L1, '2026-10-19', 'invoiced')) === 'REPAIR_ALREADY_INVOICED', 'R5 abgerechnete Reparatur: abgewiesen');
  DB.run('UPDATE repairs SET invoice_id = NULL WHERE id = ?', [R1]);
  DB.run("UPDATE products SET stock_status = 'sold' WHERE id = 'pw1'");
  ok(await fehler(() => aendern(R1, L1, '2026-10-19', 'sold item')) === 'REPAIR_COST_ALREADY_SOLD', 'R5 eigenes Stück verkauft: abgewiesen');
  DB.run("UPDATE products SET stock_status = 'in_stock' WHERE id = 'pw1'");
  reload();
}

// ── R6 In-house-Zeile umdatieren: Eigenleistung am alten Tag gegengebucht, am neuen neu ────────────────────────────────
{
  const inv0 = soll('INVENTORY');
  await aendern(R1, L2, '2026-10-21', 'polished a day earlier');
  const b = buchungen('REPAIR_OWN_WORK', L2);
  ok(tagDerZeile(L2) === '2026-10-21' && S(lebend('REPAIR_OWN_WORK', L2)) === S(['EXPENSES_OPERATING CREDIT 30 2026-10-21', 'INVENTORY DEBIT 30 2026-10-21'])
    && b.filter((x) => x.startsWith('storno')).every((x) => x.endsWith('2026-10-22')) && soll('INVENTORY') === inv0,
    `R6 Eigenleistung: Storno am 22.10., neu am 21.10., Betrag gleich (${S(b)})`);
  abgleich('R6');
}

// ── R7 gemeinsamer Artikel (Partner 40 %), nach „Ready": Partneranteil, Los-Einstand und Hauptbuch-Summen unverändert ───
{
  const a = await kauf('pw2', 1000, [{ partnerId: 'pa-b', sharePct: 40 }]);
  await move(a.line, 'CONTRIBUTION', 400);
  const R = await reparatur('pw2', lotOf(DB, a.line), '2026-10-24');
  const L = await zeileNeu(R, { supplierId: 'sup-1', workType: 'service', costAmount: 100 });
  await status(R, 'in_progress');
  await status(R, 'ready');
  const offen0 = open(a.line), los0 = n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]), pib0 = soll('PARTNER_ITEM_BALANCE');
  await aendern(R, L, '2026-10-25', 'workshop finished on 25.10.');
  ok(tagDerZeile(L) === '2026-10-25' && open(a.line) === offen0 && n(DB, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lotOf(DB, a.line)]) === los0 && soll('PARTNER_ITEM_BALANCE') === pib0,
    `R7 Partneranteil (${offen0}), Los-Einstand (${los0}) und Partnerkonto unverändert`);
  abgleich('R7');
}

// ── R8 Altbestand ohne Kostendatum: Buchung wie bisher am Tag der Buchung ──────────────────────────────────────────────
{
  const a = await kauf('pw3', 1000);
  const R = await reparatur('pw3', lotOf(DB, a.line), '2026-10-26');
  const L = await zeileNeu(R, { supplierId: 'sup-1', workType: 'service', costAmount: 60 });
  DB.run('UPDATE repair_lines SET cost_date = NULL WHERE id = ?', [L]);
  reload();
  await status(R, 'in_progress');
  const tag = s(DB, 'SELECT expense_date FROM expenses WHERE id = ?', [ausgabeDer(L)]);
  ok(tag === new Date().toISOString().slice(0, 10), `R8 Altbestand: Ausgabe am Tag der Buchung, wie bisher (${tag})`);
}

// ── R9 Material: ein Kostendatum für alle Positionen ───────────────────────────────────────────────────────────────────
{
  const a = await kauf('pw4', 1000);
  const R = await reparatur('pw4', lotOf(DB, a.line), '2026-10-27');
  await status(R, 'in_progress');
  const out = imHaus(() => gold.addRepairMaterialInHouse({ branchId: 'branch-main', userId: 'user-test' }, {
    repairId: R, expectedRevision: rev(R), costDate: '2026-10-28',
    rows: [{ materialKind: 'diamond', description: 'Diamond 0.1ct', quantity: 1, caratPerPiece: 0.1, totalCost: 50, supplierId: 'sup-1' }],
  }));
  const L = out.lineIds[0];
  ok(tagDerZeile(L) === '2026-10-28' && s(DB, 'SELECT expense_date FROM expenses WHERE id = ?', [ausgabeDer(L)]) === '2026-10-28',
    `R9 Material: Zeile und Ausgabe am Kostendatum 28.10. (${tagDerZeile(L)})`);
  const v = stand();
  ok(await fehler(() => imHaus(() => gold.addRepairMaterialInHouse({ branchId: 'branch-main', userId: 'user-test' }, {
    repairId: R, expectedRevision: rev(R), costDate: '2026-10-01',
    rows: [{ materialKind: 'diamond', description: 'Diamond', quantity: 1, caratPerPiece: 0.1, totalCost: 50, supplierId: 'sup-1' }],
  }))) === 'REPAIR_COST_DATE_BEFORE_OPENING' && stand() === v, 'R9 Material vor der Eröffnung: abgewiesen, nichts geschrieben');
  abgleich('R9');
}

// ── R10 PC2: add_line mit costDate, update_line mit costDate + reason, Wiederholung, strenger Rumpf, SALES ─────────────
{
  const a = await kauf('pw5', 1000);
  const R = await reparatur('pw5', lotOf(DB, a.line), '2026-10-29');
  await status(R, 'in_progress');
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000c1`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() });
  const ident = (k: number, op: string) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op, payloadHash: 'h' + k });
  const run = async (fn: (d: never, i: never, b: unknown) => Promise<unknown>, k: number, op: string, body: unknown): Promise<{ kind: string; code?: string; replayed?: boolean; lineId?: string }> => {
    try { return await fn(deps() as never, ident(k, op) as never, body) as { kind: string; code?: string; replayed?: boolean; lineId?: string }; }
    catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? '') }; }
  };
  const x = await run(lc.runAddRepairLine as never, 1, 'repairs.add_line', { repairId: R, expectedRevision: rev(R), supplierId: 'sup-1', workType: 'service', costAmount: 70, costDate: '2026-10-30' });
  const L = String((x as { lineId?: string }).lineId ?? s(DB, 'SELECT id FROM repair_lines WHERE repair_id = ? ORDER BY position DESC LIMIT 1', [R]));
  ok(x.kind === 'ok' && tagDerZeile(L) === '2026-10-30' && s(DB, 'SELECT expense_date FROM expenses WHERE id = ?', [ausgabeDer(L)]) === '2026-10-30',
    `R10 PC2 add_line mit costDate: Zeile + Ausgabe am 30.10. (${x.kind})`);
  const v = stand();
  const mix = await run(lc.runUpdateRepairLine as never, 2, 'repairs.update_line', { repairId: R, lineId: L, expectedRevision: rev(R), costAmount: 80, costDate: '2026-10-29', reason: 'x y z' });
  ok(mix.code === 'FINANCIAL_PAYLOAD_INVALID' || /PAYLOAD/.test(String(mix.code)), `R10 Kostendatum zusammen mit anderen Feldern: Rumpf abgewiesen (${S(mix)})`);
  const ohne = await run(lc.runUpdateRepairLine as never, 3, 'repairs.update_line', { repairId: R, lineId: L, expectedRevision: rev(R), costDate: '2026-10-29' });
  ok(/PAYLOAD/.test(String(ohne.code)) && stand() === v, `R10 ohne Grund: Rumpf abgewiesen (${S(ohne)})`);
  const kurz = await run(lc.runUpdateRepairLine as never, 4, 'repairs.update_line', { repairId: R, lineId: L, expectedRevision: rev(R), costDate: '2026-10-29', reason: 'x' });
  ok(kurz.code === 'REPAIR_COST_DATE_REASON_REQUIRED' && stand() === v, `R10 zu kurzer Grund: abgewiesen (${S(kurz)})`);
  const body = { repairId: R, lineId: L, expectedRevision: rev(R), costDate: '2026-10-29', reason: 'bill dated 29.10.' };
  const u1 = await run(lc.runUpdateRepairLine as never, 5, 'repairs.update_line', body);
  const u2 = await run(lc.runUpdateRepairLine as never, 5, 'repairs.update_line', body);
  ok(u1.kind === 'ok' && u2.kind === 'ok' && u2.replayed === true && tagDerZeile(L) === '2026-10-29'
    && buchungen('EXPENSE', ausgabeDer(L)).filter((y) => y.startsWith('storno')).length === 2,
    `R10 PC2 update_line mit costDate: genau einmal umgebucht (${u1.kind}/${u2.kind})`);
  ok(/user-pc2/.test(S(DB.exec("SELECT changed_by FROM audit_log WHERE entity_id = ? AND field_name = 'cost_date' ORDER BY rowid DESC LIMIT 1", [L])[0]?.values ?? [])),
    'R10 Protokoll nennt den Menschen am PC2');
  const v2 = stand();
  const sales = await registry.executeCommand('repairs.update_line', { input: { repairId: R, lineId: L, expectedRevision: rev(R), costDate: '2026-10-30', reason: 'sales try' } },
    { commandId: '00000097-0000-4000-8000-0000000000c1', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'u', role: 'SALES', payloadHash: 'h97' } as never) as { kind: string; code?: string };
  ok(sales.kind !== 'ok' && stand() === v2, `R10 SALES: kein Umbuchen (${S(sales)})`);
  abgleich('R10');
}

// ── R11 Annahme VOR der Eröffnung: keine stille Vorgabe „heute" — die Maske bittet, der Primary lehnt verständlich ab ─────
{
  const cd = await import('../../src/core/repairs/repair-cost-date.ts');
  const p = cd.repairCostDatePrompt('2026-10-10') ?? '';
  ok(cd.defaultRepairCostDay('2026-10-10') === '' && /received on 10 Oct 2026, before the opening \(15 Oct 2026\)/.test(p) && /choose the cost date/.test(p),
    `R11 Maske: keine Vorgabe, verständliche Aufforderung (${p})`);
  ok(cd.defaultRepairCostDay('2026-10-20') === '2026-10-20' && cd.repairCostDatePrompt('2026-10-20') === null
    && cd.defaultRepairCostDay(MORGEN) === '' && cd.defaultRepairCostDay('kaputt') === '',
    'R11 Maske: offener Annahmetag bleibt Vorgabe; künftig/ungültig ohne Vorgabe');

  const a = await kauf('pw6', 1000);
  const R = await reparatur('pw6', lotOf(DB, a.line), '2026-10-10');
  const v = stand();
  const m = await meldung(() => zeileNeu(R, { supplierId: 'sup-1', workType: 'service', costAmount: 50 }));
  ok(await fehler(() => zeileNeu(R, { supplierId: 'sup-1', workType: 'service', costAmount: 50 })) === 'REPAIR_COST_DATE_REQUIRED'
    && /before the opening/.test(m) && stand() === v, `R11 Zeile mit Betrag ohne Tag: abgewiesen, nichts geschrieben (${m.slice(0, 80)})`);
  ok(await fehler(() => imHaus(() => gold.addRepairMaterialInHouse({ branchId: 'branch-main', userId: 'user-test' }, {
    repairId: R, expectedRevision: rev(R),
    rows: [{ materialKind: 'diamond', description: 'Diamond', quantity: 1, caratPerPiece: 0.1, totalCost: 50, supplierId: 'sup-1' }],
  }))) === 'REPAIR_COST_DATE_REQUIRED' && stand() === v, 'R11 Material ohne Tag: abgewiesen, nichts geschrieben');
  const Lw = await zeileNeu(R, { supplierId: 'sup-1', workType: 'service', costAmount: 50, costDate: '2026-10-20' });
  ok(tagDerZeile(Lw) === '2026-10-20', 'R11 mit gewähltem Tag: angelegt am gewählten Kostendatum');

  // Eigene Arbeit 0.000 braucht keinen Tag; bekommt sie einen Betrag, gilt dieselbe Regel (erst „Edit date").
  const L0 = await zeileNeu(R, { workType: 'polishing', costAmount: 0 });
  ok(!!L0 && tagDerZeile(L0) === '', 'R11 eigene Arbeit 0.000 ohne Tag: angelegt, ohne Kostendatum');
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000d1`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() });
  const ident = (k: number, op: string) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op, payloadHash: 'h' + k });
  const run = async (fn: (d: never, i: never, b: unknown) => Promise<unknown>, k: number, op: string, body: unknown): Promise<{ kind: string; code?: string; message?: string }> => {
    try { return await fn(deps() as never, ident(k, op) as never, body) as { kind: string; code?: string; message?: string }; }
    catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? ''), message: String((e as Error).message) }; }
  };
  const v0 = stand();
  const hoch = await run(lc.runUpdateRepairLine as never, 1, 'repairs.update_line', { repairId: R, lineId: L0, expectedRevision: rev(R), costAmount: 30 });
  ok(hoch.code === 'REPAIR_COST_DATE_REQUIRED' && n(DB, 'SELECT cost_amount FROM repair_lines WHERE id = ?', [L0]) === 0 && stand() === v0,
    `R11 0.000 → 30 ohne Tag (PC2): abgewiesen, nichts geschrieben (${S(hoch).slice(0, 120)})`);
  await aendern(R, L0, '2026-10-21', 'polished on 21.10.');
  const hoch2 = await run(lc.runUpdateRepairLine as never, 2, 'repairs.update_line', { repairId: R, lineId: L0, expectedRevision: rev(R), costAmount: 30 });
  await status(R, 'in_progress');
  ok(hoch2.kind === 'ok' && S(lebend('REPAIR_OWN_WORK', L0)) === S(['EXPENSES_OPERATING CREDIT 30 2026-10-21', 'INVENTORY DEBIT 30 2026-10-21']),
    `R11 nach „Edit date": 30 gebucht am gewählten Tag (${S(lebend('REPAIR_OWN_WORK', L0))})`);
  abgleich('R11a');

  // Anlegen mit Kosten: ohne Tag abgewiesen (nichts angelegt), mit Tag beide Zeilen am gewählten Tag.
  const b = await kauf('pw7', 1000);
  const anlage = (extra: Record<string, unknown>) => repairs.createRepairOnPrimary({
    repairScope: 'OWN', productId: 'pw7', lotId: lotOf(DB, b.line), issueDescription: 'Old repair', receivedAt: '2026-10-10',
    repairType: 'hybrid', inHouseWorkType: 'polishing', inHouseCost: 25, workshopSupplierId: 'sup-1', estimatedCost: 40, ...extra,
  } as never);
  const vr = S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]);
  const ma = await meldung(() => anlage({}));
  ok(await fehler(() => anlage({})) === 'REPAIR_COST_DATE_REQUIRED' && /before the opening/.test(ma) && S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]) === vr,
    `R11 Anlegen mit Kosten ohne Tag: abgewiesen, nichts angelegt (${ma.slice(0, 70)})`);
  const neu = await anlage({ costDate: '2026-10-22' });
  const tage = (DB.exec('SELECT supplier_id IS NOT NULL, cost_date FROM repair_lines WHERE repair_id = ? ORDER BY position', [neu.id])[0]?.values ?? []).map((x) => `${x[0] ? 'W' : 'I'} ${x[1]}`);
  ok(S(tage) === S(['W 2026-10-22', 'I 2026-10-22']), `R11 Anlegen mit Tag: Werkstatt- und eigene Zeile am gewählten Tag (${S(tage)})`);

  // Anlegen nach der Eröffnung: die Werkstattzeile trägt den Annahmetag (vorher ohne Datum → Buchungstag).
  const c = await kauf('pw8', 1000);
  const neu2 = await repairs.createRepairOnPrimary({
    repairScope: 'OWN', productId: 'pw8', lotId: lotOf(DB, c.line), issueDescription: 'Recent', receivedAt: '2026-10-23',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 35,
  } as never);
  ok(s(DB, 'SELECT cost_date FROM repair_lines WHERE repair_id = ?', [neu2.id]) === '2026-10-23', 'R11 Werkstattzeile beim Anlegen: Kostendatum = Annahmetag');

  // PC2 legt an: dieselbe Regel, dasselbe Nein.
  const d = await kauf('pw9', 1000);
  const body = { repairScope: 'OWN', productId: 'pw9', lotId: lotOf(DB, d.line), issueDescription: 'PC2 old', receivedAt: '2026-10-10',
    repairType: 'internal', inHouseWorkType: 'polishing', inHouseCost: 15 };
  const vp = S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]);
  const pc2a = await run(svc.runRepairCreate as never, 3, 'repairs.create', body);
  ok(pc2a.kind !== 'ok' && pc2a.code === 'REPAIR_COST_DATE_REQUIRED' && S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]) === vp,
    `R11 PC2 Anlegen ohne Tag: abgewiesen, nichts angelegt (${S(pc2a).slice(0, 100)})`);
  const pc2b = await run(svc.runRepairCreate as never, 4, 'repairs.create', { ...body, costDate: '2026-10-24' });
  ok(pc2b.kind === 'ok' && s(DB, "SELECT l.cost_date FROM repair_lines l JOIN repairs r ON r.id = l.repair_id WHERE r.product_id = 'pw9'") === '2026-10-24',
    `R11 PC2 Anlegen mit Tag: eigene Zeile am gewählten Tag (${pc2b.kind})`);

  // Annahmetag in einem eingereichten Quartal: ebenfalls kein stilles „heute".
  const e = await kauf('pw10', 1000);
  const R2 = await reparatur('pw10', lotOf(DB, e.line), '2026-10-20');
  quartalZu(2026, 4);
  const vq = stand();
  ok(await fehler(() => zeileNeu(R2, { supplierId: 'sup-1', workType: 'service', costAmount: 10 })) === 'REPAIR_COST_DATE_REQUIRED' && stand() === vq,
    'R11 Annahmetag im eingereichten Quartal: Zeile ohne Tag abgewiesen');
  quartalAuf(2026, 4);
  abgleich('R11');
}

// ── R12 Reparaturkosten vereinfacht: NEUE Kosten nur als Kostenzeile; Altbestand unverändert; Voranschlag bucht nie ───────
{
  const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-0000000000e1`;
  const deps = () => ({ db: DB as never, begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
    commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => new Date().toISOString() });
  const ident = (k: number, op: string) => ({ commandId: ID(k), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN', op, payloadHash: 'h' + k });
  const run = async (fn: (d: never, i: never, b: unknown) => Promise<unknown>, k: number, op: string, body: unknown): Promise<{ kind: string; code?: string }> => {
    try { return await fn(deps() as never, ident(k, op) as never, body) as { kind: string; code?: string }; }
    catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? '') }; }
  };
  const form = (rid: string, extra: Record<string, unknown>) => ({ ...useRepairStore.getState().getRepair(rid), ...extra });
  const speichern = (rid: string, extra: Record<string, unknown>) => repairs.updateRepairOnPrimary(rid, form(rid, extra) as never, rev(rid));
  const kopf = (rid: string) => S(DB.exec('SELECT internal_cost, actual_cost, estimated_cost, workshop_supplier_id, repair_type FROM repairs WHERE id = ?', [rid])[0]?.values ?? []);
  const kopfBuchungen = (rid: string): number => n(DB, `SELECT COUNT(*) FROM ledger_entries WHERE (source_module = 'REPAIR_OWN_WORK' AND source_id = ?)
     OR (source_module = 'EXPENSE' AND source_id IN (SELECT id FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?
       AND NOT EXISTS (SELECT 1 FROM repair_lines l WHERE l.expense_id = expenses.id)))`, [rid, rid]);

  // a) Neue Reparatur ohne Kopfkosten: eigene Kosten / „Actual" von Hand → verständliches Nein, nichts geschrieben (Primary + PC2).
  const a = await kauf('pw11', 1000);
  const R = await reparatur('pw11', lotOf(DB, a.line), '2026-10-20');
  const v = S([kopf(R), stand()]);
  const m = await meldung(() => speichern(R, { internalCost: 30 }));
  ok(await fehler(() => speichern(R, { internalCost: 30 })) === 'REPAIR_COST_AS_LINE' && /\+ Add Work” → In-house/.test(m) && S([kopf(R), stand()]) === v,
    `R12 Primary: neue eigene Kosten im Kopf abgewiesen, nichts geschrieben (${m.slice(0, 80)})`);
  ok(await fehler(() => speichern(R, { actualCost: 40 })) === 'REPAIR_COST_AS_LINE' && S([kopf(R), stand()]) === v, 'R12 Primary: „Actual" von Hand ohne Zeilen abgewiesen');
  const p1 = await run(svc.runRepairUpdate as never, 1, 'repairs.update', { id: R, expectedRevision: rev(R), internalCost: 30 });
  const p2 = await run(svc.runRepairUpdate as never, 2, 'repairs.update', { id: R, expectedRevision: rev(R), actualCost: 40 });
  ok(p1.code === 'REPAIR_COST_AS_LINE' && p2.code === 'REPAIR_COST_AS_LINE' && S([kopf(R), stand()]) === v,
    `R12 PC2 (auch alter Befehl): internalCost / actualCost abgewiesen, nichts geschrieben (${p1.code}/${p2.code})`);
  // Voranschlag bleibt Information: speichern geht, gebucht wird bis „Ready" nichts davon.
  const p3 = await run(svc.runRepairUpdate as never, 3, 'repairs.update', { id: R, expectedRevision: rev(R), estimatedCost: 50, notes: 'quote 50' });
  ok(p3.kind === 'ok' && n(DB, 'SELECT estimated_cost FROM repairs WHERE id = ?', [R]) === 50, 'R12 Voranschlag 50 gespeichert (Information)');
  const p4 = await run(svc.runRepairUpdate as never, 4, 'repairs.update', { id: R, expectedRevision: rev(R), repairType: 'external', workshopSupplierId: 'sup-1' });
  ok(p4.code === 'REPAIR_COST_AS_LINE' && n(DB, 'SELECT COUNT(*) FROM repairs WHERE id = ? AND workshop_supplier_id IS NOT NULL', [R]) === 0,
    `R12 Werkstatt in den Kopf (Voranschlag würde Gebühr): abgewiesen (${p4.code})`);
  const L = await zeileNeu(R, { workType: 'polishing', costAmount: 20, costDate: '2026-10-21' });
  await status(R, 'in_progress');
  await status(R, 'ready');
  ok(kopfBuchungen(R) === 0 && S(lebend('REPAIR_OWN_WORK', L)) === S(['EXPENSES_OPERATING CREDIT 20 2026-10-21', 'INVENTORY DEBIT 20 2026-10-21']),
    `R12 „Ready": keine Kopfbuchung, kein Voranschlag gebucht — nur die In-house-Zeile am Kostendatum (${S(lebend('REPAIR_OWN_WORK', L))})`);
  abgleich('R12a');

  // b) Ein Spiegel wird nicht über einen Artwechsel zu eigenen Kosten (alter Befehl).
  const b = await kauf('pw12', 1000);
  const Rb = await reparatur('pw12', lotOf(DB, b.line), '2026-10-20');
  DB.run("UPDATE repairs SET repair_type = 'external', estimated_cost = 100, internal_cost = 100 WHERE id = ?", [Rb]);
  reload();
  const vb = S([kopf(Rb), stand()]);
  const pb = await run(svc.runRepairUpdate as never, 5, 'repairs.update', { id: Rb, expectedRevision: rev(Rb), repairType: 'internal' });
  ok(pb.code === 'REPAIR_COST_AS_LINE' && S([kopf(Rb), stand()]) === vb, `R12 Artwechsel external → internal (Spiegel 100 würde eigene Kosten): abgewiesen (${pb.code})`);

  // c) Altbestand: eigene Kopfkosten bleiben änderbar, wie bisher.
  const c = await kauf('pw13', 1000);
  const Rc = await reparatur('pw13', lotOf(DB, c.line), '2026-10-20');
  DB.run('UPDATE repairs SET internal_cost = 25 WHERE id = ?', [Rc]);
  reload();
  await speichern(Rc, { internalCost: 35, notes: 'more polishing' });
  const pc = await run(svc.runRepairUpdate as never, 6, 'repairs.update', { id: Rc, expectedRevision: rev(Rc), notes: 'checked' });
  ok(n(DB, 'SELECT internal_cost FROM repairs WHERE id = ?', [Rc]) === 35 && pc.kind === 'ok', 'R12 Altbestand: eigene Kopfkosten 25 → 35 änderbar, Notiz am PC2 geht');

  // d) Altbestand Werkstattgebühr im Kopf (ohne Zeile): der Voranschlag ist dort die Gebühr — bleibt änderbar.
  const d = await kauf('pw14', 1000);
  const Rd = await reparatur('pw14', lotOf(DB, d.line), '2026-10-20');
  DB.run("UPDATE repairs SET repair_type = 'external', workshop_supplier_id = 'sup-1', estimated_cost = 80, internal_cost = 80 WHERE id = ?", [Rd]);
  reload();
  const pd = await run(svc.runRepairUpdate as never, 7, 'repairs.update', { id: Rd, expectedRevision: rev(Rd), estimatedCost: 90 });
  ok(pd.kind === 'ok' && n(DB, 'SELECT estimated_cost FROM repairs WHERE id = ?', [Rd]) === 90, `R12 Altbestand Gebühr im Kopf: 80 → 90 änderbar (${pd.kind})`);

  // e) Anlegen mit eigenen Kosten im Kopf (alter Auftrag): Nein, nichts angelegt — Primary und PC2 gleich.
  const e = await kauf('pw15', 1000);
  const vr = S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]);
  const anlage = { repairScope: 'OWN', productId: 'pw15', lotId: lotOf(DB, e.line), issueDescription: 'Old client form', repairType: 'internal', internalCost: 20 };
  const ea = await fehler(() => repairs.createRepairOnPrimary(anlage as never));
  const eb = await run(svc.runRepairCreate as never, 8, 'repairs.create', anlage);
  ok(ea === 'REPAIR_COST_AS_LINE' && eb.code === 'REPAIR_COST_AS_LINE' && S([n(DB, 'SELECT COUNT(*) FROM repairs'), stand()]) === vr,
    `R12 Anlegen mit internalCost: Primary und PC2 abgewiesen, nichts angelegt (${ea}/${eb.code})`);
  abgleich('R12');
}

console.log(`\nrepair-cost-date: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('REPAIR_COST_DATE_PROVED');

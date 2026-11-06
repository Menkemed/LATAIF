// ════════════════════════════════════════════════════════════════════════════
// CUSTOM-ORDER Phase 1 — K3a: Goldschuld einer Order in BHD begleichen (Teil, Kurs, Tag), Wirkung auf den Einstand
// vor und nach dem Verkauf (Zero, Margin mit neuer Margin-VAT), gesperrte Quartale, Rücknahme, PC2, alte Wege gesperrt.
// Run: node --experimental-strip-types test/custom-order/phase1-k3a.test.ts
// ════════════════════════════════════════════════════════════════════════════
//   I  K2 Fehler mittendrin (VAT-Quartal zu): keine Rechnung, kein Artikel, keine Anrechnung
//   J  K2 PC2 `orders.convert_to_invoice` mit Sonderstück und Rechnungsdatum (dieselbe Wirkung); Überzahlung → Guthaben
//   L  Hauptbuch-Audit: jede Klammer ausgeglichen, Soll = Haben gesamt
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

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage, confirm: () => true };

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
await import('../../src/core/bridge/read-commands.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { loadBankingFor } = await import('../../src/stores/bankingStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const convertHouse = await import('../../src/core/orders/order-convert-house.ts');
const goldHouse = await import('../../src/core/gold/gold-house.ts');
const lifeHouse = await import('../../src/core/orders/order-lifecycle-house.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { orderCustomCostBasis } = await import('../../src/core/orders/order-invoice-lines.ts');
const { reconciliationSnapshotFor } = await import('../../src/core/reports/reconciliation-snapshot.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-20T10:00:00.000Z';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();
function reload(): void {
  useProductStore.getState().loadProducts();
  useProductStore.getState().loadCategories();
  useCustomerStore.getState().loadCustomers();
  useOrderStore.getState().loadOrders();
  useInvoiceStore.getState().loadInvoices();
  useSupplierStore.getState().loadSuppliers();
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
  db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', ['branch-main', 'tenant-1', 'Haupt', NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-gold-jewelry','branch-main','Gold-Diamond Jewellery','g','#000',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, active, created_at, updated_at) VALUES ('cat-off','branch-main','Alt','g','#000',0,?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c1','branch-main','Um','Khalid','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('sup-arup','branch-main','Arup Goldsmith',1,1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const ACTOR = { branchId: 'branch-main', userId: 'user-test' };
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (x: string, op: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW,
});
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);
interface Ausgang { ok: boolean; code: string; value?: Record<string, unknown> }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown> };
    return o.kind === 'ok' ? { ok: true, code: '', value: o.value } : { ok: false, code: o.code ?? '(ohne Code)' };
  } catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) }; }
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); reload(); throw e; }
}
const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e)));
function nein(fn: () => unknown): string { try { fn(); return 'KEIN NEIN'; } catch (e) { return codeOf(e); } }

/** Saldo eines Kontos (Soll − Haben), optional nur Einträge mit Quelle/Gegenpartei. */
const saldo = (db: Db, account: string, where = '1=1', p: unknown[] = []): number => r3(n(db,
  `SELECT COALESCE(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? AND ${where}`, [account, ...p]));
/** Jede Buchung (transaction_id) ist für sich ausgeglichen, das ganze Buch auch. */
function buchAusgeglichen(db: Db): boolean {
  const off = rows(db, `SELECT transaction_id, ROUND(SUM(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END), 3) AS d
    FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005`);
  return off.length === 0;
}

type OI = import('../../src/core/orders/order-create.ts').OrderCreateInput;
const SPEC = { categoryId: 'cat-gold-jewelry', brand: '', name: 'Ring', sku: '', condition: 'New', taxScheme: 'ZERO', scopeOfDelivery: [], attributes: { karat: '21K', weight: 4.33, item_type: 'Ring' }, images: [] };
const ORD2: OI = {
  customerId: 'c1', orderType: 'custom', lines: [{ mode: 'existing', description: '', scheme: 'auto', quantity: 1, unitPrice: 0 }],
  quotedPrice: 240, customTaxScheme: 'ZERO', finalProductDescription: 'Ring 21K', customProductSpec: SPEC as never,
  customerGoldGrams: 0, customerGoldKarat: '21K', customerStones: '1 Emerald', goldsmithSupplierId: 'sup-arup', laborCost: 25,
  extraGoldGrams: 4.33, extraGoldKarat: '21K', extraGoldCost: 185, extraGoldSupplierId: 'sup-arup', materials: [],
  depositAmount: 240, paymentMethod: 'card', cardBrand: 'normal', fullyPaid: false, expectedDelivery: '',
  orderDate: '2026-10-25', status: 'completed', notes: '',
};
function anlegen(input: OI): string {
  const id = imHaus(() => orderHouse.createOrderInHouse(input, 'branch-main').order.id);
  reload();
  return id;
}
function umwandeln(orderId: string, req: Partial<import('../../src/core/orders/order-convert-house.ts').OrderConvertRequest> = {}) {
  const out = imHaus(() => convertHouse.convertOrderToInvoiceInHouse({ orderId, invoiceDate: '2026-11-01', ...req }, 'branch-main'));
  reload();
  return out;
}

const goldSettle = await import('../../src/core/gold/order-gold-settle.ts');
const goldCore = await import('../../src/core/gold/gold-settle.ts');
const goldCmd = await import('../../src/core/bridge/gold-commands.ts');
const { useGoldStore } = await import('../../src/stores/goldStore.ts');
const { liveVatQuarters } = await import('../../src/core/tax/vat-quarter-overview.ts');

const payableOf = (db: Db, oid: string): string => String(one(db, 'SELECT id FROM gold_payables WHERE source_order_id = ?', [oid]));
const settle = (pid: string, grams: number, ratePerGram: number, settledOn?: string) =>
  imHaus(() => goldSettle.settleOrderGoldInBhd(ACTOR, { payableId: pid, grams, ratePerGram, ...(settledOn ? { settledOn } : {}) }));
const goldLineCost = (db: Db, oid: string): number => r3(n(db, "SELECT cost_amount FROM order_lines WHERE order_id = ? AND material_kind = 'gold'", [oid]));

// ══ A — vor dem Verkauf: Teil + Rest ════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const pid = payableOf(db, oid);
  const a1 = settle(pid, 2.33, 44, '2026-10-30');
  ok(a1.amount === 102.52 && a1.bookShare === 99.55 && a1.difference === 2.97 && a1.status === 'OPEN' && a1.openGrams === 2,
    `A Teil 2.330 g × 44: Schuld 102.520, Buchwert-Anteil 99.550, Differenz +2.970, offen 2.000 g (${S(a1)})`);
  ok(saldo(db, 'GOLD_LIABILITY') === -85.45 && saldo(db, 'INVENTORY') === 212.97 && goldLineCost(db, oid) === 187.97,
    `A Goldschuld-Wert 85.450 offen, Lager 212.970, Gold-Zeile 187.970 (${saldo(db, 'GOLD_LIABILITY')}/${saldo(db, 'INVENTORY')}/${goldLineCost(db, oid)})`);
  const e1 = rows(db, "SELECT amount, supplier_id, related_module, expense_date, status FROM expenses WHERE related_module = 'gold_payable'")[0];
  ok(e1 && Number(e1.amount) === 102.52 && e1.supplier_id === 'sup-arup' && e1.expense_date === '2026-10-30' && e1.status === 'PENDING'
    && saldo(db, 'ACCOUNTS_PAYABLE', "counterparty_id = 'sup-arup'") === -127.52,
  `A Lieferantenschuld Arup: Lohn 25 + Gold 102.520 (${S(e1)})`);
  const a2 = settle(pid, 2, 42);
  ok(a2.amount === 84 && a2.bookShare === 85.45 && a2.difference === -1.45 && a2.status === 'FULFILLED',
    `A Rest 2.000 g × 42: Anteil = exakter Rest 85.450, Differenz −1.450, beglichen (${S(a2)})`);
  ok(saldo(db, 'GOLD_LIABILITY') === 0 && saldo(db, 'INVENTORY') === 211.52 && goldLineCost(db, oid) === 186.52,
    'A Goldschuld-Wert ausgeglichen; tatsächliche Goldkosten 186.520 im Einstand');
  const out = umwandeln(oid);
  ok(saldo(db, 'COGS') === 211.52 && saldo(db, 'INVENTORY') === 0 && n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId]) === 211.52,
    `A Verkauf danach: Wareneinsatz = tatsächlicher Einstand 211.520, Lager 0 (${saldo(db, 'COGS')})`);
  ok(buchAusgeglichen(db), 'A Hauptbuch ausgeglichen');
}

// ══ B — nach dem Verkauf (Zero): Rechnungszeile berichtigt ══════════════════════════
let dbB: Db; let oidB = ''; let settledB = '';
{
  const db = freshDb(); dbB = db;
  const oid = anlegen(ORD2); oidB = oid;
  const out = umwandeln(oid);
  const pid = payableOf(db, oid);
  const b = settle(pid, 4.33, 44);
  settledB = b.settlementId;
  const il = rows(db, 'SELECT purchase_price_snapshot, vat_amount, line_total FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])[0];
  ok(b.difference === 5.52 && b.invoiceLineCorrected && Number(il.purchase_price_snapshot) === 215.52 && Number(il.vat_amount) === 0 && Number(il.line_total) === 240,
    `B Differenz +5.520 berichtigt die Rechnungszeile: Einstand 215.520, Zero bleibt 0, Preis 240 (${S(il)})`);
  ok(saldo(db, 'COGS') === 215.52 && saldo(db, 'INVENTORY') === 0 && saldo(db, 'GOLD_LIABILITY') === 0 && saldo(db, 'REVENUE') === -240,
    `B Wareneinsatz 215.520, Lager 0, Goldschuld-Wert 0, Umsatz unverändert (${saldo(db, 'COGS')}/${saldo(db, 'INVENTORY')})`);
  const pp = n(db, 'SELECT purchase_price FROM products WHERE id = ?', [out.productIds[0]]);
  const ms = r3(n(db, 'SELECT margin_snapshot FROM invoices WHERE id = ?', [out.invoiceId]));
  ok(pp === 215.52 && ms === 24.48, `B Artikel-Einstand und Rechnungs-Marge folgen (24.480) (${pp}/${ms})`);
  const st = rows(db, 'SELECT old_unit_cost, new_unit_cost, invoice_line_id FROM gold_payable_settlements WHERE id = ?', [b.settlementId])[0];
  ok(Number(st.old_unit_cost) === 210 && Number(st.new_unit_cost) === 215.52 && !!st.invoice_line_id, `B die Begleichung hält alte/neue Werte fest (${S(st)})`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'invoice_lines' AND field_name = 'cost_correction_order_gold'") === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'gold_payable_settlements'") >= 1,
  'B protokolliert (Rechnungszeile + Begleichung)');
  ok(buchAusgeglichen(db), 'B Hauptbuch ausgeglichen');
}

// ══ E — Rücknahme (an B) ════════════════════════════════════════════════════════════
{
  const db = dbB;
  setTestDatabase(db as never); reload();
  const r = imHaus(() => goldSettle.reverseOrderGoldSettlement(ACTOR, settledB));
  ok(r.settlementId === settledB && s(db, 'SELECT status FROM gold_payable_settlements WHERE id = ?', [settledB]) === 'REVERSED'
    && s(db, 'SELECT status FROM gold_payables WHERE source_order_id = ?', [oidB]) === 'OPEN'
    && n(db, 'SELECT fulfilled_grams FROM gold_payables WHERE source_order_id = ?', [oidB]) === 0,
  'E zurückgenommen: Schuld wieder offen');
  ok(saldo(db, 'COGS') === 210 && saldo(db, 'GOLD_LIABILITY') === -185 && saldo(db, 'INVENTORY') === 0
    && n(db, "SELECT purchase_price_snapshot FROM invoice_lines WHERE product_id = (SELECT product_id FROM orders WHERE id = ?)", [oidB]) === 210
    && s(db, "SELECT status FROM expenses WHERE related_module = 'gold_payable'") === 'CANCELLED',
  `E alles genau zurück: Wareneinsatz 210, Goldschuld-Wert 185, Rechnungszeile 210, Ausgabe storniert (${saldo(db, 'COGS')}/${saldo(db, 'GOLD_LIABILITY')})`);
  // Bezahlte Begleichung: Nein.
  const b2 = settle(payableOf(db, oidB), 1, 40);
  const expId = String(one(db, 'SELECT expense_id FROM gold_payable_settlements WHERE id = ?', [b2.settlementId]));
  db.run('UPDATE expenses SET paid_amount = 10 WHERE id = ?', [expId]);
  ok(nein(() => imHaus(() => goldSettle.reverseOrderGoldSettlement(ACTOR, b2.settlementId))) === 'SETTLEMENT_PAID', 'E bezahlte Begleichung: Rücknahme abgelehnt');
  ok(buchAusgeglichen(db), 'E Hauptbuch ausgeglichen');
}

// ══ C — nach dem Verkauf (Margin): Margin-VAT neu ═══════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen(ORD2);
  const line = String(one(db, "SELECT id FROM order_lines WHERE order_id = ? AND material_kind = 'custom'", [oid]));
  const out = umwandeln(oid, { taxSchemes: { [line]: 'MARGIN' } });
  ok(r3(n(db, 'SELECT vat_amount FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])) === 2.727 && saldo(db, 'MARGIN_VAT') === -2.727,
    'C Margin vorher: VAT 2.727 aus 240 − 210');
  settle(payableOf(db, oid), 4.33, 44);
  const il = rows(db, 'SELECT vat_amount, purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [out.invoiceId])[0];
  ok(r3(Number(il.vat_amount)) === 2.225 && Number(il.purchase_price_snapshot) === 215.52 && saldo(db, 'MARGIN_VAT') === -2.225 && saldo(db, 'REVENUE') === -237.775,
    `C Margin nachher: VAT aus 240 − 215.520 = 2.225, Umsatz 237.775 (${S(il)} / ${saldo(db, 'MARGIN_VAT')} / ${saldo(db, 'REVENUE')})`);
  const q = [...liveVatQuarters('branch-main').values()].reduce((s2, x) => s2 + x.marginVat, 0);
  ok(Math.abs(q - 2.225) < 0.0015, `C VAT-Übersicht (NBR-Regel) zeigt die neue Margin-VAT (${q})`);
  ok(n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [out.invoiceId]) === 2.225, 'C Rechnungskopf folgt');
  ok(buchAusgeglichen(db), 'C Hauptbuch ausgeglichen');
}

// ══ D — gesperrtes Quartal nach dem Verkauf ═════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen(ORD2);
  umwandeln(oid);
  db.run("INSERT INTO vat_filings (id, branch_id, year, quarter, filed_at, snapshot_json, created_at) VALUES ('f1','branch-main',2026,4,?,'{}',?)", [NOW, NOW]);
  const vorher = { l: n(db, 'SELECT COUNT(*) FROM ledger_entries'), e: n(db, 'SELECT COUNT(*) FROM expenses') };
  const r = nein(() => settle(payableOf(db, oid), 4.33, 44));
  ok(/VAT_PERIOD_FILED/.test(r) && n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher.l && n(db, 'SELECT COUNT(*) FROM expenses') === vorher.e
    && s(db, 'SELECT status FROM gold_payables WHERE source_order_id = ?', [oid]) === 'OPEN',
  `D eingereichtes Quartal: Begleichung abgelehnt, nichts geändert (${r})`);
}

// ══ F — Eingaben und Altbestand ═════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const pid = payableOf(db, oid);
  ok(nein(() => settle(pid, 5, 44)) === 'GOLD_OVER_SETTLEMENT', 'F mehr Gramm als offen: Nein');
  ok(nein(() => settle(pid, 1, 0)) === 'GOLD_RATE_INVALID', 'F ohne Kurs: Nein');
  ok(nein(() => settle(pid, 1, 44, '2099-01-01')) === 'SETTLEMENT_DATE_INVALID', 'F künftiger Tag: Nein');
  db.run('UPDATE gold_payables SET book_value = NULL WHERE id = ?', [pid]);
  ok(nein(() => settle(pid, 1, 44)) === 'GOLD_DEBT_NOT_VALUED', 'F Goldschuld ohne gebuchten Wert (Altbestand): Nein');
}

// ══ G — alte Wege gesperrt (C1) ════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const pid = payableOf(db, oid);
  for (const mode of ['return_gold', 'shop_gold', 'money'] as const) {
    const r = nein(() => imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: pid, mode, grams: 1, agreedBhd: 10 })));
    ok(r === (mode === 'return_gold' ? 'GOLD_RETURN_NOT_A_SETTLEMENT' : 'ORDER_GOLD_DEBT_SETTLE_IN_BHD'), `G Order-Goldschuld, alte Art ${mode}: Nein (${r})`);
  }
  db.run(`INSERT INTO gold_payables (id, branch_id, supplier_id, direction, weight_grams, karat, settlement_type, fulfilled_grams, status, created_at, updated_at)
          VALUES ('gp-rep','branch-main','sup-arup','we_owe',3,'21K','return_gold',0,'OPEN',?,?)`, [NOW, NOW]);
  const vorrat = n(db, 'SELECT COUNT(*) FROM precious_metals');
  ok(nein(() => imHaus(() => goldCore.settleGoldPayable(ACTOR, { payableId: 'gp-rep', mode: 'return_gold', grams: 1 }))) === 'GOLD_RETURN_NOT_A_SETTLEMENT'
    && n(db, 'SELECT COUNT(*) FROM precious_metals') === vorrat,
  'G auch eine Reparatur-Goldschuld wird nicht durch „Return gold" erfüllt (kein Zugang zum eigenen Bestand)');
  ok(s(db, "SELECT status FROM gold_payables WHERE id = 'gp-rep'") === 'OPEN', 'G …sie bleibt offen');
}

// ══ H — PC2 ══════════════════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0 });
  const pid = payableOf(db, oid);
  const rev = (): number => n(db, 'SELECT revision FROM gold_payables WHERE id = ?', [pid]);
  const alt = await fern(() => goldCmd.runGoldPayableSettle(deps(db), identity('40', 'gold.payables.settle'),
    { payableId: pid, expectedRevision: rev(), mode: 'money_order', grams: 1, ratePerGram: 44 }));
  ok(alt.ok && Number((alt.value as { amount?: number })?.amount) === 44, `H PC2 money_order: dieselbe Begleichung (${alt.code})`);
  const veraltet = await fern(() => goldCmd.runGoldPayableSettle(deps(db), identity('41', 'gold.payables.settle'),
    { payableId: pid, expectedRevision: 1, mode: 'money_order', grams: 1, ratePerGram: 44 }));
  ok(!veraltet.ok && veraltet.code === 'RECORD_CHANGED', `H PC2 mit alter Fassung: Nein (${veraltet.code})`);
  const sid = String((alt.value as { settlementId?: string })?.settlementId ?? '');
  const zur = await fern(() => goldCmd.runGoldPayableSettle(deps(db), identity('42', 'gold.payables.settle'),
    { payableId: pid, expectedRevision: rev(), mode: 'money_order_reverse', settlementId: sid }));
  ok(zur.ok && s(db, 'SELECT status FROM gold_payable_settlements WHERE id = ?', [sid]) === 'REVERSED', `H PC2 money_order_reverse (${zur.code})`);
  const verboten = await fern(() => goldCmd.runGoldPayableSettle(deps(db), identity('43', 'gold.payables.settle'),
    { payableId: pid, expectedRevision: rev(), mode: 'money_order', grams: 1, ratePerGram: 44, amount: 1 }));
  ok(!verboten.ok, `H PC2: ein Betrag vom Client wird nicht angenommen (${verboten.code})`);
  ok(buchAusgeglichen(db), 'H Hauptbuch ausgeglichen');
}

// ══ I — Löschen der Goldschuld ══════════════════════════════════════════════════════
{
  const db = freshDb();
  const oid = anlegen({ ...ORD2, depositAmount: 0, status: 'arrived' });
  const pid = payableOf(db, oid);
  settle(pid, 1, 44);
  ok(/already \(partly\) settled|GOLD_PAYABLE|settled/i.test(nein(() => imHaus(() => useGoldStore.getState().deleteGoldPayable(pid)))),
    'I eine teilweise beglichene Goldschuld wird nicht gelöscht');
}

console.log(`\nCUSTOM-ORDER Phase 1 K3a: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

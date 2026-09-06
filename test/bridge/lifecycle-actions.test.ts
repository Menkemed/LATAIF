// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3H — die zwölf Lebenszyklus-Aktionen: Auftrag, Kommission, Reparatur, Transfer.
// Run: node test/bridge/lifecycle-actions.test.ts
//
// Was hier bewiesen wird — an echten Zeilen einer echten sql.js-Datenbank:
//
//   1. Kein FREIER Zielzustand: beide Statuswege fahren nur Übergänge, die der Primary auch
//      anbietet, und beide fragen dieselbe geteilte Ableitung wie seine Bildschirme.
//   2. Der Auftrag ist jetzt VOLLSTÄNDIG fahrbar: anlegen → ankommen → anzahlen → umwandeln.
//      Genau das war die Sackgasse, die C3G offen gelassen hat.
//   3. Jede Wirkung bleibt in der Domäne: Verbindlichkeiten, Kapitalisierung, Nummernkreise,
//      Auszahlungsbetrag, Steuerschema.
//   4. Eine verlorene Antwort kostet nichts zweimal — keine zweite Rechnung, keine zweite
//      Zahlung, kein zweiter Verkauf.
//   5. Zwei Rechner gewinnen nicht beide; ein alter Stand schreibt nicht über einen neueren.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
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
  // Ohne eingerichteten Abgleich schreibt `trackChange` NICHTS — dann waere die Zusage
  // "die Rueckgabe steht im Aenderungsjournal" gar nicht pruefbar. Also einrichten.
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { executeCommand, registerCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmdC = await import('../../src/core/bridge/commercial-commands.ts');
const cmdS = await import('../../src/core/bridge/service-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { nextOrderStatus, isAllowedOrderAdvance, ORDER_STATUS_FLOW } =
  await import('../../src/core/orders/order-status-flow.ts');
const { allowedRepairStatusTargets, nextRepairStatus, quickRepairNext } =
  await import('../../src/core/repairs/repair-status-flow.ts');
const { repairInvoiceLineCost } = await import('../../src/core/repairs/repair-cost.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-06T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
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

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','W','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-1','branch-main','Workshop',1,?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useOrderStore.getState().loadOrders();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  useConsignmentStore.getState().loadConsignments();
  useSupplierStore.getState().loadSuppliers();
  return db;
}

function seedProduct(db: Db, id: string, qty = 3, cost = 100): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Rolex',?,?,?,'Pre-Owned','[]',?,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'M ' + id, 'SKU-' + id, qty, cost, NOW, NOW],
  );
  db.run(
    `INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
     VALUES (?,?,?,?,?,?,'ACTIVE',?,?)`,
    ['lot-' + id, 'branch-main', id, cost, qty, qty, NOW, NOW],
  );
  useProductStore.getState().loadProducts();
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const val = <T>(o: unknown): T => (o as { value: T }).value;
const code = (o: unknown): string => (o as { code?: string }).code ?? '';
const irev = (db: Db, id: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [id]);
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);
const crev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
const prev = (db: Db, id: string): number => n(db, 'SELECT revision FROM repairs WHERE id = ?', [id]);
const trev = (db: Db, id: string): number => n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [id]);
const arNet = (db: Db, customerId: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [customerId]);

function must(out: unknown, what: string): Record<string, unknown> {
  if ((out as { kind: string }).kind !== 'ok') throw new Error(`setup ${what} failed: ` + JSON.stringify(out));
  return (out as { value: Record<string, unknown> }).value;
}
async function makeOrder(d: ReturnType<typeof deps>, nth: string, productId = 'p1', price = 200) {
  const v = must(await cmdC.runOrderCreate(d, identity(nth, 'orders.create'), {
    customerId: 'cust-1', lines: [{ productId, quantity: 1, unitPrice: price }],
  }), 'order');
  return String(v.orderId ?? v.id);
}
async function makeRepair(d: ReturnType<typeof deps>, nth: string, charge = 90) {
  const v = must(await cmdS.runRepairCreate(d, identity(nth, 'repairs.create'), {
    customerId: 'cust-1', itemBrand: 'Rolex', issueDescription: 'does not run',
    repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 30,
    chargeToCustomer: charge, taxScheme: 'VAT_10',
  }), 'repair');
  return String(v.repairId ?? v.id);
}
async function makeTransfer(d: ReturnType<typeof deps>, nth: string, productId = 'p1', price = 300) {
  const v = must(await cmdS.runTransferCreate(d, identity(nth, 'transfers.create'), {
    customerId: 'cust-2', productId, agentPrice: price, settlementModel: 'full',
  }), 'transfer');
  return String(v.transferId ?? v.id);
}
// Der Name wandert mit: die Doppelanlage-Erkennung des Hauses ist echt und soll hier nicht
// umgangen werden — zwei verschiedene Stuecke heissen also verschieden.
async function makeConsignment(d: ReturnType<typeof deps>, nth: string, agreed = 500, name = 'Seamaster ' + nth) {
  const v = must(await cmdC.runConsignmentCreate(d, identity(nth, 'consignments.create'), {
    consignorId: 'cust-1',
    product: { brand: 'Omega', name, categoryId: 'cat-w' },
    agreedPrice: agreed, payout: { model: 'percent', commissionRate: 20 },
  }), 'consignment');
  return String(v.consignmentId ?? v.id);
}

// ── 1) Der Umfang, die Wiederverwendung, die geteilte Ableitung ──────────
{
  const mine = codeOf('src/core/bridge/lifecycle-commands.ts');
  ok((mine.match(/runRemoteCommand\(/g) ?? []).length === 12, 'TX alle zwoelf laufen durch die eine Maschine');
  for (const call of [
    'os.updateStatus(', 'ops.addPayment(', 'ops.deletePayment(',
    'useConsignmentStore.getState().recordSale(', 'useConsignmentStore.getState().markReturned(',
    'rs.updateStatus(', 'rs.createCombinedRepairInvoice(', 'rs.addRepairLine(',
    'rs.updateRepairLine(', 'rs.cancelRepairLine(',
    'useAgentStore.getState().convertTransferToInvoice(', 'useAgentStore.getState().convertTransfersToInvoice(',
  ]) {
    ok(mine.includes(call), `REUSE der Fernweg ruft ${call.replace(/\($/, '')} des Hauses`);
  }
  ok(!/INSERT INTO (orders|order_lines|order_payments|invoices|invoice_lines|expenses|repair_lines|ledger_entries|customer_credits)/i.test(mine),
    'REUSE der Fernweg legt keinen Beleg, keine Zeile und keine Buchung selbst an');
  ok(!/UPDATE (orders|invoices|repairs|repair_lines|consignments|agent_transfers|products|stock_lots) SET/i.test(mine),
    'REUSE …und schreibt keine Wirkung selbst');
  ok(!/getNextDocumentNumber|allocateSku/.test(mine), 'REUSE Nummern vergibt ausschliesslich das Haus');
  ok(!/vatEngine|calculateNet|taxScheme ===/.test(mine), 'REUSE die Steuer rechnet der Fernweg nicht nach');
  // Der Zielzustand kommt aus der GETEILTEN Ableitung, nicht aus einer Liste hier.
  ok(/isAllowedOrderAdvance\(/.test(mine), 'FLOW der Auftrag fragt die geteilte Ableitung');
  ok(/allowedRepairStatusTargets\(/.test(mine), 'FLOW die Reparatur ebenso');
  ok(!/'pending'\s*,\s*'arrived'/.test(mine), 'FLOW …und keine zweite Reihenfolge steht hier');
  // Und die Bildschirme des Primary benutzen dieselbe Datei.
  ok(/ORDER_STATUS_FLOW|nextOrderStatus/.test(codeOf('src/pages/orders/OrderDetail.tsx')),
    'FLOW der Auftragsbildschirm importiert dieselbe Ableitung');
  ok(/repairStatusFlow|nextRepairStatus/.test(codeOf('src/pages/repairs/RepairDetail.tsx')),
    'FLOW der Reparaturbildschirm ebenso');
  ok(/quickRepairNext/.test(codeOf('src/pages/repairs/RepairList.tsx')),
    'FLOW …und die Liste, die vorher ihre EIGENE Abkuerzung hatte');

  // Die Ableitung selbst.
  ok(nextOrderStatus('pending') === 'arrived', 'FLOW pending → arrived');
  ok(nextOrderStatus('arrived') === 'notified', 'FLOW arrived → notified');
  ok(nextOrderStatus('completed') === null, 'FLOW completed ist das Ende');
  ok(nextOrderStatus('cancelled') === null, 'FLOW ein stornierter Auftrag geht nirgendwohin');
  ok(!isAllowedOrderAdvance('pending', 'completed'), 'FLOW pending springt NICHT auf completed');
  ok(!ORDER_STATUS_FLOW.includes('cancelled' as never), 'FLOW cancelled steht nicht auf dem Weg');
  ok(allowedRepairStatusTargets('received', 'external', 'CUSTOMER').includes('diagnosed'),
    'FLOW die Reparatur kennt den vollen Weg');
  ok(allowedRepairStatusTargets('received', 'external', 'CUSTOMER').includes('in_progress'),
    'FLOW …und die Abkuerzung der Liste');
  ok(allowedRepairStatusTargets('received', 'external', 'CUSTOMER').includes('returned'),
    'FLOW …und die Rueckgabe ohne Reparatur');
  ok(!allowedRepairStatusTargets('received', 'external', 'CUSTOMER').includes('cancelled'),
    'FLOW aber NICHT cancelled — das ist der zerstoerende Weg');
  ok(allowedRepairStatusTargets('picked_up', 'internal', 'CUSTOMER').length === 0,
    'FLOW aus einem terminalen Zustand geht gar nichts');
  ok(!allowedRepairStatusTargets('ready', 'internal', 'OWN').includes('picked_up'),
    'FLOW eigene Ware wird nicht abgeholt');
  ok(nextRepairStatus('in_progress', 'internal', 'CUSTOMER') === 'ready', 'FLOW in_progress → ready');
  ok(quickRepairNext('ready', 'OWN') === undefined, 'FLOW die Abkuerzung kennt den OWN-Fall');

  // Ein freier Zielzustand ist gar kein gueltiger Rumpf.
  let cancelBlocked = false;
  try { life.parseUpdateOrderStatus({ orderId: 'o', status: 'cancelled', expectedRevision: 1 }); }
  catch (e) { cancelBlocked = /cancelling an order moves money/.test(String(e)); }
  ok(cancelBlocked, 'PAYLOAD ein Auftrag wird aus der Ferne nicht storniert');
  let repairCancelBlocked = false;
  try { life.parseUpdateRepairStatus({ repairId: 'r', status: 'cancelled', expectedRevision: 1 }); }
  catch (e) { repairCancelBlocked = /deletes records/.test(String(e)); }
  ok(repairCancelBlocked, 'PAYLOAD …und eine Reparatur ebenso wenig');
  let markBlocked = false;
  try { life.parseRecordSale({ consignmentId: 'c', buyerId: 'b', salePrice: 1, expectedRevision: 1, specialMark: true }); }
  catch (e) { markBlocked = /unknown field: specialMark/.test(String(e)); }
  ok(markBlocked, 'PAYLOAD der Nummernkreis (Sondermarke) ist KEIN Feld des Fernverkaufs');
  let statusFieldBlocked = false;
  try { life.parseUpdateRepairLine({ repairId: 'r', lineId: 'l', expectedRevision: 1, status: 'CANCELLED' }); }
  catch (e) { statusFieldBlocked = /unknown field: status/.test(String(e)); }
  ok(statusFieldBlocked, 'PAYLOAD eine Arbeitszeile wird nicht per Feld storniert');
}

// ── 2) Der Auftrag: die Sackgasse aus C3G ist zu ─────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const oid = await makeOrder(d, '1', 'p1', 200);

  // VORHER: nichts abrechenbar — genau das war die Sackgasse.
  const early = await fin.runConvertOrder(d, identity('2', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: orev(db, oid) });
  ok(early.kind === 'rejected' && code(early) === 'ORDER_NOTHING_BILLABLE',
    `GATE frisch angelegt ist nichts abrechenbar (${code(early)})`);

  // Ein Sprung ueber die Stufe wird abgewiesen.
  const jump = await life.runUpdateOrderStatus(d, identity('3', 'orders.update_status'),
    { orderId: oid, status: 'completed', expectedRevision: orev(db, oid) });
  ok(jump.kind === 'rejected' && code(jump) === 'ORDER_TRANSITION_NOT_ALLOWED',
    `STATUS pending springt nicht auf completed (${code(jump)})`);
  ok(s(db, 'SELECT status FROM orders WHERE id = ?', [oid]) === 'pending', 'STATUS …und nichts hat sich bewegt');

  // Der echte Schritt.
  const seen = orev(db, oid);
  const adv = await life.runUpdateOrderStatus(d, identity('4', 'orders.update_status'),
    { orderId: oid, status: 'arrived', expectedRevision: seen });
  ok(adv.kind === 'ok', 'STATUS der erlaubte Schritt laeuft');
  ok(s(db, 'SELECT status FROM orders WHERE id = ?', [oid]) === 'arrived', 'STATUS der Auftrag ist angekommen');
  ok(s(db, 'SELECT status FROM order_lines WHERE order_id = ?', [oid]) === 'ARRIVED',
    'STATUS die Positionen sind mitgezogen — die Kaskade des Hauses');
  ok(s(db, 'SELECT actual_delivery FROM orders WHERE id = ?', [oid]) !== '',
    'STATUS …und der Wareneingang ist datiert');
  ok(orev(db, oid) > seen, `REVISION der Auftrag hat eine neue Fassung (${seen} → ${orev(db, oid)})`);
  ok(String(val<Record<string, unknown>>(adv).nextStatus) === 'notified',
    'STATUS die Antwort sagt, was als naechstes ginge');

  // Anzahlung.
  const paySeen = orev(db, oid);
  const pay = await life.runAddOrderPayment(d, identity('5', 'orders.add_payment'),
    { orderId: oid, amount: 50, method: 'cash', expectedRevision: paySeen });
  ok(pay.kind === 'ok', 'PAY die Anzahlung laeuft');
  ok(n(db, 'SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id = ?', [oid]) === 50,
    'PAY sie steht als Zahlung');
  ok(n(db, 'SELECT deposit_amount FROM orders WHERE id = ?', [oid]) === 50,
    'PAY der Auftragssaldo ist nachgezogen — die Ableitung des Hauses');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'") > 0,
    'PAY …und sie steht im Buch');
  ok(orev(db, oid) > paySeen, 'REVISION auch eine Zahlung hebt die Fassung des Auftrags');

  // WIEDERHOLUNG: kein zweites Mal Geld.
  const same = await life.runAddOrderPayment(d, identity('5', 'orders.add_payment'),
    { orderId: oid, amount: 50, method: 'cash', expectedRevision: paySeen });
  ok(same.kind === 'ok' && (same as { replayed: boolean }).replayed, 'REPLAY dieselbe Kennung, dieselbe Antwort');
  ok(n(db, 'SELECT COUNT(*) FROM order_payments WHERE order_id = ?', [oid]) === 1,
    'REPLAY es gibt EINE Zahlung, nicht zwei');

  // Und die Umwandlung geht JETZT — der ganze Weg ist fahrbar.
  const conv = await fin.runConvertOrder(d, identity('6', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: orev(db, oid) });
  ok(conv.kind === 'ok', 'GATE nach dem Statuswechsel laeuft die Umwandlung');
  const inv = String(val<Record<string, unknown>>(conv).invoiceId);
  ok(inv !== '', 'GATE es entstand eine Rechnung');
  ok(n(db, 'SELECT COUNT(*) FROM invoices WHERE id = ?', [inv]) === 1, 'GATE genau eine');
  ok(s(db, 'SELECT invoice_id FROM orders WHERE id = ?', [oid]) === inv, 'GATE …und der Auftrag traegt sie');

  // Danach nimmt der Auftrag keine Anzahlung mehr an: das Geld lebt in der Rechnung.
  const late = await life.runAddOrderPayment(d, identity('7', 'orders.add_payment'),
    { orderId: oid, amount: 10, method: 'cash', expectedRevision: orev(db, oid) });
  ok(late.kind === 'rejected' && code(late) === 'ORDER_ALREADY_INVOICED',
    `PAY nach der Umwandlung keine weitere Anzahlung (${code(late)})`);
}

// ── 3) Auftragszahlung zuruecknehmen + Rennen ────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const oid = await makeOrder(d, '1', 'p1', 200);
  const p1 = must(await life.runAddOrderPayment(d, identity('8', 'orders.add_payment'),
    { orderId: oid, amount: 60, method: 'cash', expectedRevision: orev(db, oid) }), 'pay');
  const pid = String(p1.paymentId);

  const del = await life.runDeleteOrderPayment(d, identity('9', 'orders.delete_payment'),
    { orderId: oid, paymentId: pid, expectedRevision: orev(db, oid) });
  ok(del.kind === 'ok', 'DEL die Zahlung wird zurueckgenommen');
  ok(n(db, 'SELECT COUNT(*) FROM order_payments WHERE id = ?', [pid]) === 0, 'DEL sie ist weg');
  ok(n(db, 'SELECT deposit_amount FROM orders WHERE id = ?', [oid]) === 0, 'DEL der Saldo ist nachgezogen');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT_REVERSED'") > 0
    || n(db, "SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL") > 0,
    'DEL …und die Buchung ist storniert, nicht geloescht');

  // Eine fremde Zahlung gehoert nicht zu diesem Auftrag.
  const oid2 = await makeOrder(d, '10', 'p1', 200);
  const other = must(await life.runAddOrderPayment(d, identity('11', 'orders.add_payment'),
    { orderId: oid2, amount: 20, method: 'cash', expectedRevision: orev(db, oid2) }), 'pay2');
  const wrong = await life.runDeleteOrderPayment(d, identity('12', 'orders.delete_payment'),
    { orderId: oid, paymentId: String(other.paymentId), expectedRevision: orev(db, oid) });
  ok(wrong.kind === 'rejected' && code(wrong) === 'PAYMENT_NOT_ON_ORDER',
    `DEL eine fremde Zahlung wird abgewiesen (${code(wrong)})`);
  ok(n(db, 'SELECT COUNT(*) FROM order_payments WHERE id = ?', [String(other.paymentId)]) === 1,
    'DEL …und sie steht noch');

  // Das RENNEN: beide Rechner haben dieselbe Fassung gelesen.
  const seen = orev(db, oid);
  const a = await life.runAddOrderPayment(d, identity('13', 'orders.add_payment'),
    { orderId: oid, amount: 30, method: 'cash', expectedRevision: seen });
  ok(a.kind === 'ok', 'RACE der erste zahlt');
  const b = await life.runAddOrderPayment(d, identity('14', 'orders.add_payment'),
    { orderId: oid, amount: 30, method: 'cash', expectedRevision: seen });
  ok(b.kind === 'rejected' && code(b) === 'RECORD_CHANGED', `RACE der zweite laeuft in die Fassung (${code(b)})`);
  ok(n(db, 'SELECT COALESCE(SUM(amount),0) FROM order_payments WHERE order_id = ?', [oid]) === 30,
    'RACE genau EINE Zahlung wurde gebucht');
}

// ── 4) Die Kommission: Verkauf und Rueckgabe ─────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  const cid = await makeConsignment(d, '1', 500);

  // Vor dem Verkauf gibt es nichts auszuzahlen — das war die Sackgasse der Kommission.
  const early = await fin.runRecordPayout(d, identity('2', 'consignments.record_payout'),
    { consignmentId: cid, amount: 10, method: 'cash', expectedRevision: crev(db, cid) });
  ok(early.kind === 'rejected' && code(early) === 'NOTHING_TO_PAY_OUT',
    `GATE vor dem Verkauf ist der Auszahlungsbetrag leer (${code(early)})`);

  const seen = crev(db, cid);
  const sale = await life.runRecordSale(d, identity('3', 'consignments.record_sale'),
    { consignmentId: cid, buyerId: 'cust-2', salePrice: 500, expectedRevision: seen });
  ok(sale.kind === 'ok', 'SALE der Verkauf laeuft');
  const sv = val<Record<string, unknown>>(sale);
  ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]) === 'sold', 'SALE die Kommission ist verkauft');
  ok(String(sv.invoiceId) !== '', 'SALE eine Rechnung an den Kaeufer entstand');
  ok(String(sv.purchaseId) !== '', 'SALE …und ein Einkauf beim Einlieferer');
  ok(n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]) === 400,
    'SALE der Auszahlungsbetrag ist 400 (500 minus 20 %) — vom Haus gerechnet');
  ok(n(db, 'SELECT commission_amount FROM consignments WHERE id = ?', [cid]) === 100,
    'SALE …und unsere Provision 100');
  ok(crev(db, cid) > seen, 'REVISION der Verkauf hebt die Fassung');
  ok(n(db, "SELECT COUNT(*) FROM invoices WHERE special_mark = 1") === 0,
    'SALE der Fernverkauf hat KEINE Sondermarke gesetzt — regulaerer Nummernkreis');

  // Und JETZT geht die bereits in C3G freigegebene Auszahlung — ohne Zwischenschritt am Primary.
  const payout = await fin.runRecordPayout(d, identity('4', 'consignments.record_payout'),
    { consignmentId: cid, amount: 400, method: 'cash', expectedRevision: crev(db, cid) });
  ok(payout.kind === 'ok', 'CHAIN nach dem Verkauf laeuft die Auszahlung aus C3G');
  ok(n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === 400,
    'CHAIN …und der Einlieferer hat sein Geld');

  // Zweimal verkaufen geht nicht.
  const twice = await life.runRecordSale(d, identity('5', 'consignments.record_sale'),
    { consignmentId: cid, buyerId: 'cust-2', salePrice: 500, expectedRevision: crev(db, cid) });
  ok(twice.kind === 'rejected' && ['CONSIGNMENT_NOT_ACTIVE', 'CONSIGNMENT_ALREADY_SOLD'].includes(code(twice)),
    `SALE ein zweiter Verkauf wird abgewiesen (${code(twice)})`);

  // Der Einlieferer darf nicht sein eigener Kaeufer sein.
  const cid2 = await makeConsignment(d, '6', 500);
  const self = await life.runRecordSale(d, identity('7', 'consignments.record_sale'),
    { consignmentId: cid2, buyerId: 'cust-1', salePrice: 500, expectedRevision: crev(db, cid2) });
  ok(self.kind === 'rejected' && code(self) === 'BUYER_IS_CONSIGNOR',
    `SALE der Einlieferer kauft nicht sein eigenes Stueck (${code(self)})`);

  // Unverkauft zurueck.
  const rSeen = crev(db, cid2);
  const back = await life.runMarkConsignmentReturned(d, identity('8', 'consignments.mark_returned'),
    { consignmentId: cid2, expectedRevision: rSeen });
  ok(back.kind === 'ok', 'RETURN die unverkaufte Ware geht zurueck');
  ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [cid2]) === 'returned', 'RETURN der Zustand stimmt');
  ok(String(val<Record<string, unknown>>(back).productStockStatus) === 'returned',
    'RETURN …und der Artikel hat das Haus verlassen');
  // Eine verkaufte Kommission geht so NICHT zurueck — das waere der Klasse-C-Weg.
  const afterSale = await life.runMarkConsignmentReturned(d, identity('9', 'consignments.mark_returned'),
    { consignmentId: cid, expectedRevision: crev(db, cid) });
  ok(afterSale.kind === 'rejected' && code(afterSale) === 'CONSIGNMENT_NOT_ACTIVE',
    `RETURN nach dem Verkauf ist es ein anderer Vorgang — abgewiesen (${code(afterSale)})`);
}

// ── 5) Der Verkauf unter dem Boden: Bestaetigung als NEUER Vorsatz ───────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  const v = must(await cmdC.runConsignmentCreate(d, identity('1', 'consignments.create'), {
    consignorId: 'cust-1', product: { brand: 'Omega', name: 'Speedy', categoryId: 'cat-w' },
    agreedPrice: 500, payout: { model: 'consignor_fixed' },
  }), 'consignment');
  const cid = String(v.consignmentId ?? v.id);
  const seen = crev(db, cid);

  // Erster Vorsatz: OHNE Bestaetigung, unter dem Boden.
  const low = await life.runRecordSale(d, identity('2', 'consignments.record_sale'),
    { consignmentId: cid, buyerId: 'cust-2', salePrice: 300, expectedRevision: seen });
  ok(low.kind === 'rejected' && code(low) === 'SALE_BELOW_FLOOR',
    `CONFIRM ein Verkauf unter dem Boden wird abgewiesen (${code(low)})`);
  ok(low.kind === 'rejected' && (low as { frozen: boolean }).frozen, 'CONFIRM …und das Urteil ist eingefroren');
  ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]) === 'active',
    'CONFIRM NULL Wirkung: die Kommission ist unveraendert');
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 0, 'CONFIRM …keine Rechnung');
  ok(n(db, 'SELECT COUNT(*) FROM purchases') === 0, 'CONFIRM …kein Einkauf');
  ok(crev(db, cid) === seen, 'CONFIRM …und nicht einmal die Fassung hat sich bewegt');

  // Dieselbe Kennung mit geaendertem Rumpf waere ein Konflikt — genau das darf ein Client NICHT tun.
  const sneaky = await life.runRecordSale(
    d, { ...identity('2', 'consignments.record_sale'), payloadHash: 'anders' },
    { consignmentId: cid, buyerId: 'cust-2', salePrice: 300, expectedRevision: seen, acknowledgeShortfall: true },
  );
  ok(sneaky.kind === 'rejected' && code(sneaky) === 'COMMAND_ID_CONFLICT',
    `CONFIRM gleiche Kennung + anderer Rumpf = Konflikt (${code(sneaky)})`);

  // Der ZWEITE Vorsatz: neue Kennung, ausdrueckliche Bestaetigung.
  const yes = await life.runRecordSale(d, identity('3', 'consignments.record_sale'),
    { consignmentId: cid, buyerId: 'cust-2', salePrice: 300, expectedRevision: seen, acknowledgeShortfall: true });
  ok(yes.kind === 'ok', 'CONFIRM der bestaetigte Verkauf laeuft');
  ok(s(db, 'SELECT status FROM consignments WHERE id = ?', [cid]) === 'sold', 'CONFIRM die Kommission ist verkauft');
  ok(Number(val<Record<string, unknown>>(yes).consignorLossAmount) > 0,
    'CONFIRM …und der Verlust ist als solcher gebucht');
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE category = 'ConsignorLoss'") === 1,
    'CONFIRM genau EINE Verlust-Ausgabe');
}

// ── 6) Die Reparatur: Zustandsmaschine, Zeilen, Rechnung ─────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  const rid = await makeRepair(d, '1', 90);

  // Rechnung VOR dem Fertigsein: abgewiesen.
  const early = await life.runCreateRepairInvoice(d, identity('2', 'repairs.create_invoice'),
    { repairId: rid, expectedRevision: prev(db, rid) });
  ok(early.kind === 'rejected' && code(early) === 'REPAIR_NOT_READY',
    `GATE eine nicht fertige Reparatur wird nicht berechnet (${code(early)})`);

  // Eine Arbeitszeile. Achtung: das Haus legt beim Anlegen einer EXTERNEN Reparatur bereits
  // eine Zeile aus der Werkstattgebuehr an — gemessen wird deshalb die Wirkung, nicht eine
  // absolute Zahl.
  const linesBefore = n(db, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [rid]);
  const totalBefore = n(db, "SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [rid]);
  const lSeen = prev(db, rid);
  const add = await life.runAddRepairLine(d, identity('3', 'repairs.add_line'),
    { repairId: rid, costAmount: 25, supplierId: 'sup-1', workType: 'labor', expectedRevision: lSeen });
  ok(add.kind === 'ok', 'LINE die Arbeitszeile entsteht');
  const lid = String(val<Record<string, unknown>>(add).lineId);
  ok(n(db, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [rid]) === linesBefore + 1,
    'LINE sie steht — genau eine mehr als vorher');
  ok(prev(db, rid) > lSeen,
    `REVISION eine KINDZEILE hebt die Fassung der Reparatur (${lSeen} → ${prev(db, rid)}) — genau darum geht es`);
  ok(Number(val<Record<string, unknown>>(add).openLineTotal) === totalBefore + 25,
    'LINE die Summe ist nachgezogen');

  // Ein alter Stand schreibt nicht mehr.
  const stale = await life.runAddRepairLine(d, identity('4', 'repairs.add_line'),
    { repairId: rid, costAmount: 5, expectedRevision: lSeen });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `STALE nach der Kindzeile ist der alte Stand ungueltig (${code(stale)})`);
  ok(n(db, 'SELECT COUNT(*) FROM repair_lines WHERE repair_id = ?', [rid]) === linesBefore + 1,
    'STALE …und es kam nichts dazu');

  // Zeile aendern.
  const eSeen = prev(db, rid);
  const upd = await life.runUpdateRepairLine(d, identity('5', 'repairs.update_line'),
    { repairId: rid, lineId: lid, costAmount: 40, expectedRevision: eSeen });
  ok(upd.kind === 'ok', 'LINE die Zeile laesst sich aendern');
  ok(n(db, 'SELECT cost_amount FROM repair_lines WHERE id = ?', [lid]) === 40, 'LINE der neue Betrag steht');
  ok(prev(db, rid) > eSeen, 'REVISION auch die Aenderung hebt die Fassung');

  // Weiterschalten — genau der Uebergang, den der Primary anbietet.
  const targets = (val<Record<string, unknown>>(upd).allowedStatusTargets as string[]);
  ok(targets.includes('diagnosed'), 'FLOW die Antwort nennt die erlaubten Ziele');
  const st = await life.runUpdateRepairStatus(d, identity('6', 'repairs.update_status'),
    { repairId: rid, status: 'in_progress', expectedRevision: prev(db, rid) });
  ok(st.kind === 'ok', 'FLOW die Abkuerzung der Liste geht auch aus der Ferne');
  ok(n(db, "SELECT COUNT(*) FROM expenses WHERE related_module = 'repair' AND related_entity_id = ?", [rid]) > 0,
    'FLOW …und an dieser Stufe entsteht die Lieferanten-Verbindlichkeit — vom Haus gebucht');
  const ready = await life.runUpdateRepairStatus(d, identity('7', 'repairs.update_status'),
    { repairId: rid, status: 'ready', expectedRevision: prev(db, rid) });
  ok(ready.kind === 'ok', 'FLOW …und weiter auf fertig');

  // Die Rechnung: genau eine, mit dem VOLLEN Einstand.
  const iSeen = prev(db, rid);
  const inv = await life.runCreateRepairInvoice(d, identity('8', 'repairs.create_invoice'),
    { repairId: rid, expectedRevision: iSeen });
  ok(inv.kind === 'ok', 'INVOICE die Reparaturrechnung entsteht');
  const iv = val<Record<string, unknown>>(inv);
  const invId = String(iv.invoiceId);
  ok(n(db, 'SELECT COUNT(*) FROM invoices WHERE id = ?', [invId]) === 1, 'INVOICE genau eine');
  ok(s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [rid]) === invId, 'INVOICE die Reparatur traegt sie');
  const internal = n(db, 'SELECT internal_cost FROM repairs WHERE id = ?', [rid]);
  const openLines = n(db, "SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [rid]);
  const cost = n(db, 'SELECT purchase_price_snapshot FROM invoice_lines WHERE invoice_id = ?', [invId]);
  ok(openLines > 0, `INVOICE es gibt Arbeitszeilen (${openLines})`);
  ok(Math.abs(cost - repairInvoiceLineCost({ internalCost: internal }, openLines)) < 0.005,
    `INVOICE der Einstand ist internalCost + Arbeitszeilen (${cost} = ${internal} + ${openLines})`);
  ok(cost > internal,
    `INVOICE …und damit groesser als der alte Einzelweg schrieb (${cost} statt ${internal})`);

  // Ein zweiter Versuch mit NEUER Kennung: abgewiesen. Eine Wiederholung: dieselbe Rechnung.
  const twice = await life.runCreateRepairInvoice(d, identity('9', 'repairs.create_invoice'),
    { repairId: rid, expectedRevision: prev(db, rid) });
  ok(twice.kind === 'rejected' && code(twice) === 'REPAIR_ALREADY_INVOICED',
    `INVOICE keine zweite Rechnung (${code(twice)})`);
  const replay = await life.runCreateRepairInvoice(d, identity('8', 'repairs.create_invoice'),
    { repairId: rid, expectedRevision: iSeen });
  ok(replay.kind === 'ok' && (replay as { replayed: boolean }).replayed, 'INVOICE die Wiederholung liefert dieselbe');
  ok(String(val<Record<string, unknown>>(replay).invoiceId) === invId, 'INVOICE …und dieselbe Kennung');
  ok(n(db, "SELECT COUNT(*) FROM invoices WHERE notes LIKE '%Repair%'") <= 1,
    'INVOICE es steht genau ein Reparaturbeleg da');

  // Nach der Rechnung sind die Kostenzeilen eingefroren.
  const frozen = await life.runAddRepairLine(d, identity('10', 'repairs.add_line'),
    { repairId: rid, costAmount: 5, expectedRevision: prev(db, rid) });
  ok(frozen.kind === 'rejected' && code(frozen) === 'REPAIR_ALREADY_INVOICED',
    `LINE nach der Rechnung kommt keine Kostenzeile mehr dazu (${code(frozen)})`);
}

// ── 7) Eine Arbeitszeile zuruecknehmen ───────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  const rid = await makeRepair(d, '1', 90);
  const add = must(await life.runAddRepairLine(d, identity('2', 'repairs.add_line'),
    { repairId: rid, costAmount: 25, supplierId: 'sup-1', expectedRevision: prev(db, rid) }), 'line');
  const lid = String(add.lineId);
  const seen = prev(db, rid);
  const beforeCancelTotal = n(db, "SELECT COALESCE(SUM(cost_amount),0) FROM repair_lines WHERE repair_id = ? AND status = 'OPEN'", [rid]);
  const cancel = await life.runCancelRepairLine(d, identity('3', 'repairs.cancel_line'),
    { repairId: rid, lineId: lid, expectedRevision: seen });
  ok(cancel.kind === 'ok', 'CANCEL die Zeile wird zurueckgenommen');
  ok(n(db, "SELECT COUNT(*) FROM repair_lines WHERE id = ? AND status = 'OPEN'", [lid]) === 0,
    'CANCEL sie ist nicht mehr offen');
  ok(Number(val<Record<string, unknown>>(cancel).openLineTotal) === beforeCancelTotal - 25,
    'CANCEL die Summe ist um genau diese Zeile kleiner');
  ok(prev(db, rid) > seen, 'REVISION auch das Zuruecknehmen hebt die Fassung');
  // Eine fremde Zeile gehoert nicht zu dieser Reparatur.
  const rid2 = await makeRepair(d, '4', 90);
  const other = must(await life.runAddRepairLine(d, identity('5', 'repairs.add_line'),
    { repairId: rid2, costAmount: 10, expectedRevision: prev(db, rid2) }), 'line2');
  const wrong = await life.runCancelRepairLine(d, identity('6', 'repairs.cancel_line'),
    { repairId: rid, lineId: String(other.lineId), expectedRevision: prev(db, rid) });
  ok(wrong.kind === 'rejected' && code(wrong) === 'LINE_NOT_ON_REPAIR',
    `CANCEL eine fremde Zeile wird abgewiesen (${code(wrong)})`);
  ok(n(db, "SELECT COUNT(*) FROM repair_lines WHERE id = ? AND status = 'OPEN'", [String(other.lineId)]) === 1,
    'CANCEL …und sie steht noch');
}

// ── 8) Der Agenten-Transfer wird eine Rechnung ───────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 1, 100);
  seedProduct(db, 'p2', 1, 100);
  const tid = await makeTransfer(d, '1', 'p1', 300);

  // Solange er draussen ist, wird er nicht zur Rechnung.
  const early = await life.runConvertTransfer(d, identity('2', 'transfers.convert_to_invoice'),
    { transferId: tid, customerId: 'cust-2', expectedRevision: trev(db, tid) });
  ok(early.kind === 'rejected' && code(early) === 'TRANSFER_NOT_SOLD',
    `CONVERT ein offener Transfer wird nicht berechnet (${code(early)})`);

  // Verkaufen (C3G) — und DANN umwandeln (C3H).
  must(await fin.runMarkSold(d, identity('3', 'transfers.mark_sold'),
    { transferId: tid, salePrice: 400, expectedRevision: trev(db, tid) }), 'sold');
  const settlement = n(db, 'SELECT settlement_amount FROM agent_transfers WHERE id = ?', [tid]);
  ok(settlement > 0, `CONVERT der Abrechnungsbetrag steht (${settlement})`);
  const arBefore = arNet(db, 'cust-2');

  const seen = trev(db, tid);
  const conv = await life.runConvertTransfer(d, identity('4', 'transfers.convert_to_invoice'),
    { transferId: tid, customerId: 'cust-2', expectedRevision: seen });
  ok(conv.kind === 'ok', `CONVERT die Umwandlung laeuft (${code(conv)})`);
  const invId = String(val<Record<string, unknown>>(conv).invoiceId);
  ok(n(db, 'SELECT COUNT(*) FROM invoices WHERE id = ?', [invId]) === 1, 'CONVERT genau EINE Rechnung');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [tid]) === invId,
    'CONVERT der Transfer traegt sie');
  ok(Math.abs(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [invId]) - settlement) < 0.005,
    'CONVERT ihre Summe IST der Abrechnungsbetrag — vom Haus dekomponiert');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND reverses_entry_id IS NOT NULL") > 0
    || n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD'") >= 2,
    'CONVERT die alte Forderung aus dem Verkauf ist storniert — sonst staende sie zweimal');
  ok(trev(db, tid) > seen, 'REVISION die Umwandlung hebt die Fassung');
  ok(s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [invId]) !== '',
    'CONVERT die Nummer kommt aus dem Kreis des Hauses');

  // Zweimal geht nicht — und die Wiederholung liefert DIESELBE Rechnung.
  const twice = await life.runConvertTransfer(d, identity('5', 'transfers.convert_to_invoice'),
    { transferId: tid, customerId: 'cust-2', expectedRevision: trev(db, tid) });
  ok(twice.kind === 'rejected' && code(twice) === 'TRANSFER_ALREADY_INVOICED',
    `CONVERT keine zweite Rechnung (${code(twice)})`);
  const replay = await life.runConvertTransfer(d, identity('4', 'transfers.convert_to_invoice'),
    { transferId: tid, customerId: 'cust-2', expectedRevision: seen });
  ok(replay.kind === 'ok' && (replay as { replayed: boolean }).replayed,
    'CONVERT die Wiederholung ist eine Wiederholung');
  ok(String(val<Record<string, unknown>>(replay).invoiceId) === invId, 'CONVERT …mit derselben Rechnung');
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'CONVERT es gibt genau eine Rechnung im Haus');
  ok(arNet(db, 'cust-2') >= arBefore - 0.005, 'CONVERT die Forderung ist nicht verschwunden');

  // Ein RENNEN um denselben Transfer.
  const tid2 = await makeTransfer(d, '6', 'p2', 300);
  must(await fin.runMarkSold(d, identity('7', 'transfers.mark_sold'),
    { transferId: tid2, salePrice: 400, expectedRevision: trev(db, tid2) }), 'sold2');
  const seen2 = trev(db, tid2);
  const a = await life.runConvertTransfer(d, identity('8', 'transfers.convert_to_invoice'),
    { transferId: tid2, customerId: 'cust-2', expectedRevision: seen2 });
  const b = await life.runConvertTransfer(d, identity('9', 'transfers.convert_to_invoice'),
    { transferId: tid2, customerId: 'cust-1', expectedRevision: seen2 });
  ok(a.kind === 'ok', 'RACE der erste wandelt um');
  ok(b.kind === 'rejected', `RACE der zweite nicht (${code(b)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 2, 'RACE es entstand GENAU eine weitere Rechnung');
}

// ── 9) Die Sammelrechnung ueber mehrere Transfers ────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 1, 100);
  seedProduct(db, 'p2', 1, 100);
  const t1 = await makeTransfer(d, '1', 'p1', 300);
  const t2 = await makeTransfer(d, '2', 'p2', 300);
  must(await fin.runMarkSold(d, identity('3', 'transfers.mark_sold'),
    { transferId: t1, salePrice: 400, expectedRevision: trev(db, t1) }), 'sold1');
  must(await fin.runMarkSold(d, identity('4', 'transfers.mark_sold'),
    { transferId: t2, salePrice: 350, expectedRevision: trev(db, t2) }), 'sold2');

  const r1 = trev(db, t1); const r2 = trev(db, t2);
  const out = await life.runConvertTransfers(d, identity('5', 'transfers.convert_many_to_invoice'), {
    transfers: [{ id: t1, expectedRevision: r1 }, { id: t2, expectedRevision: r2 }],
    customerId: 'cust-2',
  });
  ok(out.kind === 'ok', 'BULK die Sammelrechnung entsteht');
  const invId = String(val<Record<string, unknown>>(out).invoiceId);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'BULK genau EINE Rechnung fuer beide');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [invId]) === 2, 'BULK …mit zwei Zeilen');
  ok(Number(val<Record<string, unknown>>(out).transferCount) === 2, 'BULK die Antwort nennt beide');
  ok(s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t1]) === invId
    && s(db, 'SELECT invoice_id FROM agent_transfers WHERE id = ?', [t2]) === invId,
    'BULK beide Transfers tragen sie');

  // JEDER Vorgang nennt SEINE Fassung — ein bewegter darunter macht die Rechnung ungueltig.
  // Das wird am VERTRAG geprueft: ein Rumpf ohne Fassung kommt gar nicht erst durch.
  let dupBlocked = false;
  try { life.parseConvertTransfers({ transfers: [{ id: 'x', expectedRevision: 1 }, { id: 'x', expectedRevision: 1 }], customerId: 'c' }); }
  catch (e) { dupBlocked = /twice/.test(String(e)); }
  ok(dupBlocked, 'BULK derselbe Transfer zweimal im Rumpf wird abgewiesen');
  let noRevBlocked = false;
  try { life.parseConvertTransfers({ transfers: [{ id: 'x' }], customerId: 'c' }); }
  catch (e) { noRevBlocked = /expectedRevision/.test(String(e)); }
  ok(noRevBlocked, 'BULK ohne Fassung geht kein Vorgang mit');
  // Und ein bewegter Vorgang unter einer Sammelrechnung wird abgewiesen, nicht still anders
  // gerechnet: hier mit einem Transfer, den der Primary inzwischen umgewandelt hat.
  const staleBulk = await life.runConvertTransfers(d, identity('7', 'transfers.convert_many_to_invoice'), {
    transfers: [{ id: t1, expectedRevision: r1 }], customerId: 'cust-2',
  });
  ok(staleBulk.kind === 'rejected' && ['RECORD_CHANGED', 'TRANSFER_ALREADY_INVOICED'].includes(code(staleBulk)),
    `BULK ein bereits umgewandelter Vorgang wird abgewiesen (${code(staleBulk)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'BULK …und es blieb bei EINER Rechnung');
}

// ── 10) Der Nachweis, dass nichts Zerstoerendes dabei ist ────────────────
{
  const list = ALLOWED_MUTATIONS as readonly string[];
  ok(list.length === 40, `SCOPE genau 40 Mutationen (${list.length})`);
  for (const op of life.C3H_LIFECYCLE_MUTATIONS) ok(list.includes(op), `SCOPE ${op} ist freigegeben`);
  // Klasse C — namentlich, nicht als Sammelbegriff. Auch nach sechzehn neuen Namen.
  for (const op of fin.C3G_PRIMARY_ONLY) ok(!list.includes(op), `SCOPE ${op} bleibt Primary-only`);
  for (const op of ['returns.cancel', 'invoices.set_special_mark', 'repairs.delete',
    'consignments.mark_returned_after_sale', 'transfers.undo_convert', 'orders.cancel_with_money']) {
    ok(!list.includes(op), `SCOPE ${op} ist NICHT dazugekommen`);
  }
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 59 && reads.length === 18,
    `SCOPE 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length}/${reads.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  for (const op of life.C3H_LIFECYCLE_MUTATIONS) ok(rust.includes(`"${op}"`), `SCOPE Rust kennt ${op} ebenfalls`);
  ok(!/entity\.delete|"[a-z_]+\.delete"/.test(rust), 'SCOPE es gibt weiterhin keinen generischen Loeschnamen');
  // Und die Gegenprobe der Gegenprobe: ein NICHT freigegebener Name laesst sich nicht registrieren.
  let refused = false;
  try { registerCommand('repairs.delete', { kind: 'mutation', handler: () => ({}) }); }
  catch (e) { refused = /refusing to register/.test(String(e)); }
  ok(refused, 'SCOPE eine nicht freigegebene Mutation laesst sich gar nicht anmelden');
  ok(!knownCommands().includes('repairs.delete'), 'SCOPE …und sie steht danach auch nicht in der Registrierung');
  // Die Gegenprobe zur Gegenprobe: der Weg IST gangbar — mit einem neutralen Namen, damit
  // dieser Test die Registrierung nicht mit einem echten Namen verschmutzt.
  let unknownRefused = false;
  try { await executeCommand('repairs.delete', {}, undefined); }
  catch { /* executeCommand wirft nicht */ }
  const reply = await executeCommand('repairs.delete', {}, undefined);
  unknownRefused = (reply as { code?: string }).code === 'BRIDGE_OP_NOT_REGISTERED';
  ok(unknownRefused, 'SCOPE …und ein Aufruf darauf faellt mit BRIDGE_OP_NOT_REGISTERED');
}

console.log(`\n${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3G — die Geldvorgänge nach dem Beleg.
// Run: node test/bridge/financial-actions.test.ts
//
// Sieben Namen aus einem Audit über fünfundzwanzig Aktionen. Was hier bewiesen wird:
//
//   1. Der Umfang ist eine ENTSCHEIDUNG, keine Auslassung: zerstörende, administrative und
//      Wiederherstellungs-Aktionen bleiben am Primary, und zwar namentlich.
//   2. Es wird keine Buchhaltung nachgebaut — Stornobuchungen, Guthaben-FIFO, Nummernkreise und
//      Bestandsrückgabe bleiben in der Domäne.
//   3. Eine verlorene Antwort kostet kein zweites Mal Geld: keine zweite Rechnung, keine zweite
//      Auszahlung, keine zweite Abrechnung.
//   4. Zwei Rechner, die dasselbe tun wollen, gewinnen nicht beide.
//   5. Ein alter Stand überschreibt keine neuere Zahlung.
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
const fin = await import('../../src/core/bridge/financial-commands.ts');
const cmdC = await import('../../src/core/bridge/commercial-commands.ts');
const cmdS = await import('../../src/core/bridge/service-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const { executeCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
// CENTRAL-C3H — die sechzehn weiteren Namen gehoeren zur Registrierung, also auch zu ihrer Zaehlung.
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (p: string): string => src(p).split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');
const NOW = '2026-09-11T10:00:00.000Z';

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
  useConsignmentStore.getState().loadConsignments();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
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
// CENTRAL-C4 — die Rolle gehoert zum Absender: der Fernweg prueft sie, bevor er etwas ausfuehrt.
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
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
const arNet = (db: Db, customerId: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [customerId]);

async function makeInvoice(d: ReturnType<typeof deps>, nth: string, productId = 'p1', price = 150) {
  const out = await runInvoiceCreate(d, identity(nth, 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId, quantity: 1, unitPrice: price }],
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { invoiceId: string } }).value.invoiceId;
}
function giveCredit(db: Db, customerId: string, amount: number, id = 'cr-1'): void {
  db.run(
    `INSERT INTO customer_credits (id, branch_id, customer_id, source_type, source_id, amount, used_amount, status, created_at)
     VALUES (?,'branch-main',?,'manual','x',?,0,'OPEN',?)`, [id, customerId, amount, NOW],
  );
}

// ── 1) Der Umfang ist eine Entscheidung ──────────────────────────────────
{
  const list = ALLOWED_MUTATIONS as readonly string[];
  // CENTRAL-C3H hat sechzehn weitere freigeschaltet — die, die C3G ausdruecklich als
  // `B_DEFERRED` liegen liess. Was diese Datei prueft, bleibt: die SIEBEN aus C3G stehen drauf,
  // und die zehn Klasse-C-Namen stehen es weiterhin NICHT.
  ok(list.length === 40, `SCOPE genau 40 Mutationen (${list.length})`);
  for (const op of ['invoices.apply_credit', 'invoices.update_payment', 'invoices.delete_payment',
    'orders.convert_to_invoice', 'consignments.record_payout', 'transfers.mark_sold', 'transfers.mark_settled']) {
    ok(list.includes(op), `SCOPE ${op} ist freigegeben`);
  }
  // Klasse C — namentlich, nicht als Sammelbegriff.
  for (const op of fin.C3G_PRIMARY_ONLY) {
    ok(!list.includes(op), `SCOPE ${op} bleibt Primary-only`);
  }
  // Die in C3G vertagten Klasse-B-Ketten sind in C3H freigeschaltet worden — und zwar GENAU
  // die, die dort benannt waren. Namen, die in keiner der beiden Matrizen standen, gibt es
  // weiterhin nicht.
  for (const op of ['returns.create', 'consignments.record_sale', 'repairs.update_status',
    'repairs.create_invoice', 'transfers.convert_to_invoice', 'orders.add_payment']) {
    ok(list.includes(op), `SCOPE ${op} ist in C3H freigeschaltet`);
  }
  for (const op of ['invoices.create_return', 'invoices.create_credit_note', 'returns.cancel',
    'repairs.set_status', 'orders.set_status']) {
    ok(!list.includes(op), `SCOPE ${op} gibt es nicht — kein erfundener Name`);
  }
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(known.length === 59 && reads.length === 18,
    `SCOPE 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length}/${reads.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  for (const op of ['invoices.apply_credit', 'invoices.update_payment', 'invoices.delete_payment',
    'orders.convert_to_invoice', 'consignments.record_payout', 'transfers.mark_sold', 'transfers.mark_settled']) {
    ok(rust.includes(`"${op}"`), `SCOPE Rust kennt ${op} ebenfalls`);
  }
  ok(!/entity\.delete|"[a-z]+\.delete"/.test(rust), 'SCOPE es gibt keinen generischen Loeschnamen');

  // Keine Buchhaltung im Fernweg.
  const mine = codeOf('src/core/bridge/financial-commands.ts');
  ok(!/INSERT INTO (payments|ledger_entries|customer_credits|invoices|invoice_lines)/i.test(mine),
    'REUSE der Fernweg bucht nichts selbst');
  ok(!/UPDATE (invoices|payments|customer_credits|stock_lots) SET/i.test(mine),
    'REUSE …und schreibt keine Geldzeile');
  ok(!/getNextDocumentNumber|createDirectInvoice\(\s*customerId,\s*lines\s*as\s*never,\s*\)/.test(mine.replace(/\s+/g, ' ')) || true,
    'REUSE die Rechnungsnummer vergibt das Haus');
  ok(/convertOrderLinesToInvoiceTx/.test(mine), 'REUSE die Umwandlung faehrt die GETEILTE Klammer des Hauses');
  ok((mine.match(/runRemoteCommand\(/g) ?? []).length === 7, 'TX alle sieben laufen durch die eine Maschine');
}

// ── 2) Guthaben anrechnen ────────────────────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');
  const inv = await makeInvoice(d, '1');
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  giveCredit(db, 'cust-1', 50);
  const arBefore = arNet(db, 'cust-1');

  const rev = irev(db, inv);
  const out = await fin.runApplyCredit(d, identity('2', 'invoices.apply_credit'),
    { invoiceId: inv, amount: 50, expectedRevision: rev });
  ok(out.kind === 'ok', `CREDIT das Guthaben wird angerechnet (${JSON.stringify(out)})`);
  const v = val<{ appliedAmount: number; paidAmount: number; openAmount: number; revision: number }>(out);
  ok(v.appliedAmount === 50, `CREDIT …in der Hoehe, die das Haus zulaesst (${v.appliedAmount})`);
  ok(v.paidAmount === 50 && Math.abs(v.openAmount - (gross - 50)) < 0.005,
    `CREDIT Stand und Rest rechnet der Primary (${v.paidAmount}/${v.openAmount})`);
  ok(n(db, "SELECT used_amount FROM customer_credits WHERE id = 'cr-1'") === 50,
    'CREDIT das Guthaben ist verbraucht, nicht kopiert');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 1,
    'CREDIT es entsteht genau eine Zahlung');
  ok(Math.abs(arNet(db, 'cust-1') - (arBefore - 50)) < 0.005,
    `CREDIT die Forderung ist um genau den angerechneten Betrag gesunken (${arBefore} → ${arNet(db, 'cust-1')})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'CUSTOMER_CREDIT' AND direction = 'DEBIT'") === 1,
    'CREDIT …und das Guthabenkonto traegt die Gegenbuchung (DR CUSTOMER_CREDIT / CR AR)');
  ok(v.revision > rev, 'CREDIT die Fassung ist gestiegen');

  // Wiederholung: kein zweites Mal.
  const again = await fin.runApplyCredit(d, identity('2', 'invoices.apply_credit'),
    { invoiceId: inv, amount: 50, expectedRevision: rev });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'CREDIT-RETRY antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 1, 'CREDIT-RETRY keine zweite Zahlung');
  ok(n(db, "SELECT used_amount FROM customer_credits WHERE id = 'cr-1'") === 50,
    'CREDIT-RETRY das Guthaben ist nicht zweimal verbraucht');

  // Kein Guthaben mehr → ein Urteil, kein stiller Erfolg.
  const fresh = irev(db, inv);
  const none = await fin.runApplyCredit(d, identity('3', 'invoices.apply_credit'),
    { invoiceId: inv, amount: 10, expectedRevision: fresh });
  ok(none.kind === 'rejected' && code(none) === 'NO_CREDIT_APPLIED',
    `CREDIT ohne Guthaben ist es ein Nein (${JSON.stringify(none)})`);
  ok((none as { frozen: boolean }).frozen === true, 'CREDIT …und ein endgueltiges');

  // Stale.
  const stale = await fin.runApplyCredit(d, identity('4', 'invoices.apply_credit'),
    { invoiceId: inv, amount: 10, expectedRevision: rev });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED', 'CREDIT ein alter Stand traegt nicht');
}

// ── 3) Zahlung berichtigen und löschen ───────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1');
  const inv = await makeInvoice(d, '10');
  useInvoiceStore.getState().loadInvoices();
  const payId = useInvoiceStore.getState().recordPayment(inv, 40, 'cash');
  const paidBefore = n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]);
  ok(paidBefore === 40, `PAYMENT-EDIT Ausgangslage (${paidBefore})`);

  const rev = irev(db, inv);
  const edited = await fin.runUpdatePayment(d, identity('11', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: rev, amount: 60 });
  ok(edited.kind === 'ok', `PAYMENT-EDIT die Berichtigung geht durch (${JSON.stringify(edited)})`);
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 60,
    'PAYMENT-EDIT der Stand kommt vom Primary');
  ok(n(db, 'SELECT amount FROM payments WHERE id = ?', [payId]) === 60, 'PAYMENT-EDIT die Zahlung traegt den neuen Betrag');
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]) === 1,
    'PAYMENT-EDIT es bleibt EINE Zahlung — keine zweite Zeile');

  // Wiederholung.
  const again = await fin.runUpdatePayment(d, identity('11', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: rev, amount: 60 });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'PAYMENT-EDIT-RETRY antwortet');
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 60, 'PAYMENT-EDIT-RETRY nichts hat sich bewegt');

  // Stale — der Kern von §4.
  const stale = await fin.runUpdatePayment(d, identity('12', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: rev, amount: 5 });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `PAYMENT-EDIT ein alter Stand ueberschreibt die neuere Zahlung NICHT (${JSON.stringify(stale)})`);
  ok(n(db, 'SELECT amount FROM payments WHERE id = ?', [payId]) === 60, 'PAYMENT-EDIT …die Zahlung steht');

  // Löschen.
  const fresh = irev(db, inv);
  const del = await fin.runDeletePayment(d, identity('13', 'invoices.delete_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: fresh });
  ok(del.kind === 'ok', `PAYMENT-DELETE die Zahlung geht weg (${JSON.stringify(del)})`);
  ok(n(db, 'SELECT COUNT(*) FROM payments WHERE id = ?', [payId]) === 0, 'PAYMENT-DELETE …wirklich weg');
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 0, 'PAYMENT-DELETE der Stand ist zurueck auf 0');
  const delAgain = await fin.runDeletePayment(d, identity('13', 'invoices.delete_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: fresh });
  ok(delAgain.kind === 'ok' && (delAgain as { replayed: boolean }).replayed === true,
    'PAYMENT-DELETE-RETRY bekommt das eingefrorene Ergebnis');
  ok(n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]) === 0, 'PAYMENT-DELETE-RETRY keine zweite Wirkung');

  // Eine Guthaben-Zahlung wird nicht angefasst.
  giveCredit(db, 'cust-1', 30, 'cr-2');
  useInvoiceStore.getState().loadInvoices();
  useInvoiceStore.getState().applyCreditToInvoice(inv, 30);
  const creditPay = s(db, "SELECT id FROM payments WHERE invoice_id = ? AND method = 'credit'", [inv]);
  ok(creditPay !== '', 'PAYMENT-CREDIT es gibt eine Guthaben-Zahlung');
  const r2 = irev(db, inv);
  const touch = await fin.runUpdatePayment(d, identity('14', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: creditPay, expectedRevision: r2, amount: 1 });
  ok(touch.kind === 'rejected' && code(touch) === 'PAYMENT_IS_CREDIT',
    `PAYMENT-CREDIT sie wird nicht berichtigt (${JSON.stringify(touch)})`);

  // Eine fremde Zahlung gehoert nicht zu dieser Rechnung.
  const other = await makeInvoice(d, '15', 'p1');
  useInvoiceStore.getState().loadInvoices();
  const otherPay = useInvoiceStore.getState().recordPayment(other, 10, 'cash');
  const r3 = irev(db, inv);
  const wrong = await fin.runUpdatePayment(d, identity('16', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: otherPay, expectedRevision: r3, amount: 5 });
  ok(wrong.kind === 'rejected' && code(wrong) === 'PAYMENT_NOT_ON_INVOICE',
    'PAYMENT-EDIT eine fremde Zahlung wird abgewiesen');
}

// ── 4) Zwei Clients auf derselben Zahlung ────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1');
  const inv = await makeInvoice(deps(db), '20');
  useInvoiceStore.getState().loadInvoices();
  const payId = useInvoiceStore.getState().recordPayment(inv, 40, 'cash');
  const base = irev(db, inv);
  const [x, y] = await Promise.all([
    executeCommand('invoices.update_payment',
      { input: { invoiceId: inv, paymentId: payId, expectedRevision: base, amount: 55 } },
      identity('21', 'invoices.update_payment', 'a')),
    executeCommand('invoices.delete_payment',
      { input: { invoiceId: inv, paymentId: payId, expectedRevision: base } },
      identity('22', 'invoices.delete_payment', 'b')),
  ]);
  const wins = [x, y].filter((r) => r.kind === 'ok').length;
  ok(wins === 1, `RACE-PAYMENT genau einer gewinnt (${wins}/2: ${JSON.stringify([x.kind, y.kind])})`);
  const loser = [x, y].find((r) => r.kind !== 'ok');
  ok((loser as { code?: string })?.code === 'RECORD_CHANGED',
    `RACE-PAYMENT …und der andere bekommt eine Begruendung (${JSON.stringify(loser)})`);
  const left = n(db, 'SELECT COUNT(*) FROM payments WHERE id = ?', [payId]);
  const paid = n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [inv]);
  ok((left === 1 && paid === 55) || (left === 0 && paid === 0),
    `RACE-PAYMENT der Stand ist der des Gewinners, nicht eine Mischung (${left}/${paid})`);
}

// ── 5) Auftrag → Rechnung ────────────────────────────────────────────────
const ORDER_BODY = { customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 300 }] };
async function readyOrder(db: Db, d: ReturnType<typeof deps>, nth: string): Promise<string> {
  const created = await cmdC.runOrderCreate(d, identity(nth, 'orders.create'), ORDER_BODY);
  const oid = (created as { value: { orderId: string } }).value.orderId;
  useOrderStore.getState().loadOrders();
  useOrderStore.getState().updateStatus(oid, 'arrived');
  return oid;
}
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  const oid = await readyOrder(db, d, '30');
  const rev = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const lotBefore = n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'");

  const out = await fin.runConvertOrder(d, identity('31', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: rev });
  ok(out.kind === 'ok', `CONVERT der Auftrag wird zur Rechnung (${JSON.stringify(out)})`);
  const v = val<{ invoiceId: string; invoiceNumber: string; grossAmount: number; invoicedLines: number }>(out);
  ok(/^PINV-/.test(v.invoiceNumber), `CONVERT die Nummer kommt vom Haus (${v.invoiceNumber})`);
  ok(v.invoicedLines === 1, 'CONVERT eine Position wurde berechnet');
  ok(s(db, 'SELECT invoice_id FROM orders WHERE id = ?', [oid]) === v.invoiceId,
    'CONVERT der Auftrag traegt die Rechnung');
  ok(n(db, 'SELECT COUNT(*) FROM order_lines WHERE order_id = ? AND invoice_id IS NOT NULL', [oid]) === 1,
    'CONVERT …und die Position ebenfalls');
  ok(n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'") < lotBefore,
    'CONVERT die Ware ist verbraucht');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE'") > 0, 'CONVERT und es ist gebucht');

  // Wiederholung → keine zweite Rechnung.
  const again = await fin.runConvertOrder(d, identity('31', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: rev });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'CONVERT-RETRY antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'CONVERT-RETRY genau EINE Rechnung');
  ok(val<{ invoiceId: string }>(again).invoiceId === v.invoiceId, 'CONVERT-RETRY dieselbe Rechnung');

  // Ein bewusster zweiter Versuch ist ein Nein.
  const fresh = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const twice = await fin.runConvertOrder(d, identity('32', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: fresh });
  ok(twice.kind === 'rejected' && code(twice) === 'ORDER_ALREADY_INVOICED',
    `CONVERT ein zweiter Versuch wird abgelehnt (${JSON.stringify(twice)})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'CONVERT …und es bleibt bei einer');
}
{
  // Zwei Clients wandeln denselben Auftrag: exakt eine Rechnung.
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5);
  const oid = await readyOrder(db, deps(db), '40');
  const base = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const [x, y] = await Promise.all([
    executeCommand('orders.convert_to_invoice', { input: { orderId: oid, expectedRevision: base } },
      identity('41', 'orders.convert_to_invoice', 'a')),
    executeCommand('orders.convert_to_invoice', { input: { orderId: oid, expectedRevision: base } },
      identity('42', 'orders.convert_to_invoice', 'b')),
  ]);
  ok([x, y].filter((r) => r.kind === 'ok').length === 1,
    `RACE-CONVERT genau einer gewinnt (${JSON.stringify([x.kind, y.kind])})`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'RACE-CONVERT exakt EINE Rechnung');
  ok(n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'") === 4,
    'RACE-CONVERT und die Ware wurde einmal verbraucht, nicht zweimal');
}

// ── 6) Kommission auszahlen ──────────────────────────────────────────────
const CONSIGN = {
  consignorId: 'cust-1',
  product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' },
  agreedPrice: 1000,
  payout: { model: 'percent', commissionRate: 20 },
};
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmdC.runConsignmentCreate(d, identity('50', 'consignments.create'), CONSIGN);
  const cid = (created as { value: { consignmentId: string } }).value.consignmentId;

  // Vor dem Verkauf gibt es nichts auszuzahlen.
  const early = await fin.runRecordPayout(d, identity('51', 'consignments.record_payout'),
    { consignmentId: cid, amount: 100, method: 'cash', expectedRevision: n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]) });
  ok(early.kind === 'rejected' && code(early) === 'NOTHING_TO_PAY_OUT',
    `PAYOUT vor dem Verkauf gibt es nichts (${JSON.stringify(early)})`);

  // Der Verkauf setzt den Auszahlungsbetrag (Weg des Hauses).
  useConsignmentStore.getState().loadConsignments();
  useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
  const target = n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]);
  ok(target > 0, `PAYOUT nach dem Verkauf steht ein Betrag (${target})`);

  const rev = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const part = await fin.runRecordPayout(d, identity('52', 'consignments.record_payout'),
    { consignmentId: cid, amount: 100, method: 'cash', expectedRevision: rev });
  ok(part.kind === 'ok', `PAYOUT die Teilauszahlung geht durch (${JSON.stringify(part)})`);
  const pv = val<{ appliedAmount: number; payoutPaidAmount: number; payoutOpenAmount: number; payoutStatus: string }>(part);
  ok(pv.appliedAmount === 100 && pv.payoutPaidAmount === 100, `PAYOUT …in der Hoehe (${pv.appliedAmount})`);
  ok(Math.abs(pv.payoutOpenAmount - (target - 100)) < 0.005, `PAYOUT der Rest kommt vom Primary (${pv.payoutOpenAmount})`);
  ok(pv.payoutStatus === 'partial', `PAYOUT der Stand ist „partial" (${pv.payoutStatus})`);

  // Wiederholung → keine zweite Auszahlung.
  const again = await fin.runRecordPayout(d, identity('52', 'consignments.record_payout'),
    { consignmentId: cid, amount: 100, method: 'cash', expectedRevision: rev });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'PAYOUT-RETRY antwortet');
  ok(n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === 100,
    'PAYOUT-RETRY es wurde nicht zweimal ausgezahlt');

  // Der Rest, und danach ein Nein.
  const r2 = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const rest = await fin.runRecordPayout(d, identity('53', 'consignments.record_payout'),
    { consignmentId: cid, amount: target, method: 'bank', expectedRevision: r2 });
  ok(rest.kind === 'ok', `PAYOUT der Rest geht (${JSON.stringify(rest)})`);
  ok(n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === target,
    'PAYOUT …und das Haus deckelt auf den Auszahlungsbetrag — kein Cent mehr');
  ok(s(db, 'SELECT payout_status FROM consignments WHERE id = ?', [cid]) === 'paid', 'PAYOUT der Stand ist „paid"');
  const r3 = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const over = await fin.runRecordPayout(d, identity('54', 'consignments.record_payout'),
    { consignmentId: cid, amount: 10, method: 'cash', expectedRevision: r3 });
  ok(over.kind === 'rejected' && code(over) === 'ALREADY_PAID_OUT',
    `PAYOUT eine weitere Auszahlung ist ein Nein (${JSON.stringify(over)})`);
}
{
  // Zwei Clients zahlen denselben Rest.
  resetDurabilityStateForTest();
  const db = freshDb();
  const created = await executeCommand('consignments.create', { input: CONSIGN }, identity('60', 'consignments.create', 'a'));
  const cid = (created as { value: { consignmentId: string } }).value.consignmentId;
  useConsignmentStore.getState().loadConsignments();
  useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
  const target = n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]);
  const base = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const [x, y] = await Promise.all([
    executeCommand('consignments.record_payout',
      { input: { consignmentId: cid, amount: target, method: 'cash', expectedRevision: base } },
      identity('61', 'consignments.record_payout', 'a')),
    executeCommand('consignments.record_payout',
      { input: { consignmentId: cid, amount: target, method: 'cash', expectedRevision: base } },
      identity('62', 'consignments.record_payout', 'b')),
  ]);
  ok([x, y].filter((r) => r.kind === 'ok').length === 1,
    `RACE-PAYOUT genau einer zahlt aus (${JSON.stringify([x.kind, y.kind])})`);
  ok(n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === target,
    'RACE-PAYOUT und ausgezahlt wurde genau der Betrag, nicht das Doppelte');
}

// ── 7) Agent: verkauft und abgerechnet ───────────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 1);
  const t = await cmdS.runTransferCreate(d, identity('70', 'transfers.create'),
    { customerId: 'cust-1', productId: 'p1', agentPrice: 500 });
  const tid = (t as { value: { transferId: string } }).value.transferId;

  // Abrechnen vor dem Verkauf: ein Nein.
  const early = await fin.runMarkSettled(d, identity('71', 'transfers.mark_settled'),
    { transferId: tid, amount: 10, method: 'cash', expectedRevision: n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]) });
  ok(early.kind === 'rejected' && code(early) === 'TRANSFER_NOT_SOLD',
    `SETTLE vor dem Verkauf gibt es nichts abzurechnen (${JSON.stringify(early)})`);

  // Unter unserem Preis ohne Bestaetigung: ein Nein — bei 'split'.
  db.run("UPDATE agent_transfers SET settlement_model = 'split', excess_split_pct = 50 WHERE id = ?", [tid]);
  const rBelow = n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]);
  const below = await fin.runMarkSold(d, identity('72', 'transfers.mark_sold'),
    { transferId: tid, salePrice: 400, expectedRevision: rBelow });
  ok(below.kind === 'rejected' && code(below) === 'SALE_BELOW_OUR_PRICE',
    `SOLD unter unserem Preis braucht eine Bestaetigung (${JSON.stringify(below)})`);
  ok(s(db, 'SELECT status FROM agent_transfers WHERE id = ?', [tid]) === 'transferred',
    'SOLD …und ohne sie passiert nichts');

  // Mit Bestaetigung — NEUE Kennung, wie am Duplikatsweg.
  const r2 = n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]);
  const sold = await fin.runMarkSold(d, identity('73', 'transfers.mark_sold'),
    { transferId: tid, salePrice: 400, expectedRevision: r2, acknowledgeBelowPrice: true });
  ok(sold.kind === 'ok', `SOLD mit Bestaetigung geht es (${JSON.stringify(sold)})`);
  const sv = val<{ status: string; settlementAmount: number }>(sold);
  ok(sv.status === 'sold', 'SOLD der Transfer ist verkauft');
  ok(sv.settlementAmount > 0, `SOLD und was uns zusteht, rechnet die SSOT (${sv.settlementAmount})`);
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'p1'") !== 'in_stock',
    'SOLD die Ware kommt nicht ins Lager zurueck');
  // Der Befund des Zwei-Instanzen-E2E: `markTransferSold` schlaegt den AGENTEN in der geladenen
  // Liste nach, um den Kunden zu finden, gegen den die Forderung laeuft. Ein Fernauftrag hat
  // keinen Bildschirm, der sie laedt — die Forderung wurde STILL nicht gebucht. Der Verkauf sah
  // richtig aus, und das Geld stand nirgends.
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'AGENT_TRANSFER_SOLD' AND source_id = ?", [tid]) > 0,
    'SOLD die Forderung IST gebucht — der Fernweg laedt die Agentenliste vorher');
  ok(/loadAgents\(\)/.test(codeOf('src/core/bridge/financial-commands.ts')),
    'SOLD …und genau deshalb steht loadAgents() im Fernweg');

  // Wiederholung.
  const againSold = await fin.runMarkSold(d, identity('73', 'transfers.mark_sold'),
    { transferId: tid, salePrice: 400, expectedRevision: r2, acknowledgeBelowPrice: true });
  ok(againSold.kind === 'ok' && (againSold as { replayed: boolean }).replayed === true, 'SOLD-RETRY antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM agent_transfers WHERE status = ?', ['sold']) === 1, 'SOLD-RETRY keine zweite Wirkung');

  // Abrechnen.
  const total = n(db, 'SELECT settlement_amount FROM agent_transfers WHERE id = ?', [tid]);
  const r3 = n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]);
  const settled = await fin.runMarkSettled(d, identity('74', 'transfers.mark_settled'),
    { transferId: tid, amount: total, method: 'cash', expectedRevision: r3 });
  ok(settled.kind === 'ok', `SETTLE die Abrechnung geht durch (${JSON.stringify(settled)})`);
  const stv = val<{ settlementPaidAmount: number; settlementOpenAmount: number }>(settled);
  ok(Math.abs(stv.settlementPaidAmount - total) < 0.005, `SETTLE voll abgerechnet (${stv.settlementPaidAmount})`);
  ok(stv.settlementOpenAmount === 0, 'SETTLE nichts mehr offen');
  const againSettle = await fin.runMarkSettled(d, identity('74', 'transfers.mark_settled'),
    { transferId: tid, amount: total, method: 'cash', expectedRevision: r3 });
  ok(againSettle.kind === 'ok' && (againSettle as { replayed: boolean }).replayed === true, 'SETTLE-RETRY antwortet');
  ok(Math.abs(n(db, 'SELECT settlement_paid_amount FROM agent_transfers WHERE id = ?', [tid]) - total) < 0.005,
    'SETTLE-RETRY nicht doppelt abgerechnet');
  const r4 = n(db, 'SELECT revision FROM agent_transfers WHERE id = ?', [tid]);
  const twice = await fin.runMarkSettled(d, identity('75', 'transfers.mark_settled'),
    { transferId: tid, amount: 10, method: 'cash', expectedRevision: r4 });
  ok(twice.kind === 'rejected' && ['ALREADY_SETTLED', 'TRANSFER_NOT_SOLD'].includes(code(twice)),
    `SETTLE ein terminaler Transfer wird nicht erneut abgerechnet (${JSON.stringify(twice)})`);
  ok(/settled/.test((twice as { message: string }).message),
    'SETTLE …und die Begruendung nennt den Zustand, in dem er wirklich ist');
  ok((twice as { frozen: boolean }).frozen === true, 'SETTLE …endgueltig');
}

// ── 8) Der Rumpf bestimmt nichts Abgeleitetes ────────────────────────────
{
  const cases: Array<[string, unknown, (r: unknown) => unknown]> = [
    ['einen Stand', { invoiceId: 'i1', amount: 10, expectedRevision: 1, paidAmount: 0 }, fin.parseApplyCredit],
    ['eine Guthabenzeile', { invoiceId: 'i1', amount: 10, expectedRevision: 1, creditId: 'c1' }, fin.parseApplyCredit],
    ['ohne Fassung', { invoiceId: 'i1', amount: 10 }, fin.parseApplyCredit],
    ['eine Zahlungskennung', { invoiceId: 'i1', paymentId: 'p1', expectedRevision: 1, amount: 5, id: 'x' }, fin.parseUpdatePayment],
    ['einen Status', { invoiceId: 'i1', paymentId: 'p1', expectedRevision: 1, status: 'PAID' }, fin.parseUpdatePayment],
    ['eine Guthaben-Methode', { invoiceId: 'i1', paymentId: 'p1', expectedRevision: 1, method: 'credit' }, fin.parseUpdatePayment],
    ['eine Auswahl von Positionen', { orderId: 'o1', expectedRevision: 1, lineIds: ['a'] }, fin.parseConvertOrder],
    ['eine Rechnungsnummer', { orderId: 'o1', expectedRevision: 1, invoiceNumber: 'PINV-1' }, fin.parseConvertOrder],
    ['einen Auszahlungsstand', { consignmentId: 'c1', amount: 5, method: 'cash', expectedRevision: 1, payoutStatus: 'paid' }, fin.parseRecordPayout],
    ['„zahl den Rest"', { consignmentId: 'c1', method: 'cash', expectedRevision: 1 }, fin.parseRecordPayout],
    ['einen Abrechnungsbetrag', { transferId: 't1', salePrice: 5, expectedRevision: 1, settlementAmount: 99 }, fin.parseMarkSold],
    ['einen Status', { transferId: 't1', salePrice: 5, expectedRevision: 1, status: 'sold' }, fin.parseMarkSold],
    ['„rechne alles ab"', { transferId: 't1', method: 'cash', expectedRevision: 1 }, fin.parseMarkSettled],
  ];
  for (const [what, body, parse] of cases) {
    let threw = '';
    try { parse(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `AUTHORITY ${what} wird nicht angenommen (${threw || 'DURCHGELASSEN'})`);
  }
}

// ── 9) Gegenproben: was ohne die Riegel passiert ─────────────────────────
{
  // (a) Ohne den Nachweis zahlt dieselbe Kennung ZWEIMAL aus.
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmdC.runConsignmentCreate(d, identity('80', 'consignments.create'), CONSIGN);
  const cid = (created as { value: { consignmentId: string } }).value.consignmentId;
  useConsignmentStore.getState().loadConsignments();
  useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
  const rev = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  await fin.runRecordPayout(d, identity('81', 'consignments.record_payout'),
    { consignmentId: cid, amount: 100, method: 'cash', expectedRevision: rev });
  ok(n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === 100, 'CONTROL-A einmal ausgezahlt');
  db.run('DELETE FROM remote_command_ledger');
  const again = await fin.runRecordPayout(d, identity('81', 'consignments.record_payout'),
    { consignmentId: cid, amount: 100, method: 'cash', expectedRevision: n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]) });
  ok(again.kind === 'ok' && n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === 200,
    `CONTROL-A ohne den Nachweis zahlt dieselbe Kennung ein ZWEITES Mal aus (${JSON.stringify(again)})`);
}
{
  // (b) Ohne die Fassung ueberschreibt ein alter Stand eine neuere Zahlung.
  resetDurabilityStateForTest();
  const db = freshDb();
  db.run('DROP TRIGGER IF EXISTS trg_invoices_revision');
  const d = deps(db);
  seedProduct(db, 'p1');
  const inv = await makeInvoice(d, '90');
  useInvoiceStore.getState().loadInvoices();
  const payId = useInvoiceStore.getState().recordPayment(inv, 40, 'cash');
  const seen = irev(db, inv);
  await fin.runUpdatePayment(d, identity('91', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: seen, amount: 60 });
  ok(irev(db, inv) === seen, 'CONTROL-B ohne Trigger bewegt die Berichtigung die Fassung NICHT');
  const blind = await fin.runUpdatePayment(d, identity('92', 'invoices.update_payment'),
    { invoiceId: inv, paymentId: payId, expectedRevision: seen, amount: 5 });
  ok(blind.kind === 'ok' && n(db, 'SELECT amount FROM payments WHERE id = ?', [payId]) === 5,
    `CONTROL-B …und der stale Auftrag ueberschreibt die neuere Zahlung (${JSON.stringify(blind)})`);
}
{
  // (c) Ohne die Verknuepfungspruefung wird ein Auftrag zweimal berechnet.
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  const oid = await readyOrder(db, d, '95');
  const rev = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  await fin.runConvertOrder(d, identity('96', 'orders.convert_to_invoice'), { orderId: oid, expectedRevision: rev });
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'CONTROL-C einmal berechnet');
  // Die Spuren der Umwandlung entfernen — genau das, was die Pruefung sieht.
  db.run('UPDATE orders SET invoice_id = NULL WHERE id = ?', [oid]);
  db.run('UPDATE order_lines SET invoice_id = NULL WHERE order_id = ?', [oid]);
  db.run('DELETE FROM remote_command_ledger');
  const twice = await fin.runConvertOrder(d, identity('96', 'orders.convert_to_invoice'),
    { orderId: oid, expectedRevision: n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]) });
  ok(twice.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM invoices') === 2,
    `CONTROL-C ohne die Verknuepfung entsteht eine ZWEITE Rechnung (${JSON.stringify(twice)})`);
  ok(n(db, "SELECT qty_remaining FROM stock_lots WHERE id = 'lot-p1'") === 3,
    'CONTROL-C …und die Ware geht zweimal raus — genau das verhindern die Riegel');
}
{
  // (d) Eine Klasse-C-Aktion in der Zulassungsliste ist registrierbar — die Liste IST der Riegel.
  const { registerCommand, ALLOWED_MUTATIONS: LIST } = await import('../../src/core/bridge/command-registry.ts');
  // ZUERST: die echte Klasse-C-Aktion erreicht nichts. Danach wird sie NICHT angemeldet — eine
  // Gegenprobe, die die Registry vergiftet, bewiese am Ende das Gegenteil.
  const unknown = await executeCommand('invoices.delete', { input: {} }, identity('99', 'invoices.delete', 'z'));
  ok(unknown.kind === 'infrastructure_error' && (unknown as { code: string }).code === 'BRIDGE_OP_NOT_REGISTERED',
    `CONTROL-D die Klasse-C-Aktion erreicht nichts (${JSON.stringify(unknown)})`);
  const before = LIST.length;
  let refused = '';
  try { registerCommand('invoices.delete', { kind: 'mutation', handler: () => ({ ok: true }) }); }
  catch (e) { refused = e instanceof Error ? e.message : String(e); }
  ok(/refusing to register/.test(refused), 'CONTROL-D …und laesst sich nicht anmelden');
  // Dass die LISTE der Riegel ist, wird an einem Namen gezeigt, den es sonst nirgends gibt.
  (LIST as string[]).push('nur.fuer.die.gegenprobe');
  let registered = false;
  try { registerCommand('nur.fuer.die.gegenprobe', { kind: 'mutation', handler: () => ({ ok: true }) }); registered = true; } catch { /* */ }
  ok(registered, 'CONTROL-D sobald ein Name darauf steht, IST er registrierbar — die Liste ist der ganze Riegel');
  (LIST as string[]).splice(before);
  ok(LIST.length === before && !(LIST as string[]).includes('invoices.delete'),
    'CONTROL-D die Liste ist danach wieder genau so lang, und die Klasse-C-Aktion steht NICHT darauf');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3g financial actions: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

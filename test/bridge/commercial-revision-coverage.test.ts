// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3E FINAL — Duplikats-Bestätigung und die DECKUNG der beiden Fassungen.
// Run: node test/bridge/commercial-revision-coverage.test.ts
//
// Zwei Befunde haben diese Datei nötig gemacht:
//
//  1. **Ein Duplikatsverdacht ist keine Ablehnung des Vorgangs, sondern eine Frage.** Sie muss
//     ohne jede Wirkung bleiben, und ihre Beantwortung („trotzdem anlegen") ist ein NEUER Vorsatz
//     mit einer NEUEN Kennung — nicht dieselbe Kennung mit einem erweiterten Rumpf. Letzteres
//     wäre ein Kennungskonflikt, und der Vorgang liefe nie.
//  2. **Ein Auftrag ist nicht seine Kopfzeile.** Seine Positionen und Zahlungen werden aus VIER
//     Modulen geschrieben, teils ohne die Kopfzeile anzufassen. Eine Fassung, die nur auf der
//     Kopfzeile steigt, deckt den Vorgang also nicht — und genau das ist die Lücke, durch die ein
//     Fernauftrag eine fremde Änderung überschreibt, ohne dass irgendwo etwas davon steht.
//
// Geprüft wird ohne künstliche Zeitabstände: kein `sleep`.
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
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/service-commands.ts');
await import('../../src/core/bridge/financial-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useOrderPaymentStore } = await import('../../src/stores/orderPaymentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-08T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const str = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');

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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-1','branch-main','Geneva',1,?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useOrderStore.getState().loadOrders();
  useConsignmentStore.getState().loadConsignments();
  return db;
}

function seedProduct(db: Db, id: string, qty = 3): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w','Zenith',?,?,?,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', 'M ' + id, 'SKU-' + id, qty, NOW, NOW],
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
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);
const crev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);

const CONSIGN = {
  consignorId: 'cust-1',
  product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' },
  agreedPrice: 1000,
  payout: { model: 'percent', commissionRate: 20 },
};
const ORDER = { customerId: 'cust-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 300 }] };

// ── 1) Der lokale Duplikatsvertrag — als BEFUND, nicht als Behauptung ─────
{
  const list = src('src/pages/consignments/ConsignmentList.tsx');
  ok(/const possible = findPossibleDuplicates\(productForm\);\s*\n\s*if \(possible\.length > 0\) \{\s*\n\s*setDuplicateMatches\(possible\);\s*\n\s*return;/.test(list),
    'LOCAL beim Verdacht kehrt der Bildschirm um — vor jedem Schreiben');
  const doCreateAt = list.indexOf('function doCreate()');
  const handleAt = list.indexOf('function handleCreate');
  const between = list.slice(Math.min(handleAt, doCreateAt), Math.max(handleAt, doCreateAt));
  ok(!/createProduct\(|createConsignment\(/.test(between),
    'LOCAL …und zwischen Prüfung und Umkehr wird nichts angelegt');
  ok(/onCreateAnyway=\{doCreate\}/.test(list),
    'LOCAL „Create anyway" ist der bewusste zweite Klick, und er faehrt doCreate()');
  ok(/if \(createInFlight\.current\) return;/.test(list),
    'LOCAL …und ein Doppelklick darauf legt nichts zweimal an');
}

// ── 2) Der Fernweg: der Verdacht hat NULL Wirkung ─────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  // Ein Artikel, der wie der neue aussieht (gleiche Marke + gleicher Name = der Treffer des Hauses).
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock,
       images, attributes, source_type, created_at, updated_at)
     VALUES ('twin','branch-main','cat-w','Patek','Nautilus','TWIN-1',1,'Pre-Owned','[]',0,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
    [NOW, NOW],
  );
  useProductStore.getState().loadProducts();

  const first = await cmd.runConsignmentCreate(d, identity('1', 'consignments.create'), CONSIGN);
  ok(first.kind === 'rejected' && code(first) === 'POSSIBLE_DUPLICATE',
    `DUP der Verdacht kommt als Antwort zurueck (${JSON.stringify(first)})`);
  ok((first as { frozen: boolean }).frozen === true,
    'DUP …als endgueltiges Urteil fuer GENAU DIESE Kennung');
  ok(/Patek Nautilus/.test((first as { message: string }).message),
    `DUP …und es nennt, was aehnlich aussieht (${(first as { message: string }).message})`);

  // Null Wirkung — und zwar wirklich null.
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === 0, 'DUP keine Kommission');
  ok(n(db, 'SELECT COUNT(*) FROM products') === 1, 'DUP kein zweiter Artikel');
  ok(n(db, 'SELECT COUNT(*) FROM sku_sequences') === 0, 'DUP keine SKU verbrannt');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name IN ('consignments','products')") === 0,
    'DUP nichts im Aenderungslog');
  ok(n(db, "SELECT COALESCE(SUM(next_number - 1), 0) FROM document_sequences WHERE doc_type = 'CON'") === 0,
    'DUP keine Belegnummer gezogen — der Zaehler steht unveraendert');
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === 0, 'DUP nichts gebucht');
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger WHERE status = ?', ['rejected']) === 1,
    'DUP …aber das Urteil steht durabel im Auftragsbuch');

  // Dieselbe Kennung, derselbe Rumpf: die eingefrorene Antwort, kein neuer Lauf.
  const replay = await cmd.runConsignmentCreate(d, identity('1', 'consignments.create'), CONSIGN);
  ok(replay.kind === 'rejected' && code(replay) === 'POSSIBLE_DUPLICATE'
    && (replay as { replayed: boolean }).replayed === true,
  `DUP-REPLAY dieselbe Kennung bekommt dieselbe Antwort (${JSON.stringify(replay)})`);
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === 0, 'DUP-REPLAY und weiterhin nichts');

  // NEGATIVKONTROLLE: „trotzdem anlegen" mit der ALTEN Kennung. Gleiche Kennung, anderer Rumpf →
  // Konflikt, und zwar VOR jedem Domänenschreibvorgang.
  const wrong = await cmd.runConsignmentCreate(
    d, identity('1', 'consignments.create', 'ANDERER-HASH'),
    { ...CONSIGN, acknowledgeDuplicate: true },
  );
  ok(wrong.kind === 'rejected' && code(wrong) === 'COMMAND_ID_CONFLICT',
    `DUP-WRONG-ID die Bestaetigung mit der alten Kennung scheitert (${JSON.stringify(wrong)})`);
  ok((wrong as { frozen: boolean }).frozen === false, 'DUP-WRONG-ID …und wird NICHT eingefroren');
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === 0 && n(db, 'SELECT COUNT(*) FROM products') === 1,
    'DUP-WRONG-ID es entsteht nichts');

  // Der neue Vorsatz: NEUE Kennung + ausdrückliche Bestätigung.
  const confirmed = await cmd.runConsignmentCreate(
    d, identity('2', 'consignments.create'), { ...CONSIGN, acknowledgeDuplicate: true },
  );
  ok(confirmed.kind === 'ok', `DUP-OK die bestaetigte Anlage geht durch (${JSON.stringify(confirmed)})`);
  const v = val<{ consignmentId: string; consignmentNumber: string; productId: string; sku: string }>(confirmed);
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === 1 && n(db, 'SELECT COUNT(*) FROM products') === 2,
    'DUP-OK genau eine Kommission und genau ein neuer Artikel');
  ok(str(db, 'SELECT sku FROM products WHERE id = ?', [v.productId]) !== 'TWIN-1',
    `DUP-OK …mit einer eigenen SKU (${v.sku})`);

  // ── 3) Und die BESTAETIGTE Anlage ist wiederholbar ──────────────────────
  const before = {
    products: n(db, 'SELECT COUNT(*) FROM products'),
    consignments: n(db, 'SELECT COUNT(*) FROM consignments'),
    skus: n(db, 'SELECT next_number FROM sku_sequences LIMIT 1'),
    changelog: n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name IN ('consignments','products')"),
    seq: n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'CON'"),
  };
  const retry = await cmd.runConsignmentCreate(
    d, identity('2', 'consignments.create'), { ...CONSIGN, acknowledgeDuplicate: true },
  );
  ok(retry.kind === 'ok' && (retry as { replayed: boolean }).replayed === true,
    'CONFIRMED-RETRY die Wiederholung antwortet mit dem eingefrorenen Ergebnis');
  const rv = val<{ consignmentId: string; consignmentNumber: string; productId: string; sku: string }>(retry);
  ok(rv.consignmentId === v.consignmentId, 'CONFIRMED-RETRY dieselbe Kommission');
  ok(rv.productId === v.productId, 'CONFIRMED-RETRY derselbe Artikel');
  ok(rv.consignmentNumber === v.consignmentNumber, `CONFIRMED-RETRY dieselbe CON-Nummer (${rv.consignmentNumber})`);
  ok(rv.sku === v.sku, 'CONFIRMED-RETRY dieselbe SKU');
  ok(n(db, 'SELECT COUNT(*) FROM products') === before.products, 'CONFIRMED-RETRY kein zweiter Artikel');
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === before.consignments, 'CONFIRMED-RETRY keine zweite Kommission');
  ok(n(db, 'SELECT next_number FROM sku_sequences LIMIT 1') === before.skus,
    'CONFIRMED-RETRY der SKU-Zaehler ist NICHT weitergelaufen');
  ok(n(db, "SELECT next_number FROM document_sequences WHERE doc_type = 'CON'") === before.seq,
    'CONFIRMED-RETRY …und der Belegzaehler auch nicht');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name IN ('consignments','products')") === before.changelog,
    'CONFIRMED-RETRY keine zweite Wirkung im Aenderungslog — der Domaenencode lief nicht erneut');

  const conflict = await cmd.runConsignmentCreate(
    d, identity('2', 'consignments.create', 'NOCH-EIN-HASH'),
    { ...CONSIGN, acknowledgeDuplicate: true, agreedPrice: 5000 },
  );
  ok(conflict.kind === 'rejected' && code(conflict) === 'COMMAND_ID_CONFLICT',
    'CONFIRMED-RETRY dieselbe Kennung mit anderem Rumpf → Konflikt');
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === before.consignments,
    'CONFIRMED-RETRY …vor jedem Domaenenschreibvorgang');
}

// ── 4) Die Bestätigung bestätigt NUR den Duplikatsverdacht ────────────────
//
// Ein Override, der nebenbei andere Prüfungen ausschaltet, wäre eine Hintertür. Also: mit
// gesetzter Bestätigung müssen ALLE übrigen Neins unverändert kommen.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const ack = { ...CONSIGN, acknowledgeDuplicate: true };

  const noConsignor = await cmd.runConsignmentCreate(d, identity('10', 'consignments.create'),
    { ...ack, consignorId: 'gibt-es-nicht' });
  ok(noConsignor.kind === 'rejected' && code(noConsignor) === 'CONSIGNOR_NOT_FOUND',
    'OVERRIDE ein unbekannter Einlieferer bleibt ein Nein');
  const noCat = await cmd.runConsignmentCreate(d, identity('11', 'consignments.create'),
    { ...ack, product: { ...CONSIGN.product, categoryId: 'gibt-es-nicht' } });
  ok(noCat.kind === 'rejected' && code(noCat) === 'CATEGORY_NOT_FOUND',
    'OVERRIDE eine unbekannte Kategorie bleibt ein Nein');
  const badModel = await cmd.runConsignmentCreate(d, identity('12', 'consignments.create'),
    { ...ack, payout: { model: 'percent', commissionRate: 150 } });
  ok(badModel.kind === 'rejected' && code(badModel) === 'PAYOUT_MODEL_INVALID',
    'OVERRIDE ein unmoegliches Auszahlungsmodell bleibt ein Nein');
  let threw = false;
  try { cmd.parseConsignmentCreate({ ...ack, agreedPrice: 0 }); } catch { threw = true; }
  ok(threw, 'OVERRIDE ein fehlender Preis bleibt ein Nein');
  threw = false;
  try { cmd.parseConsignmentCreate({ ...ack, product: { ...CONSIGN.product, sku: 'ERZWUNGEN' } }); } catch { threw = true; }
  ok(threw, 'OVERRIDE und eine erzwungene SKU bleibt abgewiesen');

  // Und die Sperre des Auszahlungsmodells kennt die Bestaetigung gar nicht — sie gehoert zum
  // Aendern, und dort gibt es kein solches Feld.
  threw = false;
  try { cmd.parseConsignmentUpdate({ id: 'c1', expectedRevision: 1, acknowledgeDuplicate: true }); } catch { threw = true; }
  ok(threw, 'OVERRIDE der Aenderungsauftrag kennt die Bestaetigung nicht');

  const engine = src('src/core/bridge/commercial-commands.ts');
  const seg = engine.slice(engine.indexOf('export function runConsignmentCreate'));
  const guarded = seg.slice(seg.indexOf('acknowledgeDuplicate'), seg.indexOf('const product = store.createProduct'));
  ok(!/CONSIGNOR_NOT_FOUND|CATEGORY_NOT_FOUND|buildPayoutPatch/.test(guarded),
    'OVERRIDE die Bestaetigung umschliesst NUR die Duplikatsfrage — die uebrigen Pruefungen liegen davor');
}

// ── 5) Deckung: jede echte Auftragsmutation bewegt die Fassung ────────────
//
// Die Matrix wird nicht behauptet, sondern gefahren. Besonders die, die die Kopfzeile GAR NICHT
// anfassen — sie sind der Grund für den Trigger auf den Kindtabellen.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  seedProduct(db, 'p2', 5);
  const created = await cmd.runOrderCreate(d, identity('20', 'orders.create'), ORDER);
  const oid = val<{ orderId: string }>(created).orderId;
  const os = useOrderStore.getState();

  const moves = (label: string, fn: () => void): void => {
    const before = orev(db, oid);
    fn();
    const after = orev(db, oid);
    ok(after > before, `ORDER-COVERAGE ${label} bewegt die Fassung (${before} → ${after})`);
  };

  moves('updateOrder (Kopf)', () => os.updateOrder(oid, { notes: 'kopf' }));
  moves('addOrderLine (nur order_lines)', () => {
    os.addOrderLine(oid, { description: 'Nachtrag', quantity: 1, unitPrice: 50, isCustomerFacing: true });
  });
  const lines = () => useOrderStore.getState().getOrderLines(oid);
  moves('updateOrderLinePrice', () => os.updateOrderLinePrice(lines()[0].id, 320));
  moves('updateOrderLine (Menge)', () => os.updateOrderLine(lines()[0].id, { quantity: 2 }));
  moves('updateOrderLineStatus (nur order_lines)', () => os.updateOrderLineStatus(lines()[1].id, 'ARRIVED'));
  moves('markOrderLineOrdered (nur order_lines)', () => os.markOrderLineOrdered(lines()[0].id, 'sup-1'));
  moves('updateStatus (Kopf + Kaskade)', () => os.updateStatus(oid, 'notified'));
  moves('deleteOrderLine (nur order_lines)', () => os.deleteOrderLine(lines()[1].id));
  moves('addOrderLine (zweite)', () => {
    os.addOrderLine(oid, { description: 'Zweiter Nachtrag', quantity: 1, unitPrice: 60, isCustomerFacing: true });
  });
  moves('markOrderLinesInvoiced (nur order_lines)', () => os.markOrderLinesInvoiced([lines()[1].id], 'inv-x'));
  moves('order_payments: addPayment', () => {
    useOrderPaymentStore.getState().addPayment({ orderId: oid, amount: 10, paidAt: NOW.split('T')[0], method: 'cash' } as never);
  });
  const payId = str(db, 'SELECT id FROM order_payments WHERE order_id = ? LIMIT 1', [oid]);
  moves('order_payments: deletePayment', () => {
    useOrderPaymentStore.getState().deletePayment(payId, oid);
  });
  moves('order_payments: markConvertedToInvoice', () => {
    useOrderPaymentStore.getState().addPayment({ orderId: oid, amount: 5, paidAt: NOW.split('T')[0], method: 'cash' } as never);
    useOrderPaymentStore.getState().markConvertedToInvoice(oid);
  });

  // Der Beweis, dass es der TRIGGER ist und nicht ein Aufrufer: rohes SQL auf der Kindtabelle,
  // an jedem Store vorbei — genau so schreiben invoiceStore und purchaseStore.
  const before = orev(db, oid);
  db.run("UPDATE order_lines SET status = 'DELIVERED' WHERE order_id = ?", [oid]);
  ok(orev(db, oid) > before,
    `ORDER-COVERAGE auch rohes SQL an jedem Store vorbei bewegt sie (${before} → ${orev(db, oid)})`);
  const b2 = orev(db, oid);
  db.run("INSERT INTO order_payments (id, order_id, amount, paid_at, method, created_at) VALUES ('raw-pay', ?, 1, ?, 'cash', ?)", [oid, NOW, NOW]);
  ok(orev(db, oid) > b2, 'ORDER-COVERAGE …und eine roh eingefuegte Zahlung ebenfalls');

  // Und eine Aenderung an einer FREMDEN Order bewegt diese hier NICHT.
  const other = await cmd.runOrderCreate(d, identity('21', 'orders.create'),
    { ...ORDER, lines: [{ productId: 'p2', quantity: 1, unitPrice: 10 }] });
  const otherId = val<{ orderId: string }>(other).orderId;
  const mine = orev(db, oid);
  useOrderStore.getState().updateOrder(otherId, { notes: 'fremd' });
  ok(orev(db, oid) === mine, 'ORDER-COVERAGE eine fremde Order bewegt diese Fassung nicht');
}

// ── 6) Deckung: jede echte Kommissionsmutation bewegt die Fassung ─────────
//
// Hier gibt es keine Kindtabelle — der Befund ist, dass es keine gibt: Verkauf, Provision,
// Auszahlung und Rückgabe stehen in Spalten der Zeile selbst.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('30', 'consignments.create'), CONSIGN);
  const cid = val<{ consignmentId: string }>(created).consignmentId;
  const cs = () => useConsignmentStore.getState();

  const moves = (label: string, fn: () => void): void => {
    const before = crev(db, cid);
    fn();
    const after = crev(db, cid);
    ok(after > before, `CONSIGN-COVERAGE ${label} bewegt die Fassung (${before} → ${after})`);
  };

  moves('updateConsignment (Kopf)', () => cs().updateConsignment(cid, { notes: 'kopf' }));
  moves('updateConsignmentPayoutModel', () => cs().updateConsignmentPayoutModel(cid, { model: 'percent', commissionRate: 25 }));
  moves('markSold', () => cs().markSold(cid, 1200, undefined, 'cash'));
  moves('recordPartialPayout', () => cs().recordPartialPayout(cid, 100, 'cash'));
  moves('markPaidOut', () => cs().markPaidOut(cid, 'cash'));
  moves('markReturnedAfterSale', () => cs().markReturnedAfterSale(cid, 'RETURN_TO_OWNER'));
  const before = crev(db, cid);
  db.run("UPDATE consignments SET status = 'expired' WHERE id = ?", [cid]);
  ok(crev(db, cid) > before,
    `CONSIGN-COVERAGE auch der Tageslauf (rohes SQL) bewegt sie (${before} → ${crev(db, cid)})`);

  // Der BEFUND: es gibt keine Kindtabelle, die daran vorbeischreiben koennte.
  const schema = src('src/core/db/schema.sql') + src('src/core/db/database.ts');
  ok(!/CREATE TABLE IF NOT EXISTS consignment_[a-z_]+/.test(schema),
    'CONSIGN-COVERAGE es gibt keine Kommissions-Kindtabelle — die Zeile IST der Vorgang');
  const writers = [...src('src/stores/consignmentStore.ts').matchAll(/UPDATE consignments|updateConsignment\(/g)].length;
  ok(writers >= 8, `CONSIGN-COVERAGE und alle Schreiber gehen ueber die Zeile (${writers} Stellen)`);
}

// ── 7) Rennen: eine fremde Änderung entwertet den Fernauftrag ─────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  const created = await cmd.runOrderCreate(d, identity('40', 'orders.create'), ORDER);
  const oid = val<{ orderId: string }>(created).orderId;

  // Der Client liest die Fassung N …
  const seen = orev(db, oid);
  // … der Primary aendert eine POSITION (die Kopfzeile bleibt unberuehrt) …
  useOrderStore.getState().addOrderLine(oid, { description: 'Primary hat etwas ergaenzt', quantity: 1, unitPrice: 40 });
  // … und der Client speichert seinen Kopf mit N.
  const stale = await cmd.runOrderUpdate(d, identity('41', 'orders.update'), { id: oid, expectedRevision: seen, agreedPrice: 999 });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `RACE-ORDER eine geaenderte POSITION entwertet den Kopf-Auftrag (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true, 'RACE-ORDER …und das Urteil ist endgueltig');
  ok(n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]) !== 999, 'RACE-ORDER nichts wurde ueberschrieben');

  // Dasselbe mit einer Zahlung.
  const seen2 = orev(db, oid);
  useOrderPaymentStore.getState().addPayment({ orderId: oid, amount: 20, paidAt: NOW.split('T')[0], method: 'cash' } as never);
  const stale2 = await cmd.runOrderUpdate(d, identity('42', 'orders.update'), { id: oid, expectedRevision: seen2, notes: 'zu spaet' });
  ok(stale2.kind === 'rejected' && code(stale2) === 'RECORD_CHANGED',
    'RACE-ORDER eine Zahlung entwertet ihn ebenfalls');
}
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('50', 'consignments.create'), CONSIGN);
  const cid = val<{ consignmentId: string }>(created).consignmentId;
  const seen = crev(db, cid);
  // Eine ANDERE, nicht identische lokale Mutation.
  useConsignmentStore.getState().updateConsignment(cid, { expiryDate: '2027-01-01' });
  const stale = await cmd.runConsignmentUpdate(d, identity('51', 'consignments.update'),
    { id: cid, expectedRevision: seen, agreedPrice: 4444 });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `RACE-CONSIGN eine fremde Aenderung entwertet den Fernauftrag (${JSON.stringify(stale)})`);
  ok(n(db, 'SELECT agreed_price FROM consignments WHERE id = ?', [cid]) === 1000,
    'RACE-CONSIGN nichts wurde ueberschrieben');
}

// ── 8) Zwei Clients, dieselbe Fassung: genau einer gewinnt ────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5);
  const created = await executeCommand('orders.create', { input: ORDER }, identity('60', 'orders.create', 'a'));
  const oid = (created as { value: { orderId: string } }).value.orderId;
  const base = orev(db, oid);
  const [x, y] = await Promise.all([
    executeCommand('orders.update', { input: { id: oid, expectedRevision: base, agreedPrice: 111 } }, identity('61', 'orders.update', 'b')),
    executeCommand('orders.update', { input: { id: oid, expectedRevision: base, agreedPrice: 222 } }, identity('62', 'orders.update', 'c')),
  ]);
  ok([x, y].filter((r) => r.kind === 'ok').length === 1,
    `RACE-TWO genau einer gewinnt (${JSON.stringify([x.kind, y.kind])})`);
  const loser = [x, y].find((r) => r.kind !== 'ok');
  ok((loser as { code?: string })?.code === 'RECORD_CHANGED', 'RACE-TWO …und der andere bekommt eine Begruendung');
  const price = n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]);
  ok(price === 111 || price === 222, `RACE-TWO kein Lost Update (${price})`);

  const cCreated = await executeCommand('consignments.create', { input: CONSIGN }, identity('63', 'consignments.create', 'd'));
  const cid = (cCreated as { value: { consignmentId: string } }).value.consignmentId;
  const cbase = crev(db, cid);
  const [p, q] = await Promise.all([
    executeCommand('consignments.update', { input: { id: cid, expectedRevision: cbase, agreedPrice: 1111 } }, identity('64', 'consignments.update', 'e')),
    executeCommand('consignments.update', { input: { id: cid, expectedRevision: cbase, agreedPrice: 2222 } }, identity('65', 'consignments.update', 'f')),
  ]);
  ok([p, q].filter((r) => r.kind === 'ok').length === 1, 'RACE-TWO dasselbe bei der Kommission');
}

// ── 9) Negativkontrolle: die Kindtabellen-Deckung fehlt ───────────────────
//
// Ohne den Trigger auf `order_lines` bleibt die Fassung stehen, während sich der Vorgang darunter
// ändert — und der stale Fernauftrag geht klaglos durch. Genau das ist die Lücke.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  db.run('DROP TRIGGER IF EXISTS trg_order_lines_insert_order_revision');
  db.run('DROP TRIGGER IF EXISTS trg_order_lines_update_order_revision');
  db.run('DROP TRIGGER IF EXISTS trg_order_lines_delete_order_revision');
  const d = deps(db);
  seedProduct(db, 'p1', 5);
  const created = await cmd.runOrderCreate(d, identity('70', 'orders.create'), ORDER);
  const oid = val<{ orderId: string }>(created).orderId;
  const seen = orev(db, oid);
  db.run("UPDATE order_lines SET unit_price = 999, line_total = 999 WHERE order_id = ?", [oid]);
  ok(orev(db, oid) === seen,
    'CONTROL-E ohne den Trigger bewegt eine geaenderte POSITION die Fassung NICHT');
  const blind = await cmd.runOrderUpdate(d, identity('71', 'orders.update'), { id: oid, expectedRevision: seen, agreedPrice: 1 });
  ok(blind.kind === 'ok' && n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]) === 1,
    `CONTROL-E …und der stale Auftrag ueberschreibt klaglos (${JSON.stringify(blind)})`);
}

// ── 10) Der Umfang ist unveraendert ───────────────────────────────────────
{
  const { ALLOWED_MUTATIONS, knownCommands } = await import('../../src/core/bridge/command-registry.ts');
  await import('../../src/core/bridge/read-commands.ts');
  await import('../../src/core/bridge/customer-commands.ts');
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/return-commands.ts');
  await import('../../src/core/bridge/lifecycle-commands.ts');
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  // CENTRAL-C3H hat die sechzehn in C3G als `B_DEFERRED` klassifizierten Aktionen freigeschaltet.
  // Was DIESE Datei prueft, aendert sich dadurch nicht — nur die Zahlen ziehen mit, und die
  // Namen, die weiterhin NICHT drauf stehen duerfen, bleiben dieselben zerstoerenden.
  ok(known.length === 59 && reads.length === 18 && ALLOWED_MUTATIONS.length === 40,
    `SCOPE 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length}/${reads.length}/${ALLOWED_MUTATIONS.length})`);
  ok(!ALLOWED_MUTATIONS.includes('purchases.update'),
    'SCOPE der Einkauf bleibt Create-only — es gibt keinen lokalen Edit-Pfad');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3e final revision coverage: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

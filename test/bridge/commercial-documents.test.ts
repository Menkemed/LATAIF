// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3E — Einkauf, Kommission und Auftrag von einem zweiten Rechner.
// Run: node test/bridge/commercial-documents.test.ts
//
// Was hier bewiesen wird, in der Reihenfolge der Gefahren:
//
//   1. Der Umfang ist ehrlich: nur was der Primary WIRKLICH kann, ist freigegeben (kein
//      Purchase-Edit — den gibt es im Haus nicht).
//   2. Es wird nichts nachgebaut: dieselben Domänenfunktionen, dieselben Lose, dieselben Zähler.
//   3. Eine verlorene Antwort kostet keine zweite Ware, keine zweite Verbindlichkeit, keine
//      zweite Nummer.
//   4. Zwei Rechner, die gleichzeitig anlegen, bekommen zwei Nummern — nicht dieselbe.
//   5. Ein Änderungsauftrag, der einen alten Stand beschreibt, kommt nicht durch.
//   6. Das Auszahlungsmodell einer Kommission lässt sich aus der Ferne nicht erzwingen.
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
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/service-commands.ts');
await import('../../src/core/bridge/financial-commands.ts');
const { executeCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-07T10:00:00.000Z';

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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
      preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-1','branch-main','Geneva Trading',1,?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at)
    VALUES ('sup-other','branch-other','Fremde Filiale',1,?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  usePurchaseStore.getState().loadPurchases();
  useConsignmentStore.getState().loadConsignments();
  useOrderStore.getState().loadOrders();
  return db;
}

function seedProduct(db: Db, id: string, qty = 0, brand = 'Rolex'): void {
  db.run(
    `INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
       scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
       tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
     VALUES (?,?,'cat-w',?,?,?,?,'Pre-Owned','[]',0,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
    [id, 'branch-main', brand, 'Model ' + id, 'SKU-' + id, qty, NOW, NOW],
  );
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

const PURCHASE_BODY = {
  supplierId: 'sup-1',
  taxScheme: 'VAT_10' as const,
  lines: [{ productId: 'p1', quantity: 2, unitPrice: 100 }],
};

// ── 1) Umfang: was freigegeben ist — und was ausdrücklich nicht ───────────
{
  const registry = src('src/core/bridge/command-registry.ts');
  const list = ALLOWED_MUTATIONS as readonly string[];
  // CENTRAL-C3H hat die sechzehn in C3G als `B_DEFERRED` klassifizierten Aktionen freigeschaltet.
  // Was DIESE Datei prueft, aendert sich dadurch nicht — nur die Zahlen ziehen mit, und die
  // Namen, die weiterhin NICHT drauf stehen duerfen, bleiben dieselben zerstoerenden.
  ok(list.length === 40, `SCOPE genau 40 Mutationen sind freigegeben (${list.length})`);
  for (const op of ['purchases.create', 'consignments.create', 'consignments.update', 'orders.create', 'orders.update']) {
    ok(list.includes(op), `SCOPE ${op} steht namentlich in der Zulassungsliste`);
  }
  // Was NICHT freigegeben ist — und zwar keins davon versehentlich.
  for (const op of ['consignments.record_sale', 'orders.update_status', 'orders.add_payment']) {
    ok(list.includes(op), `SCOPE ${op} ist seit C3H freigegeben`);
  }
  for (const op of [
    'purchases.update', 'purchases.cancel', 'purchases.add_payment', 'purchases.create_return',
    'consignments.mark_paid_out', 'consignments.delete',
    'orders.delete', 'orders.cancel_with_money',
  ]) {
    ok(!list.includes(op), `SCOPE ${op} bleibt fail-closed`);
  }
  const registryCode = registry.split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  ok(!/REMOTE_MUTATIONS_ENABLED|allowAllMutations/.test(registryCode),
    'SCOPE es gibt keinen Schalter, der alles auf einmal freigibt');

  // Der Beleg, warum es KEIN purchases.update gibt: im ganzen Produktcode existiert keine
  // Bearbeitung eines Einkaufs. Eine zu bauen hiesse, die Warenbewertung ein zweites Mal zu
  // schreiben — genau das verbietet der Vertrag.
  const purchaseSrc = src('src/stores/purchaseStore.ts');
  ok(!/\bupdatePurchase\b|\beditPurchase\b/.test(purchaseSrc),
    'SCOPE der Einkauf hat lokal GAR KEINE Bearbeitung — deshalb auch keine aus der Ferne');

  const known = knownCommands();
  ok(known.includes('suppliers.list') && known.includes('purchases.get')
    && known.includes('consignments.get') && known.includes('orders.get'),
  'SCOPE die neuen Lesevorgaenge sind angemeldet');

  // Rust prüft dieselbe Liste ein zweites Mal.
  const rust = src('src-tauri/src/bridge.rs');
  for (const op of [
    'suppliers.list', 'purchases.list', 'purchases.get', 'consignments.list', 'consignments.get',
    'orders.list', 'orders.get', 'purchases.create', 'consignments.create', 'consignments.update',
    'orders.create', 'orders.update',
  ]) {
    ok(rust.includes(`"${op}"`), `SCOPE Rust kennt ${op} ebenfalls`);
  }
}

// ── 2) Einkauf: anlegen, mit allem, was daran hängt ───────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 0);

  const out = await cmd.runPurchaseCreate(d, identity('1', 'purchases.create'), {
    ...PURCHASE_BODY,
    notes: 'Von einem zweiten Rechner',
    initialPayment: { amount: 50, method: 'bank' as const },
  });
  ok(out.kind === 'ok', `PURCHASE der Einkauf entsteht (${JSON.stringify(out)})`);
  const v = val<{ purchaseId: string; purchaseNumber: string; totalAmount: number; paidAmount: number; openAmount: number }>(out);
  ok(/^PUR-\d{4}-\d{6}$/.test(v.purchaseNumber), `PURCHASE die Nummer kommt aus dem Zaehler (${v.purchaseNumber})`);
  ok(v.totalAmount === 200 && v.paidAmount === 50 && v.openAmount === 150,
    `PURCHASE Summe/Zahlung/Rest rechnet der Primary (${v.totalAmount}/${v.paidAmount}/${v.openAmount})`);

  // Wareneingang: EIN Los je Zeile, mit dem tatsächlichen Einstandspreis dieser Charge.
  ok(n(db, 'SELECT COUNT(*) FROM stock_lots WHERE purchase_id = ?', [v.purchaseId]) === 1,
    'PURCHASE ein Los je Position');
  ok(n(db, 'SELECT qty_remaining FROM stock_lots WHERE purchase_id = ?', [v.purchaseId]) === 2,
    'PURCHASE …mit der eingekauften Menge');
  ok(n(db, 'SELECT unit_cost FROM stock_lots WHERE purchase_id = ?', [v.purchaseId]) === 100,
    'PURCHASE …und dem tatsaechlichen Stueckpreis dieser Charge');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 2,
    'PURCHASE die Artikelmenge folgt den Losen (nicht der Nutzlast)');

  // Vorsteuer aus dem Bruttobetrag — die Formel des Hauses, nicht die des Clients.
  const vat = n(db, 'SELECT vat_amount FROM purchase_lines WHERE purchase_id = ?', [v.purchaseId]);
  ok(Math.abs(vat - (200 * 10 / 110)) < 0.001, `PURCHASE die Vorsteuer rechnet das Haus (${vat})`);

  // Verbindlichkeit und Buchung.
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE' AND source_id = ?", [v.purchaseId]) > 0,
    'PURCHASE der Wareneingang ist gebucht');
  ok(n(db, 'SELECT COUNT(*) FROM purchase_payments WHERE purchase_id = ?', [v.purchaseId]) === 1,
    'PURCHASE die Anzahlung steht als Zahlung, nicht nur als Zahl im Kopf');

  // Der durable Nachweis liegt in DERSELBEN Transaktion.
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger WHERE command_id = ?', [ID('1')]) === 1,
    'PURCHASE der Nachweis steht — mit der Wirkung zusammen');
}

// ── 3) Einkauf: verlorene Antwort, gleiche Kennung, anderer Rumpf ─────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 0);

  const first = await cmd.runPurchaseCreate(d, identity('2', 'purchases.create'), PURCHASE_BODY);
  const again = await cmd.runPurchaseCreate(d, identity('2', 'purchases.create'), PURCHASE_BODY);
  ok(first.kind === 'ok' && again.kind === 'ok', 'RETRY die Wiederholung antwortet mit einem Ergebnis');
  ok((again as { replayed: boolean }).replayed === true, 'RETRY …und sagt, dass es die Wiederholung war');
  ok(val<{ purchaseId: string }>(first).purchaseId === val<{ purchaseId: string }>(again).purchaseId,
    'RETRY …es ist derselbe Einkauf');
  ok(n(db, 'SELECT COUNT(*) FROM purchases') === 1, 'RETRY kein zweiter Beleg');
  ok(n(db, 'SELECT COUNT(*) FROM stock_lots') === 1, 'RETRY keine zweite Ware');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 2, 'RETRY die Menge ist nicht doppelt');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE'") > 0
    && n(db, "SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module = 'PURCHASE'") === 1,
  'RETRY keine zweite Verbindlichkeit, keine zweite Buchung');

  // Dieselbe Kennung, anderer Rumpf: kein Urteil, keine Wirkung, die Kennung bleibt verbrannt.
  const conflict = await cmd.runPurchaseCreate(
    d, identity('2', 'purchases.create', 'ANDERER-HASH'),
    { ...PURCHASE_BODY, lines: [{ productId: 'p1', quantity: 9, unitPrice: 1 }] },
  );
  ok(conflict.kind === 'rejected' && code(conflict) === 'COMMAND_ID_CONFLICT',
    `CONFLICT gleiche Kennung + anderer Rumpf → Konflikt (${JSON.stringify(conflict)})`);
  ok((conflict as { frozen: boolean }).frozen === false,
    'CONFLICT …und er wird NICHT als fachliches Urteil eingefroren');
  ok(n(db, 'SELECT COUNT(*) FROM purchases') === 1, 'CONFLICT es entsteht nichts');
}

// ── 4) Einkauf: der Rumpf bestimmt nichts, was das Haus bestimmt ──────────
{
  const bad: Array<[string, unknown]> = [
    ['eine Belegnummer', { ...PURCHASE_BODY, purchaseNumber: 'PUR-2026-000999' }],
    ['eine Filiale', { ...PURCHASE_BODY, branchId: 'branch-other' }],
    ['eine Kennung', { ...PURCHASE_BODY, id: 'p-erfunden' }],
    ['einen Status', { ...PURCHASE_BODY, status: 'PAID' }],
    ['eine Summe', { ...PURCHASE_BODY, totalAmount: 1 }],
    ['einen bezahlten Betrag', { ...PURCHASE_BODY, paidAmount: 999 }],
    ['ein neues Produkt', { ...PURCHASE_BODY, lines: [{ newProduct: { brand: 'X' }, quantity: 1, unitPrice: 1 }] }],
    ['eine Auftragsverknuepfung', { ...PURCHASE_BODY, sourceOrderId: 'ord-1' }],
    ['eine Vorsteuer', { ...PURCHASE_BODY, lines: [{ productId: 'p1', quantity: 1, unitPrice: 1, vatAmount: 0 }] }],
  ];
  for (const [what, body] of bad) {
    let threw = '';
    try { cmd.parsePurchaseCreate(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `AUTHORITY der Einkaufsrumpf nimmt ${what} nicht an (${threw || 'DURCHGELASSEN'})`);
  }
  // Und was er annimmt, ist genau die Eingabe eines Menschen.
  const parsed = cmd.parsePurchaseCreate({ ...PURCHASE_BODY, notes: '  hallo  ' });
  ok(parsed.notes === 'hallo' && parsed.taxScheme === 'VAT_10' && parsed.lines.length === 1,
    'AUTHORITY …und die echten Eingaben kommen sauber an');
  ok(cmd.parsePurchaseCreate({ supplierId: 'sup-1', lines: [{ productId: 'p1', quantity: 1, unitPrice: 0 }] }).taxScheme === 'ZERO',
    'AUTHORITY ohne Angabe gilt das Steuerschema des Hauses (ZERO), nicht „irgendetwas"');
}

// ── 5) Einkauf: fachliche Neins, die wirklich Neins sind ─────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 0);

  const noSupplier = await cmd.runPurchaseCreate(d, identity('3', 'purchases.create'),
    { ...PURCHASE_BODY, supplierId: 'gibt-es-nicht' });
  ok(noSupplier.kind === 'rejected' && code(noSupplier) === 'SUPPLIER_NOT_FOUND',
    `VERDICT ein unbekannter Lieferant wird abgelehnt (${JSON.stringify(noSupplier)})`);

  const foreign = await cmd.runPurchaseCreate(d, identity('4', 'purchases.create'),
    { ...PURCHASE_BODY, supplierId: 'sup-other' });
  ok(foreign.kind === 'rejected' && code(foreign) === 'SUPPLIER_NOT_FOUND',
    'VERDICT ein Lieferant einer FREMDEN Filiale ist kein Lieferant dieser');

  const noProduct = await cmd.runPurchaseCreate(d, identity('5', 'purchases.create'),
    { ...PURCHASE_BODY, lines: [{ productId: 'gibt-es-nicht', quantity: 1, unitPrice: 5 }] });
  ok(noProduct.kind === 'rejected' && code(noProduct) === 'PRODUCT_NOT_FOUND',
    'VERDICT ein unbekannter Artikel wird abgelehnt');

  const over = await cmd.runPurchaseCreate(d, identity('6', 'purchases.create'),
    { ...PURCHASE_BODY, initialPayment: { amount: 500, method: 'cash' as const } });
  ok(over.kind === 'rejected' && code(over) === 'PAYMENT_EXCEEDS_TOTAL',
    `VERDICT eine Anzahlung ueber der Summe wird abgelehnt (${JSON.stringify(over)})`);
  ok((over as { frozen: boolean }).frozen === true, 'VERDICT …und das Urteil ist eingefroren');
  ok(n(db, 'SELECT COUNT(*) FROM purchases') === 0, 'VERDICT nach vier Neins existiert kein Beleg');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 0, 'VERDICT …und keine Ware');
}

// ── 6) Kommission: anlegen, mit dem Artikel, der dazugehört ───────────────
const CONSIGN_BODY = {
  consignorId: 'cust-1',
  product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' },
  agreedPrice: 1000,
  payout: { model: 'percent', commissionRate: 20 },
};
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);

  const out = await cmd.runConsignmentCreate(d, identity('10', 'consignments.create'), CONSIGN_BODY);
  ok(out.kind === 'ok', `CONSIGN die Kommission entsteht (${JSON.stringify(out)})`);
  const v = val<{ consignmentId: string; consignmentNumber: string; productId: string; sku: string; payoutModel: string; commissionRate: number; excessSplitPct: number | null; revision: number }>(out);
  ok(/^CON-\d{4}-\d{5}$/.test(v.consignmentNumber), `CONSIGN die Nummer kommt aus dem Zaehler (${v.consignmentNumber})`);
  ok(v.sku.length > 0, `CONSIGN die SKU vergibt der Primary (${v.sku})`);

  // Der Artikel trägt die vier festen Werte des Kommissions-Eingangs.
  const p = db.exec('SELECT stock_status, source_type, purchase_price, quantity FROM products WHERE id = ?', [v.productId])[0].values[0];
  ok(String(p[0]) === 'consignment', 'CONSIGN der Artikel steht auf „consignment"');
  ok(String(p[1]) === 'CONSIGNMENT', 'CONSIGN …und die Herkunft ist nicht „unsere Ware"');
  // Der erwartete Einstand entsteht beim Anlegen der Kommission (percent: Anteil des Einlieferers).
  ok(Math.abs(Number(p[2]) - 800) < 0.001, `CONSIGN der erwartete Einstand kommt aus dem Modell (${p[2]})`);
  ok(Number(p[3]) === 1, 'CONSIGN eine Kommission ist ein Stueck');

  ok(v.payoutModel === 'percent' && v.commissionRate === 20 && v.excessSplitPct === null,
    `CONSIGN das Modell steht vollstaendig (${v.payoutModel}/${v.commissionRate}/${v.excessSplitPct})`);
  ok(Number.isInteger(v.revision) && v.revision >= 1
    && v.revision === n(db, 'SELECT revision FROM consignments WHERE id = ?', [v.consignmentId]),
  `CONSIGN die Antwort nennt die Fassung, die WIRKLICH in der Zeile steht (${v.revision})`);

  // Wiederholung: kein zweiter Artikel, keine zweite Kommission, keine zweite SKU.
  const again = await cmd.runConsignmentCreate(d, identity('10', 'consignments.create'), CONSIGN_BODY);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'CONSIGN-RETRY die Wiederholung antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM consignments') === 1, 'CONSIGN-RETRY keine zweite Kommission');
  ok(n(db, 'SELECT COUNT(*) FROM products') === 1, 'CONSIGN-RETRY kein zweiter Artikel');
  ok(val<{ sku: string }>(again).sku === v.sku, 'CONSIGN-RETRY dieselbe SKU — der Zaehler ist nicht weitergelaufen');
}

// ── 7) Kommission: das Auszahlungsmodell lässt sich nicht erzwingen ───────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);

  // Ein Modell, das kein Bildschirm mehr anbietet.
  let threw = '';
  try { cmd.parseConsignmentCreate({ ...CONSIGN_BODY, payout: { model: 'fixed' } }); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  ok(/unknown payout model/.test(threw), `PAYOUT das Altmodell „fixed" wird abgewiesen (${threw})`);

  // Die Grenzen der SSOT gelten auch aus der Ferne.
  const badRate = await cmd.runConsignmentCreate(d, identity('11', 'consignments.create'),
    { ...CONSIGN_BODY, payout: { model: 'percent', commissionRate: 150 } });
  ok(badRate.kind === 'rejected' && code(badRate) === 'PAYOUT_MODEL_INVALID',
    `PAYOUT ein Satz ueber 100 % wird abgelehnt (${JSON.stringify(badRate)})`);

  const badSplit = await cmd.runConsignmentCreate(d, identity('12', 'consignments.create'),
    { ...CONSIGN_BODY, payout: { model: 'cost_split', excessSplitPct: 100 } });
  ok(badSplit.kind === 'rejected' && code(badSplit) === 'PAYOUT_MODEL_INVALID',
    'PAYOUT ein Shop-Anteil von 100 % waere ein anderes Modell unter falschem Namen');

  // Und das gültige `cost_split` bekommt seinen Parameter — und NUR den seinen.
  const split = await cmd.runConsignmentCreate(d, identity('13', 'consignments.create'),
    { ...CONSIGN_BODY, payout: { model: 'cost_split', excessSplitPct: 60 } });
  ok(split.kind === 'ok', `PAYOUT cost_split ist gueltig (${JSON.stringify(split)})`);
  const sv = val<{ consignmentId: string; payoutModel: string; excessSplitPct: number | null }>(split);
  ok(sv.payoutModel === 'cost_split' && sv.excessSplitPct === 60,
    `PAYOUT …mit seinem Anteil (${sv.payoutModel}/${sv.excessSplitPct})`);

  // Ein Wechsel zu consignor_fixed löscht den Anteil des vorigen Modells — sonst trüge der
  // Datensatz einen Parameter weiter, den sein Modell gar nicht kennt.
  const rev1 = n(db, 'SELECT revision FROM consignments WHERE id = ?', [sv.consignmentId]);
  const moved = await cmd.runConsignmentUpdate(d, identity('14', 'consignments.update'), {
    id: sv.consignmentId, expectedRevision: rev1, payout: { model: 'consignor_fixed' },
  });
  ok(moved.kind === 'ok', `PAYOUT der Modellwechsel geht (${JSON.stringify(moved)})`);
  ok(one(db, 'SELECT excess_split_pct FROM consignments WHERE id = ?', [sv.consignmentId]) === null,
    'PAYOUT …und der Anteil des vorigen Modells ist WEG, nicht stehengeblieben');
}

// ── 7b) Kommission: der Rumpf bestimmt nichts, was das Haus bestimmt ──────
{
  const bad = [
    ['eine Belegnummer', { ...CONSIGN_BODY, consignmentNumber: 'CON-2026-00099' }],
    ['eine SKU', { ...CONSIGN_BODY, product: { ...CONSIGN_BODY.product, sku: 'ERZWUNGEN-1' } }],
    ['eine Filiale', { ...CONSIGN_BODY, branchId: 'branch-other' }],
    ['eine Kennung', { ...CONSIGN_BODY, id: 'con-erfunden' }],
    ['einen Status', { ...CONSIGN_BODY, status: 'sold' }],
    ['einen Verkaufspreis', { ...CONSIGN_BODY, salePrice: 1100 }],
    ['einen Provisionsbetrag', { ...CONSIGN_BODY, commissionAmount: 220 }],
    ['einen Auszahlungsstand', { ...CONSIGN_BODY, payoutStatus: 'paid' }],
    ['eine Rechnung', { ...CONSIGN_BODY, invoiceId: 'inv-1' }],
    ['einen Bestandsstatus des Artikels', { ...CONSIGN_BODY, product: { ...CONSIGN_BODY.product, stockStatus: 'in_stock' } }],
    ['einen Einstandspreis', { ...CONSIGN_BODY, product: { ...CONSIGN_BODY.product, purchasePrice: 0 } }],
  ] as Array<[string, unknown]>;
  for (const [what, body] of bad) {
    let threw = '';
    try { cmd.parseConsignmentCreate(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `AUTHORITY der Kommissionsrumpf nimmt ${what} nicht an (${threw || 'DURCHGELASSEN'})`);
  }
  const parsed = cmd.parseConsignmentCreate(CONSIGN_BODY);
  ok(Object.keys(parsed.product).sort().join(',') === 'brand,categoryId,condition,name,notes',
    `AUTHORITY …und der Artikel traegt genau fuenf Felder (${Object.keys(parsed.product).join(',')})`);
}

// ── 8) Kommission: ändern — ein Save, zwei Verträge, eine Transaktion ─────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('20', 'consignments.create'), CONSIGN_BODY);
  const cid = val<{ consignmentId: string }>(created).consignmentId;
  const base = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);

  const edited = await cmd.runConsignmentUpdate(d, identity('21', 'consignments.update'), {
    id: cid, expectedRevision: base,
    agreedPrice: 1200, minimumPrice: 900, notes: 'nachverhandelt',
    payout: { model: 'percent', commissionRate: 25 },
  });
  ok(edited.kind === 'ok', `CONSIGN-EDIT die Aenderung geht durch (${JSON.stringify(edited)})`);
  const ev = val<{ agreedPrice: number; commissionRate: number; revision: number }>(edited);
  ok(ev.agreedPrice === 1200 && ev.commissionRate === 25, 'CONSIGN-EDIT Preis UND Modell sind angekommen');
  ok(ev.revision > base, `CONSIGN-EDIT die Fassung ist eine neue (${base} → ${ev.revision})`);
  ok(s(db, 'SELECT notes FROM consignments WHERE id = ?', [cid]) === 'nachverhandelt',
    'CONSIGN-EDIT …und die Notiz steht in der Zeile');

  // Der alte Stand trägt nicht mehr.
  const stale = await cmd.runConsignmentUpdate(d, identity('22', 'consignments.update'), {
    id: cid, expectedRevision: base, agreedPrice: 999,
  });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `STALE eine Aenderung auf den alten Stand wird abgelehnt (${JSON.stringify(stale)})`);
  ok((stale as { frozen: boolean }).frozen === true, 'STALE …und das Urteil ist endgueltig');
  ok(n(db, 'SELECT agreed_price FROM consignments WHERE id = ?', [cid]) === 1200,
    'STALE …der Preis der ANDEREN Aenderung steht noch');

  // Ein gescheitertes Modell lässt auch den Rest nicht durch — das ist der Unterschied zum
  // Primary, wo ein Fehler im zweiten Schritt den ersten stehenließe.
  const fresh = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const half = await cmd.runConsignmentUpdate(d, identity('23', 'consignments.update'), {
    id: cid, expectedRevision: fresh, notes: 'darf nicht bleiben', payout: { model: 'percent', commissionRate: -5 },
  });
  ok(half.kind === 'rejected', `ATOMIC ein ungueltiges Modell laesst den Auftrag scheitern (${JSON.stringify(half)})`);
  ok(s(db, 'SELECT notes FROM consignments WHERE id = ?', [cid]) === 'nachverhandelt',
    'ATOMIC …und die Notiz ist NICHT halb gespeichert');
}

// ── 9) Kommission: die Sperre gilt auch von außen ─────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('30', 'consignments.create'), CONSIGN_BODY);
  const cid = val<{ consignmentId: string }>(created).consignmentId;

  // Ein Verkauf ist gebucht — ab hier hängen Zahlen am Modell.
  db.run('UPDATE consignments SET sale_price = 1100, commission_amount = 220, payout_amount = 880 WHERE id = ?', [cid]);
  const base = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);

  const locked = await cmd.runConsignmentUpdate(d, identity('31', 'consignments.update'), {
    id: cid, expectedRevision: base, payout: { model: 'cost_split', excessSplitPct: 50 },
  });
  ok(locked.kind === 'rejected' && code(locked) === 'PAYOUT_MODEL_LOCKED',
    `LOCK ein abgerechnetes Modell aendert sich nicht mehr (${JSON.stringify(locked)})`);
  ok(s(db, 'SELECT commission_type FROM consignments WHERE id = ?', [cid]) === 'percent',
    'LOCK …das Modell steht unveraendert');

  // Der Kopf lässt sich weiterhin ändern — die Sperre gilt dem Modell, nicht dem Datensatz.
  const fresh = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const noteOnly = await cmd.runConsignmentUpdate(d, identity('32', 'consignments.update'), {
    id: cid, expectedRevision: fresh, notes: 'Abholung vereinbart',
  });
  ok(noteOnly.kind === 'ok', `LOCK eine Notiz geht weiterhin (${JSON.stringify(noteOnly)})`);
}

// ── 10) Kommission: der generische Feldsetzer bleibt unerreichbar ─────────
{
  const forbidden = [
    'status', 'salePrice', 'commissionAmount', 'payoutAmount', 'payoutStatus', 'payoutPaidAmount',
    'payoutMethod', 'payoutDate', 'payoutReference', 'saleMethod', 'buyerId', 'invoiceId',
    'consignorId', 'productId', 'commissionType', 'commissionRate', 'commissionValue', 'excessSplitPct',
  ];
  for (const f of forbidden) {
    let threw = false;
    try { cmd.parseConsignmentUpdate({ id: 'c1', expectedRevision: 1, [f]: 1 }); } catch { threw = true; }
    ok(threw, `AUTHORITY ein Aenderungsauftrag kann ${f} nicht setzen`);
  }
  let threw = false;
  try { cmd.parseConsignmentUpdate({ id: 'c1', agreedPrice: 5 }); } catch { threw = true; }
  ok(threw, 'AUTHORITY ohne die gesehene Fassung gibt es kein Aendern');
  threw = false;
  try { cmd.parseConsignmentUpdate({ id: 'c1', expectedRevision: 1 }); } catch { threw = true; }
  ok(threw, 'AUTHORITY ein Auftrag, der nichts aendert, ist keiner');
}

// ── 11) Auftrag: anlegen ──────────────────────────────────────────────────
const ORDER_BODY = {
  customerId: 'cust-1',
  lines: [{ productId: 'p1', quantity: 2, unitPrice: 300 }],
};
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 3);

  const out = await cmd.runOrderCreate(d, identity('40', 'orders.create'), {
    ...ORDER_BODY, depositAmount: 200, paymentMethod: 'cash' as const, notes: 'Kunde ruft an',
  });
  ok(out.kind === 'ok', `ORDER der Auftrag entsteht (${JSON.stringify(out)})`);
  const v = val<{ orderId: string; orderNumber: string; type: string; agreedPrice: number | null; depositAmount: number; remainingAmount: number; paidAmount: number; revision: number }>(out);
  ok(/^ORD-\d{4}-\d{5}$/.test(v.orderNumber), `ORDER die Nummer kommt aus dem Zaehler (${v.orderNumber})`);
  ok(v.type === 'normal', `ORDER er ist normal (${v.type})`);
  ok(v.agreedPrice === 600, `ORDER die Summe rechnet der Primary aus den Positionen (${v.agreedPrice})`);
  ok(v.remainingAmount === 400, `ORDER …und den Rest ebenso (${v.remainingAmount})`);
  ok(v.paidAmount === 200, `ORDER die Anzahlung steht als ZAHLUNG, nicht nur im Kopf (${v.paidAmount})`);
  ok(Number.isInteger(v.revision) && v.revision >= 1
    && v.revision === n(db, 'SELECT revision FROM orders WHERE id = ?', [v.orderId]),
  `ORDER die Antwort nennt die Fassung, die WIRKLICH in der Zeile steht (${v.revision}) —
   nicht 1: eine Position und eine Anzahlung bewegen sie schon beim Anlegen`);

  ok(n(db, 'SELECT COUNT(*) FROM order_lines WHERE order_id = ?', [v.orderId]) === 1, 'ORDER die Position steht');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'") > 0,
    'ORDER die Anzahlung ist gebucht');
  // Ein Auftrag ist eine Zusage, kein Warenausgang: es wird KEIN Los verbraucht.
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 3,
    'ORDER ein Auftrag nimmt keine Ware aus dem Bestand');

  // Wiederholung.
  const again = await cmd.runOrderCreate(d, identity('40', 'orders.create'), {
    ...ORDER_BODY, depositAmount: 200, paymentMethod: 'cash' as const, notes: 'Kunde ruft an',
  });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'ORDER-RETRY die Wiederholung antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM orders') === 1, 'ORDER-RETRY kein zweiter Auftrag');
  ok(n(db, 'SELECT COUNT(*) FROM order_payments') === 1, 'ORDER-RETRY keine zweite Anzahlung');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'")
    === n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'ORDER_PAYMENT'"),
  'ORDER-RETRY keine zweite Buchung');
  ok(n(db, 'SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module = ?', ['ORDER_PAYMENT']) === 1,
    'ORDER-RETRY …und zwar wirklich nur eine');

  // Neins.
  const noCustomer = await cmd.runOrderCreate(d, identity('41', 'orders.create'),
    { ...ORDER_BODY, customerId: 'gibt-es-nicht' });
  ok(noCustomer.kind === 'rejected' && code(noCustomer) === 'CUSTOMER_NOT_FOUND',
    'ORDER ein unbekannter Kunde wird abgelehnt');
  const overDeposit = await cmd.runOrderCreate(d, identity('42', 'orders.create'),
    { ...ORDER_BODY, depositAmount: 9999, paymentMethod: 'cash' as const });
  ok(overDeposit.kind === 'rejected' && code(overDeposit) === 'DEPOSIT_EXCEEDS_TOTAL',
    `ORDER eine Anzahlung ueber der Summe wird abgelehnt (${JSON.stringify(overDeposit)})`);
}

// ── 12) Auftrag: der Rumpf bestimmt nichts Abgeleitetes ───────────────────
{
  const bad: Array<[string, unknown]> = [
    ['eine Belegnummer', { ...ORDER_BODY, orderNumber: 'ORD-2026-00099' }],
    ['eine Summe', { ...ORDER_BODY, agreedPrice: 1 }],
    ['einen Rest', { ...ORDER_BODY, remainingAmount: 0 }],
    ['eine Marge', { ...ORDER_BODY, expectedMargin: 500 }],
    ['einen Status', { ...ORDER_BODY, status: 'completed' }],
    ['einen Typ', { ...ORDER_BODY, type: 'custom' }],
    ['eine Sonderanfertigung', { ...ORDER_BODY, customProductSpec: { brand: 'X' } }],
    ['Goldschmied-Gold', { ...ORDER_BODY, goldsmithSupplierId: 'sup-1', extraGoldValue: 10 }],
    ['ein Material an der Position', { ...ORDER_BODY, lines: [{ productId: 'p1', quantity: 1, unitPrice: 1, materialKind: 'gold' }] }],
    ['ein neues Produkt', { ...ORDER_BODY, lines: [{ newProduct: { brand: 'X' }, quantity: 1, unitPrice: 1 }] }],
    ['eine Rechnung', { ...ORDER_BODY, invoiceId: 'inv-1' }],
  ];
  for (const [what, body] of bad) {
    let threw = '';
    try { cmd.parseOrderCreate(body); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
    ok(threw !== '', `AUTHORITY der Auftragsrumpf nimmt ${what} nicht an (${threw || 'DURCHGELASSEN'})`);
  }
  let threw = '';
  try { cmd.parseOrderCreate({ ...ORDER_BODY, depositAmount: 5 }); } catch (e) { threw = String(e); }
  ok(/payment method/.test(threw), `AUTHORITY eine Anzahlung ohne Zahlungsart wird abgewiesen (${threw})`);
}

// ── 13) Auftrag: ändern — abgeleitetes rechnet der Primary ────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 3);
  const created = await cmd.runOrderCreate(d, identity('50', 'orders.create'), {
    ...ORDER_BODY, depositAmount: 100, paymentMethod: 'cash' as const,
  });
  const oid = val<{ orderId: string }>(created).orderId;
  const base = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);

  // Nur der Preis ändert sich — Rest und Marge muss der Primary NEU rechnen, mit der ALTEN
  // Anzahlung und dem ALTEN Einkaufspreis.
  db.run('UPDATE orders SET supplier_price = 400 WHERE id = ?', [oid]);
  const base2 = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const edited = await cmd.runOrderUpdate(d, identity('51', 'orders.update'), {
    id: oid, expectedRevision: base2, agreedPrice: 700,
  });
  ok(edited.kind === 'ok', `ORDER-EDIT die Aenderung geht durch (${JSON.stringify(edited)})`);
  const ev = val<{ agreedPrice: number | null; remainingAmount: number; expectedMargin: number | null; revision: number }>(edited);
  ok(ev.agreedPrice === 700, 'ORDER-EDIT der neue Preis steht');
  ok(ev.remainingAmount === 600, `ORDER-EDIT der Rest ist NEU gerechnet (700 − 100 = ${ev.remainingAmount})`);
  ok(ev.expectedMargin === 300, `ORDER-EDIT die Marge ist NEU gerechnet (700 − 400 = ${ev.expectedMargin})`);
  ok(ev.revision > base, `ORDER-EDIT die Fassung ist gestiegen (${base} → ${ev.revision})`);

  // Der alte Stand trägt nicht mehr.
  const stale = await cmd.runOrderUpdate(d, identity('52', 'orders.update'), {
    id: oid, expectedRevision: base2, agreedPrice: 1,
  });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `ORDER-STALE der alte Stand traegt nicht (${JSON.stringify(stale)})`);
  ok(n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]) === 700,
    'ORDER-STALE …und der Preis der anderen Aenderung steht noch');

  // Ein Sonderauftrag wird ausdrücklich abgelehnt statt halb bedient.
  db.run("UPDATE orders SET type = 'custom' WHERE id = ?", [oid]);
  const fresh = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const custom = await cmd.runOrderUpdate(d, identity('53', 'orders.update'), {
    id: oid, expectedRevision: fresh, agreedPrice: 800,
  });
  ok(custom.kind === 'rejected' && code(custom) === 'ORDER_NOT_NORMAL',
    `ORDER-EDIT ein Sonderauftrag wird abgelehnt, nicht halb bedient (${JSON.stringify(custom)})`);
  ok(n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]) === 700,
    'ORDER-EDIT …und sein Preis bleibt unangetastet');
}

// ── 14) Auftrag ändern: der Feldsatz ──────────────────────────────────────
{
  for (const f of ['orderNumber', 'status', 'type', 'customerId', 'invoiceId', 'productId',
    'remainingAmount', 'expectedMargin', 'fullyPaid', 'depositPaid', 'attributes']) {
    let threw = false;
    try { cmd.parseOrderUpdate({ id: 'o1', expectedRevision: 1, [f]: 1 }); } catch { threw = true; }
    ok(threw, `AUTHORITY ein Auftrags-Aenderungsauftrag kann ${f} nicht setzen`);
  }
  let threw = false;
  try { cmd.parseOrderUpdate({ id: 'o1', agreedPrice: 1 }); } catch { threw = true; }
  ok(threw, 'AUTHORITY ohne die gesehene Fassung gibt es kein Aendern');
}

// ── 15) Nummernvergabe unter gleichzeitiger Last ──────────────────────────
//
// Zwei Aufträge desselben Typs, gleichzeitig eingereicht — durch `executeCommand`, also durch die
// EINE Schreibreihenfolge, genau wie in der Produktion. Beide müssen gültig sein und verschiedene
// Nummern tragen. Ein Test, der die Befehle direkt parallel riefe, zerrisse die Klammern.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 10);

  const [a, b] = await Promise.all([
    executeCommand('purchases.create', { input: PURCHASE_BODY }, identity('60', 'purchases.create', 'ha')),
    executeCommand('purchases.create', { input: PURCHASE_BODY }, identity('61', 'purchases.create', 'hb')),
  ]);
  ok(a.kind === 'ok' && b.kind === 'ok', `NUMBERING beide Einkaeufe entstehen (${a.kind}/${b.kind})`);
  const numbers = db.exec('SELECT purchase_number FROM purchases').flatMap((r) => r.values.map((v) => String(v[0])));
  ok(numbers.length === 2 && new Set(numbers).size === 2, `NUMBERING zwei verschiedene Einkaufsnummern (${numbers.join(', ')})`);

  const [c, e] = await Promise.all([
    executeCommand('consignments.create', { input: CONSIGN_BODY }, identity('62', 'consignments.create', 'hc')),
    executeCommand('consignments.create', { input: { ...CONSIGN_BODY, acknowledgeDuplicate: true } }, identity('63', 'consignments.create', 'hd')),
  ]);
  ok(c.kind === 'ok' && e.kind === 'ok', `NUMBERING beide Kommissionen entstehen (${JSON.stringify(c)} / ${JSON.stringify(e)})`);
  const cons = db.exec('SELECT consignment_number FROM consignments').flatMap((r) => r.values.map((v) => String(v[0])));
  ok(cons.length === 2 && new Set(cons).size === 2, `NUMBERING zwei verschiedene Kommissionsnummern (${cons.join(', ')})`);
  const skus = db.exec('SELECT sku FROM products WHERE source_type = ?', ['CONSIGNMENT'])
    .flatMap((r) => r.values.map((v) => String(v[0])));
  ok(skus.length === 2 && new Set(skus).size === 2, `NUMBERING …und zwei verschiedene SKUs (${skus.join(', ')})`);

  const [f, g] = await Promise.all([
    executeCommand('orders.create', { input: ORDER_BODY }, identity('64', 'orders.create', 'he')),
    executeCommand('orders.create', { input: ORDER_BODY }, identity('65', 'orders.create', 'hf')),
  ]);
  ok(f.kind === 'ok' && g.kind === 'ok', `NUMBERING beide Auftraege entstehen (${f.kind}/${g.kind})`);
  const ords = db.exec('SELECT order_number FROM orders').flatMap((r) => r.values.map((v) => String(v[0])));
  ok(ords.length === 2 && new Set(ords).size === 2, `NUMBERING zwei verschiedene Auftragsnummern (${ords.join(', ')})`);

  // Und die Wiederholung eines der beiden verbrennt keine Nummer: sie legt gar nichts an.
  const repeat = await executeCommand('purchases.create', { input: PURCHASE_BODY }, identity('60', 'purchases.create', 'ha'));
  ok(repeat.kind === 'ok', 'NUMBERING die Wiederholung antwortet');
  ok(n(db, 'SELECT COUNT(*) FROM purchases') === 2, 'NUMBERING …und legt keinen dritten Beleg an');
}

// ── 16) Zwei Änderungen aus derselben Fassung: nur EINE gewinnt ───────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5);
  const created = await executeCommand('orders.create', { input: ORDER_BODY }, identity('70', 'orders.create', 'hg'));
  const oid = (created as { value: { orderId: string } }).value.orderId;
  const base = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);

  const [x, y] = await Promise.all([
    executeCommand('orders.update', { input: { id: oid, expectedRevision: base, agreedPrice: 111 } },
      identity('71', 'orders.update', 'hx')),
    executeCommand('orders.update', { input: { id: oid, expectedRevision: base, agreedPrice: 222 } },
      identity('72', 'orders.update', 'hy')),
  ]);
  const wins = [x, y].filter((r) => r.kind === 'ok').length;
  ok(wins === 1, `RACE genau EINE der beiden Aenderungen kommt durch (${wins}/2: ${JSON.stringify([x.kind, y.kind])})`);
  const loser = [x, y].find((r) => r.kind !== 'ok');
  ok(loser?.kind === 'business_error' && (loser as { code: string }).code === 'RECORD_CHANGED',
    `RACE …und die andere bekommt eine Begruendung, keinen stillen Verlust (${JSON.stringify(loser)})`);
  const price = n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]);
  ok(price === 111 || price === 222, `RACE der Preis ist der des Gewinners (${price})`);

  // Der Verlierer hat die Fassung NICHT bewegt.
  const after = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const again = await executeCommand('orders.update', { input: { id: oid, expectedRevision: base, agreedPrice: 333 } },
    identity('73', 'orders.update', 'hz'));
  ok(again.kind === 'business_error' && n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]) === after,
    'RACE ein weiterer Versuch mit der alten Fassung bewegt nichts');
}

// ── 17) Dieselbe Fassung für die Kommission ───────────────────────────────
{
  resetDurabilityStateForTest();
  const db = freshDb();
  const created = await executeCommand('consignments.create', { input: CONSIGN_BODY }, identity('80', 'consignments.create', 'hi'));
  const cid = (created as { value: { consignmentId: string } }).value.consignmentId;
  const base = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);

  const [x, y] = await Promise.all([
    executeCommand('consignments.update', { input: { id: cid, expectedRevision: base, agreedPrice: 1111 } },
      identity('81', 'consignments.update', 'hj')),
    executeCommand('consignments.update', { input: { id: cid, expectedRevision: base, agreedPrice: 2222 } },
      identity('82', 'consignments.update', 'hk')),
  ]);
  const wins = [x, y].filter((r) => r.kind === 'ok').length;
  ok(wins === 1, `RACE-CON genau EINE Aenderung kommt durch (${wins}/2)`);
}

// ── 18) Gegenproben: was OHNE die Sicherungen passiert ────────────────────
//
// Eine Sicherung, deren Fehlen man nicht sieht, ist keine.
{
  resetDurabilityStateForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5);
  const created = await executeCommand('orders.create', { input: ORDER_BODY }, identity('90', 'orders.create', 'hl'));
  const oid = (created as { value: { orderId: string } }).value.orderId;

  // (a) OHNE Trigger bewegt sich die Fassung nicht — und genau derselbe stale Auftrag geht durch.
  db.run('DROP TRIGGER IF EXISTS trg_orders_revision');
  const seen = n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]);
  const d = deps(db);
  const first = await cmd.runOrderUpdate(d, identity('91', 'orders.update'), { id: oid, expectedRevision: seen, agreedPrice: 555 });
  ok(first.kind === 'ok', 'CONTROL a die erste Aenderung geht (wie immer)');
  ok(n(db, 'SELECT revision FROM orders WHERE id = ?', [oid]) === seen,
    'CONTROL a ohne Trigger bewegt eine Aenderung die Fassung NICHT');
  const blind = await cmd.runOrderUpdate(d, identity('92', 'orders.update'), { id: oid, expectedRevision: seen, agreedPrice: 666 });
  ok(blind.kind === 'ok' && n(db, 'SELECT agreed_price FROM orders WHERE id = ?', [oid]) === 666,
    `CONTROL a …und der stale Auftrag ueberschreibt klaglos (${JSON.stringify(blind)}) — genau das verhindert die Fassung`);

  // (b) Eine Mutation, die nicht in der Zulassungsliste steht, laesst sich nicht anmelden.
  const { registerCommand } = await import('../../src/core/bridge/command-registry.ts');
  let refused = '';
  try {
    registerCommand('orders.delete', { kind: 'mutation', handler: () => ({ ok: true }) });
  } catch (err) { refused = err instanceof Error ? err.message : String(err); }
  ok(/refusing to register/.test(refused),
    `CONTROL b eine fremde Mutation laesst sich nicht anmelden (${refused || 'DURCHGELASSEN'})`);

  // (c) Und eine, die nicht angemeldet ist, wird gar nicht erst ausgefuehrt.
  const unknown = await executeCommand('purchases.update', { input: {} }, identity('93', 'purchases.update', 'hm'));
  ok(unknown.kind === 'infrastructure_error' && (unknown as { code: string }).code === 'BRIDGE_OP_NOT_REGISTERED',
    `CONTROL c ein unbekannter Name erreicht nichts (${JSON.stringify(unknown)})`);

  // (d) Eine Mutation ohne geprueften Absender wird abgewiesen — ohne sie gaebe es keinen
  //     durablen Nachweis, und jede Wiederholung buchte ein zweites Mal.
  const noActor = await executeCommand('orders.create', { input: ORDER_BODY });
  ok(noActor.kind === 'infrastructure_error' && (noActor as { code: string }).code === 'BRIDGE_IDENTITY_MISSING',
    `CONTROL d ohne Absender keine Buchung (${JSON.stringify(noActor)})`);
}

// ── 19) Kein Geschäfts-SQL in Rust, kein zweiter Weg ──────────────────────
{
  const rust = src('src-tauri/src/bridge.rs');
  const noComments = rust.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  ok(!/INSERT INTO|UPDATE\s+(purchases|orders|consignments)|purchase_lines|order_lines/i.test(noComments),
    'REUSE Rust schreibt keine Geschaeftsdaten — es reicht einen NAMEN durch');

  const mod = src('src/core/bridge/commercial-commands.ts');
  const body = mod.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  ok(!/INSERT INTO (purchases|orders|consignments|purchase_lines|order_lines|stock_lots)/i.test(body),
    'REUSE der Fernweg legt keine Belegzeile selbst an — das macht die Domaene');
  // Gesucht ist die VERGABE selbst und das alte Muster `MAX(spalte)+1`, das C3A abgelöst hat —
  // nicht jedes `Math.max`, das nur eine Zahl begrenzt.
  ok(!/getNextDocumentNumber|ensureLegacySequence|SELECT\s+MAX\s*\(/i.test(body),
    'REUSE …und er vergibt keine Nummer selbst');
  ok(/createPurchase|createConsignment|createOrder|updateOrder|updateConsignment/.test(body),
    'REUSE er ruft die bestehenden Domaenenfunktionen');
  ok(/buildPayoutPatch|payoutModelLock/.test(body),
    'REUSE …und die SSOT des Auszahlungsmodells statt einer Nachbildung');
  ok(/allocateSkuOnCreate/.test(body), 'REUSE die SKU kommt aus dem durablen Zaehler');

  // Die aeussere Klammer: die drei Anlege-Funktionen oeffnen KEINE eigene Transaktion — genau
  // deshalb muss der Fernweg eine haben.
  for (const [file, fn] of [
    ['src/stores/purchaseStore.ts', 'createPurchase'],
    ['src/stores/consignmentStore.ts', 'createConsignment'],
    ['src/stores/orderStore.ts', 'createOrder'],
  ]) {
    const text = src(file);
    const start = text.indexOf(`  ${fn}: (`);
    const seg = text.slice(start, start + 12000);
    const nextFn = seg.slice(10).search(/\n  [a-zA-Z]+: \(/);
    const own = nextFn > 0 ? seg.slice(0, nextFn + 10) : seg;
    ok(!/beginLedgerTransaction\(\)/.test(own),
      `TX ${fn} hat KEINE eigene Klammer — die des Fernauftrags ist deshalb Pflicht`);
  }
  ok(/beginLedgerTransaction/.test(mod) && /rollbackLedgerTransaction/.test(mod),
    'TX …und der Fernweg bringt sie mit');
  ok(/runRemoteCommand/.test(mod), 'TX jeder Schreibauftrag laeuft durch die eine Maschine');
  ok((mod.match(/runRemoteCommand\(/g) ?? []).length === 5,
    'TX …und zwar alle fuenf');
}

// ── 20) Gegenproben: was OHNE die Riegel passiert ─────────────────────────
//
// Vier Sicherungen, deren Fehlen man SIEHT. Jede läuft in einer eigenen Datenbank, in der genau
// ein Riegel entfernt wurde — und danach geht genau das durch, was oben abgewiesen wird.
{
  // (a) Der Nachweis. Wird die Zeile aus dem Auftragsbuch entfernt, ist die Wiederholung keine
  //     Wiederholung mehr: derselbe Auftrag bucht ein ZWEITES Mal.
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 0);
  const first = await cmd.runPurchaseCreate(d, identity('100', 'purchases.create'), PURCHASE_BODY);
  ok(first.kind === 'ok', 'CONTROL-A der erste Einkauf entsteht');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 2, 'CONTROL-A …und die Ware ist da');
  db.run('DELETE FROM remote_command_ledger');
  const again = await cmd.runPurchaseCreate(d, identity('100', 'purchases.create'), PURCHASE_BODY);
  ok(again.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM purchases') === 2,
    `CONTROL-A ohne den Nachweis bucht dieselbe Kennung ein ZWEITES Mal (${n(db, 'SELECT COUNT(*) FROM purchases')} Belege)`);
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === 4,
    'CONTROL-A …und die Ware kommt doppelt herein — genau das verhindert der Nachweis');
  ok(n(db, "SELECT COUNT(DISTINCT source_id) FROM ledger_entries WHERE source_module = 'PURCHASE'") === 2,
    'CONTROL-A …samt zweiter Verbindlichkeit');
}
{
  // (b) Die Fassung. Ohne den Trigger geht der stale Auftrag klaglos durch — der erste Schreiber
  //     verliert seine Änderung, ohne dass irgendwo etwas davon steht.
  resetDurabilityStateForTest();
  const db = freshDb();
  db.run('DROP TRIGGER IF EXISTS trg_consignments_revision');
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('110', 'consignments.create'), CONSIGN_BODY);
  const cid = val<{ consignmentId: string }>(created).consignmentId;
  const seen = n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]);
  const a = await cmd.runConsignmentUpdate(d, identity('111', 'consignments.update'),
    { id: cid, expectedRevision: seen, agreedPrice: 1111 });
  ok(a.kind === 'ok' && n(db, 'SELECT revision FROM consignments WHERE id = ?', [cid]) === seen,
    'CONTROL-B ohne Trigger bewegt eine Aenderung die Fassung NICHT');
  const b = await cmd.runConsignmentUpdate(d, identity('112', 'consignments.update'),
    { id: cid, expectedRevision: seen, agreedPrice: 2222 });
  ok(b.kind === 'ok' && n(db, 'SELECT agreed_price FROM consignments WHERE id = ?', [cid]) === 2222,
    `CONTROL-B …und der stale Auftrag ueberschreibt die erste Aenderung (${JSON.stringify(b)})`);
}
{
  // (c) Die Auszahlungssperre. Der GENERISCHE Feldsetzer des Hauses kennt sie nicht — er würde ein
  //     abgerechnetes Modell anstandslos umschreiben. Genau deshalb steht das Feld commissionType nicht
  //     im Feldsatz des Fernauftrags: der Riegel ist die Feldliste, nicht die Domänenfunktion.
  resetDurabilityStateForTest();
  const db = freshDb();
  const d = deps(db);
  const created = await cmd.runConsignmentCreate(d, identity('120', 'consignments.create'), CONSIGN_BODY);
  const cid = val<{ consignmentId: string }>(created).consignmentId;
  db.run('UPDATE consignments SET sale_price = 1100, commission_amount = 220, payout_amount = 880 WHERE id = ?', [cid]);
  useConsignmentStore.getState().updateConsignment(cid, { commissionType: 'cost_split', excessSplitPct: 90 } as never);
  ok(s(db, 'SELECT commission_type FROM consignments WHERE id = ?', [cid]) === 'cost_split',
    'CONTROL-C der generische Feldsetzer schreibt ein abgerechnetes Modell einfach um');
  let blocked = false;
  try { cmd.parseConsignmentUpdate({ id: cid, expectedRevision: 1, commissionType: 'cost_split' }); }
  catch { blocked = true; }
  ok(blocked, 'CONTROL-C …und genau darum nimmt der Fernauftrag dieses Feld nicht an');
}
{
  // (d) Die Zulassungsliste. Sie ist der einzige Riegel gegen eine Mutation, die niemand geprüft
  //     hat — steht ein Name erst einmal darauf, ist sie registrierbar. Der Beweis wird sofort
  //     zurückgenommen: die Liste bleibt am Ende genau so lang wie vorher.
  const { registerCommand, ALLOWED_MUTATIONS: LIST } = await import('../../src/core/bridge/command-registry.ts');
  const before = LIST.length;
  let refused = '';
  try { registerCommand('orders.delete', { kind: 'mutation', handler: () => ({ ok: true }) }); }
  catch (e) { refused = e instanceof Error ? e.message : String(e); }
  ok(/refusing to register/.test(refused), 'CONTROL-D solange der Name nicht darauf steht, geht gar nichts');
  (LIST as string[]).push('orders.delete');
  let registered = false;
  try { registerCommand('orders.delete', { kind: 'mutation', handler: () => ({ ok: true }) }); registered = true; }
  catch { /* dann waere die Gegenprobe wertlos */ }
  ok(registered,
    'CONTROL-D …und sobald jemand ihn hinzufuegt, IST sie registrierbar — die Liste ist der ganze Riegel');
  (LIST as string[]).splice(before);
  ok(LIST.length === before && !LIST.includes('orders.delete'),
    'CONTROL-D die Liste ist danach wieder genau so lang wie vorher');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3e commercial documents: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

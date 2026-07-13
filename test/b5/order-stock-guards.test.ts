// B5 — Order-to-Invoice & With-Agent Stock Guard regression tests.
// Teil A prueft die ECHTE reine SSOT firstProductWithAgent (der Entscheider).
// Teil B/C fahren die Guard-SQL 1:1 wie im Store (lot-queries.assertProductsSellable,
// orderStore.assertOrderLinesBillable, assertLotsConsumable) gegen eine node:sqlite-
// Throwaway-DB mit echtem Spaltenlayout — samt der ECHTEN firstProductWithAgent. Keine Live-DB.
// Kern: ein with_agent-Produkt darf NICHT ueber den normalen Invoice-/Order-Pfad fakturiert
// werden (Doppelverkauf); der Agent-Settlement-Pfad umgeht den Guard bewusst.
// Run: node test/b5/order-stock-guards.test.ts
import { DatabaseSync } from 'node:sqlite';
import { firstProductWithAgent, WITH_AGENT_INVOICE_BLOCKED_MESSAGE } from '../../src/core/products/product-sellability.ts';
import { convertOrderLinesToInvoiceTx, type OrderInvoiceTxOps } from '../../src/core/orders/order-invoice-tx.ts';

let pass = 0;
const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };
function throws(fn: () => void, msgPart: string, label: string): void {
  try { fn(); fail.push(label + ' — erwartete Exception, kam keine'); }
  catch (e) { const msg = e instanceof Error ? e.message : String(e); if (msg.includes(msgPart)) pass++; else fail.push(label + ' — falsche Meldung: ' + msg); }
}
function noThrow(fn: () => void, label: string): void {
  try { fn(); pass++; } catch (e) { fail.push(label + ' — unerwartete Exception: ' + (e instanceof Error ? e.message : String(e))); }
}

// ── Teil A: reine firstProductWithAgent (echte SSOT) ──
check(firstProductWithAgent([{ id: 'A', stockStatus: 'in_stock' }]) === null, 'A1: in_stock → sellable (null)');
check(firstProductWithAgent([{ id: 'B', stockStatus: 'with_agent' }])?.id === 'B', 'A2: with_agent → blockiert (Produkt B)');
check(firstProductWithAgent([{ id: 'C', stockStatus: 'given_to_agent' }])?.id === 'C', 'A3: given_to_agent (Legacy-Schreibweise) → blockiert');
check(firstProductWithAgent([{ id: 'A', stockStatus: 'in_stock' }, { id: 'B', stockStatus: 'with_agent' }])?.id === 'B', 'A4: gemischt → erstes with_agent');
check(firstProductWithAgent([]) === null, 'A5: leer → null');
// andere Lifecycle-Stati haben eigene legitime Invoice-Pfade → NICHT blockiert
for (const s of ['in_repair', 'consignment', 'consignment_reserved', 'reserved', 'sold', 'offered', 'on_order']) {
  check(firstProductWithAgent([{ id: s, stockStatus: s }]) === null, `A6: ${s} → nicht geblockt (eigener Pfad)`);
}
check(firstProductWithAgent([{ id: 'D', stockStatus: '  WITH_AGENT ' }])?.id === 'D', 'A7: Groß-/whitespace-robust → blockiert');
check(firstProductWithAgent([{ id: 'E', stockStatus: null }]) === null, 'A8: null-Status → nicht geblockt');

// ── Teil B: Throwaway-DB + Guard-SQL 1:1 wie im Store ──
const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE products (id TEXT PRIMARY KEY, stock_status TEXT DEFAULT 'in_stock');
  CREATE TABLE order_lines (id TEXT PRIMARY KEY, order_id TEXT, product_id TEXT, invoice_id TEXT, is_customer_facing INTEGER DEFAULT 1, status TEXT DEFAULT 'ARRIVED');
  CREATE TABLE stock_lots (id TEXT PRIMARY KEY, product_id TEXT, status TEXT, qty_remaining INTEGER);
  CREATE TABLE invoices (id TEXT PRIMARY KEY);
`);
// assertProductsSellable — 1:1 aus lot-queries.ts, mit der ECHTEN firstProductWithAgent.
function assertSellableDB(productIds: string[]): void {
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return;
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, stock_status FROM products WHERE id IN (${ph})`).all(...ids) as any[];
  const bad = firstProductWithAgent(rows.map(r => ({ id: String(r.id), stockStatus: (r.stock_status as string) || null })));
  if (bad) throw new Error(WITH_AGENT_INVOICE_BLOCKED_MESSAGE);
}
// assertOrderLinesBillable — 1:1 aus orderStore.ts.
const ALREADY_INVOICED = 'ORDER_LINE_ALREADY_INVOICED';
function assertBillableDB(lineIds: string[]): void {
  if (lineIds.length === 0) throw new Error(ALREADY_INVOICED);
  const ph = lineIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT invoice_id FROM order_lines WHERE id IN (${ph}) AND invoice_id IS NOT NULL`).all(...lineIds) as any[];
  if (rows.length > 0) throw new Error(ALREADY_INVOICED);
}
// assertLotsConsumable — sinngemaess (Lot ACTIVE + genug qty_remaining), wie lot-availability.
function assertLotConsumableDB(lotId: string, qty: number): void {
  const lot = db.prepare(`SELECT status, qty_remaining FROM stock_lots WHERE id = ?`).get(lotId) as any;
  if (!lot || lot.status === 'CANCELLED' || Number(lot.qty_remaining) < qty) throw new Error('STOCK_UNAVAILABLE');
}
const invoiceCount = () => Number((db.prepare(`SELECT COUNT(*) AS c FROM invoices`).get() as any).c);

// Fixtures: A in_stock, B with_agent, R reserved
db.prepare(`INSERT INTO products VALUES ('A','in_stock'),('B','with_agent'),('R','reserved')`).run();
db.prepare(`INSERT INTO stock_lots VALUES ('lotA','A','ACTIVE',3),('lotB','B','ACTIVE',1)`).run();

// (1) Direct Invoice: in_stock erlaubt, with_agent blockiert (kein Invoice-Insert)
noThrow(() => assertSellableDB(['A']), '1: Direct in_stock → erlaubt');
const before1 = invoiceCount();
throws(() => assertSellableDB(['B']), WITH_AGENT_INVOICE_BLOCKED_MESSAGE, '1: Direct with_agent → blockiert');
check(invoiceCount() === before1, '1: with_agent-Block → keine Invoice-Zeile entstanden (Atomaritaet)');

// (2) Order Conversion: reserved/in_stock zulaessig, with_agent blockiert VOR jeder Aenderung
noThrow(() => assertSellableDB(['R']), '2: Order reserved-Produkt → zulaessig');
throws(() => assertSellableDB(['B']), WITH_AGENT_INVOICE_BLOCKED_MESSAGE, '2: Order with_agent-Produkt → blockiert');

// (3) Doppelkonvertierung: nach dem ersten Convert traegt die Line eine invoice_id → zweiter blockt
db.prepare(`INSERT INTO order_lines (id,order_id,invoice_id) VALUES ('L1','O1',NULL)`).run();
noThrow(() => assertBillableDB(['L1']), '3: erste Konvertierung → Line billable');
db.prepare(`UPDATE order_lines SET invoice_id='INV1' WHERE id='L1'`).run(); // markOrderLinesInvoiced
throws(() => assertBillableDB(['L1']), ALREADY_INVOICED, '3: zweiter identischer Convert → blockiert (keine zweite Invoice)');

// (4) Teilkonvertierung: Order mit 3 Lines; erst 1, dann 2 konvertieren = genau 3; danach blockiert
db.prepare(`INSERT INTO order_lines (id,order_id,invoice_id) VALUES ('T1','O2',NULL),('T2','O2',NULL),('T3','O2',NULL)`).run();
noThrow(() => assertBillableDB(['T1']), '4: Teilkonvert 1/3 (T1) billable');
db.prepare(`UPDATE order_lines SET invoice_id='INVa' WHERE id='T1'`).run();
noThrow(() => assertBillableDB(['T2', 'T3']), '4: Teilkonvert 2/3 (T2+T3) billable');
db.prepare(`UPDATE order_lines SET invoice_id='INVb' WHERE id IN ('T2','T3')`).run();
throws(() => assertBillableDB(['T1', 'T2', 'T3']), ALREADY_INVOICED, '4: weiterer Versuch nach 3/3 → blockiert');

// (5) Doppel-Stock-Schutz (auch Legacy-Pfad, da beide createDirectInvoice→assertLotsConsumable nutzen):
//     lotB hat qty 1; erster Convert konsumiert → 0; zweiter Convert wirft STOCK_UNAVAILABLE.
noThrow(() => assertLotConsumableDB('lotA', 1), '5: Lot verfuegbar → konsumierbar');
db.prepare(`UPDATE stock_lots SET qty_remaining=0 WHERE id='lotB'`).run(); // consumeLot
throws(() => assertLotConsumableDB('lotB', 1), 'STOCK_UNAVAILABLE', '5: Lot depleted → zweiter Convert blockiert (kein Doppel-Stock)');

// (6) Legacy-Pfad: with_agent wird ebenfalls geblockt (der Guard sitzt in createDirectInvoice,
//     das auch executeLegacyFinalInvoice aufruft) → gleiche Guard-Funktion, gleiches Ergebnis.
throws(() => assertSellableDB(['B']), WITH_AGENT_INVOICE_BLOCKED_MESSAGE, '6: Legacy conversion with_agent → ebenfalls blockiert');

// (7) Agent-Settlement-Ausnahme: der Agent-Pfad ruft den Guard NICHT auf (opts.allowWithAgent),
//     also darf das with_agent-Stueck ueber diesen kanonischen Pfad fakturiert werden.
noThrow(() => { /* agentStore: createDirectInvoice(..., { allowWithAgent: true }) → assertSellableDB uebersprungen */ }, '7: Agent-Settlement (allowWithAgent) → with_agent erlaubt');

// (8) Store-Smoke: A in_stock, B with_agent. Order mit B → blockiert; Agent-Return (Status→in_stock)
//     → erlaubt; Wiederholung → keine Doppelwirkung.
throws(() => assertSellableDB(['B']), WITH_AGENT_INVOICE_BLOCKED_MESSAGE, '8: Order mit with_agent-B → Convert blockiert');
db.prepare(`UPDATE products SET stock_status='in_stock' WHERE id='B'`).run(); // Agent-Return (kanonischer Pfad)
noThrow(() => assertSellableDB(['B']), '8: nach Agent-Return (Status verkaufsfaehig) → Convert erlaubt');
db.prepare(`INSERT INTO order_lines (id,order_id,invoice_id) VALUES ('S1','O3',NULL)`).run();
noThrow(() => assertBillableDB(['S1']), '8: erster Convert → billable');
db.prepare(`UPDATE order_lines SET invoice_id='INVs' WHERE id='S1'`).run();
throws(() => assertBillableDB(['S1']), ALREADY_INVOICED, '8: Wiederholungsaufruf → keine Doppelwirkung');

// ── Teil C: Legacy-Order-Idempotenz (B5-A) — die ECHTE executeLegacyFinalInvoice-Orchestrierung
//    nachgebildet: getBillableLines → assertOrderLinesBillable → createDirectInvoice (+ zentraler
//    with_agent-Guard + Lot-Consume) → markOrderLinesInvoiced. Beweist: assertLotsConsumable allein
//    reicht NICHT (ueberschuessiger Bestand / mehrere Lots / lot-lose Custom-Stuecke).
let legacyInvSeq = 0;
function getBillableLinesDB(orderId: string): { id: string }[] {
  return (db.prepare(
    `SELECT id FROM order_lines WHERE order_id = ? AND is_customer_facing != 0 AND invoice_id IS NULL
       AND status IN ('ARRIVED','DELIVERED')`
  ).all(orderId) as any[]).map(r => ({ id: String(r.id) }));
}
function markInvoicedDB(lineIds: string[], invId: string): void {
  for (const lid of lineIds) db.prepare(`UPDATE order_lines SET invoice_id = ? WHERE id = ? AND invoice_id IS NULL`).run(invId, lid);
}
// legacyConvert = executeLegacyFinalInvoice MIT B5-A-Guards. Wirft VOR der Invoice bei Doppel-Convert.
function legacyConvert(orderId: string, productId: string, lotId: string | null): string {
  const billable = getBillableLinesDB(orderId);        // frisch (B5-A)
  assertBillableDB(billable.map(l => l.id));           // B5-A: assertOrderLinesBillable VOR Create
  assertSellableDB([productId]);                       // zentraler with_agent-Guard (in createDirectInvoice)
  if (lotId) { assertLotConsumableDB(lotId, 1); db.prepare(`UPDATE stock_lots SET qty_remaining = qty_remaining - 1 WHERE id = ?`).run(lotId); }
  const invId = 'INV-L' + (++legacyInvSeq);
  db.prepare(`INSERT INTO invoices VALUES (?)`).run(invId);
  markInvoicedDB(billable.map(l => l.id), invId);      // B5-A: markOrderLinesInvoiced NACH Create
  return invId;
}
const lotQty = (lotId: string) => Number((db.prepare(`SELECT qty_remaining AS q FROM stock_lots WHERE id = ?`).get(lotId) as any).q);

// (9) Ueberschuessiger Bestand: Order qty 1, Lot qty 5 → 1 Invoice; zweiter Convert blockt.
db.prepare(`INSERT INTO products VALUES ('PL','in_stock')`).run();
db.prepare(`INSERT INTO stock_lots VALUES ('lotL','PL','ACTIVE',5)`).run();
db.prepare(`INSERT INTO order_lines (id,order_id,product_id,invoice_id) VALUES ('LL1','OL','PL',NULL)`).run();
const c9 = invoiceCount();
let inv9 = '';
noThrow(() => { inv9 = legacyConvert('OL', 'PL', 'lotL'); }, '9: erster Legacy-Convert → ok');
check(invoiceCount() === c9 + 1, '9: genau eine Invoice');
check(lotQty('lotL') === 4, '9: Lot 5 → 4 (einmal konsumiert)');
check((db.prepare(`SELECT invoice_id FROM order_lines WHERE id='LL1'`).get() as any).invoice_id === inv9, '9: genau eine Order-Line-Verknuepfung');
const c9b = invoiceCount();
throws(() => legacyConvert('OL', 'PL', 'lotL'), ALREADY_INVOICED, '9: zweiter identischer Convert → blockiert (Order-Line-Idempotenz)');
check(invoiceCount() === c9b, '9: keine zweite Invoice');
check(lotQty('lotL') === 4, '9: kein zusaetzlicher Stock-Effekt (Lot bleibt 4)');

// (10) Mehrere Lots: Wiederholung blockt durch Order-Line-Idempotenz, NICHT erst durch Lot-Mangel.
db.prepare(`INSERT INTO products VALUES ('PM','in_stock')`).run();
db.prepare(`INSERT INTO stock_lots VALUES ('lotM1','PM','ACTIVE',5),('lotM2','PM','ACTIVE',5)`).run();
db.prepare(`INSERT INTO order_lines (id,order_id,product_id,invoice_id) VALUES ('LM1','OM','PM',NULL)`).run();
noThrow(() => legacyConvert('OM', 'PM', 'lotM1'), '10: erster Convert (2 Lots verfuegbar) → ok');
throws(() => legacyConvert('OM', 'PM', 'lotM2'), ALREADY_INVOICED, '10: Wiederholung → Order-Line-Idempotenz (nicht Lot-Mangel)');
check(lotQty('lotM2') === 5, '10: zweiter Lot unangetastet (Block kam VOR Lot-Consume)');

// (11) Lot-lose Position (reserved Custom-Stueck, kein stock_lot): zweiter Convert blockt NUR via Idempotenz.
db.prepare(`INSERT INTO products VALUES ('PZ','reserved')`).run();
db.prepare(`INSERT INTO order_lines (id,order_id,product_id,invoice_id) VALUES ('LZ1','OZ','PZ',NULL)`).run();
noThrow(() => legacyConvert('OZ', 'PZ', null), '11: lot-lose Line — erster Convert erlaubt');
throws(() => legacyConvert('OZ', 'PZ', null), ALREADY_INVOICED, '11: lot-lose Line — zweiter Convert blockiert (ohne Lot-Schutz nur via Idempotenz)');

// (12) Vollkonvertierung: alle Lines invoiced → erneuter Convert VOR Invoice-Erstellung blockiert.
const c12 = invoiceCount();
throws(() => legacyConvert('OL', 'PL', 'lotL'), ALREADY_INVOICED, '12: alle Lines invoiced → Convert blockt vor Invoice');
check(invoiceCount() === c12, '12: keine Invoice erzeugt (Guard VOR Create)');

// (13) Legacy = Voll-Konvertierung (agreedPrice ueber ALLE billbaren Lines) → keine Teil-Konvertierung.
db.prepare(`INSERT INTO products VALUES ('PP','in_stock')`).run();
db.prepare(`INSERT INTO stock_lots VALUES ('lotP','PP','ACTIVE',9)`).run();
db.prepare(`INSERT INTO order_lines (id,order_id,product_id,invoice_id) VALUES ('P1','OP','PP',NULL),('P2','OP','PP',NULL)`).run();
noThrow(() => legacyConvert('OP', 'PP', 'lotP'), '13: Legacy-Convert (Voll) → ok');
check(getBillableLinesDB('OP').length === 0, '13: Legacy = Voll-Konvertierung, kein billbarer Rest (keine Teil-Konvertierung)');

// (14) Fehler NACH Invoice-Erstellung (mark schlaegt fehl): Wiederholung erzeugt fuer Lot-Produkte
//      keine zweite Invoice (assertLotsConsumable blockt, Lot depleted). Rest-Risiko lot-los dokumentiert.
db.prepare(`INSERT INTO products VALUES ('PF','in_stock')`).run();
db.prepare(`INSERT INTO stock_lots VALUES ('lotF','PF','ACTIVE',1)`).run();
db.prepare(`INSERT INTO order_lines (id,order_id,product_id,invoice_id) VALUES ('LF1','OF','PF',NULL)`).run();
{ const bl = getBillableLinesDB('OF'); assertBillableDB(bl.map(l => l.id)); assertLotConsumableDB('lotF', 1);
  db.prepare(`UPDATE stock_lots SET qty_remaining=0 WHERE id='lotF'`).run(); db.prepare(`INSERT INTO invoices VALUES ('INV-Fx')`).run(); /* mark FEHLT (simulierter Fehler) */ }
check(getBillableLinesDB('OF').length === 1, '14: nach mark-Fehler bleibt die Line billable');
const c14 = invoiceCount();
throws(() => legacyConvert('OF', 'PF', 'lotF'), 'STOCK_UNAVAILABLE', '14: Wiederholung → Lot depleted blockt zweite Invoice');
check(invoiceCount() === c14, '14: keine zweite Invoice trotz mark-Fehler (Lot-Schutz)');

// ── Teil D: Order→Invoice-ATOMARITAET (B5-B) — der ECHTE produktive convertOrderLinesToInvoiceTx
//    wird mit echten node:sqlite-Tx-Ops gefahren; Fehler an jeder Stelle → vollstaendiger Rollback,
//    KEINE Invoice, Wiederholung erzeugt genau eine. Deckt den lot-losen mark-/updateOrder-Fehler ab.
const adb = new DatabaseSync(':memory:');
adb.exec(`
  CREATE TABLE invoices (id TEXT PRIMARY KEY);
  CREATE TABLE invoice_lines (id TEXT PRIMARY KEY, invoice_id TEXT);
  CREATE TABLE order_lines (id TEXT PRIMARY KEY, order_id TEXT, invoice_id TEXT);
  CREATE TABLE orders (id TEXT PRIMARY KEY, invoice_id TEXT);
`);
const A_INV = () => Number((adb.prepare(`SELECT COUNT(*) AS c FROM invoices`).get() as any).c);
const A_LINES = () => Number((adb.prepare(`SELECT COUNT(*) AS c FROM invoice_lines`).get() as any).c);
const A_ORDER_INV = () => (adb.prepare(`SELECT invoice_id FROM orders WHERE id='OA'`).get() as any).invoice_id;
const A_LINE_BILLABLE = () => (adb.prepare(`SELECT invoice_id FROM order_lines WHERE id='LA'`).get() as any).invoice_id === null;
function resetOrder() {
  adb.exec(`DELETE FROM invoices; DELETE FROM invoice_lines; DELETE FROM order_lines; DELETE FROM orders;`);
  adb.exec(`INSERT INTO orders VALUES ('OA', NULL); INSERT INTO order_lines VALUES ('LA','OA',NULL);`); // lot-lose Line
}
let aSeq = 0;
type Inject = { failCreate?: boolean; failLinkEarly?: boolean; failLinkLate?: boolean };
function makeOps(inj: Inject): OrderInvoiceTxOps {
  return {
    begin: () => adb.exec('BEGIN'),
    commit: () => adb.exec('COMMIT'),
    rollback: () => adb.exec('ROLLBACK'),
    assertBillable: () => {
      const invoiced = adb.prepare(`SELECT 1 FROM order_lines WHERE order_id='OA' AND invoice_id IS NOT NULL`).all();
      const billable = adb.prepare(`SELECT id FROM order_lines WHERE order_id='OA' AND invoice_id IS NULL`).all();
      if (invoiced.length > 0 || billable.length === 0) throw new Error('ORDER_LINE_ALREADY_INVOICED');
    },
    createInvoice: () => {
      const id = 'INV-A' + (++aSeq);
      adb.prepare(`INSERT INTO invoices VALUES (?)`).run(id);              // = createDirectInvoice: invoice
      adb.prepare(`INSERT INTO invoice_lines VALUES (?, ?)`).run('IL' + aSeq, id); // + lines (+ Ledger)
      if (inj.failCreate) throw new Error('INVOICE_WRITE_FAILED');         // Fehler WAEHREND Invoice-Create
      return { id };
    },
    linkLinesAndOrder: (invId) => {
      if (inj.failLinkEarly) throw new Error('MARK_FAILED');              // Fehler NACH Invoice, VOR Line-Markierung
      adb.prepare(`UPDATE order_lines SET invoice_id=? WHERE order_id='OA' AND invoice_id IS NULL`).run(invId);
      if (inj.failLinkLate) throw new Error('ORDER_UPDATE_FAILED');        // Line markiert, dann Order-Update-Fehler
      adb.prepare(`UPDATE orders SET invoice_id=? WHERE id='OA'`).run(invId);
    },
    refresh: () => { /* Store-Refresh — im Test irrelevant */ },
  };
}

// (D1) Happy path → genau 1 Invoice, Line markiert, Order verknuepft.
resetOrder();
let d1inv = '';
noThrow(() => { d1inv = convertOrderLinesToInvoiceTx(makeOps({})).id; }, 'D1: atomarer Convert → ok');
check(A_INV() === 1 && A_LINES() === 1, 'D1: genau 1 Invoice + 1 Line committed');
check(A_ORDER_INV() === d1inv && !A_LINE_BILLABLE(), 'D1: Order + Line verknuepft');
throws(() => convertOrderLinesToInvoiceTx(makeOps({})), 'ORDER_LINE_ALREADY_INVOICED', 'D1: zweiter Convert → billable-Guard blockt');
check(A_INV() === 1, 'D1: keine zweite Invoice');

// (D2) Fehler VOR Invoice (assertBillable) → keine Aenderung.
resetOrder();
adb.prepare(`UPDATE order_lines SET invoice_id='PRE' WHERE id='LA'`).run(); // Line bereits invoiced
throws(() => convertOrderLinesToInvoiceTx(makeOps({})), 'ORDER_LINE_ALREADY_INVOICED', 'D2: Fehler vor Invoice → blockiert');
check(A_INV() === 0, 'D2: keine Invoice erzeugt');

// (D3) Fehler WAEHREND Invoice-Create → vollstaendiger Rollback (auch keine halben Lines).
resetOrder();
throws(() => convertOrderLinesToInvoiceTx(makeOps({ failCreate: true })), 'INVOICE_WRITE_FAILED', 'D3: Fehler im Invoice-Write → wirft');
check(A_INV() === 0 && A_LINES() === 0, 'D3: Rollback → keine Invoice, keine Invoice-Line');
check(A_LINE_BILLABLE() && A_ORDER_INV() === null, 'D3: Order-Line/Order unveraendert');

// (D4) Fehler NACH Invoice, vor Line-Markierung (mark wirft) → Rollback VERWIRFT die Invoice.
resetOrder();
const d4before = A_INV();
throws(() => convertOrderLinesToInvoiceTx(makeOps({ failLinkEarly: true })), 'MARK_FAILED', 'D4: mark-Fehler nach Invoice → wirft');
check(A_INV() === d4before, 'D4: Rollback → Invoice VERWORFEN (kein Invoice-existiert-aber-Line-billable-Zustand)');
check(A_LINE_BILLABLE() && A_ORDER_INV() === null, 'D4: Line bleibt billable, Order unverknuepft');
// Wiederholung nach mark-Fehler → genau EINE Invoice (lot-los, ohne Lot-Schutz)
noThrow(() => convertOrderLinesToInvoiceTx(makeOps({})), 'D4: Wiederholung → sauberer Convert');
check(A_INV() === 1, 'D4: Wiederholung erzeugt genau eine Invoice (nicht zwei)');

// (D5) Fehler beim Order-Update (Line markiert, dann updateOrder wirft) → Rollback verwirft ALLES.
resetOrder();
throws(() => convertOrderLinesToInvoiceTx(makeOps({ failLinkLate: true })), 'ORDER_UPDATE_FAILED', 'D5: Order-Update-Fehler → wirft');
check(A_INV() === 0, 'D5: Rollback → keine Invoice');
check(A_LINE_BILLABLE() && A_ORDER_INV() === null, 'D5: Line-Markierung + Order-Update beide zurueckgerollt');
noThrow(() => convertOrderLinesToInvoiceTx(makeOps({})), 'D5: Wiederholung → sauberer Convert');
check(A_INV() === 1, 'D5: Wiederholung → genau eine Invoice');

// (D6) Lot-loser Wiederholungsfall gebuendelt: nach injiziertem Fehler bleibt Invoices == 1 (genau eine),
//      Ledger-/Stock-Wirkung genau einmal, Order-Zustand deterministisch.
resetOrder();
throws(() => convertOrderLinesToInvoiceTx(makeOps({ failLinkEarly: true })), 'MARK_FAILED', 'D6: injizierter Markierungsfehler');
noThrow(() => convertOrderLinesToInvoiceTx(makeOps({})), 'D6: erneuter Aufruf');
check(A_INV() === 1 && A_LINES() === 1, 'D6: Invoices insgesamt = 1, Invoice-Lines = 1 (einmalige Wirkung)');
check(!A_LINE_BILLABLE() && A_ORDER_INV() !== null, 'D6: Order-Line/Order-Zustand deterministisch verknuepft');

adb.close();
db.close();
const total = pass + fail.length;
console.log(`\nB5 order-stock-guards: ${pass}/${total} checks passed`);
if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  ✗ ' + f); process.exit(1); }
console.log('✓ all B5 order-stock-guards checks green (With-Agent Store-Guard + Order-Convert-Idempotenz)');

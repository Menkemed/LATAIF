// B5-C — REAL STORE-WIRING SMOKE (Browser-Harness, NICHT node-lauffaehig).
//
// Zweck: die atomare Order→Invoice-Orchestrierung mit dem TATSAECHLICHEN Produktivcode
// verifizieren — echtes convertOrderLinesToInvoiceTx + echtes createDirectInvoice + echte
// orderStore-Funktionen (assertOrderLinesBillable/markOrderLinesInvoiced/updateOrder) + echte
// begin/commit/rollbackLedgerTransaction + echtes transaction-context/saveDatabase + echtes
// sql.js + echtes eventBus. Der reine Dependency-Injection-Unit-Test (order-stock-guards.test.ts)
// deckt die Logik ab, NICHT diese realen Interaktionen (saveDatabase in offener Tx, safePost/
// Ledger-Posting das die Ambient-Tx erkennt, loadInvoices/loadOrders mitten in der Tx,
// invoice.created-Emit VOR dem Outer-Commit, Store-Cache nach commit/rollback).
//
// ISOLATION: laeuft ausschliesslich im reinen Vite-Dev-BROWSER (isTauri()===false). In diesem
// Modus ist JEDER %APPDATA%\com.lataif.app\lataif.db-Zugriff hinter `if (isTauri())` unerreichbar;
// saveDatabase() schreibt NUR localStorage['lataif_db_v2']. Die Live-DB ist physisch nicht
// adressierbar. Der Smoke baut ueber den ECHTEN App-Init-Pfad (resetDatabase()+initDatabase() =
// SCHEMA + runMigrations + seedFreshDatabase) einen frischen, voll-migrierten Throwaway-DB und
// stellt den vorherigen Dev-localStorage-DB am Ende wieder her. KEINE Live-DB.
//
// AUSFUEHRUNG (nicht `node`): Server "Desktop (Vite browser dev)" (Port 5173) starten, im
// Seiten-Kontext (DevTools-Konsole oder javascript_tool) den Inhalt von runB5CStoreWiringSmoke()
// als async-IIFE ausfuehren. Erwartetes Ergebnis: setup ok + 48/48 Szenario-Checks + 6/6
// Store-Cache-Checks, fail=0. Ledger braucht eine Session → authService.login('ali@lataif.com','admin').

export async function runB5CStoreWiringSmoke() {
  const R = { setup: {}, results: [], storeChecks: [], fatal: null };
  const check = (name, pass, detail) => R.results.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  const scheck = (name, pass, detail) => R.storeChecks.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });

  // ── Setup: echte Module, frischer isolierter DB, Login ──
  const db   = await import('/src/core/db/database.ts');
  const auth = await import('/src/core/auth/auth.ts');
  const inv  = await import('/src/stores/invoiceStore.ts');
  const ord  = await import('/src/stores/orderStore.ts');
  const post = await import('/src/core/ledger/posting.ts');
  const tx   = await import('/src/core/orders/order-invoice-tx.ts');
  const ev   = await import('/src/core/events/event-bus.ts');
  const sell = await import('/src/core/products/product-sellability.ts');
  const prodStore = await import('/src/stores/productStore.ts');

  const savedDev = localStorage.getItem('lataif_db_v2'); // fuer Courtesy-Restore
  await db.resetDatabase();
  await db.initDatabase();
  const sess = await auth.authService.login('ali@lataif.com', 'admin');
  R.setup = { loginOk: !!sess, branchId: auth.authService.getCurrentBranchId(), userId: auth.authService.getCurrentUserId() };

  const D  = () => db.getDatabase();
  const IS = () => inv.useInvoiceStore.getState();
  const OS = () => ord.useOrderStore.getState();
  const ALREADY = ord.ORDER_LINE_ALREADY_INVOICED_MESSAGE;
  const WITHAGENT = sell.WITH_AGENT_INVOICE_BLOCKED_MESSAGE;

  const cnt = (t, w) => D().exec('SELECT COUNT(*) c FROM ' + t + (w ? ' WHERE ' + w : ''))[0]?.values?.[0]?.[0] ?? 0;
  const snap = () => ({ inv: cnt('invoices'), il: cnt('invoice_lines'), led: cnt('ledger_entries'), aud: cnt('audit_log') });
  const allZero = (b, a) => (a.inv - b.inv) === 0 && (a.il - b.il) === 0 && (a.led - b.led) === 0 && (a.aud - b.aud) === 0;
  const lotRem = (id) => id ? (D().exec('SELECT qty_remaining FROM stock_lots WHERE id=?', [id])[0]?.values?.[0]?.[0] ?? null) : null;
  const olInv  = (id) => D().exec('SELECT invoice_id FROM order_lines WHERE id=?', [id])[0]?.values?.[0]?.[0] ?? null;
  const ordInv = (id) => D().exec('SELECT invoice_id FROM orders WHERE id=?', [id])[0]?.values?.[0]?.[0] ?? null;
  const ledgerBal = (invId) => {
    const r = D().exec("SELECT direction, COALESCE(SUM(amount),0) FROM ledger_entries WHERE source_id=? GROUP BY direction", [invId]);
    let deb = 0, cred = 0; for (const row of (r[0]?.values || [])) { if (row[0] === 'DEBIT') deb = row[1]; else cred = row[1]; }
    return { deb, cred, balanced: Math.abs(deb - cred) < 1e-6 && deb > 0 };
  };

  let evCount = 0; const off = ev.eventBus.on('invoice.created', () => { evCount++; });
  const evNow = () => evCount;

  const seed = ({ withAgent = false, lotQty = null, unitCost = 60 } = {}) => {
    const now = new Date().toISOString();
    const pid = 'b5c-p-' + crypto.randomUUID().slice(0, 8), oid = 'b5c-o-' + crypto.randomUUID().slice(0, 8),
          lid = 'b5c-l-' + crypto.randomUUID().slice(0, 8), onum = 'B5C-' + crypto.randomUUID().slice(0, 6);
    const d = D();
    d.run("INSERT INTO products (id,branch_id,category_id,brand,name,purchase_price,stock_status,tax_scheme,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [pid, 'branch-main', 'cat-accessory', 'B5C', 'Smoke Item', unitCost, withAgent ? 'with_agent' : 'in_stock', 'VAT_10', now, now]);
    let lotId = null;
    if (lotQty !== null) {
      lotId = 'b5c-lot-' + crypto.randomUUID().slice(0, 8);
      d.run("INSERT INTO stock_lots (id,branch_id,product_id,unit_cost,qty_total,qty_remaining,status,acquired_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [lotId, 'branch-main', pid, unitCost, lotQty, lotQty, 'ACTIVE', now, now]);
    }
    d.run("INSERT INTO orders (id,branch_id,order_number,customer_id,requested_brand,requested_model,agreed_price,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [oid, 'branch-main', onum, 'c-1', 'B5C', 'Smoke', 110, 'arrived', now, now]);
    d.run("INSERT INTO order_lines (id,order_id,product_id,description,quantity,unit_price,line_total,position,tax_scheme,vat_rate,is_customer_facing,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [lid, oid, pid, 'Smoke line', 1, 100, 110, 1, 'VAT_10', 10, 1, 'ARRIVED', now]);
    return { pid, oid, lid, lotId, lines: [{ productId: pid, quantity: 1, unitPrice: 100, purchasePrice: unitCost, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 10, lineTotal: 110 }] };
  };

  // Spiegelt OrderDetail.convertOrderToInvoiceAtomic EXAKT, mit Fault-Injection-Hooks.
  const runConvert = (customerId, ids, lines, oid, opts = {}) => {
    let created = null;
    tx.convertOrderLinesToInvoiceTx({
      begin: post.beginLedgerTransaction, commit: post.commitLedgerTransaction, rollback: post.rollbackLedgerTransaction,
      assertBillable: () => OS().assertOrderLinesBillable(ids),
      createInvoice: () => {
        if (opts.failCreateBefore) throw new Error('inject-before-create');
        const i = IS().createDirectInvoice(customerId, lines, 'B5C smoke', undefined, undefined, undefined, false);
        created = i; if (opts.failCreateAfter) throw new Error('inject-after-create'); return i;
      },
      linkLinesAndOrder: (invId) => {
        if (opts.failBeforeMark) throw new Error('inject-before-mark');
        OS().markOrderLinesInvoiced(ids, invId);
        if (opts.failAfterMark) throw new Error('inject-after-mark');
        if (oid) OS().updateOrder(oid, { invoiceId: invId });
      },
      refresh: () => { OS().loadOrders(); IS().loadInvoices(); prodStore.useProductStore.getState().loadProducts(); },
    });
    return created;
  };
  const measure = (fn) => { const b = snap(), e0 = evNow(); let error = null, ret = null; try { ret = fn(); } catch (x) { error = (x && x.message) || String(x); } return { b, a: snap(), ev: evNow() - e0, error, ret }; };

  // ── S1 Modern-Erfolg (Lot qty 1) ──
  { const s = seed({ lotQty: 1 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S1 modern: kein Fehler', m.error === null, m.error);
    check('S1 modern: +1 Invoice +1 Line', (m.a.inv - m.b.inv) === 1 && (m.a.il - m.b.il) === 1);
    check('S1 modern: Ledger gebucht+balanciert', m.ret && ledgerBal(m.ret.id).balanced, m.ret && JSON.stringify(ledgerBal(m.ret.id)));
    check('S1 modern: Lot 1->0 konsumiert', lotRem(s.lotId) === 0);
    check('S1 modern: order_line verknuepft', m.ret && olInv(s.lid) === m.ret.id);
    check('S1 modern: order verknuepft', m.ret && ordInv(s.oid) === m.ret.id);
    check('S1 modern: genau 1 invoice.created', m.ev === 1, 'ev=' + m.ev);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S1 modern: 2. Aufruf blockiert', m2.error === ALREADY, m2.error);
    check('S1 modern: 2. Aufruf Null-Delta', allZero(m2.b, m2.a) && m2.ev === 0); }
  // ── S2 Legacy-Erfolg (Overstock-Lot qty 5) ──
  { const s = seed({ lotQty: 5 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S2 legacy: kein Fehler, +1 Invoice', m.error === null && (m.a.inv - m.b.inv) === 1);
    check('S2 legacy: Overstock-Lot 5->4', lotRem(s.lotId) === 4);
    check('S2 legacy: Ledger balanciert', m.ret && ledgerBal(m.ret.id).balanced);
    check('S2 legacy: verknuepft', m.ret && olInv(s.lid) === m.ret.id && ordInv(s.oid) === m.ret.id);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S2 legacy: 2. Aufruf blockiert', m2.error === ALREADY, m2.error);
    check('S2 legacy: Ueberschuss-Lot unveraendert (4)', lotRem(s.lotId) === 4); }
  // ── S3 Rollback A: Markierungsfehler (vor mark) ──
  { const s = seed({ lotQty: 1 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid, { failBeforeMark: true }));
    check('S3 markErr: wirft inject-before-mark', m.error === 'inject-before-mark', m.error);
    check('S3 markErr: ALLE Deltas 0 (Invoice verworfen)', allZero(m.b, m.a));
    check('S3 markErr: Lot NICHT konsumiert (1)', lotRem(s.lotId) === 1);
    check('S3 markErr: order_line NICHT markiert', olInv(s.lid) === null);
    check('S3 markErr: order NICHT verknuepft', ordInv(s.oid) === null);
    check('S3 markErr: invoice.created feuerte, verworfen (ev=1)', m.ev === 1, 'ev=' + m.ev);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S3 markErr: sauberer Retry -> genau +1 Invoice', m2.error === null && (m2.a.inv - m2.b.inv) === 1 && olInv(s.lid) === m2.ret.id); }
  // ── S4 Rollback B: Order-Update-Fehler (nach mark) ──
  { const s = seed({ lotQty: 1 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid, { failAfterMark: true }));
    check('S4 ordErr: wirft inject-after-mark', m.error === 'inject-after-mark', m.error);
    check('S4 ordErr: ALLE Deltas 0', allZero(m.b, m.a));
    check('S4 ordErr: mark ZURUECKGEROLLT (null)', olInv(s.lid) === null);
    check('S4 ordErr: order NICHT verknuepft', ordInv(s.oid) === null);
    check('S4 ordErr: Lot unveraendert (1)', lotRem(s.lotId) === 1);
    check('S4 ordErr: ev=1 (erstellt+verworfen)', m.ev === 1, 'ev=' + m.ev);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S4 ordErr: sauberer Retry -> genau +1 Invoice', m2.error === null && (m2.a.inv - m2.b.inv) === 1); }
  // ── S5 Rollback C: LOT-LOSE Line (vorher ungeschuetzt) ──
  { const s = seed({ lotQty: null }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid, { failBeforeMark: true }));
    check('S5 lotless: wirft vor mark', m.error === 'inject-before-mark', m.error);
    check('S5 lotless: ALLE Deltas 0 (keine Invoice)', allZero(m.b, m.a));
    check('S5 lotless: order_line NICHT markiert', olInv(s.lid) === null);
    check('S5 lotless: ev=1 (erstellt+verworfen)', m.ev === 1, 'ev=' + m.ev);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S5 lotless: sauberer Retry -> EXAKT +1 Invoice', m2.error === null && (m2.a.inv - m2.b.inv) === 1);
    const m3 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S5 lotless: 3. Aufruf blockiert, keine 2. Invoice', m3.error === ALREADY && (m3.a.inv - m3.b.inv) === 0); }
  // ── S6 Point3: Fehler WAEHREND Invoice-Create (nach Row-Writes) ──
  { const s = seed({ lotQty: 1 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid, { failCreateAfter: true }));
    check('S6 duringCreate: wirft inject-after-create', m.error === 'inject-after-create', m.error);
    check('S6 duringCreate: ALLE Deltas 0 (Teil-Invoice verworfen)', allZero(m.b, m.a));
    check('S6 duringCreate: Lot unveraendert (1)', lotRem(s.lotId) === 1);
    check('S6 duringCreate: order_line NICHT markiert', olInv(s.lid) === null);
    const m2 = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S6 duringCreate: sauberer Retry -> +1 Invoice', m2.error === null && (m2.a.inv - m2.b.inv) === 1); }
  // ── S7 With-Agent BLOCK (normaler Pfad, kein allowWithAgent) ──
  { const s = seed({ withAgent: true, lotQty: 1 }); const m = measure(() => runConvert('c-1', [s.lid], s.lines, s.oid));
    check('S7 withAgent: wirft WITH_AGENT-Msg', m.error === WITHAGENT, m.error);
    check('S7 withAgent: ALLE Deltas 0', allZero(m.b, m.a));
    check('S7 withAgent: order_line/order NICHT verknuepft', olInv(s.lid) === null && ordInv(s.oid) === null);
    check('S7 withAgent: Lot unberuehrt (1)', lotRem(s.lotId) === 1);
    check('S7 withAgent: KEIN invoice.created (Guard vor Create, ev=0)', m.ev === 0, 'ev=' + m.ev);
    // ── S8 Agent-Settlement-AUSNAHME: allowWithAgent umgeht Guard ──
    const before = snap(); let err8 = null, inv8 = null;
    try { inv8 = IS().createDirectInvoice('c-1', s.lines, 'B5C agent', undefined, undefined, undefined, false, { allowWithAgent: true }); } catch (x) { err8 = (x && x.message) || String(x); }
    const after = snap();
    check('S8 agentExc: kein Fehler mit allowWithAgent', err8 === null, err8);
    check('S8 agentExc: Invoice ERSTELLT fuer with_agent-Produkt', (after.inv - before.inv) === 1 && !!inv8);
    check('S8 agentExc: Ledger balanciert', inv8 && ledgerBal(inv8.id).balanced); }

  // ── Store-Cache = DB nach Rollback (Point 9) ──
  { const s = seed({ lotQty: 1 }); OS().loadOrders(); IS().loadInvoices();
    let capturedInvId = null, err = null;
    try {
      tx.convertOrderLinesToInvoiceTx({
        begin: post.beginLedgerTransaction, commit: post.commitLedgerTransaction, rollback: post.rollbackLedgerTransaction,
        assertBillable: () => OS().assertOrderLinesBillable([s.lid]),
        createInvoice: () => { const i = IS().createDirectInvoice('c-1', s.lines, 'sc', undefined, undefined, undefined, false); capturedInvId = i.id; return i; },
        linkLinesAndOrder: (invId) => { OS().markOrderLinesInvoiced([s.lid], invId); throw new Error('boom'); },
        refresh: () => { OS().loadOrders(); IS().loadInvoices(); prodStore.useProductStore.getState().loadProducts(); },
      });
    } catch (x) { err = x.message; }
    scheck('Rollback wirft boom', err === 'boom', err);
    scheck('DB: verworfene Invoice fehlt', cnt('invoices', 'id=\'' + capturedInvId + '\'') === 0);
    scheck('DB: order_line unmarkiert', olInv(s.lid) === null);
    scheck('STORE invoices-Cache: verworfene fehlt', !(IS().invoices || []).some(v => v && v.id === capturedInvId));
    const oc = (OS().orders || []).find(o => o && o.id === s.oid); scheck('STORE orders-Cache: invoiceId leer', !!oc && oc.invoiceId == null, 'invId=' + (oc && oc.invoiceId));
    const olc = (typeof OS().getOrderLines === 'function' ? OS().getOrderLines(s.oid) : []).find(l => l && l.id === s.lid); scheck('STORE order_lines-Cache: unmarkiert', !!olc && olc.invoiceId == null); }

  off();
  // Courtesy: vorherigen Dev-localStorage-DB wiederherstellen (Live-DB war nie erreichbar).
  if (typeof savedDev === 'string') localStorage.setItem('lataif_db_v2', savedDev);

  R.pass = R.results.filter(r => r.pass).length + R.storeChecks.filter(r => r.pass).length;
  R.fail = R.results.filter(r => !r.pass).length + R.storeChecks.filter(r => !r.pass).length;
  R.finalCounts = { invoices: cnt('invoices'), invoice_lines: cnt('invoice_lines'), ledger_entries: cnt('ledger_entries'), audit_log: cnt('audit_log'), sync_changelog: cnt('sync_changelog') };
  return R;
}

// Ausfuehrung im Browser (nicht node):
//   const { runB5CStoreWiringSmoke } = await import('/test/b5/order-stock-guards.browser-smoke.mjs');
//   console.log(await runB5CStoreWiringSmoke());
// Erwartet: pass=54, fail=0 (48 Szenario- + 6 Store-Cache-Checks).

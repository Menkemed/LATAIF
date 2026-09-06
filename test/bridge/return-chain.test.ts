// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3H — die Rückgabe mit Gutschrift, von einem zweiten Rechner.
// Run: node test/bridge/return-chain.test.ts
//
// C3G hat diese Kette ausdrücklich vertagt. Was hier bewiesen wird — an echten Zeilen einer
// echten sql.js-Datenbank, nicht an Beteuerungen:
//
//   1. Der PREIS steht nicht im Rumpf. Der Client nennt Zeile und Menge; alles andere rechnet
//      das Haus aus der Rechnung.
//   2. Die Rückgabe wirkt vollständig: Bestand, Wareneinsatz, Steuer, Gutschrift, Forderung,
//      Geld, Nummernkreis, Änderungsjournal.
//   3. Die MENGE ist gedeckelt — und bleibt es, wenn zwei Rechner gleichzeitig das letzte Stück
//      zurücknehmen wollen. Genau einer gewinnt.
//   4. Eine verlorene Antwort kostet kein zweites Mal: kein zweiter Beleg, kein zweiter Bestand,
//      keine zweite Auszahlung.
//   5. Ein alter Stand schreibt nicht über einen neueren.
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
const ret = await import('../../src/core/bridge/return-commands.ts');
const { runInvoiceCreate } = await import('../../src/core/bridge/invoice-command.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { returnLineAmounts, grossUnitPrice } = await import('../../src/core/returns/return-lines.ts');

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
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
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
const rrev = (db: Db, id: string): number => n(db, 'SELECT revision FROM sales_returns WHERE id = ?', [id]);
const arNet = (db: Db, customerId: string): number => n(db,
  `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
     FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = ?`, [customerId]);

async function makeInvoice(d: ReturnType<typeof deps>, nth: string, qty = 1, price = 150) {
  const out = await runInvoiceCreate(d, identity(nth, 'invoices.create'), {
    customerId: 'cust-1', lines: [{ productId: 'p1', quantity: qty, unitPrice: price }],
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { invoiceId: string } }).value.invoiceId;
}
const lineOf = (db: Db, inv: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);

// ── 1) Der Umfang und die Wiederverwendung ───────────────────────────────
{
  const mine = codeOf('src/core/bridge/return-commands.ts');
  ok((mine.match(/runRemoteCommand\(/g) ?? []).length === 4, 'TX alle vier laufen durch die eine Maschine');
  for (const fn of ['createReturn(', 'approveReturn(', 'refundReturn(', 'recordRefundPayment(']) {
    ok(mine.includes(`useSalesReturnStore.getState().${fn}`), `REUSE der Fernweg ruft ${fn.slice(0, -1)} des Hauses`);
  }
  ok(!/INSERT INTO (sales_returns|sales_return_lines|credit_notes|customer_credits|ledger_entries)/i.test(mine),
    'REUSE der Fernweg legt keine Rueckgabe, keine Gutschrift und keine Buchung selbst an');
  ok(!/UPDATE (invoices|sales_returns|credit_notes|products|stock_lots) SET/i.test(mine),
    'REUSE …und schreibt keine Wirkung selbst');
  ok(!/getNextDocumentNumber/.test(mine), 'REUSE die Rueckgabenummer vergibt das Haus');
  ok(/returnLineAmounts\(/.test(mine), 'REUSE Preis und Steuer aus der GETEILTEN Ableitung');
  // Der Preis ist kein Feld — das ist eine Aussage ueber den Vertrag, also am Vertrag geprueft.
  const parsed = ret.parseCreateReturn({
    invoiceId: 'i', expectedRevision: 1, lines: [{ invoiceLineId: 'l', quantity: 1 }],
  });
  ok(parsed.lines.length === 1, 'PAYLOAD eine Zeile mit Kennung und Menge geht durch');
  let priceRejected = false;
  try {
    ret.parseCreateReturn({
      invoiceId: 'i', expectedRevision: 1,
      lines: [{ invoiceLineId: 'l', quantity: 1, unitPrice: 999 }],
    });
  } catch (e) { priceRejected = /unknown field: unitPrice/.test(String(e)); }
  ok(priceRejected, 'PAYLOAD ein PREIS im Rumpf wird abgewiesen — er steht auf der Rechnung');
  let vatRejected = false;
  try {
    ret.parseCreateReturn({
      invoiceId: 'i', expectedRevision: 1, lines: [{ invoiceLineId: 'l', quantity: 1, vatAmount: 1 }],
    });
  } catch (e) { vatRejected = /unknown field: vatAmount/.test(String(e)); }
  ok(vatRejected, 'PAYLOAD …und eine STEUER ebenso');
  // Und die geteilte Ableitung selbst: brutto je Stueck, Steuer anteilig.
  const a = returnLineAmounts({ quantity: 2, lineTotal: 220, vatAmount: 20 }, 1);
  ok(Math.abs(a.unitPrice - 110) < 0.0001, 'SHARED der Stueckpreis ist BRUTTO (110 von 220/2)');
  ok(Math.abs(a.vatAmount - 10) < 0.0001, 'SHARED die Steuer ist anteilig (10 von 20)');
  ok(Math.abs(grossUnitPrice({ quantity: 2, lineTotal: 220 }) - 110) < 0.0001, 'SHARED …und dieselbe Zahl schlaegt die Maske vor');
  // Sie steht in EINER Datei, und der Bildschirm des Primary benutzt sie.
  ok(/returnLineAmounts\(/.test(codeOf('src/pages/invoices/InvoiceDetail.tsx')),
    'SHARED der Bildschirm des Primary rechnet mit derselben Funktion');
}

// ── 2) Anlegen: Wirkung vollstaendig ─────────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 3, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  const arAfterSale = arNet(db, 'cust-1');
  const qtyAfterSale = n(db, "SELECT quantity FROM products WHERE id = 'p1'");
  const cogsBefore = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'COGS'");
  const invRev = irev(db, inv);

  const out = await ret.runCreateReturn(d, identity('2', 'returns.create'), {
    invoiceId: inv, expectedRevision: invRev,
    lines: [{ invoiceLineId: line, quantity: 1 }],
    refundMethod: 'cash', productDisposition: 'IN_STOCK', reason: 'defect',
  });
  ok(out.kind === 'ok', 'CREATE die Rueckgabe entsteht');
  const v = val<Record<string, unknown>>(out);
  const rid = String(v.returnId);
  ok(/^RET/.test(String(v.returnNumber)), `CREATE Nummer aus dem Kreis des Hauses (${String(v.returnNumber)})`);
  ok(String(v.status) === 'REQUESTED', 'CREATE sie steht zunaechst als beantragt');
  // Der BETRAG kam nicht aus dem Rumpf.
  ok(Math.abs(Number(v.totalAmount) - gross) < 0.005,
    `CREATE der Betrag stammt aus der Rechnung (${Number(v.totalAmount)} = ${gross})`);
  ok(Number(v.vatCorrected) > 0, 'CREATE …und die Steuer ebenso');
  // Die Ware ist zurueck.
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === qtyAfterSale + 1,
    'CREATE das Stueck ist wieder im Bestand');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE account = 'COGS'") > cogsBefore,
    'CREATE der Wareneinsatz ist zurueckgedreht');
  // Und die RECHNUNG hat eine neue Fassung — ohne sie waere die verbleibende Menge nicht
  // gegen einen fremden Zugriff gesichert.
  ok(irev(db, inv) > invRev, `REVISION die Rechnung hat eine neue Fassung (${invRev} → ${irev(db, inv)})`);
  ok(rrev(db, rid) >= 1, 'REVISION die Rueckgabe hat eine eigene Fassung');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'sales_returns'") > 0,
    'CHANGELOG die Rueckgabe steht im Aenderungsjournal');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'sales_return_lines'") > 0,
    'CHANGELOG …und ihre Zeilen ebenfalls');

  // Genehmigen: Gutschrift, Steuerkorrektur, Forderung.
  const vatBefore = n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]);
  const before = rrev(db, rid);
  const ap = await ret.runApproveReturn(d, identity('3', 'returns.approve'), { returnId: rid, expectedRevision: before });
  ok(ap.kind === 'ok', 'APPROVE die Genehmigung laeuft');
  const av = val<Record<string, unknown>>(ap);
  ok(String(av.creditNoteId) !== '', 'APPROVE eine Gutschrift entsteht — die eigene Steuerurkunde');
  ok(/^CN|^GS|.+/.test(String(av.creditNoteNumber)) && String(av.creditNoteNumber) !== '',
    `APPROVE …mit eigener Nummer (${String(av.creditNoteNumber)})`);
  ok(n(db, 'SELECT vat_amount FROM invoices WHERE id = ?', [inv]) < vatBefore,
    'APPROVE die Steuer der Rechnung ist korrigiert');
  ok(n(db, 'SELECT COUNT(*) FROM credit_notes WHERE sales_return_id = ?', [rid]) === 1,
    'APPROVE genau EINE Gutschrift');
  ok(rrev(db, rid) > before, 'REVISION die Genehmigung hebt die Fassung der Rueckgabe');
  ok(String(av.status) === 'APPROVED', 'APPROVE der Zustand ist genehmigt');
  ok(arNet(db, 'cust-1') <= arAfterSale, 'APPROVE die Forderung ist nicht groesser geworden');

  // Eine zweite Genehmigung ist ein URTEIL, kein stilles Nichts.
  const twice = await ret.runApproveReturn(d, identity('4', 'returns.approve'), { returnId: rid, expectedRevision: rrev(db, rid) });
  ok(twice.kind === 'rejected' && code(twice) === 'RETURN_NOT_REQUESTED',
    `APPROVE zweimal genehmigen wird abgewiesen (${code(twice)})`);
  ok(twice.kind === 'rejected' && (twice as { frozen: boolean }).frozen, 'APPROVE …und das Urteil ist endgueltig');
}

// ── 3) Erstatten: Geld fliesst genau einmal ──────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 3, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const gross = n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]);
  // Der Kunde hat bezahlt — nur dann kann ueberhaupt Bargeld zurueckfliessen.
  useInvoiceStore.getState().loadInvoices();
  useInvoiceStore.getState().recordPayment(inv, gross, 'cash', 'paid in full');
  const cashBefore = n(db,
    `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
       FROM ledger_entries WHERE account = 'CASH'`);

  const c = await ret.runCreateReturn(d, identity('2', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv),
    lines: [{ invoiceLineId: line, quantity: 1 }], refundMethod: 'cash',
  });
  const rid = String(val<Record<string, unknown>>(c).returnId);

  const r1 = await ret.runRefundReturn(d, identity('5', 'returns.refund'), {
    returnId: rid, amount: gross, expectedRevision: rrev(db, rid),
  });
  ok(r1.kind === 'ok', 'REFUND die Erstattung laeuft');
  const paid = n(db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [rid]);
  ok(paid > 0, `REFUND es ist wirklich Geld geflossen (${paid})`);
  const cashAfter = n(db,
    `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
       FROM ledger_entries WHERE account = 'CASH'`);
  ok(cashAfter < cashBefore, `REFUND die Kasse ist kleiner geworden (${cashBefore} → ${cashAfter})`);
  ok(s(db, 'SELECT refund_status FROM sales_returns WHERE id = ?', [rid]) === 'REFUNDED',
    'REFUND die Rueckgabe gilt als erstattet');

  // WIEDERHOLUNG mit derselben Kennung: kein zweites Mal Geld.
  const again = await ret.runRefundReturn(d, identity('5', 'returns.refund'), {
    returnId: rid, amount: gross, expectedRevision: rrev(db, rid),
  });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed,
    'REPLAY dieselbe Kennung liefert das eingefrorene Ergebnis');
  ok(n(db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [rid]) === paid,
    'REPLAY …und es floss KEIN zweites Mal Geld');
  const cashReplay = n(db,
    `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0)
       FROM ledger_entries WHERE account = 'CASH'`);
  ok(cashReplay === cashAfter, 'REPLAY …und die Kasse steht unveraendert');

  // Ein NEUER Vorsatz auf eine erledigte Rueckgabe ist ein Urteil.
  const third = await ret.runRefundReturn(d, identity('6', 'returns.refund'), {
    returnId: rid, amount: gross, expectedRevision: rrev(db, rid),
  });
  ok(third.kind === 'rejected' && code(third) === 'ALREADY_REFUNDED',
    `REFUND eine erledigte Rueckgabe wird abgewiesen (${code(third)})`);
}

// ── 4) Die Menge: der Deckel und das Rennen um das letzte Stueck ─────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const inv = await makeInvoice(d, '1', 2, 150);   // ZWEI Stueck verkauft
  const line = lineOf(db, inv);

  // Zu viel geht gar nicht erst.
  const tooMuch = await ret.runCreateReturn(d, identity('7', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv),
    lines: [{ invoiceLineId: line, quantity: 3 }],
  });
  ok(tooMuch.kind === 'rejected' && code(tooMuch) === 'RETURN_QUANTITY_EXCEEDED',
    `QTY drei von zwei geht nicht (${code(tooMuch)})`);
  ok(n(db, 'SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ?', [inv]) === 0,
    'QTY …und es blieb NICHTS stehen');

  // Das RENNEN: beide Rechner haben dieselbe Fassung gelesen, beide wollen das letzte Stueck.
  const seen = irev(db, inv);
  const first = await ret.runCreateReturn(d, identity('8', 'returns.create'), {
    invoiceId: inv, expectedRevision: seen, lines: [{ invoiceLineId: line, quantity: 2 }],
  });
  ok(first.kind === 'ok', 'RACE der erste Rechner gibt beide Stuecke zurueck');
  const second = await ret.runCreateReturn(d, identity('9', 'returns.create'), {
    invoiceId: inv, expectedRevision: seen, lines: [{ invoiceLineId: line, quantity: 1 }],
  });
  ok(second.kind === 'rejected' && code(second) === 'RECORD_CHANGED',
    `RACE der zweite laeuft in die FASSUNG (${code(second)})`);
  ok(n(db, 'SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ?', [inv]) === 1,
    'RACE genau EINE Rueckgabe entstand');
  ok(n(db,
    `SELECT COALESCE(SUM(srl.quantity),0) FROM sales_return_lines srl
       JOIN sales_returns r ON r.id = srl.return_id
      WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'`, [line]) === 2,
    'RACE …und insgesamt kamen genau zwei Stueck zurueck, nicht drei');

  // Und der zweite Riegel greift auch ohne den ersten: mit FRISCHER Fassung ist die Menge weg.
  const fresh = await ret.runCreateReturn(d, identity('10', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv), lines: [{ invoiceLineId: line, quantity: 1 }],
  });
  ok(fresh.kind === 'rejected' && code(fresh) === 'RETURN_QUANTITY_EXCEEDED',
    `QTY der Mengendeckel haelt auch mit frischer Fassung (${code(fresh)})`);
}

// ── 5) Verlorene Antwort beim Anlegen: kein zweiter Beleg ────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const seen = irev(db, inv);
  const payload = { invoiceId: inv, expectedRevision: seen, lines: [{ invoiceLineId: line, quantity: 1 }] };
  const qtyBefore = n(db, "SELECT quantity FROM products WHERE id = 'p1'");

  const a = await ret.runCreateReturn(d, identity('11', 'returns.create'), payload);
  ok(a.kind === 'ok', 'LOST der erste Versuch lief');
  const b = await ret.runCreateReturn(d, identity('11', 'returns.create'), payload);
  ok(b.kind === 'ok' && (b as { replayed: boolean }).replayed, 'LOST die Wiederholung liefert dieselbe Antwort');
  ok(val<Record<string, unknown>>(a).returnId === val<Record<string, unknown>>(b).returnId,
    'LOST …und dieselbe Rueckgabe');
  ok(n(db, 'SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ?', [inv]) === 1,
    'LOST es gibt EINEN Beleg, nicht zwei');
  ok(n(db, "SELECT quantity FROM products WHERE id = 'p1'") === qtyBefore + 1,
    'LOST …und der Bestand stieg genau EINMAL');
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') >= 1, 'LOST der durable Nachweis steht');

  // Dieselbe Kennung, ANDERER Rumpf: kein Urteil, sondern gar keine Bewertung.
  const conflict = await ret.runCreateReturn(
    { ...d } as never,
    { ...identity('11', 'returns.create'), payloadHash: 'anders' },
    payload,
  );
  ok(conflict.kind === 'rejected' && code(conflict) === 'COMMAND_ID_CONFLICT',
    `CONFLICT gleiche Kennung + anderer Rumpf = Konflikt (${code(conflict)})`);
  ok(conflict.kind === 'rejected' && !(conflict as { frozen: boolean }).frozen,
    'CONFLICT …und er wird NICHT als fachliches Nein eingefroren');
}

// ── 6) Alter Stand schreibt nicht ueber neueren ──────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const d = deps(db);
  seedProduct(db, 'p1', 5, 100);
  const inv = await makeInvoice(d, '1', 1, 150);
  const line = lineOf(db, inv);
  const c = await ret.runCreateReturn(d, identity('12', 'returns.create'), {
    invoiceId: inv, expectedRevision: irev(db, inv), lines: [{ invoiceLineId: line, quantity: 1 }],
  });
  const rid = String(val<Record<string, unknown>>(c).returnId);
  const seen = rrev(db, rid);
  // Der Primary genehmigt sie inzwischen.
  useSalesReturnStore.getState().loadReturns();
  useSalesReturnStore.getState().approveReturn(rid);
  ok(rrev(db, rid) > seen, 'STALE der Primary hat die Fassung inzwischen gehoben');
  const stale = await ret.runRefundReturn(d, identity('13', 'returns.refund'), {
    returnId: rid, amount: 10, expectedRevision: seen,
  });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED',
    `STALE der alte Stand wird abgewiesen (${code(stale)})`);
  ok(n(db, 'SELECT refund_paid_amount FROM sales_returns WHERE id = ?', [rid]) === 0,
    'STALE …und es floss nichts');
  // Kein Zeitstempel als Sperre.
  const mine = codeOf('src/core/bridge/return-commands.ts');
  ok(!/updated_at.*expected|expected.*updated_at/i.test(mine), 'STALE die Sperre ist kein Zeitstempel');
  ok(/assertRevision\('sales_returns'/.test(mine), 'STALE …sondern die Fassung der Rueckgabe');
  ok(/assertRevision\('invoices'/.test(mine), 'STALE …und beim Anlegen die der Rechnung');
}

// ── 7) Die Trigger, die das alles tragen ─────────────────────────────────
{
  const dbSrc = src('src/core/db/database.ts');
  for (const t of [
    'trg_sales_returns_revision',
    'trg_sales_return_lines_insert_returns_revision',
    'trg_sales_return_lines_update_returns_revision',
    'trg_sales_return_lines_delete_returns_revision',
    'trg_credit_notes_insert_returns_revision',
    'trg_credit_notes_update_returns_revision',
    'trg_sales_returns_insert_invoice_revision',
    'trg_sales_returns_update_invoice_revision',
    'trg_credit_notes_insert_invoice_revision',
  ]) {
    ok(dbSrc.includes(`CREATE TRIGGER ${t}`), `TRIGGER ${t} existiert`);
  }
  // Und sie sind wirklich in der Datenbank, nicht nur im Quelltext.
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  const live = db.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%returns%'")[0];
  const names = (live?.values ?? []).map((v) => String(v[0]));
  ok(names.length >= 8, `TRIGGER ${names.length} davon stehen wirklich in der Datenbank`);
}

console.log(`\n${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1a — Transaktions-, Fassungs-, Filial- und Rechtegrundlage.
// Run: node test/p1a/transaction-safety.test.ts
//
//   §1 innerer Fehler, vom Aufrufer gefangen → kein Weiterschreiben, kein Commit, nichts gespeichert
//   §2 innerer Erfolg, äußerer Fehler → alles zurück
//   §3 `invoice.paid` erst nach dem äußeren Commit (Klammer: nach dem dauerhaften Speichern), nie bei Rollback
//   §4 veraltete Fassung (Primary über runOnPrimary, PC2) → INVOICE_CHANGED, nichts geändert
//   §5 fremde Filiale → abgewiesen (Haus und PC2)
//   §6 Rollen für die Mixed-Invoice-Wege: nur ADMIN/MANAGER; bestehende Rechte unverändert
//   §7 Lieferanten-Guthaben zurückgeben: fail-closed statt klemmen
//   §8 normale Schachtelung unverändert
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
const tc = await import('../../src/core/db/transaction-context.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
// Der echte Automatik-Handler bleibt — wie in der App — der EINZIGE `invoice.paid`-Handler (er läuft synchron im
// `emit`). Gezählt wird über das Ereignisprotokoll; WO er schreibt, zeigt ein Mithörer an `db.run` (unten).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { runOnPrimary } = await import('../../src/core/data/primary-action.ts');
const { editInvoiceOnPrimary } = await import('../../src/core/invoices/invoice-edit-house.ts');
const { runInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { mayManageMixedInvoices, assertMixedInvoiceActor, MIXED_INVOICE_NOT_PERMITTED } = await import('../../src/core/invoices/mixed-invoice-permission.ts');
const { OPERATION_PERMISSIONS } = await import('../../src/core/bridge/command-permissions.ts');
const { restoreSupplierCreditUsage, SUPPLIER_CREDIT_RESTORE_MISMATCH } = await import('../../src/core/finance/supplierCreditRestore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-10-20T08:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  prepare(sql: string): { run(p?: unknown[]): unknown; free(): void };
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

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({ name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0 }));
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
    data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (/_at$|date/i.test(c.name) ? NOW : '');
  }
  const names = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((k) => data[k]));
}
function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
}
function product(db: Db, id: string): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`,
  [id, 'M ' + id, 'SKU-' + id, NOW, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES (?,'branch-main',?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, id, NOW, NOW]);
}
function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tc.resetTransactionContext();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  for (const b of ['branch-main', 'branch-2']) {
    db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,'tenant-1',?,?,?)", [b, b, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  // Mithörer: der `invoice.paid`-Handler schreibt `last_purchase_at` — in welcher Transaktionstiefe?
  const guarded = db.run.bind(db);
  db.run = (sql: string, p?: unknown[]): unknown => {
    if (/UPDATE customers SET\s+last_purchase_at/.test(sql)) handlerWrites.push({ customer: String(p?.[3] ?? ''), depth: tc.transactionDepth() });
    return guarded(sql, p);
  };
  reload();
  tauriState.reset();
  return db;
}
const handlerWrites: Array<{ customer: string; depth: number }> = [];

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
async function meldungAsync(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const LINE = (productId: string, price = 1000, lineId?: string) => ({
  ...(lineId ? { lineId } : {}),
  productId, quantity: 1, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: price / 10, lineTotal: price * 1.1,
});
function rechnung(db: Db, pid: string, date = '2026-10-20'): string {
  product(db, pid);
  reload();
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [LINE(pid)] as never, 'P1a', date).id);
  reload();
  return id;
}
function zahlung(invId: string, amount: number, day = '2026-10-21'): void {
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, amount, 'cash', undefined, undefined, undefined, undefined, undefined,
    { receivedAt: `${day}T10:00:00.000Z` } as never));
  reload();
}
const lineOf = (db: Db, inv: string): string => s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv]);
const rev = (db: Db, inv: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]);
/** Was sich an einer Rechnung und ihrem Hauptbuch ändern könnte — als Fingerabdruck. */
function zustand(db: Db, inv: string): string {
  return JSON.stringify([
    db.exec('SELECT gross_amount, paid_amount, status, revision, customer_id, issued_at, notes FROM invoices WHERE id = ?', [inv])[0]?.values,
    db.exec('SELECT unit_price, line_total, vat_amount, quantity FROM invoice_lines WHERE invoice_id = ? ORDER BY position', [inv])[0]?.values,
    n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [inv]),
  ]);
}
const paidOf = (id: string) => eventBus.getLog().filter((e) => e.type === 'invoice.paid' && e.entityId === id);

// ── §1 innerer Fehler, vom Aufrufer gefangen ───────────────────────────────────
{
  const db = freshDb();
  // a) generisch: innere Ebene schreibt und scheitert; der Äußere fängt und will weiterschreiben.
  let weiter = '', commit = '';
  const vorher = n(db, 'SELECT COUNT(*) FROM customers');
  posting.beginLedgerTransaction();
  try {
    try {
      imHaus(() => {
        db.run("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('cust-x','branch-main','X','Y','BH','en',0,'[]','collector','active',?,?)", [NOW, NOW]);
        throw new Error('innerer Schritt gescheitert');
      });
    } catch { /* der Aufrufer fängt — genau der gefährliche Fall */ }
    ok(tc.isRollbackOnly() && tc.transactionDepth() === 1, '§1a nach innerem Fehler: rollback-only, die äußere Ebene bleibt offen');
    weiter = meldung(() => db.run("UPDATE customers SET notes = 'nach dem Fehler' WHERE id = 'cust-1'"));
    ok(weiter.startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|'), `§1a Weiterschreiben wird abgewiesen (${weiter.slice(0, 60)})`);
    ok(meldung(() => posting.beginLedgerTransaction()).startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|'), '§1a keine neue Ebene in der toten Klammer');
    // Ein vorbereiteter Befehl geht am Schreibwächter vorbei — er überlebt das Ende trotzdem nicht.
    const st = db.prepare("INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at) VALUES ('cust-y','branch-main','X','Y','BH','en',0,'[]','collector','active',?,?)");
    st.run([NOW, NOW]); st.free();
    commit = meldung(() => posting.commitLedgerTransaction());
  } catch (e) { posting.rollbackLedgerTransaction(); throw e; }
  ok(commit.startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|'), `§1a das äußere Commit wirft (${commit.slice(0, 60)})`);
  ok(n(db, 'SELECT COUNT(*) FROM customers') === vorher && s(db, "SELECT COALESCE(notes,'') FROM customers WHERE id = 'cust-1'") === '',
    '§1a nichts gespeichert: weder der innere Schritt noch der vorbereitete Befehl noch das Weiterschreiben');
  ok(tc.transactionDepth() === 0 && !tc.isRollbackOnly() && !tc.isTransactionActive(), '§1a danach: Tiefe 0, Zustand frei');
  ok(meldung(() => imHaus(() => db.run("UPDATE customers SET notes = 'neu' WHERE id = 'cust-2'"))) === ''
    && s(db, "SELECT notes FROM customers WHERE id = 'cust-2'") === 'neu', '§1a die nächste Transaktion läuft normal');
}
{
  // b) echt: `editInvoice` scheitert IN seiner Transaktion — nach der Gegenbuchung fehlt Bestand für die
  //    höhere Menge (das Los hat 1) —, der Äußere fängt und schreibt weiter.
  //    (P1b: die VAT-/Stichtagssperre greift jetzt schon VOR der Transaktion; dafür taugt sie hier nicht mehr.)
  const db = freshDb();
  const inv = rechnung(db, 'p1');
  zahlung(inv, 600);
  const vor = zustand(db, inv);
  const paidVor = paidOf(inv).length;
  let innen = '', weiter = '';
  const zwei = { ...LINE('p1', 1000, lineOf(db, inv)), quantity: 2, vatAmount: 200, lineTotal: 2200 };
  const aussen = meldung(() => imHaus(() => {
    innen = meldung(() => useInvoiceStore.getState().editInvoice(inv, { lines: [zwei] as never, reason: 'x' }));
    weiter = meldung(() => db.run("UPDATE customers SET notes = 'verschluckt' WHERE id = 'cust-2'"));
  }));
  ok(innen.startsWith('INVOICE_KEPT_LINE_LOT_SHORT|'), `§1b editInvoice scheitert innen, nach der Gegenbuchung (${innen.slice(0, 40)})`);
  ok(weiter.startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|') && aussen.startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|'),
    `§1b Weiterschreiben und äußeres Commit fail-closed (${aussen.slice(0, 40)})`);
  reload();
  ok(zustand(db, inv) === vor && s(db, "SELECT COALESCE(notes,'') FROM customers WHERE id = 'cust-2'") === '',
    '§1b kein Teilzustand: Rechnung, Zeilen, Edits, Hauptbuch, Zahlungen unverändert; nichts verschluckt gespeichert');
  ok(paidOf(inv).length === paidVor && tc.transactionDepth() === 0, '§1b kein Ereignis, Tiefe 0');
}
{
  // c) Koordinator (Medien/Sync-Muster) als Eigentümer: eine innere Ledger-Ebene scheitert, er fängt und will committen.
  const db = freshDb();
  const vorher = n(db, 'SELECT COUNT(*) FROM customers');
  const outermost = tc.enterTransaction();
  db.run('BEGIN');
  let ergebnis = '';
  try {
    try { imHaus(() => { db.run("UPDATE customers SET notes = 'innen' WHERE id = 'cust-1'"); throw new Error('innen'); }); } catch { /* gefangen */ }
    if (tc.leaveNestedTransaction() && outermost) db.run('COMMIT');
    ergebnis = 'committed';
  } catch (e) {
    if (outermost) { tc.resetTransactionContext(); try { db.run('ROLLBACK'); } catch { /* schon */ } }
    ergebnis = String((e as { code?: unknown }).code ?? 'err');
  }
  ok(ergebnis === tc.TRANSACTION_ROLLBACK_ONLY && n(db, 'SELECT COUNT(*) FROM customers') === vorher
    && s(db, "SELECT COALESCE(notes,'') FROM customers WHERE id = 'cust-1'") === '' && tc.transactionDepth() === 0,
    `§1c Koordinator kann nach innerem Fehler nicht committen, alles zurück (${ergebnis})`);
}

// ── §2 innerer Erfolg, äußerer Fehler ──────────────────────────────────────────
{
  const db = freshDb();
  const inv = rechnung(db, 'p2');
  const vor = zustand(db, inv);
  const m = meldung(() => imHaus(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p2', 800, lineOf(db, inv))] as never, reason: 'außen scheitert danach' });
    throw new Error('Folgeschritt gescheitert');
  }));
  reload();
  ok(m.endsWith('Folgeschritt gescheitert') && zustand(db, inv) === vor, '§2 Rechnung, Zeilen, 0 Edits, Hauptbuch unverändert');
  // Primary-Klammer: dasselbe über runOnPrimary.
  const m2 = await meldungAsync(() => runOnPrimary(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p2', 800, lineOf(db, inv))] as never, reason: 'x', expectedRevision: rev(db, inv) });
    throw new Error('Folgeschritt gescheitert');
  }, reload));
  ok(m2.endsWith('Folgeschritt gescheitert') && zustand(db, inv) === vor && tc.transactionDepth() === 0, '§2 runOnPrimary: ebenso vollständig zurück');
}

// ── §3 invoice.paid erst am Ende der äußersten Transaktion — atomar mit ihr ─────
/** Die Pflichtwirkungen des Handlers: Artikel „sold", letzter Kauf des Kunden, verknüpfte Reparatur bezahlt. */
function wirkung(db: Db, inv: string, pid: string): string {
  return JSON.stringify([
    s(db, 'SELECT stock_status FROM products WHERE id = ?', [pid]),
    s(db, "SELECT COALESCE(last_purchase_at,'') <> '' FROM customers WHERE id = 'cust-1'"),
    s(db, "SELECT COALESCE(customer_payment_status,'') FROM repairs WHERE invoice_id = ?", [inv]),
  ]);
}
function reparaturAn(db: Db, inv: string): void {
  insert(db, 'repairs', { id: 'rep-' + inv.slice(0, 8), branch_id: 'branch-main', repair_number: 'REP-T-' + inv.slice(0, 4), customer_id: 'cust-1',
    issue_description: 'Test', received_at: NOW, invoice_id: inv, charge_to_customer: 1100, customer_payment_status: 'UNPAID', created_at: NOW, updated_at: NOW });
}
const OHNE = JSON.stringify(['reserved', '0', 'UNPAID']);
const MIT = JSON.stringify(['sold', '1', 'PAID']);
{
  const db = freshDb();
  const inv = rechnung(db, 'p3');
  reparaturAn(db, inv);
  zahlung(inv, 600);
  ok(paidOf(inv).length === 0 && wirkung(db, inv, 'p3') === OHNE, `§3 Teilzahlung: noch kein invoice.paid, keine Wirkung (${wirkung(db, inv, 'p3')})`);
  // a) geschachtelt: die Delta-Zahlung IN editInvoice macht die Rechnung FINAL.
  let waehrend = -1;
  const schreibVor = handlerWrites.length;
  imHaus(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p3', 1000, lineOf(db, inv))] as never, reason: 'Rest bezahlt',
      deltaPayment: { amount: 500, method: 'cash' } } as never);
    waehrend = paidOf(inv).length;
  });
  reload();
  const w = handlerWrites.slice(schreibVor);
  ok(waehrend === 0, '§3a während der äußeren Schritte: kein invoice.paid (auch nicht von der Delta-Zahlung)');
  ok(paidOf(inv).length === 1 && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'FINAL', `§3a genau EINMAL (${paidOf(inv).length})`);
  ok(w.length === 1 && w[0].depth === 1, `§3a der Handler schreibt IN der äußeren Transaktion, an ihrem Ende (${JSON.stringify(w)})`);
  ok(wirkung(db, inv, 'p3') === MIT, `§3a alle Pflichtwirkungen gespeichert: Artikel sold, letzter Kauf, Reparatur PAID (${wirkung(db, inv, 'p3')})`);
}
{
  // b) äußerer Rollback nach einem FINAL-Edit: nie ein Ereignis, keine Wirkung.
  const db = freshDb();
  const inv = rechnung(db, 'p4');
  reparaturAn(db, inv);
  zahlung(inv, 600);
  meldung(() => imHaus(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p4', 1000, lineOf(db, inv))] as never, reason: 'x',
      deltaPayment: { amount: 500, method: 'cash' } } as never);
    throw new Error('danach gescheitert');
  }));
  reload();
  ok(paidOf(inv).length === 0 && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) === 'PARTIAL' && wirkung(db, inv, 'p4') === OHNE,
    '§3b Rollback: kein invoice.paid, Status unverändert, keine Pflichtwirkung');
  // b2) eine Folge, die die Transaktion scheitern lässt, verhindert das ganze Commit (fail-closed).
  const vor = zustand(db, inv);
  const m = meldung(() => imHaus(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p4', 1000, lineOf(db, inv))] as never, reason: 'x',
      deltaPayment: { amount: 500, method: 'cash' } } as never);
    tc.runAtOuterCommit('test:scheitert', () => { try { imHaus(() => { throw new Error('Folge scheitert'); }); } catch { /* gefangen */ } });
  }));
  reload();
  // Der Handler lief (vor der scheiternden Folge) und steht im Ereignisprotokoll des Speichers — seine
  // Schreibwirkung aber ging mit dem Rollback: in der Datenbank steht nichts davon.
  ok(m.startsWith(tc.TRANSACTION_ROLLBACK_ONLY + '|') && zustand(db, inv) === vor && wirkung(db, inv, 'p4') === OHNE,
    `§3b eine gescheiterte Folge am Commit: nichts committet, keine Pflichtwirkung gespeichert (${m.slice(0, 40)})`);
}
{
  // c) Primary-Klammer (runOnPrimary): einmal, in der Transaktion, Wirkung gespeichert; bei äußerem Fehler nichts.
  const db = freshDb();
  const inv = rechnung(db, 'p5');
  reparaturAn(db, inv);
  zahlung(inv, 600);
  const schreibVor = handlerWrites.length;
  await editInvoiceOnPrimary(inv, { lines: [LINE('p5', 1000, lineOf(db, inv))] as never, reason: 'Rest bezahlt',
    deltaPayment: { amount: 500, method: 'cash' } } as never, rev(db, inv));
  const w = handlerWrites.slice(schreibVor);
  ok(paidOf(inv).length === 1 && w.length === 1 && w[0].depth === 1 && wirkung(db, inv, 'p5') === MIT,
    `§3c runOnPrimary: einmal, Handler in der Transaktion, Pflichtwirkung gespeichert (${paidOf(inv).length}, ${JSON.stringify(w)}, ${wirkung(db, inv, 'p5')})`);
  const inv2 = rechnung(db, 'p14');
  reparaturAn(db, inv2);
  zahlung(inv2, 600);
  const vorW2 = wirkung(db, inv2, 'p14');   // derselbe Kunde hat durch inv schon einen letzten Kauf
  await meldungAsync(() => runOnPrimary(() => {
    useInvoiceStore.getState().editInvoice(inv2, { lines: [LINE('p14', 1000, lineOf(db, inv2))] as never, reason: 'x',
      deltaPayment: { amount: 500, method: 'cash' } } as never);
    throw new Error('Folgeschritt gescheitert');
  }, reload));
  ok(paidOf(inv2).length === 0 && wirkung(db, inv2, 'p14') === vorW2 && JSON.parse(vorW2)[0] === 'reserved' && JSON.parse(vorW2)[2] === 'UNPAID'
    && s(db, 'SELECT status FROM invoices WHERE id = ?', [inv2]) === 'PARTIAL',
    `§3c runOnPrimary mit Fehler danach: kein Ereignis, keine Wirkung, Rechnung unverändert (${paidOf(inv2).length} ${wirkung(db, inv2, 'p14')})`);
}
{
  // d) PC2: einmal; scheitert das dauerhafte Speichern danach, bleiben Rechnung UND Wirkung beisammen (eine Einheit).
  const db = freshDb();
  const deps = (save: () => Promise<void>) => ({
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: save, now: () => NOW,
  });
  const ident = (k: string, branchId = 'branch-main') => ({ commandId: `00000${k}-0000-4000-8000-000000000000`, tenantId: 'tenant-1', branchId,
    userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h' + k });
  const a = rechnung(db, 'p6');
  zahlung(a, 600);
  const net600 = 600 / 1.1;
  const r = await runInvoiceUpdate(deps(async () => { /* ok */ }) as never, ident('701') as never, {
    id: a, customerId: 'cust-1', expectedRevision: rev(db, a), reason: 'Preis auf Bezahltes', lines: [{ lineId: lineOf(db, a), productId: 'p6', lotId: 'lot-p6', quantity: 1, unitPrice: net600 }],
  });
  reload();
  ok(r.kind === 'ok' && paidOf(a).length === 1 && s(db, "SELECT stock_status FROM products WHERE id = 'p6'") === 'sold',
    `§3d PC2: invoice.paid einmal, Artikel sold (${r.kind}, ${paidOf(a).length})`);
  const b = rechnung(db, 'p7');
  reparaturAn(db, b);
  zahlung(b, 600);
  const fehler = await meldungAsync(() => runInvoiceUpdate(deps(async () => { throw new Error('Platte voll'); }) as never, ident('702') as never, {
    id: b, customerId: 'cust-1', expectedRevision: rev(db, b), reason: 'Preis auf Bezahltes', lines: [{ lineId: lineOf(db, b), productId: 'p7', lotId: 'lot-p7', quantity: 1, unitPrice: net600 }],
  }));
  resetDurabilityStateForTest();
  // Kein Ergebnis an PC2 (offener Ausgang) — aber im Speicher stehen Rechnung FINAL und ALLE Pflichtwirkungen gemeinsam
  // (derselbe Commit); das nachgeholte Speichern nimmt beides mit. Vorher (nach dem Speichern) gingen sie hier verloren.
  ok(fehler !== '' && s(db, 'SELECT status FROM invoices WHERE id = ?', [b]) === 'FINAL' && paidOf(b).length === 1 && wirkung(db, b, 'p7') === MIT,
    `§3d PC2: Speichern scheitert → Rechnung und Pflichtwirkung bleiben EINE Einheit (${fehler.slice(0, 40)}, ${wirkung(db, b, 'p7')})`);
}
{
  // e) ohne Klammer unverändert: eine Zahlung, die die Rechnung schließt, meldet einmal; der Handler schreibt in IHRER Transaktion.
  const db = freshDb();
  const inv = rechnung(db, 'p8');
  reparaturAn(db, inv);
  const schreibVor = handlerWrites.length;
  imHaus(() => useInvoiceStore.getState().recordPayment(inv, 1100, 'cash'));
  reload();
  const w = handlerWrites.slice(schreibVor);
  ok(paidOf(inv).length === 1 && w.length === 1 && w[0].depth === 1 && wirkung(db, inv, 'p8') === MIT,
    `§3e Zahlung allein: einmal, in ihrer Transaktion, Pflichtwirkung gespeichert (${paidOf(inv).length}, ${JSON.stringify(w)})`);
  // f) dieselbe Zahlung ohne jede Klammer: `recordPayment` öffnet nur bei Überzahlung eine eigene Transaktion —
  //    ohne Transaktion läuft der Handler wie bisher sofort (Tiefe 0). In der App läuft die Zahlung über runOnPrimary.
  const inv2 = rechnung(db, 'p15');
  const vor2 = handlerWrites.length;
  useInvoiceStore.getState().recordPayment(inv2, 1100, 'cash');
  reload();
  const w2 = handlerWrites.slice(vor2);
  ok(paidOf(inv2).length === 1 && w2.length === 1 && w2[0].depth === 0 && s(db, "SELECT stock_status FROM products WHERE id = 'p15'") === 'sold',
    `§3f Zahlung ohne Transaktion: unverändert einmal, sofort, Artikel sold (${JSON.stringify(w2)})`);
  ok(/return runOnPrimary\(\(\) => recordInvoicePaymentInHouse\(input, branchId\), frischLesen\)/.test(src('src/core/invoices/invoice-payment-house.ts')),
    '§3f die Zahlungsmaske des Primary läuft über runOnPrimary (also §3e)');
}

// ── §4 veraltete Fassung ───────────────────────────────────────────────────────
{
  const db = freshDb();
  const inv = rechnung(db, 'p9');
  const gesehen = rev(db, inv);
  db.run("UPDATE invoices SET notes = 'von PC2 geändert' WHERE id = ?", [inv]);   // Trigger: Fassung +1
  reload();
  const vor = zustand(db, inv);
  const m = await meldungAsync(() => editInvoiceOnPrimary(inv, { lines: [LINE('p9', 700, lineOf(db, inv))] as never, reason: 'alt' }, gesehen));
  ok(m.startsWith('INVOICE_CHANGED|') && zustand(db, inv) === vor && rev(db, inv) === gesehen + 1,
    `§4 Primary auf veralteter Fassung: INVOICE_CHANGED, keine Änderung (${m.slice(0, 50)})`);
  await editInvoiceOnPrimary(inv, { lines: [LINE('p9', 700, lineOf(db, inv))] as never, reason: 'aktuell' }, rev(db, inv));
  reload();
  ok(Math.abs(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) - 770) < 0.001, '§4 mit der aktuellen Fassung: gespeichert');
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const vor2 = zustand(db, inv);
  const r = await runInvoiceUpdate(d as never, { commandId: '00000801-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main',
    userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h801' } as never, {
    id: inv, customerId: 'cust-1', expectedRevision: gesehen, reason: 'alt', lines: [{ lineId: lineOf(db, inv), productId: 'p9', lotId: 'lot-p9', quantity: 1, unitPrice: 600 }],
  });
  ok(r.kind === 'rejected' && (r as { code?: string }).code === 'INVOICE_CHANGED' && zustand(db, inv) === vor2, '§4 PC2 auf veralteter Fassung: INVOICE_CHANGED, keine Änderung');
}

// ── §5 fremde Filiale ─────────────────────────────────────────────────────────
{
  const db = freshDb();
  const inv = rechnung(db, 'p10');
  db.run("UPDATE invoices SET branch_id = 'branch-2' WHERE id = ?", [inv]);
  const vor = zustand(db, inv);
  const m = meldung(() => useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p10', 500, lineOf(db, inv))] as never, reason: 'x' }));
  ok(m.startsWith('INVOICE_NOT_FOUND|') && zustand(db, inv) === vor, `§5 Haus: Rechnung einer anderen Filiale abgewiesen (${m.slice(0, 50)})`);
  db.run("UPDATE invoices SET branch_id = 'branch-main' WHERE id = ?", [inv]);
  reload();
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const vor2 = zustand(db, inv);
  const r = await runInvoiceUpdate(d as never, { commandId: '00000901-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-2',
    userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h901' } as never, {
    id: inv, customerId: 'cust-1', expectedRevision: rev(db, inv), reason: 'fremd', lines: [{ lineId: lineOf(db, inv), productId: 'p10', lotId: 'lot-p10', quantity: 1, unitPrice: 500 }],
  });
  ok(r.kind === 'rejected' && (r as { code?: string }).code === 'INVOICE_NOT_FOUND' && zustand(db, inv) === vor2,
    '§5 PC2: Absender einer anderen Filiale abgewiesen, nichts geändert');
}

// ── §6 Rollen für die Mixed-Invoice-Wege ──────────────────────────────────────
{
  for (const r of ['ADMIN', 'MANAGER', 'owner', 'manager']) ok(mayManageMixedInvoices(r), `§6 ${r} darf`);
  for (const r of ['SALES', 'ACCOUNTANT', 'sales', 'backoffice', 'viewer', '', 'superuser', undefined, null]) {
    ok(!mayManageMixedInvoices(r as never), `§6 ${String(r)} darf nicht`);
  }
  ok(meldung(() => assertMixedInvoiceActor({ role: 'SALES' })).startsWith(MIXED_INVOICE_NOT_PERMITTED + '|')
    && meldung(() => assertMixedInvoiceActor(undefined)).startsWith(MIXED_INVOICE_NOT_PERMITTED + '|')
    && meldung(() => assertMixedInvoiceActor({ role: 'MANAGER' })) === '', '§6 Hausprüfung wirft mit Kennung, fail-closed ohne Rolle');
  const p = OPERATION_PERMISSIONS as Record<string, { kind?: string; permission?: string } | null>;
  ok(p['invoices.update']?.kind === 'isAdmin' && p['invoices.create']?.kind === 'permission' && p['invoices.create']?.permission === 'invoices.create'
    && p['consignments.record_sale']?.kind === 'isAdmin' && p['purchases.correct']?.kind === 'isOwner',
    '§6 bestehende Rechte unverändert (Rechnung ändern, anlegen, Kommission verkaufen, Einkauf korrigieren)');
}

// ── §7 Lieferanten-Guthaben zurückgeben: fail-closed ──────────────────────────
{
  const db = freshDb();
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','L',1,?,?)", [NOW, NOW]);
  insert(db, 'supplier_credits', { id: 'sc1', branch_id: 'branch-main', supplier_id: 'sup-1', amount: 100, used_amount: 60, status: 'OPEN', created_at: NOW });
  imHaus(() => restoreSupplierCreditUsage('sc1', 40));
  ok(n(db, "SELECT used_amount FROM supplier_credits WHERE id = 'sc1'") === 20 && s(db, "SELECT status FROM supplier_credits WHERE id = 'sc1'") === 'OPEN',
    '§7 Rückgabe wie bisher (60 → 20, OPEN)');
  const zuViel = meldung(() => imHaus(() => restoreSupplierCreditUsage('sc1', 50)));
  ok(zuViel.startsWith(SUPPLIER_CREDIT_RESTORE_MISMATCH + '|') && n(db, "SELECT used_amount FROM supplier_credits WHERE id = 'sc1'") === 20,
    '§7 mehr zurück als verbraucht: abgewiesen statt auf 0 geklemmt');
  ok(meldung(() => imHaus(() => restoreSupplierCreditUsage('fehlt', 10))).startsWith(SUPPLIER_CREDIT_RESTORE_MISMATCH + '|')
    && meldung(() => imHaus(() => restoreSupplierCreditUsage('', 10))).startsWith(SUPPLIER_CREDIT_RESTORE_MISMATCH + '|'),
    '§7 fehlende Gutschrift oder Kennung: abgewiesen statt still übersprungen');
  ok(meldung(() => imHaus(() => restoreSupplierCreditUsage('', 0))) === '', '§7 Betrag 0: nichts zu tun');
  const ph = src('src/core/purchases/purchase-edit-house.ts');
  ok(/if \(method === 'credit'\) \{\s*const issue = supplierCreditRestoreIssue\([\s\S]{0,120}\);\s*if \(issue\) throw nein\(SUPPLIER_CREDIT_RESTORE_MISMATCH, issue\);/.test(ph)
    && ph.indexOf('supplierCreditRestoreIssue(pay.reference') < ph.indexOf("db.run('UPDATE purchase_payments SET voided_at"),
    '§7 „Void payment" prüft die Rückgabe VOR dem ersten Schreiben');
}

// ── §8 normale Schachtelung unverändert ──────────────────────────────────────
{
  const db = freshDb();
  const inv = rechnung(db, 'p11');
  imHaus(() => {
    useInvoiceStore.getState().editInvoice(inv, { lines: [LINE('p11', 900, lineOf(db, inv))] as never, reason: 'geschachtelt' });
    db.run("UPDATE customers SET notes = 'außen' WHERE id = 'cust-2'");
  });
  reload();
  ok(Math.abs(n(db, 'SELECT gross_amount FROM invoices WHERE id = ?', [inv]) - 990) < 0.001
    && n(db, 'SELECT COUNT(*) FROM invoice_edits WHERE invoice_id = ?', [inv]) === 1
    && s(db, "SELECT notes FROM customers WHERE id = 'cust-2'") === 'außen' && tc.transactionDepth() === 0,
    '§8 innen + außen erfolgreich: beides gespeichert, einmal, Tiefe 0');
  const sum = n(db, "SELECT ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) FROM ledger_entries");
  ok(Math.abs(sum) < 0.001, '§8 Hauptbuch ausgeglichen');
}

console.log(`\np1a-transaction-safety: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

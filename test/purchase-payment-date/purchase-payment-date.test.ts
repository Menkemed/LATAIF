// ════════════════════════════════════════════════════════════════════════════
// v0.8.94 PURCHASE PAYMENT DATE — das Datum einer erfassten Einkaufszahlung berichtigen (Primary == PC2).
// Run: node --experimental-strip-types test/purchase-payment-date/purchase-payment-date.test.ts
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
const { useInvoiceStore, loadInvoicesFor } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const life = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const edit = await import('../../src/core/purchases/purchase-edit-house.ts');
const payables = await import('../../src/core/payables/payables-house.ts');
const { computeSalesMetrics } = await import('../../src/core/reports/sales-metrics.ts');
const { loadSalesData } = await import('../../src/core/reports/sales-metrics-loader.ts');
const { costCorrectionBridge, costCorrectionRows } = await import('../../src/core/purchases/cost-correction-read.ts');
const { purchaseBoundRefusal, soldItemEditNeedsReason } = await import('../../src/core/products/purchase-bound.ts');
const { vatFingerprint } = await import('../../src/core/tax/vat-period-lock.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-24T10:00:00.000Z';
const PDATE = '2026-10-20';   // nach dem Eröffnungsstichtag 15.10.2026
const SDATE = '2026-10-21';
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

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
  usePurchaseStore.getState().loadPurchases();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
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
    VALUES ('cust-1','branch-main','Test','Kunde','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant A',1,?,?)", [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-2','branch-main','Lieferant B',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const CTX = { branchId: 'branch-main', userId: 'user-test', now: NOW };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const code = (m: string): string => m.split('|')[0];

/** Einkauf eines NEUEN Artikels (der Einkauf legt ihn an → D13). Stückpreis brutto. */
function kaufNeu(opts: { price: number; qty?: number; vat?: boolean; date?: string; paid?: number; supplier?: string; sku?: string }): { pid: string; productId: string; lineId: string } {
  const p = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: opts.supplier ?? 'sup-1',
    purchaseDate: opts.date ?? PDATE,
    lines: [{
      newProduct: { categoryId: 'cat-w', brand: 'Rolex', name: 'Submariner', sku: opts.sku ?? `SKU-${Math.random().toString(36).slice(2, 8)}`, taxScheme: 'MARGIN', plannedSalePrice: 900 } as never,
      quantity: opts.qty ?? 1, unitPrice: opts.price,
      taxScheme: opts.vat ? 'VAT_10' as const : 'ZERO' as const, vatRate: opts.vat ? 10 : 0,
    }],
    ...(opts.paid ? { initialPayment: { amount: opts.paid, method: 'cash' as const } } : {}),
  }));
  reload();
  return { pid: p.id, productId: p.lines[0].productId!, lineId: p.lines[0].id };
}
const LINE = (productId: string, qty = 1, price = 700, scheme: 'VAT_10' | 'MARGIN' = 'MARGIN') => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 0, taxScheme: scheme, vatRate: 10,
  vatAmount: scheme === 'VAT_10' ? (price * qty) / 10 : 0, lineTotal: scheme === 'VAT_10' ? price * qty * 1.1 : price * qty,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, date = SDATE): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', lines as never, 'PE', `${date}T12:00:00.000Z`).id);
  reload();
  return id;
}
function voll(db: Db, invId: string): void {
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
}
const rev = (db: Db, pid: string): number => n(db, 'SELECT revision FROM purchases WHERE id = ?', [pid]);
const editIt = (db: Db, req: Record<string, unknown>, ctx = CTX) => {
  const out = imHaus(() => edit.editPurchaseInHouse(req as never, ctx, rev(db, String(req.purchaseId))));
  reload();
  return out;
};

// ── Messgrößen ──
const inventory = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = 'INVENTORY'"));
const lotsValue = (db: Db): number =>
  r3(n(db, "SELECT COALESCE(SUM(qty_remaining * unit_cost), 0) FROM stock_lots WHERE status != 'CANCELLED' AND qty_remaining > 0"));
const balance = (db: Db, account: string, extra = '', p: unknown[] = []): number =>
  r3(n(db, `SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries WHERE account = ? ${extra}`, [account, ...p]));
const apOf = (db: Db, supplierId: string): number => -balance(db, 'ACCOUNTS_PAYABLE', 'AND counterparty_id = ?', [supplierId]);
const invariant = (db: Db, tag: string): void => {
  const a = inventory(db); const b = lotsValue(db);
  ok(eq(a, b), `${tag} Invariante: INVENTORY ${a} == Restwert der Lose ${b}`);
};
const lotOfLine = (db: Db, lineId: string): string => s(db, 'SELECT id FROM stock_lots WHERE purchase_line_id = ?', [lineId]);
const unitCost = (db: Db, lot: string): number => n(db, 'SELECT unit_cost FROM stock_lots WHERE id = ?', [lot]);
const purchaseLive = (db: Db, pid: string, account: string, dir: string): number =>
  r3(n(db, `SELECT COALESCE(SUM(e1.amount), 0) FROM ledger_entries e1 WHERE e1.source_module = 'PURCHASE' AND e1.source_id = ? AND e1.account = ? AND e1.direction = ?
             AND e1.reverses_entry_id IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [pid, account, dir]));

// ══ v0.8.94 — das Datum einer erfassten Einkaufszahlung berichtigen ════════════════════════════
const cmds = await import('../../src/core/bridge/purchase-edit-commands.ts');
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
type Out = { kind: string; code?: string; frozen?: boolean; replayed?: boolean; value?: Record<string, unknown> };

/** Ein Einkauf mit ZWEI Zahlungen: 200 bar am Einkaufstag, 300 Bank am 22.10. (erfasst mit falschem Tag). */
function welt(): { db: Db; pid: string; p1: string; p2: string } {
  const db = freshDb();
  const { pid } = kaufNeu({ price: 1000, paid: 200 });
  imHaus(() => payables.recordPurchasePaymentInHouse(pid, 300, 'bank', CTX, { expectedRevision: rev(db, pid), paidAt: '2026-10-22', reference: 'TT-77' }));
  reload();
  const p1 = s(db, "SELECT id FROM purchase_payments WHERE purchase_id = ? AND method = 'cash'", [pid]);
  const p2 = s(db, "SELECT id FROM purchase_payments WHERE purchase_id = ? AND method = 'bank'", [pid]);
  return { db, pid, p1, p2 };
}
/** Die lebenden (nicht stornierten) Buchungen einer Zahlung: Konto, Richtung, Betrag, Tag. */
const lebend = (db: Db, payId: string): string => S(db.exec(`SELECT e1.account, e1.direction, ROUND(e1.amount, 3), substr(e1.occurred_at, 1, 10)
  FROM ledger_entries e1 WHERE e1.source_module = 'PURCHASE_PAYMENT' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id) ORDER BY e1.account`, [payId])[0]?.values ?? []);
const netto = (db: Db): string => S(db.exec(`SELECT account, COALESCE(counterparty_id, ''), ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3)
  FROM ledger_entries GROUP BY 1, 2 HAVING ABS(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END)) > 0.0005 ORDER BY 1, 2`)[0]?.values ?? []);
const ausgeglichen = (db: Db): boolean => n(db, `SELECT COUNT(*) FROM (SELECT transaction_id, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS d
  FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005)`) === 0;
const zahlung = (db: Db, payId: string): string => S(db.exec('SELECT id, purchase_id, amount, method, paid_at, reference, note, created_at, voided_at FROM purchase_payments WHERE id = ?', [payId])[0]?.values ?? []);
const kopf = (db: Db, pid: string): string => S(db.exec('SELECT total_amount, paid_amount, remaining_amount, status FROM purchases WHERE id = ?', [pid])[0]?.values ?? []);
const alles = (db: Db, pid: string): string => S([kopf(db, pid), S(db.exec('SELECT * FROM purchase_payments ORDER BY id')[0]?.values ?? []),
  n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM purchase_edits'), rev(db, pid)]);

// ── §1 Primary: die zweite Zahlung bekommt ihren richtigen Tag — einzeln, dieselbe Zahlung ──
const bilder: string[] = [];
{
  const { db, pid, p1, p2 } = welt();
  const vorKopf = kopf(db, pid); const vorNetto = netto(db); const vorP1 = zahlung(db, p1) + lebend(db, p1);
  const vorP2 = JSON.parse(zahlung(db, p2))[0];
  ok(lebend(db, p2).includes('2026-10-22'), `SETUP die Bankzahlung steht am 22.10. im Hauptbuch (${lebend(db, p2)})`);
  const r = imHaus(() => edit.correctPurchasePaymentDateInHouse(pid, p2, '2026-10-21', 'Kontoauszug: am 21. überwiesen', CTX, rev(db, pid)));
  reload();
  const nach = JSON.parse(zahlung(db, p2))[0];
  ok(r.oldDate === '2026-10-22' && r.newDate === '2026-10-21' && nach[4] === '2026-10-21'
    && S([nach[0], nach[1], nach[2], nach[3], nach[5], nach[6], nach[7]]) === S([vorP2[0], vorP2[1], vorP2[2], vorP2[3], vorP2[5], vorP2[6], vorP2[7]]),
    `PDATE dieselbe Zahlung (Kennung, Betrag, Weg, Beleg, Erfassung), nur der Tag ist jetzt der 21.10. (${S(nach)})`);
  ok(kopf(db, pid) === vorKopf, `PDATE bezahlt, Rest und Status unverändert (${kopf(db, pid)})`);
  ok(lebend(db, p2) === S([['ACCOUNTS_PAYABLE', 'DEBIT', 300, '2026-10-21'], ['BANK', 'CREDIT', 300, '2026-10-21']]),
    `PDATE Hauptbuch: die lebende Buchung steht am richtigen Tag, gleiche Konten und Beträge (${lebend(db, p2)})`);
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'PURCHASE_PAYMENT' AND source_id = ? AND reverses_entry_id IS NOT NULL AND substr(occurred_at, 1, 10) = ?", [p2, NOW.slice(0, 10)]) === 2,
    'PDATE …die alte ist heute gegengebucht (nachvollziehbar, nichts überschrieben)');
  ok(netto(db) === vorNetto && ausgeglichen(db), 'PDATE Salden je Konto und Lieferant unverändert, Hauptbuch ausgeglichen');
  ok(zahlung(db, p1) + lebend(db, p1) === vorP1, 'PDATE die andere Zahlung bleibt unberührt');
  ok(n(db, "SELECT COUNT(*) FROM purchase_edits WHERE purchase_id = ? AND kinds = 'PAYMENT_DATE' AND reason = 'Kontoauszug: am 21. überwiesen'", [pid]) === 1
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND field_name = 'paid_at' AND changed_by = 'user-test'", [p2]) === 1,
    'PDATE protokolliert: Verlauf des Einkaufs (mit Grund) und Audit (alt → neu, Benutzer, Zeit)');
  // Die erste Zahlung einzeln berichtigen.
  imHaus(() => edit.correctPurchasePaymentDateInHouse(pid, p1, '2026-10-21', 'bar erst am Folgetag', CTX, rev(db, pid)));
  reload();
  ok(JSON.parse(zahlung(db, p1))[0][4] === '2026-10-21' && lebend(db, p1).includes('2026-10-21') && JSON.parse(zahlung(db, p2))[0][4] === '2026-10-21'
    && kopf(db, pid) === vorKopf && netto(db) === vorNetto && ausgeglichen(db),
    'PDATE jede Teilzahlung einzeln: auch die erste, die zweite bleibt, Salden unverändert');
  invariant(db, 'PDATE');
  bilder.push(S([zahlung(db, p2).replace(p2, 'X').replace(pid, 'P'), lebend(db, p2), kopf(db, pid)]));
}

// ── §2 Die Neins — und jedes Nein ändert nichts ──
{
  const { db, pid, p1, p2 } = welt();
  const fall = (payId: string, tag: string, grund = 'x', revision: number | undefined = rev(db, pid), ctx = CTX): string => {
    const vor = alles(db, pid);
    const m = meldung(() => imHaus(() => edit.correctPurchasePaymentDateInHouse(pid, payId, tag, grund, ctx, revision)));
    reload();
    return alles(db, pid) === vor ? code(m) : `VERÄNDERT:${code(m)}`;
  };
  ok(fall(p2, '2026-10-21', '  ') === 'PURCHASE_EDIT_REASON_REQUIRED', 'NEIN ohne Grund');
  ok(fall(p2, '2026-10-22') === 'PAYMENT_DATE_UNCHANGED', 'NEIN derselbe Tag');
  ok(fall(p2, '2026-10-28') === 'PAYMENT_DATE_INVALID', 'NEIN Tag in der Zukunft');
  ok(fall(p2, '22.10.2026') === 'PAYMENT_DATE_INVALID', 'NEIN kein Kalendertag');
  ok(fall(p2, '2026-10-19') === 'PAYMENT_DATE_BEFORE_PURCHASE', 'NEIN vor dem Einkaufsdatum');
  ok(fall(p2, '2026-10-21', 'x', rev(db, pid) - 1) === 'RECORD_CHANGED', 'NEIN alte Fassung (konkurrierende Änderung)');
  // VAT-Sperre: das laufende Quartal ist VAT-bezahlt → die heutige Gegenbuchung läge darin.
  db.run("INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, created_at) VALUES ('tp-q4','branch-main',2026,4,1,'bank',?,?)", [NOW, NOW]);
  const vat = fall(p2, '2026-10-21');
  db.run("DELETE FROM tax_payments WHERE id = 'tp-q4'");
  ok(vat === 'VAT_PERIOD_FILED', `NEIN Quartal VAT-bezahlt: nicht umdatiert (${vat})`);
  // Storniert, Guthaben-Einlösung, stornierter Einkauf.
  imHaus(() => edit.voidPurchasePaymentInHouse(pid, p1, 'falsch', CTX, rev(db, pid)));
  reload();
  ok(fall(p1, '2026-10-21') === 'PAYMENT_ALREADY_VOIDED', 'NEIN stornierte Zahlung');
  db.run(`INSERT INTO supplier_credits (id, branch_id, supplier_id, amount, used_amount, status, created_at) VALUES ('sc1','branch-main','sup-1',100,0,'OPEN',?)`, [NOW]);
  imHaus(() => payables.applyCreditToPurchaseInHouse(pid, 100, CTX, rev(db, pid)));
  reload();
  const credPay = s(db, "SELECT id FROM purchase_payments WHERE purchase_id = ? AND method = 'credit'", [pid]);
  ok(fall(credPay, '2026-10-21') === 'PAYMENT_DATE_CREDIT', 'NEIN Guthaben-Einlösung trägt ihren Einlösetag');
  // Vor dem Eröffnungsstichtag (15.10.).
  const alt = kaufNeu({ price: 400, paid: 100, date: '2026-10-10' });
  const altPay = s(db, 'SELECT id FROM purchase_payments WHERE purchase_id = ?', [alt.pid]);
  const vorAlt = alles(db, alt.pid);
  const mAlt = meldung(() => imHaus(() => edit.correctPurchasePaymentDateInHouse(alt.pid, altPay, '2026-10-16', 'x', CTX, rev(db, alt.pid))));
  reload();
  ok(code(mAlt) === 'PURCHASE_EDIT_BEFORE_CUTOVER' && alles(db, alt.pid) === vorAlt, `NEIN Zahlung vor dem Eröffnungsstichtag (${code(mAlt)})`);
  ok(ausgeglichen(db), 'NEIN Hauptbuch ausgeglichen');
}

// ── §3 PC2: derselbe Befehl — gleiche Wirkung, Wiederholung ohne zweite Wirkung, Rumpfregeln ──
{
  const { db, pid, p2 } = welt();
  const body = { purchaseId: pid, paymentId: p2, expectedRevision: rev(db, pid), paidDate: '2026-10-21', reason: 'Kontoauszug: am 21. überwiesen' };
  const o = await cmds.runPurchasePaymentDate(deps(db), identity('801', 'purchases.correct_payment_date'), body) as Out;
  setTestDatabase(db as never); reload();
  ok(o.kind === 'ok' && o.value?.newDate === '2026-10-21', `PC2 angenommen (${o.kind}:${o.code ?? ''})`);
  bilder.push(S([zahlung(db, p2).replace(p2, 'X').replace(pid, 'P'), lebend(db, p2), kopf(db, pid)]));
  ok(bilder[0] === bilder[1], `PC2 PARITY Primary == PC2 (Zahlung, Hauptbuch, Kopf)${bilder[0] !== bilder[1] ? ` ${bilder[0]} / ${bilder[1]}` : ''}`);
  const vor = alles(db, pid);
  const w = await cmds.runPurchasePaymentDate(deps(db), identity('801', 'purchases.correct_payment_date'), body) as Out;
  setTestDatabase(db as never); reload();
  ok(w.kind === 'ok' && w.replayed === true && alles(db, pid) === vor, 'PC2 verlorene Antwort: dieselbe Antwort, keine zweite Wirkung');
  const alt = await cmds.runPurchasePaymentDate(deps(db), identity('802', 'purchases.correct_payment_date'), { ...body, paidDate: '2026-10-20', expectedRevision: rev(db, pid) - 1 }) as Out;
  setTestDatabase(db as never); reload();
  ok(alt.kind === 'rejected' && alt.code === 'RECORD_CHANGED' && alt.frozen === true && alles(db, pid) === vor, `PC2 alte Fassung: endgültiges Nein, nichts geändert (${alt.code})`);
  let form = '';
  try { cmds.parsePurchasePaymentDate({ ...body, paidDate: '21.10.2026' }); } catch (e) { form = String((e as { code?: unknown }).code); }
  let fremd = '';
  try { cmds.parsePurchasePaymentDate({ ...body, amount: 1 }); } catch (e) { fremd = (e as Error).message; }
  ok(form === 'PAYMENT_DATE_INVALID' && fremd !== '', `PC2 Rumpf: nur JJJJ-MM-TT, kein Betrag/Weg im Auftrag (${form} / ${fremd.slice(0, 60)})`);
}

// ── §4 Verdrahtung ──
{
  const perms = await import('../../src/core/bridge/command-permissions.ts');
  const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
  const detail = src('src/pages/purchases/PurchaseDetail.tsx');
  const house = src('src/core/purchases/purchase-house.ts');
  ok(ALLOWED_MUTATIONS.includes('purchases.correct_payment_date') && cmds.PURCHASE_EDIT_OPS.includes('purchases.correct_payment_date' as never)
    && /'purchases\.correct_payment_date': owner\(/.test(src('src/core/bridge/command-permissions.ts')) && !!perms,
    'WIRE Befehl freigegeben, nur Owner');
  ok(/data-purchase-payment-date=\{p\.id\}/.test(detail) && /p\.method !== 'credit'/.test(detail)
    && /savePurchasePaymentDate\(viaWrites\(w, PURCHASE_EDIT_OP\.CORRECT_PAYMENT_DATE\), purchase, datePay\.id, newPayDate, dateReason\)/.test(detail)
    && /local: \(\) => correctPurchasePaymentDateOnPrimary\(/.test(house) && /remote: \(\) => purchasePaymentDateBody\(/.test(house),
    'WIRE Einkaufsseite: „Edit date" je echter Zahlung; am Primary die Hausfolge, an PC2 derselbe Befehl');
}

console.log(`\n${fails.length ? 'FAIL' : 'PASS'} — purchase payment date: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// INVOICE-EDIT S5 — vollständige Korrektur eines falsch gewählten Rechnungskunden.
// Eine Rechnung lag monatelang beim falschen Kunden (Ali) — mit alten Zahlungen, einem
// Überzahlungsguthaben, einer bar erstatteten und einer als Guthaben erstatteten Retoure. Ali hat
// außerdem eine eigene Rechnung mit eigenem Guthaben. Korrigiert wird auf Nora.
// Run: node --experimental-strip-types test/invoice-edit/full-correction.test.ts
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
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
// Der echte invoice.paid-Handler (registriert sich beim Laden des Moduls).
await import('../../src/core/automation/automation-handlers.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useProductionStore } = await import('../../src/stores/productionStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const cancelReturnHouse = await import('../../src/core/returns/return-cancel-house.ts');
const { cancelInvoiceInHouse } = await import('../../src/core/invoices/invoice-cancel-house.ts');
const { convertTransferInHouse, undoTransferConversionInHouse } = await import('../../src/core/agents/transfer-house.ts');
const { createProductionInHouse } = await import('../../src/core/production/production-house.ts');
const { STOCK_UNAVAILABLE_MESSAGE } = await import('../../src/core/lots/lot-availability.ts');
const { classifyLegacyInvoiceLines, LEGACY_STOCK_LINES_MESSAGE } = await import('../../src/core/lots/stock-contract.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-21T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const info = db.exec(`PRAGMA table_info(${table})`)[0];
  const cols = info.values.map((v) => ({
    name: String(v[1]), type: String(v[2] ?? ''), notnull: Number(v[3]) === 1, dflt: v[4], pk: Number(v[5]) > 0,
  }));
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
  useSupplierStore.getState().loadSuppliers();
  useInvoiceStore.getState().loadInvoices();
  useSalesReturnStore.getState().loadReturns();
  useCreditNoteStore.getState().loadCreditNotes();
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
}

/** Artikel: `lotQty` = Einkaufslos mit dieser Menge; null = ohne Los, Menge `manualQty`. */
function product(db: Db, id: string, lotQty: number | null, manualQty = 0, extra: { status?: string; source?: string } = {}): void {
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?,'branch-main','cat-w','Rolex',?,?,?,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
  [id, 'M ' + id, 'SKU-' + id, lotQty ?? manualQty, extra.status ?? 'in_stock', extra.source ?? 'OWN', NOW, NOW]);
  if (lotQty !== null) {
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,'branch-main',?,100,?,?,'ACTIVE',?,?)`, ['lot-' + id, id, lotQty, lotQty, NOW, NOW]);
  }
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
  for (const [id, first] of [['cust-1', 'Ali'], ['cust-2', 'Nora']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, first, NOW, NOW]);
  }
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','Lieferant',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });
const OWNER_ACTOR = { userId: 'user-test', role: 'ADMIN' };

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
async function imHausAsync<T>(fn: () => Promise<T>): Promise<T> {
  posting.beginLedgerTransaction();
  try { const out = await fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
function meldung(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? '') + '|' + (e as Error).message; }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINE = (productId: string, qty = 1, price = 1000) => ({
  productId, quantity: qty, unitPrice: price, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10,
  vatAmount: (price * qty) / 10, lineTotal: price * qty * 1.1,
});
function rechnung(lines: Array<ReturnType<typeof LINE>>, customerId = 'cust-1'): string {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, lines as never, 'SLI').id);
  reload();
  return id;
}
function voll(invId: string): string {
  const db = current();
  const offen = n(db, 'SELECT gross_amount - paid_amount FROM invoices WHERE id = ?', [invId]);
  const pay = imHaus(() => useInvoiceStore.getState().recordPayment(invId, offen, 'cash'));
  reload();
  return pay;
}
const { runInvoiceUpdate } = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const { runCounterpartyAudit } = await import('../../src/core/ledger/counterpartyAudit.ts');
const {
  CUSTOMER_CHANGE_NEEDS_CONFIRMATION, CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE, CUSTOMER_CHANGE_VAT_FILED,
} = await import('../../src/core/invoices/customer-change.ts');
const { EDIT_KEPT_LINE_LOT_SHORT } = await import('../../src/core/invoices/edit-lines.ts');

let DB: Db | null = null;
const current = (): Db => DB as Db;
const neu = (): Db => { DB = freshDb(); return DB; };
void OWNER_ACTOR; void imHausAsync; void tick; void useConsignmentStore; void useProductionStore; void useAgentStore;
void cancelReturnHouse; void cancelInvoiceInHouse; void convertTransferInHouse; void undoTransferConversionInHouse;
void createProductionInHouse; void STOCK_UNAVAILABLE_MESSAGE; void classifyLegacyInvoiceLines; void LEGACY_STOCK_LINES_MESSAGE;
void eventBus; void useCreditNoteStore; void voll; void insert; void rechnung; void current;

// ── Messgrößen ─────────────────────────────────────────────────────────────────────────────
const saldo = (db: Db, acc: string, cust: string, bis?: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries
    WHERE account = ? AND counterparty_id = ?${bis ? ' AND occurred_at <= ?' : ''}`, bis ? [acc, cust, bis] : [acc, cust]);
const konto = (db: Db, acc: string, bis?: string): number => n(db,
  `SELECT COALESCE(ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3), 0) FROM ledger_entries
    WHERE account = ?${bis ? ' AND occurred_at <= ?' : ''}`, bis ? [acc, bis] : [acc]);
const ausgeglichen = (db: Db): boolean => Math.abs(n(db,
  "SELECT COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0) FROM ledger_entries")) < 0.005;
function kundenkontenOk(db: Db): string {
  const run = (sql: string, p: unknown[] = []) => {
    const r = db.exec(sql, p)[0];
    return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
  };
  const a = runCounterpartyAudit(run as never, 'branch-main');
  const bad = [...a.arByCustomer.rows, ...a.customerCreditByCustomer.rows].filter((r) => r.status !== 'ok');
  return bad.map((r) => `${r.account}:${r.id} ${r.diffFils}`).join(', ') + (a.issues.length ? ` issues:${a.issues.map((i) => `${i.kind}:${i.detail}`).join('/')}` : '');
}
/** Konten (außer den kundenbezogenen), die ab `t0` netto nicht 0 sind — bei einer reinen Korrektur: keine. */
const korrektur = (db: Db, t0: string): string => all(db,
  `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS v FROM ledger_entries
    WHERE occurred_at >= ? AND account NOT IN ('ACCOUNTS_RECEIVABLE', 'CUSTOMER_CREDIT') GROUP BY account HAVING ABS(v) > 0.0005`, [t0]).replace(/^\[\]$/, '');
/** Alle Belege der Rechnung ohne ihren Kunden — müssen gleich bleiben. */
const belege = (db: Db, inv: string): string => S({
  inv: all(db, 'SELECT invoice_number, ROUND(gross_amount, 3), paid_amount, status, issued_at, number_finalized_at FROM invoices WHERE id = ?', [inv]),
  lines: all(db, 'SELECT id, product_id, quantity, unit_price, lot_id, stock_taken FROM invoice_lines WHERE invoice_id = ? ORDER BY id', [inv]),
  pay: all(db, 'SELECT id, amount, method, reference, received_at, notes, created_at FROM payments WHERE invoice_id = ? ORDER BY id', [inv]),
  cn: all(db, 'SELECT id, credit_note_number, total_amount, vat_amount, cash_refund_amount, receivable_cancel_amount, refund_method, issued_at, status FROM credit_notes WHERE invoice_id = ? ORDER BY id', [inv]),
  ret: all(db, 'SELECT id, return_number, status, total_amount, refund_amount, refund_paid_amount, refund_method FROM sales_returns WHERE invoice_id = ? ORDER BY id', [inv]),
  srl: all(db, 'SELECT id, invoice_line_id, quantity FROM sales_return_lines ORDER BY id'),
  apps: all(db, 'SELECT id, payment_id, credit_id, amount FROM credit_applications ORDER BY id'),
  lots: all(db, 'SELECT id, qty_remaining FROM stock_lots ORDER BY id'),
});
function zustand(db: Db): string {
  return S({ all: all(db, 'SELECT id, customer_id FROM invoices ORDER BY id'), cc: all(db, 'SELECT * FROM customer_credits ORDER BY id'),
    cn: all(db, 'SELECT id, customer_id FROM credit_notes ORDER BY id'), ret: all(db, 'SELECT id, customer_id FROM sales_returns ORDER BY id'),
    le: n(db, 'SELECT COUNT(*) FROM ledger_entries'), ed: n(db, 'SELECT COUNT(*) FROM invoice_edits'), pay: all(db, 'SELECT * FROM payments ORDER BY id') });
}
const HIST = '2026-06-15T10:00:00.000Z';
const STICHTAG = '2026-08-31T23:59:59.999Z';

function zahle(inv: string, betrag: number, art: string): string {
  const id = imHaus(() => useInvoiceStore.getState().recordPayment(inv, betrag, art, 'Zahlung'));
  reload();
  return id;
}
function retoure(inv: string, z: string, methode: 'cash' | 'credit'): string {
  const rid = imHaus(() => {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    const id = rs.createReturn({
      invoiceId: inv, refundMethod: methode, productDisposition: 'IN_STOCK', reason: 'Retoure',
      lines: [{ invoiceLineId: z, productId: 'pA', quantity: 1, unitPrice: 1100, vatAmount: 100 }],
    } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(id);
    return id;
  });
  reload();
  return rid;
}

/**
 * Die Welt: Rechnung R (3 Stück à 1000 netto = 3300 brutto) für Ali statt Nora, März.
 * Zahlungen 2000 bar + 1500 Bank (200 Überzahlung → Guthaben), Retoure 1 bar erstattet,
 * Retoure 1 als Guthaben. Alis eigene Rechnung E (1 Stück, 1100) mit 1200 bezahlt → eigenes Guthaben 100.
 * Alles bis Juni datiert (Monate alt).
 */
function welt(): { db: Db; inv: string; z: string; eigen: string; rCash: string; rCredit: string } {
  const db = neu();
  product(db, 'pA', 3);
  product(db, 'pB', 1);
  reload();
  const inv = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1',
    [{ ...LINE('pA', 3, 1000), lotId: 'lot-pA' }] as never, 'R', '2026-03-10').id);
  const eigen = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1',
    [{ ...LINE('pB', 1, 1000), lotId: 'lot-pB' }] as never, 'E', '2026-03-12').id);
  reload();
  const z = s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [inv]);
  zahle(inv, 2000, 'cash');
  zahle(inv, 1500, 'bank_transfer');
  zahle(eigen, 1200, 'cash');
  const rCash = retoure(inv, z, 'cash');
  const rCredit = retoure(inv, z, 'credit');
  // Alles Bisherige liegt Monate zurück.
  for (const [t, c] of [['ledger_entries', 'occurred_at'], ['payments', 'received_at'], ['credit_notes', 'issued_at'], ['sales_returns', 'return_date']]) {
    db.run(`UPDATE ${t} SET ${c} = ? WHERE ${c} >= '2026-09-01'`, [HIST]);
  }
  reload();
  return { db, inv, z, eigen, rCash, rCredit };
}
function korrigiere(inv: string, z: string, opts: { confirm?: boolean; qty?: number } = {}): string {
  const m = meldung(() => imHaus(() => useInvoiceStore.getState().editInvoice(inv, {
    lines: [{ lineId: z, ...LINE('pA', opts.qty ?? 3, 1000), lotId: 'lot-pA' }] as never,
    customerId: 'cust-2', reason: 'Falscher Kunde seit März', ...(opts.confirm ? { confirmCustomerChange: true } : {}),
  } as never)));
  reload();
  return m;
}

// ══ SETUP ══
const W = welt();
{
  const { db, inv } = W;
  const cc = all(db, 'SELECT source_type, customer_id, amount, used_amount FROM customer_credits ORDER BY source_type, amount');
  ok(s(db, 'SELECT status FROM invoices WHERE id = ?', [inv]) !== '' && n(db, 'SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ?', [inv]) === 2
    && n(db, "SELECT COUNT(*) FROM customer_credits WHERE customer_id = 'cust-1'") === 3 && kundenkontenOk(db) === '' && ausgeglichen(db),
    `SETUP R bei Ali: 2 Zahlungen, 2 Gutschriften, 3 Guthaben bei Ali (${cc}) ${kundenkontenOk(db)}`);
}

// 1) Ohne Bestätigung nichts.
{
  const { db, inv, z } = W;
  const vor = zustand(db);
  const m = korrigiere(inv, z);
  ok(m.startsWith(CUSTOMER_CHANGE_NEEDS_CONFIRMATION + '|') && zustand(db) === vor,
    `1 ohne Bestätigung: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 60)})`);
}

// 2) Die Korrektur.
{
  const { db, inv, z, eigen } = W;
  const vorBelege = belege(db, inv);
  const ali0 = { ar: saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-1'), cc: saldo(db, 'CUSTOMER_CREDIT', 'cust-1') };
  const hist = { aliAr: saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-1', STICHTAG), aliCc: saldo(db, 'CUSTOMER_CREDIT', 'cust-1', STICHTAG),
    kasse: konto(db, 'CASH', STICHTAG), bank: konto(db, 'BANK', STICHTAG), vat: konto(db, 'VAT_OUTPUT', STICHTAG), umsatz: konto(db, 'REVENUE', STICHTAG) };
  const eigenVor = S({ inv: all(db, 'SELECT customer_id, paid_amount, status FROM invoices WHERE id = ?', [eigen]),
    cc: all(db, "SELECT id, customer_id, amount, used_amount FROM customer_credits WHERE source_id IN (SELECT id FROM payments WHERE invoice_id = ?)", [eigen]) });
  const t0 = new Date().toISOString();
  const m = korrigiere(inv, z, { confirm: true });
  ok(m === '' && s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]) === 'cust-2',
    `2 bestätigt: Rechnung bei Nora (${m})`);
  ok(belege(db, inv) === vorBelege,
    '2 …Nummer, Zeilen, Bestand, Zahlungen (Referenzen, Daten), Gutschriften, Retouren, Erstattungen, Guthaben-Links unverändert');
  ok(n(db, "SELECT COUNT(*) FROM credit_notes WHERE invoice_id = ? AND customer_id = 'cust-2'", [inv]) === 2
    && n(db, "SELECT COUNT(*) FROM sales_returns WHERE invoice_id = ? AND customer_id = 'cust-2'", [inv]) === 2,
    '2 …beide Gutschriften und Retouren lauten auf Nora');
  const noraCc = all(db, "SELECT source_type, amount, used_amount FROM customer_credits WHERE customer_id = 'cust-2' ORDER BY source_type");
  const aliCc = all(db, "SELECT source_type, amount FROM customer_credits WHERE customer_id = 'cust-1'");
  ok(noraCc === '[["overpayment",200,0],["sales_return",1100,0]]' && aliCc === '[["overpayment",100]]',
    `2 …Guthaben aus R (Überzahlung 200, Retoure 1100) bei Nora; Alis eigenes (100 aus E) bleibt bei Ali (${noraCc} / ${aliCc})`);
  ok(S({ inv: all(db, 'SELECT customer_id, paid_amount, status FROM invoices WHERE id = ?', [eigen]),
    cc: all(db, "SELECT id, customer_id, amount, used_amount FROM customer_credits WHERE source_id IN (SELECT id FROM payments WHERE invoice_id = ?)", [eigen]) }) === eigenVor,
    '2 …Alis andere Rechnung und ihr Guthaben unberührt');
  ok(saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-1') === 0 && saldo(db, 'CUSTOMER_CREDIT', 'cust-1') === -100
    && saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-2') === 0 && saldo(db, 'CUSTOMER_CREDIT', 'cust-2') === -1300,
    `2 …Salden: Ali Forderung 0 / Guthaben 100 (vorher ${ali0.ar}/${-ali0.cc}), Nora Forderung 0 / Guthaben 1300 `
    + `(${saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-2')}/${-saldo(db, 'CUSTOMER_CREDIT', 'cust-2')})`);
  ok(kundenkontenOk(db) === '' && ausgeglichen(db), `2 …Hauptbuch je Kunde abgestimmt (Forderung, Guthaben), ausgeglichen ${kundenkontenOk(db)}`);
  ok(saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-1', STICHTAG) === hist.aliAr && saldo(db, 'CUSTOMER_CREDIT', 'cust-1', STICHTAG) === hist.aliCc
    && saldo(db, 'ACCOUNTS_RECEIVABLE', 'cust-2', STICHTAG) === 0 && saldo(db, 'CUSTOMER_CREDIT', 'cust-2', STICHTAG) === 0
    && konto(db, 'CASH', STICHTAG) === hist.kasse && konto(db, 'BANK', STICHTAG) === hist.bank
    && konto(db, 'VAT_OUTPUT', STICHTAG) === hist.vat && konto(db, 'REVENUE', STICHTAG) === hist.umsatz,
    `2 …Stichtag 31.08. unverändert: Ali wie vorher (Guthaben ${-hist.aliCc}), Nora nichts; Kasse, Bank, VAT, Umsatz gleich`);
  ok(korrektur(db, t0) === '' && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE occurred_at > ? AND occurred_at < ?", [HIST, t0]) === 0,
    `2 …am Korrekturtag: Kasse/Bank/Umsatz/VAT/Erstattungen netto 0, nichts zurückdatiert (${korrektur(db, t0) || 'ok'})`);
  const snap = s(db, 'SELECT new_snapshot FROM invoice_edits WHERE invoice_id = ? ORDER BY revision DESC LIMIT 1', [inv]);
  const cc = JSON.parse(snap).customerChange;
  ok(cc && cc.from === 'cust-1' && cc.to === 'cust-2' && cc.paymentsMoved.length === 2 && cc.creditNotesMoved.length === 2
    && cc.returns.length === 2 && cc.credits.length === 2
    && /2 payment\(s\), 2 credit note\(s\), 2 return\(s\), 2 credit\(s\) moved/.test(s(db, "SELECT new_value FROM audit_log WHERE entity_id = ? AND field_name LIKE 'customer (rev %'", [inv])),
    '2 …Spur: Revision und Verlauf nennen alten/neuen Kunden und jeden umgebuchten Beleg');
  ok(n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module IN ('PAYMENT','CREDIT_NOTE') AND counterparty_id = 'cust-1' AND occurred_at = ? AND reverses_entry_id IS NULL", [HIST]) > 0,
    '2 …die ursprünglichen Buchungen beim alten Kunden stehen weiter (mit Storno am Korrekturtag)');
  // Danach wirkt alles bei Nora: ihr Guthaben ist einlösbar.
  const neuR = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-2', [{ ...LINE('pA', 1, 1000), lotId: 'lot-pA' }] as never, 'Nora').id);
  reload();
  const eingeloest = imHaus(() => useInvoiceStore.getState().applyCreditToInvoice(neuR, 1100));
  reload();
  ok(Math.abs(eingeloest - 1100) < 0.005 && kundenkontenOk(db) === '' && ausgeglichen(db),
    `2 …Nora löst das umgebuchte Guthaben auf einer eigenen Rechnung ein (${eingeloest}) ${kundenkontenOk(db)}`);
}

// 3) Guthaben aus R wurde von Ali schon ANDERSWO verwendet → gesondert (nichts geändert).
{
  const { db, inv, z } = welt();
  const offen = imHaus(() => useInvoiceStore.getState().createDirectInvoice('cust-1', [{ ...LINE('pA', 1, 500), lotId: 'lot-pA' }] as never, 'X').id);
  reload();
  imHaus(() => useInvoiceStore.getState().applyCreditToInvoice(offen, 550));
  reload();
  const vor = zustand(db);
  const m = korrigiere(inv, z, { confirm: true });
  ok(m.startsWith(CUSTOMER_CHANGE_CREDIT_USED_ELSEWHERE + '|') && zustand(db) === vor,
    `3 Guthaben aus R von Ali anderswo eingelöst: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 70)})`);
}

// 4) Rollback — scheitert der Edit NACH allen Umbuchungen, bleibt alles, wie es war.
{
  const { db, inv, z } = welt();
  const vor = zustand(db); const vorBelege = belege(db, inv);
  const m = korrigiere(inv, z, { confirm: true, qty: 9 });
  ok(m.startsWith(EDIT_KEPT_LINE_LOT_SHORT + '|') && zustand(db) === vor && belege(db, inv) === vorBelege && kundenkontenOk(db) === '',
    `4 Fehler nach dem Umbuchen: voller Rollback (Kunde, Zahlungen, Gutschriften, Guthaben, Buchungen) (${m.slice(0, 40)})`);
}

// 5) Gemeldete VAT: das Quartal der Rechnung ist bezahlt → Korrekturbeleg nötig, nichts geändert.
{
  const { db, inv, z } = welt();
  db.run("INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, created_at) VALUES ('tp-2','branch-main',2026,2,50,'VAT',?,?)", [NOW, NOW]);
  const vor = zustand(db);
  const m = korrigiere(inv, z, { confirm: true });
  ok(m.startsWith(CUSTOMER_CHANGE_VAT_FILED + '|') && /2026-Q2/.test(m) && zustand(db) === vor,
    `5 VAT für Q2/2026 schon bezahlt: abgewiesen, nichts geändert (${m.split('|')[1]?.slice(0, 70)})`);
}

// 6) PC2 — derselbe Vertrag, dasselbe Ergebnis.
{
  const { db, inv, z } = welt();
  const vorBelege = belege(db, inv);
  const d = {
    db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction, durableSave: async () => { /* test */ }, now: () => NOW,
  };
  const ident = { commandId: '00000091-0000-4000-8000-000000000000', tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op: 'invoices.update', payloadKind: 'x', payloadHash: 'h91' };
  const r = await runInvoiceUpdate(d as never, ident as never, {
    id: inv, expectedRevision: n(db, 'SELECT revision FROM invoices WHERE id = ?', [inv]), reason: 'PC2 Korrektur', customerId: 'cust-2',
    confirmCustomerChange: true, lines: [{ lineId: z, productId: 'pA', lotId: 'lot-pA', quantity: 3, unitPrice: 1000 }],
  });
  reload();
  ok(r.kind === 'ok' && s(db, 'SELECT customer_id FROM invoices WHERE id = ?', [inv]) === 'cust-2' && belege(db, inv) === vorBelege
    && saldo(db, 'CUSTOMER_CREDIT', 'cust-2') === -1300 && saldo(db, 'CUSTOMER_CREDIT', 'cust-1') === -100
    && kundenkontenOk(db) === '' && ausgeglichen(db),
    `6 PC2: dieselbe vollständige Korrektur, Belege unverändert (${r.kind}) ${kundenkontenOk(db)}`);
}

console.log(`\ninvoice-edit-full-correction: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

// ════════════════════════════════════════════════════════════════════════════
// B1-Nachgang (Owner 09.11.2026):
//   1. Letzte Zahlung einer ausgestellten Rechnung entfernt → bleibt ausgestellt und ganz offen (PARTIAL, bezahlt 0,
//      „Unpaid"), Endnummer bleibt, keine zweite Endnummer, PDF kein Proforma, Receivables/Kundenkonto zählen sie weiter;
//      echte Entwürfe, Stornos und VAT-Sperren unverändert.
//   2. Forderungsabstimmung (Gesamt + je Kunde): Storno ÜBER EINE RÜCKGABE zählt wie die Buchung (keine Gegenbuchung der
//      Rechnung) — Kontrollfälle mit und ohne B1-Verrechnung; Hauptbuch je Vorgang ausgeglichen.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/b1-offset.test.ts.
// Run: node test/customer-account/b1-followup.test.ts
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
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useDebtStore, loadDebtPaymentsFor } = await import('../../src/stores/debtStore.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const recv = await import('../../src/core/finance/receivables.ts');
const payS = await import('../../src/stores/payablesStore.ts');
const banking = await import('../../src/stores/bankingStore.ts');
const analytics = await import('../../src/core/reports/analytics-snapshot.ts');
const recon = await import('../../src/core/reports/reconciliation-snapshot.ts');
const backfill = await import('../../src/core/ledger/backfill.ts');
await import('../../src/core/bridge/party-commands.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const { executeCommand } = await import('../../src/core/bridge/command-registry.ts');
const ca = await import('../../src/core/parties/customer-account.ts');
const money = await import('../../src/core/finance/money-house.ts');
const po = await import('../../src/core/offsets/party-offsets.ts');
const lc = await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
const fc = await import('../../src/core/bridge/financial-commands.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const S = (v: unknown): string => JSON.stringify(v);
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-10-20T10:00:00.000Z';
const F = (x: number): number => Math.round(x * 1000);
const eq = (a: number, b: number): boolean => F(a) === F(b);

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

function reload(): void {
  useProductStore.getState().loadProducts();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useDebtStore.getState().loadDebts();
}

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of realMigrations()) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-2','tenant-1','Zwei',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  const kunde = (id: string, fn: string, ln: string): void => {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,'branch-main',?,?,'BH','en',0,'[]','collector','active',?,?)`, [id, fn, ln, NOW, NOW]);
  };
  kunde('cust-1', 'Ahmed', 'Karimi');
  kunde('cust-2', 'Other', 'Client');
  for (let i = 1; i <= 8; i++) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex',?,?,1,'Pre-Owned','[]',0,'BHD',1300,'in_stock','ZERO',0,'[]','{}','OWN',?,?)`,
    ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, NOW, NOW]);
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  reload();
  tauriState.reset();
  return db;
}
useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
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

const DB = freshDb();
const CTX = { branchId: 'branch-main' };
const HCTX = { branchId: 'branch-main', userId: 'user-test' };
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
const zeilen = (sql: string, p: unknown[] = []): string => S(DB.exec(sql, p)[0]?.values ?? []);
const bal = (account: string): number => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries WHERE account = ?`, [account]);
/** Kasse, Bank, Benefit, Karte — was eine Verrechnung NIE bewegen darf. */
const geld = (): string => S(['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING'].map((a) => F(bal(a))));
const ledgerBalanced = (): boolean => n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries`) === 0
  || Math.abs(n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries`)) < 0.0005;
/** Alles, was eine abgelehnte Verrechnung NICHT ändern darf. */
const stand = (): string => S([
  zeilen('SELECT id, status, paid_amount, invoice_number, revision FROM invoices ORDER BY id'),
  zeilen('SELECT id, amount, method FROM payments ORDER BY id'),
  zeilen('SELECT id, status, revision FROM debts ORDER BY id'),
  zeilen('SELECT id, amount, source FROM debt_payments ORDER BY id'),
  zeilen('SELECT id, status FROM party_offsets ORDER BY id'),
  n(DB, 'SELECT COUNT(*) FROM ledger_entries'),
]);
const sale = (pid: string, price: number, date: string, customerId = 'cust-1'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(customerId, [{ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price }] as never, 'B1-TEST', date).id);
  reload();
  return id;
};
const loan = (dir: 'we_borrow' | 'we_lend', amount: number, customerId: string, createdAt: string): string => {
  const r = imHaus(() => money.createDebtInHouse({ direction: dir, customerId, amount, source: 'cash' } as never, HCTX));
  DB.run('UPDATE debts SET created_at = ? WHERE id = ?', [createdAt, r.debt.id]);
  reload();
  return r.debt.id;
};
const inv = (id: string) => DB.exec('SELECT status, paid_amount, invoice_number, special_mark, revision FROM invoices WHERE id = ?', [id])[0].values[0];
const debtState = (id: string): { status: string; open: number; revision: number } => {
  const r = DB.exec('SELECT status, amount, revision FROM debts WHERE id = ?', [id])[0].values[0];
  const paid = n(DB, 'SELECT COALESCE(SUM(amount),0) FROM debt_payments WHERE debt_id = ?', [id]);
  return { status: String(r[0]), open: (F(Number(r[1])) - F(paid)) / 1000, revision: Number(r[2]) };
};
const invRev = (id: string): number => n(DB, 'SELECT revision FROM invoices WHERE id = ?', [id]);
/** Abstand Hauptbuch − Bestand je Konto (Testdaten ohne Buchung erzeugen einen festen Abstand; er darf sich nie ändern). */
const gap = (account: string): number => {
  const row = recon.reconciliationSnapshotFor(CTX as never).rows.find((x) => x.account === account);
  return row ? (F(Number(row.ledger)) - F(Number(row.domain))) / 1000 : NaN;
};
const create = (input: Record<string, unknown>) => imHaus(() => po.createDebtOffsetInHouse(input as never, HCTX));

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-0000000000b1`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = () => ({
  db: DB as never,
  begin: () => { setTestDatabase(DB as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction, rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {}, now: () => NOW,
});
type Outcome = { kind: string; code?: string; replayed?: boolean; value?: Record<string, unknown> };
async function fern(p: () => Promise<unknown>): Promise<Outcome & { thrown?: string }> {
  try { return await p() as Outcome; } catch (e) { return { kind: 'thrown', thrown: String((e as { code?: string }).code ?? (e as Error).message), code: String((e as { code?: string }).code ?? '') }; }
}
const TODAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();


// Aus dem gemeinsamen Gerüst, hier nicht gebraucht.
void [loadDebtPaymentsFor, payS, banking, analytics, backfill, executeCommand, lc, s, geld, stand, sale, gap, TODAY];
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { returnLineAmounts } = await import('../../src/core/returns/return-lines.ts');
const { buildInvoiceA5Data } = await import('../../src/core/pdf/invoice-a5.ts');

// ── Welt: je Fall ein eigener Kunde und eigene Artikel; ein Darlehen „We Borrowed" je B1-Fall ───────────────────
for (let i = 3; i <= 12; i++) {
  DB.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES (?, 'branch-main', 'Kunde', ?, 'BH', 'en', 0, '[]', 'collector', 'active', ?, ?)`, ['cust-' + i, String(i), NOW, NOW]);
}
for (let i = 9; i <= 30; i++) {
  DB.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price, purchase_currency,
      planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES (?, 'branch-main', 'cat-w', 'Rolex', ?, ?, 1, 'Pre-Owned', '[]', 0, 'BHD', 1300, 'in_stock', 'ZERO', 0, '[]', '{}', 'OWN', ?, ?)`,
  ['pk' + i, 'Sub pk' + i, 'SKU-pk' + i, NOW, NOW]);
}
reload();

const snap = () => recon.reconciliationSnapshotFor(CTX as never);
/** Abstand Hauptbuch − Bestand: gesamt (AR-Zeile) und je Kunde (Gegenparteien-Prüfung), in Fils. */
const abstand = (cid: string): { gesamt: number; kunde: number } => {
  const sn = snap();
  const row = sn.rows.find((x) => x.account === 'ACCOUNTS_RECEIVABLE')!;
  const k = sn.counterparty?.arByCustomer.rows.find((x) => x.id === cid);
  return { gesamt: F(Number(row.ledger)) - F(Number(row.domain)), kunde: k ? k.diffFils : 0 };
};
const verkauf = (cid: string, zeilen: Array<[string, number]>, date = '2026-10-20'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(cid, zeilen.map(([pid, price]) => ({ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price })) as never, 'B1-FOLLOWUP', date).id);
  reload();
  return id;
};
const storno = (id: string) => { imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: id, refundMethod: 'cash' } as never, 'branch-main')); reload(); };
const rueckgabe = (id: string, lineIds: string[]) => {
  imHaus(() => {
    const st = useSalesReturnStore.getState();
    st.loadReturns();
    const lines = lineIds.map((lid) => {
      const l = DB.exec('SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ?', [lid])[0].values[0];
      const a = returnLineAmounts({ quantity: Number(l[2]), lineTotal: Number(l[3]), vatAmount: Number(l[4]) }, Number(l[2]));
      return { invoiceLineId: String(l[0]), productId: String(l[1]), quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount };
    });
    const rid = st.createReturn({ invoiceId: id, refundMethod: 'cash', productDisposition: 'IN_STOCK', notes: 'b1-followup', lines } as never).id;
    useSalesReturnStore.getState().loadReturns();
    useSalesReturnStore.getState().approveReturn(rid);
    useSalesReturnStore.getState().refundReturn(rid);
  });
  reload();
};
const zeilenVon = (id: string): string[] => (DB.exec('SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id])[0]?.values ?? []).map((r) => String(r[0]));
/** Netto je Konto aller Buchungen dieser Rechnung (Rechnung, Zahlungen — auch gelöschte Verrechnung —, Rückgaben, Gutschriften). */
const netto = (id: string, konten: string[]): number => {
  const quellen = [id,
    ...(DB.exec('SELECT id FROM payments WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT receivable_payment_id FROM party_offsets WHERE receivable_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT id FROM sales_returns WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
    ...(DB.exec('SELECT id FROM credit_notes WHERE invoice_id = ?', [id])[0]?.values ?? []).map((r) => String(r[0])),
  ];
  return n(DB, `SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END),0) FROM ledger_entries
    WHERE source_id IN (${quellen.map(() => '?').join(',')}) AND account IN (${konten.map(() => '?').join(',')})`, [...quellen, ...konten]);
};
const L = loan('we_borrow', 5000, 'cust-3', '2026-10-16T09:00:00.000Z');
const LF = loan('we_borrow', 5000, 'cust-8', '2026-10-16T09:00:00.000Z');

// ══ A — Abstimmung: Kontrollfälle ═════════════════════════════════════════════════════════════════════════════════
/** Führt einen Ablauf aus und prüft: Abstand gesamt und je Kunde unverändert; Hauptbuch der Rechnung wie erwartet. */
function fall(tag: string, cid: string, ablauf: () => string, erwartet: { status: string; ar: number; geld: number }): void {
  const vor = abstand(cid);
  const id = ablauf();
  const nach = abstand(cid);
  const ar = netto(id, ['ACCOUNTS_RECEIVABLE']);
  const geld = netto(id, ['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING']);
  ok(nach.gesamt === vor.gesamt && nach.kunde === vor.kunde && nach.kunde === 0,
    `${tag} Abstimmung gesamt und je Kunde unverändert (${vor.gesamt}/${vor.kunde} → ${nach.gesamt}/${nach.kunde} Fils)`);
  ok(String(inv(id)[0]) === erwartet.status && eq(ar, erwartet.ar) && eq(geld, erwartet.geld) && ledgerBalanced(),
    `${tag} Hauptbuch: Status ${inv(id)[0]}, AR netto ${ar.toFixed(3)} (erw. ${erwartet.ar}), Geld netto ${geld.toFixed(3)} (erw. ${erwartet.geld}), ausgeglichen`);
}
fall('A-1 Storno mit Rückgabe (900, 300 bar, Erstattung bar)', 'cust-4', () => {
  const id = verkauf('cust-4', [['pk9', 900]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  storno(id);
  return id;
}, { status: 'CANCELLED', ar: 0, geld: 0 });
fall('A-2 dasselbe mit B1-Verrechnung (300 bar + 500 verrechnet)', 'cust-3', () => {
  const id = verkauf('cust-3', [['pk10', 900]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  create({ invoiceId: id, debtId: L, amount: 500 });
  storno(id);
  return id;
}, { status: 'CANCELLED', ar: 0, geld: 0 });
ok(eq(debtState(L).open, 5000), 'A-2b das Darlehen ist nach dem Storno wieder ganz offen');
fall('A-3 Storno ohne Rückgabe (400, unbezahlt)', 'cust-5', () => {
  const id = verkauf('cust-5', [['pk11', 400]]);
  storno(id);
  return id;
}, { status: 'CANCELLED', ar: 0, geld: 0 });
fall('A-4 Rückgabe ohne Storno (500, 200 bar, volle Rückgabe, Erstattung)', 'cust-6', () => {
  const id = verkauf('cust-6', [['pk12', 500]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 200, 'cash'));
  rueckgabe(id, zeilenVon(id));
  return id;
}, { status: 'RETURNED', ar: 0, geld: 0 });
fall('A-5 Teilzahlung, Teilrückgabe (400) mit Erstattung, dann Storno des Rests (400 + 600, 300 bar)', 'cust-7', () => {
  const id = verkauf('cust-7', [['pk13', 400], ['pk14', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  rueckgabe(id, [zeilenVon(id)[0]]);
  ok(inv(id)[0] === 'PARTIAL', `A-5/6 nach der Teilrückgabe noch offen (${S(inv(id))}) — der Rest wird storniert`);
  storno(id);
  return id;
}, { status: 'CANCELLED', ar: 0, geld: 0 });
fall('A-6 dasselbe mit B1-Verrechnung (300 bar + 200 verrechnet)', 'cust-8', () => {
  const id = verkauf('cust-8', [['pk15', 400], ['pk16', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  create({ invoiceId: id, debtId: LF, amount: 200 });
  rueckgabe(id, [zeilenVon(id)[0]]);
  ok(inv(id)[0] === 'PARTIAL', `A-5/6 nach der Teilrückgabe noch offen (${S(inv(id))}) — der Rest wird storniert`);
  storno(id);
  return id;
}, { status: 'CANCELLED', ar: 0, geld: 0 });
fall('A-7 Teilzahlung ohne Storno und ohne Rückgabe (offen bleibt offen)', 'cust-9', () => {
  const id = verkauf('cust-9', [['pk17', 800]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 250, 'cash'));
  return id;
}, { status: 'PARTIAL', ar: 550, geld: 250 });
{
  const s = snap();
  const ar = s.rows.find((x) => x.account === 'ACCOUNTS_RECEIVABLE')!;
  ok(eq(Number(ar.ledger), Number(ar.domain)) && (s.counterparty?.arByCustomer.mismatches ?? 1) === 0,
    `A-8 nach allen Fällen: AR-Zeile Hauptbuch = Bestand (${ar.ledger} / ${ar.domain}), keine Abweichung je Kunde`);
}

// ══ S — Letzte Zahlung einer ausgestellten Rechnung entfernt ════════════════════════════════════════════════════
{
  const frischId = verkauf('cust-10', [['pk18', 700]]);
  const frisch = S(DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [frischId])[0].values[0]);
  const id = verkauf('cust-10', [['pk19', 700]]);
  const pid = imHaus(() => useInvoiceStore.getState().recordPayment(id, 700, 'cash', undefined, false));
  reload();
  const nr = String(inv(id)[2]);
  ok(inv(id)[0] === 'FINAL' && !nr.startsWith('PINV'), `S-1 voll bar bezahlt: FINAL mit Endnummer ${nr}`);
  imHaus(() => useInvoiceStore.getState().deletePayment(pid, id));
  reload();
  const e = S(DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [id])[0].values[0]);
  ok(e === frisch && String(inv(id)[2]) === nr, `S-2 letzte Barzahlung gelöscht: ausgestellt und ganz offen wie frisch (${e}), Endnummer bleibt`);
  ok(recv.receivablesBreakdown('branch-main').some((r) => r.sourceId === id && eq(r.open, 700)), 'S-3 Receivables zählt sie weiter (offen 700)');
  ok(eq(ca.customerAccountFor(CTX, 'cust-10').docs.find((d) => d.key.endsWith(id))?.open ?? -1, 700), 'S-4 Kundenkonto zählt sie weiter (offen 700)');
  const titelFrisch = buildInvoiceA5Data({ company: {} as never, products: [], paymentMethods: [], salesperson: '', customer: null as never,
    invoice: { number: 'X', status: 'PARTIAL', issuedAt: '2026-10-20', grossAmount: 700, paidAmount: 0, lines: [] } as never }).title;
  const titel = buildInvoiceA5Data({ company: {} as never, products: [], paymentMethods: [], salesperson: '', customer: null as never,
    invoice: { number: nr, status: String(inv(id)[0]), issuedAt: '2026-10-20', grossAmount: 700, paidAmount: 0, lines: [] } as never }).title;
  ok(titel !== 'PROFORMA INVOICE' && titel === titelFrisch, `S-5 PDF: kein Proforma, derselbe Titel wie jede ausgestellte offene Rechnung („${titel}")`);
  ok(po.debtOffsetCandidatesFor(CTX, id).invoiceOpen === 700, 'S-6 wieder bezahlbar/verrechenbar (offen 700)');
  const seqVor = n(DB, "SELECT COALESCE(SUM(next_number),0) FROM document_sequences");
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 700, 'cash'));
  reload();
  ok(inv(id)[0] === 'FINAL' && String(inv(id)[2]) === nr && n(DB, "SELECT COALESCE(SUM(next_number),0) FROM document_sequences") === seqVor,
    'S-7 erneut bezahlt: FINAL mit derselben Nummer, kein Zähler weitergezählt (keine zweite Endnummer)');
  // PC2: dieselbe Löschung über invoices.delete_payment.
  const id2 = verkauf('cust-10', [['pk20', 300]]);
  const pid2 = imHaus(() => useInvoiceStore.getState().recordPayment(id2, 300, 'cash'));
  reload();
  const d = await fern(() => fc.runDeletePayment(deps() as never, identity('801', 'invoices.delete_payment'), { invoiceId: id2, paymentId: pid2, expectedRevision: invRev(id2) }));
  ok(d.kind === 'ok' && S(DB.exec('SELECT status, paid_amount FROM invoices WHERE id = ?', [id2])[0].values[0]) === frisch, `S-8 PC2 löscht die letzte Zahlung: derselbe Stand (${d.kind})`);
  // Eine Teilzahlung bleibt eine Teilzahlung.
  const id3 = verkauf('cust-10', [['pk21', 500]]);
  const p1 = imHaus(() => useInvoiceStore.getState().recordPayment(id3, 200, 'cash'));
  imHaus(() => useInvoiceStore.getState().recordPayment(id3, 100, 'bank_transfer'));
  imHaus(() => useInvoiceStore.getState().deletePayment(p1, id3));
  ok(inv(id3)[0] === 'PARTIAL' && eq(Number(inv(id3)[1]), 100), 'S-9 von zwei Zahlungen eine gelöscht: PARTIAL mit der verbleibenden 100 (unverändert)');
  // VAT-Sperre unverändert: eine FINAL-Rechnung im eingereichten Quartal verliert ihre Zahlung nicht.
  const id4 = verkauf('cust-10', [['pk22', 400]]);
  const p4 = imHaus(() => useInvoiceStore.getState().recordPayment(id4, 400, 'cash'));
  reload();
  const q = Math.floor(new Date().getMonth() / 3) + 1;
  insert(DB, 'vat_filings', { id: 'vf-f', branch_id: 'branch-main', year: new Date().getFullYear(), quarter: q, filed_at: NOW, created_at: NOW });
  const vat = wirft(() => imHaus(() => useInvoiceStore.getState().deletePayment(p4, id4)));
  DB.run("DELETE FROM vat_filings WHERE id = 'vf-f'");
  ok(vat === 'VAT_PERIOD_FILED' && inv(id4)[0] === 'FINAL' && n(DB, 'SELECT COUNT(*) FROM payments WHERE id = ?', [p4]) === 1,
    `S-10 VAT-Sperre unverändert: Löschen abgelehnt, FINAL und Zahlung bleiben (${vat})`);
  // Storno bleibt Storno, echter Entwurf bleibt Entwurf (die Regel im Quelltext).
  const st = src('src/stores/invoiceStore.ts');
  ok(/function statusWithoutPayment\(prev: InvoiceStatus\): InvoiceStatus \{\s*return prev === 'CANCELLED' \? 'CANCELLED' : prev === 'DRAFT' \? 'DRAFT' : 'PARTIAL';/.test(st)
    && (st.match(/statusWithoutPayment\(inv\.status\)/g) ?? []).length === 2 && !/: 'DRAFT'\);/.test(st),
    'S-11 eine Regel für Löschen und Ändern: CANCELLED bleibt, DRAFT bleibt, sonst PARTIAL — kein Rückfall auf DRAFT mehr');
}

console.log(`\nB1 follow-up: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

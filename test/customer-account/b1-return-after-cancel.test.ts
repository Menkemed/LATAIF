// ════════════════════════════════════════════════════════════════════════════
// B1-Sicherheitsabschluss V1–V3 (Owner 09.11.2026) — Rückgabe/Gutschrift NACH einem Rechnungsstorno.
//   V1: eine Rückgabe einer STORNIERTEN Rechnung wird nicht zurückgenommen (Hausfolge: Maske, PC2, Kommissionsstorno).
//   V2: kein Rechnungsstorno, solange eine Rückgabe nur ANGELEGT ist (REQUESTED, ohne Gutschrift) — Primary und PC2.
//   V3: eine Gutschrift einer Rückgabe wird nie direkt gelöscht (nur „Cancel Return"); unabhängige Gutschriften bleiben
//       löschbar — nur Owner, nur Primary.
//   Je Schritt: Hauptbuch, Receivables, Kundenkonto, Geld und beide Forderungsabstimmungen einig; jede Ablehnung ohne
//   Teiländerung (Abdruck aller berührten Tabellen); PC2-Wiederholung liefert dasselbe Nein; zulässige Wege bleiben.
// Nur künstliche Testdaten (In-Memory-sql.js). Gerüst aus test/customer-account/b1-followup.test.ts.
// Run: node test/customer-account/b1-return-after-cancel.test.ts
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


const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { returnLineAmounts } = await import('../../src/core/returns/return-lines.ts');
const { cancelReturnInHouse } = await import('../../src/core/returns/return-cancel-house.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const rc = await import('../../src/core/bridge/sales-reversal-commands.ts');

// ── Welt ────────────────────────────────────────────────────────────────────────────────────────────────────────
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
const abstand = (cid: string): { gesamt: number; kunde: number } => {
  const sn = snap();
  const row = sn.rows.find((x) => x.account === 'ACCOUNTS_RECEIVABLE')!;
  const k = sn.counterparty?.arByCustomer.rows.find((x) => x.id === cid);
  return { gesamt: F(Number(row.ledger)) - F(Number(row.domain)), kunde: k ? k.diffFils : 0 };
};
const verkauf = (cid: string, z: Array<[string, number]>, date = '2026-10-20'): string => {
  const id = imHaus(() => useInvoiceStore.getState().createDirectInvoice(cid, z.map(([pid, price]) => ({ productId: pid, quantity: 1, unitPrice: price, purchasePrice: 0,
    taxScheme: 'ZERO', vatRate: 0, vatAmount: 0, lineTotal: price })) as never, 'B1-RAC', date).id);
  reload();
  return id;
};
const storno = (id: string) => { imHaus(() => cancelHouse.cancelInvoiceInHouse({ invoiceId: id, refundMethod: 'cash' } as never, 'branch-main')); reload(); };
/** Rückgabe freigeben und erstatten (soweit der Deckel Geld zulässt); liefert die Rückgabe-ID. */
const rueckgabe = (id: string, lineIds: string[], refundMethod = 'cash', nurAnlegen = false): string => {
  const rid = imHaus(() => {
    const st = useSalesReturnStore.getState();
    st.loadReturns();
    const lines = lineIds.map((lid) => {
      const l = DB.exec('SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ?', [lid])[0].values[0];
      const a = returnLineAmounts({ quantity: Number(l[2]), lineTotal: Number(l[3]), vatAmount: Number(l[4]) }, Number(l[2]));
      return { invoiceLineId: String(l[0]), productId: String(l[1]), quantity: a.quantity, unitPrice: a.unitPrice, vatAmount: a.vatAmount };
    });
    const r = st.createReturn({ invoiceId: id, refundMethod, productDisposition: 'IN_STOCK', notes: 'b1-rac', lines } as never).id;
    if (!nurAnlegen) {
      useSalesReturnStore.getState().loadReturns();
      useSalesReturnStore.getState().approveReturn(r);
      useSalesReturnStore.getState().refundReturn(r);
    }
    return r;
  });
  reload();
  return rid;
};
const zeilenVon = (id: string): string[] => (DB.exec('SELECT id FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid', [id])[0]?.values ?? []).map((r) => String(r[0]));
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
/** Tatsächlich geflossenes Geld der Rechnung: Geldzahlungen minus ausgezahlte Erstattungen (laut Belegen, nicht Hauptbuch). */
const geldBelege = (id: string): number =>
  n(DB, `SELECT COALESCE(SUM(amount),0) FROM payments WHERE invoice_id = ? AND method NOT IN ('debt_offset','order_deposit','credit','store_credit')`, [id])
  - n(DB, `SELECT COALESCE(SUM(refund_paid_amount),0) FROM sales_returns WHERE invoice_id = ? AND COALESCE(refund_method,'') != 'credit'`, [id]);
const rueckStatus = (rid: string): string => S(DB.exec('SELECT status, refund_status, refund_paid_amount FROM sales_returns WHERE id = ?', [rid])[0]?.values?.[0] ?? []);
const cnVon = (rid: string): string => s(DB, 'SELECT id FROM credit_notes WHERE sales_return_id = ?', [rid]);
const cnStatus = (rid: string): string => s(DB, 'SELECT COALESCE(status, \'gelöscht?\') FROM credit_notes WHERE sales_return_id = ?', [rid]) || 'gelöscht';
const L = loan('we_borrow', 5000, 'cust-8', '2026-10-16T09:00:00.000Z');

/** Gesamtabstand zu Beginn des Falls — jeder Fall misst nur seine eigene Wirkung. */
let basis = 0;
const neuerFall = (): void => { basis = abstand('cust-3').gesamt; };
/** Ein Stand der Rechnung über alle fünf Sichten. */
function sicht(id: string, cid: string) {
  const ab = abstand(cid);
  return {
    status: String(inv(id)[0]),
    ar: netto(id, ['ACCOUNTS_RECEIVABLE']),
    geldHB: netto(id, ['CASH', 'BANK', 'BENEFIT', 'CARD_CLEARING']),
    geldBeleg: geldBelege(id),
    recv: recv.receivablesBreakdown('branch-main').find((r) => r.sourceId === id)?.open ?? 0,
    konto: ca.customerAccountFor(CTX, cid).docs.find((d) => d.key.endsWith(id))?.open ?? 0,
    gesamt: ab.gesamt - basis, kunde: ab.kunde,
    balanced: ledgerBalanced(),
  };
}
type Sicht = ReturnType<typeof sicht>;
const fmt = (v: Sicht): string => `Status ${v.status}, AR-HB ${v.ar.toFixed(3)}, Receivables ${Number(v.recv).toFixed(3)}, Konto ${Number(v.konto).toFixed(3)}, `
  + `Geld HB ${v.geldHB.toFixed(3)}/Beleg ${v.geldBeleg.toFixed(3)}, Abstand ${v.gesamt}/${v.kunde} Fils`;
/** Die Invariante: alle Sichten einig. */
function einig(tag: string, id: string, cid: string): Sicht {
  const v = sicht(id, cid);
  ok(v.balanced && v.gesamt === 0 && v.kunde === 0 && eq(v.ar, Number(v.recv)) && eq(v.ar, Number(v.konto)) && eq(v.geldHB, v.geldBeleg),
    `${tag} — Hauptbuch, Receivables, Kundenkonto, Geld und beide Abstimmungen einig (${fmt(v)})`);
  return v;
}
const owner = { userId: 'user-test', role: 'ADMIN' };
const cancelRet = (rid: string): string => wirft(() => imHaus(() => cancelReturnInHouse(rid, 'Prüfung', owner, 'branch-main')));
const cancelRetFern = async (x: string, rid: string): Promise<Outcome & { thrown?: string }> => {
  const rev = n(DB, 'SELECT revision FROM sales_returns WHERE id = ?', [rid]);
  const o = await fern(() => rc.runReturnCancel(deps() as never, identity(x, 'returns.cancel'), { returnId: rid, reason: 'Prüfung PC2', expectedRevision: rev }));
  reload();
  return o;
};
const delCN = (rid: string): string => wirft(() => imHaus(() => { useCreditNoteStore.getState().loadCreditNotes(); useCreditNoteStore.getState().deleteCreditNote(cnVon(rid)); }));

ok(abstand('cust-3').gesamt === 0, 'Ausgangslage: Abstimmung ohne Abstand');

const { returnCancelability, RETURN_INVOICE_CANCELLED } = await import('../../src/core/returns/return-cancel-house.ts');
const cnS = await import('../../src/stores/creditNoteStore.ts');
const icc = await import('../../src/core/bridge/invoice-cancel-command.ts');

/** Abdruck aller Geschäftstabellen, die ein Storno, eine Rückgabe oder eine Gutschrift berührt (Zeile für Zeile). */
const TABELLEN = ['invoices', 'invoice_lines', 'payments', 'sales_returns', 'sales_return_lines', 'credit_notes', 'customer_credits',
  'products', 'stock_lots', 'party_offsets', 'debts', 'debt_payments', 'expenses', 'ledger_entries', 'audit_log'];
const abdruck = (): string => S(TABELLEN.map((t) => { try { return DB.exec(`SELECT * FROM ${t} ORDER BY rowid`)[0]?.values ?? []; } catch { return 'n/a'; } }));
/** Eine abgelehnte Aktion ändert NICHTS: dieselben Sichten und jede Zeile jeder betroffenen Tabelle gleich. */
function unveraendert(tag: string, vorher: { sicht: Sicht; abdruck: string }, id: string, cid: string): void {
  const v = sicht(id, cid);
  ok(S(v) === S(vorher.sicht) && abdruck() === vorher.abdruck, `${tag} — keine Teiländerung (Datenbank, Bestand, Finanzkonten gleich; ${fmt(v)})`);
}
const stand0 = (id: string, cid: string) => ({ sicht: sicht(id, cid), abdruck: abdruck() });
const cancelInvFern = async (x: string, id: string): Promise<Outcome & { thrown?: string }> => {
  const o = await fern(() => icc.runCancelInvoice(deps() as never, identity(x, 'invoices.cancel'), { invoiceId: id, expectedRevision: invRev(id), refundMethod: 'cash' }));
  reload();
  return o;
};
const cancelability = (rid: string) => {
  const r = DB.exec('SELECT id, status, refund_paid_amount, product_disposition FROM sales_returns WHERE id = ?', [rid])[0].values[0];
  return returnCancelability({ id: String(r[0]), status: String(r[1]), refundPaidAmount: Number(r[2] ?? 0), productDisposition: String(r[3] ?? '') || undefined });
};
const artikel = (pid: string): string => S(DB.exec('SELECT stock_status, quantity FROM products WHERE id = ?', [pid])[0]?.values?.[0] ?? []);

// ══ R-1 Storno mit Rückgabe, Erstattung BAR AUSGEZAHLT — Rückgabe des Stornos stornieren / Gutschrift löschen ═════
{
  const cid = 'cust-3';
  neuerFall();
  const id = verkauf(cid, [['pk9', 900]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  storno(id);
  const rid = s(DB, 'SELECT id FROM sales_returns WHERE invoice_id = ?', [id]);
  einig('R-1a zulässiger Storno mit Rückgabe (900, 300 bar erstattet)', id, cid);
  ok(rueckStatus(rid) === S(['APPROVED', 'PARTIALLY_REFUNDED', 300]) && cnStatus(rid) === 'ISSUED', `R-1a Storno-Rückgabe ${rueckStatus(rid)}, Gutschrift ${cnStatus(rid)}`);
  const v0 = stand0(id, cid);
  const e1 = cancelRet(rid);
  // Die bisherige Sperre (ausgezahlt) behält ihren Code; V1 steht dahinter.
  ok(e1 === 'RETURN_REFUND_PAID_OUT', `R-1b Cancel Return am Primary gesperrt (${e1})`);
  unveraendert('R-1b', v0, id, cid);
  const f1 = await cancelRetFern('901', rid);
  ok(f1.code === 'RETURN_REFUND_PAID_OUT', `R-1c Cancel Return über PC2 gesperrt (${S({ kind: f1.kind, code: f1.code })})`);
  unveraendert('R-1c', v0, id, cid);
  // V3 — „Delete" auf der Gutschriftseite: vorher lief es und kehrte die AUSGEZAHLTE Erstattung im Hauptbuch um.
  const d1 = delCN(rid);
  reload();
  ok(d1 === cnS.CREDIT_NOTE_VIA_RETURN && cnStatus(rid) === 'ISSUED', `R-1d V3 Gutschrift einer Rückgabe lässt sich nicht direkt löschen (${d1})`);
  unveraendert('R-1d', v0, id, cid);
}

// ══ R-2…R-4 Teilrückgabe OHNE Auszahlung, Storno des Rests, dann Teilrückgabe stornieren (Primary, PC2, mit B1) ════
async function teilFall(tag: string, cid: string, p1: string, p2: string, mitB1: boolean, fernX?: string): Promise<void> {
  neuerFall();
  const id = verkauf(cid, [[p1, 400], [p2, 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  if (mitB1) create({ invoiceId: id, debtId: L, amount: 200 });
  reload();
  const r1 = rueckgabe(id, [zeilenVon(id)[0]]);
  ok(rueckStatus(r1) === S(['REFUNDED', 'PENDING_REFUND', 0]) && inv(id)[0] === 'PARTIAL',
    `${tag}a Teilrückgabe 400 ohne Auszahlung (${rueckStatus(r1)}), Rechnung offen (${S(inv(id))})`);
  einig(`${tag}a nach der Teilrückgabe`, id, cid);
  ok(cancelability(r1).canCancel, `${tag}a vor dem Storno darf die Teilrückgabe storniert werden (Knopf angeboten)`);
  storno(id);
  einig(`${tag}b zulässiger Storno des Rests (600, 300 bar erstattet)`, id, cid);
  if (mitB1) ok(eq(debtState(L).open, 5000), `${tag}b das Darlehen ist nach dem Storno wieder ganz offen`);
  const cb = cancelability(r1);
  ok(!cb.canCancel && /invoice of this return is cancelled/.test(String(cb.blockReason)), `${tag}b V1 der Knopf sagt es vorher (${cb.blockReason})`);
  const v0 = stand0(id, cid);
  if (fernX) {
    const o = await cancelRetFern(fernX, r1);
    ok(o.code === RETURN_INVOICE_CANCELLED, `${tag}c V1 Cancel Return über PC2 abgelehnt (${S({ kind: o.kind, code: o.code })})`);
    unveraendert(`${tag}c`, v0, id, cid);
    const w = await cancelRetFern(fernX, r1);
    ok(w.code === RETURN_INVOICE_CANCELLED && w.replayed === true, `${tag}d PC2-Wiederholung: dasselbe eingefrorene Nein (${S({ kind: w.kind, code: w.code, replayed: w.replayed })})`);
    unveraendert(`${tag}d`, v0, id, cid);
  } else {
    const e = cancelRet(r1);
    ok(e === RETURN_INVOICE_CANCELLED, `${tag}c V1 Cancel Return am Primary abgelehnt (${e})`);
    unveraendert(`${tag}c`, v0, id, cid);
    // Auch der Weg der Maske (Store, Owner-Sitzung, eigene Transaktion) lehnt ab.
    const m = await useSalesReturnStore.getState().cancelReturn(r1, 'Prüfung Maske').then(() => '', (x: { code?: string }) => String(x.code ?? x));
    reload();
    ok(m === RETURN_INVOICE_CANCELLED, `${tag}d V1 auch über die Maske des Primary abgelehnt (${m})`);
    unveraendert(`${tag}d`, v0, id, cid);
  }
  ok(artikel(p1) === S(['in_stock', 1]) && rueckStatus(r1) === S(['REFUNDED', 'PENDING_REFUND', 0]) && cnStatus(r1) === 'ISSUED',
    `${tag}e Ware bleibt im Bestand (${artikel(p1)}), Rückgabe und Gutschrift bleiben wirksam`);
  if (mitB1) ok(eq(debtState(L).open, 5000), `${tag}e das Darlehen bleibt ganz offen`);
}
await teilFall('R-2', 'cust-4', 'pk10', 'pk11', false);
await teilFall('R-3 (PC2)', 'cust-5', 'pk12', 'pk13', false, '902');
await teilFall('R-4 (B1 200)', 'cust-8', 'pk14', 'pk15', true);

// ══ R-5 Teilrückgabe ohne Auszahlung, Storno, dann die Gutschrift der Teilrückgabe LÖSCHEN ══════════════════════
{
  const cid = 'cust-6';
  neuerFall();
  const id = verkauf(cid, [['pk16', 400], ['pk17', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  const r1 = rueckgabe(id, [zeilenVon(id)[0]]);
  storno(id);
  einig('R-5a nach dem Storno', id, cid);
  const v0 = stand0(id, cid);
  const d = delCN(r1);
  reload();
  ok(d === cnS.CREDIT_NOTE_VIA_RETURN, `R-5b V3 Gutschrift der Teilrückgabe lässt sich nicht direkt löschen (${d})`);
  unveraendert('R-5b', v0, id, cid);
}

// ══ R-6 Teilrückgabe als Store Credit vor dem Storno — nicht erreichbar (unverändert) ═══════════════════════════
{
  const cid = 'cust-7';
  neuerFall();
  const id = verkauf(cid, [['pk18', 400], ['pk19', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 700, 'cash'));
  rueckgabe(id, [zeilenVon(id)[0]], 'credit');
  einig('R-6a nach der Guthaben-Rückgabe', id, cid);
  const v0 = stand0(id, cid);
  const es = wirft(() => storno(id));
  reload();
  ok(es === 'INVOICE_NOT_CANCELLABLE' && inv(id)[0] === 'RETURNED', `R-6b Guthaben nur bei Überzahlung → RETURNED, Storno abgelehnt (${es})`);
  unveraendert('R-6b', v0, id, cid);
}

// ══ R-7 Rückgabe nur ANGELEGT („Pending") → Storno abgelehnt (Primary + PC2); zulässige Wege danach ═══════════════
{
  const cid = 'cust-9';
  neuerFall();
  const id = verkauf(cid, [['pk20', 400], ['pk21', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  const r1 = rueckgabe(id, [zeilenVon(id)[0]], 'cash', true);
  einig('R-7a nach der angelegten Rückgabe', id, cid);
  const v0 = stand0(id, cid);
  const es = wirft(() => storno(id));
  reload();
  ok(es === 'INVOICE_HAS_PENDING_RETURN', `R-7b V2 Storno am Primary abgelehnt, solange die Rückgabe angelegt ist (${es})`);
  unveraendert('R-7b', v0, id, cid);
  const f = await cancelInvFern('903', id);
  ok(f.code === 'INVOICE_HAS_PENDING_RETURN', `R-7c V2 Storno über PC2 abgelehnt (${S({ kind: f.kind, code: f.code })})`);
  unveraendert('R-7c', v0, id, cid);
  const w = await cancelInvFern('903', id);
  ok(w.code === 'INVOICE_HAS_PENDING_RETURN' && w.replayed === true, `R-7d PC2-Wiederholung: dasselbe eingefrorene Nein (${S({ kind: w.kind, code: w.code, replayed: w.replayed })})`);
  unveraendert('R-7d', v0, id, cid);
  // Zulässig: erst die angelegte Rückgabe kontrolliert stornieren (Rechnung lebt noch), dann die Rechnung.
  const e = cancelRet(r1);
  reload();
  ok(e === '' && rueckStatus(r1).startsWith('["REJECTED"') && artikel('pk20') !== S(['in_stock', 1]), `R-7e angelegte Rückgabe an der lebenden Rechnung storniert (${rueckStatus(r1)}, Artikel ${artikel('pk20')})`);
  storno(id);
  const v = einig('R-7f danach Storno zulässig', id, cid);
  ok(v.status === 'CANCELLED' && eq(v.ar, 0) && artikel('pk20') === S(['in_stock', 1]) && artikel('pk21') === S(['in_stock', 1]),
    `R-7f Rechnung CANCELLED, keine Forderung, beide Artikel zurück im Bestand (${artikel('pk20')} ${artikel('pk21')})`);
}
{
  const cid = 'cust-11';
  neuerFall();
  const id = verkauf(cid, [['pk23', 400], ['pk24', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  const r1 = rueckgabe(id, [zeilenVon(id)[0]], 'cash', true);
  ok(wirft(() => storno(id)) === 'INVOICE_HAS_PENDING_RETURN', 'R-7g V2 auch hier: Storno abgelehnt');
  // Zulässig: die angelegte Rückgabe abschließen (freigeben, Erstattung soweit Geld da ist), dann die Rechnung.
  imHaus(() => { useSalesReturnStore.getState().loadReturns(); useSalesReturnStore.getState().approveReturn(r1); useSalesReturnStore.getState().refundReturn(r1); });
  reload();
  ok(cnStatus(r1) === 'ISSUED', `R-7h Rückgabe abgeschlossen (${rueckStatus(r1)}), Gutschrift ausgestellt`);
  storno(id);
  const v = einig('R-7i danach Storno zulässig', id, cid);
  ok(v.status === 'CANCELLED' && eq(v.ar, 0), `R-7i Rechnung CANCELLED ohne offene Forderung (${fmt(v)})`);
}

// ══ R-8 Ohne Rechnungsstorno: Rückgabe mit ausgezahlter Erstattung — Gutschrift löschen gesperrt; Korrektur über Cancel Return
{
  const cid = 'cust-10';
  neuerFall();
  const id = verkauf(cid, [['pk22', 500]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 200, 'cash'));
  const r1 = rueckgabe(id, zeilenVon(id));
  einig('R-8a nach der Rückgabe (RETURNED, 200 erstattet)', id, cid);
  const v0 = stand0(id, cid);
  ok(cancelRet(r1) === 'RETURN_REFUND_PAID_OUT', 'R-8b Cancel Return gesperrt (ausgezahlt)');
  unveraendert('R-8b', v0, id, cid);
  const d = delCN(r1);
  reload();
  ok(d === cnS.CREDIT_NOTE_VIA_RETURN, `R-8c V3 Gutschrift löschen gesperrt (${d})`);
  unveraendert('R-8c', v0, id, cid);
}
{
  // Zulässige Rückgabekorrektur an einer lebenden Rechnung bleibt möglich (Cancel Return ohne Auszahlung).
  const cid = 'cust-12';
  neuerFall();
  const id = verkauf(cid, [['pk25', 400], ['pk26', 600]]);
  imHaus(() => useInvoiceStore.getState().recordPayment(id, 300, 'cash'));
  const r1 = rueckgabe(id, [zeilenVon(id)[0]]);
  ok(delCN(r1) === cnS.CREDIT_NOTE_VIA_RETURN, 'R-8d V3 auch an der lebenden Rechnung: nur über Cancel Return');
  const e = cancelRet(r1);
  reload();
  const v = einig('R-8e Cancel Return an der lebenden Rechnung', id, cid);
  ok(e === '' && v.status === 'PARTIAL' && eq(v.ar, 700) && cnStatus(r1) === 'CANCELLED' && artikel('pk25') !== S(['in_stock', 1]),
    `R-8e zulässig wie bisher: Gutschrift CANCELLED, Rechnung wieder offen 700, Ware wieder verkauft (${e || 'ok'}, ${artikel('pk25')})`);
}

// ══ R-9 Unabhängige Gutschrift (ohne Rückgabe): löschbar für Admin und Owner (Rolle ADMIN), nur am Primary ═══════
{
  const cid = 'cust-11';
  const als = (userId: string, role: string) => useAuthStore.setState({ session: { userId, branchId: 'branch-main', role } as never });
  const zurueck = () => als('user-test', 'ADMIN');
  /** Eine unabhängige Gutschrift 100 auf einer neuen offenen Rechnung 500. */
  const gutschrift = (pid: string): { id: string; cnId: string } => {
    const id = verkauf(cid, [[pid, 500]]);
    const cn = imHaus(() => useCreditNoteStore.getState().createCreditNote({ invoiceId: id, customerId: cid, totalAmount: 100, vatAmount: 0,
      cashRefundAmount: 0, receivableCancelAmount: 100, reason: 'b1-rac unabhängig' }));
    reload();
    return { id, cnId: cn.id };
  };
  const del = (cnId: string) => wirft(() => imHaus(() => { useCreditNoteStore.getState().loadCreditNotes(); useCreditNoteStore.getState().deleteCreditNote(cnId); }));
  neuerFall();
  const g = gutschrift('pk27');
  einig('R-9a unabhängige Gutschrift 100 auf offener Rechnung', g.id, cid);
  const v0 = stand0(g.id, cid);
  // Nicht berechtigt: Manager (auch wenn usePermission().isAdmin ihn einschließt), Sales, Accountant, Altwerte.
  for (const [rolle, user] of [['MANAGER', 'user-manager'], ['SALES', 'user-staff'], ['ACCOUNTANT', 'user-acc'], ['manager', 'user-alt-m'], ['backoffice', 'user-alt-b'], ['viewer', 'user-alt-v']]) {
    als(user, rolle);
    const e = del(g.cnId);
    zurueck();
    ok(e === cnS.CREDIT_NOTE_ADMIN_ONLY, `R-9b ${rolle} darf nicht löschen (${e})`);
    unveraendert(`R-9b ${rolle}`, v0, g.id, cid);
  }
  store.set('lataif_runtime_mode', 'client');
  const e2 = del(g.cnId);
  store.delete('lataif_runtime_mode');
  ok(e2 === cnS.CREDIT_NOTE_PRIMARY_ONLY, `R-9c im PC2-Modus abgelehnt, auch für Admin (${e2})`);
  unveraendert('R-9c', v0, g.id, cid);
  // Berechtigt: der Owner (Rolle ADMIN), ein weiterer Admin-Benutzer, der Altwert 'owner'.
  const faelle: Array<[string, string, string]> = [['Owner', 'user-owner', 'ADMIN'], ['weiterer Admin', 'user-admin-2', 'ADMIN'], ['Altwert owner', 'user-alt-o', 'owner']];
  faelle.forEach(([wer, user, rolle], i) => {
    const x = i === 0 ? g : gutschrift(['pk28', 'pk29'][i - 1]);
    als(user, rolle);
    const e = del(x.cnId);
    zurueck();
    reload();
    const v = einig(`R-9d ${wer} löscht die unabhängige Gutschrift`, x.id, cid);
    ok(e === '' && n(DB, 'SELECT COUNT(*) FROM credit_notes WHERE id = ?', [x.cnId]) === 0 && eq(v.ar, 500),
      `R-9d ${wer} (${rolle}) darf: Gutschrift weg, Forderung wieder 500 (${e || 'ok'})`);
  });
  // Rückgabe-Gutschrift: für JEDE Rolle direkt unlöschbar (auch für den Owner).
  const r = verkauf(cid, [['pk30', 400]]);
  const rid = rueckgabe(r, zeilenVon(r));
  const vr = stand0(r, cid);
  for (const [rolle, user] of [['ADMIN', 'user-owner'], ['ADMIN', 'user-admin-2'], ['MANAGER', 'user-manager']]) {
    als(user, rolle);
    const e = del(cnVon(rid));
    zurueck();
    ok(e === (rolle === 'ADMIN' ? cnS.CREDIT_NOTE_VIA_RETURN : cnS.CREDIT_NOTE_ADMIN_ONLY), `R-9e Rückgabe-Gutschrift für ${user} (${rolle}) direkt unlöschbar (${e})`);
    unveraendert(`R-9e ${user}`, vr, r, cid);
  }
  // Die Regel der Maske ist dieselbe.
  ok(cnS.creditNoteDeleteBlock({}, 'ADMIN') === null && cnS.creditNoteDeleteBlock({}, 'owner') === null
    && ['MANAGER', 'SALES', 'ACCOUNTANT', 'viewer', undefined].every((ro) => cnS.creditNoteDeleteBlock({}, ro) !== null)
    && cnS.creditNoteDeleteBlock({ salesReturnId: 'x' }, 'ADMIN') !== null,
  'R-9f Maske: Admin/Owner frei, alle anderen Rollen gesperrt, Rückgabe-Gutschrift für alle gesperrt');
}

// ══ Quelltext: Maske und Schreibwege ════════════════════════════════════════════════════════════════════════════
{
  const det = src('src/pages/credit-notes/CreditNoteDetail.tsx');
  ok(/const deleteBlock = creditNoteDeleteBlock\(cn, perm\.role\);/.test(det) && /\{\.\.\.primaryOnlyDeleteProps\(\)\}\s*\{\.\.\.\(deleteBlock \? \{ disabled: true, title: deleteBlock/.test(det),
    'Q-1 Gutschriftseite: „Delete" nur ohne Rückgabe und nur für die Rolle Admin (dieselbe Regel wie der Schreibweg)');
  ok(cnS.creditNoteDeleteBlock({ salesReturnId: 'x' }, 'ADMIN') !== null && cnS.creditNoteDeleteBlock({}, 'MANAGER') !== null && cnS.creditNoteDeleteBlock({}, 'ADMIN') === null,
    'Q-2 Regel der Maske: Rückgabe-Gutschrift gesperrt, Nicht-Owner gesperrt, Owner bei unabhängiger Gutschrift frei');
  const bridge = ['src/core/bridge/sales-reversal-commands.ts', 'src/core/bridge/return-commands.ts', 'src/core/bridge/financial-commands.ts',
    'src/core/bridge/invoice-lifecycle-commands.ts', 'src/core/bridge/invoice-cancel-command.ts'].map(src).join('\n');
  ok(!/deleteCreditNote|DELETE FROM credit_notes/.test(bridge), 'Q-3 kein Fernbefehl löscht Gutschriften (PC2 erreicht den Löschweg nicht)');
  const house = src('src/core/returns/return-cancel-house.ts');
  ok(/if \(String\(inv\.status \?\? ''\) === 'CANCELLED'\) throw new ReturnCancelRejected\(RETURN_INVOICE_CANCELLED/.test(house)
    && house.indexOf('RETURN_INVOICE_CANCELLED, RETURN_INVOICE_CANCELLED_TEXT') > house.indexOf('RETURN_KEEP_CONSIGNMENT_CHANGED,')
    && house.indexOf('RETURN_INVOICE_CANCELLED, RETURN_INVOICE_CANCELLED_TEXT') < house.indexOf('revertDisposition(db, lines, disposition'),
  'Q-4 V1 steht in der Hausfolge nach den bisherigen Sperren, vor dem ersten Schreiben (Maske, PC2, Kommissionsstorno)');
  const ich = src('src/core/invoices/invoice-cancel-house.ts');
  ok(ich.indexOf("'INVOICE_HAS_PENDING_RETURN'") > 0 && ich.indexOf("'INVOICE_HAS_PENDING_RETURN'") < ich.indexOf('beforeWrite?.();'),
    'Q-5 V2 steht im Storno-Schreibweg vor dem ersten Schreiben (Primary und invoices.cancel von PC2)');
}

void [loadDebtPaymentsFor, payS, banking, analytics, backfill, executeCommand, lc, fc, money, po, geld, stand, sale, gap, TODAY, debtState, invRev, HCTX, insert, src, readFileSync, existsSync];
console.log(`\nB1 return-after-cancel: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }

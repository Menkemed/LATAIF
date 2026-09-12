// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — Retoure anlegen, Kommission verkaufen, Kommission auszahlen: dieselbe Wirkung.
// Run: node test/r5f/returns-consignment-parity.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, jeweils in ZWEI gleich gesäten Welten —
// einmal über den Anschluss der Maske am Primary (`return-house`, `consignment-finance-house`), einmal über
// den Fernbefehl mit genau dem Rumpf, den dieselbe Maske am zweiten Rechner baut:
//
//   §1 Umfang: drei geschlossen, Freigabe/Erstattung offen (sie hängen am Storno), Registry 107, Matrix 36/0/2/2.
//   §2 Retoure: später / sofort bar / Store-Guthaben / Under Repair — Kopf, Zeilen, Gutschrift, Guthaben, Bestand, Buchung.
//   §3 Verkauf (normaler Kreis, Sonderkreis, Unterdeckung) und Auszahlung (Rest, Teil, zu viel, mit Rechnung).
//   §4 Atomar: Fehler nach Kopf, Warenfolge, Erstattung, Guthaben, Buchung; nach Einkauf, Rechnung, vor Status; Auszahlung.
//   §5 Autorität: fremde Filiale/Rechnung/Zeile, Mengen, Mitarbeiter, Warenfolge, Beträge, nichts Abgeleitetes.
//   §6 EINE Domäne: Masken und Fernbefehle rufen dieselbe Folge; keine zweite Liste, keine zweite Rechnung.
// ════════════════════════════════════════════════════════════════════════════
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
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { ALLOWED_MUTATIONS } = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
const fin = await import('../../src/core/bridge/financial-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/commercial-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { eventBus } = await import('../../src/core/events/event-bus.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useOrderStore } = await import('../../src/stores/orderStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const orderRules = await import('../../src/core/orders/order-create.ts');
const orderEdit = await import('../../src/core/orders/order-edit.ts');
const purchaseHouse = await import('../../src/core/purchases/purchase-house.ts');
const purchaseRules = await import('../../src/core/purchases/purchase-create.ts');
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-12T10:00:00.000Z';
const S = (v: unknown): string => JSON.stringify(v);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function rows(db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, p)[0];
  if (!r) return [];
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])));
}
const row = (db: Db, sql: string, p: unknown[] = []): Record<string, unknown> => rows(db, sql, p)[0] ?? {};

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
  useProductStore.getState().loadCategories();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useOrderStore.getState().loadOrders();
  usePurchaseStore.getState().loadPurchases();
  useSupplierStore.getState().loadSuppliers();
}

const SEED_PRODUCTS = ['p1', 'p2', 'p3', 'p-svc', 'p-foreign'];
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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-repair-service-branch-main', 'branch-main'], ['cat-foreign', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)", [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'],
    ['cust-x', 'Fremd', 'branch-other'], ['sys-walkin', 'Walk-in', 'branch-main']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch, active] of [['sup-1', 'branch-main', 1], ['sup-gold', 'branch-main', 1], ['sup-off', 'branch-main', 0], ['sup-x', 'branch-other', 1]] as Array<[string, string, number]>) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, branch, 'Lieferant ' + id, active, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, cat, tax] of [['p1', 'branch-main', 'cat-w', 'VAT_10'], ['p2', 'branch-main', 'cat-w', 'MARGIN'],
    ['p3', 'branch-main', 'cat-w', 'ZERO'], ['p-svc', 'branch-main', 'cat-repair-service-branch-main', 'VAT_10'],
    ['p-foreign', 'branch-other', 'cat-foreign', 'MARGIN']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,?,'Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock',?,0,'[]','{}','OWN',?,?)`,
    [id, branch, cat, 'M ' + id, 'SKU-' + id, tax, NOW, NOW]);
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  insert(db, 'purchase_inbox', { id: 'inbox-1', branch_id: 'branch-main', images: '[]', note: 'Foto', status: 'open', created_at: NOW });
  insert(db, 'purchase_inbox', { id: 'inbox-x', branch_id: 'branch-other', images: '[]', note: 'Fremd', status: 'open', created_at: NOW });
  reload();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const fremd = (x: string, op: string) => ({ ...identity(x, op), branchId: 'branch-other' });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const orev = (db: Db, id: string): number => n(db, 'SELECT revision FROM orders WHERE id = ?', [id]);

/** Ein Foto, wie die Maske es als Data-URL hält — und wie die Zwischenablage es wieder hergibt. */
const foto = (seed: number): string => `data:image/jpeg;base64,${Buffer.from(Uint8Array.from({ length: 48 }, (_, i) => (seed * 31 + i * 7) & 0xff)).toString('base64')}`;
const stage = async (urls: readonly string[]): Promise<string[]> =>
  urls.map((u) => stageForTest(Uint8Array.from(Buffer.from(u.split(',')[1], 'base64')), OWNER));

interface Ausgang { ok: boolean; code: string; value?: Record<string, unknown>; replayed?: boolean }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean };
    if (o.kind === 'ok') return { ok: true, code: '', value: o.value, replayed: o.replayed };
    return { ok: false, code: o.code ?? '(ohne Code)' };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) };
  }
}
async function primary(p: () => Promise<unknown>): Promise<Ausgang> {
  try { return { ok: true, code: '', value: await p() as Record<string, unknown> }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e) }; }
}

const OHNE = /^(id|version|sync_status)$|_at$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: unknown, b: unknown, wo: string): string[] => (S(a) === S(b) ? [] : [`${wo}: ${S(a).slice(0, 300)} ≠ ${S(b).slice(0, 300)}`]);
const buchungen = (db: Db): string =>
  S(db.exec('SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction')[0]?.values ?? []);
const pid = (v: unknown): unknown => (typeof v === 'string' && SEED_PRODUCTS.includes(v) ? v : (v ? 'NEU' : v));


const ret = await import('../../src/core/bridge/return-commands.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const returnHouse = await import('../../src/core/returns/return-house.ts');
const returnRules = await import('../../src/core/returns/return-create.ts');
const conHouse = await import('../../src/core/consignment/consignment-finance-house.ts');
const conRules = await import('../../src/core/consignment/consignment-finance.ts');

type RI = import('../../src/core/returns/return-create.ts').ReturnCreateInput;
type SI = import('../../src/core/consignment/consignment-finance.ts').ConsignmentSaleInput;
type PI = import('../../src/core/consignment/consignment-finance.ts').ConsignmentPayoutInput;

const irev = (db: Db, id: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [id]);
const crev = (db: Db, id: string): number => n(db, 'SELECT revision FROM consignments WHERE id = ?', [id]);
let nth = 2000;
const nextId = (): string => String(nth++);

/** Die Welt aus R5E — plus ein Artikel mit drei Stück (fuer Teilmengen) und die Listen der Retouren/Kommissionen. */
function welt(): Db {
  const db = freshDb();
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
      scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
      tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p9','branch-main','cat-w','Omega','Nine','SKU-p9',3,'Pre-Owned','[]',100,'BHD',150,'in_stock','VAT_10',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
    VALUES ('lot-p9','branch-main','p9',100,3,3,'ACTIVE',?,?)`, [NOW, NOW]);
  useProductStore.getState().loadProducts();
  useSalesReturnStore.getState().loadReturns();
  useConsignmentStore.getState().loadConsignments();
  useCreditNoteStore.getState().loadCreditNotes();
  return db;
}

/** Eine Rechnung wie am Primary: p9 ×2 (440 brutto) + p1 ×1 (330 brutto), optional bezahlt. */
function rechnung(db: Db, bezahlt: number): { inv: string; l9: string; l1: string } {
  const inv = useInvoiceStore.getState().createDirectInvoice('cust-1', [
    { productId: 'p9', quantity: 2, unitPrice: 200, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 40, lineTotal: 440 },
    { productId: 'p1', quantity: 1, unitPrice: 300, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 30, lineTotal: 330 },
  ], 'R5F');
  if (bezahlt > 0) useInvoiceStore.getState().recordPayment(inv.id, bezahlt, 'cash');
  useInvoiceStore.getState().loadInvoices();
  return {
    inv: inv.id,
    l9: s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p9'", [inv.id]),
    l1: s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p1'", [inv.id]),
  };
}

async function retoure(weg: 'primary' | 'fern', db: Db, input: RI, x = nextId()): Promise<Ausgang> {
  return weg === 'primary'
    ? primary(() => returnHouse.createReturnOnPrimary(input))
    : fern(() => ret.runCreateReturn(deps(db), identity(x, 'returns.create'), returnRules.returnCreateBody(input, irev(db, input.invoiceId) || 1)));
}

/** Was eine Retoure im Haus hinterlässt — ohne Kennungen und Zeitpunkte. */
function bildDerRetoure(db: Db, inv: string) {
  return {
    retouren: rows(db, 'SELECT * FROM sales_returns WHERE invoice_id = ? ORDER BY return_number', [inv]).map((r) => ohne(r, ['invoice_id'])),
    zeilen: rows(db, `SELECT l.* FROM sales_return_lines l JOIN sales_returns r ON r.id = l.return_id
      WHERE r.invoice_id = ? ORDER BY r.return_number, l.product_id`, [inv]).map((l) => ohne(l, ['return_id', 'invoice_line_id'])),
    gutschriften: rows(db, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [inv]).map((c) => ohne(c, ['invoice_id', 'sales_return_id'])),
    guthaben: rows(db, "SELECT amount, used_amount, status, source_type FROM customer_credits WHERE customer_id = 'cust-1'"),
    rechnung: ohne(row(db, 'SELECT * FROM invoices WHERE id = ?', [inv])),
    bestand: rows(db, "SELECT id, quantity, stock_status FROM products WHERE id IN ('p9','p1') ORDER BY id"),
    lose: rows(db, "SELECT product_id, qty_remaining, status FROM stock_lots WHERE product_id IN ('p9','p1') ORDER BY product_id"),
    buchungen: buchungen(db),
  };
}

// ── §1 Der Umfang ───────────────────────────────────────────────────────────
{
  const vorher = ['returns.create', 'returns.approve', 'returns.refund', 'consignments.record_sale', 'consignments.record_payout'];
  const geschlossen = ['returns.create', 'consignments.record_sale', 'consignments.record_payout'];
  for (const op of vorher) ok(ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist eine VORHANDENE Buchung`);
  for (const op of geschlossen) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.paritaet === 'exakt' && z.verdrahtet && z.luecke === null, `SCOPE ${op} ist geschlossen`);
  }
  const nochB = R4C_MATRIX.filter((z) => z.luecke === 'B').map((z) => z.op).sort();
  ok(S(nochB) === S(['returns.approve', 'returns.refund']), `SCOPE offen bleiben genau Freigabe und Erstattung (${nochB.join(', ')})`);
  for (const op of ['returns.approve', 'returns.refund']) {
    ok(/invoices\.cancel/.test(R4C_MATRIX.find((x) => x.op === op)!.grund), `SCOPE ${op}: der Grund nennt die fehlende Buchung (Storno)`);
  }
  ok(ALLOWED_MUTATIONS.length === 40 && !ALLOWED_MUTATIONS.includes('invoices.cancel'), `SCOPE keine neue Buchung (${ALLOWED_MUTATIONS.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 107 && !/invoices\.cancel/.test(rust), `SCOPE die Registry bleibt bei 107 (${rustOps})`);
  const stand = [R4C_MATRIX.filter((z) => z.verdrahtet).length, R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.luecke === 'B').length, R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length];
  ok(S(stand) === S([36, 0, 2, 2]), `SCOPE die Matrix steht bei 36/0/2/2 (${stand.join('/')})`);
  for (const op of ['returns.record_refund_payment', 'consignments.update', 'consignments.mark_returned', 'invoices.record_payment']) {
    ok(!!R4C_MATRIX.find((x) => x.op === op)?.verdrahtet, `SCOPE Nachbar ${op} bleibt verdrahtet`);
  }
  // Freigabe und Erstattung: ihr einziger eigener Einstieg ist der Rechnungsstorno — der bleibt am
  // Primary (Status CANCELLED setzt keine der 40 Buchungen), wie vor R5F.
  const idc = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  const storno = /function handleCancelInvoice\(\) \{[\s\S]*?\n {2}\}/.exec(idc)?.[0] ?? '';
  ok(/\.approveReturn\(ret\.id\)/.test(storno) && /\.refundReturn\(ret\.id\)/.test(storno) && /updateInvoice\(id, \{ status: 'CANCELLED' \}\)/.test(storno),
    'SCOPE der Storno ruft Freigabe + Erstattung + Status CANCELLED — ein Vorgang, den keine vorhandene Buchung traegt');
  ok(!/'returns\.(approve|refund)'/.test(idc), 'SCOPE …und er wird nicht heimlich halb ueber den Fernweg gerufen');
}

// ── §2 Retoure anlegen: dieselbe Wirkung auf beiden Wegen ─────────────────
const RFAELLE: Array<[string, number, (r: { inv: string; l9: string; l1: string }) => RI]> = [
  ['spaeter erstatten, Mitarbeiter, Grund wie getippt', 770, (r) => ({
    invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK',
    reason: '  defekt  ', notes: 'Kiste fehlt', staffId: 'emp-1', refundNow: false,
  })],
  ['sofort bar', 770, (r) => ({
    invoiceId: r.inv, lines: [{ invoiceLineId: r.l1, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: true,
  })],
  ['Store-Guthaben (immer sofort)', 770, (r) => ({
    invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 2 }], refundMethod: 'credit', productDisposition: 'IN_STOCK', refundNow: false,
  })],
  ['Under Repair, teilbezahlt, sofort Bank', 300, (r) => ({
    invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'bank', productDisposition: 'UNDER_REPAIR', refundNow: true,
  })],
];
for (const [was, bezahlt, bau] of RFAELLE) {
  let db = welt();
  let r = rechnung(db, bezahlt);
  const p = await retoure('primary', db, bau(r));
  const bildP = bildDerRetoure(db, r.inv);
  db = welt();
  r = rechnung(db, bezahlt);
  const input = bau(r);
  const body = returnRules.returnCreateBody(input, irev(db, r.inv));
  ok(!('unitPrice' in (body.lines as Array<Record<string, unknown>>)[0]) && !('refundAmount' in body), `RETURN ${was}: der Rumpf traegt keinen Preis und keinen Betrag`);
  const x = nextId();
  const f = await retoure('fern', db, input, x);
  const bildF = bildDerRetoure(db, r.inv);
  ok(p.ok && f.ok, `RETURN ${was}: beide Wege legen an (${p.code || 'ok'} / ${f.code || 'ok'})`);
  const diff = Object.keys(bildP).flatMap((k) => unterschiede((bildP as Record<string, unknown>)[k], (bildF as Record<string, unknown>)[k], k));
  ok(diff.length === 0, `RETURN ${was}: lokal == fern (${diff.join(' · ') || 'gleich'})`);
  const vor = S([n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM credit_notes'), buchungen(db)]);
  const again = await retoure('fern', db, input, x);
  ok(again.ok && again.replayed === true && S([n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM credit_notes'), buchungen(db)]) === vor,
    `RETURN ${was}: die Wiederholung ist eine Wiederholung — keine zweite Retoure, Gutschrift oder Buchung`);
  const k = bildF.retouren[0] ?? {};
  if (was.startsWith('spaeter')) {
    ok(k.staff_id === 'emp-1' && k.reason === '  defekt  ' && k.status === 'REQUESTED' && k.refund_status === 'PENDING_REFUND' && bildF.gutschriften.length === 0,
      `RETURN spaeter: Mitarbeiter, Grund wie getippt, offen, noch keine Gutschrift (${S([k.staff_id, k.reason, k.status, k.refund_status])})`);
    ok(bildF.bestand[1].quantity === 2, `RETURN spaeter: die Ware ist sofort zurueck im Bestand (${S(bildF.bestand)})`);
  } else if (was.startsWith('sofort')) {
    ok(k.status === 'REFUNDED' && Number(k.refund_paid_amount) === 330 && bildF.gutschriften.length === 1,
      `RETURN sofort: genehmigt, Gutschrift, 330 erstattet (${S([k.status, k.refund_paid_amount])})`);
  } else if (was.startsWith('Store')) {
    ok(k.refund_status === 'REFUNDED' && bildF.guthaben.length === 1 && Number(bildF.guthaben[0].amount) === 440,
      `RETURN Guthaben: sofort, als einloesbares Guthaben 440 (${S(bildF.guthaben)})`);
  } else {
    ok(bildF.bestand[1].stock_status === 'in_repair' && k.status === 'REFUNDED' && Number(k.refund_paid_amount) === 0,
      `RETURN Under Repair: Ware in Reparatur, kein Geld zurueck (Kunde schuldet noch) — die Gutschrift kuerzt die Forderung (${S([bildF.bestand[1], k.status, k.refund_paid_amount])})`);
  }
}

// ── §3 Kommission verkaufen und auszahlen: dieselbe Wirkung auf beiden Wegen ─
const CONSIGN = { consignorId: 'cust-1', product: { brand: 'Patek', name: 'Nautilus', categoryId: 'cat-w' }, agreedPrice: 1000,
  payout: { model: 'percent', commissionRate: 20 } };
const FIXED = { ...CONSIGN, payout: { model: 'consignor_fixed' } };
async function kommission(db: Db, body: Record<string, unknown> = CONSIGN): Promise<string> {
  const c = await cmd.runConsignmentCreate(deps(db), identity(nextId(), 'consignments.create'), body);
  useConsignmentStore.getState().loadConsignments();
  return String((c as { value?: { consignmentId?: string } }).value?.consignmentId ?? '');
}
async function verkauf(weg: 'primary' | 'fern', db: Db, cid: string, input: SI, x = nextId()): Promise<Ausgang> {
  return weg === 'primary'
    ? primary(() => conHouse.recordConsignmentSaleOnPrimary(cid, input))
    : fern(() => life.runRecordSale(deps(db), identity(x, 'consignments.record_sale'), conRules.consignmentSaleBody(cid, crev(db, cid) || 1, input)));
}
async function auszahlung(weg: 'primary' | 'fern', db: Db, cid: string, input: PI, x = nextId()): Promise<Ausgang> {
  return weg === 'primary'
    ? primary(() => conHouse.payOutConsignmentOnPrimary(cid, input))
    : fern(() => fin.runRecordPayout(deps(db), identity(x, 'consignments.record_payout'), conRules.consignmentPayoutBody(cid, crev(db, cid) || 1, input)));
}
function bildDesVerkaufs(db: Db, cid: string) {
  const k = row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]);
  const inv = String(k.invoice_id ?? '');
  return {
    kommission: { ...ohne(k, ['invoice_id', 'product_id']), hatRechnung: inv !== '' },
    rechnung: inv ? ohne(row(db, 'SELECT * FROM invoices WHERE id = ?', [inv]), ['customer_id']) : null,
    einkauf: rows(db, 'SELECT purchase_number, status, total_amount, paid_amount, notes FROM purchases ORDER BY purchase_number'),
    ausgaben: rows(db, 'SELECT category, amount, status FROM expenses ORDER BY category'),
    produkt: ohne(row(db, 'SELECT * FROM products WHERE id = ?', [String(k.product_id ?? '')]), ['sku']),
    buchungen: buchungen(db),
  };
}
const SFAELLE: Array<[string, Record<string, unknown>, SI]> = [
  ['normaler Kreis', CONSIGN, { salePrice: 1200, buyerId: 'cust-2', saleDate: '2026-09-12', notes: '  bar  ', acknowledgeShortfall: false, specialMark: false }],
  ['Sonderkreis (Nummerndialog)', CONSIGN, { salePrice: 1200, buyerId: 'cust-2', saleDate: '2026-09-12', acknowledgeShortfall: false, specialMark: true }],
  ['unter dem Boden, bestaetigt', FIXED, { salePrice: 800, buyerId: 'cust-2', saleDate: '2026-09-12', acknowledgeShortfall: true, specialMark: false }],
];
for (const [was, kbody, input] of SFAELLE) {
  let db = welt();
  let cid = await kommission(db, kbody);
  const p = await verkauf('primary', db, cid, input);
  const bildP = bildDesVerkaufs(db, cid);
  db = welt();
  cid = await kommission(db, kbody);
  const x = nextId();
  const f = await verkauf('fern', db, cid, input, x);
  const bildF = bildDesVerkaufs(db, cid);
  ok(p.ok && f.ok, `SALE ${was}: beide Wege verkaufen (${p.code || 'ok'} / ${f.code || 'ok'})`);
  const diff = Object.keys(bildP).flatMap((k) => unterschiede((bildP as Record<string, unknown>)[k], (bildF as Record<string, unknown>)[k], k));
  ok(diff.length === 0, `SALE ${was}: lokal == fern (${diff.join(' · ') || 'gleich'})`);
  const vor = S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM purchases'), buchungen(db)]);
  const again = await verkauf('fern', db, cid, input, x);
  ok(again.ok && again.replayed === true && S([n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM purchases'), buchungen(db)]) === vor,
    `SALE ${was}: die Wiederholung verkauft nicht zweimal`);
  const r = bildF.rechnung as Record<string, unknown> | null;
  ok(bildF.kommission.status === 'sold' && bildF.kommission.hatRechnung && Number(r?.special_mark ?? -1) === (input.specialMark ? 1 : 0),
    `SALE ${was}: verkauft, mit Rechnung im gewaehlten Kreis (special_mark ${String(r?.special_mark)})`);
  if (was.startsWith('unter')) {
    ok(bildF.ausgaben.some((e) => e.category === 'ConsignorLoss' && Number(e.amount) === 200), `SALE Unterdeckung: Verlust-Ausgabe 200 (${S(bildF.ausgaben)})`);
  }
}
{
  // Auszahlung eines Verkaufs ohne Rechnung (der Weg, den die Masken anbieten).
  const altVerkauf = async (db: Db): Promise<string> => {
    const cid = await kommission(db);
    useConsignmentStore.getState().loadConsignments();
    useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
    return cid;
  };
  const paar = async (was: string, input: (open: number) => PI, pruef: (k: Record<string, unknown>) => boolean) => {
    let db = welt();
    let cid = await altVerkauf(db);
    const open = conRules.payoutOpenAmount({ payoutAmount: n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]), payoutPaidAmount: 0 });
    const p = await auszahlung('primary', db, cid, input(open));
    const kp = ohne(row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]), ['product_id']);
    const bp = buchungen(db);
    db = welt();
    cid = await altVerkauf(db);
    const x = nextId();
    const f = await auszahlung('fern', db, cid, input(open), x);
    const kf = ohne(row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]), ['product_id']);
    ok(p.ok && f.ok && S(kp) === S(kf) && bp === buchungen(db), `PAYOUT ${was}: lokal == fern (${p.code || 'ok'} / ${f.code || 'ok'} · ${unterschiede(kp, kf, 'K').join(' ') || 'gleich'})`);
    ok(pruef(kf), `PAYOUT ${was}: ${S([kf.status, kf.payout_status, kf.payout_paid_amount])}`);
    const again = await auszahlung('fern', db, cid, input(open), x);
    ok(again.ok && again.replayed === true && S(ohne(row(db, 'SELECT * FROM consignments WHERE id = ?', [cid]), ['product_id'])) === S(kf) && buchungen(db) === bp,
      `PAYOUT ${was}: die Wiederholung zahlt nicht zweimal`);
    return { db, cid };
  };
  const voll = await paar('der ganze Rest (Maske), Bank Transfer', (open) => ({ amount: open, method: 'bank_transfer', reference: '  R-1  ' }),
    (k) => k.status === 'paid_out' && k.payout_status === 'paid' && Number(k.payout_paid_amount) === Number(k.payout_amount) && k.payout_reference === '  R-1  ');
  ok(/BANK/.test(buchungen(voll.db)) && /EXPENSES_OPERATING/.test(buchungen(voll.db)), 'PAYOUT die Buchung: Aufwand an Bank');
  const teil = await paar('ein Teil (Befehl), bar', () => ({ amount: 100, method: 'cash' }),
    (k) => k.status === 'sold' && k.payout_status === 'partial' && Number(k.payout_paid_amount) === 100);
  // Der Rest schliesst — erst bei null.
  const rest = conRules.payoutOpenAmount({ payoutAmount: n(teil.db, 'SELECT payout_amount FROM consignments WHERE id = ?', [teil.cid]), payoutPaidAmount: 100 });
  const zu = await auszahlung('fern', teil.db, teil.cid, { amount: rest + 1, method: 'cash' });
  const zuP = await auszahlung('primary', teil.db, teil.cid, { amount: rest + 1, method: 'cash' });
  ok(zu.code === 'PAYOUT_EXCEEDS_OPEN' && zuP.code === 'PAYOUT_EXCEEDS_OPEN' && n(teil.db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [teil.cid]) === 100,
    `PAYOUT mehr als offen ist auf beiden Wegen ein Nein (${zu.code} / ${zuP.code})`);
  const schluss = await auszahlung('primary', teil.db, teil.cid, { amount: rest, method: 'cash' });
  ok(schluss.ok && s(teil.db, 'SELECT status FROM consignments WHERE id = ?', [teil.cid]) === 'paid_out', 'PAYOUT der Rest schliesst — „paid_out" erst bei null');
  const noch = await auszahlung('fern', teil.db, teil.cid, { amount: 1, method: 'cash' });
  ok(noch.code === 'ALREADY_PAID_OUT', `PAYOUT danach ist nichts mehr offen (${noch.code})`);
  // Mit Rechnung zahlt der Einkauf beim Einlieferer — die Maske bietet „Pay Out" dort nicht an.
  const db = welt();
  const cid = await kommission(db);
  await verkauf('primary', db, cid, SFAELLE[0][2]);
  const open = conRules.payoutOpenAmount({ payoutAmount: n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]), payoutPaidAmount: 0 });
  const viaF = await auszahlung('fern', db, cid, { amount: open, method: 'cash' });
  const viaP = await auszahlung('primary', db, cid, { amount: open, method: 'cash' });
  ok(viaF.code === 'PAYOUT_VIA_PURCHASE' && viaP.code === 'PAYOUT_VIA_PURCHASE' && n(db, 'SELECT payout_paid_amount FROM consignments WHERE id = ?', [cid]) === 0,
    `PAYOUT ein Verkauf mit Rechnung wird hier nicht ausgezahlt (${viaF.code} / ${viaP.code})`);
  for (const [m, soll] of [['card', true], ['bank', true], ['benefit', true], ['wire', false]] as Array<[string, boolean]>) {
    let geht = true;
    try { fin.parseRecordPayout({ consignmentId: 'c', amount: 1, method: m, expectedRevision: 1 }); } catch { geht = false; }
    ok(geht === soll, `PAYOUT der Weg ${m} ${soll ? 'steht auf der EINEN Liste' : 'ist ein Nein'}`);
  }
}

// ── §4 Atomar: nichts bleibt halb ───────────────────────────────────────────
async function bruch(was: string, weg: 'primary' | 'fern', aufbau: () => Promise<{ db: Db; lauf: (x: string) => Promise<Ausgang> }>,
  trigger: string, zaehler: (db: Db) => string): Promise<void> {
  const { db, lauf } = await aufbau();
  const x = nextId();
  const vor = zaehler(db);
  db.run(`CREATE TRIGGER r5f_bruch ${trigger} BEGIN SELECT RAISE(ABORT, 'R5F: injected'); END`);
  let aus: Ausgang;
  try { aus = await lauf(x); } finally { db.run('DROP TRIGGER IF EXISTS r5f_bruch'); }
  const nach = zaehler(db);
  const heil = await lauf(x);
  ok(!aus.ok && vor === nach, `ATOMIC ${was} ${weg}: nichts bleibt (${aus.code.slice(0, 70)})`);
  ok(heil.ok, `ATOMIC ${was} ${weg}: danach gelingt es mit derselben Kennung (${heil.code || 'ok'})`);
}
{
  const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM sales_return_lines'),
    n(db, 'SELECT COUNT(*) FROM credit_notes'), n(db, 'SELECT COUNT(*) FROM customer_credits'), n(db, 'SELECT COUNT(*) FROM ledger_entries'),
    rows(db, "SELECT quantity, stock_status FROM products WHERE id IN ('p9','p1') ORDER BY id"),
    rows(db, "SELECT qty_remaining FROM stock_lots WHERE product_id IN ('p9','p1') ORDER BY product_id"),
    rows(db, 'SELECT status, vat_amount, paid_amount, revision FROM invoices')]);
  const aufbau = (weg: 'primary' | 'fern', methode: 'cash' | 'credit') => async () => {
    const db = welt();
    const r = rechnung(db, 770);
    const input: RI = { invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: methode, productDisposition: 'IN_STOCK', refundNow: true };
    return { db, lauf: (x: string) => retoure(weg, db, input, x) };
  };
  const punkte: Array<[string, 'cash' | 'credit', string]> = [
    ['nach dem Kopf', 'cash', 'BEFORE INSERT ON sales_return_lines'],
    ['nach der Warenfolge (Bestand zurueck, Gutschrift)', 'cash', 'BEFORE INSERT ON credit_notes'],
    ['nach der Erstattung', 'cash', 'BEFORE UPDATE OF refund_paid_amount ON sales_returns'],
    ['beim Guthaben', 'credit', 'BEFORE INSERT ON customer_credits'],
    ['vor dem Abschluss der Buchung (abgefangener Post)', 'cash', "BEFORE INSERT ON ledger_entries WHEN NEW.source_module = 'CREDIT_NOTE'"],
  ];
  for (const [was, methode, trigger] of punkte) {
    for (const weg of ['primary', 'fern'] as const) await bruch(`RETURN ${was}`, weg, aufbau(weg, methode), trigger, zaehler);
  }
}
{
  const zaehler = (db: Db): string => S([n(db, 'SELECT COUNT(*) FROM purchases'), n(db, 'SELECT COUNT(*) FROM stock_lots'),
    n(db, 'SELECT COUNT(*) FROM invoices'), n(db, 'SELECT COUNT(*) FROM invoice_lines'), n(db, 'SELECT COUNT(*) FROM expenses'),
    n(db, 'SELECT COUNT(*) FROM ledger_entries'), rows(db, 'SELECT status, invoice_id, payout_amount, revision FROM consignments'),
    rows(db, "SELECT quantity, stock_status, purchase_price FROM products WHERE source_type = 'CONSIGNMENT'")]);
  const aufbau = (weg: 'primary' | 'fern', kbody: Record<string, unknown>, input: SI) => async () => {
    const db = welt();
    const cid = await kommission(db, kbody);
    return { db, lauf: (x: string) => verkauf(weg, db, cid, input, x) };
  };
  const punkte: Array<[string, Record<string, unknown>, SI, string]> = [
    ['nach dem Einkauf', CONSIGN, SFAELLE[1][2], 'BEFORE INSERT ON invoices'],
    ['nach der Rechnung (Verlust-Ausgabe)', FIXED, SFAELLE[2][2], 'BEFORE INSERT ON expenses'],
    ['vor dem Status', CONSIGN, SFAELLE[0][2], 'BEFORE UPDATE OF status ON consignments'],
    ['bei der Buchung der Rechnung', CONSIGN, SFAELLE[0][2], "BEFORE INSERT ON ledger_entries WHEN NEW.source_module = 'INVOICE'"],
  ];
  for (const [was, kbody, input, trigger] of punkte) {
    for (const weg of ['primary', 'fern'] as const) await bruch(`SALE ${was}`, weg, aufbau(weg, kbody, input), trigger, zaehler);
  }
}
{
  const zaehler = (db: Db): string => S([rows(db, 'SELECT status, payout_status, payout_paid_amount, payout_method, revision FROM consignments'),
    n(db, 'SELECT COUNT(*) FROM ledger_entries')]);
  const aufbau = (weg: 'primary' | 'fern') => async () => {
    const db = welt();
    const cid = await kommission(db);
    useConsignmentStore.getState().loadConsignments();
    useConsignmentStore.getState().markSold(cid, 1200, undefined, 'cash');
    const open = conRules.payoutOpenAmount({ payoutAmount: n(db, 'SELECT payout_amount FROM consignments WHERE id = ?', [cid]), payoutPaidAmount: 0 });
    return { db, lauf: (x: string) => auszahlung(weg, db, cid, { amount: open, method: 'cash' }, x) };
  };
  const punkte: Array<[string, string]> = [
    ['am Auszahlungsstand', 'BEFORE UPDATE OF payout_paid_amount ON consignments'],
    ['bei der Buchung (abgefangener Post)', "BEFORE INSERT ON ledger_entries WHEN NEW.source_module = 'CONSIGNMENT_PAYOUT'"],
  ];
  for (const [was, trigger] of punkte) {
    for (const weg of ['primary', 'fern'] as const) await bruch(`PAYOUT ${was}`, weg, aufbau(weg), trigger, zaehler);
  }
}

// ── §5 Autoritaet: der Primary entscheidet ─────────────────────────────────
{
  const beide = async (was: string, bau: (db: Db, r: { inv: string; l9: string; l1: string }) => RI | Promise<RI>, code: string, bezahlt = 770) => {
    for (const weg of ['primary', 'fern'] as const) {
      const db = welt();
      const r = rechnung(db, bezahlt);
      const input = await bau(db, r);
      const vor = n(db, 'SELECT COUNT(*) FROM sales_returns');
      const aus = await retoure(weg, db, input);
      ok(!aus.ok && aus.code === code && n(db, 'SELECT COUNT(*) FROM sales_returns') === vor, `AUTH RETURN ${was} (${weg}: ${aus.code})`);
    }
  };
  const basis = (r: { inv: string; l9: string }): RI => ({ invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false });
  await beide('eine unbekannte Rechnung', (_db, r) => ({ ...basis(r), invoiceId: 'gibt-es-nicht' }), 'INVOICE_NOT_FOUND');
  await beide('eine Zeile einer anderen Rechnung', (db, r) => {
    const andere = useInvoiceStore.getState().createDirectInvoice('cust-1', [
      { productId: 'p2', quantity: 1, unitPrice: 300, purchasePrice: 100, taxScheme: 'MARGIN', vatRate: 10, vatAmount: 0, lineTotal: 300 },
    ], 'R5F-2');
    return { ...basis(r), lines: [{ invoiceLineId: s(db, 'SELECT id FROM invoice_lines WHERE invoice_id = ?', [andere.id]), quantity: 1 }] };
  }, 'RETURN_LINE_NOT_ON_INVOICE');
  await beide('mehr Stueck als verkauft', (_db, r) => ({ ...basis(r), lines: [{ invoiceLineId: r.l9, quantity: 3 }] }), 'RETURN_QUANTITY_EXCEEDED');
  await beide('eine schon ganz zurueckgenommene Zeile', async (_db, r) => {
    await returnHouse.createReturnOnPrimary({ ...basis(r), lines: [{ invoiceLineId: r.l9, quantity: 2 }] });
    return basis(r);
  }, 'RETURN_QUANTITY_EXCEEDED');
  await beide('ein Mitarbeiter einer fremden Filiale', (_db, r) => ({ ...basis(r), staffId: 'emp-x' }), 'EMPLOYEE_NOT_FOUND');
  await beide('ein ausgeschiedener Mitarbeiter', (_db, r) => ({ ...basis(r), staffId: 'emp-gone' }), 'EMPLOYEE_NOT_FOUND');
  await beide('zweimal dieselbe Zeile (umginge den Deckel)', (_db, r) => ({ ...basis(r), lines: [{ invoiceLineId: r.l9, quantity: 2 }, { invoiceLineId: r.l9, quantity: 2 }] }), 'INVALID_INPUT');
  await beide('„Return to Owner" fuer eigene Ware', (_db, r) => ({ ...basis(r), productDisposition: 'RETURN_TO_OWNER' }), 'DISPOSITION_NOT_ALLOWED');
  await beide('eine stornierte Rechnung', (db, r) => { db.run("UPDATE invoices SET status = 'CANCELLED' WHERE id = ?", [r.inv]); return basis(r); }, 'INVOICE_CANCELLED');
  await beide('eine Rechnung, die die Maske nicht anbietet (Entwurf)', (db, r) => { db.run("UPDATE invoices SET status = 'DRAFT' WHERE id = ?", [r.inv]); return basis(r); }, 'INVOICE_NOT_RETURNABLE');
  {
    const db = welt();
    const r = rechnung(db, 770);
    const aus = await fern(() => ret.runCreateReturn(deps(db), fremd(nextId(), 'returns.create'), returnRules.returnCreateBody(basis(r), irev(db, r.inv))));
    ok(!aus.ok && aus.code === 'INVOICE_NOT_FOUND' && n(db, 'SELECT COUNT(*) FROM sales_returns') === 0, `AUTH RETURN ein Ausweis einer fremden Filiale (${aus.code})`);
  }
  for (const [was, extra] of [['einen Preis', { unitPrice: 1 }], ['einen Erstattungsbetrag', { refundAmount: 1 }], ['eine Gutschrift', { creditNoteId: 'cn' }],
    ['ein Guthaben', { creditAmount: 5 }], ['eine Buchung', { ledger: [] }], ['einen Status', { status: 'REFUNDED' }]] as Array<[string, Record<string, unknown>]>) {
    let threw = false;
    try { ret.parseCreateReturn({ invoiceId: 'i', expectedRevision: 1, lines: [{ invoiceLineId: 'l', quantity: 1 }], ...extra }); } catch { threw = true; }
    ok(threw, `AUTH RETURN der Rumpf setzt ${was} nicht`);
  }
  let zeilenPreis = false;
  try { ret.parseCreateReturn({ invoiceId: 'i', expectedRevision: 1, lines: [{ invoiceLineId: 'l', quantity: 1, unitPrice: 5 }] }); } catch { zeilenPreis = true; }
  ok(zeilenPreis, 'AUTH RETURN …auch nicht an der Zeile');
}
{
  const beide = async (was: string, bau: (db: Db, cid: string) => Promise<{ cid: string; input: SI }>, code: string) => {
    for (const weg of ['primary', 'fern'] as const) {
      const db = welt();
      const cid0 = await kommission(db);
      const { cid, input } = await bau(db, cid0);
      const vor = n(db, 'SELECT COUNT(*) FROM invoices');
      const aus = await verkauf(weg, db, cid, input);
      ok(!aus.ok && aus.code === code && n(db, 'SELECT COUNT(*) FROM invoices') === vor, `AUTH SALE ${was} (${weg}: ${aus.code})`);
    }
  };
  const S0 = SFAELLE[0][2];
  await beide('eine unbekannte Kommission', async () => ({ cid: 'gibt-es-nicht', input: S0 }), 'CONSIGNMENT_NOT_FOUND');
  await beide('eine schon verkaufte', async (_db, cid) => { await conHouse.recordConsignmentSaleOnPrimary(cid, S0); return { cid, input: S0 }; }, 'CONSIGNMENT_NOT_ACTIVE');
  await beide('eine zurueckgegebene', async (_db, cid) => { useConsignmentStore.getState().markReturned(cid); return { cid, input: S0 }; }, 'CONSIGNMENT_NOT_ACTIVE');
  await beide('ein Kaeufer einer fremden Filiale', async (_db, cid) => ({ cid, input: { ...S0, buyerId: 'cust-x' } }), 'BUYER_NOT_FOUND');
  await beide('der Einlieferer als Kaeufer', async (_db, cid) => ({ cid, input: { ...S0, buyerId: 'cust-1' } }), 'BUYER_IS_CONSIGNOR');
  await beide('unter dem Boden ohne Bestaetigung', async (db) => ({ cid: await kommission(db, { ...FIXED, product: { ...FIXED.product, name: "Aquanaut" } }), input: { ...S0, salePrice: 800 } }), 'SALE_BELOW_FLOOR');
  {
    const db = welt();
    const cid = await kommission(db);
    const aus = await fern(() => life.runRecordSale(deps(db), fremd(nextId(), 'consignments.record_sale'), conRules.consignmentSaleBody(cid, crev(db, cid), S0)));
    ok(!aus.ok && aus.code === 'CONSIGNMENT_NOT_FOUND', `AUTH SALE ein Ausweis einer fremden Filiale (${aus.code})`);
    const pay = await fern(() => fin.runRecordPayout(deps(db), fremd(nextId(), 'consignments.record_payout'), { consignmentId: cid, amount: 1, method: 'cash', expectedRevision: crev(db, cid) }));
    ok(!pay.ok && pay.code === 'CONSIGNMENT_NOT_FOUND', `AUTH PAYOUT ein Ausweis einer fremden Filiale (${pay.code})`);
    const neg = await auszahlung('primary', db, cid, { amount: -5, method: 'cash' });
    ok(neg.code === 'INVALID_AMOUNT', `AUTH PAYOUT ein negativer Betrag ist am Primary ein Nein (${neg.code})`);
  }
  for (const [was, extra, parse] of [
    ['eine Provision', { commissionAmount: 1 }, life.parseRecordSale], ['einen Auszahlungsbetrag', { payoutAmount: 1 }, life.parseRecordSale],
    ['eine Rechnung', { invoiceId: 'i' }, life.parseRecordSale], ['einen Sonderkreis als Text', { specialMark: 'ja' }, life.parseRecordSale],
  ] as Array<[string, Record<string, unknown>, (r: unknown) => unknown]>) {
    let threw = false;
    try { parse({ consignmentId: 'c', buyerId: 'b', salePrice: 1, expectedRevision: 1, ...extra }); } catch { threw = true; }
    ok(threw, `AUTH SALE der Rumpf setzt ${was} nicht`);
  }
  for (const [was, extra] of [['einen negativen Betrag', { amount: -5 }], ['einen Auszahlungsstand', { payoutStatus: 'paid' }],
    ['einen offenen Rest', { payoutOpenAmount: 0 }], ['eine Buchung', { ledger: [] }]] as Array<[string, Record<string, unknown>]>) {
    let threw = false;
    try { fin.parseRecordPayout({ consignmentId: 'c', amount: 5, method: 'cash', expectedRevision: 1, ...extra }); } catch { threw = true; }
    ok(threw, `AUTH PAYOUT der Rumpf setzt ${was} nicht`);
  }
}

// ── §6 EINE Domaene ─────────────────────────────────────────────────────────
{
  const idc = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  const anlegen = /async function handleCreateSalesReturn\(\) \{[\s\S]*?\n {2}\}/.exec(idc)?.[0] ?? '';
  ok(/returnCreateInput\(/.test(anlegen) && /createReturnOnPrimary\(/.test(anlegen) && /returnCreateBody\(/.test(anlegen)
    && (anlegen.match(/w\.(ok|save)\(/g) ?? []).length === 1 && !/createReturn\(|refundReturn\(|returnLineAmounts\(/.test(anlegen),
  'DOMAIN die Retourenmaske schickt Eingaben ueber GENAU eine Buchung — keine Preisrechnung, kein Nacheinander');
  for (const f of ['src/pages/consignments/ConsignmentDetail.tsx', 'src/pages/consignments/ConsignmentList.tsx']) {
    const c = codeOf(src(f));
    ok(!/\brecordSale\(|\bmarkPaidOut\(/.test(c) && /recordConsignmentSaleOnPrimary\(/.test(c) && /payOutConsignmentOnPrimary\(/.test(c)
      && /CONSIGNMENT_PAYOUT_METHODS\.map/.test(c) && !/\['bank_transfer', 'cash', 'card', 'benefit'\]/.test(c),
    `DOMAIN ${f.split('/').pop()}: Verkauf und Auszahlung ueber die Hausfolge, die Wege aus EINER Liste`);
  }
  const rc = codeOf(src('src/core/bridge/return-commands.ts'));
  ok(/createReturnInHouse\(/.test(rc) && !/\.createReturn\(/.test(rc) && !/returnLineAmounts/.test(rc), 'DOMAIN der Fernbefehl ruft dieselbe Folge — keine zweite Preis- oder Rueckgaberechnung');
  const lc = codeOf(src('src/core/bridge/lifecycle-commands.ts'));
  ok(/recordConsignmentSaleInHouse\(/.test(lc) && !/\.recordSale\(/.test(lc), 'DOMAIN der Fernverkauf ruft dieselbe Folge');
  const fc = codeOf(src('src/core/bridge/financial-commands.ts'));
  ok(/payOutConsignmentInHouse\(/.test(fc) && !/recordPartialPayout\(/.test(fc) && !/PAYOUT_METHODS = \[/.test(fc), 'DOMAIN die Fernauszahlung ruft dieselbe Folge — keine zweite Wegeliste');
  const rh = codeOf(src('src/core/returns/return-house.ts'));
  ok(/returnLineAmounts\(/.test(rh) && /\.createReturn\(/.test(rh) && /\.refundReturn\(/.test(rh) && !/computeRefundSplit|postCreditNote|postSalesReturnCogs/.test(rh),
    'DOMAIN die Hausfolge baut keine Erstattungs-, Gutschrift- oder Buchungsrechnung nach — sie ruft den Store');
  const ch = codeOf(src('src/core/consignment/consignment-finance-house.ts'));
  ok(/\.recordSale\(/.test(ch) && /\.recordPartialPayout\(/.test(ch) && !/computeConsignmentSale|postConsignmentPayout/.test(ch),
    'DOMAIN …ebenso Verkauf und Auszahlung (Anteil, Auszahlung, Buchung bleiben im Store)');
  ok(/watchLedgerPosts\('return'\)/.test(rh) && /watchLedgerPosts\('consignment sale'\)/.test(ch) && /watchLedgerPosts\('consignment payout'\)/.test(ch),
    'DOMAIN jede der drei Folgen bricht ab, wenn darin eine Buchung scheitert — auch eine abgefangene');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5f returns + consignment finance: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5F_SCOPE_FROZEN');
console.log('CENTRAL_UI_R5F_RETURN_CREATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F_RETURN_APPROVE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F_RETURN_REFUND_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F_CONSIGNMENT_SALE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F_CONSIGNMENT_PAYOUT_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F_SHARED_FINANCIAL_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5F_RETURN_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5F_CONSIGNMENT_FINANCE_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5F_INPUT_AUTHORITY_PROVED');

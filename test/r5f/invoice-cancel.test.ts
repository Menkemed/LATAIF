// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F.1 — der Rechnungsstorno als EINE Buchung, und die letzte Einordnung der Retoure.
// Run: node test/r5f/invoice-cancel.test.ts
//
//   §1 Freigabe/Erstattung: kein eigener Knopf (vor und nach R5F) → „ohne Handlung", Matrix 36/0/0/4.
//   §2 Entscheidung: invoices.cancel ist die EINE neue Buchung (Registry 108), nichts sonst.
//   §3 Wirkung lokal == fern: mit Geld, ohne Geld, nach einer Teilretoure; Wiederholung ohne zweite Wirkung.
//   §4 Regeln: endgültig/zurückgegeben/storniert/unbekannt/alte Fassung/fremde Filiale.
//   §5 Atomar: Fehler an sechs Stellen × zwei Wege — nichts bleibt halb.
//   §6 Der Mitarbeiter einer neuen Retoure beginnt frisch.  §7 Die R5F-Verträge gegen 0e522bf.
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

const { readdirSync } = await import('node:fs');
const { execSync } = await import('node:child_process');
const cancelCmd = await import('../../src/core/bridge/invoice-cancel-command.ts');
const cancelHouse = await import('../../src/core/invoices/invoice-cancel-house.ts');
const cancelRules = await import('../../src/core/invoices/invoice-cancel.ts');
const returnHouse = await import('../../src/core/returns/return-house.ts');
const { OPERATION_PERMISSIONS } = await import('../../src/core/bridge/command-permissions.ts');
const { useSalesReturnStore } = await import('../../src/stores/salesReturnStore.ts');
const { useCreditNoteStore } = await import('../../src/stores/creditNoteStore.ts');
const { R5F1_NEUE_BUCHUNGEN } = await import('../uiparity/_r4c-write-matrix.ts');

const irev = (db: Db, id: string): number => n(db, 'SELECT revision FROM invoices WHERE id = ?', [id]);
let nth = 3000;
const nextId = (): string => String(nth++);
const vor5f = (p: string): string => execSync(`git show 0e522bf:${p}`, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

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
  useCreditNoteStore.getState().loadCreditNotes();
  return db;
}
/** p9 ×2 (440 brutto) + p1 ×1 (330 brutto) = 770, optional (teil)bezahlt. */
function rechnung(db: Db, bezahlt: number): { inv: string; l9: string; l1: string } {
  const inv = useInvoiceStore.getState().createDirectInvoice('cust-1', [
    { productId: 'p9', quantity: 2, unitPrice: 200, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 40, lineTotal: 440 },
    { productId: 'p1', quantity: 1, unitPrice: 300, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 30, lineTotal: 330 },
  ], 'R5F1');
  if (bezahlt > 0) useInvoiceStore.getState().recordPayment(inv.id, bezahlt, 'cash');
  useInvoiceStore.getState().loadInvoices();
  return {
    inv: inv.id,
    l9: s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p9'", [inv.id]),
    l1: s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p1'", [inv.id]),
  };
}
async function storno(weg: 'primary' | 'fern', db: Db, inv: string, refundMethod: 'cash' | 'bank' | 'benefit', x = nextId(), rev?: number): Promise<Ausgang> {
  return weg === 'primary'
    ? primary(() => cancelHouse.cancelInvoiceOnPrimary({ invoiceId: inv, refundMethod }))
    : fern(() => cancelCmd.runCancelInvoice(deps(db), identity(x, 'invoices.cancel'),
      cancelRules.invoiceCancelBody({ invoiceId: inv, refundMethod }, rev ?? (irev(db, inv) || 1))));
}
function bildDesStornos(db: Db, inv: string) {
  return {
    rechnung: ohne(row(db, 'SELECT * FROM invoices WHERE id = ?', [inv])),
    retouren: rows(db, 'SELECT * FROM sales_returns WHERE invoice_id = ? ORDER BY return_number', [inv]).map((r) => ohne(r, ['invoice_id'])),
    zeilen: rows(db, `SELECT l.product_id, l.quantity, l.unit_price, l.vat_amount, l.line_total FROM sales_return_lines l
      JOIN sales_returns r ON r.id = l.return_id WHERE r.invoice_id = ? ORDER BY r.return_number, l.product_id`, [inv]),
    gutschriften: rows(db, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [inv]).map((c) => ohne(c, ['invoice_id', 'sales_return_id'])),
    guthaben: rows(db, "SELECT amount, used_amount, status FROM customer_credits WHERE customer_id = 'cust-1'"),
    zahlungen: rows(db, 'SELECT amount, method FROM payments WHERE invoice_id = ?', [inv]),
    bestand: rows(db, "SELECT id, quantity, stock_status FROM products WHERE id IN ('p9','p1') ORDER BY id"),
    lose: rows(db, "SELECT product_id, qty_remaining, status FROM stock_lots WHERE product_id IN ('p9','p1') ORDER BY product_id"),
    ausgaben: rows(db, 'SELECT category, status, amount FROM expenses ORDER BY category'),
    buchungen: buchungen(db),
  };
}

// ── §1 Die Klassifikation: Freigabe und Erstattung haben keinen eigenen Knopf ─
{
  const alle: string[] = [];
  const lauf = (dir: string) => {
    for (const e of readdirSync(resolvePath(repo, dir), { withFileTypes: true })) {
      const p = dir + '/' + e.name;
      if (e.isDirectory()) lauf(p); else if (/\.tsx?$/.test(e.name)) alle.push(p);
    }
  };
  lauf('src/pages'); lauf('src/components');
  const rufer = alle.filter((f) => /\b(approveReturn|refundReturn)\(/.test(codeOf(src(f))));
  ok(rufer.length === 0, `CLASS keine Seite und keine Komponente ruft Freigabe oder Erstattung (${rufer.join(', ') || 'keine'})`);
  const vorher = codeOf(vor5f('src/pages/invoices/InvoiceDetail.tsx'));
  const alt = [...vorher.matchAll(/\b(approveReturn|refundReturn|refundSalesReturn)\(([^)]*)\)/g)].map((m) => m[1] + '(' + m[2] + ')');
  ok(alt.length === 3 && /function handleCancelInvoice\(\) \{[\s\S]*approveReturn\(ret\.id\)[\s\S]*refundReturn\(ret\.id\)[\s\S]*status: 'CANCELLED'/.test(vorher)
    && /if \(returnRefundNow \|\| returnRefundMethod === 'credit'\) \{\s*refundSalesReturn\(ret\.id\)/.test(vorher),
  `CLASS vor R5F standen sie NUR im Storno und im Sofort-Erstatten beim Anlegen — nie als eigener Knopf (${alt.join(' · ')})`);
  for (const op of ['returns.approve', 'returns.refund']) {
    const z = R4C_MATRIX.find((x) => x.op === op)!;
    ok(z.paritaet === 'keine-ui' && z.ort === '(keine)' && !z.verdrahtet && z.luecke === null, `CLASS ${op}: „ohne eigene Handlung" in der Vierziger-Matrix`);
    ok(ALLOWED_MUTATIONS.includes(op), `CLASS ${op}: die Buchung bleibt fuer Fernauftraege bestehen`);
  }
  const stand = [R4C_MATRIX.filter((z) => z.verdrahtet).length, R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length,
    R4C_MATRIX.filter((z) => z.luecke === 'B').length, R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length];
  ok(S(stand) === S([36, 0, 0, 4]) && R4C_MATRIX.length === 40, `CLASS die Vierziger-Matrix steht bei 36/0/0/4 (${stand.join('/')})`);
}

// ── §2 Die Entscheidung: EINE neue Buchung, und nur sie ────────────────────
{
  const vorher = vor5f('src/core/bridge/command-registry.ts');
  ok(!vorher.includes("'invoices.cancel'"), 'DECISION vor R5F.1 gab es keine Buchung fuer den Storno');
  const upd = codeOf(src('src/core/bridge/invoice-lifecycle-commands.ts'));
  ok(!/status/.test((/onlyKnownFields\(raw, \[([^\]]*)\]\)/.exec(upd)?.[1]) ?? ''), 'DECISION invoices.update kennt keinen Status — es aendert Zeilen mit Grund');
  ok(ALLOWED_MUTATIONS.length === 41 && ALLOWED_MUTATIONS[40] === 'invoices.cancel', `DECISION genau eine neue Buchung, am Ende der Liste (${ALLOWED_MUTATIONS.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 108 && /pub const OP_INVOICES_CANCEL: &str = "invoices\.cancel";/.test(rust), `DECISION Rust laesst genau diese eine mehr durch (${rustOps})`);
  ok(!!(OPERATION_PERMISSIONS as Record<string, unknown>)['invoices.cancel']
    && S((OPERATION_PERMISSIONS as Record<string, unknown>)['invoices.cancel']) === S((OPERATION_PERMISSIONS as Record<string, unknown>)['invoices.update']),
  'DECISION dasselbe Recht wie am Primary („Cancel" nur mit canEditInvoices)');
  ok(/import '\.\/invoice-cancel-command'/.test(src('src/core/bridge/bridge-listener.ts')), 'DECISION der Befehl ist angemeldet');
  ok(R5F1_NEUE_BUCHUNGEN.length === 1 && R5F1_NEUE_BUCHUNGEN[0].op === 'invoices.cancel' && R5F1_NEUE_BUCHUNGEN[0].verdrahtet,
    'DECISION die neue Buchung steht NEBEN der Vierziger-Matrix, verdrahtet');
  for (const [was, extra] of [['einen Betrag', { amount: 1 }], ['Zeilen', { lines: [] }], ['einen Status', { status: 'CANCELLED' }],
    ['eine Erstattung', { refundAmount: 5 }], ['eine Gutschrift', { creditNoteId: 'cn' }], ['eine Buchung', { ledger: [] }]] as Array<[string, Record<string, unknown>]>) {
    let threw = false;
    try { cancelCmd.parseCancelInvoice({ invoiceId: 'i', expectedRevision: 1, refundMethod: 'cash', ...extra }); } catch { threw = true; }
    ok(threw, `DECISION der Rumpf setzt ${was} nicht`);
  }
  let karte = false;
  try { cancelCmd.parseCancelInvoice({ invoiceId: 'i', expectedRevision: 1, refundMethod: 'card' }); } catch { karte = true; }
  let ohneFassung = false;
  try { cancelCmd.parseCancelInvoice({ invoiceId: 'i', refundMethod: 'cash' }); } catch { ohneFassung = true; }
  ok(karte && ohneFassung, 'DECISION nur die Wege des Dialogs, und nie ohne gesehene Fassung');
}

// ── §3 Die Wirkung: lokal == fern ───────────────────────────────────────────
const FAELLE: Array<[string, number, 'cash' | 'bank' | 'benefit', ((db: Db, r: { inv: string; l9: string; l1: string }) => Promise<void>) | null]> = [
  ['teilbezahlt 300, bar', 300, 'cash', null],
  ['unbezahlt', 0, 'bank', null],
  ['teilbezahlt 500, eine Zeile schon zurueck, Bank', 500, 'bank', async (_db, r) => {
    await returnHouse.createReturnOnPrimary({ invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'bank', productDisposition: 'IN_STOCK', refundNow: false });
  }],
];
for (const [was, bezahlt, weg, vorab] of FAELLE) {
  let db = welt();
  let r = rechnung(db, bezahlt);
  if (vorab) await vorab(db, r);
  const p = await storno('primary', db, r.inv, weg);
  const bildP = bildDesStornos(db, r.inv);
  db = welt();
  r = rechnung(db, bezahlt);
  if (vorab) await vorab(db, r);
  const x = nextId();
  const f = await storno('fern', db, r.inv, weg, x);
  const bildF = bildDesStornos(db, r.inv);
  ok(p.ok && f.ok, `CANCEL ${was}: beide Wege stornieren (${p.code || 'ok'} / ${f.code || 'ok'})`);
  const diff = Object.keys(bildP).flatMap((k) => unterschiede((bildP as Record<string, unknown>)[k], (bildF as Record<string, unknown>)[k], k));
  ok(diff.length === 0, `CANCEL ${was}: lokal == fern (${diff.join(' · ') || 'gleich'})`);
  const vor = S([n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM credit_notes'), buchungen(db), bildF.bestand]);
  const again = await storno('fern', db, r.inv, weg, x, n(db, 'SELECT revision FROM invoices WHERE id = ?', [r.inv]));
  ok(again.ok && again.replayed === true, `CANCEL ${was}: die verlorene Antwort wird wiederholt, nicht neu ausgefuehrt`);
  ok(S([n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM credit_notes'), buchungen(db), bildDesStornos(db, r.inv).bestand]) === vor,
    `CANCEL ${was}: …keine zweite Retoure, Erstattung, Buchung, kein zweiter Bestand`);
  const k = bildF.rechnung;
  ok(k.status === 'CANCELLED', `CANCEL ${was}: die Rechnung ist storniert (${String(k.status)})`);
  ok(S(bildF.bestand) === S([{ id: 'p1', quantity: 1, stock_status: 'in_stock' }, { id: 'p9', quantity: 3, stock_status: 'in_stock' }]),
    `CANCEL ${was}: ALLE Stueck sind zurueck im Bestand (${S(bildF.bestand)})`);
  if (bezahlt === 300) {
    const rr = bildF.retouren[0] ?? {};
    ok(bildF.retouren.length === 1 && Number(rr.total_amount) === 770 && S(bildF.zeilen.map((z) => [z.product_id, z.quantity])) === S([['p1', 1], ['p9', 2]]),
      `CANCEL mit Geld: die Retoure nimmt JEDE Zeile in ihrer Menge zum Rechnungspreis zurueck (${S([rr.total_amount, bildF.zeilen])})`);
    const cn = (bildF.gutschriften[0] ?? {}) as Record<string, unknown>;
    ok(Number(rr.refund_paid_amount) === 300 && rr.refund_method === 'cash' && bildF.gutschriften.length === 1
      && Number(cn.cash_refund_amount) === 300 && Number(cn.receivable_cancel_amount) === 470,
    `CANCEL mit Geld: genau das Gezahlte (300) fliesst bar zurueck, der Rest (470) storniert die Forderung — wie der Dialog es ankuendigt (${S([rr.refund_paid_amount, rr.status, cn.cash_refund_amount, cn.receivable_cancel_amount])})`);
  } else if (bezahlt === 0) {
    ok(bildF.retouren.length === 0 && bildF.gutschriften.length === 0, 'CANCEL ohne Geld: keine Retoure, keine Gutschrift — nur die Ware');
  } else {
    ok(bildF.retouren.length === 2 && S(bildF.zeilen.map((z) => [z.product_id, z.quantity])) === S([['p9', 1], ['p1', 1], ['p9', 1]]),
      `CANCEL nach einer Teilretoure: nur, was noch nicht zurueck ist (${S(bildF.zeilen)})`);
  }
}

// ── §4 Die Regeln: was „Cancel" nicht storniert ────────────────────────────
{
  const beide = async (was: string, bau: (db: Db) => { inv: string; rev?: number }, code: string) => {
    for (const weg of ['primary', 'fern'] as const) {
      const db = welt();
      const { inv, rev } = bau(db);
      const vor = S([rows(db, 'SELECT status, revision FROM invoices'), n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM ledger_entries')]);
      const aus = await storno(weg, db, inv, 'cash', nextId(), rev);
      const nach = S([rows(db, 'SELECT status, revision FROM invoices'), n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM ledger_entries')]);
      ok(!aus.ok && aus.code === code && vor === nach, `RULE ${was} (${weg}: ${aus.code})`);
    }
  };
  await beide('eine voll bezahlte Rechnung (dort ist es eine Retoure)', (db) => ({ inv: rechnung(db, 770).inv }), 'INVOICE_NOT_CANCELLABLE');
  await beide('eine zurueckgegebene Rechnung', (db) => { const r = rechnung(db, 300); db.run("UPDATE invoices SET status = 'RETURNED' WHERE id = ?", [r.inv]); return { inv: r.inv }; }, 'INVOICE_NOT_CANCELLABLE');
  await beide('eine schon stornierte', (db) => { const r = rechnung(db, 0); db.run("UPDATE invoices SET status = 'CANCELLED' WHERE id = ?", [r.inv]); return { inv: r.inv }; }, 'INVOICE_CANCELLED');
  await beide('eine unbekannte', () => ({ inv: 'gibt-es-nicht' }), 'INVOICE_NOT_FOUND');
  {
    const db = welt();
    const r = rechnung(db, 300);
    const alt = irev(db, r.inv);
    useInvoiceStore.getState().recordPayment(r.inv, 10, 'cash');
    const aus = await storno('fern', db, r.inv, 'cash', nextId(), alt);
    ok(!aus.ok && aus.code === 'RECORD_CHANGED' && s(db, 'SELECT status FROM invoices WHERE id = ?', [r.inv]) !== 'CANCELLED', `RULE eine alte Fassung storniert nicht (${aus.code})`);
    const fr = await fern(() => cancelCmd.runCancelInvoice(deps(db), fremd(nextId(), 'invoices.cancel'), cancelRules.invoiceCancelBody({ invoiceId: r.inv, refundMethod: 'cash' }, irev(db, r.inv))));
    ok(!fr.ok && fr.code === 'INVOICE_NOT_FOUND', `RULE ein Ausweis einer fremden Filiale (${fr.code})`);
  }
  ok(S(['PARTIAL', 'DRAFT', 'FINAL', 'RETURNED', 'CANCELLED'].map((st) => cancelRules.invoiceCancelBlocker(st) === null)) === S([true, true, false, false, false]),
    'RULE die Seite und das Haus fragen dieselbe Regel (nicht storniert, nicht endgueltig, nicht zurueckgegeben)');
  const vorher = codeOf(vor5f('src/pages/invoices/InvoiceDetail.tsx'));
  ok(/const canCancel = !isCancelled && !isPaid && !isReturned;/.test(vorher) && /canCancel && perm\.canEditInvoices/.test(vorher),
    'RULE …und das ist die Regel des Knopfs vor R5F.1');
}

// ── §5 Atomar: nichts bleibt halb ───────────────────────────────────────────
{
  const zaehler = (db: Db): string => S([rows(db, 'SELECT status, paid_amount, vat_amount, revision FROM invoices'),
    n(db, 'SELECT COUNT(*) FROM sales_returns'), n(db, 'SELECT COUNT(*) FROM sales_return_lines'), n(db, 'SELECT COUNT(*) FROM credit_notes'),
    n(db, 'SELECT COUNT(*) FROM customer_credits'), n(db, 'SELECT COUNT(*) FROM ledger_entries'), n(db, 'SELECT COUNT(*) FROM payments'),
    rows(db, "SELECT quantity, stock_status FROM products WHERE id IN ('p9','p1') ORDER BY id"),
    rows(db, "SELECT qty_remaining, status FROM stock_lots WHERE product_id IN ('p9','p1') ORDER BY product_id"),
    rows(db, 'SELECT status FROM expenses ORDER BY id')]);
  const punkte: Array<[string, number, string]> = [
    ['nach der Warenfolge (Bestand zurueck), bei der Gutschrift', 300, 'BEFORE INSERT ON credit_notes'],
    ['nach der Freigabe, bei der Erstattung', 300, 'BEFORE UPDATE OF refund_paid_amount ON sales_returns'],
    ['nach Erstattung und Gutschrift, beim Status', 300, "BEFORE UPDATE OF status ON invoices WHEN NEW.status = 'CANCELLED'"],
    ['bei der Buchung der Gutschrift (abgefangener Post)', 300, "BEFORE INSERT ON ledger_entries WHEN NEW.source_module = 'CREDIT_NOTE'"],
    ['ohne Geld: nach dem Status, bei den Losen', 0, 'BEFORE UPDATE ON stock_lots'],
    ['ohne Geld: beim Buchungsstorno (abgefangener Post)', 0, "BEFORE INSERT ON ledger_entries WHEN NEW.reverses_entry_id IS NOT NULL"],
  ];
  for (const [was, bezahlt, trigger] of punkte) {
    for (const weg of ['primary', 'fern'] as const) {
      const db = welt();
      const r = rechnung(db, bezahlt);
      const x = nextId();
      const vor = zaehler(db);
      db.run(`CREATE TRIGGER r5f1_bruch ${trigger} BEGIN SELECT RAISE(ABORT, 'R5F.1: injected'); END`);
      let aus: Ausgang;
      try { aus = await storno(weg, db, r.inv, 'cash', x); } finally { db.run('DROP TRIGGER IF EXISTS r5f1_bruch'); }
      const nach = zaehler(db);
      const heil = await storno(weg, db, r.inv, 'cash', x);
      ok(!aus.ok && vor === nach, `ATOMIC ${was} ${weg}: Rechnung, Retoure, Erstattung, Guthaben, Bestand, Buchung unveraendert (${aus.code.slice(0, 60)})`);
      ok(heil.ok && s(db, 'SELECT status FROM invoices WHERE id = ?', [r.inv]) === 'CANCELLED', `ATOMIC ${was} ${weg}: danach gelingt es mit derselben Kennung (${heil.code || 'ok'})`);
    }
  }
  const h = codeOf(src('src/core/invoices/invoice-cancel-house.ts'));
  ok(/watchLedgerPosts\('invoice cancel'\)/.test(h) && /\.createReturn\(/.test(h) && /\.approveReturn\(/.test(h) && /\.refundReturn\(/.test(h)
    && /\.updateInvoice\(input\.invoiceId, \{ status: 'CANCELLED' \}\)/.test(h) && !/INSERT INTO|UPDATE \w+ SET|postEntries|computeRefundSplit/.test(h),
  'ATOMIC die Folge ruft die Hausfunktionen — sie baut nichts nach und schreibt nichts selbst');
  const idc = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok(!/console\.warn\('Cancel-refund failed/.test(idc), 'ATOMIC ein Fehler der Erstattung storniert nicht mehr trotzdem');
  ok(!/r5f1_bruch|R5F\.1: injected/.test(src('src/core/invoices/invoice-cancel-house.ts') + src('src/core/bridge/invoice-cancel-command.ts')), 'ATOMIC kein Testhaken im Produkt');
}

// ── §6 Der Mitarbeiter einer neuen Retoure beginnt frisch ──────────────────
{
  const idc = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  const oeffnen = /function openReturnModal\(\) \{[\s\S]*?\n {2}\}/.exec(idc)?.[0] ?? '';
  ok(/setReturnStaffId\(''\)/.test(oeffnen) && /useState<string>\(''\)/.test(idc.slice(idc.indexOf('returnStaffId, setReturnStaffId'), idc.indexOf('returnStaffId, setReturnStaffId') + 80)),
    'STAFF „Create Return" setzt den Mitarbeiter auf den Anfangswert der Maske („Unassigned") — wie jedes andere Feld');
  const vorher = codeOf(vor5f('src/pages/invoices/InvoiceDetail.tsx'));
  const altOeffnen = /function openReturnModal\(\) \{[\s\S]*?\n {2}\}/.exec(vorher)?.[0] ?? '';
  ok(!/setReturnStaffId/.test(altOeffnen) && /setReturnRefundNow\(true\)/.test(altOeffnen), 'STAFF vor R5F.1 fehlte genau dieses eine Feld beim Zuruecksetzen');
  const db = welt();
  const r = rechnung(db, 770);
  const a = await returnHouse.createReturnOnPrimary({ invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', staffId: 'emp-1', refundNow: false });
  const b = await returnHouse.createReturnOnPrimary({ invoiceId: r.inv, lines: [{ invoiceLineId: r.l1, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false });
  ok(s(db, 'SELECT staff_id FROM sales_returns WHERE id = ?', [a.returnId]) === 'emp-1' && one(db, 'SELECT staff_id FROM sales_returns WHERE id = ?', [b.returnId]) === null,
    'STAFF Retoure A mit Mitarbeiter, Retoure B ohne — die Datenbank zeigt genau das');
}

// ── §7 Die R5F-Vertraege gegen den Stand vor R5F (0e522bf) ─────────────────
{
  const inv = codeOf(vor5f('src/pages/invoices/InvoiceDetail.tsx'));
  ok(/const hasConsignment = products\.some\(p => includedProductIds\.includes\(p\.id\) && p\.sourceType === 'CONSIGNMENT'\);/.test(inv)
    && /if \(hasConsignment\) \{\s*options\.push\(\{ id: 'RETURN_TO_OWNER'/.test(inv),
  'PIN „Return to Owner"/„Keep" bot die Maske schon vor R5F NUR mit Kommissionsware an — R5F haelt dieselbe Regel am Haus');
  ok(/if \(returnRefundNow \|\| returnRefundMethod === 'credit'\) \{\s*refundSalesReturn\(ret\.id\);/.test(inv),
    'PIN Store-Guthaben wurde schon vor R5F IMMER sofort erstattet — refundsImmediately ist wortgleich');
  ok(/i\.refundNow \|\| i\.refundMethod === 'credit'/.test(codeOf(src('src/core/returns/return-create.ts'))), 'PIN …und so steht sie jetzt an EINER Stelle');
  for (const f of ['src/pages/consignments/ConsignmentDetail.tsx', 'src/pages/consignments/ConsignmentList.tsx']) {
    const c = codeOf(vor5f(f));
    ok(/(consignment|con)\.status === 'sold' && !(consignment|con)\.invoiceId/.test(c) || /!consignment\.invoiceId && \(/.test(c),
      `PIN ${f.split('/').pop()}: „Pay Out" gab es schon vor R5F NUR ohne Rechnung — die Hausregel PAYOUT_VIA_PURCHASE ist dieselbe`);
    ok(/markPaidOut\(/.test(c) && !/amount/i.test((/function handleMarkPaid\(\) \{[\s\S]*?\n {2}\}/.exec(c)?.[0]) ?? 'amount'),
      `PIN ${f.split('/').pop()}: die Maske schickte nie einen Betrag — sie zahlte den Rest; mehr als offen war am Primary unmoeglich`);
  }
  const store = codeOf(vor5f('src/stores/consignmentStore.ts'));
  ok(/const newStatus = fully \? 'paid_out' : con\.status;/.test(store) && /const fully = target > 0 && newPaid >= target - 0\.005;/.test(store),
    'PIN der Hausvertrag vor R5F: ein Teil laesst den Status stehen, erst der volle Betrag schliesst („paid_out")');
  const house = codeOf(src('src/core/consignment/consignment-finance-house.ts'));
  ok(/PAYOUT_EXCEEDS_OPEN/.test(house) && /PAYOUT_VIA_PURCHASE/.test(house) && /\.recordPartialPayout\(/.test(house),
    'PIN R5F: mehr als offen ist ein Nein (die Maske sendet genau den Rest), mit Rechnung zahlt der Einkauf — ueber dieselbe Store-Funktion');
}

// ════════════════════════════════════════════════════════════════════════════
// R5F FINAL GATE — Betrag, Teilzahlung, Storno-Waechter, Registry
// ════════════════════════════════════════════════════════════════════════════
const ret5 = await import('../../src/core/bridge/return-commands.ts');
const reg5 = await import('../../src/core/bridge/command-registry.ts');
const netto = (db: Db, where: string, p: unknown[] = []): Record<string, number> => Object.fromEntries(
  rows(db, `SELECT account, ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 3) AS netto
    FROM ledger_entries WHERE ${where} GROUP BY account`, p).map((r) => [String(r.account), Number(r.netto)]));
const nah = (a: unknown, b: number): boolean => Math.abs(Number(a) - b) < 0.0006;
/** p9 ×3 mit einem von Hand gesetzten Zeilenpreis (1000 brutto, 90,909 Steuer) — optional p1 (330). */
function dreier(db: Db, bezahlt: number, mitP1 = false): { inv: string; l9: string } {
  const lines = [{ productId: 'p9', quantity: 3, unitPrice: 303.03, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 90.909, lineTotal: 1000 }];
  if (mitP1) lines.push({ productId: 'p1', quantity: 1, unitPrice: 300, purchasePrice: 100, taxScheme: 'VAT_10', vatRate: 10, vatAmount: 30, lineTotal: 330 });
  const inv = useInvoiceStore.getState().createDirectInvoice('cust-1', lines, 'R5F-GATE');
  if (bezahlt > 0) useInvoiceStore.getState().recordPayment(inv.id, bezahlt, 'cash');
  useInvoiceStore.getState().loadInvoices();
  return { inv: inv.id, l9: s(db, "SELECT id FROM invoice_lines WHERE invoice_id = ? AND product_id = 'p9'", [inv.id]) };
}

// ── §8 Der Betrag: EINE Preisregel — Dialog == Erstattung == Gutschrift == Buchung ──
{
  // Einen Rabatt als eigenes Feld kennt der Rechnungsvertrag nicht; ein angepasster Preis steht in
  // `unit_price`/`line_total` der Zeile — genau daraus rechnet die Retoure (`returnLineAmounts`).
  ok(!/discount/i.test(src('src/core/db/schema.sql').slice(src('src/core/db/schema.sql').indexOf('CREATE TABLE IF NOT EXISTS invoice_lines'), src('src/core/db/schema.sql').indexOf('CREATE TABLE IF NOT EXISTS invoice_lines') + 1500)),
    'AMOUNT die Rechnungszeile hat kein Rabattfeld — ein angepasster Preis IST ihr Zeilenbetrag');
  for (const weg of ['primary', 'fern'] as const) {
    const db = welt();
    const r = dreier(db, 400);
    const aus = await storno(weg, db, r.inv, 'cash');
    const rt = row(db, 'SELECT * FROM sales_returns WHERE invoice_id = ?', [r.inv]);
    const zl = rows(db, 'SELECT quantity, unit_price, vat_amount, line_total FROM sales_return_lines WHERE return_id = ?', [String(rt.id ?? '')]);
    const cn = row(db, 'SELECT * FROM credit_notes WHERE invoice_id = ?', [r.inv]);
    const nt = netto(db, "source_module = 'CREDIT_NOTE'");
    ok(aus.ok && zl.length === 1 && Number(zl[0].quantity) === 3 && nah(zl[0].line_total, 1000) && nah(zl[0].vat_amount, 90.909),
      `AMOUNT ${weg} A/D: Menge 3 → genau der Zeilenbetrag 1000, nicht Stueckpreis × Menge (${S(zl)})`);
    ok(nah(rt.total_amount, 1000) && nah(rt.vat_corrected, 90.909) && nah(cn.total_amount, 1000) && nah(cn.vat_amount, 90.909),
      `AMOUNT ${weg} C: Retoure und Gutschrift tragen den Rechnungsbetrag samt anteiliger Steuer (${S([rt.total_amount, rt.vat_corrected, cn.total_amount, cn.vat_amount])})`);
    ok(Number(rt.refund_paid_amount) === 400 && Number(cn.cash_refund_amount) === 400 && nah(cn.receivable_cancel_amount, 600),
      `AMOUNT ${weg}: der Dialog sagt „Refund of 400" — erstattet 400, Gutschrift bar 400, Forderung 600 storniert`);
    ok(nah(nt.REVENUE, 909.091) && nah(nt.VAT_OUTPUT, 90.909) && nah(nt.CASH, -400) && nah(nt.ACCOUNTS_RECEIVABLE, -600),
      `AMOUNT ${weg}: …und genau so gebucht (Erloes 909,091 + Steuer 90,909 zurueck, 400 aus der Kasse, 600 Forderung) ${S(nt)}`);
  }
  for (const weg of ['primary', 'fern'] as const) {
    const db = welt();
    const r = dreier(db, 400);
    const erste = await returnHouse.createReturnOnPrimary({ invoiceId: r.inv, lines: [{ invoiceLineId: r.l9, quantity: 1 }], refundMethod: 'cash', productDisposition: 'IN_STOCK', refundNow: false });
    const aus = await storno(weg, db, r.inv, 'cash');
    const zweite = row(db, 'SELECT * FROM sales_returns WHERE invoice_id = ? AND id != ?', [r.inv, erste.returnId]);
    const zl = rows(db, 'SELECT quantity, line_total FROM sales_return_lines WHERE return_id = ?', [String(zweite.id ?? '')]);
    ok(aus.ok && zl.length === 1 && Number(zl[0].quantity) === 2 && nah(zl[0].line_total, 666.667),
      `AMOUNT ${weg} B: 1 von 3 schon zurueck → der Storno nimmt nur die Restmenge 2 (${S(zl)})`);
    ok(nah(n(db, 'SELECT SUM(total_amount) FROM sales_returns WHERE invoice_id = ?', [r.inv]), 1000)
      && nah(n(db, 'SELECT SUM(refund_paid_amount) FROM sales_returns WHERE invoice_id = ?', [r.inv]), 400),
    'AMOUNT B: beide Retouren zusammen genau die Zeile (1000), erstattet genau das Gezahlte (400)');
    const spaeter = await fern(() => ret5.runRecordRefundPayment(deps(db), identity(nextId(), 'returns.record_refund_payment'),
      { returnId: erste.returnId, amount: 100, method: 'cash', expectedRevision: n(db, 'SELECT revision FROM sales_returns WHERE id = ?', [erste.returnId]) }));
    ok(!spaeter.ok && nah(n(db, 'SELECT SUM(refund_paid_amount) FROM sales_returns WHERE invoice_id = ?', [r.inv]), 400),
      `AMOUNT B: die fruehere, offene Retoure zahlt danach nichts mehr aus — kein doppeltes Geld (${spaeter.code} · ${S(spaeter.value ?? {}).slice(0, 160)} · ${S(rows(db, 'SELECT status, refund_status, total_amount, refund_paid_amount FROM sales_returns WHERE invoice_id = ?', [r.inv]))} · paid ${n(db, 'SELECT paid_amount FROM invoices WHERE id = ?', [r.inv])})`);
  }
}

// ── §9 Teilzahlung: nur, was zusteht; alles saldiert ───────────────────────
for (const weg of ['primary', 'fern'] as const) {
  const db = welt();
  const r = dreier(db, 500, true);
  const aus = await storno(weg, db, r.inv, 'cash');
  const alle = Object.entries(netto(db, '1 = 1')).filter(([, v]) => Math.abs(v) > 0.0006);
  ok(aus.ok && alle.length === 0, `PAY ${weg}: nach dem Storno steht jedes Konto wieder bei null — Forderung, Kasse, Erloes, Steuer, Wareneinsatz, Bestand (${S(alle)})`);
  const dc = row(db, "SELECT ROUND(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE 0 END), 3) AS d, ROUND(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE 0 END), 3) AS c FROM ledger_entries");
  ok(nah(dc.d, Number(dc.c)), `PAY ${weg}: Soll == Haben (${S(dc)})`);
  const ar = netto(db, "account = 'ACCOUNTS_RECEIVABLE' AND counterparty_id = 'cust-1'").ACCOUNTS_RECEIVABLE ?? 0;
  ok(Math.abs(ar) < 0.0006, `PAY ${weg}: keine (negative) Restforderung beim Kunden (${ar})`);
  const rt = row(db, 'SELECT refund_paid_amount, total_amount FROM sales_returns WHERE invoice_id = ?', [r.inv]);
  ok(Number(rt.refund_paid_amount) === 500 && nah(rt.total_amount, 1330) && n(db, 'SELECT COUNT(*) FROM customer_credits') === 0
    && n(db, 'SELECT COUNT(*) FROM payments WHERE invoice_id = ?', [r.inv]) === 1,
  `PAY ${weg}: genau die 500 fliessen bar zurueck, kein Guthaben, die Zahlung bleibt als Beleg (die Erstattung gleicht sie aus)`);
}

// ── §10 Der Storno-Waechter: Fehler propagiert, kein Teil-Storno, kein zweiter Gegenposten ──
{
  for (const [name, lauf] of [['reverseSource', () => posting.reverseSource('INVOICE', 'gibt-es-nicht', NOW)],
    ['reverseTransaction', () => posting.reverseTransaction('gibt-es-nicht', NOW)]] as Array<[string, () => unknown]>) {
    const w1 = posting.watchLedgerPosts('probe');
    let geworfen = false;
    try { lauf(); } catch { geworfen = true; }
    let sieht = false;
    try { w1(); } catch { sieht = true; }
    const w2 = posting.watchLedgerPosts('danach');
    let spaeter = false;
    try { w2(); } catch { spaeter = true; }
    ok(geworfen && sieht && !spaeter, `REVERSAL ${name}: der Fehler wirft weiter wie bisher, der Waechter sieht ihn — nur in seinem Fenster`);
  }
  for (const weg of ['primary', 'fern'] as const) {
    const db = welt();
    const r = rechnung(db, 0);
    const orig = n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND reverses_entry_id IS NULL", [r.inv]);
    db.run(`CREATE TRIGGER r5f_teil BEFORE INSERT ON ledger_entries
      WHEN NEW.reverses_entry_id IS NOT NULL AND (SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL) >= 1
      BEGIN SELECT RAISE(ABORT, 'R5F: second reversal row'); END`);
    const x = nextId();
    let aus: Ausgang;
    try { aus = await storno(weg, db, r.inv, 'bank', x); } finally { db.run('DROP TRIGGER IF EXISTS r5f_teil'); }
    const reste = n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE reverses_entry_id IS NOT NULL');
    ok(orig >= 2 && !aus.ok && reste === 0 && s(db, 'SELECT status FROM invoices WHERE id = ?', [r.inv]) !== 'CANCELLED',
      `REVERSAL ${weg}: der ZWEITE Gegenposten scheitert → kein Teil-Storno, kein Erfolg (${aus.code.slice(0, 50)} · ${reste} Reste von ${orig})`);
    const heil = await storno(weg, db, r.inv, 'bank', x);
    const gegen = (): number => n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND reverses_entry_id IS NOT NULL", [r.inv]);
    ok(heil.ok && gegen() === orig, `REVERSAL ${weg}: danach genau EIN Gegenposten je Buchung (${gegen()}/${orig})`);
    const nochmal = weg === 'fern' ? await storno('fern', db, r.inv, 'bank', x, irev(db, r.inv)) : await storno('primary', db, r.inv, 'bank');
    ok((weg === 'fern' ? nochmal.ok && nochmal.replayed === true : nochmal.code === 'INVOICE_CANCELLED') && gegen() === orig,
      `REVERSAL ${weg}: die Wiederholung erzeugt keinen zweiten Gegenposten (${nochmal.code || 'wiederholt'})`);
  }
}

// ── §11 Registry: 40 → 41, einzig invoices.cancel, fremdes bleibt draussen ──
{
  const vorher = [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/.exec(vor5f('src/core/bridge/command-registry.ts'))?.[1] ?? '')
    .matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const jetzt = [...ALLOWED_MUTATIONS];
  ok(vorher.length === 40 && jetzt.length === 41 && S(jetzt.filter((o) => !vorher.includes(o))) === S(['invoices.cancel']) && vorher.every((o) => jetzt.includes(o)),
    `REGISTRY vorher 40, jetzt 41 — die einzige neue ist invoices.cancel, keine faellt weg (${vorher.length} → ${jetzt.length})`);
  const zaehle = (t: string): number => [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(t)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  const rustVorher = vor5f('src-tauri/src/bridge.rs');
  const rustJetzt = src('src-tauri/src/bridge.rs');
  const neuRust = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rustJetzt)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].map((m) => m[0])
    .filter((o) => !(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rustVorher)?.[1] ?? '').includes(o));
  ok(zaehle(rustVorher) === 107 && zaehle(rustJetzt) === 108 && S(neuRust) === S(['OP_INVOICES_CANCEL']), `REGISTRY Rust 107 → 108, einzig OP_INVOICES_CANCEL (${S(neuRust)})`);
  let zu = '';
  try { reg5.registerCommand('invoices.delete', { kind: 'mutation', handler: () => ({}) } as never); } catch (e) { zu = String(e); }
  ok(/refusing to register/.test(zu), 'REGISTRY eine nicht freigegebene Buchung bleibt fail-closed');
  const diff = execSync('git diff 247aa4d 4a8a68d -- test', { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const plus = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  ok(!plus.some((l) => /\.skip\(|\bxit\(|if \(false\)/.test(l)), 'REGISTRY die geaenderten Pins enthalten kein skip');
  const lc = src('test/bridge/invoice-lifecycle.test.ts');
  ok(/\['invoices\.delete', 'payments\.delete', 'payments\.update', 'anything\.write'\]/.test(lc) && /invoices\.cancel ist freigegeben und angemeldet/.test(lc),
    'REGISTRY die Abweisung fremder Namen steht weiter — nur die freigegebene invoices.cancel ist herausgenommen und positiv gepinnt');
  const c3g = src('test/bridge/c3g-scope-completeness.test.ts');
  ok(/a\.module === 'invoice' \? \[\] : \[`\$\{a\.module\}s\.cancel`\]/.test(c3g), 'REGISTRY die Klasse-C-Probe nimmt nur invoices.cancel aus — Loeschen und Sondermarke der Rechnung bleiben geprueft');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5f.1 invoice cancel + return closure: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5F1_RETURN_SUBACTION_CLASSIFICATION_PROVED');
console.log('CENTRAL_UI_R5F1_INVOICE_CANCEL_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5F1_INVOICE_CANCEL_COMMAND_DECISION_PROVED');
console.log('CENTRAL_UI_R5F1_INVOICE_CANCEL_ATOMIC_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5F1_FINANCIAL_CONTRACTS_PINNED');
console.log('CENTRAL_UI_R5F_CANCEL_AMOUNT_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5F_CANCEL_PAYMENT_ACCOUNTING_PROVED');
console.log('CENTRAL_UI_R5F_REVERSAL_FAILURE_CONTRACT_PROVED');
console.log('CENTRAL_UI_R5F_REGISTRY_108_AUDITED');

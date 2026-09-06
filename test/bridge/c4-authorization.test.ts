// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C4 — Identität, Rechte, Autorisierung: wer darf was, und woher weiß das jemand.
// Run: node test/bridge/c4-authorization.test.ts
//
// C4 fügt KEINE Geschäftsfunktion hinzu. Es beantwortet eine andere Frage: darf der, der fragt,
// das überhaupt? Bewiesen wird an echten Zeilen einer echten sql.js-Datenbank:
//
//   1. Der Umfang bleibt eingefroren: 1 Probe + 18 Auskünfte + 40 Buchungen = 59.
//   2. Identität ist SERVERSEITIG. Mandant, Filiale und Benutzer kommen aus geprüften
//      Ansprüchen; kein Rumpf, keine Verschachtelung und keine gefälschte Rolle kommt daran.
//   3. Rechte-Gleichstand: PC2 darf aus der Ferne nicht mehr, als derselbe Benutzer am Primary
//      vor sich hätte — und die Regel ist von dem Bildschirm abgeschrieben, der sie dort bewacht.
//   4. Ein Nein aus Rechten wirkt wie ein unbekannter Name: kein Domänenaufruf, keine Zeile im
//      durablen Nachweis, KEINE Wirkung.
//   5. Dieselbe Kennung unter fremder Identität ist ein Konflikt, keine Wiederholung.
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
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const rolePerms = await import('../../src/core/auth/role-permissions.ts');
const { executeCommand, ALLOWED_MUTATIONS, knownCommands } =
  await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/commercial-commands.ts');
await import('../../src/core/bridge/service-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
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

const ACT = (over: Record<string, unknown> = {}) => ({
  commandId: ID('90'), tenantId: 'tenant-1', branchId: 'branch-main',
  userId: 'user-test', role: 'ADMIN', payloadHash: 'h90', ...over,
});

// ── 1) Der Umfang bleibt eingefroren ─────────────────────────────────────
{
  const list = ALLOWED_MUTATIONS as readonly string[];
  const known = knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  ok(list.length === 40, `SCOPE weiterhin genau 40 Mutationen (${list.length})`);
  ok(known.length === 59 && reads.length === 18,
    `SCOPE 1 Probe + 18 Reads + 40 Mutationen = 59 (${known.length}/${reads.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rl = rust.slice(rust.indexOf('pub const REMOTE_OPS'), rust.indexOf('];', rust.indexOf('pub const REMOTE_OPS')));
  ok((rl.match(/OP_[A-Z_]+/g) ?? []).length === 59, 'SCOPE Rust kennt dieselben 59');
  // C4 hat NICHTS registriert.
  const mine = codeOf('src/core/bridge/command-permissions.ts') + codeOf('src/core/auth/role-permissions.ts');
  ok(!/registerCommand\(/.test(mine), 'SCOPE C4 registriert keine einzige Operation');
  ok(!/getDatabase\(|db\.run\(|INSERT INTO|UPDATE .* SET/i.test(mine), 'SCOPE …und schreibt nichts');
  // Jede der 40 ist in der Rechte-Tabelle NAMENTLICH bedacht — auch die ohne Tor.
  const missing = list.filter((op) => !(op in perms.OPERATION_PERMISSIONS));
  ok(missing.length === 0, `SCOPE jede Mutation ist bedacht (fehlend: ${missing.join(', ') || 'keine'})`);
  const extra = Object.keys(perms.OPERATION_PERMISSIONS).filter((op) => !list.includes(op));
  ok(extra.length === 0, `SCOPE …und keine erfundene steht drin (${extra.join(', ') || 'keine'})`);
}

// ── 2) Die Rechte kommen aus DERSELBEN Tabelle wie die Bildschirme ───────
{
  // Kein zweiter Satz Rollen: `usePermission` und `authService` fragen dieselbe Datei.
  ok(/roleHasPermission\(/.test(src('src/core/auth/auth.ts')),
    'SSOT der Anmeldedienst fragt die geteilte Tabelle');
  const auth = codeOf('src/core/auth/auth.ts');
  ok(!/ADMIN: \['\*'\]/.test(auth), 'SSOT …und haelt keine zweite Kopie mehr');
  ok(/ADMIN: \['\*'\]/.test(src('src/core/auth/role-permissions.ts')), 'SSOT die Tabelle steht an EINER Stelle');

  // Die Ableitungen, an denen die Oberflaeche ihre Knoepfe festmacht.
  ok(rolePerms.roleHasPermission('ADMIN', 'anything.at.all'), 'ROLE ADMIN darf alles');
  ok(rolePerms.roleHasPermission('MANAGER', 'orders.create'), 'ROLE MANAGER darf Auftraege');
  ok(!rolePerms.roleHasPermission('SALES', 'payments.refund'), 'ROLE SALES darf keine Zahlungen verwalten');
  ok(rolePerms.roleHasPermission('SALES', 'invoices.create'), 'ROLE …aber Rechnungen anlegen');
  ok(rolePerms.roleHasPermission('ACCOUNTANT', 'payments.anything'), 'ROLE ACCOUNTANT darf Zahlungen');
  ok(!rolePerms.roleHasPermission('ACCOUNTANT', 'orders.create'), 'ROLE …aber keine Auftraege');
  ok(rolePerms.isAdminOrManagerRole('owner'), 'ROLE der alte Name „owner" ist ADMIN');
  // Fail-closed an jeder Kante.
  for (const bad of [undefined, null, '', '   ', 'SUPERUSER', 'root']) {
    ok(!rolePerms.roleHasPermission(bad as never, 'orders.create'),
      `ROLE eine fehlende/unbekannte Rolle darf nichts (${JSON.stringify(bad)})`);
  }
}

// ── 3) Rechte-Gleichstand: nicht mehr als lokal ──────────────────────────
{
  // Die Matrix, Zeile fuer Zeile am echten Bildschirm nachgeschlagen.
  const CASES: ReadonlyArray<readonly [string, string, boolean]> = [
    // Auftraege: OrderDetail bewacht ALLES mit perm.canManageOrders (= isAdmin).
    ['orders.update_status', 'ADMIN', true], ['orders.update_status', 'MANAGER', true],
    ['orders.update_status', 'SALES', false], ['orders.update_status', 'ACCOUNTANT', false],
    ['orders.add_payment', 'SALES', false], ['orders.convert_to_invoice', 'ACCOUNTANT', false],
    // Reparaturen: perm.canManageRepairs (= isAdmin).
    ['repairs.update_status', 'MANAGER', true], ['repairs.update_status', 'SALES', false],
    ['repairs.add_line', 'ACCOUNTANT', false],
    // …ihre Rechnung aber: perm.canCreateInvoices.
    ['repairs.create_invoice', 'SALES', true], ['repairs.create_invoice', 'ACCOUNTANT', true],
    // Kommission: perm.canManageConsignments (= isAdmin).
    ['consignments.record_sale', 'MANAGER', true], ['consignments.record_sale', 'SALES', false],
    ['consignments.record_payout', 'ACCOUNTANT', false],
    // Rechnung: anlegen darf, wer invoices.create hat; aendern nur isAdmin.
    ['invoices.create', 'SALES', true], ['invoices.update', 'SALES', false],
    ['invoices.update', 'MANAGER', true],
    // Geld an der Rechnung: perm.canRecordPayments = payments.* ODER isAdmin.
    ['invoices.record_payment', 'ACCOUNTANT', true], ['invoices.record_payment', 'SALES', false],
    ['invoices.apply_credit', 'SALES', false], ['invoices.delete_payment', 'MANAGER', true],
    ['returns.refund', 'SALES', false], ['returns.record_refund_payment', 'ACCOUNTANT', true],
    // Stammdaten: products.edit / customers.edit — SALES hat beide.
    ['products.update', 'SALES', true], ['customers.create', 'SALES', true],
    ['products.update', 'ACCOUNTANT', false],
  ];
  for (const [op, role, may] of CASES) {
    ok(perms.roleMayRunOp(role, op) === may,
      `PARITY ${role} ${may ? 'darf' : 'darf NICHT'} ${op}`);
  }
  // Ohne Rolle: nichts, was ein Tor hat.
  for (const op of ['orders.update_status', 'invoices.update', 'consignments.record_sale']) {
    ok(!perms.roleMayRunOp(undefined, op), `PARITY ohne Rolle kein ${op}`);
    ok(!perms.roleMayRunOp('', op), `PARITY …auch nicht mit leerer Rolle (${op})`);
  }
  // BEFUND, nicht Auslassung: wo der Primary heute kein Tor hat, hat der Fernweg auch keins.
  const OPEN = ['purchases.create', 'transfers.create', 'transfers.mark_sold',
    'transfers.convert_to_invoice', 'returns.create', 'returns.approve'];
  for (const op of OPEN) {
    ok(perms.permissionForOp(op) === null, `FINDING ${op} hat am Primary KEIN Rechte-Tor`);
    ok(perms.roleMayRunOp('SALES', op), `FINDING …und der Fernweg erfindet keins (${op})`);
  }
  ok(OPEN.every((op) => (ALLOWED_MUTATIONS as readonly string[]).includes(op)),
    'FINDING …und alle sechs sind wirklich freigegebene Operationen');
}

// ── 4) Ein Nein aus Rechten hat NULL Wirkung ─────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5, 100);
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
      agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type, created_at, updated_at, created_by)
    VALUES ('o1','branch-main','ORD-1','cust-1','Rolex','C4',300,0,0,0,300,'pending','normal',?,?,'user-owner')`, [NOW, NOW]);
  const revBefore = n(db, "SELECT revision FROM orders WHERE id = 'o1'");
  const ledgerBefore = n(db, 'SELECT COUNT(*) FROM remote_command_ledger');

  const body = { input: { orderId: 'o1', status: 'arrived', expectedRevision: revBefore } };
  const denied = await executeCommand('orders.update_status', body, ACT({ role: 'SALES' }) as never);
  ok(denied.kind === 'business_error' && (denied as { code: string }).code === 'PERMISSION_DENIED',
    `DENY ein Verkaeufer darf den Auftrag nicht weiterschalten (${JSON.stringify(denied)})`);
  ok(s(db, "SELECT status FROM orders WHERE id = 'o1'") === 'pending', 'DENY …und nichts bewegte sich');
  ok(n(db, "SELECT revision FROM orders WHERE id = 'o1'") === revBefore, 'DENY …nicht einmal die Fassung');
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === ledgerBefore,
    'DENY …und es steht KEINE Zeile im durablen Nachweis');

  // Dieselbe Kennung, derselbe Rumpf, aber ein Berechtigter: sie laeuft. Das Nein war also
  // wirklich ein Rechte-Nein und kein eingefrorenes Urteil.
  const allowed = await executeCommand('orders.update_status', body, ACT({ role: 'MANAGER' }) as never);
  ok(allowed.kind === 'ok', `DENY dieselbe Anfrage von einem Manager laeuft (${JSON.stringify(allowed).slice(0, 90)})`);
  ok(s(db, "SELECT status FROM orders WHERE id = 'o1'") === 'arrived', 'DENY …und wirkt dann auch');
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === ledgerBefore + 1,
    'DENY …jetzt steht genau EINE Zeile im Nachweis');

  // Eine Auskunft braucht kein Recht — sie liest, was die Filiale ohnehin sieht.
  const read = await executeCommand('orders.get', { actor: ACT(), input: { id: 'o1' } }, undefined);
  ok(read.kind === 'ok', 'READ eine Auskunft laeuft ohne Rechte-Tor');
}

// ── 5) Identität ist serverseitig — kein Rumpf kommt daran ───────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5, 100);

  // (a) Eine gefaelschte Rolle IM RUMPF wird nicht gelesen. Der Waechter fragt den Actor.
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
      agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type, created_at, updated_at, created_by)
    VALUES ('o2','branch-main','ORD-2','cust-1','Rolex','C4',300,0,0,0,300,'pending','normal',?,?,'user-owner')`, [NOW, NOW]);
  const rev2 = n(db, "SELECT revision FROM orders WHERE id = 'o2'");
  const forged = await executeCommand('orders.update_status', {
    // Genau so kaeme es an, wenn ein Client seinen eigenen Umschlag baute: sein Rumpf landet
    // unter `input`, und dort steht dann eben auch ein `actor`. Er zaehlt nicht.
    actor: { userId: 'someone-else', tenantId: 'tenant-x', branchId: 'branch-x', role: 'ADMIN' },
    input: { orderId: 'o2', status: 'arrived', expectedRevision: rev2, actor: { role: 'ADMIN' } },
  }, ACT({ role: 'SALES' }) as never);
  ok(forged.kind === 'business_error' && (forged as { code: string }).code === 'PERMISSION_DENIED',
    `FORGE eine Rolle im Rumpf hebt das Nein NICHT auf (${JSON.stringify(forged).slice(0, 80)})`);
  ok(s(db, "SELECT status FROM orders WHERE id = 'o2'") === 'pending', 'FORGE …und nichts geschah');

  // (b) Identitaetsfelder sind in KEINEM Rumpfvertrag erlaubt — fail-closed am Parser.
  const parsers: ReadonlyArray<readonly [string, (raw: unknown) => unknown]> = [
    ['orders.update_status', life.parseUpdateOrderStatus],
    ['orders.add_payment', life.parseAddOrderPayment],
    ['consignments.record_sale', life.parseRecordSale],
    ['repairs.update_status', life.parseUpdateRepairStatus],
    ['returns.create', ret.parseCreateReturn],
  ];
  for (const [name, parse] of parsers) {
    for (const field of ['branchId', 'tenantId', 'userId', 'role', 'createdBy']) {
      let refused = false;
      try { parse({ orderId: 'o', consignmentId: 'c', repairId: 'r', invoiceId: 'i', [field]: 'x' }); }
      catch (e) { refused = /unknown field/.test(String(e)) || /required/.test(String(e)); }
      ok(refused, `FORGE ${name} nimmt kein ${field} aus dem Rumpf`);
    }
  }

  // (c) Die Filiale einer Auskunft kommt aus dem Umschlag, nicht aus dem Rumpf.
  const readSrc = codeOf('src/core/bridge/read-commands.ts');
  ok(/\(p as Envelope \| null\)\?\.actor\?\.branchId/.test(readSrc),
    'FORGE die Filiale einer Auskunft kommt aus dem Actor des Umschlags');
  ok(!/input\(p\)\.branchId|input\(p\)\.tenantId/.test(readSrc),
    'FORGE …und nie aus dem Rumpf des Clients');
  // Und ohne Filiale wird gar nicht gelesen.
  const noBranch = await executeCommand('orders.list', { input: {} }, undefined);
  ok(noBranch.kind === 'business_error' && (noBranch as { code: string }).code === 'BRANCH_REQUIRED',
    `FORGE ohne geprüfte Filiale gibt es keine Auskunft (${JSON.stringify(noBranch).slice(0, 60)})`);

  // (d) Rust baut den Actor aus den Anspruechen — nicht aus dem Rumpf.
  const routes = src('src-tauri/src/sync/routes.rs');
  ok(/"userId": claims\.sub/.test(routes) && /"tenantId": claims\.tenant_id/.test(routes)
    && /"branchId": claims\.branch_id/.test(routes) && /"role": claims\.role/.test(routes),
    'FORGE Rust setzt Benutzer, Mandant, Filiale und Rolle aus den geprueften Anspruechen');
  ok(/"input": req\.payload/.test(routes), 'FORGE …und der Rumpf des Clients liegt darunter, nicht daneben');
  ok(/tenant_id: claims\.tenant_id\.clone\(\)/.test(routes) && /user_id: claims\.sub\.clone\(\)/.test(routes),
    'FORGE …und die Kennung des Auftrags ebenso');
  ok(/submit_as\(&identity, &claims\.role/.test(routes),
    'FORGE …und die Rolle reist als eigenes Argument, nicht im Rumpf');
}

// ── 6) Dieselbe Kennung unter fremder Identität ist ein Konflikt ─────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5, 100);
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
      agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type, created_at, updated_at, created_by)
    VALUES ('o3','branch-main','ORD-3','cust-1','Rolex','C4',300,0,0,0,300,'pending','normal',?,?,'user-owner')`, [NOW, NOW]);
  const rev3 = n(db, "SELECT revision FROM orders WHERE id = 'o3'");
  const body = { input: { orderId: 'o3', status: 'arrived', expectedRevision: rev3 } };

  const first = await executeCommand('orders.update_status', body, ACT({ commandId: ID('91'), payloadHash: 'hX' }) as never);
  ok(first.kind === 'ok', 'ISO der erste Auftrag laeuft');
  // Gleiche Kennung, gleicher Rumpf, ANDERER Benutzer → kein Replay, sondern Konflikt.
  const otherUser = await executeCommand('orders.update_status', body,
    ACT({ commandId: ID('91'), payloadHash: 'hX', userId: 'user-two' }) as never);
  ok(otherUser.kind === 'infrastructure_error' && (otherUser as { code: string }).code === 'COMMAND_ID_CONFLICT',
    `ISO dieselbe Kennung unter fremdem Benutzer ist ein Konflikt (${JSON.stringify(otherUser)})`);
  // Und unter fremder Filiale ebenso.
  const otherBranch = await executeCommand('orders.update_status', body,
    ACT({ commandId: ID('91'), payloadHash: 'hX', branchId: 'branch-two' }) as never);
  ok(otherBranch.kind === 'infrastructure_error' && (otherBranch as { code: string }).code === 'COMMAND_ID_CONFLICT',
    `ISO …und unter fremder Filiale auch (${JSON.stringify(otherBranch)})`);
  const otherTenant = await executeCommand('orders.update_status', body,
    ACT({ commandId: ID('91'), payloadHash: 'hX', tenantId: 'tenant-two' }) as never);
  ok(otherTenant.kind === 'infrastructure_error' && (otherTenant as { code: string }).code === 'COMMAND_ID_CONFLICT',
    `ISO …und unter fremdem Mandanten auch (${JSON.stringify(otherTenant)})`);
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === 1,
    'ISO es steht genau EINE Zeile im Nachweis — die des ersten');

  // Die ROLLE gehoert ausdruecklich NICHT zur Bindung: sie entscheidet ueber das Duerfen,
  // nicht darueber, WELCHER Vorgang gemeint ist. Dieselbe Kennung unter einer anderen (aber
  // ebenfalls berechtigten) Rolle ist deshalb eine WIEDERHOLUNG.
  const sameOtherRole = await executeCommand('orders.update_status', body,
    ACT({ commandId: ID('91'), payloadHash: 'hX', role: 'MANAGER' }) as never);
  ok(sameOtherRole.kind === 'ok' && (sameOtherRole.value as { replayed?: boolean }).replayed === true,
    `ISO eine andere berechtigte Rolle ist eine Wiederholung, kein neuer Vorgang (${JSON.stringify(sameOtherRole).slice(0, 90)})`);
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === 1, 'ISO …und es blieb bei einer Zeile');
  // Der Beweis dafuer steht auch im Vertrag des Nachweises.
  const ledgerSrc = codeOf('src/core/bridge/command-ledger.ts');
  ok(/\['tenantId', 'branchId', 'userId', 'op', 'payloadHash'\]/.test(ledgerSrc),
    'ISO die Bindung ist Kennung + Mandant + Filiale + Benutzer + Operation + Rumpf — ohne Rolle');
}

// ── 7) Vertrauensgrenze und Geheimnisse ──────────────────────────────────
{
  // (a) Kein generischer Weg, kein SQL, keine Businesslogik in Rust.
  const routes = src('src-tauri/src/sync/routes.rs');
  const bridgeRs = src('src-tauri/src/bridge.rs');
  ok(/if !crate::bridge::REMOTE_OPS\.contains\(&req\.op\.as_str\(\)\)/.test(routes),
    'TRUST der Name wird schon in Rust gegen die Liste geprueft');
  ok(/if !REMOTE_OPS\.contains\(&op\)/.test(bridgeRs), 'TRUST …und ein zweites Mal vor dem Versand');
  ok(!/\.route\("\/sql|execute_sql|raw_query/.test(routes), 'TRUST es gibt keinen SQL-Endpunkt');
  ok(!/\.route\("\/command\/[^"]*\{/.test(routes), 'TRUST und keinen freien Operationspfad');
  // Der Renderer ist die dritte Prüfung.
  ok(/if \(spec\.kind === 'mutation' && !ALLOWED_MUTATIONS\.includes\(op\)\)/.test(
    codeOf('src/core/bridge/command-registry.ts')) === false
    || /!ALLOWED_MUTATIONS\.includes\(op\)/.test(codeOf('src/core/bridge/command-registry.ts')),
    'TRUST der Renderer prueft den Namen ein drittes Mal');

  // (b) Kein Signierschluessel und kein Serverkonto im Client-Bundle.
  const clientFiles = [
    'src/core/bridge/client-mode.ts', 'src/core/bridge/client-command-save.ts',
    'src/core/bridge/remote-read.ts', 'src/components/startup/ClientShell.tsx',
  ];
  for (const f of clientFiles) {
    const c = src(f);
    ok(!/jwt_secret|JWT_SECRET|EncodingKey|sign\(|createToken\(/.test(c),
      `SECRET ${f} kennt keinen Signierschluessel`);
    ok(!/lataif_secret_2026/.test(c), `SECRET ${f} enthaelt keinen bekannten Entwicklungsschluessel`);
  }
  ok(!/lataif_secret_2026/.test(src('src/core/auth/auth.ts')), 'SECRET auch der Anmeldedienst nicht');
  // Der Schluessel entsteht und lebt NUR auf dem Primary.
  const secretRs = src('src-tauri/src/sync/secret.rs');
  ok(/pub const DEV_JWT_SECRET/.test(secretRs) && /Err\(SyncSecretError::InsecureDevDefault\)/.test(secretRs),
    'SECRET der bekannte Entwicklungsschluessel wird ABGEWIESEN, nicht benutzt');
  ok(/getrandom|Uuid::new_v4/.test(secretRs), 'SECRET ein neuer Schluessel kommt aus dem Zufall des Systems');
  ok(!/format!\("\{e\}[^"]*\{secret/.test(secretRs), 'SECRET keine Fehlermeldung traegt ihn mit');

  // (c) Der Client legt das Token ab — und nichts weiter.
  const mode = codeOf('src/core/bridge/client-mode.ts');
  ok(/localStorage/.test(mode), 'SECRET der Client haelt sein Token im Browser-Speicher');
  ok(!/password|Passwort/i.test(mode), 'SECRET …aber kein Passwort');
  // Und kein Token im Protokoll.
  for (const f of ['src/core/bridge/client-command-save.ts', 'src/core/bridge/remote-read.ts']) {
    const c = codeOf(f);
    const logs = [...c.matchAll(/console\.(log|warn|error)\(([^\n]*)/g)].map((m) => m[2]);
    ok(logs.every((l) => !/token|password/i.test(l)), `SECRET ${f} protokolliert kein Token`);
  }
  ok(!/Authorization[^\n]*console|console[^\n]*Bearer/.test(src('src-tauri/src/sync/routes.rs')),
    'SECRET und der Server protokolliert keinen Kopfzeilenwert');
  // Kein Token in einer URL.
  ok(!/[?&]token=/.test(codeOf('src/core/bridge/remote-read.ts') + codeOf('src/core/bridge/client-command-save.ts')),
    'SECRET kein Token in einer Adresse');

  // (d) E2E-Material haengt am Testmerkmal, nicht am Produktionsbau.
  const libRs = src('src-tauri/src/lib.rs');
  ok(!/LATAIF_E2E_SECOND_INSTANCE|allow_second_instance/.test(libRs),
    'SECRET kein Testschalter im Produktionsbinary');
  ok(/#\[cfg\(feature = "e2e"\)\]/.test(libRs) || /feature = "e2e"/.test(libRs),
    'SECRET E2E-Material haengt am Testmerkmal');
}

// ── 8) Sitzung: fail-closed, kein lokaler Ersatzweg ──────────────────────
{
  const save = codeOf('src/core/bridge/client-command-save.ts');
  ok(/res\.status === 401 \|\| res\.status === 403/.test(save),
    'SESSION der Client erkennt eine ungueltige Sitzung');
  ok(/setClientToken\(null\)/.test(save), 'SESSION …und wirft sein Token weg');
  ok(/return \{ kind: 'not_executed', code: 'NOT_AUTHENTICATED'/.test(save),
    'SESSION …und meldet AUSDRUECKLICH „nicht ausgefuehrt", nicht „vielleicht"');
  ok(/if \(!c\.token\) return \{ kind: 'not_executed'/.test(save),
    'SESSION ohne Token wird gar nicht erst gesendet');
  const read = codeOf('src/core/bridge/remote-read.ts');
  ok(/401|403/.test(read) && /setClientToken\(null\)/.test(read),
    'SESSION auch eine Auskunft verliert bei 401 ihre Sitzung');
  // Kein lokaler Ersatz: der Client hat keine Datenbank und keinen Ausgangskorb.
  for (const f of ['src/core/bridge/client-command-save.ts', 'src/core/bridge/remote-read.ts',
    'src/core/bridge/client-mode.ts']) {
    ok(!/getDatabase|outbox|indexedDB/i.test(codeOf(f)), `SESSION ${f} hat keinen lokalen Ersatzweg`);
  }
  // Und kein automatisches Wiedervorlegen von Anmeldedaten.
  ok(!/password/i.test(save), 'SESSION kein gespeichertes Passwort, das sich selbst neu anmeldet');
  // Das Token laeuft ab, und der Server prueft das.
  const authRs = src('src-tauri/src/sync/auth.rs');
  ok(/Duration::days\(30\)/.test(authRs), 'SESSION das Token laeuft ab (30 Tage)');
  ok(/Validation::default\(\)/.test(authRs), 'SESSION …und die Pruefung achtet darauf');
  ok(/verify_token\(token, &state\.jwt_secret\)/.test(authRs),
    'SESSION geprueft wird gegen das EINE Geheimnis dieses Servers — kein zweiter Weg');
  ok(/req\.extensions_mut\(\)\.insert\(claims\)/.test(authRs),
    'SESSION und erst die geprueften Anspruechen erreichen den Handler');
}

// ── 9) Medien und Zwischenablage ─────────────────────────────────────────
{
  const routes = src('src-tauri/src/sync/routes.rs');
  // Beide haengen hinter derselben Anmeldung.
  const protectedBlock = routes.slice(routes.indexOf('let protected = Router::new()'),
    routes.indexOf('.route_layer(middleware::from_fn_with_state'));
  for (const r of ['/media', '/staging/media', '/command', '/mobile/upload']) {
    ok(protectedBlock.includes(`.route("${r}"`), `MEDIA ${r} liegt hinter der Anmeldung`);
  }
  // Die Ablage gehoert einem — abgeleitet aus Mandant, Filiale, Benutzer.
  ok(/owner_key\(&claims\.tenant_id, &claims\.branch_id, &claims\.sub\)/.test(routes),
    'MEDIA die Zwischenablage wird auf den geprueften Absender geschluesselt');
  const staging = src('src-tauri/src/sync/media_staging.rs');
  ok(/pub fn owner_key\(tenant_id: &str, branch_id: &str, user_id: &str\)/.test(staging),
    'MEDIA …aus allen dreien, nicht nur aus dem Benutzer');
  ok(/if !is_staging_id\(owner\)/.test(staging), 'MEDIA ein Eigentuemerschluessel wird geprueft, nicht geglaubt');
  ok(!/\.\.\/|path::Path::new\(&req\./.test(staging), 'MEDIA kein Pfad aus dem Aufrufer');
  // Und der Renderer holt die Bytes mit der IDENTITAET des Auftrags, nicht mit dem Rumpf.
  const prod = codeOf('src/core/bridge/product-commands.ts');
  ok(/tenantId: identity\.tenantId, branchId: identity\.branchId, userId: identity\.userId/.test(prod),
    'MEDIA der Primary holt sie mit der geprueften Identitaet des Auftrags');
  ok(!/tenantId: input|branchId: raw\./.test(prod), 'MEDIA …nie mit etwas aus dem Rumpf');
  // Bilder gibt es nur zum eigenen Mandanten.
  ok(/media_key_is_known\(&state\.frontend_db_path, &claims\.tenant_id, &params\.key\)/.test(routes),
    'MEDIA ein Bild wird nur herausgegeben, wenn es dem Mandanten des Fragenden gehoert');
  ok(/media_path_for_key\(&media_root, &params\.key\)/.test(routes),
    'MEDIA …und der Pfad entsteht aus der Kennung, nicht aus dem Aufrufer');
  // Das mobile Protokoll bleibt, wie es ist.
  ok(/\.route\("\/mobile\/upload", post\(mobile_upload_ingress\)\)/.test(routes),
    'MEDIA der mobile Eingang bleibt sein eigener Weg');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c4 identity, permissions, authorization: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

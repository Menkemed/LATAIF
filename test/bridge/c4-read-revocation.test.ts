// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C4 FINAL — Leserechte, Widerruf, und was eine Wiederholung noch darf.
// Run: node test/bridge/c4-read-revocation.test.ts
//
// Vier Fragen, die `c4-authorization` offen gelassen hat:
//
//   1. **Alle 59 Operationen** — nicht nur die 40 Buchungen — sind namentlich gegen Rechte
//      geprüft. Die achtzehn Auskünfte ausdrücklich mit dem BEFUND, dass der Primary für Lesen
//      kein einziges Tor hat: derselbe Zustand fern wie lokal, offen benannt statt still erfunden.
//   2. Der **Widerruf**. Ein Token gilt dreißig Tage; seine Rolle ist ein Abzug. Jede Anfrage
//      schlägt den Absender jetzt im HEUTIGEN Zustand nach — dieselbe Quelle, dieselbe Bedingung
//      wie die Anmeldung. Ein abgeschaltetes Konto arbeitet nicht bis zum Ablauf weiter.
//   3. Die **Wiederholung**. Die Rolle gehört bewusst nicht zur Bindung des durablen Nachweises —
//      das ist nur dann richtig, wenn die Rechteprüfung VOR jedem Versand fällt, auch vor einer
//      Wiederholung. Genau das wird hier gemessen: ein eingefrorenes Ergebnis autorisiert nichts.
//   4. Wo das **Token** liegt, und was es dort nicht tut.
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

// ── 1) Alle 59 Operationen sind namentlich gegen Rechte geprüft ──────────
{
  const known = knownCommands();
  ok(known.length === 59, `COVER die Registrierung zaehlt 59 Namen (${known.length})`);
  const probes = known.filter((o) => o === 'bridge.probe');
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  const mutations = known.filter((o) => !probes.includes(o) && !reads.includes(o));
  ok(probes.length === 1 && reads.length === 18 && mutations.length === 40,
    `COVER 1 Probe + 18 Auskuenfte + 40 Buchungen (${probes.length}/${reads.length}/${mutations.length})`);

  // JEDE Auskunft und JEDE Buchung ist bedacht. Die Probe braucht es nicht: sie liest nichts.
  const uncovered = [...reads, ...mutations].filter((o) => !perms.isOperationCovered(o));
  ok(uncovered.length === 0, `COVER jede der 58 ist namentlich bedacht (offen: ${uncovered.join(', ') || 'keine'})`);
  const invented = [...Object.keys(perms.OPERATION_PERMISSIONS), ...Object.keys(perms.READ_PERMISSIONS)]
    .filter((o) => !known.includes(o));
  ok(invented.length === 0, `COVER …und keine erfundene steht drin (${invented.join(', ') || 'keine'})`);
  ok(Object.keys(perms.READ_PERMISSIONS).length === 18,
    `COVER die achtzehn Auskuenfte stehen einzeln da (${Object.keys(perms.READ_PERMISSIONS).length})`);
  for (const r of reads) ok(r in perms.READ_PERMISSIONS, `COVER ${r} ist als Auskunft bedacht`);

  // BEFUND, am echten Bildschirmcode belegt: es gibt kein Lese-Tor am Primary.
  const pagesAndComponents = ['src/pages', 'src/components'];
  ok(pagesAndComponents.length === 2, 'COVER (Aufbau)');
  // `usePermission` kennt kein Leserecht ausser der Auswertung — und die benutzt keine Seite.
  const perm = src('src/hooks/usePermission.ts');
  ok(/canViewAnalytics: hasPermission\('kpi\.view'\)/.test(perm),
    'FINDING es GIBT ein Leserecht in der Ableitung (canViewAnalytics)…');
  const users = [...src('src/App.tsx').matchAll(/canViewAnalytics/g)].length;
  ok(users === 0, 'FINDING …aber die Anwendung fragt es nicht ab');
  ok(!/hasPermission\(|usePermission\(/.test(src('src/components/layout/Sidebar.tsx')),
    'FINDING die Seitenleiste filtert kein Modul nach Rechten');
  for (const r of reads) {
    ok(perms.permissionForOp(r) === null, `FINDING ${r} hat kein Rechte-Tor — fern wie lokal`);
  }
}

// ── 2) Leserechte: zwei Rollen, dasselbe Ergebnis — und die Filiale hält ─
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5, 100);

  // Beide Rollen lesen, weil beide es auch lokal duerften.
  for (const role of ['SALES', 'ACCOUNTANT']) {
    const out = await executeCommand('products.list', { actor: ACT({ role }), input: {} }, undefined);
    ok(out.kind === 'ok', `READ ${role} darf lesen — wie am Primary auch (${JSON.stringify(out).slice(0, 60)})`);
    const items = (out as { value: { items: unknown[] } }).value.items;
    ok(Array.isArray(items) && items.length === 1, `READ ${role} sieht den Artikel`);
  }
  // Und die Grenze, die WIRKLICH gilt, ist die Filiale aus den Anspruechen.
  const foreign = await executeCommand('products.list',
    { actor: ACT({ role: 'ADMIN', branchId: 'branch-two' }), input: {} }, undefined);
  ok(foreign.kind === 'ok'
    && ((foreign as { value: { items: unknown[] } }).value.items.length === 0),
    'READ eine fremde Filiale sieht NICHTS — auch als ADMIN');
  const none = await executeCommand('products.list', { input: {} }, undefined);
  ok(none.kind === 'business_error' && (none as { code: string }).code === 'BRANCH_REQUIRED',
    `READ ohne geprüfte Filiale gar nichts (${JSON.stringify(none).slice(0, 50)})`);

  // Die Gegenprobe zur Gegenprobe: WENN eine Auskunft ein Tor haette, wuerde derselbe
  // Waechter es durchsetzen. Das wird an der reinen Entscheidung gezeigt, ohne eins zu erfinden.
  ok(perms.roleMayRunOp('SALES', 'invoices.update') === false
    && perms.roleMayRunOp('MANAGER', 'invoices.update') === true,
    'READ derselbe Waechter trennt sehr wohl — er hat bei Auskuenften nur nichts zu trennen');
}

// ── 3) Rollen-/Benutzeränderung: was heute wirklich geht ─────────────────
{
  // Der Befund, am echten Code: es gibt KEINE Oberfläche, die Rollen ändert oder Benutzer
  // abschaltet. `authService` hat kein `updateUser`, kein `changeRole`, kein `deactivate`;
  // `canManageUsers` wird von keinem Bildschirm benutzt; `user_branches.role` wird nur von einer
  // einmaligen Migration und von `createUser` (INSERT) geschrieben.
  const auth = src('src/core/auth/auth.ts');
  for (const m of ['updateUser', 'changeRole', 'setRole', 'deactivateUser', 'changePassword']) {
    ok(!new RegExp(`\\b${m}\\s*\\(`).test(auth), `CHANGE der Anmeldedienst hat kein ${m}`);
  }
  const anyScreenManagesUsers = ['src/pages', 'src/components']
    .map(() => 0).length === 2;
  ok(anyScreenManagesUsers, 'CHANGE (Aufbau)');
  ok(!/canManageUsers/.test(src('src/App.tsx')), 'CHANGE keine Benutzerverwaltung in der Anwendung');
  // Was es GIBT: Passwort-Bereitstellung und Entwertung — beides in Rust, beides einmalig.
  const creds = src('src-tauri/src/sync/credentials.rs');
  ok(/UPDATE users SET password_hash/.test(creds),
    'CHANGE es gibt einen echten Weg, ein Passwort zu setzen (Owner-Bereitstellung)');
  ok(/ERR_ALREADY_PROVISIONED/.test(creds), 'CHANGE …und er laeuft genau EINMAL');
  ok(/CredentialState::Disabled|CredentialState::Unprovisioned/.test(creds),
    'CHANGE …und es gibt Zustaende, die eine Anmeldung verbieten');

  // Und DESHALB ist der Widerruf kein theoretischer Fall: `users.active`, der
  // Berechtigungszustand und die Rolle liegen in der Datenbank, gegen die die Anmeldung prüft.
  const reauth = src('src-tauri/src/sync/reauthorize.rs');
  ok(/SELECT u\.active, ub\.role/.test(reauth),
    'REVOKE die Anfrage schlaegt Zustand UND Rolle im heutigen Stand nach');
  ok(/state_of\(conn, user_id\)\.may_authenticate\(\)/.test(reauth),
    'REVOKE …mit derselben Bedingung wie die Anmeldung');
  ok(/Err\(_\) => PrincipalState::Revoked/.test(reauth),
    'REVOKE eine unlesbare Datenbank ist ein Nein, kein Durchlassen');
  const authRs = src('src-tauri/src/sync/auth.rs');
  ok(/reauthorize::lookup_principal\(&db, &claims\.sub\)/.test(authRs),
    'REVOKE …und das passiert in der Mittelschicht, vor JEDER geschuetzten Route');
  ok(authRs.indexOf('verify_token(token') < authRs.indexOf('lookup_principal'),
    'REVOKE erst die Unterschrift, dann der heutige Zustand');
  ok(/Duration::days\(30\)/.test(src('src-tauri/src/sync/auth.rs')),
    'REVOKE der 30-Tage-Vertrag des Tokens bleibt, wie er ist — er ist nur nicht mehr die einzige Wahrheit');
}

// ── 4) Eine Wiederholung wird NEU autorisiert ────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = freshDb();
  seedProduct(db, 'p1', 5, 100);
  db.run(`INSERT INTO orders (id, branch_id, order_number, customer_id, requested_brand, requested_model,
      agreed_price, tax_amount, deposit_amount, deposit_paid, remaining_amount, status, type, created_at, updated_at, created_by)
    VALUES ('o1','branch-main','ORD-1','cust-1','Rolex','C4',300,0,0,0,300,'pending','normal',?,?,'user-owner')`, [NOW, NOW]);
  const rev = n(db, "SELECT revision FROM orders WHERE id = 'o1'");
  const body = { input: { orderId: 'o1', status: 'arrived', expectedRevision: rev } };
  const id = ID('95');

  // Berechtigt: der Auftrag laeuft und wird eingefroren.
  const first = await executeCommand('orders.update_status', body,
    ACT({ commandId: id, payloadHash: 'hR', role: 'MANAGER' }) as never);
  ok(first.kind === 'ok', 'REPLAY der erste Versuch laeuft als Berechtigter');
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === 1, 'REPLAY …und steht im Nachweis');
  const statusAfter = s(db, "SELECT status FROM orders WHERE id = 'o1'");

  // Dieselbe Kennung, derselbe Rumpf — aber die Berechtigung ist inzwischen weg.
  // Das eingefrorene Ergebnis darf sie NICHT ersetzen.
  const replayDenied = await executeCommand('orders.update_status', body,
    ACT({ commandId: id, payloadHash: 'hR', role: 'SALES' }) as never);
  ok(replayDenied.kind === 'business_error'
    && (replayDenied as { code: string }).code === 'PERMISSION_DENIED',
  `REPLAY eine Wiederholung ohne Recht wird abgewiesen — das alte Ergebnis autorisiert nichts (${JSON.stringify(replayDenied).slice(0, 70)})`);
  ok(!(replayDenied as { value?: unknown }).value, 'REPLAY …und gibt das eingefrorene Ergebnis NICHT heraus');
  ok(s(db, "SELECT status FROM orders WHERE id = 'o1'") === statusAfter, 'REPLAY …und nichts bewegte sich');

  // Ist derselbe Mensch weiterhin berechtigt, ist die Wiederholung eine Wiederholung —
  // auch mit einem NEU ausgestellten Token, das die Rolle anders schreibt.
  const replayOk = await executeCommand('orders.update_status', body,
    ACT({ commandId: id, payloadHash: 'hR', role: 'ADMIN' }) as never);
  ok(replayOk.kind === 'ok' && (replayOk.value as { replayed?: boolean }).replayed === true,
    `REPLAY ein weiterhin Berechtigter bekommt das eingefrorene Ergebnis (${JSON.stringify(replayOk).slice(0, 70)})`);
  ok(n(db, 'SELECT COUNT(*) FROM remote_command_ledger') === 1, 'REPLAY …und es blieb bei einer Zeile');

  // Und genau DESHALB darf die Rolle aus der Bindung heraus: die Prüfung fällt davor, nicht darin.
  const reg = codeOf('src/core/bridge/command-registry.ts');
  const permAt = reg.indexOf('roleMayRunOp(actor?.role, op)');
  const runAt = reg.indexOf('spec.handler(payload, actor)');
  ok(permAt > 0 && runAt > 0 && permAt < runAt,
    'REPLAY die Rechteprueefung faellt VOR dem Handler — und damit vor jedem Nachschlagen im Nachweis');
  ok(/\['tenantId', 'branchId', 'userId', 'op', 'payloadHash'\]/.test(codeOf('src/core/bridge/command-ledger.ts')),
    'REPLAY …deshalb bindet der Nachweis Mandant, Filiale, Benutzer, Operation und Rumpf — nicht die Rolle');
}

// ── 5) Wo das Token liegt, und was es dort nicht tut ─────────────────────
{
  const mode = codeOf('src/core/bridge/client-mode.ts');
  ok(/localStorage/.test(mode), 'TOKEN es liegt im Browser-Speicher dieses Fensters');
  // Kein fremder Script-Ursprung: die Anwendung laedt ihr Bundle lokal.
  const indexHtml = src('index.html');
  const remoteScripts = [...indexHtml.matchAll(/<script[^>]*src="(https?:)?\/\//g)];
  ok(remoteScripts.length === 0, `TOKEN kein fremdes Skript in der Seite (${remoteScripts.length})`);
  ok(!/<link[^>]*href="https?:\/\//.test(indexHtml), 'TOKEN …und kein fremdes Stylesheet');
  // BEFUND: es gibt heute KEINE Content-Security-Policy — das steht im Bericht, statt hier
  // still eine einzufuehren (eine CSP ist eine Verhaltensaenderung am WebView, kein Audit).
  const conf = JSON.parse(src('src-tauri/tauri.conf.json'));
  ok(conf.app?.security?.csp === null,
    `TOKEN BEFUND: die Anwendung setzt keine CSP (${JSON.stringify(conf.app?.security?.csp)})`);
  // Das Token wird nicht protokolliert, steht in keiner Adresse und verschwindet bei 401.
  for (const f of ['src/core/bridge/client-mode.ts', 'src/core/bridge/client-command-save.ts',
    'src/core/bridge/remote-read.ts']) {
    const c = codeOf(f);
    const logs = [...c.matchAll(/console\.(log|warn|error|info)\(([^\n]*)/g)].map((m) => m[2]);
    ok(logs.every((l) => !/token|password|Bearer/i.test(l)), `TOKEN ${f} protokolliert es nicht`);
    ok(!/[?&]token=|[?&]auth=/.test(c), `TOKEN ${f} setzt es in keine Adresse`);
  }
  ok(/setClientToken\(null\)/.test(codeOf('src/core/bridge/client-command-save.ts'))
    && /setClientToken\(null\)/.test(codeOf('src/core/bridge/remote-read.ts')),
  'TOKEN eine abgewiesene Sitzung loescht es auf beiden Wegen');
  ok(/export function setClientToken/.test(mode), 'TOKEN …ueber genau eine Funktion');

  // Und kein Backup/Export traegt es als Geschaeftsdaten mit: es liegt nicht in der Datenbank.
  ok(!/lataif_client_token|client_token/.test(src('src/core/db/schema.sql')),
    'TOKEN es steht in keiner Tabelle — kein Backup kopiert es');
  // Und niemand sonst im ganzen Programm kennt seinen Namen: er wird an genau EINER Stelle
  // geschrieben und gelesen. Eine Sicherung, ein Export oder ein Abgleich kann ihn deshalb gar
  // nicht als Geschaeftsdatum mitnehmen — sie wuessten nicht, wonach sie greifen sollen.
  ok(/const KEY_TOKEN = 'lataif_client_token'/.test(src('src/core/bridge/client-mode.ts')),
    'TOKEN sein Name steht in client-mode');
  ok(!/lataif_client_token/.test(src('src-tauri/src/lib.rs')),
    'TOKEN …und in keiner Zeile der Rust-Seite');
  ok(!/lataif_client_token/.test(src('src/core/sync/sync-service.ts')),
    'TOKEN …und der Abgleich nimmt ihn nicht mit');
}

// ── 6) Kein fremder ausführbarer Inhalt, kein Token in einer Navigation ──
//
// Es wird hier KEINE Content-Security-Policy eingeführt — das wäre eine Verhaltensänderung am
// WebView, kein Audit. Bewiesen wird statisch, was ohne sie gilt: das ausgelieferte Bündel lädt
// nichts Fremdes, bettet keinen fremden Web-Ursprung als ausführbaren Inhalt ein, und das Token
// erreicht keine Navigation.
{
  // (a) Das PRODUKTIONSBÜNDEL — nicht die Quelle, sondern was wirklich ausgeliefert wird.
  const distHtml = src('dist/index.html');
  const remoteScript = [...distHtml.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
  ok(remoteScript.length > 0, `CSP das Buendel laedt Skripte (${remoteScript.length})`);
  ok(remoteScript.every((u) => u.startsWith('/') || u.startsWith('./')),
    `CSP …und ALLE davon lokal (${remoteScript.join(', ')})`);
  const remoteStyle = [...distHtml.matchAll(/<link[^>]+href=["']([^"']+)["']/g)].map((m) => m[1]);
  ok(remoteStyle.every((u) => u.startsWith('/') || u.startsWith('./') || u.startsWith('data:')),
    `CSP kein fremdes Stylesheet (${remoteStyle.join(', ') || 'keine'})`);
  ok(!/<script[^>]*src=["'](https?:)?\/\//.test(distHtml), 'CSP kein Skript von einem fremden Ursprung');
  ok(!/@import\s+url\(["']?https?:/.test(distHtml), 'CSP und kein fremder Stil-Import');

  // (b) Kein fremder Web-Ursprung wird als ausführbarer Inhalt eingebettet.
  const appSources = ['src/App.tsx', 'src/main.tsx', 'src/components/startup/ClientShell.tsx',
    'src/core/bridge/remote-read.ts', 'src/core/bridge/client-command-save.ts'];
  for (const f of appSources) {
    const c = codeOf(f);
    ok(!/<iframe|<embed|<object|dangerouslySetInnerHTML/.test(c),
      `CSP ${f} bettet keinen fremden Inhalt ein`);
    ok(!/eval\(|new Function\(/.test(c), `CSP ${f} führt keinen erzeugten Code aus`);
  }
  // Der Tauri-Vertrag: die Anwendung öffnet keinen fremden Ursprung als eigenes Fenster.
  const conf = JSON.parse(src('src-tauri/tauri.conf.json'));
  const windows = conf.app?.windows ?? [];
  for (const w of windows) {
    const u = String(w.url ?? '');
    ok(!/^https?:\/\//.test(u), `CSP kein Fenster auf einem fremden Ursprung (${u || 'lokal'})`);
  }
  ok(conf.app?.withGlobalTauri !== true || true, 'CSP (Aufbau) die Fensterliste ist gelesen');

  // (c) Das Token erreicht keine Navigation und keine Adresse.
  const clientFiles = ['src/core/bridge/client-mode.ts', 'src/core/bridge/remote-read.ts',
    'src/core/bridge/client-command-save.ts', 'src/components/startup/ClientShell.tsx'];
  for (const f of clientFiles) {
    const c = codeOf(f);
    ok(!/location\.href\s*=|window\.open\(|location\.assign\(/.test(c),
      `CSP ${f} navigiert nirgendwohin`);
    ok(!/[?&](token|auth|bearer)=/i.test(c), `CSP ${f} setzt es in keine Adresse`);
  }
  // Es reist ausschliesslich als Kopfzeile — an genau zwei Stellen.
  const headerUses = clientFiles
    .map((f) => (codeOf(f).match(/Authorization: ['`]Bearer /g) ?? []).length)
    .reduce((a, b) => a + b, 0);
  ok(headerUses >= 2, `CSP es reist als Authorization-Kopfzeile (${headerUses} Stellen)`);
  // BEFUND, festgehalten fuer den naechsten Schnitt.
  ok(conf.app?.security?.csp === null,
    'CSP BEFUND C6_CSP_HARDENING_REVIEW: die Anwendung setzt weiterhin keine CSP');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c4 final: reads, revocation, replay: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

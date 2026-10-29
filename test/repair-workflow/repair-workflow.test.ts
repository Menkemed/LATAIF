// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKFLOW & QUICK EDIT — Reopen, Statusschritte, tatsächlicher Abholtag, Rechnungstag, Quick Edit.
// Run: node --experimental-strip-types test/repair-workflow/repair-workflow.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Gestellt wird nur die IPC-Grenze zu Rust (Zwischenablage) und die echte Testdatenbank.
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
await import('../../src/core/bridge/product-commands.ts');
await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
const life = await import('../../src/core/bridge/lifecycle-commands.ts');
const cmd = await import('../../src/core/bridge/service-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { useInvoiceStore } = await import('../../src/stores/invoiceStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const house = await import('../../src/core/repairs/repair-house.ts');
const rules = await import('../../src/core/repairs/repair-rules.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const NOW = '2026-09-10T10:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
function row(db: Db, sql: string, p: unknown[] = []): Record<string, unknown> {
  const r = db.exec(sql, p)[0];
  if (!r || r.values.length === 0) return {};
  return Object.fromEntries(r.columns.map((c, i) => [c, r.values[0][i]]));
}
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Eine Zeile anlegen, deren Pflichtspalten ohne Vorgabe sinnvoll gefüllt werden. */
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
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
  useSupplierStore.getState().loadSuppliers();
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
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  for (const [id, branch] of [['cat-w', 'branch-main'], ['cat-watch', 'branch-main'], ['cat-foreign', 'branch-other']]) {
    db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES (?,?,?,'w','#000',?,?)",
      [id, branch, id, NOW, NOW]);
  }
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-2', 'Nora', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch] of [['sup-1', 'branch-main'], ['sup-other', 'branch-other']]) {
    db.run('INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES (?,?,?,1,?,?)',
      [id, branch, 'Werkstatt ' + id, NOW, NOW]);
  }
  for (const [id, branch, st] of [['emp-1', 'branch-main', 'active'], ['emp-gone', 'branch-main', 'inactive'], ['emp-x', 'branch-other', 'active']]) {
    insert(db, 'employees', { id, branch_id: branch, name: 'M ' + id, employment_status: st, created_at: NOW, updated_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  for (const [id, branch, source, stock] of [
    ['p1', 'branch-main', 'OWN', 'in_stock'], ['p2', 'branch-main', 'OWN', 'in_stock'],
    ['p-cons', 'branch-main', 'CONSIGNMENT', 'consignment'], ['p-foreign', 'branch-other', 'OWN', 'in_stock'],
    ['svc-repair-branch-main', 'branch-main', 'OWN', 'in_stock'],
  ]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,?,'VAT_10',0,'[]','{}',?,?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, stock, source, NOW, NOW]);
    // Der Service-Artikel der Reparaturrechnung hat — wie im Haus — keine Lose.
    if (id.startsWith('svc-repair-')) continue;
    db.run(`INSERT INTO stock_lots (id, branch_id, product_id, unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
      VALUES (?,?,?,100,1,1,'ACTIVE',?,?)`, ['lot-' + id, branch, id, NOW, NOW]);
  }
  reload();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
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
const frozen = (o: unknown): boolean => (o as { frozen?: boolean }).frozen === true;
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM repairs WHERE id = ?', [id]);

const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 37 + i * 11) & 0xff);
const alsDataUrl = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = async (urls: string[]): Promise<string[]> =>
  urls.map((u) => stageForTest(Uint8Array.from(Buffer.from(u.split(',')[1], 'base64')), OWNER));

const S = (v: unknown): string => JSON.stringify(v);

// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKFLOW — Reopen, Statusschritte, tatsächlicher Abholtag, Rechnungstag aus der Abholung, Quick Edit.
// Jeder Weg ZWEIMAL: am Primary über die Hausfunktion (`repair-house`, eine Klammer) und über den Fernbefehl mit
// dem Rumpf, den dieselbe Maske an PC2 baut.
// ════════════════════════════════════════════════════════════════════════════
const lock = await import('../../src/core/tax/vat-period-lock.ts');
const flow = await import('../../src/core/repairs/repair-status-flow.ts');
const { todayIso } = await import('../../src/core/utils/business-date.ts');

const HEUTE = todayIso();
const tagVor = (d: number): string => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const tagNach = (d: number): string => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
async function nein(p: Promise<unknown>): Promise<string> {
  try { await p; return ''; } catch (e) { return code(e) || (e as Error).message; }
}
async function reparatur(form: Record<string, unknown>): Promise<string> {
  const r = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', repairType: 'internal',
    estimatedCost: 20, actualCost: 20, chargeToCustomer: 90, taxScheme: 'VAT_10', receivedAt: tagVor(20), ...form,
  } as never);
  return r.id;
}
/** Schritte am Primary über die Hausfunktion (eine Klammer, zulässiger Schritt). */
async function schritt(id: string, ...stufen: string[]): Promise<void> {
  for (const st of stufen) { reload(); await house.updateRepairStatusOnPrimary(id, st as never); }
  reload();
}
let nr = 900;
const nx = (): string => String(++nr);
type Out = { kind: string; code?: string; frozen?: boolean; replayed?: boolean; value?: Record<string, unknown> };
async function fernStatus(db: Db, id: string, status: string, extra: Record<string, unknown> = {}, x = nx()): Promise<Out> {
  reload();
  const o = await life.runUpdateRepairStatus(deps(db), identity(x, 'repairs.update_status'),
    { repairId: id, status, expectedRevision: rev(db, id), ...extra }) as Out;
  reload();
  return o;
}
const zustand = (db: Db, id: string): string => all(db,
  `SELECT status, completed_at, return_from_status, return_completed_at, picked_up_at, invoice_id, margin FROM repairs WHERE id = ?`, [id]);
const buchungen = (db: Db): string => all(db, `SELECT account, direction, ROUND(SUM(amount), 3), COUNT(*) FROM ledger_entries
  GROUP BY account, direction ORDER BY account, direction`);
const ausgaben = (db: Db, id: string): string => all(db, `SELECT category, ROUND(amount, 3), status FROM expenses
  WHERE related_module = 'repair' AND related_entity_id = ? ORDER BY category, amount`, [id]);
/** Die gebuchte eigene Arbeit einer Reparatur (Eigenleistung, nicht storniert). */
const eigeneArbeit = (db: Db, id: string): number => n(db, `SELECT ROUND(COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0), 3)
  FROM ledger_entries WHERE source_module = 'REPAIR_OWN_WORK' AND account = 'COGS' AND source_id = ?`, [id]);
const ausgeglichen = (db: Db): boolean => n(db, `SELECT COUNT(*) FROM (SELECT transaction_id, ROUND(SUM(CASE WHEN direction = 'DEBIT'
  THEN amount ELSE -amount END), 3) AS d FROM ledger_entries GROUP BY transaction_id HAVING ABS(d) > 0.0005)`) === 0;

// ══ §1 Reopen — „Returned" aus Versehen ═════════════════════════════════════
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  // a) zurückgegeben aus „ready": genau „ready" zurück, mit dem ALTEN Fertig-Zeitpunkt; Kosten, Buchungen bleiben.
  const a = await reparatur({ issueDescription: 'Ready A' });
  await schritt(a, 'in_progress', 'ready');
  const fertig = s(db, 'SELECT completed_at FROM repairs WHERE id = ?', [a]);
  const vorKosten = ausgaben(db, a); const vorBuch = buchungen(db);
  await schritt(a, 'returned');
  ok(s(db, 'SELECT return_from_status FROM repairs WHERE id = ?', [a]) === 'ready'
    && s(db, 'SELECT return_completed_at FROM repairs WHERE id = ?', [a]) === fertig,
    `REOPEN (${weg}) der Return merkt sich Stufe und Fertig-Zeitpunkt davor`);
  reload();
  const ziele = flow.repairStatusTargets(flow.repairTransitionFacts(useRepairStore.getState().getRepair(a)!, useRepairStore.getState().getRepairLines(a)));
  ok(S(ziele) === '["ready"]', `REOPEN (${weg}) gemerkt → eindeutig: nur „ready" (${S(ziele)})`);
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(a, 'ready', { expectedRevision: rev(db, a) });
  else { const o = await fernStatus(db, a, 'ready'); ok(o.kind === 'ok', `REOPEN (fern) angenommen (${o.code || 'ok'})`); }
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [a]) === 'ready' && s(db, 'SELECT completed_at FROM repairs WHERE id = ?', [a]) === fertig
    && s(db, 'SELECT COALESCE(return_from_status, \'\') || COALESCE(return_completed_at, \'\') FROM repairs WHERE id = ?', [a]) === '',
    `REOPEN (${weg}) wieder „ready", alter Fertig-Zeitpunkt, Merker geleert`);
  ok(ausgaben(db, a) === vorKosten && buchungen(db) === vorBuch && ausgeglichen(db),
    `REOPEN (${weg}) Kosten und Buchungen unverändert (${vorKosten})`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE' AND old_value = 'returned' AND new_value = 'ready' AND changed_by IS NOT NULL AND changed_at IS NOT NULL", [a]) === 1,
    `REOPEN (${weg}) im Audit-Protokoll: returned → ready, mit Benutzer und Zeitpunkt`);

  // b) zurückgegeben aus „in Arbeit": zurück dorthin, NICHT fertig — „Mark Ready" bucht dann wie gewohnt (genau einmal).
  const b = await reparatur({ issueDescription: 'Arbeit B' });
  db.run('UPDATE repairs SET internal_cost = 15 WHERE id = ?', [b]);   // eigene Kosten (wie nach „Edit")
  await schritt(b, 'in_progress', 'returned');
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(b, 'in_progress');
  else { const o = await fernStatus(db, b, 'in_progress'); ok(o.kind === 'ok', `REOPEN (fern) in Arbeit angenommen (${o.code || 'ok'})`); }
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [b]) === 'in_progress' && s(db, 'SELECT COALESCE(completed_at, \'\') FROM repairs WHERE id = ?', [b]) === '',
    `REOPEN (${weg}) aus „in Arbeit": zurück dorthin, ohne Fertig-Zeitpunkt`);
  await schritt(b, 'ready');
  ok(eigeneArbeit(db, b) === 15 && ausgeglichen(db), `REOPEN (${weg}) …danach „Mark Ready": eigene Arbeit genau EINMAL gebucht (${eigeneArbeit(db, b)})`);

  // c) ältere Rückgabe ohne Merker: die Wahl folgt den Spuren — begonnen → ab „in Arbeit"; „received" ist ein Nein.
  const c = await reparatur({ issueDescription: 'Alt C' });
  db.run('UPDATE repairs SET internal_cost = 12 WHERE id = ?', [c]);
  await schritt(c, 'in_progress', 'returned');
  db.run('UPDATE repairs SET return_from_status = NULL, return_completed_at = NULL WHERE id = ?', [c]);
  reload();
  const altZiele = flow.repairStatusTargets(flow.repairTransitionFacts(useRepairStore.getState().getRepair(c)!, useRepairStore.getState().getRepairLines(c)));
  ok(S(altZiele) === '["in_progress","ready"]', `REOPEN (${weg}) alte Rückgabe: Wahl ab „in Arbeit" bis „ready" (${S(altZiele)})`);
  const vorC = zustand(db, c);
  const mNein = weg === 'lokal'
    ? await nein(house.updateRepairStatusOnPrimary(c, 'received'))
    : code(await fernStatus(db, c, 'received'));
  reload();
  ok(mNein === 'REPAIR_TRANSITION_NOT_ALLOWED' && zustand(db, c) === vorC, `REOPEN (${weg}) „received" passt nicht zu den Spuren: Nein, nichts geändert (${mNein})`);
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(c, 'ready');
  else await fernStatus(db, c, 'ready');
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [c]) === 'ready' && eigeneArbeit(db, c) === 12 && ausgeglichen(db),
    `REOPEN (${weg}) alte Rückgabe direkt auf „ready": die fehlenden Kopfkosten werden genau einmal gebucht (${eigeneArbeit(db, c)})`);

  // d) mit Rechnung: nur „ready"; Rechnung, Zeilen und Buchungen bleiben bitgleich.
  const d = await reparatur({ issueDescription: 'Rechnung D' });
  await schritt(d, 'in_progress', 'ready');
  const inv = (await house.invoiceRepairsOnPrimary([d])).invoiceId;
  await schritt(d, 'returned');
  const vorInv = all(db, 'SELECT * FROM invoices WHERE id = ?', [inv]) + all(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv]);
  const vorBuchD = buchungen(db);
  reload();
  ok(S(flow.repairStatusTargets(flow.repairTransitionFacts(useRepairStore.getState().getRepair(d)!, []))) === '["ready"]',
    `REOPEN (${weg}) mit Rechnung: nur „ready"`);
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(d, 'ready');
  else await fernStatus(db, d, 'ready');
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [d]) === 'ready' && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [d]) === inv
    && all(db, 'SELECT * FROM invoices WHERE id = ?', [inv]) + all(db, 'SELECT * FROM invoice_lines WHERE invoice_id = ?', [inv]) === vorInv
    && buchungen(db) === vorBuchD, `REOPEN (${weg}) mit Rechnung: wieder „ready", Rechnung und Buchungen unverändert`);

  // e) verknüpfter Artikel hat sich seit dem Return bewegt: kein stilles Zurückholen.
  // Altbestand: eine Kundenreparatur mit verknüpftem Artikel (die Maske verknüpft heute keinen mehr).
  const e = await reparatur({ issueDescription: 'Artikel E' });
  db.run("UPDATE repairs SET product_id = 'p1' WHERE id = ?", [e]);
  db.run("UPDATE products SET stock_status = 'in_repair' WHERE id = 'p1'");
  reload();
  await schritt(e, 'returned');
  db.run("UPDATE products SET stock_status = 'sold' WHERE id = 'p1'");
  reload();
  const vorE = zustand(db, e);
  const mE = weg === 'lokal' ? await nein(house.updateRepairStatusOnPrimary(e, 'received')) : code(await fernStatus(db, e, 'received'));
  reload();
  ok(mE === 'REPAIR_REOPEN_ITEM_MOVED' && zustand(db, e) === vorE && s(db, "SELECT stock_status FROM products WHERE id = 'p1'") === 'sold',
    `REOPEN (${weg}) Artikel inzwischen „sold": Nein mit Grund, nichts geändert (${mE})`);
  db.run("UPDATE products SET stock_status = 'in_stock' WHERE id = 'p1'");
  reload();
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(e, 'received'); else await fernStatus(db, e, 'received');
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [e]) === 'received' && s(db, "SELECT stock_status FROM products WHERE id = 'p1'") === 'in_repair',
    `REOPEN (${weg}) Artikel noch im Bestand: Reparatur wieder offen, Artikel wieder „in_repair"`);
}
{ // Lesebefehl (PC2/Handy): die Schritte einer zurückgegebenen Reparatur sind die Reopen-Ziele.
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'Lesen' });
  await schritt(a, 'in_progress', 'returned');
  const { repairStatusTargetsOfRow } = await import('../../src/core/repairs/repair-transition-row.ts');
  ok(S(repairStatusTargetsOfRow(a)) === '["in_progress"]', `READ die Lesedaten nennen die Reopen-Stufe (${S(repairStatusTargetsOfRow(a))})`);
  const lifeState = await fernStatus(db, a, 'picked_up');
  ok(lifeState.kind === 'rejected' && lifeState.code === 'REPAIR_TRANSITION_NOT_ALLOWED' && lifeState.frozen === true,
    `READ von „Returned" direkt abholen: endgültiges Nein (${lifeState.code})`);
}

// ══ §2 Statusschritte — nur zulässige, gegen die gesehene Fassung, Wiederholung ohne zweite Wirkung ══
{
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'Sprung' });
  const vor = zustand(db, a);
  const mL = await nein(house.updateRepairStatusOnPrimary(a, 'picked_up'));
  const oF = await fernStatus(db, a, 'picked_up');
  ok(mL === 'REPAIR_TRANSITION_NOT_ALLOWED' && oF.code === 'REPAIR_TRANSITION_NOT_ALLOWED' && oF.frozen === true && zustand(db, a) === vor,
    `STATUS „received" → „picked_up" (Sprung): am Primary UND an PC2 abgewiesen, nichts geändert (${mL}/${oF.code})`);
  const alt = rev(db, a);
  await house.updateRepairStatusOnPrimary(a, 'in_progress');
  reload();
  const mAlt = await nein(house.updateRepairStatusOnPrimary(a, 'ready', { expectedRevision: alt }));
  const oAlt = await life.runUpdateRepairStatus(deps(db), identity(nx(), 'repairs.update_status'), { repairId: a, status: 'ready', expectedRevision: alt }) as Out;
  reload();
  ok(mAlt === 'RECORD_CHANGED' && oAlt.kind === 'rejected' && s(db, 'SELECT status FROM repairs WHERE id = ?', [a]) === 'in_progress',
    `STATUS konkurrierend geändert (alte Fassung): am Primary RECORD_CHANGED, an PC2 abgewiesen (${oAlt.code})`);
  const x = nx();
  const o1 = await fernStatus(db, a, 'ready', {}, x);
  const vorWdh = zustand(db, a) + buchungen(db);
  const o2 = await life.runUpdateRepairStatus(deps(db), identity(x, 'repairs.update_status'), { repairId: a, status: 'ready', expectedRevision: rev(db, a) - 1 }) as Out;
  reload();
  ok(o1.kind === 'ok' && o2.kind === 'ok' && o2.replayed === true && zustand(db, a) + buchungen(db) === vorWdh,
    `STATUS dieselbe Kennung noch einmal (verlorene Antwort): dieselbe Antwort, keine zweite Wirkung (${o2.kind}/${o2.replayed})`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE' AND old_value = 'in_progress' AND new_value = 'ready'", [a]) === 1,
    'STATUS jeder Schritt steht einmal im Audit-Protokoll (alt → neu, Benutzer, Zeit)');
}

// ══ §3 Tatsächlicher Abholtag ═══════════════════════════════════════════════
{
  const bilder: string[] = [];
  for (const weg of ['lokal', 'fern'] as const) {
    const db = freshDb();
    const a = await reparatur({ issueDescription: 'Abholen' });
    await schritt(a, 'in_progress', 'ready');
    const tag = tagVor(5);
    if (weg === 'lokal') await house.updateRepairStatusOnPrimary(a, 'picked_up', { pickedUpDate: tag, expectedRevision: rev(db, a) });
    else { const o = await fernStatus(db, a, 'picked_up', { pickedUpDate: tag }); ok(o.kind === 'ok', `PICKUP (fern) angenommen (${o.code || 'ok'})`); }
    reload();
    const p = row(db, 'SELECT picked_up_at, picked_up_recorded_at FROM repairs WHERE id = ?', [a]);
    ok(String(p.picked_up_at) === `${tag}T12:00:00.000Z` && String(p.picked_up_recorded_at).slice(0, 10) === HEUTE,
      `PICKUP (${weg}) spät erfasst: Abholtag ${tag} (mittags UTC), Erfassung heute getrennt (${S(p)})`);
    bilder.push(String(p.picked_up_at));
    // Grenzen: künftig, vor der Annahme, falsche Form, Datum an einem anderen Schritt.
    const b = await reparatur({ issueDescription: 'Grenzen', receivedAt: tagVor(3) });
    await schritt(b, 'in_progress', 'ready');
    const vorB = zustand(db, b);
    const fall = async (extra: Record<string, unknown>, status = 'picked_up'): Promise<string> => (weg === 'lokal'
      ? nein(house.updateRepairStatusOnPrimary(b, status as never, extra as never))
      : nein((async () => { const o = await fernStatus(db, b, status, extra); if (o.kind !== 'ok') throw Object.assign(new Error(o.code), { code: o.code }); })()));
    const zukunft = await fall({ pickedUpDate: tagNach(3) });
    const vorAnnahme = await fall({ pickedUpDate: tagVor(10) });
    reload();
    ok(zukunft === 'PICKUP_DATE_INVALID' && vorAnnahme === 'PICKUP_BEFORE_RECEIVED' && zustand(db, b) === vorB,
      `PICKUP (${weg}) künftiger Tag / Tag vor der Annahme: Nein, nichts geändert (${zukunft} / ${vorAnnahme})`);
    const heute = weg === 'lokal' ? await nein(house.updateRepairStatusOnPrimary(b, 'picked_up')) : code(await fernStatus(db, b, 'picked_up'));
    reload();
    ok(heute === '' && s(db, 'SELECT substr(picked_up_at, 1, 10) FROM repairs WHERE id = ?', [b]) === HEUTE,
      `PICKUP (${weg}) ohne Wahl: heute (${heute || 'ok'})`);
  }
  ok(bilder[0] === bilder[1], 'PICKUP PARITY Primary == PC2 (Abholtag)');
  let form = '';
  try { life.parseUpdateRepairStatus({ repairId: 'x', status: 'ready', expectedRevision: 1, pickedUpDate: HEUTE }); } catch (e) { form = (e as Error).message; }
  let form2 = '';
  try { life.parseUpdateRepairStatus({ repairId: 'x', status: 'picked_up', expectedRevision: 1, pickedUpDate: '20.10.2026' }); } catch (e) { form2 = (e as Error).message; }
  ok(/picked_up/.test(form) && /YYYY-MM-DD/.test(form2), `PICKUP PC2-Rumpf: Abholtag nur bei „picked_up", nur JJJJ-MM-TT (${form} / ${form2})`);
}

// ══ §4 Rechnungstag aus der Abholung ════════════════════════════════════════
{
  const bilder: string[] = [];
  for (const weg of ['lokal', 'fern'] as const) {
    const db = freshDb();
    const tag = tagVor(5);
    const a = await reparatur({ issueDescription: 'Datum A' });
    await schritt(a, 'in_progress', 'ready');
    await house.updateRepairStatusOnPrimary(a, 'picked_up', { pickedUpDate: tag });
    reload();
    let inv = '';
    if (weg === 'lokal') inv = (await house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10' })).invoiceId;
    else {
      const o = await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
        rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10' })) as Out;
      ok(o.kind === 'ok', `INVDATE (fern) angenommen (${o.code || 'ok'})`);
      inv = String(o.value?.invoiceId);
    }
    ok(s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [inv]) === tag
      && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE source_module = 'INVOICE' AND source_id = ? AND substr(occurred_at, 1, 10) != ?", [inv, tag]) === 0
      && ausgeglichen(db),
      `INVDATE (${weg}) Rechnung nach später Abholung: Rechnungstag = Abholtag ${tag}, Buchungen dort, ausgeglichen`);
    bilder.push(s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [inv]));

    // Verschiedene Abholtage: ohne Wahl kein willkürlicher Tag — mit gewähltem Tag geht es.
    const b = await reparatur({ issueDescription: 'Datum B' }); const c = await reparatur({ issueDescription: 'Datum C' });
    await schritt(b, 'in_progress', 'ready'); await schritt(c, 'in_progress', 'ready');
    await house.updateRepairStatusOnPrimary(b, 'picked_up', { pickedUpDate: tagVor(4) });
    await house.updateRepairStatusOnPrimary(c, 'picked_up', { pickedUpDate: tagVor(2) });
    reload();
    const vorAnz = n(db, 'SELECT COUNT(*) FROM invoices');
    const rs = useRepairStore.getState();
    const ohne = weg === 'lokal' ? await nein(house.invoiceRepairsOnPrimary([b, c]))
      : code(await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'), rules.repairInvoiceBody([rs.getRepair(b)!, rs.getRepair(c)!])));
    reload();
    ok(ohne === 'REPAIR_INVOICE_DATE_REQUIRED' && n(db, 'SELECT COUNT(*) FROM invoices') === vorAnz,
      `INVDATE (${weg}) gemeinsame Rechnung, verschiedene Abholtage, kein Tag gewählt: Nein, nichts angelegt (${ohne})`);
    let mit = '';
    if (weg === 'lokal') mit = (await house.invoiceRepairsOnPrimary([b, c], { invoiceDate: tagVor(2) })).invoiceId;
    else {
      const o = await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
        rules.repairInvoiceBody([useRepairStore.getState().getRepair(b)!, useRepairStore.getState().getRepair(c)!], { invoiceDate: tagVor(2) })) as Out;
      mit = String(o.value?.invoiceId);
    }
    ok(s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [mit]) === tagVor(2),
      `INVDATE (${weg}) …mit ausdrücklich gewähltem Tag: angelegt, auf diesen Tag datiert`);
    const f1 = await reparatur({ issueDescription: 'Datum F' });
    await schritt(f1, 'in_progress', 'ready');
    const vorF = n(db, 'SELECT COUNT(*) FROM invoices');
    const zukunft = weg === 'lokal' ? await nein(house.invoiceRepairsOnPrimary([f1], { invoiceDate: tagNach(3) }))
      : code(await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
        rules.repairInvoiceBody([useRepairStore.getState().getRepair(f1)!], { invoiceDate: tagNach(3) })));
    reload();
    ok(zukunft === 'INVOICE_DATE_INVALID' && n(db, 'SELECT COUNT(*) FROM invoices') === vorF,
      `INVDATE (${weg}) künftiger Rechnungstag: Nein, nichts angelegt (${zukunft})`);

    // Bestehende Rechnung: eine spätere Abholung datiert sie nicht um.
    const d = await reparatur({ issueDescription: 'Datum D' });
    await schritt(d, 'in_progress', 'ready');
    const invD = (await house.invoiceRepairsOnPrimary([d])).invoiceId;
    const vorD = all(db, 'SELECT * FROM invoices WHERE id = ?', [invD]) + all(db, "SELECT * FROM ledger_entries WHERE source_id = ? ORDER BY id", [invD]);
    if (weg === 'lokal') await house.updateRepairStatusOnPrimary(d, 'picked_up', { pickedUpDate: tagVor(1) });
    else await fernStatus(db, d, 'picked_up', { pickedUpDate: tagVor(1) });
    reload();
    ok(all(db, 'SELECT * FROM invoices WHERE id = ?', [invD]) + all(db, "SELECT * FROM ledger_entries WHERE source_id = ? ORDER BY id", [invD]) === vorD
      && s(db, 'SELECT substr(picked_up_at, 1, 10) FROM repairs WHERE id = ?', [d]) === tagVor(1),
      `INVDATE (${weg}) Rechnung vor der Abholung: Abholtag erfasst, Rechnung und Buchungen bitgleich`);
  }
  ok(bilder[0] === bilder[1], 'INVDATE PARITY Primary == PC2 (Rechnungstag)');
  // Pure Regel: Vorschlag und Pflicht.
  ok(rules.repairInvoiceDateSuggestion([{ status: 'picked_up', pickedUpAt: '2026-10-20T12:00:00.000Z' }]) === '2026-10-20'
    && rules.repairInvoiceDateSuggestion([{ status: 'picked_up', pickedUpAt: '2026-10-20T12:00:00.000Z' }, { status: 'ready' }]) === null
    && rules.repairInvoiceDateSuggestion([{ status: 'ready' }]) === HEUTE,
    'INVDATE Vorschlag: gemeinsamer Abholtag, sonst heute; verschieden → wählen');
}

// ══ §4b VAT-Periodensperre: Abholtag in einem eingereichten Quartal ═════════
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'VAT', receivedAt: '2026-05-01' });
  await schritt(a, 'in_progress', 'ready');
  await house.updateRepairStatusOnPrimary(a, 'picked_up', { pickedUpDate: '2026-05-10' });
  posting.beginLedgerTransaction();
  try { lock.markVatQuarterFiled({ branchId: 'branch-main', year: 2026, quarter: 2, userId: 'user-test' }); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
  reload();
  const vor = n(db, 'SELECT COUNT(*) FROM invoices') + '|' + buchungen(db) + '|' + all(db, 'SELECT next_number FROM document_sequences ORDER BY doc_type');
  let m = '';
  if (weg === 'lokal') m = await nein(house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10' }));
  else {
    const o = await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
      rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10' })) as Out;
    m = o.kind === 'rejected' && o.frozen ? String(o.code) : `${o.kind}:${o.code}:${o.frozen}`;
  }
  reload();
  ok(m === lock.VAT_PERIOD_FILED && n(db, 'SELECT COUNT(*) FROM invoices') + '|' + buchungen(db) + '|' + all(db, 'SELECT next_number FROM document_sequences ORDER BY doc_type') === vor,
    `VATLOCK (${weg}) Abholtag im eingereichten Q2: Rechnung abgewiesen${weg === 'fern' ? ' (endgültiges Nein)' : ''} — keine Rechnung, Buchung, Nummer (${m})`);
  const inv = weg === 'lokal'
    ? (await house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10', invoiceDate: HEUTE })).invoiceId
    : String((await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
      rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10', invoiceDate: HEUTE })) as Out).value?.invoiceId);
  ok(s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [inv]) === HEUTE
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE occurred_at < '2026-07-01'") === 0,
    `VATLOCK (${weg}) …mit gewähltem Tag im offenen Quartal: angelegt, nichts im eingereichten Q2`);
}

// ══ §4c Abholung in einem SCHON eingereichten Quartal: die Abholung gilt, nur die Rechnung auf diesen Tag nicht ══
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'Spät erfasst', receivedAt: '2026-05-01' });
  await schritt(a, 'in_progress', 'ready');
  posting.beginLedgerTransaction();
  try { lock.markVatQuarterFiled({ branchId: 'branch-main', year: 2026, quarter: 2, userId: 'user-test' }); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
  reload();
  const vorBuch = buchungen(db);
  // Q2 ist eingereicht; der Kunde holte am 20.06. ab — erfasst wird es heute. Die Abholung bucht nichts: sie ist erlaubt.
  const m = weg === 'lokal' ? await nein(house.updateRepairStatusOnPrimary(a, 'picked_up', { pickedUpDate: '2026-06-20' }))
    : code(await fernStatus(db, a, 'picked_up', { pickedUpDate: '2026-06-20' }));
  reload();
  ok(m === '' && s(db, 'SELECT picked_up_at FROM repairs WHERE id = ?', [a]) === '2026-06-20T12:00:00.000Z'
    && s(db, 'SELECT substr(picked_up_recorded_at, 1, 10) FROM repairs WHERE id = ?', [a]) === HEUTE && buchungen(db) === vorBuch,
    `PICKUP-Q (${weg}) Abholtag im eingereichten Q2: erfasst (20.06., Erfassung heute), keine Buchung (${m || 'ok'})`);
  // Die Rechnung auf diesen Tag bleibt gesperrt — kein Ersatztag wird still eingesetzt.
  const vorInv = n(db, 'SELECT COUNT(*) FROM invoices') + '|' + all(db, 'SELECT next_number FROM document_sequences ORDER BY doc_type');
  const rs = useRepairStore.getState();
  const r1 = weg === 'lokal' ? await nein(house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10' }))
    : code(await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'), rules.repairInvoiceBody([rs.getRepair(a)!], { taxScheme: 'VAT_10' })));
  const r2 = weg === 'lokal' ? await nein(house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10', invoiceDate: '2026-06-20' }))
    : code(await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'), rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10', invoiceDate: '2026-06-20' })));
  reload();
  ok(r1 === lock.VAT_PERIOD_FILED && r2 === lock.VAT_PERIOD_FILED
    && n(db, 'SELECT COUNT(*) FROM invoices') + '|' + all(db, 'SELECT next_number FROM document_sequences ORDER BY doc_type') === vorInv
    && s(db, 'SELECT picked_up_at FROM repairs WHERE id = ?', [a]) === '2026-06-20T12:00:00.000Z' && s(db, 'SELECT status FROM repairs WHERE id = ?', [a]) === 'picked_up',
    `PICKUP-Q (${weg}) Rechnung auf den Abholtag (vorgeschlagen / ausdrücklich): gesperrt, nichts angelegt — die Abholung bleibt (${r1}/${r2})`);
  const inv = weg === 'lokal'
    ? (await house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10', invoiceDate: HEUTE })).invoiceId
    : String((await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
      rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10', invoiceDate: HEUTE })) as Out).value?.invoiceId);
  reload();
  ok(s(db, 'SELECT substr(issued_at, 1, 10) FROM invoices WHERE id = ?', [inv]) === HEUTE
    && s(db, 'SELECT picked_up_at FROM repairs WHERE id = ?', [a]) === '2026-06-20T12:00:00.000Z'
    && n(db, "SELECT COUNT(*) FROM ledger_entries WHERE occurred_at < '2026-07-01'") === 0,
    `PICKUP-Q (${weg}) Rechnung mit Tag im offenen Quartal: angelegt; Abholtag bleibt 20.06.; nichts in Q2`);
}
{
  const { pickupKeptInvoiceRefused } = await import('../../src/components/repairs/repair-status-save.ts');
  const t = pickupKeptInvoiceRefused('2026-06-20', 'The VAT return for Q2/2026 is already filed — …');
  ok(/Picked up on 2026-06-20 — the pickup is saved\. The invoice was NOT created: The VAT return for Q2\/2026/.test(t) && /open VAT quarter/.test(t),
    `PICKUP-Q die Meldung sagt beides: Abholung gespeichert, Rechnung nicht — mit dem Grund (${t.slice(0, 90)}…)`);
  const liste = src('src/pages/repairs/RepairList.tsx'); const detail = src('src/pages/repairs/RepairDetail.tsx');
  const quick = src('src/components/repairs/RepairQuickEditModal.tsx'); const dlg = src('src/components/repairs/RepairStatusDialog.tsx');
  ok([liste, detail, quick].every((x) => /pickupKeptInvoiceRefused\(step\.pickedUpDate, inv\.error\)/.test(x))
    && /data-pickup-invoice-note/.test(dlg) && /setAbholung\(null\);\n?\s*\/\/ Die Abholung steht/.test(liste.replace(/\r/g, '')),
    'PICKUP-Q Liste, Detailseite, Quick Edit: Fenster zu, klare Meldung; der Hinweis steht schon im Abholfenster');
}

// ══ §1f Reopen mit Rechnung, danach wieder abholen: keine zweite Rechnung, Forderung oder Buchung ══
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'Rechnung + Reopen' });
  db.run('UPDATE repairs SET internal_cost = 10 WHERE id = ?', [a]);
  await schritt(a, 'in_progress', 'ready');
  const inv = (await house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10' })).invoiceId;
  posting.beginLedgerTransaction();
  try { useInvoiceStore.getState().loadInvoices(); useInvoiceStore.getState().recordPayment(inv, 40, 'cash'); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
  reload();
  const bild = (): string => S([
    n(db, 'SELECT COUNT(*) FROM invoices'), all(db, 'SELECT id, invoice_number, status, gross_amount, paid_amount, issued_at FROM invoices'),
    all(db, 'SELECT * FROM invoice_lines ORDER BY id'), all(db, 'SELECT id, amount, received_at FROM payments ORDER BY id'),
    buchungen(db), ausgaben(db, a), eigeneArbeit(db, a),
    n(db, "SELECT ROUND(COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END), 0), 3) FROM ledger_entries WHERE account = 'ACCOUNTS_RECEIVABLE'"),
  ]);
  const vor = bild();
  await schritt(a, 'returned');
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(a, 'ready');
  else await fernStatus(db, a, 'ready');
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [a]) === 'ready' && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [a]) === inv && bild() === vor,
    `REOPEN-INV (${weg}) Returned → Reopen: dieselbe Rechnung, Zahlung, Forderung, Buchungen und eigene Arbeit (${eigeneArbeit(db, a)})`);
  // Wieder abholen — mit Abholtag; die Abholung legt keine Rechnung an, und eine zweite wird abgewiesen.
  if (weg === 'lokal') await house.updateRepairStatusOnPrimary(a, 'picked_up', { pickedUpDate: tagVor(1) });
  else await fernStatus(db, a, 'picked_up', { pickedUpDate: tagVor(1) });
  reload();
  const zweite = weg === 'lokal' ? await nein(house.invoiceRepairsOnPrimary([a], { taxScheme: 'VAT_10', invoiceDate: tagVor(1) }))
    : code(await life.runCreateRepairInvoice(deps(db), identity(nx(), 'repairs.create_invoice'),
      rules.repairInvoiceBody([useRepairStore.getState().getRepair(a)!], { taxScheme: 'VAT_10', invoiceDate: tagVor(1) })));
  reload();
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [a]) === 'picked_up' && s(db, 'SELECT substr(picked_up_at, 1, 10) FROM repairs WHERE id = ?', [a]) === tagVor(1)
    && zweite === 'REPAIR_ALREADY_INVOICED' && bild() === vor && ausgeglichen(db),
    `REOPEN-INV (${weg}) …wieder abgeholt (${tagVor(1)}): keine zweite Rechnung (${zweite}), Forderung und Buchungen bitgleich`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE'", [a]) >= 4
    && n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_id = ? AND action_type = 'STATUS_CHANGE' AND old_value = 'returned' AND new_value = 'ready'", [a]) === 1,
    `REOPEN-INV (${weg}) die Historie bleibt vollständig (Schritte im Audit-Protokoll)`);
}
{
  // Das Abholfenster bietet bei vorhandener Rechnung keine zweite an.
  const dlg = src('src/components/repairs/RepairStatusDialog.tsx');
  ok(/canInvoiceRepair\(\{ \.\.\.repair, status: 'ready' \}\) && !repair\.invoiceId/.test(dlg)
    && /The existing invoice keeps its date and number/.test(dlg),
    'REOPEN-INV das Abholfenster bietet bei vorhandener Rechnung keine an und sagt, dass sie bleibt');
}

// ══ §5 Quick Edit — Preis, Kosten, Zeilen ═══════════════════════════════════
for (const weg of ['lokal', 'fern'] as const) {
  const db = freshDb();
  const a = await reparatur({ issueDescription: 'Quick', chargeToCustomer: 90 });
  reload();
  const rA = useRepairStore.getState().getRepair(a)!;
  const neu = { ...rA, chargeToCustomer: 120, actualCost: 25 };
  if (weg === 'lokal') await house.updateRepairOnPrimary(a, neu, rev(db, a));
  else { const o = await cmd.runRepairUpdate(deps(db), identity(nx(), 'repairs.update'), rules.repairEditBody(a, rev(db, a), rA, neu)) as Out; ok(o.kind === 'ok', `QUICK (fern) Beträge angenommen (${o.code || 'ok'})`); }
  reload();
  ok(n(db, 'SELECT charge_to_customer FROM repairs WHERE id = ?', [a]) === 120 && n(db, 'SELECT internal_cost FROM repairs WHERE id = ?', [a]) === 25
    && n(db, 'SELECT margin FROM repairs WHERE id = ?', [a]) === 95,
    `QUICK (${weg}) Preis 90→120, Kosten 25: Marge 95 abgeleitet`);
  // Arbeitszeile an einer Werkstatt: ab „in Arbeit" gebucht — Betrag ändern folgt der Ausgabe, Werkstatt wechseln nicht.
  await house.addRepairLineOnPrimary(a, { supplierId: 'sup-1', workType: 'service', description: 'Werk', costAmount: 30 });
  await schritt(a, 'in_progress');
  const line = useRepairStore.getState().getRepairLines(a).find((l) => l.status === 'OPEN' && l.supplierId === 'sup-1')!;
  db.run("INSERT INTO suppliers (id, branch_id, name, active, is_workshop, created_at, updated_at) VALUES ('sup-2','branch-main','Zweite',1,1,?,?)", [NOW, NOW]);
  reload();
  if (weg === 'lokal') await house.updateRepairLineOnPrimary(a, line.id, { costAmount: 35, description: 'Werk neu' }, rev(db, a));
  else { const o = await life.runUpdateRepairLine(deps(db), identity(nx(), 'repairs.update_line'), { repairId: a, lineId: line.id, expectedRevision: rev(db, a), costAmount: 35, description: 'Werk neu' }) as Out; ok(o.kind === 'ok', `QUICK (fern) Zeile angenommen (${o.code || 'ok'})`); }
  reload();
  ok(n(db, 'SELECT cost_amount FROM repair_lines WHERE id = ?', [line.id]) === 35 && n(db, 'SELECT amount FROM expenses WHERE id = (SELECT expense_id FROM repair_lines WHERE id = ?)', [line.id]) === 35
    && s(db, 'SELECT description FROM repair_lines WHERE id = ?', [line.id]) === 'Werk neu' && ausgeglichen(db),
    `QUICK (${weg}) gebuchte Werkstattzeile 30→35: Ausgabe folgt, ausgeglichen`);
  const vorL = all(db, 'SELECT * FROM repair_lines WHERE id = ?', [line.id]) + buchungen(db);
  const wechsel = weg === 'lokal' ? await nein(house.updateRepairLineOnPrimary(a, line.id, { supplierId: 'sup-2' }, rev(db, a)))
    : code(await life.runUpdateRepairLine(deps(db), identity(nx(), 'repairs.update_line'), { repairId: a, lineId: line.id, expectedRevision: rev(db, a), supplierId: 'sup-2' }));
  const null0 = weg === 'lokal' ? await nein(house.updateRepairLineOnPrimary(a, line.id, { costAmount: 0 }, rev(db, a)))
    : code(await life.runUpdateRepairLine(deps(db), identity(nx(), 'repairs.update_line'), { repairId: a, lineId: line.id, expectedRevision: rev(db, a), costAmount: 0 }));
  const alt = weg === 'lokal' ? await nein(house.updateRepairLineOnPrimary(a, line.id, { costAmount: 40 }, rev(db, a) - 1)) : 'RECORD_CHANGED';
  reload();
  // REPAIR-REDESIGN — eine Werkstattzeile auf 0: LINE_COST_REQUIRED (sie ist die Verbindlichkeit); eigene Arbeit darf 0.
  ok(wechsel === 'REPAIR_LINE_SOURCE_LOCKED' && null0 === 'LINE_COST_REQUIRED' && alt === 'RECORD_CHANGED'
    && all(db, 'SELECT * FROM repair_lines WHERE id = ?', [line.id]) + buchungen(db) === vorL,
    `QUICK (${weg}) Werkstatt einer gebuchten Zeile wechseln / Betrag 0 / alte Fassung: Nein, nichts geändert (${wechsel}/${null0}/${alt})`);
  // Summen: Zeilen + eigene Kosten = Gesamtkosten (dieselbe Ableitung wie Detailseite und Rechnung).
  reload();
  const r2 = useRepairStore.getState().getRepair(a)!;
  const offen = useRepairStore.getState().getRepairLines(a).filter((l) => l.status === 'OPEN').reduce((x, l) => x + l.costAmount, 0);
  const { computeRepairTotalCost } = await import('../../src/stores/repairStore.ts');
  ok(offen === 35 && computeRepairTotalCost(r2, offen) === 60, `QUICK (${weg}) Summen: Zeilen 35 + eigene 25 = 60 (${computeRepairTotalCost(r2, offen)})`);
  // Abgerechnet: der Preis steht auf der Rechnung — keine stille Änderung mehr.
  await schritt(a, 'ready');
  await house.invoiceRepairsOnPrimary([a]);
  reload();
  const rI = useRepairStore.getState().getRepair(a)!;
  const vorI = zustand(db, a) + buchungen(db);
  const mI = weg === 'lokal' ? await nein(house.updateRepairOnPrimary(a, { ...rI, chargeToCustomer: 150 }, rev(db, a)))
    : code(await cmd.runRepairUpdate(deps(db), identity(nx(), 'repairs.update'), rules.repairEditBody(a, rev(db, a), rI, { ...rI, chargeToCustomer: 150 })));
  reload();
  ok(mI === 'REPAIR_ALREADY_INVOICED' && zustand(db, a) + buchungen(db) === vorI,
    `QUICK (${weg}) abgerechnete Reparatur: Preis ändern abgewiesen, nichts geändert (${mI})`);
  const notiz = weg === 'lokal' ? await nein(house.updateRepairOnPrimary(a, { ...rI, notes: 'Notiz ok' }, rev(db, a))) : '';
  ok(notiz === '', `QUICK (${weg}) …eine Notiz ändern geht weiter (${notiz || 'ok'})`);
}

// ══ §6 Verdrahtung: Liste, Quick Edit, Detailseite, Rechnungsseite, Handy ════
{
  const liste = src('src/pages/repairs/RepairList.tsx');
  const quick = src('src/components/repairs/RepairQuickEditModal.tsx');
  const detail = src('src/pages/repairs/RepairDetail.tsx');
  const rechnung = src('src/pages/invoices/InvoiceDetail.tsx');
  const handy = src('src-tauri/src/sync/mobile_repair_ui.js');
  ok(/data-repair-quick-edit=/.test(liste) && /<RepairQuickEditModal /.test(liste) && /if \(newStatus === 'picked_up'\) \{ w\.clear\(\); setAbholung\(rep\); return; \}/.test(liste),
    'WIRE Liste: „Edit" öffnet Quick Edit; „Picked Up" fragt den Abholtag');
  ok(/invoiceDate: rechnungsDatum/.test(liste) && /repairInvoiceDateSuggestion/.test(liste) && /!rechnungsDatum \|\| w\.busy/.test(liste),
    'WIRE Liste: Rechnungstag vorgeschlagen (Abholtag), bei verschiedenen Tagen Pflicht');
  ok(/updateRepairLineOnPrimary\(rep\.id, line\.id, patch as never, f\)/.test(quick) && /'repairs\.update_line'/.test(quick)
    && /addRepairLineOnPrimary\(rep\.id/.test(quick) && /addRepairMaterialOnPrimary\(req\)/.test(quick) && /updateRepairOnPrimary\(rep\.id, form, f\)/.test(quick)
    && /repairStatusTargets\(repairTransitionFacts\(rep, lines\)\)/.test(quick) && /<RepairWorkLineForm[\s\S]{0,300}?suppliers=\{suppliers\}/.test(quick)
    && /workshopOptions\(suppliers/.test(src('src/components/repairs/RepairWorkParts.tsx')),
    'WIRE Quick Edit: dieselben Hausfunktionen/Fernbefehle wie die Detailseite; Status aus der geteilten Regel; Werkstatt nur markierte');
  ok(/setStatusFrage\('picked_up'\)/.test(detail) && /data-repair-reopen/.test(detail) && /invoiceDate: rechnungsDatum/.test(detail),
    'WIRE Detailseite: Abholtag, Reopen, Rechnungstag');
  ok(/saveRepairStatus\(w, r, 'picked_up', pickedUpDate\)/.test(rechnung) && !/updateRepairStatus\(r\.id/.test(rechnung),
    'WIRE Rechnungsseite: Abholung mit Abholtag über die Hausfunktion (nicht mehr direkt im Store)');
  ok(/body\.pickedUpDate = d\.date/.test(handy) && /'Reopen as '/.test(handy) && /Tap again: return without repair/.test(handy),
    'WIRE Handy: Abholtag im Auftrag, „Reopen as …", „Returned" mit zweitem Antippen');
}

console.log(`\n${fails.length ? 'FAIL' : 'PASS'} — repair workflow & quick edit: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

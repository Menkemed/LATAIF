// ════════════════════════════════════════════════════════════════════════════
// REPAIR-INVOICE-INDICATOR — Rechnung erstellt / nicht erstellt je Reparatur, nur aus repairs.invoice_id + Rechnungsstatus.
// Run: node --experimental-strip-types test/repair-invoice-indicator/repair-invoice-indicator.test.ts
//   §1 Regel (rein)  §2 echte Sammelrechnung + Storno auf der Testdatenbank  §3 Verdrahtung der Liste
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

const invCancel = await import('../../src/core/invoices/invoice-cancel-house.ts');
const ind = await import('../../src/core/repairs/repair-invoice-state.ts');
const rs = () => useRepairStore.getState();
const S = (v: unknown): string => JSON.stringify(v);
async function lokal(fn: () => Promise<unknown>): Promise<{ ok: boolean; code: string }> {
  try { await fn(); return { ok: true, code: '' }; } catch (e) {
    return { ok: false, code: String((e as { code?: string }).code ?? (e as Error).message) };
  }
}
async function kunde(form: Record<string, unknown>): Promise<string> {
  return (await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', chargeToCustomer: 300, taxScheme: 'ZERO',
    repairType: 'internal', internalCost: 50, ...form,
  } as never)).id;
}
async function fertig(id: string): Promise<void> {
  rs().loadRepairs();
  await house.updateRepairStatusOnPrimary(id, 'in_progress' as never);
  rs().loadRepairs();
  await house.updateRepairStatusOnPrimary(id, 'ready' as never);
}
const ansicht = (id: string) => {
  const r = rs().repairs.find((x) => x.id === id);
  return ind.repairInvoiceView(r ?? {}, useInvoiceStore.getState().invoices);
};
const zaehle = (f: string): number =>
  rs().repairs.filter((r) => ind.matchRepairInvoice(ind.repairInvoiceView(r, useInvoiceStore.getState().invoices), f as never)).length;
/** Was die Anzeige nie anfassen darf: Rechnungen, Zahlungen, Hauptbuch, Reparaturkopf. */
const buchStand = (db: Db) => all(db, `SELECT
  (SELECT COUNT(*) FROM invoices), (SELECT COALESCE(SUM(gross_amount),0) FROM invoices), (SELECT COUNT(*) FROM payments),
  (SELECT COUNT(*) FROM ledger_entries), (SELECT COALESCE(SUM(amount),0) FROM ledger_entries),
  (SELECT group_concat(id || ':' || COALESCE(invoice_id,'') || ':' || status || ':' || revision, ',') FROM repairs)`);

// ══ §1 Regel (rein) — nur die Verknüpfung zählt, nie der Reparaturstatus ══════════════════════════
{
  const inv = [
    { id: 'i-final', invoiceNumber: 'INV-1', status: 'FINAL' },
    { id: 'i-part', invoiceNumber: 'PINV-2', status: 'PARTIAL' },
    { id: 'i-draft', invoiceNumber: 'PINV-3', status: 'DRAFT' },
    { id: 'i-ret', invoiceNumber: 'INV-4', status: 'RETURNED' },
    { id: 'i-canc', invoiceNumber: 'INV-5', status: 'CANCELLED' },
  ];
  const v = (r: Record<string, unknown>) => ind.repairInvoiceView(r as never, inv);
  ok(S(v({})) === S({ state: 'none', created: false, dataProblem: false, invoiceId: null, invoiceNumber: null, invoiceStatus: null, label: 'Not created' }),
    '§1 ohne Verknüpfung: Not created');
  ok(v({ invoiceId: '' }).state === 'none' && v({ invoiceId: '   ' }).state === 'none' && v({ invoiceId: null }).state === 'none',
    '§1 leere/Leerzeichen-/null-Verknüpfung = keine Rechnung');
  // Workflow-Status ohne Rechnung („ready", „picked_up", auch ein fremd gesetztes „invoiced") → trotzdem Not created.
  for (const st of ['ready', 'picked_up', 'delivered', 'invoiced']) {
    ok(v({ status: st, customerPaymentStatus: 'PAID' }).created === false, `§1 Status ${st} ohne Rechnung: Not created (nicht aus dem Workflow abgeleitet)`);
  }
  ok(v({ invoiceId: 'i-final', status: 'received' }).created === true, '§1 Rechnung da, Status „received": Invoice created (Status egal)');
  const f = v({ invoiceId: 'i-final' });
  ok(f.state === 'created' && f.created && f.invoiceId === 'i-final' && f.invoiceNumber === 'INV-1' && f.invoiceStatus === 'FINAL'
    && f.label === 'Invoice created', '§1 FINAL: created + Nummer');
  ok(v({ invoiceId: 'i-part' }).created && v({ invoiceId: 'i-part' }).label === 'Invoice created', '§1 PARTIAL: created');
  const d = v({ invoiceId: 'i-draft' });
  ok(d.state === 'draft' && d.created && !d.dataProblem && d.label === 'Invoice Draft' && d.invoiceNumber === 'PINV-3',
    '§1 DRAFT: eigener Zustand „Invoice Draft" (kein „created"-Häkchen), zählt aber als erstellt');
  ok(!f.dataProblem && f.state === 'created', '§1 FINAL ist kein Datenproblem');
  ok(v({ invoiceId: 'i-ret' }).created && v({ invoiceId: 'i-ret' }).label === 'Invoice created (returned)', '§1 RETURNED: created (returned)');
  const c = v({ invoiceId: 'i-canc' });
  ok(c.state === 'cancelled' && !c.created && c.invoiceId === 'i-canc' && c.invoiceNumber === 'INV-5' && c.label === 'Invoice cancelled',
    '§1 CANCELLED: keine erstellte Rechnung, aber Nummer zum Öffnen bleibt');
  const m = v({ invoiceId: 'i-weg' });
  ok(m.state === 'missing' && !m.created && m.dataProblem && m.invoiceId === 'i-weg' && m.invoiceNumber === null && m.label === 'Invoice not found',
    '§1 verwaiste Verknüpfung: Invoice not found, Datenproblem, nicht created');
  ok(!c.dataProblem, '§1 storniert ist kein Datenproblem');
  ok(ind.matchRepairInvoice(d, 'created') && !ind.matchRepairInvoice(d, 'not_created'), '§1 Filter: Entwurf unter Invoice Created, nicht unter Not Created');
  ok(ind.matchRepairInvoice(f, '') && ind.matchRepairInvoice(c, '') && ind.matchRepairInvoice(m, ''), '§1 Filter All: alles');
  ok(ind.matchRepairInvoice(f, 'created') && !ind.matchRepairInvoice(c, 'created') && !ind.matchRepairInvoice(m, 'created')
    && !ind.matchRepairInvoice(v({}), 'created'), '§1 Filter Invoice Created: nur geltende Rechnung');
  ok(!ind.matchRepairInvoice(f, 'not_created') && ind.matchRepairInvoice(c, 'not_created') && ind.matchRepairInvoice(m, 'not_created')
    && ind.matchRepairInvoice(v({}), 'not_created'), '§1 Filter Not Created: ohne, storniert, verwaist');
  // Created und Not Created teilen die Menge vollständig und überschneidungsfrei.
  const alle = [v({}), f, c, m, v({ invoiceId: 'i-draft' }), v({ invoiceId: 'i-ret' }), v({ invoiceId: 'i-part' })];
  ok(alle.every((x) => ind.matchRepairInvoice(x, 'created') !== ind.matchRepairInvoice(x, 'not_created')), '§1 Created/Not Created disjunkt + vollständig');
}

// ══ §2 Echt: Sammelrechnung für zwei Reparaturen, dann Storno ══════════════════════════════════
{
  const db = freshDb();
  const a = await kunde({});
  const b = await kunde({});
  const ohne = await kunde({});
  await fertig(a); await fertig(b); await fertig(ohne);
  rs().loadRepairs();
  const r = await lokal(() => house.invoiceRepairsOnPrimary([a, b], { taxScheme: 'ZERO' } as never));
  reload();
  const invId = s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [a]);
  ok(r.ok && invId !== '' && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [b]) === invId,
    `§2 Sammelrechnung: beide Reparaturen zeigen auf DIESELBE Rechnung (${r.code})`);
  const nr = s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [invId]);
  const va = ansicht(a); const vb = ansicht(b);
  ok(va.created && vb.created && va.invoiceId === invId && vb.invoiceId === invId && va.invoiceNumber === nr && nr !== '',
    `§2 beide: Invoice created mit Nummer ${nr}`);
  ok(ansicht(ohne).state === 'none', '§2 dritte (gleicher Kunde, gleicher Status, ohne Rechnung): Not created');
  ok(zaehle('') === 3 && zaehle('created') === 2 && zaehle('not_created') === 1, `§2 Zähler All 3 / Created 2 / Not Created 1 (${zaehle('created')}/${zaehle('not_created')})`);

  const vor = buchStand(db);
  for (let i = 0; i < 3; i++) { ansicht(a); ansicht(b); ansicht(ohne); zaehle('created'); zaehle('not_created'); }
  ok(buchStand(db) === vor, '§2 Anzeige und Filter schreiben nichts (Rechnung, Zahlung, Hauptbuch, Reparatur unverändert)');

  const st = await lokal(() => invCancel.cancelInvoiceOnPrimary({ invoiceId: invId, refundMethod: 'cash' } as never));
  reload();
  ok(st.ok && s(db, 'SELECT status FROM invoices WHERE id = ?', [invId]) === 'CANCELLED', `§2 Rechnung storniert (${st.code})`);
  ok(s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [a]) === invId && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [b]) === invId,
    '§2 Befund: Storno lässt repairs.invoice_id stehen — genau deshalb liest die Anzeige den Rechnungsstatus');
  const ca = ansicht(a); const cb = ansicht(b);
  ok(ca.state === 'cancelled' && cb.state === 'cancelled' && !ca.created && !cb.created && ca.invoiceNumber === nr,
    '§2 nach Storno: beide „Invoice cancelled", nicht created, Nummer zum Öffnen bleibt');
  ok(zaehle('created') === 0 && zaehle('not_created') === 3, '§2 Filter nach Storno: Created 0 / Not Created 3');

  // Verwaiste Verknüpfung (z. B. Altdaten): nicht created.
  db.run("UPDATE repairs SET invoice_id = 'inv-gibt-es-nicht' WHERE id = ?", [ohne]);
  reload();
  ok(ansicht(ohne).state === 'missing' && zaehle('not_created') === 3, '§2 verwaiste invoice_id: Invoice not found, zählt als Not Created');
}

// ══ §3 Verdrahtung der Liste ═════════════════════════════════════════════════════════════════════
{
  const regel = src('src/core/repairs/repair-invoice-state.ts');
  ok(!/^\s*import\s/m.test(regel), '§3 Regel ist rein (keine Imports: kein Store, keine DB, keine Buchung)');
  const list = codeOf(src('src/pages/repairs/RepairList.tsx'));
  ok(list.includes("from '@/core/repairs/repair-invoice-state'"), '§3 Liste nutzt die gemeinsame Regel');
  ok(/if \(filterInvoice\) r = r\.filter\(\(rep\) => matchRepairInvoice\(repairInvoiceView\(rep, invoices\), filterInvoice\)\)/.test(list),
    '§3 Filter im selben filtered-Memo wie Status/Kunde/Mitarbeiter/Arbeit (UND-Verknüpfung)');
  ok(/filterInvoice, invoices\]\);/.test(list), '§3 Memo hängt an filterInvoice und invoices');
  ok(/data-repair-filter-invoice=\{f\.value \|\| 'all'\}/.test(list)
    && list.includes("{ value: '', label: 'All' }") && list.includes("{ value: 'created', label: 'Invoice Created' }")
    && list.includes("{ value: 'not_created', label: 'Not Created' }"), '§3 Chips All / Invoice Created / Not Created');
  ok(/setIssueFallback\(true\); setFilterInvoice\(''\);/.test(list) && list.includes('filterWorkshopId || filterInvoice'),
    '§3 Reset setzt den Rechnungsfilter zurück');
  ok(/const rechnung = repairInvoiceView\(rep, invoices\);/.test(list) && list.includes('data-repair-invoice-state={rechnung.state}'),
    '§3 jede Zeile zeigt den Rechnungsstatus');
  ok((list.match(/e\.stopPropagation\(\); navigate\(`\/invoices\/\$\{rechnung\.invoiceId\}`\)/g) ?? []).length === 3
    && list.includes('data-repair-invoice-open={rechnung.invoiceId}'), '§3 Rechnung (erstellt, Entwurf, storniert) per Klick öffnen, ohne die Zeile zu öffnen');
  ok(list.includes("color: '#15803D' }}>✓ {rechnung.label}") && list.includes("{rechnung.state === 'created' ? ("),
    '§3 grünes Häkchen nur für „created" (nicht für den Entwurf)');
  ok(/rechnung\.state === 'draft' \? \([\s\S]{0,700}color: '#4B5563' \}\}>\{rechnung\.label\}<\/span>/.test(list)
    && !/rechnung\.state === 'draft' \? \([\s\S]{0,700}✓/.test(list.slice(0, list.indexOf("rechnung.state === 'missing'"))),
    '§3 Entwurf neutral (grau, ohne Häkchen), öffnet die Rechnung');
  ok(/rechnung\.state === 'missing' \? \([\s\S]{0,600}data-repair-invoice-problem[\s\S]{0,400}⚠ \{rechnung\.label\}[\s\S]{0,200}Data problem/.test(list),
    '§3 „Invoice not found" deutlich als Datenproblem (⚠, Rahmen, „Data problem")');
  ok(/<span className="text-overline">STATUS<\/span>\s*<span className="text-overline">INVOICE<\/span>/.test(list),
    '§3 eigene Spalte INVOICE neben (nicht in) STATUS');
  const grid = /const GRID = '([^']+)'/.exec(list)?.[1] ?? '';
  ok(grid.split(' ').length === 9, `§3 Raster 9 Spalten (${grid.split(' ').length})`);
  ok(!/repairInvoiceView\([^)]*status/.test(list) && !/rechnung[^;\n]*rep\.status/.test(list), '§3 kein Ableiten aus rep.status');
}

console.log(`\nREPAIR-INVOICE-INDICATOR: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('REPAIR_INVOICE_INDICATOR_PROVED');

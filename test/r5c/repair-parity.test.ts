// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — Reparatur anlegen, ändern, abrechnen: dieselbe Wirkung auf beiden Seiten.
// Run: node test/r5c/repair-parity.test.ts
//
// Bewiesen an echten Zeilen einer echten sql.js-Datenbank, jeweils ZWEIMAL — einmal über den
// Anschluss der Maske am Primary (`repair-house`), einmal über den Fernbefehl mit genau dem Rumpf,
// den dieselbe Maske am zweiten Rechner baut (`repair-rules`):
//
//   §2 Anlegen: Kunden- UND Eigenreparatur (Artikel, Los, Platzhalter-Kunde, `in_repair`), alle
//      Felder der Maske inkl. Kategorie, Merkmale, Mitarbeiter, Fotos — Zeile für Zeile gleich.
//   §3 Ändern: Zahlwege, Kartenart, Kategorie, Merkmale, Fotos — gleiche Zeile, gleiche Buchungen.
//   §4 Abrechnen: eine oder mehrere Reparaturen desselben Kunden in EINE Rechnung, Dialogwahl.
//   §6 Atomar: ein Fehler mitten im Vorgang hinterlässt NICHTS — beim Anlegen und beim Abrechnen.
//   §8 Autorität: fremde Filiale/Kunde/Artikel/Los/Reparatur, abgerechnete Reparatur, gemischte
//      Kunden, falscher Status, und kein Betrag, keine Steuer, kein Bestand, kein Eigentum, keine
//      Buchung aus dem Rumpf.
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
const { R4C_MATRIX } = await import('../uiparity/_r4c-write-matrix.ts');

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

/** Die fachlich relevanten Spalten einer Reparatur — ohne Kennung, Nummern und Zeitpunkte. */
const COLS = [
  'repair_scope', 'customer_id', 'product_id', 'lot_id', 'item_category_id', 'item_attributes', 'tax_scheme',
  'item_brand', 'item_model', 'item_reference', 'item_serial', 'item_description', 'issue_description',
  'diagnosis', 'repair_type', 'external_vendor', 'workshop_supplier_id', 'estimated_cost', 'actual_cost',
  'internal_cost', 'charge_to_customer', 'margin', 'status', 'estimated_ready', 'notes', 'images', 'staff_id',
  'customer_paid_from', 'customer_card_brand', 'internal_paid_from', 'customer_paid_amount',
  'customer_payment_status', 'customer_payment_method',
].join(', ');
const bildDerReparatur = (db: Db, id: string) => ({
  zeile: row(db, `SELECT ${COLS} FROM repairs WHERE id = ?`, [id]),
  arbeit: all(db, 'SELECT position, supplier_id, work_type, cost_amount, status FROM repair_lines WHERE repair_id = ? ORDER BY position', [id]),
  nummer: s(db, 'SELECT repair_number FROM repairs WHERE id = ?', [id]),
});
const buchungen = (db: Db): string =>
  all(db, 'SELECT account, direction, ROUND(SUM(amount), 3) FROM ledger_entries GROUP BY account, direction ORDER BY account, direction');
const kartengebuehren = (db: Db): string =>
  all(db, "SELECT category, status, ROUND(amount, 3) FROM expenses WHERE related_module = 'repair' ORDER BY category, status, amount");
const unterschiede = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .map((k) => `${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);

// ── §1 Der Umfang: genau die drei Klasse-B-Zeilen, keine neue Buchung ────
{
  const drei = ['repairs.create', 'repairs.update', 'repairs.create_invoice'];
  for (const op of drei) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.paritaet === 'exakt' && z.verdrahtet && z.luecke === null, `SCOPE ${op} ist geschlossen`);
    ok(ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist eine VORHANDENE Buchung`);
  }
  ok(ALLOWED_MUTATIONS.length === 41, `SCOPE nur die freigegebene neue Buchung invoices.cancel (${ALLOWED_MUTATIONS.length})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rustOps = [...(/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '').matchAll(/OP_[A-Z_]+/g)].length;
  ok(rustOps === 108, `SCOPE die Registry steht bei 108 (R5F.1: invoices.cancel) (${rustOps})`);
  for (const op of ['repairs.update_status', 'repairs.add_line', 'repairs.cancel_line']) {
    const z = R4C_MATRIX.find((x) => x.op === op);
    ok(!!z && z.verdrahtet, `SCOPE Nachbar ${op} bleibt verdrahtet`);
  }
}

// ── §2 Anlegen: Kundenreparatur mit allen Feldern der Maske — lokal == fern ──
const FORM_KUNDE = {
  repairScope: 'CUSTOMER', customerId: 'cust-1', itemCategoryId: 'cat-watch',
  itemAttributes: { material: 'Steel', case_diameter_mm: 40, dial: 'Black' },
  itemBrand: ' Rolex ', itemModel: 'Submariner', itemReference: '116610LN', itemSerial: 'Z12345',
  itemDescription: 'Kratzer am Glas', issueDescription: 'Krone klemmt',
  repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 30, chargeToCustomer: 90,
  taxScheme: 'ZERO', estimatedReady: '2026-09-20', staffId: 'emp-1', notes: 'Kunde wartet',
  images: [alsDataUrl(bild(1))],
} as never;
let lokalKunde: ReturnType<typeof bildDerReparatur>;
{
  const db = freshDb();
  const r = await house.createRepairOnPrimary(FORM_KUNDE);
  lokalKunde = bildDerReparatur(db, r.id);
}
{
  const db = freshDb();
  const body = rules.repairCreateBody(FORM_KUNDE, await ablegen([alsDataUrl(bild(1))]));
  ok(!JSON.stringify(body).includes('base64'), 'CREATE der Auftrag traegt keine Bildbytes — nur Ablagekennungen');
  for (const k of ['repairNumber', 'voucherCode', 'status', 'margin', 'internalCost']) {
    ok(!(k in body) || (k === 'internalCost' && body[k] === undefined), `CREATE der Rumpf traegt kein ${k}`);
  }
  const out = await cmd.runRepairCreate(deps(db), identity('1', 'repairs.create'), body);
  ok(out.kind === 'ok', `CREATE der Fernbefehl legt an (${JSON.stringify(out).slice(0, 200)})`);
  const rid = val<{ repairId: string }>(out).repairId;
  const fern = bildDerReparatur(db, rid);
  const d = unterschiede(lokalKunde.zeile, fern.zeile);
  ok(d.length === 0, `CREATE lokal == fern, Spalte fuer Spalte${d.length ? ' — ' + d.join(' | ') : ''}`);
  ok(lokalKunde.arbeit === fern.arbeit, `CREATE …und dieselbe erste Arbeitszeile (${fern.arbeit})`);
  ok(lokalKunde.nummer === fern.nummer, `CREATE …und dieselbe Nummer aus demselben Zaehler (${fern.nummer})`);
  const z = fern.zeile;
  ok(JSON.parse(String(z.item_attributes)).material === 'Steel' && z.item_category_id === 'cat-watch',
    'CREATE Kategorie und Merkmale kommen an');
  ok(z.item_reference === '116610LN' && z.item_description === 'Kratzer am Glas' && z.staff_id === 'emp-1',
    'CREATE Referenz, Beschreibung und Mitarbeiter kommen an');
  ok(z.item_brand === 'Rolex', `CREATE der Text ist auf beiden Seiten gleich aufbereitet (${JSON.stringify(z.item_brand)})`);
  ok(z.tax_scheme === 'ZERO' && Number(z.internal_cost) === 30, 'CREATE Steuerwahl und die abgeleiteten eigenen Kosten');
  ok(JSON.parse(String(z.images))[0] === alsDataUrl(bild(1)), 'CREATE das Foto steht byte-gleich in der Reparatur');
  ok(tauriState.discarded.length === 1, 'CREATE …und die Ablage ist nach dem Erfolg geraeumt');
  const again = await cmd.runRepairCreate(deps(db), identity('1', 'repairs.create'), body);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true
    && val<{ repairId: string }>(again).repairId === rid, 'CREATE eine verlorene Antwort: dieselbe Kennung liefert dieselbe Reparatur');
  ok(n(db, 'SELECT COUNT(*) FROM repairs') === 1, 'CREATE …und keine zweite');
}

// ── §2 Anlegen: EIGENE Ware — Artikel, Los, Platzhalter-Kunde, in_repair ───
const FORM_OWN = {
  repairScope: 'OWN', productId: 'p2', lotId: 'lot-p2', issueDescription: 'Politur',
  repairType: 'hybrid', workshopSupplierId: 'sup-1', internalCost: 10, estimatedCost: 25,
  estimatedReady: '2026-09-22', staffId: 'emp-1', notes: 'eigene Ware',
  // Liegengeblieben vom Umschalten — die Maske zeigt das bei eigener Ware nicht.
  customerId: 'cust-1', chargeToCustomer: 70, taxScheme: 'ZERO', itemDescription: 'alt',
  itemAttributes: { dial: 'Blue' }, itemBrand: 'Falsch',
} as never;
let lokalOwn: ReturnType<typeof bildDerReparatur>;
{
  const db = freshDb();
  const r = await house.createRepairOnPrimary(FORM_OWN);
  lokalOwn = bildDerReparatur(db, r.id);
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'p2'") === 'in_repair', 'OWN am Primary: der Artikel ist in Reparatur');
}
{
  const db = freshDb();
  const body = rules.repairCreateBody(FORM_OWN, []);
  for (const k of ['customerId', 'chargeToCustomer', 'taxScheme', 'itemDescription', 'itemAttributes', 'itemBrand']) {
    ok(!(k in body), `OWN der Rumpf traegt kein ${k} — die Maske zeigt es bei eigener Ware nicht`);
  }
  const out = await cmd.runRepairCreate(deps(db), identity('2', 'repairs.create'), body);
  ok(out.kind === 'ok', `OWN der Fernbefehl legt die Reparatur an eigener Ware an (${JSON.stringify(out).slice(0, 200)})`);
  const rid = val<{ repairId: string }>(out).repairId;
  const fern = bildDerReparatur(db, rid);
  const d = unterschiede(lokalOwn.zeile, fern.zeile);
  ok(d.length === 0, `OWN lokal == fern${d.length ? ' — ' + d.join(' | ') : ''}`);
  ok(lokalOwn.arbeit === fern.arbeit, 'OWN …mit derselben ersten Arbeitszeile');
  const z = fern.zeile;
  ok(z.repair_scope === 'OWN' && z.customer_id === 'sys-own-shop-branch-main', 'OWN den Platzhalter-Kunden setzt der Primary');
  ok(z.product_id === 'p2' && z.lot_id === 'lot-p2', 'OWN Artikel und gewaehltes Los stehen an der Reparatur');
  ok(z.item_brand === 'Rolex' && z.item_model === 'M p2' && z.item_reference === 'SKU-p2' && z.item_category_id === 'cat-w',
    'OWN die Artikelangaben kommen vom Artikel, nicht aus liegengebliebenen Feldern');
  ok(z.charge_to_customer === null && z.tax_scheme === 'VAT_10' && z.item_description === null && z.item_attributes === '{}',
    'OWN kein Kundenpreis, keine Steuerwahl, keine fremden Merkmale');
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'p2'") === 'in_repair', 'OWN der Artikel ist in Reparatur — vom Haus gesetzt');
  const again = await cmd.runRepairCreate(deps(db), identity('2', 'repairs.create'), body);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true && n(db, 'SELECT COUNT(*) FROM repairs') === 1,
    'OWN eine Wiederholung legt nichts zweimal an');
}

// ── §8 Anlegen: was der Rumpf NICHT bestimmt, und was der Primary ablehnt ──
{
  const db = freshDb();
  const falsch: Array<[string, Record<string, unknown>, string]> = [
    ['ein Artikel einer fremden Filiale', { repairScope: 'OWN', productId: 'p-foreign', issueDescription: 'x' }, 'PRODUCT_NOT_FOUND'],
    ['Kommissionsware', { repairScope: 'OWN', productId: 'p-cons', issueDescription: 'x' }, 'PRODUCT_NOT_OWN'],
    ['der Service-Artikel', { repairScope: 'OWN', productId: 'svc-repair-branch-main', issueDescription: 'x' }, 'PRODUCT_NOT_OWN'],
    ['das Los eines anderen Artikels', { repairScope: 'OWN', productId: 'p2', lotId: 'lot-p1', issueDescription: 'x' }, 'LOT_NOT_FOUND'],
    ['ein Kunde einer fremden Filiale', { customerId: 'cust-x', issueDescription: 'x' }, 'CUSTOMER_NOT_FOUND'],
    ['der Platzhalter-Kunde', { customerId: 'sys-own-shop-branch-main', issueDescription: 'x' }, 'CUSTOMER_NOT_FOUND'],
    ['eine fremde Werkstatt', { customerId: 'cust-1', issueDescription: 'x', repairType: 'external', workshopSupplierId: 'sup-other' }, 'SUPPLIER_NOT_FOUND'],
    ['ein fremder Mitarbeiter', { customerId: 'cust-1', issueDescription: 'x', staffId: 'emp-x' }, 'EMPLOYEE_NOT_FOUND'],
    ['ein ausgeschiedener Mitarbeiter', { customerId: 'cust-1', issueDescription: 'x', staffId: 'emp-gone' }, 'EMPLOYEE_NOT_FOUND'],
    ['eine fremde Kategorie', { customerId: 'cust-1', issueDescription: 'x', itemCategoryId: 'cat-foreign' }, 'CATEGORY_NOT_FOUND'],
    ['fehlende Pflichtfelder der Kategorie', { customerId: 'cust-1', issueDescription: 'x', itemCategoryId: 'cat-watch', itemModel: 'Sub' }, 'REQUIRED_FIELDS_MISSING'],
  ];
  let k = 100;
  for (const [was, body, erwartet] of falsch) {
    k += 1;
    const out = await cmd.runRepairCreate(deps(db), identity(String(k), 'repairs.create'), body);
    ok(out.kind === 'rejected' && code(out) === erwartet && frozen(out), `AUTHORITY ${was} → ${erwartet} (${code(out) || out.kind})`);
  }
  ok(n(db, 'SELECT COUNT(*) FROM repairs') === 0, 'AUTHORITY keine der Absagen hat eine Reparatur hinterlassen');
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'p2'") === 'in_stock', 'AUTHORITY …und kein Artikel steht in Reparatur');
  ok(n(db, "SELECT COUNT(*) FROM customers WHERE id LIKE 'sys-%'") === 0, 'AUTHORITY …und kein Platzhalter-Kunde entstand');

  const rumpf: Array<[string, Record<string, unknown>]> = [
    ['einen Kunden an eigener Ware', { repairScope: 'OWN', productId: 'p2', customerId: 'cust-1', issueDescription: 'x' }],
    ['einen Preis an eigener Ware', { repairScope: 'OWN', productId: 'p2', chargeToCustomer: 50, issueDescription: 'x' }],
    ['eine Steuerwahl an eigener Ware', { repairScope: 'OWN', productId: 'p2', taxScheme: 'ZERO', issueDescription: 'x' }],
    ['Artikelangaben an eigener Ware', { repairScope: 'OWN', productId: 'p2', itemBrand: 'X', issueDescription: 'x' }],
    ['einen Artikel an einer Kundenreparatur', { customerId: 'cust-1', productId: 'p2', issueDescription: 'x' }],
    ['ein Los an einer Kundenreparatur', { customerId: 'cust-1', lotId: 'lot-p2', issueDescription: 'x' }],
    ['die Steuer MARGIN', { customerId: 'cust-1', taxScheme: 'MARGIN', issueDescription: 'x' }],
    ['einen freien Werkstattnamen', { customerId: 'cust-1', externalVendor: 'X', issueDescription: 'x' }],
    ['einen Bestandsstatus', { repairScope: 'OWN', productId: 'p2', stockStatus: 'in_stock', issueDescription: 'x' }],
    ['eine Marge', { customerId: 'cust-1', margin: 5, issueDescription: 'x' }],
    ['einen Zahlweg', { customerId: 'cust-1', customerPaidFrom: 'cash', issueDescription: 'x' }],
    ['eine Buchungskennung', { customerId: 'cust-1', customerPaymentLedgerId: 'x', issueDescription: 'x' }],
    ['eine Belegnummer', { customerId: 'cust-1', repairNumber: 'REP-1', issueDescription: 'x' }],
    ['eine Filiale', { customerId: 'cust-1', branchId: 'branch-other', issueDescription: 'x' }],
    ['Bildbytes', { customerId: 'cust-1', photos: [{ dataUrl: alsDataUrl(bild(9)) }], issueDescription: 'x' }],
    ['ein „vorhandenes" Foto an einer neuen Reparatur', { customerId: 'cust-1', photos: [{ keep: 0 }], issueDescription: 'x' }],
    ['einen negativen Preis', { customerId: 'cust-1', chargeToCustomer: -5, issueDescription: 'x' }],
    ['ein verschachteltes Merkmal', { customerId: 'cust-1', itemAttributes: { a: { b: 1 } }, issueDescription: 'x' }],
  ];
  for (const [was, body] of rumpf) {
    let warf = '';
    try { cmd.parseRepairCreate(body); } catch (e) { warf = e instanceof Error ? e.message : String(e); }
    ok(warf !== '', `AUTHORITY der Anlegerumpf nimmt ${was} nicht an (${warf || 'DURCHGELASSEN'})`);
  }
}

// ── §6 Anlegen atomar: ein Fehler mitten im Vorgang hinterlässt NICHTS ───
for (const weg of ['fern', 'lokal'] as const) {
  const db = freshDb();
  db.run("CREATE TRIGGER r5c_fail_line BEFORE INSERT ON repair_lines BEGIN SELECT RAISE(ABORT, 'r5c injected'); END;");
  const form = { repairScope: 'OWN', productId: 'p2', issueDescription: 'Politur', repairType: 'hybrid', workshopSupplierId: 'sup-1', estimatedCost: 25 } as never;
  let warf = false;
  try {
    if (weg === 'fern') await cmd.runRepairCreate(deps(db), identity('300', 'repairs.create'), rules.repairCreateBody(form, []));
    else await house.createRepairOnPrimary(form);
  } catch { warf = true; }
  ok(warf, `ATOMIC (${weg}) der eingeschleuste Fehler bei der Arbeitszeile bricht das Anlegen ab`);
  ok(n(db, 'SELECT COUNT(*) FROM repairs') === 0, `ATOMIC (${weg}) keine Reparatur steht da`);
  ok(s(db, "SELECT stock_status FROM products WHERE id = 'p2'") === 'in_stock', `ATOMIC (${weg}) der Artikel ist NICHT in Reparatur`);
  ok(n(db, "SELECT COUNT(*) FROM customers WHERE id LIKE 'sys-%'") === 0, `ATOMIC (${weg}) kein Platzhalter-Kunde`);
  db.run('DROP TRIGGER r5c_fail_line');
  const r = await house.createRepairOnPrimary(form);
  ok(/-00001$/.test(r.repairNumber), `ATOMIC (${weg}) auch der Nummernzaehler ist zurueckgenommen (${r.repairNumber})`);
}

// ── §3 Ändern: dieselbe „Save"-Maske, lokal und fern — Zeile UND Buchungen ──
async function aendernZwilling(weg: 'lokal' | 'fern') {
  const db = freshDb();
  const r = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Krone klemmt', repairType: 'internal',
    estimatedCost: 40, chargeToCustomer: 100, taxScheme: 'VAT_10', images: [alsDataUrl(bild(2))],
  } as never);
  const rid = r.id;
  // Altbestand ohne Feld in der „Save"-Maske: ein freier Werkstattname und die Steuer MARGIN. Vor R5C
  // schrieb Save beides aus dem Formular zurück — MARGIN dabei still als VAT_10 (`rowToRepair`).
  db.run("UPDATE repairs SET external_vendor = 'Alt-Werkstatt', tax_scheme = 'MARGIN' WHERE id = ?", [rid]);
  const rs = useRepairStore.getState();
  const schritte: Array<(seen: Record<string, unknown>) => Record<string, unknown>> = [
    (seen) => ({
      ...seen, customerPaidFrom: 'card', customerCardBrand: 'amex', internalPaidFrom: 'benefit',
      itemCategoryId: 'cat-watch', itemAttributes: { material: 'Steel', dial: 'Blue' },
      itemBrand: 'Rolex', itemModel: 'Daytona', itemReference: '116500', itemDescription: 'neu',
      issueDescription: 'Glas ersetzen', diagnosis: 'Glas gesprungen', actualCost: 55, chargeToCustomer: 150,
      images: [(seen.images as string[])[0], alsDataUrl(bild(3))],
    }),
    // Nur die Kartenart wechselt: die Gebühr MUSS neu gebucht werden (2,5 % → 2,2 %).
    (seen) => ({ ...seen, customerCardBrand: 'normal' }),
    // Bar statt Karte, Foto entfernt, Kategorie geleert.
    (seen) => ({ ...seen, customerPaidFrom: 'cash', itemCategoryId: undefined, itemAttributes: {}, images: [] }),
    // Zurück auf Karte: die versteckte alte Kartenart kommt NICHT wieder — die Maske zeigt „Normal".
    (seen) => ({ ...seen, customerPaidFrom: 'card' }),
  ];
  const bilder: Array<ReturnType<typeof bildDerReparatur> & { buchungen: string; gebuehren: string }> = [];
  let k = 400;
  for (const schritt of schritte) {
    rs.loadRepairs();
    const seen = rs.getRepair(rid) as unknown as Record<string, unknown>;
    const form = schritt(seen);
    if (weg === 'lokal') {
      await house.updateRepairOnPrimary(rid, form as never);
    } else {
      const photos = rules.repairPhotosChanged(seen as never, form as never)
        ? await rules.repairPhotoPlan(seen.images as string[], form.images as string[], ablegen)
        : undefined;
      const body = rules.repairEditBody(rid, rev(db, rid), seen as never, form as never, photos);
      ok(!('margin' in body) && !('internalCost' in body && body.internalCost !== form.internalCost),
        `EDIT (${weg}) der Rumpf traegt keine Marge und keine abgeleiteten Kosten`);
      ok(!JSON.stringify(body).includes('base64'), `EDIT (${weg}) …und keine Bildbytes`);
      k += 1;
      const out = await cmd.runRepairUpdate(deps(db), identity(String(k), 'repairs.update'), body);
      ok(out.kind === 'ok', `EDIT (${weg}) der Fernbefehl speichert (${JSON.stringify(out).slice(0, 200)})`);
    }
    bilder.push({ ...bildDerReparatur(db, rid), buchungen: buchungen(db), gebuehren: kartengebuehren(db) });
  }
  return { db, rid, bilder };
}
{
  const lokal = await aendernZwilling('lokal');
  const fern = await aendernZwilling('fern');
  ok(lokal.bilder.length === 4 && fern.bilder.length === 4, 'EDIT vier Speichervorgaenge auf beiden Wegen');
  for (let i = 0; i < lokal.bilder.length; i++) {
    const d = unterschiede(lokal.bilder[i].zeile, fern.bilder[i].zeile);
    ok(d.length === 0, `EDIT Schritt ${i + 1}: lokal == fern, Spalte fuer Spalte${d.length ? ' — ' + d.join(' | ') : ''}`);
    ok(lokal.bilder[i].buchungen === fern.bilder[i].buchungen,
      `EDIT Schritt ${i + 1}: dieselben Buchungen je Konto (${fern.bilder[i].buchungen})`);
    ok(lokal.bilder[i].gebuehren === fern.bilder[i].gebuehren,
      `EDIT Schritt ${i + 1}: dieselben Kartengebuehren (${fern.bilder[i].gebuehren})`);
  }
  const z1 = fern.bilder[0].zeile;
  ok(z1.customer_paid_from === 'card' && z1.customer_card_brand === 'amex' && z1.internal_paid_from === 'benefit',
    'EDIT die Zahlwege der Maske kommen an');
  ok(z1.customer_payment_status === 'PAID' && Number(z1.customer_paid_amount) === 150,
    'EDIT …und die Kundenzahlung ist vom Haus gebucht');
  ok(Number(z1.internal_cost) === 55 && Number(z1.margin) === 95,
    `EDIT eigene Kosten und Marge leitet der Primary ab (${z1.internal_cost} / ${z1.margin})`);
  ok(z1.item_category_id === 'cat-watch' && JSON.parse(String(z1.item_attributes)).dial === 'Blue'
    && z1.item_reference === '116500' && z1.item_description === 'neu' && z1.issue_description === 'Glas ersetzen',
    'EDIT Kategorie, Merkmale, Referenz, Beschreibung und Problem kommen an');
  const fotos = JSON.parse(String(z1.images)) as string[];
  ok(fotos.length === 2 && fotos[0] === alsDataUrl(bild(2)) && fotos[1] === alsDataUrl(bild(3)),
    'EDIT das vorhandene Foto bleibt, das neue kommt dahinter — byte-gleich');
  ok(/"active"|"ACTIVE"|PENDING|PAID/.test(fern.bilder[0].gebuehren) || fern.bilder[0].gebuehren !== '[]',
    `EDIT bei Kartenzahlung entsteht die Kartengebuehr (${fern.bilder[0].gebuehren})`);
  ok(fern.bilder[1].gebuehren !== fern.bilder[0].gebuehren, 'EDIT ein Wechsel der Kartenart bucht die Gebuehr neu');
  const z3 = fern.bilder[2].zeile;
  ok(z3.customer_paid_from === 'cash' && z3.customer_card_brand === null && z3.item_category_id === null && z3.images === '[]',
    'EDIT bar statt Karte: keine Kartenart mehr; Kategorie und Fotos geleert');
  const z4 = fern.bilder[3].zeile;
  ok(z4.customer_paid_from === 'card' && z4.customer_card_brand === 'normal' && lokal.bilder[3].zeile.customer_card_brand === 'normal',
    'HIDDEN zurueck auf Karte: die versteckte alte Kartenart (amex) kommt nicht wieder — es gilt die angezeigte');
  ok(z4.external_vendor === 'Alt-Werkstatt' && z4.tax_scheme === 'MARGIN'
    && lokal.bilder[3].zeile.external_vendor === 'Alt-Werkstatt' && lokal.bilder[3].zeile.tax_scheme === 'MARGIN',
    'HIDDEN nach vier Mal „Save": gespeicherte Daten ohne Feld in der Maske bleiben unberuehrt (lokal und fern)');

  // §8 — was ein Änderungsauftrag nicht darf, und was der Primary ablehnt.
  const db = fern.db; const rid = fern.rid;
  const seen = rev(db, rid);
  const stale = await cmd.runRepairUpdate(deps(db), identity('450', 'repairs.update'), { id: rid, expectedRevision: seen - 1, notes: 'alt' });
  ok(stale.kind === 'rejected' && code(stale) === 'RECORD_CHANGED' && frozen(stale), 'EDIT-AUTH ein alter Stand traegt nicht');
  const keep = await cmd.runRepairUpdate(deps(db), identity('451', 'repairs.update'), { id: rid, expectedRevision: seen, photos: [{ keep: 3 }] });
  ok(keep.kind === 'rejected' && code(keep) === 'PHOTO_NOT_FOUND' && frozen(keep), 'EDIT-AUTH ein Foto, das es nicht gibt, ist ein Nein');
  let warf = false;
  try {
    await cmd.runRepairUpdate(deps(db), identity('452', 'repairs.update'), { id: rid, expectedRevision: seen, photos: [{ stagingId: 'a'.repeat(64) }] });
  } catch { warf = true; }
  ok(warf && rev(db, rid) === seen, 'EDIT-AUTH eine fremde oder verschwundene Ablage schreibt nichts');
  const cat = await cmd.runRepairUpdate(deps(db), identity('453', 'repairs.update'), { id: rid, expectedRevision: seen, itemCategoryId: 'cat-foreign' });
  ok(cat.kind === 'rejected' && code(cat) === 'CATEGORY_NOT_FOUND', 'EDIT-AUTH eine fremde Kategorie ist keine');
  insert(db, 'repairs', {
    id: 'rep-foreign', branch_id: 'branch-other', repair_number: 'REP-X-1', customer_id: 'cust-x', issue_description: 'x',
    status: 'ready', received_at: NOW, voucher_code: 'FOREIGN1', charge_to_customer: 50, repair_scope: 'CUSTOMER', created_at: NOW, updated_at: NOW,
  });
  const foreign = await cmd.runRepairUpdate(deps(db), identity('454', 'repairs.update'), { id: 'rep-foreign', expectedRevision: 1, notes: 'x' });
  ok(foreign.kind === 'rejected' && code(foreign) === 'REPAIR_NOT_FOUND', 'EDIT-AUTH eine Reparatur einer fremden Filiale gibt es hier nicht');
  for (const [f, v] of [
    ['margin', 5], ['customerPaidAmount', 150], ['customerPaymentStatus', 'PAID'], ['customerPaymentLedgerId', 'x'],
    ['status', 'ready'], ['taxScheme', 'ZERO'], ['externalVendor', 'X'], ['repairScope', 'OWN'], ['productId', 'p1'],
    ['customerPaidFrom', 'crypto'], ['customerCardBrand', 'visa'], ['internalPaidFrom', 'card'],
    ['photos', [{ dataUrl: 'data:image/jpeg;base64,AAAA' }]], ['chargeToCustomer', -1],
  ] as const) {
    let t = false;
    try { cmd.parseRepairUpdate({ id: rid, expectedRevision: 1, [f]: v }); } catch { t = true; }
    ok(t, `EDIT-AUTH der Aenderungsauftrag nimmt ${f} = ${JSON.stringify(v)} nicht an`);
  }
}

// ── §4 Abrechnen: eine oder mehrere, dieselbe Hausfunktion — lokal == fern ──
async function reparatur(form: Record<string, unknown>): Promise<string> {
  const r = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Service', repairType: 'internal',
    estimatedCost: 20, chargeToCustomer: 90, taxScheme: 'VAT_10', ...form,
  } as never);
  return r.id;
}
function schalten(id: string, ...stufen: string[]): void {
  const rs = useRepairStore.getState();
  for (const st of stufen) { rs.loadRepairs(); rs.updateStatus(id, st as never); }
  rs.loadRepairs();
}
const rechnungsBild = (db: Db, invId: string) => {
  const kopf = row(db, 'SELECT * FROM invoices WHERE id = ?', [invId]);
  for (const k of ['id', 'created_at', 'updated_at', 'issued_at', 'due_at', 'revision', 'created_by']) delete kopf[k];
  const zeilen = all(db, `SELECT product_id, unit_price, purchase_price_snapshot, tax_scheme, vat_rate, vat_amount, line_total
    FROM invoice_lines WHERE invoice_id = ? ORDER BY rowid`, [invId]);
  return { kopf, zeilen };
};
async function abrechnenZwilling(weg: 'lokal' | 'fern') {
  const db = freshDb();
  const a = await reparatur({ chargeToCustomer: 90, taxScheme: 'VAT_10' });
  const b = await reparatur({ chargeToCustomer: 60, taxScheme: 'ZERO', repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 25 });
  schalten(a, 'in_progress', 'ready');
  schalten(b, 'in_progress', 'ready');
  let invoiceId = '';
  if (weg === 'lokal') {
    invoiceId = (await house.invoiceRepairsOnPrimary([a, b])).invoiceId;
  } else {
    const rs = useRepairStore.getState();
    const body = rules.repairInvoiceBody([rs.getRepair(a)!, rs.getRepair(b)!]);
    ok(Object.keys(body).join(',') === 'repairs', `INVOICE der Rumpf nennt nur die Reparaturen und ihre Fassung (${Object.keys(body)})`);
    const out = await life.runCreateRepairInvoice(deps(db), identity('500', 'repairs.create_invoice'), body);
    ok(out.kind === 'ok', `INVOICE der Fernbefehl rechnet beide ab (${JSON.stringify(out).slice(0, 200)})`);
    invoiceId = String(val<Record<string, unknown>>(out).invoiceId);
    const replay = await life.runCreateRepairInvoice(deps(db), identity('500', 'repairs.create_invoice'), body);
    ok(replay.kind === 'ok' && (replay as { replayed: boolean }).replayed && String(val<Record<string, unknown>>(replay).invoiceId) === invoiceId,
      'INVOICE eine verlorene Antwort liefert DIESELBE Rechnung');
  }
  return { db, a, b, invoiceId, bild: rechnungsBild(db, invoiceId), buchungen: buchungen(db) };
}
{
  const lokal = await abrechnenZwilling('lokal');
  const fern = await abrechnenZwilling('fern');
  const d = unterschiede(lokal.bild.kopf, fern.bild.kopf).filter((x) => !x.startsWith('invoice_number') || true);
  ok(d.length === 0, `INVOICE der Rechnungskopf ist lokal == fern${d.length ? ' — ' + d.join(' | ') : ''}`);
  ok(lokal.bild.zeilen === fern.bild.zeilen, `INVOICE …die Zeilen auch (${fern.bild.zeilen})`);
  ok(lokal.buchungen === fern.buchungen, `INVOICE …und die Buchungen je Konto (${fern.buchungen})`);
  const db = fern.db;
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 1, 'INVOICE genau EINE Rechnung fuer beide Reparaturen');
  ok(n(db, 'SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?', [fern.invoiceId]) === 2, 'INVOICE …mit einer Zeile je Reparatur');
  ok(s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [fern.a]) === fern.invoiceId
    && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [fern.b]) === fern.invoiceId, 'INVOICE beide tragen die Rechnung');
  ok(all(db, 'SELECT DISTINCT tax_scheme FROM invoice_lines WHERE invoice_id = ? ORDER BY 1', [fern.invoiceId]) === '[["VAT_10"],["ZERO"]]',
    'INVOICE jede Zeile mit dem Schema IHRER Reparatur');
  ok(/^Combined Repair Service · /.test(s(db, 'SELECT notes FROM invoices WHERE id = ?', [fern.invoiceId])), 'INVOICE der Sammelvermerk');
  ok(s(db, 'SELECT status FROM repairs WHERE id = ?', [fern.a]) === 'ready', 'INVOICE der Reparaturstatus bleibt, wie er war');

  // Einzeln, „abgeholt", mit der Wahl der Dialoge der Detailseite.
  const c = await reparatur({ chargeToCustomer: 40, taxScheme: 'VAT_10', issueDescription: 'Batterie' });
  schalten(c, 'in_progress', 'ready', 'picked_up');
  const one1 = await life.runCreateRepairInvoice(deps(db), identity('510', 'repairs.create_invoice'),
    { repairId: c, expectedRevision: rev(db, c), taxScheme: 'ZERO', specialMark: true });
  ok(one1.kind === 'ok', `INVOICE eine abgeholte Reparatur wird abgerechnet (${code(one1) || 'ok'})`);
  const inv1 = String(val<Record<string, unknown>>(one1).invoiceId);
  ok(s(db, 'SELECT tax_scheme FROM invoice_lines WHERE invoice_id = ?', [inv1]) === 'ZERO'
    && n(db, 'SELECT vat_amount FROM invoice_lines WHERE invoice_id = ?', [inv1]) === 0, 'INVOICE die Steuerwahl des Dialogs gilt');
  ok(s(db, 'SELECT tax_scheme FROM repairs WHERE id = ?', [c]) === 'ZERO', 'INVOICE …und steht danach an der Reparatur (v0.7.6)');
  ok(n(db, 'SELECT special_mark FROM invoices WHERE id = ?', [inv1]) === 1, 'INVOICE die Nummernart des Dialogs erreicht die Rechnung');
  ok(/^Repair Service · REP-[\d-]+ · Batterie$/.test(s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv1])),
    `INVOICE der Einzelvermerk wie an der Detailseite (${s(db, 'SELECT notes FROM invoices WHERE id = ?', [inv1])})`);
  // R5C FINAL — ohne Dialog (das Kürzel der Liste) bleibt es beim Vermerk der Liste, wie vor R5C.
  const q = await reparatur({ chargeToCustomer: 35, issueDescription: 'Band' });
  schalten(q, 'in_progress', 'ready');
  const quick = await life.runCreateRepairInvoice(deps(db), identity('515', 'repairs.create_invoice'), { repairId: q, expectedRevision: rev(db, q) });
  const invQ = String(val<Record<string, unknown>>(quick).invoiceId);
  ok(/^Combined Repair Service · REP-[\d-]+$/.test(s(db, 'SELECT notes FROM invoices WHERE id = ?', [invQ]))
    && n(db, 'SELECT special_mark FROM invoices WHERE id = ?', [invQ]) === 0,
    `INVOICE das Kuerzel der Liste traegt den Vermerk der Liste (${s(db, 'SELECT notes FROM invoices WHERE id = ?', [invQ])})`);

  // §8 — die Neins.
  const d2 = await reparatur({ customerId: 'cust-2', chargeToCustomer: 50 });
  const e = await reparatur({ chargeToCustomer: 70 });
  const f = await reparatur({ chargeToCustomer: 30 });
  schalten(d2, 'in_progress', 'ready');
  schalten(e, 'in_progress', 'ready');
  const own = (await house.createRepairOnPrimary({ repairScope: 'OWN', productId: 'p1', issueDescription: 'x' } as never)).id;
  schalten(own, 'in_progress', 'ready');
  const vorher = n(db, 'SELECT COUNT(*) FROM invoices');
  const ledgerVorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const faelle: Array<[string, Record<string, unknown>, string]> = [
    ['gemischte Kunden', { repairs: [{ repairId: e, expectedRevision: rev(db, e) }, { repairId: d2, expectedRevision: rev(db, d2) }] }, 'REPAIRS_DIFFERENT_CUSTOMERS'],
    ['eine schon abgerechnete darunter', { repairs: [{ repairId: e, expectedRevision: rev(db, e) }, { repairId: fern.a, expectedRevision: rev(db, fern.a) }] }, 'REPAIR_ALREADY_INVOICED'],
    ['eine noch nicht fertige', { repairId: f, expectedRevision: rev(db, f) }, 'REPAIR_NOT_READY'],
    ['eigene Ware', { repairId: own, expectedRevision: rev(db, own) }, 'REPAIR_IS_OWN_STOCK'],
    ['eine fremde Filiale', { repairId: 'rep-foreign-x', expectedRevision: 1 }, 'REPAIR_NOT_FOUND'],
    ['ein alter Stand', { repairId: e, expectedRevision: rev(db, e) - 1 }, 'RECORD_CHANGED'],
  ];
  insert(db, 'repairs', {
    id: 'rep-foreign-x', branch_id: 'branch-other', repair_number: 'REP-X-2', customer_id: 'cust-x', issue_description: 'x',
    status: 'ready', received_at: NOW, voucher_code: 'FOREIGN2', charge_to_customer: 50, repair_scope: 'CUSTOMER', created_at: NOW, updated_at: NOW,
  });
  let k = 520;
  for (const [was, body, erwartet] of faelle) {
    k += 1;
    const out = await life.runCreateRepairInvoice(deps(db), identity(String(k), 'repairs.create_invoice'), body);
    ok(out.kind === 'rejected' && code(out) === erwartet && frozen(out), `INVOICE-AUTH ${was} → ${erwartet} (${code(out) || out.kind})`);
  }
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === vorher && n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerVorher,
    'INVOICE-AUTH keine Absage hat eine Rechnung oder Buchung hinterlassen');
  ok(s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [e]) === '', 'INVOICE-AUTH …und die gueltige Reparatur daneben ist unberuehrt');
  for (const [was, body] of [
    ['dieselbe Reparatur zweimal', { repairs: [{ repairId: e, expectedRevision: 1 }, { repairId: e, expectedRevision: 1 }] }],
    ['beide Formen zugleich', { repairId: e, expectedRevision: 1, repairs: [{ repairId: e, expectedRevision: 1 }] }],
    ['eine leere Liste', { repairs: [] }],
    ['Zeilen', { repairId: e, expectedRevision: 1, lines: [{ lineTotal: 1 }] }],
    ['einen Betrag', { repairId: e, expectedRevision: 1, grossAmount: 1 }],
    ['eine Steuer', { repairId: e, expectedRevision: 1, vatAmount: 0 }],
    ['eine Rechnungsnummer', { repairId: e, expectedRevision: 1, invoiceNumber: 'RPINV-1' }],
    ['einen Kunden', { repairId: e, expectedRevision: 1, customerId: 'cust-2' }],
    ['einen Einstand', { repairs: [{ repairId: e, expectedRevision: 1, purchasePrice: 0 }] }],
    ['die Steuer MARGIN', { repairId: e, expectedRevision: 1, taxScheme: 'MARGIN' }],
    ['eine Nummernart als Text', { repairId: e, expectedRevision: 1, specialMark: 'yes' }],
    ['einen Dialog ueber mehrere Reparaturen', { repairs: [{ repairId: e, expectedRevision: 1 }, { repairId: f, expectedRevision: 1 }], taxScheme: 'ZERO' }],
    ['eine Nummernart ohne Steuerdialog', { repairId: e, expectedRevision: 1, specialMark: true }],
  ] as const) {
    let t = '';
    try { life.parseCreateRepairInvoice(body); } catch (x) { t = x instanceof Error ? x.message : String(x); }
    ok(t !== '', `INVOICE-AUTH der Rechnungsrumpf nimmt ${was} nicht an (${t || 'DURCHGELASSEN'})`);
  }
}

// ── §6 Abrechnen atomar: Beleg, ALLE Verknüpfungen, Buchung — oder nichts ──
for (const weg of ['fern', 'lokal'] as const) {
  const db = freshDb();
  const a = await reparatur({ chargeToCustomer: 90 });
  const b = await reparatur({ chargeToCustomer: 60 });
  schalten(a, 'in_progress', 'ready');
  schalten(b, 'in_progress', 'ready');
  const ledgerVorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  // Die ZWEITE Verknüpfung scheitert — die erste, der Beleg und die Buchung sind dann schon geschrieben.
  db.run(`CREATE TRIGGER r5c_fail_link BEFORE UPDATE OF invoice_id ON repairs
    WHEN NEW.id = '${b}' AND NEW.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'r5c injected'); END;`);
  let warf = false;
  try {
    const rs = useRepairStore.getState();
    if (weg === 'fern') {
      await life.runCreateRepairInvoice(deps(db), identity('600', 'repairs.create_invoice'),
        rules.repairInvoiceBody([rs.getRepair(a)!, rs.getRepair(b)!]));
    } else {
      await house.invoiceRepairsOnPrimary([a, b]);
    }
  } catch { warf = true; }
  ok(warf, `ATOMIC-INV (${weg}) der Fehler bei der zweiten Verknuepfung bricht die Rechnung ab`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 0 && n(db, 'SELECT COUNT(*) FROM invoice_lines') === 0,
    `ATOMIC-INV (${weg}) kein Beleg, keine Zeile`);
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerVorher, `ATOMIC-INV (${weg}) keine Buchung`);
  ok(s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [a]) === '' && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [b]) === '',
    `ATOMIC-INV (${weg}) auch die ERSTE Verknuepfung ist zurueckgenommen`);
  db.run('DROP TRIGGER r5c_fail_link');
  const nachher = await house.invoiceRepairsOnPrimary([a, b]);
  ok(/-0*1$/.test(s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [nachher.invoiceId])),
    `ATOMIC-INV (${weg}) die Rechnungsnummer ist nicht verbraucht (${s(db, 'SELECT invoice_number FROM invoices WHERE id = ?', [nachher.invoiceId])})`);
}

// ── §6 Einzelrechnung über die Dialoge atomar: Steuerwahl, Beleg, Verknüpfung — oder nichts ──
for (const weg of ['fern', 'lokal'] as const) {
  const db = freshDb();
  const c = await reparatur({ chargeToCustomer: 45, taxScheme: 'VAT_10' });
  schalten(c, 'in_progress', 'ready');
  const ledgerVorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  // Die Steuerwahl wird zuerst an der Reparatur gespeichert, dann der Beleg, dann die Verknüpfung —
  // und genau die scheitert.
  db.run(`CREATE TRIGGER r5c_fail_one BEFORE UPDATE OF invoice_id ON repairs
    WHEN NEW.id = '${c}' AND NEW.invoice_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'r5c injected'); END;`);
  const wahl = { taxScheme: 'ZERO', specialMark: true } as const;
  let warf = false;
  try {
    if (weg === 'fern') {
      await life.runCreateRepairInvoice(deps(db), identity('610', 'repairs.create_invoice'), { repairId: c, expectedRevision: rev(db, c), ...wahl });
    } else {
      await house.invoiceRepairsOnPrimary([c], wahl);
    }
  } catch { warf = true; }
  ok(warf, `ATOMIC-DLG (${weg}) der Fehler bei der Verknuepfung bricht die Einzelrechnung ab`);
  ok(n(db, 'SELECT COUNT(*) FROM invoices') === 0 && n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerVorher
    && s(db, 'SELECT invoice_id FROM repairs WHERE id = ?', [c]) === '', `ATOMIC-DLG (${weg}) kein Beleg, keine Buchung, keine Verknuepfung`);
  ok(s(db, 'SELECT tax_scheme FROM repairs WHERE id = ?', [c]) === 'VAT_10',
    `ATOMIC-DLG (${weg}) …und die gespeicherte Steuerwahl des Dialogs ist zurueckgenommen`);
  db.run('DROP TRIGGER r5c_fail_one');
}

// ══ R5C FINAL — die Verträge des Primary, festgenagelt ═════════════════════
// Vermerk: je Handlung genau der des Hauses vor R5C — Detailseite (Dialog) „Repair Service · Nr ·
// Problem", Liste (Auswahl UND Kürzel, ohne Dialog) „Combined Repair Service · Nr, …".
{
  const bilder: Array<{ dlg: ReturnType<typeof rechnungsBild>; quick: ReturnType<typeof rechnungsBild>; tax: string }> = [];
  for (const weg of ['lokal', 'fern'] as const) {
    const db = freshDb();
    const d1 = await reparatur({ chargeToCustomer: 45, taxScheme: 'VAT_10', issueDescription: 'Glas' });
    const q1 = await reparatur({ chargeToCustomer: 35, issueDescription: 'Band' });
    schalten(d1, 'in_progress', 'ready');
    schalten(q1, 'in_progress', 'ready');
    let dlg = ''; let quick = '';
    if (weg === 'lokal') {
      dlg = (await house.invoiceRepairsOnPrimary([d1], { taxScheme: 'ZERO', specialMark: true })).invoiceId;
      quick = (await house.invoiceRepairsOnPrimary([q1])).invoiceId;
    } else {
      const rs = useRepairStore.getState();
      const o1 = await life.runCreateRepairInvoice(deps(db), identity('700', 'repairs.create_invoice'),
        rules.repairInvoiceBody([rs.getRepair(d1)!], { taxScheme: 'ZERO', specialMark: true }));
      const o2 = await life.runCreateRepairInvoice(deps(db), identity('701', 'repairs.create_invoice'),
        rules.repairInvoiceBody([rs.getRepair(q1)!]));
      dlg = String(val<Record<string, unknown>>(o1).invoiceId);
      quick = String(val<Record<string, unknown>>(o2).invoiceId);
    }
    ok(/^Repair Service · REP-[\d-]+ · Glas$/.test(s(db, 'SELECT notes FROM invoices WHERE id = ?', [dlg])),
      `NOTES (${weg}) Detailseite: der Vermerk der Detailseite`);
    ok(/^Combined Repair Service · REP-[\d-]+$/.test(s(db, 'SELECT notes FROM invoices WHERE id = ?', [quick])),
      `NOTES (${weg}) Kuerzel der Liste: der Sammelvermerk der Liste, auch bei EINER Reparatur`);
    bilder.push({ dlg: rechnungsBild(db, dlg), quick: rechnungsBild(db, quick), tax: s(db, 'SELECT tax_scheme FROM repairs WHERE id = ?', [d1]) });
  }
  ok(unterschiede(bilder[0].dlg.kopf, bilder[1].dlg.kopf).length === 0 && bilder[0].dlg.zeilen === bilder[1].dlg.zeilen,
    'NOTES Einzelrechnung ueber die Dialoge: lokal == fern (Kopf, Vermerk, Nummernart, Zeilen)');
  ok(unterschiede(bilder[0].quick.kopf, bilder[1].quick.kopf).length === 0 && bilder[0].quick.zeilen === bilder[1].quick.zeilen,
    'NOTES Kuerzel der Liste: lokal == fern');
  ok(bilder[0].tax === 'ZERO' && bilder[1].tax === 'ZERO', 'NOTES …und die Steuerwahl steht auf beiden Wegen an der Reparatur');
  {
    const db = freshDb();
    const a = await reparatur({}); const b = await reparatur({});
    schalten(a, 'in_progress', 'ready'); schalten(b, 'in_progress', 'ready');
    for (const [was, ids, opts, erwartet] of [
      ['ein Dialog ueber zwei Reparaturen', [a, b], { taxScheme: 'ZERO' }, 'DIALOG_IS_SINGLE'],
      ['eine Nummernart ohne Steuerdialog', [a], { specialMark: true }, 'DIALOG_INCOMPLETE'],
    ] as const) {
      let c = '';
      try { await house.invoiceRepairsOnPrimary(ids, opts as never); } catch (e) { c = code(e) || String(e); }
      ok(c === erwartet, `NOTES am Primary: ${was} → ${erwartet} (${c})`);
    }
    ok(n(db, 'SELECT COUNT(*) FROM invoices') === 0, 'NOTES …und es entstand kein Beleg');
  }
}

// Ausgeblendete Felder: was die Maske in ihrem Modus NICHT zeigt, schreibt der Klick nicht.
{
  const faelle: Array<[string, Record<string, unknown>]> = [
    ['Kundenreparatur mit Artikel und Los vom Umschalten', {
      repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Umschalten 1', productId: 'p2', lotId: 'lot-p2',
      repairType: 'internal', estimatedCost: 10, chargeToCustomer: 40,
    }],
    ['Arbeit im Haus mit einer Werkstatt vom Umschalten', {
      repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Umschalten 2', repairType: 'internal',
      workshopSupplierId: 'sup-1', estimatedCost: 25, chargeToCustomer: 60,
    }],
  ];
  let k = 720;
  for (const [was, form] of faelle) {
    const bild: Array<ReturnType<typeof bildDerReparatur> & { lager: string; zeilen: number }> = [];
    for (const weg of ['lokal', 'fern'] as const) {
      const db = freshDb();
      let id = '';
      if (weg === 'lokal') {
        id = (await house.createRepairOnPrimary(form as never)).id;
      } else {
        k += 1;
        const out = await cmd.runRepairCreate(deps(db), identity(String(k), 'repairs.create'), rules.repairCreateBody(form as never, []));
        id = val<{ repairId: string }>(out).repairId;
      }
      bild.push({ ...bildDerReparatur(db, id), lager: s(db, "SELECT stock_status FROM products WHERE id = 'p2'"), zeilen: n(db, 'SELECT COUNT(*) FROM repair_lines') });
    }
    const [l, f] = bild;
    ok(unterschiede(l.zeile, f.zeile).length === 0 && l.arbeit === f.arbeit, `HIDDEN ${was}: lokal == fern`);
    ok(f.zeile.product_id === null && f.zeile.lot_id === null && f.zeile.workshop_supplier_id === null
      && f.lager === 'in_stock' && f.zeilen === 0, `HIDDEN ${was}: nichts Verstecktes geschrieben, kein Artikel angefasst`);
  }
}

// Beträge: genau die vier Geldfelder — und kein Pauschalverbot für Zahlen.
{
  const db = freshDb();
  for (const f of ['estimatedCost', 'internalCost', 'chargeToCustomer'] as const) {
    let c = '';
    try {
      await house.createRepairOnPrimary({ repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'minus', repairType: 'external', [f]: -5 } as never);
    } catch (e) { c = code(e); }
    ok(c === 'INVALID_AMOUNT', `AMOUNT am Primary: ${f} < 0 beim Anlegen ist ein Nein (${c || 'DURCHGELASSEN'})`);
    let t = false;
    try { cmd.parseRepairCreate({ customerId: 'cust-1', issueDescription: 'x', [f]: -5 }); } catch { t = true; }
    ok(t, `AMOUNT fern: ${f} < 0 beim Anlegen ist ein Nein`);
  }
  ok(n(db, 'SELECT COUNT(*) FROM repairs') === 0, 'AMOUNT …und keine Reparatur ist entstanden');
  const r = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'plus', repairType: 'internal', estimatedCost: 10, chargeToCustomer: 30,
  } as never);
  for (const f of ['estimatedCost', 'actualCost', 'internalCost', 'chargeToCustomer'] as const) {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    const seen = rs.getRepair(r.id) as unknown as Record<string, unknown>;
    let c = '';
    try { await house.updateRepairOnPrimary(r.id, { ...seen, [f]: -1 } as never); } catch (e) { c = code(e); }
    ok(c === 'INVALID_AMOUNT', `AMOUNT am Primary: ${f} < 0 beim Speichern ist ein Nein (${c || 'DURCHGELASSEN'})`);
    let t = false;
    try { cmd.parseRepairUpdate({ id: r.id, expectedRevision: 1, [f]: -1 }); } catch { t = true; }
    ok(t, `AMOUNT fern: ${f} < 0 beim Speichern ist ein Nein`);
  }
  ok(n(db, 'SELECT charge_to_customer FROM repairs WHERE id = ?', [r.id]) === 30, 'AMOUNT …und die Zeile ist unveraendert');
  const nullen = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'null', repairType: 'internal', estimatedCost: 0, chargeToCustomer: 0,
  } as never);
  ok(!!nullen.id, 'AMOUNT 0 bleibt erlaubt („enter later" / kostenlose Reparatur)');
  const merkmal = await house.createRepairOnPrimary({
    repairScope: 'CUSTOMER', customerId: 'cust-1', issueDescription: 'Merkmal', itemAttributes: { case_diameter_mm: -1 },
  } as never);
  ok(!!merkmal.id, 'AMOUNT ein Zahlenmerkmal der Kategorie faellt nicht unter die Betragsregel');
}

// ══ R5C BILLABLE — verbindlich (12.09.2026): abrechenbar ist „fertig" ODER „abgeholt" ══════
// Alle übrigen Bedingungen bleiben: nicht schon fakturiert, keine eigene Ware, ein Preis, ein Kunde.
{
  const erlaubt = ['ready', 'READY', 'picked_up', 'DELIVERED'];
  const verboten = ['received', 'diagnosed', 'in_progress', 'sent_to_workshop', 'returned', 'cancelled',
    'RECEIVED', 'IN_PROGRESS', 'SENT_TO_WORKSHOP', 'CANCELLED'];
  ok(JSON.stringify([...rules.REPAIR_INVOICEABLE_STATUSES].sort()) === JSON.stringify([...erlaubt].sort()),
    'BILLABLE die EINE Liste: fertig oder abgeholt, in beiden Schreibweisen des Hauses');
  const basis = { repairNumber: 'REP-X', invoiceId: '', chargeToCustomer: 50, repairScope: 'CUSTOMER', customerId: 'cust-1' };
  for (const st of erlaubt) ok(rules.repairInvoiceBlocker({ ...basis, status: st }) === null, `BILLABLE ${st} → abrechenbar`);
  for (const st of verboten) {
    ok(rules.repairInvoiceBlocker({ ...basis, status: st })?.code === 'REPAIR_NOT_READY', `BILLABLE ${st} → nicht abrechenbar`);
  }
  for (const st of ['ready', 'picked_up']) {
    ok(rules.repairInvoiceBlocker({ ...basis, status: st, invoiceId: 'inv-1' })?.code === 'REPAIR_ALREADY_INVOICED',
      `BILLABLE ${st}, schon fakturiert → weiterhin verboten`);
    ok(rules.repairInvoiceBlocker({ ...basis, status: st, chargeToCustomer: 0 })?.code === 'REPAIR_HAS_NO_CHARGE'
      && rules.repairInvoiceBlocker({ ...basis, status: st, repairScope: 'OWN' })?.code === 'REPAIR_IS_OWN_STOCK',
      `BILLABLE ${st}: die uebrigen Bedingungen gelten weiter (Preis, eigene Ware)`);
  }

  // Derselbe Vertrag an beiden Anschlüssen: Primary (Liste, Kürzel, Detailseite) und Fernbefehl.
  let k = 800;
  for (const [st, erwartet] of [['ready', 'ok'], ['picked_up', 'ok'], ['received', 'REPAIR_NOT_READY'],
    ['in_progress', 'REPAIR_NOT_READY'], ['returned', 'REPAIR_NOT_READY']] as const) {
    const ergebnis: string[] = [];
    for (const weg of ['lokal', 'fern'] as const) {
      const db = freshDb();
      const id = await reparatur({ chargeToCustomer: 50 });
      db.run('UPDATE repairs SET status = ? WHERE id = ?', [st, id]);
      useRepairStore.getState().loadRepairs();
      let aus = '';
      if (weg === 'lokal') {
        try { await house.invoiceRepairsOnPrimary([id]); aus = 'ok'; } catch (e) { aus = code(e) || String(e); }
      } else {
        k += 1;
        const out = await life.runCreateRepairInvoice(deps(db), identity(String(k), 'repairs.create_invoice'), { repairId: id, expectedRevision: rev(db, id) });
        aus = out.kind === 'ok' ? 'ok' : code(out);
      }
      ergebnis.push(`${aus}/${n(db, 'SELECT COUNT(*) FROM invoices')}`);
      if (aus === 'ok') {
        k += 1;
        const zweiter = await life.runCreateRepairInvoice(deps(db), identity(String(k), 'repairs.create_invoice'), { repairId: id, expectedRevision: rev(db, id) });
        let lokalZweiter = '';
        try { await house.invoiceRepairsOnPrimary([id]); lokalZweiter = 'ok'; } catch (e) { lokalZweiter = code(e); }
        ok(zweiter.kind === 'rejected' && code(zweiter) === 'REPAIR_ALREADY_INVOICED' && lokalZweiter === 'REPAIR_ALREADY_INVOICED'
          && n(db, 'SELECT COUNT(*) FROM invoices') === 1, `BILLABLE (${weg}) ${st}: danach bereits fakturiert — keine zweite Rechnung`);
      }
    }
    ok(ergebnis[0] === ergebnis[1] && ergebnis[0] === (erwartet === 'ok' ? 'ok/1' : `${erwartet}/0`),
      `BILLABLE ${st}: Primary == Fernbefehl (${ergebnis.join(' | ')})`);
  }

  // Keine zweite Statusliste: jede Stelle, die „abrechenbar" entscheidet, fragt die eine Regel.
  const list = codeOf(src('src/pages/repairs/RepairList.tsx'));
  const detail = codeOf(src('src/pages/repairs/RepairDetail.tsx'));
  ok(/const isEligibleForBulk = \(r: Repair\) => canInvoiceRepair\(r\);/.test(list), 'BILLABLE die Auswahl der Liste fragt die Regel');
  ok(/const showInvoiceShortcut = canInvoiceRepair\(rep\);/.test(list), 'BILLABLE …das Kuerzel je Zeile auch');
  ok(/\{canInvoiceRepair\(repair\) && customer && perm\.canCreateInvoices && \(/.test(detail), 'BILLABLE …und der Knopf der Detailseite');
  ok(/const nein = repairInvoiceBlocker\(r\);/.test(codeOf(src('src/stores/repairStore.ts'))), 'BILLABLE …und die Hausfunktion (Primary)');
  ok(/const nein = repairInvoiceBlocker\(\{/.test(codeOf(src('src/core/bridge/lifecycle-commands.ts'))), 'BILLABLE …und der Fernbefehl');
  for (const f of ['src/pages/repairs/RepairList.tsx', 'src/pages/repairs/RepairDetail.tsx', 'src/stores/repairStore.ts',
    'src/core/bridge/lifecycle-commands.ts', 'src/core/repairs/repair-house.ts']) {
    const t = codeOf(src(f));
    ok(!/REPAIR_INVOICEABLE_STATUSES|is not READY|\(r\.status === 'ready'|status === 'ready' \|\| \w+\.status === 'picked_up'\) &&\s*!\w+\.invoiceId/.test(t),
      `BILLABLE ${f.split('/').pop()}: keine eigene Statusliste fuer „abrechenbar"`);
  }
}

// ── §5 Eine Domäne: die Masken benutzen die Regeln, nicht eine Kopie ─────
{
  const list = codeOf(src('src/pages/repairs/RepairList.tsx'));
  const detail = codeOf(src('src/pages/repairs/RepairDetail.tsx'));
  ok(/missingRepairItemFields\(form\)/.test(list) && !/for \(const f of activeFields\)/.test(list),
    'DOMAIN die Pflichtfelder prueft die Maske ueber die geteilte Regel — keine zweite Schleife');
  ok(/isRepairableOwnProduct\(p\)/.test(list), 'DOMAIN die Artikelauswahl der eigenen Ware ist die Regel des Fernbefehls');
  ok(/const isEligibleForBulk = \(r: Repair\) => canInvoiceRepair\(r\);/.test(list)
    && /const showInvoiceShortcut = canInvoiceRepair\(rep\);/.test(list) && /canInvoiceRepair\(repair\)/.test(detail),
    'DOMAIN Auswahl, Kuerzel und Detailknopf: EINE Regel „abrechenbar"');
  ok(/REPAIR_TYPES\.map\(/.test(list) && /REPAIR_TYPES\.map\(/.test(detail) && /REPAIR_TAX_SCHEMES\.map\(/.test(list)
    && /REPAIR_TAX_SCHEMES\.map\(/.test(detail) && /REPAIR_WORK_TYPES\.map\(/.test(detail),
    'DOMAIN Reparaturart, Steuer und Arbeitsart kommen aus den Listen des Hauses');
  ok(/maxImages=\{REPAIR_MAX_PHOTOS\}/.test(list) && /maxImages=\{REPAIR_MAX_PHOTOS\}/.test(detail),
    'DOMAIN die Fotogrenze ist dieselbe Zahl, die der Fernbefehl prueft');
  const types = src('src/core/models/types.ts');
  for (const name of ['REPAIR_TYPES', 'REPAIR_TAX_SCHEMES', 'REPAIR_CUSTOMER_PAID_FROM', 'REPAIR_INTERNAL_PAID_FROM']) {
    ok(new RegExp(`export const ${name} = \\[`).test(types), `DOMAIN ${name} ist ein WERT des Hauses`);
  }
  ok(/customerPaidFrom\?: typeof REPAIR_CUSTOMER_PAID_FROM\[number\] \| null;/.test(types)
    && /repairType: typeof REPAIR_TYPES\[number\];/.test(types), 'DOMAIN …und die Typen folgen aus den Werten');
  const svc = codeOf(src('src/core/bridge/service-commands.ts'));
  ok(/REPAIR_CUSTOMER_PAID_FROM/.test(svc) && /REPAIR_INTERNAL_PAID_FROM/.test(svc) && /CARD_BRANDS/.test(svc),
    'DOMAIN der Fernbefehl prueft gegen dieselben Listen wie die Knoepfe der Maske');
  const st = codeOf(src('src/stores/repairStore.ts'));
  ok(/const VALID: readonly string\[\] = REPAIR_CUSTOMER_PAID_FROM;/.test(st), 'DOMAIN …und die Buchung der Kundenzahlung auch');

  // Kein lokaler Schreibweg außerhalb des Primary-Anschlusses.
  for (const [datei, t] of [['RepairList', list], ['RepairDetail', detail]] as const) {
    for (const f of ['createRepairOnPrimary', 'updateRepairOnPrimary', 'invoiceRepairsOnPrimary']) {
      const alle = (t.match(new RegExp(`\\b${f}\\(`, 'g')) || []).length;
      const imAnschluss = (t.match(new RegExp(`local: \\(\\) => ${f}\\(`, 'g')) || []).length;
      ok(alle === imAnschluss, `TRIPWIRE ${datei}: ${f}() steht nur im Primary-Anschluss (${imAnschluss}/${alle})`);
    }
  }
  ok(/remote: \(\) => repairCreateBody\(form, fotos\)/.test(list) && /remote: \(\) => repairInvoiceBody\(auswahl\)/.test(list)
    && /remote: \(\) => repairEditBody\(id, fassung, repair, form, photos\)/.test(detail),
    'TRIPWIRE am zweiten Rechner reist der Rumpf der geteilten Regeln — nichts Eigenes');
  const house2 = codeOf(src('src/core/repairs/repair-house.ts'));
  ok((house2.match(/return amPrimary\(/g) || []).length === 3, 'TRIPWIRE alle drei Handlungen laufen durch EINE Klammer');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r5c: repair create/update/invoice parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R5C_REPAIR_SCOPE_FROZEN');
console.log('CENTRAL_UI_R5C_REPAIR_CREATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5C_REPAIR_UPDATE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5C_REPAIR_INVOICE_SEMANTICS_AUDITED');
console.log('CENTRAL_UI_R5C_SHARED_REPAIR_DOMAIN_PROVED');
console.log('CENTRAL_UI_R5C_REPAIR_ATOMICITY_PROVED');
console.log('CENTRAL_UI_R5C_REPAIR_INPUT_AUTHORITY_PROVED');
console.log('CENTRAL_UI_R5C_INVOICE_DESCRIPTION_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5C_AMOUNT_SIGN_CONTRACT_PINNED');
console.log('CENTRAL_UI_R5C_BILLABLE_CONTRACT_PINNED');

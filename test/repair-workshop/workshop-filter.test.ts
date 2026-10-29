// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKSHOP-FILTER — „Is Workshop" am Lieferanten, Repair → Workshop zeigt nur markierte Werkstätten.
// Run: node test/repair-workshop/workshop-filter.test.ts
//
// Echte Hausfunktionen (Stores, Fernbefehle, Leseauskünfte), echtes Schema aus den Migrationen. Bewiesen:
//   §1 Migration: neue Spalte, idempotent, bestehende Lieferanten bleiben 0 und sonst unverändert
//   §2 Regel: nur true/false, sonst dasselbe Nein am Primary und aus der Ferne
//   §3 Primary: Anlegen/Ändern schreibt die Markierung, Sync-Zeile und Protokoll tragen sie
//   §4 PC2: suppliers.create / suppliers.update tragen sie; Wiederholung, Rechenfelder, Fremdfelder
//   §5 Markieren ändert KEINEN Einkauf, keine Zahlung, keine Buchung, kein Guthaben
//   §6 Auswahlregel: nur aktiv+markiert; gespeicherter Wert bleibt (benannt); Material = alle aktiven
//   §7 Vorschläge: nur aus Werkstatt/Arbeitszeile (nicht Material, nicht storniert), nie automatisch markiert
//   §8 Telefon: suppliers.list mit workshop:true liefert nur wählbare Werkstätten
//   §9 Primary == PC2 (store.suppliers.get)
//   §10 Historische Reparaturen behalten ihre Werkstatt
//   §11 Berechtigungen: kein neues Recht, kein neuer Befehl
//   §12 Masken (Rechner + Telefon) benutzen die eine Regel; Material bleibt offen
//   §13 Sync-Vertrag
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { supplierBalance } = await import('../../src/core/ledger/queries.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const md = await import('../../src/core/bridge/masterdata-commands.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/store-read-commands.ts');
const rules = await import('../../src/core/masterdata/masterdata-rules.ts');
const choice = await import('../../src/core/repairs/repair-workshop-choice.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const { useSupplierStore, loadSuppliersFor, repairWorkshopUsesFor } = await import('../../src/stores/supplierStore.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useRepairStore } = await import('../../src/stores/repairStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-10-28T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const all = (db: Db, sql: string, p: unknown[] = []): string => JSON.stringify(db.exec(sql, p)[0]?.values ?? []);

const MIGRATION = 'ALTER TABLE suppliers ADD COLUMN is_workshop INTEGER NOT NULL DEFAULT 0';
function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function baseDb(withWorkshopColumn: boolean): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) {
    if (!withWorkshopColumn && stmt === MIGRATION) continue;
    try { db.run(stmt); } catch { /* schon da */ }
  }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(SKU_SEQUENCES_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('c1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery, purchase_price,
      purchase_currency, planned_sale_price, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p-buy','branch-main','cat-w','Rolex','M p-buy','SKU-p-buy',0,'Pre-Owned','[]',0,'BHD',500,'in_stock','ZERO',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  return db;
}
function reload(): void {
  useSupplierStore.getState().loadSuppliers();
  usePurchaseStore.getState().loadPurchases();
  useProductStore.getState().loadProducts();
  useRepairStore.getState().loadRepairs();
  useRepairStore.getState().loadRepairLines();
}
function imHaus<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const out = fn(); posting.commitLedgerTransaction(); return out; }
  catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
const supplier = (db: Db, id: string, name: string, extra: Record<string, unknown> = {}): void => {
  const cols = ['id', 'branch_id', 'name', 'active', 'created_at', 'updated_at', ...Object.keys(extra)];
  db.run(`INSERT INTO suppliers (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, [id, 'branch-main', name, 1, NOW, NOW, ...Object.values(extra)]);
};
const repair = (db: Db, id: string, workshop: string | null): void => {
  db.run(`INSERT INTO repairs (id, branch_id, repair_number, customer_id, issue_description, repair_type, status, received_at, workshop_supplier_id, created_at, updated_at)
    VALUES (?, 'branch-main', ?, 'c1', 'Glas', 'external', 'received', ?, ?, ?, ?)`, [id, 'REP-' + id, NOW, workshop, NOW, NOW]);
};
const line = (db: Db, id: string, rep: string, pos: number, sup: string | null, kind: string | null, status = 'OPEN'): void => {
  db.run(`INSERT INTO repair_lines (id, branch_id, repair_id, position, supplier_id, cost_amount, status, material_kind, created_at, updated_at)
    VALUES (?, 'branch-main', ?, ?, ?, 10, ?, ?, ?, ?)`, [id, rep, pos, sup, status, kind, NOW, NOW]);
};
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'ADMIN' };
const identity = (x: string, op: string, hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
const deps = (db: Db) => ({
  db: db as never,
  begin: () => { setTestDatabase(db as never); posting.beginLedgerTransaction(); },
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
type Outcome = { kind: string; code?: string; replayed?: boolean; value?: Record<string, unknown> };
async function fern(p: () => Promise<unknown>): Promise<Outcome & { thrown?: string }> {
  try { return await p() as Outcome; } catch (e) { return { kind: 'thrown', thrown: `${String((e as { code?: string }).code ?? '')} ${(e as Error).message}` }; }
}
const wirft = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message); } };
const lesen = async (op: string, input: Record<string, unknown> = {}) =>
  registry.executeCommand(op, { actor: { branchId: 'branch-main', tenantId: 'tenant-1', userId: 'user-pc2', role: 'ADMIN' }, input }) as Promise<{ kind: string; value?: Record<string, unknown> }>;
const ws = (db: Db, id: string): number => n(db, 'SELECT is_workshop FROM suppliers WHERE id = ?', [id]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 Migration auf einer bestehenden Datenbank
{
  const db = baseDb(false);
  supplier(db, 's-alt1', 'Alt Goldsmith', { phone: '+973 1', notes: 'old' });
  supplier(db, 's-alt2', 'Alt Parts');
  const spalten = () => (db.exec('PRAGMA table_info(suppliers)')[0]?.values ?? []).map((v) => String(v[1]));
  ok(!spalten().includes('is_workshop'), '§1 vor der Migration: keine Spalte');
  const vorher = all(db, 'SELECT id, name, phone, notes, active, revision, updated_at FROM suppliers ORDER BY id');
  ok(MIGRATIONS.filter((m) => m === MIGRATION).length === 1, '§1 die Migration steht genau einmal in der Liste');
  db.run(MIGRATION);
  const zweites = wirft(() => db.run(MIGRATION));
  ok(/duplicate column/i.test(zweites), `§1 ein zweiter Lauf scheitert nur an „duplicate column" — runMigrations schluckt genau das (${zweites})`);
  ok(/if \(!\/duplicate column\/i\.test\(msg\)\)/.test(src('src/core/db/database.ts')), '§1 …und runMigrations schluckt es wirklich');
  ok(spalten().includes('is_workshop'), '§1 danach: Spalte da');
  ok(all(db, 'SELECT id, is_workshop FROM suppliers ORDER BY id') === S([['s-alt1', 0], ['s-alt2', 0]]),
    '§1 bestehende Lieferanten bleiben 0 — nichts wird umklassifiziert');
  ok(all(db, 'SELECT id, name, phone, notes, active, revision, updated_at FROM suppliers ORDER BY id') === vorher,
    '§1 …und sonst bitgleich (keine Fassung, kein Zeitstempel geändert)');
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('s-ohne','branch-main','Ohne',1,?,?)", [NOW, NOW]);
  ok(ws(db, 's-ohne') === 0, '§1 ein Einfügen ohne die Spalte (alte Wege) ergibt 0');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
const db = baseDb(true);
reload();

// §2 Regel
{
  ok(rules.SUPPLIER_CREATE_FIELDS.includes('isWorkshop' as never) && rules.SUPPLIER_UPDATE_FIELDS.includes('isWorkshop' as never),
    '§2 isWorkshop steht in den Feldlisten (Anlegen + Ändern)');
  ok(rules.supplierCreateInput({ name: 'A', isWorkshop: true }).isWorkshop === true, '§2 Anlegen: true');
  ok(rules.supplierCreateInput({ name: 'A' }).isWorkshop === undefined, '§2 Anlegen ohne Angabe: nicht gesetzt (= nein)');
  ok(rules.supplierUpdateInput({ isWorkshop: false }).isWorkshop === false, '§2 Ändern: false ist eine Aussage');
  ok(wirft(() => rules.supplierCreateInput({ name: 'A', isWorkshop: 'yes' })) === 'MASTERDATA_FIELD_INVALID'
    && wirft(() => rules.supplierUpdateInput({ isWorkshop: 1 })) === 'MASTERDATA_FIELD_INVALID',
    '§2 kein true/false → MASTERDATA_FIELD_INVALID');
}

// §3 Primary
let sW = '', sP = '';
{
  sW = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Goldsmith Ali', isWorkshop: true })).id;
  sP = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Parts Trader' })).id;
  ok(ws(db, sW) === 1 && ws(db, sP) === 0, '§3 Anlegen am Primary: markiert / nicht markiert');
  ok(useSupplierStore.getState().getSupplier(sW)?.isWorkshop === true && useSupplierStore.getState().getSupplier(sP)?.isWorkshop === false,
    '§3 der Store liest die Markierung');
  const fassung = n(db, 'SELECT revision FROM suppliers WHERE id = ?', [sP]);
  imHaus(() => useSupplierStore.getState().updateSupplier(sP, { isWorkshop: true }));
  ok(ws(db, sP) === 1 && n(db, 'SELECT revision FROM suppliers WHERE id = ?', [sP]) === fassung + 1, '§3 Ändern setzt sie, die Fassung steigt');
  const sync = String(one(db, "SELECT data FROM sync_changelog WHERE table_name = 'suppliers' AND record_id = ? ORDER BY id DESC LIMIT 1", [sP]) ?? '');
  ok(/"is_workshop":1/.test(sync), `§3 die Sync-Zeile trägt die ganze Zeile mit is_workshop (${sync.slice(0, 80)}…)`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'suppliers' AND entity_id = ? AND field_name = 'isWorkshop'", [sP]) === 1,
    '§3 das Protokoll nennt die Änderung (Supplier History)');
  imHaus(() => useSupplierStore.getState().updateSupplier(sP, { isWorkshop: false }));
  ok(ws(db, sP) === 0, '§3 …und nimmt sie wieder zurück');
}

// §4 PC2 (Fernbefehle)
let sR = '';
{
  const a = await fern(() => md.runSupplierCreate(deps(db), identity('1', 'suppliers.create'), { name: 'Remote Workshop', isWorkshop: true }));
  sR = String(a.value?.supplierId ?? '');
  ok(a.kind === 'ok' && ws(db, sR) === 1, `§4 suppliers.create mit isWorkshop:true (${S(a).slice(0, 100)})`);
  const b = await fern(() => md.runSupplierCreate(deps(db), identity('1', 'suppliers.create'), { name: 'Remote Workshop', isWorkshop: true }));
  ok(b.replayed === true && n(db, "SELECT COUNT(*) FROM suppliers WHERE name = 'Remote Workshop'") === 1, '§4 Wiederholung: Replay, kein zweiter Lieferant');
  const c = await fern(() => md.runSupplierUpdate(deps(db), identity('2', 'suppliers.update'), { id: sR, isWorkshop: false }));
  ok(c.kind === 'ok' && ws(db, sR) === 0, '§4 suppliers.update isWorkshop:false');
  const d = await fern(() => md.runSupplierUpdate(deps(db), identity('3', 'suppliers.update'), { id: sR, isWorkshop: 'ja' }));
  ok((d.kind === 'thrown' || d.kind === 'rejected') && /MASTERDATA_FIELD_INVALID/.test(String(d.thrown ?? d.code)) && ws(db, sR) === 0,
    `§4 kein true/false → dasselbe Nein wie am Primary (${String(d.thrown ?? d.code)})`);
  const e = await fern(() => md.runSupplierUpdate(deps(db), identity('4', 'suppliers.update'), { id: sR, repairWorkshopUses: 5 }));
  ok(e.kind === 'thrown' && /primary decides repairWorkshopUses/.test(String(e.thrown)), `§4 die Vorschlagszahl rechnet das Haus — kein Rumpf setzt sie (${e.thrown})`);
  const f = await fern(() => md.runSupplierCreate(deps(db), identity('5', 'suppliers.create'), { name: 'X', is_workshop: 1 }));
  ok(f.kind === 'thrown' && /unknown field: is_workshop/.test(String(f.thrown)), '§4 die Spalte selbst ist kein Feld des Auftrags');
  await fern(() => md.runSupplierUpdate(deps(db), identity('6', 'suppliers.update'), { id: sR, isWorkshop: true }));
  ok(ws(db, sR) === 1, '§4 wieder markiert');
  reload();
}

// §5 Markieren ändert keine Bücher
{
  const pid = imHaus(() => usePurchaseStore.getState().createPurchase({
    supplierId: sP, lines: [{ productId: 'p-buy', quantity: 1, unitPrice: 300, taxScheme: 'ZERO' as const, vatRate: 0 }],
  }).id);
  usePurchaseStore.getState().addPayment(pid, 120, 'cash');
  imHaus(() => useSupplierStore.getState().grantStandaloneCredit(sP, 15, 'cash', 'Vorauszahlung'));
  const buecher = (): string => S([
    all(db, 'SELECT * FROM purchases ORDER BY id'), all(db, 'SELECT * FROM purchase_lines ORDER BY id'),
    all(db, 'SELECT * FROM purchase_payments ORDER BY id'), all(db, 'SELECT * FROM ledger_entries ORDER BY id'),
    all(db, 'SELECT * FROM supplier_credits ORDER BY id'), all(db, 'SELECT * FROM expenses ORDER BY id'),
    all(db, 'SELECT * FROM stock_lots ORDER BY id'), all(db, 'SELECT * FROM products ORDER BY id'),
  ]);
  const saldo = supplierBalance(sP, 'branch-main');
  const vorher = buecher();
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries WHERE counterparty_id = ?', [sP]) > 0 && saldo > 0, `§5 es gibt Einkauf, Zahlung und Buchungen (Saldo ${saldo})`);
  imHaus(() => useSupplierStore.getState().updateSupplier(sP, { isWorkshop: true }));
  await fern(() => md.runSupplierUpdate(deps(db), identity('7', 'suppliers.update'), { id: sP, isWorkshop: false }));
  await fern(() => md.runSupplierUpdate(deps(db), identity('8', 'suppliers.update'), { id: sP, isWorkshop: true }));
  ok(buecher() === vorher, '§5 Einkauf, Positionen, Zahlungen, Hauptbuch, Guthaben, Ausgaben, Lose und Artikel bitgleich');
  ok(supplierBalance(sP, 'branch-main') === saldo, '§5 der Saldo des Lieferanten bleibt');
  reload();
  const s = useSupplierStore.getState().getSupplier(sP)!;
  ok(s.isWorkshop === true && (s.totalPurchases ?? 0) === 300 && (s.totalPaid ?? 0) === 120, `§5 Kennzahlen unverändert (${s.totalPurchases}/${s.totalPaid})`);
  imHaus(() => useSupplierStore.getState().updateSupplier(sP, { isWorkshop: false }));
  reload();
}

// §6 Auswahlregel (rein)
{
  const L = [
    { id: 'a', name: 'Active Workshop', active: true, isWorkshop: true, phone: '1' },
    { id: 'b', name: 'Active Parts', active: true, isWorkshop: false },
    { id: 'c', name: 'Inactive Workshop', active: false, isWorkshop: true },
    { id: 'd', name: 'Old Unmarked', active: true },
  ];
  ok(S(choice.workshopOptions(L).map((o) => o.id)) === S(['a']), '§6 wählbar: nur aktiv UND markiert');
  ok(choice.workshopOptions(L)[0].subtitle === '1', '§6 Telefon als Untertitel (wie bisher)');
  const behalten = choice.workshopOptions(L, ['b', undefined, 'c', 'a', 'zz', 'b']);
  ok(S(behalten.map((o) => [o.id, o.label])) === S([['b', 'Active Parts (not marked as workshop)'], ['c', 'Inactive Workshop (inactive)'], ['a', 'Active Workshop']]),
    `§6 gespeicherte Werte bleiben vorne, benannt; unbekannt/doppelt/leer bleibt weg (${S(behalten.map((o) => o.label))})`);
  ok(S(choice.materialSupplierOptions(L).map((o) => o.id)) === S(['a', 'b', 'd']), '§6 Material: ALLE aktiven, markiert oder nicht');
  ok(choice.hasSelectableWorkshop(L) && !choice.hasSelectableWorkshop(L.filter((s) => s.id !== 'a')), '§6 Hinweis nur, wenn keine wählbare Werkstatt');
  ok(choice.SELECTABLE_WORKSHOP_SQL === 'active = 1 AND is_workshop = 1', '§6 dieselbe Bedingung in SQL');
}

// §7 Vorschläge aus alten Reparaturen
let rAlt = '';
{
  const sAlt = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Former Watchmaker' })).id;
  const sLine = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Line Goldsmith' })).id;
  const sMat = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Strap Dealer' })).id;
  const sStorno = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Cancelled Only' })).id;
  const sStill = imHaus(() => useSupplierStore.getState().createSupplier({ name: 'Quiet Workshop' })).id;
  rAlt = 'r-alt';
  repair(db, 'r-alt', sAlt); repair(db, 'r-2', sAlt); repair(db, 'r-3', null); repair(db, 'r-4', sStill);
  line(db, 'l1', 'r-3', 1, sLine, null); line(db, 'l2', 'r-3', 2, sLine, 'labor'); line(db, 'l3', 'r-alt', 1, sLine, null);
  line(db, 'l4', 'r-3', 3, sMat, 'stone'); line(db, 'l5', 'r-alt', 2, sMat, 'custom');
  line(db, 'l6', 'r-3', 4, sStorno, null, 'CANCELLED');
  line(db, 'l7', 'r-alt', 3, sAlt, null);
  imHaus(() => useSupplierStore.getState().updateSupplier(sStill, { active: false }));
  const uses = repairWorkshopUsesFor('branch-main');
  ok(uses.get(sAlt) === 2 && uses.get(sLine) === 2 && !uses.has(sMat) && !uses.has(sStorno),
    `§7 gezählt je Reparatur: Werkstatt + Arbeitszeilen; Material und Storno nicht (${S([uses.get(sAlt), uses.get(sLine), uses.get(sMat), uses.get(sStorno)])})`);
  const vorMarkierung = all(db, 'SELECT id, is_workshop FROM suppliers ORDER BY id');
  reload();
  const vs = choice.workshopSuggestions(useSupplierStore.getState().suppliers);
  ok(S(vs.map((v) => [v.name, v.uses])) === S([['Former Watchmaker', 2], ['Line Goldsmith', 2]]),
    `§7 Vorschläge: aktive, nicht markierte mit Werkstatt-Einsatz, häufigste zuerst (${S(vs)})`);
  ok(all(db, 'SELECT id, is_workshop FROM suppliers ORDER BY id') === vorMarkierung, '§7 Laden und Vorschlagen markiert NIEMANDEN');
  imHaus(() => useSupplierStore.getState().updateSupplier(sLine, { isWorkshop: true }));
  reload();
  ok(S(choice.workshopSuggestions(useSupplierStore.getState().suppliers).map((v) => v.name)) === S(['Former Watchmaker']),
    '§7 nach dem ausdrücklichen Markieren verschwindet der Vorschlag');
}

// §8 Telefon: suppliers.list
{
  const alle = await lesen('suppliers.list', { limit: 500 });
  const werk = await lesen('suppliers.list', { limit: 500, workshop: true });
  const items = (r: typeof alle) => ((r.value?.items ?? []) as Array<{ name: string; active: boolean; isWorkshop: boolean }>);
  ok(alle.kind === 'ok' && items(alle).length === n(db, 'SELECT COUNT(*) FROM suppliers') && items(alle).every((i) => typeof i.isWorkshop === 'boolean'),
    `§8 ohne Schalter: die ganze Liste wie bisher, jetzt mit isWorkshop (${items(alle).length})`);
  const soll = all(db, "SELECT name FROM suppliers WHERE branch_id = 'branch-main' AND active = 1 AND is_workshop = 1 ORDER BY name");
  ok(werk.kind === 'ok' && S(items(werk).map((i) => [i.name])) === soll && items(werk).every((i) => i.active && i.isWorkshop),
    `§8 workshop:true: nur aktive, markierte (${items(werk).map((i) => i.name).join(', ')})`);
  const suche = await lesen('suppliers.list', { q: 'gold', workshop: true });
  ok(S(items(suche).map((i) => i.name)) === S(['Goldsmith Ali', 'Line Goldsmith']), `§8 Suche + Schalter zusammen (${items(suche).map((i) => i.name).join(', ')})`);
}

// §9 Primary == PC2
{
  const fern9 = await lesen('store.suppliers.get', {});
  const pc2 = (((fern9.value?.data as { suppliers?: unknown[] } | undefined)?.suppliers ?? []) as Array<{ id: string; isWorkshop?: boolean; repairWorkshopUses?: number }>)
    .map((s) => [s.id, s.isWorkshop, s.repairWorkshopUses]);
  const primary = useSupplierStore.getState().suppliers.map((s) => [s.id, s.isWorkshop, s.repairWorkshopUses]);
  ok(fern9.kind === 'ok' && pc2.length > 0 && S(pc2) === S(primary), '§9 PC2 bekommt dieselben Markierungen und Vorschlagszahlen wie der Primary');
  ok(S(loadSuppliersFor({ branchId: 'branch-main' } as never).suppliers.map((s) => s.isWorkshop)) === S(primary.map((p) => p[1])),
    '§9 …aus derselben Ladefunktion');
}

// §10 Historische Reparaturen
{
  const sAlt = String(one(db, 'SELECT workshop_supplier_id FROM repairs WHERE id = ?', [rAlt]));
  imHaus(() => useSupplierStore.getState().updateSupplier(sAlt, { isWorkshop: true }));
  imHaus(() => useSupplierStore.getState().updateSupplier(sAlt, { isWorkshop: false }));
  reload();
  ok(one(db, 'SELECT workshop_supplier_id FROM repairs WHERE id = ?', [rAlt]) === sAlt
    && one(db, "SELECT supplier_id FROM repair_lines WHERE id = 'l7'") === sAlt, '§10 Markierung zurückgenommen: Reparatur und Arbeitszeile behalten ihre Werkstatt');
  const opts = choice.workshopOptions(useSupplierStore.getState().suppliers, [useRepairStore.getState().getRepair(rAlt)?.workshopSupplierId]);
  ok(opts[0]?.id === sAlt && /\(not marked as workshop\)/.test(opts[0].label), `§10 …und die Auswahl dieser Reparatur zeigt sie weiter, benannt (${opts[0]?.label})`);
  imHaus(() => useRepairStore.getState().updateRepair(rAlt, { notes: 'later note' }));
  ok(one(db, 'SELECT workshop_supplier_id FROM repairs WHERE id = ?', [rAlt]) === sAlt && one(db, 'SELECT notes FROM repairs WHERE id = ?', [rAlt]) === 'later note',
    '§10 ein späteres Ändern der Reparatur lässt die Werkstatt stehen');
  imHaus(() => useSupplierStore.getState().updateSupplier(sAlt, { active: false }));
  reload();
  const opts2 = choice.workshopOptions(useSupplierStore.getState().suppliers, [sAlt]);
  ok(opts2[0]?.id === sAlt && /\(inactive\)/.test(opts2[0].label) && !choice.workshopOptions(useSupplierStore.getState().suppliers).some((o) => o.id === sAlt),
    '§10 stillgelegt: nur noch dort sichtbar, wo er schon steht');
}

// §11 Berechtigungen
{
  ok(perms.permissionForOp('suppliers.update') === null && perms.permissionForOp('suppliers.create') === null,
    '§11 die Markierung reist mit suppliers.create/.update — dasselbe Tor wie jedes andere Lieferantenfeld (heute keins, wie am Primary)');
  ok(['ADMIN', 'MANAGER', 'SALES', 'VIEWER'].every((r) => perms.roleMayRunOp(r, 'suppliers.update') === perms.roleMayRunOp(r, 'suppliers.create')),
    '§11 Anlegen und Ändern für jede Rolle gleich');
  const reg = src('src/core/bridge/command-registry.ts') + src('src-tauri/src/bridge.rs');
  ok(!/workshop/i.test(reg.replace(/sent_to_workshop|SENT_TO_WORKSHOP/g, '')), '§11 kein neuer Befehl, kein neues Recht (Registry + Rust)');
  ok(src('src/core/bridge/read-commands.ts').includes("input(p).workshop === true"), '§11 die Leseauskunft bekommt nur einen Schalter, keine neue Operation');
}

// §12 Masken
{
  const list = src('src/pages/repairs/RepairList.tsx');
  const detail = src('src/pages/repairs/RepairDetail.tsx');
  ok(/workshopOptions\(suppliers, \[form\.workshopSupplierId\]\)/.test(list) && !/suppliers\.filter\(s => s\.active\)\.map/.test(list),
    '§12 Repair erstellen: nur Werkstätten, der gewählte Wert bleibt');
  ok(/useState\(true\)/.test(list) && /isWorkshop: quickSupplierWorkshop/.test(list) && /data-repair-quick-supplier-workshop/.test(list),
    '§12 „+ New Supplier" in der Werkstatt-Auswahl: Is Workshop vorbelegt, sichtbar, abwählbar');
  ok(/workshopOptions\(suppliers, \[form\.workshopSupplierId, repair\?\.workshopSupplierId\]\)/.test(detail), '§12 Werkstatt ändern: gespeicherter Wert bleibt');
  // REPAIR-REDESIGN — die Arbeitszeile wählt die Quelle (In-house | External workshop) und dann NUR Werkstätten.
  const teile = src('src/components/repairs/RepairWorkParts.tsx');
  ok(/workshopOptions\(suppliers, \[draft\.supplierId\]\)/.test(teile) && /source: 'inhouse', supplierId: ''/.test(teile)
    && /<RepairWorkLineForm[\s\S]{0,300}?suppliers=\{suppliers\}/.test(detail),
    '§12 Add Work Line: eigene Werkstatt + Werkstätten');
  ok(/goldWerkstattOptionen = useMemo\(\(\) => workshopOptions\(suppliers, \[newGoldForm\.supplierId\]\)/.test(detail) && /options=\{goldWerkstattOptionen\}/.test(detail),
    '§12 Gold vom Workshop: nur Werkstätten, kein In-house');
  ok(!/supplierOptions/.test(detail) && (detail.match(/data-repair-no-workshop-hint/g) || []).length === 2
    && (teile.match(/data-repair-no-workshop-hint/g) || []).length === 1, '§12 keine alte Liste mehr; Hinweis an allen drei Stellen');
  const mat = src('src/components/work-orders/AddMaterialModal.tsx');
  ok(!/isWorkshop|workshopOptions/.test(mat) && /<AddMaterialModal/.test(detail), '§12 Material (AddMaterialModal) bleibt bei allen aktiven Lieferanten');
  const sd = src('src/pages/suppliers/SupplierDetail.tsx'), sl = src('src/pages/suppliers/SupplierList.tsx');
  ok(/data-supplier-is-workshop/.test(sd) && /isWorkshop: e\.target\.checked/.test(sd), '§12 Edit Supplier: Checkbox „Is Workshop"');
  ok(/data-supplier-create-is-workshop/.test(sl) && /data-workshop-suggestion-mark/.test(sl) && /isWorkshop: true \}\)/.test(sl),
    '§12 New Supplier: Checkbox; Vorschläge markieren nur auf Klick');
  const ui = src('src-tauri/src/sync/mobile_repair_ui.js');
  ok(/read\('suppliers\.list', \{ limit: 500, workshop: true \}\)/.test(ui) && /rpFuelle\('rpLineSupplier', eigene\.concat\(werkstaetten\)/.test(ui)
    && /rpFuelle\('rpGoldSupplier', werkstaetten/.test(ui) && /rpFuelle\('rpMatSupplier', eigene\.concat\(material\)/.test(ui)
    && /filter\(\(s\) => s\.active !== false\)/.test(ui),
    '§12 Telefon: Arbeitszeile + Gold nur Werkstätten (Primary filtert), Material alle aktiven');
}

// §13 Sync-Vertrag
{
  const manifest = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { tables: Record<string, { allowed_fields: string[] }> };
  ok(manifest.tables.suppliers.allowed_fields.includes('is_workshop'), '§13 is_workshop reist mit der Lieferantenzeile (Manifest = Rust und TS)');
  ok(/include_str!\("\.\.\/\.\.\/\.\.\/src\/core\/sync\/sync-business-schema\.json"\)/.test(src('src-tauri/src/sync/sync_schema.rs')), '§13 Rust liest dasselbe Manifest');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — repair workshop filter: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('REPAIR_WORKSHOP_FILTER_PROVED');

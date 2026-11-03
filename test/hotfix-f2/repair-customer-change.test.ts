// ════════════════════════════════════════════════════════════════════════════
// HOTFIX F2 — Reparatur: falschen Kunden korrigieren (ADMIN/MANAGER, ohne Rechnung/Zahlung, mit Grund und Protokoll).
// Run: node test/hotfix-f2/repair-customer-change.test.ts
//   §A Primary: Kunde korrigiert, Nummer/Details/Bilder/Status/Buchungen bleiben, Protokoll alt/neu/Grund
//   §B PC2 (repairs.update mit Kunde + Grund) = Primary   §C Sperren: Rolle, Grund, Rechnung, Zahlung, Goldguthaben,
//      gleicher/fremder Kunde, veraltete Fassung, gemischter Rumpf — nichts geändert   §D Maske (Quelltext)
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
const { editBaselineRevision, shouldAdoptRecord } = await import('../../src/core/data/form-sync.ts');
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
/** MEDIA-REPAIR — die Galerie einer Reparatur: Medienkennungen in ihrer Reihenfolge. */
const galerie = (db: Db, id: string): string[] =>
  (db.exec("SELECT media_id FROM media_links WHERE entity_type = 'repair' AND entity_id = ? AND deleted_at IS NULL ORDER BY sort_order", [id])[0]?.values ?? [])
    .map((v) => String(v[0]));
/** Die Bytes hinter einem Medium — fuer den Beweis, dass genau DIESES Foto haengt. */
const medienHash = (db: Db, mediaId: string): string =>
  String(db.exec(`SELECT g.stored_blob_hash FROM media_objects o
     JOIN media_blobs b ON b.tenant_id = o.tenant_id AND b.blob_id = o.master_blob_id
     JOIN media_blob_generations g ON g.tenant_id = b.tenant_id AND g.blob_id = b.blob_id AND g.generation_no = b.current_generation_no
    WHERE o.media_id = ?`, [mediaId])[0]?.values?.[0]?.[0] ?? '');

const bildDerReparatur = (db: Db, id: string) => ({
  galerie: JSON.stringify(galerie(db, id).map((m) => medienHash(db, m))),
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


const { useAuthStore } = await import('../../src/stores/authStore.ts');
const rolle = (role: string): void => { useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role } as never }); };
const FORM = {
  repairScope: 'CUSTOMER', customerId: 'cust-1', itemCategoryId: 'cat-watch', itemBrand: 'Rolex', itemModel: 'Submariner',
  issueDescription: 'Krone klemmt', repairType: 'external', workshopSupplierId: 'sup-1', estimatedCost: 30, chargeToCustomer: 90,
  taxScheme: 'ZERO', notes: 'Kunde wartet', images: [alsDataUrl(bild(7))],
} as never;
/** Was am Datensatz bleiben muss (ohne Kunde, Fassung, Zeitstempel). */
const kern = (db: Db, id: string): string => S(Object.fromEntries(Object.entries(row(db, 'SELECT * FROM repairs WHERE id = ?', [id]))
  .filter(([k]) => !['customer_id', 'revision', 'updated_at', 'version', 'sync_status'].includes(k))));
const S = (v: unknown): string => JSON.stringify(v);
const kundeVon = (db: Db, id: string): string => s(db, 'SELECT customer_id FROM repairs WHERE id = ?', [id]);
const meldungA = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); } };

// ── §A Primary ───────────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb(); rolle('ADMIN');
  const r = await house.createRepairOnPrimary(FORM);
  const vorher = kern(db, r.id); const fotos = S(galerie(db, r.id)); const buch = buchungen(db); const rv = rev(db, r.id);
  const m = await meldungA(() => house.changeRepairCustomerOnPrimary(r.id, 'cust-2', 'auf den falschen Kunden gebucht', rv));
  reload();
  ok(m === '' && kundeVon(db, r.id) === 'cust-2', `§A Primary (ADMIN): Kunde cust-1 → cust-2 (${m})`);
  ok(kern(db, r.id) === vorher && S(galerie(db, r.id)) === fotos && buchungen(db) === buch,
    '§A Nummer, Details, Status, Bilder und Buchungen unverändert');
  ok(rev(db, r.id) === rv + 1, `§A eine neue Fassung (${rv} → ${rev(db, r.id)})`);
  const a = row(db, "SELECT old_value, new_value, changed_by FROM audit_log WHERE entity_type = 'repairs' AND entity_id = ? AND field_name = 'customer_id' ORDER BY changed_at DESC LIMIT 1", [r.id]);
  ok(String(a.old_value ?? '').includes('cust-1') && String(a.new_value ?? '').includes('cust-2') && String(a.new_value ?? '').includes('auf den falschen Kunden gebucht')
    && String(a.changed_by ?? '') === 'user-test', `§A Protokoll: alt, neu, Grund, wer (${S(a)})`);
  ok(useRepairStore.getState().getRepair(r.id)?.customerId === 'cust-2', '§A die Seite zeigt den neuen Kunden');
  // MANAGER darf ebenso.
  rolle('MANAGER');
  const m2 = await meldungA(() => house.changeRepairCustomerOnPrimary(r.id, 'cust-1', 'zurück zum richtigen', rev(db, r.id)));
  ok(m2 === '' && kundeVon(db, r.id) === 'cust-1', `§A MANAGER darf korrigieren (${m2})`);
}

// ── §B PC2 ───────────────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb(); rolle('ADMIN');
  const r = await house.createRepairOnPrimary(FORM);
  const vorher = kern(db, r.id);
  const out = await cmd.runRepairUpdate(deps(db), { ...identity('801', 'repairs.update'), role: 'MANAGER' } as never,
    { id: r.id, expectedRevision: rev(db, r.id), customerId: 'cust-2', customerChangeReason: 'falsch zugeordnet' });
  reload();
  ok((out as { kind: string }).kind === 'ok' && kundeVon(db, r.id) === 'cust-2' && kern(db, r.id) === vorher,
    `§B PC2 (repairs.update, MANAGER): Kunde korrigiert, sonst alles gleich (${S(out).slice(0, 140)})`);
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'repairs' AND entity_id = ? AND field_name = 'customer_id' AND new_value LIKE '%falsch zugeordnet%'", [r.id]) === 1,
    '§B Protokoll mit Grund auch über PC2');
  const gemischt = await cmd.runRepairUpdate(deps(db), identity('802', 'repairs.update'),
    { id: r.id, expectedRevision: rev(db, r.id), customerId: 'cust-1', customerChangeReason: 'x y z', notes: 'dazu' }).catch((e: unknown) => e);
  ok(/saved on its own/.test(String((gemischt as Error)?.message ?? S(gemischt))) && kundeVon(db, r.id) === 'cust-2',
    '§B Kunde + andere Felder in einem Rumpf: abgewiesen (eigener Speichervorgang)');
}

// ── §C Sperren ───────────────────────────────────────────────────────────────────────────────────
{
  const db = freshDb(); rolle('ADMIN');
  const r = await house.createRepairOnPrimary(FORM);
  const unveraendert = (): boolean => kundeVon(db, r.id) === 'cust-1';
  const versuch = async (rolleName: string, kunde: string, grund: string, fassung = rev(db, r.id)): Promise<string> => {
    rolle(rolleName); const m = await meldungA(() => house.changeRepairCustomerOnPrimary(r.id, kunde, grund, fassung)); rolle('ADMIN'); reload(); return m;
  };
  ok(await versuch('SALES', 'cust-2', 'falscher Kunde') === 'PERMISSION_DENIED' && unveraendert(), '§C SALES: Nein');
  const pc2Sales = await cmd.runRepairUpdate(deps(db), { ...identity('811', 'repairs.update'), role: 'SALES' } as never,
    { id: r.id, expectedRevision: rev(db, r.id), customerId: 'cust-2', customerChangeReason: 'falscher Kunde' });
  ok(code(pc2Sales) === 'PERMISSION_DENIED' && unveraendert(), `§C PC2 mit SALES-Ausweis: Nein (${code(pc2Sales)})`);
  ok(await versuch('ADMIN', 'cust-2', '  ') === 'REPAIR_CUSTOMER_REASON_REQUIRED' && unveraendert(), '§C ohne Grund: Nein');
  ok(await versuch('ADMIN', 'cust-1', 'derselbe') === 'REPAIR_CUSTOMER_UNCHANGED', '§C derselbe Kunde: Nein');
  ok(await versuch('ADMIN', 'cust-x', 'fremde Filiale') === 'CUSTOMER_NOT_FOUND' && unveraendert(), '§C Kunde einer anderen Filiale: Nein');
  ok(await versuch('ADMIN', 'cust-2', 'veraltet', rev(db, r.id) - 1) === 'RECORD_CHANGED' && unveraendert(), '§C veraltete Fassung: Nein');
  db.run("UPDATE repairs SET customer_paid_amount = 90 WHERE id = ?", [r.id]);
  ok(await versuch('ADMIN', 'cust-2', 'schon bezahlt') === 'REPAIR_CUSTOMER_LOCKED_PAID' && unveraendert(), '§C Zahlung erhalten: Nein');
  db.run("UPDATE repairs SET customer_paid_amount = 0 WHERE id = ?", [r.id]);
  db.run("UPDATE repairs SET invoice_id = 'inv-x' WHERE id = ?", [r.id]);
  ok(await versuch('ADMIN', 'cust-2', 'schon berechnet') === 'REPAIR_CUSTOMER_LOCKED_INVOICED' && unveraendert(), '§C auf einer Rechnung: Nein');
  db.run("UPDATE repairs SET invoice_id = NULL WHERE id = ?", [r.id]);
  insert(db, 'customer_gold_credits', { id: 'gc-1', branch_id: 'branch-main', customer_id: 'cust-1', source_repair_id: r.id, weight_grams: 2, karat: '18K' });
  ok(await versuch('ADMIN', 'cust-2', 'Goldguthaben') === 'REPAIR_CUSTOMER_LOCKED_GOLD_CREDIT' && unveraendert(), '§C Goldguthaben aus der Reparatur: Nein');
  db.run("DELETE FROM customer_gold_credits WHERE id = 'gc-1'");
  ok(await versuch('ADMIN', 'cust-2', 'jetzt frei') === '' && kundeVon(db, r.id) === 'cust-2', '§C ohne Sperre wieder erlaubt');
}

// ── §D Maske ─────────────────────────────────────────────────────────────────────────────────────
{
  const page = src('src/pages/repairs/RepairDetail.tsx');
  ok(/data-repair-change-customer\b/.test(page) && /perm\.canManageRepairs && !editing && !repair\.invoiceId && !\(\(repair\.customerPaidAmount \?\? 0\) > 0\.0005\)/.test(page),
    '§D „Change customer" nur für ADMIN/MANAGER, ohne Rechnung, ohne Zahlung');
  ok(/local: \(\) => changeRepairCustomerOnPrimary\(id, customerId, reason\.trim\(\), revision\)/.test(page)
    && /remote: \(\) => \(\{ id, expectedRevision: revision, customerId, customerChangeReason: reason\.trim\(\) \}\)/.test(page),
    '§D derselbe Befehl an Primary und PC2 (repairs.update), gegen die Fassung beim Öffnen');
  ok(/REASON FOR THE CHANGE \*/.test(page) && /disabled=\{!kundeWechsel\.customerId \|\| kundeWechsel\.reason\.trim\(\)\.length < 3\}/.test(page),
    '§D Grund ist Pflicht');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — hotfix F2 repair customer change: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('HOTFIX_F2_REPAIR_CUSTOMER_CHANGE_PROVED');

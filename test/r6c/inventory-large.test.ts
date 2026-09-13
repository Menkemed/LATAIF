// CENTRAL-UI-PARITY R6C — Korrektur vor dem Push: eine Inventur hat KEINE Höchstzahl.
//
// Der Kern des Primary beantwortet `latest_stock_checks` je Aufruf nur für die ersten 1000 Artikel
// (`lib.rs`, `.take(1000)`). Vorher fragte die Inventur mit der ganzen Liste — eine Beobachtung vom
// Telefon hinter Position 1000 wurde still nie eingefaltet. Hier läuft der ECHTE Anschluss
// (`tauriInventoryCore` → `latestStockChecks`) gegen einen Kern, der genau diese Kürzung nachstellt;
// Maschine, Hausfolge und Arbeitsblatt sind echt.
//
//   node test/r6c/inventory-large.test.ts

import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core') {
      return { url: pathToFileURL(resolvePath(repo, 'test/r6c/_rust-stock-check-shim.ts')).href, shortCircuit: true };
    }
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
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const session = await import('../../src/core/stock/inventory-session.ts');
const house = await import('../../src/core/stock/inventory-house.ts');
const inv = await import('../../src/core/bridge/inventory-commands.ts');
const stockCheck = await import('../../src/core/stock/stock-check.ts');
const { tauriInventoryCore } = await import('../../src/core/stock/inventory-core.ts');
const rust = await import('./_rust-stock-check-shim.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
let T = Date.parse(NOW);
const tick = (): string => { T += 1000; return new Date(T).toISOString(); };
rust.rustState.clock = tick;

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};
const count = (db: Db, table: string): number => { try { return n(db, `SELECT COUNT(*) FROM ${table}`); } catch { return -1; } };

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

/** Mehr als 1000 Artikel DIESER Filiale — die Reihenfolge ist die, in der die Maske sie nennt. */
const N = 1205;
const PID = (k: number): string => `p-${String(k).padStart(4, '0')}`;
const ALL = Array.from({ length: N }, (_, i) => PID(i + 1));

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run(session.INVENTORY_SESSION_DDL);
  db.run(session.INVENTORY_SESSION_ITEMS_DDL);
  db.run(session.INVENTORY_BOOTSTRAP_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at) VALUES ('cat','branch-main','Cat','Watch','#000','[]','[]','[]',1,1,?,?)", [NOW, NOW]);
  db.run('BEGIN');
  for (const [id, branch] of [...ALL.map((id) => [id, 'branch-main']), ['px', 'branch-other']]) {
    db.run(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery, purchase_price, purchase_currency,
         planned_sale_price, tax_scheme, stock_status, quantity, days_in_stock, images, attributes, source_type, created_at, updated_at)
       VALUES (?, ?, 'cat', 'Rolex', ?, ?, 'New', '[]', 100, 'BHD', 200, 'MARGIN', 'in_stock', 1, 0, '[]', '{}', 'OWN', ?, ?)`,
      [id, branch, 'Item ' + id, id.toUpperCase(), NOW, NOW],
    );
  }
  db.run('COMMIT');
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string) => ({
  commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadHash: 'h',
});
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => tick(),
});

async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}

const latestSizes = (): number[] => rust.rustState.calls.filter((c) => c.cmd === 'latest_stock_checks').map((c) => c.size);
const creates = () => rust.rustState.calls.filter((c) => c.cmd === 'create_stock_check');
const productState = (db: Db): string => S(rows(db, 'SELECT id, branch_id, quantity, stock_status, purchase_price, planned_sale_price, updated_at FROM products ORDER BY id'));

// ══ §1 — der Kern kürzt; der Anschluss fragt in Blöcken ══════════════════════
{
  const take = Number(/async fn latest_stock_checks[\s\S]*?\.take\((\d+)\)/.exec(src('src-tauri/src/lib.rs'))?.[1] ?? Number.NaN);
  rust.rustState.take = take;
  ok(take === 1000, `KERN latest_stock_checks beantwortet je Aufruf die ersten ${take} Artikel (aus lib.rs gelesen)`);
  ok(stockCheck.LATEST_STOCK_CHECKS_BATCH <= take, `KERN ein Block ist nie größer, als der Kern beantwortet (${stockCheck.LATEST_STOCK_CHECKS_BATCH} ≤ ${take})`);

  rust.rustState.reset();
  rust.phone('p-0005', 'available');
  rust.phone('p-1100', 'not_available', 'back room');
  const direct = await rust.invoke<Record<string, unknown>>('latest_stock_checks', { productIds: ALL });
  ok('p-0005' in direct && !('p-1100' in direct), 'KERN der alte Weg (ein Aufruf mit allen 1205) verliert p-1100 still — der Fehler war echt');

  rust.rustState.calls = [];
  const latest = await stockCheck.latestStockChecks(ALL);
  ok(latest['p-0005']?.status === 'available' && latest['p-1100']?.status === 'not_available' && latest['p-1100']?.notes === 'back room',
    'BLOCK latestStockChecks kennt p-0005 UND p-1100 (hinter Position 1000)');
  ok(S(latestSizes()) === S([1000, 205]), `BLOCK 1205 Artikel → zwei Aufrufe 1000 + 205 (${S(latestSizes())})`);
  for (const [size, want] of [[1000, [1000]], [1001, [1000, 1]], [2500, [1000, 1000, 500]], [0, []]] as Array<[number, number[]]>) {
    rust.rustState.calls = [];
    await stockCheck.latestStockChecks(Array.from({ length: size }, (_, i) => 'q' + i));
    ok(S(latestSizes()) === S(want), `BLOCK ${size} Artikel → ${S(want)} (${S(latestSizes())})`);
  }
  // Der Anschluss des Primary reicht die ganze Liste durch — kein Kürzen davor.
  rust.rustState.calls = [];
  const viaCore = await tauriInventoryCore().latest(ALL);
  ok('p-1100' in viaCore && S(latestSizes()) === S([1000, 205]), 'BLOCK tauriInventoryCore().latest liefert p-1100, in Blöcken');
}
marker('CENTRAL_UI_R6C_LATEST_CHECKS_CHUNKED');

// ══ §2 — Primary: dieselbe Hausfolge, mehr als 1000 Artikel ══════════════════
{
  const db = freshDb();
  rust.rustState.reset();
  rust.phone('p-1100', 'not_available', 'back room');
  const r = await house.startInventory(db as never, tauriInventoryCore(), house.INSIDE_COMMAND, {
    branchId: 'branch-main', productIds: ALL, now: tick(), newId: () => nextId(),
  });
  const item = r.sheet.items.find((i) => i.productId === 'p-1100');
  ok(r.created && r.foldedIn === 1 && item?.status === 'not_available' && item?.notes === 'back room' && r.sheet.revision === 2,
    `PRIMARY die Hausfolge faltet p-1100 ein (eingefaltet ${r.foldedIn}, Fassung ${r.sheet.revision})`);
  ok('p-1100' in r.latest, 'PRIMARY die letzten Beobachtungen umfassen Artikel hinter Position 1000');
}

// ══ §3 — über den Primary (Fernauftrag): start · save · finish ═══════════════
{
  const db = freshDb();
  const d = deps(db);
  rust.rustState.reset();
  const productsBefore = productState(db);
  const ledgerBefore = count(db, 'ledger_entries');
  const lotsBefore = count(db, 'stock_lots');
  const expBefore = count(db, 'expenses');
  rust.phone('p-0005', 'available');
  rust.phone('p-1100', 'not_available', 'back room');

  const s1 = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: ALL }));
  ok(s1.kind === 'ok' && s1.value.created === true && s1.value.foldedIn === 2 && s1.value.revision === 2,
    `START 1205 Artikel angenommen, beide Beobachtungen eingefaltet, Fassung 2 (${S(s1.value)} ${s1.code})`);
  ok(S(latestSizes()) === S([1000, 205]), `START der Kern wurde in Blöcken gefragt (${S(latestSizes())})`);
  const sid = String(s1.value.sessionId);
  const sheet = house.readSheet(db as never, 'branch-main');
  ok(sheet.items.find((i) => i.productId === 'p-1100')?.status === 'not_available' && sheet.items.find((i) => i.productId === 'p-0005')?.status === 'available',
    'START das Arbeitsblatt enthält p-0005 und p-1100');

  const decided = sheet.items.filter((i) => i.status === 'available' || i.status === 'not_available')
    .map((i) => ({ productId: i.productId, status: i.status, notes: i.notes ?? '' }));
  const body = { sessionId: sid, expectedRevision: 2, items: [...decided, { productId: 'p-1150', status: 'not_available', notes: 'not on shelf' }], visibleProductIds: ALL };
  const saveId = nextId();
  const v1 = await fern(() => inv.runInventorySave(d, identity(saveId, 'inventory.save'), body));
  ok(v1.kind === 'ok' && v1.value.revision === 3 && v1.value.recorded === 1 && v1.value.unchanged === false,
    `SAVE 1205 sichtbare Artikel angenommen, genau p-1150 beobachtet, Fassung 3 (${S(v1.value)} ${v1.code})`);
  ok(creates().length === 1 && creates()[0].requestId === `${saveId}:p-1150`, 'SAVE eine Beobachtung, Anfragekennung <commandId>:<productId>');
  const v1b = await fern(() => inv.runInventorySave(d, identity(saveId, 'inventory.save'), body));
  ok(v1b.kind === 'ok' && v1b.replayed && creates().length === 1, 'SAVE dieselbe Kennung → dieselbe Antwort, keine zweite Beobachtung');
  const stale = await fern(() => inv.runInventorySave(d, identity(nextId(), 'inventory.save'), body));
  ok(stale.kind === 'rejected' && stale.code === house.INVENTORY_SESSION_STALE && stale.frozen && creates().length === 1,
    `SAVE alte Fassung abgewiesen, bevor der Kern gerufen wird (${stale.code})`);
  const sheet2 = house.readSheet(db as never, 'branch-main');
  const p1150 = sheet2.items.find((i) => i.productId === 'p-1150');
  ok(sheet2.revision === 3 && p1150?.status === 'not_available' && p1150?.notes === 'not on shelf' && Boolean(p1150?.appliedCheckId),
    'SAVE p-1150 (hinter Position 1000) steht im Arbeitsblatt, mit seiner Beobachtung');
  ok((await stockCheck.latestStockChecks(ALL))['p-1150']?.status === 'not_available', 'SAVE die neue Beobachtung ist über die Blöcke lesbar');

  const f1 = await fern(() => inv.runInventoryFinish(d, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 3 }));
  const row = rows(db, 'SELECT status, revision, closed_at FROM inventory_sessions WHERE session_id = ?', [sid])[0];
  ok(f1.kind === 'ok' && row?.status === 'closed' && row?.revision === 4 && Boolean(row?.closed_at) && house.readSheet(db as never, 'branch-main').sessionId === null,
    `FINISH Lauf geschlossen, Fassung 4 (${S(row)})`);

  ok(productState(db) === productsBefore, 'WIRKUNG kein Artikel verändert (Menge, Status, Preise, Zeitstempel)');
  ok(ledgerBefore >= 0 && count(db, 'ledger_entries') === ledgerBefore, `WIRKUNG keine Hauptbuchzeile (${ledgerBefore} → ${count(db, 'ledger_entries')})`);
  ok(count(db, 'stock_lots') === lotsBefore && count(db, 'expenses') === expBefore, 'WIRKUNG keine Bestandslose, keine Ausgaben');

  // Die Filialgrenze gilt unverändert — auch bei mehr als 1000 Artikeln.
  const sessionsBefore = count(db, 'inventory_sessions');
  const foreign = await fern(() => inv.runInventoryStart(d, identity(nextId(), 'inventory.start'), { productIds: [...ALL, 'px'] }));
  ok(foreign.kind === 'rejected' && foreign.code === house.INVENTORY_PRODUCT_NOT_IN_BRANCH && foreign.frozen && count(db, 'inventory_sessions') === sessionsBefore,
    `GRENZE ein fremder Artikel unter 1206 → abgewiesen, nichts geschrieben (${foreign.code})`);
}
marker('CENTRAL_UI_R6C_INVENTORY_BEYOND_1000_PROVED');

// ══ §4 — keine Höchstzahl im Auftrag ═════════════════════════════════════════
{
  const many = Array.from({ length: 6000 }, (_, i) => 'x' + i);
  let startOk = false; let saveOk = false;
  try { startOk = inv.parseInventoryStart({ productIds: many }).productIds.length === 6000; } catch { /* abgewiesen */ }
  try {
    saveOk = inv.parseInventorySave({
      sessionId: 's', expectedRevision: 1, visibleProductIds: many,
      items: many.map((productId) => ({ productId, status: 'available', notes: '' })),
    }).items.length === 6000;
  } catch { /* abgewiesen */ }
  ok(startOk && saveOk, 'AUFTRAG 6000 Artikel werden nicht als „zu viele" abgewiesen');
}

// ══ §5 — PC2: keine lokale Datenbank, kein eigener Kern ══════════════════════
{
  store.set('lataif_runtime_mode', 'client');
  const before = rust.rustState.calls.length;
  const code = async (fn: () => Promise<unknown>): Promise<string> => { try { await fn(); return ''; } catch (e) { return String((e as { code?: string }).code); } };
  const e1 = await code(() => stockCheck.latestStockChecks(ALL));
  const e2 = await code(() => tauriInventoryCore().latest(ALL));
  store.delete('lataif_runtime_mode');
  ok(e1 === stockCheck.STOCK_CHECK_PRIMARY_ONLY && e2 === stockCheck.STOCK_CHECK_PRIMARY_ONLY && rust.rustState.calls.length === before,
    'PC2 der eigene Kern wird nicht gefragt — auch nicht blockweise');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6c inventory >1000: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6C_INVENTORY_NO_LIMIT_PROVED');

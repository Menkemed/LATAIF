// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die Inventur über den Primary: Lebenszyklus, Nebenläufigkeit,
// Atomarität, Sicherheit — und dieselbe Hausfolge für Primary und PC2.
// Run: node test/r6c/inventory-parity.test.ts
//
// Gefahren wird die ECHTE Hausfolge (`inventory-house.ts`) in der ECHTEN C3A-Maschine
// (`runRemoteCommand`, durabler Nachweis, echte Transaktionsklammern) gegen das echte Schema. Gestellt
// sind nur der Kern des Primary (die Beobachtungen, mit derselben Anfragekennungs-Regel wie
// `stock_check.rs`) und das Speichern.
//
//   §1 Umfang und Registry     §2 Lebenszyklus (beginnen → zählen → speichern → wieder öffnen → abschließen)
//   §3 Telefon-Beobachtungen   §4 Nebenläufigkeit (Fassung)   §5 Atomarität (Fehler an jedem Wirkungspunkt)
//   §6 Sicherheit              §7 Primary == PC2 (dieselbe Folge)   §8 Oberfläche (keine lokale DB, ein Anschluss)
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand, commandCount } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const session = await import('../../src/core/stock/inventory-session.ts');
const house = await import('../../src/core/stock/inventory-house.ts');
const inv = await import('../../src/core/bridge/inventory-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const readOps = await import('../../src/core/bridge/store-read-ops.ts');
const stockCheck = await import('../../src/core/stock/stock-check.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
/** EINE Uhr für Primary und Kern: jede Wirkung ist später als die vorige (wie in Wirklichkeit). */
let T = Date.parse(NOW);
const tick = (): string => { T += 1000; return new Date(T).toISOString(); };

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): Array<Record<string, unknown>> => {
  const r = db.exec(sql, p)[0];
  return r ? r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]]))) : [];
};

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
  // Das Inventur-Schema, wie der Schema-Lauf es anlegt (ohne den Bootstrap-Zeitstempel der Uhr).
  db.run(session.INVENTORY_SESSION_DDL);
  db.run(session.INVENTORY_SESSION_ITEMS_DDL);
  db.run(session.INVENTORY_BOOTSTRAP_DDL);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, attributes, scope_options, condition_options, active, sort_order, created_at, updated_at) VALUES ('cat','branch-main','Cat','Watch','#000','[]','[]','[]',1,1,?,?)", [NOW, NOW]);
  for (const [id, branch] of [['p1', 'branch-main'], ['p2', 'branch-main'], ['p3', 'branch-main'], ['p4', 'branch-main'], ['px', 'branch-other']]) {
    db.run(
      `INSERT INTO products (id, branch_id, category_id, brand, name, sku, condition, scope_of_delivery, purchase_price, purchase_currency,
         planned_sale_price, tax_scheme, stock_status, quantity, days_in_stock, images, attributes, source_type, created_at, updated_at)
       VALUES (?, ?, 'cat', 'Rolex', ?, ?, 'New', '[]', 100, 'BHD', 200, 'MARGIN', 'in_stock', 1, 0, '[]', '{}', 'OWN', ?, ?)`,
      [id, branch, 'Item ' + id, id.toUpperCase(), NOW, NOW],
    );
  }
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
const identity = (commandId: string, op: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});

function deps(db: Db, opts: { failSave?: boolean } = {}) {
  const state = { saves: 0, failSave: opts.failSave === true };
  return {
    state,
    deps: {
      db: db as never,
      begin: posting.beginLedgerTransaction,
      commit: posting.commitLedgerTransaction,
      rollback: posting.rollbackLedgerTransaction,
      durableSave: async () => { if (state.failSave) throw new Error('disk full'); state.saves += 1; },
      now: () => tick(),
    },
  };
}

/** Der Kern des Primary, nachgestellt: dieselbe Anfragekennungs-Regel wie `stock_check.rs` (Wiederholung → dieselbe Zeile). */
interface CheckRow { check_id: string; product_id: string; status: 'available' | 'not_available'; notes: string | null; checked_at: string; checked_by: string | null; checked_by_name: string | null; source: 'mobile' | 'desktop'; request_id: string | null }
function fakeCore(opts: { failWhen?: (call: number, productId: string) => boolean } = {}) {
  const rowsOf: CheckRow[] = [];
  let calls = 0;
  return {
    rows: rowsOf,
    get calls() { return calls; },
    failWhen: opts.failWhen,
    phone(productId: string, status: 'available' | 'not_available', notes: string | null = null): CheckRow {
      const r: CheckRow = { check_id: 'chk-' + (rowsOf.length + 1), product_id: productId, status, notes, checked_at: tick(), checked_by: null, checked_by_name: null, source: 'mobile', request_id: null };
      rowsOf.push(r);
      return r;
    },
    async latest(ids: readonly string[]) {
      const out: Record<string, CheckRow> = {};
      for (const id of ids) {
        const mine = rowsOf.filter((r) => r.product_id === id);
        if (mine.length) out[id] = mine[mine.length - 1];
      }
      return out as never;
    },
    async record(p: { productId: string; status: 'available' | 'not_available'; notes: string | null; userId?: string; requestId: string }) {
      calls += 1;
      const seen = rowsOf.find((r) => r.request_id === p.requestId);
      if (seen) return seen as never;
      if (this.failWhen?.(calls, p.productId)) throw new Error('STOCK_CHECK_DB_ERROR');
      const r: CheckRow = { check_id: 'chk-' + (rowsOf.length + 1), product_id: p.productId, status: p.status, notes: p.notes, checked_at: tick(), checked_by: p.userId ?? null, checked_by_name: null, source: 'desktop', request_id: p.requestId };
      rowsOf.push(r);
      return r as never;
    },
  };
}

/** Das Ergebnis eines Laufs, als Wert (wirft nie). */
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '' }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}

/** Eine Datenbank, die an EINER Stelle scheitert — für die Fehlerinjektion an echten Wirkungspunkten. */
function faulty(db: Db, pattern: RegExp) {
  const f = { armed: true };
  const proxy = new Proxy(db as object, {
    get(t, k) {
      if (k === 'run') {
        return (sql: string, p?: unknown[]) => {
          if (f.armed && pattern.test(sql)) throw new Error('INJECTED at ' + pattern);
          return (t as Db).run(sql, p);
        };
      }
      const v = (t as Record<string | symbol, unknown>)[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as unknown as Db;
  return { db: proxy, f };
}

const openSessions = (db: Db): Array<Record<string, unknown>> => rows(db, "SELECT session_id, status, revision, started_at FROM inventory_sessions WHERE branch_id = 'branch-main' AND status = 'open'");
const sheetItems = (db: Db, sid: string) => rows(db, 'SELECT product_id, status, notes, applied_check_id FROM inventory_session_items WHERE session_id = ? ORDER BY product_id', [sid]);
const VIS = ['p1', 'p2', 'p3'];

// ══ §1 — Umfang und Registry ════════════════════════════════════════════════
{
  const ops = ['inventory.start', 'inventory.save', 'inventory.finish', 'inventory.record_check'];
  ok(ops.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die vier Inventur-Absichten sind namentlich freigegeben');
  ok(ops.every((op) => registry.knownCommands().includes(op)), `SCOPE und registriert (${ops.filter((op) => !registry.knownCommands().includes(op)).join(',') || 'alle'})`);
  ok(ops.every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null), 'SCOPE kein erfundenes Recht (der Primary hat für die Inventur kein Tor)');
  ok(readOps.STORE_READ_OPS.includes('inventory.session.get') && readOps.STORE_READ_OPS.includes('inventory.checks.get'), 'SCOPE zwei Auskünfte: Arbeitsblatt + letzte Beobachtungen, Verlauf eines Artikels');
  const rust = src('src-tauri/src/bridge.rs');
  const list = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '';
  ok(['OP_INVENTORY_START', 'OP_INVENTORY_SAVE', 'OP_INVENTORY_FINISH', 'OP_INVENTORY_RECORD_CHECK', 'OP_INVENTORY_SESSION_GET', 'OP_INVENTORY_CHECKS_GET'].every((c) => list.includes(c)),
    'SCOPE Rust lässt dieselben sechs Namen durch');
  ok(!registry.ALLOWED_MUTATIONS.some((op) => /^inventory\.(adjust|delete|close_all|reset)/.test(op)), 'SCOPE keine Bestandskorrektur, kein Löschen, kein Zurücksetzen von außen');
}
marker('CENTRAL_UI_R6C_INVENTORY_COMMAND_MODEL_PROVED');

// ══ §2 — Lebenszyklus über die Maschine ═════════════════════════════════════
{
  const db = freshDb();
  const core = fakeCore();
  const d = deps(db);
  const stockBefore = S(rows(db, 'SELECT id, quantity, stock_status, purchase_price, planned_sale_price FROM products ORDER BY id'));
  const ledgerBefore = n(db, 'SELECT COUNT(*) FROM ledger_entries');

  const s1 = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  ok(s1.kind === 'ok' && s1.value.created === true && typeof s1.value.sessionId === 'string', `START ein Lauf beginnt (${S(s1.value)})`);
  const sid = String(s1.value.sessionId);
  ok(openSessions(db).length === 1 && Number(s1.value.revision) === 1, 'START genau ein offener Lauf, Fassung 1');

  const saveId = nextId();
  const body = { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: ' shelf A ' }, { productId: 'p2', status: 'not_available', notes: '' }], visibleProductIds: VIS };
  const v1 = await fern(() => inv.runInventorySave(d.deps, identity(saveId, 'inventory.save'), body, core));
  ok(v1.kind === 'ok' && v1.value.recorded === 2 && v1.value.revision === 2, `SAVE zwei Beobachtungen, Fassung 2 (${S(v1.value)})`);
  ok(core.rows.length === 2 && core.rows.every((r) => r.request_id === `${saveId}:${r.product_id}` && r.checked_by === 'user-test'),
    'SAVE jede Beobachtung trägt die Kennung DIESES Auftrags und den geprüften Benutzer — nicht aus dem Rumpf');
  const items = sheetItems(db, sid);
  ok(S(items.map((i) => [i.product_id, i.status, i.notes])) === S([['p1', 'available', 'shelf A'], ['p2', 'not_available', null], ['p3', 'to_check', null]]),
    `SAVE das Arbeitsblatt: zwei entschieden (Notiz getrimmt), der dritte bewusst offen (${S(items)})`);
  ok(items.filter((i) => i.applied_check_id).length === 2, 'SAVE die Zeilen zeigen auf ihre eigene Beobachtung (kein zweites Einfalten)');

  const s2 = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  ok(s2.kind === 'ok' && s2.value.sessionId === sid && s2.value.created === false && s2.value.revision === 2 && openSessions(db).length === 1,
    'REOPEN wieder öffnen nimmt DENSELBEN Lauf auf — kein zweiter, keine neue Fassung');
  const sheet = house.readSheet(db as never, 'branch-main');
  ok(sheet.sessionId === sid && sheet.items.filter((i: { status: string }) => i.status !== 'to_check').length === 2, 'READ das Arbeitsblatt steht wie gespeichert');

  const v2 = await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { ...body, expectedRevision: 2, items: [{ productId: 'p1', status: 'available', notes: 'shelf A' }, { productId: 'p2', status: 'not_available', notes: '' }] }, core));
  ok(v2.kind === 'ok' && v2.value.unchanged === true && core.rows.length === 2 && Number(one(db, 'SELECT revision FROM inventory_sessions WHERE session_id = ?', [sid])) === 2,
    'SAVE ein zweites Speichern ohne Änderung schreibt NICHTS (keine Beobachtung, keine Fassung)');

  const v3 = await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { ...body, expectedRevision: 2, items: [{ productId: 'p1', status: 'not_available', notes: 'gone' }, { productId: 'p2', status: 'not_available', notes: '' }] }, core));
  ok(v3.kind === 'ok' && v3.value.recorded === 1 && core.rows.length === 3 && v3.value.revision === 3, 'SAVE ein korrigiertes Urteil ist EINE neue Beobachtung (der Verlauf hängt an)');

  const f1 = await fern(() => inv.runInventoryFinish(d.deps, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 3 }));
  ok(f1.kind === 'ok' && openSessions(db).length === 0 && sheetItems(db, sid).length === 0 && one(db, 'SELECT status FROM inventory_sessions WHERE session_id = ?', [sid]) === 'closed',
    'FINISH der Lauf ist geschlossen, das Arbeitsblatt weggelegt');
  ok(core.rows.length === 3, 'FINISH der Verlauf bleibt unberührt');

  const s3 = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  ok(s3.kind === 'ok' && s3.value.created === true && s3.value.sessionId !== sid && s3.value.foldedIn === 0, 'NEXT der nächste Lauf beginnt leer — der abgeschlossene zieht nichts herüber');

  ok(S(rows(db, 'SELECT id, quantity, stock_status, purchase_price, planned_sale_price FROM products ORDER BY id')) === stockBefore
    && n(db, 'SELECT COUNT(*) FROM ledger_entries') === ledgerBefore,
  'EFFECT die ganze Inventur ändert weder Bestand noch Status noch Preis noch Hauptbuch (das tut eine Inventur in diesem Haus nicht)');
}
marker('CENTRAL_UI_R6C_INVENTORY_PRIMARY_SEMANTICS_AUDITED');

// ══ §3 — Beobachtungen vom Telefon ══════════════════════════════════════════
{
  const db = freshDb();
  const core = fakeCore();
  const d = deps(db);
  const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  const sid = String(s.value.sessionId);
  const phone = core.phone('p3', 'available', 'seen by phone');
  const again = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  ok(again.kind === 'ok' && again.value.foldedIn === 1 && again.value.revision === 2, `FOLD eine Telefon-Beobachtung im Lauf wird eingefaltet (${S(again.value)})`);
  const p3 = sheetItems(db, sid).find((i) => i.product_id === 'p3');
  ok(p3?.status === 'available' && p3?.applied_check_id === phone.check_id, 'FOLD die Zeile zeigt auf genau diese Beobachtung');
  const third = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  ok(third.value.foldedIn === 0 && third.value.revision === 2, 'FOLD …genau einmal');
}

// ══ §4 — Nebenläufigkeit: zwei Rechner, dasselbe Arbeitsblatt ════════════════
{
  const db = freshDb();
  const core = fakeCore();
  const d = deps(db);
  const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  const sid = String(s.value.sessionId);
  // Beide sehen Fassung 1. A speichert zuerst.
  const a = await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: 'A' }], visibleProductIds: VIS }, core));
  ok(a.kind === 'ok' && a.value.revision === 2, 'CONCURRENCY Rechner A speichert (Fassung 1 → 2)');
  const bId = nextId();
  const b = await fern(() => inv.runInventorySave(d.deps, identity(bId, 'inventory.save'), { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'not_available', notes: 'B' }], visibleProductIds: VIS }, core));
  ok(b.kind === 'rejected' && b.code === house.INVENTORY_SESSION_STALE && b.frozen, `CONCURRENCY Rechner B mit der alten Fassung: klares Nein, eingefroren (${b.code})`);
  ok(core.rows.length === 1 && sheetItems(db, sid).find((i) => i.product_id === 'p1')?.notes === 'A', 'CONCURRENCY B hat NICHTS geschrieben — keine Beobachtung, kein Arbeitsblatt');
  const bRetry = await fern(() => inv.runInventorySave(d.deps, identity(bId, 'inventory.save'), { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'not_available', notes: 'B' }], visibleProductIds: VIS }, core));
  ok(bRetry.kind === 'rejected' && bRetry.code === house.INVENTORY_SESSION_STALE, 'CONCURRENCY dieselbe Kennung bekommt dasselbe Nein (keine zweite Bewertung)');
  const fB = await fern(() => inv.runInventoryFinish(d.deps, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 1 }));
  ok(fB.kind === 'rejected' && fB.code === house.INVENTORY_SESSION_STALE && openSessions(db).length === 1, 'CONCURRENCY auch Abschließen mit alter Fassung: Nein — der Lauf bleibt offen');
  const bFresh = await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 2, items: [{ productId: 'p1', status: 'not_available', notes: 'B' }], visibleProductIds: VIS }, core));
  ok(bFresh.kind === 'ok' && bFresh.value.revision === 3, 'CONCURRENCY nach dem Neuladen (Fassung 2) geht es — der ausdrückliche Vertrag: sehen, dann schreiben');

  // Zwischen den Beobachtungen und dem Arbeitsblatt ändert ein anderer den Lauf (am Primary läuft die
  // Maske außerhalb eines Fernauftrags): die zweite Prüfung IN der Transaktion greift.
  let bumped = false;
  const sneaky = fakeCore();
  const orig = sneaky.record.bind(sneaky);
  sneaky.record = async (p) => { if (!bumped) { bumped = true; session.bumpSessionRevision(db as never, sid); } return orig(p); };
  let code = '';
  try {
    await house.saveInventory(db as never, sneaky, house.INSIDE_COMMAND, { branchId: 'branch-main', sessionId: sid, expectedRevision: 3, items: [{ productId: 'p2', status: 'available', notes: '' }], visibleProductIds: VIS, requestIdFor: (pid) => 'x:' + pid, now: tick() });
  } catch (e) { code = (e as { code?: string }).code ?? ''; }
  ok(code === house.INVENTORY_SESSION_STALE && !sheetItems(db, sid).some((i) => i.product_id === 'p2' && i.status === 'available'),
    'CONCURRENCY eine Änderung WÄHREND des Speicherns wird vor dem Arbeitsblatt erkannt — nichts wird blind überschrieben');
}
marker('CENTRAL_UI_R6C_INVENTORY_CONCURRENCY_PROVED');

// ══ §5 — Atomarität: Fehler an jedem echten Wirkungspunkt ════════════════════
{
  // (a) nach dem Anlegen des Laufs (beim Einfalten scheitert das Arbeitsblatt)
  {
    const db = freshDb();
    const core = fakeCore();
    core.phone('p1', 'available');
    const { db: bad, f } = faulty(db, /INSERT INTO inventory_session_items/);
    const d = deps(bad);
    const id = nextId();
    const r = await fern(() => inv.runInventoryStart(d.deps, identity(id, 'inventory.start'), { productIds: VIS }, core));
    ok(r.kind === 'thrown' && n(db, 'SELECT COUNT(*) FROM inventory_sessions') === 0 && lookupCommand(db as never, identity(id, 'inventory.start')).kind === 'fresh',
      `ATOMIC (a) scheitert es nach dem Anlegen des Laufs, gibt es KEINEN Lauf und keinen Nachweis (${r.code})`);
    f.armed = false;
    const again = await fern(() => inv.runInventoryStart(d.deps, identity(id, 'inventory.start'), { productIds: VIS }, core));
    ok(again.kind === 'ok' && again.value.foldedIn === 1 && n(db, 'SELECT COUNT(*) FROM inventory_sessions') === 1, 'ATOMIC (a) dieselbe Kennung danach: genau ein Lauf, genau eine Einfaltung');
  }
  // (b) nach dem Speichern der ersten Beobachtung (die zweite scheitert)
  {
    const db = freshDb();
    const core = fakeCore({ failWhen: (call) => call === 2 });
    const d = deps(db);
    const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
    const sid = String(s.value.sessionId);
    const id = nextId();
    const body = { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: '' }, { productId: 'p2', status: 'available', notes: '' }, { productId: 'p3', status: 'not_available', notes: '' }], visibleProductIds: VIS };
    const r = await fern(() => inv.runInventorySave(d.deps, identity(id, 'inventory.save'), body, core));
    ok(r.kind === 'thrown' && r.code === 'INVENTORY_CHECK_NOT_RECORDED', `ATOMIC (b) eine Beobachtung scheitert: kein Erfolg, kein eingefrorenes Nein (${r.code})`);
    ok(sheetItems(db, sid).length === 0 && Number(one(db, 'SELECT revision FROM inventory_sessions WHERE session_id = ?', [sid])) === 1
      && lookupCommand(db as never, identity(id, 'inventory.save')).kind === 'fresh', 'ATOMIC (b) das Arbeitsblatt und die Fassung sind unverändert, die Kennung bleibt frei');
    const landed = core.rows.length;
    core.failWhen = undefined;
    const again = await fern(() => inv.runInventorySave(d.deps, identity(id, 'inventory.save'), body, core));
    ok(again.kind === 'ok' && core.rows.length === 3 && landed >= 1, `ATOMIC (b) Wiederholung mit DERSELBEN Kennung: die schon geschriebene wird wiedergefunden — drei Beobachtungen, keine doppelt (${core.rows.length})`);
    ok(new Set(core.rows.map((x) => x.request_id)).size === 3 && sheetItems(db, sid).filter((i) => i.status !== 'to_check').length === 3, 'ATOMIC (b) …und erst jetzt steht das Arbeitsblatt, vollständig');
  }
  // (c) Differenzrechnung / (d) Bestandsbuchung: gibt es in dieser Inventur NICHT — bewiesen, statt behauptet.
  {
    const src2 = codeOf(src('src/core/stock/inventory-house.ts')) + codeOf(src('src/core/bridge/inventory-commands.ts'));
    ok(!/UPDATE products|INSERT INTO stock_lots|UPDATE stock_lots|post[A-Z]\w*\(|ledger_entries|stock_status\s*=/.test(src2),
      'ATOMIC (c/d) die Hausfolge hat keinen Weg zu Bestand, Losen oder Hauptbuch — keine Differenz, keine Bestandsbuchung, die halb stehen könnte');
    const db = freshDb();
    const core = fakeCore();
    const d = deps(db);
    const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
    const long = 'x'.repeat(501);
    const r = await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { sessionId: s.value.sessionId, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: 'ok' }, { productId: 'p2', status: 'available', notes: long }], visibleProductIds: VIS }, core));
    ok(r.kind === 'rejected' && r.code === house.INVENTORY_NOTE_TOO_LONG && core.calls === 0, 'ATOMIC (c) eine ungültige Eingabe wird VOR jeder Beobachtung abgewiesen — nichts geschrieben, auch nicht die gültige');
  }
  // (e) vor/beim Abschließen
  {
    const db = freshDb();
    const core = fakeCore();
    const good = deps(db);
    const s = await fern(() => inv.runInventoryStart(good.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
    const sid = String(s.value.sessionId);
    await fern(() => inv.runInventorySave(good.deps, identity(nextId(), 'inventory.save'), { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: '' }], visibleProductIds: VIS }, core));
    const { db: bad } = faulty(db, /UPDATE inventory_sessions SET status = 'closed'/);
    const d = deps(bad);
    const r = await fern(() => inv.runInventoryFinish(d.deps, identity(nextId(), 'inventory.finish'), { sessionId: sid, expectedRevision: 2 }));
    ok(r.kind === 'thrown' && openSessions(db).length === 1 && sheetItems(db, sid).length === 3, 'ATOMIC (e) scheitert das Abschließen, ist der Lauf NICHT „closed" — und das Arbeitsblatt ist vollständig da');
  }
  // (f) während der Durabilität
  {
    const db = freshDb();
    const core = fakeCore();
    const d = deps(db);
    const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
    const sid = String(s.value.sessionId);
    const id = nextId();
    const body = { sessionId: sid, expectedRevision: 1, items: [{ productId: 'p1', status: 'available', notes: '' }], visibleProductIds: VIS };
    d.state.failSave = true;
    const r = await fern(() => inv.runInventorySave(d.deps, identity(id, 'inventory.save'), body, core));
    ok(r.kind === 'thrown', 'ATOMIC (f) die Platte versagt nach der Wirkung: KEIN Erfolg (Ausgang offen)');
    d.state.failSave = false;
    const callsBefore = core.calls;
    const again = await fern(() => inv.runInventorySave(d.deps, identity(id, 'inventory.save'), body, core));
    ok(again.kind === 'ok' && again.replayed === true && core.calls === callsBefore && core.rows.length === 1,
      'ATOMIC (f) dieselbe Kennung: die eingefrorene Antwort — keine zweite Beobachtung, keine zweite Wirkung');
  }
}
marker('CENTRAL_UI_R6C_INVENTORY_ATOMICITY_PROVED');

// ══ §6 — Sicherheit: der Primary entscheidet ════════════════════════════════
{
  const db = freshDb();
  const core = fakeCore();
  const d = deps(db);
  const fremd = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: ['p1', 'px'] }, core));
  ok(fremd.kind === 'rejected' && fremd.code === house.INVENTORY_PRODUCT_NOT_IN_BRANCH && n(db, 'SELECT COUNT(*) FROM inventory_sessions') === 0, 'SECURITY ein Artikel einer fremden Filiale: Nein, kein Lauf');
  const branch = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start', 'branch-other'), { productIds: ['px'] }, core));
  ok(branch.kind === 'rejected' && branch.code === 'BRANCH_MISMATCH', 'SECURITY ein Ausweis einer anderen Filiale: Nein');
  const s = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
  const sid = String(s.value.sessionId);
  const save = (body: Record<string, unknown>) => fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), body, core));
  const base = { sessionId: sid, expectedRevision: 1, visibleProductIds: VIS };
  ok((await save({ ...base, sessionId: 'sess-fremd', items: [{ productId: 'p1', status: 'available', notes: '' }] })).code === house.INVENTORY_SESSION_NOT_OPEN, 'SECURITY eine fremde/erfundene Sitzung: Nein');
  ok((await save({ ...base, items: [{ productId: 'p4', status: 'available', notes: '' }] })).code === house.INVENTORY_PRODUCT_OUTSIDE_RUN, 'SECURITY ein Artikel außerhalb dieser Inventur: Nein');
  ok((await save({ ...base, visibleProductIds: [...VIS, 'px'], items: [] })).code === house.INVENTORY_PRODUCT_NOT_IN_BRANCH, 'SECURITY ein fremder Artikel im Sichtfeld: Nein');
  ok((await save({ ...base, items: [{ productId: 'p1', status: 'maybe', notes: '' }] })).code === house.INVENTORY_VERDICT_INVALID, 'SECURITY ein drittes Urteil gibt es nicht');
  ok((await save({ ...base, items: [{ productId: 'p1', status: 'available', notes: '' }, { productId: 'p1', status: 'not_available', notes: '' }] })).code === house.INVENTORY_VERDICT_INVALID, 'SECURITY zwei Urteile für einen Artikel: Nein');
  for (const k of ['expectedQuantity', 'variance', 'resultingStock', 'quantity', 'stockStatus', 'branchId', 'userId', 'checkedAt', 'revision', 'startedAt', 'appliedCheckId', 'requestId']) {
    let code = '';
    try { inv.parseInventorySave({ ...base, items: [], [k]: 1 }); } catch (e) { code = (e as Error).message; }
    let codeItem = '';
    try { inv.parseInventorySave({ ...base, items: [{ productId: 'p1', status: 'available', notes: '', [k]: 1 }] }); } catch (e) { codeItem = (e as Error).message; }
    ok(/the primary decides/.test(code) && /the primary decides/.test(codeItem), `SECURITY ${k} gibt der Primary vor, nicht der Client (Rumpf und Zeile)`);
  }
  for (const bad of [undefined, 0, -1, 1.5, '2']) {
    let threw = false;
    try { inv.parseInventorySave({ ...base, expectedRevision: bad, items: [] }); } catch { threw = true; }
    ok(threw, `SECURITY ohne gültige gesehene Fassung kein Speichern (${String(bad)})`);
  }
  let t = false; try { inv.parseInventoryStart({ productIds: VIS, extra: 1 }); } catch { t = true; }
  ok(t, 'SECURITY ein unbekanntes Feld wird abgewiesen statt ignoriert');
  // Einzel-Check
  const rc = nextId();
  const one1 = await fern(() => inv.runInventoryRecordCheck(d.deps, identity(rc, 'inventory.record_check'), { productId: 'p4', status: 'available', notes: ' in safe ' }, core));
  const again = await fern(() => inv.runInventoryRecordCheck(d.deps, identity(rc, 'inventory.record_check'), { productId: 'p4', status: 'available', notes: ' in safe ' }, core));
  ok(one1.kind === 'ok' && again.replayed === true && core.rows.filter((x) => x.product_id === 'p4').length === 1 && core.rows.find((x) => x.product_id === 'p4')?.notes === 'in safe',
    'CHECK Einzel-Check: genau eine Beobachtung, die Wiederholung derselben Kennung keine zweite');
  const foreign = await fern(() => inv.runInventoryRecordCheck(d.deps, identity(nextId(), 'inventory.record_check'), { productId: 'px', status: 'available' }, core));
  ok(foreign.kind === 'rejected' && foreign.code === house.INVENTORY_PRODUCT_NOT_IN_BRANCH, 'CHECK ein fremder Artikel: Nein');
  ok(commandCount(db as never) > 0, 'SECURITY jede bewertete Absicht hat ihren durablen Nachweis');
}
marker('CENTRAL_UI_R6C_INVENTORY_INPUT_AUTHORITY_PROVED');

// ══ §7 — Primary == PC2: dieselbe Hausfolge, zwei Anschlüsse ═════════════════
{
  const run = async (asPrimary: boolean) => {
    const db = freshDb();
    const core = fakeCore();
    const verdicts = [{ productId: 'p1', status: 'available' as const, notes: 'A1' }, { productId: 'p3', status: 'not_available' as const, notes: '' }];
    if (asPrimary) {
      const localTx = { run: <T,>(fn: () => T): T => { posting.beginLedgerTransaction(); try { const v = fn(); posting.commitLedgerTransaction(); return v; } catch (e) { posting.rollbackLedgerTransaction(); throw e; } } };
      const st = await house.startInventory(db as never, core, localTx, { branchId: 'branch-main', productIds: VIS, now: tick(), newId: () => 'sess-P' });
      await house.saveInventory(db as never, core, localTx, { branchId: 'branch-main', sessionId: st.sheet.sessionId!, expectedRevision: st.sheet.revision, items: verdicts, visibleProductIds: VIS, userId: 'user-test', requestIdFor: (p) => 'P:' + p, now: tick() });
    } else {
      const d = deps(db);
      const st = await fern(() => inv.runInventoryStart(d.deps, identity(nextId(), 'inventory.start'), { productIds: VIS }, core));
      await fern(() => inv.runInventorySave(d.deps, identity(nextId(), 'inventory.save'), { sessionId: st.value.sessionId, expectedRevision: st.value.revision, items: verdicts, visibleProductIds: VIS }, core));
    }
    const s = rows(db, "SELECT status, revision FROM inventory_sessions WHERE branch_id = 'branch-main'");
    const it = rows(db, 'SELECT product_id, status, notes FROM inventory_session_items ORDER BY product_id');
    const obs = core.rows.map((r) => [r.product_id, r.status, r.notes, r.checked_by, r.source]);
    return S({ s, it, obs });
  };
  const p = await run(true);
  const c = await run(false);
  ok(p === c, `PARITY Lauf, Fassung, Arbeitsblatt und Beobachtungen: Primary == PC2${p === c ? '' : ` (${p} / ${c})`}`);
}
marker('CENTRAL_UI_R6C_INVENTORY_PRIMARY_PARITY_PROVED');

// ══ §8 — Oberfläche: keine lokale DB, ein Anschluss je Rechner ═══════════════
{
  const modal = codeOf(src('src/components/products/StockCheckInventoryModal.tsx'));
  ok(!/getDatabase\(|saveDatabase\(|ensureOpenSession\(|persistSessionItems\(|closeSession\(|recordStockCheck\(|latestStockChecks\(/.test(modal),
    'UI die Maske fasst keine Datenbank und keinen Kern mehr selbst an');
  ok(/openInventoryHere\(ids\)/.test(modal) && /saveInventoryHere\(ask, rid, userId\)/.test(modal) && /finishInventoryHere\(sid, revision\)/.test(modal),
    'UI am Primary: die Hausfolge (Schreibreihenfolge, eigene Transaktion, durabel)');
  ok(/useSharedWrite<InventoryView>\('inventory\.start'\)/.test(modal) && /useSharedWrite<SaveValue>\('inventory\.save'\)/.test(modal) && /useSharedWrite<\{ sessionId: string \}>\('inventory\.finish'\)/.test(modal),
    'UI auf PC2: je Absicht EIN Wächter — eine verlorene Antwort wiederholt denselben Versuch');
  ok(/inventoryViewFromPrimary\(/.test(modal) && /expectedRevision: revision/.test(modal), 'UI PC2 liest das Arbeitsblatt vom Primary und nennt die gesehene Fassung');
  ok(/const locked = saving \|\| loading \|\| pending;/.test(modal) && /disabled=\{locked\}/.test(modal), 'UI solange ein Ausgang offen ist, bleibt das Arbeitsblatt unverändert (dieselbe Kennung, derselbe Rumpf)');
  ok(!/data-primary-only="inventory"/.test(modal), 'UI die R6B-Sperre ist ersetzt — die Inventur geht auf PC2 über den Primary');
  const port = codeOf(src('src/core/stock/inventory-port.ts'));
  ok((port.match(/runExclusive\(async/g) ?? []).length === 4 && /beginLedgerTransaction\(\)/.test(port) && /rollbackLedgerTransaction\(\)/.test(port),
    'UI der Primary-Anschluss läuft in der Schreibreihenfolge und in einer eigenen Transaktion (vorher: direkt, an der Warteschlange vorbei)');
  const panel = codeOf(src('src/components/products/StockCheckPanel.tsx'));
  ok(/useSharedWrite<\{ checkId: string \}>\('inventory\.record_check'\)/.test(panel) && /recordCheckHere\(/.test(panel) && /checksFromPrimary\(/.test(panel) && !/recordStockCheck\(/.test(panel),
    'UI der Einzel-Check: am Primary die Hausfolge, auf PC2 über den Primary (Schreiben und Verlauf)');
  const watch = codeOf(src('src/pages/watches/WatchList.tsx'));
  ok(/data-testid="open-inventory"\s*disabled=\{filtered\.length === 0\}/.test(watch), 'UI „Stock Check" ist auf PC2 nicht mehr gesperrt');
  // Die R6B-Invariante bleibt: der Kern DIESES Rechners wird auf einem Client nie gefragt.
  store.set('lataif_runtime_mode', 'client');
  let refused = '';
  try { await stockCheck.recordStockCheck({ productId: 'p1', status: 'available', notes: null, requestId: 'r' }); } catch (e) { refused = String((e as { code?: string }).code); }
  store.delete('lataif_runtime_mode');
  ok(refused === stockCheck.STOCK_CHECK_PRIMARY_ONLY, 'UI R6B bleibt: auf dem Client ruft der Stock-Check den eigenen Kern nicht (keine zweite Wahrheit)');
  const cmd = codeOf(src('src/core/bridge/inventory-commands.ts'));
  ok(/startInventory\(/.test(cmd) && /saveInventory\(/.test(cmd) && /finishInventory\(/.test(cmd) && /recordSingleCheck\(/.test(cmd) && /assertHouseBranch\(identity\)/.test(cmd),
    'UI der Fernbefehl ruft DIESELBE Hausfolge wie die Maske des Primary — in der Filiale, deren Bücher der Primary führt');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6c inventory parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6C_INVENTORY_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7A (PP-11) — die Notiz der Aufgabenmaske wird gespeichert.
// Run: node test/r7a/pp11-task-note.test.ts
//
// Befund: die Maske zeigte „NOTES", `tasks` hatte keine Spalte, der Text wurde auf beiden Rechnern still
// verworfen. Jetzt: Spalte `tasks.notes` (additive Migration), derselbe Rumpf (`tasks.create`/
// `tasks.update` — keine neue Fähigkeit), Hin- und Rückweg auf Primary und PC2, Fassungsschutz,
// Urheber/Protokoll unverändert, Abgleich-Manifest trägt das Feld, ein Echo erhöht keine Fassung.
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
  // Abgleich eingeschaltet: `trackChange` schreibt ins Änderungsprotokoll — messbar, auch im Rollback.
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
// Die Fehlerinjektion am Abgleich lässt `trackChange` warnen (es schluckt den Fehler) — genau das,
// was die Hausfolge jetzt bemerkt. Die Warnung selbst ist hier nur Rauschen.
const warn = console.warn;
console.warn = (...a: unknown[]): void => { if (!String(a[0]).startsWith('[Sync] Failed to track change')) warn(...a); };

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { tauriState } = await import('../bridge/_tauri-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const office = await import('../../src/core/bridge/office-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const taskStore = await import('../../src/stores/taskStore.ts');
const docStore = await import('../../src/stores/documentStore.ts');
const taskHouse = await import('../../src/core/office/task-house.ts');
const docHouse = await import('../../src/core/office/document-house.ts');
const { useAuthStore } = await import('../../src/stores/authStore.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const MANIFEST = JSON.parse(src('src/core/sync/sync-business-schema.json')) as { limits: { max_payload_bytes: number } };

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
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Watch','w','#000',?,?)", [NOW, NOW]);
  for (const [id, first, branch] of [['cust-1', 'Ali', 'branch-main'], ['cust-x', 'Fremd', 'branch-other']]) {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES (?,?,?,'Hassan','BH','en',0,'[]','collector','active',?,?)`, [id, branch, first, NOW, NOW]);
  }
  for (const [id, branch] of [['p1', 'branch-main'], ['p-foreign', 'branch-other']]) {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,?,'cat-w','Rolex',?,?,1,'Pre-Owned','[]',100,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`,
    [id, branch, 'M ' + id, 'SKU-' + id, NOW, NOW]);
  }
  // Die Benutzer der Filialen — die Menge, aus der eine Zuweisung kommen darf.
  for (const [id, branch, active] of [['user-test', 'branch-main', 1], ['user-pc2', 'branch-main', 1],
    ['user-off', 'branch-main', 0], ['user-other', 'branch-other', 1]] as Array<[string, string, number]>) {
    insert(db, 'users', { id, tenant_id: 'tenant-1', email: `${id}@x.test`, password_hash: 'h', name: id, active, created_at: NOW, updated_at: NOW });
    insert(db, 'user_branches', { user_id: id, branch_id: branch, role: 'sales', created_at: NOW });
  }
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  tauriState.reset();
  return db;
}

useAuthStore.setState({ session: { userId: 'user-test', branchId: 'branch-main', role: 'ADMIN' } as never });

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' };
const identity = (x: string, op: string, over: Partial<typeof ACTOR> = {}) =>
  ({ commandId: ID(x), ...ACTOR, ...over, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never,
  begin: posting.beginLedgerTransaction,
  commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction,
  durableSave: async () => {},
  now: () => NOW,
});
const frei = (db: Db, x: string, op: string): boolean => lookupCommand(db as never, identity(x, op) as never).kind === 'fresh';

interface Ausgang { ok: boolean; code: string; frozen: boolean; thrown: boolean; value: Record<string, unknown>; replayed: boolean; message: string }
async function fern(p: () => Promise<unknown>): Promise<Ausgang> {
  try {
    const o = await p() as { kind: string; code?: string; value?: Record<string, unknown>; replayed?: boolean; frozen?: boolean; message?: string };
    if (o.kind === 'ok') return { ok: true, code: '', frozen: false, thrown: false, value: o.value ?? {}, replayed: o.replayed === true, message: '' };
    return { ok: false, code: o.code ?? '(ohne Code)', frozen: o.frozen === true, thrown: false, value: {}, replayed: false, message: o.message ?? '' };
  } catch (e) {
    return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false, message: (e as Error).message };
  }
}
async function primary(p: () => unknown): Promise<Ausgang> {
  try { return { ok: true, code: '', frozen: false, thrown: false, value: (await p() ?? {}) as Record<string, unknown>, replayed: false, message: '' }; }
  catch (e) { return { ok: false, code: (e as { code?: string }).code ?? 'THROWN:' + String(e), frozen: false, thrown: true, value: {}, replayed: false, message: (e as Error).message }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}

const OHNE = /^(id|version|sync_status)$|_at$|_date$/;
function ohne(r: Record<string, unknown>, auch: string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(r).filter(([k]) => !OHNE.test(k) && !auch.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
}
const unterschiede = (a: Record<string, unknown>, b: Record<string, unknown>): string[] =>
  Object.keys({ ...a, ...b }).filter((k) => S(a[k] ?? null) !== S(b[k] ?? null)).map((k) => `${k}: ${S(a[k])} vs ${S(b[k])}`);
const lc = (db: Db): number => n(db, 'SELECT COUNT(*) FROM ledger_entries');
const cl = (db: Db, table: string, action?: string): number => n(db,
  `SELECT COUNT(*) FROM sync_changelog WHERE table_name = ?${action ? ' AND action = ?' : ''}`, action ? [table, action] : [table]);
const audits = (db: Db, table: string): number => n(db, 'SELECT COUNT(*) FROM audit_log WHERE entity_type = ?', [table]);
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


// ══ R7A PP-11 ═══════════════════════════════════════════════════════════════
const ac = await import('../../src/core/sync/apply-change.ts');
const { localReadContext } = await import('../../src/core/data/read-context.ts');
const FORM = {
  title: 'Call Ali', description: 'About the Daytona', type: 'follow_up', priority: 'high',
  dueAt: '', linkedEntityType: '', linkedEntityId: '', notes: '  Bring the box  ',
};
const tRow = (db: Db, id: string): Record<string, unknown> => row(db, 'SELECT * FROM tasks WHERE id = ?', [id]);
const rev = (db: Db, id: string): number => n(db, 'SELECT revision FROM tasks WHERE id = ?', [id]);
const changes = (db: Db, id: string) => (db.exec(
  "SELECT table_name, record_id, action, data FROM sync_changelog WHERE table_name = 'tasks' AND record_id = ? ORDER BY id", [id])[0]?.values ?? [])
  .map((v) => ({ table_name: String(v[0]), record_id: String(v[1]), action: String(v[2]), data: String(v[3]) }));

// §1 — Primary: anlegen, nur die Notiz ändern, leeren.
const dbP = freshDb();
const pc = await primary(() => taskStore.createTaskOnPrimary(taskHouse.taskCreateBody(FORM)));
const idP = String(pc.value.taskId);
const p1 = tRow(dbP, idP);
ok(pc.ok && p1.notes === 'Bring the box' && Number(p1.revision) === 1 && p1.created_by === 'user-test',
  `PRIMARY anlegen: Notiz gespeichert (getrimmt), Fassung 1, Urheber die Sitzung (${S([p1.notes, p1.revision, p1.created_by])})`);
const aP = audits(dbP, 'tasks');
const clP = cl(dbP, 'tasks', 'update');
const pu = await primary(() => taskStore.updateTaskOnPrimary(taskHouse.taskUpdateBody({ id: idP, revision: 1 }, { ...FORM, notes: 'Box + papers' })));
const p2 = tRow(dbP, idP);
ok(pu.ok && p2.notes === 'Box + papers' && Number(p2.revision) === 2 && p2.title === 'Call Ali' && audits(dbP, 'tasks') > aP && cl(dbP, 'tasks', 'update') > clP,
  `PRIMARY nur die Notiz geändert: gespeichert, Fassung 2, Protokoll und Abgleich wie jede Änderung (${S([p2.notes, p2.revision])})`);
const pk = await primary(() => taskStore.updateTaskOnPrimary(taskHouse.taskUpdateBody({ id: idP, revision: 2 }, { ...FORM, notes: '   ' })));
const p3 = tRow(dbP, idP);
ok(pk.ok && p3.notes === null && Number(p3.revision) === 3, `PRIMARY eine geleerte Notiz wird NULL, Fassung 3 (${S([p3.notes, p3.revision])})`);
const same = await primary(() => taskStore.updateTaskOnPrimary(taskHouse.taskUpdateBody({ id: idP, revision: 3 }, { ...FORM, notes: '' })));
ok(same.ok && same.value.changed === false && rev(dbP, idP) === 3, 'PRIMARY dieselbe (leere) Notiz noch einmal: keine Änderung, keine neue Fassung');

// §2 — PC2: derselbe Rumpf über den Fernbefehl.
const dbC = freshDb();
const cc = await fern(() => office.runTaskCreate(deps(dbC) as never, identity('1', 'tasks.create') as never, taskHouse.taskCreateBody(FORM)));
const idC = String(cc.value.taskId);
const c1 = tRow(dbC, idC);
ok(cc.ok && c1.notes === 'Bring the box' && Number(c1.revision) === 1 && c1.created_by === 'user-pc2',
  `PC2 anlegen: Notiz gespeichert, Urheber der geprüfte Absender (${S([c1.notes, c1.created_by])})`);
ok(S(ohne(p1, ['created_by'])) === S(ohne(c1, ['created_by'])), `PARITY anlegen: Primary == PC2 (${unterschiede(ohne(p1, ['created_by']), ohne(c1, ['created_by'])).join('; ')})`);
const upd = taskHouse.taskUpdateBody({ id: idC, revision: 1 }, { ...FORM, notes: 'Box + papers' });
const cu = await fern(() => office.runTaskUpdate(deps(dbC) as never, identity('2', 'tasks.update') as never, upd));
const c2 = tRow(dbC, idC);
ok(cu.ok && c2.notes === 'Box + papers' && Number(c2.revision) === 2, `PC2 Notiz geändert, Fassung 2 (${S([c2.notes, c2.revision])})`);
ok(S(ohne(p2, ['created_by'])) === S(ohne(c2, ['created_by'])), `PARITY ändern: Primary == PC2 (${unterschiede(ohne(p2, ['created_by']), ohne(c2, ['created_by'])).join('; ')})`);
const again = await fern(() => office.runTaskUpdate(deps(dbC) as never, identity('2', 'tasks.update') as never, upd));
ok(again.ok && again.replayed && rev(dbC, idC) === 2 && tRow(dbC, idC).notes === 'Box + papers',
  'LOST dieselbe Kennung noch einmal: das eingefrorene Ergebnis, keine zweite Fassung');
const stale = await fern(() => office.runTaskUpdate(deps(dbC) as never, identity('3', 'tasks.update') as never,
  taskHouse.taskUpdateBody({ id: idC, revision: 1 }, { ...FORM, notes: 'stale' })));
ok(!stale.ok && stale.code === 'RECORD_CHANGED' && tRow(dbC, idC).notes === 'Box + papers' && rev(dbC, idC) === 2,
  `STALE eine Änderung aus einem veralteten Fenster überschreibt die Notiz nicht (${stale.code})`);
const bad = await fern(() => office.runTaskUpdate(deps(dbC) as never, identity('4', 'tasks.update') as never, { taskId: idC, expectedRevision: 2, notes: 5 }));
ok(!bad.ok && bad.code === 'TASK_FIELD_INVALID' && /notes must be text/.test(bad.message), `FORM eine Notiz muss Text sein (${bad.code}: ${bad.message})`);
const aud = row(dbC, "SELECT changed_by FROM audit_log WHERE entity_type = 'tasks' AND entity_id = ? ORDER BY rowid DESC LIMIT 1", [idC]);
ok(aud.changed_by === 'user-pc2', `ACTOR das Protokoll der Notiz-Änderung nennt den geprüften Absender (${S(aud)})`);
const spoof = await fern(() => office.runTaskUpdate(deps(dbC) as never, identity('5', 'tasks.update') as never, { taskId: idC, expectedRevision: 2, notes: 'x', createdBy: 'user-test' }));
ok(!spoof.ok && /the primary decides createdBy/.test(spoof.message) && tRow(dbC, idC).notes === 'Box + papers', 'AUTHORITY ein Urheber im Rumpf bleibt ein Nein');

// §3 — PC2 liest die Notiz (die Auskunft der Aufgabenliste) und die Maske lädt sie.
setTestDatabase(dbC as never);
const read = taskStore.loadTasksFor(localReadContext());
ok(read.tasks.find((t) => t.id === idC)?.notes === 'Box + papers', 'READ die Aufgabenliste (store.tasks.get) liefert die Notiz — PC2 sieht, was gespeichert ist');

// §4 — Abgleich: das Manifest trägt das Feld, ein Echo ist kein Schreiben, ein Datenbank-Rechner bekommt die Notiz.
const stream = changes(dbC, idC);
const last = stream[stream.length - 1];
ok(!!last && JSON.parse(last.data).notes === 'Box + papers' && ac.changeContractViolation('tasks', 'update', last.data) === null,
  'SYNC die Änderung trägt die Notiz und besteht den Feldvertrag (tasks.allowed_fields enthält notes)');
const rv0 = rev(dbC, idC);
const tc0 = n(dbC, 'SELECT total_changes()');
ac.applySyncChange(dbC as never, last as never);
ok(rev(dbC, idC) === rv0 && n(dbC, 'SELECT total_changes()') === tc0, `ECHO dieselbe Zeile zurück: nichts geschrieben, keine neue Fassung (${rv0} → ${rev(dbC, idC)})`);
const dbPeer = freshDb();
for (const ch of stream) ac.applySyncChange(dbPeer as never, ch as never);
ok(tRow(dbPeer, idC).notes === 'Box + papers', 'SYNC ein anderer Datenbank-Rechner bekommt die Notiz');

// §5 — Oberfläche und Umfang: dieselben zwei Befehle, keine neue Fähigkeit.
{
  const tl = codeOf(src('src/pages/tasks/TaskList.tsx'));
  const th = codeOf(src('src/core/office/task-house.ts'));
  const oc = codeOf(src('src/core/bridge/office-commands.ts'));
  ok(tl.includes('data-task-notes') && /notes: task\.notes \|\| ''/.test(tl), 'UI die Maske lädt die gespeicherte Notiz und hat einen Haken für den Lauf');
  ok(/notes: f\.notes\.trim\(\) \|\| null/.test(th) && /want\('notes', 'notes', v\.notes\)/.test(th) && /assigned_to, notes, status/.test(th),
    'HOUSE Rumpf, Anlegen und Ändern tragen die Notiz');
  ok(/const TASK_FIELDS = \[[^\]]*'notes'\]/.test(oc), 'BRIDGE `notes` ist ein Feld des bestehenden Rumpfs');
  ok(registry.ALLOWED_MUTATIONS.filter((o: string) => o.startsWith('tasks.')).join(',') === 'tasks.create,tasks.update',
    'SCOPE keine neue Fähigkeit: tasks.create/tasks.update reichen');
  ok(/ALTER TABLE tasks ADD COLUMN notes TEXT/.test(src('src/core/db/database.ts')), 'SCHEMA additive Migration (tasks.notes)');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — post-parity r7a pp-11 task note: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('POST_PARITY_R7A_PP11_TASK_NOTE_FIXED');

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — Aufgaben und Dokumente: `tasks.create`, `tasks.update` (inkl. „Complete"),
// `documents.upload`, `documents.set_ocr` — EINE Hausfolge für Primary und PC2.
// Run: node test/r6f/office-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfolgen (`office/task-house`, `office/document-house`), die echten
// Primary-Anschlüsse (`createTaskOnPrimary`/`updateTaskOnPrimary`/`uploadDocumentOnPrimary`/
// `extractOcrOnPrimary` → `runOnPrimary`), die echte C3A-Maschine mit durablem Nachweis und das echte
// Schema samt Revisions-Triggern. Gestellt sind nur das Speichern, die Texterkennung (tesseract braucht
// Sprachdaten — hier ein Stub, der mitschreibt, WAS er erkennen sollte) und im Client-Abschnitt das Netz.
//
//   §1 Umfang   §2 Aufgaben: Primary == PC2   §3 Aufgaben: Wiederholung, Fassung, Sperren, Autorität,
//   Fehlerinjektion   §4 Aufgaben: Client + Oberfläche   §5 Upload: Primary == PC2, Grenzen, Typ, Name,
//   Verknüpfung, Fehlerinjektion   §6 Texterkennung   §7 Dokumente: Client + Oberfläche
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

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  const OPS = ['tasks.create', 'tasks.update', 'documents.upload', 'documents.set_ocr'];
  for (const op of OPS) {
    ok(registry.ALLOWED_MUTATIONS.includes(op), `SCOPE ${op} ist namentlich freigegeben`);
    ok(registry.knownCommands().includes(op), `SCOPE ${op} ist registriert`);
    ok(perms.OPERATION_PERMISSIONS[op] === null && perms.roleMayRunOp('SALES', op), `SCOPE ${op} ohne Tor (wie die Masken)`);
  }
  ok(S([...office.OFFICE_OPS].sort()) === S([...OPS].sort()), 'SCOPE die Befehlsdatei kennt genau diese vier');
  const reg = codeOf(src('src/core/bridge/office-commands.ts'));
  ok((reg.match(/registerCommand\(/g) || []).length === 4 && !/for \(|forEach/.test(reg.slice(reg.indexOf('registerCommand('))),
    'SCOPE vier ausdrückliche Anmeldungen, keine Schleife');
}

// ══ §2 — Aufgaben: Primary == PC2 ═══════════════════════════════════════════
const FORM = {
  title: ' Call Ali back ', description: 'Ring about the Daytona ', type: 'follow_up', priority: 'high',
  dueAt: '2026-09-20', linkedEntityType: 'customer', linkedEntityId: 'cust-1',
  // R7A (PP-11) — die Notiz hat ihre Spalte und reist mit.
  notes: ' Bring the box ',
};
const EDIT = { ...FORM, title: 'Call Ali again', description: '', priority: 'urgent', dueAt: '', linkedEntityType: '', linkedEntityId: '' };
const taskRow = (db: Db): Record<string, unknown> => row(db, 'SELECT * FROM tasks ORDER BY created_at LIMIT 1');
{
  // Primary: die Maske über ihre Anschlüsse.
  const dbP = freshDb();
  const c1 = await primary(() => taskStore.createTaskOnPrimary(taskHouse.taskCreateBody(FORM)));
  const p1 = taskRow(dbP);
  const u1 = await primary(() => taskStore.updateTaskOnPrimary(taskHouse.taskUpdateBody({ id: String(p1.id), revision: 1 }, EDIT)));
  const p2 = taskRow(dbP);
  const k1 = await primary(() => taskStore.updateTaskOnPrimary(taskHouse.taskCompleteBody({ id: String(p1.id), revision: 2 })));
  const p3 = taskRow(dbP);
  const clP = [cl(dbP, 'tasks', 'insert'), cl(dbP, 'tasks', 'update')];
  const auditP = s(dbP, "SELECT changed_by FROM audit_log WHERE entity_type = 'tasks' AND action_type = 'CREATE'");

  // PC2: dieselben Rümpfe als Fernaufträge.
  const dbR = freshDb();
  const c2 = await fern(() => office.runTaskCreate(deps(dbR), identity('101', 'tasks.create'), taskHouse.taskCreateBody(FORM)));
  const r1 = taskRow(dbR);
  const u2 = await fern(() => office.runTaskUpdate(deps(dbR), identity('102', 'tasks.update'), taskHouse.taskUpdateBody({ id: String(r1.id), revision: 1 }, EDIT)));
  const r2 = taskRow(dbR);
  const k2 = await fern(() => office.runTaskUpdate(deps(dbR), identity('103', 'tasks.update'), taskHouse.taskCompleteBody({ id: String(r1.id), revision: 2 })));
  const r3 = taskRow(dbR);
  const clR = [cl(dbR, 'tasks', 'insert'), cl(dbR, 'tasks', 'update')];
  const auditR = s(dbR, "SELECT changed_by FROM audit_log WHERE entity_type = 'tasks' AND action_type = 'CREATE'");

  ok(c1.ok && u1.ok && k1.ok && c2.ok && u2.ok && k2.ok,
    `PARITY beide Wege legen an, ändern, erledigen (${[c1, u1, k1, c2, u2, k2].map((x) => x.code || 'ok').join(' ')})`);
  const d = [p1, p2, p3].flatMap((p, i) => unterschiede(ohne(p, ['created_by']), ohne([r1, r2, r3][i], ['created_by'])));
  ok(d.length === 0, `PARITY lokal == fern nach jedem Schritt (${d.join(' · ') || 'gleich'})`);
  ok(r1.title === 'Call Ali back' && r1.description === 'Ring about the Daytona' && r1.status === 'open' && r1.type === 'follow_up'
    && r1.priority === 'high' && r1.linked_entity_type === 'customer' && r1.linked_entity_id === 'cust-1'
    && r1.branch_id === 'branch-main' && Number(r1.auto_generated) === 0 && Number(r1.revision) === 1,
  `CREATE die Zeile: Titel getrimmt, Status open, Filiale des Auftrags, Fassung 1 (${S(ohne(r1))})`);
  ok(r1.due_at === '2026-09-20T00:00:00.000Z' && p1.due_at === r1.due_at,
    `CREATE das Datum der Maske wird derselbe ISO-Zeitpunkt wie vorher in der Maske (${S([p1.due_at, r1.due_at])})`);
  ok(p1.created_by === 'user-test' && r1.created_by === 'user-pc2' && auditP === 'user-test' && auditR === 'user-pc2',
    `ACTOR angelegt von: lokal die Sitzung, fern der geprüfte Absender — Zeile UND Protokoll (${S([p1.created_by, r1.created_by, auditP, auditR])})`);
  ok(r2.title === 'Call Ali again' && r2.description === null && r2.priority === 'urgent' && r2.due_at === null
    && r2.linked_entity_type === null && r2.linked_entity_id === null && Number(r2.revision) === 2 && r2.completed_at === null,
  `UPDATE geleerte Felder werden NULL, Fassung 2 (${S(ohne(r2))})`);
  ok(r3.status === 'completed' && typeof r3.completed_at === 'string' && typeof p3.completed_at === 'string' && Number(r3.revision) === 3,
    `COMPLETE Status completed, Zeitpunkt vom Primary, Fassung 3 (${S([r3.status, r3.completed_at, r3.revision])})`);
  ok(S(clP) === S([1, 2]) && S(clR) === S([1, 2]), `SYNC je Schritt ein Abgleich-Eintrag (${S([clP, clR])})`);
  ok(S(Object.keys(c2.value).sort()) === S(['revision', 'taskId']) && c2.value.taskId === r1.id && c2.value.revision === 1,
    `RESULT klein: Kennung und Fassung (${S(c2.value)})`);
  ok(S(Object.keys(k2.value).sort()) === S(['changed', 'revision', 'status', 'taskId']) && k2.value.status === 'completed' && k2.value.revision === 3,
    `RESULT Ändern: Status und neue Fassung (${S(k2.value)})`);
  ok(lc(dbP) === 0 && lc(dbR) === 0, 'LEDGER Aufgaben buchen nichts');
}

// ══ §3 — Aufgaben: Wiederholung, Fassung, Sperren, Autorität, Fehlerinjektion ═
{
  const db = freshDb();
  const create = (x: string, body: Record<string, unknown>, over: Partial<typeof ACTOR> = {}) =>
    fern(() => office.runTaskCreate(deps(db), identity(x, 'tasks.create', over), body));
  const update = (x: string, body: Record<string, unknown>, over: Partial<typeof ACTOR> = {}) =>
    fern(() => office.runTaskUpdate(deps(db), identity(x, 'tasks.update', over), body));
  const count = (): number => n(db, 'SELECT COUNT(*) FROM tasks');

  // Verlorene Antwort: dieselbe Kennung zweimal — eine Aufgabe.
  const a = await create('110', taskHouse.taskCreateBody(FORM));
  const b = await create('110', taskHouse.taskCreateBody(FORM));
  ok(a.ok && !a.replayed && b.ok && b.replayed && b.value.taskId === a.value.taskId && count() === 1 && cl(db, 'tasks', 'insert') === 1,
    `RETRY dieselbe Kennung: replayed, genau EINE Aufgabe, EIN Abgleich-Eintrag (${S([a.replayed, b.replayed, count()])})`);
  const tid = String(a.value.taskId);
  const k = await update('111', { taskId: tid, expectedRevision: 1, status: 'completed' });
  const k2 = await update('111', { taskId: tid, expectedRevision: 1, status: 'completed' });
  const doneAt = s(db, 'SELECT completed_at FROM tasks WHERE id = ?', [tid]);
  ok(k.ok && k2.ok && k2.replayed && n(db, 'SELECT revision FROM tasks WHERE id = ?', [tid]) === 2 && cl(db, 'tasks', 'update') === 1,
    'RETRY „Complete" zweimal mit derselben Kennung: einmal erledigt, Fassung 2, ein Eintrag');

  // Alte Fassung.
  const vorCl = cl(db, 'tasks');
  const stale = await update('112', { taskId: tid, expectedRevision: 1, title: 'overwrite' });
  ok(!stale.ok && stale.code === 'RECORD_CHANGED' && stale.frozen && s(db, 'SELECT title FROM tasks WHERE id = ?', [tid]) === 'Call Ali back'
    && cl(db, 'tasks') === vorCl, `STALE alte Fassung → RECORD_CHANGED, nichts geschrieben (${stale.code})`);
  const noRev = await update('113', { taskId: tid, title: 'x' });
  ok(noRev.thrown && noRev.code === 'OFFICE_PAYLOAD_INVALID' && /expectedRevision is required/.test(noRev.message) && frei(db, '113', 'tasks.update'),
    'STALE ohne Fassung gibt es kein Ändern — und die Kennung bleibt frei (kein Urteil)');

  // Übergänge: „Complete" nur aus open/in_progress; wieder öffnen leert den Zeitpunkt.
  const again = await update('114', { taskId: tid, expectedRevision: 2, status: 'completed' });
  ok(again.ok && again.value.changed === false && s(db, 'SELECT completed_at FROM tasks WHERE id = ?', [tid]) === doneAt,
    'TRANSITION erledigt → erledigt ändert nichts (kein neuer Zeitstempel mehr)');
  const reopen = await update('115', { taskId: tid, expectedRevision: 2, status: 'open' });
  ok(reopen.ok && s(db, 'SELECT status FROM tasks WHERE id = ?', [tid]) === 'open' && one(db, 'SELECT completed_at FROM tasks WHERE id = ?', [tid]) === null,
    'TRANSITION wieder öffnen: Status open, Zeitpunkt des Erledigens geleert');
  const cancel = await update('116', { taskId: tid, expectedRevision: 3, status: 'cancelled' });
  const kc = await update('117', { taskId: tid, expectedRevision: 4, status: 'completed' });
  ok(cancel.ok && !kc.ok && kc.code === 'TASK_INVALID_TRANSITION' && kc.frozen && s(db, 'SELECT status FROM tasks WHERE id = ?', [tid]) === 'cancelled',
    `TRANSITION eine abgebrochene Aufgabe wird nicht „erledigt" (${kc.code})`);

  // Fremde Filiale, fremder Ausweis.
  insert(db, 'tasks', { id: 't-x', branch_id: 'branch-other', title: 'Fremd', created_at: NOW });
  const fremd = await update('118', { taskId: 't-x', expectedRevision: 1, title: 'mine now' });
  ok(!fremd.ok && fremd.code === 'TASK_NOT_FOUND' && s(db, "SELECT title FROM tasks WHERE id = 't-x'") === 'Fremd',
    `FOREIGN eine Aufgabe einer fremden Filiale gibt es nicht (${fremd.code})`);
  const falscheFiliale = await create('119', taskHouse.taskCreateBody(FORM), { branchId: 'branch-other' });
  ok(!falscheFiliale.ok && falscheFiliale.code === 'BRANCH_MISMATCH' && count() === 2, `FOREIGN Ausweis einer anderen Filiale → BRANCH_MISMATCH (${falscheFiliale.code})`);

  // Zuweisung: nur aktive Benutzer DIESER Filiale.
  const fremdUser = await create('120', { title: 'x', assignedTo: 'user-other' });
  const inaktiv = await create('121', { title: 'x', assignedTo: 'user-off' });
  const erfunden = await create('122', { title: 'x', assignedTo: 'user-ghost' });
  const gut = await create('123', { title: 'assigned', assignedTo: 'user-pc2' });
  ok(fremdUser.code === 'TASK_ASSIGNEE_NOT_FOUND' && inaktiv.code === 'TASK_ASSIGNEE_NOT_FOUND' && erfunden.code === 'TASK_ASSIGNEE_NOT_FOUND'
    && gut.ok && s(db, "SELECT assigned_to FROM tasks WHERE title = 'assigned'") === 'user-pc2',
  `ASSIGNEE fremde Filiale / inaktiv / unbekannt → nein; ein Benutzer der Filiale → ja (${S([fremdUser.code, inaktiv.code, erfunden.code, gut.code || 'ok'])})`);
  const umhaengen = await update('124', { taskId: String(gut.value.taskId), expectedRevision: 1, assignedTo: 'user-other' });
  ok(umhaengen.code === 'TASK_ASSIGNEE_NOT_FOUND', 'ASSIGNEE …auch beim Ändern');

  // Verknüpfung: nur in DIESER Filiale.
  const lf = await create('125', { title: 'x', linkedEntityType: 'customer', linkedEntityId: 'cust-x' });
  const lp = await create('126', { title: 'x', linkedEntityType: 'product', linkedEntityId: 'p-foreign' });
  const lt = await create('127', { title: 'x', linkedEntityType: 'spaceship', linkedEntityId: 'p1' });
  const li = await create('128', { title: 'x', linkedEntityId: 'p1' });
  const lok = await create('129', { title: 'linked', linkedEntityType: 'product', linkedEntityId: 'p1' });
  ok(lf.code === 'LINKED_ENTITY_NOT_FOUND' && lp.code === 'LINKED_ENTITY_NOT_FOUND' && lt.code === 'LINK_INVALID' && li.code === 'LINK_INVALID' && lok.ok,
    `LINK fremder Kunde / fremder Artikel / unbekannte Art / Kennung ohne Art → nein (${S([lf.code, lp.code, lt.code, li.code, lok.code || 'ok'])})`);

  // Autorität: was der Primary entscheidet, nennt kein Rumpf.
  const spoof: Array<[string, unknown]> = [['createdBy', 'user-test'], ['created_by', 'user-test'], ['userId', 'user-test'], ['actor', 'user-test'],
    ['id', 'x'], ['branchId', 'branch-other'], ['status', 'completed'], ['completedAt', NOW], ['autoGenerated', true],
    ['revision', 9], ['createdAt', NOW], ['tenantId', 't']];
  const vorN = count();
  for (const [k1, v] of spoof) {
    const r = await create('13' + k1.length + k1.charCodeAt(0), { title: 'spoof', [k1]: v });
    ok(r.thrown && r.code === 'OFFICE_PAYLOAD_INVALID' && r.message === `the primary decides ${k1}, not the client`,
      `AUTHORITY create: ${k1} → „the primary decides" (${r.message})`);
  }
  for (const [k1, v] of spoof.filter(([k2]) => k2 !== 'status')) {
    const r = await update('14' + k1.length + k1.charCodeAt(0), { taskId: tid, expectedRevision: 4, [k1]: v });
    ok(r.thrown && /the primary decides/.test(r.message), `AUTHORITY update: ${k1} → „the primary decides"`);
  }
  ok(count() === vorN, 'AUTHORITY kein einziger gefälschter Rumpf hat eine Zeile angelegt');
  // R7A (PP-11) — `notes` ist seit R7A ein Feld der Maske; ein wirklich unbekanntes bleibt ein Nein.
  const unbekannt = await create('150', { title: 'x', colour: 'red' });
  ok(unbekannt.thrown && unbekannt.message === 'unknown field: colour', 'AUTHORITY ein unbekanntes Feld wird abgewiesen statt ignoriert');

  // Vokabular und Form.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ title: 'x', status: 'done' }, 'TASK_STATUS_INVALID'],
    [{ title: 'x', priority: 'critical' }, 'TASK_PRIORITY_INVALID'],
    [{ title: 'x', type: 'party' }, 'TASK_TYPE_INVALID'],
    [{ title: 'x', dueAt: '2026-02-30' }, 'TASK_DUE_INVALID'],
    [{ title: 'x', dueAt: '2026-09-20T10:00' }, 'TASK_DUE_INVALID'],
    [{ title: 'x', dueAt: 'tomorrow' }, 'TASK_DUE_INVALID'],
    [{ title: '   ' }, 'TASK_TITLE_REQUIRED'],
    [{ title: 'x', description: 42 }, 'TASK_FIELD_INVALID'],
  ];
  for (const [body, code] of cases) {
    const r = await update('16' + code.length + S(body).length, { taskId: tid, expectedRevision: 4, ...body });
    ok(r.thrown && r.code === code, `VOCAB ${S(body)} → ${code} (${r.code})`);
  }
  ok(frei(db, '1' + '6' + 'TASK_STATUS_INVALID'.length + S({ title: 'x', status: 'done' }).length, 'tasks.update'),
    'VOCAB ein Rumpffehler friert nichts ein');

  // Fehlerinjektion: Zeile, Abgleich, Protokoll — jedes Mal alles oder nichts.
  for (const pattern of [/INSERT INTO tasks/, /INSERT INTO sync_changelog/, /INSERT INTO audit_log/]) {
    const vor = [count(), cl(db, 'tasks'), audits(db, 'tasks')];
    const { db: bad, f } = faulty(db, pattern);
    setTestDatabase(bad as never);
    const r = await fern(() => office.runTaskCreate(deps(bad), identity('170', 'tasks.create'), { title: 'boom' }));
    const p = await primary(() => taskStore.createTaskOnPrimary({ title: 'boom' }));
    f.armed = false;
    setTestDatabase(db as never);
    ok(r.thrown && !p.ok && S([count(), cl(db, 'tasks'), audits(db, 'tasks')]) === S(vor) && frei(db, '170', 'tasks.create'),
      `INJECT create ${pattern}: fern und lokal ganz zurück, nichts eingefroren (${r.code} / ${p.code})`);
  }
  const t2 = String(gut.value.taskId);
  for (const pattern of [/UPDATE tasks SET/, /INSERT INTO sync_changelog/, /INSERT INTO audit_log/]) {
    const vor = [row(db, 'SELECT status, revision, completed_at FROM tasks WHERE id = ?', [t2]), cl(db, 'tasks'), audits(db, 'tasks')];
    const { db: bad, f } = faulty(db, pattern);
    setTestDatabase(bad as never);
    const r = await fern(() => office.runTaskUpdate(deps(bad), identity('171', 'tasks.update'), { taskId: t2, expectedRevision: 1, status: 'completed' }));
    const p = await primary(() => taskStore.updateTaskOnPrimary({ taskId: t2, expectedRevision: 1, status: 'completed' }));
    f.armed = false;
    setTestDatabase(db as never);
    ok(r.thrown && !p.ok && S([row(db, 'SELECT status, revision, completed_at FROM tasks WHERE id = ?', [t2]), cl(db, 'tasks'), audits(db, 'tasks')]) === S(vor),
      `INJECT complete ${pattern}: Status, Fassung, Abgleich, Protokoll unverändert (${r.code} / ${p.code})`);
  }
  ok(lc(db) === 0, 'LEDGER keine Buchung');

  // Der angemeldete Befehl (Registry → execute → runRemoteCommand), wie Rust ihn aufruft.
  const actor = (x: string) => ({ commandId: ID(x), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', payloadHash: 'h' + x, role: 'SALES' });
  const via = await registry.executeCommand('tasks.create', { title: 'via registry' }, actor('190') as never) as { kind: string; value?: Record<string, unknown> };
  const viaBad = await registry.executeCommand('tasks.create', { title: 'x', created_by: 'user-test' }, actor('191') as never) as { kind: string; code?: string };
  ok(via.kind === 'ok' && via.value?.replayed === false && typeof via.value?.taskId === 'string'
    && viaBad.kind === 'business_error' && viaBad.code === 'OFFICE_PAYLOAD_INVALID',
  `REGISTRY der angemeldete Befehl: ok mit replayed; ein gefälschter Urheber ist ein fachliches Nein (${S([via.kind, viaBad.code])})`);

  // Die alten Store-Aufrufe laufen durch dasselbe Haus.
  const st = taskStore.useTaskStore.getState();
  const legacy = st.createTask({ title: 'legacy', notes: 'dropped' });
  ok(legacy.revision === 1 && s(db, 'SELECT created_by FROM tasks WHERE id = ?', [legacy.id]) === 'user-test' && cl(db, 'tasks', 'insert') >= 1,
    'LEGACY createTask läuft durch das Haus (Fassung, Urheber, Abgleich)');
  const wrongStatus = wirft(() => st.updateTask(legacy.id, { status: 'bogus' as never }));
  st.completeTask(legacy.id);
  const doppelt = wirft(() => st.updateTask(legacy.id, { status: 'cancelled' }));
  ok(wrongStatus === 'TASK_STATUS_INVALID' && s(db, 'SELECT status FROM tasks WHERE id = ?', [legacy.id]) === 'cancelled' && doppelt === '',
    `LEGACY updateTask prüft das Vokabular; completeTask/updateTask schreiben über das Haus (${wrongStatus})`);
  const fremdLegacy = wirft(() => st.completeTask('t-x'));
  ok(fremdLegacy === 'TASK_NOT_FOUND' && s(db, "SELECT status FROM tasks WHERE id = 't-x'") !== 'completed',
    'LEGACY BEFUND behoben: completeTask traf vorher `WHERE id = ?` auch eine fremde Filiale');
}

// ══ §4 — Aufgaben: Client + Oberfläche ═══════════════════════════════════════
async function imClient(fn: (touched: () => number, calls: Array<{ body: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const db = freshDb();
  let touched = 0;
  const counting = new Proxy(db as object, {
    get(t, k) {
      const v = (t as Record<string | symbol, unknown>)[k];
      if (k === 'run' || k === 'exec') return (...a: unknown[]) => { touched++; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  setTestDatabase(counting as never);
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    calls.push({ body: JSON.parse(init.body) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, value: { replayed: false } }), { status: 200 });
  }) as never;
  try {
    await fn(() => touched, calls);
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
const write = (op: string) => new CommandSaveController<Record<string, unknown>>(op).beginAttempt();
await imClient(async (touched, calls) => {
  const a = await primary(() => taskStore.createTaskOnPrimary(taskHouse.taskCreateBody(FORM)));
  const b = await primary(() => taskStore.updateTaskOnPrimary({ taskId: 't1', expectedRevision: 1, status: 'completed' }));
  const c = wirft(() => taskStore.useTaskStore.getState().createTask({ title: 'x' }));
  const d = wirft(() => taskStore.useTaskStore.getState().completeTask('t1'));
  const e = wirft(() => taskHouse.createTaskInHouse({ title: 'x' }, { branchId: 'branch-main', userId: 'u' }));
  ok(a.code === 'TASK_PRIMARY_ONLY' && b.code === 'TASK_PRIMARY_ONLY' && c === 'TASK_PRIMARY_ONLY' && d === 'TASK_PRIMARY_ONLY' && e === 'TASK_PRIMARY_ONLY' && touched() === 0,
    `CLIENT jeder Aufgaben-Anschluss verweigert, bevor er eine Datenbank anfasst (${S([a.code, b.code, c, d, e])}, Zugriffe ${touched()})`);
  const r1 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => taskHouse.taskCreateBody(FORM) }, write('tasks.create'));
  const r2 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => taskHouse.taskCompleteBody({ id: 't-pc2', revision: 5 }) }, write('tasks.update'));
  const s1 = calls.find((x) => x.body.op === 'tasks.create');
  const s2 = calls.find((x) => x.body.op === 'tasks.update');
  ok(r1.kind === 'ok' && r2.kind === 'ok' && !!s1 && !!s2
    && S(Object.keys(s1.body.payload as object).sort()) === S(['description', 'dueAt', 'linkedEntityId', 'linkedEntityType', 'notes', 'priority', 'title', 'type'])
    && S(s2.body.payload) === S({ taskId: 't-pc2', expectedRevision: 5, status: 'completed' }) && touched() === 0,
  `CLIENT je EIN geprüfter Auftrag, ohne Urheber, Zeitpunkt oder Filiale — keine lokale Wirkung (${S(s1?.body.payload)} · ${S(s2?.body.payload)})`);
});
{
  const tl = codeOf(src('src/pages/tasks/TaskList.tsx'));
  ok(/w\.ok\('tasks\.create', \{\s*local: \(\) => createTaskOnPrimary\(taskCreateBody\(form\)\),\s*remote: \(\) => taskCreateBody\(form\)/.test(tl),
    'UI TaskList: „Create Task" über die gemeinsame Weiche, derselbe Rumpf auf beiden Wegen');
  ok(/w\.ok\('tasks\.update', \{\s*local: \(\) => updateTaskOnPrimary\(taskUpdateBody\(t, form\)\),\s*remote: \(\) => taskUpdateBody\(t, form\)/.test(tl),
    'UI TaskList: „Save Changes" mit der gesehenen Fassung');
  ok(/local: \(\) => updateTaskOnPrimary\(taskCompleteBody\(task\)\),\s*remote: \(\) => taskCompleteBody\(task\)/.test(tl),
    'UI TaskList: „Complete" ist tasks.update mit Zielstatus');
  ok(!/\b(createTask|updateTask|completeTask)\(/.test(tl), 'UI TaskList: keine Store-Aktion mehr direkt');
  ok(/if \(await onSave\(form\)\) onClose\(\)/.test(tl) && /disabled=\{!form\.title\.trim\(\) \|\| busy\}/.test(tl),
    'UI TaskList: die Maske schließt erst nach dem Speichern, gesperrt während des Laufs');
  for (const h of ['data-task-new', 'data-task-title', 'data-task-description', 'data-task-type', 'data-task-priority', 'data-task-due',
    'data-task-link-type', 'data-task-link-id', 'data-task-save', 'data-task-complete', 'data-task-edit']) {
    ok(tl.includes(h), `UI TaskList: ${h}`);
  }
  const ts = codeOf(src('src/stores/taskStore.ts'));
  ok(!/INSERT INTO tasks|UPDATE tasks SET|branch-main/.test(ts) && /createTaskInHouse\(/.test(ts) && /updateTaskInHouse\(/.test(ts),
    'DOMAIN taskStore schreibt Anlegen/Ändern nicht mehr selbst, kein stilles branch-main');
}
marker('CENTRAL_UI_R6F_TASKS_PROVED');

// ══ §5 — Upload: Primary == PC2, Grenzen, Typ, Name, Verknüpfung ═════════════
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
const dataUrl = (mime: string, u: Uint8Array): string => `data:${mime};base64,${b64(u)}`;
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const PNG_URL = dataUrl('image/png', PNG);
const UP = { fileName: 'receipt.png', content: PNG_URL, docClass: 'receipt', linkedEntityType: 'customer', linkedEntityId: 'cust-1' };
const upBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...docHouse.documentUploadBody(UP), ...over });
const docRow = (db: Db, id?: string): Record<string, unknown> =>
  id ? row(db, 'SELECT * FROM documents WHERE id = ?', [id]) : row(db, 'SELECT * FROM documents ORDER BY created_at LIMIT 1');
{
  const dbP = freshDb();
  const p = await primary(() => docStore.uploadDocumentOnPrimary(upBody()));
  const rp = docRow(dbP);
  const dbR = freshDb();
  const r = await fern(() => office.runDocumentUpload(deps(dbR), identity('201', 'documents.upload'), upBody()));
  const rr = docRow(dbR);
  ok(p.ok && r.ok, `PARITY beide Wege laden hoch (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = unterschiede(ohne(rp, ['created_by']), ohne(rr, ['created_by']));
  ok(diff.length === 0, `PARITY lokal == fern (${diff.join(' · ') || 'gleich'})`);
  ok(rr.file_type === 'image/png' && Number(rr.file_size) === PNG.length && rr.file_path === PNG_URL && rr.file_name === 'receipt.png'
    && rr.doc_class === 'receipt' && rr.branch_id === 'branch-main' && Number(rr.revision) === 1 && Number(rr.ocr_reviewed) === 0,
  `UPLOAD Typ und Größe aus dem Inhalt, file_path bleibt die Data-URL, Fassung 1 (${S([rr.file_type, rr.file_size, rr.revision])})`);
  ok(rp.created_by === 'user-test' && rr.created_by === 'user-pc2', `ACTOR lokal die Sitzung, fern der geprüfte Absender (${S([rp.created_by, rr.created_by])})`);
  const sync = row(dbR, "SELECT data FROM sync_changelog WHERE table_name = 'documents' AND action = 'insert'");
  ok(cl(dbR, 'documents', 'insert') === 1 && (JSON.parse(String(sync.data)) as { file_path?: string }).file_path === PNG_URL,
    'SYNC ein Abgleich-Eintrag mit der vollständigen Zeile (samt Inhalt)');
  ok(S(Object.keys(r.value).sort()) === S(['documentId', 'fileSize', 'fileType', 'revision']) && r.value.documentId === rr.id,
    `RESULT klein, ohne Inhalt (${S(r.value)})`);
  const lesen = docStore.documentContentFor({ tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', role: 'SALES' } as never, String(rr.id));
  ok(lesen?.content === PNG_URL, 'READ PC2 liest den Inhalt über die vorhandene Auskunft documents.content.get');

  // Verlorene Antwort.
  const again = await fern(() => office.runDocumentUpload(deps(dbR), identity('201', 'documents.upload'), upBody()));
  ok(again.ok && again.replayed && again.value.documentId === rr.id && n(dbR, 'SELECT COUNT(*) FROM documents') === 1 && cl(dbR, 'documents', 'insert') === 1,
    'RETRY dieselbe Kennung: replayed, genau EIN Dokument, EIN Abgleich-Eintrag');
  ok(lc(dbP) === 0 && lc(dbR) === 0, 'LEDGER Dokumente buchen nichts');
}
{
  const db = freshDb();
  const up = (x: string, body: Record<string, unknown>) => fern(() => office.runDocumentUpload(deps(db), identity(x, 'documents.upload'), body));
  const count = (): number => n(db, 'SELECT COUNT(*) FROM documents');

  // Die Grenze — aus dem Manifest, nicht erfunden.
  const LIMIT = docHouse.DOCUMENT_ROW_LIMIT_BYTES;
  ok(LIMIT === MANIFEST.limits.max_payload_bytes && LIMIT === 33554432
    && docHouse.DOCUMENT_MAX_FILE_BYTES === Math.floor((LIMIT - docHouse.DOCUMENT_ROW_RESERVE_BYTES) / 4) * 3,
  `LIMIT die Grenze ist die des Abgleich-Manifests (${LIMIT}), die Datei höchstens ⌊(Grenze − Reserve)/4⌋×3 = ${docHouse.DOCUMENT_MAX_FILE_BYTES}`);
  const PREFIX = 'data:application/octet-stream;base64,';
  const huge = await up('210', upBody({ fileName: 'huge.bin', content: PREFIX + 'A'.repeat(LIMIT) }));
  ok(huge.thrown && huge.code === 'DOCUMENT_TOO_LARGE' && count() === 0 && frei(db, '210', 'documents.upload'),
    `LIMIT Inhalt über der Grenze → DOCUMENT_TOO_LARGE vor jeder Arbeit, nichts eingefroren (${huge.code})`);
  let k = LIMIT - PREFIX.length; k -= k % 4;
  const knapp = await up('211', upBody({ fileName: 'nearly.bin', content: PREFIX + 'A'.repeat(k) }));
  ok(knapp.thrown && knapp.code === 'DOCUMENT_TOO_LARGE' && frei(db, '211', 'documents.upload') && count() === 0 && cl(db, 'documents') === 0,
    `LIMIT Base64 bis an die Zeilengrenze: die Datei ist größer als erlaubt → nein vor jeder Arbeit (${knapp.code})`);
  const mb = await up('212', upBody({ fileName: 'one-mb.bin', content: PREFIX + 'A'.repeat(1_048_576) }));
  ok(mb.ok && mb.value.fileSize === 786432 && mb.value.fileType === 'application/octet-stream', `LIMIT 1 MiB Base64 → 768 KiB Datei, angenommen (${S(mb.value)})`);

  // Typ gegen Inhalt.
  const mism: Array<[string, Uint8Array]> = [['image/png', PDF], ['application/pdf', PNG], ['image/jpeg', PNG], ['image/tiff', PDF]];
  for (const [mime, bytes] of mism) {
    const r = await up('22' + mime.length + bytes.length, upBody({ content: dataUrl(mime, bytes) }));
    ok(r.thrown && r.code === 'DOCUMENT_TYPE_MISMATCH', `TYPE ${mime} mit fremdem Inhalt → DOCUMENT_TYPE_MISMATCH (${r.code})`);
  }
  const oct = await up('230', upBody({ fileName: 'scan', content: dataUrl('application/octet-stream', PNG) }));
  const txt = await up('231', upBody({ fileName: 'note.txt', content: dataUrl('text/plain', new TextEncoder().encode('BMW report 2026')) }));
  const ai = await up('232', upBody({ fileName: 'logo.ai', content: dataUrl('application/postscript', PDF) }));
  // MEDIA-DOCUMENTS — eine PDF geht seither NICHT mehr als Data-URL durch diese Tuer: sie gehoert
  // byte-genau in den Medienspeicher, und der Rumpf nennt nur ihre Kennung. Beweise in
  // test/media-documents/document-pdf.
  const pdf = await up('233', upBody({ fileName: 'cert.pdf', content: dataUrl('application/pdf', PDF), docClass: 'certificate' }));
  ok(oct.ok && oct.value.fileType === 'image/png' && txt.ok && txt.value.fileType === 'text/plain' && ai.ok && ai.value.fileType === 'application/postscript'
    && pdf.thrown && pdf.code === 'DOCUMENT_CONTENT_INVALID',
  `TYPE unbekannter Typ mit Bildinhalt wird Bild; Text und Illustrator bleiben; eine PDF gehoert in den Medienspeicher (${S([oct.value.fileType, txt.value.fileType, ai.value.fileType, pdf.code])})`);

  // Kein Pfad, kein kaputter Inhalt.
  for (const content of ['C:\\docs\\x.pdf', 'file:///etc/passwd', '/etc/passwd', 'data:image/png,rawbytes', 'data:image/png;base64,@@@@', 'data:image/png;base64,abc', 42]) {
    const r = await up('24' + String(content).length, upBody({ content }));
    ok(r.thrown && r.code === 'DOCUMENT_CONTENT_INVALID', `CONTENT ${S(content)} → DOCUMENT_CONTENT_INVALID (${r.code})`);
  }
  // Der Name: keine Trenner, keine Steuerzeichen, kein Ausbruch, höchstens 255 Zeichen.
  for (const fileName of ['../evil.pdf', 'dir/evil.pdf', 'dir\\evil.pdf', '..\\..\\win.ini', 'evil\u0000.pdf', 'a\nb.pdf', '..', '.', '', '   ', 'x'.repeat(256)]) {
    const r = await up('25' + fileName.length + fileName.charCodeAt(0), upBody({ fileName }));
    ok(r.thrown && r.code === 'DOCUMENT_NAME_INVALID', `NAME ${S(fileName.slice(0, 20))} → DOCUMENT_NAME_INVALID (${r.code})`);
  }
  const trim = await up('260', upBody({ fileName: '  receipt 2026.png ' }));
  const lang = await up('261', upBody({ fileName: 'x'.repeat(255) }));
  ok(trim.ok && s(db, 'SELECT file_name FROM documents WHERE id = ?', [String(trim.value.documentId)]) === 'receipt 2026.png' && lang.ok,
    'NAME getrimmt; 255 Zeichen sind erlaubt');
  const cls = await up('262', upBody({ docClass: 'secret' }));
  ok(cls.thrown && cls.code === 'DOCUMENT_CLASS_INVALID', `CLASS nur die Klassen der Maske (${cls.code})`);

  // Autorität.
  for (const [k1, v] of [['filePath', 'C:\\x'], ['file_path', 'x'], ['fileType', 'image/png'], ['fileSize', 1], ['createdBy', 'user-test'],
    ['created_by', 'user-test'], ['userId', 'u'], ['id', 'd'], ['branchId', 'branch-other'], ['ocrText', 't'], ['revision', 3], ['status', 'x']] as Array<[string, unknown]>) {
    const r = await up('27' + k1.length + k1.charCodeAt(0), upBody({ [k1]: v }));
    ok(r.thrown && r.message === `the primary decides ${k1}, not the client`, `AUTHORITY upload: ${k1} → „the primary decides" (${r.message})`);
  }

  // Verknüpfung: nur in DIESER Filiale.
  const vor = count();
  const lf = await up('280', upBody({ linkedEntityType: 'customer', linkedEntityId: 'cust-x' }));
  const lp = await up('281', upBody({ linkedEntityType: 'product', linkedEntityId: 'p-foreign' }));
  const lt = await up('282', upBody({ linkedEntityType: 'spaceship', linkedEntityId: 'p1' }));
  const li = await up('283', upBody({ linkedEntityType: null, linkedEntityId: 'p1' }));
  const lok = await up('284', upBody({ linkedEntityType: 'product', linkedEntityId: 'p1' }));
  ok(lf.code === 'LINKED_ENTITY_NOT_FOUND' && lf.frozen && lp.code === 'LINKED_ENTITY_NOT_FOUND' && lt.code === 'LINK_INVALID' && li.code === 'LINK_INVALID'
    && lok.ok && count() === vor + 1,
  `LINK fremder Kunde / fremder Artikel / unbekannte Art / Kennung ohne Art → nein; eigener Artikel → ja (${S([lf.code, lp.code, lt.code, li.code])})`);
  const falscheFiliale = await fern(() => office.runDocumentUpload(deps(db), identity('285', 'documents.upload', { branchId: 'branch-other' }), upBody()));
  ok(falscheFiliale.code === 'BRANCH_MISMATCH', 'FOREIGN Ausweis einer anderen Filiale → BRANCH_MISMATCH');

  // Fehlerinjektion.
  for (const pattern of [/INSERT INTO documents/, /INSERT INTO sync_changelog/, /INSERT INTO audit_log/]) {
    const v = [count(), cl(db, 'documents'), audits(db, 'documents')];
    const { db: bad, f } = faulty(db, pattern);
    setTestDatabase(bad as never);
    const r = await fern(() => office.runDocumentUpload(deps(bad), identity('290', 'documents.upload'), upBody()));
    const p = await primary(() => docStore.uploadDocumentOnPrimary(upBody()));
    f.armed = false;
    setTestDatabase(db as never);
    ok(r.thrown && !p.ok && S([count(), cl(db, 'documents'), audits(db, 'documents')]) === S(v) && frei(db, '290', 'documents.upload'),
      `INJECT upload ${pattern}: fern und lokal ganz zurück (${r.code} / ${p.code})`);
  }
  ok(lc(db) === 0, 'LEDGER keine Buchung');
}

// ══ §5b — Größenvertrag: Datei → Base64 → Zeile → Push-Umschlag → 32-MiB-Grenze ═════
{
  const { changeContractViolation } = await import('../../src/core/sync/apply-change.ts');
  const pb = await import('../../src/core/sync/push-batch.ts');
  const LIMIT = docHouse.DOCUMENT_ROW_LIMIT_BYTES;
  const MAX = docHouse.DOCUMENT_MAX_FILE_BYTES;
  const RES = docHouse.DOCUMENT_ROW_RESERVE_BYTES;
  const bytes = (t: string): number => Buffer.byteLength(t, 'utf8');
  ok(RES === 65536 && MAX === 25116672 && MAX % 3 === 0 && (MAX / 3) * 4 + RES === LIMIT,
    `SIZE abgeleitet: ⌊(${LIMIT} − ${RES}) / 4⌋ × 3 = ${MAX} Bytes — ihr Base64 plus Reserve ist genau die Grenze`);

  // Die längsten Angaben, die das Haus zulässt: Kopf 512 Zeichen (Typ 255 + Parameter), Name 255 Zeichen
  // zu je 4 Bytes, Verknüpfung auf eine Kennung von 255 Zeichen.
  const LINK = 'P'.repeat(docHouse.DOCUMENT_LINK_ID_MAX);
  const mitLink = (db: Db): void => {
    db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition,
        scope_of_delivery, purchase_price, purchase_currency, planned_sale_price, stock_status,
        tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
      VALUES (?,'branch-main','cat-w','Rolex','Lang','SKU-LANG',1,'Pre-Owned','[]',100,'BHD',150,'in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [LINK, NOW, NOW]);
  };
  const HEAD = `data:${'x'.repeat(127)}/${'y'.repeat(127)};p=${'v'.repeat(119)};q=${'v'.repeat(119)};base64,`;
  const B64 = 'A'.repeat((MAX / 3) * 4);
  const NAME = '\u{1F600}'.repeat(docHouse.DOCUMENT_NAME_MAX);
  const maxBody = upBody({ fileName: NAME, content: HEAD + B64, docClass: 'certificate', linkedEntityType: 'product', linkedEntityId: LINK });
  const PLUS = 'data:application/octet-stream;base64,' + B64 + 'AA==';
  ok(HEAD.length === docHouse.DOCUMENT_DATA_URL_HEADER_MAX && bytes(NAME) === 1020, `SIZE Prüfling: Kopf ${HEAD.length} Zeichen, Name ${bytes(NAME)} Bytes`);

  const db = freshDb();
  mitLink(db);
  const up = (x: string, body: Record<string, unknown>) => fern(() => office.runDocumentUpload(deps(db), identity(x, 'documents.upload'), body));
  const counts = (): string => S([n(db, 'SELECT COUNT(*) FROM documents'), cl(db, 'documents'), audits(db, 'documents')]);

  // Knapp unter / genau am Maximum: angenommen, und der echte Transport hält.
  const r = await up('500', maxBody);
  const id = String(r.value.documentId);
  const data = s(db, "SELECT data FROM sync_changelog WHERE table_name = 'documents' AND action = 'insert' AND record_id = ?", [id]);
  const rowBytes = bytes(data);
  ok(r.ok && r.value.fileSize === MAX && rowBytes <= LIMIT,
    `SIZE die größte Datei (${MAX} B) mit den längsten Angaben wird angenommen — ihre Abgleich-Zeile ${rowBytes} ≤ ${LIMIT} B (${r.code || 'ok'})`);
  const platz = LIMIT - rowBytes;
  ok(platz >= 60 * 1024, `SIZE daneben bleiben ${platz} B für den erkannten Text (≥ 60 KiB)`);
  ok(changeContractViolation('documents', 'insert', data) === null, 'SIZE der Empfänger (apply-change) nimmt genau diese Zeile an');
  const change = { table_name: 'documents', record_id: id, action: 'insert', data };
  const umschlag = bytes(pb.pushBody([change]));
  ok(umschlag <= pb.SYNC_PUSH_BODY_LIMIT_BYTES, `SIZE ihr Push-Umschlag ${umschlag} B ≤ ${pb.SYNC_PUSH_BODY_LIMIT_BYTES} B (Körpergrenze des Primary)`);
  const dbP = freshDb();
  mitLink(dbP);
  const pOk = await primary(() => docStore.uploadDocumentOnPrimary(maxBody));
  ok(pOk.ok && pOk.value.fileSize === MAX, `SIZE am Primary dieselbe Annahme (${pOk.code || 'ok'})`);
  setTestDatabase(db as never);

  // Ein Byte mehr: klar abgewiesen, vor jeder Arbeit, kein Teil-Dokument.
  const vor = counts();
  const plus = await up('501', upBody({ fileName: 'plus-one.bin', content: PLUS }));
  ok(plus.thrown && plus.code === 'DOCUMENT_TOO_LARGE' && plus.message.includes(`${MAX + 1} bytes; at most ${MAX}`)
    && frei(db, '501', 'documents.upload') && counts() === vor,
  `SIZE ein Byte mehr → DOCUMENT_TOO_LARGE mit beiden Zahlen, vor jeder Arbeit: kein Dokument, kein Abgleich, kein Protokoll (${plus.message})`);
  const pNo = await primary(() => docStore.uploadDocumentOnPrimary(upBody({ fileName: 'plus-one.bin', content: PLUS })));
  ok(pNo.code === 'DOCUMENT_TOO_LARGE' && counts() === vor, `SIZE am Primary dieselbe Absage, nichts geschrieben (${pNo.code})`);
  const h513 = await up('502', upBody({ content: HEAD.replace(';base64,', 'v;base64,') + 'AAAA' }));
  const l256 = await up('503', upBody({ linkedEntityType: 'product', linkedEntityId: LINK + 'P' }));
  ok(h513.code === 'DOCUMENT_CONTENT_INVALID' && l256.code === 'LINK_INVALID' && frei(db, '502', 'documents.upload') && frei(db, '503', 'documents.upload') && counts() === vor,
    `SIZE Kopf 513 Zeichen / Verknüpfung 256 Zeichen → nein vor jeder Arbeit (${S([h513.code, l256.code])})`);

  // Der erkannte Text (nur an Bildern): ein Bild der größten Größe mit dem längsten Kopf, Namen und
  // Verknüpfung nimmt 60 KiB Text auf; einer, der die Zeile ein Byte über die Grenze brächte, wird von
  // der exakten Zeilenregel abgewiesen — nichts geschrieben, der alte Text bleibt.
  const IMG_HEAD = `data:image/png;p=${'v'.repeat(119)};q=${'v'.repeat(119)};r=${'v'.repeat(119)};s=${'v'.repeat(121)};base64,`;
  const IMG = IMG_HEAD + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]).toString('base64') + 'A'.repeat(((MAX - 9) / 3) * 4);
  const bild = await up('506', upBody({ fileName: NAME, content: IMG, linkedEntityType: 'product', linkedEntityId: LINK }));
  const bid = String(bild.value.documentId);
  ok(IMG_HEAD.length === docHouse.DOCUMENT_DATA_URL_HEADER_MAX && bild.ok && bild.value.fileSize === MAX && bild.value.fileType === 'image/png',
    `SIZE das größte Bild (PNG, ${MAX} B, Kopf ${IMG_HEAD.length}) wird angenommen (${bild.code || 'ok'})`);
  const TXT = 'T'.repeat(60 * 1024);
  const o1 = await fern(() => office.runDocumentOcr(deps(db), identity('504', 'documents.set_ocr'), { documentId: bid, expectedRevision: 1 }, async () => ({ text: TXT, confidence: 90 })));
  const d1 = s(db, "SELECT data FROM sync_changelog WHERE table_name = 'documents' AND action = 'update' AND record_id = ?", [bid]);
  ok(o1.ok && o1.value.stored === true && bytes(d1) > TXT.length && bytes(d1) <= LIMIT && changeContractViolation('documents', 'update', d1) === null,
    `SIZE das größte Bild nimmt 60 KiB erkannten Text auf, der Empfänger nimmt die Zeile an (${bytes(d1)} ≤ ${LIMIT}; ${o1.code || 'ok'})`);
  const zuLang = 'T'.repeat(TXT.length + (LIMIT - bytes(d1)) + 1);
  const o2 = await fern(() => office.runDocumentOcr(deps(db), identity('505', 'documents.set_ocr'), { documentId: bid, expectedRevision: 2 }, async () => ({ text: zuLang, confidence: 90 })));
  ok(!o2.ok && o2.code === 'DOCUMENT_TOO_LARGE' && n(db, 'SELECT revision FROM documents WHERE id = ?', [bid]) === 2
    && s(db, 'SELECT ocr_text FROM documents WHERE id = ?', [bid]) === TXT
    && n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'documents' AND action = 'update' AND record_id = ?", [bid]) === 1,
  `SIZE ein Text, der die Zeile 1 Byte über die Grenze brächte → DOCUMENT_TOO_LARGE, nichts geschrieben (${o2.code})`);

  // Dieselbe Serialisierung wie in Produktion: die Abgleich-Zeile IST `JSON.stringify(SELECT *)` —
  // genau das misst das Haus vor dem Quittieren.
  ok(data === JSON.stringify(row(db, 'SELECT * FROM documents WHERE id = ?', [id])) && d1 === JSON.stringify(row(db, 'SELECT * FROM documents WHERE id = ?', [bid])),
    'WIRE die Abgleich-Zeile (insert und update) ist Byte für Byte JSON.stringify(SELECT *) — dieselbe Serialisierung, die das Haus prüft');

  // Der Umschlag: ein Text voller Anführungszeichen hält die Zeile unter 32 MiB, bringt den Push-Rumpf
  // aber über 50 MiB (jedes `"` steht im Zeilen-JSON als `\"` und im Umschlag als `\\\"`).
  const dbQ = freshDb();
  const kl = await fern(() => office.runDocumentUpload(deps(dbQ), identity('510', 'documents.upload'), upBody()));
  const kid = String(kl.value.documentId);
  const QUOTES = '"'.repeat(13_500_000);
  const probe = JSON.stringify({ ...row(dbQ, 'SELECT * FROM documents WHERE id = ?', [kid]), ocr_text: QUOTES, ocr_confidence: 90, ocr_reviewed: 1, revision: 2 });
  const probeEnv = bytes(pb.pushBody([{ table_name: 'documents', record_id: kid, action: 'update', data: probe }]));
  ok(bytes(probe) <= LIMIT && probeEnv > pb.SYNC_PUSH_BODY_LIMIT_BYTES,
    `WIRE Prüfling: Zeile ${bytes(probe)} ≤ ${LIMIT} B, ihr Push-Umschlag ${probeEnv} > ${pb.SYNC_PUSH_BODY_LIMIT_BYTES} B`);
  const q1 = await fern(() => office.runDocumentOcr(deps(dbQ), identity('511', 'documents.set_ocr'), { documentId: kid, expectedRevision: 1 }, async () => ({ text: QUOTES, confidence: 90 })));
  ok(!q1.ok && q1.code === 'DOCUMENT_TOO_LARGE' && (q1.message === '' || /send to the primary/.test(q1.message))
    && n(dbQ, 'SELECT revision FROM documents WHERE id = ?', [kid]) === 1 && one(dbQ, 'SELECT ocr_text FROM documents WHERE id = ?', [kid]) === null
    && cl(dbQ, 'documents', 'update') === 0,
  `WIRE dieser Text → DOCUMENT_TOO_LARGE am Umschlag, nichts geschrieben, kein Abgleich-Eintrag (${q1.code}${q1.message ? ': ' + q1.message.slice(0, 70) : ''})`);
  ok(/assertRowSyncs\(id, 'insert'\);/.test(codeOf(src('src/core/office/document-house.ts'))) && /assertRowSyncs\(v\.documentId, 'update'\);/.test(codeOf(src('src/core/office/document-house.ts'))),
    'WIRE Upload und Texterkennung prüfen Zeile UND Umschlag, bevor sie quittieren');
}
marker('CENTRAL_UI_R6F_DOCUMENT_SIZE_CONTRACT_PINNED');
marker('CENTRAL_UI_R6F_DOCUMENT_WIRE_SIZE_PROVED');

// ══ §5c — Der Push nach Bytes: die ECHTE pushChanges gegen eine gestellte Gegenstelle ═══════════
{
  const sync = await import('../../src/core/sync/sync-service.ts');
  const pb = await import('../../src/core/sync/push-batch.ts');
  const LIMIT = pb.SYNC_PAYLOAD_LIMIT_BYTES, BODY = pb.SYNC_PUSH_BODY_LIMIT_BYTES;
  const bytes = (t: string): number => Buffer.byteLength(t, 'utf8');
  const db = freshDb();
  db.run('DELETE FROM sync_changelog');
  const add = (table: string, rid: string, action: string, data: string): number => {
    db.run('INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,?,?,?,0,?)', [table, rid, 'branch-main', action, data, NOW]);
    return n(db, 'SELECT MAX(id) FROM sync_changelog');
  };
  const synced = (id: number): number => n(db, 'SELECT synced FROM sync_changelog WHERE id = ?', [id]);
  const BIG = JSON.stringify({ id: 'big', file_path: 'data:image/png;base64,' + 'A'.repeat(LIMIT - 64) });
  const TOO = JSON.stringify({ id: 'too', file_path: 'A'.repeat(LIMIT) });
  const small = (i: number): string => JSON.stringify({ id: 't' + i, title: 'x' });
  ok(bytes(BIG) <= LIMIT && 2 * bytes(BIG) > BODY && bytes(TOO) > LIMIT,
    `PUSH Prüflinge: groß ${bytes(BIG)} ≤ ${LIMIT} B (zwei > ${BODY} B), zu groß ${bytes(TOO)} B`);

  const bodies: Array<{ bytes: number; ids: string[] }> = [];
  let status = 200;
  const realFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (_url: string, init: { body: string }) => {
    const body = String(init.body);
    bodies.push({ bytes: bytes(body), ids: (JSON.parse(body) as { changes: Array<{ record_id: string }> }).changes.map((c) => c.record_id) });
    return { ok: status < 300, status };
  };
  const warnVorher = console.warn; const warnings: string[] = [];
  console.warn = (...a: unknown[]): void => { warnings.push(String(a[0])); };
  try {
    const a = add('tasks', 's1', 'update', small(1));
    const b1 = add('documents', 'big-1', 'insert', BIG);
    const b2 = add('documents', 'big-2', 'insert', BIG);
    const s2 = add('tasks', 's2', 'update', small(2));
    const too = add('documents', 'too-big', 'insert', TOO);
    const s3 = add('tasks', 's3', 'delete', small(3));
    const alle = [a, b1, b2, s2, too, s3];

    status = 500;
    const f = await sync.pushChanges().then(() => 'ok', (e: unknown) => String(e));
    ok(/Push failed: 500/.test(f) && alle.every((x) => synced(x) === 0) && S(bodies[0]?.ids) === S(['s1', 'big-1']),
      `ACK der Primary lehnt ab → nichts quittiert (${f})`);
    status = 200;
    const r1 = await sync.pushChanges();
    ok(r1 === 2 && S(bodies[1].ids) === S(bodies[0].ids) && synced(a) === 1 && synced(b1) === 1 && synced(b2) === 0,
      `RETRY die Wiederholung schickt denselben Stapel und quittiert genau ihn (${S(bodies[1].ids)})`);
    const r2 = await sync.pushChanges();
    ok(r2 === 3 && S(bodies[2].ids) === S(['big-2', 's2', 's3']) && synced(b2) === 1 && synced(s2) === 1 && synced(s3) === 1 && synced(too) === 2,
      `STARVATION die zu große Zeile geht nie, bleibt hier (synced = 2) — die spätere geht im selben Push (${S(bodies[2].ids)})`);
    const r3 = await sync.pushChanges();
    ok(r3 === 0 && bodies.length === 3 && !bodies.some((b) => b.ids.includes('too-big')) && warnings.some((w) => /larger than the primary accepts/.test(w)),
      'STARVATION kein weiterer Versuch, keine Schleife — eine Warnung nennt sie');
    ok(bodies.every((b) => b.bytes <= BODY) && bodies.slice(1).map((b) => b.ids.join(',')).join('|') === 's1,big-1|big-2,s2,s3',
      `LIMIT jeder Rumpf ≤ ${BODY} B inkl. Umschlag (${bodies.map((b) => b.bytes).join(' / ')}); Reihenfolge wie geschrieben`);

    // Nur die zu große Zeile ganz vorn: sie geht nicht hinaus, die nächste schon.
    db.run('DELETE FROM sync_changelog');
    const t2 = add('documents', 'too-2', 'update', TOO);
    const s4 = add('tasks', 's4', 'update', small(4));
    const vor = bodies.length;
    const r4 = await sync.pushChanges();
    ok(r4 === 1 && bodies.length === vor + 1 && S(bodies[vor].ids) === S(['s4']) && synced(t2) === 2 && synced(s4) === 1,
      'STARVATION eine zu große Zeile ganz vorn hält die nächste nicht auf');

    // Kleine Änderungen bleiben gebündelt wie bisher: 100 je Push, in Reihenfolge.
    db.run('DELETE FROM sync_changelog');
    const ids = Array.from({ length: 105 }, (_, i) => add('tasks', 'k' + i, 'update', small(i)));
    const v2 = bodies.length;
    const r5 = await sync.pushChanges();
    const r6 = await sync.pushChanges();
    ok(r5 === 100 && r6 === 5 && S(bodies[v2].ids) === S(ids.slice(0, 100).map((_, i) => 'k' + i)) && S(bodies[v2 + 1].ids) === S(['k100', 'k101', 'k102', 'k103', 'k104'])
      && ids.every((x) => synced(x) === 1), 'BATCH kleine Änderungen: 100 je Push in Reihenfolge, dann der Rest — wie bisher');
  } finally {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    console.warn = warnVorher;
  }

  // Die Regel selbst und ihre Grenzen.
  const ch = (rid: string, data: string, action = 'insert') => ({ table_name: 'documents', record_id: rid, action, data });
  const zwei = pb.planPush([ch('a', BIG), ch('b', BIG), ch('c', small(1))]);
  const exakt = pb.planPush([ch('a', small(1)), ch('b', small(2))], { payload: LIMIT, body: bytes(pb.pushBody([ch('a', small(1))])) });
  const del = pb.planPush([ch('d', 'x'.repeat(LIMIT + 1), 'delete')]);
  ok(S(zwei) === S({ send: [0], refused: [] }) && S(exakt) === S({ send: [0], refused: [] }) && S(del) === S({ send: [0], refused: [] }),
    'PLAN zwei große → einer je Rumpf; die Grenze ist exakt; ein delete wird nicht nach Daten gemessen (der Primary prüft dort keine)');
  ok(/pub const MAX_SYNC_PUSH_BODY_BYTES: usize = 50 \* 1024 \* 1024;/.test(src('src-tauri/src/sync/routes.rs')) && BODY === 50 * 1024 * 1024
    && LIMIT === MANIFEST.limits.max_payload_bytes && /data\.len\(\) > schema\(\)\.max_payload_bytes/.test(src('src-tauri/src/sync/sync_schema.rs')),
  'PLAN die Grenzen sind die des Primary: Körper 50 MiB (Router), Änderung max_payload_bytes (validate_business_payload)');
  const ret = codeOf(src('src/core/storage/changelog-retention.ts'));
  ok(/DELETE FROM sync_changelog WHERE synced = 1/.test(ret) && !/synced\s*(<>|!=)\s*0|synced\s*(=|>=?)\s*2/.test(ret),
    'ACK die Aufräumung löscht nur quittierte Zeilen (synced = 1) — eine abgewiesene bleibt');
}
marker('CENTRAL_UI_R6F_SYNC_SIZE_BATCHING_PROVED');

// ══ §6 — Texterkennung: der Primary rechnet, aus SEINEM Inhalt ═══════════════
function stub(result: unknown = { text: ' Rolex Daytona 116500 \n', confidence: 87.5 }, fail = false) {
  const seen: string[] = [];
  const engine = async (u: string): Promise<{ text: string; confidence: number }> => {
    seen.push(u);
    if (fail) throw new Error('language data unavailable');
    return result as { text: string; confidence: number };
  };
  return { engine, seen };
}
{
  const dbP = freshDb();
  const upP = await primary(() => docStore.uploadDocumentOnPrimary(upBody()));
  const idP = String(upP.value.documentId);
  const eP = stub();
  const p = await primary(() => docStore.extractOcrOnPrimary({ documentId: idP, expectedRevision: 1 }, eP.engine));
  const rp = docRow(dbP, idP);

  const dbR = freshDb();
  const upR = await fern(() => office.runDocumentUpload(deps(dbR), identity('300', 'documents.upload'), upBody()));
  const idR = String(upR.value.documentId);
  const eR = stub();
  const t0 = Date.now();
  const r = await fern(() => office.runDocumentOcr(deps(dbR), identity('301', 'documents.set_ocr'), { documentId: idR, expectedRevision: 1 }, eR.engine));
  const dauer = Date.now() - t0;
  const rr = docRow(dbR, idR);

  ok(p.ok && r.ok, `PARITY beide Wege erkennen (${p.code || 'ok'} / ${r.code || 'ok'})`);
  const diff = unterschiede(ohne(rp, ['created_by']), ohne(rr, ['created_by']));
  ok(diff.length === 0, `PARITY lokal == fern (${diff.join(' · ') || 'gleich'})`);
  ok(rr.ocr_text === 'Rolex Daytona 116500' && Number(rr.ocr_confidence) === 87.5 && Number(rr.ocr_reviewed) === 1 && Number(rr.revision) === 2,
    `OCR Text, Sicherheit, „gelaufen", Fassung 2 — gespeichert vom Primary (${S([rr.ocr_text, rr.ocr_confidence, rr.ocr_reviewed, rr.revision])})`);
  ok(eR.seen.length === 1 && eR.seen[0] === PNG_URL && eP.seen[0] === PNG_URL,
    'OCR die Erkennung bekam den GESPEICHERTEN Inhalt des Primary — nichts vom Client');
  ok(cl(dbR, 'documents', 'update') === 1 && cl(dbP, 'documents', 'update') === 1
    && (JSON.parse(s(dbR, "SELECT data FROM sync_changelog WHERE table_name = 'documents' AND action = 'update'")) as { ocr_text?: string }).ocr_text === 'Rolex Daytona 116500',
  'SYNC BEFUND behoben: der erkannte Text hat jetzt einen Abgleich-Eintrag (vorher: keinen)');
  ok(n(dbR, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'documents' AND field_name = 'ocrText' AND changed_by = 'user-pc2'") === 1,
    'AUDIT der Text steht im Protokoll — im Namen des Absenders');
  ok(S(Object.keys(r.value).sort()) === S(['confidence', 'documentId', 'revision', 'stored', 'text']) && r.value.stored === true,
    `RESULT Text, Sicherheit, Fassung (${S(r.value)})`);
  console.log(`  i OCR-Lauf fern mit Stub: ${dauer} ms gesamt (Schreiben nach der Erkennung: eine UPDATE-Zeile)`);

  // Wiederholung: keine zweite Erkennung, keine zweite Wirkung.
  const again = await fern(() => office.runDocumentOcr(deps(dbR), identity('301', 'documents.set_ocr'), { documentId: idR, expectedRevision: 1 }, eR.engine));
  ok(again.ok && again.replayed && eR.seen.length === 1 && cl(dbR, 'documents', 'update') === 1 && n(dbR, 'SELECT revision FROM documents WHERE id = ?', [idR]) === 2,
    'RETRY dieselbe Kennung: eingefrorene Antwort, KEINE zweite Erkennung, keine zweite Wirkung');
  // Alte Fassung: gar nicht erst erkennen.
  const stale = await fern(() => office.runDocumentOcr(deps(dbR), identity('302', 'documents.set_ocr'), { documentId: idR, expectedRevision: 1 }, eR.engine));
  ok(!stale.ok && stale.code === 'RECORD_CHANGED' && stale.frozen && eR.seen.length === 1, `STALE alte Fassung → RECORD_CHANGED, keine Erkennung (${stale.code})`);
  const noRev = await fern(() => office.runDocumentOcr(deps(dbR), identity('303', 'documents.set_ocr'), { documentId: idR }, eR.engine));
  ok(noRev.thrown && /expectedRevision is required/.test(noRev.message), 'STALE ohne Fassung keine Erkennung');

  // Kein Ergebnis vom Client.
  for (const [k1, v] of [['text', 'fake'], ['ocrText', 'fake'], ['confidence', 99], ['ocrConfidence', 99], ['ocrReviewed', true],
    ['completedAt', NOW], ['content', PNG_URL], ['filePath', 'x'], ['result', {}], ['status', 'done'], ['createdBy', 'u']] as Array<[string, unknown]>) {
    const r2 = await fern(() => office.runDocumentOcr(deps(dbR), identity('31' + k1.length + k1.charCodeAt(0), 'documents.set_ocr'), { documentId: idR, expectedRevision: 2, [k1]: v }, eR.engine));
    ok(r2.thrown && r2.message === `the primary decides ${k1}, not the client`, `AUTHORITY ocr: ${k1} → „the primary decides" (${r2.message})`);
  }
  ok(eR.seen.length === 1 && s(dbR, 'SELECT ocr_text FROM documents WHERE id = ?', [idR]) === 'Rolex Daytona 116500',
    'AUTHORITY kein Client-Ergebnis erreicht die Zeile — und keine Erkennung lief dafür');

  // Nur ein Bild mit Inhalt.
  // MEDIA-DOCUMENTS — eine PDF kommt nicht mehr als Data-URL herein; fuer diese Wache genuegt eine
  // Zeile, die wie eine gespeicherte PDF aussieht: keine Bytes in der Spalte, Typ .
  insert(dbR, 'documents', { id: 'd-pdf', branch_id: 'branch-main', file_name: 'c.pdf', file_path: '', file_type: 'application/pdf', created_at: NOW });
  const nonImg = await fern(() => office.runDocumentOcr(deps(dbR), identity('321', 'documents.set_ocr'), { documentId: 'd-pdf', expectedRevision: 1 }, eR.engine));
  insert(dbR, 'documents', { id: 'd-legacy', branch_id: 'branch-main', file_name: 'old.png', file_path: 'C:\\scans\\old.png', file_type: 'image/png', created_at: NOW });
  const legacy = await fern(() => office.runDocumentOcr(deps(dbR), identity('322', 'documents.set_ocr'), { documentId: 'd-legacy', expectedRevision: 1 }, eR.engine));
  insert(dbR, 'documents', { id: 'd-x', branch_id: 'branch-other', file_name: 'x.png', file_path: PNG_URL, file_type: 'image/png', created_at: NOW });
  const fremd = await fern(() => office.runDocumentOcr(deps(dbR), identity('323', 'documents.set_ocr'), { documentId: 'd-x', expectedRevision: 1 }, eR.engine));
  ok(nonImg.code === 'DOCUMENT_OCR_UNSUPPORTED' && nonImg.frozen && legacy.code === 'DOCUMENT_OCR_UNSUPPORTED' && fremd.code === 'DOCUMENT_NOT_FOUND'
    && eR.seen.length === 1 && one(dbR, "SELECT ocr_text FROM documents WHERE id = 'd-x'") === null,
  `GUARD PDF / alter Pfad-Eintrag / fremde Filiale → nein, ohne Erkennung (${S([nonImg.code, legacy.code, fremd.code])})`);
  // Über die Registry (mit der ECHTEN Erkennung — die hier gar nicht erst geladen wird, weil vorher geprüft wird).
  const viaOcr = await registry.executeCommand('documents.set_ocr', { documentId: 'd-pdf', expectedRevision: 1 },
    { commandId: ID('324'), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', payloadHash: 'h324', role: 'SALES' } as never) as { kind: string; code?: string };
  ok(viaOcr.kind === 'business_error' && viaOcr.code === 'DOCUMENT_OCR_UNSUPPORTED', `REGISTRY documents.set_ocr: das Urteil des Hauses (${S(viaOcr)})`);

  // Scheitert die Erkennung selbst: kein Urteil, nichts geschrieben — dieselbe Kennung darf erneut.
  const up2 = await fern(() => office.runDocumentUpload(deps(dbR), identity('330', 'documents.upload'), upBody({ fileName: 'b.png' })));
  const id2 = String(up2.value.documentId);
  const kaputt = stub(undefined, true);
  const f1 = await fern(() => office.runDocumentOcr(deps(dbR), identity('331', 'documents.set_ocr'), { documentId: id2, expectedRevision: 1 }, kaputt.engine));
  ok(!f1.ok && !f1.thrown && f1.code === 'DOCUMENT_OCR_FAILED' && !f1.frozen && frei(dbR, '331', 'documents.set_ocr')
    && n(dbR, 'SELECT revision FROM documents WHERE id = ?', [id2]) === 1,
  `FAIL die Erkennung scheitert → nicht eingefroren, nichts geschrieben (${f1.code}, frozen ${f1.frozen})`);
  const e2 = stub();
  const f2 = await fern(() => office.runDocumentOcr(deps(dbR), identity('331', 'documents.set_ocr'), { documentId: id2, expectedRevision: 1 }, e2.engine));
  ok(f2.ok && !f2.replayed && s(dbR, 'SELECT ocr_text FROM documents WHERE id = ?', [id2]) === 'Rolex Daytona 116500',
    'FAIL …dieselbe Kennung darf es danach erneut versuchen und gelingt');
  const garbage = await fern(() => office.runDocumentOcr(deps(dbR), identity('332', 'documents.set_ocr'), { documentId: id2, expectedRevision: 2 }, stub({ text: 5, confidence: 'x' }).engine));
  ok(garbage.code === 'DOCUMENT_OCR_FAILED' && !garbage.frozen, 'FAIL ein unbrauchbares Ergebnis der Erkennung ist kein Ergebnis');

  // Kein Text: nichts wird geschrieben, der alte Text bleibt.
  const clVor = cl(dbR, 'documents');
  const leer = await fern(() => office.runDocumentOcr(deps(dbR), identity('333', 'documents.set_ocr'), { documentId: id2, expectedRevision: 2 }, stub({ text: '  ', confidence: 3 }).engine));
  ok(leer.ok && leer.value.stored === false && leer.value.text === '' && leer.value.revision === 2
    && s(dbR, 'SELECT ocr_text FROM documents WHERE id = ?', [id2]) === 'Rolex Daytona 116500' && cl(dbR, 'documents') === clVor,
  'EMPTY kein Text erkannt: nichts geschrieben, der alte Text bleibt (wie bisher)');

  // Ändert sich die Zeile während des Wartens (darf in der Spur nicht passieren), zählt das Ergebnis nicht.
  const quer = async (u: string): Promise<{ text: string; confidence: number }> => {
    dbR.run("UPDATE documents SET doc_class = 'photo' WHERE id = ?", [id2]);
    return { text: `seen ${u.length}`, confidence: 50 };
  };
  const race = await fern(() => office.runDocumentOcr(deps(dbR), identity('334', 'documents.set_ocr'), { documentId: id2, expectedRevision: 2 }, quer));
  ok(!race.ok && race.code === 'RECORD_CHANGED' && s(dbR, 'SELECT ocr_text FROM documents WHERE id = ?', [id2]) === 'Rolex Daytona 116500'
    && s(dbR, 'SELECT doc_class FROM documents WHERE id = ?', [id2]) === 'receipt',
  `RACE eine Änderung während der Erkennung → RECORD_CHANGED, alles zurück (${race.code})`);

  // Primary: dieselben Nein-Fälle.
  setTestDatabase(dbP as never);
  const pf = await primary(() => docStore.extractOcrOnPrimary({ documentId: idP, expectedRevision: 2 }, stub(undefined, true).engine));
  const ps = await primary(() => docStore.extractOcrOnPrimary({ documentId: idP, expectedRevision: 1 }, stub().engine));
  ok(pf.code === 'DOCUMENT_OCR_FAILED' && ps.code === 'RECORD_CHANGED' && n(dbP, 'SELECT revision FROM documents WHERE id = ?', [idP]) === 2,
    `PRIMARY dieselben Absagen lokal (${S([pf.code, ps.code])})`);

  // Fehlerinjektion am Schreiben nach der Erkennung.
  setTestDatabase(dbR as never);
  const up3 = await fern(() => office.runDocumentUpload(deps(dbR), identity('340', 'documents.upload'), upBody({ fileName: 'c.png' })));
  const id3 = String(up3.value.documentId);
  for (const pattern of [/UPDATE documents SET ocr_text/, /INSERT INTO sync_changelog/, /INSERT INTO audit_log/]) {
    const v = [row(dbR, 'SELECT ocr_text, revision FROM documents WHERE id = ?', [id3]), cl(dbR, 'documents'), audits(dbR, 'documents')];
    const { db: bad, f } = faulty(dbR, pattern);
    setTestDatabase(bad as never);
    const r2 = await fern(() => office.runDocumentOcr(deps(bad), identity('341', 'documents.set_ocr'), { documentId: id3, expectedRevision: 1 }, stub().engine));
    f.armed = false;
    setTestDatabase(dbR as never);
    ok(r2.thrown && S([row(dbR, 'SELECT ocr_text, revision FROM documents WHERE id = ?', [id3]), cl(dbR, 'documents'), audits(dbR, 'documents')]) === S(v)
      && frei(dbR, '341', 'documents.set_ocr'), `INJECT ocr ${pattern}: nichts bleibt, nichts eingefroren (${r2.code})`);
  }
  ok(lc(dbR) === 0 && lc(dbP) === 0, 'LEDGER keine Buchung');
}

// ══ §7 — Dokumente: Client + Oberfläche ══════════════════════════════════════
await imClient(async (touched, calls) => {
  const a = await primary(() => docStore.uploadDocumentOnPrimary(upBody()));
  const b = await primary(() => docStore.extractOcrOnPrimary({ documentId: 'd1', expectedRevision: 1 }, stub().engine));
  const c = await primary(() => docStore.useDocumentStore.getState().extractOcr('d1'));
  const d = wirft(() => docHouse.uploadDocumentInHouse(upBody() as never, { branchId: 'branch-main', userId: 'u' }));
  ok(a.code === 'DOCUMENT_PRIMARY_ONLY' && b.code === 'DOCUMENT_PRIMARY_ONLY' && c.code === 'DOCUMENT_PRIMARY_ONLY' && d === 'DOCUMENT_PRIMARY_ONLY' && touched() === 0,
    `CLIENT jeder Dokument-Anschluss verweigert, bevor er eine Datenbank anfasst (${S([a.code, b.code, c.code, d])}, Zugriffe ${touched()})`);
  const r1 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => upBody() }, write('documents.upload'));
  const r2 = await runSharedWrite(true, { local: () => { throw new Error('lokal'); }, remote: () => ({ documentId: 'd-pc2', expectedRevision: 4 }) }, write('documents.set_ocr'));
  const s1 = calls.find((x) => x.body.op === 'documents.upload');
  const s2 = calls.find((x) => x.body.op === 'documents.set_ocr');
  ok(r1.kind === 'ok' && r2.kind === 'ok' && !!s1 && !!s2
    && S(Object.keys(s1.body.payload as object).sort()) === S(['content', 'docClass', 'fileName', 'linkedEntityId', 'linkedEntityType'])
    && S(s2.body.payload) === S({ documentId: 'd-pc2', expectedRevision: 4 }) && touched() === 0,
  'CLIENT Upload: Name, Inhalt, Klasse, Verknüpfung — Texterkennung: nur Dokument und Fassung');
});
{
  const dl = codeOf(src('src/pages/documents/DocumentList.tsx'));
  ok(/w\.ok\('documents\.upload', \{\s*local: \(\) => uploadDocumentOnPrimary\(body\),\s*remote: \(\) => body/.test(dl),
    'UI DocumentList: „Upload" über die gemeinsame Weiche, derselbe Rumpf auf beiden Wegen');
  ok(/const body = \{ documentId: doc\.id, expectedRevision: doc\.revision \};/.test(dl)
    && /w\.save<DocumentOcrDone>\('documents\.set_ocr', \{\s*local: \(\) => extractOcrOnPrimary\(body\),\s*remote: \(\) => body/.test(dl),
  'UI DocumentList: „Extract Text" nennt nur Dokument und gesehene Fassung');
  ok(!/\b(uploadDocument|extractOcr)\(/.test(dl), 'UI DocumentList: keine Store-Aktion mehr direkt');
  // MEDIA-DOCUMENTS — zwei Wege, zwei abgeleitete Grenzen: die Abgleich-Grenze fuer den alten Weg,
  // die Speichergrenze (25 MiB) fuer eine PDF. Erfunden ist keine davon.
  ok(/const grenze = istPdf \? DOCUMENT_MAX_BYTES : DOCUMENT_MAX_FILE_BYTES;/.test(dl)
    && /rohbytes\.byteLength > grenze/.test(dl),
  'UI DocumentList: die Vorprüfung nutzt dieselbe abgeleitete Grenze — je Weg die seine');
  for (const h of ['data-document-upload', 'data-document-file', 'data-document-class', 'data-document-link-id', 'data-document-upload-confirm', 'data-document-ocr']) {
    ok(dl.includes(h), `UI DocumentList: ${h}`);
  }
  const ds = codeOf(src('src/stores/documentStore.ts'));
  ok(!/INSERT INTO documents|UPDATE documents SET ocr_text|branch-main/.test(ds) && /uploadDocumentInHouse\(/.test(ds) && /setDocumentOcrInHouse\(/.test(ds),
    'DOMAIN documentStore schreibt Upload/Texterkennung nicht mehr selbst, kein stilles branch-main');
  const oc = codeOf(src('src/core/bridge/office-commands.ts'));
  ok(/execute\(runDocumentOcr, OP_DOCUMENTS_SET_OCR, p, a\)/.test(oc) && /engine: OcrEngine = defaultOcrEngine/.test(oc),
    'OCR der angemeldete Befehl erkennt mit der echten Erkennung des Primary (tesseract), der Stub gilt nur hier');
}
marker('CENTRAL_UI_R6F_DOCUMENTS_OCR_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6f office parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }

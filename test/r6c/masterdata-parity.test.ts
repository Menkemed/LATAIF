// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — Stammdaten und Schnellanlagen: EINE Regel, EINE Buchung je fachlicher
// Aktion, Primary und PC2 mit derselben Wirkung.
// Run: node test/r6c/masterdata-parity.test.ts
//
// Gefahren werden die ECHTEN Hausfunktionen (Store), die echte C3A-Maschine mit durablem Nachweis
// und das echte Schema. Gestellt sind nur das Speichern und — im letzten Abschnitt — das Netz.
//
//   §1 Umfang, Registry, Rechte      §2 Primary zuerst: die Regel und ihre Befunde
//   §3 suppliers.create (drei Einstiege, eine Buchung, verlorene Antwort, Foto über die Ablage)
//   §4 suppliers.update (Ändern, Zielwert statt Umschalter)   §5 agents.update   §6 partners.*   §7 employees.*
//   §8 Primary == PC2 (dieselbe Zeile)   §9 Oberfläche (jede Maske ein Anschluss)   §10 PC2-Anschluss (Ablage → Auftrag → sofort in der Auswahl)
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const rules = await import('../../src/core/masterdata/masterdata-rules.ts');
const md = await import('../../src/core/bridge/masterdata-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useEmployeeStore } = await import('../../src/stores/employeeStore.ts');
const { usePartnerStore } = await import('../../src/stores/partnerStore.ts');
const { useAgentStore } = await import('../../src/stores/agentStore.ts');
const save = await import('../../src/core/masterdata/masterdata-save.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';

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

/** Eine Zeile mit allen NOT-NULL-Spalten, damit ein Test nicht an einer Schema-Kleinigkeit scheitert. */
function insert(db: Db, table: string, values: Record<string, unknown>): void {
  const cols = rows(db, `PRAGMA table_info(${table})`);
  const data: Record<string, unknown> = { ...values };
  for (const c of cols) {
    const name = String(c.name);
    if (!c.notnull || c.dflt_value !== null || c.pk || data[name] !== undefined) continue;
    const t = String(c.type || '').toUpperCase();
    data[name] = /INT|REAL|NUM/.test(t) ? 0 : (/_at$|date/i.test(name) ? NOW : '');
  }
  const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
  db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
}

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-other','tenant-1','Andere',?,?)", [NOW, NOW]);
  insert(db, 'customers', { id: 'c1', branch_id: 'branch-main', first_name: 'Maya', last_name: 'Main', created_at: NOW, updated_at: NOW });
  insert(db, 'customers', { id: 'c2', branch_id: 'branch-other', first_name: 'Otto', last_name: 'Other', created_at: NOW, updated_at: NOW });
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
function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => { /* gestellt */ },
    now: () => NOW,
  };
}
async function fern(fn: () => Promise<{ kind: string; value?: unknown; replayed?: boolean; code?: string; frozen?: boolean }>) {
  try {
    const o = await fn();
    return o.kind === 'ok'
      ? { kind: 'ok' as const, value: o.value as Record<string, unknown>, replayed: o.replayed === true, code: '', frozen: false }
      : { kind: 'rejected' as const, code: String(o.code), frozen: o.frozen === true, value: {} as Record<string, unknown>, replayed: false };
  } catch (e) {
    return { kind: 'thrown' as const, code: String((e as { code?: unknown }).code ?? (e as Error).message), message: (e as Error).message, value: {} as Record<string, unknown>, replayed: false, frozen: false };
  }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function parseFails(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

const MD_OPS = ['suppliers.create', 'suppliers.update', 'agents.update', 'partners.create', 'partners.update', 'employees.create', 'employees.update'];

// ══ §1 — Umfang, Registry, Rechte ═══════════════════════════════════════════
{
  ok(MD_OPS.every((op) => registry.ALLOWED_MUTATIONS.includes(op)), 'SCOPE die sieben Stammdaten-Aktionen sind namentlich freigegeben');
  ok(registry.ALLOWED_MUTATIONS.length === 88 && registry.ALLOWED_MUTATIONS.at(-1) === 'customers.log_message',
    `SCOPE 41 + 7 Stammdaten + 4 Inventur + 28 R6D + 8 R6E = 88 Buchungen (${registry.ALLOWED_MUTATIONS.length})`);
  ok(MD_OPS.every((op) => registry.knownCommands().includes(op)), 'SCOPE und registriert');
  ok(MD_OPS.every((op) => op in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[op] === null),
    'SCOPE kein erfundenes Recht — die Masken des Primary haben kein Tor (Befund)');
  // R6D — Geld an Lieferant und Gesellschafter sind seither EIGENE Buchungen (suppliers.pay/refund_credit,
  // partners.record_tx); die Stammdaten-Buchungen selbst bewegen weiterhin kein Geld, und Löschen bleibt Primary-only.
  ok(!registry.ALLOWED_MUTATIONS.some((op) => /^(suppliers|agents|partners|employees)\.delete/.test(op))
    && !md.MASTERDATA_OPS.some((op) => /pay|refund|record_tx/.test(op)),
    'SCOPE kein Löschen; die Stammdaten-Buchungen bewegen kein Geld (§5)');
  const rust = src('src-tauri/src/bridge.rs');
  const list = /pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1] ?? '';
  const count = (list.match(/OP_[A-Z_]+/g) ?? []).length;
  ok(count === 160 && ['OP_SUPPLIERS_CREATE', 'OP_SUPPLIERS_UPDATE', 'OP_AGENTS_UPDATE', 'OP_PARTNERS_CREATE', 'OP_PARTNERS_UPDATE', 'OP_EMPLOYEES_CREATE', 'OP_EMPLOYEES_UPDATE'].every((c) => list.includes(c)),
    `SCOPE Rust lässt dieselben Namen durch; Registry 108 → 121 (R6C) → 152 (R6D) → 160 (R6E) (${count})`);
  const listener = src('src/core/bridge/bridge-listener.ts');
  ok(/import '\.\/masterdata-commands';/.test(listener) && /import '\.\/inventory-commands';/.test(listener), 'SCOPE der Renderer des Primary lädt beide Befehlsdateien');
}

// ══ §2 — Primary zuerst: die Regel, die vorher fehlte ═══════════════════════
{
  ok(wirft(() => rules.supplierCreateInput({ name: '   ' })) === rules.SUPPLIER_NAME_REQUIRED, 'RULE ein Lieferantenname aus Leerzeichen ist kein Name');
  const s = rules.supplierCreateInput({ name: '  Gold LLC ', phone: ' +973 1 ', email: '' });
  ok(s.name === 'Gold LLC' && s.phone === '+973 1' && !('email' in s), `RULE getrimmt, leer heißt „kein Wert" (${S(s)})`);
  ok(wirft(() => rules.supplierUpdateInput({ name: '' })) === rules.SUPPLIER_NAME_REQUIRED, 'RULE beim Ändern kann der Name nicht geleert werden');
  const u = rules.supplierUpdateInput({ phone: '', active: false });
  ok(u.phone === null && u.active === false, 'RULE ein geleertes Feld beim Ändern ist `null` (weg damit)');
  ok(wirft(() => rules.partnerCreateInput({ name: 'P', sharePercentage: 150 })) === 'MASTERDATA_FIELD_OUT_OF_RANGE'
    && wirft(() => rules.partnerCreateInput({ name: 'P', sharePercentage: -1 })) === 'MASTERDATA_FIELD_OUT_OF_RANGE', 'RULE ein Partneranteil liegt zwischen 0 und 100 %');
  ok(wirft(() => rules.employeeCreateInput({ name: 'E', baseSalary: -5 })) === 'MASTERDATA_FIELD_OUT_OF_RANGE', 'RULE ein Grundgehalt ist nie negativ');
  ok(wirft(() => rules.employeeCreateInput({ name: 'E', employmentStatus: 'fired' })) === 'EMPLOYEE_STATUS_INVALID', 'RULE der Status kommt aus der festen Liste');
  ok(!('totalSales' in rules.agentUpdateInput({ totalSales: 5, name: 'A' })), 'RULE die Umsatzsummen eines Agenten sind kein Formularfeld');

  const db = freshDb();
  const sup = useSupplierStore.getState();
  ok(wirft(() => sup.createSupplier({ name: '   ' })) === rules.SUPPLIER_NAME_REQUIRED && n(db, 'SELECT COUNT(*) FROM suppliers') === 0,
    'PRIMARY die Hausfunktion selbst verweigert einen leeren Namen (vorher legten SupplierList/PurchaseCreate „   " an)');
  const made = sup.createSupplier({ name: '  Trim Me  ' });
  ok(one(db, 'SELECT name FROM suppliers WHERE id = ?', [made.id]) === 'Trim Me', 'PRIMARY und trimmt — an allen drei Einstiegen gleich (vorher nur in der Werkstatt)');
  ok(wirft(() => sup.updateSupplier(made.id, { name: '' })) === rules.SUPPLIER_NAME_REQUIRED && one(db, 'SELECT name FROM suppliers WHERE id = ?', [made.id]) === 'Trim Me',
    'PRIMARY ein geleertes Namensfeld schreibt keinen leeren Namen mehr');
  insert(db, 'agents', { id: 'a1', branch_id: 'branch-main', name: 'Ali', commission_rate: 10, active: 1, total_sales: 500, total_commission: 50, created_at: NOW, updated_at: NOW });
  db.run('UPDATE agents SET total_sales = 900, total_commission = 90 WHERE id = ?', ['a1']);   // ein Verkauf, während die Maske offen ist
  useAgentStore.getState().updateAgent('a1', { name: 'Ali B', totalSales: 500, totalCommission: 50 } as never);
  ok(Number(one(db, 'SELECT total_sales FROM agents WHERE id = ?', ['a1'])) === 900 && Number(one(db, 'SELECT total_commission FROM agents WHERE id = ?', ['a1'])) === 90
    && one(db, 'SELECT name FROM agents WHERE id = ?', ['a1']) === 'Ali B',
  'PRIMARY „Edit Approval" schreibt die Umsatzsummen nicht mehr aus dem Stand beim Öffnen zurück (der Verkauf dazwischen bleibt)');
  ok(wirft(() => usePartnerStore.getState().createPartner({ name: 'X', sharePercentage: 250 })) === 'MASTERDATA_FIELD_OUT_OF_RANGE' && n(db, 'SELECT COUNT(*) FROM partners') === 0,
    'PRIMARY kein Partner mit 250 % Anteil');
  ok(wirft(() => useEmployeeStore.getState().createEmployee({ name: 'E', baseSalary: -500, employmentStatus: 'active' } as never)) === 'MASTERDATA_FIELD_OUT_OF_RANGE',
    'PRIMARY kein Mitarbeiter mit negativem Grundgehalt');
}
marker('CENTRAL_UI_R6C_PRIMARY_FIRST_CONTRACT_PROVED');

// ══ §3 — suppliers.create ═══════════════════════════════════════════════════
{
  for (const [k, v] of [['id', 'x'], ['branchId', 'b'], ['active', true], ['cprImage', 'data:image/png;base64,AA'], ['totalPaid', 1], ['outstandingBalance', 1], ['bogus', 1], ['createdBy', 'u']] as Array<[string, unknown]>) {
    ok(parseFails(() => md.parseSupplierCreate({ name: 'N', [k]: v })) !== '', `PAYLOAD suppliers.create weist ${k} ab`);
  }
  ok(parseFails(() => md.parseSupplierCreate({ name: 'N', cprImageStagingId: 'abc' })) !== '', 'PAYLOAD eine Ablagekennung ist ein Inhaltshash, sonst nichts');

  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const body = { name: '  Gold Dealer  ', phone: '+973 3333 4444', email: 'g@d.bh', address: 'Manama', cpr: '900123456', notes: 'n' };
  const a = await fern(() => md.runSupplierCreate(d, identity(idA, 'suppliers.create'), body));
  const row = rows(db, 'SELECT * FROM suppliers')[0] ?? {};
  ok(a.kind === 'ok' && a.value.name === 'Gold Dealer' && n(db, 'SELECT COUNT(*) FROM suppliers') === 1, `CREATE ein Lieferant (${S(a.value)})`);
  ok(row.branch_id === 'branch-main' && Number(row.active) === 1 && row.created_by === 'user-test' && row.phone === '+973 3333 4444' && row.cpr === '900123456',
    'CREATE Filiale und Benutzer vom Primary, aktiv, Telefon mit Vorwahl, CPR');
  const b = await fern(() => md.runSupplierCreate(d, identity(idA, 'suppliers.create'), body));
  ok(b.kind === 'ok' && b.replayed && b.value.supplierId === a.value.supplierId && n(db, 'SELECT COUNT(*) FROM suppliers') === 1,
    'LOST verlorene Antwort, dieselbe Kennung: genau EIN Lieferant');
  const c = await fern(() => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create'), body));
  ok(c.kind === 'ok' && n(db, 'SELECT COUNT(*) FROM suppliers') === 2, 'DUP ein NEUER Vorsatz legt an — das Haus warnt vor Doppelgängern, es sperrt nicht (dieselbe Regel wie beim Kunden)');
  const e = await fern(() => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create'), { name: '   ' }));
  ok(e.kind === 'thrown' && e.code === rules.SUPPLIER_NAME_REQUIRED && n(db, 'SELECT COUNT(*) FROM suppliers') === 2, 'CREATE fern dieselbe Regel, derselbe Code wie am Primary');
  const f = await fern(() => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create', 'branch-other'), { name: 'X' }));
  ok(f.kind === 'rejected' && f.code === 'BRANCH_MISMATCH' && f.frozen && n(db, 'SELECT COUNT(*) FROM suppliers') === 2, 'CREATE ein Ausweis einer anderen Filiale legt nichts an');

  const sid = 'a'.repeat(64);
  const discarded: string[] = [];
  let owner: Record<string, string> = {};
  const g = await fern(() => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create'), { name: 'Photo Co', cprImageStagingId: sid }, {
    readStaged: async (_id, o) => { owner = o as never; return { mime: 'image/png', dataBase64: 'iVBORw0K' }; },
    discardStaged: async (id) => { discarded.push(id); },
  }));
  ok(g.kind === 'ok' && one(db, 'SELECT cpr_image FROM suppliers WHERE id = ?', [g.value.supplierId]) === 'data:image/png;base64,iVBORw0K' && discarded.join() === sid,
    'MEDIA das Ausweisfoto kam über die vorhandene Ablage (R5B), danach geräumt');
  ok(owner.branchId === 'branch-main' && owner.userId === 'user-test', 'MEDIA die Ablage gehört der GEPRÜFTEN Identität');
  const before = n(db, 'SELECT COUNT(*) FROM suppliers');
  const idH = nextId();
  const h = await fern(() => md.runSupplierCreate(d, identity(idH, 'suppliers.create'), { name: 'Gone Co', cprImageStagingId: 'b'.repeat(64) }, { readStaged: async () => { throw new Error('missing'); } }));
  ok(h.kind === 'thrown' && h.code === 'STAGED_IMAGE_GONE' && n(db, 'SELECT COUNT(*) FROM suppliers') === before && lookupCommand(db as never, identity(idH, 'suppliers.create')).kind === 'fresh',
    'MEDIA eine verschwundene Ablage legt nichts an und verbrennt die Kennung nicht');
}
marker('CENTRAL_UI_R6C_SUPPLIER_CREATE_PROVED');

// ══ §4 — suppliers.update ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  const s = useSupplierStore.getState().createSupplier({ name: 'Old', phone: '1', cprImage: 'data:image/png;base64,QQ' });
  insert(db, 'suppliers', { id: 'sx', branch_id: 'branch-other', name: 'Foreign', active: 1, created_at: NOW, updated_at: NOW });
  ok(parseFails(() => md.parseSupplierUpdate({ id: s.id, cprImage: 'data:image/png;base64,AA' })) !== '', 'PAYLOAD ein Foto ändert sich nur über die Ablage');
  ok(parseFails(() => md.parseSupplierUpdate({ id: s.id })) === 'nothing to change', 'PAYLOAD ein leeres Ändern ist keine Absicht');
  ok(parseFails(() => md.parseSupplierUpdate({ id: s.id, creditBalance: 5 })) !== '', 'PAYLOAD Salden rechnet das Haus');
  const r1 = await fern(() => md.runSupplierUpdate(d, identity(nextId(), 'suppliers.update'), { id: s.id, name: ' New ', phone: '' }));
  const row = rows(db, 'SELECT name, phone, cpr_image FROM suppliers WHERE id = ?', [s.id])[0];
  ok(r1.kind === 'ok' && row.name === 'New' && row.phone === null && row.cpr_image === 'data:image/png;base64,QQ', 'UPDATE nur das Genannte ändert sich; das Foto bleibt');
  ok((await fern(() => md.runSupplierUpdate(d, identity(nextId(), 'suppliers.update'), { id: 'nope', name: 'X' }))).code === 'SUPPLIER_NOT_FOUND', 'UPDATE ein unbekannter Lieferant: eingefrorenes Nein');
  ok((await fern(() => md.runSupplierUpdate(d, identity(nextId(), 'suppliers.update'), { id: 'sx', name: 'X' }))).code === 'SUPPLIER_NOT_FOUND' && one(db, "SELECT name FROM suppliers WHERE id = 'sx'") === 'Foreign',
    'UPDATE ein Lieferant einer anderen Filiale ist von hier aus nicht vorhanden');
  const idT = nextId();
  const t1 = await fern(() => md.runSupplierUpdate(d, identity(idT, 'suppliers.update'), { id: s.id, active: false }));
  const t2 = await fern(() => md.runSupplierUpdate(d, identity(idT, 'suppliers.update'), { id: s.id, active: false }));
  ok(t1.kind === 'ok' && t2.replayed && Number(one(db, 'SELECT active FROM suppliers WHERE id = ?', [s.id])) === 0,
    'ACTIVE „Deactivate" reist als Zielwert — eine Wiederholung schaltet nicht zurück');
  const r5 = await fern(() => md.runSupplierUpdate(d, identity(nextId(), 'suppliers.update'), { id: s.id, cprImage: null }));
  ok(r5.kind === 'ok' && one(db, 'SELECT cpr_image FROM suppliers WHERE id = ?', [s.id]) === null, 'UPDATE ein entferntes Foto ist `null`');
  const r6 = await fern(() => md.runSupplierUpdate(d, identity(nextId(), 'suppliers.update'), { id: s.id, name: '' }));
  ok(r6.kind === 'thrown' && r6.code === rules.SUPPLIER_NAME_REQUIRED && one(db, 'SELECT name FROM suppliers WHERE id = ?', [s.id]) === 'New', 'UPDATE fern dieselbe Namensregel');
}

// ══ §5 — agents.update ══════════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  insert(db, 'agents', { id: 'a1', branch_id: 'branch-main', name: 'Ali', commission_rate: 10, active: 1, total_sales: 500, total_commission: 50, created_at: NOW, updated_at: NOW });
  insert(db, 'agents', { id: 'ax', branch_id: 'branch-other', name: 'Xavi', commission_rate: 10, active: 1, created_at: NOW, updated_at: NOW });
  for (const k of ['totalSales', 'totalCommission', 'commissionRate', 'branchId']) {
    ok(/the primary decides/.test(parseFails(() => md.parseAgentUpdate({ id: 'a1', [k]: 1 }))), `PAYLOAD agents.update: ${k} gibt der Client nicht vor`);
  }
  const r = await fern(() => md.runAgentUpdate(d, identity(nextId(), 'agents.update'), { id: 'a1', name: 'Ali New', customerId: 'c1' }));
  ok(r.kind === 'ok' && one(db, "SELECT name FROM agents WHERE id = 'a1'") === 'Ali New' && one(db, "SELECT customer_id FROM agents WHERE id = 'a1'") === 'c1'
    && Number(one(db, "SELECT total_sales FROM agents WHERE id = 'a1'")) === 500, 'AGENT Name und Kundenverknüpfung ändern sich, die Summen nicht');
  const bad = await fern(() => md.runAgentUpdate(d, identity(nextId(), 'agents.update'), { id: 'a1', customerId: 'c2' }));
  ok(bad.code === 'CUSTOMER_NOT_FOUND' && one(db, "SELECT customer_id FROM agents WHERE id = 'a1'") === 'c1', 'AGENT ein Kunde einer anderen Filiale wird nicht verknüpft');
  ok((await fern(() => md.runAgentUpdate(d, identity(nextId(), 'agents.update'), { id: 'ax', name: 'Y' }))).code === 'AGENT_NOT_FOUND', 'AGENT ein Agent einer anderen Filiale: nicht vorhanden');
  const off = await fern(() => md.runAgentUpdate(d, identity(nextId(), 'agents.update'), { id: 'a1', active: false }));
  ok(off.kind === 'ok' && Number(one(db, "SELECT active FROM agents WHERE id = 'a1'")) === 0, 'AGENT Inactive als Zielwert');
}

// ══ §6 — partners.* ═════════════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  ok(/the primary decides active/.test(parseFails(() => md.parsePartnerCreate({ name: 'P', active: false }))), 'PAYLOAD ein neuer Partner ist aktiv — das entscheidet kein Rumpf');
  ok(/the primary decides balance/.test(parseFails(() => md.parsePartnerCreate({ name: 'P', balance: 9 }))), 'PAYLOAD Salden rechnet das Haus');
  const idP = nextId();
  const p1 = await fern(() => md.runPartnerCreate(d, identity(idP, 'partners.create'), { name: ' Pa ', sharePercentage: 25, phone: '+973 1' }));
  const p2 = await fern(() => md.runPartnerCreate(d, identity(idP, 'partners.create'), { name: ' Pa ', sharePercentage: 25, phone: '+973 1' }));
  const row = rows(db, 'SELECT name, share_percentage, active FROM partners')[0];
  ok(p1.kind === 'ok' && p2.replayed && n(db, 'SELECT COUNT(*) FROM partners') === 1 && row.name === 'Pa' && Number(row.share_percentage) === 25 && Number(row.active) === 1,
    'PARTNER angelegt, verlorene Antwort: genau einer');
  const over = await fern(() => md.runPartnerCreate(d, identity(nextId(), 'partners.create'), { name: 'Q', sharePercentage: 101 }));
  ok(over.kind === 'thrown' && over.code === 'MASTERDATA_FIELD_OUT_OF_RANGE' && n(db, 'SELECT COUNT(*) FROM partners') === 1, 'PARTNER fern dieselbe Anteilsregel');
  const pid = String(p1.value.partnerId);
  const up = await fern(() => md.runPartnerUpdate(d, identity(nextId(), 'partners.update'), { id: pid, sharePercentage: 30, active: false }));
  ok(up.kind === 'ok' && Number(one(db, 'SELECT share_percentage FROM partners WHERE id = ?', [pid])) === 30 && Number(one(db, 'SELECT active FROM partners WHERE id = ?', [pid])) === 0,
    'PARTNER Anteil und Status geändert');
  ok((await fern(() => md.runPartnerUpdate(d, identity(nextId(), 'partners.update'), { id: 'nope', name: 'x' }))).code === 'PARTNER_NOT_FOUND', 'PARTNER unbekannt: eingefrorenes Nein');
}

// ══ §7 — employees.* ════════════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  ok(/the primary decides userId/.test(parseFails(() => md.parseEmployeeCreate({ name: 'E', userId: 'u' }))), 'PAYLOAD die Login-Verknüpfung ist Hauskonfiguration, nie fern');
  const idE = nextId();
  const e1 = await fern(() => md.runEmployeeCreate(d, identity(idE, 'employees.create'), { name: ' Emp ', role: 'Sales', baseSalary: 400, employmentStatus: 'active' }));
  const e2 = await fern(() => md.runEmployeeCreate(d, identity(idE, 'employees.create'), { name: ' Emp ', role: 'Sales', baseSalary: 400, employmentStatus: 'active' }));
  const eid = String(e1.value.employeeId);
  ok(e1.kind === 'ok' && e2.replayed && n(db, 'SELECT COUNT(*) FROM employees') === 1 && one(db, 'SELECT name FROM employees WHERE id = ?', [eid]) === 'Emp',
    'EMPLOYEE angelegt, verlorene Antwort: genau einer');
  const neg = await fern(() => md.runEmployeeCreate(d, identity(nextId(), 'employees.create'), { name: 'Neg', baseSalary: -1 }));
  ok(neg.kind === 'thrown' && neg.code === 'MASTERDATA_FIELD_OUT_OF_RANGE', 'EMPLOYEE fern dieselbe Gehaltsregel');
  const st = await fern(() => md.runEmployeeUpdate(d, identity(nextId(), 'employees.update'), { id: eid, employmentStatus: 'on_leave' }));
  ok(st.kind === 'ok' && st.value.employmentStatus === 'on_leave' && one(db, 'SELECT employment_status FROM employees WHERE id = ?', [eid]) === 'on_leave', 'EMPLOYEE „On Leave" als Zielstatus');
  const bad = await fern(() => md.runEmployeeUpdate(d, identity(nextId(), 'employees.update'), { id: eid, employmentStatus: 'fired' }));
  ok(bad.kind === 'thrown' && bad.code === 'EMPLOYEE_STATUS_INVALID', 'EMPLOYEE ein Status außerhalb der Liste: Nein');
  ok((await fern(() => md.runEmployeeUpdate(d, identity(nextId(), 'employees.update'), { id: 'nope', role: 'x' }))).code === 'EMPLOYEE_NOT_FOUND', 'EMPLOYEE unbekannt: eingefrorenes Nein');
}
marker('CENTRAL_UI_R6C_MASTERDATA_GAPS_CLOSED');

// ══ §8 — Primary == PC2: dieselbe Zeile ═════════════════════════════════════
{
  const norm = (r: Record<string, unknown> | undefined): string => S(Object.fromEntries(Object.entries(r ?? {}).filter(([k]) => !/^(id|created_at|updated_at|created_by)$/.test(k)).sort(([a], [b]) => a.localeCompare(b))));
  const twin = async (table: string, local: () => unknown, remote: (d: ReturnType<typeof deps>) => Promise<unknown>) => {
    const dbP = freshDb(); local(); const p = rows(dbP, `SELECT * FROM ${table}`)[0];
    const dbC = freshDb(); await remote(deps(dbC)); const c = rows(dbC, `SELECT * FROM ${table}`)[0];
    return { p: norm(p), c: norm(c) };
  };
  const sForm = { name: ' Twin Supplier ', phone: '+973 5', email: 't@s.bh', address: 'Riffa', cpr: '800', notes: 'x' };
  const sT = await twin('suppliers', () => useSupplierStore.getState().createSupplier(sForm), (d) => md.runSupplierCreate(d, identity(nextId(), 'suppliers.create'), sForm));
  ok(sT.p === sT.c, `PARITY Lieferant: Primary == PC2${sT.p === sT.c ? '' : ` (${sT.p} / ${sT.c})`}`);
  const pForm = { name: 'Twin Partner', phone: '+973 6', email: 'p@x.bh', sharePercentage: 12.5 };
  const pT = await twin('partners', () => usePartnerStore.getState().createPartner(pForm), (d) => md.runPartnerCreate(d, identity(nextId(), 'partners.create'), pForm));
  ok(pT.p === pT.c, `PARITY Partner: Primary == PC2${pT.p === pT.c ? '' : ` (${pT.p} / ${pT.c})`}`);
  const eForm = { name: 'Twin Emp', role: 'Tech', employmentStatus: 'active', baseSalary: 350, phone: '+973 7' };
  const eT = await twin('employees', () => useEmployeeStore.getState().createEmployee(eForm as never), (d) => md.runEmployeeCreate(d, identity(nextId(), 'employees.create'), eForm));
  ok(eT.p === eT.c, `PARITY Mitarbeiter: Primary == PC2${eT.p === eT.c ? '' : ` (${eT.p} / ${eT.c})`}`);
}
marker('CENTRAL_UI_R6C_PRIMARY_PARITY_PROVED');

// ══ §9 — Oberfläche: jede Maske ein Anschluss ═══════════════════════════════
{
  for (const f of ['src/pages/suppliers/SupplierList.tsx', 'src/pages/purchases/PurchaseCreate.tsx', 'src/pages/repairs/RepairList.tsx']) {
    const c = codeOf(src(f));
    ok(/saveSupplierCreate\(/.test(c) && !/createSupplier\(/.test(c) && /useSharedWrite<\{ supplierId: string \}>\('suppliers\.create'\)/.test(c),
      `QUICK ${f.split('/').pop()}: dieselbe Folge, dieselbe Buchung — kein direkter Store-Aufruf mehr`);
  }
  ok(/setSupplierId\(r\.value\.supplierId\)/.test(codeOf(src('src/pages/purchases/PurchaseCreate.tsx'))), 'QUICK Einkauf: der neue Lieferant ist danach gewählt (bestehender Vertrag)');
  ok(/workshopSupplierId: r\.value\.supplierId/.test(codeOf(src('src/pages/repairs/RepairList.tsx'))), 'QUICK Werkstatt: der neue Lieferant ist danach gewählt (bestehender Vertrag)');
  const sd = codeOf(src('src/pages/suppliers/SupplierDetail.tsx'));
  ok(/saveSupplierUpdate\(aendern, supplier, form\)/.test(sd) && /saveSupplierActive\(aendern, supplier, !supplier\.active\)/.test(sd) && !/updateSupplier\(/.test(sd),
    'UI Lieferant ändern und (de)aktivieren: EINE Buchung, kein Store-Aufruf');
  const al = codeOf(src('src/pages/agents/AgentList.tsx'));
  ok(/saveAgentUpdate\(/.test(al) && !/updateAgent\(/.test(al), 'UI Agent ändern: ein Anschluss');
  const pp = codeOf(src('src/pages/partners/PartnersPage.tsx'));
  ok(/savePartnerCreate\(/.test(pp) && /savePartnerUpdate\(/.test(pp) && !/createPartner\(|updatePartner\(/.test(pp), 'UI Partner anlegen/ändern: ein Anschluss');
  const el = codeOf(src('src/pages/employees/EmployeeList.tsx'));
  const ed = codeOf(src('src/pages/employees/EmployeeDetail.tsx'));
  ok(/saveEmployeeCreate\(/.test(el) && /saveEmployeeUpdate\(/.test(el) && !/createEmployee\(|updateEmployee\(/.test(el), 'UI Mitarbeiter anlegen und Status (Liste): ein Anschluss');
  ok(/saveEmployeeUpdate\(/.test(ed) && !/updateEmployee\(/.test(ed) && !/useEmployeeStore\(\)[\s\S]{0,200}setStatus/.test(ed), 'UI Mitarbeiter ändern und Status (Detail): ein Anschluss');
  const ms = codeOf(src('src/core/masterdata/masterdata-save.ts'));
  ok((ms.match(/local: \(\) => runOnPrimary\(/g) ?? []).length === 7, 'UI am Primary läuft jede Stammdaten-Handlung in der Schreibreihenfolge (runOnPrimary) — nicht mehr an ihr vorbei');
  ok(/stageDataUrls\(\[dataUrl\]\)/.test(ms) && /cprImageStagingId = s\.id/.test(ms), 'UI das Foto reist auf PC2 über die vorhandene Ablage (kein neuer Medienweg)');
  ok(/updatePayload\(base as unknown as Record<string, unknown>, form as Record<string, unknown>, SUPPLIER_UPDATE_FIELDS\)/.test(ms), 'UI beim Ändern reist nur das Geänderte (M-01)');
}
marker('CENTRAL_UI_R6C_QUICK_CREATES_PROVED');

// ══ §10 — der PC2-Anschluss: Ablage → Auftrag → sofort in der Auswahl ═════════
{
  freshDb();
  store.set('lataif_runtime_mode', 'client');
  store.set('lataif_client_server_url', 'https://primary.local');
  store.set('lataif_client_token', 'tok');
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/staging/media')) return new Response(JSON.stringify({ stagingId: 'c'.repeat(64), mime: 'image/png', bytes: 3, width: 1, height: 1 }), { status: 200 });
    if (body.op === 'suppliers.create') return new Response(JSON.stringify({ ok: true, value: { supplierId: 'sup-remote', name: 'Photo', replayed: false } }), { status: 200 });
    if (body.op === 'store.suppliers.get') return new Response(JSON.stringify({ ok: true, value: { data: { suppliers: [{ id: 'sup-remote', name: 'Photo', active: true }] } } }), { status: 200 });
    return new Response('{}', { status: 500 });
  }) as never;
  try {
    const ctl = new CommandSaveController<Record<string, unknown>>('suppliers.create');
    const write = { remote: true, save: <T,>(a: never) => runSharedWrite<T>(true, a, ctl.beginAttempt()) };
    const r = await save.saveSupplierCreate(write as never, { name: '  Photo  ', phone: '+973 9', cprImage: 'data:image/png;base64,iVBORw0K' });
    const cmd = calls.find((c) => c.body.op === 'suppliers.create');
    ok(r.kind === 'ok' && (r as { value: { supplierId: string } }).value.supplierId === 'sup-remote', 'CLIENT der Auftrag kommt zurück mit der Kennung des Primary');
    ok(calls[0]?.url.endsWith('/api/staging/media') && !!cmd && cmd.body.payload && S(Object.keys(cmd.body.payload as object).sort()) === S(['cprImageStagingId', 'name', 'phone'])
      && (cmd.body.payload as Record<string, unknown>).cprImageStagingId === 'c'.repeat(64) && (cmd.body.payload as Record<string, unknown>).name === 'Photo',
    `CLIENT erst die Bytes in die Ablage, dann EIN Auftrag — getrimmt, ohne Bild im Rumpf (${S(cmd?.body.payload)})`);
    ok(calls.some((c) => c.body.op === 'store.suppliers.get') && useSupplierStore.getState().suppliers.some((s) => s.id === 'sup-remote'),
      'CLIENT danach ist der neue Lieferant sofort im Bestand dieser Oberfläche (auswählbar ohne Neuladen)');
    const before = calls.length;
    const bad = await save.saveSupplierCreate(write as never, { name: '   ' });
    ok(bad.kind === 'business_error' && (bad as { code: string }).code === rules.SUPPLIER_NAME_REQUIRED && calls.length === before,
      'CLIENT dieselbe Regel VOR dem Schicken: kein Netz, dieselbe Antwort wie am Primary');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
  }
}
marker('CENTRAL_UI_R6C_QUICK_CREATE_RUNTIME_PROVED_UNIT');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r6c masterdata parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6C_MASTERDATA_PROVED');

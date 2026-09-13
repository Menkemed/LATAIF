// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — das Nachrichtenprotokoll am Kunden (`customers.log_message`): EINE
// Hausfolge für die Maske des Primary und für PC2.
// Run: node test/r6e/message-log-parity.test.ts
//
// Gefahren werden die ECHTE Hausfolge (`message-house.ts`), der echte Primary-Anschluss
// (`logCustomerMessageOnPrimary` → `runOnPrimary`), die echte C3A-Maschine mit durablem Nachweis,
// die echte Registrierung und das echte Schema. Gestellt sind nur das Speichern und — im
// Client-Abschnitt — das Netz.
//
//   §1 Umfang   §2 Parität (die vier Einträge der Matrix)   §3 verlorene Antwort
//   §4 Neins (Filiale, Verknüpfung, Rumpf)   §5 Fehlerinjektion   §6 Client   §7 Oberfläche
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
const house = await import('../../src/core/customers/message-house.ts');
const cmd = await import('../../src/core/bridge/message-commands.ts');
const msgStore = await import('../../src/stores/customerMessageStore.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T10:00:00.000Z';
const OP = 'customers.log_message';

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
const msgs = (db: Db): number => n(db, 'SELECT COUNT(*) FROM customer_messages');

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
  insert(db, 'customers', { id: 'c3', branch_id: 'branch-main', first_name: 'Carl', last_name: 'Third', created_at: NOW, updated_at: NOW });
  insert(db, 'offers', { id: 'of1', branch_id: 'branch-main', offer_number: 'OFF-1', customer_id: 'c1', created_at: NOW, updated_at: NOW });
  insert(db, 'offers', { id: 'of3', branch_id: 'branch-main', offer_number: 'OFF-3', customer_id: 'c3', created_at: NOW, updated_at: NOW });
  insert(db, 'orders', { id: 'or1', branch_id: 'branch-main', order_number: 'ORD-1', customer_id: 'c1', created_at: NOW, updated_at: NOW });
  insert(db, 'orders', { id: 'orX', branch_id: 'branch-other', order_number: 'ORD-X', customer_id: 'c1', created_at: NOW, updated_at: NOW });
  insert(db, 'repairs', { id: 'rp1', branch_id: 'branch-main', repair_number: 'REP-1', customer_id: 'c1', created_at: NOW, updated_at: NOW });
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}

const ID = (k: number): string => `${String(k).padStart(8, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const nextId = (): string => ID(++seq);
/** Der Absender von PC2 — bewusst ein ANDERER Mensch als die Sitzung des Primary ('user-test'). */
const identity = (commandId: string, branchId = 'branch-main', hash = 'h') => ({
  commandId, tenantId: 'tenant-1', branchId, userId: 'user-pc2', role: 'SALES', op: OP, payloadHash: hash,
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
async function primary<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}
function wirft(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return String((e as { code?: unknown }).code ?? (e as Error).message); }
}
function parseMsg(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

/** Eine Datenbank, die an EINER Stelle scheitert — Fehlerinjektion an echten Wirkungspunkten. */
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

/** Eine Protokollzeile ohne Kennung, Zeitpunkte und Urheber — vergleichbar zwischen zwei Datenbanken. */
const norm = (r: Record<string, unknown> | undefined): string => S(Object.fromEntries(Object.entries(r ?? {})
  .filter(([k]) => !/^(id|sent_at|created_at|created_by)$/.test(k))
  .sort(([a], [b]) => a.localeCompare(b))));

/** Die vier Einträge der Matrix — genau so, wie ihre Aufrufer die Maske füttern. */
const CASES: Array<{ name: string; payload: Record<string, unknown> }> = [
  { name: 'Nachricht kopieren (CustomerDetail, ohne Verknüpfung)', payload: { customerId: 'c1', channel: 'ai_copy', body: 'Hello Maya, thank you!', kind: 'thank_you' } },
  { name: 'WhatsApp (OfferDetail, Angebot)', payload: { customerId: 'c1', channel: 'whatsapp', body: 'Your offer OFF-1', kind: 'follow_up', linkedEntityType: 'offer', linkedEntityId: 'of1' } },
  { name: 'AI-Benachrichtigung Auftrag (OrderDetail)', payload: { customerId: 'c1', channel: 'whatsapp', body: 'Order ORD-1 has arrived.', kind: 'order_arrived', linkedEntityType: 'order', linkedEntityId: 'or1' } },
  { name: 'AI-Benachrichtigung Reparatur (RepairDetail)', payload: { customerId: 'c1', channel: 'ai_copy', body: 'Repair REP-1 is ready.', kind: 'repair_ready', linkedEntityType: 'repair', linkedEntityId: 'rp1' } },
];

// ══ §1 — Umfang ═════════════════════════════════════════════════════════════
{
  ok(registry.ALLOWED_MUTATIONS.includes(OP), 'SCOPE customers.log_message ist namentlich freigegeben');
  ok(registry.knownCommands().includes(OP) && cmd.OP_CUSTOMERS_LOG_MESSAGE === OP, 'SCOPE und registriert');
  ok(OP in perms.OPERATION_PERMISSIONS && perms.OPERATION_PERMISSIONS[OP] === null, 'SCOPE kein erfundenes Recht (die Maske hat am Primary kein Tor)');
  ok((codeOf(src('src/core/bridge/message-commands.ts')).match(/registerCommand\(/g) ?? []).length === 1, 'SCOPE genau eine Registrierung, ausdrücklich');
  ok(!registry.ALLOWED_MUTATIONS.some((op) => /^customers\.(delete_message|update_message)|^messages\./.test(op)), 'SCOPE Löschen/Ändern eines Eintrags ist nicht verdrahtet (nur anhängen)');
}
marker('CENTRAL_UI_R6E_MESSAGE_SCOPE_PROVED');

// ══ §2 — Parität: Primary == PC2, je Eintrag der Matrix ══════════════════════
{
  for (const c of CASES) {
    const dbP = freshDb();
    const p = await primary(() => msgStore.logCustomerMessageOnPrimary(house.messageLogInput(c.payload)));
    const rowP = rows(dbP, 'SELECT * FROM customer_messages')[0];
    const dbC = freshDb();
    const r = await fern(() => cmd.runLogMessage(deps(dbC), identity(nextId()), c.payload));
    const rowC = rows(dbC, 'SELECT * FROM customer_messages')[0];
    ok(p.ok && r.kind === 'ok' && msgs(dbP) === 1 && msgs(dbC) === 1 && norm(rowP) === norm(rowC),
      `PARITY ${c.name}: Primary == PC2 (${norm(rowP)} / ${norm(rowC)})`);
    ok(rowP?.created_by === 'user-test' && rowC?.created_by === 'user-pc2',
      `ACTOR ${c.name}: created_by ist der Mensch, der verschickt hat — am Primary die Sitzung, fern der Absender (${rowP?.created_by} / ${rowC?.created_by})`);
    ok(rowP?.branch_id === 'branch-main' && rowC?.branch_id === 'branch-main' && rowP?.direction === 'outbound' && rowC?.subject === null
      && rowC?.linked_entity_type === (c.payload.linkedEntityType ?? null) && rowC?.body === c.payload.body,
    `ROW ${c.name}: Filiale, Richtung, Verknüpfung und Text wie geschickt`);
    ok(!!rowC?.sent_at && rowC?.sent_at === rowC?.created_at && rowC?.sent_at === r.value.sentAt && r.value.messageId === rowC?.id && r.value.customerId === 'c1',
      `RESULT ${c.name}: Kennung und Zeitpunkt vergibt der Primary, die Antwort nennt sie`);
  }
  // Der ganze Weg über die Registrierung (Rechte-Tor, Ausführung, Antwortform).
  const db = freshDb();
  const actor = { commandId: nextId(), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', payloadHash: 'hx', role: 'SALES' };
  const reply = await registry.executeCommand(OP, CASES[2].payload, actor) as { kind: string; value?: Record<string, unknown> };
  ok(reply.kind === 'ok' && typeof reply.value?.messageId === 'string' && reply.value?.replayed === false && msgs(db) === 1
    && one(db, 'SELECT created_by FROM customer_messages') === 'user-pc2',
  `REGISTRY der Befehl läuft ohne Rechte-Tor durch und schreibt im Namen des Absenders (${S(reply)})`);
  const again = await registry.executeCommand(OP, CASES[2].payload, actor) as { kind: string; value?: Record<string, unknown> };
  ok(again.kind === 'ok' && again.value?.replayed === true && again.value?.messageId === reply.value?.messageId && msgs(db) === 1,
    'REGISTRY dieselbe Kennung über die Registrierung: Wiederholung, keine zweite Zeile');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'customer_messages' AND action_type = 'CREATE'") === 1,
    'SYNC/AUDIT trackInsert bleibt: genau ein CREATE-Eintrag je Nachricht');
}
marker('CENTRAL_UI_R6E_MESSAGE_PARITY_PROVED');

// ══ §3 — verlorene Antwort ═══════════════════════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  const idA = nextId();
  const a = await fern(() => cmd.runLogMessage(d, identity(idA), CASES[1].payload));
  const b = await fern(() => cmd.runLogMessage(d, identity(idA), CASES[1].payload));
  ok(a.kind === 'ok' && b.kind === 'ok' && b.replayed && b.value.messageId === a.value.messageId && b.value.sentAt === a.value.sentAt && msgs(db) === 1,
    'LOST verlorene Antwort, dieselbe Kennung: eingefrorene Antwort, genau eine Zeile');
  const conflict = await fern(() => cmd.runLogMessage(d, identity(idA, 'branch-main', 'other-hash'), { ...CASES[1].payload, body: 'different' }));
  ok(conflict.kind === 'rejected' && conflict.code === 'COMMAND_ID_CONFLICT' && !conflict.frozen && msgs(db) === 1,
    'LOST dieselbe Kennung mit anderem Rumpf: kein zweiter Eintrag, kein Urteil');
  const fresh = await fern(() => cmd.runLogMessage(d, identity(nextId()), CASES[1].payload));
  ok(fresh.kind === 'ok' && !fresh.replayed && fresh.value.messageId !== a.value.messageId && msgs(db) === 2,
    'LOST ein NEUER Klick (neue Kennung) ist eine neue Nachricht — wie am Primary jeder Klick');
}
marker('CENTRAL_UI_R6E_MESSAGE_LOST_RESPONSE_PROVED');

// ══ §4 — Neins: Filiale, Verknüpfung, Rumpf ═══════════════════════════════════
{
  const db = freshDb();
  const d = deps(db);
  const base = CASES[0].payload;
  const staats: Array<[string, Record<string, unknown>, string, string]> = [
    ['Kunde einer anderen Filiale', { ...base, customerId: 'c2' }, house.CUSTOMER_NOT_FOUND, 'branch-main'],
    ['unbekannter Kunde', { ...base, customerId: 'nope' }, house.CUSTOMER_NOT_FOUND, 'branch-main'],
    ['Auftrag einer anderen Filiale', { ...base, linkedEntityType: 'order', linkedEntityId: 'orX' }, house.ORDER_NOT_FOUND, 'branch-main'],
    ['unbekannte Reparatur', { ...base, linkedEntityType: 'repair', linkedEntityId: 'nope' }, house.REPAIR_NOT_FOUND, 'branch-main'],
    ['unbekanntes Angebot', { ...base, linkedEntityType: 'offer', linkedEntityId: 'nope' }, house.OFFER_NOT_FOUND, 'branch-main'],
    ['Angebot eines anderen Kunden', { ...base, linkedEntityType: 'offer', linkedEntityId: 'of3' }, house.LINKED_ENTITY_MISMATCH, 'branch-main'],
    ['Ausweis einer anderen Filiale', base, 'BRANCH_MISMATCH', 'branch-other'],
  ];
  for (const [name, payload, code, branch] of staats) {
    const r = await fern(() => cmd.runLogMessage(d, identity(nextId(), branch), payload));
    ok(r.kind === 'rejected' && r.code === code && r.frozen && msgs(db) === 0, `SECURITY fern ${name}: ${code}, eingefroren, nichts geschrieben (${r.code})`);
  }
  for (const [name, payload, code, branch] of staats) {
    if (branch !== 'branch-main') continue;
    const p = await primary(() => msgStore.logCustomerMessageOnPrimary(house.messageLogInput(payload)));
    ok(!p.ok && p.code === code && msgs(db) === 0, `SECURITY Primary ${name}: dasselbe Nein (${p.ok ? 'ok' : p.code})`);
  }

  // Der Rumpf
  const payloadNeins: Array<[string, unknown, string]> = [
    ['leerer Text', { ...base, body: '' }, house.MESSAGE_EMPTY],
    ['nur Leerzeichen', { ...base, body: '   \n ' }, house.MESSAGE_EMPTY],
    ['ohne Text', { customerId: 'c1', channel: 'ai_copy' }, house.MESSAGE_EMPTY],
    ['Text als Zahl', { ...base, body: 42 }, house.MESSAGE_EMPTY],
    ['ohne Kunde', { ...base, customerId: '' }, house.CUSTOMER_REQUIRED],
    ['Kanal email (kein Knopf protokolliert ihn)', { ...base, channel: 'email' }, house.MESSAGE_CHANNEL_INVALID],
    ['Kanal sms', { ...base, channel: 'sms' }, house.MESSAGE_CHANNEL_INVALID],
    ['Kanal in anderer Schreibweise', { ...base, channel: 'WhatsApp' }, house.MESSAGE_CHANNEL_INVALID],
    ['ohne Kanal', { customerId: 'c1', body: 'x' }, house.MESSAGE_CHANNEL_INVALID],
    ['unbekannte Art', { ...base, kind: 'spam' }, house.MESSAGE_KIND_INVALID],
    ['Verknüpfung mit Rechnung', { ...base, linkedEntityType: 'invoice', linkedEntityId: 'inv1' }, house.MESSAGE_LINK_INVALID],
    ['Typ ohne Kennung', { ...base, linkedEntityType: 'order' }, house.MESSAGE_LINK_INVALID],
    ['Kennung ohne Typ', { ...base, linkedEntityId: 'or1' }, house.MESSAGE_LINK_INVALID],
  ];
  for (const [name, payload, code] of payloadNeins) {
    ok(wirft(() => cmd.parseLogMessage(payload)) === code, `PAYLOAD ${name}: ${code}`);
  }
  for (const k of ['id', 'branchId', 'tenantId', 'userId', 'createdBy', 'createdAt', 'updatedAt', 'revision', 'status', 'sentAt', 'direction', 'messageId']) {
    ok(/the primary decides/.test(parseMsg(() => cmd.parseLogMessage({ ...base, [k]: 'x' }))), `PAYLOAD ${k} bestimmt der Primary`);
  }
  for (const k of ['subject', 'foo', 'linked_entity_type']) {
    ok(/unknown field/.test(parseMsg(() => cmd.parseLogMessage({ ...base, [k]: 'x' }))), `PAYLOAD ein unbekanntes Feld (${k}) wird abgewiesen`);
  }
  ok(/payload must be an object/.test(parseMsg(() => cmd.parseLogMessage(['x']))) && /payload must be an object/.test(parseMsg(() => cmd.parseLogMessage(null))),
    'PAYLOAD kein Objekt: abgewiesen');

  // Ein unbrauchbarer Rumpf über die Registrierung: fachliches Nein, KEIN Nachweis, keine Zeile.
  const actor = { commandId: nextId(), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2', payloadHash: 'he', role: 'SALES' };
  const empty = await registry.executeCommand(OP, { ...base, body: '  ' }, actor) as { kind: string; code?: string };
  ok(empty.kind === 'business_error' && empty.code === house.MESSAGE_EMPTY && msgs(db) === 0
    && lookupCommand(db as never, { ...actor, op: OP }).kind === 'fresh',
  `PAYLOAD leerer Text über die Registrierung: MESSAGE_EMPTY, nichts geschrieben, kein Nachweis (${S(empty)})`);

  // Am Primary: kein stilles `null` mehr, keine Ersatzfiliale.
  const p = await primary(() => msgStore.logCustomerMessageOnPrimary({ customerId: 'c1', channel: 'ai_copy', body: '   ' } as never));
  ok(!p.ok && p.code === house.MESSAGE_EMPTY && msgs(db) === 0, 'PRIMARY ein leerer Text ist ein gesagtes Nein (vorher: stilles null)');
  const s = await primary(() => msgStore.useCustomerMessageStore.getState().logMessage({ customerId: 'c2', channel: 'ai_copy', body: 'x' }));
  ok(!s.ok && s.code === house.CUSTOMER_NOT_FOUND && msgs(db) === 0, 'PRIMARY auch der alte Store-Name läuft durch dieselbe Hausfolge');
  posting.beginLedgerTransaction();
  const noBranch = wirft(() => house.logCustomerMessageInHouse(house.messageLogInput(base), '', 'u'));
  posting.commitLedgerTransaction();
  ok(noBranch === house.MESSAGE_NO_SESSION && msgs(db) === 0, "PRIMARY ohne Filiale kein stilles 'branch-main' mehr");
}
marker('CENTRAL_UI_R6E_MESSAGE_NEGATIVES_PROVED');

// ══ §5 — Fehlerinjektion ════════════════════════════════════════════════════
{
  // (a) die Zeile selbst scheitert
  const dbF = freshDb();
  const { db: bad } = faulty(dbF, /INSERT INTO customer_messages/);
  setTestDatabase(bad as never);
  const idF = nextId();
  const f1 = await fern(() => cmd.runLogMessage(deps(bad), identity(idF), CASES[2].payload));
  const f2 = await primary(() => msgStore.logCustomerMessageOnPrimary(house.messageLogInput(CASES[2].payload)));
  setTestDatabase(dbF as never);
  ok(f1.kind === 'thrown' && !f2.ok && msgs(dbF) === 0 && lookupCommand(dbF as never, identity(idF)).kind === 'fresh',
    'ATOMIC scheitert die Zeile, gibt es nichts — fern und am Primary; der Nachweis ist NICHT als Erfolg eingefroren');
  ok(n(dbF, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'customer_messages'") === 0, 'ATOMIC auch kein Protokolleintrag ohne Zeile');
  const retry = await fern(() => cmd.runLogMessage(deps(dbF), identity(idF), CASES[2].payload));
  ok(retry.kind === 'ok' && !retry.replayed && msgs(dbF) === 1, 'ATOMIC dieselbe Kennung danach: sie war frei, jetzt genau eine Zeile');

  // (b) der durable Nachweis scheitert NACH der Zeile — die Zeile geht mit zurück
  const dbN = freshDb();
  const { db: badN } = faulty(dbN, /INSERT INTO remote_command_ledger/);
  setTestDatabase(badN as never);
  const idN = nextId();
  const g = await fern(() => cmd.runLogMessage(deps(badN), identity(idN), CASES[3].payload));
  setTestDatabase(dbN as never);
  ok(g.kind === 'thrown' && msgs(dbN) === 0 && lookupCommand(dbN as never, identity(idN)).kind === 'fresh'
    && n(dbN, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'customer_messages'") === 0,
  'ATOMIC scheitert der Nachweis, verschwindet auch die schon geschriebene Zeile (eine Transaktion)');
}
marker('CENTRAL_UI_R6E_MESSAGE_FAILURE_INJECTION_PROVED');

// ══ §6 — Client: keine lokale Datenbank, der Weg geht über den Primary ═══════
{
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
  let antwort: 'ok' | 'weg' = 'ok';
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ body });
    if (antwort === 'weg') throw new Error('network down');
    return new Response(JSON.stringify({ ok: true, value: { messageId: 'm-remote', replayed: false } }), { status: 200 });
  }) as never;
  try {
    const input = house.messageLogInput(CASES[2].payload);
    const refusals = [
      wirft(() => house.logCustomerMessageInHouse(input, 'branch-main', 'u')),
      (await primary(() => msgStore.logCustomerMessageOnPrimary(input))) as { code?: string },
      (await primary(() => msgStore.useCustomerMessageStore.getState().logMessage(input))) as { code?: string },
    ].map((x) => (typeof x === 'string' ? x : x.code));
    ok(refusals.every((c) => c === house.MESSAGE_PRIMARY_ONLY) && touched === 0,
      `CLIENT jeder lokale Weg verweigert, bevor er die Datenbank (oder eine Transaktion) anfasst (${S(refusals)}, Zugriffe ${touched})`);

    // Dieselben zwei Anschlüsse wie in der Maske: lokal die Hausfolge, fern der Rumpf.
    const adapters = (i: typeof input) => ({
      local: async () => ({ messageId: (await msgStore.logCustomerMessageOnPrimary(i)).id }),
      remote: () => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)),
      shape: (v: Record<string, unknown>) => ({ messageId: String(v.messageId ?? '') }),
    });
    const ctl = new CommandSaveController<Record<string, unknown>>(OP);
    const r = await runSharedWrite(true, adapters(input), ctl.beginAttempt());
    const sent = calls[0]?.body;
    ok(r.kind === 'ok' && (r as { value: { messageId: string } }).value.messageId === 'm-remote' && calls.length === 1 && sent?.op === OP
      && S(Object.keys(sent.payload as object).sort()) === S(['body', 'channel', 'customerId', 'kind', 'linkedEntityId', 'linkedEntityType']) && touched === 0,
    `CLIENT die Maske schickt EINEN geprüften Auftrag — keine lokale Wirkung (${S(sent)})`);

    // Offener Ausgang: kein Erfolg, und der nächste Klick wiederholt DIESELBE Kennung.
    antwort = 'weg';
    const ctl2 = new CommandSaveController<Record<string, unknown>>(OP);
    const u = await runSharedWrite(true, adapters(input), ctl2.beginAttempt());
    antwort = 'ok';
    const u2 = await runSharedWrite(true, adapters(input), ctl2.beginAttempt());
    ok(u.kind === 'unknown' && u2.kind === 'ok' && calls[1].body.commandId === calls[2].body.commandId && touched === 0,
      'CLIENT offener Ausgang ist kein Erfolg; die Wiederholung trägt dieselbe Kennung (der Primary schreibt höchstens einmal)');
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6E_MESSAGE_CLIENT_NO_LOCAL_DB_PROVED');

// ══ §7 — Oberfläche: die Maske ein Anschluss, die Aufrufer im Vertrag ═══════
{
  const m = codeOf(src('src/components/ai/MessagePreviewModal.tsx'));
  ok(/const OP_CUSTOMERS_LOG_MESSAGE = 'customers\.log_message'/.test(m) && /useSharedWrite<\{ messageId: string \}>\(OP_CUSTOMERS_LOG_MESSAGE\)/.test(m),
    'UI die Maske schreibt über die gemeinsame Weiche customers.log_message');
  ok(/local: async \(\) => \(\{ messageId: \(await logCustomerMessageOnPrimary\(input\)\)\.id \}\)/.test(m) && /remote: \(\) => rumpf/.test(m),
    'UI am Primary die Hausfolge, auf PC2 der Rumpf');
  ok(!/readsFromPrimary/.test(m) && !/only recorded on the main computer/.test(m) && !/useCustomerMessageStore/.test(m),
    'UI der R6B-Hinweis „not logged" ist durch den echten Fernweg ersetzt');
  ok(/if \(r\.kind === 'ok'\) \{\s*setLogStatus\('ok'\)/.test(m) && /fehlertext\(r\)/.test(m) && /messageLogInput\(\{ customerId, channel, body: text/.test(m),
    'UI „Added" nur nach einem Erfolg, jeder andere Ausgang mit Grund; dieselbe Eingaberegel vor dem Schicken');
  const koerper = (name: string): string => { const i = m.indexOf(`function ${name}(`); return m.slice(i, m.indexOf('\n  }\n', i)); };
  const wa = koerper('handleWhatsApp'); const cp = koerper('handleCopy');
  ok(wa.indexOf('window.open(') > 0 && wa.indexOf('window.open(') < wa.indexOf("log('whatsapp')"), 'UI WhatsApp öffnet IM Klick, das Protokoll folgt (kein Popup-Block durch await)');
  ok(cp.indexOf('clipboard.writeText(') > 0 && cp.indexOf('clipboard.writeText(') < cp.indexOf("log('ai_copy')"), 'UI Kopieren passiert unabhängig vom Protokoll');
  ok((m.match(/logWrite\.busy/g) ?? []).length === 2, 'UI beide Knöpfe gesperrt, solange der Eintrag läuft');
  const missing = ['data-message-copy', 'data-message-whatsapp', 'data-message-log-status', 'data-message-log-note'].filter((h) => !m.includes(h));
  ok(missing.length === 0, `UI E2E-Haken (${missing.join(', ') || 'alle'})`);

  const st = codeOf(src('src/stores/customerMessageStore.ts'));
  ok(!/'branch-main'|'user-owner'/.test(st) && !/INSERT INTO customer_messages/.test(st) && /runOnPrimary\(/.test(st) && /logMessage: \(input\) => logCustomerMessageOnPrimary\(input\)/.test(st),
    "STORE keine eigene Zeile, kein stilles 'branch-main'/'user-owner' — der Store-Name ist ein Primary-Anschluss");
  const hs = codeOf(src('src/core/customers/message-house.ts'));
  ok(!/'branch-main'/.test(hs) && (hs.match(/INSERT INTO customer_messages/g) ?? []).length === 1 && /trackInsert\('customer_messages'/.test(hs)
    && !/BEGIN|COMMIT|ROLLBACK|saveDatabase|rollbackLedgerTransaction/.test(hs),
  'HOUSE eine Zeile, Abgleich bleibt, keine eigene Transaktion und kein eigenes Speichern');
  const cm = codeOf(src('src/core/bridge/message-commands.ts'));
  ok(/logCustomerMessageInHouse\(input, identity\.branchId, identity\.userId\)/.test(cm) && /assertHouseBranch\(identity\)/.test(cm),
    'CMD der Fernbefehl ruft DIESELBE Hausfolge, in der Filiale des Primary, im Namen des Absenders');

  // Die Wertemengen stammen von den Aufrufern: jede Verknüpfung und jede Art, die sie setzen, nimmt
  // das Haus an — und nichts darüber hinaus.
  const callers = ['src/pages/customers/CustomerDetail.tsx', 'src/pages/offers/OfferDetail.tsx', 'src/pages/orders/OrderDetail.tsx', 'src/pages/repairs/RepairDetail.tsx'];
  const links = new Set<string>(); const kinds = new Set<string>();
  for (const f of callers) {
    const s = src(f);
    const i = s.indexOf('<MessagePreviewModal');
    const block = s.slice(i, s.indexOf('/>', i));
    ok(i > 0 && /customerId=\{customer\.id\}/.test(block), `CALLER ${f}: öffnet die Maske mit dem Kunden`);
    for (const x of block.matchAll(/linkedEntityType="(\w+)"/g)) links.add(x[1]);
    for (const x of block.matchAll(/\btype="(\w+)"/g)) kinds.add(x[1]);
  }
  ok(S([...links].sort()) === S(Object.keys(house.MESSAGE_LINKS).sort()), `CALLER die Verknüpfungen der Aufrufer == die Menge des Hauses (${S([...links])})`);
  ok([...kinds].every((k) => (house.MESSAGE_KINDS as readonly string[]).includes(k)), `CALLER jede Anfangsart ist eine Art des Hauses (${S([...kinds])})`);

  // Lesen: keine Seite zeigt die Historie — also braucht PC2 keine Leseoperation dafür.
  const scan = (d: string): string[] => readdirSync(resolvePath(repo, d), { withFileTypes: true }).flatMap((e) => {
    const p = d + '/' + e.name;
    if (e.isDirectory()) return scan(p);
    return /\.(ts|tsx)$/.test(e.name) && /messagesByCustomer|loadMessages\(/.test(src(p)) ? [p] : [];
  });
  const readers = [...scan('src/pages'), ...scan('src/components')];
  ok(readers.length === 0, `READ keine Oberfläche liest die Nachrichtenhistorie (${readers.join(', ') || 'keine'}) — keine Leseoperation nötig`);
}
marker('CENTRAL_UI_R6E_MESSAGE_UI_WIRED_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r6e: customer message log: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6E_MESSAGE_LOG_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7C R1–R3 — offene Speichervorgänge von PC2.
// Run: node test/r7c/pending-saves.test.ts
//
// Echte Module: `pending-saves` (Ablage), `client-command-save` (PC2-Versuch + Wächter),
// `shared-write.fehlertext`, und am Primary `command-registry.executeCommand` →
// `mutation-engine.runRemoteCommand` → `command-ledger` an einer echten sql.js-Datenbank. Die
// Rust-Schicht dazwischen (Kennungsspeicher der Brücke + HTTP-Abbildung) ist hier nachgebildet — ihr
// echtes Verhalten beweisen `cargo test command_reply` (routes.rs) und `bridge_tests`.
//
// Geprüft wird die FACHLICHE Wirkung (Buchungszeilen, Nachweiszeilen), nicht nur Rückgabewerte.
// „Neuladen" = der Fensterzustand wird verworfen (Versuche, geladene Liste); die Ablage bleibt —
// genau wie die Dateien unter AppLocalData ein Neuladen oder einen Neustart überdauern.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@/core/db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

// ── PC2: Seitenspeicher mit Adresse + Ausweis ───────────────────────────────
const storage = new Map<string, string>();
const ls = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
};
(globalThis as Record<string, unknown>).window = { localStorage: ls };
(globalThis as Record<string, unknown>).localStorage = ls;
const b64u = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (sub: string, branch = 'branch-main', tenant = 'tenant-1'): string =>
  `${b64u({ alg: 'HS256' })}.${b64u({ sub, tenant_id: tenant, branch_id: branch, role: 'owner' })}.sig`;
function signIn(sub = 'user-a', branch = 'branch-main', server = 'http://pc1:3011'): void {
  storage.set('lataif_runtime_mode', 'client');
  storage.set('lataif_client_server_url', server);
  storage.set('lataif_client_token', token(sub, branch));
}

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { runRemoteCommand, CommandRejected, CommandNotEvaluated } = await import('../../src/core/bridge/mutation-engine.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { registerCommand, executeCommand, BusinessError } = await import('../../src/core/bridge/command-registry.ts');
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const pend = await import('../../src/core/bridge/pending-saves.ts');
const save = await import('../../src/core/bridge/client-command-save.ts');
const { fehlertext } = await import('../../src/core/data/shared-write.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8').replace(/\r\n/g, '\n');
const J = (v: unknown): string => JSON.stringify(v);

// ── Primary: echter Renderer-Weg an sql.js ──────────────────────────────────
interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> }
interface Primary { db: Db; identities: Map<string, string>; authOk: boolean; staged: Set<string>; restart(): void }
let primary: Primary;
let seq = 0;
function freshPrimary(): Primary {
  const db = new SQL.Database() as unknown as Db;
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run('CREATE TABLE bookings (id TEXT PRIMARY KEY, amount REAL, note TEXT)');
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const p: Primary = {
    db, identities: new Map(), authOk: true, staged: new Set(),
    // Der Kennungsspeicher der Brücke lebt nur im Speicher: ein Neustart des Primary leert ihn.
    restart() { p.identities.clear(); },
  };
  return p;
}
const count = (): number => Number(primary.db.exec('SELECT COUNT(*) FROM bookings')[0].values[0][0]);
const countNote = (n: string): number => Number(primary.db.exec('SELECT COUNT(*) FROM bookings WHERE note = ?', [n])[0].values[0][0]);
const ledger = (): number => Number(primary.db.exec('SELECT COUNT(*) FROM remote_command_ledger')[0].values[0][0]);

// Eine zugelassene Fernbuchung — hier mit einem Prüf-Handler registriert (das Modul der echten
// `tasks.create` wird in diesem Lauf nicht geladen; der Weg Brücke → Nachweis ist derselbe).
const OP = 'tasks.create';
registerCommand(OP, {
  kind: 'mutation',
  handler: async (payload: unknown, actor: unknown) => {
    const input = (payload as { input: { amount: number; note?: string; staged?: string } }).input;
    const out = await runRemoteCommand({
      db: primary.db as never,
      begin: () => { primary.db.run('BEGIN'); },
      commit: () => { primary.db.run('COMMIT'); },
      rollback: () => { primary.db.run('ROLLBACK'); },
      durableSave: async () => {},
      now: () => new Date().toISOString(),
    }, { ...(actor as Record<string, unknown>), op: OP } as never, (db) => {
      if (input.staged && !primary.staged.has(input.staged)) {
        throw new CommandRejected('STAGED_IMAGE_GONE', 'the staged image is no longer on the main computer');
      }
      (db as unknown as Db).run('INSERT INTO bookings (id, amount, note) VALUES (?, ?, ?)', [`b-${++seq}`, input.amount, input.note ?? '']);
      return { booked: input.amount, note: input.note ?? '' };
    });
    if (out.kind === 'rejected') {
      if (!out.frozen) throw new CommandNotEvaluated(out.code, out.message);
      throw new BusinessError(out.code, out.message);
    }
    return { ...(out.value as Record<string, unknown>), replayed: out.replayed };
  },
} as never);

// ── Die Rust-Schicht, nachgebildet: Kennungsspeicher + `command_reply_parts` ─
const hashOf = (payload: unknown): string => createHash('sha256').update(pend.stableJson(payload)).digest('hex');
type Reply = { kind: 'ok'; value: unknown } | { kind: 'business_error'; code: string; message: string }
  | { kind: 'infrastructure_error'; code: string } | { kind: 'not_executed'; code: string; message: string };
function routeParts(r: Reply): [number, Record<string, unknown>] {
  if (r.kind === 'ok') return [200, { ok: true, value: r.value }];
  if (r.kind === 'business_error') return [409, { ok: false, error: r.code, message: r.message }];
  if (r.kind === 'not_executed') return [409, { ok: false, error: r.code, message: r.message, outcome: 'not_executed' }];
  return [500, { ok: false, error: r.code }];
}
const res = (status: number, body: Record<string, unknown>): Response =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;
let calls = 0;
function primaryFetch(opts: { loseReply?: boolean; unreachable?: boolean; notReady?: boolean } = {}): typeof fetch {
  return (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls++;
    if (opts.unreachable) throw new Error('connect ECONNREFUSED (never reached the main computer)');
    if (!primary.authOk) return res(401, { ok: false, error: 'UNAUTHORIZED' });
    if (opts.notReady) return res(503, { ok: false, error: 'BRIDGE_NOT_READY', outcome: 'not_executed' });
    const req = JSON.parse(init.body) as { op: string; commandId: string; payload: Record<string, unknown> };
    const claims = JSON.parse(Buffer.from(init.headers.Authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    const hash = hashOf(req.payload);
    const seen = primary.identities.get(req.commandId);
    if (seen && seen !== `${claims.sub}|${hash}`) return res(409, { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' });
    primary.identities.set(req.commandId, `${claims.sub}|${hash}`);
    const r = await executeCommand(req.op, { actor: {}, input: req.payload }, {
      commandId: req.commandId, tenantId: claims.tenant_id, branchId: claims.branch_id, userId: claims.sub,
      role: claims.role, op: req.op, payloadHash: hash,
    } as never) as Reply;
    const [status, body] = routeParts(r);
    if (opts.loseReply) throw new Error('connection reset — the request WAS delivered, the answer is lost');
    return res(status, body);
  }) as unknown as typeof fetch;
}

let disk = pend.memoryPendingBackend();
function freshPc2(backend?: Parameters<typeof pend.setPendingBackendForTest>[0]): void {
  disk = pend.memoryPendingBackend();
  pend.setPendingBackendForTest(backend ?? disk);
  save.resetLiveAttemptsForTest();
  signIn('user-a');
}
/** Neuladen / Neustart von PC2: der Fensterzustand ist weg, die Ablage bleibt. */
async function reload(): Promise<void> {
  pend.resetPendingMemoryForTest();
  save.resetLiveAttemptsForTest();
  await pend.ensurePendingLoaded();
}
const ctx = () => pend.currentPendingContext();
const onDisk = (id: string) => (disk.files.has(id) ? JSON.parse(disk.files.get(id)!) as { state: string; payload: unknown } : null);

// ══ R1-a — Antwort verloren, PC2 neu geladen, Primary neu gestartet: Klärung = genau einmal ══
{
  primary = freshPrimary(); freshPc2();
  const ctl = new save.CommandSaveController(OP);
  const a = ctl.beginAttempt();
  const P = { amount: 100, note: 'first' };
  const first = await a.send(P, primaryFetch({ loseReply: true }));
  ok(first.kind === 'unknown', `R1 die Antwort geht verloren → offen (${J(first)})`);
  ok(count() === 1 && ledger() === 1, 'R1 …der Primary HAT gebucht (eine Zeile, ein Nachweis)');
  ok(onDisk(a.commandId)?.state === 'unresolved' && pend.stableJson(onDisk(a.commandId)?.payload) === pend.stableJson(P),
    'R1 der Vorgang steht in der Ablage: Kennung + ursprünglicher Auftrag, Zustand offen');
  primary.restart();
  await reload();
  const recs = pend.pendingRecords(ctx());
  ok(recs.length === 1 && recs[0].commandId === a.commandId && pend.stableJson(recs[0].payload) === pend.stableJson(P),
    'R1 nach dem Neuladen: derselbe Vorgang, dieselbe Kennung, derselbe Auftrag — sichtbar aufgelistet');
  const before = calls;
  const out = await save.attemptForPending(recs[0]).send(recs[0].payload, primaryFetch());
  ok(out.kind === 'ok' && out.replayed === true, `R1 Klärung nach Primary-Neustart → das eingefrorene Ergebnis (${J(out)})`);
  ok(count() === 1 && ledger() === 1 && calls === before + 1, 'R1 …fachliche Wirkung GENAU EINMAL (keine zweite Buchung, kein zweiter Nachweis)');
  ok(!disk.files.has(a.commandId) && pend.pendingRecords(ctx()).length === 0, 'R1 beantwortet → aus der Ablage entfernt');
  ok(save.describeClarification(out).includes('WAS saved'), 'R1 die Klärung sagt: es war schon gespeichert, nichts wurde hinzugefügt');
}

// ══ R1-b — nie angekommen, PC2 neu geladen: die Klärung führt ihn jetzt genau einmal aus ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  const out1 = await a.send({ amount: 7, note: 'late' }, primaryFetch({ unreachable: true }));
  ok(out1.kind === 'unknown' && count() === 0, 'R1 Verbindung weg, bevor etwas ankam → offen, keine Wirkung');
  await reload();
  const rec = pend.pendingRecords(ctx())[0];
  const out2 = await save.attemptForPending(rec).send(rec.payload, primaryFetch());
  ok(out2.kind === 'ok' && out2.replayed === false && count() === 1, `R1 Klärung → jetzt genau einmal gebucht (${J(out2)})`);
  ok(save.describeClarification(out2).includes('saved once'), 'R1 …und so benannt');
}

// ══ R1-c — kann die Ablage den Vorgang nicht sichern, geht er nicht hinaus ══
{
  primary = freshPrimary();
  const broken = { ...pend.memoryPendingBackend(), write: async () => { throw new Error('disk full'); } };
  freshPc2(broken);
  const before = calls;
  const out = await new save.CommandSaveController(OP).beginAttempt().send({ amount: 1 }, primaryFetch());
  ok(out.kind === 'not_executed' && out.code === save.PENDING_STORE_FAILED && calls === before && count() === 0,
    `R1 Ablage scheitert → NICHTS gesendet, keine Wirkung (${J(out)})`);
  ok(/Not sent \(PENDING_STORE_FAILED\)/.test(fehlertext(out)), 'R1 …und die Meldung sagt es');
}

// ══ R2 — Formular nach unklarem Ausgang geändert ══
{
  primary = freshPrimary(); freshPc2();
  const ctl = new save.CommandSaveController(OP);
  const a = ctl.beginAttempt();
  const orig = { amount: 200, note: 'orig' };
  await a.send(orig, primaryFetch({ loseReply: true }));
  const changed = { amount: 250, note: 'changed' };
  const before = calls;
  const r1 = await ctl.beginAttempt().send(changed, primaryFetch());
  const r2 = await ctl.beginAttempt().send(changed, primaryFetch());
  ok(ctl.beginAttempt().commandId === a.commandId, 'R2 der Wächter bleibt beim offenen Vorgang (keine neue Kennung als Ausweg)');
  ok(r1.kind === 'unknown' && r1.code === save.ORIGINAL_UNRESOLVED && r2.code === save.ORIGINAL_UNRESOLVED && calls === before,
    `R2 die Änderung geht unter dieser Kennung NICHT hinaus — auch nicht bei wiederholtem Klick (${J(r1)})`);
  ok(/changes were NOT sent/.test(fehlertext(r1)) && /clarify the earlier save/.test(fehlertext(r1)) && /edit or a new entry/.test(fehlertext(r1)),
    'R2 die Meldung zeigt den Weg: erst den früheren klären, dann ändern oder neu erfassen');
  const rec = pend.pendingRecords(ctx())[0];
  ok(pend.stableJson(rec.payload) === pend.stableJson(orig) && pend.stableJson(onDisk(a.commandId)?.payload) === pend.stableJson(orig),
    'R2 der ursprüngliche Auftrag bleibt der ursprüngliche (Formularänderung getrennt gehalten)');
  const live = save.attemptForPending(rec);
  ok(live === a, 'R2 die Klärung benutzt DENSELBEN laufenden Versuch wie die Maske');
  const c1 = await live.send(rec.payload, primaryFetch());
  ok(c1.kind === 'ok' && c1.replayed === true && ctl.pendingAttempt() === null, 'R2 geklärt: der ursprüngliche war gespeichert; der Versuch der Maske ist beantwortet');
  const n = ctl.beginAttempt();
  ok(n.commandId !== a.commandId, 'R2 erst jetzt — als eigene Handlung — eine neue Kennung');
  const c2 = await n.send(changed, primaryFetch());
  ok(c2.kind === 'ok' && c2.replayed === false && count() === 2 && countNote('orig') === 1 && countNote('changed') === 1,
    'R2 Wirkung: der ursprüngliche genau einmal, die Änderung genau einmal — nichts doppelt, nichts still');
}

// ══ R3-a — belegter Kennungskonflikt nach Primary-Neustart: korrekt übertragen, Vorgang bleibt offen ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  await a.send({ amount: 300, note: 'A' }, primaryFetch({ unreachable: true }));
  // Unter derselben Kennung steht auf dem Primary ein ANDERER Auftrag (fremder Weg).
  const other = { amount: 999, note: 'B' };
  const elsewhere = await executeCommand(OP, { actor: {}, input: other }, {
    commandId: a.commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-a', role: 'owner', op: OP, payloadHash: hashOf(other),
  } as never);
  ok(elsewhere.kind === 'ok' && count() === 1, 'R3 Aufbau: unter der Kennung ist auf dem Primary schon etwas gebucht');
  primary.restart(); // der Kennungsspeicher der Brücke ist leer — der Konflikt steht nur noch im durablen Nachweis
  const direct = await executeCommand(OP, { actor: {}, input: { amount: 300, note: 'A' } }, {
    commandId: a.commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-a', role: 'owner', op: OP, payloadHash: hashOf({ amount: 300, note: 'A' }),
  } as never) as Reply;
  ok(direct.kind === 'not_executed' && direct.code === 'BRIDGE_COMMAND_ID_CONFLICT',
    `R3 der Renderer meldet den Konflikt aus dem Nachweis als „nicht ausgeführt" statt als Störung (${J(direct)})`);
  ok(routeParts(direct)[0] === 409 && routeParts(direct)[1].outcome === 'not_executed', 'R3 …und Rust gibt ihn weiter wie den Brücken-Konflikt (409, outcome)');
  await reload();
  const rec = pend.pendingRecords(ctx())[0];
  const att = save.attemptForPending(rec);
  const out = await att.send(rec.payload, primaryFetch());
  ok(out.kind === 'not_executed' && out.code === save.COMMAND_ID_CONFLICT, `R3 PC2 bekommt den Konflikt korrekt (${J(out)})`);
  ok(!att.isSettled() && onDisk(rec.commandId)?.state === 'conflict' && pend.pendingRecords(ctx()).length === 1,
    'R3 „dieser Versuch lief nicht" beendet den Vorgang NICHT — er bleibt sichtbar offen (Konflikt)');
  ok(count() === 1 && countNote('A') === 0, 'R3 keine Wirkung durch den abgewiesenen Versuch');
  ok(/holds this save number for different content/.test(fehlertext(out)) && !/^Not saved/.test(fehlertext(out)),
    'R3 die Anzeige sagt Konflikt — nicht „nicht gespeichert, nochmal"');
}

// ══ R3-b — ein nicht ausgeführter Versuch beweist nicht, dass ein früherer nichts bewirkt hat ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  const P = { amount: 40, note: 'auth' };
  await a.send(P, primaryFetch({ loseReply: true }));
  const mine = ctx()!;
  primary.authOk = false;
  const out = await a.send(P, primaryFetch());
  ok(out.kind === 'unknown' && out.code === save.EARLIER_TRY_OPEN, `R3 401 nach einem offenen Versand → weiter offen, nicht „nicht ausgeführt" (${J(out)})`);
  ok(ctx() === null && onDisk(a.commandId)?.state === 'unresolved' && pend.pendingRecords(mine).length === 1,
    'R3 …der Ausweis ist verworfen, der Vorgang bleibt in der Ablage (offen)');
  primary.authOk = true; signIn('user-a');
  const rec = pend.pendingRecords(ctx())[0];
  const c = await save.attemptForPending(rec).send(rec.payload, primaryFetch());
  ok(c.kind === 'ok' && c.replayed === true && count() === 1, 'R3 nach erneuter Anmeldung: Klärung → derselbe eine Vorgang');
}

// ══ R3-c — erster Versand nachweislich nicht ausgeführt (nichts kann angekommen sein) ══
{
  primary = freshPrimary(); freshPc2();
  const ctl = new save.CommandSaveController(OP);
  const a = ctl.beginAttempt();
  const out = await a.send({ amount: 5, note: 'x' }, primaryFetch({ notReady: true }));
  ok(out.kind === 'not_executed' && !disk.files.has(a.commandId) && pend.pendingRecords(ctx()).length === 0,
    'R3 der erste Versand lief nachweislich nicht → nichts offen, nichts in der Ablage');
  const again = await ctl.beginAttempt().send({ amount: 6, note: 'y' }, primaryFetch());
  ok(again.kind === 'ok' && count() === 1 && countNote('y') === 1, 'R3 …danach darf der Auftrag frei geändert gespeichert werden (genau einmal)');
}

// ══ R1-d — mehrere offene Vorgänge überschreiben einander nicht ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  const b = new save.CommandSaveController(OP).beginAttempt();
  await a.send({ amount: 1, note: 'one' }, primaryFetch({ loseReply: true }));
  await b.send({ amount: 2, note: 'two' }, primaryFetch({ loseReply: true }));
  await reload();
  const recs = pend.pendingRecords(ctx());
  ok(recs.length === 2 && new Set(recs.map((r) => r.commandId)).size === 2 && disk.files.size === 2, 'R1 zwei offene Vorgänge = zwei Einträge, keiner überschrieben');
  for (const r of recs) await save.attemptForPending(r).send(r.payload, primaryFetch());
  ok(count() === 2 && countNote('one') === 1 && countNote('two') === 1 && disk.files.size === 0, 'R1 …beide geklärt, jeder genau einmal');
}

// ══ R1-e — Wiederaufnahme nur im passenden Kontext ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  await a.send({ amount: 9, note: 'ctx' }, primaryFetch({ loseReply: true }));
  signIn('user-b');
  await reload();
  ok(pend.pendingRecords(ctx()).length === 0 && pend.pendingElsewhereCount(ctx()) === 1,
    'R1 ein anderer Benutzer sieht den Vorgang nicht als seinen (nur „gehört zu einer anderen Anmeldung")');
  const rec = pend.pendingRecords({ ...ctx()!, userId: 'user-a' })[0];
  const before = calls;
  const out = await save.attemptForPending(rec).send(rec.payload, primaryFetch());
  ok(out.kind === 'not_executed' && out.code === save.PENDING_CONTEXT_MISMATCH && calls === before, 'R1 …und kann ihn nicht unter seinem Ausweis senden');
  signIn('user-b', 'branch-other');
  ok(pend.pendingRecords(ctx()).length === 0, 'R1 andere Filiale: ebenso');
  signIn('user-a', 'branch-main', 'http://other-primary:3011');
  ok(pend.pendingRecords(ctx()).length === 0, 'R1 anderer Primary: ebenso');
  signIn('user-a');
  ok(pend.pendingRecords(ctx()).length === 1 && onDisk(a.commandId) !== null, 'R1 zurück im eigenen Kontext: der Vorgang ist da');
}

// ══ R1-f — eine NEUE Kennung neben einem offenen Vorgang nur ausdrücklich ══
{
  primary = freshPrimary(); freshPc2();
  await new save.CommandSaveController(OP).beginAttempt().send({ amount: 11, note: 'old' }, primaryFetch({ loseReply: true }));
  await reload();
  const ctl = new save.CommandSaveController(OP);
  const before = calls;
  const g1 = await ctl.guardNewEntry();
  ok(g1?.kind === 'unknown' && g1.code === save.EARLIER_SAVE_UNRESOLVED && calls === before,
    `R1 neue Maske derselben Buchung: erst der Hinweis auf den offenen Vorgang, nichts gesendet (${J(g1)})`);
  ok(/still unresolved/.test(fehlertext(g1!)) && /press save again/.test(fehlertext(g1!)), 'R1 …mit dem Weg: klären, oder bewusst als neuen Vorgang bestätigen');
  const g2 = await ctl.guardNewEntry();
  ok(g2 === null, 'R1 der zweite Klick ist die ausdrückliche Entscheidung „neuer, eigener Vorgang"');
  const out = await ctl.beginAttempt().send({ amount: 12, note: 'new' }, primaryFetch());
  ok(out.kind === 'ok' && count() === 2 && pend.pendingRecords(ctx()).length === 1, 'R1 …der neue läuft; der alte bleibt offen, bis er geklärt ist');
  ok(await new save.CommandSaveController('r7c.other').guardNewEntry() === null, 'R1 eine andere Buchung ist nicht betroffen');
}

// ══ R1-g — Bild-/Staging-Verweise, die nicht mehr da sind ══
{
  primary = freshPrimary(); freshPc2();
  const a = new save.CommandSaveController(OP).beginAttempt();
  await a.send({ amount: 5, note: 'photo', staged: 'stg-1' }, primaryFetch({ unreachable: true }));
  await reload(); // inzwischen hat der Primary die nicht abgeholte Ablage aufgeräumt (Karenz 1 h)
  const rec = pend.pendingRecords(ctx())[0];
  const out = await save.attemptForPending(rec).send(rec.payload, primaryFetch());
  ok(out.kind === 'business_error' && out.code === 'STAGED_IMAGE_GONE' && count() === 0, `R1 fehlende Fotos → ein endgültiges, begründetes Nein, keine Wirkung (${J(out)})`);
  ok(/photos of this save are no longer on the main computer/.test(save.describeClarification(out)) && !disk.files.has(rec.commandId),
    'R1 …nachvollziehbar benannt („erneut mit Fotos erfassen"), der Vorgang ist beantwortet');
  primary.staged.add('stg-2');
  const b = new save.CommandSaveController(OP).beginAttempt();
  await b.send({ amount: 6, note: 'photo2', staged: 'stg-2' }, primaryFetch({ loseReply: true }));
  await reload();
  const r2 = pend.pendingRecords(ctx())[0];
  primary.staged.delete('stg-2'); // nach der Buchung aufgeräumt — der Nachweis braucht die Ablage nicht mehr
  const c = await save.attemptForPending(r2).send(r2.payload, primaryFetch());
  ok(c.kind === 'ok' && c.replayed === true && countNote('photo2') === 1, 'R1 schon gebucht: die Klärung braucht die Fotoablage nicht (Replay aus dem Nachweis)');
}

// ══ Verdrahtung: Maske, Leiste, Ablage, Meldungen ══
{
  const sw = src('src/core/data/shared-write.ts');
  ok(/const halt = await controller\.guardNewEntry\(\);\s*\n\s*if \(halt\) return halt as WriteOutcome<T>;\s*\n\s*\}\s*\n[^\n]*\n\s*const attempt = remote \? controller\.beginAttempt\(\) : null;/.test(sw),
    'WIRE useSharedWrite prüft den offenen früheren Vorgang, BEVOR eine Kennung vergeben wird');
  ok(/const halt = await c\.guardNewEntry\(\);\s*\n\s*if \(halt\) \{ setFehler\(fehlertext\(halt\)\); return halt as WriteOutcome<T>; \}\s*\n\s*attempt = c\.beginAttempt\(\);/.test(sw),
    'WIRE useSharedWrites ebenso, je Buchung');
  const bar = src('src/components/shared/PendingSavesBar.tsx');
  ok(/await attemptForPending\(r\)\.send\(r\.payload\)/.test(bar) && !/newCommandId|beginAttempt/.test(bar),
    'WIRE die Leiste klärt mit DERSELBEN Kennung und dem URSPRÜNGLICHEN Auftrag — sie erzeugt nie eine neue');
  const app = src('src/App.tsx');
  ok(/\{clientMode && <PendingSavesBar \/>\}/.test(app), 'WIRE die Leiste steht im Fenster des Clients (PC2)');
  const ps = src('src/core/bridge/pending-saves.ts');
  // Der Ordner kommt vom nativen Resolver (runtime-paths-Vertrag) — derselbe Ort wie seit R7C.
  const rs = src('src-tauri/src/lib.rs');
  ok(/\(await getRuntimePaths\(\)\)\.pendingSavesRoot/.test(ps) && !/appLocalDataDir/.test(ps.replace(/\/\/.*$/gm, ''))
    && /app_local_data_dir\(\)[\s\S]{0,120}\.join\("pending-saves"\)/.test(rs) && /"pendingSavesRoot": pending_saves_root/.test(rs)
    && /await fs\.writeTextFile\(tmp, text\);\s*\n\s*await fs\.rename\(tmp, p\);/.test(ps),
    'WIRE Ablage = eine Datei je Vorgang unter AppLocalData (vom nativen Resolver), über Temp-Datei + Umbenennen');
  const cs = src('src/core/bridge/client-command-save.ts');
  ok(cs.indexOf('await persistPending(rec);') > 0 && cs.indexOf('await persistPending(rec);') < cs.indexOf('const out = await this.transmit('),
    'WIRE gesichert wird VOR dem Versand');
  const reg = src('src/core/bridge/command-registry.ts');
  ok(/if \(err\.code === 'COMMAND_ID_CONFLICT'\) \{\s*\n\s*return \{ kind: 'not_executed', code: BRIDGE_COMMAND_ID_CONFLICT/.test(reg),
    'WIRE der Renderer überträgt den Nachweis-Konflikt als not_executed');
  const routes = src('src-tauri/src/sync/routes.rs');
  ok(/crate::bridge::Reply::NotExecuted \{ code, message \} => \(\s*\n\s*StatusCode::CONFLICT,\s*\n\s*serde_json::json!\(\{ "ok": false, "error": code, "message": message, "outcome": "not_executed" \}\),/.test(routes),
    'WIRE Rust bildet ihn auf 409 + outcome not_executed ab (Beweis: cargo test command_reply)');
}

pend.setPendingBackendForTest(null);
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — r7c pending saves (R1–R3): ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('POST_PARITY_R7C_PENDING_SAVES_PROVED');

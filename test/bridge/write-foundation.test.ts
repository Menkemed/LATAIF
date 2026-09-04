// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3A — die Maschine für Fernschreibvorgänge, geprüft bevor sie einen Kunden hat.
// Run: node test/bridge/write-foundation.test.ts
//
// Die eine Frage, an der alles hängt: Wenn die Antwort auf dem Weg verlorengeht — hat der Auftrag
// stattgefunden, und was passiert beim zweiten Versuch? Ohne durablen Nachweis gibt es darauf
// keine Antwort, nur eine Wette. Deshalb liegt der Nachweis in DERSELBEN Datenbank und DERSELBEN
// Transaktion wie die Buchung, und deshalb wird hier an einer echten sql.js-Datenbank gefahren.
//
// Gefahren werden die ECHTEN Funktionen: `runRemoteCommand`, `lookupCommand`, `recordCommand`,
// `ensureLegacySequence`, `getNextDocumentNumber`. Gestellt sind nur `BEGIN`/`COMMIT` (damit der
// Test die Transaktion selbst kontrollieren kann) und das Speichern.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Der ECHTE Buchungs-/Transaktionseinstieg (`posting.ts`) wird gefahren, nicht nachgebaut —
    // nur seine Datenbankquelle wird gestellt. Er holt sie ueber den Alias, daher diese Regel VOR
    // der allgemeinen `@/`-Regel.
    if (specifier === '@/core/db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand, recordCommand, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { runRemoteCommand, CommandRejected, CommandNotEvaluated } =
  await import('../../src/core/bridge/mutation-engine.ts');
const { resetDurabilityStateForTest, setDurableSaver, isDurabilityDegraded, durabilityDebt,
  markDurabilityDegraded, DURABILITY_DEGRADED } =
  await import('../../src/core/bridge/durability-state.ts');
const { installWriteGuard, isDataMutation } = await import('../../src/core/db/write-guard.ts');
const { resetTransactionHealthForTest, isTransactionUnhealthy, transactionFault, TRANSACTION_UNHEALTHY } =
  await import('../../src/core/db/transaction-health.ts');
const { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } =
  await import('../../src/core/ledger/posting.ts');
const { registerCommand, executeCommand, OP_PROBE } = await import('../../src/core/bridge/command-registry.ts');
const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
const { ensureLegacySequence, legacySpec, LEGACY_SEQUENCES, LEGACY_PADDING, highestIssuedSeq } =
  await import('../../src/core/db/legacy-sequences.ts');
const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { getNextDocumentNumber } = await import('../../src/core/db/helpers.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-04T10:00:00.000Z';
const YEAR = 2026;

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; export(): Uint8Array }

function fresh(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run('CREATE TABLE document_sequences (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL, '
    + 'next_number INTEGER NOT NULL DEFAULT 1, include_year INTEGER NOT NULL DEFAULT 1, '
    + 'padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL, seq_year INTEGER)');
  db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, branch_id TEXT)');
  db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, data TEXT)');
  for (const s of LEGACY_SEQUENCES) {
    db.run(`CREATE TABLE ${s.table} (id TEXT PRIMARY KEY, branch_id TEXT, ${s.column} TEXT)`);
    db.run(`CREATE UNIQUE INDEX ux_${s.table}_no ON ${s.table} (branch_id, ${s.column})`);
  }
  // Eine Geschaeftstabelle, an der die Wirkung sichtbar wird.
  db.run('CREATE TABLE invoices (id TEXT PRIMARY KEY, branch_id TEXT, invoice_number TEXT, gross REAL)');
  setTestDatabase(db as never);
  return db;
}

const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (commandId: string, op = 'invoice.create', hash = 'h1', user = 'u1') => ({
  commandId, tenantId: 'tenant-1', branchId: 'branch-main', userId: user, op, payloadHash: hash,
});

/**
 * Die echten Transaktionsklammern einer sql.js-Datenbank, plus ein Speichern mit einer PLATTE:
 * `state.disk` haelt genau das, was ein gelungenes Speichern hinterlassen hat. Damit laesst sich
 * ein Neustart ehrlich nachstellen — nicht „was im Speicher steht", sondern „was geschrieben wurde".
 */
function deps(db: Db, opts: { failSave?: boolean } = {}) {
  const state = { saves: 0, commits: 0, rollbacks: 0, failSave: opts.failSave === true, disk: null as Uint8Array | null };
  return {
    state,
    deps: {
      db: db as never,
      begin: () => { db.run('BEGIN'); },
      commit: () => { db.run('COMMIT'); state.commits += 1; },
      rollback: () => { db.run('ROLLBACK'); state.rollbacks += 1; },
      durableSave: async () => {
        if (state.failSave) throw new Error('disk full');
        state.disk = db.export();
        state.saves += 1;
      },
      now: () => NOW,
    },
  };
}

// ── 1) Das Schema haelt, was es verspricht ────────────────────────────────
{
  const db = fresh();
  const cols = db.exec("SELECT name FROM pragma_table_info('remote_command_ledger')")[0].values.map((v) => String(v[0]));
  for (const c of ['command_id', 'tenant_id', 'branch_id', 'user_id', 'op', 'payload_hash',
    'status', 'result_json', 'error_code', 'error_message', 'protocol', 'created_at']) {
    ok(cols.includes(c), `SCHEMA ${c} ist gebunden`);
  }
  const pk = db.exec("SELECT name FROM pragma_table_info('remote_command_ledger') WHERE pk = 1")[0].values.map((v) => String(v[0]));
  ok(pk.join(',') === 'command_id', `SCHEMA die Kennung ist der Schluessel (${pk.join(',')})`);

  let threw = false;
  try { db.run("INSERT INTO remote_command_ledger (command_id, tenant_id, branch_id, user_id, op, payload_hash, status, protocol, created_at) VALUES ('x','t','b','u','o','h','half-done',1,'n')"); }
  catch { threw = true; }
  ok(threw, 'SCHEMA es gibt nur zwei erlaubte Zustaende — kein dritter schleicht sich ein');

  // Und er liegt in DIESER Datenbank, nicht in der des Servers.
  const dbSrc = src('src/core/db/database.ts');
  ok(/COMMAND_LEDGER_DDL,/.test(dbSrc), 'SCHEMA die Tabelle entsteht mit der Geschaeftsdatenbank');
  const mig = src('src-tauri/src/sync/migrations.rs');
  ok(!/remote_command_ledger/.test(mig), 'SCHEMA und NICHT in der Server-Datenbank');
}

// ── 2) Wirkung und Nachweis committen gemeinsam ───────────────────────────
{
  const db = fresh();
  const { deps: d, state } = deps(db);
  const id = identity(ID('1'));

  const out = await runRemoteCommand(d, id, (x) => {
    ensureLegacySequence(x as never, legacySpec('ORD'), NOW, YEAR);
    const no = getNextDocumentNumber('ORD');
    (x as unknown as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
      ['inv-1', 'branch-main', no, 110]);
    return { invoiceId: 'inv-1', number: no };
  });

  ok(out.kind === 'ok' && !out.replayed, `ATOMIC der erste Lauf fuehrt aus (${JSON.stringify(out)})`);
  ok((out as { value: { number: string } }).value.number === 'ORD-2026-00001',
    `ATOMIC …und vergibt eine Nummer im bestehenden Format (${JSON.stringify((out as { value: unknown }).value)})`);
  ok(Number(db.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 1, 'ATOMIC die Wirkung steht');
  ok(commandCount(db as never) === 1, 'ATOMIC …und der Nachweis auch');
  ok(state.commits === 1, `ATOMIC in EINEM Commit (${state.commits})`);
  ok(state.saves === 1, `ATOMIC und danach genau einmal gespeichert (${state.saves})`);

  // Beides in derselben Transaktion: das Abbild traegt entweder beides oder nichts.
  const image = new SQL.Database(db.export()) as unknown as Db;
  ok(Number(image.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 1
    && Number(image.exec('SELECT COUNT(*) FROM remote_command_ledger')[0].values[0][0]) === 1,
    'ATOMIC ein Abbild enthaelt Wirkung UND Nachweis');
}

// ── 3) Absturz vor dem Commit: nichts von beidem ──────────────────────────
{
  const db = fresh();
  const { deps: d, state } = deps(db);
  const id = identity(ID('2'));

  let threw: string | null = null;
  try {
    await runRemoteCommand(d, id, (x) => {
      (x as unknown as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
        ['inv-2', 'branch-main', 'ORD-2026-00001', 50]);
      throw new Error('the machine died here');
    });
  } catch (e) { threw = String(e); }

  ok(threw !== null && /died here/.test(threw), 'CRASH die Stoerung wird weitergereicht, nicht verschluckt');
  ok(Number(db.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 0, 'CRASH keine Wirkung');
  ok(commandCount(db as never) === 0,
    'CRASH und KEIN Nachweis — ein Auftrag, der nie lief, darf nicht als gelaufen gelten');
  ok(state.rollbacks === 1 && state.commits === 0, `CRASH zurueckgerollt (${state.rollbacks}/${state.commits})`);
  ok(state.saves === 0, 'CRASH und nichts gespeichert');

  // Die Kennung ist frei: derselbe Auftrag darf erneut versucht werden.
  ok(lookupCommand(db as never, id).kind === 'fresh', 'CRASH die Kennung ist wieder frei');
}

// ── 4) Verlorene Antwort: die Wiederholung fuehrt NICHT erneut aus ────────
{
  const db = fresh();
  const { deps: d } = deps(db);
  const id = identity(ID('3'));
  let domainRuns = 0;

  const handler = (x: unknown) => {
    domainRuns += 1;
    ensureLegacySequence(x as never, legacySpec('REP'), NOW, YEAR);
    const no = getNextDocumentNumber('REP');
    (x as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
      ['inv-3-' + domainRuns, 'branch-main', no, 70]);
    return { number: no, run: domainRuns };
  };

  const first = await runRemoteCommand(d, id, handler);
  ok(first.kind === 'ok' && domainRuns === 1, `RETRY der erste Lauf fuehrt einmal aus (${domainRuns})`);

  // Die Antwort geht auf dem Weg verloren — der Client fragt mit DERSELBEN Kennung erneut.
  // Bewusst abgefangen: faellt die Wiedererkennung aus, laeuft der Geschaeftscode erneut und der
  // Nachweis kollidiert mit sich selbst. Das soll als klares Rot sichtbar werden, nicht als Absturz.
  let second: Awaited<ReturnType<typeof runRemoteCommand>> | null = null;
  let retryThrew: string | null = null;
  try { second = await runRemoteCommand(d, id, handler); } catch (e) { retryThrew = String(e); }
  ok(retryThrew === null, `RETRY die Wiederholung scheitert nicht (${retryThrew})`);
  ok(domainRuns === 1, `RETRY die Wiederholung fuehrt NICHT erneut aus (${domainRuns})`);
  ok(second?.kind === 'ok' && second.replayed === true, 'RETRY …sie ist als Wiederholung erkannt');
  ok(JSON.stringify((second as { value: unknown } | null)?.value) === JSON.stringify((first as { value: unknown }).value),
    `RETRY und liefert genau dasselbe eingefrorene Ergebnis (${JSON.stringify((second as { value: unknown } | null)?.value)})`);
  ok(Number(db.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 1,
    'RETRY es gibt weiterhin genau eine Rechnung');
  ok(Number(db.exec("SELECT next_number FROM document_sequences WHERE doc_type='REP'")[0].values[0][0]) === 2,
    'RETRY und die Nummer wurde nur einmal verbraucht');
}

// ── 5) Dieselbe Kennung, etwas anderes dahinter ───────────────────────────
{
  const db = fresh();
  const { deps: d } = deps(db);
  const id = identity(ID('4'));
  let runs = 0;
  await runRemoteCommand(d, id, () => { runs += 1; return { ok: true }; });

  for (const [what, other] of [
    ['payload', identity(ID('4'), 'invoice.create', 'DIFFERENT')],
    ['operation', identity(ID('4'), 'invoice.cancel', 'h1')],
    ['user', identity(ID('4'), 'invoice.create', 'h1', 'someone-else')],
  ] as const) {
    const out = await runRemoteCommand(d, other, () => { runs += 1; return { ok: true }; });
    ok(out.kind === 'rejected' && out.code === 'COMMAND_ID_CONFLICT',
      `CONFLICT ein anderer ${what} unter derselben Kennung wird abgewiesen (${JSON.stringify(out)})`);
  }
  ok(runs === 1, `CONFLICT und der Geschaeftscode lief kein zweites Mal (${runs})`);
  ok(commandCount(db as never) === 1, 'CONFLICT es bleibt bei einem Nachweis');
}

// ── 6) Was eingefroren wird: das Urteil der Domaene — und nur das ─────────
//
// Dieselbe Kennung ist eine WIEDERHOLUNG, kein neuer Versuch. Deshalb friert JEDES definitive
// fachliche Urteil ein, auch das zustandsabhaengige: `STOCK_UNAVAILABLE` war die Antwort auf genau
// diese Frage zu genau diesem Zeitpunkt. Waere es nicht eingefroren, haenge das Ergebnis einer
// Wiederholung davon ab, WANN sie ankommt — und niemand wuesste hinterher, welche der beiden
// Antworten der Client gesehen hat. Wer wirklich neu fragen will, schickt eine neue Kennung.
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d } = deps(db);

  const input = await runRemoteCommand(d, identity(ID('5')), () => {
    throw new CommandRejected('CUSTOMER_REQUIRED', 'no customer in the request');
  });
  ok(input.kind === 'rejected' && input.code === 'CUSTOMER_REQUIRED' && input.frozen === true,
    `CLASS ein Eingabe-Urteil kommt zurueck und ist endgueltig (${JSON.stringify(input)})`);
  ok(commandCount(db as never) === 1, 'CLASS …und wird eingefroren');
  let againRuns = 0;
  const again = await runRemoteCommand(d, identity(ID('5')), () => { againRuns += 1; return { ok: true }; });
  ok(again.kind === 'rejected' && again.replayed === true && againRuns === 0,
    'CLASS die Wiederholung bekommt dieselbe Ablehnung, ohne den Code auszufuehren');

  // Das ZUSTANDSABHAENGIGE Urteil — der Fall, der frueher falsch eingeordnet war. Bewusst
  // abgefangen: wird es wieder als Stoerung behandelt, soll das ein rotes Ergebnis sein und kein
  // Abbruch, der den Rest des Gates verschluckt.
  let stock: Awaited<ReturnType<typeof runRemoteCommand>> | { kind: 'threw'; code: string } =
    { kind: 'threw', code: 'never ran' };
  try {
    stock = await runRemoteCommand(d, identity(ID('6')), () => {
      throw new CommandRejected('STOCK_UNAVAILABLE', 'nothing left');
    });
  } catch (e) { stock = { kind: 'threw', code: String(e) }; }
  ok(stock.kind === 'rejected' && stock.code === 'STOCK_UNAVAILABLE' && stock.frozen === true,
    `CLASS auch STOCK_UNAVAILABLE ist ein Urteil (${JSON.stringify(stock)})`);
  ok(lookupCommand(db as never, identity(ID('6'))).kind === 'replay',
    'CLASS …und wird eingefroren — dieselbe Kennung fragt nicht neu, sie wiederholt');

  let later = 0;
  const retry = await runRemoteCommand(d, identity(ID('6')), () => { later += 1; return { sold: true }; });
  ok(retry.kind === 'rejected' && retry.code === 'STOCK_UNAVAILABLE' && retry.replayed === true && later === 0,
    `CLASS die Wiederholung bekommt dasselbe Nein, ohne die Domaene zu fragen (${later})`);

  // Ein bewusst NEUER Versuch braucht eine NEUE Kennung — und darf gelingen.
  const deliberate = await runRemoteCommand(d, identity(ID('9')), () => { later += 1; return { sold: true }; });
  ok(deliberate.kind === 'ok' && later === 1,
    `CLASS ein neuer Versuch mit neuer Kennung darf gelingen (${later})`);

  // Kein Urteil: der Kennungskonflikt kam nie zur Domaene.
  const conflict = await runRemoteCommand(d, identity(ID('5'), 'invoice.create', 'ANDERS'), () => ({ ok: true }));
  ok(conflict.kind === 'rejected' && conflict.code === 'COMMAND_ID_CONFLICT' && conflict.frozen === false,
    `CLASS ein Kennungskonflikt ist KEIN Urteil und wird nicht eingefroren (${JSON.stringify(conflict)})`);

  // Eine Stoerung ist erst recht keine Ablehnung: sie hinterlaesst nichts.
  let boom: string | null = null;
  try { await runRemoteCommand(d, identity(ID('7')), () => { throw new Error('database is on fire'); }); }
  catch (e) { boom = String(e); }
  ok(boom !== null, 'CLASS eine Stoerung wird geworfen');
  ok(lookupCommand(db as never, identity(ID('7'))).kind === 'fresh',
    'CLASS …und NIE als beantworteter Geschaeftsvorgang festgehalten');
}

// ── 7) Speichern gehoert zur Antwort — und ein Fehlschlag hinterlaesst Spuren ──
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d, state } = deps(db, { failSave: true });
  let threw: string | null = null;
  try {
    await runRemoteCommand(d, identity(ID('8')), (x) => {
      (x as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
        ['inv-8', 'branch-main', 'ORD-2026-00009', 10]);
      return { ok: true };
    });
  } catch (e) { threw = String(e); }
  ok(threw !== null && /disk full/.test(threw), 'DURABILITY ein gescheitertes Speichern meldet keinen Erfolg');
  ok(state.commits === 1, 'DURABILITY der Commit war schon durch — Wirkung und Nachweis stehen gemeinsam im Speicher');
  ok(state.disk === null, 'DURABILITY …und auf der Platte steht davon nichts');
  const image = new SQL.Database(db.export()) as unknown as Db;
  ok(Number(image.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0])
    === Number(image.exec('SELECT COUNT(*) FROM remote_command_ledger')[0].values[0][0]),
    'DURABILITY beide gemeinsam — nie eines ohne das andere');

  // Der Prozess merkt sich die Schuld. Das ist der ganze Unterschied zu vorher: ohne diesen
  // Zustand saehe die naechste Wiederholung nur den Nachweis im Speicher und meldete Erfolg.
  ok(isDurabilityDegraded() === true, 'DURABILITY der Prozess merkt sich, dass er der Platte etwas schuldet');
  ok(durabilityDebt()?.since === NOW && /disk full/.test(String(durabilityDebt()?.reason)),
    `DURABILITY …mit Zeitpunkt und Grund (${JSON.stringify(durabilityDebt())})`);

  const engine = src('src/core/bridge/mutation-engine.ts');
  const requireAt = engine.indexOf('await requireDurable(deps.durableSave');
  const beginAt = engine.indexOf('deps.begin();');
  const commitAt = engine.indexOf('deps.commit();');
  const saveAt = engine.lastIndexOf('await ensureDurable(deps.durableSave');
  const returnAt = engine.indexOf("return { kind: 'ok', value: record.result");
  ok(requireAt > 0 && requireAt < beginAt && beginAt < commitAt && commitAt < saveAt && saveAt < returnAt,
    'DURABILITY die Reihenfolge im Code ist durabel sein → commit → speichern → antworten');
}

// ── 8) Solange die Schuld offen ist, wird nichts bestaetigt ───────────────
//
// Der Zustand ist prozessweit, weil die Geschaeftsdatenbank EIN Abbild ist: ein fehlgeschlagenes
// Speichern gefaehrdet nicht den einen Auftrag, sondern alles seit dem letzten Schreiben.
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d } = deps(db, { failSave: true });
  try { await runRemoteCommand(d, identity(ID('10')), () => ({ ok: true })); } catch { /* offener Ausgang */ }
  ok(isDurabilityDegraded(), 'GATE die Ausgangslage: eine offene Speicherschuld');

  // (a) Kein NEUER Fernschreibvorgang — er wuerde die Schuld nur vergroessern.
  let ranNew = 0; let gateErr: string | null = null;
  try { await runRemoteCommand(d, identity(ID('11')), () => { ranNew += 1; return { ok: true }; }); }
  catch (e) { gateErr = String(e); }
  ok(ranNew === 0, `GATE eine neue Fernmutation beginnt gar nicht erst (${ranNew} Laeufe)`);
  ok(gateErr !== null && /could not be written/.test(gateErr), `GATE …und meldet einen offenen Ausgang (${gateErr})`);
  ok(commandCount(db as never) === 1, 'GATE es kommt kein zweiter Nachweis dazu');

  // (b) Auch die LOKALE Schreibreihenfolge: erst speichern, sonst gar nicht anfangen.
  setDurableSaver(async () => { throw new Error('disk still full'); });
  let localRan = 0; let localErr: string | null = null;
  try { await runExclusive(() => { localRan += 1; return 1; }); } catch (e) { localErr = String(e); }
  ok(localRan === 0 && localErr !== null,
    `GATE eine lokale Geschaeftsmutation beginnt nicht auf einem ungeschriebenen Stand (${localRan})`);

  // (c) Fernlesen bestaetigt nichts, was ein Absturz wegnehmen wuerde.
  registerCommand('test.read', { kind: 'read', handler: () => ({ rows: 0 }) });
  const read = await executeCommand('test.read', null);
  ok(read.kind === 'infrastructure_error' && read.code === DURABILITY_DEGRADED,
    `GATE ein Fernlesen wird abgewiesen statt bestaetigt (${JSON.stringify(read)})`);
  ok(read.kind !== 'business_error', 'GATE …und ausdruecklich NICHT als fachliches Nein');

  // (d) Die Probe bleibt erreichbar: sie liest nichts und bestaetigt nichts.
  const probe = await executeCommand(OP_PROBE, { echo: 'alive' });
  ok(probe.kind === 'ok', 'GATE die Probe antwortet weiter — sonst waere der Rechner von aussen einfach stumm');

  // (e) Gelingt das Speichern wieder, ist die Schuld beglichen und alles laeuft weiter.
  let flushes = 0;
  setDurableSaver(async () => { flushes += 1; });
  const after = await executeCommand('test.read', null);
  ok(after.kind === 'ok' && flushes === 1, `GATE nach gelungenem Nachholen wird wieder gelesen (${flushes})`);
  ok(!isDurabilityDegraded(), 'GATE …und die Schuld ist beglichen');
  const afterAgain = await executeCommand('test.read', null);
  ok(afterAgain.kind === 'ok' && flushes === 1, `GATE im Normalfall kostet die Sperre nichts (${flushes})`);
}

// ── 9) Neustart: was auf der Platte steht, entscheidet ────────────────────
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d, state } = deps(db);
  // Ein sauber gespeicherter Auftrag beschreibt den Stand, den ein Neustart faende.
  await runRemoteCommand(d, identity(ID('12')), () => ({ seed: true }));
  ok(state.disk !== null, 'RESTART ein gelungener Auftrag hinterlaesst ein Abbild auf der Platte');

  // Szenario A: Speichern scheitert, dann stirbt der Prozess.
  state.failSave = true;
  let domainRuns = 0;
  const sell = (x: unknown) => {
    domainRuns += 1;
    (x as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
      ['inv-13', 'branch-main', 'ORD-2026-00013', 13]);
    return { invoiceId: 'inv-13' };
  };
  try { await runRemoteCommand(d, identity(ID('13')), sell); } catch { /* offener Ausgang */ }
  ok(domainRuns === 1 && isDurabilityDegraded(), 'RESTART A der Auftrag lief, das Speichern nicht');

  // Der Prozess stirbt. Was der Neustart findet, ist das LETZTE gespeicherte Abbild.
  const restarted = new SQL.Database(state.disk as Uint8Array) as unknown as Db;
  setTestDatabase(restarted as never);
  resetDurabilityStateForTest();
  ok(Number(restarted.exec("SELECT COUNT(*) FROM invoices WHERE id='inv-13'")[0].values[0][0]) === 0,
    'RESTART A nach dem Neustart ist von der Wirkung nichts da…');
  ok(lookupCommand(restarted as never, identity(ID('13'))).kind === 'fresh',
    'RESTART A …und auch kein Nachweis — kein Phantom-Erfolg');

  const { deps: d2, state: s2 } = deps(restarted);
  const again = await runRemoteCommand(d2, identity(ID('13')), sell);
  ok(again.kind === 'ok' && again.replayed === false && domainRuns === 2,
    `RESTART A die Wiederholung fuehrt aus — und zwar genau einmal (${domainRuns})`);
  ok(Number(restarted.exec("SELECT COUNT(*) FROM invoices WHERE id='inv-13'")[0].values[0][0]) === 1,
    'RESTART A es gibt genau eine Rechnung, nicht zwei');
  ok(s2.saves === 1 && s2.disk !== null, 'RESTART A …die diesmal auch geschrieben wurde');

  // Szenario B: derselbe Prozess, kein Neustart.
  resetDurabilityStateForTest();
  const db3 = fresh();
  const { deps: d3, state: s3 } = deps(db3);
  let runsB = 0;
  s3.failSave = true;
  const count = () => { runsB += 1; return { n: runsB }; };
  try { await runRemoteCommand(d3, identity(ID('14')), count); } catch { /* offener Ausgang */ }
  ok(runsB === 1 && isDurabilityDegraded(), 'RESTART B erster Lauf: Wirkung im Speicher, Schuld offen');

  let blocked: string | null = null;
  try { await runRemoteCommand(d3, identity(ID('14')), count); } catch (e) { blocked = String(e); }
  ok(runsB === 1, `RESTART B die Wiederholung fuehrt KEINEN zweiten Domainlauf aus (${runsB})`);
  ok(blocked !== null, 'RESTART B …und meldet keinen Erfolg, solange nichts auf der Platte steht');

  // Die Platte kommt zurueck: erst speichern, DANN darf das eingefrorene Ergebnis heraus.
  s3.failSave = false;
  const settled = await runRemoteCommand(d3, identity(ID('14')), count);
  ok(settled.kind === 'ok' && settled.replayed === true && runsB === 1,
    `RESTART B danach kommt das eingefrorene Ergebnis des EINEN Laufs (${runsB})`);
  ok(JSON.stringify((settled as { value: unknown }).value) === JSON.stringify({ n: 1 }),
    `RESTART B genau dieses Ergebnis (${JSON.stringify((settled as { value: unknown }).value)})`);
  ok(!isDurabilityDegraded() && s3.disk !== null, 'RESTART B …und der Stand steht jetzt auf der Platte');
}

// ── 10) Verlorene Antwort auf ein fachliches Nein ─────────────────────────
//
// Der teure Fall: Der Client fragt „verkauf mir das Stueck", die Ware ist weg, die Antwort geht
// verloren. Inzwischen kommt die Ware zurueck. Die Wiederholung DERSELBEN Kennung muss weiterhin
// „nicht verfuegbar" sagen — sonst entscheidet die Laufzeit des Netzes, was gekauft wurde.
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d } = deps(db);
  let stock = 0;
  const sell = (x: unknown) => {
    if (stock <= 0) throw new CommandRejected('STOCK_UNAVAILABLE', 'nothing left');
    stock -= 1;
    (x as Db).run('INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES (?,?,?,?)',
      ['inv-' + stock, 'branch-main', 'ORD-2026-0002' + stock, 20]);
    return { sold: true };
  };

  // Abgefangen wie in §6: eine falsche Einordnung soll rot leuchten, nicht abbrechen.
  let first: Awaited<ReturnType<typeof runRemoteCommand>> | { kind: 'threw' } = { kind: 'threw' };
  try { first = await runRemoteCommand(d, identity(ID('15')), sell); } catch { first = { kind: 'threw' }; }
  ok(first.kind === 'rejected' && first.code === 'STOCK_UNAVAILABLE' && first.frozen === true,
    'LOST die Ware ist weg — das Nein wird eingefroren');

  stock = 5; // die Ware kommt zurueck, waehrend der Client auf seine verlorene Antwort wartet

  let repeat: Awaited<ReturnType<typeof runRemoteCommand>> | { kind: 'threw' } = { kind: 'threw' };
  try { repeat = await runRemoteCommand(d, identity(ID('15')), sell); } catch { repeat = { kind: 'threw' }; }
  ok(repeat.kind === 'rejected' && repeat.code === 'STOCK_UNAVAILABLE' && repeat.replayed === true,
    `LOST die Wiederholung bekommt dasselbe Nein (${JSON.stringify(repeat)})`);
  ok(stock === 5, `LOST …und es wurde nichts verkauft (${stock})`);
  ok(Number(db.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 0, 'LOST keine Rechnung entstanden');

  // Der bewusste neue Versuch: neue Kennung, neue Frage — und jetzt darf er gelingen.
  const deliberate = await runRemoteCommand(d, identity(ID('16')), sell);
  ok(deliberate.kind === 'ok' && stock === 4,
    `LOST ein neuer Versuch mit neuer Kennung verkauft (${stock})`);
  ok(Number(db.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0]) === 1, 'LOST …genau einmal');
}

// ── 11) Die vier Alt-Nummernkreise ─────────────────────────────────────────
{
  const db = fresh();
  // Bestand aus der Zeit vor der Umstellung — inklusive einer Nummer, die nur noch im Log steht.
  db.run("INSERT INTO consignments (id, branch_id, consignment_number) VALUES ('c1','branch-main','CON-2026-00007')");
  db.run("INSERT INTO sync_changelog (table_name, data) VALUES ('consignments', ?)",
    [JSON.stringify({ consignment_number: 'CON-2026-00011' })]);
  db.run("INSERT INTO offers (id, branch_id, offer_number) VALUES ('o1','branch-main','OFF-2026-00003')");
  db.run("INSERT INTO orders (id, branch_id, order_number) VALUES ('r1','branch-main','ORD-2025-00099')");

  const expected: Record<string, number> = { CON: 12, OFF: 4, ORD: 1, REP: 1 };
  for (const spec of LEGACY_SEQUENCES) {
    const next = ensureLegacySequence(db as never, spec, NOW, YEAR);
    ok(next === expected[spec.docType], `SEQ ${spec.docType} setzt bei ${expected[spec.docType]} fort (${next})`);
  }
  ok(highestIssuedSeq(db as never, legacySpec('CON'), YEAR) === 11,
    'SEQ eine geloeschte Nummer bleibt vergeben — sie steht im Log');
  ok(highestIssuedSeq(db as never, legacySpec('ORD'), YEAR) === 0,
    'SEQ und ein anderes Jahr zaehlt nicht mit');

  // Format und Praefix bleiben.
  const rows = db.exec('SELECT doc_type, prefix, padding, include_year FROM document_sequences ORDER BY doc_type');
  for (const r of rows[0].values) {
    ok(Number(r[2]) === LEGACY_PADDING && Number(r[3]) === 1,
      `SEQ ${r[0]}: fuenfstellig mit Jahr (${r[2]}/${r[3]})`);
  }
  ok(getNextDocumentNumber('CON') === 'CON-2026-00012', 'SEQ die naechste Nummer sieht aus wie die alten');

  // Historische Dokumente bleiben, wie sie sind.
  ok(String(db.exec("SELECT consignment_number FROM consignments WHERE id='c1'")[0].values[0][0]) === 'CON-2026-00007',
    'SEQ nichts wird umnummeriert');

  // Ein eingestellter Praefix gewinnt.
  const db2 = fresh();
  db2.run("INSERT INTO settings (key, value) VALUES ('offer.number_prefix','ANG')");
  ensureLegacySequence(db2 as never, legacySpec('OFF'), NOW, YEAR);
  ok(getNextDocumentNumber('OFF') === 'ANG-2026-00001', 'SEQ der eingestellte Praefix bleibt gueltig');

  // Idempotent, und nie rueckwaerts.
  const db3 = fresh();
  ensureLegacySequence(db3 as never, legacySpec('REP'), NOW, YEAR);
  getNextDocumentNumber('REP'); getNextDocumentNumber('REP');
  const before = Number(db3.exec("SELECT next_number FROM document_sequences WHERE doc_type='REP'")[0].values[0][0]);
  ensureLegacySequence(db3 as never, legacySpec('REP'), NOW, YEAR);
  const after = Number(db3.exec("SELECT next_number FROM document_sequences WHERE doc_type='REP'")[0].values[0][0]);
  ok(before === after && after === 3, `SEQ ein zweiter Aufruf senkt nichts (${before} → ${after})`);

  // Und der bereits migrierte Transfer-Vertrag bleibt unberuehrt.
  const trf = src('src/core/agents/transfer-sequence.ts');
  ok(/TRANSFER_PADDING = 5/.test(trf) && /TRANSFER_DOC_TYPE = 'TRF'/.test(trf),
    'SEQ der TRF-Vertrag ist unveraendert');
  ok(!LEGACY_SEQUENCES.some((s) => s.docType === 'TRF'), 'SEQ …und wird hier nicht zweitverwaltet');
}

// ── 12) Die Verdrahtung: kein alter Nummerngeber mehr, kein offenes Tor ────
{
  let legacyCalls: string[] = [];
  for (const f of ['consignmentStore', 'offerStore', 'orderStore', 'repairStore']) {
    const t = src(`src/stores/${f}.ts`);
    for (const line of t.split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith('//')) continue;
      if (/getNextNumber\(/.test(line)) legacyCalls.push(`${f}: ${s}`);
    }
    ok(/ensureLegacySequence\(/.test(t) && /getNextDocumentNumber\(/.test(t),
      `WIRED ${f} zieht seine Nummer aus dem durablen Zaehler`);
  }
  ok(legacyCalls.length === 0, `WIRED kein produktiver MAX()+1-Aufruf mehr (${legacyCalls.join(' | ') || 'keiner'})`);

  // C3B hat das Tor NICHT aufgemacht, sondern EINEN Namen freigegeben. Der Unterschied ist der
  // ganze Punkt: ein Schalter haette jede kuenftige Mutation mitgenommen.
  const registry = src('src/core/bridge/command-registry.ts');
  ok(!/export const REMOTE_MUTATIONS_ENABLED/.test(registry), 'WIRED der globale Schalter ist weg…');
  ok(/export const ALLOWED_MUTATIONS: readonly string\[\] = \['invoices\.create'\];/.test(registry),
    'WIRED …und an seiner Stelle steht genau ein freigegebener Name');
  const bridgeRs = src('src-tauri/src/bridge.rs');
  const list = bridgeRs.slice(bridgeRs.indexOf('pub const REMOTE_OPS'), bridgeRs.indexOf('];', bridgeRs.indexOf('pub const REMOTE_OPS')));
  const ops = (list.match(/OP_[A-Z_]+/g) || []).map((n) => {
    const m = bridgeRs.match(new RegExp(`${n}: &str = "([^"]+)"`));
    return m ? m[1] : n;
  });
  ok(ops.length === 8, `WIRED die Liste ist um GENAU einen Namen gewachsen: 8 (${ops.length})`);
  ok(ops.filter((o) => o.endsWith('.list') || o.endsWith('.get')).length === 6
    && ops.includes('bridge.probe') && ops.includes('invoices.create'),
    'WIRED eine Probe, sechs Lesevorgaenge, EINE Mutation');
  const engine = src('src/core/bridge/mutation-engine.ts');
  ok(!/registerCommand/.test(engine), 'WIRED die Maschine registriert selbst nichts');
}

// ── 13) Wer darf in eine äußere Transaktion — und wer noch nicht ──────────
//
// Die Frage war nicht, ob man außen ein `BEGIN` legen KANN, sondern ob die inneren Funktionen eine
// bereits offene Transaktion respektieren. Das Haus hat den Mechanismus: `transaction-context`
// zählt die Tiefe, `enterTransaction()` meldet nur der ÄUSSERSTEN Ebene, dass sie ein `BEGIN`
// schuldet, und `posting.ts` fragt an jeder seiner drei Stellen `inLedgerTransaction()`. Wer sich
// daran hält, verschachtelt sich sauber; wer selbst `BEGIN` ruft, sprengt die äußere Klammer.
{
  const ctx = src('src/core/db/transaction-context.ts');
  ok(/export function enterTransaction/.test(ctx) && /return outermost/.test(ctx),
    'TXAUDIT der Tiefenzaehler existiert und nennt die aeusserste Ebene');
  const posting = src('src/core/ledger/posting.ts');
  ok((posting.match(/const ambient = inLedgerTransaction\(\);/g) || []).length === 3,
    'TXAUDIT die Buchung respektiert an jeder Stelle eine offene Transaktion');
  ok(/if \(!ambient\) db\.run\('BEGIN'\);/.test(posting), 'TXAUDIT …und oeffnet nur, wenn keine laeuft');
  ok(/const outermost = enterTransaction\(\);/.test(posting) && /markSavePending\(\);/.test(posting),
    'TXAUDIT die aeussere Klammer merkt sich genau EINEN faelligen Save');

  // Wer heute schon eine aeussere Klammer setzt — die sind sofort C3B-tauglich.
  const outerToday = ['invoiceStore', 'purchaseStore', 'salesReturnStore', 'expenseStore',
    'orderPaymentStore', 'supplierStore'];
  for (const f of outerToday) {
    ok(/beginLedgerTransaction/.test(src(`src/stores/${f}.ts`)), `TXAUDIT ${f} setzt heute schon eine aeussere Klammer`);
  }
  // Wer heute keine setzt, aber ueber `postX` geht: seine Teile sind einzeln atomar, zusammen noch
  // nicht — eine aeussere Klammer in C3B macht sie es, ohne die Stores umzuschreiben.
  for (const f of ['consignmentStore', 'orderStore', 'repairStore', 'agentStore']) {
    const t = src(`src/stores/${f}.ts`);
    ok(!/beginLedgerTransaction/.test(t), `TXAUDIT ${f} hat heute keine aeussere Klammer…`);
    ok(/post[A-Z]/.test(t), `TXAUDIT …bucht aber ueber die Buchungsschicht, die eine respektiert (${f})`);
  }
  // Angebote buchen gar nicht — reine Domaenenschreibvorgaenge, trivial einklammerbar.
  ok(!/post[A-Z]/.test(src('src/stores/offerStore.ts')), 'TXAUDIT Angebote buchen nichts');

  // Und der eine, der es NICHT ist. Offen benannt statt uebersehen.
  const coordinator = src('src/core/media/coordinator.ts');
  ok(/this\.db\.run\('BEGIN IMMEDIATE'\);/.test(coordinator),
    'TXAUDIT der Medien-Koordinator oeffnet eine eigene Transaktion…');
  ok(!/isTransactionActive|inLedgerTransaction|enterTransaction/.test(coordinator),
    'TXAUDIT …ohne den Tiefenzaehler zu fragen — Produkt-mit-Medien ist damit NICHT C3B-tauglich');
}

// ── 14) Die Speicherschuld erreicht JEDEN Geschaeftsschreiber ─────────────
//
// `runExclusive` deckte nur die Wege ab, die tatsaechlich durch die Warteschlange gehen: Produkt,
// Dokument, Mobile-Drain. Rechnung, Einkauf, Auftragszeile, Reparatur und der taegliche
// Automatiklauf schreiben synchron ueber `getDatabase().run(...)` — die teuersten Vorgaenge liefen
// also an der Sperre vorbei. Die Bremse sitzt deshalb jetzt dort, wo die Datenbank AUSGEGEBEN wird.
{
  resetDurabilityStateForTest();
  const db = fresh();
  installWriteGuard(db as never); // genau das, was `getDatabase()` in database.ts tut
  db.run("INSERT INTO offers (id, branch_id, offer_number) VALUES ('o1','branch-main','OFF-2026-00001')");

  // Die Schuld entsteht ECHT: ein Fernauftrag committet, sein Speichern scheitert.
  const { deps: d, state } = deps(db, { failSave: true });
  try { await runRemoteCommand(d, identity(ID('17')), () => ({ ok: true })); } catch { /* offener Ausgang */ }
  ok(isDurabilityDegraded() && state.disk === null,
    'WRITERS Ausgangslage: Remote A ist committet, die Persistenz von A ist gescheitert');

  // (a) Rechnung/Einkauf — der ECHTE aeussere Klammergriff aus `posting.ts`, nicht nachgebaut.
  const INSERT_B = "INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('B','branch-main','INV-B',10)";
  let rows = 0; let localErr: string | null = null;
  try {
    beginLedgerTransaction();
    db.run(INSERT_B);
    rows += 1;
    commitLedgerTransaction();
  } catch (e) { localErr = String(e); rollbackLedgerTransaction(); }
  ok(rows === 0, `WRITERS die lokale Rechnung B fuehrt keinen Businesswrite aus (${rows})`);
  ok(localErr !== null && /unsaved since/.test(localErr), `WRITERS …sie wird vorher abgewiesen (${localErr})`);
  ok(Number(db.exec("SELECT COUNT(*) FROM invoices WHERE id='B'")[0].values[0][0]) === 0,
    'WRITERS und in der Tabelle steht nichts');

  // Die Klammer selbst, das Lesen und das Schema bleiben frei — sonst kaeme eine offene
  // Transaktion nicht mehr zurueck und ein Neustart koennte sein Schema nicht herstellen.
  let stillUsable = true;
  try {
    db.run('BEGIN'); db.run('ROLLBACK');
    db.exec('SELECT COUNT(*) FROM invoices');
    db.run('CREATE TABLE IF NOT EXISTS probe_t (id TEXT)');
  } catch { stillUsable = false; }
  ok(stillUsable, 'WRITERS Klammer, Lesen und Schema bleiben frei — die Bremse sperrt sich nicht selbst aus');

  // (b) Der taegliche Automatiklauf. Die Anweisung steht woertlich so in `daily-sweep.ts`.
  let sweepErr: string | null = null;
  try { db.run("UPDATE offers SET status = 'expired', updated_at = ? WHERE id = ?", [NOW, 'o1']); }
  catch (e) { sweepErr = String(e); }
  ok(sweepErr !== null, 'WRITERS auch die Automatik kommt nicht durch — sie hat keine Warteschlange');

  // (c) Produkt/Mobile: der asynchrone Weg kann warten, also holt er zuerst nach.
  let flushes = 0; let productRan = 0;
  setDurableSaver(async () => { flushes += 1; throw new Error('disk still full'); });
  let asyncErr: string | null = null;
  try { await runExclusive(() => { productRan += 1; return 1; }); } catch (e) { asyncErr = String(e); }
  ok(productRan === 0 && asyncErr !== null && flushes === 1,
    `WRITERS der Produkt-/Mobile-Weg versucht zu speichern und faellt dann geschlossen aus (${flushes}/${productRan})`);

  // (d) Die Platte kommt zurueck — beide Wege laufen wieder.
  setDurableSaver(async () => { flushes += 1; });
  const healed = await runExclusive(() => { productRan += 1; return 1; });
  ok(healed === 1 && productRan === 1 && !isDurabilityDegraded(),
    'WRITERS nach gelungenem Nachholen laeuft der asynchrone Weg normal');
  let postHeal: string | null = null;
  try { beginLedgerTransaction(); db.run(INSERT_B); commitLedgerTransaction(); }
  catch (e) { postHeal = String(e); rollbackLedgerTransaction(); }
  ok(postHeal === null && Number(db.exec("SELECT COUNT(*) FROM invoices WHERE id='B'")[0].values[0][0]) === 1,
    `WRITERS und die lokale Rechnung B danach ebenfalls (${postHeal})`);

  // (e) Der synchrone Weg kann nicht warten — aber er stoesst das Nachholen an, sonst bliebe die
  //     Sperre stehen, auch wenn die Platte laengst zurueck ist.
  markDurabilityDegraded('disk hiccup', NOW);
  let healFlushes = 0;
  setDurableSaver(async () => { healFlushes += 1; });
  const INSERT_C = "INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('C','branch-main','INV-C',5)";
  let firstTry: string | null = null;
  try { db.run(INSERT_C); } catch (e) { firstTry = String(e); }
  ok(firstTry !== null, 'WRITERS ein synchroner Schreiber wird abgewiesen…');
  await new Promise((r) => setTimeout(r, 0));
  ok(healFlushes === 1 && !isDurabilityDegraded(),
    `WRITERS …stoesst dabei aber selbst das Nachholen an (${healFlushes})`);
  let secondTry: string | null = null;
  try { db.run(INSERT_C); } catch (e) { secondTry = String(e); }
  ok(secondTry === null && Number(db.exec("SELECT COUNT(*) FROM invoices WHERE id='C'")[0].values[0][0]) === 1,
    `WRITERS der naechste Versuch des Benutzers laeuft durch (${secondTry})`);

  // (f) Was die Bremse greift, ist eng gefasst — und sie sitzt an EINER Stelle, nicht in 28 Stores.
  for (const [sql, mutating] of [
    ["INSERT INTO invoices (id) VALUES ('x')", true],
    ['   update invoices set gross = 1', true],
    ['DELETE FROM invoices', true],
    ["BEGIN; INSERT INTO invoices (id) VALUES ('x')", true],
    ['SELECT * FROM invoices', false],
    ['BEGIN', false], ['COMMIT', false], ['ROLLBACK', false],
    ['CREATE TABLE x (id TEXT)', false],
    ['PRAGMA foreign_keys = ON', false],
  ] as const) {
    ok(isDataMutation(sql) === mutating, `WRITERS Bremse greift richtig bei „${sql.slice(0, 30)}"`);
  }
  const dbSrc = src('src/core/db/database.ts');
  ok(/return installWriteGuard\(db\);/.test(dbSrc), 'WRITERS die Bremse sitzt an der Ausgabe der Datenbank');
  ok(/await persistDb\(data\); noteDurableWrite\(\);/.test(dbSrc), 'WRITERS ein gelungenes Speichern loescht die Schuld…');
  ok(/onError: \(err\) => \{\s*\r?\n\s*markDurabilityDegraded\(/.test(dbSrc),
    'WRITERS …und ein gescheitertes setzt sie, an der einzigen Stelle, die wirklich schreibt');
  const patchedStores = readdirSync(resolvePath(repo, 'src/stores'))
    .filter((f) => /assertDurable|requireDurableOrFail/.test(src(`src/stores/${f}`)));
  ok(patchedStores.length === 0, `WRITERS und KEIN Store musste einzeln angefasst werden (${patchedStores.join(', ') || 'keiner'})`);
}

// ── 15) Ein eingefrorenes Nein hinterlaesst keine halbe Wirkung ───────────
//
// Heute prueft `STOCK_UNAVAILABLE` vor dem ersten Schreiben — aber das ist eine Eigenschaft der
// heutigen Operationen, kein Vertrag. Ein spaeterer Auftrag darf schreiben und danach ablehnen.
// Dann muss die Rueckabwicklung vollstaendig sein, BEVOR das Nein eingefroren wird: eine halbe
// Wirkung zusammen mit einem „endgueltig abgelehnt" waere der schlimmste aller Ausgaenge.
{
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d, state } = deps(db);
  db.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('seed','branch-main','INV-SEED',100)");

  let domainRuns = 0;
  const writesThenRejects = (x: unknown): never => {
    domainRuns += 1;
    (x as Db).run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('row-A','branch-main','INV-A',1)");
    (x as Db).run("UPDATE invoices SET gross = 999 WHERE id = 'seed'");
    throw new CommandRejected('STOCK_UNAVAILABLE', 'reserved elsewhere while the lines were written');
  };

  let out: Awaited<ReturnType<typeof runRemoteCommand>> | { kind: 'threw' } = { kind: 'threw' };
  try { out = await runRemoteCommand(d, identity(ID('18')), writesThenRejects); } catch { out = { kind: 'threw' }; }
  ok(out.kind === 'rejected' && out.code === 'STOCK_UNAVAILABLE' && out.frozen === true,
    `ZEROEFFECT das Nein kommt zurueck und ist endgueltig (${JSON.stringify(out)})`);
  ok(Number(db.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 0,
    'ZEROEFFECT die halb geschriebene Zeile ist zurueckgenommen');
  ok(Number(db.exec("SELECT gross FROM invoices WHERE id='seed'")[0].values[0][0]) === 100,
    'ZEROEFFECT und die geaenderte Menge steht wieder auf ihrem alten Wert');
  ok(commandCount(db as never) === 1 && lookupCommand(db as never, identity(ID('18'))).kind === 'replay',
    'ZEROEFFECT das Nein selbst ist eingefroren');

  // Und genau so — Nein ohne Wirkung — steht es auf der Platte.
  const image = new SQL.Database(state.disk as Uint8Array) as unknown as Db;
  ok(Number(image.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 0
    && Number(image.exec("SELECT gross FROM invoices WHERE id='seed'")[0].values[0][0]) === 100
    && Number(image.exec('SELECT COUNT(*) FROM remote_command_ledger')[0].values[0][0]) === 1,
    'ZEROEFFECT …und das Abbild auf der Platte zeigt dasselbe');

  const again = await runRemoteCommand(d, identity(ID('18')), writesThenRejects);
  ok(domainRuns === 1, `ZEROEFFECT die Wiederholung laesst die Domaene nicht noch einmal laufen (${domainRuns})`);
  ok(again.kind === 'rejected' && again.code === 'STOCK_UNAVAILABLE' && again.replayed === true,
    'ZEROEFFECT …und liefert dasselbe eingefrorene Nein');
  ok(Number(db.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 0,
    'ZEROEFFECT auch nach der Wiederholung keine Wirkung');

  // Und wenn die Ruecknahme selbst scheitert, wird gar nichts eingefroren: dann laesst sich
  // „ohne Wirkung" nicht mehr behaupten.
  const db2 = fresh();
  const { deps: d2 } = deps(db2);
  const broken = { ...d2, rollback: () => { throw new Error('rollback failed'); } };
  let refused: string | null = null;
  try {
    await runRemoteCommand(broken, identity(ID('19')), () => {
      throw new CommandRejected('CUSTOMER_REQUIRED', 'no customer');
    });
  } catch (e) { refused = String(e); }
  ok(refused !== null && /unsound database/.test(refused),
    `ZEROEFFECT eine gescheiterte Ruecknahme friert nichts ein (${refused})`);
  ok(lookupCommand(db2 as never, identity(ID('19'))).kind === 'fresh',
    'ZEROEFFECT …die Kennung bleibt frei, der Ausgang offen');
}

// ── 16) Wenn selbst die Ruecknahme scheitert ──────────────────────────────
//
// An einer echten sql.js-Datenbank gemessen (siehe Kopf von `transaction-health.ts`): die
// Transaktion bleibt offen, die Teilwirkung ist im Speicher SICHTBAR, weitere Schreibvorgaenge
// haengen sich an — und `export()` beendet die Transaktion still und schreibt den Stand VOR ihr.
// Ein Speichern repariert hier also nichts, es verwischt die Spur. Deshalb: gar nichts mehr.
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = fresh();
  installWriteGuard(db as never);
  db.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('seed','branch-main','INV-SEED',100)");
  const { deps: d, state } = deps(db);
  // Ein sauberer Auftrag zuerst: er beschreibt den Stand, den ein Neustart faende.
  await runRemoteCommand(d, identity(ID('23')), () => ({ seed: true }));
  const lastGood = state.disk as Uint8Array;

  // Test A — Teilwrite, definitive Ablehnung, und die Ruecknahme erreicht die Datenbank nie.
  let domainRuns = 0;
  const writesThenRejects = (x: unknown): never => {
    domainRuns += 1;
    (x as Db).run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('row-A','branch-main','INV-A',1)");
    throw new CommandRejected('STOCK_UNAVAILABLE', 'reserved elsewhere');
  };
  const brokenRollback = { ...d, rollback: () => { throw new Error('rollback failed'); } };
  let outcome: string | null = null;
  try { await runRemoteCommand(brokenRollback, identity(ID('24')), writesThenRejects); }
  catch (e) { outcome = String(e); }
  ok(outcome !== null && /unsound database/.test(outcome),
    `HEALTH A kein Ergebnis, sondern ein offener Ausgang (${outcome})`);
  ok(commandCount(db as never) === 1 && lookupCommand(db as never, identity(ID('24'))).kind === 'fresh',
    'HEALTH A keine eingefrorene Ablehnung — nur der eine saubere Auftrag steht im Nachweis');
  ok(isTransactionUnhealthy() && transactionFault()?.since === NOW,
    `HEALTH A der Prozess weiss, dass sein Transaktionszustand hinueber ist (${JSON.stringify(transactionFault())})`);

  // Nachfolgende Schreibvorgaenge: geschlossen. Und zwar BEVOR sie etwas anfassen.
  let laterWrite: string | null = null;
  try { db.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('later','branch-main','INV-L',7)"); }
  catch (e) { laterWrite = String(e); }
  ok(laterWrite !== null && /restart required/.test(laterWrite),
    `HEALTH A jeder weitere Schreibvorgang wird abgewiesen (${laterWrite})`);
  const localWrite = await runExclusive(() => 1).then(() => null, (e) => String(e));
  ok(localWrite !== null, 'HEALTH A auch die lokale Schreibreihenfolge nimmt nichts mehr an');

  // Nachfolgende Fernlesevorgaenge: ebenfalls geschlossen — und ausdruecklich kein fachliches Nein.
  const read = await executeCommand('test.read', null);
  ok(read.kind === 'infrastructure_error' && read.code === TRANSACTION_UNHEALTHY,
    `HEALTH A ein Fernlesen bestaetigt nichts mehr (${JSON.stringify(read)})`);
  const probe = await executeCommand(OP_PROBE, { echo: 'alive' });
  ok(probe.kind === 'ok', 'HEALTH A die Probe bleibt erreichbar — der Rechner darf nicht stumm werden');

  // Test B — dieselbe Kennung im selben Prozess: die Domaene laeuft NICHT erneut.
  let retryErr: string | null = null;
  try { await runRemoteCommand(d, identity(ID('24')), writesThenRejects); } catch (e) { retryErr = String(e); }
  ok(domainRuns === 1, `HEALTH B die Domaene laeuft nicht erneut, solange der Zustand unsicher ist (${domainRuns})`);
  ok(retryErr !== null && /restart required/.test(retryErr), `HEALTH B …die Wiederholung wird abgewiesen (${retryErr})`);

  // Test C — Neustart aus der letzten durablen Datei: dort ist weder Teilwirkung noch Nachweis.
  const restarted = new SQL.Database(lastGood) as unknown as Db;
  setTestDatabase(restarted as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  installWriteGuard(restarted as never);
  ok(Number(restarted.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 0
    && Number(restarted.exec("SELECT gross FROM invoices WHERE id='seed'")[0].values[0][0]) === 100,
    'HEALTH C nach dem Neustart ist von der Teilwirkung nichts da');
  ok(lookupCommand(restarted as never, identity(ID('24'))).kind === 'fresh',
    'HEALTH C …und kein Nachweis: die Kennung ist wieder bewertbar');
  const { deps: d2 } = deps(restarted);
  const after = await runRemoteCommand(d2, identity(ID('24')), (x) => {
    domainRuns += 1;
    (x as Db).run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('row-A','branch-main','INV-A',1)");
    return { invoiceId: 'row-A' };
  });
  ok(after.kind === 'ok' && domainRuns === 2, `HEALTH C und sie laeuft GENAU EINMAL (${domainRuns})`);
  ok(Number(restarted.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 1,
    'HEALTH C genau eine Zeile, nicht zwei');

  // Und die Verdrahtung: ein Speichern in diesem Zustand waere schaedlich, nicht nur nutzlos.
  const dbSrc = src('src/core/db/database.ts');
  ok(/if \(isTransactionUnhealthy\(\)\) \{/.test(dbSrc), 'HEALTH das feuernde Speichern verweigert sich…');
  ok(/assertTransactionHealthy\(\);\s*\r?\n\s*if \(isTransactionActive\(\)\)/.test(dbSrc),
    'HEALTH …und das durable Speichern sagt es laut');
}

// ── 17) Fuenf Gegenproben: haetten die Pruefungen ueberhaupt Rot zeigen koennen? ──
//
// Eine gruene Pruefung beweist nichts, wenn sie beim falschen Verhalten ebenfalls gruen waere.
// Also wird das falsche Verhalten hier ABSICHTLICH nachgebaut — beide Male genau das Verhalten,
// das dieser Schritt korrigiert hat — und dieselbe Frage darauf angewendet.
{
  // (a) Der alte Weg: die Wiederholung reicht das eingefrorene Ergebnis aus dem SPEICHER heraus,
  //     ohne vorher zu speichern. Genau das war der Defekt — ein Erfolg, den ein Absturz wegnimmt.
  resetDurabilityStateForTest();
  const db = fresh();
  const { deps: d } = deps(db, { failSave: true });
  try { await runRemoteCommand(d, identity(ID('20')), () => ({ ok: true })); } catch { /* Schuld offen */ }

  const oldWay = (): string => (lookupCommand(db as never, identity(ID('20'))).kind === 'replay' ? 'ok' : 'refused');
  ok(oldWay() === 'ok',
    'CONTROL a der alte Weg findet den Nachweis im Speicher und wuerde Erfolg melden…');
  let newWay = 'ok';
  try { await runRemoteCommand(d, identity(ID('20')), () => ({ ok: true })); } catch { newWay = 'refused'; }
  ok(newWay === 'refused',
    'CONTROL a …der echte Weg verweigert ihn, solange nichts auf der Platte steht — die Pruefung trennt beide');

  // (b) Die alte Einordnung: `STOCK_UNAVAILABLE` NICHT einfrieren. Dann entscheidet die Ankunftszeit
  //     der Wiederholung, was passiert — dieselbe Kennung verkauft ploetzlich doch.
  resetDurabilityStateForTest();
  const db2 = fresh();
  const { deps: d2 } = deps(db2);
  let stock = 0;
  const sellUnfrozen = (): { sold: boolean } => {
    // Die falsche Klasse: „nie zu einem Urteil gekommen" statt „Urteil der Domaene".
    if (stock <= 0) throw new CommandNotEvaluated('STOCK_UNAVAILABLE', 'nothing left');
    stock -= 1;
    return { sold: true };
  };
  await runRemoteCommand(d2, identity(ID('21')), sellUnfrozen);
  ok(lookupCommand(db2 as never, identity(ID('21'))).kind === 'fresh',
    'CONTROL b unter der alten Einordnung bleibt die Kennung frei…');
  stock = 1;
  const drifted = await runRemoteCommand(d2, identity(ID('21')), sellUnfrozen);
  ok(drifted.kind === 'ok' && stock === 0,
    'CONTROL b …und dieselbe Wiederholung verkauft ploetzlich doch — genau der Fehler, den §6 und §10 fangen');

  // (c) Ohne die Bremse an der Ausgabe: derselbe synchrone Einstieg schreibt trotz offener Schuld
  //     einfach weiter. Genau so war es vor §14.
  const naked = fresh(); // NICHT ueber `installWriteGuard` ausgegeben
  markDurabilityDegraded('disk full', NOW);
  naked.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('D','branch-main','INV-D',1)");
  ok(Number(naked.exec("SELECT COUNT(*) FROM invoices WHERE id='D'")[0].values[0][0]) === 1,
    'CONTROL c ohne die Bremse schreibt der synchrone Weg weiter — genau das faengt §14');

  // (d) Der alte Weg fuer eine Ablehnung nach einem Teilwrite: im selben, halb mutierten
  //     Vorgang einfrieren, ohne zurueckzunehmen.
  resetDurabilityStateForTest();
  const db3 = fresh();
  db3.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('seed','branch-main','INV-SEED',100)");
  db3.run('BEGIN');
  db3.run("INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('row-A','branch-main','INV-A',1)");
  db3.run("UPDATE invoices SET gross = 999 WHERE id = 'seed'");
  recordCommand(db3 as never, { status: 'rejected', identity: identity(ID('22')), code: 'STOCK_UNAVAILABLE', message: 'x' }, NOW);
  db3.run('COMMIT');
  ok(Number(db3.exec("SELECT COUNT(*) FROM invoices WHERE id='row-A'")[0].values[0][0]) === 1
    && Number(db3.exec("SELECT gross FROM invoices WHERE id='seed'")[0].values[0][0]) === 999
    && commandCount(db3 as never) === 1,
    'CONTROL d der alte Weg committet Teilwirkung UND abgelehntes Ergebnis zusammen — genau das faengt §15');

  // (e) Und wenn ein gescheitertes ROLLBACK die Kennung sofort wieder freigaebe: dieselbe
  //     Wiederholung liefe im selben Prozess ein zweites Mal durch die Domaene — auf einer
  //     Datenbank, in der die Teilwirkung des ersten Versuchs noch offen steht.
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db4 = fresh();
  const { deps: d4 } = deps(db4);
  let runs = 0;
  const halfWay = (x: unknown): never => {
    runs += 1;
    (x as Db).run(`INSERT INTO invoices (id, branch_id, invoice_number, gross) VALUES ('r${runs}','branch-main','INV-R${runs}',1)`);
    throw new CommandRejected('STOCK_UNAVAILABLE', 'nothing left');
  };
  // Der luecke Fall, an dem sich die Sperre wirklich messen laesst: die Ruecknahme SELBST lief
  // durch, nur ihre Meldung scheiterte. Von aussen ist das nicht zu unterscheiden — die Datenbank
  // waere hier sogar wieder benutzbar, und genau deshalb wuerde der alte Weg einfach weitermachen.
  const broken = { ...d4, rollback: () => { db4.run('ROLLBACK'); throw new Error('rollback bookkeeping failed'); } };
  try { await runRemoteCommand(broken, identity(ID('25')), halfWay); } catch { /* offener Ausgang */ }
  ok(runs === 1 && isTransactionUnhealthy(), 'CONTROL e erster Versuch: Ruecknahme gemeldet als gescheitert');
  // Der alte Weg: keine Zustandsmarkierung — die Kennung sieht frei aus, also wird erneut bewertet.
  resetTransactionHealthForTest();
  try { await runRemoteCommand(broken, identity(ID('25')), halfWay); } catch { /* dito */ }
  ok(runs === 2,
    `CONTROL e ohne die Zustandssperre laeuft dieselbe Kennung ein zweites Mal durch die Domaene (${runs}) — genau das faengt §16 B`);
  resetTransactionHealthForTest();
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3a write foundation: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3_DURABLE_IDEMPOTENCY_SCHEMA_PROVED');
console.log('CENTRAL_C3_TRANSACTION_BOUNDARY_AUDIT_PROVED');
console.log('CENTRAL_C3_ATOMIC_COMMAND_TRANSACTION_PROVED');
console.log('CENTRAL_C3_LEGACY_SEQUENCES_MIGRATED_PROVED');
console.log('CENTRAL_C3_UNKNOWN_OUTCOME_RETRY_PROVED');
console.log('CENTRAL_C3_RESULT_CLASSIFICATION_PROVED');
console.log('CENTRAL_C3_REMOTE_WRITE_DURABILITY_PROVED');
console.log('CENTRAL_C3_POST_COMMIT_DURABILITY_FAILURE_PROVED');
console.log('CENTRAL_C3_DEGRADED_ALL_WRITERS_PROVED');
console.log('CENTRAL_C3_REJECTED_COMMAND_ZERO_EFFECT_PROVED');
console.log('CENTRAL_C3_TRANSACTION_HEALTH_FAIL_CLOSED_PROVED');

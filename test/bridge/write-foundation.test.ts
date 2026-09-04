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
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
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
const { runRemoteCommand, CommandRejected } = await import('../../src/core/bridge/mutation-engine.ts');
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

/** Die echten Transaktionsklammern einer sql.js-Datenbank, plus ein zaehlendes Speichern. */
function deps(db: Db, opts: { failSave?: boolean } = {}) {
  const state = { saves: 0, commits: 0, rollbacks: 0 };
  return {
    state,
    deps: {
      db: db as never,
      begin: () => { db.run('BEGIN'); },
      commit: () => { db.run('COMMIT'); state.commits += 1; },
      rollback: () => { db.run('ROLLBACK'); state.rollbacks += 1; },
      durableSave: async () => {
        if (opts.failSave) throw new Error('disk full');
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

// ── 6) Welche Ablehnung eingefroren wird — und welche nicht ───────────────
//
// Eine Ablehnung, die an der EINGABE haengt, faellt jedes Mal gleich aus: einfrieren spart dem
// Client eine sinnlose Wiederholung. Eine Ablehnung, die am ZUSTAND haengt, darf morgen anders
// ausfallen — sie einzufrieren waere eine falsche Endgueltigkeit.
{
  const db = fresh();
  const { deps: d } = deps(db);

  const terminal = await runRemoteCommand(d, identity(ID('5')), () => {
    throw new CommandRejected('CUSTOMER_REQUIRED', 'no customer in the request', true);
  });
  ok(terminal.kind === 'rejected' && terminal.code === 'CUSTOMER_REQUIRED', 'CLASS eine Eingabe-Ablehnung kommt zurueck');
  ok(commandCount(db as never) === 1, 'CLASS …und wird eingefroren');
  let againRuns = 0;
  const again = await runRemoteCommand(d, identity(ID('5')), () => { againRuns += 1; return { ok: true }; });
  ok(again.kind === 'rejected' && again.replayed === true && againRuns === 0,
    'CLASS die Wiederholung bekommt dieselbe Ablehnung, ohne den Code auszufuehren');

  const transient = await runRemoteCommand(d, identity(ID('6')), () => {
    throw new CommandRejected('STOCK_UNAVAILABLE', 'nothing left', false);
  });
  ok(transient.kind === 'rejected' && transient.code === 'STOCK_UNAVAILABLE', 'CLASS eine Zustands-Ablehnung kommt zurueck');
  ok(lookupCommand(db as never, identity(ID('6'))).kind === 'fresh',
    'CLASS …wird aber NICHT eingefroren — morgen kann dieselbe Anfrage zu Recht gelingen');

  let later = 0;
  const retry = await runRemoteCommand(d, identity(ID('6')), () => { later += 1; return { sold: true }; });
  ok(retry.kind === 'ok' && later === 1, 'CLASS und ein spaeterer Versuch darf gelingen');

  // Eine Stoerung ist keine Ablehnung: sie hinterlaesst nichts.
  let boom: string | null = null;
  try { await runRemoteCommand(d, identity(ID('7')), () => { throw new Error('database is on fire'); }); }
  catch (e) { boom = String(e); }
  ok(boom !== null, 'CLASS eine Stoerung wird geworfen');
  ok(lookupCommand(db as never, identity(ID('7'))).kind === 'fresh',
    'CLASS …und NIE als erledigter Geschaeftsvorgang festgehalten');
}

// ── 7) Speichern gehoert zum Erfolg ───────────────────────────────────────
{
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
  const image = new SQL.Database(db.export()) as unknown as Db;
  ok(Number(image.exec('SELECT COUNT(*) FROM invoices')[0].values[0][0])
    === Number(image.exec('SELECT COUNT(*) FROM remote_command_ledger')[0].values[0][0]),
    'DURABILITY beide gemeinsam — nie eines ohne das andere');

  const engine = src('src/core/bridge/mutation-engine.ts');
  const commitAt = engine.indexOf('deps.commit();');
  const saveAt = engine.indexOf('await deps.durableSave();\n\n  if (record.status');
  const returnAt = engine.indexOf("return { kind: 'ok', value: record.result");
  ok(commitAt > 0 && saveAt > commitAt && returnAt > saveAt,
    'DURABILITY die Reihenfolge im Code ist commit → speichern → Erfolg melden');
}

// ── 8) Die vier Alt-Nummernkreise ─────────────────────────────────────────
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

// ── 9) Die Verdrahtung: kein alter Nummerngeber mehr, kein offenes Tor ────
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

  // Das Tor bleibt zu: C3A registriert keine produktive Mutation.
  const registry = src('src/core/bridge/command-registry.ts');
  ok(/export const REMOTE_MUTATIONS_ENABLED = false;/.test(registry), 'WIRED veraendernde Fernauftraege bleiben gesperrt');
  const bridgeRs = src('src-tauri/src/bridge.rs');
  const list = bridgeRs.slice(bridgeRs.indexOf('pub const REMOTE_OPS'), bridgeRs.indexOf('];', bridgeRs.indexOf('pub const REMOTE_OPS')));
  const ops = (list.match(/OP_[A-Z_]+/g) || []).map((n) => {
    const m = bridgeRs.match(new RegExp(`${n}: &str = "([^"]+)"`));
    return m ? m[1] : n;
  });
  ok(ops.length === 7, `WIRED die Liste ist unveraendert: 7 Namen (${ops.length})`);
  ok(ops.filter((o) => o.endsWith('.list') || o.endsWith('.get')).length === 6 && ops.includes('bridge.probe'),
    'WIRED eine Probe, sechs Lesevorgaenge, null Mutationen');
  const engine = src('src/core/bridge/mutation-engine.ts');
  ok(!/registerCommand/.test(engine), 'WIRED die Maschine registriert selbst nichts');
}

// ── 10) Wer darf in eine äußere Transaktion — und wer noch nicht ──────────
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

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3a write foundation: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3_DURABLE_IDEMPOTENCY_SCHEMA_PROVED');
console.log('CENTRAL_C3_TRANSACTION_BOUNDARY_AUDIT_PROVED');
console.log('CENTRAL_C3_ATOMIC_COMMAND_TRANSACTION_PROVED');
console.log('CENTRAL_C3_LEGACY_SEQUENCES_MIGRATED_PROVED');
console.log('CENTRAL_C3_UNKNOWN_OUTCOME_RETRY_PROVED');
console.log('CENTRAL_C3_RESULT_CLASSIFICATION_PROVED');
console.log('CENTRAL_C3_REMOTE_WRITE_DURABILITY_PROVED');

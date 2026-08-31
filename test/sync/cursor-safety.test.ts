// SYNC-SAFETY-A1 — der Pull-Wasserstand gehoert zu den Daten, und die Transfernummer wird nie
// wiederverwendet. Run: node test/sync/cursor-safety.test.ts
//
// Der Vorfall, den diese Datei festhaelt, ist real: ein Transfer bekam `TRF-2026-00020`, wurde
// eine halbe Minute spaeter geloescht, und der naechste Transfer bekam DIESELBE Nummer, weil der
// alte Nummerngeber `MAX(Bestand des Jahres)+1` rechnete. Solange nichts wiederholt wurde, fiel
// das nicht auf. Dann verlor der Rechner seinen Wasserstand (Verbindung getrennt und neu
// aufgebaut — oder ein neues Windows), der Pull begann wieder bei 0, und beim Wiedereinspielen
// des alten Einfuegens schlug der eindeutige Index `(branch_id, transfer_number)` zu. Der Batch
// lief zurueck, der Stand blieb stehen, und ab da starb jeder Pull an derselben Stelle.
//
// Hier wird alles an den ECHTEN Funktionen geprueft, gegen eine echte sql.js-Datenbank.
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withTs = (p: string): string => (existsSync(p) ? p : existsSync(p + '.ts') ? p + '.ts' : p);
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(withTs(resolvePath(repo, 'src', specifier.slice(2)))).href, shortCircuit: true };
    }
    // `helpers.ts` haengt an der Datenbank und an der Anmeldung; beides wird gestellt, damit der
    // ECHTE Nummerngeber laufen kann (er selbst braucht nur die Datenbank).
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (false) {
      // Der ECHTE Allocator wird getestet; nur seine Datenbankquelle wird gestellt.
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const initSqlJs = (await import('sql.js')).default;
const {
  readCursor, writeCursor, resolveCursorStart, isServerFingerprint, CURSOR_DDL, ownPushedCounts, provenOwnPrefix,
  serverLogBehind,
} = await import('../../src/core/sync/cursor-store.ts');
const {
  ensureTransferSequence, highestIssuedTransferSeq, parseTransferNumber, TRANSFER_DOC_TYPE, TRANSFER_PADDING,
} = await import('../../src/core/agents/transfer-sequence.ts');
const { applyUpsert } = await import('../../src/core/sync/apply-change.ts');
const { A1_UPGRADE_SQL, applyA1Upgrade } = await import('../../src/core/db/a1-upgrade.ts');
const { setTestDatabase } = await import('./_db-shim.ts');
const { getNextDocumentNumber } = await import('../../src/core/db/helpers.ts');

let pass = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) pass++; else { fails.push(m); console.log('  x ' + m); } };

const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const NOW = '2026-08-31T12:00:00.000Z';
const YEAR = 2026;
const FP_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FP_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
function fresh(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(CURSOR_DDL);
  db.run('CREATE TABLE document_sequences (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL, '
    + 'next_number INTEGER NOT NULL DEFAULT 1, include_year INTEGER NOT NULL DEFAULT 1, '
    + 'padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL, seq_year INTEGER)');
  db.run("INSERT INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at) "
    + "VALUES ('TRF','TRF',1,1,6,'seed')");
  db.run('CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, '
    + 'transfer_number TEXT NOT NULL, status TEXT, created_at TEXT)');
  db.run('CREATE UNIQUE INDEX ux_transfer_number ON agent_transfers (branch_id, transfer_number)');
  db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, '
    + 'record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT)');
  return db;
}
const seqOf = (db: Db): number => Number(db.exec("SELECT next_number FROM document_sequences WHERE doc_type = 'TRF'")[0].values[0][0]);
const padOf = (db: Db): number => Number(db.exec("SELECT padding FROM document_sequences WHERE doc_type = 'TRF'")[0].values[0][0]);
/** Eine eigene, gesendete Zeile im Ausgangskorb — genau so, wie `trackChange` sie schreibt. */
const pushed = (db: Db, table: string, id: string, action: string, data: unknown): { id: number; table_name: string; record_id: string; action: string; data: string } => {
  const text = JSON.stringify(data);
  db.run('INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at) VALUES (?,?,?,?,?,1,?)',
    [table, id, 'branch-main', action, text, NOW]);
  return { id: 0, table_name: table, record_id: id, action, data: text };
};

// ── A) Der Wasserstand ─────────────────────────────────────────────────────
{
  const db = fresh();
  ok(readCursor(db, FP_A) === null, 'CURSOR a server we never spoke to has no recorded progress');
  ok(writeCursor(db, FP_A, 541, NOW) === 541, 'CURSOR the first progress is recorded');
  ok(readCursor(db, FP_A) === 541, 'CURSOR …and read back');
  ok(writeCursor(db, FP_A, 860, NOW) === 860, 'CURSOR it moves forward');
  // Der Kern: nie rueckwaerts. Ein Fenster, das tiefer beginnt, darf den Stand nicht senken —
  // sonst liefe genau der Wiedereinspiel-Fall erneut an.
  ok(writeCursor(db, FP_A, 3, NOW) === 860, 'CURSOR a smaller answer never lowers it');
  ok(readCursor(db, FP_A) === 860, 'CURSOR …and the stored value stays the high one');
  writeCursor(db, FP_B, 7, NOW);
  ok(readCursor(db, FP_A) === 860 && readCursor(db, FP_B) === 7, 'CURSOR two servers never mix');
  ok(isServerFingerprint(FP_A) && !isServerFingerprint('nope') && !isServerFingerprint(FP_A.toUpperCase()),
    'CURSOR only a real server name is accepted');
  let threw = false; try { writeCursor(db, 'nope', 1, NOW); } catch { threw = true; }
  ok(threw, 'CURSOR …and writing under anything else is refused, not silently ignored');
}

// ── B) Woran der eigene Ursprung erkannt wird ──────────────────────────────
//
// Der alte localStorage-Wert taugt NICHT als Beweis: `setSyncConfig` schrieb Adresse und Token,
// ohne ihn anzufassen — ein Verbinden mit einem anderen Server liess den Stand des vorigen
// stehen. Beweisbar ist dagegen der eigene Ausgangskorb.
{
  const db = fresh();
  const a = pushed(db, 'products', 'p1', 'insert', { id: 'p1', name: 'Mine' });
  const b = pushed(db, 'products', 'p1', 'delete', {});
  const own = ownPushedCounts(db);
  ok(own.size === 2, 'OWN the outbox is what this database provably sent');
  const foreign = { id: 3, table_name: 'products', record_id: 'p9', action: 'insert', data: JSON.stringify({ id: 'p9' }) };
  const p1 = provenOwnPrefix([{ ...a, id: 1 }, { ...b, id: 2 }, foreign], own);
  ok(p1.count === 2 && p1.lastId === 2, 'OWN the unbroken start of own changes is measured');
  const p2 = provenOwnPrefix([foreign, { ...a, id: 4 }], own);
  ok(p2.count === 0 && p2.lastId === 0, 'OWN …and the first foreign change ends the run — nothing behind it is skipped');
  const changed = provenOwnPrefix([{ ...a, id: 1, data: JSON.stringify({ id: 'p1', name: 'Altered' }) }], own);
  ok(changed.count === 0, 'OWN a payload that differs by one byte is not ours');
}
{
  // Zwei aufeinanderfolgende Aenderungen DERSELBEN Zeile duerfen nicht miteinander verwechselt
  // werden: der Beweis haengt an der vollstaendigen Nutzlast, nicht an Tabelle+Datensatz+Operation.
  const db = fresh();
  const first = pushed(db, 'products', 'p1', 'update', { id: 'p1', name: 'One' });
  const own = ownPushedCounts(db);
  const second = { id: 2, table_name: 'products', record_id: 'p1', action: 'update', data: JSON.stringify({ id: 'p1', name: 'Two' }) };
  ok(provenOwnPrefix([{ ...first, id: 1 }], own).count === 1, 'OWN the update we really sent is ours');
  ok(provenOwnPrefix([second], own).count === 0,
    'OWN a second update of the SAME row with a different payload is NOT covered by the first');
  ok(provenOwnPrefix([{ ...first, id: 1 }, second], own).count === 1,
    'OWN …so the run ends at it instead of swallowing it');
  // Und nach einer Luecke wird nichts vorab uebersprungen, auch wenn spaeter wieder Eigenes kommt.
  const later = pushed(db, 'products', 'p2', 'insert', { id: 'p2' });
  const own2 = ownPushedCounts(db);
  ok(provenOwnPrefix([second, { ...later, id: 3 }], own2).count === 0,
    'OWN a gap at the front means nothing behind it is skipped');
  // Die Korrelation muss die Nutzlast wirklich enthalten — sonst waeren die beiden Updates gleich.
  ok([...own2.keys()].some((k) => k.includes('"name":"One"')),
    'OWN the proof carries the payload, not just the row and the operation');
}

// ── B2) Ein Beleg deckt genau eine Kopie ──────────────────────────────────
//
// Der Push waehlt ungesendete Zeilen, schickt sie und markiert sie ERST NACH der Antwort als
// gesendet. Bricht die Verbindung nach der Annahme und vor der Antwort ab, schickt der naechste
// Lauf dieselben Zeilen erneut — und der Server nimmt sie wieder an (die Push-Route fuegt ohne
// Idempotenzschluessel ein). Dieselbe lokale Zeile kann also zwei Server-Ids bekommen.
{
  const db = fresh();
  const a = pushed(db, 'products', 'p1', 'insert', { id: 'p1', name: 'Mine' });
  const own = ownPushedCounts(db);
  ok(provenOwnPrefix([{ ...a, id: 1 }], own).count === 1, 'ONE one server change and one matching local row: proven');
  const twice = provenOwnPrefix([{ ...a, id: 1 }, { ...a, id: 2 }], own);
  ok(twice.count === 1 && twice.lastId === 1,
    'ONE the SAME change accepted twice needs two local rows — one proof never covers both');
  ok(twice.count === 1, 'ONE …so the run ends at the second copy instead of skipping it');

  // Zwei echte Sendungen derselben Zeile (der Wiederholungsfall) — dann sind beide belegt.
  pushed(db, 'products', 'p1', 'insert', { id: 'p1', name: 'Mine' });
  const own2 = ownPushedCounts(db);
  const key = [...own2.keys()][0];
  ok(own2.get(key) === 2, 'ONE the outbox counts how often a row really went out');
  const both = provenOwnPrefix([{ ...a, id: 1 }, { ...a, id: 2 }], own2);
  ok(both.count === 2 && both.lastId === 2, 'ONE …and then both copies are covered');
  const third = provenOwnPrefix([{ ...a, id: 1 }, { ...a, id: 2 }, { ...a, id: 3 }], own2);
  ok(third.count === 2, 'ONE …but never more copies than there are proofs');
  ok(own2.get(key) === 2, 'ONE and asking does not consume the proofs themselves');
}

// ── B3) Der geteilte Dokumentzaehler bleibt fuer alle anderen, wie er war ──
{
  // Eine echte Alt-Datenbank: INV steht auf 42, EXP auf 7, nichts kennt `seq_year`.
  const db = new SQL.Database() as unknown as Db;
  db.run('CREATE TABLE document_sequences (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL, '
    + 'next_number INTEGER NOT NULL DEFAULT 1, include_year INTEGER NOT NULL DEFAULT 1, '
    + 'padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL)');
  db.run("INSERT INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at) "
    + "VALUES ('INV','INV',42,1,6,'old'), ('EXP','EXP',7,1,6,'old'), ('TRF','TRF',1,1,6,'old')");
  applyA1Upgrade(db);
  setTestDatabase(db);

  const numberOf = (t: string): number =>
    Number(db.exec('SELECT next_number FROM document_sequences WHERE doc_type = ?', [t])[0].values[0][0]);
  const yearOf = (t: string): unknown =>
    db.exec('SELECT seq_year FROM document_sequences WHERE doc_type = ?', [t])[0].values[0][0];

  ok(numberOf('INV') === 42, 'SHARED the upgrade alone leaves an existing counter where it was');
  const year = new Date().getFullYear();
  // Der ECHTE Allocator, gegen eine echte Datenbank — nicht nachgebaut.
  ok(getNextDocumentNumber('INV') === `INV-${year}-000042`,
    'SHARED the real allocator hands out exactly the number the row was standing on');
  ok(numberOf('INV') === 43, 'SHARED …and leaves it one further, exactly as before A1');
  ok(getNextDocumentNumber('EXP') === `EXP-${year}-000007`, 'SHARED another type keeps its own value and format too');
  ok(yearOf('INV') === null && yearOf('EXP') === null, 'SHARED the new year column stays empty for every other type');

  // Erst der Transfer-Zaehler setzt sie — und nur bei sich.
  db.run('CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, transfer_number TEXT NOT NULL)');
  db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT, '
    + 'branch_id TEXT, action TEXT, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT)');
  ensureTransferSequence(db, NOW, year);
  ok(Number(yearOf('TRF')) === year, 'SHARED …and it is set only for the transfer counter');
  ok(yearOf('INV') === null && numberOf('INV') === 43, 'SHARED …without touching anyone else');
  ok(getNextDocumentNumber('INV') === `INV-${year}-000043`, 'SHARED the next invoice still follows the old contract');
  ok(numberOf('TRF') === 1 && Number(padOf(db)) === TRANSFER_PADDING,
    'SHARED a transfer counter with no history starts at 1, five digits');
}

// ── C) Der Startpunkt — vier Faelle, keiner geraten ────────────────────────
{
  const db = fresh();
  writeCursor(db, FP_A, 500, NOW);
  const s = resolveCursorStart(db, FP_A, [], 860, NOW);
  ok(s.kind === 'known' && s.cursor === 500, 'START a recorded progress wins');
}
{
  const db = fresh();
  const s = resolveCursorStart(db, FP_A, [], 0, NOW);
  ok(s.kind === 'fresh' && s.cursor === 0, 'START a first contact with an empty server starts at 0 — nothing can be replayed');
  ok(readCursor(db, FP_A) === 0, 'START …and that is recorded, so it is not decided twice');
}
{
  // Der Wiedereinstieg nach einem C:-Verlust: die Historie ist die eigene.
  const db = fresh();
  const a = pushed(db, 'products', 'p1', 'insert', { id: 'p1' });
  const b = pushed(db, 'products', 'p1', 'delete', {});
  const s = resolveCursorStart(db, FP_A, [{ ...a, id: 541 }, { ...b, id: 543 }], 543, NOW);
  ok(s.kind === 'reconstructed' && s.cursor === 543, 'START a history that is provably our own is stepped over, not replayed');
  ok(s.kind === 'reconstructed' && s.ownPrefix === 2, 'START …and it says how much it could prove');
  ok(readCursor(db, FP_A) === 543, 'START …and that becomes the durable progress');
}
{
  // Fremdes am Anfang: hier wird NICHTS uebersprungen und nichts geraten.
  const db = fresh();
  pushed(db, 'products', 'p1', 'insert', { id: 'p1' });
  const foreign = { id: 10, table_name: 'products', record_id: 'other', action: 'insert', data: '{}' };
  const s = resolveCursorStart(db, FP_A, [foreign], 860, NOW);
  ok(s.kind === 'recovery-required', 'START a history that does not start with our own is a recovery case, not a guess');
  ok(readCursor(db, FP_A) === null, 'START …and nothing is written: neither 0 nor the end of the log');
}
{
  const db = fresh();
  writeCursor(db, FP_A, 860, NOW);
  const other = resolveCursorStart(db, FP_B, [{ id: 5, table_name: 'products', record_id: 'x', action: 'insert', data: '{}' }], 860, NOW);
  ok(other.kind === 'recovery-required', 'START a different server never inherits the progress of another');
  ok(readCursor(db, FP_A) === 860 && readCursor(db, FP_B) === null, 'START …and the old progress is left untouched');
  const same = resolveCursorStart(db, FP_A, [], 860, NOW);
  ok(same.kind === 'known' && same.cursor === 860, 'START the same installation keeps its progress across an address change');
}

// ── D) Der Vorfall selbst: 541 → 543 ───────────────────────────────────────
{
  const db = fresh();
  db.run("INSERT INTO agent_transfers (id, branch_id, transfer_number, status, created_at) "
    + "VALUES ('B','branch-main','TRF-2026-00020','transferred','2026-08-14T15:07:58.059Z')");
  const payloadA = { id: 'A', branch_id: 'branch-main', transfer_number: 'TRF-2026-00020', status: 'transferred' };

  let failed = false;
  try { applyUpsert(db, 'agent_transfers', 'A', payloadA); }
  catch (e) { failed = /UNIQUE/i.test(String(e)); }
  ok(failed, 'INCIDENT replaying the old insert really does hit the unique index — this is the reported failure');
  ok(db.exec("SELECT COUNT(*) FROM agent_transfers WHERE transfer_number = 'TRF-2026-00020'")[0].values[0][0] === 1,
    'INCIDENT …and the item of today is untouched by the attempt');

  // Und so wird es aufgeloest: die beiden Log-Eintraege sind nachweislich eigener Ursprung, also
  // wird hinter sie gesprungen — nicht ueber einen Fehler hinweg, sondern ueber einen Beweis.
  const ins = pushed(db, 'agent_transfers', 'A', 'insert', payloadA);
  const del = pushed(db, 'agent_transfers', 'A', 'delete', {});
  const s = resolveCursorStart(db, FP_A, [{ ...ins, id: 541 }, { ...del, id: 543 }], 543, NOW);
  ok(s.kind === 'reconstructed' && s.cursor === 543, 'INCIDENT the durable progress steps over the old own history');
  ok(db.exec('SELECT COUNT(*) FROM agent_transfers')[0].values[0][0] === 1,
    'INCIDENT …one transfer, no duplicate, nothing lost');
}

// ── E) Die Nummer wird nie wiederverwendet — und das Jahr bleibt ───────────
{
  const db = fresh();
  ok(parseTransferNumber('TRF-2026-00020')?.seq === 20 && parseTransferNumber('TRF-2026-00020')?.year === 2026,
    'TRF year and running number are both read from the number');
  ok(parseTransferNumber('') === null && parseTransferNumber('TRF-1') === null, 'TRF …and nonsense is not a number');

  db.run("INSERT INTO agent_transfers (id, branch_id, transfer_number, status, created_at) "
    + "VALUES ('B','branch-main','TRF-2026-00020','transferred','x')");
  // Der geloeschte Transfer A lebt nur noch im Log — und genau seine Nummer ist die gefaehrliche.
  pushed(db, 'agent_transfers', 'A', 'insert', { id: 'A', transfer_number: 'TRF-2026-00021' });
  // Ein anderes Jahr darf die Zaehlung dieses Jahres nicht anheben.
  pushed(db, 'agent_transfers', 'C', 'insert', { id: 'C', transfer_number: 'TRF-2025-00099' });
  ok(highestIssuedTransferSeq(db, YEAR) === 21,
    'TRF the highest number ever issued THIS year counts the deleted one too — the live rows alone would say 20');
  ok(highestIssuedTransferSeq(db, 2025) === 99, 'TRF …and each year is counted for itself');

  ok(ensureTransferSequence(db, NOW, YEAR) === 22, 'TRF the counter is lifted past everything ever issued this year');
  ok(padOf(db) === TRANSFER_PADDING, 'TRF …and the five-digit format is kept, not the house default of six');
  ok(TRANSFER_DOC_TYPE === 'TRF', 'TRF the document type is the one already seeded in the house');
  ok(ensureTransferSequence(db, NOW, YEAR) === 22, 'TRF a second run changes nothing');

  db.run("DELETE FROM agent_transfers WHERE id = 'B'");
  ok(ensureTransferSequence(db, NOW, YEAR) === 22, 'TRF deleting a transfer does NOT free its number again');

  // Ein bereits hoeherer durabler Stand gewinnt immer — auch gegen die Historie.
  db.run("UPDATE document_sequences SET next_number = 40 WHERE doc_type = 'TRF'");
  ok(ensureTransferSequence(db, NOW, YEAR) === 40, 'TRF an existing higher counter is never pulled back down');

  // Der Jahresvertrag: der alte Weg begann jedes Jahr neu bei 1, und das bleibt so.
  ok(ensureTransferSequence(db, NOW, 2027) === 1, 'TRF a new year starts at 1 again — the year contract is kept');
  ok(ensureTransferSequence(db, NOW, 2027) === 1, 'TRF …and stays there until a number is actually taken');
  db.run("UPDATE document_sequences SET next_number = 5 WHERE doc_type = 'TRF'");
  ok(ensureTransferSequence(db, NOW, 2027) === 5, 'TRF …while within that year it only ever goes up');
  ok(seqOf(db) === 5, 'TRF …and that is what the counter holds');
}

// ── F) Eine BESTEHENDE Datenbank aus v0.8.51 ──────────────────────────────
//
// Nicht die frische, sondern die, die es schon gibt: ohne `sync_cursor`, ohne `seq_year`, mit
// gefuellten Zaehlern, Transfers und Historie. Genau die Anweisungen, die die Anwendung beim
// Start ausfuehrt, werden hier ausgefuehrt.
{
  const db = new SQL.Database() as unknown as Db;
  // v0.8.51-Schema: document_sequences OHNE seq_year, kein sync_cursor.
  db.run('CREATE TABLE document_sequences (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL, '
    + 'next_number INTEGER NOT NULL DEFAULT 1, include_year INTEGER NOT NULL DEFAULT 1, '
    + 'padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL)');
  db.run("INSERT INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at) "
    + "VALUES ('INV','INV',42,1,6,'old'), ('TRF','TRF',1,1,6,'old')");
  db.run('CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, '
    + 'transfer_number TEXT NOT NULL, status TEXT, created_at TEXT)');
  db.run('CREATE UNIQUE INDEX ux_transfer_number ON agent_transfers (branch_id, transfer_number)');
  db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, '
    + 'record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT)');
  db.run("INSERT INTO agent_transfers (id, branch_id, transfer_number, status, created_at) "
    + "VALUES ('t30','branch-main','TRF-2026-00030','transferred','x')");
  pushed(db, 'agent_transfers', 'gone', 'insert', { id: 'gone', transfer_number: 'TRF-2026-00031' });

  const has = (t: string): boolean => db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?", [t]).length > 0;
  const hasCol = (t: string, c: string): boolean =>
    db.exec(`PRAGMA table_info(${t})`)[0].values.some((r) => String(r[1]) === c);
  ok(!has('sync_cursor') && !hasCol('document_sequences', 'seq_year'), 'UPGRADE the fixture really is a pre-A1 database');

  applyA1Upgrade(db);
  ok(has('sync_cursor'), 'UPGRADE the cursor table exists afterwards');
  ok(hasCol('document_sequences', 'seq_year'), 'UPGRADE …and the counter carries its year');
  ok(A1_UPGRADE_SQL.length === 2, 'UPGRADE the whole upgrade is those two statements — nothing that touches data');
  ok(!A1_UPGRADE_SQL.some((sql) => /\b(INSERT|UPDATE|DELETE|DROP)\b/i.test(sql)), 'UPGRADE …and none of them writes a row');

  // Die Werte, die schon dastanden, sind unberuehrt.
  const inv = db.exec("SELECT next_number FROM document_sequences WHERE doc_type = 'INV'")[0].values[0][0];
  ok(Number(inv) === 42, 'UPGRADE an existing counter keeps its value');
  ok(db.exec('SELECT COUNT(*) FROM agent_transfers')[0].values[0][0] === 1, 'UPGRADE …and the business rows are untouched');

  // Zweiter Start: nichts passiert, nichts wirft.
  let threw = false; try { applyA1Upgrade(db); } catch { threw = true; }
  ok(!threw, 'UPGRADE a second start neither fails…');
  ok(Number(db.exec("SELECT next_number FROM document_sequences WHERE doc_type = 'INV'")[0].values[0][0]) === 42,
    'UPGRADE …nor changes anything');

  // Und der Transfer-Zaehler startet auf dieser Alt-DB dort, wo die Historie aufhoert — inklusive
  // der Nummer, die es nur noch im Log gibt.
  ok(ensureTransferSequence(db, NOW, YEAR) === 32, 'UPGRADE the transfer counter starts past every number ever issued (30 live, 31 in the log)');
  ok(readCursor(db, FP_A) === null, 'UPGRADE …and no progress is invented for any server');
}

// ── G) Derselbe Server, aber hinter uns ────────────────────────────────────
{
  const db = fresh();
  writeCursor(db, FP_A, 850, NOW);
  ok(serverLogBehind(db, FP_A, 850) === null, 'BEHIND a server exactly at our progress is fine');
  ok(serverLogBehind(db, FP_A, 900) === null, 'BEHIND …and one ahead of us is the normal case');
  const b = serverLogBehind(db, FP_A, 700);
  ok(b !== null && b.cursor === 850 && b.head === 700, 'BEHIND a server whose log ends before our progress is reported');
  ok(readCursor(db, FP_A) === 850, 'BEHIND …and nothing is lowered to its end');
  ok(serverLogBehind(db, FP_B, 0) === null, 'BEHIND a server we have no progress with cannot be behind us');
}

// ── H) Die Verdrahtung ─────────────────────────────────────────────────────
{
  const svc = readFileSync(resolvePath(repo, 'src/core/sync/sync-service.ts'), 'utf8');
  ok(/writeCursor\(db, durable\.fingerprint, Number\(last_sync_id\)[\s\S]{0,80}db\.run\('COMMIT'\)/.test(svc),
    'WIRED the progress is written INSIDE the apply transaction, right before the commit');
  const clear = svc.slice(svc.indexOf('export function clearSyncConfig'), svc.indexOf('export function isSyncConfigured'));
  ok(/localStorage\.removeItem\(STORAGE_KEY_FP\)/.test(clear), 'WIRED disconnect drops the connection…');
  ok(!/DELETE FROM sync_cursor|dropCursor/.test(clear),
    'WIRED …but never the durable progress in the database — that was the trigger of the incident');
  // Identitaet VOR Cursor: ein fremder Stand darf nie ein Fenster beschneiden.
  ok(/answer\.fingerprint !== cachedFp[\s\S]{0,400}answer = await ask\(asked\)/.test(svc),
    'WIRED a different server than assumed makes the answer be discarded and asked again with ITS progress');
  {
    const askAt = svc.indexOf('const ask = async');
    const resolveAt = svc.indexOf('resolveCursorStart(db, fingerprint, changes');
    // Der Aufruf, nicht der Import — der steht ganz oben in der Datei.
    const applyAt = svc.indexOf('await commitPulledBatch(');
    ok(askAt > 0 && resolveAt > askAt && applyAt > resolveAt,
      'WIRED the identity is settled before the start point, and the start point before any apply');
  }
  {
    const at = svc.indexOf("start.kind === 'recovery-required'");
    const thrown = svc.indexOf('throw new SyncRecoveryRequiredError', at);
    const apply = svc.indexOf('await commitPulledBatch(', at);
    ok(at > 0 && thrown > at && thrown < apply,
      'WIRED an unreconstructable progress THROWS before anything is applied — a successful push cannot hide it');
  }
  ok(svc.includes("setStatus('error', err instanceof SyncRecoveryRequiredError ? RECOVERY_REQUIRED"),
    'WIRED …and the run reports that state by its own name, never as "synced"');
  ok(/export const RECOVERY_REQUIRED/.test(svc), 'WIRED the state has a stable name the UI can recognise');
  {
    // Der Rueckwaerts-Schutz muss VOR dem Startpunkt und vor jedem Anwenden greifen.
    const behindAt = svc.indexOf('serverLogBehind(db, fingerprint, answer.logHead)');
    const thrown = svc.indexOf('throw new SyncServerBehindError', behindAt);
    const startAt = svc.indexOf('resolveCursorStart(db, fingerprint, changes');
    const applyAt = svc.indexOf('await commitPulledBatch(');
    ok(behindAt > 0 && thrown > behindAt && thrown < startAt && startAt < applyAt,
      'WIRED a server behind our progress stops the pull before the start point and before any apply');
  }
  ok(svc.includes('logHead: Number(b.log_head)'), 'WIRED the head of the log is read from the authenticated pull answer');
  ok(svc.includes('err instanceof SyncServerBehindError ? SERVER_LOG_BEHIND'),
    'WIRED …and that state is reported by its own name too, never as "synced"');
  const ui = readFileSync(resolvePath(repo, 'src/pages/settings/SettingsPage.tsx'), 'utf8');
  ok(ui.includes('sync.SERVER_LOG_BEHIND') && /is behind this device/i.test(ui),
    'WIRED the screen tells the two stopped states apart');
  ok(/sync\.RECOVERY_REQUIRED/.test(ui) && /recovery required/i.test(ui),
    'WIRED the screen says a recovery is needed instead of showing a generic error');
  const store = readFileSync(resolvePath(repo, 'src/stores/agentStore.ts'), 'utf8');
  ok(/getNextDocumentNumber\(TRANSFER_DOC_TYPE\)/.test(store), 'WIRED a transfer takes its number from the durable counter');
  ok(!/getNextNumber\('agent_transfers'/.test(store), 'WIRED …and no longer from MAX(rows)+1');
  ok(/ensureTransferSequence\([\s\S]{0,120}getFullYear\(\)\)/.test(store), 'WIRED …with the counter lifted for the current year first');
  const rs = readFileSync(resolvePath(repo, 'src-tauri/src/sync/routes.rs'), 'utf8');
  ok(rs.includes('SELECT COALESCE(MAX(id), 0) FROM sync_changelog WHERE tenant_id'),
    'WIRED the server answers with the real head of its log, not the end of the window');
  const dbSrc = readFileSync(resolvePath(repo, 'src/core/db/database.ts'), 'utf8');
  ok(dbSrc.includes('...A1_UPGRADE_SQL,'), 'WIRED the upgrade runs through the house migration list — the same statements the test drives');
  ok(/seq_year INTEGER\r?\n\s*\)/.test(dbSrc), 'WIRED …and a fresh database gets the counter year with its schema');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — sync cursor safety: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('SYNC_PULL_CURSOR_DURABLE_ATOMIC_PROVED');
console.log('SYNC_LEGACY_CURSOR_MIGRATION_SAFE_PROVED');
console.log('TRANSFER_DURABLE_SEQUENCE_MIGRATION_PROVED');

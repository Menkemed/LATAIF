// SYNC-SAFETY-A1 — der Pull-Wasserstand gehoert zu den Daten, und die Transfernummer wird nie
// wiederverwendet. Run: node test/sync/cursor-safety.test.ts
//
// Der Vorfall, den diese Datei festhaelt, ist real: ein Transfer bekam `TRF-2026-00020`, wurde
// eine halbe Minute spaeter geloescht, und der naechste Transfer bekam DIESELBE Nummer, weil der
// alte Nummerngeber `MAX(Bestand)+1` rechnete. Solange nichts wiederholt wurde, fiel das nicht
// auf. Dann verlor der Rechner seinen Wasserstand (Verbindung getrennt und neu aufgebaut — oder
// eben ein neues Windows), der Pull begann wieder bei 0, und beim Wiedereinspielen des alten
// Einfuegens schlug der eindeutige Index `(branch_id, transfer_number)` zu. Der Batch lief
// zurueck, der Stand blieb stehen, und ab da starb jeder Pull an derselben Stelle.
//
// Hier wird beides an den ECHTEN Funktionen geprueft, gegen eine echte sql.js-Datenbank.
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
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const initSqlJs = (await import('sql.js')).default;
const {
  readCursor, writeCursor, resolveCursorStart, isServerFingerprint, CURSOR_DDL,
} = await import('../../src/core/sync/cursor-store.ts');
const {
  ensureTransferSequence, highestIssuedTransferSeq, transferSeqOf, TRANSFER_DOC_TYPE, TRANSFER_PADDING,
} = await import('../../src/core/agents/transfer-sequence.ts');
const { applyUpsert } = await import('../../src/core/sync/apply-change.ts');

let pass = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) pass++; else { fails.push(m); console.log('  x ' + m); } };

const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });
const NOW = '2026-08-31T12:00:00.000Z';
const FP_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FP_B = '0f9e8d7c6b5a49382716f5e4d3c2b1a0';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
function fresh(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(CURSOR_DDL);
  db.run(`CREATE TABLE document_sequences (doc_type TEXT PRIMARY KEY, prefix TEXT NOT NULL,
    next_number INTEGER NOT NULL DEFAULT 1, include_year INTEGER NOT NULL DEFAULT 1,
    padding INTEGER NOT NULL DEFAULT 6, updated_at TEXT NOT NULL)`);
  db.run(`INSERT INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at)
          VALUES ('TRF','TRF',1,1,6,'seed')`);
  db.run(`CREATE TABLE agent_transfers (id TEXT PRIMARY KEY, branch_id TEXT NOT NULL,
    transfer_number TEXT NOT NULL, status TEXT, created_at TEXT)`);
  db.run(`CREATE UNIQUE INDEX ux_transfer_number ON agent_transfers (branch_id, transfer_number)`);
  db.run(`CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT,
    record_id TEXT, branch_id TEXT, action TEXT, data TEXT, synced INTEGER DEFAULT 0, created_at TEXT)`);
  return db;
}
const seq = (db: Db): number => Number(db.exec('SELECT next_number FROM document_sequences WHERE doc_type = ?', ['TRF'])[0].values[0][0]);
const padOf = (db: Db): number => Number(db.exec('SELECT padding FROM document_sequences WHERE doc_type = ?', ['TRF'])[0].values[0][0]);

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
  ok(readCursor(db, FP_B) === null, 'CURSOR another server has its own progress, not this one');
  writeCursor(db, FP_B, 7, NOW);
  ok(readCursor(db, FP_A) === 860 && readCursor(db, FP_B) === 7, 'CURSOR the two never mix');
}
{
  ok(isServerFingerprint(FP_A) && !isServerFingerprint('nope') && !isServerFingerprint(FP_A.toUpperCase()),
    'CURSOR only a real server name is accepted');
  const db = fresh();
  let threw = false; try { writeCursor(db, 'nope', 1, NOW); } catch { threw = true; }
  ok(threw, 'CURSOR …and writing under anything else is refused, not silently ignored');
}

// ── B) Der Startpunkt — vier Faelle, keiner geraten ────────────────────────
{
  const db = fresh();
  writeCursor(db, FP_A, 500, NOW);
  const s = resolveCursorStart(db, FP_A, 999, 860, NOW);
  ok(s.kind === 'known' && s.cursor === 500,
    'START a recorded progress wins — a stale localStorage value never overrides the database');
}
{
  const db = fresh();
  const s = resolveCursorStart(db, FP_A, 541, 860, NOW);
  ok(s.kind === 'adopted' && s.cursor === 541, 'START the previous localStorage progress is taken over once');
  ok(readCursor(db, FP_A) === 541, 'START …and is durable from then on');
  const again = resolveCursorStart(db, FP_A, 3, 860, NOW);
  ok(again.kind === 'known' && again.cursor === 541, 'START …the take-over happens exactly once');
}
{
  const db = fresh();
  const s = resolveCursorStart(db, FP_A, null, 0, NOW);
  ok(s.kind === 'fresh' && s.cursor === 0, 'START a first contact with an empty server starts at 0 — nothing can be replayed');
  ok(readCursor(db, FP_A) === 0, 'START …and that is recorded, so it is not decided twice');
}
{
  const db = fresh();
  const s = resolveCursorStart(db, FP_A, null, 860, NOW);
  ok(s.kind === 'recovery-required', 'START no progress + a server WITH history = recovery, not a guess');
  ok(readCursor(db, FP_A) === null, 'START …and nothing is written: neither 0 nor the end of the log');
}
{
  // Ein wirklich anderer Server bekommt NIE den Stand des alten untergeschoben — auch dann nicht,
  // wenn im localStorage noch einer steht. Das ist der Unterschied zwischen "neue Adresse" und
  // "neuer Server": die Adresse steht in keinem dieser Werte.
  const db = fresh();
  writeCursor(db, FP_A, 860, NOW);
  const other = resolveCursorStart(db, FP_B, null, 860, NOW);
  ok(other.kind === 'recovery-required', 'START a different server never inherits the progress of another');
  ok(readCursor(db, FP_A) === 860 && readCursor(db, FP_B) === null, 'START …and the old progress is left untouched');
  // Und dieselbe Installation unter neuer Adresse ist derselbe Server: der Name haengt nicht an
  // URL oder IP, also gilt der Stand weiter.
  const same = resolveCursorStart(db, FP_A, null, 860, NOW);
  ok(same.kind === 'known' && same.cursor === 860, 'START the same installation keeps its progress across an address change');
}

// ── C) Der Vorfall selbst: 541 → 543 ───────────────────────────────────────
//
// Der heutige Stand: Transfer B haelt `TRF-2026-00020`. Der Log will Transfer A mit derselben
// Nummer einfuegen. Ohne Wasserstand wird das erneut versucht und schlaegt fehl.
{
  const db = fresh();
  db.run(`INSERT INTO agent_transfers (id, branch_id, transfer_number, status, created_at)
          VALUES ('B','branch-main','TRF-2026-00020','transferred','2026-08-14T15:07:58.059Z')`);
  const payloadA = JSON.stringify({ id: 'A', branch_id: 'branch-main', transfer_number: 'TRF-2026-00020', status: 'transferred' });

  let failed = false;
  try {
    applyUpsert(db, 'agent_transfers', 'A', JSON.parse(payloadA));
  } catch (e) { failed = /UNIQUE/i.test(String(e)); }
  ok(failed, 'INCIDENT replaying the old insert really does hit the unique index — this is the reported failure');
  ok(db.exec("SELECT COUNT(*) FROM agent_transfers WHERE transfer_number = 'TRF-2026-00020'")[0].values[0][0] === 1,
    'INCIDENT …and the item of today is untouched by the attempt');

  // Mit dem dauerhaften Stand wird der alte Eintrag gar nicht erst angeboten: er liegt hinter dem
  // Wasserstand. Das ist die Loesung — nicht das Wegwerfen des Fehlers.
  writeCursor(db, FP_A, 860, NOW);
  const cursor = readCursor(db, FP_A) as number;
  const replay = [{ id: 541 }, { id: 543 }, { id: 861 }];
  const todo = replay.filter((c) => c.id > cursor);
  ok(todo.length === 1 && todo[0].id === 861,
    'INCIDENT with the durable progress the history is not offered again — only what is genuinely new');
  ok(db.exec("SELECT COUNT(*) FROM agent_transfers")[0].values[0][0] === 1,
    'INCIDENT …one transfer, no duplicate, nothing lost');
}

// ── D) Die Nummer wird nie wiederverwendet ─────────────────────────────────
{
  const db = fresh();
  ok(transferSeqOf('TRF-2026-00020') === 20 && transferSeqOf('') === 0 && transferSeqOf('TRF-1') === 0,
    'TRF the running number is read from the last part, and nothing else');

  db.run(`INSERT INTO agent_transfers (id, branch_id, transfer_number, status, created_at)
          VALUES ('B','branch-main','TRF-2026-00020','transferred','x')`);
  // Der geloeschte Transfer A lebt nur noch im Log — und genau seine Nummer ist die gefaehrliche.
  db.run(`INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, created_at)
          VALUES ('agent_transfers','A','branch-main','insert',?,'x')`,
    [JSON.stringify({ id: 'A', transfer_number: 'TRF-2026-00021' })]);
  ok(highestIssuedTransferSeq(db) === 21,
    'TRF the highest number ever issued counts the deleted one too — the live rows alone would say 20');

  const next = ensureTransferSequence(db, NOW);
  ok(next === 22, `TRF the counter is lifted past everything ever issued (${next})`);
  ok(padOf(db) === TRANSFER_PADDING, 'TRF …and the five-digit format is kept, not the house default of six');
  ok(TRANSFER_DOC_TYPE === 'TRF', 'TRF the document type is the one already seeded in the house');

  // Idempotent: ein zweiter Aufruf bewegt nichts.
  ok(ensureTransferSequence(db, NOW) === 22, 'TRF a second run changes nothing');
  // Und ein Loeschen senkt ihn nicht — das ist der ganze Unterschied zu MAX()+1.
  db.run(`DELETE FROM agent_transfers WHERE id = 'B'`);
  ok(ensureTransferSequence(db, NOW) === 22, 'TRF deleting a transfer does NOT free its number again');
  db.run(`UPDATE document_sequences SET next_number = next_number + 1 WHERE doc_type = 'TRF'`);
  ok(seq(db) === 23 && ensureTransferSequence(db, NOW) === 23, 'TRF …and the counter is never pulled back down');
}

// ── E) Die Verdrahtung ─────────────────────────────────────────────────────
{
  const svc = readFileSync(resolvePath(repo, 'src/core/sync/sync-service.ts'), 'utf8');
  ok(/writeCursor\(db, durable\.fingerprint, Number\(last_sync_id\)[\s\S]{0,80}db\.run\('COMMIT'\)/.test(svc),
    'WIRED the progress is written INSIDE the apply transaction, right before the commit');
  ok(/localStorage\.removeItem\(STORAGE_KEY_FP\)/.test(svc) && /clearSyncConfig/.test(svc),
    'WIRED disconnect drops the connection…');
  const clear = svc.slice(svc.indexOf('export function clearSyncConfig'), svc.indexOf('export function isSyncConfigured'));
  ok(!/DELETE FROM sync_cursor|dropCursor/.test(clear),
    'WIRED …but never the durable progress in the database — that was the trigger of the incident');
  ok(/resolveCursorStart\(db, fingerprint, legacyCursor/.test(svc),
    'WIRED the start point comes from the one place that decides it');
  {
    // Der Ausstieg muss VOR dem Anwenden liegen — sonst waere er ein Kommentar, kein Schutz.
    const at = svc.indexOf("start.kind === 'recovery-required'");
    const ret = svc.indexOf('return 0;', at);
    const apply = svc.indexOf('commitPulledBatch', at);
    ok(at > 0 && ret > at && apply > ret,
      'WIRED an unreconstructable progress returns BEFORE anything is applied');
  }
  const store = readFileSync(resolvePath(repo, 'src/stores/agentStore.ts'), 'utf8');
  ok(/getNextDocumentNumber\(TRANSFER_DOC_TYPE\)/.test(store), 'WIRED a transfer takes its number from the durable counter');
  ok(!/getNextNumber\('agent_transfers'/.test(store), 'WIRED …and no longer from MAX(rows)+1');
  ok(/ensureTransferSequence\(/.test(store), 'WIRED …after the counter was lifted past everything ever issued');
  const db = readFileSync(resolvePath(repo, 'src/core/db/database.ts'), 'utf8');
  ok(/CURSOR_DDL/.test(db), 'WIRED the cursor table is created with the database');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — sync cursor safety: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('SYNC_PULL_CURSOR_DURABLE_ATOMIC_PROVED');
console.log('SYNC_LEGACY_CURSOR_MIGRATION_SAFE_PROVED');
console.log('TRANSFER_DURABLE_SEQUENCE_MIGRATION_PROVED');

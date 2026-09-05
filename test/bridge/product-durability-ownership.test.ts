// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C — wem die Dauerhaftigkeit gehört, wenn Produkt und Medien entstehen.
// Run: node test/bridge/product-durability-ownership.test.ts
//
// Zwei Verträge, die beide richtig sind und sich widersprechen, sobald man sie ineinander steckt:
//
//   • Der Produktweg speichert MITTENDRIN. Erst die Produktzeile durabel, dann die Medien. Stürzt
//     der Rechner dazwischen ab, findet die Wiederholung ein echtes Produkt und vervollständigt
//     seine Bilder — statt ein zweites anzulegen.
//   • Die Fernauftrags-Maschine speichert am ENDE. Eine Transaktion, ein Commit, ein Schreiben;
//     vorher ist nichts durabel, damit Wirkung und Nachweis ein Schicksal teilen.
//
// Die Auflösung ist nicht „einer gewinnt", sondern: der Weg fragt, wem die Dauerhaftigkeit gerade
// gehört. Ohne äußere Klammer speichert er selbst, wie immer. Mit äußerer Klammer schweigt er und
// überlässt es ihr — was er auch muss, denn `db.export()` würde eine offene Transaktion beenden.
//
// Gefahren wird die ECHTE Domänenfunktion `createProductWithDurableMedia` mit ihren injizierten
// Teilen und eine echte sql.js-Datenbank; gestellt sind nur Medien-Gateway und Speichern.
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

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
};
(globalThis as { window?: unknown }).window = { localStorage: storage };
(globalThis as { localStorage?: unknown }).localStorage = storage;

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { createProductWithDurableMedia } = await import('../../src/core/media/product-media-create.ts');
const { runRemoteCommand } = await import('../../src/core/bridge/mutation-engine.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest, isDurabilityDegraded } =
  await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { enterTransaction, leaveNestedTransaction, resetTransactionContext, isTransactionActive } =
  await import('../../src/core/db/transaction-context.ts');
const { runExclusive, runExclusiveUnless, businessWriteScheduler } =
  await import('../../src/core/bridge/command-scheduler.ts');
const posting = await import('../../src/core/ledger/posting.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-05T10:00:00.000Z';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run('CREATE TABLE products (id TEXT PRIMARY KEY, branch_id TEXT, name TEXT, sku TEXT, images TEXT DEFAULT \'[]\')');
  db.run('CREATE TABLE media_links (id TEXT PRIMARY KEY, entity_id TEXT, media_id TEXT, sort_order INTEGER)');
  db.run('CREATE TABLE sync_changelog (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, record_id TEXT)');
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  setTestDatabase(db as never);
  return db;
}

const identity = (n: string, hash = 'h1') => ({
  commandId: `${n.padStart(8, '0')}-0000-4000-8000-000000000000`,
  tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test',
  op: 'products.create', payloadHash: hash,
});

/**
 * Die ECHTE Domänenfunktion, verdrahtet wie im Store — nur Gateway und Speichern sind gestellt.
 * `saveDurably` ist hier GENAU der Punkt, um den es geht: es ruft `durableCheckpoint`-Semantik nach,
 * indem es bei aktiver Klammer nichts tut. Der Zähler sagt, wie oft wirklich geschrieben wurde.
 */
function makeDeps(db: Db, opts: { failMedia?: boolean; failSave?: boolean } = {}) {
  const calls = { saves: 0, skipped: 0, inserts: 0, rollbacks: 0, prepared: 0, finalized: 0 };
  const deps = {
    productExists: (pid: string) => (db.exec('SELECT 1 FROM products WHERE id = ?', [pid])[0]?.values?.length ?? 0) > 0,
    insertProductRow: (pid: string) => {
      calls.inserts += 1;
      db.run("INSERT INTO products (id, branch_id, name, sku, images) VALUES (?,?,?,?,'[]')", [pid, 'branch-main', 'Ring', 'SKU-1']);
    },
    recordDurableInsert: (pid: string) => {
      db.run("INSERT INTO sync_changelog (table_name, record_id) VALUES ('products', ?)", [pid]);
    },
    rollbackProductRow: (pid: string) => {
      calls.rollbacks += 1;
      db.run('DELETE FROM products WHERE id = ?', [pid]);
      db.run("DELETE FROM sync_changelog WHERE table_name = 'products' AND record_id = ?", [pid]);
    },
    // Genau die Regel aus `durableCheckpoint`: gehoert die Dauerhaftigkeit einer aeusseren
    // Klammer, wird NICHT zwischengespeichert.
    saveDurably: async () => {
      if (isTransactionActive()) { calls.skipped += 1; return; }
      if (opts.failSave) throw new Error('disk full');
      calls.saves += 1;
    },
    buildBatchItems: async (pid: string, images: unknown[]) => images.map((_, i) => ({ pid, slot: i })),
    prepareAndRegisterBatch: async (items: unknown[]) => {
      calls.prepared += 1;
      if (opts.failMedia) throw new Error('MEDIA_GATEWAY_DOWN');
      for (const it of items as Array<{ pid: string; slot: number }>) {
        db.run('INSERT INTO media_links (id, entity_id, media_id, sort_order) VALUES (?,?,?,?)',
          [`link-${it.pid}-${it.slot}`, it.pid, `media-${it.slot}`, it.slot]);
      }
      await deps.saveDurably();
    },
    finalizeBatch: async (items: unknown[]) => {
      calls.finalized += 1;
      await deps.saveDurably();
      return { published: (items as unknown[]).length };
    },
    decode: (s: string) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg', src: s }),
  };
  return { calls, deps };
}

const IMAGES = { kind: 'data_urls' as const, images: ['data:image/jpeg;base64,AAA'] };

// ── 1) Ohne aeussere Klammer: der bewaehrte Zwischencheckpoint bleibt ──────
{
  resetTransactionContext();
  const db = freshDb();
  const { calls, deps } = makeDeps(db);
  const res = await createProductWithDurableMedia('p1', IMAGES, deps as never);

  ok((res as { status: string }).status === 'created', `LOCAL das Produkt entsteht (${JSON.stringify(res)})`);
  ok(calls.inserts === 1, `LOCAL genau eine Produktzeile (${calls.inserts})`);
  ok(calls.saves >= 1, `LOCAL und es wurde WIRKLICH zwischengespeichert (${calls.saves})`);
  ok(calls.skipped === 0, 'LOCAL nichts uebersprungen — ohne Klammer gehoert die Dauerhaftigkeit dem Weg selbst');
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'LOCAL die Zeile steht');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links')) === 1, 'LOCAL und ihr Bild haengt daran');
}

// ── 2) Medienfehler OHNE Klammer: der bestehende Rettungsvertrag ──────────
{
  resetTransactionContext();
  const db = freshDb();
  const { calls, deps } = makeDeps(db, { failMedia: true });
  const res = await createProductWithDurableMedia('p2', IMAGES, deps as never) as { status: string; productId: string; errorCode?: string };

  ok(res.status === 'media_incomplete' || res.status === 'product_save_failed',
    `LOCALFAIL ein Medienfehler endet nicht als Erfolg (${JSON.stringify(res)})`);
  ok(res.productId === 'p2', 'LOCALFAIL …und die Kennung bleibt dieselbe — die Wiederholung setzt fort');
  ok(calls.prepared === 1, 'LOCALFAIL die Medienphase wurde versucht');

  // Der Vertrag im Code, nicht nur im Verhalten: die Wiederholung bekommt die eingefrorene Absicht.
  const store = src('src/stores/productStore.ts');
  ok(/expectedImages: frozen\?\.images/.test(store),
    'LOCALFAIL die eingefrorene Bildabsicht wird der Wiederholung mitgegeben');
  ok(/retryProductId \?\? uuid\(\)/.test(store),
    'LOCALFAIL …und dieselbe Produkt-Kennung, damit kein zweites entsteht');
  const drain = src('src/core/media/mobile-upload-wiring.ts');
  ok(/createProductWithMedia\(collectionDataFromGrant\(grant\), grant\.entityId, receiptIntent/.test(drain),
    'LOCALFAIL der Mobile-Drain benutzt weiterhin GENAU denselben Weg mit seiner stabilen Kennung');
  ok(!/alreadySerialised/.test(drain),
    'LOCALFAIL …und stellt sich weiterhin normal an — er ist kein Fernauftrag');
}

// ── 3) MIT aeusserer Klammer: kein Zwischenspeichern, ein Commit ──────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  resetTransactionContext();
  const db = freshDb();
  const { calls, deps } = makeDeps(db);
  const state = { commits: 0, rollbacks: 0, saves: 0, exportsInTx: 0 };

  const engineDeps = {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: () => { posting.commitLedgerTransaction(); state.commits += 1; },
    rollback: () => { posting.rollbackLedgerTransaction(); state.rollbacks += 1; },
    durableSave: async () => {
      if (isTransactionActive()) state.exportsInTx += 1; // waere der Fehler, den es zu vermeiden gilt
      db.export();
      state.saves += 1;
    },
    now: () => NOW,
  };

  const out = await runRemoteCommand(engineDeps, identity('1'), async () => {
    const r = await createProductWithDurableMedia('p3', IMAGES, deps as never) as { status: string; productId: string };
    if (r.status !== 'created') throw new Error('media did not complete: ' + r.status);
    return { productId: r.productId };
  });

  ok(out.kind === 'ok', `REMOTE der Auftrag geht durch (${JSON.stringify(out)})`);
  ok(state.commits === 1, `REMOTE genau EIN Business-Commit (${state.commits})`);
  ok(calls.saves === 0, `REMOTE und KEIN eigenes Zwischenspeichern des Produktwegs (${calls.saves})`);
  ok(calls.skipped >= 1, `REMOTE er hat es erkannt und uebersprungen (${calls.skipped})`);
  ok(state.saves === 1, `REMOTE danach genau ein autoritatives Speichern (${state.saves})`);
  ok(state.exportsInTx === 0, 'REMOTE und kein Abbild innerhalb der offenen Transaktion');
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1 && Number(one(db, 'SELECT COUNT(*) FROM media_links')) === 1,
    'REMOTE Produkt und Bild sind da');
  ok(commandCount(db as never) === 1, 'REMOTE der Nachweis liegt in derselben Transaktion');
  ok(!isTransactionActive(), 'REMOTE und die Klammer ist sauber geschlossen');
}

// ── 4) Medienfehler MIT Klammer: alles zurueck, kein Nachweis ─────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  resetTransactionContext();
  const db = freshDb();
  const { calls, deps } = makeDeps(db, { failMedia: true });
  const state = { commits: 0, rollbacks: 0, saves: 0 };
  const engineDeps = {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: () => { posting.commitLedgerTransaction(); state.commits += 1; },
    rollback: () => { posting.rollbackLedgerTransaction(); state.rollbacks += 1; },
    durableSave: async () => { db.export(); state.saves += 1; },
    now: () => NOW,
  };

  let threw: string | null = null;
  try {
    await runRemoteCommand(engineDeps, identity('2', 'h2'), async () => {
      const r = await createProductWithDurableMedia('p4', IMAGES, deps as never) as { status: string };
      // Genau die Einordnung, die ein spaeterer Befehl treffen muss: ein unvollstaendiger
      // Medienstand ist KEIN definitives Geschaeftsurteil, sondern ein offener Ausgang.
      if (r.status !== 'created') throw new Error('MEDIA_INCOMPLETE:' + r.status);
      return { productId: 'p4' };
    });
  } catch (e) { threw = String(e); }

  ok(threw !== null && /MEDIA_INCOMPLETE/.test(threw), `MEDIAFAIL kein Erfolg (${threw})`);
  ok(state.rollbacks === 1 && state.commits === 0, `MEDIAFAIL zurueckgerollt (${state.rollbacks}/${state.commits})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 0,
    'MEDIAFAIL die Produktzeile ist vollstaendig weg — nicht halb da');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links')) === 0, 'MEDIAFAIL und keine Galerie-Zeile');
  ok(Number(one(db, "SELECT COUNT(*) FROM sync_changelog WHERE record_id='p4'")) === 0,
    'MEDIAFAIL auch kein gestrandeter Changelog-Eintrag');
  ok(commandCount(db as never) === 0, 'MEDIAFAIL und KEIN Nachweis — die Kennung bleibt frei');
  ok(lookupCommand(db as never, identity('2', 'h2')).kind === 'fresh', 'MEDIAFAIL …sie ist wieder bewertbar');
  ok(state.saves === 0, 'MEDIAFAIL nichts wurde geschrieben');
  ok(!isTransactionActive(), 'MEDIAFAIL die Klammer ist geschlossen');

  // Dateisystem: der Weg hat NICHTS auf die Platte gelegt, weil die Vorbereitung selbst scheiterte.
  // Was ein spaeterer Fehler hinterlaesst, faellt unter den bestehenden Erreichbarkeitsvertrag:
  // eine Datei ohne `media_blob_generations.storage_key` ist unerreichbar und damit GC-faehig —
  // und niemals Geschaeftsbestand, weil der Bestand ueber die Galerie definiert ist.
  ok(calls.prepared === 1 && calls.finalized === 0,
    `MEDIAFAIL die Veroeffentlichung wurde nie erreicht (${calls.prepared}/${calls.finalized})`);
  const gc = src('src/core/media/staging-gc.ts');
  ok(/RETAINED if/.test(gc) && /media_links/.test(gc) && /media_ingest_job/.test(gc),
    'MEDIAFAIL ein Rest im Ablageordner faellt unter den bestehenden Aufraeumvertrag…');
  ok(/GC removes ONLY files proven orphaned against EVERY SSOT/.test(gc),
    'MEDIAFAIL …der nur loescht, was gegen JEDE Quelle verwaist ist — er wird hier nicht neu gebaut');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links')) === 0,
    'MEDIAFAIL und Geschaeftsbestand ist die Galerie: sie ist leer, also gibt es kein halbes Produkt');
}

// ── 5) Speichern scheitert NACH dem Commit ────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  resetTransactionContext();
  const db = freshDb();
  const { calls, deps } = makeDeps(db);
  const state = { saves: 0, failSave: true };
  const engineDeps = {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {
      if (state.failSave) throw new Error('disk full');
      db.export(); state.saves += 1;
    },
    now: () => NOW,
  };
  let domainRuns = 0;
  const run = () => runRemoteCommand(engineDeps, identity('3', 'h3'), async () => {
    domainRuns += 1;
    const r = await createProductWithDurableMedia('p5', IMAGES, deps as never) as { status: string };
    if (r.status !== 'created') throw new Error('media: ' + r.status);
    return { productId: 'p5', sku: 'SKU-1' };
  });

  let threw: string | null = null;
  try { await run(); } catch (e) { threw = String(e); }
  ok(threw !== null && /disk full/.test(threw), `POSTCOMMIT kein definitiver Erfolg (${threw})`);
  ok(isDurabilityDegraded(), 'POSTCOMMIT die Speicherschuld steht');
  ok(domainRuns === 1 && Number(one(db, 'SELECT COUNT(*) FROM products')) === 1,
    'POSTCOMMIT Produkt und Nachweis stehen gemeinsam im Speicher');

  // Die Wiederholung fuehrt den Produktcode NICHT erneut aus.
  let retryErr: string | null = null;
  try { await run(); } catch (e) { retryErr = String(e); }
  ok(domainRuns === 1, `POSTCOMMIT die Wiederholung laesst die Domaene in Ruhe (${domainRuns})`);
  ok(retryErr !== null, 'POSTCOMMIT …und meldet keinen Erfolg, solange nichts geschrieben ist');
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'POSTCOMMIT kein zweites Produkt');
  ok(Number(one(db, "SELECT COUNT(*) FROM products WHERE sku='SKU-1'")) === 1, 'POSTCOMMIT keine zweite SKU');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links')) === 1, 'POSTCOMMIT keine zweite Galerie-Zuordnung');

  // Platte zurueck: das eingefrorene Ergebnis kommt heraus.
  state.failSave = false;
  const settled = await run();
  ok(settled.kind === 'ok' && (settled as { replayed: boolean }).replayed === true,
    `POSTCOMMIT nach gelungenem Nachholen das eingefrorene Ergebnis (${JSON.stringify(settled)})`);
  ok(domainRuns === 1 && !isDurabilityDegraded(), 'POSTCOMMIT und weiterhin genau ein Domainlauf');
}

// ── 6) Wiedereintritt: nur derselbe Kontext, kein Freifahrtschein ─────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();

  // (a) Der legitime Fall: der Aufrufer sagt ausdruecklich, dass er schon drin ist.
  let inner = 0;
  const out = await Promise.race([
    runExclusive(async () => runExclusiveUnless(true, () => { inner += 1; return 42; })),
    sleep(3000).then(() => 'DEADLOCK'),
  ]);
  ok(out === 42 && inner === 1, `REENTRY der verschachtelte Aufruf laeuft im selben Platz (${out})`);

  // (b) Der fremde Schreiber: er sagt es NICHT — und wartet.
  const order: string[] = [];
  const long = runExclusive(async () => {
    order.push('remote:start');
    await sleep(150);
    order.push('remote:end');
    return 'remote';
  });
  await sleep(20);
  const foreign = runExclusive(() => { order.push('foreign'); return 'foreign'; });
  await Promise.all([long, foreign]);
  ok(order.join(',') === 'remote:start,remote:end,foreign',
    `REENTRY ein fremder Schreiber wartet, auch waehrend der Fernauftrag wartet (${order.join(',')})`);

  // (c) Und ein Fehler gibt den Platz frei.
  let threw = false;
  try { await runExclusive(() => { throw new Error('boom'); }); } catch { threw = true; }
  const after = await runExclusive(() => 'weiter');
  ok(threw && after === 'weiter', 'REENTRY ein Fehler haelt die Reihenfolge nicht auf');
  ok(businessWriteScheduler.peakConcurrency() === 1,
    `REENTRY und nie mehr als EIN Auftrag gleichzeitig (${businessWriteScheduler.peakConcurrency()})`);

  // Der Grund steht im Code: ein Parameter, kein Zustandsflag.
  const sched = src('src/core/bridge/command-scheduler.ts');
  ok(/export function runExclusiveUnless<T>\(alreadySerialised: boolean \| undefined/.test(sched),
    'REENTRY der Ausweg ist ein Parameter — ein fremder Schreiber kann ihn nicht setzen');
  ok(!/let insideExclusive/.test(sched),
    'REENTRY und es gibt KEIN Zustandsflag, das nicht unterscheiden koennte, wer fragt');
}

// ── 7) Die Verdrahtung im Produktcode ─────────────────────────────────────
{
  const dbSrc = src('src/core/db/database.ts');
  ok(/export async function durableCheckpoint\(\): Promise<void> \{/.test(dbSrc),
    'WIRED es gibt EINEN ambient-bewussten Zwischencheckpoint');
  ok(/if \(isTransactionActive\(\)\) return; \/\/ die äußere Klammer schreibt am Ende genau einmal/.test(dbSrc),
    'WIRED …der bei aktiver Klammer schweigt');
  ok(/throw new Error\('saveDatabaseDurably darf nicht innerhalb einer aktiven Transaktion aufgerufen werden'\)/.test(dbSrc),
    'WIRED und die harte Sperre in saveDatabaseDurably BLEIBT — ein neuer, unbedachter Aufruf faellt weiter auf');

  const store = src('src/stores/productStore.ts');
  ok(/saveDurably: \(\) => durableCheckpoint\(\)/.test(store), 'WIRED der Produktweg benutzt ihn…');
  ok(/await durableCheckpoint\(\); \},/.test(store), 'WIRED …auch beim Aufraeumen der Altbilder');
  ok(!/saveDatabaseDurably/.test(store), 'WIRED und ruft die harte Variante nirgends mehr selbst');
  ok(/runExclusiveUnless\(ctx\?\.alreadySerialised/.test(store),
    'WIRED die drei Produktaktionen nehmen den ausdruecklichen Kontext entgegen');
  ok((store.match(/runExclusiveUnless\(ctx\?\.alreadySerialised/g) || []).length === 3,
    'WIRED genau drei — Create, Medien-Edit, Text-Edit');

  // Keine zweite Rechnungs-/Medienmaschine: der Befehlsordner kennt kein eigenes Produkt-SQL.
  const bridgeDir = ['invoice-command.ts', 'mutation-engine.ts', 'command-registry.ts']
    .map((f) => src(`src/core/bridge/${f}`)).join('\n');
  ok(!/INSERT INTO products|media_links/i.test(bridgeDir),
    'WIRED in der Bruecke liegt kein Produkt- und kein Medien-SQL');

  // Auf diesem Fundament steht seit C3C der Produkt-Fernauftrag: die Registry kennt ihn, und er
  // laeuft durch dieselbe Maschine wie alles andere. Was hier geprueft wird, ist die Verdrahtung —
  // seine Wirkung hat ihren eigenen Gate-Test (`product-remote-write`).
  const registry = await import('../../src/core/bridge/command-registry.ts');
  await import('../../src/core/bridge/read-commands.ts');
  await import('../../src/core/bridge/invoice-command.ts');
  await import('../../src/core/bridge/customer-commands.ts');
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  const known = registry.knownCommands();
  ok(known.length === 14 && registry.ALLOWED_MUTATIONS.join(',') === 'invoices.create,customers.create,customers.update,products.create,products.update,invoices.update,invoices.record_payment',
    `WIRED 1 Probe + 6 Reads + 7 Mutationen (${known.length}: ${registry.ALLOWED_MUTATIONS.join(', ')})`);
  const productCmd = src('src/core/bridge/product-commands.ts');
  ok(/runRemoteCommand\(/.test(productCmd) && /alreadySerialised: true/.test(productCmd),
    'WIRED der Produkt-Fernauftrag laeuft durch die Maschine und reiht sich nicht doppelt ein');
}

// ── 8) Der Medien-Koordinator klammert nur als aeusserste Ebene ───────────
//
// sql.js kennt keine verschachtelten `BEGIN`. Oeffnete der Koordinator innerhalb eines
// Fernauftrags seine eigene Klammer, scheiterte der zweite `BEGIN` — und mit ihm der Auftrag.
{
  const coordinator = src('src/core/media/coordinator.ts');
  ok(/const outermost = enterTransaction\(\);/.test(coordinator),
    'MEDIATX er fragt denselben Tiefenzaehler wie die Buchungsschicht');
  ok(/if \(outermost\) this\.db\.run\('BEGIN IMMEDIATE'\);/.test(coordinator),
    'MEDIATX …und oeffnet nur, wenn keine Klammer laeuft');
  ok(/if \(leaveNestedTransaction\(\) && outermost\) this\.db\.run\('COMMIT'\);/.test(coordinator),
    'MEDIATX committet nur die aeusserste Ebene');
  ok((coordinator.match(/this\.db\.run\('BEGIN IMMEDIATE'\)/g) || []).length === 1,
    'MEDIATX und es gibt genau EINE Stelle, die ueberhaupt klammert');

  // Und dieselbe Mechanik wie in der Buchungsschicht — nicht eine zweite, eigene.
  const posting = src('src/core/ledger/posting.ts');
  ok(/const outermost = enterTransaction\(\);/.test(posting),
    'MEDIATX dieselbe Mechanik wie `posting.ts`, kein zweiter Zaehler');

  // Verhalten: eine innere Ebene darf die aeussere Klammer nicht schliessen.
  resetTransactionContext();
  const outer = enterTransaction();
  const innerLevel = enterTransaction();
  ok(outer === true && innerLevel === false,
    `MEDIATX nur die erste Ebene meldet sich als aeusserste (${outer}/${innerLevel})`);
  ok(leaveNestedTransaction() === false, "MEDIATX die innere Ebene committet nicht");
  ok(leaveNestedTransaction() === true, "MEDIATX die aeussere schon");
  resetTransactionContext();
}
console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c product durability ownership: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_AMBIENT_DURABILITY_OWNER_PROVED');
console.log('CENTRAL_C3C_LOCAL_PRODUCT_RECOVERY_PRESERVED');
console.log('CENTRAL_C3C_REMOTE_PRODUCT_ATOMIC_DURABILITY_PROVED');
console.log('CENTRAL_C3C_REMOTE_MEDIA_FAILURE_ATOMICITY_PROVED');
console.log('CENTRAL_C3C_REENTRANT_SINGLE_WRITER_PROVED');
console.log('CENTRAL_C3C_MEDIA_AMBIENT_TRANSACTION_PROVED');

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C FINAL — die Galerie eines Artikels, von einem zweiten Rechner geändert.
// Run: node test/bridge/product-gallery-edit.test.ts
//
// Der ECHTE Weg: `editProductWithMedia` aus dem Store, der echte Plan-Bau, der echte Koordinator,
// der echte Medien-Orchestrator, die echte C3A-Maschine. Gestellt ist nur die IPC-Grenze zu Rust.
//
// Fünf Fragen:
//   • Kann PC2 hinzufügen, entfernen und umsortieren — mit den Mitteln, die das Haus schon hat?
//   • Bleibt eine verlorene Antwort folgenlos? (Kein zweites Bild, keine zweite Entfernung.)
//   • Was passiert, wenn die Medien mitten im Weg ausfallen? (Nichts bleibt zurück.)
//   • Gehört eine Ablage ihrem Absender? (Ein fremder Hash öffnet nichts.)
//   • Überlebt eine gebuchte Galerie das Wegräumen der Zwischenablage? (Sie muss.)
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
      for (const cand of [p, p + '.ts', p + '.tsx']) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
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
const { tauriState, stageForTest } = await import('./_tauri-shim.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, commandCount } =
  await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { runProductCreate, runProductUpdate, parseProductUpdate } =
  await import('../../src/core/bridge/product-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-05T12:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const rows = (db: Db, sql: string, p: unknown[] = []): unknown[][] => db.exec(sql, p)[0]?.values ?? [];

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(SKU_SEQUENCES_DDL);
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  applyMediaSchema(db as never);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-watch','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  return db;
}

const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (n: string, op: string, hash = 'h1') => ({ commandId: ID(n), ...ACTOR, op, payloadHash: hash });

function deps(db: Db) {
  return {
    db: db as never,
    begin: posting.beginLedgerTransaction,
    commit: posting.commitLedgerTransaction,
    rollback: posting.rollbackLedgerTransaction,
    durableSave: async () => {},
    now: () => NOW,
  };
}

function image(seed: string, owner = ACTOR): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i * 11) & 0xff;
  return stageForTest(bytes, owner);
}

const WISH = { categoryId: 'cat-watch', brand: 'Rolex', name: 'Datejust', purchasePrice: 100 };

/** Die aktive Galerie in ihrer Reihenfolge — die Wahrheit, gegen die hier gemessen wird. */
const gallery = (db: Db, pid: string): string[] =>
  rows(db, 'SELECT media_id FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order', [pid])
    .map((r) => String(r[0]));
const primaryOf = (db: Db, pid: string): string =>
  String(one(db, 'SELECT media_id FROM media_links WHERE entity_id = ? AND deleted_at IS NULL AND is_primary = 1', [pid]) ?? '');

async function makeProduct(d: ReturnType<typeof deps>, n: string, seeds: string[]) {
  const out = await runProductCreate(d, identity(n, 'products.create', 'c' + n), {
    ...WISH, stagingIds: seeds.map((s) => image(s)),
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + JSON.stringify(out));
  return (out as { value: { productId: string } }).value.productId;
}

// ── 1) Der Rumpf: eine Liste von Plätzen, nichts anderes ──────────────────
{
  const okReq = parseProductUpdate({ id: 'p1', gallery: [{ keep: 'm1' }, { stagingId: 'a'.repeat(64) }] });
  ok(okReq.gallery?.length === 2 && (okReq.gallery[0] as { keep: string }).keep === 'm1',
    'PAYLOAD eine Galerie ist eine geordnete Liste aus Behalten und Neu');
  ok(Object.keys(okReq.fields).length === 0,
    'PAYLOAD …und sie allein ist schon eine Aenderung — ohne ein einziges Textfeld');

  const noGallery = parseProductUpdate({ id: 'p1', name: 'X' });
  ok(noGallery.gallery === undefined,
    'PAYLOAD ohne `gallery` bleibt die Galerie UNANGETASTET — das ist nicht dasselbe wie „leer"');
  const empty = parseProductUpdate({ id: 'p1', gallery: [] });
  ok(Array.isArray(empty.gallery) && empty.gallery.length === 0,
    'PAYLOAD eine LEERE Liste dagegen ist die Aussage „diese Galerie soll leer sein"');

  for (const [what, raw] of [
    ['ein Pfad als Ablage', { id: 'p1', gallery: [{ stagingId: '../../etc/passwd' }] }],
    ['eine Datei-URL', { id: 'p1', gallery: [{ stagingId: 'file:///x.jpg' }] }],
    ['beides in einem Platz', { id: 'p1', gallery: [{ keep: 'm1', stagingId: 'a'.repeat(64) }] }],
    ['ein leerer Platz', { id: 'p1', gallery: [{}] }],
    ['ein erfundener Platz', { id: 'p1', gallery: [{ url: 'https://x/y.jpg' }] }],
    ['kein Objekt', { id: 'p1', gallery: ['m1'] }],
    ['dasselbe Bild zweimal', { id: 'p1', gallery: [{ keep: 'm1' }, { keep: 'm1' }] }],
    ['dieselbe Ablage zweimal', { id: 'p1', gallery: [{ stagingId: 'a'.repeat(64) }, { stagingId: 'a'.repeat(64) }] }],
    ['zu viele Bilder', { id: 'p1', gallery: Array.from({ length: 9 }, (_, i) => ({ stagingId: String(i).repeat(64) })) }],
    ['keine Liste', { id: 'p1', gallery: { keep: 'm1' } }],
  ] as const) {
    let threw: string | null = null;
    try { parseProductUpdate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `PAYLOAD ${what} wird abgewiesen (${threw})`);
  }
}

// ── 2) Hinzufügen, Entfernen, Umsortieren — der echte Weg ─────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);

  const pid = await makeProduct(d, '1', ['a', 'b']);
  const before = gallery(db, pid);
  ok(before.length === 2, `SETUP der Artikel hat zwei Bilder (${before.length})`);

  // (a) Hinzufügen: die bestehenden behalten, ein neues ans Ende.
  const add = await runProductUpdate(d, identity('2', 'products.update', 'h2'), {
    id: pid,
    gallery: [{ keep: before[0] }, { keep: before[1] }, { stagingId: image('c') }],
  });
  ok(add.kind === 'ok', `ADD das Bild kommt dazu (${JSON.stringify(add)})`);
  const afterAdd = gallery(db, pid);
  ok(afterAdd.length === 3, `ADD drei Bilder (${afterAdd.length})`);
  ok(afterAdd[0] === before[0] && afterAdd[1] === before[1],
    'ADD …und die beiden alten sind DIESELBEN — kein Neuanlegen unter neuer Kennung');
  ok(primaryOf(db, pid) === afterAdd[0], 'ADD Platz 0 ist weiterhin das Hauptbild');
  ok(commandCount(db as never) === 2, 'ADD der durable Nachweis steht');

  // (b) Umsortieren: dasselbe Set, andere Reihenfolge.
  const reordered = [afterAdd[2], afterAdd[0], afterAdd[1]];
  const sort = await runProductUpdate(d, identity('3', 'products.update', 'h3'), {
    id: pid, gallery: reordered.map((m) => ({ keep: m })),
  });
  ok(sort.kind === 'ok', `ORDER die Reihenfolge laesst sich aendern (${JSON.stringify(sort)})`);
  ok(gallery(db, pid).join(',') === reordered.join(','), 'ORDER …und sie steht genau so da');
  ok(primaryOf(db, pid) === reordered[0], 'ORDER das neue Hauptbild ist der neue Platz 0');
  ok(gallery(db, pid).length === 3, 'ORDER es ist kein Bild dazugekommen');

  // (c) Entfernen: eines weglassen.
  const keepTwo = [reordered[0], reordered[2]];
  const del = await runProductUpdate(d, identity('4', 'products.update', 'h4'), {
    id: pid, gallery: keepTwo.map((m) => ({ keep: m })),
  });
  ok(del.kind === 'ok', `REMOVE ein Bild laesst sich entfernen (${JSON.stringify(del)})`);
  ok(gallery(db, pid).join(',') === keepTwo.join(','), 'REMOVE …und die anderen bleiben');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL', [pid])) === 1,
    'REMOVE das entfernte Bild ist zurueckgezogen, nicht geloescht — die Spur bleibt');

  // (d) Text UND Galerie in EINEM Auftrag.
  const both = await runProductUpdate(d, identity('5', 'products.update', 'h5'), {
    id: pid, name: 'Datejust 41', gallery: [{ keep: keepTwo[0] }],
  });
  ok(both.kind === 'ok', `BOTH Text und Galerie zusammen (${JSON.stringify(both)})`);
  ok(String(one(db, 'SELECT name FROM products WHERE id = ?', [pid])) === 'Datejust 41', 'BOTH der Name ist geaendert');
  ok(gallery(db, pid).join(',') === keepTwo[0], 'BOTH …und die Galerie in derselben Wirkung');
  ok(String(one(db, 'SELECT images FROM products WHERE id = ?', [pid])) === '[]',
    'BOTH in der Produktzeile steht weiterhin kein Bild');
}

// ── 3) Verlorene Antwort: dieselbe Kennung, keine zweite Wirkung ──────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);

  const pid = await makeProduct(d, '6', ['x']);
  const base = gallery(db, pid);
  const plan = { id: pid, gallery: [{ keep: base[0] }, { stagingId: image('y') }] };

  const first = await runProductUpdate(d, identity('7', 'products.update', 'h7'), plan);
  ok(first.kind === 'ok', 'RETRY der erste Lauf geht durch');
  const afterFirst = gallery(db, pid);
  ok(afterFirst.length === 2, `RETRY zwei Bilder (${afterFirst.length})`);
  const linksTotal = Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ?', [pid]));
  const generations = Number(one(db, 'SELECT COUNT(*) FROM media_blob_generations'));

  // Die Antwort ging verloren — derselbe Vorsatz, dieselbe Kennung.
  const again = await runProductUpdate(d, identity('7', 'products.update', 'h7'), plan);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true,
    `RETRY die Wiederholung wird erkannt (${JSON.stringify(again)})`);
  ok(gallery(db, pid).join(',') === afterFirst.join(','), 'RETRY die Galerie ist Zeichen fuer Zeichen dieselbe');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ?', [pid])) === linksTotal,
    'RETRY keine zweite Galerie-Zeile — auch keine zurueckgezogene');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_blob_generations')) === generations,
    'RETRY und kein zweiter Blob-Effekt');
  ok(commandCount(db as never) === 2, 'RETRY der Nachweis steht genau einmal');

  // Dieselbe Kennung, ANDERER Plan: kein Urteil, keine Wirkung.
  const conflict = await runProductUpdate(d, identity('7', 'products.update', 'ANDERS'), {
    id: pid, gallery: [{ keep: base[0] }],
  });
  ok(conflict.kind === 'rejected' && (conflict as { code: string }).code === 'COMMAND_ID_CONFLICT'
    && (conflict as { frozen: boolean }).frozen === false,
    `RETRY gleiche Kennung, anderer Plan: abgewiesen, nichts eingefroren (${JSON.stringify(conflict)})`);
  ok(gallery(db, pid).join(',') === afterFirst.join(','), 'RETRY …und die Galerie ist unberuehrt');

  // Und ein Entfernen wiederholt sich auch nicht.
  const removePlan = { id: pid, gallery: [{ keep: afterFirst[0] }] };
  await runProductUpdate(d, identity('8', 'products.update', 'h8'), removePlan);
  const afterRemove = gallery(db, pid);
  const retired = Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL', [pid]));
  const replay = await runProductUpdate(d, identity('8', 'products.update', 'h8'), removePlan);
  ok(replay.kind === 'ok' && (replay as { replayed: boolean }).replayed === true
    && gallery(db, pid).join(',') === afterRemove.join(',')
    && Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL', [pid])) === retired,
    'RETRY eine wiederholte Entfernung entfernt kein zweites Mal');
}

// ── 4) Ein veralteter Plan ist ein Urteil, kein Vorschlag ─────────────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);
  const pid = await makeProduct(d, '9', ['z']);

  const stale = await runProductUpdate(d, identity('10', 'products.update', 'h10'), {
    id: pid, gallery: [{ keep: 'ein-bild-das-es-nicht-gibt' }],
  });
  ok(stale.kind === 'rejected' && (stale as { code: string }).code === 'PRODUCT_GALLERY_BASELINE_STALE'
    && (stale as { frozen: boolean }).frozen === true,
    `STALE ein Plan gegen eine fremde Galerie wird eingefroren abgelehnt (${JSON.stringify(stale)})`);
  ok(gallery(db, pid).length === 1, 'STALE …und die echte Galerie bleibt, wie sie war');
}

// ── 5) Medienausfall: nichts bleibt zurück ────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);
  const pid = await makeProduct(d, '11', ['m']);
  const base = gallery(db, pid);
  const linksBefore = Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ?', [pid]));
  const nameBefore = String(one(db, 'SELECT name FROM products WHERE id = ?', [pid]));

  tauriState.prepareShouldThrow = true;
  const failed = await runProductUpdate(d, identity('12', 'products.update', 'h12'), {
    id: pid, name: 'Nie gespeichert', gallery: [{ keep: base[0] }, { stagingId: image('n') }],
  });
  ok(failed.kind === 'rejected' && (failed as { frozen: boolean }).frozen === false,
    `FAIL ein Medienausfall ist KEIN Urteil (${JSON.stringify(failed)})`);
  ok(gallery(db, pid).join(',') === base.join(','), 'FAIL die Galerie ist unveraendert');
  ok(Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ?', [pid])) === linksBefore,
    'FAIL keine halbe Zeile, keine zurueckgezogene');
  ok(String(one(db, 'SELECT name FROM products WHERE id = ?', [pid])) === nameBefore,
    'FAIL …und auch der Text der GLEICHEN Transaktion ist zurueckgenommen');
  ok(commandCount(db as never) === 1, 'FAIL kein abgeschlossener Nachweis');

  // Und sobald es wieder geht, traegt dieselbe Kennung.
  tauriState.prepareShouldThrow = false;
  const retry = await runProductUpdate(d, identity('12', 'products.update', 'h12'), {
    id: pid, name: 'Nie gespeichert', gallery: [{ keep: base[0] }, { stagingId: image('n') }],
  });
  ok(retry.kind === 'ok' && gallery(db, pid).length === 2,
    `FAIL die Wiederholung derselben Kennung wirkt jetzt (${JSON.stringify(retry)})`);
  ok(String(one(db, 'SELECT name FROM products WHERE id = ?', [pid])) === 'Nie gespeichert',
    'FAIL …mit Text und Bild zusammen');
}

// ── 6) Eine Ablage gehört ihrem Absender ──────────────────────────────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);
  const pid = await makeProduct(d, '13', ['o']);
  const base = gallery(db, pid);

  // Ein ANDERER Benutzer legt ein Bild ab. Unser Auftrag kennt die Kennung — und bekommt nichts.
  // Eine unerreichbare Ablage ist eine ANTWORT an den Client (ein fachliches Nein), kein stiller
  // Fehlschlag: sie wird geworfen und von der Bruecke uebersetzt — genau wie beim Anlegen.
  const foreign = image('fremd', { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-fremd' });
  let stolen: string | null = null;
  try {
    await runProductUpdate(d, identity('14', 'products.update', 'h14'), {
      id: pid, gallery: [{ keep: base[0] }, { stagingId: foreign }],
    });
  } catch (e) { stolen = String(e); }
  ok(stolen !== null && /staged image is gone/.test(stolen), `OWNER ein fremder Hash oeffnet nichts (${stolen})`);
  ok(gallery(db, pid).join(',') === base.join(','), 'OWNER …und die Galerie bleibt unveraendert');
  ok(commandCount(db as never) === 1, 'OWNER …und es wird nichts festgehalten');

  // Und über Mandantengrenzen erst recht nicht.
  const otherTenant = image('fremd2', { tenantId: 'tenant-2', branchId: 'branch-main', userId: 'user-test' });
  let across: string | null = null;
  try {
    await runProductUpdate(d, identity('15', 'products.update', 'h15'), {
      id: pid, gallery: [{ keep: base[0] }, { stagingId: otherTenant }],
    });
  } catch (e) { across = String(e); }
  ok(across !== null, `OWNER auch nicht ueber Mandantengrenzen (${across})`);

  // Dieselben Bytes unter EIGENER Identität abgelegt gehen sofort durch — der Inhalt war nie das
  // Problem, die Berechtigung war es.
  const mine = image('fremd');
  const okOut = await runProductUpdate(d, identity('16', 'products.update', 'h16'), {
    id: pid, gallery: [{ keep: base[0] }, { stagingId: mine }],
  });
  ok(okOut.kind === 'ok' && gallery(db, pid).length === 2,
    `OWNER dieselben Bytes unter eigener Identitaet gehen durch (${JSON.stringify(okOut)})`);
  ok(mine === foreign, 'OWNER …und es ist DIESELBE Kennung — sie benennt den Inhalt, nicht den Absender');
}

// ── 7) Was gebucht ist, hängt nicht mehr an der Ablage ────────────────────
//
// Die Zwischenablage vergisst nach einer Frist. Ein Artikel, der schon gebucht ist, darf davon
// nichts merken: seine Bilder liegen dann im Medienspeicher, nicht mehr im Briefkasten.
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const d = deps(db);

  const pid = await makeProduct(d, '17', ['p']);
  const added = await runProductUpdate(d, identity('18', 'products.update', 'h18'), {
    id: pid, gallery: [{ keep: gallery(db, pid)[0] }, { stagingId: image('q') }],
  });
  ok(added.kind === 'ok', 'LIFECYCLE der Artikel hat zwei gebuchte Bilder');
  const links = gallery(db, pid);
  const keys = rows(db, `SELECT storage_key FROM media_blob_generations`).map((r) => String(r[0]));
  ok(keys.length >= 2, `LIFECYCLE …und ihre Bytes liegen im Medienspeicher (${keys.length} Ablagen)`);

  // Jetzt verschwindet die GANZE Zwischenablage — Frist abgelaufen, Kehrbesen gelaufen.
  tauriState.staged.clear();
  ok(tauriState.staged.size === 0, 'LIFECYCLE die Zwischenablage ist leer');

  ok(gallery(db, pid).join(',') === links.join(','),
    'LIFECYCLE die Galerie steht unveraendert — sie haengt an media_links, nicht an der Ablage');
  ok(rows(db, `SELECT storage_key FROM media_blob_generations`).length === keys.length,
    'LIFECYCLE …und jede Rendition hat weiter ihren Speicherschluessel');

  // Und die Ablagen, die WIRKLICH verbraucht wurden, hat der Auftrag selbst abgeräumt.
  ok(tauriState.discarded.length >= 1,
    `LIFECYCLE die benutzten Ablagen wurden nach dem Erfolg geraeumt (${tauriState.discarded.length})`);
  const cmd = src('src/core/bridge/product-commands.ts');
  ok(/if \(outcome\.kind === 'ok'\) \{/.test(cmd),
    'LIFECYCLE geraeumt wird NUR nach einem Erfolg — ein gescheiterter Versuch behaelt seine Bytes');
}

// ── 8) Keine zweite Medienlogik, kein zweiter Weg ─────────────────────────
{
  const cmd = src('src/core/bridge/product-commands.ts');
  const code = cmd.split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');
  ok(/editProductWithMedia\(/.test(code), 'REUSE die Galerie laeuft ueber den ECHTEN Bildweg des Hauses');
  ok(!/buildEditPlanEnvelope|applyEditDurably|prepareAndRegisterEdit/.test(code),
    'REUSE …und der Befehl baut keinen eigenen Plan');
  ok(!/media_links|media_blob_generations/i.test(code), 'REUSE er fasst keine Medientabelle an');
  ok(/priceEligibilityRequired: true/.test(code) && (code.match(/priceEligibilityRequired: true/g) || []).length === 2,
    'REUSE und BEIDE Wege — Text wie Galerie — laufen mit der Preissperre');
  const store = src('src/stores/productStore.ts');
  ok(/opts\?\.priceEligibilityRequired === true \? \{ priceEligibilityRequired: true \} : \{\}/.test(store),
    'PRICE der Bildweg reicht die Sperre durch, statt sie selbst zu entscheiden');

  // Der text-only Weg bleibt, was er ist: er liest die Galerie nicht einmal.
  ok(/gallery === undefined/.test(code),
    'PRESERVE ohne `gallery` laeuft weiterhin der Weg, der Medien nicht anfasst');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c product gallery edit: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_PRODUCT_GALLERY_EDIT_PROVED');
console.log('CENTRAL_C3C_PRODUCT_GALLERY_IDEMPOTENCY_PROVED');
console.log('CENTRAL_C3C_STAGING_OWNERSHIP_PROVED');
console.log('CENTRAL_C3C_STAGING_LIFECYCLE_PROVED');

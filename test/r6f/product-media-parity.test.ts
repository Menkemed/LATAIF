// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — die Bilder eines Artikels ändern (ProductDetail): am Primary
// `editProductWithMedia`, auf PC2 DIESELBE Absicht über die vorhandene Buchung `products.update` mit
// `gallery` — die am Primary genau `editProductWithMedia` fährt. Keine neue Auskunft: die
// Medienkennungen kennt PC2 aus `products.get` (`mediaIds`, über `useProductMediaPresentation`).
// Run: node test/r6f/product-media-parity.test.ts
//
//   §1 Primary == PC2   §2 verlorene Antwort   §3 veraltete Galerie   §4 Fehlerinjektion
//   §5 Negative (fremde/erfundene Medien, fremde Ablage, fremde Filiale, Rumpf)   §6 Plan-Bau
//   §7 Client   §8 Oberfläche
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
const { tauriState, stageForTest } = await import('../bridge/_tauri-shim.ts');
const { applyMediaSchema } = await import('../../src/core/db/media-schema.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, commandCount } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { runProductCreate, runProductUpdate, ProductPayloadError } = await import('../../src/core/bridge/product-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { planRemoteGallery, GalleryPlanError } = await import('../../src/core/products/gallery-plan.ts');
const { updatePayload, PRODUCT_UPDATE_FIELDS } = await import('../../src/core/data/write-payloads.ts');
const { stageDataUrls } = await import('../../src/core/bridge/client-staging-upload.ts');
const { runSharedWrite } = await import('../../src/core/data/shared-write.ts');
const { CommandSaveController } = await import('../../src/core/bridge/client-command-save.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const marker = (m: string): void => { if (fails.length === 0) console.log(m); };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);
const NOW = '2026-09-13T11:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const rows = (db: Db, sql: string, p: unknown[] = []): unknown[][] => db.exec(sql, p)[0]?.values ?? [];

function realMigrations(): string[] {
  const dbSrc = src('src/core/db/database.ts');
  const start = dbSrc.indexOf('const migrations: string[] = [');
  const end = dbSrc.indexOf('\n  ];', start);
  return [...dbSrc.slice(start, end).matchAll(/`([^`]*)`/g)].map((m) => m[1]);
}
const MIGRATIONS = realMigrations();

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(SKU_SEQUENCES_DDL);
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  applyMediaSchema(db as never);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-watch','branch-main','Watches','w','#000',?,?)", [NOW, NOW]);
  // Ein Artikel einer ANDEREN Filiale — von hier aus nicht vorhanden.
  db.run(`INSERT INTO products (id, branch_id, category_id, brand, name, sku, quantity, condition, scope_of_delivery,
      purchase_price, purchase_currency, stock_status, tax_scheme, days_in_stock, images, attributes, source_type, created_at, updated_at)
    VALUES ('p-foreign','branch-other','cat-watch','Rolex','Fremd','SKU-F',1,'','[]',100,'BHD','in_stock','MARGIN',0,'[]','{}','OWN',?,?)`, [NOW, NOW]);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useProductStore.getState().loadProducts();
  return db;
}

const PC2 = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-pc2' };
const ACTOR = { ...PC2, role: 'ADMIN' };
const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (x: string, op = 'products.update', hash = 'h' + x) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: hash });
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
function bytes(seed: string): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (seed.charCodeAt(i % seed.length) + i * 17) & 0xff;
  return b;
}
const dataUrl = (b: Uint8Array): string => 'data:image/jpeg;base64,' + Buffer.from(b).toString('base64');
const fromDataUrl = (u: string): Uint8Array => new Uint8Array(Buffer.from(u.slice(u.indexOf(',') + 1), 'base64'));
/** Was PC2 beim Ablegen bekommt: die Kennung IST der Inhalt, das Fach gehört dem Absender. */
const stageAs = (owner = PC2) => async (urls: readonly string[]): Promise<string[]> => urls.map((u) => stageForTest(fromDataUrl(u), owner));

const gallery = (db: Db, pid: string): string[] =>
  rows(db, 'SELECT media_id FROM media_links WHERE entity_id = ? AND deleted_at IS NULL ORDER BY sort_order', [pid]).map((r) => String(r[0]));
/** Die Galerie nach INHALT (Hash des Hauptblobs) — vergleichbar über zwei Datenbanken hinweg. */
const inhalt = (db: Db, pid: string): unknown[][] => rows(db, `
  SELECT l.sort_order, l.is_primary,
         (SELECT g.stored_blob_hash FROM media_blob_generations g
           WHERE g.tenant_id = o.tenant_id AND g.blob_id = o.master_blob_id ORDER BY g.generation_no DESC LIMIT 1)
    FROM media_links l JOIN media_objects o ON o.tenant_id = l.tenant_id AND o.media_id = l.media_id
   WHERE l.entity_id = ? AND l.deleted_at IS NULL ORDER BY l.sort_order`, [pid]);
const retired = (db: Db, pid: string): number => n(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NOT NULL', [pid]);

/** Ein Artikel mit zwei Bildern (a, b) — über den echten Anlageweg. */
async function artikel(db: Db, x: string, seeds = ['a', 'b']): Promise<string> {
  const out = await runProductCreate(deps(db) as never, identity(x, 'products.create'), {
    categoryId: 'cat-watch', brand: 'Rolex', name: 'Datejust', purchasePrice: 100,
    stagingIds: seeds.map((sd) => stageForTest(bytes(sd), PC2)),
  });
  if (out.kind !== 'ok') throw new Error('setup failed: ' + S(out));
  useProductStore.getState().loadProducts();
  return (out as { value: { productId: string } }).value.productId;
}
/** Was ProductDetail als Text mitgibt: das ganze Formular ohne `images`. */
function textPayloadOf(pid: string, patch: Record<string, unknown>): Record<string, unknown> {
  const p = useProductStore.getState().products.find((x) => x.id === pid) as unknown as Record<string, unknown>;
  const { images: _drop, ...rest } = { ...p, ...patch };
  void _drop;
  return rest;
}
const C = bytes('c-new');
const wirftAsync = async (fn: () => Promise<unknown>): Promise<{ code: string; message: string }> => {
  try { await fn(); return { code: '', message: '' }; } catch (e) {
    return { code: String((e as { code?: string }).code ?? ''), message: String((e as Error).message ?? e) };
  }
};

// ══ §1 — Primary == PC2: das erste Bild weg, das zweite nach vorn, ein neues dazu, Name geändert ═══
{
  // Primary: GENAU der Aufruf von ProductDetail (lokaler Anschluss der Weiche).
  const dbA = freshDb();
  const pA = await artikel(dbA, '1');
  const [a0, a1] = gallery(dbA, pA);
  const resA = await useProductStore.getState().editProductWithMedia(pA, textPayloadOf(pA, { name: 'Datejust 41' }) as never, {
    srcs: ['blob:a1', dataUrl(C)],
    resolved: [{ url: 'blob:a0', mediaId: a0 }, { url: 'blob:a1', mediaId: a1 }],
    status: 'media',
  });
  const wA = { inhalt: inhalt(dbA, pA), retired: retired(dbA, pA), name: one(dbA, 'SELECT name FROM products WHERE id = ?', [pA]), images: one(dbA, 'SELECT images FROM products WHERE id = ?', [pA]) };

  // PC2: dieselbe Absicht — der Plan aus dem angezeigten Entwurf, dann `products.update` mit `gallery`.
  const dbB = freshDb();
  const pB = await artikel(dbB, '1');
  const [b0, b1] = gallery(dbB, pB);
  const items = [{ url: 'blob:b0', mediaId: b0 }, { url: 'blob:b1', mediaId: b1 }];
  const plan = await planRemoteGallery(['blob:b1', dataUrl(C)], items, stageAs());
  const product = useProductStore.getState().products.find((x) => x.id === pB) as unknown as Record<string, unknown>;
  const body = { id: pB, ...updatePayload(product, textPayloadOf(pB, { name: 'Datejust 41' }), PRODUCT_UPDATE_FIELDS), gallery: plan };
  const sid = (plan[1] as { stagingId: string }).stagingId;
  const resB = await runProductUpdate(deps(dbB) as never, identity('2'), body);
  const wB = { inhalt: inhalt(dbB, pB), retired: retired(dbB, pB), name: one(dbB, 'SELECT name FROM products WHERE id = ?', [pB]), images: one(dbB, 'SELECT images FROM products WHERE id = ?', [pB]) };

  ok(resA.status === 'edited' && resB.kind === 'ok', `PARITY beide Wege gehen durch (${S(resA)} / ${S(resB).slice(0, 120)})`);
  ok(S(plan[0]) === S({ keep: b1 }) && /^[0-9a-f]{64}$/.test(sid) && S(Object.keys(body).sort()) === S(['gallery', 'id', 'name']),
    `PLAN behalten per Kennung, neu per Ablage; der Rumpf trägt nur Name + Galerie (${S(body).slice(0, 200)})`);
  ok(S(wA) === S(wB), `PARITY Galerie (Inhalt, Reihenfolge, Hauptbild), Rückzug, Text Zeichen für Zeichen gleich\n  A=${S(wA)}\n  B=${S(wB)}`);
  ok(wB.inhalt.length === 2 && Number(wB.inhalt[0][1]) === 1 && gallery(dbB, pB)[0] === b1 && !gallery(dbB, pB).includes(b0),
    'PARITY das frühere zweite Bild ist jetzt Hauptbild; das erste ist weg');
  ok(wB.retired === 1 && wB.name === 'Datejust 41' && wB.images === '[]',
    'PARITY das entfernte Bild ist zurückgezogen (Spur bleibt), der Name geändert, products.images bleibt leer');
  ok(!tauriState.staged.has(`${[...tauriState.staged.keys()].find((k) => k.endsWith(sid)) ?? '-'}`) && tauriState.discarded.includes(sid),
    'ABLAGE die benutzte Ablage ist nach dem Erfolg geräumt');

  // ══ §2 — verlorene Antwort ═════════════════════════════════════════════════
  const vorher = S([gallery(dbB, pB), n(dbB, 'SELECT COUNT(*) FROM media_links'), n(dbB, 'SELECT COUNT(*) FROM media_blob_generations'), commandCount(dbB as never)]);
  const again = await runProductUpdate(deps(dbB) as never, identity('2'), body);
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'RETRY dieselbe Kennung wird als Wiederholung erkannt');
  ok(S([gallery(dbB, pB), n(dbB, 'SELECT COUNT(*) FROM media_links'), n(dbB, 'SELECT COUNT(*) FROM media_blob_generations'), commandCount(dbB as never)]) === vorher,
    'RETRY kein zweites Bild, keine zweite Entfernung, kein zweiter Nachweis — und die geräumte Ablage wird nicht gebraucht');

  // ══ §3 — veraltete Galerie: ein Plan gegen einen überholten Stand ist ein Urteil ══
  const stale = await runProductUpdate(deps(dbB) as never, identity('3'), { id: pB, gallery: [{ keep: b0 }, { keep: b1 }] });
  ok(stale.kind === 'rejected' && (stale as { code: string }).code === 'PRODUCT_GALLERY_BASELINE_STALE' && (stale as { frozen: boolean }).frozen === true,
    `STALE ein zurückgezogenes Bild behalten wollen: eingefrorenes Nein (${S(stale)})`);
  ok(S([gallery(dbB, pB), n(dbB, 'SELECT COUNT(*) FROM media_links')]) === S([JSON.parse(vorher)[0], JSON.parse(vorher)[1]]),
    'STALE …die Galerie bleibt, wie sie war');
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_PARITY_PROVED');

// ══ §4 — Fehlerinjektion ═════════════════════════════════════════════════════
{
  // (a) Das Veröffentlichen des neuen Bildes scheitert — fern: kein Urteil, nichts bleibt, Ablage bleibt.
  {
    const db = freshDb();
    const pid = await artikel(db, '10');
    const base = gallery(db, pid);
    const links = n(db, 'SELECT COUNT(*) FROM media_links');
    const nachweise = commandCount(db as never);
    const plan = await planRemoteGallery(['blob:0', dataUrl(C)], [{ url: 'blob:0', mediaId: base[0] }, { url: 'blob:1', mediaId: base[1] }], stageAs());
    const body = { id: pid, name: 'Nie gespeichert', gallery: plan };
    tauriState.prepareShouldThrow = true;
    const failed = await runProductUpdate(deps(db) as never, identity('11'), body);
    tauriState.prepareShouldThrow = false;
    ok(failed.kind === 'rejected' && (failed as { frozen: boolean }).frozen === false,
      `FAIL-MEDIA ein Medienausfall ist kein Urteil (${S(failed)})`);
    ok(S(gallery(db, pid)) === S(base) && n(db, 'SELECT COUNT(*) FROM media_links') === links && retired(db, pid) === 0
      && one(db, 'SELECT name FROM products WHERE id = ?', [pid]) === 'Datejust' && commandCount(db as never) === nachweise,
    'FAIL-MEDIA Galerie, Text und Nachweis unverändert (eine Transaktion für beides)');
    const sid = (plan[1] as { stagingId: string }).stagingId;
    ok([...tauriState.staged.keys()].some((k) => k.endsWith('/' + sid)) && !tauriState.discarded.includes(sid),
      'FAIL-MEDIA die Ablage bleibt für die Wiederholung liegen');
    const retry = await runProductUpdate(deps(db) as never, identity('11'), body);
    ok(retry.kind === 'ok' && gallery(db, pid).length === 2 && gallery(db, pid)[0] === base[0] && retired(db, pid) === 1
      && one(db, 'SELECT name FROM products WHERE id = ?', [pid]) === 'Nie gespeichert',
    `FAIL-MEDIA dieselbe Kennung wirkt danach — Text und Bild zusammen (${S(retry).slice(0, 100)})`);
  }
  // (b) Am Primary: derselbe Ausfall im lokalen Anschluss — kein halber Stand.
  {
    const db = freshDb();
    const pid = await artikel(db, '12');
    const base = gallery(db, pid);
    tauriState.prepareShouldThrow = true;
    const res = await useProductStore.getState().editProductWithMedia(pid, textPayloadOf(pid, { name: 'Nie' }) as never, {
      srcs: ['blob:0', dataUrl(C)], resolved: [{ url: 'blob:0', mediaId: base[0] }, { url: 'blob:1', mediaId: base[1] }], status: 'media',
    });
    tauriState.prepareShouldThrow = false;
    ok(res.status !== 'edited' && S(gallery(db, pid)) === S(base) && one(db, 'SELECT name FROM products WHERE id = ?', [pid]) === 'Datejust',
      `FAIL-MEDIA am Primary: Galerie und Text unverändert (${S(res)})`);
  }
  // (c) Ein späterer Schreibschritt (die Textänderung am Artikel) scheitert — die Galerie geht mit zurück.
  {
    const db = freshDb();
    const pid = await artikel(db, '13');
    const base = gallery(db, pid);
    const nachweise = commandCount(db as never);
    const plan = await planRemoteGallery(['blob:1'], [{ url: 'blob:0', mediaId: base[0] }, { url: 'blob:1', mediaId: base[1] }], stageAs());
    db.run("CREATE TRIGGER r6f_name BEFORE UPDATE OF name ON products WHEN NEW.name = 'Bruch' BEGIN SELECT RAISE(ABORT, 'R6F: injected'); END");
    let geworfen = '';
    let out: unknown = null;
    try { out = await runProductUpdate(deps(db) as never, identity('14'), { id: pid, name: 'Bruch', gallery: plan }); } catch (e) { geworfen = String(e); }
    db.run('DROP TRIGGER r6f_name');
    ok(((out as { kind?: string } | null)?.kind === 'rejected' || geworfen !== '') && S(gallery(db, pid)) === S(base) && retired(db, pid) === 0
      && one(db, 'SELECT name FROM products WHERE id = ?', [pid]) === 'Datejust' && commandCount(db as never) === nachweise,
    `FAIL-TEXT scheitert der Text, bleibt auch die Galerie — kein halber Plan (${S(out).slice(0, 80)} ${geworfen.slice(0, 60)})`);
  }
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_ATOMICITY_PROVED');

// ══ §5 — Negative ═════════════════════════════════════════════════════════════
{
  const db = freshDb();
  const pid = await artikel(db, '20');
  const other = await artikel(db, '21', ['x']);
  const base = gallery(db, pid);
  const fremdesBild = gallery(db, other)[0];
  const stand = () => S([gallery(db, pid), gallery(db, other), n(db, 'SELECT COUNT(*) FROM media_links'), one(db, 'SELECT name FROM products WHERE id = ?', [pid])]);
  const vorher = stand();

  const foreignMedia = await runProductUpdate(deps(db) as never, identity('22'), { id: pid, gallery: [{ keep: base[0] }, { keep: fremdesBild }] });
  ok(foreignMedia.kind === 'rejected' && (foreignMedia as { code: string }).code === 'PRODUCT_GALLERY_BASELINE_STALE' && stand() === vorher,
    `NEIN das Bild eines ANDEREN Artikels behalten: abgewiesen, nichts geändert (${S(foreignMedia)})`);
  const invented = await runProductUpdate(deps(db) as never, identity('23'), { id: pid, gallery: [{ keep: 'erfunden' }] });
  ok(invented.kind === 'rejected' && (invented as { code: string }).code === 'PRODUCT_GALLERY_BASELINE_STALE' && stand() === vorher,
    'NEIN eine erfundene Medienkennung: abgewiesen');

  const fremdeAblage = stageForTest(bytes('fremd'), { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-fremd' });
  const r = await wirftAsync(() => runProductUpdate(deps(db) as never, identity('24'), { id: pid, gallery: [{ keep: base[0] }, { stagingId: fremdeAblage }] }));
  ok(/staged image is gone/.test(r.message) && stand() === vorher, `NEIN eine fremde Ablage öffnet nichts (${r.message.slice(0, 60)})`);

  const fremdArtikel = await runProductUpdate(deps(db) as never, identity('25'), { id: 'p-foreign', gallery: [] });
  ok(fremdArtikel.kind === 'rejected' && (fremdArtikel as { code: string }).code === 'PRODUCT_NOT_FOUND'
    && n(db, "SELECT COUNT(*) FROM products WHERE id = 'p-foreign' AND name = 'Fremd'") === 1,
  `NEIN ein Artikel einer anderen Filiale ist von hier aus nicht vorhanden (${S(fremdArtikel)})`);
  const fremdAusweis = await runProductUpdate(deps(db) as never, { ...identity('26'), branchId: 'branch-other' }, { id: pid, gallery: [{ keep: base[1] }] });
  ok(fremdAusweis.kind === 'rejected' && (fremdAusweis as { code: string }).code === 'BRANCH_MISMATCH' && stand() === vorher,
    `NEIN der Ausweis einer anderen Filiale ändert nichts (${S(fremdAusweis)})`);

  for (const [what, body] of [
    ['images als Feld', { id: pid, images: ['data:image/jpeg;base64,AAAA'] }],
    ['branchId', { id: pid, branchId: 'branch-other', gallery: [] }],
    ['createdBy', { id: pid, createdBy: 'boss', gallery: [] }],
    ['Ablage als Pfad', { id: pid, gallery: [{ stagingId: '../../etc/passwd' }] }],
    ['URL als Platz', { id: pid, gallery: [{ url: 'https://x/y.jpg' }] }],
    ['dasselbe Bild zweimal', { id: pid, gallery: [{ keep: base[0] }, { keep: base[0] }] }],
  ] as Array<[string, Record<string, unknown>]>) {
    let threw: unknown = null;
    try { await runProductUpdate(deps(db) as never, identity('27'), body); } catch (e) { threw = e; }
    ok(threw instanceof ProductPayloadError && stand() === vorher, `RUMPF ${what} wird abgewiesen (${String((threw as Error)?.message ?? threw).slice(0, 70)})`);
  }
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_AUTHORITY_PROVED');

// ══ §6 — Der Plan-Bau auf PC2 (rein, ohne Datenbank) ════════════════════════
{
  const items = [{ url: 'blob:1', mediaId: 'm1' }, { url: 'blob:2', mediaId: 'm2' }, { url: 'blob:x', mediaId: '' }];
  let gestaged = 0;
  const stage = async (urls: readonly string[]): Promise<string[]> => { gestaged += urls.length; return urls.map(() => 'e'.repeat(64)); };
  const reorder = await planRemoteGallery(['blob:2', 'blob:1'], items, stage);
  ok(S(reorder) === S([{ keep: 'm2' }, { keep: 'm1' }]) && gestaged === 0, 'PLAN umsortieren: nur Kennungen, nichts abgelegt');
  const remove = await planRemoteGallery(['blob:1'], items, stage);
  ok(S(remove) === S([{ keep: 'm1' }]), 'PLAN entfernen: das Weggelassene fehlt einfach (der Primary rechnet den Rückzug)');
  const add = await planRemoteGallery(['blob:1', dataUrl(C)], items, stage);
  ok(S(add) === S([{ keep: 'm1' }, { stagingId: 'e'.repeat(64) }]) && gestaged === 1, 'PLAN hinzufügen: das neue Foto geht in die Ablage');
  const leer = await planRemoteGallery([], items, stage);
  ok(S(leer) === S([]), 'PLAN alle Bilder weg: eine LEERE Liste ist eine Aussage');
  for (const [what, srcs, code] of [
    ['eine unbekannte Anzeige-URL', ['blob:gibt-es-nicht'], 'MEDIA_EDIT_UNKNOWN_IMAGE'],
    ['ein Bild ohne Medienkennung', ['blob:x'], 'MEDIA_EDIT_UNKNOWN_IMAGE'],
    ['eine fremde http-URL', ['https://evil/x.jpg'], 'MEDIA_EDIT_UNKNOWN_IMAGE'],
    ['dasselbe Bild zweimal', ['blob:1', 'blob:1'], 'MEDIA_EDIT_DUPLICATE_IMAGE'],
  ] as Array<[string, string[], string]>) {
    let threw: unknown = null;
    try { await planRemoteGallery(srcs, items, stage); } catch (e) { threw = e; }
    ok(threw instanceof GalleryPlanError && (threw as { code: string }).code === code, `PLAN ${what}: fail-closed (${(threw as { code?: string })?.code})`);
  }
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_PLAN_PROVED');

// ══ §7 — Client: keine lokale Datenbank; Ablage + EIN Auftrag ════════════════
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
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const netz = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/api/staging/media')) {
      return new Response(JSON.stringify({ stagingId: 'd'.repeat(64), mime: 'image/jpeg', bytes: 32, width: 1, height: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, value: { productId: 'p-pc2', replayed: false } }), { status: 200 });
  }) as unknown as typeof fetch;
  const origFetch = globalThis.fetch;
  globalThis.fetch = netz;
  try {
    const plan = await planRemoteGallery(['blob:2', dataUrl(C)], [{ url: 'blob:1', mediaId: 'm1' }, { url: 'blob:2', mediaId: 'm2' }],
      (urls) => stageDataUrls(urls, netz));
    const attempt = new CommandSaveController<Record<string, unknown>>('products.update').beginAttempt();
    const r = await runSharedWrite(true, {
      local: () => { throw new Error('lokal'); },
      remote: () => ({ id: 'p-pc2', gallery: plan }),
    }, attempt);
    const staging = calls.filter((c) => c.url.endsWith('/api/staging/media'));
    const command = calls.filter((c) => c.body.op === 'products.update');
    const payload = command[0]?.body.payload as Record<string, unknown> | undefined;
    ok(r.kind === 'ok' && staging.length === 1 && command.length === 1 && touched === 0,
      `CLIENT ein Foto in die Ablage, EIN Auftrag, keine lokale Datenbank (${staging.length}/${command.length}, Zugriffe ${touched})`);
    ok(S(payload) === S({ id: 'p-pc2', gallery: [{ keep: 'm2' }, { stagingId: 'd'.repeat(64) }] }) && !S(payload).includes('data:'),
      `CLIENT im Auftrag reisen Kennungen, nie Bytes (${S(payload)})`);
  } finally {
    globalThis.fetch = origFetch;
    store.delete('lataif_runtime_mode');
    store.delete('lataif_client_server_url');
    store.delete('lataif_client_token');
    setTestDatabase(db as never);
  }
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_CLIENT_PROVED');

// ══ §8 — Oberfläche: der Bildweg ist kein „nicht verfügbar" mehr — und bleibt fail-closed ═══
{
  const pd = codeOf(src('src/pages/watches/ProductDetail.tsx'));
  const save = pd.slice(pd.indexOf('async function handleSave'), pd.indexOf('function labelFor'));
  ok(!/nichtAmClient\(/.test(pd), 'UI der Bildweg meldet sich am Client nicht mehr als „not available"');
  ok(/planRemoteGallery\(form\.images \|\| \[\], media\.status === 'media' \? media\.items : \[\], stageDataUrls\)/.test(save),
    'UI PC2 baut die Plätze aus dem angezeigten Entwurf (media.items aus products.get) und legt neue Fotos ab');
  ok(/local: async \(\) => await editProductWithMedia\(id, textPayload, \{ srcs: form\.images \|\| \[\], resolved, status \}\)/.test(save)
    && /remote: \(\) => \(\{ id, \.\.\.textDiff, gallery \}\)/.test(save),
  'UI EINE Weiche: am Primary editProductWithMedia, auf PC2 products.update mit gallery');
  const guard = save.indexOf('if (!draftSeeded) {');
  ok(guard > 0 && guard < save.indexOf('planRemoteGallery(') && guard < save.indexOf('presentationToResolverStatus('),
    'UI der Riegel „Galerie noch nicht geladen" steht VOR jedem Plan und jeder Ablage — auf beiden Rechnern');
  ok(/if \(r\.kind !== 'ok'\) \{[\s\S]{0,300}PRODUCT_CUTOVER_RELOAD[\s\S]{0,200}fehlertext\(r\)/.test(save),
    'UI ein offener/abgewiesener Ausgang bleibt offen und sagt warum; ein Altbestand-Umzug lädt die Galerie neu');
  ok(/data-product-images=/.test(pd) && /data-save-product/.test(pd), 'UI data-product-images, data-save-product');
  const cmdSrc = codeOf(src('src/core/bridge/product-commands.ts'));
  const upd = cmdSrc.slice(cmdSrc.indexOf('export async function runProductUpdate'), cmdSrc.indexOf('// ── Die Anmeldung'));
  ok(/assertHouseBranch\(identity\);/.test(upd) && /SELECT id FROM products WHERE id = \? AND branch_id = \?', \[id, identity\.branchId\]/.test(upd),
    'BRIDGE products.update: Filiale des Ausweises = die dieses Rechners, und der Artikel muss in ihr liegen');
  const plan = codeOf(src('src/core/products/gallery-plan.ts'));
  ok(!/remoteRead|registerCommand|fetch\(|getDatabase|query\(/.test(plan), 'READ keine neue Auskunft, keine Datenbank — nur der Plan aus dem Gesehenen');
  ok(/mediaIds: gal\.map\(\(g\) => g\.mediaId\)/.test(src('src/core/bridge/read-commands.ts'))
    && /mediaId: ids\[i\] \?\? ''/.test(src('src/core/media/client-media-source.ts')),
  'READ die Medienkennungen kommen aus dem vorhandenen products.get');
}
marker('CENTRAL_UI_R6F_PRODUCT_MEDIA_UI_PROVED');

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — R6F product media parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R6F_PRODUCT_MEDIA_PROVED');

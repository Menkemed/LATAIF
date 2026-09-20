// ════════════════════════════════════════════════════════════════════════════
// MEDIA-INBOX — der Einkaufs-Posteingang des Telefons im Medienkern.
// Run: node test/media-business/purchase-inbox.test.ts
//
//   §1 Hochladen am Telefon: EIN Eintrag, EIN Medium, nirgends Bytes in einer Zeile
//   §2 Derselbe Auftrag noch einmal: dieselbe Antwort, kein zweiter Eintrag
//   §3 Unterbrechung zwischen Ablage, Aufnahme und Auftrag
//   §4 Fehlende oder falsche Ablage: nichts entsteht, und die Absage bleibt dieselbe
//   §5 Der Rumpf: keine Bytes, keine fremden Felder, eine Obergrenze
//   §6 Scheitert die Geschäftsfolge, bleibt keine halbe Verknüpfung
//   §7 Altbestand: lesbar, und er kommt nach der Übernahme nicht zurück
//   §8 Besitzerwechsel: DASSELBE Medium wird Artikelbild, der Posteingang gibt es ab
//   §9 Fremde Filiale bekommt nichts — hier wie auf der LAN-Route
//   §10 Verdrahtung: Registry, Recht, Rust, Telefon, und Auftrag/Altgold unberührt
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
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const store = new Map<string, string>([['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })]]);
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
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX, lookupCommand } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const { installWriteGuard } = await import('../../src/core/db/write-guard.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { applyMediaSchema, MEDIA_ENTITY_SCOPE } = await import('../../src/core/db/media-schema.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { useCustomerStore } = await import('../../src/stores/customerStore.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');
const { useSupplierStore } = await import('../../src/stores/supplierStore.ts');
const { useScrapTradeStore } = await import('../../src/stores/scrapTradeStore.ts');
const orderHouse = await import('../../src/core/orders/order-house.ts');
const orderMedia = await import('../../src/core/orders/order-media.ts');
const scrapMedia = await import('../../src/core/metals/scrap-media.ts');
const metalActions = await import('../../src/core/metals/metal-actions.ts');
const metalCmd = await import('../../src/core/bridge/metal-commands.ts');
const commercial = await import('../../src/core/bridge/commercial-commands.ts');
const inboxMedia = await import('../../src/core/purchases/inbox-media.ts');
const lifecycleHouse = await import('../../src/core/purchases/purchase-lifecycle-house.ts');
const lifecycleCmd = await import('../../src/core/bridge/purchase-lifecycle-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
const perms = await import('../../src/core/bridge/command-permissions.ts');
const pageReads = await import('../../src/core/data/page-reads.ts');
const { usePurchaseStore } = await import('../../src/stores/purchaseStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const NOW = '2026-09-20T10:00:00.000Z';

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);
const s = (db: Db, sql: string, p: unknown[] = []): string => String(one(db, sql, p) ?? '');
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

function freshDb(): Db {
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  const db = new SQL.Database() as unknown as Db;
  db.run(src('src/core/db/schema.sql'));
  for (const stmt of MIGRATIONS) { try { db.run(stmt); } catch { /* schon da */ } }
  for (const stmt of A1_UPGRADE_SQL) { try { db.run(stmt); } catch { /* schon da */ } }
  db.run(COMMAND_LEDGER_DDL); db.run(COMMAND_LEDGER_INDEX); db.run(SKU_SEQUENCES_DDL);
  for (const [id, name] of [['branch-main', 'Haupt'], ['branch-other', 'Andere']]) {
    db.run('INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', [id, 'tenant-1', name, NOW, NOW]);
  }
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-w','branch-main','Uhren','w','#000',?,?)", [NOW, NOW]);
  db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level, preferences, customer_type, sales_stage, created_at, updated_at)
    VALUES ('cust-1','branch-main','Ali','H','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  db.run("INSERT INTO suppliers (id, branch_id, name, active, created_at, updated_at) VALUES ('sup-1','branch-main','L',1,?,?)", [NOW, NOW]);
  applyMediaSchema(db as never);
  setTestDatabase(db as never);
  installWriteGuard(db as never);
  useCustomerStore.getState().loadCustomers();
  useProductStore.getState().loadProducts();
  useSupplierStore.getState().loadSuppliers();
  tauriState.reset();
  return db;
}

const ID = (x: string): string => `${x.padStart(8, '0')}-0000-4000-8000-000000000000`;
const ACTOR = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN' };
const OWNER = { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' };
const identity = (x: string, op: string) => ({ commandId: ID(x), ...ACTOR, op, payloadHash: 'h' + x });
const deps = (db: Db) => ({
  db: db as never, begin: posting.beginLedgerTransaction, commit: posting.commitLedgerTransaction,
  rollback: posting.rollbackLedgerTransaction, durableSave: async () => {}, now: () => NOW,
});
const bild = (seed: number): Uint8Array => Uint8Array.from({ length: 64 }, (_, i) => (seed * 53 + i * 3) & 0xff);
const url = (b: Uint8Array): string => `data:image/jpeg;base64,${Buffer.from(b).toString('base64')}`;
const ablegen = (b: Uint8Array): string => stageForTest(b, OWNER);

const linksOf = (db: Db, type: string, id: string, role?: string): string[] =>
  (db.exec(
    `SELECT media_id FROM media_links WHERE entity_type = ? AND entity_id = ?${role ? ' AND media_role = ?' : ''} AND deleted_at IS NULL ORDER BY sort_order`,
    role ? [type, id, role] : [type, id],
  )[0]?.values ?? []).map((v) => String(v[0]));
const objekte = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_objects');
const dateien = (db: Db): number => n(db, 'SELECT COUNT(*) FROM media_blob_generations');
/** Ein geworfenes Nein ist auch ein Ausgang — hier wird es einer, statt den Lauf zu beenden. */
async function fern(fn: () => Promise<{ kind: string; code?: string }>): Promise<{ kind: string; code: string }> {
  try { const o = await fn(); return { kind: o.kind, code: String(o.code ?? '') }; }
  catch (e) { return { kind: 'thrown', code: String((e as { code?: unknown }).code ?? (e as Error).message) }; }
}

const INBOX = (stagingIds: string[], note?: string): Record<string, unknown> => {
  const body: Record<string, unknown> = { photos: stagingIds.map((id) => ({ stagingId: id })) };
  if (note) body.note = note;
  return body;
};
const inboxRows = (db: Db): Array<Record<string, unknown>> =>
  rows(db, 'SELECT id, branch_id, images, note, status FROM purchase_inbox ORDER BY created_at, id');
const J = (v: unknown): string => JSON.stringify(v ?? null);

// ── §1 Hochladen am Telefon ─────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(1));
  const out = await lifecycleCmd.runInboxCreate(deps(db), identity('101', 'purchase_inbox.create'), INBOX([st], 'Ring vom Kunden'));
  ok(out.kind === 'ok', `§1 das Telefon legt einen Posteingangs-Eintrag an (${out.kind} ${(out as { code?: string }).code ?? ''})`);
  const liste = inboxRows(db);
  ok(liste.length === 1, `§1 GENAU ein Eintrag entsteht (${liste.length})`);
  const id = String(liste[0]?.id ?? '');
  ok(String(liste[0]?.branch_id) === 'branch-main' && String(liste[0]?.status) === 'pending'
    && String(liste[0]?.note) === 'Ring vom Kunden',
    '§1 …in der Filiale des geprüften Absenders, offen, mit seiner Notiz');
  ok(String(liste[0]?.images) === '[]', `§1 …und die alte Bildspalte bleibt leer (${String(liste[0]?.images)})`);
  ok(linksOf(db, 'purchase_inbox', id, 'intake_photo').length === 1,
    '§1 das Foto hängt als Verknüpfung am Eintrag, nicht in seiner Zeile');
  ok(n(db, "SELECT COUNT(*) FROM media_objects WHERE security_class = 'internal'") === 1,
    '§1 …als Medium der Klasse `internal` — kein Ausweis, keine zusätzliche Verschlüsselung');
  ok(n(db, "SELECT COUNT(*) FROM purchase_inbox WHERE images LIKE '%data:%'") === 0,
    '§1 nirgends eine Daten-URL in der Zeile');
  ok(n(db, "SELECT COUNT(*) FROM sync_changelog WHERE table_name = 'purchase_inbox' AND data LIKE '%data:%'") === 0,
    '§1 …und auch der Abgleich trägt keine Bytes mehr');
  // Was der Abgleich BEKOMMT, steht an genau einer Stelle: die Zeile, mit leerer Bildliste.
  const haus = codeOf(src('src/core/purchases/purchase-lifecycle-house.ts'));
  const anlegen = haus.slice(haus.indexOf('export function createPurchaseInboxInHouse'));
  ok(/trackChange\('purchase_inbox', inboxId, 'insert', \{[\s\S]*?images: '\[\]'/.test(anlegen),
    '§1 die Zeile reist ganz normal über den Abgleich — mit leerer Bildliste, nie mit Bytes');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'purchase_inbox'") === 1,
    '§1 …und der Vorgang steht im Protokoll');
  const refs = inboxMedia.inboxPhotoRefs(id);
  ok(refs.length === 1 && refs[0].main.storageKey.endsWith('.jpg') && refs[0].main.hash.length > 0,
    '§1 die Auskunft nennt Referenzen (Schlüssel, Hash, Fassung) — keine Bytes');
  ok(refs[0]?.securityClass === 'internal', '§1 …mit der Klasse, unter der es gespeichert wurde');
}

// ── §2 Derselbe Auftrag noch einmal ─────────────────────────────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(2));
  const a = await lifecycleCmd.runInboxCreate(deps(db), identity('201', 'purchase_inbox.create'), INBOX([st]));
  const b = await lifecycleCmd.runInboxCreate(deps(db), identity('201', 'purchase_inbox.create'), INBOX([st]));
  ok(a.kind === 'ok' && b.kind === 'ok', `§2 beide Versuche werden beantwortet (${a.kind}/${b.kind})`);
  ok(J((a as { value?: unknown }).value) === J((b as { value?: unknown }).value),
    '§2 …mit DERSELBEN Antwort: der Primary gibt sein eingefrorenes Ergebnis zurück');
  ok(inboxRows(db).length === 1, `§2 und es gibt genau einen Eintrag, keinen zweiten (${inboxRows(db).length})`);
  ok(n(db, 'SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL') === 1,
    '§2 …auch nur eine Verknüpfung');
}

// ── §3 Unterbrechung zwischen Ablage, Aufnahme und Auftrag ──────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(3));
  // Abbruch NACH der Ablage, VOR dem Auftrag: nichts ist entstanden.
  ok(inboxRows(db).length === 0 && objekte(db) === 0, '§3 nach der Ablage allein gibt es weder Eintrag noch Medium');
  // Der zweite Anlauf — dieselbe Ablage: der Eintrag entsteht jetzt.
  const out = await lifecycleCmd.runInboxCreate(deps(db), identity('301', 'purchase_inbox.create'), INBOX([st]));
  ok(out.kind === 'ok' && inboxRows(db).length === 1, `§3 der spätere Versuch legt ihn an (${out.kind})`);

  // Abbruch NACH der Aufnahme, VOR dem Auftrag: das Objekt liegt unverknüpft da (GC-Vertrag) …
  const db2 = freshDb();
  const verwaist = await inboxMedia.ingestInboxPhotos([url(bild(4))]);
  ok(verwaist.length === 1 && inboxRows(db2).length === 0
    && n(db2, 'SELECT COUNT(*) FROM media_links WHERE deleted_at IS NULL') === 0,
    '§3 eine Aufnahme ohne Auftrag hinterlässt ein unverknüpftes Objekt und KEINEN Eintrag');
  // … und dieselben Bytes ein zweites Mal aufnehmen legt keine zweite DATEI an.

}

// ── §4 Fehlende oder falsche Ablage ─────────────────────────────────────────────────────────
{
  const db = freshDb();
  const fehlt = 'a'.repeat(64);
  const weg = { readStaged: async (): Promise<never> => { throw new Error('missing'); } };
  const a = await fern(() => lifecycleCmd.runInboxCreate(deps(db), identity('401', 'purchase_inbox.create'), INBOX([fehlt]), weg));
  ok(a.kind === 'thrown' && a.code === 'STAGED_IMAGE_GONE',
    `§4 eine Ablage, die es nicht gibt, ist ein benanntes Nein (${a.kind} ${a.code ?? ''})`);
  ok(inboxRows(db).length === 0 && objekte(db) === 0 && n(db, 'SELECT COUNT(*) FROM media_links') === 0,
    '§4 …kein Eintrag, kein Medium, keine Verknüpfung');
  ok(lookupCommand(db as never, identity('401', 'purchase_inbox.create')).kind === 'fresh',
    '§4 …und die Auftragskennung ist NICHT verbrannt: das Telefon darf denselben Auftrag erneut schicken');
  // Genau das tut es — mit derselben Kennung, sobald die Bytes wieder da sind.
  const st = ablegen(bild(6));
  const b = await lifecycleCmd.runInboxCreate(deps(db), identity('401', 'purchase_inbox.create'), INBOX([st]));
  ok(b.kind === 'ok' && inboxRows(db).length === 1,
    `§4 der spätere Versuch legt GENAU EINEN Eintrag an (${b.kind}, ${inboxRows(db).length})`);
}

// ── §5 Der Rumpf ────────────────────────────────────────────────────────────────────────────
{
  const bytes = url(bild(5));
  const wirft = (raw: unknown): string => {
    try { lifecycleCmd.parseInboxCreate(raw); return ''; } catch (e) { return (e as Error).message; }
  };
  ok(wirft({ images: [bytes], photos: [{ stagingId: 'b'.repeat(64) }] }).includes('never inside the order'),
    '§5 Bytes im Rumpf werden ausdrücklich abgewiesen — mit dem Grund');
  ok(wirft({ image: bytes }) !== '', '§5 auch einzeln nicht');
  ok(wirft({ photos: [] }) !== '', '§5 ein Posteingang OHNE Foto ist kein Posteingang');
  ok(wirft({ photos: [{ stagingId: 'c'.repeat(64) }, { stagingId: 'd'.repeat(64) }, { stagingId: 'e'.repeat(64) }, { stagingId: 'f'.repeat(64) }] }) !== '',
    `§5 höchstens ${lifecycleCmd.INBOX_MAX_PHOTOS} Aufnahmen`);
  ok(wirft({ photos: [{ stagingId: 'nicht-lang-genug' }] }) !== '', '§5 eine Ablagekennung ist ein Inhaltshash, kein beliebiges Wort');
  ok(wirft({ photos: [{ stagingId: '0'.repeat(64) }], branchId: 'branch-other' }).includes('the primary decides'),
    '§5 die Filiale bestimmt der Primary, nicht der Rumpf');
  ok(wirft({ photos: [{ stagingId: '1'.repeat(64) }], status: 'done' }).includes('the primary decides'),
    '§5 und den Status auch');
  ok(wirft({ photos: [{ stagingId: '2'.repeat(64) }], note: 'Karton dabei' }) === '', '§5 eine Notiz darf mit');
}

// ── §6 Scheitert die Geschäftsfolge ─────────────────────────────────────────────────────────
{
  const db = freshDb();
  // Ein Medium, das es nicht (mehr) gibt: die Klammer nimmt den halb geschriebenen Eintrag zurück.
  // Genau dieselbe Klammer, die der Befehl aufspannt — deshalb hier von Hand, nicht im Kopf.
  let fehler = '';
  posting.beginLedgerTransaction();
  try {
    lifecycleHouse.createPurchaseInboxInHouse({ mediaIds: ['med-gibt-es-nicht'] }, 'branch-main', NOW);
    posting.commitLedgerTransaction();
  } catch (e) {
    posting.rollbackLedgerTransaction();
    fehler = String((e as { code?: string }).code ?? (e as Error).message);
  }
  ok(fehler !== '', `§6 ein unbekanntes Medium lässt die Folge scheitern (${fehler})`);
  ok(inboxRows(db).length === 0, '§6 …und es bleibt KEIN halber Eintrag stehen');
  ok(n(db, 'SELECT COUNT(*) FROM media_links') === 0, '§6 …und keine halbe Verknüpfung');
  ok(n(db, "SELECT COUNT(*) FROM audit_log WHERE entity_type = 'purchase_inbox'") === 0,
    '§6 …und nichts im Protokoll, was nie geschehen ist');
  // Ohne Foto entsteht gar kein Eintrag — das ist der Vertrag, nicht ein Zufall.
  let ohne = '';
  posting.beginLedgerTransaction();
  try { lifecycleHouse.createPurchaseInboxInHouse({ mediaIds: [] }, 'branch-main', NOW); posting.commitLedgerTransaction(); }
  catch (e) { posting.rollbackLedgerTransaction(); ohne = String((e as { code?: string }).code ?? ''); }
  ok(ohne === 'INBOX_PHOTO_REQUIRED', `§6 ein Eintrag OHNE Foto wird benannt abgewiesen (${ohne})`);
}

// ── §7 Altbestand ───────────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const alt = url(bild(7));
  db.run(`INSERT INTO purchase_inbox (id, branch_id, images, note, status, created_at, created_by)
          VALUES ('inbox-alt', 'branch-main', ?, 'von einem aelteren Telefon', 'pending', ?, 'user-test')`,
    [JSON.stringify([alt]), NOW]);
  ok(inboxMedia.legacyInboxImages('inbox-alt')[0] === alt,
    '§7 ein Eintrag von früher bleibt lesbar — seine Bytes stehen weiter in seiner Zeile');
  ok(inboxMedia.inboxPhotoRefs('inbox-alt').length === 0,
    '§7 …er hat kein Medium, und es wird auch keins erfunden');
  const vorschau = pageReads.purchaseCreatePrefillFor(
    { tenantId: 'tenant-1', branchId: 'branch-main' } as never, { inboxId: 'inbox-alt' });
  ok(vorschau.inbox !== null && vorschau.inbox.images.length === 1 && vorschau.inbox.mediaIds.length === 0,
    '§7 die Einkaufsmaske sieht ihn genau so, wie er ist');

  // Bekommt derselbe Eintrag ein Medium, wird die alte Liste in DERSELBEN Klammer geleert …
  const mediaId = (await inboxMedia.ingestInboxPhotos([url(bild(8))], undefined, 'inbox-alt'))[0];
  inboxMedia.applyInboxGallery('inbox-alt', [mediaId]);
  ok(s(db, "SELECT images FROM purchase_inbox WHERE id = 'inbox-alt'") === '[]',
    '§7 …dann ist die alte Liste leer');
  ok(inboxMedia.legacyInboxImages('inbox-alt').length === 0 && inboxMedia.inboxPhotoRefs('inbox-alt').length === 1,
    '§7 …und das Foto kommt genau einmal vor, nicht zweimal');
  // … und ein erneuter Lauf bringt sie nicht zurück.
  inboxMedia.applyInboxGallery('inbox-alt', [mediaId]);
  ok(s(db, "SELECT images FROM purchase_inbox WHERE id = 'inbox-alt'") === '[]',
    '§7 ein bewusst entferntes Bild wird nicht wiederbelebt');
}

// ── §8 Besitzerwechsel ──────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(9));
  await lifecycleCmd.runInboxCreate(deps(db), identity('801', 'purchase_inbox.create'), INBOX([st]));
  const inboxId = String(inboxRows(db)[0]?.id ?? '');
  const medium = linksOf(db, 'purchase_inbox', inboxId, 'intake_photo')[0];
  const objVorher = objekte(db); const dateiVorher = dateien(db);

  const p = useProductStore.getState().createProduct({ categoryId: 'cat-w', brand: 'X', name: 'Y', images: [] } as never);
  ok(linksOf(db, 'product', p.id, 'stock_image').length === 0,
    '§8 solange das Foto im Posteingang hängt, ist es KEIN Artikelbild — der Artikel hat keins');

  const r = inboxMedia.adoptInboxPhotosToProduct(inboxId, p.id);
  ok(r.linked === 1 && linksOf(db, 'product', p.id, 'stock_image')[0] === medium,
    '§8 beim Übernehmen bekommt der Artikel DASSELBE Medium als `stock_image`');
  ok(objekte(db) === objVorher && dateien(db) === dateiVorher,
    `§8 …kein zweites Objekt, keine zweite Datei, kein erneutes Codieren (${objekte(db)}/${dateien(db)})`);
  ok(linksOf(db, 'purchase_inbox', inboxId, 'intake_photo').length === 0,
    '§8 …und der Posteingang gibt es ab: ein Foto ist nicht an zwei Orten das aktuelle');
  ok(n(db, "SELECT COUNT(*) FROM media_links WHERE entity_type = 'purchase_inbox' AND deleted_at IS NOT NULL") === 1,
    '§8 die alte Verknüpfung wird STILLGELEGT, nicht gelöscht — der Weg bleibt nachvollziehbar');
  ok(s(db, 'SELECT security_class FROM media_objects WHERE media_id = ?', [medium]) === 'internal',
    '§8 …die Klasse bleibt dieselbe: kein stiller Wechsel beim Besitzerwechsel');
  ok(n(db, 'SELECT COUNT(*) FROM purchase_inbox WHERE id = ?', [inboxId]) === 1,
    '§8 der Eintrag selbst bleibt als Nachweis stehen');

  // Ein zweiter Lauf hängt nichts doppelt an.
  const r2 = inboxMedia.adoptInboxPhotosToProduct(inboxId, p.id);
  ok(r2.linked === 0 && linksOf(db, 'product', p.id, 'stock_image').length === 1,
    '§8 zweimal übernehmen ändert nichts — der Artikel hat weiterhin genau ein Bild');

  // Und der Einkauf tut beides in einem: Foto übernehmen UND den Eintrag abhaken.
  const haus = codeOf(src('src/core/purchases/purchase-house.ts'));
  ok(/adoptInboxPhotosToProduct\(input\.inboxId, productId\)/.test(haus)
    && /markPurchaseInboxDone\(input\.inboxId\)/.test(haus),
    '§8 „Save Purchase" übernimmt das Foto an den neu entstandenen Artikel und hakt den Eintrag ab');
}

// ── §9 Fremde Filiale ───────────────────────────────────────────────────────────────────────
{
  const db = freshDb();
  const st = ablegen(bild(10));
  await lifecycleCmd.runInboxCreate(deps(db), identity('901', 'purchase_inbox.create'), INBOX([st]));
  const inboxId = String(inboxRows(db)[0]?.id ?? '');
  ok((inboxMedia.inboxPhotoRefsFor([inboxId], 'branch-other').get(inboxId) ?? []).length === 0,
    '§9 eine andere Filiale bekommt das Foto dieses Eintrags nicht');
  ok((inboxMedia.inboxPhotoRefsFor([inboxId], 'branch-main').get(inboxId) ?? []).length === 1,
    '§9 …seine eigene schon');
  const grant = src('src-tauri/src/sync/product_query.rs');
  ok(grant.includes("l.entity_type = 'purchase_inbox' AND l.media_role = 'intake_photo'")
    && grant.includes('pi.id = l.entity_id AND pi.branch_id = l.branch_id'),
    '§9 das Tor der LAN-Route hat für den Posteingang eine EIGENE Regel (Tabelle, Rolle, Filiale)');
  ok(/security_class IN \('public', 'internal'\)\s*\n\s*AND l\.entity_type = 'purchase_inbox'/.test(grant),
    '§9 …und zwar nur für `public`/`internal`, nie unter der Regel eines Ausweises');
}

// ── §10 Verdrahtung ─────────────────────────────────────────────────────────────────────────
{
  ok(registry.ALLOWED_MUTATIONS.includes('purchase_inbox.create') && registry.ALLOWED_MUTATIONS.length === 104,
    `§10 die Buchung steht namentlich in der Zulassungsliste (${registry.ALLOWED_MUTATIONS.length})`);
  ok(registry.knownCommands().includes('purchase_inbox.create'), '§10 …und sie ist angemeldet');
  ok('purchase_inbox.create' in perms.OPERATION_PERMISSIONS
    && (perms.OPERATION_PERMISSIONS as Record<string, unknown>)['purchase_inbox.create'] === null,
    '§10 dasselbe Recht wie das Anlegen eines Einkaufs: kein eigenes Tor');
  const rust = src('src-tauri/src/bridge.rs');
  ok(/pub const OP_PURCHASE_INBOX_CREATE: &str = "purchase_inbox\.create";/.test(rust)
    && /OP_PURCHASE_INBOX_CREATE,\s*\];/.test(rust),
    '§10 Rust kennt denselben Namen und lässt ihn durch');
  ok((/pub const REMOTE_OPS: &\[&str\] = &\[([\s\S]*?)\];/.exec(rust)?.[1].match(/OP_[A-Z_]+/g) ?? []).length === 177,
    '§10 die Registry steht bei 177');

  // Das Telefon: kein Tabellen-Push mehr, sondern Ablage + benannter Auftrag mit Kennung.
  const seite = src('src-tauri/src/sync/mobile_page.rs');
  ok(!/pushChanges/.test(seite), '§10 die Handy-Seite kennt den allgemeinen Abgleich-Push gar nicht mehr');
  ok(!/table_name: 'purchase_inbox'/.test(seite), '§10 …und schreibt die Tabelle nirgends direkt');
  ok(/client\.stagePhoto\(photos\.purchase\)/.test(seite) && /'purchase_inbox\.create'/.test(seite),
    '§10 sie legt die Bytes ab und stellt danach den benannten Auftrag');
  ok(/piIntentKey = null;/.test(seite) && /if \(!piIntentKey\) piIntentKey = 'inbox:' \+ uuid\(\)/.test(seite),
    '§10 …mit einer Kennung, die den offenen Ausgang überlebt und erst beim Ergebnis fällt');
  const offen = seite.slice(seite.indexOf("$('bSaveBtn').onclick"));
  ok(/r\.kind === 'ok'/.test(offen) && /r\.kind === 'rejected'/.test(offen) && /unauthorized/.test(offen),
    '§10 …und beantwortet alle Ausgänge, nicht nur den guten');
  ok(!/images: JSON\.stringify/.test(seite), '§10 nirgends mehr Bildbytes in einem Rumpf');

  // Der Kern: derselbe Aufnahmeweg, dieselbe Klasse, und Aufnahme VOR der Klammer.
  const im = codeOf(src('src/core/purchases/inbox-media.ts'));
  ok(/ingestRecordPhotos/.test(im) && /securityClass: 'internal'/.test(im),
    '§10 der Posteingang nutzt DEN vorhandenen Aufnahmeweg (JPEG, ≤ 100 000 B, EXIF) und die Klasse `internal`');
  const cmd = codeOf(src('src/core/bridge/purchase-lifecycle-commands.ts'));
  const runIdx = cmd.indexOf('export async function runInboxCreate');
  const rumpf = cmd.slice(runIdx, cmd.indexOf('return outcome;', runIdx));
  ok(rumpf.indexOf('ingestInboxPhotos') < rumpf.indexOf('runRemoteCommand'),
    '§10 aufgenommen wird VOR der Klammer — der Ingest hat eigene Haltepunkte, eine offene Transaktion hätte keine');
  ok(/let fotoFehler[\s\S]*if \(fotoFehler\) throw fotoFehler;/.test(rumpf),
    '§10 …und ein Nein wird mitgenommen, damit die Wiederholung die eingefrorene Antwort bekommt');
  ok(/discardStagedAfterSuccess/.test(cmd.slice(runIdx)), '§10 …die Ablage wird erst NACH dem Erfolg geräumt');

  // Auftrag und Altgold bleiben, wie sie waren.
  const om = codeOf(src('src/core/orders/order-media.ts'));
  const sm = codeOf(src('src/core/metals/scrap-media.ts'));
  ok(/ORDER_MEDIA_ROLE = 'reference_image'/.test(om) && /'purchase_photo'/.test(sm) && /'sale_photo'/.test(sm),
    '§10 Auftrag und Altgold behalten ihre eigenen Rollen — dieses Bündel fasst sie nicht an');
  ok(inboxMedia.INBOX_MEDIA_ENTITY === 'purchase_inbox' && inboxMedia.INBOX_MEDIA_ROLE === 'intake_photo',
    '§10 der Posteingang hat seine eigene — ein Aufnahmefoto ist kein Warenbild');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — media business purchase inbox: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('MEDIA_BUSINESS_PURCHASE_INBOX_PROVED');

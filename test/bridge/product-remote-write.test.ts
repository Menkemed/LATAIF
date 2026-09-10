// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C — ein zweiter Rechner legt einen Artikel MIT BILDERN an und ändert ihn.
// Run: node test/bridge/product-remote-write.test.ts
//
// Der ECHTE Weg: `createProductWithMedia` aus dem Store, der echte Medien-Orchestrator, der echte
// Koordinator, das echte Schema, die echte C3A-Maschine. Gestellt ist nur die IPC-Grenze zu Rust
// (`_tauri-shim`) — Transport, keine Entscheidung.
//
// Die vier Fragen, an denen dieser Weg hängt:
//   • Wer vergibt die SKU? (Der Primary. R5B: eine EINGETIPPTE gilt wie an der Maske — getrimmt und
//     gegen den Bestand geprüft; eine vergebene Nummer kommt nicht durch.)
//   • Was passiert, wenn ein Bild nicht durchkommt? (Kein halber Artikel.)
//   • Was passiert bei einer verlorenen Antwort? (Kein zweiter Artikel.)
//   • Wo kommen die Bytes her? (Aus einer Ablage, deren Name ihr Inhalt ist.)
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Die EINZIGE gestellte Grenze: der Weg zu Rust.
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
const {
  runProductCreate, runProductUpdate, parseProductCreate, parseProductUpdate, isStagingId, MAX_REMOTE_IMAGES,
} = await import('../../src/core/bridge/product-commands.ts');
const registry = await import('../../src/core/bridge/command-registry.ts');
await import('../../src/core/bridge/read-commands.ts');
await import('../../src/core/bridge/invoice-command.ts');
await import('../../src/core/bridge/customer-commands.ts');
await import('../../src/core/bridge/return-commands.ts');
await import('../../src/core/bridge/lifecycle-commands.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const { SKU_SEQUENCES_DDL } = await import('../../src/core/products/sku-sequence.ts');
const { useProductStore } = await import('../../src/stores/productStore.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const NOW = '2026-09-05T11:00:00.000Z';

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];

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

const ID = (n: string): string => `${n.padStart(8, '0')}-0000-4000-8000-000000000000`;
const identity = (n: string, op: string, hash = 'h1') => ({
  commandId: ID(n), tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test', role: 'ADMIN', op, payloadHash: hash,
});

function deps(db: Db) {
  const state = { saves: 0 };
  return {
    state,
    deps: {
      db: db as never,
      begin: posting.beginLedgerTransaction,
      commit: posting.commitLedgerTransaction,
      rollback: posting.rollbackLedgerTransaction,
      durableSave: async () => { state.saves += 1; },
      now: () => NOW,
    },
  };
}

/** Ein Bild, das der echten Ablage genügt: seine Kennung IST sein Inhalt. */
function image(seed: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i * 7) & 0xff;
  return stageForTest(bytes, { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-test' });
}

const WISH = { categoryId: 'cat-watch', brand: 'Rolex', name: 'Datejust', purchasePrice: 100, plannedSalePrice: 150 };

const links = (db: Db, pid: string): number =>
  Number(one(db, 'SELECT COUNT(*) FROM media_links WHERE entity_id = ? AND deleted_at IS NULL', [pid]) ?? 0);

// ── 1) Der Rumpf ist ein Wunsch — und die SKU steht nicht darin ───────────
{
  for (const [field, raw] of [
    // R5B — die SKU ist eine Eingabe wie an der Maske (siehe §11). Bestandsstatus und Herkunft
    // dagegen bietet die Anlegemaske gar nicht an: die bestimmt der Primary.
    ['stockStatus', { ...WISH, stockStatus: 'consignment' }],
    ['sourceType', { ...WISH, sourceType: 'CONSIGNMENT' }],
    ['id', { ...WISH, id: 'p-forged' }],
    ['branchId', { ...WISH, branchId: 'branch-fremd' }],
    ['createdBy', { ...WISH, createdBy: 'user-boss' }],
    ['images', { ...WISH, images: ['data:image/jpeg;base64,AAAA'] }],
    ['imageEmbedding', { ...WISH, imageEmbedding: [0.1] }],
    ['expectedMargin', { ...WISH, expectedMargin: 999 }],
    ['aiCorrections', { ...WISH, aiCorrections: '{}' }],
  ] as const) {
    let threw: string | null = null;
    try { parseProductCreate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null && new RegExp(field).test(threw), `AUTHORITY ${field} entscheidet der Primary (${threw})`);
  }

  let unknownField: string | null = null;
  try { parseProductCreate({ ...WISH, secretDiscount: 5 }); } catch (e) { unknownField = String(e); }
  ok(unknownField !== null && /unknown field/.test(unknownField),
    `AUTHORITY ein unbekanntes Feld wird abgewiesen statt ignoriert (${unknownField})`);

  for (const [what, raw] of [
    ['ohne Kategorie', { brand: 'Rolex', name: 'X' }],
    // R5B — „ohne Namen" ist keine Formfrage mehr, sondern die Pflichtfeldregel des Hauses: sie
    // gilt im Auftrag, gegen die Kategorie (§11). Eine Goldkette ohne Namen ist gültig.
    ['eine SKU als Zahl', { ...WISH, sku: 42 }],
    ['negativer Preis', { ...WISH, purchasePrice: -1 }],
    ['Preis als Text', { ...WISH, purchasePrice: '100' }],
  ] as const) {
    let threw: string | null = null;
    try { parseProductCreate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY ${what} wird abgewiesen (${threw})`);
  }

  // Bildkennungen: kein Pfad, keine URL, kein Dateiname — nur ein Inhaltshash.
  for (const [what, ids] of [
    ['ein Pfad', ['../../etc/passwd']],
    ['ein Dateiname', ['bild.jpg']],
    ['eine URL', ['https://example.com/a.jpg']],
    ['ein absoluter Pfad', ['C:/Windows/System32/x.jpg']],
    ['GROSSBUCHSTABEN-Hex', ['A'.repeat(64)]],
    ['zu kurz', ['ab12']],
  ] as const) {
    let threw: string | null = null;
    try { parseProductCreate({ ...WISH, stagingIds: ids }); } catch (e) { threw = String(e); }
    ok(threw !== null && /content hash/.test(threw), `MEDIA ${what} ist keine Bildkennung (${threw})`);
  }
  ok(!isStagingId('..'.padEnd(64, 'a')) && isStagingId('a'.repeat(64)),
    'MEDIA eine Kennung ist genau 64 Hex-Zeichen');

  let tooMany: string | null = null;
  try { parseProductCreate({ ...WISH, stagingIds: Array.from({ length: 9 }, (_, i) => String(i).repeat(64)) }); }
  catch (e) { tooMany = String(e); }
  ok(tooMany !== null && MAX_REMOTE_IMAGES === 8, `MEDIA hoechstens acht Bilder (${tooMany})`);

  let twice: string | null = null;
  try { parseProductCreate({ ...WISH, stagingIds: ['a'.repeat(64), 'a'.repeat(64)] }); } catch (e) { twice = String(e); }
  ok(twice !== null && /twice/.test(twice), `MEDIA dasselbe Bild zweimal ist kein Auftrag (${twice})`);

  // Aendern ist enger als Anlegen.
  for (const [field, raw] of [
    ['category', { id: 'p1', categoryId: 'cat-other' }],
    ['quantity', { id: 'p1', quantity: 5 }],
    ['sku', { id: 'p1', sku: 'X-1' }],
  ] as const) {
    let threw: string | null = null;
    try { parseProductUpdate(raw); } catch (e) { threw = String(e); }
    ok(threw !== null, `AUTHORITY ${field} wird beim Aendern abgewiesen (${threw})`);
  }
  let noId: string | null = null;
  try { parseProductUpdate({ name: 'Neu' }); } catch (e) { noId = String(e); }
  ok(noId !== null && /id is required/.test(noId), 'AUTHORITY ein Update ohne Kennung ist keins');
  const upd = parseProductUpdate({ id: 'p1', name: 'Neu', plannedSalePrice: 200 });
  ok(upd.id === 'p1' && upd.fields.name === 'Neu' && upd.fields.plannedSalePrice === 200,
    'AUTHORITY ein gueltiges Update kommt durch');
}

// ── 2) Der echte Weg: anlegen, mit Bildern ────────────────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);

  const a = image('alpha');
  const b = image('beta');
  const created = await runProductCreate(d, identity('1', 'products.create'), { ...WISH, stagingIds: [a, b] });
  ok(created.kind === 'ok', `CREATE der Artikel entsteht (${JSON.stringify(created)})`);
  const value = (created as { value: { productId: string; sku: string; imageCount: number } }).value;

  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'CREATE genau ein Artikel');
  ok(String(one(db, 'SELECT branch_id FROM products')) === 'branch-main',
    'CREATE die Filiale kommt aus der Sitzung, nicht aus dem Rumpf');
  ok(String(one(db, 'SELECT images FROM products')) === '[]',
    'CREATE und in der Produktzeile steht KEIN Bild — die Galerie gehoert dem Medienspeicher');
  ok(links(db, value.productId) === 2, `CREATE beide Bilder haengen als Verknuepfung (${links(db, value.productId)})`);
  ok(value.imageCount === 2, 'CREATE …und die Antwort sagt, wie viele es waren');
  ok(commandCount(db as never) === 1, 'CREATE der durable Nachweis steht');

  // Die Nummer kommt vom Primary, aus dem durablen Zaehler.
  const sku = String(one(db, 'SELECT sku FROM products'));
  ok(sku !== '' && sku === value.sku, `SKU der Primary hat sie vergeben (${sku})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM sku_sequences')) >= 1, 'SKU …aus dem durablen Zaehler');

  // Und die Ablage ist danach leer: die Bytes liegen im Medienspeicher.
  ok(tauriState.discarded.length === 2 && tauriState.staged.size === 0,
    `MEDIA die Zwischenablage wird nach dem Erfolg geraeumt (${tauriState.discarded.length})`);
}

// ── 3) Zwei Rechner, zwei Nummern ─────────────────────────────────────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);

  const first = await runProductCreate(d, identity('2', 'products.create'), { ...WISH, stagingIds: [image('x')] });
  const second = await runProductCreate(d, identity('3', 'products.create', 'h3'), { ...WISH, stagingIds: [image('y')] });
  const s1 = (first as { value: { sku: string } }).value.sku;
  const s2 = (second as { value: { sku: string } }).value.sku;
  ok(first.kind === 'ok' && second.kind === 'ok' && s1 !== '' && s2 !== '' && s1 !== s2,
    `SKU zwei Anlagen bekommen zwei verschiedene Nummern (${s1} / ${s2})`);
  ok(new Set(db.exec('SELECT sku FROM products')[0].values.map((v) => String(v[0]))).size === 2,
    'SKU …und keine steht doppelt in der Datenbank');
}

// ── 4) Verlorene Antwort: dieselbe Kennung, kein zweiter Artikel ──────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);

  const img = image('gamma');
  const first = await runProductCreate(d, identity('4', 'products.create'), { ...WISH, stagingIds: [img] });
  const pid = (first as { value: { productId: string } }).value.productId;
  const sku1 = String(one(db, 'SELECT sku FROM products WHERE id = ?', [pid]));

  // Die Wiederholung: dieselbe Kennung. Die Ablage ist inzwischen geraeumt — das darf egal sein,
  // denn es wird gar nicht mehr ausgefuehrt.
  const again = await runProductCreate(d, identity('4', 'products.create'), { ...WISH, stagingIds: [img] });
  ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'RETRY als Wiederholung erkannt');
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'RETRY kein zweiter Artikel');
  ok(String(one(db, 'SELECT sku FROM products')) === sku1, 'RETRY und keine zweite Nummer');
  ok(links(db, pid) === 1, 'RETRY auch kein zweites Bild');

  const conflict = await runProductCreate(d, identity('4', 'products.create', 'ANDERS'),
    { ...WISH, name: 'Anders', stagingIds: [image('delta')] });
  ok(conflict.kind === 'rejected' && (conflict as { code: string }).code === 'COMMAND_ID_CONFLICT'
    && (conflict as { frozen: boolean }).frozen === false,
    `RETRY gleiche Kennung, anderer Rumpf: abgewiesen, nichts eingefroren (${JSON.stringify(conflict)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'RETRY …und kein dritter Artikel');
}

// ── 5) Ein Bild kommt nicht durch: KEIN halber Artikel ────────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);

  // (a) Die Ablage ist weg — das faellt VOR der Transaktion auf.
  let gone: string | null = null;
  try {
    await runProductCreate(d, identity('5', 'products.create'), { ...WISH, stagingIds: ['f'.repeat(64)] });
  } catch (e) { gone = String(e); }
  ok(gone !== null && /staged image is gone/.test(gone), `MEDIA eine fehlende Ablage ist eine Antwort (${gone})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 0, 'MEDIA …und es entsteht kein Artikel');
  ok(commandCount(db as never) === 0, 'MEDIA …und kein Nachweis');

  // (b) Das Veroeffentlichen scheitert MITTEN im Weg. Der Artikel darf nicht halb existieren.
  tauriState.prepareShouldThrow = true;
  const failed = await runProductCreate(d, identity('6', 'products.create', 'h6'), { ...WISH, stagingIds: [image('eps')] });
  ok(failed.kind === 'rejected' && (failed as { code: string }).code === 'PRODUCT_MEDIA_INCOMPLETE',
    `MEDIA ein Medienausfall ist kein Erfolg (${JSON.stringify(failed)})`);
  ok(failed.kind === 'rejected' && (failed as { frozen: boolean }).frozen === false,
    'MEDIA …und ausdruecklich KEIN Urteil: nichts wurde bewertet');
  // Und die Bruecke sagt das auch so: ein nicht eingefrorenes Nein ist kein fachliches Nein.
  const wrap = src('src/core/bridge/product-commands.ts');
  ok(/if \(!outcome\.frozen\) throw new CommandNotEvaluated\(outcome\.code, outcome\.message\);/.test(wrap),
    'MEDIA die Bruecke meldet es als „nie bewertet", nicht als Ablehnung');
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 0,
    'MEDIA kein halber Artikel — die ganze Transaktion ist zurueckgenommen');
  ok(commandCount(db as never) === 0,
    'MEDIA und KEIN eingefrorenes Urteil: dieselbe Kennung darf es erneut versuchen');

  // (c) …und genau das tut sie, sobald es wieder geht.
  tauriState.prepareShouldThrow = false;
  const retry = await runProductCreate(d, identity('6', 'products.create', 'h6'), { ...WISH, stagingIds: [image('eps')] });
  ok(retry.kind === 'ok' && (retry as { replayed: boolean }).replayed === false,
    `MEDIA die Wiederholung derselben Kennung legt ihn jetzt an (${JSON.stringify(retry)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'MEDIA …und zwar genau einmal');
}

// ── 6) Aendern: enger Rumpf, echte Domäne ─────────────────────────────────
{
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);

  const made = await runProductCreate(d, identity('7', 'products.create'), { ...WISH, stagingIds: [image('zeta')] });
  const pid = (made as { value: { productId: string } }).value.productId;
  const skuBefore = String(one(db, 'SELECT sku FROM products WHERE id = ?', [pid]));

  const edited = await runProductUpdate(d, identity('8', 'products.update', 'h8'),
    { id: pid, name: 'Datejust 41', notes: 'geprueft' });
  ok(edited.kind === 'ok', `UPDATE die Aenderung geht durch (${JSON.stringify(edited)})`);
  ok(String(one(db, 'SELECT name FROM products WHERE id = ?', [pid])) === 'Datejust 41', 'UPDATE der Name ist geaendert');
  ok(String(one(db, 'SELECT notes FROM products WHERE id = ?', [pid])) === 'geprueft', 'UPDATE und die Notiz');
  ok(String(one(db, 'SELECT sku FROM products WHERE id = ?', [pid])) === skuBefore,
    'UPDATE die Nummer bleibt — sie ist keine Eingabe');
  ok(links(db, pid) === 1, 'UPDATE und die Galerie bleibt unangetastet');

  const missing = await runProductUpdate(d, identity('9', 'products.update', 'h9'), { id: 'gibt-es-nicht', name: 'X' });
  ok(missing.kind === 'rejected' && (missing as { code: string }).code === 'PRODUCT_NOT_FOUND'
    && (missing as { frozen: boolean }).frozen === true,
    `UPDATE ein unbekannter Artikel wird abgelehnt und eingefroren (${JSON.stringify(missing)})`);

  const replay = await runProductUpdate(d, identity('8', 'products.update', 'h8'),
    { id: pid, name: 'Datejust 41', notes: 'geprueft' });
  ok(replay.kind === 'ok' && (replay as { replayed: boolean }).replayed === true,
    'UPDATE die Wiederholung liefert das eingefrorene Ergebnis');
}

// ── 7) Die Preissperre gilt auch von außen ────────────────────────────────
//
// Ein Artikel, der an einem Geschäftsvorgang hängt, ändert seinen Preis nicht — beim Handy nicht
// und von einem zweiten Rechner erst recht nicht. Geprüft wird, dass der Fernauftrag dieselbe
// Prüfung EINSCHALTET; ihre Wirkung selbst hat ihren eigenen Gate-Test.
{
  const cmd = src('src/core/bridge/product-commands.ts');
  ok(/priceEligibilityRequired: true/.test(cmd),
    'PRICE der Fernauftrag laeuft mit der verbindlichen Preisberechtigung');
  ok(!/priceEligibilityRequired: false/.test(cmd), 'PRICE …und schaltet sie nirgends ab');
  const coord = src('src/core/media/coordinator.ts');
  ok(/if \(pe\.priceEligibilityRequired && touchesPriceColumns\(pe\.set\)\)/.test(coord),
    'PRICE und die Pruefung sitzt in derselben Transaktion wie der UPDATE');
}

// ── 8) Keine zweite Produktlogik, kein zweiter Medienweg ──────────────────
{
  const cmd = src('src/core/bridge/product-commands.ts');
  // Kommentare erklaeren auch, was NICHT passiert (`media_links` zum Beispiel) — geprueft wird
  // deshalb der Code ohne sie.
  const cmdCode = cmd.split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');
  ok(/createProductWithMedia\(/.test(cmd) && /editProductTextDurably\(/.test(cmd),
    'REUSE der Befehl ruft die ECHTEN Store-Funktionen…');
  ok(!/INSERT INTO products|UPDATE products SET|media_links/i.test(cmdCode),
    'REUSE …und schreibt keine einzige Produkt- oder Medienzeile selbst');
  ok(/runRemoteCommand\(/.test(cmd), 'REUSE er laeuft durch die C3A-Maschine');
  ok(/allocateSkuOnCreate\(undefined/.test(cmd),
    'REUSE die Nummer kommt aus dem durablen Zaehler, ohne Vorschlag des Clients');
  ok(/alreadySerialised: true/.test(cmd),
    'REUSE und er reiht sich nicht ein zweites Mal ein — der Fernauftrag haelt den Platz schon');

  // Der mobile Produkt-Eingang wird NICHT missbraucht.
  ok(!/mobile\/upload|mobile_upload|prepared_media|mobileUpload/.test(cmdCode),
    'INGRESS der Produktbefehl fasst den mobilen Produkt-Eingang nicht an (der Kopf ERKLAERT nur, warum nicht)');
  ok(/mobile\/upload/.test(cmd) && /PRODUKT-EINGANG/.test(cmd),
    'INGRESS …und die Begruendung steht im Code, nicht nur in diesem Test');
  const rs = src('src-tauri/src/sync/routes.rs');
  ok(/\.route\("\/staging\/media", post\(staging_media_put\)\)/.test(rs),
    'INGRESS es gibt eine eigene, neutrale Ablage-Route');
  const staging = src('src-tauri/src/sync/media_staging.rs');
  ok(!/INSERT INTO|UPDATE |DELETE FROM|Connection|rusqlite/i.test(staging),
    'INGRESS sie fasst keine Datenbank an — kein Produkt entsteht dort');
  ok(/pub fn is_staging_id/.test(staging) && /64/.test(staging),
    'INGRESS und sie kennt keinen Pfad, nur einen Inhaltshash');
  const routeHandler = rs.slice(rs.indexOf('async fn staging_media_put'), rs.indexOf('struct CommandRequest'));
  ok(!/path|filename|dir/i.test(routeHandler.replace(/\/\/.*/g, '')),
    'INGRESS der Rumpf der Route hat kein Feld fuer ein Ziel');
  ok(/may_write_sync\(\)/.test(routeHandler) && /claims\.role/.test(routeHandler),
    'INGRESS sie liegt hinter derselben Anmeldung und demselben Schreibriegel');
}

// ── 9) Die Zulassungsliste: genau fünf Namen ──────────────────────────────
{
  await import('../../src/core/bridge/product-commands.ts');
  await import('../../src/core/bridge/invoice-lifecycle-commands.ts');
  await import('../../src/core/bridge/commercial-commands.ts');
  await import('../../src/core/bridge/service-commands.ts');
  await import('../../src/core/bridge/financial-commands.ts');
  // CENTRAL-UI-PARITY — die 47 Store-Auskuenfte gehoeren zum ausgelieferten Zustand: der
  // Bruecken-Zuhoerer laedt sie ebenfalls. Ohne diesen Import misst das Gate einen Teilstand.
  await import('../../src/core/bridge/store-read-commands.ts');
  const known = registry.knownCommands();
  const reads = known.filter((o) => o.endsWith('.list') || o.endsWith('.get'));
  const mutations = registry.ALLOWED_MUTATIONS;
  ok(mutations.join(',') === 'invoices.create,customers.create,customers.update,products.create,products.update,invoices.update,invoices.record_payment,purchases.create,consignments.create,consignments.update,orders.create,orders.update,repairs.create,repairs.update,transfers.create,transfers.update,transfers.mark_returned,invoices.apply_credit,invoices.update_payment,invoices.delete_payment,orders.convert_to_invoice,consignments.record_payout,transfers.mark_sold,transfers.mark_settled,returns.create,returns.approve,returns.refund,returns.record_refund_payment,orders.update_status,orders.add_payment,orders.delete_payment,consignments.record_sale,consignments.mark_returned,repairs.update_status,repairs.create_invoice,repairs.add_line,repairs.update_line,repairs.cancel_line,transfers.convert_to_invoice,transfers.convert_many_to_invoice',
    `ALLOWLIST genau diese vierzig Mutationen (${mutations.join(', ')})`);
  // CENTRAL-UI-PARITY R1: dazu 48 typisierte Auskuenfte mit gepruefter Identitaet und ohne Nebenwirkung
  const parityReads = known.filter((o) => ['store.products.get', 'store.customers.get', 'store.invoices.get', 'order_payments.get', 'session.context.get', 'store.suppliers.get', 'store.sales_returns.get', 'store.credit_notes.get', 'store.orders.get', 'store.consignments.get', 'store.purchases.get', 'store.repairs.get', 'store.agents.get', 'store.expenses.get', 'store.recurring_expenses.get', 'store.banking.get', 'store.payables.get', 'store.debts.get', 'store.gold.get', 'store.metals.get', 'store.scrap_trades.get', 'store.employees.get', 'store.partners.get', 'store.tasks.get', 'store.documents.get', 'store.offers.get', 'store.production.get', 'store.analytics.get', 'analytics.vat_export.get', 'documents.content.get', 'page.dashboard.get', 'page.invoice_list.get', 'page.order_list.get', 'page.customer_detail.get', 'page.order_detail.get', 'page.supplier_detail.get', 'page.product_detail.get', 'page.purchase_create.get', 'refs.numbers.get', 'metals.stock_by_karat.get', 'search.global.get', 'page.reconciliation.get', 'ledger.balances.get', 'finance.receivables.get', 'inventory.lot_aggregates.get', 'product.lots.get', 'product.lots.batch.get', 'expenses.credit_paid.get'].includes(o));
  ok(known.length === 107 && reads.length === 66 && parityReads.length === 48 && known.includes('bridge.probe'),
    `ALLOWLIST 1 Probe + 18 Auskuenfte + 48 typisierte Auskuenfte + 40 Buchungen = 107 (${known.length}/${reads.length}/${parityReads.length})`);

  for (const op of ['products.delete', 'customers.delete', 'invoice.delete', 'anything.write']) {
    let threw: string | null = null;
    try { registry.registerCommand(op, { kind: 'mutation', handler: () => ({ ok: true }) }); }
    catch (e) { threw = String(e); }
    ok(threw !== null && /refusing to register/.test(threw), `ALLOWLIST ${op} wird weiterhin abgewiesen`);
  }

  const rs = src('src-tauri/src/bridge.rs');
  const list = rs.slice(rs.indexOf('pub const REMOTE_OPS'), rs.indexOf('];', rs.indexOf('pub const REMOTE_OPS')));
  ok((list.match(/OP_[A-Z_]+/g) || []).length === 107, 'ALLOWLIST Rust kennt dieselben einhundertsieben Namen');
  ok(/OP_PRODUCTS_CREATE: &str = "products.create"/.test(rs) && /OP_PRODUCTS_UPDATE: &str = "products.update"/.test(rs),
    'ALLOWLIST …namentlich, nicht generisch');
}

// ── 10) Gegenproben ───────────────────────────────────────────────────────
{
  // (a) An der Maschine vorbei: der Store direkt. Kein Nachweis, und die „Wiederholung" legt einen
  //     ZWEITEN Artikel mit einer ZWEITEN Nummer an — genau das faengt §4.
  resetDurabilityStateForTest();
  tauriState.reset();
  const db = freshDb();
  const st = useProductStore.getState();
  await st.createProductWithMedia({ ...WISH, sku: '' } as never, undefined, undefined, { kind: 'data_urls', images: [] });
  await st.createProductWithMedia({ ...WISH, sku: '' } as never, undefined, undefined, { kind: 'data_urls', images: [] });
  ok(commandCount(db as never) === 0 && Number(one(db, 'SELECT COUNT(*) FROM products')) === 2,
    'CONTROL a ohne die Maschine gibt es keinen Nachweis und zwei Artikel');

  // (b) R5B — eine eingetippte SKU reist mit (wie an der Maske), getrimmt. Dass eine schon
  //     vergebene Nummer trotzdem nicht durchkommt, prueft §11 im Auftrag gegen den Bestand.
  const typedSku = parseProductCreate({ ...WISH, sku: '  RLX-999  ' });
  ok(typedSku.sku === 'RLX-999' && !('sku' in typedSku.data),
    `CONTROL b die eingetippte Nummer reist getrimmt und SEPARAT mit (${typedSku.sku})`);

  // (c) Ein Medien-Zielpfad vom Client: es gibt kein Feld dafuer, und der Weg ueber `stagingIds`
  //     nimmt nur Inhaltshashes. Beides zusammen ist die Sperre.
  let pathRejected = false;
  try { parseProductCreate({ ...WISH, stagingIds: ['../../media/evil.jpg'] }); } catch { pathRejected = true; }
  let fieldRejected = false;
  try { parseProductCreate({ ...WISH, mediaPath: 'C:/x.jpg' }); } catch { fieldRejected = true; }
  ok(pathRejected && fieldRejected, 'CONTROL c weder als Kennung noch als Feld kommt ein Pfad durch');
}


// ── 11) R5B — dieselbe Vorbereitung wie an der Anlegemaske ────────────────
{
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  tauriState.reset();
  const db = freshDb();
  const { deps: d } = deps(db);
  const code = (o: unknown): string => String((o as { code?: string }).code ?? '');

  // (a) Eine eingetippte SKU gilt — getrimmt, wie an der Maske.
  const typed = await runProductCreate(d, identity('201', 'products.create'), { ...WISH, sku: '  RLX-TYPED-1 ' });
  ok(typed.kind === 'ok', `R5B eine eingetippte SKU wird angelegt (${JSON.stringify(typed).slice(0, 120)})`);
  const tid = (typed as { value: { productId: string } }).value?.productId;
  ok(String(one(db, 'SELECT sku FROM products WHERE id = ?', [tid])) === 'RLX-TYPED-1',
    `R5B …getrimmt (${String(one(db, 'SELECT sku FROM products WHERE id = ?', [tid]))})`);

  // (b) Eine schon vergebene Nummer (auch in anderer Schreibweise) kommt nicht durch — der Riegel
  //     sitzt im Auftrag, gegen den frisch geladenen Bestand. Ein Urteil, eingefroren.
  const taken = await runProductCreate(d, identity('202', 'products.create'), { ...WISH, name: 'Zweiter', sku: 'rlx-typed-1' });
  ok(taken.kind === 'rejected' && code(taken) === 'SKU_TAKEN' && (taken as { frozen: boolean }).frozen === true,
    `R5B eine vergebene SKU ist ein Nein (${JSON.stringify(taken).slice(0, 140)})`);
  ok(Number(one(db, 'SELECT COUNT(*) FROM products')) === 1, 'R5B …und es entsteht kein zweiter Artikel');

  // (c) Pflichtfelder nach der Regel des Hauses: eine Uhr ohne Namen ist auch aus der Ferne ungültig…
  const noName = await runProductCreate(d, identity('203', 'products.create'), { categoryId: 'cat-watch', brand: 'Rolex' });
  ok(noName.kind === 'rejected' && code(noName) === 'PRODUCT_FIELDS_REQUIRED',
    `R5B eine Uhr ohne Namen ist ein Nein (${code(noName)})`);
  // …eine Goldkette ohne Marke und Namen dagegen gültig — genau wie an der Maske.
  db.run("INSERT INTO categories (id, branch_id, name, icon, color, created_at, updated_at) VALUES ('cat-gold-jewelry','branch-main','Gold','g','#000',?,?)", [NOW, NOW]);
  const gold = await runProductCreate(d, identity('204', 'products.create'), { categoryId: 'cat-gold-jewelry' });
  ok(gold.kind === 'ok', `R5B eine Goldkette ohne Marke/Namen ist gültig wie an der Maske (${JSON.stringify(gold).slice(0, 120)})`);

  // (d) Ein Attribut, dessen Bedingung nicht erfüllt ist, wird nicht gespeichert.
  db.run(`INSERT INTO categories (id, branch_id, name, icon, color, attributes, created_at, updated_at)
    VALUES ('cat-dep','branch-main','Dep','d','#000',?,?,?)`, [JSON.stringify([
    { key: 'material', label: 'Material', type: 'select', options: ['Steel', 'Gold'] },
    { key: 'karat_color', label: 'Karat', type: 'select', options: ['18K Yellow'], dependsOn: { key: 'material', valueIncludes: ['Gold'] } },
  ]), NOW, NOW]);
  const stale = await runProductCreate(d, identity('205', 'products.create'),
    { categoryId: 'cat-dep', brand: 'X', name: 'Steel One', attributes: { material: 'Steel', karat_color: '18K Yellow' } });
  const sid = (stale as { value: { productId: string } }).value?.productId;
  const attrs = JSON.parse(String(one(db, 'SELECT attributes FROM products WHERE id = ?', [sid]) ?? '{}'));
  ok(stale.kind === 'ok' && attrs.material === 'Steel' && !('karat_color' in attrs),
    `R5B ein veraltetes Attribut wird gestrichen, wie an der Maske (${JSON.stringify(attrs)})`);

  // (e) Die Filiale des Auftrags muss die dieses Rechners sein.
  const fremd = await runProductCreate(d, { ...identity('206', 'products.create'), branchId: 'branch-other' }, { ...WISH, name: 'Fremd' });
  ok(fremd.kind === 'rejected' && code(fremd) === 'BRANCH_MISMATCH', `R5B ein Ausweis einer anderen Filiale legt nichts an (${code(fremd)})`);

  // (f) Eine Ablage eines ANDEREN Benutzers ist von hier aus nicht vorhanden.
  const foreign = stageForTest(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8, 7, 6, 5, 4]),
    { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-other' });
  const vorher = Number(one(db, 'SELECT COUNT(*) FROM products'));
  let fremdeAblage = '';
  try { await runProductCreate(d, identity('207', 'products.create'), { ...WISH, name: 'Fremdbild', stagingIds: [foreign] }); }
  catch (e) { fremdeAblage = String(e); }
  ok(/staged image is gone/.test(fremdeAblage) && Number(one(db, 'SELECT COUNT(*) FROM products')) === vorher,
    `R5B eine fremde Ablage öffnet nichts, und es entsteht nichts (${fremdeAblage.slice(0, 80)})`);
}

// ── 12) R5B — die Kommission: EIN Vorgang, Artikel + Bilder + Kommission ──
{
  const cmdC = await import('../../src/core/bridge/commercial-commands.ts');
  const { createConsignmentOnPrimary } = await import('../../src/core/consignment/consignment-create.ts');
  const { useConsignmentStore } = await import('../../src/stores/consignmentStore.ts');
  const code = (o: unknown): string => String((o as { code?: string }).code ?? '');
  const seedConsignor = (db: Db): void => {
    db.run(`INSERT INTO customers (id, branch_id, first_name, last_name, country, language, vip_level,
        preferences, customer_type, sales_stage, created_at, updated_at)
      VALUES ('cust-1','branch-main','Ali','Hassan','BH','en',0,'[]','collector','active',?,?)`, [NOW, NOW]);
  };
  const BODY = {
    consignorId: 'cust-1',
    product: {
      categoryId: 'cat-watch', brand: 'Patek', name: 'Nautilus', condition: 'Pre-Owned',
      sku: ' PP-5711 ', attributes: { dial: 'Blue' }, taxScheme: 'MARGIN',
      storageLocation: 'Safe 2', scopeOfDelivery: ['Box', 'Papers'],
    },
    agreedPrice: 1000,
    payout: { model: 'percent', commissionRate: 20 },
    staffId: 'emp-7',
    acknowledgeDuplicate: true,
  };
  const zaehle = (db: Db) => ({
    artikel: Number(one(db, 'SELECT COUNT(*) FROM products')),
    kommissionen: Number(one(db, 'SELECT COUNT(*) FROM consignments')),
    verknuepfungen: Number(one(db, 'SELECT COUNT(*) FROM media_links')),
    auftraege: Number(one(db, 'SELECT COUNT(*) FROM media_ingest_jobs')),
    nachweise: commandCount(db as never),
  });

  // (a) Der echte Weg vom zweiten Rechner: Artikel mit Bild im Medienspeicher, Kommission daran.
  {
    resetDurabilityStateForTest();
    resetTransactionHealthForTest();
    tauriState.reset();
    const db = freshDb();
    seedConsignor(db);
    const { deps: d } = deps(db);
    const img = image('consign-a');
    const out = await cmdC.runConsignmentCreate(d, identity('301', 'consignments.create'), { ...BODY, stagingIds: [img] });
    ok(out.kind === 'ok', `R5B-K die Kommission entsteht vom zweiten Rechner (${JSON.stringify(out).slice(0, 160)})`);
    const v = (out as { value: { productId: string; consignmentId: string; sku: string; imageCount: number } }).value;
    const p = db.exec('SELECT stock_status, source_type, quantity, purchase_price, images, sku, tax_scheme, storage_location, scope_of_delivery, attributes FROM products WHERE id = ?', [v.productId])[0].values[0];
    ok(String(p[0]) === 'consignment' && String(p[1]) === 'CONSIGNMENT' && Number(p[2]) === 1,
      `R5B-K der Artikel trägt die festen Werte des Kommissionseingangs (${p[0]}/${p[1]}/${p[2]})`);
    ok(Math.abs(Number(p[3]) - 800) < 0.001, `R5B-K …und den erwarteten Einstand aus dem Modell (${p[3]})`);
    ok(String(p[4]) === '[]' && links(db, v.productId) === 1,
      `R5B-K das Bild liegt im Medienspeicher, nicht als Text in der Zeile (${p[4]} / ${links(db, v.productId)})`);
    ok(Number(one(db, 'SELECT is_primary FROM media_links WHERE entity_id = ?', [v.productId])) === 1, 'R5B-K …als Hauptbild');
    ok(String(p[5]) === 'PP-5711' && v.sku === 'PP-5711', `R5B-K die eingetippte SKU, getrimmt (${p[5]})`);
    ok(String(p[6]) === 'MARGIN' && String(p[7]) === 'Safe 2' && String(p[8]).includes('Papers') && String(p[9]).includes('Blue'),
      `R5B-K Steuer, Lagerort, Lieferumfang und Attribute kommen an (${p[6]}/${p[7]}/${p[8]}/${p[9]})`);
    const c = db.exec('SELECT product_id, staff_id, status, revision, commission_type, commission_rate FROM consignments WHERE id = ?', [v.consignmentId])[0].values[0];
    ok(String(c[0]) === v.productId && String(c[1]) === 'emp-7' && String(c[2]) === 'active' && Number(c[3]) === 1,
      `R5B-K die Kommission hängt am Artikel, mit Mitarbeiter und Fassung 1 (${c.join('/')})`);
    ok(String(c[4]) === 'percent' && Number(c[5]) === 20, `R5B-K …und dem Modell der Maske (${c[4]}/${c[5]})`);
    ok(tauriState.discarded.length === 1 && v.imageCount === 1, 'R5B-K die Ablage ist nach dem Erfolg geräumt');

    // (b) Verlorene Antwort: dieselbe Kennung — keine zweite Kombination.
    const again = await cmdC.runConsignmentCreate(d, identity('301', 'consignments.create'), { ...BODY, stagingIds: [img] });
    ok(again.kind === 'ok' && (again as { replayed: boolean }).replayed === true, 'R5B-K die Wiederholung antwortet');
    const z = zaehle(db);
    ok(z.artikel === 1 && z.kommissionen === 1 && z.verknuepfungen === 1,
      `R5B-K …kein zweiter Artikel, keine zweite Kommission, kein zweites Bild (${JSON.stringify(z)})`);

    // (c) Dieselbe SKU noch einmal: der Riegel des Hauses.
    const dup = await cmdC.runConsignmentCreate(d, identity('302', 'consignments.create'),
      { ...BODY, product: { ...BODY.product, name: 'Anders', sku: 'pp-5711' } });
    ok(dup.kind === 'rejected' && code(dup) === 'SKU_TAKEN', `R5B-K eine vergebene SKU ist ein Nein (${code(dup)})`);

    // (d) Ein fremder Ausweis, eine fremde Ablage.
    const fremd = await cmdC.runConsignmentCreate(d, { ...identity('303', 'consignments.create'), branchId: 'branch-other' },
      { ...BODY, product: { ...BODY.product, sku: 'X-1' } });
    ok(fremd.kind === 'rejected' && code(fremd) === 'BRANCH_MISMATCH', `R5B-K ein Ausweis einer anderen Filiale legt nichts an (${code(fremd)})`);
    const foreign = stageForTest(new Uint8Array([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]),
      { tenantId: 'tenant-1', branchId: 'branch-main', userId: 'user-other' });
    let fremdeAblage = '';
    try {
      await cmdC.runConsignmentCreate(d, identity('304', 'consignments.create'),
        { ...BODY, product: { ...BODY.product, sku: 'X-2' }, stagingIds: [foreign] });
    } catch (e) { fremdeAblage = String(e); }
    const z2 = zaehle(db);
    ok(/staged image is gone/.test(fremdeAblage) && z2.artikel === 1 && z2.kommissionen === 1,
      `R5B-K eine fremde Ablage öffnet nichts (${fremdeAblage.slice(0, 70)})`);
  }

  // (e) Ein Fehler ZWISCHEN Artikel und Kommission — vom zweiten Rechner.
  {
    resetDurabilityStateForTest();
    resetTransactionHealthForTest();
    tauriState.reset();
    const db = freshDb();
    seedConsignor(db);
    const { deps: d } = deps(db);
    const echt = useConsignmentStore.getState().createConsignment;
    let artikelDa = -1;
    useConsignmentStore.setState({ createConsignment: (() => {
      artikelDa = Number(one(db, 'SELECT COUNT(*) FROM products')) + Number(one(db, 'SELECT COUNT(*) FROM media_links')) * 10;
      throw new Error('INJECTED: the consignment fails after the product and its image exist');
    }) as never });
    let geworfen = '';
    try { await cmdC.runConsignmentCreate(d, identity('311', 'consignments.create'), { ...BODY, stagingIds: [image('consign-e')] }); }
    catch (e) { geworfen = String(e); }
    finally { useConsignmentStore.setState({ createConsignment: echt }); }
    ok(artikelDa === 11, `R5B-K der Fehler fiel NACH Artikel und Bild (${artikelDa})`);
    const z = zaehle(db);
    ok(/INJECTED/.test(geworfen) && z.artikel === 0 && z.kommissionen === 0 && z.verknuepfungen === 0 && z.auftraege === 0 && z.nachweise === 0,
      `R5B-K kein halbfertiger Zustand: kein Artikel, keine Kommission, keine Bildverknüpfung, kein Nachweis (${JSON.stringify(z)})`);
    // Dieselbe Kennung darf es danach erneut versuchen — nichts wurde festgehalten.
    const retry = await cmdC.runConsignmentCreate(d, identity('311', 'consignments.create'), { ...BODY, stagingIds: [image('consign-e')] });
    ok(retry.kind === 'ok' && (retry as { replayed: boolean }).replayed === false,
      `R5B-K die Wiederholung derselben Kennung legt sie jetzt an (${JSON.stringify(retry).slice(0, 100)})`);
  }

  // (f) Derselbe Vorgang an der Maske des Primary: EINE Klammer — auch dort.
  {
    resetDurabilityStateForTest();
    resetTransactionHealthForTest();
    tauriState.reset();
    const db = freshDb();
    seedConsignor(db);
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = (i * 13 + 5) & 0xff;
    const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
    const input = {
      consignorId: 'cust-1',
      product: { categoryId: 'cat-watch', brand: 'Patek', name: 'Aquanaut', sku: 'PP-5167' },
      agreedPrice: 1000,
      payout: { model: 'consignor_fixed' },
    };
    const echt = useConsignmentStore.getState().createConsignment;
    useConsignmentStore.setState({ createConsignment: (() => { throw new Error('INJECTED-LOCAL'); }) as never });
    let geworfen = '';
    try { await createConsignmentOnPrimary(input, { kind: 'data_urls', images: [dataUrl] }); }
    catch (e) { geworfen = String(e); }
    finally { useConsignmentStore.setState({ createConsignment: echt }); }
    const z = zaehle(db);
    ok(/INJECTED-LOCAL/.test(geworfen) && z.artikel === 0 && z.kommissionen === 0 && z.verknuepfungen === 0,
      `R5B-K am Primary: ein Fehler nach dem Artikel nimmt ALLES zurück (${JSON.stringify(z)})`);
    const made = await createConsignmentOnPrimary(input, { kind: 'data_urls', images: [dataUrl] });
    const z2 = zaehle(db);
    ok(z2.artikel === 1 && z2.kommissionen === 1 && links(db, made.productId) === 1
      && String(one(db, 'SELECT images FROM products WHERE id = ?', [made.productId])) === '[]',
      `R5B-K am Primary: Artikel mit Bild im Medienspeicher + Kommission (${JSON.stringify(z2)})`);
    ok(String(one(db, 'SELECT commission_type FROM consignments')) === 'consignor_fixed'
      && Math.abs(Number(one(db, 'SELECT purchase_price FROM products WHERE id = ?', [made.productId])) - 1000) < 0.001,
      'R5B-K …mit dem Modell der Maske und dem erwarteten Einstand');
  }
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c product remote write: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_PRODUCT_DOMAIN_REUSE_PROVED');
console.log('CENTRAL_C3C_PRODUCT_SKU_AUTHORITY_PROVED');
console.log('CENTRAL_C3C_PRODUCT_MEDIA_ATOMICITY_PROVED');
console.log('CENTRAL_C3C_NEUTRAL_STAGING_INGRESS_PROVED');
console.log('CENTRAL_UI_R5B_PRODUCT_MEDIA_FAILURE_CONTRACT_PROVED');
console.log('CENTRAL_UI_R5B_CONSIGNMENT_CREATE_ATOMIC_DOMAIN_PROVED');

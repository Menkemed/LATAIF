// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B / PP-12 — Nachtrag: der „New Item"-Artikel (Einkauf, Auftrag) zieht nach dem Commit mit seinen
// Fotos in den Medienspeicher um (Cutover-Dienst: Hauptbild + Vorschau), als NÄCHSTER Auftrag der Schreibreihenfolge.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
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

const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const { runExclusive } = await import('../../src/core/bridge/command-scheduler.ts');
const nim = await import('../../src/core/media/new-item-media.ts');

// ══ §2 — der „New Item"-Artikel zieht in den Medienspeicher um ══════════════
{
  const log: string[] = [];
  const cut: string[] = [];
  let reloads = 0;
  const deps = {
    scopeOf: (id: string) => (id === 'gone' ? null : { tenantId: 't1', branchId: 'b1' }),
    cutover: async (id: string) => {
      log.push('cutover:' + id); cut.push(id);
      if (id === 'bad') { const e = new Error('ingest failed') as Error & { code?: string }; e.code = 'MEDIA_CUTOVER_INGEST_FAILED'; throw e; }
      return { action: 'migrated', imported: 2 };
    },
    reload: () => { reloads++; },
  };
  await runExclusive(async () => {
    nim.scheduleNewItemMediaCutover('p1', deps);
    nim.scheduleNewItemMediaCutover('p2', deps);
    nim.scheduleNewItemMediaCutover('gone', deps);
    nim.scheduleNewItemMediaCutover('bad', deps);
    await sleep(30);
    log.push('vorgang-ende');
  });
  await runExclusive(async () => { /* der Umzug steht vor diesem Auftrag in der Reihe */ });
  const reps = nim.lastNewItemMediaReports();
  ok(log[0] === 'vorgang-ende', `REIHENFOLGE der Umzug beginnt erst nach dem Vorgang, der den Artikel anlegte (${log.join(' → ')})`);
  ok(cut.join(',') === 'p1,p2,bad' && reps.length === 4, `REIHENFOLGE EIN Umzugsauftrag für alle vorgemerkten Artikel, in Anlagereihenfolge (${cut.join(',')})`);
  ok(reps.find((r) => r.productId === 'gone')?.action === 'gone', 'ZURÜCKGENOMMEN ein Artikel ohne Zeile (Vorgang zurückgenommen) → nichts wird angefasst');
  ok(reps.find((r) => r.productId === 'bad')?.action === 'failed' && reps.find((r) => r.productId === 'bad')?.code === 'MEDIA_CUTOVER_INGEST_FAILED',
    'FEHLER ein gescheiterter Umzug wird gemeldet — die Fotos bleiben in der Spalte (die Wahrheit), die anderen ziehen trotzdem um');
  ok(reloads === 1 && nim.pendingNewItemMedia().length === 0, 'DANACH die Artikelliste einmal frisch, nichts bleibt vorgemerkt');

  // Ohne Medienspeicher (kein Tauri) bleibt die Spalte die Wahrheit — nichts wird vorgemerkt.
  nim.scheduleNewItemMediaCutover('p-node');
  ok(nim.pendingNewItemMedia().length === 0, 'OHNE MEDIENSPEICHER (Browser/Node) nichts vorgemerkt');

  const ps = code(src('src/stores/productStore.ts'));
  const create = ps.slice(ps.indexOf('createProduct: (data) => {'), ps.indexOf('createProductWithMedia: (data, retryProductId'));
  ok(/if \(product\.images\.length > 0\) \{\s*scheduleNewItemMediaCutover\(id\);/.test(create), 'ANLAGE `createProduct` merkt den Artikel NUR mit Fotos vor');
  ok((ps.match(/scheduleNewItemMediaCutover\(/g) || []).length === 1, 'ANLAGE nur dort — der Medienweg (`createProductWithMedia`) braucht keinen Umzug');
  const m = code(src('src/core/media/new-item-media.ts'));
  ok(/new ProductMediaCutoverService\(/.test(m) && /ensureProductMediaCutover\(productId\)/.test(m)
    && /UPDATE products SET images = '\[\]' WHERE id = \?/.test(m) && /await saveDatabaseDurably\(\)/.test(m),
    'UMZUG derselbe Cutover-Dienst wie beim Bearbeiten eines Altartikels: erst alle Bilder durabel, DANN die Spalte leeren (durabel)');
  ok(/FROM products p JOIN branches b ON b\.id = p\.branch_id WHERE p\.id = \?/.test(m), 'UMZUG Filiale und Mandant aus der Zeile des Artikels (auch für einen Fernauftrag)');
  // Jeder synchrone Anlageweg mit Fotos geht durch `createProduct`.
  const callers: Array<[string, RegExp]> = [
    ['src/stores/purchaseStore.ts', /createProduct\(\{\s*\.\.\.ln\.newProduct/],
    ['src/stores/orderStore.ts', /createProduct\(\{\s*\.\.\.l\.newProduct/],
    ['src/stores/orderStore.ts', /createProduct\(\{\s*\.\.\.patch\.newProduct/],
    ['src/stores/orderStore.ts', /images: spec\.images \|\| \[\]/],
    ['src/pages/orders/OrderDetail.tsx', /images: spec\.images \|\| \[\]/],
    ['src/core/orders/order-invoice-lines.ts', /images: spec\.images \|\| \[\]/],
  ];
  for (const [f, re] of callers) ok(re.test(src(f)), `ANLAGEWEG ${f} legt den Artikel mit seinen Fotos über createProduct an (${re.source.slice(0, 40)})`);
}

if (fails.length) {
  console.log(`
FAIL — r7b pp-12 new item media: ${PASS} passed, ${fails.length} failed`);
  process.exit(1);
}
console.log('POST_PARITY_PP12_NEW_ITEM_MEDIA_PROVED');
console.log(`
PASS — r7b pp-12 new item media: ${PASS} passed, 0 failed`);

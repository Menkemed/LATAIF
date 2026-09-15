// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B — Plattform / Laufzeit / Härtung: PP-3, PP-4, PP-5, PP-6, PP-7, PP-12.
// Run: node test/r7b/r7b-platform-hardening.test.ts
//
//   §1 PP-3  KI auf PC2: Schlüssel bleibt am Primary, Erkennen über den Primary, Rest vor dem Klick gesperrt
//   §2 PP-4  Daueraufträge: Taktgeber am Tageswechsel, genau einmal (Nachholen, Neustart, Monatsgrenze, Pause)
//   §3 PP-5  Trennen/Sitzung: nur die eigene, kein Rest; Primary-Start glaubt keine fremde Sitzung
//   §4 PP-6  Primary-only: Riegel an der gemeinsamen Hauptbuch-Grenze und in jedem Maschinen-Handler
//   §5 PP-7  toter Alt-Code entfernt, Registry unverändert
//   §6 PP-12 Dokumentfristen: abgeleitet, Frist ≠ Erfolg, „läuft / Frist / erneut versuchen"
//
// Gefahren werden die ECHTEN Module (Generator, Hausfolge, Buchungsgrenze, Anmeldung, KI-Weiche) gegen
// eine echte sql.js-Datenbank mit dem echten Schema; gestellt sind nur Speichern, Netz und Uhr.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

const mem = new Map<string, string>([
  ['lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' })],
]);
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
};
let alerts: string[] = [];
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = {
  localStorage: storage, confirm: () => true, alert: (m: string) => { alerts.push(String(m)); },
};

const initSqlJs = (await import('sql.js')).default;
const SQL = await initSqlJs({ locateFile: (f: string) => resolvePath(repo, 'node_modules/sql.js/dist', f) });

const { setTestDatabase } = await import('../sync/_db-shim.ts');
const { COMMAND_LEDGER_DDL, COMMAND_LEDGER_INDEX } = await import('../../src/core/bridge/command-ledger.ts');
const { resetDurabilityStateForTest } = await import('../../src/core/bridge/durability-state.ts');
const { resetTransactionHealthForTest } = await import('../../src/core/db/transaction-health.ts');
const posting = await import('../../src/core/ledger/posting.ts');
const { A1_UPGRADE_SQL } = await import('../../src/core/db/a1-upgrade.ts');
const house = await import('../../src/core/payables/payables-house.ts');
const save = await import('../../src/core/payables/payables-save.ts');
const sched = await import('../../src/core/payables/recurring-scheduler.ts');
const { useRecurringExpenseStore } = await import('../../src/stores/recurringExpenseStore.ts');
const cm = await import('../../src/core/bridge/client-mode.ts');
const { authService } = await import('../../src/core/auth/auth.ts');
const only = await import('../../src/core/data/primary-only.ts');
const primaryAi = await import('../../src/core/ai/primary-ai.ts');
const avail = await import('../../src/core/ai/ai-availability.ts');
const { fehlertext } = await import('../../src/core/data/shared-write.ts');
const ocr = await import('../../src/core/ai/ocr-service.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
let sectionFails = 0;
const marker = (m: string): void => { if (fails.length === sectionFails) console.log(m); sectionFails = fails.length; };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const S = (v: unknown): string => JSON.stringify(v);

interface Db {
  run(sql: string, p?: unknown[]): unknown;
  exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
}
const one = (db: Db, sql: string, p: unknown[] = []): unknown => db.exec(sql, p)[0]?.values?.[0]?.[0];
const n = (db: Db, sql: string, p: unknown[] = []): number => Number(one(db, sql, p) ?? 0);

const NOW = '2026-06-15T10:00:00.000Z';
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
  db.run(COMMAND_LEDGER_DDL);
  db.run(COMMAND_LEDGER_INDEX);
  db.run("INSERT INTO branches (id, tenant_id, name, created_at, updated_at) VALUES ('branch-main','tenant-1','Haupt',?,?)", [NOW, NOW]);
  setTestDatabase(db as never);
  resetDurabilityStateForTest();
  resetTransactionHealthForTest();
  return db;
}
function inTx<T>(fn: () => T): T {
  posting.beginLedgerTransaction();
  try { const v = fn(); posting.commitLedgerTransaction(); return v; } catch (e) { posting.rollbackLedgerTransaction(); throw e; }
}
const alsClient = (token = 'tok-b'): void => {
  mem.set('lataif_runtime_mode', 'client'); mem.set('lataif_client_server_url', 'http://pc1:3011'); mem.set('lataif_client_token', token);
};
const alsPrimary = (): void => {
  mem.delete('lataif_runtime_mode'); mem.delete('lataif_client_server_url'); mem.delete('lataif_client_token');
  mem.set('lataif_session', JSON.stringify({ branchId: 'branch-main', userId: 'user-test' }));
};
type Req = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };
function fakeFetch(answer: (r: Req) => { status: number; body?: unknown } | Error) {
  const seen: Req[] = [];
  const fn = (async (url: string, init: Req['init'] = {}) => {
    const r = { url: String(url), init };
    seen.push(r);
    const a = answer(r);
    if (a instanceof Error) throw a;
    return { status: a.status, ok: a.status >= 200 && a.status < 300, json: async () => a.body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, seen };
}

// ══ §1 — PP-3: KI auf PC2 ════════════════════════════════════════════════════
{
  // a) Der Schlüssel: am Primary der eigene; auf PC2 NIE ein lokaler, auch wenn einer herumliegt.
  alsPrimary();
  mem.set('lataif_openai_key', 'sk-local-primary-key');
  const ai = await import('../../src/core/ai/ai-service.ts');
  ok(ai.getApiKey() === 'sk-local-primary-key' && ai.isAiConfigured(), 'KEY am Primary gilt der eigene Schlüssel (unverändert)');
  alsClient();
  mem.set('lataif_openai_key', 'sk-stale-left-on-pc2');
  ok(ai.getApiKey() === '' && !ai.isAiConfigured(), 'KEY auf PC2 wird KEIN lokaler Schlüssel benutzt — auch kein alter, der noch dort liegt');
  const aiSrc = codeOf(src('src/core/ai/ai-service.ts'));
  const gk = aiSrc.slice(aiSrc.indexOf('export function getApiKey()'), aiSrc.indexOf('export function setApiKey'));
  ok(gk.indexOf("if (isClientMode()) return '';") > 0 && gk.indexOf("if (isClientMode()) return '';") < gk.indexOf('_apiKeyCache'),
    'KEY die Weiche steht VOR jedem Zwischenspeicher — ein am Primary geladener Schlüssel wird auf PC2 nicht zurückgegeben');

  // b) Die Regel am Knopf: am Primary nichts Neues; auf PC2 vor dem Klick gesperrt, mit Grund.
  const g = avail.aiIdentifyGate;
  ok(!g(false, 'not_configured', false).disabled && !g(false, 'unreachable', false).disabled, 'GATE am Primary sperrt die Regel nichts (dort führt „Settings → AI")');
  const mat = [
    [g(true, 'checking', true), /Checking/], [g(true, 'not_configured', true), /not set up on the main computer/],
    [g(true, 'unreachable', true), /cannot be reached/], [g(true, 'ready', false), /from a photo/],
  ] as const;
  ok(mat.every(([x, re]) => x.disabled && re.test(String(x.reason))), `GATE PC2: prüfen / nicht eingerichtet / nicht erreichbar / kein Foto — gesperrt, jeweils mit Grund (${S(mat.map(([x]) => x.reason))})`);
  ok(!g(true, 'ready', true).disabled && !g(true, 'ready', true).reason, 'GATE PC2 mit KI am Primary und Foto: frei');

  // c) Die Frage VOR dem Klick: /api/ai/status am Primary, mit dem Ausweis von PC2.
  primaryAi.forgetPrimaryAiStatus();
  const st1 = fakeFetch(() => ({ status: 200, body: { identify: true } }));
  ok(await primaryAi.primaryAiStatus(st1.fn) === 'ready' && st1.seen[0]?.url === 'http://pc1:3011/api/ai/status'
    && st1.seen[0]?.init.headers?.Authorization === 'Bearer tok-b', `STATUS fragt den Primary mit dem Ausweis von PC2 (${S(st1.seen[0])})`);
  const st1b = fakeFetch(() => ({ status: 200, body: { identify: false } }));
  ok(await primaryAi.primaryAiStatus(st1b.fn) === 'ready' && st1b.seen.length === 0, 'STATUS die Antwort wird kurz gemerkt (kein Netz je Tastendruck)');
  ok(await primaryAi.primaryAiStatus(st1b.fn, true) === 'not_configured', 'STATUS Primary ohne Schlüssel → „not set up"');
  ok(await primaryAi.primaryAiStatus(fakeFetch(() => new Error('ECONNREFUSED')).fn, true) === 'unreachable', 'STATUS Primary weg → „cannot be reached"');
  mem.set('lataif_session', JSON.stringify({ token: 'tok-b', userId: 'b', branchId: 'branch-main' }));
  ok(await primaryAi.primaryAiStatus(fakeFetch(() => ({ status: 401 })).fn, true) === 'unreachable' && cm.clientConfig()?.token === null && !mem.has('lataif_session'),
    'STATUS ein verworfener Ausweis wird weggeworfen — samt der Sitzung daraus (PP-5)');

  // d) Das Erkennen: fachliche Anfrage an den Primary, SEIN Schlüssel, geprüfte Teilmenge zurück.
  alsClient('tok-b2');
  mem.set('lataif_openai_key', 'sk-stale-left-on-pc2');
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA==';
  const idf = fakeFetch(() => ({ status: 200, body: { result: {
    brand: 'Rolex', name: 'Submariner', condition: ' very good ', storage_location: 'Safe', scope_of_delivery: ['Box', ' ', 'Papers'],
    attributes: { reference_number: '126610LN', dial: '' }, price: 9999, purchase_price: 1, sku: 'X', quantity: 7,
  } } }));
  const res = await primaryAi.identifyViaPrimary({ categoryId: 'cat-watch', imageDataUrl: img, hints: { brand: 'Rolex', name: '', reference: '126610' } }, idf.fn);
  const req = idf.seen[0];
  const body = JSON.parse(String(req?.init.body || '{}'));
  ok(req?.url === 'http://pc1:3011/api/ai/identify' && req.init.method === 'POST' && req.init.headers?.Authorization === 'Bearer tok-b2',
    'IDENTIFY die Anfrage geht an den Primary (/api/ai/identify), mit dem Ausweis von PC2');
  ok(S(Object.keys(body).sort()) === S(['category_id', 'hints', 'image']) && body.hints === 'brand: Rolex\nreference: 126610' && body.image === img,
    `IDENTIFY nur die fachliche Anfrage: Kategorie, Foto-Bytes, Hinweise wie am Primary geschrieben (${S(Object.keys(body))})`);
  ok(!/sk-/.test(String(req?.init.body)) && !/sk-/.test(S(req?.init.headers)), 'SECRET kein Schlüssel verlässt PC2 — auch der dort herumliegende nicht');
  ok(res.brand === 'Rolex' && res.name === 'Submariner' && res.condition === 'very good' && res.storageLocation === 'Safe'
    && S(res.scopeOfDelivery) === S(['Box', 'Papers']) && S(res.attributes) === S({ reference_number: '126610LN' }),
    `IDENTIFY das Ergebnis in der Form der Masken (${S(res)})`);
  const r2 = res as unknown as Record<string, unknown>;
  ok(!('price' in r2) && !('purchasePrice' in r2) && !('sku' in r2) && !('quantity' in r2) && r2.estimatedValue === undefined,
    'IDENTIFY kein Preis, keine Menge, keine Kennung wird übernommen');
  let e503 = '';
  try { await primaryAi.identifyViaPrimary({ categoryId: 'cat-watch', imageDataUrl: img }, fakeFetch(() => ({ status: 503, body: { error: 'AI_NOT_CONFIGURED' } })).fn); }
  catch (e) { e503 = (e as Error).message; }
  ok(/not set up on the main computer/.test(e503), `IDENTIFY Primary ohne Schlüssel: ein lesbarer Satz, keine Rohmeldung (${e503})`);
  let e401 = '';
  try { await primaryAi.identifyViaPrimary({ categoryId: 'cat-watch', imageDataUrl: img }, fakeFetch(() => ({ status: 401 })).fn); }
  catch (e) { e401 = (e as Error).message; }
  ok(/sign in again/.test(e401) && cm.clientConfig()?.token === null, 'IDENTIFY abgelaufener Ausweis: verworfen, neu anmelden');

  // e) Die Weiche der Erkennung und die Knöpfe — am Quelltext.
  const ad = codeOf(src('src/core/ai/identify-adapter.ts'));
  const clientBranch = ad.slice(ad.indexOf('if (isClientMode()) {'), ad.indexOf('const resolved = await resolveAiImageInput(params.productId'));
  ok(/identifyViaPrimary\(/.test(clientBranch) && !/identifyProduct\(/.test(clientBranch), 'ADAPTER auf PC2 ruft der Adapter den Primary, nie den eigenen Anbieter');
  ok(/loadRemoteGallery\(productId\)/.test(ad) && /validateDurableBytes\(bytes, prim\.mimeType\)/.test(ad) && !/blob:/.test(clientBranch),
    'ADAPTER ein gespeicherter Artikel: das Hauptbild als geprüfte Bytes über die Medienroute — nie eine Anzeige-URL');
  const pa = src('src/core/ai/primary-ai.ts');
  ok(!/openai\.com|getApiKey|lataif_openai_key/.test(codeOf(pa)), 'SECRET der Fernweg kennt weder OpenAI noch einen Schlüssel');
  for (const f of ['src/components/products/NewProductModal.tsx', 'src/pages/watches/WatchList.tsx', 'src/pages/watches/ProductDetail.tsx', 'src/pages/consignments/ConsignmentList.tsx']) {
    const c = src(f);
    ok(/const aiGate = useAiIdentifyGate\(/.test(c) && /disabled=\{aiBusy \|\| aiGate\.disabled\}/.test(c) && /title=\{aiGate\.reason\}/.test(c)
      && /data-ai-reason/.test(c) && /if \(!aiGate\.client && !ai\.isAiConfigured\(\)\)/.test(c),
    `UI ${f}: AI Identify weiß VOR dem Klick, ob es geht, und sagt warum nicht`);
  }
  const pd = src('src/pages/watches/ProductDetail.tsx');
  ok(/disabled=\{aiLoading \|\| aiTextLocked\(\)\} title=\{aiTextLocked\(\) \? AI_TEXT_ON_PRIMARY : undefined\}/.test(pd), 'UI AI Price auf PC2 vor dem Klick gesperrt, mit Grund');
  const od = src('src/pages/offers/OfferDetail.tsx');
  ok(/disabled=\{aiTextLocked\(\)\}/.test(od) && /title=\{aiTextLocked\(\) \? AI_TEXT_ON_PRIMARY : undefined\}/.test(od), 'UI Angebotstext auf PC2 vor dem Klick gesperrt, mit Grund');
  const mp = codeOf(src('src/components/ai/MessagePreviewModal.tsx'));
  const gen = mp.slice(mp.indexOf('async function generate('), mp.indexOf('useEffect(() => {'));
  ok(/if \(aiLocked\) \{ setLoading\(false\); setError\(null\); return; \}/.test(gen) && gen.indexOf('if (aiLocked)') < gen.indexOf('ai-service'),
    'UI Nachricht: auf PC2 läuft beim Öffnen KEINE KI-Anfrage (die Weiche vor dem Laden des Anbieters)');
  ok(/disabled=\{loading \|\| aiLocked\}/.test(mp) && /data-ai-locked-note/.test(mp) && !/readsFromPrimary/.test(mp), 'UI Nachricht: „Regenerate" gesperrt, der Grund steht in der Maske; Text bleibt von Hand schreibbar');
  const app = src('src/App.tsx');
  ok(/path="\/ai" element=\{clientMode \? \(\s*<PrimaryOnlyNotice title="AI" reason=\{AI_PAGE_PRIMARY_ONLY\} \/>/.test(app), 'UI /ai auf PC2: die Route sagt es, statt nach der ersten Frage zu scheitern');
  const aip = codeOf(src('src/pages/ai/AIPage.tsx'));
  ok(/export function AIPage\(\) \{\s*if \(aiTextLocked\(\)\) return <PrimaryOnlyNotice/.test(aip), 'UI …und die Seite selbst ebenso');
  const rt = src('src-tauri/src/sync/routes.rs');
  ok(/\.route\("\/ai\/status", get\(ai_status_route\)\)/.test(rt) && /super::ai_route::key_present\(state\.data_root\.path\(\)\)/.test(rt), 'PRIMARY /api/ai/status: ja/nein aus demselben Schlüssel, im geschützten Bereich');
  alsPrimary(); mem.delete('lataif_openai_key');
}
marker('POST_PARITY_R7B_PP3_AI_PC2_FIXED');

// ══ §2 — PP-4: Daueraufträge am Tageswechsel ═════════════════════════════════
{
  // a) Der Taktgeber allein: Uhr und Lauf gestellt.
  let clock = new Date(2026, 8, 30, 23, 59, 0);
  const runs: string[] = [];
  let answer: { created: number; skipped: number; errors: string[] } = { created: 0, skipped: 0, errors: [] };
  let gate: Promise<void> | null = null;
  const s = sched.createDueScheduler({ now: () => clock, run: async (iso) => { runs.push(iso); if (gate) await gate; return answer; } });
  ok(sched.localDayKey(new Date(2026, 8, 30, 23, 59)) === '2026-09-30' && sched.localDayKey(new Date(2026, 9, 1, 0, 0, 30)) === '2026-10-01', 'TAKT der Tag ist der örtliche Kalendertag (wie die Monate des Generators)');
  ok(await s.tick() === 'ran' && await s.tick() === 'already-done-today' && runs.length === 1, 'TAKT einmal je Tag — der zweite Takt am selben Tag läuft nicht');
  clock = new Date(2026, 9, 1, 0, 0, 30);
  ok(await s.tick() === 'ran' && runs.length === 2 && new Date(runs[1]).getTime() === clock.getTime(), 'TAKT der Tageswechsel löst den Lauf aus — mit genau DIESER Uhr');
  clock = new Date(2026, 9, 2, 8, 0); answer = { created: 0, skipped: 0, errors: ['busy: another action is open'] };
  ok(await s.tick() === 'ran' && s.doneDay() === '2026-10-01', 'TAKT ein nicht fertiger Lauf schließt den Tag NICHT');
  answer = { created: 0, skipped: 0, errors: [] };
  ok(await s.tick() === 'ran' && s.doneDay() === '2026-10-02' && runs.length === 4, 'TAKT …der nächste Takt versucht es wieder');
  clock = new Date(2026, 9, 3, 8, 0);
  let release: () => void = () => {};
  gate = new Promise<void>((r) => { release = r; });
  const first = s.tick();
  ok(await s.tick() === 'overlap', 'TAKT zwei Takte überholen sich nicht');
  release(); gate = null;
  ok(await first === 'ran' && runs.length === 5, 'TAKT …der laufende endet regulär');
  const tRun = sched.createDueScheduler({ now: () => clock, run: async () => { throw new Error('boom'); } });
  ok(await tRun.tick() === 'ran' && tRun.doneDay() === null, 'TAKT ein Wurf im Lauf ist „nicht erledigt", kein Absturz');

  // b) Der echte Generator unter dem Taktgeber — Nachholen, Neustart, Monatsgrenze, Pause, Storno.
  alsPrimary();
  let db = freshDb();
  const created = inTx(() => house.createTemplateInHouse(house.templateCreateIntent({
    category: 'Rent', amount: 100, paymentMethod: 'bank', payNowDefault: false, dayOfMonth: 10, startDate: '2026-06-10',
  }), { branchId: 'branch-main', userId: 'user-test', now: new Date(2026, 5, 15, 10, 0).toISOString() }));
  const tid = created.templateId;
  const months = (): string[] => (db.exec('SELECT expense_date, status FROM expenses WHERE recurring_template_id = ? ORDER BY expense_date', [tid])[0]?.values ?? []).map((v) => `${String(v[0]).slice(0, 7)}${v[1] === 'CANCELLED' ? '×' : ''}`);
  ok(S(months()) === S(['2026-06']), `SETUP die Vorlage legt Juni an (${S(months())})`);
  let uhr = new Date(2026, 8, 12, 9, 0);
  const realRun = (iso: string) => save.runDueGeneratorOnPrimary(iso);
  let g1 = sched.createDueScheduler({ now: () => uhr, run: realRun });
  ok(await g1.tick() === 'ran' && S(months()) === S(['2026-06', '2026-07', '2026-08', '2026-09']), `OVERDUE der Primary lief über drei Monatswechsel — EIN Takt holt Juli, August, September nach (${S(months())})`);
  ok(one(db, 'SELECT last_generated_period FROM recurring_expense_templates WHERE id = ?', [tid]) === '2026-09', 'OVERDUE der Monatszeiger steht mit den Ausgaben');
  uhr = new Date(2026, 8, 12, 18, 0);
  ok(await g1.tick() === 'already-done-today' && months().length === 4, 'ONCE derselbe Tag: kein zweiter Lauf');
  uhr = new Date(2026, 8, 13, 9, 0);
  ok(await g1.tick() === 'ran' && months().length === 4, 'ONCE der nächste Tag läuft — und findet nichts Doppeltes');
  // Neustart: die Datei, wie sie auf der Platte steht, frisch geöffnet; ein neuer Taktgeber ohne Gedächtnis.
  db = new SQL.Database(db.export()) as unknown as Db;
  setTestDatabase(db as never); resetDurabilityStateForTest(); resetTransactionHealthForTest();
  const g2 = sched.createDueScheduler({ now: () => uhr, run: realRun });
  ok(await g2.tick() === 'ran' && months().length === 4, 'RESTART nach dem Neustart erzeugt der erste Takt nichts doppelt (der Zeiger ist mit den Ausgaben durabel)');
  // Monatsgrenze in Ortszeit: 30. September 23:59 nichts, 1. Oktober 00:00:30 der Oktober.
  uhr = new Date(2026, 8, 30, 23, 59, 0);
  ok(await g2.tick() === 'ran' && months().length === 4, 'BOUNDARY 30.09. 23:59 — noch kein Oktober');
  uhr = new Date(2026, 9, 1, 0, 0, 30);
  ok(await g2.tick() === 'ran' && S(months().slice(-1)) === S(['2026-10']), `BOUNDARY 01.10. 00:00 — der Oktober entsteht im ersten Takt des neuen Tages (${S(months())})`);
  // Ein stornierter Monat wird NICHT neu angelegt (der Zeiger, nicht nur die Monatsprüfung).
  db.run("UPDATE expenses SET status = 'CANCELLED' WHERE recurring_template_id = ? AND substr(expense_date, 1, 7) = '2026-10'", [tid]);
  uhr = new Date(2026, 9, 2, 9, 0);
  ok(await g2.tick() === 'ran' && S(months().filter((m) => m.startsWith('2026-10'))) === S(['2026-10×']), 'ONCE ein stornierter Monat kommt nicht wieder');
  // Pause: die Monate der Pause entstehen nicht; Resume holt sie nicht nach, nur den laufenden Monat.
  const rev = (): number => n(db, 'SELECT revision FROM recurring_expense_templates WHERE id = ?', [tid]);
  inTx(() => house.updateTemplateInHouse(tid, house.templateEditFields({ active: false }), { branchId: 'branch-main', userId: 'user-test', now: uhr.toISOString() }, rev()));
  for (const d of [new Date(2026, 10, 1, 8, 0), new Date(2026, 11, 1, 8, 0)]) { uhr = d; await g2.tick(); }
  ok(!months().some((m) => m.startsWith('2026-11') || m.startsWith('2026-12')), `PAUSE November und Dezember entstehen nicht, solange pausiert (${S(months())})`);
  uhr = new Date(2026, 11, 5, 9, 0);
  const resumed = inTx(() => house.updateTemplateInHouse(tid, house.templateEditFields({ active: true }), { branchId: 'branch-main', userId: 'user-test', now: uhr.toISOString() }, rev()));
  uhr = new Date(2026, 11, 6, 9, 0);
  await g2.tick();
  ok(resumed.resumed === true && !months().includes('2026-11') && months().filter((m) => m === '2026-12').length === 1, `RESUME holt die Pause nicht nach — nur Dezember, genau einmal (${S(months())})`);
  // Eine offene fremde Klammer: der Lauf schreibt nicht hinein und meldet „nicht fertig".
  posting.beginLedgerTransaction();
  const busy = useRecurringExpenseStore.getState().runDueGenerator(new Date(2027, 0, 1, 9, 0).toISOString());
  posting.rollbackLedgerTransaction();
  ok(busy.created === 0 && busy.errors.some((e) => /busy/.test(e)) && !months().some((m) => m.startsWith('2027')), 'BUSY in eine offene Klammer wird nicht geschrieben — und der Tag bleibt offen');
  g1 = sched.createDueScheduler({ now: () => new Date(2027, 0, 1, 9, 0), run: realRun });
  ok(await g1.tick() === 'ran' && months().filter((m) => m === '2027-01').length === 1, 'BUSY …der nächste Takt legt den Januar genau einmal an');
  ok(n(db, `SELECT COUNT(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
      HAVING ROUND(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 3) <> 0)`) === 0, 'LEDGER jede Transaktion ausgeglichen');
  // c) Verdrahtung: nur am Primary, in der Schreibreihenfolge, beim Start UND am Tageswechsel.
  const app = codeOf(src('src/App.tsx'));
  ok(/import\('@\/core\/payables\/payables-save'\)\.then\(m => m\.runDueGeneratorOnPrimary\(\)\)/.test(app) && !/getState\(\)\.runDueGenerator\(\)/.test(app),
    'WIRE der Start läuft in der Schreibreihenfolge und durabel (vorher an der Warteschlange vorbei)');
  const boot = app.slice(app.indexOf('function bootDatabase()'), app.indexOf('.catch(err =>'));
  ok(/m\.startRecurringExpenseScheduler\(\)/.test(boot) && boot.indexOf('startRecurringExpenseScheduler') > boot.indexOf('initAutomation()'), 'WIRE der Taktgeber startet mit der Automatik des Primary');
  const sc = codeOf(src('src/core/payables/recurring-scheduler.ts'));
  ok(/if \(started \|\| isClientMode\(\)\) return;/.test(sc) && /runDueGeneratorOnPrimary\(nowIso\)/.test(sc) && !/generateDueForTemplate|INSERT INTO/.test(sc),
    'WIRE einmal je Fenster, nie auf PC2, und ohne eigene Regel (derselbe Generator)');
}
marker('POST_PARITY_R7B_PP4_RECURRING_EXPENSE_SCHEDULER_FIXED');

// ══ §3 — PP-5: Trennen und Sitzung ═══════════════════════════════════════════
{
  alsClient('tok-c');
  mem.set('lataif_session', JSON.stringify({ token: 'tok-c', userId: 'b', branchId: 'branch-main' }));
  cm.setClientToken(null);
  ok(!mem.has('lataif_client_token') && !mem.has('lataif_session') && mem.get('lataif_client_server_url') === 'http://pc1:3011',
    'SESSION ein verworfener Ausweis nimmt die Sitzung daraus mit; die Adresse bleibt (wieder anmelden)');
  alsClient('tok-d');
  mem.set('lataif_session', JSON.stringify({ token: 'tok-d', userId: 'b', branchId: 'branch-main' }));
  mem.set('lataif_openai_key', 'unrelated');
  cm.leaveClientMode();
  ok(!mem.has('lataif_runtime_mode') && !mem.has('lataif_client_server_url') && !mem.has('lataif_client_token') && !mem.has('lataif_session'),
    'DISCONNECT Trennen löscht Modus, Adresse, Ausweis UND die Sitzung — es bleibt nichts, was jemanden anmeldet');
  ok(mem.get('lataif_openai_key') === 'unrelated', 'DISCONNECT …und nur das (fremde Einträge bleiben)');
  mem.delete('lataif_openai_key');

  // Primary-Start: eine gespeicherte Sitzung gilt nur, wenn DIESE Datenbank sie ausgestellt hat.
  const db = freshDb();
  /** Eine Zeile mit allen NOT-NULL-Spalten, damit der Test nicht an einer Schema-Kleinigkeit scheitert. */
  const insert = (table: string, values: Record<string, unknown>): void => {
    const cols = (db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((v) => ({ name: String(v[1]), type: String(v[2] || ''), notnull: Number(v[3]), dflt: v[4], pk: Number(v[5]) }));
    const data: Record<string, unknown> = { ...values };
    for (const c of cols) {
      if (!c.notnull || c.dflt !== null || c.pk || data[c.name] !== undefined) continue;
      data[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (c.name === 'tenant_id' ? 'tenant-1' : (/_at$|date/i.test(c.name) ? NOW : ''));
    }
    const use = Object.keys(data).filter((k) => cols.some((c) => c.name === k));
    db.run(`INSERT INTO ${table} (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`, use.map((k) => data[k]));
  };
  insert('users', { id: 'u-a', email: 'a@x', password_hash: 'h', name: 'A', active: 1, created_at: NOW, updated_at: NOW });
  insert('users', { id: 'u-off', email: 'o@x', password_hash: 'h', name: 'O', active: 0, created_at: NOW, updated_at: NOW });
  insert('user_branches', { user_id: 'u-a', branch_id: 'branch-main', role: 'owner', is_default: 1, created_at: NOW });
  insert('user_branches', { user_id: 'u-off', branch_id: 'branch-main', role: 'owner', is_default: 1, created_at: NOW });
  insert('sessions', { id: 's1', user_id: 'u-a', branch_id: 'branch-main', token: 't-own', expires_at: '2099-01-01', created_at: NOW });
  insert('sessions', { id: 's2', user_id: 'u-off', branch_id: 'branch-main', token: 't-off', expires_at: '2099-01-01', created_at: NOW });
  const put = (s: unknown): void => { (authService as unknown as { currentSession: unknown }).currentSession = null; mem.set('lataif_session', typeof s === 'string' ? s : JSON.stringify(s)); };
  const base = { user: { id: 'u-a', email: 'a@x', name: 'A' }, branch: { id: 'branch-main', name: 'Haupt', country: 'BH', currency: 'BHD' } };
  put({ ...base, token: 't-own', userId: 'u-a', branchId: 'branch-main', role: 'viewer' });
  const kept = authService.verifyStoredSession();
  ok(kept === 'kept' && JSON.parse(mem.get('lataif_session') || '{}').role === 'owner' && authService.getSession()?.role === 'owner',
    'START die eigene Sitzung bleibt — mit der Rolle von JETZT (user_branches), nicht der des Merkzettels');
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLWIiLCJicmFuY2hfaWQiOiJicmFuY2gteCIsInJvbGUiOiJvd25lciJ9.sig';
  put({ ...base, token: jwt, userId: 'user-b', branchId: 'branch-x', role: 'owner' });
  ok(authService.verifyStoredSession() === 'dropped' && !mem.has('lataif_session') && authService.getSession() === null,
    'START die Sitzung eines FREMDEN Primary (vorher PC2) wird verworfen — keine Eigentümerrechte ohne Anmeldung');
  put({ ...base, token: 't-off', userId: 'u-off', branchId: 'branch-main', role: 'owner' });
  ok(authService.verifyStoredSession() === 'dropped', 'START ein deaktivierter Benutzer: verworfen');
  put({ ...base, token: 't-own', userId: 'u-a', branchId: 'branch-other', role: 'owner' });
  ok(authService.verifyStoredSession() === 'dropped', 'START eine Filiale, die der Benutzer nicht (mehr) hat: verworfen');
  put({ ...base, token: 't-own', userId: 'u-off', branchId: 'branch-main', role: 'owner' });
  ok(authService.verifyStoredSession() === 'dropped', 'START ein Token, das einem ANDEREN Benutzer gehört: verworfen');
  put('{kaputt');
  ok(authService.verifyStoredSession() === 'dropped' && !mem.has('lataif_session'), 'START ein unlesbarer Merkzettel: verworfen');
  mem.delete('lataif_session');
  ok(authService.verifyStoredSession() === 'none', 'START ohne Merkzettel: nichts zu tun');

  const app = codeOf(src('src/App.tsx'));
  const boot = app.slice(app.indexOf('function bootDatabase()'), app.indexOf('.catch(err =>'));
  ok(boot.indexOf('authService.verifyStoredSession()') > 0 && boot.indexOf('authService.verifyStoredSession()') < boot.indexOf('initialize();'),
    'WIRE der Primary prüft die gespeicherte Sitzung, BEVOR die Anwendung sie übernimmt');
  ok(/\} else if \(token\) \{\s*setClientToken\(null\);/.test(app) && /return true;\s*\}\s*setClientToken\(null\);\s*return false;/.test(app),
    'WIRE ein Ausweis ohne brauchbare Sitzung wird verworfen (Start und Anmeldung) — kein halber Zwischenzustand');
  const st = codeOf(src('src/stores/authStore.ts'));
  const lo = st.slice(st.indexOf('logout: () => {'), st.indexOf('switchBranch:', st.indexOf('logout: () => {')));
  ok(/if \(readsFromPrimary\(\)\) \{\s*resetPrimarySource\(\);\s*try \{ window\.location\.reload\(\); \}/.test(lo),
    'WIRE Abmelden auf PC2: laufende Fernladungen vergessen, das Fenster neu — die nächste Anmeldung ohne Rest der vorigen');
  const sh = src('src/components/startup/ClientShell.tsx');
  ok(/data-client-disconnect/.test(sh) && /leaveClientMode\(\); window\.location\.reload\(\);/.test(sh), 'WIRE „Disconnect" trennt über dieselbe eine Funktion');
  // Der Server führt keine Sitzung, die zu schließen wäre: zustandsloser Ausweis, jede Anfrage neu geprüft.
  const rs = src('src-tauri/src/sync/routes.rs');
  ok(!/\/auth\/logout|\/session/.test(codeOf(rs).slice(0, codeOf(rs).indexOf('#[cfg(test)]'))) && /keine Widerrufsliste, keine/.test(src('src-tauri/src/sync/reauthorize.rs')),
    'SERVER keine Sitzungsliste am Primary — Trennen hat dort nichts zu entfernen und keine andere Sitzung zu beschädigen');
  alsPrimary();
}
marker('POST_PARITY_R7B_PP5_DISCONNECT_SESSION_FIXED');

// ══ §4 — PP-6: Primary-only-Riegel ═══════════════════════════════════════════
{
  alsPrimary(); alerts = [];
  ok(only.blockPrimaryOnlyOnClient('Ledger backfill') === false && alerts.length === 0, 'GUARD am Primary: kein Riegel, keine Meldung');
  let threw = false; try { only.assertPrimaryOnly('Changing settings'); } catch { threw = true; }
  ok(!threw, 'GUARD am Primary: der Schreibhelfer läuft');
  alsClient();
  ok(only.blockPrimaryOnlyOnClient('Ledger backfill') === true && /Ledger backfill is only available on the main computer/.test(alerts[0] || ''), 'GUARD auf PC2: gesperrt und gesagt');
  threw = false; try { only.assertPrimaryOnly('Changing settings'); } catch (e) { threw = /PRIMARY_ONLY/.test((e as Error).message); }
  ok(threw, 'GUARD auf PC2: der Schreibhelfer wirft, statt zu schreiben');

  // Die gemeinsame Grenze: auf PC2 schreibt KEINE Buchung — auch mit einer Datenbank im Rücken.
  const db = freshDb();
  const vorher = n(db, 'SELECT COUNT(*) FROM ledger_entries');
  const watch = posting.watchLedgerPosts('probe');
  const codes: string[] = [];
  for (const f of [
    () => posting.postEntries([{ account: 'CASH', direction: 'DEBIT', amount: 1 }, { account: 'REVENUE', direction: 'CREDIT', amount: 1 }] as never, { sourceModule: 'EXPENSE', sourceId: 'x', occurredAt: NOW } as never),
    () => posting.reverseSource('EXPENSE' as never, 'x', NOW),
    () => posting.reverseTransaction('tx-1', NOW),
    () => posting.postExpense({ id: 'e1', branchId: 'branch-main', category: 'Rent', amount: 5, status: 'PENDING', expenseDate: '2026-06-01' } as never),
  ]) { try { f(); codes.push('NO-THROW'); } catch (e) { codes.push(/CLIENT_HAS_NO_BOOKS/.test((e as Error).message) ? 'REFUSED' : (e as Error).message.slice(0, 60)); } }
  ok(codes.every((c) => c === 'REFUSED'), `LEDGER auf PC2 verweigern postEntries, reverseSource, reverseTransaction und jede post*-Funktion (${S(codes)})`);
  ok(n(db, 'SELECT COUNT(*) FROM ledger_entries') === vorher, 'LEDGER …und es steht keine Zeile im Hauptbuch');
  let counted = false; try { watch(); } catch { counted = true; }
  ok(counted, 'LEDGER der Riegel zählt als gescheiterte Buchung — eine Hausfolge fiele ganz zurück');
  alsPrimary();

  const pages: Array<[string, string, string]> = [
    ['src/pages/settings/SettingsPage.tsx', 'SettingsPage', 'Settings'],
    ['src/pages/reports/BackfillPage.tsx', 'BackfillPage', 'Ledger backfill'],
    ['src/pages/settings/LedgerDebugPage.tsx', 'LedgerDebugPage', 'Ledger debug'],
    ['src/pages/admin/RepairFlowTestPage.tsx', 'RepairFlowTestPage', 'Repair flow test'],
    ['src/pages/admin/RepairReconcilePage.tsx', 'RepairReconcilePage', 'Repair reconcile'],
  ];
  for (const [f, name, title] of pages) {
    const c = codeOf(src(f));
    const re = new RegExp(`export function ${name}\\(\\) \\{\\s*if \\(primaryOnlyLocked\\(\\)\\) \\{\\s*return <PrimaryOnlyNotice title="${title}"[^]*?return <${name}Body />;`);
    ok(re.test(c) && new RegExp(`function ${name}Body\\(\\)`).test(c), `PAGE ${name}: prüft selbst, wo sie läuft — auf PC2 wird kein Handler eingehängt`);
  }
  const bf = codeOf(src('src/pages/reports/BackfillPage.tsx'));
  const wb = bf.slice(bf.indexOf('function withBranch('), bf.indexOf('function runAll()'));
  const ra = bf.slice(bf.indexOf('function runAll()'), bf.indexOf('const totals'));
  ok(wb.indexOf("blockPrimaryOnlyOnClient('Ledger backfill')") > 0 && wb.indexOf("blockPrimaryOnlyOnClient('Ledger backfill')") < wb.indexOf('fn(branchId)')
    && ra.indexOf("blockPrimaryOnlyOnClient('Ledger backfill')") > 0 && ra.indexOf("blockPrimaryOnlyOnClient('Ledger backfill')") < ra.indexOf('backfillAll('),
  'HANDLER Nachbuchung: der Riegel vor jeder der 20 Nachbuchungen');
  const rf = codeOf(src('src/pages/admin/RepairFlowTestPage.tsx'));
  const rfa = rf.slice(rf.indexOf('async function runAll()'), rf.indexOf('setRunning(true);', rf.indexOf('async function runAll()')) + 1);
  const rfp = rf.slice(rf.indexOf('function handlePurge()'), rf.indexOf('purgeTestData();', rf.indexOf('function handlePurge()')));
  ok(/blockPrimaryOnlyOnClient\('The repair flow test'\)/.test(rfa) && /blockPrimaryOnlyOnClient\('Purging test data'\)/.test(rfp), 'HANDLER Reparatur-Prüfstand: Lauf und Aufräumen mit Riegel vor dem ersten Schreiben');
  const rc = codeOf(src('src/pages/reports/ReconciliationPage.tsx'));
  const orphan = rc.slice(rc.indexOf('{!readsFromPrimary() && <Button'), rc.indexOf('Storniere alle Orphans'));
  ok(orphan.indexOf("blockPrimaryOnlyOnClient('Cancelling orphan postings')") > 0 && orphan.indexOf("blockPrimaryOnlyOnClient('Cancelling orphan postings')") < orphan.indexOf('reverseSource('),
    'HANDLER Orphan-Storno: Riegel im Handler, nicht nur Ausblenden');
  const sp = codeOf(src('src/pages/settings/SettingsPage.tsx'));
  const ss = sp.slice(sp.indexOf('function setSetting('), sp.indexOf('function SectionTitle'));
  ok(ss.indexOf("assertPrimaryOnly('Changing settings')") > 0 && ss.indexOf("assertPrimaryOnly('Changing settings')") < ss.indexOf('getDatabase()'), 'HANDLER Einstellungen: der Schreibhelfer wirft auf PC2 vor dem Datenbankgriff');
  const pc = codeOf(src('src/core/ledger/posting.ts'));
  for (const fn of ['export function postEntries(', 'export function reverseSource(', 'export function reverseTransaction(']) {
    const body = pc.slice(pc.indexOf(fn), pc.indexOf('\n}\n', pc.indexOf(fn)));
    ok(/try \{\s*assertLedgerHere\(\);/.test(body), `BOUNDARY ${fn.replace('export function ', '').replace('(', '')}: der Riegel als erste Anweisung`);
  }
  const app = src('src/App.tsx');
  ok(['Ledger backfill', 'Settings', 'Import', 'Ledger debug'].every((t) => new RegExp(`clientMode \\? \\(\\s*<PrimaryOnlyNotice\\s+title="${t}"`).test(app)), 'ROUTE die bisherigen Routenweichen bleiben (Riegel zusätzlich, nicht statt)');
  const reg = src('src/core/bridge/command-registry.ts');
  ok(!/'(settings|backfill|ledger|reconcil|orphan|repair_flow)[^']*'/.test(reg.slice(reg.indexOf('ALLOWED_MUTATIONS'), reg.indexOf('export interface CommandSpec'))), 'SCOPE keine neue Fernfähigkeit für Maschinenhandlungen');
}
marker('POST_PARITY_R7B_PP6_PRIMARY_ONLY_GUARDS_FIXED');

// ══ §5 — PP-7: toter Alt-Code ════════════════════════════════════════════════
{
  ok(!existsSync(resolvePath(repo, 'src/components/client')), 'DEAD der alte Client-Bereich (`components/client`, 14 Dateien) ist entfernt');
  const walk = (d: string): string[] => readdirSync(resolvePath(repo, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${d}/${e.name}`] : []));
  const refs = walk('src').filter((f) => /components\/client\//.test(codeOf(src(f))));
  ok(refs.length === 0, `DEAD kein Import, kein Lazy-Import, kein Verweis mehr (${refs.join(', ')})`);
  const sh = codeOf(src('src/components/startup/ClientShell.tsx'));
  ok(!/remoteRead\(|data-client-area|data-client-mode|ClientInvoiceCreate|useCallback/.test(sh) && /data-client-signin/.test(sh) && /data-client-email/.test(sh),
    'DEAD ClientShell führt nur noch zur Anmeldung — dieselben Felder, kein Nebenweg');
  const inv = codeOf(src('src/pages/invoices/InvoiceDetail.tsx'));
  ok(!/\[editing, setEditing\]|setEditing\(|editing \?|handleSaveEdit|saveLines|linesModal|lineDraft|updateInvoice\(|editInvoice\(/.test(inv), 'DEAD der nie betretene Bearbeitungszweig der Rechnungsansicht ist entfernt (Bearbeiten: InvoiceCreate)');
  ok(/navigate\(`\/invoices\/\$\{invoice\.id\}\/edit`\)/.test(inv) && /setPaymentsModal\(true\)/.test(inv), 'DEAD …der lebende Weg (Edit → InvoiceCreate, Zahlungen) bleibt');
  const callers = walk('src').filter((f) => /resetPrimarySource\(\)/.test(codeOf(src(f))) && !/primary-source\.ts$/.test(f));
  ok(S(callers) === S(['src/stores/authStore.ts']), `WIRED resetPrimarySource hat jetzt seinen Aufrufer (Abmelden auf PC2) (${S(callers)})`);
  const ccs = walk('src').filter((f) => /clearClientSession\(\)/.test(codeOf(src(f))) && !/client-session\.ts$/.test(f));
  ok(S(ccs) === S(['src/core/bridge/client-mode.ts']), `WIRED clearClientSession hängt am Trennen und am Verwerfen des Ausweises (${S(ccs)})`);
  const rust = src('src-tauri/src/bridge.rs');
  const rl = rust.slice(rust.indexOf('pub const REMOTE_OPS'), rust.indexOf('];', rust.indexOf('pub const REMOTE_OPS')));
  ok((rl.match(/OP_[A-Z_]+/g) ?? []).length === 175, 'REGISTRY unverändert 175 (TS == Rust; R7B fügt keinen Fernbefehl hinzu)');
}
marker('POST_PARITY_R7B_PP7_DEAD_CODE_REMOVED');

// ══ §6 — PP-12: Dokumentfristen ══════════════════════════════════════════════
{
  const t = fehlertext({ kind: 'unknown', code: 'BRIDGE_TIMEOUT' } as never);
  ok(/did not finish within the time limit/.test(t) && /may still be working/.test(t) && /can never happen twice/.test(t) && !/No answer from the primary/.test(t),
    `UI eine abgelaufene Frist heißt „läuft vielleicht noch", nicht „keine Antwort" (${t})`);
  const u = fehlertext({ kind: 'unknown', code: 'SERVER_UNAVAILABLE' } as never);
  ok(/No answer from the primary/.test(u) && /not clear whether/.test(u), 'UI ein nicht erreichbarer Primary bleibt „keine Antwort"');
  ok(!/saved\b.*successfully|Saved!/.test(t), 'UI Frist ≠ Erfolg');
  const a = ocr.ocrTargetSize(4000, 3000), b = ocr.ocrTargetSize(8000, 6000), c = ocr.ocrTargetSize(20000, 1000);
  ok(!a.scaled && b.scaled && b.width * b.height <= ocr.OCR_MAX_PIXELS && Math.abs(b.width / b.height - 4 / 3) < 0.01 && c.scaled && c.width * c.height <= ocr.OCR_MAX_PIXELS,
    `OCR bis 12 MP unverändert, darüber maßstabsgleich darunter (${S([a, b, c])})`);
  ok(ocr.OCR_MAX_PIXELS === 12_000_000 && /pub const OCR_MAX_PIXELS: u64 = 12_000_000;/.test(src('src-tauri/src/bridge.rs')), 'OCR dieselbe Grenze, aus der die Frist abgeleitet ist (TS == Rust)');
  const os = codeOf(src('src/core/ai/ocr-service.ts'));
  ok(/const bounded = await boundedOcrInput\(input\)\.catch\(\(\) => input\);/.test(os) && /tesseract\.recognize\(bounded as never/.test(os), 'OCR die Erkennung bekommt das begrenzte Bild');
  const br = src('src-tauri/src/bridge.rs');
  // R7B-Review: die Frist kennt seitdem auch die Größe der Datenbank (nur die schreibenden Dokumentwege).
  ok(/pub fn timeout_for\(op: &str, payload: &serde_json::Value, db_bytes: u64\) -> Duration/.test(br) && /_ => DEFAULT_TIMEOUT,/.test(br), 'BRIDGE je Auftrag eine Frist, alles Normale bleibt 20 s');
  const dl = src('src/pages/documents/DocumentList.tsx');
  ok(/data-document-upload-running/.test(dl) && /`Uploading… \$\{uploadSeconds\}s`/.test(dl) && /`Extracting… \$\{ocrSeconds\}s`/.test(dl) && /\.finally\(\(\) => setOcrRunning\(false\)\)/.test(dl),
    'UI „läuft": Upload und Erkennung zeigen, seit wann');
  ok(/data-document-preview-error/.test(dl) && /data-document-preview-retry/.test(dl) && /setPreviewTick\(\(t\) => t \+ 1\)/.test(dl) && /data-document-preview-loading/.test(dl),
    'UI „erneut versuchen": eine nicht geladene Vorschau sagt es und bietet den Knopf — kein leeres Feld');
  const cs = src('src/core/bridge/client-command-save.ts');
  ok(/504/.test(cs) && /BRIDGE_TIMEOUT/.test(cs), 'CLIENT 504 bleibt der offene Ausgang (dieselbe Kennung beim erneuten Klick)');
}
marker('POST_PARITY_R7B_PP12_DOCUMENT_TIMEOUT_FIXED');

console.log(`\nr7b platform hardening: ${PASS} passed, ${fails.length} failed`);
if (fails.length === 0) console.log('POST_PARITY_R7B_UNIT_PROVED');
process.exit(fails.length ? 1 : 0);

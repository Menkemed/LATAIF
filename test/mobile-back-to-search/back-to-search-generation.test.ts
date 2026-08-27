// ════════════════════════════════════════════════════════════════════════════
// v0.8.50 — G1: "Back to search" waehrend ein Save-Bestaetigungsread laeuft.
// Run: node test/mobile-back-to-search/back-to-search-generation.test.ts
//
// Live auf PROD gefunden (v0.8.49): Artikel oeffnen → speichern → sofort auf die Trefferliste
// zurueck → Sekunden spaeter klappte die Detailansicht UNTER der Liste wieder auf, samt
// verspaeteter Meldung. Ursache war nicht der Wartemechanismus selbst, sondern dass niemand ihm
// sagte, dass es seine Ansicht nicht mehr gibt: `backToSearch()` drehte `pageGen.view` nicht
// weiter, also blieb die Abbruchbedingung falsch — und `showProduct` zeigt `scanResult` wieder
// an, ohne `searchPane` zu verstecken. Beides gleichzeitig sichtbar.
//
// Dieser Test spielt genau diesen Ablauf mit den ECHTEN Funktionen der ausgelieferten Seite
// durch: der Lesevorgang wird absichtlich in der Luft gehalten, waehrenddessen wird
// zurueckgegangen, und ERST DANN kommt die alte Antwort — und zwar eine, die bestaetigen wuerde.
// Die Negativkontrolle nimmt der Seite genau das eine Hochzaehlen wieder weg und verlangt, dass
// derselbe Ablauf dann wieder den Live-Fehler zeigt.
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };

const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');

/** Eine benannte Funktion samt Rumpf aus der Seite schneiden — inklusive eines fuehrenden `async`. */
const cut = (src: string, name: string): string => {
  let from = src.indexOf('function ' + name + '(');
  if (from < 0) throw new Error('not found: ' + name);
  if (src.slice(from - 6, from) === 'async ') from -= 6;
  let d = 0, to = -1, seen = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { d++; seen = true; } else if (c === '}') { d--; if (seen && d === 0) { to = i + 1; break; } }
  }
  if (to < 0) throw new Error('unbalanced: ' + name);
  return src.slice(from, to);
};

// ── Das Modell, mit dem der Test rechnet, muss der Seite entsprechen ──────
//
// Der Test ersetzt `showProduct` durch eine Attrappe. Damit die Beobachtung etwas wert ist, muss
// die Attrappe das tun, was das Original tut — und das Original tut genau zwei Dinge, auf die es
// hier ankommt: es zeigt `scanResult` wieder an, und es versteckt `searchPane` NICHT.
const showProductSrc = cut(page, 'showProduct');
ok(showProductSrc.includes("show('scanResult');"), 'MODEL showProduct really shows the detail pane');
ok(!showProductSrc.includes("hide('searchPane')"),
  'MODEL …and really does not hide the search pane — that is why the detail appeared UNDER the list');
ok(cut(page, 'openHit').includes("hide('searchPane');"),
  'MODEL only opening a hit hides the search pane');

// ── Der Prueftisch: echte `backToSearch` + echte `showSavedState` ─────────
type El = {
  id: string; value: string; innerHTML: string; textContent: string;
  style: Record<string, string>; focus(): void;
  classList: { add(c: string): void; remove(c: string): void };
  insertAdjacentHTML(where: string, html: string): void;
};
type Harness = {
  backToSearch: () => void;
  showSavedState: (id: string, expected: unknown, msg: unknown, opts: unknown) => Promise<boolean>;
  findMode: (mode: string) => void;
  lookupProduct: (sku: string) => Promise<void>;
  loadChecks: (productId: string) => Promise<void>;
};

const SHOW = /const show = \(id\) => \$\(id\)\.classList\.remove\('hidden'\);/;
const HIDE = /const hide = \(id\) => \$\(id\)\.classList\.add\('hidden'\);/;
ok(SHOW.test(page) && HIDE.test(page), 'MODEL the page defines show/hide as one-liners over a "hidden" class');

const build = (src: string, deps: Record<string, unknown>, names: string[] = ['backToSearch', 'showSavedState']): Harness => {
  const body = [
    'const { $, renderHits, releaseMedia, showProduct, read, patchApplied, galleryAddsNewPhotos, document, window } = deps;',
    'const { fetch, localStorage, renderChecks, stopScan, startScan, setText, TOKEN_KEY } = deps;',
    (SHOW.exec(src) as RegExpExecArray)[0],
    (HIDE.exec(src) as RegExpExecArray)[0],
    'let searchReturn = deps.searchReturn;',
    "let currentOrigin = 'search';",
    'const pageGen = deps.pageGen;',
    'const fetchProductById = (id) => read(id);',
    ...names.map((n) => cut(src, n)),
    'return { ' + names.join(', ') + ' };',
  ].join('\n');
  return (new Function('deps', body) as (d: Record<string, unknown>) => Harness)(deps);
};

/** Eine Zeile NUR innerhalb einer Funktion entfernen — sonst trifft die Mutation den falschen Weg. */
const without = (src: string, fn: string, needle: RegExp): string => {
  const body = cut(src, fn);
  const cutBody = body.replace(needle, '');
  if (cutBody === body) throw new Error('mutation did not apply in ' + fn);
  return src.replace(body, cutBody);
};

const patchApplied = new Function(cut(page, 'patchApplied') + ' return patchApplied;')() as
  (fresh: unknown, expected: unknown) => boolean;
const galleryAddsNewPhotos = new Function(cut(page, 'galleryAddsNewPhotos') + ' return galleryAddsNewPhotos;')() as
  (expected: unknown) => boolean;

const WANT = { storageLocation: 'LIVE-LOC-0850' };
const CONFIRMING = {
  id: 'p-1', name: 'Flip Face', brand: 'Fendi', condition: 'Pre-Owned',
  storage_location: 'LIVE-LOC-0850', notes: null, purchase_price: null, planned_sale_price: null,
  min_sale_price: null, scope_of_delivery: '[]', attributes: '{}',
  gallery: [{ link_id: 'l1' }], updated_at: '2026-08-26T19:00:00.000Z',
};
ok(patchApplied(CONFIRMING, WANT), 'SETUP the late answer really WOULD confirm — otherwise the test proves nothing');

const WAITING = 'Saved — waiting for the desktop…';

type Obs = {
  done: boolean; drawn: number; reads: number; msg: string;
  searchVisible: boolean; detailVisible: boolean; hits: number; query: string; scrolledTo: number;
};

const mkEl = (hidden: Set<string>, els: Map<string, El>) => (id: string): El => {
  if (!els.has(id)) {
    els.set(id, {
      id, value: '', innerHTML: '', textContent: '', style: {}, focus: () => { /* … */ },
      classList: {
        add: (c: string) => { if (c === 'hidden') hidden.add(id); },
        remove: (c: string) => { if (c === 'hidden') hidden.delete(id); },
      },
      insertAdjacentHTML: () => { /* die Meldung landet im Detailbereich */ },
    });
  }
  return els.get(id) as El;
};

/**
 * Der Live-Ablauf. `back = true` geht waehrend des laufenden Lesevorgangs auf die Trefferliste
 * zurueck; `back = false` ist die Gegenprobe, bei der der Benutzer bleibt.
 */
const scenario = async (src: string, back: boolean): Promise<Obs> => {
  const hidden = new Set<string>();
  const els = new Map<string, El>();
  const $ = mkEl(hidden, els);
  let drawn = 0, hits = 0, scrolledTo = -1, reads = 0;
  let resolveRead: ((v: unknown) => void) | null = null;
  const pageGen = { view: 0, save: 0 };
  const h = build(src, {
    $, patchApplied, galleryAddsNewPhotos, pageGen,
    searchReturn: { query: 'fendi', hits: [{ id: 'p-1' }, { id: 'p-2' }], scrollY: 420 },
    renderHits: () => { hits++; },
    releaseMedia: () => { /* Bilder freigeben */ },
    // Die Attrappe tut genau das, was oben am Original geprueft wurde.
    showProduct: () => { drawn++; $('scanResult').classList.remove('hidden'); },
    read: () => { reads++; return new Promise((r) => { resolveRead = r as (v: unknown) => void; }); },
    document: { documentElement: { scrollHeight: 4000 } },
    window: { scrollTo: (_x: number, y: number) => { scrolledTo = y; } },
  });

  // Ausgangslage: die Detailansicht ist offen, die Trefferliste liegt darunter versteckt.
  $('searchPane').classList.add('hidden');
  $('scanResult').classList.remove('hidden');

  const msg = { style: {} as Record<string, string>, textContent: WAITING };
  const pending = h.showSavedState('p-1', WANT, msg, { intervalMs: 1, timeoutMs: 3000 });
  for (let i = 0; i < 2000 && reads === 0; i++) await new Promise((r) => setTimeout(r, 1));
  if (reads !== 1) throw new Error('the confirmation read never started');

  if (back) h.backToSearch();               // ← genau der Live-Weg, mitten im Lesevorgang
  const searchAfterBack = !hidden.has('searchPane');
  (resolveRead as unknown as (v: unknown) => void)(CONFIRMING);   // und JETZT kommt die alte Antwort
  const done = await pending;
  if (back && !searchAfterBack) throw new Error('back did not reach the search list at all');

  return {
    done, drawn, reads, msg: String(msg.textContent),
    searchVisible: !hidden.has('searchPane'), detailVisible: !hidden.has('scanResult'),
    hits, query: $('searchInput').value, scrolledTo,
  };
};

// ── 1) Der reparierte Fall ────────────────────────────────────────────────
const fixed = await scenario(page, true);
ok(fixed.searchVisible, 'G1 the search list stays visible after going back');
ok(!fixed.detailVisible, 'G1 …the detail view does NOT open again over it');
ok(fixed.drawn === 0, 'G1 …the late answer draws nothing, although it would have confirmed (' + fixed.drawn + ')');
ok(fixed.done === false, 'G1 …the wait reports no success');
ok(fixed.msg === WAITING, 'G1 …and no late message is written into the view the user left ("' + fixed.msg + '")');
ok(fixed.reads === 1, 'G1 …and no further poll is started from that waiter (' + fixed.reads + ')');
ok(fixed.hits === 1 && fixed.query === 'fendi' && fixed.scrolledTo === 420,
  'G1 …while the list itself is restored exactly as before: same query, same hits, same offset');

// ── 2) Negativkontrolle: genau das eine Hochzaehlen wieder wegnehmen ──────
//
// Ohne es muss GENAU dieser Ablauf wieder den Live-Fehler zeigen: die Detailansicht kommt zurueck,
// waehrend die Trefferliste noch steht. Findet der Test das nicht, prueft er nichts.
const broken = without(page, 'backToSearch', /\r?\n\s*pageGen\.view\+\+;/);
ok(broken.length < page.length, 'CONTROL the mutation removed exactly the invalidation, inside backToSearch only');
const old = await scenario(broken, true);
ok(old.drawn === 1, 'CONTROL without it the late answer redraws the detail (' + old.drawn + ')');
ok(old.detailVisible && old.searchVisible,
  'CONTROL …and it appears WHILE the search list is still shown — exactly the reported symptom');
ok(old.done === true, 'CONTROL …and the stale waiter even reports success into the abandoned view');

// ── 3) Nachbarfaelle: was weiter funktionieren muss ───────────────────────
const stay = await scenario(page, false);
ok(stay.done === true && stay.drawn === 1 && stay.detailVisible,
  'NEIGHBOUR a save WITHOUT navigating still confirms and draws exactly once');
ok(stay.searchVisible === false, 'NEIGHBOUR …and does not pull the search list up');

// Zurueckgehen ohne laufenden Save: die Liste wird ganz normal wiederhergestellt.
{
  const hidden = new Set<string>(['searchPane']);
  const els = new Map<string, El>();
  const $ = mkEl(hidden, els);
  let hits = 0, scrolledTo = -1;
  const pageGen = { view: 7, save: 3 };
  const h = build(page, {
    $, patchApplied, galleryAddsNewPhotos, pageGen,
    searchReturn: { query: 'tag heuer', hits: [{ id: 'x' }], scrollY: 88 },
    renderHits: () => { hits++; }, releaseMedia: () => { /* … */ },
    showProduct: () => { throw new Error('nothing may be drawn'); },
    read: () => { throw new Error('nothing may be read'); },
    document: { documentElement: { scrollHeight: 900 } },
    window: { scrollTo: (_x: number, y: number) => { scrolledTo = y; } },
  });
  h.backToSearch();
  ok(!hidden.has('searchPane') && hidden.has('scanResult'), 'NEIGHBOUR a plain back shows the list and hides the detail');
  ok(hits === 1 && $('searchInput').value === 'tag heuer' && scrolledTo === 88,
    'NEIGHBOUR …with the same query, the same hits and the same scroll offset as before');
  ok(pageGen.view === 8 && pageGen.save === 3, 'NEIGHBOUR …and it invalidates the view generation, nothing else');
  h.backToSearch();
  ok(pageGen.view === 8, 'NEIGHBOUR a second back does nothing at all — there is no view left to leave');
}

// ── 3b) Der Tabwechsel ist derselbe Ausgang wie "Back to search" ──────────
//
// `findMode` versteckt `scanResult` genauso — nur heisst es nicht "zurueck". Ein Warten, das die
// Ansicht ueberlebt, zeichnet sie dann ueber den anderen Tab. Derselbe Beweis, derselbe Ablauf.
const tabSwitch = async (src: string): Promise<{ drawn: number; done: boolean; detailVisible: boolean }> => {
  const hidden = new Set<string>();
  const els = new Map<string, El>();
  const $ = mkEl(hidden, els);
  let drawn = 0, reads = 0;
  let resolveRead: ((v: unknown) => void) | null = null;
  const pageGen = { view: 0, save: 0 };
  const h = build(src, {
    $, patchApplied, galleryAddsNewPhotos, pageGen,
    searchReturn: { query: 'fendi', hits: [], scrollY: 0 },
    renderHits: () => { /* … */ }, releaseMedia: () => { /* … */ },
    stopScan: () => { /* … */ }, startScan: () => { /* … */ }, setText: () => { /* … */ },
    showProduct: () => { drawn++; $('scanResult').classList.remove('hidden'); },
    read: () => { reads++; return new Promise((r) => { resolveRead = r as (v: unknown) => void; }); },
    document: { documentElement: { scrollHeight: 100 } }, window: { scrollTo: () => { /* … */ } },
  }, ['findMode', 'showSavedState']);

  $('searchPane').classList.add('hidden');
  $('scanResult').classList.remove('hidden');
  const pending = h.showSavedState('p-1', WANT, { style: {}, textContent: WAITING }, { intervalMs: 1, timeoutMs: 3000 });
  for (let i = 0; i < 2000 && reads === 0; i++) await new Promise((r) => setTimeout(r, 1));
  h.findMode('search');                       // Tab gewechselt, Detailansicht ist weg
  (resolveRead as unknown as (v: unknown) => void)(CONFIRMING);
  const done = await pending;
  return { drawn, done, detailVisible: !hidden.has('scanResult') };
};
const tab = await tabSwitch(page);
ok(tab.drawn === 0 && tab.done === false, 'TAB switching tabs during a save-wait leaves the wait without effect');
ok(!tab.detailVisible, 'TAB …and the detail does not reappear over the other tab');
const tabOld = await tabSwitch(without(page, 'findMode', /\r?\n\s*pageGen\.view\+\+;/));
ok(tabOld.drawn === 1 && tabOld.detailVisible,
  'TAB control: without the invalidation in findMode the very same symptom comes back');

// ── 3c) Der Scanner oeffnet eine Detailansicht — mit eigener Generation ───
const scan = async (src: string, leave: boolean): Promise<{ drawn: number; text: string }> => {
  const hidden = new Set<string>();
  const els = new Map<string, El>();
  const $ = mkEl(hidden, els);
  let drawn = 0;
  let release: (() => void) | null = null;
  const pageGen = { view: 0, save: 0 };
  const h = build(src, {
    $, patchApplied, galleryAddsNewPhotos, pageGen,
    searchReturn: null, renderHits: () => { /* … */ }, releaseMedia: () => { /* … */ },
    stopScan: () => { /* … */ }, startScan: () => { /* … */ }, setText: () => { /* … */ },
    showProduct: () => { drawn++; },
    read: () => Promise.resolve(null),
    localStorage: { getItem: () => 'tok' }, TOKEN_KEY: 't',
    document: { documentElement: { scrollHeight: 100 } }, window: { scrollTo: () => { /* … */ } },
    fetch: () => new Promise((r) => {
      release = () => r({ ok: true, status: 200, json: async () => CONFIRMING });
    }),
  }, ['lookupProduct', 'findMode']);

  const pending = h.lookupProduct('TAG-WCH-003');
  for (let i = 0; i < 2000 && !release; i++) await new Promise((r) => setTimeout(r, 1));
  if (leave) h.findMode('search');            // waehrend der Abfrage in die Suche gewechselt
  (release as unknown as () => void)();
  await pending;
  return { drawn, text: String($('scanDetails').textContent) };
};
const scanStayed = await scan(page, false);
ok(scanStayed.drawn === 1, 'SCAN a scan that nobody interrupts still renders its item');
const scanLeft = await scan(page, true);
ok(scanLeft.drawn === 0 && scanLeft.text === '',
  'SCAN …but after a tab switch the late answer neither draws nor writes a message');
// Kontrolle: die Pruefungen nach den Wartepunkten fallen weg — `seq` bleibt definiert, damit die
// Mutation den ALTEN Ablauf zeigt statt abzustuerzen. Genau so sah dieser Weg vorher aus.
const scanOld = await scan(
  without(page, 'lookupProduct', /\r?\n\s*if \(seq !== pageGen\.view\) return;/g), true);
ok(scanOld.drawn === 1, 'SCAN control: without the checks after its reads the scan draws into the pane the user left');

// ── 3d) Die Zaehl-Historie gehoert zu der Ansicht, die sie angefordert hat ─
const checks = async (src: string, leave: boolean): Promise<{ rendered: number }> => {
  const hidden = new Set<string>();
  const els = new Map<string, El>();
  const $ = mkEl(hidden, els);
  let rendered = 0;
  let release: (() => void) | null = null;
  const pageGen = { view: 4, save: 0 };
  const h = build(src, {
    $, patchApplied, galleryAddsNewPhotos, pageGen,
    searchReturn: { query: '', hits: [], scrollY: 0 },
    renderHits: () => { /* … */ }, releaseMedia: () => { /* … */ },
    stopScan: () => { /* … */ }, startScan: () => { /* … */ }, setText: () => { /* … */ },
    showProduct: () => { /* … */ }, read: () => Promise.resolve(null),
    renderChecks: () => { rendered++; },
    localStorage: { getItem: () => 'tok' }, TOKEN_KEY: 't',
    document: { documentElement: { scrollHeight: 100 } }, window: { scrollTo: () => { /* … */ } },
    fetch: () => new Promise((r) => { release = () => r({ ok: true, json: async () => ({ checks: [{ id: 'c1' }] }) }); }),
  }, ['loadChecks', 'findMode']);

  const pending = h.loadChecks('p-1');
  for (let i = 0; i < 2000 && !release; i++) await new Promise((r) => setTimeout(r, 1));
  if (leave) h.findMode('search');
  (release as unknown as () => void)();
  await pending;
  return { rendered };
};
ok((await checks(page, false)).rendered === 1, 'CHECKS the history of the open item is rendered');
ok((await checks(page, true)).rendered === 0,
  'CHECKS …but a late one is not written into whatever item is on screen by then');
ok((await checks(
  without(page, 'loadChecks', /\r?\n\s*if \(seq !== pageGen\.view\) return;/g), true)).rendered === 1,
  'CHECKS control: without the checks after its reads the stale history lands in the wrong item');

// ── 4) Der Rest des Lebenszyklus bleibt, wie er war ───────────────────────
// Der Vertrag, Weg fuer Weg statt als Zaehlung: wer eine Detailansicht OEFFNET, nimmt sich eine
// frische Generation; wer sie VERLAESST, dreht sie weiter; wer nur in sie hineinliest, merkt sie
// sich. Und jeder von ihnen prueft nach seinem Warten erneut.
for (const [fn, opens] of [['openHit', true], ['lookupProduct', true]] as Array<[string, boolean]>) {
  const src = cut(page, fn);
  ok(src.includes('const seq = ++pageGen.view;') === opens,
    'LIFECYCLE ' + fn + ' opens a view and takes a fresh generation for it');
  ok((src.match(/if \(seq !== pageGen\.view\) return;/g) || []).length >= 1,
    'LIFECYCLE …and re-checks it after every await before it renders');
}
for (const [fn, needle] of [['loadChecks', 'const seq = pageGen.view;']] as Array<[string, string]>) {
  const src = cut(page, fn);
  ok(src.includes(needle) && !src.includes('++pageGen.view'),
    'LIFECYCLE ' + fn + ' only remembers the running view — it does not start a new one');
  ok((src.match(/if \(seq !== pageGen\.view\) return;/g) || []).length >= 2,
    'LIFECYCLE …and checks it after each of its awaits');
}
for (const fn of ['backToSearch', 'findMode']) {
  ok(/\n\s*pageGen\.view\+\+;/.test(cut(page, fn)), 'LIFECYCLE ' + fn + ' leaves the detail view and invalidates it');
  ok(cut(page, fn).includes("hide('scanResult');"), 'LIFECYCLE …which is exactly why it must: it hides the detail');
}
ok(cut(page, 'showSavedState').includes('seq !== pageGen.view || mine !== pageGen.save'),
  'LIFECYCLE the wait is bound to BOTH its view and its save');
ok(/addEventListener\('pageshow'/.test(page) && /if \(!ev\.persisted\) return;/.test(page),
  'LIFECYCLE the v0.8.49 restore handler is untouched');
ok(/if \(seq !== pageGen\.view\) return;[^\n]*\r?\n\s*if \(fresh\) \{ showProduct\(fresh, 'search', 'fresh'\); return; \}/.test(page),
  'LIFECYCLE the retry read — same call path — cannot redraw an abandoned view either');

// ── 5) Ein Save gehoert zu der Ansicht, in der er gestartet wurde ─────────
//
// Dieser Weg laesst sich hier nicht ausfuehren (der Handler haengt an einem Formular), also wird
// er strukturell festgehalten: nach JEDEM Wartepunkt des Speicherns steht die Pruefung, und keine
// Meldung wird geschrieben, ohne sie vorher gestellt zu haben.
ok(/const viewAtSave = pageGen\.view;\r?\n\s*const viewGone = \(\) => pageGen\.view !== viewAtSave;/.test(page),
  'SAVE the save captures the view it belongs to, before its first await');
// Nur der Bearbeiten-Weg. Der Anlegen-Bildschirm hat seinen eigenen Upload und keine
// Detailansicht, die man verlassen koennte — er gehoert nicht zu diesem Lebenszyklus.
const editSrc = cut(page, 'wireProductEdit');
const drains = editSrc.match(/await uploadQueue\.drainEntry\([^\n]*\)/g) || [];
ok(drains.length === 2, 'SAVE both durable paths of the edit are covered (' + drains.length + ')');
for (const [what, re] of [
  ['photos', /throw new Error\('Photos ' \+ gr\.outcome\);\r?\n\s*if \(viewGone\(\)\) return;/],
  ['fields', /throw new Error\('Upload ' \+ r\.outcome\);\r?\n\s*if \(viewGone\(\)\) return;/],
] as Array<[string, RegExp]>) {
  ok(re.test(page), 'SAVE …and the ' + what + ' job checks the view right after its await');
}
ok(/if \(viewGone\(\)\) \{ saving = false; \$\('peSave'\)\.disabled = false; return; \}/.test(page),
  'SAVE a failed photo job writes nothing into a view the user has left');
ok(/if \(msg && !viewGone\(\)\) \{ msg\.style\.color = '#AA6E6E';/.test(page),
  'SAVE …and neither does a failed field job');

console.log('\n' + (FAIL === 0 ? 'PASS' : 'FAIL') + ' — back-to-search generation: ' + PASS + ' passed, ' + FAIL + ' failed');
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('MOBILE_BACK_TO_SEARCH_GENERATION_PROVED');

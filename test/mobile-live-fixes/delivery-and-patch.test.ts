// ════════════════════════════════════════════════════════════════════════════
// v0.8.49 — die drei live gefundenen Defekte der Mobilseite.
// Run: node test/mobile-live-fixes/delivery-and-patch.test.ts
//
//   A  Nach dem Update zeigte das Handy die ALTE Seite. Der Server sagte nichts darueber, ob seine
//      Antworten wiederverwendet werden duerfen — also behielt der Browser sie. Die Header sind in
//      `delivery_cache_tests.rs` am echten Router bewiesen; hier steht die Client-Seite: die
//      Produktabrufe holen ausdruecklich am Cache vorbei, die inhaltsadressierten Medien NICHT.
//   B  Nach "Saved." blieb der Bildschirm auf dem Stand von vorher. Jetzt wird gewartet, bis der
//      Server einen NEUEREN Stand meldet, und genau der wird gezeichnet.
//   C  In echten Payloads stand bei jedem Speichern `year: null` — eine Aenderung, die niemand
//      vorgenommen hatte. Die Regel dafuer wird hier an der ECHTEN Funktion geprueft.
//
// Dazu die Detailansicht: was das Handy bearbeiten kann, muss dort auch wieder auftauchen.
// ════════════════════════════════════════════════════════════════════════════
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } };

const page = readFileSync(join(repo, 'src-tauri/src/sync/mobile_page.rs'), 'utf8');

// ── C) die echte Attributregel, ausgewertet ───────────────────────────────
const start = page.indexOf('function attrChange(now, before) {');
ok(start >= 0, 'the page carries the attribute rule as a named function');
let depth = 0, end = -1, seen = false;
for (let i = start; i < page.length; i++) {
  const ch = page[i];
  if (ch === '{') { depth++; seen = true; }
  else if (ch === '}') { depth--; if (seen && depth === 0) { end = i + 1; break; } }
}
const attrChange = new Function(`${page.slice(start, end)} return attrChange;`)() as
  (now: unknown, before: unknown) => unknown;

const NOCHANGE = Symbol('nochange');
const call = (now: unknown, before: unknown): unknown => {
  const r = attrChange(now, before);
  return r === undefined ? NOCHANGE : r;
};

// 1) unangetastet leer → gar nicht im Patch
for (const [now, before] of [
  [null, undefined], ['', undefined], [null, null], ['', ''], [undefined, undefined],
  [null, ''], ['', null], [[], undefined], [[], []],
] as Array<[unknown, unknown]>) {
  ok(call(now, before) === NOCHANGE,
    `RULE untouched empty stays out of the patch (${JSON.stringify(now)} vs ${JSON.stringify(before)})`);
}
// Das ist der reale Fall: ein leeres Zahlenfeld liest sich als null, das Attribut gab es nie.
ok(call(null, undefined) === NOCHANGE, 'RULE …which is exactly the "year: null" that used to be sent');

// 2) vorhandener Wert bewusst geleert → ausdrueckliches null
for (const [now, before] of [
  [null, 1998], ['', 'Steel'], [null, '126334'], [[], ['Box', 'Papers']], ['', 0],
] as Array<[unknown, unknown]>) {
  ok(call(now, before) === null,
    `RULE clearing a real value sends null (${JSON.stringify(now)} vs ${JSON.stringify(before)})`);
}

// 3) geaenderter Wert → der neue Wert; gleicher Wert → nichts
ok(call(1999, 1998) === 1999, 'RULE a changed number is sent');
ok(call('Gold', 'Steel') === 'Gold', 'RULE a changed text is sent');
ok(call(1998, 1998) === NOCHANGE, 'RULE an unchanged number is not sent');
ok(call('1998', 1998) === NOCHANGE, 'RULE …not even when it arrives as text from the input');
ok(call('Steel', 'Steel') === NOCHANGE, 'RULE an unchanged text is not sent');
ok(call(0, undefined) === 0, 'RULE zero is a value, not an empty field');
ok(call(false, undefined) === false, 'RULE "No" is a value, not an empty field');
ok(call(0, 0) === NOCHANGE, 'RULE …and an unchanged zero is still not a change');
const arr = call(['Box'], ['Box', 'Papers']);
ok(Array.isArray(arr) && (arr as string[]).length === 1, 'RULE a shortened list is sent as the new list');
ok(call(['Box', 'Papers'], ['Box', 'Papers']) === NOCHANGE, 'RULE an unchanged list is not sent');

// ── A) Client-Seite der Auslieferung ──────────────────────────────────────
for (const [what, needle] of [
  ['by-id', "fetch('/api/products/by-id/' + encodeURIComponent(id), { cache: 'no-store'"],
  ['by-sku', "fetch('/api/products/by-sku/' + encodeURIComponent(sku), { cache: 'no-store'"],
  ['search', "{ cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });"],
] as Array<[string, string]>) {
  ok(page.includes(needle), `CACHE the ${what} read goes past the browser cache`);
}
// Die Medien-Bytes bleiben cachebar — sie sind inhaltsadressiert, und ein Foto zweimal zu laden
// kostet auf einem Handy im Laden echte Zeit.
const mediaFetch = page.split('\n').find((l) => l.includes("fetch('/api/media?key="));
ok(!!mediaFetch, 'CACHE the media read exists');
ok(!!mediaFetch && !mediaFetch.includes('no-store'), 'CACHE …and is deliberately left cacheable');

// ── B) nach dem Speichern wird der gespeicherte Stand gezeigt ─────────────
ok(/async function showSavedState\(productId, expected, msg, opts\)/.test(page),
  'SAVED the page has one place that shows the confirmed state');
ok(/if \(patchApplied\(fresh, expected\)\) \{/.test(page),
  'SAVED it confirms on CONTENT — a newer timestamp alone is not proof');
ok(/showProduct\(fresh, currentOrigin, 'fresh'\)/.test(page),
  'SAVED …and then draws exactly that state');
ok((page.match(/showSavedState\(p\.id, expected, msg\);/g) || []).length === 2,
  'SAVED both success paths use it — the plain edit and the one that rides along with the gallery');
ok(/accepted, but the desktop has not applied it yet/.test(page),
  'SAVED …and if it never arrives, the page says accepted — not saved');
ok(/Saved — waiting for the desktop/.test(page),
  'SAVED the wording separates "accepted" from "confirmed"');
ok(/const seq = \+\+pageGen\.view;/.test(page) && (page.match(/seq !== pageGen\.view/g) || []).length === 3,
  'ORDER every async view carries a generation guard — a slow old answer cannot overwrite a newer view');

// ── Rueckkehr aus dem Vor-/Zurueck-Speicher ist NICHT der HTTP-Cache ──────
ok(/addEventListener\('pageshow'/.test(page), 'RESTORE a restored page is handled explicitly');
ok(/if \(!ev\.persisted\) return;/.test(page), 'RESTORE …only when it really came back from the store');
ok(/fetchProductById\(currentProduct\.id\)/.test(page), 'RESTORE …and it re-reads the item');

// ── Detailansicht zeigt, was sie bearbeiten laesst ────────────────────────
ok(page.includes("add('Notes', p.notes);"), 'DETAIL the note is visible in the detail view');
ok(page.includes("add('Included', Array.isArray(scope) ? scope.join(', ') : '');"),
  'DETAIL …and so is what is included');
for (const label of ['Location', 'Condition', 'SKU', 'Category', 'Min Sale Price', 'Cost Price']) {
  ok(page.includes(`add('${label}'`), `DETAIL ${label} is still rendered`);
}

// ── Der eigene Save muss WIRKLICH bestaetigt sein ─────────────────────────
//
// Der gefaehrliche Fall: waehrend der eigene Auftrag noch in der Warteschlange liegt, aendert
// jemand am Desktop denselben Artikel. Der Stand ist dann neuer — die eigene Aenderung steht aber
// nicht drin. Wer auf "neuer" prueft, meldet Erfolg fuer etwas, das nicht passiert ist.
{
  const cut = (name: string): string => {
    let from = page.indexOf(`function ${name}(`);
    if (page.slice(from - 6, from) === 'async ') from -= 6;   // sonst faellt das `async` weg
    let d = 0, to = -1, seen = false;
    for (let i = from; i < page.length; i++) {
      const c = page[i];
      if (c === '{') { d++; seen = true; } else if (c === '}') { d--; if (seen && d === 0) { to = i + 1; break; } }
    }
    return page.slice(from, to);
  };
  const patchApplied = new Function(`${cut('patchApplied')} return patchApplied;`)() as
    (fresh: unknown, expected: unknown) => boolean;

  const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'p-1', name: 'Flip Face', brand: 'Fendi', condition: 'Pre-Owned',
    storage_location: null, notes: null, purchase_price: null, planned_sale_price: null,
    min_sale_price: null, scope_of_delivery: '[]',
    attributes: JSON.stringify({ dial: 'Beige', material: 'Steel' }),
    gallery: [{ link_id: 'l1' }, { link_id: 'l2' }], updated_at: '2026-08-25T15:00:00.000Z', ...over,
  });

  ok(patchApplied(item({ storage_location: 'LIVE-LOC-0849' }), { storageLocation: 'LIVE-LOC-0849' }),
    'CORRELATION a state that carries the change confirms it');
  ok(!patchApplied(item({ notes: 'someone else', updated_at: '2026-08-25T16:00:00.000Z' }), { storageLocation: 'LIVE-LOC-0849' }),
    'CORRELATION a FOREIGN change with a newer timestamp confirms nothing');
  ok(!patchApplied(item(), { storageLocation: 'LIVE-LOC-0849' }), 'CORRELATION …and neither does the untouched state');
  ok(patchApplied(item({ notes: null }), { notes: null }), 'CORRELATION clearing a field is confirmed by it being empty');
  ok(!patchApplied(item({ notes: 'still here' }), { notes: null }), 'CORRELATION …and not while the old text is still there');
  ok(patchApplied(item({ purchase_price: 60, planned_sale_price: 110, min_sale_price: 70 }),
    { purchasePrice: 60, plannedSalePrice: 110, minSalePrice: 70 }), 'CORRELATION prices are confirmed by value');
  ok(!patchApplied(item({ purchase_price: 60 }), { purchasePrice: 60, plannedSalePrice: 110 }),
    'CORRELATION …and a half-applied price set is not a confirmation');
  ok(patchApplied(item({ attributes: JSON.stringify({ dial: 'Beige', material: 'Steel', year: 1998 }) }),
    { attributes: { year: 1998 } }), 'CORRELATION an attribute is confirmed in the stored attributes');
  ok(!patchApplied(item(), { attributes: { year: 1998 } }), 'CORRELATION …and not while it is missing');
  ok(patchApplied(item({ attributes: JSON.stringify({ dial: 'Beige' }) }), { attributes: { material: null } }),
    'CORRELATION a cleared attribute is confirmed by its absence');
  ok(patchApplied(item({ scope_of_delivery: '["Box","Papers"]' }), { scopeOfDelivery: ['Papers', 'Box'] }),
    'CORRELATION what is included is confirmed regardless of order');
  ok(!patchApplied(item({ scope_of_delivery: '["Box"]' }), { scopeOfDelivery: ['Box', 'Papers'] }),
    'CORRELATION …but not when one is missing');
  // ── Galerie: der gewuenschte ENDZUSTAND, nicht die Anzahl ───────────────
  //
  // Die Anzahl allein beweist nichts. Eine fremde Aenderung kann zufaellig auf dieselbe Anzahl
  // kommen, und Umsortieren oder ein anderes Titelbild aendert sie ueberhaupt nicht.
  const gal = (spec: Array<[string, boolean]>): Record<string, unknown> =>
    item({ gallery: spec.map(([id, primary], i) => ({ link_id: id, is_primary: primary, sort_order: i })) });

  // Foto hinzufuegen: a,b,c bleiben in dieser Reihenfolge, ein neues kommt dazu, a bleibt Titel.
  const addPlan = { gallery: { order: [{ keep: 'a' }, { keep: 'b' }, { keep: 'c' }, { new: 0 }], remove: [] } };
  ok(patchApplied(gal([['a', true], ['b', false], ['c', false], ['n1', false]]), addPlan),
    'GALLERY adding a photo is confirmed by the resulting gallery');
  ok(!patchApplied(gal([['a', true], ['b', false], ['c', false]]), addPlan),
    'GALLERY …and not while the photo is still missing');
  ok(!patchApplied(gal([['a', true], ['b', false], ['x', false], ['y', false]]), addPlan),
    'GALLERY a FOREIGN change that happens to reach the same count confirms nothing');

  // Umsortieren: gleiche Bilder, gleiche Anzahl — nur die Reihenfolge zaehlt.
  const reorderPlan = { gallery: { order: [{ keep: 'c' }, { keep: 'a' }, { keep: 'b' }], remove: [] } };
  ok(patchApplied(gal([['c', true], ['a', false], ['b', false]]), reorderPlan),
    'GALLERY a reorder is confirmed by the new order');
  ok(!patchApplied(gal([['a', true], ['b', false], ['c', false]]), reorderPlan),
    'GALLERY …and the old order does not confirm it, though the count is identical');

  // Titelbild: gleiche Bilder, gleiche Anzahl, gleiche Reihenfolge — nur der Titel wechselt.
  const coverPlan = { gallery: { order: [{ keep: 'b' }, { keep: 'a' }, { keep: 'c' }], remove: [] } };
  ok(patchApplied(gal([['b', true], ['a', false], ['c', false]]), coverPlan),
    'GALLERY a new cover is confirmed when it really is the cover');
  ok(!patchApplied(gal([['b', false], ['a', true], ['c', false]]), coverPlan),
    'GALLERY …and not while the old one still carries the cover');

  // Entfernen: was weg sollte, muss weg sein.
  const removePlan = { gallery: { order: [{ keep: 'a' }, { keep: 'c' }], remove: ['b'] } };
  ok(patchApplied(gal([['a', true], ['c', false]]), removePlan), 'GALLERY a removal is confirmed once it is gone');
  ok(!patchApplied(gal([['a', true], ['b', false]]), removePlan),
    'GALLERY …and not while the removed photo is still there, even at the right count');

  // Ein NEUES Foto soll das Titelbild werden: seine Identitaet kennt das Geraet noch nicht, aber
  // der Titel darf dann keines der behaltenen sein.
  const newCoverPlan = { gallery: { order: [{ new: 0 }, { keep: 'a' }, { keep: 'b' }], remove: [] } };
  ok(patchApplied(gal([['n9', true], ['a', false], ['b', false]]), newCoverPlan),
    'GALLERY a newly added cover is confirmed when the cover is not one of the kept ones');
  ok(!patchApplied(gal([['a', true], ['b', false], ['n9', false]]), newCoverPlan),
    'GALLERY …and not while a kept photo is still the cover');

  // ── Die Grenze: ein NEUES Foto ist von hier aus nicht identifizierbar ───
  //
  // Seine Kennung entsteht erst beim Anwenden (der Desktop normalisiert die Bytes neu und legt sie
  // unter dem Hash des Ergebnisses ab), und keine Route meldet dem Handy das Ergebnis eines
  // Auftrags. Belegbar ist, DASS an der verlangten Stelle eines dazugekommen ist — nicht, dass es
  // genau dieses ist. Dieser Test haelt fest, dass die Seite das auch nicht behauptet.
  const galleryAddsNewPhotos = new Function(`${cut('galleryAddsNewPhotos')} return galleryAddsNewPhotos;`)() as
    (expected: unknown) => boolean;
  ok(galleryAddsNewPhotos(addPlan), 'LIMIT a plan with a new photo is recognised as not fully provable');
  ok(galleryAddsNewPhotos(newCoverPlan), 'LIMIT …and so is one that makes a new photo the cover');
  ok(!galleryAddsNewPhotos(reorderPlan) && !galleryAddsNewPhotos(coverPlan) && !galleryAddsNewPhotos(removePlan),
    'LIMIT reorder, cover change and removal are fully provable — they only touch known photos');
  ok(!galleryAddsNewPhotos({}), 'LIMIT a save without a gallery plan is fully provable');
  ok(/Saved — the photos above are the current state of this item\./.test(page),
    'LIMIT the wording for that case states the shown state instead of claiming a specific photo');
  ok(/const said = galleryAddsNewPhotos\(expected\)/.test(page),
    'LIMIT …and the page really chooses its wording by that rule');

  // Und der Ablauf drumherum, mit gestellten Antworten.
  const showSavedState = new Function(
    'fetchProductById', 'showProduct', '$', 'patchApplied', 'galleryAddsNewPhotos', 'currentOrigin', 'pageGen',
    `${cut('showSavedState')} return showSavedState;`,
  ) as (...a: unknown[]) => (id: string, expected: unknown, msg: unknown, opts: unknown) => Promise<boolean>;

  // Die ECHTEN Generationen der Seite — der Test dreht sie von aussen weiter und prueft damit
  // die tatsaechliche Abbruchbedingung, nicht eine nachgebaute.
  let gen = { view: 0, save: 0 };
  const run = async (answers: Array<Record<string, unknown>>, expected: unknown) => {
    gen = { view: 0, save: 0 };
    const drawn: unknown[] = [];
    let i = 0;
    const fn = showSavedState(
      async () => answers[Math.min(i++, answers.length - 1)],
      (fresh: unknown) => drawn.push(fresh),
      () => null,
      patchApplied, galleryAddsNewPhotos, 'search', gen,
    );
    const msg: Record<string, unknown> = { style: {}, textContent: '' };
    const okd = await fn('p-1', expected, msg, { intervalMs: 1, timeoutMs: 120 });
    return { okd, drawn, msg };
  };

  const want = { storageLocation: 'LIVE-LOC-0849' };
  const mine = item({ storage_location: 'LIVE-LOC-0849', updated_at: '2026-08-25T17:00:00.000Z' });
  const foreign = item({ notes: 'desk edit', updated_at: '2026-08-25T16:00:00.000Z' });

  const normal = await run([item(), mine], want);
  ok(normal.okd === true, 'FLOW the own change is confirmed once the server carries it');
  ok(normal.drawn.length === 1 && normal.drawn[0] === mine, 'FLOW …and exactly that state is drawn');

  const race = await run([foreign, foreign, mine], want);
  ok(race.okd === true, 'FLOW a foreign edit in between does not stop the confirmation');
  ok(race.drawn.length === 1 && race.drawn[0] === mine,
    'FLOW …and what gets drawn is the state that carries the OWN change, never the foreign one');

  // Ein Warten, das gegenstandslos geworden ist, hoert auf — es liest nicht im Hintergrund
  // weiter. Real aufgefallen: nach einem Speichern lief das Warten noch, waehrend der naechste
  // Vorgang schon lief, und schickte Leseanfragen, die niemand mehr brauchte.
  {
    let reads = 0, stop = false;
    const fn = showSavedState(
      async () => { reads++; stop = true; return foreign; },
      () => { throw new Error('nothing may be drawn from a cancelled wait'); },
      () => null, patchApplied, galleryAddsNewPhotos, 'search', { view: 0, save: 0 },
    );
    const done = await fn('p-1', want, { style: {}, textContent: '' },
      { intervalMs: 1, timeoutMs: 200, cancelled: () => stop });
    ok(done === false, 'CANCEL a wait that has become pointless ends without a result');
    ok(reads === 1, `CANCEL …and stops reading instead of polling on (${reads} read)`);
  }
  ok(/const cancelled = \(opts && opts\.cancelled\) \|\| \(\(\) => seq !== pageGen\.view \|\| mine !== pageGen\.save\)/.test(page),
    'CANCEL the page ends the wait when the view moved on or another save started');
  ok(/pageGen\.save\+\+;/.test(page), 'CANCEL …and every new save really supersedes the previous wait');

  // ── Lebenszyklus: ein Warten, das nicht mehr gilt, bleibt vollstaendig wirkungslos ──
  //
  // Nicht nur "vor dem naechsten Lesen abbrechen": ein Lesevorgang, der bereits lief, muss nach
  // seiner Rueckkehr erkennen, dass seine Generation ungueltig ist — sonst zeichnet er die alte
  // Antwort in eine Ansicht, die es so nicht mehr gibt.
  const lifecycle = async (breakIt: (g: { view: number; save: number }) => void, answer: Record<string, unknown> | null) => {
    gen = { view: 0, save: 0 };
    const drawn: unknown[] = [];
    let reads = 0;
    const fn = showSavedState(
      async () => { reads++; breakIt(gen); return answer; },      // waehrend des Lesens gilt es nicht mehr
      (fresh: unknown) => drawn.push(fresh),
      () => null, patchApplied, galleryAddsNewPhotos, 'search', gen,
    );
    const msg: Record<string, unknown> = { style: {}, textContent: 'untouched' };
    const done = await fn('p-1', want, msg, { intervalMs: 1, timeoutMs: 120 });
    return { done, drawn, reads, msg };
  };

  // 1) Der Benutzer ist weitergegangen, waehrend der Lesevorgang lief — und die Antwort HAETTE
  //    bestaetigt. Sie darf trotzdem nichts bewirken.
  const viewGone = await lifecycle((g) => { g.view++; }, mine);
  ok(viewGone.done === false, 'LIFECYCLE a wait whose view is gone reports nothing');
  ok(viewGone.drawn.length === 0, 'LIFECYCLE …draws nothing, although the answer would have confirmed');
  ok(viewGone.reads === 1, `LIFECYCLE …and stops reading (${viewGone.reads})`);
  ok(viewGone.msg.textContent === 'untouched', 'LIFECYCLE …and leaves the message of the new view alone');

  // 2) Save A wartet, Save B beginnt — A darf B nicht bestaetigen, auch nicht mit passendem Stand.
  const superseded = await lifecycle((g) => { g.save++; }, mine);
  ok(superseded.done === false, 'LIFECYCLE a save that was superseded by the next one confirms nothing');
  ok(superseded.drawn.length === 0, 'LIFECYCLE …and draws nothing into the newer save');
  ok(superseded.reads === 1, `LIFECYCLE …and stops (${superseded.reads})`);

  // 3) Der entwertete Lesevorgang scheitert (abgelaufenes Token liefert nichts) — das darf die
  //    neue Ansicht ebenso wenig beruehren.
  const failedLate = await lifecycle((g) => { g.view++; }, null);
  ok(failedLate.done === false && failedLate.drawn.length === 0 && failedLate.msg.textContent === 'untouched',
    'LIFECYCLE a failed read of an invalidated wait leaves the new view untouched');

  // 3b) Wird das Warten schon vor dem naechsten Takt gegenstandslos, wird gar nicht erst gelesen.
  {
    gen = { view: 0, save: 0 };
    let reads = 0;
    const fn = showSavedState(
      async () => { reads++; return mine; },
      () => { throw new Error('nothing may be drawn'); },
      () => null, patchApplied, galleryAddsNewPhotos, 'search', gen,
    );
    const pending = fn('p-1', want, { style: {}, textContent: '' }, { intervalMs: 5, timeoutMs: 120 });
    gen.view++;                                  // der Benutzer geht weiter, bevor der Takt faellt
    const done = await pending;
    ok(done === false, 'LIFECYCLE a wait invalidated before the next tick ends without a result');
    ok(reads === 0, `LIFECYCLE …and does not even read once more (${reads})`);
  }

  // 4) Und der gueltige Fall bestaetigt weiterhin.
  const stillValid = await lifecycle(() => {}, mine);
  ok(stillValid.done === true && stillValid.drawn.length === 1,
    'LIFECYCLE the current save still confirms and draws exactly once');

  const never = await run([foreign], want);
  ok(never.okd === false, 'FLOW an unapplied save is never reported as done');
  ok(never.drawn.length === 0, 'FLOW …nothing is drawn from it');
  ok(String(never.msg.textContent).includes('accepted'),
    `FLOW …and the message says accepted, not saved ("${never.msg.textContent}")`);
}

// ── Syntaxgate: die ausgelieferte Seite parst ─────────────────────────────
//
// Die Seite ist ein Rust-Stringliteral — ein Tippfehler im JavaScript faellt beim Kompilieren NICHT
// auf. Deshalb wird hier jeder Skriptblock geparst (nur geparst, nicht ausgefuehrt), nachdem die
// Rust-Nahtstellen des `concat!` durch gleichwertige JS-Werte ersetzt wurden.
{
  // Vom Beginn des echten Skripts bis zu seinem Ende — nicht ueber Kommentare hinweg raten, die
  // dieselben Nahtstellen zitieren.
  const from = page.indexOf('window.__MOBILE_FIELD_SCHEMA__ = ');
  const to = page.indexOf('</script>', from);
  ok(from > 0 && to > from, 'PARSE the served script block was located');
  const js = page
    .slice(from, to)
    .split('"##, include_str!("mobile_field_schema.json"), r##"').join('{}')
    .split('"##, include_str!("mobile_upload_queue.js"), r##"').join('\n/* queue */\n');
  ok(js.length > 50_000, `PARSE …and it is the whole page script (${js.length} chars)`);
  let err = '';
  try { new Function(js); } catch (e) { err = String((e as Error).message); }
  ok(err === '', `PARSE the served page script parses — a typo in a Rust string literal never reaches the compiler (${err})`);
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — mobile live fixes: ${PASS} passed, ${FAIL} failed`);
if (FAIL) { for (const f of fails) console.log('   - ' + f); process.exit(1); }

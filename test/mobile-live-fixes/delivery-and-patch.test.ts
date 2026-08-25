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
ok(/async function showSavedState\(productId, seenUpdatedAt, msg\)/.test(page),
  'SAVED the page has one place that shows the saved state');
ok(/String\(fresh\.updated_at \|\| ''\) !== String\(seenUpdatedAt \|\| ''\)/.test(page),
  'SAVED it waits for the server to report a NEWER state, it does not guess');
ok(/showProduct\(fresh, currentOrigin, 'fresh'\)/.test(page),
  'SAVED …and then draws exactly that state');
ok((page.match(/showSavedState\(p\.id, seenUpdatedAt, msg\);/g) || []).length === 2,
  'SAVED both success paths use it — the plain edit and the one that rides along with the gallery');
ok(/the desktop has not applied it yet/.test(page),
  'SAVED …and if it never arrives, the page says so instead of pretending');

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

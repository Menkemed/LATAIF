// COLLECTIONS-S1 — RAM-Cache der Kartenbilder (src/core/media/card-image-cache.ts).
// Prüft: Treffer/Fehlschlag, nur EIN Bild je Artikel, Ersetzen widerruft das alte, Byte- und
// Anzahl-Grenze mit LRU, nie Widerruf unter einer gezeigten Karte, Scope-Wechsel/clear leert,
// jede erzeugte URL wird genau einmal widerrufen.
// Run: node test/media-thumb/card-image-cache.test.ts
import { CardImageCache, CARD_CACHE_MAX_BYTES, CARD_CACHE_MAX_ENTRIES } from '../../src/core/media/card-image-cache.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

function harness(maxBytes?: number, maxEntries?: number) {
  let n = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const cache = new CardImageCache({
    createObjectURL: () => { const u = `blob:u${++n}`; created.push(u); return u; },
    revokeObjectURL: (u) => { revoked.push(u); },
    maxBytes, maxEntries,
  });
  return { cache, created, revoked };
}
const blob = (size: number) => new Blob([new Uint8Array(size)], { type: 'image/jpeg' });

// ── Grenzen ────────────────────────────────────────────────────────────────
check(CARD_CACHE_MAX_BYTES === 64 * 1024 * 1024, 'Grenze 64 MiB');
check(CARD_CACHE_MAX_ENTRIES === 1000, 'Grenze 1000 Einträge');

// ── Treffer / Fehlschlag / Ersetzen ─────────────────────────────────────────
{
  const { cache, revoked } = harness();
  cache.setScope('local|t|b');
  check(cache.get('p1') === undefined, 'leer: kein Treffer');
  const a = cache.put('p1', blob(10), 'media:A');
  const hit = cache.get('p1');
  check(hit?.url === a.url && hit?.fingerprint === 'media:A', 'Treffer liefert URL + Fingerabdruck');
  check(cache.stats().bytes === 10 && cache.stats().entries === 1, 'Bytes gezählt');
  const b = cache.put('p1', blob(20), 'media:B');
  check(cache.get('p1')?.url === b.url, 'Ersetzen: neues Bild');
  check(revoked.includes(a.url), 'Ersetzen: altes (nicht gezeigtes) widerrufen');
  check(cache.stats().entries === 1 && cache.stats().bytes === 20, 'nur ein Bild je Artikel');
  cache.delete('p1');
  check(cache.get('p1') === undefined && revoked.includes(b.url), 'delete widerruft');
  check(cache.stats().bytes === 0 && cache.stats().liveUrls === 0, 'nichts übrig');
}

// ── Gezeigte URL wird nie darunter widerrufen ───────────────────────────────
{
  const { cache, revoked } = harness();
  cache.setScope('s');
  const a = cache.put('p1', blob(5), 'media:A');
  cache.acquire(a.url);
  cache.put('p1', blob(5), 'media:B');
  check(!revoked.includes(a.url), 'ersetzt, aber gezeigt: noch nicht widerrufen');
  check(cache.stats().liveUrls === 2, 'alte URL lebt bis release');
  cache.release(a.url);
  check(revoked.includes(a.url), 'release der zurückgezogenen URL widerruft');
  // zweifach gezeigt
  const c = cache.get('p1')!;
  cache.acquire(c.url); cache.acquire(c.url);
  cache.clear();
  check(!revoked.includes(c.url), 'clear: gezeigte URL bleibt');
  cache.release(c.url);
  check(!revoked.includes(c.url), 'erst ein release von zweien');
  cache.release(c.url);
  check(revoked.includes(c.url), 'letztes release widerruft');
  check(cache.stats().liveUrls === 0 && cache.stats().bytes === 0, 'clear vollständig');
}

// ── Byte-Grenze + LRU ───────────────────────────────────────────────────────
{
  const { cache, revoked } = harness(100, 1000);
  cache.setScope('s');
  const p1 = cache.put('p1', blob(40), 'f');
  const p2 = cache.put('p2', blob(40), 'f');
  cache.get('p1'); // p1 zuletzt benutzt → p2 ist der älteste
  const p3 = cache.put('p3', blob(40), 'f');
  check(revoked.includes(p2.url) && !revoked.includes(p1.url) && !revoked.includes(p3.url), 'LRU verdrängt den ältesten (p2)');
  check(cache.stats().bytes <= 100, 'Byte-Grenze eingehalten');
  // gezeigte Einträge werden übersprungen
  cache.acquire(p1.url);
  const p4 = cache.put('p4', blob(40), 'f');
  check(!revoked.includes(p1.url) && revoked.includes(p3.url), 'gezeigter p1 bleibt, p3 verdrängt');
  // Überhang nur solange gezeigt
  cache.acquire(p4.url);
  cache.put('p5', blob(40), 'f'); // p1+p4 gezeigt (80) + p5 (40) = 120 > 100 → p5 selbst verdrängt
  check(cache.stats().bytes <= 100, 'neuer, nicht gezeigter Eintrag weicht, wenn nur Gezeigte übrig');
  cache.release(p1.url);
  check(cache.stats().bytes <= 100, 'nach release unter der Grenze');
}

// ── Übergabe (`hold`): ein neues Bild überlebt, bis seine Karte es hält ─────
{
  const { cache, revoked } = harness(100, 1000);
  cache.setScope('s');
  const a = cache.put('a', blob(60), 'f'); cache.acquire(a.url);
  const b = cache.put('b', blob(60), 'f', true); // Grenze überschritten, a gezeigt, b in Übergabe
  check(!revoked.includes(b.url) && !revoked.includes(a.url), 'Übergabe: neues Bild nicht sofort verdrängt');
  cache.acquire(b.url);   // die Karte übernimmt
  cache.release(b.url);   // Übergabe zurück
  check(!revoked.includes(b.url), 'gezeigt nach Übergabe: bleibt (Überhang nur solange gezeigt)');
  cache.release(b.url);   // Karte weg
  check(revoked.includes(b.url) && cache.stats().bytes <= 100, 'nicht mehr gezeigt: Grenze wieder eingehalten');
  const c = cache.put('c', blob(60), 'f', true);
  cache.release(c.url);   // niemand hat übernommen (Karte schon weg)
  check(revoked.includes(c.url) && !revoked.includes(a.url) && cache.stats().bytes <= 100, 'Übergabe ohne Abnehmer: normal verdrängbar, gezeigtes a bleibt');
}

// ── Anzahl-Grenze ───────────────────────────────────────────────────────────
{
  const { cache } = harness(1e9, 3);
  cache.setScope('s');
  for (let i = 0; i < 10; i++) cache.put(`p${i}`, blob(1), 'f');
  check(cache.stats().entries === 3, 'Anzahl-Grenze 3');
  check(cache.get('p9') && cache.get('p8') && cache.get('p7') && !cache.get('p0'), 'die jüngsten bleiben');
}

// ── Scope-Wechsel leert (Filialwechsel / Abmeldung / neue DB-Epoche) ────────
{
  const { cache, created, revoked } = harness();
  cache.setScope('local|t|b1');
  cache.put('p1', blob(3), 'f');
  cache.put('p2', blob(3), 'f');
  cache.setScope('local|t|b1');
  check(cache.stats().entries === 2, 'gleicher Scope: bleibt');
  cache.setScope('local|t|b2');
  check(cache.stats().entries === 0 && cache.get('p1') === undefined, 'anderer Scope: leer');
  check(cache.currentScope === 'local|t|b2', 'Scope übernommen');
  check(created.every((u) => revoked.includes(u)), 'jede URL widerrufen');
  check(new Set(revoked).size === revoked.length, 'keine URL doppelt widerrufen');
}

// ── Großlauf: 460 Kartenbilder à 100 000 B passen unter die Standardgrenze ───
{
  const { cache, created, revoked } = harness();
  cache.setScope('s');
  for (let i = 0; i < 460; i++) cache.put(`p${i}`, blob(100_000), 'f');
  check(cache.stats().entries === 460 && revoked.length === 0, '460 x 100 KB = 46 MB < 64 MiB: nichts verdrängt');
  for (let i = 460; i < 800; i++) cache.put(`p${i}`, blob(100_000), 'f');
  check(cache.stats().bytes <= CARD_CACHE_MAX_BYTES, '800 x 100 KB: unter 64 MiB gehalten');
  check(cache.stats().entries === Math.floor(CARD_CACHE_MAX_BYTES / 100_000), `genau ${Math.floor(CARD_CACHE_MAX_BYTES / 100_000)} Einträge`);
  cache.clear();
  check(created.length === revoked.length && cache.stats().bytes === 0, 'clear gibt alle frei');
}

console.log(`card-image-cache: ${pass} passed, ${fail.length} failed`);
if (fail.length) { for (const f of fail) console.log('  FAIL ' + f); process.exit(1); }

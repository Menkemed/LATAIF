// PRE-G5 MOBILE REPAIR — die Oberflaeche des Telefons, deterministisch nachgespielt.
//
// Warum: `mobile_repair_ui.js` wird woertlich in die Handy-Seite eingebettet und laeuft dort in
// einem echten Browser. Ein Fehler darin kostet im Zwei-App-Lauf zehn Minuten je Versuch — hier
// kostet er zwei Sekunden. Die Datei wird mit einem kleinen DOM-Ersatz ausgefuehrt (dieselbe
// Bauweise wie `test/media04b2a9/upload-queue.test.ts`, das `mobile_upload_queue.js` prueft):
// echte Datei, echte Befehlslogik, erfundene Umgebung.
//
// Geprueft wird der WEG, den ein Mensch geht: neu erfassen → Kunde → Fotos → speichern → die
// Maske sagt, dass es geklappt hat; danach aendern → speichern → dieselbe Aussage. Genau diese
// Rueckmeldung ist im ersten E2E-Lauf ausgeblieben, obwohl der Primary laengst gebucht hatte.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let PASS = 0, FAIL = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): boolean => { if (c) PASS++; else { FAIL++; fails.push(m); console.log('  x ' + m); } return !!c; };

// ── Der DOM-Ersatz ──────────────────────────────────────────────────────────
// Er kann genau so viel, wie die Oberflaeche benutzt: Elemente mit Klassen, Text, Wert und
// Kindern. Was er NICHT kann, faellt sofort auf — ein fehlendes Stueck waere ein stiller Test.
class El {
  id = '';
  tagName = 'DIV';
  className = '';
  textContent = '';
  _innerHTML = '';
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v: string) { this._innerHTML = v; if (v === '') this.children = []; }
  value = '';
  disabled = false;
  style: Record<string, string> = {};
  children: El[] = [];
  onclick: ((ev?: unknown) => unknown) | null = null;
  onchange: ((ev?: unknown) => unknown) | null = null;
  onkeydown: ((ev?: unknown) => unknown) | null = null;
  files: unknown = null;
  attrs: Record<string, string> = {};
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
  get classList() {
    const self = this;
    const list = (): string[] => self.className.split(/\s+/).filter(Boolean);
    return {
      add(c: string) { if (!list().includes(c)) self.className = list().concat(c).join(' '); },
      remove(c: string) { self.className = list().filter((x) => x !== c).join(' '); },
      contains: (c: string) => list().includes(c),
      toggle(c: string, force?: boolean) {
        const soll = force === undefined ? !list().includes(c) : force;
        if (soll) this.add(c); else this.remove(c);
      },
    };
  }
  appendChild(child: El) { this.children.push(child); return child; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  dispatchEvent() { return true; }
  click() { return this.onclick ? this.onclick({ stopPropagation() {}, preventDefault() {} }) : undefined; }
  alleKinder(): El[] { return this.children.flatMap((c) => [c, ...c.alleKinder()]); }
}

function baueDom(htmlPfad: string) {
  const html = readFileSync(htmlPfad, 'utf8');
  const nach: Record<string, El> = {};
  for (const m of html.matchAll(/<(\w+)[^>]*\bid="([A-Za-z0-9_]+)"([^>]*)>/g)) {
    const el = new El(m[1]);
    el.id = m[2];
    const cls = /class="([^"]*)"/.exec(m[3] + ' ' + m[0]);
    el.className = cls ? cls[1] : '';
    nach[el.id] = el;
  }
  const document = {
    getElementById: (id: string) => nach[id] ?? null,
    createElement: (tag: string) => new El(tag),
    querySelectorAll: (sel: string): El[] => {
      if (sel === '[data-back-repair]') return Object.values(nach).filter((e) => e.id === '');
      const m = /^#([A-Za-z0-9_]+) (\w+)$/.exec(sel);
      if (m) {
        const wurzel = nach[m[1]];
        return wurzel ? wurzel.alleKinder().filter((c) => c.tagName === m[2].toUpperCase()) : [];
      }
      return [];
    },
  };
  return { document, nach };
}

// ── Umgebung ────────────────────────────────────────────────────────────────
function ladeModul(pfad: string): Record<string, unknown> {
  const src = readFileSync(pfad, 'utf8');
  const sand: Record<string, unknown> = {};
  new Function('self', src)(sand);
  return sand.MobileRepair as Record<string, unknown>;
}

interface Antwort { status: number; body: unknown }
function baueUmgebung(antworten: (url: string, body: unknown) => Antwort) {
  const gerufen: Array<{ url: string; body: unknown }> = [];
  const speicher = new Map<string, unknown>();
  const fetchFn = async (url: string, opts: { body?: string }) => {
    const rumpf = opts && opts.body ? JSON.parse(opts.body) : null;
    gerufen.push({ url, body: rumpf });
    const a = antworten(url, rumpf);
    return { status: a.status, json: async () => a.body } as unknown;
  };
  // Ein IndexedDB-Ersatz, der genau die Kette bedient, die die Oberflaeche benutzt.
  const indexedDB = {
    open() {
      const req: Record<string, unknown> = { result: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        transaction: () => ({
          objectStore: () => ({
            get: (k: string) => ({ __wert: speicher.get(k) ?? undefined }),
            put: (e: { key: string }) => { speicher.set(e.key, e); return { __wert: undefined }; },
            delete: (k: string) => { speicher.delete(k); return { __wert: undefined }; },
            getAll: () => ({ __wert: [...speicher.values()] }),
          }),
        }),
      };
      req.result = db;
      queueMicrotask(() => { const f = req.onsuccess as (() => void) | null; if (f) f(); });
      return req;
    },
  };
  const idbReq = async (r: { __wert: unknown }) => r.__wert;
  return { fetchFn, idbReq, indexedDB, gerufen, speicher };
}

function starteOberflaeche(antworten: (url: string, body: unknown) => Antwort) {
  const { document, nach } = baueDom(join(repo, 'src-tauri/src/sync/mobile_repair.html'));
  const MobileRepair = ladeModul(join(repo, 'src-tauri/src/sync/mobile_repair_commands.js'));
  const umgebung = baueUmgebung(antworten);
  const schirme: string[] = [];
  const src = readFileSync(join(repo, 'src-tauri/src/sync/mobile_repair_ui.js'), 'utf8');
  const fn = new Function(
    '$', 'show', 'hide', 'setText', 'screen', 'el', 'uuid', 'resizePhoto', 'TOKEN_KEY',
    'idbReq', 'MobileRepair', 'indexedDB', 'fetch', 'localStorage', 'document',
    src + '\n; return { rpHomeOpen };',
  );
  let nr = 0;
  const api = fn(
    (id: string) => document.getElementById(id),
    () => {}, () => {}, () => {},
    (id: string) => { schirme.push(id); },
    (tag: string, attrs: Record<string, string> | null, text?: string) => {
      const e = new El(tag);
      if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
      if (text != null) e.textContent = text;
      return e;
    },
    () => 'id-' + (++nr),
    async () => 'data:image/jpeg;base64,AAAA',
    'lataif_mobile_token',
    umgebung.idbReq, MobileRepair, umgebung.indexedDB, umgebung.fetchFn,
    { getItem: () => 'token-xyz', setItem: () => {}, removeItem: () => {} },
    document,
  );
  return { document, nach, MobileRepair, schirme, api, ...umgebung };
}

const warte = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

// ── §1 Erfassen: der Mensch sieht, dass gespeichert wurde ───────────────────
{
  const antworten = (url: string, body: unknown): Antwort => {
    const b = body as { op?: string } | null;
    if (/staging\/media/.test(url)) return { status: 201, body: { stagingId: 'a'.repeat(64) } };
    if (b?.op === 'customers.create') return { status: 200, body: { ok: true, value: { customerId: 'cust-1', name: 'Mo Kunde' } } };
    if (b?.op === 'repairs.create') return { status: 200, body: { ok: true, value: { repairId: 'rep-1', repairNumber: 'REP-2026-00007' } } };
    if (b?.op === 'repairs.get') {
      return { status: 200, body: { ok: true, value: { id: 'rep-1', repairNumber: 'REP-2026-00007', revision: 1, status: 'received', issueDescription: 'Krone lose', images: ['data:image/jpeg;base64,AAAA'], lines: [], openLineTotal: 0, allowedStatusTargets: ['diagnosed'] } } };
    }
    if (b?.op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [] } } };
    return { status: 200, body: { ok: true, value: {} } };
  };
  const t = starteOberflaeche(antworten);
  const $ = (id: string) => t.document.getElementById(id)!;

  $('rpNewBtn').click();
  await warte();
  $('rpCustomerFirst').value = 'Mo';
  $('rpCustomerLast').value = 'Kunde';
  await $('rpCustomerCreateBtn').onclick!();
  await warte();
  ok(!$('rpCustomerPicked').classList.contains('hidden'), '§1 der angelegte Kunde ist gewaehlt');

  $('rpIssue').value = 'Krone lose';
  await $('rpSaveBtn').onclick!();
  await warte();

  const erfolg = $('rpSuccess');
  ok(!erfolg.classList.contains('hidden'), '§1 die Maske MELDET den Erfolg (sichtbar)');
  ok(/REP-2026-00007/.test(erfolg.textContent), `§1 und nennt die Nummer des Primary (${erfolg.textContent})`);
  ok($('rpError').classList.contains('hidden'), '§1 kein Fehler daneben');
  const create = t.gerufen.filter((g) => (g.body as { op?: string })?.op === 'repairs.create');
  ok(create.length === 1, `§1 genau EIN Anlagebefehl (${create.length})`);
  ok($('rpSaveBtn').textContent === 'Save Changes', '§1 die Maske steht danach auf „Aendern"');
}

// ── §2 Aendern: dieselbe Rueckmeldung, gegen die gelesene Fassung ───────────
{
  let fassung = 4;
  const antworten = (url: string, body: unknown): Antwort => {
    const b = body as { op?: string; payload?: Record<string, unknown> } | null;
    if (/staging\/media/.test(url)) return { status: 201, body: { stagingId: 'b'.repeat(64) } };
    if (b?.op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'rep-9', repairNumber: 'REP-2026-00009', itemBrand: 'Rolex', itemModel: 'DJ', status: 'received' }] } } };
    if (b?.op === 'repairs.get') {
      return { status: 200, body: { ok: true, value: { id: 'rep-9', repairNumber: 'REP-2026-00009', revision: fassung, status: 'received', issueDescription: 'Glas kaputt', notes: '', images: ['data:image/jpeg;base64,AAAA'], lines: [], openLineTotal: 0, allowedStatusTargets: ['diagnosed'] } } };
    }
    if (b?.op === 'repairs.update') { fassung += 1; return { status: 200, body: { ok: true, value: { repairId: 'rep-9' } } }; }
    return { status: 200, body: { ok: true, value: {} } };
  };
  const t = starteOberflaeche(antworten);
  const $ = (id: string) => t.document.getElementById(id)!;

  await t.api.rpHomeOpen();
  await warte();
  const treffer = t.document.querySelectorAll('#rpList button');
  ok(treffer.length === 1, `§2 die Liste zeigt den Treffer (${treffer.length})`);
  await treffer[0].onclick!();
  await warte();
  ok($('rpIssue').value === 'Glas kaputt', '§2 die Maske traegt den gelesenen Stand');

  $('rpNotes').value = 'Am Schalter abgegeben';
  await $('rpSaveBtn').onclick!();
  await warte();

  const update = t.gerufen.filter((g) => (g.body as { op?: string })?.op === 'repairs.update');
  const rumpf = (update[0]?.body as { payload?: Record<string, unknown> })?.payload ?? {};
  ok(!$('rpSuccess').classList.contains('hidden'), '§2 die Aenderung wird bestaetigt');
  ok(update.length === 1, `§2 genau EIN Aenderungsbefehl (${update.length})`);
  ok(rumpf.expectedRevision === 4, `§2 er traegt die GELESENE Fassung (${String(rumpf.expectedRevision)})`);
  ok(rumpf.notes === 'Am Schalter abgegeben' && rumpf.issueDescription === undefined,
    `§2 nur das geaenderte Feld reist mit (${JSON.stringify(rumpf)})`);
  ok(rumpf.photos === undefined, '§2 unveraenderte Bilder → kein Bildplan im Rumpf');
}

// ── §3 Veralteter Stand: die Maske sagt es, statt zu ueberschreiben ─────────
{
  const antworten = (url: string, body: unknown): Antwort => {
    const b = body as { op?: string } | null;
    if (b?.op === 'repairs.get') {
      return { status: 200, body: { ok: true, value: { id: 'rep-3', repairNumber: 'REP-3', revision: 2, status: 'received', issueDescription: 'A', images: [], lines: [], openLineTotal: 0, allowedStatusTargets: [] } } };
    }
    if (b?.op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [{ id: 'rep-3', repairNumber: 'REP-3', status: 'received' }] } } };
    if (b?.op === 'repairs.update') return { status: 409, body: { ok: false, error: 'RECORD_CHANGED' } };
    return { status: 200, body: { ok: true, value: {} } };
  };
  const t = starteOberflaeche(antworten);
  const $ = (id: string) => t.document.getElementById(id)!;
  await t.api.rpHomeOpen();
  await warte();
  await t.document.querySelectorAll('#rpList button')[0].onclick!();
  await warte();
  $('rpNotes').value = 'ueberschreiben';
  await $('rpSaveBtn').onclick!();
  await warte();
  ok(!$('rpError').classList.contains('hidden') && /changed this repair in the meantime/.test($('rpError').textContent),
    `§3 veralteter Stand → klare Ansage statt stiller Ueberschreibung (${$('rpError').textContent})`);
  ok($('rpSuccess').classList.contains('hidden'), '§3 und kein falscher Erfolg daneben');
}

// ── §4 Verlorene Antwort: der Vorgang bleibt offen und sichtbar ─────────────
{
  let versuche = 0;
  const antworten = (url: string, body: unknown): Antwort => {
    const b = body as { op?: string } | null;
    if (b?.op === 'customers.create') return { status: 200, body: { ok: true, value: { customerId: 'c1', name: 'K' } } };
    if (b?.op === 'repairs.create') {
      versuche += 1;
      if (versuche === 1) return { status: 504, body: null };
      return { status: 200, body: { ok: true, value: { repairId: 'rep-7', repairNumber: 'REP-7', replayed: true } } };
    }
    if (b?.op === 'repairs.get') return { status: 200, body: { ok: true, value: { id: 'rep-7', repairNumber: 'REP-7', revision: 1, images: [], lines: [], openLineTotal: 0, allowedStatusTargets: [] } } };
    if (b?.op === 'repairs.list') return { status: 200, body: { ok: true, value: { items: [] } } };
    return { status: 200, body: { ok: true, value: {} } };
  };
  const t = starteOberflaeche(antworten);
  const $ = (id: string) => t.document.getElementById(id)!;
  $('rpNewBtn').click();
  await warte();
  $('rpCustomerFirst').value = 'K';
  await $('rpCustomerCreateBtn').onclick!();
  await warte();
  $('rpIssue').value = 'Batterie leer';
  await $('rpSaveBtn').onclick!();
  await warte();
  ok(/No answer from the main computer/.test($('rpError').textContent),
    `§4 keine Antwort → ehrliche Ansage (${$('rpError').textContent.slice(0, 60)})`);
  const offen = [...t.speicher.values()] as Array<{ state: string; commandId: string }>;
  ok(offen.length === 1 && offen[0].state === 'unresolved', `§4 der Vorgang bleibt durabel offen (${JSON.stringify(offen.map((o) => o.state))})`);

  await t.api.rpHomeOpen();
  await warte();
  const knoepfe = t.document.querySelectorAll('#rpOpenList button');
  ok(knoepfe.length === 1, `§4 er steht in der Leiste „Unresolved saves" (${knoepfe.length})`);
  const kennungVorher = offen[0].commandId;
  await knoepfe[0].onclick!();
  await warte();
  const create = t.gerufen.filter((g) => (g.body as { op?: string })?.op === 'repairs.create');
  ok(create.length === 2 && (create[0].body as { commandId: string }).commandId === (create[1].body as { commandId: string }).commandId
    && (create[1].body as { commandId: string }).commandId === kennungVorher,
    '§4 „Clarify now" wiederholt DIESELBE Kennung — kein zweiter Vorgang');
  ok(t.speicher.size === 0, `§4 nach dem Erfolg ist der Vorgang abgeschlossen (${t.speicher.size})`);
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — preg5 mobile repair ui: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PRE_G5_MOBILE_REPAIR_UI_PROVED');

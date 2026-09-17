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
import { shouldAdoptRecord } from '../../src/core/data/form-sync.ts';
import {
  isOwnWorkLine, ownWorkDescription, showsInternalCostRow, workTypeLabel,
  OWN_WORK_KIND, OWN_WORK_SOURCE,
} from '../../src/core/repairs/repair-line-view.ts';
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
  /** Die Maske holt den Blick zu einer Meldung — der Ersatz merkt sich nur, DASS sie es tut. */
  scrolls = 0;
  scrollIntoView() { this.scrolls += 1; }
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

// ── §5 Ungespeicherte Eingaben ueberleben eine Werkstatthandlung (Telefon) ──
//
// Der Fund aus dem Handlauf: tippen, dann „Add work line" — und das Getippte war weg. Die Maske
// liest nach jeder Handlung neu und fuellte dabei ALLE Kopffelder aus dem gespeicherten Stand.
// Danach sah „Save Changes" keine Aenderung mehr („Nothing changed.") und die Arbeit war verloren,
// ohne dass es jemand gemerkt haette — die Meldung stand ausserdem weit ausserhalb des Bildes.
{
  const stand = (revision: number, diagnosis: string, notes: string) => ({
    id: 'rep-1', repairNumber: 'REP-2026-00007', revision, status: 'received',
    issueDescription: 'Krone lose', diagnosis, notes, itemBrand: 'Rolex',
    images: ['data:image/jpeg;base64,GESPEICHERT'], lines: [], openLineTotal: 0,
    allowedStatusTargets: ['diagnosed'],
  });
  let fassung = 4;
  let notizenImStand = 'vom Primary';
  const antworten = (url: string, body: unknown): Antwort => {
    const b = body as { op?: string } | null;
    if (/staging\/media/.test(url)) return { status: 201, body: { stagingId: 'b'.repeat(64) } };
    if (b?.op === 'repairs.get') return { status: 200, body: { ok: true, value: stand(fassung, '', notizenImStand) } };
    if (b?.op === 'repairs.add_line') { fassung += 1; notizenImStand = 'vom Primary (neu)'; return { status: 200, body: { ok: true, value: {} } }; }
    if (b?.op === 'repairs.update_status') { fassung += 1; return { status: 200, body: { ok: true, value: {} } }; }
    if (b?.op === 'repairs.update') { fassung += 1; return { status: 200, body: { ok: true, value: {} } }; }
    if (b?.op === 'repairs.list') {
      return { status: 200, body: { ok: true, value: { items: [{ id: 'rep-1', repairNumber: 'REP-2026-00007', itemBrand: 'Rolex', itemModel: '', status: 'received' }] } } };
    }
    return { status: 200, body: { ok: true, value: { items: [] } } };
  };
  const t = starteOberflaeche(antworten);
  const $ = (id: string) => t.document.getElementById(id)!;
  await t.api.rpHomeOpen();
  await warte();
  await t.nach.rpList.alleKinder().find((e: El) => e.tagName === 'BUTTON')?.onclick?.();
  await warte();

  // Der Mensch tippt — und haengt ein Foto an, das noch nirgends gespeichert ist.
  $('rpDiagnosis').value = 'Krone neu verschraubt';
  t.nach.rpPhotoInput.files = [{}];
  await t.nach.rpPhotoInput.onchange!({ target: { files: [{}] } });
  await warte();
  const fotosVorher = (t.MobileRepair as { MAX_PHOTOS: number }) && $('rpPhotoStatus').textContent;

  // …und fuehrt DANACH eine Werkstatthandlung aus, die den Stand neu liest.
  $('rpLineCost').value = '12.5';
  await $('rpLineAddBtn').onclick!();
  await warte();

  ok($('rpDiagnosis').value === 'Krone neu verschraubt',
    '§5 das GETIPPTE Kopffeld ueberlebt die Werkstatthandlung (' + $('rpDiagnosis').value + ')');
  ok($('rpNotes').value === 'vom Primary (neu)',
    '§5 …ein NICHT angefasstes Feld kommt frisch vom Primary (' + $('rpNotes').value + ')');
  ok($('rpPhotoStatus').textContent === fotosVorher && /2 \/ 6/.test($('rpPhotoStatus').textContent),
    '§5 …und das neue, noch nicht gespeicherte Foto steht weiter da (' + $('rpPhotoStatus').textContent + ')');
  ok(/unsaved entries are still here/.test($('rpSuccess').textContent),
    '§5 …die Maske sagt es auch, statt es stumm zu tun');

  // Und die Antwort auf „Save Changes" holt den Blick zu sich — der Knopf steht unten, die
  // Meldung oben; im echten Browser lagen 2498 px dazwischen.
  const vorherScrolls = $('rpSuccess').scrolls + $('rpError').scrolls;
  await $('rpSaveBtn').onclick!();
  await warte();
  ok($('rpSuccess').scrolls + $('rpError').scrolls > vorherScrolls,
    '§5 die Speicher-Antwort wird in den sichtbaren Bereich geholt');
  const update = t.gerufen.filter((g) => (g.body as { op?: string })?.op === 'repairs.update');
  const rumpf = update.length ? (update[0].body as { payload: Record<string, unknown> }).payload : {};
  ok(update.length === 1 && rumpf.diagnosis === 'Krone neu verschraubt' && !('notes' in rumpf),
    '§5 …und gespeichert wird genau das Getippte, nichts sonst (' + JSON.stringify(rumpf) + ')');
}

// ── §6 Dieselbe Regel am Rechner (PC2 und Primary) ──────────────────────────
//
// Die React-Maske hielt es genauso falsch: ihre Arbeitskopie folgte der Objektreferenz des
// Ladens — und die ist nach JEDEM Neuladen neu (eigene Handlung ODER eingespielte fremde
// Aenderung, sync-service). Die Regel steht jetzt an einer Stelle und wird hier AUSGEFUEHRT,
// nicht im Quelltext gesucht.
{
  const a = { id: 'rep-1', revision: 4 };
  const b = { id: 'rep-1', revision: 4 };   // gleiche Daten, frisches Objekt — genau das liefert loadRepairs()
  ok(shouldAdoptRecord(a, undefined, false), '§6 beim ersten Laden uebernimmt die Maske den Datensatz');
  ok(!shouldAdoptRecord(a, a, false), '§6 dieselbe Referenz uebernimmt sie nicht noch einmal');
  ok(!shouldAdoptRecord(b, a, true), '§6 waehrend des Bearbeitens wird NICHT uebernommen — die Eingabe bleibt stehen');
  ok(shouldAdoptRecord(b, a, false), '§6 …nach Save oder Cancel greift die Uebernahme sofort wieder');
  ok(!shouldAdoptRecord(undefined, a, false), '§6 ohne Datensatz gibt es nichts zu uebernehmen');

  const detail = readFileSync(join(repo, 'src/pages/repairs/RepairDetail.tsx'), 'utf8');
  ok(/if \(shouldAdoptRecord\(repair, formVon, editing\)\) \{/.test(detail),
    '§6 die Maske fragt genau diese Regel — keine zweite Bedingung im Bauch der Komponente');
  ok(!/if \(repair && repair !== formVon\) \{/.test(detail),
    '§6 …und die alte, bedingungslose Uebernahme ist weg');
  // Der Schutz gegen fremde Aenderungen bleibt, wo er hingehoert: an der Fassung.
  ok(/expectedRevision: fassung/.test(detail) && /fassungOderNichts\(/.test(detail),
    '§6 jede Handlung schickt weiter die GELESENE Fassung mit');
  const svc = readFileSync(join(repo, 'src/core/bridge/service-commands.ts'), 'utf8');
  ok(/'RECORD_CHANGED',/.test(svc),
    '§6 …und ein veralteter Stand bleibt ein RECORD_CHANGED des Primary');
}

// ══════════════════════════════════════════════════════════════════════════════
// §7 — Kostenkarte der Reparatur: eigene Arbeit heisst auch so (NUR Darstellung)
//
// Eine im Haus gearbeitete Zeile trug ihre Arbeitsart als „Kind" und in der Quellenspalte ein
// blasses „— own cost"; die Pauschale des Kopfes sah fast genauso aus und stand selbst dann da,
// wenn sie 0,000 war. Jetzt: Kind „In-house", Quelle „Internal labor / own work", Beschreibung
// = Arbeitsart und Notiz — und die Pauschale nur, wenn es sie wirklich gibt.
// Gerechnet und gebucht wird NICHTS anders; das ist hier mitbewiesen.
// ══════════════════════════════════════════════════════════════════════════════
{
  const polieren = { workType: 'polishing', description: 'Gehaeuse und Band, Hochglanz' };
  ok(isOwnWorkLine(polieren), '§7 eine Arbeitszeile ohne Lieferant ist eigene Arbeit');
  ok(ownWorkDescription(polieren) === 'Polishing — Gehaeuse und Band, Hochglanz',
    `§7 …und die Beschreibung nennt Arbeitsart UND Notiz (${ownWorkDescription(polieren)})`);
  ok(OWN_WORK_KIND === '🏠 In-house' && OWN_WORK_SOURCE === 'Internal labor / own work',
    `§7 …unter „In-house" mit der Quelle des eigenen Hauses (${OWN_WORK_KIND} / ${OWN_WORK_SOURCE})`);

  const ohneNotiz = { workType: 'polishing', description: '' };
  ok(ownWorkDescription(ohneNotiz) === 'Polishing',
    `§7 ohne Notiz bleibt es bei der Arbeitsart — kein einsamer Gedankenstrich (${ownWorkDescription(ohneNotiz)})`);
  ok(ownWorkDescription({ description: 'ohne Art' }) === 'Other — ohne Art',
    '§7 …und eine Zeile ohne Arbeitsart faellt auf „Other", statt leer zu bleiben');
  ok(workTypeLabel('spare_part') === 'Spare Part',
    '§7 die Arbeitsart wird geschrieben wie in der Auswahl der Maske');

  ok(!showsInternalCostRow('internal', 0) && !showsInternalCostRow('hybrid', 0),
    '§7 ohne Pauschale (Internal Cost = 0) gibt es KEINE Pauschalen-Zeile mehr');
  ok(showsInternalCostRow('internal', 12.5) && showsInternalCostRow('hybrid', 0.001),
    '§7 …mit Pauschale steht sie weiterhin da');
  ok(!showsInternalCostRow('external', 12.5),
    '§7 …und eine reine Fremdreparatur hat ohnehin keine');

  // Fremde Zeilen bleiben, wie sie waren — Lieferant, Material, Goldschuld.
  ok(!isOwnWorkLine({ workType: 'polishing', supplierId: 'sup-1' }),
    '§7 eine Zeile MIT Lieferant ist keine Hauszeile — sie zeigt weiter den Lieferanten');
  ok(!isOwnWorkLine({ materialKind: 'diamond', description: 'Round Brilliant' }),
    '§7 …und eine Materialzeile behaelt ihre eigene Art (Diamond), auch ohne Lieferant');
  ok(!isOwnWorkLine({ materialKind: 'gold', description: 'Goldschuld' }),
    '§7 …auch die Goldzeile, deren A/P-Spalte „Gold debt" nennt');

  const detail7 = readFileSync(join(repo, 'src/pages/repairs/RepairDetail.tsx'), 'utf8');
  ok(/const showInHouseRow = showsInternalCostRow\(repair\.repairType, inHouseCost\);/.test(detail7)
    && !/const showInHouseRow = repair\.repairType === 'internal'/.test(detail7),
    '§7 die Karte fragt genau diese Regel — die alte, bedingungslose Zeile ist weg');
  ok(/const eigeneArbeit = isOwnWorkLine\(l\);/.test(detail7)
    && /eigeneArbeit \? OWN_WORK_KIND/.test(detail7)
    && /eigeneArbeit \? OWN_WORK_SOURCE/.test(detail7)
    && /eigeneArbeit \? ownWorkDescription\(l\)/.test(detail7),
    '§7 …und die drei Spalten kommen aus derselben Stelle, nicht aus drei Bedingungen im Bauch');
  // Beweis, dass nur die Beschriftung angefasst wurde: die Summe zaehlt weiter Zeilen + Pauschale.
  ok(/const totalCost = explicitLines\.reduce\(\(s, l\) => s \+ \(l\.costAmount \|\| 0\), 0\) \+ inHouseCost;/.test(detail7),
    '§7 die Kostensumme ist unveraendert — es wurde nichts umgerechnet');
  ok(!/repair-line-view/.test(readFileSync(join(repo, 'src/core/repairs/repair-cost.ts'), 'utf8')),
    '§7 …und die Rechnung des Hauses weiss von dieser Beschriftung nichts');
}

console.log(`\n${FAIL === 0 ? 'PASS' : 'FAIL'} — preg5 mobile repair ui: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('PRE_G5_MOBILE_REPAIR_UI_PROVED');

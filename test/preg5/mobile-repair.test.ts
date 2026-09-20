// ════════════════════════════════════════════════════════════════════════════
// PRE-G5 MOBILE REPAIR — die Befehlsseite des Telefons, ohne DOM und ohne Primary.
// Run: node test/preg5/mobile-repair.test.ts
//
// Warum es diese Pruefung gibt: das Telefon hatte frueher eine ZWEITE Reparaturlogik — es erfand
// eine Nummer (`REP-MOB-…`), einen Gutscheincode und schrieb selbst. Zwei Stellen, die dasselbe
// tun, laufen auseinander. Seit PRE-G5 stellt das Telefon nur noch Auftraege; Nummer, Status,
// Filiale, Mandant und alle Betraege macht der Primary.
//
// Geprueft wird deshalb DREIERLEI:
//   §1 was ein Rumpf traegt — und vor allem, was er NIE tragen darf,
//   §2 dass ein Auftrag genau einmal wirkt, auch wenn die Antwort verlorengeht (der einzige Grund,
//      warum die Kennung durabel abgelegt wird, bevor etwas hinausgeht),
//   §3 dass die AI nur vorschlaegt und nie ueberschreibt,
//   §4 dass die alte Schreibseite nicht durch die Hintertuer zurueckkommt (Quelltext-Nagel).
//
// Echte Module: `mobile_repair_commands.js` (woertlich dieselbe Datei, die in die Handy-Seite
// eingebettet wird). Speicher und `fetch` sind nachgebildet — das Telefon hat sie ohnehin von
// aussen gereicht bekommen, genau damit das hier pruefbar ist.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { materialDetailText } from '../../src/core/repairs/repair-line-view.ts';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath, join } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => readFileSync(join(repo, p), 'utf8').replace(/\r\n/g, '\n');

let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const groups: Array<[string, number]> = [];
let mark = 0;
const group = (name: string): void => { groups.push([name, PASS - mark]); mark = PASS; };

/** Eigener, stabiler Vergleich — die Pruefung darf sich nicht auf `stableJson` des Prueflings stuetzen. */
const J = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(J).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort()
      .map((k) => JSON.stringify(k) + ':' + J((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v) ?? 'null';
};

// ── Der Pruefling: dieselbe Datei, die die Handy-Seite einbettet ─────────────
type Rec = { key: string; commandId: string; op: string; payload: unknown; state: string; lastCode?: string };
type Out = { kind: string; code?: string; value?: unknown; status?: number; commandId?: string; record?: Rec };
interface Api {
  MAX_PHOTOS: number;
  CREATE_FIELDS: string[]; EDIT_FIELDS: string[]; AI_FIELDS: string[]; MONEY_FIELDS: string[];
  stableJson(v: unknown): string;
  textOrNull(v: unknown): string | null;
  moneyOrNull(v: unknown): number | null;
  createBody(form: Record<string, unknown>, ids?: string[]): Record<string, unknown>;
  photoPlan(slots: unknown[]): Array<{ keep?: number; stagingId?: string }>;
  photosUnchanged(plan: unknown[], stored: number): boolean;
  editBody(repair: Record<string, unknown>, form: Record<string, unknown>, plan?: unknown[]): Record<string, unknown>;
  editHasChanges(body: Record<string, unknown>): boolean;
  applyAiSuggestions(form: Record<string, unknown>, s: unknown): number;
  lineText(line: Record<string, unknown>): string;
  materialDetailText(line: Record<string, unknown>): string;
  classify(status: number, body: unknown): { kind: string; code: string };
  createClient(deps: Record<string, unknown>): {
    read(op: string, input?: unknown): Promise<{ ok: boolean; value?: unknown; status?: number; code?: string }>;
    stagePhoto(dataUrl: string): Promise<{ ok: boolean; stagingId?: string; code?: string }>;
    mutate(key: string, op: string, payload: unknown, opts?: { clarify?: boolean }): Promise<Out>;
    openIntents(): Promise<Rec[]>;
  };
}
// Geladen wird die Datei WOERTLICH — so, wie die Handy-Seite sie einbettet: ausgewertet in einem
// leeren Fenster-Ersatz, der danach `MobileRepair` traegt. (Ein `require` geht nicht: das Paket ist
// `type: module`, und dann ist in der Datei weder `module` noch `this` gesetzt. Derselbe Weg wie in
// `test/media04b2a9/upload-queue.test.ts`.)
const sandbox: { MobileRepair?: Api } = {};
new Function('self', src('src-tauri/src/sync/mobile_repair_commands.js'))(sandbox);
const M = sandbox.MobileRepair!;

// ══════════════════════════════════════════════════════════════════════════════
// §1 — was ein Rumpf traegt, und was er niemals traegt
// ══════════════════════════════════════════════════════════════════════════════

// Alles, was der PRIMARY setzt. Kaeme eines davon vom Telefon, haette das Haus wieder zwei
// Wahrheiten ueber dieselbe Reparatur.
const VERBOTEN = ['id', 'repairNumber', 'voucherCode', 'status', 'branchId', 'tenantId', 'userId',
  'createdBy', 'revision', 'margin', 'internalCost', 'productId', 'repairScope', 'taxScheme'];

{
  // Ein Formular, das ALLES enthaelt, was ein Angreifer oder ein unachtsamer Umbau hineinlegen
  // koennte — der Rumpf darf trotzdem nur die erlaubten Felder zeigen.
  const form: Record<string, unknown> = {
    customerId: 'cust-1', itemBrand: 'Rolex', itemModel: '   ', itemSerial: '  S-9  ',
    issueDescription: 'does not run', notes: '', estimatedCost: '12,5', estimatedReady: '2026-01-02',
    id: 'rep-hack', repairNumber: 'REP-0001', voucherCode: 'VC-1', status: 'DELIVERED',
    branchId: 'branch-x', tenantId: 'tenant-x', userId: 'user-x', createdBy: 'user-x',
    revision: 7, margin: 999, internalCost: 111, productId: 'prod-1', repairScope: 'INTERNAL',
    taxScheme: 'MARGIN', diagnosis: 'never in a create',
  };
  const body = M.createBody(form);
  ok(body.customerId === 'cust-1' && body.itemBrand === 'Rolex' && body.issueDescription === 'does not run',
    '§1 createBody traegt die erlaubten Felder');
  ok(body.itemSerial === 'S-9', '§1 …getrimmt, nicht roh');
  ok(!('itemModel' in body) && !('notes' in body),
    '§1 ein leeres Feld reist gar nicht mit (kein leerer Text, der etwas loeschen wuerde)');
  ok(body.estimatedCost === 12.5 && typeof body.estimatedCost === 'number',
    `§1 Geld wird gelesen, nicht durchgereicht ("12,5" → ${String(body.estimatedCost)})`);
  const durchgerutscht = VERBOTEN.filter((k) => k in body);
  ok(durchgerutscht.length === 0,
    `§1 KEIN Feld des Primary im Rumpf einer Neuanlage (durchgerutscht: ${durchgerutscht.join(', ') || 'keins'})`);
  ok(!('diagnosis' in body), '§1 auch ein echtes Repair-Feld, das nur zur Aenderung gehoert, bleibt draussen');
  ok(J(Object.keys(body).sort()) === J(Object.keys(body).filter((k) => M.CREATE_FIELDS.includes(k)).sort()),
    '§1 der Rumpf ist eine Teilmenge von CREATE_FIELDS — nichts ausserhalb der Erlaubnisliste');
}

{
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  const body = M.createBody({ issueDescription: 'x' }, [a, b]);
  ok(J(body.photos) === J([{ stagingId: a }, { stagingId: b }]),
    '§1 Fotos einer Neuanlage sind reine Staging-Kennungen, in der Reihenfolge des Benutzers');
  ok(!JSON.stringify(body.photos).includes('keep'),
    '§1 …und nie `keep` — bei einer Neuanlage gibt es keine gespeicherte Liste, auf die man zeigen koennte');
  const viele = M.createBody({ issueDescription: 'x' }, Array.from({ length: 9 }, (_, i) => String(i).repeat(64)));
  ok(M.MAX_PHOTOS === 6 && (viele.photos as unknown[]).length === 6,
    `§1 mehr als ${M.MAX_PHOTOS} Fotos werden abgeschnitten, statt den Primary ablehnen zu lassen`);
  ok(J((viele.photos as Array<{ stagingId: string }>)[0].stagingId) === J('0'.repeat(64)),
    '§1 …abgeschnitten wird hinten, die ersten bleiben (das erste ist das Titelbild)');
  ok(!('photos' in M.createBody({ issueDescription: 'x' }, [])),
    '§1 ohne Fotos trägt der Rumpf kein leeres `photos` (das hiesse am Primary „alle loeschen")');
}

{
  // Der gelesene Stand und ein Formular, das nur an einer Stelle abweicht.
  const repair: Record<string, unknown> = {
    id: 'rep-1', revision: 4, diagnosis: 'crown worn', notes: 'in the safe', estimatedCost: 10,
    actualCost: null, chargeToCustomer: null, repairType: 'WORKSHOP', workshopSupplierId: 'sup-1',
    estimatedReady: '2026-02-01', itemBrand: 'Rolex', itemModel: 'Sub', itemReference: '116610',
    itemSerial: 'S-1', itemDescription: 'steel', issueDescription: 'does not run',
    images: [],
    // MEDIA-REPAIR — die Galerie sind Referenzen: stabile Medienkennungen, nie Bytes.
    mediaIds: ['media-a', 'media-b'],
    mediaKeys: ['tenant-1/aa/a.jpg', 'tenant-1/bb/b.jpg'],
  };
  // Das Formular liest ALLES als Text — genau wie ein `<input>`. Dass daraus keine Scheinaenderung
  // wird, ist die eigentliche Aussage hier.
  const form: Record<string, unknown> = {};
  for (const k of M.EDIT_FIELDS) form[k] = repair[k] === null || repair[k] === undefined ? '' : String(repair[k]);
  const behalten = M.photoPlan([{ keep: 'media-a' }, { keep: 'media-b' }]);

  const gleich = M.editBody(repair, form, behalten);
  ok(J(gleich) === J({ id: 'rep-1', expectedRevision: 4 }),
    `§1 nichts geaendert → nur Kennung und Fassung (${J(gleich)})`);
  ok(M.editHasChanges(gleich) === false,
    '§1 …und editHasChanges sagt Nein — das Telefon sendet gar nicht erst');
  ok(gleich.expectedRevision === 4,
    '§1 die Fassung reist IMMER mit — ohne sie koennte eine fremde Aenderung still ueberschrieben werden');

  const form2 = { ...form, diagnosis: 'balance staff broken', itemBrand: '' };
  const geaendert = M.editBody(repair, form2, behalten);
  ok(geaendert.diagnosis === 'balance staff broken', '§1 das geaenderte Feld reist mit');
  ok(!('notes' in geaendert) && !('estimatedCost' in geaendert) && !('workshopSupplierId' in geaendert),
    '§1 unveraenderte Felder bleiben WEG — der Primary mischt ueber den gelesenen Stand, ein Weglassen aendert nichts');
  ok('itemBrand' in geaendert && geaendert.itemBrand === null,
    '§1 ein GELEERTES Feld reist als `null` (ausdrueckliches Loeschen), nicht als Auslassung');
  ok(M.editHasChanges(geaendert) === true, '§1 …jetzt gibt es etwas zu senden');
  ok(VERBOTEN.filter((k) => k !== 'id' && k !== 'revision').every((k) => !(k in geaendert)) && !('revision' in geaendert),
    '§1 auch die Aenderung traegt kein Feld des Primary (nur `id` + `expectedRevision`)');

  ok(M.photosUnchanged(behalten, ['media-a', 'media-b']) === true && !('photos' in geaendert),
    '§1 unveraenderte Bilder → gar kein `photos` (ein Plan, der nichts aendert, wird nicht gesendet)');
  const gedreht = M.photoPlan([{ keep: 'media-b' }, { keep: 'media-a' }]);
  ok(M.photosUnchanged(gedreht, ['media-a', 'media-b']) === false
    && J(M.editBody(repair, form, gedreht).photos) === J([{ keep: 'media-b' }, { keep: 'media-a' }]),
    '§1 …nur umsortiert ist schon eine Aenderung (das erste Bild ist das Titelbild)');
  const gemischt = M.photoPlan([{ keep: 'media-b' }, { stagingId: 'c'.repeat(64) }, { keep: 'media-a' }, { nonsense: 1 }]);
  ok(J(gemischt) === J([{ keep: 'media-b' }, { stagingId: 'c'.repeat(64) }, { keep: 'media-a' }]),
    '§1 der Bildplan mischt Behaltenes und Neues und laesst Unbrauchbares fallen');
  // ALTBESTAND — solange die alte Bildspalte noch etwas haelt, ist jede Speicherung eine Aenderung:
  // sonst bliebe die alte Liste stehen und käme nach „alle entfernt" beim naechsten Lesen zurueck.
  ok(M.photosUnchanged([], [], 1) === false && M.photosUnchanged([], [], 0) === true,
    '§1 Altbestand: „alle entfernt" ist eine Aenderung; ohne Altbestand ist die leere Galerie unveraendert');
  const altRepair = { ...repair, images: ['data:image/jpeg;base64,ALT'], mediaIds: [] };
  const altBody = M.editBody(altRepair, form, M.photoPlan([]));
  ok(Array.isArray(altBody.photos) && (altBody.photos as unknown[]).length === 0,
    `§1 …und der Rumpf traegt dann die LEERE Galerie (${JSON.stringify(altBody.photos)})`);
  ok(M.photosUnchanged(M.photoPlan([{ keep: 'media-a' }]), ['media-a', 'media-b']) === false,
    '§1 ein geloeschtes Bild ist eine Aenderung (kuerzerer Plan als die gespeicherte Liste)');
}
group('§1 Rumpf/verbotene Felder');

// ══════════════════════════════════════════════════════════════════════════════
// §2 — genau einmal wirken: Kennung, Ablage, Ausgaenge
// ══════════════════════════════════════════════════════════════════════════════

const LESEN = new Set(['repairs.list', 'repairs.get', 'customers.list']);
type Sent = { url: string; body: { op: string; commandId: string; payload: unknown } };
const alleBefehle: Sent[] = [];

/** Der durable Speicher des Telefons (IndexedDB), hier eine Map — mit Zaehlern, damit sich auch
 * beweisen laesst, dass ihn eine Auskunft GAR NICHT anfasst. */
function frischerSpeicher() {
  const m = new Map<string, Rec>();
  const zaehler = { get: 0, put: 0, delete: 0, getAll: 0 };
  const zustand = { brechen: false };
  return {
    m, zaehler,
    set brechen(v: boolean) { zustand.brechen = v; },
    async get(k: string) { zaehler.get += 1; return m.get(k) ?? null; },
    async put(e: Rec) {
      zaehler.put += 1;
      if (zustand.brechen) throw new Error('QuotaExceededError — dieses Telefon kann die Kennung nicht sichern');
      m.set(e.key, JSON.parse(JSON.stringify(e)) as Rec);
    },
    async delete(k: string) { zaehler.delete += 1; m.delete(k); },
    async getAll() { zaehler.getAll += 1; return [...m.values()]; },
  };
}
type Store = ReturnType<typeof frischerSpeicher>;

type Antwort = { throws?: boolean; status: number; body?: unknown };
function fakeFetch(plan: Antwort[] | ((n: number, b: Sent['body']) => Antwort)) {
  const calls: Array<{ url: string; body: Sent['body']; raw: string }> = [];
  const fn = async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Sent['body'];
    calls.push({ url, body, raw: init.body });
    if (url === '/api/command') alleBefehle.push({ url, body });
    const a = typeof plan === 'function' ? plan(calls.length, body) : (plan[calls.length - 1] ?? plan[plan.length - 1]);
    if (a.throws) throw new Error('connection reset — ob es ankam, weiss das Telefon nicht');
    return { status: a.status, json: async () => a.body ?? null };
  };
  return { fn, calls };
}

let idZaehler = 0;
function frischerClient(store: Store, f: ReturnType<typeof fakeFetch>) {
  return M.createClient({
    fetchFn: f.fn, store, genId: () => `cmd-${++idZaehler}`,
    token: () => 'jwt.for.this.phone', now: () => '2026-01-01T00:00:00.000Z',
  });
}
const OK200 = { status: 200, body: { ok: true, value: { repairId: 'rep-9', repairNumber: 'REP-0009' } } };
const NEUANLAGE = { customerId: 'cust-1', issueDescription: 'does not run' };

// ── Antwort verloren: dieselbe Kennung, der Vorgang bleibt liegen ────────────
{
  const store = frischerSpeicher();
  const f1 = fakeFetch([{ throws: true, status: 0 }]);
  const c1 = frischerClient(store, f1);
  const erst = await c1.mutate('create:draft-1', 'repairs.create', NEUANLAGE);
  ok(erst.kind === 'unresolved' && erst.status === 0,
    `§2 die Antwort geht verloren → offen, NICHT „nicht gespeichert" (${J(erst)})`);
  const liegt = store.m.get('create:draft-1')!;
  ok(liegt !== undefined && liegt.state === 'unresolved' && liegt.commandId === erst.commandId
    && J(liegt.payload) === J(NEUANLAGE),
    '§2 …der Vorgang liegt mit Kennung UND urspruenglichem Auftrag im durablen Speicher');

  const f2 = fakeFetch([OK200]);
  const zweit = await frischerClient(store, f2).mutate('create:draft-1', 'repairs.create', NEUANLAGE);
  ok(zweit.commandId === erst.commandId,
    `§2 die Wiederholung benutzt DIESELBE Kennung (${String(erst.commandId)}) — der Primary antwortet aus seinem Nachweis statt ein zweites Mal zu buchen`);
  ok(f2.calls[0].body.commandId === erst.commandId && J(f2.calls[0].body.payload) === J(NEUANLAGE),
    '§2 …und denselben Auftrag');
  ok(zweit.kind === 'ok' && store.m.size === 0, '§2 beantwortet → der Eintrag ist weg');
}

// ── Auch eine echte Antwort ohne Aussage (504) laesst den Vorgang offen ──────
{
  const store = frischerSpeicher();
  const f = fakeFetch((n) => (n === 1 ? { status: 504, body: { ok: false, error: 'GATEWAY_TIMEOUT' } } : OK200));
  const c = frischerClient(store, f);
  const a = await c.mutate('create:draft-2', 'repairs.create', NEUANLAGE);
  ok(a.kind === 'unresolved' && a.code === 'GATEWAY_TIMEOUT' && store.m.get('create:draft-2')?.state === 'unresolved',
    `§2 504 = keine Aussage → offen mit Grund (${J(a)})`);
  const b = await c.mutate('create:draft-2', 'repairs.create', NEUANLAGE);
  ok(b.commandId === a.commandId && b.kind === 'ok' && store.m.size === 0,
    '§2 …dieselbe Kennung klaert ihn, danach ist er erledigt');
}

// ── Die Ausgaenge: was beendet einen Vorgang, was nicht ──────────────────────
{
  const store = frischerSpeicher();
  await frischerClient(store, fakeFetch([OK200])).mutate('k-ok', 'repairs.create', NEUANLAGE);
  ok(store.m.size === 0, '§2 200 → Vorgang beendet, nichts bleibt liegen');

  const abgelehnt = await frischerClient(store, fakeFetch([
    { status: 409, body: { ok: false, error: 'RECORD_CHANGED', message: 'someone else was faster' } },
  ])).mutate('k-nein', 'repairs.update', { id: 'rep-1', expectedRevision: 2, diagnosis: 'x' });
  ok(abgelehnt.kind === 'rejected' && abgelehnt.code === 'RECORD_CHANGED' && !store.m.has('k-nein'),
    `§2 ein fachliches Nein IST eine Antwort → der Vorgang wird beendet, nicht ewig als „offen" gezeigt (${J(abgelehnt)})`);

  const konflikt = await frischerClient(store, fakeFetch([
    { status: 409, body: { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' } },
  ])).mutate('k-konflikt', 'repairs.create', NEUANLAGE);
  const k = store.m.get('k-konflikt');
  ok(konflikt.kind === 'conflict' && k?.state === 'conflict' && k.lastCode === 'BRIDGE_COMMAND_ID_CONFLICT',
    `§2 „nicht ausgefuehrt" ist KEINE Antwort auf die Frage, ob frueher gebucht wurde → bleibt offen (${J(konflikt)})`);
  const offen = await frischerClient(store, fakeFetch([OK200])).openIntents();
  ok(offen.length === 1 && offen[0].key === 'k-konflikt',
    '§2 …und taucht in der Leiste „Unresolved saves" auf');
}

// ── Formular waehrend eines offenen Vorgangs geaendert ───────────────────────
{
  const store = frischerSpeicher();
  const f = fakeFetch([{ throws: true, status: 0 }]);
  const c = frischerClient(store, f);
  const erst = await c.mutate('create:draft-3', 'repairs.create', NEUANLAGE);
  const vorher = f.calls.length;
  const geaendert = { ...NEUANLAGE, issueDescription: 'does not run AND the glass is cracked' };
  const r = await c.mutate('create:draft-3', 'repairs.create', geaendert);
  ok(r.kind === 'changed_while_open' && r.code === 'ORIGINAL_UNRESOLVED',
    `§2 geaenderter Auftrag unter offener Kennung → Halt (${J({ kind: r.kind, code: r.code })})`);
  ok(f.calls.length === vorher,
    '§2 …und es geht NICHTS hinaus — sonst haette der Primary zwei verschiedene Inhalte unter einer Kennung');
  ok(J(store.m.get('create:draft-3')!.payload) === J(NEUANLAGE),
    '§2 der urspruengliche Auftrag bleibt der urspruengliche (die Formularaenderung wird getrennt gehalten)');

  const f2 = fakeFetch([OK200]);
  const geklaert = await frischerClient(store, f2).mutate('create:draft-3', 'repairs.create', geaendert, { clarify: true });
  ok(J(f2.calls[0].body.payload) === J(NEUANLAGE),
    '§2 Klaeren sendet den URSPRUENGLICHEN Auftrag — nie den neuen Inhalt unter der alten Kennung');
  ok(f2.calls[0].body.commandId === erst.commandId && geklaert.commandId === erst.commandId,
    '§2 …unter derselben Kennung (nur so antwortet der Primary aus dem Nachweis)');
  ok(geklaert.kind === 'ok' && store.m.size === 0, '§2 …danach ist der Weg fuer die Aenderung frei');
}

// ── Kann die Ablage die Kennung nicht sichern, geht nichts hinaus ────────────
{
  const store = frischerSpeicher();
  store.brechen = true;
  const f = fakeFetch([OK200]);
  const r = await frischerClient(store, f).mutate('k-disk', 'repairs.create', NEUANLAGE);
  ok(r.kind === 'not_sent' && r.code === 'PENDING_STORE_FAILED',
    `§2 Speicher defekt → nicht gesendet (${J(r)})`);
  ok(f.calls.length === 0 && store.m.size === 0,
    '§2 …NICHTS ging hinaus: ein Auftrag, dessen Kennung ein Absturz verlieren kann, darf nicht abgeschickt werden');
}

// ── Auskuenfte sind keine Vorhaben ───────────────────────────────────────────
{
  const store = frischerSpeicher();
  const f = fakeFetch((n) => (n <= 2
    ? { status: 200, body: { ok: true, value: { items: [] } } }
    : { status: 503, body: { ok: false, error: 'BRIDGE_NOT_READY' } }));
  const c = frischerClient(store, f);
  await c.read('repairs.list', { q: '' });
  await c.read('repairs.list', { q: '' });
  ok(f.calls[0].body.commandId !== f.calls[1].body.commandId,
    '§2 jede Auskunft bekommt eine FRISCHE Kennung — sie darf jederzeit wiederholt werden');
  ok(store.zaehler.get === 0 && store.zaehler.put === 0 && store.zaehler.delete === 0 && store.m.size === 0,
    '§2 …und ruehrt den durablen Speicher nicht an (nur Vorhaben gehoeren dort hinein)');
  const schief = await c.read('repairs.get', { id: 'x' });
  ok(schief.ok === false && schief.code === 'BRIDGE_NOT_READY' && store.m.size === 0 && store.zaehler.put === 0,
    `§2 …auch eine gescheiterte Auskunft laesst NICHTS offen — sie darf einfach wiederholt werden (${J(schief)})`);
}

// ── Die Ausgangstabelle als Ganzes ───────────────────────────────────────────
{
  const tabelle: Array<[number, unknown, string]> = [
    [200, { ok: true }, 'ok'], [201, { ok: true }, 'ok'],
    [409, { error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' }, 'conflict'],
    [409, { error: 'RECORD_CHANGED' }, 'rejected'],
    [422, { error: 'INVALID' }, 'rejected'], [400, { error: 'BAD' }, 'rejected'],
    [401, { error: 'UNAUTHORIZED' }, 'unauthorized'], [403, { error: 'FORBIDDEN' }, 'unauthorized'],
    [0, null, 'unresolved'], [500, null, 'unresolved'],
    [503, { error: 'BRIDGE_NOT_READY' }, 'unresolved'], [504, null, 'unresolved'],
  ];
  const falsch = tabelle.filter(([s, b, erwartet]) => M.classify(s, b).kind !== erwartet)
    .map(([s, , e]) => `${s}≠${e}`);
  ok(falsch.length === 0, `§2 classify: jede Antwort landet im richtigen Ausgang (${falsch.join(', ') || 'alle 12 stimmen'})`);
  ok(M.classify(0, null).code === 'HTTP_0' && M.classify(409, { error: 'RECORD_CHANGED' }).code === 'RECORD_CHANGED',
    '§2 …und behaelt den Grund, damit die Maske ihn nennen kann');
}

// ── Die Form JEDES Befehls + Fotos reisen nie als Bytes ─────────────────────
{
  const store = frischerSpeicher();
  const f = fakeFetch((_n, b) => (b.op === 'repairs.create' ? OK200 : { status: 201, body: { stagingId: 'd'.repeat(64) } }));
  const c = frischerClient(store, f);
  const bytes = 'data:image/png;base64,iVBORw0KGgoAAAANS';
  const s = await c.stagePhoto(bytes);
  ok(s.ok === true && s.stagingId === 'd'.repeat(64) && f.calls[0].url === '/api/staging/media',
    '§2 Bytes gehen in die ABLAGE des Primary und bekommen dort ihre Kennung');
  await c.mutate('create:draft-4', 'repairs.create',
    M.createBody({ customerId: 'c', issueDescription: 'x' }, [s.stagingId!]));

  const befehle = alleBefehle;
  const falscheForm = befehle.filter((x) => J(Object.keys(x.body).sort()) !== J(['commandId', 'op', 'payload']));
  ok(befehle.length >= 12 && falscheForm.length === 0,
    `§2 alle ${befehle.length} Befehle tragen genau {op, commandId, payload} — nichts daneben (${falscheForm.length} Ausreisser)`);
  ok(befehle.every((x) => x.url === '/api/command'),
    '§2 …und gehen alle an `/api/command` (ein Weg, kein zweiter Kanal)');
  const mitBytes = befehle.filter((x) => !LESEN.has(x.body.op) && JSON.stringify(x.body).includes('data:'));
  ok(mitBytes.length === 0,
    `§2 in KEINEM Auftrag stecken Bildbytes — nur Staging-Kennungen (${mitBytes.length} gefunden)`);
}
group('§2 Idempotenz/Schreibsicherheit');

// ══════════════════════════════════════════════════════════════════════════════
// §3 — die AI schlaegt vor, sie entscheidet nicht
// ══════════════════════════════════════════════════════════════════════════════
{
  ok(J(M.AI_FIELDS) === J(['itemBrand', 'itemModel', 'itemReference', 'itemSerial', 'itemDescription', 'issueDescription']),
    `§3 die AI darf genau sechs beschreibende Felder anfassen (${M.AI_FIELDS.join(', ')})`);
  ok(M.AI_FIELDS.every((k) => M.CREATE_FIELDS.includes(k)) && !M.AI_FIELDS.some((k) => M.MONEY_FIELDS.includes(k)),
    '§3 …alle davon sind echte Erfassungsfelder, keines davon ist Geld');

  const form: Record<string, unknown> = { itemBrand: 'Rolex', itemModel: '', issueDescription: 'does not run', itemSerial: '' };
  const n = M.applyAiSuggestions(form, { fields: { itemBrand: 'Omega', itemModel: 'Speedmaster', issueDescription: 'scratched', itemSerial: '   ' } });
  ok(form.itemBrand === 'Rolex' && form.issueDescription === 'does not run',
    '§3 was der Mensch getippt hat, bleibt stehen — die AI ueberschreibt NIE');
  ok(form.itemModel === 'Speedmaster', '§3 ein leeres Feld wird gefuellt');
  ok(form.itemSerial === '', '§3 …ein Vorschlag aus Leerzeichen ist kein Vorschlag');
  ok(n === 1, `§3 gezaehlt wird, was wirklich gefuellt wurde (${n}) — die Maske sagt dem Benutzer die Wahrheit`);

  const flach: Record<string, unknown> = { itemBrand: '' };
  ok(M.applyAiSuggestions(flach, { itemBrand: 'Cartier' }) === 1 && flach.itemBrand === 'Cartier',
    '§3 ein flaches Antwortobjekt wird genauso gelesen wie `{fields:{…}}`');

  // Der eigentliche Nagel: eine AI-Antwort (oder ein manipulierter Primary) darf ueber diesen Weg
  // NICHTS Geldwertes, keinen Status und keine Kennung in das Formular schreiben.
  const leer: Record<string, unknown> = {};
  const gefaehrlich = { estimatedCost: '9999', customerId: 'cust-fremd', status: 'DELIVERED', repairNumber: 'REP-0001', id: 'rep-hack', revision: 99, branchId: 'branch-x' };
  const nn = M.applyAiSuggestions(leer, gefaehrlich);
  const eingeschleust = Object.keys(gefaehrlich).filter((k) => k in leer);
  ok(nn === 0 && eingeschleust.length === 0,
    `§3 kein Feld ausserhalb von AI_FIELDS kommt durch (eingeschleust: ${eingeschleust.join(', ') || 'keins'})`);
  const vorhanden: Record<string, unknown> = { estimatedCost: '10', status: 'RECEIVED', itemBrand: '' };
  M.applyAiSuggestions(vorhanden, { ...gefaehrlich, itemBrand: 'Seiko' });
  ok(vorhanden.estimatedCost === '10' && vorhanden.status === 'RECEIVED' && vorhanden.itemBrand === 'Seiko',
    '§3 …auch wenn sie im Formular schon existieren, bleiben sie unberuehrt');
}
group('§3 AI-Leitplanken');

// ══════════════════════════════════════════════════════════════════════════════
// §4 — Verdrahtung: der alte Weg kommt nicht durch die Hintertuer zurueck
// ══════════════════════════════════════════════════════════════════════════════
{
  const page = src('src-tauri/src/sync/mobile_page.rs');
  ok(/include_str!\("mobile_repair\.html"\)/.test(page)
    && /include_str!\("mobile_repair_commands\.js"\)/.test(page)
    && /include_str!\("mobile_repair_ui\.js"\)/.test(page),
    '§4 Maske, Befehlsseite und Oberflaeche sind woertlich eingebettet — genau die Dateien, die hier geprueft werden');
  ok(page.indexOf('include_str!("mobile_repair_commands.js")') < page.indexOf('include_str!("mobile_repair_ui.js")'),
    '§4 …und die Befehlsseite steht VOR der Oberflaeche (sonst gaebe es `MobileRepair` beim Verdrahten noch nicht)');
  const screens = /const SCREENS = \[([^\]]*)\]/.exec(page)?.[1] ?? '';
  ok(/'repairHome'/.test(screens) && /'formRepair'/.test(screens),
    `§4 die Reparaturbildschirme sind bekannte Bildschirme (${screens.trim()})`);
  ok(/mode === 'repair'\)\s*rpHomeOpen\(\)/.test(page),
    '§4 die Reparatur-Kachel fuehrt in die neue Startseite (rpHomeOpen)');

  // Der alte Weg: das Telefon erfand eine Nummer und schrieb selbst. Bliebe davon auch nur eine
  // Zeichenkette stehen, waere der Rueckweg offen.
  const altReste = ['repair_number', 'REP-MOB-', 'voucher_code'].filter((s) => page.includes(s));
  ok(altReste.length === 0,
    `§4 keine Spur der alten Telefon-Schreibseite mehr in mobile_page.rs (gefunden: ${altReste.join(', ') || 'nichts'})`);
  const slots = /const photos = \{([^}]*)\}/.exec(page)?.[1] ?? 'FEHLT';
  ok(!/repair/.test(slots) && /collection/.test(slots) && /purchase/.test(slots),
    `§4 der alte Einzelbild-Halter hat keinen `+ '`repair`' + `-Platz mehr (${slots.trim()}) — Reparaturbilder leben nur noch in RP.slots`);
}

{
  const ui = src('src-tauri/src/sync/mobile_repair_ui.js');
  const ops = new Set<string>();
  for (const m of ui.matchAll(/rpClient\.read\(\s*'([^']+)'/g)) ops.add(m[1]);
  for (const m of ui.matchAll(/rpClient\.mutate\(\s*[^,]+,\s*'([^']+)'/g)) ops.add(m[1]);
  // Die Werkstattwege nennen ihren Befehl beim Aufruf des gemeinsamen Helfers.
  for (const m of ui.matchAll(/rpWerkstatt\(\s*'([^']+)'/g)) ops.add(m[1]);
  // Genau der vereinbarte mobile Umfang — alles VORHANDENE Operationen, keine einzige neue.
  const ERLAUBT = ['customers.create', 'customers.list', 'repairs.add_line', 'repairs.add_material',
    'repairs.cancel_line', 'repairs.create', 'repairs.create_invoice', 'repairs.get', 'repairs.list',
    'repairs.record_gold_usage', 'repairs.update', 'repairs.update_status', 'suppliers.list'];
  ok(J([...ops].sort()) === J(ERLAUBT),
    `§4 die Oberflaeche ruft GENAU diese Fernbefehle: ${[...ops].sort().join(', ')}`);
  // Jeder Aufruf muss von der Zaehlung erfasst sein — sonst koennte ein neuer Befehl unbemerkt
  // hinzukommen. Der einzige Aufruf ohne Zeichenkette ist die Klaerung, die den GESPEICHERTEN
  // Befehl wiederholt.
  // Zwei Aufrufe tragen KEINE Zeichenkette an der Aufrufstelle, und beide sind erklaert: die
  // Klaerung wiederholt den gespeicherten Befehl, und der Werkstatt-Helfer bekommt seinen Namen
  // als Parameter (oben mitgezaehlt). Alles andere muss namentlich dastehen.
  const aufrufe = (ui.match(/rpClient\.(read|mutate)\(/g) || []).length;
  const direkt = (ui.match(/rpClient\.read\(\s*'/g) || []).length + (ui.match(/rpClient\.mutate\(\s*[^,]+,\s*'/g) || []).length;
  const werkstattAufrufe = (ui.match(/rpWerkstatt\(\s*'/g) || []).length;
  ok(aufrufe === direkt + 2 && werkstattAufrufe === 5
    && /rpClient\.mutate\(rec\.key, rec\.op, rec\.payload, \{ clarify: true \}\)/.test(ui)
    && /rpClient\.mutate\(key, op, res\.body\)/.test(ui),
    `§4 …ohne festen Namen sind genau die Klaerung und der Werkstatt-Helfer (${aufrufe} Aufrufe, ${direkt} direkt benannt, ${werkstattAufrufe} Werkstattwege)`);
  ok(!ui.includes('/api/sync/push'),
    '§4 die Oberflaeche kennt den Abgleichkanal NICHT — Reparaturen reisen als Befehl, nicht als geschobene Zeile');
  ok(!/fetch\(\s*'\/api\/command'/.test(ui) && /rpClient/.test(ui),
    '§4 …und sie spricht nie selbst mit `/api/command`, sondern immer ueber den Auftraggeber (Kennung + Ablage)');
}

{
  const rc = src('src/core/bridge/read-commands.ts');
  const spalten = /const REPAIR_COLUMNS =([\s\S]*?);\n/.exec(rc)?.[1] ?? 'FEHLT';
  ok(!/\bimages\b/.test(spalten) && /repair_number/.test(spalten),
    '§4 `repairs.list` liest KEINE Bilder — eine Liste mit Daten-URLs waere ein Vielfaches an Last je Tastendruck');
  const get = rc.slice(rc.indexOf('registerCommand(OP_REPAIRS_GET'));
  ok(/SELECT \$\{REPAIR_COLUMNS\}, notes, voucher_code, images, item_reference, item_description,/.test(get),
    '§4 `repairs.get` holt die Bilder und die restlichen Warenfelder dazu');
  ok(/mediaIds: fotos\.map/.test(get) && /images: fotos\.length > 0 \? \[\] : repairImages\(found\[0\]\.images\)/.test(get),
    '§4 …als Medien-Referenzen; die alte Spalte nur noch fuer Reparaturen ohne Verknuepfung');
  // Der Index IST der Vertrag: `{keep:i}` einer Aenderung loest der Primary gegen die gespeicherte
  // Liste auf (`resolvePhotos` gegen `seen.images`). Ein Filter hier verschoebe jede folgende
  // Stelle — und ein Speichern wuerde still das falsche Foto behalten.
  const bilder = /function repairImages\(v: unknown\): string\[\] \{([\s\S]*?)\n\}/.exec(rc)?.[1] ?? 'FEHLT';
  ok(/parsed\.map\(/.test(bilder) && !/\.filter\(/.test(bilder) && !/startsWith\('data:image/.test(bilder),
    '§4 `repairs.get` laesst KEINEN Bildeintrag weg — sonst zeigt `{keep:i}` spaeter auf ein anderes Bild');
  ok(/typeof x === 'string' \? x : ''/.test(bilder),
    '§4 …und haelt die Zaehlung auch bei einem unerwarteten Eintrag (leerer Platzhalter statt Luecke)');
  for (const feld of ['itemReference', 'itemDescription', 'itemCategoryId', 'itemAttributes', 'staffId']) {
    ok(new RegExp(`\\n\\s*${feld}: `).test(get.slice(0, get.indexOf('// ── Agenten-Transfers'))),
      `§4 …und nennt \`${feld}\` — ohne das koennte die Handy-Maske nicht bearbeiten, ohne Felder zu leeren`);
  }
}
group('§4 Verdrahtung');

// ── §5 Felder, die die Maske NICHT zeigt, reisen nie mit ──────────────────────
//
// Der Zwei-App-Lauf hat es gefunden: der gelesene Stand traegt `repairType: 'internal'`, die
// Handy-Maske hat dafuer kein Feld — verglichen wurde trotzdem, also ging `repairType: null`
// hinaus und der Primary wies die ganze Aenderung ab („unknown repair type"). Ein Feld ohne
// Eingabefeld kann auf dem Telefon nicht geaendert worden sein; es gehoert nicht in den Rumpf.
{
  const gelesen = {
    id: 'rep-1', revision: 3, issueDescription: 'Krone lose', notes: 'alt',
    repairType: 'internal', workshopSupplierId: 'sup-1', actualCost: 12.5, chargeToCustomer: 30,
    diagnosis: 'nichts', images: [],
  };
  // Genau die zehn Felder, die `RP_INPUTS` in der Oberflaeche hat.
  const maske = {
    issueDescription: 'Krone lose', itemBrand: '', itemModel: '', itemReference: '', itemSerial: '',
    itemDescription: '', estimatedCost: '', estimatedReady: '', diagnosis: 'nichts', notes: 'neu',
  };
  const body = M.editBody(gelesen, maske, []) as Record<string, unknown>;
  ok(body.notes === 'neu', '§5 die echte Aenderung reist mit');
  for (const feld of ['repairType', 'workshopSupplierId', 'actualCost', 'chargeToCustomer']) {
    ok(!(feld in body), `§5 \`${feld}\` fehlt im Rumpf — die Maske zeigt es nicht, also aendert sie es nicht`);
  }
  ok(!('itemBrand' in body), '§5 ein leeres Maskenfeld gegen einen leeren Stand ist keine Aenderung');
  // Und umgekehrt: ein Feld, das die Maske ZEIGT, darf geleert werden.
  const geleert = M.editBody(gelesen, { ...maske, diagnosis: '' }, []) as Record<string, unknown>;
  ok(geleert.diagnosis === null, '§5 ein geleertes Maskenfeld reist als `null` — Leeren bleibt moeglich');
}
group('§5 Keine Phantomfelder');

// ── §6 Werkstattwege: Arbeitszeile, Storno, Material, Gold, Rechnung ─────────
//
// Fuenf VORHANDENE Fernbefehle. Hier wird nur geprueft, dass der Rumpf genau das traegt, was der
// Primary annimmt — und nichts, was er ausrechnet oder bucht.
{
  const rep = { id: 'rep-1', revision: 7 };

  // Arbeitszeile
  const linie = M.lineBody(rep, { costAmount: '12,5', workType: 'polishing', supplierId: 'sup-1', description: 'Politur' }) as
    { ok: boolean; body: Record<string, unknown> };
  ok(linie.ok && linie.body.repairId === 'rep-1' && linie.body.expectedRevision === 7,
    '§6 die Arbeitszeile nennt Reparatur und GELESENE Fassung');
  ok(linie.body.costAmount === 12.5 && linie.body.workType === 'polishing' && linie.body.supplierId === 'sup-1',
    `§6 …Kosten (Komma wird Punkt), Arbeitsart und Lieferant (${J(linie.body)})`);
  const eigen = M.lineBody(rep, { costAmount: '5', workType: 'service', supplierId: M.INHOUSE }) as
    { ok: boolean; body: Record<string, unknown> };
  ok(eigen.ok && !('supplierId' in eigen.body),
    '§6 eigene Arbeit reist OHNE Lieferant — der Platzhalter ist kein Lieferant');
  ok((M.lineBody(rep, { costAmount: '0', workType: 'service' }) as { code: string }).code === 'COST_REQUIRED',
    '§6 ohne Betrag geht nichts hinaus');
  ok((M.lineBody(rep, { costAmount: '5', workType: 'erfunden' }) as { code: string }).code === 'WORK_TYPE_INVALID',
    '§6 eine erfundene Arbeitsart wird hier schon abgewiesen');

  // Storno
  const storno = M.cancelLineBody(rep, 'line-9', null) as { ok: boolean; body: Record<string, unknown> };
  ok(storno.ok && J(Object.keys(storno.body).sort()) === J(['expectedRevision', 'lineId', 'repairId']),
    `§6 das Storno nennt genau Reparatur, Zeile und Fassung (${J(storno.body)})`);
  ok((M.cancelLineBody(rep, '', null) as { code: string }).code === 'LINE_REQUIRED', '§6 ohne Zeile kein Storno');

  // Material
  const mat = M.materialBody(rep, {
    materialKind: 'gold', description: '21K Draht', supplierId: 'sup-2', totalCost: '30',
    quantity: '2', weightGrams: '3,5', karat: '21K',
  }) as { ok: boolean; body: { rows: Array<Record<string, unknown>> } };
  ok(mat.ok && mat.body.rows.length === 1 && mat.body.rows[0].materialKind === 'gold'
    && mat.body.rows[0].totalCost === 30 && mat.body.rows[0].weightGrams === 3.5,
    `§6 Material reist als EINE Position mit Art, Text, Lieferant und Kosten (${J(mat.body.rows[0])})`);
  ok((M.materialBody(rep, { materialKind: 'gold', description: 'x', totalCost: '5' }) as { code: string }).code === 'SUPPLIER_REQUIRED',
    '§6 Material ohne Lieferant (oder eigene Werkstatt) geht nicht');
  // Die Art entscheidet ueber die Felder — dieselbe Weiche wie `checkMaterialRows` am Primary.
  ok((M.materialBody(rep, { materialKind: 'labor', description: 'x', supplierId: 'sup-2', totalCost: '5' }) as { code: string })
    .code === 'MATERIAL_KIND_REQUIRED',
    '§6 `labor` gibt es an einer Reparatur nicht — der Primary weist es immer ab, also bietet das Telefon es nicht an');
  const stein = M.materialBody(rep, {
    materialKind: 'diamond', description: '0,5 ct', supplierId: 'sup-2', totalCost: '40', quantity: '2', caratPerPiece: '0,5',
  }) as { ok: boolean; body: { rows: Array<Record<string, unknown>> } };
  ok(stein.ok && stein.body.rows[0].caratPerPiece === 0.5 && stein.body.rows[0].quantity === 2
    && !('weightGrams' in stein.body.rows[0]) && !('karat' in stein.body.rows[0]),
    `§6 Diamant/Stein: Karat je Stueck ja, Gewicht und Karatangabe nein (${J(stein.body.rows[0])})`);
  ok((M.materialBody(rep, { materialKind: 'stone', description: 'x', supplierId: 'sup-2', totalCost: '5' }) as { code: string })
    .code === 'CARAT_REQUIRED',
    '§6 …ohne Karat je Stueck geht ein Stein nicht hinaus (der Primary verlangt es)');
  ok(!('caratPerPiece' in mat.body.rows[0]),
    '§6 …und ein Goldstueck traegt kein Karat je Stueck');
  ok((M.materialBody(rep, { materialKind: 'gold', description: 'x', supplierId: 'sup-2', totalCost: '5', karat: '21K' }) as { code: string })
    .code === 'WEIGHT_REQUIRED',
    '§6 Gold ohne Gewicht geht nicht');
  ok((M.materialBody(rep, { materialKind: 'gold', description: 'x', supplierId: 'sup-2', totalCost: '5', weightGrams: '2' }) as { code: string })
    .code === 'KARAT_REQUIRED',
    '§6 Gold ohne Karat geht nicht');
  ok((M.materialBody(rep, { materialKind: 'gold', description: 'x', supplierId: 'sup-2', totalCost: '5', weightGrams: '2', karat: '21K', quantity: '0' }) as { code: string })
    .code === 'QUANTITY_INVALID',
    '§6 eine angegebene Menge ist groesser als null');

  // Gold — zwei Faelle mit verschiedenen Feldern
  const werkstatt = M.goldBody(rep, { source: 'workshop', supplierId: 'sup-3', karat: '21K', receivedGrams: '10', settlementType: 'pay_money' }) as
    { ok: boolean; body: Record<string, unknown> };
  ok(werkstatt.ok && werkstatt.body.supplierId === 'sup-3' && !('usedGrams' in werkstatt.body) && !('leftover' in werkstatt.body),
    `§6 Werkstattgold: Lieferant ja, Verbrauch/Rest nein (${J(werkstatt.body)})`);
  const kunde = M.goldBody(rep, { source: 'customer', karat: '18K', receivedGrams: '8', usedGrams: '6', leftover: 'credit' }) as
    { ok: boolean; body: Record<string, unknown> };
  ok(kunde.ok && kunde.body.leftover === 'credit' && kunde.body.usedGrams === 6 && !('supplierId' in kunde.body),
    `§6 Kundengold: Verbrauch und Rest ja, Lieferant nein (${J(kunde.body)})`);
  ok((M.goldBody(rep, { source: 'customer', karat: '18K', receivedGrams: '8' }) as { code: string }).code === 'LEFTOVER_REQUIRED',
    '§6 Kundengold ohne Aussage ueber den Rest geht nicht');
  ok((M.goldBody(rep, { source: 'workshop', karat: '18K', receivedGrams: '8', supplierId: M.INHOUSE }) as { code: string }).code === 'SUPPLIER_REQUIRED',
    '§6 Werkstattgold braucht einen ECHTEN Lieferanten');

  // Rechnung
  const re = M.invoiceBody(rep, 'VAT_10') as { ok: boolean; body: Record<string, unknown> };
  ok(re.ok && J(Object.keys(re.body).sort()) === J(['expectedRevision', 'repairId', 'taxScheme']),
    `§6 die Rechnung nennt Reparatur, Fassung und Steuerart (${J(re.body)})`);
  ok((M.invoiceBody(rep, '') as { ok: boolean; body: Record<string, unknown> }).body.taxScheme === undefined,
    '§6 ohne Wahl bleibt die gespeicherte Steuerart stehen');
  ok((M.invoiceBody(rep, 'PHANTASIE') as { code: string }).code === 'TAX_SCHEME_INVALID', '§6 erfundene Steuerart: nein');

  // Und keiner der fuenf Rueempfe traegt je ein Feld, das der Primary selbst setzt.
  const verboten = ['id', 'repairNumber', 'voucherCode', 'status', 'branchId', 'tenantId', 'userId',
    'createdBy', 'margin', 'internalCost', 'invoiceId', 'expenseId', 'revision'];
  for (const [name, res] of [['line', linie], ['cancel', storno], ['material', mat], ['gold', werkstatt], ['invoice', re]] as const) {
    const text = J((res as { body: unknown }).body);
    const treffer = verboten.filter((f) => new RegExp(`"${f}"\\s*:`).test(text));
    ok(treffer.length === 0, `§6 ${name}: kein Feld des Primary im Rumpf (${treffer.join(', ') || 'keins'})`);
  }
}
group('§6 Werkstattwege');

// ══════════════════════════════════════════════════════════════════════════════
// §7 — die Vokabeln gehoeren dem HAUS, nicht dem Telefon
//
// Zweimal teuer gelernt (R4C.3, R4C.4): wo eine zweite Liste desselben Vokabulars steht, laeuft sie
// mit dem Haus auseinander — und die Maske bietet dann Woerter an, die der Primary nicht kennt
// (`unknown work type: service`). Das Telefon BRAUCHT die Woerter als Werte (eine Auswahl muss sie
// anbieten), also werden sie hier Zeichen fuer Zeichen gegen die Quelle des Hauses genagelt.
// ══════════════════════════════════════════════════════════════════════════════
{
  const typen = src('src/core/models/types.ts');
  const goldHaus = src('src/core/gold/gold-house.ts');
  const goldBefehl = src('src/core/bridge/gold-commands.ts');
  /** Die Woerter einer `export const X = [...]`-Liste, so wie sie im Quelltext stehen. */
  const listeAus = (text: string, name: string): string[] => {
    const m = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(text);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };

  const hausArbeit = listeAus(typen, 'REPAIR_WORK_TYPES');
  ok(hausArbeit.length === 8 && J(M.WORK_TYPES) === J(hausArbeit),
    `§7 Arbeitsarten == REPAIR_WORK_TYPES des Hauses (${J(hausArbeit)})`);

  const hausSteuer = listeAus(typen, 'REPAIR_TAX_SCHEMES');
  ok(hausSteuer.length === 2 && J(M.TAX_SCHEMES) === J(hausSteuer),
    `§7 Steuerarten == REPAIR_TAX_SCHEMES (${J(hausSteuer)})`);

  const hausMaterial = listeAus(goldHaus, 'MATERIAL_KINDS');
  ok(hausMaterial.length === 4 && J(M.MATERIAL_KINDS) === J(hausMaterial),
    `§7 Materialarten == MATERIAL_KINDS des Hauses (${J(hausMaterial)})`);
  // …und was eine REPARATUR davon annimmt, entscheidet `allowLabor` am Haus — nicht das Telefon.
  ok(/addRepairMaterialInHouse[\s\S]*?checkMaterialRows\(req\.rows, actor\.branchId, false\)/.test(goldHaus),
    '§7 eine Reparatur nimmt kein `labor` an (checkMaterialRows(..., false))');
  ok(J(M.REPAIR_MATERIAL_KINDS) === J(hausMaterial.filter((w) => w !== 'labor')),
    `§7 …also bietet das Telefon genau die uebrigen an (${J(M.REPAIR_MATERIAL_KINDS)})`);

  const hausRest = listeAus(goldHaus, 'GOLD_LEFTOVER_DESTINATIONS');
  ok(hausRest.length === 3 && J(M.GOLD_LEFTOVER) === J(hausRest),
    `§7 Rest-Ziele == GOLD_LEFTOVER_DESTINATIONS (${J(hausRest)})`);

  const hausAbrechnung = listeAus(goldHaus, 'GOLD_SETTLEMENT_TYPES');
  ok(hausAbrechnung.length === 2 && J(M.GOLD_SETTLEMENT) === J(hausAbrechnung),
    `§7 Abrechnungsarten == GOLD_SETTLEMENT_TYPES (${J(hausAbrechnung)})`);

  // Die Quelle des Goldes steht nicht als Liste, sondern als Pruefung im Befehl — also wird SIE gelesen.
  const quellen = /source !== '([a-z]+)' && source !== '([a-z]+)'/.exec(goldBefehl);
  ok(quellen !== null && J(M.GOLD_SOURCES) === J([quellen[1], quellen[2]]),
    `§7 Goldquellen == die Pruefung in parseRepairGoldUsage (${quellen ? quellen[1] + '/' + quellen[2] : 'FEHLT'})`);

  const platzhalter = /export const INHOUSE_SOURCE = '([^']+)'/.exec(goldHaus)?.[1] ?? 'FEHLT';
  ok(M.INHOUSE === platzhalter, `§7 „eigene Werkstatt" == INHOUSE_SOURCE (${platzhalter})`);
}
group('§7 Vokabeln des Hauses');

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// §9 — „Customer Pays" reist beim ANLEGEN mit, und eine Zeile sagt, was sie ist
//
// Zwei Funde eines echten Durchlaufs am Telefon:
//   a) „Create invoice" wurde abgewiesen („has no charge"), obwohl der Betrag in der Maske stand:
//      `CREATE_FIELDS` kannte `chargeToCustomer` nicht, der Betrag fiel still weg. Ein Feld ohne
//      Weg — dieselbe Klasse wie die Materialsackgassen.
//   b) Die Zeilenliste sagte „polishing · 12.5 · OPEN" und damit nichts ueber Quelle, Material
//      oder Text. Alles davon stand laengst in der Zeile.
// ══════════════════════════════════════════════════════════════════════════════
{
  const rumpf = M.createBody({
    customerId: 'cust-1', issueDescription: 'Krone klemmt',
    estimatedCost: '40', chargeToCustomer: '100,500',
  });
  ok(rumpf.chargeToCustomer === 100.5,
    `§9 der Betrag der Maske reist beim Anlegen mit — als Zahl (${J(rumpf.chargeToCustomer)})`);
  ok(M.CREATE_FIELDS.includes('chargeToCustomer') && M.MONEY_FIELDS.includes('chargeToCustomer'),
    '§9 …er steht in der Anlageliste und gilt als Geld');

  // Der Primary nimmt beim ANLEGEN genau das an — aus seinem Quelltext gelesen, nicht geraten.
  const erlaubt = /export function parseRepairCreate[\s\S]*?onlyKnownFields\(raw, \[([\s\S]*?)\]\);/
    .exec(src('src/core/bridge/service-commands.ts'))?.[1] ?? '';
  const primaerFelder = [...erlaubt.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const fremd = M.CREATE_FIELDS.filter((f) => f !== 'customerId' && !primaerFelder.includes(f));
  ok(primaerFelder.includes('chargeToCustomer') && fremd.length === 0,
    `§9 …und der Primary nimmt jedes Feld der Anlage an (fremd: ${fremd.join(', ') || 'keins'})`);

  // Die Gegenprobe zum Fund: JEDES Maskenfeld, das beim Anlegen SICHTBAR ist, hat einen Weg.
  // Sichtbar = in `RP_INPUTS` und nicht beim Anlegen ausgeblendet (`rpDiagnosisRow`).
  const ui = src('src-tauri/src/sync/mobile_repair_ui.js');
  const zuordnung = /const RP_INPUTS = \{([\s\S]*?)\};/.exec(ui)?.[1] ?? '';
  const maskenFelder = [...zuordnung.matchAll(/([a-zA-Z]+):\s*'([^']+)'/g)].map((m) => m[1]);
  ok(maskenFelder.length >= 10, `§9 die Feldzuordnung der Maske ist lesbar (${maskenFelder.length})`);
  const versteckt = /rpNewIntake\(\)[\s\S]*?\$\('rpDiagnosisRow'\)\.classList\.add\('hidden'\)/.test(ui)
    ? ['diagnosis'] : [];
  ok(versteckt.length === 1, '§9 …und die Diagnose ist beim Anlegen ausgeblendet (sie gehoert zur Arbeit)');
  const sackgassen = maskenFelder.filter((f) => !versteckt.includes(f) && !M.CREATE_FIELDS.includes(f));
  ok(sackgassen.length === 0,
    `§9 kein sichtbares Feld der Anlage ohne Weg (Sackgasse: ${sackgassen.join(', ') || 'keine'})`);

  // b) Die Beschriftung einer Zeile.
  ok(M.lineText({ workType: 'polishing', description: 'Gehaeuse und Band', costAmount: 12.5, status: 'OPEN' })
    === 'In-house · Polishing — Gehaeuse und Band · 12.500 · OPEN',
    `§9 eigene Arbeit: Quelle, Art, Text, Betrag, Stand (${M.lineText({ workType: 'polishing', description: 'Gehaeuse und Band', costAmount: 12.5, status: 'OPEN' })})`);
  ok(M.lineText({ supplierId: 'sup-1', supplierName: 'Al Noor', workType: 'spare_part', description: 'Zugfeder', costAmount: 25, status: 'OPEN' })
    === 'Al Noor · Spare Part — Zugfeder · 25.000 · OPEN',
    '§9 fremde Arbeit nennt den Lieferanten beim Namen');
  const stein = { supplierId: 'sup-1', supplierName: 'Al Noor', materialKind: 'diamond', description: 'Round Brilliant', materialDetails: { qty: 3, ct: 0.25 }, costAmount: 45, status: 'OPEN' };
  ok(M.lineText(stein) === 'Al Noor · Diamond — 3 × 0.25 ct — Round Brilliant · 45.000 · OPEN',
    `§9 Diamant nennt Menge und Karat je Stueck (${M.lineText(stein)})`);
  const gold = { supplierName: 'Goldsmith Ali', materialKind: 'gold', description: 'Fassung', materialDetails: { weightGrams: 5.2, karat: '21K' }, costAmount: 80, status: 'OPEN' };
  ok(M.lineText(gold) === 'Goldsmith Ali · Gold — 5.200 g · 21K — Fassung · 80.000 · OPEN',
    `§9 Gold nennt Gewicht und Karat — und den Goldschmied, obwohl die Zeile keine Lieferantenkennung traegt (${M.lineText(gold)})`);
  ok(M.lineText({ materialKind: 'gold', materialDetails: {}, costAmount: 3, status: 'CANCELLED' })
    === 'In-house · Gold · 3.000 · CANCELLED',
    '§9 …und was fehlt, wird nicht erfunden: kein leerer Gedankenstrich');

  // Dieselbe Schreibweise wie am Rechner — sonst liest dasselbe Stueck an zwei Orten anders.
  ok(M.materialDetailText(stein) === materialDetailText(stein as never)
    && M.materialDetailText(gold) === materialDetailText(gold as never),
    '§9 Telefon und Rechner schreiben die Materialangaben Zeichen fuer Zeichen gleich');

  // Die Auskunft gibt die Felder auch wirklich heraus (sonst bliebe die Beschriftung leer).
  const reads = src('src/core/bridge/read-commands.ts');
  ok(/SELECT id, supplier_id, work_type, description, cost_amount, status, position[\s\S]*?material_kind, material_details/.test(reads)
    && /materialDetails: materialDetailsOf\(l\.material_details\)/.test(reads)
    && /supplierName: str\(rows\('SELECT name FROM suppliers WHERE id = \?'/.test(reads),
    '§9 `repairs.get` gibt Text, Art, Materialangaben und den Namen des Lieferanten mit heraus');
}
group('§9 Anlagebetrag und Zeilenbeschriftung');

for (const [name, n] of groups) console.log(`  ${name}: ${n}`);
if (fails.length > 0) {
  console.log(`\nFAIL — preg5 mobile repair: ${PASS} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`\nPASS — preg5 mobile repair: ${PASS} passed, 0 failed`);
console.log('PRE_G5_MOBILE_REPAIR_UNIT_PROVED');

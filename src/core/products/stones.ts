// ════════════════════════════════════════════════════════════════════════════
// STONES — die EINE Steinliste für Gold-Diamond Jewellery.
//
// Rechner, Primary und Telefon (Twin: `src-tauri/src/sync/mobile_stones.js`, Paritätstest) nutzen
// genau diese Struktur — für Collection, Einkauf, Kommission, Bearbeiten, Reparatur und die KI.
//
// Gespeichert in `attributes.stones` als geordnete Liste:
//   { type, qty, carat?, name?, color?, clarity?, shape? }
//   • type    — kanonischer Schlüssel aus STONE_TYPES (nie die Anzeige-Bezeichnung)
//   • qty     — ganze Zahl ≥ 1
//   • carat   — optional, Gesamt-Karat der Zeile, > 0, höchstens 3 Nachkommastellen
//   • name    — nur und genau bei type = 'other'
//   • color / clarity / shape — nur bei type = 'diamond', optional, aus festen Listen
// Mehrere Zeilen derselben Steinart sind erlaubt und bleiben getrennt; die Reihenfolge bleibt.
//
// „Diamond Weight" (`attributes.diamond_weight`) ist kein zweites Eingabefeld mehr: sobald Zeilen
// Diamant-Karat tragen, ist es deren Summe (in Tausendstel gerechnet, ohne Float-Fehler). Ein Wert
// von vor der Steinliste bleibt unverändert stehen, bis Diamant-Zeilen mit Karat ihn ersetzen —
// erfunden wird daraus nichts.
// ════════════════════════════════════════════════════════════════════════════

export const STONES_KEY = 'stones';
export const DIAMOND_WEIGHT_KEY = 'diamond_weight';

/** Die Kategorien mit Steinliste. */
export const STONE_CATEGORIES: readonly string[] = ['cat-gold-jewelry'];
export function stonesApply(categoryId: string | null | undefined): boolean {
  return STONE_CATEGORIES.includes(String(categoryId ?? ''));
}

export interface StoneOption { key: string; label: string }

export const STONE_TYPES: readonly StoneOption[] = [
  { key: 'diamond', label: 'Diamond' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'sapphire', label: 'Sapphire' },
  { key: 'ruby', label: 'Ruby' },
  { key: 'pearl', label: 'Pearl' },
  { key: 'moissanite', label: 'Moissanite' },
  { key: 'cubic_zirconia', label: 'Cubic Zirconia' },
  { key: 'amethyst', label: 'Amethyst' },
  { key: 'aquamarine', label: 'Aquamarine' },
  { key: 'topaz', label: 'Topaz' },
  { key: 'tourmaline', label: 'Tourmaline' },
  { key: 'opal', label: 'Opal' },
  { key: 'garnet', label: 'Garnet' },
  { key: 'onyx', label: 'Onyx' },
  { key: 'turquoise', label: 'Turquoise' },
  { key: 'other', label: 'Other' },
];
export const DIAMOND_COLORS: readonly StoneOption[] = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N-Z', 'Fancy']
  .map((c) => ({ key: c, label: c }));
export const DIAMOND_CLARITIES: readonly StoneOption[] = ['FL', 'IF', 'VVS1', 'VVS2', 'VVS', 'VS1', 'VS2', 'VS', 'SI1', 'SI2', 'SI', 'I1', 'I2', 'I3']
  .map((c) => ({ key: c, label: c }));
export const DIAMOND_SHAPES: readonly StoneOption[] = [
  { key: 'round', label: 'Round' }, { key: 'princess', label: 'Princess' }, { key: 'oval', label: 'Oval' },
  { key: 'cushion', label: 'Cushion' }, { key: 'emerald', label: 'Emerald cut' }, { key: 'pear', label: 'Pear' },
  { key: 'marquise', label: 'Marquise' }, { key: 'radiant', label: 'Radiant' }, { key: 'asscher', label: 'Asscher' },
  { key: 'heart', label: 'Heart' }, { key: 'baguette', label: 'Baguette' }, { key: 'trillion', label: 'Trillion' },
];

export const MAX_STONE_ROWS = 50;
export const MAX_STONE_QTY = 100000;
/** Höchstens 10 000 ct je Zeile — in Tausendstel. */
export const MAX_CARAT_THOUSANDTHS = 10_000_000;
export const MAX_STONE_NAME = 60;

export interface StoneRow {
  type: string;
  qty: number;
  carat?: number;
  name?: string;
  color?: string;
  clarity?: string;
  shape?: string;
}

export interface StoneIssue { row: number; field: string; code: string; message: string }

const ROW_KEYS = ['type', 'qty', 'carat', 'name', 'color', 'clarity', 'shape'];
const DIAMOND_ONLY = ['color', 'clarity', 'shape'] as const;

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const labelOf = (list: readonly StoneOption[], key: string): string => list.find((o) => o.key === key)?.label ?? key;

export function stoneTypeLabel(key: string): string { return labelOf(STONE_TYPES, key); }
export function diamondShapeLabel(key: string): string { return labelOf(DIAMOND_SHAPES, key); }

/** Karat → Tausendstel. Leer → null; ungültig → NaN. Keine Float-Arithmetik: der Text wird zerlegt. */
export function caratThousandths(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return NaN;
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim().replace(',', '.');
    if (s === '') return null;
  } else return NaN;
  const m = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) return NaN;
  const t = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
  if (t <= 0 || t > MAX_CARAT_THOUSANDTHS) return NaN;
  return t;
}

/** Tausendstel → Anzeige: mindestens zwei Nachkommastellen („0.80"), bis drei („0.005"). */
export function fmtCarat(thousandths: number): string {
  const ganz = Math.floor(thousandths / 1000);
  const rest = String(thousandths % 1000).padStart(3, '0');
  return ganz + '.' + (rest.endsWith('0') ? rest.slice(0, 2) : rest);
}

function qtyOf(v: unknown): number {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= MAX_STONE_QTY ? v : NaN;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n >= 1 && n <= MAX_STONE_QTY ? n : NaN;
  }
  return NaN;
}

function istLeer(r: Record<string, unknown>): boolean {
  return ROW_KEYS.every((k) => text(r[k]) === '');
}

/**
 * Die verbindliche Prüfung (Primary/Haus, Telefon, Rechner). Leere Zeilen fallen weg, alles
 * andere muss stimmen — eine falsche Zeile wird benannt, nicht still verbessert.
 */
export function parseStones(raw: unknown): { rows: StoneRow[]; issues: StoneIssue[] } {
  const issues: StoneIssue[] = [];
  const rows: StoneRow[] = [];
  if (raw === undefined || raw === null || raw === '') return { rows, issues };
  if (!Array.isArray(raw)) return { rows, issues: [{ row: -1, field: STONES_KEY, code: 'STONES_INVALID', message: 'Stones must be a list.' }] };
  if (raw.length > MAX_STONE_ROWS) issues.push({ row: -1, field: STONES_KEY, code: 'STONES_TOO_MANY', message: `At most ${MAX_STONE_ROWS} stone rows.` });
  raw.forEach((r0, i) => {
    const n = 'Stone ' + (i + 1) + ': ';
    if (!r0 || typeof r0 !== 'object' || Array.isArray(r0)) { issues.push({ row: i, field: 'row', code: 'STONE_ROW_INVALID', message: n + 'not a stone row.' }); return; }
    const r = r0 as Record<string, unknown>;
    if (istLeer(r)) return;
    for (const k of Object.keys(r)) {
      if (!ROW_KEYS.includes(k)) issues.push({ row: i, field: k, code: 'STONE_FIELD_UNKNOWN', message: n + `unknown field "${k}".` });
    }
    const type = text(r.type);
    const out: StoneRow = { type, qty: 0 };
    if (!type) issues.push({ row: i, field: 'type', code: 'STONE_TYPE_REQUIRED', message: n + 'choose the stone type.' });
    else if (!STONE_TYPES.some((t) => t.key === type)) issues.push({ row: i, field: 'type', code: 'STONE_TYPE_INVALID', message: n + `unknown stone type "${type}".` });
    const qty = qtyOf(r.qty);
    if (Number.isNaN(qty)) issues.push({ row: i, field: 'qty', code: 'STONE_QTY_INVALID', message: n + 'quantity must be a whole number of at least 1.' });
    else out.qty = qty;
    const ct = caratThousandths(r.carat);
    if (Number.isNaN(ct)) issues.push({ row: i, field: 'carat', code: 'STONE_CARAT_INVALID', message: n + 'total carat must be a positive number with at most 3 decimals.' });
    else if (ct !== null) out.carat = ct / 1000;
    const name = text(r.name);
    if (type === 'other') {
      if (!name) issues.push({ row: i, field: 'name', code: 'STONE_NAME_REQUIRED', message: n + 'enter the stone name for "Other".' });
      else if (name.length > MAX_STONE_NAME) issues.push({ row: i, field: 'name', code: 'STONE_NAME_TOO_LONG', message: n + `stone name is longer than ${MAX_STONE_NAME} characters.` });
      else out.name = name;
    } else if (name) {
      issues.push({ row: i, field: 'name', code: 'STONE_NAME_ONLY_OTHER', message: n + 'a stone name belongs only to "Other".' });
    }
    for (const k of DIAMOND_ONLY) {
      const v = text(r[k]);
      if (!v) continue;
      if (type !== 'diamond') { issues.push({ row: i, field: k, code: 'STONE_DIAMOND_ONLY', message: n + `${k} belongs only to diamonds.` }); continue; }
      const list = k === 'color' ? DIAMOND_COLORS : k === 'clarity' ? DIAMOND_CLARITIES : DIAMOND_SHAPES;
      if (!list.some((o) => o.key === v)) issues.push({ row: i, field: k, code: 'STONE_' + k.toUpperCase() + '_INVALID', message: n + `unknown ${k} "${v}".` });
      else out[k] = v;
    }
    rows.push(out);
  });
  return { rows: issues.length ? [] : rows, issues };
}

/** Für die Anzeige: gespeicherte Zeilen lesen (auch als JSON-Text aus einer SQL-Zeile); Ungültiges fällt weg. */
export function readStones(raw: unknown): StoneRow[] {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  const out: StoneRow[] = [];
  for (const r of v) {
    const p = parseStones([r]);
    if (!p.issues.length && p.rows[0]) out.push(p.rows[0]);
  }
  return out;
}

/** Summe der Diamant-Karat in Tausendstel; null, wenn keine Diamant-Zeile Karat trägt. */
export function diamondCaratThousandths(rows: readonly StoneRow[]): number | null {
  let sum: number | null = null;
  for (const r of rows) {
    if (r.type !== 'diamond' || r.carat === undefined) continue;
    const t = caratThousandths(r.carat);
    if (t === null || Number.isNaN(t)) continue;
    sum = (sum ?? 0) + t;
  }
  return sum;
}

/** Tausendstel eines gespeicherten Diamond-Weight (Zahl) — für den Vergleich „war abgeleitet?". */
function storedThousandths(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

/**
 * Die EINE Stelle, an der ein Speichern die Steinliste übernimmt (Anlegen und Ändern, Rechner und
 * Primary). Prüft die Zeilen, speichert sie normalisiert (leere Liste → Schlüssel entfällt) und
 * leitet Diamond Weight ab:
 *   • Zeilen mit Diamant-Karat → Diamond Weight = deren Summe.
 *   • keine Diamant-Karat mehr, der alte Wert WAR aus der Liste abgeleitet → er entfällt.
 *   • sonst (Wert von vor der Steinliste) → unverändert.
 * `previous` = die bisher gespeicherten Merkmale (beim Ändern), sonst weglassen.
 */
export function normalizeStoneAttributes<T extends Record<string, unknown>>(
  categoryId: string | null | undefined, attributes: T | null | undefined, previous?: Record<string, unknown> | null,
): { attributes: T; issues: StoneIssue[] } {
  const out = { ...(attributes || {}) } as Record<string, unknown>;
  const roh = out[STONES_KEY];
  const vorhanden = !(roh === undefined || roh === null || roh === '' || (Array.isArray(roh) && roh.length === 0));
  if (!stonesApply(categoryId)) {
    if (vorhanden) return { attributes: out as T, issues: [{ row: -1, field: STONES_KEY, code: 'STONES_NOT_FOR_CATEGORY', message: 'Stones are only recorded for Gold-Diamond Jewellery.' }] };
    delete out[STONES_KEY];
    return { attributes: out as T, issues: [] };
  }
  const { rows, issues } = parseStones(roh);
  if (issues.length) return { attributes: out as T, issues };
  if (rows.length) out[STONES_KEY] = rows; else delete out[STONES_KEY];
  const summe = diamondCaratThousandths(rows);
  if (summe !== null) {
    out[DIAMOND_WEIGHT_KEY] = summe / 1000;
  } else if (previous) {
    const vorherSumme = diamondCaratThousandths(readStones(previous[STONES_KEY]));
    const vorherGewicht = storedThousandths(previous[DIAMOND_WEIGHT_KEY]);
    const jetztGewicht = storedThousandths(out[DIAMOND_WEIGHT_KEY]);
    if (vorherSumme !== null && vorherGewicht === vorherSumme && jetztGewicht === vorherGewicht) delete out[DIAMOND_WEIGHT_KEY];
  }
  return { attributes: out as T, issues: [] };
}

/** Woher kommt das angezeigte Diamond Weight? */
export function diamondWeightInfo(attributes: Record<string, unknown> | null | undefined):
  { thousandths: number | null; source: 'stones' | 'legacy' | 'none' } {
  const a = attributes || {};
  const summe = diamondCaratThousandths(readStones(a[STONES_KEY]));
  if (summe !== null) return { thousandths: summe, source: 'stones' };
  const alt = storedThousandths(a[DIAMOND_WEIGHT_KEY]);
  return alt !== null ? { thousandths: alt, source: 'legacy' } : { thousandths: null, source: 'none' };
}

/** Eine Zeile ausgeschrieben: „Diamond · Qty 1 · 0.50 ct · G · VS1 · Oval". */
export function stoneRowLabel(r: StoneRow): string {
  const art = r.type === 'other' ? (r.name || 'Other') : stoneTypeLabel(r.type);
  const t = caratThousandths(r.carat);
  return [art, 'Qty ' + r.qty, t && !Number.isNaN(t) ? fmtCarat(t) + ' ct' : '',
    r.color || '', r.clarity || '', r.shape ? diamondShapeLabel(r.shape) : ''].filter(Boolean).join(' · ');
}

/**
 * Kurzform für Listen und Dokumente: je Steinart (bei Other je Name) die Karat-Summe, sonst die
 * Stückzahl — „Diamond 0.80 ct · Emerald 0.45 ct", „Pearl ×12". Reihenfolge des ersten Auftretens.
 */
export function stonesSummary(rowsOrRaw: readonly StoneRow[] | unknown): string {
  const rows = Array.isArray(rowsOrRaw) && rowsOrRaw.every((r) => r && typeof r === 'object' && 'qty' in r)
    ? rowsOrRaw as StoneRow[] : readStones(rowsOrRaw);
  const gruppen: Array<{ label: string; t: number | null; qty: number }> = [];
  for (const r of rows) {
    const label = r.type === 'other' ? (r.name || 'Other') : stoneTypeLabel(r.type);
    let g = gruppen.find((x) => x.label === label);
    if (!g) { g = { label, t: null, qty: 0 }; gruppen.push(g); }
    g.qty += r.qty;
    const t = caratThousandths(r.carat);
    if (t !== null && !Number.isNaN(t)) g.t = (g.t ?? 0) + t;
  }
  return gruppen.map((g) => g.label + ' ' + (g.t !== null ? fmtCarat(g.t) + ' ct' : '×' + g.qty)).join(' · ');
}

/** Geschlossene Zusammenfassung des Abschnitts: „3 rows · Diamond 0.80 ct · Emerald 0.45 ct". */
export function stonesSectionSummary(rows: readonly StoneRow[]): string {
  if (!rows.length) return 'none';
  return rows.length + (rows.length === 1 ? ' row' : ' rows') + ' · ' + stonesSummary(rows);
}

/** Durchsuchbarer Text: Steinarten, Other-Namen, Diamant-Merkmale. */
export function stonesSearchText(raw: unknown): string {
  return readStones(raw).map((r) => [
    r.type === 'other' ? r.name : stoneTypeLabel(r.type), r.color, r.clarity, r.shape ? diamondShapeLabel(r.shape) : '',
  ].filter(Boolean).join(' ')).join(' ');
}

/**
 * KI-Vorschläge: nur Zeilen, die die Prüfung bestehen; ein Stein wird über seine Bezeichnung
 * erkannt („Diamond" → diamond, unbekannt → Other mit Namen). Nichts wird erfunden — was fehlt,
 * bleibt leer; eine Zeile ohne erkennbare Stückzahl entfällt.
 */
export function stonesFromAi(raw0: unknown): StoneRow[] {
  let raw = raw0;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }   // vom Primary als JSON-Text
  if (!Array.isArray(raw)) return [];
  const out: StoneRow[] = [];
  for (const r0 of raw.slice(0, MAX_STONE_ROWS)) {
    if (!r0 || typeof r0 !== 'object') continue;
    const r = r0 as Record<string, unknown>;
    const roh = text(r.type).toLowerCase();
    if (!roh) continue;
    const typ = STONE_TYPES.find((t) => t.key === roh.replace(/\s+/g, '_') || t.label.toLowerCase() === roh);
    const zeile: Record<string, unknown> = typ && typ.key !== 'other' ? { type: typ.key } : { type: 'other', name: text(r.name) || text(r.type) };
    zeile.qty = r.qty;
    if (r.carat !== undefined && r.carat !== null && r.carat !== '') zeile.carat = r.carat;
    if (zeile.type === 'diamond') {
      for (const k of DIAMOND_ONLY) {
        const v = text(r[k]);
        if (!v) continue;
        const list = k === 'color' ? DIAMOND_COLORS : k === 'clarity' ? DIAMOND_CLARITIES : DIAMOND_SHAPES;
        const hit = list.find((o) => o.key.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase());
        if (hit) zeile[k] = hit.key;
      }
    }
    const p = parseStones([zeile]);
    if (!p.issues.length && p.rows[0]) out.push(p.rows[0]);
  }
  return out;
}

/** Bezeichnung oder Schlüssel („Cubic Zirconia", „cubic_zirconia", „vs1", „Round") → Schlüssel der Liste, sonst null. */
function optionKey(list: readonly StoneOption[], v: unknown): string | null {
  const s = text(v).toLowerCase();
  if (!s) return null;
  const hit = list.find((o) => o.key.toLowerCase() === s || o.label.toLowerCase() === s || o.key === s.replace(/[\s-]+/g, '_'));
  return hit ? hit.key : null;
}

/**
 * Zeilen, wie ein Mensch sie in eine Tabelle schreibt (Excel-Import): Steinart, Farbe, Reinheit und
 * Form auch als Bezeichnung, groß/klein egal („Diamond", „Cubic Zirconia", „vs1", „Round").
 * Übersetzt wird nur die Schreibweise — geprüft wird mit derselben `parseStones` wie am Rechner und
 * am Telefon. Was nicht passt, bleibt stehen und wird dort benannt; nichts wird erfunden.
 */
export function stonesFromLabels(raw: ReadonlyArray<Record<string, unknown>>): { rows: StoneRow[]; issues: StoneIssue[] } {
  return parseStones(raw.map((r) => {
    const z: Record<string, unknown> = { ...r };
    const typ = optionKey(STONE_TYPES, r.type);
    if (typ) z.type = typ;
    for (const k of DIAMOND_ONLY) {
      const key = optionKey(k === 'color' ? DIAMOND_COLORS : k === 'clarity' ? DIAMOND_CLARITIES : DIAMOND_SHAPES, r[k]);
      if (key) z[k] = key;
    }
    return z;
  }));
}

/** Ein Nein der Steinprüfung beim Schreiben — mit dem Code, den die Befehle weiterreichen. */
export class StonesRejected extends Error {
  readonly code = 'STONES_INVALID';
  constructor(message: string) { super(message); this.name = 'StonesRejected'; }
}

/** Die letzte Sicherung an der Schreibstelle: normalisieren oder mit dem ersten Satz ablehnen. */
export function stonesOrThrow<T extends Record<string, unknown>>(
  categoryId: string | null | undefined, attributes: T, previous?: Record<string, unknown> | null,
): T {
  const r = normalizeStoneAttributes(categoryId, attributes, previous);
  if (r.issues.length) throw new StonesRejected(r.issues[0].message);
  return r.attributes;
}

/** Hat die Maske schon Steinzeilen (auch unfertige)? Dann überschreibt die KI sie nicht. */
export function hasStoneRows(v: unknown): boolean {
  let x = v;
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return false; } }
  return Array.isArray(x) && x.some((r) => r && typeof r === 'object' && Object.values(r as Record<string, unknown>).some((w) => text(w) !== ''));
}

/**
 * Die KI-Merkmale in die Merkmale einer Maske übernehmen (bisheriges Verhalten: die KI schlägt vor,
 * der Mensch bestätigt) — mit einer Ausnahme: eine schon erfasste Steinliste bleibt, wie sie ist.
 */
export function mergeAiAttributes<T extends Record<string, unknown>>(current: T | null | undefined, ai: Record<string, unknown> | null | undefined): T {
  const out = { ...(current || {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(ai || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (k === STONES_KEY && hasStoneRows(out[STONES_KEY])) continue;
    out[k] = v;
  }
  return out as T;
}

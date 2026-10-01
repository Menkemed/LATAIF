// ════════════════════════════════════════════════════════════════════════════
// DISPLAY-NAME — der EINE Anzeigename eines Artikels.
//
// Überall, wo die App einen Artikel nennt (Collection, Suche, Einkauf, Rechnung, Beleg,
// Etikett, Handy), kommt der Name von hier — statt dass jede Stelle selbst „Marke + Modell"
// zusammensetzt.
//
// Regel:
//   • Hat der Artikel Marke oder Modell → genau die (wie bisher: „Rolex Datejust 36").
//   • Sonst entsteht der Name aus den Merkmalen: Schmuckart · Beschreibung · Karat · Gewicht,
//     z. B. „Ring · Baguette Diamond · 18K White Gold · 3.10 g".
//   • Sonst der Kategoriename; sonst leer (der Aufrufer entscheidet über „(unnamed)").
//
// Gespeichert wird hier NICHTS: Marke und Modell bleiben, wie sie sind (auch ältere Werte bei
// Gold-Diamond Jewellery). Die Handy-Seite trägt denselben Algorithmus als JavaScript
// (`mobile_page.rs`, `displayName`) — ein Paritätstest hält beide gleich.
// ════════════════════════════════════════════════════════════════════════════
import { lookupCategory } from '../utils/category-lookup.ts';
import { stonesApply, stonesFromAi } from './stones.ts';

/** Bei dieser Kategorie stehen Marke und Modell nicht in den Eingabemasken — die Merkmale sagen es schon. */
export const BRAND_MODEL_HIDDEN_CATEGORIES: readonly string[] = ['cat-gold-jewelry'];

/** Marke/Modell in der Maske ausblenden? (Ein älterer, schon gespeicherter Wert wird beim Bearbeiten trotzdem gezeigt.) */
export function brandModelHidden(categoryId: string | null | undefined): boolean {
  return BRAND_MODEL_HIDDEN_CATEGORIES.includes(String(categoryId ?? ''));
}

export interface DisplayNameSource {
  brand?: string | null;
  name?: string | null;
  categoryId?: string | null;
  /** Das Merkmal-Objekt — oder, aus einer SQL-Zeile, sein JSON-Text. */
  attributes?: Record<string, unknown> | string | null;
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function attrsOf(a: DisplayNameSource['attributes']): Record<string, unknown> {
  if (!a) return {};
  if (typeof a === 'string') {
    try { const o = JSON.parse(a); return o && typeof o === 'object' && !Array.isArray(o) ? o as Record<string, unknown> : {}; } catch { return {}; }
  }
  return a;
}

/** „EMERALD PENDANT" → „Emerald Pendant"; gemischte Schreibweise bleibt, wie sie ist. */
function sanfteSchreibweise(s: string): string {
  if (!s || s !== s.toUpperCase() || s === s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** 5 → „5 g", 3.1 → „3.10 g", 2.92 → „2.92 g". */
function gewicht(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(text(v));
  if (!Number.isFinite(n) || n <= 0) return '';
  return (Number.isInteger(n) ? String(n) : n.toFixed(2)) + ' g';
}
/** Dieselbe Gewichtsschreibweise für andere Anzeigen (z. B. die Collection-Karte). */
export const formatGrams = gewicht;

/** „18K White" → „18K White Gold", „21K" → „21K Gold" — sonst weiß man nicht, was die Farbe ist. „Silver" und ein Wert mit „Gold" bleiben. */
export function karatText(v: unknown): string {
  const s = text(v);
  return /^[0-9]+\s*KT?\b/i.test(s) && !/gold/i.test(s) ? s + ' Gold' : s;
}

/** Der Name aus den Merkmalen allein (ohne Marke/Modell) — leer, wenn es keine gibt. */
export function nameFromAttributes(attributes: DisplayNameSource['attributes']): string {
  const a = attrsOf(attributes);
  const art = text(a.item_type);
  let beschreibung = sanfteSchreibweise(text(a.description));
  if (beschreibung && art && beschreibung.toLowerCase() === art.toLowerCase()) beschreibung = '';
  // Nennt die Beschreibung die Schmuckart schon („Double Ring"), steht sie nicht noch einmal davor.
  const woerter = (s: string): string => ' ' + s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  const ohneArt = !!beschreibung && !!art && woerter(beschreibung).includes(woerter(art));
  return [ohneArt ? '' : art, beschreibung, karatText(a.karat), gewicht(a.weight)].filter(Boolean).join(' · ');
}

/** Der Anzeigename. Leer nur, wenn wirklich nichts da ist. */
export function productDisplayName(p: DisplayNameSource | null | undefined): string {
  if (!p) return '';
  const marke = text(p.brand);
  const modell = text(p.name);
  if (marke || modell) return [marke, modell].filter(Boolean).join(' ');
  const ausMerkmalen = nameFromAttributes(p.attributes);
  if (ausMerkmalen) return ausMerkmalen;
  return p.categoryId ? text(lookupCategory(p.categoryId)?.name) : '';
}

/**
 * AI Identify bei Gold-Diamond Jewellery: keine Marke, kein Modell — die Kategorie fragt nicht danach.
 * Hat die KI die Schmuckart dorthin geschrieben („Pendant"), wandert sie nach `item_type`, wenn das
 * Feld noch leer ist und der Wert eine der Auswahlen ist. Andere Kategorien bleiben unberührt.
 */
export function aiResultForCategory<T extends { brand?: string | null; name?: string | null; attributes?: Record<string, unknown> }>(
  result: T, categoryId: string | null | undefined,
): T {
  if (!result || !brandModelHidden(categoryId)) return result;
  const attributes: Record<string, unknown> = { ...(result.attributes || {}) };
  const optionen = (lookupCategory(String(categoryId))?.attributes || []).find((a) => a.key === 'item_type')?.options || [];
  if (!text(attributes.item_type)) {
    for (const v of [text(result.brand), text(result.name)]) {
      const treffer = optionen.find((o) => o.toLowerCase() === v.toLowerCase());
      if (treffer) { attributes.item_type = treffer; break; }
    }
  }
  // STONES — nur geprüfte Steinzeilen (nichts erfunden); Diamond Weight kommt aus den Zeilen, nie von der KI.
  if (stonesApply(categoryId)) {
    const zeilen = stonesFromAi(attributes.stones);
    if (zeilen.length) attributes.stones = zeilen; else delete attributes.stones;
    delete attributes.diamond_weight;
  }
  const { brand: _b, name: _n, ...rest } = result;
  return { ...rest, attributes } as unknown as T;
}

/**
 * Für zweizeilige Darstellungen (kleine Marke oben, Modell darunter): mit Marke/Modell wie
 * bisher; ohne beide steht der erzeugte Name als Titel und die obere Zeile bleibt leer.
 */
export function productDisplayLines(p: DisplayNameSource | null | undefined): { overline: string; title: string } {
  if (!p) return { overline: '', title: '' };
  const marke = text(p.brand);
  const modell = text(p.name);
  if (marke && modell) return { overline: marke, title: modell };
  if (marke || modell) return { overline: '', title: marke || modell };
  return { overline: '', title: productDisplayName(p) };
}

/** Der Anzeigename eines Reparatur-Gegenstands (Kundenstück) — derselbe Algorithmus wie beim Artikel. */
export function repairItemDisplayName(r: {
  itemBrand?: string | null; itemModel?: string | null; itemCategoryId?: string | null; itemAttributes?: Record<string, unknown> | string | null;
} | null | undefined): string {
  if (!r) return '';
  const marke = text(r.itemBrand);
  const modell = text(r.itemModel);
  if (marke || modell) return [marke, modell].filter(Boolean).join(' ');
  return nameFromAttributes(r.itemAttributes ?? null);
}

// ═══════════════════════════════════════════════════════════
// LATAIF — Safe Product Import logic (X3)
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Import-Logik: robustes Zahlen-Parsing, VAT-Scheme-Auflösung,
// Duplicate-Detection, Zeilen-Klassifikation und Summary/Import-Gate.
// KEIN React / DB / Tauri / xlsx hier → headless testbar via `node test/x3/import-hardening.test.ts`.
//
// Der UI-Layer (ImportPage.tsx) liefert nur die IO (Datei lesen, Kategorien auflösen,
// Backup, createProduct) und rendert das Ergebnis. Alle riskanten Entscheidungen
// (was ist gültig / Duplikat / welche Zahl / welches VAT-Scheme) fallen HIER und sind getestet.

import type { TaxScheme, CategoryAttribute } from '@/core/models/types';
import { DEFAULT_CATEGORIES } from '../models/default-categories.ts';
import { productDisplayName } from '../products/display-name.ts';
// STONES — Bedeutung und Prüfung der Steinzeilen kommen aus der EINEN Steinregel (Rechner/Telefon/Primary).
// Relativer Pfad: dieser Baustein läuft auch headless ohne Alias-Auflösung (test/x3).
import {
  stonesFromLabels, normalizeStoneAttributes, caratThousandths, fmtCarat, MAX_STONE_ROWS,
  STONE_TYPES, DIAMOND_COLORS, DIAMOND_CLARITIES, DIAMOND_SHAPES, type StoneRow,
} from '../products/stones.ts';

// SSOT-Werte (identisch mit TaxSchemeCanonical in core/models/types) — NICHT neu erfunden.
export const VAT_SCHEMES: readonly TaxScheme[] = ['VAT_10', 'ZERO', 'MARGIN'];

export type ImportRowStatus = 'new' | 'warning' | 'duplicate' | 'invalid';

export interface RawRow { [key: string]: string | number | undefined; }

// ── kleine String-Helfer ──
export function cleanStr(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

// Case-insensitive, whitespace-tolerante Spalten-Suche (erste passende Kopfzeile gewinnt).
export function getCol(row: RawRow, ...names: string[]): string | number | undefined {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, '');
    for (const k of keys) {
      if (k.toLowerCase().replace(/\s+/g, '') === target) return row[k];
    }
  }
  return undefined;
}

function norm(val: unknown): string {
  if (val === undefined || val === null) return '';
  return String(val).toLowerCase().trim();
}

// ── Steinspalten der Tabelle ──
// Je Stein eine Spaltengruppe: „Stone 1 Type", „Stone 1 Qty", „Stone 1 Carat", „Stone 1 Color",
// „Stone 1 Clarity", „Stone 1 Shape", „Stone 1 Name" — für weitere Steine Stone 2 …, Stone 3 … usw.
// Hier wird NUR die Tabelle gelesen; was eine gültige Steinzeile ist, entscheidet core/products/stones.ts.
const STONE_COLUMN = /^stone\s*(\d{1,3})\s*[-_:]?\s*(type|qty|quantity|total\s*carat|total\s*ct|carat|ct|colou?r|clarity|shape|name)$/i;
const STONE_FIELD: Record<string, string> = {
  type: 'type', qty: 'qty', quantity: 'qty', totalcarat: 'carat', totalct: 'carat', carat: 'carat', ct: 'carat',
  color: 'color', colour: 'color', clarity: 'clarity', shape: 'shape', name: 'name',
};

/** Die Steingruppen einer Zeile in Nummernfolge; Lücken bleiben leer (die Meldung „Stone 3: …" passt zur Spalte). */
export function readStoneColumns(row: RawRow): Array<Record<string, unknown>> {
  const gruppen = new Map<number, Record<string, unknown>>();
  for (const [k, v] of Object.entries(row)) {
    const m = STONE_COLUMN.exec(k.trim());
    if (!m) continue;
    const wert = typeof v === 'string' ? v.trim() : v;
    if (wert === undefined || wert === null || wert === '') continue;
    const n = Number(m[1]);
    if (n < 1) continue;
    const g = gruppen.get(n) || {};
    g[STONE_FIELD[m[2].toLowerCase().replace(/\s+/g, '')]] = wert;
    gruppen.set(n, g);
  }
  if (!gruppen.size) return [];
  const bis = Math.max(...gruppen.keys());
  return Array.from({ length: bis }, (_, i) => gruppen.get(i + 1) || {});
}

// ─────────────────────────────────────────────────────────────
// 1. Robuster Zahlen-Parser
// ─────────────────────────────────────────────────────────────
// Behandelt: 1234.50 · 1,234.50 (US) · 1.234,50 (EU) · 1234,50 (EU) · "BD 1,234.500".
// Regeln (dokumentiert, deterministisch):
//   - Currency/Buchstaben/Symbole/Spaces werden entfernt (nur 0-9 . , - bleiben).
//   - Sind '.' UND ',' vorhanden: der ZULETZT stehende ist das Dezimaltrennzeichen,
//     der andere ist Tausendertrennung.
//   - Nur Kommas: 1 Komma mit genau 3 Nachkommastellen (z. B. "1,234") ist MEHRDEUTIG
//     → ok=false (Zeile wird ggf. invalid/warning). Sonst: 1 Komma = Dezimal, mehrere = Tausender.
//   - Nur Punkte: 1 Punkt = Dezimal (BHD-freundlich), mehrere = Tausender.
// Leer → ok=true, value=0, empty=true (Aufrufer entscheidet: Cost leer = invalid, Qty leer = 1).
export interface NumberParse { ok: boolean; value: number; empty: boolean; ambiguous: boolean; }

export function parseNumber(raw: string | number | undefined | null): NumberParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0, empty: true, ambiguous: false };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, value: 0, empty: false, ambiguous: false };
    return { ok: true, value: raw, empty: false, ambiguous: false };
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: true, value: 0, empty: true, ambiguous: false };

  let s = trimmed.replace(/[^\d.,-]/g, ''); // Currency/Buchstaben/Spaces raus
  let sign = 1;
  if (s.startsWith('-')) sign = -1;
  s = s.replace(/-/g, '');
  if (s === '') return { ok: false, value: 0, empty: false, ambiguous: false };

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let normalized: string;
  let ambiguous = false;

  if (dots > 0 && commas > 0) {
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decimalSep === '.' ? ',' : '.';
    normalized = s.split(thouSep).join('').replace(decimalSep, '.');
  } else if (commas > 0) {
    if (commas === 1) {
      const after = s.split(',')[1] ?? '';
      if (after.length === 3) {
        ambiguous = true;            // "1,234" — Tausender ODER Dezimal? Nicht still raten.
        normalized = s.replace(',', ''); // Best-Guess (Tausender), aber ok=false
      } else {
        normalized = s.replace(',', '.'); // Dezimalkomma
      }
    } else {
      normalized = s.split(',').join(''); // mehrere Kommas = Tausender
    }
  } else if (dots > 0) {
    normalized = dots === 1 ? s : s.split('.').join(''); // 1 Punkt = Dezimal, mehrere = Tausender
  } else {
    normalized = s;
  }

  const val = Number(normalized);
  if (normalized === '' || Number.isNaN(val) || !Number.isFinite(val)) {
    return { ok: false, value: 0, empty: false, ambiguous };
  }
  return { ok: !ambiguous, value: sign * val, empty: false, ambiguous };
}

// ─────────────────────────────────────────────────────────────
// 2. VAT-Scheme-Auflösung (nie still MARGIN)
// ─────────────────────────────────────────────────────────────
// recognized = raw-Wert wurde als valides Scheme erkannt.
// fromDefault = raw war leer → import-weiter Default genutzt.
// scheme = null → nicht auflösbar (raw unbekannt ODER leer ohne Default) → Aufrufer blockiert.
export interface VatParse { scheme: TaxScheme | null; ok: boolean; fromDefault: boolean; recognized: boolean; }

const VAT_ALIASES: Record<string, TaxScheme> = {
  'vat_10': 'VAT_10', 'vat10': 'VAT_10', 'vat 10': 'VAT_10', 'vat': 'VAT_10', 'vat10%': 'VAT_10',
  'standard': 'VAT_10', 'standard rated': 'VAT_10', 'std': 'VAT_10', '10%': 'VAT_10', '10': 'VAT_10',
  'zero': 'ZERO', 'zero rated': 'ZERO', 'zero-rated': 'ZERO', 'exempt': 'ZERO', '0%': 'ZERO', '0': 'ZERO', 'z': 'ZERO',
  'margin': 'MARGIN', 'profit margin': 'MARGIN', 'profit margin scheme': 'MARGIN', 'm': 'MARGIN',
};

export function parseVatScheme(raw: string | number | undefined | null, defaultScheme: TaxScheme | null): VatParse {
  const s = norm(raw).replace(/\s+/g, ' ').trim();
  if (s === '') {
    return defaultScheme
      ? { scheme: defaultScheme, ok: true, fromDefault: true, recognized: false }
      : { scheme: null, ok: false, fromDefault: false, recognized: false };
  }
  const hit = VAT_ALIASES[s];
  if (hit) return { scheme: hit, ok: true, fromDefault: false, recognized: true };
  return { scheme: null, ok: false, fromDefault: false, recognized: false }; // vorhanden, aber unbekannt → nicht still defaulten
}

// ─────────────────────────────────────────────────────────────
// 3. Duplicate-Detection gegen bestehende Produkte (+ intra-file)
// ─────────────────────────────────────────────────────────────
export interface ExistingProductLike { sku?: string | null; brand?: string | null; attributes?: Record<string, unknown> | null; }
export interface ExistingProductIndex { skus: Set<string>; serials: Set<string>; brandRef: Set<string>; }

export function buildExistingIndex(products: ExistingProductLike[]): ExistingProductIndex {
  const skus = new Set<string>();
  const serials = new Set<string>();
  const brandRef = new Set<string>();
  for (const p of products) {
    const sku = norm(p.sku); if (sku) skus.add(sku);
    const serial = norm(p.attributes?.serial_no); if (serial) serials.add(serial);
    const brand = norm(p.brand); const ref = norm(p.attributes?.reference_no);
    if (brand && ref) brandRef.add(brand + '|' + ref);
  }
  return { skus, serials, brandRef };
}

export interface DuplicateCheck { duplicate: boolean; reason?: string; }

export function detectDuplicate(
  c: { sku: string; serialNo: string; brand: string; referenceNo: string },
  index: ExistingProductIndex,
): DuplicateCheck {
  const sku = norm(c.sku);
  if (sku && index.skus.has(sku)) return { duplicate: true, reason: `SKU "${c.sku}" already exists` };
  const serial = norm(c.serialNo);
  if (serial && index.serials.has(serial)) return { duplicate: true, reason: `Serial "${c.serialNo}" already exists` };
  const brand = norm(c.brand); const ref = norm(c.referenceNo);
  if (brand && ref && index.brandRef.has(brand + '|' + ref)) {
    return { duplicate: true, reason: `Brand+Reference "${c.brand} ${c.referenceNo}" already exists` };
  }
  return { duplicate: false };
}

// keeper-Keys in den (kopierten) Index eintragen → fängt datei-INTERNE Duplikate.
function addToIndex(index: ExistingProductIndex, c: { sku: string; serialNo: string; brand: string; referenceNo: string }): void {
  const sku = norm(c.sku); if (sku) index.skus.add(sku);
  const serial = norm(c.serialNo); if (serial) index.serials.add(serial);
  const brand = norm(c.brand); const ref = norm(c.referenceNo);
  if (brand && ref) index.brandRef.add(brand + '|' + ref);
}

function cloneIndex(index: ExistingProductIndex): ExistingProductIndex {
  return { skus: new Set(index.skus), serials: new Set(index.serials), brandRef: new Set(index.brandRef) };
}

// ─────────────────────────────────────────────────────────────
// 4. Zeilen-Klassifikation
// ─────────────────────────────────────────────────────────────
export interface ClassifiedRow {
  index: number;
  status: ImportRowStatus;
  errors: string[];
  warnings: string[];
  sku: string; categoryId: string; categoryName: string; categoryMatched: boolean;
  brand: string; name: string; referenceNo: string; serialNo: string;
  description1: string; description2: string; description3: string;
  size: string; material: string; markup: string;
  weight: number | null; carat: number | null; diamondWeight: number | null;
  /** Geprüfte, normalisierte Steinzeilen (wie am Rechner/Telefon) — leer ohne Steinspalten. */
  stones: StoneRow[];
  /** Gold-Diamond Jewellery: erkannte Auswahlwerte (leer = nicht gesetzt/nicht erkannt). */
  itemType: string; karatColor: string;
  /** Die Merkmale, mit denen der Artikel angelegt wird (bei Gold genau die Felder der Maske). */
  attributes: Record<string, unknown>;
  /** Notiz des Artikels (Description 2/3; bei Gold auch Werte ohne eigenes Feld). */
  notes?: string;
  /** Der Anzeigename des künftigen Artikels (Vorschau). */
  displayName: string;
  purchasePrice: number; plannedSalePrice: number | undefined;
  quantity: number; isSold: boolean;
  taxScheme: TaxScheme | null; vatFromDefault: boolean;
  duplicateReason?: string;
}

export interface ClassifyOptions {
  resolveCategory: (rawName: string, rowIndex: number) => { id: string; name: string; matched: boolean };
  defaultVatScheme: TaxScheme | null;
  existingIndex: ExistingProductIndex;
  /** Die Merkmale einer Kategorie (aus der Datenbank); ohne Angabe die Standard-Kategorien. */
  categoryAttributes?: (categoryId: string) => readonly CategoryAttribute[] | undefined;
}

// ── Gold-Diamond Jewellery: dieselben Felder wie die Maske am Rechner/Telefon ──
// Nur diese Kategorie wird kanonisch angelegt (item_type, karat, weight, description, stones,
// diamond_weight). Alle anderen Kategorien behalten die bisherige Zuordnung unverändert.
export const GOLD_IMPORT_CATEGORY = 'cat-gold-jewelry';
const ITEM_TYPE_COLUMNS = ['Item Type', 'Piece Type', 'Jewellery Type', 'Jewelry Type'];
const KARAT_COLOR_COLUMNS = ['Karat & Color', 'Karat & Colour', 'Karat and Color', 'Karat and Colour', 'Karat/Color', 'Karat Color'];

function optionsOf(attrs: readonly CategoryAttribute[], key: string): string[] {
  return attrs.find((a) => a.key === key)?.options || [];
}

/** „Rings", „earring", „RING" → die Auswahl der Kategorie („Ring", „Earrings"); sonst null. */
export function itemTypeOption(raw: string, options: readonly string[]): string | null {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return options.find((o) => { const l = o.toLowerCase(); return l === s || l === s.replace(/s$/, '') || l === s + 's'; }) ?? null;
}

/**
 * Karat & Color aus dem, was eine Tabelle dazu hergibt: der Wert selbst („18K Yellow"), oder alte
 * Spalten zusammen („18" + „White Gold" → „18K White"; „750 rose" → „18K Rose"). 24K/22K/21K gibt es
 * nur in Gelb. Nichts wird geraten: ohne eindeutige Farbe (z. B. nur „18") → null.
 */
export function karatColorOption(raw: string, options: readonly string[]): string | null {
  const s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const genau = options.find((o) => o.toLowerCase() === s);
  if (genau) return genau;
  // Eine Zahl zählt nur für sich — nie als Teil einer Dezimalzahl („0.18" ist kein 18K).
  const fuer = (muster: string) => new RegExp('(?<![\\d.,])(' + muster + ')(?!\\d|[.,]\\d)').exec(s);
  if (/\bsilver\b|\bsterling\b/.test(s) || fuer('925')) return options.find((o) => o.toLowerCase() === 'silver') ?? null;
  const FEIN: Record<string, number> = { '999': 24, '916': 22, '875': 21, '750': 18, '585': 14, '375': 9 };
  const fein = fuer('999|916|875|750|585|375');
  const zahl = fuer('24|22|21|18|14|9');
  const k: number | null = fein ? FEIN[fein[1]] : zahl ? Number(zahl[1]) : null;
  let farbe = /yellow/.test(s) ? 'Yellow' : /rose|pink|red/.test(s) ? 'Rose' : /white/.test(s) ? 'White'
    : /\bmix|two[\s-]?tone|bi[\s-]?colou?r|tri[\s-]?colou?r/.test(s) ? 'Mix' : '';
  if (k !== null && !farbe && (k === 24 || k === 22 || k === 21)) farbe = 'Yellow';
  if (k === null || !farbe) return null;
  const wunsch = `${k}K ${farbe}`.toLowerCase();
  return options.find((o) => o.toLowerCase() === wunsch) ?? null;
}

export function isImportable(status: ImportRowStatus): boolean {
  return status === 'new' || status === 'warning';
}

function classifyRow(row: RawRow, idx: number, opts: ClassifyOptions, runningIndex: ExistingProductIndex): ClassifiedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawCategory = cleanStr(getCol(row, 'Catergorie', 'Category', 'Categorie', 'Type'));
  const cat = opts.resolveCategory(rawCategory, idx);
  const brand = cleanStr(getCol(row, 'Brand'));
  const description1 = cleanStr(getCol(row, 'Description 1'));
  const description2 = cleanStr(getCol(row, 'Description 2'));
  const description3 = cleanStr(getCol(row, 'Description 3'));
  const sku = cleanStr(getCol(row, 'Serial Tag', 'SKU'));
  const referenceNo = cleanStr(getCol(row, 'Model', 'Reference', 'Reference No'));
  const serialNo = cleanStr(getCol(row, 'Serial', 'Serial No'));
  const size = cleanStr(getCol(row, 'Size'));
  const material = cleanStr(getCol(row, 'Metal', 'Material'));
  const markup = cleanStr(getCol(row, 'Markup'));
  // GOLD — Item Type und Karat & Color wie in der Maske. Alte Spalten bleiben lesbar: „Karat"/„Carat"
  // (auch zusammen mit der Farbe aus „Metal"/„Material"). „Material" wird NIE zu Item Type — im alten
  // Import war es immer das Metall.
  const gold = cat.id === GOLD_IMPORT_CATEGORY;
  const katAttrs = (opts.categoryAttributes?.(cat.id) ?? DEFAULT_CATEGORIES.find((c) => c.id === cat.id)?.attributes) || [];
  const itemTypeRaw = gold ? cleanStr(getCol(row, ...ITEM_TYPE_COLUMNS)) : '';
  const karatColorRaw = gold ? cleanStr(getCol(row, ...KARAT_COLOR_COLUMNS)) : '';
  const karatAltRaw = gold ? cleanStr(getCol(row, 'Karat', 'Carat')) : '';
  const itemType = itemTypeRaw ? itemTypeOption(itemTypeRaw, optionsOf(katAttrs, 'item_type')) || '' : '';
  const karatQuelle = karatColorRaw || [karatAltRaw, material].filter(Boolean).join(' ');
  const karatColor = gold && karatQuelle ? karatColorOption(karatQuelle, optionsOf(katAttrs, 'karat')) || '' : '';
  // Bei Gold kein erfundener Name: ohne Marke/Modell benennen die Merkmale den Artikel (wie in der Maske).
  const name = gold ? referenceNo : (description1 || referenceNo || brand || 'Unknown');

  // ── Zahlen ──
  const costP = parseNumber(getCol(row, 'Cost', 'Purchase Price', 'Cost Price'));
  const saleP = parseNumber(getCol(row, 'Tag Price', 'Sale Price', 'Price', 'Selling Price'));
  const qtyP = parseNumber(getCol(row, 'Qty', 'QTY', 'Quantity'));
  const weightP = parseNumber(getCol(row, 'Weight', 'Gross Weight'));
  const caratP = parseNumber(getCol(row, 'Carat', 'Karat'));
  const diaP = parseNumber(getCol(row, 'Diamond Weight', 'Diamond Carat', 'Diamond'));

  // Pflicht: Identität (bei Gold genügt die Schmuckart — Marke/Modell werden dort nicht verlangt)
  if (!brand && !description1 && !referenceNo && !itemTypeRaw) errors.push(gold ? 'No item type or description' : 'No brand or name');

  // Pflicht: Cost > 0, sauber geparst
  if (costP.empty) errors.push('No cost');
  else if (!costP.ok) errors.push(costP.ambiguous ? 'Ambiguous cost number' : 'Invalid cost number');
  else if (costP.value <= 0) errors.push('Cost must be > 0');
  const purchasePrice = costP.ok && !costP.empty ? costP.value : 0;

  // Pflicht: Kategorie
  if (!cat.id) errors.push('No category');
  else if (!rawCategory) warnings.push('No category in file → defaulted');
  else if (!cat.matched) warnings.push('Category not matched → defaulted');

  // Qty: leer = 1; unklar/<=0 = invalid
  let quantity = 1;
  if (qtyP.empty) quantity = 1;
  else if (!qtyP.ok) errors.push(qtyP.ambiguous ? 'Ambiguous quantity' : 'Invalid quantity');
  else if (qtyP.value <= 0) errors.push('Quantity must be > 0');
  else quantity = Math.floor(qtyP.value);

  // Sale price: optional; unklar → warnen + ignorieren
  let plannedSalePrice: number | undefined;
  if (!saleP.empty) {
    if (!saleP.ok) warnings.push(saleP.ambiguous ? 'Ambiguous sale price → ignored' : 'Invalid sale price → ignored');
    else if (saleP.value < 0) warnings.push('Negative sale price → ignored');
    else plannedSalePrice = saleP.value;
  }

  // optionale Attribute (Weight/Carat/Diamond): unklar → warnen + leer lassen
  const optNum = (p: NumberParse, label: string): number | null => {
    if (p.empty) return null;
    if (!p.ok) { warnings.push(`${label} unclear → left blank`); return null; }
    if (p.value < 0) { warnings.push(`${label} negative → left blank`); return null; }
    return p.value;
  };
  const weight = optNum(weightP, 'Weight');
  const carat = optNum(caratP, 'Carat');
  let diamondWeight = optNum(diaP, 'Diamond weight');

  // STONES — Steinspalten mit derselben Regel wie Rechner und Telefon. Eine falsche Steinzeile macht die
  // Zeile ungültig (nichts wird still verbessert). Mit Diamant-Karat ist deren Summe das Diamond Weight;
  // ein altes Diamond Weight ohne Steinspalten bleibt, wie es ist — daraus entstehen keine Steinzeilen.
  let stones: StoneRow[] = [];
  const steinEntwurf = readStoneColumns(row);
  if (steinEntwurf.length) {
    const p = stonesFromLabels(steinEntwurf);
    const n = p.issues.length ? p : normalizeStoneAttributes(cat.id, {
      stones: p.rows, ...(diamondWeight != null ? { diamond_weight: diamondWeight } : {}),
    });
    if (n.issues.length) {
      for (const i of n.issues) errors.push('Stones — ' + i.message);
    } else if ('attributes' in n) {
      stones = (n.attributes.stones as StoneRow[] | undefined) || [];
      const dw = n.attributes.diamond_weight;
      if (typeof dw === 'number') {
        const alt = diamondWeight != null ? caratThousandths(Math.round(diamondWeight * 1000) / 1000) : null;
        const neu = caratThousandths(dw);
        if (alt !== null && neu !== null && alt !== neu) {
          warnings.push(`Diamond Weight ${diamondWeight} replaced by the diamond rows (${fmtCarat(neu as number)} ct)`);
        }
        diamondWeight = dw;
      }
    }
  }

  // ── Merkmale + Notiz, mit denen angelegt wird ──
  const attributes: Record<string, unknown> = {};
  let notizTeile: string[] = [description2, description3];
  if (gold) {
    // Genau die Felder der Maske. Was dort kein Feld hat, geht nicht verloren, sondern in die Notiz.
    if (weight != null) attributes.weight = weight;
    if (diamondWeight != null) attributes.diamond_weight = diamondWeight;
    if (stones.length) attributes.stones = stones;
    if (itemType) attributes.item_type = itemType;
    if (karatColor) attributes.karat = karatColor;
    if (description1) attributes.description = description1;
    if (itemTypeRaw && !itemType) warnings.push(`Item Type "${itemTypeRaw}" not recognised → left empty (kept in notes)`);
    else if (!itemTypeRaw) warnings.push('Item Type not set');
    if (karatQuelle && !karatColor) warnings.push(`Karat & Color "${karatQuelle}" not recognised → left empty (kept in notes)`);
    else if (!karatQuelle) warnings.push('Karat & Color not set');
    if (weight == null) warnings.push('Weight not set');
    // Die Metall-Spalte ist nur dann „aufgebraucht“, wenn erst sie die Farbe zu Karat & Color geliefert hat.
    const metallVerbraucht = !karatColorRaw && !!karatColor && !karatColorOption(karatAltRaw, optionsOf(katAttrs, 'karat'));
    notizTeile = notizTeile.concat([
      itemTypeRaw && !itemType ? `Item type: ${itemTypeRaw}` : '',
      karatColorRaw && !karatColor ? `Karat & Color: ${karatColorRaw}` : '',
      !karatColorRaw && karatAltRaw && !karatColor ? `Karat: ${karatAltRaw}` : '',
      material && !metallVerbraucht ? `Metal: ${material}` : '',
      serialNo ? `Serial: ${serialNo}` : '', size ? `Size: ${size}` : '', markup ? `Markup: ${markup}` : '',
    ]);
  } else {
    // Alle anderen Kategorien: die bisherige Zuordnung, unverändert.
    if (referenceNo) attributes.reference_no = referenceNo;
    if (serialNo) attributes.serial_no = serialNo;
    if (description1) attributes.description_1 = description1;
    if (description2) attributes.description_2 = description2;
    if (description3) attributes.description_3 = description3;
    if (size) attributes.size = size;
    if (material) attributes.metal = material;
    if (markup) attributes.markup = markup;
    if (weight != null) attributes.weight = weight;
    if (carat != null) attributes.carat = carat;
    if (diamondWeight != null) attributes.diamond_weight = diamondWeight;
    if (stones.length) attributes.stones = stones;
  }
  const notes = notizTeile.filter(Boolean).join(' / ') || undefined;
  const displayName = productDisplayName({ brand, name, categoryId: cat.id, attributes: attributes as never }) || name;

  // VAT: nie still MARGIN
  const rawVat = cleanStr(getCol(row, 'VAT', 'VAT Scheme', 'Tax', 'Tax Scheme', 'Scheme'));
  const vat = parseVatScheme(rawVat, opts.defaultVatScheme);
  if (!vat.scheme) errors.push(rawVat ? `Unrecognized VAT scheme "${rawVat}"` : 'VAT scheme not set');

  const soldRaw = cleanStr(getCol(row, 'Sold', 'Status')).toLowerCase();
  const isSold = soldRaw === 'sold' || soldRaw === 'yes' || soldRaw === '1' || soldRaw === 'x';

  // ── Status: invalid > duplicate > warning > new ──
  let status: ImportRowStatus;
  let duplicateReason: string | undefined;
  if (errors.length) {
    status = 'invalid';
  } else {
    const dup = detectDuplicate({ sku, serialNo, brand, referenceNo }, runningIndex);
    if (dup.duplicate) { status = 'duplicate'; duplicateReason = dup.reason; }
    else status = warnings.length ? 'warning' : 'new';
  }

  return {
    index: idx, status, errors, warnings,
    sku, categoryId: cat.id, categoryName: cat.name, categoryMatched: cat.matched,
    brand, name, referenceNo, serialNo, description1, description2, description3,
    size, material, markup, weight, carat, diamondWeight, stones, itemType, karatColor, attributes, notes, displayName,
    purchasePrice, plannedSalePrice, quantity, isSold,
    taxScheme: vat.scheme, vatFromDefault: vat.fromDefault, duplicateReason,
  };
}

// Klassifiziert alle Zeilen; importierbare (new/warning) Keys wandern in einen KOPIERTEN
// Index → datei-interne Duplikate werden als 'duplicate' erkannt (kein Doppel-Insert aus einer Datei).
export function classifyRows(rows: RawRow[], opts: ClassifyOptions): ClassifiedRow[] {
  const running = cloneIndex(opts.existingIndex);
  const out: ClassifiedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = classifyRow(rows[i], i, opts, running);
    if (isImportable(r.status)) addToIndex(running, { sku: r.sku, serialNo: r.serialNo, brand: r.brand, referenceNo: r.referenceNo });
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 5. Summary + Import-Gate
// ─────────────────────────────────────────────────────────────
export interface ImportSummary {
  total: number; new: number; warning: number; duplicate: number; invalid: number;
  importable: number; estQtyTotal: number; estCostTotal: number;
}

export function summarize(rows: ClassifiedRow[]): ImportSummary {
  const s: ImportSummary = { total: rows.length, new: 0, warning: 0, duplicate: 0, invalid: 0, importable: 0, estQtyTotal: 0, estCostTotal: 0 };
  for (const r of rows) {
    s[r.status]++;
    if (isImportable(r.status)) {
      s.importable++;
      s.estQtyTotal += r.quantity;
      s.estCostTotal += r.purchasePrice * r.quantity;
    }
  }
  return s;
}

export interface ImportGateState { canBackup: boolean; vatSelected: boolean; summary: ImportSummary; }

// Import-Button nur aktiv, wenn: Backup möglich · VAT-Scheme gewählt · >=1 importierbare (new/warning)
// Zeile. invalid/duplicate sind per Konstruktion NICHT im Import-Set.
export function canStartImport(s: ImportGateState): boolean {
  return s.canBackup && s.vatSelected && s.summary.importable >= 1;
}

// Nur die tatsächlich zu importierenden Zeilen (new/warning) — invalid/duplicate werden geblockt.
export function importableRows(rows: ClassifiedRow[]): ClassifiedRow[] {
  return rows.filter((r) => isImportable(r.status));
}

// ─────────────────────────────────────────────────────────────
// 5b. Die angebotene Vorlage (Download auf der Import-Seite)
// ─────────────────────────────────────────────────────────────
// Kopfzeile + Beispielzeilen, die genau so wieder eingelesen werden (Test: Vorlage → Import), und ein
// Blatt „How to" mit den erlaubten Werten aus der Steinregel.
const VORLAGE_STEINE = 3;
const STEIN_SPALTEN = ['Type', 'Qty', 'Carat', 'Color', 'Clarity', 'Shape', 'Name'];

export function importTemplate(): { items: Array<Array<string | number>>; help: string[][] } {
  const kopf = ['Category', 'SKU', 'Brand', 'Model', 'Serial', 'Description 1', 'Description 2', 'Size', 'Material',
    'Item Type', 'Karat & Color', 'Weight', 'Diamond Weight', 'Cost', 'Tag Price', 'Qty', 'VAT'];
  for (let n = 1; n <= VORLAGE_STEINE; n++) for (const s of STEIN_SPALTEN) kopf.push(`Stone ${n} ${s}`);
  kopf.push('Sold');
  const zeile = (werte: Record<string, string | number>) => kopf.map((h) => werte[h] ?? '');
  const items = [
    kopf,
    zeile({ Category: 'Watch', Brand: 'Rolex', Model: '126610LN', 'Description 1': 'Submariner Date', Cost: 9500, 'Tag Price': 11500, Qty: 1, VAT: 'MARGIN' }),
    zeile({ Category: 'Gold-Diamond Jewellery', 'Item Type': 'Ring', 'Karat & Color': '18K Yellow', Weight: 6.4, 'Description 1': 'Diamond Ring', Cost: 450, 'Tag Price': 690, Qty: 1, VAT: 'VAT_10',
      'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 12, 'Stone 1 Carat': 0.8, 'Stone 1 Color': 'G', 'Stone 1 Clarity': 'VS1', 'Stone 1 Shape': 'Round',
      'Stone 2 Type': 'Emerald', 'Stone 2 Qty': 2, 'Stone 2 Carat': 0.45,
      'Stone 3 Type': 'Other', 'Stone 3 Qty': 6, 'Stone 3 Name': 'Tsavorite' }),
    zeile({ Category: 'Gold-Diamond Jewellery', 'Item Type': 'Pendant', 'Karat & Color': '18K White', Weight: 3.1, 'Description 1': 'Halo', Cost: 380, Qty: 1, VAT: 'VAT_10',
      'Stone 1 Type': 'Diamond', 'Stone 1 Qty': 1, 'Stone 1 Carat': 0.5, 'Stone 1 Color': 'F', 'Stone 1 Clarity': 'VVS2', 'Stone 1 Shape': 'Oval',
      'Stone 2 Type': 'Diamond', 'Stone 2 Qty': 20, 'Stone 2 Carat': 0.3 }),
    zeile({ Category: 'Gold-Diamond Jewellery', 'Item Type': 'Bangle', 'Karat & Color': '21K Yellow', Weight: 15, 'Diamond Weight': 1.2, Cost: 700, Qty: 1, VAT: 'VAT_10' }),
  ];
  const liste = (l: readonly { label: string }[]) => l.map((o) => o.label).join(', ');
  const goldAttrs = DEFAULT_CATEGORIES.find((c) => c.id === GOLD_IMPORT_CATEGORY)?.attributes || [];
  const help = [
    ['LATAIF — product import'],
    ['One row = one item. Column names are not case-sensitive; unused columns can be left empty or removed.'],
    [''],
    ['Gold-Diamond Jewellery'],
    ['Brand and Model are not needed — the item is named from its details (e.g. Ring · Diamond Ring · 18K Yellow · 6.40 g).'],
    ['Item Type — ' + optionsOf(goldAttrs, 'item_type').join(', ') + '.'],
    ['Karat & Color — ' + optionsOf(goldAttrs, 'karat').join(', ') + '.'],
    ['Weight — in grams. Description 1 — a short description (e.g. SOLITAIRE). Description 2/3, Serial, Size and Markup are kept in the item notes.'],
    ['Older files still import: Karat / Carat (e.g. 18) together with Metal / Material (e.g. White Gold) become Karat & Color (18K White); 21, 22 and 24 are always Yellow.'],
    ['Without a clear value nothing is guessed — the preview warns and the value is kept in the notes. Material is never used as Item Type.'],
    ['Watches and all other categories: the columns work as before.'],
    [''],
    ['Stones (Gold-Diamond Jewellery only)'],
    ['Each stone has its own column group: Stone 1 Type, Stone 1 Qty, Stone 1 Carat, Stone 1 Color, Stone 1 Clarity, Stone 1 Shape, Stone 1 Name.'],
    [`For more stones add the same columns with the next number (Stone 4 Type, Stone 4 Qty, …) — up to ${MAX_STONE_ROWS} stones per item.`],
    ['Type — ' + liste(STONE_TYPES) + '.'],
    ['Qty — whole number of stones in that row (required). Carat — total carat of that row (optional, up to 3 decimals).'],
    ['Color, Clarity, Shape — only for Diamond (optional). Color: ' + liste(DIAMOND_COLORS) + '. Clarity: ' + liste(DIAMOND_CLARITIES) + '. Shape: ' + liste(DIAMOND_SHAPES) + '.'],
    ['Name — only for Other, and required there (e.g. Tsavorite).'],
    ['Diamond Weight is calculated from the diamond rows with carat. Older files with only a Diamond Weight column still import; no stone rows are created from it.'],
    ['A row with an invalid stone is shown as invalid in the preview and is not imported.'],
  ];
  return { items, help };
}

// ─────────────────────────────────────────────────────────────
// 6. Import-Orchestrator (Backup-first, per-Row, NICHT atomar)
// ─────────────────────────────────────────────────────────────
// Injizierbar (backup + create) → headless testbar ohne React/DB/Tauri.
// Vertrag: Backup MUSS zuerst erfolgreich sein; wirft es, wird KEINE Zeile angelegt
// (started=false). Danach wird NUR für importierbare Zeilen create() aufgerufen —
// invalid/duplicate bleiben unangetastet, bestehende Produkte werden nie überschrieben.
export interface RunImportDeps {
  backup: () => Promise<{ location: string }>;
  create: (row: ClassifiedRow) => void;
}
export interface RunImportResult {
  started: boolean; imported: number; failed: number;
  backupLocation: string | null; backupError: string | null;
}

export async function runProductImport(rows: ClassifiedRow[], deps: RunImportDeps): Promise<RunImportResult> {
  let backupLocation: string;
  try {
    const b = await deps.backup();
    backupLocation = b.location;
  } catch (e) {
    return { started: false, imported: 0, failed: 0, backupLocation: null, backupError: (e as Error)?.message || String(e) };
  }
  let imported = 0;
  let failed = 0;
  for (const r of importableRows(rows)) {
    try { deps.create(r); imported++; } catch { failed++; }
  }
  return { started: true, imported, failed, backupLocation, backupError: null };
}

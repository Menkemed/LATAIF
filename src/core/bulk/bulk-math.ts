// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Rechenregeln (docs/bulk-metal-v1-spec.md, Kapitel 4).
//
// Gewicht in ganzen Milligramm, Werte in ganzen Fils (1 BHD = 1000 Fils). Eingaben werden als TEXT
// exakt zerlegt — nie `Math.round(float × 1000)`. Die anteilige Zuteilung rechnet mit BigInt
// (Restwert × Gramm kann 2^53 übersteigen) und rundet kaufmännisch; der letzte Verbrauch nimmt exakt
// den Rest. Rein, ohne Datenbank — Maske, Primary und Tests benutzen dieselben Funktionen.
// ════════════════════════════════════════════════════════════════════════════

export class BulkRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BulkRejected';
  }
}

/** Was beim Verkauf gewählt wird (Rechnungszeile). */
export const BULK_TYPES = ['RING', 'BRACELET_BANGLE', 'NECKLACE_CHAIN', 'EARRINGS', 'PENDANT', 'SET', 'OTHER', 'BY_WEIGHT'] as const;
export type BulkType = typeof BULK_TYPES[number];
export const BULK_TYPE_LABEL: Record<BulkType, string> = {
  RING: 'Ring', BRACELET_BANGLE: 'Bracelet/Bangle', NECKLACE_CHAIN: 'Necklace/Chain', EARRINGS: 'Earrings',
  PENDANT: 'Pendant', SET: 'Set', OTHER: 'Other', BY_WEIGHT: 'By weight',
};

/** Was beim Einkauf als ungefähre Zusammensetzung erfasst wird (nur Information). */
export const COMPOSITION_TYPES = ['RINGS', 'BRACELETS_BANGLES', 'NECKLACES_CHAINS', 'EARRINGS', 'PENDANTS', 'SETS', 'MIXED_OTHER'] as const;
export type CompositionType = typeof COMPOSITION_TYPES[number];
export const COMPOSITION_LABEL: Record<CompositionType, string> = {
  RINGS: 'Rings', BRACELETS_BANGLES: 'Bracelets/Bangles', NECKLACES_CHAINS: 'Necklaces/Chains', EARRINGS: 'Earrings',
  PENDANTS: 'Pendants', SETS: 'Sets', MIXED_OTHER: 'Mixed/Other',
};
/** „Sold as …" neben der Composition: Verkaufstyp → Composition-Zeile (By weight bleibt eine eigene Zeile). */
export const SALE_TO_COMPOSITION: Record<BulkType, CompositionType | null> = {
  RING: 'RINGS', BRACELET_BANGLE: 'BRACELETS_BANGLES', NECKLACE_CHAIN: 'NECKLACES_CHAINS', EARRINGS: 'EARRINGS',
  PENDANT: 'PENDANTS', SET: 'SETS', OTHER: 'MIXED_OTHER', BY_WEIGHT: null,
};

/** Steuerart beim Verkauf, als Snapshot am Lot (K4). */
export const BULK_SALE_TAX_SCHEMES = ['MARGIN', 'VAT_10', 'ZERO'] as const;
export type BulkSaleTaxScheme = typeof BULK_SALE_TAX_SCHEMES[number];

export interface CompositionEntry { type: CompositionType; weightMg: number; pieces?: number }

const DECIMAL_TEXT = /^(\d+)(?:\.(\d{1,3}))?$/;

/** „7" → 7000, „7.5" → 7500, „7.500" → 7500. Kein Vorzeichen, kein Trennzeichen, kein Exponent. */
function parseThousandths(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = DECIMAL_TEXT.exec(text);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(3, '0'));
  const v = whole * 1000 + frac;
  return Number.isSafeInteger(v) ? v : null;
}

/** Gramm-Text → ganze Milligramm (> 0). */
export function parseGramsToMg(text: unknown): number {
  const v = parseThousandths(text);
  if (v === null || v <= 0) throw new BulkRejected('BULK_WEIGHT_INVALID', 'weight must be grams > 0 with at most 3 decimals (e.g. 7.500)');
  return v;
}

/** BHD-Text → ganze Fils. `allowZero` nur dort, wo 0 fachlich erlaubt ist. */
export function parseBhdToFils(text: unknown, allowZero = false): number {
  const v = parseThousandths(text);
  if (v === null || v < 0 || (!allowZero && v === 0)) {
    throw new BulkRejected('BULK_AMOUNT_INVALID', 'amount must be BHD with at most 3 decimals (e.g. 25.000)');
  }
  return v;
}

/** Eine schon ganzzahlige Eingabe (PC2 schickt mg/Fils als Zahl) prüfen. */
export function assertWeightMg(v: unknown, what = 'weight'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new BulkRejected('BULK_WEIGHT_INVALID', `${what} must be a whole number of milligrams > 0`);
  }
  return v;
}
export function assertFils(v: unknown, what = 'amount', allowZero = false): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || (!allowZero && v === 0)) {
    throw new BulkRejected('BULK_AMOUNT_INVALID', `${what} must be a whole number of fils${allowZero ? '' : ' > 0'}`);
  }
  return v;
}

/** Ganzzahl in Tausendsteln → „1234.567" (ohne Float-Division). */
function formatThousandths(v: number): string {
  const neg = v < 0;
  const a = Math.abs(v);
  const s = `${Math.floor(a / 1000)}.${String(a % 1000).padStart(3, '0')}`;
  return neg ? `-${s}` : s;
}
export const formatMg = (mg: number): string => formatThousandths(mg);
export const formatFils = (fils: number): string => formatThousandths(fils);
/** Fils → BHD als Zahl mit genau 3 Dezimalen (für bestehende REAL-Spalten und den Zeilenvertrag). */
export const filsToBhd = (fils: number): number => Number(formatThousandths(fils));

/** Kaufmännisch gerundete Division zweier nicht-negativer BigInts. */
function divHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/**
 * Anteil am aktuellen Restwert für `takeMg` Milligramm (4.2): bei `takeMg == W` exakt der Rest,
 * sonst `round_half_up(V · w / W)`.
 */
export function allocateFils(remainingValueFils: number, remainingWeightMg: number, takeMg: number): number {
  if (!Number.isSafeInteger(remainingValueFils) || remainingValueFils < 0
    || !Number.isSafeInteger(remainingWeightMg) || remainingWeightMg < 0
    || !Number.isSafeInteger(takeMg) || takeMg <= 0) {
    throw new BulkRejected('BULK_INVARIANT_VIOLATED', 'allocation inputs must be whole numbers');
  }
  if (takeMg > remainingWeightMg) throw new BulkRejected('BULK_WEIGHT_EXCEEDS_REMAINING', 'more than the remaining weight of this lot');
  if (takeMg === remainingWeightMg) return remainingValueFils;
  return Number(divHalfUp(BigInt(remainingValueFils) * BigInt(takeMg), BigInt(remainingWeightMg)));
}

/** Vorsteuer in Fils aus einem Brutto-Betrag in Fils (4.5): round_half_up(L · r / (100 + r)). */
export function vatFilsOfGross(grossFils: number, ratePct: number): number {
  if (ratePct <= 0) return 0;
  return Number(divHalfUp(BigInt(grossFils) * BigInt(ratePct), BigInt(100 + ratePct)));
}

/** BHD pro Gramm als Text mit 3 Dezimalen: Fils / mg = (BHD/1000)/(g/1000). */
export function costPerGramText(valueFils: number, weightMg: number): string {
  if (!(weightMg > 0)) return '—';
  return formatThousandths(Number(divHalfUp(BigInt(valueFils) * 1000n, BigInt(weightMg))));
}

/** Einen gespeicherten 3-Dezimal-REAL-Betrag in Fils — nur für Prüfungen, nie für Eingaben. */
export function filsOfStoredAmount(n: number): number {
  const f = Math.round(n * 1000);
  if (Math.abs(n * 1000 - f) > 1e-6) throw new BulkRejected('BULK_INVARIANT_VIOLATED', `amount ${n} is not a whole number of fils`);
  return f;
}

/** Composition prüfen: bekannte Typen, ganze mg > 0, Summe ≤ Gewicht (K9). */
export function checkComposition(raw: unknown, totalWeightMg: number): CompositionEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BulkRejected('BULK_COMPOSITION_INVALID', 'composition must be a list');
  const out: CompositionEntry[] = [];
  let sum = 0;
  for (const e of raw as Array<Record<string, unknown>>) {
    const type = e?.type;
    if (typeof type !== 'string' || !(COMPOSITION_TYPES as readonly string[]).includes(type)) {
      throw new BulkRejected('BULK_COMPOSITION_INVALID', `unknown composition type: ${String(type)}`);
    }
    const weightMg = assertWeightMg(e.weightMg, `composition weight (${type})`);
    let pieces: number | undefined;
    if (e.pieces !== undefined && e.pieces !== null && e.pieces !== '') {
      if (typeof e.pieces !== 'number' || !Number.isSafeInteger(e.pieces) || e.pieces < 0) {
        throw new BulkRejected('BULK_COMPOSITION_INVALID', `pieces must be a whole number (${type})`);
      }
      pieces = e.pieces;
    }
    sum += weightMg;
    out.push(pieces === undefined ? { type: type as CompositionType, weightMg } : { type: type as CompositionType, weightMg, pieces });
  }
  if (sum > totalWeightMg) {
    throw new BulkRejected('BULK_COMPOSITION_EXCEEDS_WEIGHT', `composition (${formatMg(sum)} g) exceeds the lot weight (${formatMg(totalWeightMg)} g)`);
  }
  return out;
}

export function compositionSumMg(c: readonly CompositionEntry[]): number {
  return c.reduce((s, e) => s + e.weightMg, 0);
}

/** Automatische Zeilenbeschreibung: „Ring · Silver 925 · 7.000 g". */
export function bulkLineDescription(type: BulkType, metalLabel: string, fineness: string, weightMg: number): string {
  return `${BULK_TYPE_LABEL[type]} · ${metalLabel} ${fineness} · ${formatMg(weightMg)} g`;
}

export function assertBulkType(v: unknown): BulkType {
  if (typeof v !== 'string' || !(BULK_TYPES as readonly string[]).includes(v)) {
    throw new BulkRejected('BULK_TYPE_INVALID', `type must be one of ${BULK_TYPES.join(', ')}`);
  }
  return v as BulkType;
}

export function assertSaleTaxScheme(v: unknown): BulkSaleTaxScheme {
  if (typeof v !== 'string' || !(BULK_SALE_TAX_SCHEMES as readonly string[]).includes(v)) {
    throw new BulkRejected('BULK_TAX_SCHEME_INVALID', `sale tax scheme must be one of ${BULK_SALE_TAX_SCHEMES.join(', ')}`);
  }
  return v as BulkSaleTaxScheme;
}

/** Stabiler, synchroner Hash (cyrb53) der kanonischen Eingabe einer manuellen Aktion. */
export function payloadHash(payload: unknown): string {
  const str = canonicalJson(payload);
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

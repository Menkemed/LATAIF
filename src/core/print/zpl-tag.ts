// ═══════════════════════════════════════════════════════════
// LATAIF — ZPL Tag Generator (Zebra ZD220, Schmuck-Falt-Tags)
// Erzeugt natives ZPL für die 2-up Die-Cut Rat-Tail-Tags.
// Geometrie FINAL gelockt 2026-06-03 (physisch am ZD220 verifiziert):
//   Font ^A0N,17,18 · max 17 Zeichen/Zeile · 10 Zeilen/Pad (5 obere + 5 untere Falt-Hälfte)
//   Pad B (oben-rechts) x500 · Pad A (unten-links) x5 · Falz B y118 / A y208
// ═══════════════════════════════════════════════════════════

import type { Product, Category } from '@/core/models/types';

// ── Gelockte Geometrie (NICHT ändern ohne erneuten physischen Test) ──
const FONT = '^A0N,17,18';
const MAX_CHARS = 17;
const PAD_B_X = 500;
const PAD_A_X = 5;
const PAD_B_UPPER_Y = [22, 42, 62, 82, 102];
const PAD_B_LOWER_Y = [126, 146, 166, 186, 206];
const PAD_A_UPPER_Y = [112, 132, 152, 172, 192];
const PAD_A_LOWER_Y = [216, 236, 256, 276, 294];

const ZPL_HEAD = '^XA\n^CI28\n^PW663\n^LL296\n^LH0,0\n^MD30\n^PR2\n';
const ZPL_FOOT = '^XZ\n';

/** Eine fertig gerenderte Tag-Seite: bis zu 5 Zeilen obere + 5 untere Falt-Hälfte. */
export interface TagFace {
  upper: string[]; // Identität (SKU/Brand/Model/Ref/Serial)
  lower: string[]; // Specs (Metall/Dial/Bezel/Preis/Included)
}

// ── Text-Helfer ──
function up(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}
function fit(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s;
}
/** Hängt ein Kontext-Wort an (z.B. "DIAL"/"BEZEL") — aber nur wenn es noch in 17 Zeichen passt. */
function withSuffix(value: string, suffix: string): string {
  if (!value) return '';
  if (value.includes(suffix)) return value;
  const combined = `${value} ${suffix}`;
  return combined.length <= MAX_CHARS ? combined : value;
}
/** ZPL-Steuerzeichen aus Nutzdaten entschärfen (^ ~ \ und Zeilenumbrüche). */
function zplEscape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\^/g, ' ').replace(/~/g, '-').replace(/\\/g, '/');
}

// ── Watch: Material + Karat zu EINER Metall-Zeile (Karat ist nur die Gold-Verfeinerung) ──
function karatShort(karat: unknown): string {
  const s = String(karat ?? '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)\s*K\s+(\w+)/i);
  if (m) return `${m[1]}K ${m[2][0].toUpperCase()}G`; // "18K Yellow" → "18K YG"
  return s.toUpperCase();
}
function metalLine(material: unknown, karat: unknown): string {
  const mat = String(material ?? '').trim();
  if (!mat) return '';
  const k = karatShort(karat);
  switch (mat) {
    case 'Solid Gold': return k || 'GOLD';
    case 'Two-Tone Steel/Gold': return k ? `STEEL/${k}` : 'STEEL/GOLD';
    case 'Ceramic & Gold': return k ? `CERAMIC/${k}` : 'CERAMIC/GOLD';
    case 'Titanium & Gold': return k ? `TI/${k}` : 'TI/GOLD';
    default: return mat.toUpperCase(); // Steel, Titanium, Ceramic, Platinum, … (kein Gold)
  }
}

// ── Watch-Tag-Layout (final gelockt, am Rolex 116243 abgenommen) ──
function buildWatchFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;

  // Obere Hälfte = Identität (max 5)
  const upper: string[] = [];
  if (p.sku) upper.push(fit(up(p.sku)));
  if (p.brand) upper.push(fit(up(p.brand)));
  if (p.name) upper.push(fit(up(p.name)));
  if (a.reference_number) upper.push(fit(`REF ${up(a.reference_number)}`));
  if (a.serial_number) upper.push(fit(`SN ${up(a.serial_number)}`));

  // Untere Hälfte = Specs (max 5). Reihenfolge: Metall, Dial, Bezel, [Description], Preis, Included+Year.
  const lower: string[] = [];
  const metal = metalLine(a.material, a.karat_color);
  if (metal) lower.push(fit(metal));
  if (a.dial) lower.push(fit(withSuffix(up(a.dial), 'DIAL')));
  if (a.bezel) lower.push(fit(withSuffix(up(a.bezel), 'BEZEL')));
  const price = p.plannedSalePrice || p.purchasePrice || 0;
  lower.push(fit(`BD ${Math.round(price)}`));
  const incl = (p.scopeOfDelivery || []).map(up).join(' ');
  const year = a.year ? String(a.year) : '';
  const inclYear = fit([incl, year].filter(Boolean).join(' '));
  if (inclYear) lower.push(inclYear);

  // Description (Prosa) kommt bewusst NICHT aufs Tag — bleibt im Produkt-Record.
  // (Die AI wird angewiesen, lange Beschreibungen ins description-Feld zu legen.)
  return { upper: upper.slice(0, 5), lower: lower.slice(0, 5) };
}

// ── Generischer Fallback für andere Kategorien (noch ohne eigenes Layout) ──
function buildGenericFace(p: Product, category?: Category): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const upper: string[] = [];
  if (p.sku) upper.push(fit(up(p.sku)));
  if (p.brand) upper.push(fit(up(p.brand)));
  if (p.name) upper.push(fit(up(p.name)));

  const lower: string[] = [];
  const specAttrs = (category?.attributes || []).filter(
    at => at.showInList && a[at.key] != null && a[at.key] !== ''
  );
  for (const at of specAttrs) lower.push(fit(up(String(a[at.key]))));
  const price = p.plannedSalePrice || p.purchasePrice || 0;
  lower.push(fit(`BD ${Math.round(price)}`));
  const incl = (p.scopeOfDelivery || []).map(up).join(' ');
  if (incl) lower.push(fit(incl));

  return { upper: upper.slice(0, 5), lower: lower.slice(0, 5) };
}

/** Baut eine Tag-Seite für ein Produkt — Watch-Layout oder generischer Fallback. */
export function buildProductFace(p: Product, category?: Category): TagFace {
  const isWatch = category?.id === 'cat-watch' || category?.name === 'Watch';
  return isWatch ? buildWatchFace(p) : buildGenericFace(p, category);
}

// ── ZPL-Rendering ──
function foLines(x: number, ys: number[], lines: string[]): string {
  let z = '';
  for (let i = 0; i < lines.length && i < ys.length; i++) {
    z += `^FO${x},${ys[i]}${FONT}^FD${zplEscape(lines[i])}^FS\n`;
  }
  return z;
}
/** Ein Feld (Vorschub-Einheit) = Pad B (oben-rechts) + Pad A (unten-links). Pad A optional (ungerade Anzahl). */
function renderField(tagB: TagFace, tagA: TagFace | null): string {
  let z = ZPL_HEAD;
  z += foLines(PAD_B_X, PAD_B_UPPER_Y, tagB.upper);
  z += foLines(PAD_B_X, PAD_B_LOWER_Y, tagB.lower);
  if (tagA) {
    z += foLines(PAD_A_X, PAD_A_UPPER_Y, tagA.upper);
    z += foLines(PAD_A_X, PAD_A_LOWER_Y, tagA.lower);
  }
  z += ZPL_FOOT;
  return z;
}

/** Packt N Tag-Seiten 2-up pro Feld (Pad B + Pad A) und liefert das komplette ZPL. */
export function facesToZpl(faces: TagFace[]): string {
  let zpl = '';
  for (let i = 0; i < faces.length; i += 2) {
    zpl += renderField(faces[i], faces[i + 1] || null);
  }
  return zpl;
}

/**
 * Komfort-API: ZPL für `copies` Tags EINES Produkts.
 * 2 Tags teilen sich ein Feld (kein verschwendeter Vorschub bei gerader Anzahl).
 */
export function buildProductTagsZpl(p: Product, category: Category | undefined, copies = 1): string {
  const face = buildProductFace(p, category);
  const faces: TagFace[] = Array.from({ length: Math.max(1, copies) }, () => face);
  return facesToZpl(faces);
}

/** ZPL für mehrere verschiedene Produkte (Batch, je 1 Tag) — 2-up gepackt. */
export function buildBatchTagsZpl(items: Array<{ product: Product; category?: Category }>): string {
  const faces = items.map(it => buildProductFace(it.product, it.category));
  return facesToZpl(faces);
}

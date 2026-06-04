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

/** Eine fertig gerenderte Tag-Seite. Generisches Slot-Layout ODER (Watch) Barcode-Layout. */
export interface TagFace {
  upper: string[]; // generisches Slot-Layout: obere Falt-Hälfte
  lower: string[]; // generisches Slot-Layout: untere Falt-Hälfte
  watch?: WatchTagContent; // Watch-Kategorie: eigenes Scan-Layout mit Barcode
}

/** Watch-Tag: SKU + Barcode + Preis (obere Hälfte), Details (untere Hälfte). */
interface WatchTagContent {
  sku: string;
  barcode: string; // codierter Wert = rohe SKU (Case-sensitiv für den Scanner)
  price: string;
  details: string[]; // REF, SN, Papers/Warranty, Year
}

// ── Text-Helfer ──
function up(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}
function fit(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s;
}
/** ZPL-Steuerzeichen aus Nutzdaten entschärfen (^ ~ \ und Zeilenumbrüche). */
function zplEscape(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/\^/g, ' ').replace(/~/g, '-').replace(/\\/g, '/');
}


// ── Papers/Warranty: zeigt, was die Uhr tatsächlich hat (aus scopeOfDelivery) ──
function papersWarranty(scope?: string[]): string {
  const s = scope || [];
  const hasPapers = s.includes('Papers');
  const hasWarranty = s.includes('Warranty Card');
  if (hasPapers && hasWarranty) return 'PAPERS + WARRANTY';
  if (hasWarranty) return 'WARRANTY CARD';
  if (hasPapers) return 'PAPERS';
  return '';
}

// ── Watch-Tag-Layout (2026-06-04, physisch abgenommen) — Scan-Tag mit Barcode ──
// Obere Falt-Hälfte: SKU, Barcode (codiert die SKU), Preis.
// Untere Falt-Hälfte: REF, SN, Papers/Warranty, Year.
// Brand/Name/Dial/Bezel/Material kommen bewusst NICHT aufs Tag (Inventar-/Scan-Fokus).
function buildWatchFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim(); // roher SKU-Wert für den Scanner
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  if (a.reference_number) details.push(fit(`REF ${up(a.reference_number)}`));
  if (a.serial_number) details.push(fit(`SN ${up(a.serial_number)}`));
  const pw = papersWarranty(p.scopeOfDelivery);
  if (pw) details.push(fit(pw));
  if (a.year) details.push(fit(`YEAR ${a.year}`));

  return { upper: [], lower: [], watch: { sku, barcode, price, details: details.slice(0, 5) } };
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
// Watch-Scan-Layout: SKU + Barcode + Preis (oben), Details (unten). Positionen physisch
// abgenommen 2026-06-04. Pad A = Pad B + 90 in y (yOff), x kommt vom Aufrufer.
function renderWatchPad(x: number, yOff: number, w: WatchTagContent): string {
  let z = '';
  if (w.sku) z += `^FO${x},${20 + yOff}${FONT}^FD${zplEscape(w.sku)}^FS\n`;
  if (w.barcode) z += `^FO${x},${40 + yOff}^BY1^BCN,55,N,N,N^FD${zplEscape(w.barcode)}^FS\n`;
  if (w.price) z += `^FO${x},${100 + yOff}${FONT}^FD${zplEscape(w.price)}^FS\n`;
  let ly = 126 + yOff;
  for (const d of w.details) { z += `^FO${x},${ly}${FONT}^FD${zplEscape(d)}^FS\n`; ly += 20; }
  return z;
}

// Ein Pad rendern — Watch-Barcode-Layout (yOff) oder generisches Slot-Layout (upperY/lowerY).
function renderPad(x: number, upperY: number[], lowerY: number[], yOff: number, face: TagFace): string {
  if (face.watch) return renderWatchPad(x, yOff, face.watch);
  return foLines(x, upperY, face.upper) + foLines(x, lowerY, face.lower);
}

/** Ein Feld (Vorschub-Einheit) = Pad B (oben-rechts) + Pad A (unten-links). Pad A optional (ungerade Anzahl). */
function renderField(tagB: TagFace, tagA: TagFace | null): string {
  let z = ZPL_HEAD;
  z += renderPad(PAD_B_X, PAD_B_UPPER_Y, PAD_B_LOWER_Y, 0, tagB);
  if (tagA) z += renderPad(PAD_A_X, PAD_A_UPPER_Y, PAD_A_LOWER_Y, 90, tagA);
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

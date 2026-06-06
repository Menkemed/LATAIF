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
  scan?: ScanTagContent; // Barcode-Scan-Layout (Watch, Gold-Jewelry, …)
}

/** Barcode-Scan-Tag: SKU + Barcode + Preis (obere Hälfte), Details (untere Hälfte). */
interface ScanTagContent {
  sku: string;
  barcode: string; // codierter Wert = rohe SKU (Case-sensitiv für den Scanner)
  price: string;
  details: string[]; // kategorie-spezifische Detailzeilen
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

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
}

// ── Gold-Jewelry: Karat & Color kurz (18K Yellow → 18K YG, 18K Mix → 18K MIX, Silver → SILVER) ──
function karatShortJewelry(karat: unknown): string {
  const s = String(karat ?? '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)\s*K\s+(\w+)/i);
  if (m) {
    const color = m[2].toLowerCase();
    if (color === 'mix') return `${m[1]}K MIX`;
    return `${m[1]}K ${color[0].toUpperCase()}G`; // Yellow→YG, Rose→RG, White→WG
  }
  return s.toUpperCase(); // Silver
}

// ── Gold-Diamond Jewellery (2026-06-04, abgenommen) — Scan-Tag mit Barcode ──
// Oben: SKU, Barcode, Preis. Unten: Weight/Carat, Item Type + Karat, Description.
function buildGoldJewelryFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim();
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  const w = (a.weight != null && a.weight !== '') ? `${a.weight}G` : '';
  const ct = (a.diamond_weight != null && a.diamond_weight !== '') ? `${a.diamond_weight}CT` : '';
  const wc = [w, ct].filter(Boolean).join(' / ');
  if (wc) details.push(fit(wc));
  const itemKarat = [a.item_type ? up(a.item_type) : '', karatShortJewelry(a.karat)].filter(Boolean).join(' ');
  if (itemKarat) details.push(fit(itemKarat));
  if (a.description) details.push(fit(up(a.description)));

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
}

// ── Branded Gold Jewelry (2026-06-04) — Scan-Tag mit Barcode ──
// Unten: Item Type, Size/Karat, Description, Weight/Diamond. (Brand bewusst NICHT drauf.)
function buildBrandedJewelryFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim();
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  if (a.item_type) details.push(fit(up(a.item_type)));
  const size = (a.size != null && a.size !== '') ? up(a.size) : '';
  const sizeKarat = [size, karatShortJewelry(a.karat)].filter(Boolean).join(' / ');
  if (sizeKarat) details.push(fit(sizeKarat));
  if (a.description) details.push(fit(up(a.description)));
  const w = (a.weight != null && a.weight !== '') ? `${a.weight}G` : '';
  const ct = (a.diamond_weight != null && a.diamond_weight !== '') ? `${a.diamond_weight}CT` : '';
  const wc = [w, ct].filter(Boolean).join(' / ');
  if (wc) details.push(fit(wc));

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
}

// ── Original Gold Jewelry (2026-06-04) — Scan-Tag mit Barcode ──
// Unten: Serial, Ref (model_number, nur wenn vorhanden), Size (nur Nummer), Certificate/Year.
function buildOriginalJewelryFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim();
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  if (a.serial_number) details.push(fit(`SN ${up(a.serial_number)}`));
  if (a.model_number) details.push(fit(`REF ${up(a.model_number)}`)); // model_number, als "REF" angezeigt
  if (a.size != null && a.size !== '') details.push(fit(up(a.size))); // nur die Nummer
  const hasCert = (p.scopeOfDelivery || []).includes('Certificate');
  const year = a.year ? String(a.year) : '';
  const certYear = [hasCert ? 'CERTIFICATE' : '', year].filter(Boolean).join(' ');
  if (certYear) details.push(fit(certYear));

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
}

// ── Accessory (2026-06-04) — Scan-Tag mit Barcode ──
// Unten: Serial, Model No (nur wenn vorhanden → sonst hoch), Papers/Year.
// HINWEIS: Accessory-Schema hat KEIN year-Feld → aktuell nur "PAPERS" (Year erscheint nur falls je vorhanden).
function buildAccessoryFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim();
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  if (a.serial_number) details.push(fit(`SN ${up(a.serial_number)}`));
  if (a.model_number) details.push(fit(`MODEL ${up(a.model_number)}`));
  const hasPapers = (p.scopeOfDelivery || []).includes('Papers');
  const year = a.year ? String(a.year) : '';
  const papersYear = [hasPapers ? 'PAPERS' : '', year].filter(Boolean).join(' ');
  if (papersYear) details.push(fit(papersYear));

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
}

// ── Spare Part (2026-06-04) — Scan-Tag mit Barcode ──
// Unten: Part Type, Material, Original/Copy, Description.
function buildSparePartFace(p: Product): TagFace {
  const a = (p.attributes || {}) as Record<string, unknown>;
  const sku = fit(up(p.sku || ''));
  const barcode = String(p.sku || '').trim();
  const price = fit(`BD ${Math.round(p.plannedSalePrice || p.purchasePrice || 0)}`);

  const details: string[] = [];
  if (a.part_type) details.push(fit(up(a.part_type)));
  if (a.material) details.push(fit(up(a.material)));
  if (a.original_or_copy) details.push(fit(up(a.original_or_copy)));
  if (a.description) details.push(fit(up(a.description)));

  return { upper: [], lower: [], scan: { sku, barcode, price, details: details.slice(0, 5) } };
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

/** Baut eine Tag-Seite für ein Produkt — kategorie-spezifisches Layout oder generischer Fallback. */
export function buildProductFace(p: Product, category?: Category): TagFace {
  if (category?.id === 'cat-watch' || category?.name === 'Watch') return buildWatchFace(p);
  if (category?.id === 'cat-gold-jewelry' || category?.name === 'Gold-Diamond Jewellery') return buildGoldJewelryFace(p);
  if (category?.id === 'cat-branded-gold-jewelry' || category?.name === 'Branded Gold Jewelry') return buildBrandedJewelryFace(p);
  if (category?.id === 'cat-original-gold-jewelry' || category?.name === 'Original Gold Jewelry') return buildOriginalJewelryFace(p);
  if (category?.id === 'cat-accessory' || category?.name === 'Accessory') return buildAccessoryFace(p);
  if (category?.id === 'cat-spare-part' || category?.name === 'Spare Part') return buildSparePartFace(p);
  return buildGenericFace(p, category);
}

// ── ZPL-Rendering ──
function foLines(x: number, ys: number[], lines: string[]): string {
  let z = '';
  for (let i = 0; i < lines.length && i < ys.length; i++) {
    z += `^FO${x},${ys[i]}${FONT}^FD${zplEscape(lines[i])}^FS\n`;
  }
  return z;
}
// Scan-Layout mit QR-Code (statt CODE128) — QR scannt am Handy zuverlaessiger als
// der feine ^BY1-Barcode. QR ist quadratisch (^BQN,2,3 ≈ 63 dots ≈ 8 mm), darum:
//   Zeile 1: SKU (volle Breite oben)
//   QR links unter der SKU, PREIS rechts daneben (mittig zum QR)
//   Details in der unteren Falt-Haelfte (unveraendert ab y126).
// QR codiert die rohe SKU (case-sensitiv) — der Scanner-Lookup bleibt identisch.
function renderScanPad(x: number, yOff: number, w: ScanTagContent): string {
  let z = '';
  if (w.sku) z += `^FO${x},${20 + yOff}${FONT}^FD${zplEscape(w.sku)}^FS\n`;
  if (w.barcode) z += `^FO${x},${42 + yOff}^BQN,2,3^FDMA,${zplEscape(w.barcode)}^FS\n`;
  if (w.price) z += `^FO${x + 72},${66 + yOff}${FONT}^FD${zplEscape(w.price)}^FS\n`;
  let ly = 126 + yOff;
  for (const d of w.details) { z += `^FO${x},${ly}${FONT}^FD${zplEscape(d)}^FS\n`; ly += 20; }
  return z;
}

// Ein Pad rendern — Barcode-Scan-Layout (yOff) oder generisches Slot-Layout (upperY/lowerY).
function renderPad(x: number, upperY: number[], lowerY: number[], yOff: number, face: TagFace): string {
  if (face.scan) return renderScanPad(x, yOff, face.scan);
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

// Plan §Print — produktbezogene Druck-Unterlagen müssen ALLE Specs enthalten
// (nicht nur Brand+Name). Dieser Helper baut eine vollständige Beschreibung
// aus Brand, Name, SKU, Condition + allen Kategorie-Attributen.
import type { Product, Category, CategoryAttribute } from '@/core/models/types';

function formatAttrValue(attr: CategoryAttribute, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (attr.type === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (attr.type === 'number') {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(n)) return null;
    return attr.unit ? `${n} ${attr.unit}` : String(n);
  }
  return String(value);
}

interface FormatOptions {
  includeSku?: boolean;
  includeCondition?: boolean;
  /** Wenn true → nur Attribute mit `showInList: true`, sonst alle. */
  prominentOnly?: boolean;
}

export interface ProductSpec {
  label: string;
  value: string;
}

/** Liste aller Specs (Label-Value-Paare) — für strukturierte Anzeige (Tabellen, Cards). */
export function getProductSpecs(
  product: Product | undefined,
  categories: Category[],
  opts: FormatOptions = {}
): ProductSpec[] {
  if (!product) return [];
  const cat = categories.find(c => c.id === product.categoryId);
  const out: ProductSpec[] = [];

  if (product.sku && (opts.includeSku ?? true)) out.push({ label: 'SKU', value: product.sku });
  if (product.condition && (opts.includeCondition ?? true)) out.push({ label: 'Condition', value: product.condition });

  if (cat) {
    const attrs = cat.attributes || [];
    const filtered = opts.prominentOnly ? attrs.filter(a => a.showInList) : attrs;
    const values = (product.attributes as Record<string, unknown>) || {};
    for (const attr of filtered) {
      // Beschreibung wird separat behandelt → skip in Specs-Liste damit nicht doppelt erscheint.
      if (attr.key === 'description') continue;
      const formatted = formatAttrValue(attr, values[attr.key]);
      if (formatted) out.push({ label: attr.label, value: formatted });
    }
  }
  return out;
}

/** Einzeilige kompakte Beschreibung für Print-Lines: "Brand Name · Ref X · 40mm · Steel". */
export function formatProductOneLine(
  product: Product | undefined,
  categories: Category[],
  opts: FormatOptions = { prominentOnly: true, includeSku: false, includeCondition: false }
): string {
  if (!product) return '';
  const head = `${product.brand || ''} ${product.name || ''}`.trim();
  const specs = getProductSpecs(product, categories, opts);
  if (specs.length === 0) return head;
  return `${head} · ${specs.map(s => s.value).join(' · ')}`;
}

/** Lowercased Haystack über Brand, Name, SKU, Condition + ALLE Attribut-Werte
 *  (Reference, Serial, Material, Karat, Farbe, …) — für die Tiefen-Suche in
 *  Produkt-Pickern via `SearchSelectOption.searchText`. */
export function productSearchText(product: Product): string {
  const attrs = (product.attributes as Record<string, unknown>) || {};
  const attrValues = Object.values(attrs).map(v => (Array.isArray(v) ? v.join(' ') : v));
  return [product.brand, product.name, product.sku, product.condition, ...attrValues]
    .map(v => String(v ?? '').toLowerCase())
    .filter(Boolean)
    .join(' ');
}

// ════════════════════════════════════════════════════════════════════════════
// PRODUKTSUCHE — eine positive Liste fachlicher Felder statt einer Ausschlussliste
//
// Ein Produkt traegt neben seinen fachlichen Daten auch reine Maschinendaten: den
// KI-Beschreibungstext des Fotos, den Embedding-Vektor, Bild-Hashes, KI-Snapshots und
// Korrekturprotokolle. Die Listensuche hat frueher ALLES durchsucht, was nicht
// ausdruecklich ausgenommen war — und damit auch das. An der echten Produktionsdatenbank
// gemessen (66 Artikel):
//
//   "large" → 6 Treffer statt 2   (KI-Text: "large, bold hour markers")
//   "126"   → ALLE 66 Artikel     (Zahlen des Embedding-Vektors, als Text verglichen)
//   "steel" → ALLE 66 Artikel     (die Auswahlliste der Kategorie, nicht das Produkt)
//
// Eine Referenznummer war damit nicht mehr auffindbar. Deshalb die Umkehrung: gesucht
// wird nur in dem, was hier aufgezaehlt ist. Ein neues technisches Feld am Produkt ist
// dadurch von sich aus nicht durchsuchbar — niemand muss daran denken, es irgendwo
// auszuschliessen. Das ist der ganze Punkt der Liste.
//
// Ausdruecklich NICHT durchsuchbar: `imageDescription`, `imageEmbedding`, `imageHash`,
// `aiIdentifiedSnapshot`, `aiCorrections`, `aiConfirmedAt`, `images`, technische Ids und
// Zeitstempel. Die Daten bleiben gespeichert und werden von den KI-Funktionen weiter
// benutzt — sie zaehlen nur nicht als fachlicher Suchbegriff.
// ════════════════════════════════════════════════════════════════════════════

/** Die fachlichen Produktfelder, die eine Textsuche sieht. Dient zugleich als Beleg,
  * dass die Liste bewusst gepflegt ist — der Test vergleicht sie gegen den echten Typ. */
export const PRODUCT_SEARCH_FIELDS = [
  'brand', 'name', 'sku', 'condition', 'attributes',          // via productSearchText
  'storageLocation', 'notes', 'supplierName', 'purchaseSource', 'purchaseDate',
  'stockStatus', 'taxScheme', 'sourceType', 'purchaseCurrency', 'paidFrom',
  'scopeOfDelivery', 'quantity', 'purchasePrice', 'plannedSalePrice', 'minSalePrice',
  'maxSalePrice', 'lastOfferPrice', 'lastSalePrice',
] as const;

/**
 * Der vollstaendige fachliche Suchtext eines Produkts — die kanonische Projektion fuer
 * jede Listensuche. Baut auf `productSearchText` auf (Marke, Name, SKU, Zustand + alle
 * Attributwerte, also auch Referenz, Seriennummer, Modell, Beschreibung, Material …) und
 * ergaenzt die uebrigen fachlichen Felder, die eine Listensuche bisher zu Recht gefunden
 * hat: Lagerort, Notiz, Lieferant, Herkunft, Lieferumfang, Status und die Preise.
 */
export function productBusinessSearchText(product: Product): string {
  const parts: unknown[] = [
    productSearchText(product),
    product.storageLocation, product.notes, product.supplierName, product.purchaseSource,
    product.purchaseDate, product.stockStatus, product.taxScheme, product.sourceType,
    product.purchaseCurrency, product.paidFrom,
    ...(Array.isArray(product.scopeOfDelivery) ? product.scopeOfDelivery : []),
    product.quantity, product.purchasePrice, product.plannedSalePrice, product.minSalePrice,
    product.maxSalePrice, product.lastOfferPrice, product.lastSalePrice,
  ];
  return parts.map(v => String(v ?? '').toLowerCase()).filter(Boolean).join(' ');
}

/**
 * Ist dieses Objekt ein Produkt? Gefragt wird nach der Form, nicht nach einer Markierung:
 * ein Produkt hat immer eine Kategorie, einen Bestandsstatus, einen Attribut-Satz und
 * mindestens Marke oder SKU. Kein Beleg (Rechnung, Angebot, Auftrag, Reparatur,
 * Kommission) traegt diese Kombination — deshalb greift die Projektion auch dann, wenn
 * ein Produkt IN einem Beleg steckt und nicht selbst das durchsuchte Objekt ist.
 */
export function isProductLike(value: unknown): value is Product {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.categoryId === 'string'
    && typeof v.stockStatus === 'string'
    && typeof v.attributes === 'object' && v.attributes !== null && !Array.isArray(v.attributes)
    && (typeof v.brand === 'string' || typeof v.sku === 'string');
}

/**
 * Eine Kategorie ist eine DEFINITION, kein Artikel. Ihre Attributliste enthaelt Labels
 * ("Serial Number") und Auswahlwerte ("Steel", "Leather") — wer die mitdurchsucht, findet
 * bei "steel" jede Uhr, weil ihre Kategorie Stahl anbietet, nicht weil der Artikel aus
 * Stahl ist. Genau das ist real passiert (alle 66 Artikel). Durchsuchbar ist deshalb nur
 * der Name der Kategorie; das Material des Artikels steht ohnehin in seinen Attributen.
 */
export function isCategoryLike(value: unknown): value is Category {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === 'string' && Array.isArray(v.attributes)
    && (Array.isArray(v.conditionOptions) || Array.isArray(v.scopeOptions));
}

/** Der durchsuchbare Teil einer Kategorie: ihr Name. */
export function categorySearchText(category: Category): string {
  return String(category.name ?? '').toLowerCase();
}
/** Multi-line Beschreibung für PDF/Print: "Brand Name\nRef: X\nDiameter: 40mm\n…". */
export function formatProductMultiLine(
  product: Product | undefined,
  categories: Category[],
  opts: FormatOptions = { prominentOnly: false }
): string {
  if (!product) return '';
  const head = `${product.brand || ''} ${product.name || ''}`.trim();
  const specs = getProductSpecs(product, categories, opts);
  if (specs.length === 0) return head;
  return [head, ...specs.map(s => `${s.label}: ${s.value}`)].join('\n');
}

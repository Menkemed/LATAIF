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
  return [product.brand, product.name, product.sku, product.condition,
    ...productAttributeSearchValues(product)]
    .map(v => String(v ?? '').toLowerCase())
    .filter(Boolean)
    .join(' ');
}

/**
 * Die EINE Stelle, die aus den Attributen eines Produkts Suchtext macht.
 *
 * Zwei Grenzen, beide gegen dieselbe Fehlerklasse: aus `attributes` darf kein technischer
 * Inhalt in die Suche geraten, nur der fachliche Wert, den ein Mensch am Artikel sieht.
 *
 *   • FORM — nur einfache Werte und Listen einfacher Werte. Ein verschachteltes Objekt wird
 *     nicht serialisiert; frueher wurde daraus "[object Object]", und alles darin haette
 *     mitsuchen koennen, sobald jemand strukturierte Metadaten in ein Attribut legt.
 *   • SCHLUESSEL — ist die Kategorie bekannt, zaehlen ausschliesslich die Attribute, die sie
 *     wirklich definiert. Ein unbekannter oder technischer Schluessel, wie ihn ein Import oder
 *     eine KI-Antwort hinterlassen kann, wird damit nicht von selbst durchsuchbar.
 *
 * Ohne Kategorie greift nur die Formgrenze — der Aufrufer, der keine Kategorie kennt, kann
 * einen Schluessel nicht pruefen. Die Listensuche gibt sie mit, wo sie sie hat.
 */
export function productAttributeSearchValues(product: Product, category?: Category): string[] {
  const attrs = (product.attributes as Record<string, unknown>) || {};
  const defined = category ? new Set((category.attributes || []).map(a => a.key)) : null;
  const out: string[] = [];
  const primitive = (v: unknown): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  for (const [key, value] of Object.entries(attrs)) {
    if (defined && !defined.has(key)) continue;
    if (Array.isArray(value)) { for (const v of value) if (primitive(v)) out.push(String(v)); continue; }
    if (primitive(value)) out.push(String(value));
  }
  return out;
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

/**
 * Die fachlichen Produktfelder, die eine Textsuche sieht — die vollstaendige Liste.
 *
 * Suche ist Identifikation und Beschreibung eines Artikels: woran erkennt ein Mensch ihn
 * wieder, wenn er ihn in der Hand hatte. Nicht dabei ist alles, wonach man FILTERT statt
 * sucht — Preise, Steuerschema, Eigentumsart und der interne Bestandsstatus haben dafuer
 * ihre eigenen Schaltflaechen und wuerden als Freitext nur Zufallstreffer erzeugen: eine
 * Suche nach "126" darf kein Produkt finden, dessen Preis zufaellig 126 enthaelt.
 */
export const PRODUCT_SEARCH_FIELDS = [
  'brand', 'name', 'sku', 'condition',      // Identitaet
  'attributes',                             // die fachlichen Werte der Kategorie-Attribute
  'notes', 'storageLocation', 'scopeOfDelivery',
  'supplierName',                           // der Lieferant als Klartext-Name
] as const;

/**
 * Der fachliche Suchtext eines Produkts — die kanonische Projektion fuer jede Listensuche.
 *
 * Marke, Name, SKU und Zustand kommen aus derselben Ableitung wie im Produkt-Picker
 * (`productSearchText`), die Attributwerte aus derselben Stelle wie dort
 * (`productAttributeSearchValues`) — dadurch bleiben Referenz, Seriennummer, Modell,
 * Beschreibung und Material auffindbar, ohne dass es zwei Feldlisten gibt. Dazu kommen
 * Notiz, Lagerort, Lieferumfang und der Lieferantenname.
 *
 * Der Lieferant steht als Klartext am Produkt (`supplier_name`) — es gibt keine Id
 * aufzuloesen, also auch keine zusaetzliche Abfrage je Artikel.
 *
 * Ausdruecklich NICHT enthalten: die drei Preise, Steuerschema, Eigentumsart
 * (`sourceType`), der interne Bestandsstatus, die technische Herkunft (`purchaseSource`),
 * Waehrung, Zahlungsart, Menge und Datumsfelder — dafuer gibt es Filter. Ebenso wenig die
 * KI- und Maschinendaten (Bildbeschreibung, Embedding, Hashes, Snapshots) und die
 * technischen Identitaeten. Ein neues technisches Feld am Produkt ist von sich aus nicht
 * durchsuchbar; es muesste hier ausdruecklich aufgenommen werden.
 */
export function productBusinessSearchText(product: Product, category?: Category): string {
  const parts: unknown[] = [
    product.brand, product.name, product.sku, product.condition,
    product.notes, product.storageLocation, product.supplierName,
    ...(Array.isArray(product.scopeOfDelivery) ? product.scopeOfDelivery : []),
    ...productAttributeSearchValues(product, category),
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

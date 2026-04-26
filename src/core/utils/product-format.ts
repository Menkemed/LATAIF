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

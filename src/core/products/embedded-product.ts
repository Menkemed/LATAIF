// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5E — ein Artikel, der INNERHALB eines Auftrags oder Einkaufs entsteht.
//
// Auftrag („New Product"-Zeile, „Final Product") und Einkauf („New Item") erfassen ihn mit der
// gemeinsamen Maske `NewProductModal`: Kategorie, Marke/Name, SKU, Merkmale, Zustand, Lieferumfang,
// Steuer, Lagerort, Notiz, Fotos. Einstand, Verkaufspreis, Menge und Zahlweg blendet die Maske dort
// aus — die setzt der Vorgang (Wareneingang, Auftrag). Hier steht, was davon ein gültiger Artikel
// ist: dieselbe Pflichtfeldregel und derselbe SKU-Riegel wie an der Maske, für beide Seiten.
// ════════════════════════════════════════════════════════════════════════════
import type { Category, Product } from '@/core/models/types';
import { planProductCreate, productCreateRefusal } from './product-create';

/** Die Felder der Maske in Auftrag und Einkauf. */
export const EMBEDDED_PRODUCT_FIELDS = [
  'categoryId', 'brand', 'name', 'sku', 'condition', 'attributes', 'scopeOfDelivery',
  'taxScheme', 'purchaseCurrency', 'storageLocation', 'notes', 'images',
] as const;
/** „Final Product" eines Sonderauftrags — dieselbe Maske, ohne Lagerort. */
export const FINAL_PRODUCT_FIELDS = EMBEDDED_PRODUCT_FIELDS.filter((f) => f !== 'storageLocation');

/** Nur die Felder der Maske — was sonst an einem Entwurf hängt (eine Kopie, ein KI-Vorschlag), zählt nicht. */
export function pickProductSpec(spec: Partial<Product> | undefined, fields: readonly string[]): Partial<Product> | undefined {
  if (!spec) return undefined;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = (spec as Record<string, unknown>)[f];
    if (v !== undefined) out[f] = v;
  }
  return out as Partial<Product>;
}

export class EmbeddedProductRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'EmbeddedProductRejected';
  }
}

export interface EmbeddedProductPort {
  category(id: string): Category | undefined;
  isSkuTaken(sku: string): boolean;
}

/**
 * Die Prüfung der Maske (Pflichtfelder der Kategorie dependsOn-bewusst, veraltete Merkmale
 * gestrichen, eine schon vergebene SKU abgewiesen). Vergeben wird KEINE SKU: Auftrag und Einkauf
 * legten den Artikel schon immer ohne an, wenn keine eingetippt war.
 */
export function checkEmbeddedProduct(spec: Partial<Product>, port: EmbeddedProductPort): Partial<Product> {
  const plan = planProductCreate(spec, {
    category: port.category(String(spec.categoryId ?? '')),
    isSkuTaken: port.isSkuTaken,
    allocateSku: () => '',
  });
  if (plan.kind !== 'ok') {
    const r = productCreateRefusal(plan);
    throw new EmbeddedProductRejected(r.code, r.message);
  }
  const { sku, ...rest } = plan.data;
  return sku ? { ...rest, sku } : rest;
}

/**
 * Für den zweiten Rechner: die Fotos eines Entwurfs in die Zwischenablage, im Rumpf nur ihre
 * Kennungen. Die Bilder selbst reisen NIE im Auftrag.
 */
export async function stageSpecImages(
  spec: Partial<Product> | undefined, stage: (urls: readonly string[]) => Promise<string[]>,
): Promise<Record<string, unknown> | undefined> {
  if (!spec) return undefined;
  const { images, ...rest } = spec as Record<string, unknown>;
  // Ein Entwurf MIT Fotofeld (auch leer) bekommt eine Kennungsliste; einer ohne keins — der Primary
  // setzt dann auch kein Fotofeld, genau wie die Maske.
  if (!Array.isArray(images)) return { ...rest };
  const urls = images as string[];
  return { ...rest, stagingIds: urls.length > 0 ? await stage(urls) : [] };
}

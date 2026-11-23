// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — reine Anzeige-Hilfen (ohne Datenbank): Mitglieder eines Modells, Größen, Bestand, Preisspanne.
// Dieselbe Rechnung am Primary und am PC2 (beide haben Artikel und Zuordnungen im Store).
// ═════════════════════════════════════════════════════════════════

import type { Product } from '@/core/models/types';
import { productDisplayName } from './display-name';
import { isAvailableVariant, modelDisplayName, type ModelCandidate } from './product-models';

export type ModelMap = Readonly<Record<string, string>>;

/** Alle Artikel eines Modells (aus der übergebenen Liste), nach Größe und SKU sortiert. */
export function modelMembers(products: readonly Product[], models: ModelMap, key: string): Product[] {
  return products.filter((p) => models[p.id] === key)
    .sort((a, b) => sizeOf(a).localeCompare(sizeOf(b), undefined, { numeric: true }) || String(a.sku ?? '').localeCompare(String(b.sku ?? '')));
}

/** Die Größe eines Artikels — aus dem Attribut `size` (Schmuck); Uhren: Gehäusedurchmesser; sonst leer. */
export function sizeOf(p: Product): string {
  const a = (p.attributes ?? {}) as Record<string, unknown>;
  const v = a.size ?? (a.case_diameter_mm != null && a.case_diameter_mm !== '' ? `${a.case_diameter_mm} mm` : '');
  return String(v ?? '').trim();
}

export function weightOf(p: Product): number | null {
  const v = Number((p.attributes as Record<string, unknown> | undefined)?.weight);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Die Merkmale für die Gruppierungsregel — Eigentum aus `sourceType` (der Primary prüft zusätzlich offene Kommissionen). */
export function candidateOfProduct(p: Product, branchId: string): ModelCandidate {
  return {
    id: p.id,
    branchId,
    categoryId: p.categoryId,
    brand: p.brand ?? '',
    attributes: (p.attributes ?? {}) as Record<string, unknown>,
    ownership: String(p.sourceType || 'OWN').toUpperCase(),
    stockStatus: String(p.stockStatus ?? ''),
  };
}

export interface ModelSummary {
  key: string;
  name: string;
  brand: string;
  members: Product[];
  available: Product[];
  sold: number;
  other: number;
  /** verfügbare Größen mit Stückzahl, aufsteigend */
  sizes: Array<{ size: string; count: number }>;
  /** Größen, die nur noch verkauft bzw. reserviert sind */
  soldSizes: string[];
  priceMin: number | null;
  priceMax: number | null;
  /** der Artikel, dessen Bild die Karte zeigt und dessen Seite sich öffnet */
  representative: Product;
}

function pieces(p: Product): number {
  const q = Number(p.quantity);
  return Number.isFinite(q) && q > 0 ? q : 1;
}

/** Die Anzeige „Marke Modell" eines Modells — über die EINE Namensregel (`productDisplayName`). */
export function modelTitle(s: Pick<ModelSummary, 'brand' | 'name' | 'representative'>): string {
  return productDisplayName({ ...s.representative, brand: s.brand, name: s.name });
}

export function summarizeModel(key: string, members: readonly Product[]): ModelSummary {
  const available = members.filter((m) => isAvailableVariant(String(m.stockStatus)));
  const sold = members.filter((m) => String(m.stockStatus).toLowerCase() === 'sold').length;
  const counts = new Map<string, number>();
  for (const m of available) { const s = sizeOf(m) || '—'; counts.set(s, (counts.get(s) ?? 0) + pieces(m)); }
  const sizes = [...counts.entries()].map(([size, count]) => ({ size, count }))
    .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const soldSizes = [...new Set(members.filter((m) => !isAvailableVariant(String(m.stockStatus))).map((m) => sizeOf(m) || '—'))]
    .filter((s) => !counts.has(s)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const prices = available.map((m) => Number(m.plannedSalePrice)).filter((x) => Number.isFinite(x) && x > 0);
  return {
    key,
    name: modelDisplayName(members.map((m) => m.name)),
    brand: modelDisplayName(members.map((m) => m.brand ?? '')),
    members: [...members],
    available,
    sold,
    other: members.length - available.length - sold,
    sizes,
    soldSizes,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    representative: available[0] ?? members[0],
  };
}

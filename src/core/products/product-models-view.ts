// ═════════════════════════════════════════════════════════════════
// ARTIKELVARIANTEN — reine Anzeige-Hilfen (ohne Datenbank): Mitglieder eines Modells, Größen, Bestand, Preisspanne.
// Dieselbe Rechnung am Primary und am PC2 (beide haben Artikel und Zuordnungen im Store).
// ═════════════════════════════════════════════════════════════════

import type { Product } from '@/core/models/types';
import { productDisplayName } from './display-name';
import { isAvailableVariant, modelDisplayName, type ModelCandidate } from './product-models';
import { karatShort } from './karat-short';

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

/** Karat & Color eines Stücks in Kurzform („18K WG") — dieselbe Regel wie das Etikett; leer, wenn nicht gesetzt. */
export function karatOf(p: Product): string {
  return karatShort((p.attributes as Record<string, unknown> | undefined)?.karat);
}

/** v0.8.113 — die freie Beschreibung eines Stücks (z. B. die Steinfarbe „Malachite"), getrimmt; leer, wenn nicht gesetzt. */
export function descriptionOf(p: Product): string {
  return String(((p.attributes as Record<string, unknown> | undefined)?.description) ?? '').replace(/\s+/g, ' ').trim();
}

/** Kürzt einen Text für Chip/Tabelle auf höchstens `max` Zeichen (mit „…"). */
export function shortText(t: string, max: number): string {
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

/**
 * PURCHASE ADD VARIANT — die Aufschlüsselung der Modellkarte: Größe und Karat & Color („17 · 18K WG").
 * v0.8.113 — mit Description dahinter („18K YG · Malachite"); dann entfällt der Platzhalter für eine fehlende Größe.
 */
export function variantKeyOf(p: Product): string {
  const d = descriptionOf(p);
  if (d) return [sizeOf(p), karatOf(p), shortText(d, 16)].filter(Boolean).join(' · ');
  return [sizeOf(p) || '—', karatOf(p)].filter(Boolean).join(' · ');
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
  /** verfügbare Größen (mit Karat & Color, z. B. „17 · 18K WG") mit Stückzahl, aufsteigend */
  sizes: Array<{ size: string; count: number }>;
  /** Größen (mit Karat & Color), die nur noch verkauft bzw. reserviert sind */
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
  for (const m of available) { const s = variantKeyOf(m); counts.set(s, (counts.get(s) ?? 0) + pieces(m)); }
  const sizes = [...counts.entries()].map(([size, count]) => ({ size, count }))
    .sort((a, b) => a.size.localeCompare(b.size, undefined, { numeric: true }));
  const soldSizes = [...new Set(members.filter((m) => !isAvailableVariant(String(m.stockStatus))).map((m) => variantKeyOf(m)))]
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

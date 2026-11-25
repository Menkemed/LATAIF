// ═════════════════════════════════════════════════════════════════
// PURCHASE ADD VARIANT (Owner 25.11.2026) — gemeinsame, reine Regeln für „Add variant" (Collections und Einkauf):
//   • welche Angaben aus dem Ausgangsartikel übernommen werden (EINE Regel für beide Einstiege);
//   • Karat & Color: die Kurzform (18K YG/WG/RG/MIX) — DIESELBE wie auf dem Etikett — für Modellkarten und Suche,
//     ohne sie zu speichern. Gespeichert bleibt nur das vorhandene Merkmal `attributes.karat` ("18K White" …).
// Keine Datenbank, kein Store.
// ═════════════════════════════════════════════════════════════════

import type { Product } from '@/core/models/types';
import { copiedAttributes } from './duplicate-dismiss';
import { karatShort } from './karat-short';

export { karatShort };

/** Je Stück individuell — nie aus dem Ausgangsartikel übernommen. */
export const VARIANT_INDIVIDUAL_ATTRIBUTES = ['size', 'weight', 'serial_number', 'diamond_weight', 'stones', 'year'] as const;

/**
 * Die Vorbelegung einer neuen Variante: Kategorie, Marke, Modell (Name), Zustand, Lieferumfang und die gemeinsamen
 * Merkmale (Warenart, Referenz, Beschreibung … und Karat & Color als VORSCHLAG zur Bestätigung). Leer bleiben Größe,
 * Gewicht, Seriennummer, Steine, Jahr, Preise, SKU, Fotos — und die Steuerart (nie vom Original übernommen).
 */
export function variantSeed(template: Product, conditionFallback = ''): Partial<Product> {
  const shared = { ...copiedAttributes(template) } as Record<string, unknown>;
  for (const k of VARIANT_INDIVIDUAL_ATTRIBUTES) delete shared[k];
  return {
    categoryId: template.categoryId, brand: template.brand, name: template.name,
    condition: template.condition || conditionFallback, taxScheme: undefined,
    scopeOfDelivery: [...(template.scopeOfDelivery || [])], purchaseCurrency: 'BHD',
    attributes: shared as Product['attributes'], images: [],
  };
}

const karatOf = (p: { attributes?: Product['attributes'] } | null | undefined): string =>
  String(((p?.attributes ?? {}) as Record<string, unknown>).karat ?? '').trim();

/** Haben zwei Stücke denselben Karat-/Farbwert? Zwei leere Werte gelten als gleich (Uhren, Zubehör). */
export function sameKarat(a: { attributes?: Product['attributes'] } | null | undefined, b: { attributes?: Product['attributes'] } | null | undefined): boolean {
  return karatOf(a).toLowerCase() === karatOf(b).toLowerCase();
}

/** Der Karat-/Farbwert eines Stücks in Kurzform (für Modellkarte und -tabelle). */
export function karatShortOf(p: { attributes?: Product['attributes'] } | null | undefined): string {
  return karatShort(karatOf(p));
}

/**
 * Zusätzliche Suchbegriffe — nur zur Laufzeit, nie gespeichert: die Kurzform („18K WG") und das Farbkürzel („WG"),
 * damit die Suche nach „WG", „18K WG" oder „18k wg" das Stück mit „18K White" findet.
 */
export function karatSearchTerms(p: { attributes?: Product['attributes'] } | null | undefined): string[] {
  const short = karatShortOf(p);
  if (!short) return [];
  const teile = short.split(' ');
  return teile.length > 1 ? [short, teile[teile.length - 1]] : [short];
}

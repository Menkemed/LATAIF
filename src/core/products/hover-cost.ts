// Hover-Karte der Artikelauswahl — welcher Einstand angezeigt wird. Keine eigene Bewertung: offene Lose →
// `fifoCost`, derselbe Wert, den ein Verkauf als Einstand bucht (InvoiceCreate, invoice-command,
// offer-house); ohne offenes Los (Altbestand ohne Los, ausverkauft, Kommission) der Einkaufspreis des
// Artikels — wie beim Verkauf selbst. Bei mehreren Losen zusätzlich Durchschnitt und Anzahl.
import type { ProductLots } from '@/core/data/domain-reads';

export interface HoverCardCost {
  value: number;
  source: 'lot' | 'product';
  avg?: number;
  lots?: number;
}

export function hoverCardCost(purchasePrice: number | null | undefined, fifo: ProductLots['fifo'] | undefined): HoverCardCost {
  if (fifo) {
    return { value: fifo.fifoCost, source: 'lot', ...(fifo.lotCount > 1 ? { avg: fifo.weightedAvg, lots: fifo.lotCount } : {}) };
  }
  return { value: Number(purchasePrice) || 0, source: 'product' };
}

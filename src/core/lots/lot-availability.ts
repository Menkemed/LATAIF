// ═══════════════════════════════════════════════════════════
// LATAIF — Lot-Verfügbarkeit (rein, keine DB)
// ═══════════════════════════════════════════════════════════
//
// F1 — Pre-Flight-Entscheidung "ist dieser Lot noch um die geforderte Menge
// konsumierbar?". BEWUSST self-contained (kein '@/'-Import, keine DB, kein Tauri/React)
// — analog zu b1-protocol.ts, damit dieselbe Logik im Desktop (via lot-queries.ts) UND
// in einem Node-Harness ohne Vite-SSR läuft. Der DB-Layer reicht nur den Lot-Snapshot rein.

export const STOCK_UNAVAILABLE_MESSAGE =
  'This item is no longer available in stock. Please refresh and try again.';

export interface LotSnapshot {
  status: string;
  qtyRemaining: number;
}

// True, wenn der Lot aktiv (nicht CANCELLED) ist und mindestens `qty` Reststück trägt.
// Spiegelt exakt die Guards in consumeLot (lot-queries.ts): CANCELLED → nein,
// qtyRemaining < qty → nein.
export function isLotConsumable(lot: LotSnapshot | null | undefined, qty: number): boolean {
  return !!lot && lot.status !== 'CANCELLED' && lot.qtyRemaining >= Math.max(1, qty);
}

// Aggregiert die geforderte Menge PRO Lot (mehrere Invoice-Lines können denselben Lot
// ziehen — z.B. zwei Offer-Lines desselben Produkts → derselbe Auto-FIFO-Lot) und liefert
// die erste lotId, deren Restbestand die Summe nicht deckt; sonst null. `lookup` liefert
// den aktuellen Lot-Snapshot (im Desktop: getLot). Lines ohne Lot werden übersprungen
// (Service/Consignment-vor-Auto-Purchase-Verkäufe bleiben erlaubt).
export function firstUnavailableLot(
  picks: { lotId: string | null | undefined; qty: number }[],
  lookup: (lotId: string) => LotSnapshot | null | undefined,
): string | null {
  const byLot = new Map<string, number>();
  for (const p of picks) {
    if (!p.lotId) continue;
    byLot.set(p.lotId, (byLot.get(p.lotId) || 0) + Math.max(1, p.qty || 1));
  }
  for (const [lotId, totalQty] of byLot) {
    if (!isLotConsumable(lookup(lotId), totalQty)) return lotId;
  }
  return null;
}

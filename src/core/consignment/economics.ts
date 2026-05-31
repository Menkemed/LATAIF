// SSOT — Consignment-Sale-Oekonomie für ALLE drei Commission-Modelle.
//
// Vorher war die Marge/Payout-Berechnung an ~8 Stellen dupliziert (Store
// recordSale + markSold, ConsignmentList Sold-Preview + Liste, ConsignmentDetail
// 5x, ConsignorDetail), und nur 2 Modelle wurden sauber unterschieden
// (consignor_fixed vs. „alles andere = percent"). cost_split fiel überall durchs
// percent-Raster → falsche Vorschauen + falsche Labels.
//
// Diese Datei ist die EINE Wahrheit: jede Anzeige + die Buchungslogik rufen
// computeConsignmentSale() / commissionLineLabel() / commissionModelLabel().
import type { Consignment } from '@/core/models/types';
import { fmtBhd, fmtPct } from '@/core/utils/format';

/** Default Shop-Anteil am Profit bei cost_split (= 50/50). */
export const DEFAULT_COST_SPLIT_PCT = 50;

type CommissionInput = Pick<
  Consignment,
  'commissionType' | 'commissionRate' | 'agreedPrice' | 'excessSplitPct'
>;

export interface ConsignmentSaleResult {
  /** Marge/Commission des Shops. Negativ = Shop schluckt einen Verlust. */
  commission: number;
  /** Auszahlung an den Consignor. */
  payout: number;
  /** Consignor-Loss (Shortfall) — > 0 nur wenn unter dem Floor verkauft. */
  loss: number;
  /** Verkauf unterhalb des Consignor-Floors (Kost bzw. Agreed Price)? */
  belowFloor: boolean;
  /** Der Floor-Betrag (agreedPrice — bei cost_split = Kost, bei consignor_fixed = Agreed). */
  floor: number;
}

/** Normalisiert den Commission-Typ — 'fixed' (legacy) + unbekannt → 'percent'. */
function normType(t: CommissionInput['commissionType']): 'percent' | 'consignor_fixed' | 'cost_split' {
  if (t === 'consignor_fixed' || t === 'cost_split') return t;
  return 'percent';
}

/**
 * Berechnet Commission + Payout (+ ggf. Loss) für einen Verkauf zum salePrice.
 * Eine Wahrheit für Store-Buchung UND alle Display-Vorschauen.
 */
export function computeConsignmentSale(con: CommissionInput, salePrice: number): ConsignmentSaleResult {
  const sale = Number(salePrice) || 0;
  const agreed = Number(con.agreedPrice) || 0;
  const type = normType(con.commissionType);

  if (type === 'consignor_fixed') {
    // Agreed + Excess: Consignor kriegt garantiert den Agreed-Preis, Shop den Rest.
    const belowFloor = sale < agreed;
    return {
      commission: sale - agreed,                 // negativ wenn unter Agreed
      payout: agreed,
      loss: belowFloor ? agreed - sale : 0,
      belowFloor,
      floor: agreed,
    };
  }

  if (type === 'cost_split') {
    // Consignor nennt seinen Kost (= agreedPrice). Profit darüber wird geteilt:
    // Shop bekommt shopPct%, Consignor den Rest. Unter Kost → Garantie + Loss.
    const cost = agreed;
    const shopPct = con.excessSplitPct ?? DEFAULT_COST_SPLIT_PCT;
    if (sale >= cost) {
      const profit = sale - cost;
      const commission = profit * (shopPct / 100);
      return { commission, payout: cost + (profit - commission), loss: 0, belowFloor: false, floor: cost };
    }
    return { commission: -(cost - sale), payout: cost, loss: cost - sale, belowFloor: true, floor: cost };
  }

  // percent: Shop zieht rate% vom GESAMTEN Verkaufspreis ab.
  const rate = con.commissionRate || 0;
  const commission = sale * (rate / 100);
  return { commission, payout: sale - commission, loss: 0, belowFloor: false, floor: 0 };
}

/**
 * Label für die Commission-/Marge-Zeile in einem Sale-Breakdown.
 * z.B. "Commission (15.0%)" · "Our margin (above agreed 1,000.000 BHD)" ·
 *      "Shop share (50% of profit above cost)".
 */
export function commissionLineLabel(con: CommissionInput): string {
  const type = normType(con.commissionType);
  if (type === 'consignor_fixed') return `Our margin (above agreed ${fmtBhd(con.agreedPrice)} BHD)`;
  if (type === 'cost_split') {
    const shopPct = con.excessSplitPct ?? DEFAULT_COST_SPLIT_PCT;
    return `Shop share (${shopPct}% of profit above cost)`;
  }
  // fmtPct hängt das %-Zeichen bereits an → kein zusätzliches %.
  return `Commission (${fmtPct(con.commissionRate)})`;
}

/**
 * Kompaktes Modell-Label (ohne Betrag) — z.B. für die "Commission Rate"-Zelle
 * oder Listen-Spalte. "15.0%" · "Agreed + Excess" · "Cost + 50% split".
 */
export function commissionModelLabel(con: CommissionInput): string {
  const type = normType(con.commissionType);
  if (type === 'consignor_fixed') return 'Agreed + Excess';
  if (type === 'cost_split') {
    const shopPct = con.excessSplitPct ?? DEFAULT_COST_SPLIT_PCT;
    return `Cost + ${shopPct}% split`;
  }
  return fmtPct(con.commissionRate);
}

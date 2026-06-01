// SSOT — Approval/Agent-Transfer-Abrechnung. EINE Wahrheit für beide Modelle:
//  'full'  = Kunde schuldet uns den vollen Verkaufspreis (kein Split).
//  'split' = wir geben dem Kunden Ware zu "Our Price" (agentPrice); verkauft er
//            darüber, wird der Überschuss geteilt — Shop bekommt excessSplitPct%,
//            der Kunde behält den Rest. Verkauf UNTER Our Price: wir bekommen nur
//            den tatsächlichen Erlös (kein Split), mit Bestätigungs-Warnung.
//
// Spiegelbild von core/consignment/economics.ts (dort gibt der Konsignant UNS
// Ware; hier geben WIR dem Kunden Ware → der "Floor" ist unser Preis, und WIR
// kriegen Floor + Anteil statt der Gegenpartei).
import type { AgentTransfer } from '@/core/models/types';
import { fmtPct } from '@/core/utils/format';

/** Default Shop-Anteil am Überschuss bei 'split' (= 50/50). */
export const DEFAULT_AGENT_SPLIT_PCT = 50;

type SettlementInput = Pick<AgentTransfer, 'settlementModel' | 'agentPrice' | 'excessSplitPct'>;

export interface AgentTransferSaleResult {
  /** Was wir vom Kunden bekommen (= Höhe der erzeugten Invoice / settlementAmount). */
  ourSettlement: number;
  /** Marge, die der Kunde behält (nur 'split' und nur über Our Price). */
  customerShare: number;
  /** Überschuss über Our Price (0 wenn darunter oder 'full'). */
  excess: number;
  /** Verkauf unter Our Price (nur 'split' relevant) → Bestätigung nötig. */
  belowPrice: boolean;
  /** Our Price (= agentPrice). */
  ourPrice: number;
}

function normModel(m: SettlementInput['settlementModel']): 'full' | 'split' {
  return m === 'split' ? 'split' : 'full';
}

/**
 * Berechnet unser Settlement + Kunden-Anteil für einen Verkauf zum salePrice.
 * Eine Wahrheit für Store-Buchung (markTransferSold) UND alle Vorschauen.
 */
export function computeAgentTransferSale(t: SettlementInput, salePrice: number): AgentTransferSaleResult {
  const sale = Number(salePrice) || 0;
  const model = normModel(t.settlementModel);

  if (model === 'full') {
    // Voller Verkaufspreis ist unsere Forderung — keine Aufteilung.
    return { ourSettlement: sale, customerShare: 0, excess: 0, belowPrice: false, ourPrice: Number(t.agentPrice) || 0 };
  }

  // 'split': Our Price = agentPrice. Überschuss darüber teilen.
  const ourPrice = Number(t.agentPrice) || 0;
  const shopPct = t.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT;
  if (sale >= ourPrice) {
    const excess = sale - ourPrice;
    const customerShare = excess * ((100 - shopPct) / 100);
    return { ourSettlement: sale - customerShare, customerShare, excess, belowPrice: false, ourPrice };
  }
  // Unter Our Price: wir bekommen nur den tatsächlichen Erlös, kein Split.
  return { ourSettlement: sale, customerShare: 0, excess: 0, belowPrice: true, ourPrice };
}

/**
 * Label für die Settlement-/Marge-Zeile in einem Sale-Breakdown.
 * 'full' → "Full sale amount to us" · 'split' → "Our Price + 50% of excess to us".
 */
export function settlementLineLabel(t: SettlementInput): string {
  if (normModel(t.settlementModel) === 'full') return 'Full sale amount to us';
  const shopPct = t.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT;
  return `Our Price + ${shopPct}% of excess to us`;
}

/**
 * Kompaktes Modell-Label (ohne Betrag) — z.B. für Listen-Spalte / Detail-Zelle.
 * 'full' → "Full amount" · 'split' → "Our Price + 50% split".
 */
export function settlementModelLabel(t: SettlementInput): string {
  if (normModel(t.settlementModel) === 'full') return 'Full amount';
  const shopPct = t.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT;
  return `Our Price + ${shopPct}% split`;
}

// fmtPct re-exportiert für UI-Stellen die das Modell-% formatieren wollen.
export { fmtPct };

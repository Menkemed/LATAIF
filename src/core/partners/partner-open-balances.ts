// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — die OFFENEN Partner-Salden als Forderung / Verbindlichkeit.
//
// Keine zweite Rechnung und keine Buchung: gelesen wird ausschließlich der offene Stand, den die
// Partnerlogik je Partner und Artikel schon führt (`partnerItemsOverview` → `open`, `moneyAction`).
//   Partner schuldet LATAIF  (open < 0: „Partner pays in" / „Partner repays")  → Receivable
//   LATAIF schuldet Partner  (open > 0: „Pay out")                              → Payable
// Bei OPEN = 0 gibt es keine Zeile. Der Verlauf bleibt im Partner-Modul.
//
// Diese Datei rechnet nur aus der Übersicht (keine Datenbank) — Receivables, Payables, Bericht und
// Test benutzen dieselbe Ableitung.
// ════════════════════════════════════════════════════════════════════════════
import type { PartnerItemsOfPartner } from './item-participation-house';

export type PartnerOpenSide = 'RECEIVABLE' | 'PAYABLE';
/** Woher der offene Betrag kommt — dieselbe Unterscheidung wie die Geldhandlung der Partnerseite. */
export type PartnerOpenOrigin = 'COST_SHARE' | 'REPAYMENT' | 'PAYOUT';

export interface PartnerOpenRow {
  partnerId: string;
  partnerName: string;
  purchaseLineId: string;
  purchaseId: string;
  purchaseNumber: string;
  productLabel: string;
  side: PartnerOpenSide;
  origin: PartnerOpenOrigin;
  /** Offener Betrag, immer positiv. */
  open: number;
  /** Bezugsgröße und der schon gedeckte Teil (Kostenanteil / davon gedeckt) — sonst open / 0. */
  total: number;
  covered: number;
  /** Relevantes Datum: Einkauf beim Kostenanteil, sonst die letzte wirksame Bewegung. */
  date: string;
  /** Auszahlung wartet (Nachabrechnung offen oder Lieferantengutschrift noch nicht verwendet). */
  onHold: boolean;
  /** Der Partner ist am laufenden Abschnitt beteiligt (sonst: beendete Beteiligung mit Rest). */
  participating: boolean;
  /** Die Stelle im Partner-Modul. */
  href: string;
}

export const PARTNER_ORIGIN_LABEL: Record<PartnerOpenOrigin, string> = {
  COST_SHARE: 'Cost share',
  REPAYMENT: 'Repayment',
  PAYOUT: 'Pay out',
};

export function partnerItemHref(partnerId: string, purchaseLineId: string): string {
  return `/partners?partner=${encodeURIComponent(partnerId)}&item=${encodeURIComponent(purchaseLineId)}`;
}

/** Die offenen Salden aller Partner, eine Zeile je Partner und Artikel. */
export function partnerOpenRows(overview: readonly PartnerItemsOfPartner[]): PartnerOpenRow[] {
  const out: PartnerOpenRow[] = [];
  for (const p of overview) {
    for (const it of p.items) {
      if (it.moneyAction === 'NONE' || it.open === 0) continue;
      const open = Math.abs(it.open);
      const side: PartnerOpenSide = it.open < 0 ? 'RECEIVABLE' : 'PAYABLE';
      const origin: PartnerOpenOrigin = it.moneyAction === 'PAYS_IN' ? 'COST_SHARE' : it.moneyAction === 'REPAYS' ? 'REPAYMENT' : 'PAYOUT';
      const letzte = [...it.movements].reverse().find((m) => !m.cancelled)?.occurredAt || '';
      const costShare = origin === 'COST_SHARE' && it.owedCost >= open;
      out.push({
        partnerId: p.partnerId, partnerName: p.name,
        purchaseLineId: it.purchaseLineId, purchaseId: it.purchaseId, purchaseNumber: it.purchaseNumber,
        productLabel: it.productLabel,
        side, origin, open,
        total: costShare ? it.owedCost : open,
        covered: costShare ? Math.round((it.owedCost - open) * 1000) / 1000 : 0,
        date: origin === 'COST_SHARE' ? (it.purchaseDate || letzte) : (letzte || it.purchaseDate),
        onHold: side === 'PAYABLE' && (it.correctionPending || it.refundPending),
        participating: it.participating,
        href: partnerItemHref(p.partnerId, it.purchaseLineId),
      });
    }
  }
  return out;
}

// SSOT fuer Karten-Bearbeitungsgebuehren (v0.7.26).
// Zwei Raten je nach Karten-Brand:
//   normal (Visa / Mastercard / Debit) = finance.card_fee_rate       (Default 2.2%)
//   amex   (American Express)          = finance.card_fee_rate_amex  (Default 2.5%)
// WICHTIG: Banking/Ledger/Analytics behandeln die Zahlungsmethode weiterhin als
// 'card' — NUR die Gebuehren-RATE unterscheidet sich nach Brand. Dadurch bleibt
// das gesamte Konten-/Netting-Routing unveraendert korrekt.
import { query } from '@/core/db/helpers';

export type CardBrand = 'normal' | 'amex';

export const CARD_FEE_DEFAULTS: Record<CardBrand, number> = { normal: 2.2, amex: 2.5 };

const SETTING_KEY: Record<CardBrand, string> = {
  normal: 'finance.card_fee_rate',
  amex: 'finance.card_fee_rate_amex',
};

/** Liest die Gebuehren-Rate (%) fuer den Brand aus den Settings (Fallback = Default). */
export function cardFeeRate(branchId: string, brand: CardBrand): number {
  try {
    const rows = query(`SELECT value FROM settings WHERE branch_id = ? AND key = ?`, [branchId, SETTING_KEY[brand]]);
    const v = parseFloat((rows[0]?.value as string) || '');
    return Number.isFinite(v) && v >= 0 ? v : CARD_FEE_DEFAULTS[brand];
  } catch {
    return CARD_FEE_DEFAULTS[brand];
  }
}

/**
 * Berechnet die Karten-Gebuehr fuer Betrag + Brand. Rundung IDENTISCH zur
 * bisherigen invoiceStore-Logik: Math.round(amount * rate) / 100  -> 2 Dezimalen.
 */
export function computeCardFee(branchId: string, amount: number, brand: CardBrand): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const rate = cardFeeRate(branchId, brand);
  return Math.round(amount * rate) / 100;
}

/** Normalisiert beliebigen DB-Wert auf 'normal' | 'amex' (Default 'normal'). */
export function normalizeCardBrand(b: unknown): CardBrand {
  return b === 'amex' ? 'amex' : 'normal';
}

/** Anzeige-Label fuer den Brand. */
export function cardBrandLabel(brand: CardBrand): string {
  return brand === 'amex' ? 'Amex' : 'Card';
}

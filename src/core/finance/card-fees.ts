// SSOT fuer Karten-Bearbeitungsgebuehren (v0.7.26).
// Drei Raten je nach Karten-Brand:
//   normal (Visa / Mastercard)  = finance.card_fee_rate        (Default 2.2%)
//   amex   (American Express)   = finance.card_fee_rate_amex   (Default 2.5%)
//   debit  (Debitkarte)         = finance.card_fee_rate_debit  (v0.8.87 — KEIN Default und KEIN Rückfall: solange
//                                 der Owner keinen Satz gespeichert hat (0 ist ein Satz), wird eine Debitzahlung
//                                 abgelehnt — nie still mit einem fremden Satz gebucht)
// WICHTIG: Banking/Ledger/Analytics behandeln die Zahlungsmethode weiterhin als
// 'card' — NUR die Gebuehren-RATE unterscheidet sich nach Brand. Dadurch bleibt
// das gesamte Konten-/Netting-Routing unveraendert korrekt.
import { query } from '@/core/db/helpers';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

/**
 * R5A — die Kartenarten als WERT, nicht nur als Typ. Ein Vertrag, der sie pruefen muss (der
 * Fernbefehl fuer eine Anzahlung), kann einen Typ nicht fragen — und schreibt sich sonst eine
 * eigene Liste, die auseinanderlaeuft. Genau das war der Arbeitsart-Fehler aus R4C.4.
 */
export const CARD_BRANDS = ['normal', 'amex', 'debit'] as const;

export type CardBrand = typeof CARD_BRANDS[number];

/** Die eingebauten Rückfallsätze — nur Normal und Amex; Debit hat keinen (siehe `CardFeeNotConfigured`). */
export const CARD_FEE_DEFAULTS: Record<'normal' | 'amex', number> = { normal: 2.2, amex: 2.5 };

export const CARD_FEE_SETTING_KEY: Record<CardBrand, string> = {
  normal: 'finance.card_fee_rate',
  amex: 'finance.card_fee_rate_amex',
  debit: 'finance.card_fee_rate_debit',
};

function storedRate(branchId: string, brand: CardBrand): number | null {
  try {
    const rows = query(`SELECT value FROM settings WHERE branch_id = ? AND key = ?`, [branchId, CARD_FEE_SETTING_KEY[brand]]);
    const v = parseFloat((rows[0]?.value as string) || '');
    return Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

export const CARD_FEE_NOT_CONFIGURED = 'CARD_FEE_NOT_CONFIGURED';

/** v0.8.87 — Debit ohne gespeicherten Satz: ein fachliches Nein VOR jedem Schreiben. Als `InvoiceActionRejected`,
 *  damit die PC2-Wege der Rechnung (Anlegen, Zahlung, Abrechnung) es ohne Sonderfall als Urteil weitergeben. */
export class CardFeeNotConfigured extends InvoiceActionRejected {
  constructor() {
    super(CARD_FEE_NOT_CONFIGURED,
      'The debit card fee is not set. Enter it in Settings → Tax / VAT → Card Processing Fee (0 % is allowed) before taking a debit card payment.');
    this.name = 'CardFeeNotConfigured';
  }
}

/** Ist für diesen Brand ein Satz da? Normal/Amex immer (eingebauter Rückfall), Debit nur gespeichert. */
export function cardFeeConfigured(branchId: string, brand: CardBrand): boolean {
  return brand !== 'debit' || storedRate(branchId, 'debit') !== null;
}

/** Die Sperre am Anfang jedes Zahlungswegs: Debit ohne Satz → `CardFeeNotConfigured`, sonst nichts. */
export function assertCardFeeConfigured(branchId: string, brand: CardBrand | null | undefined): void {
  if (brand && !cardFeeConfigured(branchId, brand)) throw new CardFeeNotConfigured();
}

/** Liest die Gebuehren-Rate (%) fuer den Brand aus den Settings (Fallback = Default; Debit ohne Satz → Nein). */
export function cardFeeRate(branchId: string, brand: CardBrand): number {
  if (brand === 'debit') {
    const rate = storedRate(branchId, 'debit');
    if (rate === null) throw new CardFeeNotConfigured();
    return rate;
  }
  return storedRate(branchId, brand) ?? CARD_FEE_DEFAULTS[brand];
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

/** Normalisiert beliebigen DB-Wert auf 'normal' | 'amex' | 'debit' (Default 'normal' — Altbestand bleibt Normal). */
export function normalizeCardBrand(b: unknown): CardBrand {
  return b === 'amex' ? 'amex' : b === 'debit' ? 'debit' : 'normal';
}

/** Anzeige-Label fuer den Brand. */
export function cardBrandLabel(brand: CardBrand): string {
  return brand === 'amex' ? 'Amex' : brand === 'debit' ? 'Debit' : 'Card';
}

/** Die Knöpfe der Masken: Normal / Amex / Debit — in dieser Reihenfolge. */
export const CARD_BRAND_OPTIONS: ReadonlyArray<{ id: CardBrand; label: string }> = [
  { id: 'normal', label: 'Normal' },
  { id: 'amex', label: 'Amex' },
  { id: 'debit', label: 'Debit' },
];

// ═══════════════════════════════════════════════════════════
// LATAIF — VAT Engine
// Stand Phase 0.A: zwei APIs nebeneinander
//   - Legacy (gross-in, extraktiv)  — wird von bestehenden Callern genutzt
//   - Netto-API (Plan §Tax §7 + §12) — für neue Formulare in Phase 0.B
// Phase 0.B wird alle Caller auf die Netto-API umstellen und die Legacy entfernen.
// ═══════════════════════════════════════════════════════════

import type { TaxScheme } from '../models/types';
import { canonicalTaxScheme } from '../models/types';

export interface TaxCalculation {
  netAmount: number;
  vatAmount: number;          // SICHTBAR — 0 für MARGIN
  grossAmount: number;        // Preis auf Rechnung (Kundenpreis)
  taxScheme: TaxScheme;
  vatRate: number;
  internalVatAmount?: number; // intern berechnet (MARGIN) — nicht sichtbar
  purchasePriceSnapshot?: number;
  marginUsedForTax?: number;
}

function round(value: number, decimals = 3): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

export class VATEngine {
  // ────────────────────────────────────────────────────────
  // LEGACY API (gross-in, extraktiv) — unverändert aus Vor-Plan-Ära.
  // Behält aktuelles Verhalten, bis Phase 0.B alle Caller migriert.
  // ────────────────────────────────────────────────────────

  /** @deprecated Legacy: nimmt gross als Input, extrahiert VAT. */
  calculateStandardVAT(salePrice: number, vatRate: number): TaxCalculation {
    const grossAmount = round(salePrice);
    const vatAmount = round(grossAmount * vatRate / (100 + vatRate));
    const netAmount = round(grossAmount - vatAmount);
    return { netAmount, vatAmount, grossAmount, taxScheme: 'VAT_10', vatRate, internalVatAmount: vatAmount };
  }

  /** @deprecated Legacy: nimmt gross als Input. Margin wird aus (gross − purchase) extrahiert. */
  calculateMarginScheme(salePrice: number, purchasePrice: number, vatRate: number): TaxCalculation {
    const margin = salePrice - purchasePrice;
    const taxableMargin = Math.max(0, margin);
    const vatAmount = round(taxableMargin * vatRate / (100 + vatRate));
    return {
      netAmount: round(salePrice),
      vatAmount,
      grossAmount: round(salePrice),
      taxScheme: 'MARGIN',
      vatRate,
      internalVatAmount: vatAmount,
      purchasePriceSnapshot: purchasePrice,
      marginUsedForTax: round(taxableMargin),
    };
  }

  /** @deprecated Legacy */
  calculateExempt(salePrice: number): TaxCalculation {
    return {
      netAmount: round(salePrice),
      vatAmount: 0,
      grossAmount: round(salePrice),
      taxScheme: 'ZERO',
      vatRate: 0,
      internalVatAmount: 0,
    };
  }

  /** @deprecated Legacy gross-in entry point. Use calculateNet() for Plan-konforme Netto-Eingabe. */
  calculate(
    salePrice: number,
    purchasePrice: number,
    taxScheme: TaxScheme,
    vatRate: number
  ): TaxCalculation {
    const scheme = canonicalTaxScheme(taxScheme);
    switch (scheme) {
      case 'VAT_10': return this.calculateStandardVAT(salePrice, vatRate);
      case 'MARGIN': return this.calculateMarginScheme(salePrice, purchasePrice, vatRate);
      case 'ZERO':   return this.calculateExempt(salePrice);
    }
  }

  /**
   * Profit-Berechnung basierend auf Netto-Input (Plan §Tax).
   * grossMargin = (Kundenpreis brutto) − Einkauf
   * vatLiability = insgesamt fällige Steuer (sichtbar ODER intern)
   * netProfit = grossMargin − vatLiability
   */
  calculateProfit(
    netAmount: number,
    purchasePrice: number,
    taxScheme: TaxScheme,
    vatRate: number
  ): { grossMargin: number; vatLiability: number; netProfit: number } {
    const calc = this.calculateNet(netAmount, purchasePrice, taxScheme, vatRate);
    const grossMargin = round(calc.grossAmount - purchasePrice);
    const vatLiability = calc.internalVatAmount || 0;
    return {
      grossMargin,
      vatLiability,
      netProfit: round(grossMargin - vatLiability),
    };
  }

  // ────────────────────────────────────────────────────────
  // NEUE NETTO-API (Plan §Tax §7 + §12) — für Phase 0.B
  // ────────────────────────────────────────────────────────

  /** Plan §4: Netto 100 + VAT 10% → Steuer 10, Gesamt 110. */
  calcVat10FromNet(netAmount: number, vatRate: number): TaxCalculation {
    const net = round(netAmount);
    const vat = round(net * vatRate / 100);
    return {
      netAmount: net,
      vatAmount: vat,
      grossAmount: round(net + vat),
      taxScheme: 'VAT_10',
      vatRate,
      internalVatAmount: vat,
    };
  }

  /** Plan §5: Netto = Gross, keine Steuer. */
  calcZeroFromNet(netAmount: number): TaxCalculation {
    const net = round(netAmount);
    return {
      netAmount: net,
      vatAmount: 0,
      grossAmount: net,
      taxScheme: 'ZERO',
      vatRate: 0,
      internalVatAmount: 0,
    };
  }

  /** Plan §6 + §8: Netto = Kundenpreis. Sichtbar 0%, intern = profit/11 bei rate=10. */
  calcMarginFromNet(netAmount: number, purchasePrice: number, vatRate: number): TaxCalculation {
    const net = round(netAmount);
    const profit = Math.max(0, net - purchasePrice);
    const internalVat = round(profit * vatRate / (100 + vatRate));
    return {
      netAmount: net,
      vatAmount: 0,
      grossAmount: net,
      taxScheme: 'MARGIN',
      vatRate,
      internalVatAmount: internalVat,
      purchasePriceSnapshot: purchasePrice,
      marginUsedForTax: round(profit),
    };
  }

  /**
   * Plan-konformer Netto-Einstieg. User gibt Netto ein, System rechnet.
   * Akzeptiert canonical und legacy scheme names.
   */
  calculateNet(
    netAmount: number,
    purchasePrice: number,
    taxScheme: TaxScheme,
    vatRate: number
  ): TaxCalculation {
    const scheme = canonicalTaxScheme(taxScheme);
    switch (scheme) {
      case 'VAT_10': return this.calcVat10FromNet(netAmount, vatRate);
      case 'ZERO':   return this.calcZeroFromNet(netAmount);
      case 'MARGIN': return this.calcMarginFromNet(netAmount, purchasePrice, vatRate);
    }
  }
}

export const vatEngine = new VATEngine();

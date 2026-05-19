// ═══════════════════════════════════════════════════════════
// LATAIF — Karat-Purity-Math (v0.1.47)
//
// SSOT fuer Gold-Purity-Factors. Erlaubt Cross-Karat-Conversion:
// Wenn ein Supplier 21K verlangt aber wir 24K im Bestand haben, koennen wir
// mit weniger Gramm Bestand denselben Reinheit-Wert (au-equivalent) liefern.
//
// 24K = 99.9% rein (Industrie-Standard "24K" wird oft 0.9999 fine genannt)
// 22K = 91.6% (.916 fine)
// 21K = 87.5% (.875 fine — typische Saudi/Bahrain-Hauptpurity)
// 18K = 75.0% (.750 fine)
// 14K = 58.5% (.585 fine)
// 9K  = 37.5% (.375 fine)
//
// Silver/Platinum-Purities sind separat (925=Sterling, 950=Platinum-Reinheit)
// und werden in dieser Datei nur fuer Vollstaendigkeit gelistet — Cross-Karat
// ist nur fuer Gold relevant.
// ═══════════════════════════════════════════════════════════

export const KARAT_PURITY: Record<string, number> = {
  '24K': 0.999,
  '22K': 0.916,
  '21K': 0.875,
  '18K': 0.750,
  '14K': 0.585,
  '9K':  0.375,
  '999': 0.999,  // Silver fine
  '925': 0.925,  // Sterling silver
  '950': 0.950,  // Platinum
};

/**
 * Reinheit-Faktor eines Karat-Strings. Unbekannte Karate liefern 1.0
 * als Fallback (verhindert silent zero-multiplication). Aufrufer sollten
 * KARAT_PURITY direkt pruefen wenn sie sichere Behandlung brauchen.
 */
export function purityOf(karat: string): number {
  return KARAT_PURITY[karat] ?? 1.0;
}

/**
 * Wieviel Gramm im Source-Karat sind aequivalent zu X Gramm im Target-Karat
 * (gleicher reiner Gold-Inhalt)?
 *
 * Beispiel: 10g 21K (87.5%) = 8.75g pure gold = ~8.76g 24K (99.9%)
 *           sourceEquivalent('21K', '24K', 10) === 10 * 0.875 / 0.999 ≈ 8.76
 *
 * Verwendung in Cross-Settle:
 *   Supplier verlangt X Gramm in targetKarat (z.B. 21K).
 *   Shop hat sourceKarat-Bestand (z.B. 24K).
 *   sourceEquivalent('24K', '21K', X) sagt wieviel Gramm vom 24K-Bestand
 *   abgebucht werden muessen um X Gramm 21K-Schuld zu tilgen.
 */
export function sourceEquivalent(sourceKarat: string, targetKarat: string, targetGrams: number): number {
  const sP = purityOf(sourceKarat);
  const tP = purityOf(targetKarat);
  if (sP <= 0) throw new Error(`Invalid source karat: ${sourceKarat}`);
  return (targetGrams * tP) / sP;
}

/**
 * Inverse: gegeben X Gramm sourceKarat → wieviel Gramm targetKarat ist das wert?
 *
 * Beispiel: 10g 24K (99.9%) bei Schuld in 21K (87.5%):
 *   targetEquivalent('24K', '21K', 10) === 10 * 0.999 / 0.875 ≈ 11.42g 21K-aequivalent
 */
export function targetEquivalent(sourceKarat: string, targetKarat: string, sourceGrams: number): number {
  const sP = purityOf(sourceKarat);
  const tP = purityOf(targetKarat);
  if (tP <= 0) throw new Error(`Invalid target karat: ${targetKarat}`);
  return (sourceGrams * sP) / tP;
}

/**
 * Pure-Gold-Equivalent (in 24K-Aequivalent). Nuetzlich fuer Aggregierte
 * Inventar-Berichte (z.B. Reconcile-Dashboard zeigt Gesamt-Pure-Au).
 */
export function pureGoldGrams(karat: string, grams: number): number {
  return grams * purityOf(karat);
}

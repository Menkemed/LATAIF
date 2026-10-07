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
// PURITY-METAL-DOMAIN — die Feinheiten stehen JE METALL, nicht mehr in einer gemeinsamen Liste.
// Vorher lagen Silber (999, 925) und Platin (950) in derselben Tabelle wie die Gold-Karate: jeder
// Gold-Ablauf nahm damit „925" als Gold an, und eine unbekannte Angabe wurde still mit 1,0 gerechnet.
// Jetzt: Gold kennt nur Karate (24K = 0,999 — dieselbe Zahl, mit der Ausgleich, Reparatur und Auftrag
// schon immer rechneten), Silber 999/925, Platin 950/999. Eine fremde Angabe ist kein Gold — kein 1,0.
// ═══════════════════════════════════════════════════════════

export type PurityMetal = 'gold' | 'silver' | 'platinum';

/** Gold-Karate (die Reihenfolge ist die der Masken). */
export const GOLD_PURITY: Readonly<Record<string, number>> = {
  '24K': 0.999,
  '22K': 0.916,
  '21K': 0.875,
  '18K': 0.750,
  '14K': 0.585,
  '9K':  0.375,
};

/** Silberfeinheiten. */
export const SILVER_PURITY: Readonly<Record<string, number>> = {
  '999': 0.999,  // Feinsilber
  '925': 0.925,  // Sterling
};

/** Platinfeinheiten. */
export const PLATINUM_PURITY: Readonly<Record<string, number>> = {
  '950': 0.950,
  '999': 0.999,
};

export const METAL_PURITIES: Readonly<Record<PurityMetal, Readonly<Record<string, number>>>> = {
  gold: GOLD_PURITY,
  silver: SILVER_PURITY,
  platinum: PLATINUM_PURITY,
};

/**
 * Die Angaben je Metall in der Reihenfolge der Masken. Ausdrücklich, weil JavaScript Schlüssel wie
 * „999"/„925" als Zahlen sortiert (`Object.keys` gäbe 925 vor 999).
 */
export const METAL_GRADES: Readonly<Record<PurityMetal, readonly string[]>> = {
  gold: ['24K', '22K', '21K', '18K', '14K', '9K'],
  silver: ['999', '925'],
  platinum: ['950', '999'],
};

/**
 * Die Gold-Karate — der Name bleibt (Gold-Ausgleich, Reparatur-Maske), die Liste enthält jetzt NUR Gold.
 * Silber-/Platinfeinheiten stehen in `METAL_PURITIES`.
 */
export const KARAT_PURITY: Readonly<Record<string, number>> = GOLD_PURITY;

const own = (map: Readonly<Record<string, number>>, k: unknown): k is string =>
  typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k);

/** Feinheit einer Angabe IM Kontext ihres Metalls; `null`, wenn sie dort nicht vorkommt. */
export function metalPurity(metal: string | null | undefined, fineness: string | null | undefined): number | null {
  const map = METAL_PURITIES[metal as PurityMetal];
  return map && own(map, fineness) ? map[fineness] : null;
}

/** Feinheit eines Gold-Karats; `null` für alles andere (Silber-/Platinfeinheit, Tippfehler). Kein stilles 1,0. */
export function goldPurity(karat: string | null | undefined): number | null {
  return own(GOLD_PURITY, karat) ? GOLD_PURITY[karat] : null;
}

/**
 * Reinheit-Faktor eines Gold-Karats für Rechnungen, die eine Zahl brauchen. Ein Wert, der kein Gold-
 * Karat ist, ist ein Fehler — vorher lieferte er still 1,0 (Silber 925 rechnete als Feingold).
 */
export function purityOf(karat: string): number {
  const p = goldPurity(karat);
  if (p === null) throw new Error(`not a gold karat: ${String(karat)} (gold: ${Object.keys(GOLD_PURITY).join(', ')})`);
  return p;
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
  return (sourceGrams * sP) / tP;
}

/**
 * Pure-Gold-Equivalent (in 24K-Aequivalent). Nuetzlich fuer Aggregierte
 * Inventar-Berichte (z.B. Reconcile-Dashboard zeigt Gesamt-Pure-Au).
 */
export function pureGoldGrams(karat: string, grams: number): number {
  return grams * purityOf(karat);
}

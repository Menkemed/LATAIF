// LOT-VAT-COST — der Einstand eines Loses ist GENAU das, was auf INVENTORY aktiviert wurde.
//
// Bis hierher trug ein Einkaufslos den Bruttopreis (inkl. Vorsteuer), während die Einkaufsbuchung
// netto auf INVENTORY und die Vorsteuer auf VAT_INPUT buchte. Der Wareneinsatz zog dann den
// Bruttopreis aus INVENTORY ab — die Vorsteuer wurde doppelt entlastet und INVENTORY lief ins Minus.
//
// Eine Regel für beide Seiten, datenbankfrei: die Einkaufsbuchung (`postPurchaseReceived`) und die
// Los-Anlage (`createPurchase`) rechnen dieselbe gerundete Zahl. Ohne Vorsteuer (`ZERO`) bleibt der
// Einstand unverändert der Stückpreis.

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Was die Einkaufsbuchung je Zeile auf INVENTORY bucht: Brutto − Vorsteuer, beide auf Fils gerundet. */
export function capitalizedLineCost(lineTotal: number, vatAmount: number | null | undefined): number {
  return round3(round3(lineTotal) - round3(vatAmount ?? 0));
}

/**
 * Einstand je Einheit eines Einkaufsloses. Mit Vorsteuer: aktivierter Zeilenwert ÷ Menge — ungerundet,
 * damit Menge × Einstand den aktivierten Wert trifft. Ohne Vorsteuer: der Stückpreis, wie bisher.
 */
export function purchaseLotUnitCost(line: { qty: number; unitPrice: number; lineTotal: number; vatAmount?: number | null }): number {
  if (!(round3(line.vatAmount ?? 0) > 0) || !(line.qty > 0)) return line.unitPrice;
  return capitalizedLineCost(line.lineTotal, line.vatAmount) / line.qty;
}

/**
 * Die Kostenbasis eines Artikels für eine Umbuchung zwischen Losen (Production): hat er aktive Lose,
 * deren Restwert (Σ Restmenge × Einstand) — das ist, was INVENTORY für ihn hält; sonst, wie bisher,
 * sein Einkaufspreis (Artikel ohne Los: Collection-/Handy-Anlage).
 */
export function inventoryCostBasis(purchasePrice: number, activeLotValue: number | null | undefined): number {
  return activeLotValue === null || activeLotValue === undefined ? (Number(purchasePrice) || 0) : activeLotValue;
}

// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Bulk-Zeile eines Einkaufs (Spec 6.2/6.3). Rein, ohne Datenbank: dieselbe
// Prüfung für Maske, Primary und Fernbefehl. Gewicht in mg, Betrag in Fils — beides ganze Zahlen.
// ════════════════════════════════════════════════════════════════════════════
import {
  BulkRejected, assertFils, assertSaleTaxScheme, assertWeightMg, checkComposition, filsToBhd, formatMg, vatFilsOfGross,
  type BulkSaleTaxScheme, type CompositionEntry,
} from './bulk-math';
import { METAL_LABEL, assertBulkMetal, type BulkMetal } from './bulk-product';

/** Was die Maske für eine Bulk-Zeile schickt. */
export interface BulkPurchaseLineInput {
  metal: string;
  fineness: string;
  weightMg: number;
  /** Zeilenbetrag in Fils — wie jede Einkaufszeile brutto bei VAT_10. */
  lineTotalFils: number;
  saleTaxScheme: string;
  composition?: unknown;
}

/** Die geprüfte Bulk-Zeile. */
export interface BulkPurchaseLine {
  metal: BulkMetal;
  fineness: string;
  weightMg: number;
  lineTotalFils: number;
  saleTaxScheme: BulkSaleTaxScheme;
  composition: CompositionEntry[];
}

export function checkBulkPurchaseLine(raw: unknown): BulkPurchaseLine {
  if (!raw || typeof raw !== 'object') throw new BulkRejected('BULK_LINE_INVALID', 'a bulk line needs metal, fineness, weight, cost and sale tax scheme');
  const r = raw as Record<string, unknown>;
  const { metal, fineness } = assertBulkMetal(r.metal, r.fineness);
  const weightMg = assertWeightMg(r.weightMg, 'total weight');
  const lineTotalFils = assertFils(r.lineTotalFils, 'total cost');
  const saleTaxScheme = assertSaleTaxScheme(r.saleTaxScheme);
  const composition = checkComposition(r.composition, weightMg);
  return { metal, fineness, weightMg, lineTotalFils, saleTaxScheme, composition };
}

/** Vorschlag der Verkaufs-Steuerart aus der Einkaufs-Steuerart (ZERO → MARGIN, VAT_10 → VAT_10). */
export function suggestedSaleTaxScheme(purchaseTaxScheme: string): BulkSaleTaxScheme {
  return purchaseTaxScheme === 'VAT_10' ? 'VAT_10' : 'MARGIN';
}

/** Zeilenwerte wie die Bücher sie sehen (4.5): Vorsteuer in Fils, aktivierter Lot-Wert = Betrag − Vorsteuer. */
export function bulkPurchaseAmounts(lineTotalFils: number, vatRatePct: number): { vatFils: number; lotValueFils: number; lineTotal: number; vatAmount: number } {
  const vatFils = vatFilsOfGross(lineTotalFils, vatRatePct);
  return { vatFils, lotValueFils: lineTotalFils - vatFils, lineTotal: filsToBhd(lineTotalFils), vatAmount: filsToBhd(vatFils) };
}

export function bulkPurchaseDescription(metal: BulkMetal, fineness: string, weightMg: number): string {
  return `${METAL_LABEL[metal]} ${fineness} · ${formatMg(weightMg)} g (bulk)`;
}

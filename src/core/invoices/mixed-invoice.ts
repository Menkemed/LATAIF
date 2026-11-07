// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P3 — die gemischte Rechnung: eigene Lagerware UND Kommissionsartikel auf EINER Kundenrechnung.
//
// Rein, ohne Datenbank: dieselben Regeln für die Maske (Primary und PC2), die Hausfolge und den Fernrumpf.
// Gebucht wird über die vorhandene Folge des Kommissionsverkaufs (`recordSales`: Ökonomie, Boden-Bestätigung,
// Käufer ≠ Einlieferer, ein Einkauf je Einlieferer, Verlust-Ausgabe, Kommissionsstatus), erweitert um die eigenen
// Zeilen in DERSELBEN Rechnung (`createInvoiceInHouse`). Kommissionsware ist dort nur für genau die gewählten
// Kommissionsartikel erlaubt; eigene Zeilen laufen nach den Regeln von „Save Invoice".
//
// Owner-Regeln (Plan §1): Anlegen nur ADMIN/MANAGER (E13, `mixed-invoice-permission`). E7 — die Provision kommt
// vom Brutto vor VAT, die VAT trägt LATAIF; macht VAT 10 % das LATAIF-Ergebnis einer Kommissionszeile negativ,
// bestätigt der Mensch das ausdrücklich je Zeile. Eine Kommission = ein Stück (E12 folgt in P5). Kein Rabatt (E1).
// ════════════════════════════════════════════════════════════════════════════
import { vatEngine } from '@/core/tax/vat-engine';
import type { ConsignmentSaleResult } from '@/core/consignment/economics';
import type { ConsignmentSaleItemInput } from '@/core/consignment/consignment-finance';
import type { InvoiceCreateLine, InvoiceCreatePayment } from './invoice-create-house';

/** E7 — Kommissionszeile mit VAT 10 % und negativem LATAIF-Ergebnis ohne ausdrückliche Bestätigung. */
export const VAT_SHORTFALL_UNCONFIRMED = 'VAT_SHORTFALL_UNCONFIRMED';
/** Eine gemischte Rechnung braucht mindestens einen Kommissionsartikel (sonst ist es eine gewöhnliche Rechnung). */
export const MIXED_INVOICE_NEEDS_CONSIGNMENT = 'MIXED_INVOICE_NEEDS_CONSIGNMENT';
/** Eine eigene Zeile darf keine Kommissionsware sein — die läuft nur als Kommissionsartikel über ihre Kommission. */
export const OWN_LINE_IS_CONSIGNMENT = 'OWN_LINE_IS_CONSIGNMENT';
/** E3 (Owner) — kein Rechnungsdatum vor der Einlieferung des Kommissionsartikels. */
export const SALE_BEFORE_CONSIGNMENT = 'SALE_BEFORE_CONSIGNMENT';

export type SaleScheme = 'MARGIN' | 'VAT_10' | 'ZERO';

/**
 * Die Beträge der Rechnungszeile eines Kommissionsartikels — GENAU die Rechnung des Verkaufs („Record Sale"):
 * der Verkaufspreis ist der Kundenpreis inkl. VAT; bei VAT 10 % wird das Netto daraus zurückgerechnet, bei Margin
 * die Margen-VAT aus Preis und Einkaufspreis des Artikels (sonst Auszahlung, G4 unverändert).
 */
export function consignmentLineAmounts(salePrice: number, scheme: SaleScheme, purchasePrice: number) {
  const rate = scheme === 'ZERO' ? 0 : 10;
  const netInput = scheme === 'VAT_10' ? salePrice / (1 + rate / 100) : salePrice;
  const calc = vatEngine.calculateNet(netInput, purchasePrice, scheme, rate);
  // v0.7.1 — NBR: MARGIN persistiert die interne VAT; VAT 10 % die VAT der Zeile.
  const persistedVat = calc.internalVatAmount ?? calc.vatAmount;
  return { rate, calc, persistedVat };
}

/**
 * E7 — das LATAIF-Ergebnis einer Kommissionszeile unter VAT 10 %: Provision (vom Brutto) minus die VAT, die LATAIF
 * trägt. Negativ ⇒ der Betrag (z. B. −45,455), sonst `null`. Ein Verkauf unter dem Boden des Einlieferers zählt hier
 * nicht: dessen Verlust bestätigt der Haken der Unterdeckung. Margin und Zero-rated: nie (Margin rechnet die VAT
 * aus der Provision, Zero hat keine).
 */
export function consignmentVatShortfall(
  econ: Pick<ConsignmentSaleResult, 'commission' | 'belowFloor'>, scheme: SaleScheme, vat: number,
): number | null {
  if (scheme !== 'VAT_10' || econ.belowFloor) return null;
  const result = Math.round((econ.commission - vat) * 1000) / 1000;
  return result < -0.0005 ? result : null;
}

/** Ein Kommissionsartikel der gemischten Rechnung: die Felder des Verkaufs samt E7-Bestätigung (`acknowledgeVatShortfall`). */
export type MixedConsignmentItem = ConsignmentSaleItemInput;

/** Die EINGABEN der gemischten Rechnung, wie die Maske „Direct Sale" sie am Primary schickt. */
export interface MixedInvoiceInput {
  customerId: string;
  /** Die eigenen Zeilen — dieselbe Form wie bei „Save Invoice" (auch Bulk). Darf leer sein. */
  ownLines: InvoiceCreateLine[];
  /** Die Kommissionsartikel — mindestens einer. */
  items: MixedConsignmentItem[];
  /** YYYY-MM-DD — zugleich der Verkaufstag der Kommissionen und das Datum der Einlieferer-Einkäufe. */
  issuedDate?: string;
  notes?: string;
  staffId?: string;
  specialMark: boolean;
  payments?: InvoiceCreatePayment[];
}

/**
 * Der Fernrumpf: `consignments.record_sale` mit `ownLines`. Die eigenen Zeilen reisen als ABSICHT (Artikel, Los,
 * Menge, Preis, Steuerart bzw. Bulk-Absicht — wie bei `invoices.create`); Einstand und Steuer rechnet der Primary.
 * Je Kommission die gesehene Fassung.
 */
export function mixedInvoiceBody(
  i: Omit<MixedInvoiceInput, 'ownLines'>,
  ownLines: ReadonlyArray<Record<string, unknown>>,
  revisions: Readonly<Record<string, number>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    items: i.items.map((it) => ({
      consignmentId: it.consignmentId, expectedRevision: revisions[it.consignmentId],
      salePrice: it.salePrice, acknowledgeShortfall: it.acknowledgeShortfall === true,
      ...(it.taxScheme ? { taxScheme: it.taxScheme } : {}),
      ...(it.consignorTaxScheme ? { consignorTaxScheme: it.consignorTaxScheme } : {}),
      ...(it.acknowledgeVatShortfall === true ? { acknowledgeVatShortfall: true } : {}),
    })),
    buyerId: i.customerId,
    specialMark: i.specialMark === true,
    ownLines: ownLines.map((l) => ({ ...l })),
  };
  if (i.issuedDate !== undefined) body.saleDate = i.issuedDate;
  if (i.notes !== undefined) body.notes = i.notes;
  if (i.staffId) body.staffId = i.staffId;
  if (i.payments && i.payments.length > 0) body.payments = i.payments.map((p) => ({ ...p }));
  return body;
}

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — Kommission verkaufen und auszahlen: EINE Vorbereitung für beide Seiten.
//
// „Record Sale" wählt mit dem Nummerndialog den Belegkreis der entstehenden Rechnung
// (`specialMark`); der Fernbefehl kannte das Feld nicht. „Pay Out Consignor" zahlt den OFFENEN Rest
// aus (markPaidOut, ohne Betrag); der Fernbefehl kannte nur den Teilbetrag. Jetzt schicken beide
// Masken ihre Eingaben, und das Haus (`consignment-finance-house`) entscheidet — am Primary wie fern.
// ════════════════════════════════════════════════════════════════════════════
import type { InvoiceCreatePayment } from '@/core/invoices/invoice-create-house';

/** Ein Nein der geteilten Regeln — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class ConsignmentActionRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ConsignmentActionRejected';
  }
}

/** Die Wege der Maske „Pay Out Consignor". */
export const CONSIGNMENT_PAYOUT_METHODS = ['bank_transfer', 'cash', 'card', 'benefit'] as const;
/** Was die Buchung annimmt: die Wege der Maske — und `bank`, die Schreibweise des C3G-Vertrags. */
export const ACCEPTED_PAYOUT_METHODS: readonly string[] = [...CONSIGNMENT_PAYOUT_METHODS, 'bank'];

/** Die EINGABEN von „Record Sale" samt der Wahl im Nummerndialog. */
export interface ConsignmentSaleInput {
  salePrice: number;
  buyerId: string;
  saleDate?: string;
  notes?: string;
  acknowledgeShortfall: boolean;
  specialMark: boolean;
}

/** CONSIGNMENT MULTI-SALE — ein Artikel des gemeinsamen Verkaufs (je Artikel Preis und ggf. die Bestätigung der Unterdeckung). */
export interface ConsignmentSaleItemInput {
  consignmentId: string;
  salePrice: number;
  acknowledgeShortfall: boolean;
}

/**
 * CONSIGNMENT MULTI-SALE — die EINGABEN des Verkaufsdialogs: ein oder mehrere Artikel (auch verschiedener
 * Einlieferer), EIN Käufer, EINE Rechnung, datiert auf den Verkaufstag (D1), optional mit Zahlungen (D5) —
 * dieselben Zahlungszeilen wie „Save Invoice".
 */
export interface ConsignmentMultiSaleInput {
  items: ConsignmentSaleItemInput[];
  buyerId: string;
  saleDate?: string;
  notes?: string;
  specialMark: boolean;
  payments?: InvoiceCreatePayment[];
}

/** So viele Artikel nimmt ein gemeinsamer Verkauf auf einmal an. */
export const MAX_SALE_ITEMS = 50;

/** Die EINGABEN einer Auszahlung an den Eigentümer. */
export interface ConsignmentPayoutInput {
  amount: number;
  method: string;
  reference?: string;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Was noch an den Eigentümer geht — die Maske zahlt genau das aus. */
export function payoutOpenAmount(c: { payoutAmount?: number | null; payoutPaidAmount?: number | null }): number {
  return Math.max(0, r3((c.payoutAmount || 0) - (c.payoutPaidAmount || 0)));
}

/** Der Rumpf von `consignments.record_sale`, wie ihn die Maske am zweiten Rechner baut. */
export function consignmentSaleBody(id: string, revision: number, i: ConsignmentSaleInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    consignmentId: id, expectedRevision: revision, buyerId: i.buyerId, salePrice: i.salePrice,
    acknowledgeShortfall: i.acknowledgeShortfall, specialMark: i.specialMark,
  };
  if (i.saleDate !== undefined) body.saleDate = i.saleDate;
  if (i.notes !== undefined) body.notes = i.notes;
  return body;
}

/**
 * CONSIGNMENT MULTI-SALE — der Rumpf von `consignments.record_sale` für einen gemeinsamen Verkauf: je Artikel die
 * gesehene Fassung (jede Kommission wird gegen IHRE Fassung geprüft), dazu Käufer, Tag, Nummernkreis, Zahlungen.
 */
export function consignmentSalesBody(i: ConsignmentMultiSaleInput, revisions: Readonly<Record<string, number>>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    items: i.items.map((it) => ({
      consignmentId: it.consignmentId, expectedRevision: revisions[it.consignmentId],
      salePrice: it.salePrice, acknowledgeShortfall: it.acknowledgeShortfall,
    })),
    buyerId: i.buyerId,
    specialMark: i.specialMark,
  };
  if (i.saleDate !== undefined) body.saleDate = i.saleDate;
  if (i.notes !== undefined) body.notes = i.notes;
  if (i.payments && i.payments.length > 0) body.payments = i.payments.map((p) => ({ ...p }));
  return body;
}

/** Der Rumpf von `consignments.record_payout` — ausdrücklich der Betrag, den die Maske gesehen hat. */
export function consignmentPayoutBody(id: string, revision: number, i: ConsignmentPayoutInput): Record<string, unknown> {
  const body: Record<string, unknown> = { consignmentId: id, expectedRevision: revision, amount: i.amount, method: i.method };
  if (i.reference !== undefined) body.reference = i.reference;
  return body;
}

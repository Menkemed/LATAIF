// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — Kommission verkaufen und auszahlen: EINE Vorbereitung für beide Seiten.
//
// „Record Sale" wählt mit dem Nummerndialog den Belegkreis der entstehenden Rechnung
// (`specialMark`); der Fernbefehl kannte das Feld nicht. „Pay Out Consignor" zahlt den OFFENEN Rest
// aus (markPaidOut, ohne Betrag); der Fernbefehl kannte nur den Teilbetrag. Jetzt schicken beide
// Masken ihre Eingaben, und das Haus (`consignment-finance-house`) entscheidet — am Primary wie fern.
// ════════════════════════════════════════════════════════════════════════════

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

/** Der Rumpf von `consignments.record_payout` — ausdrücklich der Betrag, den die Maske gesehen hat. */
export function consignmentPayoutBody(id: string, revision: number, i: ConsignmentPayoutInput): Record<string, unknown> {
  const body: Record<string, unknown> = { consignmentId: id, expectedRevision: revision, amount: i.amount, method: i.method };
  if (i.reference !== undefined) body.reference = i.reference;
  return body;
}

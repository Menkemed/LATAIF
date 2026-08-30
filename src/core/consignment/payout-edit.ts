// SSOT — darf das Payout-Modell eines BESTEHENDEN Consignments noch geaendert werden,
// und wie sieht der vollstaendige Feldsatz eines Modells aus?
//
// Warum eine eigene Datei: das Modell entscheidet, wie beim Verkauf Marge und Auszahlung
// gerechnet werden (`economics.ts`). Solange nichts gebucht ist, ist es eine reine Vereinbarung
// und darf korrigiert werden. Sobald daraus Zahlen entstanden sind — eine Rechnung, ein
// Consignor-Purchase, eine Auszahlung —, waeren dieselben Formeln mit anderen Parametern eine
// RUECKWIRKENDE Neuberechnung bereits gebuchter Betraege. Genau das ist verboten: das Modell
// wird dann gesperrt, statt still neu zu rechnen.
//
// Die Sperre leitet sich AUS DEN REALEN FELDERN ab, die diese Buchungen hinterlassen
// (`consignmentStore.recordSale` / `markPaidOut` / `recordPartialPayout` schreiben sie), nicht aus
// einer gepflegten Liste von Zustaenden. Fail-closed: was nicht zweifelsfrei unbenutzt ist, ist
// gesperrt.
import type { Consignment } from '@/core/models/types';
import { canonicalConsignmentStatus } from '@/core/models/types';
import { DEFAULT_COST_SPLIT_PCT } from './economics';

/** Die drei real unterstuetzten Modelle. Kein viertes wird hier erfunden. */
export const PAYOUT_MODELS = ['percent', 'consignor_fixed', 'cost_split'] as const;
export type PayoutModel = (typeof PAYOUT_MODELS)[number];

/** Legacy 'fixed' und Unbekanntes verhalten sich wie 'percent' — identisch zu `economics.normType`. */
export function normalizePayoutModel(t: unknown): PayoutModel {
  return t === 'consignor_fixed' || t === 'cost_split' ? t : 'percent';
}

export interface PayoutLock {
  /** true = das Modell darf NICHT mehr geaendert werden. */
  locked: boolean;
  /** Warum — als Satz fuer die Oberflaeche. `null`, wenn nicht gesperrt. */
  reason: string | null;
}

const NOT_EDITABLE = (why: string): PayoutLock => ({
  locked: true,
  reason: `The payout model can no longer be changed — ${why}. Changing it now would recalculate amounts that are already booked.`,
});

/** Ein Betrag, der wirklich gesetzt ist (0 zaehlt als gesetzt, nur leer/ungueltig nicht). */
const booked = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/**
 * Darf das Payout-Modell dieses Consignments noch geaendert werden?
 *
 * Gesperrt, sobald irgendetwas existiert, das aus dem Modell bereits Zahlen gemacht hat.
 * Die Reihenfolge ist die der Aussagekraft — die konkreteste Begruendung gewinnt.
 */
export function payoutModelLock(con: Consignment | null | undefined): PayoutLock {
  // Fail-closed: ohne Datensatz gibt es nichts zu erlauben.
  if (!con) return NOT_EDITABLE('the consignment could not be loaded');

  // Der Verkauf: Rechnung, Consignor-Purchase, ggf. Consignor-Loss-Expense und die Ledger-
  // Buchungen dazu haengen alle an genau diesen Feldern (`recordSale`).
  if (con.invoiceId) return NOT_EDITABLE('the item was sold and invoiced');
  if (booked(con.salePrice)) return NOT_EDITABLE('a sale is already recorded');
  if (booked(con.commissionAmount) || booked(con.payoutAmount)) {
    return NOT_EDITABLE('commission and payout have already been calculated');
  }

  // Das Geld: jede Auszahlung — auch eine Teilauszahlung — ist gebucht.
  if (booked(con.payoutPaidAmount) && (con.payoutPaidAmount as number) > 0) {
    return NOT_EDITABLE('a payout has already been made');
  }
  // NUR `partial` und `paid` bedeuten geflossenes Geld. `returned` setzt auch `markReturned` bei
  // einem Artikel, der NIE verkauft wurde — das ist ein Abschluss ohne jede Buchung.
  if (con.payoutStatus === 'partial' || con.payoutStatus === 'paid') {
    return NOT_EDITABLE(`the payout is already "${con.payoutStatus}"`);
  }

  // Der Lebenszyklus — aber nur der Teil, der wirklich einen Verkauf bedeutet.
  //
  // `expired` sieht nach Ende aus, ist aber eine reine Verwaltungsangelegenheit: der Tageslauf
  // setzt ihn allein wegen eines abgelaufenen Datums (`daily-sweep.ts`), ohne Verkauf, ohne
  // Rechnung, ohne Buchung — die Domaene selbst rechnet ihn deshalb zu IN_STOCK. Ein `returned`
  // wiederum entsteht auf ZWEI Wegen: mit vorherigem Verkauf (dann sperren bereits die Felder
  // oben) und ohne (dann gibt es nichts zu schuetzen). Deshalb sperrt hier ausschliesslich die
  // Verkaufs-Familie, und die wird in der Sprache der Domaene gefragt.
  if (canonicalConsignmentStatus(con.status) === 'SOLD') {
    return NOT_EDITABLE(`the consignment is "${con.status}"`);
  }

  return { locked: false, reason: null };
}

/**
 * DIESELBE Bedingung wie `payoutModelLock`, nur als SQL — und zwar fuer die WHERE-Klausel des
 * schreibenden UPDATE.
 *
 * Der Grund ist keine Redundanz, sondern der Zeitpunkt: eine Pruefung vor dem Schreiben beurteilt
 * einen Zustand, der beim Schreiben schon ein anderer sein kann (der Bildschirm stand offen,
 * waehrenddessen kam ein Verkauf oder eine Auszahlung — auch ueber den Sync von einem anderen
 * Geraet). Steht die Bedingung IM Update, entscheidet die Datenbank im selben Schritt, in dem sie
 * schreibt: passt sie nicht mehr, trifft das Update keine Zeile und es aendert sich nichts.
 *
 * Die Feldliste ist Zeile fuer Zeile dieselbe wie oben; der Test haelt beide gegeneinander.
 */
export const PAYOUT_EDITABLE_SQL = [
  'invoice_id IS NULL',
  'sale_price IS NULL',
  'commission_amount IS NULL',
  'payout_amount IS NULL',
  'COALESCE(payout_paid_amount, 0) <= 0',
  "COALESCE(payout_status, 'pending') NOT IN ('partial', 'paid')",
  // Wortgleich zu `canonicalConsignmentStatus(...) === 'SOLD'`: nur diese beiden Schreibweisen
  // (in jeder Gross-/Kleinschreibung) bedeuten einen Verkauf.
  "LOWER(COALESCE(status, '')) NOT IN ('sold', 'paid_out')",
].join(' AND ');

/** Die Spalten, die ein Payout-Patch IMMER vollstaendig setzt. */
export interface PayoutPatch {
  commissionType: PayoutModel;
  commissionRate: number;
  /** Nur fuer `cost_split` gesetzt, sonst ausdruecklich `null`. */
  excessSplitPct: number | null;
}

export interface PayoutInput {
  model: unknown;
  /** Prozentsatz fuer `percent`. */
  commissionRate?: unknown;
  /** Shop-Anteil am Gewinn fuer `cost_split`. */
  excessSplitPct?: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

export class PayoutPatchError extends Error {}

/**
 * Baut den VOLLSTAENDIGEN Feldsatz fuer ein Modell — inklusive der ausdruecklichen `null` fuer
 * alles, was zu einem ANDEREN Modell gehoert.
 *
 * Das ist der Kern der Atomaritaet: es gibt keinen Zustand "Modell A gespeichert, Parameter von
 * Modell B wirken noch". Wer auf `consignor_fixed` wechselt, verliert `excess_split_pct`; wer auf
 * `cost_split` wechselt, bekommt einen — und `commission_rate` bleibt in beiden Faellen als Zahl
 * erhalten, weil die Spalte `NOT NULL DEFAULT 15` ist und von `economics` bei diesen Modellen
 * ohnehin nicht gelesen wird.
 */
export function buildPayoutPatch(input: PayoutInput): PayoutPatch {
  const model = normalizePayoutModel(input.model);

  if (model === 'percent') {
    const rate = num(input.commissionRate);
    if (rate === null) throw new PayoutPatchError('Please enter a commission rate.');
    if (rate < 0 || rate > 100) throw new PayoutPatchError('The commission rate must be between 0 and 100.');
    return { commissionType: 'percent', commissionRate: rate, excessSplitPct: null };
  }

  if (model === 'cost_split') {
    const pct = num(input.excessSplitPct) ?? DEFAULT_COST_SPLIT_PCT;
    // 0 gaebe dem Shop nichts, 100 verhielte sich wie `consignor_fixed` — beides waere ein anderes
    // Modell unter falschem Namen (dieselbe Regel wie beim Anlegen).
    if (pct <= 0 || pct >= 100) {
      throw new PayoutPatchError("The shop's share must be between 1 and 99 percent.");
    }
    // Der Prozentsatz spielt hier keine Rolle mehr; die Spalte bleibt eine gueltige Zahl.
    return { commissionType: 'cost_split', commissionRate: num(input.commissionRate) ?? 0, excessSplitPct: pct };
  }

  return { commissionType: 'consignor_fixed', commissionRate: num(input.commissionRate) ?? 0, excessSplitPct: null };
}

/**
 * Wenn kein belastbarer historischer Wert existiert, wird die Marge OHNE Basis beschriftet —
 * lieber unbestimmt als mit einer Zahl, die zur Buchung nicht passt.
 */
export const HISTORICAL_MARGIN_LABEL = 'Our margin (above the agreed price at the time of sale)';

/**
 * Womit die Marge-Zeile eines BEREITS GEBUCHTEN Verkaufs beschriftet werden darf.
 *
 * Das Problem: die Beschriftung fuer `consignor_fixed` nennt den Agreed Price — und den liest sie
 * aus dem Datensatz, also aus dem HEUTIGEN Wert. Der Preis bleibt nach dem Verkauf aenderbar
 * (er ist danach nur noch eine Notiz), die Buchung daneben nicht. Damit koennte neben einer
 * gebuchten Marge eine Basis stehen, mit der nie gerechnet wurde.
 *
 * Die Loesung braucht keine neue Formel und keine Migration: bei `consignor_fixed` IST die
 * ausgezahlte Summe der damalige Agreed Price (`economics`: `payout = agreed`, auch beim
 * Fehlbetrag). Dieser Wert ist mit dem Verkauf eingefroren. Er wird eingesetzt, und die
 * bestehende zentrale Beschriftung rechnet unveraendert weiter.
 *
 * Rueckgabe `null` heisst: nimm `HISTORICAL_MARGIN_LABEL`.
 */
export function bookedCommissionInput<T extends Consignment>(con: T): T | null {
  // Nichts gebucht → der heutige Stand IST die Wahrheit, es gibt nichts einzufrieren.
  if (!payoutModelLock(con).locked) return con;
  // Nur diese eine Beschriftung nennt ueberhaupt einen Preis; Rate und Split gehoeren zum Modell
  // und sind bei einem gebuchten Datensatz ohnehin gesperrt.
  if (normalizePayoutModel(con.commissionType) !== 'consignor_fixed') return con;
  const frozen = con.payoutAmount;
  if (typeof frozen !== 'number' || !Number.isFinite(frozen)) return null;
  return { ...con, agreedPrice: frozen };
}

/** Die Felder, die die Oberflaeche fuer ein Modell anzeigen muss — Anlegen wie Bearbeiten. */
export function payoutFieldsFor(model: unknown): { rate: boolean; split: boolean } {
  const m = normalizePayoutModel(model);
  return { rate: m === 'percent', split: m === 'cost_split' };
}

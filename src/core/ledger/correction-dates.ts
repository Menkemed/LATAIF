// ════════════════════════════════════════════════════════════════════════════
// MIXED-INVOICE P1b (E11 / W1 / O1 / O2) — darf eine Korrektur auf DIESE Tage buchen?
//
// Seit P1b bucht eine Korrektur periodengerecht: die Gegenbuchung auf den Tag ihres Originals, die
// Neubuchung auf den fachlich richtigen Tag (Rechnungsdatum, Zahlungstag). Damit entstehen Buchungen in
// der Vergangenheit — und die sind nur erlaubt, wo die Vergangenheit noch offen ist:
//   • O1 — nicht vor dem Eröffnungsstichtag (`OPENING_CUTOFF_DATE`, die eine Owner-Konstante in
//          `parties/opening-balances.ts`; hier nur gelesen, kein zweites Datum);
//   • O2 — nicht in einem VAT-Quartal, das eingereicht oder schon bezahlt ist (`closedVatQuarters`,
//          dieselbe Quartalsregel wie der NBR-Export), auch wenn die Rechnung dort noch nicht exportiert ist.
// Ein Tag zählt als Kalendertag in Ortszeit — wie Stichtagsliste und NBR-Export.
// ════════════════════════════════════════════════════════════════════════════
import { closedVatQuarters, nbrQuarterOfDate, VatPeriodFiled } from '@/core/tax/vat-period-lock';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';

export const CORRECTION_BEFORE_OPENING_CUTOFF = 'CORRECTION_BEFORE_OPENING_CUTOFF';

/**
 * Nur für Node-Tests: Regressionstests anderer Regeln (VAT-Sperre, Kundenwechsel), deren Szenarien in Quartalen
 * VOR der Eröffnung spielen, setzen hier einen früheren Stichtag. `null` = die Owner-Konstante. Der O1-Test prüft
 * mit der echten Konstante.
 *
 * In der App ist der Schalter TOT: dort setzt Vite `import.meta.env` (dev wie prod, beim Bauen ersetzt) — dann wirft
 * das Setzen, und gelesen wird immer die Owner-Konstante, auch wenn irgendetwas den Wert verändert hätte. Nur der
 * Node-Testlauf (ohne Vite) hat kein `import.meta.env`.
 */
const nurNodeTest = (): boolean => typeof import.meta.env === 'undefined';
let cutoffForTest: string | null = null;
export function setOpeningCutoffForTest(day: string | null): void {
  if (!nurNodeTest()) throw new Error('setOpeningCutoffForTest is only available in node tests — the opening cut-off is fixed in the app.');
  cutoffForTest = day;
}
const openingCutoff = (): string => (nurNodeTest() && cutoffForTest !== null ? cutoffForTest : OPENING_CUTOFF_DATE);
/** Der gültige Eröffnungsstichtag (in der App immer die Owner-Konstante) — auch für einen gewählten Zahlungstag. */
export function openingCutoffDay(): string { return openingCutoff(); }

export interface CorrectionDate {
  /** Der Buchungszeitpunkt (ISO), den die Korrektur schreiben würde. */
  iso: string;
  /** Wofür — für den Satz an den Menschen (z. B. „the invoice", „a payment"). */
  what: string;
}

/** Der Kalendertag in Ortszeit (JJJJ-MM-TT) — dieselbe Kalenderlogik wie `nbrQuarterOfDate`. */
function localDay(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Warum diese Buchungstage nicht gehen — oder null. Rein lesend, vor jedem Schreiben. */
export function correctionDateIssue(branchId: string, dates: ReadonlyArray<CorrectionDate>): InvoiceActionRejected | null {
  const closed = closedVatQuarters(branchId);
  for (const d of dates) {
    const day = localDay(d.iso);
    if (!day) continue;
    const cutoff = openingCutoff();
    if (day < cutoff) {
      return new InvoiceActionRejected(CORRECTION_BEFORE_OPENING_CUTOFF,
        `This correction would book ${d.what} on ${day}, before the opening cut-off (${cutoff}). `
        + 'Bookings before the opening are not changed afterwards. Nothing was changed.');
    }
    const q = nbrQuarterOfDate(d.iso);
    const c = q ? closed.get(q.key) : undefined;
    if (q && c) {
      const [y, n] = q.key.split('-Q');
      return new VatPeriodFiled(
        `The VAT return for Q${n}/${y} is already ${c.filedAt ? 'filed' : 'paid'} — this correction would book ${d.what} on ${day} `
        + 'in that quarter. Nothing was changed.');
    }
  }
  return null;
}

/** Wirft, wenn eine Korrektur auf einen dieser Tage buchen würde, der vor der Eröffnung oder in einem zugemachten Quartal liegt. */
export function assertCorrectionDates(branchId: string, dates: ReadonlyArray<CorrectionDate>): void {
  const issue = correctionDateIssue(branchId, dates);
  if (issue) throw issue;
}

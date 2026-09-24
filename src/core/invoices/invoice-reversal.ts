// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — eine Rechnung SICHER umkehren, ohne sie zu löschen.
//
// Bisher gab es für „diese Rechnung soll es wirtschaftlich nicht mehr geben" zwei Wege: das harte
// Löschen (`deleteInvoice` — Zeilen, Zahlungen und der Beleg selbst verschwinden; nur am Primary,
// nur für den Owner) und den Status CANCELLED über `updateInvoice`. „Umwandlung rückgängig" am
// Agenten-Transfer nahm den ERSTEN — ein Geschäftsbeleg mit vergebener Nummer war danach fort.
//
// Diese Grundlage nimmt den ZWEITEN, und nur ihn: `updateInvoice(id, { status: 'CANCELLED' })`
// trägt schon alles, was eine Stornierung ausmacht — Lose zurück und Reservierung gelöst,
// Buchung der Rechnung storniert, Zahlungen storniert, Auto-Ausgaben storniert, Angebot und
// Auftrag freigegeben, Guthaben-Sperren. Der Beleg bleibt mit Nummer und Zeilen als CANCELLED stehen.
// Neu ist nur, was eine HAUSFOLGE braucht: die Rechnung aus der DATENBANK, in der Filiale des
// Auftrags; eine Buchung, die dort nur protokolliert scheitert (`safePost`), bricht hier die ganze
// Handlung ab (`watchLedgerPosts`); und ein Nein ist ein `InvoiceActionRejected` mit festem Code.
//
// Läuft INNERHALB der Transaktion des Aufrufers — öffnet, schließt und rollt nie selbst zurück.
//
// Wiederverwendbar gedacht: die Umwandlung eines Agenten-Transfers nutzt sie (R6E); der Verkaufs-
// storno einer Kommission (`consignmentStore.cancelSale`) storniert seine Käuferrechnung auf
// demselben Weg und kann sie mit eigener Statusregel übernehmen (R6F — hier NICHT gebaut).
// `invoices.cancel` (R5F.1) bleibt bei seinem eigenen letzten Schritt: dort legt die eigene Retoure
// die Rechnung eventuell auf RETURNED, was die Statusregel dieser Grundlage bewusst ablehnt.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { InvoiceActionRejected, invoiceCancelBlocker } from './invoice-cancel';
import { assertInvoiceNotInClosedVatQuarter } from '@/core/tax/vat-period-lock';

/** Ein Nein mit Code und Worten — der Aufrufer nennt, was SEINE Maske dazu sagt. */
export interface ReversalVerdict { code: string; message: string }

export interface InvoiceReversalOptions {
  /**
   * Welche Status umkehrbar sind. Ohne Angabe die Regel der Maske „Cancel Invoice"
   * (`invoiceCancelBlocker`: nicht storniert, nicht endgültig bezahlt, nicht zurückgegeben).
   */
  statusRule?: (status: string) => ReversalVerdict | null;
  /** Kein erhaltenes Geld — sonst stünde eine Erstattung aus, die diese Folge nicht bucht. */
  requireUnpaid?: ReversalVerdict;
  /**
   * Keine Retoure und keine Gutschrift an der Rechnung — dieselben zwei Zählungen wie der Guard B
   * von `editInvoice`: dann trägt die Rechnung ihre Zeilen-Buchung nicht mehr unberührt, und
   * `updateInvoice` überspränge Buchungsstorno und Lose (M-04).
   */
  requireNoReturns?: ReversalVerdict;
  /** Der letzte Wächter vor dem ersten Schreiben (fern: die gesehene Fassung). */
  beforeWrite?: () => void;
}

export interface InvoiceReversed {
  invoiceId: string;
  previousStatus: string;
  status: 'CANCELLED';
}

/** Die Urteile, die `updateInvoice` beim Storno wirklich fällt — als Liste, nicht als „klingt fachlich". */
const VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/store credit[\s\S]*used/i, 'INVOICE_CREDIT_USED'],
];

function alsUrteil(e: unknown): never {
  if (e instanceof InvoiceActionRejected) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  for (const [pattern, code] of VERDICTS) if (pattern.test(msg)) throw new InvoiceActionRejected(code, msg);
  throw e;
}

/**
 * Die Rechnung wird CANCELLED — mit allen Umkehrungen des Hauses, ohne Löschen. Wirft, statt halb
 * zu schreiben; der Aufrufer (`runOnPrimary` / `runRemoteCommand`) nimmt dann alles zurück.
 */
export function reverseInvoiceInHouse(invoiceId: string, branchId: string, opts: InvoiceReversalOptions = {}): InvoiceReversed {
  const inv = query('SELECT id, status, paid_amount FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0];
  if (!inv) throw new InvoiceActionRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  const previousStatus = String(inv.status ?? '');
  if (previousStatus === 'CANCELLED') {
    throw new InvoiceActionRejected('INVOICE_CANCELLED', 'this invoice is already cancelled');
  }
  // VAT-PERIOD-LOCK — eine gemeldete Rechnung wird nicht aus einem eingereichten Quartal storniert.
  assertInvoiceNotInClosedVatQuarter(invoiceId);
  if (opts.requireUnpaid && Number(inv.paid_amount ?? 0) > 0.005) {
    throw new InvoiceActionRejected(opts.requireUnpaid.code, opts.requireUnpaid.message);
  }
  if (opts.requireNoReturns) {
    const retouren = Number(query(
      `SELECT COUNT(*) AS c FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED'`, [invoiceId],
    )[0]?.c ?? 0);
    // R6E-CN — nur wirksame Gutschriften; eine stornierte hat keine Wirkung mehr (ihre Retoure ist REJECTED).
    const gutschriften = Number(query(
      `SELECT COUNT(*) AS c FROM credit_notes WHERE invoice_id = ? AND status != 'CANCELLED'`, [invoiceId],
    )[0]?.c ?? 0);
    if (retouren > 0 || gutschriften > 0) {
      throw new InvoiceActionRejected(opts.requireNoReturns.code, opts.requireNoReturns.message);
    }
  }
  const blocker = (opts.statusRule ?? invoiceCancelBlocker)(previousStatus);
  if (blocker) throw new InvoiceActionRejected(blocker.code, blocker.message);
  opts.beforeWrite?.();

  const buchung = watchLedgerPosts('invoice reversal');
  try {
    // Der Store schlägt die Rechnung beim Storno nicht in seiner Liste nach, liest danach aber neu —
    // frisch geladen, damit die Seite den Stand der Datenbank zeigt.
    useInvoiceStore.getState().loadInvoices();
    useInvoiceStore.getState().updateInvoice(invoiceId, { status: 'CANCELLED' });
  } catch (e) {
    alsUrteil(e);
  }
  buchung();
  const after = String(query('SELECT status FROM invoices WHERE id = ?', [invoiceId])[0]?.status ?? '');
  if (after !== 'CANCELLED') {
    throw new Error(`invoice reversal: ${invoiceId} did not become CANCELLED (it is ${after || 'gone'})`);
  }
  return { invoiceId, previousStatus, status: 'CANCELLED' };
}

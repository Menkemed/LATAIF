// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5F — die Retoure am Haus: dieselben Regeln, EINE Klammer.
//
// „Confirm Return & Refund" schrieb am Primary die Retoure (Kopf, Zeilen, Warenfolge, Wareneinsatz)
// und DANACH, getrennt, die sofortige Erstattung (Genehmigung mit Gutschrift, Deckel, Auszahlung,
// Buchung). Jetzt:
//
//   • `createReturnInHouse` — die EINE Folge, die der Fernbefehl innerhalb seiner Transaktion ruft;
//   • `createReturnOnPrimary` — dieselbe Folge für die Maske des Primary, exklusiv, in EINER Transaktion.
//
// Keine Rückgabe- oder Steuerlogik wird hier nachgebaut: `createReturn` und `refundReturn` des
// Stores tragen Mengendeckel, Warenfolge, Wareneinsatz, Gutschrift, Guthaben und Kartengebühr.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import { watchLedgerPosts } from '@/core/ledger/posting';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import { useCustomerStore } from '@/stores/customerStore';
import { returnLineAmounts } from './return-lines';
import {
  CONSIGNMENT_DISPOSITIONS, ReturnActionRejected, assertReturnCreateValues, refundsImmediately,
  type ReturnCreateInput,
} from './return-create';

/** Die Urteile, die die Store-Funktionen wirklich fällen — als Liste, nicht als „klingt fachlich". */
const VERDICTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/exceeds remaining/i, 'RETURN_QUANTITY_EXCEEDED'],
  [/at least one line/i, 'RETURN_NO_LINES'],
  [/must be a non-negative number|must be non-negative/i, 'RETURN_INVALID_QUANTITY'],
  [/settled as store credit/i, 'REFUND_IS_STORE_CREDIT'],
  [/Store credit can only be granted/i, 'REFUND_NOT_STORE_CREDIT'],
];

function alsUrteil(e: unknown): never {
  if (e instanceof ReturnActionRejected) throw e;
  const msg = e instanceof Error ? e.message : String(e);
  for (const [pattern, code] of VERDICTS) if (pattern.test(msg)) throw new ReturnActionRejected(code, msg);
  // Alles andere ist eine Störung, kein Urteil — die Handlung fällt zurück, nichts wird eingefroren.
  throw e;
}

const aktiverMitarbeiter = (id: string, branchId: string): boolean => !!query(
  "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
  [id, branchId],
)[0];

const istKommissionsware = (productId: string): boolean =>
  !!query("SELECT id FROM products WHERE id = ? AND source_type = 'CONSIGNMENT'", [productId])[0];

export interface ReturnCreated { returnId: string }

/**
 * „Confirm Return & Refund": die Retoure — und, wenn sofort erstattet wird, die Erstattung mit
 * Gutschrift und Buchung. EINE Folge; scheitert die Erstattung oder eine Buchung, gibt es auch die
 * Retoure nicht (vorher blieb sie ohne Erstattung stehen). `beforeWrite` ist der letzte Wächter vor
 * dem ersten Schreiben (fern: die gesehene Fassung).
 */
export function createReturnInHouse(input: ReturnCreateInput, branchId: string, beforeWrite?: () => void): ReturnCreated {
  assertReturnCreateValues(input);
  const inv = query('SELECT id, status FROM invoices WHERE id = ? AND branch_id = ?', [input.invoiceId, branchId])[0];
  if (!inv) throw new ReturnActionRejected('INVOICE_NOT_FOUND', 'no such invoice in this branch');
  const status = String(inv.status);
  if (status === 'CANCELLED') throw new ReturnActionRejected('INVOICE_CANCELLED', 'a cancelled invoice takes no return');
  // Die Maske bietet „Create Return" nur für eine endgültige oder teilbezahlte Rechnung an.
  if (status !== 'FINAL' && status !== 'PARTIAL') {
    throw new ReturnActionRejected('INVOICE_NOT_RETURNABLE', `a ${status.toLowerCase()} invoice takes no return — only a final or partly paid one`);
  }
  if (input.staffId && !aktiverMitarbeiter(input.staffId, branchId)) {
    throw new ReturnActionRejected('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');
  }
  // Preis und Steuer aus der RECHNUNG — dieselbe Ableitung wie die Maske (`returnLineAmounts`).
  const lines = input.lines.map((l) => {
    const src = query(
      'SELECT id, product_id, quantity, line_total, vat_amount FROM invoice_lines WHERE id = ? AND invoice_id = ?',
      [l.invoiceLineId, input.invoiceId],
    )[0];
    if (!src) throw new ReturnActionRejected('RETURN_LINE_NOT_ON_INVOICE', 'one of these lines does not belong to this invoice');
    const a = returnLineAmounts(
      { quantity: Number(src.quantity ?? 1), lineTotal: Number(src.line_total ?? 0), vatAmount: Number(src.vat_amount ?? 0) },
      l.quantity,
    );
    return {
      invoiceLineId: l.invoiceLineId,
      productId: String(src.product_id ?? '') || undefined,
      quantity: a.quantity,
      unitPrice: a.unitPrice,
      vatAmount: a.vatAmount,
    };
  });
  // „Return to Owner" / „Keep (→ OWN)" schreiben die Kommission und den Einstand um — die Maske
  // bietet sie nur an, wenn Kommissionsware unter den Zeilen ist.
  if (CONSIGNMENT_DISPOSITIONS.includes(input.productDisposition)
    && !lines.some((l) => !!l.productId && istKommissionsware(l.productId))) {
    throw new ReturnActionRejected('DISPOSITION_NOT_ALLOWED',
      'return to owner / keep as own is offered only when a consignment item comes back');
  }
  beforeWrite?.();

  const buchung = watchLedgerPosts('return');
  let returnId = '';
  try {
    const rs = useSalesReturnStore.getState();
    rs.loadReturns();
    returnId = rs.createReturn({
      invoiceId: input.invoiceId,
      refundMethod: input.refundMethod,
      productDisposition: input.productDisposition,
      reason: input.reason,
      notes: input.notes,
      staffId: input.staffId,
      lines,
    }).id;
    if (refundsImmediately(input)) {
      // Der Store schlägt die Retoure in SEINER Liste nach — frisch, sonst täte er still nichts.
      useSalesReturnStore.getState().loadReturns();
      useSalesReturnStore.getState().refundReturn(returnId);
    }
  } catch (e) {
    alsUrteil(e);
  }
  buchung();
  return { returnId };
}

/** Die Listen, die die Seite danach zeigt — auch nach einem Rollback. */
function frischLesen(): void {
  useSalesReturnStore.getState().loadReturns();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
  useCreditNoteStore.getState().loadCreditNotes();
  useCustomerStore.getState().loadCustomers();
}

/** „Confirm Return & Refund" am Primary. */
export function createReturnOnPrimary(input: ReturnCreateInput): Promise<ReturnCreated> {
  return runOnPrimary(() => createReturnInHouse(input, currentBranchId()), frischLesen);
}

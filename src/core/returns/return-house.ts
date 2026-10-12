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
// PARTNER-ITEMS — eine Retoure gemeinsam gekaufter Ware: zurück ins Lager oder abgeschrieben.
import { jointInvoiceLines, JOINT_BLOCK } from '@/core/partners/item-participation-house';
import {
  CONSIGNMENT_DISPOSITIONS, ReturnActionRejected, assertReturnCreateValues, refundsImmediately,
  type ReturnCreateInput,
} from './return-create';
// CONSIGNMENT-INTEGRITY F6 — „Return to Owner“ / „Keep“ einer verkauften Kommission laufen über DEN einen
// Kommissionsweg (Wareneinsatz zurück, Einkauf/Verlust beim Einlieferer storniert bzw. Einstand = Auszahlung,
// Kommission „returned“) — egal ob von der Rechnung oder von der Kommission aus angestoßen.
import { saleConsignmentOfLine } from '@/core/consignment/consignment-sale-link';
import { returnConsignmentAfterSaleInHouse } from '@/core/consignment/consignment-reversal-house';
import { ConsignmentActionRejected } from '@/core/consignment/consignment-finance';
import { ReturnCancelRejected } from './return-cancel-house';
import { InvoiceActionRejected } from '@/core/invoices/invoice-cancel';
import { PurchaseLifecycleRejected } from '@/core/purchases/purchase-lifecycle-house';

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
export function createReturnInHouse(
  input: ReturnCreateInput, branchId: string, beforeWrite?: () => void,
  // Nur der Kommissionsweg selbst: GENAU die Kommission dieses Verkaufs (kein Teil des Fernrumpfs).
  internal?: { consignmentId: string },
): ReturnCreated {
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
  // „Keep (→ OWN)" gilt JEDER Zeile der Retoure. Eigene Ware darauf bekäme ein neues Los zum Verkaufspreis
  // und diesen Preis als Einstand, ohne Wareneinsatz-Rückbuchung — also nur, wenn jede Zeile Kommissionsware ist.
  if (input.productDisposition === 'KEEP_AS_OWN' && lines.some((l) => !l.productId || !istKommissionsware(l.productId))) {
    throw new ReturnActionRejected('KEEP_ONLY_FOR_CONSIGNMENT',
      'keep as own applies to every returned line — use it only when all returned lines are consignment items');
  }
  // „Return to Owner" gilt ebenso JEDER Zeile. Eigene Ware darauf würde 'returned' (verlässt das System: kein Los
  // zurück, kein Wareneinsatz zurückgebucht, auch der Restbestand des Artikels gälte als weg) — also nur, wenn jede
  // Zeile Kommissionsware ist. Gemischt: erst die Kommissionszeilen „Return to Owner", die eigene Ware getrennt.
  if (input.productDisposition === 'RETURN_TO_OWNER' && lines.some((l) => !l.productId || !istKommissionsware(l.productId))) {
    throw new ReturnActionRejected('RETURN_TO_OWNER_ONLY_FOR_CONSIGNMENT',
      'return to owner applies to every returned line — use it only when all returned lines are consignment items');
  }
  if (input.productDisposition !== 'IN_STOCK' && input.productDisposition !== 'WRITE_OFF'
    && jointInvoiceLines(lines.map((l) => l.invoiceLineId)).length > 0) {
    throw new ReturnActionRejected(JOINT_BLOCK.code, JOINT_BLOCK.salesReturnDisposition);
  }
  // CONSIGNMENT-INTEGRITY F6 — von der Rechnung aus: derselbe Vertrag wie „Buyer Returns the Item“.
  if (CONSIGNMENT_DISPOSITIONS.includes(input.productDisposition) && !internal) {
    return viaConsignment(input, lines, branchId, beforeWrite);
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
      consignmentId: internal?.consignmentId,
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

/**
 * CONSIGNMENT-INTEGRITY F6 — „Return to Owner“ / „Keep“ von der Rechnung aus. Früher wirkten sie hier anders als
 * von der Kommission aus: kein Wareneinsatz zurück, Einkauf und Verlust beim Einlieferer blieben offen (Return to
 * Owner) bzw. das Los stand zum Verkaufspreis (Keep), und JEDE Kommission des Artikels wurde umgeschrieben.
 * Jetzt: die autoritativ zugeordnete Kommission (Rechnung + Artikel, genau eine) und dann DIESELBE Hausfolge wie
 * „Buyer Returns the Item“. Was diese Folge nicht ausdrücken kann, wird vor dem ersten Schreiben abgewiesen.
 */
function viaConsignment(
  input: ReturnCreateInput,
  lines: ReadonlyArray<{ invoiceLineId: string; quantity: number }>,
  branchId: string,
  beforeWrite?: () => void,
): ReturnCreated {
  const nein = (code: string, m: string): never => { throw new ReturnActionRejected(code, m); };
  if (lines.length !== 1) {
    nein('CONSIGNMENT_RETURN_ONE_ITEM', 'a consigned item comes back on its own — return it without other lines');
  }
  const link = saleConsignmentOfLine(lines[0].invoiceLineId, branchId);
  if (link.kind === 'ambiguous') {
    nein('CONSIGNMENT_RETURN_AMBIGUOUS', `this line belongs to ${link.count} consignments — nothing was changed`);
  }
  if (link.kind !== 'one') {
    return nein('CONSIGNMENT_RETURN_NOT_LINKED',
      'this sale is not linked to its consignment (it was not recorded with "Record Sale") — return to owner / keep as own are not possible here');
  }
  const rest = Number(query(
    `SELECT il.quantity - COALESCE((SELECT SUM(srl.quantity) FROM sales_return_lines srl JOIN sales_returns r ON r.id = srl.return_id
                                     WHERE srl.invoice_line_id = il.id AND r.status != 'REJECTED'), 0) AS rest
       FROM invoice_lines il WHERE il.id = ?`,
    [lines[0].invoiceLineId],
  )[0]?.rest ?? 0);
  if (Math.abs(lines[0].quantity - rest) > 0.005) {
    nein('CONSIGNMENT_RETURN_WHOLE_ITEM', 'a consigned item comes back as a whole — return the full remaining quantity');
  }
  if (!refundsImmediately(input)) {
    nein('CONSIGNMENT_RETURN_REFUNDS_NOW', 'a consigned item that comes back is refunded at once — choose "Refund now"');
  }
  beforeWrite?.();
  try {
    const out = returnConsignmentAfterSaleInHouse(link.id, {
      disposition: input.productDisposition as 'RETURN_TO_OWNER' | 'KEEP_AS_OWN',
      refundMethod: input.refundMethod,
      reason: input.reason,
      notes: input.notes,
      staffId: input.staffId,
    }, branchId);
    return { returnId: out.returnId };
  } catch (e) {
    // Ein fachliches Nein des Kommissionswegs bleibt ein fachliches Nein — am Primary wie fern (`returns.create`).
    if (e instanceof ConsignmentActionRejected || e instanceof ReturnCancelRejected
      || e instanceof InvoiceActionRejected || e instanceof PurchaseLifecycleRejected) {
      throw new ReturnActionRejected(e.code, e.message);
    }
    throw e;
  }
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

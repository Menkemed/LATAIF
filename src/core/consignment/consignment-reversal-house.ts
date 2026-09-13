// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6F — eine Kommission NACH dem Verkauf am Haus: „Post-Sale Return"
// (`consignments.return_after_sale`) und „Cancel Sale" (`consignments.cancel_sale`) — EINE Folge je
// Handlung für die Maske des Primary und für PC2.
//
// Was vorher geschah (auditiert, nicht angenommen) — `consignmentStore`:
//
//  markReturnedAfterSale
//   • baute eine ZWEITE Retourenlogik: Retoure direkt als REFUNDED eingefügt, Nummer `RET-<Uhrzeit>`
//     statt aus dem durablen Zähler, Gutschrift von Hand eingefügt und über `safePost` gebucht (verschluckt).
//   • Die Retoure nahm den NETTO-Stückpreis: bei VAT_10 buchte die Gutschrift Netto statt Brutto gegen die
//     Forderung — in Höhe der Steuer blieb eine Phantom-Forderung und Phantom-Umsatz stehen.
//   • Die Barerstattung stand im Hauptbuch, aber nie als `refund_paid_amount` an der Retoure; die Rechnung
//     wurde nie RETURNED und blieb in den offenen Posten.
//   • Der Wareneinsatz blieb gebucht: bei „Return to Owner" wurde danach der Einkauf storniert (INVENTORY
//     gutgeschrieben) — Lager im Hauptbuch negativ, COGS für einen Verkauf, den es nicht mehr gibt. Bei
//     „Keep" lag ein Los mit Einstand im Lager, das Hauptbuch hatte dafür keinen Bestand — beim
//     Wiederverkauf doppelter Wareneinsatz.
//   • Einkaufs- und Verluststorno liefen in einem try/catch, der den Fehler nur protokollierte.
//   • Keine Filiale, Liste statt Datenbank, stilles Nichts beim zweiten Aufruf, und fehlte die
//     Rechnungszeile, fiel er still auf die schlichte Rückgabe zurück (die Forderung blieb stehen).
//
//  cancelSale
//   • LÖSCHTE Gutschrift und Retoure hart (Steuerurkunde samt Nummer weg) — ohne Warenfolge, Steuer und
//     Los der Retoure zurückzudrehen (das „Keep"-Los blieb aktiv, ohne Einkauf dahinter).
//   • Stornierte die Rechnung direkt über `updateInvoice` — an der Grundlage `reverseInvoiceInHouse`
//     vorbei, mit verschluckten Buchungen.
//   • Vier Teilschritte (Retoure, Rechnung, Einkauf, Verlust) schluckten ihren Fehler: ein halber Storno
//     blieb stehen, und die Kommission stand trotzdem wieder auf „active".
//
// Jetzt: prüfen (aus der DATENBANK, in der Filiale des Auftrags, gegen die gesehene Fassung), dann die
// VORHANDENEN Folgen des Hauses — keine zweite Retouren- oder Rechnungslogik:
//   • die Retoure über `createReturnInHouse` (R5F: Anlegen, Freigabe mit Gutschrift, Erstattung);
//   • ihr Storno über `cancelReturnInHouse` (R6E: Gutschrift CANCELLED statt gelöscht, Retoure REJECTED);
//   • die Rechnung über `reverseInvoiceInHouse` (R6E: CANCELLED, Lose, Buchung, Zahlungen);
//   • der Auto-Einkauf über `cancelPurchaseInHouse` (R6F purchases), die Verlust-Ausgabe über ihren Storno.
// Alles INNERHALB der Transaktion des Aufrufers (`runOnPrimary` / `runRemoteCommand`): diese Datei öffnet,
// schließt und rollt nie selbst zurück. Sie importiert den Kommissions-Store NICHT — der ruft sie.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query, currentUserId } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { watchLedgerPosts, postSalesReturnCogs, hasLedgerEntries, reverseConsignmentPayouts } from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { trackUpdate } from '@/core/sync/track';
import { trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
import { eventBus } from '@/core/events/event-bus';
import { useAuthStore } from '@/stores/authStore';
import { useExpenseStore } from '@/stores/expenseStore';
import { createReturnInHouse } from '@/core/returns/return-house';
import { cancelReturnInHouse } from '@/core/returns/return-cancel-house';
import { reverseInvoiceInHouse } from '@/core/invoices/invoice-reversal';
import { cancelPurchaseInHouse } from '@/core/purchases/purchase-lifecycle-house';
import { ConsignmentActionRejected } from './consignment-finance';
import {
  CONSIGNMENT_PRIMARY_ONLY, DEFAULT_POST_SALE_REFUND_METHOD, POST_SALE_DISPOSITIONS, POST_SALE_REFUND_METHODS,
  cancelSaleBlocker, consignmentSaleInvoiceRule, postSaleReturnBlocker, postSaleReturnMarker,
  type ConsignmentReturnAfterSaleInput, type PostSaleDisposition,
} from './consignment-reversal';

const nein = (code: string, message: string): ConsignmentActionRejected => new ConsignmentActionRejected(code, message);

/** Ein Rechner ohne Bücher (PC2) schreibt NIE in eine lokale Datenbank — die Handlung geht zum Primary. */
function assertBooks(): void {
  if (isClientMode()) {
    throw nein(CONSIGNMENT_PRIMARY_ONLY, 'this happens on the main computer — this window has no business database');
  }
}

/** Die Kommission aus der DATENBANK, in DIESER Filiale, gegen die gesehene Fassung — vor jeder Regel. */
function liveConsignment(id: string, branchId: string, expectedRevision?: number): Record<string, unknown> {
  const con = query('SELECT * FROM consignments WHERE id = ? AND branch_id = ?', [id, branchId])[0];
  if (!con) throw nein('CONSIGNMENT_NOT_FOUND', 'no such consignment in this branch');
  if (expectedRevision !== undefined) {
    const jetzt = Number(con.revision ?? 0);
    if (jetzt !== expectedRevision) {
      throw nein('RECORD_CHANGED',
        `this consignment changed since you opened it (you saw ${expectedRevision}, it is now ${jetzt}) — reopen it`);
    }
  }
  return con;
}

/**
 * Der Auto-Einkauf beim Einlieferer, den `recordSale` anlegt. Sein Vermerk nennt die Kommissionsnummer
 * (dieselbe Suche wie bisher) — und seine Zeile den Artikel: ohne diese zweite Bedingung fände
 * „CON-…1" auch den Einkauf von „CON-…10". Nur in dieser Filiale, nur wirksame.
 */
function consignorPurchases(consignmentNumber: string, productId: string, branchId: string): string[] {
  if (!consignmentNumber || !productId) return [];
  return query(
    `SELECT p.id FROM purchases p
      WHERE p.branch_id = ? AND p.status != 'CANCELLED' AND p.notes LIKE ?
        AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.product_id = ?)
      ORDER BY p.created_at ASC, p.id ASC`,
    [branchId, `%${consignmentNumber}%`, productId],
  ).map((r) => String(r.id));
}

/** Die Verlust-Ausgabe (Verkauf unter dem Boden des Einlieferers), die `recordSale` anlegt. */
function consignorLosses(consignmentId: string, branchId: string): string[] {
  return query(
    `SELECT id FROM expenses
      WHERE branch_id = ? AND related_module = 'consignment' AND related_entity_id = ?
        AND category = 'ConsignorLoss' AND status != 'CANCELLED'
      ORDER BY created_at ASC, id ASC`,
    [branchId, consignmentId],
  ).map((r) => String(r.id));
}

/**
 * Die Verlust-Ausgabe über ihren VORHANDENEN Storno (`updateExpense` → CANCELLED: Zahlungen und
 * Aufwand strikt zurückgebucht, Guthaben zurück). Er schlägt die Ausgabe in SEINER Liste nach — frisch
 * geladen, sonst täte er still nichts. Danach wird nachgelesen, statt geglaubt.
 */
function cancelConsignorLoss(expenseId: string): void {
  useExpenseStore.getState().loadExpenses();
  useExpenseStore.getState().updateExpense(expenseId, { status: 'CANCELLED' });
  const st = String(query('SELECT status FROM expenses WHERE id = ?', [expenseId])[0]?.status ?? '');
  if (st !== 'CANCELLED') throw new Error(`consignor loss ${expenseId} did not become CANCELLED (it is ${st || 'gone'})`);
}

/** Wer die Handlung verantwortet: fern der geprüfte Absender, am Primary die Sitzung. */
export interface ConsignmentActor {
  userId: string;
  role: string | null | undefined;
}

/** Die Sitzung am Primary — Rolle wie bei „Cancel Return" (`useAuthStore`). */
export function localConsignmentActor(): ConsignmentActor {
  let role: string | undefined;
  try { role = useAuthStore.getState().role(); } catch { role = undefined; }
  return { userId: currentUserId(), role };
}

// ════════════════════════════════════════════════════════════════════════════
// „Post-Sale Return" — der Käufer bringt die Ware zurück
// ════════════════════════════════════════════════════════════════════════════

export interface ConsignmentReturnedAfterSale {
  consignmentId: string;
  status: 'returned';
  disposition: PostSaleDisposition;
  /** Altweg ohne Rechnung (`markSold`): die schlichte Rückgabe, ohne Retoure und ohne Buchung. */
  withoutInvoice: boolean;
  invoiceId: string;
  returnId: string;
  returnNumber: string;
  refundMethod: string;
  cancelledPurchases: number;
  cancelledLossExpenses: number;
}

/**
 * „Buyer Returns the Item": die Retoure über das Retourenhaus (Zeile der Kommissionsware in ihrer
 * Restmenge, Rechnungspreis brutto, sofort erstattet im gewählten Weg — unbezahlt ist das die
 * Forderungsstornierung), der Wareneinsatz zurück, dann je Weg:
 *   • „Return to Owner": die Ware geht an den Einlieferer; sein Auto-Einkauf und die Verlust-Ausgabe
 *     werden storniert (die Maske: „Our A/P to him gets cancelled … No inventory effect for us");
 *   • „Keep": die Ware wird eigener Bestand zum Einstand = Auszahlung an den Einlieferer (v0.7.11,
 *     derselbe Betrag wie die offen bleibende Verbindlichkeit); der Einkauf bleibt offen.
 * Die Kommission steht danach auf „returned" (die Maske bietet dann „Cancel Sale (cleanup)").
 */
export function returnConsignmentAfterSaleInHouse(
  id: string, input: ConsignmentReturnAfterSaleInput, branchId: string, expectedRevision?: number,
): ConsignmentReturnedAfterSale {
  assertBooks();
  const disposition = input.disposition;
  if (!(POST_SALE_DISPOSITIONS as readonly string[]).includes(disposition)) {
    throw nein('INVALID_INPUT', `unknown disposition: ${String(disposition)}`);
  }
  const refundMethod = input.refundMethod ?? DEFAULT_POST_SALE_REFUND_METHOD;
  if (!(POST_SALE_REFUND_METHODS as readonly string[]).includes(refundMethod)) {
    throw nein('INVALID_INPUT', `unknown refund method: ${String(refundMethod)}`);
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const con = liveConsignment(id, branchId, expectedRevision);
  const block = postSaleReturnBlocker(con.status);
  if (block) throw nein(block.code, block.message);
  const consignmentNumber = String(con.consignment_number ?? '');
  const productId = String(con.product_id ?? '');
  const invoiceId = String(con.invoice_id ?? '');
  const db = getDatabase();
  const now = new Date().toISOString();
  const vorher = { status: String(con.status ?? ''), payoutStatus: String(con.payout_status ?? ''), invoiceId };
  const protokoll = (neu: Record<string, unknown>): void => logAuditOrThrow({
    module: 'Commission', entityType: 'consignments', entityId: id, action: 'STATUS_CHANGE', field: 'return_after_sale',
    oldValue: vorher, newValue: neu, actor: { userId: currentUserId(), branchId },
  });

  // Altweg — ein Verkauf ohne Rechnung (`markSold`): wie bisher die schlichte Rückgabe (Artikel und
  // Kommission „returned"). Es gibt keinen Beleg, den eine Retoure umkehren könnte.
  if (!invoiceId) {
    db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, productId]);
    trackProductRow(productId);
    db.run(`UPDATE consignments SET status = 'returned', payout_status = 'returned', updated_at = ? WHERE id = ?`, [now, id]);
    trackUpdate('consignments', id, { status: 'returned', payoutStatus: 'returned' });
    protokoll({ status: 'returned', disposition, withoutInvoice: true });
    eventBus.emit('consignment.returned', 'consignment', id, {});
    return {
      consignmentId: id, status: 'returned', disposition, withoutInvoice: true, invoiceId: '', returnId: '', returnNumber: '',
      refundMethod, cancelledPurchases: 0, cancelledLossExpenses: 0,
    };
  }

  if (!query('SELECT id FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0]) {
    throw nein('INVOICE_NOT_FOUND', 'the invoice of this sale is not in this branch');
  }
  // Die Zeile der Kommissionsware — und was davon noch nicht zurück ist (dieselbe Zählung wie jede Retoure).
  const line = query(
    `SELECT il.id, il.quantity,
            COALESCE((SELECT SUM(srl.quantity) FROM sales_return_lines srl JOIN sales_returns r ON r.id = srl.return_id
                       WHERE srl.invoice_line_id = il.id AND r.status != 'REJECTED'), 0) AS zurueck
       FROM invoice_lines il WHERE il.invoice_id = ? AND il.product_id = ? ORDER BY il.rowid LIMIT 1`,
    [invoiceId, productId],
  )[0];
  // Vorher fiel der Store hier still auf die schlichte Rückgabe zurück — die Forderung blieb stehen.
  if (!line) throw nein('CONSIGNMENT_INVOICE_LINE_NOT_FOUND', 'the invoice of this sale has no line for the consigned item');
  const lineId = String(line.id);
  const rest = Number(line.quantity ?? 1) - Number(line.zurueck ?? 0);
  if (rest <= 0.005) throw nein('CONSIGNMENT_ALREADY_RETURNED', 'the consigned item on this invoice has already come back');
  const purchases = disposition === 'RETURN_TO_OWNER' ? consignorPurchases(consignmentNumber, productId, branchId) : [];
  const losses = disposition === 'RETURN_TO_OWNER' ? consignorLosses(id, branchId) : [];

  // 1. Die Retoure — über das Retourenhaus: Preis und Steuer aus der Rechnung, Gutschrift, Erstattung im
  //    gewählten Weg (nur was der Käufer bezahlt hat, fließt zurück), Warenfolge, Nummer aus dem Zähler.
  //    Der Vermerk ist derselbe wie bisher — an ihm erkennt „Cancel Sale" die Retoure wieder.
  const { returnId } = createReturnInHouse({
    invoiceId,
    lines: [{ invoiceLineId: lineId, quantity: rest }],
    refundMethod,
    productDisposition: disposition,
    reason: reason || undefined,
    notes: postSaleReturnMarker(consignmentNumber),
    refundNow: true,
  }, branchId);

  // 2. Der Wareneinsatz des Verkaufs zurück (DR INVENTORY / CR COGS, zum Einstand der Rechnungszeile).
  //    Das Retourenhaus tut das nur bei „In Stock"; hier gilt es für BEIDE Wege: bei „Return to Owner"
  //    nimmt der Einkaufsstorno den Bestand danach wieder heraus (Lager im Hauptbuch null statt negativ),
  //    bei „Keep" steht dem neuen Los endlich der Bestand im Hauptbuch gegenüber. Strikt: wirft.
  if (!hasLedgerEntries('SALES_RETURN_COGS', returnId)) {
    postSalesReturnCogs(returnId, [{ invoiceLineId: lineId, productId, quantity: rest }], now);
  }

  // 3. „Keep": Einstand = Auszahlung an den Einlieferer (v0.7.11 — sonst Einstand = Verkaufspreis, und
  //    Marge und Margensteuer des Wiederverkaufs wären falsch). Das Retourenhaus legt das Los zum
  //    Verkaufspreis an; es wird hier auf den Einstand gesetzt — dasselbe Los, das ein Storno der
  //    Retoure wieder findet (jüngstes aktives, unangebrochenes Los ohne Einkauf).
  if (disposition === 'KEEP_AS_OWN') {
    const costBasis = Number(con.payout_amount ?? con.sale_price ?? 0);
    const lot = query(
      `SELECT id FROM stock_lots
          WHERE product_id = ? AND purchase_id IS NULL AND status = 'ACTIVE' AND qty_remaining = qty_total
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      [productId],
    )[0];
    if (costBasis > 0 && lot) {
      db.run(`UPDATE stock_lots SET unit_cost = ? WHERE id = ?`, [costBasis, String(lot.id)]);
      trackLotRow(String(lot.id), 'update');
      db.run(`UPDATE products SET purchase_price = ?, updated_at = ? WHERE id = ?`, [costBasis, now, productId]);
      trackProductRow(productId);
    }
  }

  // 4. „Return to Owner": wir schulden dem Einlieferer nichts mehr — sein Auto-Einkauf und die
  //    Verlust-Ausgabe werden storniert. Strikt: scheitert es, gibt es auch die Rückgabe nicht.
  for (const purchaseId of purchases) cancelPurchaseInHouse(purchaseId, branchId);
  for (const expenseId of losses) cancelConsignorLoss(expenseId);

  // 5. Die Kommission. Das Retourenhaus schreibt dafür RETURNED / RETURNED_TO_OWNER; die Kommissions-
  //    masken und „Cancel Sale" kennen den Rückgabe-Status nach dem Verkauf als „returned" — wie bisher.
  db.run(`UPDATE consignments SET status = 'returned', updated_at = ? WHERE id = ?`, [now, id]);
  trackUpdate('consignments', id, { status: 'returned' });

  const returnNumber = String(query('SELECT return_number FROM sales_returns WHERE id = ?', [returnId])[0]?.return_number ?? '');
  // 6. Protokoll ATOMAR in derselben Transaktion — mit dem, der die Rückgabe gebucht hat.
  protokoll({
    status: 'returned', disposition, refundMethod, reason: reason || null, invoiceId, returnId, returnNumber,
    cancelledPurchases: purchases.length, cancelledLossExpenses: losses.length,
  });
  eventBus.emit('consignment.returned', 'consignment', id, { disposition, returnId });
  return {
    consignmentId: id, status: 'returned', disposition, withoutInvoice: false, invoiceId, returnId, returnNumber,
    refundMethod, cancelledPurchases: purchases.length, cancelledLossExpenses: losses.length,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// „Cancel Sale" — der Verkauf war ein Fehler
// ════════════════════════════════════════════════════════════════════════════

export interface ConsignmentSaleCancelled {
  consignmentId: string;
  status: 'active';
  /** Die Käuferrechnung des Verkaufs (bleibt als CANCELLED stehen) — leer beim Altweg ohne Rechnung. */
  invoiceId: string;
  invoiceReversed: boolean;
  /** Die eigene Rückgabe nach dem Verkauf, storniert (Retoure REJECTED, Gutschrift CANCELLED). */
  cancelledReturns: number;
  cancelledPurchases: number;
  cancelledLossExpenses: number;
  reversedPayouts: number;
}

/**
 * „Cancel Sale": der Verkauf wird vollständig zurückgenommen — in DIESER Reihenfolge, in EINER Klammer:
 *   1. die eigene Rückgabe nach dem Verkauf (falls da) über den Retourenstorno — nichts wird gelöscht;
 *   2. die Käuferrechnung über die Grundlage (CANCELLED: Los zurück, Buchung, Zahlungen, Auto-Ausgaben);
 *   3. die Seite des Einlieferers: Auto-Einkauf (samt Zahlungen), Verlust-Ausgabe, Auszahlungen;
 *   4. der Artikel zurück in den Kommissionsbestand, die Kommission zurück auf „active";
 *   5. das Protokoll.
 * Eine fremde Retoure an der Rechnung (nicht die der Kommission) sperrt — erst sie stornieren (dieselbe
 * Regel wie „Undo convert"). Ist die Rechnung schon storniert, wird sie nicht ein zweites Mal angefasst.
 */
export function cancelConsignmentSaleInHouse(
  id: string, actor: ConsignmentActor, branchId: string, expectedRevision?: number,
): ConsignmentSaleCancelled {
  assertBooks();
  const con = liveConsignment(id, branchId, expectedRevision);
  const block = cancelSaleBlocker(con.status, con.invoice_id);
  if (block) throw nein(block.code, block.message);
  const consignmentNumber = String(con.consignment_number ?? '');
  const productId = String(con.product_id ?? '');
  const invoiceId = String(con.invoice_id ?? '');
  const inv = invoiceId ? query('SELECT id, status FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0] : undefined;
  if (invoiceId && !inv) throw nein('INVOICE_NOT_FOUND', 'the invoice of this sale is not in this branch');
  // Eine schon stornierte Rechnung (z. B. über „Cancel Invoice") ist umgekehrt — ihre Retouren und
  // Gutschriften gehören zu jenem Storno und bleiben, wie sie sind.
  const invoiceLive = !!inv && String(inv.status ?? '') !== 'CANCELLED';
  const marker = postSaleReturnMarker(consignmentNumber);
  const retouren = invoiceLive
    ? query(`SELECT id, notes FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED' ORDER BY created_at ASC, id ASC`, [invoiceId])
    : [];
  const eigene = retouren.filter((r) => String(r.notes ?? '').includes(marker)).map((r) => String(r.id));
  if (eigene.length !== retouren.length) {
    throw nein('CONSIGNMENT_INVOICE_HAS_RETURNS',
      'the invoice of this sale has a return that is not the consignment\'s own — cancel that return first');
  }
  const purchases = consignorPurchases(consignmentNumber, productId, branchId);
  const losses = consignorLosses(id, branchId);
  const db = getDatabase();
  const now = new Date().toISOString();
  const vorher = {
    status: String(con.status ?? ''), invoiceId, salePrice: con.sale_price ?? null,
    payoutAmount: con.payout_amount ?? null, payoutPaidAmount: Number(con.payout_paid_amount ?? 0),
    payoutStatus: String(con.payout_status ?? ''),
  };

  // 1. Die eigene Rückgabe nach dem Verkauf — über den Retourenstorno des Hauses: Warenfolge, Steuer,
  //    Wareneinsatz, Gutschrift (CANCELLED, bleibt mit Nummer stehen), unbenutztes Guthaben, Retoure
  //    REJECTED. Seine Sperren gelten auch hier (ausgezahlte Erstattung, verbrauchtes Guthaben, Owner).
  for (const returnId of eigene) {
    cancelReturnInHouse(returnId, `Consignment sale cancelled (${consignmentNumber})`, actor, branchId);
  }

  // 2. Die Käuferrechnung — über die Grundlage, nicht mehr direkt über `updateInvoice`. Keine offene
  //    Retoure mehr an ihr (sonst überspränge der Storno Buchung und Los, M-04).
  let invoiceReversed = false;
  if (invoiceLive) {
    reverseInvoiceInHouse(invoiceId, branchId, {
      statusRule: consignmentSaleInvoiceRule,
      requireNoReturns: {
        code: 'CONSIGNMENT_INVOICE_HAS_RETURNS',
        message: 'the invoice of this sale still carries a return or credit note — cancel it first',
      },
    });
    invoiceReversed = true;
  }

  // 3. Die Seite des Einlieferers: Auto-Einkauf (Zahlungen und Einkauf strikt zurückgebucht, Lose
  //    storniert), Verlust-Ausgabe, und Auszahlungen ohne Rechnung (M-22) — strikt: der Zähler bricht
  //    ab, wenn darin eine Umkehrbuchung scheiterte (die Hilfe fängt sie je Quelle ab).
  for (const purchaseId of purchases) cancelPurchaseInHouse(purchaseId, branchId);
  for (const expenseId of losses) cancelConsignorLoss(expenseId);
  const auszahlungen = watchLedgerPosts('consignor payout reversal');
  const reversedPayouts = reverseConsignmentPayouts(id, now);
  auszahlungen();

  // 4. Der Artikel zurück in den Kommissionsbestand. `quantity` defensiv auf 1, wenn ≤ 0: der Altweg
  //    (markSold ohne Rechnung) zählte herunter und kennt kein Los, das zurückkäme.
  db.run(
    `UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', quantity = CASE WHEN quantity <= 0 THEN 1 ELSE quantity END, updated_at = ? WHERE id = ?`,
    [now, productId],
  );
  trackUpdate('products', productId, { stockStatus: 'consignment', sourceType: 'CONSIGNMENT', cancelledSale: true });
  //    …und die Kommission zurück auf „active", Verkaufs- und Auszahlungsfelder leer — auch Methode,
  //    Datum und Referenz, sonst erschienen sie im nächsten Auszahlungszyklus als alte Daten.
  db.run(
    `UPDATE consignments SET
       status = 'active', sale_price = NULL, buyer_id = NULL, invoice_id = NULL,
       commission_amount = NULL, payout_amount = NULL, payout_paid_amount = 0, payout_status = 'pending',
       payout_method = NULL, payout_date = NULL, payout_reference = NULL, sale_method = NULL, updated_at = ?
     WHERE id = ?`,
    [now, id],
  );
  trackUpdate('consignments', id, { status: 'active', cancelledSale: true });

  // 5. Protokoll ATOMAR in derselben Transaktion — mit dem Menschen, der storniert hat.
  const invoiceStatus = invoiceId ? String(query('SELECT status FROM invoices WHERE id = ?', [invoiceId])[0]?.status ?? '') : '';
  logAuditOrThrow({
    module: 'Commission', entityType: 'consignments', entityId: id, action: 'STATUS_CHANGE', field: 'cancel_sale',
    oldValue: vorher,
    newValue: {
      status: 'active', invoiceId: invoiceId || null, invoiceStatus: invoiceStatus || null, invoiceReversed,
      cancelledReturns: eigene.length, cancelledPurchases: purchases.length, cancelledLossExpenses: losses.length,
      reversedPayouts,
    },
    actor: { userId: actor.userId, branchId },
  });
  eventBus.emit('consignment.sale_cancelled', 'consignment', id, { previousInvoiceId: invoiceId || undefined });
  return {
    consignmentId: id, status: 'active', invoiceId, invoiceReversed, cancelledReturns: eigene.length,
    cancelledPurchases: purchases.length, cancelledLossExpenses: losses.length, reversedPayouts,
  };
}

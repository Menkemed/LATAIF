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
import {
  cancelPurchaseInHouse, confirmPurchaseReturnInHouse, createPurchaseReturnDraftInHouse,
} from '@/core/purchases/purchase-lifecycle-house';
import { ConsignmentActionRejected } from './consignment-finance';
import {
  CONSIGNMENT_CONSIGNOR_SETTLED, CONSIGNMENT_PRIMARY_ONLY, CONSIGNOR_LOSS_PAID, CONSIGNOR_PAID_BY_CREDIT,
  CONSIGNOR_PAYOUT_PAID_LEGACY, CONSIGNOR_REFUND_INVALID, CONSIGNOR_REFUND_REQUIRED,
  DEFAULT_POST_SALE_REFUND_METHOD, POST_SALE_DISPOSITIONS, POST_SALE_REFUND_METHODS,
  cancelSaleBlocker, consignmentSaleInvoiceRule, consignorRefundOf, postSaleReturnBlocker, postSaleReturnMarker,
  type ConsignmentReturnAfterSaleInput, type ConsignorRefundChoice, type ConsignorRefundMethod, type ConsignorRefundMode,
  type PostSaleDisposition,
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
// PURCHASE-EDIT B6 — zuerst die Spalte (`source_consignment_id`, seit dieser Version gesetzt und für den
// Bestand einmalig aus dem Vermerk nachgetragen); der Vermerk gilt nur noch für einen Einkauf ohne Spalte.
// So bricht eine geänderte Notiz die Verknüpfung nicht mehr. (Exportiert für den Altbestands-Nachweis.)
export function consignorPurchases(consignmentId: string, consignmentNumber: string, productId: string, branchId: string): string[] {
  if (!consignmentNumber || !productId) return [];
  // CONSIGNOR-JOINT-PURCHASE — ein gemeinsamer Einkauf (mehrere Artikel desselben Einlieferers) trägt die Kommission an
  // der ZEILE; der Einkauf selbst hat dann keine.
  return query(
    `SELECT p.id FROM purchases p
      WHERE p.branch_id = ? AND p.status != 'CANCELLED'
        AND (p.source_consignment_id = ?
             OR EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.source_consignment_id = ?)
             OR (p.source_consignment_id IS NULL AND p.notes LIKE ?
                 AND EXISTS (SELECT 1 FROM purchase_lines pl WHERE pl.purchase_id = p.id AND pl.product_id = ?)))
      ORDER BY p.created_at ASC, p.id ASC`,
    [branchId, consignmentId, consignmentId, `%${consignmentNumber}%`, productId],
  ).map((r) => String(r.id));
}

/**
 * CONSIGNOR-JOINT-PURCHASE — gehört ein Einkauf NICHT dieser Kommission allein (mehrere Zeilen, je Artikel eine), dann die
 * Zeile dieser Kommission: Rückgabe wirkt nur auf sie. `null`: der Einkauf gehört ihr allein (wie bisher, ganz).
 */
interface GemeinsameZeile { lineId: string; quantity: number; unitPrice: number; wertF: number; zurueck: string | null }
function gemeinsameZeile(purchaseId: string, consignmentId: string, productId: string): GemeinsameZeile | null {
  const zeilen = query('SELECT id, product_id, quantity, unit_price, line_total, source_consignment_id FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id', [purchaseId]);
  if (zeilen.length <= 1) return null;
  const z = zeilen.find((l) => String(l.source_consignment_id ?? '') === consignmentId)
    ?? zeilen.find((l) => !l.source_consignment_id && String(l.product_id ?? '') === productId);
  if (!z) return null;
  const ret = query(
    `SELECT pr.return_number FROM purchase_return_lines prl JOIN purchase_returns pr ON pr.id = prl.return_id
      WHERE prl.purchase_line_id = ? AND pr.status != 'CANCELLED' LIMIT 1`,
    [String(z.id)],
  )[0];
  return {
    lineId: String(z.id), quantity: Number(z.quantity) || 1, unitPrice: Number(z.unit_price) || 0, wertF: F(z.line_total),
    zurueck: ret ? String(ret.return_number ?? '') || 'a supplier return' : null,
  };
}

/**
 * D3 — die Einkäufe DIESES Verkaufs: ein früherer, storniert-und-neu-verkaufter Verkauf kann einen bezahlten Einkauf
 * hinterlassen, der über die Lieferanten-Retoure zurückging (nicht storniert, Summe 0). Er gehört nicht zum jetzigen
 * Verkauf — zugeordnet wird über das Los des Einkaufs auf einer Zeile der jetzigen Rechnung. Ohne diese Zuordnung
 * (Altbestand ohne Los) bleiben es alle wie bisher.
 */
function zumVerkauf(invoiceId: string, purchases: string[]): string[] {
  if (!invoiceId || purchases.length <= 1) return purchases;
  const verknuepft = purchases.filter((pid) => query(
    `SELECT 1 FROM invoice_lines il JOIN stock_lots sl ON sl.id = il.lot_id WHERE il.invoice_id = ? AND sl.purchase_id = ? LIMIT 1`,
    [invoiceId, pid],
  ).length > 0);
  return verknuepft.length > 0 ? verknuepft : purchases;
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
// D3 — die Seite des Einlieferers, wenn sein Verkauf zurückgenommen wird
// ════════════════════════════════════════════════════════════════════════════

const F = (n: unknown): number => Math.round((Number(n) || 0) * 1000);
const B = (f: number): number => f / 1000;

/** Was ein Einkauf beim Einlieferer schon gesehen hat: Bezahltes (bar UND per Guthaben) und eine wirksame Lieferanten-Retoure.
 *  CONSIGNOR-JOINT-PURCHASE — `offenF`: der offene Rest des Einkaufs (eine Zeilen-Retoure mindert zuerst ihn). */
interface EinkaufLage { id: string; number: string; bezahltF: number; guthabenF: number; retoure: string | null; offenF: number }

function einkaufLage(purchaseId: string): EinkaufLage {
  const p = query('SELECT purchase_number, paid_amount, remaining_amount FROM purchases WHERE id = ?', [purchaseId])[0];
  const guthabenF = F(query(
    `SELECT COALESCE(SUM(amount), 0) AS t FROM purchase_payments WHERE purchase_id = ? AND method = 'credit' AND voided_at IS NULL`,
    [purchaseId],
  )[0]?.t);
  const ret = query(`SELECT return_number FROM purchase_returns WHERE purchase_id = ? AND status != 'CANCELLED' LIMIT 1`, [purchaseId])[0];
  return {
    id: purchaseId, number: String(p?.purchase_number ?? ''), bezahltF: F(p?.paid_amount) + guthabenF, guthabenF,
    retoure: ret ? String(ret.return_number ?? '') || 'a supplier return' : null, offenF: F(p?.remaining_amount),
  };
}

/**
 * CONSIGNOR-JOINT-PURCHASE — was eine Zeilen-Retoure zurückzahlt: die Lieferanten-Retoure mindert zuerst den offenen Rest
 * des Einkaufs, nur der Überschuss kommt zurück (dieselbe Regel wie `confirmPurchaseReturnInHouse`).
 */
const zeilenErstattungF = (lage: EinkaufLage, zeile: GemeinsameZeile): number => Math.max(0, zeile.wertF - lage.offenF);

/** Was auf eine Verlust-Ausgabe schon gezahlt ist (bar und per Guthaben). */
function verlustBezahltF(expenseId: string): number {
  const e = query('SELECT paid_amount FROM expenses WHERE id = ?', [expenseId])[0];
  const guthaben = query(`SELECT COALESCE(SUM(amount), 0) AS t FROM expense_payments WHERE expense_id = ? AND method = 'credit'`, [expenseId])[0];
  return F(e?.paid_amount) + F(guthaben?.t);
}

/** Der Vermerk der Lieferanten-Retoure, mit der die Auszahlung einer Kommission zurückkommt. */
export function consignorRefundMarker(consignmentNumber: string): string {
  return `Consignment payout back (${consignmentNumber})`;
}

/** D3 — die gebuchte Rückzahlung des Einlieferers (Lieferanten-Retoure seines Einkaufs). */
export interface ConsignorRefundBooked {
  consignmentId: string;
  purchaseId: string;
  purchaseNumber: string;
  mode: ConsignorRefundMode;
  /** received: der Weg des Eingangs; pending: null (Lieferanten-Guthaben). */
  method: ConsignorRefundMethod | null;
  returnId: string;
  returnNumber: string;
  /** Der zurückkommende bzw. offene Betrag — genau das schon Bezahlte. */
  refundAmount: number;
  supplierCreditId: string | null;
}

/**
 * Was eine Rücknahme an der Seite des Einlieferers prüfen muss, BEVOR geschrieben wird: kein schon zurückgegebener
 * Einkauf, kein mit Guthaben bezahlter, keine bezahlte Verlust-Ausgabe, keine Altweg-Auszahlung — und bei einem
 * bezahlten Einkauf die Wahl des Owners (D3). Wirft das erste Nein.
 */
function pruefeEinlieferer(
  con: Record<string, unknown>, purchases: string[], losses: string[], wahl: ConsignorRefundChoice | undefined,
  /** CONSIGNOR-JOINT-PURCHASE — true: nur die Zeile DIESER Kommission geht zurück (Rückgabe nach dem Verkauf). */
  nurZeile = false,
): EinkaufLage[] {
  const nr = String(con.consignment_number ?? '');
  const lagen = purchases.map(einkaufLage);
  let erstattungF = 0;
  for (const l of lagen) {
    const zeile = nurZeile ? gemeinsameZeile(l.id, String(con.id), String(con.product_id ?? '')) : null;
    if (zeile) {
      if (zeile.zurueck) {
        throw nein(CONSIGNMENT_CONSIGNOR_SETTLED,
          `${nr}: this item's line of the consignor's purchase ${l.number} already went back to the consignor (${zeile.zurueck})`);
      }
    } else if (l.retoure) {
      throw nein(CONSIGNMENT_CONSIGNOR_SETTLED,
        `${nr}: the consignor's purchase ${l.number} already went back to the consignor (${l.retoure}) — this sale cannot be undone again`);
    }
    if (l.guthabenF > 0) {
      throw nein(CONSIGNOR_PAID_BY_CREDIT,
        `${nr}: the consignor's purchase ${l.number} was paid with supplier credit — it is not undone automatically; please check it with the accountant`);
    }
    erstattungF += zeile ? zeilenErstattungF(l, zeile) : l.bezahltF;
  }
  const bezahltF = erstattungF;
  if (bezahltF > 0 && !wahl) {
    throw nein(CONSIGNOR_REFUND_REQUIRED,
      `${nr}: the consignor was already paid ${B(bezahltF).toFixed(3)} BHD — choose whether that money came back now or is still to be repaid`);
  }
  for (const e of losses) {
    if (verlustBezahltF(e) > 0) {
      throw nein(CONSIGNOR_LOSS_PAID,
        `${nr}: the consignor's guarantee shortfall was already paid — it is not undone automatically; please check it with the accountant`);
    }
  }
  if (F(con.payout_paid_amount) > 0) {
    throw nein(CONSIGNOR_PAYOUT_PAID_LEGACY,
      `${nr}: this old sale was already paid out to the consignor (${B(F(con.payout_paid_amount)).toFixed(3)} BHD) — undoing it would book that money as returned; please check it with the accountant`);
  }
  return lagen;
}

/**
 * Der Einkauf beim Einlieferer wird zurückgenommen: unbezahlt wie bisher über den Einkaufsstorno; bezahlt (D3) über
 * die VORHANDENE Lieferanten-Retoure — die Verbindlichkeit fällt, das schon Bezahlte kommt zurück (received: auf
 * dem gewählten Weg) oder wird Lieferanten-Guthaben beim Einlieferer (pending). Die Auszahlung selbst bleibt stehen.
 */
function einkaufZurueck(
  con: Record<string, unknown>, lage: EinkaufLage, wahl: ConsignorRefundChoice | undefined, branchId: string, now: string,
  nurZeile = false,
): ConsignorRefundBooked | null {
  // CONSIGNOR-JOINT-PURCHASE — ein gemeinsamer Einkauf: nur die Zeile dieser Kommission geht über die Lieferanten-Retoure
  // zurück. Sie mindert zuerst den offenen Rest; was darüber schon bezahlt war, kommt zurück (D3-Wahl) — sonst nichts.
  const zeile = nurZeile ? gemeinsameZeile(lage.id, String(con.id), String(con.product_id ?? '')) : null;
  if (zeile) {
    const erwartetF = zeilenErstattungF(lage, zeile);
    if (erwartetF > 0 && !wahl) throw nein(CONSIGNOR_REFUND_REQUIRED, 'the consignor was already paid — choose how the money comes back');
    const nrZ = String(con.consignment_number ?? '');
    const ctxZ = { branchId, userId: currentUserId(), now };
    const entwurf = createPurchaseReturnDraftInHouse({
      purchaseId: lage.id,
      refundMethod: erwartetF > 0 && wahl && wahl.mode === 'received' ? wahl.method : 'credit',
      notes: consignorRefundMarker(nrZ),
      lines: [{ purchaseLineId: zeile.lineId, quantity: zeile.quantity, unitPrice: zeile.unitPrice }],
    }, ctxZ);
    const fertig = confirmPurchaseReturnInHouse(entwurf.returnId, ctxZ);
    if (F(fertig.refundAmount) !== erwartetF) {
      throw new Error(`consignor refund ${entwurf.returnNumber}: ${fertig.refundAmount} back, but ${B(erwartetF)} was expected`);
    }
    if (erwartetF <= 0) return null;
    return {
      consignmentId: String(con.id), purchaseId: lage.id, purchaseNumber: lage.number, mode: wahl!.mode,
      method: wahl!.mode === 'received' ? wahl!.method : null, returnId: entwurf.returnId, returnNumber: entwurf.returnNumber,
      refundAmount: fertig.refundAmount, supplierCreditId: fertig.supplierCreditId,
    };
  }
  if (lage.bezahltF <= 0) {
    cancelPurchaseInHouse(lage.id, branchId);
    return null;
  }
  if (!wahl) throw nein(CONSIGNOR_REFUND_REQUIRED, 'the consignor was already paid — choose how the money comes back');
  const nr = String(con.consignment_number ?? '');
  const lines = query('SELECT id, quantity, unit_price FROM purchase_lines WHERE purchase_id = ? ORDER BY position, id', [lage.id]);
  const ctx = { branchId, userId: currentUserId(), now };
  const draft = createPurchaseReturnDraftInHouse({
    purchaseId: lage.id,
    refundMethod: wahl.mode === 'received' ? wahl.method : 'credit',
    notes: consignorRefundMarker(nr),
    lines: lines.map((l) => ({ purchaseLineId: String(l.id), quantity: Number(l.quantity) || 1, unitPrice: Number(l.unit_price) || 0 })),
  }, ctx);
  const done = confirmPurchaseReturnInHouse(draft.returnId, ctx);
  if (F(done.refundAmount) !== lage.bezahltF) {
    throw new Error(`consignor refund ${draft.returnNumber}: ${done.refundAmount} back, but ${B(lage.bezahltF)} was paid`);
  }
  return {
    consignmentId: String(con.id), purchaseId: lage.id, purchaseNumber: lage.number, mode: wahl.mode,
    method: wahl.mode === 'received' ? wahl.method : null, returnId: draft.returnId, returnNumber: draft.returnNumber,
    refundAmount: done.refundAmount, supplierCreditId: done.supplierCreditId,
  };
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
  /** D3 — die Rückzahlung eines schon bezahlten Einlieferers (nur bei „Return to Owner"). */
  consignorRefunds: ConsignorRefundBooked[];
}

/**
 * „Buyer Returns the Item": die Retoure über das Retourenhaus (Zeile der Kommissionsware in ihrer
 * Restmenge, Rechnungspreis brutto, sofort erstattet im gewählten Weg — unbezahlt ist das die
 * Forderungsstornierung), der Wareneinsatz zurück, dann je Weg:
 *   • „Return to Owner": die Ware geht an den Einlieferer; sein Auto-Einkauf und die Verlust-Ausgabe
 *     werden storniert (die Maske: „Our A/P to him gets cancelled … No inventory effect for us") —
 *     D3: war er schon bezahlt, kommt das Geld über die Lieferanten-Retoure zurück (jetzt oder als Guthaben);
 *   • „Keep": die Ware wird eigener Bestand zum Einstand, den das Lager zurückbekam (= Auszahlung an den
 *     Einlieferer, v0.7.11); der Einkauf bleibt (offen oder bezahlt — eine Auszahlung bleibt eine Auszahlung).
 * Die Kommission steht danach auf „returned" (die Maske bietet dann „Cancel Sale (cleanup)").
 * Bei einem gemeinsamen Verkauf wirkt das NUR auf diese Kommission — die übrigen Zeilen der Rechnung bleiben.
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
  let wahl: ConsignorRefundChoice | undefined;
  if (input.consignorRefund !== undefined) {
    const w = consignorRefundOf(input.consignorRefund);
    if (!w) throw nein(CONSIGNOR_REFUND_INVALID, 'the consignor refund is "received" with cash, bank or benefit — or "pending"');
    wahl = w;
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
      refundMethod, cancelledPurchases: 0, cancelledLossExpenses: 0, consignorRefunds: [],
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
  const purchases = disposition === 'RETURN_TO_OWNER' ? zumVerkauf(invoiceId, consignorPurchases(id, consignmentNumber, productId, branchId)) : [];
  const losses = disposition === 'RETURN_TO_OWNER' ? consignorLosses(id, branchId) : [];
  // D3 — VOR dem ersten Schreiben: was an der Seite des Einlieferers schon bezahlt ist, und die Wahl des Owners.
  const lagen = disposition === 'RETURN_TO_OWNER' ? pruefeEinlieferer(con, purchases, losses, wahl, true) : [];

  // 1. Die Retoure — über das Retourenhaus: Preis und Steuer aus der Rechnung, Gutschrift, Erstattung im
  //    gewählten Weg (nur was der Käufer bezahlt hat, fließt zurück), Warenfolge, Nummer aus dem Zähler.
  //    Der Vermerk ist derselbe wie bisher — an ihm erkennt „Cancel Sale" die Retoure wieder.
  //    CONSIGNMENT-INTEGRITY — GENAU diese Kommission (nicht jede Kommission des Artikels).
  const extraNotes = typeof input.notes === 'string' ? input.notes.trim() : '';
  const { returnId } = createReturnInHouse({
    invoiceId,
    lines: [{ invoiceLineId: lineId, quantity: rest }],
    refundMethod,
    productDisposition: disposition,
    reason: reason || undefined,
    notes: postSaleReturnMarker(consignmentNumber) + (extraNotes ? ` — ${extraNotes}` : ''),
    staffId: input.staffId || undefined,
    refundNow: true,
  }, branchId, undefined, { consignmentId: id });

  // 2. Der Wareneinsatz des Verkaufs zurück (DR INVENTORY / CR COGS, zum Einstand der Rechnungszeile).
  //    Das Retourenhaus tut das nur bei „In Stock"; hier gilt es für BEIDE Wege: bei „Return to Owner"
  //    nimmt der Einkaufsstorno (bzw. die Lieferanten-Retoure) den Bestand danach wieder heraus (Lager im
  //    Hauptbuch null statt negativ), bei „Keep" steht dem neuen Los endlich der Bestand im Hauptbuch gegenüber.
  //    Strikt: wirft.
  if (!hasLedgerEntries('SALES_RETURN_COGS', returnId)) {
    postSalesReturnCogs(returnId, [{ invoiceLineId: lineId, productId, quantity: rest }], now);
  }

  // 3. „Keep": Einstand = was das Lager eben zurückbekam (v0.7.11: die Auszahlung an den Einlieferer — sonst
  //    Einstand = Verkaufspreis, und Marge und Margensteuer des Wiederverkaufs wären falsch). Das ist der Einkauf
  //    beim Einlieferer; bei Unterdeckung der Verkaufspreis (der Rest steht schon als Verlust-Ausgabe), damit Los
  //    und Hauptbuch denselben Bestand zeigen. Das Retourenhaus legt das Los zum Verkaufspreis an; es wird hier auf
  //    den Einstand gesetzt — dasselbe Los, das ein Storno der Retoure wieder findet (jüngstes aktives,
  //    unangebrochenes Los ohne Einkauf).
  if (disposition === 'KEEP_AS_OWN') {
    const eingebucht = Number(query(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM ledger_entries
        WHERE source_module = 'SALES_RETURN_COGS' AND source_id = ? AND account = 'INVENTORY' AND direction = 'DEBIT'
          AND reverses_entry_id IS NULL`,
      [returnId],
    )[0]?.t ?? 0);
    const costBasis = eingebucht > 0.0005 && rest > 0 ? Math.round((eingebucht / rest) * 1000) / 1000
      : Number(con.payout_amount ?? con.sale_price ?? 0);
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

  // 4. „Return to Owner": wir schulden dem Einlieferer nichts mehr — sein Auto-Einkauf (unbezahlt: storniert;
  //    bezahlt: Lieferanten-Retoure, D3) und die Verlust-Ausgabe. Strikt: scheitert es, gibt es auch die Rückgabe nicht.
  const consignorRefunds: ConsignorRefundBooked[] = [];
  let cancelledPurchases = 0;
  for (const lage of lagen) {
    const r = einkaufZurueck(con, lage, wahl, branchId, now, true);
    if (r) consignorRefunds.push(r); else cancelledPurchases++;
  }
  for (const expenseId of losses) cancelConsignorLoss(expenseId);

  // 5. Die Kommission. Das Retourenhaus schreibt dafür RETURNED / RETURNED_TO_OWNER; die Kommissions-
  //    masken und „Cancel Sale" kennen den Rückgabe-Status nach dem Verkauf als „returned" — wie bisher.
  db.run(`UPDATE consignments SET status = 'returned', updated_at = ? WHERE id = ?`, [now, id]);
  trackUpdate('consignments', id, { status: 'returned' });

  const returnNumber = String(query('SELECT return_number FROM sales_returns WHERE id = ?', [returnId])[0]?.return_number ?? '');
  // 6. Protokoll ATOMAR in derselben Transaktion — mit dem, der die Rückgabe gebucht hat.
  protokoll({
    status: 'returned', disposition, refundMethod, reason: reason || null, invoiceId, returnId, returnNumber,
    cancelledPurchases, cancelledLossExpenses: losses.length,
    ...(consignorRefunds.length > 0 ? {
      consignorRefunds: consignorRefunds.map((r) => ({
        purchaseNumber: r.purchaseNumber, mode: r.mode, method: r.method, returnNumber: r.returnNumber, amount: r.refundAmount,
      })),
    } : {}),
  });
  eventBus.emit('consignment.returned', 'consignment', id, { disposition, returnId });
  return {
    consignmentId: id, status: 'returned', disposition, withoutInvoice: false, invoiceId, returnId, returnNumber,
    refundMethod, cancelledPurchases, cancelledLossExpenses: losses.length, consignorRefunds,
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
  /** CONSIGNMENT MULTI-SALE (D2) — ALLE Kommissionen dieses Verkaufs (eine Rechnung = ein Verkauf). */
  consignmentIds: string[];
  /** D3 — die Rückzahlungen schon bezahlter Einlieferer. */
  consignorRefunds: ConsignorRefundBooked[];
}

/** D2 — die Kommissionen eines Verkaufs: bei einer Rechnung ALLE mit dieser Rechnung, sonst (Altweg) nur diese. */
export function saleGroupOf(con: Record<string, unknown>, branchId: string): Array<Record<string, unknown>> {
  const invoiceId = String(con.invoice_id ?? '');
  if (!invoiceId) return [con];
  return query('SELECT * FROM consignments WHERE invoice_id = ? AND branch_id = ? ORDER BY consignment_number, id', [invoiceId, branchId]);
}

/**
 * „Cancel Sale": der Verkauf wird vollständig zurückgenommen — bei einem gemeinsamen Verkauf ausdrücklich die
 * GANZE Rechnung mit ALLEN ihren Kommissionen (D2; eine einzelne zurückgebrachte Uhr geht über „Post-Sale Return").
 * In DIESER Reihenfolge, in EINER Klammer:
 *   1. die eigenen Rückgaben nach dem Verkauf (falls da) über den Retourenstorno — nichts wird gelöscht;
 *   2. die Käuferrechnung über die Grundlage (CANCELLED: Los zurück, Buchung, Zahlungen, Auto-Ausgaben);
 *   3. je Kommission die Seite des Einlieferers: Auto-Einkauf (unbezahlt storniert; bezahlt nach der Wahl des
 *      Owners über die Lieferanten-Retoure, D3), Verlust-Ausgabe, Auszahlungen;
 *   4. je Kommission der Artikel zurück in den Kommissionsbestand, die Kommission zurück auf „active";
 *   5. das Protokoll.
 * Alle Sperren gelten für JEDE Kommission und stehen vor dem ersten Schreiben. Eine fremde Retoure an der
 * Rechnung (nicht die einer Kommission dieses Verkaufs) sperrt — erst sie stornieren (dieselbe Regel wie „Undo
 * convert"). Ist die Rechnung schon storniert, wird sie nicht ein zweites Mal angefasst.
 */
export function cancelConsignmentSaleInHouse(
  id: string, actor: ConsignmentActor, branchId: string, expectedRevision?: number,
  consignorRefunds?: Readonly<Record<string, unknown>>,
): ConsignmentSaleCancelled {
  assertBooks();
  const con = liveConsignment(id, branchId, expectedRevision);
  const block = cancelSaleBlocker(con.status, con.invoice_id);
  if (block) throw nein(block.code, block.message);
  const invoiceId = String(con.invoice_id ?? '');
  const inv = invoiceId ? query('SELECT id, status FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0] : undefined;
  if (invoiceId && !inv) throw nein('INVOICE_NOT_FOUND', 'the invoice of this sale is not in this branch');
  const gruppe = saleGroupOf(con, branchId);
  for (const k of gruppe) {
    const b = cancelSaleBlocker(k.status, k.invoice_id);
    if (b) throw nein(b.code, `${String(k.consignment_number ?? '')}: ${b.message}`);
  }
  // D3 — die Wahl je Kommission (nur für schon bezahlte Einlieferer nötig, aber nie eine ungültige).
  const wahlen = new Map<string, ConsignorRefundChoice>();
  for (const [kid, roh] of Object.entries(consignorRefunds ?? {})) {
    const w = consignorRefundOf(roh);
    if (!w) throw nein(CONSIGNOR_REFUND_INVALID, 'the consignor refund is "received" with cash, bank or benefit — or "pending"');
    if (!gruppe.some((k) => String(k.id) === kid)) throw nein(CONSIGNOR_REFUND_INVALID, 'a consignor refund names a consignment that is not part of this sale');
    wahlen.set(kid, w);
  }
  // Eine schon stornierte Rechnung (z. B. über „Cancel Invoice") ist umgekehrt — ihre Retouren und
  // Gutschriften gehören zu jenem Storno und bleiben, wie sie sind.
  const invoiceLive = !!inv && String(inv.status ?? '') !== 'CANCELLED';
  const retouren = invoiceLive
    ? query(`SELECT id, notes FROM sales_returns WHERE invoice_id = ? AND status != 'REJECTED' ORDER BY created_at ASC, id ASC`, [invoiceId])
    : [];
  // CONSIGNOR-JOINT-PURCHASE — ein gemeinsamer Einkauf gehört mehreren Kommissionen dieses Verkaufs: er wird EINMAL
  // zurückgenommen (ganz), mit der Wahl, die für irgendeine seiner Kommissionen genannt ist.
  const einkaufDer = new Map<string, string>();
  const teile = gruppe.map((k) => {
    const kid = String(k.id);
    const nr = String(k.consignment_number ?? '');
    const pid = String(k.product_id ?? '');
    const marker = postSaleReturnMarker(nr);
    const eigene = retouren.filter((r) => String(r.notes ?? '').includes(marker)).map((r) => String(r.id));
    const alle = zumVerkauf(String(k.invoice_id ?? ''), consignorPurchases(kid, nr, pid, branchId));
    const purchases = alle.filter((p) => !einkaufDer.has(p));
    for (const p of purchases) einkaufDer.set(p, kid);
    const losses = consignorLosses(kid, branchId);
    return { k, kid, nr, pid, eigene, purchases, losses, lagen: [] as EinkaufLage[] };
  });
  const wahlFuer = (purchaseId: string, kid: string): ConsignorRefundChoice | undefined => wahlen.get(kid)
    ?? [...wahlen.entries()].find(([k]) => teile.some((t) => t.kid === k && consignorPurchases(k, t.nr, t.pid, branchId).includes(purchaseId)))?.[1];
  for (const t of teile) {
    t.lagen = t.purchases.flatMap((p) => pruefeEinlieferer(t.k, [p], [], wahlFuer(p, t.kid)));
    pruefeEinlieferer(t.k, [], t.losses, undefined);
  }
  if (teile.reduce((s, t) => s + t.eigene.length, 0) !== retouren.length) {
    throw nein('CONSIGNMENT_INVOICE_HAS_RETURNS',
      'the invoice of this sale has a return that is not the consignment\'s own — cancel that return first');
  }
  const db = getDatabase();
  const now = new Date().toISOString();

  // 1. Die eigenen Rückgaben nach dem Verkauf — über den Retourenstorno des Hauses: Warenfolge, Steuer,
  //    Wareneinsatz, Gutschrift (CANCELLED, bleibt mit Nummer stehen), unbenutztes Guthaben, Retoure
  //    REJECTED. Seine Sperren gelten auch hier (ausgezahlte Erstattung, verbrauchtes Guthaben, Owner).
  for (const t of teile) {
    for (const returnId of t.eigene) {
      cancelReturnInHouse(returnId, `Consignment sale cancelled (${t.nr})`, actor, branchId, undefined,
        { viaConsignmentCancelSale: t.kid });
    }
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

  // 3.–5. Je Kommission: die Seite des Einlieferers (Auto-Einkauf — unbezahlt storniert, bezahlt über die
  //    Lieferanten-Retoure nach der Wahl des Owners —, Verlust-Ausgabe, Auszahlungen ohne Rechnung, M-22: strikt,
  //    der Zähler bricht ab, wenn darin eine Umkehrbuchung scheiterte), der Artikel, die Kommission, das Protokoll.
  const erstattet: ConsignorRefundBooked[] = [];
  let cancelledPurchases = 0;
  let cancelledLossExpenses = 0;
  let reversedPayouts = 0;
  let cancelledReturns = 0;
  for (const t of teile) {
    const vorher = {
      status: String(t.k.status ?? ''), invoiceId, salePrice: t.k.sale_price ?? null,
      payoutAmount: t.k.payout_amount ?? null, payoutPaidAmount: Number(t.k.payout_paid_amount ?? 0),
      payoutStatus: String(t.k.payout_status ?? ''),
    };
    const eigeneErstattungen: ConsignorRefundBooked[] = [];
    let einkaeufe = 0;
    for (const lage of t.lagen) {
      const r = einkaufZurueck(t.k, lage, wahlFuer(lage.id, t.kid), branchId, now);
      if (r) eigeneErstattungen.push(r); else einkaeufe++;
    }
    for (const expenseId of t.losses) cancelConsignorLoss(expenseId);
    const auszahlungen = watchLedgerPosts('consignor payout reversal');
    const umgekehrt = reverseConsignmentPayouts(t.kid, now);
    auszahlungen();

    // Der Artikel zurück in den Kommissionsbestand. `quantity` defensiv auf 1, wenn ≤ 0: der Altweg
    // (markSold ohne Rechnung) zählte herunter und kennt kein Los, das zurückkäme.
    db.run(
      `UPDATE products SET stock_status = 'consignment', source_type = 'CONSIGNMENT', quantity = CASE WHEN quantity <= 0 THEN 1 ELSE quantity END, updated_at = ? WHERE id = ?`,
      [now, t.pid],
    );
    trackUpdate('products', t.pid, { stockStatus: 'consignment', sourceType: 'CONSIGNMENT', cancelledSale: true });
    //    …und die Kommission zurück auf „active", Verkaufs- und Auszahlungsfelder leer — auch Methode,
    //    Datum und Referenz, sonst erschienen sie im nächsten Auszahlungszyklus als alte Daten.
    db.run(
      `UPDATE consignments SET
         status = 'active', sale_price = NULL, buyer_id = NULL, invoice_id = NULL,
         commission_amount = NULL, payout_amount = NULL, payout_paid_amount = 0, payout_status = 'pending',
         payout_method = NULL, payout_date = NULL, payout_reference = NULL, sale_method = NULL, updated_at = ?
       WHERE id = ?`,
      [now, t.kid],
    );
    trackUpdate('consignments', t.kid, { status: 'active', cancelledSale: true });

    // Protokoll ATOMAR in derselben Transaktion — mit dem Menschen, der storniert hat.
    const invoiceStatus = invoiceId ? String(query('SELECT status FROM invoices WHERE id = ?', [invoiceId])[0]?.status ?? '') : '';
    logAuditOrThrow({
      module: 'Commission', entityType: 'consignments', entityId: t.kid, action: 'STATUS_CHANGE', field: 'cancel_sale',
      oldValue: vorher,
      newValue: {
        status: 'active', invoiceId: invoiceId || null, invoiceStatus: invoiceStatus || null, invoiceReversed,
        cancelledReturns: t.eigene.length, cancelledPurchases: einkaeufe, cancelledLossExpenses: t.losses.length,
        reversedPayouts: umgekehrt,
        ...(gruppe.length > 1 ? { saleConsignments: teile.map((x) => x.nr) } : {}),
        ...(eigeneErstattungen.length > 0 ? {
          consignorRefunds: eigeneErstattungen.map((r) => ({
            purchaseNumber: r.purchaseNumber, mode: r.mode, method: r.method, returnNumber: r.returnNumber, amount: r.refundAmount,
          })),
        } : {}),
      },
      actor: { userId: actor.userId, branchId },
    });
    eventBus.emit('consignment.sale_cancelled', 'consignment', t.kid, { previousInvoiceId: invoiceId || undefined });
    erstattet.push(...eigeneErstattungen);
    cancelledPurchases += einkaeufe;
    cancelledLossExpenses += t.losses.length;
    reversedPayouts += umgekehrt;
    cancelledReturns += t.eigene.length;
  }
  return {
    consignmentId: id, status: 'active', invoiceId, invoiceReversed, cancelledReturns,
    cancelledPurchases, cancelledLossExpenses, reversedPayouts,
    consignmentIds: teile.map((t) => t.kid), consignorRefunds: erstattet,
  };
}

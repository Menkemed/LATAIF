// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6E — „Cancel Return" am Haus: EINE Folge für die Maske des Primary und für
// den Fernbefehl `returns.cancel` von PC2.
//
// Was vorher geschah (auditiert, nicht angenommen) — `salesReturnStore.cancelReturn`:
//
//   • Das Owner-Recht kam aus der Sitzung des PRIMARY (`useAuthStore`). Ein Fernauftrag hätte also
//     das Recht dessen geerbt, der am Primary angemeldet ist — nicht das des Absenders.
//   • Die Retoure wurde in der GELADENEN Liste des Stores gesucht, ohne Filiale; eine fehlende
//     Retoure war ein stilles Nichts.
//   • Die Folge öffnete ihre EIGENE Transaktion und rollte bei Fehler selbst zurück — in einem
//     Fernauftrag hätte das die äußere Transaktion der Maschine samt Nachweis zerstört.
//   • Das Protokoll nannte den Benutzer der Sitzung, nicht den, der storniert hat.
//   • Stand die Rechnung durch die Gutschrift auf RETURNED, blieb sie es nach dem Storno — obwohl
//     die Forderung im Hauptbuch zurück war. Die offenen Posten (`status IN ('PARTIAL','DRAFT')`)
//     sahen sie nie wieder. Die geänderte Rechnung (Steuer, Status) ging zudem nicht in den Abgleich.
//
// Jetzt: prüfen (aus der DATENBANK, in der Filiale des Auftrags, das Recht am AUFTRAGGEBER), dann
// dieselben Umkehrschritte wie bisher — alles INNERHALB der Transaktion des Aufrufers
// (`runOnPrimary` am Primary, `runRemoteCommand` für PC2). Diese Datei öffnet, schließt und rollt
// nie selbst zurück; ein Nein ist ein geworfener `ReturnCancelRejected` mit festem Code.
//
// R6E-CN — die Gutschrift wird nicht mehr GELÖSCHT, sondern STORNIERT. Vorher verschwand die Zeile
// samt Nummer (eine Steuerurkunde!) und das daraus entstandene, unbenutzte Store-Guthaben; die
// einzige Spur waren die Stornobuchungen. Jetzt bleibt beides stehen:
//   • `credit_notes.status = 'CANCELLED'` mit `cancelled_at`/`cancelled_by`/`cancel_reason` —
//     Nummer, Beträge und Verweise unverändert (Historie, klar als storniert gekennzeichnet);
//   • `customer_credits.status = 'CANCELLED'` (das Vokabular des Hauses) — nicht mehr einlösbar.
// Die finanzielle Wahrheit bleibt das Hauptbuch (`reverseSource('CREDIT_NOTE')` wie bisher). Jeder
// Leser, der Gutschriften oder Guthaben SUMMIERT (offene Posten, Forderungen, Deckel, Abstimmung,
// Gegenpartei-Prüfung, Nachbuchung, Rechnungsstorno M-04, Guard B), lässt CANCELLED aus — damit
// hat die stornierte Gutschrift genau die Wirkung, die sie vorher durch das Löschen hatte: keine.
// Protokoll: je Gutschrift ein eigener Eintrag (ISSUED → CANCELLED, mit dem Menschen, der storniert).
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { query } from '@/core/db/helpers';
import { isClientMode } from '@/core/bridge/client-mode';
import { canonicalRole, type ProductDisposition } from '@/core/models/types';
import { reverseSource, hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { trackChange } from '@/core/sync/sync-service';
import { syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';

/** Ein fachliches Nein des Stornos — am Primary eine Absage der Maske, fern ein eingefrorenes Urteil. */
export class ReturnCancelRejected extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReturnCancelRejected';
    this.code = code;
  }
}

export const RETURN_PRIMARY_ONLY = 'RETURN_PRIMARY_ONLY';
export const RETURN_OWNER_ONLY = 'RETURN_OWNER_ONLY';
export const RETURN_NOT_FOUND = 'RETURN_NOT_FOUND';
export const RETURN_REASON_REQUIRED = 'RETURN_REASON_REQUIRED';
export const RETURN_ALREADY_CANCELLED = 'RETURN_ALREADY_CANCELLED';
export const RETURN_REFUND_PAID_OUT = 'RETURN_REFUND_PAID_OUT';
export const RETURN_CREDIT_USED = 'RETURN_CREDIT_USED';
export const RECORD_CHANGED = 'RECORD_CHANGED';
export const RETURN_STOCK_RESOLD = 'RETURN_STOCK_RESOLD';

/** Wer storniert: fern der geprüfte Absender, am Primary die Sitzung. */
export interface ReturnCancelActor {
  userId: string;
  role: string | null | undefined;
}

/** Was die Maske vor dem Klick wissen muss — am Primary live, auf PC2 aus der Auskunft des Primary. */
export interface ReturnCancelability {
  canCancel: boolean;
  blockReason: string | null;
  needsStockWarning: boolean;
}

/** Die Zeile einer Retoure, soweit Storno und Knopf sie brauchen. */
export interface ReturnCancelView {
  id: string;
  status: string;
  refundPaidAmount?: number;
  productDisposition?: string;
}

// ── Die Regeln: EINE Stelle für den Knopf und für die Hausfolge ─────────────

/** Echtes Geld ist schon hinaus (Kasse, Bank, Karte) — ein Storno holte es nur buchhalterisch zurück. */
const auszahlungGeflossen = (r: ReturnCancelView): boolean => Number(r.refundPaidAmount ?? 0) > 0.005;

/** Das Store-Guthaben aus dieser Retoure floss schon (teilweise) auf eine andere Rechnung. */
function guthabenVerbraucht(returnId: string): boolean {
  return query(
    `SELECT cc.id FROM customer_credits cc
       JOIN credit_notes cn ON cn.id = cc.source_id
      WHERE cn.sales_return_id = ? AND cc.source_type = 'sales_return'
        AND cc.used_amount > 0.005 LIMIT 1`,
    [returnId],
  ).length > 0;
}

/** Warenfolgen, deren Rücknahme nur „best effort" ist — die Maske warnt davor. */
const unsichereWarenfolge = (d: string | undefined): boolean => d === 'KEEP_AS_OWN' || d === 'RETURN_TO_OWNER';

/**
 * Darf die Maske „Cancel Return" anbieten? Dieselben Sperren wie die Hausfolge — mit den Worten, die
 * die Maske schon immer zeigte. Wirft, wenn es keine Datenbank gibt (der Aufrufer entscheidet dann).
 */
export function returnCancelability(r: ReturnCancelView): ReturnCancelability {
  if (r.status === 'REJECTED') return { canCancel: false, blockReason: 'Return is already cancelled.', needsStockWarning: false };
  if (auszahlungGeflossen(r)) {
    return {
      canCancel: false,
      blockReason: `A refund of ${Number(r.refundPaidAmount ?? 0).toFixed(3)} BHD has already been paid out — reclaim it first.`,
      needsStockWarning: false,
    };
  }
  if (guthabenVerbraucht(r.id)) {
    return { canCancel: false, blockReason: 'The store credit from this return has already been used.', needsStockWarning: false };
  }
  return { canCancel: true, blockReason: null, needsStockWarning: unsichereWarenfolge(r.productDisposition || 'IN_STOCK') };
}

// ── Die Warenfolge zurücknehmen (unverändert aus dem Store übernommen) ─────

interface RueckLine { productId?: string; quantity: number; invoiceLineId?: string }

// Best-effort Revert. KEEP_AS_OWN/RETURN_TO_OWNER nicht voll reversibel — Logwarnung statt
// stillschweigend zerstören. Läuft in der Transaktion des Aufrufers → atomar mit dem Rest.
function revertDisposition(
  db: ReturnType<typeof getDatabase>,
  lines: RueckLine[],
  disposition: ProductDisposition,
  now: string,
): void {
  for (const line of lines) {
    if (!line.productId) continue;
    const qty = Math.max(1, line.quantity || 1);

    if (disposition === 'IN_STOCK') {
      db.run(
        `UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`,
        [now, line.productId]
      );
      // Phase 5 — den per applyDisposition restored Lot wieder konsumieren.
      // Lot.qty_remaining wird um qty reduziert; bei 0 → EXHAUSTED. Spiegelt
      // die Sale-Konsumption der Original-Invoice-Line.
      if (line.invoiceLineId) {
        const ilRows = query(`SELECT lot_id FROM invoice_lines WHERE id = ?`, [line.invoiceLineId]);
        const lotId = (ilRows[0]?.lot_id as string | null) || null;
        if (lotId) {
          db.run(
            `UPDATE stock_lots
                SET qty_remaining = MAX(0, qty_remaining - ?),
                    status = CASE WHEN qty_remaining - ? <= 0 THEN 'EXHAUSTED' ELSE status END
              WHERE id = ?`,
            [qty, qty, lotId]
          );
          trackLotRow(lotId, 'update');
        }
      }
      // Phase 7 Sync — products.quantity aus Lots ableiten (ersetzt manuelles Decrement).
      syncProductQuantity(line.productId);
    } else if (disposition === 'UNDER_REPAIR' || disposition === 'WRITE_OFF') {
      db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
    } else if (disposition === 'KEEP_AS_OWN') {
      // Phase 5 — den per applyDisposition synthetisch erzeugten Lot cancellen (jüngster passender,
      // unangebrochener Lot ohne Einkauf — sonst würden bereits konsumierte Spuren ausgelöscht).
      const keepCancelId = query(
        `SELECT id FROM stock_lots
            WHERE product_id = ? AND purchase_id IS NULL AND status = 'ACTIVE'
              AND qty_remaining = qty_total
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        [line.productId]
      )[0]?.id as string | undefined;
      if (keepCancelId) {
        db.run(`UPDATE stock_lots SET status = 'CANCELLED' WHERE id = ?`, [keepCancelId]);
        trackLotRow(keepCancelId, 'update');
      }
      console.warn(`[Return] reverted KEEP_AS_OWN for product ${line.productId} — purchase_price/source_type still need manual cleanup`);
      db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
      syncProductQuantity(line.productId);
    } else if (disposition === 'RETURN_TO_OWNER') {
      // Nicht voll reversibel (Consignment-Status zurueck war auf RETURNED_TO_OWNER).
      console.warn(`[Return] cannot fully revert ${disposition} disposition for product ${line.productId} — manual cleanup may be needed`);
      db.run(`UPDATE products SET stock_status = 'sold', updated_at = ? WHERE id = ?`, [now, line.productId]);
    }
    trackProductRow(line.productId);
  }
}

// ── Die Hausfolge ───────────────────────────────────────────────────────────

export interface ReturnCancelled {
  returnId: string;
  returnNumber: string;
  invoiceId: string;
  status: 'REJECTED';
  revision: number;
  invoiceStatus: string;
  /** Zahl der Gutschriften, die storniert wurden (Hauptbuch umgekehrt, Zeile CANCELLED). */
  reversedCreditNotes: number;
  /** Ihre Nummern — sie bleiben belegt und sichtbar. */
  cancelledCreditNoteNumbers: string[];
  /** Zahl der unbenutzten Store-Guthaben, die CANCELLED wurden (nicht mehr gelöscht). */
  cancelledCustomerCredits: number;
  cardFeeRestored: number;
}

/**
 * „Cancel Return": die Retoure wird REJECTED (Zeile und Positionen bleiben — Historie), und jede
 * ihrer Wirkungen wird umgekehrt: Warenfolge/Lose, Steuerkorrektur der Rechnung, Wareneinsatz der
 * Retoure, jede Gutschrift samt unbenutztem Store-Guthaben, erstattete Kartengebühr. Gesperrt, wenn
 * Geld schon ausgezahlt oder das Guthaben schon verbraucht ist.
 *
 * `expectedRevision` (fern Pflicht) wird INNERHALB der Transaktion verglichen, vor jeder Regel.
 */
export function cancelReturnInHouse(
  returnId: string,
  reason: string,
  actor: ReturnCancelActor,
  branchId: string,
  expectedRevision?: number,
): ReturnCancelled {
  if (isClientMode()) {
    throw new ReturnCancelRejected(RETURN_PRIMARY_ONLY, 'a return is cancelled on the main computer — this window has no business database');
  }
  // Owner-only — am AUFTRAGGEBER gemessen. Fern prüft die Maschine es schon zentral (`isOwner`);
  // hier noch einmal, damit kein Weg an der Regel der Maske („perm.isOwner") vorbeikommt.
  if (canonicalRole(actor.role) !== 'ADMIN') {
    throw new ReturnCancelRejected(RETURN_OWNER_ONLY, 'Only the owner can cancel a return.');
  }
  const r = query('SELECT * FROM sales_returns WHERE id = ? AND branch_id = ?', [returnId, branchId])[0];
  if (!r) throw new ReturnCancelRejected(RETURN_NOT_FOUND, 'no such return in this branch');
  const invoiceId = String(r.invoice_id ?? '');
  const inv = query('SELECT id, status FROM invoices WHERE id = ? AND branch_id = ?', [invoiceId, branchId])[0];
  if (!inv) throw new ReturnCancelRejected(RETURN_NOT_FOUND, 'the invoice of this return is not in this branch');
  if (expectedRevision !== undefined) {
    const now = Number(r.revision ?? 0);
    if (now !== expectedRevision) {
      throw new ReturnCancelRejected(RECORD_CHANGED,
        `this return changed since you opened it (you saw ${expectedRevision}, it is now ${now}) — reopen it`);
    }
  }
  const status = String(r.status ?? 'REQUESTED');
  if (status === 'REJECTED') throw new ReturnCancelRejected(RETURN_ALREADY_CANCELLED, 'This return is already cancelled.');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!why) throw new ReturnCancelRejected(RETURN_REASON_REQUIRED, 'A reason is required to cancel a return.');
  const view: ReturnCancelView = {
    id: returnId, status, refundPaidAmount: Number(r.refund_paid_amount ?? 0),
    productDisposition: (r.product_disposition as string | null) || undefined,
  };
  // Sperre 1 — bereits ausgezahlter Refund: echtes Geld ist raus; ein Ledger-Reverse würde es nur
  // buchhalterisch zurückholen.
  if (auszahlungGeflossen(view)) {
    throw new ReturnCancelRejected(RETURN_REFUND_PAID_OUT,
      `Cannot cancel: a refund of ${Number(view.refundPaidAmount).toFixed(3)} BHD has already been paid out. Reclaim the payout first.`);
  }
  // Sperre 2 — das Store-Guthaben aus dieser Retoure floss schon auf eine andere Rechnung.
  if (guthabenVerbraucht(returnId)) {
    throw new ReturnCancelRejected(RETURN_CREDIT_USED, 'Cannot cancel this return because its customer credit has already been used.');
  }

  const db = getDatabase();
  const now = new Date().toISOString();
  const disposition = (view.productDisposition || 'IN_STOCK') as ProductDisposition;
  const wasApproved = status === 'APPROVED' || status === 'REFUNDED' || status === 'CLOSED';
  const vatCorrected = Number(r.vat_corrected ?? 0);
  const lines: RueckLine[] = query('SELECT product_id, quantity, invoice_line_id FROM sales_return_lines WHERE return_id = ?', [returnId])
    .map((l) => ({
      productId: (l.product_id as string | null) || undefined,
      quantity: Number(l.quantity ?? 1) || 1,
      invoiceLineId: (l.invoice_line_id as string | null) || undefined,
    }));
  // Sperre 3 — die zurückgenommene Ware wurde schon wieder verkauft: das Los deckt die Menge
  // nicht mehr. Der Re-Konsum unten würde still bei 0 kappen (ein Stück auf zwei Rechnungen,
  // COGS doppelt). Erst die spätere Rechnung klären, dann stornieren.
  if (disposition === 'IN_STOCK') {
    for (const line of lines) {
      if (!line.invoiceLineId) continue;
      const lot = query(
        `SELECT sl.qty_remaining FROM invoice_lines il JOIN stock_lots sl ON sl.id = il.lot_id WHERE il.id = ?`,
        [line.invoiceLineId],
      )[0];
      if (lot && Number(lot.qty_remaining ?? 0) < Math.max(1, line.quantity || 1) - 0.0005) {
        throw new ReturnCancelRejected(RETURN_STOCK_RESOLD,
          'Cannot cancel this return: the returned item has already been sold again. Resolve the later sale first.');
      }
    }
  }
  const oldSnapshot = {
    status,
    refundStatus: String(r.refund_status ?? ''),
    totalAmount: Number(r.total_amount ?? 0),
    refundPaidAmount: Number(r.refund_paid_amount ?? 0),
    vatCorrected,
    disposition,
    invoiceId,
    returnNumber: String(r.return_number ?? ''),
    invoiceStatus: String(inv.status ?? ''),
  };
  const cancelledCns: Array<{ id: string; number: string }> = [];
  const cancelledCcIds: string[] = [];
  let feeRestored = 0;
  let feeExpenseId: string | null = null;
  let invoiceTouched = false;

  // 1. Inventory/Disposition zurück (best-effort bei KEEP_AS_OWN/RETURN_TO_OWNER).
  revertDisposition(db, lines, disposition, now);

  // 2. VAT auf der Invoice wiederherstellen (nur wenn Approve sie reduziert hatte).
  if (wasApproved && vatCorrected > 0) {
    db.run(`UPDATE invoices SET vat_amount = vat_amount + ?, updated_at = ? WHERE id = ?`, [vatCorrected, now, invoiceId]);
    invoiceTouched = true;
  }

  // 3. COGS-Umkehr der Return spiegeln (greift nur bei IN_STOCK; guarded + idempotent).
  if (hasLedgerEntries('SALES_RETURN_COGS', returnId) && !hasReversalFor('SALES_RETURN_COGS', returnId)) {
    reverseSource('SALES_RETURN_COGS', returnId, now);
  }

  // 4. Pro (noch wirksamer) Gutschrift: Ledger zurück (Revenue/AR/Cash/VAT/CUSTOMER_CREDIT), das
  //    unverbrauchte Store-Guthaben (Sperre 2 garantiert used_amount = 0) und die Gutschrift selbst
  //    auf CANCELLED — Zeile, Nummer und Beträge bleiben stehen (Steuerurkunde, Historie).
  for (const cn of query(
    `SELECT id, credit_note_number FROM credit_notes WHERE sales_return_id = ? AND status != 'CANCELLED'`, [returnId],
  )) {
    const cnId = String(cn.id);
    if (hasLedgerEntries('CREDIT_NOTE', cnId) && !hasReversalFor('CREDIT_NOTE', cnId)) {
      reverseSource('CREDIT_NOTE', cnId, now);
    }
    for (const cc of query(
      `SELECT id FROM customer_credits WHERE source_type = 'sales_return' AND source_id = ? AND status != 'CANCELLED'`, [cnId],
    )) {
      db.run(`UPDATE customer_credits SET status = 'CANCELLED' WHERE id = ?`, [String(cc.id)]);
      cancelledCcIds.push(String(cc.id));
    }
    db.run(
      `UPDATE credit_notes SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?, cancel_reason = ? WHERE id = ?`,
      [now, actor.userId, why, cnId],
    );
    cancelledCns.push({ id: cnId, number: String(cn.credit_note_number ?? '') });
  }

  // 5. Karten-Gebühr-Erstattungen dieses Returns reversieren (Ledger + Expense auffüllen).
  const feeSrcs = query(
    `SELECT DISTINCT source_id FROM ledger_entries WHERE source_module = 'REFUND' AND source_id LIKE ?`,
    [`cardfee-refund:${returnId}:%`],
  );
  for (const fs of feeSrcs) {
    const sid = String(fs.source_id);
    if (!hasLedgerEntries('REFUND', sid) || hasReversalFor('REFUND', sid)) continue;
    const amtRow = query(
      `SELECT COALESCE(SUM(amount),0) a FROM ledger_entries
         WHERE source_module='REFUND' AND source_id=? AND account='EXPENSES_OPERATING'
           AND direction='CREDIT' AND reverses_entry_id IS NULL`,
      [sid],
    );
    reverseSource('REFUND', sid, now); // DR EXPENSES / CR account — Gebühr-Erstattung zurück
    feeRestored += Number(amtRow[0]?.a || 0);
  }
  if (feeRestored > 0.0005) {
    const feeRows = query(
      `SELECT id, amount FROM expenses
         WHERE category='CardFees' AND related_module='invoice' AND related_entity_id=?
         ORDER BY created_at DESC LIMIT 1`,
      [invoiceId],
    );
    if (feeRows.length) {
      feeExpenseId = String(feeRows[0].id);
      const newAmt = Math.round(((Number(feeRows[0].amount) || 0) + feeRestored) * 1000) / 1000;
      db.run(`UPDATE expenses SET amount = ?, paid_amount = ?, status = 'PAID' WHERE id = ?`, [newAmt, newAmt, feeExpenseId]);
    }
  }

  // 6. R6E — die Rechnung aus RETURNED zurückholen, wenn ihre Forderung wieder offen ist. RETURNED
  //    setzen `approveReturn`/`recordRefundPayment` genau dann, wenn Gezahltes + Gutschriften das
  //    Brutto decken — und nur aus PARTIAL/DRAFT; eine Retoure entsteht nur an einer FINAL- oder
  //    PARTIAL-Rechnung (`createReturnInHouse`). Deckt es nach dem Storno nicht mehr, ist sie wieder
  //    PARTIAL (dieselbe Ableitung wie `editInvoice` für „bezahlt < Brutto").
  const nach = query(
    `SELECT i.status, i.gross_amount, i.paid_amount,
            COALESCE((SELECT SUM(cn.receivable_cancel_amount) FROM credit_notes cn
                       WHERE cn.invoice_id = i.id AND cn.status != 'CANCELLED'), 0) AS cn_cancel
       FROM invoices i WHERE i.id = ?`,
    [invoiceId],
  )[0];
  let invoiceStatus = String(nach?.status ?? '');
  if (invoiceStatus === 'RETURNED') {
    const offen = Number(nach?.gross_amount ?? 0) - Number(nach?.paid_amount ?? 0) - Number(nach?.cn_cancel ?? 0);
    if (offen > 0.005) {
      db.run(`UPDATE invoices SET status = 'PARTIAL', updated_at = ? WHERE id = ?`, [now, invoiceId]);
      invoiceStatus = 'PARTIAL';
      invoiceTouched = true;
    }
  }

  // 7. Return auf REJECTED — Row + Lines bleiben erhalten (Historie, keine Orphans).
  db.run(`UPDATE sales_returns SET status = 'REJECTED' WHERE id = ?`, [returnId]);

  // 8. Audit ATOMAR in derselben Transaktion — mit dem Menschen, der storniert hat.
  logAuditOrThrow({
    module: 'Sales',
    entityType: 'sales_returns',
    entityId: returnId,
    action: 'STATUS_CHANGE',
    field: 'cancel',
    oldValue: oldSnapshot,
    newValue: {
      status: 'REJECTED', reason: why, invoiceId, invoiceStatus,
      reversedCreditNotes: cancelledCns.length, cancelledCreditNoteNumbers: cancelledCns.map((c) => c.number),
      cancelledCustomerCredits: cancelledCcIds.length, cardFeeRestored: feeRestored,
    },
    actor: { userId: actor.userId, branchId },
  });
  // …und je Gutschrift ein eigener Eintrag an IHRER Zeile: wer sie wann und warum storniert hat —
  // auffindbar über die Gutschrift, nicht nur über die Retoure. Ebenso atomar.
  for (const c of cancelledCns) {
    logAuditOrThrow({
      module: 'Sales',
      entityType: 'credit_notes',
      entityId: c.id,
      action: 'STATUS_CHANGE',
      field: 'status',
      oldValue: 'ISSUED',
      newValue: { status: 'CANCELLED', creditNoteNumber: c.number, returnId, reason: why, cancelledAt: now },
      actor: { userId: actor.userId, branchId },
    });
  }

  // 9. Abgleich — in der Transaktion: ein Rollback verwirft auch diese Zeilen (`saveDatabase` wartet
  //    in einer offenen Transaktion auf deren Ende). Die Rechnung geht jetzt mit (Steuer, Status).
  //    Gutschrift und Guthaben reisen als Änderung (volle Zeile mit Status), nicht als Löschung.
  trackChange('sales_returns', returnId, 'update', { status: 'REJECTED', cancelReason: why });
  for (const c of cancelledCns) trackChange('credit_notes', c.id, 'update', { status: 'CANCELLED' });
  for (const ccId of cancelledCcIds) trackChange('customer_credits', ccId, 'update', { status: 'CANCELLED' });
  if (feeExpenseId && feeRestored > 0.0005) trackChange('expenses', feeExpenseId, 'update', { cardFeeRestored: feeRestored });
  if (invoiceTouched) trackChange('invoices', invoiceId, 'update', {});

  const rev = Number(query('SELECT revision FROM sales_returns WHERE id = ?', [returnId])[0]?.revision ?? 0);
  return {
    returnId,
    returnNumber: oldSnapshot.returnNumber,
    invoiceId,
    status: 'REJECTED',
    revision: rev,
    invoiceStatus,
    reversedCreditNotes: cancelledCns.length,
    cancelledCreditNoteNumbers: cancelledCns.map((c) => c.number),
    cancelledCustomerCredits: cancelledCcIds.length,
    cardFeeRestored: feeRestored,
  };
}

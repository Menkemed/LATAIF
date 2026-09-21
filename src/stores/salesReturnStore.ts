// ═══════════════════════════════════════════════════════════
// LATAIF — Sales Returns (Plan §Returns)
// ═══════════════════════════════════════════════════════════
// Refactor 2026-05 — clean refund/CN wiring:
//  - createReturn: status=REQUESTED, refund_status=PENDING_REFUND, applies product
//    disposition NOW (User-Spec: Disposition beim Anlegen). KEINE CN, KEIN Cash.
//  - approveReturn: status=APPROVED, erstellt Credit Note (Industry Standard) und
//    revertiert VAT auf Invoice. KEIN Cash bewegt sich.
//  - recordRefundPayment: tatsächlicher Cash-Out → Banking ↓, refund_paid_amount ↑,
//    CN cashRefund/receivableCancel-Split wird live nachgezogen, refund_status
//    transitioned. Auto-approve, falls noch REQUESTED, damit CN garantiert existiert.
//  - refundReturn: Convenience-Wrapper (approve + recordRefundPayment in einem).
//  - cancelReturn: einheitlicher Storno (UI: Owner-only). R6E — die Folge wohnt jetzt in
//    `core/returns/return-cancel-house` (dieselbe für den Fernbefehl `returns.cancel`); hier nur
//    noch der Anschluss der Maske: Owner der Sitzung, EINE Klammer über `runOnPrimary`.
//    Idempotent am Primary (schon REJECTED → No-op). Ersetzt die alten reject/delete-Pfade.

import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { SalesReturn, SalesReturnLine, SalesReturnStatus, RefundStatus, ProductDisposition } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate, trackStatusChange, trackRefund } from '@/core/sync/track';
import { trackChange } from '@/core/sync/sync-service';
import { useAuthStore } from '@/stores/authStore';
import { canonicalRole } from '@/core/models/types';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import {
  postCreditNote,
  postSalesReturnCogs,
  reverseSource,
  hasLedgerEntries,
  hasReversalFor,
} from '@/core/ledger/posting';
import { restoreLot, syncProductQuantity, trackLotRow, trackProductRow } from '@/core/lots/lot-queries';
// CENTRAL-UI-PARITY R6E — der Storno ist EINE Hausfolge (Primary und PC2); der Store ist nur Anschluss.
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import {
  ReturnCancelRejected, RETURN_OWNER_ONLY, RETURN_PRIMARY_ONLY, cancelReturnInHouse, returnCancelability,
  type ReturnCancelability,
} from '@/core/returns/return-cancel-house';
import type { CreditNote } from '@/core/models/types';
import { refundCardFeePortion } from '@/core/finance/card-fee-booking';
import { computeCardFee, normalizeCardBrand } from '@/core/finance/card-fees';
// CENTRAL-UI-PARITY — auf einem Rechner ohne Datenbank holt derselbe Aufruf den Stand vom Primary.
import { hydrateFromPrimary, readsFromPrimary } from '@/core/data/primary-source';
// CENTRAL-UI-PARITY R1 — der Ausweis der Leseanfrage reist als Parameter, nicht als globaler
// Zustand: am Primary aus der eigenen Sitzung, aus der Ferne aus dem geprueften Absender.
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';

// Wenn sich CN.cash_refund_amount oder refund_method nach erstem Posting aendert,
// urspruengliche Buchung reverten + neu posten — sonst zeigen CASH/BANK-Salden im
// Ledger den falschen Refund-Pfad. Hilfsfunktion ist zentral, da gleicher Pattern
// nach jedem CN-UPDATE noetig ist.
function repostCreditNoteFromCnId(cnId: string, occurredAt: string): void {
  try {
    // v0.7.3 — credit_notes hatte keine status-Spalte; seit R6E-CN hat sie eine (ISSUED/CANCELLED).
    const cnRow = query(
      `SELECT id, credit_note_number, branch_id, customer_id, invoice_id, sales_return_id,
              total_amount, vat_amount, cash_refund_amount, receivable_cancel_amount,
              refund_method, reason, notes, issued_at, created_at, status
         FROM credit_notes WHERE id = ?`,
      [cnId]
    )[0];
    if (!cnRow) return;
    // R6E-CN — eine stornierte Gutschrift wird nie neu gebucht (ihr Storno bliebe sonst wirkungslos).
    if (String(cnRow.status ?? 'ISSUED') === 'CANCELLED') return;
    if (hasLedgerEntries('CREDIT_NOTE', cnId) && !hasReversalFor('CREDIT_NOTE', cnId)) {
      reverseSource('CREDIT_NOTE', cnId, occurredAt);
    }
    const cn: CreditNote = {
      id: cnRow.id as string,
      creditNoteNumber: cnRow.credit_note_number as string,
      branchId: cnRow.branch_id as string,
      customerId: cnRow.customer_id as string,
      invoiceId: cnRow.invoice_id as string,
      salesReturnId: (cnRow.sales_return_id as string) || undefined,
      totalAmount: Number(cnRow.total_amount || 0),
      vatAmount: Number(cnRow.vat_amount || 0),
      cashRefundAmount: Number(cnRow.cash_refund_amount || 0),
      receivableCancelAmount: Number(cnRow.receivable_cancel_amount || 0),
      refundMethod: (cnRow.refund_method as CreditNote['refundMethod']) || 'bank',
      reason: (cnRow.reason as string) || undefined,
      notes: (cnRow.notes as string) || undefined,
      issuedAt: cnRow.issued_at as string,
      createdAt: cnRow.created_at as string,
    };
    postCreditNote(cn);
  } catch (err) {
    console.error('[ledger] repostCreditNote failed:', err);
  }
}

// ── Helpers ────────────────────────────────────────────────

// Disposition auf Produkt anwenden (Plan §Returns §6 + §Commission §13).
// Wird in createReturn aufgerufen — Ware ist physisch zurück, Status muss reflektieren.
//
// Phase 5 — Lot-Logik je Disposition:
//   - IN_STOCK: invoice_line.lot_id finden + restoreLot(qty). Originaler Cost-Provenance bleibt.
//   - KEEP_AS_OWN: NEUEN Lot an unitPrice (= Sale-Preis als Acquisition-Cost). Originaler Lot
//     bleibt EXHAUSTED — die Ware ist effektiv "verkauft & zurueckgekauft".
//   - RETURN_TO_OWNER / WRITE_OFF / UNDER_REPAIR: kein Lot-Restore (Ware nicht im Verkauf-Bestand).
function applyDisposition(
  db: ReturnType<typeof getDatabase>,
  lines: Array<{ productId?: string; quantity: number; unitPrice: number; invoiceLineId?: string }>,
  disposition: ProductDisposition,
  now: string,
  branchId: string,
): void {
  for (const line of lines) {
    if (!line.productId) continue;
    const qty = Math.max(1, line.quantity || 1);

    if (disposition === 'RETURN_TO_OWNER') {
      // Plan §Commission §13 A — Ware verlässt System, Consignment auf RETURNED_TO_OWNER.
      db.run(`UPDATE products SET stock_status = 'returned', updated_at = ? WHERE id = ?`, [now, line.productId]);
      db.run(
        `UPDATE consignments SET status = 'RETURNED_TO_OWNER', updated_at = ?
         WHERE product_id = ? AND status IN ('sold','SOLD','paid_out','active','IN_STOCK')`,
        [now, line.productId]
      );
    } else if (disposition === 'KEEP_AS_OWN') {
      // Plan §Commission §13 B — bleibt im System als OWN, purchase_price = letzter Verkaufspreis.
      db.run(
        `UPDATE products SET stock_status = 'in_stock', source_type = 'OWN',
         purchase_price = COALESCE(?, purchase_price), updated_at = ? WHERE id = ?`,
        [line.unitPrice ?? null, now, line.productId]
      );
      db.run(
        `UPDATE consignments SET status = 'RETURNED', updated_at = ?
         WHERE product_id = ? AND status IN ('sold','SOLD','paid_out','active','IN_STOCK')`,
        [now, line.productId]
      );
      // Phase 5 — neuer Lot an Sale-Preis als Acquisition-Cost.
      // Den alten (verkauften) Lot lassen wir EXHAUSTED — wirtschaftlich korrekt:
      // Die Ware war verkauft, jetzt haben wir sie zum unitPrice "zurueckgekauft".
      if (line.unitPrice && line.unitPrice > 0) {
        const keepLotId = uuid();   // LAN-Sync Phase 1a
        db.run(
          `INSERT INTO stock_lots
             (id, branch_id, product_id, purchase_id, purchase_line_id,
              unit_cost, qty_total, qty_remaining, status, acquired_at, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 'ACTIVE', ?, ?)`,
          [keepLotId, branchId, line.productId, line.unitPrice, qty, qty, now.split('T')[0], now]
        );
        trackLotRow(keepLotId, 'insert');
      }
      // Phase 7 Sync: products.quantity aus den jetzt korrekten Lots.
      syncProductQuantity(line.productId);
    } else if (disposition === 'IN_STOCK') {
      // Stock-Status + last_updated; quantity wird unten durch syncProductQuantity gesetzt.
      db.run(
        `UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [now, line.productId]
      );
      // Phase 5 — Original-Lot der Sale-Line wieder freigeben (qty zurueckgeben).
      // So bleibt Cost-Provenance erhalten: Wenn die Ware spaeter neu verkauft
      // wird, kommt der korrekte alte Cost-Snapshot raus.
      if (line.invoiceLineId) {
        const ilRows = query(`SELECT lot_id FROM invoice_lines WHERE id = ?`, [line.invoiceLineId]);
        const lotId = (ilRows[0]?.lot_id as string | null) || null;
        if (lotId) restoreLot(lotId, qty);
      }
      // Phase 7 Sync — products.quantity = Σ qty_remaining; ersetzt das frueher manuelle Increment.
      syncProductQuantity(line.productId);
    } else {
      const newStatus = disposition === 'UNDER_REPAIR' ? 'in_repair'
        : disposition === 'WRITE_OFF' ? 'write_off'
        : 'in_stock';
      db.run(`UPDATE products SET stock_status = ?, updated_at = ? WHERE id = ?`, [newStatus, now, line.productId]);
    }
    trackProductRow(line.productId);   // LAN-Sync Phase 1b: finaler Product-Snapshot je Line
  }
}

// R6E — die Rücknahme der Warenfolge (`revertDisposition`) wohnt jetzt bei ihrer einzigen Nutzerin,
// der Storno-Hausfolge `core/returns/return-cancel-house`.

// R5F FINAL — Geld auf Fils (BHD, 3 Stellen). Ein Drittel einer Zeile ist 333,333…; ohne Runden blieb nach
// einem Storno ein Gleitkomma-Rest (5,7e-14), den eine offene Retoure noch „erstatten" konnte.
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

// Berechnet Cash-Refundability nach Industriestandard (SAP/Xero/QuickBooks):
//   cashRefund = max(0, customerPaid − (invoiceGross − allReturns) − otherRefundsAlreadyPaid)
// d. h. nur was Customer NACH Returns überzahlt hat ist cash-pflichtig zurückzugeben.
function computeRefundSplit(
  returnId: string,
  invoiceId: string,
  totalAmount: number,
): { cashRefundCap: number; receivableCancel: number; customerPaid: number; invoiceGross: number } {
  const invRow = query('SELECT paid_amount, gross_amount FROM invoices WHERE id = ?', [invoiceId])[0];
  const customerPaid = (invRow?.paid_amount as number) || 0;
  const invoiceGross = (invRow?.gross_amount as number) || 0;

  const otherReturnsRow = query(
    `SELECT COALESCE(SUM(total_amount), 0) AS s
     FROM sales_returns
     WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
    [invoiceId, returnId]
  )[0];
  const otherReturnsTotal = (otherReturnsRow?.s as number) || 0;

  const otherRefundsRow = query(
    `SELECT COALESCE(SUM(refund_paid_amount), 0) AS s
     FROM sales_returns
     WHERE invoice_id = ? AND id != ? AND status != 'REJECTED'`,
    [invoiceId, returnId]
  )[0];
  const otherRefundsAlreadyPaid = (otherRefundsRow?.s as number) || 0;

  const owedAfterAllReturns = Math.max(0, invoiceGross - otherReturnsTotal - totalAmount);
  const surplus = Math.max(0, customerPaid - owedAfterAllReturns - otherRefundsAlreadyPaid);
  const cashRefundCap = r3(Math.min(totalAmount, surplus));
  const receivableCancel = r3(Math.max(0, totalAmount - cashRefundCap));

  return { cashRefundCap, receivableCancel, customerPaid, invoiceGross };
}

// ── Store ──────────────────────────────────────────────────

interface SalesReturnStore {
  returns: SalesReturn[];
  loadReturns: () => void;
  getReturn: (id: string) => SalesReturn | undefined;
  createReturn: (input: {
    invoiceId: string;
    returnDate?: string;
    refundMethod?: 'cash' | 'bank' | 'benefit' | 'card' | 'credit' | 'other';
    productDisposition?: ProductDisposition;
    reason?: string;
    notes?: string;
    staffId?: string;
    lines: Array<{
      invoiceLineId: string;
      productId?: string;
      quantity: number;
      unitPrice: number;
      vatAmount: number;
    }>;
  }) => SalesReturn;
  approveReturn: (id: string) => void;
  refundReturn: (id: string, partialAmount?: number) => void;
  // deductCardFee (Slice 5): bei method cash/bank zieht es die anteilige Original-
  // Karten-Gebuehr vom Refund ab (Kunde traegt sie). Bei method 'card' wird die Gebuehr
  // immer anteilig erstattet (Flag irrelevant).
  recordRefundPayment: (returnId: string, amount: number, method: 'cash' | 'bank' | 'benefit' | 'card' | 'credit' | 'other', date?: string, deductCardFee?: boolean) => void;
  // Einheitlicher Storno (Owner-only via UI). Atomar, behaelt die Row als REJECTED.
  // R6E — der Anschluss der Maske an die Hausfolge: EINE Klammer, erst danach durabel.
  cancelReturn: (id: string, reason: string) => Promise<void>;
  // R6E — die Storno-Auskunft je Retoure, wie sie der Primary mit der Liste ausliefert (PC2 hat
  // keine Datenbank, um sie selbst zu fragen).
  cancelability: Record<string, ReturnCancelability>;
  // Vorab-Pruefung fuer die UI: ob/warum ein Return (nicht) stornierbar ist + Lager-Warnflag.
  getReturnCancelability: (id: string) => ReturnCancelability;
  getInvoiceReturnSummary: (invoiceId: string, invoiceGross: number, invoicePaid?: number) => {
    returns: SalesReturn[];
    totalReturned: number;
    totalRefundPaid: number;
    outstandingRefund: number;
    returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED';
    refundState: RefundStatus;
  };
  getCustomerRefundPayable: (customerId: string) => number;
  // Slice 5 — Karten-Zahlungs-Info der Original-Invoice (fuer die 3-Wege-Refund-UI).
  getInvoiceCardInfo: (invoiceId: string) => { cardPaid: number; brand: 'normal' | 'amex'; activeFee: number };
  getReturnedQtyForLine: (invoiceLineId: string) => number;
}

function rowToReturn(row: Record<string, unknown>): SalesReturn {
  const rawStatus = row.refund_status as RefundStatus | undefined;
  return {
    // R4C — die Fassung reist mit; ohne sie kann ein Auftrag nicht sagen, WORAUF er sich bezieht.
    revision: row.revision === undefined || row.revision === null ? undefined : Number(row.revision),
    id: row.id as string,
    returnNumber: row.return_number as string,
    branchId: row.branch_id as string,
    invoiceId: row.invoice_id as string,
    customerId: row.customer_id as string,
    status: (row.status as SalesReturnStatus) || 'REQUESTED',
    totalAmount: (row.total_amount as number) || 0,
    vatCorrected: (row.vat_corrected as number) || 0,
    returnDate: row.return_date as string,
    refundMethod: row.refund_method as 'cash' | 'bank' | 'benefit' | 'card' | 'credit' | 'other' | undefined,
    refundAmount: (row.refund_amount as number) || 0,
    refundPaidAmount: (row.refund_paid_amount as number) || 0,
    refundPaidDate: (row.refund_paid_date as string | null) || undefined,
    // Legacy 'NOT_REFUNDED' wird auf 'PENDING_REFUND' normalisiert (semantisch identisch).
    refundStatus: rawStatus === 'NOT_REFUNDED' ? 'PENDING_REFUND' : (rawStatus || 'PENDING_REFUND'),
    productDisposition: row.product_disposition as ProductDisposition | undefined,
    reason: (row.reason as string | null) || undefined,
    notes: row.notes as string | undefined,
    lines: [],
    staffId: (row.staff_id as string) || undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

function rowToLine(row: Record<string, unknown>): SalesReturnLine {
  return {
    id: row.id as string,
    returnId: row.return_id as string,
    invoiceLineId: row.invoice_line_id as string | undefined,
    productId: row.product_id as string | undefined,
    quantity: (row.quantity as number) || 1,
    unitPrice: (row.unit_price as number) || 0,
    vatAmount: (row.vat_amount as number) || 0,
    lineTotal: (row.line_total as number) || 0,
  };
}

export const useSalesReturnStore = create<SalesReturnStore>((set, get) => ({
  returns: [],
  cancelability: {},

  loadReturns: () => {
    if (hydrateFromPrimary('store.sales_returns.get', (d) => set(d as never))) return;
    try {
      set(loadSalesReturnsFor(localReadContext()));
    } catch { set({ returns: [], cancelability: {} }); }
  },

  getReturn: (id) => get().returns.find(r => r.id === id),

  // ── Create ───────────────────────────────────────────────
  // Plan 2026-05: Disposition wird sofort angewandt. KEINE CN, KEIN Cash.
  // Refund-Status startet als PENDING_REFUND.
  createReturn: (input) => {
    if (!input.lines || input.lines.length === 0) {
      throw new Error('Return must include at least one line.');
    }
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const invRows = query('SELECT customer_id FROM invoices WHERE id = ?', [input.invoiceId]);
    const customerId = invRows[0]?.customer_id as string;

    // Per-Line Cap & Validierung.
    for (const l of input.lines) {
      if (!Number.isFinite(l.quantity) || l.quantity < 0) {
        throw new Error('Return quantity must be a non-negative number.');
      }
      if (!Number.isFinite(l.unitPrice) || l.unitPrice < 0) {
        throw new Error('Return unit price must be non-negative.');
      }
      const lineRows = query(
        `SELECT
           (SELECT quantity FROM invoice_lines WHERE id = ?) AS orig_qty,
           COALESCE((
             SELECT SUM(srl.quantity) FROM sales_return_lines srl
             JOIN sales_returns r ON r.id = srl.return_id
             WHERE srl.invoice_line_id = ? AND r.status != 'REJECTED'
           ), 0) AS already_returned`,
        [l.invoiceLineId, l.invoiceLineId]
      );
      const origQty = Number(lineRows[0]?.orig_qty || 0);
      const alreadyReturned = Number(lineRows[0]?.already_returned || 0);
      const remaining = Math.max(0, origQty - alreadyReturned);
      if (l.quantity > remaining + 0.005) {
        throw new Error(
          `Return quantity ${l.quantity} exceeds remaining ${remaining.toFixed(2)} (original ${origQty}, already returned ${alreadyReturned}).`
        );
      }
    }

    const returnNumber = getNextDocumentNumber('RET');
    const returnDate = input.returnDate || now.split('T')[0];
    const total = input.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
    const vatCorrected = input.lines.reduce((s, l) => s + l.vatAmount, 0);
    const disposition: ProductDisposition = input.productDisposition || 'IN_STOCK';

    db.run(
      `INSERT INTO sales_returns (id, branch_id, return_number, invoice_id, customer_id, status, total_amount,
        vat_corrected, return_date, refund_method, refund_amount, refund_paid_amount, refund_status,
        product_disposition, reason, notes, staff_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, 0, 0, 'PENDING_REFUND', ?, ?, ?, ?, ?, ?)`,
      [id, branchId, returnNumber, input.invoiceId, customerId, total, vatCorrected, returnDate,
       input.refundMethod || null, disposition,
       input.reason || null, input.notes || null, input.staffId || null, now, userId]
    );

    const stmt = db.prepare(
      `INSERT INTO sales_return_lines (id, return_id, invoice_line_id, product_id, quantity, unit_price, vat_amount, line_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // LAN-Sync (Bug-3b): inline uuid() in kanonische Variable umstellen → Line-IDs trackbar.
    const srLineIds: string[] = [];
    for (const l of input.lines) {
      const srLineId = uuid();
      srLineIds.push(srLineId);
      stmt.run([srLineId, id, l.invoiceLineId, l.productId || null, l.quantity, l.unitPrice, l.vatAmount, l.quantity * l.unitPrice]);
    }
    stmt.free();

    // Plan 2026-05 §C: Disposition beim Anlegen anwenden — Ware ist physisch retour.
    applyDisposition(db, input.lines, disposition, now, branchId);

    // Slice 2 — Wareneinsatz (COGS) zurueckdrehen, NUR wenn die Ware real wieder
    // Verkaufsbestand wird (IN_STOCK). Bei KEEP_AS_OWN/WRITE_OFF/RETURN_TO_OWNER
    // bleibt der Original-COGS gueltig. Self-Guard in postSalesReturnCogs: ohne
    // gebuchten Original-COGS (Legacy) passiert nichts.
    if (disposition === 'IN_STOCK') {
      try {
        postSalesReturnCogs(
          id,
          input.lines.map(l => ({ invoiceLineId: l.invoiceLineId, productId: l.productId, quantity: l.quantity })),
          now
        );
      } catch (err) { console.error('[ledger] postSalesReturnCogs failed:', err); }
    }

    saveDatabase();
    trackInsert('sales_returns', id, { returnNumber, invoiceId: input.invoiceId, total });
    // LAN-Sync (Bug-3b): sales_return_lines NACH dem Header tracken (FK-Reihenfolge), sync-only.
    for (const srLineId of srLineIds) trackChange('sales_return_lines', srLineId, 'insert', {});
    get().loadReturns();
    return get().getReturn(id)!;
  },

  // ── Approve ──────────────────────────────────────────────
  // Plan 2026-05 §B: Approve = formaler Buchungsschritt. Erstellt Credit Note
  // (Industry Standard, auch bei unbezahlter Invoice → cashRefund=0, receivableCancel=total).
  // VAT auf Invoice wird hier reduziert. Cash bewegt sich NICHT.
  approveReturn: (id) => {
    const r = get().getReturn(id);
    if (!r) return;
    // Idempotent: schon approved oder weiter im Lifecycle → no-op.
    if (r.status === 'APPROVED' || r.status === 'REFUNDED' || r.status === 'CLOSED' || r.status === 'REJECTED') {
      return;
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // Cash/Receivable-Split berechnen (Industriestandard).
    const { cashRefundCap, receivableCancel } = computeRefundSplit(id, r.invoiceId, r.totalAmount);

    // Credit Note erstellen — eigenständige Steuerurkunde, 1:1 zum Return.
    try {
      useCreditNoteStore.getState().createCreditNote({
        invoiceId: r.invoiceId,
        customerId: r.customerId,
        salesReturnId: r.id,
        totalAmount: r.totalAmount,
        vatAmount: r.vatCorrected || 0,
        cashRefundAmount: cashRefundCap,
        receivableCancelAmount: receivableCancel,
        refundMethod: r.refundMethod,
        reason: r.reason,
        notes: r.notes,
      });
    } catch (e) {
      console.warn('[Return] credit note auto-creation failed:', e);
      throw new Error(`Approve failed: credit note could not be created — ${e instanceof Error ? e.message : String(e)}`);
    }

    // VAT-Korrektur auf Invoice — CN ist die Steuerurkunde, die VAT-Pflicht reversiert.
    // Voll, nicht proportional zu Cash (Receivable-Cancel reversiert ebenfalls VAT).
    // LAN-Sync (Gruppe 1): ob die Invoice-Header-Row angefasst wurde (VAT-Korrektur und/oder
    // RETURNED) → genau EIN finaler Invoice-Snapshot am Ende, statt mehrerer Zwischen-Emits.
    let invoiceTouched = false;
    if ((r.vatCorrected || 0) > 0) {
      db.run(
        `UPDATE invoices SET vat_amount = MAX(0, vat_amount - ?), updated_at = ? WHERE id = ?`,
        [r.vatCorrected || 0, now, r.invoiceId]
      );
      invoiceTouched = true;
    }

    // M-01: Customer-LTV wird hier NICHT mehr reduziert — die stalen
    // customers.total_*-Spalten sind als Quelle abgeschafft; Refund-Abzuege
    // rechnet computeSalesMetrics aus refund_paid_amount selbst (anteilig).

    // Nach CN-Erstellung: wenn effektives Invoice-Outstanding (gross - paid - Σ CN.cancel) = 0,
    // Invoice auf RETURNED setzen (Forderung vollständig durch Return abgedeckt).
    try {
      // R6E-CN — nur wirksame Gutschriften decken die Forderung (eine stornierte nicht mehr).
      const invCheck = query(
        `SELECT i.gross_amount, i.paid_amount,
                COALESCE((SELECT SUM(cn.receivable_cancel_amount) FROM credit_notes cn
                           WHERE cn.invoice_id = i.id AND cn.status != 'CANCELLED'), 0) AS cn_cancel
         FROM invoices i WHERE i.id = ?`,
        [r.invoiceId]
      )[0];
      if (invCheck) {
        const gross = (invCheck.gross_amount as number) || 0;
        const paid  = (invCheck.paid_amount as number)  || 0;
        const cancel= (invCheck.cn_cancel as number)    || 0;
        if (gross > 0 && (gross - paid - cancel) <= 0.005) {
          db.run(
            `UPDATE invoices SET status = 'RETURNED', updated_at = ? WHERE id = ? AND status IN ('PARTIAL', 'DRAFT')`,
            [now, r.invoiceId]
          );
          invoiceTouched = true;
        }
      }
    } catch (e) {
      console.warn('[Return] invoice status update check failed:', e);
    }

    db.run(`UPDATE sales_returns SET status = 'APPROVED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r.status, 'APPROVED');
    // LAN-Sync (Gruppe 1): sales_returns-Status-Snapshot + ggf. Invoice (VAT/RETURNED) — audit-only zuvor.
    trackChange('sales_returns', id, 'update', {});
    if (invoiceTouched) trackChange('invoices', r.invoiceId, 'update', {});
    get().loadReturns();
  },

  // ── Refund (convenience wrapper) ─────────────────────────
  // Plan 2026-05: Ruft approveReturn (idempotent) + recordRefundPayment(cap) auf.
  // KEIN eigener CN-Code mehr.
  refundReturn: (id, partialAmount) => {
    const r = get().getReturn(id);
    if (!r) return;
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }

    // 1) Approve (idempotent — erstellt CN + reduziert VAT, falls noch nicht passiert).
    if (r.status === 'REQUESTED') {
      get().approveReturn(id);
    }
    const r2 = get().getReturn(id);
    if (!r2) return;

    // 2) Cap berechnen — wieviel Cash kann tatsächlich zurückfließen.
    const { cashRefundCap } = computeRefundSplit(id, r2.invoiceId, r2.totalAmount);
    const remainingCashRefundable = Math.max(0, r3(cashRefundCap - (r2.refundPaidAmount || 0)));
    const requestedAmount = typeof partialAmount === 'number' && partialAmount >= 0 && partialAmount <= r2.totalAmount
      ? partialAmount
      : r2.totalAmount;
    const refundAmount = r3(Math.min(requestedAmount, remainingCashRefundable));

    // 3a) Cash fließt → recordRefundPayment.
    if (refundAmount > 0) {
      get().recordRefundPayment(id, refundAmount, r2.refundMethod || 'cash');
      return;
    }

    // 3b) Kein Cash refundbar (Customer hat noch nichts gezahlt) → CN ist ausreichend,
    // Return-Status auf REFUNDED (nichts mehr zu tun aus Buchhaltungssicht).
    const db = getDatabase();
    db.run(`UPDATE sales_returns SET status = 'REFUNDED' WHERE id = ?`, [id]);
    saveDatabase();
    trackStatusChange('sales_returns', id, r2.status, 'REFUNDED');
    trackChange('sales_returns', id, 'update', {});   // LAN-Sync (Gruppe 1): Status-Snapshot (audit-only zuvor)
    get().loadReturns();
  },

  // ── Record Refund Payment ────────────────────────────────
  // Cash fließt tatsächlich → Banking ↓, refund_paid_amount ↑, CN-Split-Update.
  // Auto-approve, falls noch REQUESTED, damit CN garantiert existiert wenn Geld bewegt wird.
  recordRefundPayment: (returnId, amount, method, date, deductCardFee) => {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Refund payment amount must be a positive number.');
    }
    const db = getDatabase();
    let r = get().getReturn(returnId);
    if (!r) return;
    if (r.refundStatus === 'REFUNDED') { console.warn('[Return] already fully refunded'); return; }

    // Auto-approve falls noch REQUESTED — CN muss existieren bevor Cash fließt.
    if (r.status === 'REQUESTED') {
      get().approveReturn(returnId);
      r = get().getReturn(returnId);
      if (!r) return;
    }

    // Credit-Modell-Härtung — Methoden-Riegel (Altdaten/programmatische Aufrufe; die UI
    // erreicht diesen Mismatch nicht). Wahrheit = Domain-Row: existiert für diesen Return
    // ein Store-Guthaben (customer_credits via CN), darf NUR method='credit' durch —
    // jede Cash-Methode würde zusätzlich auszahlen, während die einlösbare Credit-Row
    // stehen bliebe (Doppel-Auszahlung + Domain≠Ledger nach Repost). Umgekehrt darf
    // 'credit' ohne Domain-Row nicht durch: der Repost buchte CR CUSTOMER_CREDIT, aber
    // die einlösbare Row entsteht nur in createCreditNote (Phantom-Guthaben, L-01).
    // Sauberer Weg bei gewünschtem Cash: Return löschen (baut Credit-Row ab) + neu anlegen.
    // R6E-CN — nur ein WIRKSAMES Guthaben einer wirksamen Gutschrift zählt (CANCELLED ist Historie).
    const ccRows = query(
      `SELECT cc.id FROM customer_credits cc
         JOIN credit_notes cn ON cn.id = cc.source_id AND cc.source_type = 'sales_return'
        WHERE cn.sales_return_id = ? AND cn.status != 'CANCELLED' AND cc.status != 'CANCELLED' LIMIT 1`,
      [returnId]
    );
    const hasStoreCredit = ccRows.length > 0;
    if (hasStoreCredit && method !== 'credit') {
      throw new Error('This return was settled as store credit — a cash payout would pay the customer twice. Delete the return and re-create it with a cash method if needed.');
    }
    if (!hasStoreCredit && method === 'credit') {
      throw new Error("Store credit can only be granted when the return is created with refund method 'Store Credit'.");
    }

    // Teil-Erstattungen: die Gutschrift wird mit EINEM Konto (refund_method) neu gebucht — ein
    // Methodenwechsel zoege frühere Teilbeträge still auf das neue Konto (Kasse/Bank verfälscht).
    if ((r.refundPaidAmount || 0) > 0.005 && r.refundMethod && method !== r.refundMethod) {
      throw new Error(`This return was already partly refunded by ${r.refundMethod}. Refund the rest by ${r.refundMethod} as well.`);
    }

    const remaining = Math.max(0, r.totalAmount - (r.refundPaidAmount || 0));
    if (remaining <= 0.005) { console.warn('[Return] nothing left to refund'); return; }

    // Cap: Cash-Refundability laut Industriestandard (Customer-Surplus nach allen Returns).
    const { cashRefundCap } = computeRefundSplit(returnId, r.invoiceId, r.totalAmount);
    const refundableNow = Math.max(0, r3(cashRefundCap - (r.refundPaidAmount || 0)));
    const cappedAmount = r3(Math.min(amount, refundableNow, remaining));

    if (cappedAmount <= 0) {
      console.warn('[Return] no cash refundable now — customer surplus exhausted');
      return;
    }

    const newPaid = r3((r.refundPaidAmount || 0) + cappedAmount);
    const newRefundStatus: RefundStatus = newPaid >= r.totalAmount - 0.005 ? 'REFUNDED'
      : newPaid > 0 ? 'PARTIALLY_REFUNDED'
      : 'PENDING_REFUND';
    // Voll erstattet → Return-Status auch auf REFUNDED.
    const newReturnStatus = newRefundStatus === 'REFUNDED' ? 'REFUNDED' : r.status;

    const now = new Date().toISOString();
    const refundDate = date || now.split('T')[0];

    db.run(
      `UPDATE sales_returns SET refund_paid_amount = ?, refund_paid_date = ?,
        refund_method = ?, refund_status = ?, status = ?,
        refund_amount = MAX(refund_amount, ?) WHERE id = ?`,
      [newPaid, refundDate, method, newRefundStatus, newReturnStatus, newPaid, returnId]
    );

    if (cappedAmount > 0 && method !== 'credit') {
      trackRefund('sales_returns', returnId, cappedAmount, method);
    }
    saveDatabase();
    trackUpdate('sales_returns', returnId, { refundPayment: cappedAmount, method, date: refundDate, status: newRefundStatus });

    // CN-Sync: cashRefund/receivableCancel-Split nachziehen.
    try {
      // R6E-CN — eine stornierte Gutschrift wird nicht nachgezogen (und nie neu gebucht).
      const cnRows = query(
        `SELECT id, total_amount FROM credit_notes WHERE sales_return_id = ? AND status != 'CANCELLED' LIMIT 1`,
        [returnId]
      );
      if (cnRows.length > 0) {
        const cnId = cnRows[0].id as string;
        const cnTotal = (cnRows[0].total_amount as number) || 0;
        const newCancel = Math.max(0, cnTotal - newPaid);
        db.run(
          `UPDATE credit_notes SET cash_refund_amount = ?, receivable_cancel_amount = ?, refund_method = COALESCE(?, refund_method) WHERE id = ?`,
          [newPaid, newCancel, method, cnId]
        );
        saveDatabase();
        trackUpdate('credit_notes', cnId, { cashRefundAmount: newPaid, receivableCancelAmount: newCancel });
        useCreditNoteStore.getState().loadCreditNotes();

        // Cash/AR-Split hat sich geaendert (oder Method) — Original-Posting reverten und mit
        // neuem Stand frisch posten, damit CASH/BANK-Saldo im Ledger den tatsaechlichen
        // Refund-Pfad reflektiert.
        repostCreditNoteFromCnId(cnId, now);
      }
    } catch (e) {
      console.warn('[Return] credit note update failed:', e);
    }

    // ── SLICE 5 — Karten-Gebuehr beim Refund (3-Wege) ─────────────────────
    // Nur wenn die Original-Invoice (anteilig) per Karte gezahlt wurde.
    //   ① method 'card'                  → Processor erstattet Gebuehr (DR CARD_CLEARING)
    //   ③ method cash/bank + deductFee   → Kunde traegt Gebuehr   (DR CASH/BANK)
    //   ② method cash/bank ohne Flag     → Shop frisst Gebuehr    (nichts buchen)
    // Die anteilige Gebuehr bezieht sich auf DIESEN Refund-Betrag (cappedAmount),
    // gecapped auf den Karten-Anteil — so summieren mehrere Teil-Refunds nie ueber die
    // Original-Gebuehr hinaus, und refundCardFeePortion cappt zusaetzlich am Rest.
    try {
      const cardRow = query(
        `SELECT COALESCE(SUM(amount),0) AS paid, MAX(card_brand) AS brand
           FROM payments WHERE invoice_id = ? AND method = 'card'`,
        [r.invoiceId]
      )[0];
      const cardPaid = Number(cardRow?.paid || 0);
      const feeRelevant = method === 'card' || (deductCardFee && (method === 'cash' || method === 'bank'));
      if (cardPaid > 0 && feeRelevant) {
        let branchId: string; let userId: string;
        try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }
        try { userId = currentUserId(); } catch { userId = 'system'; }
        const brand = normalizeCardBrand((cardRow?.brand as string) || undefined);
        const feeBase = Math.min(cappedAmount, cardPaid);
        const proportionalFee = computeCardFee(branchId, feeBase, brand);
        if (proportionalFee > 0) {
          const debitAccount: 'CASH' | 'BANK' | 'CARD_CLEARING' =
            method === 'card' ? 'CARD_CLEARING' : (method === 'cash' ? 'CASH' : 'BANK');
          refundCardFeePortion({
            branchId, userId, invoiceId: r.invoiceId, feeAmount: proportionalFee,
            debitAccount, sourceId: `cardfee-refund:${returnId}:${uuid()}`, occurredAt: now,
          });
        }
      }
    } catch (e) {
      console.warn('[Return] card-fee refund handling failed:', e);
    }

    // Invoice RETURNED setzen, wenn Forderung durch Cash + CN-Cancel vollständig gedeckt.
    try {
      const invCheck = query(
        `SELECT i.gross_amount, i.paid_amount, i.status AS inv_status,
                COALESCE((SELECT SUM(cn.receivable_cancel_amount) FROM credit_notes cn
                           WHERE cn.invoice_id = i.id AND cn.status != 'CANCELLED'), 0) AS cn_cancel
         FROM invoices i WHERE i.id = ?`,
        [r.invoiceId]
      )[0];
      if (invCheck && (invCheck.inv_status === 'PARTIAL' || invCheck.inv_status === 'DRAFT')) {
        const gross = (invCheck.gross_amount as number) || 0;
        const paid  = (invCheck.paid_amount as number)  || 0;
        const cancel= (invCheck.cn_cancel as number)    || 0;
        if (gross > 0 && (gross - paid - cancel) <= 0.005) {
          db.run(
            `UPDATE invoices SET status = 'RETURNED', updated_at = ? WHERE id = ?`,
            [now, r.invoiceId]
          );
          // LAN-Sync (Gruppe 1): Invoice→RETURNED war ungetrackt (sales_returns synct via
          // trackUpdate oben, die Invoice nicht). Snapshot nach dem finalen Status-UPDATE.
          trackChange('invoices', r.invoiceId, 'update', {});
        }
      }
    } catch (e) {
      console.warn('[Return] invoice status update check (recordRefundPayment) failed:', e);
    }

    if (newReturnStatus !== r.status) {
      trackStatusChange('sales_returns', returnId, r.status, newReturnStatus);
    }
    get().loadReturns();
  },

  // ── Cancel (einheitlicher Storno) ────────────────────────
  // R6E — die Folge (Disposition/COGS/CN/VAT/Customer-Credit/Card-Fee umkehren, REJECTED, Audit)
  // wohnt in `cancelReturnInHouse` — DIESELBE, die `returns.cancel` von PC2 ruft. Hier nur der
  // Anschluss der Maske: das Owner-Recht der SITZUNG, dann EINE Klammer (`runOnPrimary`: exklusiv,
  // eine Transaktion, erst danach durabel). Vorher öffnete dieser Store seine eigene Transaktion
  // und rollte bei Fehler selbst zurück.
  // Keine eigene `async`-Aktion: die Handlung stellt sich über `runOnPrimary` in die EINE
  // Schreibspur (`runExclusive`) — die Vorprüfungen davor fassen die Datenbank nicht an.
  cancelReturn: (id, reason) => {
    if (isClientMode()) {
      return Promise.reject(new ReturnCancelRejected(RETURN_PRIMARY_ONLY, 'a return is cancelled on the main computer — this window has no business database'));
    }
    // Owner-only — store-seitig HART erzwungen (die UI versteckt den Button zusaetzlich via perm.isOwner).
    let actorRole: string | undefined;
    try { actorRole = useAuthStore.getState().role(); } catch { actorRole = undefined; }
    if (canonicalRole(actorRole) !== 'ADMIN') {
      return Promise.reject(new ReturnCancelRejected(RETURN_OWNER_ONLY, 'Only the owner can cancel a return.'));
    }
    // Keine stille Ersatzfiliale: ohne Sitzung wird nichts storniert.
    let branchId: string;
    let userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); } catch (e) { return Promise.reject(e); }
    return runOnPrimary(() => {
      // Idempotent am Primary (wie bisher): eine schon stornierte Retoure ist ein No-op. Fern ist
      // es ein eingefrorenes Nein (`RETURN_ALREADY_CANCELLED`) — dort sagt es dem Absender, dass
      // SEIN Auftrag nichts mehr bewirkt hat.
      const st = query('SELECT status FROM sales_returns WHERE id = ? AND branch_id = ?', [id, branchId])[0];
      if (st && String(st.status) === 'REJECTED') return;
      cancelReturnInHouse(id, reason, { userId, role: actorRole }, branchId);
    }, () => {
      get().loadReturns();
      try { useCreditNoteStore.getState().loadCreditNotes(); } catch { /* */ }
    });
  },

  // Vorab-Pruefung fuer die UI: ob/warum ein Return (nicht) stornierbar ist + Lager-Warnflag.
  // R6E — dieselbe Regel wie die Hausfolge (`returnCancelability`). Am Primary live gefragt; auf PC2
  // kommt die Antwort des Primary mit der Liste (`store.sales_returns.get` → `cancelability`).
  getReturnCancelability: (id) => {
    const r = get().getReturn(id);
    if (!r) return { canCancel: false, blockReason: 'Return not found.', needsStockWarning: false };
    // R4C.3 — diese Frage wird beim ZEICHNEN gestellt. Ohne Auskunft ist die ehrliche Antwort nicht
    // „darf stornieren", sondern das Gegenteil — dieselbe fail-closed Haltung wie `getInvoiceCardInfo`.
    const ohneAuskunft: ReturnCancelability = {
      canCancel: false,
      blockReason: 'Cancelling a return is only available on the main computer.',
      needsStockWarning: false,
    };
    if (readsFromPrimary()) return get().cancelability[id] ?? ohneAuskunft;
    try {
      return returnCancelability(r);
    } catch {
      return ohneAuskunft;
    }
  },

  // ── Aggregations (unverändert — Reports lesen hier) ─────
  getInvoiceReturnSummary: (invoiceId, invoiceGross, invoicePaid) => {
    const returns = get().returns.filter(r => r.invoiceId === invoiceId && r.status !== 'REJECTED');
    const totalReturned = returns.reduce((s, r) => s + (r.totalAmount || 0), 0);
    const totalRefundPaid = returns.reduce((s, r) => s + (r.refundPaidAmount || 0), 0);

    let outstandingRefund: number;
    if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      outstandingRefund = Math.max(0, cashRefundable - totalRefundPaid);
    } else {
      outstandingRefund = Math.max(0, totalReturned - totalRefundPaid);
    }

    let returnState: 'NONE' | 'PARTIAL_RETURN' | 'RETURNED';
    if (returns.length === 0) {
      returnState = 'NONE';
    } else {
      try {
        const lineRows = query(
          `SELECT il.id, il.quantity AS orig_qty,
                  COALESCE((
                    SELECT SUM(srl.quantity)
                    FROM sales_return_lines srl
                    JOIN sales_returns sr ON sr.id = srl.return_id
                    WHERE srl.invoice_line_id = il.id AND sr.status != 'REJECTED'
                  ), 0) AS returned_qty
           FROM invoice_lines il
           WHERE il.invoice_id = ?`,
          [invoiceId]
        );
        const totalLines = lineRows.length;
        const fullyReturnedLines = lineRows.filter(r =>
          Number(r.returned_qty || 0) >= Number(r.orig_qty || 0) - 0.005
        ).length;
        if (totalLines === 0) {
          returnState = 'NONE';
        } else if (fullyReturnedLines === totalLines) {
          returnState = 'RETURNED';
        } else {
          returnState = 'PARTIAL_RETURN';
        }
      } catch {
        returnState = totalReturned >= invoiceGross - 0.005 ? 'RETURNED' : 'PARTIAL_RETURN';
      }
    }

    let refundState: RefundStatus;
    if (totalReturned === 0) {
      refundState = 'PENDING_REFUND';
    } else if (typeof invoicePaid === 'number') {
      const owedAfterReturns = Math.max(0, invoiceGross - totalReturned);
      const cashRefundable = Math.max(0, invoicePaid - owedAfterReturns);
      if (cashRefundable < 0.01) refundState = 'REFUNDED';
      else if (totalRefundPaid >= cashRefundable - 0.01) refundState = 'REFUNDED';
      else if (totalRefundPaid > 0) refundState = 'PARTIALLY_REFUNDED';
      else refundState = 'PENDING_REFUND';
    } else {
      refundState = totalRefundPaid >= totalReturned - 0.005 ? 'REFUNDED'
        : totalRefundPaid > 0 ? 'PARTIALLY_REFUNDED'
        : 'PENDING_REFUND';
    }
    return { returns, totalReturned, totalRefundPaid, outstandingRefund, returnState, refundState };
  },

  getCustomerRefundPayable: (customerId) => {
    return get().returns
      .filter(r => r.customerId === customerId && r.status !== 'REJECTED')
      .reduce((sum, r) => sum + Math.max(0, (r.refundAmount || 0) - (r.refundPaidAmount || 0)), 0);
  },

  // Slice 5 — Karten-Zahlungs-Info der Original-Invoice fuer die Refund-UI:
  //   cardPaid  = per Karte gezahlter Betrag der Invoice
  //   brand     = Karten-Brand (normal/amex) fuer die Gebuehren-Rate
  //   activeFee = aktuell aktive (nicht stornierte) CardFee der Invoice
  getInvoiceCardInfo: (invoiceId) => {
    try {
      const pay = query(
        `SELECT COALESCE(SUM(amount),0) AS paid, MAX(card_brand) AS brand
           FROM payments WHERE invoice_id = ? AND method = 'card'`,
        [invoiceId]
      )[0];
      const fee = query(
        `SELECT COALESCE(SUM(amount),0) AS fee FROM expenses
           WHERE category = 'CardFees' AND related_module = 'invoice'
             AND related_entity_id = ? AND status != 'CANCELLED'`,
        [invoiceId]
      )[0];
      return {
        cardPaid: Number(pay?.paid || 0),
        brand: normalizeCardBrand((pay?.brand as string) || undefined),
        activeFee: Number(fee?.fee || 0),
      };
    } catch {
      return { cardPaid: 0, brand: 'normal', activeFee: 0 };
    }
  },

  getReturnedQtyForLine: (invoiceLineId) => {
    let qty = 0;
    for (const r of get().returns) {
      if (r.status === 'REJECTED') continue;
      for (const l of r.lines) {
        if (l.invoiceLineId === invoiceLineId) qty += l.quantity || 1;
      }
    }
    return qty;
  },
}));

/**
 * CENTRAL-UI-PARITY R2A — die gemeinsame Ladefunktion fuer Rueckgaben samt ihren Zeilen.
 *
 * Zustandsfrei: kein `set`, kein `get`, kein `currentBranchId()`. Die Filiale kommt aus dem
 * Ausweis, den der Aufrufer mitbringt — am Primary aus der eigenen Sitzung, aus der Ferne aus dem
 * geprueften Absender. Damit koennen beide Wege dieselbe Funktion benutzen, ohne dass das Lesen
 * des einen den Bildschirm des anderen anfasst.
 */
export function loadSalesReturnsFor(ctx: BusinessReadContext): {
  returns: SalesReturn[];
  cancelability: Record<string, ReturnCancelability>;
} {
  const rows = query('SELECT * FROM sales_returns WHERE branch_id = ? ORDER BY created_at DESC', [ctx.branchId]);
  const returns: SalesReturn[] = rows.map((r) => {
    const ret = rowToReturn(r);
    const lineRows = query('SELECT * FROM sales_return_lines WHERE return_id = ?', [ret.id]);
    ret.lines = lineRows.map(rowToLine);
    return ret;
  });
  // R6E — die Storno-Auskunft reist mit derselben Auskunft (`store.sales_returns.get`): der Knopf
  // „Cancel Return" auf PC2 fragt dieselbe Regel wie die Hausfolge, gerechnet vom Primary.
  const cancelability: Record<string, ReturnCancelability> = {};
  for (const r of returns) cancelability[r.id] = returnCancelability(r);
  return { returns, cancelability };
}

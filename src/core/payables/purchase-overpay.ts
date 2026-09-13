// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6D — die Ueberzahlung eines Einkaufs als Lieferanten-Guthaben (Slice 4b).
//
// Inhaltlich unveraendert aus `purchaseStore.ts` hierher gezogen: die Zahlungsfolge des Hauses
// (`payables-house.ts`) und die Retourenwege des Stores brauchen DIESELBEN Helfer, und das Haus
// darf den Store nicht importieren (der Store ruft das Haus — umgekehrt waere es ein Kreis).
//
// Overpay-Basis ist purchases.paid_amount (NETTO-CASH): eine Zahlung erhoeht es, confirmReturn-
// Refund senkt es, eine Credit-Einloesung fasst es NICHT an → Credit-Zahlungen erzeugen nie
// Ueberzahlung (Entscheidung 5). Bewusst NICHT SUM(non-credit payments): das wuerde nach einem
// Refund-Return den Ueberschuss um den Refund zu hoch ansetzen (AP-Drift).
// SUPPLIER_CREDIT ist Asset/DEBIT-natur → Reklass DR SUPPLIER_CREDIT / CR ACCOUNTS_PAYABLE
// (NICHT spiegelbildlich zur Customer-Seite). Diskriminator gegen Return-Credits:
// source_purchase_id=? AND source_return_id IS NULL (Return-Credits setzen beide IDs).
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { trackInsert, trackDelete } from '@/core/sync/track';
import {
  postPurchaseOverpaymentCredit, reverseSource, hasLedgerEntries, hasReversalFor,
  beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction,
} from '@/core/ledger/posting';

/** Das Nein, wenn die Overpay-Gutschrift schon eingeloest ist — mit Code, damit das Haus es einfrieren kann. */
export class OverpayCreditRedeemed extends Error {
  readonly code = 'PURCHASE_OVERPAY_CREDIT_REDEEMED';
  constructor(message: string) {
    super(message);
    this.name = 'OverpayCreditRedeemed';
  }
}

function purchaseOverpayOf(purchaseId: string): { over: number; supplierId: string; branchId: string } {
  const r = query(`SELECT supplier_id, branch_id, total_amount, paid_amount FROM purchases WHERE id = ?`, [purchaseId])[0];
  if (!r) return { over: 0, supplierId: '', branchId: '' };
  const over = Math.max(0, Math.round(((Number(r.paid_amount || 0)) - (Number(r.total_amount || 0))) * 1000) / 1000);
  return { over, supplierId: (r.supplier_id as string) || '', branchId: (r.branch_id as string) || '' };
}

function existingSupplierOverpayCredit(purchaseId: string): { id: string; amount: number; used: number } | null {
  const r = query(
    `SELECT id, amount, used_amount FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL`,
    [purchaseId]
  )[0];
  return r ? { id: r.id as string, amount: Number(r.amount || 0), used: Number(r.used_amount || 0) } : null;
}

// BLOCK bei eingeloestem Overpay-Guthaben (Entscheidung 6: kein Auto-Reversal benutzter Credits).
function assertSupplierOverpayCreditUnused(purchaseId: string, msg: string): void {
  const ex = existingSupplierOverpayCredit(purchaseId);
  if (ex && ex.used > 0.005) throw new OverpayCreditRedeemed(msg);
}

// Pre-Check VOR jeder Mutation: aendert sich der Ueberschuss, waehrend die bestehende Overpay-
// Gutschrift schon (teil-)eingeloest ist → BLOCK. prospectiveTotal optional (Return-Pfade aendern total).
export function assertSupplierOverpayMutable(purchaseId: string, prospectivePaid: number, prospectiveTotal?: number): void {
  const ex = existingSupplierOverpayCredit(purchaseId);
  if (!ex || ex.used <= 0.005) return;
  const total = prospectiveTotal !== undefined
    ? prospectiveTotal
    : Number(query(`SELECT total_amount FROM purchases WHERE id = ?`, [purchaseId])[0]?.total_amount || 0);
  const newOver = Math.max(0, Math.round((prospectivePaid - total) * 1000) / 1000);
  if (Math.abs(newOver - ex.amount) > 0.005) {
    throw new OverpayCreditRedeemed('Cannot change this purchase payment/return: the supplier credit from its overpayment has already been (partially) redeemed. Reverse the credit usage first.');
  }
}

// Domain-Row weg + syncen. Diskriminator MUSS mit (source_return_id IS NULL), sonst loescht es
// versehentlich Return-Credits. In offener Ambient-Tx deferiert saveDatabase bis COMMIT.
function clawbackSupplierOverpayCredit(purchaseId: string): void {
  const db = getDatabase();
  const rows = query(`SELECT id FROM supplier_credits WHERE source_purchase_id = ? AND source_return_id IS NULL`, [purchaseId]);
  for (const r of rows) {
    db.run(`DELETE FROM supplier_credits WHERE id = ?`, [r.id as string]);
    trackDelete('supplier_credits', r.id as string);
  }
  saveDatabase();
}

// clawback-then-rebook: bringt die EINE Overpay-Gutschrift auf den aktuellen Ueberschuss.
// Reklass-Bein (PURCHASE_OVERPAY) + supplier_credits-Row + Reverse atomar in EINER
// beginLedgerTransaction (wirft → rollback). reverseSource ist multi-cycle-safe (per-Leg).
// Innerhalb einer offenen Handlung (R6D) verschachtelt sich die Klammer nur — ein Fehler nimmt dann
// die GANZE Handlung zurueck, nicht bloss die Gutschrift.
export function reconcilePurchaseOverpayCredit(purchaseId: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const { over, supplierId, branchId: purchaseBranch } = purchaseOverpayOf(purchaseId);
  const ex = existingSupplierOverpayCredit(purchaseId);
  const exAmt = ex ? ex.amount : 0;
  if (Math.abs(over - exAmt) <= 0.005) return;   // unveraendert → nichts tun
  if (ex && ex.used > 0.005) throw new OverpayCreditRedeemed('supplier overpayment credit already redeemed — cannot rebook.');
  // R6D — die Gutschrift gehoert in die Filiale DES EINKAUFS (nicht still in 'branch-main').
  const branchId = purchaseBranch || currentBranchId();
  let userId = 'user-owner';
  try { userId = currentUserId(); } catch { /* Anlage ohne Sitzung (Altpfad) */ }
  beginLedgerTransaction();
  try {
    if (hasLedgerEntries('PURCHASE_OVERPAY', purchaseId)) reverseSource('PURCHASE_OVERPAY', purchaseId, now);
    clawbackSupplierOverpayCredit(purchaseId);
    if (over > 0.005 && supplierId) {
      const creditId = uuid();
      db.run(
        `INSERT INTO supplier_credits (id, branch_id, supplier_id, source_return_id, source_purchase_id,
           amount, used_amount, status, note, created_at, created_by)
         VALUES (?, ?, ?, NULL, ?, ?, 0, 'OPEN', ?, ?, ?)`,
        [creditId, branchId, supplierId, purchaseId, over, 'Ueberzahlung Purchase', now, userId]
      );
      trackInsert('supplier_credits', creditId, { supplierId, amount: over, sourcePurchaseId: purchaseId });
      postPurchaseOverpaymentCredit(purchaseId, supplierId, over, now);
    }
    commitLedgerTransaction();
  } catch (e) {
    rollbackLedgerTransaction();
    throw e;
  }
}

// Terminaler Teardown (cancelPurchase): BLOCK bei eingeloest → reverse PURCHASE_OVERPAY → clawback.
// Kein Rebook (Purchase storniert). reverseSource guarded (kein Doppel-Reverse).
export function teardownSupplierOverpayCredit(purchaseId: string, msg: string): void {
  assertSupplierOverpayCreditUnused(purchaseId, msg);
  if (hasLedgerEntries('PURCHASE_OVERPAY', purchaseId) && !hasReversalFor('PURCHASE_OVERPAY', purchaseId)) {
    reverseSource('PURCHASE_OVERPAY', purchaseId, new Date().toISOString());
  }
  clawbackSupplierOverpayCredit(purchaseId);
}

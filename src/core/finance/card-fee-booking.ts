// SSOT fuer das BUCHEN + REVERSIEREN von Karten-Bearbeitungsgebuehren (v0.7.26).
// Eine einzige Codepath fuer Invoice-, Order- und Repair-Karten-Zahlungen, damit
// die Gebuehren-Logik nirgends divergiert.
//
// MODELL (v0.7.26): Die Karten-Gebuehr wird vom Processor SOFORT beim Swipe
// abgezogen — also direkt als BEZAHLT (status PAID, paid_amount = fee). Gebucht als
// EINE Buchung
//   DR EXPENSES_OPERATING / CR CARD_CLEARING   (Source 'EXPENSE')
// Karten-Zahlungen landen im Ledger auf CARD_CLEARING (cashAccountFor('card')) —
// der Processor haelt den Brutto dort und settled netto an die Bank. Die Gebuehr
// wird daher aus CARD_CLEARING abgezogen (nicht aus BANK). CARD_CLEARING zeigt so
// den Netto-Betrag, der zur Bank wandert.
// Vorteil: die Standard-Reversierung postExpenseCancelled (reverseSource 'EXPENSE')
// dreht die Buchung sauber zurueck — KEINE separate Zahlungs-Reversierung noetig.
// Deshalb funktionieren auch die bestehenden Reverse-Pfade (deleteInvoice,
// invoice-cancel) unveraendert.
//
// WICHTIG (load-bearing): created_at der CardFees-Expense MUSS == created_at der
// zugehoerigen Zahlung sein. bankingStore nettet die Bank-Zeile ueber diesen
// geteilten Timestamp (gross - matched CardFee). Wer bookCardFee aufruft, muss
// also denselben `now`-Timestamp wie der Payment-Insert mitgeben.
import { v4 as uuid } from 'uuid';
import { getDatabase } from '@/core/db/database';
import { query, getNextDocumentNumber } from '@/core/db/helpers';
import { trackInsert, trackUpdate } from '@/core/sync/track';
import { postEntries, postExpenseCancelled, hasLedgerEntries, hasReversalFor } from '@/core/ledger/posting';
import type { Expense } from '@/core/models/types';
import { cardFeeRate, computeCardFee, type CardBrand } from './card-fees';

function safePost(label: string, fn: () => void): void {
  try { fn(); } catch (err) { console.error(`[ledger] ${label} failed:`, err); }
}

export interface BookCardFeeArgs {
  branchId: string;
  userId: string;
  amount: number;          // Brutto-Betrag der Karten-Zahlung
  brand: CardBrand;        // 'normal' | 'amex'
  relatedModule: string;   // 'invoice' | 'order' | 'repair'
  relatedEntityId: string;
  label: string;           // Doc-Nummer/Label fuer die Beschreibung
  createdAt: string;       // MUSS == payment.created_at sein (Banking-Netting!)
}

/**
 * Bucht eine automatische CardFees-Expense (brand-genaue Rate) als BEZAHLT
 * (Processor zieht sofort ab) inkl. direktem Bank-Abgang im Ledger.
 * Gibt expenseId zurueck, oder null wenn keine Gebuehr anfaellt (fee <= 0).
 */
export function bookCardFee(args: BookCardFeeArgs): string | null {
  const { branchId, userId, amount, brand, relatedModule, relatedEntityId, label, createdAt } = args;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const feeRate = cardFeeRate(branchId, brand);
  const fee = computeCardFee(branchId, amount, brand);
  if (fee <= 0) return null;

  const db = getDatabase();
  const expenseId = uuid();
  const expenseNumber = getNextDocumentNumber('EXP');
  const expenseDescription = `Card fee (${brand === 'amex' ? 'Amex' : 'Normal'}) · ${label} · ${feeRate}% of ${amount.toFixed(3)} BHD`;
  const expenseDate = createdAt.split('T')[0];

  // Expense als PAID anlegen (paid_amount = fee, status PAID).
  db.run(
    `INSERT INTO expenses (id, branch_id, expense_number, category, amount, paid_amount, status, payment_method,
      expense_date, description, related_module, related_entity_id, created_at, created_by)
     VALUES (?, ?, ?, 'CardFees', ?, ?, 'PAID', 'bank', ?, ?, ?, ?, ?, ?)`,
    [expenseId, branchId, expenseNumber, fee, fee, expenseDate, expenseDescription, relatedModule, relatedEntityId, createdAt, userId]
  );
  trackInsert('expenses', expenseId, { category: 'CardFees', amount: fee, auto: true, relatedModule, relatedEntityId });

  // Ledger: die Gebuehr wird vom Karten-Clearing abgezogen (Processor haelt den
  // Brutto auf CARD_CLEARING, settled netto an die Bank). Daher DR EXPENSES_OPERATING
  // / CR CARD_CLEARING (NICHT BANK — Karten-Zahlungen buchen via cashAccountFor('card')
  // = CARD_CLEARING, nicht direkt auf BANK). Source 'EXPENSE'.
  safePost(`postCardFee(${expenseId})`, () => {
    if (hasLedgerEntries('EXPENSE', expenseId)) return;
    postEntries(
      [
        {
          account: 'EXPENSES_OPERATING', direction: 'DEBIT', amount: fee,
          metadata: { expenseNumber, category: 'CardFees', relatedModule, relatedEntityId },
        },
        {
          account: 'CARD_CLEARING', direction: 'CREDIT', amount: fee,
          metadata: { expenseNumber, category: 'CardFees' },
        },
      ],
      { occurredAt: createdAt, sourceModule: 'EXPENSE', sourceId: expenseId, branchId, userId }
    );
  });
  return expenseId;
}

/**
 * Reversiert (Status CANCELLED + Ledger-Reverse) alle nicht-stornierten CardFees
 * eines related-Modul+Entity, optional gefiltert auf einen created_at-Timestamp.
 * postExpenseCancelled (reverseSource 'EXPENSE') dreht die EINE Bank-Buchung
 * komplett zurueck (DR BANK / CR EXPENSES) — Card-Fee voll neutralisiert.
 * Idempotent. Gibt Anzahl reversierter Expenses zurueck.
 */
export function reverseCardFees(relatedModule: string, relatedEntityId: string, createdAt?: string): number {
  const db = getDatabase();
  const params: string[] = [relatedModule, relatedEntityId];
  let sql = `SELECT id FROM expenses
             WHERE category = 'CardFees' AND related_module = ? AND related_entity_id = ? AND status != 'CANCELLED'`;
  if (createdAt) { sql += ` AND created_at = ?`; params.push(createdAt); }
  const rows = query(sql, params);
  for (const er of rows) {
    const expId = er.id as string;
    db.run(`UPDATE expenses SET status = 'CANCELLED', paid_amount = 0 WHERE id = ?`, [expId]);
    trackUpdate('expenses', expId, { status: 'CANCELLED', reason: 'card-fee-reversed' });
    safePost(`postExpenseCancelled(${expId}) [card-fee-reverse]`, () => {
      if (!hasLedgerEntries('EXPENSE', expId)) return;
      if (hasReversalFor('EXPENSE', expId)) return;
      postExpenseCancelled({ id: expId } as Expense);
    });
  }
  return rows.length;
}

const ROUND3 = (n: number) => Math.round(n * 1000) / 1000;

export interface RefundCardFeeArgs {
  branchId: string;
  userId: string;
  invoiceId: string;
  feeAmount: number;        // anteilige Gebuehr, die erstattet/zurueckgeholt wird (> 0)
  debitAccount: 'CASH' | 'BANK' | 'CARD_CLEARING' | 'BENEFIT';
  sourceId: string;         // eindeutig pro Refund-Event (keine CN-Kollision)
  occurredAt: string;
}

/**
 * SLICE 5 — anteilige Karten-Gebuehr bei einem Refund zurueckholen.
 * Reduziert die aktive Invoice-CardFee um `feeAmount` (auf den Rest gecapped, FIFO;
 * CANCELLED wenn auf 0) und bucht die Erstattung:
 *   DR debitAccount / CR EXPENSES_OPERATING   (Source 'REFUND')
 * - debitAccount = CARD_CLEARING  → Weg ① (Processor erstattet die Gebuehr)
 * - debitAccount = CASH/BANK      → Weg ③ (Kunde traegt die Gebuehr, kleinerer Refund)
 * So bleibt die CardFee-Expense in der Tabelle = der NETTO behaltene Gebuehren-Anteil
 * (Tabelle ↔ Ledger konsistent). Gibt den tatsaechlich angewandten Betrag zurueck.
 */
export function refundCardFeePortion(args: RefundCardFeeArgs): number {
  const { branchId, userId, invoiceId, feeAmount, debitAccount, sourceId, occurredAt } = args;
  if (!Number.isFinite(feeAmount) || feeAmount <= 0) return 0;
  const db = getDatabase();

  const rows = query(
    `SELECT id, amount FROM expenses
      WHERE category = 'CardFees' AND related_module = 'invoice' AND related_entity_id = ?
        AND status != 'CANCELLED' ORDER BY created_at ASC`,
    [invoiceId]
  );
  const activeFee = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const apply = ROUND3(Math.min(feeAmount, activeFee));
  if (apply <= 0) return 0;

  // Aktive CardFee(s) anteilig reduzieren (FIFO), CANCELLED wenn auf 0.
  let remaining = apply;
  for (const r of rows) {
    if (remaining <= 0.0005) break;
    const expId = r.id as string;
    const amt = Number(r.amount) || 0;
    const take = ROUND3(Math.min(amt, remaining));
    const newAmt = ROUND3(amt - take);
    if (newAmt <= 0.0005) {
      db.run(`UPDATE expenses SET amount = 0, paid_amount = 0, status = 'CANCELLED' WHERE id = ?`, [expId]);
    } else {
      db.run(`UPDATE expenses SET amount = ?, paid_amount = ? WHERE id = ?`, [newAmt, newAmt, expId]);
    }
    trackUpdate('expenses', expId, { cardFeeReducedBy: take, reason: 'refund-fee-recovery' });
    remaining = ROUND3(remaining - take);
  }

  // Ledger: Gebuehr zurueck — DR debitAccount / CR EXPENSES_OPERATING.
  safePost(`refundCardFeePortion(${sourceId})`, () => {
    if (hasLedgerEntries('REFUND', sourceId)) return;
    postEntries(
      [
        { account: debitAccount, direction: 'DEBIT', amount: apply, metadata: { invoiceId, category: 'CardFeesRefund' } },
        { account: 'EXPENSES_OPERATING', direction: 'CREDIT', amount: apply, metadata: { invoiceId, category: 'CardFeesRefund' } },
      ],
      { occurredAt, sourceModule: 'REFUND', sourceId, branchId, userId }
    );
  });
  return apply;
}

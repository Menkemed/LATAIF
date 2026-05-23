// ═══════════════════════════════════════════════════════════
// LATAIF — Central Financial Ledger: Posting Service
// ZIEL.md §3a — Single Source of Truth, Double-Entry, Immutable.
//
// Dies ist der EINZIGE Schreibpfad für finanzwirksame Vorgänge.
// Domain-Tabellen (invoices, payments, credit_notes, ...) bleiben
// als operative Records, sind aber NICHT die Wahrheit für Geld.
//
// Invarianten:
//   - Pro transaction_id gilt SUM(DEBIT) === SUM(CREDIT).
//   - Einträge sind immutable (kein UPDATE, kein DELETE).
//   - Korrektur ausschliesslich via reversing entries (reverses_entry_id).
//   - amount ist immer >= 0; direction ('DEBIT'|'CREDIT') gibt das Vorzeichen.
//   - entry_no ist pro branch_id monoton, gap-frei (vergeben durch ledger_sequence).
// ═══════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { currentBranchId, currentUserId, query } from '@/core/db/helpers';
import { trackChange } from '@/core/sync/sync-service';
import type { Invoice, Payment, CreditNote, PaymentMethod, Purchase, PurchasePayment, Expense, ExpensePayment, BankTransfer, Debt, DebtPayment, CanonicalLoanDirection, CashSource, ScrapPaymentMethod } from '@/core/models/types';
import { canonicalLoanDirection } from '@/core/models/types';

// ── Kontenrahmen (siehe ZIEL.md §3a) ──────────────────────────

export type LedgerAccount =
  | 'CASH'
  | 'BANK'
  | 'CARD_CLEARING'
  // Benefit: BenefitPay App-Transfers (BHD), eigenes Asset-Konto.
  // Separat von Bank ausgewiesen, damit App-Zahlungen vom regulären
  // Banking unterschieden werden können.
  | 'BENEFIT'
  | 'ACCOUNTS_RECEIVABLE'
  | 'ACCOUNTS_PAYABLE'
  | 'REVENUE'
  | 'COGS'
  | 'INVENTORY'
  | 'VAT_OUTPUT'
  | 'VAT_INPUT'
  | 'MARGIN_VAT'
  | 'REFUNDS'
  | 'CARD_FEES'
  | 'SUPPLIER_CREDIT'
  // Customer-Deposits: Anzahlung vom Kunden vor Rechnungserstellung. Verbindlichkeit
  // (CREDIT-natur) — wir schulden Ware. Wird beim Convert-to-Invoice gegen AR verrechnet.
  | 'CUSTOMER_DEPOSITS'
  // Loans-Receivable: wir haben Geld verliehen (we_lend / MONEY_GIVEN). Asset, DEBIT-natur.
  | 'LOAN_RECEIVABLE'
  // Loans-Payable: wir haben Geld geliehen (we_borrow / MONEY_RECEIVED). Liability, CREDIT-natur.
  | 'LOAN_PAYABLE'
  | 'COMMISSION_PAYABLE_AGENT'
  | 'COMMISSION_PAYABLE_CONSIGNOR'
  | 'PARTNER_EQUITY'
  | 'EXPENSES_OPERATING'
  | 'TAX_PAID'
  | 'INTERNAL_TRANSFER'
  // v0.7.0 — Storno-Gebuehr / verfallene Anzahlung beim Order-Cancel. Income,
  // separat von REVENUE damit Business-Reports Sale vs. Storno trennen koennen.
  | 'CANCELLATION_FEE_INCOME';

export type LedgerDirection = 'DEBIT' | 'CREDIT';

export type SourceModule =
  | 'INVOICE'
  | 'PAYMENT'
  | 'CREDIT_NOTE'
  | 'REFUND'
  | 'PURCHASE'
  | 'PURCHASE_PAYMENT'
  | 'PURCHASE_RETURN'
  | 'EXPENSE'
  | 'EXPENSE_PAYMENT'
  | 'ORDER_PAYMENT'
  | 'LOAN'
  | 'LOAN_PAYMENT'
  | 'REPAIR_PAYMENT'
  | 'AGENT_SETTLEMENT'
  | 'AGENT_TRANSFER_SOLD'
  | 'CONSIGNMENT_PAYOUT'
  | 'METAL_PAYMENT'
  | 'BANK_TRANSFER'
  | 'PARTNER_TX'
  | 'TAX_PAYMENT'
  | 'STOCK_ADJUST'
  | 'SCRAP_TRADE'
  // v0.7.0 — Order-Cancel Geld-Handling (Refund / Forfeit). 'credit' macht
  // keine Ledger-Buchung — die Liability bleibt als CUSTOMER_DEPOSITS und wird
  // beim Apply auf eine Folge-Order/Invoice aufgeloest.
  | 'ORDER_CANCEL';

export type CounterpartyType =
  | 'CUSTOMER'
  | 'SUPPLIER'
  | 'AGENT'
  | 'PARTNER'
  | 'INTERNAL';

// ── Eintrag-Shape ──────────────────────────────────────────────

export interface LedgerEntryInput {
  account: LedgerAccount;
  direction: LedgerDirection;
  amount: number; // immer >= 0
  counterpartyType?: CounterpartyType;
  counterpartyId?: string;
  sourceLineId?: string;
  taxSchemeSnapshot?: string;
  vatRateSnapshot?: number;
  metadata?: Record<string, unknown>;
}

export interface PostContext {
  occurredAt: string;             // Geschäftsdatum (z.B. invoice.issuedAt)
  sourceModule: SourceModule;
  sourceId: string;
  reversesEntryId?: string;       // bei Korrektur-Buchung
  branchId?: string;              // Default: currentBranchId()
  userId?: string;                // Default: currentUserId()
  currency?: string;              // Default: 'BHD'
}

export interface PostingResult {
  transactionId: string;
  entryIds: string[];
}

// ── Rundung BHD: 3 Dezimalstellen (siehe ZIEL.md §5) ──────────

const ROUND = (n: number) => Math.round(n * 1000) / 1000;
const EPSILON = 0.001;

// ── Sequenz-Helper: nächste entry_no pro Branch reservieren ───

function reserveEntryNos(branchId: string, count: number): number[] {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR IGNORE INTO ledger_sequence (branch_id, next_no, updated_at) VALUES (?, 1, ?)`,
    [branchId, now]
  );
  db.run(
    `UPDATE ledger_sequence SET next_no = next_no + ?, updated_at = ? WHERE branch_id = ?`,
    [count, now, branchId]
  );
  const r = db.exec(
    `SELECT next_no FROM ledger_sequence WHERE branch_id = ?`,
    [branchId]
  );
  const newNext = (r[0]?.values?.[0]?.[0] as number) ?? (count + 1);
  const firstClaimed = newNext - count;
  return Array.from({ length: count }, (_, i) => firstClaimed + i);
}

// ── Low-Level: atomare Buchung ────────────────────────────────

// v0.4.2 — Ledger-Entries fuer die LAN-Spiegelung trackn. Ohne das wuerde der
// zweite Rechner Domain-Daten bekommen, aber ein leeres/falsches Ledger.
// trackChange snapshottet die volle Zeile; der andere Rechner uebernimmt sie
// via applyUpsert und postet NICHT neu → keine Doppelbuchung. trackChange ist
// ein No-op wenn kein Sync konfiguriert ist.
function trackLedgerEntries(entryIds: string[]): void {
  for (const id of entryIds) {
    try { trackChange('ledger_entries', id, 'insert', {}); }
    catch (err) { console.warn('[ledger] trackChange(ledger_entries) failed:', err); }
  }
}

export function postEntries(
  entries: LedgerEntryInput[],
  ctx: PostContext
): PostingResult {
  if (entries.length === 0) {
    throw new Error('postEntries: empty entries array');
  }

  // Bilanz-Check: SUM(DEBIT) === SUM(CREDIT)
  const debits = entries
    .filter(e => e.direction === 'DEBIT')
    .reduce((s, e) => s + ROUND(e.amount), 0);
  const credits = entries
    .filter(e => e.direction === 'CREDIT')
    .reduce((s, e) => s + ROUND(e.amount), 0);
  if (Math.abs(debits - credits) > EPSILON) {
    throw new Error(
      `postEntries: imbalance — debits=${debits} credits=${credits} (transaction must net to zero)`
    );
  }
  for (const e of entries) {
    if (!(e.amount >= 0)) {
      throw new Error(`postEntries: amount must be >= 0 (got ${e.amount} for ${e.account})`);
    }
  }

  const branchId = ctx.branchId ?? currentBranchId();
  const userId = ctx.userId ?? currentUserId();
  const currency = ctx.currency ?? 'BHD';
  const recordedAt = new Date().toISOString();
  const transactionId = uuid();
  const nos = reserveEntryNos(branchId, entries.length);

  const db = getDatabase();
  db.run('BEGIN');
  try {
    const entryIds: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const id = uuid();
      entryIds.push(id);
      db.run(
        `INSERT INTO ledger_entries (
          id, branch_id, tenant_id, entry_no, transaction_id,
          occurred_at, recorded_at,
          account, direction, amount, currency,
          counterparty_type, counterparty_id,
          source_module, source_id, source_line_id,
          reverses_entry_id, tax_scheme_snapshot, vat_rate_snapshot,
          metadata_json, created_by, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          branchId,
          nos[i],
          transactionId,
          ctx.occurredAt,
          recordedAt,
          e.account,
          e.direction,
          ROUND(e.amount),
          currency,
          e.counterpartyType ?? null,
          e.counterpartyId ?? null,
          ctx.sourceModule,
          ctx.sourceId,
          e.sourceLineId ?? null,
          ctx.reversesEntryId ?? null,
          e.taxSchemeSnapshot ?? null,
          e.vatRateSnapshot ?? null,
          e.metadata ? JSON.stringify(e.metadata) : null,
          userId,
          recordedAt,
        ]
      );
    }
    db.run('COMMIT');
    // Persist nach jeder erfolgreichen Buchung — sonst gehen Posts beim Browser-Reload verloren,
    // weil sql.js in-memory ist und localStorage nur via saveDatabase() aktualisiert wird.
    saveDatabase();
    trackLedgerEntries(entryIds);
    return { transactionId, entryIds };
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ── Idempotency-Helpers ───────────────────────────────────────

/**
 * Liefert true, wenn für (source_module, source_id) bereits Original-Buchungen
 * existieren (also nicht selbst eine Reversal-Buchung). Wire-Up ruft das auf,
 * um Doppel-Postings beim Replay/Re-Save zu vermeiden.
 */
export function hasLedgerEntries(sourceModule: SourceModule, sourceId: string): boolean {
  // Multi-Cycle-Pattern (Plan repair-multi-supplier): True genau dann, wenn
  // es ein ORIGINAL-Entry (reverses_entry_id IS NULL) gibt, das NOCH NICHT
  // reversed wurde. Stale Originale aus alten Zyklen werden ignoriert.
  const rows = query(
    `SELECT 1 FROM ledger_entries e1
     WHERE e1.source_module = ? AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries e2
         WHERE e2.reverses_entry_id = e1.id
       )
     LIMIT 1`,
    [sourceModule, sourceId]
  );
  return rows.length > 0;
}

/**
 * Liefert true, wenn der LETZTE Zyklus von (source_module, source_id) bereits
 * reversed wurde — also keine offenen Original-Entries mehr existieren. Wenn
 * es ueberhaupt keine Eintraege gibt, false (es gibt nichts zu reversen).
 *
 * Multi-Cycle-Pattern (Plan repair-multi-supplier): erlaubt mehrfache
 * sequenzielle Reverse-and-Repost-Zyklen, indem die Pruefung sich nur auf
 * den aktuellsten Zyklus bezieht. Frueher: blockierte jede zweite Reversal.
 */
export function hasReversalFor(sourceModule: SourceModule, sourceId: string): boolean {
  const anyOriginal = query(
    `SELECT 1 FROM ledger_entries
     WHERE source_module = ? AND source_id = ? AND reverses_entry_id IS NULL LIMIT 1`,
    [sourceModule, sourceId]
  );
  if (anyOriginal.length === 0) return false;
  // True = alle Originale reversed = "letzter Zyklus geschlossen"
  return !hasLedgerEntries(sourceModule, sourceId);
}

// ── Domain-Mappings ───────────────────────────────────────────

function vatAccountFor(scheme: string | undefined): LedgerAccount {
  if (scheme === 'MARGIN') return 'MARGIN_VAT';
  return 'VAT_OUTPUT';
}

/**
 * Lädt das Tax-Scheme der Original-Invoice eines CN.
 * Gibt 'mixed' zurück, wenn die Invoice gemischt ist — Caller muss dann fallen
 * auf VAT_OUTPUT zurück (da CN keine Line-Granularität hat).
 */
function lookupInvoiceTaxScheme(invoiceId: string): string | undefined {
  const rows = query(
    `SELECT tax_scheme_snapshot FROM invoices WHERE id = ?`,
    [invoiceId]
  );
  return rows[0]?.tax_scheme_snapshot as string | undefined;
}

function cashAccountFor(method: PaymentMethod): LedgerAccount {
  switch (method) {
    case 'cash':          return 'CASH';
    case 'bank_transfer': return 'BANK';
    case 'card':          return 'CARD_CLEARING';
    // Benefit: BenefitPay App-Transfer, eigenes Konto separat von Bank.
    // Banking-Page zeigt Cash/Bank/Benefit als drei getrennte Balance-Cards.
    case 'benefit':       return 'BENEFIT';
    default:              return 'BANK';
  }
}

// ── Invoice (issued) ──────────────────────────────────────────
//
// Pro Line:
//   DEBIT  AR              by lineTotal
//   CREDIT REVENUE         by (lineTotal - vatAmount)
//   CREDIT VAT/MARGIN_VAT  by vatAmount   (übersprungen wenn 0)

export function postInvoiceIssued(invoice: Invoice): PostingResult {
  if (!invoice.lines || invoice.lines.length === 0) {
    throw new Error(`postInvoiceIssued: invoice ${invoice.id} has no lines`);
  }
  const occurredAt = invoice.issuedAt ?? invoice.createdAt;
  const entries: LedgerEntryInput[] = [];
  for (const line of invoice.lines) {
    const gross = ROUND(line.lineTotal);
    const vat = ROUND(line.vatAmount);
    const net = ROUND(gross - vat);

    entries.push({
      account: 'ACCOUNTS_RECEIVABLE',
      direction: 'DEBIT',
      amount: gross,
      counterpartyType: 'CUSTOMER',
      counterpartyId: invoice.customerId,
      sourceLineId: line.id,
      taxSchemeSnapshot: line.taxScheme,
      vatRateSnapshot: line.vatRate,
      metadata: { invoiceNumber: invoice.invoiceNumber, productId: line.productId },
    });
    if (net > 0) {
      entries.push({
        account: 'REVENUE',
        direction: 'CREDIT',
        amount: net,
        counterpartyType: 'CUSTOMER',
        counterpartyId: invoice.customerId,
        sourceLineId: line.id,
        taxSchemeSnapshot: line.taxScheme,
        vatRateSnapshot: line.vatRate,
        metadata: { invoiceNumber: invoice.invoiceNumber, productId: line.productId },
      });
    }
    if (vat > 0) {
      entries.push({
        account: vatAccountFor(line.taxScheme),
        direction: 'CREDIT',
        amount: vat,
        counterpartyType: 'CUSTOMER',
        counterpartyId: invoice.customerId,
        sourceLineId: line.id,
        taxSchemeSnapshot: line.taxScheme,
        vatRateSnapshot: line.vatRate,
        metadata: { invoiceNumber: invoice.invoiceNumber, productId: line.productId },
      });
    }
  }
  return postEntries(entries, {
    occurredAt,
    sourceModule: 'INVOICE',
    sourceId: invoice.id,
    currency: invoice.currency,
  });
}

// ── Payment (Customer-Zahlung gegen Invoice) ──────────────────
//
//   DEBIT  CASH/BANK/CARD_CLEARING  by amount
//   CREDIT ACCOUNTS_RECEIVABLE      by amount

export function postInvoicePayment(
  payment: Payment,
  customerId: string
): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postInvoicePayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = cashAccountFor(payment.method);
  return postEntries(
    [
      {
        account: cashAcc,
        direction: 'DEBIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { invoiceId: payment.invoiceId, method: payment.method },
      },
      {
        account: 'ACCOUNTS_RECEIVABLE',
        direction: 'CREDIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { invoiceId: payment.invoiceId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.receivedAt,
      sourceModule: 'PAYMENT',
      sourceId: payment.id,
    }
  );
}

// ── Credit Note (Storno-Rechnung / Sales Return) ──────────────
//
// Logik: Der CN-Total wird in zwei Teile gespalten:
//   - cashRefundAmount  → echtes Geld zurück an Kunden
//   - receivableCancelAmount → nur Forderungs-Abbau (kein Cash)
//
// Buchung:
//   DEBIT  REVENUE      by (totalAmount - vatAmount)
//   DEBIT  VAT_OUTPUT   by vatAmount
//   CREDIT ACCOUNTS_RECEIVABLE  by receivableCancelAmount
//   CREDIT CASH/BANK    by cashRefundAmount

export function postCreditNote(cn: CreditNote): PostingResult {
  const total = ROUND(cn.totalAmount);
  const vat = ROUND(cn.vatAmount);
  const net = ROUND(total - vat);
  const cashRefund = ROUND(cn.cashRefundAmount);
  const arCancel = ROUND(cn.receivableCancelAmount);

  if (Math.abs(cashRefund + arCancel - total) > EPSILON) {
    throw new Error(
      `postCreditNote ${cn.id}: cashRefund(${cashRefund}) + arCancel(${arCancel}) !== total(${total})`
    );
  }

  const entries: LedgerEntryInput[] = [];

  if (net > 0) {
    entries.push({
      account: 'REVENUE',
      direction: 'DEBIT',
      amount: net,
      counterpartyType: 'CUSTOMER',
      counterpartyId: cn.customerId,
      metadata: { creditNoteNumber: cn.creditNoteNumber, invoiceId: cn.invoiceId },
    });
  }
  if (vat > 0) {
    // VAT-Konto richtet sich nach dem Tax-Scheme der Original-Invoice.
    // 'mixed' fällt auf VAT_OUTPUT zurück, weil CN keine Line-Granularität hat.
    const origScheme = lookupInvoiceTaxScheme(cn.invoiceId);
    const vatAcc = origScheme === 'MARGIN' ? 'MARGIN_VAT' : 'VAT_OUTPUT';
    entries.push({
      account: vatAcc,
      direction: 'DEBIT',
      amount: vat,
      counterpartyType: 'CUSTOMER',
      counterpartyId: cn.customerId,
      taxSchemeSnapshot: origScheme,
      metadata: { creditNoteNumber: cn.creditNoteNumber, invoiceId: cn.invoiceId, originalScheme: origScheme },
    });
  }
  if (arCancel > 0) {
    entries.push({
      account: 'ACCOUNTS_RECEIVABLE',
      direction: 'CREDIT',
      amount: arCancel,
      counterpartyType: 'CUSTOMER',
      counterpartyId: cn.customerId,
      metadata: { creditNoteNumber: cn.creditNoteNumber, invoiceId: cn.invoiceId },
    });
  }
  if (cashRefund > 0) {
    const refundAcc: LedgerAccount =
      cn.refundMethod === 'cash' ? 'CASH' :
      cn.refundMethod === 'card' ? 'CARD_CLEARING' :
      'BANK';
    entries.push({
      account: refundAcc,
      direction: 'CREDIT',
      amount: cashRefund,
      counterpartyType: 'CUSTOMER',
      counterpartyId: cn.customerId,
      metadata: {
        creditNoteNumber: cn.creditNoteNumber,
        invoiceId: cn.invoiceId,
        refundMethod: cn.refundMethod ?? 'bank',
      },
    });
  }

  return postEntries(entries, {
    occurredAt: cn.issuedAt,
    sourceModule: 'CREDIT_NOTE',
    sourceId: cn.id,
  });
}

// ── Storno: Original-Buchung spiegeln ─────────────────────────
//
// Lädt alle bestehenden Einträge zu (sourceModule, sourceId) und
// schreibt eine spiegelverkehrte Buchung (DEBIT↔CREDIT) mit
// reverses_entry_id zum jeweiligen Original.

export function reverseSource(
  sourceModule: SourceModule,
  sourceId: string,
  occurredAt: string
): PostingResult {
  if (hasReversalFor(sourceModule, sourceId)) {
    throw new Error(`reverseSource: ${sourceModule}/${sourceId} already reversed`);
  }
  const db = getDatabase();
  // Multi-Cycle-Safe: nur Originale die NICHT bereits eine Reversal haben.
  // So koennen mehrere Reverse-and-Repost-Zyklen sauber sequenziert werden.
  const r = db.exec(
    `SELECT e1.id, e1.account, e1.direction, e1.amount, e1.counterparty_type, e1.counterparty_id,
            e1.source_line_id, e1.tax_scheme_snapshot, e1.vat_rate_snapshot, e1.currency
     FROM ledger_entries e1
     WHERE e1.source_module = ? AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id
       )`,
    [sourceModule, sourceId]
  );
  if (r.length === 0 || r[0].values.length === 0) {
    throw new Error(`reverseSource: no entries found for ${sourceModule}/${sourceId}`);
  }
  const cols = r[0].columns;
  const idIdx = cols.indexOf('id');
  const accIdx = cols.indexOf('account');
  const dirIdx = cols.indexOf('direction');
  const amtIdx = cols.indexOf('amount');
  const ctIdx = cols.indexOf('counterparty_type');
  const ciIdx = cols.indexOf('counterparty_id');
  const slIdx = cols.indexOf('source_line_id');
  const tsIdx = cols.indexOf('tax_scheme_snapshot');
  const vrIdx = cols.indexOf('vat_rate_snapshot');
  const curIdx = cols.indexOf('currency');

  // Wir schreiben EINE Reverse-Transaction mit allen gespiegelten Entries.
  // Für jede Originalzeile setzen wir reverses_entry_id; daher rufen wir
  // postEntries nicht direkt auf, sondern bauen die INSERTs selbst.
  const branchId = currentBranchId();
  const userId = currentUserId();
  const recordedAt = new Date().toISOString();
  const transactionId = uuid();
  const rows = r[0].values;
  const nos = reserveEntryNos(branchId, rows.length);
  const currency = (rows[0][curIdx] as string) ?? 'BHD';

  db.run('BEGIN');
  try {
    const entryIds: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const newId = uuid();
      entryIds.push(newId);
      const flipped = (row[dirIdx] as string) === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      db.run(
        `INSERT INTO ledger_entries (
          id, branch_id, tenant_id, entry_no, transaction_id,
          occurred_at, recorded_at,
          account, direction, amount, currency,
          counterparty_type, counterparty_id,
          source_module, source_id, source_line_id,
          reverses_entry_id, tax_scheme_snapshot, vat_rate_snapshot,
          metadata_json, created_by, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          branchId,
          nos[i],
          transactionId,
          occurredAt,
          recordedAt,
          row[accIdx],
          flipped,
          row[amtIdx],
          currency,
          row[ctIdx],
          row[ciIdx],
          sourceModule,
          sourceId,
          row[slIdx],
          row[idIdx],                     // reverses_entry_id → Original
          row[tsIdx],
          row[vrIdx],
          JSON.stringify({ reversal: true }),
          userId,
          recordedAt,
        ]
      );
    }
    db.run('COMMIT');
    saveDatabase();
    trackLedgerEntries(entryIds);
    return { transactionId, entryIds };
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ── Convenience: Invoice-Storno ───────────────────────────────

export function postInvoiceCancelled(invoice: Invoice): PostingResult {
  return reverseSource('INVOICE', invoice.id, new Date().toISOString());
}

// ── Reverse-by-Transaction ────────────────────────────────────
//
// Spiegelt eine konkrete Transaktion (transaction_id), egal welche
// (sourceModule, sourceId) sie hat. Wird gebraucht, wenn mehrere
// Transactions denselben source_id teilen (z.B. Migration: Original-Cash↔Revenue
// + neue Cash↔AR-Buchung mit gleicher source_id) und reverseSource()
// wegen hasReversalFor-Check blockt.
//
// Anders als reverseSource: kein source-weiter Reversal-Check, dafür ein
// strikter Check, dass GENAU diese transaction_id noch unreversed ist.

export function reverseTransaction(transactionId: string, occurredAt: string): PostingResult {
  const db = getDatabase();
  const r = db.exec(
    `SELECT id, account, direction, amount, counterparty_type, counterparty_id,
            source_module, source_id, source_line_id,
            tax_scheme_snapshot, vat_rate_snapshot, currency,
            reverses_entry_id
     FROM ledger_entries
     WHERE transaction_id = ?`,
    [transactionId]
  );
  if (r.length === 0 || r[0].values.length === 0) {
    throw new Error(`reverseTransaction: no entries for ${transactionId}`);
  }
  const cols = r[0].columns;
  const idIdx = cols.indexOf('id');
  const accIdx = cols.indexOf('account');
  const dirIdx = cols.indexOf('direction');
  const amtIdx = cols.indexOf('amount');
  const ctIdx = cols.indexOf('counterparty_type');
  const ciIdx = cols.indexOf('counterparty_id');
  const smIdx = cols.indexOf('source_module');
  const siIdx = cols.indexOf('source_id');
  const slIdx = cols.indexOf('source_line_id');
  const tsIdx = cols.indexOf('tax_scheme_snapshot');
  const vrIdx = cols.indexOf('vat_rate_snapshot');
  const curIdx = cols.indexOf('currency');
  const revIdx = cols.indexOf('reverses_entry_id');

  // Eine Tx ist hier per Definition als Reversal zu betrachten, wenn die Tx
  // selbst nur Reversal-Entries enthält. Wenn ein Mix (was nicht passieren
  // sollte), reversen wir die unreversed Original-Zeilen.
  const rows = r[0].values.filter(row => row[revIdx] === null);
  if (rows.length === 0) {
    throw new Error(`reverseTransaction: ${transactionId} has no original entries to reverse`);
  }

  // Prüfen, dass keine dieser Original-Zeilen bereits eine Reversal hat.
  for (const row of rows) {
    const origId = row[idIdx] as string;
    const existing = query(
      `SELECT 1 FROM ledger_entries WHERE reverses_entry_id = ? LIMIT 1`,
      [origId]
    );
    if (existing.length > 0) {
      throw new Error(`reverseTransaction: entry ${origId} already reversed`);
    }
  }

  const branchId = currentBranchId();
  const userId = currentUserId();
  const recordedAt = new Date().toISOString();
  const newTxId = uuid();
  const nos = reserveEntryNos(branchId, rows.length);
  const currency = (rows[0][curIdx] as string) ?? 'BHD';

  db.run('BEGIN');
  try {
    const entryIds: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const newId = uuid();
      entryIds.push(newId);
      const flipped = (row[dirIdx] as string) === 'DEBIT' ? 'CREDIT' : 'DEBIT';
      db.run(
        `INSERT INTO ledger_entries (
          id, branch_id, tenant_id, entry_no, transaction_id,
          occurred_at, recorded_at,
          account, direction, amount, currency,
          counterparty_type, counterparty_id,
          source_module, source_id, source_line_id,
          reverses_entry_id, tax_scheme_snapshot, vat_rate_snapshot,
          metadata_json, created_by, created_at
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId,
          branchId,
          nos[i],
          newTxId,
          occurredAt,
          recordedAt,
          row[accIdx],
          flipped,
          row[amtIdx],
          currency,
          row[ctIdx],
          row[ciIdx],
          row[smIdx],
          row[siIdx],
          row[slIdx],
          row[idIdx],
          row[tsIdx],
          row[vrIdx],
          JSON.stringify({ reversal: true, reverseTx: transactionId }),
          userId,
          recordedAt,
        ]
      );
    }
    db.run('COMMIT');
    saveDatabase();
    trackLedgerEntries(entryIds);
    return { transactionId: newTxId, entryIds };
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }
}

// ── Purchase (received goods) ─────────────────────────────────
//
// Pro Line:
//   DEBIT  INVENTORY        by (lineTotal - vatAmount)   netto Anschaffungskosten
//   DEBIT  VAT_INPUT        by vatAmount                 Vorsteuer (rückforderbar)
//   CREDIT ACCOUNTS_PAYABLE by lineTotal                 Schuld beim Lieferanten

export function postPurchaseReceived(purchase: Purchase): PostingResult {
  if (!purchase.lines || purchase.lines.length === 0) {
    throw new Error(`postPurchaseReceived: purchase ${purchase.id} has no lines`);
  }
  const occurredAt = purchase.purchaseDate ?? purchase.createdAt;
  const entries: LedgerEntryInput[] = [];
  for (const line of purchase.lines) {
    const gross = ROUND(line.lineTotal);
    const vat = ROUND(line.vatAmount ?? 0);
    const net = ROUND(gross - vat);

    if (net > 0) {
      entries.push({
        account: 'INVENTORY',
        direction: 'DEBIT',
        amount: net,
        counterpartyType: 'SUPPLIER',
        counterpartyId: purchase.supplierId,
        sourceLineId: line.id,
        taxSchemeSnapshot: line.taxScheme,
        vatRateSnapshot: line.vatRate,
        metadata: { purchaseNumber: purchase.purchaseNumber, productId: line.productId },
      });
    }
    if (vat > 0) {
      entries.push({
        account: 'VAT_INPUT',
        direction: 'DEBIT',
        amount: vat,
        counterpartyType: 'SUPPLIER',
        counterpartyId: purchase.supplierId,
        sourceLineId: line.id,
        taxSchemeSnapshot: line.taxScheme,
        vatRateSnapshot: line.vatRate,
        metadata: { purchaseNumber: purchase.purchaseNumber, productId: line.productId },
      });
    }
    if (gross > 0) {
      entries.push({
        account: 'ACCOUNTS_PAYABLE',
        direction: 'CREDIT',
        amount: gross,
        counterpartyType: 'SUPPLIER',
        counterpartyId: purchase.supplierId,
        sourceLineId: line.id,
        taxSchemeSnapshot: line.taxScheme,
        vatRateSnapshot: line.vatRate,
        metadata: { purchaseNumber: purchase.purchaseNumber, productId: line.productId },
      });
    }
  }
  return postEntries(entries, {
    occurredAt,
    sourceModule: 'PURCHASE',
    sourceId: purchase.id,
  });
}

// ── Purchase Payment (Zahlung an Lieferanten) ─────────────────
//
//   DEBIT  ACCOUNTS_PAYABLE      by amount
//   CREDIT CASH/BANK/SUPPLIER_CR by amount
//
// 'credit'-Methode konsumiert vorhandenes Supplier-Credit-Guthaben:
//   AP runter ← SUPPLIER_CREDIT runter (beide DEBIT-natur, also CREDIT auf Credit).

function purchaseCashAccountFor(method: PurchasePayment['method']): LedgerAccount {
  switch (method) {
    case 'cash':   return 'CASH';
    case 'bank':   return 'BANK';
    case 'credit': return 'SUPPLIER_CREDIT';
    default:       return 'BANK';
  }
}

export function postPurchasePayment(
  payment: PurchasePayment,
  supplierId: string
): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postPurchasePayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = purchaseCashAccountFor(payment.method);
  return postEntries(
    [
      {
        account: 'ACCOUNTS_PAYABLE',
        direction: 'DEBIT',
        amount,
        counterpartyType: 'SUPPLIER',
        counterpartyId: supplierId,
        metadata: { purchaseId: payment.purchaseId, method: payment.method },
      },
      {
        account: cashAcc,
        direction: 'CREDIT',
        amount,
        counterpartyType: 'SUPPLIER',
        counterpartyId: supplierId,
        metadata: { purchaseId: payment.purchaseId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'PURCHASE_PAYMENT',
      sourceId: payment.id,
    }
  );
}

// ── Convenience: Purchase-Storno ──────────────────────────────

export function postPurchaseCancelled(purchase: Purchase): PostingResult {
  return reverseSource('PURCHASE', purchase.id, new Date().toISOString());
}

// ── Expense (recorded, before/without payment) ────────────────
//
// Wir buchen IMMER zuerst gegen AP, auch wenn die Expense „payNow" ist.
// Die direkte Cash-Bewegung erfolgt separat als EXPENSE_PAYMENT.
// Vorteil: Storno einer Expense reverst NUR EXPENSES_OPERATING/AP — bereits
// geleistete Cash-Zahlungen bleiben gebucht (echtes Geld ist raus).
//
//   DEBIT  EXPENSES_OPERATING by amount
//   CREDIT ACCOUNTS_PAYABLE   by amount (counterparty: supplier wenn gesetzt)

export function postExpense(expense: Expense): PostingResult {
  const amount = ROUND(expense.amount);
  if (amount <= 0) {
    throw new Error(`postExpense: amount must be > 0 (got ${expense.amount})`);
  }
  const occurredAt = expense.expenseDate ?? expense.createdAt;
  const counterpartyType: CounterpartyType | undefined = expense.supplierId ? 'SUPPLIER' : undefined;
  return postEntries(
    [
      {
        account: 'EXPENSES_OPERATING',
        direction: 'DEBIT',
        amount,
        counterpartyType,
        counterpartyId: expense.supplierId,
        metadata: {
          expenseNumber: expense.expenseNumber,
          category: expense.category,
          relatedModule: expense.relatedModule,
          relatedEntityId: expense.relatedEntityId,
        },
      },
      {
        account: 'ACCOUNTS_PAYABLE',
        direction: 'CREDIT',
        amount,
        counterpartyType,
        counterpartyId: expense.supplierId,
        metadata: { expenseNumber: expense.expenseNumber, category: expense.category },
      },
    ],
    {
      occurredAt,
      sourceModule: 'EXPENSE',
      sourceId: expense.id,
    }
  );
}

// ── Expense Payment ───────────────────────────────────────────
//
//   DEBIT  ACCOUNTS_PAYABLE  by amount
//   CREDIT CASH/BANK         by amount

function expenseCashAccountFor(method: ExpensePayment['method']): LedgerAccount {
  switch (method) {
    case 'cash': return 'CASH';
    case 'bank': return 'BANK';
    default:     return 'BANK';
  }
}

export function postExpensePayment(
  payment: ExpensePayment,
  supplierId?: string
): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postExpensePayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = expenseCashAccountFor(payment.method);
  const counterpartyType: CounterpartyType | undefined = supplierId ? 'SUPPLIER' : undefined;
  return postEntries(
    [
      {
        account: 'ACCOUNTS_PAYABLE',
        direction: 'DEBIT',
        amount,
        counterpartyType,
        counterpartyId: supplierId,
        metadata: { expenseId: payment.expenseId, method: payment.method },
      },
      {
        account: cashAcc,
        direction: 'CREDIT',
        amount,
        counterpartyType,
        counterpartyId: supplierId,
        metadata: { expenseId: payment.expenseId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'EXPENSE_PAYMENT',
      sourceId: payment.id,
    }
  );
}

// ── Convenience: Expense-Storno ───────────────────────────────

export function postExpenseCancelled(expense: Expense): PostingResult {
  return reverseSource('EXPENSE', expense.id, new Date().toISOString());
}

// ── Bank Transfer (internal: cash ↔ bank) ─────────────────────
//
// X_TO_Y: DEBIT Y / CREDIT X (Empfangskonto soll, Quellkonto haben)
// 6 Richtungen über CASH ↔ BANK ↔ BENEFIT.
//
// Source ist BANK_TRANSFER — Cashflow-Reports können diese Quelle filtern,
// damit innerbetriebliche Verschiebungen nicht als externe Geldflüsse zählen.
// Counterparty: INTERNAL.

const TRANSFER_DIRECTION_MAP: Record<BankTransfer['direction'], { dr: LedgerAccount; cr: LedgerAccount }> = {
  CASH_TO_BANK:    { dr: 'BANK',    cr: 'CASH'    },
  BANK_TO_CASH:    { dr: 'CASH',    cr: 'BANK'    },
  CASH_TO_BENEFIT: { dr: 'BENEFIT', cr: 'CASH'    },
  BENEFIT_TO_CASH: { dr: 'CASH',    cr: 'BENEFIT' },
  BANK_TO_BENEFIT: { dr: 'BENEFIT', cr: 'BANK'    },
  BENEFIT_TO_BANK: { dr: 'BANK',    cr: 'BENEFIT' },
};

export function postBankTransfer(transfer: BankTransfer): PostingResult {
  const amount = ROUND(transfer.amount);
  if (amount <= 0) {
    throw new Error(`postBankTransfer: amount must be > 0 (got ${transfer.amount})`);
  }
  const occurredAt = transfer.transferDate ?? transfer.createdAt;
  const fromTo = TRANSFER_DIRECTION_MAP[transfer.direction];
  if (!fromTo) {
    throw new Error(`postBankTransfer: unknown direction ${transfer.direction}`);
  }

  return postEntries(
    [
      {
        account: fromTo.dr,
        direction: 'DEBIT',
        amount,
        counterpartyType: 'INTERNAL',
        metadata: { direction: transfer.direction, notes: transfer.notes },
      },
      {
        account: fromTo.cr,
        direction: 'CREDIT',
        amount,
        counterpartyType: 'INTERNAL',
        metadata: { direction: transfer.direction, notes: transfer.notes },
      },
    ],
    {
      occurredAt,
      sourceModule: 'BANK_TRANSFER',
      sourceId: transfer.id,
    }
  );
}

// ── Convenience: Bank-Transfer-Storno ─────────────────────────

export function postBankTransferReversed(transfer: BankTransfer): PostingResult {
  return reverseSource('BANK_TRANSFER', transfer.id, new Date().toISOString());
}

// ── Order Payment (Anzahlung vor Invoice-Erstellung) ─────────
//
// Kunde zahlt Deposit auf eine Order. Geld geht physisch ein, ist aber
// noch keine Bezahlung einer Rechnung — es ist eine Verbindlichkeit
// gegenüber dem Kunden (wir schulden Ware oder Refund).
//
//   DEBIT  CASH/BANK/CARD       by amount
//   CREDIT CUSTOMER_DEPOSITS    by amount
//
// Beim Convert-to-Invoice werden diese Order-Payments per
// reverseSource('ORDER_PAYMENT', id) zurück gespiegelt. Die parallel
// erzeugten invoice_payments posten dann normal (DEBIT cash, CREDIT AR).
// Net: Cash bleibt gleich (Reversal -X plus Invoice-Payment +X), die
// Customer-Deposits-Verbindlichkeit löst sich auf, und AR wird gemindert.

export interface OrderPaymentLike {
  id: string;
  orderId: string;
  amount: number;
  method?: string;          // 'cash' | 'bank' | 'card' | 'bank_transfer' | undefined
  paidAt: string;
}

function orderPaymentCashAccountFor(method?: string): LedgerAccount {
  const m = (method || 'cash').toLowerCase();
  if (m === 'cash') return 'CASH';
  if (m === 'card') return 'CARD_CLEARING';
  // 'bank', 'bank_transfer', sonstiges → BANK
  return 'BANK';
}

export function postOrderPayment(
  payment: OrderPaymentLike,
  customerId: string
): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postOrderPayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = orderPaymentCashAccountFor(payment.method);
  return postEntries(
    [
      {
        account: cashAcc,
        direction: 'DEBIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { orderId: payment.orderId, method: payment.method ?? 'cash' },
      },
      {
        account: 'CUSTOMER_DEPOSITS',
        direction: 'CREDIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { orderId: payment.orderId, method: payment.method ?? 'cash' },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'ORDER_PAYMENT',
      sourceId: payment.id,
    }
  );
}

// Reverse einen Order-Payment-Eintrag — bei Lösch oder Convert-to-Invoice.
export function postOrderPaymentReversed(orderPaymentId: string): PostingResult {
  return reverseSource('ORDER_PAYMENT', orderPaymentId, new Date().toISOString());
}

// v0.7.0 — Order-Cancel mit Geld-Handling. Drei Optionen:
//   refund   → Geld zurueck an Kunden:   CUSTOMER_DEPOSITS −X · CASH/BANK/BENEFIT −X
//   forfeit  → Storno-Gebuehr (Verfall): CUSTOMER_DEPOSITS −X · CANCELLATION_FEE_INCOME +X
//   credit   → Als Guthaben behalten — KEINE Ledger-Buchung. Die Liability bleibt
//              als CUSTOMER_DEPOSITS und der Caller schreibt einen Domain-Eintrag
//              in `customer_credits`, der beim naechsten Sale eingeloest wird.
export interface OrderCancellationChoice {
  orderId: string;
  customerId: string;
  totalPaid: number;
  choice: 'refund' | 'credit' | 'forfeit';
  refundMethod?: 'cash' | 'bank' | 'benefit';
  occurredAt?: string;
}

export function postOrderCancellationChoice(c: OrderCancellationChoice): PostingResult | null {
  const amount = ROUND(c.totalPaid);
  if (amount <= 0) return null;
  if (c.choice === 'credit') return null; // kein Ledger-Effekt
  const now = c.occurredAt || new Date().toISOString();

  if (c.choice === 'refund') {
    const method = c.refundMethod || 'cash';
    const cashAcc = orderPaymentCashAccountFor(method);
    return postEntries(
      [
        {
          account: 'CUSTOMER_DEPOSITS', direction: 'DEBIT', amount,
          counterpartyType: 'CUSTOMER', counterpartyId: c.customerId,
          metadata: { orderId: c.orderId, refundMethod: method, kind: 'order_cancel_refund' },
        },
        {
          account: cashAcc, direction: 'CREDIT', amount,
          counterpartyType: 'CUSTOMER', counterpartyId: c.customerId,
          metadata: { orderId: c.orderId, refundMethod: method, kind: 'order_cancel_refund' },
        },
      ],
      { occurredAt: now, sourceModule: 'ORDER_CANCEL', sourceId: `refund:${c.orderId}` }
    );
  }

  // forfeit
  return postEntries(
    [
      {
        account: 'CUSTOMER_DEPOSITS', direction: 'DEBIT', amount,
        counterpartyType: 'CUSTOMER', counterpartyId: c.customerId,
        metadata: { orderId: c.orderId, kind: 'cancellation_fee' },
      },
      {
        account: 'CANCELLATION_FEE_INCOME', direction: 'CREDIT', amount,
        counterpartyType: 'CUSTOMER', counterpartyId: c.customerId,
        metadata: { orderId: c.orderId, kind: 'cancellation_fee' },
      },
    ],
    { occurredAt: now, sourceModule: 'ORDER_CANCEL', sourceId: `forfeit:${c.orderId}` }
  );
}

// ── Loan / Debt ───────────────────────────────────────────────
//
// Zwei Richtungen:
//   MONEY_GIVEN (we_lend):
//     DEBIT  LOAN_RECEIVABLE        by amount
//     CREDIT cashAccountFor(source) by amount   (Geld geht raus)
//
//   MONEY_RECEIVED (we_borrow):
//     DEBIT  cashAccountFor(source) by amount   (Geld kommt rein)
//     CREDIT LOAN_PAYABLE           by amount
//
// Beim Repayment dreht sich die Cash-Bewegung um, und die jeweilige
// Loan-Bilanz wird abgebaut.

function loanCashAccountFor(source: CashSource): LedgerAccount {
  if (source === 'cash') return 'CASH';
  if (source === 'benefit') return 'BENEFIT';
  return 'BANK';
}

export function postLoanCreated(debt: Debt): PostingResult {
  const amount = ROUND(debt.amount);
  if (amount <= 0) {
    throw new Error(`postLoanCreated: amount must be > 0 (got ${debt.amount})`);
  }
  const dir: CanonicalLoanDirection = canonicalLoanDirection(debt.direction);
  const cashAcc = loanCashAccountFor(debt.source);
  const occurredAt = debt.createdAt;

  const entries: LedgerEntryInput[] =
    dir === 'MONEY_GIVEN'
      ? [
          {
            account: 'LOAN_RECEIVABLE',
            direction: 'DEBIT',
            amount,
            metadata: { loanNumber: debt.loanNumber, counterparty: debt.counterparty, direction: 'MONEY_GIVEN' },
          },
          {
            account: cashAcc,
            direction: 'CREDIT',
            amount,
            metadata: { loanNumber: debt.loanNumber, counterparty: debt.counterparty, direction: 'MONEY_GIVEN' },
          },
        ]
      : [
          {
            account: cashAcc,
            direction: 'DEBIT',
            amount,
            metadata: { loanNumber: debt.loanNumber, counterparty: debt.counterparty, direction: 'MONEY_RECEIVED' },
          },
          {
            account: 'LOAN_PAYABLE',
            direction: 'CREDIT',
            amount,
            metadata: { loanNumber: debt.loanNumber, counterparty: debt.counterparty, direction: 'MONEY_RECEIVED' },
          },
        ];

  return postEntries(entries, {
    occurredAt,
    sourceModule: 'LOAN',
    sourceId: debt.id,
  });
}

export function postLoanPayment(payment: DebtPayment, direction: CanonicalLoanDirection): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postLoanPayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = loanCashAccountFor(payment.source);

  // MONEY_GIVEN repayment: counterparty zahlt zurück → cash REIN, LOAN_RECEIVABLE runter.
  // MONEY_RECEIVED repayment: wir zahlen zurück → cash RAUS, LOAN_PAYABLE runter.
  const entries: LedgerEntryInput[] =
    direction === 'MONEY_GIVEN'
      ? [
          {
            account: cashAcc,
            direction: 'DEBIT',
            amount,
            metadata: { debtId: payment.debtId, direction: 'MONEY_GIVEN' },
          },
          {
            account: 'LOAN_RECEIVABLE',
            direction: 'CREDIT',
            amount,
            metadata: { debtId: payment.debtId, direction: 'MONEY_GIVEN' },
          },
        ]
      : [
          {
            account: 'LOAN_PAYABLE',
            direction: 'DEBIT',
            amount,
            metadata: { debtId: payment.debtId, direction: 'MONEY_RECEIVED' },
          },
          {
            account: cashAcc,
            direction: 'CREDIT',
            amount,
            metadata: { debtId: payment.debtId, direction: 'MONEY_RECEIVED' },
          },
        ];

  return postEntries(entries, {
    occurredAt: payment.paidAt,
    sourceModule: 'LOAN_PAYMENT',
    sourceId: payment.id,
  });
}

// Loan-Storno: spiegelt nur die LOAN-Originalbuchung zurück.
// Bestehende Repayments bleiben gebucht — Reconciliation surface deren
// Diskrepanz, falls der Loan trotz erfolgter Rückzahlungen storniert wird.
export function postLoanCancelled(debt: Debt): PostingResult {
  return reverseSource('LOAN', debt.id, new Date().toISOString());
}

export function postLoanPaymentReversed(paymentId: string): PostingResult {
  return reverseSource('LOAN_PAYMENT', paymentId, new Date().toISOString());
}

// ── Tax Payment (Quartals-VAT-Abführung) ─────────────────────
//
//   DEBIT  TAX_PAID by amount
//   CREDIT CASH/BANK by amount

export interface TaxPaymentLike {
  id: string;
  amount: number;
  source: 'cash' | 'bank';
  paidAt: string;            // ISO
  year?: number;
  quarter?: number;
  note?: string;
}

export function postTaxPayment(payment: TaxPaymentLike): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postTaxPayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc: LedgerAccount = payment.source === 'cash' ? 'CASH' : 'BANK';
  return postEntries(
    [
      {
        account: 'TAX_PAID',
        direction: 'DEBIT',
        amount,
        metadata: { year: payment.year, quarter: payment.quarter, note: payment.note },
      },
      {
        account: cashAcc,
        direction: 'CREDIT',
        amount,
        metadata: { year: payment.year, quarter: payment.quarter, note: payment.note },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'TAX_PAYMENT',
      sourceId: payment.id,
    }
  );
}

export function postTaxPaymentReversed(paymentId: string): PostingResult {
  return reverseSource('TAX_PAYMENT', paymentId, new Date().toISOString());
}

// ── Partner Transaction (Equity-Bewegung) ────────────────────
//
//   INVESTMENT          : DEBIT cash/bank      / CREDIT PARTNER_EQUITY
//   WITHDRAWAL          : DEBIT PARTNER_EQUITY / CREDIT cash/bank
//   PROFIT_DISTRIBUTION : DEBIT PARTNER_EQUITY / CREDIT cash/bank
//
// Wir machen keinen Unterschied zwischen WITHDRAWAL (Kapital-Rückgabe) und
// PROFIT_DISTRIBUTION (Gewinn-Auszahlung) auf Ledger-Ebene — beide reduzieren
// PARTNER_EQUITY und treiben Cash raus. Der semantische Unterschied (Capital vs.
// Profits) ist später via Sub-Account oder Reporting trennbar; für jetzt: gleich.

export type PartnerTxKind = 'INVESTMENT' | 'WITHDRAWAL' | 'PROFIT_DISTRIBUTION';

export interface PartnerTxLike {
  id: string;
  partnerId: string;
  type: PartnerTxKind;
  amount: number;
  method: 'cash' | 'bank' | 'benefit';
  transactionDate: string;
  transactionNumber?: string;
}

export function postPartnerTransaction(tx: PartnerTxLike): PostingResult {
  const amount = ROUND(tx.amount);
  if (amount <= 0) {
    throw new Error(`postPartnerTransaction: amount must be > 0 (got ${tx.amount})`);
  }
  const cashAcc: LedgerAccount = tx.method === 'cash' ? 'CASH' : tx.method === 'benefit' ? 'BENEFIT' : 'BANK';
  const meta = { partnerTxNumber: tx.transactionNumber, type: tx.type };

  const entries: LedgerEntryInput[] =
    tx.type === 'INVESTMENT'
      ? [
          {
            account: cashAcc,
            direction: 'DEBIT',
            amount,
            counterpartyType: 'PARTNER',
            counterpartyId: tx.partnerId,
            metadata: meta,
          },
          {
            account: 'PARTNER_EQUITY',
            direction: 'CREDIT',
            amount,
            counterpartyType: 'PARTNER',
            counterpartyId: tx.partnerId,
            metadata: meta,
          },
        ]
      : [
          {
            account: 'PARTNER_EQUITY',
            direction: 'DEBIT',
            amount,
            counterpartyType: 'PARTNER',
            counterpartyId: tx.partnerId,
            metadata: meta,
          },
          {
            account: cashAcc,
            direction: 'CREDIT',
            amount,
            counterpartyType: 'PARTNER',
            counterpartyId: tx.partnerId,
            metadata: meta,
          },
        ];

  return postEntries(entries, {
    occurredAt: tx.transactionDate,
    sourceModule: 'PARTNER_TX',
    sourceId: tx.id,
  });
}

export function postPartnerTransactionReversed(txId: string): PostingResult {
  return reverseSource('PARTNER_TX', txId, new Date().toISOString());
}

// ── Repair Payment (Customer-Charge ohne Invoice) ────────────
//
// Anwendungsfall: Kunde zahlt direkt für die Reparatur, OHNE dass eine Invoice
// erstellt wird. Wenn später eine Invoice gekoppelt wird, läuft die Bezahlung
// über invoice_payments (siehe bankingStore-Filter `if (r.invoice_id) continue`).
//
//   DEBIT  CASH/BANK/CARD by amount
//   CREDIT REVENUE        by amount
//
// VAT-Split nicht modelliert — Standalone-Repair-Cash geht direkt in REVENUE.
// Bei späterem Invoice-Convert müsste manuell reverst werden (Reconciliation surface).

export interface RepairPaymentLike {
  id: string;            // synthetisch — repair_payments-Tabelle existiert nicht,
                         // also UUID per Aufruf erzeugt; Reconciliation linkt via metadata.repairId.
  repairId: string;
  amount: number;
  method: 'cash' | 'bank' | 'card';
  paidAt: string;
  customerId?: string;
}

function repairCashAccountFor(method: 'cash' | 'bank' | 'card'): LedgerAccount {
  if (method === 'cash') return 'CASH';
  if (method === 'card') return 'CARD_CLEARING';
  return 'BANK';
}

export function postRepairPayment(payment: RepairPaymentLike): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postRepairPayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = repairCashAccountFor(payment.method);
  const cpType: CounterpartyType | undefined = payment.customerId ? 'CUSTOMER' : undefined;
  return postEntries(
    [
      {
        account: cashAcc,
        direction: 'DEBIT',
        amount,
        counterpartyType: cpType,
        counterpartyId: payment.customerId,
        metadata: { repairId: payment.repairId, method: payment.method },
      },
      {
        account: 'REVENUE',
        direction: 'CREDIT',
        amount,
        counterpartyType: cpType,
        counterpartyId: payment.customerId,
        metadata: { repairId: payment.repairId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'REPAIR_PAYMENT',
      sourceId: payment.id,
    }
  );
}

export function postRepairPaymentReversed(paymentId: string): PostingResult {
  return reverseSource('REPAIR_PAYMENT', paymentId, new Date().toISOString());
}

// ── Metal Payment (Verkauf von Edelmetallen) ──────────────────
//
//   DEBIT  CASH/BANK/CARD by amount
//   CREDIT REVENUE        by amount
//
// Wie Repair-Payments: simplified, kein VAT-Split. Wenn Edelmetallverkäufe je
// VAT-pflichtig werden, separater Sub-Account.

export interface MetalPaymentLike {
  id: string;
  metalId: string;
  amount: number;
  method: string;        // 'cash' | 'bank' | 'card' | etc.
  paidAt: string;
}

function metalCashAccountFor(method: string): LedgerAccount {
  const m = (method || 'bank').toLowerCase();
  if (m === 'cash') return 'CASH';
  if (m === 'card') return 'CARD_CLEARING';
  return 'BANK';
}

export function postMetalPayment(payment: MetalPaymentLike): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postMetalPayment: amount must be > 0 (got ${payment.amount})`);
  }
  const cashAcc = metalCashAccountFor(payment.method);
  return postEntries(
    [
      {
        account: cashAcc,
        direction: 'DEBIT',
        amount,
        metadata: { metalId: payment.metalId, method: payment.method },
      },
      {
        account: 'REVENUE',
        direction: 'CREDIT',
        amount,
        metadata: { metalId: payment.metalId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'METAL_PAYMENT',
      sourceId: payment.id,
    }
  );
}

export function postMetalPaymentReversed(paymentId: string): PostingResult {
  return reverseSource('METAL_PAYMENT', paymentId, new Date().toISOString());
}

// ── Agent Settlement Payment (Legacy-Pfad ohne Invoice) ──────
//
// Anwendungsfall: Agent verkauft unsere Ware, behält Kommission, überweist uns
// das Settlement. Wenn KEINE Invoice gekoppelt ist (UI-Fallback), läuft die Cash-
// Bewegung direkt über agent_settlement_payments. Die Convert-to-Invoice-Logik
// reverst diese Buchungen, sobald eine Invoice angelegt wird (siehe
// agentStore.convertTransferToInvoice).
//
//   DEBIT  CASH/BANK by amount
//   CREDIT REVENUE   by amount
//
// Match bestehende bankingStore-Klassifizierung (SALES_IN). Kein VAT-Split —
// wenn das gewünscht ist, MUSS Convert-to-Invoice genutzt werden.

// AGENT_TRANSFER_SOLD: Beim "Sold"-Klick auf einen Approval-Transfer entsteht
// eine Forderung gegen den verknüpften Customer. Sichtbar im Customer-Ledger
// (customerBalance) und damit auch in Customer-Detail-KPIs / Dashboard.
// VAT-frei (informelle Forderung) — wenn formale VAT-Rechnung gewünscht ist,
// muss Convert-to-Invoice genutzt werden (siehe convertTransferToInvoice).
//
//   DEBIT  ACCOUNTS_RECEIVABLE  by amount  (counterparty: CUSTOMER)
//   CREDIT REVENUE              by amount  (counterparty: CUSTOMER)

export interface AgentTransferSoldLike {
  transferId: string;
  amount: number;
  soldAt: string;
}

export function postAgentTransferSold(transfer: AgentTransferSoldLike, customerId: string): PostingResult {
  const amount = ROUND(transfer.amount);
  if (amount <= 0) {
    throw new Error(`postAgentTransferSold: amount must be > 0 (got ${transfer.amount})`);
  }
  if (!customerId) {
    throw new Error('postAgentTransferSold: customerId required to post receivable.');
  }
  return postEntries(
    [
      {
        account: 'ACCOUNTS_RECEIVABLE',
        direction: 'DEBIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { transferId: transfer.transferId },
      },
      {
        account: 'REVENUE',
        direction: 'CREDIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { transferId: transfer.transferId },
      },
    ],
    {
      occurredAt: transfer.soldAt,
      sourceModule: 'AGENT_TRANSFER_SOLD',
      sourceId: transfer.transferId,
    }
  );
}

export function postAgentTransferSoldReversed(transferId: string, occurredAt?: string): PostingResult {
  return reverseSource('AGENT_TRANSFER_SOLD', transferId, occurredAt || new Date().toISOString());
}

export interface AgentSettlementPaymentLike {
  id: string;
  transferId: string;
  amount: number;
  method: 'cash' | 'bank';
  paidAt: string;
}

// AGENT_SETTLEMENT: Cash/Bank-Eingang vom Agent — reduziert die offene Forderung
// (counterparty: CUSTOMER). Greift nur sauber, wenn vorher AGENT_TRANSFER_SOLD
// gepostet wurde. Für historische Settlements ohne Sold-Post: Backfill über
// backfill.ts: AGENT_TRANSFER_SOLD posted dann nachträglich die fehlende Forderung.
//
//   DEBIT  CASH/BANK            by amount
//   CREDIT ACCOUNTS_RECEIVABLE  by amount  (counterparty: CUSTOMER)

export function postAgentSettlementPayment(payment: AgentSettlementPaymentLike, customerId: string): PostingResult {
  const amount = ROUND(payment.amount);
  if (amount <= 0) {
    throw new Error(`postAgentSettlementPayment: amount must be > 0 (got ${payment.amount})`);
  }
  if (!customerId) {
    throw new Error('postAgentSettlementPayment: customerId required to reduce receivable.');
  }
  const cashAcc: LedgerAccount = payment.method === 'cash' ? 'CASH' : 'BANK';
  return postEntries(
    [
      {
        account: cashAcc,
        direction: 'DEBIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { transferId: payment.transferId, method: payment.method },
      },
      {
        account: 'ACCOUNTS_RECEIVABLE',
        direction: 'CREDIT',
        amount,
        counterpartyType: 'CUSTOMER',
        counterpartyId: customerId,
        metadata: { transferId: payment.transferId, method: payment.method },
      },
    ],
    {
      occurredAt: payment.paidAt,
      sourceModule: 'AGENT_SETTLEMENT',
      sourceId: payment.id,
    }
  );
}

export function postAgentSettlementPaymentReversed(paymentId: string): PostingResult {
  return reverseSource('AGENT_SETTLEMENT', paymentId, new Date().toISOString());
}

// ── Consignment Payout (Auszahlung an Consignor) ─────────────
//
// Wir haben Ware fremder Personen (Consignor) verkauft, die Buyer-Invoice hat
// die volle salePrice als REVENUE gebucht. Beim Payout an den Consignor müssen
// wir die nicht-uns-gehörende Hälfte raus aus dem System nehmen.
//
//   DEBIT  EXPENSES_OPERATING by amount  (Pseudo-Aufwand: Geld fließt raus, ist nicht unser Erlös)
//   CREDIT CASH/BANK          by amount
//
// Ergebnis: REVENUE − EXPENSES_OPERATING ergibt die echte Marge (= Kommission).
// Match bestehende bankingStore-Klassifizierung (EXPENSE_OUT).

export interface ConsignmentPayoutLike {
  id: string;             // synthetisch — consignment_payouts existiert nicht als eigene Tabelle
  consignmentId: string;
  consignorId?: string;   // customer_id des Consignors
  amount: number;
  method: 'cash' | 'bank';
  paidAt: string;
}

export function postConsignmentPayout(payout: ConsignmentPayoutLike): PostingResult {
  const amount = ROUND(payout.amount);
  if (amount <= 0) {
    throw new Error(`postConsignmentPayout: amount must be > 0 (got ${payout.amount})`);
  }
  const cashAcc: LedgerAccount = payout.method === 'cash' ? 'CASH' : 'BANK';
  const cpType: CounterpartyType | undefined = payout.consignorId ? 'CUSTOMER' : undefined;
  return postEntries(
    [
      {
        account: 'EXPENSES_OPERATING',
        direction: 'DEBIT',
        amount,
        counterpartyType: cpType,
        counterpartyId: payout.consignorId,
        metadata: { consignmentId: payout.consignmentId, kind: 'consignor_payout', method: payout.method },
      },
      {
        account: cashAcc,
        direction: 'CREDIT',
        amount,
        counterpartyType: cpType,
        counterpartyId: payout.consignorId,
        metadata: { consignmentId: payout.consignmentId, kind: 'consignor_payout', method: payout.method },
      },
    ],
    {
      occurredAt: payout.paidAt,
      sourceModule: 'CONSIGNMENT_PAYOUT',
      sourceId: payout.id,
    }
  );
}

export function postConsignmentPayoutReversed(payoutId: string): PostingResult {
  return reverseSource('CONSIGNMENT_PAYOUT', payoutId, new Date().toISOString());
}

// ── Scrap Gold Quick Trade ───────────────────────────────────
//
// Brutto-Booking mit Spread-Income: Echte Cash-Bewegungen pro Split
// gehen ins Ledger, dazu nur der Spread als REVENUE (bzw. EXPENSES_OPERATING
// bei Verlust). So sind reale Cash-Flows in Banking sichtbar, und der
// Profit-Report sieht nur den Spread, nicht den vollen Sale Price.
//
// Beispiel: Purchase 200 cash + 300 benefit (= 500), Sale 300 cash + 600 bank (= 900)
//   DEBIT  CASH    300   (sale-split 1: vom Buyer)
//   DEBIT  BANK    600   (sale-split 2: vom Buyer)
//   CREDIT CASH    200   (purchase-split 1: zum Seller)
//   CREDIT BENEFIT 300   (purchase-split 2: zum Seller)
//   CREDIT REVENUE 400   (Spread)
//
// Bei Verlust (z.B. Purchase 1000, Sale 950):
//   DEBIT  cash[sale-splits]
//   DEBIT  EXPENSES_OPERATING (|spread|)
//   CREDIT cash[purchase-splits]
//
// Bei Zero-Spread: nur Cash-Verschiebung, keine REVENUE-Zeile.

export interface ScrapPaymentSplit {
  method: ScrapPaymentMethod;
  amount: number;
}

export interface ScrapTradePostInput {
  id: string;
  tradeDate: string;
  paymentsOut: ScrapPaymentSplit[];   // zum Seller (Purchase)
  paymentsIn: ScrapPaymentSplit[];    // vom Buyer (Sale)
}

function scrapCashAccountFor(method: ScrapPaymentMethod): LedgerAccount {
  if (method === 'cash') return 'CASH';
  if (method === 'benefit') return 'BENEFIT';
  return 'BANK';
}

export function postScrapTrade(trade: ScrapTradePostInput): PostingResult | null {
  const sumIn = trade.paymentsIn.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const sumOut = trade.paymentsOut.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const spread = ROUND(sumIn - sumOut);

  const entries: LedgerEntryInput[] = [];

  // Cash-IN-Splits (vom Buyer → unsere Konten)
  for (const split of trade.paymentsIn) {
    const amt = ROUND(split.amount);
    if (amt <= 0) continue;
    entries.push({
      account: scrapCashAccountFor(split.method),
      direction: 'DEBIT',
      amount: amt,
      metadata: { scrapTradeId: trade.id, kind: 'sale_in', method: split.method },
    });
  }

  // Cash-OUT-Splits (zum Seller → aus unseren Konten)
  for (const split of trade.paymentsOut) {
    const amt = ROUND(split.amount);
    if (amt <= 0) continue;
    entries.push({
      account: scrapCashAccountFor(split.method),
      direction: 'CREDIT',
      amount: amt,
      metadata: { scrapTradeId: trade.id, kind: 'purchase_out', method: split.method },
    });
  }

  // Spread als REVENUE (gain) bzw. EXPENSES_OPERATING (loss)
  if (spread > EPSILON) {
    entries.push({
      account: 'REVENUE',
      direction: 'CREDIT',
      amount: spread,
      metadata: { scrapTradeId: trade.id, kind: 'spread_income' },
    });
  } else if (spread < -EPSILON) {
    entries.push({
      account: 'EXPENSES_OPERATING',
      direction: 'DEBIT',
      amount: -spread,
      metadata: { scrapTradeId: trade.id, kind: 'spread_loss' },
    });
  }

  if (entries.length === 0) return null;

  return postEntries(entries, {
    occurredAt: trade.tradeDate,
    sourceModule: 'SCRAP_TRADE',
    sourceId: trade.id,
  });
}

export function postScrapTradeReversed(tradeId: string): PostingResult {
  return reverseSource('SCRAP_TRADE', tradeId, new Date().toISOString());
}

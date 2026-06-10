// ZIEL.md §3a — Ledger Backfill.
// Replay aller historischen Domain-Records durch den Posting-Service.
// Idempotenz via hasLedgerEntries — bestehende Posts werden übersprungen.
//
// Reihenfolge ist nicht kritisch (Posting validiert nur pro-Transaction-Bilanz),
// aber wir backfillen Quellen vor ihren Folge-Effekten:
//   Invoices vor Payments, Purchases vor Purchase-Payments, etc.
// Cancelled-Records werden ZUSÄTZLICH per reverseSource storniert.

import {
  postInvoiceIssued,
  postInvoiceCogsBackfill,
  postInvoicePayment,
  postInvoiceCancelled,
  postCreditNote,
  postPurchaseReceived,
  postPurchasePayment,
  postPurchaseCancelled,
  postExpense,
  postExpensePayment,
  postExpenseCancelled,
  postBankTransfer,
  postOrderPayment,
  postOrderPaymentReversed,
  postLoanCreated,
  postLoanPayment,
  postLoanCancelled,
  postPartnerTransaction,
  postTaxPayment,
  postMetalPayment,
  postAgentSettlementPayment,
  postAgentSettlementPaymentReversed,
  postAgentTransferSold,
  postConsignmentPayout,
  postOpeningBalances,
  postOrderCancellationChoice,
  postGoldConversionCredit,
  hasLedgerEntries,
  hasReversalFor,
  reverseSource,
  reverseTransaction,
} from '@/core/ledger/posting';
import { canonicalLoanDirection } from '@/core/models/types';
import { query } from '@/core/db/helpers';
import { getDatabase, saveDatabase } from '@/core/db/database';
import type {
  Invoice, InvoiceLine, Purchase, PurchaseLine, Expense,
  BankTransfer, Debt, CreditNote, Payment, PaymentMethod,
} from '@/core/models/types';

export interface BackfillResult {
  domain: string;
  total: number;
  posted: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function emptyResult(domain: string): BackfillResult {
  return { domain, total: 0, posted: 0, skipped: 0, failed: 0, errors: [] };
}

function safeStep(res: BackfillResult, label: string, fn: () => void): void {
  try { fn(); res.posted++; }
  catch (err) {
    res.failed++;
    res.errors.push(`${label}: ${(err as Error).message}`);
  }
}

// ── Invoices + Lines ──────────────────────────────────────────

export function backfillInvoices(branchId: string): BackfillResult {
  const res = emptyResult('invoices');
  const rows = query(
    `SELECT * FROM invoices WHERE branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('INVOICE', id)) { res.skipped++; continue; }

    const lineRows = query(
      `SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position`,
      [id]
    );
    const lines: InvoiceLine[] = lineRows.map(lr => ({
      id: lr.id as string,
      invoiceId: id,
      productId: (lr.product_id as string | null) || '',
      quantity: Number(lr.quantity || 1),
      unitPrice: Number(lr.unit_price || 0),
      purchasePriceSnapshot: Number(lr.purchase_price_snapshot || 0),
      vatRate: Number(lr.vat_rate || 0),
      taxScheme: (lr.tax_scheme as InvoiceLine['taxScheme']) || 'MARGIN',
      vatAmount: Number(lr.vat_amount || 0),
      lineTotal: Number(lr.line_total || 0),
      position: Number(lr.position || 0),
    }));
    if (lines.length === 0) { res.skipped++; continue; }

    const invoice: Invoice = {
      id,
      invoiceNumber: r.invoice_number as string,
      customerId: r.customer_id as string,
      offerId: (r.offer_id as string | null) || undefined,
      status: (r.status as Invoice['status']) || 'FINAL',
      currency: ((r.currency as string) || 'BHD') as Invoice['currency'],
      netAmount: Number(r.net_amount || 0),
      vatRateSnapshot: Number(r.vat_rate_snapshot || 0),
      vatAmount: Number(r.vat_amount || 0),
      grossAmount: Number(r.gross_amount || 0),
      taxSchemeSnapshot: (r.tax_scheme_snapshot as Invoice['taxSchemeSnapshot']) || undefined,
      paidAmount: Number(r.paid_amount || 0),
      issuedAt: r.issued_at as string,
      dueAt: (r.due_date as string | null) || undefined,
      lines,
      createdAt: r.created_at as string,
    };

    safeStep(res, `invoice ${invoice.invoiceNumber}`, () => {
      postInvoiceIssued(invoice);
      // Wenn der Invoice cancelled war, sofort die Reversal-Buchung anstoßen,
      // damit historische Stornos im Ledger-Saldo korrekt abgebildet sind.
      if (invoice.status === 'CANCELLED' && !hasReversalFor('INVOICE', id)) {
        postInvoiceCancelled(invoice);
      }
    });
  }
  return res;
}

// ── Invoice COGS (Weg A / #1) ─────────────────────────────────
//
// Traegt fuer bereits-gepostete (aktive) Invoices das fehlende COGS/INVENTORY-
// Paar nach. Guards:
//   - hasLedgerEntries('INVOICE', id): nur aktive Sales (cancelled = alles
//     reversed → false → skip, bleibt netto-null).
//   - hasInvoiceCogs(id): bereits COGS vorhanden → skip (idempotent, kein
//     Doppel-Paar; deckt sowohl Post-H-01-Invoices als auch fruehere Re-Runs ab).
function hasInvoiceCogs(invoiceId: string): boolean {
  return query(
    `SELECT 1 FROM ledger_entries
      WHERE source_module = 'INVOICE' AND source_id = ?
        AND account = 'COGS' AND reverses_entry_id IS NULL
      LIMIT 1`,
    [invoiceId]
  ).length > 0;
}

export function backfillInvoiceCogs(branchId: string): BackfillResult {
  const res = emptyResult('invoice_cogs');
  const rows = query(`SELECT * FROM invoices WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    // Nur aktive, schon gepostete Sales; cancelled (alles reversed) ueberspringen.
    if (!hasLedgerEntries('INVOICE', id)) { res.skipped++; continue; }
    if (hasInvoiceCogs(id)) { res.skipped++; continue; }

    const lineRows = query(
      `SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position`,
      [id]
    );
    const lines: InvoiceLine[] = lineRows.map(lr => ({
      id: lr.id as string,
      invoiceId: id,
      productId: (lr.product_id as string | null) || '',
      quantity: Number(lr.quantity || 1),
      unitPrice: Number(lr.unit_price || 0),
      purchasePriceSnapshot: Number(lr.purchase_price_snapshot || 0),
      vatRate: Number(lr.vat_rate || 0),
      taxScheme: (lr.tax_scheme as InvoiceLine['taxScheme']) || 'MARGIN',
      vatAmount: Number(lr.vat_amount || 0),
      lineTotal: Number(lr.line_total || 0),
      position: Number(lr.position || 0),
    }));
    if (lines.length === 0) { res.skipped++; continue; }

    const invoice: Invoice = {
      id,
      invoiceNumber: r.invoice_number as string,
      customerId: r.customer_id as string,
      status: (r.status as Invoice['status']) || 'FINAL',
      currency: ((r.currency as string) || 'BHD') as Invoice['currency'],
      netAmount: Number(r.net_amount || 0),
      vatRateSnapshot: Number(r.vat_rate_snapshot || 0),
      vatAmount: Number(r.vat_amount || 0),
      grossAmount: Number(r.gross_amount || 0),
      taxSchemeSnapshot: (r.tax_scheme_snapshot as Invoice['taxSchemeSnapshot']) || undefined,
      paidAmount: Number(r.paid_amount || 0),
      issuedAt: r.issued_at as string,
      lines,
      createdAt: r.created_at as string,
    };

    // postInvoiceCogsBackfill gibt null zurueck, wenn keine Cost-Zeile (Service-only) →
    // dann als skip zaehlen statt als posted. Inline try/catch statt safeStep, damit
    // posted/skipped/failed sich nicht ueberschneiden.
    try {
      const posted = postInvoiceCogsBackfill(invoice);
      if (posted !== null) res.posted++;
      else res.skipped++;
    } catch (err) {
      res.failed++;
      res.errors.push(`inv-cogs ${invoice.invoiceNumber}: ${(err as Error).message}`);
    }
  }
  return res;
}

export function backfillInvoicePayments(branchId: string): BackfillResult {
  const res = emptyResult('invoice_payments');
  const rows = query(
    `SELECT p.id, p.invoice_id, p.amount, p.method, p.received_at, p.created_at, i.customer_id
     FROM payments p JOIN invoices i ON i.id = p.invoice_id
     WHERE i.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('PAYMENT', id)) { res.skipped++; continue; }
    const customerId = r.customer_id as string;
    const payment: Payment = {
      id,
      invoiceId: r.invoice_id as string,
      amount: Number(r.amount || 0),
      method: (r.method as PaymentMethod) || 'cash',
      receivedAt: r.received_at as string,
      createdAt: r.created_at as string,
    };
    safeStep(res, `payment ${id.slice(0, 8)}`, () => postInvoicePayment(payment, customerId));
  }
  return res;
}

export function backfillCreditNotes(branchId: string): BackfillResult {
  const res = emptyResult('credit_notes');
  const rows = query(
    `SELECT * FROM credit_notes WHERE branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('CREDIT_NOTE', id)) { res.skipped++; continue; }
    const cn: CreditNote = {
      id,
      creditNoteNumber: r.credit_note_number as string,
      branchId: r.branch_id as string,
      invoiceId: r.invoice_id as string,
      salesReturnId: (r.sales_return_id as string | null) || undefined,
      customerId: r.customer_id as string,
      issuedAt: r.issued_at as string,
      totalAmount: Number(r.total_amount || 0),
      vatAmount: Number(r.vat_amount || 0),
      cashRefundAmount: Number(r.cash_refund_amount || 0),
      receivableCancelAmount: Number(r.receivable_cancel_amount || 0),
      refundMethod: (r.refund_method as CreditNote['refundMethod']) || undefined,
      reason: (r.reason as string | null) || undefined,
      notes: (r.notes as string | null) || undefined,
      createdAt: r.created_at as string,
      createdBy: (r.created_by as string | null) || undefined,
    };
    safeStep(res, `cn ${cn.creditNoteNumber}`, () => postCreditNote(cn));
  }
  return res;
}

// ── Purchases + Lines ─────────────────────────────────────────

export function backfillPurchases(branchId: string): BackfillResult {
  const res = emptyResult('purchases');
  const rows = query(`SELECT * FROM purchases WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('PURCHASE', id)) { res.skipped++; continue; }
    const lineRows = query(
      `SELECT * FROM purchase_lines WHERE purchase_id = ? ORDER BY position`,
      [id]
    );
    const lines: PurchaseLine[] = lineRows.map(lr => ({
      id: lr.id as string,
      purchaseId: id,
      productId: (lr.product_id as string | null) || undefined,
      description: (lr.description as string | null) || undefined,
      quantity: Number(lr.quantity || 1),
      unitPrice: Number(lr.unit_price || 0),
      lineTotal: Number(lr.line_total || 0),
      position: Number(lr.position || 0),
      taxScheme: (lr.tax_scheme as 'ZERO' | 'VAT_10' | null) || undefined,
      vatRate: lr.vat_rate != null ? Number(lr.vat_rate) : undefined,
      vatAmount: lr.vat_amount != null ? Number(lr.vat_amount) : undefined,
    }));
    if (lines.length === 0) { res.skipped++; continue; }
    const purchase: Purchase = {
      id,
      purchaseNumber: r.purchase_number as string,
      branchId: r.branch_id as string,
      supplierId: r.supplier_id as string,
      status: (r.status as Purchase['status']) || 'UNPAID',
      totalAmount: Number(r.total_amount || 0),
      paidAmount: Number(r.paid_amount || 0),
      remainingAmount: Number(r.remaining_amount || 0),
      purchaseDate: r.purchase_date as string,
      notes: (r.notes as string | null) || undefined,
      lines,
      payments: [],
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
    safeStep(res, `purchase ${purchase.purchaseNumber}`, () => {
      postPurchaseReceived(purchase);
      if (purchase.status === 'CANCELLED' && !hasReversalFor('PURCHASE', id)) {
        postPurchaseCancelled(purchase);
      }
    });
  }
  return res;
}

export function backfillPurchasePayments(branchId: string): BackfillResult {
  const res = emptyResult('purchase_payments');
  const rows = query(
    `SELECT pp.*, p.supplier_id
     FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
     WHERE p.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('PURCHASE_PAYMENT', id)) { res.skipped++; continue; }
    safeStep(res, `pay ${id.slice(0, 8)}`, () => {
      postPurchasePayment(
        {
          id, purchaseId: r.purchase_id as string,
          amount: Number(r.amount || 0),
          method: (r.method as 'cash' | 'bank' | 'credit') || 'bank',
          paidAt: r.paid_at as string,
          reference: (r.reference as string | null) || undefined,
          note: (r.note as string | null) || undefined,
          createdAt: r.created_at as string,
        },
        r.supplier_id as string
      );
    });
  }
  return res;
}

// ── Expenses ──────────────────────────────────────────────────

export function backfillExpenses(branchId: string): BackfillResult {
  const res = emptyResult('expenses');
  const rows = query(`SELECT * FROM expenses WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('EXPENSE', id)) { res.skipped++; continue; }
    const expense: Expense = {
      id,
      expenseNumber: r.expense_number as string,
      branchId: r.branch_id as string,
      category: (r.category as Expense['category']) || 'Miscellaneous',
      amount: Number(r.amount || 0),
      paidAmount: Number(r.paid_amount || 0),
      paymentMethod: (r.payment_method as 'cash' | 'bank') || 'cash',
      expenseDate: r.expense_date as string,
      description: (r.description as string | null) || undefined,
      relatedModule: (r.related_module as string | null) || undefined,
      relatedEntityId: (r.related_entity_id as string | null) || undefined,
      supplierId: (r.supplier_id as string | null) || undefined,
      status: (r.status as Expense['status']) || 'PAID',
      createdAt: r.created_at as string,
    };
    if (expense.amount <= 0) { res.skipped++; continue; }
    safeStep(res, `exp ${expense.expenseNumber}`, () => {
      postExpense(expense);
      if (expense.status === 'CANCELLED' && !hasReversalFor('EXPENSE', id)) {
        postExpenseCancelled(expense);
      }
    });
  }
  return res;
}

export function backfillExpensePayments(branchId: string): BackfillResult {
  const res = emptyResult('expense_payments');
  const rows = query(
    `SELECT ep.*, e.supplier_id
     FROM expense_payments ep JOIN expenses e ON e.id = ep.expense_id
     WHERE e.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('EXPENSE_PAYMENT', id)) { res.skipped++; continue; }
    safeStep(res, `exp-pay ${id.slice(0, 8)}`, () => {
      postExpensePayment(
        {
          id, expenseId: r.expense_id as string,
          amount: Number(r.amount || 0),
          method: (r.method as 'cash' | 'bank') || 'cash',
          paidAt: r.paid_at as string,
          note: (r.note as string | null) || undefined,
          createdAt: r.created_at as string,
        },
        (r.supplier_id as string | null) || undefined
      );
    });
  }
  return res;
}

// ── Bank Transfers ────────────────────────────────────────────

export function backfillBankTransfers(branchId: string): BackfillResult {
  const res = emptyResult('bank_transfers');
  const rows = query(`SELECT * FROM bank_transfers WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('BANK_TRANSFER', id)) { res.skipped++; continue; }
    const transfer: BankTransfer = {
      id, branchId: r.branch_id as string,
      amount: Number(r.amount || 0),
      direction: (r.direction as 'CASH_TO_BANK' | 'BANK_TO_CASH') || 'CASH_TO_BANK',
      transferDate: r.transfer_date as string,
      notes: (r.notes as string | null) || undefined,
      createdAt: r.created_at as string,
      createdBy: (r.created_by as string | null) || undefined,
    };
    safeStep(res, `transfer ${id.slice(0, 8)}`, () => postBankTransfer(transfer));
  }
  return res;
}

// ── Order Payments (nur nicht-konvertierte) ──────────────────

export function backfillOrderPayments(branchId: string): BackfillResult {
  const res = emptyResult('order_payments');
  const rows = query(
    `SELECT op.*, o.customer_id, COALESCE(op.converted_to_invoice, 0) AS converted, o.status AS order_status
     FROM order_payments op JOIN orders o ON o.id = op.order_id
     WHERE o.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('ORDER_PAYMENT', id)) { res.skipped++; continue; }
    const customerId = r.customer_id as string;
    if (!customerId) { res.skipped++; continue; }
    const converted = Number(r.converted) === 1;
    const cancelled = String(r.order_status || '').toLowerCase() === 'cancelled';

    safeStep(res, `op ${id.slice(0, 8)}`, () => {
      postOrderPayment(
        {
          id, orderId: r.order_id as string,
          amount: Number(r.amount || 0),
          method: (r.method as string) || 'cash',
          paidAt: r.paid_at as string,
        },
        customerId
      );
      // Wenn der Order schon konvertiert oder cancelled ist, sofort die Reversal-
      // Buchung — sonst hängen ledger-mäßig phantom Customer-Deposits, obwohl im
      // Domain die Anzahlung ja längst abgewickelt (in invoice migriert oder cancelled).
      if ((converted || cancelled) && !hasReversalFor('ORDER_PAYMENT', id)) {
        postOrderPaymentReversed(id);
      }
    });
  }
  return res;
}

// ── Debts (Loans) ─────────────────────────────────────────────

export function backfillDebts(branchId: string): BackfillResult {
  const res = emptyResult('debts');
  const rows = query(`SELECT * FROM debts WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('LOAN', id)) { res.skipped++; continue; }
    const debt: Debt = {
      id,
      loanNumber: (r.loan_number as string | null) || undefined,
      direction: r.direction as Debt['direction'],
      counterparty: r.counterparty as string,
      customerId: (r.customer_id as string | null) || undefined,
      amount: Number(r.amount || 0),
      source: (r.source as 'cash' | 'bank') || 'bank',
      dueDate: (r.due_date as string | null) || undefined,
      notes: (r.notes as string | null) || undefined,
      status: (r.status as Debt['status']) || 'OPEN',
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      settledAt: (r.settled_at as string | null) || undefined,
      paidAmount: 0,
    };
    if (debt.amount <= 0) { res.skipped++; continue; }
    safeStep(res, `loan ${debt.loanNumber || id.slice(0, 8)}`, () => {
      postLoanCreated(debt);
      const status = String(debt.status || '').toUpperCase();
      if (status === 'CANCELLED' && !hasReversalFor('LOAN', id)) {
        postLoanCancelled(debt);
      }
    });
  }
  return res;
}

export function backfillDebtPayments(branchId: string): BackfillResult {
  const res = emptyResult('debt_payments');
  const rows = query(
    `SELECT dp.*, d.direction
     FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
     WHERE d.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('LOAN_PAYMENT', id)) { res.skipped++; continue; }
    const dir = canonicalLoanDirection(r.direction as string);
    safeStep(res, `loan-pay ${id.slice(0, 8)}`, () => {
      postLoanPayment(
        {
          id, debtId: r.debt_id as string,
          amount: Number(r.amount || 0),
          source: (r.source as 'cash' | 'bank') || 'bank',
          paidAt: r.paid_at as string,
          notes: (r.notes as string | null) || undefined,
          createdAt: r.created_at as string,
        },
        dir
      );
    });
  }
  return res;
}

// ── Partner Transactions ──────────────────────────────────────

export function backfillPartnerTransactions(branchId: string): BackfillResult {
  const res = emptyResult('partner_transactions');
  const rows = query(`SELECT * FROM partner_transactions WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('PARTNER_TX', id)) { res.skipped++; continue; }
    safeStep(res, `partner-tx ${id.slice(0, 8)}`, () => {
      postPartnerTransaction({
        id,
        partnerId: r.partner_id as string,
        type: (r.type as 'INVESTMENT' | 'WITHDRAWAL' | 'PROFIT_DISTRIBUTION'),
        amount: Number(r.amount || 0),
        method: (r.method as 'cash' | 'bank') || 'bank',
        transactionDate: r.transaction_date as string,
        transactionNumber: (r.transaction_number as string | null) || undefined,
      });
    });
  }
  return res;
}

// ── Tax Payments ──────────────────────────────────────────────

export function backfillTaxPayments(branchId: string): BackfillResult {
  const res = emptyResult('tax_payments');
  const rows = query(`SELECT * FROM tax_payments WHERE branch_id = ?`, [branchId]);
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('TAX_PAYMENT', id)) { res.skipped++; continue; }
    safeStep(res, `tax ${id.slice(0, 8)}`, () => {
      postTaxPayment({
        id,
        amount: Number(r.amount || 0),
        source: (r.source as 'cash' | 'bank') || 'bank',
        paidAt: r.paid_at as string,
        year: Number(r.year || 0),
        quarter: Number(r.quarter || 0),
        note: (r.note as string | null) || undefined,
      });
    });
  }
  return res;
}

// ── Metal Payments ────────────────────────────────────────────

export function backfillMetalPayments(branchId: string): BackfillResult {
  const res = emptyResult('metal_payments');
  const rows = query(
    `SELECT mp.* FROM metal_payments mp
     JOIN precious_metals pm ON pm.id = mp.metal_id
     WHERE pm.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('METAL_PAYMENT', id)) { res.skipped++; continue; }
    safeStep(res, `metal-pay ${id.slice(0, 8)}`, () => {
      postMetalPayment({
        id,
        metalId: r.metal_id as string,
        amount: Number(r.amount || 0),
        method: (r.method as string) || 'bank',
        paidAt: r.paid_at as string,
      });
    });
  }
  return res;
}

// ── Agent Settlement Payments ─────────────────────────────────

export function backfillAgentSettlementPayments(branchId: string): BackfillResult {
  const res = emptyResult('agent_settlement_payments');
  const rows = query(
    `SELECT asp.*, at.agent_id, ag.customer_id
     FROM agent_settlement_payments asp
     JOIN agent_transfers at ON at.id = asp.transfer_id
     JOIN agents ag ON ag.id = at.agent_id
     WHERE at.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('AGENT_SETTLEMENT', id)) { res.skipped++; continue; }
    const method = (r.method as 'cash' | 'bank') || 'cash';
    const customerId = (r.customer_id as string) || '';
    if (!customerId) { res.skipped++; continue; }
    safeStep(res, `agent-settle ${id.slice(0, 8)}`, () => {
      postAgentSettlementPayment(
        {
          id, transferId: r.transfer_id as string,
          amount: Number(r.amount || 0), method,
          paidAt: r.paid_at as string,
        },
        customerId
      );
    });
  }
  return res;
}

// ── Cleanup: Verwaiste AGENT_TRANSFER_SOLD / AGENT_SETTLEMENT-Posts ─────────
//
// Wenn ein Transfer früher (vor dem deleteTransfer-Fix) gelöscht wurde, ohne
// dass die zugehörigen Ledger-Posts reverst wurden, hängt die AR-Forderung
// noch im Customer-Ledger und das Outstanding zeigt einen falschen Wert.
// Diese Funktion findet Original-Posts ohne dazugehörigen Transfer-Datensatz
// und reverst sie. Idempotent: bereits reversierte Posts werden geskippt.

export function cleanupOrphanedAgentTransferLedger(branchId: string): BackfillResult {
  const res = emptyResult('agent_ledger_orphan_cleanup');

  // 1. Verwaiste AGENT_TRANSFER_SOLD-Posts: source_id kein passender agent_transfer.
  const orphanedSold = query(
    `SELECT DISTINCT le.source_id
     FROM ledger_entries le
     LEFT JOIN agent_transfers at ON at.id = le.source_id
     WHERE le.source_module = 'AGENT_TRANSFER_SOLD'
       AND le.reverses_entry_id IS NULL
       AND le.branch_id = ?
       AND at.id IS NULL`,
    [branchId]
  );

  // 2. Verwaiste AGENT_SETTLEMENT-Posts: source_id kein passendes agent_settlement_payment.
  const orphanedSettle = query(
    `SELECT DISTINCT le.source_id
     FROM ledger_entries le
     LEFT JOIN agent_settlement_payments asp ON asp.id = le.source_id
     WHERE le.source_module = 'AGENT_SETTLEMENT'
       AND le.reverses_entry_id IS NULL
       AND le.branch_id = ?
       AND asp.id IS NULL`,
    [branchId]
  );

  res.total = orphanedSold.length + orphanedSettle.length;

  for (const r of orphanedSold) {
    const sourceId = r.source_id as string;
    if (hasReversalFor('AGENT_TRANSFER_SOLD', sourceId)) { res.skipped++; continue; }
    safeStep(res, `orphan-sold ${sourceId.slice(0, 8)}`, () => {
      reverseSource('AGENT_TRANSFER_SOLD', sourceId, new Date().toISOString());
    });
  }

  for (const r of orphanedSettle) {
    const sourceId = r.source_id as string;
    if (hasReversalFor('AGENT_SETTLEMENT', sourceId)) { res.skipped++; continue; }
    safeStep(res, `orphan-settle ${sourceId.slice(0, 8)}`, () => {
      reverseSource('AGENT_SETTLEMENT', sourceId, new Date().toISOString());
    });
  }

  // 3. Phantom AGENT_SETTLEMENT-Migration-Posts: Cash↔AR-Buchungen, die durch
  // migrateLegacyAgentSettlements entstanden sind, deren zugehöriger
  // AGENT_TRANSFER_SOLD aber nachträglich reversed wurde (Convert/Returned).
  // Erkennung: AR-Bein (CREDIT) eines AGENT_SETTLEMENT, das selbst nicht
  // reversed ist und dessen Transfer (aus metadata.transferId) keinen aktiven
  // Sold-Post mehr hat.
  const phantomCandidates = query(
    `SELECT le.id, le.transaction_id, le.source_id, le.metadata_json
     FROM ledger_entries le
     WHERE le.source_module = 'AGENT_SETTLEMENT'
       AND le.account = 'ACCOUNTS_RECEIVABLE'
       AND le.direction = 'CREDIT'
       AND le.branch_id = ?
       AND le.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM ledger_entries x WHERE x.reverses_entry_id = le.id)`,
    [branchId]
  );

  for (const r of phantomCandidates) {
    const txId = r.transaction_id as string;
    const meta = (r.metadata_json as string) || '';
    let transferId: string | null = null;
    try {
      const m = JSON.parse(meta);
      if (m && typeof m.transferId === 'string') transferId = m.transferId;
    } catch { /* ignore */ }
    if (!transferId) { res.skipped++; continue; }

    // Aktiven Sold-Post suchen (nicht reversed AND nicht zurück-reversed)
    const activeSold = query(
      `SELECT 1 FROM ledger_entries le
       WHERE le.source_module = 'AGENT_TRANSFER_SOLD'
         AND le.source_id = ?
         AND le.direction = 'DEBIT'
         AND le.account = 'ACCOUNTS_RECEIVABLE'
         AND le.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM ledger_entries x WHERE x.reverses_entry_id = le.id)
       LIMIT 1`,
      [transferId]
    );
    if (activeSold.length > 0) { res.skipped++; continue; } // Sold ist aktiv → Settle ist legitim

    res.total++;
    safeStep(res, `phantom-settle-tx ${txId.slice(0, 8)}`, () => {
      reverseTransaction(txId, new Date().toISOString());
    });
  }

  return res;
}

// ── Cleanup: Verwaiste Consignment-Post-Sale-Return Credit Notes ─────────────
//
// Bug-Repair 2026-05: Vor dem Fix in markReturnedAfterSale wurde bei einem
// Post-Sale-Return einer unbezahlten Consignment-Invoice eine CN mit
// hardcoded `cash_refund_amount = totalAmount` gepostet. Wenn die Invoice
// danach gecancelt wurde (cancelSale), wurde NUR die Invoice-Buchung reverst —
// die CN-Buchung blieb aktiv und erzeugt phantom CASH-/REVENUE-Bewegungen.
// Erkennung: CN mit `Consignment post-sale return`-Reason, deren Invoice CANCELLED ist.
// Fix: CN-Ledger reversen, dann CN- + Sales-Return-Records loeschen.

export function cleanupOrphanedConsignmentReturnCN(branchId: string): BackfillResult {
  const res = emptyResult('consignment_return_cn_cleanup');

  const orphanCns = query(
    `SELECT cn.id, cn.sales_return_id
     FROM credit_notes cn
     JOIN invoices i ON i.id = cn.invoice_id
     WHERE cn.branch_id = ?
       AND cn.reason LIKE 'Consignment post-sale return%'
       AND i.status = 'CANCELLED'`,
    [branchId]
  );

  res.total = orphanCns.length;

  for (const r of orphanCns) {
    const cnId = r.id as string;
    const srId = r.sales_return_id as string | undefined;
    safeStep(res, `orphan-cn ${cnId.slice(0, 8)}`, () => {
      if (hasLedgerEntries('CREDIT_NOTE', cnId) && !hasReversalFor('CREDIT_NOTE', cnId)) {
        reverseSource('CREDIT_NOTE', cnId, new Date().toISOString());
      }
      const db = getDatabase();
      if (srId) {
        db.run(`DELETE FROM sales_return_lines WHERE return_id = ?`, [srId]);
        db.run(`DELETE FROM sales_returns WHERE id = ?`, [srId]);
      }
      db.run(`DELETE FROM credit_notes WHERE id = ?`, [cnId]);
      saveDatabase();
    });
  }

  return res;
}

// ── Migration: Legacy AGENT_SETTLEMENT (Cash↔Revenue) → neu (Cash↔AR) ───────
//
// Vor der Sold→AR-Umstellung postete postAgentSettlementPayment direkt
// `DEBIT CASH/BANK ↔ CREDIT REVENUE` (kein AR-Cycle). Mit dem neuen Flow
// (AGENT_TRANSFER_SOLD → AR↔REVENUE) erzeugen alte Settlements jetzt
// Doppel-Revenue + nicht-reduziertes AR. Diese Migration:
//   1. Findet alle AGENT_SETTLEMENT-Buchungen mit altem REVENUE-Bein
//      (= Cash↔Revenue-Logik), die noch keine Reversal haben.
//   2. Reverst die alte Buchung.
//   3. Postet sie neu mit der Cash↔AR-Logik (counterparty CUSTOMER).
// Idempotent: bereits migrierte Payments werden geskippt.

export function migrateLegacyAgentSettlements(branchId: string): BackfillResult {
  const res = emptyResult('agent_settle_legacy_migrate');
  const rows = query(
    `SELECT asp.id as payment_id, asp.transfer_id, asp.amount, asp.method, asp.paid_at,
            ag.customer_id
     FROM agent_settlement_payments asp
     JOIN agent_transfers at ON at.id = asp.transfer_id
     JOIN agents ag ON ag.id = at.agent_id
     WHERE at.branch_id = ?`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.payment_id as string;
    const customerId = (r.customer_id as string) || '';
    if (!customerId) { res.skipped++; continue; }

    // Alt-Logik erkennen: Original-Buchung enthält REVENUE-Bein.
    const hasRevenueLeg = query(
      `SELECT 1 FROM ledger_entries
       WHERE source_module = 'AGENT_SETTLEMENT' AND source_id = ?
         AND account = 'REVENUE' AND reverses_entry_id IS NULL
       LIMIT 1`,
      [id]
    ).length > 0;
    if (!hasRevenueLeg) { res.skipped++; continue; }

    // Schon reverst → entweder schon migriert (alte Reversal + neue Post mit
    // gleichem sourceId koexistieren) oder anderweitig storniert. Skip.
    if (hasReversalFor('AGENT_SETTLEMENT', id)) { res.skipped++; continue; }

    // Schutz: wenn der zugehörige AGENT_TRANSFER_SOLD-Post bereits reversed
    // wurde (Convert-to-Invoice oder markTransferReturned), dürfen wir die
    // Settle nicht als Cash↔AR neu posten — sonst entsteht ein dauerhaft
    // negativer AR-Saldo für diesen Customer ohne passenden Sold-Debit.
    // Bug-Repro: Sara Al-Dosari, 2026-05-08 — 2 converted Transfers, deren
    // Settles via Migration phantom-AR-Credits erzeugten, die das Open
    // Receivable verfälschten.
    const transferIdRaw = r.transfer_id as string;
    const soldHasReversal = hasReversalFor('AGENT_TRANSFER_SOLD', transferIdRaw);
    const soldHasOriginal = hasLedgerEntries('AGENT_TRANSFER_SOLD', transferIdRaw);
    if (soldHasReversal || !soldHasOriginal) { res.skipped++; continue; }

    const method = (r.method as 'cash' | 'bank') || 'cash';
    const amount = Number(r.amount || 0);
    const paidAt = r.paid_at as string;

    safeStep(res, `agent-settle-migrate ${id.slice(0, 8)}`, () => {
      // 1. Alte Cash↔Revenue-Buchung reversen.
      postAgentSettlementPaymentReversed(id);
      // 2. Neu posten mit Cash↔AR-Logik. Wichtig: der hasLedgerEntries-Check
      //    in der normalen Settle-Funktion würde hier skippen (Original-Entries
      //    existieren noch). Wir rufen postAgentSettlementPayment direkt — das
      //    ergibt ein zweites Original-Set, das die saubere Logik trägt.
      postAgentSettlementPayment(
        { id, transferId: r.transfer_id as string, amount, method, paidAt },
        customerId
      );
    });
  }
  return res;
}

// ── Agent Transfer Sold ───────────────────────────────────────
//
// Für jeden sold/settled Transfer ohne invoiceId: AGENT_TRANSFER_SOLD posten
// (DEBIT AR ↔ CREDIT REVENUE, counterparty = CUSTOMER). Damit erscheinen
// historische Forderungen aus Approval-Verkäufen im Customer-Ledger.
// Convert-to-Invoice-Transfers werden ausgenommen, da deren Forderung über
// die Invoice läuft.

export function backfillAgentTransferSold(branchId: string): BackfillResult {
  const res = emptyResult('agent_transfers_sold');
  const rows = query(
    `SELECT at.id, at.settlement_amount, at.actual_sale_price, at.agent_price, at.sold_at, ag.customer_id
     FROM agent_transfers at
     JOIN agents ag ON ag.id = at.agent_id
     WHERE at.branch_id = ?
       AND at.invoice_id IS NULL
       AND at.status IN ('sold','settled')`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const id = r.id as string;
    if (hasLedgerEntries('AGENT_TRANSFER_SOLD', id)) { res.skipped++; continue; }
    const customerId = (r.customer_id as string) || '';
    if (!customerId) { res.skipped++; continue; }
    const amount = Number(r.settlement_amount ?? r.actual_sale_price ?? r.agent_price ?? 0);
    if (amount <= 0) { res.skipped++; continue; }
    const soldAt = (r.sold_at as string) || new Date().toISOString();
    safeStep(res, `agent-sold ${id.slice(0, 8)}`, () => {
      postAgentTransferSold({ transferId: id, amount, soldAt }, customerId);
    });
  }
  return res;
}

// ── Consignment Payouts ───────────────────────────────────────
//
// Es gibt KEINE separate consignment_payouts-Tabelle — payout_paid_amount ist
// kumulativ auf consignments. Daher ein synthetischer source_id pro Consignment,
// damit Idempotenz funktioniert (re-running überschreibt nicht).
// Format: "consignment-payout-${consignmentId}".

export function backfillConsignmentPayouts(branchId: string): BackfillResult {
  const res = emptyResult('consignment_payouts');
  const rows = query(
    `SELECT id, consignor_id, payout_paid_amount, payout_amount, payout_method, payout_date
     FROM consignments
     WHERE branch_id = ? AND COALESCE(payout_paid_amount, 0) > 0`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const consignmentId = r.id as string;
    const synthId = `cp-${consignmentId}`;
    if (hasLedgerEntries('CONSIGNMENT_PAYOUT', synthId)) { res.skipped++; continue; }
    const amount = Number(r.payout_paid_amount || 0);
    if (amount <= 0) { res.skipped++; continue; }
    const method = String(r.payout_method || 'bank').toLowerCase() === 'cash' ? 'cash' : 'bank';
    const paidAt = (r.payout_date as string) || new Date().toISOString().split('T')[0];
    safeStep(res, `cons-payout ${consignmentId.slice(0, 8)}`, () => {
      postConsignmentPayout({
        id: synthId, consignmentId,
        consignorId: (r.consignor_id as string) || undefined,
        amount, method: method as 'cash' | 'bank', paidAt,
      });
    });
  }
  return res;
}

// ── Top-Level Orchestrator ────────────────────────────────────

// ── M-12 Phase 1 — Opening-Balances (settings → Ledger) ──────
// Idempotentes Seed-Posting des Geschaeftsstart-Bestands. postOpeningBalances
// ist selbst guarded (hasLedgerEntries) → posted/skipped spiegelt das wider.
export function backfillOpeningBalances(branchId: string): BackfillResult {
  const res = emptyResult('opening_balances');
  res.total = 1;
  try {
    const posted = postOpeningBalances(branchId);
    if (posted) res.posted++; else res.skipped++;
  } catch (err) {
    res.failed++;
    res.errors.push(`opening: ${(err as Error).message}`);
  }
  return res;
}

// ── Customer-Credit-Modell — Alt-Credits ledgerisieren ───────
// customer_credits-Rows aus der Zeit VOR den Slices 4a/4b (order_cancel /
// gold_conversion) haben Domain-Guthaben ohne CR CUSTOMER_CREDIT im Ledger —
// Einloesung (applyCreditToInvoice: DR CUSTOMER_CREDIT) zoege das Konto negativ.
// Backfill spiegelt exakt die Live-Postings:
//   order_cancel:    DR CUSTOMER_DEPOSITS / CR CUSTOMER_CREDIT (= Slice 4a;
//                    raeumt zugleich die beim Alt-Cancel stehengebliebene Anzahlung)
//   gold_conversion: DR GOLD_CREDIT_CLEARING / CR CUSTOMER_CREDIT (= Slice 4b)
// sales_return-Credits existieren erst SEIT dem Modell (Slice 2 legt Row+Ledger
// zusammen an) — kein Alt-Bestand moeglich, daher hier nicht behandelt.
// Voller Original-amount, NICHT amount−used_amount: eventuelle Einloesungs-DRs
// stehen schon im Ledger (CR amount − DR used == Domain amount − used_amount).
export function backfillCustomerCredits(branchId: string): BackfillResult {
  const res = emptyResult('customer_credits');
  const rows = query(
    `SELECT id, customer_id, amount, source_type, source_id, created_at
     FROM customer_credits
     WHERE branch_id = ? AND source_type IN ('order_cancel', 'gold_conversion')`,
    [branchId]
  );
  res.total = rows.length;
  for (const r of rows) {
    const creditId = r.id as string;
    const customerId = r.customer_id as string;
    const amount = Number(r.amount || 0);
    const createdAt = (r.created_at as string) || new Date().toISOString();
    if (amount <= 0) { res.skipped++; continue; }
    if (r.source_type === 'gold_conversion') {
      // Live-Posting (goldStore) keyt auf die customer_credits-Row-id.
      if (hasLedgerEntries('GOLD_CONVERSION', creditId)) { res.skipped++; continue; }
      safeStep(res, `gold-credit ${creditId.slice(0, 8)}`, () => {
        postGoldConversionCredit(creditId, customerId, amount, createdAt);
      });
    } else {
      // order_cancel: source_id = orderId; Live-Posting keyt auf `credit:<orderId>`.
      const orderId = r.source_id as string;
      if (hasLedgerEntries('ORDER_CANCEL', `credit:${orderId}`)) { res.skipped++; continue; }
      safeStep(res, `order-credit ${creditId.slice(0, 8)}`, () => {
        postOrderCancellationChoice({
          orderId, customerId, totalPaid: amount, choice: 'credit', occurredAt: createdAt,
        });
      });
    }
  }
  return res;
}

export function backfillAll(branchId: string): BackfillResult[] {
  return [
    backfillOpeningBalances(branchId),
    backfillInvoices(branchId),
    backfillInvoiceCogs(branchId),
    backfillInvoicePayments(branchId),
    backfillCreditNotes(branchId),
    backfillPurchases(branchId),
    backfillPurchasePayments(branchId),
    backfillExpenses(branchId),
    backfillExpensePayments(branchId),
    backfillBankTransfers(branchId),
    backfillOrderPayments(branchId),
    // NACH Order-Payments: DR CUSTOMER_DEPOSITS braucht die Deposit-CRs zuerst.
    backfillCustomerCredits(branchId),
    backfillDebts(branchId),
    backfillDebtPayments(branchId),
    backfillPartnerTransactions(branchId),
    backfillTaxPayments(branchId),
    backfillMetalPayments(branchId),
    // Reihenfolge wichtig:
    //   0. Verwaiste Ledger-Posts gelöschter Transfers reversen (AR aufräumen).
    //   1. Sold-Forderung posten (AR aufbauen).
    //   2. Alte Cash↔Revenue-Settles auf neue Cash↔AR umbauen (reduzieren AR).
    //   3. Fehlende Settles ohne Ledger-Eintrag nachposten (Cash↔AR).
    cleanupOrphanedAgentTransferLedger(branchId),
    backfillAgentTransferSold(branchId),
    migrateLegacyAgentSettlements(branchId),
    backfillAgentSettlementPayments(branchId),
    backfillConsignmentPayouts(branchId),
    cleanupOrphanedConsignmentReturnCN(branchId),
  ];
}

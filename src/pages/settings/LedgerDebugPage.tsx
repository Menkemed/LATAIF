// Plan §3a — Ledger Debug Page (test-drive vor Wire-Up)
// /ledger-debug → Live-Test des Posting-Service ohne produktive Stores zu berühren.

import { useState, useCallback } from 'react';
import { v4 as uuid } from 'uuid';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { query, currentBranchId } from '@/core/db/helpers';
import {
  postInvoiceIssued,
  postInvoicePayment,
  postCreditNote,
  postInvoiceCancelled,
  postPurchaseReceived,
  postPurchasePayment,
  postPurchaseCancelled,
  postExpense,
  postExpensePayment,
  postExpenseCancelled,
  postBankTransfer,
  postBankTransferReversed,
  postOrderPayment,
  postOrderPaymentReversed,
  postLoanCreated,
  postLoanPayment,
  postLoanCancelled,
  postTaxPayment,
  postTaxPaymentReversed,
  postPartnerTransaction,
  postPartnerTransactionReversed,
  postRepairPayment,
  postRepairPaymentReversed,
  postMetalPayment,
  postMetalPaymentReversed,
  postAgentSettlementPayment,
  postAgentSettlementPaymentReversed,
  postConsignmentPayout,
  postConsignmentPayoutReversed,
  type LedgerAccount,
} from '@/core/ledger/posting';
import {
  balanceOf,
  cashflow,
  revenueSnapshot,
  ledgerImbalance,
  findImbalancedTransactions,
} from '@/core/ledger/queries';
import type { Invoice, Payment, CreditNote, PaymentMethod, Purchase, PurchasePayment, Expense, ExpensePayment, BankTransfer, Debt, DebtPayment } from '@/core/models/types';

const ALL_ACCOUNTS: LedgerAccount[] = [
  'CASH', 'BANK', 'CARD_CLEARING', 'BENEFIT',
  'ACCOUNTS_RECEIVABLE', 'ACCOUNTS_PAYABLE',
  'REVENUE', 'COGS', 'INVENTORY',
  'VAT_OUTPUT', 'VAT_INPUT', 'MARGIN_VAT',
  'REFUNDS', 'CARD_FEES',
  'SUPPLIER_CREDIT', 'CUSTOMER_CREDIT', 'CUSTOMER_DEPOSITS',
  'LOAN_RECEIVABLE', 'LOAN_PAYABLE',
  'COMMISSION_PAYABLE_AGENT', 'COMMISSION_PAYABLE_CONSIGNOR',
  'PARTNER_EQUITY', 'EXPENSES_OPERATING',
  'TAX_PAID', 'INTERNAL_TRANSFER',
  'CANCELLATION_FEE_INCOME',
];

const fmt = (n: number) => n.toFixed(3);

interface RecentEntry {
  entry_no: number;
  occurred_at: string;
  account: string;
  direction: string;
  amount: number;
  source_module: string;
  source_id: string;
  counterparty_id: string | null;
  reverses_entry_id: string | null;
}

export function LedgerDebugPage() {
  const [log, setLog] = useState<string[]>([]);
  const [balances, setBalances] = useState<Array<[LedgerAccount, number]>>([]);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [imbalanceInfo, setImbalanceInfo] = useState<string>('—');
  const [lastInvoiceId, setLastInvoiceId] = useState<string | null>(null);
  const [lastPurchaseId, setLastPurchaseId] = useState<string | null>(null);
  const [lastExpenseId, setLastExpenseId] = useState<string | null>(null);
  const [lastTransferId, setLastTransferId] = useState<string | null>(null);
  const [lastTransferRecord, setLastTransferRecord] = useState<BankTransfer | null>(null);
  const [lastOrderPaymentId, setLastOrderPaymentId] = useState<string | null>(null);
  const [lastLoanRecord, setLastLoanRecord] = useState<Debt | null>(null);
  const [lastTaxId, setLastTaxId] = useState<string | null>(null);
  const [lastPartnerTxId, setLastPartnerTxId] = useState<string | null>(null);
  const [lastRepairPayId, setLastRepairPayId] = useState<string | null>(null);
  const [lastMetalPayId, setLastMetalPayId] = useState<string | null>(null);
  const [lastAgentSettleId, setLastAgentSettleId] = useState<string | null>(null);
  const [lastConsignmentPayoutId, setLastConsignmentPayoutId] = useState<string | null>(null);

  const append = (line: string) => setLog(l => [`[${new Date().toLocaleTimeString()}] ${line}`, ...l].slice(0, 50));

  // ── Test-Invoice (margin scheme, 2 lines) ─────────────────
  const handlePostTestInvoice = useCallback(() => {
    try {
      const branchId = currentBranchId();
      const customerId = 'test-customer-' + uuid().slice(0, 8);
      const invoice: Invoice = {
        id: uuid(),
        invoiceNumber: 'INV-TEST-' + Date.now(),
        customerId,
        status: 'FINAL',
        currency: 'BHD',
        netAmount: 4545.455,
        vatRateSnapshot: 10,
        vatAmount: 454.545,
        grossAmount: 5000,
        taxSchemeSnapshot: 'MARGIN',
        paidAmount: 0,
        issuedAt: new Date().toISOString(),
        lines: [
          {
            id: uuid(),
            invoiceId: '',
            productId: 'p-test-1',
            quantity: 1,
            unitPrice: 3500,
            purchasePriceSnapshot: 3000,
            vatRate: 10,
            taxScheme: 'MARGIN',
            vatAmount: 45.455,
            lineTotal: 3500,
            position: 0,
          },
          {
            id: uuid(),
            invoiceId: '',
            productId: 'p-test-2',
            quantity: 1,
            unitPrice: 1500,
            purchasePriceSnapshot: 1200,
            vatRate: 10,
            taxScheme: 'MARGIN',
            vatAmount: 27.273,
            lineTotal: 1500,
            position: 1,
          },
        ],
        createdAt: new Date().toISOString(),
      };
      const result = postInvoiceIssued(invoice);
      setLastInvoiceId(invoice.id);
      append(`✓ Invoice posted — txn=${result.transactionId.slice(0, 8)}, ${result.entryIds.length} entries, branch=${branchId}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handlePostTestPayment = useCallback((method: PaymentMethod) => {
    try {
      const customerId = 'test-customer-shared';
      const payment: Payment = {
        id: uuid(),
        invoiceId: lastInvoiceId ?? 'no-invoice',
        amount: 1000,
        method,
        receivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
      const result = postInvoicePayment(payment, customerId);
      append(`✓ Payment ${method} 1000 — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastInvoiceId]);

  const handlePostTestCreditNote = useCallback(() => {
    try {
      const customerId = 'test-customer-shared';
      const cn: CreditNote = {
        id: uuid(),
        creditNoteNumber: 'CN-TEST-' + Date.now(),
        branchId: currentBranchId(),
        invoiceId: lastInvoiceId ?? 'no-invoice',
        customerId,
        issuedAt: new Date().toISOString(),
        totalAmount: 500,
        vatAmount: 45.455,
        cashRefundAmount: 200,
        receivableCancelAmount: 300,
        refundMethod: 'bank',
        createdAt: new Date().toISOString(),
      };
      const result = postCreditNote(cn);
      append(`✓ CreditNote 500 (200 refund + 300 cancel) — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastInvoiceId]);

  // ── Test-Purchase (1 line, VAT_10, 1100 BHD gross = 1000 net + 100 VAT) ──
  const handlePostTestPurchase = useCallback(() => {
    try {
      const supplierId = 'test-supplier-' + uuid().slice(0, 8);
      const purchase: Purchase = {
        id: uuid(),
        purchaseNumber: 'PUR-TEST-' + Date.now(),
        branchId: currentBranchId(),
        supplierId,
        status: 'UNPAID',
        totalAmount: 1100,
        paidAmount: 0,
        remainingAmount: 1100,
        purchaseDate: new Date().toISOString().split('T')[0],
        lines: [
          {
            id: uuid(),
            purchaseId: '',
            productId: 'p-purchase-test',
            quantity: 1,
            unitPrice: 1100,
            lineTotal: 1100,
            position: 1,
            taxScheme: 'VAT_10',
            vatRate: 10,
            vatAmount: 100,
          },
        ],
        payments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const result = postPurchaseReceived(purchase);
      setLastPurchaseId(purchase.id);
      append(`✓ Purchase posted — txn=${result.transactionId.slice(0, 8)}, ${result.entryIds.length} entries (INV/VAT_IN/AP)`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handlePostTestPurchasePayment = useCallback((method: PurchasePayment['method']) => {
    if (!lastPurchaseId) {
      append('✗ no purchase to pay — post a test purchase first');
      return;
    }
    try {
      const supplierId = 'test-supplier-shared';
      const payment: PurchasePayment = {
        id: uuid(),
        purchaseId: lastPurchaseId,
        amount: 500,
        method,
        paidAt: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
      };
      const result = postPurchasePayment(payment, supplierId);
      append(`✓ Supplier-pay ${method} 500 — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastPurchaseId]);

  const handleReverseLastPurchase = useCallback(() => {
    if (!lastPurchaseId) {
      append('✗ no purchase to reverse — post a test purchase first');
      return;
    }
    try {
      const fakePurchase = { id: lastPurchaseId } as Purchase;
      const result = postPurchaseCancelled(fakePurchase);
      append(`✓ Purchase ${lastPurchaseId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastPurchaseId]);

  // ── Test-Expense (250 BHD operating expense) ──────────────
  const handlePostTestExpense = useCallback(() => {
    try {
      const expense: Expense = {
        id: uuid(),
        expenseNumber: 'EXP-TEST-' + Date.now(),
        branchId: currentBranchId(),
        category: 'Miscellaneous',
        amount: 250,
        paidAmount: 0,
        paymentMethod: 'cash',
        expenseDate: new Date().toISOString().split('T')[0],
        description: 'Ledger debug test expense',
        status: 'PENDING',
        createdAt: new Date().toISOString(),
      };
      const result = postExpense(expense);
      setLastExpenseId(expense.id);
      append(`✓ Expense posted — txn=${result.transactionId.slice(0, 8)}, ${result.entryIds.length} entries (EXPENSES_OPERATING/AP)`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handlePostTestExpensePayment = useCallback((method: ExpensePayment['method']) => {
    if (!lastExpenseId) {
      append('✗ no expense to pay — post a test expense first');
      return;
    }
    try {
      const payment: ExpensePayment = {
        id: uuid(),
        expenseId: lastExpenseId,
        amount: 100,
        method,
        paidAt: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
      };
      const result = postExpensePayment(payment);
      append(`✓ Expense-pay ${method} 100 — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastExpenseId]);

  const handleReverseLastExpense = useCallback(() => {
    if (!lastExpenseId) {
      append('✗ no expense to reverse — post a test expense first');
      return;
    }
    try {
      const fakeExpense = { id: lastExpenseId } as Expense;
      const result = postExpenseCancelled(fakeExpense);
      append(`✓ Expense ${lastExpenseId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastExpenseId]);

  // ── Bank Transfer (cash ↔ bank) ──────────────────────────
  const handlePostTestTransfer = useCallback((direction: BankTransfer['direction']) => {
    try {
      const transfer: BankTransfer = {
        id: uuid(),
        branchId: currentBranchId(),
        amount: 500,
        direction,
        transferDate: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
      };
      const result = postBankTransfer(transfer);
      setLastTransferId(transfer.id);
      setLastTransferRecord(transfer);
      append(`✓ Transfer ${direction} 500 — txn=${result.transactionId.slice(0, 8)}, ${result.entryIds.length} entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastTransfer = useCallback(() => {
    if (!lastTransferRecord) {
      append('✗ no transfer to reverse — post one first');
      return;
    }
    try {
      const result = postBankTransferReversed(lastTransferRecord);
      append(`✓ Transfer ${lastTransferId!.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastTransferId, lastTransferRecord]);

  // ── Order Payment (Anzahlung vor Invoice) ─────────────────
  const handlePostTestOrderPayment = useCallback((method: 'cash' | 'bank' | 'card') => {
    try {
      const customerId = 'test-order-customer';
      const orderId = 'test-order-' + uuid().slice(0, 8);
      const id = uuid();
      const result = postOrderPayment(
        { id, orderId, amount: 500, method, paidAt: new Date().toISOString() },
        customerId
      );
      setLastOrderPaymentId(id);
      append(`✓ Order-Payment ${method} 500 → CUSTOMER_DEPOSITS — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastOrderPayment = useCallback(() => {
    if (!lastOrderPaymentId) {
      append('✗ no order-payment to reverse');
      return;
    }
    try {
      const result = postOrderPaymentReversed(lastOrderPaymentId);
      append(`✓ Order-Payment ${lastOrderPaymentId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastOrderPaymentId]);

  // ── Loan / Debt ───────────────────────────────────────────
  const handlePostTestLoan = useCallback((kind: 'lend' | 'borrow') => {
    try {
      const dir = kind === 'lend' ? 'we_lend' : 'we_borrow';
      const debt: Debt = {
        id: uuid(),
        loanNumber: 'LOA-TEST-' + Date.now(),
        direction: dir,
        counterparty: kind === 'lend' ? 'Test-Borrower' : 'Test-Lender',
        amount: 2000,
        source: 'bank',
        status: 'OPEN',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        paidAmount: 0,
      };
      const result = postLoanCreated(debt);
      setLastLoanRecord(debt);
      append(`✓ Loan ${kind} 2000 BHD — txn=${result.transactionId.slice(0, 8)}, ${result.entryIds.length} entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handlePostTestLoanRepayment = useCallback(() => {
    if (!lastLoanRecord) {
      append('✗ no loan to repay');
      return;
    }
    try {
      const payment: DebtPayment = {
        id: uuid(),
        debtId: lastLoanRecord.id,
        amount: 500,
        source: 'bank',
        paidAt: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
      };
      const dir = lastLoanRecord.direction === 'we_lend' || lastLoanRecord.direction === 'MONEY_GIVEN'
        ? 'MONEY_GIVEN' : 'MONEY_RECEIVED';
      const result = postLoanPayment(payment, dir as any);
      append(`✓ Loan repayment 500 (${dir}) — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastLoanRecord]);

  const handleReverseLastLoan = useCallback(() => {
    if (!lastLoanRecord) {
      append('✗ no loan to cancel');
      return;
    }
    try {
      const result = postLoanCancelled(lastLoanRecord);
      append(`✓ Loan ${lastLoanRecord.id.slice(0, 8)} cancelled — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastLoanRecord]);

  // ── Tax Payment (Quartals-VAT) ─────────────────────────────
  const handlePostTestTaxPayment = useCallback((source: 'cash' | 'bank') => {
    try {
      const id = uuid();
      const now = new Date();
      const result = postTaxPayment({
        id, amount: 750, source,
        paidAt: now.toISOString(),
        year: now.getFullYear(),
        quarter: Math.floor(now.getMonth() / 3) + 1,
        note: 'Debug test',
      });
      setLastTaxId(id);
      append(`✓ Tax-Payment ${source} 750 → TAX_PAID — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastTaxPayment = useCallback(() => {
    if (!lastTaxId) {
      append('✗ no tax-payment to reverse');
      return;
    }
    try {
      const result = postTaxPaymentReversed(lastTaxId);
      append(`✓ Tax-Payment ${lastTaxId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastTaxId]);

  // ── Partner Transaction (Equity) ─────────────────────────
  const handlePostTestPartnerTx = useCallback((kind: 'INVESTMENT' | 'WITHDRAWAL' | 'PROFIT_DISTRIBUTION') => {
    try {
      const id = uuid();
      const partnerId = 'test-partner-' + uuid().slice(0, 8);
      const result = postPartnerTransaction({
        id, partnerId, type: kind,
        amount: 5000, method: 'bank',
        transactionDate: new Date().toISOString().split('T')[0],
        transactionNumber: 'PARTNER-TEST-' + Date.now(),
      });
      setLastPartnerTxId(id);
      append(`✓ Partner ${kind} 5000 — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastPartnerTx = useCallback(() => {
    if (!lastPartnerTxId) {
      append('✗ no partner-tx to reverse');
      return;
    }
    try {
      const result = postPartnerTransactionReversed(lastPartnerTxId);
      append(`✓ Partner-tx ${lastPartnerTxId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastPartnerTxId]);

  // ── Repair Payment ────────────────────────────────────────
  const handlePostTestRepairPayment = useCallback((method: 'cash' | 'bank' | 'card') => {
    try {
      const id = uuid();
      const result = postRepairPayment({
        id,
        repairId: 'test-repair-' + uuid().slice(0, 8),
        amount: 80, method,
        paidAt: new Date().toISOString(),
      });
      setLastRepairPayId(id);
      append(`✓ Repair-Payment ${method} 80 → REVENUE — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastRepairPayment = useCallback(() => {
    if (!lastRepairPayId) {
      append('✗ no repair-payment to reverse');
      return;
    }
    try {
      const result = postRepairPaymentReversed(lastRepairPayId);
      append(`✓ Repair-Payment ${lastRepairPayId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastRepairPayId]);

  // ── Metal Payment ─────────────────────────────────────────
  const handlePostTestMetalPayment = useCallback((method: 'cash' | 'bank' | 'card') => {
    try {
      const id = uuid();
      const result = postMetalPayment({
        id,
        metalId: 'test-metal-' + uuid().slice(0, 8),
        amount: 1500, method,
        paidAt: new Date().toISOString(),
      });
      setLastMetalPayId(id);
      append(`✓ Metal-Payment ${method} 1500 → REVENUE — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastMetalPayment = useCallback(() => {
    if (!lastMetalPayId) {
      append('✗ no metal-payment to reverse');
      return;
    }
    try {
      const result = postMetalPaymentReversed(lastMetalPayId);
      append(`✓ Metal-Payment ${lastMetalPayId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastMetalPayId]);

  // ── Agent Settlement Payment ──────────────────────────────
  const handlePostTestAgentSettle = useCallback((method: 'cash' | 'bank') => {
    try {
      const id = uuid();
      const result = postAgentSettlementPayment(
        { id, transferId: 'test-transfer-' + uuid().slice(0, 8), amount: 800, method, paidAt: new Date().toISOString() },
        'test-agent-' + uuid().slice(0, 8)
      );
      setLastAgentSettleId(id);
      append(`✓ Agent-Settle ${method} 800 → REVENUE — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastAgentSettle = useCallback(() => {
    if (!lastAgentSettleId) {
      append('✗ no agent-settle to reverse');
      return;
    }
    try {
      const result = postAgentSettlementPaymentReversed(lastAgentSettleId);
      append(`✓ Agent-Settle ${lastAgentSettleId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastAgentSettleId]);

  // ── Consignment Payout ────────────────────────────────────
  const handlePostTestConsignmentPayout = useCallback((method: 'cash' | 'bank') => {
    try {
      const id = uuid();
      const result = postConsignmentPayout({
        id, consignmentId: 'test-cons-' + uuid().slice(0, 8),
        amount: 600, method, paidAt: new Date().toISOString(),
      });
      setLastConsignmentPayoutId(id);
      append(`✓ Consignor-Payout ${method} 600 → EXPENSES_OPERATING — txn=${result.transactionId.slice(0, 8)}`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReverseLastConsignmentPayout = useCallback(() => {
    if (!lastConsignmentPayoutId) {
      append('✗ no consignment-payout to reverse');
      return;
    }
    try {
      const result = postConsignmentPayoutReversed(lastConsignmentPayoutId);
      append(`✓ Consignment-Payout ${lastConsignmentPayoutId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastConsignmentPayoutId]);

  const handleReverseLastInvoice = useCallback(() => {
    if (!lastInvoiceId) {
      append('✗ no invoice to reverse — post a test invoice first');
      return;
    }
    try {
      const fakeInvoice = { id: lastInvoiceId } as Invoice;
      const result = postInvoiceCancelled(fakeInvoice);
      append(`✓ Invoice ${lastInvoiceId.slice(0, 8)} reversed — ${result.entryIds.length} mirror entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, [lastInvoiceId]);

  // ── Read-Side ─────────────────────────────────────────────
  const handleShowBalances = useCallback(() => {
    try {
      const out: Array<[LedgerAccount, number]> = [];
      for (const acc of ALL_ACCOUNTS) {
        const bal = balanceOf(acc);
        if (Math.abs(bal) > 0.0001) out.push([acc, bal]);
      }
      setBalances(out);
      append(`✓ Balances refreshed — ${out.length} non-zero accounts`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleShowRecent = useCallback(() => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT entry_no, occurred_at, account, direction, amount,
                source_module, source_id, counterparty_id, reverses_entry_id
         FROM ledger_entries
         WHERE branch_id = ?
         ORDER BY entry_no DESC
         LIMIT 30`,
        [branchId]
      );
      setRecent(rows.map(r => ({
        entry_no: r.entry_no as number,
        occurred_at: r.occurred_at as string,
        account: r.account as string,
        direction: r.direction as string,
        amount: r.amount as number,
        source_module: r.source_module as string,
        source_id: r.source_id as string,
        counterparty_id: r.counterparty_id as string | null,
        reverses_entry_id: r.reverses_entry_id as string | null,
      })));
      append(`✓ Loaded ${rows.length} recent entries`);
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleReconcile = useCallback(() => {
    try {
      const branchTotal = ledgerImbalance();
      const broken = findImbalancedTransactions();
      const totalOk = Math.abs(branchTotal) < 0.001;
      if (totalOk && broken.length === 0) {
        setImbalanceInfo(`✓ OK — branch debit/credit netto 0, alle Transactions ausgeglichen`);
      } else {
        setImbalanceInfo(
          `✗ Branch-Diff: ${fmt(branchTotal)} BHD · ${broken.length} unbalancierte Transaktionen` +
          (broken.length > 0 ? '\n' + broken.slice(0, 5).map(b =>
            `  • ${b.sourceModule}/${b.sourceId.slice(0,8)} diff=${fmt(b.diff)}`
          ).join('\n') : '')
        );
      }
      append(`✓ Reconciliation: branch=${fmt(branchTotal)} broken=${broken.length}`);
    } catch (e) {
      setImbalanceInfo(`✗ ${(e as Error).message}`);
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  const handleShowCashflow = useCallback(() => {
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
      const cf = cashflow(start, end);
      const rev = revenueSnapshot(start, end);
      append(
        `✓ Month: cash=${fmt(cf.cash)} bank=${fmt(cf.bank)} card=${fmt(cf.card)} | ` +
        `rev=${fmt(rev.netRevenue)} vat=${fmt(rev.vatOutput + rev.marginVat)} refund=${fmt(rev.refunds)}`
      );
    } catch (e) {
      append(`✗ ${(e as Error).message}`);
    }
  }, []);

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <h1 style={{ fontSize: 28, fontWeight: 600, marginBottom: 8 }}>Ledger Debug</h1>
      <p style={{ color: '#6B7280', fontSize: 13, marginBottom: 24 }}>
        Test-Drive für den zentralen Posting-Service. ZIEL.md §3a. Buchungen landen in <code>ledger_entries</code> ohne produktive Tabellen zu berühren.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16, marginBottom: 16 }}>
        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Sales-Pfad</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={handlePostTestInvoice}>Post test invoice (2 lines, MARGIN, 5000 BHD)</Button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestPayment('cash')} disabled={!lastInvoiceId}>Pay 1000 cash</Button>
              <Button onClick={() => handlePostTestPayment('bank_transfer')} disabled={!lastInvoiceId}>Pay 1000 bank</Button>
              <Button onClick={() => handlePostTestPayment('card')} disabled={!lastInvoiceId}>Pay 1000 card</Button>
            </div>
            <Button onClick={handlePostTestCreditNote} disabled={!lastInvoiceId}>Post credit note (500: 200 refund + 300 cancel)</Button>
            <Button variant="danger" onClick={handleReverseLastInvoice} disabled={!lastInvoiceId}>Reverse last invoice (storno)</Button>
          </div>
          {lastInvoiceId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last invoice: {lastInvoiceId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Purchase-Pfad</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={handlePostTestPurchase}>Post test purchase (VAT_10, 1100 BHD)</Button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestPurchasePayment('cash')} disabled={!lastPurchaseId}>Pay supplier 500 cash</Button>
              <Button onClick={() => handlePostTestPurchasePayment('bank')} disabled={!lastPurchaseId}>Pay supplier 500 bank</Button>
            </div>
            <Button onClick={() => handlePostTestPurchasePayment('credit')} disabled={!lastPurchaseId}>Pay supplier 500 via credit</Button>
            <Button variant="danger" onClick={handleReverseLastPurchase} disabled={!lastPurchaseId}>Reverse last purchase (storno)</Button>
          </div>
          {lastPurchaseId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last purchase: {lastPurchaseId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Expense-Pfad</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={handlePostTestExpense}>Post test expense (Office, 250 BHD)</Button>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestExpensePayment('cash')} disabled={!lastExpenseId}>Pay 100 cash</Button>
              <Button onClick={() => handlePostTestExpensePayment('bank')} disabled={!lastExpenseId}>Pay 100 bank</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastExpense} disabled={!lastExpenseId}>Reverse last expense (storno)</Button>
          </div>
          {lastExpenseId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last expense: {lastExpenseId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Order-Payment</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestOrderPayment('cash')}>Deposit 500 cash</Button>
              <Button onClick={() => handlePostTestOrderPayment('bank')}>Deposit 500 bank</Button>
              <Button onClick={() => handlePostTestOrderPayment('card')}>Deposit 500 card</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastOrderPayment} disabled={!lastOrderPaymentId}>Reverse last order-payment</Button>
          </div>
          {lastOrderPaymentId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last order-payment: {lastOrderPaymentId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Loan / Debt</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestLoan('lend')}>Lend 2000 (we_lend)</Button>
              <Button onClick={() => handlePostTestLoan('borrow')}>Borrow 2000 (we_borrow)</Button>
            </div>
            <Button onClick={handlePostTestLoanRepayment} disabled={!lastLoanRecord}>Repayment 500</Button>
            <Button variant="danger" onClick={handleReverseLastLoan} disabled={!lastLoanRecord}>Cancel last loan (storno)</Button>
          </div>
          {lastLoanRecord && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last loan: {lastLoanRecord.id.slice(0, 8)}… ({lastLoanRecord.direction})
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Tax-Payment</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestTaxPayment('cash')}>Pay tax 750 cash</Button>
              <Button onClick={() => handlePostTestTaxPayment('bank')}>Pay tax 750 bank</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastTaxPayment} disabled={!lastTaxId}>Reverse last tax-payment</Button>
          </div>
          {lastTaxId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last tax-payment: {lastTaxId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Partner-Transaction</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={() => handlePostTestPartnerTx('INVESTMENT')}>Investment 5000</Button>
            <Button onClick={() => handlePostTestPartnerTx('WITHDRAWAL')}>Withdrawal 5000</Button>
            <Button onClick={() => handlePostTestPartnerTx('PROFIT_DISTRIBUTION')}>Profit-Distribution 5000</Button>
            <Button variant="danger" onClick={handleReverseLastPartnerTx} disabled={!lastPartnerTxId}>Reverse last partner-tx</Button>
          </div>
          {lastPartnerTxId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last partner-tx: {lastPartnerTxId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Repair-Payment</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestRepairPayment('cash')}>Pay 80 cash</Button>
              <Button onClick={() => handlePostTestRepairPayment('bank')}>Pay 80 bank</Button>
              <Button onClick={() => handlePostTestRepairPayment('card')}>Pay 80 card</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastRepairPayment} disabled={!lastRepairPayId}>Reverse last repair-payment</Button>
          </div>
          {lastRepairPayId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last repair-payment: {lastRepairPayId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Metal-Payment</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestMetalPayment('cash')}>Sale 1500 cash</Button>
              <Button onClick={() => handlePostTestMetalPayment('bank')}>Sale 1500 bank</Button>
              <Button onClick={() => handlePostTestMetalPayment('card')}>Sale 1500 card</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastMetalPayment} disabled={!lastMetalPayId}>Reverse last metal-payment</Button>
          </div>
          {lastMetalPayId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last metal-payment: {lastMetalPayId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Agent-Settlement</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestAgentSettle('cash')}>Settle 800 cash</Button>
              <Button onClick={() => handlePostTestAgentSettle('bank')}>Settle 800 bank</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastAgentSettle} disabled={!lastAgentSettleId}>Reverse last agent-settle</Button>
          </div>
          {lastAgentSettleId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last agent-settle: {lastAgentSettleId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Consignment-Payout</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Button onClick={() => handlePostTestConsignmentPayout('cash')}>Payout 600 cash</Button>
              <Button onClick={() => handlePostTestConsignmentPayout('bank')}>Payout 600 bank</Button>
            </div>
            <Button variant="danger" onClick={handleReverseLastConsignmentPayout} disabled={!lastConsignmentPayoutId}>Reverse last consignment-payout</Button>
          </div>
          {lastConsignmentPayoutId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last consignment-payout: {lastConsignmentPayoutId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Bank-Transfer</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={() => handlePostTestTransfer('CASH_TO_BANK')}>Transfer 500 cash → bank</Button>
            <Button onClick={() => handlePostTestTransfer('BANK_TO_CASH')}>Transfer 500 bank → cash</Button>
            <Button variant="danger" onClick={handleReverseLastTransfer} disabled={!lastTransferId}>Reverse last transfer (storno)</Button>
          </div>
          {lastTransferId && (
            <div style={{ marginTop: 12, fontSize: 11, color: '#6B7280', fontFamily: 'monospace' }}>
              last transfer: {lastTransferId.slice(0, 8)}…
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Lesepfad</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Button onClick={handleShowBalances}>Show balances</Button>
            <Button onClick={handleShowRecent}>Show recent 30 entries</Button>
            <Button onClick={handleShowCashflow}>Cashflow + Revenue (this month)</Button>
            <Button onClick={handleReconcile}>Run reconciliation</Button>
          </div>
          <div style={{ marginTop: 12, padding: 8, background: '#F4F6F9', borderRadius: 8, fontSize: 12, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {imbalanceInfo}
          </div>
        </Card>
      </div>

      {balances.length > 0 && (
        <Card className="mb-4">
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Account Balances (natural sign)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
            {balances.map(([acc, bal]) => (
              <div key={acc} style={{ padding: 10, border: '1px solid #E5E9EE', borderRadius: 8, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, color: '#6B7280' }}>{acc}</span>
                <span style={{ fontSize: 13, fontFamily: 'monospace', color: bal < 0 ? '#DC2626' : '#0F0F10' }}>{fmt(bal)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {recent.length > 0 && (
        <Card className="mb-4" noPadding>
          <div style={{ padding: 16, borderBottom: '1px solid #E5E9EE' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Recent Entries</h3>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#F4F6F9', textAlign: 'left' }}>
                  <th style={{ padding: 8 }}>#</th>
                  <th style={{ padding: 8 }}>Account</th>
                  <th style={{ padding: 8 }}>Dir</th>
                  <th style={{ padding: 8, textAlign: 'right' }}>Amount</th>
                  <th style={{ padding: 8 }}>Source</th>
                  <th style={{ padding: 8 }}>Counterparty</th>
                  <th style={{ padding: 8 }}>Reverses</th>
                </tr>
              </thead>
              <tbody>
                {recent.map(r => (
                  <tr key={r.entry_no} style={{ borderTop: '1px solid #E5E9EE' }}>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.entry_no}</td>
                    <td style={{ padding: 8 }}>{r.account}</td>
                    <td style={{ padding: 8, color: r.direction === 'DEBIT' ? '#0F0F10' : '#715DE3' }}>{r.direction}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', textAlign: 'right' }}>{fmt(r.amount)}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.source_module}/{r.source_id.slice(0, 6)}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace' }}>{r.counterparty_id ? r.counterparty_id.slice(0, 12) : '—'}</td>
                    <td style={{ padding: 8, fontFamily: 'monospace', color: '#DC2626' }}>{r.reverses_entry_id ? '↩ ' + r.reverses_entry_id.slice(0, 6) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Activity Log</h3>
        <div style={{ maxHeight: 240, overflowY: 'auto', fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {log.length === 0 ? <span style={{ color: '#6B7280' }}>No actions yet.</span> : log.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      </Card>
    </div>
  );
}

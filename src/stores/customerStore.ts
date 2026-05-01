import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Customer, SalesStage, VIPLevel, CustomerType } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';

interface CustomerStore {
  customers: Customer[];
  selectedCustomer: Customer | null;
  loading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  loadCustomers: () => void;
  getCustomer: (id: string) => Customer | undefined;
  selectCustomer: (id: string) => void;
  createCustomer: (data: Partial<Customer>) => Customer;
  updateCustomer: (id: string, data: Partial<Customer>) => void;
  deleteCustomer: (id: string) => void;
  // Plan §Customer §4: pro Kunde offene Beträge aggregieren.
  getOutstanding: (customerId: string) => { outstanding: number; invoiceCount: number; totalPaid: number; totalGross: number };
  // Live-Cashflow-Berechnung (User-Vorgabe):
  //  Revenue     = Σ payments.amount − Σ sales_returns.refund_paid_amount   (was reinkam minus was raus ging)
  //  Profit      = Σ payment·margin/gross − Σ refund·margin/gross           (anteilig zum Cash-Anteil)
  //  Outstanding = Σ (gross − paid) PARTIAL/DRAFT Invoices + offene we_lend Loans
  getCustomerStats: (customerId: string) => {
    revenue: number;
    profit: number;
    outstanding: number;            // total receivable = invoices + open loans
    invoiceOutstanding: number;     // only from invoices
    loanOutstanding: number;        // only from we_lend debts
    invoiceCount: number;
    openInvoiceCount: number;
    openLoanCount: number;
  };
}

function rowToCustomer(row: Record<string, unknown>): Customer {
  return {
    id: row.id as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    company: row.company as string | undefined,
    phone: row.phone as string | undefined,
    whatsapp: row.whatsapp as string | undefined,
    email: row.email as string | undefined,
    country: (row.country as string) || 'BH',
    language: (row.language as string) || 'en',
    budgetMin: row.budget_min as number | undefined,
    budgetMax: row.budget_max as number | undefined,
    vipLevel: (row.vip_level as VIPLevel) || 0,
    preferences: JSON.parse((row.preferences as string) || '[]'),
    customerType: (row.customer_type as CustomerType) || 'collector',
    salesStage: (row.sales_stage as SalesStage) || 'lead',
    lastContactAt: row.last_contact_at as string | undefined,
    lastPurchaseAt: row.last_purchase_at as string | undefined,
    totalRevenue: (row.total_revenue as number) || 0,
    totalProfit: (row.total_profit as number) || 0,
    purchaseCount: (row.purchase_count as number) || 0,
    vatAccountNumber: row.vat_account_number as string | undefined,
    personalId: row.personal_id as string | undefined,
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useCustomerStore = create<CustomerStore>((set, get) => ({
  customers: [],
  selectedCustomer: null,
  loading: false,
  searchQuery: '',

  setSearchQuery: (q) => set({ searchQuery: q }),

  loadCustomers: () => {
    try {
      const branchId = currentBranchId();
      const rows = query('SELECT * FROM customers WHERE branch_id = ? ORDER BY updated_at DESC', [branchId]);
      set({ customers: rows.map(rowToCustomer), loading: false });
    } catch {
      set({ customers: [], loading: false });
    }
  },

  getCustomer: (id) => get().customers.find(c => c.id === id),

  selectCustomer: (id) => {
    const customer = get().customers.find(c => c.id === id) || null;
    set({ selectedCustomer: customer });
  },

  createCustomer: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const customer: Customer = {
      id,
      firstName: data.firstName || '',
      lastName: data.lastName || '',
      company: data.company,
      phone: data.phone,
      whatsapp: data.whatsapp,
      email: data.email,
      country: data.country || 'BH',
      language: data.language || 'en',
      budgetMin: data.budgetMin,
      budgetMax: data.budgetMax,
      vipLevel: data.vipLevel || 0,
      preferences: data.preferences || [],
      customerType: data.customerType || 'collector',
      salesStage: data.salesStage || 'lead',
      totalRevenue: 0,
      totalProfit: 0,
      purchaseCount: 0,
      vatAccountNumber: data.vatAccountNumber,
      personalId: data.personalId,
      notes: data.notes,
      createdAt: now,
      updatedAt: now,
    };

    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO customers (id, branch_id, first_name, last_name, company, phone, whatsapp, email,
        country, language, budget_min, budget_max, vip_level, preferences, customer_type,
        sales_stage, notes, vat_account_number, personal_id, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, branchId, customer.firstName, customer.lastName, customer.company || null,
       customer.phone || null, customer.whatsapp || null, customer.email || null,
       customer.country, customer.language, customer.budgetMin || null, customer.budgetMax || null,
       customer.vipLevel, JSON.stringify(customer.preferences), customer.customerType,
       customer.salesStage, customer.notes || null, customer.vatAccountNumber || null,
       customer.personalId || null, now, now,
       (() => { try { return currentUserId(); } catch { return null; } })()]
    );

    saveDatabase();
    trackInsert('customers', id, { firstName: customer.firstName, lastName: customer.lastName, phone: customer.phone, email: customer.email });
    eventBus.emit('customer.created', 'customer', id, { name: `${customer.firstName} ${customer.lastName}` });
    get().loadCustomers();
    return customer;
  },

  updateCustomer: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];

    const fieldMap: Record<string, string> = {
      firstName: 'first_name', lastName: 'last_name', company: 'company',
      phone: 'phone', whatsapp: 'whatsapp', email: 'email',
      country: 'country', language: 'language', budgetMin: 'budget_min',
      budgetMax: 'budget_max', vipLevel: 'vip_level', customerType: 'customer_type',
      salesStage: 'sales_stage', notes: 'notes', lastContactAt: 'last_contact_at',
      lastPurchaseAt: 'last_purchase_at', totalRevenue: 'total_revenue',
      totalProfit: 'total_profit', purchaseCount: 'purchase_count',
      vatAccountNumber: 'vat_account_number',
      personalId: 'personal_id',
    };

    for (const [key, val] of Object.entries(data)) {
      const col = fieldMap[key];
      if (col) {
        fields.push(`${col} = ?`);
        values.push(val);
      }
    }

    if (data.preferences) {
      fields.push('preferences = ?');
      values.push(JSON.stringify(data.preferences));
    }

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    db.run(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('customers', id, data);
    eventBus.emit('customer.updated', 'customer', id, data);
    get().loadCustomers();
  },

  deleteCustomer: (id) => {
    // Referenz-Check vor Hard-Delete — sonst Orphan-Records in invoices/debts/returns/etc.
    const refs = query(
      `SELECT
         (SELECT COUNT(*) FROM invoices       WHERE customer_id = ?) AS invoices,
         (SELECT COUNT(*) FROM debts          WHERE customer_id = ?) AS debts,
         (SELECT COUNT(*) FROM sales_returns  WHERE customer_id = ?) AS returns,
         (SELECT COUNT(*) FROM consignments   WHERE consignor_id = ?) AS consignments,
         (SELECT COUNT(*) FROM orders         WHERE customer_id = ?) AS orders,
         (SELECT COUNT(*) FROM repairs        WHERE customer_id = ?) AS repairs`,
      [id, id, id, id, id, id]
    );
    const r = refs[0] || {};
    const linked = ['invoices', 'debts', 'returns', 'consignments', 'orders', 'repairs']
      .map(k => ({ k, n: Number((r as Record<string, unknown>)[k] || 0) }))
      .filter(x => x.n > 0);
    if (linked.length > 0) {
      const detail = linked.map(x => `${x.n} ${x.k}`).join(', ');
      throw new Error(`Cannot delete customer with linked records: ${detail}. Cancel or reassign these first.`);
    }
    const db = getDatabase();
    db.run('DELETE FROM customers WHERE id = ?', [id]);
    saveDatabase();
    trackDelete('customers', id);
    get().loadCustomers();
  },

  // Plan §Customer §4: aggregiert alle offenen Invoices (PARTIAL) pro Kunde.
  // Berücksichtigt NICHT stornierte/gelöschte Invoices.
  getOutstanding: (customerId) => {
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT COALESCE(SUM(gross_amount), 0) AS gross,
                COALESCE(SUM(paid_amount), 0) AS paid,
                COUNT(*) AS cnt
         FROM invoices
         WHERE customer_id = ? AND branch_id = ? AND status IN ('PARTIAL', 'DRAFT')`,
        [customerId, branchId]
      );
      const r = rows[0] || {};
      const gross = Number(r.gross || 0);
      const paid = Number(r.paid || 0);
      return {
        outstanding: Math.max(0, gross - paid),
        invoiceCount: Number(r.cnt || 0),
        totalPaid: paid,
        totalGross: gross,
      };
    } catch {
      return { outstanding: 0, invoiceCount: 0, totalPaid: 0, totalGross: 0 };
    }
  },

  // Live-Cashflow:
  //  Revenue = Σ Customer-Zahlungen − Σ tatsächlich geleistete Refund-Zahlungen.
  //  Profit  = anteilig: pro Zahlung margin/gross-Quote, ebenso pro Refund-Zahlung abgezogen.
  //  Outstanding = (gross − paid) der offenen Invoices + offene we_lend-Loans.
  // User-Vorgabe (2026-04-29): Revenue/Profit zählen NUR bei status='FINAL' (voll bezahlt).
  // PARTIAL/DRAFT/CANCELLED-Invoices tragen NICHT bei — Teilzahlung wird in der UI separat
  // als „Paid"/„Remaining" angezeigt, aber erst bei voller Settle-ung wird Umsatz realisiert.
  getCustomerStats: (customerId) => {
    try {
      // Cash-Inflow: nur Zahlungen auf FINAL-Invoices zählen als Revenue.
      const inflowRow = query(
        `SELECT COALESCE(SUM(p.amount), 0) AS paid_in,
                COALESCE(SUM(p.amount * (i.margin_snapshot / NULLIF(i.gross_amount, 0))), 0) AS profit_in
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
         WHERE i.customer_id = ? AND i.status = 'FINAL'`,
        [customerId]
      );

      // Cash-Outflow: Refunds nur abziehen wenn die zugehörige Invoice FINAL war
      // (sonst wurde sie nie als Revenue gezählt → Refund würde Revenue ins Negative drücken).
      const outflowRow = query(
        `SELECT COALESCE(SUM(r.refund_paid_amount), 0) AS paid_out,
                COALESCE(SUM(r.refund_paid_amount * (i.margin_snapshot / NULLIF(i.gross_amount, 0))), 0) AS profit_out
         FROM sales_returns r
         JOIN invoices i ON i.id = r.invoice_id
         WHERE r.customer_id = ? AND i.status = 'FINAL'`,
        [customerId]
      );

      const paidIn   = Number(inflowRow[0]?.paid_in   || 0);
      const profitIn = Number(inflowRow[0]?.profit_in || 0);
      const paidOut  = Number(outflowRow[0]?.paid_out  || 0);
      const profitOut= Number(outflowRow[0]?.profit_out || 0);

      // Outstanding aus Invoices (PARTIAL/DRAFT mit gross > paid).
      const openRow = query(
        `SELECT COALESCE(SUM(gross_amount - paid_amount), 0) AS outstanding,
                COUNT(*) AS open_cnt
         FROM invoices
         WHERE customer_id = ? AND status IN ('PARTIAL', 'DRAFT')`,
        [customerId]
      );

      // Anzahl aktiver Invoices (für UI "X invoices"-Hinweis) — ohne stornierte/draft.
      const cntRow = query(
        `SELECT COUNT(*) AS cnt
         FROM invoices
         WHERE customer_id = ? AND status NOT IN ('CANCELLED', 'DRAFT')`,
        [customerId]
      );

      // Loans: offene we_lend-Beträge — Raten leben in debt_payments (Subselect).
      const loanRow = query(
        `SELECT COALESCE(SUM(d.amount - COALESCE(p.total_paid, 0)), 0) AS open_lent,
                COUNT(*) AS cnt
         FROM debts d
         LEFT JOIN (
           SELECT debt_id, SUM(amount) AS total_paid
           FROM debt_payments
           GROUP BY debt_id
         ) p ON p.debt_id = d.id
         WHERE d.customer_id = ? AND d.direction = 'we_lend'
           AND d.status NOT IN ('CANCELLED', 'REPAID', 'settled')`,
        [customerId]
      );

      const o = openRow[0] || {};
      const invoiceOutstanding = Math.max(0, Number(o.outstanding || 0));
      const loanOpen = Math.max(0, Number(loanRow[0]?.open_lent || 0));
      const loanCount = Number(loanRow[0]?.cnt || 0);

      return {
        revenue: Math.max(0, paidIn - paidOut),
        profit: profitIn - profitOut,
        outstanding: invoiceOutstanding + loanOpen,
        invoiceOutstanding,
        loanOutstanding: loanOpen,
        invoiceCount: Number(cntRow[0]?.cnt || 0),
        openInvoiceCount: Number(o.open_cnt || 0),
        openLoanCount: loanCount,
      };
    } catch {
      return { revenue: 0, profit: 0, outstanding: 0, invoiceOutstanding: 0, loanOutstanding: 0, invoiceCount: 0, openInvoiceCount: 0, openLoanCount: 0 };
    }
  },
}));

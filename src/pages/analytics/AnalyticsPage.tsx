import { useState, useEffect, useMemo } from 'react';
import {
  TrendingUp, Package, Users, FileText,
  DollarSign, Clock, BarChart3, PieChart,
  Wallet, Building2, CheckCircle2,
} from 'lucide-react';
import { v4 as uuid } from 'uuid';
import { KPICard } from '@/components/ui/KPICard';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { exportCsv } from '@/core/utils/export-file';

// ── Helpers ──

type Tab = 'sales' | 'stock' | 'finance' | 'clients';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDec(v: number, digits = 1): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function pct(v: number): string {
  return fmtDec(v) + '%';
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function qry(sql: string, params: unknown[] = []): Record<string, unknown>[] {
  try {
    return query(sql, params);
  } catch {
    return [];
  }
}

function num(row: Record<string, unknown>, key: string): number {
  return (row[key] as number) || 0;
}

// ── Tab button style ──

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '10px 24px',
  fontSize: 13,
  fontWeight: 500,
  letterSpacing: '0.04em',
  color: active ? '#0F0F10' : '#6B7280',
  background: active ? 'rgba(15,15,16,0.08)' : 'transparent',
  border: `1px solid ${active ? 'rgba(15,15,16,0.15)' : '#E5E9EE'}`,
  borderRadius: 8,
  cursor: 'pointer',
  transition: 'all 0.2s',
});

// ── Section header ──

function SectionLabel({ children }: { children: string }) {
  return (
    <span
      className="text-overline"
      style={{ display: 'block', marginBottom: 16, marginTop: 8 }}
    >
      {children}
    </span>
  );
}

// ── Table row helper ──

function TableRow({
  label,
  value,
  sub,
  color,
  bold,
  borderBottom = true,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  bold?: boolean;
  borderBottom?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '14px 0',
        borderBottom: borderBottom ? '1px solid #E5E9EE' : 'none',
      }}
    >
      <span style={{ fontSize: 14, color: '#4B5563', fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <div className="text-right">
        <span
          className="font-mono"
          style={{ fontSize: 14, color: color || '#0F0F10', fontWeight: bold ? 600 : 400 }}
        >
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>{sub}</span>
        )}
      </div>
    </div>
  );
}

// ── Ranked list item ──

function RankedItem({
  rank,
  label,
  value,
  sub,
  color,
}: {
  rank: number;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div
      className="flex items-center justify-between"
      style={{ padding: '12px 0', borderBottom: '1px solid #E5E9EE' }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex items-center justify-center rounded-full font-mono"
          style={{
            width: 28,
            height: 28,
            background: '#E5E9EE',
            fontSize: 11,
            color: '#4B5563',
            flexShrink: 0,
          }}
        >
          {rank}
        </span>
        <span style={{ fontSize: 14, color: '#0F0F10' }}>{label}</span>
      </div>
      <div className="text-right">
        <span className="font-mono" style={{ fontSize: 14, color: color || '#0F0F10' }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>{sub}</span>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════

export function AnalyticsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('sales');
  const [branchId, setBranchId] = useState<string>('');
  const [refreshTick, setRefreshTick] = useState(0);

  // Tax payment modal state
  const [taxPayQuarter, setTaxPayQuarter] = useState<{ year: number; quarter: number; vat: number; paid: number } | null>(null);
  const [taxPayAmount, setTaxPayAmount] = useState('');
  const [taxPayDate, setTaxPayDate] = useState('');
  const [taxPaySource, setTaxPaySource] = useState<'cash' | 'bank'>('bank');
  const [taxPayNote, setTaxPayNote] = useState('');

  useEffect(() => {
    try {
      setBranchId(currentBranchId());
    } catch {
      setBranchId('branch-main');
    }
  }, []);

  useEffect(() => {
    if (taxPayQuarter) {
      setTaxPayAmount((taxPayQuarter.vat - taxPayQuarter.paid).toFixed(3));
      setTaxPayDate(new Date().toISOString().split('T')[0]);
      setTaxPaySource('bank');
      setTaxPayNote('');
    }
  }, [taxPayQuarter]);

  function confirmTaxPayment() {
    if (!taxPayQuarter) return;
    const amt = parseFloat(taxPayAmount);
    if (!amt || amt <= 0) return;
    const now = new Date().toISOString();
    try {
      const db = getDatabase();
      db.run(
        `INSERT INTO tax_payments (id, branch_id, year, quarter, amount, source, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuid(), branchId, taxPayQuarter.year, taxPayQuarter.quarter, amt, taxPaySource, taxPayDate + 'T00:00:00Z', taxPayNote || null, now]
      );
      saveDatabase();
    } catch (e) {
      console.warn('Tax payment save failed', e);
    }
    setTaxPayQuarter(null);
    setRefreshTick(t => t + 1);
  }

  // ── SALES DATA ──

  const sales = useMemo(() => {
    if (!branchId) return null;

    // Invoices (non-cancelled)
    const invoices = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(gross_amount),0) as gross,
              COALESCE(SUM(net_amount),0) as net, COALESCE(SUM(vat_amount),0) as vat,
              COALESCE(SUM(margin_snapshot),0) as profit,
              COALESCE(SUM(purchase_price_snapshot),0) as cost
       FROM invoices WHERE branch_id = ? AND status = 'FINAL'`,
      [branchId]
    );
    const inv = invoices[0] || {};
    const invoiceCount = num(inv, 'cnt');
    const grossRevenue = num(inv, 'gross');
    const netRevenue = num(inv, 'net');
    const totalProfit = num(inv, 'profit');
    const marginPct = safeDiv(totalProfit, netRevenue) * 100;
    const avgSaleValue = safeDiv(grossRevenue, invoiceCount);

    // Offers
    const offers = qry(
      `SELECT COUNT(*) as cnt FROM offers WHERE branch_id = ?`,
      [branchId]
    );
    const offerCount = num(offers[0] || {}, 'cnt');

    const accepted = qry(
      `SELECT COUNT(*) as cnt FROM offers WHERE branch_id = ? AND status = 'accepted'`,
      [branchId]
    );
    const acceptedCount = num(accepted[0] || {}, 'cnt');
    const closeRate = safeDiv(acceptedCount, offerCount) * 100;

    // Revenue by category
    const revByCat = qry(
      `SELECT c.name, c.color, COALESCE(SUM(il.line_total),0) as revenue, COUNT(il.id) as cnt
       FROM invoice_lines il
       JOIN products p ON p.id = il.product_id
       JOIN categories c ON c.id = p.category_id
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'
       GROUP BY c.id ORDER BY revenue DESC`,
      [branchId]
    );

    // Top 5 brands
    const topBrands = qry(
      `SELECT p.brand, COALESCE(SUM(il.line_total),0) as revenue, COUNT(il.id) as cnt
       FROM invoice_lines il
       JOIN products p ON p.id = il.product_id
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'
       GROUP BY p.brand ORDER BY revenue DESC LIMIT 5`,
      [branchId]
    );

    return {
      grossRevenue, netRevenue, totalProfit, marginPct,
      invoiceCount, offerCount, closeRate, avgSaleValue,
      revByCat, topBrands,
    };
  }, [branchId]);

  // ── STOCK DATA ──

  const stock = useMemo(() => {
    if (!branchId) return null;

    // Total stock value (EK = purchase, VK = planned sale)
    // Plan §Commission §5: nur OWN-Ware zählt als Asset.
    const totals = qry(
      `SELECT COUNT(*) as cnt,
              COALESCE(SUM(purchase_price),0) as ek,
              COALESCE(SUM(planned_sale_price),0) as vk
       FROM products WHERE branch_id = ? AND stock_status = 'in_stock' AND source_type = 'OWN'`,
      [branchId]
    );
    const t = totals[0] || {};
    const totalItems = num(t, 'cnt');
    const totalEK = num(t, 'ek');
    const totalVK = num(t, 'vk');

    // Items by category
    // Plan §Commission §5: nur OWN-Ware.
    const byCat = qry(
      `SELECT c.name, c.color, COUNT(p.id) as cnt,
              COALESCE(SUM(p.purchase_price),0) as value
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE p.branch_id = ? AND p.stock_status = 'in_stock' AND p.source_type = 'OWN'
       GROUP BY c.id ORDER BY value DESC`,
      [branchId]
    );

    // Slow movers (> 90 days in stock)
    const slow = qry(
      `SELECT COUNT(*) as cnt FROM products
       WHERE branch_id = ? AND stock_status = 'in_stock' AND days_in_stock > 90`,
      [branchId]
    );
    const slowCount = num(slow[0] || {}, 'cnt');

    // Average days in stock
    const avgDays = qry(
      `SELECT COALESCE(AVG(days_in_stock),0) as avg_days
       FROM products WHERE branch_id = ? AND stock_status = 'in_stock'`,
      [branchId]
    );
    const avgDaysInStock = num(avgDays[0] || {}, 'avg_days');

    // Status breakdown (all products, not just in_stock)
    const byStatus = qry(
      `SELECT stock_status, COUNT(*) as cnt
       FROM products WHERE branch_id = ?
       GROUP BY stock_status ORDER BY cnt DESC`,
      [branchId]
    );

    return { totalItems, totalEK, totalVK, byCat, slowCount, avgDaysInStock, byStatus };
  }, [branchId]);

  // ── FINANCE DATA ──

  const finance = useMemo(() => {
    if (!branchId) return null;

    // Revenue totals from final invoices.
    // Total VAT muss BEIDE Steuern erfassen — auch in mixed-Scheme-Invoices (typisch: Watch via MARGIN
    // + Strap/Box via VAT_10 in derselben Rechnung). Lösung: per-Line aggregieren.
    //  - Stored vat_amount (Invoice-Level): erfasst nur VAT_10/ZERO-Anteile (MARGIN-Lines speichern 0)
    //  - Margin-VAT muss live aus invoice_lines berechnet werden:
    //    qty × max(0, unit_price − purchase_price) × vat_rate / (100 + vat_rate)
    const rev = qry(
      `SELECT COALESCE(SUM(net_amount),0) as net,
              COALESCE(SUM(gross_amount),0) as gross,
              COALESCE(SUM(vat_amount),0) as stored_vat,
              COALESCE(SUM(margin_snapshot),0) as profit
       FROM invoices WHERE branch_id = ? AND status = 'FINAL'`,
      [branchId]
    );
    // Per-Line MARGIN-VAT — über alle FINAL-Invoices, alle Lines mit tax_scheme='MARGIN'.
    const marginVatRow = qry(
      `SELECT COALESCE(SUM(
         CASE WHEN il.tax_scheme = 'MARGIN' AND il.unit_price > il.purchase_price_snapshot
           THEN COALESCE(il.quantity, 1) * (il.unit_price - il.purchase_price_snapshot)
                * il.vat_rate / (100 + il.vat_rate)
         ELSE 0 END
       ),0) AS margin_vat
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.branch_id = ? AND i.status = 'FINAL'`,
      [branchId]
    );
    const r = rev[0] || {};
    const netRevenue = num(r, 'net');
    const grossRevenue = num(r, 'gross');
    const totalVat = num(r, 'stored_vat') + num(marginVatRow[0] || {}, 'margin_vat');
    const profitAfterVat = num(r, 'profit');

    // Open invoices (issued or partially_paid)
    const open = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(gross_amount - paid_amount),0) as outstanding
       FROM invoices WHERE branch_id = ? AND status IN ('issued','partially_paid')`,
      [branchId]
    );
    const o = open[0] || {};
    const openCount = num(o, 'cnt');
    const openValue = num(o, 'outstanding');

    // Paid invoices
    const paid = qry(
      `SELECT COUNT(*) as cnt, COALESCE(SUM(paid_amount),0) as total_paid
       FROM invoices WHERE branch_id = ? AND status = 'paid'`,
      [branchId]
    );
    const p = paid[0] || {};
    const paidCount = num(p, 'cnt');
    const paidValue = num(p, 'total_paid');

    // Revenue from repairs (completed or picked_up with charge)
    const repairRev = qry(
      `SELECT COALESCE(SUM(charge_to_customer),0) as rev, COALESCE(SUM(margin),0) as profit
       FROM repairs WHERE branch_id = ? AND status IN ('ready','picked_up') AND charge_to_customer > 0`,
      [branchId]
    );
    const repRev = num(repairRev[0] || {}, 'rev');

    // Consignment commissions
    const conComm = qry(
      `SELECT COALESCE(SUM(commission_amount),0) as comm
       FROM consignments WHERE branch_id = ? AND status IN ('sold','paid_out')`,
      [branchId]
    );
    const consignmentComm = num(conComm[0] || {}, 'comm');

    // Agent commissions (what we pay out to agents)
    const agentComm = qry(
      `SELECT COALESCE(SUM(commission_amount),0) as comm
       FROM agent_transfers WHERE branch_id = ? AND status IN ('sold','settled')`,
      [branchId]
    );
    const agentCommTotal = num(agentComm[0] || {}, 'comm');

    // Outstanding payments (total owed to us)
    const outstandingPayments = openValue;

    // ── Cashflow: Cash vs Bank vs Card (with fee deduction) ──
    const cardFeeRow = qry(
      `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.card_fee_rate'`,
      [branchId]
    );
    const cardFeeRate = parseFloat((cardFeeRow[0]?.value as string) || '2.2') || 2.2;

    const payByMethod = qry(
      `SELECT method, COALESCE(SUM(amount),0) as total
       FROM payments WHERE branch_id = ? GROUP BY method`,
      [branchId]
    );
    let cashReceived = 0, bankReceived = 0, cardReceived = 0, cryptoReceived = 0, otherReceived = 0;
    for (const row of payByMethod) {
      const m = row.method as string;
      const amt = (row.total as number) || 0;
      if (m === 'cash') cashReceived += amt;
      else if (m === 'bank_transfer') bankReceived += amt;
      else if (m === 'card') cardReceived += amt;
      else if (m === 'crypto') cryptoReceived += amt;
      else otherReceived += amt;
    }
    const cardFeeLost = Math.round(cardReceived * cardFeeRate / 100 * 100) / 100;
    const cardNetToBank = cardReceived - cardFeeLost;
    // Quarterly tax paid (outflow)
    const taxPaidRows = qry(
      `SELECT year, quarter, amount, source FROM tax_payments WHERE branch_id = ?`,
      [branchId]
    );
    let taxPaidTotal = 0, taxPaidFromCash = 0, taxPaidFromBank = 0;
    for (const t of taxPaidRows) {
      const a = (t.amount as number) || 0;
      taxPaidTotal += a;
      if ((t.source as string) === 'cash') taxPaidFromCash += a;
      else taxPaidFromBank += a;
    }
    // Debt flows (if debts table exists)
    let lentOutCash = 0, lentOutBank = 0, borrowedInCash = 0, borrowedInBank = 0;
    let debtRepaidToUsCash = 0, debtRepaidToUsBank = 0;
    let debtRepaidByUsCash = 0, debtRepaidByUsBank = 0;
    try {
      const debts = qry(`SELECT direction, source, amount FROM debts WHERE branch_id = ?`, [branchId]);
      for (const d of debts) {
        const a = (d.amount as number) || 0;
        const src = d.source as string;
        if (d.direction === 'we_lend') {
          if (src === 'cash') lentOutCash += a; else lentOutBank += a;
        } else {
          if (src === 'cash') borrowedInCash += a; else borrowedInBank += a;
        }
      }
      const dpays = qry(
        `SELECT dp.amount, dp.source, d.direction
         FROM debt_payments dp JOIN debts d ON d.id = dp.debt_id
         WHERE d.branch_id = ?`,
        [branchId]
      );
      for (const p of dpays) {
        const a = (p.amount as number) || 0;
        const src = p.source as string;
        if (p.direction === 'we_lend') {
          if (src === 'cash') debtRepaidToUsCash += a; else debtRepaidToUsBank += a;
        } else {
          if (src === 'cash') debtRepaidByUsCash += a; else debtRepaidByUsBank += a;
        }
      }
    } catch { /* debts table not yet migrated */ }

    // Opening balances (admin-set status quo)
    const openingRows = qry(
      `SELECT key, value FROM settings WHERE branch_id = ? AND (key = 'finance.opening_cash' OR key = 'finance.opening_bank')`,
      [branchId]
    );
    let openingCash = 0, openingBank = 0;
    for (const r of openingRows) {
      const v = parseFloat((r.value as string) || '0') || 0;
      if (r.key === 'finance.opening_cash') openingCash = v;
      else if (r.key === 'finance.opening_bank') openingBank = v;
    }

    // Product EK outflow (cash / bank)
    let productEkCash = 0, productEkBank = 0;
    try {
      const ekRows = qry(
        `SELECT paid_from, COALESCE(SUM(purchase_price),0) as total
         FROM products WHERE branch_id = ? AND paid_from IS NOT NULL GROUP BY paid_from`,
        [branchId]
      );
      for (const r of ekRows) {
        const t = (r.total as number) || 0;
        if (r.paid_from === 'cash') productEkCash += t;
        else if (r.paid_from === 'bank') productEkBank += t;
      }
    } catch { /* columns not yet migrated */ }

    // Repair cashflow
    let repairCashIn = 0, repairBankIn = 0, repairCashOut = 0, repairBankOut = 0;
    try {
      const rpIn = qry(
        `SELECT customer_paid_from, COALESCE(SUM(charge_to_customer),0) as total
         FROM repairs WHERE branch_id = ? AND status IN ('ready','picked_up')
         AND customer_paid_from IS NOT NULL AND charge_to_customer > 0 GROUP BY customer_paid_from`,
        [branchId]
      );
      for (const r of rpIn) {
        const t = (r.total as number) || 0;
        if (r.customer_paid_from === 'cash') repairCashIn += t;
        else if (r.customer_paid_from === 'bank') repairBankIn += t;
      }
      const rpOut = qry(
        `SELECT internal_paid_from, COALESCE(SUM(internal_cost),0) as total
         FROM repairs WHERE branch_id = ? AND internal_paid_from IS NOT NULL
         AND internal_cost > 0 GROUP BY internal_paid_from`,
        [branchId]
      );
      for (const r of rpOut) {
        const t = (r.total as number) || 0;
        if (r.internal_paid_from === 'cash') repairCashOut += t;
        else if (r.internal_paid_from === 'bank') repairBankOut += t;
      }
    } catch { /* ignore */ }

    // Consignment cashflow (sale income + payout)
    let consignSaleCash = 0, consignSaleBank = 0, consignPayoutCash = 0, consignPayoutBank = 0;
    try {
      const cnIn = qry(
        `SELECT sale_method, COALESCE(SUM(sale_price),0) as total
         FROM consignments WHERE branch_id = ? AND status IN ('sold','paid_out')
         AND sale_method IS NOT NULL GROUP BY sale_method`,
        [branchId]
      );
      for (const r of cnIn) {
        const t = (r.total as number) || 0;
        if (r.sale_method === 'cash') consignSaleCash += t;
        else if (r.sale_method === 'bank') consignSaleBank += t;
      }
      const cnOut = qry(
        `SELECT payout_method, COALESCE(SUM(payout_amount),0) as total
         FROM consignments WHERE branch_id = ? AND payout_status = 'paid'
         AND payout_method IS NOT NULL GROUP BY payout_method`,
        [branchId]
      );
      for (const r of cnOut) {
        const t = (r.total as number) || 0;
        if (r.payout_method === 'cash') consignPayoutCash += t;
        else consignPayoutBank += t; // treat bank_transfer/card as bank
      }
    } catch { /* ignore */ }

    // Agent/Approval Settlements (Inflow): Der Agent verkauft unsere Ware und
    // zahlt uns den Erlös abzüglich Kommission aus → Geld kommt rein.
    // Konvertierte Transfers (mit invoice_id) werden hier NICHT gezählt — deren
    // Cashflow läuft über die Invoice-Payments (= cashReceived/bankReceived).
    let agentSettleCash = 0, agentSettleBank = 0;
    try {
      const agRows = qry(
        `SELECT asp.method, COALESCE(SUM(asp.amount),0) as total
         FROM agent_settlement_payments asp
         JOIN agent_transfers at ON at.id = asp.transfer_id
         WHERE at.branch_id = ? AND at.invoice_id IS NULL
         GROUP BY asp.method`,
        [branchId]
      );
      for (const r of agRows) {
        const t = (r.total as number) || 0;
        if (r.method === 'cash') agentSettleCash += t;
        else if (r.method === 'bank') agentSettleBank += t;
      }
    } catch { /* ignore */ }

    // Order deposits not yet converted to invoice (avoid doubling after conversion)
    let orderDepositCash = 0, orderDepositBank = 0;
    try {
      const opRows = qry(
        `SELECT op.method, COALESCE(SUM(op.amount),0) as total
         FROM order_payments op JOIN orders o ON o.id = op.order_id
         WHERE o.branch_id = ? AND COALESCE(op.converted_to_invoice,0) = 0
           AND o.status != 'cancelled'
         GROUP BY op.method`,
        [branchId]
      );
      for (const r of opRows) {
        const t = (r.total as number) || 0;
        const m = (r.method as string) || 'cash';
        if (m === 'cash') orderDepositCash += t;
        else if (m === 'bank_transfer') orderDepositBank += t;
        else if (m === 'card') orderDepositBank += t * (1 - cardFeeRate / 100);
      }
    } catch { /* ignore */ }

    // Phase 1 — Purchase payments (Plan §Purchases §8), Cash/Bank ↓
    let purchasePaidCash = 0, purchasePaidBank = 0;
    try {
      const ppRows = qry(
        `SELECT pp.method, COALESCE(SUM(pp.amount),0) as total
         FROM purchase_payments pp JOIN purchases p ON p.id = pp.purchase_id
         WHERE p.branch_id = ? AND p.status != 'CANCELLED'
         GROUP BY pp.method`,
        [branchId]
      );
      for (const r of ppRows) {
        const t = (r.total as number) || 0;
        if (r.method === 'cash') purchasePaidCash += t;
        else if (r.method === 'bank') purchasePaidBank += t;
      }
    } catch { /* ignore */ }

    // Phase 1 — Expenses (Plan §Expenses §6), Cash/Bank ↓
    let expenseCash = 0, expenseBank = 0;
    try {
      const expRows = qry(
        `SELECT payment_method, COALESCE(SUM(amount),0) as total
         FROM expenses WHERE branch_id = ? GROUP BY payment_method`,
        [branchId]
      );
      for (const r of expRows) {
        const t = (r.total as number) || 0;
        if (r.payment_method === 'cash') expenseCash += t;
        else if (r.payment_method === 'bank') expenseBank += t;
      }
    } catch { /* ignore */ }

    // Phase 2 — Sales Return refunds (Plan §Returns §7), Cash/Bank ↓
    let salesRefundCash = 0, salesRefundBank = 0;
    try {
      const srRows = qry(
        `SELECT refund_method, COALESCE(SUM(refund_amount),0) as total
         FROM sales_returns WHERE branch_id = ? AND status = 'REFUNDED'
         AND refund_method IS NOT NULL AND refund_amount > 0
         GROUP BY refund_method`,
        [branchId]
      );
      for (const r of srRows) {
        const t = (r.total as number) || 0;
        if (r.refund_method === 'cash') salesRefundCash += t;
        else if (r.refund_method === 'bank') salesRefundBank += t;
      }
    } catch { /* ignore */ }

    // Phase 4 — Bank Transfers (Cash↔Bank). Plan §Banking §10
    let cashToBank = 0, bankToCash = 0;
    try {
      const btRows = qry(
        `SELECT direction, COALESCE(SUM(amount),0) as total FROM bank_transfers WHERE branch_id = ? GROUP BY direction`,
        [branchId]
      );
      for (const r of btRows) {
        const t = (r.total as number) || 0;
        if (r.direction === 'CASH_TO_BANK') cashToBank += t;
        else if (r.direction === 'BANK_TO_CASH') bankToCash += t;
      }
    } catch { /* ignore */ }

    // Phase 4 — Partner investments (IN) + withdrawals (OUT) + profit distributions (OUT)
    let partnerInvestCash = 0, partnerInvestBank = 0;
    let partnerWithdrawCash = 0, partnerWithdrawBank = 0;
    try {
      const ptRows = qry(
        `SELECT type, method, COALESCE(SUM(amount),0) as total
         FROM partner_transactions WHERE branch_id = ? GROUP BY type, method`,
        [branchId]
      );
      for (const r of ptRows) {
        const t = (r.total as number) || 0;
        const m = r.method as string;
        const type = r.type as string;
        if (type === 'INVESTMENT') {
          if (m === 'cash') partnerInvestCash += t; else partnerInvestBank += t;
        } else {
          // WITHDRAWAL + PROFIT_DISTRIBUTION both reduce liquid cash
          if (m === 'cash') partnerWithdrawCash += t; else partnerWithdrawBank += t;
        }
      }
    } catch { /* ignore */ }

    // Phase 1 — Purchase return refunds (Plan §Purchase Returns §9), Cash/Bank ↑
    let purchaseRefundCash = 0, purchaseRefundBank = 0;
    try {
      const prRows = qry(
        `SELECT refund_method, COALESCE(SUM(refund_amount),0) as total
         FROM purchase_returns WHERE branch_id = ? AND status = 'CONFIRMED'
         AND refund_method IS NOT NULL AND refund_method != 'credit' AND refund_amount > 0
         GROUP BY refund_method`,
        [branchId]
      );
      for (const r of prRows) {
        const t = (r.total as number) || 0;
        if (r.refund_method === 'cash') purchaseRefundCash += t;
        else if (r.refund_method === 'bank') purchaseRefundBank += t;
      }
    } catch { /* ignore */ }

    const cashBalance = openingCash + cashReceived + borrowedInCash + debtRepaidToUsCash
                      + repairCashIn + consignSaleCash + orderDepositCash + purchaseRefundCash
                      + partnerInvestCash + bankToCash + agentSettleCash
                      - lentOutCash - debtRepaidByUsCash - taxPaidFromCash - productEkCash
                      - repairCashOut - consignPayoutCash
                      - purchasePaidCash - expenseCash - salesRefundCash
                      - partnerWithdrawCash - cashToBank;
    const bankBalance = openingBank + bankReceived + cardNetToBank + borrowedInBank + debtRepaidToUsBank
                      + repairBankIn + consignSaleBank + orderDepositBank + purchaseRefundBank
                      + partnerInvestBank + cashToBank + agentSettleBank
                      - lentOutBank - debtRepaidByUsBank - taxPaidFromBank - productEkBank
                      - repairBankOut - consignPayoutBank - salesRefundBank
                      - partnerWithdrawBank - bankToCash
                      - purchasePaidBank - expenseBank;
    const totalLiquid = cashBalance + bankBalance;

    // ── Quarterly VAT (owed) ──
    type QuarterRow = { year: number; quarter: number; vat: number; paid: number };
    const fyStartRow = qry(
      `SELECT value FROM settings WHERE branch_id = ? AND key = 'finance.fiscal_year_start_month'`,
      [branchId]
    );
    const fyStartMonth = parseInt((fyStartRow[0]?.value as string) || '1') || 1; // 1-12

    // Quarterly VAT: per-invoice effective VAT = stored vat_amount (VAT_10/ZERO-Anteile)
    // PLUS per-line MARGIN-VAT-Subselect (für mixed-Scheme-Invoices ist das essentiell —
    // dort enthält der invoice-level vat_amount nur den VAT_10-Anteil, MARGIN-Anteil fehlt).
    const vatByInv = qry(
      `SELECT COALESCE(i.issued_at, i.created_at) as d,
              i.vat_amount + COALESCE((
                SELECT SUM(
                  CASE WHEN il.tax_scheme = 'MARGIN' AND il.unit_price > il.purchase_price_snapshot
                    THEN COALESCE(il.quantity, 1) * (il.unit_price - il.purchase_price_snapshot)
                         * il.vat_rate / (100 + il.vat_rate)
                  ELSE 0 END
                )
                FROM invoice_lines il WHERE il.invoice_id = i.id
              ), 0) AS effective_vat
         FROM invoices i
        WHERE i.branch_id = ? AND i.status != 'CANCELLED' AND i.status != 'DRAFT'
          AND COALESCE(i.butterfly,0) = 0`,
      [branchId]
    );
    const quarterlyVatOwed: Record<string, number> = {};
    for (const row of vatByInv) {
      const d = new Date((row.d as string) || Date.now());
      const year = d.getFullYear();
      const month = d.getMonth() + 1; // 1-12
      // Map calendar month to fiscal quarter (1-4)
      const fyOffset = ((month - fyStartMonth + 12) % 12); // 0-11 within fy
      const q = Math.floor(fyOffset / 3) + 1;
      // Fiscal year label: the calendar year of the quarter's start month
      const key = `${year}-Q${q}`;
      quarterlyVatOwed[key] = (quarterlyVatOwed[key] || 0) + ((row.effective_vat as number) || 0);
    }
    const quarterlyVatPaid: Record<string, number> = {};
    for (const t of taxPaidRows) {
      const key = `${t.year}-Q${t.quarter}`;
      quarterlyVatPaid[key] = (quarterlyVatPaid[key] || 0) + ((t.amount as number) || 0);
    }
    const quarterly: QuarterRow[] = Object.keys(quarterlyVatOwed)
      .sort((a, b) => b.localeCompare(a))
      .map(k => {
        const [yearStr, qStr] = k.split('-Q');
        return {
          year: parseInt(yearStr),
          quarter: parseInt(qStr),
          vat: quarterlyVatOwed[k] || 0,
          paid: quarterlyVatPaid[k] || 0,
        };
      });

    return {
      netRevenue, grossRevenue, totalVat, profitAfterVat,
      openCount, openValue, paidCount, paidValue,
      repairRevenue: repRev, consignmentComm, agentCommTotal,
      outstandingPayments,
      // Cashflow
      cashReceived, bankReceived, cardReceived, cryptoReceived, otherReceived,
      cardFeeRate, cardFeeLost, cardNetToBank,
      cashBalance, bankBalance, totalLiquid,
      openingCash, openingBank,
      productEkCash, productEkBank,
      purchasePaidCash, purchasePaidBank,
      expenseCash, expenseBank,
      purchaseRefundCash, purchaseRefundBank,
      salesRefundCash, salesRefundBank,
      partnerInvestCash, partnerInvestBank,
      partnerWithdrawCash, partnerWithdrawBank,
      cashToBank, bankToCash,
      repairCashIn, repairBankIn, repairCashOut, repairBankOut,
      consignSaleCash, consignSaleBank, consignPayoutCash, consignPayoutBank,
      agentSettleCash, agentSettleBank,
      orderDepositCash, orderDepositBank,
      // Debt flows
      lentOutCash, lentOutBank, borrowedInCash, borrowedInBank,
      debtRepaidToUsCash, debtRepaidToUsBank, debtRepaidByUsCash, debtRepaidByUsBank,
      // Tax
      taxPaidTotal, taxPaidFromCash, taxPaidFromBank,
      quarterly,
    };
  }, [branchId, refreshTick]);


  // ── CLIENT DATA ──

  const clients = useMemo(() => {
    if (!branchId) return null;

    // Total clients
    const total = qry(
      `SELECT COUNT(*) as cnt FROM customers WHERE branch_id = ?`,
      [branchId]
    );
    const totalClients = num(total[0] || {}, 'cnt');

    // Active (purchased in last 180 days)
    const active = qry(
      `SELECT COUNT(*) as cnt FROM customers
       WHERE branch_id = ? AND last_purchase_at IS NOT NULL
       AND last_purchase_at >= date('now','-180 days')`,
      [branchId]
    );
    const activeClients = num(active[0] || {}, 'cnt');

    // Dormant
    const dormant = qry(
      `SELECT COUNT(*) as cnt FROM customers
       WHERE branch_id = ? AND sales_stage = 'dormant'`,
      [branchId]
    );
    const dormantClients = num(dormant[0] || {}, 'cnt');

    // Top 5 by revenue
    const topByRev = qry(
      `SELECT first_name, last_name, total_revenue, purchase_count
       FROM customers WHERE branch_id = ? AND total_revenue > 0
       ORDER BY total_revenue DESC LIMIT 5`,
      [branchId]
    );

    // Top 5 by profit
    const topByProfit = qry(
      `SELECT first_name, last_name, total_profit, purchase_count
       FROM customers WHERE branch_id = ? AND total_profit > 0
       ORDER BY total_profit DESC LIMIT 5`,
      [branchId]
    );

    // Average client value
    const totalRevenue = qry(
      `SELECT COALESCE(SUM(total_revenue),0) as rev FROM customers WHERE branch_id = ?`,
      [branchId]
    );
    const avgClientValue = safeDiv(num(totalRevenue[0] || {}, 'rev'), totalClients);

    // Repeat purchase rate
    const buyingClients = qry(
      `SELECT COUNT(*) as cnt FROM customers WHERE branch_id = ? AND purchase_count > 0`,
      [branchId]
    );
    const repeatClients = qry(
      `SELECT COUNT(*) as cnt FROM customers WHERE branch_id = ? AND purchase_count > 1`,
      [branchId]
    );
    const buyingCount = num(buyingClients[0] || {}, 'cnt');
    const repeatCount = num(repeatClients[0] || {}, 'cnt');
    const repeatRate = safeDiv(repeatCount, buyingCount) * 100;

    // VIP distribution
    const vipDist = qry(
      `SELECT vip_level, COUNT(*) as cnt
       FROM customers WHERE branch_id = ?
       GROUP BY vip_level ORDER BY vip_level`,
      [branchId]
    );

    return {
      totalClients, activeClients, dormantClients,
      topByRev, topByProfit, avgClientValue,
      repeatRate, buyingCount, repeatCount, vipDist,
    };
  }, [branchId]);

  // ── RENDER ──

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'sales', label: 'SALES', icon: <TrendingUp size={14} /> },
    { key: 'stock', label: 'STOCK', icon: <Package size={14} /> },
    { key: 'finance', label: 'FINANCE', icon: <DollarSign size={14} /> },
    { key: 'clients', label: 'CLIENTS', icon: <Users size={14} /> },
  ];

  const statusLabels: Record<string, string> = {
    in_stock: 'In Stock',
    reserved: 'Reserved',
    offered: 'Offered',
    sold: 'Sold',
    with_agent: 'With Agent',
    in_repair: 'In Repair',
    consignment: 'Consignment',
    on_order: 'On Order',
  };

  const statusColors: Record<string, string> = {
    in_stock: '#7EAA6E',
    reserved: '#0F0F10',
    offered: '#4B5563',
    sold: '#6B9EDB',
    with_agent: '#C9896E',
    in_repair: '#AA6E6E',
    consignment: '#9B7ECB',
    on_order: '#6B7280',
  };

  const vipLabels: Record<number, string> = {
    0: 'Standard',
    1: 'Silver',
    2: 'Gold',
    3: 'Platinum',
  };

  const vipColors: Record<number, string> = {
    0: '#6B7280',
    1: '#4B5563',
    2: '#0F0F10',
    3: '#0F0F10',
  };

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10"
        style={{
          background: 'rgba(255,255,255,0.92)',
          backdropFilter: 'blur(12px)',
          borderBottom: '1px solid #E5E9EE',
        }}
      >
        <div style={{ padding: '24px 48px' }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
            <div>
              <h1 className="text-display-s" style={{ color: '#0F0F10' }}>Analytics</h1>
              <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4 }}>
                Key performance indicators and business insights
              </p>
            </div>
            <div className="flex items-center gap-2">
              <BarChart3 size={16} style={{ color: '#6B7280' }} />
              <span style={{ fontSize: 12, color: '#6B7280' }}>
                {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex items-center gap-8" style={{ marginTop: 4 }}>
            {tabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                style={tabStyle(activeTab === tab.key)}
                className="flex items-center gap-2 transition-all"
                onMouseEnter={e => {
                  if (activeTab !== tab.key) {
                    e.currentTarget.style.color = '#0F0F10';
                    e.currentTarget.style.borderColor = '#D5D9DE';
                  }
                }}
                onMouseLeave={e => {
                  if (activeTab !== tab.key) {
                    e.currentTarget.style.color = '#6B7280';
                    e.currentTarget.style.borderColor = '#E5E9EE';
                  }
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="animate-fade-in" style={{ padding: '32px 48px 64px', maxWidth: 1400 }}>

        {/* ════════════════ SALES DASHBOARD ════════════════ */}
        {activeTab === 'sales' && sales && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="TOTAL REVENUE"
                value={fmt(sales.grossRevenue)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
              <KPICard
                label="TOTAL PROFIT"
                value={fmt(sales.totalProfit)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
              <KPICard
                label="PROFIT MARGIN"
                value={pct(sales.marginPct)}
                icon={<PieChart size={16} />}
              />
              <KPICard
                label="AVG SALE VALUE"
                value={fmt(sales.avgSaleValue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Second KPI Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="OFFERS"
                value={sales.offerCount}
                unit="total offers"
                icon={<FileText size={16} />}
              />
              <KPICard
                label="INVOICES"
                value={sales.invoiceCount}
                unit="total invoices"
                icon={<FileText size={16} />}
              />
              <KPICard
                label="CLOSE RATE"
                value={pct(sales.closeRate)}
                unit="accepted / total offers"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Revenue by Category + Top Brands */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>REVENUE BY CATEGORY</SectionLabel>
                {sales.revByCat.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No sales data yet.</p>
                )}
                {sales.revByCat.map((cat, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between"
                    style={{
                      padding: '14px 0',
                      borderBottom: i < sales.revByCat.length - 1 ? '1px solid #E5E9EE' : 'none',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: (cat.color as string) || '#0F0F10',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{cat.name as string}</span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>
                        {num(cat, 'cnt')} items
                      </span>
                    </div>
                    <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>
                      {fmt(num(cat, 'revenue'))} <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
                    </span>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionLabel>TOP 5 SELLING BRANDS</SectionLabel>
                {sales.topBrands.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No sales data yet.</p>
                )}
                {sales.topBrands.map((b, i) => (
                  <RankedItem
                    key={i}
                    rank={i + 1}
                    label={b.brand as string}
                    value={`${fmt(num(b, 'revenue'))} BHD`}
                    sub={`${num(b, 'cnt')} sold`}
                  />
                ))}
              </Card>
            </div>
          </div>
        )}

        {/* ════════════════ STOCK DASHBOARD ════════════════ */}
        {activeTab === 'stock' && stock && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="STOCK VALUE (EK)"
                value={fmt(stock.totalEK)}
                unit="BHD purchase cost"
                icon={<Package size={16} />}
              />
              <KPICard
                label="STOCK VALUE (VK)"
                value={fmt(stock.totalVK)}
                unit="BHD planned sale"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label="ITEMS IN STOCK"
                value={stock.totalItems}
                unit="products"
                icon={<Package size={16} />}
              />
              <KPICard
                label="EXPECTED MARGIN"
                value={fmt(stock.totalVK - stock.totalEK)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Second Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="SLOW MOVERS"
                value={stock.slowCount}
                unit="> 90 days in stock"
                icon={<Clock size={16} />}
              />
              <KPICard
                label="AVG DAYS IN STOCK"
                value={fmtDec(stock.avgDaysInStock, 0)}
                unit="days"
                icon={<Clock size={16} />}
              />
              <KPICard
                label="POTENTIAL PROFIT"
                value={pct(safeDiv(stock.totalVK - stock.totalEK, stock.totalEK) * 100)}
                unit="margin on current stock"
                icon={<PieChart size={16} />}
              />
            </div>

            {/* By Category + By Status */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>ITEMS BY CATEGORY</SectionLabel>
                {stock.byCat.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No stock data.</p>
                )}
                {stock.byCat.map((cat, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between"
                    style={{
                      padding: '14px 0',
                      borderBottom: i < stock.byCat.length - 1 ? '1px solid #E5E9EE' : 'none',
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="rounded-full"
                        style={{
                          width: 8,
                          height: 8,
                          background: (cat.color as string) || '#0F0F10',
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ fontSize: 14, color: '#0F0F10' }}>{cat.name as string}</span>
                      <span className="font-mono" style={{ fontSize: 12, color: '#6B7280' }}>
                        {num(cat, 'cnt')} items
                      </span>
                    </div>
                    <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>
                      {fmt(num(cat, 'value'))} <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
                    </span>
                  </div>
                ))}
              </Card>

              <Card>
                <SectionLabel>STATUS BREAKDOWN</SectionLabel>
                {stock.byStatus.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No products.</p>
                )}
                {stock.byStatus.map((s, i) => {
                  const status = s.stock_status as string;
                  const count = num(s, 'cnt');
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between"
                      style={{
                        padding: '14px 0',
                        borderBottom: i < stock.byStatus.length - 1 ? '1px solid #E5E9EE' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="rounded-full"
                          style={{
                            width: 8,
                            height: 8,
                            background: statusColors[status] || '#6B7280',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: 14, color: '#0F0F10' }}>
                          {statusLabels[status] || status}
                        </span>
                      </div>
                      <span className="font-mono" style={{ fontSize: 14, color: statusColors[status] || '#0F0F10' }}>
                        {count}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </div>
          </div>
        )}

        {/* ════════════════ FINANCE DASHBOARD ════════════════ */}
        {activeTab === 'finance' && finance && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="NET REVENUE"
                value={fmt(finance.netRevenue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label="GROSS REVENUE"
                value={fmt(finance.grossRevenue)}
                unit="BHD incl. VAT"
                icon={<DollarSign size={16} />}
              />
              <KPICard
                label="TOTAL VAT"
                value={fmt(finance.totalVat)}
                unit="BHD collected"
                icon={<FileText size={16} />}
              />
              <KPICard
                label="PROFIT AFTER VAT"
                value={fmt(finance.profitAfterVat)}
                unit="BHD"
                icon={<TrendingUp size={16} />}
              />
            </div>

            {/* Invoice Status Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="OPEN INVOICES"
                value={finance.openCount}
                unit={`${fmt(finance.openValue)} BHD outstanding`}
                icon={<Clock size={16} />}
              />
              <KPICard
                label="PAID INVOICES"
                value={finance.paidCount}
                unit={`${fmt(finance.paidValue)} BHD collected`}
                icon={<FileText size={16} />}
              />
              <KPICard
                label="OUTSTANDING"
                value={fmt(finance.outstandingPayments)}
                unit="BHD owed to you"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Revenue Streams */}
            <Card>
              <SectionLabel>REVENUE STREAMS</SectionLabel>
              <TableRow
                label="Product Sales (Net)"
                value={`${fmt(finance.netRevenue)} BHD`}
                color="#0F0F10"
              />
              <TableRow
                label="Repair Revenue"
                value={`${fmt(finance.repairRevenue)} BHD`}
                color="#0F0F10"
              />
              <TableRow
                label="Consignment Commissions"
                value={`${fmt(finance.consignmentComm)} BHD`}
                color="#7EAA6E"
              />
              <TableRow
                label="Approval Commissions (Paid Out)"
                value={`${fmt(finance.agentCommTotal)} BHD`}
                color="#AA6E6E"
              />
              <TableRow
                label="VAT Collected"
                value={`${fmt(finance.totalVat)} BHD`}
                color="#4B5563"
                borderBottom={false}
              />
            </Card>

            {/* ═══ CASHFLOW ═══ */}
            <div style={{ marginTop: 32 }}>
              <h2 className="font-display" style={{ fontSize: 20, color: '#0F0F10', marginBottom: 16 }}>Cashflow</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, marginBottom: 20 }}>
                <KPICard
                  label="CASH BALANCE"
                  value={fmtDec(finance.cashBalance, 2)}
                  unit="BHD on hand"
                  icon={<Wallet size={16} />}
                />
                <KPICard
                  label="BANK BALANCE"
                  value={fmtDec(finance.bankBalance, 2)}
                  unit="BHD (incl. cards net of fees)"
                  icon={<Building2 size={16} />}
                />
                <KPICard
                  label="TOTAL LIQUID"
                  value={fmtDec(finance.totalLiquid, 2)}
                  unit="BHD available"
                  icon={<DollarSign size={16} />}
                />
              </div>

              <Card>
                <SectionLabel>CASH &amp; BANK BREAKDOWN</SectionLabel>
                {(finance.openingCash > 0 || finance.openingBank > 0) && (
                  <TableRow label="Opening balance (cash + bank)" value={`${fmtDec(finance.openingCash + finance.openingBank, 2)} BHD`} color="#4B5563" />
                )}
                <TableRow label="Cash received (invoices)" value={`${fmtDec(finance.cashReceived, 2)} BHD`} color="#0F0F10" />
                <TableRow label="Bank transfers received" value={`${fmtDec(finance.bankReceived, 2)} BHD`} color="#0F0F10" />
                <TableRow label="Card payments received (gross)" value={`${fmtDec(finance.cardReceived, 2)} BHD`} color="#4B5563" />
                <TableRow label={`Card processing fees (${fmtDec(finance.cardFeeRate, 2)}%)`} value={`- ${fmtDec(finance.cardFeeLost, 2)} BHD`} color="#AA6E6E" />
                <TableRow label="Card → Bank (net)" value={`${fmtDec(finance.cardNetToBank, 2)} BHD`} color="#7EAA6E" />
                {finance.cryptoReceived > 0 && <TableRow label="Crypto received" value={`${fmtDec(finance.cryptoReceived, 2)} BHD`} color="#4B5563" />}
                {(finance.productEkCash + finance.productEkBank) > 0 && <TableRow label="Product purchases (EK paid out, manual)" value={`- ${fmtDec(finance.productEkCash + finance.productEkBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.purchasePaidCash + finance.purchasePaidBank) > 0 && <TableRow label="Supplier payments (Purchases module)" value={`- ${fmtDec(finance.purchasePaidCash + finance.purchasePaidBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.expenseCash + finance.expenseBank) > 0 && <TableRow label="Operating expenses" value={`- ${fmtDec(finance.expenseCash + finance.expenseBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.purchaseRefundCash + finance.purchaseRefundBank) > 0 && <TableRow label="Supplier refunds (Purchase returns)" value={`+ ${fmtDec(finance.purchaseRefundCash + finance.purchaseRefundBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.salesRefundCash + finance.salesRefundBank) > 0 && <TableRow label="Customer refunds (Sales returns)" value={`- ${fmtDec(finance.salesRefundCash + finance.salesRefundBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.partnerInvestCash + finance.partnerInvestBank) > 0 && <TableRow label="Partner investments (in)" value={`+ ${fmtDec(finance.partnerInvestCash + finance.partnerInvestBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.partnerWithdrawCash + finance.partnerWithdrawBank) > 0 && <TableRow label="Partner withdrawals / profit share (out)" value={`- ${fmtDec(finance.partnerWithdrawCash + finance.partnerWithdrawBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.cashToBank + finance.bankToCash) > 0 && <TableRow label="Internal Cash↔Bank transfers" value={`${fmtDec(finance.cashToBank + finance.bankToCash, 2)} BHD (neutral)`} color="#6B7280" />}
                {(finance.repairCashIn + finance.repairBankIn) > 0 && <TableRow label="Repair charges received" value={`+ ${fmtDec(finance.repairCashIn + finance.repairBankIn, 2)} BHD`} color="#7EAA6E" />}
                {(finance.repairCashOut + finance.repairBankOut) > 0 && <TableRow label="Repair internal costs paid" value={`- ${fmtDec(finance.repairCashOut + finance.repairBankOut, 2)} BHD`} color="#AA6E6E" />}
                {(finance.consignSaleCash + finance.consignSaleBank) > 0 && <TableRow label="Consignment sales received" value={`+ ${fmtDec(finance.consignSaleCash + finance.consignSaleBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.consignPayoutCash + finance.consignPayoutBank) > 0 && <TableRow label="Consignment payouts to consignors" value={`- ${fmtDec(finance.consignPayoutCash + finance.consignPayoutBank, 2)} BHD`} color="#AA6E6E" />}
                {(finance.agentSettleCash + finance.agentSettleBank) > 0 && <TableRow label="Agent settlements received" value={`+ ${fmtDec(finance.agentSettleCash + finance.agentSettleBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.orderDepositCash + finance.orderDepositBank) > 0 && <TableRow label="Order deposits (pre-invoice)" value={`+ ${fmtDec(finance.orderDepositCash + finance.orderDepositBank, 2)} BHD`} color="#7EAA6E" />}
                {finance.taxPaidTotal > 0 && <TableRow label="Quarterly tax paid (outflow)" value={`- ${fmtDec(finance.taxPaidTotal, 2)} BHD`} color="#AA6E6E" />}
                {(finance.lentOutCash + finance.lentOutBank) > 0 && <TableRow label="Lent out (debts to us)" value={`- ${fmtDec(finance.lentOutCash + finance.lentOutBank, 2)} BHD`} color="#AA956E" />}
                {(finance.debtRepaidToUsCash + finance.debtRepaidToUsBank) > 0 && <TableRow label="Debt repaid to us" value={`+ ${fmtDec(finance.debtRepaidToUsCash + finance.debtRepaidToUsBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.borrowedInCash + finance.borrowedInBank) > 0 && <TableRow label="Borrowed in" value={`+ ${fmtDec(finance.borrowedInCash + finance.borrowedInBank, 2)} BHD`} color="#7EAA6E" />}
                {(finance.debtRepaidByUsCash + finance.debtRepaidByUsBank) > 0 && <TableRow label="Repaid by us" value={`- ${fmtDec(finance.debtRepaidByUsCash + finance.debtRepaidByUsBank, 2)} BHD`} color="#AA6E6E" borderBottom={false} />}
              </Card>
            </div>

            {/* ═══ QUARTERLY TAX ═══ */}
            <div style={{ marginTop: 32 }}>
              <h2 className="font-display" style={{ fontSize: 20, color: '#0F0F10', marginBottom: 16 }}>Quarterly VAT</h2>
              <Card>
                <SectionLabel>VAT PER QUARTER — FROM NON-BUTTERFLY INVOICES</SectionLabel>
                {finance.quarterly.length === 0 && (
                  <p style={{ padding: 24, textAlign: 'center', fontSize: 13, color: '#6B7280' }}>No VAT-relevant invoices yet.</p>
                )}
                {finance.quarterly.map(q => {
                  const remaining = q.vat - q.paid;
                  const isSettled = remaining <= 0.01;
                  return (
                    <div key={`${q.year}-${q.quarter}`}
                      className="flex items-center justify-between"
                      style={{ padding: '14px 0', borderBottom: '1px solid #E5E9EE', gap: 16 }}>
                      <div className="flex items-center gap-3" style={{ flex: 1 }}>
                        {isSettled ? <CheckCircle2 size={16} style={{ color: '#7EAA6E' }} /> : <Clock size={16} style={{ color: '#AA956E' }} />}
                        <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{q.year} · Q{q.quarter}</span>
                      </div>
                      <div className="flex items-center gap-6">
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>VAT OWED</span>
                          <span className="font-mono" style={{ fontSize: 14, color: '#4B5563' }}>{fmtDec(q.vat, 2)}</span>
                        </div>
                        <div className="text-right">
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>PAID</span>
                          <span className="font-mono" style={{ fontSize: 14, color: q.paid > 0 ? '#7EAA6E' : '#6B7280' }}>{fmtDec(q.paid, 2)}</span>
                        </div>
                        <div className="text-right" style={{ minWidth: 90 }}>
                          <span style={{ fontSize: 11, color: '#6B7280', display: 'block' }}>REMAINING</span>
                          <span className="font-mono" style={{ fontSize: 14, color: isSettled ? '#7EAA6E' : '#AA6E6E' }}>{fmtDec(Math.max(0, remaining), 2)}</span>
                        </div>
                        {!isSettled && (
                          <button
                            onClick={() => setTaxPayQuarter(q)}
                            className="cursor-pointer"
                            style={{ padding: '6px 14px', fontSize: 11, background: 'rgba(15,15,16,0.08)', border: '1px solid rgba(198,163,109,0.3)', borderRadius: 6, color: '#0F0F10' }}
                          >Mark paid</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* VAT Export */}
            <div style={{ marginTop: 20 }}>
              <button
                onClick={() => {
                  const rows = qry(
                    `SELECT i.invoice_number, i.created_at, i.net_amount, i.vat_amount, i.gross_amount, i.tax_scheme_snapshot, i.margin_snapshot, i.purchase_price_snapshot, i.sale_price_snapshot, i.status,
                            c.first_name || ' ' || c.last_name as customer_name
                     FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
                     WHERE i.branch_id = ? AND i.status = 'FINAL' ORDER BY i.created_at DESC`,
                    [branchId]
                  );
                  const header = 'Invoice,Date,Customer,Status,Tax Scheme,Net Amount,VAT Amount,Gross Amount,Purchase Price,Sale Price,Margin';
                  const csvRows = rows.map(r => [
                    r.invoice_number, (r.created_at as string).split('T')[0],
                    (r.customer_name as string || '').replace(/,/g, ' '), r.status, r.tax_scheme_snapshot,
                    (r.net_amount as number).toFixed(3), (r.vat_amount as number).toFixed(3),
                    (r.gross_amount as number).toFixed(3),
                    ((r.purchase_price_snapshot as number) || 0).toFixed(3),
                    ((r.sale_price_snapshot as number) || 0).toFixed(3),
                    ((r.margin_snapshot as number) || 0).toFixed(3),
                  ].join(','));

                  // Line-level detail
                  const lineHeader = '\n\nInvoice,Product,Tax Scheme,Unit Price,Purchase Price,Margin,VAT Rate,VAT Amount,Line Total';
                  const lineRows = qry(
                    `SELECT i.invoice_number, p.brand || ' ' || p.name as product_name,
                            il.tax_scheme, il.unit_price, il.purchase_price_snapshot, il.vat_rate, il.vat_amount, il.line_total
                     FROM invoice_lines il
                     JOIN invoices i ON i.id = il.invoice_id
                     JOIN products p ON p.id = il.product_id
                     WHERE i.branch_id = ? AND i.status = 'FINAL' ORDER BY i.created_at DESC, il.position`,
                    [branchId]
                  ).map(r => {
                    const margin = (r.tax_scheme as string) === 'MARGIN' ? (r.unit_price as number) - ((r.purchase_price_snapshot as number) || 0) : 0;
                    return [
                      r.invoice_number, (r.product_name as string).replace(/,/g, ' '),
                      r.tax_scheme, (r.unit_price as number).toFixed(3),
                      ((r.purchase_price_snapshot as number) || 0).toFixed(3),
                      margin.toFixed(3), r.vat_rate, (r.vat_amount as number).toFixed(3),
                      (r.line_total as number).toFixed(3),
                    ].join(',');
                  });

                  const csv = [header, ...csvRows, lineHeader, ...lineRows].join('\n');
                  exportCsv(`LATAIF_VAT_Report_${new Date().toISOString().split('T')[0]}.csv`, csv);
                }}
                className="cursor-pointer flex items-center gap-2 transition-colors"
                style={{ padding: '12px 20px', fontSize: 13, background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 8, color: '#4B5563' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#0F0F10'; e.currentTarget.style.color = '#0F0F10'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#E5E9EE'; e.currentTarget.style.color = '#4B5563'; }}
              >
                <FileText size={14} />
                Export VAT Report (CSV) — All Invoices with Line Details
              </button>
            </div>
          </div>
        )}

        {/* ════════════════ CLIENT DASHBOARD ════════════════ */}
        {activeTab === 'clients' && clients && (
          <div>
            {/* KPI Row */}
            <div
              className="animate-fade-in"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="TOTAL CLIENTS"
                value={clients.totalClients}
                icon={<Users size={16} />}
              />
              <KPICard
                label="ACTIVE CLIENTS"
                value={clients.activeClients}
                unit="purchased in last 180 days"
                icon={<Users size={16} />}
              />
              <KPICard
                label="DORMANT CLIENTS"
                value={clients.dormantClients}
                icon={<Users size={16} />}
              />
              <KPICard
                label="AVG CLIENT VALUE"
                value={fmt(clients.avgClientValue)}
                unit="BHD"
                icon={<DollarSign size={16} />}
              />
            </div>

            {/* Second Row */}
            <div
              style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, marginBottom: 40 }}
            >
              <KPICard
                label="REPEAT PURCHASE RATE"
                value={pct(clients.repeatRate)}
                unit={`${clients.repeatCount} of ${clients.buyingCount} buying clients`}
                icon={<TrendingUp size={16} />}
              />
              <Card>
                <SectionLabel>VIP DISTRIBUTION</SectionLabel>
                {clients.vipDist.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '12px 0' }}>No clients.</p>
                )}
                {clients.vipDist.map((v, i) => {
                  const level = num(v, 'vip_level');
                  const count = num(v, 'cnt');
                  return (
                    <div
                      key={i}
                      className="flex items-center justify-between"
                      style={{
                        padding: '10px 0',
                        borderBottom: i < clients.vipDist.length - 1 ? '1px solid #E5E9EE' : 'none',
                      }}
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className="rounded-full"
                          style={{
                            width: 8,
                            height: 8,
                            background: vipColors[level] || '#6B7280',
                            flexShrink: 0,
                          }}
                        />
                        <span style={{ fontSize: 14, color: vipColors[level] || '#0F0F10' }}>
                          {vipLabels[level] || `Level ${level}`}
                        </span>
                      </div>
                      <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{count}</span>
                    </div>
                  );
                })}
              </Card>
            </div>

            {/* Top Clients */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Card>
                <SectionLabel>TOP 5 CLIENTS BY REVENUE</SectionLabel>
                {clients.topByRev.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No client data yet.</p>
                )}
                {clients.topByRev.map((c, i) => (
                  <RankedItem
                    key={i}
                    rank={i + 1}
                    label={`${c.first_name as string} ${c.last_name as string}`}
                    value={`${fmt(num(c, 'total_revenue'))} BHD`}
                    sub={`${num(c, 'purchase_count')} purchases`}
                  />
                ))}
              </Card>

              <Card>
                <SectionLabel>TOP 5 CLIENTS BY PROFIT</SectionLabel>
                {clients.topByProfit.length === 0 && (
                  <p style={{ fontSize: 13, color: '#6B7280', padding: '24px 0' }}>No client data yet.</p>
                )}
                {clients.topByProfit.map((c, i) => (
                  <RankedItem
                    key={i}
                    rank={i + 1}
                    label={`${c.first_name as string} ${c.last_name as string}`}
                    value={`${fmt(num(c, 'total_profit'))} BHD`}
                    sub={`${num(c, 'purchase_count')} purchases`}
                    color="#7EAA6E"
                  />
                ))}
              </Card>
            </div>
          </div>
        )}
      </main>

      {/* ── Tax Payment Modal ── */}
      <Modal open={!!taxPayQuarter} onClose={() => setTaxPayQuarter(null)} title={taxPayQuarter ? `Record VAT Payment — ${taxPayQuarter.year} Q${taxPayQuarter.quarter}` : ''} width={460}>
        {taxPayQuarter && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ padding: '12px 14px', background: '#F2F7FA', borderRadius: 8, border: '1px solid #E5E9EE' }}>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>VAT owed</span>
                <span className="font-mono" style={{ color: '#4B5563' }}>{fmtDec(taxPayQuarter.vat, 2)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: '#6B7280' }}>Already paid</span>
                <span className="font-mono" style={{ color: '#7EAA6E' }}>{fmtDec(taxPayQuarter.paid, 2)} BHD</span>
              </div>
              <div className="flex justify-between" style={{ fontSize: 13, paddingTop: 6, borderTop: '1px solid #E5E9EE', marginTop: 6 }}>
                <span style={{ color: '#0F0F10' }}>Remaining</span>
                <span className="font-mono" style={{ color: '#AA6E6E' }}>{fmtDec(Math.max(0, taxPayQuarter.vat - taxPayQuarter.paid), 2)} BHD</span>
              </div>
            </div>
            <Input label="AMOUNT (BHD)" type="number" step="0.001" value={taxPayAmount} onChange={e => setTaxPayAmount(e.target.value)} />
            <Input label="PAID ON" type="date" value={taxPayDate} onChange={e => setTaxPayDate(e.target.value)} />
            <div>
              <span className="text-overline" style={{ marginBottom: 8 }}>PAID FROM</span>
              <div className="flex gap-2" style={{ marginTop: 8 }}>
                {(['bank', 'cash'] as const).map(s => (
                  <button key={s} onClick={() => setTaxPaySource(s)}
                    className="cursor-pointer rounded" style={{
                      padding: '6px 16px', fontSize: 12,
                      border: `1px solid ${taxPaySource === s ? '#0F0F10' : '#D5D9DE'}`,
                      color: taxPaySource === s ? '#0F0F10' : '#6B7280',
                      background: taxPaySource === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{s === 'bank' ? 'Bank' : 'Cash'}</button>
                ))}
              </div>
            </div>
            <Input label="REFERENCE / NOTE (optional)" value={taxPayNote} onChange={e => setTaxPayNote(e.target.value)} placeholder="NBR confirmation #, etc." />
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setTaxPayQuarter(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmTaxPayment}>Record Payment</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

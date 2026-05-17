import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pause, Play, Edit2, Wallet, Repeat, Receipt, Wrench, ShoppingCart, Send, Briefcase, RotateCcw, HandCoins } from 'lucide-react';
import { useGoBack } from '@/hooks/useGoBack';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useEmployeeStore } from '@/stores/employeeStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useRepairStore } from '@/stores/repairStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useAgentStore } from '@/stores/agentStore';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useDebtStore } from '@/stores/debtStore';
import type { Employee, EmploymentStatus } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { formatInvoiceDisplayShort } from '@/core/utils/invoiceNumber';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const STATUS_STYLE: Record<EmploymentStatus, { fg: string; bg: string; label: string }> = {
  'active':    { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)', label: 'Active' },
  'on_leave':  { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'On Leave' },
  'inactive':  { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Inactive' },
};

const PAY_STATUS_STYLE: Record<'PAID' | 'PENDING' | 'CANCELLED', { fg: string; bg: string; label: string }> = {
  'PAID':      { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',  label: 'Paid' },
  'PENDING':   { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  label: 'Open' },
  'CANCELLED': { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Cancelled' },
};

type TabKey = 'salary' | 'sales' | 'repairs' | 'purchases' | 'transfers' | 'consignments' | 'returns' | 'debts';

const PURCHASE_STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  'PAID':      { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',  label: 'Paid' },
  'PARTIAL':   { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'Partial' },
  'PENDING':   { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  label: 'Open' },
  'DRAFT':     { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Draft' },
  'CANCELLED': { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Cancelled' },
};

const TRANSFER_STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  'transferred': { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)', label: 'Transferred' },
  'sold':        { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',  label: 'Sold' },
  'returned':    { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'Returned' },
  'settled':     { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Settled' },
};

const CONSIGNMENT_STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  'active':   { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)',  label: 'Active' },
  'sold':     { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',   label: 'Sold' },
  'paid_out': { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Paid Out' },
  'returned': { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)',  label: 'Returned' },
  'expired':  { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',   label: 'Expired' },
};

const RETURN_STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  'REQUESTED':  { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'Requested' },
  'APPROVED':   { fg: '#3D7FFF', bg: 'rgba(61,127,255,0.10)', label: 'Approved' },
  'COMPLETED':  { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',  label: 'Completed' },
  'REJECTED':   { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  label: 'Rejected' },
  'CANCELLED':  { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: 'Cancelled' },
};

const DEBT_STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  'open':    { fg: '#DC2626', bg: 'rgba(220,38,38,0.08)',  label: 'Open' },
  'partial': { fg: '#FF8730', bg: 'rgba(255,135,48,0.10)', label: 'Partial' },
  'settled': { fg: '#16A34A', bg: 'rgba(22,163,74,0.10)',  label: 'Settled' },
};

export function EmployeeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const goBack = useGoBack('/employees');
  const {
    loadEmployees, getEmployee, updateEmployee, setStatus,
    getSalaryHistory, getSalaryStats, getSalesHistory, getSalesStats, getRepairsHandled,
    getPurchasesHandled, getPurchasesStats,
    getTransfersHandled, getConsignmentsHandled, getReturnsHandled, getDebtsHandled,
    employees,
  } = useEmployeeStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { repairs, loadRepairs } = useRepairStore();
  const { purchases, loadPurchases } = usePurchaseStore();
  const { transfers, loadTransfers } = useAgentStore();
  const { consignments, loadConsignments } = useConsignmentStore();
  const { returns, loadReturns } = useSalesReturnStore();
  const { debts, loadDebts } = useDebtStore();
  const [showEdit, setShowEdit] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Employee>>({});
  const [activeTab, setActiveTab] = useState<TabKey>('salary');

  useEffect(() => {
    loadEmployees(); loadInvoices(); loadRepairs(); loadPurchases();
    loadTransfers(); loadConsignments(); loadReturns(); loadDebts();
  }, [loadEmployees, loadInvoices, loadRepairs, loadPurchases, loadTransfers, loadConsignments, loadReturns, loadDebts]);

  const employee = useMemo(() => (id ? getEmployee(id) : undefined), [id, employees, getEmployee]);
  const history = useMemo(() => (id ? getSalaryHistory(id) : []), [id, employees, getSalaryHistory]);
  const stats = useMemo(() => (id ? getSalaryStats(id) : { totalGross: 0, totalPaid: 0, totalOpen: 0, monthsPaid: 0 }), [id, employees, getSalaryStats]);
  const salesHistory = useMemo(() => (id ? getSalesHistory(id) : []), [id, invoices, getSalesHistory]);
  const salesStats = useMemo(() => (id ? getSalesStats(id) : { totalRevenue: 0, totalProfit: 0, invoiceCount: 0 }), [id, invoices, getSalesStats]);
  const repairsHandled = useMemo(() => (id ? getRepairsHandled(id) : []), [id, repairs, getRepairsHandled]);
  const purchasesHandled = useMemo(() => (id ? getPurchasesHandled(id) : []), [id, purchases, getPurchasesHandled]);
  const purchasesStats = useMemo(() => (id ? getPurchasesStats(id) : { totalSpend: 0, totalPaid: 0, purchaseCount: 0 }), [id, purchases, getPurchasesStats]);
  const transfersHandled = useMemo(() => (id ? getTransfersHandled(id) : []), [id, transfers, getTransfersHandled]);
  const consignmentsHandled = useMemo(() => (id ? getConsignmentsHandled(id) : []), [id, consignments, getConsignmentsHandled]);
  const returnsHandled = useMemo(() => (id ? getReturnsHandled(id) : []), [id, returns, getReturnsHandled]);
  const debtsHandled = useMemo(() => (id ? getDebtsHandled(id) : []), [id, debts, getDebtsHandled]);

  if (!employee) {
    return (
      <PageLayout title="Employee not found">
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <p style={{ fontSize: 14, color: '#6B7280' }}>This employee does not exist or was removed.</p>
          <Button variant="ghost" onClick={() => navigate('/employees')} style={{ marginTop: 12 }}>← Back to employees</Button>
        </div>
      </PageLayout>
    );
  }

  const status = STATUS_STYLE[employee.employmentStatus];

  function startEdit() {
    setEditForm({ ...employee });
    setShowEdit(true);
  }

  function saveEdit() {
    if (!id) return;
    updateEmployee(id, editForm);
    setShowEdit(false);
  }

  return (
    <PageLayout
      title={employee.name}
      subtitle={[employee.role, status.label].filter(Boolean).join(' · ')}
      actions={
        <div className="flex gap-2">
          <Button variant="ghost" onClick={goBack}>
            <ArrowLeft size={14} /> Back
          </Button>
          {employee.employmentStatus === 'active' ? (
            <Button variant="ghost" onClick={() => setStatus(employee.id, 'on_leave')}>
              <Pause size={14} /> On Leave
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setStatus(employee.id, 'active')}>
              <Play size={14} /> Reactivate
            </Button>
          )}
          <Button variant="primary" onClick={startEdit}><Edit2 size={14} /> Edit</Button>
        </div>
      }
    >
      {/* ── Top stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        <Card>
          <span className="text-overline">BASE SALARY</span>
          <div className="font-display" style={{ fontSize: 24, color: '#0F0F10', marginTop: 6 }}>
            {employee.baseSalary != null ? <Bhd v={employee.baseSalary}/> : '—'}
            <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>BHD</span>
          </div>
          <span style={{ fontSize: 11, color: '#6B7280' }}>per month</span>
        </Card>
        <Card>
          <span className="text-overline">TOTAL PAID</span>
          <div className="font-display" style={{ fontSize: 24, color: '#16A34A', marginTop: 6 }}>
            <Bhd v={stats.totalPaid}/>
            <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>BHD</span>
          </div>
          <span style={{ fontSize: 11, color: '#6B7280' }}>{stats.monthsPaid} salary records</span>
        </Card>
        <Card>
          <span className="text-overline">OPEN</span>
          <div className="font-display" style={{ fontSize: 24, color: stats.totalOpen > 0.005 ? '#DC2626' : '#9CA3AF', marginTop: 6 }}>
            <Bhd v={stats.totalOpen}/>
            <span style={{ fontSize: 11, color: '#6B7280', marginLeft: 6 }}>BHD</span>
          </div>
          <span style={{ fontSize: 11, color: '#6B7280' }}>not yet paid</span>
        </Card>
        <Card>
          <span className="text-overline">CONTACT</span>
          <div style={{ fontSize: 13, color: '#0F0F10', marginTop: 6 }}>{employee.phone || '—'}</div>
          <div style={{ fontSize: 11, color: '#6B7280' }}>{employee.email || '—'}</div>
        </Card>
      </div>

      {/* ── Tabs ── */}
      <Card noPadding>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '6px 6px 0', borderBottom: '1px solid #E5E9EE',
        }}>
          {([
            { key: 'salary' as TabKey, label: 'Salary History', count: history.length, Icon: Wallet, color: '#715DE3' },
            { key: 'sales' as TabKey, label: 'Sales', count: salesHistory.length, Icon: Receipt, color: '#3D7FFF' },
            { key: 'repairs' as TabKey, label: 'Repairs', count: repairsHandled.length, Icon: Wrench, color: '#16A34A' },
            { key: 'purchases' as TabKey, label: 'Purchases', count: purchasesHandled.length, Icon: ShoppingCart, color: '#FF8730' },
            { key: 'transfers' as TabKey, label: 'Transfers', count: transfersHandled.length, Icon: Send, color: '#0E9F6E' },
            { key: 'consignments' as TabKey, label: 'Consignments', count: consignmentsHandled.length, Icon: Briefcase, color: '#A855F7' },
            { key: 'returns' as TabKey, label: 'Returns', count: returnsHandled.length, Icon: RotateCcw, color: '#DC2626' },
            { key: 'debts' as TabKey, label: 'Debts', count: debtsHandled.length, Icon: HandCoins, color: '#EAB308' },
          ]).map(t => {
            const active = activeTab === t.key;
            return (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className="cursor-pointer flex items-center gap-2"
                style={{
                  padding: '10px 14px', fontSize: 13,
                  background: 'none', border: 'none',
                  color: active ? '#0F0F10' : '#6B7280',
                  fontWeight: active ? 600 : 400,
                  borderBottom: active ? `2px solid ${t.color}` : '2px solid transparent',
                  marginBottom: -1,
                }}>
                <t.Icon size={13} style={{ color: t.color }} />
                {t.label}
                <span style={{ fontSize: 11, color: '#9CA3AF' }}>· {t.count}</span>
              </button>
            );
          })}
          {activeTab === 'sales' && salesStats.invoiceCount > 0 && (
            <span style={{ marginLeft: 'auto', marginRight: 14, fontSize: 11, color: '#6B7280' }}>
              Revenue <strong style={{ color: '#0F0F10' }}><Bhd v={salesStats.totalRevenue}/> BHD</strong> · Profit <strong style={{ color: '#16A34A' }}><Bhd v={salesStats.totalProfit}/> BHD</strong>
            </span>
          )}
          {activeTab === 'purchases' && purchasesStats.purchaseCount > 0 && (
            <span style={{ marginLeft: 'auto', marginRight: 14, fontSize: 11, color: '#6B7280' }}>
              Spend <strong style={{ color: '#0F0F10' }}><Bhd v={purchasesStats.totalSpend}/> BHD</strong> · Paid <strong style={{ color: '#16A34A' }}><Bhd v={purchasesStats.totalPaid}/> BHD</strong>
            </span>
          )}
        </div>

        {/* ── Salary Tab ── */}
        {activeTab === 'salary' && (
          history.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No salary expenses yet for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Create one in Expenses with category <strong>Salary</strong> and pick this employee.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'DESCRIPTION', 'AMOUNT', 'PAID', 'METHOD', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {history.map(row => {
                const ps = PAY_STATUS_STYLE[row.status];
                return (
                  <div key={row.expenseId}
                    className="cursor-pointer transition-colors"
                    onClick={() => navigate(`/expenses?focus=${row.expenseId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                      opacity: row.status === 'CANCELLED' ? 0.55 : 1,
                    }}>
                    <span className="font-mono flex items-center gap-1" style={{ fontSize: 12, color: '#0F0F10' }}>
                      {row.recurringTemplateId && <Repeat size={10} style={{ color: '#715DE3', flexShrink: 0 }} />}
                      {row.expenseNumber}
                    </span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.expenseDate)}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.description || '—'}
                    </span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.amount}/></span>
                    <span className="font-mono" style={{ fontSize: 13, color: row.paidAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={row.paidAmount}/></span>
                    <span style={{ fontSize: 12, color: '#4B5563', textTransform: 'capitalize' }}>{row.paymentMethod}</span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: ps.fg, background: ps.bg, border: `1px solid ${ps.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{ps.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}

        {/* ── Sales Tab ── */}
        {activeTab === 'sales' && (
          salesHistory.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No sales recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new invoice.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'CLIENT', 'GROSS', 'PAID', 'PROFIT', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {salesHistory.map(row => (
                <div key={row.invoiceId}
                  className="cursor-pointer transition-colors"
                  onClick={() => navigate(`/invoices/${row.invoiceId}`)}
                  onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                  onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                    gap: 12, padding: '12px 16px', alignItems: 'center',
                    borderBottom: '1px solid rgba(229,225,214,0.6)',
                  }}>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{formatInvoiceDisplayShort({ invoiceNumber: row.invoiceNumber, status: row.status, specialMark: row.specialMark })}</span>
                  <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.issuedAt)}</span>
                  <span
                    onClick={ev => { ev.stopPropagation(); navigate(`/clients/${row.customerId}`); }}
                    style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.customerName}
                  </span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.grossAmount}/></span>
                  <span className="font-mono" style={{ fontSize: 13, color: row.paidAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={row.paidAmount}/></span>
                  <span className="font-mono" style={{ fontSize: 13, color: row.margin >= 0 ? '#16A34A' : '#DC2626' }}><Bhd v={row.margin}/></span>
                  <span style={{ fontSize: 11, color: '#4B5563', textTransform: 'capitalize' }}>{row.status.toLowerCase()}</span>
                </div>
              ))}
            </>
          )
        )}

        {/* ── Repairs Tab ── */}
        {activeTab === 'repairs' && (
          repairsHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No repairs handled by this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new repair.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'RECEIVED', 'CLIENT', 'ITEM', 'CHARGE', 'PAID', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {repairsHandled.map(row => (
                <div key={row.repairId}
                  className="cursor-pointer transition-colors"
                  onClick={() => navigate(`/repairs/${row.repairId}`)}
                  onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                  onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                    gap: 12, padding: '12px 16px', alignItems: 'center',
                    borderBottom: '1px solid rgba(229,225,214,0.6)',
                  }}>
                  <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{row.repairNumber}</span>
                  <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.receivedAt)}</span>
                  <span
                    onClick={ev => { ev.stopPropagation(); navigate(`/clients/${row.customerId}`); }}
                    style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.customerName}
                  </span>
                  <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.itemDescription}
                  </span>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.chargeToCustomer}/></span>
                  <span className="font-mono" style={{ fontSize: 13, color: row.customerPaidAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={row.customerPaidAmount}/></span>
                  <span style={{ fontSize: 11, color: '#4B5563', textTransform: 'capitalize' }}>{row.status.replace(/_/g, ' ')}</span>
                </div>
              ))}
            </>
          )
        )}

        {/* ── Purchases Tab ── */}
        {activeTab === 'purchases' && (
          purchasesHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No purchases recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new purchase.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'SUPPLIER', 'TOTAL', 'PAID', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {purchasesHandled.map(row => {
                const ps = PURCHASE_STATUS_STYLE[row.status] || PURCHASE_STATUS_STYLE['DRAFT'];
                return (
                  <div key={row.purchaseId}
                    className="cursor-pointer transition-colors"
                    onClick={() => navigate(`/purchases/${row.purchaseId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.6fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                      opacity: row.status === 'CANCELLED' ? 0.55 : 1,
                    }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{row.purchaseNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.purchaseDate)}</span>
                    <span
                      onClick={ev => { ev.stopPropagation(); navigate(`/suppliers/${row.supplierId}`); }}
                      style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.supplierName}
                    </span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.totalAmount}/></span>
                    <span className="font-mono" style={{ fontSize: 13, color: row.paidAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={row.paidAmount}/></span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: ps.fg, background: ps.bg, border: `1px solid ${ps.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{ps.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}

        {/* ── Transfers Tab ── */}
        {activeTab === 'transfers' && (
          transfersHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No agent transfers recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new transfer.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'AGENT', 'ITEM', 'PRICE', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {transfersHandled.map(row => {
                const ts = TRANSFER_STATUS_STYLE[row.status] || { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: row.status };
                return (
                  <div key={row.transferId}
                    className="cursor-pointer transition-colors"
                    onClick={() => navigate(`/agents?transfer=${row.transferId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                    }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{row.transferNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.transferredAt)}</span>
                    <span
                      onClick={ev => { ev.stopPropagation(); navigate(`/agents/${row.agentId}`); }}
                      style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.agentName}
                    </span>
                    <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.productLabel}
                    </span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.agentPrice}/></span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: ts.fg, background: ts.bg, border: `1px solid ${ts.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{ts.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}

        {/* ── Consignments Tab ── */}
        {activeTab === 'consignments' && (
          consignmentsHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No consignments recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new consignment.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'CONSIGNOR', 'ITEM', 'AGREED', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {consignmentsHandled.map(row => {
                const cs = CONSIGNMENT_STATUS_STYLE[row.status] || { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: row.status };
                return (
                  <div key={row.consignmentId}
                    className="cursor-pointer transition-colors"
                    onClick={() => navigate(`/consignments/${row.consignmentId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                    }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{row.consignmentNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.agreementDate)}</span>
                    <span
                      onClick={ev => { ev.stopPropagation(); navigate(`/clients/${row.consignorId}`); }}
                      style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.consignorName}
                    </span>
                    <span style={{ fontSize: 12, color: '#4B5563', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.productLabel}
                    </span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.agreedPrice}/></span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: cs.fg, background: cs.bg, border: `1px solid ${cs.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{cs.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}

        {/* ── Returns Tab ── */}
        {activeTab === 'returns' && (
          returnsHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No sales returns recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when processing a return.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['NUMBER', 'DATE', 'CLIENT', 'INVOICE', 'AMOUNT', 'REFUND', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {returnsHandled.map(row => {
                const rs = RETURN_STATUS_STYLE[row.status] || { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: row.status };
                return (
                  <div key={row.returnId}
                    className="cursor-pointer transition-colors"
                    onClick={() => row.invoiceId && navigate(`/invoices/${row.invoiceId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                    }}>
                    <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{row.returnNumber}</span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.returnDate)}</span>
                    <span
                      onClick={ev => { ev.stopPropagation(); navigate(`/clients/${row.customerId}`); }}
                      style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.customerName}
                    </span>
                    <span className="font-mono" style={{ fontSize: 12, color: '#4B5563' }}>{row.invoiceNumber ? formatInvoiceDisplayShort({ invoiceNumber: row.invoiceNumber, status: row.invoiceStatus, specialMark: row.invoiceSpecialMark }) : '—'}</span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.totalAmount}/></span>
                    <span className="font-mono" style={{ fontSize: 13, color: row.refundAmount > 0 ? '#16A34A' : '#9CA3AF' }}><Bhd v={row.refundAmount}/></span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: rs.fg, background: rs.bg, border: `1px solid ${rs.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{rs.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}

        {/* ── Debts Tab ── */}
        {activeTab === 'debts' && (
          debtsHandled.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', fontSize: 13, color: '#6B7280' }}>
              No debts/loans recorded for this employee.
              <br />
              <span style={{ fontSize: 11 }}>Pick them as <strong>Staff</strong> when creating a new debt.</span>
            </div>
          ) : (
            <>
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                gap: 12, padding: '10px 16px', borderBottom: '1px solid #E5E9EE',
              }}>
                {['DIRECTION', 'COUNTERPARTY', 'SOURCE', 'AMOUNT', 'DUE', 'STATUS'].map(h => (
                  <span key={h} className="text-overline">{h}</span>
                ))}
              </div>
              {debtsHandled.map(row => {
                const ds = DEBT_STATUS_STYLE[row.status] || { fg: '#6B7280', bg: 'rgba(107,114,128,0.10)', label: row.status };
                const isOut = row.direction === 'we_lend' || row.direction === 'MONEY_GIVEN';
                return (
                  <div key={row.debtId}
                    className="cursor-pointer transition-colors"
                    onClick={() => navigate(`/debts?focus=${row.debtId}`)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                    onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0,0.9fr) minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                      gap: 12, padding: '12px 16px', alignItems: 'center',
                      borderBottom: '1px solid rgba(229,225,214,0.6)',
                    }}>
                    <span style={{ fontSize: 12, color: isOut ? '#DC2626' : '#16A34A' }}>{isOut ? 'We lent' : 'We borrowed'}</span>
                    <span style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.counterparty}</span>
                    <span style={{ fontSize: 12, color: '#4B5563', textTransform: 'capitalize' }}>{row.source}</span>
                    <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={row.amount}/></span>
                    <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(row.dueDate)}</span>
                    <span style={{
                      padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
                      color: ds.fg, background: ds.bg, border: `1px solid ${ds.fg}33`, whiteSpace: 'nowrap', width: 'fit-content',
                    }}>{ds.label}</span>
                  </div>
                );
              })}
            </>
          )
        )}
      </Card>

      {employee.notes && (
        <Card style={{ marginTop: 16 }}>
          <span className="text-overline">NOTES</span>
          <p style={{ fontSize: 13, color: '#0F0F10', margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{employee.notes}</p>
        </Card>
      )}

      {/* Edit Modal */}
      <Modal open={showEdit} onClose={() => setShowEdit(false)} title="Edit Employee" width={500}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 12 }}>
            <Input required label="NAME" value={editForm.name || ''} onChange={e => setEditForm({ ...editForm, name: e.target.value })} />
            <Input label="ROLE" value={editForm.role || ''} onChange={e => setEditForm({ ...editForm, role: e.target.value })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="PHONE" value={editForm.phone || ''} onChange={e => setEditForm({ ...editForm, phone: e.target.value })} />
            <Input label="EMAIL" value={editForm.email || ''} onChange={e => setEditForm({ ...editForm, email: e.target.value })} />
          </div>
          <Input label="BASE SALARY (BHD)" type="number" step="0.01"
            value={editForm.baseSalary ?? ''}
            onChange={e => setEditForm({ ...editForm, baseSalary: e.target.value ? parseFloat(e.target.value) : undefined })} />
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>STATUS</span>
            <div className="flex gap-2" style={{ marginTop: 6 }}>
              {(['active', 'on_leave', 'inactive'] as EmploymentStatus[]).map(s => {
                const active = editForm.employmentStatus === s;
                return (
                  <button key={s} onClick={() => setEditForm({ ...editForm, employmentStatus: s })}
                    className="cursor-pointer rounded"
                    style={{
                      padding: '7px 14px', fontSize: 12,
                      border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                      color: active ? '#0F0F10' : '#6B7280',
                      background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                    }}>{STATUS_STYLE[s].label}</button>
                );
              })}
            </div>
          </div>
          <Input label="NOTES" value={editForm.notes || ''} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowEdit(false)}>Cancel</Button>
            <Button variant="primary" onClick={saveEdit}>Save Changes</Button>
          </div>
        </div>
      </Modal>
    </PageLayout>
  );
}

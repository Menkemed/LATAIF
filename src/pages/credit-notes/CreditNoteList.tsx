// Credit Notes List — Storno-Rechnungen, eigene Sidebar-Page (SALES → Credit Notes).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileMinus, ExternalLink } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Card } from '@/components/ui/Card';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function CreditNoteList() {
  const navigate = useNavigate();
  const { creditNotes, loadCreditNotes } = useCreditNoteStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const [search, setSearch] = useState('');

  useEffect(() => { loadCreditNotes(); loadCustomers(); loadInvoices(); }, [loadCreditNotes, loadCustomers, loadInvoices]);

  const filtered = useMemo(() => {
    if (!search) return creditNotes;
    const q = search.toLowerCase();
    return creditNotes.filter(cn => {
      const cust = customers.find(c => c.id === cn.customerId);
      const inv = invoices.find(i => i.id === cn.invoiceId);
      const hay = `${cn.creditNoteNumber} ${inv?.invoiceNumber || ''} ${cust?.firstName || ''} ${cust?.lastName || ''} ${cust?.company || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [creditNotes, customers, invoices, search]);

  const totalCash = creditNotes.reduce((s, cn) => s + (cn.cashRefundAmount || 0), 0);
  const totalCancel = creditNotes.reduce((s, cn) => s + (cn.receivableCancelAmount || 0), 0);

  return (
    <PageLayout
      title="Credit Notes"
      subtitle={`${creditNotes.length} credit note${creditNotes.length === 1 ? '' : 's'} \u00b7 ${fmt(totalCash)} BHD cash refunded \u00b7 ${fmt(totalCancel)} BHD receivable cancelled`}
      showSearch onSearch={setSearch} searchPlaceholder="Search CN-, INV-, customer..."
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <FileMinus size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {search ? 'No credit notes match.' : 'No credit notes yet. Returns automatically generate credit notes.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <div style={{
            display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)',
            gap: 14, padding: '12px 16px', borderBottom: '1px solid #E5E9EE',
          }}>
            {['CN NUMBER', 'DATE', 'INVOICE', 'CUSTOMER', 'CASH REFUND', 'CANCELLED'].map((h, i) => (
              <span key={h} className="text-overline" style={{ display: 'block', textAlign: i >= 4 ? 'right' : 'left' }}>{h}</span>
            ))}
          </div>
          {filtered.map(cn => {
            const cust = customers.find(c => c.id === cn.customerId);
            const inv = invoices.find(i => i.id === cn.invoiceId);
            return (
              <div key={cn.id} className="cursor-pointer transition-colors"
                onClick={() => navigate(`/credit-notes/${cn.id}`)}
                style={{
                  display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr)',
                  gap: 14, padding: '14px 16px', alignItems: 'center',
                  borderBottom: '1px solid rgba(229,225,214,0.6)',
                }}
                onMouseEnter={ev => (ev.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
                onMouseLeave={ev => (ev.currentTarget.style.background = 'transparent')}>
                <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cn.creditNoteNumber}</span>
                <span style={{ fontSize: 12, color: '#4B5563' }}>{fmtDate(cn.issuedAt)}</span>
                <span className="font-mono" style={{ fontSize: 11, color: '#3D7FFF', display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inv?.invoiceNumber || cn.invoiceId.slice(0, 8)}
                  <ExternalLink size={10} style={{ opacity: 0.5 }} />
                </span>
                <span style={{ fontSize: 12, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cust ? `${cust.firstName} ${cust.lastName}`.trim() || cust.company || '\u2014' : '\u2014'}
                </span>
                <span className="font-mono" style={{ fontSize: 13, color: cn.cashRefundAmount > 0 ? '#DC2626' : '#6B7280', textAlign: 'right' }}>{fmt(cn.cashRefundAmount)}</span>
                <span className="font-mono" style={{ fontSize: 13, color: cn.receivableCancelAmount > 0 ? '#FF8730' : '#6B7280', textAlign: 'right' }}>{fmt(cn.receivableCancelAmount)}</span>
              </div>
            );
          })}
        </Card>
      )}
    </PageLayout>
  );
}

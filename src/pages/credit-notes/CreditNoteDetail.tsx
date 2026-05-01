// Credit Note Detail — eigenständige Steuerurkunde mit PDF-Export.
// Industry Standard: NBR-Bahrain VAT-konform (alle Pflichtangaben + Verweis auf Original-Invoice).
import { useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Download, Trash2, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useCreditNoteStore } from '@/stores/creditNoteStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useSalesReturnStore } from '@/stores/salesReturnStore';
import { useProductStore } from '@/stores/productStore';
import { downloadPdf } from '@/core/pdf/pdf-generator';
import { formatProductMultiLine } from '@/core/utils/product-format';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso?: string): string {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function CreditNoteDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { creditNotes, loadCreditNotes, deleteCreditNote } = useCreditNoteStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { invoices, loadInvoices } = useInvoiceStore();
  const { returns: salesReturns, loadReturns } = useSalesReturnStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();

  useEffect(() => {
    loadCreditNotes(); loadCustomers(); loadInvoices(); loadReturns();
    loadProducts(); loadCategories();
  }, [loadCreditNotes, loadCustomers, loadInvoices, loadReturns, loadProducts, loadCategories]);

  const cn = useMemo(() => creditNotes.find(x => x.id === id), [creditNotes, id]);
  const cust = useMemo(() => cn ? customers.find(c => c.id === cn.customerId) : undefined, [cn, customers]);
  const inv = useMemo(() => cn ? invoices.find(i => i.id === cn.invoiceId) : undefined, [cn, invoices]);
  const ret = useMemo(() => cn?.salesReturnId ? salesReturns.find(r => r.id === cn.salesReturnId) : undefined, [cn, salesReturns]);

  if (!cn) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ height: '100vh', background: '#FFFFFF' }}>
        <p style={{ color: '#6B7280' }}>Credit note not found</p>
      </div>
    );
  }

  function handleDownload() {
    if (!cn) return;
    const itemLines = (ret?.lines || []).map(rl => {
      const p = products.find(pp => pp.id === rl.productId);
      const desc = p ? formatProductMultiLine(p, categories) : (rl.productId || 'Item');
      return { label: desc, value: `${fmt(rl.quantity * rl.unitPrice)} BHD` };
    });
    downloadPdf({
      title: `Credit Note ${cn.creditNoteNumber}`,
      number: cn.creditNoteNumber,
      date: fmtDate(cn.issuedAt),
      subtitle: `Reference Invoice: ${inv?.invoiceNumber || cn.invoiceId}`,
      customer: cust ? { name: `${cust.firstName} ${cust.lastName}`.trim(), company: cust.company, phone: cust.phone } : undefined,
      type: 'credit_note', // eigener Type: Header-Label "CREDIT NOTE", orange Akzentfarbe
      sections: [
        ...(itemLines.length > 0 ? [{ title: 'Returned Items', lines: itemLines }] : []),
        { title: 'Settlement', lines: [
          { label: 'Total Credit', value: `${fmt(cn.totalAmount)} BHD`, bold: true },
          ...(cn.vatAmount ? [{ label: 'VAT correction', value: `${fmt(cn.vatAmount)} BHD` }] : []),
          { label: 'Cash refunded to customer', value: `${fmt(cn.cashRefundAmount)} BHD` },
          { label: 'Receivable cancelled', value: `${fmt(cn.receivableCancelAmount)} BHD` },
          ...(cn.refundMethod ? [{ label: 'Refund method', value: cn.refundMethod }] : []),
        ]},
        ...(cn.reason ? [{ title: 'Reason', lines: [{ label: cn.reason, value: '' }] }] : []),
      ],
      footer: `This Credit Note credits Invoice ${inv?.invoiceNumber || cn.invoiceId}. Original invoice remains on record.`,
    });
  }

  function handleDelete() {
    if (!cn) return;
    if (!confirm(`Delete credit note ${cn.creditNoteNumber}? This is destructive — only do this if it was created by mistake.`)) return;
    deleteCreditNote(cn.id);
    navigate('/credit-notes');
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1100 }}>
        {/* Header */}
        <div className="flex items-center justify-between" style={{ marginBottom: 32 }}>
          <button onClick={() => navigate('/credit-notes')}
            className="flex items-center gap-2 cursor-pointer transition-colors"
            style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 13 }}>
            <ArrowLeft size={16} /> Credit Notes
          </button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={handleDownload}><Download size={14} /> Download PDF</Button>
            <Button variant="ghost" onClick={handleDelete} style={{ color: '#DC2626' }}><Trash2 size={14} /> Delete</Button>
          </div>
        </div>

        {/* Hero */}
        <div className="animate-fade-in" style={{ marginBottom: 32 }}>
          <span className="text-overline" style={{ color: '#FF8730' }}>CREDIT NOTE</span>
          <h1 className="font-display" style={{ fontSize: 32, color: '#0F0F10', marginTop: 4, lineHeight: 1.1 }}>{cn.creditNoteNumber}</h1>
          <div className="flex items-center gap-3" style={{ marginTop: 8, fontSize: 13, color: '#6B7280' }}>
            <span>Issued {fmtDate(cn.issuedAt)}</span>
            <span>·</span>
            <span>Total credit <span className="font-mono" style={{ color: '#DC2626', fontWeight: 600 }}>{fmt(cn.totalAmount)} BHD</span></span>
          </div>
        </div>

        {/* KPI Row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16, marginBottom: 32 }}>
          <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
            <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>TOTAL CREDIT</span>
            <div className="font-display" style={{ fontSize: 26, color: '#0F0F10', lineHeight: 1.1 }}>
              {fmt(cn.totalAmount)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>Reverses part of original invoice</div>
          </div>
          <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
            <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>CASH REFUND</span>
            <div className="font-display" style={{ fontSize: 26, color: cn.cashRefundAmount > 0 ? '#DC2626' : '#6B7280', lineHeight: 1.1 }}>
              {fmt(cn.cashRefundAmount)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>
              {cn.refundMethod ? `Via ${cn.refundMethod}` : 'No cash flow yet'}
            </div>
          </div>
          <div style={{ padding: '20px 22px', background: '#FFFFFF', border: '1px solid #E5E9EE', borderRadius: 12 }}>
            <span className="text-overline" style={{ display: 'block', marginBottom: 8 }}>RECEIVABLE CANCELLED</span>
            <div className="font-display" style={{ fontSize: 26, color: cn.receivableCancelAmount > 0 ? '#FF8730' : '#6B7280', lineHeight: 1.1 }}>
              {fmt(cn.receivableCancelAmount)} <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
            </div>
            <div style={{ fontSize: 11, color: '#6B7280', marginTop: 8 }}>Customer no longer owes this</div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 24 }}>
          {/* Left: Items */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {ret && ret.lines.length > 0 && (
              <Card>
                <span className="text-overline" style={{ marginBottom: 16, display: 'block' }}>RETURNED ITEMS</span>
                <div>
                  {ret.lines.map(rl => {
                    const p = products.find(pp => pp.id === rl.productId);
                    return (
                      <div key={rl.id} className="flex justify-between" style={{ padding: '12px 0', borderBottom: '1px solid #E5E9EE' }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 13, color: '#0F0F10', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {p ? `${p.brand} ${p.name}` : 'Item'}
                          </div>
                          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>
                            Qty {rl.quantity} \u00d7 {fmt(rl.unitPrice)} BHD
                          </div>
                        </div>
                        <span className="font-mono" style={{ fontSize: 13, color: '#DC2626' }}>−{fmt(rl.quantity * rl.unitPrice)} BHD</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
            {cn.reason && (
              <Card>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>REASON FOR CREDIT</span>
                <p style={{ fontSize: 13, color: '#0F0F10', lineHeight: 1.6, margin: 0 }}>{cn.reason}</p>
              </Card>
            )}
            {cn.notes && (
              <Card>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>NOTES</span>
                <p style={{ fontSize: 13, color: '#4B5563', lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' }}>{cn.notes}</p>
              </Card>
            )}
          </div>

          {/* Right: Linked documents + customer */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Card>
              <span className="text-overline" style={{ marginBottom: 16, display: 'block' }}>LINKED DOCUMENTS</span>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Original Invoice</div>
                {inv ? (
                  <Link to={`/invoices/${inv.id}`} className="cursor-pointer flex items-center gap-1"
                    style={{ fontSize: 13, color: '#3D7FFF', textDecoration: 'none' }}
                    onMouseEnter={e => (e.currentTarget.style.textDecoration = 'underline')}
                    onMouseLeave={e => (e.currentTarget.style.textDecoration = 'none')}>
                    {inv.invoiceNumber}
                    <ExternalLink size={11} style={{ opacity: 0.5 }} />
                  </Link>
                ) : <span style={{ fontSize: 13, color: '#6B7280' }}>{cn.invoiceId.slice(0, 12)}\u2026</span>}
              </div>
              {ret && (
                <div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginBottom: 4 }}>Sales Return</div>
                  <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{ret.returnNumber}</span>
                </div>
              )}
            </Card>
            {cust && (
              <Card>
                <span className="text-overline" style={{ marginBottom: 16, display: 'block' }}>CUSTOMER</span>
                <Link to={`/clients/${cust.id}`} className="cursor-pointer"
                  style={{ fontSize: 14, color: '#0F0F10', textDecoration: 'none', display: 'block', marginBottom: 4 }}>
                  {cust.firstName} {cust.lastName}
                </Link>
                {cust.company && <div style={{ fontSize: 12, color: '#6B7280' }}>{cust.company}</div>}
                {cust.phone && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>{cust.phone}</div>}
                {cust.email && <div style={{ fontSize: 12, color: '#6B7280' }}>{cust.email}</div>}
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

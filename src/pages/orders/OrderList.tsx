import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ShoppingBag } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { useOrderStore } from '@/stores/orderStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { OrderStatus } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: 'Pending',
  deposit_received: 'Deposit Received',
  sourcing: 'Sourcing',
  sourced: 'Sourced',
  arrived: 'Arrived',
  notified: 'Notified',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const STATUS_FLOW: Record<OrderStatus, OrderStatus | null> = {
  pending: 'deposit_received',
  deposit_received: 'sourcing',
  sourcing: 'sourced',
  sourced: 'arrived',
  arrived: 'notified',
  notified: 'completed',
  completed: null,
  cancelled: null,
};

const FILTER_STATUSES: (OrderStatus | '')[] = ['', 'pending', 'deposit_received', 'sourcing', 'arrived', 'completed'];

export function OrderList() {
  const navigate = useNavigate();
  const { orders, loadOrders, updateStatus } = useOrderStore();
  const { categories, loadCategories, loadProducts } = useProductStore();
  const { customers, loadCustomers } = useCustomerStore();

  const [searchParams, setSearchParams] = useSearchParams();
  const [filterStatus, setFilterStatus] = useState<OrderStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => { loadOrders(); loadCustomers(); loadCategories(); loadProducts(); }, [loadOrders, loadCustomers, loadCategories, loadProducts]);

  // Pre-fill from URL — forward customer to /orders/new
  useEffect(() => {
    const customerParam = searchParams.get('customer');
    if (customerParam) {
      setSearchParams({}, { replace: true });
      navigate(`/orders/new?customer=${customerParam}`);
    }
  }, [searchParams, setSearchParams, navigate]);

  const custMap = useMemo(() => {
    const m = new Map<string, string>();
    customers.forEach(c => m.set(c.id, `${c.firstName} ${c.lastName}`));
    return m;
  }, [customers]);

  const filtered = useMemo(() => {
    let r = orders;
    if (filterStatus) r = r.filter(o => o.status === filterStatus);
    if (searchQuery) {
      r = r.filter(o => {
        const customer = customers.find(c => c.id === o.customerId);
        return matchesDeep(o, searchQuery, [customer, o.product]);
      });
    }
    return r;
  }, [orders, filterStatus, searchQuery, customers]);

  const activeCount = orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled').length;

  return (
    <PageLayout
      title="Orders"
      subtitle={`${activeCount} active order${activeCount !== 1 ? 's' : ''} \u00b7 ${orders.length} total`}
      showSearch onSearch={setSearchQuery} searchPlaceholder="Search by order #, brand, model, customer..."
      actions={
        <div className="flex items-center gap-3">
          {/* Status Filter */}
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {FILTER_STATUSES.map(s => (
              <button key={s} onClick={() => setFilterStatus(s)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${filterStatus === s ? '#0F0F10' : 'transparent'}`,
                  color: filterStatus === s ? '#0F0F10' : '#6B7280',
                  background: filterStatus === s ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{s === '' ? 'All' : STATUS_LABELS[s]}</button>
            ))}
          </div>
          <Button variant="primary" onClick={() => navigate('/orders/new')}>New Order</Button>
        </div>
      }
    >
      {filtered.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <ShoppingBag size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterStatus ? 'No orders match your filters.' : 'No orders yet.'}
          </p>
        </div>
      ) : (
        <Card noPadding>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E1D6' }}>
                {['Order #', 'Customer', 'Requested Item', 'Agreed Price', 'Deposit', 'Remaining', 'Status', ''].map(h => (
                  <th key={h} style={{
                    padding: '14px 18px', fontSize: 11, fontWeight: 500, letterSpacing: '0.06em',
                    color: '#6B7280', textAlign: 'left', textTransform: 'uppercase',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map(order => {
                const next = STATUS_FLOW[order.status];
                return (
                  <tr key={order.id}
                    className="cursor-pointer"
                    style={{ borderBottom: '1px solid #E5E1D6' }}
                    onClick={() => navigate(`/orders/${order.id}`)}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.015)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Order Number */}
                    <td style={{ padding: '16px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                        {order.orderNumber}
                      </span>
                    </td>

                    {/* Customer */}
                    <td style={{ padding: '16px 18px' }}>
                      <span style={{ fontSize: 13, color: '#0F0F10' }}>
                        {custMap.get(order.customerId) || '\u2014'}
                      </span>
                    </td>

                    {/* Requested Item */}
                    <td style={{ padding: '16px 18px' }}>
                      <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                        {(() => {
                          const cat = categories.find(c => c.id === order.categoryId);
                          if (!cat) return null;
                          return (
                            <span style={{
                              fontSize: 9, padding: '2px 8px', borderRadius: 999,
                              background: cat.color + '15', color: cat.color, border: `1px solid ${cat.color}30`,
                              textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 500,
                            }}>{cat.name}</span>
                          );
                        })()}
                        <span style={{ fontSize: 13, color: '#0F0F10' }}>
                          {order.requestedBrand} {order.requestedModel}
                        </span>
                      </div>
                      {order.requestedReference && (
                        <span className="font-mono" style={{ fontSize: 11, color: '#6B7280', display: 'block', marginTop: 2 }}>
                          {order.requestedReference}
                        </span>
                      )}
                    </td>

                    {/* Agreed Price */}
                    <td style={{ padding: '16px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                        {order.agreedPrice ? `${fmt(order.agreedPrice)} BHD` : '\u2014'}
                      </span>
                    </td>

                    {/* Deposit */}
                    <td style={{ padding: '16px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: order.depositPaid ? '#7EAA6E' : '#AA956E' }}>
                        {order.depositAmount ? `${fmt(order.depositAmount)} BHD` : '\u2014'}
                      </span>
                    </td>

                    {/* Remaining */}
                    <td style={{ padding: '16px 18px' }}>
                      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>
                        {order.remainingAmount != null ? `${fmt(order.remainingAmount)} BHD` : '\u2014'}
                      </span>
                    </td>

                    {/* Status */}
                    <td style={{ padding: '16px 18px' }}>
                      <StatusDot status={order.status} />
                    </td>

                    {/* Action */}
                    <td style={{ padding: '16px 18px', textAlign: 'right' }}>
                      {next && (
                        <button
                          onClick={(e) => { e.stopPropagation(); updateStatus(order.id, next); }}
                          className="cursor-pointer transition-all duration-200"
                          style={{
                            padding: '5px 14px', fontSize: 11, borderRadius: 999,
                            border: '1px solid #D5D1C4', color: '#4B5563',
                            background: 'transparent', whiteSpace: 'nowrap',
                          }}
                          onMouseEnter={e => {
                            e.currentTarget.style.borderColor = '#0F0F10';
                            e.currentTarget.style.color = '#0F0F10';
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.borderColor = '#D5D1C4';
                            e.currentTarget.style.color = '#4B5563';
                          }}
                        >
                          {STATUS_LABELS[next]} &rarr;
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </PageLayout>
  );
}

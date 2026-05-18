// Plan §Scrap Gold Quick Trade — geteiltes Multi-Line-Formular für Create + Edit (v2: split-payments).
//
// Form-Sections:
//   A. Seller (Name + Phone + optional Customer-Link + Date)
//   B. Items (dynamische Liste: jedes Item mit Weight + Karat + Purchase +
//             Sale + Profit + per-item Photos + Notes)
//   C. Buyer (Name + Phone + optional Supplier-Link)
//   D. Total + Payment Methods
//   E. Trade Notes (optional, trade-weit)
//   F. Actions

import { useEffect, useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Link2, Plus, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Bhd } from '@/components/ui/Bhd';
import { ImageUpload } from '@/components/ui/ImageUpload';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useCustomerStore } from '@/stores/customerStore';
import { useSupplierStore } from '@/stores/supplierStore';
import type { ScrapTrade, ScrapPaymentMethod } from '@/core/models/types';
import type { ScrapTradeInput, ScrapTradeLineInput, ScrapTradePaymentInput } from '@/stores/scrapTradeStore';

interface ScrapTradeFormProps {
  initial?: ScrapTrade;
  submitLabel: string;
  onSubmit: (values: ScrapTradeInput) => void;
  onCancel: () => void;
  disabled?: boolean;
}

const KARAT_OPTIONS = ['24K', '22K', '21K', '18K', '14K', '9K'];

const PAYMENT_METHODS: { value: ScrapPaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank' },
  { value: 'benefit', label: 'Benefit' },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyLine(): ScrapTradeLineInput {
  return {
    weightGrams: 0,
    karat: '22K',
    purchasePrice: 0,
    salePrice: 0,
    notes: '',
    imagesPurchase: [],
    imagesSale: [],
  };
}

export function ScrapTradeForm({ initial, submitLabel, onSubmit, onCancel, disabled = false }: ScrapTradeFormProps) {
  const { customers, loadCustomers } = useCustomerStore();
  const { suppliers, loadSuppliers } = useSupplierStore();

  const [linkSeller, setLinkSeller] = useState(!!initial?.sellerCustomerId);
  const [linkBuyer, setLinkBuyer] = useState(!!initial?.buyerSupplierId);
  const [error, setError] = useState<string | null>(null);

  const [v, setV] = useState<ScrapTradeInput>(() => ({
    sellerName: initial?.sellerName || '',
    sellerPhone: initial?.sellerPhone || '',
    sellerCustomerId: initial?.sellerCustomerId,
    buyerName: initial?.buyerName || '',
    buyerPhone: initial?.buyerPhone || '',
    buyerSupplierId: initial?.buyerSupplierId,
    tradeDate: initial?.tradeDate ? initial.tradeDate.slice(0, 10) : todayIso(),
    notes: initial?.notes || '',
    lines: initial?.lines?.length
      ? initial.lines.map(l => ({
          weightGrams: l.weightGrams,
          karat: l.karat,
          purchasePrice: l.purchasePrice,
          salePrice: l.salePrice,
          notes: l.notes || '',
          imagesPurchase: l.imagesPurchase,
          imagesSale: l.imagesSale,
        }))
      : [emptyLine()],
    paymentsOut: initial?.paymentsOut?.length
      ? initial.paymentsOut.map(p => ({ method: p.method, amount: p.amount }))
      : [{ method: 'cash', amount: 0 }],
    paymentsIn: initial?.paymentsIn?.length
      ? initial.paymentsIn.map(p => ({ method: p.method, amount: p.amount }))
      : [{ method: 'cash', amount: 0 }],
  }));

  useEffect(() => { loadCustomers(); loadSuppliers(); }, [loadCustomers, loadSuppliers]);

  const customerOptions = useMemo(() => customers.map(c => ({
    id: c.id,
    label: `${c.firstName} ${c.lastName}`.trim() || '(unnamed)',
    subtitle: c.phone || c.email || '',
    meta: c.customerType || '',
  })), [customers]);

  const supplierOptions = useMemo(() => suppliers
    .filter(s => s.active)
    .map(s => ({ id: s.id, label: s.name, subtitle: s.phone || '', meta: s.email || '' })),
    [suppliers]);

  // Aggregates live computed
  const totals = useMemo(() => {
    const weight = v.lines.reduce((s, l) => s + (Number(l.weightGrams) || 0), 0);
    const purchase = v.lines.reduce((s, l) => s + (Number(l.purchasePrice) || 0), 0);
    const sale = v.lines.reduce((s, l) => s + (Number(l.salePrice) || 0), 0);
    return { weight, purchase, sale, profit: sale - purchase };
  }, [v.lines]);

  function patch<K extends keyof ScrapTradeInput>(key: K, value: ScrapTradeInput[K]) {
    setV(prev => ({ ...prev, [key]: value }));
  }

  function patchLine(idx: number, updater: (line: ScrapTradeLineInput) => ScrapTradeLineInput) {
    setV(prev => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === idx ? updater(l) : l)),
    }));
  }

  function addLine() {
    setV(prev => ({ ...prev, lines: [...prev.lines, emptyLine()] }));
  }

  function removeLine(idx: number) {
    setV(prev => ({
      ...prev,
      lines: prev.lines.length > 1 ? prev.lines.filter((_, i) => i !== idx) : prev.lines,
    }));
  }

  function handleSubmit() {
    setError(null);
    if (!v.sellerName.trim()) { setError('Seller name is required'); return; }
    if (!v.buyerName.trim()) { setError('Buyer name is required'); return; }
    if (!v.tradeDate) { setError('Trade date is required'); return; }
    if (v.lines.length === 0) { setError('Add at least one item'); return; }
    for (let i = 0; i < v.lines.length; i++) {
      const l = v.lines[i];
      if (!(l.weightGrams > 0)) { setError(`Item ${i + 1}: weight must be > 0`); return; }
      if (!l.karat.trim()) { setError(`Item ${i + 1}: karat is required`); return; }
      if (!(l.purchasePrice >= 0)) { setError(`Item ${i + 1}: purchase price must be ≥ 0`); return; }
      if (!(l.salePrice >= 0)) { setError(`Item ${i + 1}: sale price must be ≥ 0`); return; }
    }

    // Validate split-payments sums match totals
    const sumOut = v.paymentsOut.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    const sumIn = v.paymentsIn.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (Math.abs(sumOut - totals.purchase) > 0.001) {
      setError(`Payment OUT total (${sumOut.toFixed(3)}) must equal Purchase total (${totals.purchase.toFixed(3)})`);
      return;
    }
    if (Math.abs(sumIn - totals.sale) > 0.001) {
      setError(`Payment IN total (${sumIn.toFixed(3)}) must equal Sale total (${totals.sale.toFixed(3)})`);
      return;
    }
    for (const p of [...v.paymentsOut, ...v.paymentsIn]) {
      if (!(Number(p.amount) > 0)) { setError('Each payment split must have amount > 0'); return; }
    }

    onSubmit(v);
  }

  const profitColor = totals.profit > 0 ? '#16A34A' : totals.profit < 0 ? '#DC2626' : '#6B7280';
  const ProfitIcon = totals.profit > 0 ? TrendingUp : totals.profit < 0 ? TrendingDown : null;

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 16 }}>
      {/* A. Seller Section */}
      <Card>
        <SectionHeader title="A. Seller" subtitle="Wer verkauft uns das Gold?" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <Input
            label="Seller / Customer"
            required
            value={v.sellerName}
            onChange={e => patch('sellerName', e.target.value)}
            disabled={disabled}
          />
          <Input
            label="Phone"
            value={v.sellerPhone || ''}
            onChange={e => patch('sellerPhone', e.target.value)}
            disabled={disabled}
          />
          <Input
            label="Trade Date"
            type="date"
            required
            value={v.tradeDate}
            onChange={e => patch('tradeDate', e.target.value)}
            disabled={disabled}
          />
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6B7280', cursor: disabled ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={linkSeller}
              onChange={e => {
                setLinkSeller(e.target.checked);
                if (!e.target.checked) patch('sellerCustomerId', undefined);
              }}
              disabled={disabled}
            />
            <Link2 size={12} /> Link to existing Customer
          </label>
          {linkSeller && (
            <div style={{ marginTop: 8, maxWidth: 480 }}>
              <SearchSelect
                placeholder="Search customer..."
                options={customerOptions}
                value={v.sellerCustomerId || ''}
                onChange={id => patch('sellerCustomerId', id || undefined)}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </Card>

      {/* B. Items */}
      <Card>
        <SectionHeader title="B. Items" subtitle="Goldstücke einzeln auflisten. Foto pro Item separat." />
        <div style={{ display: 'grid', gap: 16 }}>
          {v.lines.map((line, idx) => (
            <LineEditor
              key={idx}
              line={line}
              index={idx}
              canRemove={v.lines.length > 1}
              onPatch={updater => patchLine(idx, updater)}
              onRemove={() => removeLine(idx)}
              disabled={disabled}
            />
          ))}
        </div>
        {!disabled && (
          <div style={{ marginTop: 14 }}>
            <Button variant="secondary" icon={<Plus size={14} />} onClick={addLine}>
              Add Item
            </Button>
          </div>
        )}
      </Card>

      {/* C. Buyer Section */}
      <Card>
        <SectionHeader title="C. Buyer" subtitle="An wen verkaufen wir das Gold weiter?" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          <Input
            label="Buyer / Dealer"
            required
            value={v.buyerName}
            onChange={e => patch('buyerName', e.target.value)}
            disabled={disabled}
          />
          <Input
            label="Phone"
            value={v.buyerPhone || ''}
            onChange={e => patch('buyerPhone', e.target.value)}
            disabled={disabled}
          />
          <div />
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6B7280', cursor: disabled ? 'not-allowed' : 'pointer' }}>
            <input
              type="checkbox"
              checked={linkBuyer}
              onChange={e => {
                setLinkBuyer(e.target.checked);
                if (!e.target.checked) patch('buyerSupplierId', undefined);
              }}
              disabled={disabled}
            />
            <Link2 size={12} /> Link to existing Supplier
          </label>
          {linkBuyer && (
            <div style={{ marginTop: 8, maxWidth: 480 }}>
              <SearchSelect
                placeholder="Search supplier..."
                options={supplierOptions}
                value={v.buyerSupplierId || ''}
                onChange={id => patch('buyerSupplierId', id || undefined)}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </Card>

      {/* D. Totals + Split Payments */}
      <Card>
        <SectionHeader title="D. Payments" subtitle="Mehrere Beträge mit verschiedenen Methoden möglich. Sum muss zum jeweiligen Total passen." />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <SplitPaymentEditor
            label="Payment Out (to Seller)"
            splits={v.paymentsOut}
            target={totals.purchase}
            onChange={splits => patch('paymentsOut', splits)}
            disabled={disabled}
          />
          <SplitPaymentEditor
            label="Payment In (from Buyer)"
            splits={v.paymentsIn}
            target={totals.sale}
            onChange={splits => patch('paymentsIn', splits)}
            disabled={disabled}
          />
        </div>

        {/* Totals + Profit Display */}
        <div
          style={{
            marginTop: 22, padding: '18px 22px',
            borderRadius: 12,
            background: totals.profit > 0 ? 'rgba(22,163,74,0.06)' : totals.profit < 0 ? 'rgba(220,38,38,0.06)' : '#F2F7FA',
            border: `1px solid ${totals.profit > 0 ? 'rgba(22,163,74,0.20)' : totals.profit < 0 ? 'rgba(220,38,38,0.20)' : '#E5E9EE'}`,
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr) auto', gap: 18, alignItems: 'center' }}>
            <TotalCell label="Total Weight" value={`${totals.weight.toFixed(2)} g`} />
            <TotalCell label="Total Purchase" valueBhd={totals.purchase} />
            <TotalCell label="Total Sale" valueBhd={totals.sale} />
            <TotalCell label={`${v.lines.length} Item${v.lines.length === 1 ? '' : 's'}`} value="" />
            <div style={{ textAlign: 'right' }}>
              <div className="text-overline" style={{ marginBottom: 4 }}>Profit / Spread</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: profitColor, fontSize: 30, fontWeight: 700, justifyContent: 'flex-end' }}>
                {ProfitIcon && <ProfitIcon size={24} />}
                <Bhd v={totals.profit} />
                <span style={{ fontSize: 14, fontWeight: 500, color: '#6B7280' }}>BHD</span>
              </div>
            </div>
          </div>
          {totals.profit < 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#DC2626' }}>
              This trade is a loss — booked as operating expense.
            </div>
          )}
        </div>
      </Card>

      {/* E. Trade Notes */}
      <Card>
        <SectionHeader title="E. Notes (optional)" subtitle="Anmerkungen zum gesamten Trade (item-spezifisch siehe pro Item)." />
        <textarea
          value={v.notes || ''}
          onChange={e => patch('notes', e.target.value)}
          disabled={disabled}
          rows={3}
          style={{
            width: '100%', resize: 'vertical',
            background: 'transparent', borderBottom: '1px solid #D5D9DE',
            padding: '8px 0', fontSize: 14, color: '#0F0F10',
            outline: 'none', fontFamily: 'inherit',
          }}
        />
      </Card>

      {/* F. Actions */}
      {!disabled && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div>
            {error && (
              <div style={{ color: '#DC2626', fontSize: 13, fontWeight: 500 }}>{error}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button variant="secondary" onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={handleSubmit}>{submitLabel}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-Components ────────────────────────────────────────────────

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12, color: '#6B7280', marginTop: 2 }}>{subtitle}</div>}
    </div>
  );
}

function TotalCell({ label, value, valueBhd }: { label: string; value?: string; valueBhd?: number }) {
  return (
    <div>
      <div className="text-overline" style={{ marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
        {valueBhd !== undefined ? <Bhd v={valueBhd} /> : value}
      </div>
    </div>
  );
}

function SplitPaymentEditor({
  label, splits, target, onChange, disabled,
}: {
  label: string;
  splits: ScrapTradePaymentInput[];
  target: number;
  onChange: (splits: ScrapTradePaymentInput[]) => void;
  disabled: boolean;
}) {
  const sum = useMemo(() => splits.reduce((s, p) => s + (Number(p.amount) || 0), 0), [splits]);
  const remaining = Math.round((target - sum) * 1000) / 1000;
  const mismatch = Math.abs(remaining) > 0.001;

  function patchSplit(idx: number, key: keyof ScrapTradePaymentInput, value: any) {
    onChange(splits.map((s, i) => (i === idx ? { ...s, [key]: value } : s)));
  }
  function addSplit() {
    // Neuer Split bekommt automatisch den verbleibenden Betrag, falls > 0
    onChange([
      ...splits,
      { method: 'cash', amount: remaining > 0 ? remaining : 0 },
    ]);
  }
  function removeSplit(idx: number) {
    if (splits.length <= 1) return;
    onChange(splits.filter((_, i) => i !== idx));
  }
  function autofillFirst() {
    // Convenience: setze den ersten Split auf den Target-Betrag (Single-Method-Fall)
    if (splits.length === 0) return;
    onChange(splits.map((s, i) => (i === 0 ? { ...s, amount: target } : s)));
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <label className="text-overline">{label}</label>
        <div style={{ fontSize: 11, color: mismatch ? '#DC2626' : '#16A34A', fontWeight: 500 }}>
          {mismatch
            ? remaining > 0
              ? `${remaining.toFixed(3)} BHD remaining`
              : `${Math.abs(remaining).toFixed(3)} BHD over`
            : '✓ matches total'}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {splits.map((split, idx) => (
          <div
            key={idx}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1.2fr) auto',
              gap: 8, alignItems: 'center',
              padding: '8px 12px',
              borderRadius: 8,
              border: '1px solid #E5E9EE',
              background: '#FBFBFC',
            }}
          >
            {/* Method pills */}
            <div style={{ display: 'flex', gap: 4 }}>
              {PAYMENT_METHODS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => patchSplit(idx, 'method', opt.value)}
                  disabled={disabled}
                  style={{
                    padding: '5px 10px', fontSize: 11, borderRadius: 999,
                    border: '1px solid ' + (split.method === opt.value ? '#0F0F10' : '#E5E9EE'),
                    background: split.method === opt.value ? '#0F0F10' : 'transparent',
                    color: split.method === opt.value ? '#FFFFFF' : '#6B7280',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Amount input */}
            <input
              type="number"
              step="0.001"
              min="0"
              value={split.amount || ''}
              placeholder="0.000"
              onChange={e => patchSplit(idx, 'amount', Number(e.target.value) || 0)}
              disabled={disabled}
              style={{
                width: '100%', background: 'transparent',
                border: 'none', borderBottom: '1px solid #D5D9DE',
                padding: '6px 0', fontSize: 14, outline: 'none', textAlign: 'right',
              }}
            />

            {/* Remove button */}
            {!disabled && splits.length > 1 ? (
              <button
                type="button"
                onClick={() => removeSplit(idx)}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer',
                  color: '#DC2626', padding: 4, display: 'flex',
                }}
                title="Remove split"
              >
                <X size={14} />
              </button>
            ) : (
              <div style={{ width: 22 }} />
            )}
          </div>
        ))}
      </div>

      {!disabled && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <button
            type="button"
            onClick={addSplit}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '6px 12px', fontSize: 11, borderRadius: 999,
              border: '1px solid #E5E9EE', background: 'transparent',
              color: '#6B7280', cursor: 'pointer',
            }}
          >
            <Plus size={12} /> Add Split
          </button>
          {mismatch && remaining > 0 && splits.length === 1 && (
            <button
              type="button"
              onClick={autofillFirst}
              style={{
                padding: '6px 12px', fontSize: 11, borderRadius: 999,
                border: '1px dashed #715DE3', background: 'transparent',
                color: '#715DE3', cursor: 'pointer',
              }}
            >
              Set to {target.toFixed(3)} BHD
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LineEditor({
  line, index, canRemove, onPatch, onRemove, disabled,
}: {
  line: ScrapTradeLineInput;
  index: number;
  canRemove: boolean;
  onPatch: (updater: (line: ScrapTradeLineInput) => ScrapTradeLineInput) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const [karatCustom, setKaratCustom] = useState(!!line.karat && !KARAT_OPTIONS.includes(line.karat));
  const purchase = Number(line.purchasePrice) || 0;
  const sale = Number(line.salePrice) || 0;
  const profit = Math.round((sale - purchase) * 1000) / 1000;
  const profitColor = profit > 0 ? '#16A34A' : profit < 0 ? '#DC2626' : '#6B7280';

  function set<K extends keyof ScrapTradeLineInput>(key: K, value: ScrapTradeLineInput[K]) {
    onPatch(l => ({ ...l, [key]: value }));
  }

  return (
    <div
      style={{
        padding: 18, borderRadius: 12,
        border: '1px solid #E5E9EE',
        background: '#FBFBFC',
      }}
    >
      {/* Item Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Item {index + 1}</div>
        {!disabled && canRemove && (
          <button
            type="button"
            onClick={onRemove}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 10px', fontSize: 11,
              border: '1px solid #E5E9EE', borderRadius: 999,
              background: 'transparent', color: '#DC2626',
              cursor: 'pointer',
            }}
          >
            <X size={11} /> Remove
          </button>
        )}
      </div>

      {/* Row 1: Weight + Karat */}
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16, marginBottom: 14 }}>
        <Input
          label="Weight (g)"
          type="number"
          step="0.01"
          min="0"
          required
          value={line.weightGrams || ''}
          onChange={e => set('weightGrams', Number(e.target.value) || 0)}
          disabled={disabled}
        />
        <div>
          <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
            Karat <span style={{ color: '#DC2626', marginLeft: 4 }}>*</span>
          </label>
          {!karatCustom ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {KARAT_OPTIONS.map(k => (
                <button
                  key={k}
                  type="button"
                  onClick={() => set('karat', k)}
                  disabled={disabled}
                  style={{
                    padding: '6px 12px', fontSize: 12, borderRadius: 999,
                    border: '1px solid ' + (line.karat === k ? '#0F0F10' : '#E5E9EE'),
                    background: line.karat === k ? '#0F0F10' : 'transparent',
                    color: line.karat === k ? '#FFFFFF' : '#6B7280',
                    cursor: disabled ? 'not-allowed' : 'pointer',
                  }}
                >
                  {k}
                </button>
              ))}
              <button
                type="button"
                onClick={() => { setKaratCustom(true); set('karat', ''); }}
                disabled={disabled}
                style={{
                  padding: '6px 12px', fontSize: 12, borderRadius: 999,
                  border: '1px dashed #D5D9DE', background: 'transparent', color: '#6B7280',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                Custom…
              </button>
            </div>
          ) : (
            <Input
              placeholder="e.g. 916, 750..."
              value={line.karat}
              onChange={e => set('karat', e.target.value)}
              disabled={disabled}
            />
          )}
        </div>
      </div>

      {/* Row 2: Purchase + Sale + Profit */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginBottom: 14 }}>
        <Input
          label="Purchase (BHD)"
          type="number"
          step="0.001"
          min="0"
          required
          value={line.purchasePrice || ''}
          onChange={e => set('purchasePrice', Number(e.target.value) || 0)}
          disabled={disabled}
        />
        <Input
          label="Sale (BHD)"
          type="number"
          step="0.001"
          min="0"
          required
          value={line.salePrice || ''}
          onChange={e => set('salePrice', Number(e.target.value) || 0)}
          disabled={disabled}
        />
        <div>
          <label className="text-overline" style={{ marginBottom: 6, display: 'block' }}>Profit</label>
          <div style={{ fontSize: 18, fontWeight: 600, color: profitColor, padding: '8px 0' }}>
            <Bhd v={profit} />
          </div>
        </div>
      </div>

      {/* Row 3: Notes */}
      <div style={{ marginBottom: 14 }}>
        <Input
          label="Item Notes (optional)"
          value={line.notes || ''}
          onChange={e => set('notes', e.target.value)}
          disabled={disabled}
        />
      </div>

      {/* Row 4: Photos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <label className="text-overline" style={{ marginBottom: 8, display: 'block' }}>Purchase Photo</label>
          <ImageUpload
            images={line.imagesPurchase || []}
            onChange={imgs => set('imagesPurchase', imgs)}
            maxImages={3}
            disabled={disabled}
          />
        </div>
        <div>
          <label className="text-overline" style={{ marginBottom: 8, display: 'block' }}>Sale Photo</label>
          <ImageUpload
            images={line.imagesSale || []}
            onChange={imgs => set('imagesSale', imgs)}
            maxImages={3}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}

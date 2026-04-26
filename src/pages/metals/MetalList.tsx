import { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { KPICard } from '@/components/ui/KPICard';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useMetalStore } from '@/stores/metalStore';
import { matchesDeep } from '@/core/utils/deep-search';
import type { PreciousMetal, MetalType, MetalKarat, MetalStatus } from '@/core/models/types';

// ── Purity factors ──
const PURITY: Record<string, number> = {
  '24K': 1.0, '22K': 0.916, '21K': 0.875, '18K': 0.75,
  '14K': 0.585, '9K': 0.375, '999': 0.999, '925': 0.925, '950': 0.95,
};

const METAL_TYPES: MetalType[] = ['gold', 'silver', 'platinum'];

const KARAT_OPTIONS: Record<MetalType, MetalKarat[]> = {
  gold: ['24K', '22K', '21K', '18K', '14K', '9K'],
  silver: ['999', '925'],
  platinum: ['950', '999'],
};

const STATUS_FILTERS: { value: MetalStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'in_stock', label: 'In Stock' },
  { value: 'sold', label: 'Sold' },
  { value: 'melted', label: 'Melted' },
];

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtWeight(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function calcMeltValue(weight: number, karat: string | undefined, spotPrice: number): number {
  if (!karat || !spotPrice) return 0;
  const purity = PURITY[karat] ?? 1;
  return weight * purity * spotPrice;
}

function metalColor(type: MetalType): string {
  switch (type) {
    case 'gold': return '#0F0F10';
    case 'silver': return '#4B5563';
    case 'platinum': return '#8B95A5';
  }
}

export function MetalList() {
  const { metals, loadMetals, createMetal, updateMetal, deleteMetal, getSpotPrice, setSpotPrice } = useMetalStore();
  const [showNew, setShowNew] = useState(false);
  const [filterStatus, setFilterStatus] = useState<MetalStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState<Partial<PreciousMetal>>({ metalType: 'gold', karat: '24K' });
  const [sellTarget, setSellTarget] = useState<PreciousMetal | null>(null);
  const [sellPrice, setSellPrice] = useState('');
  const [meltTarget, setMeltTarget] = useState<PreciousMetal | null>(null);

  // Spot prices (local state synced with settings)
  const [spotGold, setSpotGold] = useState(0);
  const [spotSilver, setSpotSilver] = useState(0);
  const [spotPlatinum, setSpotPlatinum] = useState(0);

  useEffect(() => {
    loadMetals();
    setSpotGold(getSpotPrice('gold'));
    setSpotSilver(getSpotPrice('silver'));
    setSpotPlatinum(getSpotPrice('platinum'));
  }, [loadMetals, getSpotPrice]);

  function getSpotForType(type: MetalType): number {
    switch (type) {
      case 'gold': return spotGold;
      case 'silver': return spotSilver;
      case 'platinum': return spotPlatinum;
    }
  }

  function handleSpotChange(type: MetalType, value: number) {
    switch (type) {
      case 'gold': setSpotGold(value); break;
      case 'silver': setSpotSilver(value); break;
      case 'platinum': setSpotPlatinum(value); break;
    }
    setSpotPrice(type, value);
  }

  const filtered = useMemo(() => {
    let list = metals;
    if (searchQuery) {
      list = list.filter(m => matchesDeep(m, searchQuery));
    }
    if (filterStatus) list = list.filter(m => m.status === filterStatus);
    return list;
  }, [metals, searchQuery, filterStatus]);

  // KPI calculations (in_stock only)
  const inStock = metals.filter(m => m.status === 'in_stock');
  const totalWeight = inStock.reduce((s, m) => s + m.weightGrams, 0);
  const totalMeltValue = inStock.reduce((s, m) => s + calcMeltValue(m.weightGrams, m.karat, getSpotForType(m.metalType)), 0);
  const totalPurchaseCost = inStock.reduce((s, m) => s + (m.purchaseTotal || 0), 0);
  const profitPotential = totalMeltValue - totalPurchaseCost;

  // Form melt value preview
  const formMeltValue = form.weightGrams && form.karat
    ? calcMeltValue(form.weightGrams, form.karat, getSpotForType(form.metalType || 'gold'))
    : 0;

  function openNew() {
    setForm({ metalType: 'gold', karat: '24K' });
    setShowNew(true);
  }

  function handleCreate() {
    if (!form.metalType || !form.weightGrams) return;
    const spot = getSpotForType(form.metalType);
    const meltValue = calcMeltValue(form.weightGrams, form.karat, spot);
    createMetal({
      ...form,
      spotPriceAtPurchase: spot,
      currentSpotPrice: spot,
      meltValue,
    });
    setShowNew(false);
  }

  function openSell(m: PreciousMetal) {
    const melt = calcMeltValue(m.weightGrams, m.karat, getSpotForType(m.metalType));
    setSellTarget(m);
    setSellPrice(melt > 0 ? melt.toFixed(2) : '');
  }

  function confirmSell() {
    if (!sellTarget) return;
    const price = parseFloat(sellPrice);
    if (isNaN(price) || price < 0) { alert('Enter a valid sale price.'); return; }
    updateMetal(sellTarget.id, { status: 'sold', salePrice: price });
    setSellTarget(null);
    setSellPrice('');
  }

  function confirmMelt() {
    if (!meltTarget) return;
    const spot = getSpotForType(meltTarget.metalType);
    const melt = calcMeltValue(meltTarget.weightGrams, meltTarget.karat, spot);
    updateMetal(meltTarget.id, { status: 'melted', currentSpotPrice: spot, meltValue: melt });
    setMeltTarget(null);
  }

  return (
    <PageLayout
      title="Precious Metals"
      subtitle={`${inStock.length} items in stock`}
      showSearch onSearch={setSearchQuery}
      searchPlaceholder="Search by metal, karat, description, supplier..."
      actions={
        <div className="flex items-center gap-3">
          <div className="flex gap-1" style={{ marginRight: 4 }}>
            {STATUS_FILTERS.map(sf => (
              <button key={sf.value} onClick={() => setFilterStatus(sf.value)}
                className="cursor-pointer transition-all duration-200"
                style={{
                  padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  border: `1px solid ${filterStatus === sf.value ? '#0F0F10' : 'transparent'}`,
                  color: filterStatus === sf.value ? '#0F0F10' : '#6B7280',
                  background: filterStatus === sf.value ? 'rgba(15,15,16,0.06)' : 'transparent',
                }}>{sf.label}</button>
            ))}
          </div>
          <Button variant="primary" onClick={openNew}>New Item</Button>
        </div>
      }
    >
      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 20, marginBottom: 32 }}>
        <KPICard label="TOTAL WEIGHT" value={fmtWeight(totalWeight)} unit="grams" />
        <KPICard label="TOTAL MELT VALUE" value={fmt(totalMeltValue)} unit="BHD" />
        <KPICard label="TOTAL PURCHASE COST" value={fmt(totalPurchaseCost)} unit="BHD" />
        <KPICard
          label="PROFIT POTENTIAL"
          value={fmt(profitPotential)}
          unit="BHD"
          trend={totalPurchaseCost > 0 ? Math.round((profitPotential / totalPurchaseCost) * 100) : undefined}
        />
      </div>

      {/* Spot Prices Bar */}
      <div
        className="rounded-lg"
        style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24,
          padding: '20px 24px', marginBottom: 28,
          background: '#FFFFFF', border: '1px solid #E5E9EE',
        }}
      >
        {METAL_TYPES.map(type => (
          <div key={type} className="flex items-center gap-3">
            <div
              className="rounded-full"
              style={{ width: 8, height: 8, background: metalColor(type), flexShrink: 0 }}
            />
            <span style={{ fontSize: 12, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.06em', minWidth: 72 }}>
              {type} / g
            </span>
            <input
              type="number"
              step="0.01"
              value={getSpotForType(type) || ''}
              onChange={e => handleSpotChange(type, parseFloat(e.target.value) || 0)}
              placeholder="0.00"
              className="outline-none"
              style={{
                background: 'transparent', border: 'none',
                borderBottom: '1px solid #D5D9DE',
                padding: '4px 0', fontSize: 14, color: '#0F0F10',
                width: 100, fontFamily: 'inherit',
              }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
            <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
          </div>
        ))}
      </div>

      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 0.8fr 1fr 1.2fr 1.2fr 0.8fr 0.6fr',
          gap: 16, padding: '0 16px 12px',
        }}
      >
        <span className="text-overline">METAL</span>
        <span className="text-overline">KARAT</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>WEIGHT (g)</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>PURCHASE</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>MELT VALUE</span>
        <span className="text-overline">STATUS</span>
        <span className="text-overline" style={{ textAlign: 'right' }}>ACTION</span>
      </div>

      <div style={{ borderTop: '1px solid #E5E9EE' }} />

      {filtered.length === 0 && (
        <div style={{ padding: '64px 0', textAlign: 'center' }}>
          <CircleDollarSign size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            {searchQuery || filterStatus ? 'No metals match your filters.' : 'No precious metals yet. Add your first item.'}
          </p>
        </div>
      )}

      {filtered.map(metal => {
        const melt = calcMeltValue(metal.weightGrams, metal.karat, getSpotForType(metal.metalType));
        const purchase = metal.purchaseTotal || 0;
        const diff = melt - purchase;

        return (
          <div
            key={metal.id}
            className="transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 0.8fr 1fr 1.2fr 1.2fr 0.8fr 0.6fr',
              gap: 16, padding: '14px 16px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,15,16,0.03)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* Metal Type */}
            <div className="flex items-center gap-3">
              <div
                className="rounded-full"
                style={{ width: 10, height: 10, background: metalColor(metal.metalType), flexShrink: 0 }}
              />
              <div>
                <span style={{ fontSize: 14, color: '#0F0F10', textTransform: 'capitalize' }}>{metal.metalType}</span>
                {metal.description && (
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
                    {metal.description}
                  </div>
                )}
              </div>
            </div>

            {/* Karat */}
            <span className="font-mono" style={{ fontSize: 13, color: metalColor(metal.metalType) }}>
              {metal.karat || '\u2014'}
            </span>

            {/* Weight */}
            <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10', textAlign: 'right' }}>
              {fmtWeight(metal.weightGrams)}
            </span>

            {/* Purchase */}
            <div style={{ textAlign: 'right' }}>
              <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(purchase)}</span>
              <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
            </div>

            {/* Melt Value */}
            <div style={{ textAlign: 'right' }}>
              <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}>{fmt(melt)}</span>
              <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
              {purchase > 0 && (
                <div className="font-mono" style={{ fontSize: 11, color: diff >= 0 ? '#7EAA6E' : '#AA6E6E', marginTop: 2 }}>
                  {diff >= 0 ? '+' : ''}{fmt(diff)}
                </div>
              )}
            </div>

            {/* Status */}
            <div>
              <span style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 999,
                textTransform: 'capitalize',
                color: metal.status === 'in_stock' ? '#7EAA6E' : metal.status === 'sold' ? '#0F0F10' : '#6B7280',
                background: metal.status === 'in_stock' ? 'rgba(126,170,110,0.08)' : metal.status === 'sold' ? 'rgba(15,15,16,0.06)' : 'rgba(107,107,115,0.08)',
                border: `1px solid ${metal.status === 'in_stock' ? 'rgba(126,170,110,0.2)' : metal.status === 'sold' ? 'rgba(15,15,16,0.15)' : 'rgba(107,107,115,0.15)'}`,
              }}>
                {metal.status.replace('_', ' ')}
              </span>
            </div>

            {/* Actions */}
            <div style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {metal.status === 'in_stock' && (
                <>
                  <button
                    onClick={() => openSell(metal)}
                    className="cursor-pointer transition-all duration-200"
                    style={{ padding: '5px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #0F0F10', color: '#0F0F10', background: 'rgba(15,15,16,0.06)' }}
                  >Sell</button>
                  <button
                    onClick={() => setMeltTarget(metal)}
                    className="cursor-pointer transition-all duration-200"
                    style={{ padding: '5px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#4B5563', background: 'transparent' }}
                  >Melt</button>
                </>
              )}
              <button
                onClick={() => { if (confirm('Delete this item?')) deleteMetal(metal.id); }}
                className="cursor-pointer transition-all duration-200"
                style={{ padding: '5px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#AA6E6E'; e.currentTarget.style.color = '#AA6E6E'; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#D5D9DE'; e.currentTarget.style.color = '#6B7280'; }}
              >Delete</button>
            </div>
          </div>
        );
      })}

      {/* New Metal Modal */}
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New Precious Metal" width={580}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* Metal Type Selector */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>METAL TYPE</span>
            <div className="flex gap-2" style={{ marginTop: 8 }}>
              {METAL_TYPES.map(type => (
                <button key={type} onClick={() => setForm({ ...form, metalType: type, karat: KARAT_OPTIONS[type][0] })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '8px 20px', fontSize: 13, textTransform: 'capitalize',
                    border: `1px solid ${form.metalType === type ? metalColor(type) : '#D5D9DE'}`,
                    color: form.metalType === type ? metalColor(type) : '#6B7280',
                    background: form.metalType === type ? `${metalColor(type)}10` : 'transparent',
                  }}>
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Karat Selector */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>PURITY / KARAT</span>
            <div className="flex gap-2 flex-wrap" style={{ marginTop: 8 }}>
              {KARAT_OPTIONS[form.metalType || 'gold'].map(k => (
                <button key={k} onClick={() => setForm({ ...form, karat: k })}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '6px 14px', fontSize: 12,
                    border: `1px solid ${form.karat === k ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.karat === k ? '#0F0F10' : '#6B7280',
                    background: form.karat === k ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {k} <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>({(PURITY[k] * 100).toFixed(1)}%)</span>
                </button>
              ))}
            </div>
          </div>

          {/* Weight & Price */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <Input
              label="WEIGHT (GRAMS)"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={form.weightGrams || ''}
              onChange={e => setForm({ ...form, weightGrams: parseFloat(e.target.value) || 0 })}
            />
            <Input
              label="PURCHASE TOTAL (BHD)"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={form.purchaseTotal || ''}
              onChange={e => setForm({ ...form, purchaseTotal: parseFloat(e.target.value) || 0 })}
            />
          </div>

          <Input
            label="PURCHASE PRICE PER GRAM (BHD)"
            type="number"
            step="0.001"
            placeholder="0.000"
            value={form.purchasePricePerGram || ''}
            onChange={e => setForm({ ...form, purchasePricePerGram: parseFloat(e.target.value) || 0 })}
          />

          {/* Melt Value Preview */}
          {formMeltValue > 0 && (
            <div className="rounded font-mono" style={{
              padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE',
              fontSize: 13, display: 'flex', justifyContent: 'space-between',
            }}>
              <span style={{ color: '#6B7280' }}>Melt Value (at current spot)</span>
              <span style={{ color: '#0F0F10' }}>{fmt(formMeltValue)} BHD</span>
            </div>
          )}

          {/* Supplier & Description */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <Input
                label="SUPPLIER"
                placeholder="Supplier name"
                value={form.supplierName || ''}
                onChange={e => setForm({ ...form, supplierName: e.target.value })}
              />
              <Input
                label="DESCRIPTION"
                placeholder="e.g. Bar, Coin, Chain..."
                value={form.description || ''}
                onChange={e => setForm({ ...form, description: e.target.value })}
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>NOTES</span>
            <textarea
              style={{
                width: '100%', marginTop: 8, background: 'transparent',
                border: 'none', borderBottomStyle: 'solid', borderBottomWidth: 1, borderBottomColor: '#D5D9DE',
                padding: '10px 0', fontSize: 14, color: '#0F0F10',
                resize: 'vertical', minHeight: 48, outline: 'none',
                fontFamily: 'inherit',
              }}
              placeholder="Internal notes..."
              value={form.notes || ''}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => (e.currentTarget.style.borderBottomColor = '#D5D9DE')}
            />
          </div>

          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!form.weightGrams}>Add Item</Button>
          </div>
        </div>
      </Modal>

      {/* Sell Modal */}
      <Modal open={!!sellTarget} onClose={() => setSellTarget(null)} title="Sell Item" width={440}>
        {sellTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 6, border: '1px solid #E5E9EE' }}>
              <div style={{ fontSize: 13, color: '#0F0F10', textTransform: 'capitalize' }}>
                {sellTarget.metalType} {sellTarget.karat || ''} · {fmtWeight(sellTarget.weightGrams)}g
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                Melt value: {fmt(calcMeltValue(sellTarget.weightGrams, sellTarget.karat, getSpotForType(sellTarget.metalType)))} BHD
                {sellTarget.purchaseTotal ? ` · Purchase: ${fmt(sellTarget.purchaseTotal)} BHD` : ''}
              </div>
            </div>
            <Input
              label="SALE PRICE (BHD)"
              type="number"
              step="0.01"
              value={sellPrice}
              onChange={e => setSellPrice(e.target.value)}
              autoFocus
            />
            {sellTarget.purchaseTotal && parseFloat(sellPrice) > 0 && (
              <div style={{ fontSize: 12, color: (parseFloat(sellPrice) - sellTarget.purchaseTotal) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                Margin: {fmt(parseFloat(sellPrice) - sellTarget.purchaseTotal)} BHD
              </div>
            )}
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setSellTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmSell} disabled={!sellPrice}>Mark Sold</Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Melt Modal */}
      <Modal open={!!meltTarget} onClose={() => setMeltTarget(null)} title="Mark as Melted" width={440}>
        {meltTarget && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ padding: 12, background: '#F2F7FA', borderRadius: 6, border: '1px solid #E5E9EE' }}>
              <div style={{ fontSize: 13, color: '#0F0F10', textTransform: 'capitalize' }}>
                {meltTarget.metalType} {meltTarget.karat || ''} · {fmtWeight(meltTarget.weightGrams)}g
              </div>
              <div className="font-mono" style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }}>
                Current melt value: {fmt(calcMeltValue(meltTarget.weightGrams, meltTarget.karat, getSpotForType(meltTarget.metalType)))} BHD
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#4B5563' }}>
              This will mark the item as melted. Use this when you've sent it for smelting or refining. The current spot price will be frozen on the record.
            </p>
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setMeltTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={confirmMelt}>Confirm Melt</Button>
            </div>
          </div>
        )}
      </Modal>
    </PageLayout>
  );
}

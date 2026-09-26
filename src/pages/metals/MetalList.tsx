import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleDollarSign } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { KPICard } from '@/components/ui/KPICard';
import { Button } from '@/components/ui/Button';
import { primaryOnlyDeleteProps, blockDeleteOnClient } from '@/core/data/primary-only';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useMetalStore } from '@/stores/metalStore';
import { useSupplierStore } from '@/stores/supplierStore';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { matchesDeep } from '@/core/utils/deep-search';
import type { PreciousMetal, MetalType, MetalStatus } from '@/core/models/types';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
// CENTRAL-UI-PARITY R6D — die Maske speichert, ohne zu wissen, wo die Datenbank steht: am Primary
// die Hausfolge in EINER Transaktion, auf PC2 derselbe Vorgang als Auftrag. Spotpreis und
// Schmelzwert, die gespeichert werden, bestimmt das Haus — die Anzeige hier ist nur Vorschau.
import { useSharedWrites, fehlertext, nichtAmClient } from '@/core/data/shared-write';
import { useSharedRead } from '@/core/data/shared-read';
import {
  METAL_KARATS, METAL_PURITY, METAL_TYPES, meltValueOf, spotPricesFor,
  type MetalCreateInput, type MetalRecord, type SpotPrices,
} from '@/core/metals/metal-house';
import {
  changeMetalStatusOnPrimary, createMetalOnPrimary, metalCreateBody, metalStatusBody,
  setSpotPriceOnPrimary, spotPriceBody,
} from '@/core/metals/metal-actions';

const STATUS_FILTERS: { value: MetalStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'in_stock', label: 'In Stock' },
  { value: 'sold', label: 'Sold' },
  { value: 'melted', label: 'Melted' },
];

const NO_SPOTS: SpotPrices = { gold: 0, silver: 0, platinum: 0 };

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function fmtWeight(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

function metalColor(type: MetalType): string {
  switch (type) {
    case 'gold': return '#0F0F10';
    case 'silver': return '#4B5563';
    case 'platinum': return '#8B95A5';
  }
}

export function MetalList() {
  const { metals, loadMetals, deleteMetal } = useMetalStore();
  const { suppliers, loadSuppliers } = useSupplierStore();
  const w = useSharedWrites();
  const [showNew, setShowNew] = useState(false);
  const [filterStatus, setFilterStatus] = useState<MetalStatus | ''>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState<Partial<PreciousMetal>>({ metalType: 'gold', karat: '24K' });
  const [sellTarget, setSellTarget] = useState<MetalRecord | null>(null);
  const [sellPrice, setSellPrice] = useState('');
  // R6D — ein Verkauf mit Preis > 0 nennt, wie das Geld hereinkam (Metallzahlung → Kasse/Bank/Karte, Erlös).
  const [sellMethod, setSellMethod] = useState<'cash' | 'bank' | 'card'>('cash');
  const [meltTarget, setMeltTarget] = useState<MetalRecord | null>(null);

  // R6D — die Spotpreise der Filiale: am Primary aus seiner Einstellung, auf PC2 über
  // `metals.spot_prices.get`. Getippt wird in einen Entwurf; übernommen wird erst beim Verlassen
  // des Feldes oder mit Enter (vorher schrieb JEDER Tastendruck in die Einstellung).
  const gelesen = useSharedRead('metals.spot_prices.get', {}, spotPricesFor, NO_SPOTS);
  const [uebernommen, setUebernommen] = useState<Partial<SpotPrices>>({});
  const [entwurf, setEntwurf] = useState<Partial<Record<MetalType, string>>>({});
  const spots: SpotPrices = { ...gelesen, ...uebernommen };

  useEffect(() => {
    loadMetals();
    loadSuppliers();
  }, [loadMetals, loadSuppliers]);

  // Der Hinweis der Altgold-Maske („Add Precious Metal") kommt mit `?new=1` — dann direkt die leere
  // Maske öffnen und den Parameter entfernen, damit Zurück/Neuladen sie nicht erneut öffnet.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('new') !== '1') return;
    openNew();
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nur beim Eintreffen des Parameters
  }, [params]);

  function getSpotForType(type: MetalType): number {
    return spots[type] || 0;
  }

  function entwurfWeg(type: MetalType) {
    setEntwurf(d => { const n = { ...d }; delete n[type]; return n; });
  }

  async function commitSpot(type: MetalType) {
    const draft = entwurf[type];
    if (draft === undefined) return;
    // Wie bisher: ein geleertes Feld ist 0.
    const price = parseFloat(draft) || 0;
    if (price === getSpotForType(type)) { entwurfWeg(type); return; }
    if (!await w.ok('metals.set_spot_price', {
      local: () => setSpotPriceOnPrimary(type, price),
      remote: () => spotPriceBody(type, price),
    })) return;   // der Entwurf bleibt stehen, der Grund steht in `w.fehler`
    setUebernommen(u => ({ ...u, [type]: price }));
    entwurfWeg(type);
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
  const totalMeltValue = inStock.reduce((s, m) => s + meltValueOf(m.weightGrams, m.karat, getSpotForType(m.metalType)), 0);
  const totalPurchaseCost = inStock.reduce((s, m) => s + (m.purchaseTotal || 0), 0);
  const profitPotential = totalMeltValue - totalPurchaseCost;

  // Form melt value preview
  const formMeltValue = form.weightGrams && form.karat
    ? meltValueOf(form.weightGrams, form.karat, getSpotForType(form.metalType || 'gold'))
    : 0;

  function openNew() {
    w.clear();
    setForm({ metalType: 'gold', karat: '24K' });
    setShowNew(true);
  }

  async function handleCreate() {
    if (!form.metalType || !form.weightGrams) return;
    // Nur die Eingaben der Maske — Spot und Schmelzwert rechnet das Haus aus SEINER Einstellung.
    const input: Partial<MetalCreateInput> = {
      metalType: form.metalType,
      karat: form.karat,
      weightGrams: form.weightGrams,
      purchaseTotal: form.purchaseTotal,
      purchasePricePerGram: form.purchasePricePerGram,
      supplierId: form.supplierId || undefined,
      supplierName: form.supplierName,
      description: form.description,
      notes: form.notes,
    };
    if (!await w.ok('metals.create', {
      local: () => createMetalOnPrimary(input),
      remote: () => metalCreateBody(input),
    })) return;
    loadMetals();
    setShowNew(false);
  }

  function openSell(m: MetalRecord) {
    w.clear();
    const melt = meltValueOf(m.weightGrams, m.karat, getSpotForType(m.metalType));
    setSellTarget(m);
    setSellPrice(melt > 0 ? melt.toFixed(2) : '');
  }

  async function confirmSell() {
    if (!sellTarget) return;
    const price = parseFloat(sellPrice);
    if (isNaN(price) || price < 0) { alert('Enter a valid sale price.'); return; }
    const m = sellTarget;
    if (w.remote && !m.revision) { alert(fehlertext(nichtAmClient('selling this item (no revision loaded)'))); return; }
    const method = price > 0 ? sellMethod : undefined;
    if (!await w.ok('metals.update_status', {
      local: () => changeMetalStatusOnPrimary({ metalId: m.id, status: 'sold', salePrice: price, paymentMethod: method, expectedRevision: m.revision }),
      remote: () => metalStatusBody(m.id, m.revision, 'sold', price, method),
    })) return;
    loadMetals();
    setSellTarget(null);
    setSellPrice('');
  }

  function openMelt(m: MetalRecord) {
    w.clear();
    setMeltTarget(m);
  }

  async function confirmMelt() {
    if (!meltTarget) return;
    const m = meltTarget;
    if (w.remote && !m.revision) { alert(fehlertext(nichtAmClient('melting this item (no revision loaded)'))); return; }
    if (!await w.ok('metals.update_status', {
      local: () => changeMetalStatusOnPrimary({ metalId: m.id, status: 'melted', expectedRevision: m.revision }),
      remote: () => metalStatusBody(m.id, m.revision, 'melted'),
    })) return;
    loadMetals();
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
          <Button variant="primary" onClick={openNew} data-metal-new-open>New Item</Button>
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
          padding: '20px 24px', marginBottom: showNew || sellTarget || meltTarget ? 28 : 12,
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
              data-metal-spot-input={type}
              value={entwurf[type] ?? (getSpotForType(type) || '')}
              onChange={e => setEntwurf(d => ({ ...d, [type]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              placeholder="0.00"
              className="outline-none"
              disabled={w.busy}
              style={{
                background: 'transparent', border: 'none',
                borderBottom: '1px solid #D5D9DE',
                padding: '4px 0', fontSize: 14, color: '#0F0F10',
                width: 100, fontFamily: 'inherit',
              }}
              onFocus={e => (e.currentTarget.style.borderBottomColor = '#0F0F10')}
              onBlur={e => { e.currentTarget.style.borderBottomColor = '#D5D9DE'; void commitSpot(type); }}
            />
            <span style={{ fontSize: 11, color: '#6B7280' }}>BHD</span>
          </div>
        ))}
      </div>
      {!showNew && !sellTarget && !meltTarget && <WriteError text={w.fehler} />}
      <div style={{ marginBottom: 16 }} />

      {/* Table Header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.6fr)',
          gap: 16, padding: '0 16px 12px',
        }}
      >
        <span className="text-overline">METAL</span>
        <span className="text-overline">KARAT</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>WEIGHT (g)</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>PURCHASE</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>MELT VALUE</span>
        <span className="text-overline">STATUS</span>
        <span className="text-overline" style={{ display: 'block', textAlign: 'right' }}>ACTION</span>
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
        const melt = meltValueOf(metal.weightGrams, metal.karat, getSpotForType(metal.metalType));
        const purchase = metal.purchaseTotal || 0;
        const diff = melt - purchase;

        return (
          <div
            key={metal.id}
            data-metal-row={metal.id}
            className="transition-colors"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) minmax(0,0.8fr) minmax(0,1fr) minmax(0,1.2fr) minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.6fr)',
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
              {metal.karat || '—'}
            </span>

            {/* Weight */}
            <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10', textAlign: 'right' }}>
              {fmtWeight(metal.weightGrams)}
            </span>

            {/* Purchase */}
            <div style={{ textAlign: 'right' }}>
              <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}><Bhd v={purchase}/></span>
              <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
            </div>

            {/* Melt Value */}
            <div style={{ textAlign: 'right' }}>
              <span className="font-mono" style={{ fontSize: 14, color: '#0F0F10' }}><Bhd v={melt}/></span>
              <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 3 }}>BHD</span>
              {purchase > 0 && (
                <div className="font-mono" style={{ fontSize: 11, color: diff >= 0 ? '#7EAA6E' : '#AA6E6E', marginTop: 2 }}>
                  {diff >= 0 ? '+' : ''}<Bhd v={diff}/>
                </div>
              )}
            </div>

            {/* Status */}
            <div>
              <span data-metal-status={metal.status} style={{
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
                    data-metal-sell-open
                    className="cursor-pointer transition-all duration-200"
                    style={{ padding: '5px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #0F0F10', color: '#0F0F10', background: 'rgba(15,15,16,0.06)' }}
                  >Sell</button>
                  <button
                    onClick={() => openMelt(metal)}
                    data-metal-melt-open
                    className="cursor-pointer transition-all duration-200"
                    style={{ padding: '5px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #D5D9DE', color: '#4B5563', background: 'transparent' }}
                  >Melt</button>
                </>
              )}
              <button
                {...primaryOnlyDeleteProps()}
                onClick={async () => { if (blockDeleteOnClient()) return; if (await window.confirm('Delete this item?')) deleteMetal(metal.id); }}
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
                <button key={type} onClick={() => setForm({ ...form, metalType: type, karat: METAL_KARATS[type][0] })}
                  data-metal-type={type}
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
              {METAL_KARATS[form.metalType || 'gold'].map(k => (
                <button key={k} onClick={() => setForm({ ...form, karat: k })}
                  data-metal-karat={k}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '6px 14px', fontSize: 12,
                    border: `1px solid ${form.karat === k ? '#0F0F10' : '#D5D9DE'}`,
                    color: form.karat === k ? '#0F0F10' : '#6B7280',
                    background: form.karat === k ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}>
                  {k} <span style={{ fontSize: 10, color: '#6B7280', marginLeft: 4 }}>({(METAL_PURITY[k] * 100).toFixed(1)}%)</span>
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
              data-metal-weight
              value={form.weightGrams || ''}
              onChange={e => setForm({ ...form, weightGrams: parseFloat(e.target.value) || 0 })}
            />
            <Input
              label="PURCHASE TOTAL (BHD)"
              type="number"
              step="0.01"
              placeholder="0.00"
              data-metal-purchase-total
              value={form.purchaseTotal || ''}
              onChange={e => setForm({ ...form, purchaseTotal: parseFloat(e.target.value) || 0 })}
            />
          </div>

          <Input
            label="PURCHASE PRICE PER GRAM (BHD)"
            type="number"
            step="0.001"
            placeholder="0.000"
            data-metal-price-per-gram
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
              <span style={{ color: '#0F0F10' }}><Bhd v={formMeltValue}/> BHD</span>
            </div>
          )}

          {/* Supplier & Description */}
          <div style={{ borderTop: '1px solid #E5E9EE', paddingTop: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              <div data-metal-supplier>
                <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>SUPPLIER (OPTIONAL)</span>
                <SearchSelect
                  options={suppliers.filter(s => s.active).map(s => ({
                    id: s.id, label: s.name, subtitle: s.phone || '', meta: s.email || '',
                  }))}
                  value={form.supplierId || ''}
                  onChange={(id) => {
                    const sup = suppliers.find(s => s.id === id);
                    setForm({ ...form, supplierId: id, supplierName: sup?.name || form.supplierName });
                  }}
                  placeholder="Pick a supplier — or leave empty"
                />
              </div>
              <Input
                label="DESCRIPTION"
                placeholder="e.g. Bar, Coin, Chain..."
                data-metal-description
                value={form.description || ''}
                onChange={e => setForm({ ...form, description: e.target.value })}
              />
            </div>
            {/* v0.1.46 hint: A/P will auto-post when supplier + purchaseTotal set */}
            {form.supplierId && (form.purchaseTotal || 0) > 0 && (
              <div className="rounded" style={{
                marginTop: 12, padding: '10px 14px', fontSize: 12, color: '#16A34A',
                background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(22,163,74,0.3)',
              }}>
                ✓ Supplier + Purchase Total gesetzt → A/P-Schuld wird automatisch gebucht (OPEN bis bezahlt).
              </div>
            )}
            {!form.supplierId && (form.purchaseTotal || 0) > 0 && (
              <div className="rounded" style={{
                marginTop: 12, padding: '10px 14px', fontSize: 12, color: '#92400E',
                background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.3)',
              }}>
                ⚠ Kein Supplier ausgewaehlt — Bestand wird erhoeht, aber keine Geld-Schuld gebucht.
                Wenn du via Lieferant gekauft hast, bitte Supplier setzen.
              </div>
            )}
          </div>

          {/* Notes */}
          <div>
            <span className="text-overline" style={{ marginBottom: 8 }}>NOTES</span>
            <textarea
              data-metal-notes
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

          <WriteError text={w.fehler} />
          <div className="flex justify-end gap-3" style={{ marginTop: 8, paddingTop: 16, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void handleCreate()} disabled={!form.weightGrams || w.busy} data-metal-save>Add Item</Button>
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
                Melt value: <Bhd v={meltValueOf(sellTarget.weightGrams, sellTarget.karat, getSpotForType(sellTarget.metalType))}/> BHD
                {sellTarget.purchaseTotal ? ` · Purchase: ${fmt(sellTarget.purchaseTotal)} BHD` : ''}
              </div>
            </div>
            <Input
              label="SALE PRICE (BHD)"
              type="number"
              step="0.01"
              data-metal-sell-price
              value={sellPrice}
              onChange={e => setSellPrice(e.target.value)}
              autoFocus
            />
            {parseFloat(sellPrice) > 0 && (
              <div>
                <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>RECEIVED VIA</span>
                <div className="flex gap-2">
                  {(['cash', 'bank', 'card'] as const).map((m) => (
                    <Button key={m} variant={sellMethod === m ? 'primary' : 'ghost'} onClick={() => setSellMethod(m)} data-metal-sell-method={m}>
                      {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Card'}
                    </Button>
                  ))}
                </div>
              </div>
            )}
            {sellTarget.purchaseTotal && parseFloat(sellPrice) > 0 && (
              <div style={{ fontSize: 12, color: (parseFloat(sellPrice) - sellTarget.purchaseTotal) >= 0 ? '#7EAA6E' : '#AA6E6E' }}>
                Margin: <Bhd v={parseFloat(sellPrice) - sellTarget.purchaseTotal}/> BHD
              </div>
            )}
            <WriteError text={w.fehler} />
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setSellTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void confirmSell()} disabled={!sellPrice || w.busy} data-metal-sell-confirm>Mark Sold</Button>
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
                Current melt value: <Bhd v={meltValueOf(meltTarget.weightGrams, meltTarget.karat, getSpotForType(meltTarget.metalType))}/> BHD
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#4B5563' }}>
              This will mark the item as melted. Use this when you've sent it for smelting or refining. The current spot price will be frozen on the record.
            </p>
            <WriteError text={w.fehler} />
            <div className="flex justify-end gap-3" style={{ paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <Button variant="ghost" onClick={() => setMeltTarget(null)}>Cancel</Button>
              <Button variant="primary" onClick={() => void confirmMelt()} disabled={w.busy} data-metal-melt-confirm>Confirm Melt</Button>
            </div>
          </div>
        )}
      </Modal>
    </PageLayout>
  );
}

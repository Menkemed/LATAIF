// Plan §Production — List + New Production Record modal mit Multi-Output via
// NewProductModal (Category-First Workflow). Output-Cards zeigen Summary mit
// kategorie-spezifischen Attributen, nicht nur Brand/Name/SKU.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Factory, Trash2, Plus, Edit2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchMultiSelect } from '@/components/ui/SearchSelect';
import { NewProductModal } from '@/components/products/NewProductModal';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { useProductionStore } from '@/stores/productionStore';
import { useProductStore } from '@/stores/productStore';
import { useOrderStore } from '@/stores/orderStore';
import { Bhd } from '@/components/ui/Bhd';
import { getProductSpecs } from '@/core/utils/product-format';
import type { Product, Category } from '@/core/models/types';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

interface OutputDraft {
  key: string;
  spec: Partial<Product>;
  value: number;
}

function uid() { return Math.random().toString(36).slice(2, 10); }

export function ProductionPage() {
  const navigate = useNavigate();
  const { records, loadRecords, createRecord, deleteRecord } = useProductionStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  // v0.6.9 — Soft-Reservation: Production verbraucht ein Stueck; wenn es in einer
  // offenen Order versprochen ist, Hinweis im Input-Picker.
  const { orders, loadOrders, getAllProductReservations } = useOrderStore();

  const [showNew, setShowNew] = useState(false);
  const [selectedInputIds, setSelectedInputIds] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputDraft[]>([]);
  const [notes, setNotes] = useState('');
  const [laborCost, setLaborCost] = useState<number>(0);
  const [overheadCost, setOverheadCost] = useState<number>(0);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Output-Modal-State: open + welcher Output gerade editiert wird (null = neu)
  const [outputModalOpen, setOutputModalOpen] = useState(false);
  const [editingOutputKey, setEditingOutputKey] = useState<string | null>(null);

  useEffect(() => { loadRecords(); loadProducts(); loadCategories(); loadOrders(); }, [loadRecords, loadProducts, loadCategories, loadOrders]);

  const productReservations = useMemo(() => getAllProductReservations(), [orders, getAllProductReservations]);

  const availableProducts = useMemo(() => products.filter(p => p.stockStatus === 'in_stock'), [products]);

  const inputTotal = useMemo(() => {
    const sel = new Set(selectedInputIds);
    return products.filter(p => sel.has(p.id)).reduce((s, p) => s + p.purchasePrice, 0);
  }, [products, selectedInputIds]);

  const outputTotal = useMemo(() => outputs.reduce((s, o) => s + (Number(o.value) || 0), 0), [outputs]);
  const balanced = Math.abs(inputTotal - outputTotal) <= 0.01;

  function resetForm() {
    setSelectedInputIds([]);
    setOutputs([]);
    setNotes('');
    setLaborCost(0);
    setOverheadCost(0);
    setError('');
  }

  function openAddOutput() {
    setEditingOutputKey(null);
    setOutputModalOpen(true);
  }

  function openEditOutput(key: string) {
    setEditingOutputKey(key);
    setOutputModalOpen(true);
  }

  function handleOutputSubmit(spec: Partial<Product>) {
    if (editingOutputKey) {
      setOutputs(prev => prev.map(o => o.key === editingOutputKey ? { ...o, spec } : o));
    } else {
      setOutputs(prev => [...prev, { key: uid(), spec, value: 0 }]);
    }
    setOutputModalOpen(false);
    setEditingOutputKey(null);
  }

  function patchOutputValue(key: string, value: number) {
    setOutputs(prev => prev.map(o => o.key === key ? { ...o, value } : o));
  }

  function removeOutput(key: string) {
    setOutputs(prev => prev.filter(o => o.key !== key));
  }

  function autofillRemainingValue(key: string) {
    const remaining = inputTotal - outputs.filter(o => o.key !== key).reduce((s, o) => s + (Number(o.value) || 0), 0);
    patchOutputValue(key, Math.max(0, Math.round(remaining * 1000) / 1000));
  }

  function handleCreate() {
    setError('');
    if (selectedInputIds.length === 0) { setError('Select at least one input product.'); return; }
    if (outputs.length === 0) { setError('Add at least one output product.'); return; }
    for (let i = 0; i < outputs.length; i++) {
      const o = outputs[i];
      if (!o.spec.brand || !o.spec.name || !o.spec.categoryId) {
        setError(`Output ${i + 1}: brand, name and category are required.`); return;
      }
      if (!(o.value > 0)) { setError(`Output ${i + 1}: value must be > 0.`); return; }
    }
    try {
      createRecord({
        notes: notes || undefined,
        inputProductIds: selectedInputIds,
        outputs: outputs.map(o => ({ spec: o.spec, value: o.value })),
        laborCost: laborCost > 0 ? laborCost : undefined,
        overheadCost: overheadCost > 0 ? overheadCost : undefined,
      });
      setShowNew(false);
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const editingOutput = editingOutputKey ? outputs.find(o => o.key === editingOutputKey) : null;

  return (
    <PageLayout
      title="Production & Consumption"
      subtitle={`${records.length} records — Plan §Production (Input Value = Output Value)`}
      actions={<Button variant="primary" onClick={() => setShowNew(true)} disabled={availableProducts.length === 0}>New Record</Button>}
    >
      {records.length === 0 ? (
        <div style={{ padding: '80px 0', textAlign: 'center' }}>
          <Factory size={40} strokeWidth={1} style={{ color: '#6B7280', margin: '0 auto 16px' }} />
          <p style={{ fontSize: 14, color: '#6B7280' }}>
            No production records yet. Use this module to merge or decompose products without changing total value.
          </p>
        </div>
      ) : (
        <Card noPadding>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.6fr 0.6fr 1fr 2fr 0.4fr', gap: 12, padding: '12px 16px', borderBottom: '1px solid #E5E9EE' }}>
            {['NUMBER', 'DATE', 'INPUTS', 'OUTPUTS', 'TOTAL', 'NOTES', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {records.map(r => (
            <ProductionRow
              key={r.id}
              record={r}
              onOpen={() => navigate(`/production/${r.id}`)}
              onDelete={() => setConfirmDelete(r.id)}
            />
          ))}
        </Card>
      )}

      {/* New Record Modal */}
      <Modal open={showNew} onClose={() => { setShowNew(false); resetForm(); }} title="New Production Record (PRD)" width={860}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '78vh', overflowY: 'auto', paddingRight: 4 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Plan §Production §12: Gesamtwert bleibt identisch. Inputs werden entfernt, Outputs neu erstellt.
          </p>

          {/* Inputs */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>INPUT PRODUCTS (will be consumed)</span>
            <SearchMultiSelect
              label=""
              placeholder="Search inventory..."
              options={availableProducts.map(p => {
                const res = productReservations.get(p.id);
                const resHint = res && res.qty > 0
                  ? ` · 🔒 ${res.qty} reserviert (${res.orderNumbers.slice(0, 2).join(', ')}${res.orderNumbers.length > 2 ? '…' : ''})`
                  : '';
                return {
                  id: p.id, label: `${p.brand} ${p.name}`,
                  subtitle: `${fmt(p.purchasePrice)} BHD${resHint}`,
                  meta: p.sku,
                };
              })}
              value={selectedInputIds}
              onChange={setSelectedInputIds}
              renderPreview={id => (
                <ProductHoverCard
                  product={availableProducts.find(p => p.id === id)}
                  categories={categories}
                />
              )}
            />
          </div>

          {/* Outputs */}
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
              <span className="text-overline">OUTPUT PRODUCTS (new inventory)</span>
              <Button variant="secondary" icon={<Plus size={14} />} onClick={openAddOutput}>Add Output</Button>
            </div>

            {outputs.length === 0 ? (
              <div style={{
                padding: '24px', textAlign: 'center', border: '1px dashed #D5D9DE', borderRadius: 10,
                color: '#6B7280', fontSize: 13,
              }}>
                No outputs yet. Click <strong>Add Output</strong> to define a new product with category + details + photos.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {outputs.map((o, idx) => (
                  <OutputCard
                    key={o.key}
                    index={idx}
                    draft={o}
                    categories={categories}
                    inputTotal={inputTotal}
                    onEdit={() => openEditOutput(o.key)}
                    onRemove={() => removeOutput(o.key)}
                    onValueChange={v => patchOutputValue(o.key, v)}
                    onAutofill={() => autofillRemainingValue(o.key)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Costs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input
              label="Labor Cost (optional)"
              type="number"
              step="0.001"
              min="0"
              value={laborCost || ''}
              placeholder="0.000"
              onChange={e => setLaborCost(Number(e.target.value) || 0)}
            />
            <Input
              label="Overhead Cost (optional)"
              type="number"
              step="0.001"
              min="0"
              value={overheadCost || ''}
              placeholder="0.000"
              onChange={e => setOverheadCost(Number(e.target.value) || 0)}
            />
          </div>

          <Input label="Notes" placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />

          {/* Balance check */}
          <div style={{
            padding: '12px 14px',
            background: balanced ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.06)',
            border: `1px solid ${balanced ? '#16A34A33' : '#DC262633'}`,
            borderRadius: 8,
          }}>
            <div className="flex justify-between" style={{ fontSize: 13 }}>
              <span style={{ color: '#6B7280' }}>Input Value</span>
              <span className="font-mono" style={{ color: '#DC2626' }}>− <Bhd v={inputTotal}/> BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, marginTop: 4 }}>
              <span style={{ color: '#6B7280' }}>Output Value</span>
              <span className="font-mono" style={{ color: '#16A34A' }}>+ <Bhd v={outputTotal}/> BHD</span>
            </div>
            {(laborCost > 0 || overheadCost > 0) && (
              <div className="flex justify-between" style={{ fontSize: 12, marginTop: 4, color: '#6B7280' }}>
                <span>Labor + Overhead (booked separately)</span>
                <span className="font-mono">+ <Bhd v={laborCost + overheadCost}/> BHD</span>
              </div>
            )}
            <div className="flex justify-between" style={{ fontSize: 14, marginTop: 8, paddingTop: 8, borderTop: '1px solid #E5E9EE' }}>
              <span style={{ color: balanced ? '#16A34A' : '#DC2626', fontWeight: 500 }}>
                {balanced ? 'Balanced ✓' : 'Out of balance'}
              </span>
              <span className="font-mono" style={{ color: balanced ? '#16A34A' : '#DC2626' }}>
                <Bhd v={Math.abs(inputTotal - outputTotal)}/> BHD
              </span>
            </div>
          </div>

          {error && (
            <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.08)', borderRadius: 6, fontSize: 12, color: '#DC2626' }}>{error}</div>
          )}

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={() => { setShowNew(false); resetForm(); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!balanced || inputTotal <= 0}>Confirm Production</Button>
          </div>
        </div>
      </Modal>

      {/* Output Add/Edit Modal — reuses NewProductModal (Kategorie + Brand + Name +
          dyn. Attribute + Condition + Photos + Tax-Scheme). Versteckt Felder, die
          für Production nicht relevant sind (Purchase Price wird separat als
          "Value" auf der Karte erfasst). */}
      <NewProductModal
        open={outputModalOpen}
        onClose={() => { setOutputModalOpen(false); setEditingOutputKey(null); }}
        onSubmit={handleOutputSubmit}
        initial={editingOutput?.spec}
        title={editingOutput ? 'Edit Output Product' : 'New Output Product'}
        submitLabel={editingOutput ? 'Update' : 'Add to Production'}
        hint="Pick category → brand/name + dynamic attributes from the category. Enter the production value on the card afterwards."
        hideFields={{
          purchasePrice: true,
          salePrice: true,
          paidFrom: true,
          supplier: true,
          quantity: true,
          storageLocation: true,
        }}
      />

      <Modal open={!!confirmDelete} onClose={() => setConfirmDelete(null)} title="Delete Production Record" width={380}>
        <p style={{ fontSize: 14, color: '#4B5563', marginBottom: 20 }}>
          Delete this record? This removes only the log entry — previously created output products remain in inventory.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => { if (confirmDelete) { deleteRecord(confirmDelete); setConfirmDelete(null); } }}>Delete</Button>
        </div>
      </Modal>
    </PageLayout>
  );
}

// ─── Clickable List Row ─────────────────────────────────────────

function ProductionRow({
  record, onOpen, onDelete,
}: {
  record: import('@/core/models/types').ProductionRecord;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr 0.6fr 0.6fr 1fr 2fr 0.4fr',
        gap: 12, padding: '12px 16px', alignItems: 'center',
        borderBottom: '1px solid rgba(229,225,214,0.6)',
        cursor: 'pointer',
        background: hovered ? '#F8FAFB' : 'transparent',
      }}
    >
      <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{record.recordNumber}</span>
      <span style={{ fontSize: 12, color: '#4B5563' }}>{record.productionDate}</span>
      <span style={{ fontSize: 12, color: '#DC2626' }}>−{record.inputs.length}</span>
      <span style={{ fontSize: 12, color: '#16A34A' }}>+{record.outputs.length}</span>
      <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}><Bhd v={record.totalValue}/></span>
      <span style={{ fontSize: 12, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{record.notes || '—'}</span>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="cursor-pointer"
        style={{ background: 'none', border: 'none', color: '#6B7280' }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ─── Output Summary Card ────────────────────────────────────────

function OutputCard({
  index, draft, categories, inputTotal, onEdit, onRemove, onValueChange, onAutofill,
}: {
  index: number;
  draft: OutputDraft;
  categories: Category[];
  inputTotal: number;
  onEdit: () => void;
  onRemove: () => void;
  onValueChange: (v: number) => void;
  onAutofill: () => void;
}) {
  const cat = categories.find(c => c.id === draft.spec.categoryId);
  const headerLine = `${draft.spec.brand || ''} ${draft.spec.name || ''}`.trim() || '(unnamed)';
  // Specs als Pills — kategorie-spezifische Attribute aus dem dyn. Schema.
  const specs = useMemo(() => {
    // We need a fake Product because getProductSpecs expects Product — Partial works
    // because we only access fields that exist.
    return getProductSpecs(draft.spec as Product, categories, { prominentOnly: false, includeSku: true, includeCondition: true });
  }, [draft.spec, categories]);
  const hasImages = (draft.spec.images || []).length > 0;

  return (
    <div
      style={{
        border: '1px solid #E5E9EE',
        borderRadius: 12,
        padding: 14,
        background: '#FBFBFC',
        display: 'grid',
        gridTemplateColumns: '64px 1fr 220px auto',
        gap: 14,
        alignItems: 'center',
      }}
    >
      {/* Thumbnail / Index */}
      <div style={{
        width: 64, height: 64, borderRadius: 8,
        background: '#F2F7FA', display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', border: '1px solid #E5E9EE',
      }}>
        {hasImages ? (
          <img src={(draft.spec.images || [])[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 11, color: '#6B7280' }}>#{index + 1}</span>
        )}
      </div>

      {/* Summary */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {cat && (
            <span style={{ fontSize: 10, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {cat.name}
            </span>
          )}
          {draft.spec.sku && (
            <span className="font-mono" style={{ fontSize: 10, color: '#9CA3AF' }}>{draft.spec.sku}</span>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', marginBottom: 4 }}>{headerLine}</div>
        {specs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {specs.slice(0, 6).map((s, i) => (
              <span key={i} style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 999,
                background: '#F2F7FA', color: '#4B5563', border: '1px solid #E5E9EE',
              }}>
                <span style={{ color: '#9CA3AF' }}>{s.label}:</span> {s.value}
              </span>
            ))}
            {specs.length > 6 && (
              <span style={{ fontSize: 10, color: '#9CA3AF' }}>+{specs.length - 6} more</span>
            )}
          </div>
        )}
      </div>

      {/* Value Input */}
      <div>
        <label className="text-overline" style={{ marginBottom: 4, display: 'block', fontSize: 10 }}>Value (BHD)</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            step="0.001"
            min="0"
            value={draft.value || ''}
            placeholder="0.000"
            onChange={e => onValueChange(Number(e.target.value) || 0)}
            style={{
              flex: 1, padding: '8px 10px', fontSize: 14, fontFamily: 'monospace',
              background: '#FFFFFF', border: '1px solid #D5D9DE', borderRadius: 6,
              outline: 'none', textAlign: 'right',
            }}
          />
          {inputTotal > 0 && (
            <button
              type="button"
              onClick={onAutofill}
              title="Fill with remaining input value"
              style={{
                padding: '6px 10px', fontSize: 10, borderRadius: 999,
                border: '1px dashed #715DE3', background: 'transparent',
                color: '#715DE3', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Auto
            </button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button
          onClick={onEdit}
          title="Edit details"
          style={{
            padding: 6, border: '1px solid #E5E9EE', background: '#FFFFFF',
            borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Edit2 size={14} color="#0F0F10" />
        </button>
        <button
          onClick={onRemove}
          title="Remove output"
          style={{
            padding: 6, border: '1px solid #E5E9EE', background: '#FFFFFF',
            borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <Trash2 size={14} color="#DC2626" />
        </button>
      </div>
    </div>
  );
}

// Plan §Production — List + New Production Record modal
import { useEffect, useMemo, useState } from 'react';
import { Factory, Trash2 } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { SearchMultiSelect } from '@/components/ui/SearchSelect';
import { useProductionStore } from '@/stores/productionStore';
import { useProductStore } from '@/stores/productStore';

function fmt(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface OutputDraft {
  key: string;
  brand: string;
  name: string;
  sku: string;
  categoryId: string;
  value: number;
}

export function ProductionPage() {
  const { records, loadRecords, createRecord, deleteRecord } = useProductionStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();

  const [showNew, setShowNew] = useState(false);
  const [selectedInputIds, setSelectedInputIds] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<OutputDraft[]>([{ key: uid(), brand: '', name: '', sku: '', categoryId: 'cat-watch', value: 0 }]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function uid() { return Math.random().toString(36).slice(2, 10); }

  useEffect(() => { loadRecords(); loadProducts(); loadCategories(); }, [loadRecords, loadProducts, loadCategories]);

  const availableProducts = useMemo(() => products.filter(p => p.stockStatus === 'in_stock'), [products]);
  const inputTotal = useMemo(() => {
    const sel = new Set(selectedInputIds);
    return products.filter(p => sel.has(p.id)).reduce((s, p) => s + p.purchasePrice, 0);
  }, [products, selectedInputIds]);
  const outputTotal = useMemo(() => outputs.reduce((s, o) => s + (o.value || 0), 0), [outputs]);
  const balanced = Math.abs(inputTotal - outputTotal) <= 0.01;

  function resetForm() {
    setSelectedInputIds([]);
    setOutputs([{ key: uid(), brand: '', name: '', sku: '', categoryId: 'cat-watch', value: 0 }]);
    setNotes('');
    setError('');
  }

  function handleCreate() {
    setError('');
    if (selectedInputIds.length === 0) { setError('Select at least one input product.'); return; }
    const validOutputs = outputs.filter(o => o.brand && o.name && o.value > 0);
    if (validOutputs.length === 0) { setError('Define at least one output product with a value.'); return; }
    try {
      createRecord({
        notes: notes || undefined,
        inputProductIds: selectedInputIds,
        outputs: validOutputs.map(o => ({ categoryId: o.categoryId, brand: o.brand, name: o.name, value: o.value, sku: o.sku || undefined })),
      });
      setShowNew(false);
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 0.6fr 0.6fr 1fr 2fr 0.4fr', gap: 12, padding: '12px 16px', borderBottom: '1px solid #E5E1D6' }}>
            {['NUMBER', 'DATE', 'INPUTS', 'OUTPUTS', 'TOTAL', 'NOTES', ''].map(h => (
              <span key={h} className="text-overline">{h}</span>
            ))}
          </div>
          {records.map(r => (
            <div key={r.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 0.6fr 0.6fr 1fr 2fr 0.4fr',
              gap: 12, padding: '12px 16px', alignItems: 'center',
              borderBottom: '1px solid rgba(229,225,214,0.6)',
            }}>
              <span className="font-mono" style={{ fontSize: 12, color: '#0F0F10' }}>{r.recordNumber}</span>
              <span style={{ fontSize: 12, color: '#4B5563' }}>{r.productionDate}</span>
              <span style={{ fontSize: 12, color: '#DC2626' }}>−{r.inputs.length}</span>
              <span style={{ fontSize: 12, color: '#16A34A' }}>+{r.outputs.length}</span>
              <span className="font-mono" style={{ fontSize: 13, color: '#0F0F10' }}>{fmt(r.totalValue)}</span>
              <span style={{ fontSize: 12, color: '#6B7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.notes || '—'}</span>
              <button onClick={() => setConfirmDelete(r.id)} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280' }}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </Card>
      )}

      {/* New Record Modal */}
      <Modal open={showNew} onClose={() => { setShowNew(false); resetForm(); }} title="New Production Record (PRD)" width={780}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 12, color: '#6B7280' }}>
            Plan §Production §12: Gesamtwert bleibt identisch. Inputs werden entfernt, Outputs neu erstellt.
          </p>

          {/* Inputs */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>INPUT PRODUCTS (will be consumed)</span>
            <SearchMultiSelect
              label=""
              placeholder="Search inventory..."
              options={availableProducts.map(p => ({
                id: p.id, label: `${p.brand} ${p.name}`,
                subtitle: `${fmt(p.purchasePrice)} BHD`, meta: p.sku,
              }))}
              value={selectedInputIds}
              onChange={setSelectedInputIds}
            />
          </div>

          {/* Outputs */}
          <div>
            <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
              <span className="text-overline">OUTPUT PRODUCTS (new inventory)</span>
              <button onClick={() => setOutputs([...outputs, { key: uid(), brand: '', name: '', sku: '', categoryId: 'cat-watch', value: 0 }])}
                className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 12 }}>+ Add output</button>
            </div>
            <div style={{ border: '1px solid #E5E1D6', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1fr 1.5fr 1fr 0.3fr', gap: 8, padding: '8px 10px', background: '#EFECE2', borderBottom: '1px solid #E5E1D6' }}>
                {['BRAND', 'NAME', 'SKU', 'CATEGORY', 'VALUE (BHD)', ''].map(h => (
                  <span key={h} className="text-overline" style={{ fontSize: 10 }}>{h}</span>
                ))}
              </div>
              {outputs.map((o, idx) => (
                <div key={o.key} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1.6fr 1fr 1.5fr 1fr 0.3fr', gap: 8, padding: '8px 10px', borderBottom: idx < outputs.length - 1 ? '1px solid #E5E1D6' : 'none', alignItems: 'center' }}>
                  <input placeholder="Brand" value={o.brand} onChange={e => setOutputs(os => os.map(x => x.key === o.key ? { ...x, brand: e.target.value } : x))}
                    className="outline-none" style={{ padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }} />
                  <input placeholder="Name" value={o.name} onChange={e => setOutputs(os => os.map(x => x.key === o.key ? { ...x, name: e.target.value } : x))}
                    className="outline-none" style={{ padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }} />
                  <input placeholder="SKU" value={o.sku} onChange={e => setOutputs(os => os.map(x => x.key === o.key ? { ...x, sku: e.target.value } : x))}
                    className="outline-none" style={{ padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }} />
                  <select value={o.categoryId} onChange={e => setOutputs(os => os.map(x => x.key === o.key ? { ...x, categoryId: e.target.value } : x))}
                    style={{ padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }}>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <input type="number" step="0.01" placeholder="0" value={o.value || ''} onChange={e => setOutputs(os => os.map(x => x.key === o.key ? { ...x, value: parseFloat(e.target.value) || 0 } : x))}
                    className="outline-none font-mono" style={{ padding: '6px 8px', fontSize: 12, background: 'transparent', border: '1px solid #D5D1C4', borderRadius: 4, color: '#0F0F10' }} />
                  {outputs.length > 1 && (
                    <button onClick={() => setOutputs(os => os.filter(x => x.key !== o.key))} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#DC2626', fontSize: 14 }}>×</button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Input label="NOTES" placeholder="Optional" value={notes} onChange={e => setNotes(e.target.value)} />

          {/* Balance check */}
          <div style={{
            padding: '12px 14px',
            background: balanced ? 'rgba(22,163,74,0.06)' : 'rgba(220,38,38,0.06)',
            border: `1px solid ${balanced ? '#16A34A33' : '#DC262633'}`,
            borderRadius: 8,
          }}>
            <div className="flex justify-between" style={{ fontSize: 13 }}>
              <span style={{ color: '#6B7280' }}>Input Value</span>
              <span className="font-mono" style={{ color: '#DC2626' }}>− {fmt(inputTotal)} BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 13, marginTop: 4 }}>
              <span style={{ color: '#6B7280' }}>Output Value</span>
              <span className="font-mono" style={{ color: '#16A34A' }}>+ {fmt(outputTotal)} BHD</span>
            </div>
            <div className="flex justify-between" style={{ fontSize: 14, marginTop: 8, paddingTop: 8, borderTop: '1px solid #E5E1D6' }}>
              <span style={{ color: balanced ? '#16A34A' : '#DC2626', fontWeight: 500 }}>
                {balanced ? 'Balanced ✓' : 'Out of balance'}
              </span>
              <span className="font-mono" style={{ color: balanced ? '#16A34A' : '#DC2626' }}>
                {fmt(Math.abs(inputTotal - outputTotal))} BHD
              </span>
            </div>
          </div>

          {error && (
            <div style={{ padding: '8px 12px', background: 'rgba(220,38,38,0.08)', borderRadius: 6, fontSize: 12, color: '#DC2626' }}>{error}</div>
          )}

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E1D6' }}>
            <Button variant="ghost" onClick={() => { setShowNew(false); resetForm(); }}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!balanced || inputTotal <= 0}>Confirm Production</Button>
          </div>
        </div>
      </Modal>

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

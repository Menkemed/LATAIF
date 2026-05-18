// Production Record Detail — zeigt was konsumiert (Inputs) und was erzeugt
// (Outputs) wurde, inkl. aller Attribute, Photos und Werte. Read-only,
// Production-Records sind unveränderlich (Audit-Trail).

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Trash2, Factory, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { Modal } from '@/components/ui/Modal';
import { useProductionStore } from '@/stores/productionStore';
import { useProductStore } from '@/stores/productStore';
import { getProductSpecs } from '@/core/utils/product-format';
import type { Category, Product, ProductionInputSnapshot } from '@/core/models/types';

function fmtDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function ProductionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { records, loadRecords, deleteRecord } = useProductionStore();
  const { products, categories, loadProducts, loadCategories } = useProductStore();
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => { if (records.length === 0) loadRecords(); loadProducts(); loadCategories(); }, [records.length, loadRecords, loadProducts, loadCategories]);

  const record = id ? records.find(r => r.id === id) : undefined;

  // Outputs: full Product rows via product_id JOIN (verbleiben in der products-Tabelle)
  const outputProducts = useMemo(() => {
    if (!record) return new Map<string, Product>();
    const m = new Map<string, Product>();
    for (const o of record.outputs) {
      const p = products.find(p => p.id === o.productId);
      if (p) m.set(o.id, p);
    }
    return m;
  }, [record, products]);

  if (!record) {
    return (
      <PageLayout
        title="Record not found"
        actions={<Button icon={<ArrowLeft size={14} />} onClick={() => navigate('/production')}>Back</Button>}
      >
        <div style={{ maxWidth: 600, margin: '40px auto', textAlign: 'center', color: '#6B7280' }}>
          The production record doesn't exist or was deleted.
        </div>
      </PageLayout>
    );
  }

  const totalInputs = record.inputs.reduce((s, i) => s + (i.inputValue || 0), 0);
  const totalOutputs = record.outputs.reduce((s, o) => s + (o.outputValue || 0), 0);

  return (
    <PageLayout
      title={`Production ${record.recordNumber}`}
      subtitle={`${fmtDate(record.productionDate)} · ${record.inputs.length} input${record.inputs.length === 1 ? '' : 's'} → ${record.outputs.length} output${record.outputs.length === 1 ? '' : 's'} · ${record.status}`}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/production')}>Back</Button>
          <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete Record</Button>
        </div>
      }
    >
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'grid', gap: 16 }}>
        {/* Summary KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <SummaryCard label="Input Value" valueBhd={totalInputs} icon={<ArrowDownCircle size={16} color="#DC2626" />} />
          <SummaryCard label="Output Value" valueBhd={totalOutputs} icon={<ArrowUpCircle size={16} color="#16A34A" />} />
          <SummaryCard label="Labor + Overhead" valueBhd={(record.laborCost || 0) + (record.overheadCost || 0)} icon={<Factory size={16} color="#6B7280" />} />
          <SummaryCard label="Total Cost" valueBhd={record.totalCost || totalInputs} icon={<Factory size={16} color="#0F0F10" />} />
        </div>

        {/* Inputs Section */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <ArrowDownCircle size={18} color="#DC2626" />
            <div style={{ fontSize: 14, fontWeight: 600 }}>Inputs (consumed)</div>
            <div style={{ fontSize: 12, color: '#6B7280' }}>· {record.inputs.length} items · <Bhd v={totalInputs} /> BHD</div>
          </div>
          {record.inputs.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>No inputs logged.</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {record.inputs.map((inp, idx) => (
                <ProductDisplayCard
                  key={inp.id}
                  index={idx + 1}
                  categories={categories}
                  snapshot={inp.snapshot}
                  value={inp.inputValue}
                  variant="input"
                />
              ))}
            </div>
          )}
        </Card>

        {/* Outputs Section */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <ArrowUpCircle size={18} color="#16A34A" />
            <div style={{ fontSize: 14, fontWeight: 600 }}>Outputs (created)</div>
            <div style={{ fontSize: 12, color: '#6B7280' }}>· {record.outputs.length} items · <Bhd v={totalOutputs} /> BHD</div>
          </div>
          {record.outputs.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#6B7280', fontSize: 13 }}>No outputs.</div>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {record.outputs.map((out, idx) => {
                const product = outputProducts.get(out.id);
                return (
                  <ProductDisplayCard
                    key={out.id}
                    index={idx + 1}
                    categories={categories}
                    snapshot={product ? productToSnapshot(product) : { brand: '(deleted product)', name: '' }}
                    value={out.outputValue}
                    variant="output"
                    productId={out.productId}
                    productStillExists={!!product}
                    onOpenProduct={() => navigate(`/collection/${out.productId}`)}
                  />
                );
              })}
            </div>
          )}
        </Card>

        {/* Costs Detail (if labor/overhead set) */}
        {((record.laborCost || 0) > 0 || (record.overheadCost || 0) > 0) && (
          <Card>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Additional Costs</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, fontSize: 13 }}>
              <div>
                <div style={{ color: '#6B7280', marginBottom: 4 }}>Labor</div>
                <div style={{ fontWeight: 600 }}><Bhd v={record.laborCost || 0} /> BHD</div>
              </div>
              <div>
                <div style={{ color: '#6B7280', marginBottom: 4 }}>Overhead</div>
                <div style={{ fontWeight: 600 }}><Bhd v={record.overheadCost || 0} /> BHD</div>
              </div>
              <div>
                <div style={{ color: '#6B7280', marginBottom: 4 }}>Total Cost</div>
                <div style={{ fontWeight: 600 }}><Bhd v={record.totalCost || 0} /> BHD</div>
              </div>
            </div>
          </Card>
        )}

        {/* Notes & Meta */}
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Notes & Meta</div>
          <div style={{ fontSize: 13, color: record.notes ? '#0F0F10' : '#9CA3AF', marginBottom: 12, whiteSpace: 'pre-wrap' }}>
            {record.notes || 'No notes.'}
          </div>
          <div style={{ display: 'flex', gap: 24, fontSize: 12, color: '#6B7280' }}>
            <div>
              <div style={{ marginBottom: 4 }}>Created at</div>
              <div style={{ color: '#0F0F10' }}>{fmtDate(record.createdAt)}</div>
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>Record No.</div>
              <div style={{ color: '#0F0F10', fontFamily: 'monospace' }}>{record.recordNumber}</div>
            </div>
            <div>
              <div style={{ marginBottom: 4 }}>Status</div>
              <div style={{ color: '#0F0F10' }}>{record.status}</div>
            </div>
          </div>
        </Card>
      </div>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Production Record" width={420}>
        <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 20, lineHeight: 1.6 }}>
          Delete this record? This removes only the log entry — previously consumed inputs stay deleted, and created output products remain in inventory.
        </p>
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => {
            if (record) deleteRecord(record.id);
            navigate('/production');
          }}>Delete</Button>
        </div>
      </Modal>
    </PageLayout>
  );
}

// ─── Helpers ────────────────────────────────────────────────────

function productToSnapshot(p: Product): ProductionInputSnapshot {
  return {
    categoryId: p.categoryId,
    brand: p.brand,
    name: p.name,
    sku: p.sku,
    condition: p.condition,
    attributes: p.attributes,
    images: p.images,
    purchasePrice: p.purchasePrice,
  };
}

function SummaryCard({ label, valueBhd, icon }: { label: string; valueBhd: number; icon: React.ReactNode }) {
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        {icon}
        <div className="text-overline">{label}</div>
      </div>
      <div style={{ fontSize: 20, fontWeight: 600 }}>
        <Bhd v={valueBhd} /> <span style={{ fontSize: 11, color: '#6B7280', fontWeight: 400 }}>BHD</span>
      </div>
    </Card>
  );
}

function ProductDisplayCard({
  index, categories, snapshot, value, variant, onOpenProduct, productStillExists,
}: {
  index: number;
  categories: Category[];
  snapshot?: ProductionInputSnapshot;
  value: number;
  variant: 'input' | 'output';
  productId?: string;
  productStillExists?: boolean;
  onOpenProduct?: () => void;
}) {
  const cat = snapshot?.categoryId ? categories.find(c => c.id === snapshot.categoryId) : undefined;
  const hasImages = (snapshot?.images || []).length > 0;
  const headerLine = `${snapshot?.brand || ''} ${snapshot?.name || ''}`.trim() || '(unnamed)';
  const specs = useMemo(() => {
    if (!snapshot) return [];
    // Adapter: getProductSpecs erwartet Product, wir füttern ein passendes Subset
    const fauxProduct = {
      categoryId: snapshot.categoryId,
      sku: snapshot.sku,
      condition: snapshot.condition,
      attributes: snapshot.attributes || {},
    } as Product;
    return getProductSpecs(fauxProduct, categories, { includeSku: true, includeCondition: true });
  }, [snapshot, categories]);

  const tone = variant === 'input' ? '#DC2626' : '#16A34A';
  const toneBg = variant === 'input' ? 'rgba(220,38,38,0.04)' : 'rgba(22,163,74,0.04)';

  return (
    <div
      style={{
        border: '1px solid #E5E9EE',
        borderRadius: 12,
        padding: 14,
        background: toneBg,
        display: 'grid',
        gridTemplateColumns: '72px 1fr 140px',
        gap: 14,
        alignItems: 'center',
      }}
    >
      <div style={{
        width: 72, height: 72, borderRadius: 8,
        background: '#FFFFFF', border: '1px solid #E5E9EE',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
      }}>
        {hasImages ? (
          <img src={(snapshot?.images || [])[0]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 12, color: '#6B7280' }}>#{index}</span>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          {cat && (
            <span style={{ fontSize: 10, fontWeight: 600, color: tone, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              {cat.name}
            </span>
          )}
          {snapshot?.sku && (
            <span className="font-mono" style={{ fontSize: 10, color: '#9CA3AF' }}>{snapshot.sku}</span>
          )}
          {variant === 'output' && productStillExists && onOpenProduct && (
            <button
              onClick={onOpenProduct}
              style={{
                marginLeft: 'auto', padding: '2px 10px', fontSize: 10, borderRadius: 999,
                border: '1px solid #E5E9EE', background: '#FFFFFF', color: '#6B7280',
                cursor: 'pointer',
              }}
            >
              Open Product →
            </button>
          )}
          {variant === 'output' && !productStillExists && (
            <span style={{ marginLeft: 'auto', fontSize: 10, color: '#9CA3AF', fontStyle: 'italic' }}>
              product no longer in inventory
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10', marginBottom: 4 }}>{headerLine}</div>
        {specs.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {specs.slice(0, 8).map((s, i) => (
              <span key={i} style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 999,
                background: '#FFFFFF', color: '#4B5563', border: '1px solid #E5E9EE',
              }}>
                <span style={{ color: '#9CA3AF' }}>{s.label}:</span> {s.value}
              </span>
            ))}
            {specs.length > 8 && (
              <span style={{ fontSize: 10, color: '#9CA3AF' }}>+{specs.length - 8} more</span>
            )}
          </div>
        )}
      </div>

      <div style={{ textAlign: 'right' }}>
        <div className="text-overline" style={{ marginBottom: 4, fontSize: 10 }}>
          {variant === 'input' ? 'Input Value' : 'Output Value'}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, color: tone, fontFamily: 'monospace' }}>
          {variant === 'input' ? '− ' : '+ '}<Bhd v={value} />
        </div>
        <div style={{ fontSize: 10, color: '#6B7280', marginTop: 2 }}>BHD</div>
      </div>
    </div>
  );
}

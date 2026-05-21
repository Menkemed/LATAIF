// Back-to-Back Beschaffung — Bearbeiten einer kundenseitigen Order-Produkt-Zeile.
// Produkt (Existing/New), Menge, Preis, Beschreibung. Produkt-Wechsel ist
// gesperrt sobald die Zeile via aktivem Purchase beschafft wurde (productLocked).
import { useEffect, useMemo, useState } from 'react';
import { Edit3 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { ProductHoverCard } from '@/components/products/ProductHoverCard';
import { productSearchText } from '@/core/utils/product-format';
import { NewProductModal } from '@/components/products/NewProductModal';
import { useProductStore } from '@/stores/productStore';
import type { OrderLine, Product } from '@/core/models/types';

export interface OrderLineEditPatch {
  productId?: string;
  newProduct?: Partial<Product>;
  description?: string;
  quantity?: number;
  unitPrice?: number;
}

interface Props {
  open: boolean;
  line: OrderLine | null;
  /** true = Zeile via aktivem Purchase beschafft → Produkt-Wechsel gesperrt. */
  productLocked: boolean;
  onClose: () => void;
  onSave: (patch: OrderLineEditPatch) => void;
}

export function OrderLineEditModal({ open, line, productLocked, onClose, onSave }: Props) {
  const { products, categories } = useProductStore();

  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [productId, setProductId] = useState('');
  const [newProduct, setNewProduct] = useState<Partial<Product> | undefined>(undefined);
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [unitPrice, setUnitPrice] = useState(0);
  const [showNewProductModal, setShowNewProductModal] = useState(false);

  useEffect(() => {
    if (!open || !line) return;
    setMode('existing');
    setProductId(line.productId || '');
    setNewProduct(undefined);
    setDescription(line.description || '');
    setQuantity(Math.max(1, line.quantity || 1));
    setUnitPrice(line.unitPrice || 0);
    setShowNewProductModal(false);
  }, [open, line]);

  const productOptions = useMemo(() => products.map(p => ({
    id: p.id,
    label: `${p.brand} ${p.name}${p.sku ? ' · ' + p.sku : ''}`,
    subtitle: (p.quantity ?? 0) > 0 ? `${p.quantity} auf Lager` : 'ausverkauft',
    searchText: productSearchText(p),
  })), [products]);

  function pickProduct(pid: string) {
    const p = products.find(pp => pp.id === pid);
    setProductId(pid);
    setNewProduct(undefined);
    if (p) setDescription(`${p.brand} ${p.name}`);
  }

  function handleNewProductSaved(prod: Partial<Product>) {
    setNewProduct(prod);
    setProductId('');
    setDescription(`${prod.brand || ''} ${prod.name || ''}`.trim());
    setShowNewProductModal(false);
  }

  function save() {
    const patch: OrderLineEditPatch = {
      description,
      quantity: Math.max(1, quantity),
      unitPrice,
    };
    if (!productLocked) {
      if (mode === 'new' && newProduct) {
        patch.newProduct = newProduct;
      } else if (mode === 'existing' && productId && productId !== line?.productId) {
        patch.productId = productId;
      }
    }
    onSave(patch);
  }

  if (!line) return null;

  return (
    <>
      <Modal open={open} onClose={onClose} title="Order-Position bearbeiten" width={480}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {productLocked ? (
            <div style={{
              padding: '10px 12px', borderRadius: 6, fontSize: 12,
              background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.3)', color: '#92400E',
            }}>
              Diese Position wurde bereits beim Supplier beschafft — das Produkt ist
              gesperrt. Menge, Preis &amp; Beschreibung sind weiter editierbar; fuer einen
              Produkt-Wechsel zuerst den Purchase stornieren.
            </div>
          ) : (
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PRODUKT</span>
              <div className="flex gap-2" style={{ marginBottom: 8 }}>
                {(['existing', 'new'] as const).map(m => {
                  const active = mode === m;
                  return (
                    <button key={m} type="button"
                      onClick={() => {
                        setMode(m);
                        if (m === 'new') setShowNewProductModal(true);
                      }}
                      className="cursor-pointer rounded"
                      style={{
                        padding: '6px 14px', fontSize: 12, flex: 1,
                        border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                        color: active ? '#0F0F10' : '#6B7280',
                        background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                      }}>
                      {m === 'existing' ? 'Existing Product' : 'New Product'}
                    </button>
                  );
                })}
              </div>
              {mode === 'existing' ? (
                <SearchSelect
                  placeholder="Produkt waehlen..."
                  options={productOptions}
                  value={productId}
                  onChange={pickProduct}
                  renderPreview={id => {
                    const p = products.find(x => x.id === id);
                    return p ? <ProductHoverCard product={p} categories={categories} /> : null;
                  }}
                />
              ) : newProduct ? (
                <div className="flex items-center justify-between" style={{
                  padding: '8px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE',
                  borderRadius: 6, fontSize: 13, color: '#0F0F10',
                }}>
                  <span>{newProduct.brand} <span style={{ color: '#4B5563' }}>{newProduct.name}</span></span>
                  <button onClick={() => setShowNewProductModal(true)} title="Produkt-Details bearbeiten"
                    className="cursor-pointer flex items-center gap-1"
                    style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 11 }}>
                    <Edit3 size={12} /> Edit
                  </button>
                </div>
              ) : (
                <button onClick={() => setShowNewProductModal(true)}
                  className="cursor-pointer"
                  style={{
                    width: '100%', padding: '8px 12px', fontSize: 13, textAlign: 'left',
                    border: '1px dashed #D5D9DE', borderRadius: 6, background: '#FFFFFF', color: '#6B7280',
                  }}>
                  + Neues Produkt definieren…
                </button>
              )}
            </div>
          )}

          <Input label="BESCHREIBUNG" value={description}
            onChange={e => setDescription(e.target.value)} />

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="MENGE" type="number" step="1" value={quantity || ''}
              onChange={e => setQuantity(Math.max(1, parseInt(e.target.value) || 1))} />
            <Input label="NET PREIS / STUECK (BHD)" type="number" step="0.001" value={unitPrice || ''}
              onChange={e => setUnitPrice(parseFloat(e.target.value) || 0)} />
          </div>

          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
            <Button variant="primary" onClick={save}>Speichern</Button>
          </div>
        </div>
      </Modal>

      <NewProductModal
        open={showNewProductModal}
        onClose={() => setShowNewProductModal(false)}
        onSubmit={handleNewProductSaved}
        initial={newProduct ?? {
          categoryId: categories[0]?.id || '',
          brand: '', name: '', sku: '', condition: '',
          taxScheme: 'MARGIN', scopeOfDelivery: [], purchaseCurrency: 'BHD',
          attributes: {}, images: [],
        }}
        title="Neues Produkt — Artikel definieren"
        submitLabel="Artikel uebernehmen"
        hint={<>Das Produkt wird angelegt. Einkaufspreis + Lagerbestand kommen beim Wareneingang (Purchase).</>}
        hideFields={{ purchasePrice: true, salePrice: true, paidFrom: true, supplier: true, quantity: true }}
      />
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Verkaufs- und Mindestpreis direkt aus der Collection — derselbe Weg wie die Maske der Artikelseite: am Primary
// `editProductTextDurably`, am zweiten Rechner der geprüfte Befehl `products.update` gegen den gesehenen Stand.
// Hier steht keine eigene Regel: Sperren und Berechtigung prüft das Haus, eine Ablehnung zeigt ihren Grund.
// Der Einkaufspreis wird nur angezeigt; er ändert sich über Purchase → Edit.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import { useProductStore, type EditProductResult } from '@/stores/productStore';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import { updatePayload, PRODUCT_UPDATE_FIELDS } from '@/core/data/write-payloads';
import { productDisplayName } from '@/core/products/display-name';

const feld = (v: number | null | undefined): string => (v === null || v === undefined || v === 0 ? '' : String(v));

export function ProductPriceModal({ productId, onClose }: { productId: string | null; onClose: () => void }) {
  const { products, editProductTextDurably, loadProducts } = useProductStore();
  const product = productId ? products.find((p) => p.id === productId) : undefined;
  const aendern = useSharedWrite<EditProductResult>('products.update');
  const [vk, setVk] = useState('');
  const [mind, setMind] = useState('');
  const [fehler, setFehler] = useState('');

  useEffect(() => {
    if (!product) return;
    setVk(feld(product.plannedSalePrice)); setMind(feld(product.minSalePrice)); setFehler('');
  }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!productId || !product) return null;
  const artikel = product;
  const zahl = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s));

  async function speichern() {
    const neuVk = zahl(vk);
    const neuMind = zahl(mind);
    if ((neuVk !== undefined && (!Number.isFinite(neuVk) || neuVk < 0)) || (neuMind !== undefined && (!Number.isFinite(neuMind) || neuMind < 0))) {
      setFehler('Prices must be numbers of 0 or more.');
      return;
    }
    setFehler('');
    const preise = { plannedSalePrice: neuVk, minSalePrice: neuMind };
    const diff = updatePayload(artikel as unknown as Record<string, unknown>, { ...artikel, ...preise } as Record<string, unknown>, PRODUCT_UPDATE_FIELDS);
    if (Object.keys(diff).length === 0) { onClose(); return; }
    const r = await aendern.save({
      // Die erwartete Marge leitet das Haus aus dem Verkaufspreis ab (`buildProductEditColumns`).
      local: async () => await editProductTextDurably(artikel.id, preise),
      remote: () => ({ id: artikel.id, ...diff, ...(artikel.updatedAt ? { expectedUpdatedAt: artikel.updatedAt } : {}) }),
      shape: () => ({ status: 'edited' } as EditProductResult),
    });
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    const ergebnis = r.value as EditProductResult;
    if (ergebnis.status !== 'edited') {
      setFehler(('message' in ergebnis && ergebnis.message) || ('errorCode' in ergebnis ? String(ergebnis.errorCode) : 'Nothing was saved.'));
      return;
    }
    loadProducts();
    onClose();
  }

  const neuVk = zahl(vk);
  return (
    <Modal open onClose={onClose} title="Edit prices" width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} data-collection-price-modal={artikel.id}>
        <div style={{ fontSize: 13, color: '#0F0F10' }}>
          {productDisplayName(artikel)}{artikel.sku ? <span className="font-mono" style={{ color: '#4B5563', marginLeft: 8, fontSize: 12 }}>{artikel.sku}</span> : null}
        </div>
        <WriteError text={fehler} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <Input label="SALE PRICE (BHD)" type="number" step="0.001" min="0" placeholder="Listing / target price"
            value={vk} onChange={(e) => setVk(e.target.value)} data-collection-price-sale />
          <Input label="MIN SALE PRICE (BHD)" type="number" step="0.001" min="0" placeholder="Negotiation floor"
            value={mind} onChange={(e) => setMind(e.target.value)} data-collection-price-min />
        </div>
        <div className="flex justify-between" style={{ fontSize: 12, color: '#4B5563' }} data-collection-price-cost>
          <span>Purchase price: <span className="font-mono" style={{ color: '#0F0F10' }}><Bhd v={artikel.purchasePrice}/> BHD</span> — changed only through Purchase → Edit.</span>
        </div>
        {neuVk !== undefined && Number.isFinite(neuVk) && neuVk > 0 && (
          <div style={{ fontSize: 12, color: '#4B5563' }} data-collection-price-margin>
            Expected margin <span className="font-mono" style={{ color: neuVk - artikel.purchasePrice >= 0 ? '#15803D' : '#B91C1C' }}><Bhd v={neuVk - artikel.purchasePrice}/> BHD</span>
          </div>
        )}
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void speichern()} disabled={aendern.busy} data-collection-price-save>Save</Button>
        </div>
      </div>
    </Modal>
  );
}

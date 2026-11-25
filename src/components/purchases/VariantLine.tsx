// ═════════════════════════════════════════════════════════════════
// PURCHASE ADD VARIANT — „Variant of existing" in Einkauf (New Purchase) UND Bearbeitung (Edit Purchase): EINE Regel für
// die Auswahl des Ausgangsartikels, die Vorbelegung, die Bildübernahme (nur bei gleichem Karat & Color von selbst) und
// die Absicht, die der Primary prüft. Kein Datenbankzugriff — nur Store-Daten, die die Masken ohnehin geladen haben.
// ═════════════════════════════════════════════════════════════════

import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { SearchSelect } from '@/components/ui/SearchSelect';
import type { Category, Product } from '@/core/models/types';
import { productDisplayName } from '@/core/products/display-name';
import { isSystemArticle, mayJoinModel, type VariantIntent } from '@/core/products/product-models';
import { loadVariantGallery } from '@/core/products/product-models-primary';
import { modelMembers } from '@/core/products/product-models-view';
import { sameKarat, variantSeed, karatSearchTerms } from '@/core/products/variant-seed';
import { productSearchText } from '@/core/utils/product-format';

/** Die Variante einer Zeile. photo: 'auto' = Bild des Originals übernehmen, solange Karat & Color gleich ist. */
export interface VariantDraft { anchorId: string; modelKey: string | null; label: string; excludeIds: string[]; photo: 'auto' | 'yes' | 'no' }

/** Wählbar: Eigenware, die in ein Modell darf (keine Kommission, keine System-/erledigten Artikel). */
export function variantAnchorOptions(products: readonly Product[]) {
  return products
    .filter((p) => String(p.sourceType || 'OWN').toUpperCase() === 'OWN' && !isSystemArticle(p.id, p.categoryId || '') && mayJoinModel(String(p.stockStatus)))
    .map((p) => ({ id: p.id, label: productDisplayName(p), subtitle: p.sku || undefined, searchText: [productSearchText(p), ...karatSearchTerms(p)].join(' ') }));
}

export function makeVariantDraft(anchor: Product, products: readonly Product[], models: Readonly<Record<string, string>>): VariantDraft {
  const key = models[anchor.id] ?? null;
  const geschwister = key ? modelMembers(products, models, key).map((m) => m.id) : [];
  return { anchorId: anchor.id, modelKey: key, label: productDisplayName(anchor), excludeIds: [...new Set([anchor.id, ...geschwister])], photo: 'auto' };
}

/** Die Vorbelegung der Maske für eine Variante (EINE Regel, `variant-seed`). */
export function variantInitial(draft: VariantDraft, products: readonly Product[], categories: readonly Category[]): Partial<Product> | undefined {
  const t = products.find((p) => p.id === draft.anchorId);
  if (!t) return undefined;
  return variantSeed(t, categories.find((c) => c.id === t.categoryId)?.conditionOptions?.[0] || '');
}

/**
 * Trägt das Original sein Foto noch im alten Format (in `products.images`)? Darauf kann eine Variante nicht verweisen —
 * es ist kein Medium. Dann gibt es keine Übernahme (Hinweis: später über „Merge photos", das zuerst umzieht).
 */
export function anchorHasOldFormatPhoto(anchor: Product | undefined): boolean {
  return Array.isArray(anchor?.images) && (anchor!.images as unknown[]).length > 0;
}

/** Wird das Bild des Originals übernommen? Eigene Fotos haben Vorrang; sonst von selbst nur bei gleichem Karat & Color. */
export function variantPhotoOn(draft: VariantDraft | undefined, newProduct: Partial<Product> | undefined, products: readonly Product[]): boolean {
  if (!draft || (newProduct?.images || []).length > 0) return false;
  if (anchorHasOldFormatPhoto(products.find((p) => p.id === draft.anchorId))) return false;
  if (draft.photo !== 'auto') return draft.photo === 'yes';
  return sameKarat(products.find((p) => p.id === draft.anchorId), newProduct ?? null);
}

/** Die Absicht für den Primary — das Bild wird VOR dem Auftrag gelesen; nicht lesbar → Fehlertext statt still ohne Bild. */
export async function variantIntentFor(draft: VariantDraft, newProduct: Partial<Product> | undefined, products: readonly Product[]): Promise<VariantIntent | string> {
  let pick: string | null = null;
  if (variantPhotoOn(draft, newProduct, products)) {
    const g = await loadVariantGallery(draft.anchorId);
    if (!g) return 'The photo of the original could not be read from the main computer. Nothing was saved — please try again.';
    // Gewünscht, aber kein Medium da (altes Format oder kein Foto): nicht still ohne Bild speichern.
    if (!g.mediaIds[0]) return 'The original has no photo that can be referenced (old format or none). Untick “Use the photo of the original” or add a photo. Nothing was saved.';
    pick = g.mediaIds[0];
  }
  return draft.modelKey ? { modelKey: draft.modelKey, pickMediaId: pick } : { anchorProductId: draft.anchorId, pickMediaId: pick };
}

/** Unter der Zeile: Herkunft, Modell, Bildübernahme mit Warnung bei anderem Karat & Color. */
export function VariantLineInfo({ draft, newProduct, products, dataKey, onPhoto }: {
  draft: VariantDraft; newProduct: Partial<Product> | undefined; products: readonly Product[]; dataKey: string | number;
  onPhoto: (on: boolean) => void;
}) {
  const anchor = products.find((p) => p.id === draft.anchorId);
  const eigeneFotos = (newProduct?.images || []).length > 0;
  const altFormat = anchorHasOldFormatPhoto(anchor);
  const anders = !!newProduct && !sameKarat(anchor, newProduct);
  const an = variantPhotoOn(draft, newProduct, products);
  return (
    <div data-line-variant={dataKey} style={{ padding: '6px 12px 10px 40px', fontSize: 12, color: '#4B5563', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span>Variant of <b>{draft.label}</b>{draft.modelKey ? ' — joins its model.' : ' — not in a model yet: saving creates the model with both items.'}</span>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={an} disabled={eigeneFotos || altFormat} data-line-variant-photo={dataKey} onChange={(e) => onPhoto(e.target.checked)} />
        <span>Use the photo of the original (no upload, no new file — only a reference).{eigeneFotos ? ' Not used: this piece has its own photo.' : ''}
          {altFormat && !eigeneFotos ? ' Not possible: the original’s photo is still in the old format — add a photo here, or use “Merge photos” later.' : ''}</span>
      </label>
      {anders && !eigeneFotos && (
        <span data-line-variant-photo-warning={dataKey} style={{ color: '#B45309' }}>
          Karat &amp; Color differs from the original ({String(((anchor?.attributes ?? {}) as Record<string, unknown>).karat ?? '—')}).
          {an ? ' The photo may show a different gold colour — use it only if it really fits.' : ' Its photo is not taken over unless you tick the box.'}
        </span>
      )}
    </div>
  );
}

/** Den Ausgangsartikel aus Collections wählen (nur Eigenware). */
export function VariantPickerModal({ open, products, onPick, onClose }: {
  open: boolean; products: readonly Product[]; onPick: (productId: string) => void; onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Variant of existing item" width={520}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-variant-picker>
        <p style={{ fontSize: 13, color: '#4B5563' }}>
          Choose the existing item. Its shared details are taken over; this piece gets its own SKU, size, weight, Karat &amp; Color and prices.
          Own stock only — consignment pieces are added through the consignment intake.
        </p>
        <SearchSelect placeholder="Search collection..." options={variantAnchorOptions(products)} value="" matchAllWords onChange={(pid) => { if (pid) onPick(pid); }} />
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

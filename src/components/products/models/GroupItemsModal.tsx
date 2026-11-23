// ARTIKELVARIANTEN — „Group items": vorhandene Artikel manuell zu einem Modell verbinden (neu oder zu einem bestehenden
// Modell hinzufügen). Nur fachlich passende Artikel sind wählbar (gleiche Filiale, Kategorie, Marke, Warenart; eigene Ware
// und Kommission getrennt); Vorschau vor dem Speichern. Gespeichert wird NUR die Zuordnung (+ Audit) — am Primary direkt,
// am PC2 als Fernauftrag `product_models.group`.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { WriteError } from '@/components/shared/WriteError';
import { useProductStore } from '@/stores/productStore';
import { useAuthStore } from '@/stores/authStore';
import { useSharedWrites } from '@/core/data/shared-write';
import { modelCompatibilityReason, isSystemArticle, mayJoinModel, PRODUCT_MODELS_GROUP_OP, type GroupInput, type GroupResult } from '@/core/products/product-models';
import { groupProductsOnPrimary } from '@/core/products/product-models-primary';
import { candidateOfProduct, modelMembers, sizeOf, summarizeModel, weightOf } from '@/core/products/product-models-view';
import { matchesDeep } from '@/core/utils/deep-search';
import { productDisplayName } from '@/core/products/display-name';
import type { Product } from '@/core/models/types';

interface Props {
  open: boolean;
  onClose: () => void;
  /** vorausgewählte Artikel (z. B. „Mit anderen Artikeln gruppieren" auf der Artikelseite) */
  initialSelection?: string[];
  /** bestehendes Modell, dem Artikel hinzugefügt werden */
  targetKey?: string | null;
  onDone?: (modelKey: string) => void;
}

export function GroupItemsModal({ open, onClose, initialSelection, targetKey, onDone }: Props) {
  const { products, productModels, categories, loadProducts } = useProductStore();
  const branchId = useAuthStore((s) => s.session?.branchId) ?? '';
  const w = useSharedWrites();
  const [sel, setSel] = useState<string[]>([]);
  const [step, setStep] = useState<'select' | 'preview'>('select');
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    setSel(initialSelection ? [...initialSelection] : []);
    setStep('select');
    setQ('');
    w.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const target = targetKey ?? null;
  const targetMembers = useMemo(() => (target ? modelMembers(products, productModels, target) : []), [products, productModels, target]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const anchor: Product | undefined = targetMembers[0] ?? (sel[0] ? byId.get(sel[0]) : undefined);

  const rows = useMemo(() => {
    const base = products.filter((p) => !isSystemArticle(p.id, p.categoryId || '') && mayJoinModel(String(p.stockStatus)));
    const hit = q.trim() ? base.filter((p) => matchesDeep(p, q, [categories.find((c) => c.id === p.categoryId)])) : base;
    return hit.map((p) => {
      const inTarget = target ? productModels[p.id] === target : false;
      let reason: string | null = null;
      if (!inTarget) {
        if (productModels[p.id] && productModels[p.id] !== target) reason = 'Already in another model';
        else if (anchor && anchor.id !== p.id) reason = modelCompatibilityReason(candidateOfProduct(anchor, branchId), candidateOfProduct(p, branchId));
      }
      return { p, inTarget, reason };
    }).sort((a, b) => Number(!!a.reason) - Number(!!b.reason));
  }, [products, productModels, q, categories, target, anchor, branchId]);

  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const enough = target ? sel.length >= 1 : sel.length >= 2;
  const resulting = useMemo(() => [...targetMembers, ...sel.map((id) => byId.get(id)).filter((p): p is Product => !!p && !targetMembers.includes(p))], [targetMembers, sel, byId]);
  const summary = resulting.length ? summarizeModel(target ?? 'new', resulting) : null;
  const namesDiffer = new Set(resulting.map((p) => p.name.trim())).size > 1;

  async function save() {
    const input: GroupInput = { productIds: sel, modelKey: target };
    const r = await w.save<GroupResult>(PRODUCT_MODELS_GROUP_OP, {
      local: () => groupProductsOnPrimary(input),
      remote: () => ({ productIds: sel, ...(target ? { modelKey: target } : {}) }),
    });
    if (r.kind !== 'ok') return;
    if (w.remote) loadProducts();
    const key = String((r.value as unknown as { modelKey?: string })?.modelKey ?? target ?? '');
    onDone?.(key);
    onClose();
  }

  const title = target ? `Add items to model${summary ? ` — ${summary.name}` : ''}` : 'Group items into a model';
  return (
    <Modal open={open} onClose={onClose} title={title} width={760}>
      <div data-group-items-modal style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '68vh', overflowY: 'auto', paddingRight: 4 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['select', 'preview'] as const).map((s, i) => (
            <span key={s} style={{ fontSize: 12, padding: '4px 10px', borderRadius: 999, border: `1px solid ${step === s ? '#715DE3' : '#D5D9DE'}`, color: step === s ? '#5B3DCC' : '#6B7280', background: step === s ? 'rgba(113,93,227,0.09)' : '#FFFFFF' }}>
              {i + 1} {s === 'select' ? 'Choose items' : 'Preview'}
            </span>
          ))}
        </div>

        {step === 'select' ? (
          <>
            <div style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.5, padding: '8px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8 }}>
              Only matching items can be grouped: same branch, category, brand and item type — own stock and consignment are never mixed.
              Size, weight, price and SKU stay separate per item; several pieces of the same size are allowed. Sold items may stay in the model (visible, not counted as stock).
            </div>
            <input className="w-full" placeholder="Search by brand, name, SKU…" value={q} onChange={(e) => setQ(e.target.value)} data-group-search
              style={{ padding: '8px 12px', border: '1px solid #D5D9DE', borderRadius: 8, fontSize: 13 }} />
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead><tr style={{ background: '#FAFBFC', color: '#6B7280', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  <th style={{ padding: 8 }} /><th style={{ padding: 8, textAlign: 'left' }}>SKU</th><th style={{ padding: 8, textAlign: 'left' }}>Item</th>
                  <th style={{ padding: 8, textAlign: 'left' }}>Size</th><th style={{ padding: 8, textAlign: 'right' }}>Weight</th><th style={{ padding: 8, textAlign: 'left' }}>Status</th>
                  <th style={{ padding: 8, textAlign: 'left' }}>Note</th>
                </tr></thead>
                <tbody>
                  {rows.slice(0, 300).map(({ p, inTarget, reason }) => {
                    const checked = inTarget || sel.includes(p.id);
                    const disabled = inTarget || (!!reason && !sel.includes(p.id));
                    return (
                      <tr key={p.id} data-group-row={p.id} style={{ borderTop: '1px solid #E5E9EE', color: disabled ? '#9CA3AF' : '#0F0F10' }}>
                        <td style={{ padding: 8 }}>
                          <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(p.id)} aria-label={`select ${p.sku || p.name}`} data-group-check={p.id} />
                        </td>
                        <td className="font-mono" style={{ padding: 8, whiteSpace: 'nowrap' }}>{p.sku || '—'}</td>
                        <td style={{ padding: 8 }}>{productDisplayName(p)}{p.sourceType === 'CONSIGNMENT' ? <span style={{ color: '#3F5B7A' }}> · Consignment</span> : null}</td>
                        <td style={{ padding: 8 }}>{sizeOf(p) || '—'}</td>
                        <td className="font-mono" style={{ padding: 8, textAlign: 'right' }}>{weightOf(p) != null ? `${weightOf(p)!.toFixed(2)} g` : '—'}</td>
                        <td style={{ padding: 8 }}><StatusDot status={p.stockStatus} /></td>
                        <td style={{ padding: 8, fontSize: 11, color: inTarget ? '#6B7280' : '#9B2C2C' }}>{inTarget ? 'in this model' : reason ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between" style={{ gap: 8 }}>
              <span style={{ fontSize: 12, color: '#6B7280' }}>{sel.length} selected{target ? ` · model has ${targetMembers.length} items` : ''}{!target && sel.length < 2 ? ' — choose at least two items' : ''}</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button variant="primary" disabled={!enough} onClick={() => setStep('preview')} data-group-preview>Preview</Button>
              </div>
            </div>
          </>
        ) : (
          <>
            {summary && (
              <div style={{ border: '1px solid #E5E9EE', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span className="text-overline">{summary.brand ? `${summary.brand} · MODEL` : 'MODEL'}</span>
                <span className="font-display" style={{ fontSize: 18 }}>{summary.name}</span>
                <span style={{ fontSize: 12, color: '#4B5563' }}>
                  {summary.members.length} items · {summary.available.length} available{summary.sold ? ` · ${summary.sold} sold` : ''} · sizes {summary.sizes.map((z) => `${z.size} ×${z.count}`).join(', ') || '—'}
                </span>
              </div>
            )}
            {namesDiffer && (
              <div style={{ fontSize: 12, padding: '8px 12px', borderLeft: '3px solid #B45309', background: '#FFF7E6', borderRadius: '0 8px 8px 0' }}>
                The item names differ. The model shows the most common name (“{summary?.name}”). The items are <b>not</b> renamed — invoices and labels stay as they are.
              </div>
            )}
            <div style={{ fontSize: 12, padding: '8px 12px', borderLeft: '3px solid #7EAA6E', background: 'rgba(126,170,110,0.13)', borderRadius: '0 8px 8px 0' }}>
              Only the model assignment is saved ({sel.length} new {sel.length === 1 ? 'entry' : 'entries'}), plus the audit log. No item, price, stock lot, photo, invoice or booking is changed.
            </div>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 10, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  {resulting.map((p) => (
                    <tr key={p.id} style={{ borderTop: '1px solid #E5E9EE' }}>
                      <td className="font-mono" style={{ padding: 8 }}>{p.sku || '—'}</td>
                      <td style={{ padding: 8 }}>Size {sizeOf(p) || '—'}</td>
                      <td className="font-mono" style={{ padding: 8, textAlign: 'right' }}>{weightOf(p) != null ? `${weightOf(p)!.toFixed(2)} g` : '—'}</td>
                      <td style={{ padding: 8 }}><StatusDot status={p.stockStatus} /></td>
                      <td style={{ padding: 8, fontSize: 11, color: '#6B7280' }}>{targetMembers.includes(p) ? 'already in model' : 'new'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <WriteError text={w.fehler} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep('select')}>Back</Button>
              <Button variant="primary" disabled={w.busy} onClick={() => void save()} data-group-save>{w.busy ? 'Saving…' : 'Save model'}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

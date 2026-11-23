// ARTIKELVARIANTEN — „Merge Photos": ein vorhandenes Bild als gemeinsames Modellbild wählen; die gewählten Varianten
// verweisen danach auf DIESELBE gespeicherte Datei (keine neue Datei, keine Neuberechnung). Bisherige Bilder bleiben als
// weitere Bilder am Artikel oder werden nur gelöst (die Datei bleibt; endgültig entfernt wird sie nie hier, sondern nur
// über die Medien-Freigabe in den Einstellungen nach Referenzprüfung). Verkaufte Stücke behalten ihr Bild. Rückgängig.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { WriteError } from '@/components/shared/WriteError';
import { CollectionProductThumb } from '@/components/products/CollectionProductThumb';
import { useProductStore } from '@/stores/productStore';
import { useSharedWrites } from '@/core/data/shared-write';
import { mayChangeVariantPhoto, PRODUCT_MODELS_MERGE_PHOTOS_OP, type MergePhotosInput, type MergePhotosResult } from '@/core/products/product-models';
import { loadVariantGallery, mergeModelPhotosOnPrimary } from '@/core/products/product-models-primary';
import { modelMembers, sizeOf } from '@/core/products/product-models-view';
import type { Product } from '@/core/models/types';

interface Props {
  open: boolean;
  modelKey: string;
  tenantId: string | undefined;
  branchId: string | undefined;
  onClose: () => void;
  onChanged?: () => void;
}

type Gal = { mediaIds: string[]; updatedAt: string; legacy: boolean };

export function MergePhotosModal({ open, modelKey, tenantId, branchId, onClose, onChanged }: Props) {
  const { products, productModels, loadProducts } = useProductStore();
  const members = useMemo(() => modelMembers(products, productModels, modelKey), [products, productModels, modelKey]);
  const w = useSharedWrites();
  const [gal, setGal] = useState<Record<string, Gal | null>>({});
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<string>('');
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const [detach, setDetach] = useState(false);
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<MergePhotosResult | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!open) return;
    setDone(null); setAck(false); setConfirming(false); setSkip({}); setDetach(false); w.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelKey]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void Promise.all(members.map(async (m) => [m.id, await loadVariantGallery(m.id)] as const)).then((pairs) => {
      if (!alive) return;
      const next: Record<string, Gal | null> = {};
      for (const [id, g] of pairs) next[id] = g;
      setGal(next);
      setLoading(false);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelKey, reloadTick, members.map((m) => `${m.id}:${m.updatedAt}`).join('|')]);

  // Wählbare Bilder: das Hauptbild jedes Artikels (Datei-Identität), einmal je Medium.
  const options = useMemo(() => {
    const seen = new Map<string, { mediaId: string; owner: Product; users: Product[] }>();
    for (const m of members) {
      const first = gal[m.id]?.mediaIds[0];
      if (!first) continue;
      const o = seen.get(first);
      if (o) o.users.push(m); else seen.set(first, { mediaId: first, owner: m, users: [m] });
    }
    return [...seen.values()];
  }, [members, gal]);
  useEffect(() => { if (!pick && options[0]) setPick(options[0].mediaId); }, [options, pick]);

  const status = (m: Product): { eligible: boolean; note: string } => {
    const g = gal[m.id];
    if (!mayChangeVariantPhoto(String(m.stockStatus))) return { eligible: false, note: 'Sold / closed — keeps its photo (records stay as they are)' };
    if (g?.legacy) return { eligible: false, note: 'Photos in the old format — open the item and save its photos once first' };
    if (!g) return { eligible: false, note: loading ? 'loading…' : 'Photos could not be read' };
    if (g.mediaIds[0] === pick) return { eligible: false, note: 'already shows this photo' };
    return { eligible: true, note: '' };
  };
  const targets = members.filter((m) => status(m).eligible && !skip[m.id]);
  const pickOwner = options.find((o) => o.mediaId === pick)?.owner;

  async function run(input: MergePhotosInput) {
    const r = await w.save<MergePhotosResult>(PRODUCT_MODELS_MERGE_PHOTOS_OP, {
      local: () => mergeModelPhotosOnPrimary(input),
      remote: () => input as unknown as Record<string, unknown>,
    });
    if (r.kind !== 'ok') return null;
    if (w.remote) loadProducts();
    onChanged?.();
    setReloadTick((x) => x + 1);
    return r.value as unknown as MergePhotosResult;
  }

  async function merge() {
    const res = await run({
      modelKey, pickMediaId: pick, detachOld: detach,
      targets: targets.map((m) => ({ productId: m.id, expectedUpdatedAt: gal[m.id]?.updatedAt ?? '' })),
    });
    if (res) { setDone(res); setConfirming(false); setAck(false); }
  }
  async function undo() {
    if (!done) return;
    const changed = done.products.filter((x) => x.previousMediaIds.join() !== x.mediaIds.join());
    const res = await run({ modelKey, restore: changed.map((x) => ({ productId: x.productId, mediaIds: x.previousMediaIds, expectedUpdatedAt: x.updatedAt })) });
    if (res) setDone(null);
  }

  return (
    <Modal open={open} onClose={onClose} title="Merge photos" width={820}>
      <div data-merge-photos-modal style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }}>
        {done ? (
          <div data-merge-done style={{ fontSize: 12.5, padding: '10px 12px', borderLeft: '3px solid #7EAA6E', background: 'rgba(126,170,110,0.13)', borderRadius: '0 8px 8px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span><b>Photos merged.</b> {done.products.filter((x) => x.previousMediaIds.join() !== x.mediaIds.join()).length} item(s) now point to the same stored photo. No new file was created and nothing was deleted.</span>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={w.busy} onClick={() => void undo()} data-merge-undo>Undo</Button>
              <Button variant="primary" onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : null}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="text-overline">1 · CHOOSE THE SHARED PHOTO</span>
          <span style={{ fontSize: 12, color: '#6B7280' }}>Each tile is a photo that is already stored. Nothing is uploaded or recalculated; the chosen photo is only referenced.</span>
          {loading && options.length === 0 ? <span style={{ fontSize: 12, color: '#6B7280' }}>Loading photos…</span> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12 }}>
            {options.map((o) => (
              <label key={o.mediaId} data-merge-pick={o.mediaId}
                style={{ border: `2px solid ${pick === o.mediaId ? '#715DE3' : '#E5E9EE'}`, borderRadius: 12, overflow: 'hidden', cursor: 'pointer', background: '#FFFFFF' }}>
                <div style={{ height: 120, background: '#F2F7FA', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  <CollectionProductThumb product={o.owner} tenantId={tenantId} branchId={branchId} iconSize={28} />
                </div>
                <div style={{ padding: '8px 10px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600 }}>
                    <input type="radio" name="merge-pick" checked={pick === o.mediaId} onChange={() => setPick(o.mediaId)} /> Use as model photo
                  </span>
                  <span style={{ color: '#6B7280', fontSize: 11 }}>main photo of {o.users.map((u) => u.sku || u.name).join(', ')}</span>
                </div>
              </label>
            ))}
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="text-overline">2 · WHICH ITEMS TAKE IT OVER?</span>
          <div style={{ border: '1px solid #E5E9EE', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
              <tbody>
                {members.map((m) => {
                  const st = status(m);
                  return (
                    <tr key={m.id} style={{ borderTop: '1px solid #E5E9EE', color: st.eligible ? '#0F0F10' : '#6B7280' }} data-merge-row={m.id}>
                      <td style={{ padding: 8 }}>
                        <input type="checkbox" disabled={!st.eligible} checked={st.eligible && !skip[m.id]} onChange={() => setSkip((s) => ({ ...s, [m.id]: !s[m.id] }))} aria-label={`${m.sku} takes the model photo`} data-merge-target={m.id} />
                      </td>
                      <td className="font-mono" style={{ padding: 8 }}>{m.sku || '—'}</td>
                      <td style={{ padding: 8 }}>Size {sizeOf(m) || '—'}</td>
                      <td style={{ padding: 8 }}><StatusDot status={m.stockStatus} /></td>
                      <td style={{ padding: 8, fontSize: 11.5 }}>{st.eligible ? (skip[m.id] ? 'stays unchanged' : `will show the photo of ${pickOwner?.sku ?? 'the model'}`) : st.note}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="text-overline">3 · THE PREVIOUS PHOTOS</span>
          <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
            <Button variant={detach ? 'ghost' : 'secondary'} onClick={() => setDetach(false)} data-merge-keep>Keep as additional photo (recommended)</Button>
            <Button variant={detach ? 'secondary' : 'ghost'} onClick={() => setDetach(true)} data-merge-detach>Detach from the item</Button>
          </div>
          <span style={{ fontSize: 12, color: '#4B5563' }}>
            {detach
              ? 'The link is only marked as removed; the stored file stays. It is never deleted here — only later via Settings → maintenance (media release) after a full reference check, dry run and quarantine. Undo is possible until then.'
              : 'The previous main photo moves into the item’s gallery (second place). Nothing is deleted; undo is possible at any time.'}
          </span>
        </section>

        <div style={{ fontSize: 12.5, padding: '10px 12px', background: '#FAFBFC', border: '1px solid #E5E9EE', borderRadius: 10 }} data-merge-summary>
          <b>{targets.length}</b> item(s) get a new main photo · new files: <b>0</b> · recalculated: <b>0</b> · deleted: <b>0</b> · items, prices and bookings: unchanged
        </div>
        <WriteError text={w.fehler} />
        {confirming ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', borderLeft: '3px solid #715DE3', background: 'rgba(113,93,227,0.09)', borderRadius: '0 8px 8px 0', fontSize: 12.5 }}>
            <span>Merge photos for {targets.map((t) => t.sku || t.name).join(', ')}? Sold items, invoices, the audit history and older photo references stay unchanged.</span>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={ack} onChange={() => setAck((a) => !a)} data-merge-ack /> I have checked the preview.
            </label>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="primary" disabled={!ack || w.busy} onClick={() => void merge()} data-merge-confirm>{w.busy ? 'Saving…' : 'Merge photos'}</Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button variant="primary" disabled={!pick || targets.length === 0 || loading || w.busy} onClick={() => setConfirming(true)} data-merge-open-confirm>Merge photos…</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

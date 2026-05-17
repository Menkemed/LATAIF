// Plan §Sync-Duplicate-Detection
// ─────────────────────────────────────────────────────────────────────────
// Reagiert auf neue Produkte, die per Sync (typischerweise Phone-Upload via
// LAN-Sync-Server) hereinkommen. Für jedes neue Item läuft der gleiche
// Score-Helper wie beim Live-Check beim Anlegen (productStore.findPossibleDuplicates).
// Bei Treffer wird ein Side-by-Side-Modal angeboten:
//
//   • Bestätigen → mergeIntoExisting (qty++, Source löschen)
//   • Ablehnen   → als eigenes Item behalten (no-op, dismiss)
//
// Mehrere Hits werden serialisiert: nach Entscheidung des aktuellen Items
// rückt der nächste aus der Queue nach.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { Bhd } from '@/components/ui/Bhd';
import { Package, ArrowRight, Plus } from 'lucide-react';
import { useProductStore } from '@/stores/productStore';
import type { Product } from '@/core/models/types';

interface PendingReview {
  incoming: Product;
  matches: Array<{ product: Product; score: number; reasons: string[] }>;
}

function scoreLabel(score: number): { text: string; color: string; bg: string } {
  if (score >= 100) return { text: 'Almost certainly duplicate', color: '#AA6E6E', bg: 'rgba(170,110,110,0.10)' };
  if (score >= 60)  return { text: 'Likely duplicate',           color: '#AA956E', bg: 'rgba(170,149,110,0.12)' };
  return { text: 'Possibly similar', color: '#6E8AAA', bg: 'rgba(110,138,170,0.12)' };
}

function specsOf(p: Product): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (p.sku) out.push({ label: 'SKU', value: p.sku });
  const attrs = p.attributes || {};
  const ref = String(attrs.reference_number || attrs.reference || attrs.referenceNo || '').trim();
  if (ref) out.push({ label: 'Ref', value: ref });
  const serial = String(attrs.serial_number || attrs.serialNo || '').trim();
  if (serial) out.push({ label: 'Serial', value: serial });
  const modelNo = String(attrs.model_number || '').trim();
  if (modelNo) out.push({ label: 'Model No', value: modelNo });
  const weight = Number(attrs.weight) || 0;
  const karat = String(attrs.karat || '').trim();
  if (weight > 0) out.push({ label: 'Weight', value: `${weight}g${karat ? ' · ' + karat : ''}` });
  const itemType = String(attrs.item_type || '').trim();
  if (itemType) out.push({ label: 'Type', value: itemType });
  const caseSize = String(attrs.case_diameter_mm || attrs.case_size || '').trim();
  if (caseSize) out.push({ label: 'Case', value: `${caseSize}${/^\d+$/.test(caseSize) ? ' mm' : ''}` });
  return out;
}

function ItemImage({ src, size = 130 }: { src?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, background: '#F2F7FA', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', border: '1px solid #E5E9EE',
    }}>
      {src ? (
        <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <Package size={size * 0.28} strokeWidth={1} style={{ color: '#6B7280' }} />
      )}
    </div>
  );
}

function SpecGrid({ specs }: { specs: { label: string; value: string }[] }) {
  if (specs.length === 0) return null;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px',
      fontSize: 11, marginTop: 10,
    }}>
      {specs.map((s, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <span style={{ color: '#6B7280' }}>{s.label}</span>
          <span style={{ color: '#0F0F10' }} className="font-mono">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

export function SyncDuplicateGuard() {
  const navigate = useNavigate();
  const { products, mergeIntoExisting } = useProductStore();
  const [queue, setQueue] = useState<PendingReview[]>([]);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    function handle(ev: Event) {
      const ce = ev as CustomEvent<{ ids: string[] }>;
      const ids = ce.detail?.ids || [];
      if (ids.length === 0) return;
      const state = useProductStore.getState();
      const reviews: PendingReview[] = [];
      for (const id of ids) {
        const incoming = state.products.find(p => p.id === id);
        if (!incoming) continue;
        // Image-only-Modus für Phone-Uploads: Phone-User tippen oft falsche
        // SKUs/Brands oder lassen sie leer. Photo ist das verlässliche Signal.
        // Wenn das incoming-Item noch keinen Hash hat (z.B. wegen broken image
        // auf Phone-Seite), fällt der Modus auf 'all' zurück.
        const mode: 'all' | 'image-only' = incoming.imageHash ? 'image-only' : 'all';
        const matches = state.findPossibleDuplicates(incoming, id, { mode });
        if (matches.length > 0) reviews.push({ incoming, matches });
      }
      if (reviews.length > 0) {
        setQueue(prev => {
          // Dedupe gegen bereits queue'te Reviews (gleiche incoming-ID).
          const known = new Set(prev.map(r => r.incoming.id));
          const fresh = reviews.filter(r => !known.has(r.incoming.id));
          return [...prev, ...fresh];
        });
      }
    }
    window.addEventListener('lataif:sync-products-inserted', handle as EventListener);
    return () => window.removeEventListener('lataif:sync-products-inserted', handle as EventListener);
  }, []);

  const current = queue[0];
  // Aktuelle Produkte aus dem Store ziehen — incoming/match könnten in der
  // Zwischenzeit modifiziert sein (z.B. anderer Peer hat schon gemerged).
  const incoming = current ? products.find(p => p.id === current.incoming.id) : null;
  const topMatch = current?.matches[0];
  const existing = topMatch ? products.find(p => p.id === topMatch.product.id) : null;

  function dequeue() {
    setQueue(prev => prev.slice(1));
  }

  function keepAsNew() {
    // "Ablehnen" / "Erstellen" — Item bleibt wie es ist, nur dismissen.
    dequeue();
  }

  function confirmMerge() {
    if (!incoming || !existing) { dequeue(); return; }
    setActionBusy(true);
    try {
      mergeIntoExisting(incoming.id, existing.id);
      dequeue();
    } catch (e) {
      console.error('[SyncDuplicateGuard] merge failed:', e);
      alert(`Merge fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  function openExisting() {
    if (!existing) return;
    dequeue();
    navigate(`/collection/${existing.id}`);
  }

  // Edge-Cases: wenn Items zwischen Event-Empfang und Render verschwunden
  // sind (anderer Peer hat sie schon gelöscht), Queue-Eintrag stillschweigend
  // skippen.
  if (current && (!incoming || !existing || !topMatch)) {
    setTimeout(() => dequeue(), 0);
    return null;
  }
  if (!current || !incoming || !existing || !topMatch) return null;

  const lbl = scoreLabel(topMatch.score);
  const incomingSpecs = specsOf(incoming);
  const existingSpecs = specsOf(existing);
  const incomingQty = Math.max(1, incoming.quantity || 1);
  const newQty = (existing.quantity || 1) + incomingQty;

  return (
    <Modal open={true} onClose={keepAsNew} title="Möglicher Duplikat-Upload erkannt" width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(170,149,110,0.10)', border: '1px solid rgba(170,149,110,0.25)',
          fontSize: 13, color: '#0F0F10', lineHeight: 1.5,
        }}>
          Ein über Sync hochgeladenes Item sieht aus wie ein bereits bestehender Artikel.
          Vergleiche beide — bei <strong>Bestätigen</strong> wird die Menge des bestehenden Artikels um {incomingQty} erhöht und das neue gelöscht.
          {queue.length > 1 && (
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#6B7280' }}>
              {queue.length - 1} weitere Pair{queue.length - 1 === 1 ? '' : 's'} warten danach.
            </span>
          )}
        </div>

        {/* Side-by-Side */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 14, alignItems: 'stretch',
        }}>
          {/* INCOMING — left (gerade per Sync angekommen) */}
          <div style={{
            padding: 14, border: '1px dashed #AA956E', borderRadius: 10,
            background: 'rgba(170,149,110,0.04)',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <span className="text-overline" style={{ color: '#AA956E' }}>NEU (per Sync)</span>
            <ItemImage src={incoming.images?.[0]} />
            <div style={{ marginTop: 4, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{incoming.brand || '—'}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {incoming.name || 'Untitled'}
              </div>
              <SpecGrid specs={incomingSpecs} />
              {incomingQty > 1 && (
                <div className="font-mono" style={{ fontSize: 11, color: '#AA956E', marginTop: 6 }}>
                  Quantity: {incomingQty}
                </div>
              )}
            </div>
          </div>

          {/* Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', color: '#6B7280', paddingTop: 90 }}>
            <ArrowRight size={20} />
          </div>

          {/* EXISTING — right */}
          <div style={{
            padding: 14, border: '1px solid #E5E9EE', borderRadius: 10,
            background: '#FFFFFF',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <div className="flex items-center justify-between">
              <span className="text-overline" style={{ color: '#0F0F10' }}>BESTEHEND</span>
              <StatusDot status={existing.stockStatus} />
            </div>
            <ItemImage src={existing.images?.[0]} />
            <div style={{ marginTop: 4, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{existing.brand}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {existing.name}
              </div>
              <SpecGrid specs={existingSpecs} />
              <div className="flex items-center" style={{ gap: 10, marginTop: 8, fontSize: 12 }}>
                <span className="font-mono" style={{ color: '#4B5563' }}>
                  Qty: {existing.quantity || 1} → <strong style={{ color: '#7EAA6E' }}>{newQty}</strong>
                </span>
                {existing.plannedSalePrice ? (
                  <span className="font-mono" style={{ color: '#0F0F10' }}>
                    · <Bhd v={existing.plannedSalePrice}/> BHD
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Reason chips */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '10px 14px', borderRadius: 8, background: 'rgba(15,15,16,0.03)',
          border: '1px solid #E5E9EE',
        }}>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 999,
            color: lbl.color, background: lbl.bg, border: `1px solid ${lbl.color}40`,
            fontWeight: 500,
          }}>{lbl.text}</span>
          <span style={{ fontSize: 11, color: '#6B7280' }}>Why:</span>
          {topMatch.reasons.map((r, i) => (
            <span key={i} style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 999,
              background: '#FFFFFF', color: '#4B5563', border: '1px solid #E5E9EE',
            }}>{r}</span>
          ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3" style={{
          paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap',
        }}>
          <Button variant="ghost" onClick={openExisting}>Bestehenden öffnen</Button>
          <Button variant="secondary" onClick={keepAsNew} disabled={actionBusy}>
            Ablehnen — als neu behalten
          </Button>
          <Button variant="primary" onClick={confirmMerge} disabled={actionBusy}>
            <Plus size={14} /> Bestätigen — Menge erhöhen ({newQty})
          </Button>
        </div>
      </div>
    </Modal>
  );
}

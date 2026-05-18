// Plan §Product §QuickCapture — zeigt mögliche Duplikate vor dem Anlegen
// eines neuen Items. Score-Threshold-Logik in productStore.findPossibleDuplicates;
// dieses Modal ist nur die UI.
//
// Layout: Side-by-Side "YOUR NEW ITEM" vs "EXISTING (top match)". Bilder
// nebeneinander, Details drunter. Weitere Matches als kleine Karten unten.
// Aktionen: Cancel · Open existing · Create anyway.
//
// Wird benutzt in WatchList, NewProductModal (PurchaseCreate) und ConsignmentList.
import { Package, AlertTriangle, ArrowRight, Copy } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { StatusDot } from './StatusDot';
import { Bhd } from './Bhd';
import type { Product } from '@/core/models/types';

export interface DuplicateMatch {
  product: Product;
  score: number;
  reasons: string[];
}

interface Props {
  open: boolean;
  matches: DuplicateMatch[];
  /** Das gerade erfasste Item, das verglichen wird (Bild + Daten). */
  candidate?: Partial<Product>;
  onCancel: () => void;
  onCreateAnyway: () => void;
  /** Optional — wenn der Caller zum gefundenen Produkt navigieren will (z.B. statt anlegen). */
  onPickExisting?: (productId: string) => void;
  /** Optional — übernimmt die Stamm-Daten des Existing in den neuen Form (Brand/Name/Specs/Preis), ohne SKU/Serial/Bild. */
  onCopyDetails?: (productId: string) => void;
}

function scoreLabel(score: number): { text: string; color: string; bg: string } {
  // 2026-05-18 — Schwellen passend zu STRONG (>=80) / POSSIBLE (60-79).
  if (score >= 150) return { text: 'Almost certainly duplicate', color: '#AA6E6E', bg: 'rgba(170,110,110,0.10)' };
  if (score >= 80)  return { text: 'Likely duplicate',           color: '#AA956E', bg: 'rgba(170,149,110,0.12)' };
  return { text: 'Possibly similar', color: '#6E8AAA', bg: 'rgba(110,138,170,0.12)' };
}

// Kleiner Image-Block — fällt auf Package-Icon zurück wenn kein Bild da.
function ItemImage({ src, size = 140 }: { src?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, background: '#F2F7FA', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', border: '1px solid #E5E9EE',
    }}>
      {src ? (
        <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <Package size={size * 0.3} strokeWidth={1} style={{ color: '#6B7280' }} />
      )}
    </div>
  );
}

// Liefert kompakt die wichtigsten Identitäts-Felder eines Produkts/Kandidaten.
function specsOf(p: Partial<Product>): { label: string; value: string }[] {
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

export function DuplicateWarningModal({ open, matches, candidate, onCancel, onCreateAnyway, onPickExisting, onCopyDetails }: Props) {
  if (matches.length === 0) return null;
  const top = matches[0];
  const topSeverity = top.score >= 100 ? 'severe' : top.score >= 60 ? 'warn' : 'mild';
  const topLabel = scoreLabel(top.score);
  const others = matches.slice(1);

  const candidateSpecs = candidate ? specsOf(candidate) : [];
  const existingSpecs = specsOf(top.product);

  return (
    <Modal open={open} onClose={onCancel} title="Possible duplicate detected" width={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{
          padding: '12px 14px', borderRadius: 8,
          background: topSeverity === 'severe' ? 'rgba(170,110,110,0.08)' : topSeverity === 'warn' ? 'rgba(170,149,110,0.10)' : '#F2F7FA',
          border: `1px solid ${topSeverity === 'severe' ? 'rgba(170,110,110,0.25)' : topSeverity === 'warn' ? 'rgba(170,149,110,0.25)' : '#E5E9EE'}`,
          display: 'flex', alignItems: 'flex-start', gap: 10,
        }}>
          <AlertTriangle size={18} style={{ color: topSeverity === 'severe' ? '#AA6E6E' : '#AA956E', marginTop: 1 }} />
          <div style={{ fontSize: 13, color: '#0F0F10', lineHeight: 1.5 }}>
            This item looks like {matches.length === 1 ? 'one' : `${matches.length}`} you already have in your collection.
            <div style={{ fontSize: 12, color: '#6B7280', marginTop: 4 }}>
              Compare both sides — you may want to open the existing item instead.
            </div>
          </div>
        </div>

        {/* Side-by-Side Compare */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          gap: 16,
          alignItems: 'stretch',
        }}>
          {/* NEW — left */}
          <div style={{
            padding: 14, border: '1px dashed #AA956E', borderRadius: 10,
            background: 'rgba(170,149,110,0.04)',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <span className="text-overline" style={{ color: '#AA956E' }}>YOUR NEW ITEM</span>
            <ItemImage src={candidate?.images?.[0]} />
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{candidate?.brand || '—'}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {candidate?.name || 'Untitled'}
              </div>
              <SpecGrid specs={candidateSpecs} />
            </div>
          </div>

          {/* Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', color: '#6B7280', paddingTop: 100 }}>
            <ArrowRight size={20} />
          </div>

          {/* EXISTING — right (top match) */}
          <div
            onClick={() => onPickExisting?.(top.product.id)}
            style={{
              padding: 14, border: '1px solid #E5E9EE', borderRadius: 10,
              background: '#FFFFFF',
              display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
              cursor: onPickExisting ? 'pointer' : 'default',
              transition: 'background 120ms, border-color 120ms',
            }}
            onMouseEnter={e => { if (onPickExisting) { e.currentTarget.style.background = '#FAFBFC'; e.currentTarget.style.borderColor = '#0F0F10'; } }}
            onMouseLeave={e => { if (onPickExisting) { e.currentTarget.style.background = '#FFFFFF';   e.currentTarget.style.borderColor = '#E5E9EE'; } }}
          >
            <div className="flex items-center justify-between">
              <span className="text-overline" style={{ color: '#0F0F10' }}>EXISTING ITEM</span>
              <StatusDot status={top.product.stockStatus} />
            </div>
            <ItemImage src={top.product.images?.[0]} />
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{top.product.brand}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {top.product.name}
              </div>
              <SpecGrid specs={existingSpecs} />
              {top.product.plannedSalePrice ? (
                <div className="font-mono" style={{ fontSize: 12, color: '#0F0F10', marginTop: 8 }}>
                  Asking: <Bhd v={top.product.plannedSalePrice}/> BHD
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* Match-Reason Chips + Score-Label */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '10px 14px', borderRadius: 8, background: 'rgba(15,15,16,0.03)',
          border: '1px solid #E5E9EE',
        }}>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 999,
            color: topLabel.color, background: topLabel.bg, border: `1px solid ${topLabel.color}40`,
            fontWeight: 500,
          }}>{topLabel.text}</span>
          <span style={{ fontSize: 11, color: '#6B7280' }}>Why:</span>
          {top.reasons.map((r, i) => (
            <span key={i} style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 999,
              background: '#FFFFFF', color: '#4B5563', border: '1px solid #E5E9EE',
            }}>{r}</span>
          ))}
        </div>

        {/* Andere Matches als Mini-Karten */}
        {others.length > 0 && (
          <div>
            <div className="text-overline" style={{ marginBottom: 8 }}>
              Other possible matches ({others.length})
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 10,
            }}>
              {others.map(({ product: p, score, reasons }) => {
                const lbl = scoreLabel(score);
                return (
                  <div key={p.id}
                    onClick={() => onPickExisting?.(p.id)}
                    style={{
                      display: 'grid', gridTemplateColumns: '48px 1fr', gap: 10,
                      padding: 10, border: '1px solid #E5E9EE', borderRadius: 8,
                      cursor: onPickExisting ? 'pointer' : 'default',
                      transition: 'background 120ms',
                    }}
                    onMouseEnter={e => { if (onPickExisting) e.currentTarget.style.background = '#FAFBFC'; }}
                    onMouseLeave={e => { if (onPickExisting) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <ItemImage src={p.images?.[0]} size={48} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, color: '#6B7280' }}>{p.brand}</div>
                      <div style={{ fontSize: 12, color: '#0F0F10', fontWeight: 500, lineHeight: 1.2 }}>{p.name}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        <span style={{
                          fontSize: 9, padding: '1px 6px', borderRadius: 999,
                          color: lbl.color, background: lbl.bg, border: `1px solid ${lbl.color}40`,
                        }}>{lbl.text}</span>
                        {reasons.slice(0, 1).map((r, i) => (
                          <span key={i} style={{
                            fontSize: 9, padding: '1px 6px', borderRadius: 999,
                            background: 'rgba(15,15,16,0.04)', color: '#4B5563',
                          }}>{r}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {onCopyDetails && (
          <div style={{ fontSize: 11, color: '#6B7280', lineHeight: 1.5, marginTop: -4 }}>
            <strong style={{ color: '#0F0F10' }}>Copy details</strong> — wenn es ein zweites Stück desselben Modells ist: übernimmt Brand, Name, Specs und Preis ins Formular. SKU und Serial bleiben leer (jedes Stück ist physisch eigen). Foto wird nur übernommen, wenn du noch keins selbst hochgeladen hast.
          </div>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap' }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {onPickExisting && (
            <Button variant="secondary" onClick={() => onPickExisting(top.product.id)}>Open existing</Button>
          )}
          {onCopyDetails && (
            <Button variant="secondary" onClick={() => onCopyDetails(top.product.id)}>
              <Copy size={14} /> Copy details
            </Button>
          )}
          <Button variant="primary" onClick={onCreateAnyway}>Create anyway</Button>
        </div>
      </div>
    </Modal>
  );
}

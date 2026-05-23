// v0.7.0 — Cancel-Order Wizard: Geld-Handling (Refund/Credit/Forfeit) + Info
// ueber die automatischen Lifecycle-Effekte (A/P, Gold, beschaffte Ware).
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import type { Order, OrderLine } from '@/core/models/types';

type Choice = 'refund' | 'credit' | 'forfeit';
type RefundMethod = 'cash' | 'bank' | 'benefit';

export interface CancelOrderModalProps {
  open: boolean;
  order: Order;
  orderLines: OrderLine[];
  totalPaid: number;
  /** Sourced-Map fuer Lines, die schon via Purchase beschafft wurden. */
  sourcedLineIds: Set<string>;
  /** Anzahl offener Gold-Verbindlichkeiten dieser Order. */
  openGoldPayableCount: number;
  onCancel: () => void;
  onConfirm: (choice: Choice, refundMethod?: RefundMethod) => void;
}

export function CancelOrderModal({
  open, order, orderLines, totalPaid, sourcedLineIds, openGoldPayableCount,
  onCancel, onConfirm,
}: CancelOrderModalProps) {
  const [choice, setChoice] = useState<Choice>('refund');
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('cash');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setChoice('refund');
      setRefundMethod('cash');
      setNote('');
    }
  }, [open]);

  // Auto-Effekte fuer den Info-Block (rein deskriptiv, keine User-Wahl).
  const stats = useMemo(() => {
    const customerLines = orderLines.filter(l => l.isCustomerFacing !== false && l.status !== 'CANCELLED');
    const costLines = orderLines.filter(l => l.isCustomerFacing === false && l.status !== 'CANCELLED');
    const sourcedArrived = customerLines.filter(l => sourcedLineIds.has(l.id));
    const orderedMarker = customerLines.filter(l => l.status === 'ORDERED' && !sourcedLineIds.has(l.id));
    // v0.7.0 — Custom-Order mit angefangener Arbeit: Cost-Lines die schon eine
    // expense_id haben (= reale A/P-Buchung gegenueber dem Goldsmith/Material-
    // Supplier) bleiben offen, das Stueck wird in Lager ueberfuehrt.
    const realizedCostLines = costLines.filter(l => l.expenseId);
    const realizedCostTotal = realizedCostLines.reduce((s, l) => s + (l.costAmount || 0), 0);
    const allCustomCostBasis = costLines.reduce((s, l) => s + (l.costAmount || 0), 0);
    return {
      customerLineCount: customerLines.length,
      costLineCount: costLines.length,
      sourcedArrivedCount: sourcedArrived.length,
      orderedMarkerCount: orderedMarker.length,
      realizedCostCount: realizedCostLines.length,
      realizedCostTotal,
      customCostBasis: allCustomCostBasis,
    };
  }, [orderLines, sourcedLineIds]);

  const moneyShown = totalPaid > 0.005;

  return (
    <Modal open={open} onClose={onCancel} title={`Cancel Order ${order.orderNumber}`} width={620}>
      <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 18 }}>
        Diese Order wird storniert. Lege fest, wie mit dem schon gezahlten Betrag verfahren wird,
        und überprüfe die automatischen Folgen unten.
      </p>

      {/* ── Geld-Handling ── */}
      {moneyShown && (
        <div style={{ marginBottom: 18, padding: '14px 16px',
                      background: '#FFFAF0', border: '1px solid #F0D9A8', borderRadius: 8 }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
            <span className="text-overline">KUNDEN-ANZAHLUNG</span>
            <span className="font-mono" style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
              <Bhd v={totalPaid}/> BHD
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([
              { v: 'refund' as Choice, label: 'Refund — Geld zurück an Kunden',
                desc: 'Cash/Bank/Benefit aus dem entsprechenden Konto raus. Customer-Deposit-Schuld geht weg.' },
              { v: 'credit' as Choice, label: 'Als Guthaben behalten',
                desc: 'Eintrag in customer_credits. Bei nächster Order/Invoice einlösbar. Geld bleibt in der Kasse.' },
              { v: 'forfeit' as Choice, label: 'Storno-Gebühr / Verfall',
                desc: 'Wird als Cancellation-Fee-Income gebucht. Geld bleibt beim Shop, Customer-Schuld erlischt.' },
            ]).map(opt => (
              <label key={opt.v}
                style={{ display: 'flex', gap: 10, padding: 10, borderRadius: 6,
                         border: `1px solid ${choice === opt.v ? '#0F0F10' : '#D5D9DE'}`,
                         background: choice === opt.v ? 'rgba(15,15,16,0.04)' : 'transparent',
                         cursor: 'pointer' }}>
                <input type="radio" checked={choice === opt.v} onChange={() => setChoice(opt.v)}
                  style={{ marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, color: '#0F0F10', fontWeight: 500 }}>{opt.label}</div>
                  <div style={{ fontSize: 11, color: '#6B7280', marginTop: 2 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>

          {choice === 'refund' && (
            <div style={{ marginTop: 12 }}>
              <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>REFUND-METHODE</span>
              <div className="flex gap-2">
                {(['cash', 'bank', 'benefit'] as const).map(m => (
                  <button key={m} type="button" onClick={() => setRefundMethod(m)}
                    style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6,
                             border: `1px solid ${refundMethod === m ? '#0F0F10' : '#D5D9DE'}`,
                             color: refundMethod === m ? '#0F0F10' : '#6B7280',
                             background: refundMethod === m ? 'rgba(15,15,16,0.06)' : 'transparent',
                             cursor: 'pointer' }}>
                    {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {choice === 'credit' && (
            <div style={{ marginTop: 12 }}>
              <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>NOTIZ (OPTIONAL)</span>
              <input value={note} onChange={e => setNote(e.target.value)}
                placeholder="Verwendungszweck für das Guthaben…"
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #D5D9DE',
                         borderRadius: 6, fontSize: 13 }} />
            </div>
          )}
        </div>
      )}

      {!moneyShown && (
        <div style={{ marginBottom: 18, padding: '12px 14px',
                      background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8,
                      fontSize: 12, color: '#4B5563' }}>
          Kein Geld eingenommen — die Order wird ohne Geld-Buchung storniert.
        </div>
      )}

      {/* v0.7.0 — Custom-Order in Arbeit (Goldsmith hat schon angefangen):
          A/P bleibt real, Stueck wird in Lager ueberfuehrt. Eigene Warn-Sektion. */}
      {stats.realizedCostCount > 0 && (
        <div style={{ padding: '12px 14px', background: '#FFF7ED',
                      border: '1px solid #F0A258', borderRadius: 8, marginBottom: 14 }}>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block', color: '#9A3412' }}>
            CUSTOM-ARBEIT BEREITS ANGEFANGEN
          </span>
          <ul style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7, paddingLeft: 16, margin: 0 }}>
            <li>
              <strong>A/P-Schuld {stats.realizedCostTotal.toFixed(3)} BHD</strong> beim
              Goldsmith / Material-Supplier <strong>bleibt offen</strong> — der Supplier hat schon gearbeitet bzw.
              geliefert. Bezahlen oder mit ihm separat verhandeln (Expense manuell stornieren falls Einigung).
            </li>
            <li>
              Das Stück wird als <strong>Lagerprodukt</strong> angelegt
              (Wert {stats.customCostBasis.toFixed(3)} BHD, frei verkäuflich).
              Erscheint in Collection unter der Custom-Order-Kategorie.
            </li>
          </ul>
        </div>
      )}

      {/* ── Auto-Lifecycle Info ── */}
      <div style={{ padding: '12px 14px', background: '#FAFBFC',
                    border: '1px solid #E5E9EE', borderRadius: 8, marginBottom: 18 }}>
        <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
          AUTOMATISCH BEIM STORNO
        </span>
        <ul style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7, paddingLeft: 16, margin: 0 }}>
          {stats.costLineCount > 0 && stats.realizedCostCount === 0 && (
            <li>{stats.costLineCount} Kosten-Position{stats.costLineCount === 1 ? '' : 'en'} (Labor/Material/Gold, noch nicht geliefert) — werden gestrichen, keine A/P entstanden</li>
          )}
          {openGoldPayableCount > 0 && (
            <li>{openGoldPayableCount} offene Gold-Verbindlichkeit{openGoldPayableCount === 1 ? '' : 'en'} (Gramm) — auf CANCELLED gesetzt</li>
          )}
          {stats.orderedMarkerCount > 0 && (
            <li>{stats.orderedMarkerCount} Zeile{stats.orderedMarkerCount === 1 ? '' : 'n'} „beim Supplier bestellt" — Supplier-Marker entfernt (kein realer Purchase, kein Effekt beim Supplier)</li>
          )}
          {stats.sourcedArrivedCount > 0 && (
            <li style={{ color: '#D97706' }}>
              <strong>{stats.sourcedArrivedCount} Zeile{stats.sourcedArrivedCount === 1 ? '' : 'n'} bereits via Purchase beschafft</strong> —
              das Stück bleibt im Lager (Standard-Bestand). Wenn du es retournieren willst, ist das ein
              separater Schritt über Purchases → Return.
            </li>
          )}
          <li>Alle Order-Zeilen und die Order selbst werden auf Status CANCELLED gesetzt</li>
        </ul>
      </div>

      <div className="flex justify-end gap-3" style={{ paddingTop: 14, borderTop: '1px solid #E5E9EE' }}>
        <Button variant="ghost" onClick={onCancel}>Zurück</Button>
        <Button variant="danger" onClick={() => onConfirm(choice, choice === 'refund' ? refundMethod : undefined)}>
          Order stornieren
        </Button>
      </div>
    </Modal>
  );
}

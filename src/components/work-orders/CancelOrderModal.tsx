// v0.7.0 — Cancel-Order Wizard: Geld-Handling (Refund/Credit/Forfeit) + Info
// ueber die automatischen Lifecycle-Effekte (A/P, Gold, beschaffte Ware).
// CENTRAL-UI-PARITY R6F — die Maske waehlt nur (Weg, Zahlweg, Notiz); Betraege, Guthaben, Buchungen,
// Lagerstueck und Status rechnet und schreibt das Haus (`cancelOrderInHouse`) — am Primary wie auf PC2.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import type { Order, OrderLine } from '@/core/models/types';

type Choice = 'refund' | 'credit' | 'forfeit';
type RefundMethod = 'cash' | 'bank' | 'benefit';

export interface CancelOrderModalProps {
  open: boolean;
  order: Order;
  orderLines: OrderLine[];
  /** R6F — die NICHT umgewandelten Anzahlungen: genau die Summe, die das Haus bucht. */
  totalPaid: number;
  /** Sourced-Map fuer Lines, die schon via Purchase beschafft wurden. */
  sourcedLineIds: Set<string>;
  /** Offene Gold-Verbindlichkeiten, die der Storno aufhebt (reine Planung). */
  openGoldPayableCount: number;
  /** R6F — offene Gold-Verbindlichkeiten, die bleiben: Gold geliefert oder schon Gramm bewegt. */
  keptGoldPayableCount?: number;
  /** R6F — der Storno laeuft; der Knopf ist solange gesperrt. */
  busy?: boolean;
  /** R6F — warum der Storno nicht geglueckt ist (leer = kein Fehler). */
  submitError?: string;
  /** R6F — ueber „Delete Order" geoeffnet: ein bezahlter Auftrag wird storniert, nicht geloescht. */
  fromDelete?: boolean;
  onCancel: () => void;
  onConfirm: (choice: Choice, refundMethod?: RefundMethod, note?: string) => void;
}

export function CancelOrderModal({
  open, order, orderLines, totalPaid, sourcedLineIds, openGoldPayableCount, keptGoldPayableCount = 0,
  busy = false, submitError = '', fromDelete = false,
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

  // R6F — vorher fiel die Notiz hier weg: die Maske fragte „Intended use of the credit…", der Knopf
  // reichte sie aber nie weiter, und das Guthaben bekam immer den Standardtext. Die Notiz gehoert
  // zum Guthaben, der Zahlweg zur Rueckzahlung — sonst reist keins von beiden mit.
  function confirm() {
    const trimmed = note.trim();
    onConfirm(
      choice,
      choice === 'refund' ? refundMethod : undefined,
      choice === 'credit' && trimmed ? trimmed : undefined,
    );
  }

  return (
    <Modal open={open} onClose={onCancel} title={`Cancel Order ${order.orderNumber}`} width={620}>
      <p style={{ fontSize: 13, color: '#4B5563', marginBottom: 18 }}>
        This order will be cancelled. Decide how to handle the amount already paid,
        and review the automatic effects below.
      </p>

      {fromDelete && (
        <div data-order-cancel-from-delete style={{ marginBottom: 18, padding: '12px 14px',
                      background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 8,
                      fontSize: 12, color: '#4B5563' }}>
          This order has received payments. It is cancelled instead of deleted — the order stays as
          the record of how the money was handled.
        </div>
      )}

      {/* ── Geld-Handling ── */}
      {moneyShown && (
        <div style={{ marginBottom: 18, padding: '14px 16px',
                      background: '#FFFAF0', border: '1px solid #F0D9A8', borderRadius: 8 }}>
          <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
            <span className="text-overline">CUSTOMER DOWN PAYMENT</span>
            <span className="font-mono" style={{ fontSize: 16, fontWeight: 600, color: '#0F0F10' }}>
              <Bhd v={totalPaid}/> BHD
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([
              { v: 'refund' as Choice, label: 'Refund — money back to customer',
                desc: 'Cash/Bank/Benefit leaves the corresponding account. The customer-deposit liability is cleared.' },
              { v: 'credit' as Choice, label: 'Keep as credit',
                desc: 'Entry in customer_credits. Redeemable on the next order/invoice. Money stays in the till.' },
              { v: 'forfeit' as Choice, label: 'Cancellation fee / forfeit',
                desc: 'Booked as cancellation-fee income. Money stays with the shop, customer liability is cleared.' },
            ]).map(opt => (
              <label key={opt.v}
                style={{ display: 'flex', gap: 10, padding: 10, borderRadius: 6,
                         border: `1px solid ${choice === opt.v ? '#0F0F10' : '#D5D9DE'}`,
                         background: choice === opt.v ? 'rgba(15,15,16,0.04)' : 'transparent',
                         cursor: 'pointer' }}>
                <input type="radio" checked={choice === opt.v} onChange={() => setChoice(opt.v)}
                  data-order-cancel-choice={opt.v}
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
              <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>REFUND METHOD</span>
              <div className="flex gap-2">
                {(['cash', 'bank', 'benefit'] as const).map(m => (
                  <button key={m} type="button" onClick={() => setRefundMethod(m)}
                    data-order-cancel-refund-method={m}
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
              <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>NOTE (OPTIONAL)</span>
              <input value={note} onChange={e => setNote(e.target.value)}
                data-order-cancel-note
                placeholder="Intended use of the credit…"
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
          No money received — the order will be cancelled without any money posting.
        </div>
      )}

      {/* v0.7.0 — Custom-Order in Arbeit (Goldsmith hat schon angefangen):
          A/P bleibt real, Stueck wird in Lager ueberfuehrt. Eigene Warn-Sektion. */}
      {stats.realizedCostCount > 0 && (
        <div style={{ padding: '12px 14px', background: '#FFF7ED',
                      border: '1px solid #F0A258', borderRadius: 8, marginBottom: 14 }}>
          <span className="text-overline" style={{ marginBottom: 8, display: 'block', color: '#9A3412' }}>
            CUSTOM WORK ALREADY STARTED
          </span>
          <ul style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7, paddingLeft: 16, margin: 0 }}>
            <li>
              <strong>A/P liability {stats.realizedCostTotal.toFixed(3)} BHD</strong> to the
              goldsmith / material supplier <strong>stays open</strong> — the supplier has already
              worked / delivered. Pay or negotiate separately (cancel the expense manually if agreed).
            </li>
            <li>
              The piece is created as a <strong>stock product</strong>
              (value {stats.customCostBasis.toFixed(3)} BHD, freely saleable).
              Appears in Collection under the custom-order category.
            </li>
          </ul>
        </div>
      )}

      {/* ── Auto-Lifecycle Info ── */}
      <div style={{ padding: '12px 14px', background: '#FAFBFC',
                    border: '1px solid #E5E9EE', borderRadius: 8, marginBottom: 18 }}>
        <span className="text-overline" style={{ marginBottom: 8, display: 'block' }}>
          AUTOMATIC ON CANCEL
        </span>
        <ul style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7, paddingLeft: 16, margin: 0 }}>
          {stats.costLineCount > 0 && stats.realizedCostCount === 0 && (
            <li>{stats.costLineCount} cost position{stats.costLineCount === 1 ? '' : 's'} (labor/material/gold, not yet delivered) — will be removed, no A/P incurred</li>
          )}
          {openGoldPayableCount > 0 && (
            <li>{openGoldPayableCount} open gold liabilit{openGoldPayableCount === 1 ? 'y' : 'ies'} (grams) — set to CANCELLED</li>
          )}
          {keptGoldPayableCount > 0 && (
            <li>{keptGoldPayableCount} gold liabilit{keptGoldPayableCount === 1 ? 'y' : 'ies'} already delivered or partly settled — <strong>stays open</strong> (the goldsmith is still owed the grams)</li>
          )}
          {stats.orderedMarkerCount > 0 && (
            <li>{stats.orderedMarkerCount} line{stats.orderedMarkerCount === 1 ? '' : 's'} "ordered from supplier" — supplier marker removed (no real purchase, no effect on supplier)</li>
          )}
          {stats.sourcedArrivedCount > 0 && (
            <li style={{ color: '#D97706' }}>
              <strong>{stats.sourcedArrivedCount} line{stats.sourcedArrivedCount === 1 ? '' : 's'} already sourced via purchase</strong> —
              the piece stays in stock (standard inventory). If you want to return it to the supplier,
              that's a separate step via Purchases → Return.
            </li>
          )}
          <li>All order lines and the order itself are set to status CANCELLED</li>
        </ul>
      </div>

      <WriteError text={submitError} />

      <div className="flex justify-end gap-3" style={{ paddingTop: 14, borderTop: '1px solid #E5E9EE' }}>
        <Button variant="ghost" onClick={onCancel} data-order-cancel-back>Back</Button>
        <Button variant="danger" onClick={confirm} disabled={busy} data-order-cancel-confirm>
          Cancel Order
        </Button>
      </div>
    </Modal>
  );
}

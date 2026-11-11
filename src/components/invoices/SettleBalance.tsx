// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT B1 — „Settle Balance" an der Verkaufsrechnung: die offene Rechnung mit einem offenen Darlehen
// „We Borrowed" DESSELBEN Kunden verrechnen — ohne Geld. Die Maske schickt nur ihre Wahl (Darlehen, Betrag, Tag,
// gesehene Fassungen); Prüfung, Buchung (Soll LOAN_PAYABLE / Haben AR), Endnummer und Verbindung macht das Haus
// (`party-offsets.ts`) — am Primary über `runOnPrimary`, auf PC2 über `invoices.record_payment` mit 'debt_offset'.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Bhd } from '@/components/ui/Bhd';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { WriteError } from '@/components/shared/WriteError';
import { useSharedWrites, nichtAmClient, fehlertext } from '@/core/data/shared-write';
import { businessDateIssue, latestBusinessDate, todayIso } from '@/core/utils/business-date';
import { OPENING_CUTOFF_DATE } from '@/core/parties/opening-balances';
import type { DebtOffsetChoice, OffsetRef } from '@/core/offsets/party-offset-reads';
import { createDebtOffsetOnPrimary, debtOffsetBody, type DebtOffsetInput } from '@/core/offsets/party-offsets';

const fils = (n: number): number => Math.round(n * 1000);
const tag = (iso: string): string => {
  const d = String(iso || '').slice(0, 10);
  const [y, m, t] = d.split('-');
  return y && m && t ? `${t}.${m}.${y}` : d;
};

export interface SettleInvoice {
  id: string; label: string; status: string; revision?: number; invoiceNumber?: string;
  numberFinalizedAt?: string | null; issuedAt?: string; createdAt?: string;
}

export function SettleBalanceDialog({ open, invoice, choice, onClose, onDone }: {
  open: boolean; invoice: SettleInvoice; choice: DebtOffsetChoice; onClose: () => void; onDone: () => void;
}) {
  const w = useSharedWrites();
  const [debtId, setDebtId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [fehler, setFehler] = useState('');
  const [artFrage, setArtFrage] = useState(false);

  // Beim Öffnen: das älteste Darlehen, der Vorschlag (kleinerer Rest), heute.
  useEffect(() => {
    if (!open) return;
    const first = choice.candidates[0];
    setDebtId(first?.debtId ?? '');
    setAmount(first ? choice.suggested.toFixed(3) : '');
    setDate(todayIso());
    setFehler('');
    setArtFrage(false);
    w.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loan = choice.candidates.find((c) => c.debtId === debtId);
  const amt = parseFloat(amount);
  const amtF = Number.isFinite(amt) ? fils(amt) : 0;
  const invAfterF = fils(choice.invoiceOpen) - amtF;
  const loanAfterF = loan ? fils(loan.open) - amtF : 0;
  const rechnungstag = String(invoice.issuedAt || invoice.createdAt || '').slice(0, 10);
  const fruehestens = useMemo(
    () => [rechnungstag, loan?.date ?? '', OPENING_CUTOFF_DATE].filter(Boolean).sort().pop() as string,
    [rechnungstag, loan?.date],
  );
  const schliesst = invAfterF <= 0 && invoice.status !== 'FINAL' && !invoice.numberFinalizedAt;
  const variant = /^(RPINV|RINV|SRINV)-/.test(invoice.invoiceNumber ?? '') ? 'repair' as const : 'sales' as const;

  function pruefen(): string {
    if (!loan) return 'Please choose a loan';
    if (!(amtF > 0) || Math.abs(amt * 1000 - amtF) > 1e-6) return 'The amount must be above 0 with at most 3 decimals';
    if (amtF > fils(choice.invoiceOpen)) return `At most ${choice.invoiceOpen.toFixed(3)} BHD is open on the invoice`;
    if (amtF > fils(loan.open)) return `At most ${loan.open.toFixed(3)} BHD is open on the loan`;
    const issue = businessDateIssue(date, 'Offset date') || (!date ? 'Please choose the offset date' : '');
    if (issue) return issue;
    if (date < fruehestens) return `The offset date must be on or after ${tag(fruehestens)} (invoice, loan and opening cutoff)`;
    return '';
  }

  async function buchen(specialMark?: boolean) {
    if (!loan) return;
    if (w.remote && !invoice.revision) { setFehler(fehlertext(nichtAmClient('settling this invoice (no revision loaded)'))); return; }
    const input: DebtOffsetInput = {
      invoiceId: invoice.id, debtId: loan.debtId, amount: amtF / 1000, offsetDate: date,
      expectedDebtRevision: loan.revision,
      ...(invoice.revision ? { expectedInvoiceRevision: invoice.revision } : {}),
      ...(specialMark !== undefined ? { specialMarkOnFinal: specialMark } : {}),
    };
    if (!await w.ok('invoices.record_payment', {
      local: () => createDebtOffsetOnPrimary(input),
      remote: () => debtOffsetBody(input),
    })) return;
    onDone();
  }

  function bestaetigen() {
    const f = pruefen();
    setFehler(f);
    if (f) return;
    if (schliesst) { setArtFrage(true); return; }
    void buchen();
  }

  return (
    <>
      <Modal open={open && !artFrage} onClose={onClose} title="Settle Balance — offset with a loan" width={520}>
        <div data-settle-dialog style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 12, color: '#6B7280', margin: 0 }}>
            The open invoice is settled against money LATAIF owes this client (We Borrowed). No cash, bank or benefit moves.
          </p>
          <div className="flex justify-between" style={{ fontSize: 13 }}>
            <span style={{ color: '#6B7280' }}>Open on {invoice.label}</span>
            <span className="font-mono" data-settle-invoice-open><Bhd v={choice.invoiceOpen} /> BHD</span>
          </div>

          <div>
            <span className="text-overline" style={{ display: 'block', marginBottom: 6 }}>LOAN (WE BORROWED) · OLDEST FIRST</span>
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
              {choice.candidates.map((c) => {
                const on = c.debtId === debtId;
                return (
                  <label key={c.debtId} data-settle-loan={c.loanNumber}
                    className="flex justify-between items-center cursor-pointer"
                    style={{ padding: '8px 12px', borderTop: '1px solid #EEF0F2', background: on ? 'rgba(15,15,16,0.04)' : 'transparent', fontSize: 12 }}>
                    <span className="flex items-center" style={{ gap: 8 }}>
                      <input type="radio" name="settle-loan" checked={on} onChange={() => {
                        setDebtId(c.debtId);
                        setAmount((Math.min(fils(choice.invoiceOpen), fils(c.open)) / 1000).toFixed(3));
                        setFehler('');
                      }} />
                      <span style={{ color: '#0F0F10' }}>{c.loanNumber}</span>
                      <span style={{ color: '#9CA3AF' }}>{tag(c.date)}</span>
                    </span>
                    <span className="font-mono" style={{ color: '#4B5563' }}>open <Bhd v={c.open} /> BHD</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Input label="AMOUNT (BHD)" type="number" step="0.001" min="0.001" value={amount}
              onChange={(e) => { setAmount(e.target.value); setFehler(''); }} data-settle-amount />
            <Input label="OFFSET DATE" type="date" value={date} min={fruehestens} max={latestBusinessDate()}
              onChange={(e) => { setDate(e.target.value); setFehler(''); }} data-settle-date />
          </div>

          {loan && amtF > 0 && (
            <div data-settle-preview style={{ padding: '10px 12px', background: '#F9FAFB', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="flex justify-between">
                <span style={{ color: '#4B5563' }}>Invoice {invoice.label}</span>
                <span data-settle-preview-invoice>
                  {invAfterF <= 0 ? 'Paid' : 'Partially Paid'} · open <span className="font-mono"><Bhd v={Math.max(0, invAfterF) / 1000} /></span> BHD
                </span>
              </div>
              <div className="flex justify-between">
                <span style={{ color: '#4B5563' }}>Loan {loan.loanNumber}</span>
                <span data-settle-preview-loan>
                  {loanAfterF <= 0 ? 'Repaid' : 'Partially repaid'} · open <span className="font-mono"><Bhd v={Math.max(0, loanAfterF) / 1000} /></span> BHD
                </span>
              </div>
              <div style={{ color: '#6B7280' }}>
                Both documents show this offset ({tag(date)}, <span className="font-mono"><Bhd v={amtF / 1000} /></span> BHD) with the counter document · Offset – no cash.
              </div>
            </div>
          )}

          <WriteError text={fehler || w.fehler} />
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={bestaetigen} disabled={w.busy || !loan} data-settle-confirm>
              <ArrowLeftRight size={14} /> Confirm offset
            </Button>
          </div>
        </div>
      </Modal>
      <NumberTypeDialog
        open={open && artFrage}
        variant={variant}
        title="Final Number Type"
        onCancel={() => setArtFrage(false)}
        onConfirm={(special) => { setArtFrage(false); void buchen(special); }}
      />
    </>
  );
}

/**
 * Die Verrechnungen einer Rechnung (wirksam und aufgehoben) mit Gegenbeleg; „Remove offset" nur für eine wirksame.
 * CUSTOMER ACCOUNT C — auch die Zuordnungen aus „Settle Balance" (STL-…/n; Gegenbeleg Darlehen oder Store Credit).
 * B2/B3 — Gegenbeleg Einkauf: „purchase PUR-…" bzw. „consignment purchase PUR-…" mit Verweis auf den Einkauf.
 */
export function InvoiceOffsetList({ offsets, canRemove, busy, onRemove }: {
  offsets: OffsetRef[]; canRemove: boolean; busy: boolean; onRemove: (o: OffsetRef) => void;
}) {
  if (offsets.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }} data-invoice-offsets>
      <span className="text-overline" style={{ display: 'block', marginBottom: 4 }}>OFFSETS</span>
      {offsets.map((o) => {
        const aktiv = o.status === 'ACTIVE';
        return (
          <div key={o.offsetId} data-invoice-offset={o.offsetNumber} data-invoice-offset-status={o.status}
            className="flex justify-between items-center" style={{ padding: '5px 0', borderBottom: '1px solid #EEF0F2', fontSize: 11, gap: 8 }}>
            <span style={{ color: aktiv ? '#4B5563' : '#9CA3AF', minWidth: 0 }}>
              {tag(o.offsetDate)} · {o.offsetNumber}{o.settlementNumber ? ' (settlement)' : ''} · {o.payableType === 'STORE_CREDIT' || o.payableType === 'PARTNER_ITEM' ? o.sourceLabel : o.payableType === 'PURCHASE' ? (<>{o.sourceLabel.replace(/ \S+$/, '')}{' '}
              <Link to={`/purchases/${o.debtId}`} style={{ color: 'inherit', textDecoration: 'underline' }} data-invoice-offset-purchase>{o.sourceLabel.split(' ').pop()}</Link></>) : (<>loan{' '}
              <Link to={`/debts?filter=all&loan=${encodeURIComponent(o.loanNumber)}`} style={{ color: 'inherit', textDecoration: 'underline' }}>{o.loanNumber}</Link></>)}
              {' '}· Offset – no cash{aktiv ? '' : ` · reversed${o.reverseReason ? ` (${o.reverseReason})` : ''}`}
            </span>
            <span className="flex items-center" style={{ gap: 8, flexShrink: 0 }}>
              <span className="font-mono" style={{ color: aktiv ? '#16A34A' : '#9CA3AF', textDecoration: aktiv ? 'none' : 'line-through' }}><Bhd v={o.amount} /> BHD</span>
              {aktiv && canRemove && (
                <button type="button" disabled={busy} onClick={() => onRemove(o)} data-invoice-offset-remove
                  className="cursor-pointer" style={{ padding: '2px 8px', fontSize: 10, background: 'none', border: '1px solid #D5D9DE', borderRadius: 4, color: '#AA6E6E' }}>
                  Remove offset
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SETTLEMENT S2 — „Receive Payment" am Kunden: ein Betrag über seine offenen Rechnungen.
//   • Automatisch: der Primary verteilt, älteste Rechnung zuerst (dieselbe Rechnung zeigt die Vorschau).
//   • Manuell: der Benutzer verteilt selbst — je Rechnung höchstens ihr Offenes, Summe = Betrag.
// Jede Teilzahlung ist eine gewöhnliche Rechnungszahlung (`customers.settle` → `recordInvoicePaymentInHouse`).
// Ein Betrag über allem Offenen wird nur mit ausdrücklicher Wahl Store-Guthaben. Eröffnungsposten und Erlass sind
// sichtbar, aber gesperrt, bis der Buchhalter die Regeln bestätigt.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { OP_PARTIES_ACCOUNT_GET, partyAccountReadFor, type PartyAccountRead } from '@/core/parties/party-account';
import {
  planCustomerSettlement, previewPaymentAndWaiver, settleCustomerOnPrimary,
  type CustomerSettled, type CustomerSettleRequest, type SettlementInvoice, type SettlementPlan,
} from '@/core/parties/customer-settlement';
import { INVOICE_PAYMENT_METHODS } from '@/core/invoices/invoice-payment-house';

const toFils = (n: number): number => Math.round(n * 1000);
const fmt = (f: number): string => (f / 1000).toFixed(3);
const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', benefit: 'Benefit', other: 'Other' };

export function CustomerSettlementModal({ customerId, customerName, onClose, onDone }: {
  customerId: string; customerName: string; onClose: () => void; onDone: () => void;
}) {
  const w = useSharedWrites();
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<string>('cash');
  const [cardBrand, setCardBrand] = useState<'normal' | 'amex' | 'debit'>('normal');
  const [manual, setManual] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [excessOk, setExcessOk] = useState(false);
  const [waiver, setWaiver] = useState('');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const data = useSharedRead<PartyAccountRead | null>(
    OP_PARTIES_ACCOUNT_GET, { partyType: 'CUSTOMER', partyId: customerId },
    (ctx) => partyAccountReadFor(ctx, { partyType: 'CUSTOMER', partyId: customerId }),
    null, [customerId],
  );
  const invoices = useMemo<SettlementInvoice[]>(() => (data?.settlement?.invoices ?? []).map((i) => ({
    id: i.id, number: i.number, date: i.date, totalF: toFils(i.total), openF: toFils(i.open), cnCancelF: i.hasCreditNote ? 1 : 0,
  })), [data]);
  const openF = invoices.reduce((s, i) => s + i.openF, 0);
  const amountF = toFils(Number(amount.replace(',', '.')) || 0);
  const manualF = invoices.reduce((s, i) => s + toFils(Number((alloc[i.id] ?? '').replace(',', '.')) || 0), 0);
  const waiverF = toFils(Number(waiver.replace(',', '.')) || 0);

  const plan = useMemo(() => {
    if (!(amountF > 0)) return null;
    try {
      return planCustomerSettlement(invoices, amountF, manual ? 'manual' : 'fifo',
        manual ? invoices.map((i) => ({ invoiceId: i.id, amountF: toFils(Number((alloc[i.id] ?? '').replace(',', '.')) || 0) })).filter((a) => a.amountF > 0) : []);
    } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }, [invoices, amountF, manual, alloc]);
  const planOk = plan && !('error' in plan) ? plan : null;
  const excessF = planOk?.excessF ?? 0;
  const waiverPreview = waiverF > 0 ? previewPaymentAndWaiver(openF, amountF, waiverF) : null;

  // PUSH-GATE — ein Doppelklick darf nie zweimal zahlen: der zweite Klick kam vorher noch vor der Rückfrage durch
  // (`busy` gilt erst während des Speicherns) und erzeugte eine zweite Zahlung. Eine Absicht, ein Vorgang.
  const sending = useRef(false);

  async function submit(): Promise<void> {
    if (sending.current || !planOk || waiverF > 0) return;
    sending.current = true;
    let done = false;
    try {
      done = await submitOnce(planOk);
    } finally {
      // Nach Erfolg schließt das Fenster — bis dahin bleibt es gesperrt.
      if (!done) sending.current = false;
    }
  }

  async function submitOnce(planOk: SettlementPlan): Promise<boolean> {
    const req: CustomerSettleRequest = {
      customerId, amount: amountF / 1000, method, mode: manual ? 'manual' : 'fifo',
      ...(method === 'card' ? { cardBrand } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(manual ? { allocations: planOk.allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amountF / 1000 })) } : {}),
      ...(excessF > 0 && excessOk ? { confirmExcessAsCredit: true } : {}),
      // PAYMENT FINAL VERIFICATION — der Stand, den dieses Fenster gezeigt hat (vom Primary berechnet).
      expectedOpenStamp: data?.settlement?.openStamp ?? '',
    };
    const lines = planOk.allocations.map((a) => `${invoices.find((i) => i.id === a.invoiceId)?.number}: ${fmt(a.amountF)}`).join('\n');
    if (!(await window.confirm(`Receive ${fmt(amountF)} BHD (${METHOD_LABEL[method] ?? method}) from ${customerName}?\n\n${lines}${excessF > 0 ? `\nStore credit: ${fmt(excessF)}` : ''}`))) return false;
    const out = await w.save<CustomerSettled>('customers.settle', {
      local: () => settleCustomerOnPrimary(req),
      remote: () => ({ ...req }),
    });
    if (out.kind !== 'ok') { setMsg(fehlertext(out)); return false; }
    onDone();
    onClose();
    return true;
  }

  return (
    <Modal open onClose={onClose} title={`Receive payment · ${customerName}`} width={680}>
      <div data-settlement-dialog style={{ display: 'grid', gap: 12, fontSize: 13 }}>
        {data === null && <p style={{ color: '#9CA3AF' }} data-settlement-unavailable>Open invoices are not available right now.</p>}
        {data && (
          <p style={{ color: '#4B5563' }}>
            Open in LATAIF: <b className="font-mono">{fmt(openF)} BHD</b> on {invoices.length} invoice{invoices.length === 1 ? '' : 's'}.
            {' '}Each part is a normal invoice payment — no new revenue, no new VAT.
          </p>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <Input label="Amount received (BHD)" value={amount} onChange={(e) => setAmount(e.target.value)} data-settlement-amount />
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="text-overline">METHOD</span>
            <select value={method} onChange={(e) => setMethod(e.target.value)} data-settlement-method>
              {INVOICE_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m] ?? m}</option>)}
            </select>
          </label>
          {method === 'card' ? (
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span className="text-overline">CARD</span>
              <select value={cardBrand} onChange={(e) => setCardBrand(e.target.value as 'normal' | 'amex' | 'debit')}>
                <option value="normal">Visa / Mastercard</option>
                <option value="amex">Amex</option>
                <option value="debit">Debit card</option>
              </select>
            </label>
          ) : <span />}
        </div>
        <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} data-settlement-manual />
          Choose the invoices myself (otherwise the oldest invoice is paid first)
        </label>
        <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid #E5E9EE', borderRadius: 8 }}>
          {invoices.map((i) => {
            const auto = planOk?.allocations.find((a) => a.invoiceId === i.id)?.amountF ?? 0;
            return (
              <div key={i.id} className="flex justify-between items-center" style={{ padding: '6px 10px', borderTop: '1px solid #F1F3F5', fontSize: 12 }} data-settlement-invoice={i.number}>
                <span><b className="font-mono">{i.number}</b> · {i.date} · open <span className="font-mono">{fmt(i.openF)}</span></span>
                {manual
                  ? <input value={alloc[i.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [i.id]: e.target.value })} placeholder="0.000" style={{ width: 100, textAlign: 'right' }} data-settlement-alloc />
                  : <span className="font-mono" style={{ color: auto > 0 ? '#0F0F10' : '#9CA3AF' }}>{auto > 0 ? fmt(auto) : '—'}</span>}
              </div>
            );
          })}
          {(data?.settlement?.openingItems.length ?? 0) > 0 && (
            <div style={{ padding: '6px 10px', fontSize: 11, color: '#9A6B00', borderTop: '1px solid #F1F3F5' }} data-settlement-opening>
              Opening positions ({data!.settlement!.openingItems.map((o) => o.itemNumber).join(', ')}) are recorded but not booked yet — they cannot be paid here until the accountant confirms the opening rules.
            </div>
          )}
        </div>
        {manual && amountF > 0 && <div style={{ fontSize: 12, color: manualF === amountF ? '#3F6E2F' : '#7A3535' }}>Allocated {fmt(manualF)} of {fmt(amountF)}</div>}
        {plan && 'error' in plan && <div style={{ fontSize: 12, color: '#7A3535' }} data-settlement-refused>{plan.error}</div>}
        {excessF > 0 && (
          <label className="flex items-center gap-2" style={{ fontSize: 12, color: '#7A3535' }} data-settlement-excess>
            <input type="checkbox" checked={excessOk} onChange={(e) => setExcessOk(e.target.checked)} />
            {fmt(excessF)} BHD is more than everything open — keep it as store credit for {customerName} (redeemable on invoices).
          </label>
        )}
        <div style={{ padding: '8px 10px', borderRadius: 8, background: '#FAFBFC', fontSize: 12, color: '#4B5563' }} data-settlement-waiver>
          <Input label="Agreed lower amount — part to waive (preview only)" value={waiver} onChange={(e) => setWaiver(e.target.value)} data-settlement-waiver-amount />
          {waiverPreview && (
            <div style={{ marginTop: 6 }}>
              Open {fmt(openF)} · paid {fmt(waiverPreview.paidF)} · waived {fmt(waiverPreview.waivedF)} · rest {fmt(waiverPreview.restF)}.
            </div>
          )}
          <div style={{ marginTop: 6, color: '#9A6B00' }}>
            {data?.settlement?.waiver.reason ?? 'Debt waiver / write-off is not available yet.'} A waived amount is never counted as paid.
          </div>
        </div>
        <Input label="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {msg && <div style={{ fontSize: 12, color: '#7A3535' }} data-settlement-error>{msg}</div>}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={w.busy || !planOk || waiverF > 0 || (excessF > 0 && !excessOk)} onClick={() => void submit()} data-settlement-submit>
            Receive payment
          </Button>
        </div>
      </div>
    </Modal>
  );
}

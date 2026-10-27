// ════════════════════════════════════════════════════════════════════════════
// CONSIGNMENT MULTI-SALE — der EINE „Record Sale"-Dialog für einen oder mehrere Kommissionsartikel (auch verschiedener
// Einlieferer): je Artikel Preis, Provision und Auszahlung, Steuerart, die Summe, der Käufer (mit „+ New Client"),
// der Verkaufstag (= Rechnungsdatum, D1), Zahlungen wie bei „Save Invoice" (D5) und die Pflichtbestätigungen bei
// Unterdeckung. Gebucht wird über DIESELBE Hausfolge am Primary und von PC2 (`consignments.record_sale`).
// Die Ökonomie rechnet `computeConsignmentSale` (dieselbe Funktion wie die Buchung), die Steuer `vatEngine` wie der
// Store — die Vorschau ist, was gebucht wird.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { NumberTypeDialog } from '@/components/ui/NumberTypeDialog';
import { Bhd } from '@/components/ui/Bhd';
import { WriteError } from '@/components/shared/WriteError';
import { QuickCustomerModal } from '@/components/customers/QuickCustomerModal';
import { useConsignmentStore } from '@/stores/consignmentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useProductStore } from '@/stores/productStore';
import { useSharedWrites, fehlertext, nichtAmClient } from '@/core/data/shared-write';
import { computeConsignmentSale, commissionLineLabel } from '@/core/consignment/economics';
import { consignmentSalesBody, MAX_SALE_ITEMS, type ConsignmentMultiSaleInput } from '@/core/consignment/consignment-finance';
import { recordConsignmentSalesOnPrimary } from '@/core/consignment/consignment-finance-house';
import { invoiceCreatePaymentsBody, MAX_CREATE_PAYMENTS, type InvoiceCreatePayment } from '@/core/invoices/invoice-create-house';
import { CARD_BRAND_OPTIONS, cardFeeConfigured, computeCardFee, type CardBrand } from '@/core/finance/card-fees';
import { businessDateIssue, latestBusinessDate } from '@/core/utils/business-date';
import { currentBranchId } from '@/core/db/helpers';
import { vatEngine } from '@/core/tax/vat-engine';
import { productDisplayName } from '@/core/products/display-name';
import type { TaxScheme } from '@/core/models/types';

type Method = 'cash' | 'bank_transfer' | 'card' | 'benefit';

/** Eine Zahlungszeile beim Verkauf — dieselbe Form wie bei „Save Invoice" (v0.8.87). */
interface PayRow {
  key: number;
  method: Method;
  cardBrand: CardBrand;
  amountText: string;
  date: string;
  /** Der Mensch hat den Tag selbst gewählt — dann folgt er dem Verkaufstag nicht mehr. */
  dateTouched: boolean;
}
const payAmountOf = (r: PayRow): number => { const v = parseFloat(r.amountText); return Number.isFinite(v) ? v : 0; };
const DEBIT_FEE_MISSING = 'Debit card fee is not set yet. Enter it in Settings → Tax / VAT → Card Processing Fee (0 % is allowed).';
const SCHEME_LABEL: Record<string, string> = { MARGIN: 'Margin scheme', VAT_10: 'VAT 10 %', ZERO: 'Zero-rated' };
const today = (): string => new Date().toISOString().split('T')[0];

interface Props {
  open: boolean;
  /** Die Kommissionen, die verkauft werden — eine oder mehrere (Reihenfolge = Reihenfolge der Rechnungszeilen). */
  consignmentIds: readonly string[];
  onClose: () => void;
  /** Nach dem Buchen — die Seite lädt ihre Listen neu, leert ihre Auswahl. */
  onSold?: () => void;
}

export function ConsignmentSaleDialog({ open, consignmentIds, onClose, onSold }: Props) {
  const { consignments, loadConsignments } = useConsignmentStore();
  const { customers, loadCustomers } = useCustomerStore();
  const { products, loadProducts } = useProductStore();
  const w = useSharedWrites();

  const [prices, setPrices] = useState<Record<string, string>>({});
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [buyerId, setBuyerId] = useState('');
  const [saleDate, setSaleDate] = useState(today());
  const [notes, setNotes] = useState('');
  const [payRows, setPayRows] = useState<PayRow[]>([]);
  const [payRowSeq, setPayRowSeq] = useState(2);
  const [showQuickBuyer, setShowQuickBuyer] = useState(false);
  const [numberDialogOpen, setNumberDialogOpen] = useState(false);
  const [error, setError] = useState('');

  const items = useMemo(
    () => consignmentIds.map((id) => consignments.find((c) => c.id === id)).filter((c): c is NonNullable<typeof c> => !!c),
    [consignmentIds, consignments],
  );

  // Beim Öffnen: Preise = vereinbarter Preis, alles andere leer — der Dialog beginnt immer frisch.
  useEffect(() => {
    if (!open) return;
    w.clear();
    setError('');
    setPrices(Object.fromEntries(consignmentIds.map((id) => {
      const c = useConsignmentStore.getState().consignments.find((k) => k.id === id);
      return [id, c?.agreedPrice ? String(c.agreedPrice) : ''];
    })));
    setAcks({});
    setBuyerId('');
    setSaleDate(today());
    setNotes('');
    setPayRows([{ key: 1, method: 'cash', cardBrand: 'normal', amountText: '', date: today(), dateTouched: false }]);
    setPayRowSeq(2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, consignmentIds.join('|')]);

  // Der vorgeschlagene Zahlungstag ist der Verkaufstag — bis der Mensch den Tag einer Zeile selbst wählt.
  useEffect(() => {
    setPayRows((prev) => prev.map((r) => (r.dateTouched || r.date === saleDate ? r : { ...r, date: saleDate })));
  }, [saleDate]);

  const rows = useMemo(() => items.map((c) => {
    const price = Number(prices[c.id]) || 0;
    const econ = computeConsignmentSale(c, price);
    const prod = products.find((p) => p.id === c.productId);
    const scheme = ((prod?.taxScheme as TaxScheme | undefined) || 'MARGIN') as TaxScheme;
    const rate = scheme === 'ZERO' ? 0 : 10;
    const purchasePrice = prod?.purchasePrice || econ.payout;
    const calc = price > 0 ? vatEngine.calculateNet(scheme === 'VAT_10' ? price / (1 + rate / 100) : price, purchasePrice, scheme, rate) : null;
    const vat = calc ? (calc.internalVatAmount ?? calc.vatAmount) : 0;
    const consignor = customers.find((k) => k.id === c.consignorId);
    return {
      c, price, econ, scheme, vat, prod,
      label: prod ? productDisplayName(prod) : c.consignmentNumber,
      consignorName: consignor ? `${consignor.firstName} ${consignor.lastName}`.trim() : '—',
      needsAck: price > 0 && econ.belowFloor,
    };
  }), [items, prices, products, customers]);

  const total = rows.reduce((s, r) => s + r.price, 0);
  const totalPayout = rows.reduce((s, r) => s + r.econ.payout, 0);
  const totalCommission = rows.reduce((s, r) => s + r.econ.commission, 0);
  const paid = payRows.reduce((s, r) => s + Math.max(0, payAmountOf(r)), 0);
  const buyerIsConsignor = !!buyerId && items.some((c) => c.consignorId === buyerId);
  const consignorCount = new Set(items.map((c) => c.consignorId)).size;

  function updatePayRow(key: number, patch: Partial<PayRow>) {
    setPayRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function addPayRow() {
    setPayRows((prev) => {
      if (prev.length >= MAX_CREATE_PAYMENTS) return prev;
      const open = Math.max(0, total - prev.reduce((s, r) => s + Math.max(0, payAmountOf(r)), 0));
      return [...prev, { key: payRowSeq, method: 'cash', cardBrand: 'normal', amountText: open > 0.0005 ? open.toFixed(3) : '', date: saleDate, dateTouched: false }];
    });
    setPayRowSeq((n) => n + 1);
  }
  function removePayRow(key: number) {
    setPayRows((prev) => (prev.length === 1 ? [{ ...prev[0], amountText: '' }] : prev.filter((r) => r.key !== key)));
  }
  /** Die Kartengebühr einer Zeile als Vorschau — nur, wo die Sätze liegen (Primary); gebucht wird sie im Haus. */
  function cardFeePreview(r: PayRow): number | null {
    if (w.remote || r.method !== 'card' || !(payAmountOf(r) > 0)) return null;
    try { return computeCardFee(currentBranchId(), payAmountOf(r), r.cardBrand); } catch { return null; }
  }
  function debitFeeMissing(r: PayRow): boolean {
    if (w.remote || r.method !== 'card' || r.cardBrand !== 'debit') return false;
    try { return !cardFeeConfigured(currentBranchId(), 'debit'); } catch { return false; }
  }

  function validate(): string | null {
    if (items.length === 0) return 'Select at least one consignment';
    if (items.length !== consignmentIds.length) return 'One of the selected consignments is no longer available — reopen the dialog';
    if (items.length > MAX_SALE_ITEMS) return `At most ${MAX_SALE_ITEMS} items in one sale`;
    const nichtAktiv = items.find((c) => c.status !== 'active');
    if (nichtAktiv) return `${nichtAktiv.consignmentNumber} is "${nichtAktiv.status}" — only active consignments are sold`;
    if (!buyerId) return 'Please select the buyer';
    if (buyerIsConsignor) return 'The buyer cannot be the consignor of one of these items — use "Return" if the consignor takes an item back';
    const ohnePreis = rows.find((r) => !(r.price > 0));
    if (ohnePreis) return `${ohnePreis.c.consignmentNumber}: enter a sale price above 0`;
    const ohneAck = rows.find((r) => r.needsAck && !acks[r.c.id]);
    if (ohneAck) return `${ohneAck.c.consignmentNumber}: confirm the consignor-loss shortfall`;
    const tag = businessDateIssue(saleDate, 'Sale date');
    if (tag || !saleDate) return tag || 'Please choose the sale date';
    for (let i = 0; i < payRows.length; i++) {
      const r = payRows[i];
      const raw = r.amountText.trim();
      if (raw === '') continue;
      const v = parseFloat(raw);
      if (!Number.isFinite(v) || v < 0) return `Payment ${i + 1}: the amount must be a number of 0 or more`;
      if (v === 0) continue;
      const dateIssue = businessDateIssue(r.date, `Payment ${i + 1} date`);
      if (dateIssue || !r.date) return dateIssue || `Payment ${i + 1}: please choose the payment date`;
      if (r.date < saleDate) return `Payment ${i + 1}: the payment date cannot be before the sale date`;
      if (debitFeeMissing(r)) return `Payment ${i + 1}: ${DEBIT_FEE_MISSING}`;
    }
    if (paid > total + 0.0005) return 'The payments exceed the total — an overpayment is recorded on the invoice page';
    return null;
  }

  function handleConfirm() {
    const v = validate();
    setError(v ?? '');
    if (v) return;
    if (w.remote && items.some((c) => !c.revision)) { w.clear(); setError(fehlertext(nichtAmClient('recording this sale (no revision loaded)'))); return; }
    // Wie bisher fragt „Record Sale" IMMER nach dem Belegkreis der entstehenden Rechnung.
    setNumberDialogOpen(true);
  }

  async function executeSale(specialMark: boolean) {
    setNumberDialogOpen(false);
    const zahlungen = invoiceCreatePaymentsBody(payRows.map((r) => ({ amount: payAmountOf(r), method: r.method, cardBrand: r.cardBrand, paidDate: r.date })));
    const input: ConsignmentMultiSaleInput = {
      items: rows.map((r) => ({ consignmentId: r.c.id, salePrice: r.price, acknowledgeShortfall: acks[r.c.id] === true })),
      buyerId,
      saleDate,
      notes: notes.trim() || undefined,
      specialMark,
      ...(zahlungen.length > 0 ? { payments: zahlungen as unknown as InvoiceCreatePayment[] } : {}),
    };
    const revisions = Object.fromEntries(items.map((c) => [c.id, Number(c.revision)]));
    if (!await w.ok('consignments.record_sale', {
      local: () => recordConsignmentSalesOnPrimary(input),
      remote: () => consignmentSalesBody(input, revisions),
    })) return;
    loadConsignments();
    loadProducts();
    onSold?.();
    onClose();
  }

  const single = rows.length === 1;
  return (
    <>
      <Modal open={open} onClose={onClose} title={single ? 'Record Sale' : `Record Sale — ${rows.length} items`} width={single ? 560 : 820}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '70vh', overflowY: 'auto', paddingRight: 4 }} data-consignment-sale-dialog>
          <div>
            <SearchSelect
              label="BUYER"
              placeholder="Search clients..."
              options={customers.map((c) => ({ id: c.id, label: `${c.firstName} ${c.lastName}`, subtitle: c.company, meta: c.phone }))}
              value={buyerId}
              onChange={(id) => setBuyerId(id)}
            />
            <button onClick={() => setShowQuickBuyer(true)}
              data-consignment-sale-new-client
              className="cursor-pointer transition-colors"
              style={{ background: 'none', border: 'none', color: '#0F0F10', fontSize: 11, marginTop: 6, padding: 0 }}
            >+ New Client</button>
          </div>

          {!single && (
            <div style={{ fontSize: 12, color: '#6B7280' }} data-consignment-sale-summary>
              {rows.length} items from {consignorCount} consignor{consignorCount === 1 ? '' : 's'} — one invoice for the buyer, one purchase per item for its consignor.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r) => (
              <div key={r.c.id} data-consignment-sale-row={r.c.id}
                style={{ padding: single ? 0 : '12px 14px', border: single ? 'none' : '1px solid #E5E9EE', borderRadius: 8 }}>
                {!single && (
                  <div className="flex justify-between" style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{ color: '#0F0F10' }}>
                      <span className="font-mono" style={{ fontSize: 12, color: '#6B7280', marginRight: 8 }}>{r.c.consignmentNumber}</span>
                      {r.label}
                    </span>
                    <span style={{ color: '#6B7280', fontSize: 12 }}>Consignor: {r.consignorName}</span>
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: single ? '1fr 1fr' : '160px 1fr', gap: 16, alignItems: 'end' }}>
                  <Input required label="SALE PRICE (BHD)" type="number" placeholder="0"
                    value={prices[r.c.id] ?? ''} data-consignment-sale-price={r.c.id}
                    onChange={(e) => { const v = e.target.value; setPrices((p) => ({ ...p, [r.c.id]: v })); setAcks((a) => ({ ...a, [r.c.id]: false })); }} />
                  {single ? (
                    <Input label="SALE DATE" type="date" max={latestBusinessDate()} value={saleDate} data-consignment-sale-date
                      onChange={(e) => setSaleDate(e.target.value)} />
                  ) : (
                    <div className="font-mono" style={{ fontSize: 12, color: '#4B5563', lineHeight: 1.7 }}>
                      <div className="flex justify-between"><span>{commissionLineLabel(r.c)}</span><span style={{ color: r.econ.commission < 0 ? '#DC2626' : '#0F0F10' }}><Bhd v={r.econ.commission}/> BHD</span></div>
                      <div className="flex justify-between"><span>Payout to consignor</span><span style={{ color: '#7EAA6E' }}><Bhd v={r.econ.payout}/> BHD</span></div>
                      <div className="flex justify-between"><span>{SCHEME_LABEL[r.scheme] ?? r.scheme}</span><span>VAT <Bhd v={r.vat}/> BHD</span></div>
                    </div>
                  )}
                </div>
                {single && r.price > 0 && (
                  <div className="rounded font-mono" style={{ padding: 14, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 13, marginTop: 14 }}>
                    <div className="flex justify-between" style={{ marginBottom: 8 }}>
                      <span style={{ color: '#6B7280' }}>{commissionLineLabel(r.c)}</span>
                      <span style={{ color: r.econ.commission < 0 ? '#DC2626' : '#0F0F10' }}><Bhd v={r.econ.commission}/> BHD</span>
                    </div>
                    <div className="flex justify-between" style={{ marginBottom: 8 }}>
                      <span style={{ color: '#6B7280' }}>Payout to consignor</span>
                      <span style={{ color: '#7EAA6E' }}><Bhd v={r.econ.payout}/> BHD</span>
                    </div>
                    <div className="flex justify-between">
                      <span style={{ color: '#6B7280' }}>{SCHEME_LABEL[r.scheme] ?? r.scheme}</span>
                      <span style={{ color: '#0F0F10' }}>VAT <Bhd v={r.vat}/> BHD</span>
                    </div>
                  </div>
                )}
                {r.needsAck && (
                  <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.30)', fontSize: 12, color: '#DC2626' }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>
                      ⚠ Sale <Bhd v={r.econ.loss}/> BHD below {r.c.commissionType === 'cost_split' ? "consignor's cost" : 'agreed price'}
                    </div>
                    <div style={{ marginBottom: 8, color: '#7A2A2A' }}>
                      Consignor still receives <Bhd v={r.c.agreedPrice}/> BHD — the <Bhd v={r.econ.loss}/> BHD difference will be recorded as a <strong>Consignor Loss</strong> expense.
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer" style={{ fontSize: 12 }}>
                      <input type="checkbox" checked={acks[r.c.id] === true} data-consignment-sale-ack={r.c.id}
                        onChange={(e) => { const v = e.target.checked; setAcks((a) => ({ ...a, [r.c.id]: v })); }} />
                      <span>I confirm — record this shortfall as Consignor Loss</span>
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!single && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'end' }}>
              <Input label="SALE DATE" type="date" max={latestBusinessDate()} value={saleDate} data-consignment-sale-date
                onChange={(e) => setSaleDate(e.target.value)} />
              <div className="font-mono" style={{ fontSize: 13, color: '#0F0F10', lineHeight: 1.7 }} data-consignment-sale-total>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Total (invoice)</span><strong><Bhd v={total}/> BHD</strong></div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Payouts to consignors</span><span style={{ color: '#7EAA6E' }}><Bhd v={totalPayout}/> BHD</span></div>
                <div className="flex justify-between"><span style={{ color: '#6B7280' }}>Our share</span><span><Bhd v={totalCommission}/> BHD</span></div>
              </div>
            </div>
          )}
          <div style={{ fontSize: 11, color: '#6B7280', marginTop: -8 }}>The sale date is also the invoice date.</div>

          {buyerIsConsignor && (
            <div style={{ padding: '12px 14px', borderRadius: 8, background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.40)', fontSize: 12, color: '#DC2626' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Buyer cannot be the same as the consignor</div>
              <div style={{ color: '#7A2A2A' }}>
                If the consignor is taking the item back, use <strong>Return</strong> instead — no invoice/purchase needed.
              </div>
            </div>
          )}

          {/* D5 — Zahlungen beim Verkauf: dieselben Zeilen wie „Save Invoice" (Weg, Kartenart, Betrag, Tag). Leer = später zahlen. */}
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>PAYMENT (OPTIONAL)</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-consignment-sale-pay-rows>
              {payRows.map((r, idx) => {
                const fee = cardFeePreview(r);
                return (
                  <div key={r.key} data-consignment-sale-pay-row={idx}
                    style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr auto', gap: 12, alignItems: 'end', padding: '10px 12px', border: '1px solid #E5E9EE', borderRadius: 8 }}>
                    <div>
                      <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>{payRows.length > 1 ? `PAYMENT ${idx + 1} · METHOD` : 'METHOD'}</span>
                      <div className="flex gap-2" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                        {([
                          { id: 'cash', label: 'Cash' },
                          { id: 'bank_transfer', label: 'Bank' },
                          { id: 'card', label: 'Card' },
                          { id: 'benefit', label: 'Benefit' },
                        ] as const).map((m) => {
                          const active = r.method === m.id;
                          return (
                            <button key={m.id} type="button" onClick={() => updatePayRow(r.key, { method: m.id })} data-consignment-sale-pay-method={m.id}
                              className="cursor-pointer rounded"
                              style={{ padding: '7px 12px', fontSize: 12, border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                                color: active ? '#0F0F10' : '#6B7280', background: active ? 'rgba(15,15,16,0.06)' : 'transparent' }}>{m.label}</button>
                          );
                        })}
                      </div>
                      {r.method === 'card' && (
                        <div className="flex gap-2" style={{ marginTop: 8 }}>
                          {CARD_BRAND_OPTIONS.map((b) => {
                            const on = r.cardBrand === b.id;
                            return (
                              <button key={b.id} type="button" onClick={() => updatePayRow(r.key, { cardBrand: b.id })} data-consignment-sale-pay-card-brand={b.id}
                                className="cursor-pointer rounded"
                                style={{ padding: '5px 10px', fontSize: 12, border: `1px solid ${on ? '#0F0F10' : '#D5D9DE'}`,
                                  color: on ? '#0F0F10' : '#6B7280', background: on ? 'rgba(15,15,16,0.06)' : 'transparent' }}>{b.label}</button>
                            );
                          })}
                        </div>
                      )}
                      {r.method === 'card' && (
                        debitFeeMissing(r) ? (
                          <div style={{ fontSize: 11, color: '#AA6E6E', marginTop: 6 }}>{DEBIT_FEE_MISSING}</div>
                        ) : (
                          <div style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>
                            {fee !== null ? <>Card fee <Bhd v={fee}/> BHD (booked with this payment)</> : 'The card fee is booked with this payment by the main computer.'}
                          </div>
                        )
                      )}
                    </div>
                    <Input label="AMOUNT (BHD)" type="number" step="0.001" min="0" value={r.amountText} data-consignment-sale-pay-amount
                      onChange={(e) => updatePayRow(r.key, { amountText: e.target.value })} />
                    <Input label="PAYMENT DATE" type="date" min={saleDate} max={latestBusinessDate()} value={r.date} data-consignment-sale-pay-date
                      onChange={(e) => updatePayRow(r.key, { date: e.target.value, dateTouched: true })} />
                    <button type="button" onClick={() => removePayRow(r.key)} title="Remove this payment"
                      className="cursor-pointer rounded" disabled={payRows.length === 1 && !r.amountText}
                      style={{ padding: 8, border: '1px solid #D5D9DE', background: 'transparent', color: '#9CA3AF', marginBottom: 2 }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 items-center" style={{ marginTop: 10 }}>
              <button onClick={addPayRow} disabled={payRows.length >= MAX_CREATE_PAYMENTS} data-consignment-sale-pay-add
                className="cursor-pointer rounded flex items-center gap-1"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #0F0F10', color: '#0F0F10', background: 'transparent' }}>
                <Plus size={12} /> Add Payment
              </button>
              <button data-consignment-sale-pay-full
                onClick={() => setPayRows((prev) => {
                  const last = prev[prev.length - 1];
                  const others = prev.slice(0, -1).reduce((s, x) => s + Math.max(0, payAmountOf(x)), 0);
                  const rest = Math.max(0, total - others);
                  return prev.map((x) => (x.key === last.key ? { ...x, amountText: rest > 0.0005 ? rest.toFixed(3) : '' } : x));
                })}
                className="cursor-pointer rounded"
                style={{ padding: '6px 12px', fontSize: 11, border: '1px solid #D5D9DE', color: '#6B7280', background: 'transparent' }}>
                Pay Full
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#6B7280' }} data-consignment-sale-paid>
                Paid <Bhd v={paid}/> of <Bhd v={total}/> BHD{paid > 0.0005 && paid < total - 0.0005 ? ' — the rest stays open on the invoice' : ''}
              </span>
            </div>
          </div>

          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES (OPTIONAL)</span>
            <textarea placeholder="Reference, payment terms, …" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full"
              style={{ background: 'transparent', border: '1px solid #D5D9DE', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0F0F10', resize: 'vertical', minHeight: 50 }} />
          </div>
          <div style={{ padding: '10px 12px', borderRadius: 6, background: '#F2F7FA', border: '1px solid #E5E9EE', fontSize: 11, color: '#6B7280', lineHeight: 1.4 }}>
            On save: <strong>one invoice</strong> for the buyer · <strong>one purchase per item</strong> for its consignor (as supplier) — each consignor is paid through his own purchase.
          </div>
          <WriteError text={error || w.fehler} />
          <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={handleConfirm} data-consignment-sale
              disabled={w.busy || items.length === 0 || !buyerId || buyerIsConsignor || rows.some((r) => !(r.price > 0) || (r.needsAck && !acks[r.c.id]))}
            >{single ? 'Confirm Sale' : `Confirm Sale (${rows.length} items · ${total.toFixed(3)} BHD)`}</Button>
          </div>
        </div>
      </Modal>

      <QuickCustomerModal
        open={showQuickBuyer}
        onClose={() => setShowQuickBuyer(false)}
        onCreated={(id) => { loadCustomers(); setBuyerId(id); }}
      />

      <NumberTypeDialog
        open={numberDialogOpen}
        variant="sales"
        onCancel={() => setNumberDialogOpen(false)}
        onConfirm={(special) => { void executeSale(special); }}
      />
    </>
  );
}

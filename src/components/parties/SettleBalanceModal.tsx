// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT C — „Settle Balance" im Kundenkonto: links die offenen Rechnungen (älteste zuerst), rechts was LATAIF
// dem Kunden schuldet (1. Store Credit, 2. We Borrowed; je älteste zuerst), je mit Häkchen. Der Vorschlag rechnet bei
// jedem Häkchen sofort neu (dieselbe Funktion wie das Haus: `planSettlement`). Darunter „What will happen": jede
// Zuordnung, vorher/nachher je Beleg, was voll bezahlt wird, was offen bleibt, Summe, Nettosaldo (unverändert).
// Ein Klick „Confirm settlement" — werden Rechnungen voll bezahlt, zuerst die Endnummer je Rechnung (Normal/Special).
// Gebucht wird alles in EINER Transaktion unter einer STL-Nummer (Primary lokal, PC2 über `customers.settle_balance`).
// Hat sich der Stand inzwischen geändert, bucht der Primary nichts; das Fenster liest neu und schlägt neu vor.
// B2/B3 Nachbesserung (Owner 10.11.2026): jede Zeile hat „Change amount" — voll oder teilweise, 0 bis zur Obergrenze der Zeile
// (kleinerer Rest von Rechnung und Gegenposten nach den früheren Zeilen), BHD mit drei Nachkommastellen. Was dadurch offen
// bleibt, geht der Reihe nach (FIFO) an den nächsten gewählten Posten; alle Reste rechnen bei jeder gültigen Eingabe neu.
// Das Haus rechnet mit derselben Funktion und prüft jede Obergrenze erneut (SETTLE_AMOUNT_TOO_HIGH / _INVALID).
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import {
  SETTLE_SOURCE_LABEL, SETTLE_SOURCE_ORDER, finalizingInvoices, planSettlementRows, settlePairKey, type SettleBalanceRead,
} from '@/core/offsets/party-settlement-reads';
import {
  settleBalanceBody, settleBalanceOnPrimary, type SettleBalanceRequest, type SettlementBooked,
} from '@/core/offsets/party-settlement';

const INK = '#0F0F10';
const GREY = '#6B7280';
const LINE = '#E5E9EE';
const GREEN = '#15803D';
const F = (n: number): number => Math.round(n * 1000);
const fmt = (f: number): string => (f / 1000).toFixed(3);
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fmtDate = (d: string): string => {
  const [y, m, dd] = (d || '').split('-');
  return y && m && dd ? `${dd}.${m}.${y}` : d || '—';
};

export interface NotOfferedItem { key: string; number: string; label: string; open: number; why: string }

export function SettleBalanceModal({ customerName, data, focus, totals, notOffered, notice, onClose, onDone, onStale }: {
  customerName: string;
  /** B2/B3 — Einstieg von der Rechnung (nur sie vorgewählt) bzw. vom Einkauf (nur er vorgewählt); ohne: alles (Kundenkonto). */
  focus?: { invoiceId?: string; sourceId?: string };
  /** Ein Hinweis von außen (z. B. „der Stand hat sich geändert, neu vorgeschlagen"). */
  notice?: string | null;
  data: SettleBalanceRead;
  /** Die Kontozahlen vorher (Kundenkonto): er schuldet uns, wir schulden ihm, Netto. */
  totals: { owesUs: number; weOwe: number; net: number };
  notOffered: NotOfferedItem[];
  onClose: () => void;
  onDone: (b: SettlementBooked) => void;
  /** Der Stand hat sich geändert — das Konto neu lesen (der Vorschlag wird neu gerechnet). */
  onStale: () => void;
}) {
  const w = useSharedWrites();
  const [invSel, setInvSel] = useState<Set<string>>(() => new Set(focus?.invoiceId ? data.invoices.filter((i) => i.id === focus.invoiceId).map((i) => i.id) : data.invoices.map((i) => i.id)));
  const [srcSel, setSrcSel] = useState<Set<string>>(() => new Set(focus?.sourceId ? data.sources.filter((s) => s.id === focus.sourceId).map((s) => s.id) : data.sources.map((s) => s.id)));
  const [date, setDate] = useState(today());
  const [step, setStep] = useState<'select' | 'numbers'>('select');
  const [choice, setChoice] = useState<Record<string, 'normal' | 'special'>>({});
  const [msg, setMsg] = useState<string | null>(null);
  // B2/B3 Nachbesserung — „Change amount": je Zuordnung ein von Hand gesetzter Betrag (Fils); die Zeile im Bearbeiten.
  const [hand, setHand] = useState<Record<string, number>>({});
  const [edit, setEdit] = useState<{ key: string; text: string } | null>(null);

  const rows = useMemo(
    () => planSettlementRows(data.invoices, data.sources, { invoiceIds: [...invSel], sourceIds: [...srcSel], amounts: hand }),
    [data, invSel, srcSel, hand],
  );
  const pairs = useMemo(() => rows.filter((r) => r.amountF > 0), [rows]);
  /** Eingabe prüfen: BHD mit höchstens drei Nachkommastellen, 0 bis zur Obergrenze der Zeile. */
  const pruefe = (text: string, maxF: number): { f: number } | { fehler: string } => {
    const t = text.trim();
    if (!/^\d+(\.\d{0,3})?$/.test(t)) return { fehler: 'Enter an amount in BHD (up to 3 decimals).' };
    const f = Math.round(Number(t) * 1000);
    if (f > maxF) return { fehler: `At most ${fmt(maxF)} here (open rest of the invoice or of the counter item).` };
    return { f };
  };
  const editRow = edit ? rows.find((r) => settlePairKey(r.sourceId, r.invoiceId) === edit.key) : undefined;
  const editCheck = edit && editRow ? pruefe(edit.text, editRow.maxF) : null;
  const editBad = !!editCheck && 'fehler' in editCheck;
  function tippe(key: string, text: string, maxF: number): void {
    setEdit({ key, text });
    const c = pruefe(text, maxF);
    // Sofort neu rechnen, sobald die Eingabe gültig ist — Vorschau und alle Reste folgen.
    if ('f' in c) setHand((h) => (h[key] === c.f ? h : { ...h, [key]: c.f }));
  }
  function zuruecksetzen(key: string): void {
    setHand((h) => { const n = { ...h }; delete n[key]; return n; });
    setEdit(null);
  }
  const totalF = pairs.reduce((s, p) => s + p.amountF, 0);
  const usedInv = (id: string): number => pairs.filter((p) => p.invoiceId === id).reduce((s, p) => s + p.amountF, 0);
  const usedSrc = (id: string): number => pairs.filter((p) => p.sourceId === id).reduce((s, p) => s + p.amountF, 0);
  const finalizing = useMemo(() => finalizingInvoices(data.invoices, pairs), [data, pairs]);
  const needChoice = finalizing.filter((i) => !i.finalized);
  const partlyOpen = data.invoices.filter((i) => usedInv(i.id) > 0 && !finalizing.some((f) => f.id === i.id));
  const sourcesLeft = data.sources.filter((s) => usedSrc(s.id) > 0 && F(s.open) - usedSrc(s.id) > 5);
  const toggle = (set: Set<string>, id: string, apply: (s: Set<string>) => void): void => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    apply(n);
  };
  const invNo = (id: string): string => data.invoices.find((i) => i.id === id)?.number ?? id;
  const src = (id: string) => data.sources.find((s) => s.id === id);

  async function buchen(): Promise<void> {
    setMsg(null);
    const req: SettleBalanceRequest = {
      customerId: data.customerId, invoiceIds: [...invSel], sourceIds: [...srcSel], settlementDate: date,
      expectedStamp: data.stamp, expectedTotal: totalF / 1000,
      ...(needChoice.length > 0 ? { finalNumbers: Object.fromEntries(needChoice.map((i) => [i.id, choice[i.id] ?? 'normal'])) } : {}),
    };
    // Nur die von Hand gesetzten Beträge der Zeilen, die dieser Vorschlag zeigt (das Haus prüft jede Obergrenze erneut).
    const geaendert = rows.filter((r) => r.edited).map((r) => ({ invoiceId: r.invoiceId, sourceId: r.sourceId, amount: r.amountF / 1000 }));
    if (geaendert.length > 0) req.amounts = geaendert;
    const out = await w.save<SettlementBooked>('customers.settle_balance', {
      local: () => settleBalanceOnPrimary(req),
      remote: () => settleBalanceBody(req),
    });
    if (out.kind !== 'ok') {
      // Ein Nein zu einem von Hand gesetzten Betrag (SETTLE_AMOUNT_*) kommt erst NACH dem Stand-Abgleich: es bleibt hier stehen.
      if ('code' in out && (out.code === 'OPEN_ITEMS_CHANGED' || out.code === 'SETTLE_TOTAL_CHANGED' || out.code === 'SETTLE_SELECTION_INVALID')) {
        setStep('select');
        onStale();
        return;
      }
      setMsg(fehlertext(out));
      setStep('select');
      return;
    }
    onDone(out.value);
  }

  function bestaetigen(): void {
    if (pairs.length === 0 || editBad) return;
    setEdit(null);
    if (needChoice.length > 0) {
      setChoice((c) => Object.fromEntries(needChoice.map((i) => [i.id, c[i.id] ?? 'normal'])));
      setStep('numbers');
      return;
    }
    void buchen();
  }

  const zelle: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${LINE}`, fontSize: 12, verticalAlign: 'top' };
  const zahl: React.CSSProperties = { ...zelle, textAlign: 'right', fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' };
  const ueber: React.CSSProperties = { fontSize: 11, color: GREY, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 6px' };

  if (step === 'numbers') {
    return (
      <Modal open onClose={() => setStep('select')} title="Final invoice numbers" width={520}>
        <div data-settle-numbers style={{ display: 'grid', gap: 10, fontSize: 13 }}>
          <p style={{ color: GREY, margin: 0 }}>These invoices will be fully paid by this settlement. Choose the number type for each — it is set once and never changes.</p>
          {needChoice.map((i) => (
            <div key={i.id} data-settle-number-for={i.number} className="flex items-center justify-between" style={{ gap: 10, borderBottom: `1px solid ${LINE}`, paddingBottom: 8 }}>
              <span><b>{i.number}</b> <span style={{ color: GREY }}>· <Bhd v={i.total} /> BHD</span></span>
              <span className="flex" style={{ gap: 6 }}>
                {(['normal', 'special'] as const).map((k) => (
                  <button key={k} type="button" data-settle-number-choice={k} onClick={() => setChoice((c) => ({ ...c, [i.id]: k }))}
                    style={{ padding: '4px 10px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                      border: `1px solid ${(choice[i.id] ?? 'normal') === k ? INK : LINE}`, background: (choice[i.id] ?? 'normal') === k ? INK : '#FFF',
                      color: (choice[i.id] ?? 'normal') === k ? '#FFF' : INK }}>
                    {k === 'normal' ? 'Normal Final' : 'Special Final'}
                  </button>
                ))}
              </span>
            </div>
          ))}
          {(msg || w.fehler) && <div style={{ color: '#B91C1C', fontSize: 12 }} data-settle-error>{msg || w.fehler}</div>}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={() => setStep('select')}>Back</Button>
            <Button variant="primary" onClick={() => { void buchen(); }} disabled={w.busy} data-settle-numbers-confirm>Confirm settlement</Button>
          </div>
        </div>
      </Modal>
    );
  }

  const quellen = SETTLE_SOURCE_ORDER.flatMap((k) => data.sources.filter((s) => s.kind === k));
  return (
    <Modal open onClose={onClose} title={`Settle Balance — ${customerName}`} width={980}>
      <div data-settle-balance style={{ display: 'grid', gap: 14, fontSize: 13 }}>
        <p style={{ color: GREY, margin: 0 }}>
          The app proposes what to offset. Untick what should stay out, or use “Change amount” on a line to offset less (full or
          partial) — the proposal and every remaining amount are calculated again at once. No money moves: cash, bank, Benefit and
          card stay as they are.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
          <div>
            <p style={ueber}>{customerName} owes us — oldest first</p>
            {data.invoices.length === 0 && <p style={{ color: GREY }}>No open invoice.</p>}
            {data.invoices.map((i) => {
              const on = invSel.has(i.id);
              const used = usedInv(i.id);
              const after = F(i.open) - used;
              return (
                <label key={i.id} data-settle-invoice={i.number} data-settle-invoice-kind={i.kind ?? 'INVOICE'} data-settle-on={on ? '1' : '0'} className="flex cursor-pointer"
                  style={{ gap: 8, padding: '7px 8px', borderBottom: `1px solid ${LINE}`, background: on ? '#FAFBFC' : '#FFF', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(invSel, i.id, setInvSel)} style={{ marginTop: 3 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{i.number}</b>{' '}
                    {/* v0.8.101 S5 — eine GEBUCHTE Forderung an den verknüpften Partner (z. B. Rückforderung nach Abrechnung), keine Rechnung. */}
                    {i.kind === 'PARTNER_ITEM' && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, marginRight: 4, background: 'rgba(220,38,38,0.08)', color: '#B91C1C' }}>
                        Partner owes{i.partnerName ? ` · ${i.partnerName}` : ''}
                      </span>
                    )}
                    <span style={{ color: GREY }}>· {fmtDate(i.date)}</span>
                    <div style={{ fontSize: 11, color: GREY }}>
                      {i.kind === 'PARTNER_ITEM'
                        ? <>{i.productLabel ? `${i.productLabel} · ` : ''}booked partner receivable · open <Bhd v={i.open} /> · only against We Borrowed or open purchases</>
                        : <>total <Bhd v={i.total} /> · paid <Bhd v={i.paid} /> · open <Bhd v={i.open} /></>}
                    </div>
                    <div style={{ fontSize: 11, color: on && used > 0 ? (after <= 5 ? GREEN : INK) : GREY }}>
                      {!on ? 'excluded' : used === 0 ? 'nothing left to offset' : after <= 5 ? '→ fully paid' : `→ ${fmt(after)} stays open`}
                    </div>
                  </span>
                  <span className="font-mono" style={{ whiteSpace: 'nowrap' }}><Bhd v={i.open} /></span>
                </label>
              );
            })}
          </div>
          <div>
            <p style={ueber}>We owe {customerName} — in this order</p>
            {data.sources.length === 0 && <p style={{ color: GREY }}>Nothing open that can be offset.</p>}
            {quellen.map((s, idx) => {
              const kopf = idx === 0 || quellen[idx - 1].kind !== s.kind ? (
                <div style={{ fontSize: 11, fontWeight: 600, color: INK, margin: '8px 0 2px' }}>
                  {SETTLE_SOURCE_ORDER.indexOf(s.kind) + 1}. {SETTLE_SOURCE_LABEL[s.kind]}
                </div>
              ) : null;
              const on = srcSel.has(s.id);
              const used = usedSrc(s.id);
              return (
                <div key={s.id}>
                  {kopf}
                  <label data-settle-source={s.number} data-settle-source-kind={s.kind} data-settle-on={on ? '1' : '0'} className="flex cursor-pointer"
                    {...(s.kind === 'PURCHASE' ? { 'data-settle-source-purchase': s.consignment ? 'consignment' : 'normal' } : {})}
                    {...(s.kind === 'PARTNER_ITEM' ? { 'data-settle-source-partner': s.partnerId ?? '' } : {})}
                    style={{ gap: 8, padding: '7px 8px', borderBottom: `1px solid ${LINE}`, background: on ? '#FAFBFC' : '#FFF', alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={on} onChange={() => toggle(srcSel, s.id, setSrcSel)} style={{ marginTop: 3 }} />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <b>{s.number}</b>{' '}
                      {s.kind === 'PURCHASE' && (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, marginRight: 4,
                          background: s.consignment ? 'rgba(124,58,237,0.10)' : 'rgba(15,15,16,0.06)', color: s.consignment ? '#6D28D9' : INK }}>
                          {s.consignment ? 'Consignment purchase' : 'Purchase'}
                        </span>
                      )}
                      {/* v0.8.101 S4 — LATAIF schuldet dem verknüpften Partner diesen Betrag an diesem Artikel (auszahlbar, keine Sperre). */}
                      {s.kind === 'PARTNER_ITEM' && (
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, marginRight: 4, background: 'rgba(170,149,110,0.16)', color: '#7A6A45' }}>
                          Partner balance{s.partnerName ? ` · ${s.partnerName}` : ''}
                        </span>
                      )}
                      <span style={{ color: GREY }}>· {s.kind === 'PURCHASE' ? `total ${fmt(F(s.total))}` : s.label} · {fmtDate(s.date)}</span>
                      <div style={{ fontSize: 11, color: GREY }}>
                        {!on ? 'excluded' : used === 0 ? 'not needed' : `uses ${fmt(used)} → open after ${fmt(F(s.open) - used)}`}
                        {on && used > 0 && s.kind === 'PURCHASE' && (F(s.open) - used <= 5 ? ' · purchase → Paid' : ' · purchase → Partially paid')}
                        {on && used > 0 && s.kind === 'PARTNER_ITEM' && ' · counts as paid out to the partner — no cash'}
                      </div>
                    </span>
                    <span className="font-mono" style={{ whiteSpace: 'nowrap' }}><Bhd v={s.open} /></span>
                  </label>
                </div>
              );
            })}
            {notOffered.length > 0 && (
              <div style={{ fontSize: 11, color: GREY, marginTop: 10 }} data-settle-not-offered={notOffered.length}>
                Not offered here:
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {notOffered.map((n) => <li key={n.key}>{n.label} {n.number} (<Bhd v={n.open} />) — {n.why}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>

        <label className="flex items-center" style={{ gap: 8 }}>
          <span style={{ fontSize: 12, color: GREY }}>Settlement date</span>
          <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} data-settle-date
            style={{ padding: '4px 8px', border: `1px solid ${LINE}`, borderRadius: 6, fontSize: 12 }} />
        </label>

        <div>
          <p style={ueber}>What will happen</p>
          {rows.length === 0 ? (
            <p style={{ color: '#B91C1C' }} data-settle-nothing>Nothing to offset with this selection.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }} data-settle-pairs={pairs.length}>
              <thead><tr>
                <th style={{ ...zelle, textAlign: 'left', color: GREY }}>We owe</th><th style={zelle} />
                <th style={{ ...zelle, textAlign: 'left', color: GREY }}>Invoice</th>
                <th style={{ ...zahl, color: GREY }}>Invoice open before → after</th>
                <th style={{ ...zahl, color: GREY }}>Counter item open before → after</th>
                <th style={{ ...zahl, color: GREY }}>Amount</th>
              </tr></thead>
              <tbody>
                {(() => {
                  const offenNach = new Map(data.invoices.map((i) => [i.id, F(i.open)]));
                  const quelleNach = new Map(data.sources.map((q) => [q.id, F(q.open)]));
                  return rows.map((p) => {
                    const s = src(p.sourceId);
                    const key = settlePairKey(p.sourceId, p.invoiceId);
                    const vor = offenNach.get(p.invoiceId) ?? 0;
                    offenNach.set(p.invoiceId, vor - p.amountF);
                    const qVor = quelleNach.get(p.sourceId) ?? 0;
                    quelleNach.set(p.sourceId, qVor - p.amountF);
                    const offen = edit?.key === key;
                    const fehler = offen && editCheck && 'fehler' in editCheck ? editCheck.fehler : null;
                    return (
                      <tr key={key} data-settle-pair={`${s?.number}>${invNo(p.invoiceId)}`} data-settle-pair-amount={fmt(p.amountF)}
                        data-settle-pair-max={fmt(p.maxF)} data-settle-pair-edited={p.edited ? '1' : '0'} style={{ opacity: p.amountF > 0 ? 1 : 0.6 }}>
                        <td style={zelle}><b>{s?.number}</b> <span style={{ color: GREY }}>· {s ? (s.kind === 'PURCHASE' ? (s.consignment ? 'consignment purchase' : 'purchase') : SETTLE_SOURCE_LABEL[s.kind]) : ''}</span></td>
                        <td style={zelle}>→</td>
                        <td style={zelle}><b>{invNo(p.invoiceId)}</b></td>
                        <td style={zahl}>{fmt(vor)} → {fmt(vor - p.amountF)}</td>
                        <td style={zahl}>{fmt(qVor)} → {fmt(qVor - p.amountF)}</td>
                        <td style={zahl}>
                          {offen ? (
                            <div style={{ display: 'grid', gap: 4, justifyItems: 'end' }}>
                              <input autoFocus inputMode="decimal" value={edit.text} data-settle-amount-input
                                onChange={(e) => tippe(key, e.target.value, p.maxF)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && !fehler) setEdit(null); if (e.key === 'Escape') setEdit(null); }}
                                style={{ width: 110, textAlign: 'right', padding: '3px 6px', fontFamily: 'inherit', fontSize: 12,
                                  border: `1px solid ${fehler ? '#B91C1C' : LINE}`, borderRadius: 6 }} />
                              <span style={{ fontSize: 10, color: GREY }}>max {fmt(p.maxF)} BHD</span>
                              {fehler && <span style={{ fontSize: 10, color: '#B91C1C', whiteSpace: 'normal', maxWidth: 220 }} data-settle-amount-error>{fehler}</span>}
                              <span className="flex" style={{ gap: 6 }}>
                                <button type="button" data-settle-amount-done disabled={!!fehler} onClick={() => setEdit(null)}
                                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: `1px solid ${INK}`, background: INK, color: '#FFF', cursor: fehler ? 'not-allowed' : 'pointer', opacity: fehler ? 0.5 : 1 }}>Done</button>
                                {p.edited && <button type="button" data-settle-amount-reset onClick={() => zuruecksetzen(key)}
                                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: `1px solid ${LINE}`, background: '#FFF', cursor: 'pointer' }}>Reset</button>}
                              </span>
                            </div>
                          ) : (
                            <div style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                              <span>{fmt(p.amountF)}{p.edited && <span style={{ color: GREY, fontSize: 10 }}> · changed</span>}</span>
                              <span className="flex" style={{ gap: 6 }}>
                                <button type="button" data-settle-amount-edit onClick={() => setEdit({ key, text: fmt(p.amountF) })} disabled={w.busy || editBad}
                                  style={{ fontSize: 11, padding: 0, border: 'none', background: 'none', color: '#1D4ED8', cursor: 'pointer', textDecoration: 'underline' }}>Change amount</button>
                                {p.edited && <button type="button" data-settle-amount-reset onClick={() => zuruecksetzen(key)}
                                  style={{ fontSize: 11, padding: 0, border: 'none', background: 'none', color: GREY, cursor: 'pointer', textDecoration: 'underline' }}>Reset</button>}
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  });
                })()}
              </tbody>
            </table>
          )}
          {rows.length > 0 && pairs.length === 0 && <p style={{ color: '#B91C1C', margin: '6px 0 0' }} data-settle-nothing>Every amount is 0 — nothing to offset.</p>}
        </div>

        {pairs.length > 0 && (
          <div style={{ background: '#F7F9FB', border: `1px solid ${LINE}`, borderRadius: 10, padding: '10px 14px', display: 'grid', gap: 4, fontSize: 12 }} data-settle-summary>
            <div className="flex justify-between"><span>Total offset (no cash)</span><b className="font-mono" data-settle-total={fmt(totalF)}>{fmt(totalF)} BHD</b></div>
            <div className="flex justify-between"><span>{customerName} owes us</span><span className="font-mono">{fmt(F(totals.owesUs))} → <b>{fmt(F(totals.owesUs) - totalF)}</b></span></div>
            <div className="flex justify-between"><span>We owe {customerName}</span><span className="font-mono">{fmt(F(totals.weOwe))} → <b>{fmt(F(totals.weOwe) - totalF)}</b></span></div>
            <div className="flex justify-between"><span>Net balance</span><span className="font-mono">{fmt(Math.abs(F(totals.net)))} → {fmt(Math.abs(F(totals.net)))} — unchanged</span></div>
            {finalizing.length > 0 && <div data-settle-paid-full>Fully paid: {finalizing.map((i) => i.number).join(', ')}</div>}
            {partlyOpen.length > 0 && <div>Stay partly open: {partlyOpen.map((i) => `${i.number} (${fmt(F(i.open) - usedInv(i.id))})`).join(', ')}</div>}
            {sourcesLeft.length > 0 && <div>Remain with us: {sourcesLeft.map((s) => `${s.number} (${fmt(F(s.open) - usedSrc(s.id))})`).join(', ')}</div>}
          </div>
        )}
        <p style={{ fontSize: 11, color: GREY, margin: 0 }}>
          All lines are booked together under one settlement number (STL-…). If anything changed in the meantime, nothing is booked and
          the proposal is shown again. Each invoice shows the settlement number, the counter document, the amount, the date and “Offset – no cash”.
        </p>
        {notice && !msg && <div style={{ color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px', fontSize: 12 }} data-settle-notice>{notice}</div>}
        {(msg || w.fehler) && <div style={{ color: '#B91C1C', fontSize: 12 }} data-settle-error>{msg || w.fehler}</div>}
        <div className="flex justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={bestaetigen} disabled={w.busy || pairs.length === 0 || editBad} data-settle-confirm>
            Confirm settlement · {pairs.length} offset{pairs.length === 1 ? '' : 's'} · {fmt(totalF)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

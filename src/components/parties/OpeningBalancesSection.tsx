// ════════════════════════════════════════════════════════════════════════════
// OPENING BALANCES S1 — der Bereich „Opening balances" in Edit Client / Supplier Edit (Owner) und seine Zusammenfassung
// in der Ansicht. Eigener Beleg mit eigener Bestätigung: das „Save" der Kontaktdaten schreibt hier nie etwas.
//
// Am Primary und am PC2 dieselbe Fläche: die Auskunft `parties.account.get` (Posten, Vorschau, offene LATAIF-Belege) und
// die Buchungen `opening_balances.create` / `.cancel` rechnet der Primary. Gebucht wird nichts — jeder Posten steht auf
// „accounting pending", bis der Buchhalter Gegenkonto, Datum und VAT bestätigt.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { OP_PARTIES_ACCOUNT_GET, partyAccountReadFor, type PartyAccountRead } from '@/core/parties/party-account';
import {
  KINDS_OF, KIND_LABEL, OPENING_CUTOFF_DATE, PRIOR_VAT_STATES, cancelOpeningItemOnPrimary, recordOpeningItemOnPrimary,
  type OpeningItem, type OpeningKind, type OpeningPartyType, type OpeningScope, type PriorVat, type ProposedLine,
} from '@/core/parties/opening-balances';

const PRIOR_VAT_LABEL: Record<PriorVat, string> = {
  DECLARED_BEFORE: 'VAT already declared in the old records',
  OUTSIDE_VAT: 'No VAT on this (outside VAT / exempt)',
  UNKNOWN: 'Unknown — accountant to check',
};
const fmt = (v: number): string => v.toFixed(3);
const lineText = (lines: readonly ProposedLine[], partyName: string): string =>
  lines.map((l) => `${l.side === 'DEBIT' ? 'Dr' : 'Cr'} ${l.account}${l.counterparty ? ` (${partyName})` : ''}`).join(' / ');

export interface OpeningBalancesSectionProps {
  partyType: OpeningPartyType;
  partyId: string;
  /** `edit`: Erfassen und Stornieren (nur Owner); `summary`: nur lesen, nur wenn es Posten gibt. */
  mode: 'edit' | 'summary';
  canRecord: boolean;
  /** Die Maske meldet, ob eine Eingabe noch nicht erfasst ist (Schutz vor „Save" der Kontaktdaten). */
  onDirtyChange?: (dirty: boolean) => void;
}

export function OpeningBalancesSection({ partyType, partyId, mode, canRecord, onDirtyChange }: OpeningBalancesSectionProps) {
  const navigate = useNavigate();
  const w = useSharedWrites();
  const kinds = KINDS_OF[partyType];
  const [refresh, setRefresh] = useState(0);
  const [kind, setKind] = useState<OpeningKind>(kinds[0]);
  const [scope, setScope] = useState<OpeningScope>('DOCUMENT');
  const [reference, setReference] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [priorVat, setPriorVat] = useState<PriorVat>('UNKNOWN');
  const [note, setNote] = useState('');
  const [notInLataif, setNotInLataif] = useState(false);
  const [noOverlap, setNoOverlap] = useState(false);
  const [actionId, setActionId] = useState(() => uuid());
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [storno, setStorno] = useState<{ id: string; number: string } | null>(null);
  const [stornoReason, setStornoReason] = useState('');

  const amountNum = Number(amount.replace(',', '.'));
  const hasInput = amount.trim() !== '' || reference.trim() !== '';
  useEffect(() => { onDirtyChange?.(mode === 'edit' && hasInput); }, [hasInput, mode, onDirtyChange]);

  const preview = mode === 'edit' && canRecord && amount.trim() !== '' && Number.isFinite(amountNum)
    ? { kind, scope, reference, documentDate, dueDate, amount: amountNum, priorVat, note }
    : undefined;
  const params = { partyType, partyId, ...(preview ? { preview } : {}), v: refresh };
  const data = useSharedRead<PartyAccountRead | null>(
    OP_PARTIES_ACCOUNT_GET, params,
    (ctx) => partyAccountReadFor(ctx, { partyType, partyId, preview }),
    null,
    [partyType, partyId, refresh, JSON.stringify(preview ?? null)],
  );
  const items = useMemo(() => data?.items ?? [], [data]);
  const live = items.filter((i) => i.status === 'RECORDED');
  const plan = data?.preview?.plan ?? null;
  const partyName = data?.party.name ?? '';

  function reset(): void {
    setReference(''); setDocumentDate(''); setDueDate(''); setAmount(''); setNote(''); setPriorVat('UNKNOWN');
    setNotInLataif(false); setNoOverlap(false); setActionId(uuid());
  }
  const reload = (): void => setRefresh((r) => r + 1);

  async function record(): Promise<void> {
    if (!plan) return;
    const text = `Record ${KIND_LABEL[plan.kind].toLowerCase()} for ${plan.party.name}: ${fmt(plan.amount)} BHD`
      + `${plan.reference ? ` (${plan.reference})` : ' (summarised remainder)'} as of ${OPENING_CUTOFF_DATE}?\n\n`
      + 'This creates an opening document only: no invoice, no purchase, no revenue, no VAT and no cash movement. '
      + 'It is not booked and not payable until the accountant confirms the opening rules.';
    if (!(await window.confirm(text))) return;
    const input = {
      actionId, partyType, partyId, kind: plan.kind, scope: plan.scope,
      ...(plan.reference ? { reference: plan.reference } : {}),
      ...(plan.documentDate ? { documentDate: plan.documentDate } : {}),
      ...(plan.dueDate ? { dueDate: plan.dueDate } : {}),
      amount: plan.amount, priorVat: plan.priorVat, ...(plan.note ? { note: plan.note } : {}),
      confirmNotInLataif: notInLataif, ...(plan.needsOverlapConfirm ? { confirmNoOverlap: noOverlap } : {}),
    };
    const out = await w.save<OpeningItem>('opening_balances.create', {
      local: () => recordOpeningItemOnPrimary(input, reload),
      remote: () => input,
    });
    if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
    setMsg({ text: `${out.value.itemNumber} recorded — ${fmt(out.value.amount)} BHD, accounting pending.`, ok: true });
    reset();
    reload();
  }

  async function cancel(): Promise<void> {
    if (!storno || !stornoReason.trim()) return;
    if (!(await window.confirm(`Cancel ${storno.number}? It was not booked, so nothing is reversed in the ledger.`))) return;
    const input = { itemId: storno.id, reason: stornoReason.trim() };
    const out = await w.save<OpeningItem>('opening_balances.cancel', {
      local: () => cancelOpeningItemOnPrimary(input, reload),
      remote: () => input,
    });
    if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
    setStorno(null);
    setMsg({ text: `${out.value.itemNumber} cancelled.`, ok: true });
    reload();
  }

  if (mode === 'summary') {
    if (live.length === 0) return null;
    return (
      <div data-opening-summary><Card style={{ marginTop: 16 }}>
        <div className="flex justify-between items-center">
          <span style={{ fontSize: 13, fontWeight: 600, color: '#0F0F10' }}>Opening balances · {OPENING_CUTOFF_DATE}</span>
          <span style={{ fontSize: 11, color: '#9A6B00' }}>Recorded, not booked yet — not part of the balances above</span>
        </div>
        {data?.totals.filter((t) => t.count > 0).map((t) => (
          <div key={t.kind} className="flex justify-between" style={{ fontSize: 12, padding: '6px 0', borderTop: '1px solid #F1F3F5' }} data-opening-total={t.kind}>
            <span>{t.label} · {t.count} position{t.count === 1 ? '' : 's'}</span>
            <span className="font-mono">{fmt(t.amount)} BHD</span>
          </div>
        ))}
      </Card></div>
    );
  }

  return (
    <div data-opening-section><Card style={{ marginTop: 16 }}>
      <div className="flex justify-between items-center">
        <span style={{ fontSize: 14, fontWeight: 600, color: '#0F0F10' }}>Opening balances · as of {OPENING_CUTOFF_DATE}</span>
        <button onClick={() => navigate('/opening-balances')} style={{ background: 'none', border: 'none', fontSize: 12, color: '#3D7FFF', cursor: 'pointer' }}>All opening balances →</button>
      </div>
      <p style={{ fontSize: 12, color: '#6B7280', marginTop: 6 }}>
        Old balances from before {OPENING_CUTOFF_DATE}, recorded as separate documents. This is not part of “Save” above.
        {' '}<b>Not booked and not payable yet</b> — the accountant confirms the counter account, the booking date and the VAT treatment first.
      </p>
      {data === null && <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 8 }} data-opening-unavailable>Opening balances are not available right now.</p>}

      {data && data.lataifOpen.length > 0 && (
        <div data-opening-lataif-open style={{ marginTop: 10, padding: '8px 12px', borderRadius: 8, background: 'rgba(61,127,255,0.06)', fontSize: 12, color: '#1F3B73' }}>
          Already open in LATAIF: {data.lataifOpen.length} document{data.lataifOpen.length === 1 ? '' : 's'}, {fmt(data.lataifOpenTotal)} BHD
          {' '}({data.lataifOpen.slice(0, 5).map((d) => `${d.number} ${fmt(d.open)}`).join(', ')}{data.lataifOpen.length > 5 ? ', …' : ''}).
          {' '}Do not record these again — they are paid where they are.
        </div>
      )}

      {data && data.totals.map((t) => (
        <div key={t.kind} style={{ fontSize: 12, padding: '6px 0', borderTop: '1px solid #F1F3F5', marginTop: 6 }} data-opening-total={t.kind}>
          <div className="flex justify-between"><span>{t.label}</span><span className="font-mono">{t.count > 0 ? `${fmt(t.amount)} BHD · ${t.count}` : '—'}</span></div>
          <div style={{ fontSize: 11, color: '#9CA3AF' }}>Proposed booking (not booked): {lineText(t.proposed, partyName)}</div>
        </div>
      ))}

      {items.map((i) => (
        <div key={i.id} data-opening-item={i.itemNumber} className="flex justify-between items-center"
          style={{ padding: '8px 0', borderTop: '1px solid #F1F3F5', fontSize: 12, opacity: i.status === 'CANCELLED' ? 0.55 : 1 }}>
          <span>
            <b className="font-mono">{i.itemNumber}</b> · {KIND_LABEL[i.kind]} · {i.scope === 'DOCUMENT' ? `old invoice ${i.reference ?? ''}` : `remainder${i.reference ? ` (${i.reference})` : ''}`}
            {i.documentDate ? ` · ${i.documentDate}` : ''}{i.dueDate ? ` · due ${i.dueDate}` : ''} · <span className="font-mono">{fmt(i.amount)} BHD</span>
            {' · '}{i.status === 'CANCELLED' ? `cancelled (${i.cancelReason ?? ''})` : 'accounting pending'}
          </span>
          {canRecord && i.status === 'RECORDED' && (
            <Button variant="ghost" disabled={w.busy} onClick={() => { w.clear(); setStornoReason(''); setStorno({ id: i.id, number: i.itemNumber }); }} data-opening-cancel>Cancel</Button>
          )}
        </div>
      ))}

      {storno && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8, padding: 10, borderRadius: 8, background: '#FAFBFC' }} data-opening-cancel-dialog>
          <Input label={`Why is ${storno.number} cancelled? (required)`} value={stornoReason} onChange={(e) => setStornoReason(e.target.value)} data-opening-cancel-reason />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStorno(null)}>Keep</Button>
            <Button variant="danger" disabled={w.busy || !stornoReason.trim()} onClick={() => void cancel()} data-opening-cancel-submit>Cancel position</Button>
          </div>
        </div>
      )}

      {canRecord && (
        <div style={{ display: 'grid', gap: 10, marginTop: 14, paddingTop: 12, borderTop: '1px solid #E5E9EE' }} data-opening-form>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span className="text-overline">TYPE</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as OpeningKind)} data-opening-kind>
                {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
              <span className="text-overline">WHAT</span>
              <select value={scope} onChange={(e) => setScope(e.target.value as OpeningScope)} data-opening-scope>
                <option value="DOCUMENT">One old invoice / document</option>
                <option value="REMAINDER">Summarised remaining balance</option>
              </select>
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <Input label={scope === 'DOCUMENT' ? 'Old reference (required)' : 'Reference (optional)'} value={reference} onChange={(e) => setReference(e.target.value)} data-opening-reference />
            <Input label="Document date" type="date" max={OPENING_CUTOFF_DATE} value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} data-opening-date />
            <Input label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} data-opening-due />
            <Input label="Amount (BHD)" value={amount} onChange={(e) => setAmount(e.target.value)} data-opening-amount />
          </div>
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            <span className="text-overline">VAT IN THE OLD RECORDS</span>
            <select value={priorVat} onChange={(e) => setPriorVat(e.target.value as PriorVat)} data-opening-prior-vat>
              {PRIOR_VAT_STATES.map((s) => <option key={s} value={s}>{PRIOR_VAT_LABEL[s]}</option>)}
            </select>
          </label>
          <Input label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} data-opening-note />
          {amount.trim() !== '' && (plan ? (
            <div data-opening-preview style={{ padding: '10px 12px', borderRadius: 8, background: '#F5F7FA', fontSize: 12, color: '#374151' }}>
              {KIND_LABEL[plan.kind]}: {fmt(plan.amount)} BHD as of {OPENING_CUTOFF_DATE}. No invoice, no revenue, no VAT, no cash movement.
              {' '}Proposed booking after the accountant&apos;s approval: {lineText(data?.totals.find((t) => t.kind === plan.kind)?.proposed ?? [], plan.party.name)}.
            </div>
          ) : (
            <div data-opening-refused style={{ padding: '10px 12px', borderRadius: 8, background: 'rgba(170,110,110,0.10)', fontSize: 12, color: '#7A3535' }}>
              {data?.preview?.issue ?? 'Checking…'}
            </div>
          ))}
          <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <input type="checkbox" checked={notInLataif} onChange={(e) => setNotInLataif(e.target.checked)} data-opening-confirm-not-in-lataif />
            This amount is not already an invoice, purchase or payment in LATAIF.
          </label>
          {plan?.needsOverlapConfirm && (
            <label className="flex items-center gap-2" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={noOverlap} onChange={(e) => setNoOverlap(e.target.checked)} data-opening-confirm-no-overlap />
              The summarised remainder does not contain any of the single old invoices of this type.
            </label>
          )}
          {msg && (
            <div data-opening-msg style={{ padding: '8px 12px', borderRadius: 8, fontSize: 12,
              background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>{msg.text}</div>
          )}
          <div className="flex justify-end gap-2">
            {hasInput && <Button variant="ghost" onClick={() => { reset(); setMsg(null); }}>Clear</Button>}
            <Button variant="primary" disabled={w.busy || !plan || !notInLataif || (plan.needsOverlapConfirm && !noOverlap)} onClick={() => void record()} data-opening-submit>
              Record opening position…
            </Button>
          </div>
        </div>
      )}
    </Card></div>
  );
}

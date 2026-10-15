// ════════════════════════════════════════════════════════════════════════════
// B1 OPENING ACCOUNTING — „Settings → Opening Balances": Erfassung und Abstimmung der Eröffnungsbilanz zum 15.10.2026.
//
// Nur der Owner; am Primary und am PC2 dieselbe Fläche: die Auskunft `page.opening_accounting.get` (Übersicht,
// Saldenliste, Bilanzvorschau, Stichtagsliste, Vorschau einer Eingabe) und die Belege `opening_accounts.create` /
// `.cancel` rechnet der Primary. Gebucht wird NICHTS — jede Zahl hier ist entweder schon im Hauptbuch (gebucht) oder ein
// Entwurf (nicht gebucht); das Ergebnis ist immer PROVISIONAL. Kunden-/Lieferantenposten werden weiter in Customer/Supplier
// Edit erfasst, Altbestand über Collection.
// ════════════════════════════════════════════════════════════════════════════
import { useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { useSharedRead } from '@/core/data/shared-read';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { usePermission } from '@/hooks/usePermission';
import { OP_PAGE_OPENING_ACCOUNTING_GET } from '@/core/bridge/store-read-ops';
import {
  OPENING_ACCOUNT_KINDS, OPENING_ACCOUNT_KIND_INFO, OPENING_CUTOFF_DATE,
  cancelOpeningAccountItemOnPrimary, openingAccountingFor, recordOpeningAccountItemOnPrimary,
  type CounterpartyType, type OpeningAccountItem, type OpeningAccountKind, type OpeningAccountingRead, type OverviewRow,
} from '@/core/accounting/opening-accounting';

const b3 = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : n.toFixed(3));
const STATUS_COLOR: Record<string, string> = { RECONCILED: '#2F6B3A', BOOKED: '#374151', PROVISIONAL: '#8A5A00', MISSING: '#7A3535', NOT_VERIFIED: '#7A3535', EMPTY: '#9CA3AF' };
const box = { padding: '10px 14px', background: '#F5F7FA', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 13, color: '#374151' } as const;
const th = { textAlign: 'left' as const, padding: '6px 8px', fontSize: 11, color: '#6B7280', fontWeight: 600, borderBottom: '1px solid #E5E9EE' };
const td = { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid #F1F3F5', verticalAlign: 'top' as const };

export function OpeningAccountingPanel() {
  const perm = usePermission();
  const w = useSharedWrites();
  const sending = useRef(false);
  const [refresh, setRefresh] = useState(0);
  const [asOfDate, setAsOfDate] = useState(OPENING_CUTOFF_DATE);
  const [showTx, setShowTx] = useState(false);
  const [kind, setKind] = useState<OpeningAccountKind>('CASH_BALANCE');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [cpType, setCpType] = useState<CounterpartyType | ''>('');
  const [cpId, setCpId] = useState('');
  const [cpName, setCpName] = useState('');
  const [notInLataif, setNotInLataif] = useState(false);
  const [correcting, setCorrecting] = useState<{ id: string; number: string; revision: number } | null>(null);
  const [actionId, setActionId] = useState(() => uuid());
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [storno, setStorno] = useState<{ id: string; number: string; revision: number } | null>(null);
  const [stornoReason, setStornoReason] = useState('');

  const info = OPENING_ACCOUNT_KIND_INFO[kind];
  const amountNum = Number(amount.replace(',', '.'));
  const counterparty = info.counterparty === 'NONE' || cpType === '' ? {}
    : cpType === 'OTHER' ? { counterpartyType: cpType, counterpartyName: cpName }
    : { counterpartyType: cpType, counterpartyId: cpId };
  const preview = amount.trim() !== '' && Number.isFinite(amountNum)
    ? { kind, amount: amountNum, reference, reason, ...counterparty, ...(correcting ? { correctsId: correcting.id, expectedCorrectsRevision: correcting.revision } : {}) }
    : undefined;
  const input = { asOfDate, ...(showTx ? { view: 'transactions' } : {}), ...(preview ? { preview } : {}) };
  const data = useSharedRead<OpeningAccountingRead | null>(
    OP_PAGE_OPENING_ACCOUNTING_GET, { ...input, v: refresh },
    // Am Primary rechnet die Maske nur für den Owner; am PC2 weist der Primary andere Rollen selbst ab.
    (ctx) => (perm.isOwner ? openingAccountingFor(ctx, input) : null),
    null,
    [refresh, asOfDate, showTx, JSON.stringify(preview ?? null)],
  );
  const reload = (): void => setRefresh((r) => r + 1);

  if (!perm.isOwner) return <p data-opening-accounting-no-access style={{ fontSize: 14, color: '#6B7280' }}>Only the owner records and reconciles the opening balances.</p>;
  if (!data) return <p data-opening-accounting-unavailable style={{ fontSize: 14, color: '#6B7280' }}>The opening balances are not available right now.</p>;
  const plan = data.preview?.plan ?? null;

  function reset(): void {
    setAmount(''); setReference(''); setReason(''); setCpType(''); setCpId(''); setCpName(''); setNotInLataif(false);
    setCorrecting(null); setActionId(uuid());
  }
  function startCorrect(i: OpeningAccountItem): void {
    setMsg(null); setKind(i.kind); setAmount(String(i.amount)); setReference(i.reference); setReason('');
    setCpType(i.counterpartyType ?? ''); setCpId(i.counterpartyId ?? ''); setCpName(i.counterpartyType === 'OTHER' ? i.counterpartyName ?? '' : '');
    setCorrecting({ id: i.id, number: i.itemNumber, revision: i.revision }); setActionId(uuid());
  }

  async function record(): Promise<void> {
    if (!plan || sending.current) return;
    sending.current = true;
    try {
      const text = `${correcting ? `Replace ${correcting.number} with` : 'Record'} ${OPENING_ACCOUNT_KIND_INFO[plan.kind].label.toLowerCase()}: ${b3(plan.amount)} BHD as of ${OPENING_CUTOFF_DATE}?\n\n`
        + 'This creates an opening document only: nothing is booked — no cash, bank, Benefit, VAT or ledger entry.';
      if (!(await window.confirm(text))) return;
      const body = {
        actionId, kind: plan.kind, amount: plan.amount, reference: plan.reference, reason: plan.reason,
        ...(plan.counterparty ? (plan.counterparty.type === 'OTHER' ? { counterpartyType: 'OTHER' as const, counterpartyName: plan.counterparty.name } : { counterpartyType: plan.counterparty.type, counterpartyId: plan.counterparty.id ?? '' }) : {}),
        ...(plan.corrects ? { correctsId: plan.corrects.id, expectedCorrectsRevision: plan.corrects.revision } : {}),
        ...(plan.kind === 'LOAN_RECEIVABLE' || plan.kind === 'LOAN_PAYABLE' ? { confirmNotInLataif: notInLataif } : {}),
      };
      const out = await w.save<OpeningAccountItem>('opening_accounts.create', {
        local: () => recordOpeningAccountItemOnPrimary(body, reload),
        remote: () => body,
      });
      if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
      setMsg({ text: `${out.value.itemNumber} recorded — ${b3(out.value.amount)} BHD, not booked.`, ok: true });
      reset();
      reload();
    } finally {
      sending.current = false;
    }
  }

  async function cancel(): Promise<void> {
    if (!storno || !stornoReason.trim() || sending.current) return;
    sending.current = true;
    try {
      if (!(await window.confirm(`Cancel ${storno.number}? It was not booked, so nothing is reversed in the ledger.`))) return;
      const body = { itemId: storno.id, reason: stornoReason.trim(), expectedRevision: storno.revision };
      const out = await w.save<OpeningAccountItem>('opening_accounts.cancel', {
        local: () => cancelOpeningAccountItemOnPrimary(body, reload),
        remote: () => body,
      });
      if (out.kind !== 'ok') { setMsg({ text: fehlertext(out), ok: false }); return; }
      setMsg({ text: `${out.value.itemNumber} cancelled.`, ok: true });
      setStorno(null); setStornoReason('');
      reload();
    } finally {
      sending.current = false;
    }
  }

  const rowView = (r: OverviewRow) => (
    <tr key={r.key} data-opening-row={r.key}>
      <td style={td}>
        <div style={{ fontWeight: 600 }}>{r.label}</div>
        <div style={{ fontSize: 11, color: '#9CA3AF' }}>{r.source}</div>
        {r.notes.map((n) => <div key={n} style={{ fontSize: 11, color: '#6B7280' }}>{n}</div>)}
      </td>
      <td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(r.booked)}</td>
      <td style={{ ...td, textAlign: 'right' }} className="font-mono">{r.target !== null ? `${b3(r.target)} (counted)` : r.range ? `${r.valuation === 'CURRENT_NOT_VERIFIED' ? 'CURRENT ' : ''}${b3(r.range.low)} – ${b3(r.range.high)}${r.valuation === 'CURRENT_NOT_VERIFIED' ? ' (not verified at cutoff)' : ''}` : b3(r.draft)}</td>
      <td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(r.adjustment)}</td>
      <td style={{ ...td, color: STATUS_COLOR[r.status], fontWeight: 600 }} data-opening-row-status={r.status}>{r.status}</td>
    </tr>
  );
  const live = data.items.filter((i) => i.status === 'RECORDED');

  return (
    <div data-opening-accounting style={{ display: 'grid', gap: 18 }}>
      <div>
        <h2 className="text-display-s" style={{ marginBottom: 4 }}>Opening balances as of {data.cutoffDate}</h2>
        <span data-opening-status style={{ fontSize: 12, fontWeight: 700, color: '#8A5A00' }}>{data.status} — nothing on this page is booked</span>
      </div>
      <div style={box} data-opening-issues>
        {data.issues.map((x) => <div key={x}>• {x}</div>)}
      </div>

      <Card>
        <span className="text-overline">BALANCES — BOOKED VS. RECORDED (NOT BOOKED)</span>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }} data-opening-overview>
          <thead><tr><th style={th}>Balance</th><th style={{ ...th, textAlign: 'right' }}>Booked before cutoff</th><th style={{ ...th, textAlign: 'right' }}>Recorded / counted</th><th style={{ ...th, textAlign: 'right' }}>Change if booked later</th><th style={th}>Status</th></tr></thead>
          <tbody>
            <tr><td colSpan={5} style={{ ...td, fontWeight: 700 }}>Assets</td></tr>
            {data.rows.filter((r) => r.side === 'ASSET').map(rowView)}
            <tr><td colSpan={5} style={{ ...td, fontWeight: 700 }}>Liabilities</td></tr>
            {data.rows.filter((r) => r.side === 'LIABILITY').map(rowView)}
          </tbody>
        </table>
      </Card>

      <Card>
        <span className="text-overline">EQUITY</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6, marginTop: 8, fontSize: 13 }} data-opening-equity>
          <span>Opening equity booked (incl. settings opening 01.01.2000)</span><span className="font-mono" style={{ textAlign: 'right' }}>{b3(data.equity.openingBooked)}</span>
          <span>Partner equity booked</span><span className="font-mono" style={{ textAlign: 'right' }}>{b3(data.equity.partnerBooked)}</span>
          <span>ERP result booked before the cutoff (income − expenses)</span><span className="font-mono" style={{ textAlign: 'right' }}>{b3(data.equity.resultBooked)}</span>
          <span style={{ fontWeight: 600 }}>Provisional opening equity — without old stock</span><span className="font-mono" style={{ textAlign: 'right', fontWeight: 600 }} data-opening-equity-provisional>{b3(data.equity.provisionalOpening.withoutOldStock)}</span>
          <span data-opening-equity-old-stock>Old stock — CURRENT value only, not verified as of {data.cutoffDate}; NOT included above (B5)</span><span className="font-mono" style={{ textAlign: 'right', color: '#7A3535' }}>{b3(data.equity.provisionalOpening.oldStock.low)} … {b3(data.equity.provisionalOpening.oldStock.high)}</span>
        </div>
        <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>Computed from what is booked and what is recorded — nothing is assumed for balances that are not recorded yet.</p>
      </Card>

      <Card>
        <span className="text-overline">EARLIER SETTINGS OPENING (FROZEN)</span>
        <div style={{ fontSize: 12, marginTop: 6 }} data-legacy-cash>
          {(['cash', 'bank', 'benefit'] as const).map((k) => (
            <div key={k}>{k.toUpperCase()}: settings {b3(data.legacyCash.settings[k])} · booked on 01.01.2000 {b3(data.legacyCash.ledger[k])}{data.legacyCash.notBooked.includes(k) ? ' · not booked, not counted' : ''}</div>
          ))}
          <div style={{ color: '#6B7280', marginTop: 4 }}>Kept unchanged — it is not rebooked or moved; the counted balances below are compared with the ledger including it.</div>
        </div>
      </Card>

      <Card>
        <span className="text-overline">OPENING DOCUMENTS (CASH COUNT, LOANS, OTHER, VAT)</span>
        <div style={{ marginTop: 8 }} data-opening-docs>
          {live.length === 0 && <p style={{ fontSize: 12, color: '#6B7280' }}>No opening documents recorded yet.</p>}
          {data.items.map((i) => (
            <div key={i.id} data-opening-doc={i.itemNumber} className="flex justify-between items-center" style={{ padding: '6px 0', borderTop: '1px solid #F1F3F5', fontSize: 12, opacity: i.status === 'CANCELLED' ? 0.55 : 1 }}>
              <span><b className="font-mono">{i.itemNumber}</b> · {OPENING_ACCOUNT_KIND_INFO[i.kind].label} · {b3(i.amount)} BHD · {i.reference}{i.counterpartyName ? ` · ${i.counterpartyName}` : ''} · {i.status === 'CANCELLED' ? `cancelled (${i.cancelReason ?? ''})` : 'not booked'}</span>
              {i.status === 'RECORDED' && i.accounting === 'PENDING' && (
                <span className="flex gap-2">
                  <Button variant="ghost" onClick={() => startCorrect(i)} data-opening-doc-correct>Correct</Button>
                  <Button variant="ghost" onClick={() => { setMsg(null); setStornoReason(''); setStorno({ id: i.id, number: i.itemNumber, revision: i.revision }); }} data-opening-doc-cancel>Cancel</Button>
                </span>
              )}
            </div>
          ))}
        </div>
        {storno && (
          <div style={{ ...box, marginTop: 8, display: 'grid', gap: 8 }} data-opening-doc-cancel-form>
            <Input label={`Why is ${storno.number} cancelled? (required)`} value={stornoReason} onChange={(e) => setStornoReason(e.target.value)} />
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" onClick={() => setStorno(null)}>Back</Button>
              <Button variant="secondary" disabled={!stornoReason.trim()} onClick={() => void cancel()} data-opening-doc-cancel-submit>Cancel document</Button>
            </div>
          </div>
        )}
        <div style={{ marginTop: 14, display: 'grid', gap: 10 }} data-opening-doc-form>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{correcting ? `Correct ${correcting.number}` : 'Record an opening document'}</span>
          <label style={{ fontSize: 12 }}>Kind{' '}
            <select value={kind} disabled={!!correcting} onChange={(e) => { setKind(e.target.value as OpeningAccountKind); setCpType(''); }} data-opening-doc-kind>
              {OPENING_ACCOUNT_KINDS.map((k) => <option key={k} value={k}>{OPENING_ACCOUNT_KIND_INFO[k].label}</option>)}
            </select>
          </label>
          <Input label={info.count ? `Balance on ${OPENING_CUTOFF_DATE} (BHD)` : 'Amount (BHD)'} value={amount} onChange={(e) => setAmount(e.target.value)} data-opening-doc-amount />
          <Input label="Reference (count, statement, contract, document)" value={reference} onChange={(e) => setReference(e.target.value)} data-opening-doc-reference />
          <Input label="Reason / basis (required)" value={reason} onChange={(e) => setReason(e.target.value)} data-opening-doc-reason />
          {info.counterparty !== 'NONE' && (
            <div style={{ display: 'grid', gap: 6 }}>
              <label style={{ fontSize: 12 }}>Counterparty{info.counterparty === 'REQUIRED' ? ' (required)' : ' (optional)'}{' '}
                <select value={cpType} onChange={(e) => { setCpType(e.target.value as CounterpartyType | ''); setCpId(''); setCpName(''); }} data-opening-doc-cp-type>
                  <option value="">—</option><option value="CUSTOMER">Customer</option><option value="SUPPLIER">Supplier</option><option value="OTHER">Other (name)</option>
                </select>
              </label>
              {(cpType === 'CUSTOMER' || cpType === 'SUPPLIER') && (
                <SearchSelect value={cpId} onChange={setCpId} placeholder={`Choose the ${cpType.toLowerCase()}`}
                  options={(cpType === 'CUSTOMER' ? data.counterparties.customers : data.counterparties.suppliers).map((c) => ({ id: c.id, label: c.name }))} />
              )}
              {cpType === 'OTHER' && <Input label="Name" value={cpName} onChange={(e) => setCpName(e.target.value)} />}
            </div>
          )}
          {(kind === 'LOAN_RECEIVABLE' || kind === 'LOAN_PAYABLE') && (
            <label style={{ fontSize: 12 }}><input type="checkbox" checked={notInLataif} onChange={(e) => setNotInLataif(e.target.checked)} data-opening-doc-not-in-lataif /> This loan is not already recorded in LATAIF (Debts).</label>
          )}
          {data.preview && (data.preview.plan ? (
            <div style={box} data-opening-doc-preview>
              {plan?.ledgerBefore !== null && plan?.ledgerBefore !== undefined ? `Ledger before the cutoff ${b3(plan.ledgerBefore)} BHD · counted ${b3(plan.amount)} BHD · difference ${b3(plan.difference)} BHD (not booked). ` : ''}
              Proposed later (not booked): {plan?.proposed}.
            </div>
          ) : (
            <div style={{ ...box, background: 'rgba(170,110,110,0.10)', color: '#7A3535' }} data-opening-doc-refused>{data.preview.issue}</div>
          ))}
          {msg && <div style={{ fontSize: 12, color: msg.ok ? '#2F6B3A' : '#7A3535' }} data-opening-doc-msg>{msg.text}</div>}
          <div className="flex gap-2 justify-end">
            {correcting && <Button variant="ghost" onClick={reset}>Stop correcting</Button>}
            <Button variant="primary" disabled={w.busy || !plan || !reason.trim()} onClick={() => void record()} data-opening-doc-submit>{correcting ? 'Replace document' : 'Record document'}</Button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex justify-between items-center">
          <span className="text-overline">TRIAL BALANCE AND BALANCE SHEET PREVIEW (LEDGER BEFORE)</span>
          <input type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value || OPENING_CUTOFF_DATE)} data-opening-as-of />
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }} data-trial-balance>
          <thead><tr><th style={th}>Account</th><th style={th}>Class</th><th style={{ ...th, textAlign: 'right' }}>Debit</th><th style={{ ...th, textAlign: 'right' }}>Credit</th><th style={{ ...th, textAlign: 'right' }}>Balance</th></tr></thead>
          <tbody>
            {data.trialBalance.lines.map((l) => (
              <tr key={l.account}><td style={td}>{l.account}</td><td style={td}>{l.klass ?? 'NOT CLASSIFIED'}{l.contra ? ' (contra)' : ''}</td>
                <td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(l.debit)}</td><td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(l.credit)}</td><td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(l.balance)}</td></tr>
            ))}
            <tr><td style={{ ...td, fontWeight: 700 }} colSpan={2}>Total ({data.trialBalance.entries} entries)</td><td style={{ ...td, textAlign: 'right', fontWeight: 700 }} className="font-mono">{b3(data.trialBalance.totalDebit)}</td><td style={{ ...td, textAlign: 'right', fontWeight: 700 }} className="font-mono">{b3(data.trialBalance.totalCredit)}</td><td style={{ ...td, textAlign: 'right' }} className="font-mono" data-trial-imbalance>{b3(data.trialBalance.imbalance)}</td></tr>
          </tbody>
        </table>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12, fontSize: 12 }} data-balance-sheet>
          <div><b>Assets {b3(data.balanceSheet.totals.assets)}</b>{data.balanceSheet.assets.filter((g) => g.total !== 0).map((g) => <div key={g.group}>{g.label}: {b3(g.total)}</div>)}</div>
          <div><b>Liabilities {b3(data.balanceSheet.totals.liabilities)}</b>{data.balanceSheet.liabilities.filter((g) => g.total !== 0).map((g) => <div key={g.group}>{g.label}: {b3(g.total)}</div>)}</div>
          <div><b>Equity + result {b3(data.balanceSheet.totals.equityAndResult)}</b>
            <div>Opening equity: {b3(data.balanceSheet.equity.opening)}</div><div>Partner equity: {b3(data.balanceSheet.equity.partner)}</div><div>Result (income − expenses): {b3(data.balanceSheet.equity.result)}</div>
            <div data-balance-difference>Unexplained difference: {b3(data.balanceSheet.difference)}</div>
          </div>
        </div>
        <p style={{ fontSize: 11, color: '#6B7280', marginTop: 6 }}>{data.balanceSheet.status} — booked ledger only; recorded documents above are not part of it.</p>
      </Card>

      <Card>
        <div className="flex justify-between items-center">
          <span className="text-overline">ALL BOOKINGS BEFORE {asOfDate}</span>
          <Button variant="ghost" onClick={() => setShowTx((s) => !s)} data-cutoff-transactions-toggle>{showTx ? 'Hide' : 'Show'}</Button>
        </div>
        {showTx && data.transactions && (
          <div data-cutoff-transactions style={{ marginTop: 8 }}>
            <p style={{ fontSize: 12, color: '#6B7280' }}>{data.transactions.total} booking(s){data.transactions.truncated ? `, first ${data.transactions.rows.length} shown` : ''}. Check each one: is it a real business transaction?</p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Document</th><th style={th}>Origin</th><th style={th}>Status</th><th style={th}>Debit / credit</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Effect on the cutoff balance</th></tr></thead>
              <tbody>
                {data.transactions.rows.map((t) => (
                  <tr key={t.transactionId} data-cutoff-tx={t.document}>
                    <td style={td}>{new Date(t.occurredAt).toLocaleDateString()}</td><td style={td} className="font-mono">{t.document}</td><td style={td}>{t.sourceModule}</td><td style={td}>{t.status}</td>
                    <td style={td}>{t.lines.map((l, k) => <div key={k}>{l.direction === 'DEBIT' ? 'Dr' : 'Cr'} {l.account} {b3(l.amount)}</div>)}</td>
                    <td style={{ ...td, textAlign: 'right' }} className="font-mono">{b3(t.amount)}</td>
                    <td style={td}>{t.effect.map((e) => <div key={e.group}>{e.group} {e.delta > 0 ? '+' : ''}{b3(e.delta)}</div>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

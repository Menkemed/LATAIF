// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A1 — die Ansicht „Account" eines Kunden: was er LATAIF schuldet, was LATAIF ihm schuldet, Nettosaldo,
// Partnerkonto, Gold getrennt, Hinweise auf nicht verknüpfte Posten und der Kontoauszug. NUR LESEN — hier wird nichts
// gebucht, nichts verrechnet, nichts geändert. Die Zahlen kommen aus `parties.account.get` (view = customer_account):
// am Primary lokal, am PC2 vom Primary.
//
// CUSTOMER ACCOUNT C — „Settle Balance": verrechnet offene Rechnungen mit Store Credit und We Borrowed desselben Kunden
// (Vorschlag, Häkchen, eine Bestätigung, eine STL-Nummer, keine Geldbewegung). Die Übersicht „Settlements" zeigt jede
// Verrechnung mit allen Zuordnungen; „Undo settlement" hebt eine ganze STL in einem Zug auf.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Bhd } from '@/components/ui/Bhd';
import { useGoBack } from '@/hooks/useGoBack';
import { useSharedRead } from '@/core/data/shared-read';
import { OP_PARTIES_ACCOUNT_GET, partyAccountReadFor, type PartyAccountRead } from '@/core/parties/party-account';
import { CUSTOMER_ACCOUNT_VIEW, type AccountDoc, type CustomerAccount, type DebtHint, type PartnerAccountView, type StatementRow } from '@/core/parties/customer-account';
import { useSharedWrites, fehlertext, type WriteAdapters } from '@/core/data/shared-write';
import { saveDebtAssignCustomer } from '@/core/finance/money-save';
import { savePartnerLinkToCustomer } from '@/core/masterdata/masterdata-save';
import { usePermission } from '@/hooks/usePermission';
import { SettleBalanceModal, type NotOfferedItem } from '@/components/parties/SettleBalanceModal';
import type { SettlementView } from '@/core/offsets/party-settlement-reads';
import { partnerItemHref } from '@/core/partners/partner-open-balances';
import { reverseSettlementOnPrimary, settlementReverseBody, type SettlementBooked, type SettlementReversed } from '@/core/offsets/party-settlement';

/** Warum ein offener Posten, den LATAIF schuldet, in „Settle Balance" NICHT angeboten wird (Owner 09.11.2026: nur Store Credit + We Borrowed). */
const NICHT_ANGEBOTEN: Partial<Record<AccountDoc['kind'], string>> = {
  // B2/B3 (Owner 10.11.2026) — Einkäufe (normal und Kommission) der verknüpften Rolle SIND angeboten; hier steht nur, wer
  // trotzdem nicht passt (z. B. ohne Einkaufsbuchung oder nicht über die Verknüpfung, sondern nur über die Kommission gefunden).
  PURCHASE: 'this purchase cannot be offset here (supplier role not linked, or no accounting entry)',
  SUPPLIER_EXPENSE: 'supplier expenses (e.g. consignor loss) are not offset',
  CONSIGNMENT_PAYOUT: 'this consignment purchase cannot be offset here (supplier role not linked, or no accounting entry)',
  // v0.8.101 S4 — ein AUSZAHLBARES Partnerguthaben ist angeboten (Gruppe „Partner balances“); hier steht nur, was wartet.
  PARTNER_PAYABLE: 'this partner amount cannot be paid out now (a settlement correction or a supplier credit is pending)',
  ORDER_DEPOSIT: 'bound to its order — applied with that order’s invoice',
  OPENING_ADVANCE: 'opening balance — waits for the accountant',
  OPENING_SUPPLIER_PAYABLE: 'opening balance — waits for the accountant',
  REFUND_DUE: 'a refund to pay out, not store credit',
  RETURN_REFUND: 'a refund to pay out, not store credit',
};

/** CUSTOMER ACCOUNT C — die Verrechnungen dieses Kunden mit allen Zuordnungen; „Undo settlement" für eine noch wirksame. */
function Settlements({ list, canUndo, busy, onUndo }: { list: SettlementView[]; canUndo: boolean; busy: boolean; onUndo: (s: SettlementView) => void }) {
  if (list.length === 0) return <p style={{ fontSize: 13, color: GREY, marginTop: 6 }} data-settlements-none>No settlement yet.</p>;
  return (
    <div style={{ marginTop: 6 }} data-settlements={list.length}>
      {list.map((st) => (
        <div key={st.number} data-settlement={st.number} data-settlement-status={st.status} style={{ borderTop: `1px solid ${LINE}`, padding: '10px 0' }}>
          <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13 }}>
              <b>{st.number}</b> <span style={{ color: GREY }}>· {fmtDate(st.date)} · {st.single ? 'single offset on the invoice' : `${st.lines.length} offsets`} · no cash</span>
              {st.status !== 'ACTIVE' && <span style={{ marginLeft: 8, fontSize: 11, color: st.status === 'REVERSED' ? GREY : AMBER }}>{st.status === 'REVERSED' ? 'undone' : 'partly undone'}</span>}
            </span>
            <span className="flex items-center" style={{ gap: 10 }}>
              <span className="font-mono" style={{ fontSize: 13, color: st.status === 'REVERSED' ? GREY : INK }}><Bhd v={st.status === 'REVERSED' ? st.total : st.activeTotal} /> BHD</span>
              {st.status !== 'REVERSED' && canUndo && (
                <button onClick={() => onUndo(st)} disabled={busy} className="cursor-pointer" data-settlement-undo={st.number}
                  style={{ background: '#fff', border: `1px solid ${LINE}`, borderRadius: 8, padding: '4px 10px', fontSize: 12, color: '#AA6E6E' }}>
                  Undo settlement
                </button>
              )}
            </span>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
            <tbody>
              {st.lines.map((l) => (
                <tr key={l.offsetId} data-settlement-line={l.offsetNumber} data-settlement-line-status={l.status}>
                  <td style={{ ...td, fontSize: 12, color: l.status === 'ACTIVE' ? INK : GREY }}>{l.offsetNumber}</td>
                  <td style={{ ...td, fontSize: 12 }}>{l.sourceKind === 'STORE_CREDIT'
                    ? (l.sourceNumber === 'Store credit' ? 'Store credit' : `Store credit ${l.sourceNumber}`)
                    // v0.8.101 S0 — eine Einkaufsverrechnung ist kein Darlehen: Gegenbeleg ist der Einkauf selbst.
                    : l.sourceKind === 'PURCHASE'
                      ? <>Purchase <Link to={`/purchases/${encodeURIComponent(l.sourceId)}`} style={{ color: INK }} data-settlement-line-source="PURCHASE">{l.sourceNumber}</Link></>
                      : l.sourceKind === 'PARTNER_ITEM'
                        ? <>Partner balance <Link to={l.partnerId ? partnerItemHref(l.partnerId, l.sourceId) : '/partners'} style={{ color: INK }} data-settlement-line-source="PARTNER_ITEM">{l.sourceNumber}</Link></>
                      : <>We Borrowed <Link to={`/debts?filter=all&loan=${encodeURIComponent(l.sourceNumber)}`} style={{ color: INK }}>{l.sourceNumber}</Link></>}</td>
                  <td style={{ ...td, fontSize: 12 }}>→ <Link to={`/invoices/${l.invoiceId}`} style={{ color: INK }}>{l.invoiceNumber}</Link></td>
                  <td style={{ ...td, fontSize: 12, color: GREY }}>{l.status === 'ACTIVE' ? 'Offset – no cash' : `removed${l.reverseReason ? ` (${l.reverseReason})` : ''}`}</td>
                  <td style={{ ...num, fontSize: 12, textDecoration: l.status === 'ACTIVE' ? 'none' : 'line-through', color: l.status === 'ACTIVE' ? INK : GREY }}><Bhd v={l.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

const INK = '#0F0F10';
const GREY = '#6B7280';
const LINE = '#E5E9EE';
const GOLD = '#AA956E';
const AMBER = '#B45309';

const fmtDate = (d: string): string => {
  if (!d) return '—';
  const [y, m, dd] = d.split('-');
  return y && m && dd ? `${dd}.${m}.${y}` : d;
};

const STATUS_STYLE: Record<AccountDoc['status'], { label: string; fg: string; bg: string }> = {
  OPEN: { label: 'Open', fg: AMBER, bg: 'rgba(245,158,11,0.10)' },
  PARTIAL: { label: 'Partly settled', fg: '#1D4ED8', bg: 'rgba(59,130,246,0.10)' },
  SETTLED: { label: 'Settled', fg: '#15803D', bg: 'rgba(22,163,74,0.10)' },
};

function Pill({ status }: { status: AccountDoc['status'] }) {
  const s = STATUS_STYLE[status];
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 9px', borderRadius: 999, color: s.fg, background: s.bg, whiteSpace: 'nowrap' }}>{s.label}</span>;
}

function DocLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <Link to={href} style={{ color: INK, fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2 }}>{children}</Link> : <span style={{ fontWeight: 500 }}>{children}</span>;
}

const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, color: GREY, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 500, padding: '6px 8px', borderBottom: `1px solid ${LINE}` };
const td: React.CSSProperties = { padding: '9px 8px', borderBottom: `1px solid ${LINE}`, fontSize: 13, verticalAlign: 'top' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, Consolas, monospace', whiteSpace: 'nowrap' };

function SideTable({ title, docs, testId, showSettled }: { title: string; docs: AccountDoc[]; testId: string; showSettled: boolean }) {
  const rows = docs.filter((d) => showSettled || d.status !== 'SETTLED');
  return (
    <Card style={{ minWidth: 0 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: INK, marginBottom: 10 }}>{title}</h3>
      {rows.length === 0 ? <p style={{ fontSize: 13, color: GREY }}>Nothing open.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-account-side={testId}>
            <thead><tr><th style={th}>Document</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={{ ...th, textAlign: 'right' }}>Open</th><th style={th}>Status today</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.key} data-account-doc={d.key} data-doc-open={d.open}>
                  <td style={td}>
                    <DocLink href={d.href}>{d.number}</DocLink>
                    <div style={{ fontSize: 11, color: GREY, marginTop: 2 }}>{d.kindLabel} · {fmtDate(d.date)}{d.detail && d.detail !== d.kindLabel ? ` · ${d.detail}` : ''}</div>
                    {d.bound && <div style={{ fontSize: 11, color: GOLD, marginTop: 2 }} data-doc-bound>Bound: {d.bound}</div>}
                  </td>
                  <td style={num}><Bhd v={d.total} /></td>
                  <td style={{ ...num, fontWeight: d.open > 0 ? 600 : 400, color: d.open > 0 ? INK : GREY }}><Bhd v={d.open} /></td>
                  <td style={td}><Pill status={d.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PartnerBlock({ p, onLink, busy }: { p: PartnerAccountView; onLink?: () => void; busy?: boolean }) {
  const possible = p.link === 'POSSIBLE';
  return (
    <div style={{ border: `1px ${possible ? 'dashed' : 'solid'} ${possible ? '#F5C78E' : LINE}`, borderRadius: 12, padding: 14, marginTop: 10, background: possible ? '#FFFBF3' : '#fff' }} data-partner-block={p.partnerId} data-partner-link={p.link}>
      <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div>
          <Link to={`/partners?partner=${encodeURIComponent(p.partnerId)}`} style={{ color: INK, fontWeight: 600 }}>{p.name}</Link>
          <span style={{ fontSize: 12, color: possible ? AMBER : GREY, marginLeft: 8 }}>
            {possible ? `possible match by ${p.matchedBy} — not linked, NOT counted in the balance` : 'linked partner — open amounts counted in the balance'}
          </span>
        </div>
        <div className="flex items-center gap-3" style={{ fontSize: 12, color: GREY, flexWrap: 'wrap' }}>
          <span>We owe the partner <b style={{ color: INK }}><Bhd v={p.owedToPartner} /></b> · partner owes us <b style={{ color: INK }}><Bhd v={p.owedByPartner} /></b></span>
          {possible && onLink && (
            <button onClick={onLink} disabled={busy} className="cursor-pointer" data-partner-link-here={p.partnerId}
              style={{ background: '#fff', border: `1px solid ${INK}`, borderRadius: 8, padding: '5px 12px', fontSize: 12, color: INK }}>
              Link to this client
            </button>
          )}
        </div>
      </div>
      {p.items.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>
              <th style={th}>Item / purchase</th><th style={{ ...th, textAlign: 'right' }}>Share</th><th style={{ ...th, textAlign: 'right' }}>Agreed contribution</th>
              <th style={{ ...th, textAlign: 'right' }}>Paid in</th><th style={th}>Sale</th><th style={{ ...th, textAlign: 'right' }}>Profit share</th>
              <th style={{ ...th, textAlign: 'right' }}>Paid out / offset</th><th style={{ ...th, textAlign: 'right' }}>Open</th>
            </tr></thead>
            <tbody>
              {p.items.map((it) => (
                <tr key={it.href}>
                  <td style={td}><Link to={it.href} style={{ color: INK }}>{it.productLabel}</Link><div style={{ fontSize: 11, color: GREY }}>{it.purchaseNumber} · {fmtDate(it.purchaseDate)}</div></td>
                  <td style={num}>{it.sharePct}%</td>
                  <td style={num}><Bhd v={it.costShare} /></td>
                  <td style={num}><Bhd v={it.contributed} /></td>
                  <td style={td}>{it.sales.length === 0 ? <span style={{ color: GREY }}>not sold</span> : it.sales.map((s) => (
                    <div key={s.invoiceId + s.invoiceNumber} style={{ fontSize: 12 }}><Link to={`/invoices/${s.invoiceId}`} style={{ color: INK }}>{s.invoiceNumber}</Link> <span style={{ color: GREY }}>· {fmtDate(s.issuedAt)} · {s.state.toLowerCase().replace('_', ' ')}</span></div>
                  ))}</td>
                  <td style={num}><Bhd v={it.profitShare} />{it.profitNotSettled > 0 && <div style={{ fontSize: 11, color: GREY }} title="computed from sales that are not settled yet — never counted">+<Bhd v={it.profitNotSettled} /> not settled</div>}</td>
                  <td style={num}><Bhd v={it.paidOut + it.offsets} /></td>
                  <td style={{ ...num, fontWeight: 600 }}>{it.open > 0 ? 'we owe ' : it.open < 0 ? 'owes us ' : ''}<Bhd v={Math.abs(it.open)} />{it.onHold && <div style={{ fontSize: 11, color: GOLD }}>on hold</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// CUSTOMER ACCOUNT A1.1 — Beträge lesbarer: getrennte Spalten für Belastung (+) und Gutschrift (−), volle Nachkommastellen,
// der laufende Saldo mit Klartext (wer schuldet wem). Der Status ist der HEUTIGE Stand des Belegs.
const amountCell: React.CSSProperties = { ...num, fontSize: 13, fontVariantNumeric: 'tabular-nums' };
const FULL = '1em';

function BalanceCell({ v }: { v: number }) {
  const who = v > 0 ? 'client owes' : v < 0 ? 'LATAIF owes' : 'settled';
  return (
    <td style={{ ...amountCell, color: v < 0 ? AMBER : INK, fontWeight: 600 }} data-statement-balance={v}>
      <Bhd v={Math.abs(v)} fracSize={FULL} />
      <div style={{ fontSize: 10, fontWeight: 400, color: GREY, fontFamily: 'inherit', letterSpacing: '0.02em' }}>{who}</div>
    </td>
  );
}

function Statement({ rows, showSettled }: { rows: StatementRow[]; showSettled: boolean }) {
  const shown = showSettled ? rows : rows.filter((r) => r.status !== 'SETTLED');
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }} data-account-statement>
        <thead><tr>
          <th style={th}>Date</th><th style={th}>Document</th><th style={th}>Transaction</th>
          <th style={{ ...th, textAlign: 'right' }} title="Raises what the client owes LATAIF (or lowers what LATAIF owes the client)">Charge (+)</th>
          <th style={{ ...th, textAlign: 'right' }} title="Lowers what the client owes LATAIF (or raises what LATAIF owes the client)">Credit (−)</th>
          <th style={{ ...th, textAlign: 'right' }}>Balance</th>
          <th style={th} title="The document's status today — not its status on the date of this line" data-statement-status-head>Status today</th>
        </tr></thead>
        <tbody>
          {shown.map((r, k) => (
            <tr key={k} data-statement-row={r.docKey}>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDate(r.date)}</td>
              <td style={td}><DocLink href={r.href}>{r.number}</DocLink><div style={{ fontSize: 11, color: GREY }}>{r.kindLabel}</div></td>
              <td style={td}>{r.text}</td>
              <td style={amountCell} data-statement-charge={r.change > 0 ? r.change : 0}>{r.change > 0 ? <Bhd v={r.change} fracSize={FULL} /> : ''}</td>
              <td style={{ ...amountCell, color: AMBER }} data-statement-credit={r.change < 0 ? -r.change : 0}>{r.change < 0 ? <Bhd v={-r.change} fracSize={FULL} /> : ''}</td>
              <BalanceCell v={r.balance} />
              <td style={td}><Pill status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: GREY, marginTop: 8 }}>
        Charge raises what the client owes LATAIF; credit lowers it or raises what LATAIF owes the client. “Status today” is the
        document's current status, not its status on the date of the line.
        {!showSettled && rows.length !== shown.length && ' Settled documents are hidden — the running balance still includes them.'}
      </p>
    </div>
  );
}

export function CustomerAccountPage() {
  const { id } = useParams<{ id: string }>();
  const goBack = useGoBack(id ? `/clients/${id}` : '/clients');
  const [tick, setTick] = useState(0);
  const [showSettled, setShowSettled] = useState(true);
  const params = { partyType: 'CUSTOMER', partyId: id ?? '', view: CUSTOMER_ACCOUNT_VIEW, v: tick };
  const read = useSharedRead<PartyAccountRead | null>(
    OP_PARTIES_ACCOUNT_GET, params,
    (ctx) => partyAccountReadFor(ctx, { partyType: 'CUSTOMER', partyId: id, view: CUSTOMER_ACCOUNT_VIEW }),
    null, [id, tick],
  );
  const acc: CustomerAccount | null = read?.customerAccount ?? null;
  const owes = useMemo(() => acc?.docs.filter((d) => d.side === 'OWES_US') ?? [], [acc]);
  const weOwe = useMemo(() => acc?.docs.filter((d) => d.side === 'WE_OWE') ?? [], [acc]);
  const possiblePartners = acc?.hints.partners ?? [];
  // CUSTOMER ACCOUNT C — „Settle Balance": dieselbe Auskunft liefert die angebotenen Posten, den Fingerabdruck und die Verrechnungen.
  const perm = usePermission();
  const settle = read?.settleBalance ?? null;
  const [settleOpen, setSettleOpen] = useState(false);
  const [settleNotice, setSettleNotice] = useState<string | null>(null);
  const [gebucht, setGebucht] = useState<string | null>(null);
  const kannVerrechnen = !!settle && settle.invoices.length > 0 && settle.sources.length > 0;
  const nichtAngeboten = useMemo<NotOfferedItem[]>(() => (acc?.docs ?? [])
    .filter((d) => d.side === 'WE_OWE' && d.open > 0.0045 && NICHT_ANGEBOTEN[d.kind])
    // B2/B3 — ein angebotener Einkauf steht rechts in der Gruppe „Purchases", nicht hier.
    .filter((d) => !(d.key.startsWith('purchase:') && (settle?.sources ?? []).some((x) => x.kind === 'PURCHASE' && `purchase:${x.id}` === d.key)))
    // v0.8.101 S4 — ein angebotenes Partnerguthaben steht rechts in der Gruppe „Partner balances“, nicht hier.
    .filter((d) => !(d.key.startsWith('partner:') && (settle?.sources ?? []).some((x) => x.kind === 'PARTNER_ITEM' && `partner:${x.partnerId}:${x.id}` === d.key)))
    .map((d) => ({ key: d.key, number: d.number, label: d.kindLabel, open: d.open, why: NICHT_ANGEBOTEN[d.kind] as string })), [acc, settle]);
  async function verrechnungAufheben(st: SettlementView) {
    setAktionFehler('');
    setGebucht(null);
    const ok = await window.confirm(`Undo ${st.number}?\n\nEvery offset of this settlement that is still active (${st.activeLines}, ${st.activeTotal.toFixed(3)} BHD) is removed at once: the invoices are open again by these amounts, the store credit, loans, purchases and partner balances are open again. No cash moves. Final invoice numbers stay as they are.`);
    if (!ok) return;
    const req = { settlementNumber: st.number, expectedActiveLines: st.activeLines, reason: 'settlement undone in the client account' };
    const r = await w.save<SettlementReversed>('customers.settlement_reverse', {
      local: () => reverseSettlementOnPrimary(req),
      remote: () => settlementReverseBody(req),
    });
    if (r.kind !== 'ok') { setAktionFehler(`Could not undo ${st.number}: ${fehlertext(r)}`); setTick((t) => t + 1); return; }
    setGebucht(`${st.number} undone — ${r.value.reversedLines} offset${r.value.reversedLines === 1 ? '' : 's'}, ${r.value.amount.toFixed(3)} BHD open again on both sides. No cash moved.`);
    setTick((t) => t + 1);
  }
  function verrechnet(b: SettlementBooked) {
    setSettleOpen(false);
    setSettleNotice(null);
    setGebucht(`Settlement ${b.settlementNumber} booked — ${b.lines.length} offset${b.lines.length === 1 ? '' : 's'}, ${b.total.toFixed(3)} BHD, dated ${fmtDate(b.settlementDate)}. No cash moved.`);
    setTick((t) => t + 1);
  }

  // CUSTOMER ACCOUNT A2 — die beiden ausdrücklichen Zuordnungen aus dem Konto heraus, je mit Rückfrage: ein Darlehen ohne
  // Kunde diesem Kunden zuordnen (P2), einen möglichen Partner mit diesem Kunden verknüpfen (P1). Danach neu lesen.
  const w = useSharedWrites();
  const [aktionFehler, setAktionFehler] = useState('');
  async function darlehenZuordnen(h: DebtHint) {
    if (!acc) return;
    setAktionFehler('');
    const ok = await window.confirm(`Assign loan ${h.loanNumber} (counterparty “${h.counterparty}”) to ${acc.customer.name}?\n\nOnly the client link is saved — amount, repayments, status and bookings stay as they are. It cannot be moved to another client afterwards.`);
    if (!ok) return;
    const r = await saveDebtAssignCustomer(w, { id: h.id, revision: h.revision }, acc.customer.id);
    if (r.kind !== 'ok') { setAktionFehler(`Could not assign ${h.loanNumber}: ${fehlertext(r)}`); return; }
    setTick((t) => t + 1);
  }
  async function partnerVerknuepfen(p: PartnerAccountView) {
    if (!acc) return;
    setAktionFehler('');
    const ok = await window.confirm(`Link partner "${p.name}" to ${acc.customer.name} (same person)?\n\nOnly the link is saved — shares, settlements and bookings stay as they are. The partner's open amounts then count in this account.`);
    if (!ok) return;
    const r = await savePartnerLinkToCustomer(
      { remote: w.remote, save: (a: WriteAdapters<{ partnerId: string; existing: boolean }>) => w.save('partners.update', a) },
      p.partnerId, { id: acc.customer.id, updatedAt: acc.customer.updatedAt },
    );
    if (r.kind !== 'ok') { setAktionFehler(`Could not link ${p.name}: ${fehlertext(r)}`); return; }
    setTick((t) => t + 1);
  }

  return (
    <div className="app-content" style={{ background: '#FFFFFF' }}>
      <div style={{ padding: '32px 48px 64px', maxWidth: 1500 }} data-customer-account={id}>
        <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
          <button onClick={goBack} className="flex items-center gap-2 cursor-pointer" style={{ background: 'none', border: 'none', color: GREY, fontSize: 13 }}>
            <ArrowLeft size={16} /> Back
          </button>
          <span className="flex items-center gap-2">
            {acc && perm.canRecordPayments && (
              <button onClick={() => { setGebucht(null); setSettleNotice(null); setSettleOpen(true); }} disabled={!kannVerrechnen} data-account-settle
                title={kannVerrechnen ? 'Offset open invoices with store credit and We Borrowed — no cash' : 'Nothing to offset: it needs an open invoice and open store credit or We Borrowed of this client'}
                className="cursor-pointer" style={{ background: kannVerrechnen ? INK : '#E5E7EB', color: kannVerrechnen ? '#FFF' : GREY, border: 'none', borderRadius: 8, padding: '7px 16px', fontSize: 12, fontWeight: 600 }}>
                Settle Balance
              </button>
            )}
            <button onClick={() => setTick((t) => t + 1)} className="flex items-center gap-2 cursor-pointer" data-account-refresh
              style={{ background: 'none', border: `1px solid ${LINE}`, borderRadius: 8, padding: '6px 14px', fontSize: 12, color: INK }}>
              <RefreshCw size={13} /> Refresh
            </button>
          </span>
        </div>

        {!acc ? (
          <p style={{ fontSize: 13, color: GREY }} data-account-loading>{read === null ? 'Loading the account…' : 'This client has no account in this branch.'}</p>
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <h1 className="font-display" style={{ fontSize: 30, color: INK, margin: 0 }}>{acc.customer.name}</h1>
              <div style={{ fontSize: 13, color: GREY, marginTop: 4 }}>
                Account statement · read-only overview
                {acc.supplierRole && <> · supplier role <Link to={`/suppliers/${acc.supplierRole.id}`} style={{ color: INK }}>{acc.supplierRole.name}</Link> (linked)</>}
              </div>
            </div>

            <div style={{ background: '#FFF7E6', border: '1px solid #F3D9A4', color: '#7A5B1E', borderRadius: 10, padding: '10px 14px', fontSize: 13, marginBottom: 18 }}>
              The balance is an overview. Nothing is paid or offset by opening this page — invoices and debts change only when a payment or settlement is confirmed.
            </div>

            {!acc.complete && (
              <div style={{ border: '1px dashed #F5C78E', background: '#FFFBF3', borderRadius: 12, padding: '12px 14px', marginBottom: 18, fontSize: 13 }} data-account-incomplete>
                <b>The balance may be incomplete.</b>
                <ul style={{ margin: '6px 0 0 18px', padding: 0, color: '#7A5B1E' }}>{acc.incomplete.map((t) => <li key={t}>{t}</li>)}</ul>
              </div>
            )}
            {gebucht && (
              <div style={{ border: '1px solid #A7F3D0', background: '#ECFDF5', color: '#065F46', borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 13 }} data-account-settled>
                {gebucht}
              </div>
            )}
            {aktionFehler && (
              <div style={{ border: '1px solid #FCA5A5', background: '#FEF2F2', color: '#B91C1C', borderRadius: 10, padding: '10px 14px', marginBottom: 18, fontSize: 13 }} data-account-action-error>
                {aktionFehler}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 18 }}>
              <Card>
                <div style={{ fontSize: 11, color: GREY, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{acc.customer.name} owes us</div>
                <div className="font-display" style={{ fontSize: 26, color: INK, marginTop: 6 }} data-account-owes-us={acc.owesUs.total}><Bhd v={acc.owesUs.total} /> <span style={{ fontSize: 12, color: GREY }}>BHD</span></div>
                <div style={{ fontSize: 11, color: GREY, marginTop: 6 }}>free <Bhd v={acc.owesUs.free} />{acc.owesUs.bound > 0 && <> · bound <Bhd v={acc.owesUs.bound} /></>}</div>
              </Card>
              <Card>
                <div style={{ fontSize: 11, color: GREY, letterSpacing: '0.08em', textTransform: 'uppercase' }}>We owe {acc.customer.name}</div>
                <div className="font-display" style={{ fontSize: 26, color: INK, marginTop: 6 }} data-account-we-owe={acc.weOwe.total}><Bhd v={acc.weOwe.total} /> <span style={{ fontSize: 12, color: GREY }}>BHD</span></div>
                <div style={{ fontSize: 11, color: GREY, marginTop: 6 }}>free <Bhd v={acc.weOwe.free} />{acc.weOwe.bound > 0 && <> · bound <Bhd v={acc.weOwe.bound} /></>}</div>
              </Card>
              <Card style={{ border: `1px solid ${INK}` }}>
                <div style={{ fontSize: 11, color: GREY, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Net balance</div>
                <div className="font-display" style={{ fontSize: 30, color: INK, marginTop: 6 }} data-account-net={acc.net} data-account-direction={acc.direction}>
                  <Bhd v={Math.abs(acc.net)} /> <span style={{ fontSize: 12, color: GREY }}>BHD</span>
                </div>
                <div style={{ fontSize: 12, color: INK, marginTop: 6 }}>
                  {acc.direction === 'CLIENT_OWES' ? `${acc.customer.name} owes LATAIF.` : acc.direction === 'WE_OWE' ? `LATAIF owes ${acc.customer.name}.` : 'Balanced — nobody owes anything.'}
                </div>
                <div style={{ fontSize: 11, color: GREY, marginTop: 4 }} data-account-net-free={acc.netFree}>
                  Free amounts only: {acc.netFree > 0 ? 'client owes ' : acc.netFree < 0 ? 'we owe ' : ''}<Bhd v={Math.abs(acc.netFree)} /> BHD
                </div>
                {/* CUSTOMER ACCOUNT A1.1 — direkt am Netto: es fehlen womöglich nicht verknüpfte Posten. */}
                {!acc.complete && (
                  <div style={{ fontSize: 11, color: AMBER, marginTop: 6, fontWeight: 600 }} data-account-net-incomplete={acc.incomplete.length}>
                    ⚠ May be incomplete — unlinked items that may belong to this client are not included (see below).
                  </div>
                )}
              </Card>
            </div>

            <div className="flex items-center gap-2" style={{ marginBottom: 10, fontSize: 12, color: GREY }}>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} data-account-show-settled /> Show settled documents</label>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16, marginBottom: 18 }}>
              <SideTable title={`${acc.customer.name} owes us`} docs={owes} testId="owes-us" showSettled={showSettled} />
              <SideTable title={`We owe ${acc.customer.name}`} docs={weOwe} testId="we-owe" showSettled={showSettled} />
            </div>

            <Card style={{ marginBottom: 18 }}>
              <h3 style={{ fontSize: 15, fontWeight: 600, color: INK }}>Partner account</h3>
              {acc.partners.length === 0 && possiblePartners.length === 0 && (
                <p style={{ fontSize: 13, color: GREY, marginTop: 6 }} data-partner-none>No partner account belongs to this client.</p>
              )}
              {acc.partners.map((p) => <PartnerBlock key={p.partnerId} p={p} />)}
              {possiblePartners.length > 0 && (
                <p style={{ fontSize: 12, color: GREY, marginTop: 8 }}>
                  A partner with the same name or phone is shown below for checking; its amounts are not part of the balance until you link it — the app never links by name or phone.
                </p>
              )}
              {possiblePartners.map((p) => <PartnerBlock key={p.partnerId} p={p} busy={w.busy} onLink={() => void partnerVerknuepfen(p)} />)}
            </Card>

            <Card style={{ marginBottom: 18 }}>
              <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: INK }}>Gold account</h3>
                <span style={{ fontSize: 12, color: GREY }}>In grams, separate from BHD — never converted or offset.</span>
              </div>
              {acc.gold.length === 0 ? <p style={{ fontSize: 13, color: GREY, marginTop: 6 }} data-gold-none>No open gold credit.</p> : (
                <div className="flex gap-6" style={{ marginTop: 8, flexWrap: 'wrap' }} data-account-gold>
                  {acc.gold.map((g) => (
                    <div key={g.karat} data-gold-karat={g.karat} data-gold-grams={g.grams}>
                      <div className="font-display" style={{ fontSize: 22, color: INK }}>{g.grams.toFixed(3)} g</div>
                      <div style={{ fontSize: 11, color: GREY }}>{g.karat} · {g.count} credit{g.count === 1 ? '' : 's'} · we owe the client</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {(acc.hints.debts.length > 0 || acc.hints.suppliers.length > 0) && (
              <div style={{ border: '1px dashed #F5C78E', background: '#FFFBF3', borderRadius: 12, padding: '12px 14px', marginBottom: 18, fontSize: 13 }} data-account-hints>
                <b>Not linked to this client — please check</b>
                <div style={{ fontSize: 12, color: GREY, margin: '4px 0 8px' }}>These are not counted in the balance. The app never links by name or phone.</div>
                {acc.hints.debts.map((h) => (
                  <div key={h.id} className="flex items-center justify-between" style={{ padding: '4px 0', gap: 12 }} data-hint-debt={h.id}>
                    <span><Link to="/debts" style={{ color: INK, fontWeight: 500 }}>{h.loanNumber}</Link> · {h.direction === 'WE_LENT' ? 'We Lent' : 'We Borrowed'} · {fmtDate(h.date)} · counterparty “{h.counterparty}”</span>
                    <span className="flex items-center gap-3">
                      <span className="font-mono">open <Bhd v={h.open} /></span>
                      <button onClick={() => void darlehenZuordnen(h)} disabled={w.busy} className="cursor-pointer" data-hint-debt-assign={h.id}
                        style={{ background: '#fff', border: `1px solid ${INK}`, borderRadius: 8, padding: '5px 12px', fontSize: 12, color: INK }}>
                        Assign to this client
                      </button>
                    </span>
                  </div>
                ))}
                {acc.hints.suppliers.map((h) => (
                  <div key={h.id} className="flex items-center justify-between" style={{ padding: '4px 0', gap: 12 }} data-hint-supplier={h.id}>
                    <span>Supplier <Link to={`/suppliers/${h.id}`} style={{ color: INK, fontWeight: 500 }}>{h.name}</Link> · same {h.matchedBy} · not linked</span>
                    <span className="font-mono">open purchases <Bhd v={h.outstanding} /></span>
                  </div>
                ))}
              </div>
            )}

            <Card style={{ marginBottom: 18 }}>
              <div className="flex items-center justify-between" style={{ gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: INK }}>Settlements</h3>
                <span style={{ fontSize: 12, color: GREY }}>Offsets without cash. Undo removes every active offset of a settlement at once; single lines can also be removed on the invoice.</span>
              </div>
              <Settlements list={settle?.settlements ?? []} canUndo={perm.canRecordPayments} busy={w.busy} onUndo={(st) => { void verrechnungAufheben(st); }} />
            </Card>

            <Card>
              <div className="flex items-center justify-between" style={{ marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: INK }}>Account statement</h3>
                <span style={{ fontSize: 12, color: GREY }}>+ = {acc.customer.name} owes LATAIF · − = LATAIF owes {acc.customer.name}</span>
              </div>
              {acc.statement.length === 0 ? <p style={{ fontSize: 13, color: GREY }}>No transactions yet.</p> : <Statement rows={acc.statement} showSettled={showSettled} />}
            </Card>
          </>
        )}
        {settleOpen && acc && settle && (
          <SettleBalanceModal
            key={settle.stamp}
            customerName={acc.customer.name}
            data={settle}
            totals={{ owesUs: acc.owesUs.total, weOwe: acc.weOwe.total, net: acc.net }}
            notOffered={nichtAngeboten}
            notice={settleNotice}
            onClose={() => { setSettleOpen(false); setSettleNotice(null); }}
            onDone={verrechnet}
            onStale={() => {
              setSettleNotice('The open items changed in the meantime (another payment, offset or change). Nothing was booked — this is the proposal for the current state. Check it and confirm again.');
              setTick((t) => t + 1);
            }}
          />
        )}
      </div>
    </div>
  );
}

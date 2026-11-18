// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTING-OPENING-DATE — „Settings → Accounting": der Buchungsstichtag DIESER Datenbank.
//
// Anzeigen kann jeder, der Settings sieht; ändern nur der Owner und nur am Primary (die Hausfunktion prüft die Rolle
// selbst noch einmal aus der Datenbank). Erst „Check", dann „Save": die Prüfung ist dieselbe, die vor dem Schreiben
// läuft — Eröffnungsposten auf dem alten Tag und rückwirkend gesperrte Vorgänge werden abgelehnt.
// ════════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { usePermission } from '@/hooks/usePermission';
import { isClientMode } from '@/core/bridge/client-mode';
import { accountingOpeningDateInfo, DEFAULT_ACCOUNTING_OPENING_DATE } from '@/core/accounting/opening-date';
import { checkOpeningDateChange, setAccountingOpeningDateOnPrimary, type OpeningDateCheck } from '@/core/accounting/opening-date-house';

const box = { padding: '10px 14px', background: '#F5F7FA', border: '1px solid #E5E9EE', borderRadius: 8, fontSize: 13, color: '#374151' } as const;

export function AccountingOpeningDatePanel() {
  const perm = usePermission();
  const client = isClientMode();
  const [stand, setStand] = useState(() => accountingOpeningDateInfo());
  const [neu, setNeu] = useState(stand.date);
  const [pruefung, setPruefung] = useState<OpeningDateCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const herkunft = stand.source === 'database' ? 'set for this database'
    : stand.source === 'primary' ? 'from the main computer'
    : `default (${DEFAULT_ACCOUNTING_OPENING_DATE}) — not set for this database yet`;

  const pruefen = () => {
    setMsg(null);
    try { setPruefung(checkOpeningDateChange(neu)); } catch (e) { setPruefung(null); setMsg({ text: (e as Error).message, ok: false }); }
  };
  const speichern = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await setAccountingOpeningDateOnPrimary(neu);
      setStand(accountingOpeningDateInfo()); setPruefung(null);
      setMsg({ text: r.changed ? `Accounting opening date changed from ${r.previous} to ${r.date}.` : `The accounting opening date is already ${r.date}.`, ok: true });
    } catch (e) {
      setMsg({ text: (e as Error).message, ok: false });
    } finally { setBusy(false); }
  };

  return (
    <div data-accounting-opening-date style={{ display: 'grid', gap: 18, maxWidth: 760 }}>
      <Card>
        <span className="text-overline">ACCOUNTING OPENING DATE</span>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
          <span style={{ fontSize: 22, fontWeight: 600, color: '#0F0F10' }} data-accounting-opening-date-current>{stand.date}</span>
          <span style={{ fontSize: 12, color: '#6B7280' }} data-accounting-opening-date-source={stand.source}>{herkunft}</span>
        </div>
        <p style={{ fontSize: 13, color: '#4B5563', marginTop: 10, lineHeight: 1.5 }}>
          Bookings and corrections dated before this day are locked; opening balances describe the balance on this day.
          Each LATAIF database has its own opening date — changing it here changes nothing on another installation.
          Filed or paid VAT quarters stay locked independently. Changing the date does not change any invoice, payment or booking.
        </p>
      </Card>

      {client ? (
        <div style={box} data-accounting-opening-date-client>The opening date belongs to the main computer's database and is set there.</div>
      ) : !perm.isOwner ? (
        <div style={box} data-accounting-opening-date-no-access>Only the owner can change the accounting opening date.</div>
      ) : (
        <Card>
          <span className="text-overline">CHANGE</span>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'grid', gap: 4, fontSize: 11, color: '#6B7280' }}>
              NEW OPENING DATE
              <input type="date" value={neu} onChange={(e) => { setNeu(e.target.value); setPruefung(null); setMsg(null); }} data-accounting-opening-date-input
                style={{ padding: '7px 10px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6 }} />
            </label>
            <Button variant="secondary" onClick={pruefen} disabled={busy || !neu} data-accounting-opening-date-check>Check</Button>
            <Button variant="primary" onClick={speichern} disabled={busy || !pruefung?.ok || pruefung.unchanged} data-accounting-opening-date-save>Save</Button>
          </div>
          {pruefung && (
            <div style={{ ...box, marginTop: 12 }} data-accounting-opening-date-result={pruefung.ok ? 'ok' : 'refused'}>
              {pruefung.unchanged ? 'This is already the opening date.'
                : pruefung.ok ? `Possible: ${pruefung.current} → ${neu} (${pruefung.direction === 'earlier' ? 'corrections from the new date on become possible again, unless another lock applies' : 'later'}). Nothing else is changed.`
                : <>Not possible:<ul style={{ margin: '6px 0 0 18px' }}>{pruefung.problems.map((p) => <li key={p}>{p}</li>)}</ul></>}
            </div>
          )}
        </Card>
      )}
      {msg && <div style={{ ...box, color: msg.ok ? '#2F6B3A' : '#7A3535' }} data-accounting-opening-date-msg={msg.ok ? 'ok' : 'error'}>{msg.text}</div>}
    </div>
  );
}

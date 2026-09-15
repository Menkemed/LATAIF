// POST-PARITY R7C R1 — die offenen Speichervorgänge dieses Rechners: sichtbar und klärbar.
//
// Ein Vorgang, dessen Antwort verloren ging, steht hier, bis er beantwortet ist — auch nach
// Maskenwechsel, Neuladen oder Neustart. „Clarify now" wiederholt den URSPRÜNGLICHEN Auftrag unter
// SEINER Kennung: war er schon gespeichert, liefert der Primary das eingefrorene Ergebnis (nichts
// Neues entsteht); war er es nicht, läuft er jetzt genau einmal. Eine neue Kennung entsteht hier nie.
import { useEffect, useState, type CSSProperties } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  ensurePendingLoaded, subscribePending, currentPendingContext, pendingRecords, pendingElsewhereCount,
  pendingProblems, dropPending, type PendingRecord,
} from '@/core/bridge/pending-saves';
import { attemptForPending, describeClarification } from '@/core/bridge/client-command-save';

const label = (op: string): string => op.replace(/[._]/g, ' ');
function when(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : iso;
}
const btn: CSSProperties = {
  border: '1px solid #C9A04A', background: '#FFFFFF', borderRadius: 6, padding: '3px 10px', cursor: 'pointer', fontSize: 12,
};

export function PendingSavesBar() {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [askRemove, setAskRemove] = useState<string | null>(null);

  useEffect(() => {
    const off = subscribePending(() => setTick((t) => t + 1));
    void ensurePendingLoaded().then(() => setTick((t) => t + 1));
    return off;
  }, []);

  const ctx = currentPendingContext();
  const mine = pendingRecords(ctx);
  const elsewhere = pendingElsewhereCount(ctx);
  const { unreadable, loadError } = pendingProblems();
  const noteIds = Object.keys(notes);
  if (!mine.length && !elsewhere && !unreadable.length && !loadError && !noteIds.length) return null;

  async function clarify(r: PendingRecord): Promise<void> {
    setBusy(r.commandId);
    try {
      const out = await attemptForPending(r).send(r.payload);
      setNotes((n) => ({ ...n, [r.commandId]: `${label(r.op)}: ${describeClarification(out)}` }));
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string): Promise<void> {
    setAskRemove(null);
    await dropPending(id);
  }
  function dismissNote(id: string): void {
    setNotes((n) => {
      const rest = { ...n };
      delete rest[id];
      return rest;
    });
  }

  return (
    <div data-testid="pending-saves-bar" role="status" style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 60, width: 440, maxWidth: 'calc(100vw - 32px)',
      background: '#FFF8E6', border: '1px solid #E0B24C', borderRadius: 10, padding: '12px 14px',
      boxShadow: '0 6px 24px rgba(0,0,0,.12)', fontSize: 13, color: '#3A2E12',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, marginBottom: 6 }}>
        <AlertTriangle size={16} /> Unresolved saves
      </div>
      {mine.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          These saves may already be on the main computer. Clarify each one before entering it again —
          clarifying repeats the original under its own number and never saves twice.
        </div>
      )}
      {mine.map((r) => (
        <div key={r.commandId} data-testid="pending-save-row" data-command-id={r.commandId} data-state={r.state}
          style={{ borderTop: '1px solid #EBD9A8', padding: '6px 0' }}>
          <div>
            <b>{label(r.op)}</b> · {when(r.createdAt)} · {r.state === 'conflict' ? 'number held for different content' : 'result unknown'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {r.state !== 'conflict' && (
              <button type="button" style={btn} data-testid="pending-save-clarify" disabled={busy !== null} onClick={() => void clarify(r)}>
                {busy === r.commandId ? 'Clarifying…' : 'Clarify now'}
              </button>
            )}
            {askRemove === r.commandId ? (
              <>
                <span>Remove this reminder? Only after checking the main computer.</span>
                <button type="button" style={btn} data-testid="pending-save-remove-confirm" onClick={() => void remove(r.commandId)}>Remove</button>
                <button type="button" style={btn} onClick={() => setAskRemove(null)}>Keep</button>
              </>
            ) : (
              <button type="button" style={btn} data-testid="pending-save-remove" disabled={busy !== null} onClick={() => setAskRemove(r.commandId)}>
                Remove…
              </button>
            )}
          </div>
        </div>
      ))}
      {noteIds.map((id) => (
        <div key={`n-${id}`} data-testid="pending-save-note" style={{ borderTop: '1px solid #EBD9A8', padding: '6px 0' }}>
          {notes[id]} <button type="button" style={btn} onClick={() => dismissNote(id)}>OK</button>
        </div>
      ))}
      {elsewhere > 0 && (
        <div style={{ borderTop: '1px solid #EBD9A8', padding: '6px 0' }}>
          {elsewhere} unresolved save{elsewhere === 1 ? '' : 's'} belong to another sign-in or main computer — sign in there to clarify {elsewhere === 1 ? 'it' : 'them'}.
        </div>
      )}
      {unreadable.map((id) => (
        <div key={`u-${id}`} style={{ borderTop: '1px solid #EBD9A8', padding: '6px 0' }}>
          A stored save ({id.slice(0, 8)}) could not be read on this computer.{' '}
          <button type="button" style={btn} onClick={() => void dropPending(id)}>Remove</button>
        </div>
      ))}
      {loadError && (
        <div style={{ borderTop: '1px solid #EBD9A8', padding: '6px 0' }}>
          The list of unresolved saves could not be read on this computer: {loadError}
        </div>
      )}
    </div>
  );
}

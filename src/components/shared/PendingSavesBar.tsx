// POST-PARITY R7C R1 — die offenen Speichervorgänge dieses Rechners: sichtbar und klärbar.
//
// Ein Vorgang, dessen Antwort verloren ging, steht hier, bis er beantwortet ist — auch nach
// Maskenwechsel, Neuladen oder Neustart. „Clarify now" fragt nur den durablen Nachweis des Primary und
// führt nichts aus. Kam der Vorgang dort nie an, entscheidet der Mensch: „Save it now" schickt den
// URSPRÜNGLICHEN Auftrag unter SEINER Kennung, „Discard" verwirft ihn. Auch „Remove" fragt zuerst: Ein
// offener Vorgang verschwindet nie still, und kein Entfernen gilt als „erledigt".
import { useEffect, useState, type CSSProperties } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  ensurePendingLoaded, subscribePending, currentPendingContext, pendingRecords, pendingElsewhereCount,
  pendingProblems, dropPending, type PendingRecord,
} from '@/core/bridge/pending-saves';
import { attemptForPending, describeClarification, describeClarify, type ClarifyOutcome } from '@/core/bridge/client-command-save';

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
  // Was die Nachfrage je Vorgang ergab, solange noch eine Entscheidung offen ist.
  const [checked, setChecked] = useState<Record<string, ClarifyOutcome['kind']>>({});

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

  /** Nur fragen. `removing`: Die Frage kam von „Remove…", ein offenes Ergebnis wird dort angesprochen. */
  async function clarify(r: PendingRecord, removing = false): Promise<void> {
    setBusy(r.commandId);
    try {
      const out = await attemptForPending(r).clarify();
      setChecked((c) => ({ ...c, [r.commandId]: out.kind }));
      if (removing && (out.kind === 'not_saved' || out.kind === 'unknown' || out.kind === 'conflict')) setAskRemove(r.commandId);
      if (out.kind !== 'not_saved') setNotes((n) => ({ ...n, [r.commandId]: `${label(r.op)}: ${describeClarify(out)}` }));
    } finally {
      setBusy(null);
    }
  }
  /** Der ausdrückliche Entschluss, den Vorgang, der nie ankam, jetzt einmal auszuführen. */
  async function sendNow(r: PendingRecord): Promise<void> {
    setBusy(r.commandId);
    try {
      const out = await attemptForPending(r).send(r.payload);
      setChecked((c) => { const rest = { ...c }; delete rest[r.commandId]; return rest; });
      setNotes((n) => ({ ...n, [r.commandId]: `${label(r.op)}: ${describeClarification(out)}` }));
    } finally {
      setBusy(null);
    }
  }
  async function remove(r: PendingRecord): Promise<void> {
    const wusste = checked[r.commandId];
    setAskRemove(null);
    await attemptForPending(r).abandon();
    setChecked((c) => { const rest = { ...c }; delete rest[r.commandId]; return rest; });
    setNotes((n) => ({
      ...n,
      [r.commandId]: `${label(r.op)}: reminder removed. ${wusste === 'not_saved'
        ? 'This save was NOT stored on the main computer.'
        : 'It is still NOT known whether this save reached the main computer — check there.'}`,
    }));
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
          clarifying only asks the main computer and changes nothing.
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
            {checked[r.commandId] === 'not_saved' && (
              <>
                <span data-testid="pending-save-not-saved" style={{ flexBasis: '100%' }}>{describeClarify({ kind: 'not_saved' })}</span>
                <button type="button" style={btn} data-testid="pending-save-send" disabled={busy !== null} onClick={() => void sendNow(r)}>Save it now</button>
              </>
            )}
            {askRemove === r.commandId ? (
              <>
                <span>{checked[r.commandId] === 'not_saved'
                  ? 'Discard this save? It will not be stored.'
                  : 'The result is still unknown. Remove the reminder anyway? This does not mark it as done.'}</span>
                <button type="button" style={btn} data-testid="pending-save-remove-confirm" onClick={() => void remove(r)}>
                  {checked[r.commandId] === 'not_saved' ? 'Discard' : 'Remove anyway'}
                </button>
                <button type="button" style={btn} onClick={() => setAskRemove(null)}>Keep</button>
              </>
            ) : (
              <button type="button" style={btn} data-testid="pending-save-remove" disabled={busy !== null} onClick={() => void clarify(r, true)}>
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

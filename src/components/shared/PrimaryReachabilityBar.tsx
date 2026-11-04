// PC2 — der Primary antwortet nicht (oder die Sitzung ist weg): das SAGEN, statt still den alten Stand oder leere
// Listen zu zeigen, als gäbe es nichts. Gespeist von `remoteRead` (jede Lesefrage meldet, ob der Primary geantwortet
// hat); verschwindet, sobald eine Lesefrage wieder eine Antwort bekommt. Am Primary nie angezeigt.
import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { onPrimaryReachability, primaryReachability, type PrimaryReachability } from '@/core/bridge/remote-read';

export function PrimaryReachabilityBar() {
  const [r, setR] = useState<PrimaryReachability>(primaryReachability());
  useEffect(() => onPrimaryReachability(setR), []);
  if (r.state === 'ok') return null;
  const abgemeldet = r.state === 'signed_out';
  return (
    <div data-primary-unreachable={r.state} role="alert" style={{
      position: 'fixed', left: '50%', top: 12, transform: 'translateX(-50%)', zIndex: 61,
      width: 560, maxWidth: 'calc(100vw - 32px)', display: 'flex', alignItems: 'center', gap: 10,
      background: '#FDECEC', border: '1px solid #DC2626', borderRadius: 10, padding: '10px 14px',
      boxShadow: '0 6px 24px rgba(0,0,0,.12)', fontSize: 13, color: '#5A1414',
    }}>
      <WifiOff size={16} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1 }} data-primary-unreachable-text>
        {abgemeldet
          ? 'Signed out from the main computer — sign in again to see current data.'
          : 'The main computer is not answering — what you see may be out of date. A save made now is kept under "Unresolved saves" until it can be checked.'}
      </span>
      <button type="button" onClick={() => window.location.reload()} data-primary-reload style={{
        background: '#FFFFFF', border: '1px solid #DC2626', borderRadius: 6, padding: '5px 10px',
        color: '#5A1414', fontSize: 12, cursor: 'pointer', flexShrink: 0,
      }}>
        {abgemeldet ? 'Sign in' : 'Reload'}
      </button>
    </div>
  );
}

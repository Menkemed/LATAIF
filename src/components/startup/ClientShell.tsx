// CENTRAL-C2 — die Oberfläche des zweiten Rechners VOR der Anmeldung.
//
// Seit der UI-Parität führt sie nur noch zum Server und meldet an; danach läuft DIESELBE Anwendung
// wie am Primary. Es gibt hier keine Liste, kein Formular und keinen Schreibweg.
//
// POST-PARITY R7B PP-7 — bis hierher stand darunter die alte, schmale Client-Oberfläche (Listen,
// Detailansichten, eigene Formulare in `components/client/`). Erreichbar war sie nur noch, wenn ein
// Ausweis vorlag, aus dem keine Sitzung entstand — und genau diesen Zustand gibt es seit PP-5 nicht
// mehr: ein unbrauchbarer Ausweis wird verworfen, und es geht hierher zurück. Sie ist entfernt.
//
// Und es gibt keinen stillen Rückfall. Ist der Server weg, steht das da. Es wird keine lokale
// Datenbank angelegt, um „wenigstens etwas" zu zeigen — das wäre eine zweite Wahrheit.

import { useState } from 'react';
import { clientConfig, leaveClientMode } from '@/core/bridge/client-mode';
import { clientLogin, RemoteReadError } from '@/core/bridge/remote-read';

/**
 * `onSignedIn` baut aus dem frischen Ausweis die Sitzung und meldet, ob das gelang. Gelingt es
 * nicht, ist der Ausweis dort bereits verworfen — hier steht dann ein Satz statt einer halben App.
 */
export function ClientShell({ onSignedIn }: { onSignedIn?: () => boolean } = {}) {
  const cfg = clientConfig();
  if (!cfg) {
    return <Frame><p>No server is configured for this client.</p></Frame>;
  }
  return <SignIn serverUrl={cfg.serverUrl} onDone={() => (onSignedIn ? onSignedIn() : true)} />;
}

function SignIn({ serverUrl, onDone }: { serverUrl: string; onDone: () => boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Frame>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Connected to {serverUrl}</h2>
      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 14 }}>
        This machine has no database of its own. Sign in to read from the server.
      </p>
      <input data-client-email type="email" placeholder="you@company.com" value={email}
        onChange={(e) => setEmail(e.target.value)} style={field} />
      <input data-client-password type="password" placeholder="Password" value={password}
        onChange={(e) => setPassword(e.target.value)} style={field} />
      {error && <p data-client-error style={{ color: '#B91C1C', fontSize: 12 }}>{error}</p>}
      <button data-client-signin disabled={busy} style={{ ...chip(true), marginTop: 8 }}
        onClick={async () => {
          setBusy(true); setError(null);
          try {
            await clientLogin(email, password);
            if (!onDone()) setError('The server issued a sign-in this computer cannot use. Please sign in again.');
          } catch (e) {
            const err = e as RemoteReadError;
            setError(err.code === 'SERVER_UNAVAILABLE' ? 'Server unavailable' : 'Wrong e-mail or password');
          } finally { setBusy(false); }
        }}>Sign in</button>
      <button data-client-disconnect style={{ ...chip(false), marginTop: 8, marginLeft: 8 }}
        onClick={() => { leaveClientMode(); window.location.reload(); }}>Disconnect</button>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div data-client-shell style={{ padding: 28, maxWidth: 1100, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      {children}
    </div>
  );
}

const field: React.CSSProperties = {
  display: 'block', width: 280, padding: '8px 10px', marginBottom: 8,
  borderRadius: 8, border: '1px solid #D5D9DE', fontSize: 13,
};

function chip(active: boolean): React.CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
    color: active ? '#0F0F10' : '#6B7280',
    background: active ? 'rgba(15,15,16,0.06)' : '#FFFFFF',
  };
}

// DATA-ROOT-B1a — die Weiche, die ein leerer Start sieht.
//
// Zwei Wege, keiner davon vorausgewaehlt, und bis zum Klick veraendert sich nichts: kein
// Verzeichnis, keine Kennung, keine Datenbank. Wer das Fenster schliesst, hat nichts angefasst.

import { useState } from 'react';
import { setUpNewInstallation } from '@/core/lifecycle/first-run';
import { approveRelaunch } from '@/core/lifecycle/relaunch-coordinator';

export function FirstRunGate() {
  const [busy, setBusy] = useState<'new' | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setUpNew() {
    // Ein Klick, eine Installation — der Kern haelt dieselbe Regel noch einmal, unabhaengig davon,
    // was der Bildschirm tut.
    if (busy) return;
    setBusy('new');
    setError(null);
    try {
      await setUpNewInstallation();
      // Hier gibt es nichts zu leeren: kein Server, keine Datenbank, kein Schreiber. Der Neustart
      // ist die Uebergabe an einen gewoehnlichen Start, der die frisch angelegte Wurzel oeffnet.
      approveRelaunch();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0F0F10', color: '#FFFFFF', padding: 24,
    }}>
      <div style={{ maxWidth: 560, width: '100%' }} data-first-run-gate>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 8 }}>Welcome to LATAIF</h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#B9BDC4', marginBottom: 24 }}>
          This computer has no LATAIF data yet. Nothing has been created — choose how to continue.
        </p>

        {!recovering ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <button
              data-first-run-new
              onClick={setUpNew}
              disabled={busy !== null}
              style={{
                textAlign: 'left', padding: '16px 18px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
                background: '#1B1C1F', border: '1px solid #2C2E33', color: '#FFFFFF',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                {busy === 'new' ? 'Setting up…' : 'Set up new installation'}
              </div>
              <div style={{ fontSize: 13, color: '#B9BDC4', marginTop: 4 }}>
                Start with an empty database on this computer.
              </div>
            </button>

            <button
              data-first-run-recover
              onClick={() => { setRecovering(true); setError(null); }}
              disabled={busy !== null}
              style={{
                textAlign: 'left', padding: '16px 18px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
                background: '#1B1C1F', border: '1px solid #2C2E33', color: '#FFFFFF',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600 }}>Recover existing data location</div>
              <div style={{ fontSize: 13, color: '#B9BDC4', marginTop: 4 }}>
                Your data is already on this machine or on another drive — point LATAIF at it.
              </div>
            </button>
          </div>
        ) : (
          // Der Wiederherstellungsweg selbst kommt als eigener Schritt. Bis dahin sagt dieser
          // Bildschirm genau das — und faengt ausdruecklich nichts an: keine Suche, keine Auswahl,
          // keine Adoption. Zurueck fuehrt zur Weiche, und auch dann ist nichts geschehen.
          <div data-first-run-recover-panel style={{
            padding: '18px 20px', borderRadius: 10, background: '#1B1C1F', border: '1px solid #2C2E33',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Recover existing data location</div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: '#B9BDC4', marginBottom: 16 }}>
              Choosing an existing data folder is not available in this build yet. Nothing has been
              created or changed on this computer, and closing the window leaves it that way.
            </p>
            <button
              data-first-run-back
              onClick={() => setRecovering(false)}
              style={{
                padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                background: 'transparent', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13,
              }}
            >Back</button>
          </div>
        )}

        {error && (
          <div data-first-run-error style={{ marginTop: 16, fontSize: 13, color: '#E88' }}>{error}</div>
        )}
      </div>
    </div>
  );
}

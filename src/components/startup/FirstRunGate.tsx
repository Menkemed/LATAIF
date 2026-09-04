// DATA-ROOT-B1a — die Weiche, die ein leerer Start sieht.
//
// Zwei Wege, keiner davon vorausgewaehlt, und bis zum Klick veraendert sich nichts: kein
// Verzeichnis, keine Kennung, keine Datenbank. Wer das Fenster schliesst, hat nichts angefasst.

import { useState } from 'react';
import {
  setUpNewInstallation, validateCandidate, adoptDataLocation, type CandidateFacts,
} from '@/core/lifecycle/first-run';
import { approveRelaunch } from '@/core/lifecycle/relaunch-coordinator';
// CENTRAL-C2 — der dritte Weg: dieser Rechner wird eine Oberflaeche an einem anderen Server und
// legt hier NICHTS an; gemerkt wird nur die Adresse.
import { enterClientMode } from '@/core/bridge/client-mode';

/** Aus einem Fehlercode einen Satz machen, den jemand lesen kann, der seine Daten sucht. */
function explain(e: unknown): string {
  const code = e instanceof Error ? e.message : String(e);
  const map: Record<string, string> = {
    ADOPT_NOT_A_DIRECTORY: 'That folder does not exist any more.',
    ADOPT_OVERLAPS_CONTROL_DIRECTORY: 'That folder belongs to the program itself, not to your data.',
    ADOPT_MARKER_MISSING: 'This is not a LATAIF data folder — it has no data-set marker.',
    ADOPT_MARKER_UNUSABLE: 'The data-set marker in this folder cannot be read.',
    ADOPT_BUSINESS_DB_MISSING: 'The database file is missing from this folder.',
    ADOPT_BUSINESS_DB_UNREADABLE: 'The database file in this folder cannot be opened.',
    ADOPT_BUSINESS_DB_INCONSISTENT: 'The database in this folder is damaged — LATAIF will not open it.',
    ADOPT_BUSINESS_DB_NOT_LATAIF: 'That database does not belong to LATAIF.',
    ADOPT_SERVER_DB_MISSING: 'The server database is missing from this folder.',
    ADOPT_SERVER_DB_UNUSABLE: 'The server database in this folder cannot be used.',
    ADOPT_INSTALL_ID_UNUSABLE: 'This folder has no usable installation identity.',
    ADOPT_IDENTITY_MISMATCH: 'The parts of this folder belong to different installations.',
    ADOPT_MEDIA_NOT_A_DIRECTORY: 'The photo folder inside is not a folder.',
    FIRST_RUN_SETUP_ALREADY_RUNNING: 'Already working on it.',
  };
  if (map[code]) return map[code];
  if (code.startsWith('ADOPT_MAINTENANCE_PENDING:')) {
    return 'This folder has an unfinished maintenance operation in it. Finish it on the original computer first.';
  }
  if (code.startsWith('ADOPT_OWNER_REJECTED')) return 'That is not the owner of this data set.';
  if (code === 'ADOPT_LOCATOR_WRITE_FAILED') return 'The location could not be saved on this computer.';
  return code;
}

export function FirstRunGate() {
  const [busy, setBusy] = useState<'new' | 'adopt' | null>(null);
  const [recovering, setRecovering] = useState(false);
  // CENTRAL-C2 — der dritte Weg: dieser Rechner wird eine Oberflaeche an einem anderen Server.
  const [connecting, setConnecting] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<CandidateFacts | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  /** Der Benutzer zeigt selbst auf den Ordner — es wird nichts gesucht und nichts geraten. */
  async function pickFolder() {
    setError(null);
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: 'Choose your LATAIF data folder' });
    if (typeof picked !== 'string' || !picked) return;
    try {
      // Nur ansehen. Was hier zurueckkommt, ist eine Auskunft, keine Erlaubnis.
      setCandidate(await validateCandidate(picked));
    } catch (e) {
      setCandidate(null);
      setError(explain(e));
    }
  }

  /** Uebernehmen — der Kern prueft alles selbst noch einmal und verlangt den Eigentuemer. */
  async function adopt() {
    if (busy || !candidate) return;
    setBusy('adopt');
    setError(null);
    try {
      await adoptDataLocation(candidate.path, email, password);
      approveRelaunch();
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      setError(explain(e));
      setBusy(null);
    }
  }

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
            <button
              data-first-run-connect
              onClick={() => { setConnecting(true); setError(null); }}
              disabled={busy !== null}
              style={{
                textAlign: 'left', padding: '16px 18px', borderRadius: 10, cursor: busy ? 'default' : 'pointer',
                background: '#1B1C1F', border: '1px solid #2C2E33', color: '#FFFFFF',
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600 }}>Connect to existing LATAIF server</div>
              <div style={{ fontSize: 13, color: '#B9BDC4', marginTop: 4 }}>
                This computer becomes a second screen. It keeps no data of its own and reads from
                the machine that has it.
              </div>
            </button>
          </div>
        ) : connecting ? (
          // CENTRAL-C2 — der dritte Weg. Er legt NICHTS an: kein Datenort, keine Datenbank, keine
          // Kennung. Gespeichert wird nur die Adresse, damit dieser Rechner beim naechsten Start
          // weiss, wen er fragen soll. Alles Fachliche kommt von dort.
          <div data-first-run-connect-panel style={{
            padding: '18px 20px', borderRadius: 10, background: '#1B1C1F', border: '1px solid #2C2E33',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Connect to existing LATAIF server</div>
            <p style={{ fontSize: 13, color: '#B9BDC4', marginBottom: 12 }}>
              Enter the address of the computer that holds the data, for example
              {' '}<code>192.168.1.5:3001</code>. Nothing is created on this machine.
            </p>
            <input
              data-first-run-server
              placeholder="192.168.1.5:3001"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 8, marginBottom: 10,
                background: '#0F0F10', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13,
              }}
            />
            {error && <p style={{ color: '#FCA5A5', fontSize: 13, marginBottom: 10 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                data-first-run-connect-go
                disabled={serverUrl.trim().length === 0}
                onClick={() => {
                  try {
                    enterClientMode(serverUrl);
                    window.location.reload();
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                style={{
                  padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
                  background: '#FFFFFF', border: 'none', color: '#0F0F10', fontSize: 13, fontWeight: 600,
                }}
              >Connect</button>
              <button
                data-first-run-connect-back
                onClick={() => { setConnecting(false); setError(null); }}
                style={{
                  padding: '10px 16px', borderRadius: 8, cursor: 'pointer',
                  background: 'transparent', border: '1px solid #2C2E33', color: '#B9BDC4', fontSize: 13,
                }}
              >Back</button>
            </div>
          </div>
        ) : (
          // Der Wiederherstellungsweg. Nichts wird gesucht: der Benutzer zeigt selbst auf den
          // Ordner. Ansehen veraendert nichts; erst die Uebernahme mit der Anmeldung des
          // Eigentuemers schreibt eine einzige Datei — den Locator auf diesem Rechner.
          <div data-first-run-recover-panel style={{
            padding: '18px 20px', borderRadius: 10, background: '#1B1C1F', border: '1px solid #2C2E33',
          }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Recover existing data location</div>
            <p style={{ fontSize: 13, lineHeight: 1.6, color: '#B9BDC4', marginBottom: 16 }}>
              Choose the folder your LATAIF data is in — for example <code>E:\LATAIF\Data</code>.
              It is only read; nothing is copied and nothing on this computer changes until you
              confirm as the owner.
            </p>

            <button
              data-first-run-pick
              onClick={pickFolder}
              disabled={busy !== null}
              style={{
                padding: '10px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                background: '#24262B', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13,
              }}
            >{candidate ? 'Choose a different folder…' : 'Choose folder…'}</button>

            {candidate && (
              <div data-first-run-candidate style={{ marginTop: 14, fontSize: 13, color: '#B9BDC4' }}>
                <div style={{ color: '#FFFFFF', wordBreak: 'break-all' }}>{candidate.path}</div>
                <div style={{ marginTop: 4 }}>
                  Data set {candidate.rootId.slice(0, 8)}… · {candidate.hasMedia ? 'with photos' : 'no photos yet'}
                </div>
                <div style={{ display: 'grid', gap: 8, marginTop: 14, maxWidth: 320 }}>
                  <input
                    data-first-run-owner-email
                    placeholder="Owner e-mail"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: 8, background: '#0F0F10', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13 }}
                  />
                  <input
                    data-first-run-owner-password
                    type="password"
                    placeholder="Owner password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{ padding: '10px 12px', borderRadius: 8, background: '#0F0F10', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13 }}
                  />
                  <button
                    data-first-run-adopt
                    onClick={adopt}
                    disabled={busy !== null || !email || !password}
                    style={{
                      padding: '10px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                      background: '#1F6F43', border: '1px solid #2C7A4E', color: '#FFFFFF', fontSize: 13, fontWeight: 600,
                    }}
                  >{busy === 'adopt' ? 'Recovering…' : 'Use this data location'}</button>
                </div>
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <button
                data-first-run-back
                onClick={() => { setRecovering(false); setCandidate(null); setError(null); }}
                disabled={busy !== null}
                style={{
                  padding: '10px 14px', borderRadius: 8, cursor: busy ? 'default' : 'pointer',
                  background: 'transparent', border: '1px solid #2C2E33', color: '#FFFFFF', fontSize: 13,
                }}
              >Back</button>
            </div>
          </div>
        )}

        {error && (
          <div data-first-run-error style={{ marginTop: 16, fontSize: 13, color: '#E88' }}>{error}</div>
        )}
      </div>
    </div>
  );
}

// Plan §Auto-Update — prüft beim App-Start (und bei manuellem Klick) ob ein neuer
// LATAIF-Build verfügbar ist. Zeigt unauffälliges Banner; User entscheidet wann installieren.
import { useEffect, useRef, useState } from 'react';
import { Download, X, RefreshCw, CheckCircle2 } from 'lucide-react';
import { saveDatabaseDurably } from '@/core/db/database';
import { prepareAndInstallUpdate, createSingleFlight } from '@/core/updater/update-orchestration';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string; date?: string }
  | { kind: 'saving' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'installing' }
  | { kind: 'error'; message: string }
  | { kind: 'up-to-date' };

function isTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);
  const [starting, setStarting] = useState(false); // schnelle UI-Sperre gegen Doppelklick
  // Single-Flight-Barriere aus dem produktiven Helper — einmal erzeugen (stabil ueber Renders).
  const installRef = useRef<(() => Promise<void>) | null>(null);

  async function checkForUpdate(manual = false) {
    if (!isTauri()) {
      if (manual) setState({ kind: 'error', message: 'Updater only available in the desktop app.' });
      return;
    }
    setState({ kind: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (update) {
        setState({
          kind: 'available',
          version: update.version,
          notes: update.body,
          date: update.date,
        });
        setDismissed(false);
      } else if (manual) {
        setState({ kind: 'up-to-date' });
        setTimeout(() => setState({ kind: 'idle' }), 4000);
      } else {
        setState({ kind: 'idle' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[Updater] check failed:', msg);
      if (manual) setState({ kind: 'error', message: msg });
      else setState({ kind: 'idle' }); // silent fail beim Auto-Check
    }
  }

  // M3 — Ein Update-Durchlauf: erst DURABEL speichern, dann herunterladen+installieren, dann
  // relaunchen (prepareAndInstallUpdate erzwingt genau diese Reihenfolge). Der durable Save
  // laeuft VOR downloadAndInstall, weil der NSIS-Installer die laufende .exe ersetzt und
  // relaunch() den Prozess beendet — pending In-Memory-Aenderungen (z.B. gerade gesyncte
  // Uploads) waeren sonst fuer immer verloren.
  async function installOnce() {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) {
      setState({ kind: 'up-to-date' });
      setTimeout(() => setState({ kind: 'idle' }), 4000);
      return;
    }

    let downloaded = 0;
    let total = 0;
    await prepareAndInstallUpdate({
      // 1. Aktuellen DB-Stand durabel schreiben; wirft bei Persist-Fehler ODER aktiver
      //    Ambient-Transaktion → kein Download, kein Relaunch, Stand bleibt sicher.
      durableSave: saveDatabaseDurably,
      // 2. Erst NACH bestaetigtem Save: herunterladen + installieren, Progress live anzeigen.
      downloadAndInstall: () =>
        update.downloadAndInstall((event) => {
          if (event.event === 'Started') {
            total = event.data.contentLength || 0;
          } else if (event.event === 'Progress') {
            downloaded += event.data.chunkLength;
            const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
            setState({ kind: 'downloading', progress: pct });
          } else if (event.event === 'Finished') {
            setState({ kind: 'installing' });
          }
        }),
      // 3. Nur nach erfolgreicher Installation: App neustarten.
      relaunch: async () => {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      },
      onPhase: (phase) => {
        if (phase.kind === 'saving') setState({ kind: 'saving' });
        else if (phase.kind === 'downloading') setState({ kind: 'downloading', progress: 0 });
        else if (phase.kind === 'relaunching') setState({ kind: 'installing' });
      },
    });
  }

  async function installUpdate() {
    if (!isTauri()) return;
    if (starting) return; // schnelle UI-Sperre gegen Doppelklick vor dem ersten State-Wechsel
    setStarting(true);
    // Single-Flight-Barriere (produktiver Helper) einmalig binden → zweiter Klick startet
    // keine zweite Kette, sondern haengt sich an denselben laufenden Durchlauf.
    if (!installRef.current) installRef.current = createSingleFlight(installOnce);
    try {
      await installRef.current();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message: msg });
    } finally {
      setStarting(false);
    }
  }

  // Auto-Check beim App-Start (5s Verzögerung damit die DB-Init vorher fertig ist)
  useEffect(() => {
    const t = setTimeout(() => checkForUpdate(false), 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v0.4.5 — Manueller Check aus Settings → Updates feuert dieses Event. So
  // erscheint das Banner sofort, ohne App-Neustart (vorher hatte der Settings-
  // Check einen eigenen, vom Banner getrennten State).
  useEffect(() => {
    const handler = () => checkForUpdate(true);
    window.addEventListener('lataif:check-update', handler);
    return () => window.removeEventListener('lataif:check-update', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sichtbar nur wenn relevant + nicht dismissed
  const visible = !dismissed && (
    state.kind === 'available' ||
    state.kind === 'saving' ||
    state.kind === 'downloading' ||
    state.kind === 'installing' ||
    state.kind === 'error' ||
    state.kind === 'up-to-date'
  );
  if (!visible) return null;

  const styles: React.CSSProperties = {
    position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
    background: '#1A1A1F', color: '#FFFFFF',
    border: '1px solid #2A2A30', borderRadius: 12,
    padding: '14px 18px', minWidth: 320, maxWidth: 420,
    boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
    display: 'flex', alignItems: 'center', gap: 12,
  };

  if (state.kind === 'available') {
    return (
      <div style={styles} role="status">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#C6A36D' }}>
            Update available — v{state.version}
          </div>
          <div style={{ fontSize: 11, color: '#8E8E97', marginTop: 4 }}>
            {state.notes ? state.notes.slice(0, 100) : 'Neue LATAIF-Version bereit zum Installieren.'}
          </div>
        </div>
        <button onClick={installUpdate} disabled={starting}
          className="cursor-pointer"
          style={{ padding: '8px 14px', background: '#C6A36D', color: '#1A1A1F',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600,
            opacity: starting ? 0.6 : 1, cursor: starting ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 6 }}>
          <Download size={12} /> Install
        </button>
        <button onClick={() => setDismissed(true)}
          className="cursor-pointer"
          style={{ padding: 6, background: 'transparent', border: 'none', color: '#8E8E97' }}
          title="Remind later">
          <X size={14} />
        </button>
      </div>
    );
  }

  if (state.kind === 'saving') {
    return (
      <div style={styles} role="status">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#C6A36D' }} />
        <div style={{ flex: 1, fontSize: 13 }}>Daten werden gesichert…</div>
      </div>
    );
  }

  if (state.kind === 'downloading') {
    return (
      <div style={styles} role="status">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#C6A36D' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: '#FFFFFF' }}>Update wird heruntergeladen…</div>
          <div style={{ marginTop: 6, height: 4, background: '#2A2A30', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${state.progress}%`, background: '#C6A36D', transition: 'width 0.2s' }} />
          </div>
          <div className="font-mono" style={{ fontSize: 10, color: '#8E8E97', marginTop: 3 }}>{state.progress}%</div>
        </div>
      </div>
    );
  }

  if (state.kind === 'installing') {
    return (
      <div style={styles} role="status">
        <RefreshCw size={16} className="animate-spin" style={{ color: '#C6A36D' }} />
        <div style={{ flex: 1, fontSize: 13 }}>Wird installiert — App startet gleich neu.</div>
      </div>
    );
  }

  if (state.kind === 'up-to-date') {
    return (
      <div style={styles} role="status">
        <CheckCircle2 size={16} style={{ color: '#7EAA6E' }} />
        <div style={{ flex: 1, fontSize: 13 }}>LATAIF ist auf dem neuesten Stand.</div>
        <button onClick={() => setDismissed(true)}
          className="cursor-pointer"
          style={{ padding: 4, background: 'transparent', border: 'none', color: '#8E8E97' }}>
          <X size={12} />
        </button>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div style={{ ...styles, borderColor: 'rgba(220,38,38,0.4)' }} role="status">
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, color: '#DC2626', fontWeight: 600 }}>Update-Fehler</div>
          <div style={{ fontSize: 11, color: '#8E8E97', marginTop: 4 }}>{state.message.slice(0, 200)}</div>
        </div>
        <button onClick={() => setDismissed(true)}
          className="cursor-pointer"
          style={{ padding: 4, background: 'transparent', border: 'none', color: '#8E8E97' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  return null;
}

// Hook + Button-Variante für Settings-Page (manueller Check)
export function useUpdateChecker() {
  return async () => {
    if (!isTauri()) return { ok: false, message: 'Only available in desktop.' };
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      return { ok: true, available: !!update, version: update?.version };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  };
}

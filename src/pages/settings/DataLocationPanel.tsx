// ════════════════════════════════════════════════════════════════════════════
// DATA-ROOT-I1 / B2 — Settings → Storage → Data Location.
//
// Shows where the data actually lives, where backups go (a separate setting, never changed from
// here), and offers the move. The move itself is three deliberate steps — choose, preflight,
// confirm — because it is the one action in the app that relocates every byte the business owns.
//
// What the panel promises the owner, in the panel itself and not in a manual:
//   • the app will restart,
//   • the data is COPIED and verified before anything switches over,
//   • the old folder is kept, not deleted.
//
// The password lives in local state only and is wiped on success, on failure and on unmount.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type CSSProperties } from 'react';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/stores/authStore';
import { getRuntimePaths, type RuntimePaths } from '@/core/runtime/runtime-paths';
import {
  pendingDataRootMove,
  pickDataFolder,
  preflightDataRootMove,
  startDataRootMove,
  type MovePlan,
  type PendingMove,
} from '@/core/lifecycle/data-root-move';
import { formatBytes } from './backup-restore-panel-logic';
import { canConfirmMove, sanitizeMoveError } from './data-location-panel-logic';

const primaryBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #715DE3', background: '#715DE3', color: '#fff', cursor: 'pointer' };
const ghostBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #E5E9EE', background: '#fff', cursor: 'pointer' };
const label: CSSProperties = { fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.4 };
const pathStyle: CSSProperties = { fontSize: 12, fontFamily: 'monospace', color: '#0F0F10', wordBreak: 'break-all' };

export function DataLocationPanel() {
  const sessionEmail = useAuthStore((s) => (s.session?.user as { email?: string } | undefined)?.email) ?? '';
  const [paths, setPaths] = useState<RuntimePaths | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);
  const [email, setEmail] = useState(sessionEmail);
  const [password, setPassword] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => setPassword(''), []);
  useEffect(() => { getRuntimePaths().then(setPaths).catch(() => setPaths(null)); }, []);
  useEffect(() => { pendingDataRootMove().then(setPending).catch(() => setPending(null)); }, []);

  const choose = async () => {
    setError(null); setMsg(null); setPlan(null);
    const picked = await pickDataFolder(paths?.dataRoot);
    if (picked) setTarget(picked);
  };

  const runPreflight = async () => {
    if (busy || !target) return;
    setBusy(true); setError(null); setMsg(null); setPlan(null);
    try {
      setPlan(await preflightDataRootMove({ email, password, target }));
    } catch (e) {
      setError(sanitizeMoveError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    // The guard is checked again here, not only on the button: a second click that arrives while the
    // first is still awaiting must not start a second move.
    if (!canConfirmMove({ email, password, target, planned: !!plan, busy, pending: !!pending })) return;
    setBusy(true); setError(null);
    setMsg('Preparing the move — the app will restart.');
    try {
      await startDataRootMove({ email, password }, target!, () => {});
      // On success the process relaunches; anything after this line is the failure path.
      setMsg('Restarting…');
    } catch (e) {
      setError(sanitizeMoveError(e));
      setMsg(null);
      setBusy(false);
      setPassword('');
    }
  };

  return (
    <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid #E5E9EE' }} data-testid="data-location-panel">
      <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 4 }}>Data Location</h4>
      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
        Where the databases and images are stored. Moving copies everything, verifies the copy, and only
        then switches over — the previous folder is kept, never deleted.
      </p>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <div style={label}>Current data location</div>
          <div style={pathStyle} data-testid="dl-current">{paths?.dataRoot ?? '…'}</div>
        </div>
        <div>
          <div style={label}>Backup location</div>
          <div style={pathStyle} data-testid="dl-backups">{paths?.backupsRoot ?? '…'}</div>
        </div>
      </div>

      {pending && (
        <p style={{ fontSize: 12, color: '#B54708', marginBottom: 12 }} data-testid="dl-pending">
          A move to {pending.targetRoot} is scheduled. Restart the app to complete it.
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ minWidth: 220 }}>
          <div style={label}>Owner email</div>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} data-testid="dl-email" />
        </div>
        <div style={{ minWidth: 220 }}>
          <div style={label}>Owner password</div>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="dl-password" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button style={ghostBtn} onClick={() => void choose()} disabled={busy} data-testid="dl-choose">
          Choose new folder…
        </button>
        <button style={ghostBtn} onClick={() => void runPreflight()} disabled={busy || !target} data-testid="dl-check">
          Check
        </button>
        {target && <span style={pathStyle} data-testid="dl-target">{target}</span>}
      </div>

      {plan && (
        <div style={{ marginTop: 12, padding: 12, border: '1px solid #E5E9EE', borderRadius: 8 }} data-testid="dl-plan">
          <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 6 }}>
            {plan.fileCount} files · needs {formatBytes(plan.requiredBytes)} · {formatBytes(plan.freeBytes)} free at the destination
          </div>
          <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 10 }}>
            <strong>From</strong> <span style={pathStyle}>{plan.sourceRoot}</span><br />
            <strong>To</strong> <span style={pathStyle}>{plan.targetRoot}</span>
          </div>
          <p style={{ fontSize: 12, color: '#B54708', marginBottom: 10 }}>
            The app will restart to complete the move. Your existing data stays at the old location and is
            not deleted.
          </p>
          <button
            style={primaryBtn}
            onClick={() => void confirm()}
            disabled={!canConfirmMove({ email, password, target, planned: !!plan, busy, pending: !!pending })}
            data-testid="dl-confirm"
          >
            Move data and restart
          </button>
        </div>
      )}

      {msg && <p style={{ fontSize: 12, color: '#4B5563', marginTop: 10 }} data-testid="dl-msg">{msg}</p>}
      {error && <p style={{ fontSize: 12, color: '#B42318', marginTop: 10 }} data-testid="dl-error">{error}</p>}
    </div>
  );
}

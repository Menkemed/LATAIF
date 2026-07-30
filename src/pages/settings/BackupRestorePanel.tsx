// ════════════════════════════════════════════════════════════════════════════
// MOBILE-04B2A12-U2 — Settings → Backup & Restore (full DB + media).
//
// Owner-gated end to end. CREATE makes a consistent DB+media snapshot; RESTORE lists the safe complete
// snapshots (opaque ids only), then — behind an explicit warning + owner-password re-entry + confirmation —
// starts the existing restore orchestrator: it durably schedules the restore and relaunches; the swap runs
// at the next boot while the DBs are closed. Secrets live only in local state and are cleared on cancel,
// error, and unmount. No path/hash/internal error detail ever reaches the DOM (see sanitizeBackupError).
// Every in-flight action takes a lock so backup/restore can't be double-fired.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type CSSProperties } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/stores/authStore';
import {
  scheduleBackupSnapshot,
  listRestoreSnapshots,
  startRestore,
  type SnapshotSummary,
} from '@/core/lifecycle/restore-wiring';
import {
  sanitizeBackupError,
  formatBytes,
  formatCreatedAt,
  canRunOwnerAction,
  canConfirmRestore,
} from './backup-restore-panel-logic';

const primaryBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #715DE3', background: '#715DE3', color: '#fff', cursor: 'pointer' };
const ghostBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #E5E9EE', background: '#fff', cursor: 'pointer' };
const dangerBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #B42318', background: '#B42318', color: '#fff', cursor: 'pointer' };
const cell: CSSProperties = { fontSize: 12, color: '#4B5563' };

export function BackupRestorePanel() {
  const sessionEmail = useAuthStore((s) => (s.session?.user as { email?: string } | undefined)?.email) ?? '';
  const [email, setEmail] = useState(sessionEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmPw, setConfirmPw] = useState('');
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPw, setBackupPw] = useState('');

  // Secret hygiene: never leave a password in memory when the panel unmounts.
  useEffect(() => () => { setPassword(''); setConfirmPw(''); setBackupPw(''); }, []);

  const cancelBackup = () => { setBackupOpen(false); setBackupPw(''); };

  const doScheduleBackup = async () => {
    if (!canRunOwnerAction(email, backupPw, busy)) return;
    setBusy(true); setError(null);
    try {
      // Schedules a durable backup intent + relaunches; the snapshot runs at BOOT (DBs closed). On success
      // the process relaunches (this never resolves). A wrong owner throws BEFORE the intent → app usable.
      await scheduleBackupSnapshot({ email: email.trim(), password: backupPw });
    } catch (e) {
      setBackupPw(''); setError(sanitizeBackupError(e)); setBusy(false); setBackupOpen(false);
    }
  };

  const doLoad = async () => {
    if (!canRunOwnerAction(email, password, busy)) return;
    setBusy(true); setError(null);
    try {
      const list = await listRestoreSnapshots({ email: email.trim(), password });
      setSnapshots(list);
      setPassword('');
    } catch (e) {
      setPassword(''); setError(sanitizeBackupError(e));
    } finally { setBusy(false); }
  };

  const cancelConfirm = () => { setConfirmId(null); setConfirmPw(''); };

  const doConfirmRestore = async () => {
    if (!canConfirmRestore(confirmId, confirmPw, busy)) return;
    setBusy(true); setError(null);
    try {
      // Starts the orchestrator: quiesce → durably SCHEDULE the restore → relaunch. On success the process
      // relaunches (this promise never resolves). On failure the writers stay blocked (fail-closed).
      await startRestore({ snapshotId: confirmId!, email: email.trim(), password: confirmPw });
    } catch (e) {
      setConfirmPw(''); setError(sanitizeBackupError(e)); setBusy(false);
      // NB: do NOT resume here — a failed restore keeps the app blocked/fail-closed until a manual restart.
    }
  };

  return (
    <div data-testid="brp-root" style={{ marginTop: 24 }}>
      <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 4 }}>Full Backup &amp; Restore (Database + Media)</h4>
      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12 }}>
        Owner action. Create a consistent snapshot of the database and all media, or restore a previous
        snapshot. Restoring replaces all current data and restarts the app.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, maxWidth: 520 }}>
        <Input label="OWNER EMAIL" data-testid="brp-owner-email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        <Input label="OWNER PASSWORD" data-testid="brp-owner-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button data-testid="brp-create" onClick={() => { setBackupOpen(true); setBackupPw(''); setError(null); }} disabled={busy} style={primaryBtn}>
          Create backup…
        </button>
        <button data-testid="brp-load" onClick={doLoad} disabled={!canRunOwnerAction(email, password, busy)} style={ghostBtn}>
          Load snapshots
        </button>
      </div>

      {error && <div data-testid="brp-error" style={{ color: '#B42318', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      <Modal open={backupOpen} onClose={cancelBackup} title="Create backup" width={520}>
        <div data-testid="brp-backup-modal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div data-testid="brp-backup-warning" style={{ background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8, padding: 12, fontSize: 13, color: '#9A3412' }}>
            The app will <b>restart</b> to create a consistent snapshot of the database and all media (the
            backup runs at the next boot while the databases are closed). Your data is not changed.
          </div>
          <Input label="RE-ENTER OWNER PASSWORD" data-testid="brp-backup-pw" type="password" value={backupPw} onChange={(e) => setBackupPw(e.target.value)} autoComplete="off" />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button data-testid="brp-backup-cancel" onClick={cancelBackup} disabled={busy} style={ghostBtn}>Cancel</button>
            <button data-testid="brp-backup-confirm" onClick={doScheduleBackup} disabled={!canRunOwnerAction(email, backupPw, busy)} style={primaryBtn}>
              {busy ? 'Scheduling…' : 'Restart & back up'}
            </button>
          </div>
        </div>
      </Modal>

      {snapshots && (
        <div data-testid="brp-list" style={{ border: '1px solid #E5E9EE', borderRadius: 8, overflow: 'hidden' }}>
          {snapshots.length === 0 && <div style={{ padding: 12, fontSize: 13, color: '#6B7280' }}>No snapshots yet.</div>}
          {snapshots.map((s) => (
            <div key={s.snapshotId} data-testid="brp-row" data-snapshot-id={s.snapshotId}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderTop: '1px solid #F1F3F5' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, color: '#0F0F10' }}>{formatCreatedAt(s.createdAt)} · v{s.appVersion}</div>
                <div style={cell}>{formatBytes(s.dbSizeBytes + s.mediaSizeBytes)} · {s.mediaFileCount} media · complete</div>
              </div>
              <button data-testid="brp-restore" data-snapshot-id={s.snapshotId}
                onClick={() => { setConfirmId(s.snapshotId); setConfirmPw(''); setError(null); }}
                disabled={busy} style={dangerBtn}>Restore</button>
            </div>
          ))}
        </div>
      )}

      <Modal open={confirmId !== null} onClose={cancelConfirm} title="Restore backup" width={520}>
        <div data-testid="brp-confirm-modal" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div data-testid="brp-confirm-warning" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', borderRadius: 8, padding: 12, fontSize: 13, color: '#991B1B' }}>
            <b>This replaces ALL current data</b> with the selected backup. The app will restart and the
            restore runs at the next boot. This cannot be undone.
          </div>
          <Input label="RE-ENTER OWNER PASSWORD" data-testid="brp-confirm-pw" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="off" />
          {error && <div data-testid="brp-error" style={{ color: '#B42318', fontSize: 13 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button data-testid="brp-confirm-cancel" onClick={cancelConfirm} disabled={busy} style={ghostBtn}>Cancel</button>
            <button data-testid="brp-confirm" onClick={doConfirmRestore} disabled={!canConfirmRestore(confirmId, confirmPw, busy)} style={dangerBtn}>
              {busy ? 'Restoring…' : 'Confirm restore'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

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
  getBackupLocation,
  pickBackupFolder,
  setBackupLocation,
  resetBackupLocation,
  openBackupLocation,
  type BackupLocationInfo,
} from '@/core/lifecycle/backup-location';
import { getBackupRetention, setBackupRetention, type RetentionInfo } from '@/core/lifecycle/backup-retention';
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
  const [loc, setLoc] = useState<BackupLocationInfo | null>(null);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [ret, setRet] = useState<RetentionInfo | null>(null);
  const [retCount, setRetCount] = useState<string>('10');
  const [retMsg, setRetMsg] = useState<string | null>(null);

  // Secret hygiene: never leave a password in memory when the panel unmounts.
  useEffect(() => () => { setPassword(''); setConfirmPw(''); setBackupPw(''); }, []);

  // Load the current backup location for display (read-only, no owner gate).
  useEffect(() => { getBackupLocation().then(setLoc).catch(() => setLoc(null)); }, []);

  // Load the current retention config for display.
  useEffect(() => {
    getBackupRetention().then((r) => { setRet(r); setRetCount(String(r.keepCount)); }).catch(() => setRet(null));
  }, []);

  // OWNER-gated: save retention (enable/disable + keep count). Does NOT prune existing snapshots — the
  // prune runs after the next successful backup.
  const saveRetention = async (enabled: boolean) => {
    if (!canRunOwnerAction(email, password, busy)) { setRetMsg('Enter the owner email and password above first.'); return; }
    const n = Math.max(1, Math.min(1000, parseInt(retCount, 10) || 0));
    setBusy(true); setError(null); setRetMsg(null);
    try {
      const next = await setBackupRetention({ email: email.trim(), password, enabled, keepCount: n });
      setRet(next); setRetCount(String(next.keepCount)); setPassword('');
      setRetMsg(enabled ? `Retention on — keeping the newest ${next.keepCount} snapshots.` : 'Retention off — no snapshots are auto-deleted.');
    } catch (e) { setError(sanitizeBackupError(e)); }
    finally { setBusy(false); }
  };

  // OWNER-gated: pick a folder (native dialog) → validate+persist in Rust. Requires the owner password
  // typed in the fields above. A disconnected/read-only drive fails VISIBLY (no silent fallback).
  const doChangeLocation = async () => {
    if (!canRunOwnerAction(email, password, busy)) { setLocMsg('Enter the owner email and password above first.'); return; }
    const folder = await pickBackupFolder(loc?.path);
    if (!folder) return; // user cancelled the dialog
    setBusy(true); setError(null); setLocMsg(null);
    try {
      const next = await setBackupLocation({ email: email.trim(), password, path: folder });
      setLoc(next); setLocMsg('Backup folder saved.'); setPassword('');
    } catch (e) { setError(sanitizeBackupError(e)); }
    finally { setBusy(false); }
  };

  const doResetLocation = async () => {
    if (!canRunOwnerAction(email, password, busy)) { setLocMsg('Enter the owner email and password above first.'); return; }
    setBusy(true); setError(null); setLocMsg(null);
    try {
      const next = await resetBackupLocation({ email: email.trim(), password });
      setLoc(next); setLocMsg('Reset to the default location.'); setPassword('');
    } catch (e) { setError(sanitizeBackupError(e)); }
    finally { setBusy(false); }
  };

  const doOpenLocation = async () => {
    setError(null);
    try { await openBackupLocation(); } catch (e) { setError(sanitizeBackupError(e)); }
  };

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

      {/* BACKUP-LOCATION — owner-configurable backup folder. Snapshots + restore use this exact location. */}
      <div data-testid="brp-loc" style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: 12, marginBottom: 16, maxWidth: 640 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#0F0F10', marginBottom: 6 }}>Backup location</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>
          Where full snapshots are stored and restored from. Choose any writable folder (e.g. an external
          drive). Existing snapshots in the previous folder are left where they are.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <code data-testid="brp-loc-path" style={{ flex: 1, fontSize: 12, color: '#0F0F10', background: '#F6F7F9', border: '1px solid #EEF0F3', borderRadius: 6, padding: '6px 8px', wordBreak: 'break-all' }}>
            {loc ? loc.path : '…'}
          </code>
          <span data-testid="brp-loc-default" style={{ fontSize: 11, color: loc?.isDefault ? '#059669' : '#9CA3AF', whiteSpace: 'nowrap' }}>
            {loc ? (loc.isDefault ? 'default' : 'custom') : ''}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button data-testid="brp-loc-change" onClick={doChangeLocation} disabled={busy} style={ghostBtn}>Change folder…</button>
          <button data-testid="brp-loc-reset" onClick={doResetLocation} disabled={busy || !!loc?.isDefault} style={ghostBtn}>Reset to default</button>
          <button data-testid="brp-loc-open" onClick={doOpenLocation} disabled={busy} style={ghostBtn}>Open backup folder</button>
        </div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 8 }}>
          Changing or resetting requires the owner password entered above.
        </div>
        {locMsg && <div data-testid="brp-loc-msg" style={{ color: '#059669', fontSize: 12, marginTop: 8 }}>{locMsg}</div>}
      </div>

      {/* BACKUP-RETENTION — owner-configurable "keep last N snapshots". Prune runs after the NEXT backup. */}
      <div data-testid="brp-ret" style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: 12, marginBottom: 16, maxWidth: 640 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: '#0F0F10', marginBottom: 6 }}>Snapshot retention</div>
        <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8 }}>
          Automatically keep only the newest N complete snapshots. Existing snapshots are never deleted when
          you change this — old ones are pruned only after your next successful backup, and the newest is
          always kept.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span data-testid="brp-ret-state" style={{ fontSize: 12, fontWeight: 500, color: ret?.enabled ? '#059669' : '#9CA3AF' }}>
            {ret ? (ret.enabled ? `On · keep ${ret.keepCount}` : 'Off') : '…'}
          </span>
          <label style={{ fontSize: 12, color: '#4B5563', display: 'flex', alignItems: 'center', gap: 6 }}>
            Keep last
            <input data-testid="brp-ret-count" type="number" min={1} max={1000} value={retCount}
              onChange={(e) => setRetCount(e.target.value)}
              style={{ width: 70, padding: '4px 6px', fontSize: 12, borderRadius: 6, border: '1px solid #D5D9DE' }} />
            snapshots
          </label>
          <button data-testid="brp-ret-enable" onClick={() => saveRetention(true)} disabled={busy} style={primaryBtn}>
            {ret?.enabled ? 'Update' : 'Enable'}
          </button>
          {ret?.enabled && (
            <button data-testid="brp-ret-disable" onClick={() => saveRetention(false)} disabled={busy} style={ghostBtn}>Disable</button>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 8 }}>Changing retention requires the owner password entered above.</div>
        {retMsg && <div data-testid="brp-ret-msg" style={{ color: '#059669', fontSize: 12, marginTop: 8 }}>{retMsg}</div>}
      </div>

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

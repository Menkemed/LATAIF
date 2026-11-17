// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — „Release old image versions" in Settings → Data Repairs (Phase 5B, 17.11.2026).
//
// Gibt die alten, größeren Bildfassungen der Migration für die vorhandene Medien-Aufräumung frei. Löscht hier KEINE
// Datei: danach zeigt Settings → Backup & Restore → „Unused media cleanup" sie als unbenutzt; dort Quarantäne beim
// Neustart und endgültiges Löschen nur auf Bestätigung. Aktuelle Bilder, Fotos entfernter Galerien, Ausweise und
// das Medien-Journal bleiben. Owner-Rolle, Primary, Grund und Sicherung prüft die Verdrahtung im Ausführungspfad.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { ReleaseReport, ReleaseSkipReason } from '@/core/media/old-version-release';
import {
  oldVersionReleaseUiState, requestOldVersionReleaseStop, runOldVersionReleaseOnPrimary, subscribeOldVersionRelease,
  type ReleaseUiState,
} from '@/core/media/image-store-migration-wiring';

const MB = (b: number) => (b / 1_000_000).toFixed(1);
const SKIP_LABEL: Record<ReleaseSkipReason, string> = {
  not_older_than_current: 'not older than the current version',
  current_not_available: 'current version not available',
  blob_not_present: 'image not present',
  backup_pinned: 'held by a backup',
  rotation_reference: 'used by a key rotation',
  security_class: 'identity document',
  purchase_identity: 'ID kept as purchase evidence',
  storage_key_form: 'unexpected file name',
  current_unverified: 'current file could not be verified',
};

export function OldImageVersionsCard({ reason }: { reason: string }) {
  const [ui, setUi] = useState<ReleaseUiState>(oldVersionReleaseUiState());
  const [dry, setDry] = useState<ReleaseReport | null>(null);
  const [backupRef, setBackupRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => subscribeOldVersionRelease(() => setUi(oldVersionReleaseUiState())), []);

  async function dryRun(): Promise<void> {
    setBusy(true); setMsg(null);
    try {
      const r = await runOldVersionReleaseOnPrimary({ mode: 'dry-run' });
      if (r.refused) { setMsg({ text: r.refused.detail, ok: false }); return; }
      if (r.report) setDry(r.report);
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } finally { setBusy(false); }
  }

  async function start(): Promise<void> {
    if (!dry) return;
    const text = `Release ${dry.planned} old image version(s) (${MB(dry.bytesPlanned)} MB) for the unused media cleanup?\n`
      + 'Nothing is deleted now. The current images, removed photos, identity documents and the media journal stay.\n'
      + 'While it runs, the second computer and the phone cannot save anything.\n'
      + 'This step cannot be undone in the app — only by restoring the full backup.\n'
      + `Verified full backup: ${backupRef.trim()}`;
    if (!(await window.confirm(text))) return;
    setBusy(true); setMsg(null);
    try {
      const r = await runOldVersionReleaseOnPrimary({ mode: 'apply', reason: reason.trim(), backupRef: backupRef.trim() });
      if (r.refused) setMsg({ text: r.refused.detail, ok: false });
      else if (r.report?.stoppedEarly) setMsg({ text: `Stopped (${r.report.stopCode ?? 'stopped'}). Everything done so far is saved. Start again to continue.`, ok: false });
      else if (r.report) setMsg({ text: `Done. ${r.report.released} old version(s) released (${MB(r.report.bytesReleased)} MB), ${r.report.failed} error(s). Next: Settings → Backup & Restore → Unused media cleanup → Scan, then schedule (restart) and confirm.`, ok: r.report.failed === 0 });
      setDry(null);
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } finally { setBusy(false); }
  }

  const p = ui.progress;
  const last = ui.report;
  const skipped = dry ? Object.entries(dry.skipped).filter(([, n]) => (n ?? 0) > 0) : [];
  return (
    <Card>
      <div data-oldver-card>
        <span className="text-overline">RELEASE OLD IMAGE VERSIONS (OWNER MAINTENANCE)</span>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: 760 }}>
          After making the stored images smaller, the old, larger versions are still on the disk. This step releases them
          for the unused media cleanup — it deletes nothing itself. Only old versions whose current, smaller version has
          been checked are released. Current images, photos removed from a gallery, identity documents and the media journal
          always stay. Before you start: close the second computer, stop using the phone, and make a full backup on E: and F:
          — keep it permanently. Then delete the files in Settings → Backup &amp; Restore → Unused media cleanup.
        </p>

        <div className="flex gap-3" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" disabled={busy || ui.running} onClick={() => void dryRun()} data-oldver-dry>Dry run (changes nothing)</Button>
        </div>

        {dry && (
          <div data-oldver-dryresult data-planned={dry.planned} data-bytes={dry.bytesPlanned} data-total={dry.total}
            data-unverified={dry.skipped.current_unverified ?? 0} style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            <div>Can be released: <b>{dry.planned}</b> old version(s), {MB(dry.bytesPlanned)} MB — main images {dry.byRendition.main.files} ({MB(dry.byRendition.main.bytes)} MB),
              previews {dry.byRendition.thumbnail.files} ({MB(dry.byRendition.thumbnail.bytes)} MB).</div>
            <div>Stay: current images in use {dry.kept.currentInUse.files} ({MB(dry.kept.currentInUse.bytes)} MB), identity documents {dry.kept.currentIdentity.files},
              photos removed from a gallery {dry.kept.currentRemovedPhotos.files} ({MB(dry.kept.currentRemovedPhotos.bytes)} MB), media journal (not touched).</div>
            {skipped.length > 0 && (
              <div data-oldver-skipped>Old versions kept: {skipped.map(([k, n]) => `${n} ${SKIP_LABEL[k as ReleaseSkipReason] ?? k}`).join(', ')}.</div>
            )}
          </div>
        )}

        {!ui.running && (
          <div className="flex flex-col gap-3" style={{ marginTop: 12, maxWidth: 520 }}>
            <Input label="Name of the verified full backup (E: and F:)" value={backupRef} onChange={(e) => setBackupRef(e.target.value)} data-oldver-backup />
            <Button variant="primary" disabled={busy || !dry || dry.planned === 0 || !reason.trim() || backupRef.trim().length < 8}
              onClick={() => void start()} data-oldver-start>Release old versions</Button>
            {!dry && <span style={{ fontSize: 12, color: '#6B7280' }}>Run the dry run first.</span>}
            {dry && !reason.trim() && <span style={{ fontSize: 12, color: '#6B7280' }}>Enter a reason above first.</span>}
          </div>
        )}

        {ui.running && p && (
          <div data-oldver-progress data-mode={p.mode} data-done={p.done} data-total={p.total} data-released={p.released}
            style={{ marginTop: 12, fontSize: 13, color: '#374151' }}>
            {p.mode === 'apply' ? 'Maintenance running — the second computer and the phone cannot save. ' : 'Dry run — '}
            {p.done} / {p.total} checked{p.mode === 'apply' ? `, ${p.released} released` : ''}, {p.failed} error(s).
            <div style={{ height: 6, background: '#E5E9EE', borderRadius: 3, marginTop: 6, maxWidth: 520 }}>
              <div style={{ height: 6, width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`, background: '#5C8550', borderRadius: 3 }} />
            </div>
            {p.mode === 'apply' && (
              <div style={{ marginTop: 8 }}>
                <Button variant="secondary" disabled={ui.stopRequested} onClick={() => requestOldVersionReleaseStop()} data-oldver-stop>
                  {ui.stopRequested ? 'Stopping after the current image…' : 'Stop'}
                </Button>
              </div>
            )}
          </div>
        )}

        {last && last.mode === 'apply' && !ui.running && (
          <div data-oldver-result data-released={last.released} data-failed={last.failed} data-stopped={String(last.stoppedEarly)}
            style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            Last run: {last.released} released ({MB(last.bytesReleased)} MB), {last.failed} error(s)
            {last.stoppedEarly ? `, stopped early (${last.stopCode ?? ''}) — start again to continue` : ''}.
            {ui.logName && <> Log: <span className="font-mono">maintenance-logs/{ui.logName}.jsonl</span> in the data folder.</>}
          </div>
        )}

        {msg && (
          <div data-oldver-msg style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12,
            background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>
            {msg.text}
          </div>
        )}
      </div>
    </Card>
  );
}

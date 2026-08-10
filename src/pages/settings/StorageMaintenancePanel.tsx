// ════════════════════════════════════════════════════════════════════════════
// STORAGE-PERF-I1 §9 — Settings → Storage Maintenance (owner-gated).
//
// Two-step by construction: a read-only DRY RUN first (what would be migrated,
// how many images, how many bytes, what is not migratable and why), then an
// explicit APPLY that requires the owner's credentials AND a fresh backup
// snapshot. Nothing runs on its own — no startup hook, no timer.
//
// The panel never renders a product's image data; only counts, byte totals and
// stable reason codes. Owner credentials live in local state and are cleared on
// success, failure and unmount.
// ════════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type CSSProperties } from 'react';
import { Input } from '@/components/ui/Input';
import { useAuthStore } from '@/stores/authStore';
import {
  compactDatabaseLive,
  measureDatabaseCompaction,
  planLegacyMediaMigration,
  runLegacyMediaMigrationLive,
} from '@/core/storage/legacy-media-wiring';
import type { LegacyMediaPlan } from '@/core/storage/legacy-media-plan';
import type { MigrationReport } from '@/core/storage/legacy-media-migration';
import { formatBytes } from './backup-restore-panel-logic';
import { explainStorageCode } from './storage-panel-logic';

const primaryBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #715DE3', background: '#715DE3', color: '#fff', cursor: 'pointer' };
const ghostBtn: CSSProperties = { padding: '8px 14px', borderRadius: 8, border: '1px solid #E5E9EE', background: '#fff', cursor: 'pointer' };
const label: CSSProperties = { fontSize: 11, color: '#6B7280', textTransform: 'uppercase', letterSpacing: 0.4 };
const value: CSSProperties = { fontSize: 20, color: '#0F0F10', lineHeight: 1.15 };

function Stat({ title, main, sub, tone }: { title: string; main: string; sub?: string; tone?: 'good' | 'warn' }) {
  return (
    <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: '10px 14px', minWidth: 140 }}>
      <div style={label}>{title}</div>
      <div style={{ ...value, color: tone === 'warn' ? '#B45309' : tone === 'good' ? '#15803D' : '#0F0F10' }}>{main}</div>
      {sub && <div style={{ fontSize: 11, color: '#9CA3AF', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function StorageMaintenancePanel() {
  const sessionEmail = useAuthStore((s) => (s.session?.user as { email?: string } | undefined)?.email) ?? '';
  const [email, setEmail] = useState(sessionEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<LegacyMediaPlan | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [pages, setPages] = useState<{ bytesBefore: number; freelistBefore: number; pageSize: number } | null>(null);

  useEffect(() => () => setPassword(''), []);

  const dryRun = () => {
    setMsg(null); setReport(null);
    try {
      const p = planLegacyMediaMigration();
      setPlan(p);
      try { setPages(measureDatabaseCompaction()); } catch { setPages(null); }
      setMsg(p.migratable === 0
        ? { text: 'Nothing to migrate — every product already stores its photos in the durable gallery.', ok: true }
        : { text: `${p.migratable} product(s) with ${p.legacyImageCount} inline image(s) can be migrated.`, ok: true });
    } catch (e) {
      setPlan(null);
      setMsg({ text: explainStorageCode((e as { code?: string })?.code), ok: false });
    }
  };

  const apply = async () => {
    if (busy) return;
    setBusy(true); setMsg(null); setReport(null); setProgress({ done: 0, total: plan?.migratable ?? 0 });
    try {
      const r = await runLegacyMediaMigrationLive({
        owner: { email: email.trim(), password },
        nowMs: Date.parse(new Date().toISOString()),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setReport(r);
      setPlan(r.plan);
      setPassword('');
      setConfirmOpen(false);
      const problems = r.failed + r.verifyFailed + r.skipped;
      setMsg({
        text: `${r.migrated} product(s) migrated, ${formatBytes(r.clearedColumnBytes)} of inline image data removed from the product table.`
          + (problems > 0 ? ` ${problems} left untouched — see the list below.` : ''),
        ok: problems === 0,
      });
    } catch (e) {
      setPassword('');
      setMsg({ text: explainStorageCode((e as { code?: string })?.code ?? (e as Error)?.message), ok: false });
    } finally {
      setBusy(false); setProgress(null);
    }
  };

  const problems = report ? report.items.filter((i) => i.outcome !== 'migrated' && i.outcome !== 'already_migrated') : [];

  return (
    <div style={{ marginTop: 16, border: '1px solid #E5E9EE', borderRadius: 10, padding: 16 }}>
      <h4 style={{ fontSize: 14, fontWeight: 500, color: '#0F0F10', marginBottom: 4 }}>Storage Maintenance — move old photos into the media store</h4>
      <p style={{ fontSize: 12, color: '#6B7280', marginBottom: 12, maxWidth: 720 }}>
        Older products keep their photo inside the database row itself. That makes the database large and every
        refresh slow. This moves those photos into the durable media store — the picture stays exactly the same,
        and no other product data is touched. Originals are only removed once the migrated copy has been verified.
        The run saves after every product, so with many photos it can take several minutes — leave the app open
        until it reports a result.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button style={ghostBtn} onClick={dryRun} disabled={busy} data-testid="storage-dry-run">Check what would change</button>
        {plan && plan.migratable > 0 && !confirmOpen && (
          <button style={primaryBtn} onClick={() => setConfirmOpen(true)} disabled={busy} data-testid="storage-apply-open">
            Migrate {plan.migratable} product(s)…
          </button>
        )}
      </div>

      {plan && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }} data-testid="storage-plan">
          <Stat title="Products" main={String(plan.scannedProducts)} sub="in this branch" />
          <Stat title="To migrate" main={String(plan.migratable)} sub={`${plan.legacyImageCount} image(s)`} tone={plan.migratable > 0 ? 'warn' : 'good'} />
          <Stat title="Already done" main={String(plan.alreadyMigrated)} sub="gallery-backed" tone="good" />
          <Stat title="No photo" main={String(plan.noImages)} />
          <Stat title="Not migratable" main={String(plan.unsupported)} sub="left untouched" tone={plan.unsupported > 0 ? 'warn' : undefined} />
          <Stat title="Removable from rows" main={formatBytes(plan.reclaimableColumnBytes)} sub={`${formatBytes(plan.decodedBytes)} as image data`} />
        </div>
      )}

      {confirmOpen && (
        <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: 12, marginBottom: 12, background: '#FAFBFC' }}>
          <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 8 }}>
            A recent complete backup is required. Owner credentials are used to verify it — the migration refuses to start otherwise.
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Input label="OWNER EMAIL" data-testid="storage-apply-email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 240 }} />
            <Input label="OWNER PASSWORD" data-testid="storage-apply-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 220 }} />
            <button style={primaryBtn} onClick={apply} disabled={busy || !email.trim() || !password} data-testid="storage-apply">
              {busy ? 'Migrating…' : 'Start migration'}
            </button>
            <button style={ghostBtn} onClick={() => { setConfirmOpen(false); setPassword(''); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {progress && (
        <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 8 }} data-testid="storage-progress">
          Migrating {progress.done} / {progress.total}…
        </div>
      )}

      {msg && (
        <div data-testid="storage-msg" style={{ fontSize: 12, marginBottom: 8, color: msg.ok ? '#15803D' : '#B45309' }}>{msg.text}</div>
      )}

      {report && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }} data-testid="storage-report">
          <Stat title="Migrated" main={String(report.migrated)} tone="good" />
          <Stat title="Already done" main={String(report.alreadyMigrated)} />
          <Stat title="Left untouched" main={String(report.skipped)} tone={report.skipped > 0 ? 'warn' : undefined} />
          <Stat title="Failed" main={String(report.failed + report.verifyFailed)} tone={report.failed + report.verifyFailed > 0 ? 'warn' : 'good'} />
          <Stat title="Removed from rows" main={formatBytes(report.clearedColumnBytes)} />
        </div>
      )}

      {/* §18 — reclaiming the freed pages is a SEPARATE, explicit step: SQLite keeps
          deleted pages on a freelist, so the file only shrinks after a VACUUM. */}
      {pages && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #F1F3F5' }}>
          <div style={{ fontSize: 12, color: '#6B7280', marginBottom: 8, maxWidth: 720 }}>
            Freeing rows does not shrink the file on its own — SQLite keeps the emptied pages for reuse.
            Reclaiming them is a separate step; run it after the migration, with the app otherwise idle.
            Currently {formatBytes(pages.freelistBefore * pages.pageSize)} of {formatBytes(pages.bytesBefore)} are reusable free space.
          </div>
          {/* SINGLE-PC-STORAGE-I2 §11 — compaction rewrites the ENTIRE database file, so it is
              owner-verified exactly like the migration. Opening the credential box is a separate
              click from running it, which keeps the destructive action two keystrokes away from
              a stray click in the Danger Zone. */}
          {!compactOpen ? (
            <button style={ghostBtn} disabled={busy} data-testid="storage-compact-open" onClick={() => setCompactOpen(true)}>
              Reclaim free space…
            </button>
          ) : (
            <div style={{ border: '1px solid #E5E9EE', borderRadius: 8, padding: 12, background: '#FAFBFC' }}>
              <div style={{ fontSize: 12, color: '#4B5563', marginBottom: 8 }}>
                Reclaiming rewrites the whole database file. Owner credentials are required, and the app
                should otherwise be idle.
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <Input label="OWNER EMAIL" data-testid="storage-compact-email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 240 }} />
                <Input label="OWNER PASSWORD" data-testid="storage-compact-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 220 }} />
                <button style={primaryBtn} disabled={busy || !email.trim() || !password} data-testid="storage-compact" onClick={async () => {
                  setBusy(true); setMsg(null);
                  try {
                    const st = await compactDatabaseLive({ email: email.trim(), password });
                    setPages({ bytesBefore: st.bytesAfter, freelistBefore: st.freelistAfter, pageSize: st.pageSize });
                    setPassword(''); setCompactOpen(false);
                    setMsg({ text: `Database compacted — ${formatBytes(st.reclaimedBytes)} reclaimed (${formatBytes(st.bytesBefore)} → ${formatBytes(st.bytesAfter)}).`, ok: true });
                  } catch (e) {
                    setPassword('');
                    setMsg({ text: explainStorageCode((e as { code?: string })?.code ?? (e as Error)?.message), ok: false });
                  } finally { setBusy(false); }
                }}>{busy ? 'Reclaiming…' : 'Reclaim free space'}</button>
                <button style={ghostBtn} onClick={() => { setCompactOpen(false); setPassword(''); }} disabled={busy}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid #E5E9EE', borderRadius: 8 }}>
          {problems.map((p) => (
            <div key={p.productId} style={{ display: 'flex', gap: 10, padding: '6px 10px', borderBottom: '1px solid #F1F3F5', fontSize: 12 }}>
              <span style={{ color: '#6B7280', fontFamily: 'monospace' }}>{p.productId.slice(0, 8)}</span>
              <span style={{ color: '#B45309' }}>{explainStorageCode(p.code)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

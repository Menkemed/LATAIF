// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — einmalige Karte „überholte Galerie-Bearbeitungen vom Handy“ in Settings → Data Repairs.
//
// Sichtbar NUR, solange einer der zwei eingetragenen Jobs (TAG-WCH-004, CAR-OGJ-001) noch offen ist oder nach
// dem Abbruch das Embedding eines der zwei Artikel noch fehlt. Sonst rendert sie nichts — keine dauerhafte
// Bereinigungsfunktion. Ablauf: Prüfen (live: DB + Rust-Journal) → Sicherungsname + Grund → Rückfrage → Abbruch
// (die Hausfunktion prüft unmittelbar davor erneut und weist bei jeder Änderung ab) → Nachkontrolle.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { SupersededVerdict } from '@/core/media/superseded-edit-plans';
import { supersededEditPlansStatusOnPrimary } from '@/core/media/superseded-edit-plans-status';
import { runSupersededEditPlansOnPrimary, type SupersededRunResult } from '@/core/media/superseded-edit-plans-wiring';

const CREATED: Record<string, string> = { 'TAG-WCH-004': '25 Aug 2026', 'CAR-OGJ-001': '3 Oct 2026' };

export function SupersededGalleryEditsCard({ reason }: { reason: string }) {
  const [refresh, setRefresh] = useState(0);
  // Der Leseweg liegt im Kern (nur Primary, nur lesend) — die Seite fasst keine Datenbank an.
  const status = useMemo(() => supersededEditPlansStatusOnPrimary(), [refresh]);
  const [check, setCheck] = useState<SupersededVerdict[] | null>(null);
  const [backupRef, setBackupRef] = useState('');
  const [result, setResult] = useState<SupersededRunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  if (!status || (!status.cardVisible && !result)) return null;
  const open = status.cases.filter((c) => c.jobState === 'accepted');
  const closable = (check ?? []).filter((v) => v.status === 'closable');
  const allOpenClosable = open.length > 0 && open.every((c) => closable.some((v) => v.jobId === c.jobId));

  async function runCheck(): Promise<void> {
    setBusy(true); setMsg(null); setResult(null);
    try {
      const r = await runSupersededEditPlansOnPrimary({ mode: 'inspect' });
      if (r.refused) { setMsg({ text: r.refused.detail, ok: false }); setCheck(null); return; }
      setCheck(r.inspected ?? []);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally { setBusy(false); }
  }

  async function runClose(): Promise<void> {
    if (!check) return;
    const fingerprints: Record<string, string> = {};
    for (const v of check) if (v.status === 'closable') fingerprints[v.jobId] = v.fingerprint;
    const skus = status!.cases.filter((c) => fingerprints[c.jobId]).map((c) => c.sku).join(', ');
    const text = `Close ${Object.keys(fingerprints).length} superseded phone gallery edit(s)? ${skus}\n`
      + 'Only these old, unfinished requests are marked as superseded. Prices, photos, photo links and sync stay exactly as they are.\n'
      + `Verified backup: ${backupRef.trim()}`;
    if (!(await window.confirm(text))) return;
    setBusy(true); setMsg(null);
    try {
      const r = await runSupersededEditPlansOnPrimary({ mode: 'close', fingerprints, reason: reason.trim(), backupRef: backupRef.trim() });
      setResult(r);
      if (r.refused) setMsg({ text: r.refused.detail, ok: false });
      else {
        const refusedOnes = (r.closed ?? []).filter((x) => x.status === 'refused');
        setMsg(refusedOnes.length === 0
          ? { text: 'Done. Both old requests are marked as superseded.', ok: true }
          : { text: 'Nothing was changed for the refused item(s) — the data differs from the check. Please check again.', ok: false });
      }
      setCheck(null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally { setBusy(false); setRefresh((x) => x + 1); }
  }

  async function runControl(): Promise<void> {
    setBusy(true);
    try { setResult(await runSupersededEditPlansOnPrimary({ mode: 'control' })); } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally { setBusy(false); setRefresh((x) => x + 1); }
  }

  const control = result?.control;
  return (
    <Card>
      <div data-superseded-card>
        <span className="text-overline">SUPERSEDED PHONE GALLERY EDITS (ONE-TIME)</span>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: 720 }}>
          Two photo edits sent from the phone never finished and were replaced by a later edit that did. They are still
          marked as open, which keeps both items out of image matching and blocks the image store migration. Closing them
          only marks the two old requests as superseded. Make a full backup on E: and F: with the apps closed first.
        </p>
        {status.cases.map((c) => {
          const v = check?.find((x) => x.jobId === c.jobId);
          return (
            <div key={c.jobId} data-superseded-row={c.sku} style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE', fontSize: 13 }}>
              <b className="font-mono">{c.sku}</b> · edit from {CREATED[c.sku] ?? '—'} · {c.jobState === 'accepted' ? 'open' : c.closedByMaintenance ? 'closed as superseded' : c.jobState}
              {' · '}image matching: {c.hasEmbedding ? 'done' : 'pending'}
              {v && (
                <div data-superseded-verdict={c.sku} data-verdict={v.status === 'refused' ? v.code : v.status} style={{ marginTop: 4, color: v.status === 'refused' ? '#7A3535' : '#3F6E2F' }}>
                  {v.status === 'closable' && 'Check passed: the old plan no longer applies, a later edit succeeded, no image file or change depends on it.'}
                  {v.status === 'already_closed' && 'Already closed.'}
                  {v.status === 'refused' && `Not closable: ${v.code} — ${v.detail}`}
                </div>
              )}
            </div>
          );
        })}
        {open.length > 0 && (
          <div className="flex flex-col gap-3" style={{ marginTop: 12, maxWidth: 520 }}>
            <Button variant="secondary" disabled={busy} onClick={() => void runCheck()} data-superseded-check>Check now</Button>
            <Input label="Name of the verified backup (E: and F:)" value={backupRef} onChange={(e) => setBackupRef(e.target.value)} data-superseded-backup />
            <Button variant="primary" disabled={busy || !allOpenClosable || !reason.trim() || backupRef.trim().length < 8}
              onClick={() => void runClose()} data-superseded-close>Close superseded edits</Button>
            {!reason.trim() && <span style={{ fontSize: 12, color: '#6B7280' }}>Enter a reason above first.</span>}
          </div>
        )}
        {msg && (
          <div data-superseded-msg style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12,
            background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>
            {msg.text}
          </div>
        )}
        {result?.proof && (
          <div data-superseded-proof data-unchanged={String(result.proof.unchanged)} style={{ marginTop: 10, fontSize: 12, color: result.proof.unchanged ? '#3F6E2F' : '#7A3535' }}>
            {result.proof.unchanged
              ? 'Verified unchanged: items and prices, photos, photo links, stored image versions, other requests and the sync log.'
              : 'WARNING: a checksum differs — please report this before doing anything else.'}
            {` History entries added: ${result.proof.auditAdded}.`}
          </div>
        )}
        {control && (
          <div data-superseded-control data-migration-blocked={control.migrationBlockedBy ?? ''} style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            {control.cases.map((c) => (
              <div key={c.jobId} data-superseded-control-row={c.sku} data-candidate={String(c.embeddingCandidate)} data-embedding={String(c.hasEmbedding)}>
                {c.sku}: {c.hasEmbedding ? 'image matching done' : c.embeddingCandidate ? 'queued for image matching (runs at the next start or reload)' : 'not yet queued for image matching'}
              </div>
            ))}
            <div>Image store migration: {control.migrationBlockedBy ? `still blocked (${control.migrationBlockedBy})` : 'no longer blocked by these requests'}</div>
          </div>
        )}
        {open.length === 0 && (
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" disabled={busy} onClick={() => void runControl()} data-superseded-control-run>Check image matching</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

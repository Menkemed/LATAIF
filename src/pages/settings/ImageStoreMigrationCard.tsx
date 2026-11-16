// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — „Bildspeicher verkleinern" (bestehende Bilder auf 60/30/10 KB) in Settings → Data Repairs.
//
// Nichts läuft von selbst: Zählen und Probelauf schreiben nichts; der echte Lauf braucht einen Probelauf in dieser
// Sitzung, einen Grund, den Namen der geprüften Vollsicherung und die App-Rückfrage. Owner-Rolle, Primary und
// Freigabe prüft die Verdrahtung im Ausführungspfad (vor dem Lauf und vor jedem Paket) — nicht diese Maske.
// Während des Laufs: Wartungsmodus (PC2 und Handy können nichts speichern), Fortschritt, „Stop" hält nach dem
// laufenden Bild an; ein neuer Start setzt dort fort. Alte Bildfassungen bleiben auf der Platte.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import type { ImageStoreInventory, MigrationReport } from '@/core/media/image-store-migration';
import {
  imageMigrationUiState, imageStoreInventoryOnPrimary, requestImageMigrationStop, runImageStoreMigrationOnPrimary,
  subscribeImageMigration, type MigrationUiState,
} from '@/core/media/image-store-migration-wiring';

const MB = (b: number) => (b / 1_000_000).toFixed(1);
const CLASS_LABEL: Record<string, string> = {
  watch: 'Watches', jewelry: 'Jewellery', accessory: 'Accessories', repair: 'Repairs', order: 'Orders', other: 'Other', thumbnail: 'Previews',
};

export function ImageStoreMigrationCard({ reason }: { reason: string }) {
  const [ui, setUi] = useState<MigrationUiState>(imageMigrationUiState());
  const [inv, setInv] = useState<ImageStoreInventory | null>(null);
  const [dry, setDry] = useState<{ report: MigrationReport; secondsPerImage: number } | null>(null);
  const [backupRef, setBackupRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => subscribeImageMigration(() => setUi(imageMigrationUiState())), []);

  async function count(): Promise<void> {
    setBusy(true); setMsg(null);
    try { setInv(await imageStoreInventoryOnPrimary()); } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } finally { setBusy(false); }
  }

  async function dryRun(): Promise<void> {
    setBusy(true); setMsg(null);
    const t0 = Date.now();
    try {
      const r = await runImageStoreMigrationOnPrimary({ mode: 'dry-run' });
      if (r.refused) { setMsg({ text: r.refused.detail, ok: false }); return; }
      if (r.report) setDry({ report: r.report, secondsPerImage: r.report.total ? (Date.now() - t0) / 1000 / r.report.total : 0 });
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } finally { setBusy(false); }
  }

  async function start(): Promise<void> {
    if (!dry) return;
    const text = `Make ${dry.report.eligible} stored image(s) smaller (${MB(dry.report.bytesBefore)} MB → about ${MB(dry.report.bytesAfter)} MB)?\n`
      + 'While it runs, the second computer and the phone cannot save anything (they can try again afterwards).\n'
      + 'Old image versions stay on the disk; items, prices and photo links do not change.\n'
      + `Verified full backup: ${backupRef.trim()}`;
    if (!(await window.confirm(text))) return;
    setBusy(true); setMsg(null);
    try {
      const r = await runImageStoreMigrationOnPrimary({ mode: 'apply', reason: reason.trim(), backupRef: backupRef.trim() });
      if (r.refused) setMsg({ text: r.refused.detail, ok: false });
      else if (r.report?.stoppedEarly) setMsg({ text: `Stopped (${r.report.stopCode ?? 'stopped'}). Everything done so far is saved. Start again to continue.`, ok: false });
      else if (r.report) setMsg({ text: `Done. ${r.report.switched} image(s) made smaller, ${r.report.failed} not changed because of an error.`, ok: r.report.failed === 0 });
      setDry(null);
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : String(e), ok: false }); } finally { setBusy(false); }
  }

  const p = ui.progress;
  const last = ui.report;
  return (
    <Card>
      <div data-imgmig-card>
        <span className="text-overline">MAKE STORED IMAGES SMALLER (OWNER MAINTENANCE)</span>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 6, maxWidth: 760 }}>
          Brings existing photos down to the sizes new photos already use: watches 60 KB, jewellery and accessories 30 KB,
          previews 10 KB; repairs, orders, inbox and scrap gold follow their category (60 KB when unknown). Identity documents
          are never changed. Each image gets a new, smaller version; the old version stays on the disk, and items, prices and
          photo links do not change. Nothing happens automatically. Before you start: close the second computer, stop using
          the phone, and make a full backup on E: and F: — keep that backup permanently.
        </p>

        <div className="flex gap-3" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <Button variant="secondary" disabled={busy || ui.running} onClick={() => void count()} data-imgmig-count>Count images</Button>
          <Button variant="secondary" disabled={busy || ui.running} onClick={() => void dryRun()} data-imgmig-dry>Dry run (changes nothing)</Button>
        </div>

        {inv && (
          <div data-imgmig-inventory data-total={inv.blobsPresent} data-balanced={String(inv.balanced)} style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            <div>Stored image files: <b>{inv.blobsPresent}</b> — main images {inv.byRendition.main}, previews {inv.byRendition.thumbnail}
              {inv.byRendition.otherVariant ? `, other versions ${inv.byRendition.otherVariant}` : ''}{inv.byRendition.noObject ? `, without a photo record ${inv.byRendition.noObject}` : ''}.</div>
            <div>In use: main images {inv.linked.main}, previews {inv.linked.thumbnail}. Kept only for history (photo removed): {inv.notLinked.main + inv.notLinked.thumbnail + inv.notLinked.otherVariant + inv.notLinked.noObject}.</div>
            <div>Main images in use: {inv.decision.main.planned} above their limit, {inv.decision.main.already_small ?? 0} already small
              {inv.decision.main.excluded_security || inv.decision.main.excluded_identity ? `, ${(inv.decision.main.excluded_security ?? 0) + (inv.decision.main.excluded_identity ?? 0)} identity document(s) never changed` : ''}.</div>
            <div>Previews in use: {inv.decision.thumbnail.planned} above 10 KB, {inv.decision.thumbnail.already_small ?? 0} already small
              {inv.decision.thumbnail.excluded_security || inv.decision.thumbnail.excluded_identity ? `, ${(inv.decision.thumbnail.excluded_security ?? 0) + (inv.decision.thumbnail.excluded_identity ?? 0)} identity preview(s) never changed` : ''}.</div>
          </div>
        )}

        {dry && (
          <div data-imgmig-dryresult data-eligible={dry.report.eligible} data-total={dry.report.total} data-failed={dry.report.failed}
            style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            <div>Dry run: <b>{dry.report.eligible}</b> of {dry.report.total} image(s) above their limit can be made smaller:
              {' '}{MB(dry.report.bytesBefore)} MB → {MB(dry.report.bytesAfter)} MB (current image data).
              {dry.report.failed ? ` ${dry.report.failed} could not be read.` : ''} Estimated time: about {Math.max(1, Math.round(dry.report.total * dry.secondsPerImage / 60))} min.</div>
            {Object.entries(dry.report.byClass).map(([k, c]) => c && (
              <div key={k} data-imgmig-class={k}>{CLASS_LABEL[k] ?? k}: {c.n} · {MB(c.before)} MB → {MB(c.after)} MB</div>
            ))}
          </div>
        )}

        {!ui.running && (
          <div className="flex flex-col gap-3" style={{ marginTop: 12, maxWidth: 520 }}>
            <Input label="Name of the verified full backup (E: and F:)" value={backupRef} onChange={(e) => setBackupRef(e.target.value)} data-imgmig-backup />
            <Button variant="primary" disabled={busy || !dry || dry.report.eligible === 0 || !reason.trim() || backupRef.trim().length < 8}
              onClick={() => void start()} data-imgmig-start>Start image migration</Button>
            {!dry && <span style={{ fontSize: 12, color: '#6B7280' }}>Run the dry run first.</span>}
            {dry && !reason.trim() && <span style={{ fontSize: 12, color: '#6B7280' }}>Enter a reason above first.</span>}
          </div>
        )}

        {ui.running && p && (
          <div data-imgmig-progress data-mode={p.mode} data-done={p.done} data-total={p.total} data-switched={p.switched} data-failed={p.failed}
            style={{ marginTop: 12, fontSize: 13, color: '#374151' }}>
            {p.mode === 'apply' ? 'Maintenance running — the second computer and the phone cannot save. ' : 'Dry run — '}
            {p.done} / {p.total} done{p.mode === 'apply' ? `, ${p.switched} made smaller` : ''}, {p.failed} error(s).
            <div style={{ height: 6, background: '#E5E9EE', borderRadius: 3, marginTop: 6, maxWidth: 520 }}>
              <div style={{ height: 6, width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`, background: '#5C8550', borderRadius: 3 }} />
            </div>
            {p.mode === 'apply' && (
              <div style={{ marginTop: 8 }}>
                <Button variant="secondary" disabled={ui.stopRequested} onClick={() => requestImageMigrationStop()} data-imgmig-stop>
                  {ui.stopRequested ? 'Stopping after the current image…' : 'Stop'}
                </Button>
              </div>
            )}
          </div>
        )}

        {last && last.mode === 'apply' && !ui.running && (
          <div data-imgmig-result data-switched={last.switched} data-failed={last.failed} data-stopped={String(last.stoppedEarly)}
            style={{ marginTop: 10, fontSize: 12, color: '#374151' }}>
            Last run: {last.switched} made smaller ({MB(last.bytesBefore)} MB → {MB(last.bytesAfter)} MB), {last.failed} error(s)
            {last.stoppedEarly ? `, stopped early (${last.stopCode ?? ''}) — start again to continue` : ''}.
            {ui.logName && <> Log: <span className="font-mono">maintenance-logs/{ui.logName}.jsonl</span> in the data folder.</>}
          </div>
        )}

        {msg && (
          <div data-imgmig-msg style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12,
            background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>
            {msg.text}
          </div>
        )}
      </div>
    </Card>
  );
}

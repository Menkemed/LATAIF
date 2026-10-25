// ════════════════════════════════════════════════════════════════════════════
// F10 — „Data Repairs": die belegten Reparaturen nach dem alten Start-Fehler, nur ausdrücklich ausgelöst.
//
// Die Einstellungen laufen nur am Primary und nur für Admin. Angezeigt wird ausschließlich, was die Hausfunktionen
// als bewiesen erkennen (dieselben Prüfungen laufen beim Auslösen noch einmal, in der Transaktion):
//   • Edelmetall-Lose, die fälschlich auf EXHAUSTED stehen (Restgewicht da, Bewegungen ergeben genau diesen Rest);
//   • Gold-Schmuck, dessen protokollierter Zustand „New" still zu „Pre-Owned" wurde.
// Nichts geschieht ohne Grund, Rückfrage und Klick; Gewicht, Wert, Menge, Preise und Buchungen bleiben unberührt.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { currentBranchId } from '@/core/db/helpers';
import { formatFils, formatMg } from '@/core/bulk/bulk-math';
import { wronglyClosedBulkLotRows } from '@/core/bulk/bulk-reads';
import { reopenWronglyClosedLotOnPrimary } from '@/core/bulk/bulk-actions';
import { goldConditionRestoreCandidates, restoreGoldConditionOnPrimary } from '@/core/products/gold-condition-restore';
import { cardFeeRepairPreview, repairCardFeeBookingsOnPrimary } from '@/core/finance/card-fee-repair';
import { useProductStore } from '@/stores/productStore';
import { useExpenseStore } from '@/stores/expenseStore';

export function DataRepairsTab() {
  const [refresh, setRefresh] = useState(0);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const lots = useMemo(() => wronglyClosedBulkLotRows(currentBranchId()), [refresh]);
  const gold = useMemo(() => goldConditionRestoreCandidates(), [refresh]);
  // v0.8.90 — Kartengebühren, die „Edit Expense" als offene Verbindlichkeit neu gebucht hatte.
  const fees = useMemo(() => cardFeeRepairPreview(currentBranchId()), [refresh]);
  const [abgewaehlt, setAbgewaehlt] = useState<Set<string>>(new Set());
  const reload = (): void => { useProductStore.getState().loadProducts(); useExpenseStore.getState().loadExpenses(); setRefresh((r) => r + 1); };

  async function rebookFees(): Promise<void> {
    if (!reason.trim()) { setMsg({ text: 'Please enter a reason first.', ok: false }); return; }
    const ids = fees.repairable.map((f) => f.expenseId);
    if (ids.length === 0) return;
    const summe = fees.repairable.reduce((s, f) => s + f.amount, 0);
    if (!(await window.confirm(`Re-book ${ids.length} card fee(s) (${summe.toFixed(3)} BHD) from Payables to Card Clearing?\n`
      + 'The wrong booking is reversed and the right one is booked on the same day. Amounts, dates and the expenses themselves stay as they are.'))) return;
    setBusy(true);
    try {
      const r = await repairCardFeeBookingsOnPrimary({ expenseIds: ids, reason: reason.trim() }, reload);
      setMsg({ text: `${r.repaired.length} card fee(s) re-booked to Card Clearing.`, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
      setRefresh((x) => x + 1);
    }
  }

  async function reopen(l: (typeof lots)[number]): Promise<void> {
    if (!reason.trim()) { setMsg({ text: 'Please enter a reason first.', ok: false }); return; }
    const text = `Reopen bulk lot ${l.lotNo} (${l.metal} ${l.fineness}, purchase ${l.purchaseNumber ?? '—'})?\n`
      + `Remaining ${formatMg(l.remainingWeightMg)} g · ${formatFils(l.remainingValueFils)} BHD stay exactly as they are; only the status goes back to ACTIVE.`;
    if (!(await window.confirm(text))) return;
    setBusy(true);
    try {
      const r = await reopenWronglyClosedLotOnPrimary({
        actionId: uuid(), lotId: l.id, purchaseId: l.purchaseId ?? '', expectedRevision: l.revision,
        confirmWeightMg: l.remainingWeightMg, confirmValueFils: l.remainingValueFils, reason: reason.trim(),
      }, reload);
      setMsg({ text: `Bulk lot ${r.lotNo} is ACTIVE again (${formatMg(r.remainingWeightMg)} g · ${formatFils(r.remainingValueFils)} BHD).`, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
      setRefresh((x) => x + 1);
    }
  }

  async function restoreGold(): Promise<void> {
    if (!reason.trim()) { setMsg({ text: 'Please enter a reason first.', ok: false }); return; }
    const ids = gold.map((g) => g.productId).filter((id) => !abgewaehlt.has(id));
    if (ids.length === 0) return;
    if (!(await window.confirm(`Set the condition of ${ids.length} Gold-Diamond Jewellery item(s) back to "New"? Nothing else changes.`))) return;
    setBusy(true);
    try {
      const r = await restoreGoldConditionOnPrimary({ productIds: ids, reason: reason.trim() }, reload);
      setMsg({ text: `${r.restored.length} item(s) restored to "New".`, ok: true });
      setAbgewaehlt(new Set());
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
      setRefresh((x) => x + 1);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-data-repairs>
      <Card>
        <h2 className="text-display-xs" style={{ color: '#0F0F10' }}>Data Repairs</h2>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 4, maxWidth: 680 }}>
          Up to v0.8.80 a start-up step could close bulk metal lots that still had stock, and set Gold-Diamond Jewellery
          items from “New” to “Pre-Owned”. Up to v0.8.89 editing the date or amount of an automatic card fee booked it as
          an open payable instead of against Card Clearing. Only items where the app’s own records prove this are listed.
          Nothing changes until you confirm. Make a fresh backup first.
        </p>
        <div style={{ marginTop: 12, maxWidth: 520 }}>
          <Input label="Reason (required, saved in the history)" value={reason} onChange={(e) => setReason(e.target.value)} data-repair-reason />
        </div>
        {msg && (
          <div data-repair-msg style={{ marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: 12,
            background: msg.ok ? 'rgba(126,170,110,0.10)' : 'rgba(170,110,110,0.10)', color: msg.ok ? '#3F6E2F' : '#7A3535' }}>
            {msg.text}
          </div>
        )}
      </Card>

      <Card>
        <span className="text-overline">BULK METAL LOTS CLOSED BY THE START-UP STEP</span>
        {lots.length === 0 && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8 }}>None found.</p>}
        {lots.map((l) => (
          <div key={l.id} data-repair-lot={l.lotNo} className="flex justify-between items-center" style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE', fontSize: 13 }}>
            <span>
              <b className="font-mono">{l.lotNo}</b> · {l.metal} {l.fineness} · purchase {l.purchaseNumber ?? '—'} · {l.acquiredAt}
              {' · '}<span className="font-mono">{formatMg(l.remainingWeightMg)} g · {formatFils(l.remainingValueFils)} BHD</span> · status {l.status}
            </span>
            <Button variant="secondary" disabled={busy || !reason.trim()} onClick={() => void reopen(l)} data-repair-reopen={l.lotNo}>Reopen lot</Button>
          </div>
        ))}
      </Card>

      <Card>
        <span className="text-overline">GOLD-DIAMOND JEWELLERY SET FROM “NEW” TO “PRE-OWNED”</span>
        {gold.length === 0 && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8 }}>None found.</p>}
        {gold.map((g) => (
          <label key={g.productId} data-repair-gold={g.productId} className="flex gap-3 items-center" style={{ padding: '8px 0', borderBottom: '1px solid #E5E9EE', fontSize: 13 }}>
            <input type="checkbox" checked={!abgewaehlt.has(g.productId)}
              onChange={(e) => setAbgewaehlt((prev) => { const n = new Set(prev); if (e.target.checked) n.delete(g.productId); else n.add(g.productId); return n; })} />
            <span>{g.name || '(no name)'} · <span className="font-mono">{g.sku || g.productId}</span> · last recorded “New” on {g.trackedAt.slice(0, 10)}</span>
          </label>
        ))}
        {gold.length > 0 && (
          <div className="flex justify-end" style={{ marginTop: 12 }}>
            <Button variant="primary" disabled={busy || !reason.trim() || gold.every((g) => abgewaehlt.has(g.productId))}
              onClick={() => void restoreGold()} data-repair-gold-restore>Restore “New”</Button>
          </div>
        )}
      </Card>

      <Card>
        <span className="text-overline">CARD FEES BOOKED AS PAYABLES AFTER AN EDIT</span>
        {fees.repairable.length === 0 && fees.blocked.length === 0 && <p style={{ fontSize: 13, color: '#6B7280', marginTop: 8 }}>None found.</p>}
        {fees.repairable.map((f) => (
          <div key={f.expenseId} data-repair-card-fee={f.expenseNumber} style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE', fontSize: 13 }}>
            <b className="font-mono">{f.expenseNumber}</b> · {f.documentNumber} · <span className="font-mono">{f.amount.toFixed(3)} BHD</span>
            {' · '}booked on {f.occurredAt.slice(0, 10)} · Payables → Card Clearing
          </div>
        ))}
        {fees.blocked.map((f) => (
          <div key={f.expenseId} data-repair-card-fee-blocked={f.expenseNumber} style={{ padding: '10px 0', borderBottom: '1px solid #E5E9EE', fontSize: 13, color: '#7A3535' }}>
            <b className="font-mono">{f.expenseNumber}</b> · <span className="font-mono">{f.amount.toFixed(3)} BHD</span> · not repaired automatically: {f.issue}
          </div>
        ))}
        {fees.repairable.length > 0 && (
          <div className="flex justify-end" style={{ marginTop: 12 }}>
            <Button variant="primary" disabled={busy || !reason.trim()} onClick={() => void rebookFees()} data-repair-card-fee-rebook>Re-book card fees</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

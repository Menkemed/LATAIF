// PARTNER-ITEMS — „Add partner" im Einkauf: optional, standardmäßig geschlossen, und nur sichtbar,
// wenn es aktive Partner gibt. Eine Beteiligung (Partner + Anteile) lässt sich auf ausgewählte Zeilen
// anwenden; jede Zeile trägt danach ihre eigene. LATAIF hält immer den Rest bis 100 %.
import { useMemo, useState } from 'react';
import { Plus, Trash2, Users, X } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { Partner } from '@/core/models/types';
import {
  PartnerItemRejected, planLineParticipation, suggestedPartnerPcts, type PartnerShareInput,
} from '@/core/partners/item-participation';

export interface PartnerSectionLine {
  label: string;
  lineTotal: number;
  partnerShares?: PartnerShareInput[];
}

interface Props {
  partners: Partner[];
  lines: PartnerSectionLine[];
  onApply: (lineIndexes: number[], shares: PartnerShareInput[] | undefined) => void;
}

const pct = (v: number): string => `${Number(v.toFixed(2))} %`;

/** Betrag → Anteil in Prozent, auf 0,01 % gerundet (die Beteiligung rechnet in Basispunkten). */
const pctOfAmount = (amount: number, total: number): string =>
  total > 0 && Number.isFinite(amount) ? String(Math.round((amount / total) * 10000) / 100) : '';

type Row = { partnerId: string; sharePct: string; amount?: string };

export function PurchasePartnerSection({ partners, lines, onApply }: Props) {
  const active = useMemo(() => partners.filter((p) => p.active), [partners]);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [error, setError] = useState('');

  // Ein Betrag bezieht sich auf die Summe der ausgewählten Artikel.
  const totalOf = (sel: Record<number, boolean>): number =>
    lines.reduce((s, l, i) => s + (sel[i] ? (Number(l.lineTotal) || 0) : 0), 0);
  const selectedTotal = totalOf(selected);
  const amountShown = (r: Row): string => r.amount ?? (selectedTotal > 0 && r.sharePct !== ''
    ? (Math.round(selectedTotal * (parseFloat(r.sharePct) || 0) * 10) / 1000).toFixed(3) : '');

  function select(next: Record<number, boolean>) {
    setSelected(next);
    // Eingetippte Beträge bleiben; ihr Anteil folgt der neuen Auswahl.
    const t = totalOf(next);
    setRows(rows.map((r) => (r.amount !== undefined ? { ...r, sharePct: pctOfAmount(parseFloat(r.amount), t) || r.sharePct } : r)));
  }

  const nameOf = (id: string | null): string =>
    id ? (partners.find((p) => p.id === id)?.name ?? id) : 'LATAIF';
  const anyShared = lines.some((l) => l.partnerShares && l.partnerShares.length > 0);

  if (active.length === 0) return null;

  const partnerSum = rows.reduce((s, r) => s + (parseFloat(r.sharePct) || 0), 0);
  const houseShare = Math.round((100 - partnerSum) * 100) / 100;

  function start() {
    setOpen(true);
    setError('');
    if (rows.length === 0) setRows([{ partnerId: '', sharePct: String(suggestedPartnerPcts(1)[0]) }]);
    if (Object.keys(selected).length === 0) setSelected(Object.fromEntries(lines.map((_, i) => [i, true])));
  }

  function addRow() {
    // Vorschlag: alle Beteiligten zu gleichen Teilen (LATAIF eingeschlossen).
    const next: Row[] = [...rows, { partnerId: '', sharePct: '0' }];
    const s = suggestedPartnerPcts(next.length);
    setRows(next.map((r, i) => ({ partnerId: r.partnerId, sharePct: String(s[i]) })));
  }

  function shares(): PartnerShareInput[] | null {
    const out = rows.map((r) => ({ partnerId: r.partnerId, sharePct: parseFloat(r.sharePct) }));
    try {
      planLineParticipation(out, 0);
    } catch (e) {
      setError(e instanceof PartnerItemRejected ? e.message : String(e));
      return null;
    }
    return out;
  }

  function apply() {
    setError('');
    const idx = lines.map((_, i) => i).filter((i) => selected[i]);
    if (idx.length === 0) { setError('Select at least one item'); return; }
    const s = shares();
    if (!s) return;
    onApply(idx, s);
  }

  return (
    <div style={{ marginTop: 16 }} data-purchase-partner-section>
      <Card>
        <div className="flex items-center justify-between">
          <span className="text-overline">PARTNERS (optional)</span>
          {!open && (
            <button type="button" onClick={start} data-purchase-partner-open
              className="cursor-pointer flex items-center gap-1"
              style={{ padding: '4px 10px', fontSize: 11, borderRadius: 999, border: '1px solid #C6A36D', color: '#0F0F10', background: 'rgba(198,163,109,0.08)' }}>
              <Users size={12} /> Add partner
            </button>
          )}
          {open && (
            <button type="button" onClick={() => setOpen(false)} className="cursor-pointer" style={{ background: 'none', border: 'none', color: '#6B7280' }}>
              <X size={14} />
            </button>
          )}
        </div>

        {open && (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 11, color: '#6B7280', marginBottom: 10 }}>
              Bought together with a partner: LATAIF buys and pays the supplier as usual; the share decides the
              partner&apos;s part of the cost and of the later profit or loss. LATAIF keeps the rest.
            </p>
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-3" style={{ marginBottom: 8 }}>
                <select value={r.partnerId} data-purchase-partner-select={i}
                  onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, partnerId: e.target.value } : x)))}
                  style={{ flex: 2, padding: '8px 6px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6, background: 'transparent' }}>
                  <option value="">Select partner…</option>
                  {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <input type="number" step="0.01" min="0" max="100" value={r.sharePct} data-purchase-partner-share={i}
                  onChange={(e) => setRows(rows.map((x, k) => (k === i ? { partnerId: x.partnerId, sharePct: e.target.value } : x)))}
                  style={{ width: 90, padding: '8px 6px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6 }} />
                <span style={{ fontSize: 12, color: '#6B7280' }}>%</span>
                <span style={{ fontSize: 12, color: '#9CA3AF' }}>or</span>
                <input type="number" step="0.001" min="0" value={amountShown(r)} data-purchase-partner-amount={i}
                  disabled={selectedTotal <= 0} title={selectedTotal > 0 ? `of ${selectedTotal.toFixed(3)} BHD (selected items)` : 'Enter the prices of the selected items first'}
                  onChange={(e) => setRows(rows.map((x, k) => (k === i
                    ? { ...x, amount: e.target.value, sharePct: pctOfAmount(parseFloat(e.target.value), selectedTotal) || x.sharePct }
                    : x)))}
                  style={{ width: 110, padding: '8px 6px', fontSize: 13, border: '1px solid #D5D9DE', borderRadius: 6 }} />
                <span style={{ fontSize: 12, color: '#6B7280' }}>BHD</span>
                <button type="button" onClick={() => setRows(rows.filter((_, k) => k !== i))} className="cursor-pointer"
                  style={{ background: 'none', border: 'none', color: '#9CA3AF' }} disabled={rows.length === 1}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
              <button type="button" onClick={addRow} className="cursor-pointer flex items-center gap-1"
                style={{ background: 'none', border: 'none', color: '#6B7280', fontSize: 12 }}
                disabled={rows.length >= active.length}>
                <Plus size={12} /> Another partner
              </button>
              <span style={{ fontSize: 12, color: houseShare < 0 ? '#DC2626' : '#0F0F10' }} data-purchase-partner-house>
                LATAIF: {pct(houseShare)}
              </span>
            </div>

            <span className="text-overline" style={{ marginTop: 14, marginBottom: 6, display: 'block' }}>APPLY TO</span>
            {lines.map((l, i) => (
              <label key={i} className="flex items-center gap-2" style={{ fontSize: 13, marginBottom: 4 }}>
                <input type="checkbox" checked={!!selected[i]} data-purchase-partner-line={i}
                  onChange={(e) => select({ ...selected, [i]: e.target.checked })} />
                Line {i + 1} · {l.label || 'Item'}
              </label>
            ))}
            <p style={{ fontSize: 11, color: '#6B7280', marginTop: 4 }} data-purchase-partner-amount-hint>
              A BHD amount is the partner&apos;s part of the selected items ({selectedTotal.toFixed(3)} BHD) and is turned into a
              share rounded to 0.01 %. The exact cost share per item is shown after applying.
            </p>
            {error && <p style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }} data-purchase-partner-error>{error}</p>}
            <div className="flex justify-end" style={{ marginTop: 10 }}>
              <Button variant="secondary" onClick={apply} data-purchase-partner-apply>Apply to selected items</Button>
            </div>
          </div>
        )}

        {anyShared && (
          <div style={{ marginTop: 12 }} data-purchase-partner-summary>
            {lines.map((l, i) => {
              if (!l.partnerShares || l.partnerShares.length === 0) return null;
              let plan: ReturnType<typeof planLineParticipation> = [];
              try { plan = planLineParticipation(l.partnerShares, Math.round(l.lineTotal * 1000)); } catch { plan = []; }
              return (
                <div key={i} className="flex items-center justify-between" style={{ fontSize: 12, padding: '6px 0', borderTop: '1px solid #F0F1F3' }}>
                  <span>
                    <strong>Line {i + 1}</strong> · {l.label || 'Item'} —{' '}
                    {plan.map((p) => `${nameOf(p.partnerId)} ${pct(p.shareBp / 100)} (${(p.costShareF / 1000).toFixed(3)} BHD)`).join(' · ')}
                  </span>
                  <button type="button" onClick={() => onApply([i], undefined)} className="cursor-pointer"
                    style={{ background: 'none', border: 'none', color: '#9CA3AF', fontSize: 11 }} data-purchase-partner-remove={i}>
                    remove
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// SettleGoldModal — universelles Modal fuer alle Settle/Convert-Aktionen
// auf den drei Gold-Buckets (gold_payable, customer_gold_credit).
//
// Mode bestimmt die Aktion + Felder:
//   - 'settle_supplier_return'  → gold_payables.settle_return_gold (Inflow ins Shop-Inventar)
//   - 'convert_supplier_money'  → gold_payables.convert_to_money (Expense erzeugen)
//   - 'apply_shop_to_supplier'  → applyShopGoldToSupplierPayable (Outflow Shop-Inventar)
//   - 'return_customer'         → customer_gold_credits.return_to_customer
//   - 'convert_customer_money'  → customer_gold_credits.convert_to_money
//
// Plan repair-multi-supplier — Salesforce-Stil: jede Aktion ist explizit
// gewaehlt, niemals automatisch. Soft-Warn bei verdaechtigen Eingaben
// (z.B. Karat-Mismatch), aber nie blockierend.

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { useGoldStore } from '@/stores/goldStore';
import { KARAT_PURITY } from '@/core/gold/purity';
import { query, currentBranchId } from '@/core/db/helpers';
import type { GoldPayable, CustomerGoldCredit } from '@/core/models/types';

export type SettleGoldMode =
  | 'settle_supplier_return'
  | 'convert_supplier_money'
  | 'apply_shop_to_supplier'
  | 'return_customer'
  | 'convert_customer_money';

interface SettleGoldModalProps {
  open: boolean;
  onClose: () => void;
  mode: SettleGoldMode;
  payable?: GoldPayable;
  credit?: CustomerGoldCredit;
  repairId?: string;
}

function modeTitle(mode: SettleGoldMode): string {
  switch (mode) {
    case 'settle_supplier_return':  return 'Settle — Workshop returns gold';
    case 'convert_supplier_money':  return 'Convert gold debt to BHD';
    case 'apply_shop_to_supplier':  return 'Apply shop gold to supplier debt';
    case 'return_customer':         return 'Return gold to customer';
    case 'convert_customer_money':  return 'Convert customer credit to BHD';
  }
}

function modeHint(mode: SettleGoldMode): string {
  switch (mode) {
    case 'settle_supplier_return':
      return 'Workshop liefert das geschuldete Gold physisch zurueck — wird ins Shop-Inventar (precious_metals) gebucht.';
    case 'convert_supplier_money':
      return 'Wir verhandeln einen BHD-Betrag fuer die Gold-Schuld. Es wird eine Expense gegen den Supplier erzeugt + Ledger gebucht.';
    case 'apply_shop_to_supplier':
      return 'Wir geben dem Workshop Gold aus unserem Bestand — Shop-Inventar reduziert sich, Schuld faellt.';
    case 'return_customer':
      return 'Kunde holt physisch sein Gold-Guthaben ab. Kein Geldfluss.';
    case 'convert_customer_money':
      return 'Wir verhandeln einen BHD-Betrag — der Customer-Credit wird zu BHD-Refund umgewandelt.';
  }
}

export function SettleGoldModal({ open, onClose, mode, payable, credit, repairId }: SettleGoldModalProps) {
  const goldStore = useGoldStore();
  const [grams, setGrams] = useState<string>('');
  const [bhd, setBhd] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [error, setError] = useState<string>('');

  // v0.1.47 — Cross-Karat-Settle. Nur fuer apply_shop_to_supplier-Mode.
  // Default = Payable-Karat (= "exakter Match", kein Cross-Karat).
  const [sourceKarat, setSourceKarat] = useState<string>('');

  // Remaining grams aus dem entsprechenden Bucket
  const remainingGrams = payable
    ? Math.max(0, payable.weightGrams - payable.fulfilledGrams)
    : credit
    ? Math.max(0, credit.weightGrams - credit.fulfilledGrams)
    : 0;
  const karat = payable?.karat || credit?.karat || '';

  // Reset bei Modal-Open
  useEffect(() => {
    if (open) {
      setGrams(remainingGrams.toFixed(3));
      setBhd('');
      setNotes('');
      setError('');
      setSourceKarat(karat);
    }
  }, [open, remainingGrams, karat]);

  // v0.1.47 — fetche Shop-Inventory pro Karat damit der User sieht was zur
  // Verfuegung steht. Nur fuer apply_shop_to_supplier-Mode relevant.
  const shopInventory = useMemo<Array<{ karat: string; grams: number }>>(() => {
    if (mode !== 'apply_shop_to_supplier' || !open) return [];
    try {
      const branchId = currentBranchId();
      const rows = query(
        `SELECT karat, COALESCE(SUM(weight_grams), 0) AS total
           FROM precious_metals
           WHERE branch_id = ? AND status = 'in_stock' AND weight_grams > 0
           GROUP BY karat
           ORDER BY karat DESC`,
        [branchId]
      );
      return rows.map(r => ({ karat: r.karat as string, grams: r.total as number }));
    } catch { return []; }
  }, [mode, open]);

  // v0.1.47 — Conversion-Preview fuer Cross-Karat
  const isCrossKarat = mode === 'apply_shop_to_supplier' && sourceKarat && sourceKarat !== karat;
  const sourceGramsNum = parseFloat(grams) || 0;
  const conversionPreview = useMemo(() => {
    if (!isCrossKarat || sourceGramsNum <= 0) return null;
    try {
      // sourceGrams im sourceKarat → wieviel ist das im targetKarat?
      const sourceP = KARAT_PURITY[sourceKarat] || 1.0;
      const targetP = KARAT_PURITY[karat] || 1.0;
      const targetEquiv = (sourceGramsNum * sourceP) / targetP;
      return {
        sourceP, targetP, targetEquiv,
        pureGoldGrams: sourceGramsNum * sourceP,
      };
    } catch { return null; }
  }, [isCrossKarat, sourceGramsNum, sourceKarat, karat]);

  const needsBhd = mode === 'convert_supplier_money' || mode === 'convert_customer_money';

  // SoftWarn-Hinweise. Bei Cross-Karat sind die Vergleichsgroessen in
  // unterschiedlichen Karaten — wir vergleichen target-equivalent vs remaining.
  let gramsWarn: string | undefined;
  const gNum = parseFloat(grams) || 0;
  if (isCrossKarat && conversionPreview) {
    const inv = shopInventory.find(i => i.karat === sourceKarat);
    const avail = inv?.grams || 0;
    if (gNum > avail + 0.0001) {
      gramsWarn = `Nur ${avail.toFixed(3)}g ${sourceKarat} im Bestand — wird beim Speichern zurueckgewiesen.`;
    } else if (conversionPreview.targetEquiv > remainingGrams + 0.0001) {
      gramsWarn = `${conversionPreview.targetEquiv.toFixed(3)}g ${karat}-equivalent uebersteigt die offene Schuld (${remainingGrams.toFixed(3)}g) — wird beim Speichern zurueckgewiesen.`;
    } else if (conversionPreview.targetEquiv < remainingGrams - 0.0001) {
      gramsWarn = `Partial settlement: ${(remainingGrams - conversionPreview.targetEquiv).toFixed(3)}g ${karat} bleiben offen.`;
    }
  } else if (gNum > 0 && gNum > remainingGrams + 0.0001) {
    gramsWarn = `Mehr Gramm angegeben als offen (${remainingGrams.toFixed(3)}g) — wird beim Speichern zurueckgewiesen.`;
  } else if (gNum > 0 && gNum < remainingGrams - 0.0001) {
    gramsWarn = `Partial settlement: ${(remainingGrams - gNum).toFixed(3)}g bleiben offen.`;
  }

  function handleConfirm() {
    setError('');
    const g = parseFloat(grams) || 0;
    const b = parseFloat(bhd) || 0;

    try {
      switch (mode) {
        case 'settle_supplier_return':
          if (!payable) throw new Error('payable required');
          if (g <= 0) throw new Error('Gramm > 0 erforderlich');
          goldStore.settleGoldReturn(payable.id, g, notes || undefined);
          break;
        case 'convert_supplier_money':
          if (!payable) throw new Error('payable required');
          if (b <= 0) throw new Error('BHD-Betrag > 0 erforderlich');
          goldStore.convertGoldPayableToMoney(payable.id, b, 'bank', notes || undefined);
          break;
        case 'apply_shop_to_supplier':
          if (!payable) throw new Error('payable required');
          if (g <= 0) throw new Error('Gramm > 0 erforderlich');
          if (sourceKarat && sourceKarat !== payable.karat) {
            // Cross-Karat: andere Reinheit als Payable verlangt
            goldStore.applyShopGoldCrossKaratToPayable(payable.id, sourceKarat, g);
          } else {
            goldStore.applyShopGoldToSupplierPayable(payable.id, g);
          }
          break;
        case 'return_customer':
          if (!credit) throw new Error('credit required');
          if (g <= 0) throw new Error('Gramm > 0 erforderlich');
          goldStore.returnCustomerCredit(credit.id, g, notes || undefined);
          break;
        case 'convert_customer_money':
          if (!credit) throw new Error('credit required');
          if (b <= 0) throw new Error('BHD-Betrag > 0 erforderlich');
          goldStore.convertCustomerCreditToMoney(credit.id, b, notes || undefined);
          break;
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={modeTitle(mode)} width={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>{modeHint(mode)}</p>

        <div style={{ padding: '10px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6, fontSize: 12 }}>
          <div style={{ color: '#6B7280' }}>Offen:</div>
          <div className="font-mono" style={{ color: '#0F0F10', fontSize: 14, marginTop: 2 }}>
            {remainingGrams.toFixed(3)}g {karat}
          </div>
          {repairId && (
            <div style={{ color: '#9CA3AF', fontSize: 10, marginTop: 4 }}>Repair: {repairId.slice(0, 8)}</div>
          )}
        </div>

        {/* v0.1.47 — Source-Karat-Picker fuer apply_shop_to_supplier mode.
            Default = Payable-Karat (kein Cross-Karat). User kann auf anderes
            Karat wechseln, dann zeigt sich Conversion-Preview. */}
        {mode === 'apply_shop_to_supplier' && shopInventory.length > 0 && (
          <div>
            <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>
              FROM YOUR INVENTORY (KARAT)
            </span>
            <div className="flex gap-2 flex-wrap">
              {shopInventory.map(inv => (
                <button
                  key={inv.karat}
                  type="button"
                  onClick={() => setSourceKarat(inv.karat)}
                  className="cursor-pointer rounded transition-all duration-200"
                  style={{
                    padding: '6px 12px', fontSize: 12,
                    border: `1px solid ${sourceKarat === inv.karat ? '#0F0F10' : '#D5D9DE'}`,
                    color: sourceKarat === inv.karat ? '#0F0F10' : '#6B7280',
                    background: sourceKarat === inv.karat ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >
                  {inv.karat}
                  <span style={{ fontSize: 10, color: '#9CA3AF', marginLeft: 6 }}>
                    {inv.grams.toFixed(3)}g verfuegbar
                    {inv.karat === karat && ' (exakt)'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {mode !== 'convert_supplier_money' && mode !== 'convert_customer_money' && (
          <div>
            <Input
              label={isCrossKarat ? `WEIGHT (g ${sourceKarat})` : 'WEIGHT (g)'}
              type="number" step="0.001" value={grams}
              onChange={e => setGrams(e.target.value)} autoFocus />
            <SoftWarn warning={gramsWarn} />
          </div>
        )}

        {/* v0.1.47 — Cross-Karat-Conversion-Preview */}
        {conversionPreview && (
          <div style={{
            padding: '10px 12px', background: 'rgba(61,127,255,0.06)',
            border: '1px solid rgba(61,127,255,0.3)', borderRadius: 6, fontSize: 12,
          }}>
            <div style={{ color: '#3D7FFF', fontWeight: 600, marginBottom: 4 }}>
              ⇄ Cross-Karat Conversion
            </div>
            <div className="font-mono" style={{ color: '#0F0F10', fontSize: 13 }}>
              {sourceGramsNum.toFixed(3)}g {sourceKarat} ({(conversionPreview.sourceP * 100).toFixed(1)}%)
              {' = '}
              <strong>{conversionPreview.targetEquiv.toFixed(3)}g {karat}-equivalent</strong>
            </div>
            <div style={{ color: '#6B7280', fontSize: 11, marginTop: 4 }}>
              = {conversionPreview.pureGoldGrams.toFixed(3)}g pure gold · Payable wird mit {conversionPreview.targetEquiv.toFixed(3)}g {karat} fulfilled.
            </div>
          </div>
        )}

        {needsBhd && (
          <Input label="AGREED BHD" type="number" step="0.001" value={bhd}
            onChange={e => setBhd(e.target.value)} autoFocus />
        )}

        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES (optional)</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            rows={2}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #D5D9DE', borderRadius: 4,
                     fontSize: 13, color: '#0F0F10', background: 'transparent', resize: 'vertical' }} />
        </div>

        {error && (
          <div style={{ padding: '8px 10px', background: 'rgba(220,38,38,0.06)',
                        border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6,
                        fontSize: 12, color: '#DC2626' }}>{error}</div>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleConfirm}>Confirm</Button>
        </div>
      </div>
    </Modal>
  );
}

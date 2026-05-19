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

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { useGoldStore } from '@/stores/goldStore';
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
    }
  }, [open, remainingGrams]);

  const needsBhd = mode === 'convert_supplier_money' || mode === 'convert_customer_money';

  // SoftWarn-Hinweise
  let gramsWarn: string | undefined;
  const gNum = parseFloat(grams) || 0;
  if (gNum > 0 && gNum > remainingGrams + 0.0001) {
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
          goldStore.applyShopGoldToSupplierPayable(payable.id, g);
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

        {mode !== 'convert_supplier_money' && mode !== 'convert_customer_money' && (
          <div>
            <Input label="WEIGHT (g)" type="number" step="0.001" value={grams}
              onChange={e => setGrams(e.target.value)} autoFocus />
            <SoftWarn warning={gramsWarn} />
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

// SettleGoldModal — universelles Modal fuer alle Settle/Convert-Aktionen
// auf den drei Gold-Buckets (gold_payable, customer_gold_credit).
//
// Mode bestimmt die Aktion + Felder:
//   - 'settle_supplier_return'  → gold.payables.settle mode 'return_gold' (Inflow ins Shop-Inventar)
//   - 'convert_supplier_money'  → gold.payables.settle mode 'money' (Expense erzeugen)
//   - 'apply_shop_to_supplier'  → gold.payables.settle mode 'shop_gold' (Outflow Shop-Inventar, auch Cross-Karat)
//   - 'return_customer'         → gold.customer_credits.settle mode 'return'
//   - 'convert_customer_money'  → gold.customer_credits.settle mode 'money'
//
// Plan repair-multi-supplier — Salesforce-Stil: jede Aktion ist explizit
// gewaehlt, niemals automatisch. Soft-Warn bei verdaechtigen Eingaben.
//
// CENTRAL-UI-PARITY R6D — die Maske rechnet und schreibt nicht mehr selbst: am Primary laeuft der
// Goldkern in EINER Klammer (`settleGold…OnPrimary`), auf PC2 dieselbe Absicht als Fernbefehl. Was
// die SoftWarns als „wird beim Speichern zurueckgewiesen" ankuendigen, weist der Kern jetzt auch
// wirklich zurueck — dieselbe Rechnung (`crossKaratPlan`, Ladenbestand) steht hinter beiden.

import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { SoftWarn } from '@/components/ui/SoftWarn';
import { useGoldStore, goldRevisionOf } from '@/stores/goldStore';
import type { GoldPayable, CustomerGoldCredit } from '@/core/models/types';
import { useSharedRead } from '@/core/data/shared-read';
import { metalStockByKaratFor } from '@/core/data/page-reads';
import { useSharedWrites, nichtAmClient, fehlertext } from '@/core/data/shared-write';
import { crossKaratPlan, isKnownKarat, GRAM_EPS, type CrossKaratPlan } from '@/core/gold/gold-settle';
import {
  goldCreditSettleBody, goldPayableSettleBody, settleGoldCreditOnPrimary, settleGoldPayableOnPrimary,
  type CreditSettleRequest, type PayableSettleRequest,
} from '@/core/gold/gold-house';

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
  const goldLoadAll = useGoldStore(s => s.loadAll);
  const w = useSharedWrites();
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

  // Reset bei Modal-Open — einmal je Öffnen (und je Schuld), beim Rendern angeglichen statt per
  // Effekt. R6D: nach einem gescheiterten Versuch bleiben die Eingaben stehen, damit „Confirm"
  // denselben Rumpf wiederholt.
  const openKey = open ? `${mode}:${payable?.id ?? credit?.id ?? ''}` : '';
  const [resetFor, setResetFor] = useState('');
  if (openKey !== resetFor) {
    setResetFor(openKey);
    if (openKey) {
      setGrams(remainingGrams.toFixed(3));
      setBhd('');
      setNotes('');
      setError('');
      setSourceKarat(karat);
      w.clear();
    }
  }

  // v0.1.47 — fetche Shop-Inventory pro Karat damit der User sieht was zur
  // Verfuegung steht. Nur fuer apply_shop_to_supplier-Mode relevant.
  // CENTRAL-UI-PARITY R2D — der Ladenbestand kommt aus der gemeinsamen Ladefunktion.
  const metalStock = useSharedRead('metals.stock_by_karat.get', {}, metalStockByKaratFor, { rows: [] }, [mode, open]);
  const shopInventory = useMemo<Array<{ karat: string; grams: number }>>(
    () => (mode !== 'apply_shop_to_supplier' || !open ? [] : metalStock.rows),
    [mode, open, metalStock],
  );

  // v0.1.47 — Conversion-Preview fuer Cross-Karat. R6D: dieselbe Rechnung wie der Kern (Toleranz
  // einer halben Eingabestufe) — ein unbekanntes Karat hat keine Umrechnung, statt still 1.0.
  const isCrossKarat = mode === 'apply_shop_to_supplier' && !!sourceKarat && sourceKarat !== karat;
  const sourceGramsNum = parseFloat(grams) || 0;
  const conversionPreview = useMemo<CrossKaratPlan | null>(() => {
    if (!isCrossKarat || sourceGramsNum <= 0 || !isKnownKarat(sourceKarat) || !isKnownKarat(karat)) return null;
    return crossKaratPlan(sourceKarat, karat, sourceGramsNum, remainingGrams);
  }, [isCrossKarat, sourceGramsNum, sourceKarat, karat, remainingGrams]);

  const needsBhd = mode === 'convert_supplier_money' || mode === 'convert_customer_money';

  // SoftWarn-Hinweise. Bei Cross-Karat sind die Vergleichsgroessen in
  // unterschiedlichen Karaten — wir vergleichen target-equivalent vs remaining.
  let gramsWarn: string | undefined;
  const gNum = parseFloat(grams) || 0;
  const avail = shopInventory.find(i => i.karat === (isCrossKarat ? sourceKarat : karat))?.grams || 0;
  if (isCrossKarat && gNum > 0 && !conversionPreview) {
    gramsWarn = `Karat ${sourceKarat} / ${karat} hat keine bekannte Reinheit — wird beim Speichern zurueckgewiesen.`;
  } else if (isCrossKarat && conversionPreview) {
    if (gNum > avail + GRAM_EPS) {
      gramsWarn = `Nur ${avail.toFixed(3)}g ${sourceKarat} im Bestand — wird beim Speichern zurueckgewiesen.`;
    } else if (conversionPreview.verdict === 'over') {
      gramsWarn = `${conversionPreview.targetEquivalent.toFixed(3)}g ${karat}-equivalent uebersteigt die offene Schuld (${remainingGrams.toFixed(3)}g) — wird beim Speichern zurueckgewiesen.`;
    } else if (conversionPreview.verdict === 'partial') {
      gramsWarn = `Partial settlement: ${(remainingGrams - conversionPreview.targetEquivalent).toFixed(3)}g ${karat} bleiben offen.`;
    }
  } else if (gNum > 0 && gNum > remainingGrams + GRAM_EPS) {
    gramsWarn = `Mehr Gramm angegeben als offen (${remainingGrams.toFixed(3)}g) — wird beim Speichern zurueckgewiesen.`;
  } else if (mode === 'apply_shop_to_supplier' && gNum > avail + GRAM_EPS) {
    gramsWarn = `Nur ${avail.toFixed(3)}g ${karat} im Bestand — wird beim Speichern zurueckgewiesen.`;
  } else if (gNum > 0 && gNum < remainingGrams - GRAM_EPS) {
    gramsWarn = `Partial settlement: ${(remainingGrams - gNum).toFixed(3)}g bleiben offen.`;
  }

  async function handleConfirm() {
    setError('');
    const g = parseFloat(grams) || 0;
    const b = parseFloat(bhd) || 0;
    if (needsBhd && b <= 0) { setError('BHD-Betrag > 0 erforderlich'); return; }
    if (!needsBhd && g <= 0) { setError('Gramm > 0 erforderlich'); return; }
    // Die gesehene Fassung reist mit — ein zweiter Rechner soll nichts still ueberschreiben.
    const revision = goldRevisionOf(payable ?? credit);
    if (w.remote && !revision) { setError(fehlertext(nichtAmClient('settling gold (no revision loaded)'))); return; }
    const note = notes || undefined;

    let done = false;
    if (mode === 'settle_supplier_return' || mode === 'apply_shop_to_supplier' || mode === 'convert_supplier_money') {
      if (!payable) { setError('payable required'); return; }
      const req: PayableSettleRequest = mode === 'convert_supplier_money'
        ? { payableId: payable.id, expectedRevision: revision, mode: 'money', agreedBhd: b, notes: note }
        : {
            payableId: payable.id, expectedRevision: revision, grams: g, notes: note,
            mode: mode === 'apply_shop_to_supplier' ? 'shop_gold' : 'return_gold',
            // Cross-Karat: andere Reinheit als die Schuld verlangt — die Gramm sind Quellgramm.
            ...(isCrossKarat ? { sourceKarat } : {}),
          };
      done = await w.ok('gold.payables.settle', {
        local: () => settleGoldPayableOnPrimary(req),
        remote: () => goldPayableSettleBody(req),
      });
    } else {
      if (!credit) { setError('credit required'); return; }
      const req: CreditSettleRequest = mode === 'convert_customer_money'
        ? { creditId: credit.id, expectedRevision: revision, mode: 'money', agreedBhd: b, notes: note }
        : { creditId: credit.id, expectedRevision: revision, mode: 'return', grams: g, notes: note };
      done = await w.ok('gold.customer_credits.settle', {
        local: () => settleGoldCreditOnPrimary(req),
        remote: () => goldCreditSettleBody(req),
      });
    }
    // Nie schliessen, solange es nicht geglueckt ist — auch nicht bei offenem Ausgang (derselbe Versuch).
    if (!done) return;
    goldLoadAll();
    onClose();
  }

  const shownError = error || w.fehler;

  return (
    <Modal open={open} onClose={onClose} title={modeTitle(mode)} width={480}>
      <div data-gold-settle-modal={mode} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ fontSize: 12, color: '#6B7280', lineHeight: 1.5 }}>{modeHint(mode)}</p>

        <div style={{ padding: '10px 12px', background: '#F2F7FA', border: '1px solid #E5E9EE', borderRadius: 6, fontSize: 12 }}>
          <div style={{ color: '#6B7280' }}>Offen:</div>
          <div className="font-mono" data-gold-settle-open-grams style={{ color: '#0F0F10', fontSize: 14, marginTop: 2 }}>
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
                  data-gold-settle-source-karat={inv.karat}
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
              type="number" step="0.001" value={grams} data-gold-settle-grams
              onChange={e => setGrams(e.target.value)} autoFocus />
            <SoftWarn warning={gramsWarn} />
          </div>
        )}

        {/* v0.1.47 — Cross-Karat-Conversion-Preview */}
        {conversionPreview && (
          <div data-gold-settle-preview={conversionPreview.verdict} style={{
            padding: '10px 12px', background: 'rgba(61,127,255,0.06)',
            border: '1px solid rgba(61,127,255,0.3)', borderRadius: 6, fontSize: 12,
          }}>
            <div style={{ color: '#3D7FFF', fontWeight: 600, marginBottom: 4 }}>
              ⇄ Cross-Karat Conversion
            </div>
            <div className="font-mono" style={{ color: '#0F0F10', fontSize: 13 }}>
              {sourceGramsNum.toFixed(3)}g {sourceKarat} ({(conversionPreview.sourcePurity * 100).toFixed(1)}%)
              {' = '}
              <strong>{conversionPreview.targetEquivalent.toFixed(3)}g {karat}-equivalent</strong>
            </div>
            <div style={{ color: '#6B7280', fontSize: 11, marginTop: 4 }}>
              = {(sourceGramsNum * conversionPreview.sourcePurity).toFixed(3)}g pure gold · {conversionPreview.verdict === 'exact'
                ? <>Payable wird vollstaendig beglichen ({remainingGrams.toFixed(3)}g {karat}).</>
                : <>Payable wird mit {conversionPreview.targetEquivalent.toFixed(3)}g {karat} fulfilled.</>}
            </div>
            <div style={{ color: '#6B7280', fontSize: 11, marginTop: 2 }}>
              Fuer volle Begleichung: {conversionPreview.exactSourceGrams.toFixed(3)}g {sourceKarat}.
            </div>
          </div>
        )}

        {needsBhd && (
          <Input label="AGREED BHD" type="number" step="0.001" value={bhd} data-gold-settle-bhd
            onChange={e => setBhd(e.target.value)} autoFocus />
        )}

        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>NOTES (optional)</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} data-gold-settle-notes
            rows={2}
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #D5D9DE', borderRadius: 4,
                     fontSize: 13, color: '#0F0F10', background: 'transparent', resize: 'vertical' }} />
        </div>

        {shownError && (
          <div data-gold-settle-error style={{ padding: '8px 10px', background: 'rgba(220,38,38,0.06)',
                        border: '1px solid rgba(220,38,38,0.3)', borderRadius: 6,
                        fontSize: 12, color: '#DC2626' }}>{shownError}</div>
        )}

        <div className="flex justify-end gap-3" style={{ paddingTop: 10, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleConfirm()} disabled={w.busy} data-gold-settle-confirm>Confirm</Button>
        </div>
      </div>
    </Modal>
  );
}

// v0.7.7 — Shared Pay-Expense Modal.
//
// Vorher lebte das Modal inline in ExpenseList. Jetzt wiederverwendet von
// SupplierDetail (Workshop & Service Costs Pay-Button), RepairDetail (A/P-
// Chip-Klick) und OrderDetail (A/P-Chip-Klick). Eine UI, eine SSOT-Action.
//
// CENTRAL-UI-PARITY R6D — „Record Payment" ist EINE Buchung (`expenses.record_payment`): am Primary
// die Hausfolge in der Schreibreihenfolge, auf PC2 die Fernbuchung. Mehr als offen wird vom Haus
// abgewiesen (vorher still auf den Rest gekappt, waehrend die Maske den vollen Betrag meldete). Das
// Modal schliesst NUR bei Erfolg; ein Fehler bleibt stehen. Alle vier Einstiege erben das hier.
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { computeExpenseSettlement } from '@/core/finance/expenseSettlement';
import { useSharedRead } from '@/core/data/shared-read';
import { creditPaidFor } from '@/core/data/domain-reads';
import { useSharedWrite, fehlertext } from '@/core/data/shared-write';
import { WriteError } from '@/components/shared/WriteError';
import { PAYABLES_OP } from '@/core/payables/payables-house';
import { saveExpensePayment } from '@/core/payables/payables-save';

interface PayExpenseModalProps {
  expenseId: string | null;
  onClose: () => void;
  /** Optional callback after successful payment (e.g. local refresh). */
  onPaid?: () => void;
}

type PayMethod = 'cash' | 'bank' | 'benefit';

export function PayExpenseModal({ expenseId, onClose, onPaid }: PayExpenseModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const loadExpenses = useExpenseStore(s => s.loadExpenses);
  const zahlen = useSharedWrite<Record<string, unknown>>(PAYABLES_OP.EXPENSES_RECORD_PAYMENT);
  const [fehler, setFehler] = useState('');

  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');

  const exp = expenseId ? expenses.find(e => e.id === expenseId) : null;
  // Settlement-SSOT: Rest = amount − (cash + credit). credit_paid einzeln (eine Expense → eine Query,
  // kein N+1). Ohne den credit-Anteil koennte das Modal Cash auf eine bereits credit-beglichene
  // Expense ueber-einziehen und zeigte einen falschen Restbetrag.
  // Dieselbe Kernauskunft wie die Liste — eine Anfrage, keine je Beleg.
  const guthaben = useSharedRead('expenses.credit_paid.get', {}, creditPaidFor, { byExpense: {} }, [expenseId, expenses]);
  const creditPaid = expenseId ? (guthaben.byExpense[expenseId] || 0) : 0;
  const settlement = exp ? computeExpenseSettlement(exp.amount, exp.paidAmount || 0, creditPaid, exp.status) : null;
  const remaining = settlement ? settlement.remaining : 0;

  // R6D — beim Oeffnen den Stand frisch holen: die Fassung, die „Record Payment" nennt, soll die
  // aktuelle sein (auch wenn das Modal aus Reparatur/Auftrag kommt, die die Liste nicht laden).
  useEffect(() => {
    if (expenseId) loadExpenses();
  }, [expenseId, loadExpenses]);

  // Wenn das Modal mit einer neuen expenseId oeffnet, Form mit Restbetrag +
  // Default-Methode vorbelegen. effect statt useState-Init damit ein
  // wiederholtes Oeffnen mit einer anderen Expense den State neu seedet.
  useEffect(() => {
    setFehler('');
    if (exp) {
      setAmount(remaining);
      setMethod((exp.paymentMethod as PayMethod) || 'bank');
    } else {
      setAmount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseId]);

  async function handleSubmit() {
    if (!expenseId || amount <= 0 || zahlen.busy) return;
    if (!exp) { setFehler('This expense is not loaded yet — close and open it again.'); return; }
    setFehler('');
    const r = await saveExpensePayment(zahlen, exp, amount, method);
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    onPaid?.();
    onClose();
  }

  return (
    <Modal open={!!expenseId} onClose={onClose} title="Record Expense Payment" width={420}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {exp && (
          <div style={{ padding: '10px 12px', background: '#F2F7FA', borderRadius: 8, fontSize: 12, color: '#4B5563' }}>
            <div className="flex justify-between">
              <span>Expense:</span>
              <span className="font-mono" style={{ color: '#0F0F10' }}>{exp.expenseNumber}</span>
            </div>
            {exp.description && (
              <div className="flex justify-between" style={{ marginTop: 4 }}>
                <span>Description:</span>
                <span style={{ color: '#0F0F10', maxWidth: 220, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {exp.description}
                </span>
              </div>
            )}
            <div className="flex justify-between" style={{ marginTop: 4 }}>
              <span>Total:</span>
              <span className="font-mono"><Bhd v={exp.amount}/> BHD</span>
            </div>
            <div className="flex justify-between" style={{ marginTop: 4 }}>
              <span>Already paid (cash):</span>
              <span className="font-mono" style={{ color: '#16A34A' }}><Bhd v={exp.paidAmount || 0}/> BHD</span>
            </div>
            {creditPaid > 0 && (
              <div className="flex justify-between" style={{ marginTop: 4 }}>
                <span>Credit applied:</span>
                <span className="font-mono" style={{ color: '#715DE3' }}><Bhd v={creditPaid}/> BHD</span>
              </div>
            )}
            <div className="flex justify-between" style={{ marginTop: 4 }}>
              <span>Remaining:</span>
              <span className="font-mono" style={{ color: '#DC2626' }}><Bhd v={remaining}/> BHD</span>
            </div>
          </div>
        )}
        <Input
          required
          label="PAYMENT AMOUNT (BHD)"
          type="number"
          step="0.01"
          value={amount || ''}
          disabled={zahlen.busy}
          onChange={e => setAmount(parseFloat(e.target.value) || 0)}
          data-expense-pay-amount
        />
        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            {(['cash', 'bank', 'benefit'] as const).map(m => {
              const active = method === m;
              return (
                <button
                  key={m}
                  onClick={() => !zahlen.busy && setMethod(m)}
                  disabled={zahlen.busy}
                  data-expense-pay-method={m}
                  className="cursor-pointer rounded"
                  style={{
                    padding: '8px 16px',
                    fontSize: 13,
                    border: `1px solid ${active ? '#0F0F10' : '#D5D9DE'}`,
                    color: active ? '#0F0F10' : '#6B7280',
                    background: active ? 'rgba(15,15,16,0.06)' : 'transparent',
                  }}
                >
                  {m === 'cash' ? 'Cash' : m === 'bank' ? 'Bank' : 'Benefit'}
                </button>
              );
            })}
          </div>
        </div>
        <WriteError text={fehler} />
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose} disabled={zahlen.busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={amount <= 0 || zahlen.busy} data-expense-pay-save>
            {zahlen.busy ? 'Saving…' : 'Record Payment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

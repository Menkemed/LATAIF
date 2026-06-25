// v0.7.7 — Shared Pay-Expense Modal.
//
// Vorher lebte das Modal inline in ExpenseList. Jetzt wiederverwendet von
// SupplierDetail (Workshop & Service Costs Pay-Button), RepairDetail (A/P-
// Chip-Klick) und OrderDetail (A/P-Chip-Klick). Eine UI, eine SSOT-Action
// (`recordExpensePayment`) — Cross-Store-Reload triggert die anderen Views
// automatisch via expenseStore.recordExpensePayment.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Bhd } from '@/components/ui/Bhd';
import { useExpenseStore } from '@/stores/expenseStore';
import { computeExpenseSettlement, creditPaidForExpense } from '@/core/finance/expenseSettlement';

interface PayExpenseModalProps {
  expenseId: string | null;
  onClose: () => void;
  /** Optional callback after successful payment (e.g. local refresh). */
  onPaid?: () => void;
}

type PayMethod = 'cash' | 'bank' | 'benefit';

export function PayExpenseModal({ expenseId, onClose, onPaid }: PayExpenseModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const recordExpensePayment = useExpenseStore(s => s.recordExpensePayment);

  const [amount, setAmount] = useState<number>(0);
  const [method, setMethod] = useState<PayMethod>('bank');

  const exp = expenseId ? expenses.find(e => e.id === expenseId) : null;
  // Settlement-SSOT: Rest = amount − (cash + credit). credit_paid einzeln (eine Expense → eine Query,
  // kein N+1). Ohne den credit-Anteil koennte das Modal Cash auf eine bereits credit-beglichene
  // Expense ueber-einziehen und zeigte einen falschen Restbetrag.
  const creditPaid = useMemo(() => (expenseId ? creditPaidForExpense(expenseId) : 0), [expenseId, expenses]);
  const settlement = exp ? computeExpenseSettlement(exp.amount, exp.paidAmount || 0, creditPaid, exp.status) : null;
  const remaining = settlement ? settlement.remaining : 0;

  // Wenn das Modal mit einer neuen expenseId oeffnet, Form mit Restbetrag +
  // Default-Methode vorbelegen. effect statt useState-Init damit ein
  // wiederholtes Oeffnen mit einer anderen Expense den State neu seedet.
  useEffect(() => {
    if (exp) {
      setAmount(remaining);
      setMethod((exp.paymentMethod as PayMethod) || 'bank');
    } else {
      setAmount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseId]);

  function handleSubmit() {
    if (!expenseId || amount <= 0) return;
    try {
      recordExpensePayment(expenseId, amount, method);
      onPaid?.();
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
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
          onChange={e => setAmount(parseFloat(e.target.value) || 0)}
        />
        <div>
          <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
          <div className="flex gap-2" style={{ marginTop: 6 }}>
            {(['cash', 'bank', 'benefit'] as const).map(m => {
              const active = method === m;
              return (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
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
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={amount <= 0}>Record Payment</Button>
        </div>
      </div>
    </Modal>
  );
}

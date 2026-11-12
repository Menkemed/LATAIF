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
//
// Owner 12.11.2026 — je Zahlung der Tag, an dem WIRKLICH bezahlt wurde (vorbelegt heute; nicht in der Zukunft, nicht vor
// der Ausgabe), und mehrere Zahlwege in EINER Zahlung (z. B. 300 Cash + 200 Bank, je mit eigenem Tag) — atomar gebucht.
// Eine einzelne Zeile reist wie bisher (amount/method), ein gewählter Tag nur, wenn er nicht heute ist.
import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
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
import { saveExpensePayment, saveExpensePayments } from '@/core/payables/payables-save';
import { usePermission } from '@/hooks/usePermission';
import { latestBusinessDate, todayIso } from '@/core/utils/business-date';

interface PayExpenseModalProps {
  expenseId: string | null;
  onClose: () => void;
  /** Optional callback after successful payment (e.g. local refresh). */
  onPaid?: () => void;
}

type PayMethod = 'cash' | 'bank' | 'benefit';
interface PayRow { amount: number; method: PayMethod; date: string }
const METHODS: readonly PayMethod[] = ['cash', 'bank', 'benefit'];
const MAX_ROWS = 5;
const F = (n: number): number => Math.round((Number(n) || 0) * 1000);

export function PayExpenseModal({ expenseId, onClose, onPaid }: PayExpenseModalProps) {
  const expenses = useExpenseStore(s => s.expenses);
  const loadExpenses = useExpenseStore(s => s.loadExpenses);
  const zahlen = useSharedWrite<Record<string, unknown>>(PAYABLES_OP.EXPENSES_RECORD_PAYMENT);
  const perm = usePermission();
  const [fehler, setFehler] = useState('');
  const [rows, setRows] = useState<PayRow[]>([{ amount: 0, method: 'bank', date: todayIso() }]);

  const exp = expenseId ? expenses.find(e => e.id === expenseId) : null;
  // Settlement-SSOT: Rest = amount − (cash + credit). credit_paid einzeln (eine Expense → eine Query,
  // kein N+1). Ohne den credit-Anteil koennte das Modal Cash auf eine bereits credit-beglichene
  // Expense ueber-einziehen und zeigte einen falschen Restbetrag.
  // Dieselbe Kernauskunft wie die Liste — eine Anfrage, keine je Beleg.
  const guthaben = useSharedRead('expenses.credit_paid.get', {}, creditPaidFor, { byExpense: {} }, [expenseId, expenses]);
  const creditPaid = expenseId ? (guthaben.byExpense[expenseId] || 0) : 0;
  const settlement = exp ? computeExpenseSettlement(exp.amount, exp.paidAmount || 0, creditPaid, exp.status) : null;
  const remaining = settlement ? settlement.remaining : 0;
  const minDate = exp?.expenseDate ? exp.expenseDate.slice(0, 10) : undefined;
  const sumF = rows.reduce((s, r) => s + F(r.amount), 0);
  const zuViel = sumF > F(remaining);
  const ungueltig = rows.some((r) => !(F(r.amount) > 0) || !r.date);

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
    setRows([{ amount: exp ? remaining : 0, method: ((exp?.paymentMethod as PayMethod) || 'bank'), date: todayIso() }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expenseId]);

  const setRow = (i: number, patch: Partial<PayRow>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  function addRow() {
    setRows((rs) => {
      if (rs.length >= MAX_ROWS) return rs;
      const offen = Math.max(0, F(remaining) - rs.reduce((s, r) => s + F(r.amount), 0)) / 1000;
      const frei = METHODS.find((m) => !rs.some((r) => r.method === m)) ?? 'bank';
      return [...rs, { amount: offen, method: frei, date: todayIso() }];
    });
  }

  async function handleSubmit() {
    if (!expenseId || ungueltig || zuViel || zahlen.busy) return;
    if (!exp) { setFehler('This expense is not loaded yet — close and open it again.'); return; }
    setFehler('');
    const heute = todayIso();
    const r = rows.length === 1
      ? await saveExpensePayment(zahlen, exp, rows[0].amount, rows[0].method, undefined, rows[0].date !== heute ? rows[0].date : undefined)
      : await saveExpensePayments(zahlen, exp, rows.map((x) => ({ amount: x.amount, method: x.method, ...(x.date !== heute ? { paidDate: x.date } : {}) })));
    if (r.kind !== 'ok') { setFehler(fehlertext(r)); return; }
    onPaid?.();
    onClose();
  }

  return (
    <Modal open={!!expenseId} onClose={onClose} title="Record Expense Payment" width={rows.length > 1 ? 520 : 440}>
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
        {rows.map((r, i) => (
          <div key={i} data-expense-pay-row={i}
            style={{ display: 'flex', flexDirection: 'column', gap: 10, ...(rows.length > 1 ? { padding: 12, border: '1px solid #E5E9EE', borderRadius: 8 } : {}) }}>
            {rows.length > 1 && (
              <div className="flex justify-between items-center">
                <span className="text-overline">PAYMENT {i + 1}</span>
                <button type="button" onClick={() => !zahlen.busy && setRows((rs) => rs.filter((_, k) => k !== i))} disabled={zahlen.busy}
                  className="cursor-pointer" data-expense-pay-remove={i} title="Remove this payment"
                  style={{ padding: 2, background: 'transparent', border: 'none', color: '#6B7280' }}>
                  <X size={14} />
                </button>
              </div>
            )}
            <div className="flex gap-3">
              <div style={{ flex: 1 }}>
                <Input
                  required
                  label="PAYMENT AMOUNT (BHD)"
                  type="number"
                  step="0.01"
                  value={r.amount || ''}
                  disabled={zahlen.busy}
                  onChange={e => setRow(i, { amount: parseFloat(e.target.value) || 0 })}
                  data-expense-pay-amount
                />
              </div>
              <div style={{ flex: 1 }}>
                <Input
                  required
                  label="PAYMENT DATE"
                  type="date"
                  value={r.date}
                  max={latestBusinessDate()}
                  min={minDate}
                  disabled={zahlen.busy}
                  onChange={e => setRow(i, { date: e.target.value })}
                  data-expense-pay-date
                />
              </div>
            </div>
            <div>
              <span className="text-overline" style={{ marginBottom: 6, display: 'block' }}>METHOD</span>
              <div className="flex gap-2" style={{ marginTop: 6 }}>
                {METHODS.map(m => {
                  const active = r.method === m;
                  return (
                    <button
                      key={m}
                      onClick={() => !zahlen.busy && setRow(i, { method: m })}
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
          </div>
        ))}
        {rows.length < MAX_ROWS && (
          <button type="button" onClick={addRow} disabled={zahlen.busy} className="cursor-pointer" data-expense-pay-add
            style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', fontSize: 12,
              color: '#0F0F10', background: 'transparent', border: '1px dashed #D5D9DE', borderRadius: 6 }}>
            <Plus size={12} /> Add payment method
          </button>
        )}
        {rows.length > 1 && (
          <div className="flex justify-between" style={{ fontSize: 13 }} data-expense-pay-sum>
            <span style={{ color: '#6B7280' }}>Total of {rows.length} payments</span>
            <span className="font-mono" style={{ color: zuViel ? '#DC2626' : '#0F0F10' }}><Bhd v={sumF / 1000}/> BHD</span>
          </div>
        )}
        {zuViel && (
          <div style={{ fontSize: 12, color: '#DC2626' }} data-expense-pay-too-much>
            The payments are more than what is open on this expense (<Bhd v={remaining}/> BHD).
          </div>
        )}
        {/* B2/B3 Sicherheitsabschluss — Geld für eine Ausgabe: dasselbe Recht wie jede Zahlung (payments.* oder Admin). */}
        {!perm.canRecordPayments && (
          <div style={{ fontSize: 12, color: '#92400E', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 8, padding: '8px 10px' }} data-expense-pay-no-right>
            Your role may not record payments. A manager, accountant or the owner records this payment.
          </div>
        )}
        <WriteError text={fehler} />
        <div className="flex justify-end gap-3" style={{ paddingTop: 12, borderTop: '1px solid #E5E9EE' }}>
          <Button variant="ghost" onClick={onClose} disabled={zahlen.busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={ungueltig || zuViel || zahlen.busy || !perm.canRecordPayments} data-expense-pay-save>
            {zahlen.busy ? 'Saving…' : 'Record Payment'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

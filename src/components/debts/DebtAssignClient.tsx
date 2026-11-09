// ════════════════════════════════════════════════════════════════════════════
// CUSTOMER ACCOUNT A2 (P2) — „Assign to client" für ein Darlehen OHNE Kunde: Kunde bewusst auswählen, bestätigen.
// Geschrieben wird nur `debts.customer_id` (Primary: Hausfunktion, PC2: `debts.update` mit `assignCustomerId` und der
// gesehenen Fassung), mit Protokoll. Betrag, Zahlungen, Status, Freitext der Gegenpartei und Buchung bleiben.
// Ein schon zugeordnetes Darlehen bekommt diesen Block nicht — es wird hier nie umgehängt.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useCustomerStore } from '@/stores/customerStore';
import { useSharedWrites, fehlertext } from '@/core/data/shared-write';
import { saveDebtAssignCustomer } from '@/core/finance/money-save';

const nameOf = (c: { firstName?: string; lastName?: string; company?: string }): string =>
  `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim() || c.company || '—';

export function DebtAssignClient({ debt, onDone }: {
  debt: { id: string; revision?: number; counterparty?: string; loanNumber?: string };
  onDone: () => void;
}) {
  const customers = useCustomerStore((s) => s.customers);
  const w = useSharedWrites();
  const [wahl, setWahl] = useState('');
  const [fehler, setFehler] = useState('');
  const sortiert = useMemo(() => [...customers].sort((a, b) => nameOf(a).localeCompare(nameOf(b))), [customers]);

  async function zuordnen() {
    const c = customers.find((x) => x.id === wahl);
    if (!c) return;
    setFehler('');
    const ok = await window.confirm(`Assign loan ${debt.loanNumber || ''} (counterparty “${debt.counterparty || ''}”) to client "${nameOf(c)}"?\n\nOnly the client link is saved — amount, repayments, status and bookings stay as they are. It cannot be moved to another client afterwards.`);
    if (!ok) return;
    const r = await saveDebtAssignCustomer(w, { id: debt.id, revision: debt.revision }, c.id);
    if (r.kind !== 'ok') { setFehler(`Could not assign: ${fehlertext(r)}`); return; }
    setWahl('');
    onDone();
  }

  return (
    <div style={{ border: '1px dashed #F5C78E', background: '#FFFBF3', borderRadius: 10, padding: 12 }} data-debt-assign={debt.id}>
      <div style={{ fontSize: 12, color: '#7A5B1E', marginBottom: 8 }}>
        This loan is not linked to a client (counterparty text only). Choose the client deliberately — nothing is matched by name.
      </div>
      <div className="flex items-center gap-2">
        <select value={wahl} onChange={(e) => setWahl(e.target.value)} data-debt-assign-select
          style={{ flex: 1, minWidth: 0, padding: '8px 10px', border: '1px solid #D5D9DE', borderRadius: 6, fontSize: 13, background: '#fff' }}>
          <option value="">Choose the client…</option>
          {sortiert.map((c) => <option key={c.id} value={c.id}>{nameOf(c)}{c.phone ? ` · ${c.phone}` : ''}</option>)}
        </select>
        <Button variant="secondary" disabled={!wahl || w.busy} onClick={() => void zuordnen()} data-debt-assign-go>Assign to client</Button>
      </div>
      {fehler && <div style={{ fontSize: 12, color: '#DC2626', marginTop: 6 }} data-debt-assign-error>{fehler}</div>}
    </div>
  );
}

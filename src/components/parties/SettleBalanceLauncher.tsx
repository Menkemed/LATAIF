// ════════════════════════════════════════════════════════════════════════════
// B2/B3 — „Settle Balance" von der Rechnung (A) und vom Einkauf (B): DERSELBE Dialog wie im Kundenkonto (C), dieselbe
// Auskunft (`parties.account.get`, view customer_account — am PC2 vom Primary), dieselbe Buchung (`customers.settle_balance`,
// eine STL, atomar). Nur die Vorauswahl unterscheidet sich: von der Rechnung genau diese Rechnung (Gegenposten alle, V7),
// vom Einkauf genau dieser Einkauf (Rechnungen alle, älteste zuerst). Häkchen bleiben frei.
// ════════════════════════════════════════════════════════════════════════════
import { useState } from 'react';
import { useSharedRead } from '@/core/data/shared-read';
import { OP_PARTIES_ACCOUNT_GET, partyAccountReadFor, type PartyAccountRead } from '@/core/parties/party-account';
import { CUSTOMER_ACCOUNT_VIEW } from '@/core/parties/customer-account';
import type { SettlementBooked } from '@/core/offsets/party-settlement';
import { SettleBalanceModal } from './SettleBalanceModal';

export function SettleBalanceLauncher({ customerId, focus, onClose, onDone }: {
  customerId: string;
  focus: { invoiceId?: string; sourceId?: string };
  onClose: () => void;
  onDone: (b: SettlementBooked) => void;
}) {
  const [tick, setTick] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const params = { partyType: 'CUSTOMER', partyId: customerId, view: CUSTOMER_ACCOUNT_VIEW, v: tick };
  const read = useSharedRead<PartyAccountRead | null>(
    OP_PARTIES_ACCOUNT_GET, params,
    (ctx) => partyAccountReadFor(ctx, { partyType: 'CUSTOMER', partyId: customerId, view: CUSTOMER_ACCOUNT_VIEW }),
    null, [customerId, tick],
  );
  const acc = read?.customerAccount ?? null;
  const settle = read?.settleBalance ?? null;
  if (!acc || !settle) return null;
  return (
    <SettleBalanceModal
      key={settle.stamp}
      customerName={acc.customer.name}
      data={settle}
      focus={focus}
      totals={{ owesUs: acc.owesUs.total, weOwe: acc.weOwe.total, net: acc.net }}
      notOffered={[]}
      notice={notice}
      onClose={onClose}
      onDone={onDone}
      onStale={() => {
        setNotice('The open items changed in the meantime (another payment, offset or change). Nothing was booked — this is the proposal for the current state. Check it and confirm again.');
        setTick((t) => t + 1);
      }}
    />
  );
}

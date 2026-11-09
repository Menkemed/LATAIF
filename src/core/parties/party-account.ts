// OPENING BALANCES + SETTLEMENT — die EINE Auskunft hinter dem Bereich „Opening balances" und „Receive Payment" einer
// Partei (`parties.account.get`): Eröffnungsposten, Vorschau einer Eingabe, offene LATAIF-Belege und — beim Kunden — die
// bezahlbaren Rechnungen. Am Primary lokal, am PC2 vom Primary; die Filiale kommt aus dem Ausweis.
//
// CUSTOMER ACCOUNT A1 — mit `view: 'customer_account'` liefert dieselbe Auskunft beim Kunden zusätzlich das gemeinsame
// Kundenkonto (`customer-account.ts`, nur lesen). Kein neuer Fernbefehl: Primary und PC2 rechnen über denselben Weg.
import type { BusinessReadContext } from '@/core/data/read-context';
import { partyAccountFor, type PartyAccount } from './opening-balances';
import { customerSettlementFor, type CustomerSettlementRead } from './customer-settlement';
import { customerAccountFor, CUSTOMER_ACCOUNT_VIEW, type CustomerAccount } from './customer-account';
import { settleBalanceFor, type SettleBalanceRead } from '@/core/offsets/party-settlement-reads';

export const OP_PARTIES_ACCOUNT_GET = 'parties.account.get';
export const OP_PAGE_OPENING_BALANCES_GET = 'page.opening_balances.get';

// CUSTOMER ACCOUNT C — mit derselben view zusätzlich „Settle Balance" (angebotene Posten beider Seiten, Fingerabdruck, Verrechnungen).
export type PartyAccountRead = PartyAccount & { settlement: CustomerSettlementRead | null; customerAccount?: CustomerAccount | null; settleBalance?: SettleBalanceRead | null };

export function partyAccountReadFor(ctx: BusinessReadContext | { branchId: string }, input: { partyType?: unknown; partyId?: unknown; preview?: unknown; view?: unknown }): PartyAccountRead {
  const account = partyAccountFor(ctx, input);
  const out: PartyAccountRead = {
    ...account,
    settlement: account.party.type === 'CUSTOMER' ? customerSettlementFor(ctx, account.party.id) : null,
  };
  if (input.view === CUSTOMER_ACCOUNT_VIEW) {
    out.customerAccount = account.party.type === 'CUSTOMER' ? customerAccountFor(ctx, account.party.id) : null;
    out.settleBalance = account.party.type === 'CUSTOMER' ? settleBalanceFor(ctx, account.party.id) : null;
  }
  return out;
}

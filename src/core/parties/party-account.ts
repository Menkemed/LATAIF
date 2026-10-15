// OPENING BALANCES + SETTLEMENT — die EINE Auskunft hinter dem Bereich „Opening balances" und „Receive Payment" einer
// Partei (`parties.account.get`): Eröffnungsposten, Vorschau einer Eingabe, offene LATAIF-Belege und — beim Kunden — die
// bezahlbaren Rechnungen. Am Primary lokal, am PC2 vom Primary; die Filiale kommt aus dem Ausweis.
import type { BusinessReadContext } from '@/core/data/read-context';
import { partyAccountFor, type PartyAccount } from './opening-balances';
import { customerSettlementFor, type CustomerSettlementRead } from './customer-settlement';

export const OP_PARTIES_ACCOUNT_GET = 'parties.account.get';
export const OP_PAGE_OPENING_BALANCES_GET = 'page.opening_balances.get';

export type PartyAccountRead = PartyAccount & { settlement: CustomerSettlementRead | null };

export function partyAccountReadFor(ctx: BusinessReadContext | { branchId: string }, input: { partyType?: unknown; partyId?: unknown; preview?: unknown }): PartyAccountRead {
  const account = partyAccountFor(ctx, input);
  return {
    ...account,
    settlement: account.party.type === 'CUSTOMER' ? customerSettlementFor(ctx, account.party.id) : null,
  };
}

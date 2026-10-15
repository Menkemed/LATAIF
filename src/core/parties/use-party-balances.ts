// PARTY-BALANCES S0 — die Salden für eine Fläche, am Primary lokal, am PC2 vom Primary. „Noch nicht da"
// und „geht gerade nicht" sind `null` — die Fläche zeigt dann „—", nie 0,000.
import { useMemo } from 'react';
import { useSharedRead } from '@/core/data/shared-read';
import { OP_PARTIES_BALANCES_GET, partyBalancesFor, type CustomerBalance, type PartyBalances, type SupplierLedger } from './party-balances';

export interface PartyBalanceLookup {
  /** `null` = unbekannt (lädt, Fehler oder nicht in dieser Filiale). */
  customer(id: string | undefined): CustomerBalance | null;
  supplier(id: string | undefined): SupplierLedger | null;
  /** Die Auskunft ist da (auch wenn ein einzelner Eintrag fehlt). */
  loaded: boolean;
}

/**
 * `v` ist ein Auffrischzähler: ändert er sich, fragt PC2 neu (am Primary rechnet `deps` neu).
 */
export function usePartyBalances(
  ids: { customerIds?: readonly string[]; supplierIds?: readonly string[] },
  deps: readonly unknown[] = [],
  v: string | number = 0,
): PartyBalanceLookup {
  const customerIds = useMemo(() => [...new Set(ids.customerIds ?? [])].filter(Boolean).sort(), [ids.customerIds]);
  const supplierIds = useMemo(() => [...new Set(ids.supplierIds ?? [])].filter(Boolean).sort(), [ids.supplierIds]);
  const params = { customerIds, supplierIds, v };
  const data = useSharedRead<PartyBalances | null>(
    OP_PARTIES_BALANCES_GET, params,
    (ctx) => partyBalancesFor(ctx, { customerIds, supplierIds }),
    null,
    [customerIds.join(','), supplierIds.join(','), v, ...deps],
  );
  return useMemo(() => {
    const c = new Map(data?.customers ?? []);
    const s = new Map(data?.suppliers ?? []);
    return {
      customer: (id) => (id && data ? c.get(id) ?? null : null),
      supplier: (id) => (id && data ? s.get(id) ?? null : null),
      loaded: data !== null,
    };
  }, [data]);
}

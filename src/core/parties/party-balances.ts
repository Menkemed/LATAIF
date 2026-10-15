// ════════════════════════════════════════════════════════════════════════════
// PARTY-BALANCES S0 — die Salden von Kunden und Lieferanten aus EINER Rechnung, am Primary und am PC2.
//
// Vorher rechneten Kundendetail, Kundenliste, Lieferantendetail und das Guthaben auf der Rechnung lokal
// (`getCustomerStats`, `getAvailableCredit`, `getLedger`). Auf dem PC2 gibt es keine Datenbank: der Fehler
// wurde abgefangen und die Fläche zeigte 0,000 — „nichts offen", obwohl offen war.
//
// Jetzt fragt jede dieser Flächen `parties.balances.get`. Am Primary läuft dieselbe Ladefunktion lokal, am
// PC2 auf dem Primary — mit dem geprüften Ausweis des Anfragenden (Filialgrenze). Kein Ergebnis heißt
// „unbekannt" (`null`), nie 0.
// ════════════════════════════════════════════════════════════════════════════
import type { BusinessReadContext } from '@/core/data/read-context';
import { query } from '@/core/db/helpers';
import { customerStatsFor, customerStoreCreditFor, type CustomerStats } from '@/stores/customerStore';
import { supplierLedgerStrict, type SupplierLedger } from '@/stores/supplierStore';

export const OP_PARTIES_BALANCES_GET = 'parties.balances.get';

/** Die Kennzahlen eines Kunden plus sein einlösbares Store-Guthaben. */
export type CustomerBalance = CustomerStats & { storeCredit: number };
export type { SupplierLedger };

export interface PartyBalances {
  /** Paare statt Map — eine Map überlebt den Weg über das Netz nicht. */
  customers: Array<[string, CustomerBalance]>;
  suppliers: Array<[string, SupplierLedger]>;
}

export class PartyBalancesInputError extends Error {
  readonly code = 'PARTY_BALANCES_INPUT_INVALID';
  constructor(message: string) { super(message); this.name = 'PartyBalancesInputError'; }
}

/** Höchstens so viele Kennungen je Anfrage — eine Liste, kein Abzug der ganzen Datenbank. */
export const PARTY_BALANCES_MAX_IDS = 5000;

function idList(raw: unknown, what: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PartyBalancesInputError(`${what} must be a list`);
  if (raw.length > PARTY_BALANCES_MAX_IDS) throw new PartyBalancesInputError(`${what}: at most ${PARTY_BALANCES_MAX_IDS} per request`);
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string' || v.trim() === '' || v.length > 200) throw new PartyBalancesInputError(`${what}: every id is text`);
    out.add(v);
  }
  return [...out];
}

/**
 * Die Salden der genannten Kunden und Lieferanten in der Filiale des Ausweises. Eine Kennung einer anderen
 * Filiale (oder eine unbekannte) fehlt in der Antwort — sie wird nicht als 0 gemeldet.
 */
export function partyBalancesFor(ctx: BusinessReadContext, input: { customerIds?: unknown; supplierIds?: unknown }): PartyBalances {
  const customerIds = idList(input.customerIds, 'customerIds');
  const supplierIds = idList(input.supplierIds, 'supplierIds');
  const customers: Array<[string, CustomerBalance]> = [];
  for (const id of customerIds) {
    const stats = customerStatsFor(ctx, id);
    if (!stats) continue;
    customers.push([id, { ...stats, storeCredit: customerStoreCreditFor(ctx, id) }]);
  }
  const suppliers: Array<[string, SupplierLedger]> = [];
  for (const id of supplierIds) {
    if (!query('SELECT 1 FROM suppliers WHERE id = ? AND branch_id = ?', [id, ctx.branchId])[0]) continue;
    suppliers.push([id, supplierLedgerStrict(id, ctx.branchId)]);
  }
  return { customers, suppliers };
}

// B5 — With-Agent Sellability Guard (reiner Kern, testbar ohne DB).
//
// Ein Produkt mit stock_status `with_agent` (physisch beim Agenten) darf NICHT ueber den
// normalen Invoice-Pfad (Direct Invoice / Order-Convert / Offer / Edit) fakturiert oder
// als verkauft markiert werden — sonst entsteht ein Doppelverkauf (das Stueck ist beim
// Agenten UND wird im Laden nochmal verkauft).
//
// Erlaubt wird es erst nach dem bestehenden Agent-Return-Prozess, der den Status wieder in
// einen verkaufsfaehigen Zustand versetzt — ODER ueber den kanonischen Agent-Settlement-Pfad
// (agentStore.convertTransferToInvoice / convertTransfersToInvoice), der DAS legitime
// Fakturieren eines with_agent-Stuecks ist und diesen Guard deshalb bewusst umgeht.
//
// Keine automatische Statusaenderung, kein stilles Zurueckholen — der Guard wirft nur.
// SSOT-Meldung, damit UI-Vorwarnung und harte Store-Grenze dieselbe Sprache sprechen.

export const WITH_AGENT_INVOICE_BLOCKED_MESSAGE =
  'Cannot invoice product while it is with an agent. Return it from the agent first.';

// stock_status-Werte, die „beim Agenten" bedeuten (Roh + Legacy-Schreibweise; canonicalStockStatus
// mappt beide → GIVEN_TO_AGENT). BEWUSST nur diese: in_repair/consignment/consignment_reserved/
// reserved haben eigene legitime Invoice-Pfade und werden hier NICHT geblockt.
const WITH_AGENT_STATUSES = new Set(['with_agent', 'given_to_agent']);

export interface SellabilityProduct {
  id: string;
  stockStatus?: string | null;
}

// Gibt das erste Produkt zurueck, das beim Agenten ist (→ Invoice blockieren), sonst null.
// Rein: der Aufrufer reicht die (frisch geladenen) Produkte rein; kein DB-Zugriff hier.
export function firstProductWithAgent(products: SellabilityProduct[]): SellabilityProduct | null {
  for (const p of products) {
    const s = (p.stockStatus || '').trim().toLowerCase();
    if (WITH_AGENT_STATUSES.has(s)) return p;
  }
  return null;
}

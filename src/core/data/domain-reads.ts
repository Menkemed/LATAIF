// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4A — was eine Seite über eine KERNFUNKTION liest.
//
// R2D hat die Abfragen aus den Seiten geholt und danach gezählt, was noch in Seiten steht. Der
// erste Lauf an zwei echten Rechnern hat gezeigt, dass diese Zählung am Kern vorbeigeht: eine
// Seite liest auch, wenn sie `balanceOf`, `receivablesBreakdown` oder `getStockAggregates` ruft.
// Die Übersicht tat genau das — und stürzte auf einem Rechner ohne Datenbank ab, worauf die
// Fehlergrenze stehen blieb und JEDE weitere Seite leer aussah.
//
// Hier stehen deshalb die wenigen Kernauskünfte, die eine Seite beim Zeichnen wirklich braucht,
// nach demselben Schnitt wie alles andere: zustandsfrei, mit dem Ausweis der Anfrage, von der
// Seite wie von der Fernauskunft benutzt.
//
// Die reinen Rechnungen bleiben, wo sie sind: `computeExpenseSettlement`, `summarizeInventory`,
// `bucketTotals`, `formatLotLabel` rechnen aus übergebenen Zahlen und brauchen keine Datenbank.
// Kopiert wird nichts — was hier steht, ruft die vorhandenen Funktionen auf.
// ════════════════════════════════════════════════════════════════════════════
import { balanceOf, totalReceivables } from '@/core/ledger/queries';
import { receivablesBreakdown, type ReceivableRow } from '@/core/finance/receivables';
import {
  getStockAggregates, getLotsWithPurchaseNumbers, deriveProductCostFromLots,
  type LotAggregate, type StockLot,
} from '@/core/lots/lot-queries';
import { creditPaidByExpense } from '@/core/finance/expenseSettlement';
import type { BusinessReadContext } from '@/core/data/read-context';

// ── Die Salden, die die Übersicht zeigt ──────────────────────────────────
export interface LedgerBalances {
  cash: number;
  bank: number;
  benefit: number;
  supplierPayable: number;
  loanGiven: number;
  loanTaken: number;
  receivables: number;
}
export const LEERE_SALDEN: LedgerBalances = {
  cash: 0, bank: 0, benefit: 0, supplierPayable: 0, loanGiven: 0, loanTaken: 0, receivables: 0,
};

export function ledgerBalancesFor(ctx: BusinessReadContext): LedgerBalances {
  const branchId = ctx.branchId;
  return {
    cash: balanceOf('CASH', { branchId }),
    bank: balanceOf('BANK', { branchId }) + balanceOf('CARD_CLEARING', { branchId }),
    benefit: balanceOf('BENEFIT', { branchId }),
    supplierPayable: Math.max(0, balanceOf('ACCOUNTS_PAYABLE', { branchId, counterpartyType: 'SUPPLIER' })),
    loanGiven: Math.max(0, balanceOf('LOAN_RECEIVABLE', { branchId })),
    loanTaken: Math.max(0, balanceOf('LOAN_PAYABLE', { branchId })),
    receivables: totalReceivables(branchId),
  };
}

// ── Die offenen Forderungen, Zeile für Zeile ─────────────────────────────
//
// `receivablesBreakdown` hatte keine Filialgrenze — dieselbe Sorte Fund wie bei den
// Verbindlichkeiten in R2B. Sie bekommt sie jetzt vom Ausweis.
export interface ReceivableRows { rows: ReceivableRow[] }

export function receivableRowsFor(ctx: BusinessReadContext): ReceivableRows {
  return { rows: receivablesBreakdown(ctx.branchId) };
}

// ── Bestandszahlen aus den Losen ─────────────────────────────────────────
//
// `Map` überlebt den Weg über das Netz nicht — deshalb reisen Paare, und die Seite baut die
// Karte wieder auf. Dieselbe Form auf beiden Rechnern.
export interface FifoKosten { fifoCost: number; weightedAvg: number; lotCount: number }
export interface LotAggregates {
  paare: Array<[string, LotAggregate]>;
  /** Die FIFO-Kosten je Artikel — dieselbe Quelle, ein Durchgang statt einer Abfrage je Zeile. */
  fifo: Array<[string, FifoKosten]>;
}

export function lotAggregatesFor(ctx: BusinessReadContext): LotAggregates {
  void ctx;   // die Lose hängen am Artikel; der Bestand ist bereits filialgebunden geladen
  const paare = [...getStockAggregates().entries()];
  const fifo: Array<[string, FifoKosten]> = [];
  for (const [productId] of paare) {
    const f = deriveProductCostFromLots(productId);
    if (f) fifo.push([productId, f]);
  }
  return { paare, fifo };
}

// ── Die Lose EINES Artikels ──────────────────────────────────────────────
export interface ProductLots {
  lots: Array<StockLot & { purchaseNumber: string | null; supplierId: string | null; supplierName: string | null }>;
  fifo: { fifoCost: number; weightedAvg: number; lotCount: number } | null;
}

export function productLotsFor(ctx: BusinessReadContext, productId: string): ProductLots {
  void ctx;
  return { lots: getLotsWithPurchaseNumbers(productId), fifo: deriveProductCostFromLots(productId) };
}

// ── Wie viel einer Ausgabe mit Guthaben beglichen wurde ──────────────────
export interface CreditPaid { byExpense: Record<string, number> }

export function creditPaidFor(ctx: BusinessReadContext): CreditPaid {
  const byExpense: Record<string, number> = {};
  for (const [id, betrag] of creditPaidByExpense(ctx.branchId)) byExpense[id] = betrag;
  return { byExpense };
}

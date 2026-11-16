// agent-print-helpers (2026-05-18) — Adapter zwischen AgentTransfer-Daten und
// printItemListPdf. Wird von AgentDetail (single) und AgentList (aggregate)
// verwendet damit beide Pages dieselbe Filter-/Format-/Summary-Logik teilen.
import type { Agent, AgentTransfer, Invoice, Customer, Category, Product } from '@/core/models/types';
import { getProductSpecs } from '@/core/utils/product-format';
import {
  printItemListPdf,
  type ItemListFilter,
  type ItemListGroup,
  type ItemListRow,
} from '@/core/pdf/itemListPdf';
import { productDisplayName } from '../products/display-name.ts';
import { approvalRowMoney, approvalStatusLabel, filterApprovalTransfers } from '@/core/agents/approval-rows';

/** Baut eine kompakte "Steel · 40mm · Black Dial · Pre-Owned"-Zeile aus
 *  allen ausgefuellten Kategorie-Attributen + Condition (ohne SKU, weil SKU
 *  schon in einer separaten Print-Spalte landet). */
function buildSpecsLine(product: Product | undefined, categories: Category[]): string | undefined {
  if (!product) return undefined;
  const specs = getProductSpecs(product, categories, {
    includeSku: false,
    includeCondition: true,
    prominentOnly: false,
  });
  if (specs.length === 0) return undefined;
  return specs.map(s => s.value).join(' · ');
}

function fmt3(v: number | null | undefined): string {
  return (v ?? 0).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

// Filter und Statusname sind mit dem Approval-Excel geteilt (approval-rows) — Druck und Excel zeigen dieselben Zeilen.
export { filterApprovalTransfers };
const statusLabel = approvalStatusLabel;

export interface BuildAgentGroupInput {
  agent: Agent;
  transfers: AgentTransfer[];
  invoices: Invoice[];
  products: Product[];
  categories: Category[];
  filter: ItemListFilter;
}

export function buildAgentPrintGroup({ agent, transfers, invoices, products, categories, filter }: BuildAgentGroupInput): ItemListGroup {
  const filtered = filterApprovalTransfers(transfers, filter);
  const rows: ItemListRow[] = filtered.map(t => {
    const linkedInvoice = t.invoiceId ? invoices.find(i => i.id === t.invoiceId) : undefined;
    const product = products.find(p => p.id === t.productId);
    const refOrSerial = product
      ? [
          product.sku,
          (product.attributes as Record<string, unknown> | undefined)?.['reference_number'],
          (product.attributes as Record<string, unknown> | undefined)?.['serial_number'],
        ].filter(Boolean).map(String).join(' · ') || undefined
      : undefined;
    const itemLabel = product ? productDisplayName(product) : '(product not found)';
    const specsLine = buildSpecsLine(product, categories);
    // Dieselbe Geldregel wie Approval-Excel und Approval-Seite: Bezahlt/Offen nur bei verkauften Stücken. Früher
    // wurde hier für JEDEN Transfer eine Forderung gebildet (ohne Verkauf = Our Price) — Stücke beim Kunden oder
    // zurückgegebene standen dadurch mit ihrem Our Price als „Outstanding" im Druck.
    const money = approvalRowMoney(t, linkedInvoice);

    return {
      date: (t.transferredAt || t.createdAt || '').split('T')[0],
      itemLabel,
      specsLine,
      refOrSerial,
      ourPrice: money.ourPrice,
      saleOrPayout: money.salePrice ?? undefined,
      paid: money.paid ?? undefined,
      outstanding: money.outstanding ?? undefined,
      returnDate: t.returnBy ? t.returnBy.split('T')[0] : undefined,
      status: statusLabel(t, linkedInvoice),
    };
  });

  // Summary
  const totalOurPrice = rows.reduce((s, r) => s + (r.ourPrice || 0), 0);
  const totalPaid = rows.reduce((s, r) => s + (r.paid || 0), 0);
  const totalOutstanding = rows.reduce((s, r) => s + (r.outstanding || 0), 0);
  const summaryParts = [
    `${rows.length} item${rows.length === 1 ? '' : 's'}`,
    `Total Our Price: ${fmt3(totalOurPrice)} BHD`,
  ];
  if (totalPaid > 0) summaryParts.push(`Paid: ${fmt3(totalPaid)} BHD`);
  if (totalOutstanding > 0) summaryParts.push(`Outstanding: ${fmt3(totalOutstanding)} BHD`);

  const contactBits = [agent.company, agent.phone, agent.email].filter(Boolean) as string[];

  return {
    heading: agent.name + (agent.company ? ` — ${agent.company}` : ''),
    contact: contactBits.length > 0 ? contactBits.join(' · ') : undefined,
    rows,
    summary: summaryParts.join(' · '),
  };
}

export interface RunApprovalPrintInput {
  filter: ItemListFilter;
  branchName?: string;
  /** single = ein Agent; aggregate = alle Agenten */
  scope: 'single' | 'aggregate';
  /** Bei single: nur dieser Agent. Bei aggregate: alle Agenten mit Items. */
  agents: Agent[];
  /** Alle Transfers — Helper filtert pro Agent. */
  transfers: AgentTransfer[];
  invoices: Invoice[];
  products: Product[];
  /** Fuer die kategorie-spezifische Specs-Zeile unter dem Item-Namen. */
  categories: Category[];
  /** Wenn aggregate: Customers fuer linked-customer (heute ungenutzt, future-proof). */
  customers?: Customer[];
}

export function runApprovalPrint(input: RunApprovalPrintInput): void {
  const { filter, branchName, scope, agents, transfers, invoices, products, categories } = input;
  const groups: ItemListGroup[] = [];
  for (const a of agents) {
    const myTransfers = transfers.filter(t => t.agentId === a.id);
    const g = buildAgentPrintGroup({ agent: a, transfers: myTransfers, invoices, products, categories, filter });
    // Aggregat-Modus: Gruppen ohne matching items weglassen.
    if (scope === 'aggregate' && g.rows.length === 0) continue;
    groups.push(g);
  }
  printItemListPdf({
    kind: 'approval',
    filter,
    branchName,
    groups,
    isAggregate: scope === 'aggregate',
  });
}

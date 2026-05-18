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

export function filterApprovalTransfers(transfers: AgentTransfer[], filter: ItemListFilter): AgentTransfer[] {
  switch (filter) {
    case 'sold':     return transfers.filter(t => t.status === 'sold' || t.status === 'settled');
    case 'open':     return transfers.filter(t => t.status === 'transferred');
    case 'returned': return transfers.filter(t => t.status === 'returned');
    default:         return transfers.slice();
  }
}

function statusLabel(t: AgentTransfer, invoice?: Invoice): string {
  if (t.status === 'returned') return 'Returned';
  if (t.status === 'transferred') return 'On Approval';
  if (t.invoiceId && invoice) {
    const paid = invoice.paidAmount || 0;
    const gross = invoice.grossAmount || 0;
    if (gross > 0 && paid >= gross - 0.005) return 'Settled';
    if (paid > 0.005) return 'Partially Paid';
    return 'Unpaid';
  }
  return t.status.charAt(0).toUpperCase() + t.status.slice(1);
}

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
    const itemLabel = product ? `${product.brand} ${product.name}`.trim() : '(product not found)';
    const specsLine = buildSpecsLine(product, categories);
    const amount = linkedInvoice
      ? linkedInvoice.grossAmount
      : ((t.settlementAmount ?? t.actualSalePrice ?? t.agentPrice) || 0);
    const paid = linkedInvoice
      ? (linkedInvoice.paidAmount || 0)
      : (t.settlementStatus === 'paid'
        ? (t.settlementAmount ?? amount)
        : (t.settlementStatus === 'partial' ? (t.settlementPaidAmount || 0) : 0));
    const outstanding = Math.max(0, amount - paid);

    return {
      date: (t.transferredAt || t.createdAt || '').split('T')[0],
      itemLabel,
      specsLine,
      refOrSerial,
      ourPrice: t.agentPrice || 0,
      saleOrPayout: t.actualSalePrice ?? undefined,
      paid,
      outstanding,
      returnDate: t.returnBy ? t.returnBy.split('T')[0] : undefined,
      status: statusLabel(t, linkedInvoice),
    };
  });

  // Summary
  const totalOurPrice = rows.reduce((s, r) => s + (r.ourPrice || 0), 0);
  const totalOutstanding = rows.reduce((s, r) => s + (r.outstanding || 0), 0);
  const summaryParts = [
    `${rows.length} item${rows.length === 1 ? '' : 's'}`,
    `Total Our Price: ${fmt3(totalOurPrice)} BHD`,
  ];
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

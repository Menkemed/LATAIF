// consignment-print-helpers (2026-05-18) — Adapter zwischen Consignment-Daten
// und printItemListPdf. Wird von ConsignorDetail (single) und ConsignmentList
// (aggregate) wiederverwendet.
import type { Consignment, Customer, Category, Product } from '@/core/models/types';
import { getProductSpecs } from '@/core/utils/product-format';
import {
  printItemListPdf,
  type ItemListFilter,
  type ItemListGroup,
  type ItemListRow,
} from '@/core/pdf/itemListPdf';

/** Baut eine kompakte Specs-Zeile aus allen ausgefuellten Kategorie-Attributen. */
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

export function filterConsignments(consignments: Consignment[], filter: ItemListFilter): Consignment[] {
  switch (filter) {
    case 'sold':     return consignments.filter(c => c.status === 'sold');
    case 'open':     return consignments.filter(c => c.status === 'active');
    case 'returned': return consignments.filter(c =>
      c.status === 'returned' || (c.status as string) === 'RETURNED' || (c.status as string) === 'RETURNED_TO_OWNER'
    );
    default:         return consignments.slice();
  }
}

function statusLabel(c: Consignment): string {
  const s = String(c.status || '').toLowerCase();
  if (s === 'active') return 'Active';
  if (s === 'sold') {
    if (c.payoutStatus === 'paid') return 'Sold · Paid Out';
    if (c.payoutStatus === 'partial') return 'Sold · Partial Payout';
    return 'Sold · Payout Pending';
  }
  if (s === 'paid_out') return 'Paid Out';
  if (s === 'returned' || s === 'returned_to_owner') return 'Returned';
  if (s === 'expired') return 'Expired';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface BuildConsignorGroupInput {
  consignor: Customer;
  consignments: Consignment[];
  products: Product[];
  categories: Category[];
  filter: ItemListFilter;
}

export function buildConsignorPrintGroup({ consignor, consignments, products, categories, filter }: BuildConsignorGroupInput): ItemListGroup {
  const filtered = filterConsignments(consignments, filter);
  const rows: ItemListRow[] = filtered.map(c => {
    const product = products.find(p => p.id === c.productId);
    const refOrSerial = product
      ? [
          product.sku,
          (product.attributes as Record<string, unknown> | undefined)?.['reference_number'],
          (product.attributes as Record<string, unknown> | undefined)?.['serial_number'],
        ].filter(Boolean).map(String).join(' · ') || undefined
      : undefined;
    const itemLabel = product ? `${product.brand} ${product.name}`.trim() : '(product not found)';
    const specsLine = buildSpecsLine(product, categories);
    return {
      date: (c.createdAt || '').split('T')[0],
      itemLabel,
      specsLine,
      refOrSerial,
      ourPrice: c.agreedPrice || 0,
      saleOrPayout: c.salePrice ?? undefined,
      payout: c.payoutAmount ?? undefined,
      status: statusLabel(c),
    };
  });

  // Summary
  const totalAgreed = rows.reduce((s, r) => s + (r.ourPrice || 0), 0);
  const totalSold = rows.reduce((s, r) => s + (r.saleOrPayout || 0), 0);
  const totalPayout = rows.reduce((s, r) => s + (r.payout || 0), 0);
  const summaryParts = [
    `${rows.length} item${rows.length === 1 ? '' : 's'}`,
    `Total Agreed: ${fmt3(totalAgreed)} BHD`,
  ];
  if (totalSold > 0) summaryParts.push(`Sold: ${fmt3(totalSold)} BHD`);
  if (totalPayout > 0) summaryParts.push(`Payout: ${fmt3(totalPayout)} BHD`);

  const fullName = `${consignor.firstName} ${consignor.lastName}`.trim() || '(unnamed)';
  const contactBits = [consignor.company, consignor.phone, consignor.email].filter(Boolean) as string[];

  return {
    heading: fullName + (consignor.company ? ` — ${consignor.company}` : ''),
    contact: contactBits.length > 0 ? contactBits.join(' · ') : undefined,
    rows,
    summary: summaryParts.join(' · '),
  };
}

export interface RunConsignmentPrintInput {
  filter: ItemListFilter;
  branchName?: string;
  scope: 'single' | 'aggregate';
  consignors: Customer[];
  consignments: Consignment[];
  products: Product[];
  categories: Category[];
}

export function runConsignmentPrint(input: RunConsignmentPrintInput): void {
  const { filter, branchName, scope, consignors, consignments, products, categories } = input;
  const groups: ItemListGroup[] = [];
  for (const c of consignors) {
    const my = consignments.filter(con => con.consignorId === c.id);
    const g = buildConsignorPrintGroup({ consignor: c, consignments: my, products, categories, filter });
    if (scope === 'aggregate' && g.rows.length === 0) continue;
    groups.push(g);
  }
  printItemListPdf({
    kind: 'consignment',
    filter,
    branchName,
    groups,
    isAggregate: scope === 'aggregate',
  });
}

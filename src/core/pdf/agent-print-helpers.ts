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

/** Kennnummern: stehen in der Spalte „Ref / Serial" (SKU, Referenz, Modellnummer, Seriennummer). */
const ID_KEYS = ['reference_number', 'model_number', 'serial_number'];
/** Was der Anzeigename eines Stücks ohne Marke/Modell schon nennt („Ring · Red Stone · 18K White Gold · 7.80 g"). */
const NAME_KEYS = ['item_type', 'karat', 'weight'];

const attrsOf = (p: Product): Record<string, unknown> => (p.attributes as Record<string, unknown> | undefined) || {};

/** SKU, Referenz, Modellnummer, Seriennummer — je einmal, in dieser Reihenfolge. */
export function approvalRefLine(product: Product | undefined): string | undefined {
  if (!product) return undefined;
  const a = attrsOf(product);
  const vals = [product.sku, ...ID_KEYS.map(k => a[k])].map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
  return [...new Set(vals)].join(' · ') || undefined;
}

/** Baut eine kompakte "Steel · 40mm · Black Dial · Pre-Owned"-Zeile aus
 *  allen ausgefuellten Kategorie-Attributen + Condition — OHNE was schon woanders steht: die Kennnummern (Spalte
 *  „Ref / Serial") und bei Stücken ohne Marke/Modell Art, Karat und Gewicht (stehen im Anzeigenamen). */
export function buildSpecsLine(product: Product | undefined, categories: Category[]): string | undefined {
  if (!product) return undefined;
  const cat = categories.find(c => c.id === product.categoryId);
  const nameFromAttrs = !String(product.brand || '').trim() && !String(product.name || '').trim();
  // Das Diamantgewicht steht schon in den Steinen („Diamond 1.65 ct") — nicht noch einmal davor („1.65 ct").
  const stones = attrsOf(product).stones;
  const hasStones = Array.isArray(stones) ? stones.length > 0 : !!stones;
  const skipKeys = new Set([...ID_KEYS, ...(nameFromAttrs ? NAME_KEYS : []), ...(hasStones ? ['diamond_weight'] : [])]);
  const skipLabels = new Set((cat?.attributes || []).filter(a => skipKeys.has(a.key)).map(a => a.label));
  const specs = getProductSpecs(product, categories, {
    includeSku: false,
    includeCondition: true,
    prominentOnly: false,
  }).filter(s => !skipLabels.has(s.label));
  if (specs.length === 0) return undefined;
  return specs.map(s => s.value).join(' · ');
}

/** Lieferumfang (Box, Papers, Warranty Card, Dust Bag, Certificate …) — nur wenn vorhanden. Ältere Artikel
 *  führen Box/Papers noch als Ja/Nein-Merkmal; das zählt mit. */
export function scopeOfDeliveryLine(product: Product | undefined): string | undefined {
  if (!product) return undefined;
  const raw = (product as { scopeOfDelivery?: unknown }).scopeOfDelivery;
  const list = (Array.isArray(raw) ? raw : []).map(v => String(v).trim()).filter(Boolean);
  const a = attrsOf(product);
  const yes = (v: unknown) => v === true || v === 'true' || v === 'Yes';
  if (yes(a.box) && !list.some(x => x.toLowerCase() === 'box')) list.push('Box');
  if (yes(a.papers) && !list.some(x => x.toLowerCase() === 'papers')) list.push('Papers');
  return list.length ? [...new Set(list)].join(' · ') : undefined;
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
  /** Vorab aufgelöste kleine Produktbilder (Produkt-ID → data:-URL); fehlt eines, bleibt die Bildzelle leer. */
  imageUrls?: ReadonlyMap<string, string>;
}

export function buildAgentPrintGroup({ agent, transfers, invoices, products, categories, filter, imageUrls }: BuildAgentGroupInput): ItemListGroup {
  const filtered = filterApprovalTransfers(transfers, filter);
  const rows: ItemListRow[] = filtered.map(t => {
    const linkedInvoice = t.invoiceId ? invoices.find(i => i.id === t.invoiceId) : undefined;
    const product = products.find(p => p.id === t.productId);
    const refOrSerial = approvalRefLine(product);
    const itemLabel = product ? productDisplayName(product) : '(product not found)';
    const specsLine = buildSpecsLine(product, categories);
    const scopeLine = scopeOfDeliveryLine(product);
    // Dieselbe Geldregel wie Approval-Excel und Approval-Seite: Bezahlt/Offen nur bei verkauften Stücken. Früher
    // wurde hier für JEDEN Transfer eine Forderung gebildet (ohne Verkauf = Our Price) — Stücke beim Kunden oder
    // zurückgegebene standen dadurch mit ihrem Our Price als „Outstanding" im Druck.
    const money = approvalRowMoney(t, linkedInvoice);

    return {
      date: (t.transferredAt || t.createdAt || '').split('T')[0],
      itemLabel,
      specsLine,
      scopeLine,
      imageUrl: product ? imageUrls?.get(product.id) : undefined,
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
  /** Kleines Druckbild eines Produkts (data:-URL) oder null. Ohne: Druck ohne Produktbilder. */
  resolveImageUrl?: (product: Product) => Promise<string | null>;
}

/** Die Druckbilder genau der Stücke, die gedruckt werden — je Produkt einmal; ein Fehler lässt nur das Bild weg. */
async function collectImageUrls(input: RunApprovalPrintInput): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!input.resolveImageUrl) return out;
  const ids = new Set(input.agents.flatMap(a => filterApprovalTransfers(input.transfers.filter(t => t.agentId === a.id), input.filter).map(t => t.productId)));
  for (const p of input.products) {
    if (!ids.has(p.id)) continue;
    try {
      const url = await input.resolveImageUrl(p);
      if (url) out.set(p.id, url);
    } catch (err) {
      console.warn('[Approval-Druck] Bild übersprungen für', p.id, err);
    }
  }
  return out;
}

export async function runApprovalPrint(input: RunApprovalPrintInput): Promise<void> {
  const { filter, branchName, scope, agents, transfers, invoices, products, categories } = input;
  const imageUrls = await collectImageUrls(input);
  const groups: ItemListGroup[] = [];
  for (const a of agents) {
    const myTransfers = transfers.filter(t => t.agentId === a.id);
    const g = buildAgentPrintGroup({ agent: a, transfers: myTransfers, invoices, products, categories, filter, imageUrls });
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

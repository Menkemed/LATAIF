// Approval-Excel und Approval-Druckbilder aus der Seite heraus: Mandant/Filiale für die Bilder, Kategorie-Definitionen,
// Datei speichern.
// Der Aufbau der Mappe selbst steht in core/agents/approval-workbook.ts (unter node getestet).
import type { Agent, AgentTransfer, Category, Invoice, Product } from '@/core/models/types';
import type { ItemListFilter } from '@/core/pdf/itemListPdf';
import { buildApprovalWorkbookBuffer } from '@/core/agents/approval-workbook';
import { resolvePrimaryImageForExport } from '@/core/media/product-image-export';
import { printThumbDataUrl } from '@/core/media/print-thumb';
import { currentBranchId } from '@/core/db/helpers';
import { sessionTenantId } from '@/core/data/shared-read';
import { exportFile } from '@/core/utils/export-file';
import { todayIso } from '@/core/utils/business-date';
import { categoryDefinitionsForExport } from '@/stores/productStore';

export interface ApprovalExcelInput {
  filter: ItemListFilter;
  scope: 'single' | 'aggregate';
  agents: Agent[];
  transfers: AgentTransfer[];
  invoices: Invoice[];
  products: Product[];
  categories: Category[];
}

function currentMediaScope(): { tenantId: string | undefined; branchId: string | undefined } {
  try {
    const b = currentBranchId();
    return { branchId: b || undefined, tenantId: sessionTenantId(b || undefined) };
  } catch { return { tenantId: undefined, branchId: undefined }; /* ohne Bereich nur Bilder aus der alten Bildspalte */ }
}

/** Druckbild für den Approval-Druck: dasselbe Hauptbild wie im Excel, verkleinert als data:-URL. */
export async function approvalPrintImageUrl(product: Product): Promise<string | null> {
  const img = await resolvePrimaryImageForExport(product, currentMediaScope());
  return img ? printThumbDataUrl(img) : null;
}

export async function exportApprovalsToExcel(input: ApprovalExcelInput): Promise<void> {
  const today = todayIso();
  const mediaScope = currentMediaScope();
  const defs = categoryDefinitionsForExport();
  const buffer = await buildApprovalWorkbookBuffer({
    ...input,
    categories: defs,
    categoryName: (id) => defs.find((c) => c.id === id)?.name || input.categories.find((c) => c.id === id)?.name || '',
    resolveImage: resolvePrimaryImageForExport,
    mediaScope,
    today,
  });
  const who = input.scope === 'single' && input.agents[0]
    ? `Approval_${input.agents[0].name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Client'}`
    : 'Approvals';
  const was = input.filter === 'all' ? '' : `_${input.filter}`;
  await exportFile(`LATAIF_${who}${was}_${today}.xlsx`, new Uint8Array(buffer), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

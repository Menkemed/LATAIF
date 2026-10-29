// ════════════════════════════════════════════════════════════════════════════
// REPAIR-WORKFLOW — die Statusschritte und die Rechnung einer Reparatur aus jeder Maske (Liste, Quick Edit,
// Detailseite, Rechnungsseite): am Primary die Hausfunktion in EINER Klammer (zulässiger Schritt, gesehene
// Fassung, Abholtag), an PC2 derselbe geprüfte Fernbefehl. Keine eigene Regel hier — nur der Anschluss.
// ════════════════════════════════════════════════════════════════════════════
import { fehlertext, nichtAmClient, type SharedWrites } from '@/core/data/shared-write';
import { invoiceRepairsOnPrimary, updateRepairStatusOnPrimary } from '@/core/repairs/repair-house';
import { repairInvoiceBody, type RepairInvoiceOptions } from '@/core/repairs/repair-rules';
import { useRepairStore } from '@/stores/repairStore';
import type { Repair, RepairStatus } from '@/core/models/types';

/**
 * Ein Statusschritt (vorwärts, „Returned", „Reopen", „Picked Up" mit tatsächlichem Abholtag). Gibt die Fassung
 * NACH dem Schritt zurück (für eine Folgehandlung wie die Rechnung) — `null`, wenn es nicht geglückt ist.
 */
export async function saveRepairStatus(
  w: SharedWrites, repair: Pick<Repair, 'id' | 'revision'>, status: RepairStatus, pickedUpDate?: string,
): Promise<number | null> {
  if (w.remote && !repair.revision) {
    alert(fehlertext(nichtAmClient('changing the repair status (no revision loaded)')));
    return null;
  }
  const r = await w.save<Record<string, unknown>>('repairs.update_status', {
    local: async () => {
      await updateRepairStatusOnPrimary(repair.id, status, {
        ...(repair.revision ? { expectedRevision: repair.revision } : {}),
        ...(pickedUpDate ? { pickedUpDate } : {}),
      });
      return { revision: useRepairStore.getState().getRepair(repair.id)?.revision ?? 0 };
    },
    remote: () => ({
      repairId: repair.id, status, expectedRevision: repair.revision,
      ...(pickedUpDate ? { pickedUpDate } : {}),
    }),
  });
  if (r.kind !== 'ok') return null;
  return Number((r.value as { revision?: unknown }).revision) || 0;
}

/** Die Rechnung einer oder mehrerer Reparaturen — dieselbe Hausfunktion wie Liste und Detailseite. */
export async function saveRepairInvoice(
  w: SharedWrites, repairs: ReadonlyArray<{ id: string; revision?: number }>, opts: RepairInvoiceOptions,
): Promise<{ invoiceId: string } | { error: string }> {
  const r = await w.save<{ invoiceId: string }>('repairs.create_invoice', {
    local: () => invoiceRepairsOnPrimary(repairs.map((x) => x.id), opts),
    remote: () => repairInvoiceBody(repairs, opts),
  });
  return r.kind === 'ok' ? { invoiceId: String(r.value.invoiceId) } : { error: fehlertext(r) };
}

/**
 * REPAIR-PICKUP-DATE — die Abholung ist erfasst, die Rechnung (auf den Abholtag) aber nicht: das ist KEIN Fehler der
 * Abholung. Sie bleibt mit ihrem tatsächlichen Tag stehen; die Rechnung wird später mit einem zulässigen Tag angelegt
 * (z. B. wenn das Quartal des Abholtags schon eingereicht oder VAT-bezahlt ist). Ein falscher Rechnungstag wird nie
 * eingesetzt.
 */
export function pickupKeptInvoiceRefused(pickedUpDate: string | undefined, reason: string): string {
  return `Picked up${pickedUpDate ? ` on ${pickedUpDate}` : ''} — the pickup is saved. The invoice was NOT created: ${reason}`
    + ' Create the invoice later from the repair with an invoice date in an open VAT quarter.';
}

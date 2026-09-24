// VAT-PERIOD-LOCK — „Mark VAT filed" vom Bildschirm aus: nur am Primary (dort liegen die Daten, die
// festgehalten werden), in dessen Schreibreihenfolge und dauerhaft gespeichert. Am verbundenen Client
// ein ehrliches Nein — die SPERRE selbst gilt dort trotzdem, denn jede Rechnungsänderung von PC2 läuft
// am Primary durch dieselben Prüfungen. Recht: dasselbe wie für die VAT-Zahlung (`tax.record_payment`).
import { isClientMode } from '@/core/bridge/client-mode';
import { runOnPrimary } from '@/core/data/primary-action';
import { nichtAmClient, type WriteOutcome } from '@/core/data/shared-write';
import { currentBranchId, currentUserId } from '@/core/db/helpers';
import { useAuthStore } from '@/stores/authStore';
import { markVatQuarterFiled, type VatFilingResult } from './vat-period-lock';

export async function saveVatFiling(year: number, quarter: number, reload: () => void): Promise<WriteOutcome<VatFilingResult>> {
  if (isClientMode()) return nichtAmClient('marking a VAT quarter as filed');
  if (!useAuthStore.getState().hasPermission('tax.record_payment')) {
    return { kind: 'business_error', code: 'FORBIDDEN', message: 'you may not mark VAT quarters as filed' };
  }
  try {
    const value = await runOnPrimary(() => {
      let userId: string | null = null;
      try { userId = currentUserId(); } catch { /* ohne Sitzung */ }
      return markVatQuarterFiled({ branchId: currentBranchId(), year, quarter, userId });
    }, reload);
    reload();
    return { kind: 'ok', value, replayed: false };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    return { kind: 'business_error', code: typeof code === 'string' ? code : 'VAT_FILING_FAILED', message: (e as Error).message };
  }
}

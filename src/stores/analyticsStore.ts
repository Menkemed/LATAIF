// ═══════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2C — der Bestand für die Auswertungsseite.
//
// Er hält kein eigenes Wissen: er ruft dieselbe gemeinsame Rechnung, die auch die Fernauskunft
// ausführt, und legt das Ergebnis ab. Die Weiche zwischen „eigene Datenbank" und „Stand vom
// Primary" sitzt genau hier — eine Zeile — und nicht in der Seite.
// ═══════════════════════════════════════════════════════════
import { create } from 'zustand';
import { loadAnalyticsFor, vatExportRowsFor, type AnalyticsSnapshot } from '@/core/reports/analytics-snapshot';
import { hydrateFromPrimary, readsFromPrimary, fetchFromPrimary } from '@/core/data/primary-source';
import { localReadContext } from '@/core/data/read-context';

interface AnalyticsStore {
  snapshot: AnalyticsSnapshot | null;
  loading: boolean;
  loadAnalytics: () => void;
  /** Der Steuerbericht — auf Abruf, weil er zeilenweise und damit groß ist. */
  vatExportRows: () => Promise<{ invoices: Record<string, unknown>[]; lines: Record<string, unknown>[] }>;
}

export const useAnalyticsStore = create<AnalyticsStore>((set) => ({
  snapshot: null,
  loading: false,

  loadAnalytics: () => {
    if (hydrateFromPrimary('store.analytics.get', (d) => set(d as never))) return;
    try {
      set({ ...loadAnalyticsFor(localReadContext()), loading: false });
    } catch {
      set({ snapshot: null, loading: false });
    }
  },

  vatExportRows: async () => {
    if (readsFromPrimary()) {
      const d = await fetchFromPrimary('analytics.vat_export.get', {});
      return {
        invoices: (d?.invoices ?? []) as Record<string, unknown>[],
        lines: (d?.lines ?? []) as Record<string, unknown>[],
      };
    }
    try {
      return vatExportRowsFor(localReadContext());
    } catch {
      return { invoices: [], lines: [] };
    }
  },
}));

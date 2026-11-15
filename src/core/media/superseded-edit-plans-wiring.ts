// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — Verdrahtung „überholte Galerie-Bearbeitungen abbrechen“ am Primary.
//
// Es gibt (noch) KEINEN Produktions-Einstieg: keine Maske, kein Befehl, kein automatischer Lauf. Die
// produktive Ausführung braucht einen aktuellen Zustandsnachweis, eine geprüfte Sicherung und eine
// gesonderte Owner-Freigabe. Erreichbar ist die Funktion nur in einem E2E-Build (Rust setzt dort
// `window.__LATAIF_E2E__ = true`, Release-Builds nie) — für Prüfungen auf isolierten Kopien.
//
// Ablauf: unter DERSELBEN Medien-Sperre + DEMSELBEN DB-Lease wie jeder Upload/jede Wiederherstellung.
//   inspect → je zugelassenem Job das Urteil + Fingerabdruck (schreibt nichts)
//   close   → nur Owner; nur Jobs, deren Fingerabdruck der Aufrufer aus `inspect` mitbringt; danach EIN
//             durables Speichern (auch wenn nichts geschlossen wurde, aber ein früherer Abbruch nur im
//             Speicher stand — Speichern derselben DB ist ohne Nebenwirkung).
// ════════════════════════════════════════════════════════════════════════════
import {
  closeSupersededEditPlan, inspectSupersededEditPlan, SUPERSEDED_EDIT_PLAN_CASES,
  type SupersededCloseResult, type SupersededDb, type SupersededDeps, type SupersededVerdict,
} from './superseded-edit-plans.ts';

export type SupersededRunRequest =
  | { mode: 'inspect' }
  | { mode: 'close'; fingerprints: Record<string, string> };

export async function runSupersededEditPlansOnPrimary(req: SupersededRunRequest): Promise<{
  inspected?: SupersededVerdict[];
  closed?: SupersededCloseResult[];
  saved: boolean;
}> {
  const [{ getStockMediaOrchestrator }, core, { useAuthStore }] = await Promise.all([
    import('./orchestrator.ts'), import('@tauri-apps/api/core'), import('../../stores/authStore'),
  ]);
  const orch = await getStockMediaOrchestrator();
  return orch.runMaintenanceExclusive(async (lease, coordinator) => {
    const deps: SupersededDeps = {
      db: lease.db as unknown as SupersededDb,
      inspect: (t, irid) => coordinator.inspectStoredEditPlan(t, irid),
      journalPresent: (tenantScope, ingestRequestId) =>
        core.invoke<boolean>('media_ingest_journal_present', { tenantScope, ingestRequestId }),
    };
    if (req.mode === 'inspect') {
      const inspected: SupersededVerdict[] = [];
      for (const c of SUPERSEDED_EDIT_PLAN_CASES) inspected.push(await inspectSupersededEditPlan(deps, c.jobId));
      return { inspected, saved: false };
    }
    const session = useAuthStore.getState().session as { role?: string; userId?: string } | null | undefined;
    const actor = { userId: session?.userId ?? null, role: session?.role };
    const closed: SupersededCloseResult[] = [];
    for (const c of SUPERSEDED_EDIT_PLAN_CASES) {
      const fp = req.fingerprints[c.jobId];
      if (!fp) continue; // nur ausdrücklich mitgebrachte Jobs
      closed.push(await closeSupersededEditPlan(deps, c.jobId, fp, actor));
    }
    const mustSave = closed.some((r) => r.status === 'closed' || r.status === 'already_closed');
    if (mustSave) await lease.saveDurably();
    return { closed, saved: mustSave };
  });
}

/** Nur im E2E-Build: `window.__lataifSupersededEditPlans`. */
export function installSupersededEditPlansBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__LATAIF_E2E__ !== true) return;
  w.__lataifSupersededEditPlans = { run: runSupersededEditPlansOnPrimary };
}

// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — Verdrahtung der Migration am Primary.
//
// Es gibt (noch) KEINEN Produktions-Einstieg: keine Maske, kein Befehl, kein automatischer Lauf. Die
// produktive Migration ist nicht freigegeben. Erreichbar ist der Lauf nur in einem E2E-Build, in
// dem Rust `window.__LATAIF_E2E__ = true` setzt (Release-Builds setzen das nie) — für die Tests auf
// isolierten Kopien. Der Lauf hält dieselbe Medien-Sperre und denselben DB-Lease wie jeder Upload.
// ════════════════════════════════════════════════════════════════════════════
import {
  migrationInvariantDigest, planImageStoreMigration, runImageStoreMigration,
  type MigrationDb, type MigrationJournalEntry, type MigrationReport, type RecompressOutcome,
} from './image-store-migration.ts';

export interface MigrationRunRequest {
  mode: 'dry-run' | 'apply';
  maxBlobs?: number;
  saveEvery?: number;
  /** Test: nach so vielen Umstellungen kooperativ anhalten (Abbruch/Wiederaufnahme). */
  stopAfter?: number;
  /** Test: nur diese Blobs (feste Stichprobe). */
  onlyBlobIds?: string[];
}

export async function runImageStoreMigrationOnPrimary(req: MigrationRunRequest): Promise<{ report: MigrationReport; journal: MigrationJournalEntry[] }> {
  const [{ getStockMediaOrchestrator }, core] = await Promise.all([import('./orchestrator.ts'), import('@tauri-apps/api/core')]);
  const orch = await getStockMediaOrchestrator();
  const journal: MigrationJournalEntry[] = [];
  let switched = 0;
  // Fortschritt für Beobachter (E2E: harter Abbruch mitten im Lauf). Nur Zähler, keine Inhalte.
  const progress = { switched: 0, failed: 0, done: 0, running: true };
  if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__lataifImageMigrationProgress = progress;
  const report = await orch.runMaintenanceExclusive((lease) => runImageStoreMigration({
    db: lease.db as unknown as MigrationDb,
    saveDurably: () => lease.saveDurably(),
    recompress: (a) => core.invoke<RecompressOutcome>('media_recompress_stored', {
      tenantScope: a.tenantScope, sourceHash: a.sourceHash, sourceExtension: a.sourceExtension, rendition: a.rendition,
      maxBytes: a.maxBytes, publish: a.publish, publishOnlyBelow: a.publishOnlyBelow ?? null,
    }),
    journal: (e) => {
      journal.push(e);
      if (e.event === 'switched') { switched++; progress.switched++; }
      if (e.event === 'failed') progress.failed++;
      if (e.event === 'switched' || e.event === 'failed' || e.event === 'skipped' || e.event === 'planned') progress.done++;
    },
  }, {
    mode: req.mode, maxBlobs: req.maxBlobs, saveEvery: req.saveEvery,
    onlyBlobIds: req.onlyBlobIds ? new Set(req.onlyBlobIds) : undefined,
    shouldStop: () => req.stopAfter != null && switched >= req.stopAfter,
  })).finally(() => { progress.running = false; });
  return { report, journal };
}

/** Nur im E2E-Build: `window.__lataifImageMigration`. */
export function installImageMigrationBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__LATAIF_E2E__ !== true) return;
  w.__lataifImageMigration = {
    run: runImageStoreMigrationOnPrimary,
    digest: async () => {
      const { getDatabase } = await import('@/core/db/database');
      return migrationInvariantDigest(getDatabase() as unknown as MigrationDb);
    },
    plan: async () => {
      const { getDatabase } = await import('@/core/db/database');
      const p = planImageStoreMigration(getDatabase() as unknown as MigrationDb);
      return { plans: p.plans.length, skipped: p.skipped.length };
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — Verdrahtung der Migration am Primary (Phase 4, 16.11.2026).
//
// Einstieg: die Owner-Karte in Settings → Data Repairs (`ImageStoreMigrationCard`). Kein automatischer Lauf,
// kein Start beim App-Start. Im E2E-Build zusätzlich `window.__lataifImageMigration` (dieselbe Funktion).
//
// Ablauf eines echten Laufs (`apply`):
//   1. nur am Primary; Owner-Rolle, Grund und Name der geprüften Vollsicherung Pflicht;
//   2. Wartungsmodus AN: Rust weist verändernde Aufträge von PC2/Handy ab (503), der Renderer ebenso, der
//      Handy-Drain verarbeitet nichts; ein laufender Drain-Durchgang wird abgewartet;
//   3. Pakete (Standard 10 Bilder): je Paket der EINE exklusive Schreibplatz (Schreib-Warteschlange →
//      Medien-Sperre → DB-Lease), am Ende des Pakets durables Speichern. Die Owner-Rolle wird zu Beginn
//      JEDES Pakets erneut gelesen (Abmelden/Rollenwechsel → sauberer Halt);
//   4. Protokoll als Datei im Datenordner (`maintenance-logs/<runId>.jsonl`, Probelauf `<runId>-dry.jsonl`;
//      nur Kennungen und Zahlen);
//   5. Wartungsmodus AUS — immer, auch bei Fehler oder Abbruch.
// Abbruch: `requestImageMigrationStop()` hält zwischen zwei Bildern an; das Paket wird gespeichert.
// Wiederaufnahme: ein neuer Lauf plant aus dem DB-Stand; umgestellte Bilder liegen unter ihrer Grenze.
// ════════════════════════════════════════════════════════════════════════════
import {
  inventoryImageStore, migrationInvariantDigest, planImageStoreMigration, runImageStoreMigration,
  type ImageStoreInventory, type MigrationDb, type MigrationJournalEntry, type MigrationProgress, type MigrationReport,
  type RecompressArgs, type RecompressOutcome,
} from './image-store-migration.ts';
import { canonicalRole } from '../models/types.ts';

export interface MigrationRunRequest {
  mode: 'dry-run' | 'apply';
  /** Pflicht für `apply`: Grund (steht im Protokoll). */
  reason?: string;
  /** Pflicht für `apply`: Name der geprüften Vollsicherung vor dem Lauf. */
  backupRef?: string;
  maxBlobs?: number;
  /** Paketgröße (Standard 10). */
  saveEvery?: number;
  /** Test: nach so vielen Umstellungen kooperativ anhalten (Abbruch/Wiederaufnahme). */
  stopAfter?: number;
  /** Test: nur diese Blobs (feste Stichprobe). */
  onlyBlobIds?: string[];
}

export type MigrationRefusal =
  | 'MIGRATION_PRIMARY_ONLY' | 'MIGRATION_NOT_OWNER' | 'MIGRATION_NOTE_REQUIRED' | 'MIGRATION_ALREADY_RUNNING';

export interface MigrationRunResult {
  report?: MigrationReport;
  journal: MigrationJournalEntry[];
  refused?: { code: MigrationRefusal; detail: string };
  /** Name der Protokolldatei im Datenordner (nur `apply`). */
  logName?: string;
  error?: string;
}

/** Was die Verdrahtung von außen braucht — in der App echt, im Test ersetzbar. */
export interface MigrationEnv {
  /** Der EINE exklusive Schreibplatz: Schreib-Warteschlange → Medien-Sperre → DB-Lease (DB + Speichern). */
  exclusive<T>(fn: (lease: { db: unknown; saveDurably(): Promise<void> }) => Promise<T>): Promise<T>;
  recompress(a: RecompressArgs): Promise<RecompressOutcome>;
  /** Die AKTUELLE Sitzung — wird vor jedem Paket gelesen. */
  session(): { userId?: string | null; role?: string | null } | null;
  isClientMode(): boolean;
  /** Wartungsmodus in Rust UND im Renderer setzen. Wirft, wenn Rust ihn nicht setzen kann. */
  setMaintenance(on: boolean, reason: string): Promise<void>;
  /** Auf einen gerade laufenden Handy-Drain-Durchgang warten. */
  waitForDrainIdle?(): Promise<void>;
  /** Eine Zeile an die Protokolldatei `<name>.jsonl` im Datenordner anhängen. */
  appendLog(name: string, line: string): Promise<void>;
  transactionActive(): boolean;
  now?(): string;
}

// ── Zustand für die Anzeige (nur Zahlen) ─────────────────────────────────────
export interface MigrationUiState {
  running: boolean;
  mode: 'dry-run' | 'apply' | null;
  progress: MigrationProgress | null;
  report: MigrationReport | null;
  logName: string | null;
  error: string | null;
  stopRequested: boolean;
}
let uiState: MigrationUiState = { running: false, mode: null, progress: null, report: null, logName: null, error: null, stopRequested: false };
const listeners = new Set<() => void>();
function setUi(patch: Partial<MigrationUiState>): void {
  uiState = { ...uiState, ...patch };
  for (const l of listeners) { try { l(); } catch { /* Anzeige */ } }
}
export function imageMigrationUiState(): MigrationUiState { return uiState; }
export function subscribeImageMigration(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
/** Kooperativer Abbruch: hält zwischen zwei Bildern an, das laufende Paket wird gespeichert. */
export function requestImageMigrationStop(): void { if (uiState.running) setUi({ stopRequested: true }); }

const BACKUP_REF = /^[A-Za-z0-9][A-Za-z0-9._ -]{7,119}$/;
let running = false;

class NotOwnerError extends Error { readonly code = 'MIGRATION_NOT_OWNER'; constructor() { super('MIGRATION_NOT_OWNER: only the owner may run the image migration'); } }

export async function runImageMigrationWith(env: MigrationEnv, req: MigrationRunRequest): Promise<MigrationRunResult> {
  const journal: MigrationJournalEntry[] = [];
  if (env.isClientMode()) return { journal, refused: { code: 'MIGRATION_PRIMARY_ONLY', detail: 'the image migration runs on the main computer only' } };
  const isOwner = () => canonicalRole(env.session()?.role ?? undefined) === 'ADMIN';
  if (!isOwner()) return { journal, refused: { code: 'MIGRATION_NOT_OWNER', detail: 'only the owner may run the image migration' } };
  if (req.mode === 'apply' && (!req.reason?.trim() || !BACKUP_REF.test(req.backupRef?.trim() ?? ''))) {
    return { journal, refused: { code: 'MIGRATION_NOTE_REQUIRED', detail: 'a reason and the name of the verified full backup are required' } };
  }
  if (running) return { journal, refused: { code: 'MIGRATION_ALREADY_RUNNING', detail: 'a migration run is already in progress' } };
  running = true;

  const now = env.now ?? (() => new Date().toISOString());
  let logName: string | undefined;
  let switched = 0;
  // Die DB gehört dem Lease des laufenden Pakets: jeder Zugriff außerhalb eines Pakets ist ein Fehler, und
  // ein DB-Austausch zwischen zwei Paketen (Reload/Restore) kann nie auf eine alte Instanz schreiben lassen.
  let current: { db: unknown; saveDurably(): Promise<void> } | null = null;
  const leaseDb = (): MigrationDb => { if (!current) throw new Error('MIGRATION_NO_LEASE'); return current.db as MigrationDb; };
  const db: MigrationDb = { run: (sql, params) => leaseDb().run(sql, params), exec: (sql, params) => leaseDb().exec(sql, params) };
  let maintenanceOn = false;
  setUi({ running: true, mode: req.mode, progress: null, report: null, logName: null, error: null, stopRequested: false });
  const log = async (obj: Record<string, unknown>) => {
    if (!logName) return;
    try { await env.appendLog(logName, JSON.stringify(obj)); } catch (e) { console.warn('[Bildmigration] Protokollzeile nicht geschrieben', e); }
  };
  try {
    if (req.mode === 'apply') {
      await env.setMaintenance(true, 'image-store-migration');
      maintenanceOn = true;
      await env.waitForDrainIdle?.();
    }
    const report = await runImageStoreMigration({
      db,
      recompress: (a) => env.recompress(a),
      saveDurably: async () => { if (!current) throw new Error('MIGRATION_NO_LEASE'); await current.saveDurably(); },
      exclusive: (fn) => env.exclusive(async (lease) => { current = lease; try { return await fn(); } finally { current = null; } }),
      transactionActive: () => env.transactionActive(),
      assertAllowed: () => { if (!isOwner()) throw new NotOwnerError(); },
      progress: (p) => {
        // Auch der Probelauf schreibt sein Protokoll (Vorhersage je Bild) — damit lässt sich danach jedes Bild
        // mit seiner Vorhersage vergleichen.
        if (!logName) {
          logName = req.mode === 'apply' ? p.runId : `${p.runId}-dry`;
          setUi({ logName });
          void log({ at: now(), runId: p.runId, event: 'owner', reason: req.reason?.trim(), backup: req.backupRef?.trim(), user: env.session()?.userId ?? null });
        }
        setUi({ progress: p });
      },
      journal: async (e) => {
        journal.push(e);
        if (e.event === 'switched') switched++;
        await log(e as unknown as Record<string, unknown>);
      },
      now,
    }, {
      mode: req.mode, maxBlobs: req.maxBlobs, saveEvery: req.saveEvery,
      onlyBlobIds: req.onlyBlobIds ? new Set(req.onlyBlobIds) : undefined,
      shouldStop: () => uiState.stopRequested || (req.stopAfter != null && switched >= req.stopAfter),
    });
    await log({ at: now(), runId: report.runId, event: 'report', report: { ...report, errors: report.errors.slice(0, 200) } });
    setUi({ report });
    return { report, journal, logName };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log({ at: now(), event: 'error', reason: msg.slice(0, 300) });
    setUi({ error: msg });
    if (e instanceof NotOwnerError) return { journal, refused: { code: 'MIGRATION_NOT_OWNER', detail: 'the owner session ended — the run stopped after the last saved package' }, logName };
    throw e;
  } finally {
    if (maintenanceOn) {
      try { await env.setMaintenance(false, ''); } catch (e) { console.error('[Bildmigration] Wartungsmodus nicht beendet', e); }
    }
    running = false;
    setUi({ running: false, stopRequested: false });
  }
}

/** Die echte Umgebung am Primary. */
async function primaryEnv(): Promise<MigrationEnv> {
  const [{ getStockMediaOrchestrator }, core, { useAuthStore }, { isClientMode }, { runExclusive }, gate, drain, txc] = await Promise.all([
    import('./orchestrator.ts'), import('@tauri-apps/api/core'), import('../../stores/authStore'), import('../bridge/client-mode.ts'),
    import('../bridge/command-scheduler'), import('../bridge/maintenance-gate.ts'),
    import('./mobile-upload-drain.ts'), import('@/core/db/transaction-context'),
  ]);
  const orch = await getStockMediaOrchestrator();
  return {
    // Reihenfolge wie jeder Fernauftrag: erst die Schreib-Warteschlange, dann die Medien-Sperre.
    exclusive: (fn) => runExclusive(() => orch.runMaintenanceExclusive((lease) => fn(lease))),
    recompress: (a) => core.invoke<RecompressOutcome>('media_recompress_stored', {
      tenantScope: a.tenantScope, sourceHash: a.sourceHash, sourceExtension: a.sourceExtension, rendition: a.rendition,
      maxBytes: a.maxBytes, publish: a.publish, publishOnlyBelow: a.publishOnlyBelow ?? null,
    }),
    session: () => (useAuthStore.getState().session as { userId?: string; role?: string } | null) ?? null,
    isClientMode,
    setMaintenance: async (on, reason) => {
      // Rust zuerst AN und zuletzt AUS: der Server-Riegel umschließt den Renderer-Riegel.
      if (on) { await core.invoke('maintenance_mode_set', { active: true, reason }); gate.setMaintenanceGate(true, reason); }
      else { gate.setMaintenanceGate(false); await core.invoke('maintenance_mode_set', { active: false, reason: '' }); }
    },
    waitForDrainIdle: () => drain.waitForMobileDrainIdle(),
    appendLog: (name, line) => core.invoke('maintenance_log_append', { name, line }),
    transactionActive: () => txc.isTransactionActive(),
  };
}

export async function runImageStoreMigrationOnPrimary(req: MigrationRunRequest): Promise<MigrationRunResult> {
  return runImageMigrationWith(await primaryEnv(), req);
}

/** Bestandsübersicht (nur lesend, im exklusiven Platz: ein konsistenter Stand). */
export async function imageStoreInventoryOnPrimary(): Promise<ImageStoreInventory> {
  const env = await primaryEnv();
  if (env.isClientMode()) throw new Error('MIGRATION_PRIMARY_ONLY');
  return env.exclusive(async (lease) => inventoryImageStore(lease.db as MigrationDb));
}

/** Nur im E2E-Build: `window.__lataifImageMigration` — dieselben Funktionen wie die Owner-Karte. */
export function installImageMigrationBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__LATAIF_E2E__ !== true) return;
  w.__lataifImageMigration = {
    run: runImageStoreMigrationOnPrimary,
    stop: requestImageMigrationStop,
    state: imageMigrationUiState,
    inventory: imageStoreInventoryOnPrimary,
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

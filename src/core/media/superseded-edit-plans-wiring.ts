// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — Verdrahtung „überholte Galerie-Bearbeitungen abbrechen“ am Primary.
//
// Einstieg: die Karte in Settings → Data Repairs (nur Primary, nur Admin). Sie erscheint NUR, solange einer der
// zwei eingetragenen Jobs offen ist oder nach dem Abbruch das Embedding noch fehlt — danach nie wieder; auf einer
// Installation ohne diese Jobs nie. Keine allgemeine Bereinigung.
//
// Alles läuft unter DERSELBEN Medien-Sperre + DEMSELBEN DB-Lease wie jeder Upload/jede Wiederherstellung:
//   inspect → je Job das Urteil + Fingerabdruck; live: DB im Speicher + Rust-Journal (schreibt nichts)
//   close   → nur am Primary; Owner-Rolle wird HIER, unmittelbar vor der Änderung, aus der Sitzung gelesen;
//             Grund + Name der geprüften Sicherung Pflicht; nur Jobs mit dem Fingerabdruck aus `inspect`;
//             die Hausfunktion prüft unmittelbar vor der Transaktion erneut und weist bei jeder Änderung ab;
//             Prüfsummen von Artikeln, Medien, Zuordnungen, Generationen und sync_changelog vor/nach;
//             danach EIN durables Speichern
//   control → Nachkontrolle: Zustand der Jobs, Embedding-Kandidaten, Bildmigration nicht mehr blockiert
// ════════════════════════════════════════════════════════════════════════════
import {
  closeSupersededEditPlan, inspectSupersededEditPlan, supersededEditPlansStatus, SUPERSEDED_EDIT_PLAN_CASES,
  type SupersededCaseStatus, type SupersededCloseResult, type SupersededDb, type SupersededDeps, type SupersededVerdict,
  type SupersededEditPlanCase,
} from './superseded-edit-plans.ts';
import type { StoredEditPlanView } from './coordinator.ts';
import { findProductsNeedingEmbedding } from './embedding-reconcile.ts';
import { assertMigrationPreconditions, type MigrationDb } from './image-store-migration.ts';
import { canonicalRole } from '../models/types.ts';

/** Was die Verdrahtung von außen braucht — in der App echt, im Test ersetzbar. */
export interface SupersededEnv {
  runExclusive: <T>(fn: (lease: { db: unknown; saveDurably(): Promise<void> }, coordinator: { inspectStoredEditPlan(t: string, r: string): StoredEditPlanView | null }) => Promise<T>) => Promise<T>;
  journalPresent: (tenantScope: string, ingestRequestId: string) => Promise<boolean>;
  /** Die AKTUELLE Sitzung — wird beim Abbruch erst unmittelbar vor der Änderung gelesen. */
  session: () => { userId?: string | null; role?: string | null } | null;
  isClientMode: () => boolean;
  now?: () => string;
  /** Nur Tests: andere Liste zugelassener Vorgänge. Produktion: immer die zwei fest eingetragenen. */
  cases?: readonly SupersededEditPlanCase[];
}

export type SupersededRunRequest =
  | { mode: 'inspect' }
  | { mode: 'close'; fingerprints: Record<string, string>; reason: string; backupRef: string }
  | { mode: 'control' };

export interface SupersededUnchangedProof {
  /** Prüfsumme je Tabelle vor und nach dem Abbruch — muss gleich sein. */
  tables: Record<string, { before: string; after: string }>;
  otherJobsUnchanged: boolean;
  auditAdded: number;
  unchanged: boolean;
}

export interface SupersededControl {
  cases: Array<SupersededCaseStatus & { embeddingCandidate: boolean }>;
  /** `null` = die Bildmigration hat keine Blockade mehr; sonst der Fehlercode. */
  migrationBlockedBy: string | null;
}

export interface SupersededRunResult {
  inspected?: SupersededVerdict[];
  closed?: SupersededCloseResult[];
  proof?: SupersededUnchangedProof;
  control?: SupersededControl;
  saved: boolean;
  refused?: { code: 'SUPERSEDED_PRIMARY_ONLY' | 'SUPERSEDED_NOT_OWNER' | 'SUPERSEDED_NOTE_REQUIRED'; detail: string };
}

const PROOF_TABLES = ['products', 'media_links', 'media_objects', 'media_variants', 'media_blobs', 'media_blob_generations', 'sync_changelog'] as const;

function rowsOf(db: SupersededDb, sql: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const r = db.exec(sql, params);
  if (!r.length) return [];
  return r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]])));
}

async function sha(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Prüfsumme einer ganzen Tabelle (alle Spalten, feste Reihenfolge). Nur lesend. */
async function tableHash(db: SupersededDb, table: string): Promise<string> {
  const r = db.exec(`SELECT * FROM ${table} ORDER BY rowid`);
  return sha(JSON.stringify(r.length ? r[0].values : []));
}

async function snapshotHashes(db: SupersededDb, jobIds: string[]): Promise<{ tables: Record<string, string>; otherJobs: string; audit: number }> {
  const tables: Record<string, string> = {};
  for (const t of PROOF_TABLES) tables[t] = await tableHash(db, t);
  const ph = jobIds.map(() => '?').join(',');
  const other = db.exec(`SELECT * FROM media_ingest_jobs WHERE job_id NOT IN (${ph}) ORDER BY rowid`, jobIds);
  const otherJobs = await sha(JSON.stringify(other.length ? other[0].values : []));
  const audit = Number(rowsOf(db, 'SELECT COUNT(*) AS n FROM audit_log')[0]?.n ?? 0);
  return { tables, otherJobs, audit };
}

export function supersededControlOf(db: SupersededDb, cases: readonly SupersededEditPlanCase[] = SUPERSEDED_EDIT_PLAN_CASES): SupersededControl {
  const st = supersededEditPlansStatus(db, cases);
  const candidates = new Set(findProductsNeedingEmbedding(db as never).map((x) => x.productId));
  let migrationBlockedBy: string | null = null;
  try { assertMigrationPreconditions(db as unknown as MigrationDb); } catch (e) { migrationBlockedBy = (e as Error).message || 'MIGRATION_BLOCKED'; }
  return { cases: st.cases.map((c) => ({ ...c, embeddingCandidate: candidates.has(c.productId) })), migrationBlockedBy };
}

const BACKUP_REF = /^[A-Za-z0-9][A-Za-z0-9._ -]{7,119}$/;

export async function runSupersededEditPlans(env: SupersededEnv, req: SupersededRunRequest): Promise<SupersededRunResult> {
  if (env.isClientMode()) return { saved: false, refused: { code: 'SUPERSEDED_PRIMARY_ONLY', detail: 'this maintenance runs on the main computer only' } };
  if (req.mode === 'close') {
    // Frühes Nein ohne Sperre; maßgeblich ist die Prüfung unten, unmittelbar vor der Änderung.
    if (canonicalRole(env.session()?.role ?? undefined) !== 'ADMIN') return { saved: false, refused: { code: 'SUPERSEDED_NOT_OWNER', detail: 'only the owner may close these edits' } };
    if (!req.reason?.trim() || !BACKUP_REF.test(req.backupRef?.trim() ?? '')) {
      return { saved: false, refused: { code: 'SUPERSEDED_NOTE_REQUIRED', detail: 'a reason and the name of the verified backup are required' } };
    }
  }
  const cases = env.cases ?? SUPERSEDED_EDIT_PLAN_CASES;
  return env.runExclusive(async (lease, coordinator) => {
    const db = lease.db as SupersededDb;
    const deps: SupersededDeps = {
      db, inspect: (t, irid) => coordinator.inspectStoredEditPlan(t, irid),
      journalPresent: env.journalPresent, ...(env.now ? { now: env.now } : {}), cases,
    };
    if (req.mode === 'inspect') {
      const inspected: SupersededVerdict[] = [];
      for (const c of cases) inspected.push(await inspectSupersededEditPlan(deps, c.jobId));
      return { inspected, saved: false };
    }
    if (req.mode === 'control') return { control: supersededControlOf(db, cases), saved: false };

    const ids = cases.map((c) => c.jobId);
    const before = await snapshotHashes(db, ids);
    const closed: SupersededCloseResult[] = [];
    for (const c of cases) {
      const fp = req.fingerprints[c.jobId];
      if (!fp) continue; // nur ausdrücklich mitgebrachte Jobs
      // Die Rolle wird HIER gelesen — nicht aus der Maske, nicht vom Beginn des Vorgangs.
      const s = env.session();
      closed.push(await closeSupersededEditPlan(deps, c.jobId, fp, { userId: s?.userId ?? null, role: s?.role }, { reason: req.reason.trim(), backupRef: req.backupRef.trim() }));
    }
    const after = await snapshotHashes(db, ids);
    const tables: SupersededUnchangedProof['tables'] = {};
    for (const t of PROOF_TABLES) tables[t] = { before: before.tables[t], after: after.tables[t] };
    const otherJobsUnchanged = before.otherJobs === after.otherJobs;
    const proof: SupersededUnchangedProof = {
      tables, otherJobsUnchanged, auditAdded: after.audit - before.audit,
      unchanged: PROOF_TABLES.every((t) => tables[t].before === tables[t].after) && otherJobsUnchanged,
    };
    const mustSave = closed.some((r) => r.status === 'closed' || r.status === 'already_closed');
    if (mustSave) await lease.saveDurably();
    return { closed, proof, control: supersededControlOf(db, cases), saved: mustSave };
  });
}

/** Die echte Umgebung am Primary. */
export async function runSupersededEditPlansOnPrimary(req: SupersededRunRequest): Promise<SupersededRunResult> {
  const [{ getStockMediaOrchestrator }, core, { useAuthStore }, { isClientMode }] = await Promise.all([
    import('./orchestrator.ts'), import('@tauri-apps/api/core'), import('../../stores/authStore'), import('../bridge/client-mode.ts'),
  ]);
  const orch = await getStockMediaOrchestrator();
  return runSupersededEditPlans({
    runExclusive: (fn) => orch.runMaintenanceExclusive((lease, coordinator) => fn(lease, coordinator)),
    journalPresent: (tenantScope, ingestRequestId) => core.invoke<boolean>('media_ingest_journal_present', { tenantScope, ingestRequestId }),
    session: () => (useAuthStore.getState().session as { userId?: string; role?: string } | null) ?? null,
    isClientMode,
  }, req);
}

/** Nur im E2E-Build: `window.__lataifSupersededEditPlans` (Prüfungen auf isolierten Kopien). */
export function installSupersededEditPlansBridge(): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__LATAIF_E2E__ !== true) return;
  w.__lataifSupersededEditPlans = {
    run: runSupersededEditPlansOnPrimary,
    /** Nur E2E: einen Job zwischen Prüfen und Abbruch verändern (unter derselben Sperre, nicht gespeichert). */
    e2eTouch: async (jobId: string, delta: number) => {
      const { getStockMediaOrchestrator } = await import('./orchestrator.ts');
      const orch = await getStockMediaOrchestrator();
      return orch.runMaintenanceExclusive(async (lease) => {
        (lease.db as SupersededDb).run('UPDATE media_ingest_jobs SET attempt_count = attempt_count + ? WHERE job_id = ?', [delta, jobId]);
        return true;
      });
    },
    /** Nur E2E: Abmelden, um den Mutationspfad mit einer anderen Rolle zu prüfen. */
    e2eLogout: async () => { const { useAuthStore } = await import('../../stores/authStore'); useAuthStore.getState().logout(); return true; },
  };
}

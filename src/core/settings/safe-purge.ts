// ═══════════════════════════════════════════════════════════
// LATAIF — Safe Settings Purge core (D3)
// ═══════════════════════════════════════════════════════════
//
// Reiner, injizierbarer Kern für die Danger-Zone-Purges. KEINE Imports von React,
// Tauri, Stores oder sql.js-Runtime → headless testbar (echte in-memory sql.js-DB +
// Mocks im Test). Fasst NIE echte App-Daten an.
//
// Schließt die D0-Fehlerklasse: `SettingsPage.handlePurge()` löschte sync-getrackte
// Tabellen per stillem `DELETE FROM …`, OHNE Sync-Delete-Changes zu schreiben. Der
// Server-Changelog behielt die alten Inserts → ein späterer Pull/Replay konnte die
// gelöschten Records wiederbeleben. D3 schreibt jetzt für JEDEN gelöschten Record
// einen `delete`-Change (bestehendes trackDelete-Format, action='delete') — atomar,
// mit vorherigem Auto-Backup.
//
// KEINE neue Tombstone-/Baseline-/Compaction-Architektur (das ist D4).

// Minimale sql.js-Database-Form (strukturell erfüllt von sql.js Database — kein Import).
export interface PurgeStmt {
  bind(params: unknown[]): void;
  step(): boolean;
  get(): unknown[];
  free(): void;
}
export interface PurgeDb {
  prepare(sql: string): PurgeStmt;
  run(sql: string, params?: unknown[]): void;
}

// Ein Purge-Schritt = eine Tabelle + WHERE-Bedingung (genau EIN `?` = branch_id).
// Dieselbe Bedingung erzeugt `SELECT id …` (für die Delete-Changes) und `DELETE …`.
export interface PurgeStep {
  table: string;
  where: string;
}

// ── Purge-Pläne: exakt die Tabellen/Bedingungen des bisherigen handlePurge, ──
// ── nur Kinder-vor-Eltern geordnet. ALLE diese Tabellen sind sync-getrackt.  ──
const OFFER_LINES: PurgeStep = { table: 'offer_lines', where: 'offer_id IN (SELECT id FROM offers WHERE branch_id = ?)' };
const INVOICE_LINES: PurgeStep = { table: 'invoice_lines', where: 'invoice_id IN (SELECT id FROM invoices WHERE branch_id = ?)' };
const BRANCH = (table: string): PurgeStep => ({ table, where: 'branch_id = ?' });

export const PURGE_PLANS: Record<string, PurgeStep[]> = {
  products: [OFFER_LINES, INVOICE_LINES, BRANCH('products')],
  customers: [BRANCH('customers')],
  offers: [OFFER_LINES, BRANCH('offers')],
  invoices: [BRANCH('payments'), INVOICE_LINES, BRANCH('invoices')],
  repairs: [BRANCH('repairs')],
  consignments: [BRANCH('consignments')],
  agents: [BRANCH('agent_transfers'), BRANCH('agents')],
  orders: [BRANCH('orders')],
  tasks: [BRANCH('tasks')],
  documents: [BRANCH('documents')],
  all_data: [
    OFFER_LINES,
    INVOICE_LINES,
    BRANCH('payments'),
    BRANCH('agent_transfers'),
    BRANCH('offers'),
    BRANCH('invoices'),
    BRANCH('repairs'),
    BRANCH('consignments'),
    BRANCH('agents'),
    BRANCH('orders'),
    BRANCH('tasks'),
    BRANCH('documents'),
    BRANCH('products'),
    BRANCH('customers'),
  ],
};

export interface PurgeCounts {
  perTable: Record<string, number>;
  total: number;
}

/** Alle betroffenen IDs eines Schritts lesen (branch-gescopet). */
export function selectPurgeIds(db: PurgeDb, step: PurgeStep, branchId: string): string[] {
  const stmt = db.prepare(`SELECT id FROM ${step.table} WHERE ${step.where}`);
  try {
    stmt.bind([branchId]);
    const ids: string[] = [];
    while (stmt.step()) {
      const row = stmt.get();
      if (row.length > 0 && row[0] != null) ids.push(String(row[0]));
    }
    return ids;
  } finally {
    stmt.free();
  }
}

/** Nur zählen (für die UI-Bestätigung „N betroffene Datensätze"). Schreibt nichts. */
export function countPurge(db: PurgeDb, steps: PurgeStep[], branchId: string): PurgeCounts {
  const perTable: Record<string, number> = {};
  let total = 0;
  for (const step of steps) {
    const n = selectPurgeIds(db, step, branchId).length;
    perTable[step.table] = (perTable[step.table] ?? 0) + n;
    total += n;
  }
  return { perTable, total };
}

/**
 * Kern-Purge: pro Schritt ALLE betroffenen IDs lesen, für JEDE ID `onDelete(table, id)`
 * (= Sync-Delete-Change), danach die Zeilen löschen. Reihenfolge: exakt `steps`
 * (Kinder vor Eltern). Wirft `onDelete`, propagiert der Fehler VOR dem DELETE dieser
 * Tabelle → der aufrufende Transaktions-Rahmen (runSafePurge) rollt alles zurück.
 * Achtung: selbst NICHT transaktional — Atomarität liefert der Rahmen (BEGIN/COMMIT/ROLLBACK).
 */
export function executeTrackedPurge(
  db: PurgeDb,
  steps: PurgeStep[],
  branchId: string,
  onDelete: (table: string, id: string) => void
): PurgeCounts {
  const perTable: Record<string, number> = {};
  let total = 0;
  for (const step of steps) {
    const ids = selectPurgeIds(db, step, branchId);
    // 1. Für JEDEN Record einen Delete-Change schreiben (vor dem lokalen Löschen).
    for (const id of ids) onDelete(step.table, id);
    // 2. Danach lokal löschen (branch-gescopet == dieselbe Zeilenmenge wie oben gelesen).
    db.run(`DELETE FROM ${step.table} WHERE ${step.where}`, [branchId]);
    perTable[step.table] = (perTable[step.table] ?? 0) + ids.length;
    total += ids.length;
  }
  return { perTable, total };
}

export interface SafePurgeResult extends PurgeCounts {
  backupLocation: string;
}

export interface SafePurgeDeps {
  db: PurgeDb;
  /** Auto-Backup VOR jeder Löschung. Wirft → Abbruch, es wird NICHTS gelöscht. */
  backup: () => Promise<{ location: string }>;
  begin: () => void;
  commit: () => void;
  rollback: () => void;
  /** Ein Sync-Delete-Change pro Record (Produktion: trackDelete). */
  onDelete: (table: string, id: string) => void;
}

/**
 * Vollständiger sicherer Purge-Ablauf:
 *   1. Auto-Backup (throws → Abbruch, kein Delete, kein trackDelete).
 *   2. BEGIN → executeTrackedPurge (delete-changes + lokale Deletes) → COMMIT.
 *   3. Fehler in (2) → ROLLBACK (nichts halb gelöscht) und Fehler weiterreichen.
 */
export async function runSafePurge(
  steps: PurgeStep[],
  branchId: string,
  deps: SafePurgeDeps
): Promise<SafePurgeResult> {
  // 1. Backup zuerst — bei Fehler NICHTS anfassen.
  const backup = await deps.backup();

  // 2. Atomarer, getrackter Purge.
  deps.begin();
  try {
    const counts = executeTrackedPurge(deps.db, steps, branchId, deps.onDelete);
    deps.commit();
    return { ...counts, backupLocation: backup.location };
  } catch (err) {
    deps.rollback();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// D3b — Factory-Reset-Guard
// ═══════════════════════════════════════════════════════════
//
// Factory Reset löscht NUR die lokale DB. Ist Sync/LAN konfiguriert oder aktiv, kann ein
// späterer Pull alte Server-Daten wiederherstellen (Resurrection) — genau die D0-Klasse.
// Darum: Reset blockieren, solange Sync/LAN konfiguriert ist. Für sync-getrackte Daten ist
// der sichere Purge (runSafePurge) der richtige Weg; eine vollständige Server-Baseline/
// Compaction kommt erst in D4 (hier NICHT gebaut).

export const FACTORY_RESET_BLOCKED_MESSAGE =
  'Factory Reset ist blockiert, weil Sync/LAN konfiguriert ist. Ein lokaler Reset könnte Server-Daten wiederherstellen. Nutze Safe Purge oder deaktiviere Sync bewusst.';

/**
 * True → Factory Reset blockieren. Union der sauberen vorhandenen Quellen:
 *   - syncConfigured: sync-service.isSyncConfigured() (Client-URL+Token gesetzt), UND/ODER
 *   - lanMode !== 'off': auto-lan.getLanMode() ('server' | 'client' | 'manual') — deckt auch
 *     den LAN-Host und den Client VOR dem Login (Token noch leer) ab.
 */
export function isFactoryResetBlocked(signals: { syncConfigured: boolean; lanMode: string }): boolean {
  return signals.syncConfigured || (signals.lanMode !== 'off' && signals.lanMode !== '');
}

export interface GuardedResetDeps {
  syncConfigured: boolean;
  lanMode: string;
  /** Auto-Backup vor dem echten Reset (nur wenn NICHT blockiert). Wirft → Abbruch, kein Reset. */
  backup: () => Promise<{ location: string }>;
  /** Der echte lokale Reset (resetDatabase). Nur wenn nicht blockiert UND Backup erfolgreich. */
  reset: () => Promise<void>;
  /** Wird bei Blockade aufgerufen (Fehlermeldung setzen) — KEINE destruktive Aktion. */
  onBlocked: () => void;
}

/**
 * Sicherer Factory-Reset:
 *   - Sync/LAN konfiguriert → `onBlocked()`, KEIN Backup, KEIN Reset, `blocked: true`.
 *   - sonst: Backup (wirft → Abbruch, kein Reset) → Reset → `blocked: false`.
 */
export async function runGuardedReset(deps: GuardedResetDeps): Promise<{ blocked: boolean; backupLocation?: string }> {
  if (isFactoryResetBlocked({ syncConfigured: deps.syncConfigured, lanMode: deps.lanMode })) {
    deps.onBlocked();
    return { blocked: true };
  }
  const backup = await deps.backup(); // Fehler → wirft → kein Reset
  await deps.reset();
  return { blocked: false, backupLocation: backup.location };
}

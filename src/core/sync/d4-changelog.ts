// ═══════════════════════════════════════════════════════════
// LATAIF — D4-B: pure sync-changelog logic (baseline / tombstones / compaction)
// ═══════════════════════════════════════════════════════════
//
// Reine, deterministische Logik über SYNTHETISCHE Change-Strukturen. KEINE SQLite-Datei,
// kein Tauri, KEIN Date.now — headless testbar und ohne jeden Zugriff auf echte Daten.
// Liegt bei den anderen Sync-Bausteinen (`src/core/sync/`), damit ein späteres Dry-Run-/
// Migrationstool (D4-C/D) genau diese verifizierte Logik wiederverwenden kann.
//
// Grundlagen (aus D4-A belegt):
//   - Der Server-Changelog ist append-only, `id` (AUTOINCREMENT) = Sequence/Cursor.
//   - Clients wenden Changes in id-Reihenfolge an: insert/update = Upsert, delete = DELETE.
//     → „delete gewinnt" gilt id-geordnet bereits (delete mit höherer id kommt nach insert).
//   - Der Rest-Fix: (a) Wachstum → Compaction, (b) verwaiste Alt-Inserts (gelöscht ohne
//     delete-Change) → autoritative Baseline + synthetische Tombstones.
//
// D4-B baut NUR die Algorithmik. Kein Schreiben in echte Changelogs, keine Migration.

export type ChangeAction = 'insert' | 'update' | 'delete';

// Eine Changelog-Zeile (synthetisch — im Test/Plan, nicht aus echter DB).
export interface Change {
  id: number;
  tenant_id: string;
  branch_id: string;
  table_name: string;
  record_id: string;
  action: ChangeAction;
  data: Record<string, unknown>;
  created_at: string;
}

// Ein autoritativer Live-Record (aus der SSOT `lataif.db` eines gesunden Geräts).
export interface AuthoritativeRecord {
  tenant_id: string;
  branch_id: string;
  table_name: string;
  record_id: string;
  data: Record<string, unknown>;
}

// Eine GEPLANTE Änderung (noch OHNE echte id — die vergibt später der Server beim Append).
export interface PlannedChange {
  tenant_id: string;
  branch_id: string;
  table_name: string;
  record_id: string;
  action: ChangeAction;
  data: Record<string, unknown>;
  reason: 'baseline-upsert' | 'synthetic-delete';
}

// Finaler Zustand eines Records nach Replay.
export interface ReplayEntry {
  tenant_id: string;
  branch_id: string;
  table_name: string;
  record_id: string;
  deleted: boolean; // Tombstone?
  data: Record<string, unknown> | null; // finaler Stand wenn live, sonst null
  lastId: number;
  lastAction: ChangeAction;
}
export type ReplayState = Map<string, ReplayEntry>;

// ── Record-Identität: tenant + branch + table + record_id (keine Vermischung über Branches) ──
export function recordKey(r: {
  tenant_id: string;
  branch_id: string;
  table_name: string;
  record_id: string;
}): string {
  return JSON.stringify([r.tenant_id, r.branch_id, r.table_name, r.record_id]);
}

function sortById(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => a.id - b.id);
}

// Kanonischer Vergleich flacher Row-Objekte (schlüssel-sortiert → order-unabhängig).
function canon(o: Record<string, unknown> | null): string {
  if (o == null) return 'null';
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ── 1. Replay: id-geordnet, insert/update = Upsert, delete = Tombstone. Finaler Zustand/Record. ──
export function replayChanges(changes: Change[]): ReplayState {
  const state: ReplayState = new Map();
  for (const c of sortById(changes)) {
    const key = recordKey(c);
    if (c.action === 'delete') {
      state.set(key, {
        tenant_id: c.tenant_id, branch_id: c.branch_id, table_name: c.table_name, record_id: c.record_id,
        deleted: true, data: null, lastId: c.id, lastAction: 'delete',
      });
    } else {
      state.set(key, {
        tenant_id: c.tenant_id, branch_id: c.branch_id, table_name: c.table_name, record_id: c.record_id,
        deleted: false, data: c.data, lastId: c.id, lastAction: c.action,
      });
    }
  }
  return state;
}

export function liveRecords(state: ReplayState): ReplayEntry[] {
  return [...state.values()].filter((e) => !e.deleted);
}
export function tombstones(state: ReplayState): ReplayEntry[] {
  return [...state.values()].filter((e) => e.deleted);
}

export interface CorrectiveBaselinePlan {
  baselineUpserts: PlannedChange[];
  syntheticDeletes: PlannedChange[];
}

// ── 2+4. Corrective Baseline: autoritative Live-Records als Upserts re-asserten; für Records, ──
// ── die der Changelog aktuell als LIVE replayt, aber die NICHT autoritativ sind (verwaiste     ──
// ── Alt-Inserts) → synthetische delete-Tombstones. Bereits getombstonete Records werden        ──
// ── übersprungen → idempotent (keine Doppel-Tombstones).                                        ──
export function buildCorrectiveBaselinePlan(input: {
  changes: Change[];
  authoritativeLiveRecords: AuthoritativeRecord[];
}): CorrectiveBaselinePlan {
  const { changes, authoritativeLiveRecords } = input;

  const authKeys = new Set<string>();
  for (const r of authoritativeLiveRecords) authKeys.add(recordKey(r));

  const baselineUpserts: PlannedChange[] = authoritativeLiveRecords.map((r) => ({
    tenant_id: r.tenant_id, branch_id: r.branch_id, table_name: r.table_name, record_id: r.record_id,
    action: 'insert', data: r.data, reason: 'baseline-upsert',
  }));

  const state = replayChanges(changes);
  const syntheticDeletes: PlannedChange[] = [];
  for (const e of liveRecords(state)) {
    if (!authKeys.has(recordKey(e))) {
      syntheticDeletes.push({
        tenant_id: e.tenant_id, branch_id: e.branch_id, table_name: e.table_name, record_id: e.record_id,
        action: 'delete', data: {}, reason: 'synthetic-delete',
      });
    }
  }
  return { baselineUpserts, syntheticDeletes };
}

export interface CompactionPlan {
  kept: Change[]; // pro Record EINE konsolidierte Zeile (finaler Upsert ODER Tombstone)
  archived: Change[]; // überholte Zeilen → archivieren/prunen
}

// ── 3. Compaction: pro Record nur die FINALE Zeile behalten (finaler Zustand bzw. Tombstone), ──
// ── den Rest archivieren. Deletes/Tombstones bleiben erhalten.                                  ──
export function compactChangePlan(changes: Change[]): CompactionPlan {
  const byKey = new Map<string, Change[]>();
  for (const c of changes) {
    const k = recordKey(c);
    const arr = byKey.get(k);
    if (arr) arr.push(c);
    else byKey.set(k, [c]);
  }
  const kept: Change[] = [];
  const archived: Change[] = [];
  for (const arr of byKey.values()) {
    const sorted = sortById(arr);
    kept.push(sorted[sorted.length - 1]); // finale Zeile (höchste id) = finaler Zustand/Tombstone
    for (let i = 0; i < sorted.length - 1; i++) archived.push(sorted[i]);
  }
  kept.sort((a, b) => a.id - b.id);
  archived.sort((a, b) => a.id - b.id);
  return { kept, archived };
}

export interface FinalStateDiff {
  identical: boolean;
  differences: Array<{
    key: string;
    kind: 'data-changed' | 'liveness-changed' | 'only-in-before' | 'only-in-after';
    before?: ReplayEntry;
    after?: ReplayEntry;
  }>;
}

// ── 4b/8. Zwei finale Zustände vergleichen. Compaction erwartet `identical`; Baseline erwartet ──
// ── bewusste `liveness-changed`-Korrekturen (verwaist live → deleted).                          ──
export function compareFinalStates(before: ReplayState, after: ReplayState): FinalStateDiff {
  const differences: FinalStateDiff['differences'] = [];
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const b = before.get(key);
    const a = after.get(key);
    if (b && !a) differences.push({ key, kind: 'only-in-before', before: b });
    else if (!b && a) differences.push({ key, kind: 'only-in-after', after: a });
    else if (b && a) {
      if (b.deleted !== a.deleted) differences.push({ key, kind: 'liveness-changed', before: b, after: a });
      else if (!b.deleted && !a.deleted && canon(b.data) !== canon(a.data))
        differences.push({ key, kind: 'data-changed', before: b, after: a });
    }
  }
  return { identical: differences.length === 0, differences };
}

// ── Hilfen: geplante Changes zu Changes materialisieren (Server-Append simulieren; Tests/Dry-Run). ──
export function maxId(changes: Change[]): number {
  return changes.reduce((m, c) => Math.max(m, c.id), 0);
}
export function plannedToChanges(planned: PlannedChange[], startId: number, createdAt: string): Change[] {
  return planned.map((p, i) => ({
    id: startId + i + 1,
    tenant_id: p.tenant_id, branch_id: p.branch_id, table_name: p.table_name, record_id: p.record_id,
    action: p.action, data: p.data, created_at: createdAt,
  }));
}

export interface PlanSummary {
  tables: number;
  liveRecords: number; // autoritative Live (= baseline upserts) bzw. kompaktierte Live-Records
  tombstones: number; // synthetische + behaltene delete-Tombstones
  archivedChanges: number; // von der Compaction entfernt/archiviert
  syntheticDeletes: number;
  baselineUpserts: number;
  keptChanges: number; // Gesamtgröße des kompaktierten Satzes
}

// ── 5. Zusammenfassung eines (Baseline- und/oder Compaction-)Plans. ──
export function summarizePlan(plan: {
  baselineUpserts?: PlannedChange[];
  syntheticDeletes?: PlannedChange[];
  kept?: Change[];
  archived?: Change[];
}): PlanSummary {
  const baselineUpserts = plan.baselineUpserts ?? [];
  const syntheticDeletes = plan.syntheticDeletes ?? [];
  const kept = plan.kept ?? [];
  const archived = plan.archived ?? [];

  const tableSet = new Set<string>();
  for (const p of baselineUpserts) tableSet.add(p.table_name);
  for (const p of syntheticDeletes) tableSet.add(p.table_name);
  for (const c of kept) tableSet.add(c.table_name);
  for (const c of archived) tableSet.add(c.table_name);

  const keptTombstones = kept.filter((c) => c.action === 'delete').length;
  const keptLive = kept.length - keptTombstones;

  return {
    tables: tableSet.size,
    liveRecords: baselineUpserts.length > 0 ? baselineUpserts.length : keptLive,
    tombstones: syntheticDeletes.length + keptTombstones,
    archivedChanges: archived.length,
    syntheticDeletes: syntheticDeletes.length,
    baselineUpserts: baselineUpserts.length,
    keptChanges: kept.length,
  };
}

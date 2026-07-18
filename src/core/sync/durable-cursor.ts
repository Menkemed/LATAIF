// ═══════════════════════════════════════════════════════════
// LATAIF — M2: Durable Mobile Sync Cursor
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Orchestrierung der EINEN Sicherheitsreihenfolge fuer den
// Desktop-Sync-Pull:
//
//     apply batch  →  await durable save  →  advance cursor
//
// M1-Root-Cause (bestaetigt + reproduziert): pullChanges wandte Remote-Changes nur
// in die In-Memory-sql.js an, rief `saveDatabase()` FIRE-AND-FORGET (nicht awaited)
// und rueckte den Sync-Cursor (`lataif_sync_last_id`) SOFORT synchron in localStorage
// vor. Starb der Prozess (Updater-Relaunch / Force-Kill / abgebrochener Close-Flush)
// zwischen In-Memory-Apply und bestaetigtem Disk-Write, war das Item nie auf Disk —
// der Cursor aber schon vorgerueckt → der Server sendet es nie erneut → PERMANENTER,
// stiller Verlust.
//
// Kanonische Regel: der Cursor darf NUR vorgerueckt werden, wenn der Batch angewandt
// UND durabel auf die aktive DB-Datei geschrieben UND vom Persistenzpfad als erfolgreich
// bestaetigt wurde. Bei JEDEM Fehler (apply / save / cursor-write) bleibt der Cursor
// auf dem alten Wert und der Fehler wird weitergereicht → der naechste Pull fordert
// dieselben Server-Changes erneut an. Das ist sicher, weil das Anwenden idempotent ist
// (applyUpsert: SELECT-COUNT → UPDATE-if-exists sonst INSERT; DELETE eines bereits
// geloeschten Datensatzes = No-op).
//
// Die Logik ist von den konkreten DB-/Save-/Cursor-Funktionen ENTKOPPELT (Dependency-
// Injection), damit GENAU diese produktive Reihenfolge getestet werden kann — ohne eine
// zweite Implementierung. sync-service.ts injiziert den echten Apply-Loop,
// saveDatabaseDurably und den localStorage-Cursor-Write.

export interface DurableCursorOps {
  /** Wendet ALLE Changes des Batches auf die In-Memory-DB an. Wirft nur bei einem
   *  systemischen Apply-Fehler (einzelne kaputte Changes werden intern geloggt+uebersprungen). */
  applyBatch(): void;
  /** Awaitbare DURABLE Persistenz: resolved erst nach bestaetigtem Disk-Write, WIRFT bei
   *  Persist-Fehler (Stale-Konflikt/transient). NICHT das fire-and-forget saveDatabase(). */
  durableSave(): Promise<void>;
  /** Persistiert den Sync-Cursor (z.B. localStorage `lataif_sync_last_id`). NUR nach durablem Save. */
  setCursor(): void;
}

// Fuehrt den gepullten Batch in der Sicherheitsreihenfolge aus. Bei JEDEM Fehler
// (apply, save oder cursor-write) wird der Cursor NICHT vorgerueckt bzw. der Fehler
// propagiert VOR dem Cursor — der naechste Pull replayt dieselben Changes idempotent.
export async function commitPulledBatch(ops: DurableCursorOps): Promise<void> {
  ops.applyBatch();          // Apply-Fehler → wirft VOR save/cursor (kein Advance)
  await ops.durableSave();   // Save-Fehler → wirft VOR cursor (Cursor bleibt alt → Re-Pull)
  ops.setCursor();           // NUR nach bestaetigtem durablem Save
}

// ── M2-A: Batch-Atomaritaet (kein stiller per-Change-Skip) ──────────────────────
//
// Bestaetigte Restluecke: der alte Apply-Loop fing einzelne Apply-Fehler PRO Change ab und
// loggte sie nur. Bei einem Batch [21, 22, 23] konnte 22 fehlschlagen + geschluckt werden,
// 21 und 23 wurden angewandt, der durable Save gelang, der Cursor sprang auf 23 → Change 22
// war DAUERHAFT uebersprungen und wurde nie erneut gepullt (stiller Sync-/Datenverlust).
//
// Kanonische Regel: der Cursor darf nur bis zu einer Change-ID vorruecken, wenn JEDE Aenderung
// bis einschliesslich dieser ID erfolgreich angewandt UND durabel gespeichert wurde. Deshalb:
// der GESAMTE Batch wird in EINER Transaktion angewandt; beim ERSTEN Fehler → ROLLBACK (verwirft
// alle bereits angewandten Changes des Batches → kein partieller, nicht-dauerhafter Memory-Stand)
// und ein SyncApplyError mit Kontext (change id / table / record / op) wird geworfen. Der
// aufrufende commitPulledBatch erreicht dann weder durableSave noch setCursor → Cursor bleibt alt
// → der naechste Pull liefert den GESAMTEN Batch erneut (applyUpsert/DELETE ist idempotent).

export interface SyncChangeRef {
  id?: number | string;
  table_name: string;
  record_id: string;
  action: string;
  // M6-B3A — the raw payload, present on pulled changes. Only ever HASHED for a quarantine record,
  // never stored raw. Optional so the strict M2 callers (which never quarantine) need not carry it.
  data?: string;
}

// Fehler mit genau dem Kontext, der zum Nachvollziehen noetig ist — OHNE Payload/sensible Daten.
export class SyncApplyError extends Error {
  readonly changeId: number | string | undefined;
  readonly table: string;
  readonly recordId: string;
  readonly action: string;
  readonly cause: unknown;
  constructor(change: SyncChangeRef, cause: unknown) {
    super(
      `[Sync] apply failed at change id=${change.id ?? '?'} record=${change.record_id} ` +
      `table=${change.table_name} op=${change.action}: ${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = 'SyncApplyError';
    this.changeId = change.id;
    this.table = change.table_name;
    this.recordId = change.record_id;
    this.action = change.action;
    this.cause = cause;
  }
}

export interface BatchApplyOps {
  /** Transaktion oeffnen (z.B. db.run('BEGIN')). */
  begin(): void;
  /** EINE Change anwenden. Wirft bei Fehler (der Batch bricht dann ab). */
  applyChange(change: SyncChangeRef): void;
  /** Transaktion bestaetigen (z.B. db.run('COMMIT')). */
  commit(): void;
  /** Transaktion verwerfen (z.B. db.run('ROLLBACK')) — verwirft ALLE Changes des Batches. */
  rollback(): void;
  // M6-B3A §9/§10 — OPTIONAL. Wenn gesetzt, wird eine DETERMINISTISCHE Policy-Ablehnung
  // (SyncPoisonError: verbotene/unbekannte Tabelle, ungueltiges/nicht-erlaubtes Feld, kaputter
  // Payload) NICHT als Batch-Fehler behandelt, sondern hier gemeldet — dauerhaft QUARANTAENISIERT
  // IN DERSELBEN Transaktion — und der Batch laeuft weiter. So werden gueltige Changes vor UND nach
  // einer vergifteten Zeile angewandt und gemeinsam-atomar committed; die vergiftete Zeile gilt als
  // quarantaenisiert, NICHT als angewandt. Ohne diesen Hook (Default) bleibt das strikte
  // Alles-oder-Nichts-Verhalten: jede Poison-Ablehnung bricht den Batch ab (Rollback). Ein
  // Poison wird strukturell erkannt (`isSyncPoison`), damit dieses Modul den Fehlertyp nicht
  // importieren muss. `code` ist der stabile SYNC_*-Code der Ablehnung.
  onPoison?(change: SyncChangeRef, code: string): void;
}

// Ein SyncPoisonError traegt `code` + `isSyncPoison === true`. Strukturell geprueft, damit
// durable-cursor keine apply-change-Kopplung braucht (bleibt reiner Orchestrator).
function poisonCodeOf(err: unknown): string | null {
  if (err && typeof err === 'object' && (err as { isSyncPoison?: unknown }).isSyncPoison === true) {
    const c = (err as { code?: unknown }).code;
    return typeof c === 'string' ? c : 'SYNC_POISON';
  }
  return null;
}

// Wendet ALLE Changes atomar an: begin → jede Change → commit.
//  • Ohne ops.onPoison: beim ERSTEN Fehler rollback (verwirft den ganzen Batch) + SyncApplyError —
//    kein Change wird uebersprungen (M2-A Alles-oder-Nichts, unveraendert).
//  • Mit ops.onPoison (M6-B3A): eine deterministische SyncPoisonError-Ablehnung wird ueber
//    onPoison quarantaenisiert und uebersprungen (Batch laeuft weiter); JEDER ANDERE Fehler (echter
//    transienter DB-Fault) fuehrt weiterhin zu rollback + SyncApplyError. Quarantaene-Insert und
//    angewandte Changes committen gemeinsam in EINER Transaktion.
export function applyChangesAtomic(changes: SyncChangeRef[], ops: BatchApplyOps): void {
  ops.begin();
  let current: SyncChangeRef | null = null;
  try {
    for (const change of changes) {
      current = change;
      try {
        ops.applyChange(change);
      } catch (err) {
        const code = poisonCodeOf(err);
        if (ops.onPoison && code !== null) {
          // Deterministische Ablehnung → in derselben Tx quarantaenisieren, dann weiter.
          ops.onPoison(change, code);
          continue;
        }
        throw err; // transient oder kein onPoison → Batch abbrechen (aeusserer catch → rollback)
      }
    }
    ops.commit();
  } catch (err) {
    // Rollback-Fehler darf den Original-Fehler nicht verdecken.
    try { ops.rollback(); } catch { /* ignore */ }
    throw err instanceof SyncApplyError ? err : new SyncApplyError(current as SyncChangeRef, err);
  }
}

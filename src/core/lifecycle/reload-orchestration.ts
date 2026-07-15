// ═══════════════════════════════════════════════════════════
// LATAIF — M5: Refresh & Reload Persistence
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Orchestrierung des sicheren App-Reload (F5 / Ctrl+R / app-eigener
// Reload). Analog zu M4 (Close), aber der finale Schritt ist ein Webview-/App-Reload statt
// Window-Close:
//
//     Status → UI-Turn → Sync pausieren → laufenden Sync abwarten → durableSave → Reload
//
// Warum: unter Tauri ist `flushDatabaseSync()` ein No-op (siehe database.ts) — ein nativer
// Reload (F5/Ctrl+R) laedt den Webview neu und `initDatabase()` liest die DB-Datei erneut von
// der Platte. War der letzte In-Memory-Stand (z.B. gerade gesyncte Uploads oder ein pending
// saveDatabase()) noch nicht durabel geschrieben, ist er nach dem Reload weg. `beforeunload`/
// `pagehide` koennen keinen asynchronen durablen Save abwarten. Deshalb: den Reload abfangen,
// erst durabel speichern, dann reloaden.
//
// Kanonische Regel: KEIN Reload, solange ein Sync laeuft ODER ein DB-Write laeuft ODER der
// aktuelle In-Memory-Stand nicht durabel bestaetigt ist. Bei JEDEM Fehler (wait/save): kein
// Reload, App bleibt offen, Fehler sichtbar, Background kontrolliert wieder aufgenommen, Retry.
//
// Entkoppelt (Dependency-Injection): App.tsx injiziert pauseAutoSync/waitForSyncIdle/
// resumeAutoSync (M4-A1, Aufruf — keine Sync-Aenderung), saveDatabaseDurably (M2) und
// window.location.reload(). KEINE zweite Persistenzimplementierung — dieselben M2/M4-Primitive.

export type ReloadStatus =
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

export interface ReloadOrchestrationOps {
  /** UI-Status setzen (null = zuruecksetzen). App.tsx rendert daraus das Save-/Fehler-Overlay
   *  (derselbe CloseOverlay wie M4 — ReloadStatus ist strukturell gleich CloseStatus). */
  setStatus: (status: ReloadStatus | null) => void;
  /** Regel E: dem UI einen Render-/Event-Loop-Turn geben, BEVOR der (potenziell blockierende)
   *  db.export()/Save startet (z.B. setTimeout(0) — NICHT rAF, das bei hidden window nie feuert). */
  yieldToRender?: () => Promise<void>;
  /** Neue Background-Writes stoppen (z.B. pauseAutoSync() → kein neuer Sync-Pull). */
  pauseBackgroundWrites: () => void;
  /** Optional: auf einen bereits laufenden Sync/Write warten, bevor gespeichert wird. */
  waitForPendingOperations?: () => Promise<void>;
  /** Durable Persistenzbarriere: erzwingt einen frischen db.export() + persist und WIRFT bei
   *  Persist-Fehler ODER aktiver Ambient-Tx (saveDatabaseDurably, M2). NICHT das fire-and-forget
   *  saveDatabase(). Fuer Reload bewusst der staerkere Vertrag (immer frischer Snapshot). */
  durableSave: () => Promise<void>;
  /** Fuehrt den eigentlichen Reload aus (z.B. window.location.reload()). NUR nach durablem Save. */
  reloadApplication: () => void | Promise<void>;
  /** Optional: bei Fehler den pausierten Background-Betrieb wieder aufnehmen. */
  resumeBackgroundWrites?: () => void;
}

// Fuehrt den Reload in der Sicherheitsreihenfolge aus. Bei Wait-/Save-Fehler: KEIN reload,
// Status 'error', Background wieder aufnehmen, Fehler propagieren (App bleibt offen, Retry).
export async function prepareAndReloadApplication(ops: ReloadOrchestrationOps): Promise<void> {
  ops.setStatus({ kind: 'saving' });                 // Regel E: erst Status…
  if (ops.yieldToRender) await ops.yieldToRender();  // …dann ein Render-Turn (Overlay sichtbar)
  ops.pauseBackgroundWrites();                        // keine neuen Background-Writes ab jetzt
  try {
    if (ops.waitForPendingOperations) await ops.waitForPendingOperations();
    await ops.durableSave();                          // durable Barriere; wirft bei Fehler/aktiver Tx
  } catch (err) {
    ops.setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    ops.resumeBackgroundWrites?.();                   // Betrieb kontrolliert wieder aufnehmen
    throw err;                                         // KEIN reloadApplication
  }
  await ops.reloadApplication();                       // nur nach bestaetigter Persistenz
}

// Single-Flight-Barriere: waehrend ein Reload-Flow laeuft, liefern weitere Aufrufe (Doppel-F5,
// zweiter Klick) dasselbe Promise — keine zweite Save-/Reload-Kette. Nach Abschluss (Erfolg ODER
// Fehler) ist der Guard frei → nach einem Persistenzfehler ist ein erneuter Reload-Versuch moeglich.
export function createSingleFlight(run: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const p = (async () => run())().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return inFlight;
  };
}

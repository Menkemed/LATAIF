// ═══════════════════════════════════════════════════════════
// LATAIF — M4-A: Window Close & Shutdown Persistence
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Orchestrierung des sicheren App-Close:
//
//     Single-Flight  →  UI-Status  →  Background-Writes stoppen  →  pending Ops abwarten
//     →  durabler Flush  →  kontrollierter Window-Close
//
// Vorher (App.tsx onCloseRequested): der Handler flushte best-effort mit 1,5s-Cap, SCHLUCKTE
// jeden Flush-Fehler und beendete den Prozess ueber Hard-Exit-Timer (proc.exit(0) nach 3s bzw.
// 1,5s) — d.h. bei langsamer/fehlgeschlagener Persistenz wurde ohne bestaetigten Disk-Write hart
// beendet (Datenverlust) und der Nutzer sah nichts. Zudem liefen Background-Writes (Sync-Pull)
// waehrend des Close weiter.
//
// Kanonische Regeln:
//   A — Kein Hard-Kill mit unbestaetigter Persistenz: der Window-Close passiert NUR nach einem
//       erfolgreichen Flush. Schlaegt der Flush fehl (oder haengt), bleibt die App offen.
//   B — Persistenzfehler haelt die App offen: kein Close, sichtbarer Fehler, Retry moeglich.
//   C — Single-Flight: der erste X-Klick startet den Flow; weitere Klicks haengen sich an
//       denselben Lauf (keine zweite Flush-/Close-Kette).
//   D — Keine neuen Background-Writes ab Close-Beginn: stopBackgroundWrites() zuerst; optional
//       auf bereits laufende Operationen warten.
//   E — UI rendert vor dem (potenziell blockierenden) Flush: setStatus('saving') + ein
//       Render-/Event-Loop-Turn, damit "Daten werden gespeichert…" sichtbar wird.
//
// Bei Fehler wird NICHT der Prozess hart beendet — die App bleibt offen, der Background-Betrieb
// wird (falls pausiert) wieder aufgenommen und der Fehler propagiert an den Aufrufer.
//
// Entkoppelt von Tauri-Window/Sync/DB (Dependency-Injection), damit genau diese Reihenfolge
// headless getestet werden kann. App.tsx injiziert stopAutoSync/startAutoSync (Aufruf, keine
// Sync-Aenderung), flushDatabase (wartet auf angeforderte Writes + WIRFT bei Fehler) und
// closeWindow = den nativen Close-Finalizer (M4-D: invoke('finalize_application_shutdown')).

export type CloseStatus =
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

export interface CloseOrchestrationOps {
  /** UI-Status setzen (null = zuruecksetzen). App.tsx rendert daraus das Save-/Fehler-Overlay. */
  setStatus: (status: CloseStatus | null) => void;
  /** Regel E: der UI mindestens einen Render-/Event-Loop-Turn geben, BEVOR der blockierende
   *  Flush startet (z.B. requestAnimationFrame / setTimeout(0)). Optional (Tests lassen es weg). */
  yieldToRender?: () => Promise<void>;
  /** Regel D: neue Background-Writes stoppen (z.B. stopAutoSync() → kein neuer Sync-Pull). */
  stopBackgroundWrites: () => void;
  /** Optional: auf bereits laufende Operationen warten, bevor geflusht wird. */
  waitForPendingOperations?: () => Promise<void>;
  /** Durable Persistenzbarriere: schliesst alle bereits angeforderten Writes ab und WIRFT bei
   *  Fehler (z.B. flushDatabase() — NICHT das fire-and-forget saveDatabase()). */
  flushPendingDatabaseWrites: () => Promise<void>;
  /** M4-D: nativer Close-Finalizer (z.B. invoke('finalize_application_shutdown') → Rust stoppt den
   *  Sync-Server und ruft AppHandle::exit(0)). NUR nach erfolgreichem Flush. Im Erfolgsfall beendet
   *  Rust den Prozess (Promise loest nie auf); wirft nur, wenn der Finalizer VOR dem Exit fehlschlaegt. */
  closeWindow: () => Promise<void>;
  /** Optional: bei Fehler den (in Schritt D pausierten) Background-Betrieb wieder aufnehmen. */
  resumeBackgroundWrites?: () => void;
}

// Fuehrt den Close in der Sicherheitsreihenfolge aus. Bei Flush-Fehler: KEIN closeWindow, Status
// 'error', Background wieder aufnehmen, Fehler propagieren (App bleibt offen, Retry moeglich).
export async function prepareAndCloseApplication(ops: CloseOrchestrationOps): Promise<void> {
  ops.setStatus({ kind: 'saving' });                 // Regel E: erst Status…
  if (ops.yieldToRender) await ops.yieldToRender();  // …dann einen Render-Turn zulassen
  ops.stopBackgroundWrites();                         // Regel D: keine neuen Background-Writes mehr
  try {
    if (ops.waitForPendingOperations) await ops.waitForPendingOperations();
    await ops.flushPendingDatabaseWrites();           // Persistenzbarriere; wirft bei Fehler
    // M4-D: finaler Schritt = nativer Close-Finalizer (Rust: Sync-Server stoppen + nativer Prozess-Exit).
    // NUR nach bestaetigter Persistenz. Im Erfolgsfall beendet Rust den Prozess → dieses Promise loest
    // nie auf (normaler Exit-Pfad, kein Fehler). Schlaegt der Finalizer VOR dem Exit fehl, landet der
    // Fehler ebenfalls im catch: App bleibt offen, Fehler sichtbar, Retry moeglich (Regel A/B).
    await ops.closeWindow();
  } catch (err) {
    ops.setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    ops.resumeBackgroundWrites?.();                   // Betrieb kontrolliert wieder aufnehmen
    throw err;                                         // Regel A/B: kein nativer Exit → App bleibt offen
  }
}

// Single-Flight-Barriere (Regel C): waehrend ein Close-Flow laeuft, liefern weitere Aufrufe
// dasselbe Promise — keine zweite Flush-/Close-Kette. Nach Abschluss (Erfolg ODER Fehler) ist
// der Guard frei, sodass nach einem Persistenzfehler ein erneuter Close-Versuch moeglich ist.
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

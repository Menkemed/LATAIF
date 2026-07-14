// ═══════════════════════════════════════════════════════════
// LATAIF — M3: Durable DB Flush Before Updater Relaunch
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Orchestrierung der EINEN Sicherheitsreihenfolge fuer den
// Desktop-Auto-Update:
//
//     durable save  →  download + install  →  relaunch
//
// M1/M3-Root-Cause: der UpdateBanner rief `update.downloadAndInstall()` und danach
// `relaunch()` OHNE vorher den aktuellen In-Memory-DB-Stand dauerhaft auf die aktive
// lataif.db zu schreiben. Auf Windows ersetzt der NSIS-Installer die laufende .exe und
// `relaunch()` beendet den Prozess — pending, noch nicht persistierte Aenderungen (z.B.
// gerade gesyncte Mobile-Uploads) waren dann fuer immer weg (der Prozess starb, bevor der
// letzte fire-and-forget saveDatabase() auf der Platte landete).
//
// Kanonische Regel: VOR jedem Install/Relaunch muss der aktuelle Stand als Save angefordert,
// vollstaendig persistiert und der Persistenzerfolg bestaetigt sein. Bei JEDEM Fehler
// (save / download+install / relaunch) bricht die Kette ab, der Fehler propagiert und es
// wird NICHTS weiter ausgefuehrt: ein Save-Fehler verhindert Download UND Relaunch, ein
// Install-Fehler verhindert den Relaunch, ein Relaunch-Fehler wird sichtbar (die bestehende
// App bleibt offen, wird NICHT hart beendet).
//
// Die Logik ist von Tauri-Updater/Process und vom konkreten Save-Pfad ENTKOPPELT
// (Dependency-Injection), damit GENAU diese produktive Reihenfolge headless getestet werden
// kann — ohne eine zweite Implementierung. UpdateBanner injiziert saveDatabaseDurably (M2),
// update.downloadAndInstall und relaunch.

export type UpdatePhase =
  | { kind: 'saving' }
  | { kind: 'downloading'; progress: number }
  | { kind: 'installing' }
  | { kind: 'relaunching' };

export interface UpdateOrchestrationOps {
  /** Awaitbare DURABLE Persistenz des aktuellen In-Memory-DB-Stands. Resolved erst nach
   *  bestaetigtem Disk-Write, WIRFT bei Persist-Fehler ODER aktiver Ambient-Transaktion.
   *  Bevorzugt saveDatabaseDurably (M2) — NICHT das fire-and-forget saveDatabase(). */
  durableSave: () => Promise<void>;
  /** Laedt das Update herunter und installiert es (Tauri update.downloadAndInstall). */
  downloadAndInstall: () => Promise<void>;
  /** Startet die App neu (Tauri plugin-process relaunch). */
  relaunch: () => Promise<void>;
  /** Optional: Status-Callback fuer die UI (Saving… / Downloading / Installing / Relaunching). */
  onPhase?: (phase: UpdatePhase) => void;
}

// Fuehrt das Update in der Sicherheitsreihenfolge aus. Keine Stufe beginnt vor dem
// erfolgreichen Abschluss ihrer Vorgaengerin; der erste Fehler propagiert und stoppt die Kette.
export async function prepareAndInstallUpdate(ops: UpdateOrchestrationOps): Promise<void> {
  ops.onPhase?.({ kind: 'saving' });
  await ops.durableSave();               // 1. Save-Fehler / aktive Tx → wirft VOR download+relaunch
  ops.onPhase?.({ kind: 'downloading', progress: 0 });
  await ops.downloadAndInstall();        // 2. nur nach bestaetigtem Save; Install-Fehler → wirft VOR relaunch
  ops.onPhase?.({ kind: 'relaunching' });
  await ops.relaunch();                  // 3. nur nach erfolgreichem Install
}

// Single-Flight-Barriere gegen Doppelklick: solange ein Lauf aktiv ist, liefern weitere
// Aufrufe dasselbe Promise zurueck — es startet KEINE zweite durableSave/download/install/
// relaunch-Kette. Nach Abschluss (Erfolg ODER Fehler) ist der Guard wieder frei, sodass ein
// bewusster Retry nach einem Fehler wieder eine frische Kette starten kann.
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

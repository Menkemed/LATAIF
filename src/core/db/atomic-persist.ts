// ═══════════════════════════════════════════════════════════
// LATAIF — Atomic sql.js persistence core (D2)
// ═══════════════════════════════════════════════════════════
//
// Reiner, Tauri-/sql.js-agnostischer Kern für das Schreiben der lataif.db-Datei.
// KEINE Imports von sql.js, Tauri oder Browser-Globals → läuft headless im Test
// (Node-fs-Adapter gegen synthetische Temp-Dateien) und fasst NIE echte App-Daten an.
//
// Härtet zwei Dinge (D0-RC4):
//   1. Atomic write   — nie direkt in die finale DB schreiben. Erst Temp, verifizieren,
//                       dann atomar rename → ein abgebrochener Write kann die gute DB
//                       nicht mehr halb überschreiben/beschädigen.
//   2. Stale-write    — ein älterer In-Memory-Snapshot darf keinen NEUEREN Disk-Stand
//                       überschreiben. Wir merken uns die Signatur (size+mtime) der Datei,
//                       wie wir sie zuletzt geladen/geschrieben haben, und verweigern den
//                       Save, wenn die Platte seither fremd verändert wurde.
//
// Fail-open-Prinzip beim Stale-Check: ist keine Baseline bekannt oder die Datei nicht
// stat-bar, wird der Save ERLAUBT (ein legitimer eigener Save darf nie blockieren).
// Verweigert wird NUR bei bekannter Baseline UND lesbarer, ABWEICHENDER Disk-Signatur.

// ── Minimal-fs-Schnittstelle (deckt Tauri plugin-fs UND Node fs/promises ab) ──
export interface FsLike {
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: Date | null }>;
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
}

// ── Disk-Signatur = das, was wir über den aktuellen Datei-Stand auf der Platte wissen ──
export interface DiskSig {
  size: number;
  mtimeMs: number | null; // null = Plattform ohne mtime → Vergleich fällt auf size-only zurück
}

// ── Konflikt-Fehler: Platte wurde fremd/neuer verändert → Save verweigert ──
export class StaleWriteError extends Error {
  readonly baseline: DiskSig | null;
  readonly current: DiskSig | null;
  constructor(baseline: DiskSig | null, current: DiskSig | null) {
    super(
      '[DB] stale-write guard: die DB-Datei wurde seit dem letzten Laden/Speichern extern ' +
        'verändert — Überschreiben eines neueren Stands verweigert'
    );
    this.name = 'StaleWriteError';
    this.baseline = baseline;
    this.current = current;
  }
}

// SQLite-Dateiheader (16 Bytes): "SQLite format 3" (15 ASCII) + 0x00-Null-Terminator.
// Bewusst KEIN eingebettetes \0 im String-Literal (Editor-/Tool-sicher) — Byte 15 separat prüfen.
const SQLITE_MAGIC_PREFIX = 'SQLite format 3'; // exakt 15 Zeichen

/** True, wenn der Puffer mit dem gültigen 16-Byte-SQLite-Header beginnt (schützt vor Nicht-DB-Blobs). */
export function sqliteHeaderOk(data: Uint8Array): boolean {
  if (data.length < 16) return false;
  for (let i = 0; i < SQLITE_MAGIC_PREFIX.length; i++) {
    if (data[i] !== SQLITE_MAGIC_PREFIX.charCodeAt(i)) return false;
  }
  return data[15] === 0; // Null-Terminator (16. Byte)
}

/** Zwei Disk-Signaturen gleich? size muss immer passen; mtime nur wenn beide Seiten sie kennen. */
export function sigEqual(a: DiskSig | null, b: DiskSig | null): boolean {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  if (a.mtimeMs == null || b.mtimeMs == null) return true; // size stimmt, mtime unbekannt → als gleich werten
  return a.mtimeMs === b.mtimeMs;
}

/** Signatur der Datei auf der Platte lesen. null = fehlt / nicht stat-bar (→ keine Baseline). */
export async function statSig(fs: FsLike, path: string): Promise<DiskSig | null> {
  try {
    const st = await fs.stat(path);
    return { size: st.size, mtimeMs: st.mtime ? st.mtime.getTime() : null };
  } catch {
    return null;
  }
}

/**
 * Wirft StaleWriteError GENAU DANN, wenn eine Baseline bekannt ist UND die Datei auf der
 * Platte lesbar ist UND ihre Signatur von der Baseline abweicht. In allen anderen Fällen
 * (keine Baseline / Datei fehlt / nicht stat-bar) kehrt sie zurück → Save erlaubt (fail-open).
 */
export async function assertNotStale(
  fs: FsLike,
  finalPath: string,
  baseline: DiskSig | null
): Promise<void> {
  if (baseline == null) return; // kein Referenzpunkt → nicht blockieren
  const current = await statSig(fs, finalPath);
  if (current == null) return; // Datei fehlt / unlesbar → nichts zu überschreiben bzw. nicht verifizierbar
  if (sigEqual(current, baseline)) return; // Platte ist exakt das, was wir zuletzt ablegten → sicher
  throw new StaleWriteError(baseline, current);
}

export interface AtomicWriteOpts {
  dir: string;
  finalPath: string;
  tmpPath: string;
  data: Uint8Array;
  baseline: DiskSig | null;
}

/**
 * Ersetzt finalPath atomar durch `data`:
 *   header-check → stale-guard → mkdir → write(temp) → verify(size) → rename(temp→final) → neue Signatur.
 * Bei JEDEM Fehler bleibt die finale Datei unangetastet und der Temp wird best-effort entfernt.
 * Rückgabe: die frische Disk-Signatur der finalen Datei (neue Baseline für den nächsten Save).
 */
export async function atomicWrite(fs: FsLike, opts: AtomicWriteOpts): Promise<DiskSig> {
  const { dir, finalPath, tmpPath, data, baseline } = opts;

  // 0. Korrupt-Export-Schutz: niemals einen Nicht-SQLite-Blob über eine gute DB schreiben.
  if (!sqliteHeaderOk(data)) {
    throw new Error(`[DB] persist abgelehnt: Puffer ist kein SQLite-Image (len=${data.length})`);
  }

  // 1. Stale-Guard VOR jedem Schreiben — bei Konflikt raus, bevor wir die Platte anfassen.
  await assertNotStale(fs, finalPath, baseline);

  // 2. Zielverzeichnis sicherstellen (idempotent).
  await fs.mkdir(dir, { recursive: true }).catch(() => {});

  // 3. In eine Temp-Datei schreiben — NIE direkt in die finale Datei.
  try {
    await fs.writeFile(tmpPath, data);
  } catch (err) {
    await fs.remove(tmpPath).catch(() => {});
    throw err; // finale Datei unangetastet
  }

  // 4. Temp verifizieren: existiert + exakte Größe (fängt abgeschnittene/teilweise Writes).
  const tmpSig = await statSig(fs, tmpPath);
  if (tmpSig == null || tmpSig.size !== data.length) {
    await fs.remove(tmpPath).catch(() => {});
    throw new Error(
      `[DB] Temp-Verify fehlgeschlagen (erwartet ${data.length}B, bekam ${tmpSig ? tmpSig.size : 'fehlt'})`
    );
  }

  // 5. Atomarer Ersatz: rename temp → final (gleiches Volume → atomar auf Windows/POSIX,
  //    ersetzt bestehende Datei via MoveFileEx REPLACE_EXISTING / rename(2)).
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.remove(tmpPath).catch(() => {});
    throw err; // rename gescheitert → finale Datei ist noch die alte, gute Version
  }

  // 6. Neue Ist-Signatur der finalen Datei zurückgeben (nächste Baseline).
  const sig = await statSig(fs, finalPath);
  return sig ?? { size: data.length, mtimeMs: null };
}

// ═══════════════════════════════════════════════════════════
// Save-Coalescer — serialisiert Speichervorgänge (nur EIN Write gleichzeitig)
// ═══════════════════════════════════════════════════════════
//
// Erhält das bestehende Coalescing-Verhalten (paralleles saveDatabase() → koalesziert;
// am Ende landet garantiert der ALLERLETZTE In-Memory-Stand auf der Platte), macht aber
// Fehler sichtbar statt sie still zu verschlucken:
//   - onError wird bei jedem Persist-Fehler aufgerufen (Logging).
//   - getLastError() liefert den letzten Fehler (für Diagnose/UI).
//   - flush() wirft den letzten Fehler → App-Quit-Pfad kann ihn beobachten/loggen.
//   - isFatal(err) (z. B. StaleWriteError): NICHT in Endlosschleife weiter versuchen/clobbern.

export interface CoalescerOpts {
  /** Aktuellen In-Memory-Stand als Bytes exportieren (z. B. db.export()). */
  snapshot: () => Uint8Array;
  /** Bytes persistieren (z. B. atomic write auf Disk / localStorage). Darf werfen. */
  persist: (data: Uint8Array) => Promise<void>;
  /** Optional: ob überhaupt gespeichert werden kann (z. B. db != null). Default: immer true. */
  isReady?: () => boolean;
  /** Optional: jeder Persist-/Export-Fehler (Logging — KEINE Secrets/Base64 loggen). */
  onError?: (err: unknown) => void;
  /** Optional: „fataler" Fehler (z. B. Konflikt) → nicht als transienter Retry behandeln. */
  isFatal?: (err: unknown) => boolean;
}

export interface SaveCoalescer {
  requestSave(): Promise<void>;
  flush(maxRounds?: number): Promise<void>;
  getLastError(): unknown;
  isDirty(): boolean;
}

export function createSaveCoalescer(opts: CoalescerOpts): SaveCoalescer {
  const ready = opts.isReady ?? (() => true);
  let dirty = false;
  let inFlight: Promise<void> | null = null;
  let lastError: unknown = null;

  async function drain(): Promise<void> {
    try {
      while (dirty && ready()) {
        dirty = false;

        let data: Uint8Array;
        try {
          data = opts.snapshot();
        } catch (err) {
          // Export scheiterte → Stand bleibt dirty für nächsten Versuch.
          lastError = err;
          opts.onError?.(err);
          dirty = true;
          break;
        }

        try {
          await opts.persist(data);
          lastError = null; // Erfolg löscht den letzten Fehler
        } catch (err) {
          lastError = err;
          opts.onError?.(err);
          if (opts.isFatal?.(err)) {
            // Konflikt (z. B. Stale-Write): NICHT weiter drehen und NICHT clobbern.
            // dirty bleibt false → keine Endlosschleife; Fehler via getLastError/flush sichtbar.
            break;
          }
          dirty = true; // transient → beim nächsten requestSave erneut versuchen
          break;
        }
      }
    } finally {
      inFlight = null;
    }
  }

  function kick(): Promise<void> {
    dirty = true;
    if (!inFlight) inFlight = drain();
    return inFlight;
  }

  return {
    requestSave(): Promise<void> {
      return kick();
    },
    async flush(maxRounds = 10): Promise<void> {
      // Mehrere Runden, falls während des Drains neue Mutationen kommen.
      for (let i = 0; i < maxRounds; i++) {
        if (inFlight) await inFlight;
        if (!dirty) break;
        kick();
      }
      // Persistierten Fehler nach außen sichtbar machen (App-Quit loggt ihn).
      if (lastError) {
        const e = lastError;
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    getLastError(): unknown {
      return lastError;
    },
    isDirty(): boolean {
      return dirty;
    },
  };
}

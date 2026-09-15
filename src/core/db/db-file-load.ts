// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7C R4 — welche der drei Antworten liegt vor: Datei fehlt, Bytes, unlesbar?
//
// CENTRAL-C6-P1 hat „fehlt" und „komme nicht heran" getrennt. Zwei Wege führten trotzdem in einen
// neuen, leeren Bestand, obwohl eine Datei da war:
//
//   1. Eine vorhandene 0-Byte-`lataif.db` (Stromausfall kurz nach einem Speichern, Eingriff von
//      außen): sql.js öffnet 0 Bytes als LEERE Datenbank, `initDatabase` legte Schema und Migrationen
//      an, und das nächste Speichern hätte die Datei ersetzt. Jetzt: unlesbar → der bestehende
//      `DB_RECOVERY_REQUIRED`-Weg, die Datei bleibt, wie sie ist.
//   2. `exists` sagt auch dann „nein", wenn nur die Metadaten nicht lesbar sind (Rust
//      `Path::exists` verschluckt jeden Fehler). „Fehlt" gilt jetzt erst, wenn die Nachfrage
//      ausdrücklich „nicht gefunden" meldet; jeder andere Fehler ist kein Beweis → unlesbar.
//
// Kein Integritätsaudit: eine Datei mit Bytes geht wie bisher an sql.js; kann es sie nicht öffnen,
// endet der Start dort ebenfalls in der Wiederherstellung (C6-P1).
// ════════════════════════════════════════════════════════════════════════════

/** Die drei Dateizugriffe, die das Laden braucht (Tauri plugin-fs, im Test Node `fs`). */
export interface DbFileFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  stat(path: string): Promise<{ size: number; mtime: Date | null }>;
}

export type DbFileLoad =
  | { kind: 'missing' }
  | { kind: 'bytes'; data: Uint8Array; sig: { size: number; mtimeMs: number | null } | null }
  | { kind: 'unreadable'; reason: string };

/** „Nicht gefunden" — Windows (os error 2 Datei / 3 Pfad), POSIX/Node (ENOENT). Sonst kein Beweis. */
const NOT_FOUND = /\(os error [23]\)|\bENOENT\b|no such file or directory|cannot find the (file|path) specified/i;

export async function loadDbFile(fs: DbFileFs, path: string): Promise<DbFileLoad> {
  let exists: boolean;
  try {
    exists = await fs.exists(path);
  } catch (err) {
    return { kind: 'unreadable', reason: `existence check failed: ${String(err)}` };
  }
  if (!exists) {
    try {
      await fs.stat(path);
      // Die Nachfrage fand sie doch: wie eine vorhandene Datei weiter.
    } catch (err) {
      if (NOT_FOUND.test(String(err))) return { kind: 'missing' };
      return { kind: 'unreadable', reason: `absence not proven: ${String(err)}` };
    }
  }
  let data: Uint8Array;
  try {
    data = new Uint8Array(await fs.readFile(path));
  } catch (err) {
    return { kind: 'unreadable', reason: `read failed: ${String(err)}` };
  }
  if (data.byteLength === 0) {
    return { kind: 'unreadable', reason: 'the database file is empty (0 bytes) — it is kept unchanged; restore the last backup' };
  }
  let sig: { size: number; mtimeMs: number | null } | null = null;
  try {
    const st = await fs.stat(path);
    sig = { size: st.size, mtimeMs: st.mtime ? st.mtime.getTime() : null };
  } catch {
    sig = null; // nicht stat-bar → keine Baseline (Stale-Check fällt fail-open aus, wie bisher)
  }
  return { kind: 'bytes', data, sig };
}

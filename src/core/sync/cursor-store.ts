// SYNC-SAFETY-A1 — wie weit der Pull gekommen ist, gehoert zu den Daten, nicht zum Rechner.
//
// Bisher stand dieser Wasserstand als `lataif_sync_last_id` im localStorage der WebView. Alles
// andere, was den Sync beschreibt, liegt im Datenverzeichnis: der Aenderungslog, die Identitaet
// der Installation, die Quarantaene, der Push-Stand — nur diese eine Zahl lag auf C:. Geht C:
// verloren (oder loescht jemand die Verbindung und legt sie neu an), faengt der Pull wieder bei
// 0 an und spielt die gesamte Historie erneut ein. Genau das ist beim Kollegen passiert: ein
// laengst geloeschter Transfer wurde erneut eingefuegt, seine Nummer war inzwischen an einen
// anderen Datensatz vergeben, der eindeutige Index schlug zu — und der Pull stand fuer immer.
//
// Deshalb steht der Wasserstand jetzt IN der Business-Datenbank, in derselben Transaktion
// geschrieben wie das Anwenden selbst. Damit gilt: wer die Daten hat, hat auch ihren Stand.
//
// Und er wird an einen Server gebunden. Nicht an dessen Adresse — die aendert sich mit jedem
// neuen WLAN — sondern an den oeffentlichen Namen der Installation, den der Server bei jedem
// Pull mitschickt (eine Einwegableitung seiner Install-Kennung, nie die Kennung selbst). So
// ueberlebt der Stand einen Adresswechsel, und ein wirklich anderer Server bekommt niemals
// einen fremden Wasserstand untergeschoben.

import type { SqlDb } from './apply-change';

export const CURSOR_DDL = `CREATE TABLE IF NOT EXISTS sync_cursor (
  server_fingerprint TEXT PRIMARY KEY,
  last_sync_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** Ein Server-Name ist die 32-stellige Hex-Ableitung aus `install_id::public_fingerprint`. */
export function isServerFingerprint(fp: unknown): fp is string {
  return typeof fp === 'string' && /^[0-9a-f]{32}$/.test(fp);
}

/** Der gespeicherte Stand fuer diesen Server — `null`, wenn es fuer ihn noch keinen gibt. */
export function readCursor(db: SqlDb, fingerprint: string): number | null {
  if (!isServerFingerprint(fingerprint)) return null;
  // Fehlt die Tabelle (sehr alter Bestand, dessen Schema-Lauf sie noch nicht angelegt hat), ist das
  // KEIN Absturz und auch kein Freifahrtschein: 'kein Stand' fuehrt in den fail-closed-Zweig.
  let r: Array<{ columns: string[]; values: unknown[][] }>;
  try { r = db.exec('SELECT last_sync_id FROM sync_cursor WHERE server_fingerprint = ?', [fingerprint]); }
  catch { return null; }
  if (r.length === 0 || r[0].values.length === 0) return null;
  const v = Number(r[0].values[0][0]);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Den Stand fortschreiben.
 *
 * Nie rueckwaerts: das `WHERE last_sync_id < ?` ist kein Komfort, sondern die Regel. Ein Pull,
 * der aus einem kleineren Fenster antwortet (etwa direkt nach einem Verbindungsaufbau, wenn die
 * Anfrage noch bei 0 begann), darf den erreichten Stand nicht senken — sonst liefe genau der
 * Wiedereinspiel-Fall erneut an, den diese Datei verhindert.
 *
 * Gibt den Stand zurueck, der danach gilt.
 */
export function writeCursor(db: SqlDb, fingerprint: string, lastSyncId: number, now: string): number {
  if (!isServerFingerprint(fingerprint)) throw new Error('[Sync] cursor needs a server fingerprint');
  const next = Math.trunc(Number(lastSyncId));
  if (!Number.isFinite(next) || next < 0) throw new Error('[Sync] cursor needs a non-negative id');
  const current = readCursor(db, fingerprint);
  if (current === null) {
    db.run('INSERT INTO sync_cursor (server_fingerprint, last_sync_id, updated_at) VALUES (?, ?, ?)',
      [fingerprint, next, now]);
    return next;
  }
  if (next <= current) return current;
  db.run('UPDATE sync_cursor SET last_sync_id = ?, updated_at = ? WHERE server_fingerprint = ? AND last_sync_id < ?',
    [next, now, fingerprint, next]);
  return readCursor(db, fingerprint) ?? current;
}

/** Was beim ersten Pull nach dem Update mit dem alten Stand geschehen soll. */
export type CursorStart =
  /** Bekannter Stand — von hier wird weitergemacht. */
  | { kind: 'known'; cursor: number }
  /** Der alte localStorage-Stand wurde einmalig uebernommen. */
  | { kind: 'adopted'; cursor: number }
  /** Erstkontakt mit einem Server, der noch nichts zu erzaehlen hat. */
  | { kind: 'fresh'; cursor: number }
  /** Kein Stand rekonstruierbar, aber der Server hat Historie — hier wird NICHTS angewendet. */
  | { kind: 'recovery-required' };

/**
 * Den Startpunkt bestimmen — die eine Stelle, an der ueber Wiedereinspielen entschieden wird.
 *
 * Vier Faelle, und keiner davon ist geraten:
 *
 *  1. Es gibt einen gespeicherten Stand fuer diesen Server → der gilt.
 *  2. Es gibt keinen, aber den alten Wert aus dem localStorage. Der wird EINMAL uebernommen, und
 *     das ist belegt, nicht angenommen: der Pull, der gerade geantwortet hat, war mit dem
 *     gespeicherten Token authentifiziert, und dieses Token gilt nur gegen das Geheimnis genau
 *     dieses Servers. Alter Stand und altes Token sind ein Paar — `clearSyncConfig` loescht sie
 *     gemeinsam. Also gehoert der alte Stand zu dem Server, der eben geantwortet hat.
 *  3. Kein Stand, kein alter Wert, und der Server hat ueberhaupt keine Historie (`serverMaxId`
 *     ist 0) → bei 0 anzufangen kann nichts wiederholen. Das ist die Erstinstallation.
 *  4. Kein Stand, kein alter Wert, aber der Server HAT Historie → dann ist unbekannt, was davon
 *     hier schon angekommen ist. Weder 0 (spielt alles erneut ein) noch das Log-Ende (ueberspringt
 *     womoeglich Echtes) waere zu verantworten. Also wird nichts angewendet und der Zustand
 *     benannt. Fail-closed, wie ueberall sonst im Datenwurzel-Vertrag.
 */
export function resolveCursorStart(
  db: SqlDb,
  fingerprint: string,
  legacyCursor: number | null,
  serverMaxId: number,
  now: string,
): CursorStart {
  const known = readCursor(db, fingerprint);
  if (known !== null) return { kind: 'known', cursor: known };

  if (legacyCursor !== null && Number.isFinite(legacyCursor) && legacyCursor > 0) {
    const cursor = writeCursor(db, fingerprint, Math.trunc(legacyCursor), now);
    return { kind: 'adopted', cursor };
  }

  if (!(serverMaxId > 0)) {
    const cursor = writeCursor(db, fingerprint, 0, now);
    return { kind: 'fresh', cursor };
  }

  return { kind: 'recovery-required' };
}

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

/**
 * Liegt der Server HINTER unserem Stand?
 *
 * Der Kopf des Logs ist die hoechste Id, die der Server ueberhaupt hat — nicht das Ende des
 * gerade betrachteten Fensters. Ist unser Stand groesser, dann kennt dieser Server Aenderungen
 * nicht mehr, die wir bereits von ihm angewendet haben: seine Datenbank wurde zurueckgesetzt
 * oder halb wiederhergestellt. Beide naheliegenden Reaktionen waeren falsch — den Stand senken
 * hiesse alles dazwischen ein zweites Mal anwenden, weitermachen hiesse seine kuenftigen
 * Aenderungen ueberspringen. Also gibt diese Funktion nur den Befund zurueck und ueberlaesst
 * dem Aufrufer das Anhalten.
 *
 * `null` heisst: in Ordnung (oder es gibt hier keinen Stand, dann ist nichts zu pruefen).
 */
export function serverLogBehind(db: SqlDb, fingerprint: string, logHead: number): { cursor: number; head: number } | null {
  const cursor = readCursor(db, fingerprint);
  if (cursor === null) return null;
  const head = Math.trunc(Number(logHead));
  if (!Number.isFinite(head) || head < 0) return null;
  return cursor > head ? { cursor, head } : null;
}

/** Was beim ersten Pull ohne gespeicherten Stand geschehen soll. */
export type CursorStart =
  /** Bekannter Stand — von hier wird weitergemacht. */
  | { kind: 'known'; cursor: number }
  /** Erstkontakt mit einem Server, der noch nichts zu erzaehlen hat. */
  | { kind: 'fresh'; cursor: number }
  /** Der Anfang der Historie ist nachweislich eigener Ursprung — er wird uebersprungen, nicht wiederholt. */
  | { kind: 'reconstructed'; cursor: number; ownPrefix: number }
  /** Kein Stand, und die Historie beginnt mit etwas Fremdem — hier wird NICHTS uebersprungen. */
  | { kind: 'recovery-required' };

/** Eine Aenderung, wie der Pull sie liefert. */
export interface PulledChange {
  id?: number | string;
  table_name: string;
  record_id: string;
  action: string;
  data?: string;
}

const ownKey = (c: { table_name: string; record_id: string; action: string; data?: string }): string =>
  // Getrennt durch ein Zeichen, das in keinem Bezeichner und in keiner JSON-Nutzlast vorkommt —
  // sonst koennte eine Grenze verrutschen und zwei verschiedene Aenderungen denselben
  // Schluessel bekommen. Im Quelltext steht es als Escape, damit die Datei reiner Text bleibt.
  [c.table_name, c.record_id, c.action, c.data ?? ''].join('\u0000');

/**
 * Alles, was DIESE Datenbank selbst schon einmal an den Server geschickt hat — MIT ANZAHL.
 *
 * Der eigene Ausgangskorb (`sync_changelog` in der Business-DB) ist die Aufzeichnung der eigenen
 * Schreibvorgaenge: eine Zeile entsteht NACH dem lokalen Schreiben und wird erst nach der Annahme
 * durch den Server als gesendet markiert. Kommt genau diese Zeile spaeter beim Pull zurueck, dann
 * beschreibt sie einen Schreibvorgang, der hier entstanden ist — und dessen weitere Geschichte
 * (auch ein spaeteres Loeschen) diese Datenbank bereits kennt.
 *
 * Gezaehlt wird, weil einmal gesendet nicht einmal angekommen heisst: bricht die Verbindung NACH
 * der Annahme und VOR der Antwort ab, bleibt die Zeile hier ungesendet und wird erneut geschickt —
 * der Server hat sie dann zweimal, unter zwei Ids. Ein blosses "so eine Zeile gibt es" wuerde
 * beide Kopien mit demselben einen Beleg decken. Also deckt jeder Beleg genau eine Kopie.
 */
export function ownPushedCounts(db: SqlDb): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const r = db.exec('SELECT table_name, record_id, action, data FROM sync_changelog');
    if (r.length > 0) {
      for (const v of r[0].values) {
        const k = ownKey({
          table_name: String(v[0] ?? ''), record_id: String(v[1] ?? ''),
          action: String(v[2] ?? ''), data: v[3] === null || v[3] === undefined ? '' : String(v[3]),
        });
        out.set(k, (out.get(k) ?? 0) + 1);
      }
    }
  } catch { /* kein Ausgangskorb → nichts ist als eigener Ursprung belegt */ }
  return out;
}
/**
 * Wie weit der Anfang der gelieferten Historie NACHWEISLICH eigener Ursprung ist.
 *
 * Gezaehlt wird nur ein ununterbrochener Anfang: die erste Aenderung, die nicht belegt werden
 * kann, beendet die Reihe. Alles danach wird ganz normal angewendet — hier wird nichts
 * uebersprungen, was fremd sein koennte.
 */
export function provenOwnPrefix(changes: PulledChange[], own: Map<string, number>): { count: number; lastId: number } {
  // Auf einer Kopie gearbeitet: der Aufrufer bekommt seine Belege unveraendert zurueck.
  const left = new Map(own);
  let count = 0;
  let lastId = 0;
  for (const c of changes) {
    const k = ownKey(c);
    const n = left.get(k) ?? 0;
    if (n <= 0) break;
    left.set(k, n - 1);
    count++;
    const id = Number(c.id ?? 0);
    if (Number.isFinite(id) && id > lastId) lastId = id;
  }
  return { count, lastId };
}
/**
 * Den Startpunkt bestimmen — die eine Stelle, an der ueber Wiedereinspielen entschieden wird.
 *
 * Der alte localStorage-Wert taugt dafuer ausdruecklich NICHT als Beweis. Er wurde nie an einen
 * Server gebunden: `setSyncConfig` schrieb Adresse und Token, ohne ihn anzufassen, also konnte
 * ein Verbinden mit einem anderen Server den Stand des vorigen stehen lassen. Ein gueltiges
 * Token beweist deshalb nur, WER gerade antwortet — nicht, zu wem die alte Zahl gehoerte.
 *
 * Was sich stattdessen wirklich beweisen laesst, steht in der Datenbank selbst: der eigene
 * Ausgangskorb. Ist der Anfang der Historie Zeile fuer Zeile das, was diese Datenbank selbst
 * gesendet hat, dann ist er hier bereits geschehen — und darf uebersprungen werden, ohne dass
 * irgendetwas geraten wird. Sobald die Reihe abreisst, endet das Ueberspringen.
 *
 *  1. Gespeicherter Stand fuer diesen Server → der gilt.
 *  2. Der Server hat ueberhaupt keine Historie → bei 0 anfangen kann nichts wiederholen.
 *  3. Der Anfang der Historie ist belegter eigener Ursprung → hinter diesen Anfang springen.
 *  4. Sonst → NICHTS anwenden, Zustand benennen. Weder 0 (spielt alles erneut ein) noch das
 *     Log-Ende (ueberspringt womoeglich Echtes) waere zu verantworten.
 */
export function resolveCursorStart(
  db: SqlDb,
  fingerprint: string,
  changes: PulledChange[],
  serverMaxId: number,
  now: string,
): CursorStart {
  const known = readCursor(db, fingerprint);
  if (known !== null) return { kind: 'known', cursor: known };

  if (!(serverMaxId > 0)) {
    const cursor = writeCursor(db, fingerprint, 0, now);
    return { kind: 'fresh', cursor };
  }

  const prefix = provenOwnPrefix(changes, ownPushedCounts(db));
  if (prefix.count > 0) {
    const cursor = writeCursor(db, fingerprint, prefix.lastId, now);
    return { kind: 'reconstructed', cursor, ownPrefix: prefix.count };
  }

  return { kind: 'recovery-required' };
}

// SYNC-SAFETY-A1 — Transfernummern aus dem durablen Zaehler, nicht aus dem Bestand.
//
// Die Nummer eines Agenten-Transfers kam bisher aus `getNextNumber('agent_transfers', …)`, und
// das rechnet `MAX(vorhandene Zeilen) + 1`. Wird der zuletzt angelegte Transfer geloescht, ist
// seine Nummer wieder frei — der naechste bekommt DIESELBE. Solange alles lokal bleibt, faellt
// das nicht auf. Im Aenderungslog steht dann aber zweimal dieselbe Nummer unter zwei Kennungen,
// und wer diesen Log spaeter erneut einspielt, laeuft in den eindeutigen Index
// `(branch_id, transfer_number)` — der Pull bleibt stehen. Genau so ist es passiert.
//
// Das Haus hat den richtigen Mechanismus laengst: `document_sequences` gibt eine Nummer aus und
// zaehlt hoch; weil der Zaehler NICHT in `agent_transfers` steht, kann kein Loeschen ihn senken.
// Die Zeile `TRF` ist dort sogar schon angelegt — sie wurde nur nie benutzt.
//
// Diese Datei macht die Umstellung sicher: bevor der Zaehler das erste Mal ausgibt, wird er auf
// die hoechste Nummer gehoben, die nachweislich JE vergeben wurde — und zwar nicht nur nach den
// heutigen Zeilen, sondern auch nach dem, was der Aenderungslog ueber inzwischen geloeschte
// Transfers weiss. Sonst wuerde die Umstellung selbst eine schon vergebene Nummer neu ausgeben.

import type { SqlDb } from '../sync/apply-change';

export const TRANSFER_DOC_TYPE = 'TRF';
/** Das bestehende Format ist fuenfstellig: `TRF-2026-00020`. Es bleibt, wie es ist. */
export const TRANSFER_PADDING = 5;

/** Die laufende Nummer aus `PREFIX-JAHR-NNNNN` — der letzte Abschnitt, sonst nichts. */
export function transferSeqOf(numberText: unknown): number {
  if (typeof numberText !== 'string') return 0;
  const parts = numberText.trim().split('-');
  if (parts.length < 3) return 0;
  const n = parseInt(parts[parts.length - 1], 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Die hoechste Transfernummer, die diese Installation nachweislich vergeben hat.
 *
 * Zwei Quellen, beide lokal und beide massgeblich:
 *
 *  • die heutigen Zeilen in `agent_transfers` — was noch da ist;
 *  • die Nutzlasten im eigenen Aenderungslog — was einmal da WAR. Ein geloeschter Transfer
 *    hinterlaesst dort seine Nummer, und genau diese Nummern sind die gefaehrlichen: sie sind
 *    vergeben worden, stehen aber in keiner Zeile mehr.
 *
 * Was in beiden Quellen fehlt, kann auch niemanden mehr stoeren: ist ein Log-Eintrag fort, gibt
 * es nichts, was ihn wieder einspielen koennte.
 */
export function highestIssuedTransferSeq(db: SqlDb): number {
  let max = 0;
  const bump = (v: unknown): void => { const n = transferSeqOf(v); if (n > max) max = n; };

  try {
    const rows = db.exec('SELECT transfer_number FROM agent_transfers');
    if (rows.length > 0) for (const r of rows[0].values) bump(r[0]);
  } catch { /* Tabelle fehlt (frische DB) — dann gibt es auch keine Nummer */ }

  try {
    const rows = db.exec("SELECT data FROM sync_changelog WHERE table_name = 'agent_transfers'");
    if (rows.length > 0) {
      for (const r of rows[0].values) {
        try {
          const d = JSON.parse(String(r[0] ?? '{}')) as { transfer_number?: unknown };
          bump(d.transfer_number);
        } catch { /* eine unlesbare Nutzlast sagt nichts ueber Nummern aus */ }
      }
    }
  } catch { /* kein Log (frische DB) */ }

  return max;
}

/**
 * Den Zaehler fuer Transfernummern einmalig auf den bewiesenen Stand heben — und danach in Ruhe
 * lassen.
 *
 * Idempotent und nur aufwaerts: `next_number` wird nie gesenkt. Ein zweiter Aufruf, ein Neustart
 * oder ein spaeteres Update aendern nichts mehr, sobald der Zaehler vorne liegt. Gibt die Nummer
 * zurueck, die als naechste ausgegeben wird.
 */
export function ensureTransferSequence(db: SqlDb, now: string): number {
  db.run(
    `INSERT OR IGNORE INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at)
     VALUES (?, ?, 1, 1, ?, ?)`,
    [TRANSFER_DOC_TYPE, TRANSFER_DOC_TYPE, TRANSFER_PADDING, now]
  );
  // Das Format ist Teil des Vertrags: fuenfstellig, mit Jahr. Die Seed-Zeile des Hauses steht auf
  // sechs — ohne diese Zeile wuerde die Umstellung sichtbar `TRF-2026-000021` erzeugen.
  db.run(
    `UPDATE document_sequences SET padding = ?, include_year = 1, updated_at = ?
      WHERE doc_type = ? AND (padding <> ? OR include_year <> 1)`,
    [TRANSFER_PADDING, now, TRANSFER_DOC_TYPE, TRANSFER_PADDING]
  );

  const needed = highestIssuedTransferSeq(db) + 1;
  db.run(
    `UPDATE document_sequences SET next_number = ?, updated_at = ?
      WHERE doc_type = ? AND next_number < ?`,
    [needed, now, TRANSFER_DOC_TYPE, needed]
  );

  const r = db.exec('SELECT next_number FROM document_sequences WHERE doc_type = ?', [TRANSFER_DOC_TYPE]);
  return r.length > 0 && r[0].values.length > 0 ? Number(r[0].values[0][0]) : needed;
}

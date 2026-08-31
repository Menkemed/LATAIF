// SYNC-SAFETY-A1 — Transfernummern aus dem durablen Zaehler, nicht aus dem Bestand.
//
// Die Nummer eines Agenten-Transfers kam bisher aus `getNextNumber('agent_transfers', …)`, und
// das rechnet `MAX(vorhandene Zeilen des laufenden Jahres) + 1`. Wird der zuletzt angelegte
// Transfer geloescht, ist seine Nummer wieder frei — der naechste bekommt DIESELBE. Solange alles
// lokal bleibt, faellt das nicht auf. Im Aenderungslog steht dann aber zweimal dieselbe Nummer
// unter zwei Kennungen, und wer diesen Log spaeter erneut einspielt, laeuft in den eindeutigen
// Index `(branch_id, transfer_number)` — der Pull bleibt stehen. Genau so ist es passiert.
//
// Das Haus hat den richtigen Mechanismus laengst: `document_sequences` gibt eine Nummer aus und
// zaehlt hoch; weil der Zaehler NICHT in `agent_transfers` steht, kann kein Loeschen ihn senken.
//
// ## Der Jahresvertrag bleibt
//
// Der alte Weg zaehlte PRO JAHR: sein `LIKE 'TRF-<Jahr>-%'` sah nur die Nummern des laufenden
// Jahres, also begann jedes Jahr wieder bei 1. Das ist die bestehende Semantik, und sie bleibt —
// eine Umstellung auf eine ewig weiterlaufende Nummer waere eine neue Nummernbedeutung aus rein
// technischer Bequemlichkeit. Der Zaehler traegt deshalb das Jahr, zu dem er gehoert: im selben
// Jahr geht er nur aufwaerts, mit einem neuen Jahr beginnt er neu bei dessen hoechster Nummer + 1
// (und das ist im leeren Jahr die 1). Kollidieren kann dabei nichts, weil das Jahr Teil der
// Nummer ist: `TRF-2027-00001` ist nie `TRF-2026-00030`.

import type { SqlDb } from '../sync/apply-change';

export const TRANSFER_DOC_TYPE = 'TRF';
/** Das bestehende Format ist fuenfstellig: `TRF-2026-00020`. Es bleibt, wie es ist. */
export const TRANSFER_PADDING = 5;

/** Jahr und laufende Nummer aus `PREFIX-JAHR-NNNNN`. */
export function parseTransferNumber(numberText: unknown): { year: number; seq: number } | null {
  if (typeof numberText !== 'string') return null;
  const parts = numberText.trim().split('-');
  if (parts.length < 3) return null;
  const year = parseInt(parts[parts.length - 2], 10);
  const seq = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(year) || !Number.isFinite(seq) || seq <= 0) return null;
  return { year, seq };
}

/**
 * Die hoechste Transfernummer, die diese Installation in DIESEM Jahr nachweislich vergeben hat.
 *
 * Zwei Quellen, beide lokal und beide massgeblich:
 *
 *  • die heutigen Zeilen in `agent_transfers` — was noch da ist;
 *  • die Nutzlasten im eigenen Aenderungslog — was einmal da WAR. Ein geloeschter Transfer
 *    hinterlaesst dort seine Nummer, und genau diese Nummern sind die gefaehrlichen: sie sind
 *    vergeben worden, stehen aber in keiner Zeile mehr.
 *
 * Was in beiden Quellen fehlt, kann auch niemanden mehr stoeren: ist ein Log-Eintrag fort, gibt
 * es nichts, was ihn wieder einspielen koennte. Und ein Restore bringt beide Quellen gemeinsam
 * zurueck — sie stehen in derselben Datenbank.
 */
export function highestIssuedTransferSeq(db: SqlDb, year: number): number {
  let max = 0;
  const bump = (v: unknown): void => {
    const p = parseTransferNumber(v);
    if (p && p.year === year && p.seq > max) max = p.seq;
  };

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
 * Den Zaehler fuer Transfernummern auf den bewiesenen Stand des laufenden Jahres bringen — und
 * danach in Ruhe lassen.
 *
 * Idempotent. Innerhalb eines Jahres nur aufwaerts: ein bereits hoeherer Zaehler wird NIE gesenkt,
 * auch nicht durch diese Funktion selbst. Wechselt das Jahr, beginnt die Zaehlung neu, wie es der
 * bisherige Vertrag vorsieht. Gibt die Nummer zurueck, die als naechste ausgegeben wird.
 */
export function ensureTransferSequence(db: SqlDb, now: string, year: number): number {
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

  const needed = highestIssuedTransferSeq(db, year) + 1;
  const stored = db.exec(
    'SELECT next_number, seq_year FROM document_sequences WHERE doc_type = ?', [TRANSFER_DOC_TYPE]
  );
  const storedNumber = stored.length > 0 && stored[0].values.length > 0 ? Number(stored[0].values[0][0]) : 1;
  const storedYear = stored.length > 0 && stored[0].values.length > 0 ? Number(stored[0].values[0][1]) : NaN;

  // Im selben Jahr gewinnt der hoehere Wert — der Zaehler darf nie zurueckfallen. In einem neuen
  // Jahr gilt die Historie dieses Jahres, und die faengt bei 1 an.
  const next = storedYear === year ? Math.max(storedNumber, needed) : needed;
  db.run(
    `UPDATE document_sequences SET next_number = ?, seq_year = ?, updated_at = ? WHERE doc_type = ?`,
    [next, year, now, TRANSFER_DOC_TYPE]
  );
  return next;
}

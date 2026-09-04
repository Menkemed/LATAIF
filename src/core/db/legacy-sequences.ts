// CENTRAL-C3A — die vier letzten Nummernkreise, die noch aus dem Bestand gerechnet haben.
//
// `getNextNumber(tabelle, …)` bildet `MAX(Nummern des laufenden Jahres) + 1` über die LEBENDEN
// Zeilen. Wird der zuletzt angelegte Datensatz gelöscht, ist seine Nummer wieder frei, und der
// nächste bekommt dieselbe. Genau daran ist der Pull des Kollegen hängengeblieben: dieselbe
// Transfernummer stand zweimal im Änderungslog, das Wiedereinspielen lief in den eindeutigen Index,
// der Batch fiel zurück, und ab da starb jeder Pull an derselben Stelle. Für Transfers ist das
// behoben; hier sind die vier, die noch offen waren:
//
//   CON — Kommissionen · OFF — Angebote · ORD — Aufträge · REP — Reparaturen
//
// Mit zwei Rechnern wird aus dem seltenen Fall der Regelfall: zwei Clients speichern gleichzeitig,
// beide fragen den Bestand, beide bekommen dieselbe Zahl. Deshalb müssen diese vier auf den
// durablen Zähler, BEVOR ein Fernschreibzugriff überhaupt möglich wird.
//
// ## Was dabei gleich bleibt
//
// Das Format: `PREFIX-JAHR-NNNNN`, fünfstellig, mit Jahr — die Hausvorgabe für neue Zähler ist
// sechsstellig, das würde aus `CON-2026-00021` ein `CON-2026-000021` machen. Der Präfix kommt
// weiterhin aus den Einstellungen. Und der Jahresvertrag bleibt: innerhalb eines Jahres nur
// aufwärts, ein neues Jahr beginnt wieder bei 1.
//
// Historische Dokumente werden nicht angefasst. Der Zähler wird lediglich auf den bewiesenen Stand
// gehoben — und „bewiesen" heißt: die lebenden Zeilen UND die Nutzlasten im eigenen Änderungslog.
// Was einmal vergeben war, bleibt vergeben, auch wenn die Zeile gelöscht wurde.

import type { SqlDb } from '../sync/apply-change';

/** Das bestehende Format dieser vier Kreise: fuenfstellig, mit Jahr. */
export const LEGACY_PADDING = 5;

export interface LegacySequenceSpec {
  /** Der Typ im durablen Zaehler. */
  readonly docType: string;
  /** Die Tabelle, in der die bisherigen Nummern stehen. */
  readonly table: string;
  /** Die Spalte mit der Nummer. */
  readonly column: string;
  /** Der Einstellungsschluessel, aus dem der Praefix kommt. */
  readonly settingsKey: string;
  /** Der Praefix, wenn nichts eingestellt ist. */
  readonly defaultPrefix: string;
}

/** Die vier Kreise, die C3A umstellt. Transfers (TRF) sind bereits umgestellt und stehen hier NICHT. */
export const LEGACY_SEQUENCES: readonly LegacySequenceSpec[] = [
  { docType: 'CON', table: 'consignments', column: 'consignment_number', settingsKey: 'consignment.number_prefix', defaultPrefix: 'CON' },
  { docType: 'OFF', table: 'offers', column: 'offer_number', settingsKey: 'offer.number_prefix', defaultPrefix: 'OFF' },
  { docType: 'ORD', table: 'orders', column: 'order_number', settingsKey: 'order.number_prefix', defaultPrefix: 'ORD' },
  { docType: 'REP', table: 'repairs', column: 'repair_number', settingsKey: 'repair.number_prefix', defaultPrefix: 'REP' },
];

/** Jahr und laufende Nummer aus `PREFIX-JAHR-NNNNN`. Derselbe Vertrag wie bei den Transfers. */
export function parseLegacyNumber(numberText: unknown): { year: number; seq: number } | null {
  if (typeof numberText !== 'string') return null;
  const parts = numberText.trim().split('-');
  if (parts.length < 3) return null;
  const year = parseInt(parts[parts.length - 2], 10);
  const seq = parseInt(parts[parts.length - 1], 10);
  if (!Number.isFinite(year) || !Number.isFinite(seq) || seq <= 0) return null;
  return { year, seq };
}

/**
 * Die höchste Nummer, die diese Installation für einen Kreis in DIESEM Jahr nachweislich vergeben
 * hat — aus beiden Quellen: was noch da ist, und was einmal da war.
 *
 * Die zweite Quelle ist die wichtige. Eine gelöschte Zeile hinterlässt ihre Nummer im
 * Änderungslog, und genau solche Nummern sind gefährlich: vergeben, aber in keiner Zeile mehr.
 */
export function highestIssuedSeq(db: SqlDb, spec: LegacySequenceSpec, year: number): number {
  let max = 0;
  const bump = (v: unknown): void => {
    const p = parseLegacyNumber(v);
    if (p && p.year === year && p.seq > max) max = p.seq;
  };

  try {
    const rows = db.exec(`SELECT ${spec.column} FROM ${spec.table}`);
    if (rows.length > 0) for (const r of rows[0].values) bump(r[0]);
  } catch { /* Tabelle fehlt (frische DB) — dann gibt es auch keine Nummer */ }

  try {
    const rows = db.exec('SELECT data FROM sync_changelog WHERE table_name = ?', [spec.table]);
    if (rows.length > 0) {
      for (const r of rows[0].values) {
        try {
          const d = JSON.parse(String(r[0] ?? '{}')) as Record<string, unknown>;
          bump(d[spec.column]);
        } catch { /* eine unlesbare Nutzlast sagt nichts ueber Nummern aus */ }
      }
    }
  } catch { /* kein Log (frische DB) */ }

  return max;
}

/** Der eingestellte Praefix, oder der Standard. Ein leerer Wert ist kein Praefix. */
export function prefixFor(db: SqlDb, spec: LegacySequenceSpec): string {
  try {
    const r = db.exec('SELECT value FROM settings WHERE key = ?', [spec.settingsKey]);
    if (r.length > 0 && r[0].values.length > 0) {
      const v = String(r[0].values[0][0] ?? '').trim();
      if (v) return v;
    }
  } catch { /* keine Einstellungen (frische DB) */ }
  return spec.defaultPrefix;
}

/**
 * Bringt EINEN Zähler auf den bewiesenen Stand des laufenden Jahres — und lässt ihn danach in Ruhe.
 *
 * Idempotent. Innerhalb eines Jahres nur aufwärts: ein bereits höherer Zähler wird NIE gesenkt.
 * Gibt die Nummer zurück, die als nächste ausgegeben wird.
 */
export function ensureLegacySequence(db: SqlDb, spec: LegacySequenceSpec, now: string, year: number): number {
  const prefix = prefixFor(db, spec);

  db.run(
    `INSERT OR IGNORE INTO document_sequences (doc_type, prefix, next_number, include_year, padding, updated_at)
     VALUES (?, ?, 1, 1, ?, ?)`,
    [spec.docType, prefix, LEGACY_PADDING, now]
  );
  // Format und Praefix sind Teil des Vertrags. Die Seed-Zeile des Hauses steht auf sechs Stellen;
  // ohne diese Zeile wuerde die Umstellung sichtbar `CON-2026-000021` erzeugen.
  db.run(
    `UPDATE document_sequences SET prefix = ?, padding = ?, include_year = 1, updated_at = ?
      WHERE doc_type = ? AND (prefix <> ? OR padding <> ? OR include_year <> 1)`,
    [prefix, LEGACY_PADDING, now, spec.docType, prefix, LEGACY_PADDING]
  );

  const needed = highestIssuedSeq(db, spec, year) + 1;
  const stored = db.exec(
    'SELECT next_number, seq_year FROM document_sequences WHERE doc_type = ?', [spec.docType]
  );
  const storedNumber = stored.length > 0 && stored[0].values.length > 0 ? Number(stored[0].values[0][0]) : 1;
  const storedYear = stored.length > 0 && stored[0].values.length > 0 ? Number(stored[0].values[0][1]) : NaN;

  // Im selben Jahr gewinnt der hoehere Wert. In einem neuen Jahr gilt die Historie dieses Jahres,
  // und die faengt bei 1 an — das Jahr ist Teil der Nummer, kollidieren kann dabei nichts.
  const next = storedYear === year ? Math.max(storedNumber, needed) : needed;
  db.run(
    `UPDATE document_sequences SET next_number = ?, seq_year = ?, updated_at = ? WHERE doc_type = ?`,
    [next, year, now, spec.docType]
  );
  return next;
}

/** Alle vier auf einmal — der Aufruf, den die Nummernvergabe vor dem Zug macht. */
export function ensureAllLegacySequences(db: SqlDb, now: string, year: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of LEGACY_SEQUENCES) out[spec.docType] = ensureLegacySequence(db, spec, now, year);
  return out;
}

/** Den Spezifikationseintrag zu einem Typ finden. */
export function legacySpec(docType: string): LegacySequenceSpec {
  const s = LEGACY_SEQUENCES.find((x) => x.docType === docType);
  if (!s) throw new Error(`[sequences] unknown legacy doc type: ${docType}`);
  return s;
}

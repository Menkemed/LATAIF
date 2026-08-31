// SYNC-SAFETY-A1 — was eine BESTEHENDE Datenbank braucht, damit A1 auf ihr laeuft.
//
// Zwei Strukturen kommen neu dazu: die Tabelle mit dem Pull-Wasserstand und die Jahresangabe am
// Dokumentzaehler. Auf einer frischen Datenbank entstehen beide ohnehin mit dem Schema; auf einer
// bestehenden aus v0.8.51 muessen sie nachgezogen werden.
//
// Sie stehen hier und nicht als zwei lose Zeilen mitten in `database.ts`, damit dieselben
// Anweisungen, die die Anwendung ausfuehrt, auch ein Test gegen eine echte Alt-Datenbank
// ausfuehren kann — `database.ts` selbst laesst sich ausserhalb des Browsers nicht laden.
//
// Der Mechanismus bleibt der des Hauses: eine Liste idempotenter Anweisungen, die bei JEDEM Start
// laeuft. `IF NOT EXISTS` traegt die Tabelle, und das doppelte Anlegen der Spalte quittiert SQLite
// mit "duplicate column", was die Migrationsschleife schon immer verschluckt. Deshalb gibt es hier
// auch keine Versionsnummer: die Business-Datenbank fuehrt keine (ihr `user_version` ist 0), ihr
// Schema ist die Liste selbst.

import { CURSOR_DDL } from '../sync/cursor-store';

/** Die Spalte, die den Dokumentzaehler an sein Jahr bindet. */
export const SEQ_YEAR_COLUMN_SQL = 'ALTER TABLE document_sequences ADD COLUMN seq_year INTEGER';

/**
 * Alles, was A1 auf einer bestehenden Datenbank braucht — in der Reihenfolge, in der es laufen
 * muss, und ohne eine einzige Anweisung, die Daten anfasst. Keine Zeile wird geschrieben, kein
 * Zaehler bewegt: die Werte, die schon dastehen, bleiben unberuehrt (die neue Spalte ist bei
 * ihnen schlicht leer, bis der Transfer-Zaehler sie das erste Mal setzt).
 */
export const A1_UPGRADE_SQL: string[] = [
  CURSOR_DDL,
  SEQ_YEAR_COLUMN_SQL,
];

/** Was ein Aufrufer braucht, um die Liste auszufuehren — dieselbe Form wie die Migrationsschleife. */
export interface UpgradeRunner {
  run(sql: string): unknown;
}

/**
 * Die Liste anwenden, mit derselben Nachsicht wie die Migrationsschleife: eine bereits vorhandene
 * Spalte ist kein Fehler, sondern der Normalfall beim zweiten Start. Alles andere fliegt weiter.
 */
export function applyA1Upgrade(db: UpgradeRunner): void {
  for (const sql of A1_UPGRADE_SQL) {
    try { db.run(sql); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) throw err;
    }
  }
}

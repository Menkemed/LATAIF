// CENTRAL-C3A — die eine Bremse, die jeden Geschäftsschreibvorgang erreicht.
//
// Die Speicherschuld (durability-state) war zuerst nur an drei Stellen abgefragt: der Fernauftrag,
// die Warteschlange `runExclusive` und das Fernlesen. Das deckte den Produktweg und die
// Fernaufträge ab — aber nicht Rechnung, Einkauf, Auftragszeile, Reparatur oder den täglichen
// Automatiklauf. Die schreiben synchron über `getDatabase().run(...)`, ohne Warteschlange. Genau
// die teuersten Vorgänge liefen also weiter in einen Speicher, der nicht mehr auf die Platte kam.
//
// 28 Stores einzeln zu verriegeln wäre die falsche Antwort gewesen: 607 Schreibstellen, und die
// nächste neue Datei hätte die Sperre wieder nicht. Stattdessen sitzt die Bremse dort, wo die
// Datenbank ausgehändigt wird — `getDatabase()`. Wer sie holt, um zu schreiben, kommt hier vorbei.
//
// Was gebremst wird, ist bewusst eng gefasst:
//
//   • NUR Datenänderungen (INSERT/UPDATE/DELETE/REPLACE). Ein `SELECT` liest, ein `BEGIN`/`COMMIT`/
//     `ROLLBACK` muss eine bereits laufende Transaktion sauber beenden dürfen, und `PRAGMA` ist
//     Verwaltung. Würde man sie mitbremsen, käme eine offene Transaktion nicht mehr zurück.
//   • NICHT das Schema (CREATE/ALTER/DROP). Migrationen sind keine Geschäftsmutation, und ein
//     Neustart, der sein Schema nicht herstellen kann, wäre schlechter dran als vorher.
//   • NICHT das Speichern selbst: das geht über `export()`, nicht über `run()` — die Bremse kann
//     sich also nicht selbst aussperren.
//
// Die Prüfung ist ein Zeichenkettentest vor dem eigentlichen Aufruf. Sie ist eine Bremse gegen
// unbemerkten Verlust, keine Sicherheitsgrenze gegen absichtlich getarntes SQL.

import { assertDurable } from '@/core/bridge/durability-state';
import { assertTransactionHealthy } from './transaction-health';

/**
 * Die beiden Gründe, aus denen dieser Prozess gerade nichts mehr ändern darf — in der Reihenfolge
 * ihrer Endgültigkeit. Ein verlorener Transaktionszustand lässt sich nicht nachholen, eine
 * Speicherschuld schon; deshalb wird zuerst auf ihn geprüft (und dann gar kein Speichern mehr
 * angestoßen, das die offene Transaktion still beenden würde).
 */
function assertWritable(): void {
  assertTransactionHealthy();
  assertDurable();
}

/**
 * Eine Anweisung, die Geschäftsdaten verändert. Geprüft wird an jeder Anweisungsgrenze, weil
 * `run()` mehrere Anweisungen auf einmal annimmt — sonst käme ein `BEGIN; INSERT …` durch.
 */
const DATA_MUTATION = /(?:^|;)\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

export function isDataMutation(sql: string): boolean {
  return DATA_MUTATION.test(sql);
}

/** Merkmal an der Instanz: zweimal patchen würde die Prüfung verdoppeln. */
const GUARDED = Symbol.for('lataif.write-guard');

interface Runner {
  run(sql: string, params?: unknown[]): unknown;
  [GUARDED]?: boolean;
}

/**
 * Legt die Bremse auf EINE sql.js-Instanz. Gibt dieselbe Instanz zurück (kein Proxy, kein
 * Ersatzobjekt): alles andere — `export()`, `prepare()`, `close()`, die Lebenszyklus-Leases —
 * bleibt bitgleich dasselbe Objekt, und `this` zeigt weiter auf die echte Datenbank.
 *
 * `check` ist standardmäßig Transaktionszustand + Speicherschuld; als Parameter, damit die Prüfung
 * selbst ohne Prozesszustand testbar bleibt.
 */
export function installWriteGuard<T extends Runner>(db: T, check: () => void = assertWritable): T {
  if (db[GUARDED]) return db;
  const raw = db.run.bind(db);
  db.run = (sql: string, params?: unknown[]): unknown => {
    if (isDataMutation(sql)) check();
    return raw(sql, params);
  };
  db[GUARDED] = true;
  return db;
}

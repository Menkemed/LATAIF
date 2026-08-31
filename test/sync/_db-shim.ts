// Nur fuer Tests: die eine Funktion, die `core/db/helpers.ts` aus `core/db/database.ts` braucht.
//
// `database.ts` laesst sich ausserhalb des Browsers nicht laden (es zieht `?raw`/`?url`-Importe von
// Vite). Der Aufloeser des Tests legt dieses Modul an dessen Stelle, damit der ECHTE Allocator
// `getNextDocumentNumber` gegen eine echte sql.js-Datenbank laufen kann — getestet wird der
// Produktivcode, nur seine Datenbankquelle wird gestellt.

interface Db { run(sql: string, p?: unknown[]): unknown; exec(sql: string, p?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>; }

let current: Db | null = null;

export function setTestDatabase(db: Db): void { current = db; }

export function getDatabase(): Db {
  if (!current) throw new Error('[test] no database set');
  return current;
}

export function saveDatabase(): void { /* im Test nicht noetig */ }
export function saveDatabaseDurably(): Promise<void> { return Promise.resolve(); }

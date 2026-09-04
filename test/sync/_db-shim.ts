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

// Wie in der Produktion ein Promise (dort feuert-und-vergisst; `posting.ts` haengt ein `.catch`
// daran). Ein `void` hier liesse den echten Buchungsweg im Test an einer Stelle scheitern, die in
// der Produktion in Ordnung ist.
export function saveDatabase(): Promise<void> { return Promise.resolve(); }
export function saveDatabaseDurably(): Promise<void> { return Promise.resolve(); }

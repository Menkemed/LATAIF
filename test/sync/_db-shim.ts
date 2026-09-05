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

// CENTRAL-C3C — derselbe Name wie in der Produktion, damit der Produktweg unter dem Test laedt.
// Die ECHTE Regel („bei aktiver Klammer nicht speichern") wird dort geprueft, wo sie wirkt:
// in `product-durability-ownership.test.ts` an der injizierten `saveDurably`.
export function durableCheckpoint(): Promise<void> { return Promise.resolve(); }

// CENTRAL-C3C — der Medien-Orchestrator nimmt pro Vorgang eine Leihe auf die aktuelle
// Datenbankinstanz. In der Produktion wartet sie einen laufenden Reload ab; hier gibt es keinen,
// also ist sie genau das, was sie im Vertrag ist: dieselbe Instanz, ein durabler Speicherpunkt,
// und ein Freigeben. Der ECHTE Orchestrator laeuft darauf.
export function acquireDbLease(): Promise<{
  db: Db; epoch: number; saveDurably(): Promise<void>; release(): void;
}> {
  const leased = getDatabase();
  return Promise.resolve({
    db: leased,
    epoch: 0,
    saveDurably: () => durableCheckpoint(),
    release: () => {},
  });
}

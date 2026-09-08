// CENTRAL-UI-PARITY — dieselbe Oberflaeche auf beiden Rechnern, und woher sie ihre Daten bekommt.
//
// C2 hatte eine SCHLANKE Client-Oberflaeche, und dazu passte der Grundsatz von `read-commands.ts`:
// die Antwort ist eine Form, keine Tabelle — benannte Felder statt `SELECT *`, damit nichts
// Internes versehentlich mitreist. Mit der neuen Anforderung traegt dieser Grundsatz nicht mehr:
// wenn auf PC2 DIESELBE Seite laufen soll, zeigt sie dieselben Felder, sonst ist es nicht dieselbe
// Seite. Diese Datei ist deshalb ein ausdruecklich ANDERER Weg als die 18 Auskuenfte aus C2 — und
// die Grenze, die dabei bleibt, ist eine andere, aber keine schwaechere:
//
//   1. **Der Client nennt einen STORE, keine Abfrage.** Kein SQL, kein Tabellenname, kein
//      Sortierausdruck reist ueber das Netz. Was gelesen werden darf, steht in `STORE_SOURCES`;
//      alles andere gibt es nicht — Rust weist es schon vor dem Renderer ab.
//   2. **Gelesen wird, indem der Primary seine EIGENE Ladefunktion ausfuehrt.** Nicht eine
//      nachgebaute Abfrage, die morgen auseinanderlaeuft — dieselbe Funktion, die der Primary fuer
//      seine eigene Anzeige benutzt. Damit ist Gleichstand keine Absicht, sondern Bauart.
//   3. **Zurueck kommen nur DATEN.** Aus dem Zustand des Stores werden die Funktionen entfernt;
//      was bleibt, ist genau das, was die Oberflaeche am Primary ohnehin anzeigt.
//   4. **Die Rechte gelten unveraendert.** Der Weg laeuft durch `executeCommand`, also durch
//      dieselbe Pruefung wie jede andere Operation.
//
// Was dieser Weg NICHT ist: kein generischer SQL-Ausfuehrer, kein Spiegel der Datenbank, keine
// zweite Wahrheit. Der Client haelt das Ergebnis im Anzeige-Zustand — geschrieben wird
// ausschliesslich ueber die geprueften Fernbefehle, und der naechste Ladevorgang holt den Stand
// wieder vom Primary.

import { registerCommand, type CommandResult } from './command-registry';
import { STORE_SOURCES, STORE_READ_OPS } from './store-read-ops';

/** Nur Daten: Funktionen gehoeren zum Store, nicht zur Antwort. */
function dataOf(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (typeof v === 'function') continue;
    out[k] = v;
  }
  return out;
}

interface ZustandLike {
  getState(): Record<string, unknown>;
}

/**
 * Einen Store am Primary fuellen und seinen Datenstand zurueckgeben.
 *
 * Die Ladefunktionen werden GERUFEN, nicht nachgebaut — und falls eine von ihnen ein Versprechen
 * liefert, wird darauf gewartet, sonst reiste ein halb gefuellter Stand zurueck.
 */
async function readStore(key: string): Promise<CommandResult> {
  const src = STORE_SOURCES[key];
  if (!src) return { data: {} }; // unerreichbar: registriert werden nur diese Schluessel
  const mod = await src.load();
  const store = mod[src.hook] as ZustandLike | undefined;
  if (!store) throw new Error(`[bridge] store hook missing: ${src.hook}`);
  for (const name of src.loaders) {
    const fn = store.getState()[name];
    if (typeof fn !== 'function') throw new Error(`[bridge] loader missing: ${key}.${name}`);
    await (fn as () => unknown | Promise<unknown>)();
  }
  return { data: dataOf(store.getState()) };
}

for (const key of STORE_READ_OPS) {
  registerCommand(key, { kind: 'read', handler: () => readStore(key) });
}

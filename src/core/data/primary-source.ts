// CENTRAL-UI-PARITY — woher ein Store seine Daten nimmt, ohne dass die Oberflaeche es merkt.
//
// Die Oberflaeche soll auf beiden Rechnern dieselbe sein. Also darf sie NICHT an fuenfzig Stellen
// `if (clientMode)` bekommen — die Weiche gehoert unter die Stores, nicht in die Seiten:
//
//     Seite  →  bestehender Store-Vertrag  →  lokal (Primary)  |  fern (Client)
//
// Am Primary bleibt alles, wie es war: die Ladefunktion liest aus der eigenen Datenbank. Auf PC2
// gibt es keine Datenbank; dort holt derselbe Aufruf den Datenstand ueber eine benannte
// Store-Auskunft vom Primary — und der fuellt sie, indem er SEINE Ladefunktion ausfuehrt.
//
// Drei Dinge, die dieser Weg ausdruecklich nicht tut: er schickt kein SQL, er legt keine
// Datenbank an, und er macht das Ergebnis nicht zur Wahrheit. Was hier ankommt, ist Anzeige.
// Geschrieben wird ausschliesslich ueber die geprueften Fernbefehle, und der naechste Ladevorgang
// holt den Stand wieder dort ab, wo er entsteht.

import { isClientMode } from '@/core/bridge/client-mode';
import { remoteRead, RemoteReadError } from '@/core/bridge/remote-read';

/** Laeuft dieses Fenster als Oberflaeche an einem fremden Primary? */
export function readsFromPrimary(): boolean {
  return isClientMode();
}

/**
 * Mehrere Ladefunktionen desselben Stores (`loadProducts`, `loadCategories`) fuehren auf dieselbe
 * Auskunft. Ohne diese Klammer liefe pro Seitenaufbau je eine Anfrage — mit ihr teilen sie sich
 * eine. Der Eintrag faellt weg, sobald die Antwort da ist; der naechste Aufruf fragt also frisch.
 */
const inFlight = new Map<string, Promise<Record<string, unknown> | null>>();

/** Wer moechte erfahren, dass eine Fernladung schiefging (Anzeige eines Verbindungsfehlers). */
export type LoadFailure = (op: string, error: RemoteReadError) => void;
let onFailure: LoadFailure | null = null;
export function setRemoteLoadFailureHandler(fn: LoadFailure | null): void { onFailure = fn; }

async function fetchStore(op: string): Promise<Record<string, unknown> | null> {
  const running = inFlight.get(op);
  if (running) return running;
  const p = (async () => {
    try {
      const reply = await remoteRead<{ data?: Record<string, unknown> }>(op, {});
      return reply?.data ?? null;
    } catch (e) {
      if (e instanceof RemoteReadError && onFailure) onFailure(op, e);
      else console.warn(`[data] ${op} failed:`, e);
      return null;
    } finally {
      inFlight.delete(op);
    }
  })();
  inFlight.set(op, p);
  return p;
}

/**
 * Die eine Zeile, die in einer Store-Ladefunktion steht.
 *
 * Am Primary liefert sie `false` — die Funktion macht danach genau das, was sie immer tat. Auf PC2
 * liefert sie `true` und holt den Stand im Hintergrund; sobald er da ist, setzt sie ihn in den
 * Store, und die bereits gerenderte Seite zeichnet sich mit echten Daten neu. Genau so verhaelt
 * sich ein Zustandsspeicher auch sonst.
 */
export function hydrateFromPrimary(
  op: string,
  apply: (data: Record<string, unknown>) => void,
): boolean {
  if (!readsFromPrimary()) return false;
  void fetchStore(op).then((data) => { if (data) apply(data); });
  return true;
}


/**
 * Derselbe Gedanke fuer einen EINZELNEN Vorgang: hier gibt es einen Parameter (eine Auftrags-
 * oder Kundenkennung), also auch keine gemeinsame Klammer — jede Kennung fragt fuer sich.
 */
export function hydrateOneFromPrimary(
  op: string,
  params: Record<string, unknown>,
  apply: (data: Record<string, unknown>) => void,
): boolean {
  if (!readsFromPrimary()) return false;
  void (async () => {
    try {
      const reply = await remoteRead<{ data?: Record<string, unknown> }>(op, params);
      if (reply?.data) apply(reply.data);
    } catch (e) {
      if (e instanceof RemoteReadError && onFailure) onFailure(op, e);
      else console.warn(`[data] ${op} failed:`, e);
    }
  })();
  return true;
}


/**
 * CENTRAL-UI-PARITY R1 — der ehrliche Riegel fuer alles, was noch nicht umgestellt ist.
 *
 * Ein Store, dessen Ladefunktion noch den alten Schnitt hat, darf aus der Ferne gar nicht erst
 * geladen werden: er wuerde die Filiale des Primary lesen und dessen Bildschirm anfassen. Also
 * wird auf einem Rechner ohne Datenbank hier abgebrochen — kein Datenbankzugriff, kein toter
 * Netzaufruf, und eine Zeile im Protokoll, damit es sichtbar ist statt still.
 *
 * Seit R2B hat er KEINEN Aufrufer mehr: jede Store-Ladefunktion ist umgestellt. Er bleibt
 * trotzdem stehen, denn er ist der Vertrag fuer den naechsten Store, der dazukommt — solange
 * dessen Ladefunktion nicht denselben Schnitt hat, gehoert hier der Riegel hin und nicht ein
 * „laeuft meistens".
 */
const announced = new Set<string>();
export function remoteReadUnavailable(what: string): boolean {
  if (!readsFromPrimary()) return false;
  if (!announced.has(what)) {
    announced.add(what);
    console.warn(`[data] ${what} is not available on a client yet — no local database, no remote read`);
  }
  return true;
}

/** Nur fuer Tests und den Abmeldeweg: die laufenden Anfragen vergessen. */
export function resetPrimarySource(): void {
  inFlight.clear();
}

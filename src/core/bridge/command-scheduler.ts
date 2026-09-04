// CENTRAL-C1 — die eine Reihenfolge, in der Geschäftsschreibvorgänge auf dem Primary passieren.
//
// Warum das nötig ist, obwohl JavaScript einfädig läuft: einfädig heißt nicht unteilbar. Sobald
// eine Domänenfunktion `await` benutzt, darf eine zweite dazwischen loslaufen. Heute fällt das
// nicht auf, weil es nur einen Auslöser gibt — den Menschen vor dem Fenster. Sobald ein zweiter
// Rechner und der Mobile-Drain Aufträge schicken, treffen zwei Aufträge gleichzeitig ein, und
// „zwischen `BEGIN` und `COMMIT` liegt kein `await`" schützt dann nur noch die einzelne
// Transaktion, nicht die Abfolge davor und danach (Bestandsprüfung, Nummernvergabe, Speichern).
//
// Also: höchstens EIN Geschäftsauftrag ist zu jedem Zeitpunkt aktiv. Kein Mutex in Rust — die
// Datenbank gehört diesem Renderer, und die Reihenfolge gehört dorthin, wo die Datenbank liegt.
//
// Zwei Eigenschaften, die leicht zu übersehen und teuer zu verlieren sind:
//   • Ein gescheiterter Auftrag darf die Kette nicht vergiften. Der Fehler geht an SEINEN Aufrufer,
//     und der nächste läuft danach normal — sonst bringt ein einziger fachlicher Konflikt den
//     ganzen Rechner zum Stehen.
//   • Die Reihenfolge ist die der Annahme (FIFO). Wer zuerst kam, wird zuerst ausgeführt; das
//     entscheidet bei „Menge 1, zwei Verkäufe", wer gewinnt, und macht es nachvollziehbar.

/** Ein Auftrag: irgendetwas, das etwas zurückgibt. Die Warteschlange kennt seinen Inhalt nicht. */
export type Task<T> = () => Promise<T> | T;

export interface SchedulerStats {
  /** Wie viele Aufträge warten oder laufen — 0 heißt: die Kette ist leer. */
  readonly depth: number;
  /** Wie viele insgesamt durchgelaufen sind, erfolgreich oder nicht. */
  readonly completed: number;
  /** Wie viele mit einem Fehler endeten. */
  readonly failed: number;
  /** Läuft gerade einer? Höchstens einer, sonst ist der Vertrag gebrochen. */
  readonly running: boolean;
}

export class CommandScheduler {
  /** Das Ende der Kette. Jeder neue Auftrag hängt sich hier an — daraus entsteht die Reihenfolge. */
  private tail: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private completed = 0;
  private failed = 0;
  private running = false;
  /** Höchstwert von `running` über die Laufzeit — bleibt er 1, war nie mehr als einer aktiv. */
  private peakConcurrent = 0;
  private concurrent = 0;

  /**
   * Führt `task` aus, wenn alle vorher angenommenen Aufträge fertig sind. Das zurückgegebene
   * Versprechen gehört dem Aufrufer: es löst sich mit dem Ergebnis oder scheitert mit dem Fehler
   * des Auftrags — und beides berührt die Kette nicht.
   */
  run<T>(task: Task<T>): Promise<T> {
    this.depth += 1;
    // WICHTIG: die Kette wartet auf das VORHERIGE Ende, und was sie danach weitergibt, ist
    // absichtlich immer erfüllt. Würde der Fehler in der Kette bleiben, wäre jeder folgende
    // Auftrag mit demselben Fehler abgewiesen — die Warteschlange wäre dauerhaft vergiftet.
    const result = this.tail.then(() => this.readersDrained()).then(() => {
      this.running = true;
      this.concurrent += 1;
      if (this.concurrent > this.peakConcurrent) this.peakConcurrent = this.concurrent;
      return task();
    });

    this.tail = result.then(
      () => { this.settle(false); },
      () => { this.settle(true); },
    );

    return result;
  }

  private settle(didFail: boolean): void {
    this.concurrent -= 1;
    this.depth -= 1;
    this.completed += 1;
    if (didFail) this.failed += 1;
    if (this.concurrent === 0) this.running = false;
  }

  // ── Lesen: nebeneinander ja, aber nie mitten in einer Buchung ────────────
  //
  // C1 liess Lesevorgaenge einfach an der Warteschlange vorbei. Das war richtig, solange nur die
  // Probe existierte, und wird falsch, sobald ein zweiter Rechner echte Listen abruft: nicht jede
  // Geschaeftsoperation ist von aussen unteilbar. Rechnungen und Einkaeufe sind es (ihre Stores
  // enthalten KEIN einziges `await`, die Wirkung passiert in einem Zug), aber der Produktweg mit
  // Medien ist es nicht — `createProductWithMedia` und `editProductWithMedia` haben mehrere
  // `await`-Punkte zwischen Vorbereiten und durablem Anwenden. Ein Lesen, das dort hineinfaellt,
  // sieht ein Produkt ohne seine Bilder oder einen Text ohne seine Galerie.
  //
  // Deshalb eine Leser-Schreiber-Ordnung auf DERSELBEN Kette: Leser duerfen sich gegenseitig
  // ueberholen, ein Schreiber wartet auf die laufenden Leser, und ein Leser beginnt nie waehrend
  // eines Schreibers. Kein zweiter Planer, keine Store-Umbauten.
  private readers = 0;
  private readerWaiters: Array<() => void> = [];
  private peakReaders = 0;

  /** Wartet, bis kein Lesevorgang mehr laeuft. */
  private readersDrained(): Promise<void> {
    if (this.readers === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.readerWaiters.push(resolve); });
  }

  private releaseReader(): void {
    this.readers -= 1;
    if (this.readers === 0) {
      const waiting = this.readerWaiters;
      this.readerWaiters = [];
      for (const w of waiting) w();
    }
  }

  /**
   * Fuehrt `task` als LESEVORGANG aus: parallel zu anderen Lesevorgaengen, aber erst wenn die
   * laufende Buchung fertig ist. Das zurueckgegebene Versprechen gehoert dem Aufrufer.
   */
  runShared<T>(task: Task<T>): Promise<T> {
    this.depth += 1;
    // An DERSELBEN Kette anstellen: das Ende der Kette ist das Ende der letzten Buchung.
    const result = this.tail.then(() => {
      this.readers += 1;
      if (this.readers > this.peakReaders) this.peakReaders = this.readers;
      return task();
    });
    // Leser verlaengern die Schreiber-Kette NICHT — sonst waeren sie untereinander seriell.
    result.then(
      () => { this.depth -= 1; this.completed += 1; this.releaseReader(); },
      () => { this.depth -= 1; this.completed += 1; this.failed += 1; this.releaseReader(); },
    );
    return result;
  }

  /** Nur zur Pruefung: liefen je mehrere Lesevorgaenge gleichzeitig? */
  peakConcurrentReaders(): number {
    return this.peakReaders;
  }

  stats(): SchedulerStats {
    return { depth: this.depth, completed: this.completed, failed: this.failed, running: this.running };
  }

  /** Nur zur Prüfung: war je mehr als ein Auftrag gleichzeitig aktiv? */
  peakConcurrency(): number {
    return this.peakConcurrent;
  }

  /** Wartet, bis nichts mehr aussteht. Für einen kontrollierten Abschluss beim Herunterfahren. */
  async drain(): Promise<void> {
    // Mehrfach, weil während des Wartens neue Aufträge angenommen werden können.
    for (let i = 0; i < 100 && this.depth > 0; i++) {
      await this.tail.catch(() => undefined);
    }
  }
}

/**
 * Die EINE Warteschlange dieses Renderers. Jeder autoritative Geschäftsschreibvorgang — lokale
 * Oberfläche, Auftrag vom zweiten Rechner, Mobile-Drain, KI-Bearbeitung, Import, Automatisierung —
 * läuft hierdurch. Ein zweiter Planer wäre eine zweite Reihenfolge und damit keine.
 */
export const businessWriteScheduler = new CommandScheduler();

/** Kurzform für den Regelfall. */
export function runExclusive<T>(task: Task<T>): Promise<T> {
  return businessWriteScheduler.run(task);
}

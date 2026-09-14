// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-4 — der Taktgeber für fällige Daueraufträge am Primary.
//
// Bis hierher entstanden fällige Monate nur beim Primary-Start/Filialwechsel und beim Öffnen der
// Ausgabenliste. Lief der Primary über den Monatswechsel, erschien die Miete erst, wenn jemand die
// Liste öffnete oder neu startete.
//
// Hier ist kein neuer Dienst und keine zweite Regel: der Taktgeber fragt einmal pro Minute nach dem
// ÖRTLICHEN Tag und lässt, sobald ein neuer Tag begonnen hat, den bestehenden Generator laufen —
// `runDueGeneratorOnPrimary`, in der Schreibreihenfolge und danach durabel. Was fällig ist, wie weit
// nachgeholt wird, dass Pausenmonate nicht nachgeholt werden: das entscheidet weiter allein
// `generateDueForTemplate` (Monatszeiger + Monatsprüfung in derselben Klammer wie die Ausgabe).
//
// Genau einmal: ein zweiter Lauf am selben Tag findet nichts (Zeiger), ein Neustart ebenso (der
// Zeiger ist mit der Ausgabe durabel), und zwei Takte überholen sich nicht (einer läuft, der
// andere kehrt um). Ein Lauf, der nicht fertig wurde (fremde Klammer offen, niemand angemeldet,
// eine Vorlage scheiterte), schließt den Tag NICHT — der nächste Takt versucht es wieder.
// ════════════════════════════════════════════════════════════════════════════
import { isClientMode } from '@/core/bridge/client-mode';

export interface DueRun { created: number; skipped: number; errors: string[] }

export interface DueSchedulerDeps {
  /** Die Uhr — dieselbe für den Tageswechsel und für den Generator. */
  now: () => Date;
  /** Der bestehende Generator, mit genau dieser Uhr. */
  run: (nowIso: string) => Promise<DueRun>;
}

/** Der örtliche Kalendertag (`YYYY-MM-DD`) — dieselbe Ortszeit, in der der Generator Monate zählt. */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export type TickOutcome = 'ran' | 'already-done-today' | 'overlap';

export function createDueScheduler(deps: DueSchedulerDeps) {
  let doneDay: string | null = null;
  let running = false;
  async function tick(): Promise<TickOutcome> {
    if (running) return 'overlap';
    const now = deps.now();
    const day = localDayKey(now);
    if (doneDay === day) return 'already-done-today';
    running = true;
    try {
      const r = await deps.run(now.toISOString());
      if (r.errors.length === 0) doneDay = day;
    } catch { /* nicht erledigt — der nächste Takt */ }
    finally { running = false; }
    return 'ran';
  }
  return { tick, doneDay: (): string | null => doneDay };
}

/** Wie oft nach dem Tag gefragt wird. Eine Minute: der Monatswechsel wird binnen einer Minute bemerkt. */
export const DUE_SCHEDULER_INTERVAL_MS = 60_000;

let started = false;

/** Einmal je Fenster, nur am Primary (auf PC2 führt der Primary seine Monate selbst). */
export function startRecurringExpenseScheduler(): void {
  if (started || isClientMode()) return;
  started = true;
  const s = createDueScheduler({
    now: () => new Date(),
    run: async (nowIso) => {
      const { runDueGeneratorOnPrimary } = await import('@/core/payables/payables-save');
      return runDueGeneratorOnPrimary(nowIso);
    },
  });
  void s.tick();
  setInterval(() => { void s.tick(); }, DUE_SCHEDULER_INTERVAL_MS);
}

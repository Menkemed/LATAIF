// CENTRAL-C3H — welchen Schritt eine Reparatur als naechstes gehen darf. EINE Quelle.
//
// Derselbe Grund wie beim Auftrag, nur schaerfer: die Reparatur hatte ZWEI Ableitungen, und sie
// waren nicht gleich. Die Detailseite geht den vollen Weg (`getStatusFlow`), die Liste bot eine
// Abkuerzung an (`NEXT_STATUS`: von `received` direkt auf `in_progress`, ohne Diagnose). Beides
// ist echtes Verhalten des Primary — ein Fernauftrag, der nur eine der beiden kennte, wiese
// einen Klick ab, den der Mensch am anderen Rechner taeglich macht.
//
// Also: beide stehen hier, zusammen, und `allowedRepairStatusTargets` ist ihre Vereinigung. Das
// ist die ehrliche Antwort auf „welchen Uebergang faehrt der Primary wirklich" — und sie ist
// ausdruecklich NICHT „jeden". Ein freies `set_status(any)` uebersprnge Stufen, an denen
// Lieferanten-Verbindlichkeiten und Kapitalisierung haengen.

import type { RepairStatus } from '@/core/models/types';

export type RepairScope = 'CUSTOMER' | 'OWN';

/** OWN-scope endet bei `ready` — kein Abholen, das Stueck bleibt ohnehin im Haus. */
export function repairStatusFlow(repairType?: string, scope?: RepairScope | string): RepairStatus[] {
  const base: RepairStatus[] = ['received', 'diagnosed', 'in_progress'];
  const ext = repairType === 'external' || repairType === 'hybrid';
  if (scope === 'OWN') {
    return ext ? [...base, 'sent_to_workshop', 'ready'] : [...base, 'ready'];
  }
  if (ext) return [...base, 'sent_to_workshop', 'ready', 'picked_up'];
  return [...base, 'ready', 'picked_up'];
}

/** Der naechste Schritt auf dem vollen Weg — was die Detailseite als „Mark as …" anbietet. */
export function nextRepairStatus(
  current: RepairStatus | string, repairType?: string, scope?: RepairScope | string,
): RepairStatus | null {
  const flow = repairStatusFlow(repairType, scope);
  const idx = flow.indexOf(current as RepairStatus);
  if (idx === -1 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}

/** Die Abkuerzungen der Liste: „Start", „Mark Ready", „Picked Up". */
export const REPAIR_QUICK_NEXT: Partial<Record<string, { status: RepairStatus; label: string }>> = {
  received: { status: 'in_progress', label: 'Start' },
  in_progress: { status: 'ready', label: 'Mark Ready' },
  ready: { status: 'picked_up', label: 'Picked Up' },
};

/** Die Abkuerzung, wie die Liste sie zeigt — bei OWN-scope ohne das Abholen. */
export function quickRepairNext(
  current: RepairStatus | string, scope?: RepairScope | string,
): { status: RepairStatus; label: string } | undefined {
  const raw = REPAIR_QUICK_NEXT[String(current)];
  if (!raw) return undefined;
  return scope === 'OWN' && raw.status === 'picked_up' ? undefined : raw;
}

/** Terminal heisst: von hier aus schaltet niemand mehr weiter. */
export const TERMINAL_REPAIR_STATUS: readonly string[] =
  ['picked_up', 'DELIVERED', 'returned', 'cancelled', 'CANCELLED'];

export function isTerminalRepairStatus(s: RepairStatus | string): boolean {
  return TERMINAL_REPAIR_STATUS.includes(String(s));
}

/**
 * JEDER Uebergang, den der Primary an dieser Reparatur wirklich anbietet — und kein weiterer.
 *
 * `returned` ist dabei kein Storno: die Ware geht unrepariert an den Kunden zurueck, das Stueck
 * kommt in den Bestand, es wird nichts rueckabgewickelt. Der Knopf steht an jeder nicht
 * terminalen Kunden-Reparatur. `cancelled` steht NICHT hier — den gibt es am Primary nur ueber
 * das Loeschen, und das ist zerstoerend.
 */
export function allowedRepairStatusTargets(
  current: RepairStatus | string, repairType?: string, scope?: RepairScope | string,
): RepairStatus[] {
  if (isTerminalRepairStatus(current)) return [];
  const out = new Set<RepairStatus>();
  const next = nextRepairStatus(current, repairType, scope);
  if (next) out.add(next);
  const quick = quickRepairNext(current, scope);
  if (quick) out.add(quick.status);
  if (scope !== 'OWN') out.add('returned');
  return [...out];
}

// ── REPAIR-REOPEN — eine versehentlich zurückgegebene Reparatur wieder aufnehmen ─────────────────

/**
 * Was eine Reparatur über sich weiß, um die Schritte von hier zu bestimmen. Alles steht in ihrer Zeile und
 * ihren Kostenzeilen — am Primary, an PC2 (geladen vom Primary) und am Handy (Lesebefehl) dieselben Fakten.
 */
export interface RepairTransitionFacts {
  status: RepairStatus | string;
  repairType?: string | null;
  repairScope?: RepairScope | string | null;
  invoiceId?: string | null;
  /** Die Stufe vor „Returned" — gemerkt seit v0.8.94; bei älteren Rückgaben leer. */
  returnFromStatus?: string | null;
  startedAt?: string | null;
  diagnosedAt?: string | null;
  /** Kostenzeilen, deren Ausgabe schon gebucht ist (das geschieht ab „in Arbeit"). */
  bookedLineCount?: number;
}

/**
 * „Reopen" einer zurückgegebenen Kundenreparatur — auf welche Stufe sie zurück darf:
 *  • gemerkt (Rückgabe ab v0.8.94): genau die Stufe davor — eindeutig, keine Wahl;
 *  • mit Rechnung: nur „ready" (abgerechnet wird erst ab „ready"; die Rechnung bleibt, wie sie ist);
 *  • ältere Rückgabe ohne Merker: die Stufen, die zu ihren Spuren passen — ab „in Arbeit", wenn sie begonnen
 *    wurde oder Zeilen gebucht sind, ab „diagnosed", wenn diagnostiziert, sonst ab „received" — bis „ready".
 * Nie „picked_up" (das ist eine eigene Handlung mit Abholtag) und nie eigene Ware (die wird nicht zurückgegeben).
 */
export function reopenRepairTargets(f: RepairTransitionFacts): RepairStatus[] {
  if (String(f.status) !== 'returned' || f.repairScope === 'OWN') return [];
  const flow: RepairStatus[] = repairStatusFlow(f.repairType ?? undefined, f.repairScope ?? undefined)
    .filter((s) => s !== 'picked_up');
  if (f.invoiceId) return flow.includes('ready') ? ['ready'] : [];
  if (f.returnFromStatus) {
    return flow.includes(f.returnFromStatus as RepairStatus) ? [f.returnFromStatus as RepairStatus] : [];
  }
  const begonnen = !!f.startedAt || (f.bookedLineCount ?? 0) > 0;
  const ab = begonnen ? flow.indexOf('in_progress') : f.diagnosedAt ? flow.indexOf('diagnosed') : 0;
  return flow.slice(Math.max(0, ab));
}

/** JEDER Schritt von hier: vorwärts (`allowedRepairStatusTargets`) oder — von „Returned" — zurück (`reopenRepairTargets`). */
export function repairStatusTargets(f: RepairTransitionFacts): RepairStatus[] {
  return String(f.status) === 'returned'
    ? reopenRepairTargets(f)
    : allowedRepairStatusTargets(f.status, f.repairType ?? undefined, f.repairScope ?? undefined);
}

/** Die Fakten aus einer geladenen Reparatur und ihren Zeilen (Bildschirm am Primary und an PC2, Haus). */
export function repairTransitionFacts(
  r: {
    status: RepairStatus | string; repairType?: string | null; repairScope?: string | null; invoiceId?: string | null;
    returnFromStatus?: string | null; startedAt?: string | null; diagnosedAt?: string | null; id?: string;
  },
  lines: ReadonlyArray<{ repairId?: string; status?: string; expenseId?: string | null }> = [],
): RepairTransitionFacts {
  return {
    status: r.status, repairType: r.repairType, repairScope: r.repairScope, invoiceId: r.invoiceId ?? null,
    returnFromStatus: r.returnFromStatus ?? null, startedAt: r.startedAt ?? null, diagnosedAt: r.diagnosedAt ?? null,
    bookedLineCount: lines.filter((l) => (!r.id || l.repairId === r.id) && l.status === 'OPEN' && !!l.expenseId).length,
  };
}

/** Die Beschriftung eines Schritts — „Reopen as …" von „Returned", sonst „Mark as …". */
export function repairStatusActionLabel(from: RepairStatus | string, to: RepairStatus | string): string {
  const name = String(to).split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return String(from) === 'returned' ? `Reopen as ${name}` : `Mark as ${name}`;
}

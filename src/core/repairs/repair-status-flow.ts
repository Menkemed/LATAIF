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

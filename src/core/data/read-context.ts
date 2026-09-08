// CENTRAL-UI-PARITY R1 — wessen Daten sind das eigentlich?
//
// Eine Ladefunktion braucht genau vier Angaben, um zu wissen, was sie zeigen darf: Mandant,
// Filiale, Benutzer und Rolle. Bisher holte sie sich die Filiale aus `currentBranchId()` — also
// aus der Sitzung des Menschen, der gerade am Primary sitzt. Solange nur er selbst liest, ist das
// richtig. Sobald ein zweiter Rechner fragt, ist es falsch: er bekaeme die Filiale des anderen.
//
// Deshalb reist der Kontext ab jetzt als Parameter mit, und er hat genau zwei Quellen:
//
//   • am Primary  → die lokale, angemeldete Sitzung
//   • aus der Ferne → der bereits GEPRUEFTE und reautorisierte Absender der Anfrage (C4)
//
// Und keine dritte. Insbesondere niemals der Rumpf, den der Client mitschickt: was dort steht, ist
// ein Wunsch, kein Ausweis.

import { authService } from '@/core/auth/auth';

/** Der Ausweis einer Leseanfrage. Reine Daten — kein Zustand, kein Speicher, keine Oberflaeche. */
export interface BusinessReadContext {
  readonly tenantId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly role: string;
}

export class ReadContextMissing extends Error {
  readonly code = 'READ_CONTEXT_MISSING';
  constructor(what: string) { super(`READ_CONTEXT_MISSING: ${what}`); this.name = 'ReadContextMissing'; }
}

/**
 * Der Kontext am Primary: aus der eigenen angemeldeten Sitzung. Das ist derselbe Wert, den die
 * Ladefunktionen vorher direkt gelesen haben — nur steht er jetzt sichtbar im Aufruf.
 */
export function localReadContext(): BusinessReadContext {
  const s = authService.getSession();
  const branchId = s?.branchId ?? authService.getCurrentBranchId();
  if (!branchId) throw new ReadContextMissing('no branch in the local session');
  return {
    tenantId: (s as { tenantId?: string } | null)?.tenantId ?? 'tenant-1',
    branchId,
    userId: s?.userId ?? authService.getCurrentUserId(),
    role: (s as { role?: string } | null)?.role ?? '',
  };
}

/** Was der Absender einer Fernanfrage mitbringt — geprueft, nicht behauptet. */
export interface VerifiedActor {
  readonly tenantId?: string;
  readonly branchId?: string;
  readonly userId?: string;
  readonly role?: string;
}

/**
 * Der Kontext einer Fernanfrage. Er entsteht AUSSCHLIESSLICH aus dem geprueften Absender; fehlt
 * dort die Filiale, wird nicht gelesen. Ein Rumpf wird hier bewusst gar nicht entgegengenommen —
 * so kann kein Aufrufer versehentlich einen Wunsch des Clients zur Autoritaet machen.
 */
export function remoteReadContext(actor: VerifiedActor | undefined): BusinessReadContext {
  const branchId = actor?.branchId;
  if (typeof branchId !== 'string' || branchId.length === 0) {
    throw new ReadContextMissing('no branch in the authenticated request');
  }
  const userId = actor?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new ReadContextMissing('no user in the authenticated request');
  }
  return {
    tenantId: typeof actor?.tenantId === 'string' && actor.tenantId ? actor.tenantId : 'tenant-1',
    branchId,
    userId,
    role: typeof actor?.role === 'string' ? actor.role : '',
  };
}

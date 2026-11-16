// ════════════════════════════════════════════════════════════════════════════
// WARTUNGSMODUS — solange eine Owner-Wartung schreibt (Bildmigration), nimmt der Primary von anderen Rechnern
// und vom Handy KEINE verändernden Aufträge an.
//
// Zwei Riegel, die beide gelten:
//   • Rust (`maintenance.rs`): der Server weist verändernde Fernaufträge, Ablagen und Handy-Uploads mit 503
//     `MAINTENANCE_ACTIVE` ab, bevor irgendetwas den Renderer erreicht. Das Handy behält seinen Upload und
//     versucht es später erneut (503 = vorübergehend).
//   • Renderer (hier): `executeCommand` weist jeden Auftrag der Klasse `mutation` ab, bevor sein Handler läuft —
//     falls ein Auftrag den Server vor dem Umschalten passiert hat. Der Handy-Drain verarbeitet nichts.
// Lesen bleibt erlaubt. Lokale Arbeit am Primary läuft weiter durch die eine Schreib-Warteschlange und kommt
// zwischen zwei Paketen der Wartung dran.
//
// Der Zustand lebt nur im Speicher: ein Neustart (auch nach einem Absturz) beendet den Wartungsmodus.
// ════════════════════════════════════════════════════════════════════════════

export const MAINTENANCE_ACTIVE = 'MAINTENANCE_ACTIVE';

let active: { reason: string; since: string } | null = null;

export function setMaintenanceGate(on: boolean, reason = ''): void {
  active = on ? { reason: reason || 'maintenance', since: new Date().toISOString() } : null;
}

export function maintenanceGateActive(): boolean {
  return active !== null;
}

export function maintenanceGateInfo(): { reason: string; since: string } | null {
  return active ? { ...active } : null;
}

/** Die Antwort an einen abgewiesenen Fernauftrag (gleicher Code wie Rust). */
export function maintenanceRefusal(): { kind: 'business_error'; code: string; message: string } {
  return {
    kind: 'business_error',
    code: MAINTENANCE_ACTIVE,
    message: 'The main computer is running owner maintenance. Nothing was saved — please try again in a few minutes.',
  };
}

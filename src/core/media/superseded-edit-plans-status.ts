// ════════════════════════════════════════════════════════════════════════════
// OWNER-WARTUNG — der Zustand der zwei überholten Galerie-Bearbeitungen für die Karte in Data Repairs.
//
// Die Oberfläche liest keine Datenbank selbst (CENTRAL-UI-PARITY): diese Funktion ist der eine Leseweg der
// Karte. Nur am Primary (auf PC2 gibt es keine Geschäftsdatenbank → `null`, die Karte erscheint nicht), nur
// lesend (drei kleine Zeilen, `supersededEditPlansStatus`). Ändert nichts an Prüfungen, Abbruch oder Rechten —
// die laufen weiter über `runSupersededEditPlansOnPrimary` unter Sperre + Lease.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase } from '@/core/db/database';
import { isClientMode } from '@/core/bridge/client-mode';
import { supersededEditPlansStatus, type SupersededCaseStatus, type SupersededDb } from './superseded-edit-plans.ts';

export function supersededEditPlansStatusOnPrimary(): { cases: SupersededCaseStatus[]; cardVisible: boolean } | null {
  if (isClientMode()) return null;
  try {
    return supersededEditPlansStatus(getDatabase() as unknown as SupersededDb);
  } catch {
    return null;
  }
}

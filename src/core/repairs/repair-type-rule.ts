// ════════════════════════════════════════════════════════════════════════════
// REPAIR-TYPE FINAL CORRECTION — welche Art (`repair_type`) eine Reparatur SPEICHERT, wenn sich ihre Arbeit ändert.
//
// Befund REP-2026-00002: „In-house" ist beim Anlegen vorgewählt; die erste Werkstattzeile machte daraus „hybrid"
// (Regel seit v0.7.6: internal + Werkstattzeile → hybrid, external + eigene Zeile → hybrid), obwohl niemand im Haus
// daran arbeitete. Jetzt zählt die AKTIVE Arbeit, nicht die Vorwahl:
//   • eigene Arbeit  = eine offene Arbeitszeile ohne Lieferant, oder eigene Kosten (`internal_cost` > 0, außer bei
//                      „external" — dort ist das der gespiegelte Voranschlag, keine eigene Arbeit);
//   • Werkstattarbeit = eine offene Arbeitszeile mit Werkstatt, eine eingeplante Werkstatt (noch ohne Zeile), oder die
//                      Werkstatt im Kopf, die nie aus einer Zeile kam (Gebühr beim Anlegen / Altbestand);
//   • nur eigene → internal · nur Werkstatt → external · beides → hybrid · keine aktive Arbeit → bleibt.
// Materialzeilen (`material_kind`, außer dem Lohnposten „labor") gibt der Aufrufer gar nicht erst mit.
//
// Kosten und Status sind geschützt: die neue Art wird nur gespeichert, wenn sie gegenüber dem BISHERIGEN Verhalten
// (`legacy` — was die Regel seit v0.7.6 speichern würde) nichts an Kosten und Statusweg ändert. Sonst bleibt es exakt
// beim bisherigen Verhalten, und der Grund steht in `kept` (der Aufrufer protokolliert ihn):
//   • HYBRID_KEPT — „hybrid" bleibt hybrid (keine automatische Herabstufung; wie bisher);
//   • INVOICED    — abgerechnet (`invoice_id`): die Rechnung trägt die Kosten schon;
//   • COST        — eigene Kosten, Zeilen oder Gebühr (`repairCostParts`, dieselbe Aufteilung wie Marge,
//                   Rechnungseinstand und die Kopfbuchung bei „ready") wären anders, z. B. ein gespiegelter Voranschlag;
//   • STATUS      — der aktuelle Schritt fehlte im neuen Statusweg, oder „Sent to workshop" fiele weg, obwohl die
//                   Reparatur dort steht, von dort zurückkam oder je dort war.
// Rein: keine Datenbank, kein Store. Die Kostenformel selbst bleibt unverändert.
// ════════════════════════════════════════════════════════════════════════════

import { repairCostParts } from './repair-cost';
import { repairStatusFlow } from './repair-status-flow';

export type StoredRepairType = 'internal' | 'external' | 'hybrid';
export type RepairTypeKeptReason = 'HYBRID_KEPT' | 'INVOICED' | 'COST' | 'STATUS';

export interface RepairTypeFacts {
  currentType: string | null | undefined;
  scope?: string | null;
  status?: string | null;
  returnFromStatus?: string | null;
  invoiceId?: string | null;
  internalCost?: number | null;
  estimatedCost?: number | null;
  /** Die Werkstatt, die die Reparatur NACH dieser Änderung trägt (`workshop_supplier_id`). */
  workshopSupplierId?: string | null;
  plannedWorkshopSupplierId?: string | null;
  /** Die Werkstatt im Kopf VOR dieser Änderung, wenn sie nie aus einer Werkstatt-Arbeitszeile kam (Gebühr/Altbestand). */
  assignedWorkshopSupplierId?: string | null;
  /** Die OFFENEN Arbeitszeilen (ohne Material). */
  workLines: ReadonlyArray<{ supplierId?: string | null }>;
  /** Summe ALLER offenen Zeilen (Arbeit + Material) — wie `actual_cost`. */
  openLineTotal: number;
  /** Stand die Reparatur je auf „Sent to workshop" (Protokoll)? */
  everSentToWorkshop?: boolean;
}

export interface RepairTypeDecision {
  /** Was gespeichert wird. */
  type: StoredRepairType;
  /** Was die aktive Arbeit sagt. */
  target: StoredRepairType;
  /** Was das bisherige Verhalten gespeichert hätte. */
  legacy: StoredRepairType;
  /** `type` ≠ bisher gespeicherte Art. */
  changed: boolean;
  /** Warum `type` ≠ `target` bleibt. */
  kept?: RepairTypeKeptReason;
}

const EPS = 0.0005;
const art = (t: string | null | undefined): StoredRepairType => (t === 'external' || t === 'hybrid' ? t : 'internal');

/** Das bisherige Verhalten (seit v0.7.6, nur Zeilen): hochstufen auf hybrid, nie herabstufen. */
export function legacyRepairType(current: StoredRepairType, workLines: RepairTypeFacts['workLines']): StoredRepairType {
  if (current === 'internal' && workLines.some((l) => !!l.supplierId)) return 'hybrid';
  if (current === 'external' && workLines.some((l) => !l.supplierId)) return 'hybrid';
  return current;
}

export function decideRepairType(f: RepairTypeFacts): RepairTypeDecision {
  const current = art(f.currentType);
  const internal = Number(f.internalCost) || 0;
  const ownActive = f.workLines.some((l) => !l.supplierId) || (current !== 'external' && internal > EPS);
  const shopActive = f.workLines.some((l) => !!l.supplierId) || !!f.plannedWorkshopSupplierId || !!f.assignedWorkshopSupplierId;
  const target: StoredRepairType = ownActive && shopActive ? 'hybrid'
    : shopActive ? 'external' : ownActive ? 'internal' : current;
  const legacy = legacyRepairType(current, f.workLines);
  const out = (type: StoredRepairType, kept?: RepairTypeKeptReason): RepairTypeDecision =>
    ({ type, target, legacy, changed: type !== current, ...(kept ? { kept } : {}) });
  if (target === legacy) return out(target);
  if (current === 'hybrid') return out(legacy, 'HYBRID_KEPT');
  if (f.invoiceId) return out(legacy, 'INVOICED');

  const teile = (t: StoredRepairType) => repairCostParts({
    repairType: t, internalCost: internal, estimatedCost: f.estimatedCost ?? null, workshopSupplierId: f.workshopSupplierId ?? null,
  }, f.openLineTotal);
  const a = teile(legacy); const b = teile(target);
  if (Math.abs(a.own - b.own) > EPS || Math.abs(a.fee - b.fee) > EPS || Math.abs(a.total - b.total) > EPS) return out(legacy, 'COST');

  const scope = f.scope ?? undefined;
  const vorher = repairStatusFlow(legacy, scope);
  const nachher = repairStatusFlow(target, scope);
  const status = String(f.status ?? '');
  if (vorher.includes(status as never) && !nachher.includes(status as never)) return out(legacy, 'STATUS');
  const werkstattSchrittWeg = vorher.includes('sent_to_workshop') && !nachher.includes('sent_to_workshop');
  if (werkstattSchrittWeg && (f.returnFromStatus === 'sent_to_workshop' || f.everSentToWorkshop)) return out(legacy, 'STATUS');
  return out(target);
}

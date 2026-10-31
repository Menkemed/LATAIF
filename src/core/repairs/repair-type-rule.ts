// ════════════════════════════════════════════════════════════════════════════
// REPAIR-TYPE FINAL CORRECTION — welche Art (`repair_type`) eine Reparatur SPEICHERT, wenn sich ihre Arbeit ändert.
//
// Befund REP-2026-00002: „In-house" ist beim Anlegen vorgewählt; die erste Werkstattzeile machte daraus „hybrid"
// (Regel seit v0.7.6: internal + Werkstattzeile → hybrid, external + eigene Zeile → hybrid), obwohl niemand im Haus
// daran arbeitete. Jetzt zählt die AKTIVE Arbeit, nicht die Vorwahl:
//   • eigene Arbeit  = eine offene Arbeitszeile ohne Lieferant, oder eigene Kosten (`internal_cost` > 0, außer bei
//                      „external" — dort zählt der Betrag nicht als eigene Arbeit);
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
//                   Rechnungseinstand und die Kopfbuchung bei „ready") wären anders;
//   • STATUS      — der aktuelle Schritt fehlte im neuen Statusweg, oder „Sent to workshop" fiele weg, obwohl die
//                   Reparatur dort steht, von dort zurückkam oder je dort war.
// Rein: keine Datenbank, kein Store.
//
// REPAIR COST FINAL SAFETY — der Betrag in `internal_cost` beim Verlassen von „external". Dort zählt er nicht (own = 0);
// danach zählte ihn die Formel als eigene Kosten, neben der Werkstattzeile über denselben Betrag. Ob er ein Spiegel des
// Voranschlags (`internalCostOnCreate`) oder wirklich erfasst ist, sagt der Betrag NICHT: gleiche Beträge beweisen nichts.
// Beweis ist allein das Protokoll der Anlage (`mirroredAmount`: die Anlage hat genau diesen Betrag selbst gespiegelt,
// niemand hat ihn seither geändert):
//   • NEUTRALIZED — nachweislicher Spiegel → 0; die Werkstattzeile (oder gar nichts) trägt die Kosten;
//   • MIRROR (kept) — kein Nachweis (Altbestand, von Hand geändert): nichts wird geraten — die Reparatur bleibt
//                   „external", der Betrag bleibt stehen und zählt weiter nicht, der Konflikt steht im Protokoll.
// Echte eigene Kosten bei internal/hybrid werden nie angefasst. Altbestand ändert sich nur bei einer neuen Zeilenänderung.
// ════════════════════════════════════════════════════════════════════════════

import { repairCostParts } from './repair-cost';
import { repairStatusFlow } from './repair-status-flow';

export type StoredRepairType = 'internal' | 'external' | 'hybrid';
export type RepairTypeKeptReason = 'HYBRID_KEPT' | 'INVOICED' | 'COST' | 'STATUS' | 'MIRROR';
export type RepairMirrorHandling = 'NEUTRALIZED';

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
  /** Die Werkstatt im Kopf VOR dieser Änderung, wenn sie nicht aus einer Werkstatt-Arbeitszeile kommt (Gebühr/Altbestand). */
  assignedWorkshopSupplierId?: string | null;
  /** Gilt die Werkstatt-Gebühr im Kopf nach dieser Änderung weiter (`repairHeaderFeeKept`)? */
  headerFeeKept?: boolean;
  /** Die OFFENEN Arbeitszeilen (ohne Material). */
  workLines: ReadonlyArray<{ supplierId?: string | null }>;
  /** Summe ALLER offenen Zeilen (Arbeit + Material) — wie `actual_cost`. */
  openLineTotal: number;
  /** Stand die Reparatur je auf „Sent to workshop" (Protokoll)? */
  everSentToWorkshop?: boolean;
  /** Der Betrag, den die Anlage nachweislich gespiegelt hat (Protokoll `internalCostMirrored`; 0/leer = kein Nachweis). */
  mirroredAmount?: number | null;
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
  /** Neuer Wert für `internal_cost` und warum (nur ein nachgewiesener Spiegel). */
  internalCost?: number;
  mirror?: RepairMirrorHandling;
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
  const out = (type: StoredRepairType, kept?: RepairTypeKeptReason, internalCost?: number, mirror?: RepairMirrorHandling): RepairTypeDecision =>
    ({ type, target, legacy, changed: type !== current, ...(kept ? { kept } : {}), ...(mirror ? { internalCost, mirror } : {}) });

  if (current === 'hybrid') return out('hybrid', target !== 'hybrid' ? 'HYBRID_KEPT' : undefined);

  const teile = (t: StoredRepairType, eigene = internal) => repairCostParts({
    repairType: t, internalCost: eigene, estimatedCost: f.estimatedCost ?? null, workshopSupplierId: f.workshopSupplierId ?? null,
  }, f.openLineTotal, { headerFeeKept: !!f.headerFeeKept });
  const scope = f.scope ?? undefined;
  const status = String(f.status ?? '');
  const statusKonflikt = (von: StoredRepairType, nach: StoredRepairType): boolean => {
    const vorher = repairStatusFlow(von, scope);
    const nachher = repairStatusFlow(nach, scope);
    if (vorher.includes(status as never) && !nachher.includes(status as never)) return true;
    const werkstattSchrittWeg = vorher.includes('sent_to_workshop') && !nachher.includes('sent_to_workshop');
    return werkstattSchrittWeg && (f.returnFromStatus === 'sent_to_workshop' || !!f.everSentToWorkshop);
  };

  let typ = target;
  let kept: RepairTypeKeptReason | undefined;
  if (target !== legacy) {
    if (f.invoiceId) { typ = legacy; kept = 'INVOICED'; }
    else if (current !== 'external') {
      // Aus „internal": die neue Art muss kostengleich zum bisherigen Verhalten sein (eigene Kosten zählen in beiden).
      const a = teile(legacy); const b = teile(target);
      if (Math.abs(a.own - b.own) > EPS || Math.abs(a.fee - b.fee) > EPS || Math.abs(a.total - b.total) > EPS) { typ = legacy; kept = 'COST'; }
    }
    if (!kept && statusKonflikt(legacy, target)) { typ = legacy; kept = 'STATUS'; }
  }

  if (current === 'external' && typ !== 'external') {
    // Eine noch geltende Werkstatt-Gebühr darf mit der Art nicht wegfallen oder sich ändern.
    if (Math.abs(teile('external').fee - teile(typ, 0).fee) > EPS) return out('external', 'COST');
    // Der Betrag in `internal_cost` wird nur entfernt, wenn er nachweislich ein Spiegel ist — sonst wird nichts geraten.
    if (internal > EPS) {
      const spiegel = Number(f.mirroredAmount) || 0;
      if (spiegel <= EPS || Math.abs(internal - spiegel) > EPS) return out('external', 'MIRROR');
      return out(typ, kept, 0, 'NEUTRALIZED');
    }
  }
  return out(typ, kept);
}

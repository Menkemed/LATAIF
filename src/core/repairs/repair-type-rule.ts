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
//
// REPAIR COST DOUBLE-COUNT FIX — der Spiegel in `internal_cost`. Bei „external" ist `internal_cost` nie eigene Arbeit
// (`repairCostParts`: own = 0), sondern der gespiegelte Voranschlag (`internalCostOnCreate`) bzw. Actual
// (`internalCostOnEdit`). Verlässt die Reparatur „external" (bisher: hybrid, sobald eine eigene Zeile dazukommt),
// zählte die Formel ihn plötzlich als eigene Kosten — neben der Werkstattzeile, die denselben Betrag schon trägt.
// Jetzt, beim Verlassen von „external" (`mirror`):
//   • NEUTRALIZED — gleich dem Voranschlag und keine Kopf-Gebühr in Kraft: ein Spiegel, keine eigene Arbeit → 0;
//   • CARRIED     — die Werkstatt-Gebühr im Kopf galt bis zu dieser ersten Zeile (sie fällt mit Zeilen weg) und der
//                   Spiegel IST diese Gebühr: er bleibt als ihr Platzhalter stehen (wie bisher, Summe unverändert) und
//                   wird protokolliert (`repairFeeCarried`);
//   • REPLACED    — eine Hybrid-Reparatur mit unverändertem Platzhalter bekommt ihre erste Werkstatt-Arbeitszeile: die
//                   Zeile ersetzt die Gebühr (wie bei „external"), der Platzhalter → 0;
//   • MIRROR (kept) — ein anderer Betrag (nicht der Voranschlag, nicht die Gebühr): ob echte eigene Kosten, entscheidet
//                   ein Mensch — die Reparatur bleibt „external" (eigene Kosten zählen weiter nicht), Protokoll.
// Echte eigene Kosten bei internal/hybrid werden nie angefasst. Altbestand nur bei einer neuen Zeilenänderung.
// ════════════════════════════════════════════════════════════════════════════

import { repairCostParts } from './repair-cost';
import { repairStatusFlow } from './repair-status-flow';

export type StoredRepairType = 'internal' | 'external' | 'hybrid';
export type RepairTypeKeptReason = 'HYBRID_KEPT' | 'INVOICED' | 'COST' | 'STATUS' | 'MIRROR';
export type RepairMirrorHandling = 'NEUTRALIZED' | 'CARRIED' | 'REPLACED';

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
  /** Der zuletzt protokollierte Gebühr-Platzhalter (`repairFeeCarried`), falls je einer stehen blieb. */
  carriedFee?: number | null;
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
  /** Neuer Wert für `internal_cost` (nur wenn er sich ändert oder als Platzhalter stehen bleibt) und warum. */
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
  const shopLine = f.workLines.some((l) => !!l.supplierId);
  const out = (type: StoredRepairType, kept?: RepairTypeKeptReason, internalCost?: number, mirror?: RepairMirrorHandling): RepairTypeDecision =>
    ({ type, target, legacy, changed: type !== current, ...(kept ? { kept } : {}), ...(mirror ? { internalCost, mirror } : {}) });

  if (current === 'hybrid') {
    const kept = target !== 'hybrid' ? 'HYBRID_KEPT' : undefined;
    const platz = Number(f.carriedFee) || 0;
    if (platz > EPS && shopLine && Math.abs(internal - platz) < EPS) return out('hybrid', kept, 0, 'REPLACED');
    return out('hybrid', kept);
  }

  const teile = (t: StoredRepairType) => repairCostParts({
    repairType: t, internalCost: internal, estimatedCost: f.estimatedCost ?? null, workshopSupplierId: f.workshopSupplierId ?? null,
  }, f.openLineTotal);
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

  // Verlässt die Reparatur „external", wird der Spiegel nie zu eigenen Kosten (Doppelzählung mit der Werkstattzeile).
  if (current === 'external' && typ !== 'external') {
    // Eine noch geltende Werkstatt-Gebühr (ohne Kostenzeile) darf mit der Art nicht wegfallen oder sich ändern.
    const gebuehrJetzt = teile('external').fee;
    const gebuehrDanach = repairCostParts({ repairType: typ, internalCost: 0, estimatedCost: f.estimatedCost ?? null,
      workshopSupplierId: f.workshopSupplierId ?? null }, f.openLineTotal).fee;
    if (Math.abs(gebuehrJetzt - gebuehrDanach) > EPS) return out('external', 'COST');
  }
  if (current === 'external' && typ !== 'external' && internal > EPS) {
    const gebuehr = f.assignedWorkshopSupplierId ? repairCostParts({
      repairType: 'external', internalCost: internal, estimatedCost: f.estimatedCost ?? null, workshopSupplierId: f.assignedWorkshopSupplierId,
    }, 0).fee : 0;
    const est = f.estimatedCost === null || f.estimatedCost === undefined ? null : Number(f.estimatedCost);
    if (gebuehr > EPS) {
      if (Math.abs(internal - gebuehr) >= EPS) return out('external', 'MIRROR');
      // Kommt die Werkstattzeile gleich mit, ersetzt sie die Gebühr (wie bei „external"); sonst bleibt der Platzhalter.
      return shopLine ? out(typ, kept, 0, 'NEUTRALIZED') : out(typ, kept, internal, 'CARRIED');
    }
    return est !== null && Math.abs(internal - est) < EPS ? out(typ, kept, 0, 'NEUTRALIZED') : out('external', 'MIRROR');
  }
  return out(typ, kept);
}

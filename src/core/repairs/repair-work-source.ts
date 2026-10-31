// ════════════════════════════════════════════════════════════════════════════
// REPAIR-REDESIGN — WER arbeitet an einer Reparatur, und was sie kostet: EINE reine Ableitung für Liste,
// Quick Edit, Detailseite, PC2 (lädt dieselben Zeilen vom Primary) und Handy (Lesebefehl des Primary).
//
// Bisher wählte man das zweimal: oben den Reparaturtyp (Internal / External / Hybrid) und an jeder
// Arbeitszeile noch einmal „In-house" oder eine Werkstatt. Jetzt wird die Art nicht mehr gewählt, sondern
// angezeigt — und zwar so, dass sie der GESPEICHERTEN Art nie widerspricht (FOLLOW-UP):
//
//   • Die gespeicherte Art (`repair_type`, beim Anlegen aus „Wer arbeitet?", von Arbeitszeilen nur HOCHGESTUFT,
//     nie zurück) bestimmt, welche Beteiligungen es gibt; Arbeitszeilen, eine geplante Werkstatt und eine
//     Altzuordnung kommen dazu (Vereinigung). Eine Seite ohne aktive Arbeitszeile bleibt sichtbar — als
//     „ohne Arbeitszeile" markiert, nicht weggelassen. Eine automatische Herabstufung gibt es nicht: sie änderte
//     Statusweg („Sent to workshop") und Kostenregel (`repairCostParts`, `internalCostOnEdit`).
//   • Arbeitszeilen = offen, ohne `material_kind` (oder der Lohnposten „labor"): ohne Lieferant eigene Arbeit,
//     mit Lieferant Werkstatt.
//   • Eine geplante Werkstatt (`planned_workshop_supplier_id`, beim Anlegen ohne Gebühr) zählt als Werkstatt-
//     beteiligung, solange es von ihr keine Arbeitszeile gibt. Sie bucht NICHTS.
//   • Materiallieferanten sind KEINE Werkstatt (seit dem FOLLOW-UP auch nicht mehr in `recomputeRepairAggregates`).
//     `workshop_supplier_id` wird deshalb nur gelesen, wenn die Reparatur gar keine Zeile hat (Altgebühr).
//
// Gespeichertes ändert diese Datei nicht; die Kosten hier sind dieselbe Summe wie `repairCostParts`, nur aufgeteilt.
// ════════════════════════════════════════════════════════════════════════════
import { REPAIR_WORK_TYPES, type RepairWorkType } from '@/core/models/types';
import { repairCostParts } from './repair-cost';

export type RepairWorkSourceKind = 'inhouse' | 'external' | 'hybrid' | 'none';

/** Woher eine Beteiligung bekannt ist: eine Arbeitszeile, eine geplante Werkstatt, eine Altzuordnung oder nur die Art. */
export type RepairWorkBasis = 'line' | 'planned' | 'assigned' | 'intent';

export interface RepairWorkEntry {
  source: 'inhouse' | 'external';
  /** Die Werkstatt — nie ein Materiallieferant; `null` bei eigener Arbeit oder unbekannter Werkstatt. */
  supplierId: string | null;
  /** Die Arbeitsart der Zeile; `null`, wenn es (noch) keine strukturierte Arbeitszeile gibt. */
  workType: RepairWorkType | null;
  lineId: string | null;
  basis: RepairWorkBasis;
}

export interface RepairWorkSourceInput {
  repairType?: string | null;
  workshopSupplierId?: string | null;
  plannedWorkshopSupplierId?: string | null;
  issueDescription?: string | null;
}

export interface RepairWorkLineInput {
  id?: string;
  status?: string | null;
  supplierId?: string | null;
  workType?: string | null;
  materialKind?: string | null;
  costAmount?: number | null;
}

export interface RepairWorkSource {
  kind: RepairWorkSourceKind;
  inHouse: boolean;
  external: boolean;
  /** Werkstätten, die arbeiten oder eingeplant sind (Arbeitszeilen, Plan, Altzuordnung). */
  workshopIds: string[];
  /** Eine geplante Werkstatt, von der es noch keine Arbeitszeile gibt. */
  plannedWorkshopId: string | null;
  /** Ältere Reparatur: Werkstatt direkt zugeordnet, ganz ohne Zeilen. */
  assignedWorkshopId: string | null;
  /** Externe Beteiligung (gespeicherte Art) ohne bekannte Werkstatt — keine Werkstattzeile, kein Plan. */
  externalWithoutWorkshop: boolean;
  /** Eigene Arbeit laut gespeicherter Art, aber keine offene eigene Arbeitszeile. */
  inHouseWithoutLine: boolean;
  /** Werkstattbeteiligung, aber keine offene Werkstatt-Arbeitszeile (geplant, zugeordnet oder nach Storno). */
  externalWithoutLine: boolean;
  hasWorkLines: boolean;
  /** `lines`: jede Seite hat eine Arbeitszeile; `intent`: mindestens eine Seite nur aus Art, Plan oder Altzuordnung. */
  basis: 'lines' | 'intent';
  entries: RepairWorkEntry[];
}

const isOpen = (l: RepairWorkLineInput): boolean => (l.status ?? 'OPEN') === 'OPEN';
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const uniq = <T>(xs: readonly T[]): T[] => xs.filter((x, i) => xs.indexOf(x) === i);
const knownType = (v: unknown): RepairWorkType | null =>
  ((REPAIR_WORK_TYPES as readonly string[]).includes(String(v)) ? (v as RepairWorkType) : null);
/** Arbeit statt Material: keine Materialart, oder der Lohnposten „labor" (wie die Werkstatt-Nutzung im Lieferantenstamm). */
const isWorkKind = (materialKind: unknown): boolean => !text(materialKind) || text(materialKind) === 'labor';

/** Eine Arbeitszeile: offen und KEIN Material (Diamant, Stein, Gold). */
export function isRepairWorkLine(l: RepairWorkLineInput): boolean {
  return isOpen(l) && isWorkKind(l.materialKind);
}

export function repairWorkSource(r: RepairWorkSourceInput, lines: readonly RepairWorkLineInput[]): RepairWorkSource {
  const open = lines.filter(isOpen);
  const work = open.filter((l) => isWorkKind(l.materialKind));
  const entries: RepairWorkEntry[] = work.map((l) => ({
    source: text(l.supplierId) ? 'external' : 'inhouse',
    supplierId: text(l.supplierId),
    workType: knownType(l.workType),
    lineId: l.id ?? null,
    basis: 'line',
  }));
  const lineShops = uniq(work.map((l) => text(l.supplierId)).filter((x): x is string => !!x));
  const lineIn = work.some((l) => !text(l.supplierId));
  const plannedRaw = text(r.plannedWorkshopSupplierId);
  const planned = plannedRaw && !lineShops.includes(plannedRaw) ? plannedRaw : null;
  if (planned) entries.push({ source: 'external', supplierId: planned, workType: null, lineId: null, basis: 'planned' });
  // Nur ohne JEDE Zeile ist `workshop_supplier_id` eine echte Zuordnung (Altgebühr) — sonst eine Ableitung aus Zeilen.
  const altWerkstatt = text(r.workshopSupplierId);
  const assigned = open.length === 0 && altWerkstatt && altWerkstatt !== planned ? altWerkstatt : null;
  if (assigned) entries.push({ source: 'external', supplierId: assigned, workType: null, lineId: null, basis: 'assigned' });
  const stored = text(r.repairType) ?? 'internal';
  const storedIn = stored === 'internal' || stored === 'hybrid';
  const storedEx = stored === 'external' || stored === 'hybrid';
  // Vereinigung: die gespeicherte Art und was Zeilen, Plan und Altzuordnung zeigen (Zeilen stufen ohnehin hoch).
  const inHouse = storedIn || lineIn;
  const external = storedEx || lineShops.length > 0 || !!planned || !!assigned;
  if (inHouse && !lineIn) entries.push({ source: 'inhouse', supplierId: null, workType: null, lineId: null, basis: 'intent' });
  if (external && lineShops.length === 0 && !planned && !assigned) {
    entries.push({ source: 'external', supplierId: null, workType: null, lineId: null, basis: 'intent' });
  }
  const kind: RepairWorkSourceKind = inHouse && external ? 'hybrid' : external ? 'external' : inHouse ? 'inhouse' : 'none';
  const inHouseWithoutLine = inHouse && !lineIn;
  const externalWithoutLine = external && lineShops.length === 0;
  return {
    kind, inHouse, external,
    workshopIds: uniq(entries.filter((e) => e.source === 'external' && e.supplierId).map((e) => e.supplierId as string)),
    plannedWorkshopId: planned,
    assignedWorkshopId: assigned,
    externalWithoutWorkshop: entries.some((e) => e.source === 'external' && !e.supplierId),
    inHouseWithoutLine,
    externalWithoutLine,
    hasWorkLines: work.length > 0,
    basis: inHouseWithoutLine || externalWithoutLine ? 'intent' : 'lines',
    entries,
  };
}

export const REPAIR_WORK_SOURCE_LABEL: Record<RepairWorkSourceKind, string> = {
  inhouse: 'In-house',
  external: 'External workshop',
  hybrid: 'Hybrid',
  none: 'Not set',
};

/** Die Arbeitsart als Wort der Masken („gold_work" → „Gold Work"). */
export function repairWorkTypeLabel(t: string | null | undefined): string {
  return String(t || 'service').split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Filter der Liste: Arbeitsart, Quelle und Werkstatt an DERSELBEN Beteiligung ─────────────────

/**
 * Wörter, an denen eine ältere Reparatur OHNE Arbeitszeile ihre Arbeitsart im Problemtext verrät (z. B. „Polish").
 * Bewusst eng: ein Treffer wird als „aus dem Issue" angezeigt und ändert nichts an den Daten.
 */
export const REPAIR_ISSUE_KEYWORDS: Partial<Record<RepairWorkType, readonly string[]>> = {
  polishing: ['polish'],
  service: ['service'],
  engraving: ['engrav'],
  plating: ['plating', 'rhodium'],
  stone_setting: ['stone setting', 'set stone'],
  spare_part: ['spare part'],
  gold_work: ['gold work', 'solder'],
};

export type RepairSourceFilter = '' | 'inhouse' | 'external' | 'hybrid' | 'unassigned';

export interface RepairWorkFilter {
  workType?: RepairWorkType | '';
  source?: RepairSourceFilter;
  workshopId?: string;
  /** Ältere Reparaturen ohne Arbeitszeile über ihren Problemtext finden (Standard: ja). */
  issueFallback?: boolean;
}

export interface RepairWorkMatch { match: boolean; viaIssue: boolean }

function issueMentions(issue: string | null | undefined, t: RepairWorkType): boolean {
  const words = REPAIR_ISSUE_KEYWORDS[t];
  if (!words || !issue) return false;
  const low = issue.toLowerCase();
  return words.some((w) => low.includes(w));
}

/**
 * Passt die Reparatur? Arbeitsart, Quelle und Werkstatt müssen an EINER Beteiligung zusammenkommen — eine
 * Hybrid-Reparatur mit eigener Politur und Werkstatt-Service ist ein Treffer für „Polishing + In-house" und
 * „Service + Workshop A", aber NICHT für „Polishing + Workshop A". „Hybrid" ist eine Eigenschaft der ganzen
 * Reparatur. Der Problemtext zählt nur ohne Arbeitszeile, und neben Quelle/Werkstatt nur, wenn die Reparatur
 * genau EINE Beteiligung hat (sonst wäre die Zuordnung geraten).
 */
export function matchRepairWork(
  r: RepairWorkSourceInput, lines: readonly RepairWorkLineInput[], f: RepairWorkFilter,
): RepairWorkMatch {
  const ws = repairWorkSource(r, lines);
  const source = f.source || '';
  const workshop = f.workshopId || '';
  const workType = f.workType || '';
  if (source === 'hybrid' && ws.kind !== 'hybrid') return { match: false, viaIssue: false };
  const srcOk = (e: RepairWorkEntry): boolean => {
    if (!source || source === 'hybrid') return true;
    if (source === 'inhouse') return e.source === 'inhouse';
    if (source === 'external') return e.source === 'external';
    return e.source === 'external' && !e.supplierId;   // unassigned
  };
  const wsOk = (e: RepairWorkEntry): boolean => !workshop || e.supplierId === workshop;
  const narrowed = (!!source && source !== 'hybrid') || !!workshop;
  const issueAllowed = f.issueFallback !== false && !ws.hasWorkLines && (!narrowed || ws.entries.length === 1);
  let viaLine = false;
  let viaIssue = false;
  for (const e of ws.entries) {
    if (!srcOk(e) || !wsOk(e)) continue;
    if (!workType) return { match: true, viaIssue: false };
    if (e.workType === workType) viaLine = true;
    else if (e.workType === null && issueAllowed && issueMentions(r.issueDescription, workType)) viaIssue = true;
  }
  if (viaLine) return { match: true, viaIssue: false };
  return { match: viaIssue, viaIssue };
}

// ── Kosten: dieselbe Summe wie Marge, Einstand und Rechnung — nur aufgeteilt ──────────────────

export interface RepairCostView {
  work: number;
  material: number;
  /** Summe aller offenen Zeilen (Arbeit + Material) — `actual_cost`, sobald es Zeilen gibt. */
  linesTotal: number;
  /** Eigene Kosten der Reparatur (`internal_cost`) — außer bei „external", dort ein Spiegel (`repairCostParts`). */
  own: number;
  /** Altgebühr einer verknüpften Werkstatt ohne jede Zeile (`repairCostParts`). */
  fee: number;
  total: number;
  hasLines: boolean;
}

export function repairCostView(
  r: { repairType?: string | null; internalCost?: number | null; estimatedCost?: number | null; workshopSupplierId?: string | null },
  lines: readonly RepairWorkLineInput[],
): RepairCostView {
  const open = lines.filter(isOpen);
  const sum = (xs: readonly RepairWorkLineInput[]): number => xs.reduce((s, l) => s + (Number(l.costAmount) || 0), 0);
  const work = sum(open.filter((l) => isWorkKind(l.materialKind)));
  const material = sum(open.filter((l) => !isWorkKind(l.materialKind)));
  const parts = repairCostParts(r, work + material);
  return { work, material, linesTotal: work + material, own: parts.own, fee: parts.fee, total: parts.total, hasLines: open.length > 0 };
}

/**
 * Was „Estimated" an DIESER Reparatur bedeutet — gelesen aus der bestehenden Regel, nicht neu erfunden:
 * ohne Zeilen, mit verknüpfter Werkstatt und bei „external"/„hybrid" ist es die Werkstattgebühr, die bei
 * „ready" gebucht wird (`repairCostParts` → `fee`); sonst nur eine Schätzung.
 */
export function repairEstimateRole(
  r: { repairType?: string | null; workshopSupplierId?: string | null }, hasLines: boolean,
): 'fee' | 'info' {
  const ext = r.repairType === 'external' || r.repairType === 'hybrid';
  return !hasLines && ext && !!text(r.workshopSupplierId) ? 'fee' : 'info';
}

// ── Anlegen: eine Werkstatt ohne Gebühr ist EINGEPLANT, nicht zugeordnet ─────────────────────────

/**
 * Was „Create Repair" mit einer gewählten Werkstatt macht. Mit Gebühr wie bisher: `workshopSupplierId` + Gebühr, und
 * `createRepair` legt die Werkstattzeile an (dieselbe Betragsregel wie dort). OHNE Gebühr wird die Werkstatt nur
 * eingeplant (`plannedWorkshopSupplierId`): keine Zeile, keine Altzuordnung — damit bucht eine später eingetragene
 * Schätzung bei „ready" keine Werkstattgebühr und keine Verbindlichkeit. Bei eigener Arbeit gibt es keine Werkstatt.
 */
export function repairCreateWorkshopSplit<T extends {
  repairType?: string | null; workshopSupplierId?: string; plannedWorkshopSupplierId?: string;
  estimatedCost?: number | null; internalCost?: number | null;
}>(form: T): T {
  if (form.repairType !== 'external' && form.repairType !== 'hybrid') {
    return { ...form, workshopSupplierId: undefined, plannedWorkshopSupplierId: undefined };
  }
  const ws = text(form.workshopSupplierId);
  if (!ws) return { ...form, workshopSupplierId: undefined, plannedWorkshopSupplierId: undefined };
  const gebuehr = form.repairType === 'hybrid'
    ? (Number(form.estimatedCost) || 0)
    : ((Number(form.estimatedCost) || 0) || (Number(form.internalCost) || 0));
  if (gebuehr > 0) return { ...form, workshopSupplierId: ws, plannedWorkshopSupplierId: undefined };
  return { ...form, workshopSupplierId: undefined, plannedWorkshopSupplierId: ws };
}

// ── Kosten einer Arbeitszeile — EINE Regel am Primary, an PC2 und am Handy ──────────────────────

/**
 * Eigene Arbeit darf 0.000 kosten (fest angestelltes Personal — keine Zusatzkosten, keine Buchung). Eine
 * Werkstattzeile braucht ihren Betrag über 0: aus ihr wird die Verbindlichkeit an die Werkstatt.
 * Antwort: `null` (in Ordnung) oder der Code des Neins.
 */
export function repairLineCostIssue(
  supplierId: string | null | undefined, cost: unknown,
): 'LINE_COST_INVALID' | 'LINE_COST_REQUIRED' | null {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return 'LINE_COST_INVALID';
  if (text(supplierId) && !(cost > 0)) return 'LINE_COST_REQUIRED';
  return null;
}

export const REPAIR_LINE_COST_MESSAGE: Record<'LINE_COST_INVALID' | 'LINE_COST_REQUIRED', string> = {
  LINE_COST_INVALID: 'the cost must be a number of 0 or more',
  LINE_COST_REQUIRED: 'a workshop line needs its cost (above 0) — it becomes the payable to the workshop',
};

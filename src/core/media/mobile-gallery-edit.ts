// ════════════════════════════════════════════════════════════════════════════
// MOBILE-EDIT-S3 — der Galerie-Edit vom Handy: Plan lesen, gegen den eingefrorenen Baseline
// pruefen, in den BESTEHENDEN Edit-Plan uebersetzen.
//
// Diese Datei baut keine zweite Galerie-Semantik. Sie tut genau zwei Dinge, die der Desktop nicht
// braucht und das Handy sehr wohl:
//
//   1. Sie prueft, ob die Galerie noch die ist, die der Benutzer gesehen hat (`gallery_baseline`).
//      Der Desktop liest die Galerie im selben Moment, in dem er speichert; das Handy hat sie
//      vielleicht vor Minuten geladen.
//   2. Sie besteht darauf, dass der Plan die gesehene Galerie VOLLSTAENDIG abdeckt: jede bestehende
//      Verknuepfung ist entweder ausdruecklich behalten oder ausdruecklich entfernt. Ein Bild, das
//      im Plan schlicht fehlt, ist ein FEHLER — niemals eine Loeschung.
//
// Danach uebergibt sie an `buildEditPlanEnvelope`, und ab dort gilt der vorhandene, atomare
// Vertrag: eine Transaktion, genau ein Titelbild, Entfernen = Link zurueckziehen (kein Datei-Delete),
// Wiederholung ist ein No-op.
// ════════════════════════════════════════════════════════════════════════════

import { buildEditPlanEnvelope, type EditDesiredSlot } from './product-media-edit.ts';
import { galleryBaselineFingerprint } from './gallery-baseline.ts';
import type { EditBaselineLink, EditPlanEnvelope, ProductEditIntent } from './coordinator.ts';
import type { PrepareResult } from './gateway.ts';

/** Hoechstzahl Bilder in der fertigen Galerie — derselbe Wert wie `MAX_UPLOAD_IMAGES` in Rust. */
export const MOBILE_GALLERY_MAX = 8;

export const ERR_GALLERY_PLAN_INVALID = 'MOBILE_GALLERY_PLAN_INVALID';
export const ERR_GALLERY_BASELINE_CHANGED = 'MOBILE_GALLERY_BASELINE_CHANGED';
export const ERR_GALLERY_PLAN_INCOMPLETE = 'MOBILE_GALLERY_PLAN_INCOMPLETE';
export const ERR_GALLERY_TOO_MANY = 'MOBILE_GALLERY_TOO_MANY_IMAGES';

/** Ein Platz in der gewuenschten Reihenfolge: entweder eine bestehende Verknuepfung oder eines der
 *  gerade hochgeladenen Bilder (ueber seinen Slot im Batch). */
export type MobileGalleryOrderEntry = { keep: string } | { new: number };

export interface MobileGalleryPlan {
  productId: string;
  /** Der Fingerabdruck der Galerie, wie das Handy sie beim Oeffnen gelesen hat. */
  galleryBaseline: string;
  /** Die gewuenschte Endreihenfolge; Index 0 ist das Titelbild. */
  order: MobileGalleryOrderEntry[];
  /** Ausdruecklich zu entfernende bestehende Verknuepfungen (stabile `link_id`). */
  remove: string[];
}

const isKeep = (e: MobileGalleryOrderEntry): e is { keep: string } => typeof (e as { keep?: unknown }).keep === 'string';

/**
 * Den Plan aus der Job-Metadata lesen. Fail closed und in derselben Strenge wie die Rust-Seite:
 * beides prueft, damit sich weder Server noch Desktop auf den anderen verlaesst.
 */
export function parseMobileGalleryPlan(metadataJson: string): { ok: true; plan: MobileGalleryPlan } | { ok: false } {
  let meta: unknown;
  try { meta = JSON.parse(metadataJson); } catch { return { ok: false }; }
  const m = meta as Record<string, unknown> | null;
  if (!m || m.kind !== 'gallery_edit') return { ok: false };

  const productId = m.productId;
  if (typeof productId !== 'string' || productId === '') return { ok: false };
  const galleryBaseline = m.galleryBaseline;
  if (typeof galleryBaseline !== 'string' || !/^[0-9a-f]{64}$/.test(galleryBaseline)) return { ok: false };

  if (!Array.isArray(m.order) || !Array.isArray(m.remove)) return { ok: false };
  const order: MobileGalleryOrderEntry[] = [];
  const seenKeep = new Set<string>(), seenNew = new Set<number>();
  for (const raw of m.order) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
    const keys = Object.keys(raw as object);
    if (keys.length !== 1) return { ok: false };
    const entry = raw as { keep?: unknown; new?: unknown };
    if (typeof entry.keep === 'string') {
      if (entry.keep === '' || seenKeep.has(entry.keep)) return { ok: false };
      seenKeep.add(entry.keep);
      order.push({ keep: entry.keep });
    } else if (typeof entry.new === 'number' && Number.isInteger(entry.new) && entry.new >= 0) {
      if (seenNew.has(entry.new)) return { ok: false };
      seenNew.add(entry.new);
      order.push({ new: entry.new });
    } else return { ok: false };
  }

  const remove: string[] = [];
  for (const r of m.remove) {
    if (typeof r !== 'string' || r === '' || remove.includes(r)) return { ok: false };
    // Gleichzeitig behalten und entfernen wollen ist ein widerspruechlicher Plan, kein Grenzfall.
    if (seenKeep.has(r)) return { ok: false };
    remove.push(r);
  }
  if (order.length === 0 && remove.length === 0) return { ok: false };
  return { ok: true, plan: { productId, galleryBaseline, order, remove } };
}

/** Ein Fehler, der NUR fuer diese Sicht gilt: eine Wiederholung mit demselben Plan kann nie
 *  gelingen, weil der Plan auf einem ueberholten Zustand beruht. Der Drain macht daraus einen
 *  terminalen Zustand statt einer Wiederholungsschleife. */
export class MobileGalleryConflict extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

export interface BuildMobileGalleryArgs {
  plan: MobileGalleryPlan;
  /** Die Galerie, wie sie JETZT unter der Sperre gelesen wurde. */
  baseline: EditBaselineLink[];
  /** Die bereits vorbereiteten neuen Bilder, nach Batch-Slot. */
  preparedBySlot: Map<number, { requestId: string; prepared: PrepareResult }>;
  batchId: string;
  tenantId: string;
  branchId: string | null;
  entityId: string;
  role: string;
  productEdit?: ProductEditIntent;
  digestHex: (input: string) => Promise<string>;
}

/**
 * Den mobilen Plan gegen den frisch gelesenen Baseline pruefen und in den vorhandenen
 * `EditPlanEnvelope` uebersetzen.
 *
 * Reihenfolge der Pruefungen ist Absicht — der Baseline zuerst: solange nicht feststeht, dass wir
 * ueber dieselbe Galerie reden, ist jede weitere Aussage ueber "behalten" und "entfernen" wertlos.
 */
export async function buildMobileGalleryEnvelope(args: BuildMobileGalleryArgs): Promise<EditPlanEnvelope> {
  const { plan, baseline } = args;

  // 1) Reden wir ueber dieselbe Galerie? Der Fingerabdruck wird aus dem AKTUELLEN Stand neu
  //    berechnet und mit dem verglichen, den das Handy beim Oeffnen bekommen hat.
  const current = await galleryBaselineFingerprint(baseline);
  if (current !== plan.galleryBaseline) throw new MobileGalleryConflict(ERR_GALLERY_BASELINE_CHANGED);

  // 2) Deckt der Plan die gesehene Galerie vollstaendig ab? Jede bestehende Verknuepfung muss
  //    ausdruecklich behalten ODER ausdruecklich entfernt werden. Fehlt eine, ist der Plan
  //    unvollstaendig — und wird NICHT als "die soll wohl weg" gedeutet.
  const byLinkId = new Map(baseline.map((b) => [b.linkId, b]));
  const keeps = plan.order.filter(isKeep).map((e) => e.keep);
  const named = new Set<string>([...keeps, ...plan.remove]);
  for (const linkId of named) {
    if (!byLinkId.has(linkId)) throw new MobileGalleryConflict(ERR_GALLERY_PLAN_INCOMPLETE);
  }
  for (const b of baseline) {
    if (!named.has(b.linkId)) throw new MobileGalleryConflict(ERR_GALLERY_PLAN_INCOMPLETE);
  }

  // 3) Die Obergrenze gilt fuer den ENDZUSTAND, nicht fuer den Upload: 8 behalten und 1 dazu ist zu
  //    viel, 8 behalten, 1 entfernt und 1 dazu ist in Ordnung.
  if (plan.order.length > MOBILE_GALLERY_MAX) throw new MobileGalleryConflict(ERR_GALLERY_TOO_MANY);

  // 4) Uebersetzen — ab hier gilt der vorhandene Vertrag unveraendert.
  const desired: EditDesiredSlot[] = [];
  const prepared = new Map<string, PrepareResult>();
  for (const entry of plan.order) {
    if (isKeep(entry)) {
      desired.push({ source: 'keep', mediaId: byLinkId.get(entry.keep)!.mediaId });
    } else {
      const p = args.preparedBySlot.get(entry.new);
      if (!p) throw new MobileGalleryConflict(ERR_GALLERY_PLAN_INVALID);
      prepared.set(p.requestId, p.prepared);
      desired.push({ source: 'new', requestId: p.requestId, requestHash: p.prepared.request_hash });
    }
  }

  return buildEditPlanEnvelope({
    batchId: args.batchId,
    tenantId: args.tenantId,
    branchId: args.branchId,
    scopeKind: 'branch',
    entityType: 'product',
    entityId: args.entityId,
    role: args.role,
    baseline,
    desired,
    prepared,
    ...(args.productEdit ? { productEdit: args.productEdit } : {}),
  }, args.digestHex);
}

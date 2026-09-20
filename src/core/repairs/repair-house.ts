// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5C — die Reparatur am Primary: dieselben Regeln, EINE Klammer.
//
// Die drei Handlungen der Reparaturmasken schrieben am Primary ohne gemeinsame Klammer: das
// Anlegen einer Reparatur an eigener Ware setzt den Artikel auf `in_repair` und legt ggf. die
// erste Arbeitszeile an; das Ändern bucht Zahlwege und Kartengebühr um; die Sammelrechnung legt
// den Beleg an und verknüpft danach jede Reparatur einzeln. Scheiterte ein späterer Schritt, blieb
// der frühere stehen. Der Fernbefehl klammert seit jeher — jetzt klammert der Primary genauso,
// exklusiv in derselben Warteschlange, und speichert erst nach dem Commit durabel.
//
// Die Regeln selbst stehen in `repair-rules`; hier wohnen nur die Anschlüsse ans Haus.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, watchLedgerPosts } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { getLotsWithPurchaseNumbers } from '@/core/lots/lot-queries';
import { useRepairStore, sumOpenRepairLineCosts } from '@/stores/repairStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { normalizeRecordImages } from '@/core/media/record-image';
import { applyRepairGallery, ingestRepairPhotos, resolveRepairPhotoSlots } from '@/core/repairs/repair-media';
import type { Repair, RepairLine, RepairStatus } from '@/core/models/types';
import {
  RepairActionRejected, assertRepairEditRefs, buildRepairEditPatch, normalizeRepairCreate, planRepairCreate,
  type RepairHousePort, type RepairInvoiceOptions,
} from './repair-rules';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseRepairPort(branchId: string): RepairHousePort {
  const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    product: (id) => {
      const r = query('SELECT id, source_type, brand, name, sku, category_id FROM products WHERE id = ? AND branch_id = ?',
        [id, branchId])[0];
      if (!r) return undefined;
      return {
        id: String(r.id), sourceType: str(r.source_type) ?? null,
        brand: str(r.brand), name: str(r.name), sku: str(r.sku), categoryId: str(r.category_id),
      };
    },
    // Dieselbe Quelle wie die Losauswahl der Maske — keine zweite Vorstellung davon, was „aktiv" ist.
    lotBelongs: (lotId, productId) => getLotsWithPurchaseNumbers(productId, branchId).some((l) => l.id === lotId),
    supplierExists: (id) => !!query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [id, branchId])[0],
    // Die Mitarbeiterauswahl der Maske zeigt nur, wer nicht ausgeschieden ist.
    employeeExists: (id) => !!query(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId],
    )[0],
    // Dieselbe Menge wie die Kategorie-Chips der Masken: die aktiven der Filiale, ohne „Repair Service".
    categoryExists: (id) => !id.startsWith('cat-repair-service')
      && !!query('SELECT id FROM categories WHERE id = ? AND branch_id = ? AND COALESCE(active, 1) = 1', [id, branchId])[0],
  };
}

function frischLesen(): void {
  const rs = useRepairStore.getState();
  rs.loadRepairs();
  rs.loadRepairLines();
  useProductStore.getState().loadProducts();
  useInvoiceStore.getState().loadInvoices();
}

/** Eine Handlung am Primary: exklusiv, in EINER Transaktion, erst danach durabel. */
function amPrimary<T>(work: () => T | Promise<T>): Promise<T> {
  return runExclusive(async () => {
    beginLedgerTransaction();
    let out: T;
    try {
      out = await work();
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      frischLesen();
      throw e;
    }
    await saveDatabaseDurably();
    frischLesen();
    return out;
  });
}

/** „Create Repair" am Primary — dieselbe Vorbereitung wie der Fernbefehl, dann `createRepair`. */
export async function createRepairOnPrimary(form: Partial<Repair>): Promise<Repair> {
  // POST-PARITY R7B PP-12 — jedes Foto durch den EINEN Normalisierer (≤ 100 000 B), wie fern — VOR der
  // Klammer: das Umrechnen hält die Schreibreihenfolge des Primary nicht auf.
  // MEDIA-REPAIR — die Fotos werden VOR der Klammer zu geprüften Medienobjekten (noch ohne
  // Verknüpfung, eigene durable Haltepunkte). Danach: Reparatur + Verknüpfungen in EINER Klammer.
  const images = await normalizeRecordImages(form.images ?? []);
  const mediaIds = await ingestRepairPhotos(images);
  return amPrimary(() => {
    const data = planRepairCreate(normalizeRepairCreate(form), houseRepairPort(currentBranchId()));
    const repair = useRepairStore.getState().createRepair({ ...data, images: [] });
    if (mediaIds.length > 0) applyRepairGallery(repair.id, mediaIds);
    return repair;
  });
}

/** Die gespeicherten Fotos einer Reparatur — sie bleiben beim Ändern, wie sie sind. */
function gespeicherteFotos(id: string): string[] {
  try {
    const list = JSON.parse(String(query('SELECT images FROM repairs WHERE id = ?', [id])[0]?.images ?? '[]'));
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/**
 * Die Fassung, die die Maske beim Eintritt ins Bearbeiten gelesen hat — derselbe Vertrag wie der
 * Fernbefehl (`assertRevision` in `service-commands`: gleicher Code, gleicher Wortlaut), INNERHALB
 * der Klammer gegen die Zeile selbst. Feldbefund (Live-Test 19.09.2026): der Primary schrieb seine
 * ganze Maske zurück und überschrieb still, was der zweite Rechner inzwischen gespeichert hatte.
 */
function assertRepairRevision(id: string, expected: number): void {
  const live = query('SELECT revision FROM repairs WHERE id = ? AND branch_id = ?', [id, currentBranchId()])[0];
  if (!live) throw new RepairActionRejected('REPAIR_NOT_FOUND', 'no such repair');
  const now = Number(live.revision ?? 0);
  if (!Number.isInteger(expected) || now !== expected) {
    throw new RepairActionRejected(
      'RECORD_CHANGED',
      `this record changed since you opened it (you saw ${expected}, it is now ${now})`
        + ' — nothing was saved. Your entries are still in the form; Cancel loads the current version.',
    );
  }
}

/** „Save" der Detailseite am Primary — derselbe Schreibsatz wie der Fernbefehl, gegen die gesehene Fassung. */
export async function updateRepairOnPrimary(id: string, form: Partial<Repair>, expectedRevision: number): Promise<void> {
  // MEDIA-REPAIR — `form.images` ist die gewünschte Galerie: eine bestehende Medienkennung (behalten)
  // oder eine neue Aufnahme als Daten-URL. Neue Aufnahmen werden VOR der Klammer aufgenommen.
  // POST-PARITY R7B PP-12 — neue Fotos durch den EINEN Normalisierer; gespeicherte bleiben.
  let galleryMediaIds: string[] | undefined;
  if (form.images !== undefined) {
    const wunsch = form.images.filter((x): x is string => typeof x === 'string');
    const neu = await normalizeRecordImages(wunsch.filter((x) => x.startsWith('data:')));
    let i = 0;
    galleryMediaIds = await resolveRepairPhotoSlots(
      wunsch.map((x) => (x.startsWith('data:') ? { dataUrl: neu[i++] } : { keep: x })), undefined, id,
    );
  }
  return amPrimary(() => {
    assertRepairRevision(id, expectedRevision);
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    const seen = rs.getRepair(id);
    if (!seen) throw new RepairActionRejected('REPAIR_NOT_FOUND', 'no such repair');
    // Die offenen Kostenzeilen gehoeren in die Ableitung — sonst zaehlt ihre Summe doppelt.
    const patch = buildRepairEditPatch(form, sumOpenRepairLineCosts(id));
    assertRepairEditRefs(patch, seen, houseRepairPort(currentBranchId()));
    // POST-PARITY PP-13/PP-14 — gebuchte Kopfkosten folgen der Änderung; dieselbe Buchungswache wie fern.
    mitBuchungswache('repairs.update', () => {
      // Eine fachliche Änderung — eine Fassung: die Galerie ZUERST (sie leert auch die alte Spalte),
      // dann die Zeile — so trägt der Abgleich den Stand NACH der Fotoänderung.
      if (galleryMediaIds) applyRepairGallery(id, galleryMediaIds);
      rs.updateRepair(id, patch);
    });
  });
}

// ── POST-PARITY PP-13 — Status und Kostenzeilen am Primary: dieselbe Klammer wie der Fernbefehl ──
// Werkstattforderung (Soll INVENTORY bei eigener Ware), Kapitalisierung in Artikel + Los und Status
// gehören zusammen: scheitert ein Teil — auch eine im Store abgefangene Buchung —, fällt ALLES zurück.
function mitBuchungswache<T>(what: string, work: () => T): T {
  const check = watchLedgerPosts(what);
  const out = work();
  check();
  return out;
}

/** „Mark Ready" & Co. am Primary — derselbe Hausweg wie `repairs.update_status`. */
export function updateRepairStatusOnPrimary(id: string, status: RepairStatus): Promise<void> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    mitBuchungswache('repairs.update_status', () => rs.updateStatus(id, status));
  });
}

/** „+ Add Line" am Primary — derselbe Hausweg wie `repairs.add_line`. */
export function addRepairLineOnPrimary(repairId: string, data: Partial<RepairLine>): Promise<void> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    mitBuchungswache('repairs.add_line', () => { rs.addRepairLine(repairId, data); });
  });
}

/** „Cancel" einer Kostenzeile am Primary — derselbe Hausweg wie `repairs.cancel_line`. */
export function cancelRepairLineOnPrimary(lineId: string): Promise<void> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    mitBuchungswache('repairs.cancel_line', () => rs.cancelRepairLine(lineId));
  });
}

/** Eine oder mehrere Reparaturen in EINE Rechnung — Liste, Kürzel und Detailseite. */
export function invoiceRepairsOnPrimary(
  repairIds: readonly string[], opts: RepairInvoiceOptions = {},
): Promise<{ invoiceId: string }> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    return rs.createCombinedRepairInvoice([...repairIds], opts);
  });
}

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
import { query, currentBranchId, currentUserId } from '@/core/db/helpers';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { isAdminOrManagerRole } from '@/core/auth/role-permissions';
import { useAuthStore } from '@/stores/authStore';
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { trackChange } from '@/core/sync/sync-service';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, watchLedgerPosts } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { getLotsWithPurchaseNumbers } from '@/core/lots/lot-queries';
import { repairLotChoiceRequired } from '@/core/partners/item-participation-house';
import { useRepairStore, sumOpenRepairLineCosts } from '@/stores/repairStore';
import { useProductStore } from '@/stores/productStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { normalizeRecordImages } from '@/core/media/record-image';
import { applyRepairGallery, ingestRepairPhotos, resolveRepairPhotoSlots } from '@/core/repairs/repair-media';
import type { Repair, RepairLine, RepairStatus } from '@/core/models/types';
import {
  RepairActionRejected, type RepairCreateWorkInput, assertRepairEditRefs, buildRepairEditPatch, normalizeRepairCreate, planRepairCreate,
  type RepairHousePort, type RepairInvoiceOptions,
} from './repair-rules';
import { repairStatusTargets, repairTransitionFacts } from './repair-status-flow';
import { REPAIR_LINE_COST_MESSAGE, repairLineCostIssue } from './repair-work-source';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseRepairPort(branchId: string): RepairHousePort {
  const str = (v: unknown): string | undefined => (v === null || v === undefined || v === '' ? undefined : String(v));
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    product: (id) => {
      // BULK METAL V1 — keine Reparatur am Bulk-Systemartikel.
      const r = query("SELECT id, source_type, brand, name, sku, category_id FROM products WHERE id = ? AND branch_id = ? AND id NOT LIKE 'bulk-%'",
        [id, branchId])[0];
      if (!r) return undefined;
      return {
        id: String(r.id), sourceType: str(r.source_type) ?? null,
        brand: str(r.brand), name: str(r.name), sku: str(r.sku), categoryId: str(r.category_id),
      };
    },
    // Dieselbe Quelle wie die Losauswahl der Maske — keine zweite Vorstellung davon, was „aktiv" ist.
    lotBelongs: (lotId, productId) => getLotsWithPurchaseNumbers(productId, branchId).some((l) => l.id === lotId),
    // v0.8.101 S3 — verkauft = Kundenware; gemischte Lose (eigen + gemeinsam) = Los ist Pflicht.
    productSold: (id) => String(query('SELECT stock_status FROM products WHERE id = ? AND branch_id = ?', [id, branchId])[0]?.stock_status ?? '') === 'sold',
    lotChoiceRequired: (productId) => repairLotChoiceRequired(productId),
    supplierExists: (id) => !!query('SELECT id FROM suppliers WHERE id = ? AND branch_id = ?', [id, branchId])[0],
    // Die Mitarbeiterauswahl der Maske zeigt nur, wer nicht ausgeschieden ist.
    employeeExists: (id) => !!query(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId],
    )[0],
    // Dieselbe Menge wie die Kategorie-Chips der Masken: die aktiven der Filiale, ohne „Repair Service".
    categoryExists: (id) => !id.startsWith('cat-repair-service') && !id.startsWith('cat-bulk-metal')
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
export async function createRepairOnPrimary(form: Partial<Repair> & RepairCreateWorkInput): Promise<Repair> {
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

// ── HOTFIX F2 — falschen Kunden einer Reparatur korrigieren ──────────────────────────────────
// Nur ADMIN/MANAGER, nur solange die Reparatur weder auf einer Rechnung steht noch eine Zahlung (oder ein
// Kunden-Goldguthaben aus ihr) dem bisherigen Kunden gehört — dann wäre es keine reine Zuordnung mehr. Nummer, Details,
// Bilder, Verlauf und Status bleiben; geändert wird nur `customer_id`, mit Grund im Protokoll (alt/neu, wer, wann).
export interface RepairCustomerChange { repairId: string; customerId: string; reason: string }
export interface RepairCustomerChangeCtx { branchId: string; userId: string; role: string | undefined }

/** In der Transaktion des Aufrufers (Primary wie Fernbefehl). */
export function changeRepairCustomerInHouse(input: RepairCustomerChange, ctx: RepairCustomerChangeCtx): void {
  if (!isAdminOrManagerRole(ctx.role)) {
    throw new RepairActionRejected('PERMISSION_DENIED', 'only a manager or the owner may change the customer of a repair');
  }
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 3) throw new RepairActionRejected('REPAIR_CUSTOMER_REASON_REQUIRED', 'give a reason for the customer change');
  const r = query(
    `SELECT customer_id, repair_number, invoice_id, customer_paid_amount, customer_payment_ledger_id
       FROM repairs WHERE id = ? AND branch_id = ?`,
    [input.repairId, ctx.branchId],
  )[0];
  if (!r) throw new RepairActionRejected('REPAIR_NOT_FOUND', 'no such repair');
  if (!query('SELECT 1 FROM customers WHERE id = ? AND branch_id = ?', [input.customerId, ctx.branchId]).length) {
    throw new RepairActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
  }
  const vorher = String(r.customer_id ?? '');
  if (vorher === input.customerId) throw new RepairActionRejected('REPAIR_CUSTOMER_UNCHANGED', 'this client is already on the repair');
  if (r.invoice_id) {
    throw new RepairActionRejected('REPAIR_CUSTOMER_LOCKED_INVOICED', 'the repair is already on an invoice — the client cannot be changed here');
  }
  if (Number(r.customer_paid_amount ?? 0) > 0.0005 || r.customer_payment_ledger_id) {
    throw new RepairActionRejected('REPAIR_CUSTOMER_LOCKED_PAID', 'the client has already paid for this repair — the client cannot be changed here');
  }
  if (query('SELECT 1 FROM customer_gold_credits WHERE source_repair_id = ? LIMIT 1', [input.repairId]).length) {
    throw new RepairActionRejected('REPAIR_CUSTOMER_LOCKED_GOLD_CREDIT', 'a gold credit of the client comes from this repair — the client cannot be changed here');
  }
  // Genau EINE Änderung an der Zeile (eine neue Fassung) — nicht über `updateRepair`, das Marge, Zahlweg und Kopfkosten
  // nachrechnet; die Reparatur soll bis auf den Kunden bleiben, wie sie ist. Der Abgleich trägt die ganze Zeile.
  getDatabase().run('UPDATE repairs SET customer_id = ?, updated_at = ? WHERE id = ?', [input.customerId, new Date().toISOString(), input.repairId]);
  trackChange('repairs', input.repairId, 'update', {});
  logAuditOrThrow({
    module: 'Repair', entityType: 'repairs', entityId: input.repairId, action: 'UPDATE', field: 'customer_id',
    oldValue: vorher, newValue: { customerId: input.customerId, reason, repairNumber: String(r.repair_number ?? '') },
    actor: { userId: ctx.userId, branchId: ctx.branchId },
  });
}

/** „Change customer" der Detailseite am Primary — gegen die gesehene Fassung, eine Klammer. */
export function changeRepairCustomerOnPrimary(repairId: string, customerId: string, reason: string, expectedRevision: number): Promise<void> {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return amPrimary(() => {
    assertRepairRevision(repairId, expectedRevision);
    changeRepairCustomerInHouse({ repairId, customerId, reason }, { branchId: currentBranchId(), userId: currentUserId(), role: session?.role });
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

/**
 * Die Schritte, die das Haus an dieser Reparatur JETZT zulässt — vorwärts oder („Returned") zurück. Aus den Fakten
 * der Zeile und ihrer Kostenzeilen (dieselbe reine Regel wie Liste, Detailseite, PC2 und Handy).
 */
export function repairStatusTargetsInHouse(repairId: string): RepairStatus[] {
  const rs = useRepairStore.getState();
  const r = rs.getRepair(repairId);
  return r ? repairStatusTargets(repairTransitionFacts(r, rs.getRepairLines(repairId))) : [];
}

/** Ein Statusschritt am Primary — nur, was das Haus anbietet (wie `repairs.update_status`), nie ein freies Setzen. */
export function assertRepairStatusTarget(repairId: string, status: RepairStatus): void {
  const r = useRepairStore.getState().getRepair(repairId);
  if (!r) throw new RepairActionRejected('REPAIR_NOT_FOUND', 'no such repair');
  const ziele = repairStatusTargetsInHouse(repairId);
  if (!ziele.includes(status)) {
    throw new RepairActionRejected('REPAIR_TRANSITION_NOT_ALLOWED',
      `a repair at "${r.status}" does not go to "${status}" — possible: ${ziele.length ? ziele.join(', ') : '(none, it is finished)'}`);
  }
}

/**
 * „Mark Ready", „Picked Up", „Returned", „Reopen" am Primary — derselbe Hausweg wie `repairs.update_status`:
 * zulässiger Schritt, gesehene Fassung (wenn die Maske sie kennt), bei „picked_up" der tatsächliche Abholtag.
 */
export function updateRepairStatusOnPrimary(
  id: string, status: RepairStatus, opts: { expectedRevision?: number; pickedUpDate?: string } = {},
): Promise<void> {
  return amPrimary(() => {
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    if (opts.expectedRevision !== undefined) assertRepairRevision(id, opts.expectedRevision);
    assertRepairStatusTarget(id, status);
    mitBuchungswache('repairs.update_status', () => rs.updateStatus(id, status,
      opts.pickedUpDate !== undefined ? { pickedUpDate: opts.pickedUpDate } : {}));
  });
}

/** Eine Kostenzeile ändern am Primary — derselbe Hausweg wie `repairs.update_line` (gesehene Fassung, offene Zeile). */
export function updateRepairLineOnPrimary(
  repairId: string, lineId: string,
  patch: Partial<Pick<RepairLine, 'costAmount' | 'supplierId' | 'workType' | 'description' | 'dueDate' | 'notes'>>,
  expectedRevision: number,
): Promise<void> {
  return amPrimary(() => {
    assertRepairRevision(repairId, expectedRevision);
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    const line = rs.getRepairLines(repairId).find((l) => l.id === lineId);
    if (!line) throw new RepairActionRejected('LINE_NOT_FOUND', 'no such cost line on this repair');
    if (line.status !== 'OPEN') throw new RepairActionRejected('LINE_NOT_OPEN', `this cost line is "${line.status}"`);
    if (patch.costAmount !== undefined) {
      // REPAIR-REDESIGN — dieselbe Regel wie der Fernbefehl: eigene Arbeit ab 0, eine Werkstattzeile über 0.
      const issue = repairLineCostIssue(patch.supplierId !== undefined ? patch.supplierId : line.supplierId, patch.costAmount);
      if (issue) throw new RepairActionRejected(issue, REPAIR_LINE_COST_MESSAGE[issue]);
    }
    mitBuchungswache('repairs.update_line', () => rs.updateRepairLine(lineId, patch));
  });
}

/**
 * Owner 12.11.2026 — „Edit Cost Date" am Primary: derselbe Hausweg wie `repairs.update_line` mit `costDate` + `reason`
 * (gesehene Fassung, offene Zeile; Prüfungen und Umbuchung in `changeRepairLineCostDateInHouse`).
 */
export function changeRepairLineCostDateOnPrimary(repairId: string, lineId: string, costDate: string, reason: string, expectedRevision: number): Promise<void> {
  return amPrimary(() => {
    assertRepairRevision(repairId, expectedRevision);
    const rs = useRepairStore.getState();
    rs.loadRepairs();
    rs.loadRepairLines();
    const line = rs.getRepairLines(repairId).find((l) => l.id === lineId);
    if (!line) throw new RepairActionRejected('LINE_NOT_FOUND', 'no such cost line on this repair');
    mitBuchungswache('repairs.update_line', () => { rs.changeRepairLineCostDate(lineId, costDate, reason); });
  });
}

/** „+ Add Line" am Primary — derselbe Hausweg wie `repairs.add_line`. */
export function addRepairLineOnPrimary(repairId: string, data: Partial<RepairLine>): Promise<void> {
  // REPAIR-REDESIGN — dieselbe Regel wie der Fernbefehl (vorher nahm der Primary auch eine Werkstattzeile über 0.000).
  const issue = repairLineCostIssue(data.supplierId, data.costAmount ?? 0);
  if (issue) return Promise.reject(new RepairActionRejected(issue, REPAIR_LINE_COST_MESSAGE[issue]));
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

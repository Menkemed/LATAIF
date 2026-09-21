// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY — das Ausweisdokument eines Kunden und eines Lieferanten.
//
// Ein Ausweisfoto ist ein Medium wie jedes andere im Kern (MEDIA-S2): Besitzer, Rolle, Klasse.
// Neu sind genau drei Dinge, und nur die stehen hier:
//
//   1. **Die Rolle** `identity_document` und die Klasse `sensitive`. Keine Verschlüsselung über
//      das Dateisystem hinaus — der Schutz ist der Zugriffsweg: Speicherschlüssel oder
//      Medienkennung allein reichen nirgends, es entscheidet das Tor (`media_read_grant` für die
//      LAN-Route, der geprüfte Leser am Primary).
//   2. **Höchstens EIN aktives Dokument.** Kein Stapel, keine Reihenfolge: eine Person hat einen
//      Ausweis. Technisch ist es die Galerie des Kerns mit einem oder null Einträgen.
//   3. **Die verknüpfte Identität.** Ist ein Lieferant die Lieferantenrolle eines Kunden
//      (`suppliers.linked_customer_id`), dann ist der KUNDE die führende Quelle. Der Lieferant
//      bekommt KEINE zweite Kopie und KEINE eigene Verknüpfung, die nur spiegelt — er liest das
//      Dokument des Kunden. Ändert der Kunde es, sieht der Lieferant beim nächsten Lesen das neue.
//      Und ein Speichern am Lieferanten darf das Dokument des Kunden nicht still ersetzen: es wird
//      abgewiesen, nicht stillschweigend woandershin geschrieben.
//
// Der Altbestand `suppliers.cpr_image` (Bytes in der Zeile) wird NICHT mehr geschrieben und NICHT
// gelöscht: alte Einkaufsbelege ohne eigenen Abzug zeigen ihn weiterhin. Gelesen wird er nur noch,
// solange der Lieferant im Medienspeicher überhaupt keine Geschichte hat — sobald sein Ausweis
// dort einmal lag, ist der Medienspeicher die Wahrheit, auch wenn die Antwort „keiner" lautet.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { getDatabase } from '@/core/db/database';
import { MediaOwnerLinks } from '@/core/media/media-links';
import { resolveOwnerMedia, type OwnerMediaRef } from '@/core/media/owner-media-resolver';
import { ingestRecordPhotos, resolvePhotoSlots, type PhotoSlotRequest, type RecordPhotoScope } from '@/core/media/record-photo-media';
import type { MediaOwner, MediaSecurityClass } from '@/core/media/media-owner';
import type { IdentityDocumentRef } from '@/core/models/types';
import type { StockMediaOrchestrator } from '@/core/media/orchestrator';

export const IDENTITY_MEDIA_ROLE = 'identity_document';
// Genau `sensitive` — nicht irgendeine Klasse: eine Aufnahme kennt `highly_sensitive` nicht (S1:
// ohne Verschlüsselung darf es sie gar nicht geben), und der Typ soll das auch sagen.
export const IDENTITY_MEDIA_CLASS = 'sensitive' as const satisfies MediaSecurityClass;

/** Wer ein Ausweisdokument haben kann. Beides filialgebunden. */
export type IdentityOwnerType = 'customer' | 'supplier';

export class IdentityMediaError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'IdentityMediaError';
  }
}

/** Der Lieferant ist die Rolle eines Kunden — sein Ausweis gehört dorthin, nicht hierher. */
export const IDENTITY_FROM_LINKED_CUSTOMER = 'IDENTITY_FROM_LINKED_CUSTOMER';
/** Das genannte Medium ist (nicht mehr) das Ausweisdokument dieses Datensatzes. */
export const IDENTITY_PHOTO_NOT_FOUND = 'IDENTITY_PHOTO_NOT_FOUND';
export const IDENTITY_OWNER_NOT_FOUND = 'IDENTITY_OWNER_NOT_FOUND';

const TABLE: Record<IdentityOwnerType, string> = { customer: 'customers', supplier: 'suppliers' };

/** Mandant und Filiale dieses Datensatzes — die Filiale entscheidet, wer ihn sehen darf. */
export function identityScope(ownerType: IdentityOwnerType, ownerId?: string): { tenantId: string; branchId: string } {
  let branchId = '';
  if (ownerId) {
    const row = query(`SELECT branch_id FROM ${TABLE[ownerType]} WHERE id = ?`, [ownerId])[0];
    if (row?.branch_id) branchId = String(row.branch_id);
  }
  if (!branchId) branchId = currentBranchId();
  const t = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId])[0];
  return { tenantId: String(t?.tenant_id ?? 'tenant-1'), branchId };
}

export function identityOwner(
  ownerType: IdentityOwnerType,
  ownerId: string,
  scope = identityScope(ownerType, ownerId),
): MediaOwner {
  return {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: scope.branchId,
    entityType: ownerType, entityId: ownerId, role: IDENTITY_MEDIA_ROLE, securityClass: IDENTITY_MEDIA_CLASS,
  };
}

export function identityPhotoScope(
  ownerType: IdentityOwnerType,
  scope = identityScope(ownerType),
  orchestrator?: StockMediaOrchestrator,
): RecordPhotoScope {
  return {
    tenantId: scope.tenantId, branchId: scope.branchId, ownerType,
    role: IDENTITY_MEDIA_ROLE, securityClass: IDENTITY_MEDIA_CLASS, orchestrator,
  };
}

// ── Die verknüpfte Identität ────────────────────────────────────────────────────────────────

/** Der Kunde, dessen Lieferantenrolle dieser Lieferant ist — oder `null`. */
export function linkedCustomerOf(supplierId: string): string | null {
  const row = query('SELECT linked_customer_id FROM suppliers WHERE id = ?', [supplierId])[0];
  const id = row?.linked_customer_id;
  return typeof id === 'string' && id ? id : null;
}

/** Wem das Ausweisdokument dieses Datensatzes GEHÖRT — die führende Quelle. */
export function identitySourceOf(
  ownerType: IdentityOwnerType,
  ownerId: string,
): { ownerType: IdentityOwnerType; ownerId: string; fromLinkedCustomer: boolean } {
  if (ownerType === 'supplier') {
    const customerId = linkedCustomerOf(ownerId);
    if (customerId) return { ownerType: 'customer', ownerId: customerId, fromLinkedCustomer: true };
  }
  return { ownerType, ownerId, fromLinkedCustomer: false };
}

// ── Aufnehmen ───────────────────────────────────────────────────────────────────────────────

/** Eine Daten-URL → ein geprüftes, noch UNVERKNÜPFTES Medium. Läuft VOR der Geschäftstransaktion. */
export async function ingestIdentityPhoto(
  dataUrl: string,
  ownerType: IdentityOwnerType,
  opts: { orchestrator?: StockMediaOrchestrator; ownerId?: string } = {},
): Promise<string> {
  const scope = identityPhotoScope(ownerType, identityScope(ownerType, opts.ownerId), opts.orchestrator);
  const [mediaId] = await ingestRecordPhotos([dataUrl], scope);
  return mediaId;
}

/** Was die Maske will: entfernen (`null`), behalten oder eine neue Aufnahme. `undefined` = nichts tun. */
export type IdentityPhotoPlan = null | { keep: string } | { dataUrl: string };

/**
 * Den Wunsch der Maske in eine Medienkennung auflösen (oder `null` für „entfernen").
 * Eine neue Aufnahme wird hier aufgenommen — vor der Klammer, wie überall im Kern.
 */
export async function resolveIdentityPlan(
  plan: IdentityPhotoPlan,
  ownerType: IdentityOwnerType,
  opts: { orchestrator?: StockMediaOrchestrator; ownerId?: string } = {},
): Promise<string | null> {
  if (plan === null) return null;
  const scope = identityPhotoScope(ownerType, identityScope(ownerType, opts.ownerId), opts.orchestrator);
  const [id] = await resolvePhotoSlots([plan as PhotoSlotRequest], scope);
  return id ?? null;
}

// ── Setzen ──────────────────────────────────────────────────────────────────────────────────

/**
 * Das Ausweisdokument INNERHALB der laufenden Geschäftstransaktion setzen, austauschen oder
 * entfernen. `null` heißt „keines".
 *
 * Ein Austausch ist EIN Aufruf und damit GENAU EINE Fassung des Besitzers — nicht „raus" plus
 * „rein". Ändert sich nichts, wird nichts geschrieben und nichts gezählt.
 *
 * Ein verknüpfter Lieferant wird abgewiesen: sein Ausweis gehört dem Kunden. Stillschweigend
 * dorthin zu schreiben wäre genau das, was nicht passieren darf — der Mensch am Lieferanten hat
 * den Kunden nicht vor sich und weiß nicht, wessen Dokument er gerade tauscht.
 */
export function applyIdentityDocument(
  ownerType: IdentityOwnerType,
  ownerId: string,
  mediaId: string | null,
  opts: { bumpOwner?: boolean } = {},
): { changed: boolean } {
  if (ownerType === 'supplier' && linkedCustomerOf(ownerId)) {
    throw new IdentityMediaError(
      IDENTITY_FROM_LINKED_CUSTOMER,
      'this supplier is the supplier role of a customer — change the ID document on the customer',
    );
  }
  const links = new MediaOwnerLinks(getDatabase() as never);
  try {
    const r = links.setGallery(identityOwner(ownerType, ownerId), mediaId ? [mediaId] : [], {
      // Wird der Datensatz in DERSELBEN Klammer ohnehin geschrieben, ist SEIN Trigger die eine
      // Fassung. Steht die Änderung des Dokuments allein (Hinzufügen/Entfernen ohne Feldänderung),
      // muss dieser Aufruf die Fassung erhöhen — sonst bliebe die Änderung für einen zweiten
      // Bildschirm unsichtbar.
      bumpOwner: opts.bumpOwner ?? true,
    });
    return { changed: r.changed };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'MEDIA_LINK_OBJECT_NOT_READY') {
      throw new IdentityMediaError(IDENTITY_PHOTO_NOT_FOUND, 'this ID document is not available (any more)');
    }
    if (code === 'MEDIA_OWNER_NOT_FOUND') {
      throw new IdentityMediaError(IDENTITY_OWNER_NOT_FOUND, `no ${ownerType} ${ownerId} in this branch`);
    }
    throw e;
  }
}

// ── Lesen ───────────────────────────────────────────────────────────────────────────────────

/** Das aktuelle Ausweisdokument DIESES Datensatzes (ohne Verknüpfungsregel) — Referenz, keine Bytes. */
export function ownIdentityRef(ownerType: IdentityOwnerType, ownerId: string): OwnerMediaRef | null {
  return ownIdentityRefsFor(ownerType, [ownerId]).get(ownerId) ?? null;
}

/**
 * Gibt es den Medienkern in DIESER Datenbank überhaupt?
 *
 * Eine sehr alte Datenbank — oder eine Testdatenbank, die nur die Geschäftstabellen anlegt — hat
 * keine `media_links`. Das ist die Antwort „dieser Datensatz hat kein Ausweisdokument", kein
 * Fehler; sie muss aber GEFRAGT werden. Eine blanke Abfrage gegen eine fehlende Tabelle wirft, und
 * der Aufrufer ist eine Liste, die ihren Fehler still zu einer LEEREN Liste machen würde — aus
 * einem fehlenden Foto würde so ein fehlender Lieferant.
 */
function mediaCoreAvailable(): boolean {
  const rows = query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_links' LIMIT 1");
  return rows.length > 0;
}

/** Dasselbe für viele Datensätze — EINE Abfrage, damit eine Liste eine Liste bleibt. */
export function ownIdentityRefsFor(
  ownerType: IdentityOwnerType,
  ownerIds: readonly string[],
  branchId?: string,
): Map<string, OwnerMediaRef | null> {
  if (!mediaCoreAvailable()) return new Map(ownerIds.map((id) => [id, null]));
  const scope = identityScope(ownerType);
  const found = resolveOwnerMedia(getDatabase() as never, {
    tenantId: scope.tenantId, scopeKind: 'branch', branchId: branchId ?? scope.branchId,
    entityType: ownerType, role: IDENTITY_MEDIA_ROLE, entityIds: [...ownerIds],
    // Ausdrücklich genannt: der Kern liefert `sensitive` nur auf Nachfrage, damit kein Aufrufer
    // ein Ausweisfoto versehentlich in einer allgemeinen Galerie-Auflösung mitbekommt.
    classes: [IDENTITY_MEDIA_CLASS],
  });
  const out = new Map<string, OwnerMediaRef | null>();
  for (const id of ownerIds) out.set(id, found.get(id)?.[0] ?? null);
  return out;
}

/**
 * Das Ausweisdokument, das für diesen Datensatz GILT — mit der Verknüpfungsregel.
 *
 * Beim verknüpften Lieferanten ist das die aktuelle Fassung des Kunden. „Aktuell" ist hier wörtlich
 * gemeint: es wird bei jedem Lesen aufgelöst, nichts wird kopiert, also sieht der Lieferant nach
 * einem Austausch am Kunden beim nächsten Lesen das neue Dokument.
 */
export function identityDocumentFor(
  ownerType: IdentityOwnerType,
  ownerId: string,
): { ref: OwnerMediaRef | null; source: { ownerType: IdentityOwnerType; ownerId: string; fromLinkedCustomer: boolean } } {
  const source = identitySourceOf(ownerType, ownerId);
  return { ref: ownIdentityRef(source.ownerType, source.ownerId), source };
}

/**
 * MEDIA-IDENTITY §4/§10 — die GELTENDEN Ausweisdokumente vieler Datensätze, in wenigen Abfragen.
 *
 * Für Lieferanten ist das zweistufig, weil die Verknüpfungsregel gilt: erst nachsehen, welche von
 * ihnen die Lieferantenrolle eines Kunden sind, dann für die einen die Dokumente der KUNDEN holen
 * und für die anderen ihre eigenen. Zwei Abfragen für eine ganze Liste — nicht zwei je Zeile.
 */
export function identityDocumentsFor(
  ownerType: IdentityOwnerType,
  ownerIds: readonly string[],
  branchId?: string,
): Map<string, IdentityDocumentRef | null> {
  const out = new Map<string, IdentityDocumentRef | null>();
  const ids = [...new Set(ownerIds.filter((x) => typeof x === 'string' && x.length > 0))];
  for (const id of ids) out.set(id, null);
  if (ids.length === 0) return out;

  if (ownerType === 'customer') {
    const refs = ownIdentityRefsFor('customer', ids, branchId);
    for (const id of ids) out.set(id, describe(refs.get(id) ?? null, 'customer', id, false));
    return out;
  }

  // Lieferanten: wer ist die Rolle eines Kunden?
  const linked = new Map<string, string>();
  const rows = query(
    `SELECT id, linked_customer_id FROM suppliers WHERE linked_customer_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [...ids],
  );
  for (const r of rows) {
    const sid = String(r.id);
    const cid = r.linked_customer_id;
    if (typeof cid === 'string' && cid) linked.set(sid, cid);
  }
  const ownIds = ids.filter((id) => !linked.has(id));
  const ownRefs = ownIdentityRefsFor('supplier', ownIds, branchId);
  for (const id of ownIds) out.set(id, describe(ownRefs.get(id) ?? null, 'supplier', id, false));

  const customerIds = [...new Set(linked.values())];
  if (customerIds.length > 0) {
    const custRefs = ownIdentityRefsFor('customer', customerIds, branchId);
    for (const [sid, cid] of linked) {
      out.set(sid, describe(custRefs.get(cid) ?? null, 'customer', cid, true));
    }
  }
  return out;
}

/** Die Referenz eines einzelnen Datensatzes — mit der Verknüpfungsregel. */
export function identityDocumentRefFor(
  ownerType: IdentityOwnerType, ownerId: string, branchId?: string,
): IdentityDocumentRef | null {
  return identityDocumentsFor(ownerType, [ownerId], branchId).get(ownerId) ?? null;
}

function describe(
  ref: OwnerMediaRef | null,
  sourceOwnerType: IdentityOwnerType,
  sourceOwnerId: string,
  fromLinkedCustomer: boolean,
): IdentityDocumentRef | null {
  if (!ref) return null;
  return {
    mediaId: ref.mediaId,
    key: ref.main.storageKey,
    thumbKey: ref.thumbnail?.storageKey ?? null,
    hash: ref.main.hash,
    extension: ref.main.extension,
    generationNo: ref.main.generationNo,
    sourceOwnerType,
    sourceOwnerId,
    fromLinkedCustomer,
  };
}

/**
 * MEDIA-IDENTITY §9 — die Fassung, die der Bildschirm gesehen hat, gegen die Zeile.
 *
 * Am Primary gibt es keinen Fernbefehl, der das täte, also steht die Prüfung hier — sonst wäre
 * der Vertrag genau dort schwächer, wo zwei Menschen gleichzeitig am selben Datensatz sitzen.
 */
export function assertIdentityOwnerRevision(
  ownerType: IdentityOwnerType, ownerId: string, expected: number,
): void {
  const row = query(`SELECT revision FROM ${TABLE[ownerType]} WHERE id = ?`, [ownerId])[0];
  if (!row) throw new IdentityMediaError(IDENTITY_OWNER_NOT_FOUND, `no ${ownerType} ${ownerId}`);
  const now = Number(row.revision ?? 1);
  if (now !== expected) {
    throw new IdentityMediaError(
      'RECORD_CHANGED',
      `this record changed since you opened it (you saw ${expected}, it is now ${now}) — nothing was saved`,
    );
  }
}

/**
 * ALTBESTAND — hatte dieser Lieferant jemals ein Ausweisdokument im Medienspeicher?
 *
 * Die Frage entscheidet, ob `suppliers.cpr_image` noch gezeigt werden darf. Gezählt werden auch
 * still gelegte Verknüpfungen: wer sein Dokument bewusst ENTFERNT hat, will nicht, dass die alte
 * Kopie aus der Spalte wieder auftaucht. Solange es nie eine Verknüpfung gab, ist die Spalte das
 * Einzige, was es gibt — und die zu verstecken wäre Datenverlust auf dem Bildschirm.
 */
export function supplierHasIdentityHistory(supplierId: string): boolean {
  if (!mediaCoreAvailable()) return false;
  const scope = identityScope('supplier', supplierId);
  const rows = query(
    `SELECT 1 FROM media_links WHERE tenant_id = ? AND entity_type = 'supplier' AND entity_id = ?
       AND media_role = ? LIMIT 1`,
    [scope.tenantId, supplierId, IDENTITY_MEDIA_ROLE],
  );
  return rows.length > 0;
}

/** Der Altbestand dieses Lieferanten, falls er noch gilt. */
export function supplierLegacyIdPhoto(supplierId: string): string | null {
  if (supplierHasIdentityHistory(supplierId)) return null;
  const row = query('SELECT cpr_image FROM suppliers WHERE id = ?', [supplierId])[0];
  const v = row?.cpr_image;
  return typeof v === 'string' && v ? v : null;
}

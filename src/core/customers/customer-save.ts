// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY §2 — die gemeinsame Speicherfolge eines Kunden, mit seinem Ausweisdokument.
//
// Vorher baute jede Maske ihre beiden Anschlüsse selbst (`local` / `remote`), und das war in
// Ordnung, solange ein Kunde nur Felder hatte. Ein Ausweisdokument hat einen Weg davor (aufnehmen
// oder in die Ablage legen), einen Stand (welche Fassung war auf dem Bildschirm) und eine
// Reihenfolge innerhalb der Klammer. Das dreimal zu schreiben hieße, es dreimal zu können.
//
// Es gibt keine zweite Kundenlogik: am Primary läuft `createCustomer`/`updateCustomer` wie bisher,
// auf PC2 die vorhandenen Befehle `customers.create`/`customers.update`.
// ════════════════════════════════════════════════════════════════════════════
import type { Customer } from '@/core/models/types';
import type { WriteOutcome } from '@/core/data/shared-write';
import { runOnPrimary } from '@/core/data/primary-action';
import { createPayload, updatePayload, CUSTOMER_EDITABLE } from '@/core/data/write-payloads';
import { useCustomerStore } from '@/stores/customerStore';
import { applyIdentityDocument, assertIdentityOwnerRevision } from '@/core/identity/identity-media';
import { CUSTOMER_PHOTO_KEYS, prepareIdentityPhoto, type IdentityPhotoIntent } from '@/core/identity/identity-save';

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrite` passt. */
export interface CustomerWrite<T> {
  readonly remote: boolean;
  save: (adapters: {
    local: () => T | Promise<T>;
    remote: () => Record<string, unknown>;
    shape?: (value: Record<string, unknown>) => T;
  }) => Promise<WriteOutcome<T>>;
}

const kundenNeu = () => useCustomerStore.getState().loadCustomers();

/** Anlegen — mit oder ohne Ausweisdokument. Ohne ist der Normalfall und kostet nichts extra. */
export async function saveCustomerCreate(
  write: CustomerWrite<{ customerId: string }>,
  form: Record<string, unknown>,
  photo: IdentityPhotoIntent = { kind: 'unchanged' },
): Promise<WriteOutcome<{ customerId: string }>> {
  const body = createPayload(form, CUSTOMER_EDITABLE);
  const foto = await prepareIdentityPhoto(write.remote, 'customer', photo, CUSTOMER_PHOTO_KEYS);
  if (foto.kind === 'fail') return foto.outcome;
  if (foto.kind === 'ready') Object.assign(body, foto.body);
  const mediaId = foto.kind === 'ready' ? foto.mediaId : null;
  return write.save({
    local: () => runOnPrimary(() => {
      const created = useCustomerStore.getState().createCustomer(form as never);
      // Die Zeile ist gerade entstanden — das Anlegen IST die Änderung, keine zweite Fassung.
      if (mediaId) applyIdentityDocument('customer', created.id, mediaId, { bumpOwner: false });
      return { customerId: created.id };
    }, kundenNeu),
    remote: () => body,
    shape: (v) => ({ customerId: String(v.customerId ?? '') }),
  });
}

/**
 * Ändern: nur das Geänderte, dazu das Ausweisdokument und der Stand, den der Bildschirm sah.
 *
 * Ein Austausch ist GENAU EINE Fassung (§9): schreibt dieser Vorgang die Zeile ohnehin, zählt ihr
 * Trigger; ändert sich nur das Dokument, zählt die Verknüpfung.
 */
export async function saveCustomerUpdate(
  write: CustomerWrite<{ id: string }>,
  base: Customer,
  form: Record<string, unknown>,
  photo: IdentityPhotoIntent = { kind: 'unchanged' },
): Promise<WriteOutcome<{ id: string }> | null> {
  const diff = updatePayload(base as unknown as Record<string, unknown>, form, CUSTOMER_EDITABLE);
  const foto = await prepareIdentityPhoto(write.remote, 'customer', photo, CUSTOMER_PHOTO_KEYS, base.id);
  if (foto.kind === 'fail') return foto.outcome;
  // Nichts geändert ist keine Absicht — und für den Fernbefehl ein leerer Auftrag, den er abweist.
  if (Object.keys(diff).length === 0 && foto.kind !== 'ready') return null;
  const body: Record<string, unknown> = { id: base.id, ...diff };
  if (foto.kind === 'ready') {
    Object.assign(body, foto.body);
    body.expectedRevision = base.revision ?? 1;
  }
  const mediaId = foto.kind === 'ready' ? foto.mediaId : null;
  const aendertDokument = foto.kind === 'ready';
  return write.save({
    local: () => runOnPrimary(() => {
      if (aendertDokument) {
        assertIdentityOwnerRevision('customer', base.id, base.revision ?? 1);
        applyIdentityDocument('customer', base.id, mediaId, { bumpOwner: Object.keys(diff).length === 0 });
      }
      if (Object.keys(diff).length > 0) useCustomerStore.getState().updateCustomer(base.id, form as never);
      return { id: base.id };
    }, kundenNeu),
    remote: () => body,
    shape: () => ({ id: base.id }),
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-IDENTITY §2/§3 — die EINE Speicherfolge für ein Ausweisdokument, an beiden Anschlüssen.
//
// Eine Maske sagt nur, was der Mensch wollte: nichts, entfernen, oder dieses neue Bild. Wie daraus
// ein Medium wird, hängt davon ab, wo sie läuft — und genau das steht hier, damit es nicht in fünf
// Masken steht:
//
//   Primary → die Bytes werden HIER aufgenommen (geprüft, normalisiert, veröffentlicht) und die
//             Medienkennung reist in die Klammer des Speicherns.
//   PC2     → die Bytes gehen in die Zwischenablage des Primary (R5B), und der Auftrag nennt nur
//             ihre Inhaltskennung. Nie Bytes im Auftrag.
//
// Aufgenommen wird IMMER vor der Geschäftsklammer: der Ingest hat eigene durable Haltepunkte und
// darf nicht in einer offenen Transaktion sitzen.
// ════════════════════════════════════════════════════════════════════════════
import type { WriteOutcome } from '@/core/data/shared-write';
import { stageRecordDataUrls } from '@/core/bridge/client-staging-upload';
import { ingestIdentityPhoto, type IdentityOwnerType } from '@/core/identity/identity-media';

/** Was der Mensch mit dem Ausweisdokument wollte. */
export type IdentityPhotoIntent =
  | { kind: 'unchanged' }
  | { kind: 'remove' }
  | { kind: 'set'; dataUrl: string };

/** Wie die beiden Befehle das Feld nennen. Der Lieferant behält seinen gewachsenen Namen. */
export const CUSTOMER_PHOTO_KEYS = { staging: 'idPhotoStagingId', remove: 'idPhoto' } as const;
export const SUPPLIER_PHOTO_KEYS = { staging: 'cprImageStagingId', remove: 'cprImage' } as const;

export type IdentityPrepared =
  | { kind: 'unchanged' }
  /** `body` ergänzt den Fernauftrag; `mediaId` ist der lokale Weg (`null` = entfernen). */
  | { kind: 'ready'; body: Record<string, unknown>; mediaId: string | null }
  | { kind: 'fail'; outcome: WriteOutcome<never> };

/**
 * Den Wunsch in das übersetzen, was der jeweilige Anschluss braucht.
 *
 * Scheitert die Zwischenablage, ist das ein `not_executed`: es wurde nachweislich nichts
 * gespeichert, und der Mensch darf es sofort erneut versuchen. Als „unbekannt" zu melden wäre
 * falsch — hier ist noch gar kein Auftrag gestellt worden.
 */
export async function prepareIdentityPhoto(
  remote: boolean,
  ownerType: IdentityOwnerType,
  intent: IdentityPhotoIntent,
  keys: { staging: string; remove: string },
  ownerId?: string,
): Promise<IdentityPrepared> {
  if (intent.kind === 'unchanged') return { kind: 'unchanged' };
  if (intent.kind === 'remove') {
    return { kind: 'ready', body: { [keys.remove]: null }, mediaId: null };
  }
  if (remote) {
    try {
      const [id] = await stageRecordDataUrls([intent.dataUrl]);
      return { kind: 'ready', body: { [keys.staging]: id }, mediaId: null };
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      return {
        kind: 'fail',
        outcome: {
          kind: 'not_executed',
          code: typeof code === 'string' && code ? code : 'STAGING_FAILED',
          message: `The ID document could not be sent to the main computer (${e instanceof Error ? e.message : String(e)}). Nothing was saved.`,
        },
      };
    }
  }
  try {
    const mediaId = await ingestIdentityPhoto(intent.dataUrl, ownerType, { ownerId });
    return { kind: 'ready', body: {}, mediaId };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return {
      kind: 'fail',
      outcome: {
        kind: 'not_executed',
        code: typeof code === 'string' && code ? code : 'IDENTITY_INGEST_FAILED',
        message: `The ID document could not be stored (${e instanceof Error ? e.message : String(e)}). Nothing was saved.`,
      },
    };
  }
}

/**
 * Was eine Maske aus ihrem Zustand macht: `undefined` heißt „unverändert", `null` heißt
 * „entfernt", eine Daten-URL heißt „das hier ist neu". Eine Objekt-URL (das angezeigte,
 * gespeicherte Dokument) ist ausdrücklich KEINE Änderung — sie zeigt nur, was schon da ist.
 */
export function intentOf(formValue: string | null | undefined): IdentityPhotoIntent {
  if (formValue === undefined) return { kind: 'unchanged' };
  if (formValue === null) return { kind: 'remove' };
  if (!formValue.startsWith('data:')) return { kind: 'unchanged' };
  return { kind: 'set', dataUrl: formValue };
}

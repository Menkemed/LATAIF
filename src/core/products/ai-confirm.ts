// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6B — „KI-Identifikation bestätigen", EINE Regel für beide Wege.
//
// Vorher schrieb der Knopf `updateProduct({ aiConfirmedAt: <Uhrzeit dieses Rechners> })`: am Primary
// ohne Prüfung, auf einem Rechner ohne Datenbank ein Griff ins Leere. Jetzt:
//
//   • der Mensch sagt nur „stimmt" — die ZEIT stempelt der Primary, ein Client kann keine wählen;
//   • bestätigt wird nur, was die KI wirklich identifiziert hat (sonst gibt es nichts zu bestätigen);
//   • ein zweites Bestätigen ändert nichts: der erste Stempel bleibt (der Knopf verschwindet danach
//     ohnehin, aber zwei Rechner können gleichzeitig klicken).
//
// Fern reist die Absicht als `products.update` mit `aiConfirmedAt: true` — allein, ohne Textfelder.
// ════════════════════════════════════════════════════════════════════════════
import { query } from '@/core/db/helpers';
import { useProductStore } from '@/stores/productStore';

export type AiConfirmBlocker = 'PRODUCT_NOT_FOUND' | 'AI_NOT_IDENTIFIED';

const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).trim();

/** Darf dieser Artikel bestätigt werden? `null` = ja. Rein, ohne Datenbank. */
export function aiConfirmBlocker(row: { aiIdentifiedSnapshot?: unknown } | undefined): AiConfirmBlocker | null {
  if (!row) return 'PRODUCT_NOT_FOUND';
  if (!txt(row.aiIdentifiedSnapshot)) return 'AI_NOT_IDENTIFIED';
  return null;
}

export const AI_CONFIRM_MESSAGES: Record<AiConfirmBlocker, string> = {
  PRODUCT_NOT_FOUND: 'no such product',
  AI_NOT_IDENTIFIED: 'this item has no AI identification to confirm',
};

/**
 * Am Primary — lokal wie für den Fernauftrag. Wirft einen Fehler mit `code`, wenn es nichts zu
 * bestätigen gibt; gibt den (ersten) Stempel zurück.
 */
export function confirmAiIdentificationInHouse(productId: string): { productId: string; aiConfirmedAt: string } {
  const row = query('SELECT id, ai_identified_snapshot, ai_confirmed_at FROM products WHERE id = ?', [productId])[0] as
    Record<string, unknown> | undefined;
  const blocker = aiConfirmBlocker(row ? { aiIdentifiedSnapshot: row.ai_identified_snapshot } : undefined);
  if (blocker) throw Object.assign(new Error(AI_CONFIRM_MESSAGES[blocker]), { code: blocker });
  const schon = txt(row!.ai_confirmed_at);
  if (schon) return { productId, aiConfirmedAt: schon };
  const now = new Date().toISOString();
  useProductStore.getState().updateProduct(productId, { aiConfirmedAt: now } as never);
  return { productId, aiConfirmedAt: now };
}

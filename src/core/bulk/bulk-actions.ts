// ════════════════════════════════════════════════════════════════════════════
// BULK METAL V1 — die Anschlüsse der Masken: am Primary die Hausfolge in EINER Transaktion
// (`runOnPrimary`), auf PC2 derselbe Vorgang als Fernbefehl (Rumpf = dieselbe Eingabe). Die
// `action_id` entsteht beim Öffnen eines Dialogs und bleibt für jeden Versuch dieses Dialogs gleich.
// ════════════════════════════════════════════════════════════════════════════
import { v4 as uuid } from 'uuid';
import { runOnPrimary } from '@/core/data/primary-action';
import { currentBranchId, currentUserId } from '@/core/db/helpers';
import { useAuthStore } from '@/stores/authStore';
import { isClientMode } from '@/core/bridge/client-mode';
import { BulkRejected } from './bulk-math';
import {
  closeLotInHouse, correctLotInHouse, reopenWronglyClosedLotInHouse, reverseAdjustmentInHouse, writeOffInHouse,
  type BulkActionResult, type BulkCtx, type CloseLotInput, type CorrectLotInput, type ReopenLotInput, type ReopenLotResult,
  type ReverseAdjustmentInput, type WriteOffInput,
} from './bulk-lot-house';

/** Eine neue stabile Kennung für EINE Dialog-Absicht (beim Öffnen erzeugen, bei Wiederholung behalten). */
export const newBulkActionId = (): string => uuid();

function localBulkCtx(): BulkCtx {
  const session = useAuthStore.getState().session as { role?: string } | null | undefined;
  return { branchId: currentBranchId(), userId: currentUserId(), now: new Date().toISOString(), role: session?.role };
}

export const writeOffOnPrimary = (input: WriteOffInput, reload: () => void): Promise<BulkActionResult> =>
  runOnPrimary(() => writeOffInHouse(input, localBulkCtx()), reload);
export const closeLotOnPrimary = (input: CloseLotInput, reload: () => void): Promise<BulkActionResult> =>
  runOnPrimary(() => closeLotInHouse(input, localBulkCtx()), reload);
export const correctLotOnPrimary = (input: CorrectLotInput, reload: () => void): Promise<BulkActionResult> =>
  runOnPrimary(() => correctLotInHouse(input, localBulkCtx()), reload);
export const reverseAdjustmentOnPrimary = (input: ReverseAdjustmentInput, reload: () => void): Promise<BulkActionResult> =>
  runOnPrimary(() => reverseAdjustmentInHouse(input, localBulkCtx()), reload);

/** F10 — ein fälschlich geschlossenes Lot wieder öffnen: nur am Primary (kein Fernbefehl), nur der Owner. */
export const reopenWronglyClosedLotOnPrimary = (input: ReopenLotInput, reload: () => void): Promise<ReopenLotResult> =>
  isClientMode()
    ? Promise.reject(new BulkRejected('PRIMARY_ONLY', 'this repair runs on the main computer only'))
    : runOnPrimary(() => reopenWronglyClosedLotInHouse(input, localBulkCtx()), reload);

// ════════════════════════════════════════════════════════════════════════════
// PARTNER-ITEMS — die Speicherfolge der Partnerseite: Beitrag/Auszahlung, Verkauf (nach)abrechnen,
// Verrechnen, Storno. Zwei Anschlüsse, keine eigene Regel:
//   • am Primary die Hausfolge (`item-participation-house.ts`) — exklusiv, in EINER Transaktion,
//     erst danach durabel (`runOnPrimary`);
//   • auf dem Rechner ohne Datenbank der geprüfte Fernbefehl (`partner_items.*`) — gebucht wird am
//     Primary in der Transaktion des Auftrags, mit Nachweis der Auftragskennung.
// Geprüft wird VOR dem Schicken mit derselben Eingaberegel, die der Primary anwendet.
// ════════════════════════════════════════════════════════════════════════════
import { currentBranchId, currentUserId } from '@/core/db/helpers';
import { runOnPrimary } from '@/core/data/primary-action';
import type { WriteAdapters, WriteOutcome } from '@/core/data/shared-write';
import { usePartnerStore } from '@/stores/partnerStore';
import { usePurchaseStore } from '@/stores/purchaseStore';
import { useBankingStore } from '@/stores/bankingStore';
import {
  PartnerItemRejected, itemMovementInput, itemOffsetInput, requiredId, type ItemMovementInput, type ItemOffsetInput,
} from './item-participation';
import {
  cancelItemMovementInHouse, offsetItemsInHouse, recordItemMovementInHouse, settleSaleLineInHouse,
  type ItemMovementRecorded, type ItemOffsetRecorded, type PartnerItemCtx, type SaleSettled,
} from './item-participation-house';

// Die Namen der geprüften Fernbefehle (`bridge/partner-item-commands.ts`) — als Wert: die Oberfläche
// lädt die Befehlsdatei nicht (sie meldet beim Laden ihre Handler an).
const OP_RECORD_MOVEMENT = 'partner_items.record_movement';
const OP_SETTLE_SALE = 'partner_items.settle_sale';
const OP_OFFSET = 'partner_items.offset';
const OP_CANCEL_MOVEMENT = 'partner_items.cancel_movement';

/** Was eine Maske von ihrer Schreibweiche braucht — `useSharedWrites()` passt. */
export interface ItemWrite {
  readonly remote: boolean;
  save: <T>(op: string, adapters: WriteAdapters<T>) => Promise<WriteOutcome<T>>;
}

function localCtx(): PartnerItemCtx {
  let branchId = '';
  let userId = '';
  try { branchId = currentBranchId(); } catch { branchId = ''; }
  try { userId = currentUserId(); } catch { userId = ''; }
  if (!branchId) throw new PartnerItemRejected('PARTNER_ITEM_NO_SESSION', 'no branch in this session — sign in again');
  return { branchId, userId, now: new Date().toISOString() };
}

function neuLesen(): void {
  const ps = usePartnerStore.getState();
  ps.loadPartners();
  ps.loadTransactions();
  usePurchaseStore.getState().loadPurchases();
  try { useBankingStore.getState().loadTransfers(); } catch { /* Bankseite nicht geladen */ }
}

function absage<T>(e: unknown): WriteOutcome<T> {
  const code = (e as { code?: unknown })?.code;
  return {
    kind: 'business_error',
    code: typeof code === 'string' && code ? code : 'LOCAL_WRITE_REJECTED',
    message: e instanceof Error ? e.message : String(e),
  };
}
function rumpf(input: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined) out[k] = v;
  return out;
}

// ── Am Primary: die Hausfolge in der Schreibreihenfolge ─────────────────────

export function recordItemMovementOnPrimary(input: ItemMovementInput): Promise<ItemMovementRecorded> {
  return runOnPrimary(() => recordItemMovementInHouse(input, localCtx()), neuLesen);
}
export function settleSaleOnPrimary(invoiceLineId: string): Promise<SaleSettled> {
  return runOnPrimary(() => settleSaleLineInHouse(invoiceLineId, localCtx()), neuLesen);
}
export function offsetItemsOnPrimary(input: ItemOffsetInput): Promise<ItemOffsetRecorded> {
  return runOnPrimary(() => offsetItemsInHouse(input, localCtx()), neuLesen);
}
export function cancelItemMovementOnPrimary(movementId: string): Promise<{ cancelled: string[] }> {
  return runOnPrimary(() => cancelItemMovementInHouse(movementId, localCtx()), neuLesen);
}

// ── Die Masken ──────────────────────────────────────────────────────────────

/** „Record contribution" / „Pay out". */
export async function saveItemMovement(w: ItemWrite, raw: Record<string, unknown>): Promise<WriteOutcome<{ movementId: string }>> {
  let input: ItemMovementInput;
  try { input = itemMovementInput(raw); } catch (e) { return absage(e); }
  const r = await w.save<{ movementId: string }>(OP_RECORD_MOVEMENT, {
    local: async () => ({ movementId: (await recordItemMovementOnPrimary(input)).movementId }),
    remote: () => rumpf(input),
    shape: (v) => ({ movementId: String(v.movementId ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) neuLesen();
  return r;
}

/** „Settle sale" / „Correct settlement". */
export async function saveSettleSale(w: ItemWrite, invoiceLineId: string): Promise<WriteOutcome<{ mode: string; shares: unknown }>> {
  let id: string;
  try { id = requiredId(invoiceLineId, 'invoiceLineId'); } catch (e) { return absage(e); }
  const r = await w.save<{ mode: string; shares: unknown }>(OP_SETTLE_SALE, {
    local: async () => { const s = await settleSaleOnPrimary(id); return { mode: s.mode, shares: s.shares }; },
    remote: () => ({ invoiceLineId: id }),
    shape: (v) => ({ mode: String(v.mode ?? ''), shares: v.shares }),
  });
  if (r.kind === 'ok' && w.remote) neuLesen();
  return r;
}

/** „Offset" — Guthaben an einem Artikel gegen Schuld an einem anderen. */
export async function saveItemOffset(w: ItemWrite, raw: Record<string, unknown>): Promise<WriteOutcome<{ groupId: string }>> {
  let input: ItemOffsetInput;
  try { input = itemOffsetInput(raw); } catch (e) { return absage(e); }
  const r = await w.save<{ groupId: string }>(OP_OFFSET, {
    local: async () => ({ groupId: (await offsetItemsOnPrimary(input)).groupId }),
    remote: () => rumpf(input),
    shape: (v) => ({ groupId: String(v.groupId ?? '') }),
  });
  if (r.kind === 'ok' && w.remote) neuLesen();
  return r;
}

/** „Reverse (entry error)". */
export async function saveCancelMovement(w: ItemWrite, movementId: string): Promise<WriteOutcome<{ cancelled: string[] }>> {
  let id: string;
  try { id = requiredId(movementId, 'movementId'); } catch (e) { return absage(e); }
  const r = await w.save<{ cancelled: string[] }>(OP_CANCEL_MOVEMENT, {
    local: async () => cancelItemMovementOnPrimary(id),
    remote: () => ({ movementId: id }),
    shape: (v) => ({ cancelled: Array.isArray(v.cancelled) ? v.cancelled.map(String) : [] }),
  });
  if (r.kind === 'ok' && w.remote) neuLesen();
  return r;
}

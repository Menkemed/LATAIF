// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R6C — die beiden Anschlüsse der Inventurmaske, ohne React.
//
// Am Primary: die Hausfolge (`inventory-house.ts`) in DERSELBEN Schreibreihenfolge wie jeder
// Fernauftrag (`runExclusive`), mit eigener Transaktion und erst danach durabel. Vorher schrieb die
// Maske direkt in die Datenbank und rief `saveDatabase()` — an der Warteschlange vorbei, sodass ein
// Fernauftrag, der gerade auf etwas wartete, ihre Zeilen in seine Transaktion hätte nehmen können.
//
// Auf PC2: nur Lesen vom Primary. Geschrieben wird über die Fernbefehle (`inventory.*`), die die
// Maske über ihre Schreibweiche schickt. Der Kern dieses Rechners wird nie gefragt.
// ════════════════════════════════════════════════════════════════════════════
import { getDatabase, saveDatabaseDurably } from '@/core/db/database';
import { currentBranchId } from '@/core/db/helpers';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { fetchFromPrimary } from '@/core/data/primary-source';
import {
  finishInventory, recordSingleCheck, saveInventory, startInventory,
  type InventorySheet, type InventoryTx, type VerdictInput,
} from './inventory-house';
import { tauriInventoryCore } from './inventory-core';
import type { InventorySessionDb, SessionItem } from './inventory-session';
import type { StockCheck, StockCheckStatus } from './stock-check';

export interface InventoryView extends InventorySheet {
  latest: Record<string, StockCheck>;
  foldedIn: number;
}

/** Die eigene Klammer des Primary — dieselbe Form wie `runOnPrimary`. */
const localTx: InventoryTx = {
  run(fn) {
    beginLedgerTransaction();
    try {
      const v = fn();
      commitLedgerTransaction();
      return v;
    } catch (e) {
      rollbackLedgerTransaction();
      throw e;
    }
  },
};

const db = () => getDatabase() as unknown as InventorySessionDb;
const iso = () => new Date().toISOString();

export function openInventoryHere(productIds: readonly string[]): Promise<InventoryView> {
  return runExclusive(async () => {
    const r = await startInventory(db(), tauriInventoryCore(), localTx, {
      branchId: currentBranchId(), productIds, now: iso(), newId: () => crypto.randomUUID(),
    });
    await saveDatabaseDurably();
    return { ...r.sheet, latest: r.latest, foldedIn: r.foldedIn };
  });
}

export interface SaveAsk {
  sessionId: string;
  expectedRevision: number;
  items: readonly VerdictInput[];
  visibleProductIds: readonly string[];
}

export function saveInventoryHere(ask: SaveAsk, requestIdFor: (productId: string) => string, userId?: string): Promise<{ sheet: InventorySheet; recorded: number; unchanged: boolean }> {
  return runExclusive(async () => {
    // Der Kern prüft die Existenz eines Artikels gegen die Datei auf der Platte — erst die offene
    // Speicherschuld begleichen, sonst wäre ein eben angelegter Artikel dort noch nicht zu sehen.
    await saveDatabaseDurably();
    const r = await saveInventory(db(), tauriInventoryCore(), localTx, {
      branchId: currentBranchId(), ...ask, userId, requestIdFor, now: iso(),
    });
    await saveDatabaseDurably();
    return { sheet: r.sheet, recorded: Object.keys(r.recorded).length, unchanged: r.unchanged };
  });
}

export function finishInventoryHere(sessionId: string, expectedRevision: number): Promise<void> {
  return runExclusive(async () => {
    finishInventory(db(), localTx, { branchId: currentBranchId(), sessionId, expectedRevision, now: iso() });
    await saveDatabaseDurably();
  });
}

export function recordCheckHere(p: { productId: string; status: StockCheckStatus; notes: string; userId?: string; requestId: string }): Promise<StockCheck> {
  return runExclusive(async () => {
    await saveDatabaseDurably();
    return recordSingleCheck(db(), tauriInventoryCore(), { branchId: currentBranchId(), ...p });
  });
}

/** PC2: das Arbeitsblatt des offenen Laufs und die letzte Beobachtung je Artikel — vom Primary. */
export async function inventoryViewFromPrimary(productIds: readonly string[]): Promise<Omit<InventoryView, 'foldedIn'> | null> {
  const d = await fetchFromPrimary('inventory.session.get', { productIds: [...productIds] });
  if (!d) return null;
  const sheet = (d.sheet ?? {}) as Partial<InventorySheet>;
  return {
    sessionId: typeof sheet.sessionId === 'string' ? sheet.sessionId : null,
    startedAt: String(sheet.startedAt ?? ''),
    revision: Number(sheet.revision ?? 0),
    items: Array.isArray(sheet.items) ? sheet.items as SessionItem[] : [],
    latest: (d.latest ?? {}) as Record<string, StockCheck>,
  };
}

/** PC2: der Verlauf eines Artikels — vom Primary. `null`, wenn er nicht zu lesen war. */
export async function checksFromPrimary(productId: string, limit = 20): Promise<StockCheck[] | null> {
  const d = await fetchFromPrimary('inventory.checks.get', { productId, limit });
  if (!d || !Array.isArray(d.checks)) return null;
  return d.checks as StockCheck[];
}

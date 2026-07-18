// ═══════════════════════════════════════════════════════════
// LATAIF — Sync Service
// Pushes local changes to server, pulls remote changes
// Works offline — queues changes and syncs when online
// ═══════════════════════════════════════════════════════════

import { getDatabase, saveDatabase, saveDatabaseDurably } from '../db/database';
import { query } from '../db/helpers';
import { isTransactionActive } from '../db/transaction-context';
import { commitPulledBatch, applyChangesAtomic } from './durable-cursor';
// M6-B2DE4 §5 — the apply path (denylist, identifier gates, applyUpsert, the DELETE branch and
// the applySyncChange dispatcher) lives in the node-safe `apply-change.ts` so the behavioral gate
// can drive the REAL functions against a real sql.js database. Same implementation, one home.
import { applySyncChange, assertSyncIdentifier } from './apply-change';
// M6-B3A §9/§11 — the client's durable quarantine writer + status reader (node-safe, driven by the
// b3a gate too).
import { recordClientQuarantine, quarantineStatus, type QuarantineStatus } from './quarantine';
// Re-exported so existing import paths (`from '.../sync-service'`) keep working.
export { isControlPlaneTable, isValidSyncIdentifier } from './apply-change';

const SYNC_INTERVAL = 30_000; // 30 seconds
const STORAGE_KEY_URL = 'lataif_sync_url';
const STORAGE_KEY_TOKEN = 'lataif_sync_token';
const STORAGE_KEY_LAST = 'lataif_sync_last_id';

// M6-B2DE4 §5 — the control-plane denylist, the identifier charset/gates and applyUpsert moved to
// the node-safe `apply-change.ts` (imported above) so the behavioral gate can drive the REAL
// functions. `isControlPlaneTable` / `isValidSyncIdentifier` are re-exported above; the apply loop
// below calls `applySyncChange`, and `trackChange` uses `assertSyncIdentifier` for its echo-SELECT.

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;
// M4-A1 — Close-Lifecycle: waehrend eines App-Close werden neue Sync-Laeufe pausiert und ein
// bereits laufender Lauf wird als Promise festgehalten, damit der Close darauf warten kann.
let syncPaused = false;
let inFlightSync: Promise<void> | null = null;

// ── Status ──

export type SyncStatus = 'offline' | 'syncing' | 'synced' | 'error';
type SyncListener = (status: SyncStatus, message?: string) => void;
const listeners: SyncListener[] = [];
let currentStatus: SyncStatus = 'offline';

function setStatus(status: SyncStatus, message?: string) {
  currentStatus = status;
  listeners.forEach(fn => fn(status, message));
}

export function onSyncStatus(fn: SyncListener): () => void {
  listeners.push(fn);
  fn(currentStatus);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

export function getSyncStatus(): SyncStatus { return currentStatus; }

// ── M6-B3A §11 — quarantine visibility ──
// A local diagnostic snapshot of the client's open sync quarantine (count, last reason, oldest /
// newest). Surfaced for a status/diagnostics view and to gate cutover-readiness. Safe to call
// anytime; returns zeros when the table is empty or sync is unconfigured.
export function getSyncQuarantineStatus(): QuarantineStatus {
  try {
    return quarantineStatus(getDatabase() as unknown as import('./apply-change').SqlDb);
  } catch {
    return { openCount: 0, lastReason: null, oldestOpenAt: null, newestOpenAt: null };
  }
}

// ── Config ──

export function getSyncUrl(): string {
  return localStorage.getItem(STORAGE_KEY_URL) || '';
}

export function setSyncConfig(url: string, token: string) {
  localStorage.setItem(STORAGE_KEY_URL, url);
  localStorage.setItem(STORAGE_KEY_TOKEN, token);
}

export function clearSyncConfig() {
  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_LAST);
  setStatus('offline');
}

export function isSyncConfigured(): boolean {
  return !!(localStorage.getItem(STORAGE_KEY_URL) && localStorage.getItem(STORAGE_KEY_TOKEN));
}

// ── Track changes locally ──

export function trackChange(tableName: string, recordId: string, action: 'insert' | 'update' | 'delete', data: Record<string, unknown>) {
  if (!isSyncConfigured()) return;
  try {
    const db = getDatabase();
    const now = new Date().toISOString();
    const branchId = (() => { try { const s = JSON.parse(localStorage.getItem('lataif_session') || '{}'); return s.branchId || ''; } catch { return ''; } })();

    // v0.4.2 — Die DB-Spiegelung MUSS die vollstaendige Zeile replizieren.
    // Das vom Caller uebergebene `data` ist oft nur eine Teil-Zusammenfassung
    // (teils mit Feldnamen, die keine echten Spalten sind). Das auf dem anderen
    // Rechner via applyUpsert anzuwenden erzeugt kaputte/unvollstaendige Zeilen
    // oder einen SQL-Fehler → der Change geht verloren. Bei insert/update lesen
    // wir daher die echte Zeile frisch aus der DB; bei delete bleibt es leer
    // (applyUpsert nutzt dort nur die record_id).
    let syncData: Record<string, unknown> = data;
    if (action === 'insert' || action === 'update') {
      // §3 — `tableName` is interpolated into the echo-SELECT below. It comes from local caller
      // code (always a canonical literal), but gate it anyway so no path — not even this local
      // one — turns a non-canonical name into SQL. record_id stays a bound parameter.
      assertSyncIdentifier('table', tableName);
      try {
        const rows = query(`SELECT * FROM ${tableName} WHERE id = ?`, [recordId]);
        if (rows.length > 0) syncData = rows[0];
      } catch { /* Tabelle ohne id-Spalte → Fallback auf Caller-data */ }
    }

    db.run(
      `INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [tableName, recordId, branchId, action, JSON.stringify(syncData), now]
    );
    saveDatabase();
  } catch (err) {
    console.warn('[Sync] Failed to track change:', err);
  }
}

// ── Push: Send local changes to server ──

async function pushChanges(): Promise<number> {
  const url = localStorage.getItem(STORAGE_KEY_URL);
  const token = localStorage.getItem(STORAGE_KEY_TOKEN);
  if (!url || !token) return 0;

  const unsynced = query(
    `SELECT id, table_name, record_id, action, data FROM sync_changelog WHERE synced = 0 ORDER BY id ASC LIMIT 100`
  );

  if (unsynced.length === 0) return 0;

  const changes = unsynced.map(row => ({
    table_name: row.table_name as string,
    record_id: row.record_id as string,
    action: row.action as string,
    data: row.data as string,
  }));

  const res = await fetch(`${url}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ changes }),
  });

  if (!res.ok) throw new Error(`Push failed: ${res.status}`);

  // Mark as synced
  const db = getDatabase();
  const ids = unsynced.map(r => r.id as number);
  for (const id of ids) {
    db.run(`UPDATE sync_changelog SET synced = 1 WHERE id = ?`, [id]);
  }
  saveDatabase();

  return ids.length;
}

// ── Pull: Get remote changes from server ──

async function pullChanges(): Promise<number> {
  const url = localStorage.getItem(STORAGE_KEY_URL);
  const token = localStorage.getItem(STORAGE_KEY_TOKEN);
  if (!url || !token) return 0;

  const lastId = parseInt(localStorage.getItem(STORAGE_KEY_LAST) || '0');

  const res = await fetch(`${url}/api/sync/pull?since=${lastId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) throw new Error(`Pull failed: ${res.status}`);

  const { changes, last_sync_id } = await res.json();

  if (changes.length === 0) return 0;

  // Apply remote changes to local DB
  const db = getDatabase();
  // Plan §Sync-Duplicate-Detection: track IDs of products freshly inserted
  // via Sync (z.B. Foto-Upload vom Handy), damit der SyncDuplicateGuard
  // sie nach dem Reload gegen die DB scoren und ein Side-by-Side-Review
  // zum Mergen anbieten kann.
  const insertedProductIds: string[] = [];
  // M2 / M2-A — Sicherheitsreihenfolge (durable-cursor.ts): apply batch ATOMAR → AWAIT durable
  // save → erst DANN den Cursor vorruecken.
  //   M2:   der Cursor rueckt nur nach bestaetigtem durablem Save vor (saveDatabaseDurably wirft
  //         bei Persist-Fehler → kein Advance → Re-Pull).
  //   M2-A: der Apply-Loop laeuft in EINER sql.js-Transaktion und BRICHT beim ersten Fehler AB
  //         (kein per-Change-Schlucken mehr). ROLLBACK verwirft ALLE bereits angewandten Changes
  //         des Batches → kein partieller, nicht-dauerhafter Memory-Stand bleibt sichtbar; ein
  //         SyncApplyError (change id/table/record/op, KEIN Payload) wird geworfen → commitPulledBatch
  //         erreicht weder durableSave noch setCursor → der Cursor (`lataif_sync_last_id`) bleibt alt
  //         → der naechste Pull liefert den GESAMTEN Batch erneut (applyUpsert/DELETE idempotent).
  //         So wird KEIN Change in der Mitte still uebersprungen.
  await commitPulledBatch({
    applyBatch: () => {
      // Der Pull laeuft nie in einer Ambient-Ledger-Tx; liefe er es doch, wuerde unser ROLLBACK
      // deren Zustand mit-verwerfen → dann lieber laut scheitern (kein Cursor-Advance) als still.
      if (isTransactionActive()) throw new Error('[Sync] pull apply darf nicht in einer aktiven Transaktion laufen');
      applyChangesAtomic(changes, {
        begin: () => db.run('BEGIN'),
        applyChange: (change) => {
          // M6-B2DE4 §5 / M6-B3A §4/§5 — the REAL apply dispatcher (control-plane denylist, canonical
          // table name, business allowlist, allowed operation, then the payload field/shape/limit
          // contract, then applyUpsert / DELETE). Every guard throws a SyncPoisonError BEFORE any SQL
          // string is built. record_id stays a bound parameter.
          applySyncChange(db, change as unknown as import('./apply-change').ApplyChange);
          // Only reached when the change applied cleanly: track inserted products for the
          // duplicate-review event fired after the store reload.
          if (change.action === 'insert' && change.table_name === 'products') {
            insertedProductIds.push(change.record_id);
          }
        },
        // M6-B3A §9/§10 — a DETERMINISTIC policy rejection (SyncPoisonError) does not stall the whole
        // batch: the change is written to the LOCAL quarantine IN THIS SAME transaction (never applied,
        // never counted as applied) and the batch continues. Valid changes before AND after it are
        // applied and committed atomically together; only then does the cursor advance. A genuine
        // transient DB fault is NOT a SyncPoisonError → applyChangesAtomic still rolls the whole batch
        // back and leaves the cursor untouched (→ idempotent re-pull). Closes the head-of-line DoS.
        onPoison: (change, code) => {
          recordClientQuarantine(db, {
            changeId: (change as { id?: number | string }).id ?? null,
            tableName: change.table_name,
            recordId: change.record_id,
            rawData: (change as { data?: string }).data,
            reasonCode: code,
            now: new Date().toISOString(),
          });
        },
        commit: () => db.run('COMMIT'),
        rollback: () => { db.run('ROLLBACK'); insertedProductIds.length = 0; },
      });
    },
    durableSave: saveDatabaseDurably,
    setCursor: () => localStorage.setItem(STORAGE_KEY_LAST, String(last_sync_id)),
  });

  // Plan §LAN-Sync: nach dem Pull die betroffenen Stores neu laden — sonst
  // bleibt die UI auf dem alten Stand und neue Items vom Handy tauchen erst
  // beim naechsten App-Start auf. Per-Store try/catch, sonst killt ein einziger
  // fehlender Store die ganze Reload-Kette.
  //
  // Frueher waren hier nur 9 Stores. Mobile-Aenderungen an Suppliers, Offers,
  // Tasks, Documents, Credit-Notes etc. waren erst nach App-Restart sichtbar —
  // genau das Symptom "hochgeladen, kurz da, nach Restart in DB drin aber in
  // UI weg". Reload-Map deckt jetzt alle Tabellen mit Store-Backing ab.
  const tablesChanged = new Set(changes.map((c: { table_name: string }) => c.table_name));
  if (tablesChanged.size > 0) {
    type Reloader = { tables: string[]; reload: () => Promise<void> };
    const reloadMap: Reloader[] = [
      { tables: ['products'],
        reload: async () => { (await import('@/stores/productStore')).useProductStore.getState().loadProducts(); } },
      { tables: ['customers'],
        reload: async () => { (await import('@/stores/customerStore')).useCustomerStore.getState().loadCustomers(); } },
      { tables: ['invoices', 'invoice_lines', 'payments'],
        reload: async () => { (await import('@/stores/invoiceStore')).useInvoiceStore.getState().loadInvoices(); } },
      { tables: ['repairs'],
        reload: async () => { (await import('@/stores/repairStore')).useRepairStore.getState().loadRepairs(); } },
      { tables: ['orders', 'order_lines'],
        reload: async () => { (await import('@/stores/orderStore')).useOrderStore.getState().loadOrders(); } },
      // order_payments / customer_messages: per-entity store (loadPayments(orderId)/
      // loadMessages(customerId)). Beim Sync-Pull kennen wir die Entity-ID nicht —
      // betroffene Detail-Pages reloaden beim Nav-Switch. Bewusst aus der Map raus.
      { tables: ['purchases', 'purchase_lines', 'purchase_payments', 'purchase_returns', 'purchase_return_lines', 'purchase_inbox'],
        reload: async () => {
          const m = await import('@/stores/purchaseStore');
          m.usePurchaseStore.getState().loadPurchases();
          m.usePurchaseStore.getState().loadReturns();
          m.usePurchaseStore.getState().loadPurchaseInbox();
        } },
      { tables: ['agents', 'agent_transfers', 'agent_settlement_payments'],
        reload: async () => {
          const m = await import('@/stores/agentStore');
          m.useAgentStore.getState().loadAgents();
          m.useAgentStore.getState().loadTransfers();
        } },
      { tables: ['consignments'],
        reload: async () => { (await import('@/stores/consignmentStore')).useConsignmentStore.getState().loadConsignments(); } },
      { tables: ['expenses', 'expense_payments'],
        reload: async () => { (await import('@/stores/expenseStore')).useExpenseStore.getState().loadExpenses(); } },
      // Ab hier neu: Stores die zuvor nicht reloaded wurden.
      { tables: ['suppliers', 'supplier_credits'],
        reload: async () => { (await import('@/stores/supplierStore')).useSupplierStore.getState().loadSuppliers(); } },
      { tables: ['offers', 'offer_lines'],
        reload: async () => { (await import('@/stores/offerStore')).useOfferStore.getState().loadOffers(); } },
      { tables: ['partners', 'partner_transactions'],
        reload: async () => {
          const m = await import('@/stores/partnerStore');
          m.usePartnerStore.getState().loadPartners();
          m.usePartnerStore.getState().loadTransactions();
        } },
      { tables: ['debts', 'debt_payments'],
        reload: async () => { (await import('@/stores/debtStore')).useDebtStore.getState().loadDebts(); } },
      { tables: ['sales_returns', 'sales_return_lines'],
        reload: async () => { (await import('@/stores/salesReturnStore')).useSalesReturnStore.getState().loadReturns(); } },
      { tables: ['credit_notes'],
        reload: async () => { (await import('@/stores/creditNoteStore')).useCreditNoteStore.getState().loadCreditNotes(); } },
      { tables: ['tasks'],
        reload: async () => { (await import('@/stores/taskStore')).useTaskStore.getState().loadTasks(); } },
      { tables: ['documents'],
        reload: async () => { (await import('@/stores/documentStore')).useDocumentStore.getState().loadDocuments(); } },
      { tables: ['bank_transfers'],
        reload: async () => { (await import('@/stores/bankingStore')).useBankingStore.getState().loadTransfers(); } },
      { tables: ['precious_metals', 'metal_payments'],
        reload: async () => { (await import('@/stores/metalStore')).useMetalStore.getState().loadMetals(); } },
      { tables: ['production_records', 'production_inputs', 'production_outputs'],
        reload: async () => { (await import('@/stores/productionStore')).useProductionStore.getState().loadRecords(); } },
    ];
    for (const entry of reloadMap) {
      if (entry.tables.some(t => tablesChanged.has(t))) {
        try { await entry.reload(); }
        catch (err) { console.warn('[Sync] Store reload failed for', entry.tables[0], ':', err); }
      }
    }
  }

  // SyncDuplicateGuard hört auf dieses Event und reviewt phone-uploaded
  // Produkte gegen die bestehende DB. Erst nach dem Store-Reload feuern —
  // sonst hat der Guard die neuen Items noch nicht im productStore-State.
  if (insertedProductIds.length > 0) {
    window.dispatchEvent(new CustomEvent('lataif:sync-products-inserted', {
      detail: { ids: insertedProductIds },
    }));
  }

  return changes.length;
}

// applyUpsert moved to `apply-change.ts` (M6-B2DE4 §5) — same conflict logic, one home, and now
// importable by the behavioral gate against a real sql.js database.

// ── Full sync cycle ──

export function syncNow(): Promise<void> {
  // M4-A1: waehrend eines App-Close (syncPaused) KEINEN neuen Lauf starten; ebenso kein
  // paralleler Lauf (syncing-Single-Flight bleibt unveraendert). Rueckgabe ist der laufende
  // Zyklus als Promise, damit waitForSyncIdle() darauf warten kann.
  if (syncing || syncPaused || !isSyncConfigured()) return Promise.resolve();
  syncing = true;
  setStatus('syncing');

  const run = (async () => {
    try {
      const pushed = await pushChanges();
      const pulled = await pullChanges();
      // C1: drain the authoritative operations-pull too, so a passive device
      // converges on B1 operations (whose effects are NOT in sync_changelog).
      // Dynamic import breaks the operations/sync static cycle.
      let opsApplied = 0;
      try {
        const ops = await import('../operations/service');
        opsApplied = await ops.pullAndApplyOperationsAuto();
      } catch (e) {
        console.warn('[Sync] ops-pull skipped:', e);
      }
      setStatus('synced', `Pushed ${pushed}, pulled ${pulled}, ops ${opsApplied}`);
    } catch (err) {
      console.warn('[Sync] Error:', err);
      setStatus('error', String(err));
    } finally {
      syncing = false;
      inFlightSync = null;
    }
  })();
  inFlightSync = run;
  return run;
}

// ── Auto-sync ──

export function startAutoSync() {
  if (syncTimer) return;
  if (!isSyncConfigured()) return;

  syncNow(); // Initial sync

  syncTimer = setInterval(() => {
    syncNow();
  }, SYNC_INTERVAL);
}

export function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// ── M4-A1: Close-Lifecycle — laufenden Sync sauber abschliessen vor dem finalen Flush ──
//
// Der App-Close-Flow (App.tsx) braucht: neue Sync-Laeufe pausieren → einen bereits laufenden
// syncNow() vollstaendig abwarten → finaler flushDatabase() → Window schliessen. stopAutoSync()
// allein loescht nur den Timer; ein laufender syncNow() koennte danach noch schreiben.

// Pausiert Auto-Sync: loescht den Timer UND blockt neue (Timer- wie manuelle) syncNow-Laeufe,
// bis resumeAutoSync() gerufen wird. Ein BEREITS laufender syncNow() wird NICHT abgebrochen.
export function pauseAutoSync(): void {
  syncPaused = true;
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// Wartet auf den vollstaendigen Abschluss eines bereits laufenden syncNow() (inkl. aller
// DB-Writes + Store-Reloads — die passieren vor der Promise-Aufloesung). syncNow() behandelt
// Fehler intern (setStatus('error')) und rejectet nicht; das try/catch ist rein defensiv, damit
// ein unerwarteter Reject das Close-Warten nicht selbst zum Fehler macht.
export async function waitForSyncIdle(): Promise<void> {
  const p = inFlightSync;
  if (p) { try { await p; } catch { /* syncNow behandelt Fehler intern */ } }
}

// Hebt die Pause auf und startet Auto-Sync wieder — GENAU EIN Timer (startAutoSync guardet gegen
// Doppel-Timer via `if (syncTimer) return`). Fuer den Fall eines abgebrochenen Close.
export function resumeAutoSync(): void {
  syncPaused = false;
  startAutoSync();
}

// Bequemer kombinierter Vertrag fuer den Close: neue Syncs pausieren + laufenden abwarten.
export async function pauseAutoSyncAndWaitForIdle(): Promise<void> {
  pauseAutoSync();
  await waitForSyncIdle();
}

// ── Server login (connects desktop to server) ──

export async function connectToServer(serverUrl: string, email: string, password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!res.ok) {
      return { success: false, error: 'Invalid credentials' };
    }

    const data = await res.json();
    setSyncConfig(serverUrl, data.token);
    startAutoSync();
    return { success: true };
  } catch {
    return { success: false, error: 'Server not reachable' };
  }
}

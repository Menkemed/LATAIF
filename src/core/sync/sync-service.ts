// ═══════════════════════════════════════════════════════════
// LATAIF — Sync Service
// Pushes local changes to server, pulls remote changes
// Works offline — queues changes and syncs when online
// ═══════════════════════════════════════════════════════════

import { getDatabase, saveDatabase } from '../db/database';
import { query } from '../db/helpers';

const SYNC_INTERVAL = 30_000; // 30 seconds
const STORAGE_KEY_URL = 'lataif_sync_url';
const STORAGE_KEY_TOKEN = 'lataif_sync_token';
const STORAGE_KEY_LAST = 'lataif_sync_last_id';

let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncing = false;

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
    db.run(
      `INSERT INTO sync_changelog (table_name, record_id, branch_id, action, data, synced, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [tableName, recordId, branchId, action, JSON.stringify(data), now]
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
  for (const change of changes) {
    try {
      const data = JSON.parse(change.data);
      if (change.action === 'insert' || change.action === 'update') {
        applyUpsert(db, change.table_name, change.record_id, data);
      } else if (change.action === 'delete') {
        db.run(`DELETE FROM ${change.table_name} WHERE id = ?`, [change.record_id]);
      }
    } catch (err) {
      console.warn('[Sync] Failed to apply change:', change, err);
    }
  }

  saveDatabase();
  localStorage.setItem(STORAGE_KEY_LAST, String(last_sync_id));

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
      { tables: ['purchases', 'purchase_lines', 'purchase_payments', 'purchase_returns', 'purchase_return_lines'],
        reload: async () => {
          const m = await import('@/stores/purchaseStore');
          m.usePurchaseStore.getState().loadPurchases();
          m.usePurchaseStore.getState().loadReturns();
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

  return changes.length;
}

function applyUpsert(db: any, table: string, id: string, data: Record<string, unknown>) {
  const keys = Object.keys(data);
  if (keys.length === 0) return;

  // Try update first
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => {
    const v = data[k];
    return typeof v === 'object' ? JSON.stringify(v) : v;
  });

  const result = db.exec(`SELECT COUNT(*) FROM ${table} WHERE id = ?`, [id]);
  const exists = result.length > 0 && result[0].values[0][0] > 0;

  if (exists) {
    db.run(`UPDATE ${table} SET ${setClause} WHERE id = ?`, [...values, id]);
  } else {
    const allKeys = ['id', ...keys];
    const placeholders = allKeys.map(() => '?').join(', ');
    db.run(`INSERT INTO ${table} (${allKeys.join(', ')}) VALUES (${placeholders})`, [id, ...values]);
  }
}

// ── Full sync cycle ──

export async function syncNow(): Promise<void> {
  if (syncing || !isSyncConfigured()) return;
  syncing = true;
  setStatus('syncing');

  try {
    const pushed = await pushChanges();
    const pulled = await pullChanges();
    setStatus('synced', `Pushed ${pushed}, pulled ${pulled}`);
  } catch (err) {
    console.warn('[Sync] Error:', err);
    setStatus('error', String(err));
  } finally {
    syncing = false;
  }
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

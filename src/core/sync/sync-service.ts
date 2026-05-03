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
  // beim naechsten App-Start auf. Wir reloaden anhand der Tabellen die im
  // Changeset vorkommen, damit nicht jedes Mal alle Stores rauschen.
  const tablesChanged = new Set(changes.map((c: { table_name: string }) => c.table_name));
  if (tablesChanged.size > 0) {
    try {
      if (tablesChanged.has('products')) {
        const { useProductStore } = await import('@/stores/productStore');
        useProductStore.getState().loadProducts();
      }
      if (tablesChanged.has('customers')) {
        const { useCustomerStore } = await import('@/stores/customerStore');
        useCustomerStore.getState().loadCustomers();
      }
      if (tablesChanged.has('invoices') || tablesChanged.has('invoice_lines') || tablesChanged.has('payments')) {
        const { useInvoiceStore } = await import('@/stores/invoiceStore');
        useInvoiceStore.getState().loadInvoices();
      }
      if (tablesChanged.has('repairs')) {
        const { useRepairStore } = await import('@/stores/repairStore');
        useRepairStore.getState().loadRepairs();
      }
      if (tablesChanged.has('orders') || tablesChanged.has('order_lines')) {
        const { useOrderStore } = await import('@/stores/orderStore');
        useOrderStore.getState().loadOrders();
      }
      if (tablesChanged.has('purchases') || tablesChanged.has('purchase_lines')) {
        const { usePurchaseStore } = await import('@/stores/purchaseStore');
        usePurchaseStore.getState().loadPurchases();
      }
      if (tablesChanged.has('agents') || tablesChanged.has('agent_transfers')) {
        const { useAgentStore } = await import('@/stores/agentStore');
        useAgentStore.getState().loadAgents();
        useAgentStore.getState().loadTransfers();
      }
      if (tablesChanged.has('consignments')) {
        const { useConsignmentStore } = await import('@/stores/consignmentStore');
        useConsignmentStore.getState().loadConsignments();
      }
      if (tablesChanged.has('expenses')) {
        const { useExpenseStore } = await import('@/stores/expenseStore');
        useExpenseStore.getState().loadExpenses();
      }
    } catch (err) {
      console.warn('[Sync] Store reload after pull failed:', err);
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

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
// SYNC-SAFETY-A1 — der dauerhafte, an den Server gebundene Pull-Wasserstand.
import { readCursor, writeCursor, resolveCursorStart, isServerFingerprint, serverLogBehind } from './cursor-store';

const SYNC_INTERVAL = 30_000; // 30 seconds
const STORAGE_KEY_URL = 'lataif_sync_url';
const STORAGE_KEY_TOKEN = 'lataif_sync_token';
const STORAGE_KEY_LAST = 'lataif_sync_last_id';
// SYNC-SAFETY-A1 — welcher Server zuletzt geantwortet hat. Nur ein Zwischenspeicher, damit die
// naechste Anfrage gleich beim richtigen Stand beginnt; massgeblich ist die Zeile in der
// Business-DB (`cursor-store.ts`). Geht dieser Wert verloren, kostet das einen Umlauf, sonst nichts.
const STORAGE_KEY_FP = 'lataif_sync_server_fp';
/**
 * SYNC-SAFETY-A1 — der eine Zustand, den ein Benutzer sehen muss: der Pull kann nicht sicher
 * fortgesetzt werden. Das ist KEIN Netzfehler und kein Wiederholungsfall — er bleibt bei jedem
 * Lauf gleich, bis jemand ihn aufloest. Deshalb hat er einen eigenen, erkennbaren Namen.
 */
export const RECOVERY_REQUIRED = 'sync-recovery-required';

/** Der Server liegt hinter dem Stand, den dieses Geraet von ihm hat — ebenfalls ein eigener,
 *  stabiler Zustand und ausdruecklich kein Netzfehler. */
export const SERVER_LOG_BEHIND = 'sync-server-log-behind';

/** Wie der Wiederherstellungsfall: ein eigener Typ, damit ein erfolgreicher Push ihn nicht verdeckt. */
export class SyncServerBehindError extends Error {
  readonly code = SERVER_LOG_BEHIND;
  constructor(message: string) { super(message); this.name = 'SyncServerBehindError'; }
}

/** Der Pull kann nicht sicher fortgesetzt werden — als eigener Fehlertyp, damit ein erfolgreicher
 *  Push ihn nicht verdeckt und die Oberflaeche ihn von einer Stoerung unterscheiden kann. */
export class SyncRecoveryRequiredError extends Error {
  readonly code = RECOVERY_REQUIRED;
  constructor(message: string) { super(message); this.name = 'SyncRecoveryRequiredError'; }
}

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

/**
 * Die Verbindung trennen.
 *
 * SYNC-SAFETY-A1 — was hier faellt, ist die VERBINDUNG: Adresse und Token. Was NICHT faellt, ist
 * der erreichte Stand. Genau daran hing der Vorfall: Trennen loeschte den Wasserstand, das
 * naechste Verbinden begann wieder bei 0, und die gesamte Historie wurde erneut eingespielt.
 * Der dauerhafte Stand steht in der Business-DB, an den Server gebunden, und ueberlebt das
 * Trennen — verbindet man sich mit demselben Server erneut, geht es weiter, wo es aufhoerte;
 * verbindet man sich mit einem anderen, wird dessen eigener Stand benutzt (oder eben keiner).
 */
export function clearSyncConfig() {
  localStorage.removeItem(STORAGE_KEY_URL);
  localStorage.removeItem(STORAGE_KEY_TOKEN);
  localStorage.removeItem(STORAGE_KEY_LAST);
  localStorage.removeItem(STORAGE_KEY_FP);
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

  // SYNC-SAFETY-A1 — ein servergebundener Stand darf NIE in eine Anfrage gehen, bevor feststeht,
  // wer antwortet. Der gemerkte Name ist nur ein Zwischenspeicher; er kann zu einem anderen Server
  // gehoeren als dem, der jetzt unter dieser Adresse laeuft. Deshalb: fragen, den Namen aus der
  // Antwort lesen, und falls er ein anderer ist als angenommen, die Antwort VERWERFEN und mit dem
  // Stand DIESES Servers neu fragen. So kann kein fremder Stand jemals ein Fenster beschneiden.
  const db = getDatabase();
  const ask = async (since: number): Promise<{ fingerprint: string; changes: import('./durable-cursor').SyncChangeRef[]; lastSyncId: number; logHead: number }> => {
    const r = await fetch(`${url}/api/sync/pull?since=${since}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Pull failed: ${r.status}`);
    const b = await r.json();
    return {
      fingerprint: typeof b.server_fingerprint === 'string' ? b.server_fingerprint : '',
      changes: (b.changes || []) as import('./durable-cursor').SyncChangeRef[],
      lastSyncId: Number(b.last_sync_id) || 0,
      logHead: Number(b.log_head) || 0,
    };
  };

  const cachedFp = localStorage.getItem(STORAGE_KEY_FP) || '';
  const assumedCursor = isServerFingerprint(cachedFp) ? readCursor(db, cachedFp) : null;
  let asked = assumedCursor ?? 0;
  let answer = await ask(asked);

  if (isServerFingerprint(answer.fingerprint) && answer.fingerprint !== cachedFp) {
    // Ein anderer Server als angenommen. Was gerade geholt wurde, ist ab einem fremden Stand
    // geschnitten — es wird nicht benutzt. Stattdessen wird mit dem Stand gefragt, den DIESER
    // Server bei uns hat (oder ab 0, wenn wir ihn noch nicht kennen).
    const its = readCursor(db, answer.fingerprint) ?? 0;
    if (its !== asked) { asked = its; answer = await ask(asked); }
  }

  const fingerprint = answer.fingerprint;
  let { changes } = answer;
  const last_sync_id = answer.lastSyncId;

  // Der Server nennt sich. Tut er es nicht, ist er aelter als dieser Vertrag: dann bleibt alles
  // beim Alten (localStorage-Stand), damit ein gemischter Stand nicht bricht — es entsteht kein
  // dauerhafter Stand fuer einen Server, den wir nicht benennen koennen.
  let durable: { fingerprint: string; cursor: number } | null = null;
  if (isServerFingerprint(fingerprint)) {
    localStorage.setItem(STORAGE_KEY_FP, fingerprint);

    // SYNC-SAFETY-A1 — derselbe Server, aber er ist HINTER uns. Das kann kein normaler Zustand
    // sein: sein Log endet vor einem Stand, den wir von ihm haben. So sieht ein halber Restore
    // seiner Server-DB aus, oder ein Zuruecksetzen. Beide moeglichen Reaktionen waeren falsch —
    // den Stand auf sein Ende senken hiesse, alles dazwischen ein zweites Mal anzuwenden, und
    // weiterzumachen hiesse, seine kuenftigen Aenderungen zu ueberspringen. Also nichts von
    // beidem: anhalten und es sagen.
    const behind = serverLogBehind(db, fingerprint, answer.logHead);
    if (behind !== null) {
      throw new SyncServerBehindError(
        `this device recorded progress ${behind.cursor} with that server, but its change log ends at ${behind.head}`
      );
    }

    const start = resolveCursorStart(db, fingerprint, changes, last_sync_id, new Date().toISOString());
    if (start.kind === 'recovery-required') {
      // Kein gespeicherter Stand, und die Historie beginnt mit etwas, das nicht als eigener
      // Ursprung belegt ist. Weder von vorne anfangen (spielt alles erneut ein) noch ans Ende
      // springen (ueberspringt womoeglich Echtes) waere zu verantworten — also wird nichts
      // angewendet, nichts uebersprungen, und der Zustand wird benannt statt als Netzfehler
      // ausgegeben.
      // Geworfen, nicht zurueckgegeben: ein erfolgreicher Push darf einen blockierten Pull nicht
      // als 'Synced' erscheinen lassen.
      throw new SyncRecoveryRequiredError(`no recorded progress for this server, and its history does not start with changes this database provably pushed itself`);
    }
    if (start.kind === 'reconstructed') {
      console.warn(`[Sync] the first ${start.ownPrefix} changes were pushed by this database itself — progress set to ${start.cursor} instead of replaying them`);
    }
    // SYNC-SAFETY-A1-F1 — ein Stand, den dieser Lauf ERST ANGELEGT hat, muss auf die Platte,
    // bevor der Lauf sich als erfolgreich meldet. Sonst lebt er nur im Speicher: die
    // Business-Datenbank wird als Ganzes gespeichert, und ohne einen Save waere die Zeile beim
    // naechsten Start wieder weg. Das ist kein Schoenheitsfehler — "kein Stand" bedeutet etwas
    // anderes als "bewiesener Stand 0": beim naechsten Start koennte der Server inzwischen
    // Historie haben, und dann entscheidet genau diese Zeile ueber Weitermachen statt Nachfragen.
    //
    // Der Weg mit Aenderungen braucht das nicht: dort schreibt der Apply den Stand in derselben
    // Transaktion, und `commitPulledBatch` speichert durabel, BEVOR es Erfolg meldet.
    if (start.kind === 'fresh' || start.kind === 'reconstructed') {
      await saveDatabaseDurably();
    }
    durable = { fingerprint, cursor: start.cursor };
    // Was schon angewendet wurde, wird nicht erneut angewendet — unabhaengig davon, ab wo der
    // Server geantwortet hat.
    changes = changes.filter((c) => Number(c.id ?? 0) > start.cursor);
  }

  if (changes.length === 0) {
    // Nichts anzuwenden, aber der Server hat weitergezaehlt (nur Control-Plane-Zeilen im Fenster):
    // dann darf der Stand trotzdem mit — sonst wird dasselbe Fenster ewig neu geholt.
    if (durable && Number(last_sync_id) > durable.cursor) {
      writeCursor(db, durable.fingerprint, Number(last_sync_id), new Date().toISOString());
      await saveDatabaseDurably();
      localStorage.setItem(STORAGE_KEY_LAST, String(last_sync_id));
    }
    return 0;
  }

  // Apply remote changes to local DB
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
        // SYNC-SAFETY-A1 — der Stand wird IN dieser Transaktion fortgeschrieben, unmittelbar vor
        // dem COMMIT. Damit teilen Anwenden und Fortschritt ein Schicksal: ein Rollback verwirft
        // beides, und es kann keinen dauerhaften Stand geben, hinter dem keine Daten stehen.
        // `writeCursor` geht nie rueckwaerts — ein kleineres Fenster senkt den Stand nicht.
        commit: () => {
          if (durable) writeCursor(db, durable.fingerprint, Number(last_sync_id), new Date().toISOString());
          db.run('COMMIT');
        },
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
      // SYNC-SAFETY-A1 — der Wiederherstellungsfall bekommt seinen eigenen, stabilen Namen; jede
      // andere Stoerung (auch ein Apply-Konflikt mit Change-Id, Tabelle und Datensatz) meldet sich
      // weiterhin im Klartext. Beides ist ausdruecklich KEIN 'Synced'.
      setStatus('error', err instanceof SyncRecoveryRequiredError ? RECOVERY_REQUIRED
        : err instanceof SyncServerBehindError ? SERVER_LOG_BEHIND : String(err));
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

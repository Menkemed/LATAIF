import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Sidebar } from '@/components/layout/Sidebar';
import { Dashboard } from '@/pages/dashboard/Dashboard';
import { CustomerList } from '@/pages/customers/CustomerList';
import { CustomerDetail } from '@/pages/customers/CustomerDetail';
import { WatchList } from '@/pages/watches/WatchList';
import { ProductDetail } from '@/pages/watches/ProductDetail';
import { OfferList } from '@/pages/offers/OfferList';
import { OfferDetail } from '@/pages/offers/OfferDetail';
import { InvoiceList } from '@/pages/invoices/InvoiceList';
import { InvoiceCreate } from '@/pages/invoices/InvoiceCreate';
import { InvoiceDetail } from '@/pages/invoices/InvoiceDetail';
import { RepairList } from '@/pages/repairs/RepairList';
import { RepairDetail } from '@/pages/repairs/RepairDetail';
import { RepairFlowTestPage } from '@/pages/admin/RepairFlowTestPage';
import { RepairReconcilePage } from '@/pages/admin/RepairReconcilePage';
import { ScrapTradeList } from '@/pages/scrap-trades/ScrapTradeList';
import { ScrapTradeNew } from '@/pages/scrap-trades/ScrapTradeNew';
import { ScrapTradeDetail } from '@/pages/scrap-trades/ScrapTradeDetail';
import { ConsignmentList } from '@/pages/consignments/ConsignmentList';
import { ConsignmentDetail } from '@/pages/consignments/ConsignmentDetail';
import { ConsignorDetail } from '@/pages/consignors/ConsignorDetail';
import { AgentList } from '@/pages/agents/AgentList';
import { AgentDetail } from '@/pages/agents/AgentDetail';
import { TransferDetail } from '@/pages/agents/TransferDetail';
import { MetalList } from '@/pages/metals/MetalList';
import { OrderList } from '@/pages/orders/OrderList';
import { OrderCreate } from '@/pages/orders/OrderCreate';
import { OrderDetail } from '@/pages/orders/OrderDetail';
import { DocumentList } from '@/pages/documents/DocumentList';
import { TaskList } from '@/pages/tasks/TaskList';
import { AnalyticsPage } from '@/pages/analytics/AnalyticsPage';
import { DebtsPage } from '@/pages/debts/DebtsPage';
import { ReceivablesPage } from '@/pages/receivables/ReceivablesPage';
import { EmployeeList } from '@/pages/employees/EmployeeList';
import { EmployeeDetail } from '@/pages/employees/EmployeeDetail';
import { AIPage } from '@/pages/ai/AIPage';
import { CreditNoteList } from '@/pages/credit-notes/CreditNoteList';
import { CreditNoteDetail } from '@/pages/credit-notes/CreditNoteDetail';
import { SupplierList } from '@/pages/suppliers/SupplierList';
import { SupplierDetail } from '@/pages/suppliers/SupplierDetail';
import { ExpenseList } from '@/pages/expenses/ExpenseList';
import { PayablesPage } from '@/pages/payables/PayablesPage';
import { PurchaseList } from '@/pages/purchases/PurchaseList';
import { PurchaseCreate } from '@/pages/purchases/PurchaseCreate';
import { PurchaseDetail } from '@/pages/purchases/PurchaseDetail';
import { BankingPage } from '@/pages/banking/BankingPage';
import { PartnersPage } from '@/pages/partners/PartnersPage';
import { ProductionPage } from '@/pages/production/ProductionPage';
import { ProductionDetail } from '@/pages/production/ProductionDetail';
import { BusinessReportsPage } from '@/pages/reports/BusinessReportsPage';
import { ReconciliationPage } from '@/pages/reports/ReconciliationPage';
import { BackfillPage } from '@/pages/reports/BackfillPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { OnboardingPage } from '@/pages/auth/OnboardingPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { ImportPage } from '@/pages/settings/ImportPage';
import { LedgerDebugPage } from '@/pages/settings/LedgerDebugPage';
import { GlobalSearch } from '@/components/shared/GlobalSearch';
import { UpdateBanner } from '@/components/shared/UpdateBanner';
import { ErrorBoundary } from '@/components/shared/ErrorBoundary';
import { SyncDuplicateGuard } from '@/components/sync/SyncDuplicateGuard';
import { initDatabase, flushDatabase, flushDatabaseSync, saveDatabaseDurably } from '@/core/db/database';
import { prepareAndCloseApplication, createSingleFlight, type CloseStatus } from '@/core/lifecycle/close-orchestration';
import { prepareAndReloadApplication, createSingleFlight as createReloadSingleFlight, type ReloadStatus } from '@/core/lifecycle/reload-orchestration';
import { useAuthStore } from '@/stores/authStore';
import { initAutomation } from '@/core/automation/automation-handlers';

let automationsRegistered = false;

// M5-B — Event-Name der nativen WebView2-Reload-Bruecke. MUSS exakt mit src-tauri/src/lib.rs
// (NATIVE_RELOAD_EVENT) uebereinstimmen: die native Bruecke unterdrueckt F5/Ctrl+R und sendet
// dieses Event, woraufhin wir hier den durablen Save-vor-Reload-Flow fahren.
const NATIVE_RELOAD_EVENT = 'm5-native-reload-requested';

// M4-A/M5 — Overlay für den kontrollierten App-Close ODER Reload: erst "Saving data…", bei
// Persistenzfehler eine sichtbare Fehlermeldung (App bleibt offen). Der Retry-Hinweis ist
// mode-spezifisch, damit ein Reload-Fehler nicht "close again" sagt.
function CloseOverlay({ status, mode = 'close' }: { status: CloseStatus | null; mode?: 'close' | 'reload' }) {
  if (!status) return null;
  const isError = status.kind === 'error';
  const retryHint = mode === 'reload'
    ? 'The app stays open. Please try reloading again.'
    : 'The app stays open. Please close again to retry.';
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: 'rgba(15,15,16,0.72)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} role="status" aria-live="assertive">
      <div style={{
        background: '#1A1A1F', color: '#FFFFFF', border: '1px solid ' + (isError ? 'rgba(220,38,38,0.5)' : '#2A2A30'),
        borderRadius: 12, padding: '22px 26px', minWidth: 320, maxWidth: 440,
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)', textAlign: 'center',
      }}>
        {isError ? (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#DC2626', marginBottom: 8 }}>Save failed</div>
            <div style={{ fontSize: 12, color: '#B8B8C0', marginBottom: 6 }}>{status.message.slice(0, 200)}</div>
            <div style={{ fontSize: 12, color: '#8E8E97' }}>{retryHint}</div>
          </>
        ) : (
          <div style={{ fontSize: 14, color: '#FFFFFF' }}>Saving data. Please wait …</div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [closeStatus, setCloseStatus] = useState<CloseStatus | null>(null); // M4-A: App-Close-Overlay
  const [reloadStatus, setReloadStatus] = useState<ReloadStatus | null>(null); // M5: Reload-Overlay
  const { session, initialize } = useAuthStore();

  useEffect(() => {
    initDatabase()
      .then(async () => {
        setDbReady(true);
        // Check if onboarding is needed (Tauri fresh install)
        try {
          const { getDatabase: getDb } = await import('@/core/db/database');
          const db = getDb();
          const r1 = db.exec("SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'onboarding.done'");
          const r2 = db.exec("SELECT value FROM settings WHERE branch_id = 'branch-main' AND key = 'company.name'");
          const companyName = r2.length > 0 && r2[0].values.length > 0 ? r2[0].values[0][0] as string : '';
          if ((r1.length === 0 || r1[0].values.length === 0) && !companyName) {
            setNeedsOnboarding(true);
          }
        } catch { /* ignore */ }
        initialize();
        if (!automationsRegistered) {
          initAutomation();
          // Auto-configure LAN sync on Tauri desktop (become server if first, else client)
          import('@/core/sync/auto-lan').then(lan => { lan.autoLanSetup().catch(() => {}); });
          // Start sync if already configured (after manual setup or re-open)
          import('@/core/sync/sync-service').then(sync => {
            if (sync.isSyncConfigured()) sync.startAutoSync();
          });
          automationsRegistered = true;
        }
      })
      .catch(err => { console.error('DB init failed:', err); setDbError(String(err)); });
  }, [initialize]);

  // Persistence-Flush vor App-Close. Ohne diesen Hook kann der OS-Kill
  // einen pending writeFile abschneiden und der letzte saveDatabase()-Call
  // ist dann nie auf der Platte gelandet.
  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

    if (isTauri) {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      // M4-A/M4-A1 — kontrollierter Close via prepareAndCloseApplication. Single-Flight (Regel C)
      // einmal binden: mehrere X-Klicks teilen denselben Lauf. Reihenfolge: Status → UI-Turn →
      // Sync pausieren → laufenden Sync abwarten → durabler Flush → Window-Close. Bei Sync-Warte-
      // oder Persistenzfehler KEIN Close, KEIN Hard-Exit — App bleibt offen, Fehler sichtbar,
      // Sync wird kontrolliert wieder freigegeben, Retry moeglich (Regeln A/B).
      const runClose = createSingleFlight(async () => {
        const winMod = await import('@tauri-apps/api/window');
        const win = winMod.getCurrentWindow();
        const sync = await import('@/core/sync/sync-service');
        await prepareAndCloseApplication({
          setStatus: (s) => setCloseStatus(s),
          // Regel E: dem UI einen Event-Loop-Turn geben, damit das Save-Overlay erscheint, BEVOR
          // der (potenziell blockierende) db.export()/Flush startet. Bewusst setTimeout(0) statt
          // requestAnimationFrame: rAF feuert bei minimiertem/verstecktem Fenster (document.hidden)
          // nicht — ein Close darf dann NICHT haengen. setTimeout(0) laeuft als Macrotask nach dem
          // (auto-gebatchten) React-Commit → das Overlay ist gerendert.
          yieldToRender: () => new Promise<void>((r) => setTimeout(r, 0)),
          // Regel D: neue Sync-Laeufe (Timer UND manuell) pausieren — Lifecycle-Vertrag in
          // sync-service; M2-Batch-/Durable-Save-/Cursor-Semantik bleibt unangetastet.
          stopBackgroundWrites: () => sync.pauseAutoSync(),
          // Auf einen BEREITS laufenden syncNow() warten, damit dessen DB-Writes im finalen Flush
          // landen (er schliesst alle Writes + Store-Reloads vor der Promise-Aufloesung ab).
          waitForPendingOperations: () => sync.waitForSyncIdle(),
          // Persistenzbarriere: schliesst alle angeforderten Writes ab und WIRFT bei Fehler
          // (kein Schlucken mehr wie im alten 1,5s-Best-Effort-Pfad).
          flushPendingDatabaseWrites: () => flushDatabase(),
          // Nur nach bestaetigter Persistenz. destroy() kann in Tauri v2 haengen → ein gebundener
          // Hard-Exit NACH sicherem Flush ist unbedenklich (die Daten sind bereits auf der Platte).
          closeWindow: async () => {
            win.destroy().catch((err) => console.warn('[App] destroy failed:', err));
            setTimeout(async () => {
              try { const proc = await import('@tauri-apps/plugin-process'); await proc.exit(0); } catch { /* */ }
            }, 2000);
          },
          // Bei Fehler: Pause aufheben + genau EIN Auto-Sync-Timer wieder starten; App bleibt offen.
          resumeBackgroundWrites: () => sync.resumeAutoSync(),
        });
      });
      import('@tauri-apps/api/window').then(async (mod) => {
        if (cancelled) return;
        const win = mod.getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          event.preventDefault(); // wir kontrollieren den Close selbst
          try {
            await runClose();
          } catch (err) {
            // Fehler ist bereits als closeStatus 'error' sichtbar; App bleibt offen (kein Hard-Exit).
            console.warn('[App] close aborted (persist failed):', err instanceof Error ? err.message : String(err));
          }
        });
      });
      return () => { cancelled = true; if (unlisten) unlisten(); };
    }

    // Browser-Fallback: beforeunload + pagehide. Async laeuft hier nicht durch,
    // also synchroner localStorage-Flush.
    const handler = () => { flushDatabaseSync(); };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, []);

  // M5 / M5-B — Reload/Refresh-Persistenz. Ein nativer Reload (F5 / Ctrl+R) im Tauri-Webview wuerde
  // pending In-Memory-Aenderungen (z.B. gerade gesyncte Uploads) verlieren: initDatabase() liest die
  // DB-Datei neu von der Platte, und flushDatabaseSync() ist unter Tauri ein No-op (beforeunload kann
  // keinen async Save abwarten). Ein reiner JS-keydown-Interceptor griff hier NICHT — WebView2 feuert
  // den Reload-Accelerator nativ, bevor/statt der DOM-keydown das Frontend erreicht; preventDefault()
  // bleibt wirkungslos (empirisch belegt, M5-A1). Deshalb M5-B: die native WebView2-Bruecke (src-tauri)
  // unterdrueckt F5/Ctrl+R synchron auf COM-Ebene (AcceleratorKeyPressed → SetHandled(true)) und meldet
  // den Reload-Wunsch als Tauri-Event. HIER hoeren wir genau dieses Event ab und fahren den durablen
  // Save-vor-Reload-Flow. Nur unter Tauri (im Browser-Dev bleibt F5 der normale HMR-Reload). Der
  // Listener wird frueh — vor Login/Onboarding/Loading — registriert, damit er auf allen Screens greift.
  useEffect(() => {
    const isTauri = !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // Single-Flight (produktiver Helper) einmal binden: schnelle Doppel-F5 starten keine zweite Kette.
    const runReload = createReloadSingleFlight(async () => {
      const sync = await import('@/core/sync/sync-service');
      await prepareAndReloadApplication({
        setStatus: (s) => setReloadStatus(s),
        // Regel E: ein Event-Loop-Turn, damit das Save-Overlay erscheint (setTimeout(0), nicht rAF
        // — rAF feuert bei verstecktem Fenster nicht).
        yieldToRender: () => new Promise<void>((r) => setTimeout(r, 0)),
        pauseBackgroundWrites: () => sync.pauseAutoSync(),         // M4-A1: neue Sync-Laeufe pausieren
        waitForPendingOperations: () => sync.waitForSyncIdle(),    // laufenden Sync abwarten
        durableSave: saveDatabaseDurably,                          // M2: frischer db.export + persist, wirft bei Fehler/aktiver Tx
        reloadApplication: () => window.location.reload(),         // nur nach bestaetigter Persistenz
        resumeBackgroundWrites: () => sync.resumeAutoSync(),       // bei Fehler: Sync wieder freigeben
      });
    });
    // Die native Bruecke sendet dieses Event, NACHDEM sie den nativen Reload unterdrueckt hat.
    import('@tauri-apps/api/event').then(async (mod) => {
      if (cancelled) return;
      unlisten = await mod.listen(NATIVE_RELOAD_EVENT, () => {
        runReload().catch((err) => {
          // Fehler ist bereits als reloadStatus 'error' sichtbar; App bleibt offen (KEIN Reload).
          console.warn('[App] reload aborted (persist failed):', err instanceof Error ? err.message : String(err));
        });
      });
    });
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  // Recurring-Expense Generator: catch-up bei jedem Session-Wechsel / App-Start.
  // Laeuft erst nachdem session vorliegt (currentBranchId greift auf Session zu).
  useEffect(() => {
    if (!dbReady || !session) return;
    import('@/stores/recurringExpenseStore').then(m => {
      try { m.useRecurringExpenseStore.getState().runDueGenerator(); }
      catch (e) { console.warn('[recurring-expense] startup generator failed:', e); }
    });
  }, [dbReady, session?.branchId]);

  if (!dbReady) {
    return (
      <div className="flex items-center justify-center" style={{ height: '100vh', width: '100vw', background: '#F2F7FA' }}>
        <div className="text-center">
          <h1 className="font-display gold-gradient" style={{ fontSize: 28, letterSpacing: '0.25em', marginBottom: 16 }}>LATAIF</h1>
          {dbError ? (
            <p style={{ color: '#AA6E6E', fontSize: 13, marginTop: 16, maxWidth: 400 }}>{dbError}</p>
          ) : (
            <div className="animate-shimmer" style={{ width: 120, height: 1, margin: '0 auto', borderRadius: 1 }} />
          )}
        </div>
      </div>
    );
  }

  if (needsOnboarding) return <OnboardingPage onComplete={() => setNeedsOnboarding(false)} />;
  if (!session) return <LoginPage />;

  return (
    <BrowserRouter>
      <div className="app-layout" style={{ background: '#F2F7FA' }}>
        <CloseOverlay status={closeStatus ?? reloadStatus} mode={closeStatus ? 'close' : 'reload'} />
        <GlobalSearch />
        <UpdateBanner />
        <SyncDuplicateGuard />
        <Sidebar />
        <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/clients" element={<CustomerList />} />
          <Route path="/clients/:id" element={<CustomerDetail />} />
          <Route path="/collection" element={<WatchList />} />
          <Route path="/collection/:id" element={<ProductDetail />} />
          <Route path="/offers" element={<OfferList />} />
          <Route path="/offers/:id" element={<OfferDetail />} />
          <Route path="/invoices" element={<InvoiceList />} />
          <Route path="/invoices/new" element={<InvoiceCreate />} />
          <Route path="/invoices/:id/edit" element={<InvoiceCreate />} />
          <Route path="/invoices/:id" element={<InvoiceDetail />} />
          <Route path="/repairs" element={<RepairList />} />
          <Route path="/repairs/:id" element={<RepairDetail />} />
          <Route path="/admin/repair-flow-test" element={<RepairFlowTestPage />} />
          <Route path="/admin/reconcile" element={<RepairReconcilePage />} />
          <Route path="/scrap-trades" element={<ScrapTradeList />} />
          <Route path="/scrap-trades/new" element={<ScrapTradeNew />} />
          <Route path="/scrap-trades/:id" element={<ScrapTradeDetail />} />
          <Route path="/consignments" element={<ConsignmentList />} />
          <Route path="/consignments/:id" element={<ConsignmentDetail />} />
          <Route path="/consignors/:id" element={<ConsignorDetail />} />
          <Route path="/agents" element={<AgentList />} />
          <Route path="/agents/:id" element={<AgentDetail />} />
          <Route path="/transfers/:id" element={<TransferDetail />} />
          <Route path="/metals" element={<MetalList />} />
          <Route path="/orders" element={<OrderList />} />
          <Route path="/orders/new" element={<OrderCreate />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/documents" element={<DocumentList />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/debts" element={<DebtsPage />} />
          <Route path="/receivables" element={<ReceivablesPage />} />
          <Route path="/employees" element={<EmployeeList />} />
          <Route path="/employees/:id" element={<EmployeeDetail />} />
          <Route path="/suppliers" element={<SupplierList />} />
          <Route path="/suppliers/:id" element={<SupplierDetail />} />
          <Route path="/purchases" element={<PurchaseList />} />
          <Route path="/purchases/new" element={<PurchaseCreate />} />
          <Route path="/purchases/:id" element={<PurchaseDetail />} />
          <Route path="/expenses" element={<ExpenseList />} />
          <Route path="/payables" element={<PayablesPage />} />
          <Route path="/banking" element={<BankingPage />} />
          <Route path="/partners" element={<PartnersPage />} />
          <Route path="/production" element={<ProductionPage />} />
          <Route path="/production/:id" element={<ProductionDetail />} />
          <Route path="/business-reports" element={<BusinessReportsPage />} />
          <Route path="/reconciliation" element={<ReconciliationPage />} />
          <Route path="/ledger-backfill" element={<BackfillPage />} />
          <Route path="/credit-notes" element={<CreditNoteList />} />
          <Route path="/credit-notes/:id" element={<CreditNoteDetail />} />
          <Route path="/ai" element={<AIPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/ledger-debug" element={<LedgerDebugPage />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </BrowserRouter>
  );
}

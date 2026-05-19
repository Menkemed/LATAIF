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
import { initDatabase, flushDatabase, flushDatabaseSync } from '@/core/db/database';
import { useAuthStore } from '@/stores/authStore';
import { initAutomation } from '@/core/automation/automation-handlers';

let automationsRegistered = false;

export default function App() {
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
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
      let closing = false;
      import('@tauri-apps/api/window').then(async (mod) => {
        if (cancelled) return;
        const win = mod.getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          if (closing) return;
          closing = true;
          event.preventDefault();
          // Hard-Deadline: nach 3s ist das Fenster IMMER weg, egal was passiert.
          // setTimeout setzen BEVOR async-Work startet, sonst kann ein hängender
          // flush/destroy auch den Hard-Exit blockieren — der ist im selben
          // Event-Loop-Tick wie das setTimeout, nicht innerhalb des awaits.
          const hardExitTimer = setTimeout(async () => {
            console.warn('[App] close took too long — forcing exit via plugin-process');
            try {
              const proc = await import('@tauri-apps/plugin-process');
              await proc.exit(0);
            } catch (err) { console.error('[App] hard exit failed:', err); }
          }, 3000);
          try {
            // Best-effort flush mit 1.5s-Cap.
            try {
              await Promise.race([
                flushDatabase(),
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('flush timeout')), 1500)),
              ]);
            } catch (err) { console.warn('[App] flush on close skipped:', err); }
            // Fire-and-forget destroy — nicht awaiten, weil Tauri v2 in manchen
            // States nie resolved. Wenn destroy funktioniert, ist das Fenster
            // weg bevor der Hard-Exit feuert. Wenn nicht, fängt der setTimeout es.
            win.destroy().catch(err => console.warn('[App] destroy failed:', err));
          } finally {
            clearTimeout(hardExitTimer);
            // ABER: hard-exit-Sicherheitsnetz nochmal als finaler Fallback —
            // falls destroy() weder resolved noch das Fenster zumacht. Nach
            // weiteren 1.5s gibt's keine Ausreden mehr.
            setTimeout(async () => {
              try {
                const proc = await import('@tauri-apps/plugin-process');
                await proc.exit(0);
              } catch { /* */ }
            }, 1500);
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

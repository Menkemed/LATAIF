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
import { ConsignmentList } from '@/pages/consignments/ConsignmentList';
import { ConsignmentDetail } from '@/pages/consignments/ConsignmentDetail';
import { AgentList } from '@/pages/agents/AgentList';
import { MetalList } from '@/pages/metals/MetalList';
import { OrderList } from '@/pages/orders/OrderList';
import { OrderCreate } from '@/pages/orders/OrderCreate';
import { OrderDetail } from '@/pages/orders/OrderDetail';
import { DocumentList } from '@/pages/documents/DocumentList';
import { TaskList } from '@/pages/tasks/TaskList';
import { AnalyticsPage } from '@/pages/analytics/AnalyticsPage';
import { DebtsPage } from '@/pages/debts/DebtsPage';
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
import { BusinessReportsPage } from '@/pages/reports/BusinessReportsPage';
import { LoginPage } from '@/pages/auth/LoginPage';
import { OnboardingPage } from '@/pages/auth/OnboardingPage';
import { SettingsPage } from '@/pages/settings/SettingsPage';
import { ImportPage } from '@/pages/settings/ImportPage';
import { GlobalSearch } from '@/components/shared/GlobalSearch';
import { UpdateBanner } from '@/components/shared/UpdateBanner';
import { initDatabase } from '@/core/db/database';
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
        <Sidebar />
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
          <Route path="/consignments" element={<ConsignmentList />} />
          <Route path="/consignments/:id" element={<ConsignmentDetail />} />
          <Route path="/agents" element={<AgentList />} />
          <Route path="/metals" element={<MetalList />} />
          <Route path="/orders" element={<OrderList />} />
          <Route path="/orders/new" element={<OrderCreate />} />
          <Route path="/orders/:id" element={<OrderDetail />} />
          <Route path="/documents" element={<DocumentList />} />
          <Route path="/tasks" element={<TaskList />} />
          <Route path="/analytics" element={<AnalyticsPage />} />
          <Route path="/debts" element={<DebtsPage />} />
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
          <Route path="/business-reports" element={<BusinessReportsPage />} />
          <Route path="/credit-notes" element={<CreditNoteList />} />
          <Route path="/credit-notes/:id" element={<CreditNoteDetail />} />
          <Route path="/ai" element={<AIPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

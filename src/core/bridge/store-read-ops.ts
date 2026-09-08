// CENTRAL-UI-PARITY — der Katalog der Store-Auskuenfte, ohne jede Nebenwirkung.
//
// Bewusst getrennt von `store-read-commands.ts`: dort werden die Operationen REGISTRIERT, und wer
// nur die Namen braucht (die Rechteabbildung, die Gates), soll das nicht ausloesen. Ein Import
// dieser Datei laedt keinen Store und meldet nichts an.

/** Ein Store, den die normale Oberflaeche braucht — und wie der Primary ihn fuellt. */
export interface StoreSource {
  /** Der Modulpfad als Funktion: dynamisch, damit kein Zyklus Store → Bruecke → Store entsteht. */
  readonly load: () => Promise<Record<string, unknown>>;
  /** Der Name des Zustandshakens im Modul (`useProductStore` …). */
  readonly hook: string;
  /** Die echten Ladefunktionen des Stores, in der Reihenfolge, in der der Primary sie ruft. */
  readonly loaders: readonly string[];
}

/**
 * Die Liste IST die Erlaubnis. Ein Name, der hier fehlt, existiert fuer das Netz nicht — genau
 * wie bei den Buchungen. Ein Store steht hier, weil die normale Oberflaeche ihn zum Anzeigen
 * braucht, nicht weil er zufaellig existiert.
 */
export const STORE_SOURCES: Readonly<Record<string, StoreSource>> = {
  'store.products.get': { load: () => import('@/stores/productStore'), hook: 'useProductStore', loaders: ['loadCategories', 'loadProducts'] },
  'store.customers.get': { load: () => import('@/stores/customerStore'), hook: 'useCustomerStore', loaders: ['loadCustomers'] },
  'store.invoices.get': { load: () => import('@/stores/invoiceStore'), hook: 'useInvoiceStore', loaders: ['loadInvoices'] },
  'store.suppliers.get': { load: () => import('@/stores/supplierStore'), hook: 'useSupplierStore', loaders: ['loadSuppliers'] },
  'store.purchases.get': { load: () => import('@/stores/purchaseStore'), hook: 'usePurchaseStore', loaders: ['loadPurchases', 'loadReturns', 'loadPurchaseInbox'] },
  'store.orders.get': { load: () => import('@/stores/orderStore'), hook: 'useOrderStore', loaders: ['loadOrders'] },
  'store.consignments.get': { load: () => import('@/stores/consignmentStore'), hook: 'useConsignmentStore', loaders: ['loadConsignments'] },
  'store.repairs.get': { load: () => import('@/stores/repairStore'), hook: 'useRepairStore', loaders: ['loadRepairs'] },
  'store.agents.get': { load: () => import('@/stores/agentStore'), hook: 'useAgentStore', loaders: ['loadAgents', 'loadTransfers'] },
  'store.sales_returns.get': { load: () => import('@/stores/salesReturnStore'), hook: 'useSalesReturnStore', loaders: ['loadReturns'] },
  'store.credit_notes.get': { load: () => import('@/stores/creditNoteStore'), hook: 'useCreditNoteStore', loaders: ['loadCreditNotes'] },
  'store.expenses.get': { load: () => import('@/stores/expenseStore'), hook: 'useExpenseStore', loaders: ['loadExpenses'] },
  'store.recurring_expenses.get': { load: () => import('@/stores/recurringExpenseStore'), hook: 'useRecurringExpenseStore', loaders: ['loadTemplates'] },
  'store.payables.get': { load: () => import('@/stores/payablesStore'), hook: 'usePayablesStore', loaders: ['loadPayables'] },
  'store.debts.get': { load: () => import('@/stores/debtStore'), hook: 'useDebtStore', loaders: ['loadDebts'] },
  'store.banking.get': { load: () => import('@/stores/bankingStore'), hook: 'useBankingStore', loaders: ['loadTransfers'] },
  'store.gold.get': { load: () => import('@/stores/goldStore'), hook: 'useGoldStore', loaders: ['loadAll'] },
  'store.metals.get': { load: () => import('@/stores/metalStore'), hook: 'useMetalStore', loaders: ['loadMetals'] },
  'store.scrap_trades.get': { load: () => import('@/stores/scrapTradeStore'), hook: 'useScrapTradeStore', loaders: ['loadTrades'] },
  'store.offers.get': { load: () => import('@/stores/offerStore'), hook: 'useOfferStore', loaders: ['loadOffers'] },
  'store.production.get': { load: () => import('@/stores/productionStore'), hook: 'useProductionStore', loaders: ['loadRecords'] },
  'store.partners.get': { load: () => import('@/stores/partnerStore'), hook: 'usePartnerStore', loaders: ['loadPartners', 'loadTransactions'] },
  'store.employees.get': { load: () => import('@/stores/employeeStore'), hook: 'useEmployeeStore', loaders: ['loadEmployees'] },
  'store.tasks.get': { load: () => import('@/stores/taskStore'), hook: 'useTaskStore', loaders: ['loadTasks'] },
  'store.documents.get': { load: () => import('@/stores/documentStore'), hook: 'useDocumentStore', loaders: ['loadDocuments'] },
};

// Bewusst NICHT hier: `orderPaymentStore.loadPayments(orderId)` und
// `customerMessageStore.loadMessages(customerId)` laden je EINEN Vorgang, nicht den Store. Sie
// brauchen eine Auskunft MIT Parameter; bis es die gibt, stehen sie als Luecke im Bericht.

/** Jede Store-Auskunft, die die Paritaet freischaltet — dieselbe Liste kennt auch Rust. */
export const STORE_READ_OPS: readonly string[] = Object.keys(STORE_SOURCES);

/** Der Name der Auskunft, die diesen Store fuellt — oder `null`, wenn es ihn fern nicht gibt. */
export function storeReadOp(storeKey: string): string | null {
  return storeKey in STORE_SOURCES ? storeKey : null;
}

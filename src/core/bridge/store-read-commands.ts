// CENTRAL-UI-PARITY R1 — die Auskuenfte, mit denen ein Rechner ohne Datenbank DIESELBE
// Oberflaeche fuellt wie der Primary.
//
// Der erste Wurf hatte zwei Fehler, und beide sind hier abgestellt:
//
//   1. Er rief die Ladefunktion des Primary-STORES. Damit schrieb jedes Lesen von aussen in genau
//      den Zustand, den der Mensch am Primary vor sich hat — Liste, Auswahl, Filter.
//   2. Diese Ladefunktion nahm ihre Filiale aus `currentBranchId()`, also aus der Sitzung des
//      Primary. Ein Client aus einer anderen Filiale bekam fremde Daten.
//
// Jetzt gilt: eine Auskunft ruft eine GEMEINSAME, zustandsfreie Ladefunktion — dieselbe, die auch
// der Primary fuer seine eigene Anzeige benutzt — und uebergibt ihr den Ausweis des ANFRAGENDEN.
// Der Ausweis kommt ausschliesslich aus dem bereits geprueften Absender (C4); was der Client im
// Rumpf mitschickt, ist Eingabe, niemals Autoritaet.
//
// Was dieser Weg NICHT ist: kein SQL vom Client, kein beliebiger Store- oder Methodenname, kein
// Spiegel der Datenbank, keine zweite Wahrheit. Zurueck reisen nur einfache, serialisierbare
// Daten — keine Funktionen, keine Ausweise, keine Dateipfade, keine Systemkonfiguration.

import { registerCommand, BusinessError, type CommandResult, type CommandActor } from './command-registry';
import { remoteReadContext, type BusinessReadContext } from '@/core/data/read-context';
import {
  OP_STORE_PRODUCTS_GET, OP_STORE_CUSTOMERS_GET, OP_STORE_INVOICES_GET,
  OP_ORDER_PAYMENTS_GET, OP_SESSION_CONTEXT_GET,
  OP_STORE_SUPPLIERS_GET, OP_STORE_SALES_RETURNS_GET, OP_STORE_CREDIT_NOTES_GET,
  OP_STORE_ORDERS_GET, OP_STORE_CONSIGNMENTS_GET, OP_STORE_PURCHASES_GET,
  OP_STORE_REPAIRS_GET, OP_STORE_AGENTS_GET,
  OP_STORE_EXPENSES_GET, OP_STORE_RECURRING_EXPENSES_GET, OP_STORE_BANKING_GET,
  OP_STORE_PAYABLES_GET, OP_STORE_DEBTS_GET, OP_STORE_GOLD_GET, OP_STORE_METALS_GET,
  OP_STORE_SCRAP_TRADES_GET, OP_STORE_EMPLOYEES_GET, OP_STORE_PARTNERS_GET,
  OP_STORE_TASKS_GET, OP_STORE_DOCUMENTS_GET, OP_STORE_OFFERS_GET, OP_STORE_PRODUCTION_GET,
  OP_STORE_ANALYTICS_GET, OP_ANALYTICS_VAT_EXPORT_GET, OP_DOCUMENTS_CONTENT_GET,
} from './store-read-ops';

/** Der Rumpf, den die Route baut: geprüfter Absender plus die Eingabe des Clients. */
interface Envelope {
  readonly actor?: { tenantId?: string; branchId?: string; userId?: string; role?: string };
  readonly input?: Record<string, unknown>;
}

/**
 * Der Ausweis der Anfrage. Er kommt aus dem geprueften Absender — entweder als eigener Parameter
 * (so ruft `executeCommand`) oder aus dem Umschlag, den die Route gebaut hat. Aus dem
 * Client-Rumpf kommt er NIE: `input` wird hier gar nicht erst angesehen.
 */
function contextOf(payload: unknown, actor?: CommandActor): BusinessReadContext {
  const fromEnvelope = (payload as Envelope | null)?.actor;
  return remoteReadContext(actor ?? fromEnvelope);
}

/** Die Eingabe des Clients — ausdruecklich getrennt vom Ausweis. */
function inputOf(payload: unknown): Record<string, unknown> {
  const i = (payload as Envelope | null)?.input;
  return i && typeof i === 'object' ? i : {};
}

function requiredId(payload: unknown, field: string): string {
  const v = inputOf(payload)[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new BusinessError('INPUT_REQUIRED', `${field} is required`);
  }
  return v;
}

// ── Artikel und Kategorien ──────────────────────────────────────────────────
registerCommand(OP_STORE_PRODUCTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const store = await import('@/stores/productStore');
    return { data: { ...store.loadProductsFor(ctx), ...store.loadCategoriesFor(ctx) } };
  },
});

// ── Kunden ──────────────────────────────────────────────────────────────────
registerCommand(OP_STORE_CUSTOMERS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const store = await import('@/stores/customerStore');
    return { data: store.loadCustomersFor(ctx) };
  },
});

// ── Rechnungen ──────────────────────────────────────────────────────────────
registerCommand(OP_STORE_INVOICES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const store = await import('@/stores/invoiceStore');
    return { data: store.loadInvoicesFor(ctx) };
  },
});

// ── Ein Auftrag, seine Zahlungen: der parametrisierte Weg ───────────────────
registerCommand(OP_ORDER_PAYMENTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const orderId = requiredId(payload, 'orderId');
    const store = await import('@/stores/orderPaymentStore');
    // Die Filiale steckt im Loader mit in der Abfrage: eine fremde Auftragskennung liefert nichts.
    return { data: store.loadOrderPaymentsFor(ctx, orderId) };
  },
});

// ── Sitzungskontext: Filiale, Name, Waehrung ───────────────────────────────
registerCommand(OP_SESSION_CONTEXT_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const { query } = await import('@/core/db/helpers');
    const rows = query('SELECT id, name, country, currency FROM branches WHERE id = ?', [ctx.branchId]);
    const b = rows[0];
    if (!b) throw new BusinessError('BRANCH_NOT_FOUND', 'the authenticated branch does not exist');
    return {
      data: {
        branch: { id: String(b.id), name: String(b.name ?? ''), country: String(b.country ?? ''), currency: String(b.currency ?? '') },
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: ctx.role,
      },
    };
  },
});

// ── CENTRAL-UI-PARITY R2A — die uebrigen Kernflaechen ──────────────────────
//
// Alle nach demselben Schnitt: Ausweis aus dem geprueften Absender, gemeinsame Ladefunktion,
// einfache Daten zurueck. Kein Store wird angefasst, keine Abfrage nachgebaut.

registerCommand(OP_STORE_SUPPLIERS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/supplierStore')).loadSuppliersFor(ctx) };
  },
});

registerCommand(OP_STORE_SALES_RETURNS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/salesReturnStore')).loadSalesReturnsFor(ctx) };
  },
});

registerCommand(OP_STORE_CREDIT_NOTES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/creditNoteStore')).loadCreditNotesFor(ctx) };
  },
});

registerCommand(OP_STORE_ORDERS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/orderStore')).loadOrdersFor(ctx) };
  },
});

registerCommand(OP_STORE_CONSIGNMENTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/consignmentStore')).loadConsignmentsFor(ctx) };
  },
});

registerCommand(OP_STORE_PURCHASES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const s = await import('@/stores/purchaseStore');
    // Eine Seite, drei Bestaende: Einkaeufe, offener Wareneingang, Retouren.
    return { data: { ...s.loadPurchasesFor(ctx), ...s.loadPurchaseInboxFor(ctx), ...s.loadPurchaseReturnsFor(ctx) } };
  },
});

registerCommand(OP_STORE_REPAIRS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const s = await import('@/stores/repairStore');
    return { data: { ...s.loadRepairsFor(ctx), ...s.loadRepairLinesFor(ctx) } };
  },
});

registerCommand(OP_STORE_AGENTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const s = await import('@/stores/agentStore');
    return { data: { ...s.loadAgentsFor(ctx), ...s.loadAgentTransfersFor(ctx) } };
  },
});

// ── CENTRAL-UI-PARITY R2B — Finanzen ───────────────────────────────────────
//
// Derselbe Schnitt wie oben. Was diese Gruppe zusaetzlich zeigt: eine Auswahl ist keine
// Berechtigung. Zeitraum, Kategorie, Status und Gruppierung schraenken eine Liste ein — die
// Filiale und der Mandant kommen ausschliesslich aus dem geprueften Absender und stehen in
// JEDER Abfrage. Zwei Listen hatten diese Grenze bisher gar nicht (Verbindlichkeiten,
// Altgold-Geschaefte); sie haben sie jetzt.

registerCommand(OP_STORE_EXPENSES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/expenseStore')).loadExpensesFor(ctx) };
  },
});

registerCommand(OP_STORE_RECURRING_EXPENSES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/recurringExpenseStore')).loadRecurringTemplatesFor(ctx) };
  },
});

registerCommand(OP_STORE_BANKING_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    // Umbuchungen UND die abgeleitete Bewegungsliste: ohne Datenbank laesst sich Letztere
    // drueben nicht nachrechnen.
    return { data: (await import('@/stores/bankingStore')).loadBankingFor(ctx) };
  },
});

registerCommand(OP_STORE_PAYABLES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/payablesStore')).loadPayablesFor(ctx) };
  },
});

registerCommand(OP_STORE_DEBTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/debtStore')).loadDebtsFor(ctx) };
  },
});

registerCommand(OP_STORE_GOLD_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const s = await import('@/stores/goldStore');
    return { data: { ...s.loadGoldPayablesFor(ctx), ...s.loadCustomerGoldCreditsFor(ctx) } };
  },
});

registerCommand(OP_STORE_METALS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/metalStore')).loadMetalsFor(ctx) };
  },
});

registerCommand(OP_STORE_SCRAP_TRADES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    // Ohne den Nachtrag alter Zeilen: eine Auskunft liest, sie repariert nicht.
    return { data: (await import('@/stores/scrapTradeStore')).loadScrapTradesFor(ctx) };
  },
});

// ── CENTRAL-UI-PARITY R2B — Betriebsfuehrung ───────────────────────────────
//
// Mitarbeiter, Gesellschafter, Aufgaben, Belege, Angebote, Fertigung. Hier wird ausdruecklich
// KEINE Rollenlogik erfunden: was jemand sehen darf, hat die Reautorisierung der Anfrage bereits
// entschieden. Die Ladefunktionen kennen nur die Filiale ihres Ausweises.

registerCommand(OP_STORE_EMPLOYEES_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/employeeStore')).loadEmployeesFor(ctx) };
  },
});

registerCommand(OP_STORE_PARTNERS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const s = await import('@/stores/partnerStore');
    return { data: { ...s.loadPartnersFor(ctx), ...s.loadPartnerTransactionsFor(ctx) } };
  },
});

registerCommand(OP_STORE_TASKS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/taskStore')).loadTasksFor(ctx) };
  },
});

registerCommand(OP_STORE_DOCUMENTS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    // OHNE Dateiinhalt: in dieser Tabelle steht die ganze Datei als Data-URL. Die Liste ist die
    // Auskunft; der Inhalt bleibt dort, wo die Datenbank steht.
    return { data: (await import('@/stores/documentStore')).loadDocumentsFor(ctx, { withContent: false }) };
  },
});

registerCommand(OP_STORE_OFFERS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/offerStore')).loadOffersFor(ctx) };
  },
});

registerCommand(OP_STORE_PRODUCTION_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/stores/productionStore')).loadProductionRecordsFor(ctx) };
  },
});

// ── CENTRAL-UI-PARITY R2C — Auswertung und Belegeinhalt ────────────────────
//
// Die Auswertung ist der Grund, warum es hier EINE Auskunft gibt und nicht fünfzig: die Seite
// rechnete bisher jede Kennzahl selbst in der Datenbank. Über das Netz wären das fünfzig
// Anfragen je Seitenaufbau gewesen — und fünfzig Gelegenheiten, Zahlen aus verschiedenen
// Augenblicken nebeneinander zu zeigen. Jetzt kommt ein begrenztes Ergebnis, in einem Stück.

registerCommand(OP_STORE_ANALYTICS_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    return { data: (await import('@/core/reports/analytics-snapshot')).loadAnalyticsFor(ctx) };
  },
});

registerCommand(OP_ANALYTICS_VAT_EXPORT_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    // Zeilenweise und damit groß — deshalb steht er nicht in der Auskunft oben, sondern kommt
    // nur, wenn jemand den Knopf drückt.
    return { data: (await import('@/core/reports/analytics-snapshot')).vatExportRowsFor(ctx) };
  },
});

registerCommand(OP_DOCUMENTS_CONTENT_GET, {
  kind: 'read',
  handler: async (payload, actor): Promise<CommandResult> => {
    const ctx = contextOf(payload, actor);
    const documentId = requiredId(payload, 'documentId');
    const doc = (await import('@/stores/documentStore')).documentContentFor(ctx, documentId);
    // Ein Beleg einer fremden Filiale ist nicht „verboten", sondern schlicht nicht da — die
    // Antwort verrät damit nicht einmal, dass es ihn gibt.
    if (!doc) throw new BusinessError('DOCUMENT_NOT_FOUND', 'no such document');
    return { data: doc };
  },
});

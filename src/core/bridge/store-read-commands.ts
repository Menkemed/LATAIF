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

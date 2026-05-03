import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { Agent, AgentTransfer, AgentTransferStatus, Invoice, TaxScheme } from '@/core/models/types';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { query, currentBranchId, currentUserId, getNextNumber } from '@/core/db/helpers';
import { eventBus } from '@/core/events/event-bus';
import { trackInsert, trackUpdate, trackDelete } from '@/core/sync/track';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useCustomerStore } from '@/stores/customerStore';
import { vatEngine } from '@/core/tax/vat-engine';

interface AgentStore {
  agents: Agent[];
  transfers: AgentTransfer[];
  loading: boolean;
  loadAgents: () => void;
  loadTransfers: () => void;
  getAgent: (id: string) => Agent | undefined;
  getTransfer: (id: string) => AgentTransfer | undefined;
  createAgent: (data: Partial<Agent>) => Agent;
  updateAgent: (id: string, data: Partial<Agent>) => void;
  deleteAgent: (id: string) => void;
  createTransfer: (data: Partial<AgentTransfer>) => AgentTransfer;
  updateTransfer: (id: string, data: Partial<AgentTransfer>) => void;
  markTransferSold: (id: string, actualPrice: number, buyerInfo?: string) => void;
  markTransferReturned: (id: string) => void;
  // Plan §Agent §4: Teilzahlungen. Wenn amount < settlementAmount → status='partial'.
  markTransferSettled: (id: string, amount?: number, method?: 'cash' | 'bank') => void;
  // Plan §Agent §Convert: verkauften Transfer in eine Invoice (Forderung an Agent) umwandeln.
  // Erzeugt die Invoice mit dem gegebenen Customer, persistiert customerId auf dem Agent,
  // bindet transfer.invoiceId. Ab dann läuft die Bezahlung über die Invoice; markTransferSettled
  // wird in der UI ausgeblendet.
  convertTransferToInvoice: (transferId: string, customerId: string) => Invoice;
  // Plan §Agent §Convert §Undo: Convert rückgängig machen. Erlaubt nur solange
  // die Invoice noch nicht (teilweise) bezahlt wurde — sonst Doppelbuchung.
  undoTransferInvoiceConvert: (transferId: string) => void;
  // Plan §8 #5 — Audit-Trail der Settlement-Zahlungen.
  getSettlementPayments: (transferId: string) => Array<{ id: string; amount: number; method: string; paidAt: string; note?: string }>;
  deleteTransfer: (id: string) => void;
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string, name: row.name as string,
    company: row.company as string | undefined,
    phone: row.phone as string | undefined, whatsapp: row.whatsapp as string | undefined,
    email: row.email as string | undefined,
    commissionRate: (row.commission_rate as number) || 10,
    active: row.active === 1, notes: row.notes as string | undefined,
    totalSales: (row.total_sales as number) || 0,
    totalCommission: (row.total_commission as number) || 0,
    customerId: (row.customer_id as string | null) || undefined,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
  };
}

function rowToTransfer(row: Record<string, unknown>): AgentTransfer {
  return {
    id: row.id as string, transferNumber: row.transfer_number as string,
    agentId: row.agent_id as string, productId: row.product_id as string,
    agentPrice: (row.agent_price as number) || 0,
    minimumPrice: row.minimum_price as number | undefined,
    commissionRate: (row.commission_rate as number) || 10,
    commissionType: (row.commission_type as 'percent' | 'fixed' | undefined) || 'percent',
    commissionValue: row.commission_value as number | undefined,
    commissionPaidFrom: (row.commission_paid_from as 'cash' | 'bank' | null) ?? null,
    commissionAmount: row.commission_amount as number | undefined,
    status: (row.status as AgentTransferStatus) || 'transferred',
    transferredAt: row.transferred_at as string,
    returnBy: row.return_by as string | undefined,
    soldAt: row.sold_at as string | undefined,
    returnedAt: row.returned_at as string | undefined,
    settledAt: row.settled_at as string | undefined,
    actualSalePrice: row.actual_sale_price as number | undefined,
    buyerInfo: row.buyer_info as string | undefined,
    invoiceId: row.invoice_id as string | undefined,
    settlementAmount: row.settlement_amount as number | undefined,
    settlementPaidAmount: (row.settlement_paid_amount as number | undefined) ?? 0,
    settlementStatus: (row.settlement_status as AgentTransfer['settlementStatus']) || 'pending',
    notes: row.notes as string | undefined,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    createdBy: row.created_by as string | undefined,
  };
}

export const useAgentStore = create<AgentStore>((set, get) => ({
  agents: [], transfers: [], loading: false,

  loadAgents: () => {
    try {
      const rows = query('SELECT * FROM agents WHERE branch_id = ? ORDER BY name', [currentBranchId()]);
      set({ agents: rows.map(rowToAgent) });
    } catch { set({ agents: [] }); }
  },

  loadTransfers: () => {
    try {
      const rows = query('SELECT * FROM agent_transfers WHERE branch_id = ? ORDER BY created_at DESC', [currentBranchId()]);
      set({ transfers: rows.map(rowToTransfer), loading: false });
    } catch { set({ transfers: [], loading: false }); }
  },

  getAgent: (id) => get().agents.find(a => a.id === id),
  getTransfer: (id) => get().transfers.find(t => t.id === id),

  createAgent: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string;
    try { branchId = currentBranchId(); } catch { branchId = 'branch-main'; }

    db.run(
      `INSERT INTO agents (id, branch_id, name, company, phone, whatsapp, email, commission_rate, active, notes, customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, branchId, data.name || '', data.company || null, data.phone || null,
       data.whatsapp || null, data.email || null, data.commissionRate || 10,
       data.notes || null, data.customerId || null, now, now]
    );
    saveDatabase();
    trackInsert('agents', id, { name: data.name });
    eventBus.emit('agent.created', 'agent', id, { name: data.name });
    get().loadAgents();
    return get().getAgent(id)!;
  },

  updateAgent: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      name: 'name', company: 'company', phone: 'phone', whatsapp: 'whatsapp',
      email: 'email', commissionRate: 'commission_rate', notes: 'notes',
      totalSales: 'total_sales', totalCommission: 'total_commission',
      customerId: 'customer_id',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (data.active !== undefined) { fields.push('active = ?'); values.push(data.active ? 1 : 0); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('agents', id, data);
    get().loadAgents();
  },

  deleteAgent: (id) => {
    const db = getDatabase();
    db.run(`DELETE FROM agents WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('agents', id);
    get().loadAgents();
  },

  createTransfer: (data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    let branchId: string, userId: string;
    try { branchId = currentBranchId(); userId = currentUserId(); }
    catch { branchId = 'branch-main'; userId = 'user-owner'; }

    const transferNumber = getNextNumber('agent_transfers', 'transfer.number_prefix', 'TRF');

    // Update product status
    if (data.productId) {
      // Plan §Product §5: source_type = AGENT während Transfer
      db.run(`UPDATE products SET stock_status = 'with_agent', source_type = 'AGENT', updated_at = ? WHERE id = ?`, [now, data.productId]);
    }

    db.run(
      `INSERT INTO agent_transfers (id, branch_id, transfer_number, agent_id, product_id,
        agent_price, minimum_price, commission_rate, commission_type, commission_value,
        status, transferred_at, return_by,
        notes, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'transferred', ?, ?, ?, ?, ?, ?)`,
      [id, branchId, transferNumber, data.agentId, data.productId,
       data.agentPrice || 0, data.minimumPrice || null, data.commissionRate || 10,
       data.commissionType || 'percent', data.commissionValue ?? null,
       now, data.returnBy || null, data.notes || null, now, now, userId]
    );
    saveDatabase();
    trackInsert('agent_transfers', id, { agentId: data.agentId, productId: data.productId });
    eventBus.emit('agent_transfer.created', 'agent_transfer', id, { agentId: data.agentId, productId: data.productId });
    get().loadTransfers();
    return get().getTransfer(id)!;
  },

  updateTransfer: (id, data) => {
    const db = getDatabase();
    const now = new Date().toISOString();
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      agentPrice: 'agent_price', minimumPrice: 'minimum_price', commissionRate: 'commission_rate',
      commissionType: 'commission_type', commissionValue: 'commission_value',
      commissionPaidFrom: 'commission_paid_from',
      status: 'status', returnBy: 'return_by', actualSalePrice: 'actual_sale_price',
      buyerInfo: 'buyer_info', commissionAmount: 'commission_amount',
      settlementAmount: 'settlement_amount',
      settlementPaidAmount: 'settlement_paid_amount',
      settlementStatus: 'settlement_status',
      notes: 'notes', soldAt: 'sold_at', returnedAt: 'returned_at', settledAt: 'settled_at',
    };
    for (const [k, v] of Object.entries(data)) {
      const col = map[k]; if (col) { fields.push(`${col} = ?`); values.push(v); }
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?'); values.push(now); values.push(id);
    db.run(`UPDATE agent_transfers SET ${fields.join(', ')} WHERE id = ?`, values);
    saveDatabase();
    trackUpdate('agent_transfers', id, data);
    get().loadTransfers();
  },

  markTransferSold: (id, actualPrice, buyerInfo) => {
    const transfer = get().getTransfer(id);
    if (!transfer) return;
    const commission = transfer.commissionType === 'fixed'
      ? (transfer.commissionValue || 0)
      : actualPrice * (transfer.commissionRate / 100);
    const settlement = actualPrice - commission;
    const now = new Date().toISOString();

    get().updateTransfer(id, {
      status: 'sold', actualSalePrice: actualPrice, buyerInfo,
      commissionAmount: commission, settlementAmount: settlement, soldAt: now,
    });

    // Update product
    const db = getDatabase();
    // Quantity-aware: dekrementiere Stück; erst wenn Bestand = 0 → stock_status='sold'.
    db.run(
      `UPDATE products SET
         quantity = CASE WHEN COALESCE(quantity,1) > 1 THEN COALESCE(quantity,1) - 1 ELSE 0 END,
         stock_status = CASE WHEN COALESCE(quantity,1) > 1 THEN stock_status ELSE 'sold' END,
         last_sale_price = ?, updated_at = ? WHERE id = ?`,
      [actualPrice, now, transfer.productId]);
    saveDatabase();
    eventBus.emit('agent_transfer.sold', 'agent_transfer', id, { actualPrice, commission });
  },

  markTransferReturned: (id) => {
    const transfer = get().getTransfer(id);
    if (!transfer) return;
    const now = new Date().toISOString();
    get().updateTransfer(id, { status: 'returned', returnedAt: now });
    const db = getDatabase();
    // Plan §Product §5: zurück zu OWN wenn Ware vom Agent zurückkommt
    db.run(`UPDATE products SET stock_status = 'in_stock', source_type = 'OWN', updated_at = ? WHERE id = ?`, [now, transfer.productId]);
    saveDatabase();
    eventBus.emit('agent_transfer.returned', 'agent_transfer', id, {});
  },

  markTransferSettled: (id, amount, method) => {
    if (typeof amount === 'number' && (!Number.isFinite(amount) || amount < 0)) {
      throw new Error('Settlement amount must be non-negative.');
    }
    const t = get().getTransfer(id);
    if (!t) return;
    const db = getDatabase();
    const now = new Date().toISOString();
    const total = t.settlementAmount || 0;
    const prevPaid = t.settlementPaidAmount || 0;
    // Plan §Agent §4: wenn amount nicht angegeben → voll ausbuchen
    const paidNow = typeof amount === 'number' && amount > 0 ? amount : Math.max(0, total - prevPaid);
    const newPaid = Math.min(total, prevPaid + paidNow);
    const isFull = newPaid >= total - 0.005;

    // Plan §Agent §Settle+Invoice (User-Spec): Wenn der Transfer schon eine
    // Invoice hat, läuft die Bezahlung exklusiv über die Invoice — sonst
    // doppelte Banking-Buchung. Settle-Klick wird zur Invoice-Payment.
    if (t.invoiceId && paidNow > 0) {
      const inv = useInvoiceStore.getState();
      const invoice = inv.invoices.find(i => i.id === t.invoiceId);
      if (invoice) {
        // method: 'cash'/'bank' → Invoice nutzt 'cash'/'bank_transfer' Convention.
        const invMethod = method === 'bank' ? 'bank_transfer' : (method || 'cash');
        inv.recordPayment(t.invoiceId, paidNow, invMethod, isFull ? 'Final settlement (from Agent)' : 'Partial settlement (from Agent)');
      }
    } else if (paidNow > 0) {
      // Plan §8 #5 — Audit-Trail: jede Teilzahlung als eigene Zeile in agent_settlement_payments.
      // Nur wenn KEINE Invoice existiert (Legacy-Pfad) — sonst doppelte Buchung.
      const payId = uuid();
      db.run(
        `INSERT INTO agent_settlement_payments (id, transfer_id, amount, method, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [payId, id, paidNow, method || 'cash', now.split('T')[0], isFull ? 'Final settlement' : 'Partial settlement', now]
      );
      trackInsert('agent_settlement_payments', payId, { transferId: id, amount: paidNow, method: method || 'cash' });
    }

    get().updateTransfer(id, {
      status: isFull ? 'settled' : 'sold',
      settlementStatus: isFull ? 'paid' : 'partial',
      settlementPaidAmount: newPaid,
      commissionPaidFrom: method ?? t.commissionPaidFrom ?? null,
      settledAt: isFull ? now : t.settledAt,
    });
    eventBus.emit('agent_transfer.settled', 'agent_transfer', id, { amount: paidNow, full: isFull });
  },

  // Plan §8 #5 — Settlement-Payment-Historie auslesen.
  getSettlementPayments: (transferId: string) => {
    try {
      const rows = query(
        `SELECT id, amount, method, paid_at, note, created_at FROM agent_settlement_payments
           WHERE transfer_id = ? ORDER BY paid_at ASC, created_at ASC`,
        [transferId]
      );
      return rows.map(r => ({
        id: r.id as string,
        amount: (r.amount as number) || 0,
        method: r.method as string,
        paidAt: r.paid_at as string,
        note: (r.note as string) || undefined,
      }));
    } catch { return []; }
  },

  deleteTransfer: (id) => {
    const db = getDatabase();
    const transfer = get().getTransfer(id);
    if (transfer && transfer.status === 'transferred') {
      db.run(`UPDATE products SET stock_status = 'in_stock', updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), transfer.productId]);
    }
    db.run(`DELETE FROM agent_transfers WHERE id = ?`, [id]);
    saveDatabase();
    trackDelete('agent_transfers', id);
    get().loadTransfers();
  },

  convertTransferToInvoice: (transferId, customerId) => {
    const transfer = get().getTransfer(transferId);
    if (!transfer) throw new Error('Transfer not found.');
    if (transfer.status !== 'sold' && transfer.status !== 'settled') {
      throw new Error('Convert is only possible for sold or settled transfers.');
    }
    if (transfer.invoiceId) {
      throw new Error('This transfer was already converted to an invoice.');
    }
    if (!customerId) throw new Error('Customer is required.');
    // Plan §Agent §Settle+Invoice (User-Spec): bestehende Settle-Payments
    // werden in die neue Invoice migriert (statt zu blocken). Kein Geld-Verlust,
    // keine Doppelbuchung.

    // Produkt aus DB ziehen — Tax-Scheme + Einkaufspreis bestimmen die Invoice-Mathematik.
    const prodRows = query(
      `SELECT id, tax_scheme, purchase_price FROM products WHERE id = ?`,
      [transfer.productId]
    );
    const prod = prodRows[0];
    const scheme = ((prod?.tax_scheme as TaxScheme | undefined) || 'MARGIN') as TaxScheme;
    const purchasePrice = (prod?.purchase_price as number | undefined) || 0;
    const rate = scheme === 'ZERO' ? 0 : 10;

    // settlementAmount ist die brutto-Forderung an den Agent (= actualSalePrice − commission).
    // Je nach Scheme dekomponieren, damit die fertige Invoice gross == settlementAmount hat.
    const settlementGross = Number(transfer.settlementAmount || 0);
    if (settlementGross <= 0) {
      throw new Error('Settlement amount must be positive before converting to invoice.');
    }
    const netInput = scheme === 'VAT_10' ? settlementGross / (1 + rate / 100) : settlementGross;
    const calc = vatEngine.calculateNet(netInput, purchasePrice, scheme, rate);

    // Invoice anlegen — eine einzelne Line mit dem Produkt-Snapshot.
    const inv = useInvoiceStore.getState();
    const invoice = inv.createDirectInvoice(
      customerId,
      [{
        productId: transfer.productId,
        unitPrice: calc.netAmount,
        purchasePrice,
        taxScheme: scheme,
        vatRate: rate,
        vatAmount: calc.vatAmount,
        lineTotal: calc.grossAmount,
      }],
      `Agent settlement · transfer ${transfer.transferNumber}`,
    );

    // Transfer ↔ Invoice koppeln + Customer-Verknüpfung am Agent merken.
    get().updateTransfer(transferId, { invoiceId: invoice.id });
    const agent = get().getAgent(transfer.agentId);
    if (agent && !agent.customerId) {
      get().updateAgent(transfer.agentId, { customerId });
    }

    // Plan §Agent §Settle+Invoice: bestehende Settle-Payments in die neue
    // Invoice migrieren, sonst zählen sie weiter parallel und Banking
    // bucht das Geld doppelt. Nach der Migration werden die alten
    // agent_settlement_payments entfernt + transfer.settlementPaidAmount
    // zurückgesetzt — die Wahrheit lebt jetzt in der Invoice.
    const existingSettlePayments = get().getSettlementPayments(transferId);
    if (existingSettlePayments.length > 0) {
      const db = getDatabase();
      for (const sp of existingSettlePayments) {
        const invMethod = sp.method === 'bank' ? 'bank_transfer' : (sp.method || 'cash');
        inv.recordPayment(invoice.id, sp.amount, invMethod, `Migrated from settlement (${sp.paidAt})`);
      }
      db.run('DELETE FROM agent_settlement_payments WHERE transfer_id = ?', [transferId]);
      saveDatabase();
      get().updateTransfer(transferId, {
        settlementPaidAmount: 0,
        settlementStatus: 'pending',
        // Status zurück auf 'sold' falls vorher 'settled' — die Wahrheit über
        // den Zahlungsstand lebt jetzt in der Invoice, nicht mehr im Transfer.
        status: 'sold',
      });
    }

    // Customer-Liste neu laden, falls der UI-Convert-Flow eben einen neuen Customer erzeugt hat —
    // sonst sieht /clients den nicht.
    useCustomerStore.getState().loadCustomers();
    eventBus.emit('agent_transfer.invoice_created', 'agent_transfer', transferId, { invoiceId: invoice.id });
    return invoice;
  },

  undoTransferInvoiceConvert: (transferId) => {
    const transfer = get().getTransfer(transferId);
    if (!transfer) throw new Error('Transfer not found.');
    if (!transfer.invoiceId) throw new Error('This transfer has no linked invoice.');
    const inv = useInvoiceStore.getState();
    const invoice = inv.invoices.find(i => i.id === transfer.invoiceId);
    if (!invoice) {
      // Invoice fehlt → einfach den Link löschen, Daten konsistent halten.
      get().updateTransfer(transferId, { invoiceId: undefined });
      return;
    }
    if ((invoice.paidAmount || 0) > 0.005) {
      throw new Error(
        'Invoice hat schon eine Zahlung — Undo nicht erlaubt (würde Doppelbuchung erzeugen). Erst Payment löschen, dann Undo.'
      );
    }
    inv.deleteInvoice(invoice.id);
    get().updateTransfer(transferId, { invoiceId: undefined });
    eventBus.emit('agent_transfer.invoice_undone', 'agent_transfer', transferId, { invoiceId: invoice.id });
  },
}));

// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R5D — der Agenten-Transfer am Haus: dieselben Regeln, EINE Klammer.
//
// Die drei Handlungen schrieben am Primary ohne gemeinsame Klammer: das Anlegen legt ggf. den
// Agenten zum Kunden an, setzt das Stück auf `with_agent` und schreibt den Transfer — drei
// Schreibvorgänge. „Auto-create from agent" legte erst den Kunden an und wandelte DANACH um;
// scheiterte die Umwandlung, blieb der Kunde stehen. Jetzt:
//
//   • `…InHouse` — die EINE Folge (Prüfen, ggf. Kunde, Hausfunktion), die der Fernbefehl innerhalb
//     seiner Transaktion ruft;
//   • `…OnPrimary` — dieselbe Folge für die Maske des Primary, exklusiv in derselben Warteschlange,
//     in EINER Transaktion, erst danach durabel.
//
// Die Regeln selbst stehen in `transfer-rules`; hier wohnen nur die Anschlüsse ans Haus.
// ════════════════════════════════════════════════════════════════════════════
import { query, currentBranchId } from '@/core/db/helpers';
import { saveDatabaseDurably } from '@/core/db/database';
import { beginLedgerTransaction, commitLedgerTransaction, rollbackLedgerTransaction, watchLedgerPosts } from '@/core/ledger/posting';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { useAgentStore, type TransferConvertUndone } from '@/stores/agentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import type { AgentTransfer } from '@/core/models/types';
import {
  TransferActionRejected, agentAutoCustomer, normalizeTransferCreate, planTransferCreate, transferConvertBlocker,
  type TransferBillTo, type TransferCreateForm, type TransferHousePort,
} from './transfer-rules';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseTransferPort(branchId: string): TransferHousePort {
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    productStock: (id) => {
      const r = query('SELECT stock_status FROM products WHERE id = ? AND branch_id = ?', [id, branchId])[0];
      return r ? String(r.stock_status ?? '') : undefined;
    },
    productOut: (id) => !!query(
      "SELECT id FROM agent_transfers WHERE product_id = ? AND status = 'transferred'", [id],
    )[0],
    // Die Mitarbeiterauswahl der Maske (StaffSelect) zeigt nur, wer nicht ausgeschieden ist.
    employeeExists: (id) => !!query(
      "SELECT id FROM employees WHERE id = ? AND branch_id = ? AND COALESCE(employment_status, 'active') != 'inactive'",
      [id, branchId],
    )[0],
  };
}

/**
 * Die Stores schlagen Transfer, Agent, Kunde und Artikel in ihren GELADENEN Listen nach — ohne ein
 * `load…()` davor täten sie still nichts (C3G/C3H). Also: frisch lesen, dann rufen.
 */
function frischLesen(): void {
  useAgentStore.getState().loadAgents();
  useAgentStore.getState().loadTransfers();
  useCustomerStore.getState().loadCustomers();
  useInvoiceStore.getState().loadInvoices();
  useProductStore.getState().loadProducts();
}

/** „Transfer Item": prüfen, dann die Hausfunktion (Agent finden/anlegen, Nummer, Bestand, Transfer). */
export function createTransferInHouse(form: TransferCreateForm, branchId: string): AgentTransfer {
  const input = planTransferCreate(normalizeTransferCreate(form), houseTransferPort(branchId));
  // `findOrCreateAgentForCustomer` sucht Kunde und Agent in den GELADENEN Listen — ein zurück-
  // gerollter Agent darf dort nicht mehr stehen, ein eben angelegter Kunde muss es.
  useCustomerStore.getState().loadCustomers();
  useAgentStore.getState().loadAgents();
  return useAgentStore.getState().createTransferForCustomer({
    customerId: input.customerId,
    productId: input.productId,
    ourPrice: input.ourPrice,
    returnBy: input.returnBy,
    notes: input.notes,
    staffId: input.staffId,
    settlementModel: input.settlementModel,
    excessSplitPct: input.excessSplitPct,
  });
}

export interface TransferConversion {
  invoiceId: string;
  customerId: string;
  /** Hat „Auto-create from agent" den Kunden eben angelegt? */
  customerCreated: boolean;
}

/** Die EINE Folge beider Umwandlungen: prüfen, ggf. den Kunden anlegen, dann die Hausfunktion. */
function umwandeln(ids: readonly string[], billTo: TransferBillTo, branchId: string, combined: boolean): TransferConversion {
  if (ids.length === 0) throw new TransferActionRejected('NO_TRANSFERS_SELECTED', 'no transfers selected');
  if (new Set(ids).size !== ids.length) {
    throw new TransferActionRejected('TRANSFER_LISTED_TWICE', 'a transfer is listed twice');
  }
  // ALLE Voraussetzungen zuerst — eine halb gebaute Sammelrechnung wäre schlimmer als keine.
  const rows = ids.map((id) => {
    const r = query(
      'SELECT id, status, invoice_id, settlement_amount, agent_id FROM agent_transfers WHERE id = ? AND branch_id = ?',
      [id, branchId],
    )[0];
    if (!r) throw new TransferActionRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
    const blocker = transferConvertBlocker({
      status: String(r.status ?? '') as AgentTransfer['status'],
      invoiceId: r.invoice_id ? String(r.invoice_id) : null,
      settlementAmount: Number(r.settlement_amount ?? 0),
    }, combined);
    if (blocker) throw new TransferActionRejected(blocker.code, blocker.message);
    return r;
  });
  const agentIds = new Set(rows.map((r) => String(r.agent_id ?? '')));
  if (agentIds.size > 1) {
    throw new TransferActionRejected('TRANSFERS_NOT_SAME_AGENT', 'a combined invoice covers transfers of ONE agent');
  }
  const agent = query('SELECT id, name, company, phone, whatsapp, email FROM agents WHERE id = ?', [[...agentIds][0]])[0];
  if (!agent) throw new TransferActionRejected('AGENT_NOT_FOUND', 'the agent of this transfer is gone');

  let customerId: string;
  let customerCreated = false;
  if ('autoCustomer' in billTo) {
    // „Auto-create from agent": ein NEUER Kunde aus den Angaben des Agenten, wie ihn das Haus
    // kennt — nicht aus dem, was ein Client darüber erzählt.
    customerId = useCustomerStore.getState().createCustomer(agentAutoCustomer({
      name: agent.name as string | null, company: agent.company as string | null, phone: agent.phone as string | null,
      whatsapp: agent.whatsapp as string | null, email: agent.email as string | null,
    }, combined)).id;
    customerCreated = true;
  } else {
    if (!houseTransferPort(branchId).customerExists(billTo.customerId)) {
      throw new TransferActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
    }
    customerId = billTo.customerId;
  }

  frischLesen();
  const as = useAgentStore.getState();
  // Die Hausfunktionen: Rechnung über den Abrechnungsbetrag (Steuer je Artikel), Transfer ↔ Rechnung,
  // Kunde am Agenten gemerkt, die alte Forderung aus dem Verkauf storniert, gezahlte
  // Abrechnungsbeträge in die Rechnung umgezogen.
  const invoice = combined
    ? as.convertTransfersToInvoice([...ids], customerId)
    : as.convertTransferToInvoice(ids[0], customerId);
  return { invoiceId: invoice.id, customerId, customerCreated };
}

/** „Create Invoice" eines Transfers (Liste und Detailseite). */
export function convertTransferInHouse(transferId: string, billTo: TransferBillTo, branchId: string): TransferConversion {
  return umwandeln([transferId], billTo, branchId, false);
}

/** „Create Combined Invoice": mehrere verkaufte Transfers EINES Agenten in EINE Rechnung. */
export function convertTransfersInHouse(ids: readonly string[], billTo: TransferBillTo, branchId: string): TransferConversion {
  return umwandeln(ids, billTo, branchId, true);
}

/** Eine Handlung am Primary: exklusiv, in EINER Transaktion, erst danach durabel. */
function amPrimary<T>(work: () => T): Promise<T> {
  return runExclusive(async () => {
    beginLedgerTransaction();
    let out: T;
    try {
      out = work();
      commitLedgerTransaction();
    } catch (e) {
      rollbackLedgerTransaction();
      frischLesen();
      throw e;
    }
    await saveDatabaseDurably();
    frischLesen();
    return out;
  });
}

/** „Transfer Item" am Primary — dieselbe Folge wie der Fernbefehl. */
export function createTransferOnPrimary(form: TransferCreateForm): Promise<AgentTransfer> {
  return amPrimary(() => createTransferInHouse(form, currentBranchId()));
}

/** „Create Invoice" am Primary. */
export function convertTransferOnPrimary(transferId: string, billTo: TransferBillTo): Promise<TransferConversion> {
  return amPrimary(() => convertTransferInHouse(transferId, billTo, currentBranchId()));
}

/** „Create Combined Invoice" am Primary. */
export function convertTransfersOnPrimary(ids: readonly string[], billTo: TransferBillTo): Promise<TransferConversion> {
  return amPrimary(() => convertTransfersInHouse(ids, billTo, currentBranchId()));
}

// ── R6E — „Undo convert": die Umwandlung zurücknehmen, ohne die Rechnung zu löschen ──────────

export interface TransferConversionUndone extends TransferConvertUndone {
  transferId: string;
}

/** Der Knopf „Undo"/„Undo Convert": nur mit Rechnung, und nur solange sie (sichtbar) nicht bezahlt ist. */
export function canUndoTransferConvert(t: { invoiceId?: string | null }, invoice?: { paidAmount?: number } | null): boolean {
  return !!t.invoiceId && (!invoice || (invoice.paidAmount || 0) <= 0.005);
}

/** Der Rumpf von `transfers.undo_convert` — der Transfer mit seiner gesehenen Fassung, sonst nichts. */
export function transferUndoBody(t: { id: string; revision?: number }): Record<string, unknown> {
  return { transferId: t.id, expectedRevision: t.revision };
}

/**
 * „Undo convert": die EINE Folge, die der Fernbefehl in seiner Transaktion ruft. Der Transfer muss
 * in DIESER Filiale stehen; die gesehene Fassung wird vor jeder Regel verglichen. Den Rest — Regel
 * „bezahlt", Storno der Rechnung, Stück, Verkaufsforderung, Entkoppeln aller Transfers — trägt die
 * Hausfunktion. Eine abgefangene Buchung irgendwo darin bricht die ganze Handlung ab.
 */
export function undoTransferConversionInHouse(transferId: string, branchId: string, expectedRevision?: number): TransferConversionUndone {
  if (isClientMode()) {
    throw new TransferActionRejected('TRANSFER_PRIMARY_ONLY', 'a conversion is undone on the main computer — this window has no business database');
  }
  const row = query('SELECT id, revision FROM agent_transfers WHERE id = ? AND branch_id = ?', [transferId, branchId])[0];
  if (!row) throw new TransferActionRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
  if (expectedRevision !== undefined && Number(row.revision ?? 0) !== expectedRevision) {
    throw new TransferActionRejected('RECORD_CHANGED',
      `this transfer changed since you opened it (you saw ${expectedRevision}, it is now ${Number(row.revision ?? 0)}) — reopen it`);
  }
  frischLesen();
  const buchung = watchLedgerPosts('undo transfer conversion');
  const out = useAgentStore.getState().undoTransferInvoiceConvert(transferId, branchId);
  buchung();
  return { transferId, ...out };
}

/** „Undo convert" am Primary — dieselbe Folge, EINE Klammer, erst danach durabel. */
export function undoTransferConversionOnPrimary(transferId: string, expectedRevision?: number): Promise<TransferConversionUndone> {
  if (isClientMode()) {
    return Promise.reject(new TransferActionRejected('TRANSFER_PRIMARY_ONLY',
      'a conversion is undone on the main computer — this window has no business database'));
  }
  const branchId = currentBranchId();
  return runOnPrimary(() => undoTransferConversionInHouse(transferId, branchId, expectedRevision), frischLesen);
}

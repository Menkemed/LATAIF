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
import {
  activeSourceDates, beginLedgerTransaction, commitLedgerTransaction, hasLedgerEntries, postAgentTransferSold, reverseSource,
  rollbackLedgerTransaction, watchLedgerPosts,
} from '@/core/ledger/posting';
import { logAuditOrThrow } from '@/core/audit/audit-log';
import { computeAgentTransferSale, DEFAULT_AGENT_SPLIT_PCT } from '@/core/agent/economics';
import { businessTimestamp } from '@/core/utils/business-date';
import { openingCutoffDay } from '@/core/ledger/correction-dates';
import { closedVatQuarters, nbrQuarterOfDate } from '@/core/tax/vat-period-lock';
import { runExclusive } from '@/core/bridge/command-scheduler';
import { runOnPrimary } from '@/core/data/primary-action';
import { isClientMode } from '@/core/bridge/client-mode';
import { watchSyncTracks } from '@/core/sync/sync-service';
import { useAgentStore, type TransferConvertUndone } from '@/stores/agentStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useInvoiceStore } from '@/stores/invoiceStore';
import { useProductStore } from '@/stores/productStore';
import type { AgentTransfer } from '@/core/models/types';
import { belongsToConsignment } from '@/core/consignment/consignment-sale-link';
import {
  TransferActionRejected, agentAutoCustomer, normalizeTransferBatch, normalizeTransferCreate, planTransferCreate, transferConvertBlocker,
  transferCorrectionReason, transferEditBlocker, transferRemovePlan,
  type TransferBatchForm, type TransferBillTo, type TransferCreateForm, type TransferEditPatch, type TransferHousePort,
} from './transfer-rules';

/** Die Nachschlagestellen des Hauses — immer in der Filiale, deren Bücher dieser Rechner führt. */
export function houseTransferPort(branchId: string): TransferHousePort {
  return {
    customerExists: (id) => !!query(
      "SELECT id FROM customers WHERE id = ? AND branch_id = ? AND id NOT LIKE 'sys-%'", [id, branchId],
    )[0],
    consignmentOwned: (id) => belongsToConsignment(id),
    productStock: (id) => {
      // BULK METAL V1 — kein Bulk an Agenten (nicht V1): der Systemartikel gilt hier als nicht vorhanden.
      const r = query("SELECT stock_status FROM products WHERE id = ? AND branch_id = ? AND id NOT LIKE 'bulk-%'", [id, branchId])[0];
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
    transferredAt: input.transferredAt,
    notes: input.notes,
    staffId: input.staffId,
    settlementModel: input.settlementModel,
    excessSplitPct: input.excessSplitPct,
  });
}

/** Ein Stück lesbar für eine Meldung: SKU, sonst Marke + Name. */
function stueckName(productId: string): string {
  const p = query('SELECT sku, brand, name FROM products WHERE id = ?', [productId])[0];
  if (!p) return productId;
  return String(p.sku || [p.brand, p.name].filter(Boolean).join(' ') || productId);
}

/**
 * Owner 14.11.2026 — „New Transfer" mit mehreren Stücken: in der Transaktion des Aufrufers (`amPrimary` bzw. der
 * Fernbefehl). ZUERST jedes Stück durch dieselben Prüfungen wie der Einzeltransfer (Kunde, im Lager, keine Kommission, nicht
 * schon draußen, Mitarbeiter) — erst wenn ALLE gehen, wird geschrieben: je Stück die Hausfunktion des Einzeltransfers (eigene
 * Nummer, eigener Preis, Bestand „with agent"). Scheitert irgendetwas, rollt der Aufrufer alles zurück — kein halber Vorgang.
 */
export function createTransfersInHouse(form: TransferBatchForm, branchId: string): AgentTransfer[] {
  const inputs = normalizeTransferBatch(form);
  const port = houseTransferPort(branchId);
  inputs.forEach((input, i) => {
    try {
      planTransferCreate(input, port);
    } catch (e) {
      if (e instanceof TransferActionRejected) {
        throw new TransferActionRejected(e.code, `item ${i + 1} (${stueckName(input.productId)}): ${e.message}`);
      }
      throw e;
    }
  });
  useCustomerStore.getState().loadCustomers();
  useAgentStore.getState().loadAgents();
  return inputs.map((input) => useAgentStore.getState().createTransferForCustomer({
    customerId: input.customerId,
    productId: input.productId,
    ourPrice: input.ourPrice,
    returnBy: input.returnBy,
    transferredAt: input.transferredAt,
    notes: input.notes,
    staffId: input.staffId,
    settlementModel: input.settlementModel,
    excessSplitPct: input.excessSplitPct,
  }));
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

  // AGENT-PAYMENT-SYNC — ab dem ersten Schreiben: ein Abgleich-Eintrag, der nicht geschrieben werden konnte (Kunde,
  // Rechnung, Zahlungen, umgezogene Abrechnungszeilen, Vorgang), bricht die Umwandlung ab — der Aufrufer
  // (`amPrimary` bzw. der Fernbefehl) rollt dann ALLES zurück. Sonst wäre sie hier umgewandelt und auf dem Spiegel nicht.
  const abgleich = watchSyncTracks(combined ? 'convert transfers' : 'convert transfer');
  // AGENT-CONVERSION-LEDGER — ebenso eine Buchung, die die Hausfunktionen in `safePost` abfangen: der Storno der
  // alten Verkaufsforderung (je Vorgang) und der Abrechnungszahlungen (je Zeile), aber auch Rechnung und umgezogene
  // Zahlungen. Ein gescheiterter Storno ließ sonst die alte Forderung NEBEN der neuen Rechnung stehen (doppelt).
  const buchung = watchLedgerPosts(combined ? 'convert transfers' : 'convert transfer');
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
  buchung();
  abgleich();
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

/** Owner 14.11.2026 — „Transfer N items" am Primary: alle Stücke in EINER Transaktion (dieselbe Folge wie fern). */
export function createTransfersOnPrimary(form: TransferBatchForm): Promise<AgentTransfer[]> {
  return amPrimary(() => createTransfersInHouse(form, currentBranchId()));
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

// ── AGENT-DELETE-ATOMICITY — „Delete": ganz oder gar nicht ──────────────────────────────────

export interface TransferDeleted {
  transferId: string;
  transferNumber: string;
}

/**
 * „Delete" eines Transfers — EIN Vorgang in der Transaktion des Aufrufers: Stück zurück (samt Eigentum),
 * Verkauf und Zahlungen streng storniert, Zeilen gelöscht, Protokoll und Sync. Vorher rief die Maske die
 * Hausfunktion ohne Klammer, und die Stornos liefen in `safePost` — ein gescheiterter Storno ließ das Stück
 * zurück und die Forderung stehen. Jetzt bricht jeder Fehler (auch eine abgefangene Buchung) die GANZE
 * Handlung ab. Ein zweiter Aufruf (Doppelklick) findet den Vorgang nicht mehr — keine zweite Wirkung.
 */
export function deleteTransferInHouse(transferId: string, branchId: string, expectedRevision?: number): TransferDeleted {
  if (isClientMode()) {
    throw new TransferActionRejected('TRANSFER_PRIMARY_ONLY', 'a transfer is deleted on the main computer — this window has no business database');
  }
  const row = query('SELECT id, revision, transfer_number FROM agent_transfers WHERE id = ? AND branch_id = ?', [transferId, branchId])[0];
  if (!row) throw new TransferActionRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch — it may already be deleted');
  if (expectedRevision !== undefined && Number(row.revision ?? 0) !== expectedRevision) {
    throw new TransferActionRejected('RECORD_CHANGED',
      `this transfer changed since you opened it (you saw ${expectedRevision}, it is now ${Number(row.revision ?? 0)}) — reopen it`);
  }
  frischLesen();
  const buchung = watchLedgerPosts('delete transfer');
  // AGENT-DELETE-SYNC — ein Abgleich-Eintrag (Stück, Los, Buchung, Zahlung, Vorgang), der nicht geschrieben werden
  // konnte, bricht die Handlung ebenso ab: sonst wäre sie hier gelöscht und auf dem Spiegel nicht.
  const abgleich = watchSyncTracks('delete transfer');
  useAgentStore.getState().deleteTransfer(transferId);
  buchung();
  abgleich();
  return { transferId, transferNumber: String(row.transfer_number ?? '') };
}

/** „Delete" am Primary — exklusiv, EINE Klammer, erst danach durabel. */
export function deleteTransferOnPrimary(transferId: string, expectedRevision?: number): Promise<TransferDeleted> {
  if (isClientMode()) {
    return Promise.reject(new TransferActionRejected('TRANSFER_PRIMARY_ONLY',
      'a transfer is deleted on the main computer — this window has no business database'));
  }
  const branchId = currentBranchId();
  return runOnPrimary(() => deleteTransferInHouse(transferId, branchId, expectedRevision), frischLesen);
}

// ── Owner 14.11.2026 — „Edit" und „Remove" eines Approval-Transfers ─────────────────────────────

export interface TransferEdited { transferId: string; changed: string[]; settlementAmount?: number; saleRebooked: boolean }

/** Sind Abrechnungszahlungen an diesem Transfer erfasst (Betrag oder Zeilen)? */
function zahlungenErfasst(transferId: string, paidAmount: unknown): boolean {
  return (Number(paidAmount) || 0) > 0.0005
    || Number(query('SELECT COUNT(*) AS n FROM agent_settlement_payments WHERE transfer_id = ?', [transferId])[0]?.n) > 0;
}

/** Liegt ein Tag der Verkaufsbuchung in einer geschlossenen Periode (Eröffnung, eingereichtes/bezahltes VAT-Quartal)? */
function verkaufsPeriodeGeschlossen(transferId: string, branchId: string): string | null {
  const cutoff = openingCutoffDay();
  const zu = closedVatQuarters(branchId);
  for (const d of activeSourceDates('AGENT_TRANSFER_SOLD', transferId)) {
    const tag = String(d).slice(0, 10);
    if (tag < cutoff) return `the sale is booked on ${tag}, before the opening (${cutoff})`;
    const q = nbrQuarterOfDate(tag);
    if (q && zu.get(q.key)) return `the sale is booked on ${tag}, in a VAT quarter that is already filed or paid`;
  }
  return null;
}

/**
 * „Edit" eines Transfers — EINE Folge für Primary und PC2 (`transfers.update`), in der Transaktion des Aufrufers:
 *   • Preis, Modell und Anteil: vor dem Verkauf nur die Werte; nach dem Verkauf (ohne Rechnung, ohne Zahlung) wird der
 *     Abrechnungsbetrag mit DERSELBEN Formel neu gerechnet (`computeAgentTransferSale`) und die Verkaufsbuchung an ihrem Tag
 *     gegengebucht und mit dem neuen Betrag neu gebucht (Einstand und Kunde unverändert) — sichtbar im Hauptbuch und Protokoll;
 *   • Kunde nur, solange das Stück draußen ist (sein Approval-Konto wird gefunden oder angelegt);
 *   • Übergabetag (kein künftiger), Rückgabedatum, Mitarbeiter, Notiz.
 * Gesperrt (vor jedem Schreiben, verständlich): Rechnung, Abrechnungszahlungen, geschlossene Periode — `transferEditBlocker`.
 */
export function editTransferInHouse(
  transferId: string, patchIn: TransferEditPatch, branchId: string, opts: { expectedRevision?: number } = {},
): TransferEdited {
  const row = query(`SELECT id, revision, status, invoice_id, agent_id, product_id, agent_price, settlement_model, excess_split_pct,
      actual_sale_price, settlement_amount, settlement_paid_amount, staff_id, transferred_at, return_by, notes, transfer_number
    FROM agent_transfers WHERE id = ? AND branch_id = ?`, [transferId, branchId])[0];
  if (!row) throw new TransferActionRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch');
  if (opts.expectedRevision !== undefined && Number(row.revision ?? 0) !== opts.expectedRevision) {
    throw new TransferActionRejected('RECORD_CHANGED',
      `this transfer changed since you opened it (you saw ${opts.expectedRevision}, it is now ${Number(row.revision ?? 0)}) — reopen it`);
  }
  const alt = {
    agentPrice: Number(row.agent_price) || 0,
    settlementModel: (String(row.settlement_model || 'full') === 'split' ? 'split' : 'full') as 'full' | 'split',
    excessSplitPct: row.excess_split_pct === null || row.excess_split_pct === undefined ? null : Number(row.excess_split_pct),
    staffId: row.staff_id ? String(row.staff_id) : null,
    transferredAt: String(row.transferred_at ?? '').slice(0, 10),
    returnBy: row.return_by ? String(row.return_by) : null,
    notes: row.notes === null || row.notes === undefined ? null : String(row.notes),
    customerId: String(query('SELECT customer_id FROM agents WHERE id = ?', [String(row.agent_id ?? '')])[0]?.customer_id ?? ''),
  };
  // Nur, was sich WIRKLICH ändert — ein unverändertes Feld ist keine Änderung (und keine Sperre).
  const p: TransferEditPatch = { ...patchIn };
  const gleich = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  if (p.agentPrice !== undefined && Math.abs(p.agentPrice - alt.agentPrice) < 0.0005) delete p.agentPrice;
  if (p.settlementModel !== undefined && p.settlementModel === alt.settlementModel) delete p.settlementModel;
  if (p.excessSplitPct !== undefined && gleich(p.excessSplitPct, alt.excessSplitPct)) delete p.excessSplitPct;
  if (p.staffId !== undefined && gleich(p.staffId, alt.staffId)) delete p.staffId;
  if (p.transferredAt !== undefined && p.transferredAt === alt.transferredAt) delete p.transferredAt;
  if (p.returnBy !== undefined && gleich(p.returnBy ? p.returnBy.slice(0, 10) : null, alt.returnBy ? alt.returnBy.slice(0, 10) : null)) delete p.returnBy;
  if (p.notes !== undefined && gleich(p.notes || null, alt.notes || null)) delete p.notes;
  if (p.customerId !== undefined && p.customerId === alt.customerId) delete p.customerId;
  const changed = (Object.keys(p) as Array<keyof TransferEditPatch>).filter((k) => k !== 'acknowledgeBelowPrice');
  if (changed.length === 0) return { transferId, changed: [], saleRebooked: false };

  const status = String(row.status ?? '');
  const blocker = transferEditBlocker({
    status, invoiceId: row.invoice_id ? String(row.invoice_id) : null, hasPayments: zahlungenErfasst(transferId, row.settlement_paid_amount),
  }, p);
  if (blocker) throw new TransferActionRejected(blocker.code, blocker.message);
  const port = houseTransferPort(branchId);
  if (p.customerId !== undefined && !port.customerExists(p.customerId)) throw new TransferActionRejected('CUSTOMER_NOT_FOUND', 'no such client in this branch');
  if (p.staffId && !port.employeeExists(p.staffId)) throw new TransferActionRejected('EMPLOYEE_NOT_FOUND', 'no such active employee in this branch');

  // Der wirksame neue Stand von Preis/Modell/Anteil.
  const neu = {
    agentPrice: p.agentPrice ?? alt.agentPrice,
    settlementModel: p.settlementModel ?? alt.settlementModel,
    excessSplitPct: (p.settlementModel ?? alt.settlementModel) === 'split'
      ? (p.excessSplitPct ?? alt.excessSplitPct ?? DEFAULT_AGENT_SPLIT_PCT) : null,
  };
  const now = new Date().toISOString();
  frischLesen();
  const buchung = watchLedgerPosts('edit transfer');
  const abgleich = watchSyncTracks('edit transfer');
  let settlementAmount: number | undefined;
  let saleRebooked = false;
  const geld = p.agentPrice !== undefined || p.settlementModel !== undefined || p.excessSplitPct !== undefined;
  if (geld && status === 'sold') {
    const verkauf = Number(row.actual_sale_price) || 0;
    const econ = computeAgentTransferSale({ ...neu, excessSplitPct: neu.excessSplitPct ?? undefined }, verkauf);
    if (econ.belowPrice && !patchIn.acknowledgeBelowPrice) {
      throw new TransferActionRejected('TRANSFER_BELOW_PRICE',
        `the sale price ${verkauf} is below the new Our Price ${neu.agentPrice} — confirm it: we then receive only the sale amount, no split`);
    }
    settlementAmount = econ.ourSettlement;
    if (Math.abs(settlementAmount - (Number(row.settlement_amount) || 0)) > 0.0005 && hasLedgerEntries('AGENT_TRANSFER_SOLD', transferId)) {
      const zu = verkaufsPeriodeGeschlossen(transferId, branchId);
      if (zu) throw new TransferActionRejected('TRANSFER_PERIOD_CLOSED', `${zu} — the booked sale is not changed any more`);
      // Die lebende Verkaufsbuchung: Forderung (Kunde, Tag) und Wareneinsatz — sie bleiben, nur der Betrag ändert sich.
      const beine = query(`SELECT e1.account, e1.direction, e1.amount, e1.counterparty_id, e1.occurred_at FROM ledger_entries e1
          WHERE e1.source_module = 'AGENT_TRANSFER_SOLD' AND e1.source_id = ? AND e1.reverses_entry_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM ledger_entries e2 WHERE e2.reverses_entry_id = e1.id)`, [transferId]);
      const ar = beine.find((b) => b.account === 'ACCOUNTS_RECEIVABLE' && b.direction === 'DEBIT');
      const cogs = beine.find((b) => b.account === 'COGS' && b.direction === 'DEBIT');
      if (!ar) throw new TransferActionRejected('TRANSFER_SALE_UNREADABLE', 'the sale posting of this transfer has no receivable — nothing was changed');
      reverseSource('AGENT_TRANSFER_SOLD', transferId, now, { mirrorOriginalDates: true });
      postAgentTransferSold({ transferId, amount: settlementAmount, soldAt: String(ar.occurred_at), cost: Number(cogs?.amount ?? 0) },
        String(ar.counterparty_id ?? ''));
      saleRebooked = true;
    }
  }
  const data: Partial<AgentTransfer> = {};
  if (p.agentPrice !== undefined) data.agentPrice = neu.agentPrice;
  if (p.settlementModel !== undefined || p.excessSplitPct !== undefined) {
    data.settlementModel = neu.settlementModel;
    data.excessSplitPct = (neu.excessSplitPct ?? null) as unknown as number;
  }
  if (settlementAmount !== undefined) data.settlementAmount = settlementAmount;
  if (p.staffId !== undefined) data.staffId = (p.staffId ?? null) as unknown as string;
  if (p.transferredAt !== undefined) data.transferredAt = businessTimestamp(p.transferredAt, now);
  if (p.returnBy !== undefined) data.returnBy = (p.returnBy ?? null) as unknown as string;
  if (p.notes !== undefined) data.notes = (p.notes ?? null) as unknown as string;
  if (p.customerId !== undefined) {
    useCustomerStore.getState().loadCustomers();
    useAgentStore.getState().loadAgents();
    data.agentId = useAgentStore.getState().findOrCreateAgentForCustomer(p.customerId).id;
  }
  useAgentStore.getState().updateTransfer(transferId, data);
  const vorher: Record<string, unknown> = {}, nachher: Record<string, unknown> = {};
  for (const k of changed) { vorher[k] = (alt as Record<string, unknown>)[k] ?? null; nachher[k] = (p as Record<string, unknown>)[k] ?? null; }
  if (settlementAmount !== undefined) { vorher.settlementAmount = Number(row.settlement_amount) || 0; nachher.settlementAmount = settlementAmount; }
  logAuditOrThrow({ module: 'Agent', entityType: 'agent_transfers', entityId: transferId, action: 'UPDATE', oldValue: vorher, newValue: { ...nachher, saleRebooked } });
  buchung();
  abgleich();
  return { transferId, changed: changed as string[], ...(settlementAmount !== undefined ? { settlementAmount } : {}), saleRebooked };
}

/** „Edit" am Primary — exklusiv, EINE Klammer, erst danach durabel (dieselbe Folge wie `transfers.update`). */
export function editTransferOnPrimary(transferId: string, patch: TransferEditPatch, expectedRevision?: number): Promise<TransferEdited> {
  return amPrimary(() => editTransferInHouse(transferId, patch, currentBranchId(), { expectedRevision }));
}

export interface TransferRemoved { transferId: string; transferNumber: string; kind: 'deleted' | 'cancelled' }

/**
 * „Remove" eines Transfers (am Primary, wie jedes Löschen): `transferRemovePlan` entscheidet —
 *   • nichts gebucht → löschen (Stück zurück, Nummer bleibt verbraucht, Protokoll mit Grund);
 *   • verkauft → Storno (Gegenbuchung am Tag des Verkaufs, Stück zurück, Transfer bleibt „cancelled");
 *   • Rechnung / Zahlungen → verständliches Nein mit dem Korrekturweg.
 * Andere Transfers derselben Sammelübergabe bleiben unberührt (jeder Transfer ist eine eigene Zeile).
 */
export function removeTransferInHouse(transferId: string, branchId: string, reasonIn: unknown, expectedRevision?: number): TransferRemoved {
  if (isClientMode()) {
    throw new TransferActionRejected('TRANSFER_PRIMARY_ONLY', 'a transfer is removed on the main computer — this window has no business database');
  }
  const reason = transferCorrectionReason(reasonIn);
  const row = query(`SELECT id, revision, status, invoice_id, settlement_paid_amount, stock_taken, transfer_number
    FROM agent_transfers WHERE id = ? AND branch_id = ?`, [transferId, branchId])[0];
  if (!row) throw new TransferActionRejected('TRANSFER_NOT_FOUND', 'no such transfer in this branch — it may already be removed');
  if (expectedRevision !== undefined && Number(row.revision ?? 0) !== expectedRevision) {
    throw new TransferActionRejected('RECORD_CHANGED',
      `this transfer changed since you opened it (you saw ${expectedRevision}, it is now ${Number(row.revision ?? 0)}) — reopen it`);
  }
  const plan = transferRemovePlan({
    status: String(row.status ?? ''), invoiceId: row.invoice_id ? String(row.invoice_id) : null,
    hasPayments: zahlungenErfasst(transferId, row.settlement_paid_amount), hasSalePosting: hasLedgerEntries('AGENT_TRANSFER_SOLD', transferId),
  });
  if ('code' in plan) throw new TransferActionRejected(plan.code, plan.message);
  if (plan.kind === 'cancel') {
    // Ein Altverkauf ohne Nachweis des Bestandsverbrauchs: das Stück ließe sich nicht genau zurücknehmen — nicht raten.
    if (!(Number(row.stock_taken ?? 0) > 0)) {
      throw new TransferActionRejected('TRANSFER_STOCK_UNKNOWN',
        'this is an older sale without a stock record — it cannot be cancelled automatically. Correct it with the accountant.');
    }
    const zu = verkaufsPeriodeGeschlossen(transferId, branchId);
    if (zu) throw new TransferActionRejected('TRANSFER_PERIOD_CLOSED', `${zu} — the sale is not cancelled any more`);
  }
  frischLesen();
  const buchung = watchLedgerPosts('remove transfer');
  const abgleich = watchSyncTracks('remove transfer');
  if (plan.kind === 'cancel') useAgentStore.getState().cancelTransfer(transferId, reason);
  else useAgentStore.getState().deleteTransfer(transferId, reason);
  buchung();
  abgleich();
  return { transferId, transferNumber: String(row.transfer_number ?? ''), kind: plan.kind === 'cancel' ? 'cancelled' : 'deleted' };
}

/** „Remove" am Primary — exklusiv, EINE Klammer, erst danach durabel. */
export function removeTransferOnPrimary(transferId: string, reason: string, expectedRevision?: number): Promise<TransferRemoved> {
  if (isClientMode()) {
    return Promise.reject(new TransferActionRejected('TRANSFER_PRIMARY_ONLY',
      'a transfer is removed on the main computer — this window has no business database'));
  }
  const branchId = currentBranchId();
  return runOnPrimary(() => removeTransferInHouse(transferId, branchId, reason, expectedRevision), frischLesen);
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

// CENTRAL-C4 — was ein Fernauftrag an RECHTEN braucht. Abgeschrieben, nicht erfunden.
//
// Die Regel dieses Schnitts in einem Satz: **PC2 darf aus der Ferne nicht mehr, als derselbe
// Benutzer am Primary vor sich hätte.**
//
// Bis hierher galt das nicht. Die Rolle des Fragenden reiste im geprüften Token mit, wurde in den
// Auftrag geschrieben — und nie gelesen. Ein Verkäufer, dessen Knopf „Advance to arrived" am
// Primary gar nicht erscheint (`perm.canManageOrders`), konnte denselben Vorgang aus der Ferne
// fahren. Das ist keine fehlende Funktion, sondern eine fehlende Prüfung.
//
// Was hier steht, ist deshalb KEINE neue Rollenarchitektur und kein neues Recht. Jede Zeile nennt
// den Bildschirm, von dem sie abgeschrieben ist, und benutzt dieselbe Ableitung wie er
// (`usePermission` → `roleHasPermission`). Wo der Primary heute GAR KEIN Tor hat, steht hier
// bewusst `null` — eine Sperre zu erfinden, die es lokal nicht gibt, wäre dieselbe Sorte Fehler
// in die andere Richtung.
//
// Geprüft wird an EINER Stelle: `executeCommand`, bevor der Handler läuft. Damit gilt für ein Nein
// dasselbe wie für einen unbekannten Namen — kein `runRemoteCommand`, kein Domänenaufruf, keine
// Zeile im durablen Nachweis, keine Wirkung.

import { isAdminOrManagerRole, isAdminRole, roleHasPermission } from '../auth/role-permissions';
import { STORE_READ_OPS } from './store-read-ops';

/** Wie ein Recht geprüft wird. Beides gibt es in `usePermission` schon so. */
export type PermissionRule =
  /** Ein benanntes Recht aus der Rollentabelle (`hasPermission('…')`). */
  | { readonly kind: 'permission'; readonly permission: string; readonly screen: string }
  /** Die Ableitung `isAdmin` der Oberfläche: ADMIN oder MANAGER. */
  | { readonly kind: 'isAdmin'; readonly screen: string }
  /** Eines von beiden reicht — z. B. `hasPermission('payments.*') || isAdmin`. */
  | { readonly kind: 'permissionOrAdmin'; readonly permission: string; readonly screen: string }
  /** R6E — die Ableitung `isOwner` der Oberfläche: nur ADMIN (z. B. „Cancel Return"). */
  | { readonly kind: 'isOwner'; readonly screen: string };

const perm = (permission: string, screen: string): PermissionRule =>
  ({ kind: 'permission', permission, screen });
const admin = (screen: string): PermissionRule => ({ kind: 'isAdmin', screen });
const permOrAdmin = (permission: string, screen: string): PermissionRule =>
  ({ kind: 'permissionOrAdmin', permission, screen });
const owner = (screen: string): PermissionRule => ({ kind: 'isOwner', screen });

/**
 * `canRecordPayments` = `hasPermission('payments.*') || isAdmin` — InvoiceDetail bewacht damit
 * „Record Payment", „Manage payments" und die Rückerstattung einer Rückgabe.
 */
const RECORD_PAYMENTS = permOrAdmin('payments.*', 'InvoiceDetail: perm.canRecordPayments');
/** `canCreateInvoices` = `hasPermission('invoices.create') || hasPermission('invoices.*')`. */
const CREATE_INVOICES = perm('invoices.create', 'InvoiceDetail/RepairDetail: perm.canCreateInvoices');
/** `canEditInvoices` = `isAdmin` — derselbe Knopf, der am Primary „Edit" zeigt. */
const EDIT_INVOICES = admin('InvoiceDetail: perm.canEditInvoices');
/**
 * B2/B3 SICHERHEIT A — Einkaufs- und Lieferantenzahlungen (Geld an den Lieferanten, Lieferantenguthaben auf einen Einkauf)
 * verlangen dasselbe Recht wie eine Rechnungszahlung. Vorher ohne Tor: PC2 konnte mit jeder Rolle bezahlen. Der Primary
 * zeigt die Knöpfe seither ebenso nur mit `perm.canRecordPayments` (PurchaseDetail „Add Payment", SupplierDetail
 * „Pay Supplier — Bulk"), und die lokale Speicherfolge (`payables-save`) prüft dieselbe Regel. Keine neue Rolle.
 */
const PURCHASE_PAYMENTS = permOrAdmin('payments.*', 'PurchaseDetail Add Payment / SupplierDetail Pay Supplier: perm.canRecordPayments');
/**
 * B2/B3 SICHERHEITSABSCHLUSS (10.11.2026) — Geld für Ausgaben (Record Payment, „Pay now"/„Partial" beim Anlegen, ein
 * Dauerauftrag, der jeden Monat sofort zahlt) verlangt dasselbe Recht wie jede andere Zahlung. Vorher ohne Tor (jede Rolle,
 * lokal und PC2). Das Anlegen OHNE Zahlung bleibt frei. Keine neue Rolle: dieselbe Ableitung `perm.canRecordPayments`.
 */
const EXPENSE_PAYMENTS = permOrAdmin('payments.*', 'PayExpenseModal / ExpenseList Pay now: perm.canRecordPayments');
/**
 * v0.8.101 S2 (Owner 11.11.2026: „Partnerzahlungen, Beiträge und Auszahlungen serverseitig absichern"; SALES erfasst keine
 * Zahlungen) — Geld zwischen LATAIF und einem Partner: Beitrag/Rückzahlung/Auszahlung an einem gemeinsamen Artikel, deren
 * Storno (nimmt eine Kassen-/Bankbuchung zurück) und die Gesellschafterbuchungen (Invest, Withdraw, Profit Share). Dieselbe
 * Ableitung `perm.canRecordPayments` wie jede andere Zahlung; Primary (Maske + Speicherfolge) und PC2 gleich. Keine neue Rolle.
 */
const PARTNER_PAYMENTS = permOrAdmin('payments.*', 'PartnerItemsPanel Pays in/Repays/Pay out/reverse, PartnersPage Invest/Withdraw/Profit Share: perm.canRecordPayments');

/**
 * B2/B3 SICHERHEITSABSCHLUSS — Operationen, die mit UND ohne Zahlung vorkommen: das Anlegen bleibt frei, der ZAHLUNGSTEIL
 * verlangt das Recht der Zahlungsoperation. Gibt die Operation zurück, deren Recht gilt — oder `null` (keine Zahlung dabei).
 * Geprüft an derselben Stelle wie das feste Tor (`executeCommand`) und von der lokalen Speicherfolge.
 */
export function paymentOpForPayload(op: string, body: unknown): string | null {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const pos = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
  switch (op) {
    case 'purchases.create': {
      const init = b.initialPayment && typeof b.initialPayment === 'object' ? (b.initialPayment as Record<string, unknown>).amount : undefined;
      const viele = Array.isArray(b.payments) && b.payments.some((p) => p && typeof p === 'object' && pos((p as Record<string, unknown>).amount));
      return pos(b.paymentAmount) || pos(init) || viele ? 'purchases.record_payment' : null;
    }
    case 'expenses.create':
      return b.timing === 'now' || b.timing === 'partial' ? 'expenses.record_payment' : null;
    case 'expenses.template_create':
    case 'expenses.template_update':
      return b.payNowDefault === true ? 'expenses.record_payment' : null;
    default:
      return null;
  }
}

/**
 * Die Zuordnung für alle vierzig verändernden Operationen. `null` heißt ausdrücklich: der Primary
 * hat für diese Aktion heute KEIN Rechte-Tor — der Fernweg erfindet keins.
 */
export const OPERATION_PERMISSIONS: Readonly<Record<string, PermissionRule | null>> = {
  // ── Rechnung ────────────────────────────────────────────────────────────
  'invoices.create': CREATE_INVOICES,
  'invoices.update': EDIT_INVOICES,
  'invoices.record_payment': RECORD_PAYMENTS,
  'invoices.apply_credit': RECORD_PAYMENTS,
  'invoices.update_payment': RECORD_PAYMENTS,
  'invoices.delete_payment': RECORD_PAYMENTS,
  // R5F.1 — „Cancel" steht nur, wenn `canCancel && perm.canEditInvoices`.
  'invoices.cancel': EDIT_INVOICES,

  // ── Stammdaten ──────────────────────────────────────────────────────────
  // ProductDetail: perm.canEditProducts / CustomerDetail: perm.canEditCustomers.
  'products.create': perm('products.edit', 'ProductDetail: perm.canEditProducts'),
  'products.update': perm('products.edit', 'ProductDetail: perm.canEditProducts'),
  'customers.create': perm('customers.edit', 'CustomerDetail: perm.canEditCustomers'),
  'customers.update': perm('customers.edit', 'CustomerDetail: perm.canEditCustomers'),

  // ── Einkauf ─────────────────────────────────────────────────────────────
  // BEFUND: `PurchaseDetail`/`PurchaseList` fragen `usePermission` gar nicht. Am Primary darf
  // jeder angemeldete Benutzer einen Einkauf anlegen. Hier deshalb kein Tor — und der Befund
  // steht im Bericht, statt still ein Recht zu erfinden.
  'purchases.create': null,

  // ── Auftrag ─────────────────────────────────────────────────────────────
  // OrderDetail bewacht JEDEN Knopf mit `perm.canManageOrders` (= isAdmin).
  'orders.create': admin('OrderDetail: perm.canManageOrders'),
  'orders.update': admin('OrderDetail: perm.canManageOrders'),
  'orders.update_status': admin('OrderDetail: perm.canManageOrders'),
  'orders.add_payment': admin('OrderDetail: perm.canManageOrders'),
  'orders.delete_payment': admin('OrderDetail: perm.canManageOrders'),
  'orders.convert_to_invoice': admin('OrderDetail: perm.canManageOrders'),

  // ── Kommission ──────────────────────────────────────────────────────────
  // ConsignmentDetail bewacht mit `perm.canManageConsignments` (= isAdmin).
  'consignments.create': admin('ConsignmentDetail: perm.canManageConsignments'),
  'consignments.update': admin('ConsignmentDetail: perm.canManageConsignments'),
  'consignments.record_sale': admin('ConsignmentDetail: perm.canManageConsignments'),
  'consignments.record_payout': admin('ConsignmentDetail: perm.canManageConsignments'),
  'consignments.mark_returned': admin('ConsignmentDetail: perm.canManageConsignments'),

  // ── Reparatur ───────────────────────────────────────────────────────────
  // RepairDetail: `perm.canManageRepairs` (= isAdmin) für Zustand und Arbeitszeilen,
  // `perm.canCreateInvoices` für die Rechnung.
  'repairs.create': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.update': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.update_status': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.add_line': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.update_line': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.cancel_line': admin('RepairDetail: perm.canManageRepairs'),
  'repairs.create_invoice': CREATE_INVOICES,

  // ── Agenten-Transfer ────────────────────────────────────────────────────
  // BEFUND: `TransferDetail` und `AgentDetail` benutzen `usePermission` NICHT. Am Primary hat
  // dieser Bereich heute kein Rechte-Tor. Kein erfundenes Recht — der Befund steht im Bericht.
  'transfers.create': null,
  'transfers.update': null,
  'transfers.mark_returned': null,
  'transfers.mark_sold': null,
  'transfers.mark_settled': null,
  'transfers.convert_to_invoice': null,
  'transfers.convert_many_to_invoice': null,

  // ── Rückgabe ────────────────────────────────────────────────────────────
  // BEFUND: „Create Return" in `InvoiceDetail` ist NICHT rechtegeschützt (nur zustandsgeprüft),
  // und `approveReturn` ruft die Oberfläche nur aus geschützten Wegen heraus — ein eigenes Tor
  // hat es nicht. Beides bleibt deshalb offen wie lokal. Wo Geld fließt, gilt dagegen dasselbe
  // Tor wie am Bildschirm: die Rückerstattung sitzt hinter `perm.canRecordPayments`.
  'returns.create': null,
  'returns.approve': null,
  'returns.refund': RECORD_PAYMENTS,
  'returns.record_refund_payment': RECORD_PAYMENTS,

  // ── Stammdaten (R6C) ────────────────────────────────────────────────────
  // BEFUND: `SupplierList`, `SupplierDetail`, `PurchaseCreate`, `RepairList`, `AgentList`,
  // `PartnersPage`, `EmployeeList` und `EmployeeDetail` fragen `usePermission` NICHT. Am Primary
  // darf jeder angemeldete Benutzer diese Stammdaten anlegen und ändern — der Fernweg erfindet kein
  // Recht (dieselbe Regel wie bei `purchases.create`). Der Befund steht im Bericht.
  'suppliers.create': null,
  'suppliers.update': null,
  'agents.update': null,
  'partners.create': null,
  'partners.update': null,
  'employees.create': null,
  'employees.update': null,

  // ── Inventur (R6C) ──────────────────────────────────────────────────────
  // BEFUND: `WatchList` („Stock Check"), `StockCheckInventoryModal` und `StockCheckPanel` sind am
  // Primary ohne Rechte-Tor. Kein erfundenes Recht.
  'inventory.start': null,
  'inventory.save': null,
  'inventory.finish': null,
  'inventory.record_check': null,

  // ── Steuer, Geld, Gold, Metall (R6D) ────────────────────────────────────
  // BEFUND: `AnalyticsPage` (Steuerzahlung), `BankingPage`, `PartnersPage`, `DebtsPage`,
  // `ExpenseList`, `PayExpenseModal`, `PurchaseDetail`, `SupplierDetail`, `PaySupplierModal`,
  // `CustomerDetail` (Kundengold), `SettleGoldModal`, `MetalList` und die Schrotthandel-Seiten
  // fragen `usePermission` NICHT; `RepairDetail` bewacht „Add Material" und „Gold Used" nicht.
  // Am Primary darf jeder angemeldete Benutzer das — der Fernweg erfindet kein Recht.
  // v0.8.101 S2: `PartnersPage` bewacht Invest/Withdraw/Profit Share seither mit `perm.canRecordPayments` (s. u.).
  'tax.record_payment': null,
  'banking.transfer': null,
  'partners.record_tx': PARTNER_PAYMENTS,
  'debts.create': null,
  'debts.update': null,
  'debts.record_payment': null,
  'expenses.create': null,
  'expenses.update': null,
  'expenses.record_payment': EXPENSE_PAYMENTS,
  'expenses.template_create': null,
  'expenses.template_update': null,
  'purchases.record_payment': PURCHASE_PAYMENTS,
  'purchases.apply_credit': PURCHASE_PAYMENTS,
  'suppliers.pay': PURCHASE_PAYMENTS,
  'suppliers.apply_credit': PURCHASE_PAYMENTS,
  'suppliers.refund_credit': PURCHASE_PAYMENTS,
  // Eine Gold-Verbindlichkeit ist am Primary über `SupplierDetail` ohne Tor abrechenbar — dass
  // `OrderDetail` dieselben Knöpfe hinter `perm.canManageOrders` stellt, macht die Handlung nicht
  // strenger: PC2 darf nicht weniger als derselbe Benutzer am Primary.
  'gold.payables.settle': null,
  'gold.customer_credits.settle': null,
  'repairs.record_gold_usage': null,
  'repairs.add_material': null,
  // OrderDetail: „Add Cost" und das Löschen einer Kostenzeile stehen hinter `perm.canManageOrders`.
  'orders.add_cost': admin('OrderDetail: perm.canManageOrders'),
  'orders.remove_cost': admin('OrderDetail: perm.canManageOrders'),
  'metals.create': null,
  'metals.update_status': null,
  'metals.set_spot_price': null,
  'scrap_trades.create': null,
  'scrap_trades.update': null,
  'scrap_trades.cancel': null,
  // BULK METAL V1 — Lot korrigieren, Write-off, Close: ADMIN oder MANAGER; Abschreibung stornieren: nur ADMIN.
  // Die Hausfolge prüft dieselbe Rolle noch einmal (assertRole).
  'bulk_metals.write_off': admin('BulkMetals: perm.isAdmin (Write off)'),
  'bulk_metals.close_lot': admin('BulkMetals: perm.isAdmin (Close lot)'),
  'bulk_metals.correct_weight': admin('BulkMetals: perm.isAdmin (Correct lot)'),
  'bulk_metals.reverse_adjustment': owner('BulkMetals: perm.isOwner (Reverse write-off)'),
  // STOCK CORRECTION — die Karte „Stock corrections" steht nur für `perm.isOwner`; die Hausfolge prüft es noch einmal.
  'stock_adjustments.issue': owner('ProductDetail: perm.isOwner (Stock corrections)'),
  'stock_adjustments.cancel': owner('ProductDetail: perm.isOwner (Stock corrections)'),
  'stock_adjustments.add_old_stock': owner('ProductDetail: perm.isOwner (Stock corrections — Add old stock)'),
  // OPENING BALANCES — der Bereich „Opening balances" in Edit Client / Supplier Edit steht nur für `perm.isOwner`; die
  // Hausfolge prüft es noch einmal (assertOwner).
  'opening_balances.create': owner('CustomerDetail/SupplierDetail Edit: perm.isOwner (Opening balances)'),
  'opening_balances.cancel': owner('CustomerDetail/SupplierDetail Edit: perm.isOwner (Opening balances)'),
  // SETTLEMENT — „Receive Payment" am Kunden: dasselbe Recht wie „Record Payment" auf der Rechnung.
  'customers.settle': RECORD_PAYMENTS,
  // INITIAL QTY — dieselbe Karte „Stock corrections" (nur `perm.isOwner`); die Hausfolge prüft es noch einmal.
  'stock_adjustments.correct_initial': owner('ProductDetail: perm.isOwner (Stock corrections — Correct initial qty)'),
  // B1 OPENING ACCOUNTING — Settings → Opening Balances steht nur für `perm.isOwner`; die Hausfolge prüft es noch einmal.
  'opening_accounts.create': owner('Settings → Opening Balances: perm.isOwner (record / correct an opening document)'),
  'opening_accounts.cancel': owner('Settings → Opening Balances: perm.isOwner (cancel an opening document)'),

  // ── Angebot, Rechnungs-Lebenszyklus, Nachrichten (R6E) ──────────────────
  // BEFUND: `OfferList` („New Offer", „Send", „Accept", „Reject") fragt `usePermission` NICHT, und
  // „Create Invoice" in `OfferDetail` steht ohne Tor. Nur das Bearbeiten (Kopf und Positionen) sitzt
  // hinter `perm.canEditOffers`. PC2 darf nicht weniger als derselbe Benutzer am Primary.
  'offers.create': null,
  'offers.update': perm('offers.edit', 'OfferDetail: perm.canEditOffers'),
  'offers.set_status': null,
  'offers.convert_to_invoice': null,
  // Butterfly steht neben „Edit" hinter `perm.canEditInvoices`.
  'invoices.set_butterfly': EDIT_INVOICES,
  // „Cancel Return" steht nur für `perm.isOwner`, und `cancelReturn` erzwingt es zusätzlich im Store.
  'returns.cancel': owner('InvoiceDetail: perm.isOwner (Cancel Return)'),
  // BEFUND wie bei allen Transfer-Buchungen: `TransferTable`/`TransferDetail` ohne Rechte-Tor.
  'transfers.undo_convert': null,
  // `MessagePreviewModal` (Kunde, Angebot, Auftrag, Reparatur) protokolliert ohne Tor.
  'customers.log_message': null,

  // ── Einkauf, Auftrag, Kommission, Produktion, Büro (R6F) ────────────────
  // BEFUND: `PurchaseDetail`/`PurchaseList`, `ProductionPage`, `TaskList` und `DocumentList` fragen
  // `usePermission` NICHT; die Zeilenstatus-Knöpfe in `OrderDetail` stehen ohne Tor. PC2 darf nicht
  // weniger als derselbe Benutzer am Primary.
  'purchases.return_to_supplier': null,
  'purchases.cancel': null,
  'purchases.dismiss_inbox': null,
  // PURCHASE-EDIT D11 — Notiz, Mitarbeiter, Ausweisfoto nach den bestehenden Einkaufsrechten (kein Tor, wie
  // `purchases.create`); die Finanzkorrektur und das Stornieren einer Zahlung nur der Owner (`perm.isOwner`) —
  // dieselbe Regel blendet die Maske am Primary ein.
  'purchases.update': null,
  'purchases.correct': owner('PurchaseDetail Edit: perm.isOwner (date, supplier, prices, quantities)'),
  'purchases.void_payment': owner('PurchaseDetail: perm.isOwner (void a payment)'),
  'purchases.correct_payment_date': owner('PurchaseDetail: perm.isOwner (correct a payment date)'),
  // CUSTOMER ACCOUNT C — „Settle Balance" und „Undo settlement" im Kundenkonto: dasselbe Recht wie „Record Payment"
  // (und wie „Remove offset" auf der Rechnung, `invoices.delete_payment`). Keine neue Rolle.
  'customers.settle_balance': RECORD_PAYMENTS,
  'customers.settlement_reverse': RECORD_PAYMENTS,
  // MEDIA-INBOX — dasselbe Recht wie das Anlegen eines Einkaufs: wer einkaufen darf, darf ein Foto
  // in den Posteingang legen. Am Telefon gibt es keine Maske, die ein eigenes Recht prüfen könnte;
  // die Rolle des geprüften Absenders entscheidet.
  'purchase_inbox.create': null,
  // OrderDetail: „Cancel Order", „Edit" einer Position und „Beim Supplier bestellen" hinter `perm.canManageOrders`.
  'orders.cancel': admin('OrderDetail: perm.canManageOrders'),
  'orders.update_line_status': null,
  'orders.mark_line_ordered': admin('OrderDetail: perm.canManageOrders'),
  'orders.update_line': admin('OrderDetail: perm.canManageOrders'),
  // ConsignmentDetail bewacht die Aktionen nach dem Verkauf mit `perm.canManageConsignments`.
  'consignments.return_after_sale': admin('ConsignmentDetail: perm.canManageConsignments'),
  'consignments.cancel_sale': admin('ConsignmentDetail: perm.canManageConsignments'),
  'production.create': null,
  // R7A — `ProductionDetail` fragt `usePermission` nicht (wie `ProductionPage` für das Anlegen).
  'production.complete': null,
  'tasks.create': null,
  'tasks.update': null,
  'documents.upload': null,
  'documents.set_ocr': null,
  // PARTNER-ITEMS — Geld (Beitrag, Rückzahlung, Auszahlung) und sein Storno: dasselbe Zahlungsrecht wie jede Zahlung
  // (v0.8.101 S2). Abrechnen, Verrechnen zwischen Artikeln, Übernahme und Partnerwechsel bewegen kein Geld: ohne Tor.
  'partner_items.record_movement': PARTNER_PAYMENTS,
  'partner_items.settle_sale': null,
  'partner_items.offset': null,
  'partner_items.cancel_movement': PARTNER_PAYMENTS,
  'partner_items.take_over': null,
  'partner_items.change_partners': null,
};

/**
 * CENTRAL-C4 FINAL — und die achtzehn AUSKÜNFTE.
 *
 * Der Befund zuerst, weil er das Ergebnis erklärt: **der Primary hat für Lesen kein einziges
 * Rechte-Tor.** Es gibt keinen Routen-Wächter, die Seitenleiste filtert nichts, und die
 * `.view`-Rechte der Rollentabelle (`products.view`, `invoices.view`, `kpi.view`) werden von
 * KEINEM Bildschirm abgefragt — `hasPermission` wird im ganzen `src/pages` und
 * `src/components` nie mit einem Leserecht aufgerufen. Wer sich am Primary anmeldet, sieht jedes
 * Modul.
 *
 * Also bekommt der Fernweg dasselbe: `null` für alle achtzehn. Ein Leserecht hier zu erfinden,
 * hieße, PC2 strenger zu machen als den Bildschirm daneben — und dann wäre die Zusage dieses
 * Schnitts („nicht mehr, aber auch nicht weniger als lokal") in der anderen Richtung gebrochen.
 * Der Befund steht im Bericht, nicht in einer stillen neuen Sperre.
 *
 * Was Auskünfte trotzdem begrenzt, und zwar hart: die FILIALE. Jede liest `actor.branchId` aus
 * den geprüften Ansprüchen und weist ohne sie ab (`BRANCH_REQUIRED`) — kein Rumpf kommt daran.
 */
export const READ_PERMISSIONS: Readonly<Record<string, PermissionRule | null>> = {
  'products.list': null, 'products.get': null, 'products.duplicates.get': null, 'products.sku_preview.get': null,
  'customers.list': null, 'customers.get': null,
  'invoices.list': null, 'invoices.get': null,
  'suppliers.list': null, 'categories.list': null,
  'purchases.list': null, 'purchases.get': null,
  'consignments.list': null, 'consignments.get': null,
  'orders.list': null, 'orders.get': null,
  'repairs.list': null, 'repairs.get': null,
  'transfers.list': null, 'transfers.get': null,
  // CENTRAL-UI-PARITY — die Store-Auskuenfte, mit denen der zweite Rechner DIESELBE Oberflaeche
  // fuellt. Sie stehen hier aus demselben Grund wie die 18 darueber auf `null`: der Primary
  // bewacht seine Anzeige nirgends mit einem Recht — jeder angemeldete Benutzer sieht dort alles.
  // Ein Tor hier waere kein Gleichstand, sondern eine ERFUNDENE Regel, die es lokal nicht gibt.
  // Der Befund bleibt derselbe wie in C4 und ist unveraendert offen: es gibt am Primary keine
  // allgemeinen Lese-Rechte. Aendert sich das, aendert es sich fuer beide Rechner zugleich.
  ...Object.fromEntries(STORE_READ_OPS.map((op) => [op, null])),
};

/** Das Recht, das diese Operation verlangt — `null`, wenn der Primary keins verlangt. */
export function permissionForOp(op: string): PermissionRule | null {
  return OPERATION_PERMISSIONS[op] ?? READ_PERMISSIONS[op] ?? null;
}

/** Ist diese Operation überhaupt bedacht — als Buchung ODER als Auskunft? */
export function isOperationCovered(op: string): boolean {
  return op in OPERATION_PERMISSIONS || op in READ_PERMISSIONS;
}

/**
 * Darf DIESE Rolle das? Fail-closed: eine fehlende oder leere Rolle darf nichts, was ein Recht
 * verlangt. Eine Operation ohne Tor bleibt ohne Tor.
 */
export function roleMayRunOp(role: string | null | undefined, op: string): boolean {
  const rule = permissionForOp(op);
  if (!rule) return true;
  switch (rule.kind) {
    case 'permission': return roleHasPermission(role, rule.permission);
    case 'isAdmin': return isAdminOrManagerRole(role);
    case 'permissionOrAdmin':
      return roleHasPermission(role, rule.permission) || isAdminOrManagerRole(role);
    case 'isOwner': return isAdminRole(role);
  }
}

/** Für die Begründung im Nein — sie nennt das Recht, nicht die Rolle des Fragenden. */
export function requiredPermissionLabel(op: string): string {
  const rule = permissionForOp(op);
  if (!rule) return '';
  if (rule.kind === 'isAdmin') return 'a manager or owner account';
  if (rule.kind === 'isOwner') return 'the owner account';
  return rule.permission;
}

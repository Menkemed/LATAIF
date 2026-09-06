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

import { isAdminOrManagerRole, roleHasPermission } from '../auth/role-permissions';

/** Wie ein Recht geprüft wird. Beides gibt es in `usePermission` schon so. */
export type PermissionRule =
  /** Ein benanntes Recht aus der Rollentabelle (`hasPermission('…')`). */
  | { readonly kind: 'permission'; readonly permission: string; readonly screen: string }
  /** Die Ableitung `isAdmin` der Oberfläche: ADMIN oder MANAGER. */
  | { readonly kind: 'isAdmin'; readonly screen: string }
  /** Eines von beiden reicht — z. B. `hasPermission('payments.*') || isAdmin`. */
  | { readonly kind: 'permissionOrAdmin'; readonly permission: string; readonly screen: string };

const perm = (permission: string, screen: string): PermissionRule =>
  ({ kind: 'permission', permission, screen });
const admin = (screen: string): PermissionRule => ({ kind: 'isAdmin', screen });
const permOrAdmin = (permission: string, screen: string): PermissionRule =>
  ({ kind: 'permissionOrAdmin', permission, screen });

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
};

/** Das Recht, das diese Operation verlangt — `null`, wenn der Primary keins verlangt. */
export function permissionForOp(op: string): PermissionRule | null {
  return OPERATION_PERMISSIONS[op] ?? null;
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
  }
}

/** Für die Begründung im Nein — sie nennt das Recht, nicht die Rolle des Fragenden. */
export function requiredPermissionLabel(op: string): string {
  const rule = permissionForOp(op);
  if (!rule) return '';
  return rule.kind === 'isAdmin' ? 'a manager or owner account' : rule.permission;
}

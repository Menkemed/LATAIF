import { useAuthStore } from '@/stores/authStore';
import { canonicalRole } from '@/core/models/types';

/**
 * Quick permission check hooks.
 * Plan §Users §4 canonical roles: ADMIN / MANAGER / SALES / ACCOUNTANT.
 * Legacy values (owner/manager/sales/backoffice/viewer) werden via canonicalRole() normalisiert.
 */
export function usePermission() {
  const { hasPermission, role } = useAuthStore();
  const canonical = canonicalRole(role());
  const isOwner = canonical === 'ADMIN';      // Plan: ADMIN = vollständige Kontrolle
  const isManager = canonical === 'MANAGER';
  const isAdmin = isOwner || isManager;

  return {
    role: role(),
    isOwner,
    isManager,
    isAdmin,
    can: hasPermission,

    // Shortcuts
    canEditProducts: hasPermission('products.edit'),
    canDeleteProducts: isAdmin,
    canEditCustomers: hasPermission('customers.edit'),
    canDeleteCustomers: isAdmin,
    canCreateOffers: hasPermission('offers.create') || hasPermission('offers.*'),
    canEditOffers: hasPermission('offers.edit') || hasPermission('offers.*'),
    canDeleteOffers: isAdmin,
    canCreateInvoices: hasPermission('invoices.create') || hasPermission('invoices.*'),
    canEditInvoices: isAdmin,
    canDeleteInvoices: isOwner, // only owner can delete invoices
    canRecordPayments: hasPermission('payments.*') || isAdmin,
    canManageRepairs: isAdmin,
    canDeleteRepairs: isAdmin,
    canManageConsignments: isAdmin,
    canManageAgents: isAdmin,
    canManageOrders: isAdmin,
    canDeleteOrders: isAdmin,
    canManageSettings: isOwner,
    canManageUsers: isOwner,
    canViewAnalytics: hasPermission('kpi.view') || hasPermission('kpi.view_own'),
    canExportData: isAdmin,
  };
}

// CENTRAL-C4 — welche Rechte eine ROLLE hat. EINE Quelle, jetzt auch ohne Sitzung fragbar.
//
// Diese Tabelle stand bisher IN `authService.hasPermission`, und sie war dort nur über die
// aktuelle Sitzung dieses Rechners erreichbar (`this.getSession()`). Für einen Bildschirm ist das
// richtig; für einen Fernauftrag ist es falsch, und zwar gefährlich falsch: der Fragende sitzt an
// einem anderen Rechner, und was ER darf, steht in SEINEM geprüften Token — nicht in der Sitzung
// des Menschen, der am Primary gerade angemeldet ist.
//
// Deshalb wird hier NICHTS erfunden. Es ist dieselbe Tabelle, wortgleich, nur als reine Funktion
// über eine ausdrücklich übergebene Rolle. `authService.hasPermission` ruft sie mit der eigenen
// Sitzung; der Fernweg ruft sie mit der Rolle aus den Ansprüchen des Tokens. Zwei Aufrufer, eine
// Wahrheit — und keine zweite Rollenarchitektur.

import { canonicalRole, type CanonicalUserRole } from '../models/types';

/**
 * Plan §Users §4+§5 — ADMIN/MANAGER/SALES/ACCOUNTANT mit granularen
 * VIEW/CREATE/EDIT/DELETE/APPROVE-Rechten. Alte Rollennamen (owner/manager/sales/backoffice/
 * viewer) normalisiert `canonicalRole`.
 */
export const ROLE_PERMISSIONS: Record<CanonicalUserRole, readonly string[]> = {
  // Plan §Users §4A: ADMIN — voller Zugriff
  ADMIN: ['*'],
  // Plan §Users §4B: MANAGER — Zugriff auf alle Module, eingeschränkte Admin-Rechte
  MANAGER: [
    'products.*', 'customers.*', 'offers.*', 'invoices.*', 'payments.*',
    'tasks.*', 'documents.*', 'repairs.*', 'consignments.*', 'agents.*',
    'orders.*', 'suppliers.*', 'purchases.*', 'expenses.*', 'banking.*',
    'partners.view', 'production.*', 'returns.*',
    'kpi.*', 'reports.*', 'settings.view', 'users.view',
  ],
  // Plan §Users §4C: SALES — Sales erlaubt, keine sensiblen Daten
  SALES: [
    'products.view', 'products.create', 'products.edit',
    'customers.view', 'customers.create', 'customers.edit',
    'offers.*', 'invoices.view', 'invoices.create', 'invoices.edit',
    'payments.view', 'payments.create',
    'tasks.view', 'tasks.edit', 'documents.upload', 'documents.view',
    'repairs.view', 'repairs.create', 'kpi.view_own',
  ],
  // Plan §Users §4D: ACCOUNTANT — Finance-Fokus
  ACCOUNTANT: [
    'products.view', 'customers.view',
    'invoices.*', 'payments.*', 'banking.*', 'expenses.*',
    'purchases.view', 'purchases.payments',
    'suppliers.view',
    'reports.*', 'kpi.*', 'tax.*',
    'partners.view', 'debts.*',
    'documents.view',
  ],
};

/**
 * Hat DIESE Rolle dieses Recht? Fail-closed: eine leere, fehlende oder unbekannte Rolle hat
 * nichts. `canonicalRole` bildet Altnamen ab; was es nicht kennt, fällt auf die schwächste
 * Auslegung — und die trifft hier keine Zeile der Tabelle.
 */
export function roleHasPermission(role: string | null | undefined, permission: string): boolean {
  const raw = typeof role === 'string' ? role.trim() : '';
  if (raw === '') return false;
  const canonical = canonicalRole(raw);
  const perms = ROLE_PERMISSIONS[canonical] ?? [];
  if (perms.includes('*')) return true;
  return perms.some((p) => {
    if (p === permission) return true;
    if (p.endsWith('.*')) return permission.startsWith(p.slice(0, -2));
    return false;
  });
}

/** `ADMIN` — die Rolle, an der die Oberfläche ihre `isOwner`-Knöpfe festmacht. */
export function isAdminRole(role: string | null | undefined): boolean {
  const raw = typeof role === 'string' ? role.trim() : '';
  return raw !== '' && canonicalRole(raw) === 'ADMIN';
}

/**
 * `isAdmin` der Oberfläche — ADMIN ODER MANAGER. Der Name stammt aus `usePermission`, wo genau
 * diese Ableitung die Knöpfe für Aufträge, Reparaturen und Kommissionen bewacht.
 */
export function isAdminOrManagerRole(role: string | null | undefined): boolean {
  const raw = typeof role === 'string' ? role.trim() : '';
  if (raw === '') return false;
  const c = canonicalRole(raw);
  return c === 'ADMIN' || c === 'MANAGER';
}

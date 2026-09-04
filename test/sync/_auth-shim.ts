// Nur fuer Tests: `core/db/helpers.ts` importiert die Anmeldung fuer `currentBranchId()` und
// `currentUserId()`. Der ECHTE Nummerngeber braucht davon nichts — gestellt wird nur so viel, dass
// das Modul laedt.
export const authService = {
  getCurrentUser(): { id: string; branchId: string } | null { return { id: 'user-test', branchId: 'branch-main' }; },
  getSession(): { userId: string; branchId: string } | null { return { userId: 'user-test', branchId: 'branch-main' }; },
  // CENTRAL-C3B: die zwei Namen, die `helpers.ts` wirklich ruft. Ohne sie warf `currentBranchId()`,
  // und jeder Aufrufer mit einem `try/catch` fiel still auf einen Ersatzwert zurueck — der ECHTE
  // Rechnungsweg sah dann seine eigene Rechnung nicht mehr wieder.
  getCurrentBranchId(): string { return 'branch-main'; },
  getCurrentUserId(): string { return 'user-test'; },
};

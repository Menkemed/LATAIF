// Nur fuer Tests: `core/db/helpers.ts` importiert die Anmeldung fuer `currentBranchId()` und
// `currentUserId()`. Der ECHTE Nummerngeber braucht davon nichts — gestellt wird nur so viel, dass
// das Modul laedt.
export const authService = {
  getCurrentUser(): { id: string; branchId: string } | null { return { id: 'user-test', branchId: 'branch-main' }; },
  getSession(): { userId: string; branchId: string } | null { return { userId: 'user-test', branchId: 'branch-main' }; },
};

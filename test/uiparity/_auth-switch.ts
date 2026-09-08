// Nur fuer Tests: eine Anmeldung, deren Filiale sich UMSCHALTEN laesst.
//
// Der feste Shim aus `test/sync` liefert immer `branch-main`. Fuer die Frage dieses Schnitts —
// "liest eine Fernabfrage die Filiale des PRIMARY-Benutzers oder die des Anfragenden?" — braucht
// es genau diesen Unterschied: der Primary sitzt in Filiale A, der Client kommt aus B.

let branchId = 'branch-a';
let userId = 'user-a';

export function setPrimarySession(b: string, u = 'user-a'): void { branchId = b; userId = u; }

export const authService = {
  getCurrentUser(): { id: string; branchId: string } | null { return { id: userId, branchId }; },
  getSession(): { userId: string; branchId: string } | null { return { userId, branchId }; },
  getCurrentBranchId(): string { return branchId; },
  getCurrentUserId(): string { return userId; },
};

// ════════════════════════════════════════════════════════════════════════════
// v0.8.101 S2 — dieselbe Rechte-Regel für die lokale Speicherfolge am Primary wie für den Fernweg (`executeCommand`):
// `roleMayRunOp` aus der Rechte-SSOT (`command-permissions.ts`), mit der Rolle der angemeldeten Sitzung. Fail-closed:
// ohne Rolle kein Recht. Kein neues Recht, keine neue Rolle — nur der gemeinsame Anschluss für Masken ohne eigenen.
// ════════════════════════════════════════════════════════════════════════════
import { useAuthStore } from '@/stores/authStore';
import { requiredPermissionLabel, roleMayRunOp } from '@/core/bridge/command-permissions';
import type { WriteOutcome } from '@/core/data/shared-write';

/** `null`, wenn die angemeldete Rolle `op` ausführen darf; sonst die Absage (wie PC2: PERMISSION_DENIED). */
export function localPermissionDenied<T>(op: string): WriteOutcome<T> | null {
  let role: string | undefined;
  try { role = useAuthStore.getState().role(); } catch { role = undefined; }
  if (roleMayRunOp(role, op)) return null;
  return { kind: 'business_error', code: 'PERMISSION_DENIED', message: `this account may not run ${op} — it needs ${requiredPermissionLabel(op)}` };
}

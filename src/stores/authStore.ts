import { create } from 'zustand';
import { authService, type Session, type UserBranch } from '@/core/auth/auth';
import { readsFromPrimary } from '@/core/data/primary-source';
import type { UserRole } from '@/core/models/types';

/**
 * MEDIA-04A-3B2B-R5 — fire startup media recovery + embedding reconciliation
 * once a session (branch/tenant) is available. Dynamic import breaks the
 * store→store cycle; fire-and-forget so it never blocks auth. Idempotent:
 * recovery is once-per-epoch, reconciliation is guarded per product.
 */
function triggerMediaRecoveryPostAuth(): void {
  // CENTRAL-UI-PARITY R4A — dieser Nachlauf gehoert zur MASCHINE, auf der die Datenbank steht:
  // Medien-Wiederherstellung, Einbettungen, der durable Posteingang der Telefone. Auf einem
  // Rechner ohne Datenbank greift jeder dieser Schritte ins Leere — sichtbar als abgewiesene
  // Zusage bei JEDEM Seitenaufbau. Er wird dort deshalb gar nicht erst angestossen.
  if (readsFromPrimary()) return;
  void import('@/stores/productStore')
    .then((m) => m.triggerStartupMediaRecovery())
    .catch(() => { /* never blocks auth */ })
    // MOBILE-04B2A2 — only AFTER media startup recovery completes: drain the durable Rust mobile
    // upload inbox into the product/media pipeline. Fire-and-forget and fully guarded — a no-op
    // without an authenticated scope or without Tauri (web preview), and never blocks auth.
    .finally(() => {
      void Promise.all([import('@/core/media/mobile-upload-wiring'), import('@/core/db/database')])
        .then(([w, db]) => {
          w.triggerMobileUploadDrainPostAuth(db.currentDbEpoch());
          // MOBILE-04B2A13 — also ARM the bounded drain poller so a job that ARRIVES AFTER this login is
          // processed without a fresh login. Arming is scope-gated: it registers a timer ONLY when a
          // matching binding is already configured (no binding → no timer). A later owner configure arms
          // it via SettingsPage. The immediate trigger above is preserved.
          w.armMobileDrainPoller();
        })
        .catch(() => { /* never blocks auth */ });
      // MOBILE-04B2A12-U1 — expose the safe restore surface (list + owner-gated restore orchestration) on
      // window. Additive, no auto-run; a Danger-Zone UI (U2) will call it. No path ever crosses the bridge.
      void import('@/core/lifecycle/restore-wiring')
        .then((m) => m.installRestoreBridge())
        .catch(() => { /* never blocks auth */ });
    });
}

interface AuthStore {
  session: Session | null;
  branches: UserBranch[];
  loading: boolean;
  error: string | null;

  initialize: () => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  switchBranch: (branchId: string) => void;
  isAuthenticated: () => boolean;
  branchId: () => string;
  userId: () => string;
  role: () => UserRole;
  hasPermission: (perm: string) => boolean;
}

/**
 * CENTRAL-UI-PARITY R3 — die Filialen eines Benutzers, auch ohne Datenbank.
 *
 * Am Primary stehen sie in `user_branches`. Auf einem Rechner ohne Datenbank gibt es diese
 * Tabelle nicht — und der Aufruf warf. Das war kein kleiner Fehler: er warf WAEHREND des
 * Anmeldens, also im Aufbau der Anwendung, und liess einen komplett weissen Bildschirm zurueck.
 *
 * Die ehrliche Antwort dort ist die Filiale, die im geprueften Ausweis steht — es ist genau eine,
 * und mehr darf dieser Rechner ohnehin nicht sehen.
 */
function branchesFor(session: Session): UserBranch[] {
  try {
    return authService.getUserBranches(session.userId);
  } catch {
    return [{
      branchId: session.branchId,
      branchName: session.branch?.name || '',
      role: session.role,
      isDefault: true,
    }];
  }
}
export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  branches: [],
  loading: false,
  error: null,

  initialize: () => {
    const session = authService.getSession();
    if (session) {
      const branches = branchesFor(session);
      set({ session, branches });
      triggerMediaRecoveryPostAuth();
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const session = await authService.login(email, password);
      const branches = branchesFor(session);
      set({ session, branches, loading: false });
      // MEDIA-04A-3B2B-R5: with the branch/tenant now available, drive startup
      // media recovery + embedding reconciliation. Recovery itself is
      // once-per-epoch (a no-op if the boot pass already ran); the reconciliation
      // re-scans and can now start embeddings that needed an authenticated,
      // AI-configured session. Fire-and-forget, never blocks login.
      triggerMediaRecoveryPostAuth();
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
      throw err;
    }
  },

  logout: () => {
    authService.logout();
    set({ session: null, branches: [] });
    // MOBILE-04B2A13 — stop the bounded drain poller on logout (no polling/claim without a session).
    void import('@/core/media/mobile-upload-wiring')
      .then((w) => w.stopMobileDrainPoller())
      .catch(() => { /* nothing to stop / no Tauri */ });
  },

  switchBranch: (branchId) => {
    const session = authService.switchBranch(branchId);
    set({ session });
  },

  isAuthenticated: () => get().session !== null,
  branchId: () => get().session?.branchId || '',
  userId: () => get().session?.userId || '',
  role: () => get().session?.role || 'viewer',
  hasPermission: (perm) => authService.hasPermission(perm),
}));

import { create } from 'zustand';
import { authService, type Session, type UserBranch } from '@/core/auth/auth';
import type { UserRole } from '@/core/models/types';

/**
 * MEDIA-04A-3B2B-R5 — fire startup media recovery + embedding reconciliation
 * once a session (branch/tenant) is available. Dynamic import breaks the
 * store→store cycle; fire-and-forget so it never blocks auth. Idempotent:
 * recovery is once-per-epoch, reconciliation is guarded per product.
 */
function triggerMediaRecoveryPostAuth(): void {
  void import('@/stores/productStore')
    .then((m) => m.triggerStartupMediaRecovery())
    .catch(() => { /* never blocks auth */ })
    // MOBILE-04B2A2 — only AFTER media startup recovery completes: drain the durable Rust mobile
    // upload inbox into the product/media pipeline. Fire-and-forget and fully guarded — a no-op
    // without an authenticated scope or without Tauri (web preview), and never blocks auth.
    .finally(() => {
      void Promise.all([import('@/core/media/mobile-upload-wiring'), import('@/core/db/database')])
        .then(([w, db]) => w.triggerMobileUploadDrainPostAuth(db.currentDbEpoch()))
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

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  branches: [],
  loading: false,
  error: null,

  initialize: () => {
    const session = authService.getSession();
    if (session) {
      const branches = authService.getUserBranches(session.userId);
      set({ session, branches });
      triggerMediaRecoveryPostAuth();
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const session = await authService.login(email, password);
      const branches = authService.getUserBranches(session.userId);
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

import { create } from 'zustand';
import { authService, type Session, type UserBranch } from '@/core/auth/auth';
import type { UserRole } from '@/core/models/types';

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
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null });
    try {
      const session = await authService.login(email, password);
      const branches = authService.getUserBranches(session.userId);
      set({ session, branches, loading: false });
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

// ═══════════════════════════════════════════════════════════
// LATAIF — Authentication & Session Management
// Multi-Branch, Offline-Capable
// ═══════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '../db/database';
import type { UserRole, CanonicalUserRole } from '../models/types';
import { canonicalRole } from '../models/types';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  phone?: string;
  avatarPath?: string;
}

export interface UserBranch {
  branchId: string;
  branchName: string;
  role: UserRole;
  isDefault: boolean;
}

export interface Session {
  userId: string;
  branchId: string;
  role: UserRole;
  token: string;
  user: AuthUser;
  branch: { id: string; name: string; country: string; currency: string };
}

// Simple hash for offline auth (not for production server auth)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'lataif_salt_2026');
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class AuthService {
  private currentSession: Session | null = null;

  getSession(): Session | null {
    if (this.currentSession) return this.currentSession;
    // Try to restore from localStorage
    const saved = localStorage.getItem('lataif_session');
    if (saved) {
      try {
        this.currentSession = JSON.parse(saved);
        return this.currentSession;
      } catch { /* ignore */ }
    }
    return null;
  }

  isAuthenticated(): boolean {
    return this.getSession() !== null;
  }

  getCurrentBranchId(): string {
    const session = this.getSession();
    if (!session) throw new Error('Not authenticated');
    return session.branchId;
  }

  getCurrentUserId(): string {
    const session = this.getSession();
    if (!session) throw new Error('Not authenticated');
    return session.userId;
  }

  getCurrentRole(): UserRole {
    const session = this.getSession();
    if (!session) throw new Error('Not authenticated');
    return session.role;
  }

  async login(email: string, password: string): Promise<Session> {
    const db = getDatabase();
    const hash = await hashPassword(password);

    const result = db.exec(
      `SELECT id, email, name, phone, avatar_path FROM users WHERE email = ? AND password_hash = ? AND active = 1`,
      [email, hash]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      throw new Error('Invalid email or password');
    }

    const row = result[0].values[0];
    const user: AuthUser = {
      id: row[0] as string,
      email: row[1] as string,
      name: row[2] as string,
      phone: row[3] as string | undefined,
      avatarPath: row[4] as string | undefined,
    };

    // Get user's branches
    const branches = this.getUserBranches(user.id);
    if (branches.length === 0) throw new Error('No branch assigned');

    const defaultBranch = branches.find(b => b.isDefault) || branches[0];

    // Get branch details
    const branchResult = db.exec(
      `SELECT id, name, country, currency FROM branches WHERE id = ?`,
      [defaultBranch.branchId]
    );

    const branchRow = branchResult[0]?.values[0];
    if (!branchRow) throw new Error('Branch not found');

    const token = uuid();
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days

    db.run(
      `INSERT INTO sessions (id, user_id, branch_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuid(), user.id, defaultBranch.branchId, token, expiresAt, now]
    );

    db.run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [now, user.id]);
    await saveDatabase();

    const session: Session = {
      userId: user.id,
      branchId: defaultBranch.branchId,
      role: defaultBranch.role,
      token,
      user,
      branch: {
        id: branchRow[0] as string,
        name: branchRow[1] as string,
        country: branchRow[2] as string,
        currency: branchRow[3] as string,
      },
    };

    this.currentSession = session;
    localStorage.setItem('lataif_session', JSON.stringify(session));
    return session;
  }

  switchBranch(branchId: string): Session {
    const session = this.getSession();
    if (!session) throw new Error('Not authenticated');

    const branches = this.getUserBranches(session.userId);
    const target = branches.find(b => b.branchId === branchId);
    if (!target) throw new Error('No access to this branch');

    const db = getDatabase();
    const branchResult = db.exec(
      `SELECT id, name, country, currency FROM branches WHERE id = ?`, [branchId]
    );
    const branchRow = branchResult[0]?.values[0];
    if (!branchRow) throw new Error('Branch not found');

    const newSession: Session = {
      ...session,
      branchId: target.branchId,
      role: target.role,
      branch: {
        id: branchRow[0] as string,
        name: branchRow[1] as string,
        country: branchRow[2] as string,
        currency: branchRow[3] as string,
      },
    };

    this.currentSession = newSession;
    localStorage.setItem('lataif_session', JSON.stringify(newSession));
    return newSession;
  }

  getUserBranches(userId: string): UserBranch[] {
    const db = getDatabase();
    const result = db.exec(
      `SELECT ub.branch_id, b.name, ub.role, ub.is_default
       FROM user_branches ub
       JOIN branches b ON b.id = ub.branch_id
       WHERE ub.user_id = ? AND b.active = 1`,
      [userId]
    );

    if (result.length === 0) return [];
    return result[0].values.map((row: unknown[]) => ({
      branchId: row[0] as string,
      branchName: row[1] as string,
      role: row[2] as UserRole,
      isDefault: row[3] === 1,
    }));
  }

  logout(): void {
    if (this.currentSession) {
      const db = getDatabase();
      db.run(`DELETE FROM sessions WHERE token = ?`, [this.currentSession.token]);
      saveDatabase();
    }
    this.currentSession = null;
    localStorage.removeItem('lataif_session');
  }

  async register(email: string, password: string, name: string, branchId: string, role: UserRole = 'viewer'): Promise<AuthUser> {
    const db = getDatabase();
    const now = new Date().toISOString();
    const id = uuid();
    const hash = await hashPassword(password);

    // Check if email exists
    const existing = db.exec(`SELECT id FROM users WHERE email = ?`, [email]);
    if (existing.length > 0 && existing[0].values.length > 0) {
      throw new Error('Email already registered');
    }

    db.run(
      `INSERT INTO users (id, email, password_hash, name, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [id, email, hash, name, now, now]
    );

    db.run(
      `INSERT INTO user_branches (user_id, branch_id, role, is_default, created_at)
       VALUES (?, ?, ?, 1, ?)`,
      [id, branchId, role, now]
    );

    saveDatabase();
    return { id, email, name };
  }

  hasPermission(permission: string): boolean {
    const session = this.getSession();
    if (!session) return false;

    // Plan §Users §4+§5: ADMIN/MANAGER/SALES/ACCOUNTANT mit granularen VIEW/CREATE/EDIT/DELETE/APPROVE.
    // Legacy-Rollen werden via canonicalRole normalisiert.
    const canonical = canonicalRole(session.role);
    const rolePermissions: Record<CanonicalUserRole, string[]> = {
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

    const perms = rolePermissions[canonical] || [];
    if (perms.includes('*')) return true;

    return perms.some(p => {
      if (p === permission) return true;
      if (p.endsWith('.*')) {
        const prefix = p.slice(0, -2);
        return permission.startsWith(prefix);
      }
      return false;
    });
  }
}

export const authService = new AuthService();

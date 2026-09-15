// ═══════════════════════════════════════════════════════════
// LATAIF — Authentication & Session Management
// Multi-Branch, Offline-Capable
// ═══════════════════════════════════════════════════════════

import { v4 as uuid } from 'uuid';
import { getDatabase, saveDatabase } from '../db/database';
import type { UserRole } from '../models/types';
import { roleHasPermission } from './role-permissions';
import { isClientMode, setClientToken } from '../bridge/client-mode';

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

  /**
   * POST-PARITY R7B PP-5 — die gespeicherte Sitzung am Primary-Start PRÜFEN, statt sie zu glauben.
   *
   * `lataif_session` ist nur ein Merkzettel im Seitenspeicher. War dieser Rechner vorher PC2, liegt
   * dort womöglich die Sitzung eines FREMDEN Primary (ein JWT statt eines eigenen Tokens, fremde
   * Filiale, fremde Rolle) — und `getSession()` übernahm sie ohne jede Frage, samt Eigentümerrechten.
   * Gültig ist sie hier nur, wenn DIESE Datenbank sie ausgestellt hat (`sessions.token`), der
   * Benutzer aktiv ist und die Filiale noch hat. Die Rolle kommt dabei frisch aus `user_branches`,
   * nicht aus dem Merkzettel. Sonst wird sie verworfen und es geht zur Anmeldung.
   *
   * R7B-Review — auch die Ablaufzeit gilt aus DIESER Datenbank (`sessions.expires_at`, von `login`
   * als ISO-Zeit geschrieben): abgelaufen oder kein lesbarer Zeitpunkt → verworfen. Scheitert die
   * Prüfung selbst, gilt die Sitzung ebenfalls nicht — eine ungeprüfte Sitzung ist keine bestätigte.
   */
  verifyStoredSession(): 'kept' | 'dropped' | 'none' {
    let saved: string | null = null;
    try { saved = localStorage.getItem('lataif_session'); } catch { return 'none'; }
    if (!saved) return 'none';
    const drop = (reason: string): 'dropped' => this.discardStoredSession(reason);
    let s: Session;
    try { s = JSON.parse(saved) as Session; } catch { return drop('unreadable'); }
    if (!s || typeof s.token !== 'string' || typeof s.userId !== 'string' || typeof s.branchId !== 'string') return drop('incomplete');
    try {
      const db = getDatabase();
      const has = (sql: string, p: unknown[]): boolean => (db.exec(sql, p)[0]?.values?.length ?? 0) > 0;
      const r = db.exec(
        `SELECT ub.role, se.expires_at FROM sessions se
           JOIN users u ON u.id = se.user_id AND u.active = 1
           JOIN user_branches ub ON ub.user_id = u.id AND ub.branch_id = ?
           JOIN branches b ON b.id = ub.branch_id AND b.active = 1
          WHERE se.token = ? AND se.user_id = ?
          LIMIT 1`,
        [s.branchId, s.token, s.userId],
      );
      const role = r[0]?.values[0]?.[0];
      if (typeof role !== 'string' || !role) {
        if (!has('SELECT 1 FROM sessions WHERE token = ?', [s.token])) return drop(`not-issued-here (${has('SELECT 1 FROM sessions', []) ? 'other sessions exist' : 'no sessions'})`);
        if (!has('SELECT 1 FROM sessions WHERE token = ? AND user_id = ?', [s.token, s.userId])) return drop('other-user');
        if (!has('SELECT 1 FROM users WHERE id = ? AND active = 1', [s.userId])) return drop('user-inactive');
        return drop('no-branch-access');
      }
      const expiresAt = r[0]?.values[0]?.[1];
      const until = typeof expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(expiresAt.trim()) ? Date.parse(expiresAt.trim()) : NaN;
      if (!Number.isFinite(until)) return drop('expiry-unreadable');
      if (until <= Date.now()) return drop('expired');
      const verified: Session = { ...s, role: role as UserRole };
      this.currentSession = verified;
      localStorage.setItem('lataif_session', JSON.stringify(verified));
      return 'kept';
    } catch (e) {
      return drop(`check-failed (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  /** Die gespeicherte Sitzung verwerfen: Merkzettel weg, nichts angemeldet. Der Grund steht im
   *  Protokoll (und für diese Sitzung des Fensters abrufbar) — nie das Token. */
  discardStoredSession(reason: string): 'dropped' {
    this.currentSession = null;
    try { localStorage.removeItem('lataif_session'); } catch { /* kein Speicher */ }
    console.warn('[auth] stored session not accepted:', reason);
    try { sessionStorage.setItem('lataif_session_check', reason); } catch { /* kein Speicher */ }
    return 'dropped';
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
    // CENTRAL-UI-PARITY R6B — ein Rechner ohne eigene Datenbank hat keine `sessions`-Tabelle: der
    // Griff danach warf, BEVOR die Sitzung geleert war, und niemand kam mehr hinaus. Abmelden ist
    // dort rein lokal — Sitzung und Ausweis weg, zurück zum Verbinden/Anmelden. Der Primary prüft
    // ohnehin jede Anfrage; ein vergessener Ausweis kann nichts mehr.
    if (isClientMode()) {
      this.currentSession = null;
      try { localStorage.removeItem('lataif_session'); } catch { /* kein Speicher */ }
      setClientToken(null);
      return;
    }
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
    // CENTRAL-C4 — die Tabelle steht in `role-permissions`, damit sie AUCH ohne Sitzung
    // fragbar ist: ein Fernauftrag kommt von einem anderen Rechner, und was SEIN Absender darf,
    // steht in dessen geprueftem Token — nicht in der Sitzung dieses Bildschirms. Hier wird
    // dieselbe Tabelle mit der eigenen Rolle gefragt.
    return roleHasPermission(session.role, permission);
  }

}

export const authService = new AuthService();

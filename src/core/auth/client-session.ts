// CENTRAL-UI-PARITY — die Sitzung auf einem Rechner, der keine Benutzertabelle hat.
//
// Am Primary entsteht die Sitzung beim Anmelden aus der eigenen Datenbank. PC2 hat keine. Was es
// dort gibt, ist der gepruefte Ausweis, den der Primary ausgestellt hat — und in dem steht bereits
// alles, was die Oberflaeche braucht: wer, welcher Mandant, welche Filiale, welche Rolle.
//
// Zwei Dinge sind dabei wichtig:
//
//   1. **Nichts davon wird geglaubt, sondern nur ANGEZEIGT.** Der Ausweis ist auf dem Server
//      signiert; jede Anfrage wird dort erneut geprueft und die Rolle bei JEDEM Zugriff frisch aus
//      der Benutzertabelle gelesen (C4 FINAL). Wer hier von Hand eine andere Rolle einträgt,
//      aendert nur, welche Knoepfe sein eigener Bildschirm zeigt — nicht, was der Primary tut.
//   2. **Es entsteht keine zweite Wahrheit.** Gespeichert wird derselbe Kontrollzustand wie
//      bisher: Adresse, Ausweis, Sitzung. Keine Geschaeftsdaten, keine Datenbank.

import type { Session } from './auth';
import type { UserRole } from '@/core/models/types';

/** Die Felder, die der Primary in den Ausweis schreibt (`sync/auth.rs`). */
interface Claims {
  readonly sub?: string;
  readonly tenant_id?: string;
  readonly branch_id?: string;
  readonly role?: string;
  readonly email?: string;
  readonly name?: string;
}

/** Den Rumpf eines JWT lesen. Ohne Pruefung — die passiert am Server, hier wird nur angezeigt. */
export function readClaims(token: string): Claims | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as Claims;
  } catch {
    return null;
  }
}

const ROLES: readonly string[] = ['ADMIN', 'MANAGER', 'SALES', 'ACCOUNTANT'];

/**
 * Aus dem Ausweis die Sitzung bauen, mit der die normale Oberflaeche laeuft.
 *
 * Filialname, Land und Waehrung stehen NICHT im Ausweis. Sie sind reine Beschriftung; bis es eine
 * Auskunft dafuer gibt, tragen sie den Hausstandard. Das ist als Luecke im Bericht vermerkt und
 * hat keine Wirkung auf Buchungen — die entstehen ausschliesslich am Primary.
 */
export function sessionFromToken(token: string): Session | null {
  const c = readClaims(token);
  if (!c?.sub || !c.branch_id) return null;
  const role = (ROLES.includes(String(c.role)) ? c.role : 'SALES') as UserRole;
  return {
    userId: c.sub,
    branchId: c.branch_id,
    role,
    token,
    user: { id: c.sub, email: c.email ?? '', name: c.name ?? c.email ?? c.sub },
    branch: { id: c.branch_id, name: '', country: 'BH', currency: 'BHD' },
  };
}

const KEY_SESSION = 'lataif_session';

/** Die Sitzung so ablegen, wie `authService` sie erwartet — dieselbe Stelle, dieselbe Form. */
export function installClientSession(token: string): Session | null {
  const s = sessionFromToken(token);
  if (!s) return null;
  try { window.localStorage.setItem(KEY_SESSION, JSON.stringify(s)); } catch { return null; }
  return s;
}

/**
 * CENTRAL-UI-PARITY R1 — Filialname, Land und Waehrung stehen NICHT im Ausweis; sie sind
 * Beschriftung. Frueher trugen sie deshalb den Hausstandard — geraten, nicht gewusst. Jetzt holt
 * der Client sie ueber eine eigene Auskunft vom Primary, der sie aus SEINER Filialtabelle liest,
 * und zwar zu der Filiale, die im geprueften Ausweis steht.
 *
 * Das bleibt Anzeige: die Sitzung wird damit beschriftet, nicht berechtigt. Wer sie von Hand
 * aendert, aendert seine eigene Beschriftung — nicht, was der Primary tut.
 */
export async function refreshClientSessionContext(): Promise<void> {
  const raw = (() => { try { return window.localStorage.getItem(KEY_SESSION); } catch { return null; } })();
  if (!raw) return;
  try {
    const { remoteRead } = await import('@/core/bridge/remote-read');
    const ctx = await remoteRead<{ data?: { branch?: { id: string; name: string; country: string; currency: string } } }>(
      'session.context.get', {},
    );
    const branch = ctx?.data?.branch;
    if (!branch) return;
    const s = JSON.parse(raw) as Session;
    if (branch.id !== s.branchId) return; // eine andere Filiale als im Ausweis wird nicht uebernommen
    s.branch = branch;
    window.localStorage.setItem(KEY_SESSION, JSON.stringify(s));
  } catch { /* Beschriftung fehlt, mehr nicht */ }
}

/** Beim Trennen faellt sie wieder weg — es bleibt nichts stehen, was jemanden anmeldet. */
export function clearClientSession(): void {
  try { window.localStorage.removeItem(KEY_SESSION); } catch { /* nichts zu raeumen */ }
}

// ═══════════════════════════════════════════════════════════
// Duplicate-Check fuer Kontakt-Entities (Customer / Supplier / Agent / Partner / Employee).
//
// Idee:
//   - STARKES Match: Telefonnummer (letzte 8 Digits gleich) ODER WhatsApp.
//     → Sehr wahrscheinlich Duplikat.
//   - WEICHES Match: Name (case-insensitive, Levenshtein-Distance ≤ 2 auf
//     dem zusammengebauten Vollnamen).
//     → Warnung; koennte zwei Personen mit gleichem Namen sein.
//
// Verhalten: NICHT hart blockieren. Aufrufer zeigt Banner + Save-Button bleibt aktiv.
// ═══════════════════════════════════════════════════════════

import { normalizedTail } from '@/core/contacts/country-codes';

// Generisches Kontakt-Shape — alle Entity-Typen erfuellen mindestens ein paar dieser Felder.
// `id` ist Pflicht damit der Aufrufer den Match identifizieren kann.
export interface ContactLike {
  id: string;
  firstName?: string;
  lastName?: string;
  name?: string;          // Supplier/Workshop/Partner ohne first/last
  company?: string;
  phone?: string;
  whatsapp?: string;
}

// Probe = das was der User gerade eintippt; alle Felder optional.
export interface DuplicateProbe {
  firstName?: string;
  lastName?: string;
  name?: string;
  company?: string;
  phone?: string;
  whatsapp?: string;
}

export type MatchKind = 'phone' | 'whatsapp' | 'name';

export interface DuplicateMatch<T extends ContactLike> {
  contact: T;
  kinds: MatchKind[];     // welche Felder matchen (Phone, WhatsApp, Name) — manchmal mehrere
  strength: 'strong' | 'soft';  // strong = phone/whatsapp, soft = name only
}

// ─── Helpers ───
function fullName(c: DuplicateProbe | ContactLike): string {
  const parts = [c.firstName, c.lastName].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(' ').trim().toLowerCase();
  return (c.name || '').trim().toLowerCase();
}

function levenshtein(a: string, b: string): number {
  // Klassische DP-Implementierung; reicht fuer kurze Strings (Personen-Namen).
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0].push(j);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[a.length][b.length];
}

// Weicher Name-Match: gleich (case-insensitive) ODER Levenshtein-Distance ≤ 2 wenn beide
// Strings mind. 4 Zeichen haben (sonst sind Mini-Tipps trivial und produzieren Noise).
function nameMatches(probe: string, candidate: string): boolean {
  if (!probe || !candidate) return false;
  if (probe === candidate) return true;
  // "Ahmed" matched "Ahmad"? Distance=1, also ja. Aber nur wenn beide >= 4 Zeichen.
  if (probe.length < 4 || candidate.length < 4) return false;
  return levenshtein(probe, candidate) <= 2;
}

// ─── Hauptfunktion ───
export function findSimilarContacts<T extends ContactLike>(
  probe: DuplicateProbe,
  candidates: T[],
  options?: { excludeId?: string },
): DuplicateMatch<T>[] {
  const excludeId = options?.excludeId;
  const probePhoneTail = probe.phone ? normalizedTail(probe.phone, 8) : '';
  const probeWhatsappTail = probe.whatsapp ? normalizedTail(probe.whatsapp, 8) : '';
  const probeName = fullName(probe);

  const out: DuplicateMatch<T>[] = [];

  for (const c of candidates) {
    if (excludeId && c.id === excludeId) continue;

    const kinds: MatchKind[] = [];

    // Phone (Strong): nur wenn der Probe-Tail mindestens 6 Digits hat (sonst False-Positives).
    if (probePhoneTail.length >= 6) {
      const cTail = normalizedTail(c.phone, 8);
      if (cTail && cTail === probePhoneTail) kinds.push('phone');
      // Auch gegen das WhatsApp-Feld des Candidates pruefen — Phone hier kann WhatsApp dort sein.
      const cWaTail = normalizedTail(c.whatsapp, 8);
      if (cWaTail && cWaTail === probePhoneTail && !kinds.includes('phone')) kinds.push('phone');
    }

    // WhatsApp (Strong).
    if (probeWhatsappTail.length >= 6) {
      const cWaTail = normalizedTail(c.whatsapp, 8);
      if (cWaTail && cWaTail === probeWhatsappTail && !kinds.includes('whatsapp')) kinds.push('whatsapp');
      const cTail = normalizedTail(c.phone, 8);
      if (cTail && cTail === probeWhatsappTail && !kinds.includes('whatsapp')) kinds.push('whatsapp');
    }

    // Name (Soft).
    if (probeName.length >= 2 && nameMatches(probeName, fullName(c))) {
      kinds.push('name');
    }

    if (kinds.length > 0) {
      const strength: 'strong' | 'soft' =
        kinds.includes('phone') || kinds.includes('whatsapp') ? 'strong' : 'soft';
      out.push({ contact: c, kinds, strength });
    }
  }

  // Sortierung: strong zuerst, dann nach Name-Alphabet.
  out.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
    return fullName(a.contact).localeCompare(fullName(b.contact));
  });

  return out;
}

// ─── Hilfsfunktion fuer Banner-Text ───
export function matchSummary(m: DuplicateMatch<ContactLike>): string {
  const labels: Record<MatchKind, string> = {
    phone: 'same phone',
    whatsapp: 'same WhatsApp',
    name: 'similar name',
  };
  return m.kinds.map(k => labels[k]).join(' · ');
}

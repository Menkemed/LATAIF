// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R2D — eine Seite liest, ohne zu wissen, wo die Datenbank steht.
//
// Bis hierher hatten die Stores ihre Weiche (`hydrateFromPrimary`), die Seiten aber nicht: ein gutes
// Dutzend Flächen stellte ihre Abfrage selbst. Am Primary war das richtig; auf einem Rechner ohne
// Datenbank lieferte dieselbe Zeile still eine leere Menge — und leere Mengen sehen aus wie Daten.
//
// Diese Datei ist die fehlende Weiche für Seiten. Sie hat genau eine Form:
//
//     const x = useSharedRead('page.foo.get', { id }, (ctx) => fooFor(ctx, id), LEER, [deps]);
//
//   • Am Primary ruft sie DIESELBE gemeinsame Ladefunktion, die auch die Fernauskunft ausführt —
//     synchron, gemerkt, mit denselben Abhängigkeiten wie das frühere `useMemo`.
//   • Auf einem Client fragt sie EINMAL nach und zeigt die Antwort.
//
// Was sie nicht tut: sie schickt kein SQL, sie kennt keinen Store, und sie lässt die Seite nichts
// über den Unterschied wissen. Die Zeile sieht auf beiden Rechnern gleich aus.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from 'react';
import { readsFromPrimary, fetchFromPrimary } from '@/core/data/primary-source';
import { localReadContext, type BusinessReadContext } from '@/core/data/read-context';
import { query } from '@/core/db/helpers';

/**
 * Eine Fläche, ein Ergebnis — egal an welchem Rechner.
 *
 * `fallback` ist die ehrliche Antwort für „noch nicht da" und für „geht gerade nicht": dieselbe
 * leere Form, die die Seite auch bisher im `catch` bekam.
 */
export function useSharedRead<T>(
  op: string,
  params: Record<string, unknown>,
  loader: (ctx: BusinessReadContext) => T,
  fallback: T,
  deps: readonly unknown[] = [],
): T {
  const remote = readsFromPrimary();
  const key = JSON.stringify(params);
  const [antwort, setAntwort] = useState<T | null>(null);

  useEffect(() => {
    if (!remote) return;
    let alive = true;
    void fetchFromPrimary(op, JSON.parse(key) as Record<string, unknown>).then((d) => {
      if (alive && d) setAntwort(d as T);
    });
    return () => { alive = false; };
    // Der Rumpf ist als Zeichenkette in `key` — so lösen gleiche Werte in einem neuen Objekt
    // keine zweite Anfrage aus.
  }, [op, key, remote]);

  return useMemo(() => {
    if (remote) return antwort ?? fallback;
    try { return loader(localReadContext()); } catch { return fallback; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, antwort, key, ...deps]);
}

/**
 * Der Mandant der angemeldeten Filiale — für die Bildquelle der Medien.
 *
 * Am Primary steht er in der Filialtabelle. Auf einem Client steht er im geprüften Ausweis, mit
 * dem sich dieses Fenster angemeldet hat: derselbe Wert, ohne Datenbank und ohne Netzaufruf.
 * Fehlt er, bleibt er `undefined` — dann fällt die Anzeige auf die alte Spalte zurück, wie
 * bisher auch. Geraten wird nichts.
 */
export function sessionTenantId(branchId: string | undefined): string | undefined {
  if (!branchId) return undefined;
  if (readsFromPrimary()) {
    try {
      const raw = window.localStorage.getItem('lataif_session');
      const token = raw ? (JSON.parse(raw) as { token?: string }).token : undefined;
      if (!token) return undefined;
      const part = token.split('.')[1];
      if (!part) return undefined;
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { tenant_id?: string; branch_id?: string };
      // Nur der Mandant der Filiale, die auch im Ausweis steht — nichts Fremdes.
      if (claims.branch_id !== branchId) return undefined;
      return claims.tenant_id || undefined;
    } catch { return undefined; }
  }
  try {
    // Am Primary bleibt es bei der Filialtabelle: sie ist hier die Wahrheit.
    const rows = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]);
    return (rows[0]?.tenant_id as string | null) || undefined;
  } catch { return undefined; }
}

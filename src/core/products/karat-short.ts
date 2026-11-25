// Karat & Color kurz — EINE Regel für Etikett, Modellkarte und Suche (nur Anzeige, nie gespeichert).
// „18K Yellow" → „18K YG", „18K Mix" → „18K MIX", „Silver" → „SILVER", „Platinum" → „PLATINUM". Leer bleibt leer.
export function karatShort(karat: unknown): string {
  const s = String(karat ?? '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)\s*K\s+(\w+)/i);
  if (m) {
    const color = m[2].toLowerCase();
    if (color === 'mix') return `${m[1]}K MIX`;
    return `${m[1]}K ${color[0].toUpperCase()}G`; // Yellow→YG, Rose→RG, White→WG
  }
  return s.toUpperCase();
}

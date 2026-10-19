// ═════════════════════════════════════════════════════════════════
// RETIRED-CHOICES — Auswahlwerte, die es für NEUE Artikel nicht mehr gibt (Owner-Entscheidung 19.10.2026: „Pendant"
// ist keine eigene Schmuckart mehr, es heißt „Necklace").
//
// Bestehende Artikel und Belege behalten ihren Wert — hier wird nichts umgeschrieben. Die Liste sorgt nur dafür, dass
// kein Weg den Wert wieder einführt: Neuanlage (Rechner, PC2, Einkauf, Kommission, Auftrag, Produktion — alle über
// `planProductCreate`) lehnt ihn mit einem klaren Satz ab, statt ihn still zu speichern (KI-Vorschlag, „Copy details"
// von einem alten Artikel). Der Excel-Import übersetzt ihn sichtbar (Warnung + Original in der Notiz).
// ═════════════════════════════════════════════════════════════════

export const CHOICE_RETIRED = 'CHOICE_RETIRED';

/** Merkmal → { alter Wert → Ersatz }. */
export const RETIRED_CHOICES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  item_type: { Pendant: 'Necklace' },
};

const norm = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase().replace(/\s+/g, ' ') : '');

/** Der Ersatz, wenn `value` für `key` ein ausgemusterter Wert ist („Pendant", „pendants") — sonst `null`. */
export function retiredReplacement(key: string, value: unknown): string | null {
  const v = norm(value);
  if (!v) return null;
  for (const [alt, neu] of Object.entries(RETIRED_CHOICES[key] || {})) {
    const a = alt.toLowerCase();
    if (v === a || v === a + 's') return neu;
  }
  return null;
}

/**
 * Die Merkmale eines NEUEN Artikels, die einen ausgemusterten Wert tragen — mit dem Satz für den Menschen. Bietet die
 * Kategorie den Wert selbst noch an (eine eigene Kategorie des Hauses), ist er dort nicht ausgemustert.
 */
export function retiredChoiceIssues(
  attributes: Record<string, unknown> | null | undefined,
  category?: { attributes: ReadonlyArray<{ key: string; label: string; options?: readonly string[] }> } | null,
): Array<{ field: string; label: string; code: string; message: string }> {
  const out: Array<{ field: string; label: string; code: string; message: string }> = [];
  for (const [key, value] of Object.entries(attributes || {})) {
    const def = category?.attributes.find((a) => a.key === key);
    if (def?.options?.includes(String(value))) continue;
    const labelOf = (k: string): string => def?.label || k;
    const neu = retiredReplacement(key, value);
    if (neu) out.push({ field: key, label: labelOf(key), code: CHOICE_RETIRED, message: `${labelOf(key)} “${String(value).trim()}” is no longer a choice — use ${neu}.` });
  }
  return out;
}

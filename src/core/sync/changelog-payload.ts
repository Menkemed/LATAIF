// ════════════════════════════════════════════════════════════════════════════
// SYNC-SLIM (Weg A) — was ein NEUER `sync_changelog`-Eintrag von einer Zeile mitträgt.
//
// Beide Schreiber (`trackChange` in sync-service.ts und der Medien-Koordinator) spiegeln die ganze
// Zeile per `SELECT *`. Für Artikel hieß das: bei JEDER Änderung (Preis, Status, Menge …) wurde der
// KI-Vektor `image_embedding` (≈ 30 KB) erneut kopiert — gemessen ~2/3 des Changelog-Wachstums.
//
// Warum der Vektor im Abgleich entbehrlich ist (Code-Prüfung 17.11.2026):
//   • Einziger Empfänger ist der Primary selbst: Legacy-Push/-Pull antwortet jedem anderen Aufrufer
//     403 (`LEGACY_SYNC_DISABLED`), PC2 im Client-Modus hat keinen Abgleich, das Handy arbeitet mit Befehlen.
//   • Jeder Leser des Vektors (Bildsuche, Duplikat-Prüfung, Einstellungen) liest `products` lokal.
//   • `applyUpsert` ändert nur mitgeschickte Spalten: ein FEHLENDES Feld lässt den Wert beim Empfänger
//     unverändert — es wird nie zu NULL und ist kein Löschauftrag. Eine neue Zeile ohne das Feld bekommt
//     den Spaltenstandard (kein Embedding) und rechnet es bei Bedarf selbst.
//
// Warum IMMER weglassen (auch NULL): der Primary spielt seine eigenen Einträge beim Pull wieder ein.
// Trüge ein älterer Eintrag `image_embedding: null` (Bild geändert) und ein jüngerer den neuen Vektor
// nicht, setzte das Echo das frisch berechnete Embedding auf NULL. Wird die Spalte nie mitgeschickt,
// fasst das Echo sie nie an — der lokale Stand bleibt maßgeblich, in jeder Reihenfolge.
//
// Der Abgleich-Vertrag (`sync-business-schema.json`) bleibt unverändert: `image_embedding` ist weiter
// ein ERLAUBTES Feld (ältere Einträge tragen es), nur nicht mehr verpflichtend mitgeschickt.
// ════════════════════════════════════════════════════════════════════════════

/** Spalten, die ein neuer Changelog-Eintrag je Tabelle NICHT mitträgt. */
export const CHANGELOG_OMIT: Readonly<Record<string, readonly string[]>> = {
  products: ['image_embedding'],
};

/**
 * A2-STUFE-1 — dieselben Spalten sind beim EINSPIELEN rein lokal: ein Eintrag aus dem Abgleich (auch ein
 * ALTER von vor Weg A, der noch einen Vektor oder `null` trägt) setzt sie nie. Sonst könnte ein Wieder-
 * Einspielen — normaler Pull eines noch offenen Eintrags oder Neuaufbau nach Cursor-Verlust, der ab dem
 * ersten fremden Eintrag alles erneut anwendet — ein neueres Embedding durch ein altes ersetzen oder auf NULL
 * setzen. Das Embedding ist abgeleitet; der Rechner, der es braucht, rechnet es selbst. Alle übrigen Felder
 * wirken wie bisher.
 */
export function inboundPayload(table: string, data: Record<string, unknown>): Record<string, unknown> {
  return changelogPayload(table, data);
}

/** Die Zeile, wie sie in den Changelog geht. Ohne betroffene Spalte unverändert (kein Kopieren). */
export function changelogPayload(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const omit = CHANGELOG_OMIT[table];
  if (!omit) return row;
  let out: Record<string, unknown> | null = null;
  for (const col of omit) {
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      out ??= { ...row };
      delete out[col];
    }
  }
  return out ?? row;
}

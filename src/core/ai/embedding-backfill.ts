// ════════════════════════════════════════════════════════════════════════════
// EMBEDDING-BACKFILL — der Ablauf hinter Einstellungen → „Backfill Embeddings" (ohne UI, testbar).
//
// Fehler vorher: der Knopf rechnete für jeden Artikel ohne Embedding Beschreibung + Vektor und rief
// `updateProduct(id, { imageDescription, imageEmbedding })` — deren Feldliste kennt beide nicht. Nichts wurde
// gespeichert, der volle Vektor aber ins Audit geschrieben; jeder weitere Lauf (und der Lazy-Backfill beim
// Laden) rief die KI für dieselben Artikel erneut auf.
//
// Jetzt, je Artikel, der Reihe nach:
//   1. frisch prüfen, ob das Embedding WIRKLICH noch fehlt (die Liste kann veraltet sein) → sonst überspringen;
//   2. den Artikel für diese Sitzung belegen (kein zweiter Rechenweg parallel) → sonst überspringen;
//   3. EIN KI-Aufruf; 4. dauerhaft speichern — nur, wenn es noch fehlt; 5. Belegung freigeben (auch bei Fehler).
// Ein einzelner Fehler zählt und es geht weiter; Kontingent-/Schlüssel-Fehler (quota/429/401/403) brechen ab,
// statt jeden weiteren Artikel ebenfalls scheitern zu lassen; `shouldStop` bricht zwischen zwei Artikeln ab.
// Was gespeichert ist, bleibt gespeichert — ein Abbruch hinterlässt nichts Halbes.
// Kein Start-Automatismus: läuft nur, wenn der Mensch den Knopf drückt.
// ════════════════════════════════════════════════════════════════════════════

export interface EmbeddingBackfillItem { id: string; image: string }

export interface EmbeddingBackfillDeps {
  stillMissing(productId: string): boolean;
  claim(productId: string): boolean;
  release(productId: string): void;
  compute(image: string): Promise<{ description: string; embedding: number[] }>;
  /** true = gespeichert; false = inzwischen schon vorhanden (nichts geschrieben). */
  persist(productId: string, description: string, embedding: number[]): boolean;
  shouldStop?(): boolean;
  onProgress?(p: EmbeddingBackfillProgress): void;
}

export interface EmbeddingBackfillProgress { current: number; total: number; saved: number; skipped: number; errors: number }

export interface EmbeddingBackfillResult extends EmbeddingBackfillProgress {
  /** 'done' = alle durchgegangen; 'stopped' = auf Wunsch angehalten; 'blocked' = Kontingent/Schlüssel. */
  outcome: 'done' | 'stopped' | 'blocked';
  computed: number;
}

const BLOCKING = /quota|429|401|403/i;

export async function runEmbeddingBackfill(items: readonly EmbeddingBackfillItem[], deps: EmbeddingBackfillDeps): Promise<EmbeddingBackfillResult> {
  const r: EmbeddingBackfillResult = { current: 0, total: items.length, saved: 0, skipped: 0, errors: 0, computed: 0, outcome: 'done' };
  for (const item of items) {
    if (deps.shouldStop?.()) { r.outcome = 'stopped'; break; }
    r.current++;
    if (!deps.stillMissing(item.id) || !deps.claim(item.id)) {
      r.skipped++;
      deps.onProgress?.({ ...r });
      continue;
    }
    try {
      r.computed++;
      const { description, embedding } = await deps.compute(item.image);
      if (deps.persist(item.id, description, embedding)) r.saved++;
      else r.skipped++;
    } catch (err) {
      r.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (BLOCKING.test(msg)) { r.outcome = 'blocked'; deps.release(item.id); deps.onProgress?.({ ...r }); break; }
    } finally {
      deps.release(item.id);
    }
    deps.onProgress?.({ ...r });
  }
  return r;
}

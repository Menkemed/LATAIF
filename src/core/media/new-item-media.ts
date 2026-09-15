// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-12 — der „New Item"-Artikel aus Einkauf und Auftrag bekommt seine Fotos im
// Medienspeicher, wie jeder andere Artikel.
//
// Jeder Artikel, den die Sammlung, die Kommission, die Fertigung oder das Handy anlegt, trägt seine
// Fotos im Medienspeicher (`createProductWithMedia`: `normalize_stock_image` + `create_thumbnail`,
// Hauptbild ≤ 100 000 B, Vorschau ≤ 20 000 B, `products.images = '[]'`). Nur der Artikel, der in einem
// Einkauf („New Item"), in einem Auftrag (Neuanlage, Positionsänderung, Umwandlung, Storno eines
// Sonderstücks) entsteht, schrieb seine Fotos in die Spalte `products.images` — normalisiert (PP-12),
// aber ohne Vorschau und neben dem Medienspeicher her. Diese Wege sind SYNCHRON und laufen in EINER
// Transaktion mit Einkauf, Zeilen, Hauptbuch; der Medienweg dagegen schreibt Dateien und ist
// asynchron. Ihn in die Transaktion zu ziehen hieße, jeden dieser Geldwege asynchron umzubauen.
//
// Stattdessen derselbe Umzug, den der Artikel ohnehin kennt: der Cutover-Dienst
// (`ProductMediaCutoverService`, bisher beim Bearbeiten eines Altartikels und in der Speicherpflege)
// übernimmt die Fotos des frisch angelegten Artikels in den Medienspeicher — alle, in Reihenfolge,
// durabel, geprüft — und leert die Spalte ERST danach. Er läuft als NÄCHSTER Auftrag in der einen
// Schreibreihenfolge, also nach dem Commit und dem durablen Speichern des Vorgangs, der den Artikel
// anlegte; ein zurückgenommener Vorgang hinterlässt keinen Artikel, und der Dienst findet nichts.
// Scheitert der Umzug, bleibt die Spalte die Wahrheit (das Bild wird weiter gezeigt), und die
// Speicherpflege holt ihn später nach — nichts geht verloren.
//
// Bestehende Artikel werden hier NIE angefasst: nur Kennungen, die `createProduct` in diesem Leben
// mit Fotos angelegt hat.
// ════════════════════════════════════════════════════════════════════════════
import { runExclusive } from '../bridge/command-scheduler.ts';

export type NewItemCutoverAction = 'migrated' | 'resumed_and_cleared' | 'noop_no_legacy' | 'noop_already_migrated' | 'gone' | 'failed';
export interface NewItemCutoverReport { productId: string; action: NewItemCutoverAction; imported?: number; code?: string }

export interface NewItemMediaDeps {
  /** Filiale und Mandant des Artikels aus SEINER Zeile — `null`, wenn es ihn nicht (mehr) gibt. */
  scopeOf: (productId: string) => { tenantId: string; branchId: string } | null;
  /** Der echte Umzug eines Artikels (Cutover-Dienst mit dem Medien-Orchestrator). */
  cutover: (productId: string, scope: { tenantId: string; branchId: string }) => Promise<{ action: string; imported: number }>;
  /** Danach die Artikelliste frisch (die Galerie kommt jetzt aus dem Medienspeicher). */
  reload: () => void | Promise<void>;
}

const pending = new Set<string>();
let queued = false;
let lastReports: NewItemCutoverReport[] = [];

const inTauri = (): boolean => typeof window !== 'undefined' && !!(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

/** Nur zur Prüfung: was noch aussteht, was der letzte Lauf tat. */
export function pendingNewItemMedia(): string[] { return [...pending]; }
export function lastNewItemMediaReports(): NewItemCutoverReport[] { return lastReports; }

/**
 * Merkt einen frisch mit Fotos angelegten Artikel vor und stellt EINEN Umzugsauftrag hinten in die
 * Schreibreihenfolge. Aus einem laufenden exklusiven Vorgang heraus aufgerufen, beginnt er erst,
 * wenn dieser fertig (committet und durabel gespeichert — oder zurückgenommen) ist.
 */
export function scheduleNewItemMediaCutover(productId: string, deps?: NewItemMediaDeps): void {
  if (!deps && !inTauri()) return; // ohne Medienspeicher (Browser/Node) bleibt die Spalte die Wahrheit
  pending.add(productId);
  if (queued) return;
  queued = true;
  runExclusive(async () => {
    queued = false;
    await drainNewItemMediaCutovers(deps);
  }).catch((e) => {
    queued = false;
    console.warn('[new-item-media] cutover not run:', e instanceof Error ? e.message : String(e));
  });
}

export async function drainNewItemMediaCutovers(deps?: NewItemMediaDeps): Promise<NewItemCutoverReport[]> {
  const d = deps ?? await liveDeps();
  const ids = [...pending];
  pending.clear();
  const out: NewItemCutoverReport[] = [];
  for (const productId of ids) {
    const scope = d.scopeOf(productId);
    if (!scope) { out.push({ productId, action: 'gone' }); continue; }
    try {
      const r = await d.cutover(productId, scope);
      out.push({ productId, action: r.action as NewItemCutoverAction, imported: r.imported });
    } catch (e) {
      const code = (e as { code?: string })?.code ?? (e instanceof Error ? e.message : String(e));
      out.push({ productId, action: 'failed', code });
      console.warn('[new-item-media] cutover failed — the photos stay in products.images:', productId, code);
    }
  }
  lastReports = out;
  if (out.some((r) => r.action === 'migrated' || r.action === 'resumed_and_cleared')) {
    try { await d.reload(); } catch { /* die Liste lädt beim nächsten Mal */ }
  }
  return out;
}

async function liveDeps(): Promise<NewItemMediaDeps> {
  const [{ getDatabase, saveDatabaseDurably }, { ProductMediaCutoverService }, { getStockMediaOrchestrator }] = await Promise.all([
    import('../db/database.ts'),
    import('./product-media-cutover.ts'),
    import('./orchestrator.ts'),
  ]);
  type RawDb = { run(sql: string, params?: unknown[]): void; exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }> };
  const db = () => getDatabase() as unknown as RawDb;
  return {
    scopeOf: (productId) => {
      const r = db().exec('SELECT p.branch_id, b.tenant_id FROM products p JOIN branches b ON b.id = p.branch_id WHERE p.id = ?', [productId]);
      const row = r[0]?.values?.[0];
      return row && row[0] && row[1] ? { branchId: String(row[0]), tenantId: String(row[1]) } : null;
    },
    cutover: async (productId, scope) => {
      const service = new ProductMediaCutoverService({
        dbProvider: db,
        orchestrator: await getStockMediaOrchestrator(),
        // Der Vorgang, der den Artikel anlegte, hat ihn schon durabel gespeichert (runOnPrimary /
        // runRemoteCommand) — deshalb kein zusätzliches Speichern VOR dem ersten Bild.
        commitLegacyCleared: async (pid: string) => {
          getDatabase().run(`UPDATE products SET images = '[]' WHERE id = ?`, [pid]);
          await saveDatabaseDurably();
        },
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        role: 'stock_image',
      });
      return service.ensureProductMediaCutover(productId);
    },
    reload: async () => { (await import('../../stores/productStore.ts')).useProductStore.getState().loadProducts(); },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7C R1 — offene Speichervorgänge überleben Maskenwechsel, Neuladen und Neustart.
//
// Bis hier lebte die Kennung eines Speicherversuchs nur im Speicher der Maske (R7B-Review R1). Ging
// die Antwort verloren und verließ der Mensch danach die Maske — oder lud PC2 neu —, bekam der
// nächste Klick eine NEUE Kennung; hatte der erste Lauf committet, entstand der Vorgang zweimal.
//
// Jetzt steht jeder Versuch, der den Primary erreicht haben KÖNNTE, in einer eigenen Datei dieses
// Rechners, geschrieben BEVOR er hinausgeht (`<AppLocalData>/pending-saves/<Kennung>.json`):
// Kennung, Buchung, der UNVERÄNDERTE ursprüngliche Rumpf und der Kontext (Primary-Adresse,
// Mandant, Benutzer, Filiale aus dem Ausweis). Das ist keine zweite Wahrheit über Geschäftsdaten:
// ob der Vorgang stattfand, weiß weiterhin nur der durable Nachweis des Primary — die Wiederholung
// derselben Kennung mit demselben Rumpf holt dessen eingefrorenes Ergebnis (Replay) oder führt den
// Vorgang genau einmal aus.
//
// Eine Datei verschwindet erst, wenn der Vorgang beantwortet ist (Erfolg oder endgültiges Nein) —
// oder wenn nachweislich KEIN Versand ihn erreicht haben kann. Jeder Vorgang hat seine eigene
// Datei; mehrere offene überschreiben einander nicht.
// ════════════════════════════════════════════════════════════════════════════
import { clientConfig } from './client-mode';
import { readClaims } from '../auth/client-session';

/** Wo ein offener Vorgang hingehört. Wiederaufnahme nur im selben Kontext. */
export interface PendingContext {
  readonly server: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly branchId: string;
}

/** `sending`: vor dem Versand geschrieben (kann angekommen sein) · `unresolved`: Ausgang offen ·
 *  `conflict`: der Primary hält die Kennung für einen ANDEREN Rumpf — dieser Versuch lief nicht. */
export type PendingState = 'sending' | 'unresolved' | 'conflict';

export interface PendingRecord {
  readonly v: 1;
  readonly commandId: string;
  readonly op: string;
  /** Der ursprüngliche Auftrag, genau so, wie er zuerst hinausging. */
  readonly payload: Record<string, unknown>;
  readonly context: PendingContext;
  readonly createdAt: string;
  readonly state: PendingState;
  readonly lastCode?: string;
  readonly updatedAt: string;
}

/** Wo die Vorgänge liegen. Tauri: Dateien unter AppLocalData; im Test/Browser: Speicher. */
export interface PendingBackend {
  list(): Promise<string[]>;
  read(id: string): Promise<string | null>;
  write(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: ReadonlySet<string> = new Set(['sending', 'unresolved', 'conflict']);

export function memoryPendingBackend(): PendingBackend & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    list: async () => [...files.keys()],
    read: async (id) => files.get(id) ?? null,
    write: async (id, text) => { files.set(id, text); },
    remove: async (id) => { files.delete(id); },
  };
}

/** Eine Datei je Vorgang; geschrieben über eine Temp-Datei + Umbenennen (kein halber Stand). */
function tauriPendingBackend(): PendingBackend {
  let dirP: Promise<string> | null = null;
  // Der Ordner kommt nativ (`get_pending_saves_root`) — der Renderer löst keinen Datenpfad selbst
  // auf. Derselbe Ort wie bisher: `<AppLocalData>/pending-saves`. Nicht `get_runtime_paths`: das
  // antwortet auf PC2 nicht (dort gibt es keinen Geschäftsbestand).
  const dir = (): Promise<string> => (dirP ??= (async () => {
    const { getPendingSavesRoot } = await import('@/core/runtime/runtime-paths');
    return getPendingSavesRoot();
  })());
  const file = async (id: string): Promise<string> => {
    const { join } = await import('@tauri-apps/api/path');
    return join(await dir(), `${id}.json`);
  };
  const fsm = () => import('@tauri-apps/plugin-fs');
  return {
    async list() {
      const fs = await fsm();
      const d = await dir();
      if (!(await fs.exists(d))) return [];
      return (await fs.readDir(d))
        .filter((e) => e.isFile && /\.json$/i.test(e.name) && ID_RE.test(e.name.slice(0, -5)))
        .map((e) => e.name.slice(0, -5));
    },
    async read(id) {
      const fs = await fsm();
      const p = await file(id);
      try {
        return await fs.readTextFile(p);
      } catch (e) {
        if (!(await fs.exists(p))) return null;
        throw e;
      }
    },
    async write(id, text) {
      const fs = await fsm();
      await fs.mkdir(await dir(), { recursive: true });
      const p = await file(id);
      const tmp = `${p}.tmp`;
      await fs.writeTextFile(tmp, text);
      await fs.rename(tmp, p);
    },
    async remove(id) {
      const fs = await fsm();
      const p = await file(id);
      if (await fs.exists(p)) await fs.remove(p);
    },
  };
}

function isTauri(): boolean {
  try { return !!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; } catch { return false; }
}

// ── Zustand dieses Fensters ─────────────────────────────────────────────────
let backend: PendingBackend | null = null;
const records = new Map<string, PendingRecord>();
let unreadable: string[] = [];
let loadError: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function activeBackend(): PendingBackend {
  return (backend ??= isTauri() ? tauriPendingBackend() : memoryPendingBackend());
}
function notify(): void {
  for (const fn of listeners) { try { fn(); } catch { /* eine Anzeige darf das Speichern nicht stören */ } }
}

/** Nur für Tests: einen anderen Ablageort setzen (und den Fensterzustand verwerfen). */
export function setPendingBackendForTest(b: PendingBackend | null): void {
  backend = b;
  resetPendingMemoryForTest();
}
/** Nur für Tests: den Fensterzustand verwerfen — genau das, was ein Neuladen tut. Die Ablage bleibt. */
export function resetPendingMemoryForTest(): void {
  records.clear();
  unreadable = [];
  loadError = null;
  loading = null;
}

function parseRecord(text: string, id: string): PendingRecord | null {
  try {
    const r = JSON.parse(text) as PendingRecord;
    const c = r?.context as PendingContext | undefined;
    const ok = r && r.v === 1 && r.commandId === id && ID_RE.test(id) && typeof r.op === 'string' && r.op !== ''
      && r.payload !== null && typeof r.payload === 'object' && !Array.isArray(r.payload)
      && c && ['server', 'tenantId', 'userId', 'branchId'].every((k) => typeof (c as unknown as Record<string, unknown>)[k] === 'string')
      && typeof r.createdAt === 'string' && STATES.has(r.state);
    return ok ? r : null;
  } catch {
    return null;
  }
}

/** Liest die Ablage einmal je Fenster. Wirft nie: ein Lesefehler wird angezeigt, nicht verschluckt. */
export function ensurePendingLoaded(): Promise<void> {
  return (loading ??= (async () => {
    try {
      const b = activeBackend();
      for (const id of await b.list()) {
        try {
          const t = await b.read(id);
          if (t === null) continue;
          const r = parseRecord(t, id);
          if (r) records.set(id, r);
          else if (!unreadable.includes(id)) unreadable.push(id);
        } catch {
          if (!unreadable.includes(id)) unreadable.push(id);
        }
      }
    } catch (e) {
      loadError = String(e instanceof Error ? e.message : e);
    }
    notify();
  })());
}

/** Der Kontext der Anmeldung dieses Fensters (Adresse + Ausweis). `null` ohne Anmeldung. */
export function currentPendingContext(): PendingContext | null {
  const c = clientConfig();
  if (!c || !c.token) return null;
  const claims = readClaims(c.token);
  return {
    server: c.serverUrl,
    tenantId: claims?.tenant_id ?? '',
    userId: claims?.sub ?? '',
    branchId: claims?.branch_id ?? '',
  };
}

export function sameContext(a: PendingContext, b: PendingContext): boolean {
  return a.server === b.server && a.tenantId === b.tenantId && a.userId === b.userId && a.branchId === b.branchId;
}

/** Schreibt den Vorgang. Wirft, wenn die Ablage es nicht kann — dann darf nichts hinausgehen. */
export async function persistPending(r: PendingRecord): Promise<void> {
  await ensurePendingLoaded();
  await activeBackend().write(r.commandId, JSON.stringify(r));
  records.set(r.commandId, r);
  notify();
}

/** Entfernt einen beantworteten Vorgang. `false`, wenn die Datei blieb (dann erscheint er nach dem
 *  Neuladen wieder als offen — sicher: die Klärung holt dasselbe Ergebnis). */
export async function dropPending(id: string): Promise<boolean> {
  try {
    await activeBackend().remove(id);
  } catch {
    return false;
  }
  records.delete(id);
  unreadable = unreadable.filter((x) => x !== id);
  notify();
  return true;
}

/** Die offenen Vorgänge dieses Kontexts (älteste zuerst), wahlweise nur einer Buchung. */
export function pendingRecords(ctx: PendingContext | null, op?: string): PendingRecord[] {
  if (!ctx) return [];
  return [...records.values()]
    .filter((r) => sameContext(r.context, ctx) && (op === undefined || r.op === op))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Wie viele offene Vorgänge zu einer ANDEREN Anmeldung / einem anderen Primary gehören. */
export function pendingElsewhereCount(ctx: PendingContext | null): number {
  return [...records.values()].filter((r) => !ctx || !sameContext(r.context, ctx)).length;
}

export function pendingProblems(): { unreadable: readonly string[]; loadError: string | null } {
  return { unreadable: [...unreadable], loadError };
}

export function subscribePending(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Derselbe Inhalt, gleich welche Schlüsselreihenfolge — für „ist das noch der ursprüngliche Auftrag?". */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => stableJson(x === undefined ? null : x)).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// ════════════════════════════════════════════════════════════════════════════
// POST-PARITY R7B PP-3 — KI-Erkennen auf PC2 ÜBER den Primary.
//
// Der Schlüssel liegt am Primary (`<Datenort>/openai.key`) und verlässt ihn nie. PC2 schickt nur die
// fachliche Anfrage — Kategorie, Foto-Bytes, Hinweise — an die Stelle, die der Primary dafür schon
// hat: `/api/ai/identify` (dieselbe gemeinsame Vorgabe `identify-contract.json` wie am Primary,
// derselbe geprüfte Ausweis wie jede Fernbuchung). Der Primary ruft die KI und gibt das geprüfte
// Ergebnis zurück — die freigegebene Teilmenge: Marke, Name, Zustand, Beschreibung, Lagerort,
// Notizen, Lieferumfang, Merkmale der Kategorie. Nie ein Preis, eine Menge, eine Kennung.
//
// Ob der Primary überhaupt KI hat, fragt `/api/ai/status` VOR dem Klick; der Knopf sagt es dann,
// statt erst nach dem Klick zu scheitern.
// ════════════════════════════════════════════════════════════════════════════
import { clientConfig, setClientToken } from '@/core/bridge/client-mode';
import type { AiCategoryId, AiProductIdentification } from './ai-service';

export type PrimaryAiStatus = 'ready' | 'not_configured' | 'unreachable';

/** Die Antwort wird kurz gemerkt: jede Maske fragt beim Öffnen, nicht jeder Tastendruck. */
const STATUS_TTL_MS = 30_000;
let cached: { at: number; status: PrimaryAiStatus } | null = null;

export async function primaryAiStatus(fetchFn: typeof fetch = fetch, force = false): Promise<PrimaryAiStatus> {
  if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.status;
  const c = clientConfig();
  let status: PrimaryAiStatus = 'unreachable';
  if (c?.token) {
    try {
      const res = await fetchFn(`${c.serverUrl}/api/ai/status`, { headers: { Authorization: `Bearer ${c.token}` } });
      if (res.status === 401 || res.status === 403) setClientToken(null);
      else if (res.ok) {
        const j = await res.json() as { identify?: unknown };
        status = j?.identify === true ? 'ready' : 'not_configured';
      }
    } catch { /* nicht erreichbar */ }
  }
  cached = { at: Date.now(), status };
  return status;
}

export function forgetPrimaryAiStatus(): void {
  cached = null;
}

const AI_ERROR_TEXT: Readonly<Record<string, string>> = {
  AI_NOT_CONFIGURED: 'AI is not set up on the main computer (Settings → AI there).',
  AI_IMAGE_REQUIRED: 'On this computer AI Identify works from a photo — add one first.',
  AI_IMAGE_UNSUPPORTED_TYPE: 'This photo type cannot be identified (JPEG, PNG or WebP only).',
  AI_IMAGE_TOO_LARGE: 'This photo is too large for AI Identify.',
  AI_UNKNOWN_CATEGORY: 'AI Identify does not know this category.',
  AI_MALFORMED_REQUEST: 'The request could not be read by the main computer.',
  AI_UPSTREAM_FAILED: 'The AI service did not answer the main computer. Try again.',
  AI_MALFORMED_RESPONSE: 'The AI answer could not be read. Try again or pick another category.',
};

export function primaryAiErrorText(code: string): string {
  return AI_ERROR_TEXT[code] ?? `AI Identify failed on the main computer (${code}).`;
}

/** Die Hinweise so geschrieben wie am Primary (`identifyProduct`): „schlüssel: wert" je Zeile. */
export function identifyHintsText(h?: Readonly<Record<string, string | undefined>>): string {
  if (!h) return '';
  return Object.entries(h).filter(([, v]) => !!v).map(([k, v]) => `${k}: ${v}`).join('\n');
}

interface PrimaryIdentifyResult {
  brand?: unknown; name?: unknown; condition?: unknown; description?: unknown;
  storage_location?: unknown; notes?: unknown; scope_of_delivery?: unknown; attributes?: unknown;
}

/** Die Antwort des Primary in die Form, die die Masken schon kennen. */
export function fromPrimaryResult(r: PrimaryIdentifyResult | null | undefined): AiProductIdentification {
  const t = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const scope = Array.isArray(r?.scope_of_delivery)
    ? (r!.scope_of_delivery as unknown[]).map(t).filter((s): s is string => !!s)
    : [];
  const attributes: Record<string, string> = {};
  if (r?.attributes && typeof r.attributes === 'object' && !Array.isArray(r.attributes)) {
    for (const [k, v] of Object.entries(r.attributes as Record<string, unknown>)) {
      const s = t(v);
      if (s) attributes[k] = s;
    }
  }
  return {
    brand: t(r?.brand), name: t(r?.name), condition: t(r?.condition), description: t(r?.description),
    storageLocation: t(r?.storage_location), notes: t(r?.notes),
    scopeOfDelivery: scope.length ? scope : undefined,
    attributes,
  };
}

/** Eine Erkennung — ausgeführt am Primary, mit SEINEM Schlüssel. Wirft mit einem lesbaren Satz. */
export async function identifyViaPrimary(
  p: { categoryId: AiCategoryId | string; imageDataUrl: string; hints?: Readonly<Record<string, string | undefined>> },
  fetchFn: typeof fetch = fetch,
): Promise<AiProductIdentification> {
  const c = clientConfig();
  if (!c?.token) throw new Error('Not signed in to the main computer — sign in again.');
  const hints = identifyHintsText(p.hints);
  let res: Response;
  try {
    res = await fetchFn(`${c.serverUrl}/api/ai/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ category_id: p.categoryId, image: p.imageDataUrl, ...(hints ? { hints } : {}) }),
    });
  } catch {
    throw new Error('The main computer cannot be reached for AI right now.');
  }
  if (res.status === 401 || res.status === 403) {
    setClientToken(null);
    throw new Error('The sign-in is no longer valid — sign in again.');
  }
  type Answer = { result?: PrimaryIdentifyResult; error?: string };
  let body: Answer | null;
  try { body = await res.json() as Answer; } catch { body = null; }
  if (!res.ok || !body?.result) {
    const code = body?.error ?? `HTTP_${res.status}`;
    if (code === 'AI_NOT_CONFIGURED') forgetPrimaryAiStatus();
    throw new Error(primaryAiErrorText(code));
  }
  return fromPrimaryResult(body.result);
}

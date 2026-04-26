// ═══════════════════════════════════════════════════════════
// PII Anonymization Utility
// Replaces customer names with stable short tokens before the
// data is sent to OpenAI, for contexts where the narrative
// does not need real names (chat, insight detection).
// Executive Summaries addressed to the user himself KEEP names.
// ═══════════════════════════════════════════════════════════

export interface PiiMap {
  // tokenized name -> real name (for re-hydrating in UI)
  tokenToReal: Record<string, string>;
  // real name -> token (for lookup when scrubbing more text)
  realToToken: Record<string, string>;
}

export function createPiiMap(): PiiMap {
  return { tokenToReal: {}, realToToken: {} };
}

export function anonymizeName(name: string, map: PiiMap): string {
  if (!name) return name;
  const existing = map.realToToken[name];
  if (existing) return existing;
  const idx = Object.keys(map.tokenToReal).length + 1;
  const token = `Client #${String(idx).padStart(3, '0')}`;
  map.tokenToReal[token] = name;
  map.realToToken[name] = token;
  return token;
}

export function rehydrateText(text: string, map: PiiMap): string {
  let out = text;
  for (const [token, real] of Object.entries(map.tokenToReal)) {
    out = out.split(token).join(real);
  }
  return out;
}

/**
 * Walk an object and replace any field matching a customer-name heuristic
 * with anonymized tokens, keeping the rest of the data intact.
 * Mutates a DEEP COPY.
 */
export function scrubCustomerNames<T>(obj: T, map: PiiMap, nameKeys: string[] = ['name']): T {
  const json = JSON.stringify(obj, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (nameKeys.includes(k) && typeof v === 'string') {
          out[k] = anonymizeName(v, map);
        } else {
          out[k] = v;
        }
      }
      return out;
    }
    return value;
  });
  return JSON.parse(json) as T;
}

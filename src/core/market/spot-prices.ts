// Live Spot-Prices für Gold + Silber.
// Quelle: gold-api.com (gratis, kein API-Key, USD pro Troy-Unze).
// Cache 5 Minuten in memory + localStorage als Offline-Fallback.

// METAL-SPOT-SSOT — die EINE Live-Umrechnung „BHD pro Gramm Feinmetall". Der Weltmarkt notiert USD pro
// Feinunze; umgerechnet wird mit der Feinunze in Gramm und der offiziellen Bindung des Dinars (0,376 BHD
// je USD). Vorher zeigte die Übersicht eine zweite Formel (`USD/oz × 1,417 / 116,64` = 10 Tola mit
// einem ungenannten Kurs von 0,37786) — rund 0,5 % über dem, womit Add Material und Aufträge rechnen.
// Ein abweichender Händler-/Hauskurs gehört, wenn überhaupt, als sichtbare Einstellung dazu — nicht als
// Konstante in einer Anzeige. Gerundet wird erst beim Anzeigen bzw. Buchen in BHD.
export const TROY_OUNCE_GRAMS = 31.1034768;
export const BHD_PER_USD = 0.376;   // offizielle Bindung (Central Bank of Bahrain)

/** BHD pro Gramm FEINMETALL aus dem Weltmarktpreis in USD pro Feinunze — ungerundet. */
export function bhdPerGramFine(usdPerOunce: number): number {
  return usdPerOunce / TROY_OUNCE_GRAMS * BHD_PER_USD;
}

/** Marktwert pro Gramm eines Stücks: BHD pro Gramm fein × Reinheit (aus `core/gold/purity`) — ungerundet. */
export function marketValuePerGram(bhdPerGramFineValue: number, purity: number): number {
  return bhdPerGramFineValue * purity;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
const STORAGE_KEY = 'lataif_spot_prices_v1';

export interface SpotPrice {
  symbol: 'XAU' | 'XAG';
  metal: 'Gold' | 'Silver';
  usdPerOunce: number;
  usdPerGram: number;
  bhdPerGram: number;
  updatedAt: string;        // ISO timestamp from API
  fetchedAt: string;        // ISO timestamp when we fetched
}

interface CachedPrices {
  fetchedAt: number;
  gold?: SpotPrice;
  silver?: SpotPrice;
}

let memCache: CachedPrices | null = null;

function loadCache(): CachedPrices | null {
  if (memCache) return memCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    memCache = JSON.parse(raw);
    return memCache;
  } catch { return null; }
}

function saveCache(c: CachedPrices) {
  memCache = c;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* */ }
}

async function fetchOne(symbol: 'XAU' | 'XAG'): Promise<SpotPrice | null> {
  try {
    const res = await fetch(`https://api.gold-api.com/price/${symbol}`);
    if (!res.ok) return null;
    const data = await res.json();
    const usdPerOunce = Number(data.price);
    if (!isFinite(usdPerOunce) || usdPerOunce <= 0) return null;
    const usdPerGram = usdPerOunce / TROY_OUNCE_GRAMS;
    return {
      symbol,
      metal: symbol === 'XAU' ? 'Gold' : 'Silver',
      usdPerOunce,
      usdPerGram,
      bhdPerGram: bhdPerGramFine(usdPerOunce),
      updatedAt: String(data.updatedAt || ''),
      fetchedAt: new Date().toISOString(),
    };
  } catch { return null; }
}

// Returns cached values if fresh (≤5 min); refreshes in background otherwise.
// Force=true ignoriert Cache und holt jetzt neu.
export async function getSpotPrices(force = false): Promise<{ gold?: SpotPrice; silver?: SpotPrice; stale: boolean }> {
  const cached = loadCache();
  const fresh = cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS;
  if (fresh && !force) {
    return { gold: cached.gold, silver: cached.silver, stale: false };
  }

  const [gold, silver] = await Promise.all([fetchOne('XAU'), fetchOne('XAG')]);

  // Wenn API-Aufruf fehlschlägt, behalte alten Cache (besser als nichts)
  if (!gold && !silver && cached) {
    return { gold: cached.gold, silver: cached.silver, stale: true };
  }

  const next: CachedPrices = {
    fetchedAt: Date.now(),
    gold: gold || cached?.gold,
    silver: silver || cached?.silver,
  };
  saveCache(next);
  return { gold: next.gold, silver: next.silver, stale: !gold || !silver };
}

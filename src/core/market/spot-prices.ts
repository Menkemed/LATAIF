// Live Spot-Prices für Gold + Silber.
// Quelle: gold-api.com (gratis, kein API-Key, USD pro Troy-Unze).
// Cache 5 Minuten in memory + localStorage als Offline-Fallback.

const TROY_OZ_TO_GRAM = 31.1035;
const USD_TO_BHD = 0.376; // BHD ist gepeggt zu USD ≈ 0.376 BHD pro USD
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
    const usdPerGram = usdPerOunce / TROY_OZ_TO_GRAM;
    return {
      symbol,
      metal: symbol === 'XAU' ? 'Gold' : 'Silver',
      usdPerOunce,
      usdPerGram,
      bhdPerGram: usdPerGram * USD_TO_BHD,
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

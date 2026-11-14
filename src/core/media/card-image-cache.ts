// ════════════════════════════════════════════════════════════════════════════
// COLLECTIONS-S1 — RAM-Cache für das Kartenbild (Hauptbild) der Collections-Karten.
//
// Bis hierher gab jede Karte beim Abbau (Artikel öffnen, Kategorie wechseln) ihre Bilder frei; die
// Rückkehr las sie alle neu (Primary: Datenbank + Medienspeicher, PC2: über das Netz). Dieser Cache
// hält je Artikel GENAU EIN Bild (das der Karte, nie die Galerie) als Blob-URL — nur im
// Arbeitsspeicher dieser Sitzung: kein SQLite, kein IndexedDB, kein localStorage, keine Datei.
//
// Aktualität: Jeder Eintrag trägt den Fingerabdruck der Galerie (Kennungen + Inhalts-Hashes), aus dem
// er stammt. Die Karte zeigt die Kopie sofort und prüft den Fingerabdruck danach billig (nur
// Metadaten); weicht er ab, wird neu geladen. Daher gilt jede Änderung — Bearbeiten, Mobile-Upload,
// Restore, Änderungen an einem anderen Rechner — ohne eigene Meldung an den Cache.
//
// Speichergrenze: höchstens `maxBytes` Bildbytes und `maxEntries` Einträge. Verdrängt wird der am
// längsten nicht benutzte Eintrag. Eine Blob-URL, die eine Karte gerade zeigt (`acquire`), wird nie
// unter ihr freigegeben: sie wird erst beim letzten `release` widerrufen.
//
// Rein und ohne React/DB — unter node getestet (test/media-thumb/card-image-cache.test.ts).
// ════════════════════════════════════════════════════════════════════════════

/** 64 MiB Bildbytes (ein Kartenbild ist ≤ 100 000 B: also ~650+ Artikel). */
export const CARD_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const CARD_CACHE_MAX_ENTRIES = 1000;

export interface CardImageCacheDeps {
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  maxBytes?: number;
  maxEntries?: number;
}

interface Entry {
  productId: string;
  url: string;
  bytes: number;
  fingerprint: string;
  refs: number;
  /** Nicht mehr über `productId` erreichbar; widerrufen, sobald `refs` 0 ist. */
  retired: boolean;
}

export interface CardImageHit {
  url: string;
  fingerprint: string;
}

export class CardImageCache {
  /** productId → aktueller Eintrag; Einfügereihenfolge = LRU (vorne = am längsten unbenutzt). */
  private readonly byProduct = new Map<string, Entry>();
  /** Jede noch nicht widerrufene URL (aktuelle + zurückgezogene, aber noch gezeigte). */
  private readonly byUrl = new Map<string, Entry>();
  private bytes = 0;
  private scope = '';
  private readonly maxBytes: number;
  private readonly maxEntries: number;

  private readonly deps: CardImageCacheDeps;

  constructor(deps: CardImageCacheDeps) {
    this.deps = deps;
    this.maxBytes = deps.maxBytes ?? CARD_CACHE_MAX_BYTES;
    this.maxEntries = deps.maxEntries ?? CARD_CACHE_MAX_ENTRIES;
  }

  /** Mandant/Filiale/DB-Epoche. Ein anderer Scope leert den Cache (Filialwechsel, Restore, Neuladen). */
  setScope(scope: string): void {
    if (scope === this.scope) return;
    this.clear();
    this.scope = scope;
  }

  get currentScope(): string {
    return this.scope;
  }

  /** Der Eintrag eines Artikels (und als „zuletzt benutzt" markiert) — oder nichts. */
  get(productId: string): CardImageHit | undefined {
    const e = this.byProduct.get(productId);
    if (!e) return undefined;
    this.byProduct.delete(productId);
    this.byProduct.set(productId, e);
    return { url: e.url, fingerprint: e.fingerprint };
  }

  /**
   * Ein frisch geladenes Kartenbild aufnehmen; ein älterer Eintrag desselben Artikels wird zurückgezogen.
   * `hold`: der neue Eintrag ist schon einmal gehalten (Übergabe an die wartenden Karten) — der Aufrufer
   * gibt diese Übergabe mit `release(url)` zurück, sobald die Karten ihn selbst halten. So verdrängt
   * keine gleichzeitige Aufnahme ein Bild, bevor seine Karte es zeigt.
   */
  put(productId: string, blob: Blob, fingerprint: string, hold = false): CardImageHit {
    const old = this.byProduct.get(productId);
    if (old) this.retire(old);
    const url = this.deps.createObjectURL(blob);
    const e: Entry = { productId, url, bytes: blob.size, fingerprint, refs: hold ? 1 : 0, retired: false };
    this.byProduct.set(productId, e);
    this.byUrl.set(url, e);
    this.bytes += e.bytes;
    this.evict();
    return { url, fingerprint };
  }

  /** Der Fingerabdruck wurde bestätigt, das Bild aber ist ein anderes Ergebnis (kein Bild / Fehler). */
  delete(productId: string): void {
    const e = this.byProduct.get(productId);
    if (e) this.retire(e);
  }

  /** Eine Karte zeigt `url` — sie darf darunter nicht widerrufen werden. */
  acquire(url: string): void {
    const e = this.byUrl.get(url);
    if (e) e.refs += 1;
  }

  /** Die Karte zeigt `url` nicht mehr. */
  release(url: string): void {
    const e = this.byUrl.get(url);
    if (!e) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs === 0) {
      if (e.retired) this.revoke(e);
      else this.evict();
    }
  }

  /** Alles freigeben (Abmeldung, Scope-Wechsel). Gerade gezeigte URLs folgen beim letzten `release`. */
  clear(): void {
    for (const e of Array.from(this.byProduct.values())) this.retire(e);
  }

  stats(): { entries: number; bytes: number; liveUrls: number; pinned: number } {
    let pinned = 0;
    for (const e of this.byUrl.values()) if (e.refs > 0) pinned += 1;
    return { entries: this.byProduct.size, bytes: this.bytes, liveUrls: this.byUrl.size, pinned };
  }

  // ── intern ───────────────────────────────────────────────────────────────

  private retire(e: Entry): void {
    if (this.byProduct.get(e.productId) === e) this.byProduct.delete(e.productId);
    e.retired = true;
    if (e.refs === 0) this.revoke(e);
  }

  private revoke(e: Entry): void {
    if (!this.byUrl.delete(e.url)) return;
    this.bytes -= e.bytes;
    try {
      this.deps.revokeObjectURL(e.url);
    } catch {
      /* eine bereits ungültige URL ist kein Fehler */
    }
  }

  /** Älteste, nicht gezeigte Einträge zurückziehen, bis Bytes UND Anzahl unter der Grenze liegen. */
  private evict(): void {
    if (this.bytes <= this.maxBytes && this.byProduct.size <= this.maxEntries) return;
    for (const e of Array.from(this.byProduct.values())) {
      if (this.bytes <= this.maxBytes && this.byProduct.size <= this.maxEntries) return;
      if (e.refs === 0) this.retire(e);
    }
  }
}

// ── die eine Instanz der Sitzung ────────────────────────────────────────────

let shared: CardImageCache | null = null;

/** Der Cache dieses Fensters (lebt nur im Arbeitsspeicher; ein Neustart/Neuladen leert ihn). */
export function sharedCardImageCache(): CardImageCache {
  if (!shared) {
    shared = new CardImageCache({
      createObjectURL: (b) => URL.createObjectURL(b),
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
    });
  }
  return shared;
}

/** Abmeldung: alle Kartenbilder freigeben. */
export function clearSharedCardImageCache(): void {
  shared?.clear();
}

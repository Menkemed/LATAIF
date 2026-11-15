// ════════════════════════════════════════════════════════════════════════════
// BILDSPEICHER — die EINE Stelle, die einem Bild seine Größenklasse gibt.
//
// Owner-Entscheidung (14.11.2026):
//   Uhren                                       Hauptbild 60 KB · Vorschau 10 KB
//   Schmuck, Accessories                        Hauptbild 30 KB · Vorschau 10 KB
//   Reparaturen ohne eindeutige Kategorie       Hauptbild 60 KB · Vorschau 10 KB
//   Aufträge, Altgold, Einkaufs-Inbox           30 KB bei Schmuck/Accessories, sonst 60 KB
//   Ausweise                                    unverändert (100 KB / 20 KB), bis eine geprüfte
//                                               60-KB-Fassung vom Owner freigegeben ist
//
// Daraus folgt EINE Regel: 30 KB nur, wenn die Kategorie eindeutig Schmuck oder Accessory ist;
// jede andere oder fehlende Kategorie bekommt 60 KB (die größere Grenze ist die sichere). Ein
// Ausweis oder ein Objekt einer höheren Sicherheitsklasse bleibt `standard`.
//
// Die Grenzen selbst stehen in Rust (`normalize.rs`, `SizeProfile`); der Name einer Klasse ist der
// Draht-Vertrag und Teil des kanonischen Anfrage-Hashes (`canonicalRequestHash`).
// ════════════════════════════════════════════════════════════════════════════

export type MediaSizeProfile = 'standard' | 'main60' | 'main30';

/** Byte-Grenzen je Klasse — Spiegel von `SizeProfile` in Rust (Tests halten beide gleich). */
export const SIZE_PROFILE_LIMITS: Readonly<Record<MediaSizeProfile, { main: number; thumbnail: number }>> = {
  standard: { main: 100_000, thumbnail: 20_000 },
  main60: { main: 60_000, thumbnail: 10_000 },
  main30: { main: 30_000, thumbnail: 10_000 },
};

/** Normalisierungsparameter je Klasse — WORTGLEICH mit `SizeProfile::norm_params` in Rust. */
export const SIZE_PROFILE_NORM_PARAMS: Readonly<Record<MediaSizeProfile, string>> = {
  standard: 'main<=100000;thumb<=20000;out=jpeg',
  main60: 'main<=60000;thumb<=10000;out=jpeg',
  main30: 'main<=30000;thumb<=10000;out=jpeg',
};

/** Die Kategorien, deren Bilder mit 30 KB auskommen (Schmuck + Accessories). */
export const MAIN30_CATEGORY_IDS: ReadonlySet<string> = new Set([
  'cat-gold-jewelry',
  'cat-branded-gold-jewelry',
  'cat-original-gold-jewelry',
  'cat-accessory',
]);

/** Besitzer, deren Bilder NIE automatisch verkleinert werden (Ausweise, Dokumente). */
const STANDARD_ROLES: ReadonlySet<string> = new Set(['identity_document']);

export interface SizeProfileInput {
  /** Kategorie des Artikels (Produkt) bzw. des Gegenstands (Reparatur, Auftrag, Inbox). */
  categoryId?: string | null;
  /** Medienrolle (`stock_image`, `gallery`, `identity_document`, …). */
  role?: string | null;
  /** Sicherheitsklasse des Objekts; alles außer `internal`/`public` bleibt `standard`. */
  securityClass?: string | null;
}

/** Die Klasse für ein NEUES Bild bzw. die Zielklasse eines bestehenden. */
export function sizeProfileFor(input: SizeProfileInput): MediaSizeProfile {
  if (input.role && STANDARD_ROLES.has(input.role)) return 'standard';
  const cls = input.securityClass ?? 'internal';
  if (cls !== 'internal' && cls !== 'public') return 'standard';
  const cat = typeof input.categoryId === 'string' ? input.categoryId.trim() : '';
  return cat && MAIN30_CATEGORY_IDS.has(cat) ? 'main30' : 'main60';
}

/** Draht-Name prüfen (ein unbekannter Name ist ein Fehler, nie ein stiller Rückfall). */
export function isMediaSizeProfile(v: unknown): v is MediaSizeProfile {
  return v === 'standard' || v === 'main60' || v === 'main30';
}

// ════════════════════════════════════════════════════════════════════════════
// PAYMENT-DATE (Owner 12.11.2026) — der Tag, an dem eine Zahlung WIRKLICH war (Ausgabe, „Pay Supplier").
//
// Ein Zahlungstag ist ein Kalendertag in BAHRAIN (Asia/Bahrain, ganzjährig UTC+3, keine Sommerzeit) — unabhängig
// von der Zeitzone des Rechners. Die allgemeine Regel (`business-date`, UTC + ein Tag Spielraum) hätte hier zweierlei
// falsch gemacht: zwischen 00:00 und 03:00 Ortszeit war „heute" noch gestern, und den MORGIGEN Tag ließ sie zu.
//   • vorbelegt: der heutige Tag in Bahrain;
//   • erlaubt: jeder echte Tag bis einschließlich heute in Bahrain (Vergangenheit ja, Zukunft nein).
// Den Periodenschutz (Eröffnungsstichtag, eingereichtes VAT-Quartal) und „nicht vor dem Beleg" prüft das Haus.
//
// Rein, ohne Datenbank und ohne Alias-Importe — Maske, Speicherweg (auch PC2), Fernbefehl und Haus prüfen damit dasselbe.
// ════════════════════════════════════════════════════════════════════════════

const BAHRAIN_OFFSET_MS = 3 * 3_600_000;

/** Der heutige Kalendertag in Bahrain (JJJJ-MM-TT). */
export function bahrainTodayIso(nowMs: number = Date.now()): string {
  return new Date(nowMs + BAHRAIN_OFFSET_MS).toISOString().slice(0, 10);
}

/** `null` = in Ordnung (leer heißt „heute"); sonst der Satz für den Menschen. */
export function paymentDateIssue(value: unknown, label: string, nowMs: number = Date.now()): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return `${label} is not a valid date`;
  const t = Date.parse(value + 'T00:00:00.000Z');
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return `${label} is not a valid date`;
  const heute = bahrainTodayIso(nowMs);
  if (value > heute) return `${label} cannot be in the future (today in Bahrain is ${heute})`;
  return null;
}

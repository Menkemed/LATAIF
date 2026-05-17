// ═══════════════════════════════════════════════════════════
// Country-Codes fuer das PhoneInput-Component.
//
// Speicherung: Telefonnummern landen weiterhin in EINER `phone` TEXT-Spalte
// — aber als E.164 ("+97336123456"). Beim Edit-Render wird der Wert per
// Prefix-Match zurueck in Country + National-Number aufgesplittet, sodass
// das Dropdown den korrekten Eintrag selektiert.
//
// Erweitern: einfach einen Eintrag ins COUNTRIES-Array zufuegen — keine
// Migration noetig.
// ═══════════════════════════════════════════════════════════

export interface CountryCode {
  iso: string;           // ISO-3166-1 Alpha-2 (z.B. 'BH'). Dient als stable id.
  dial: string;          // E.164 Country-Code mit "+" (z.B. '+973').
  label: string;         // Anzeigename (z.B. 'Bahrain').
  flag: string;          // Emoji-Flag.
  example?: string;      // Beispiel-National-Number (UI-Placeholder).
  maxLength?: number;    // Erwartete National-Number-Maximallaenge (Validation; weich).
}

// Default = Bahrain (lokaler Markt). Reihenfolge im Dropdown entspricht der
// hier definierten Reihenfolge: BH zuerst, dann die uebrigen GCC-Laender,
// dann Westen.
export const COUNTRIES: CountryCode[] = [
  { iso: 'BH', dial: '+973', label: 'Bahrain',       flag: '🇧🇭', example: '3612 3456', maxLength: 8 },
  { iso: 'SA', dial: '+966', label: 'Saudi Arabia',  flag: '🇸🇦', example: '5xxxxxxxx',  maxLength: 9 },
  { iso: 'KW', dial: '+965', label: 'Kuwait',        flag: '🇰🇼', example: '5xxxxxxx',   maxLength: 8 },
  { iso: 'AE', dial: '+971', label: 'United Arab Emirates', flag: '🇦🇪', example: '5xxxxxxxx', maxLength: 9 },
  { iso: 'QA', dial: '+974', label: 'Qatar',         flag: '🇶🇦', example: '3xxxxxxx',   maxLength: 8 },
  { iso: 'OM', dial: '+968', label: 'Oman',          flag: '🇴🇲', example: '9xxxxxxx',   maxLength: 8 },
  { iso: 'US', dial: '+1',   label: 'United States', flag: '🇺🇸', example: '2125551234', maxLength: 10 },
  { iso: 'GB', dial: '+44',  label: 'United Kingdom',flag: '🇬🇧', example: '7700900123',  maxLength: 10 },
];

export const DEFAULT_COUNTRY: CountryCode = COUNTRIES[0];

export function findCountryByIso(iso: string): CountryCode | undefined {
  return COUNTRIES.find(c => c.iso === iso);
}

// Splittet einen gespeicherten E.164-String in Country + National-Number.
// Wenn die gespeicherte Zeichenkette keinem bekannten Dial-Prefix entspricht,
// fallback: Default-Country + roher Rest (so geht alte/uneindeutige Daten nicht verloren).
//
// Optional `countries`-Parameter: erlaubt der UI eine erweiterte Liste (built-in
// + custom aus Settings) zu uebergeben, ohne dass dieses Modul den Store importieren
// muss (circular-import-frei).
export function splitPhone(
  stored: string | undefined | null,
  countries: CountryCode[] = COUNTRIES,
): { country: CountryCode; national: string } {
  if (!stored) return { country: DEFAULT_COUNTRY, national: '' };
  const s = String(stored).trim();
  if (!s) return { country: DEFAULT_COUNTRY, national: '' };

  // Wenn kein "+", versuche "00"-Notation umzuwandeln; sonst nehme die Default-Country an.
  const normalized = s.startsWith('+') ? s : (s.startsWith('00') ? '+' + s.slice(2) : '');
  if (!normalized) {
    // Roh-String ohne Country-Code-Prefix — nationale Nummer mit Default-Country annehmen.
    return { country: DEFAULT_COUNTRY, national: digitsOnly(s) };
  }

  // Match mit dem laengsten passenden Dial-Prefix (USA "+1" sollte erst nach "+1xxx" gepruft werden,
  // aber "+1" ist hier eindeutig). Wir sortieren nach Dial-Laenge desc.
  const sorted = [...countries].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (normalized.startsWith(c.dial)) {
      return { country: c, national: digitsOnly(normalized.slice(c.dial.length)) };
    }
  }
  // Unbekannter Country-Code → roher String erhalten, Default-Country zeigen.
  return { country: DEFAULT_COUNTRY, national: digitsOnly(normalized) };
}

// Baut den E.164-String fuer Speicherung. Leerer national → leerer String (kein '+973').
export function joinPhone(country: CountryCode, national: string): string {
  const d = digitsOnly(national);
  if (!d) return '';
  return country.dial + d;
}

export function digitsOnly(s: string): string {
  return (s || '').replace(/\D+/g, '');
}

// Liefert die letzten N Digits einer Nummer (fuer Matching/Suche unabhaengig vom Country-Format).
export function normalizedTail(stored: string | undefined | null, n = 8): string {
  const d = digitsOnly(String(stored || ''));
  return d.slice(-n);
}

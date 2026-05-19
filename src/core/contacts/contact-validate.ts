// ═══════════════════════════════════════════════════════════
// LATAIF — Contact Field Soft-Validation (CPR + Phone per country)
//
// Salesforce-Stil: NIEMALS hart blockieren. Validation gibt nur eine
// "warning"-Message zurueck, damit der User sieht dass etwas ungewoehnlich
// aussieht (z.B. Bahrain-Phone mit nur 6 Digits statt 8), aber er kann
// trotzdem speichern — Edge-Cases (Auslaendische Tourist-Belege, Custom-CPR
// fuer juristische Personen, alte 8-stellige CPRs) bleiben moeglich.
//
// Konvention:
//   ok=true        → Feld ist plausibel ODER leer (leer ist erlaubt)
//   warning='...'  → Feld ist gesetzt, sieht aber komisch aus → gelber Hinweis
// ═══════════════════════════════════════════════════════════

import { COUNTRIES, splitPhone, digitsOnly, type CountryCode } from './country-codes';

export interface ValidationResult {
  ok: boolean;
  warning?: string;
}

// ─── CPR (Bahrain Central Population Registry) ───
//
// Heute neu ausgestellte CPRs sind 9 Digits. Altbestand (vor ~2008) kann
// 8 Digits haben. Wir akzeptieren also 8 ODER 9; alles andere → Warnung.
// Alpha-Zeichen (manche Firmen-IDs / CR-Numbers) explizit erlaubt — nicht
// jeder Beleg-Empfaenger ist eine Privatperson mit CPR.
export function validateCpr(raw: string | undefined | null): ValidationResult {
  const v = String(raw || '').trim();
  if (!v) return { ok: true };
  const digits = digitsOnly(v);
  // Pure-Digit CPR: 8 oder 9 Stellen ok
  if (digits === v.replace(/[\s-]/g, '')) {
    if (digits.length === 9 || digits.length === 8) return { ok: true };
    if (digits.length < 8) return { ok: false, warning: `CPR sieht zu kurz aus (${digits.length} Ziffern) — Bahrain CPR hat 9 Ziffern.` };
    return { ok: false, warning: `CPR sieht zu lang aus (${digits.length} Ziffern) — Bahrain CPR hat 9 Ziffern.` };
  }
  // Alphanumerisch (z.B. CR-Number) → kein Hard-Check, nur Hinweis wenn extrem ungewoehnlich
  if (v.length < 4) {
    return { ok: false, warning: 'ID sieht zu kurz aus.' };
  }
  return { ok: true };
}

// ─── Phone per Country ───
//
// Erwartet ein E.164-String (z.B. "+97336123456") wie ihn PhoneInput liefert.
// Splittet in Country + National, prueft die National-Laenge gegen das
// erwartete maxLength des Country. Tolerant: +/-1 Digit ist ok (manche Laender
// haben variable Laengen, z.B. UAE 8 oder 9), >2 Abweichung → Warnung.
export function validatePhone(
  e164: string | undefined | null,
  countries: CountryCode[] = COUNTRIES,
): ValidationResult {
  const v = String(e164 || '').trim();
  if (!v) return { ok: true };

  const { country, national } = splitPhone(v, countries);
  const len = national.length;
  const expected = country.maxLength || 0;

  if (len === 0) {
    return { ok: false, warning: `Telefonnummer fehlt (${country.dial} ohne Nummer).` };
  }

  // GCC-spezifische Heuristik: erste Digit muss zum Mobile-Prefix passen.
  // (Nur Bahrain/UAE/Saudi/Kuwait/Qatar/Oman — fuer USA/UK skip wir das.)
  const firstDigit = national[0];
  const mobilePrefixHint: Record<string, string[]> = {
    BH: ['3', '6', '7'],   // 3xxx + 6xxx + 7xxx sind Mobile in Bahrain
    AE: ['5'],             // 5xxxxxxxx Mobile in UAE
    SA: ['5'],             // 5xxxxxxxx Mobile in Saudi
    KW: ['5', '6', '9'],   // Kuwait Mobile
    QA: ['3', '5', '6', '7'],
    OM: ['7', '9'],
  };
  const expectedPrefixes = mobilePrefixHint[country.iso];

  if (expected > 0) {
    if (len < expected - 1) {
      return { ok: false, warning: `${country.label}-Nummer sieht zu kurz aus (${len}/${expected} Ziffern).` };
    }
    if (len > expected + 2) {
      return { ok: false, warning: `${country.label}-Nummer sieht zu lang aus (${len}/${expected} Ziffern).` };
    }
  }

  if (expectedPrefixes && !expectedPrefixes.includes(firstDigit)) {
    return {
      ok: false,
      warning: `Ungewoehnliche Vorwahl fuer ${country.label}-Mobile — erwartet beginnend mit ${expectedPrefixes.join('/')}.`,
    };
  }

  return { ok: true };
}

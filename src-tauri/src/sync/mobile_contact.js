// MOBILE-CONTACT — Vorwahl und Ausweisnummer eines Kunden, EINMAL fuer jede Maske des Telefons (Einkauf, Reparatur,
// Kommission), so wie am Rechner.
//
// Die Vorwahlen sind die des Rechners (`src/core/contacts/country-codes.ts`, COUNTRIES — der Test nagelt die Liste an die
// Quelle). Gespeichert wird wie dort EIN Wert in E.164 („+97336123456"): `splitPhone`/`joinPhone` folgen denselben Regeln
// wie der PhoneInput des Rechners. Die Hinweise folgen `validatePhone`/`validateCpr` (`src/core/contacts/contact-validate.ts`)
// und sind wie dort weich — nie eine Sperre.
//
// Woertlich in die Handy-Seite eingebettet (vor den Befehlsdateien) und in node pruefbar.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileContact = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COUNTRIES = [
    { iso: 'BH', dial: '+973', label: 'Bahrain', flag: '🇧🇭', example: '3612 3456', maxLength: 8 },
    { iso: 'SA', dial: '+966', label: 'Saudi Arabia', flag: '🇸🇦', example: '5xxxxxxxx', maxLength: 9 },
    { iso: 'KW', dial: '+965', label: 'Kuwait', flag: '🇰🇼', example: '5xxxxxxx', maxLength: 8 },
    { iso: 'AE', dial: '+971', label: 'United Arab Emirates', flag: '🇦🇪', example: '5xxxxxxxx', maxLength: 9 },
    { iso: 'QA', dial: '+974', label: 'Qatar', flag: '🇶🇦', example: '3xxxxxxx', maxLength: 8 },
    { iso: 'OM', dial: '+968', label: 'Oman', flag: '🇴🇲', example: '9xxxxxxx', maxLength: 8 },
    { iso: 'US', dial: '+1', label: 'United States', flag: '🇺🇸', example: '2125551234', maxLength: 10 },
    { iso: 'GB', dial: '+44', label: 'United Kingdom', flag: '🇬🇧', example: '7700900123', maxLength: 10 },
  ];
  const DEFAULT_ISO = 'BH';
  /** Wie `validatePhone` am Rechner: die Anfangsziffern einer Handynummer am Golf. */
  const MOBILE_PREFIXES = { BH: ['3', '6', '7'], AE: ['5'], SA: ['5'], KW: ['5', '6', '9'], QA: ['3', '5', '6', '7'], OM: ['7', '9'] };

  function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }
  function countryOf(iso) { return COUNTRIES.find((c) => c.iso === iso) || COUNTRIES[0]; }
  /** Die Beschriftung einer Vorwahl in der Auswahl. */
  function optionLabel(c) { return c.flag + ' ' + c.dial; }
  /** Wie `splitPhone`: „+973…"/„00973…" → Land + Nummer (laengste passende Vorwahl); ohne Vorwahl → Bahrain + Ziffern. */
  function splitPhone(stored) {
    const s = String(stored == null ? '' : stored).trim();
    if (!s) return { iso: DEFAULT_ISO, national: '' };
    const norm = s.charAt(0) === '+' ? s : (s.slice(0, 2) === '00' ? '+' + s.slice(2) : '');
    if (!norm) return { iso: DEFAULT_ISO, national: digitsOnly(s) };
    const sorted = COUNTRIES.slice().sort((a, b) => b.dial.length - a.dial.length);
    for (const c of sorted) if (norm.indexOf(c.dial) === 0) return { iso: c.iso, national: digitsOnly(norm.slice(c.dial.length)) };
    return { iso: DEFAULT_ISO, national: digitsOnly(norm) };
  }
  /** Wie `joinPhone`: leere Nummer → '' (nie ein „+973" allein). */
  function joinPhone(iso, national) {
    const d = digitsOnly(national);
    return d ? countryOf(iso).dial + d : '';
  }
  /** Weicher Hinweis wie `validatePhone` am Rechner. Leer = nichts zu sagen. */
  function phoneHint(iso, national) {
    const d = digitsOnly(national);
    if (!d) return '';
    const c = countryOf(iso), max = c.maxLength || 0;
    if (max && d.length < max - 1) return c.label + ' number looks too short (' + d.length + '/' + max + ' digits).';
    if (max && d.length > max + 2) return c.label + ' number looks too long (' + d.length + '/' + max + ' digits).';
    const pre = MOBILE_PREFIXES[c.iso];
    if (pre && pre.indexOf(d.charAt(0)) < 0) return 'Unusual start for a ' + c.label + ' mobile number — expected ' + pre.join('/') + '.';
    return '';
  }
  /** Weicher Hinweis wie `validateCpr` am Rechner: reine Ziffern → 8 oder 9; Buchstaben (Pass, CR) sind erlaubt. */
  function personalIdHint(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) return '';
    const d = digitsOnly(v);
    if (d === v.replace(/[\s-]/g, '')) {
      if (d.length === 8 || d.length === 9) return '';
      return 'CPR looks too ' + (d.length < 8 ? 'short' : 'long') + ' (' + d.length + ' digits) — a Bahrain CPR has 9 digits.';
    }
    return v.length < 4 ? 'ID looks too short.' : '';
  }
  /** Die Kontaktfelder fuer `customers.create` (und die neue Person beim Einkauf): nur, was gesetzt ist. */
  function contactFields(iso, national, personalId) {
    const out = {};
    const phone = joinPhone(iso, national);
    if (phone) out.phone = phone;
    const id = String(personalId == null ? '' : personalId).trim();
    if (id) out.personalId = id;
    return out;
  }

  return {
    COUNTRIES: COUNTRIES, DEFAULT_ISO: DEFAULT_ISO, digitsOnly: digitsOnly, countryOf: countryOf, optionLabel: optionLabel,
    splitPhone: splitPhone, joinPhone: joinPhone, phoneHint: phoneHint, personalIdHint: personalIdHint, contactFields: contactFields,
  };
}));

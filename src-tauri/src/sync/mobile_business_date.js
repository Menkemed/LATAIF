// BUSINESS-DATE — das wählbare Datum eines Vorgangs am Telefon (Einkauf, Reparatur, Kommission).
//
// Dieselbe Regel wie `src/core/utils/business-date.ts` am Rechner/Primary (ein Paritätstest hält
// beide gleich): ein echter Kalendertag JJJJ-MM-TT, nicht in der Zukunft (ein Tag Spielraum für
// die Zeitzone); leer heißt „heute". Verbindlich prüft der Primary — das Telefon sagt es nur früher.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileBusinessDate = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAG = 86400000;
  const jetzt = function (nowMs) { return nowMs === undefined ? Date.now() : nowMs; };

  /** Der heutige Tag, wie die Masken ihn vorbelegen. */
  function todayIso(nowMs) { return new Date(jetzt(nowMs)).toISOString().split('T')[0]; }

  /** Der späteste Tag, den ein Datumsfeld anbietet (`max`). */
  function latestBusinessDate(nowMs) { return todayIso(jetzt(nowMs) + TAG); }

  /** `null` = in Ordnung (leer heißt „heute"); sonst der Satz für den Menschen. */
  function businessDateIssue(value, label, nowMs) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return label + ' is not a valid date';
    const t = Date.parse(value + 'T00:00:00.000Z');
    if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value) return label + ' is not a valid date';
    if (t > jetzt(nowMs) + TAG) return label + ' cannot be in the future';
    return null;
  }

  /** Ein gültiger, nicht künftiger Tag im Format JJJJ-MM-TT. */
  function isBusinessDate(value, nowMs) {
    return typeof value === 'string' && value.length === 10 && businessDateIssue(value, 'date', nowMs) === null;
  }

  /**
   * Das Datum, das in den AUFTRAG geht: immer ein ausgeschriebener Tag. Ein leeres Feld wird hier zu
   * „heute" — der Rumpf trägt den Tag, damit eine Wiederholung unter derselben Kennung an einem
   * späteren Tag nicht auf das dann gültige „heute" des Primary fällt.
   */
  function pickDate(value, label, nowMs) {
    const roh = value === undefined || value === null ? '' : String(value).trim();
    if (roh === '') return { ok: true, date: todayIso(nowMs) };
    const fehler = businessDateIssue(roh, label, nowMs);
    return fehler ? { ok: false, message: fehler } : { ok: true, date: roh };
  }

  return {
    todayIso: todayIso, latestBusinessDate: latestBusinessDate,
    businessDateIssue: businessDateIssue, isBusinessDate: isBusinessDate, pickDate: pickDate,
  };
}));

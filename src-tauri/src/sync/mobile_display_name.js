// DISPLAY-NAME — der Anzeigename eines Artikels am Telefon.
//
// Derselbe Algorithmus wie `src/core/products/display-name.ts` am Rechner (ein Paritätstest hält
// beide gleich): Marke/Modell, wenn vorhanden; sonst aus den Merkmalen „Schmuckart · Beschreibung ·
// Karat · Gewicht", z. B. „Ring · Baguette Diamond · 18K White · 3.10 g"; sonst der Kategoriename.
// Gespeichert wird hier nichts.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileDisplayName = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Bei dieser Kategorie stehen Marke und Modell nicht in den Masken — die Merkmale sagen es schon. */
  const BRAND_MODEL_HIDDEN_CATEGORIES = ['cat-gold-jewelry'];

  function brandModelHidden(categoryId) {
    return BRAND_MODEL_HIDDEN_CATEGORIES.indexOf(String(categoryId == null ? '' : categoryId)) >= 0;
  }

  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

  function attrsOf(a) {
    if (!a) return {};
    if (typeof a === 'string') {
      try { const o = JSON.parse(a); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
    }
    return a;
  }

  function sanfteSchreibweise(s) {
    if (!s || s !== s.toUpperCase() || s === s.toLowerCase()) return s;
    return s.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (_m, p, c) => p + c.toUpperCase());
  }

  function gewicht(v) {
    const n = typeof v === 'number' ? v : Number(text(v));
    if (!Number.isFinite(n) || n <= 0) return '';
    return (Number.isInteger(n) ? String(n) : n.toFixed(2)) + ' g';
  }

  function nameFromAttributes(attributes) {
    const a = attrsOf(attributes);
    const art = text(a.item_type);
    let beschreibung = sanfteSchreibweise(text(a.description));
    if (beschreibung && art && beschreibung.toLowerCase() === art.toLowerCase()) beschreibung = '';
    return [art, beschreibung, text(a.karat), gewicht(a.weight)].filter(Boolean).join(' · ');
  }

  /** `categoryName` optional — der Name der Kategorie als letzte Rückfalllösung. */
  function displayName(p, categoryName) {
    if (!p) return '';
    const marke = text(p.brand);
    const modell = text(p.name);
    if (marke || modell) return [marke, modell].filter(Boolean).join(' ');
    const ausMerkmalen = nameFromAttributes(p.attributes);
    if (ausMerkmalen) return ausMerkmalen;
    return text(categoryName);
  }

  function displayLines(p, categoryName) {
    if (!p) return { overline: '', title: '' };
    const marke = text(p.brand);
    const modell = text(p.name);
    if (marke && modell) return { overline: marke, title: modell };
    if (marke || modell) return { overline: '', title: marke || modell };
    return { overline: '', title: displayName(p, categoryName) };
  }

  /**
   * AI Identify bei Gold-Diamond Jewellery: keine Marke, kein Modell. Steht die Schmuckart dort,
   * wandert sie nach `item_type` (nur wenn leer und eine der Auswahlen). Andere Kategorien unberührt.
   */
  function aiResultForCategory(result, categoryId, itemTypeOptions) {
    if (!result || !brandModelHidden(categoryId)) return result;
    const attributes = Object.assign({}, result.attributes || {});
    const optionen = itemTypeOptions || [];
    if (!text(attributes.item_type)) {
      for (const v of [text(result.brand), text(result.name)]) {
        const treffer = optionen.find((o) => o.toLowerCase() === v.toLowerCase());
        if (treffer) { attributes.item_type = treffer; break; }
      }
    }
    const out = Object.assign({}, result, { attributes: attributes });
    delete out.brand;
    delete out.name;
    return out;
  }

  return {
    BRAND_MODEL_HIDDEN_CATEGORIES: BRAND_MODEL_HIDDEN_CATEGORIES,
    brandModelHidden: brandModelHidden,
    nameFromAttributes: nameFromAttributes,
    displayName: displayName,
    displayLines: displayLines,
    aiResultForCategory: aiResultForCategory,
  };
}));

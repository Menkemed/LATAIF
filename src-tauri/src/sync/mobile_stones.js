// STONES — die Steinliste für Gold-Diamond Jewellery am Telefon.
//
// Dieselbe Struktur, dieselben Listen und dieselbe Prüfung wie `src/core/products/stones.ts` am
// Rechner/Primary (ein Paritätstest hält beide gleich). Gespeichert wird `attributes.stones`:
// [{ type, qty, carat?, name?, color?, clarity?, shape? }] — kanonische Schlüssel, Reihenfolge bleibt.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileStones = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STONES_KEY = 'stones';
  const DIAMOND_WEIGHT_KEY = 'diamond_weight';
  const STONE_CATEGORIES = ['cat-gold-jewelry'];
  function stonesApply(categoryId) { return STONE_CATEGORIES.indexOf(String(categoryId == null ? '' : categoryId)) >= 0; }

  const STONE_TYPES = [
    { key: 'diamond', label: 'Diamond' }, { key: 'emerald', label: 'Emerald' }, { key: 'sapphire', label: 'Sapphire' },
    { key: 'ruby', label: 'Ruby' }, { key: 'pearl', label: 'Pearl' }, { key: 'moissanite', label: 'Moissanite' },
    { key: 'cubic_zirconia', label: 'Cubic Zirconia' }, { key: 'amethyst', label: 'Amethyst' },
    { key: 'aquamarine', label: 'Aquamarine' }, { key: 'topaz', label: 'Topaz' }, { key: 'tourmaline', label: 'Tourmaline' },
    { key: 'opal', label: 'Opal' }, { key: 'garnet', label: 'Garnet' }, { key: 'onyx', label: 'Onyx' },
    { key: 'turquoise', label: 'Turquoise' }, { key: 'other', label: 'Other' },
  ];
  const DIAMOND_COLORS = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N-Z', 'Fancy'].map((c) => ({ key: c, label: c }));
  const DIAMOND_CLARITIES = ['FL', 'IF', 'VVS1', 'VVS2', 'VVS', 'VS1', 'VS2', 'VS', 'SI1', 'SI2', 'SI', 'I1', 'I2', 'I3'].map((c) => ({ key: c, label: c }));
  const DIAMOND_SHAPES = [
    { key: 'round', label: 'Round' }, { key: 'princess', label: 'Princess' }, { key: 'oval', label: 'Oval' },
    { key: 'cushion', label: 'Cushion' }, { key: 'emerald', label: 'Emerald cut' }, { key: 'pear', label: 'Pear' },
    { key: 'marquise', label: 'Marquise' }, { key: 'radiant', label: 'Radiant' }, { key: 'asscher', label: 'Asscher' },
    { key: 'heart', label: 'Heart' }, { key: 'baguette', label: 'Baguette' }, { key: 'trillion', label: 'Trillion' },
  ];

  const MAX_STONE_ROWS = 50;
  const MAX_STONE_QTY = 100000;
  const MAX_CARAT_THOUSANDTHS = 10000000;
  const MAX_STONE_NAME = 60;
  const ROW_KEYS = ['type', 'qty', 'carat', 'name', 'color', 'clarity', 'shape'];
  const DIAMOND_ONLY = ['color', 'clarity', 'shape'];

  const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
  function labelOf(list, key) { const o = list.find((x) => x.key === key); return o ? o.label : key; }
  function stoneTypeLabel(key) { return labelOf(STONE_TYPES, key); }
  function diamondShapeLabel(key) { return labelOf(DIAMOND_SHAPES, key); }

  function caratThousandths(v) {
    if (v === null || v === undefined || v === '') return null;
    let s;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return NaN; s = String(v); }
    else if (typeof v === 'string') { s = v.trim().replace(',', '.'); if (s === '') return null; }
    else return NaN;
    const m = /^(\d{1,6})(?:\.(\d{1,3}))?$/.exec(s);
    if (!m) return NaN;
    const t = Number(m[1]) * 1000 + Number((m[2] || '').padEnd(3, '0'));
    if (t <= 0 || t > MAX_CARAT_THOUSANDTHS) return NaN;
    return t;
  }
  function fmtCarat(thousandths) {
    const ganz = Math.floor(thousandths / 1000);
    const rest = String(thousandths % 1000).padStart(3, '0');
    return ganz + '.' + (rest.endsWith('0') ? rest.slice(0, 2) : rest);
  }
  function qtyOf(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v >= 1 && v <= MAX_STONE_QTY ? v : NaN;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) { const n = Number(v.trim()); return n >= 1 && n <= MAX_STONE_QTY ? n : NaN; }
    return NaN;
  }
  function istLeer(r) { return ROW_KEYS.every((k) => text(r[k]) === ''); }

  function parseStones(raw) {
    const issues = [];
    const rows = [];
    if (raw === undefined || raw === null || raw === '') return { rows: rows, issues: issues };
    if (!Array.isArray(raw)) return { rows: rows, issues: [{ row: -1, field: STONES_KEY, code: 'STONES_INVALID', message: 'Stones must be a list.' }] };
    if (raw.length > MAX_STONE_ROWS) issues.push({ row: -1, field: STONES_KEY, code: 'STONES_TOO_MANY', message: 'At most ' + MAX_STONE_ROWS + ' stone rows.' });
    raw.forEach((r, i) => {
      const n = 'Stone ' + (i + 1) + ': ';
      if (!r || typeof r !== 'object' || Array.isArray(r)) { issues.push({ row: i, field: 'row', code: 'STONE_ROW_INVALID', message: n + 'not a stone row.' }); return; }
      if (istLeer(r)) return;
      for (const k of Object.keys(r)) {
        if (ROW_KEYS.indexOf(k) < 0) issues.push({ row: i, field: k, code: 'STONE_FIELD_UNKNOWN', message: n + 'unknown field "' + k + '".' });
      }
      const type = text(r.type);
      const out = { type: type, qty: 0 };
      if (!type) issues.push({ row: i, field: 'type', code: 'STONE_TYPE_REQUIRED', message: n + 'choose the stone type.' });
      else if (!STONE_TYPES.some((t) => t.key === type)) issues.push({ row: i, field: 'type', code: 'STONE_TYPE_INVALID', message: n + 'unknown stone type "' + type + '".' });
      const qty = qtyOf(r.qty);
      if (Number.isNaN(qty)) issues.push({ row: i, field: 'qty', code: 'STONE_QTY_INVALID', message: n + 'quantity must be a whole number of at least 1.' });
      else out.qty = qty;
      const ct = caratThousandths(r.carat);
      if (Number.isNaN(ct)) issues.push({ row: i, field: 'carat', code: 'STONE_CARAT_INVALID', message: n + 'total carat must be a positive number with at most 3 decimals.' });
      else if (ct !== null) out.carat = ct / 1000;
      const name = text(r.name);
      if (type === 'other') {
        if (!name) issues.push({ row: i, field: 'name', code: 'STONE_NAME_REQUIRED', message: n + 'enter the stone name for "Other".' });
        else if (name.length > MAX_STONE_NAME) issues.push({ row: i, field: 'name', code: 'STONE_NAME_TOO_LONG', message: n + 'stone name is longer than ' + MAX_STONE_NAME + ' characters.' });
        else out.name = name;
      } else if (name) {
        issues.push({ row: i, field: 'name', code: 'STONE_NAME_ONLY_OTHER', message: n + 'a stone name belongs only to "Other".' });
      }
      for (const k of DIAMOND_ONLY) {
        const v = text(r[k]);
        if (!v) continue;
        if (type !== 'diamond') { issues.push({ row: i, field: k, code: 'STONE_DIAMOND_ONLY', message: n + k + ' belongs only to diamonds.' }); continue; }
        const list = k === 'color' ? DIAMOND_COLORS : k === 'clarity' ? DIAMOND_CLARITIES : DIAMOND_SHAPES;
        if (!list.some((o) => o.key === v)) issues.push({ row: i, field: k, code: 'STONE_' + k.toUpperCase() + '_INVALID', message: n + 'unknown ' + k + ' "' + v + '".' });
        else out[k] = v;
      }
      rows.push(out);
    });
    return { rows: issues.length ? [] : rows, issues: issues };
  }

  function readStones(raw) {
    let v = raw;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } }
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const r of v) { const p = parseStones([r]); if (!p.issues.length && p.rows[0]) out.push(p.rows[0]); }
    return out;
  }

  function diamondCaratThousandths(rows) {
    let sum = null;
    for (const r of rows) {
      if (r.type !== 'diamond' || r.carat === undefined) continue;
      const t = caratThousandths(r.carat);
      if (t === null || Number.isNaN(t)) continue;
      sum = (sum === null ? 0 : sum) + t;
    }
    return sum;
  }
  function storedThousandths(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 1000);
  }
  function diamondWeightInfo(attributes) {
    const a = attributes || {};
    const summe = diamondCaratThousandths(readStones(a[STONES_KEY]));
    if (summe !== null) return { thousandths: summe, source: 'stones' };
    const alt = storedThousandths(a[DIAMOND_WEIGHT_KEY]);
    return alt !== null ? { thousandths: alt, source: 'legacy' } : { thousandths: null, source: 'none' };
  }

  function stoneRowLabel(r) {
    const art = r.type === 'other' ? (r.name || 'Other') : stoneTypeLabel(r.type);
    const t = caratThousandths(r.carat);
    return [art, 'Qty ' + r.qty, t && !Number.isNaN(t) ? fmtCarat(t) + ' ct' : '',
      r.color || '', r.clarity || '', r.shape ? diamondShapeLabel(r.shape) : ''].filter(Boolean).join(' · ');
  }
  function stonesSummary(rowsOrRaw) {
    const rows = Array.isArray(rowsOrRaw) && rowsOrRaw.every((r) => r && typeof r === 'object' && 'qty' in r) ? rowsOrRaw : readStones(rowsOrRaw);
    const gruppen = [];
    for (const r of rows) {
      const label = r.type === 'other' ? (r.name || 'Other') : stoneTypeLabel(r.type);
      let g = gruppen.find((x) => x.label === label);
      if (!g) { g = { label: label, t: null, qty: 0 }; gruppen.push(g); }
      g.qty += r.qty;
      const t = caratThousandths(r.carat);
      if (t !== null && !Number.isNaN(t)) g.t = (g.t === null ? 0 : g.t) + t;
    }
    return gruppen.map((g) => g.label + ' ' + (g.t !== null ? fmtCarat(g.t) + ' ct' : '×' + g.qty)).join(' · ');
  }
  function stonesSectionSummary(rows) {
    if (!rows.length) return 'none';
    return rows.length + (rows.length === 1 ? ' row' : ' rows') + ' · ' + stonesSummary(rows);
  }
  function stonesSearchText(raw) {
    return readStones(raw).map((r) => [r.type === 'other' ? r.name : stoneTypeLabel(r.type), r.color, r.clarity,
      r.shape ? diamondShapeLabel(r.shape) : ''].filter(Boolean).join(' ')).join(' ');
  }
  function stonesFromAi(raw0) {
    let raw = raw0;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return []; } }   // vom Primary als JSON-Text
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw.slice(0, MAX_STONE_ROWS)) {
      if (!r || typeof r !== 'object') continue;
      const roh = text(r.type).toLowerCase();
      if (!roh) continue;
      const typ = STONE_TYPES.find((t) => t.key === roh.replace(/\s+/g, '_') || t.label.toLowerCase() === roh);
      const zeile = typ && typ.key !== 'other' ? { type: typ.key } : { type: 'other', name: text(r.name) || text(r.type) };
      zeile.qty = r.qty;
      if (r.carat !== undefined && r.carat !== null && r.carat !== '') zeile.carat = r.carat;
      if (zeile.type === 'diamond') {
        for (const k of DIAMOND_ONLY) {
          const v = text(r[k]);
          if (!v) continue;
          const list = k === 'color' ? DIAMOND_COLORS : k === 'clarity' ? DIAMOND_CLARITIES : DIAMOND_SHAPES;
          const hit = list.find((o) => o.key.toLowerCase() === v.toLowerCase() || o.label.toLowerCase() === v.toLowerCase());
          if (hit) zeile[k] = hit.key;
        }
      }
      const p = parseStones([zeile]);
      if (!p.issues.length && p.rows[0]) out.push(p.rows[0]);
    }
    return out;
  }

  return {
    STONES_KEY: STONES_KEY, DIAMOND_WEIGHT_KEY: DIAMOND_WEIGHT_KEY, STONE_CATEGORIES: STONE_CATEGORIES,
    STONE_TYPES: STONE_TYPES, DIAMOND_COLORS: DIAMOND_COLORS, DIAMOND_CLARITIES: DIAMOND_CLARITIES, DIAMOND_SHAPES: DIAMOND_SHAPES,
    MAX_STONE_ROWS: MAX_STONE_ROWS,
    stonesApply: stonesApply, stoneTypeLabel: stoneTypeLabel, diamondShapeLabel: diamondShapeLabel,
    caratThousandths: caratThousandths, fmtCarat: fmtCarat, parseStones: parseStones, readStones: readStones,
    diamondCaratThousandths: diamondCaratThousandths, diamondWeightInfo: diamondWeightInfo,
    stoneRowLabel: stoneRowLabel, stonesSummary: stonesSummary, stonesSectionSummary: stonesSectionSummary,
    stonesSearchText: stonesSearchText, stonesFromAi: stonesFromAi,
  };
}));

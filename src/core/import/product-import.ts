// ═══════════════════════════════════════════════════════════
// LATAIF — Safe Product Import logic (X3)
// ═══════════════════════════════════════════════════════════
//
// Reine, injizierbare Import-Logik: robustes Zahlen-Parsing, VAT-Scheme-Auflösung,
// Duplicate-Detection, Zeilen-Klassifikation und Summary/Import-Gate.
// KEIN React / DB / Tauri / xlsx hier → headless testbar via `node test/x3/import-hardening.test.ts`.
//
// Der UI-Layer (ImportPage.tsx) liefert nur die IO (Datei lesen, Kategorien auflösen,
// Backup, createProduct) und rendert das Ergebnis. Alle riskanten Entscheidungen
// (was ist gültig / Duplikat / welche Zahl / welches VAT-Scheme) fallen HIER und sind getestet.

import type { TaxScheme } from '@/core/models/types';

// SSOT-Werte (identisch mit TaxSchemeCanonical in core/models/types) — NICHT neu erfunden.
export const VAT_SCHEMES: readonly TaxScheme[] = ['VAT_10', 'ZERO', 'MARGIN'];

export type ImportRowStatus = 'new' | 'warning' | 'duplicate' | 'invalid';

export interface RawRow { [key: string]: string | number | undefined; }

// ── kleine String-Helfer ──
export function cleanStr(val: string | number | undefined | null): string {
  if (val === undefined || val === null) return '';
  return String(val).trim();
}

// Case-insensitive, whitespace-tolerante Spalten-Suche (erste passende Kopfzeile gewinnt).
export function getCol(row: RawRow, ...names: string[]): string | number | undefined {
  const keys = Object.keys(row);
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, '');
    for (const k of keys) {
      if (k.toLowerCase().replace(/\s+/g, '') === target) return row[k];
    }
  }
  return undefined;
}

function norm(val: unknown): string {
  if (val === undefined || val === null) return '';
  return String(val).toLowerCase().trim();
}

// ─────────────────────────────────────────────────────────────
// 1. Robuster Zahlen-Parser
// ─────────────────────────────────────────────────────────────
// Behandelt: 1234.50 · 1,234.50 (US) · 1.234,50 (EU) · 1234,50 (EU) · "BD 1,234.500".
// Regeln (dokumentiert, deterministisch):
//   - Currency/Buchstaben/Symbole/Spaces werden entfernt (nur 0-9 . , - bleiben).
//   - Sind '.' UND ',' vorhanden: der ZULETZT stehende ist das Dezimaltrennzeichen,
//     der andere ist Tausendertrennung.
//   - Nur Kommas: 1 Komma mit genau 3 Nachkommastellen (z. B. "1,234") ist MEHRDEUTIG
//     → ok=false (Zeile wird ggf. invalid/warning). Sonst: 1 Komma = Dezimal, mehrere = Tausender.
//   - Nur Punkte: 1 Punkt = Dezimal (BHD-freundlich), mehrere = Tausender.
// Leer → ok=true, value=0, empty=true (Aufrufer entscheidet: Cost leer = invalid, Qty leer = 1).
export interface NumberParse { ok: boolean; value: number; empty: boolean; ambiguous: boolean; }

export function parseNumber(raw: string | number | undefined | null): NumberParse {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0, empty: true, ambiguous: false };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, value: 0, empty: false, ambiguous: false };
    return { ok: true, value: raw, empty: false, ambiguous: false };
  }
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: true, value: 0, empty: true, ambiguous: false };

  let s = trimmed.replace(/[^\d.,-]/g, ''); // Currency/Buchstaben/Spaces raus
  let sign = 1;
  if (s.startsWith('-')) sign = -1;
  s = s.replace(/-/g, '');
  if (s === '') return { ok: false, value: 0, empty: false, ambiguous: false };

  const dots = (s.match(/\./g) || []).length;
  const commas = (s.match(/,/g) || []).length;
  let normalized: string;
  let ambiguous = false;

  if (dots > 0 && commas > 0) {
    const decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decimalSep === '.' ? ',' : '.';
    normalized = s.split(thouSep).join('').replace(decimalSep, '.');
  } else if (commas > 0) {
    if (commas === 1) {
      const after = s.split(',')[1] ?? '';
      if (after.length === 3) {
        ambiguous = true;            // "1,234" — Tausender ODER Dezimal? Nicht still raten.
        normalized = s.replace(',', ''); // Best-Guess (Tausender), aber ok=false
      } else {
        normalized = s.replace(',', '.'); // Dezimalkomma
      }
    } else {
      normalized = s.split(',').join(''); // mehrere Kommas = Tausender
    }
  } else if (dots > 0) {
    normalized = dots === 1 ? s : s.split('.').join(''); // 1 Punkt = Dezimal, mehrere = Tausender
  } else {
    normalized = s;
  }

  const val = Number(normalized);
  if (normalized === '' || Number.isNaN(val) || !Number.isFinite(val)) {
    return { ok: false, value: 0, empty: false, ambiguous };
  }
  return { ok: !ambiguous, value: sign * val, empty: false, ambiguous };
}

// ─────────────────────────────────────────────────────────────
// 2. VAT-Scheme-Auflösung (nie still MARGIN)
// ─────────────────────────────────────────────────────────────
// recognized = raw-Wert wurde als valides Scheme erkannt.
// fromDefault = raw war leer → import-weiter Default genutzt.
// scheme = null → nicht auflösbar (raw unbekannt ODER leer ohne Default) → Aufrufer blockiert.
export interface VatParse { scheme: TaxScheme | null; ok: boolean; fromDefault: boolean; recognized: boolean; }

const VAT_ALIASES: Record<string, TaxScheme> = {
  'vat_10': 'VAT_10', 'vat10': 'VAT_10', 'vat 10': 'VAT_10', 'vat': 'VAT_10', 'vat10%': 'VAT_10',
  'standard': 'VAT_10', 'standard rated': 'VAT_10', 'std': 'VAT_10', '10%': 'VAT_10', '10': 'VAT_10',
  'zero': 'ZERO', 'zero rated': 'ZERO', 'zero-rated': 'ZERO', 'exempt': 'ZERO', '0%': 'ZERO', '0': 'ZERO', 'z': 'ZERO',
  'margin': 'MARGIN', 'profit margin': 'MARGIN', 'profit margin scheme': 'MARGIN', 'm': 'MARGIN',
};

export function parseVatScheme(raw: string | number | undefined | null, defaultScheme: TaxScheme | null): VatParse {
  const s = norm(raw).replace(/\s+/g, ' ').trim();
  if (s === '') {
    return defaultScheme
      ? { scheme: defaultScheme, ok: true, fromDefault: true, recognized: false }
      : { scheme: null, ok: false, fromDefault: false, recognized: false };
  }
  const hit = VAT_ALIASES[s];
  if (hit) return { scheme: hit, ok: true, fromDefault: false, recognized: true };
  return { scheme: null, ok: false, fromDefault: false, recognized: false }; // vorhanden, aber unbekannt → nicht still defaulten
}

// ─────────────────────────────────────────────────────────────
// 3. Duplicate-Detection gegen bestehende Produkte (+ intra-file)
// ─────────────────────────────────────────────────────────────
export interface ExistingProductLike { sku?: string | null; brand?: string | null; attributes?: Record<string, unknown> | null; }
export interface ExistingProductIndex { skus: Set<string>; serials: Set<string>; brandRef: Set<string>; }

export function buildExistingIndex(products: ExistingProductLike[]): ExistingProductIndex {
  const skus = new Set<string>();
  const serials = new Set<string>();
  const brandRef = new Set<string>();
  for (const p of products) {
    const sku = norm(p.sku); if (sku) skus.add(sku);
    const serial = norm(p.attributes?.serial_no); if (serial) serials.add(serial);
    const brand = norm(p.brand); const ref = norm(p.attributes?.reference_no);
    if (brand && ref) brandRef.add(brand + '|' + ref);
  }
  return { skus, serials, brandRef };
}

export interface DuplicateCheck { duplicate: boolean; reason?: string; }

export function detectDuplicate(
  c: { sku: string; serialNo: string; brand: string; referenceNo: string },
  index: ExistingProductIndex,
): DuplicateCheck {
  const sku = norm(c.sku);
  if (sku && index.skus.has(sku)) return { duplicate: true, reason: `SKU "${c.sku}" already exists` };
  const serial = norm(c.serialNo);
  if (serial && index.serials.has(serial)) return { duplicate: true, reason: `Serial "${c.serialNo}" already exists` };
  const brand = norm(c.brand); const ref = norm(c.referenceNo);
  if (brand && ref && index.brandRef.has(brand + '|' + ref)) {
    return { duplicate: true, reason: `Brand+Reference "${c.brand} ${c.referenceNo}" already exists` };
  }
  return { duplicate: false };
}

// keeper-Keys in den (kopierten) Index eintragen → fängt datei-INTERNE Duplikate.
function addToIndex(index: ExistingProductIndex, c: { sku: string; serialNo: string; brand: string; referenceNo: string }): void {
  const sku = norm(c.sku); if (sku) index.skus.add(sku);
  const serial = norm(c.serialNo); if (serial) index.serials.add(serial);
  const brand = norm(c.brand); const ref = norm(c.referenceNo);
  if (brand && ref) index.brandRef.add(brand + '|' + ref);
}

function cloneIndex(index: ExistingProductIndex): ExistingProductIndex {
  return { skus: new Set(index.skus), serials: new Set(index.serials), brandRef: new Set(index.brandRef) };
}

// ─────────────────────────────────────────────────────────────
// 4. Zeilen-Klassifikation
// ─────────────────────────────────────────────────────────────
export interface ClassifiedRow {
  index: number;
  status: ImportRowStatus;
  errors: string[];
  warnings: string[];
  sku: string; categoryId: string; categoryName: string; categoryMatched: boolean;
  brand: string; name: string; referenceNo: string; serialNo: string;
  description1: string; description2: string; description3: string;
  size: string; material: string; markup: string;
  weight: number | null; carat: number | null; diamondWeight: number | null;
  purchasePrice: number; plannedSalePrice: number | undefined;
  quantity: number; isSold: boolean;
  taxScheme: TaxScheme | null; vatFromDefault: boolean;
  duplicateReason?: string;
}

export interface ClassifyOptions {
  resolveCategory: (rawName: string, rowIndex: number) => { id: string; name: string; matched: boolean };
  defaultVatScheme: TaxScheme | null;
  existingIndex: ExistingProductIndex;
}

export function isImportable(status: ImportRowStatus): boolean {
  return status === 'new' || status === 'warning';
}

function classifyRow(row: RawRow, idx: number, opts: ClassifyOptions, runningIndex: ExistingProductIndex): ClassifiedRow {
  const errors: string[] = [];
  const warnings: string[] = [];

  const rawCategory = cleanStr(getCol(row, 'Catergorie', 'Category', 'Categorie', 'Type'));
  const cat = opts.resolveCategory(rawCategory, idx);
  const brand = cleanStr(getCol(row, 'Brand'));
  const description1 = cleanStr(getCol(row, 'Description 1'));
  const description2 = cleanStr(getCol(row, 'Description 2'));
  const description3 = cleanStr(getCol(row, 'Description 3'));
  const sku = cleanStr(getCol(row, 'Serial Tag', 'SKU'));
  const referenceNo = cleanStr(getCol(row, 'Model', 'Reference', 'Reference No'));
  const serialNo = cleanStr(getCol(row, 'Serial', 'Serial No'));
  const size = cleanStr(getCol(row, 'Size'));
  const material = cleanStr(getCol(row, 'Metal', 'Material'));
  const markup = cleanStr(getCol(row, 'Markup'));
  const name = description1 || referenceNo || brand || 'Unknown';

  // ── Zahlen ──
  const costP = parseNumber(getCol(row, 'Cost', 'Purchase Price', 'Cost Price'));
  const saleP = parseNumber(getCol(row, 'Tag Price', 'Sale Price', 'Price', 'Selling Price'));
  const qtyP = parseNumber(getCol(row, 'Qty', 'QTY', 'Quantity'));
  const weightP = parseNumber(getCol(row, 'Weight', 'Gross Weight'));
  const caratP = parseNumber(getCol(row, 'Carat', 'Karat'));
  const diaP = parseNumber(getCol(row, 'Diamond Weight', 'Diamond Carat', 'Diamond'));

  // Pflicht: Identität
  if (!brand && !description1 && !referenceNo) errors.push('No brand or name');

  // Pflicht: Cost > 0, sauber geparst
  if (costP.empty) errors.push('No cost');
  else if (!costP.ok) errors.push(costP.ambiguous ? 'Ambiguous cost number' : 'Invalid cost number');
  else if (costP.value <= 0) errors.push('Cost must be > 0');
  const purchasePrice = costP.ok && !costP.empty ? costP.value : 0;

  // Pflicht: Kategorie
  if (!cat.id) errors.push('No category');
  else if (!rawCategory) warnings.push('No category in file → defaulted');
  else if (!cat.matched) warnings.push('Category not matched → defaulted');

  // Qty: leer = 1; unklar/<=0 = invalid
  let quantity = 1;
  if (qtyP.empty) quantity = 1;
  else if (!qtyP.ok) errors.push(qtyP.ambiguous ? 'Ambiguous quantity' : 'Invalid quantity');
  else if (qtyP.value <= 0) errors.push('Quantity must be > 0');
  else quantity = Math.floor(qtyP.value);

  // Sale price: optional; unklar → warnen + ignorieren
  let plannedSalePrice: number | undefined;
  if (!saleP.empty) {
    if (!saleP.ok) warnings.push(saleP.ambiguous ? 'Ambiguous sale price → ignored' : 'Invalid sale price → ignored');
    else if (saleP.value < 0) warnings.push('Negative sale price → ignored');
    else plannedSalePrice = saleP.value;
  }

  // optionale Attribute (Weight/Carat/Diamond): unklar → warnen + leer lassen
  const optNum = (p: NumberParse, label: string): number | null => {
    if (p.empty) return null;
    if (!p.ok) { warnings.push(`${label} unclear → left blank`); return null; }
    if (p.value < 0) { warnings.push(`${label} negative → left blank`); return null; }
    return p.value;
  };
  const weight = optNum(weightP, 'Weight');
  const carat = optNum(caratP, 'Carat');
  const diamondWeight = optNum(diaP, 'Diamond weight');

  // VAT: nie still MARGIN
  const rawVat = cleanStr(getCol(row, 'VAT', 'VAT Scheme', 'Tax', 'Tax Scheme', 'Scheme'));
  const vat = parseVatScheme(rawVat, opts.defaultVatScheme);
  if (!vat.scheme) errors.push(rawVat ? `Unrecognized VAT scheme "${rawVat}"` : 'VAT scheme not set');

  const soldRaw = cleanStr(getCol(row, 'Sold', 'Status')).toLowerCase();
  const isSold = soldRaw === 'sold' || soldRaw === 'yes' || soldRaw === '1' || soldRaw === 'x';

  // ── Status: invalid > duplicate > warning > new ──
  let status: ImportRowStatus;
  let duplicateReason: string | undefined;
  if (errors.length) {
    status = 'invalid';
  } else {
    const dup = detectDuplicate({ sku, serialNo, brand, referenceNo }, runningIndex);
    if (dup.duplicate) { status = 'duplicate'; duplicateReason = dup.reason; }
    else status = warnings.length ? 'warning' : 'new';
  }

  return {
    index: idx, status, errors, warnings,
    sku, categoryId: cat.id, categoryName: cat.name, categoryMatched: cat.matched,
    brand, name, referenceNo, serialNo, description1, description2, description3,
    size, material, markup, weight, carat, diamondWeight,
    purchasePrice, plannedSalePrice, quantity, isSold,
    taxScheme: vat.scheme, vatFromDefault: vat.fromDefault, duplicateReason,
  };
}

// Klassifiziert alle Zeilen; importierbare (new/warning) Keys wandern in einen KOPIERTEN
// Index → datei-interne Duplikate werden als 'duplicate' erkannt (kein Doppel-Insert aus einer Datei).
export function classifyRows(rows: RawRow[], opts: ClassifyOptions): ClassifiedRow[] {
  const running = cloneIndex(opts.existingIndex);
  const out: ClassifiedRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = classifyRow(rows[i], i, opts, running);
    if (isImportable(r.status)) addToIndex(running, { sku: r.sku, serialNo: r.serialNo, brand: r.brand, referenceNo: r.referenceNo });
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 5. Summary + Import-Gate
// ─────────────────────────────────────────────────────────────
export interface ImportSummary {
  total: number; new: number; warning: number; duplicate: number; invalid: number;
  importable: number; estQtyTotal: number; estCostTotal: number;
}

export function summarize(rows: ClassifiedRow[]): ImportSummary {
  const s: ImportSummary = { total: rows.length, new: 0, warning: 0, duplicate: 0, invalid: 0, importable: 0, estQtyTotal: 0, estCostTotal: 0 };
  for (const r of rows) {
    s[r.status]++;
    if (isImportable(r.status)) {
      s.importable++;
      s.estQtyTotal += r.quantity;
      s.estCostTotal += r.purchasePrice * r.quantity;
    }
  }
  return s;
}

export interface ImportGateState { canBackup: boolean; vatSelected: boolean; summary: ImportSummary; }

// Import-Button nur aktiv, wenn: Backup möglich · VAT-Scheme gewählt · >=1 importierbare (new/warning)
// Zeile. invalid/duplicate sind per Konstruktion NICHT im Import-Set.
export function canStartImport(s: ImportGateState): boolean {
  return s.canBackup && s.vatSelected && s.summary.importable >= 1;
}

// Nur die tatsächlich zu importierenden Zeilen (new/warning) — invalid/duplicate werden geblockt.
export function importableRows(rows: ClassifiedRow[]): ClassifiedRow[] {
  return rows.filter((r) => isImportable(r.status));
}

// ─────────────────────────────────────────────────────────────
// 6. Import-Orchestrator (Backup-first, per-Row, NICHT atomar)
// ─────────────────────────────────────────────────────────────
// Injizierbar (backup + create) → headless testbar ohne React/DB/Tauri.
// Vertrag: Backup MUSS zuerst erfolgreich sein; wirft es, wird KEINE Zeile angelegt
// (started=false). Danach wird NUR für importierbare Zeilen create() aufgerufen —
// invalid/duplicate bleiben unangetastet, bestehende Produkte werden nie überschrieben.
export interface RunImportDeps {
  backup: () => Promise<{ location: string }>;
  create: (row: ClassifiedRow) => void;
}
export interface RunImportResult {
  started: boolean; imported: number; failed: number;
  backupLocation: string | null; backupError: string | null;
}

export async function runProductImport(rows: ClassifiedRow[], deps: RunImportDeps): Promise<RunImportResult> {
  let backupLocation: string;
  try {
    const b = await deps.backup();
    backupLocation = b.location;
  } catch (e) {
    return { started: false, imported: 0, failed: 0, backupLocation: null, backupError: (e as Error)?.message || String(e) };
  }
  let imported = 0;
  let failed = 0;
  for (const r of importableRows(rows)) {
    try { deps.create(r); imported++; } catch { failed++; }
  }
  return { started: true, imported, failed, backupLocation, backupError: null };
}

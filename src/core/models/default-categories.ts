// ═══════════════════════════════════════════════════════════
// LATAIF — Default Categories (Plan §Product §3 + §4)
// 6 Kategorien mit je spezifischen Pflicht-/Optional-Feldern.
// ═══════════════════════════════════════════════════════════

import type { Category, CategoryAttribute } from './types';

// Plan §4.1 WATCH
const WATCH_ATTRIBUTES: CategoryAttribute[] = [
  // 2026-05-17: reference_number + serial_number optional — manche Vintage/Custom-Uhren
  // haben keine. Bezel ebenfalls optional.
  { key: 'reference_number', label: 'Reference Number', type: 'text', required: false, showInList: true },
  // 'model' attribute entfernt (2026-05-17) — Duplikat zum Universal-Feld "Name / Model".
  { key: 'case_diameter_mm', label: 'Case Diameter', type: 'number', unit: 'mm', required: true, showInList: true },
  { key: 'serial_number', label: 'Serial Number', type: 'text', required: false, showInList: true },
  { key: 'dial', label: 'Dial', type: 'text', required: true, showInList: false },
  { key: 'bezel', label: 'Bezel', type: 'text', required: false, showInList: false },
  // Diamonds direkt neben Bezel (Row 3 rechts).
  { key: 'diamonds', label: 'Diamonds', type: 'boolean', required: false, showInList: false },
  // 2026-05-17: Material differenziert (14 Optionen incl. Bicolor-Ceramic/Titanium).
  // Karat & Color hängt davon ab und wird nur sichtbar bei Gold-Anteil.
  { key: 'material', label: 'Material', type: 'select',
    options: [
      'Steel',
      'Solid Gold',
      'Two-Tone Steel/Gold',
      'Platinum',
      'Titanium',
      'Ceramic',
      'Bronze',
      'Carbon',
      'DLC Steel',
      'Plated',
      'Ceramic & Steel',
      'Ceramic & Gold',
      'Titanium & Gold',
      'Titanium & Ceramic',
    ],
    required: true, showInList: true },
  { key: 'karat_color', label: 'Karat & Color', type: 'select',
    options: ['18K Yellow', '18K Rose', '18K White', '14K Yellow', '14K Rose', '14K White', '9K Yellow', '9K Rose'],
    required: true, showInList: true,
    dependsOn: {
      key: 'material',
      valueIncludes: ['Solid Gold', 'Two-Tone Steel/Gold', 'Ceramic & Gold', 'Titanium & Gold'],
    },
  },
  // Description an Diamonds' alter Position (Row 6 links).
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
  { key: 'strap_type', label: 'Strap Type', type: 'select',
    options: ['Leather', 'Rubber'], required: false, showInList: false },
  { key: 'movement', label: 'Movement / Caliber', type: 'text', required: false, showInList: false },
  { key: 'year', label: 'Year', type: 'number', required: false, showInList: false },
];

// Plan §4.2 GOLD_DIAMOND_JEWELRY — 2026-05-17: umbenannt + karat/color zu Karat & Color kombiniert.
// 24K/22K/21K nur Yellow (reines Gold); ab 18K alle 4 Farben möglich (Mix = Two-Tone). Silber separat.
// Bar + Coin als item_type für Investitions-Gold/Münzen. Diamond Weight direkt neben Weight.
const GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: true, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch', 'Bar', 'Coin'],
    required: true, showInList: true },
  { key: 'karat', label: 'Karat & Color', type: 'select',
    options: [
      '24K Yellow', '22K Yellow', '21K Yellow',
      '18K Yellow', '18K Rose', '18K White', '18K Mix',
      '14K Yellow', '14K Rose', '14K White', '14K Mix',
      'Silver',
    ],
    required: true, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.3 BRANDED_GOLD_JEWELRY — 2026-05-17: karat + color_type kombiniert.
const BRANDED_GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
    required: true, showInList: true },
  { key: 'size', label: 'Size', type: 'text', required: true, showInList: true },
  { key: 'karat', label: 'Karat & Color', type: 'select',
    options: [
      '24K Yellow', '22K Yellow', '21K Yellow',
      '18K Yellow', '18K Rose', '18K White', '18K Mix',
      '14K Yellow', '14K Rose', '14K White', '14K Mix',
      'Silver',
    ],
    required: true, showInList: true },
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: false, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.4 ORIGINAL_GOLD_JEWELRY — 2026-05-17: karat + color_type kombiniert.
const ORIGINAL_GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
    required: true, showInList: true },
  { key: 'size', label: 'Size', type: 'text', required: false, showInList: true },
  { key: 'karat', label: 'Karat & Color', type: 'select',
    options: [
      '24K Yellow', '22K Yellow', '21K Yellow',
      '18K Yellow', '18K Rose', '18K White', '18K Mix',
      '14K Yellow', '14K Rose', '14K White', '14K Mix',
      'Silver',
    ],
    required: true, showInList: true },
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: false, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  // 'model_name' attribute entfernt (2026-05-17) — Duplikat zum Universal-Feld "Name / Model".
  { key: 'model_number', label: 'Model Number', type: 'text', required: false, showInList: false },
  { key: 'serial_number', label: 'Serial Number', type: 'text', required: false, showInList: false },
  { key: 'year', label: 'Year', type: 'number', required: false, showInList: false },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.5 ACCESSORY — User-Vorgabe: Item Type oben, Color/Material frei.
// Box/Papers werden über das "Included"-Multi-Select abgebildet, daher hier entfernt.
const ACCESSORY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Handbag', 'Eyeglass', 'Wallet', 'Lighter', 'Cufflinks', 'Prayer Beads', 'Walking Stick', 'Pen', 'Key Holder', 'Other'],
    required: true, showInList: true },
  { key: 'color', label: 'Color', type: 'text', required: true, showInList: true },
  { key: 'material', label: 'Material', type: 'text', required: true, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: true, showInList: false },
  { key: 'model_number', label: 'Model No', type: 'text', required: false, showInList: false },
  { key: 'serial_number', label: 'Serial No', type: 'text', required: false, showInList: false },
];

// Plan §4.6 SPARE_PART — 2026-05-17: Box ergänzt; Material differenziert nach Karat+Color
// plus Steel/Gold-Bicolor-Varianten (analog Watch).
const SPARE_PART_ATTRIBUTES: CategoryAttribute[] = [
  // 'model' attribute entfernt (2026-05-17) — Duplikat zum Universal-Feld "Name / Model".
  { key: 'part_type', label: 'Part Type', type: 'select',
    options: ['Dial', 'Bezel', 'Links', 'Crown', 'Strap', 'Buckle', 'Caseback', 'Movement', 'Crystal', 'Box', 'Other'],
    required: true, showInList: true },
  { key: 'material', label: 'Material', type: 'select',
    options: [
      'Steel',
      '18K YG', '18K RG', '18K WG',
      '14K YG', '14K RG', '14K WG',
      'Steel/18K YG', 'Steel/18K RG', 'Steel/18K WG',
      'Steel/14K YG', 'Steel/14K RG', 'Steel/14K WG',
    ],
    required: true, showInList: true },
  { key: 'original_or_copy', label: 'Original or Copy', type: 'select',
    options: ['Original', 'Copy'], required: true, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: true, showInList: false },
];

export const DEFAULT_CATEGORIES: Omit<Category, 'createdAt'>[] = [
  {
    id: 'cat-watch',
    name: 'Watch',
    icon: 'Watch',
    color: '#0F0F10',
    sortOrder: 1,
    active: true,
    conditionOptions: ['Unworn', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Papers', 'Warranty Card', 'Extra Links', 'Pouch'],
    attributes: WATCH_ATTRIBUTES,
  },
  {
    id: 'cat-gold-jewelry',
    name: 'Gold-Diamond Jewellery',
    icon: 'Gem',
    color: '#C6A36D',
    sortOrder: 2,
    active: true,
    conditionOptions: ['Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Certificate', 'Pouch'],
    attributes: GOLD_JEWELRY_ATTRIBUTES,
  },
  {
    id: 'cat-branded-gold-jewelry',
    name: 'Branded Gold Jewelry',
    icon: 'Award',
    color: '#A76ECF',
    sortOrder: 3,
    active: true,
    conditionOptions: ['New', 'Pre-Owned', 'Vintage'],
    scopeOptions: [], // User-Wunsch: kein "Included"-Feld
    attributes: BRANDED_GOLD_JEWELRY_ATTRIBUTES,
  },
  {
    id: 'cat-original-gold-jewelry',
    name: 'Original Gold Jewelry',
    icon: 'Sparkles',
    color: '#CF8A6E',
    sortOrder: 4,
    active: true,
    conditionOptions: ['New', 'Pre-Owned', 'Vintage', 'Antique'],
    scopeOptions: ['Box', 'Certificate'],
    attributes: ORIGINAL_GOLD_JEWELRY_ATTRIBUTES,
  },
  {
    id: 'cat-accessory',
    name: 'Accessory',
    icon: 'ShoppingBag',
    color: '#6E9FCF',
    sortOrder: 5,
    active: true,
    conditionOptions: ['New', 'Pre-Owned'],
    scopeOptions: ['Box', 'Dust Bag', 'Pouch', 'Papers'],
    attributes: ACCESSORY_ATTRIBUTES,
  },
  {
    id: 'cat-spare-part',
    name: 'Spare Part',
    icon: 'Wrench',
    color: '#8B95A5',
    sortOrder: 6,
    active: true,
    conditionOptions: ['New', 'Pre-Owned', 'Refurbished'],
    scopeOptions: ['Packaging'],
    attributes: SPARE_PART_ATTRIBUTES,
  },
];

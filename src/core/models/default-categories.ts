// ═══════════════════════════════════════════════════════════
// LATAIF — Default Categories (Plan §Product §3 + §4)
// 6 Kategorien mit je spezifischen Pflicht-/Optional-Feldern.
// ═══════════════════════════════════════════════════════════

import type { Category, CategoryAttribute } from './types';

// Plan §4.1 WATCH
const WATCH_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'reference_number', label: 'Reference Number', type: 'text', required: true, showInList: true },
  { key: 'model', label: 'Model / Name', type: 'text', required: true, showInList: true },
  { key: 'case_diameter_mm', label: 'Case Diameter', type: 'number', unit: 'mm', required: true, showInList: true },
  { key: 'serial_number', label: 'Serial Number', type: 'text', required: true, showInList: true },
  { key: 'dial', label: 'Dial', type: 'text', required: true, showInList: false },
  { key: 'bezel', label: 'Bezel', type: 'text', required: true, showInList: false },
  { key: 'material', label: 'Material', type: 'select',
    options: ['Steel', 'Gold', 'Rose Gold', 'White Gold', 'Two-Tone', 'Titanium', 'Plated'],
    required: true, showInList: true },
  { key: 'diamonds', label: 'Diamonds', type: 'boolean', required: true, showInList: false },
  { key: 'strap_type', label: 'Strap Type', type: 'select',
    options: ['Leather', 'Rubber'], required: true, showInList: false },
  { key: 'movement', label: 'Movement / Caliber', type: 'text', required: false, showInList: false },
  { key: 'year', label: 'Year', type: 'number', required: false, showInList: false },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.2 GOLD_JEWELRY — Hauptfokus: Weight, Karat, Item Type, Color Type
const GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: true, showInList: true },
  { key: 'karat', label: 'Karat', type: 'select',
    options: ['24K', '22K', '21K', '18K', '14K', '9K'], required: true, showInList: true },
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
    required: true, showInList: true },
  { key: 'color_type', label: 'Color', type: 'select',
    options: ['Yellow Gold', 'Rose Gold', 'White Gold', 'Two-Tone'],
    required: true, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.3 BRANDED_GOLD_JEWELRY — User-Vorgabe: Brand/Model/Size/Karat + Item Type + Color
const BRANDED_GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
    required: true, showInList: true },
  { key: 'color_type', label: 'Color', type: 'select',
    options: ['Yellow Gold', 'Rose Gold', 'White Gold', 'Two-Tone'],
    required: true, showInList: true },
  { key: 'size', label: 'Size', type: 'text', required: true, showInList: true },
  { key: 'karat', label: 'Karat', type: 'select',
    options: ['24K', '22K', '21K', '18K', '14K', '9K'], required: true, showInList: true },
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: false, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  { key: 'model_number', label: 'Model Number', type: 'text', required: false, showInList: false },
  { key: 'serial_number', label: 'Serial Number', type: 'text', required: false, showInList: false },
  { key: 'certificate', label: 'Certificate', type: 'boolean', required: false, showInList: false },
  { key: 'box', label: 'Box', type: 'boolean', required: false, showInList: false },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.4 ORIGINAL_GOLD_JEWELRY — User-Vorgabe: identisch zu Branded
const ORIGINAL_GOLD_JEWELRY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
    required: true, showInList: true },
  { key: 'color_type', label: 'Color', type: 'select',
    options: ['Yellow Gold', 'Rose Gold', 'White Gold', 'Two-Tone'],
    required: true, showInList: true },
  { key: 'size', label: 'Size', type: 'text', required: true, showInList: true },
  { key: 'karat', label: 'Karat', type: 'select',
    options: ['24K', '22K', '21K', '18K', '14K', '9K'], required: true, showInList: true },
  { key: 'weight', label: 'Weight', type: 'number', unit: 'g', required: false, showInList: true },
  { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct', required: false, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: false, showInList: false },
];

// Plan §4.5 ACCESSORY — User-Vorgabe: Item Type oben, Color/Material frei
const ACCESSORY_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'item_type', label: 'Item Type', type: 'select',
    options: ['Handbag', 'Eyeglass', 'Wallet', 'Lighter', 'Cufflinks', 'Prayer Beads', 'Walking Stick', 'Pen', 'Key Holder', 'Other'],
    required: true, showInList: true },
  { key: 'color', label: 'Color', type: 'text', required: true, showInList: true },
  { key: 'material', label: 'Material', type: 'text', required: true, showInList: true },
  { key: 'description', label: 'Description', type: 'text', required: true, showInList: false },
  { key: 'model_number', label: 'Model No', type: 'text', required: false, showInList: false },
  { key: 'serial_number', label: 'Serial No', type: 'text', required: false, showInList: false },
  { key: 'box', label: 'Box', type: 'boolean', required: false, showInList: false },
  { key: 'papers', label: 'Papers', type: 'boolean', required: false, showInList: false },
];

// Plan §4.6 SPARE_PART
const SPARE_PART_ATTRIBUTES: CategoryAttribute[] = [
  { key: 'model', label: 'Model', type: 'text', required: true, showInList: true },
  { key: 'part_type', label: 'Part Type', type: 'select',
    options: ['Dial', 'Bezel', 'Links', 'Crown', 'Strap', 'Buckle', 'Caseback', 'Movement', 'Crystal', 'Other'],
    required: true, showInList: true },
  { key: 'material', label: 'Material', type: 'text', required: true, showInList: true },
  { key: 'karat', label: 'Karat', type: 'select',
    options: ['24K', '22K', '21K', '18K', '14K', '9K'], required: false, showInList: false },
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
    conditionOptions: ['New', 'Unworn', 'Pre-Owned', 'Vintage'],
    scopeOptions: ['Box', 'Papers', 'Warranty Card', 'Extra Links', 'Pouch'],
    attributes: WATCH_ATTRIBUTES,
  },
  {
    id: 'cat-gold-jewelry',
    name: 'Gold Jewelry',
    icon: 'Gem',
    color: '#C6A36D',
    sortOrder: 2,
    active: true,
    conditionOptions: ['New', 'Pre-Owned', 'Vintage'],
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
    scopeOptions: ['Box', 'Certificate', 'Papers', 'Pouch', 'Receipt'],
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
    scopeOptions: ['Box', 'Certificate', 'Appraisal', 'Pouch'],
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

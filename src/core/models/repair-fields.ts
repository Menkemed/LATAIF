// Plan §Repair §Item-Details: kategorie-spezifische Felder für Repair-Item-
// Erfassung. Wird sowohl in RepairList (New Repair) als auch in RepairDetail
// (Edit) benutzt.
//
// v0.7.15 — Voller Collection-Parity (User-Direktive "alle felder"). Vorher
// nur 2-4 Felder pro Kategorie; jetzt das volle Spec-Set der Collection
// (ausser `condition` — das hat einen eigenen Top-Level-Selector im Repair-
// Modal). 'boolean' + `dependsOn` jetzt unterstuetzt, damit Diamonds (Yes/No)
// und Karat-bei-Gold-Bicolor-Watches rendern wie in Collection.
//
// Wichtig: fast alles ist `required: false` weil bei Repair-Intake der
// Kunde nicht alle Specs kennt. Nur Brand (bei Branded-Kategorien) wird
// erzwungen, damit wir das Ticket einer Marke zuordnen koennen.

export type RepairFieldType = 'text' | 'number' | 'select' | 'boolean';

export interface RepairFieldDef {
  key: string;
  label: string;
  type: RepairFieldType;
  options?: string[];
  unit?: string;
  required?: boolean;
  /** Wenn `coreField` gesetzt → speichert in repair.item_brand/itemModel/etc. statt itemAttributes. */
  coreField?: 'itemBrand' | 'itemModel' | 'itemReference' | 'itemSerial';
  /** v0.7.15 — Conditional Visibility analog Collection-Schema. Feld wird
   *  nur gerendert wenn der Wert des `key` einer der `valueIncludes` ist. */
  dependsOn?: {
    key: string;
    valueIncludes: string[];
  };
}

export const REPAIR_FIELDS: Record<string, RepairFieldDef[]> = {
  // ── WATCH ─────────────────────────────────────────────────────────
  'cat-watch': [
    // Identifikation
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'name', label: 'Name / Model', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'reference', label: 'Reference', type: 'text', coreField: 'itemReference' },
    { key: 'serial', label: 'Serial Number', type: 'text', coreField: 'itemSerial' },
    // Specs (alle optional fuer Repair-Intake)
    { key: 'case_diameter_mm', label: 'Case Diameter', type: 'number', unit: 'mm' },
    { key: 'dial', label: 'Dial', type: 'text' },
    { key: 'bezel', label: 'Bezel', type: 'text' },
    { key: 'diamonds', label: 'Diamonds', type: 'boolean' },
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
    },
    { key: 'karat_color', label: 'Karat & Color', type: 'select',
      options: ['18K Yellow', '18K Rose', '18K White', '14K Yellow', '14K Rose', '14K White', '9K Yellow', '9K Rose'],
      dependsOn: {
        key: 'material',
        valueIncludes: ['Solid Gold', 'Two-Tone Steel/Gold', 'Ceramic & Gold', 'Titanium & Gold'],
      },
    },
    { key: 'strap_type', label: 'Strap Type', type: 'select', options: ['Leather', 'Rubber'] },
    { key: 'movement', label: 'Movement / Caliber', type: 'text' },
    { key: 'year', label: 'Year', type: 'number' },
    { key: 'description', label: 'Description', type: 'text' },
  ],

  // ── GOLD / DIAMOND JEWELLERY ─────────────────────────────────────
  'cat-gold-jewelry': [
    { key: 'brand', label: 'Brand', type: 'text', coreField: 'itemBrand' },
    { key: 'name', label: 'Name / Model', type: 'text', coreField: 'itemModel' },
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch', 'Bar', 'Coin'],
      required: true },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
    { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct' },
    { key: 'karat', label: 'Karat & Color', type: 'select',
      options: [
        '24K Yellow', '22K Yellow', '21K Yellow',
        '18K Yellow', '18K Rose', '18K White', '18K Mix',
        '14K Yellow', '14K Rose', '14K White', '14K Mix',
        'Silver',
      ],
    },
    { key: 'description', label: 'Description', type: 'text' },
  ],

  // ── BRANDED GOLD JEWELRY ─────────────────────────────────────────
  'cat-branded-gold-jewelry': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'name', label: 'Name / Model', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
      required: true },
    { key: 'size', label: 'Size', type: 'text' },
    { key: 'karat', label: 'Karat & Color', type: 'select',
      options: [
        '24K Yellow', '22K Yellow', '21K Yellow',
        '18K Yellow', '18K Rose', '18K White', '18K Mix',
        '14K Yellow', '14K Rose', '14K White', '14K Mix',
        'Silver',
      ],
    },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
    { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct' },
    { key: 'description', label: 'Description', type: 'text' },
  ],

  // ── ORIGINAL GOLD JEWELRY ────────────────────────────────────────
  'cat-original-gold-jewelry': [
    { key: 'brand', label: 'Brand', type: 'text', coreField: 'itemBrand' },
    { key: 'name', label: 'Name / Model', type: 'text', coreField: 'itemModel' },
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Bangle', 'Bracelet', 'Necklace', 'Pendant', 'Earrings', 'Brooch'],
      required: true },
    { key: 'size', label: 'Size', type: 'text' },
    { key: 'karat', label: 'Karat & Color', type: 'select',
      options: [
        '24K Yellow', '22K Yellow', '21K Yellow',
        '18K Yellow', '18K Rose', '18K White', '18K Mix',
        '14K Yellow', '14K Rose', '14K White', '14K Mix',
        'Silver',
      ],
    },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
    { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct' },
    { key: 'model_number', label: 'Model Number', type: 'text' },
    { key: 'serial_number', label: 'Serial Number', type: 'text', coreField: 'itemSerial' },
    { key: 'year', label: 'Year', type: 'number' },
    { key: 'description', label: 'Description', type: 'text' },
  ],

  // ── ACCESSORY ────────────────────────────────────────────────────
  'cat-accessory': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'name', label: 'Name / Model', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'item_type', label: 'Item Type', type: 'select',
      options: ['Handbag', 'Eyeglass', 'Wallet', 'Lighter', 'Cufflinks', 'Prayer Beads', 'Walking Stick', 'Pen', 'Key Holder', 'Other'],
    },
    { key: 'color', label: 'Color', type: 'text' },
    { key: 'material', label: 'Material', type: 'text' },
    { key: 'model_number', label: 'Model No', type: 'text' },
    { key: 'serial_number', label: 'Serial No', type: 'text', coreField: 'itemSerial' },
    { key: 'description', label: 'Description', type: 'text' },
  ],

  // ── SPARE PART ───────────────────────────────────────────────────
  'cat-spare-part': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'name', label: 'Part Name', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'reference', label: 'Reference / SKU', type: 'text', coreField: 'itemReference' },
    { key: 'part_type', label: 'Part Type', type: 'select',
      options: ['Dial', 'Bezel', 'Links', 'Crown', 'Strap', 'Buckle', 'Caseback', 'Movement', 'Crystal', 'Box', 'Other'],
    },
    { key: 'material', label: 'Material', type: 'select',
      options: [
        'Steel',
        '18K YG', '18K RG', '18K WG',
        '14K YG', '14K RG', '14K WG',
        'Steel/18K YG', 'Steel/18K RG', 'Steel/18K WG',
        'Steel/14K YG', 'Steel/14K RG', 'Steel/14K WG',
      ],
    },
    { key: 'original_or_copy', label: 'Original or Copy', type: 'select',
      options: ['Original', 'Copy'] },
    { key: 'description', label: 'Description', type: 'text' },
  ],
};

// Plan §Repair §Item-Details: vereinfachte kategorie-spezifische Felder für
// Repair-Item-Erfassung. Bewusst schlanker als Collection-Attributes — wir
// brauchen für eine Reparatur nur die wichtigsten identifizierenden Felder.
// Wird sowohl in RepairList (New Repair) als auch in RepairDetail (Edit) benutzt.

export type RepairFieldType = 'text' | 'number' | 'select';

export interface RepairFieldDef {
  key: string;
  label: string;
  type: RepairFieldType;
  options?: string[];
  unit?: string;
  required?: boolean;
  /** Wenn `coreField` gesetzt → speichert in repair.item_brand/itemModel/etc. statt itemAttributes. */
  coreField?: 'itemBrand' | 'itemModel' | 'itemReference' | 'itemSerial';
}

export const REPAIR_FIELDS: Record<string, RepairFieldDef[]> = {
  'cat-watch': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'model', label: 'Model', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'reference', label: 'Reference', type: 'text', coreField: 'itemReference' },
    { key: 'serial', label: 'Serial Number', type: 'text', coreField: 'itemSerial' },
  ],
  'cat-gold-jewelry': [
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Necklace', 'Bracelet', 'Bangle', 'Brooch', 'Pendant', 'Earrings', 'Other'], required: true },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
    { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct' },
  ],
  'cat-branded-gold-jewelry': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Necklace', 'Bracelet', 'Bangle', 'Brooch', 'Pendant', 'Earrings', 'Other'], required: true },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
  ],
  'cat-original-gold-jewelry': [
    { key: 'item_type', label: 'Type', type: 'select',
      options: ['Ring', 'Necklace', 'Bracelet', 'Bangle', 'Brooch', 'Pendant', 'Earrings', 'Other'], required: true },
    { key: 'weight', label: 'Weight', type: 'number', unit: 'g' },
    { key: 'karat', label: 'Karat', type: 'select',
      options: ['24K', '22K', '21K', '18K', '14K', '9K'] },
    { key: 'diamond_weight', label: 'Diamond Weight', type: 'number', unit: 'ct' },
  ],
  'cat-accessory': [
    { key: 'brand', label: 'Brand', type: 'text', required: true, coreField: 'itemBrand' },
    { key: 'model', label: 'Model / Type', type: 'text', coreField: 'itemModel' },
  ],
  'cat-spare-part': [
    { key: 'name', label: 'Part Name', type: 'text', required: true, coreField: 'itemModel' },
    { key: 'reference', label: 'Reference / SKU', type: 'text', coreField: 'itemReference' },
  ],
};

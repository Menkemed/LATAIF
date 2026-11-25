// PURCHASE ADD VARIANT (Owner 25.11.2026) — eine kleine Textzeile unter dem Artikelnamen einer Einkaufszeile:
// Schmuck „Bracelet · 16 · 18K White · 36.5 g", Uhren „Ref · 40 mm · Steel · 2020". Dieselbe Merkmalzeile wie die
// Collection-Karte (`cardAttributeText`, nur Merkmale mit showInList), dazu das Jahr, wo die Kategorie es kennt.
// Nur aus Daten, die die Maske schon hat — keine Abfrage, keine Datenbankänderung.
import type { Category, Product } from '@/core/models/types';
import { cardAttributeText } from '@/core/utils/product-format';

export function purchaseLineDetailText(product: Partial<Product> | undefined, categories: readonly Category[]): string {
  if (!product) return '';
  const cat = categories.find((c) => c.id === product.categoryId);
  const attrs = (product.attributes ?? {}) as Record<string, unknown>;
  const teile = [cardAttributeText(cat, attrs)].filter(Boolean);
  const jahr = attrs.year;
  const jahrImListeSchon = !!cat?.attributes.some((a) => a.key === 'year' && a.showInList);
  if (!jahrImListeSchon && jahr !== undefined && jahr !== null && String(jahr).trim() !== '' && cat?.attributes.some((a) => a.key === 'year')) {
    teile.push(String(jahr).trim());
  }
  return teile.join(' · ');
}

export function PurchaseLineDetail({ product, categories, dataKey }: {
  product: Partial<Product> | undefined; categories: readonly Category[]; dataKey?: string | number;
}) {
  const t = purchaseLineDetailText(product, categories);
  if (!t) return null;
  return (
    <div data-purchase-line-detail={dataKey ?? ''} style={{ fontSize: 11, color: '#6B7280', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t}>
      {t}
    </div>
  );
}

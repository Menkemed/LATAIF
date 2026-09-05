// CENTRAL-C3B — woher das Rechnungsformular seine Auswahllisten bekommt.
//
// Das Formular braucht zwei Dinge: Kunden und Produkte. Auf dem Primary liegen sie in der eigenen
// Datenbank, auf dem Client gibt es keine — er fragt den Primary. Genau diese eine Frage trennt die
// beiden Betriebsarten, und deshalb steht sie hier als Schnittstelle statt als `if` mitten im
// Formular: wer eine Oberfläche baut, bekommt eine Quelle gereicht und muss nie wissen, welche.
//
// Was hier ABSICHTLICH nicht passiert:
//
//   • Keine Geschäftsrechnung. Preis, Steuer, Marge, Belegnummer — nichts davon entsteht in einer
//     Auswahlliste. Die Quelle liefert Stammdaten zur Anzeige, mehr nicht.
//   • Kein Zugriff auf `getDatabase()`/`initDatabase()` und kein Store-Import in der Client-
//     Implementierung. Diese Datei kennt die lokale Datenschicht nicht einmal dem Namen nach —
//     das ist der Grund, warum der Client gar keine Datenbank anlegen KANN.
//   • Kein Zwischenspeicher. Ist der Server weg, sagt die Oberfläche das; sie zeigt keine alte
//     Liste, die inzwischen falsch sein könnte.
//
// Die Lose wählt der Client nicht aus. `createDirectInvoice` nimmt das älteste offene Los, wenn
// keines genannt ist — dieselbe Regel, die das Formular auf dem Primary vorbelegt. Damit braucht
// der Client weder eine Losliste noch eine neue Leseoperation, und die Kostenbasis bleibt dort,
// wo sie hingehört.

import { remoteRead } from '@/core/bridge/remote-read';

export interface InvoiceFormCustomer {
  id: string;
  label: string;
  phone: string;
}

export interface InvoiceFormProduct {
  id: string;
  label: string;
  sku: string;
  /** Vorschlag für den Preis — der Mensch überschreibt ihn, der Primary rechnet damit. */
  plannedSalePrice: number | null;
  taxScheme: string;
  quantity: number | null;
  stockStatus: string;
}

export interface InvoiceFormSource {
  searchCustomers(q: string): Promise<InvoiceFormCustomer[]>;
  searchProducts(q: string): Promise<InvoiceFormProduct[]>;
}

const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function customerLabel(r: Record<string, unknown>): string {
  const name = [s(r.firstName), s(r.lastName)].filter(Boolean).join(' ').trim();
  const company = s(r.company);
  return company ? (name ? `${name} — ${company}` : company) : (name || s(r.id));
}

export function productLabel(r: Record<string, unknown>): string {
  return [s(r.brand), s(r.name)].filter(Boolean).join(' ').trim() || s(r.id);
}

/** Die Quelle des Clients: dieselben sechs Lesevorgänge, die C2 bereits freigegeben hat. */
export function remoteFormSource(): InvoiceFormSource {
  return {
    async searchCustomers(q) {
      const res = await remoteRead<{ items: Array<Record<string, unknown>> }>('customers.list', q ? { q } : {});
      return (res.items || []).map((r) => ({ id: s(r.id), label: customerLabel(r), phone: s(r.phone) }));
    },
    async searchProducts(q) {
      const res = await remoteRead<{ items: Array<Record<string, unknown>> }>('products.list', q ? { q } : {});
      return (res.items || []).map((r) => ({
        id: s(r.id),
        label: productLabel(r),
        sku: s(r.sku),
        plannedSalePrice: n(r.plannedSalePrice),
        taxScheme: s(r.taxScheme) || 'VAT_10',
        quantity: n(r.quantity),
        stockStatus: s(r.stockStatus),
      }));
    },
  };
}

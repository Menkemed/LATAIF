// ════════════════════════════════════════════════════════════════════════════
// PAYMENT FINAL VERIFICATION — der „gesehene Stand" einer Sammelzahlung (Receive Payment, Pay Supplier — Bulk).
//
// Eine Wiederholung DESSELBEN Versuchs vom PC2 trägt dieselbe Befehlskennung und wird vom durablen Nachweis
// beantwortet, ohne ein zweites Mal zu zahlen (`runRemoteCommand`). Das deckt aber nicht:
//   • den Primary selbst (keine Befehlskennung — zwei Klicks, zwei Aufrufe),
//   • zwei geöffnete Fenster oder zwei Rechner mit derselben Absicht (zwei Kennungen).
// Deshalb schickt jede Sammelzahlung den Fingerabdruck der offenen Posten mit, die ihr Fenster gezeigt hat. Der
// Primary rechnet ihn in SEINER Transaktion neu (die Zahlungen laufen nacheinander, `runExclusive`); hat eine
// andere Zahlung den Stand inzwischen verändert, wird abgewiesen statt ein zweites Mal gezahlt.
// ════════════════════════════════════════════════════════════════════════════
import { payloadHash } from '@/core/bulk/bulk-math';

export const OPEN_STAMP_REQUIRED = 'OPEN_STAMP_REQUIRED';
export const OPEN_ITEMS_CHANGED = 'OPEN_ITEMS_CHANGED';

/** Der Fingerabdruck offener Posten: Art, Kennung und offener Betrag in Fils — unabhängig von der Reihenfolge. */
export function openItemsStamp(items: ReadonlyArray<{ kind: string; id: string; openF: number }>): string {
  return payloadHash(items.map((i) => `${i.kind}:${i.id}:${Math.round(i.openF)}`).sort());
}

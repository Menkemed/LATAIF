// Bestandskennzahlen — die zwei Regeln, die JEDE Oberflaeche gleich beantworten muss.
//
// Bewusst ohne Datenbank-, Sync- oder Store-Import: der Excel-Export der Collection braucht sie
// genauso wie Dashboard, Analytics und Reports, und keiner davon soll dafuer die halbe Datenschicht
// mitladen. `lot-queries` reicht beide weiter, damit bestehende Aufrufer nichts aendern muessen.

// Wie viele Stueck steht in dieser Zeile?
//
// Die Spalte `products.quantity` hat `DEFAULT 1`, aber KEINE Constraint — und zwei autoritative
// Schreibwege setzen bewusst eine Null: der Verkauf einer lot-losen Zeile zaehlt herunter und endet
// bei 0 (`sold`), und der Lot-Abgleich schreibt `COALESCE(SUM(qty_remaining), 0)`. `quantity || 1`
// kann diese echte Null nicht von einer fehlenden Angabe unterscheiden und macht aus "nichts mehr
// da" ein Stueck — bei einer Zeile, deren Status noch `in_stock` sagt, ist das ein Stueck und ein
// Stueckpreis zu viel.
//
// Deshalb ausdruecklich: fehlt die Angabe (Altbestand, unlesbar), gilt weiter der Hausvertrag EINS;
// eine ausdrueckliche Null bleibt eine Null. Negativ kann keiner der Schreibwege erzeugen (der
// Verkauf haelt bei 0, Lot-Summen sind nie negativ) — kaeme es doch vor, zaehlt es als nichts,
// niemals als Abzug vom Bestand anderer Zeilen.
export function pieceCount(q: number | null | undefined): number {
  if (q === null || q === undefined) return 1;
  const n = Number(q);
  if (!Number.isFinite(n)) return 1;
  return n > 0 ? n : 0;
}

// Welche Zeile ist eigenes Bestandsvermoegen? Unveraendert die Regel, die der ProductStore schon
// hatte — hier nur an EINER Stelle, damit Collection, Dashboard, Analytics, Reports und die
// KI-Auswertung nicht fuenf Fassungen davon pflegen. Kommissionsware ist kein eigenes Asset, und
// nur was im Bestand liegt zaehlt.
//
// Ausdruecklich NICHT `canonicalStockStatus`: das ist ein Status-Normalisierer, der `in_stock`,
// `consignment` und `offered` zusammenfasst, weil sie fuer Verkauf und Suche dasselbe bedeuten. Als
// Vermoegensregel benutzt, zaehlt er fremde und angebotene Ware zum eigenen Bestandswert.
export function isOwnStockAsset(p: { stockStatus?: string | null; sourceType?: string | null }): boolean {
  const s = p.stockStatus || '';
  return (s === 'in_stock' || s === 'IN_STOCK') && p.sourceType === 'OWN';
}

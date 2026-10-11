# Offene Funde nach v0.8.80 (dokumentiert, nicht behoben)

Stand: Inventory/Lifecycle-Cleanup nach v0.8.80. Jeder Fund mit reproduzierbarem Umfang und Schweregrad.
Keine Lösung festgelegt, kein Gegenkonto erfunden.

## F1 — Produktion: Input ohne Los überträgt Wert in ein Ausgangs-Los (Bewertung, mittel)

**Vertrag heute** (`src/core/production/production-house.ts`):

- Die Produktion bucht nie ins Hauptbuch, auch nicht mit Los. Der Wert wandert nur zwischen Losen; für eingekaufte Ware ist INVENTORY = Σ Loswert, also ohne Buchung korrekt.
- **Input ohne Los** (Artikel ohne jede Los-Zeile, z. B. manuell erfasst): Kostenbasis = `products.purchase_price` (`inventoryCostBasis` → Rückfall in `lot-cost.ts`). Dieser Wert wird `production_inputs.input_value`, geht in die Wertgleichheit ein und wird Einstand des neuen Ausgangs-Loses.
- **Folge:** Der Artikel ohne Los stand nie in INVENTORY (manuelles Anlegen bucht nichts, eine Eröffnungsbuchung für Bestand gibt es nicht). Das Ausgangs-Los trägt danach Wert, dem kein INVENTORY-Soll gegenübersteht: **INVENTORY < Σ Loswert**. Beim Verkauf des Ausgangs bucht die Rechnung `Soll COGS / Haben INVENTORY` zum Los-Einstand, und INVENTORY kann negativ werden.
- **Kein Sonderfall der Produktion:** Ein Direktverkauf eines Artikels ohne Los entlastet INVENTORY schon heute mit dessen Einkaufspreis (`postInvoiceIssued`, `purchasePriceSnapshot`). Die Produktion verschiebt diese Entlastung nur auf den Verkauf des Ausgangs.
- **Falscher Fix:** INVENTORY beim Verbrauch im Haben zu buchen, würde doppelt entlasten (Produktion und Verkauf).

**Reproduktion:** `test/lot-vat-cost/lot-vat-cost.test.ts` §6. Input mit Los (100) + Input ohne Los (50) → INVENTORY 100, Σ Lose 150.

**Zu entscheiden (Buchhaltung):** a) Bestand ohne Los beim Übergang in ein Los aktivieren (Soll INVENTORY an ein festzulegendes Gegenkonto), b) Ausgangswert ohne den Anteil ohne Los, c) allgemeine Eröffnungsbuchung für Bestand ohne Los. Bis dahin bleibt das Verhalten wie beim Direktverkauf.

## F2 — Produktion löschen ist nicht atomar (Datenintegrität, mittel bis hoch) — BEHOBEN

> Behoben: `deleteProductionInHouse` über `runOnPrimary`. Eine Transaktion, strikte Stornos, exakte Los-Rückgabe mit Prüfung vorher, Ausgang auf Beleg gesperrt, Protokoll. Störungstests stehen in `test/r7a/pp2-pp10-production.test.ts` (F2).

`useProductionStore.deleteRecord` (`src/stores/productionStore.ts`) läuft ohne Transaktion und ohne `runOnPrimary`:

- Die Buchungs-Stornos der verknüpften Ausgaben (`reverseSource('EXPENSE_PAYMENT' | 'EXPENSE')`) laufen in `safePost` und **schlucken Fehler**.
- Danach werden Ausgaben, Ein- und Ausgänge, Ausgangsartikel und deren Lose gelöscht.
- Scheitert ein Schritt mittendrin, bleibt ein halber Stand: Inputs schon zurückgegeben, Ausgänge oder Buchungen noch da, oder umgekehrt.
- Nebenfall: Ein Ausgang, der verkauft und per Retoure (IN_STOCK) wieder `in_stock` ist, passiert die Sperre. Das Löschen entfernt dann Artikel und Lose, auf die Rechnungszeile und COGS-Buchung noch verweisen.

**Reproduktion:** Fehler in `reverseSource` einschleusen (wie `test/r6f`/`pp13`-Muster) und `deleteRecord` aufrufen → Teilzustand. Nächster eigener Slice.

## F3 — FIFO bei Losen vom selben Tag entscheidet die Los-Id (gering)

`deriveProductCostFromLots` und die Auto-Auswahl beim Verkauf sortieren nach `acquired_at, id`. Zwei Einkäufe am selben Tag werden nicht in Einkaufsreihenfolge, sondern nach zufälliger UUID verbraucht.

Hover-Karte und Verkauf nutzen dieselbe Regel und zeigen deshalb denselben Wert. Bei unterschiedlichen Einständen am selben Tag ist aber nicht vorhersagbar, welcher zuerst gebucht wird. Möglicher Tie-Break: `created_at`.

## F4 — „Return to Owner" wirkt wie früher „Keep" auf alle Zeilen (gering bis mittel)

`createReturnInHouse` verlangt für `RETURN_TO_OWNER` nur, dass **eine** Zeile Kommissionsware ist. `applyDisposition` setzt dann **jede** Zeile auf `returned` (Ware verlässt das System), auch eigene Ware auf derselben Rechnung.

Für `KEEP_AS_OWN` ist das im Cleanup geschlossen (jede Zeile muss Kommissionsware sein). Für `RETURN_TO_OWNER` ist es noch offen.

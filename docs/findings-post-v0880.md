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

## F4 — „Return to Owner" wirkt wie früher „Keep" auf alle Zeilen (gering bis mittel) — BEHOBEN

> Behoben: `createReturnInHouse` verlangt für `RETURN_TO_OWNER` jetzt, dass jede Zeile Kommissionsware ist (`RETURN_TO_OWNER_ONLY_FOR_CONSIGNMENT`), geprüft vor dem ersten Schreiben. Maske, PC2 `returns.create` und Kommissionsmaske laufen hier durch. Gemischt: Kommissionszeilen und eigene Ware als getrennte Retouren. Tests: `test/return-cancel-status/return-cancel-status.test.ts` §15, `test/r5f/returns-consignment-parity.test.ts` (beide Wege).

`createReturnInHouse` verlangt für `RETURN_TO_OWNER` nur, dass **eine** Zeile Kommissionsware ist. `applyDisposition` setzt dann **jede** Zeile auf `returned` (Ware verlässt das System), auch eigene Ware auf derselben Rechnung.

Für `KEEP_AS_OWN` ist das im Cleanup geschlossen (jede Zeile muss Kommissionsware sein). Für `RETURN_TO_OWNER` ist es noch offen.

## F5–F7 — Kommissionsware: Doppelverkauf, zwei Rückgabewege, Storno, Sync (hoch) — BEHOBEN

> Behoben im Consignment-Integrity-Bundle. Tests: `test/consignment-integrity/consignment-integrity.test.ts` (Gegenprobe gegen den alten Code: 45 von 52 Prüfungen rot).

- **Zuordnung:** Rechnungszeile → Kommission nur über Rechnung **und** Artikel (`saleConsignmentOfLine`, genau eine, sonst nichts). `consignments.invoice_id` setzt nur „Record Sale" (eigene Rechnung, eine Zeile) und löscht nur „Cancel Sale".
- **F7 Doppelverkauf:** Kommissionsware auf einer gewöhnlichen Rechnung (Anlegen, Ändern als neue Zeile, PC2 `invoices.create`) → `CONSIGNMENT_SELL_VIA_CONSIGNMENT`. Nur „Record Sale" darf sie verkaufen (Erlaubnis nur für seinen Artikel). In der Maske „New Invoice" ist Kommissionsware nicht auswählbar.
- **F6 zwei Rückgabewege:** „Return to Owner" / „Keep" von der Rechnung aus laufen über denselben Kommissionsweg wie „Buyer Returns the Item": gleicher Endzustand, gleiche Buchungen (Wareneinsatz zurück, Einkauf/Verlust beim Einlieferer storniert bzw. Einstand = Auszahlung). Nicht ausdrückbar und deshalb abgewiesen: mehrere Zeilen, Teilmenge, „später erstatten", keine oder mehrdeutige Zuordnung.
- **Storno:**
  - Eine Rückgabe an den Einlieferer wird nur mit „Cancel Sale" umgekehrt; „Cancel Return" → `RETURN_VIA_CANCEL_SALE`.
  - Ohne Snapshot (Altbestand) → `RETURN_RTO_NOT_RESTORABLE`.
  - Eine seither veränderte oder fremde Kommission → `RETURN_RTO_CONSIGNMENT_CHANGED`.
- **Snapshot:** `sales_return_lines.rto_consignment_id`, `rto_prev_status` und `rto_snapshot_at` (Sync-Freigabe aufgenommen).
- **Nur die zugeordnete Kommission:** `applyDisposition` ändert genau die eine Kommission (vorher jede passende Kommission des Artikels).
- **Sync:** Jede Kommissionsänderung durch „Return to Owner" oder „Keep" wird gemeldet.

**Bewusst nicht Teil:**
- Den Status „vor der Rückgabe" (`sold`) stellt kein Storno wieder her. Der einzige Rückweg „Cancel Sale" nimmt den ganzen Verkauf zurück (→ `active`), weil die Rückgabe die Verbindlichkeit beim Einlieferer storniert hat und es dafür keinen Wiederherstellungsvertrag gibt.
- Offen bleibt:
  - Altfälle „Return to Owner" aus der Rechnungsmaske (Kommission `RETURNED_TO_OWNER`) lassen sich weder stornieren noch per „Cancel Sale" aufräumen.
  - Ändern einer Kommissions-Verkaufsrechnung (Preis/Menge der Kommissionszeile) gleicht die Kommission nicht nach.
  - Übergabe von Kommissionsware an einen Agenten.
  - Angebot/Auftrag mit Kommissionsware scheitern erst beim Umwandeln.

**Abschluss (Verkaufsrechnung einer Kommission):**
- Für eine über `consignments.invoice_id` gebundene Rechnung gilt:
  - Artikel, Menge, Preis, Steuerart und Summe der Zeilen ändern, Zeilen hinzufügen/entfernen/ersetzen und den Käufer wechseln → `CONSIGNMENT_INVOICE_LOCKED`.
  - Löschen oder Stornieren (Primary und PC2) → `CONSIGNMENT_INVOICE_LOCKED`.
  - Retoure der Kommissionsware ohne Kommissionsweg („Back to Stock", „Under Repair", „Write Off") → `CONSIGNMENT_RETURN_VIA_CONSIGNMENT`.
- Ebenso gesperrt: das Rechnungsdatum (= Verkaufsdatum; der Einkauf beim Einlieferer trägt es mit) — derselbe Kalendertag bleibt erlaubt.
- Weiter erlaubt: Notiz und Mitarbeiter (Rechnungsregeln) sowie Zahlungen des Käufers.
- Der Weg für alles andere ist „Cancel Sale".
- Tests: `consignment-integrity` §I (Gegenprobe: 12 rot, u. a. Rechnung 1500 ≠ Kommission 1200).

## F8 — Kommissionsware beim Agenten (hoch) — BEHOBEN

> Behoben im Agenten-Schritt. Tests: `test/consignment-integrity/agent-handoff.test.ts` (Gegenprobe gegen den alten Code: 17 von 26 rot).

- `products.source_type` mischt Eigentum (OWN/CONSIGNMENT) und Aufenthaltsort (AGENT). Wem eine Ware gehört, entscheidet jetzt die Kommission (`consignments`), nicht `source_type` allein (`belongsToConsignment`, `ownershipAfterAgent`).
- **Neue Übergabe** von Kommissionsware (offen oder verkauft, auch mit Status „in stock" von Hand) → `CONSIGNMENT_NOT_TRANSFERABLE`. Die Regel steht in `planTransferCreate`, also am Primary und über PC2 `transfers.create`.
- **Altbestand schon beim Agenten:** Verkauf (`markTransferSold`, PC2 `transfers.mark_sold`) und Abrechnung (`markTransferSettled`, PC2 `transfers.mark_settled`) → `CONSIGNMENT_NOT_TRANSFERABLE`, vor jeder Buchung. Es wird nichts automatisch in einen Kommissionsverkauf umgewandelt.
- **Rückwege** (`markTransferReturned`, `deleteTransfer`, `giveBackAgentStock`): Eigentum aus der Kommission.
  - Genau eine offene Kommission → `CONSIGNMENT`/`consignment`.
  - Keine → `OWN`/`in_stock`.
  - Mehrere, oder eine schon verkaufte → `AGENT_RETURN_OWNERSHIP_UNCLEAR`, nichts geschrieben.
  - Löschen einer Übergabe lässt auch bei eigener Ware kein `AGENT` mehr stehen.
- Eigene Ware läuft unverändert `OWN → AGENT → OWN`. Eigentum und Aufenthaltsort grundsätzlich zu trennen ist ein eigenes Design-Thema.

## F9 — Status-Knöpfe der Artikelmaske umgehen den Lebenslauf (hoch, offen)

In „Edit" der Artikelseite (`src/pages/watches/ProductDetail.tsx`, Recht `canEditProducts`) lassen sich `stock_status` (in_stock, reserved, offered, sold, consignment) und die Menge frei setzen — ohne Los, Buchung, Verkauf, Retoure, Kommission oder Agentenvorgang.

- **Folgen:**
  - Ein verkauftes Stück wird wieder „in stock" (bei Artikeln ohne Los samt Menge auch wieder verkaufbar).
  - Ein Stück verschwindet als „sold" ohne Verkauf.
  - Eigene Ware erscheint als „consignment".
  - Bis zu diesem Fix öffnete der Knopf auch Kommissionsware den Weg zum Agenten.
- **Schweregrad hoch:** Er umgeht jede Lebenslauf-Regel für alle Warenarten. Nur gemildert dadurch, dass es eine bewusste Bearbeitung mit Bearbeitungsrecht braucht und die Bestandsprüfungen (Los, Menge) einen Teil der Folgeverkäufe noch abfangen.
- Die Regeln zu Kommissionsware (F7, F8) hängen nicht vom Status ab.
- Vorschlag (eigener Schritt): Status nur aus den Vorgängen ableiten, die Knöpfe entfernen oder auf neutrale Zustände beschränken; Menge nur über Inventur bzw. Einkauf.

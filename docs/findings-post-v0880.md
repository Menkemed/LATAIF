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

## F9 — Status-Knöpfe der Artikelmaske umgehen den Lebenslauf (hoch) — BEHOBEN (Bestandskorrektur als Vertrag offen)

In „Edit" der Artikelseite (`src/pages/watches/ProductDetail.tsx`, Recht `canEditProducts`) lassen sich `stock_status` (in_stock, reserved, offered, sold, consignment) und die Menge frei setzen — ohne Los, Buchung, Verkauf, Retoure, Kommission oder Agentenvorgang.

- **Folgen:**
  - Ein verkauftes Stück wird wieder „in stock" (bei Artikeln ohne Los samt Menge auch wieder verkaufbar).
  - Ein Stück verschwindet als „sold" ohne Verkauf.
  - Eigene Ware erscheint als „consignment".
  - Bis zu diesem Fix öffnete der Knopf auch Kommissionsware den Weg zum Agenten.
- **Schweregrad hoch:** Er umgeht jede Lebenslauf-Regel für alle Warenarten. Nur gemildert dadurch, dass es eine bewusste Bearbeitung mit Bearbeitungsrecht braucht und die Bestandsprüfungen (Los, Menge) einen Teil der Folgeverkäufe noch abfangen.
- Die Regeln zu Kommissionsware (F7, F8) hängen nicht vom Status ab.
- Vorschlag (eigener Schritt): Status nur aus den Vorgängen ableiten, die Knöpfe entfernen oder auf neutrale Zustände beschränken; Menge nur über Inventur bzw. Einkauf.
- **Behoben (F9-Bündel):**
  - Menge, Bestandsstatus und Herkunft weist das Haus bei jeder Artikelbearbeitung ab (`PRODUCT_LIFECYCLE_LOCKED`, `src/core/products/lifecycle-fields.ts`). Das gilt für `editProductTextDurably` und `editProductWithMedia`, also für Primary, PC2 und Handy gleich, vor dem ersten Schreiben.
  - Die drei Spalten stehen nicht mehr in der Bearbeitungs-Spaltenliste.
  - PC2 `products.update` weist `stockStatus`/`sourceType` (wie `quantity`) mit Begründung ab, auch Fantasiewerte.
  - Die Artikelseite zeigt Menge und Status nur an und schickt sie nicht mit.
  - Die echte Menge statt „mindestens 1" beim Laden: Das Speichern einer Notiz machte ein ausverkauftes Stück wieder verkaufbar.
  - Der Agentenschutz beim Verkauf hängt zusätzlich am offenen Agentenvorgang, nicht nur am Status. Das gilt für alle Verkaufswege (Rechnung, Angebot, Auftrag, Reparatur, Rechnungsänderung).
  - Duplikate zusammenführen: Quelle mit Belegen, oder Menge in ein Ziel mit Losen, wird abgewiesen; es zählt die echte Menge. Die Einstellungen nehmen nur die sichtbaren Mitglieder und den sichtbaren Master und fragen vorher nach.
  - Test: `test/f9/product-lifecycle-integrity.test.ts`.
- **Offen:** der Vorgang „Bestandskorrektur" (Vertrag in `docs/stock-correction-contract.md`, mit offenen Fragen zu Gegenkonto, Bewertung, Anfangsbestand, Berechtigung). Menge und Status beim ANLEGEN (Import, Maske, Handy) bleiben wie bisher.

## F10 — Start-Migration rechnete Lose und Mengen bei jedem Start neu (kritisch) — BEHOBEN in v0.8.81 (Primary geprüft, Rechner des Freundes offen)

`runMigrations` (`src/core/db/database.ts`) läuft bei jedem Start einer vorhandenen Datenbank, auch beim Neuladen nach einer Wiederherstellung. Im Block standen 8 historische Datenkorrekturen aus `89cbcf4` (2026-05-17) bzw. dem ersten Commit:

- Herkunft CONSIGNMENT/AGENT;
- Status sold → (consignment_)reserved;
- Einstand der Kommissionsware;
- Losbezug der Rechnungszeilen;
- Losreste aus Rechnungszeilen;
- Menge aus den Losen.

Bei jedem Start rechneten sie über alles hinweg, was seitdem geschah.

- **Folgen (Testdaten, Gegenprobe auf `dae54bd`):**
  - Ein Edelmetall-Los wird EXHAUSTED, danach `BULK_LOT_NOT_ACTIVE`.
  - Agentenverkauf, Produktion und Lieferantenrückgabe: Die Entnahme kommt als Bestand zurück, der Artikel ist wieder verkaufbar.
  - Retoure „Keep": Die Menge zählt doppelt.
  - Die Änderungen entstehen im Speicher und werden mit dem nächsten Speichern dauerhaft.
- **Fix:** `src/core/db/legacy-stock-repair.ts`.
  - Die Korrekturen laufen einmal je Datenbank.
  - Hatte die Datenbank `stock_lots` schon vor dem Start, liefen sie dort bereits: Es wird nur der Merker `migration.legacy_stock_repairs_once_v1` gesetzt.
  - Neue und Alt-Datenbanken (vor den Losen) laufen sie einmal, zusammen mit dem Merker in einem Sicherungspunkt.
  - Edelmetall-Lose sind ausgenommen.
  - Test: `test/startup-migration/startup-migration-integrity.test.ts`.
- **Bereits entstandene Schäden** (nicht automatisch repariert): betroffen sind Datenbanken, die mit v0.8.79/80 oder früher nach solchen Vorgängen neu gestartet wurden. Nur-Lese-Erkennung:
  - Edelmetall-Los `unit = 'mg' AND status = 'EXHAUSTED' AND remaining_weight_mg > 0` ist eindeutig falsch. Die Bewegungen (`bulk_lot_movements`) belegen den Rest.
  - `stock_lots.qty_remaining > qty_total` ist eindeutig falsch (Retoure doppelt gezählt).
  - Ein Los, das ein Agentenvorgang verbraucht hat (`agent_transfers.stock_lot_id`, `stock_taken = 1`, Status sold/settled), steht wieder auf ACTIVE.
  - Ein Los aus `production_inputs.lot_consumption` oder aus einer bestätigten Lieferantenrückgabe hat mehr Rest als Eingang minus aller Entnahmen.
  - Artikel `sold`/`consumed`/`returned` mit aktivem Los (`qty_remaining > 0`).
  - Rechnungszeilen, deren `lot_id` auf ein Los zeigt, das erst nach der Rechnung entstand (Schritt 1 hängte Zeilen ohne Los an das älteste Los).
- **Für eine spätere sichere Wiederherstellung nötig:** alle Entnahmen je Los, nämlich:
  - Rechnungszeilen mit `lot_id`;
  - `agent_transfers.stock_lot_id`/`stock_taken`;
  - `production_inputs.lot_consumption`;
  - Lieferantenrückgaben;
  - `sales_return_lines` samt Ausgang und `keep_lot_id`;
  - `bulk_lot_movements`;
  - dazu ältere Sicherungen als Vergleichsstand.

  Die Migrationen schrieben weder Protokoll noch Changelog. Eine Rekonstruktion allein aus Rechnungszeilen wäre derselbe Fehler noch einmal.
- **Nicht im Umfang, offen:** weitere wiederholte Daten-UPDATEs im Block an Stammdaten (Karat-/Zustands-/Namens-Normalisierung, z. B. Gold-Schmuck „New" → „Pre-Owned"), `expenses.paid_amount` bei PAID. Nicht reproduziert.

### F10 — Stand 13.10.2026

- **v0.8.81 auf dem Primary** (seit 13.10. 18:07). Der Merker `migration.legacy_stock_repairs_once_v1` wurde beim ersten Start gesetzt, ohne Neuberechnung.
- **Primary geprüft, mit Freigabe, nur lesend auf Kopien der Sicherungen:**
  - Geprüft wurden die Sicherungen vom 06.10. (v0.8.78, 209 Artikel), 12.10. (v0.8.80, 326 Artikel) und 13.10. (v0.8.81, 326 Artikel).
  - In keiner gibt es einen Vorgang: 0 Lose (auch Edelmetall), Rechnungen, Einkäufe, Agentenvorgänge, Produktionen, Retouren, Kommissionen, Aufträge, Reparaturen und Buchungen.
  - Alle Artikel stehen auf `in_stock`/`OWN`. Zwischen den Sicherungen hat sich bei keinem Artikel Status, Menge, Herkunft oder Einstand geändert.
  - **Ergebnis: In den drei untersuchten Sicherungen sind keine Schäden nachgewiesen; keine Reparatur nötig.** Ältere Stände (vor dem 06.10.) sind nicht mehr als Sicherung vorhanden.
- **Aufbewahrung der Sicherungen (Belege):**
  - Vor der Sicherung vom 13.10. 18:25 lagen 3 Sicherungen in `E:\LATAIF\Backups` (04.10., 06.10., 12.10.). Danach lagen wieder genau 3 vor (06.10., 12.10., 13.10.). Die vom 04.10. war gelöscht, nicht im Papierkorb.
  - Code: Nach jeder fertigen Sicherung räumt `prune_after_publish` (`src-tauri/src/media/backup.rs`) über `backup_retention::prune` auf. Das greift nur, wenn der Owner die Aufbewahrung eingeschaltet hat (`backup_retention_config.enabled`), und behält die neuesten `keep_count`.
  - Das beobachtete Verhalten passt zu „eingeschaltet, 3 behalten". Die Einstellung selbst wurde nicht gelesen (Steuerdatenbank); sichtbar ist sie unter Einstellungen → Backup & Restore.
  - **Folge:** Jede neue Sicherung löscht die älteste. Was bleiben soll, vorher außerhalb von `E:\LATAIF\Backups` kopieren.
- **Rechner des Freundes** (eigener Primary mit echten Vorgängen, noch v0.8.80; hier sind F10-Schäden möglich):
  1. Mit seiner Zustimmung, und bevor eine neue Sicherung entsteht: die vorhandenen Sicherungen, die bleiben sollen, außerhalb der Aufbewahrungsrotation kopieren.
  2. Eine aktuelle Sicherung über die App erstellen (Owner-Konto dort). Danach eine unveränderte Kopie getrennt aufbewahren.
  3. Erst nach ausdrücklicher Freigabe: eine Kopie dieser Sicherung nur lesend auf F10 prüfen. Prüfpunkte siehe oben (Edelmetall EXHAUSTED mit Restgewicht, `qty_remaining > qty_total`, verbrauchte Lose wieder ACTIVE, Rechnungszeilen auf späteren Losen, Herkunft CONSIGNMENT/AGENT ohne offenen Vorgang).
  4. Das Update auf v0.8.81 gesondert freigeben. Bis dahin den Rechner möglichst nicht neu starten.
  5. Danach gegebenenfalls ein Vorher-/Nachher-Vergleich (Sicherung vor und nach dem Update). Eine Korrektur erfolgt nur als eigener, freigegebener Schritt, nie automatisch.
  - Die ältere Kopie der Datenbank des Freundes in `Downloads` wird nicht geöffnet.

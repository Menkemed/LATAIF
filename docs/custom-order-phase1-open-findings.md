# Custom Order Phase 1 — offene Funde

Stand: Branch `feature/custom-order-k1-k2-k3a` (K1, K2, K3a, Review-Findings, Abschluss, K4, OF3/OF5a-Sperren, K5-Skript).
Wo nicht anders vermerkt, ist ein Punkt nicht umgesetzt und braucht eine eigene Freigabe; wo eine fachliche Entscheidung
fehlt, steht sie unter **Zu entscheiden**. Kein Gegenkonto, keine NBR-Zeile und kein Ablauf ist festgelegt.

> **Release-Blocker OF3 und OF5a — BEHANDELT durch Sperren (nicht durch neue Buchungslogik):**
> - **OF3** — Rechnungsumwandlung (neuer Weg, Altweg, Primary und PC2) und „Cancel Order → Lagerartikel" lehnen ab,
>   solange eine angekommene Kostenzeile nicht im Lager gebucht ist (`CUSTOM_COSTS_NOT_BOOKED`, vor jedem Schreiben;
>   `src/core/orders/order-cost-booking.ts`). Die Maske warnt schon bei der Eingabe. Für ORD-2 (Lohn bei Arup + Goldschuld
>   bei Arup) ist nach K5 alles gebucht — die Rechnung geht und bucht Wareneinsatz 210 gegen Lager 210.
> - **OF5a** — die Retoure einer Rechnungszeile mit getrennt gebuchter Goldschuld-Differenz (`cost_mode = 'SEPARATE'`)
>   wird abgelehnt (`RETURN_GOLD_SETTLED_SEPARATELY`, Primary und PC2). Weg: Begleichung zurücknehmen, dann Retoure;
>   oder die Rechnung stornieren (nimmt die Differenz mit).
>
> Offen bleibt das eigentliche Aktivieren eigener Kosten (G1) und eine Retoure, die die Differenz mitnimmt.

## OF1 — Gesonderter VAT-Korrekturvorgang bei geschlossenen Quartalen (Buchhaltung, mittel)

**Heute:** Eine Einstandsänderung an einem verkauften Stück, dessen Rechnung nicht mehr berichtigt werden darf, wird
gebucht, ohne die Steuer anzufassen. Die mögliche VAT-Wirkung steht nur als **REVIEW** am Vorgang:

- Purchase-Edit D1 (`src/core/purchases/purchase-edit-house.ts`): Korrekturbeleg in `cost_corrections`,
  `vat_status = 'REVIEW'`. Das gilt, wenn das Quartal der Rechnung gemeldet ist, die Rechnung eine Retoure oder
  Änderungsgutschrift hat oder eine andere Steuerart als Margin trägt. Sichtbar in `CostCorrectionsCard` und `PurchaseDetail`.
- K3a Goldschuld in BHD (`src/core/gold/order-gold-settle.ts`): `gold_payable_settlements.cost_mode = 'SEPARATE'`,
  `vat_status = 'REVIEW'` mit `old_vat_amount` / `new_vat_amount` als Schätzung (Margin-Formel). Die Differenz steht im
  Wareneinsatz der offenen Periode (der Rechnungszeile zugeordnet). Sichtbar im Dialog „Settle in BHD".
- Rechnung, VAT-Fingerabdruck und gemeldetes Quartal bleiben unverändert; Periodensperren unverändert
  (`test/custom-order/phase1-review.test.ts` R4, `test/purchase-edit/purchase-edit.test.ts`).

**Lücke:** Die geschätzte Margin-VAT-Differenz wird nie gebucht und erscheint in keinem NBR-Export. Es gibt keine
gemeinsame Liste aller REVIEW-Fälle.

**Vorschlag (nicht umgesetzt):**

1. Eigener Beleg „Margin-VAT-Korrektur" je REVIEW-Fall: Bezug (Rechnung, Zeile, Ursprungsquartal), alte und neue
   Margin-VAT, Differenz, Grund, Quelle (D1-Beleg bzw. Goldschuld-Begleichung).
2. Buchung im **Korrekturquartal** (offen, heute): Soll/Haben `MARGIN_VAT` gegen `REVENUE` (oder ein eigenes
   Anpassungskonto), datiert heute. Das Ursprungsquartal bleibt unberührt.
3. NBR-Export des Korrekturquartals führt den Beleg als Anpassung (eigene Zeile).
4. Freigabe vor dem Buchen, Storno als Gegenbuchung, Protokoll; der REVIEW-Status wechselt auf „gebucht" bzw.
   „verworfen". PC2 über dieselbe Hausfolge.
5. Eine Liste aller offenen REVIEW-Fälle (D1 und Gold) für den Buchhalter.

**Zu entscheiden (Buchhalter/Owner):** Lässt NBR die Korrektur im laufenden Quartal zu, oder ist eine berichtigte
Meldung des alten Quartals nötig? Nur Minderungen oder beide Richtungen? Welche Exportzeile/Box? Gegenkonto (`REVENUE`
oder eigenes Anpassungskonto)? Schwelle für Kleinstbeträge? Wer gibt frei?

## OF2 — Analytics „Operating expenses" zählt unbezahlte, stornierte und aktivierte Ausgaben (Auswertung, mittel)

**Heute** (`src/core/reports/analytics-snapshot.ts:585–597`, Anzeige `src/pages/analytics/AnalyticsPage.tsx:731`):
`SUM(expenses.amount)` je `payment_method` (`cash`/`bank`), ohne Status- und Zahlungsfilter, ohne Zeitraum.

- Stornierte Ausgaben (`status = 'CANCELLED'`) zählen mit.
- Unbezahlte Ausgaben (`PENDING`) zählen mit ihrem vorgesehenen Zahlweg, obwohl kein Geld geflossen ist.
- Aktivierte Kosten (Kategorie `Inventory`) zählen als Betriebsausgabe, obwohl sie Lagerwert sind: Order-Kosten mit
  Lieferant (`src/stores/orderStore.ts:1108`, Zahlweg der Order, sonst `bank`) und Goldschuld-Begleichungen in BHD
  (`src/core/gold/order-gold-settle.ts:162`, `bank`, `PENDING`).
- Teilzahlungen über `expense_payments` bildet die Zeile nicht ab; Zahlungen per `benefit` fehlen.
- Kassen- und Bankstand der Seite kommen aus dem Hauptbuch und stimmen. Falsch ist nur diese eine Zeile.

Älter als Phase 1. K1 und K3a erzeugen aber zusätzliche Ausgaben, die hier falsch mitzählen.

**Vorschlag:** die Zeile aus den tatsächlichen Zahlungen (`expense_payments`, ohne stornierte Ausgaben) bilden und
Kategorie `Inventory` ausschließen. Alternativ direkt aus dem Hauptbuch (Aufwandskonten).

**Zu entscheiden:** Zahlungssicht (Geldabfluss) oder Aufwandssicht (Hauptbuch)? Gehören aktivierte Kosten in
eine eigene Zeile „Inventory purchases"?

## OF3 — Eigene Kosten ohne Lieferant werden nicht aktiviert (Hauptbuch, mittel bis hoch; Paket G1) — GESPERRT (siehe oben)

**Heute:** `commitOrderLineExpenses` (`src/stores/orderStore.ts:1088–1091`) bucht nur Kostenzeilen **mit**
`supplier_id` (Soll `INVENTORY` / Haben A/P bzw. `GOLD_LIABILITY`). Eine Kostenzeile ohne Lieferant (eigene Arbeit,
eigenes Material, eigenes Gold aus dem Laden) bucht nichts. Sie zählt aber im Einstand des Sonderstücks
(`orderCustomCostBasis`). Beim Verkauf entlastet die Rechnung `INVENTORY` mit dem vollen Einstand. `INVENTORY` sinkt
dadurch um die Summe dieser Zeilen unter den Lagerwert (kann negativ werden).

**Gehört zu G1** (Goldbestand im Laden, Konto `GOLD_STOCK`, Abgang zum Ø): Erst wenn eigenes Gold einen Bestand und Wert
hat, kann sein Verbrauch für eine Order gegen `GOLD_STOCK` aktiviert werden. Für eigene Arbeit fehlt eine Regel.

**Zu entscheiden:** Gegenkonto für eigene Arbeit/eigenes Material (Aufwandsumbuchung, z. B. Lohnaufwand →
`INVENTORY`) oder solche Zeilen nicht in den Einstand nehmen.

## OF4 — Weitere Abhängigkeiten von G1–G3 und K3b (nicht vorgezogen)

- **K3b Begleichung mit Gold:** Ladengold oder Saldo beim Goldschmied an eine Order-Goldschuld ist gesperrt; nur
  BHD (K3a) ist möglich. Grund: Ladengold hat heute keinen Bestand und Wert (G1).
- **G2 Gold beim Goldschmied (`they_owe`):** Ein Datensatz „unser Gold beim Goldschmied" wird noch von keinem Ablauf
  angelegt (keine Übergabe, kein Topfwert, kein Konto `GOLD_AT_SUPPLIER`). „Return gold" ist seit dem Review nur für
  diese Richtung freigegeben (`GOLD_CLAIM_RETURN_ONLY`). Es wirkt daher nur bei schon vorhandenen Datensätzen.
- **G3 Reparaturgold:** Werkstattgold an `GOLD_LIABILITY`, Verbrauch eigenen Goldes nach Eigentum: unverändert.
  Reparaturabläufe sind unverändert (Review R7).
- **BHD-Begleichung nur nach Ankunft:** Eine Goldschuld wird erst begleichbar, wenn die Goldzeile angekommen und
  bewertet ist (K1-Buchung vorhanden).

## OF5 — Kleinere Randfälle (gering)

- **OF5a — Retoure nach getrennter Korrektur — GESPERRT (siehe oben); die Retoure MIT Differenz bleibt offen:** Wird ein Stück
  nach einer `SEPARATE`-Begleichung (OF1) per Retoure zurückgenommen, bleibt die Differenz im Wareneinsatz
  (`COGS`), obwohl das Stück zum tatsächlichen Einstand zurück im Lager steht. Gewinn und Lagerwert passen dann nicht
  zusammen. Dieselbe Lücke besteht bei D1-Belegen und Retouren. Der Rechnungsstorno nimmt die Differenz dagegen ins
  Lager zurück (`moveGoldSeparateBackToStock`). **Zu entscheiden:** die Retoure nimmt die Differenz wie der Storno mit
  (Soll `INVENTORY` / Haben `COGS`, im Retourendatum), oder der Fall wird ausdrücklich in Kauf genommen.
- **Rücknahme einer berichtigten Begleichung nach Quartalsmeldung:** Wurde die Rechnung im offenen Quartal berichtigt
  (`cost_mode = 'INVOICE'`) und ist das Quartal inzwischen gemeldet, wird die Rücknahme abgelehnt
  (`SETTLEMENT_INVOICE_PERIOD_CLOSED`). Der Weg ist eine neue Begleichung. Eine `SEPARATE`-Begleichung braucht zum
  Begleichen und zur Rücknahme eine offene Periode heute.
- **Normale Orders ohne Kategorie:** Die SKU-Regel normaler Artikel (Marke + Kategorie) ist unverändert. Eine
  normale Order ohne Kategorie bekommt wie bisher `<Marke>-GEN-nnn`. Die Sperre gegen `ITM-GEN` gilt nur für
  Sonderstücke (Custom Order).
- **Sonderstück in einer anderen Kategorie mit Kürzel:** Uhr, Accessoire usw. ergeben `ITM-WCH-nnn` usw. (Kürzel der
  gewählten Kategorie). Nur Gold-Diamond Jewellery ergibt `ITM-GLD-nnn`. Eine Kategorie **ohne** Kürzel (selbst
  angelegt) wird für ein Sonderstück abgelehnt (`CUSTOM_CATEGORY_NO_SKU_CODE`). Eine an der Order eingetragene,
  manuelle SKU umgeht diese Prüfung nicht (Owner-Regel): Kategorie vorhanden, aktiv und gültig ist immer Pflicht.
- **`src/core/orders/order-invoice-tx.ts`** wird von der App nicht mehr benutzt (nur noch vom b5-Test). Entfernen in
  einem eigenen Aufräumschritt.
- **FINAL-Rechnungen** sind nicht stornierbar (bestehende Regel, unverändert). Wichtig für ORD-2: die Anzahlung (240)
  deckt die Rechnung voll → die Rechnung ist sofort FINAL; eine Korrektur geht danach nur über eine Retoure. Steuerart
  (Zero) und Rechnungsdatum (25.10.) im Dialog vor dem Bestätigen prüfen.

## Owner-Regel „Edit Order After Invoice Conversion" (umgesetzt) — Grenzen

Eine umgewandelte Custom Order bleibt über die Order korrigierbar, solange die Rechnung im offenen Zeitraum berichtigt
werden kann. Das gilt auch, wenn sie FINAL und voll bezahlt ist.
- **Kosten** (Lohn, Gold, Karat, Goldquelle, Goldschuld):
  - Weg: „Add Cost" / Kostenzeile entfernen. Ein Wert in einer bestehenden Kostenzeile wird nicht geändert; Gold mit
    anderen Gramm, anderem Karat oder anderer Werkstatt = alte Goldzeile entfernen und neue hinzufügen.
  - Rechnungszeile (Einstand, bei Margin die Margin-VAT) und Artikel folgen in derselben Klammer
    (`applySoldLineCostCorrection`, wie K3a/D1). Lager bleibt, Wareneinsatz und Lieferantenschuld/Goldschuld folgen.
  - Gesperrt:
    - Quartal der Rechnung oder heute gemeldet/vor dem Stichtag (`ORDER_COSTS_PERIOD_CLOSED`, kein Weg über einen
      getrennten Beleg)
    - Retoure oder Gutschrift an der Rechnung (`INVOICE_HAS_RETURNS`), ein Korrektur-Guthaben
    - eigene Kosten ohne Werkstatt (OF3)
    - eine schon (teil-)beglichene Goldschuld (erst die Begleichung zurücknehmen)
    - eine schon (teil-)bezahlte Lieferantenschuld (`ORDER_COST_PAID`, gilt auch vor der Rechnung, siehe OF6)
- **Kunde:** „Change client" an der Order öffnet die vorhandene Rechnungskorrektur (Grund + Bestätigung).
  - Was umzieht: Order, Rechnung, Anrechnung (PAYMENT) und die Anzahlungen der Order (ORDER_PAYMENT), rückwirkend auf
    ihre eigenen Buchungstage. Geldkonten und unbeteiligte Kunden bleiben unverändert.
  - Gesperrt: mehrere Orders, eine auf mehrere Rechnungen verteilte Order, ein Überzahlungs-Guthaben der Order, eine
    Anzahlung in unüblicher Buchungsform, gemeldetes Quartal (bestehende Regeln).
- **Kundenname:** Stammdaten („Correct client name" → Kunde), mit der bestehenden VAT-Sperre der Stammdaten.
- **Daten:** K4 („Correct dates"), nur Anzeige. Das Rechnungsdatum folgt dem Order-Datum NICHT; es wird bei Bedarf in der
  Rechnungskorrektur geändert.
- **Nicht über die Order:** Verkaufspreis und Steuerart der Rechnung (Rechnungskorrektur), Storno einer FINAL-Rechnung
  (bestehende Regel: Retoure).

## OF6 — Weitere Funde aus dem Abschluss (dokumentiert, zurückgestellt)

- **Bezahlte Kostenzeile entfernen (behoben):** `deleteOrderLine` löschte die Zahlungszeilen einer schon bezahlten
  Lieferantenschuld mit, ließ deren Buchungen aber stehen (älter als diese Phase). Jetzt Nein (`ORDER_COST_PAID`).

- **GOLD SOURCE und Goldhändler (K4):** Preview V4 zeigt unter „Gold vom Lieferanten" auch einen Goldhändler. Es gibt
  kein Merkmal „Goldhändler"; umgesetzt sind nur Werkstätten (aktiv + „Is Workshop", wie Reparaturen). Ein Goldhändler,
  bei dem eine Goldschuld entstehen soll, wird als Werkstatt markiert — oder ein eigenes Merkmal wird beschlossen.
- **Eigene Kosten anlegen:** Order-Anlage und „Add Cost" nehmen eigene Kosten (ohne Werkstatt) weiterhin an und warnen;
  gesperrt sind Rechnung und Storno-ins-Lager. Wer früher sperren will (schon beim Anlegen), braucht eine Freigabe.
- **Artikel eines Sonderstücks direkt verkaufen:** Nach einem Rechnungsstorno könnte das Stück über „New Invoice"
  verkauft werden; diese Rechnung prüft OF3 nicht (Einstand steht am Artikel). Gering, da OF3 schon die erste Rechnung
  sperrt.
- **D1-Belege und Retouren:** dieselbe Lücke wie OF5a für Einkaufskorrekturen (`cost_corrections`), älter als diese
  Phase, nicht gesperrt.
- **Altweg normaler Orders:** Ein sehr alter Auftrag ohne Steuerart legt den Artikel mit dem Einkaufspreis der Order an,
  ohne Lagerbuchung (Verhalten unverändert seit vor v0.1.15). In der Produktion gibt es keinen solchen Auftrag.
- **Kartengebühr umdatieren:** „Edit Expense" storniert die alte Buchung am Tag der Änderung und bucht am neuen Tag
  (bestehende Regel). K5 nutzt genau diesen Weg; das Quartal Q4/2026 ist offen.
- **E2E r5e, Foto eines neuen Artikels (schwankt):** „ORDER-PARITAET der neue Artikel … auch das Foto" war in 2 von 3
  Läufen rot (die Bilddaten des am Primary und des am PC2 angelegten Artikels unterschieden sich), im dritten Lauf grün
  (74/0, wie bei v0.8.97). Phase 1 ändert am Bildweg neuer Artikel nichts; die Ursache ist offen. Die Prüfung meldet
  jetzt die abweichenden Spalten. Kein Bezug zu ORD-2.
- **Zahlweg der Lohn-Verbindlichkeit (behoben):** `commitOrderLineExpenses` übernahm den Zahlweg der Kundenanzahlung
  (`card`) — kein gültiger Ausgaben-Zahlweg. Jetzt cash/bank/benefit, sonst `bank`.

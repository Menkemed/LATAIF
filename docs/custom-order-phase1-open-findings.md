# Custom Order Phase 1 — offene Funde (dokumentiert, nicht umgesetzt)

Stand: Branch `feature/custom-order-k1-k2-k3a` (K1, K2, K3a, Review-Findings, Abschluss).
Keiner dieser Punkte ist umgesetzt. Jeder braucht eine eigene Freigabe; wo eine fachliche Entscheidung fehlt, steht sie
unter **Zu entscheiden**. Kein Gegenkonto, keine NBR-Zeile und kein Ablauf ist festgelegt.

> **⚠ Mögliche Release-Blocker (vor einem Release dieser Phase zu entscheiden):**
> - **OF3** — eigene Kosten ohne Lieferant: `INVENTORY` im Hauptbuch sinkt beim Verkauf eines Sonderstücks unter den
>   Lagerwert (kann negativ werden).
> - **OF5a** — Retoure nach getrennt gebuchter Goldschuld-Differenz: die Differenz bleibt im Wareneinsatz, obwohl das
>   Stück zurück im Lager ist.
>
> Beide betreffen Hauptbuch und Gewinn eines verkauften Sonderstücks, nicht nur die Anzeige. Noch nicht umgesetzt; Owner
> entscheidet, ob sie vor dem Release behoben oder ausdrücklich in Kauf genommen werden.

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

## OF3 — Eigene Kosten ohne Lieferant werden nicht aktiviert (Hauptbuch, mittel bis hoch; Paket G1) — ⚠ MÖGLICHER RELEASE-BLOCKER

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

- **OF5a — Retoure nach getrennter Korrektur — ⚠ MÖGLICHER RELEASE-BLOCKER (Hauptbuch, mittel):** Wird ein Stück
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
- **FINAL-Rechnungen** sind nicht stornierbar (bestehende Regel, unverändert).

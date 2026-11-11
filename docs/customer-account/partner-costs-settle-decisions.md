# Partner-Kosten und Settle Balance — Stand v0.8.101

Stand: 11.11.2026, Abschlussprüfung und Lieferantenrückgabe mit Zusatzkosten. Die Owner-Entscheidungen E1–E3 sind freigegeben. Alles ist lokal committet, nichts gepusht.

## Umgesetzt

| Stufe | Inhalt | Nachweis |
|---|---|---|
| S0 | Einkaufsverrechnung wird nicht mehr als Darlehen angezeigt; Gegenbeleg und Zahlart verständlich; gedruckte Rechnung „Offset“ | b23 S0; E2E b23 E |
| S1 | Kostenbasis netto. Der Partner darf seinen Bruttoanteil zahlen; die vorfinanzierte VAT steht ihm zu. Bei Rückgabe bekommt er seine tatsächliche Zahlung zurück. | partner-vat-basis |
| S2 | Partnergeld nur mit Zahlungsrecht | partner-permissions |
| S3 | Eigene Reparatur an einem verkauften Artikel abgewiesen; bei gemischten Losen ist das Los Pflicht | partner-repair-costs |
| S3/E1 | Partner zahlt die Werkstatt direkt: Soll A/P an Haben PARTNER_ITEM_BALANCE, kein Geldkonto. Teilzahlung und Storno. | partner-direct-payer; E2E b23 I |
| S3/E2 | Werkstattgold in BHD an einem gemeinsamen, unverkauften Los wird aktiviert und geteilt | partner-direct-payer D7 |
| Anspruch | Der Kostenanteil zählt die schon gebuchten Werkstattzeilen einer laufenden Reparatur. Vor „ready“ beträgt der Anspruch 60, nicht 100. Übernahme, Partnerwechsel und Lieferantenrückgabe warten, bis die Reparatur „ready“ ist. | partner-direct-payer F1–F3 |
| S4 | Auszahlbares Partnerguthaben gegen Kundenrechnungen | partner-settle-offset; E2E b23 H |
| S5/E3 | Gebuchte Partnerforderung gegen Store Credit (Variante B, `customer_credit_offsets`), We Borrowed und offene Einkäufe | partner-receivable-offset; E2E b23 J |
| Rückgabe | Lieferantenrückgabe auch mit aktivierten Zusatzkosten (Owner 11.11.), siehe unten | supplier-return-added-costs; E2E b23 K |

## Lieferantenrückgabe mit Zusatzkosten (Owner 11.11.2026)

Je zurückgegebener Zeile:

- **Buchwert:** Menge × Einstand des Loses, inklusive aktivierter Reparatur, Polieren und Werkstattgold.
- **Rücknahmepreis:** höchstens der Einkaufspreis je Stück. Er mindert den Einkauf, also Schuld, Bezahlt und Erstattung, wie bisher; die Vorsteuer wird anteilig zurückgenommen.
- **„Added costs refunded“:** ein eigenes Feld für das, was der Lieferant zusätzlich für die Zusatzkosten erstattet. Höchstens die aktivierten Zusatzkosten der zurückgegebenen Stücke. Ohne VAT, wie die Aktivierung selbst. Es geht auf dasselbe Erstattungskonto wie die Erstattung (Kasse, Bank, Benefit oder Lieferantenguthaben) und berührt die Einkaufssummen nicht.
- **Verlust:** Buchwert − Rücknahmepreis netto − erstattete Zusatzkosten. Gebucht als Soll INVENTORY_LOSS an Haben INVENTORY, dasselbe Konto wie bei Bestandsabschreibungen. Danach steht kein Lagerwert mehr; Hauptbuch INVENTORY = Σ Lose.
  - Beispiel 1000 + 100: Erstattung 1000 → Verlust 100; 1100 → 0; 1050 → 50.
  - Auch die Rücknahmegebühr ohne Zusatzkosten ist jetzt ein Verlust und kein Lagerrest mehr. Bisher blieb der Rest stehen.
  - Rundungsreste bis 0,005 werden wie bisher nicht gebucht.
- **Gemeinsame Artikel:** Der Partner trägt seinen Anteil am Verlust nach Prozent. Die Buchung läuft über die bestehende SUPPLIER_RETURN-Bewegung.
  - Beispiel: 50/50, 550 eingezahlt, Verlust 50 → Anspruch 525.
  - Hat der Partner die Zusatzkosten direkt bezahlt, zählt das als seine Einzahlung. Kein doppelter Anspruch und keine zweite Auszahlung.
- **Abgewiesen, nichts geschrieben:**
  - Rücknahmepreis über dem Einkaufspreis;
  - Erstattung der Zusatzkosten über den aktivierten Zusatzkosten;
  - Gewinn, also Erstattung über dem Buchwert (dafür ist kein Konto festgelegt);
  - Zusatzkosten-Erstattung an einer Zeile ohne Los.
- **Rückgängig:** über „Cancel return“, siehe nächster Abschnitt. Der Storno des ganzen Einkaufs bleibt unverändert; bei aktivierten Kosten ist er gesperrt (`PURCHASE_LOT_COST_CHANGED`).
- **Neue Spalten:** `purchase_returns.added_cost_refund` und `purchase_return_lines.added_cost_refund`, additiv mit Vorgabe 0. Bestehende Rückgaben bleiben unverändert.
- **Auswertungen:** Banking und Kennzahlen zählen die Zusatzkosten-Erstattung als Geldeingang.

## Lieferantenrückgabe stornieren — „Cancel return“ (Owner 11.11.2026)

Eine gebuchte Rückgabe wird einzeln zurückgenommen; der Einkauf bleibt. Der Knopf steht an der Rückgabe im Einkauf und ist nur für den Owner da, am Primary wie am PC2 (`purchases.cancel_return`). Ein Grund ist Pflicht.

- **Rückbuchung:** Es läuft der bestehende Weg des Einkaufs-Stornos (`reverseConfirmedPurchaseReturnInHouse`). Danach stehen alle Konten, Lose, Einkaufssummen und Partneransprüche wie vor der Rückgabe.
  - Die Rückgabebuchung wird mit heutigem Datum storniert: Lagerwert inklusive Zusatzkosten, Verlust, Vorsteuer, A/P und Erstattung. Die ursprüngliche VAT-Korrektur bleibt an ihrem Tag; heute muss das VAT-Quartal offen sein.
  - Die Stücke kommen ins Los zurück, zum Einstand, mit dem sie gingen. Er wird seit diesem Stand je Rückgabezeile festgehalten (`unit_cost_at_return`).
  - Partnerbuchungen der Rückgabe werden gegengebucht; ungenutztes Guthaben der Rückgabe wird entfernt.
- **Geldpfad (nachgewiesen):**
  - Die Rückgabe bucht unter `PURCHASE_RETURN` die Erstattung Soll Kasse, Bank, Benefit oder `SUPPLIER_CREDIT`, dazu Lager, Vorsteuer, A/P, Zusatzkosten und Verlust. Bei Guthaben legt sie eine Zeile in `supplier_credits` an.
  - Banking liest nicht das Hauptbuch, sondern `purchase_returns` und `supplier_credit_refunds`.
  - Der Storno läuft über `reverseConfirmedPurchaseReturnInHouse` → `reverseSource`: Gegenbuchungen mit `reverses_entry_id`, das Original bleibt.
- **Zwei Arten, Pflichtangabe im Dialog „What happened?“:**
  - **A, Erfassungsfehler (`entry_error`):** Die Rückgabe wurde versehentlich erfasst, der Lieferant hat nichts erstattet.
    - Die Gegenbuchung korrigiert auch die falsch gebuchte Erstattung. Im Hauptbuch ist sie gekennzeichnet (`purchaseReturnCancel: ENTRY_ERROR`, `money: entry-error-correction`). Das ist keine Zahlung, es gibt keinen Rückzahlungsvermerk.
    - Banking zeigt weder Eingang noch Rückzahlung, wie bei einer stornierten Zahlung.
    - Ursprüngliche Buchung, Korrektur und Protokoll (`entryErrorCorrected`) bleiben nachvollziehbar.
    - Bestätigt jemand bei A eine Rückzahlung, ist das ein Widerspruch: Nein (`PURCHASE_RETURN_KIND_CONFLICT`).
  - **B, echte Rückgabe rückgängig (`reversed`):** Hat der Lieferant per Kasse, Bank oder Benefit erstattet, geht das Geld an ihn zurück.
    - Das ist eine echte Zahlung und geht nur nachgewiesen: Bestätigung plus Beleg (`repaymentReference`, etwa Überweisungsreferenz oder Quittung). Sonst Nein mit Betrag, Weg und Hinweis auf den Erfassungsfehler (`PURCHASE_RETURN_REFUND_NOT_REPAID`).
    - Vermerk an der Rückgabe: `refund_repaid_amount`, `refund_repaid_reference`, `cancelled_at`. Im Hauptbuch: `REVERSED`, `money: repaid-to-supplier` mit Beleg.
    - Banking zeigt den Eingang weiter und die Rückzahlung als eigenen Ausgang mit Beleg.
    - Eine Rückzahlung wird genau einmal erfasst: Status plus PC2-Auftragskennung.
    - Ohne Geld (Guthaben oder nur Schuld gesenkt) gibt es nichts zurückzuzahlen (`PURCHASE_RETURN_NOTHING_TO_REPAY`).
  - **Lieferantenguthaben:** bei beiden Arten kein Geld. Das ungenutzte Guthaben wird entfernt (bestehender Vertrag der Umkehr); das Protokoll hält die Zeile vollständig fest, die Guthabenbuchung bleibt mit ihrer Gegenbuchung im Hauptbuch.
  - **Datum:** Beide Arten buchen heute, wie „Void payment“. Ein eingereichtes früheres Quartal bleibt unberührt; ist das heutige Quartal eingereicht: Nein.
- **Kontrolliert gesperrt, nichts geschrieben, mit konkretem offenem Ausgleich:**
  - Guthaben schon verrechnet oder vom Lieferanten ausgezahlt (`PURCHASE_RETURN_CREDIT_USED`, nennt Einkauf oder Ausgabe und Betrag);
  - Partnerbuchung nach der Rückgabe, etwa Auszahlung oder Verrechnung (`PURCHASE_RETURN_PARTNER_LATER`, nennt Partner, Art und Betrag);
  - Einstand des Restloses nach der Rückgabe geändert (`PURCHASE_RETURN_COST_CHANGED`, nennt damals und jetzt);
  - ältere Rückgabe ohne festgehaltenen Einstand, deren Los Zusatzkosten trägt (`PURCHASE_RETURN_COST_UNKNOWN`, Buchhalter);
  - Rückgabe aus einer Kommission (`PURCHASE_RETURN_CONSIGNMENT`; das gehört zum Kommissionsweg);
  - heutiges Quartal eingereicht (`VAT_PERIOD_FILED`);
  - Rückgabe schon storniert (`PURCHASE_RETURN_ALREADY_CANCELLED`).
- **Historie:** Die Rückgabe bleibt als CANCELLED stehen, mit Nummer, Zeilen und Beträgen. Das Protokoll trennt die Geldbewegung (`moneyRepaid`) von den Gegenbuchungen (Buchwert, Verlust, Zusatzkosten, Partner) und hält den Einkauf vorher und nachher fest. Danach ist eine neue Rückgabe möglich.
- **Neue Spalten:** `purchase_returns.cancelled_at`, `cancelled_by`, `cancel_reason`, `cancel_kind`, `refund_repaid_amount`, `refund_repaid_reference` und `purchase_return_lines.unit_cost_at_return`. Alle additiv; bestehende Rückgaben bleiben unverändert.

### Zur Entscheidung vorgelegt (nicht umgesetzt)

1. **Gewinn bei der Rückgabe** (Erstattung über dem Buchwert): Dafür gibt es kein Konto. Heute wird die Rückgabe abgewiesen. Nötig wäre zum Beispiel ein Ertragskonto „Gewinn aus Lieferantenrückgabe“.
2. **Guthaben beim Storno als „storniert“ kennzeichnen statt entfernen:** Heute entfernt die bestehende Umkehr die ungenutzte Guthabenzeile; Buchung und Protokoll bleiben. Ein Storno-Status bräuchte Anpassungen an 38 Lesestellen in 18 Dateien.
3. **VAT auf getrennt erstattete Zusatzkosten:** Heute ohne VAT, weil die aktivierten Kosten keine Vorsteuer trugen. Weist ein echter Lieferantenbeleg VAT auf die Erstattung aus, braucht es dafür eine Regel. Die NBR-Regeln sind nicht geändert.

## Noch offen

- **Produktionslohn**
  - Produktion mit einem gemeinsamen Artikel ist gesperrt; die Sperre bleibt.
  - Gemeinsame Produktion ist eine eigene Architekturänderung und ein getrennter Folgepunkt.
- **Werkstattgold, Sonderfälle**
  - Gold aus dem eigenen Bestand hat keinen BHD-Wert am Artikel; dafür fehlt eine Bewertungsregel.
  - Eine BHD-Abrechnung nach dem Verkauf bleibt Betriebsausgabe.
- **Befund, nicht geändert:** Die allgemeine Gold-Abrechnung (`gold-settle`) legt Auftrags-Goldschulden als „Inventory“ an, gebucht wird aber EXPENSES_OPERATING.
- **Einkaufskorrektur gemeinsamer Zeilen:** Sie bleibt gesperrt.

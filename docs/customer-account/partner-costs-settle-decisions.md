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
- **Rückgängig:**
  - Der Storno des Einkaufs nimmt die Rückgabe vollständig zurück: Verlust, Zusatzkosten-Erstattung, Partnerbuchung, Los und Guthaben.
  - Der Storno eines Einkaufs mit aktivierten Kosten bleibt gesperrt (bestehender Schutz `PURCHASE_LOT_COST_CHANGED`).
- **Neue Spalten:** `purchase_returns.added_cost_refund` und `purchase_return_lines.added_cost_refund`, additiv mit Vorgabe 0. Bestehende Rückgaben bleiben unverändert.
- **Auswertungen:** Banking und Kennzahlen zählen die Zusatzkosten-Erstattung als Geldeingang.

### Zur Entscheidung vorgelegt (nicht umgesetzt)

1. **Gewinn bei der Rückgabe** (Erstattung über dem Buchwert): Dafür gibt es kein Konto. Heute wird die Rückgabe abgewiesen. Nötig wäre zum Beispiel ein Ertragskonto „Gewinn aus Lieferantenrückgabe“.
2. **VAT auf getrennt erstattete Zusatzkosten:** Heute ohne VAT, weil die aktivierten Kosten keine Vorsteuer trugen. Weist ein echter Lieferantenbeleg VAT auf die Erstattung aus, braucht es dafür eine Regel. Die NBR-Regeln sind nicht geändert.

## Noch offen

- **Produktionslohn**
  - Produktion mit einem gemeinsamen Artikel ist gesperrt; die Sperre bleibt.
  - Gemeinsame Produktion ist eine eigene Architekturänderung und ein getrennter Folgepunkt.
- **Werkstattgold, Sonderfälle**
  - Gold aus dem eigenen Bestand hat keinen BHD-Wert am Artikel; dafür fehlt eine Bewertungsregel.
  - Eine BHD-Abrechnung nach dem Verkauf bleibt Betriebsausgabe.
- **Befund, nicht geändert:** Die allgemeine Gold-Abrechnung (`gold-settle`) legt Auftrags-Goldschulden als „Inventory“ an, gebucht wird aber EXPENSES_OPERATING.
- **Einkaufskorrektur gemeinsamer Zeilen:** Sie bleibt gesperrt.

# Partner-Kosten und Settle Balance — Stand v0.8.101

Stand 11.11.2026. Die Owner-Entscheidungen E1–E3 sind freigegeben. Alles ist lokal committet, nichts gepusht.

## Umgesetzt

| Stufe | Inhalt | Nachweis |
|---|---|---|
| S0 | Einkaufsverrechnung nicht mehr als Darlehen angezeigt; Gegenbeleg und Zahlart verständlich; gedruckte Rechnung „Offset“ | b23 S0; E2E b23 E |
| S1 | Kostenbasis gemeinsamer Artikel netto. Rückgabe zum Netto-Erstattungswert. **Neu:** Der Partner darf seinen Bruttoanteil zahlen; die vorfinanzierte VAT schuldet LATAIF ihm zurück. Bei einer Rückgabe bekommt er seine tatsächliche Zahlung zurück. | partner-vat-basis (110/100/10, 60/40, 50/50) |
| S2 | Partnergeld nur mit Zahlungsrecht | partner-permissions |
| S3 | Eigene Reparatur an einem verkauften Artikel wird abgewiesen; bei gemischten Losen ist das Los Pflicht; der Reparaturweg ist belegt | partner-repair-costs |
| S3/E1 | Der Partner bezahlt die Werkstatt direkt: Soll A/P (Werkstatt) an Haben PARTNER_ITEM_BALANCE (Partner), kein Geldkonto. Teilzahlung und Storno funktionieren. Auszahlungen warten, bis die Reparatur „ready“ ist. | partner-direct-payer |
| S3/E2 | Werkstattgold in BHD an einem gemeinsamen, unverkauften Los wird aktiviert (Soll INVENTORY an Haben A/P, Los-Einstand) und damit geteilt. Alle anderen Fälle bleiben Betriebsausgabe. | partner-direct-payer D7 |
| S4 | Auszahlbare Partnerguthaben gegen Kundenrechnungen | partner-settle-offset; E2E b23 H |
| S5/E3 | Gebuchte Partnerforderung gegen We Borrowed (Soll LOAN_PAYABLE an Haben PARTNER_ITEM_BALANCE) und gegen offene Einkäufe (Soll A/P an Haben PARTNER_ITEM_BALANCE), in derselben STL-Engine | partner-receivable-offset |

## Noch offen

- **Store Credit gegen eine Partnerforderung**
  - **Warum nicht gebaut:** Store Credit wird heute nur über `credit_applications` verbraucht, und jede Anrechnung zeigt auf eine Rechnungszahlung. Das Gegenpartei-Audit prüft, dass `used_amount` gleich der Summe der Anrechnungen ist. Ein Verbrauch ohne Rechnung braucht deshalb eine neue Verbrauchsart. Einen künstlichen Rechnungsbeleg schließt der Auftrag aus.
  - **Möglichkeit A:** Eine Anrechnungszeile, die auf die Partnerbewegung statt auf eine Rechnungszahlung zeigt, plus eine Erweiterung des Audits.
  - **Möglichkeit B:** Eine eigene Tabelle für Guthaben-Verrechnungen, die das Audit mitzählt.
  - **Buchung in beiden Fällen:** Soll CUSTOMER_CREDIT (Kunde) an Haben PARTNER_ITEM_BALANCE (Partner).
- **Produktionslohn**
  - Produktion mit einem gemeinsamen Artikel ist gesperrt; die Sperre bleibt.
  - Gemeinsame Produktion braucht eine eigene Architektur: Wem gehört das neue Stück, wie gehen die Anteile der Komponenten über? Das ist ein getrennter Folgepunkt.
- **Werkstattgold, Sonderfälle**
  - **Rückgabe von Gold aus dem eigenen Bestand an die Werkstatt:** Dabei entsteht kein BHD-Wert am Artikel, also auch kein Anteil. Dafür braucht es eine Bewertungsregel für Metall aus dem Bestand.
  - **Abrechnung in BHD nach dem Verkauf:** Sie bleibt Betriebsausgabe, weil die Kosten nach dem Verkauf nicht mehr aktiviert werden. Der Partner trägt sie also nicht.
- **Befund, nicht geändert:** Die allgemeine Gold-Abrechnung (`gold-settle`) legt Auftrags-Goldschulden als Kategorie „Inventory“ an. Die Buchung über `postExpense` geht aber auf EXPENSES_OPERATING, weil die Kontenregel nur die Bezüge `repair` und `order` aktiviert. Die eigentliche Auftrags-Goldabrechnung (`order-gold-settle`) bucht INVENTORY mit eigenen Zeilen.
- **Lieferantenrückgabe nach einer Reparatur:** INVENTORY nimmt nur den ursprünglichen Nettowert zurück. Das ist ein Bestandsthema, nicht partner-spezifisch.
- **Einkaufskorrektur gemeinsamer Zeilen:** Sie bleibt gesperrt.
- **Bedienung ohne Zwei-App-Lauf:** „Partner paid directly“ und die Partnerforderung im Settle-Dialog sind auf Code- und Node-Ebene geprüft, aber noch nicht im Zwei-App-E2E.

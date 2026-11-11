# Partner-Kosten und Settle Balance — Stand v0.8.101

Stand: 11.11.2026, Abschlussprüfung. Die Owner-Entscheidungen E1–E3 sind freigegeben. Alles ist lokal committet, nichts gepusht.

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
| Rückgabe | Ein Stück mit nachträglich aktivierten Kosten (Reparatur, Werkstattgold) kann nicht an den Lieferanten zurückgegeben werden. So bleibt kein stiller Lagerrest. | supplier-return-repair |

## Noch offen

- **Lieferantenrückgabe eines reparierten Stücks**
  - Heute gesperrt.
  - Eine Rückabwicklung bräuchte eine Verlustbuchung für die aktivierten Kosten: Soll Aufwand/COGS an Haben INVENTORY. Das ist eine neue Regel und braucht deine Entscheidung.
- **Lieferantenrückgabe unter Einstand**
  - Beispiel: Rücknahmegebühr; der Lieferant erstattet weniger als den Einkaufspreis.
  - Das Lager wird nur um den Rückgabewert netto entlastet, der Rest bleibt im Lagerwert. Das gilt schon vor v0.8.101 und ist nicht partner-spezifisch.
  - Eine Sperre würde legitime Teilerstattungen verhindern. Nötig ist auch hier eine Verlustbuchung.
- **Produktionslohn**
  - Produktion mit einem gemeinsamen Artikel ist gesperrt; die Sperre bleibt.
  - Gemeinsame Produktion ist eine eigene Architekturänderung und ein getrennter Folgepunkt.
- **Werkstattgold, Sonderfälle**
  - Gold aus dem eigenen Bestand hat keinen BHD-Wert am Artikel; dafür fehlt eine Bewertungsregel.
  - Eine BHD-Abrechnung nach dem Verkauf bleibt Betriebsausgabe.
- **Befund, nicht geändert:** Die allgemeine Gold-Abrechnung (`gold-settle`) legt Auftrags-Goldschulden als „Inventory“ an, gebucht wird aber EXPENSES_OPERATING.
- **Einkaufskorrektur gemeinsamer Zeilen:** Sie bleibt gesperrt.

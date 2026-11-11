# Partner-Kosten und Settle Balance — Stand v0.8.101 und offene Entscheidungen

Stand: 11.11.2026. Grundlage ist der Owner-Auftrag „Kostenverteilung und Settle Balance“ (S0–S5).

## Umgesetzt

Die Stufen sind lokal committet, aber nicht gepusht.

| Stufe | Inhalt | Nachweis |
|---|---|---|
| S0 | Einkaufsverrechnung wird nicht mehr als Darlehen angezeigt. Gegenbeleg und Zahlart im Kontoauszug sind verständlich beschriftet. Die gedruckte Rechnung zeigt „Offset“. | b23 S0-1…5; E2E b23 Schritt E |
| S1 | Gemeinsamer Einkauf: Kostenbasis netto, also Brutto minus abziehbare Vorsteuer, gleich Los und INVENTORY. Die Lieferantenrückgabe rechnet mit dem Netto-Erstattungswert. Gespeicherter Altbestand bleibt unverändert. | partner-vat-basis |
| S2 | Partnergeld (Beitrag, Auszahlung, Storno, Gesellschafterbuchung) nur mit Zahlungsrecht, am Primary und auf PC2 gleich. | partner-permissions |
| S3 | Der echte Reparaturweg ist belegt. Eine eigene Reparatur an einem verkauften Artikel wird abgewiesen. Bei gemischten Losen ist das Los Pflicht. | partner-repair-costs |
| S4 | Auszahlbare Partnerguthaben werden in Settle Balance gegen Rechnungen desselben Menschen verrechnet. | partner-settle-offset; E2E b23 Schritt H |

## Entscheidung E1: Partner bezahlt eine Kostenstelle direkt

Das betrifft Werkstatt oder Lieferant. Heute ist ein Partner als Zahler nicht abbildbar. Eine Werkstattzeile bucht Soll INVENTORY an Haben A/P (Werkstatt). Bezahlen kann sie nur LATAIF, mit Bar, Bank oder Benefit.

**Vorschlag.** Die Ausgabe (oder der Einkauf) bekommt den Zahlweg „Paid by partner“, nur wenn die Kosten an einem gemeinsamen Artikel dieses Partners entstehen.

- **Buchung:** Soll ACCOUNTS_PAYABLE (Gegenpartei Werkstatt bzw. Lieferant) an Haben PARTNER_ITEM_BALANCE (Gegenpartei Partner). Kein Geldkonto.
- **Am Partnerartikel:** ein Beitrag, Methode `direct`, mit Verweis auf die Zahlung. Er bucht nicht selbst. Die Obergrenze ist der offene Betrag der Ausgabe, nicht der Kostenanteil.
- **Wirkung im Beispiel:** Reparatur 100, Partner 40 %, der Partner zahlt 100. Dann sinkt die Werkstattschuld um 100, das Partnerkonto steigt um 100, der Kostenanteil beträgt 40, und offen ist +60 zugunsten des Partners (auszahlbar oder verrechenbar). Zahlt LATAIF, schuldet der Partner 40. Bei einer Teilzahlung wird entsprechend aufgeteilt.
- **Aufwand:** Die Zahlart muss an rund 20 Lesestellen der Ausgabenzahlungen eingetragen werden: Banking, Abgleich, Nachbuchung, Kontoauszug, Storno.

**Zu bestätigen:** Buchung und Zahlweg. Soll dasselbe auch für den Einkaufspreis selbst gelten, wenn der Partner den Lieferanten direkt bezahlt?

## Entscheidung E2: Werkstattgold und Produktionslohn

- **Werkstattgold:** Die Abrechnung in BHD wird heute als `RepairCosts` gebucht. Das ist eine Betriebsausgabe; sie wird nicht aktiviert und deshalb nie geteilt. Die Rückgabe von Gold aus dem eigenen Bestand hat keinen BHD-Wert im Artikel. Für die Verteilung müsste Werkstattgold bei eigener Ware aktiviert werden: Soll INVENTORY statt Aufwand, und für die Rückgabe aus dem Bestand eine Bewertung des Metalls. Das ist eine neue Buchungsregel für alle eigenen Reparaturen, nicht nur für Partnerartikel.
- **Produktionslohn:** Produktion mit einem gemeinsamen Artikel ist gesperrt. Ein Produktionslohn kann deshalb heute nicht an einem Partnerartikel entstehen. Die Sperre bleibt, bis die Regel für Produktion mit Partnern feststeht.

**Zu entscheiden:**
- Soll Werkstattgold bei eigener Ware aktiviert werden, und mit welchem Wert für Gold aus dem Bestand?
- Soll Produktion mit Partnerartikeln erlaubt werden?

## Entscheidung E3: S5, Partner schuldet LATAIF

**Was im Hauptbuch steht.** Nur eine Rückforderung, also ein Soll-Saldo auf PARTNER_ITEM_BALANCE beim Partner: nach einem Verlust, einer Nachabrechnung oder einer zu hohen Auszahlung. Der offene Kostenanteil ist nur berechnet und steht nicht im Hauptbuch. Er darf nach Owner-Vorgabe nicht verrechnet werden.

**Vorschlag für den Weg (nur Rückforderung):**

| Gegenposten | Buchung | Vorhandener Weg |
|---|---|---|
| Store Credit | Soll CUSTOMER_CREDIT (Kunde) an Haben PARTNER_ITEM_BALANCE (Partner) | Store Credit wird heute nur gegen eine Rechnung verbraucht, weil `credit_applications.payment_id` Pflicht ist. Ein neuer Verbrauchsweg ist nötig. |
| We Borrowed | Soll LOAN_PAYABLE (Kunde) an Haben PARTNER_ITEM_BALANCE (Partner) | Rückzahlungszeile am Darlehen wie bei B1. |
| Offener Einkauf | Soll ACCOUNTS_PAYABLE (Lieferant) an Haben PARTNER_ITEM_BALANCE (Partner) | Zeile `offset` am Einkauf wie bei B2/B3. |

Am Partnerartikel entsteht dazu ein Beitrag, Methode `offset`, ohne eigene Buchung.

Für die Tabelle gilt: `party_offsets` mit `receivable_type = 'PARTNER_ITEM'`. Die Spalte hat keine CHECK-Sperre, ein Umbau ist also nicht nötig.

In der Engine braucht es eine zweite Forderungsart neben INVOICE: Auswahl, FIFO, Stand-Abdruck, Rückgängig je Zeile und je STL.

**Zu entscheiden:**
- Nur die Rückforderung, oder soll auch ein offener Kostenanteil verrechenbar werden? Letzteres hieße, ihn zuerst als Forderung zu buchen; das wäre eine neue Regel, zum Beispiel Soll PARTNER_ITEM_BALANCE an Haben INVENTORY für den Partneranteil, und sie änderte den Wareneinsatz.
- Welche der drei Gegenposten sollen zugelassen werden?

## Weitere offene Punkte

- **Einkaufskorrektur gemeinsamer Zeilen:** Sie bleibt gesperrt. Die Netto-Basis steht jetzt fest. Was eine Korrektur nach geleisteten Beiträgen oder Abrechnungen bewirkt, braucht eine eigene Regel.
- **Reparatur zwischen „in Arbeit“ und „ready“:** Den Partneranteil an Reparaturkosten sieht der Partner erst ab „ready“. Gebucht ist der Betrag ab „in Arbeit“ in INVENTORY.
- **Mehrere Stücke in einem Los:** Die Reparatur verteilt sich auf alle Stücke, die im Lager liegen. Die Summe des Partneranteils stimmt; je Stück wird gemittelt.
- **Lieferantenrückgabe nach einer Reparatur:** INVENTORY nimmt nur den ursprünglichen Nettowert zurück. Die Reparaturkosten am zurückgegebenen Stück bleiben in INVENTORY. Das ist ein Bestandsthema, nicht partner-spezifisch.

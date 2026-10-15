# Opening Balances & Settlement — Vertrag (Stand 15.10.2026, lokal, nicht released)

## Geschäftsentscheidung (Owner)

- LATAIF führt ab **15.10.2026** die laufende Buchhaltung einschließlich VAT.
- Alte Rechnungen, Einkäufe und Zahlungen werden **nicht** einzeln nachgetragen. Übernommen werden nur die tatsächlich vorhandenen Salden:
  - Altbestand;
  - Kasse, Bank und Benefit;
  - Forderungen an Kunden und Verbindlichkeiten an Lieferanten;
  - Anzahlungen von Kunden und Vorauszahlungen an Lieferanten;
  - gegebenenfalls weitere Vermögenswerte, Schulden und VAT-Salden.
- Die Eröffnung ist keine Neugründung der Firma. Es entstehen keine fiktiven Umsätze, Einkäufe oder Zahlungen.

## Was es vorher gab (Audit, Code-Stand e991c59)

| Bereich | Vorhanden | Folge |
|---|---|---|
| Anfangsbestand Kasse/Bank/Benefit | Einstellungen `finance.opening_*`, gebucht von `postOpeningBalances` gegen `OPENING_BALANCE_EQUITY` am **01.01.2000**; jede Änderung storniert und bucht neu | Bleibt **unverändert**. Datum und Verfahren werden nicht eigenmächtig auf den 15.10.2026 umgestellt (siehe E2). |
| Darlehen (Debts) | Buchen immer Geld (Kasse/Bank) und tragen keine Gegenpartei im Hauptbuch | Ungeeignet für alte Salden |
| Rechnungs- und Einkaufszahlungen | `payments.invoice_id` und `purchase_payments.purchase_id` sind Pflicht | Ein Eröffnungsposten braucht später eigene Zahlungszeilen |
| Kundensaldo | Hauptbuch (`customerBalance`) | wiederverwendet |
| Lieferantensaldo | Belege (`supplierLedgerFor`) | wiederverwendet |
| Kundenguthaben | `customer_credits` + `CUSTOMER_CREDIT`, einlösbar über `invoices.apply_credit` | Weg für spätere Eröffnungs-Anzahlungen |
| Lieferantenguthaben | `supplier_credits` + `SUPPLIER_CREDIT`, einlösbar über `suppliers.apply_credit` / `purchases.apply_credit` | ohne Quellenkennzeichen; das freie Guthaben bucht immer Geld |
| Kunden-Sammelzahlung | fehlte; nur Zahlung je Rechnung | neu: `customers.settle` |
| Lieferanten-Sammelzahlung | `suppliers.pay` (FIFO/manuell, eine Transaktion) | ein Überschuss wurde still zu Guthaben → jetzt nur mit ausdrücklicher Wahl |

## S0 — Salden am PC2 (behoben)

- **Fehler:** Kundendetail, Kundenliste, Lieferantendetail und das Guthaben auf der Rechnungsseite rechneten lokal. Der PC2 hat keine Datenbank; der Fehler wurde abgefangen und die Fläche zeigte **0,000**.
- **Lösung:** eine Auskunft `parties.balances.get`.
  - Eine Rechnung für beide Rechner: `customerStatsFor`, `customerStoreCreditFor`, `supplierLedgerStrict`.
  - Der Primary rechnet lokal, der PC2 fragt den Primary, an die Filiale des Absenders gebunden.
  - Ohne Antwort zeigt die Fläche „n/a", nie 0.
  - Eine Kennung einer anderen Filiale fehlt in der Antwort.

## S1 — Eröffnungsposten (Beleg ja, Buchung nein)

- **Ort:** Edit Client bzw. Supplier Edit → Bereich „Opening balances".
  - Der Bereich hat eine eigene Bestätigung und ist nur für den Owner sichtbar.
  - In der normalen Ansicht steht eine Zusammenfassung zum Lesen.
- **Tabelle `opening_balance_items`** (Nummern `OB-…`, synchronisiert mit insert und update, gelöscht wird nie):
  - Arten:
    - `CUSTOMER_RECEIVABLE` — Kunde schuldet uns;
    - `CUSTOMER_ADVANCE` — Kunde hat vorausbezahlt;
    - `SUPPLIER_PAYABLE` — wir schulden dem Lieferanten;
    - `SUPPLIER_ADVANCE` — wir haben vorausbezahlt.
  - Umfang: `DOCUMENT` (eine alte Rechnung mit Referenz) oder `REMAINDER` (zusammengefasster Restbetrag).
  - Weitere Felder: Rechnungsdatum (vor dem Stichtag), Fälligkeit, Betrag in Fils, frühere VAT-Behandlung (`DECLARED_BEFORE` / `OUTSIDE_VAT` / `UNKNOWN`, nur festgehalten), Notiz.
  - Stichtag ist immer 2026-10-15. `accounting` steht immer auf `PENDING`.
- **Schutz gegen doppelte Übernahme:**
  - Pflichtbestätigung „steht nicht schon in LATAIF".
  - Der Bereich zeigt die offenen LATAIF-Belege der Partei.
  - Eine Referenz, die eine LATAIF-Belegnummer ist, wird abgewiesen (`REFERENCE_IS_LATAIF_DOCUMENT`).
  - Dieselbe Referenz wird nicht zweimal angenommen (Teilindex).
  - Je Partei und Art gibt es höchstens einen Restbetrag (Teilindex).
  - Einzelposten und Restbetrag nebeneinander verlangen die Bestätigung „überschneiden sich nicht".
- **Wiederholschutz:** Aktionskennung plus Fingerabdruck. Eine Wiederholung liefert denselben Beleg; eine andere Absicht unter derselben Kennung wird abgewiesen (`ACTION_ID_CONFLICT`).
- **Storno:** nur der Owner, nur mit Grund und nur, solange der Posten nicht gebucht ist. Die Zeile bleibt mit Grund und Protokoll erhalten.
- **Kontaktdaten speichern** bucht nie und verändert nie einen Posten:
  - Die Feldlisten sind streng.
  - Eine begonnene, noch nicht erfasste Eingabe hält „Save" mit einer Rückfrage an.
- **Löschschutz:** Ein Kunde oder Lieferant mit Eröffnungsposten lässt sich nicht löschen.
- **PC2:** `opening_balances.create` und `.cancel` stehen nur dem Owner zu. Die Hausfolge läuft am Primary und prüft den Owner dort noch einmal.
- **Abstimmungsliste `/opening-balances`** (nur lesen):
  - alle Posten je Art und Partei;
  - Anzahl der Stornos;
  - der unveränderte Anfangsbestand von Kasse/Bank/Benefit aus den Einstellungen und dem Hauptbuch.

## S2 — Zahlungen

- **Kunde, „Receive Payment" (`customers.settle`, Recht wie „Record Payment"):**
  - Automatisch: älteste Rechnung zuerst. Manuell: je Rechnung höchstens ihr Offenes, die Summe muss dem Betrag entsprechen.
  - Jede Teilzahlung ist eine gewöhnliche Rechnungszahlung (`recordInvoicePaymentInHouse`), alle in einer Transaktion. Dazu gehören Status, Endnummer, Kartengebühr, VAT-Periodenschutz und die Buchung „Soll Kasse/Bank / Haben Forderung".
  - Kein Umsatz und keine VAT entstehen neu.
  - „Offen" ist dieselbe Zahl wie in Receivables und im Hauptbuch: Brutto − gezahlt − Forderungsstorno der Gutschriften.
  - Ein Betrag über allem Offenen wird ohne Wahl abgewiesen (`PAYMENT_EXCEEDS_OPEN`). Mit `confirmExcessAsCredit` wird der Rest Store-Guthaben nach der bestehenden Überzahlungsregel; Träger ist die jüngste zugeordnete Rechnung ohne Gutschrift.
- **Lieferant, „Pay Supplier — Bulk" (`suppliers.pay`):** FIFO und manuelle Verteilung bleiben wie bisher. Ein Überschuss wird nur noch mit `confirmExcessAsCredit` Guthaben, sonst abgewiesen (`PAYMENT_EXCEEDS_OPEN`).
- **Eröffnungsposten** sind in beiden Masken sichtbar, aber **nicht bezahlbar**, solange ihre Buchung gesperrt ist.

## Gesperrt (fail-closed) — wartet auf den Buchhalter

| Nr. | Frage | Gesperrt bis dahin |
|---|---|---|
| E1 | Gegenkonto der Eröffnung (Vorschlag: `OPENING_BALANCE_EQUITY`; Anzahlung Kunde auf `CUSTOMER_CREDIT` oder `CUSTOMER_DEPOSITS`?) | jede Eröffnungsbuchung (`OPENING_BOOKING.active = false`, es gibt keinen Weg dorthin) |
| E2 | Buchungsdatum (Stichtag 15.10.2026 oder Erfassungstag) und Verhältnis zum Kassen-Anfangsbestand am 01.01.2000 | wie E1; der Kassen-Anfangsbestand bleibt unverändert |
| E3 | VAT: Übernahme ohne VAT-Buchung bestätigen; uneinbringliche Altforderung | wie E1 |
| E4 | Korrektur eines gebuchten Postens (Gegenbuchung mit welchem Datum) | Storno nur ungebucht (`BOOKED_NEEDS_REVERSAL`) |
| E5 | Zahlung auf Eröffnungsposten (eigene Zahlungszeilen; Lieferanten-Sammelzahlung einbeziehen) | Posten nicht bezahlbar |
| W1 | Vereinbarter Nachlass: Gutschrift mit VAT-Korrektur? | Erlass: kein Feld, kein Befehl (`WAIVER_BOOKING_BLOCKED`); nur die Vorschau Zahlung + Erlass |
| W2 | Forderungsverzicht / Erlass durch den Lieferanten: Konto (Ertrag/Aufwand), VAT | wie W1 |
| W3 | Uneinbringliche Forderung: Abschreibung, VAT-Entlastung | wie W1 |
| A1 | Vorauszahlung des Kunden vor dem Start: wurde VAT schon bei der Anzahlung erklärt? Wie wird die spätere Rechnung behandelt? | Verrechnung von Eröffnungs-Anzahlungen (Erfassung erlaubt) |
| A2 | Vorauszahlung an Lieferanten: Guthaben mit welcher Kennzeichnung (`supplier_credits` hat keine Quellenspalte)? | wie A1 |

Nach der Freigabe:
- Der Eröffnungsposten wird gebucht (Forderung bzw. Verbindlichkeit gegen das bestätigte Eröffnungskonto).
- Eine Anzahlung wird `customer_credits` bzw. `supplier_credits` mit Quelle „Eröffnung" und ist dann über die vorhandenen Einlösewege nutzbar (`invoices.apply_credit`, `suppliers.apply_credit`).
- Receivables, Payables, „Pay Supplier", „Receive Payment" und die Abstimmungsseite nehmen die gebuchten Posten auf.

## Invarianten (Tests: `test/opening-balances/opening-balances-bundle.test.ts`)

- Ein Eröffnungsposten schreibt **keine** Hauptbuchzeile, keine Rechnung, keine Zahlung und keinen Einkauf.
- Kontaktdaten speichern verändert weder Buchung noch Eröffnungsposten.
- Kunden- und Lieferantenzahlung überzahlen nie still. Eine gescheiterte Teilzahlung nimmt die ganze Verteilung zurück.
- Der VAT-Periodenschutz der Einzelzahlung gilt auch für die Sammelzahlung.
- Primary und PC2 rechnen Salden mit derselben Funktion. Ohne Antwort steht „n/a".

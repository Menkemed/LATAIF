# B2/B3 — gemeinsame Einkaufsverrechnung (normaler Einkauf und Kommissions-Einkauf)

> **Umgesetzt (Owner-Freigabe 10.11.2026), Teil von v0.8.100:** `15ac1543` (Einkaufsverrechnung, ein Dialog für Rechnung,
> Einkauf und Kundenkonto), `3b297a93` („Change amount" je Zuordnung, Einkaufs-Einstieg, Ankaufbeleg), `c3340a31` / `78b6b8d5` /
> `2f2473a9` (Zahlungsrechte, keine stille Bank-Zahlart). Buchung wie unten: Rechnungszahlung `purchase_offset` (Soll
> ACCOUNTS_PAYABLE mit Gegenpartei Lieferant / Haben AR Kunde), Einkaufszeile `offset` ohne eigene Buchung, keine VAT-/NBR-Änderung.
> Der Text darunter ist der ursprüngliche Plan (Stand vor der Umsetzung).

Stand 10.11.2026 (Plan). **Nur Plan — nichts davon ist gebaut.** Die Buchung „Soll ACCOUNTS_PAYABLE / Haben ACCOUNTS_RECEIVABLE"
ist ein **Vorschlag** und braucht die Bestätigung des Buchhalters (Abschnitt 9). Die Umsetzung braucht eine eigene Freigabe.

## 1. Ziel

Eine offene Verkaufsrechnung (der Kunde schuldet uns) wird mit einem offenen Einkauf bei **derselben Person** (wir schulden
ihr als Lieferant) ohne Geld verrechnet — für normale Einkäufe **und** Kommissions-Einkäufe, weil beide dieselbe
Verbindlichkeit sind. Einstiege später:

1. auf der Verkaufsrechnung („Settle Balance"),
2. auf dem Einkauf („Settle Balance"),
3. im Kundenkonto (Stufe C, dritte Gruppe „Purchases").

Alle drei rufen **eine** Hausfolge, buchen gleich und dokumentieren unter derselben STL-Nummer wie B1 und Stufe C.

## 2. Was der Code heute tut (geprüft)

| Thema | Befund | Beleg |
|---|---|---|
| Einkauf | Soll Lager/Vorsteuer, Haben `ACCOUNTS_PAYABLE`, Gegenpartei **Lieferant** | `posting.ts` `postPurchaseReceived` |
| Kommissionsverkauf mit Rechnung | legt beim Kommittenten einen **Einkauf** an (dieselbe AP); Kommission am Kopf (`source_consignment_id`, nur bei genau einer) oder je Zeile (`purchase_lines.source_consignment_id`) | `consignmentStore.ts` `recordSale` |
| Garantie-Unterschreitung | eigene Ausgabe `ConsignorLoss`, AP beim Kommittenten-Lieferanten | `consignmentStore.ts` |
| Altweg ohne Rechnung | `payout_amount` an der Kommission; Auszahlung bucht Aufwand gegen Geld — **keine Verbindlichkeit im Hauptbuch** | `postConsignmentPayout` |
| `COMMISSION_PAYABLE_CONSIGNOR` | wird nirgends bebucht | — |
| Einkaufszahlung | `purchase_payments` (Zahlart freier Text, `voided_at`), Hausfolge `recordPurchasePaymentInHouse` ohne eigene Transaktion; bucht Soll AP / Haben Geld, **beide** Zeilen Gegenpartei Lieferant | `payables-house.ts`, `postPurchasePayment` |
| „Beglichen" am Einkauf | `paid_amount` (nur Geld) + Σ Zahlart `'credit'` (Lieferantenguthaben) — **mehrfach kopiert**, keine zentrale Funktion (≈ 6 Stellen) | `payables-house`, `purchase-lifecycle-house`, `purchase-edit-house`, `mixed-invoice-correction` |
| Rechnungszahlung (B1-Weg) | Geldzeile und AR-Zeile tragen **beide** Gegenpartei **Kunde** | `postInvoicePayment` |
| Kunde ↔ Lieferant | nur `suppliers.linked_customer_id` (eindeutig je Filiale) ist eine ausdrückliche Verknüpfung; der Kommittenten-Lieferant wird teils über Spiegel-Notiz/Telefon/Name gefunden und dann **ohne** Verknüpfung benutzt | `consignmentStore.findOrCreateSupplierForConsignor` |
| Unbekannte Zahlart | fällt an 6 Stellen still auf **BANK** (Buchung, Banking, Nachbuchung) | `purchaseCashAccountFor`, `cashAccountFor`, `backfill.ts`, `bankingStore.ts` |
| Rechte | Einkaufszahlung/`suppliers.pay` ohne Rechte-Tor; Rechnungszahlung/Stufe C = `payments.*` oder Admin | `command-permissions.ts` |

**Daraus folgt:** Es entsteht keine zweite Kommissionsverbindlichkeit — B2 ist technisch dieselbe Verrechnung wie B3, nur auf
einen Kommissions-Einkauf. `COMMISSION_PAYABLE_CONSIGNOR` wird nicht benutzt.

## 3. Was verrechenbar ist (Vorschlag)

| Gegenposten | Verrechenbar | Warum |
|---|---|---|
| Normaler Einkauf, offener Rest | ja | AP beim verknüpften Lieferanten |
| Kommissions-Einkauf, offener Rest | ja | dieselbe AP |
| `ConsignorLoss`-Ausgabe | **später** (eigene Freigabe) | AP über Ausgaben, `expense_payments` ohne Storno-Spalte |
| Altweg ohne Rechnung (`payout_amount`) | **nein** | keine Verbindlichkeit im Hauptbuch |
| Scrap-Gold-Quick-Trade | nein | wird sofort voll bezahlt, keine offene Schuld |
| Gold-Verbindlichkeit in Gramm | nein | nie in BHD |
| Eröffnungsposten der Lieferantenrolle | nein | wartet auf den Buchhalter (wie bisher) |

**Identität:** nur Einkäufe eines Lieferanten mit `linked_customer_id = Kunde der Rechnung`, dieselbe Filiale. Ein
Kommittenten-Lieferant ohne Verknüpfung wird **nicht** angeboten; das Konto zeigt den Hinweis „Link the supplier role
first" mit dem vorhandenen Knopf zum Verknüpfen. Die App verknüpft nie selbst.

## 4. Buchung (Vorschlag — Buchhalter)

**Eine** Buchung je Zuordnung, an der **Rechnungszahlung** (wie B1), ohne Geldkonto:

```
Soll  ACCOUNTS_PAYABLE      Gegenpartei LIEFERANT (Lieferant des Einkaufs)
Haben ACCOUNTS_RECEIVABLE   Gegenpartei KUNDE     (Kunde der Rechnung)
```

Technisch: neue Rechnungs-Zahlart `purchase_offset`. `postInvoicePayment` bekommt für genau diese Zahlart die Soll-Zeile
mit Gegenpartei **Lieferant** (heute stünde dort der Kunde → die Abstimmung „AP je Lieferant" liefe auseinander).
Am Einkauf entsteht eine Zahlungszeile Zahlart `offset` **ohne eigene Buchung** (wie die Darlehenszeile in B1).
Aufheben bucht über `deletePayment` (Gegenbuchung der Rechnungszahlung) und setzt die Einkaufszeile auf `voided_at`
(Zeile bleibt, Historie). VAT, Margin und Vorsteuer bleiben an Rechnung bzw. Einkauf, wie sie sind — eine Verrechnung ist
eine Zahlung, kein Steuertatbestand (Bestätigung Frage 4).

## 5. Datenmodell — keine neue Tabelle, keine neue Spalte

- `party_offsets`: `payable_type = 'PURCHASE'`, `payable_id` = Einkauf, `payable_payment_id` = die `purchase_payments`-Zeile,
  `settlement_number` wie Stufe C. `payable_type` ist schon freier Text.
- `purchase_payments.method = 'offset'`, `payments.method = 'purchase_offset'` — beide Spalten sind freier Text; das
  Sync-Manifest braucht **keine** Änderung.
- „Beglichen" am Einkauf = `paid_amount` (Geld) + Σ `'credit'` + Σ `'offset'` (nicht storniert). `paid_amount` bleibt
  **nur Geld** (sonst würden Überzahlung, Void, Retoure und Ankaufbeleg die Verrechnung als Bargeld behandeln).
  Dafür **eine** zentrale Funktion `purchaseSettledFils(id)` statt der heutigen Kopien.

## 6. Wege, die angepasst werden müssen

**Lesen (Verrechnung zählt als beglichen, ist aber kein Geld):** Banking (Einkaufs- und Rechnungszahlungen ausschließen),
Nachbuchung `backfill` (nie nachbuchen), Payables, Lieferantenkonto/-saldo, Kundenkonto, Eröffnungsübersicht, Abstimmung
`domainAP`/`domainAR` und „AP/AR je Gegenpartei", Einlieferer-Seite (`consignor-side`), Seiten-Auskünfte und Beschriftungen,
Ankaufbeleg (PDF).

**Sperren, solange eine wirksame Verrechnung am Einkauf hängt** (sonst zerreißt sie oder wird Geld): Einkauf stornieren
(heute auch teilbezahlt möglich), Lieferant wechseln, Zahlung voiden / Zahlungsdatum ändern (für die `offset`-Zeile nur
„Remove offset"), Lieferanten-Retoure, Einkaufssumme unter das Beglichene senken, Kommission „Cancel Sale" und „Return after
sale", Mixed-Korrektur E5/D3. Auf der Rechnungsseite dieselben Ausnahmen wie für `debt_offset` (Storno gibt zurück statt bar
zu erstatten, Löschen gesperrt, Bearbeiten mit Überzahlung gesperrt, spätere Rückgabe sperrt das Aufheben).

**Ankaufbeleg (Altgold, Gebrauchtuhren):** zeigt heute die Zahlart roh und „Paid" = nur Geld. Neu: Zeile „Settled by offset
STL-… with invoice …" (Frage 3).

## 7. Bedienung und PC2

- **Kundenkonto:** Stufe C bekommt die dritte Gruppe „Purchases" (V7: Store Credit → We Borrowed → Purchases), dieselbe
  Vorschau, dieselbe STL, dieselbe Aufhebung. Fernbefehl bleibt `customers.settle_balance` / `customers.settlement_reverse`.
- **Rechnung:** der B1-Dialog zeigt zusätzlich die offenen Einkäufe der verknüpften Lieferantenrolle (Quelle gekennzeichnet).
- **Einkauf:** neuer Knopf „Settle Balance" zeigt die offenen Rechnungen des verknüpften Kunden; bucht über dieselbe
  Hausfolge (Kunde = Verknüpfung des Lieferanten).
- **Einzel-Aufheben:** „Remove offset" auf Rechnung und Einkauf (beide → dieselbe Rechnungszahlung löschen); ganze STL im Konto.
- PC2: keine neuen Befehle nötig, wenn alle Einstiege `customers.settle_balance` nutzen (Rumpf: Auswahl + Stand + Summe).
  Rechte wie Stufe C (`payments.*` oder Admin). Wiederholung wirkt einmal (vorhanden).
- **Gleichzeitigkeit:** Einkaufszahlungen haben keine Fassung; der Fingerabdruck aller offenen Posten (Stufe C) und die
  Fassung des Einkaufs (`purchases.revision`) sichern ab.

## 8. Umsetzung in Schritten (nach Freigabe)

1. Zentrale Regel „beglichen" am Einkauf + alle Leser auf diese Regel (ohne neue Zahlart — reine Vereinheitlichung, Tests gleich).
2. Zahlarten `purchase_offset`/`offset`: Buchung mit Lieferanten-Gegenpartei, Ausnahmen in Banking/Nachbuchung/Beschriftung.
3. Hausfolge: Stufe C um Quelle `PURCHASE` erweitern (Einzel-Einstieg = Stufe C mit vorgewählter Auswahl).
4. Sperren aus Abschnitt 6 (Einkauf, Kommission, Mixed, Rechnung) — je mit Nachweis „keine Teiländerung".
5. Oberfläche: Konto-Gruppe, Rechnungsdialog, Einkaufsknopf, Ankaufbeleg-Zeile.
6. Tests: Node (voll/teil, normal/Kommission/gemeinsamer Einkauf, Identität/Filiale, keine Geldbewegung, Hauptbuch + beide
   Abstimmungen + AP je Lieferant, Umkehr einzeln/ganz, jede Sperre, PC2 + Wiederholung), Zwei-App-E2E, Pin-Nachzug.

## 9. Offene Fragen an den Buchhalter

1. **Buchung:** Ist die Verrechnung einer Lieferantenverbindlichkeit mit einer Kundenforderung **derselben Person** als
   *Soll Verbindlichkeiten aus Lieferungen (Gegenpartei Lieferant) / Haben Forderungen (Gegenpartei Kunde)* zulässig, und
   genügt ein Verrechnungsbeleg je Zuordnung (STL-Nummer, Datum, Betrag, beide Belege) als Nachweis?
2. **Aufrechnungserklärung:** Braucht es eine Zustimmung/Unterschrift der Gegenseite (z. B. auf einem druckbaren STL-Beleg),
   oder genügt die interne Dokumentation?
3. **Ankauf von Privatpersonen (Altgold, Gebrauchtuhren):** Darf ein solcher Ankauf durch Verrechnung statt Bar-/Bankzahlung
   beglichen werden? Reicht auf dem Ankaufbeleg „beglichen durch Verrechnung STL-… mit Rechnung …"? Gibt es Nachweis- oder
   Bargeldvorschriften, die eine echte Zahlung verlangen?
4. **VAT/NBR:** Bleiben Umsatzsteuer der Rechnung und Vorsteuer/Margin des Einkaufs durch die Verrechnung unberührt, und gilt
   für die Rechnung der Tag der vollständigen Verrechnung als Zahlungstag (Exportmonat) wie bei jeder Zahlung?
5. **Kommission:** Darf die Auszahlung an den Kommittenten (sein Einkauf) durch Verrechnung mit seiner eigenen Kaufrechnung
   erfolgen? Und darf auch die Garantie-Unterschreitung (`ConsignorLoss`) verrechnet werden?
6. **Spätere Minderung des Einkaufs** (Lieferanten-Retoure, Preiskorrektur unter das Verrechnete): Soll dann die Verrechnung
   zurückgehen (Kundenforderung wieder offen) — oder darf der Überschuss als Lieferantenguthaben stehen bleiben? (Vorschlag:
   gesperrt, solange die Verrechnung besteht; erst „Remove offset", dann Minderung.)
7. **Filialen:** Verrechnung nur innerhalb derselben Filiale — bestätigt?

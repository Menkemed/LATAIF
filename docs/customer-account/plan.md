# Kundenkonto — alles mit einem Kunden auf einen Blick, verrechnen mit einem Klick

Stand 08.11.2026. Entwurf zur Owner-Freigabe; noch nichts gebaut, nichts committet. Vorschau: `docs/customer-account/preview.html`.
Ersetzt als Gesamtlösung `docs/debt-offset/plan.md`; jener Plan bleibt das Detail für den Baustein „Rechnung gegen Schuld" (Stufe B1).

Festgelegt vom Owner (08.11.): drei Stufen A, B, C · Reihenfolge V7 · Gold in Gramm getrennt · Anzeige ist keine Zahlung.

## 1. Was du haben möchtest

Du öffnest einen Kunden und siehst sofort:

- **Was er dir schuldet** — offene Rechnungen.
- **Was du ihm schuldest** — Store Credit, Schulden „We Borrowed", Einkäufe bei ihm, Kommissionsauszahlungen, Anzahlungen.
- **Den Nettosaldo** — wer wem unterm Strich wie viel schuldet.
- **Den Kontoauszug** — alle Vorgänge nach Datum mit laufendem Saldo.

Von dort aus kannst du:

- **Receive Payment** — er zahlt Geld. Du gibst nur Betrag, Datum und Zahlungsart ein, keine Rechnung. Die App verteilt auf die ältesten offenen Rechnungen und zeigt vorher, welche bezahlt werden.
- **Settle Balance** — was ihr euch gegenseitig schuldet, wird ohne Geld verrechnet. Die App schlägt vor, du nimmst mit Häkchen heraus, was nicht dazugehören soll, und bestätigst einmal.

## 2. Der Grundsatz

**Der Saldo ist eine Anzeige.** Eine Rechnung gilt erst als bezahlt, eine Schuld erst als getilgt, wenn eine Zahlung oder Verrechnung bestätigt und gebucht ist. Das Öffnen des Kontos bucht nichts.

## 3. Was im Kundenkonto steht (Stufe A, nur lesen)

| Posten | Seite | Im Saldo | In „Settle Balance" |
|---|---|---|---|
| Offene Rechnungen (Brutto − bezahlt − Gutschrift) | schuldet uns | ja | ja — werden bezahlt |
| Schuld „We Lent" (er hat von dir geliehen) | schuldet uns | ja | nein, zuerst nur anzeigen |
| Eröffnungsposten des Kunden (OB-…) | schuldet uns | ja | nein — bleibt gesperrt bis zum Buchhalter, wie heute |
| Store Credit (nur der noch freie Teil) | wir schulden | ja | ja (1.) |
| Schuld „We Borrowed" (nur der offene Teil) | wir schulden | ja | ja (2.) |
| Einkäufe bei ihm über die **verknüpfte** Lieferantenrolle (offener Teil) | wir schulden | ja | ja (3.) |
| Kommission: **verkauft, noch nicht ausgezahlt** | wir schulden | ja | ja (4.) |
| Anzahlung auf eine Order, **noch nicht angerechnet** | wir schulden | ja, als „gebunden" | nein — gehört zu ihrer Order und wird mit deren Rechnung angerechnet, wie heute |
| Eröffnungsposten der Lieferantenrolle | wir schulden | ja | nein, wie oben |
| **Gold-Guthaben in Gramm** | — | **nein** | **nein** — eigene Karte in Gramm, nie in BHD |

Damit nichts doppelt zählt: nur offene Beträge. Ein angerechnetes Guthaben, eine angerechnete Anzahlung, eine ausgezahlte Kommission, ein bezahlter Einkauf zählen nicht mehr. Stornierte und gelöschte Belege zählen nie.

**Was nicht eindeutig zum Kunden gehört, zählt nicht still mit.** Es steht in einem eigenen Kasten „Not linked to this client — please check":

- Schulden ohne Kundenverknüpfung, deren Freitext wie der Kundenname aussieht. Knopf **„Assign to this client"** (setzt nur die Kundenverknüpfung der Schuld; nur möglich, solange sie keine Verrechnung hat).
- Ein Lieferant mit gleichem Namen ohne Verknüpfung. Nur ein Hinweis — die App verknüpft nie über Name oder Telefon (bestehende Regel `suppliers.linked_customer_id`).

Erst nach der Zuordnung zählt der Posten im Saldo.

Der Kontoauszug zeigt je Zeile Datum, Beleg, Art, Betrag und laufenden Saldo. Zahlungen und Verrechnungen stehen als eigene Zeilen; eine Verrechnung ändert den Saldo nicht (beide Seiten sinken gleich), sie ist nur sichtbar.

Das Konto gilt je Filiale (wie „Receive Payment" heute).

## 4. Zahlung ohne Rechnungsauswahl — „Receive Payment"

Gibt es schon am Kunden (`customers.settle`). Im Konto wird es der Hauptweg:

1. Betrag, Datum, Zahlungsart (Cash, Bank Transfer, Card, Benefit). **Keine Rechnung wählen.**
2. Die App verteilt: älteste offene Rechnung zuerst. Vorschau je Rechnung: wie viel, danach offen, „Paid" oder „Partially paid".
3. Wer selbst verteilen will: „Choose invoices" (gibt es schon).
4. Bestätigen. Die Rechnungen zeigen „Cash payment · über Receive Payment", eine voll bezahlte bekommt ihre Endnummer wie heute.

Ist der Betrag größer als alles Offene, wird der Rest **nur mit Häkchen** „Keep the rest as store credit" zu Store Credit (gibt es schon). Ohne Häkchen wird abgelehnt.

**Neu:** Hat der Kunde **gar keine** offene Rechnung, lehnt die App heute ab (`CUSTOMER_NOTHING_OPEN`). Künftig: mit Häkchen „Payment on account" wird der ganze Betrag zu Store Credit (Quelle „payment on account"). Buchung Soll Kasse/Bank / Haben CUSTOMER_CREDIT, ohne VAT bei Eingang — dieselbe Behandlung wie eine Order-Anzahlung heute. So bleibt eine nicht zuordenbare Zahlung nachvollziehbar stehen, und keine zufällige Rechnung wird als bezahlt markiert. Das Guthaben wird später über „Settle Balance" (Schritt 1) oder auf der Rechnung angerechnet.

## 5. „Settle Balance" (Stufe C)

1. Knopf im Konto, nur wenn auf beiden Seiten verrechenbare Posten stehen.
2. Die App schlägt vor:
   - **Links** die offenen Rechnungen, älteste zuerst, mit Häkchen.
   - **Rechts** was du schuldest, in der festgelegten Reihenfolge (V7): **Store Credit → We Borrowed → Einkäufe → Kommissionsauszahlungen**, innerhalb jeder Gruppe älteste zuerst, mit Häkchen.
3. Darunter „What will happen": jede Zuordnung als Zeile (z. B. „LOA-2026-000003 → SINV-2026-000014 · 1.200,000"), dazu Vorher/Nachher je Beleg und der Saldo vorher/nachher.
4. Häkchen abwählen rechnet sofort neu.
5. Datum (heute vorgewählt, frei wie bei Zahlungen), optional Notiz.
6. **Ein Klick „Confirm settlement"** bucht alle Zuordnungen in **einer** Transaktion unter einer Nummer `STL-2026-000001`. Klappt eine nicht (Sperre, geänderter Stand), wird nichts gebucht.
7. Volle Deckung einer Rechnung → Nummerndialog wie heute (INV/SINV). Bei mehreren Rechnungen nacheinander.

Teilverrechnung ist normal: was übrig bleibt, bleibt offen — auf der Rechnung oder beim Posten, den du schuldest.

## 6. Buchungen (Stufe B)

Jede Zuordnung ist **eine** Buchung, ohne Kasse, Bank oder Karte, ohne Kartengebühr:

| Zuordnung | Soll | Haben | Teilschritt |
|---|---|---|---|
| Store Credit → Rechnung | CUSTOMER_CREDIT | AR | gibt es schon (`applyCreditToInvoice`) |
| We Borrowed → Rechnung | LOAN_PAYABLE | AR | **B1** (Plan `docs/debt-offset/`) |
| Kommission → Rechnung | COMMISSION_PAYABLE_CONSIGNOR | AR | **B2** |
| Einkauf → Rechnung | ACCOUNTS_PAYABLE | AR | **B3** — erst nach Bestätigung des Buchhalters |

Auf beiden Seiten entsteht eine Zahlungszeile ohne eigene Buchung:

- Rechnung: „Offset · LOA-2026-000003 · no cash" (Zahlungsart je Quelle: `debt_offset`, `consignment_offset`, `purchase_offset`).
- Schuld: Rückzahlung mit Quelle `offset`.
- Einkauf: Zahlung mit Art `offset`.
- Kommission: Auszahlung mit Art `offset`.

Neue Tabelle `party_offsets`: Nummer STL, Kunde, Rechnung, Rechnungszahlung, Quelle (Art + Beleg + deren Zahlungszeile), Betrag, Datum, Status aktiv/aufgehoben. Darüber findet jede Seite die andere. Sync-Manifest ergänzen; bestehende Zeilen bleiben unverändert.

VAT und NBR: Eine Verrechnung ist eine Zahlung. Wird die Rechnung dadurch voll bezahlt, zählt sie in diesem Monat wie bei jeder Zahlung. Die Einkaufsseite und ihr Ankaufbeleg bleiben, wie sie sind; eine Verrechnung ist kein neuer Einkauf.

**Für den Buchhalter (vor B3):**

1. Verrechnung Einkauf gegen Verkauf als Soll Lieferantenverbindlichkeit / Haben Kundenforderung, je Paar dokumentiert.
2. Bei Altgold- und Gebrauchtuhr-Ankäufen mit Ankaufbeleg: genügt die Verrechnung als Zahlungsart auf dem Beleg?
3. Einmal bestätigen: „Payment on account" ohne VAT bei Eingang, wie die Order-Anzahlung.

## 7. Rückgängig machen

| Fall | Wirkung |
|---|---|
| Auf der Rechnung eine Verrechnung **entfernen** | Gegenbuchung; Rechnung und Gegenposten sind um den Betrag wieder offen; beide Zeilen tragen „removed" |
| Im Konto eine ganze Verrechnung **STL-… rückgängig** | Alle Zuordnungen dieser Nummer in einer Transaktion, wie oben |
| **Rechnung stornieren** | Jede Verrechnung geht an ihren Gegenposten zurück (kein Bargeld-Refund); Vorbild Guthaben und Anzahlung beim Storno |
| Rechnung so **korrigieren**, dass mehr bezahlt als geschuldet wäre | Abgelehnt: „zuerst die Verrechnung entfernen" |
| Schuld, Einkauf oder Kommission **löschen / stornieren / unter das Verrechnete senken** | Abgelehnt, solange eine aktive Verrechnung daran hängt |

## 8. Regeln und Sperren

- Nur Belege **dieses Kunden** (Lieferantenrolle nur über die ausdrückliche Verknüpfung, Kommission über `consignor_id`, Schuld über die Kundenverknüpfung).
- Betrag je Zuordnung > 0 und höchstens das Offene auf beiden Seiten.
- Datum nicht in der Zukunft, nicht vor einem der beiden Belege.
- Geschlossenes VAT-Quartal und Eröffnungsstichtag sperren wie bisher.
- Rechte wie „Record Payment"; keine neue Rolle.
- Der Vorschlag trägt einen Fingerabdruck der offenen Posten (wie `expectedOpenStamp` bei „Receive Payment"). Hat sich inzwischen etwas geändert (anderer PC, Doppelklick), wird nichts gebucht und neu vorgeschlagen.
- Primary und PC2 gleich: PC2 schickt einen Befehl, der Primary bucht in einer Transaktion; ein wiederholter Befehl wirkt nur einmal.

## 9. Bewusst nicht enthalten

- Verrechnung mit „We Lent" (er schuldet dir aus einem Darlehen) — wird angezeigt, aber nicht verrechnet.
- Verrechnung über Filialen hinweg.
- Auszahlung an den Kunden, wenn du unterm Strich mehr schuldest — bleibt in den bestehenden Masken (Schuld zurückzahlen, Lieferant bezahlen, Kommission auszahlen); das Konto verlinkt dorthin.
- Gold in Gramm verrechnen.
- Eröffnungsposten bezahlen oder verrechnen (gesperrt bis zum Buchhalter, unverändert).

## 10. Umsetzung in Schritten

Ein Gesamtplan, jeder Schritt einzeln prüfbar und einzeln freizugeben:

1. **A1 Kundenkonto lesen:** eine Auskunft `parties.statement.get` (Primary lokal, PC2 vom Primary), Seite „Account" im Kunden: Karten, offene Posten beider Seiten, Kontoauszug, Gold getrennt, Kasten „Not linked".
2. **A2 Zuordnen:** „Assign to this client" für Schulden ohne Kunde.
3. **A3 Receive Payment im Konto** + „Payment on account" ohne offene Rechnung.
4. **B1 We Borrowed → Rechnung** + Tabelle `party_offsets` + Rückgängig-Wege.
5. **C Settle Balance** mit Store Credit + We Borrowed (Vorschlag, Häkchen, eine Bestätigung, STL-Nummer, ganze Verrechnung rückgängig).
6. **B2 Kommission → Rechnung** in Settle Balance aufnehmen.
7. **B3 Einkauf → Rechnung** nach Bestätigung des Buchhalters.

Tests je Schritt:

- Node: Saldo = Summe der Posten (fils-genau, gleich wie Receivables/Payables), keine Doppelzählung, Verrechnung voll/teilweise, Reihenfolge V7, Häkchen, Grenzen, Sperren (Quartal, Stichtag, Rolle, Fingerabdruck), Rückgängig einzeln und ganz, Hauptbuch ausgeglichen, Primary = PC2, Wiederholung wirkt einmal.
- E2E am PC2 mit Maus und Tastatur, Datenbank, Neustart.

Abnahme gegen `preview.html`. Release nur auf Ansage.

## 11. Getrennt davon

v0.8.99 ist veröffentlicht und am Primary installiert. Das offene PC2-Update (zuerst „Unresolved saves" prüfen) hat mit diesem Plan nichts zu tun.

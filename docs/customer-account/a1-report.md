# Kundenkonto A1 — Umsetzung und offene Punkte

Stand 08.11.2026, Branch `feature/customer-account` (Basis `origin/main` = v0.8.99-Stand `ebac2ff3`). Nur lesen: keine Buchung, keine Verrechnung, keine Schemaänderung, keine Migration.

## Was gebaut ist

- Ansicht **Account** je Kunde: `/clients/:id/account`, Knopf „Account" im Kunden.
- Rechenkern `src/core/parties/customer-account.ts`:
  - `customerAccountFor` liest die Belege,
  - `buildCustomerAccount` rechnet Salden und Kontoauszug, ohne Datenbank.
- Primary und PC2: dieselbe Auskunft `parties.account.get` mit `view: 'customer_account'`.
  - Es gibt keinen neuen Fernbefehl und keine Rust-Änderung.
  - Ohne `view` liefert die Auskunft genau das Bisherige.

## Datenquellen (je Posten dieselbe Regel wie die führende Fläche)

| Posten | Seite | Quelle / Regel |
|---|---|---|
| Rechnungen | schuldet uns | Receivables / „Receive Payment": Brutto − bezahlt − Gutschrift-Forderungsstorno; ohne Entwurf/Storno; retourniert = 0 |
| Reparatur ohne Rechnung, Approval (Agent = Kunde) | schuldet uns | Receivables |
| We Lent | schuldet uns | Kundenkennzahlen: Betrag − Rückzahlungen |
| Eröffnungsposten Kunde (OB, erfasst) | beide | `opening_balance_items`; **gebunden** (nicht gebucht, nicht bezahlbar) |
| Store Credit (OPEN) | wir schulden | einlösbares Guthaben (Betrag − verwendet) |
| Rückzahlungsanspruch (REFUND_DUE), Retoure-Erstattung | wir schulden | Payables „Refund" |
| We Borrowed | wir schulden | Payables „Loan" |
| Einkäufe der **verknüpften** Lieferantenrolle, Ausgaben, Lieferantenguthaben, Lieferanten-Eröffnungsposten | beide | Lieferantenkonto (`supplierLedgerStrict`-Regel), ohne Entwurf |
| Kommission Altweg | wir schulden | Payables „Consignor" |
| Kommission über Record Sale | wir schulden | Einkauf mit `source_consignment_id` → `consignor_id`, genau einmal |
| Order-Anzahlung | wir schulden | Kundenseite (`customerOrderDepositsFor`); **gebunden** an den Auftrag |
| Partner | beide | nur ausdrücklich verknüpft; offener Stand der Partnerlogik (`partnerOpenRows`) |
| Gold | — | getrennt in Gramm (OPEN, Gewicht − erfüllt), nie in BHD |

**Saldo:** Netto = Summe der offenen Beträge „schuldet uns" − Summe „wir schulden". Dazu wird der Netto-Saldo nur der frei verrechenbaren Beträge getrennt ausgewiesen.

**Kontoauszug:** Er zeigt je Beleg die Ausstellung und seine Zahlungen bzw. Anrechnungen. Was die Einzelbewegungen nicht erklären, steht als eigene Zeile, z. B. „Correction" oder „Returned". So endet der Auszug immer genau beim Netto.

**Gezählt wird nur, was ausdrücklich verknüpft ist.** Was nur nach Name oder Telefon passt, ist ein Hinweis (Darlehen ohne Kunde, Lieferant, Partner). Ein Hinweis zählt nicht im Saldo, und der Saldo wird dann als unvollständig markiert.

## Partner Account

- **Seit A2 (09.11.)** gibt es die ausdrückliche Verknüpfung `partners.linked_customer_id` (siehe P1). Nur ein verknüpfter Partner zählt. Seine **offenen** Beträge laufen über `partnerOpenRows` in den Saldo, also dieselbe Zahl wie in Receivables/Payables, je Partner und Artikel genau einmal:
  - Kostenanteil oder Rückforderung = der Partner schuldet uns.
  - „Pay out" = LATAIF schuldet ihm.
  - Eine Auszahlung, die wartet, zählt als gebunden.
- Ein nicht verknüpfter möglicher Partner (gleiches Telefon oder gleicher Name) erscheint mit seinem vollen Stand aus der Partnerlogik, ausdrücklich als „not counted", mit dem Knopf „Link to this client":
  - Artikel und Einkauf, Anteil
  - vereinbarter Beitrag und eingezahlter Beitrag
  - Verkauf, abgerechneter Gewinnanteil
  - Auszahlung und Verrechnung, offener Stand
- Ein rechnerischer Gewinnanteil aus einem noch nicht abgerechneten Verkauf wird nur angezeigt und **nie** gezählt.
- Gesellschafterkonten (`partner_transactions`, Eigenkapital) bleiben außen vor.
## Owner-Entscheidungen

- **P1 Partner ↔ Kunde — umgesetzt in A2 (09.11.):**
  - **Schema:** Spalte `partners.linked_customer_id` (rein additiv, Altzeilen NULL) mit eindeutigem Index „höchstens ein Partner je Kunde und Filiale". Die Spalte ist im Abgleich-Manifest eingetragen.
  - **„Link to client"** im Partner-Dialog (Kunde auswählen) und „Link to this client" im Kundenkonto, jeweils mit App-Rückfrage. „Unlink" gibt es im Partner-Dialog.
  - **Prüfung im Haus (`partnerLinkCheck`), abgelehnt werden:**
    - ein Kunde einer anderen Filiale oder ein System-Kunde,
    - ein schon verknüpfter Partner (er wird nie still umgehängt),
    - ein Kunde, der schon einen Partner hat,
    - ein veralteter Kundenstand.
  - Jede Änderung wird protokolliert, mit der Person, die sie wirklich gemacht hat.
  - **PC2:** über den bestehenden Befehl `partners.update` mit einem eigenen, schmalen Auftrag (Verknüpfen oder Lösen, nie zusammen mit Stammdaten). Prüfung, Transaktion und Wiederholungsschutz laufen am Primary.
  - Wird der Kunde gelöscht, wird nur der Verweis gelöst.
- **P2 Darlehen zuordnen — umgesetzt in A2 (09.11.):**
  - „Assign to client" im Darlehen-Detail (Kunde auswählen) und „Assign to this client" im Kundenkonto, nur bei Darlehen ohne Kunde und nur mit App-Rückfrage.
  - **Weg:** bestehender Befehl `debts.update` mit `assignCustomerId`, immer allein und mit der gesehenen Fassung.
  - **Es ändert sich nur `customer_id`:** Betrag, Zahlungen, Status, Freitext der Gegenpartei und Buchung bleiben, wie sie sind.
  - **Abgelehnt werden:** Umhängen eines schon zugeordneten Darlehens, ein storniertes Darlehen, eine fremde Filiale, ein System-Kunde.
  - Die Zuordnung wird protokolliert.
- **P3 Lieferantenguthaben — entschieden und umgesetzt in A1.1 (09.11.):** Die Unterscheidung folgt dem gespeicherten Status (`supplier_credits.status`; dieselbe Regel wie `supplierCreditsFor`):
  - `REFUND_DUE`: Der Lieferant muss Geld zurückzahlen („Record Repayment"). Zählt **frei**.
  - `OPEN`: Die App löst es nur auf seine Einkäufe oder Ausgaben ein (Retoure, Überzahlung, Kostenkorrektur, Vorauszahlung). Zählt **gebunden**.
  - Auch ein Vorauszahlungs-Guthaben, für das sich eine Rückzahlung erfassen ließe, bleibt gebunden, solange es kein `REFUND_DUE` ist.

## Befunde in bestehenden Flächen — Stand A1.1 (09.11.)

1. **Darlehen mit kanonischer Richtung — bestätigt und behoben.**
   - `createDebtInHouse` nimmt auch `MONEY_GIVEN` / `MONEY_RECEIVED` an.
   - Kundenkennzahlen (`customerStatsFor`) und Payables zählen jetzt beide Schreibweisen. Der Status wird ohne Groß-/Kleinschreibung gelesen, wie bei `canonicalLoanStatus`; ein „repaid" in Kleinschrift galt vorher als offen.
   - Die Darlehensliste auf der Kundenseite trennt die Richtungen jetzt über `isLoanGiven`.
   - **Behoben in A2 (eigener Commit):** Der Geldfluss in Analytics (`analytics-snapshot.ts`) zählte `MONEY_GIVEN` als „geliehen"; jetzt über `isLoanGiven`, Rückzahlungen ebenso.
2. **Einkaufsentwürfe — nicht bestätigt, keine Änderung.**
   - Jede Statusregel setzt `DRAFT` nur bei Betrag ≤ 0.
   - Ein Entwurf trägt im Lieferantenkonto deshalb nie etwas Offenes (`max(0, …)`). Der Test belegt das.
3. **Eingelöstes Lieferantenguthaben — bestätigt und behoben.**
   - `paid_amount` enthält nur Geld; das Guthaben steht in `purchase_payments` (`credit`).
   - Payables zieht es jetzt ab, wie „Pay Supplier", das Lieferantenkonto und der Einkaufsstatus.
4. **Datumsangaben:**
   - Darlehen haben kein Geschäftsdatum; der Kontoauszug nimmt `created_at`.
   - Zahlungen an Reparaturen, Approval und Kommission (Altweg) haben kein eigenes Datum; sie stehen am Belegdatum.

## Für die spätere Verrechnung (B/C) vorbereitet

- Jeder Posten hat einen festen Schlüssel: `invoice:`, `debt:`, `purchase:`, `consignment:`, `credit:`, `order:`, `opening:`, `supcredit:`, `partner:<partner>:<zeile>`.
- Dazu kommen Seite, offener Betrag und frei/gebunden.
- Eine zentrale Verrechnungsfunktion kann damit aus vier Stellen aufgerufen werden: Kundenkonto, Rechnung, Einkauf und Partner. Auf beiden Seiten zeigt dann der Kontoauszug Nummer, Datum und Betrag.
- „Receive Payment" bleibt der vorhandene Weg und wurde nicht dupliziert.

# Eröffnungsbilanz & Buchhaltungs-Abschluss — Prüfung und Umsetzungsplan (15.10.2026)

Status: Analyse auf Code-Stand `367c46e` (= origin/main, Version 0.8.82 installiert). **B1 ist umgesetzt** (lokal,
Vertrag: `docs/opening-accounting-contract.md`); B2–B5 sind nicht freigeschaltet. Alle Soll/Haben-Angaben sind
**Vorschläge** — bindend erst nach Bestätigung des Buchhalters. Pfade relativ zu `desktop/src`.

---

## 0. Was vor dem 15.10.2026 im Hauptbuch stehen kann (Code-Nachweis)

Die Produktivdatenbank wurde am 20.08.2026 bewusst leer neu angelegt. Die frühere Aussage „Verkäufe, Einkäufe und
Zahlungen seit August“ war eine **unbelegte Annahme** und ist zurückgenommen. Aus dem Code (alle Versionen bis v0.8.82)
folgt:

| Quelle | Bucht ins Hauptbuch? | Beleg |
|---|---|---|
| New Collection (Desktop), Excel-Import, Handy-Upload | **nie** — „Paid from“ war nur Anzeige | `git show v0.8.82:src/stores/productStore.ts` ~776-918; `git log -S paidFrom -- src/core/ledger` leer |
| Cash/Bank/Benefit-Opening (Settings) | **nur wenn auf der Backfill-Seite geklickt wurde** — DR CASH/BANK/BENEFIT / CR OPENING_BALANCE_EQUITY, Datum 01.01.2000 | `core/ledger/backfill.ts:1085-1096`, `core/ledger/posting.ts:2759-2832` |
| Verkauf von Altbestand (ohne Los) | DR COGS / CR INVENTORY zum Einstand → **INVENTORY wird negativ** | `posting.ts:611-640`, Test `old-stock-foundation.test.ts:452` |
| Rechnungen, Einkäufe, Ausgaben, Zahlungen, Darlehen, Partner, Umbuchungen | ja, mit ihrem Geschäftsdatum | jeweilige Poster in `posting.ts` |

**Ob es echte Vorgänge der dritten/vierten Zeile gibt (oder Testdaten), lässt sich nur an den Daten feststellen.** Die
Produktivdatenbank darf ohne Freigabe nicht gelesen werden. Zwei Wege: (a) der Owner legt selbst eine Kopie an und gibt
die read-only-Auswertung frei (nur SELECT, sql.js, nichts zurückgeschrieben); (b) Bundle B1 liefert eine Stichtagsliste
„alle Vorgänge vor dem 15.10. nach Modul“ in der App, die der Owner selbst durchgeht. Testdaten werden nie automatisch
entfernt.

## 1. Bestand der Funktionen

| Bereich | Vorhanden | Grenze |
|---|---|---|
| Kunden-/Lieferanten-Eröffnungsposten | `opening_balance_items` (OB-, 4 Arten, DOCUMENT/REMAINDER, prior VAT nur notiert, Stichtag 2026-10-15, owner, PC2-Fernbefehle, Sync insert/update, Storno mit Grund) | `OPENING_BOOKING.active=false`; nicht in Salden, nicht bezahlbar (`core/parties/opening-balances.ts:66-69, 351-358`) |
| Cash/Bank/Benefit-Opening | Settings → Tax/VAT „OPENING BALANCES“, nur Admin, nur Primary | kein Audit, kein Sync, kein Fernbefehl; Buchung nur über Backfill; Änderung = stilles Storno+Neubuchung; negativer Wert → unausgeglichene Buchung (Throw); `reverseTransaction` nimmt `currentBranchId()`; `finance.opening_benefit` nicht vorbelegt |
| Receive Payment / Pay Supplier | Rechnungen bzw. Einkäufe+Ausgaben, FIFO/manuell, Teil/voll, `expectedOpenStamp`, Replay, Überzahlung nur mit `confirmExcessAsCredit` | OB-Posten nicht enthalten (`customer-settlement.ts:49-65`, `payables-house.ts:1145-1239`) |
| Kundenguthaben | `customer_credits` + `credit_applications`, `invoices.apply_credit` (DR CUSTOMER_CREDIT / CR AR) | **keine Bar-Rückzahlung von Kundenguthaben**; Anwenden ignoriert Gutschrifts-Kürzung (`invoiceStore.ts:1436`) |
| Lieferantenguthaben | `supplier_credits`, `purchases.apply_credit`, `suppliers.apply_credit`, `suppliers.refund_credit` | Refund nur für eigenständige Vorauszahlung mit SUPPLIER_PREPAYMENT-Quelle; keine Herkunftsspalte (A2) |
| Darlehen (`debts.*`) | LOAN_RECEIVABLE/LOAN_PAYABLE, Rückzahlung, an Kunden gebunden | immer mit Geldbewegung — kein Eröffnungssaldo möglich |
| Partner (`partners.record_tx`) | PARTNER_EQUITY (Einlage/Entnahme/Gewinnverteilung) | — |
| Erlass/Nachlass | Vorschau Zahlung+Erlass getrennt; `WAIVER_BOOKING_BLOCKED` im Kundenweg | kein Konto (Nachlass/Erlass/Forderungsverlust); Gutschrift nur über Retoure; Lieferantenweg ohne Payload-Sperre |
| Altbestand | Abgang (ISSUE, mit Los gebucht, ohne Los PENDING), Add Old Stock (RECEIPT), Correct initial qty (CORRECTION), Eröffnungsvorschau `/old-stock` (CAPITALISED/OPENING_CANDIDATE/REVIEW, soldCogs, V1/V2) | Eröffnungsbuchung BLOCKED (D1–D6, D8) |
| Berichte | Kontosalden (Debug), Imbalance-Prüfung, Domain-Abgleich | **keine Bilanz, keine Saldenliste, keine Kontenklassen** (nur `NATURAL_DEBIT`, `core/ledger/queries.ts:31-57`); Gewinn nur aus Rechnungsdaten; OPENING_BALANCE_EQUITY fehlt im Debug-Kontenplan und im Abgleich |
| Periodensperre | VAT-Sperre nur für Rechnungen (Quartal der vollständigen Zahlung) | **keine allgemeine Hauptbuch-Sperre**; Einkäufe/Vorsteuer/Ausgaben nicht gesperrt; viele Stornos auf `new Date()` |
| VAT | VAT_OUTPUT, VAT_INPUT, MARGIN_VAT, TAX_PAID; Erklärung aus Rechnungen/Einkaufszeilen, nicht aus dem Hauptbuch | kein VAT-Eröffnungssaldo; VAT_OUTPUT wird nie gegen TAX_PAID ausgeglichen |

## 2. Stichtag-Semantik (Vorschlag, E2/D3)

- Eröffnung = Stand **zu Beginn des 15.10.2026** („vor dem Stichtag“ = `occurred_at < 2026-10-15`).
- Ziel je Saldoart: **gebuchter Hauptbuchsaldo vor dem Stichtag + Eröffnungsbuchung = tatsächlicher Bestand am 15.10.**
  Es wird **nie** pauschal die Summe früherer Bewegungen abgezogen; gebucht wird nur die belegte Differenz.
- Cash/Bank/Benefit: Owner erfasst den gezählten Kassenbestand / Kontoauszugsstand am 15.10. Das System zeigt den
  Buchsaldo vor dem Stichtag (inkl. einer vorhandenen 01.01.2000-Eröffnung) und die Differenz. Ist die Differenz durch
  fehlende ERP-Vorgänge entstanden, entscheidet der Owner: Vorgang nacherfassen oder als Eröffnungsdifferenz belegen.
  Kein zweiter Anfangsbestand: die 01.01.2000-Buchung bleibt stehen und ist Teil des Buchsaldos.
- Forderungen/Schulden je Partei: offene LATAIF-Belege (schon im Hauptbuch) + OB-Posten (nicht in LATAIF) = tatsächlicher
  Stand; OB-Referenzen dürfen keine LATAIF-Nummern sein (vorhanden).
- Lager: Eröffnungsvorschau (V1/V2) einschließlich der schon gebuchten COGS (gleicht das negative INVENTORY aus, D4).

## 3. Buchungsregeln (Vorschläge; OBE = OPENING_BALANCE_EQUITY)

| Nr | Vorgang | Soll | Haben | Datum | Beleg / Storno | Abgleich | Blocker |
|---|---|---|---|---|---|---|---|
| R1 | Cash/Bank/Benefit-Differenz | CASH/BANK/BENEFIT (bei Minus umgekehrt) | OBE | Stichtag | OB-Zählbeleg; Korrekturbeleg | Buchsaldo am Stichtag = Zählung | E1, E2 |
| R2 | Alte Kundenforderung | AR (Gegenpartei Kunde, Quelle OPENING/OB-id) | OBE | Stichtag | OB-Beleg; Korrektur = Storno+Neubuchung | AR je Kunde = LATAIF offen + OB offen | E1–E4 |
| R3 | Alte Lieferantenschuld | OBE | AP | Stichtag | wie R2 | AP je Lieferant | E1–E4 |
| R4 | Kundenanzahlung | OBE | CUSTOMER_CREDIT (oder DEPOSITS) + `customer_credits` Quelle `opening` | Stichtag | wie R2 | Guthaben je Kunde | E1, A1 |
| R5 | Lieferantenvorauszahlung | SUPPLIER_CREDIT + `supplier_credits` Quelle `opening` | OBE | Stichtag | wie R2 | Guthaben je Lieferant | E1, A2 |
| R6 | Darlehen gegeben / aufgenommen | LOAN_RECEIVABLE / OBE | OBE / LOAN_PAYABLE | Stichtag | LOA-Eröffnung ohne Geld | Darlehen je Partei | E1 |
| R7 | Sonstige Vermögenswerte / Verbindlichkeiten | neues Konto (z. B. OTHER_ASSETS) / OBE | OBE / neues Konto (OTHER_LIABILITIES) | Stichtag | OB-Beleg | Einzelnachweis | E1, Konten |
| R8 | VAT-Eröffnung (offene Quartale) | OBE bzw. VAT_INPUT | VAT_OUTPUT bzw. OBE | Stichtag | OB-Beleg | NBR-Erklärung kommt aus Rechnungen → Abgleich offen | E3, D6 |
| R9 | Altbestand-Eröffnung | INVENTORY (V1 oder V2, inkl. soldCogs) | OBE (D1b) | D3 | ein Beleg je Lauf; Storno mit D3/E4-Datum | INVENTORY = Regalwert | D1–D5 |
| R10 | Später gefundener Altbestand | INVENTORY | OBE (D1b) | D8 | RECEIPT → Nachtrags-Eröffnung | wie R9 | D8 |
| R11 | Zahlung auf OB-Forderung / -Schuld | CASH… / AP | AR / CASH… | Zahltag | Zahlungszeile Quelle OPENING_PAYMENT; Storno wie Zahlung | Stempel inkl. OB-Posten | E5, E3 (VAT bei Zahlung?) |
| R12 | Guthaben anwenden / zurückzahlen | vorhandene Wege; neu: Kunde DR CUSTOMER_CREDIT / CR CASH… | | Zahltag | | | A1, A2 |
| R13 | Preisnachlass (vereinbart) | REVENUE + VAT_OUTPUT (LATAIF-Rechnung) | AR | Belegtag | Gutschrift „Preis“ (ohne Retoure) | VAT-Periode | W1 |
| R14 | Vergleich / Erlass | Kunde: neues Aufwandskonto (Nachlass gewährt); Lieferant: AP | Kunde: AR; Lieferant: neues Ertragskonto | Belegtag | WAV-Beleg, Owner | Zahlung und Erlass getrennt | W2 |
| R15 | Forderungsausbuchung | neues Konto Forderungsverlust | AR | Belegtag | WAV-Beleg | VAT-Entlastung? | W3 |

Gemeinsam für alle: owner-only, Ausführung nur am Primary (PC2 per Fernbefehl), eine Transaktion, Aktionskennung +
Payload-Hash, Stand-Stempel, Audit, Sync; keine Buchung erfindet einen Gegenposten ohne Beleg.

## 4. Eröffnungsablauf (Statusmodell)

1. **Entwurf** — alle Erfassungen (OB-Posten, Kassenzählung, Darlehen, sonstige Posten, Altbestand) sind Belege mit
   `accounting PENDING`; Änderung nur per Storno + neuer Beleg.
2. **Prüfung** — Eröffnungsübersicht: Aktiva / Passiva / Eigenkapital in Fils; Eigenkapital getrennt in
   OBE (rechnerische Eröffnung, nichts erfunden), PARTNER_EQUITY und **ERP-Ergebnis vor dem Stichtag** (Ertrag − Aufwand
   mit `occurred_at < Stichtag`); offene Prüffälle (REVIEW, unklare Werte, unbekannte INVENTORY-Buchungen) sperren.
3. **Festschreibung** — Owner am Primary oder PC2; der Fernbefehl trägt den Stempel aller enthaltenen Belege; der Primary
   prüft neu, bucht alle Zeilen in einer Transaktion (Quelle je Beleg, idempotent), markiert POSTED.
4. **Danach** — Periodensperre: keine Buchung mit `occurred_at < Stichtag`, außer (a) Korrekturbelege der Eröffnung,
   (b) Nachtrags-Eröffnung für später gefundenen Altbestand (R10). Settings-Felder Cash/Bank/Benefit gesperrt.

## 5. Bundles

| Bundle | Inhalt | Bucht? | Braucht Buchhalter? |
|---|---|---|---|
| **B1 Grundlage & Übersicht** | Kontenklassen; Saldenliste und Bilanz zum Stichtag (read-only); Stichtagsliste aller Vorgänge vor dem 15.10.; Eröffnungsübersicht mit Abgleich je Saldoart; neue OB-Arten (Kassenzählung, Darlehen, sonstige Posten, VAT) nur als PENDING-Belege; Settings-Opening ins Belegmodell (Audit, Sync, PC2 per Fernbefehl), 01.01.2000-Buchung nur angezeigt; Fixes: negativer Opening-Wert, Branch in `reverseTransaction`, OBE im Debug/Abgleich | nein | nein |
| **B2 Festschreibung (Motor, gesperrt)** | Statusmodell, `opening.finalize` (owner, Primary+PC2→Primary), Buchung R1–R8, Korrekturbelege, Periodensperre mit Ausnahmen; Tests mit Testschalter | nur nach Freigabe | E1–E4 |
| **B3 Zahlungen & Guthaben** | OB-Posten in Receive Payment / Pay Supplier (Einzelposten und Gesamtsaldo, Stempel), Kunden-Guthaben-Rückzahlung, Lieferanten-Refund für Eröffnungsguthaben | nach B2 | E5, A1, A2 |
| **B4 Erlass / Nachlass / Ausbuchung** | WAV-Beleg, drei getrennte Arten, Gutschrift „Preis“ für LATAIF-Rechnungen, Lieferanten-Payload-Sperre schon in B1 | nach Freigabe | W1–W3, Konten |
| **B5 Altbestand-Eröffnung** | R9/R10 auf dem B2-Motor, V1/V2, soldCogs, Nachtrag | nach Freigabe | D1–D6, D8 |

B1 lässt sich ohne reale Beträge und ohne Buchhalter vollständig bauen und testen.

## 6. Primary / PC2 / VAT

- Jeder Write als Hausfolge am Primary (`runOnPrimary`, `assertLedgerHere`); PC2 nur über registrierte Fernbefehle
  (`ALLOWED_MUTATIONS`, `owner(...)`, Rust `REMOTE_OPS`), Replay über das Befehlsbuch, Stand-Stempel gegen veraltete Fenster.
- Hauptbuch synct insert-only; OB-Belege insert/update; Settings heute **ohne** Sync → B1 behebt das über das Belegmodell.
- VAT-Sperre bleibt unverändert; Eröffnungsbuchungen ändern keine Rechnung und keinen NBR-Export. Achtung: Output-VAT
  zählt im Monat der vollständigen Zahlung — eine Zahlung auf eine alte Forderung mit `prior_vat` UNKNOWN braucht E3.
- Zwei-App-Test mit echtem PC2 und gemeinsames Update von Primary und PC2 vor jedem Release.

## 7. Vorab-Release der Grundlage (Option)

Gepusht, nicht veröffentlicht (`v0.8.82..HEAD`, 15 Commits): Abgang Phase 1, Altbestand-Grundlage, Eröffnungsposten
ohne Buchung, Receive Payment, Stempel-Schutz, Correct initial qty. Alle Buchungsfunktionen bleiben darin gesperrt;
ungebuchte Posten sind gekennzeichnet („Recorded, not booked yet — not part of the balances above“). Voraussetzung:
Zwei-App-Test, gemeinsames Update. Hinweis an den Owner: bis B1 **keine** Cash/Bank/Benefit-Eröffnung in den Settings
eintragen und **nicht** „Backfill“ klicken.

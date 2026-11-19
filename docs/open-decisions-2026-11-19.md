# Offene ERP-Aufgaben gebündelt (19.11.2026, lokal, nicht released)

## Nachtrag 19.11.2026 — Owner-Entscheidungen umgesetzt (lokal, nicht released)

**Reparaturen**
- Entstandene Werkstattkosten bleiben beim Storno als Firmenaufwand. Bei „Return“ (Kundenware) bleiben sie als COGS stehen; das war schon so.
- Nicht entstandene Kosten nimmt „Cancel line“ zurück, jetzt **am ursprünglichen Buchungstag** (`mirrorOriginalDates`, vorher: heute).
- „Delete repair“ geht nur noch **ohne gebuchte Kosten** (`REPAIR_HAS_BOOKED_COSTS`, mit Weg im Text). Vorher nahm Löschen alle Kosten heute zurück, auch entstandene.
- Betragskorrektur einer gebuchten Zeile: Rücknahme und Neubuchung stehen am **ursprünglichen Tag**. Gilt für Werkstatt (Ausgabe) und eigene Arbeit.
- Geprüft wird jeder noch wirksame Buchungstag (`assertCostCorrectionOpen`): Buchungsstichtag und eingereichte/bezahlte Quartale. Sonst Nein, nichts geschrieben.
- Fehlerhafte Reparaturrechnungen laufen über das bestehende „Edit“ der Rechnung (keine neue Rechnung, kein Wieder-Abrechnen nach Storno). Bestand, nichts geändert.
- Reparaturen vor v0.8.55: unverändert, keine Nachbuchung (F5 bleibt dokumentiert).
- Kopfkosten-Altbestand (v0.8.55–v0.8.101) korrigiert weiter wie bisher (heute). In Produktion gibt es 0 Fälle.

**„Correct final invoice date“ (nur ADMIN, Primary und PC2)**
- Hausfolge `correctFinalInvoiceDateInHouse` (`src/core/invoices/final-date-correction.ts`).
- Fernauftrag `invoices.correct_final_date`; Registry 132, Rust REMOTE_OPS 219.
- Knopf „Correct final date“ auf der Rechnungsseite, nur bei Endrechnung.
- Abschließende Zahlung und `final_issued_at` wandern gemeinsam:
  - Die alte Zahlungsbuchung wird an ihrem Tag zurückgenommen und am neuen Tag neu gebucht.
  - Nummer, Umsatz/VAT und Kartengebühr bleiben.
  - Steht die Zahlung schon auf dem neuen Tag, zieht nur das Datum nach.
- Pflichtgrund; Protokoll in `invoice_edits` (FINAL_DATE) und Audit für Endrechnungsdatum und Zahlung.
- Abgewiesen wird:
  - kein ADMIN (Sitzung und `user_branches`), alte Fassung;
  - keine voll bezahlte Endrechnung;
  - Tag künftig oder vor dem Rechnungstag;
  - abschließende Zahlung nicht eindeutig oder keine Geldzahlung;
  - eine andere Zahlung liegt nach dem neuen Tag;
  - Überzahlung oder Guthaben;
  - alter oder neuer Tag vor dem Stichtag oder in einem eingereichten/bezahlten Quartal;
  - **Endnummer trägt ein anderes Jahr** (z. B. `INV-2027-…` und neuer Tag 2026; NBR zeigt die Nummer).
- Jahreswechsel ins Jahr der Nummer ist erlaubt.
- Liste, Detail, PDF, CSV, NBR und VAT-Übersicht lesen dasselbe Feld.
- „Manage payments“ bleibt unverändert: es datiert nur die Zahlung, das feste Datum bleibt.

**Lieferantenrückgabe mit Zusatzkosten**: Der bestätigte Standardfall war schon umgesetzt (8fdeabba):
- Rücknahme höchstens zum Einkaufspreis, kein Gewinn.
- Erstattung getrennt erfasst (`added_cost_refund`), Gutschrift = Gesamtbetrag.
- Deckel = aktivierte Zusatzkosten der zurückgegebenen Stücke; nur eine Rückgabe je Einkauf.
- Erstattung ohne VAT: Die Zusatzkosten selbst tragen nie Vorsteuer (`VAT_INPUT` bucht nur die Einkaufszeile), also dieselbe Behandlung. Kein pauschaler Satz.
- Neu:
  - A1: verständliche Meldung (ohne Zusatzkosten `PURCHASE_RETURN_GAIN_UNSUPPORTED`, mit Zusatzkosten der Höchstbetrag fürs eigene Feld).
  - A3: Rundungsrest ≤ 5 Fils auch im Partneranteil 0.
  - Hinweis zur VAT in der Maske.

**Gemeinsame Produktion**: wird nicht genutzt, die Sperre bleibt. Keine Umsetzung.

Grundlage:
- Branch `feature/customer-account`, ab `fe681669`.
- Code-Prüfung, dazu für die Reparaturen eine Auswertung auf einer **Kopie** der Sicherung `2026-11-18_nach-a2-stufe2`.
- Keine produktive Datenänderung.

## 1. Reparaturkosten (Kopfkosten, Ready, Delivered, Storno)

### Wann gebucht wird (Ist-Stand)
- **received / diagnosed:** keine Buchung.
- **in_progress / sent_to_workshop:** jede Kostenzeile mit Betrag wird gebucht.
  - Werkstattzeile → Ausgabe am Kostendatum: Soll INVENTORY (eigene Ware) bzw. COGS (Kundenware), Haben A/P.
  - Zeile im Haus → Eigenleistung REPAIR_OWN_WORK: Soll INVENTORY/COGS, Haben EXPENSES_OPERATING.
  - Später hinzugefügte Zeilen werden sofort gebucht.
- **erstes ready:**
  - Altbestand-Kopfkosten werden gebucht.
  - Bei eigener Ware steigt der Einstand um die Gesamtkosten.
  - Danach zieht jede Änderung nach (Storno + Neubuchung).
- **picked_up:** keine Buchung.
- **Rechnung:** Erlös/VAT/Forderung; die Kosten sind danach eingefroren.
- **Rechnungsstorno:** nur der Erlös wird zurückgebucht.
- Statuswechsel gehen nur vorwärts; ein „Reopen“ ist idempotent. **Doppelte Buchungen über Ready/Delivered wurden nicht gefunden.**

### Alt / neu
- **Vor v0.8.55:** Die Gebühr war eine Betriebsausgabe „RepairCosts“, `internal_cost` war nie im Hauptbuch.
- **v0.8.55–v0.8.101:** Kopfkosten wurden bei ready gebucht.
- **Ab v0.8.102:** neue Kopfkosten abgewiesen (`REPAIR_COST_AS_LINE`), Kosten nur als Zeile mit Kostendatum.

### Daten (Kopie der Sicherung)
- 84 Reparaturen, alle nach PP-13 angelegt.
- Keine Kopfkosten, keine Altausgaben.
- 6 Reparatur-Ausgaben, alle genau einmal gebucht.
- **Keine historische Korrektur nötig.**

### Bestätigte technische Fehler – behoben
- **F1** Eine Kostenzeile, die beim Start 0,000 hatte (oder auf 0 gesetzt wurde) und danach einen Betrag bekam, wurde nie gebucht. Marge und Einstand enthielten die Kosten, das Hauptbuch nicht.
  - Jetzt wird sie gebucht wie eine neu hinzugefügte Zeile, ihr Kostendatum wird vorher geprüft.
  - Gefährdet waren in der Kopie 41 Reparaturen mit 0,000-Zeile; keine davon ist betroffen.
- **F4** Eine längst gebuchte Zeile im Haus, deren Tag inzwischen gesperrt ist (Stichtag oder eingereichtes Quartal), wies jede neue Zeile und „Sent to workshop“ ab. Jetzt werden nur Zeilen geprüft, die wirklich gebucht werden.
- **F2** Eine Reparatur mit geltender Rechnung ließ sich löschen. Die FINAL-Rechnung wäre verwaist, die Werkstattkosten wären zurückgebucht worden.
  - Jetzt: `REPAIR_ALREADY_INVOICED`, erst die Rechnung stornieren.
  - In der Kopie betraf das 9 Reparaturen, keine mit Kosten.
- **F3 (Teil)** Eine Betragsänderung an einer gebuchten Zeile buchte ohne Periodenprüfung in den alten Kostentag, also auch vor den Stichtag oder in ein eingereichtes Quartal. Jetzt wird vorher geprüft und verständlich abgewiesen (zuerst „Edit date“).

### Nicht behoben (Code-Befund, in Produktion 0 Fälle)
- **F5** Altbestand vor v0.8.55: Eine „RepairCosts“-Ausgabe wird nicht als Kopfausgabe erkannt. Beim Speichern einer alten fertigen Reparatur würde doppelt gebucht; eine alte abgerechnete Reparatur meldet irreführend „already invoiced“. Betrifft nur andere Installationen mit sehr altem Bestand → **Frage 1.4**.
- **F6** (plausibel) Der Werkstatt-Nachtrag über einen Fernbefehl hängt die erste beliebige Ausgabe um. Über die Maske nicht erreichbar.

### Offene Owner-/Buchhalter-Fragen
1. Löschen einer Reparatur mit erledigter Werkstattarbeit: Soll die Verbindlichkeit an die Werkstatt zurückgenommen werden, oder bleiben die Kosten stehen (wie bei „returned“)? Braucht es einen echten Storno-Status statt Löschen?
2. Nach einem Rechnungsstorno: Soll die Reparatur wieder abrechenbar sein (wie Auftrag und Angebot)?
3. Betragskorrektur gebuchter Reparaturkosten: in der Originalperiode korrigieren (gesperrt, wenn geschlossen) oder die Differenz heute buchen? Heute: Storno heute, Neubuchung am Kostendatum.
4. Altbestand anderer Installationen vor v0.8.55: Soll die eigene Arbeit nachgebucht werden, und an welchem Datum?
5. Zurückgegebene Kundenreparaturen: Kosten bleiben ohne Erlös als COGS stehen – gewollt?

## 2. Endrechnungsdatum nachträglich korrigieren

**Heute** gibt es keinen stimmigen Weg:
- „Manage payments“ datiert die Zahlung um (Hauptbuch: Storno heute, Neubuchung am neuen Tag). `final_issued_at` bleibt dabei bewusst stehen.
- Das Umdatieren ist mit `RECORD_PAYMENTS` erlaubt, also nicht nur für ADMIN. Es prüft weder Stichtag noch Zukunft, und es gibt keinen Pflichtgrund.

**Bestätigter technischer Fehler – behoben:**
- Die VAT-Übersicht und die Summen beim Einreichen lasen `final_issued_at` nicht und rechneten mit dem spätesten Zahlungsdatum.
- Nach Umdatieren, Überzahlung oder erneuter Vollzahlung konnte das ein anderes Quartal ergeben als NBR-Export und Zeilen-Snapshot.

**Vorschlag (nicht gebaut):** Admin-Aktion „Correct final invoice date“ (Vorbild: Zahlungsdatum-Korrektur beim Einkauf).
- **Recht:** nur ADMIN, serverseitig geprüft; Pflichtgrund.
- **Ablauf:** in einer Transaktion die abschließende Zahlung umdatieren (Storno + Neubuchung, Kartengebühr mit) und `final_issued_at` nachziehen. Ist die Zahlung schon umdatiert, wird nur `final_issued_at` nachgezogen.
- **Abweisen, wenn:**
  - der Tag in der Zukunft liegt;
  - er vor dem Rechnungstag liegt;
  - er vor einer anderen nötigen Zahlung liegt;
  - ein betroffener Tag (alt, neu, heute) vor dem Stichtag oder in einem eingereichten/bezahlten Quartal liegt;
  - der Tag in ein anderes Jahr wechseln würde.
- **Audit:** alt/neu/Grund für Zahlung und Endrechnungsdatum, dazu eine `invoice_edits`-Zeile.
- **„Manage payments“:** soll bei Endrechnungen das abschließende Datum nicht mehr verschieben (Verweis auf die neue Aktion).
- **Nummer:** bleibt unverändert (Nummern-Freeze).
- **Aufwand:** etwa 7–9 Dateien und 1–1,5 Tage inklusive Abnahme mit echter Maus und Tastatur.

**Risiken:**
- Wurden die Zahlungen nach der Endrechnung verändert, ist die abschließende Zahlung nicht eindeutig. Dann abweisen und manuell prüfen.
- Ausgegebene Belege tragen das alte Datum.
- Eine Verschiebung über die Quartalsgrenze ändert Kasse/Bank beider Perioden. Das ist nur sicher, solange beide offen sind.

**Offene Fragen:**
1. Bei einem Jahreswechsel: Nummer ändern oder abweisen? Empfehlung: abweisen, Nummer nie ändern.
2. Kundenbeleg: einfach neu drucken, mit Vermerk „corrected“, oder Gutschrift mit Neuausstellung?
3. Auch für zurückgefallene (PARTIAL) Endrechnungen erlauben?
4. Kartengebühr mit umdatieren?
5. „Manage payments“ für Endrechnungen wie vorgeschlagen einschränken?
6. Auch am PC2 anbieten oder nur am Primary?

## 3. Partner- und Lieferantenrückgaben

### A. Gewinn bei Lieferantenrückgabe
**Ist-Stand:** Ein Gewinn wird vor jedem Schreiben abgewiesen (`PURCHASE_RETURN_GAIN_UNSUPPORTED` bzw. Preis-/Erstattungsgrenze), am Primary und am PC2 gleich. Ein Verlust wird Soll INVENTORY_LOSS / Haben INVENTORY gebucht.

**Technische Befunde (nicht behoben, geringe Wirkung):**
- **A1:** Ein echter Gewinn ohne Zusatzkosten wird zuerst mit „Preis über Einkauf“ und einem irreführenden Hinweis abgewiesen, nicht mit GAIN_UNSUPPORTED. Das ist nur die Meldung.
- **A3:** Die Rundungstoleranz (5 Fils je Zeile) fehlt in der Partnerrechnung; der Unterschied beträgt höchstens etwa 3 Fils.
- **A5:** `purchaseStore.createReturn`/`confirmReturn` sind toter Code ohne Prüfungen und ohne Aufrufer.

**Braucht eine Entscheidung:**
- **A2:** Wird eine Reparaturzeile storniert, nachdem ein Teil des Loses verkauft ist, nimmt der Rest den ganzen Betrag; das Reststück kann unter den Einkaufspreis fallen. Wie die Rücknahme auf Verkauftes und Restbestand aufgeteilt wird, ist eine Buchungsregel.

**Frage:** Zahlt ein Lieferant mehr als den Buchwert, wie wird der Überschuss behandelt?
- (a) neues Ertragskonto „Gewinn aus Lieferantenrückgabe“ (ohne VAT);
- (b) Minderung von Wareneinsatz/INVENTORY_LOSS;
- (c) Verkauf an den Lieferanten mit Rechnung, VAT und NBR;
- (d) weiter abweisen.

Bekommt der Partner seinen Anteil am Gewinn? Bleibt die Grenze „Preis ≤ Einkaufspreis“?

### B. VAT auf erstattete Zusatzkosten
**Ist-Stand:**
- Die Erstattung bucht ohne VAT gegen INVENTORY, höchstens in Höhe der aktivierten Zusatzkosten.
- Die Vorsteuer auf den Rücknahmepreis wird anteilig zurückgebucht.
- Werkstattkosten buchen nie Vorsteuer; eine Werkstatt-VAT steckt brutto im Einstand.

Keine falsche VAT-Rechnung gefunden. Nur Anzeige: Die Lieferantenseite zeigt die Erstattung nicht.

**Frage:** Weist der Lieferantenbeleg VAT auf die Erstattung aus, was ist das?
- (a) nicht steuerbare Kostenerstattung (heutiger Stand);
- (b) Vorsteuerkorrektur (erst sinnvoll, wenn Werkstatt-VAT als Vorsteuer gebucht wird);
- (c) eigene steuerpflichtige Leistung mit Ausgangs-VAT und NBR.

### C. Gesperrte gemeinsame Produktion
**Ist-Stand:** Gemeinsam gekaufte Ware wird von der Produktion abgewiesen (`PARTNER_ITEM_JOINT_BLOCKED`), vor jedem Schreiben, am Primary und PC2 gleich. Eine Umgehung wurde nicht gefunden.

**Befunde:**
- Die Sperre gilt auch nach einer „Take over“-Übernahme, wenn LATAIF das Stück allein hält. Das ist laut Code-Kommentar gewollt, widerspricht aber dem Wortlaut der Doku → **Frage 4**.
- Die Produktionsmaske kennzeichnet gemeinsame Artikel nicht; der Fehler kommt erst beim Bestätigen.

**Fragen:**
1. Geht die Partnerbeteiligung auf das Fertigteil über, und wenn ja, nach welchem Anteil?
2. Produktionslohn und Gemeinkosten (heute sofort Aufwand) bei gemeinsamen Teilen:
   - (a) LATAIF trägt sie allein,
   - (b) sie werden aktiviert und geteilt,
   - (c) der Partner zahlt direkt.
3. Wie wird geteilt, wenn eigene und gemeinsame Teile gemischt verarbeitet werden?
4. Soll die Sperre nach einer Übernahme fallen?

## 4. Wartung – behoben (`25993a6b`)

- **„Reclaim free space“:**
  - Verdichtet wird jetzt eine Kopie.
  - Sie ersetzt die geladene Datenbank nur, wenn `integrity_check`, Schema, `user_version` und jede Tabelle Zeile für Zeile **mit rowid** gleich sind (wie beim Offline-Werkzeug). Sonst wird sie verworfen und nichts wird geändert.
  - Auf einer Kopie der Sicherung: 48,0 → 31,6 MB, identisch, 1,1 s.
- **`zurueckspielen`:** funktioniert auch in einen völlig leeren Datenordner. Alle Schutzregeln bleiben.

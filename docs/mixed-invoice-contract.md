# Gemischte Rechnung (Mixed Invoice P1–P5) — Vertrag

Stand 07.11.2026, Branch `feature/mixed-invoice-p2` auf v0.8.98 (`112c03be`). P1a–P1c sind seit v0.8.98 ausgeliefert; P2–P5 kommen mit dem nächsten Release.
Diese Datei ist die verbindliche Stelle. Die Entscheidungsunterlagen liegen unter `docs/mixed-invoice/` (historisch, siehe dort), die Abnahme in `docs/ai/mixed-invoice-acceptance.md`, Release und Installation in `docs/ai/mixed-invoice-release-plan.md`.

## 1. Was die Funktion ist

Eine Kundenrechnung kann eigene Lagerware und Kommissionsware gleichzeitig tragen. Jede Kommissionszeile bleibt dabei ein vollständiger Kommissionsverkauf: Einkauf beim Einlieferer (eine Zeile je Stück, ein Einkauf je Einlieferer), Los, Wareneinsatz, Provision, Auszahlungsanspruch, gegebenenfalls Verlust-Ausgabe. Gebucht wird in **einer** Transaktion am Primary; PC2 und Handy schicken Fernbefehle, der Primary entscheidet.

## 2. Verbindliche Owner-Entscheidungen

| Nr. | Regel |
|---|---|
| E1 | Rabatte: zurückgestellt. Ein anderer Preis ist eine Preisänderung. |
| E2 | Ein überzahlter Einlieferer (Preis unter das Bezahlte gesenkt, Zeile entfernt): Pflichtwahl **verrechenbares Lieferanten-Guthaben** oder **Rückforderung** (`REFUND_DUE`, „Record Repayment"). Originalzahlungen bleiben. |
| E3 | Kein Rechnungsdatum vor der Einlieferung (`SALE_BEFORE_CONSIGNMENT`). Ein unbezahlter Einlieferer-Einkauf folgt dem Rechnungsdatum, ein (teil)bezahlter behält seins. |
| E4 | Kundenwechsel einer gemischten Rechnung wie bei Eigenware (S3/S5), rückwirkend auf die Tage der Zahlungen (W1). |
| E5 | Kommissionszeile entfernen = Erfassungsfehler: die Kommission geht auf **Active**, die Einkaufszeile wird zurückgenommen (unbezahlt an Ort und Stelle bzw. Storno auf dem Originaltag; bezahlt über die Lieferanten-Retoure mit Pflichtwahl E2). Eine echte Rückgabe bleibt „Post-Sale Return". Keine leere Rechnung. |
| E6 | Neue Kommissionszeile beim Korrigieren: an den **unbezahlten** Einkauf des Einlieferers, sonst ein neuer Einkauf. |
| E7 (Owner A) | Provision vom Preis inkl. VAT; die VAT trägt LATAIF. Macht VAT 10 % das LATAIF-Ergebnis negativ, wird jeder Verkauf erst nach ausdrücklicher Bestätigung gebucht (`VAT_SHORTFALL_UNCONFIRMED`) — gemischte Rechnung, „Record Sale", Handy, Primary und PC2 gleich. Die Margenrechnung bleibt unverändert. |
| E8 | Eingereichte VAT-Quartale bleiben gesperrt; Korrekturen vor dem Eröffnungsstichtag werden abgewiesen. |
| E9 (mit E5/E9 Owner) | Ein Verlust (Verkauf unter dem Boden) ist eine Ausgabe je Verkauf. Unbezahlt/teilbezahlt folgt die offene Schuld; eine echte Überzahlung braucht die Pflichtwahl Guthaben/Rückforderung (wie die Custom-Order-Kosten), auch beim Entfernen. |
| E10 | Steuerart der Rechnungszeile frei wählbar (Margin, VAT 10 %, Zero). Einkaufs-VAT des Einlieferers je Einlieferer **Pflicht**, nie vorbelegt (ohne VAT / VAT 10 %); änderbar nur vor der ersten Auszahlung. |
| E11 | Korrekturen buchen auf den Tag des Originals (Gegenbuchung je Originaltransaktion), das Änderungsdatum steht im Protokoll. |
| E12 | Mengen: **Weg A** — eine Kommissionsgruppe aus Einzelstücken (D-P5-1); vereinbarter Preis und Minimum **je Stück** (D-P5-2); eine Rechnungszeile **je Stück** (D-P5-3). |
| E13 | Gemischte Rechnung anlegen und korrigieren: ADMIN und MANAGER. |
| G4 (Owner, endgültig 07.11.) | Margin VAT = (Verkaufspreis − **tatsächlicher Einkauf**) × 10/110. **Einkauf mit abziehbarer Einkaufs-VAT 10 %:** der Nettoeinkauf, die Vorsteuer läuft getrennt. **Einkauf ohne abziehbare VAT:** der tatsächlich bezahlte Preis. Keine Bruttobasis bei Vorsteuerabzug, keine weitere G4-Umsetzung, keine automatische Änderung historischer Rechnungen. Rechenlogik `0cbbfdee`. |

**Margin VAT, eine Regel (v0.8.99, VAT-CONSISTENCY).**
- **Basis:** Die Margin VAT einer Zeile folgt dem Einstand, den die Zeile wirklich hält (`purchase_price_snapshot` = Wareneinsatz):
  - Eigenware: der Los-Einstand. Ein Einkauf ohne VAT ergibt den vollen Preis (brutto), ein Einkauf mit VAT 10 % den Preis ohne die als Vorsteuer gebuchte VAT.
  - Kommission: der Einkauf beim Einlieferer (`consignorLotCost`), also die Auszahlung, bei Unterdeckung der Verkaufspreis; mit Einkaufs-VAT 10 % netto.
  - Nie der bei der Aufnahme geschätzte Artikel-Einkaufspreis.
- **Formel:** `vatEngine.marginVatOfLine` / `calcMarginFromNet`. Der Einkauf wird auf Fils gerundet, wie im NBR-Export. Eine negative Marge ergibt 0.
- **Haus:** Anlegen und neue Zeilen beim Ändern setzen die Margin VAT aus dem gehaltenen Einstand (`marginVatFromHeldCost`, `invoiceStore`). Ein Aufrufer mit anderem Wert (Agent, Auftrag, Aufnahme-Schätzung) verschiebt so nichts mehr.
- **Korrektur (P4):** Eine unveränderte Zeile behält ihre gespeicherte VAT. Ändert sich nur ihr Einstand (Einkauf korrigiert, Einkaufs-VAT gewechselt), folgt die VAT dem neuen Einstand.
- **Verbraucher:** Rechnungszeile, Hauptbuch (MARGIN_VAT), NBR-Export, VAT-Quartalsübersicht, Finanzauswertung („Total VAT", bis v0.8.98 doppelt gezählt) und Berichte rechnen dieselbe Zahl (`test/vat/margin-vat-consistency.test.ts`).
- **Beispiele:** Kommission 1.200 bei Auszahlung 960 ⇒ 21,818. Einkauf ohne abziehbare VAT 110, Verkauf 150 ⇒ 3,636. Einkauf netto 100 + 10 Vorsteuer, Verkauf 150 ⇒ 4,545 (G4-Netto-Regel).

## 3. Wege (Haus = dieselbe Folge am Primary und für PC2)

| Vorgang | Primary | PC2 / Handy | Haus |
|---|---|---|---|
| Gemischte Rechnung anlegen (P3) | `createMixedInvoiceOnPrimary` | `consignments.record_sale` mit `ownLines` (eigene Zeilen als Absicht) | `createMixedInvoiceInHouse` → `recordSales({ mixed })` |
| Kommissionsverkauf, auch k Stücke (P2/P5) | `recordConsignmentSalesOnPrimary` | `consignments.record_sale` (Einzelrumpf oder `items[]`, bis 50) | `recordConsignmentSalesInHouse` |
| Gemischte Rechnung korrigieren (P4) | `correctMixedInvoiceOnPrimary` | `invoices.update` mit Feld `consignment` (dann sind `lines` nur die eigenen Zeilen) | `correctMixedInvoiceInHouse` (plant alles vor dem ersten Schreiben; `editInvoice` geschachtelt mit `rebook`/`houseAmounts`) |
| Kommission aufnehmen, 1–50 Stück (P5) | `createConsignmentOnPrimary` | `consignments.create` + `quantity` | `createConsignmentWithProduct` (alle Stücke vorher geplant, eine Transaktion) |
| Rückgabe nach Verkauf, Cancel Sale, Auszahlung | unverändert je Stück | unverändert | `consignment-reversal-house`, `consignment-finance-house` |

Die Kommissionssperre am gewöhnlichen Änderungsweg (`assertConsignmentSaleInvoiceEdit`) gilt nur noch für Kommissionszeilen; `withConsignmentCorrectionPermit` öffnet sie ausschließlich für die Korrekturfolge. Ein älterer Änderungsrumpf, der eine Kommissionszeile auf VAT 10 % mit negativem Ergebnis stellt, bekommt `VAT_SHORTFALL_UNCONFIRMED` (`plainEditVatShortfall`).

## 4. Kommissionsgruppe (P5, Weg A)

- **Daten:** `consignments.group_id` (gemeinsame Kennung), `group_seq` (Stück 1..N), `group_quantity` (ursprüngliche Menge) + Index `idx_consignments_group`. Rein additiv; Altzeilen bleiben `NULL` und sind Einzelkommissionen. Im Sync-Manifest erlaubt.
- **Aufnahme:** Menge 1–50 (`consignmentQuantityIssue`, ganzzahlig; fehlt sie, gilt 1 und der Weg ist der bisherige). Jedes Stück wird ein eigener Artikel (Menge 1, Kommissionsbestand, eigene SKU — getippte SKU wird `SKU-1 … SKU-N`, sonst der Zähler je Stück) und eine eigene Kommission mit denselben Bedingungen. Fotos werden je Stück verknüpft, jede Datei nur einmal gespeichert. Protokoll `consignment_group_created`. Scheitert ein Stück, entsteht keines.
- **Rest:** verfügbar ist ein Stück mit Status `active` ohne Rechnung (`isAvailablePiece`). Die Anzeige rechnet `summarizeGroup`/`groupStatusLine` (`src/core/consignment/consignment-group.ts`); gebucht wird dort nichts.
- **Teilverkauf:** k Stücke = k Kommissionen im vorhandenen Mehrfachverkauf bzw. in Abschnitt 2b; gewählt werden die verfügbaren Stücke mit der kleinsten Nummer (`pickAvailablePieces`, im Dialog zuerst die geöffneten: `expandGroupSelection`; am Handy das geöffnete Stück zuerst).
- **Je Stück unverändert:** Einliefererabrechnung, Einkaufs-VAT, Steuerart, Boden/Unterdeckung, E7, Verlust, Post-Sale Return, Cancel Sale (je Rechnung, wie bisher), P4-Korrektur, Auszahlung.
- **Nicht enthalten:** zusammengefasste Druckzeile, Gruppen-Massenrückgabe, Bearbeiten aller Stücke auf einmal.

## 5. Masken

- **Rechnung „Direct Sale"/„Edit Invoice":** Abschnitt „2b · Consignment items" (nur ADMIN/MANAGER). Je Zeile Steuerart, Preis inkl. VAT, VAT, Auszahlung, LATAIF-Anteil, Hinweise Boden/E7 mit Häkchen. Einlieferer-Abrechnung mit Pflichtwahl der Einkaufs-VAT. Beim Korrigieren: bleibende Zeilen, „leaves this invoice" mit „Keep on invoice", Einkaufslage je Einlieferer, Pflichtwahlen E2/E9. Eine Kommissionsgruppe erscheint in der Auswahl einmal („group × N available") mit „Pieces on this invoice" und „Price per piece".
- **Eigene Zeilen beim Korrigieren:** Ein Artikel, den diese Rechnung schon reserviert oder verkauft hat, steht in der Auswahl genau seiner Zeile („on this invoice"); keine andere Zeile kann ihn wählen.
- **Kommissionen:** Aufnahme mit QUANTITY und „Agreed/Minimum price per piece"; Liste „Items" mit Gruppen-Kopfzeile („Group × N · k available"), aufklappbar, „Select k"; Detail mit Abschnitt „Group"; „Record Sale" mit „Pieces to sell" und „Price per piece", Einkaufs-VAT je Einlieferer Pflicht, E7-Häkchen.
- **Handy:** Mengenfeld bei der Aufnahme, Gruppenkarte in der Liste und im Detail, „Pieces to sell" (über `items[]`), Steuerart und Einkaufs-VAT, Boden- und E7-Frage erst nach dem Nein des Primary.
- **PC2-Leiste „Unresolved saves":** reserviert am Seitenende ihre Höhe (`--pending-saves-space`), damit kein Knopf darunter verschwindet; „Hide" klappt sie auf eine Plakette mit der Zahl ein. Offene Vorgänge bleiben gespeichert, bis sie geklärt sind.

## 6. Sicherheit und Konsistenz

- **Atomar:** jede Folge in einer Transaktion (innere Rollbacks machen sie rollback-only); Prüfungen (Rolle, Fassungen, Perioden, Stichtag, Pflichtwahlen) vor dem ersten Schreiben.
- **Idempotent:** PC2-Befehle über den durablen Befehlsnachweis; dieselbe Kennung wirkt einmal.
- **Fassungen:** jede Kommission, jeder betroffene Einkauf und die Rechnung werden gegen die gesehene Fassung geprüft.
- **Hauptbuch:** Lager = aktive Lose, AP = offene Einkäufe/Ausgaben, AR = offene Rechnungen abzüglich Gutschriften, Lieferanten-Guthaben = offene Guthaben/Rückforderungen; jede Buchung ausgeglichen (in den Tests nach jedem Schritt geprüft).
- **Protokoll:** `mixed_invoice`, `mixed_invoice_correction`, `consignment_group_created`, dazu die bestehenden Einträge je Zeile.

## 7. Versionen und Rückweg

- Es gibt keine Versionsprüfung zwischen PC2 und Primary (`docs/ai/upgrade-runbook.md`).
- **Neuer PC2, alter Primary:** neue Felder (`quantity`, `ownLines`, `consignment`, `acknowledgeVatShortfall`) werden als unbekanntes Feld abgewiesen; nichts wird gebucht.
- **Alter PC2, neuer Primary:** Aufnahme ohne Menge und Verkauf mit Einkaufs-VAT funktionieren; ein Verkauf ohne Einkaufs-VAT (`CONSIGNOR_VAT_REQUIRED`) oder mit VAT-10-%-Verlust (`VAT_SHORTFALL_UNCONFIRMED`) ist ein klares Nein. Deshalb PC2 direkt nach dem Primary aktualisieren.
- **Rückweg:** nur über das Zurückspielen der Sicherung vor dem Update und den alten Installer. Eine v0.8.98-App auf der migrierten Datenbank würde Kommissionszeilen mit Gruppenfeldern in ihrer eigenen Synchronisierung abweisen (älteres Manifest).

## 8. Tests

- Node: `test/p1a`, `test/p1b`, `test/p1c`, `test/p2/e10-tax-choice`, `test/p3/mixed-invoice-create`, `test/p4/mixed-invoice-correction`, `test/p5/consignment-quantities` (inkl. Migration auf dem v0.8.98-Schema und Versionswechsel), `test/vat/margin-vat-consistency` (Margin VAT: Zeile = Hauptbuch = NBR = Auswertung, G4), dazu die Kommissions-, Rechnungs-, Einkaufs- und Manifest-Suiten.
- E2E (zwei echte Test-Apps): `mixed-invoice-p3`, `mixed-invoice-p4`, `consignment-quantities-p5` (inkl. PC2-Leiste bei 1400×900), `consignment-multi-sale-pc2`, `r5f`, `r5f1`, `r6f`, `custom-order-pc2`, `r5b-create-parity`, `consignment-duplicate-create`, `restore-safety`; Handy: `test/preg5/mobile-consignment-page.e2e.mjs` und `pre-g5-mobile-consignment`.
- Die Generatoren der P3–P5-Tests lagen während der Entwicklung außerhalb des Repositorys; die erzeugten Dateien sind die Quelle.
- Testisolation (seit 07.11.2026): `test/e2e-safety/locator-isolation.test.ts` (Testtreiber) und `test/e2e-safety/data-root-isolation.e2e.mjs` (Laufzeitsperre der Test-App).
- Abnahme: `docs/ai/mixed-invoice-acceptance.md` — die persönliche Sichtabnahme des Owners ist dort für jede Zeile als offen geführt.

## 9. Bekannte offene Punkte

- **G4 ist entschieden** (Owner, endgültig 07.11., §2): Bei abziehbarer Vorsteuer ist die Basis netto, ohne abziehbare VAT der tatsächliche Preis. Daraus folgt keine weitere Entwicklung.
- **Dokumentierte Grenze (keine Entwicklung):** Die App prüft weder die NBR-Zulassung zum Margin Scheme noch die Warenberechtigung (Bahrain-VAT-Ausführungsverordnung Art. 31, NBR-Leitfäden; Einschränkungen u. a. für Edelmetalle, Edelsteine, Perlen, Schmuck). „Margin" ist eine Auswahl des Bedieners. Im Bestand vom 07.11.2026 kommt kein Margin-Verkauf nach Vorsteuerabzug vor (`E:\software\lataif\vat-pruefung\2026-11-07\`).
- `posting.ts` liegt mit CRLF im Repository: `git diff --check` mit `-c core.whitespace=cr-at-eol` prüfen.

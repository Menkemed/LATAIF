# Mixed Invoice P3 · P4 · E7 · P5 — Abnahmematrix

Regeln: `docs/ai/acceptance-rules.md`. Abnahmegrundlage sind die freigegebenen Previews `docs/mixed-invoice/preview-p1-p4.html` und `docs/mixed-invoice/preview-p5-quantities.html`. Regeln der Funktion: `docs/mixed-invoice-contract.md`.

**Status:** Jede Zeile ist in der echten Test-App belegt: zwei Apps (Primary + PC2), Maus über `mausKlick`/`_e2e-mouse.mjs`, Tastatur über `Input.insertText`, danach die Wirkung in der Datenbank des Primary und beim erneuten Öffnen geprüft.
**Owner 07.11.2026 (Release-Auftrag v0.8.99):** Die Abnahmebilder sind geprüft, und es ist keine größere UI-Entwicklung erforderlich. Die Spalte „Owner" gibt den Stand vor dieser Prüfung wieder. Die Bedienung an Primary und PC2 nach der Installation bleibt Teil des Installationsplans (§5).

Bilder (Stand 07.11.2026, Test-App mit Testdaten): `E:\software\lataif\abnahme\mixed-invoice-2026-11-07\` — bewusst außerhalb des Repositorys.

## 1. P3 — gemischte Rechnung anlegen (`test/e2e/mixed-invoice-p3.e2e.mjs`)

| # | Funktion (Preview) | In der App | Benutzeraktion im Lauf | Ergebnis | Bild | Owner |
|---|---|---|---|---|---|---|
| 3.1 | Abschnitt „2b · Consignment items" (nur Admin/Manager) | „Direct Sale", Abschnitt 2b | Kommissionsartikel über die Auswahl, Steuerart gewählt, Preis per Tastatur | PASS | p3-b1 | offen |
| 3.2 | Je Zeile VAT/Margin-VAT, Auszahlung, LATAIF-Anteil | dieselbe Zeile | Anzeige gegen die Buchung verglichen; seit VAT-CONSISTENCY auch gegen den NBR-Export: Nautilus 1.200/960 ⇒ Margin VAT 21,818 (vorher 36,364 aus der Aufnahme-Schätzung 800) | PASS | p3-b1 | offen |
| 3.3 | E7-Hinweis nur an der betroffenen Zeile; ohne Häkchen kein Speichern | Hinweis + Häkchen je Zeile | Speichern ohne Häkchen (Nein, kein Auftrag), dann mit Häkchen | PASS | p3-b1 | offen |
| 3.4 | Einlieferer-Abrechnung, Einkaufs-VAT je Einlieferer Pflicht, nicht vorbelegt | „Consignor settlement" | beide Einlieferer per Maus gewählt | PASS | p3-b2 | offen |
| 3.5 | Speichern: eine Rechnung, ein Auftrag, je Einlieferer ein Einkauf, Teilzahlung → PINV | Save Invoice | Speichern per Maus | PASS | — | offen |
| 3.6 | Primary: Direct Sale mit Vollzahlung (Nummerndialog) | Primary-Maske | Speichern, „Normal Final" | PASS | — | offen |

## 2. P4 — gemischte Rechnung korrigieren (`test/e2e/mixed-invoice-p4.e2e.mjs`)

| # | Funktion (Preview) | In der App | Benutzeraktion im Lauf | Ergebnis | Bild | Owner |
|---|---|---|---|---|---|---|
| 4.1 | Bleibende Kommissionszeilen in 2b; eigene Zeilen zeigen ihren Artikel | „Edit Invoice" am PC2 | Maske öffnen; verkaufter/reservierter eigener Artikel zeigt Namen („on this invoice"), kein „Pick product…" | PASS | p4-b1 | offen |
| 4.2 | Preis ändern, Zeile entfernen („leaves this invoice", „Keep on invoice"), Zeile hinzufügen | 2b + Einkaufslage je Einlieferer | Preis per Tastatur, Papierkorb per Maus, neue Zeile | PASS | p4-b2 | offen |
| 4.3 | Bezahlter Einlieferer: Pflichtwahl Guthaben/Rückforderung (E2/E5) | Wahlblock je Einkauf | ohne Wahl speichern (Nein), dann „Rückforderung" | PASS | p4-c | offen |
| 4.4 | Bezahlter Verlust zu hoch: Pflichtwahl (E5/E9) | Wahlblock je Kommission | ohne Wahl (Nein), dann „Guthaben" | PASS | p4-d2 | offen |

## 3. E7 — Bestätigung des negativen LATAIF-Ergebnisses bei VAT 10 %

| # | Ort | Benutzeraktion im Lauf | Ergebnis | Bild | Owner |
|---|---|---|---|---|---|
| 7.1 | Gemischte Rechnung (P3 3.3) | siehe oben | PASS | p3-b1 | offen |
| 7.2 | „Record Sale" am PC2 (`mixed-invoice-p4` D) | Steuerart VAT 10 % per Maus; „Confirm" gesperrt bis zum Häkchen; Bestätigung reist im Auftrag | PASS | p4-d | offen |
| 7.3 | Handy (`test/preg5/mobile-consignment-page.e2e.mjs` §4b) | Nein des Primary → Kästchen leer; ohne Häkchen geht nichts hinaus; Steuerart ändern setzt zurück | PASS | — | offen |

## 4. P5 — Kommissionsgruppe (`test/e2e/consignment-quantities-p5.e2e.mjs`)

| # | Funktion (Preview) | In der App | Benutzeraktion im Lauf | Ergebnis | Bild | Owner |
|---|---|---|---|---|---|---|
| 5.1 | Aufnahme mit Menge, „Agreed price per piece" | „New Consignment" am PC2 | Menge 4 per Tastatur, Preis/Minimum, Anlegen | PASS | p5-b | offen |
| 5.2 | Liste: Gruppe zusammengefasst, Rest sichtbar, Stücke auswählbar | „Items": Kopfzeile „Group × 4 · 4 available", aufklappbar, „Select k" | Aufklappen per Maus, „Select 1" per Tastatur | PASS | p5-c1 | offen |
| 5.3 | Record Sale mit Mengenwahl und Preis je Stück | Gruppenblock im Dialog | „Pieces to sell" 1 → 2, „Price per piece" 450, Einkaufs-VAT, Confirm | PASS | p5-c2 | offen |
| 5.4 | Detail: Abschnitt „Group" | Primary-Detail | Seite öffnen | PASS | p5-d | offen |
| 5.5 | Rechnung 2b: Gruppe einmal in der Auswahl, je Stück eine Zeile | „group × 2 available", „Pieces on this invoice" | Gruppe wählen, Menge 2, Preis je Stück, Speichern | PASS | p5-e | offen |
| 5.6 | Korrektur je Stück (P4) | „Edit Invoice" | ein Stück entfernen, Speichern → nur dieses wieder verfügbar | PASS | p5-f | offen |
| 5.7 | Handy: Menge, Gruppenkarte, Teilverkauf | Handy-Seite §P5 | Menge 3, Gruppenkarte, „Pieces to sell" 2 → ein Auftrag mit `items[]` | PASS | p5-handy-* | offen |

**Bewusste Abweichungen vom P5-Preview** (Owner entscheidet):
- Preview-Variante „Preis für alle Stücke" nicht gebaut — D-P5-2 hat „je Stück" entschieden.
- Liste: statt Stepper in einer Spalte „Sell" ein Zahlenfeld „Select k of n" in der Spalte „Actions"; Kopfzeile „Group × N" statt „<Name> × N · group" (der Name steht in der Produktspalte).
- „Record Sale (n)" bleibt der vorhandene Knopf der Mehrfachauswahl.

## 5. Release-Korrekturen

| # | Befund | Korrektur | Beleg | Bild | Owner |
|---|---|---|---|---|---|
| R1 | „Pick product…" bei schon verkauftem/reserviertem eigenem Artikel im Änderungsmodus | Die Zeile zeigt ihren Artikel („on this invoice"); keine andere Zeile kann ihn wählen | P4 4.1 | p4-b1 | offen |
| R2 | PC2-Leiste „Unresolved saves" verdeckte „Save Invoice" bei 1400×900 | Platz am Seitenende in Höhe der Leiste; „Hide"/„Show"; Vorgänge bleiben bis zur Klärung | P5 H: ganz unten gescrollt liegt „Save Invoice" über der Leiste, echter Mausklick erreicht ihn; nach Neuladen noch da; „Clarify now" leert die Leiste | p5-h1, p5-h2 | offen |

## 5a. Margin VAT — eine Regel (VAT-CONSISTENCY, G4; Vertrag §2)

| # | Befund | Korrektur | Beleg | Owner |
|---|---|---|---|---|
| V1 | Record Sale und gemischte Rechnung rechneten die Margin VAT einer Kommission aus der Aufnahme-Schätzung (`products.purchase_price`, Prozent-Modell: Agreed × (1 − Satz)), der Wareneinsatz aber aus der Auszahlung. Folge: Hauptbuch ≠ NBR. | Basis = tatsächlicher Einkauf beim Einlieferer (`consignorLotCost`), in Haus, Vorschau 2b und „Record Sale"-Dialog | `test/vat` §2–§4, P3 B (Maske und Datenbank 21,818) | offen |
| V2 | Korrektur (P4) rechnete mit der Auszahlung brutto, das Anlegen mit der Schätzung; ein gewechselter Einstand ließ die VAT stehen | Neue und geänderte Zeilen aus dem Einstand nach den Einkäufen; unveränderte behalten ihre VAT, außer ihr Einstand ändert sich | `test/vat` §5, P4 | offen |
| V3 | Agent, Auftrag u. a. konnten eine VAT mit anderem Einstand als dem Los mitschicken | Das Haus setzt die Margin VAT aus dem gehaltenen Einstand (Anlegen, neue Zeile beim Ändern) | `test/vat` §7 | offen |
| V4 | Finanzauswertung „Total VAT" zählte die Margin VAT doppelt | Je Zeile dieselbe Formel wie NBR | `test/vat` §2/§3/§6; Bestand: 60 → 30 | offen |
| V5 | G4: Einkauf ohne abziehbare VAT | Basis = tatsächlich bezahlter Preis: 150/110 ⇒ 3,636 | `test/vat` §6 | entschieden (Owner, endgültig) |
| V6 | G4: Einkauf mit abziehbarer Vorsteuer 10 % | Basis = Nettoeinkauf, keine Bruttobasis: 150/100 ⇒ 4,545 (Vertrag §2) | `test/vat` §6 | entschieden (Owner, endgültig) |

## 6. Ergebnisse der Läufe (07.11.2026)

Alle E2E-Läufe streng nacheinander, jeder über `e2ePreflight` (Zeigerprüfung) im isolierten Testordner `com.lataif.app.e2e`; die Produktions-App lief daneben unberührt (nur in der Prozessliste beobachtet).

**VAT-CONSISTENCY (Bau 22:50, Margin VAT §5a):**

| Lauf | Ergebnis |
|---|---|
| `test/e2e-safety/data-root-isolation.e2e.mjs` (zuerst) | 6/0 |
| `mixed-invoice-p3` (neu: Maske und Datenbank 21,818) | 29/0 |
| `mixed-invoice-p4` | 37/0 |
| `consignment-quantities-p5` | 39/0 |
| `p1a-primary-edit` | 21/0 |
| `p1c-invoice-correction` | 31/0 |
| `test/vat/margin-vat-consistency.test.ts` (auf dem alten Stand `9caab992`: 27 rot) | 51/0 |
| Node-Gesamtlauf | 296/299. Nachgeprüft: `p2/e10-tax-choice` 42/0 (Erwartung der alten Schätzungsbasis auf G4 umgestellt), `e2e-safety/process-isolation` 44/0 (Pfadtext in `_e2e-preflight.mjs` entfernt). Offen: `e2e-binary-identity` (Release-Build) |

Die Handy-Seite rechnet keine Margin VAT selbst. Ihr Verkauf läuft über denselben Befehl `consignments.record_sale` wie PC2 (`test/vat` §2 pc2).

**Stand davor (Bau 20:48: Laufzeitsperre `e2e_assert_isolated_data_root` + Leisten-Knöpfe):**

| Lauf | Ergebnis |
|---|---|
| `test/e2e-safety/data-root-isolation.e2e.mjs` (zuerst; bei Rot keine weiteren Läufe) | 6/0 |
| Startprobe auf `lataif.db` aus `2026-11-07_nach-vorfall` (Release-Plan §8) | 18/0 |
| `data-root-move` | 55/0 |
| `p1a-primary-edit` | 21/0 |
| `p1c-invoice-correction` | 31/0 |
| `r7c-pending-saves` | 31/0 |
| `restore-safety` | 45/0 |
| `consignment-quantities-p5` (inkl. H: Leiste bei 1400×900) | 39/0 |

**Aus dem Bau 18:20 übernommen** (seitdem nur Startsperre und Stil der Leisten-Knöpfe geändert, beides oben abgedeckt; `InvoiceCreate.tsx` unverändert):

| Lauf | Ergebnis |
|---|---|
| `mixed-invoice-p3` | 28/0 |
| `mixed-invoice-p4` (inkl. R1) | 37/0 |
| `test/preg5/mobile-consignment-page.e2e.mjs` (inkl. E7 Handy, P5 Handy) | 97/0 |

**Node/Befehlsebene:** `test/p5/consignment-quantities.test.ts` 140/0 (inkl. §13 Versionswechsel), `test/e2e-safety/locator-isolation.test.ts` 21/0, `test/storage-perf/e2e-isolation-sweep.test.ts` 397/0 (99/99 Läufe isoliert). TS (`tsconfig.app.json`) sauber, Lint unverändert gegenüber v0.8.98, `cargo check` mit und ohne `e2e` ok.

**Noch offen, gehört zum Release-Gate:** `test/storage-perf/e2e-binary-identity.test.ts` braucht den Release-Build (jetzt 11/1 nur aus diesem Grund).

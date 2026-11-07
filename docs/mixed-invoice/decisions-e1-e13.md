> **Historische Entscheidungsunterlage (Stand 02.11.2026).** Die endgültigen Regeln stehen in `docs/mixed-invoice-contract.md`. Spätere Owner-Entscheidungen (E7 Option A, E5/E9 wie Custom-Order-Kosten, E12 Weg A) ersetzen die hier offenen Punkte. Pfadangaben beziehen sich auf den damaligen Stand.

# Mixed Own + Consignment Invoice — Read-only-Audit E1–E13

Stand 02.11.2026. Nur Prüfung, keine Code-, Schema-, Test- oder Preview-Änderung. Einzige neue Datei: dieser Bericht.

## 0. Baseline

| Punkt | Wert |
|---|---|
| Repo | `E:/software/lataif/desktop`, Branch `main` |
| HEAD = origin/main | `2f40d944` (repair detail: large item photo, compact voucher code) |
| Version | 0.8.96 (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) |
| Public Latest | GitHub Release `v0.8.96`, veröffentlicht 2026-11-01 18:36Z, Tag → `a5e3ed81` |
| Working Tree vorher | `?? docs/previews/` (Preview, ungetrackt) |
| Kanonische Doku | `docs/ai/acceptance-rules.md`, `docs/ai/upgrade-runbook.md` (keine Verträge zu Rechnung/Kommission) |

Beweisrangfolge: Code → Verhaltenstests → Git → docs/ai → Preview. Das Preview ist hier nur Vergleichsobjekt.

### Ausgeführte Tests (gezielt, vorhanden, keine Produktionsdaten)

| Test | Ergebnis |
|---|---|
| `test/invoice-edit/customer-change.test.ts` | 41/0 |
| `test/invoice-edit/edit-with-returns.test.ts` | 41/0 |
| `test/invoice-edit/full-correction.test.ts` | 22/0 |
| `test/invoice-edit/invoice-paid.test.ts` | 21/0 |
| `test/invoice-edit/line-identity.test.ts` | 44/0 |
| `test/invoice-edit/margin-vat.test.ts` | 30/0 |
| `test/invoice-edit/vat-period-lock.test.ts` | 75/0 |
| `test/consignment-multi-sale/d3-repayment.test.ts` | 39/0 |
| `test/consignment-multi-sale/multi-sale-d3.test.ts` | 157/0 |
| `test/consignment-integrity/consignment-integrity.test.ts` | 96/0 |
| `test/consignment/payout-model-edit.test.ts` | 110/0 |
| `test/r6f/consignment-parity.test.ts` | 454/0 |
| `test/lot-vat-cost/lot-vat-cost.test.ts` | 75/0 |
| **Summe** | **1205/0** |

Die Tests belegen das **heutige** Verhalten (u. a. die Sperren). Keiner prüft eine der neuen Anforderungen — die gibt es im Code noch nicht.

---

## 1. Der heutige Aufbau (tatsächliche Call-Paths)

**Neue Rechnung, eigene Ware:** `InvoiceCreate.tsx` → `createInvoiceOnPrimary` / `createInvoiceInHouse` (`src/core/invoices/invoice-create-house.ts:179,266`) → `useInvoiceStore.createDirectInvoice` (`src/stores/invoiceStore.ts:322-517`). Dort: `assertNoConsignmentGoods` (`:335`), Datumssperre `assertInvoiceDateNotInClosedVatQuarter` (`:344`), FIFO-Los + Einstand (`:369-398`), Summen + `'mixed'` (`:416-431`), Buchung `postInvoiceIssued` (`:495-513`).

**Kommissionsverkauf:** `ConsignmentSaleDialog.tsx` → `recordConsignmentSalesOnPrimary` (`src/core/consignment/consignment-finance-house.ts:232`, `runOnPrimary`, eine Transaktion) → `recordConsignmentSalesInHouse` (`:91-165`, Prüfung aus der DB je Filiale `:113-125`, `beforeWrite` `:134`) → `useConsignmentStore.recordSales` (`src/stores/consignmentStore.ts:490-726`):
1. Ökonomie je Artikel `computeConsignmentSale` (`src/core/consignment/economics.ts:45-79`), Floor-Bestätigung (`consignmentStore.ts:539-543`), Käufer ≠ Einlieferer (`:519-525`).
2. Je Einlieferer EIN Einkauf, Menge 1 je Zeile, Einkaufs-VAT Vorgabe `ZERO` (`:550`, `:553-562`, `:602-616`); bei Unterdeckung Einkauf = Verkaufspreis (`:584`).
3. EINE Rechnung über `createInvoiceInHouse` mit Erlaubnis nur für diese Artikel (`:648-655`, `withConsignmentSalePermit` `consignment-sale-link.ts:115-123`).
4. Verlust-Ausgabe `ConsignorLoss`, unbezahlt (`:664-680`); Kommission `sold` + `invoice_id` (`:683-690`); Produktmenge −1 (`:699-704`).

**Rechnung ändern:** `InvoiceDetail` → `useInvoiceStore.editInvoice` (`invoiceStore.ts:703-1260`); PC2: `invoices.update` (`src/core/bridge/invoice-lifecycle-commands.ts`, Pflicht `expectedRevision` `:89-97`, Vergleich `:210-221`). Eine Transaktion (`beginLedgerTransaction` `:856`): Gegenbuchung `reverseSource('INVOICE', id, now)` (`:861`), Kunde (`:794`, `:884`), Zeilenabgleich S2 (`:728-767`), Neubuchung (`:1083-1112`), Überzahlung → Kundenguthaben (`:1193-1230`), Revision + Audit (`:1232-1246`).

**Kommissionsrechnung ändern:** heute nur Steuerart, Brutto bleibt: `assertConsignmentSaleInvoiceEdit` (`src/core/consignment/consignment-sale-link.ts:170-211`; Kunde `:182`, Datum `:183`, Zeilen `:184-186`, Steuerart `:192-209`). Alles andere über „Cancel Sale" für den **ganzen** Verkauf (`consignment-reversal-house.ts:580-736`, Gruppe `:591`, Rechnungsstorno `:651-660`).

**Einlieferer-Seite:** abgeleitet, nie gespeichert (`src/core/consignment/consignor-side.ts:22-157`): Einkauf mit Kopfspalte `source_consignment_id` (`:29-44`), gemeinsamer Einkauf über Zeilenspalte (`:48-75`), offene Verlust-Ausgaben (`:76-87`), D3-Rückzahlungen (`:88-144`).

**Einkauf ändern:** `purchase-edit-house.ts` — Kommissions-Einkäufe gesperrt (`:36-38`, `:327-328`, `:1217-1220`, `:1318-1320`: „correct it through the consignment"). Einen solchen Weg gibt es aber nicht.

---

## 2. Matrix E1–E13

| ID | Bereits implementiert | Fehlend / Abweichung | Risiko | Beweis |
|---|---|---|---|---|
| E1 | Nichts. Rabatt = Preisänderung | Kein Feld trennt Rabatt und Preis; Auszahlung rechnet vom Verkaufspreis | Hoch | `schema.sql:220-232`, `edit-lines.ts:183`, `economics.ts:45-79` |
| E2 | D3: Rückzahlung „received"/„pending" (Lieferanten-Guthaben, verrechenbar); Überzahlung eines Einkaufs → Lieferanten-Guthaben | Nur bei Storno/Rückgabe, nicht bei einer Betragskorrektur; Kommissions-Einkauf nicht änderbar | Hoch | `consignment-reversal.ts:20-37`, `consignment-reversal-house.ts:296-348`, `purchase-overpay.ts:57,86`, `purchase-edit-house.ts:327-328` |
| E3 | Datum eigener Rechnungen änderbar (mit VAT-Prüfung) | Kommissionsrechnung: Datum gesperrt; kein Weg für das Einkaufsdatum | Mittel | `consignment-sale-link.ts:183`, `purchase-edit-house.ts:327-328` |
| E4 | Kundenwechsel S3/S5 vollständig (Zahlungen, Gutschriften, Guthaben, Sperren) für eigene Rechnungen | Kommissionsrechnung gesperrt; `consignments.buyer_id` zieht nicht mit; Buchung am Wechseltag (siehe W1) | Mittel | `customer-change.ts:9-27,125-271`, `consignment-sale-link.ts:182` |
| E5 | Echte Retoure je Kommission (Return after Sale, Zeile eines gemeinsamen Einkaufs); keine leere Rechnung | Einzelne Zeile entfernen nicht möglich; Cancel Sale nimmt den ganzen Verkauf | Hoch | `consignment-sale-link.ts:184-186`, `consignment-reversal-house.ts:591,651-660`, `invoiceStore.ts:716` |
| E6 | Gemeinsamer Einkauf mit Zeilenverknüpfung | Keine Zeile zu bestehendem Einkauf; keine Kommission im Edit | Hoch | `invoiceStore.ts:733`, `purchase-edit-house.ts:327-328`, `consignor-side.ts:29-44` |
| E7 | Provision vom Brutto vor VAT; VAT trägt LATAIF; Margin/VAT 10 %/Zero je Zeile wählbar | Keine Warnung, wenn die VAT die Provision übersteigt | Mittel (VAT 10 %) | `consignmentStore.ts:535,575-584`, `economics.ts:75-78`, `ConsignmentSaleDialog.tsx:123-124,297` |
| E8 | Sperre über Export-Fingerabdruck; Neuanlage im geschlossenen Quartal abgewiesen | Für neue Einkaufskorrekturen der Kommission noch keine Prüfung (es gibt den Weg nicht) | Niedrig | `vat-period-lock.ts:90-144,171-180`, `invoiceStore.ts:855,1103-1111` |
| E9 | Verlust-Ausgabe je Verkauf; bezahlter Verlust sperrt Storno | Kein Weg für Differenzen; Minderung eines bezahlten Verlusts ungeregelt | Hoch | `consignmentStore.ts:664-680`, `consignment-reversal-house.ts:278-283` |
| E10 | Vorgabe No VAT; eine Wahl je Einlieferer | Nach dem Verkauf gar nicht mehr änderbar (auch vor Auszahlung) | Mittel | `consignmentStore.ts:550,553-562`, `purchase-edit-house.ts:327-328` |
| E11 | Neubuchung auf Rechnungsdatum bei offenem Quartal | Gegenbuchung heute; Kundenwechsel und Einkaufskorrektur beide heute | Hoch (Widerspruch) | `invoiceStore.ts:861,1100-1111`, `posting.ts:577,1094-1183`, `purchase-edit-house.ts:25-27` |
| E12 | Nichts. Eine Kommission = ein Stück | Datenmodell ohne Menge; Los entsteht erst beim Verkauf mit Menge 1 | **Blocker** | `schema.sql:418-452`, `consignment-create.ts:127`, `consignmentStore.ts:610,699-704` |
| E13 | Rechnung ändern: ADMIN + MANAGER; Einkauf korrigieren: nur ADMIN | Wer ist „Admin"? Einkaufsseite heute nur Owner | Mittel | `usePermission.ts:12-14,32-33`, `command-permissions.ts:50,59,238` |

---

## 3. Befunde je Entscheidung

### E1 — Rabatt trägt nur LATAIF
- **Ist:** `invoice_lines` hat kein Rabattfeld (`schema.sql:220-232`; Zusatzspalten `database.ts:400,1293,2194,2199,2323-2327,2572`, keine davon Rabatt). `edit-lines.ts:183` sagt ausdrücklich: „ein Rabatt ist hier eine Preisänderung". Die Auszahlung rechnet vom Verkaufspreis (`consignmentStore.ts:535`). Auf Kommissionen steht genau ein Preis: `consignments.sale_price` („actual sale price", `schema.sql:441`).
- **Ohne Rabattfeld** gilt nach E7 jede Preissenkung als Senkung des Verkaufspreises. Die Auszahlung sinkt damit mit (percent, cost_split). E1 lässt sich deshalb nur umsetzen, wenn Rabatt und Preis getrennt gespeichert werden.
- **Vorhandene Strukturen reichen nicht ohne Bedeutungswechsel.** `consignments.sale_price` könnte die Basis für den Einlieferer tragen, die Rechnungszeile den rabattierten Betrag. Das ändert aber die Bedeutung eines bestehenden Feldes, das u. a. `payoutModelLock` (`payout-edit.ts:56`) und die Anzeigen lesen. Nachweis: Eine Schemaänderung (Rabatt je Zeile) oder ein Bedeutungswechsel ist unvermeidlich. Welcher Weg, ist offen.
- **Je Modell:**
  - **consignor_fixed:** Die Auszahlung ist ohnehin der vereinbarte Betrag (`economics.ts:50-59`), E1 ändert nichts.
  - **percent:** Auszahlung = (1−p) × Preis vor Rabatt.
  - **cost_split:** Auszahlung = Kosten + (1−s) × (Preis vor Rabatt − Kosten) (`economics.ts:62-73`).
- **Floor:** Heute prüft `belowFloor` den Verkaufspreis (`economics.ts:52,67`). Mit E1 folgt die Floor-Prüfung logisch dem Preis vor Rabatt. Ein Rabatt unter den vereinbarten Betrag ergäbe dann keinen Consignor Loss, sondern eine negative Marge bei LATAIF. **Offener Befund:** Wie und mit welcher Warnung wird das gebucht?
- **Steuer:** Bei Margin sinkt die Marge um den Rabatt (VAT auf die Marge ≥ 0, `vat-engine.ts:43-55`). Bei VAT 10 % sinkt die VAT mit dem Brutto.
- **Ungeklärt:** Steht der Rabatt auf Druck und NBR-Export? Der Export zeigt nur `line_total` (`nbr-export.ts:244-246`). Hinweis: `customer-settlement.ts:43` lässt Rabatt- und Erlassregeln für **nachträgliche** Forderungsminderungen auf den Buchhalter warten. Das ist ein anderer Fall als ein Rabatt beim Verkauf, aber zu prüfen.
- **Kleinste Änderung:** Rabattbetrag je Rechnungszeile speichern, die Ökonomie mit dem Preis vor Rabatt rufen. Neue Spalte = Schemaänderung, vorher Owner-Freigabe.

### E2 — Überzahlter Einlieferer: Rückforderung oder Verrechnung
- **Ist:** D3 kennt genau zwei Wege:
  - „received": Geld kam zurück.
  - „pending": Lieferanten-Guthaben, verrechenbar oder später als Eingang `supplier_credit_refunds` (`consignment-reversal.ts:20-37`, `consignment-reversal-house.ts:296-348`, Anzeige `consignor-side.ts:88-144`).

  Für normale Einkäufe macht `reconcilePurchaseOverpayCredit` aus einer Überzahlung Lieferanten-Guthaben (`purchase-overpay.ts:86`). Bestehende Zahlungen bleiben (D3-Kommentar `consignment-reversal.ts:26-27`).
- **Abbildung auf E2:**
  - „Verrechnung" = Lieferanten-Guthaben, mit einer späteren Einkaufszahlung (`method = 'credit'`) verrechnet.
  - „Rückforderung" = dasselbe Guthaben mit späterem Eingang.

  Beides gibt es als Struktur. Es fehlt der Auslöser: Eine Preis- oder Steuerkorrektur kann den Einkauf heute nicht mindern (`purchase-edit-house.ts:327-328`).
- **Wechselwirkung:** Ein mit Guthaben bezahlter Kommissions-Einkauf sperrt später Cancel Sale und Rückgabe (`CONSIGNOR_PAID_BY_CREDIT`, `consignment-reversal-house.ts:267-270`). Nach einer Verrechnung nach E2 wären also spätere Rücknahmen gesperrt. Das ist kein Fehler, muss aber in Preview und Umsetzung bewusst stehen.
- **Kleinste Änderung:** In der neuen Korrekturfolge (Paket P2) die Einkaufszeile mindern. Den Überschuss über den vorhandenen Guthabenweg buchen, Wahl Pflicht wie D3.

### E3 — Rechnungsdatum (bereits entschieden: unbezahlter Einkauf folgt, (teil)bezahlter behält sein Datum)
- **Ist:** Kommissionsrechnung: Datum gesperrt (`consignment-sale-link.ts:176-183`), weil Einkauf und Buchungen das Verkaufsdatum tragen (`consignmentStore.ts:604`). Eigene Rechnung: Datum änderbar; Neubuchung am neuen Datum, bei geschlossenem Quartal heute (`invoiceStore.ts:1107-1111`). Export-Fingerabdruck enthält `issued_at` (`vat-period-lock.ts:117-121`).
- **Technisch umsetzbar:** Unbezahlter Einkauf: Datum + Buchung neu (heute gibt es dafür nur den gesperrten Purchase-Edit; der bucht auf den Korrekturtag `purchase-edit-house.ts:25-27`, siehe W3). Bezahlter Einkauf: bleibt — keine Änderung nötig.
- **Sonderfall 1 — Rechnung wandert in ein anderes Quartal, bezahlter Einkauf bleibt:**
  - Der NBR-Monat einer FINAL-Rechnung ist der Tag der letzten Zahlung, nicht das Rechnungsdatum (`nbr-export.ts:62-76`). Die Datumsänderung verschiebt also im Export den Monat oft gar nicht, wohl aber Umsatz und Wareneinsatz im Hauptbuch (Neubuchung am Rechnungsdatum).
  - Die Vorsteuer des Einkaufs (nur bei Einlieferer VAT 10 %) bleibt im alten Quartal. Das ist fachlich vertretbar (Rechnung des Einlieferers), aber Verkauf und Einkauf stehen dann in verschiedenen Perioden.
  - **Befund**, keine neue Regel.
- **Sonderfall 2 — Rechnung vor das Datum des bezahlten Einkaufs:**
  - Der Wareneinsatz stünde vor dem Lagerzugang. Das Los entsteht am Einkaufsdatum (`consignmentStore.ts:588-590`), das Hauptbuch zeigte also zwischen beiden Tagen negatives Lager.
  - Ebenso möglich: ein Rechnungsdatum vor `consignments.agreement_date`, also ein Verkauf vor der Einlieferung.
  - **Befund**: Sperren oder zulassen ist eine Owner-Entscheidung. Heute gibt es keine Prüfung, weil der Fall gesperrt ist.
- **Kleinste Änderung:** In P2 das Datum der Kommissionszeilen freigeben. Unbezahlter Einkauf: Datum und Neubuchung nach E11. Für Sonderfall 2 eine Prüfung, wenn der Owner sie will.

### E4 — Kunde ändern
- **Ist:** S3/S5 bucht Zahlungen, Gutschriften, Retouren und Guthaben der Rechnung atomar um (`customer-change.ts:279ff`, in `editInvoice` `:884`). Gesperrt:
  - Guthaben, das anderweitig verwendet wurde (`:204-213`)
  - fremdes Guthaben (`:214-222`)
  - Rechnungen aus Auftrag oder Reparatur (`:172-180`)
  - eingereichte Quartale (`:186-201`)

  Mit Geldfluss ist eine ausdrückliche Bestätigung nötig (`:224-227`). Das deckt „fremde Guthaben und Rechnungen nicht verschieben" bereits ab. Test `customer-change.test.ts` 41/0.
- **Fehlt bei Kommissionsrechnungen:** Die Sperre `consignment-sale-link.ts:182` muss fallen. `consignments.buyer_id` muss mitziehen, und Käufer ≠ Einlieferer (`consignmentStore.ts:519-525`) muss für den **neuen** Kunden gelten. Bei gemischter Rechnung gilt das für jede Kommissionszeile.
- **Buchungsdatum:** Siehe W1. Der Vertrag bucht ausdrücklich auf den Wechseltag (`customer-change.ts:9-16`, `invoiceStore.ts:1100-1102`, festgehalten in `customer-change.test.ts:553`).

### E5 — Einzelne Kommissionszeile entfernen (Fehlerfassung → Active)
- **Ist:** Zeilen entfernen ist an Kommissionsrechnungen gesperrt (`consignment-sale-link.ts:184-186`). „Cancel Sale" nimmt die **ganze** Verkaufsgruppe samt Rechnung zurück (`consignment-reversal-house.ts:591,651-660`). Das widerspricht „übrige Positionen bleiben". Die echte Retoure ist bereits ein eigener Vorgang je Kommission (`returnConsignmentAfterSaleInHouse`, Zeilenretoure des gemeinsamen Einkaufs `pruefeEinlieferer(..., nurZeile)` `:248-289`, `einkaufZurueck(..., nurZeile)` `:296-324`). Eine leere Rechnung verhindert schon `editInvoice` (`invoiceStore.ts:716`).
- **Vorhandene Bausteine für „Zeile zurück":**
  - Einkaufszeile über die Zeilenretoure (`:303-324`), die zuerst den offenen Rest mindert.
  - Bezahlter Teil nach D3-Wahl.
  - Verlust-Ausgabe stornieren (`cancelConsignorLoss`).
  - Kommission zurücksetzen (`:696-703`).
  - Artikel zurück in den Kommissionsbestand (`:689-692`).

  Sperren wie heute: bezahlter Verlust (`:278-283`), mit Guthaben bezahlt (`:267-270`).
- **Kleinste Änderung:** In P2 eine Zeilenvariante der Cancel-Sale-Schritte, innerhalb der `editInvoice`-Transaktion.

### E6 — Zeile zum bestehenden unbezahlten Einkauf hinzufügen
- **Ist:** Im Edit kommt keine Kommissionsware neu auf eine Rechnung (`invoiceStore.ts:733`). Einkauf-Edit „Position nachtragen" gibt es (`purchase-edit-house.ts:19-20`), aber nicht für Kommissions-Einkäufe (`:327-328`).
- **Technische Falle:** Ein Einkauf mit **einer** Kommission trägt sie in der Kopfspalte `purchases.source_consignment_id` (`consignmentStore.ts:607`). `consignor-side.ts:29-44` rechnet solche Einkäufe ganz dieser einen Kommission zu; nur Einkäufe **ohne** Kopfspalte werden je Zeile verteilt (`:48-75`). Wer eine zweite Zeile anhängt, muss die Kopfspalte leeren, sonst zeigt die Einlieferer-Seite falsche offene Beträge. Gleiches prüfen in `zumVerkauf`/`consignorPurchases` der Rücknahme.
- **Bezahlt → separater Einkauf:** Strukturell unproblematisch (neuer Einkauf je `createPurchase`). Die Regel „eine VAT-Wahl je Einlieferer und Verkauf" (`consignmentStore.ts:553-562`) gilt dann je Einkauf.

### E7 — Provision vom vollen Preis vor VAT, VAT trägt LATAIF
- **Ist = E7:** Der Verkaufspreis im Dialog ist der Bruttopreis. Die Ökonomie rechnet damit (`consignmentStore.ts:535`); die Rechnungszeile wird für VAT 10 % auf netto zurückgerechnet (`:578`, `:633,638`). Steuerart je Zeile wählbar (`ConsignmentSaleDialog.tsx:297`, `consignment-finance.ts:37`).
- **VAT 10 %, getrennt gerechnet** (Brutto B, VAT = B/11 ≈ 9,09 % von B):
  - percent (Satz p): LATAIF = p·B − B/11 → **Verlust, sobald p < 9,09 %**.
  - consignor_fixed: LATAIF = B − Agreed − B/11 → Verlust, sobald der Überschuss unter B/11 liegt.
  - cost_split (Anteil s): LATAIF = s·(B − Kosten) − B/11 → Verlust häufig, wenn der Gewinn über den Kosten klein ist.
  - Der Dialog zeigt die VAT (`ConsignmentSaleDialog.tsx:123-124,289,320`), warnt aber nicht vor einem negativen Ergebnis. **Befund**, keine neue Mindestprovision.
- **Profit Margin, getrennt gerechnet:** Margin-VAT = max(0, B − Einstand)/11. Der Einstand ist das Los des Auto-Einkaufs = Auszahlung (`consignmentStore.ts:588-590`, `invoiceStore.ts:384-396`). Damit gilt VAT = Provision/11 und LATAIF = Provision × 10/11: kein Verlust, solange die Provision ≥ 0 ist.
  - Bei Unterdeckung ist der Einkauf = B (`consignmentStore.ts:584`), die Margin-VAT also 0.
  - **Abweichung:** Die Vorschau-VAT rechnet mit `purchasePrice = products.purchase_price || Auszahlung` (`:576`), die Rechnung danach mit dem Losstand (`invoiceStore.ts:394`), die gespeicherte VAT aber aus der Vorschau (`consignmentStore.ts:637`). Heute deckungsgleich, weil Kommissionsartikel mit `purchase_price = 0` angelegt werden (`:619-625`). Bei einem Artikel mit gesetztem Einkaufspreis wichen VAT-Betrag und Einstand der Zeile voneinander ab. **Niedrig**, aber in P1/P2 auf eine Quelle bringen.
- **Zero:** keine VAT.

### E8 — Eingereichte Quartale bleiben gesperrt
- **Ist = E8:**
  - Zu ist ein Quartal, wenn es eingereicht ODER bezahlt ist (`vat-period-lock.ts:52-64`).
  - Die Änderung wird über den Export-Fingerabdruck vorher/nachher geprüft (`:90-144`, `editInvoice` `:855` + Vergleich vor dem Commit).
  - Neuanlage im zugemachten Quartal wird abgewiesen (`:171-180`).
  - Buchungen eines zugemachten Quartals gehen auf heute (`invoiceStore.ts:1103-1111`).
  - Test `vat-period-lock.test.ts` 75/0. Kein Korrekturrechnungs-Workflow vorhanden, keiner nötig.
- **Für P2 zu ergänzen:** Einkaufsseitige Korrekturen der Kommission (Einlieferer-VAT 10 %) brauchen dieselbe Sperre. Vorbild: Einkauf-Edit sperrt Vorsteuer außerhalb des offenen Quartals (`purchase-edit-house.ts:36-37`).
- **Hinweis:** Das Quartal einer FINAL-Rechnung im Export ist das der Vollzahlung (`nbr-export.ts:62-76`), nicht das Rechnungsdatum. „VAT-Quartal der Rechnung" meint im Code also zwei Dinge: den Export (Zahlungsdatum) und das Hauptbuch (Rechnungsdatum, `invoiceStore.ts:1107-1110`).

### E9 — Bezahlte Verlust-Ausgabe bleibt, Differenzen getrennt
- **Ist:**
  - Je unterdecktem Verkauf eine `ConsignorLoss`-Ausgabe, unbezahlt (`consignmentStore.ts:664-680`).
  - Ist sie bezahlt, sperrt sie Storno und Rückgabe (`consignment-reversal-house.ts:278-283`).
  - Es gibt keinen Weg, sie anzupassen.
  - Bei Unterdeckung ist der Einkauf = Verkaufspreis (`consignmentStore.ts:584`). Eine Preisänderung ändert dann **zwei** Belege: Einkauf und Verlust.
- **Fehlt:** Eine zusätzliche Differenz als eigene Ausgabe (E9) ist technisch einfach (neue Ausgabe, gleiche Kategorie, Bezug zur Kommission). **Nicht geregelt** ist die Minderung, also eine Preiserhöhung nach bezahltem Verlust: Der Einlieferer hätte dann zu viel Verlustausgleich erhalten. E9 spricht nur von „zusätzlichen Differenzen". Offener Befund, gehört vermutlich zu E2 (Rückforderung/Verrechnung).

### E10 — Einkaufs-VAT: Vorgabe No VAT, vor erster Auszahlung änderbar
- **Ist:** Die Vorgabe `ZERO` (`consignmentStore.ts:550`) und eine Wahl je Einlieferer (`:553-562`) entsprechen E10. Nach dem Verkauf ist die Einkaufs-VAT **gar nicht** änderbar: Einkauf-Edit ist gesperrt, und `assertConsignmentSaleInvoiceEdit` betrifft nur die Verkaufssteuer. Damit ist die Sperre nach der Auszahlung erfüllt, die Änderbarkeit davor fehlt.
- **Steuerliche Unsicherheit:** Das Los aktiviert den Einstand **ohne** Vorsteuer (`purchaseStore.ts:461`). Bei Einlieferer-VAT 10 % und Verkauf im Margin-Schema rechnet die Marge gegen den Nettoeinstand, und die Vorsteuer wird abgezogen. Ob das Margin-Schema überhaupt gilt, wenn eine Vorsteuer abziehbar war, ist eine **Rechtsfrage für den Buchhalter**. Der Code entscheidet sie nicht.

### E11 — Korrekturen auf das ursprüngliche Rechnungsdatum, Änderungsdatum auditieren
- **Ist, belegt:**
  - Neubuchung am Rechnungsdatum (`invoiceStore.ts:1111` → `posting.ts:577`, Standard `invoice.issuedAt`), **Gegenbuchung aber heute** (`invoiceStore.ts:861` → `reverseSourceOnce` schreibt `occurred_at = occurredAt` = jetzt, `posting.ts:1149-1179`).
  - Folge im Hauptbuch: Zwischen Rechnungsdatum und Korrekturtag stehen Original und Neubuchung **beide**, die Gegenbuchung erst im Korrekturmonat. Datumsbezogene Auswertungen (`ledger-statements.ts:69,233-236`) zeigen für die alte Periode doppelte Werte und im Korrekturmonat einen Gegenposten.
  - Die VAT-Erklärung ist nicht betroffen; sie liest Rechnungen, nicht das Hauptbuch (`vat-quarter-overview.ts:61,70`).
  - Kein Test prüft diese Periodenwirkung (die Tests prüfen Summen bis zu Stichtagen, `full-correction.test.ts:225-243`).
- **Kundenwechsel:** beide Seiten heute (W1). **Einkaufskorrektur:** beide Seiten heute (`purchase-edit-house.ts:25-27`, W3).
- **Audit des Änderungsdatums:** vorhanden (`invoice_edits.edited_at`, `audit_log`, `invoiceStore.ts:1232-1246`).
- **Kleinste Änderung, wenn E11 wörtlich gilt:** `reverseSource('INVOICE', id, <Rechnungsdatum>)` bei offenem Quartal ohne Kundenwechsel. Das ändert einen bestehenden Vertrag („Regel 1") und verlangt einen Regressionstest. **Vorher Owner-Freigabe** (W2).

### E12 — Mengen und Teilverkäufe
**Nachweis, dass das heutige Modell Einzelstück ist:**
- `consignments` hat keine Menge. `sale_price`, `buyer_id`, `invoice_id`, `payout_amount`, `payout_paid_amount`, `status` stehen je **eine** einmal (`schema.sql:418-452`, `rowToConsignment` `consignmentStore.ts:216-250`).
- Der Artikel einer Kommission entsteht mit Menge 1 (`consignment-create.ts:127`).
- Verkauf nur aus `active` (`consignmentStore.ts:509`), danach `sold` + `invoice_id` (`:683-690`). Eine zweite Rechnung ist ausgeschlossen (`consignment-finance-house.ts:119-121`).
- Einkaufszeile Menge 1 (`consignmentStore.ts:610`). Das Los entsteht **erst beim Verkauf** und wird sofort verbraucht (`:588-590`). Vorher hat Kommissionsware kein Los.
- Zuordnung Rechnungszeile → Kommission über (Rechnung, Artikel), höchstens eine (`consignment-sale-link.ts:5-14,94-107`). Derselbe Artikel zweimal auf einer Rechnung ist verboten (`consignmentStore.ts:505-508`).
- **Doppelter Effekt bei Menge > 1:** Die Rechnung nimmt Bestand (`invoiceStore.ts:456,475`) und gleicht die Menge aus den Losen ab (`lot-queries.ts:239-253`). Danach zieht `recordSales` die Menge **noch einmal** um 1 ab (`consignmentStore.ts:699-704`). Bei Menge 1 harmlos, bei Teilverkäufen falsch.
- Agreed, Floor und Kosten sind ein Betrag je Kommission. Ob er je Stück oder gesamt gilt, ist nicht definiert.
- Cancel Sale und Rückgabe arbeiten je Kommission bzw. je ganzer Gruppe (`consignment-reversal-house.ts:580-736`).

**Folge:** E12 braucht ein neues Datenmodell, etwa eine Tabelle der Verkaufsmengen je Kommission oder Mengenfelder, Lose ab Einlieferung oder je Teilverkauf, und eine Migration aller Einzelstück-Datensätze auf Menge 1 ohne Verlust. Nötig: Schemaänderung, Anpassung aller Konsumenten (Einlieferer-Seite, Rücknahme, Payout-Sperre, Mobile `preg5/mobile-consignment`) und Race-Schutz. Der Verkauf läuft heute exklusiv am Primary mit Revision (`consignment-finance-house.ts:134,232`); Teilmengen brauchen dieselbe Exklusivität für die Reservierung (Bezug F7 Doppelverkauf).
- **Bewertung:** eigenes Paket, nicht Teil des Mixed-Invoice-Kerns. Architektur wird hier bewusst nicht festgelegt.

### E13 — Owner und Admin dürfen bestätigen
- **Ist:**
  - Im Code heißt „Owner" die Rolle `ADMIN`, „isAdmin" heißt `ADMIN` oder `MANAGER` (`usePermission.ts:12-14`).
  - Rechnung ändern: isAdmin (`usePermission.ts:32`, `command-permissions.ts:50,59`).
  - Kommission verkaufen und stornieren: isAdmin (`command-permissions.ts:91-95,251-252`).
  - Einkauf korrigieren: **nur Owner** (`:238`).
  - Retouren-Storno: Owner (`consignment-reversal-house.ts:640`, `cancelReturnInHouse`).
- **Prüfstelle:** PC2-Aufträge werden zentral vor dem Handler geprüft (`command-permissions.ts:16-19`). Am Primary prüft nur die Oberfläche; die Domainfunktionen (`editInvoice`, `recordSales`) prüfen keine Rolle.
- **Offen:** Ist „Admin" in E13 die Rolle `MANAGER`? Dann passt die Rechnungsseite. Eine Korrektur, die den Einlieferer-Einkauf ändert, fiele aber unter eine Regel, die heute nur der Owner hat. Das muss für P2 ausdrücklich festgelegt werden.

---

## 4. Zusätzliche Anforderungen (nicht nummeriert)

| Anforderung | Ist | Abweichung | Beweis |
|---|---|---|---|
| Steuerart je Position | Vorhanden: `invoice_lines.tax_scheme`, Kopf `'mixed'`, Formular je Zeile | — | `schema.sql:228`, `invoiceStore.ts:429-431`, `InvoiceCreate.tsx:44,63` |
| Steuerartwechsel: Brutto und Einliefererbetrag bleiben | Für Kommissionszeilen erzwungen | Für eigene Zeilen nicht im Haus erzwungen (rechnet aus dem Nettopreis neu, `edit-lines.ts:243-244`); ob die Maske das Brutto hält, **ungeprüft** | `consignment-sale-link.ts:192-209` |
| Margin-Basis eigene Ware aus gespeichertem Einstand, sonst blockieren | Basis = Los `unit_cost`, sonst `products.purchase_price`, sonst 0 | **Keine Sperre**: Margin mit Basis 0 wird gespeichert. Altbestand/New Collection hat den Einstand nur am Artikel (Regel „nie Geld", kein Einkaufsbeleg) — eine Sperre „nur mit Einkaufsbeleg" sperrte allen Altbestand | `InvoiceCreate.tsx:315`, `invoiceStore.ts:384-396` |
| Kundenüberzahlung: Wahl Guthaben oder Rückzahlung | Überschuss wird automatisch Kundenguthaben; Auszahlung nur getrennt (Refund-UI) | Wahl im Edit fehlt | `invoiceStore.ts:1193-1230` |
| Retouren: nur verbleibende Mengen korrigieren | Retournierte Zeile: Menge ≥ Retourenmenge, **Preis der ganzen Zeile gesperrt** | Strenger als gefordert: auch die nicht retournierten Stücke dieser Zeile sind preisgesperrt (bräuchte eine Zeilenteilung) | `edit-lines.ts:168-198` |
| Begründung und Historie | Pflichtgrund, `invoice_edits` vorher/nachher, `audit_log` | Kommissions- und Einkaufsfolgen brauchen eigene Einträge (Muster `logAuditOrThrow` in der Rücknahme) | `invoiceStore.ts:718-720,1232-1246`, `consignment-reversal-house.ts:708-723` |

---

## 5. Pflichtprüfung D — Sicherheit und Konsistenz

| Punkt | Befund | Beweis |
|---|---|---|
| Atomar / Rollback | `editInvoice` ist eine Transaktion; Kommissionsverkauf und Rücknahme laufen exklusiv in einer Klammer, die Hausfolgen öffnen nie selbst | `invoiceStore.ts:856`, `consignment-finance-house.ts:227-234`, `consignment-reversal-house.ts:37-38` |
| Doppelte Effekte | Doppelabzug der Menge bei Menge > 1 (E12). Sonst sind Gegen- und Neubuchung je Quelle einmalig (`hasReversalFor`) | `consignmentStore.ts:699-704`, `posting.ts:1113-1115` |
| Idempotenz / verlorene Antwort | Befehlsprotokoll mit Wiederholung | `command-ledger.ts:92-122` |
| Veralteter Stand | `invoices.update` verlangt `expectedRevision`; Kommission und Einkauf haben `revision`. Eine kombinierte Korrektur muss **alle** gesehenen Fassungen prüfen (Rechnung, jede Kommission, jeder Einkauf) | `invoice-lifecycle-commands.ts:89-97,210-221`, `database.ts:1721,1759,2032` |
| VAT-Sperren | siehe E8 | `vat-period-lock.ts` |
| Filiale | Kommissionswege filtern `branch_id` | `consignment-finance-house.ts:113,123`, `consignment-sale-link.ts:94-101` |
| Rechte | PC2 zentral geprüft, Primary nur Oberfläche | `command-permissions.ts:16-19` |
| Historie / Zahlungen / Retouren | Storno statt Löschen, Zahlungen bleiben Zeilen, Retourenzeilen behalten ihre ID | `consignment-reversal-house.ts:23-38`, `invoiceStore.ts:722-727` |

---

## 6. Ergebnis

### 6.1 Kritische technische Blocker
1. **E12:** Das Datenmodell ist Einzelstück. Ohne Schemaänderung und Migration gibt es keine Teilverkäufe (§3 E12).
2. **Keine Korrekturfolge für den Kommissionsverkauf:** Kommissions-Einkauf und Kommissionsrechnung sind heute beide gesperrt („über die Kommission korrigieren"), und diesen Weg gibt es nicht. E2, E3, E4, E5, E6, E9 und E10 hängen alle an einer neuen Hausfolge, die Rechnung, Einkauf, Verlust und Kommission in **einer** Transaktion ändert.
3. **E1:** Kein Datenfeld trennt Rabatt und Preis. Nötig sind eine neue Spalte oder ein Bedeutungswechsel von `consignments.sale_price` (§3 E1).

### 6.2 Widersprüche zwischen Entscheidungen und Code (zur Entscheidung)
- **W1 E11 ↔ E4:** Der Kundenwechsel bucht vertraglich auf den Wechseltag (`customer-change.ts:9-16`, Test `customer-change.test.ts:553`). Gilt E11 für den Kundenwechsel, oder bleibt E4 der Sondervertrag?
- **W2 E11 ↔ Rechnungskorrektur:** Die Neubuchung steht am Rechnungsdatum, die Gegenbuchung heute (`invoiceStore.ts:861` vs. `:1111`). Soll auch die Gegenbuchung aufs Rechnungsdatum?
- **W3 E11 ↔ Einkaufskorrektur:** Einkäufe werden auf den Korrekturtag korrigiert, keine Rückdatierung (`purchase-edit-house.ts:25-27`). Gilt E11 auch für den Einlieferer-Einkauf?
- **W4 E13 ↔ Rollen:** Welche Rolle ist „Admin"? Einkaufskorrektur ist heute nur Owner (`command-permissions.ts:238`).
- **W5 Retouren:** Der Code sperrt den Preis der ganzen retournierten Zeile. Gefordert ist nur der Schutz der retournierten Menge (`edit-lines.ts:183-191`).
- **W6 E12 ↔ Integritätsvertrag:** „Ein Verkauf = eine Kommission; (Rechnung, Artikel) → höchstens eine Kommission" (`consignment-sale-link.ts:5-14`).
- **W7 Margin-Basis ↔ Altbestand:** Was als „gespeicherter Einkauf" zählt, muss den Einstand am Artikel einschließen, sonst ist Altbestand unverkäuflich im Margin-Schema.

### 6.3 Ungeklärte Geschäftsregeln (nur Befunde)
- **E1:** Rabatt unter dem vereinbarten Betrag: Buchung und Warnung für die negative LATAIF-Marge. Rabatt auf Druck und Export?
- **E3:** Rechnungsdatum vor dem bezahlten Einkauf oder vor dem Einlieferungsdatum: sperren oder zulassen?
- **E7:** Warnung bei VAT 10 %, wenn die VAT die Provision übersteigt?
- **E9:** Minderung eines schon bezahlten Verlustausgleichs?
- **E10:** Margin-Schema nach VAT-Rechnung des Einlieferers (Rechtsfrage, Buchhalter).
- **E2:** Eine Verrechnung per Guthaben sperrt spätere Rücknahmen (`CONSIGNOR_PAID_BY_CREDIT`). Bewusst so?

### 6.4 Verträge, die unverändert bleiben müssen
- `computeConsignmentSale` als **einzige** Ökonomie für percent / consignor_fixed / cost_split (`economics.ts:1-10`). Keine zweite Rechnung.
- Payout-Modell gesperrt nach Buchung (`payout-edit.ts:49-60`).
- Kommissionsware nie am Kommissionsweg vorbei (`assertNoConsignmentGoods`, Erlaubnis nur im Verkaufsweg).
- Käufer ≠ Einlieferer; Floor-Bestätigung je Artikel.
- D3-Rückzahlungswege und Sperren (bezahlter Verlust, Guthabenzahlung, Altweg).
- S2 (Zeilen behalten ID, Los, Einstand; Retourensperren), S3/S5-Kundenwechsel samt Sperren.
- VAT-Periodensperre über den Export-Fingerabdruck; Neuanlage im geschlossenen Quartal abgewiesen.
- Pflichtgrund, `invoice_edits`, `audit_log`; Storno statt Löschen.
- PC2: `expectedRevision`, zentrale Rechteprüfung, Befehlsprotokoll.
- Einlieferer-Seite nur abgeleitet (`consignor-side.ts`), nie gespeichert.

### 6.5 Empfohlene Reihenfolge
| Paket | Inhalt | Voraussetzung |
|---|---|---|
| P0 | Owner klärt W1–W4 und die offenen Punkte in 6.3; Preview angleichen (siehe 7) und neu abnehmen | — |
| P1 | Neue gemischte Rechnung: eigene + Kommissionszeilen in **einer** Rechnung, gebaut auf `recordSales` (Einkauf je Einlieferer, Floor, VAT-Wahl), Steuer je Zeile, ohne Rabatt und mit Menge 1 | P0 |
| P2 | Korrekturfolge Kommissionszeilen im Edit (Preis, Steuer, Kunde, Datum, Zeile entfernen/hinzufügen, Einkaufs-VAT vor Auszahlung, Überzahlung E2, Verlust E9, Buchungsdatum E11, Rechte E13), eine Transaktion, alle Revisionen | P1 |
| P3 | E1 Rabatt (Datenfeld, Ökonomie mit Preis vor Rabatt, Anzeige, Druck) | P0-Entscheidung Schema |
| P4 | Kundenüberzahlung mit Wahl; Retouren-Zeilenteilung, falls gewünscht (W5); Margin-Basis-Sperre nach W7 | P0 |
| P5 | E12 Mengen und Teilverkäufe (Schema, Migration, Lose, Race-Schutz, Mobile) | eigenes Audit + Preview |

### 6.6 Testmatrix (gezielt)
| Paket | Neue Prüfungen | Vorhandene Gates, die grün bleiben |
|---|---|---|
| P1 | gemischte Rechnung: Summen, ein Einkauf je Einlieferer, VAT je Zeile, Floor-Ack, Käufer ≠ Einlieferer, Zahlungen, Rollback bei Fehler, PC2 = Primary | `consignment-multi-sale/*`, `consignment-integrity`, `invoice-edit/line-identity`, `lot-vat-cost` |
| P2 | je E2/E3/E4/E5/E6/E9/E10/E11 ein Fall unbezahlt + ein Fall (teil)bezahlt; E3-Sonderfälle; E6-Kopfspalte; veraltete Revision; Quartal zu; Rolle | `invoice-edit/*` (7), `r6f/consignment-parity`, `consignment-multi-sale/d3-repayment` |
| P3 | percent/cost_split mit Rabatt, consignor_fixed unverändert, Floor, Margin- und VAT-10-Steuer | `consignment/payout-model-edit`, `invoice-edit/margin-vat` |
| P4 | Wahl Guthaben/Rückzahlung, Teilretoure | `invoice-edit/edit-with-returns`, `invoice-edit/full-correction` |
| alle | echte Test-App mit Maus/Tastatur gegen das freigegebene Preview (`docs/ai/acceptance-rules.md`) | — |

### 6.7 Belegt vs. ungeprüft
**Belegt (Code gelesen, Zeilen oben):** alle Matrixzeilen E1–E13, die Abweichungen in §4, D-Punkte außer den unten genannten, 1205/0 in den 13 Tests.

**Ungeprüft:**
- ob die Rechnungsmaske beim Steuerartwechsel einer eigenen Zeile Brutto oder Netto hält;
- Verschachtelung von `beginLedgerTransaction` (in `editInvoice`) mit einer äußeren `runOnPrimary`-Klammer für eine kombinierte Folge;
- ob `editInvoice` am Primary die Filiale per SQL prüft (es liest die Rechnung aus dem geladenen Store, `invoiceStore.ts:713`);
- Revisionsvergleich der Primary-Maske (belegt nur für PC2);
- Periodenwirkung von W2 in konkreten Berichten (nur aus dem Buchungsdatum abgeleitet, kein Test);
- Mobile-Wege der Kommission (`test/preg5/mobile-consignment.test.ts` nicht ausgeführt).

---

## 7. Preview-Abweichungen zu den Owner-Entscheidungen
Preview `docs/previews/mixed-invoice-preview.html` (nicht verändert):

| Punkt | Preview | Entscheidung |
|---|---|---|
| E1 | Vorgabe „Rabatt folgt Modell" (`S.discountRule = 'shared'`, Zeile 247) | Nur LATAIF trägt den Rabatt |
| E6 | hängt auch an einen **bezahlten** Einkauf an (`saveEdit`, Zeilen 488-491) | bezahlt → separater Einkauf |
| E9 | keine Verlust-Ausgabe modelliert | bezahlte bleibt, Differenz getrennt |
| E12 | Menge fest 1 (Zeile 1035) | Mengen und Teilverkäufe |
| E13 | ausgezahlter Einlieferer: nur Owner | Owner und Admin |
| Kundenüberzahlung | automatisch Kundenguthaben | Wahl Guthaben oder Rückzahlung |
| Retouren | nur ganze retournierte Zeile (Demo) | nur retournierte Menge geschützt |
| E3, E5, E10 | stimmen (Einkauf folgt nur unbezahlt; Zeile → Active; VAT-Sperre nach Auszahlung, Zeilen 701-706) | — |

---

## 8. Git-Zustand
- **Vorher:** HEAD = origin/main `2f40d944`, `?? docs/previews/`.
- **Nachher:** HEAD unverändert `2f40d944`. Ungetrackt sind `docs/previews/` (unverändert) und `docs/ai/audits/mixed-invoice-e1-e13.md` (neu). Kein Commit, Push, Tag oder Release. Die Tests haben keine Dateien im Repo hinterlassen.

`MIXED_INVOICE_E1_E13_AUDIT_COMPLETE`

---

# 9. Technischer Nachaudit (02.11.2026)

Grundlage: die endgültigen Owner-Entscheidungen. E1 ist zurückgestellt. W1 = Option A: Rechnung und jede Zahlung rückwirkend auf ihr eigenes Datum. E10 Fall A/B gilt für Eigenware und Kommission. E13: ADMIN und MANAGER. Gemischte Rechnung anlegen: nur ADMIN/MANAGER. Abschnitte 0–8 bleiben als Erstbefund stehen. W1–W4 aus 6.2 sind damit entschieden.

**Git vorher:** HEAD = origin/main `2f40d944`; ungetrackt `docs/ai/audits/mixed-invoice-e1-e13.md`, `docs/previews/mixed-invoice-preview.html`.

**Nachweise:**
- Code gelesen.
- Zusätzlich vorhandene Tests: `test/preg5/mobile-consignment.test.ts` 107/0, `test/purchase-edit/purchase-edit.test.ts` 188/0.
- Ein **temporäres Prüfskript** außerhalb des Repos (Scratchpad, sql.js im Speicher, Testaufbau wörtlich nach `test/invoice-edit/full-correction.test.ts`, echter Produktionscode). Danach gelöscht. „Heute" im Lauf = 2026-11-02 (Q4).

Kombinierte Korrekturwege gibt es nicht. Was unten „bewiesen" heißt, betrifft ausschließlich vorhandene Bausteine.

## 9.1 Ergebnis der sieben Nachprüfungen

### N1 — Steuerartwechsel eigener Zeilen: Brutto bleibt **nicht** erhalten (bewiesen, Code)
- **Maske:** Der Steuerart-Wechsel setzt nur `scheme` (`InvoiceCreate.tsx:807-808` → `updateLine` `:370-372`). Gespeichert bleibt der Nettopreis `unitPrice`. Das Brutto wird neu gerechnet (`calcLine` `:323`). Nur wer das Brutto-Feld tippt, rechnet auf netto zurück (`:833-841`, `unitNetFromGross` `:101-104`).
  - MARGIN → VAT 10 %: Brutto +10 %.
  - VAT 10 % → MARGIN: Brutto −9,09 %.
- **Haus:** `keptLineAmounts` rechnet eine geänderte Zeile aus dem geschickten Nettopreis (`edit-lines.ts:239-244`). Für Kommissionszeilen wird das Brutto dagegen erzwungen (`consignment-sale-link.ts:192-209`).
- **Soll laut Owner:** Brutto bleibt. **Kleinste Änderung:** Beim Wechsel aus dem bisherigen Brutto neu auf netto rechnen (Maske), und im Haus dieselbe Regel wie bei Kommissionszeilen.

### N2 — Verschachtelte Transaktionen: atomar nur, solange Fehler durchgereicht werden (bewiesen, Prüfskript)
- **Aufbau:** `runOnPrimary` = `runExclusive` + `beginLedgerTransaction` … `commit`/`rollback` (`primary-action.ts:18-34`). Verschachtelung zählt die Tiefe; nur die äußerste Ebene committet (`posting.ts:276-312`, `transaction-context.ts:40-58`). **Jedes** `rollbackLedgerTransaction` setzt die Tiefe auf 0 und rollt die **ganze** äußere Transaktion zurück (`posting.ts:314-324`, `transaction-context.ts:80-83`). `editInvoice` tut genau das in seinem `catch` (`invoiceStore.ts:1263-1272`).
- **Prüfskript P4a:** `editInvoice` gelingt, danach wirft die äußere Folge → Brutto zurück auf 1100, 0 `invoice_edits`. **Rollback vollständig.**
- **Prüfskript P4b:** `editInvoice` wirft in seiner Transaktion (VAT-Sperre), die äußere Folge **fängt** den Fehler und schreibt weiter. Ergebnis:
  - Tiefe danach 0.
  - Der folgende Schreibzugriff landet **ohne Transaktion** in der Datenbank und bleibt stehen.
  - Das äußere Commit wirft `leaveNestedTransaction: no active transaction`.

  **Teilzustand bewiesen.**
- **Zusatz:** `editInvoice` meldet `invoice.paid` nach seinem inneren „Commit" (`invoiceStore.ts:1274-1278`), auch wenn die äußere Folge danach noch zurückrollt. Handler-Folgen dieses Falls sind **ungeprüft**.
- **Regel für P1/P4:** Fehler einer Hausfolge nie fangen und weiterschreiben. Besser: `editInvoice` als Hausfolge ohne eigenes Begin/Rollback, wenn es geschachtelt läuft.

### N3 — Filial-/Tenant-Prüfung: nur implizit (belegt, Code)
- **Primary:** `editInvoice` liest die Rechnung aus dem Store (`invoiceStore.ts:713`). Der lädt nur die Filiale der Sitzung (`loadInvoicesFor` `:2086-2087`). Eine fremde Rechnung wäre „not found". Es gibt keine SQL-Prüfung im Schreibweg.
- **PC2:** `invoices.update` liest die Fassung **ohne** Filiale (`invoice-lifecycle-commands.ts:210`) und ruft dann denselben Store-Weg (`:253-261`).
- **Tenant:** kein Mandantenmerkmal im Rechnungsweg (Hauptbuch `tenant_id = NULL`, `posting.ts:1173`).
- **Vorbild für neue Folgen:** Die Kommissionswege filtern ausdrücklich `branch_id` (`consignment-finance-house.ts:113,123`, `consignment-sale-link.ts:94-101`).
- **Bewertung:** Niedrig (eine Filiale). Neue Folgen prüfen die Filiale ausdrücklich.

### N4 — Revisionsschutz: PC2 ja, Primary nein, kombiniert nicht vorhanden (belegt, Code)
- **Fassungen:** Datenbank-Trigger erhöhen `revision` bei jedem UPDATE auf `invoices`, `consignments`, `purchases` (`database.ts:1721-1736,1759-1767,2032-2040`). Zahlungen und Zeilen ändern den Kopf mit (Summen, `paid_amount`).
- **PC2:**
  - Rechnung: `expectedRevision` Pflicht, Vergleich in der Transaktion (`invoice-lifecycle-commands.ts:89-97,210-221`).
  - Kommission: Fassung im Rumpf (`mobile_consignment_commands.js:202,217`), geprüft in `beforeWrite` (`consignment-finance-house.ts:134`).
  - Einkauf: `assertSeen` (`purchase-edit-house.ts:1213`).
- **Primary:**
  - Die Maske ruft `editInvoice` direkt (`InvoiceCreate.tsx:536`). Die Fassung wird nur für PC2 verlangt (`:503-506`).
  - Kein `runExclusive`: Ein Fernauftrag darf innerhalb seiner Transaktion warten (`mutation-engine.ts:110-118,136-152`). Ein Primary-Edit in diese Wartezeit liefe in dessen Transaktion mit. Das ist aus dem Code abgeleitet, **im Lauf ungeprüft**.
  - Ein Speichern auf veraltetem Stand überschreibt eine PC2-Änderung still.
- **Kombiniert:** Eine Auszahlung an den Einlieferer ändert die Fassung des **Einkaufs**, nicht die der Rechnung. Eine gemischte Korrektur muss daher die Fassungen von Rechnung, jeder Kommission und jedem verknüpften Einkauf prüfen. Heute verbindet nichts diese Fassungen.

### N5 — E11/W1/E3: tatsächliche Periodenwirkung (bewiesen, Prüfskript)
- **P1 — Preiskorrektur einer Rechnung vom 15.08. (Q3 offen) am 02.11.** Forderungsbuchungen danach:
  - 15.08. +1100 (Original)
  - 15.08. +990 (Neubuchung)
  - 02.11. −1100 (Gegenbuchung)

  **Stichtagsliste 30.09. (`trialBalanceAt`, `ledger-statements.ts:75`): Forderung vorher 1100, nachher 2090.** Heute 990. Jeder historische Saldo zwischen Rechnungsdatum und Korrekturtag ist dauerhaft überhöht. Das betrifft bereits jede heutige Korrektur einer früher datierten Rechnung, also auch vorhandene Produktionsdaten. Nicht geprüft, keine Produktionsdaten gelesen.
- **Ursache:** Die Gegenbuchung nimmt **ein** Datum für alle Beine (`reverseSource(…, now)`, `invoiceStore.ts:861`, `posting.ts:1149-1179`). Die Neubuchung nimmt das Rechnungsdatum (`posting.ts:577`).
- **Falle für E11:** Nicht jedes Bein der Quelle `INVOICE` steht am Rechnungsdatum. Die Überzahlungs-Gutschrift eines früheren Edits wird am Edit-Tag unter `INVOICE` gebucht (`invoiceStore.ts:1196-1199,1222`). Eine Gegenbuchung „alles aufs Rechnungsdatum" verschöbe dieses Bein. **Richtig:** Jedes Bein spiegelt auf seinem **eigenen** `occurred_at`, sofern dessen Quartal offen ist. Kleinste Änderung: Option in `reverseSource`.
- **P2 — W1, Teilzahlung 20.08. im eingereichten Q3, Restzahlung 20.10., Rechnung FINAL in Q4:**
  - Der Kundenwechsel ist **heute erlaubt**.
  - Alle Zahlungsbuchungen werden am 02.11. umgebucht.
  - `planCustomerChange` prüft nur das Quartal der Vollzahlung und der Gutschriften (`customer-change.ts:186-201`), nicht das Quartal jeder einzelnen Zahlung.
  - Mit Option A läge die Umbuchung der 500-BHD-Zahlung im zugemachten Q3. Nach Owner-Regel **blockieren**. Dafür ist eine neue Prüfung je betroffenem Buchungsdatum nötig.
- **P3 — E3:**
  - Neuanlage mit Datum im zugemachten Q3 wird abgewiesen (`vat-period-lock.ts:171-180`).
  - **Aber:** Der Edit einer **unbezahlten** Rechnung von Q4 in das zugemachte Q3 wird angenommen (`issued_at = 2026-08-10`, Buchung auf heute), weil die Sperre nur beim Anlegen steht (`invoiceStore.ts:344`) und der Fingerabdruck nur FINAL-Rechnungen kennt (`vat-period-lock.ts:94`). Widerspricht E8 „keine Umgehung".
  - Umgekehrt (Q3 zu → Q4): Original 15.08. bleibt, Gegenbuchung heute, Neubuchung am neuen Datum 25.10.
- **Eröffnungsstichtag:** `OPENING_CUTOFF_DATE = 2026-10-15` (`opening-balances.ts:38`). Rückwirkende Buchungen vor diesem Tag ändern die Stichtagsliste, auf der die Eröffnung aufsetzt. Der Einkauf-Edit sperrt Vorgänge vor dem Stichtag (`purchase-edit-house.ts:1225-1228`, Kopf `:36-37`). `editInvoice` und der Kundenwechsel tun es nicht. Siehe O1.

### N6 — E12 Mobile (belegt, Code + Test 107/0)
- **Rümpfe:**
  - Das Telefon stellt `consignments.create`, `.update`, `.record_sale`, `.record_payout` und Rückgabe als Fernauftrag.
  - Der Anlege-Rumpf darf **keine Menge** tragen; der Test erzwingt das (`test/preg5/mobile-consignment.test.ts:101`).
  - Der Verkaufsrumpf hat eine Kommission, keine Menge, keine Steuerart und keine Einlieferer-VAT (`mobile_consignment_commands.js:194-208`). Es gelten also die Vorgaben: Steuerart des Artikels, Einlieferer ZERO (= E10 Fall A).
  - Die Auszahlung läuft über `record_payout` (`:212-219`), das bei verkauften Stücken mit Rechnung `PAYOUT_VIA_PURCHASE` ablehnt (`consignment-finance-house.ts:198-200`).
- **E12-Folge:** Mobile-Vertrag und Test müssen mitgeändert werden (Menge beim Anlegen, Menge beim Verkauf, Restbestand in der Liste). Das gehört zu P5.
- **E7-Folge:** Der Mobile-Verkauf kennt keine Bestätigung eines negativen LATAIF-Ergebnisses. Nötig ist ein Feld nach dem Muster `acknowledgeShortfall` (`:207`), oder ein solcher Verkauf wird am Telefon abgewiesen.

### N7 — E2 Rücknahme nach Guthabenverrechnung (Baustein bewiesen, Weg fehlt)
- **Baustein vorhanden:** `voidPurchasePaymentInHouse` storniert eine mit Lieferanten-Guthaben bezahlte Zahlung. Die Zahlungszeile bleibt, das Guthaben kommt zurück, die Buchung wird gegengebucht, Protokoll ist dabei, eine eigene Transaktion öffnet er nicht (`purchase-edit-house.ts:1201-1284`, Guthaben `:1253-1256`). Test `purchase-edit.test.ts:548-550` („Guthaben zurückgegeben"), Teil von 188/0.
- **Gesperrt für Kommissions-Einkäufe** (`purchase-edit-house.ts:1217-1220`, Test `multi-sale-d3.test.ts:883`). Die Rücknahme sperrt mit `CONSIGNOR_PAID_BY_CREDIT` (`consignment-reversal-house.ts:267-270`).
- **Sichere Folge möglich**, in einer Transaktion:
  1. Guthabenzahlungen des Kommissions-Einkaufs stornieren (das Guthaben steht wieder beim Einlieferer als Forderung).
  2. Dann die vorhandene D3-Rücknahme: unbezahlt → Einkaufsstorno; bar bezahlt → Lieferanten-Retoure mit Wahl.

  Bedingungen aus dem Baustein: Zahlung nach dem Eröffnungsstichtag, lebende Buchung, Überzahlungsguthaben nicht eingelöst.
- **Schwachstelle:** `restoreSupplierCreditUsage` kehrt still zurück, wenn das Guthaben fehlt, und klemmt bei 0 (`supplierCreditRestore.ts:24-35`). In der neuen Folge stattdessen hart prüfen, sonst ist „sicher atomar" nicht gegeben.

## 9.2 Auswirkungen der endgültigen E10-Regel
- **Datengrundlage:**
  - Einkaufszeilen tragen `tax_scheme` (`database.ts:828`).
  - Ein Los kennt seinen Einkauf und seine Einkaufszeile (`stock_lots.purchase_id`/`purchase_line_id`, genutzt in `consignor-side.ts:107-110`).
  - Kommission: eine Einlieferer-VAT je Einkauf (`consignmentStore.ts:550-562`).
- **Heute unabhängig:**
  - Verkaufsschema und Einlieferer-VAT werden getrennt gewählt (`ConsignmentSaleDialog.tsx:297` vs. `:355-363`; `consignmentStore.ts:575`).
  - Die Rechnungsmaske erlaubt Margin für jede Zeile (`InvoiceCreate.tsx:807-814`, `line-derivation.ts:23-27`).
  - Fall B ist nirgends erzwungen.
- **Nötig:**
  1. Im Haus (Anlegen + Ändern, Primary + PC2): Zeile mit Los aus VAT-10-%-Einkaufszeile → nur VAT 10 %.
  2. Kommission: Einlieferer-VAT 10 % ⇒ Verkaufsschema VAT 10 %. Ein späterer Wechsel ZERO → VAT 10 % vor der ersten Auszahlung erzwingt den Wechsel der Verkaufszeile auf VAT 10 % bei gleichem Brutto. Das senkt das LATAIF-Ergebnis (E7-Warnung) und ist eine Steueränderung der Rechnung (E8-Sperre).
  3. Mobile: Vorgaben = Fall A, also konform.
- **Lücken in den Daten:** Lose ohne Einkaufszeile (Altbestand/Eröffnung, Altlose) und Einkaufszeilen ohne `tax_scheme` (vor der Migration) tragen keine Fall-B-Information → O3.
- **Margin-Einstand netto** (`purchaseStore.ts:461`): Mit Fall B entfällt Margin für VAT-10-%-Einkäufe. Die frühere Rechtsfrage (§3 E10) betrifft dann nur Altfälle.
- **Steuerrechtlich gesondert** (nicht ersetzt): ob in Fall B Zero-rated (z. B. Export) zulässig bleibt; die Voraussetzungen des Margin-Schemas in Fall A.

## 9.3 Neue bzw. bestätigte Risiken
| # | Risiko | Schwere | Beweis |
|---|---|---|---|
| R1 | Historische Salden nach jeder Korrektur früher datierter Rechnungen überhöht (Gegenbuchung heute) | Hoch | Prüfskript P1; `invoiceStore.ts:861` |
| R2 | Gefangener Fehler einer Hausfolge → Schreiben ohne Transaktion | Hoch (für P4) | Prüfskript P4b; `posting.ts:314-324` |
| R3 | Primary-Edit ohne Fassungsvergleich und ohne Exklusivität | Mittel | `InvoiceCreate.tsx:503-506,536` |
| R4 | Unbezahlte Rechnung per Edit in eingereichtes Quartal datierbar | Mittel | Prüfskript P3 |
| R5 | W1 Option A trifft Zahlungen in zugemachten Quartalen; heutige Prüfung sieht sie nicht | Mittel | Prüfskript P2; `customer-change.ts:186-201` |
| R6 | Rückwirkende Buchungen vor dem Eröffnungsstichtag 15.10.2026 | Mittel | `opening-balances.ts:38` |
| R7 | Steuerartwechsel ändert Kundenbrutto (eigene Zeilen) | Mittel | `InvoiceCreate.tsx:807-808`, `edit-lines.ts:239-244` |
| R8 | Guthaben-Rückgabe still/klemmend | Niedrig | `supplierCreditRestore.ts:24-35` |
| R9 | `invoice.paid` nach innerem Commit trotz späterem äußeren Rollback | Niedrig (ungeprüft im Lauf) | `invoiceStore.ts:1274-1278` |

## 9.4 Technische Blocker
- **T1 E12:** Einzelstück-Datenmodell (§3 E12) plus Mobile-Vertrag, der eine Menge verbietet (N6).
- **T2:** Keine Korrekturfolge für Kommissionsverkäufe (§6.1 Nr. 2).
- **T3:** `editInvoice` ist als innerer Baustein nur sicher, wenn kein Aufrufer Fehler fängt (N2). Vor P4 muss es als schachtelbare Hausfolge vorliegen.
- **T4:** E11 braucht eine Gegenbuchung je Bein auf dem eigenen Datum (N5). Ohne sie bleibt R1.
- Der frühere Blocker E1 ist entfallen (zurückgestellt).

## 9.5 Empfohlene Pakete (P1–P5)
| Paket | Inhalt | Abhängig von | Test-Gates (vorhanden + neu) |
|---|---|---|---|
| **P1 Korrektur-Fundament (eigene Rechnungen)** | `editInvoice` schachtelbar (T3); Primary über `runOnPrimary` + Fassungsvergleich (R3); Filiale explizit; Rollenprüfung im Haus (ADMIN/MANAGER) für die neuen Wege; E11 Gegenbuchung je Bein am eigenen Datum (T4); W1 Option A mit Zahlungsdatum und Sperre je betroffenem Quartal (R5); Edit-Datum in zugemachtes Quartal sperren (R4); Brutto beim Steuerartwechsel (R7); Wahl Guthaben/Rückzahlung; Teilretouren nur retournierte Menge | O1, O2 | `invoice-edit/*` (7, davon **`customer-change.test.ts:553` bewusst neu**, weil der Vertrag sich ändert), `vat-period-lock`, `margin-vat`; neu: Stichtagsliste unverändert nach Korrektur, W1 Zahlung im zugemachten Quartal → Nein, Schachtelung ohne Teilzustand, veraltete Fassung am Primary → Nein |
| **P2 Steuerregeln E10 + Einstand** | Fall B im Haus (Eigenware + Kommission, Kopplung Einlieferer-VAT ⇒ Verkaufsschema); Margin-Einstand aus Los/Produkt inkl. Altbestand ohne Belegpflicht | P1 (Hausprüfung), O3 | `lot-vat-cost`, `invoice-edit/margin-vat`, `consignment-multi-sale/*`; neu: VAT-10-%-Los + Margin → Nein, Altbestand-Margin → erlaubt |
| **P3 Gemischte Rechnung anlegen** | eigene + Kommissionszeilen in einer Rechnung über die `recordSales`-Bausteine (ein Einkauf je Einlieferer, Floor, Käufer ≠ Einlieferer); nur ADMIN/MANAGER (Haus + PC2); E7-Warnung + Bestätigung; Menge 1 | P1, P2 | `consignment-multi-sale/*`, `consignment-integrity`, `invoice-edit/line-identity`; neu: SALES/ACCOUNTANT → Nein, E7 ohne Bestätigung → Nein, Rollback bei Fehler im Einkauf |
| **P4 Korrekturfolge Kommission** | E2 (inkl. N7-Folge), E3 (unbezahlt folgt, bezahlt bleibt, kein Datum vor Einlieferung/bezahltem Einkauf), E4 Käufer, E5, E6 (Kopfspalte!), E9, E10 vor erster Auszahlung, E11; Fassungen aller verknüpften Belege | P1, P3 | `r6f/consignment-parity`, `consignment-multi-sale/d3-repayment`, `purchase-edit`; neu je E ein unbezahlter und ein (teil)bezahlter Fall |
| **P5 E12 Mengen/Teilverkäufe** | nur Planung: Schema, Migration Einzelstück → Menge 1, Lose, Payout je Menge, Mobile-Vertrag; eigenes Audit + Preview | P4 | später |

Alle Pakete: Abnahme in der echten Test-App gegen das neu freigegebene Preview (`docs/ai/acceptance-rules.md`). Das Preview muss vorher angeglichen werden: E1-Rabattfeld entfernen, E6, E9, E12, E13, Kundenüberzahlung, Teilretoure, E7-Warnung, E10-Kopplung.

## 9.6 Noch erforderliche Owner-Entscheidungen
- **O1 Eröffnungsstichtag:** Rückwirkende Gegen-/Neubuchungen (E11) und W1-Umbuchungen mit Datum **vor dem 15.10.2026**: zulassen (die Stichtagsliste der Eröffnung ändert sich), sperren (wie der Einkauf-Edit) oder auf heute buchen?
- **O2 Altes Datum im zugemachten Quartal:** Eine **unbezahlte** Rechnung, die im eingereichten Quartal datiert ist, aber dort nicht gemeldet wurde (nicht FINAL), wird verschoben oder korrigiert. Gegenbuchung heute (wie jetzt) oder sperren? E11 regelt nur offene Quartale.
- **O3 E10-Altfälle:**
  - Bestehende Rechnungen, die Fall B schon widersprechen: beim Ändern unverändert lassen (Muster `keptLineAmounts`, `edit-lines.ts:228-242`) oder erzwingen?
  - Artikel ohne gespeicherte Einkaufs-VAT (Altbestand, Altlose): gilt Fall A?
- **O4 Vorhandene Buchungen (R1):** Frühere Korrekturen haben schon heute datierte Gegenbuchungen hinterlassen. Bleiben sie, oder ist eine eigene, freigegebene Datenkorrektur gewünscht? Das wäre ein Produktionsdaten-Eingriff, nicht Teil von P1.
- **An den Buchhalter (keine Owner-Ersatzregel):** Zero-rated in Fall B; Voraussetzungen Margin in Fall A.

## 9.7 Belegt vs. ungeprüft
**Belegt:** N1, N3, N4, N6 (Code); N2, N5 (Prüfskript P1–P4 auf echtem Code); N7 (Code + Test); E10-Auswirkungen (Code).

**Ungeprüft:**
- Handler-Folgen von `invoice.paid` bei äußerem Rollback (R9);
- die Primary-Schachtelung in eine wartende Fern-Transaktion (nur aus dem Code abgeleitet);
- Ausmaß von R1 in den Produktionsdaten (nicht gelesen);
- Bulk-Metall-Lose (`sale_tax_scheme` je Los, `bulk-lot-house.ts:96`) unter E10.

**Git nachher:** HEAD unverändert `2f40d944`. Ungetrackt nur dieser Bericht (ergänzt) und das unveränderte Preview. Prüfskript gelöscht. Kein Commit, Push, Tag oder Release.

`MIXED_INVOICE_TECHNICAL_FOLLOWUP_AUDIT_COMPLETE`

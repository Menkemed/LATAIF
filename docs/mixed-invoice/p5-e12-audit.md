> **Historische Planungsunterlage (Stand 07.11.2026).** Am selben Tag freigegeben (D-P5-1 Weg A, D-P5-2 je Stück, D-P5-3 eine Zeile je Stück) und umgesetzt; abweichend vom Plan trägt die Gruppe zusätzlich `group_seq` und `group_quantity`. Verbindlich ist `docs/mixed-invoice-contract.md`.

# Mixed Invoice P5 — E12 Mengen und Teilverkäufe bei Kommission: Audit und Implementierungsplan

Stand 07.11.2026. Nur Prüfung und Plan. Kein Code, keine Migration, kein Commit, kein Zugriff auf Produktionsdaten.
Basis: Arbeitsbaum `desktop-mixed-p2`, Branch `feature/mixed-invoice-p2`, HEAD `1c81e383` (P2 `8faa564a`, P3 `8475b370`, P4 `30af0731`, E5/E9 `1c81e383`).

## 0. Grundlage

- **E12 (Owner, endgültig):** „Mengen und Teilverkäufe bei Kommission; Restbestand, Auszahlungen, Retouren und Altdaten schützen. Pflichtteil des Projekts, getrennt umsetzbar."
- **Plan §P5:** vorab eigenes Audit, Preview und Architekturentscheidung. Planungsinhalt:
  - Schema für Mengen und Verkaufsanteile
  - Lose ab Einlieferung oder je Teilverkauf
  - Payout/Floor je Stück oder gesamt
  - Migration aller Einzelstücke auf Menge 1 ohne Verlust
  - Einlieferer-Seite, Rücknahme, Payout-Sperre
  - Mobile-Rümpfe und -Liste
  - Rennschutz der Reservierung (F7)
- **Nicht neu eröffnet:** E1–E11, E13, D1–D5, E7 Option A, E5/E9 (Order-Kostenlogik).

## 1. Ist-Zustand (belegt)

**Datenmodell — eine Kommission ist genau ein Stück:**
- `consignments` (`schema.sql:418-452` + Spalten aus `database.ts:294,295,395,1065,1266,1679,1759`) hat keine Mengenspalte.
- Die Verkaufsfelder sind Einzelwerte: `sale_price`, `buyer_id`, `invoice_id`, `commission_amount`, `payout_amount`, `payout_paid_amount`, `status`.
- `product_id NOT NULL`, der Index darauf ist nicht unique.

**Aufnahme:**
- Der Artikel entsteht mit `quantity: 1`, `purchasePrice: 0`, `stock_status 'consignment'`, `source_type 'CONSIGNMENT'` (`consignment-create.ts:122-128`); genau eine Kommission auf genau diesen Artikel (133-146).
- Kein Mengenfeld in:
  - Desktop-Modal `ConsignmentList.tsx:784-1279`
  - PC2-Rumpf `commercial-commands.ts:542-547` (streng, `onlyKnownFields`)
  - Handy `mobile_consignment_commands.js:37`
- Der Handy-Vertrag verbietet die Menge ausdrücklich (`test/preg5/mobile-consignment.test.ts:101-105`).

**Bestand:**
- Vor dem Verkauf gibt es kein Los, die Menge kommt aus `products.quantity` (`lot-queries.ts:239-263`, `remainingSellableStock` 346-356). `getAvailableStock` zählt nur Lose (221-232).
- Das erste Los entsteht erst beim Verkauf: Der Auto-Einkauf legt eine Zeile mit Menge 1 an (`consignmentStore.ts:622-636`), danach gilt Menge = Summe der Lose (`purchaseStore.ts:512-520`).
- **Folge für eine echte Menge N>1:** Das erste Los überschriebe `products.quantity` mit 1.
- Zusätzlich zieht `recordSales` außerhalb der gemischten Rechnung noch einmal 1 ab (`consignmentStore.ts:730-735`; P3 hat diesen Doppelabzug nicht übernommen).
- Kommissionsware ist nicht im Lagerwert und vor dem Verkauf nicht im Hauptbuch (`stock-metrics.ts:35-40`, `consignment-create.ts:124`).

**Verkauf, Rechnung und Retoure:**
- `recordSales` verlangt Status `active` und verbietet denselben Artikel zweimal auf einer Rechnung (`consignmentStore.ts:513-519`).
- Ein Einkauf je Einlieferer und Verkauf, eine Zeile je Kommission, Menge 1 (630).
- Integritätsvertrag: (Rechnung, Artikel) gehört zu höchstens einer Kommission (`consignment-sale-link.ts:5-14,94-107`).
- P3/P4 bauen darauf:
  - Kommissionszeilen haben Menge 1 (`mixed-invoice-correction.ts:715,734,761,768`).
  - Die Ökonomie rechnet je Kommission (`economics.ts:45`).
- Post-Sale Return nimmt immer den ganzen Rest der Zeile (`consignment-reversal-house.ts:447-471`).
- Cancel Sale nimmt die ganze Rechnung mit allen Kommissionen zurück (`:574-576`).

**Einzelwert-Leser (Auswahl, alle setzen eine Kommission = ein Verkauf voraus):**
- Einlieferer-Seite `consignor-side.ts:106-110,194-204`
- `payablesStore.ts:283-308`, `bankingStore.ts:502-514`
- Berichte `analytics-snapshot.ts:314-319,490-505`, `reports/context.ts:410-414`
- `payout-edit.ts:55-57,100-102`, `legacy-stock-repair.ts`, B6-Nachtrag `database.ts:2596-2607`
- PC2-DTO `read-commands.ts:738-770`
- Seiten `ConsignmentList`, `ConsignmentDetail`, `ConsignorDetail`, PDF `consignment-print-helpers.ts:82-83`
- Sync-Manifest `sync-business-schema.json:165-206` (`allowed_fields`)

**Agent:** Kommissionsware darf nicht zum Agenten (`transfer-rules.ts:159-162`, `agentStore.ts:52-57`). Keine Wechselwirkung.

**Medien:** Fotos hängen über `media_links` (Medium ↔ Entität, `media-schema.ts:106-125`). Ein Medium kann mehreren Artikeln verknüpft werden, ohne die Datei zu kopieren.

## 2. Was P5 wirklich braucht — zwei Wege

### Weg A — Kommissionsgruppe aus Einzelstücken (empfohlen)
- Eine Aufnahme mit Menge N legt N Kommissionen an, je ein Stück, je ein eigener Artikel mit eigener SKU. Alle tragen dieselben Bedingungen (Einlieferer, Preis je Stück, Payout-Modell, Datum) und dieselbe Gruppenkennung.
- Ein Teilverkauf ist der Verkauf von k Stücken der Gruppe. Das ist der vorhandene Mehrfachverkauf (`recordSales` mit `items[]`, PC2-Rumpf vorhanden, bis 50).
- Der Restbestand ist die Zahl der aktiven Stücke der Gruppe.
- Auszahlung, Retoure, Cancel Sale und P4-Korrektur bleiben je Stück, unverändert.

| Punkt | Wirkung |
|---|---|
| Schema | **eine** neue Spalte `consignments.group_id TEXT NULL` + Index. Keine Mengenspalte, keine Verkaufstabelle. |
| Migration | `ALTER TABLE … ADD COLUMN` (idempotent). Bestehende Zeilen bleiben `NULL` = Gruppe aus einem Stück. **Kein Datenumbau, keine Beträge verändert.** |
| Sync | `group_id` in `allowed_fields` (`sync-business-schema.json`); der Rust-Server liest dieselbe Liste (Build nötig). |
| P1–P4 | **unverändert**: Ein Stück = eine Kommission = eine Rechnungszeile, Integritätsvertrag, Ökonomie, E7/E9/E2 je Zeile. |
| Lose und Bestand | **unverändert**: je Stück ein Artikel mit Menge 1; das Los entsteht wie heute beim Verkauf. |
| Floor/Payout | je Stück (der vereinbarte Preis gilt je Stück). |
| Rechnung | k Zeilen, eine je Stück (Folge des Modells; eine zusammengefasste Druckzeile wäre ein eigenes Thema). |
| PC2 | `consignments.create` + optionales `quantity` (1–50). Der strenge Rumpf lässt einen alten Primary es abweisen, statt still 1 anzulegen. Verkauf: vorhandener `items[]`-Rumpf. |
| Handy | Mengenfeld bei der Aufnahme; Liste nach Gruppe; Verkauf von k Stück über den vorhandenen `items[]`-Rumpf (nicht k Einzelaufträge). Der Vertragstest (`mobile-consignment.test.ts:101`) ändert sich bewusst (E12). |
| Rennschutz F7 | wie heute: Fassung je Kommission, eine Schreibreihenfolge. |
| Rückweg | Die Spalte bleibt bei einer Rückkehr auf v0.8.98 unbeachtet; jedes Stück ist eine gültige Einzelkommission. |
| Aufwand/Risiko | klein bis mittel: Aufnahme (Haus, 3 Masken), Gruppenanzeige (Liste, Detail, Handy), Gruppenauswahl im Verkaufsdialog und in Abschnitt 2b. |

### Weg B — echte Menge auf einer Kommission (Teilen beim Verkauf)
- **Inhalt:**
  - Eine Kommission und ein Artikel mit Menge N.
  - Beim Teilverkauf wird eine Teilkommission (k Stück) abgespalten.
  - Die Ökonomie rechnet ×k.
  - Einkaufszeile und Los haben Menge k.
- **Was dafür nötig wäre (belegt):**
  - Neue Mengenregel im Bestandskern: Das erste Los darf die Restmenge nicht mehr überschreiben (`lot-queries.ts:239-263`).
  - Der Doppelabzug (`consignmentStore.ts:730-735`) muss weg.
  - Eigentum gemischt in einem Artikel: Nach „Keep as own" sind k Stücke eigen und N−k Kommission, `source_type` ist aber ein Wert je Artikel.
  - Der Integritätsvertrag (Rechnung, Artikel) → Kommission ändert sich.
  - Cancel Sale und P4-Entfernen müssen eine Teilkommission zurückführen.
  - Etwa 20 Einzelwert-Leser (§1) ändern sich.
  - Payout-Sperre, Berichte und PC2-DTO ändern sich.
  - P3/P4 rechnen dann mit Menge k je Zeile.
- **Aufwand/Risiko:** hoch. Es berührt den Bestandskern und alle P1–P4-Verträge.

**Empfehlung: Weg A.** Er erfüllt E12 vollständig: Menge bei der Aufnahme, Teilverkauf, Restbestand, Auszahlungen und Retouren je Stück, Altdaten unverändert. Dafür genügen eine additive Spalte und keine Änderung an P1–P4 oder am Bestandskern.

## 3. Implementierungsplan (Weg A)

**P5a — Daten und Haus**
1. Migration: `ALTER TABLE consignments ADD COLUMN group_id TEXT`, `CREATE INDEX IF NOT EXISTS ix_consignments_group ON consignments(group_id)`.
2. Sync-Manifest: `group_id` in `allowed_fields`.
3. `createConsignmentWithProduct` + Menge (1–50), in EINER Transaktion:
   - N Artikel: SKU je Stück aus dem Zähler; eine getippte SKU bekommt `-1…-N`.
   - N Kommissionen mit fortlaufenden Nummern und gemeinsamer `group_id` (= Kennung der ersten).
   - Fotos einmal aufgenommen und je Stück verknüpft (`media_links`), keine Kopie.
   - Protokoll `consignment_group_created`.
4. PC2 `consignments.create` + `quantity` (streng, ganzzahlig 1–50); Antwort mit allen Kennungen.
5. Lesemodell: `groupId` in `rowToConsignment` und im PC2-DTO.

**P5b — Masken**
1. Desktop-Aufnahme: Feld „Quantity" und die Kennzeichnung „Agreed price per piece".
2. Liste „Items": Gruppen zusammengefasst („Perlenstecker × 5 · 3 aktiv · 2 verkauft"), aufklappbar. Mehrfachauswahl wie heute.
3. Detail: Abschnitt „Group" mit allen Stücken (Status, Käufer, Rechnung, Auszahlung, Link).
4. Verkaufsdialog: Gruppe mit Mengenwahl k. Die Maske wählt die k aktiven Stücke mit der kleinsten Nummer; ein Preis je Stück gilt für alle k und bleibt je Zeile änderbar. E7/Floor je Zeile wie heute.
5. Abschnitt 2b der Rechnung: der Picker zeigt Gruppen („× 3 verfügbar") mit Mengenwahl, daraus k Zeilen. Beim Ändern (P4) bleiben die Zeilen je Stück.
6. Handy: Mengenfeld bei der Aufnahme, Liste nach Gruppe, Verkauf von k Stück über `items[]`.

**Nicht enthalten (keine Erweiterung):**
- keine zusammengefasste Druckzeile
- keine Gruppen-Massenrückgabe als eigener Befehl (Rückgabe je Stück, mehrere über die Auswahl)
- kein Weg B

## 4. Testplan

- **Neu `test/p5/consignment-quantities.test.ts`:**
  - Aufnahme N=3 (Primary + PC2): 3 Artikel, 3 Kommissionen, gleiche `group_id`, eindeutige SKUs, Fotos 1× gespeichert und 3× verknüpft, eine Transaktion (Rollback bei Fehler im 3. Stück).
  - Menge fehlt ⇒ wie heute 1. Menge 0, 51, 1.5 oder Text ⇒ Nein.
  - Teilverkauf 2 von 3 über Record Sale (Primary/PC2) und über die gemischte Rechnung: Rest 1 aktiv, Einkauf je Einlieferer mit 2 Zeilen, Abgleich Lager/AP/AR/Hauptbuch.
  - Je Stück: Post-Sale Return, Cancel Sale (Stück zurück in der Gruppe), P4 Entfernen/Preis.
  - Einlieferer-Seite je Stück und als Gruppensumme.
  - Berichte zählen Stücke.
  - Migration auf einer alten Datenbank: Spalte ergänzt, bestehende Zeilen unverändert (Fingerabdruck), zweiter Lauf ohne Wirkung.
  - Sync-Manifest enthält `group_id`.
- **Handy:** `mobile-consignment.test.ts` (Menge jetzt erlaubt, nur 1–50); `mobile-consignment-page.e2e.mjs` (Aufnahme 3, Liste nach Gruppe, Verkauf 2 über `items[]`).
- **E2E Zwei-App** `consignment-quantities.e2e.mjs`: Aufnahme 3 am PC2, Verkauf 2 im Dialog, Rest 1, P4-Entfernen eines Stücks, Abgleich.
- **Regression:** alle P1–P4-Gates (80 Node-Suiten) und die E2E P3, P4, Multi-Sale-PC2, r5f, r6f, Custom-Order.

## 5. Rückweg und Produktion

- **Additiv:** Die Spalte stört v0.8.98 nicht; jede Gruppe besteht aus gültigen Einzelkommissionen. Eine Rückkehr auf die Vorversion verliert nur die Gruppenanzeige.
- **Altdaten:** Keine Zeile wird umgeschrieben. Fingerabdruck aller Kommissionen vor und nach der Migration im Test.
- **Einführung** nach Runbook:
  1. Sicherung mit Medien auf E: und F:.
  2. Primary zuerst, dann PC2. Ein alter PC2 schickt keine Menge, das Ergebnis ist unverändert.
  3. Handy-Seite kommt mit dem Primary.
- Kein Zugriff auf Produktionsdaten vor der Freigabe.

## 6. Entscheidungslücken (nur diese)

| # | Frage | Empfehlung |
|---|---|---|
| D-P5-1 | Architektur: Weg A (Gruppe aus Einzelstücken) oder Weg B (echte Menge, Teilen beim Verkauf)? | **A** |
| D-P5-2 | Gilt der vereinbarte Preis (und Minimum) **je Stück** oder für die ganze Menge? | **je Stück** (Floor, Auszahlung, E7, Verlust je Zeile; bei einer Gesamtangabe müsste geteilt und gerundet werden) |
| D-P5-3 | Bestätigt: eine Rechnungszeile je Stück (Folge von A)? | ja |

## 7. Release-Checkliste (gemeinsamer Mixed-Invoice-Release)

1. **Anzeige „Pick product..." (bestehend, nicht P3–P5):** Im Änderungsmodus fehlt ein reservierter oder verkaufter eigener Artikel in der Produktauswahl; die Zeile zeigt den Platzhalter, behält aber den Artikel. Entscheiden: vor dem Release beheben oder als bekannter Punkt.
2. **Commit-Whitespace:** `posting.ts` liegt mit CRLF im Repository; `git diff --check` meldet dort das `\r` (in `1c81e383`, drei Zeilen). Mit `-c core.whitespace=cr-at-eol` sauber. Im Release-Gate so prüfen.
3. Sichtabnahme in der echten App: P3 (Anlegen), P4 (Korrektur inkl. E5/E9-Wahl), E7 im Record-Sale-Dialog und auf dem Handy, P5.
4. Bestehender Befund: Die Leiste „Unresolved saves" verdeckt am PC2 bei 1400×900 den Knopf „Save Invoice".
5. G4 (Margen-Basis nach VAT-10-%-Einkauf) bleibt Frage an den Buchhalter.
6. Untrackte Plan- und Audit-Dateien im ursprünglichen Baum (`desktop/docs/ai/audits/mixed-invoice-*.md`, `docs/previews/mixed-invoice-preview.html`) und diese P5-Dateien: über einen Commit entscheiden.
7. Runbook: Sicherung mit Medien (E:/F:), Release-Gate (Full-Suite), Primary zuerst, dann PC2; offene „Unresolved saves" am PC2 vorher prüfen.

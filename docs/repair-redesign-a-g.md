# Repair Redesign A–G — Regeln, Umsetzung, offene Entscheidungen

Stand: 29.10.2026. Grundlage: die vom Owner freigegebene Vorschau „Repair UI Redesign Preview" (Ansichten A–G).

## Was gilt

**Wer arbeitet** (`src/core/repairs/repair-work-source.ts`, eine reine Ableitung für Liste, Quick Edit, Detailseite, PC2 und Handy):

- Arbeitszeilen (offen, ohne `material_kind`) sind die Wahrheit: ohne Lieferant = eigene Arbeit, mit Lieferant = Werkstatt, beides = Hybrid.
- `repairs.planned_workshop_supplier_id` (neu) = eine beim Anlegen gewählte Werkstatt **ohne** Gebühr. Sie zählt als Werkstattbeteiligung, solange es von ihr keine Arbeitszeile gibt. Die erste Arbeitszeile dieser Werkstatt beendet den Plan (`addRepairLine`). Der Plan bucht nichts.
- Ohne Arbeitszeilen: die beim Anlegen gewählte Art (`repair_type`); eine Werkstatt, die ohne jede Zeile an der Reparatur steht (`workshop_supplier_id`, Altbestand), gilt als zugeordnet.
- Materiallieferanten sind nie eine Werkstatt.

**Filter der Liste** (`matchRepairWork`):

- Arbeitsart, Quelle und Werkstatt müssen an derselben Beteiligung zusammenkommen.
- „Hybrid" ist eine Eigenschaft der ganzen Reparatur.
- Das Issue zählt nur ohne Arbeitszeile. Neben einem Quellen- oder Werkstattfilter zählt es nur, wenn genau eine Beteiligung besteht.

**Kosten** (`repairCostView`):

- Die Kosten sind dieselbe Summe wie `computeRepairTotalCost` (`repairCostParts`), nur aufgeteilt: Arbeit, Material, eigene Kosten (`internal_cost`, nicht bei „external"), Altgebühr.
- „Actual Cost" ist bei vorhandenen Zeilen deren Summe und wird nur angezeigt; `recomputeRepairAggregates` schreibt sie ohnehin.

**Kosten einer Arbeitszeile** (`repairLineCostIssue`, am Primary, im PC2-Befehl `repairs.add_line`/`update_line` und am Handy gleich):

- Eigene Arbeit ab 0.000.
- Eine Werkstattzeile über 0 (`LINE_COST_REQUIRED`).
- Negativ oder keine Zahl: Nein.

**Anlegen** (`repairCreateWorkshopSplit`):

- Mit Werkstattgebühr wie bisher (`workshop_supplier_id` + Gebühr → `createRepair` legt die Werkstattzeile an).
- Ohne Gebühr wird die Werkstatt nur eingeplant. Damit bucht eine später eingetragene Schätzung bei „ready" keine Werkstattgebühr.

## Was unverändert blieb

- **Gespeicherter `repair_type`**: Er bestimmt weiter den Statusweg („Sent to workshop") und die bestehende Kostenregel. Er wird beim Anlegen aus „Wer arbeitet?" gesetzt und durch Zeilen nur hochgestuft (wie bisher). Er wird nie zurückgestuft und an der Detailseite nicht mehr von Hand gewählt.
- **Buchungen**: Hauptbuch, Werkstatt-Verbindlichkeiten (Buchung ab „in Arbeit"), eigene Arbeit (`REPAIR_OWN_WORK`), Kopfkosten bei „ready", VAT, Bestand und Gold sind unverändert.
- **Altfälle**: Kein historischer Datensatz wird umgeschrieben oder in Arbeitszeilen umgewandelt.
- **Material**: Der Materialdialog und seine Regeln (Gold, eigener Bestand, alle aktiven Lieferanten) sind unverändert.

## Gefunden, nicht geändert (Owner-Entscheidung)

1. **Materiallieferant und `repair_type`**: `recomputeRepairAggregates` stuft `repair_type` auch wegen einer Material-Lieferantenzeile auf „hybrid" hoch und trägt den Materiallieferanten in `workshop_supplier_id` ein. Die Anzeige und die Filter ignorieren das. Der gespeicherte Typ (Statusweg „Sent to workshop", Kostenbeschriftung) bleibt davon betroffen.
2. **Zurückstufen des Typs**: Wird die einzige Werkstattzeile storniert, zeigt die Seite „In-house", gespeichert bleibt „hybrid"/„external". Ein Zurückstufen würde bei „external" die Zählung von `internal_cost` ändern. Die Regel „Zeilen + Zusatzkosten unabhängig vom Typ" ist nicht freigegeben.
3. **Anzeige an der Detailseite**: Die Kostenkarte zählte „Total Cost" bisher als Zeilen + `internal_cost`. Bei „external" ist `internal_cost` der gespiegelte Voranschlag und zählte doppelt. Jetzt steht dort dieselbe Summe wie in Marge und Rechnung. Das ist eine reine Anzeige; Buchungen ändern sich nicht.

## Vor einem Release

- Neue Spalte `repairs.planned_workshop_supplier_id`: Migration auf einer Produktionskopie, wiederholter Start, Backup/Restore über die App.
- `sync-business-schema.json` ist geändert; der Rust-Sync-Server bindet sie ein, deshalb ist ein Neubau nötig.

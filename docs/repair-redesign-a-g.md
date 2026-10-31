# Repair Redesign A–G — Regeln, Umsetzung, offene Entscheidungen

Stand: 29.10.2026. Grundlage: die vom Owner freigegebene Vorschau „Repair UI Redesign Preview" (Ansichten A–G).

## Was gilt

**Wer arbeitet** (`src/core/repairs/repair-work-source.ts`, eine reine Ableitung für Liste, Quick Edit, Detailseite, PC2 und Handy):

- Die angezeigte Art widerspricht der gespeicherten nie (FOLLOW-UP 31.10.): angezeigt wird die Vereinigung aus gespeicherter Art (`repair_type`) und dem, was Arbeitszeilen, geplante Werkstatt und Altzuordnung zeigen. Eine Seite ohne aktive Arbeitszeile bleibt sichtbar und ist markiert („no active work line").
- Arbeitszeilen (offen, ohne `material_kind` oder mit dem Lohnposten „labor"): ohne Lieferant = eigene Arbeit, mit Lieferant = Werkstatt, beides = Hybrid.
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

## FOLLOW-UP 31.10. — behoben

1. **Materiallieferanten**: `recomputeRepairAggregates` liest Werkstatt und Hochstufung nur noch aus Arbeitszeilen.
   - Ein Materiallieferant stuft nicht mehr auf „hybrid" hoch und steht nicht mehr in `workshop_supplier_id`.
   - Eigenes Material stuft eine Fremdreparatur nicht mehr hoch. Vorher wurde dabei der gespiegelte Voranschlag (`internal_cost` bei „external") ab „hybrid" als eigene Kosten mitgezählt.
   - `actual_cost` bleibt die Summe aller Zeilen. Materialbuchungen und Lager sind unverändert.
   - Altfälle werden nicht umgeschrieben. Kostenwirkung hat `workshop_supplier_id` nur ohne jede Zeile (Altgebühr), deshalb ändert sich dadurch keine Summe.
2. **Art und Anzeige**: Die Anzeige folgt jetzt der gespeicherten Art plus den Zeilen (Vereinigung).
   - Nach dem Storno der letzten Werkstattzeile bleibt es Hybrid oder External, mit dem Hinweis „no active work line"; es gibt keinen Widerspruch mehr zur gespeicherten Art.
   - Statusweg, Verbindlichkeiten, Buchungen und Kosten bleiben unverändert.
3. **Anzeige an der Detailseite** (aus A–G): „Total Cost" ist dieselbe Summe wie Marge und Rechnung. Vorher zählte bei „external" der gespiegelte Voranschlag doppelt. Das ist eine reine Anzeige.

## Zur Freigabe: bewusstes Zurückstufen der Art

Eine automatische Herabstufung ist nicht sicher:

- **„Sent to workshop"** verschwindet aus dem Statusweg. Eine Reparatur, die dort steht oder von dort zurückgegeben wurde, hätte keinen gültigen nächsten Schritt bzw. kein Reopen-Ziel mehr.
- **hybrid → external** nimmt die eigenen Zusatzkosten (`internal_cost`) aus der Summe. Marge und Einstand sinken.
- **external → internal** zählt den gespiegelten Voranschlag als eigene Kosten (Doppelzählung).
- **hybrid → internal ohne Zeilen**: Beim nächsten Speichern wird ein von Hand eingetragener Actual Cost zu eigenen Kosten (`internalCostOnEdit`). Die Altgebühr (Werkstatt ohne Zeilen) entfiele.

**Vorschlag**: eine ausdrückliche Owner-Handlung „Change work type" an der Detailseite, mit Audit-Eintrag.

- **hybrid → internal** wird nur angeboten, wenn es nachweislich nichts an Kosten und Status ändert:
  - keine offene Werkstatt-Arbeitszeile, keine geplante Werkstatt, kein `workshop_supplier_id`;
  - mindestens eine offene Zeile, oder `actual_cost` leer;
  - Status nicht `sent_to_workshop`, `return_from_status` nicht `sent_to_workshop`;
  - nicht abgerechnet.
- **hybrid → external** und **external → internal** bleiben gesperrt (kostenwirksam), nur mit Freigabe des Buchhalters.

## Vor einem Release

- Neue Spalte `repairs.planned_workshop_supplier_id`: Migration auf einer Produktionskopie, wiederholter Start, Backup/Restore über die App.
- `sync-business-schema.json` ist geändert; der Rust-Sync-Server bindet sie ein, deshalb ist ein Neubau nötig.

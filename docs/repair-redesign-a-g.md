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

## Befund REP-2026-00002 (31.10., Produktionskopie, nur gelesen)

- **Angelegt** am 27.10. 15:43 als `internal`, Status `received`. Belegt durch den ersten Eintrag in `sync_changelog`, der Typ war die Vorgabe des Anlegefensters.
- **15:49:28**: Eine Arbeitszeile der Werkstatt „Watch Repair Safruddeen“ (Service, 20.000) kommt dazu. In derselben Millisekunde setzt `recomputeRepairAggregates` den Typ auf `hybrid` und trägt die Werkstatt ein. Das Audit nennt das `recomputedFromLines`.
  - Ursache ist die Regel „internal + erste Werkstattzeile → hybrid“, die es seit v0.7.6 gibt. Der Owner hat den Typ nicht gewählt.
  - Um 15:50:59 hat das Bearbeiten-Fenster den schon gesetzten Typ nur mitgespeichert.
- **Wirkung**: keine fachliche.
  - `internal_cost` ist 0, `estimated_cost` leer. Also gilt Summe = Zeile = 20.000, egal ob hybrid, external oder internal mit Zeile.
  - Rechnung SRINV-2026-000001 ist FINAL, 30.000 bezahlt, Einstand 20. Hauptbuch: AR/REVENUE 30, COGS 20, AP 20 (EXP-2026-000003 offen).
  - Der Schritt „Sent to workshop“ (28.10.) gibt es bei hybrid und bei external gleich.
  - Falsch ist nur die Bezeichnung „Hybrid“.
- **Die Regel besteht weiter.** Im Anlegefenster ist „In-house“ vorgewählt. Kommt danach eine Werkstattzeile dazu, wird die Reparatur wieder hybrid.
- **Vorschlag zur Freigabe**:
  1. Code: „internal + erste Werkstatt-Arbeitszeile“ wird `external` statt `hybrid`, solange es keine eigene Arbeitszeile gibt und `internal_cost` 0 ist. Gibt es eigene Arbeit oder eigene Kosten, bleibt es hybrid. Statusweg und Summe bleiben in diesem Fall gleich. Vor dem Umsetzen nachweisen: Storno der Zeile, späteres Bearbeiten (`internalCostOnEdit`), Kopfkosten bei „ready“.
  2. Daten: REP-2026-00002 `repair_type` hybrid → external. Kosten- und statusneutral (siehe oben), nur mit Sicherung und Audit-Eintrag und nur auf gesonderte Freigabe.

## REPAIR TYPE FINAL CORRECTION (31.10.) — umgesetzt

- **Regel** (`src/core/repairs/repair-type-rule.ts`, rein): Die gespeicherte Art folgt der aktiven Arbeit, nicht der Vorwahl „In-house“.
  - Eigene Arbeit: eine offene Arbeitszeile ohne Lieferant, oder eigene Kosten (`internal_cost` > 0, außer bei „external“).
  - Werkstattarbeit: eine offene Werkstatt-Arbeitszeile, eine eingeplante Werkstatt, oder die Werkstatt im Kopf vor der ersten Zeile (Gebühr beim Anlegen / Altbestand).
  - Nur eigene → internal, nur Werkstatt → external, beides → hybrid, keine aktive Arbeit → bleibt.
  - Materialzeilen zählen nie.
- **Wann geprüft wird:** nach jeder Zeilenänderung (hinzufügen, ändern, stornieren — Primary, PC2 und Handy über dieselbe Store-Funktion) und wenn sich die geplante Werkstatt im Bearbeiten-Fenster ändert. Bestehende Reparaturen ohne solche Änderung werden nie umgeschrieben.
- **Schutz:** Die neue Art wird nur gespeichert, wenn sie gegenüber dem bisherigen Verhalten (Hochstufung seit v0.7.6) gleich bleibt bei:
  - Kostenaufteilung: eigene Kosten, Zeilen, Gebühr (`repairCostParts`);
  - Statusweg: aktueller Schritt, „Sent to workshop“ (aktuell, Reopen-Ziel oder je erreicht).
  - Sonst bleibt das bisherige Verhalten, und im Protokoll steht `repairTypeKept` (COST, STATUS oder INVOICED).
  - „Hybrid“ bleibt Hybrid.
  - Die Kostenformel ist unverändert.
- **Ergebnis:** Internal mit der ersten Werkstattzeile (ohne eigene Arbeit oder eigene Kosten) wird jetzt External statt Hybrid. Statusweg und Kosten sind dabei gleich wie bisher.
- **REP-2026-00002**: Die Datenkorrektur hybrid → external ist vorbereitet (`fix-rep2-type.cjs`, Arbeitskopie, Vorbedingungen und Nachprüfung). Der Probelauf auf einer Produktionskopie war ok: nur `repair_type` und `revision` ändern sich, Salden, Rechnung, Ausgabe und Zahlungen nicht. Ausführung nur mit gesonderter Owner-Freigabe, App geschlossen, nach Sicherung.
- ~~Bleibt bestehen: gespiegelter Voranschlag bei external → hybrid zählt doppelt~~ — behoben, siehe unten.

## REPAIR COST DOUBLE-COUNT FIX + FINAL SAFETY (31.10.)

- **Ursache der Doppelzählung**: Bei „external“ zählt `internal_cost` nicht (`repairCostParts`: own = 0); die Anlage spiegelt dort den Voranschlag (`internalCostOnCreate`) und legt zugleich die Werkstattzeile über denselben Betrag an. Kam eine eigene Zeile dazu, wurde die Reparatur hybrid, und der Spiegel zählte neben der Werkstattzeile (Gebühr 25 + Politur ergab Kosten 50).
- **Spiegel nur mit Nachweis** (`decideRepairType`): Gleiche Beträge beweisen nichts.
  - Der Nachweis ist das Protokoll `internalCostMirrored`, das die Anlage nur dann schreibt, wenn sie selbst gespiegelt hat (external, keine eigenen Kosten eingetragen).
  - Jede Änderung von `internal_cost` löscht den Nachweis, auch „von Hand geändert und zurück“.
  - Mit Nachweis wird der Betrag beim Verlassen von „external“ 0 (NEUTRALIZED).
  - Ohne Nachweis (Altbestand, eingetragene Kosten, von Hand geändert) bleibt die Reparatur „external“, der Betrag bleibt stehen und zählt weiter nicht. Im Protokoll steht `repairTypeKept: MIRROR`. Die Anzeige zeigt die eigene Arbeit trotzdem (Hybrid), die Kosten bleiben korrekt.
- **Altgebühr im Kopf bleibt** (`repairHeaderFeeKept`, `repairCostParts(…, { headerFeeKept })`): Eine Gebühr im Kopf ohne Zeile gibt es nur im Altbestand.
  - Sie gilt weiter neben Material und eigener Arbeit und endet erst mit einer Arbeitszeile dieser Werkstatt. Nach „ready“ wird die Kopfbuchung dann um genau die Differenz nachgezogen: keine zweite Verbindlichkeit.
  - Nicht zuordenbar und deshalb abgewiesen (`REPAIR_HEADER_FEE_OPEN`, nichts geändert): eine Arbeitszeile einer anderen Werkstatt und Material desselben Lieferanten, solange die Gebühr gilt.
  - Bestehende Reparaturen mit Zeilen ändern sich nicht: Ihr `workshop_supplier_id` stammt aus diesen Zeilen, deshalb greift die Regel dort nicht.
- **Unverändert**: echte eigene Kosten bei internal und hybrid, Rechnungen, VAT, Zahlungen, Status. Altbestand ändert sich nur bei einer neuen Zeilenänderung.
- **Offen zur Entscheidung**:
  - External-Reparaturen ohne Nachweis, die eigene Arbeit bekommen, bleiben gespeichert „external“. Ob der Betrag echte eigene Kosten sind, entscheidet der Owner; er kann sie als eigene Arbeitszeile erfassen.
  - Eine bezahlte Altgebühr lässt sich nicht automatisch ersetzen: Die Werkstattzeile wird dann mit `REPAIR_COST_PAID` abgewiesen.
  - Wer den vorbelegten Spiegel unverändert speichert, „bestätigt“ ihn nicht: Er bleibt ein Spiegel, weil sich nichts geändert hat.

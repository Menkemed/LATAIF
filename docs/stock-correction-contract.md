# Bestandskorrektur — Vertrag (Phase 1 und die Grundlage von Phase 2+3 umgesetzt; Buchungen von Zugang und Anfangsbestand offen)

## Bestätigte Owner-Regeln (14.10.2026, nicht offen)

- **C1 Altbestand:** Desktop „Collection → New Item“, Handy „New Collection Item“ und der Excel-Import erfassen vorhandene eigene Ware.
- **C2 Kein Geld:** Die Erfassung bucht keine Zahlung (Kasse, Bank, Benefit), keinen Einkauf, keine Lieferantenschuld. Der eingetragene Einkaufspreis ist der historische Einstand. Vor der Freigabe der Buchhalter-Regeln wird keine Eröffnung gebucht.
- **C3 Neue Ware** nur über Purchase.
- **C4 Verkauf vor der Eröffnung** ist erlaubt; die spätere Eröffnung bucht keinen Wareneinsatz doppelt.
- **C5 Rechte:** Der Owner bucht Korrekturen und Eröffnungen am Primary und am PC2; der PC2 schreibt nie selbst, sondern über Fernbefehle am Primary. Keine Manager-Freigabe.
- Die Buchhalter-Vorlage (D1–D6, D8: Gegenkonten, Bewertung, Stichtag, frühere Verkäufe, offene Abgänge, Wertunterschied, Mehrwertsteuer, Datum späterer Eröffnungen) ist die Grundlage aller noch offenen Buchungen.

## Grundlage Phase 2+3 (umgesetzt, ohne neue Buchungen)

- **„Paid from“ entfernt** (New Collection und Artikel bearbeiten); ein gespeicherter Wert bleibt unverändert. Die Auswertung zeigt keinen „Product purchases (EK paid out, manual)“-Abfluss mehr; die Salden kommen aus dem Hauptbuch.
  - **Offener Befund:** Die übrigen Zeilen der Aufschlüsselung „Cash & Bank“ sind Tabellenaggregate, nicht das Hauptbuch. Eine Umstellung ist ein eigener Auftrag.
- **PC2:** `stock_adjustments.issue`, `.cancel` und `.add_old_stock` sind namentlich freigegebene Fernbefehle (nur Owner, zentral geprüft und noch einmal in der Hausfolge), dazu die Auskünfte `stock_adjustments.product.get` (Karte am Artikel) und `page.old_stock.get` (Vorschau). Primary und PC2 müssen gemeinsam aktualisiert werden.
- **„Add Old Stock“** (`addOldStockInHouse`): weitere Stücke Altbestand eines erfassten Artikels. Beleg `RECEIPT` mit Menge, historischem Einstand je Stück (`purchase_price_hint`), Grund, Geschäftsdatum, Protokoll und Sync; immer `ACCOUNTING_RECONCILIATION_PENDING`, Wert 0, keine Buchung. Storno nur, solange sich der Bestand seitdem nicht bewegt hat.
  - Hat der Artikel offene Abgänge, muss der Owner bestätigen, dass es andere Stücke sind (das Protokoll hält es fest). Die Wiederherstellung eines ausgebuchten Stücks wartet auf D1c.
  - Die Tabelle erlaubt dafür `direction IN ('ISSUE','RECEIPT')`; ältere Entwicklungsdatenbanken baut `stock-adjustment-schema.ts` einmal verlustfrei um.
- **Eröffnungsvorschau** (`old-stock-reconciliation.ts`, Seite „Old stock“, nur lesen, nur Owner): je Artikel (a) gebuchter Wareneinsatz netto aus dem Hauptbuch, (b) offene Abgänge, (c) Bestand × historischer Einstand, dazu V1 und V2. Dieselbe Funktion (`oldStockRowsFor`/`planOldStockOpening`) ist die Rechengrundlage der späteren Buchung, die jeden Nachweis in ihrer Transaktion erneut prüft.
  - Kandidat ist nur, was das Hauptbuch als nie aktiviert belegt. Prüffall mit Grund: INVENTORY-Sollbuchung unbekannter Herkunft, Einkauf ohne Los, Los ohne gebuchten Einkauf (Produktion, „Keep“), Menge ≠ Lose, aktivierte Reparaturkosten, Produktion, stornierter Sonderauftrag, Altzeilen mit mehreren Stücken, fehlender Einstand, gebuchter Wareneinsatz ≠ heutiger Einstand (Frage D4), gemischte Einstände nach einer Bewegung.
  - **Gemischte Einstände:** Teil (c) besteht aus Wertblöcken mit Herkunft — der Artikel-Einstand und jeder Altbestands-Beleg mit eigenem Einstand. Beispiel: 1 × 250 (Artikel) + 2 × 300 (Beleg ADJ-…) = 850, nie 3 × 250, 3 × 300 oder ein Durchschnitt.
    - Belegt ist das nur, solange sich der Bestand seit dem ersten abweichenden Beleg nicht bewegt hat (kein Verkauf, Abgang, Agent, keine Retoure) und die Menge der nach dem letzten Beleg entspricht.
    - Danach ist ohne Los nicht bekannt, welche Stücke übrig sind: Prüffall `MIXED_COST_NOT_TRACEABLE`, kein Wert, keine Summe.
    - Schon gebuchter Wareneinsatz bleibt immer wie gebucht (Teil (a) aus dem Hauptbuch).
- **Es gibt noch keine Eröffnungsbuchung.** Die Seite „Old stock“ ist eine Vorschau; sie bucht nichts und gibt keine Freigabe.
- **BLOCKED** (fail-closed, bis die Buchhalter-Regeln vorliegen): jede Eröffnungs-, Fund-, Wiederherstellungs- und Wertunterschied-Buchung; Mehrwertsteuer auf Korrekturen.
- **DEFERRED** (bewusst noch nicht gebaut, fail-closed abgewiesen):
  - „Add Old Stock“ für Artikel mit Losen — gekauft, produziert, „Keep“ und künftig eröffnet. Weitere Altbestands-Stücke eines schon eröffneten Artikels brauchen eine spätere Eröffnung je Wertblock (Phase 3, nach D8).
  - „Add Old Stock“ für Artikel mit Lagerwert-Buchung, bei Lagerbuchungen unbekannter Herkunft im Hauptbuch und für ausverkaufte Artikel; als Ausweg bleibt New Collection als neuer Artikel.
  - Ein wiedergefundenes, früher ausgebuchtes Stück: nur das Storno des Abgangs, solange sich nichts bewegt hat; die Wiederherstellung danach wartet auf D1c.
  - Der Wert gemischter Einstände nach einer Bewegung (siehe oben).
  - Der echte Zwei-Rechner-Test (Primary + PC2) ist Release-Gate, nicht Teil dieser Grundlage.

## Phase 1 — Bestandsabgang (umgesetzt, `src/core/stock/stock-adjustment.ts`)

- **Beleg:** `stock_adjustments` (Nummer `ADJ-…`, ein Artikel je Beleg), synchronisiert (insert/update).
  - Festgehalten werden Menge und Status vorher/nachher, die entnommenen Lose mit ihrem Stand davor, der gebuchte Wert und die Buchungslage.
  - Dazu Grund (Kategorie Pflicht, Text Pflicht), Geschäftsdatum (keine Zukunft), Benutzer und Aktions-ID (eine Wiederholung erzeugt keinen zweiten Beleg).
- **Herkunft des Lagerwerts, aus dem Hauptbuch bewiesen und nicht aus „Los ja/nein“:** INVENTORY wird im Soll nur an diesen Stellen bebucht.
  - Einkauf (je Einkaufszeile);
  - aktivierte Reparaturkosten am eigenen Artikel (Ausgabe „Inventory“ zur Reparatur, eigene Arbeit OWN), auch ohne Los;
  - Retoure „In Stock“: nimmt nur einen Wareneinsatz zurück;
  - Rücknahmen.
  - Produktion und „Keep“ legen Lose an, buchen aber nichts. Ein Test pinnt diese Liste.
- **Mit Los:** Entnahme nach der bestehenden Regel (ältestes zuerst).
  - Jedes entnommene Los muss aus einer Einkaufszeile mit stehender INVENTORY-Buchung stammen (oder Einstand 0 haben).
  - Gebucht wird dann Soll `INVENTORY_LOSS` an `INVENTORY` zum Einstand, Quelle `STOCK_ADJUST`. Sonst wird abgewiesen (`VALUE_NOT_PROVEN`).
- **Ohne Los:** Nur wenn nachweislich nie Lagerwert gebucht wurde: keine Einkaufszeile, keine aktivierten Reparaturkosten, und im ganzen Hauptbuch keine INVENTORY-Sollbuchung unbekannter Herkunft.
  - Dann wird nur die Menge reduziert, ohne Buchung.
  - Der Beleg trägt `ACCOUNTING_RECONCILIATION_PENDING` und den Einkaufspreis als Bewertungshinweis.
  - Diese Belege muss die spätere Anfangsbestands-Abstimmung einbeziehen. Sonst wird fail-closed abgewiesen.
- **Ausgeschlossen:** Kommission (auch über eine offene Kommission), Agent, nicht „in stock“, offene Reparatur, offene Auftragsbindung, Partnerware, Edelmetall.
- **Menge 0 nach dem Abgang:** Status `write_off` (kein Verkauf).
- **Storno:** exakt zurück (Lose, Menge, Status; bei Buchung `reverseSource`).
  - Nur solange seitdem nichts anderes am Bestand des Artikels geschah; sonst abgewiesen (`MOVED_SINCE`). Kein verkauftes Stück wird wieder verfügbar.
- **Rechte und Ablauf:** nur Owner (Admin), Karte „Stock corrections“ auf der Artikelseite; seit der Grundlage Phase 2+3 auch am PC2 über die Fernbefehle (C5).
  - Eine Transaktion mit strengem Protokoll, Wächtern für Buchung und Sync, nie automatisch.
  - Ein Artikel mit Korrekturbeleg ist nicht mehr löschbar oder zusammenführbar.
- **Wirkung:** erst mit dem nächsten Release, weil Manifest und Rust-Server zusammen ausgeliefert werden.

---

Der folgende Entwurf gilt weiter für Zugang, Anfangsbestand und alles noch Offene.

Seit F9 lassen sich Menge, Bestandsstatus und Herkunft eines Artikels nicht mehr in der Artikelbearbeitung setzen
(Primary, PC2, Handy). Für echte Korrekturen braucht es einen eigenen, kontrollierten Vorgang. Dieses Dokument legt
fest, was er leisten muss. Die mit **OFFEN** markierten Punkte brauchen eine fachliche Entscheidung, bevor gebaut wird.

## Zweck

Bestand ändern, ohne dass ein Einkauf, Verkauf oder eine Retoure dahintersteht: Fund (Zugang), Verlust, Diebstahl,
Beschädigung, Zählfehler (Abgang). Inventur-Ergebnisse dürfen solche Belege vorschlagen, aber nie selbst buchen.

## Beleg

- Eigener Beleg „Stock Adjustment“ mit Nummer (eigener Nummernkreis), Geschäftsdatum (keine Zukunft, wie überall),
  Mitarbeiter, **Grund Pflicht**.
- Zeilen je Artikel: Richtung (Zugang/Abgang), Menge. Stückware nur in ganzen Stücken (wie Verkauf und Retoure).
- Edelmetall nach Gewicht hat schon seinen eigenen Weg (Abschreibung im Bulk-Metal-Bereich) und bleibt dort.

## Abgang

- Entnahme aus genau benannten Losen (Vorschlag ältestes zuerst, wählbar) über die Losfunktionen; vorher prüfen,
  dass jedes Los die Menge hat. Nie unter 0, nie still gekappt.
- Artikel ohne Losführung: über `products.quantity`, ebenfalls nie unter 0.
- Ausgeschlossen, weil ein eigener Vorgang zuständig ist: Kommissionsware (Kommission), Stücke beim Agenten (offener
  Agentenvorgang), in Reparatur, auf einer offenen Rechnung reserviert.
- Status nur abgeleitet (aus Losen bzw. Menge), nie gesetzt.

## Zugang

- Ein eigenes Korrektur-Los (ohne Einkauf, als Korrektur gekennzeichnet) mit Menge und Einstand.
- **OFFEN — Bewertung des Zugangs:** Einkaufspreis des Artikels, letzter Los-Einstand oder manuelle Eingabe?
- Ein Artikel ohne Losführung bekommt beim ersten Zugang ein Los für seinen gesamten bisherigen Bestand, sonst verlöre
  der Abgleich aus den Losen die frühere Menge (dieselbe Lücke wie beim ersten Einkauf heute, s. F9-Audit).

## Buchung

- Abgang: Soll Bestandsverlust (`INVENTORY_LOSS`, wie bei der Edelmetall-Abschreibung) an `INVENTORY` zum Einstand der
  entnommenen Lose.
- Zugang: Soll `INVENTORY` an **OFFEN — Gegenkonto** (z. B. ein Ertrag aus Bestandsdifferenz, oder Eröffnung/Eigenkapital
  bei nachträglich erfasstem Anfangsbestand).
- Storno statt Löschen: Lose genau zurück, Buchungen über `reverseSource`; abgewiesen, wenn ein Korrektur-Los inzwischen
  verbraucht ist.

## Ablauf und Absicherung

- Eine Hausfunktion, am Primary über `runOnPrimary`, vom PC2 über einen Fernbefehl mit derselben Funktion; alles in einer
  Transaktion. Gescheiterte Buchungen (`watchLedgerPosts`) und nicht geschriebene Sync-Einträge (`watchSyncTracks`) nehmen
  den ganzen Vorgang zurück.
- Protokoll streng (`logAuditOrThrow`) mit Vorher/Nachher je Zeile.
- Sync: der neue Beleg samt Zeilen im Manifest (insert/update), die Los-, Artikel- und Buchungszeilen wie bisher. Das
  wirkt erst mit dem Release, das Manifest und Rust-Server zusammen ausliefert.
- **OFFEN — Berechtigung:** eigenes Recht, nur Manager/Admin? Vom PC2 erlaubt? Freigabe durch eine zweite Person ab
  einem Betrag?

## Ebenfalls offen (eigene Entscheidung)

- **Anfangsbestand / Eröffnung:** Artikel aus dem Excel-Import oder manuell bzw. vom Handy angelegt haben eine Menge,
  aber kein Los und keine Buchung (kein Lagerwert in der Buchhaltung). Ob und wie sie einen Anfangsbestand mit
  Eröffnungsbuchung bekommen, ist eine eigene fachliche Entscheidung.
- **Manuelle Merker „reserved“/„offered“:** Seit F9 nicht mehr setzbar. Angebot und Auftrag setzen sie weiterhin selbst.
  Ein manuelles „zurückgelegt“ für einen Kunden wäre ein eigener, umkehrbarer Vorgang, kein Statusknopf.

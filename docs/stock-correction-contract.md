# Bestandskorrektur — Vertrag (Phase 1 umgesetzt, Zugang und Anfangsbestand offen)

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
- **Rechte und Ablauf:** nur Owner (Admin), nur am Primary (Karte „Stock corrections“ auf der Artikelseite); PC2 wird abgewiesen.
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

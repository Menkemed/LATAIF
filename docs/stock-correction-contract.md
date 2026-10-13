# Bestandskorrektur — künftiger Vertrag (Entwurf, NICHT umgesetzt)

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

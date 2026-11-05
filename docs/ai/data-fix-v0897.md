# Datenkorrektur v0.8.97 – vorbereitet, nicht ausgeführt

Skript: `scripts/data-fix-v0897.mts`. Es läuft nur bei geschlossener App und nur nach gesonderter Owner-Freigabe.

## Was es tut

**A – Altbestand VAN-BGJ-005 und VAN-BGJ-006.** Der Einkauf PUR-2026-000024 vom 03.11.2026 lief noch ohne F1-Fix und hat den Altbestand überschrieben. Das Skript holt die Altstücke als eigenes Los zurück, genau wie v0.8.97 sie bei diesem Einkauf angelegt hätte:
- Das Los hat keinen Einkauf und keine Buchung. Der Einstand ist der historische, `acquired_at` ist der Eingangstag des Artikels. Beim Verkauf gehen die Altstücke deshalb zuerst (FIFO).
- Die Menge ist danach die Summe der Lose.
- Einkaufslos, Einkauf und Hauptbuch bleiben unverändert.

| Artikel | gezählt | ERP | Altlos | Einstand |
|---|---|---|---|---|
| VAN-BGJ-005 | 7 | 4 | +3 | 190 BHD (Owner; seit 20.10. als Einkaufspreis gespeichert; Wingold Jewe-13148 „sicher“) |
| VAN-BGJ-006 | 2 | 1 | +1 | **140 BHD**, vom Owner am 05.11.2026 endgültig bestätigt (Wingold Jewe-13127 „butterfly Neckl · mop“). In den ERP-Daten stand in allen Fassungen 0. |

Beide Einstände stehen fest im Skript. Es gibt keinen Schalter dafür; ein unbekannter Schalter wird abgewiesen.

Auf der Kopie vom 04.11. hat sonst kein Artikel überschriebenen Altbestand.

**B – Diamond Weight bei 77 Gold-Diamond-Artikeln.** Das Gewicht wird mit der kanonischen Steinlogik (`normalizeStoneAttributes`) aus den Diamantzeilen berechnet und gespeichert. Nur `attributes.diamond_weight` kommt dazu. Steinzeilen, Preise, VAT, Mengen, Buchungen und `updated_at` bleiben, wie sie sind.

v0.8.97 zeigt dieses Gewicht auf Karte, Merkmalliste, Artikelansicht und Etikett schon ohne Nachtrag; das ist für 77 von 77 geprüft. Der Nachtrag schließt zwei Lücken:
- Die Handy-Artikelansicht zeigt die Summe „Diamond Ct“ nur, wenn das Gewicht gespeichert ist. Die einzelnen Steinzeilen mit Karat zeigt sie immer.
- Rechner, die noch v0.8.96 haben, lesen nur das gespeicherte Feld.

29 Artikel haben Diamantzeilen ohne Karat. Ihr Gewicht ist nicht bestimmbar; sie sind als Prüfbedarf gelistet und bleiben unverändert.

## Sicherheit

- **Plan:** Ohne `--apply` gibt es nur Plan und Prüfungen; die Datei bleibt bytegleich.
- **Transaktion:** Alles läuft in einer Transaktion. Jede Vorbedingung ist hart (Menge, Lose, Einkaufslos samt Kosten, keine Verkäufe, keine Korrekturen). Eine Abweichung führt zum Abbruch ohne jede Änderung.
- **Nachkontrolle in der Transaktion:**
  - Hauptbuch, Einkäufe, Einkaufszeilen, Rechnungen, Rechnungszeilen, Zahlungen, Ausgaben und Bestandskorrekturen sind bytegleich.
  - Nur die erwarteten Artikel sind geändert, und nur in den erwarteten Spalten.
  - Bestehende Lose sind unverändert.
  - `integrity_check` ist in Ordnung.
- **Idempotenz:** Ein zweiter Lauf meldet „bereits korrigiert“ und ändert nichts.
- **Spuren:** Je Änderung gibt es eine Zeile in `audit_log` und eine in `sync_changelog`, wie bei `logAudit`/`trackChange`.

## Auf der Kopie geprüft (04.11.2026, Kopie sha 760bfad4…)

- **Plan:** Die Datei bleibt unverändert.
- **Anwenden:** 2 Altbestands-Korrekturen und 77 Gewichtsnachträge. Geschützte Tabellen sind unverändert, Protokoll und Änderungsliste haben je +81 Zeilen.
- **Endgültige Fassung (05.11.2026, frische Kopie):** 005 bekommt 3 × 190, 006 bekommt 1 × 140. Danach stehen die Mengen bei 7 bzw. 2, das Hauptbuch bei 301 Zeilen wie vorher. Die Wiederholung ist bytegleich, und `--cost006` wird abgewiesen.
- **Wiederholung:** ändert nichts, die Datei ist bytegleich.
- **Gegenprobe:** Mit abweichender Menge bricht das Skript ab und ändert nichts.
- **FIFO mit dem echten Abfrageweg** (`getActiveLots`):

  | Artikel | Reihenfolge | Lagerwert |
  |---|---|---|
  | 005 | 3 × 190 Altbestand vor 4 × 180 Einkauf | 1290 |
  | 006 | 1 × 140 vor 1 × 130 | 270 |

- **Gate auf der Prod-Kopie mit v0.8.97:** 25/0 auf der korrigierten Kopie. Beide Starts lassen Bestand, Lose und Merkmale unverändert.

## Reihenfolge für die Echtdaten

1. **Werte:** Der Owner hat sie bestätigt (05.11.2026). Das Ausführen selbst braucht eine eigene Freigabe.
2. **v0.8.97 installieren:** v0.8.97 ist seit 05.11.2026 veröffentlicht. Zuerst den Primary installieren, gleich danach PC2. Unter v0.8.96 bleibt der F1-Fehler für andere Artikel aktiv. Für den korrigierten Zustand selbst ist die Version egal, denn der Leseweg von Losen und Mengen ist in beiden gleich.
3. **App schließen:** auf PC2 und auf dem Primary.
4. **Sicherung:** vollständige Sicherung von `E:\LATAIF\Data`, danach prüfen.
5. **Plan prüfen:**
   ```
   node scripts/data-fix-v0897.mts E:\LATAIF\Data\lataif.db
   ```
6. **Anwenden:** derselbe Aufruf mit `--apply`.
7. **Nachkontrolle:** dasselbe noch einmal; erwartet wird „bereits korrigiert“.
8. **App starten und prüfen:** VAN-BGJ-005 zeigt 7, VAN-BGJ-006 zeigt 2, Stichproben der Gold-Diamond-Karten und -Etiketten stimmen.

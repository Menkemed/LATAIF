# K5 – Korrektur ORD-2026-00002 und Installation (vorbereitet, nicht ausgeführt)

Skript: `scripts/k5-ord2-fix.mts`. Es läuft nur bei geschlossenen Apps (Primary und PC2), nur nach der Installation der
neuen Version und nur nach gesonderter Owner-Freigabe. Nichts davon ist an den Echtdaten ausgeführt.

## Was K5 tut (Owner-Daten, Preview V4 §8)

| | vorher (Produktion 06.11.2026) | nachher |
|---|---|---|
| Order-Datum | 05.11.2026 | **25.10.2026** |
| Fertigstellung (Actual Delivery) | leer | **25.10.2026** |
| Kopf „Deposit date" | 05.11.2026 | **25.10.2026** (Tag der Kartenzahlung) |
| Kartenzahlung 240 (Karte, Normal) | 25.10.2026, Karten-Clearing | unverändert |
| Kartengebühr EXP-2026-000005 (2,4 % = 5,760) | gebucht 05.11.2026 | **25.10.2026**, Betrag gleich („Edit Expense": Storno am Tag der Ausführung, Neubuchung am 25.10. gegen das Karten-Clearing) |
| Lohn 25,000 Arup | keine Verbindlichkeit | **Lager an Lieferantenschuld Arup am 25.10.2026**, offen, Zahlweg bank |
| Goldschuld Arup 4,330 g 21K | offen, ohne Wert | offen, **Buchwert 185,000: Lager an GOLD_LIABILITY Arup am 25.10.2026** |
| Steuerart / Preis / Status | Zero 0 % / 240 / completed | unverändert |
| Rechnung / Artikel / Goldbestand | keine | keine (die Rechnung erstellt danach der Owner) |

Hauptbuch danach: Lager +210,000; Lieferantenschuld Arup −25,000; Goldschuld Arup −185,000; sonst bewegt sich kein Saldo.
Kundenanzahlung 240 bleibt offen bis zur Rechnung.

## Sicherheit des Skripts

- Es läuft der **echte Code der neuen Version**: Datumskorrektur (K4), „Edit Expense" der App, `commitOrderLineExpenses` (K1).
- Ohne `--apply`: nur Plan und Prüfungen, die Datei bleibt bytegleich.
- Alle festen Kennungen von ORD-2 stehen im Skript. Jede Abweichung vom erwarteten Stand bricht ab, bevor etwas
  geschrieben wird: Auftrag, drei Positionen, eine Kartenzahlung samt Buchung, Goldschuld, Gebühr, storniertes
  EXP-2026-000004, Schema der neuen Version, offene Periode am 25.10.
- Eine Klammer. Vor dem Festschreiben vergleicht das Skript jede Tabelle Zeile für Zeile. Geändert sein dürfen nur:
  1 Auftrag, 1 Position, 1 neue Ausgabe und die umdatierte Gebühr, 1 Goldschuld, 8 neue Buchungen, Protokoll,
  Änderungsliste und Zähler. Weiter geprüft werden die Kontensalden (Lager +210, Arup −25 / −185, sonst 0), das
  ausgeglichene Hauptbuch und `integrity_check`. Stimmt eine Prüfung nicht, wird alles zurückgenommen.
- Die Datei wird atomar ersetzt (temp → fsync → rename) und danach frisch auf `integrity_check` geprüft.
- **Idempotent:** Ein zweiter Lauf meldet „NICHTS ZU TUN" und lässt die Datei bytegleich.

## Auf der Kopie geprüft (06.11.2026, Produktions-DB sha f4dd35f7…, nur gelesen)

Gate `scratchpad/k5/k5-gate.mjs` mit der isolierten neuen Version (E2E-Build, `com.lataif.app.e2e`, Port 3011):

- K5 auf dem alten Stand vor dem ersten Start der neuen Version: Abbruch, Datei unverändert (das Schema fehlt).
- Erststart der neuen Version: neue leere Tabellen `gold_payable_settlements`, `order_deposit_applications`.
  Keine fachliche Zeile ändert sich (nur der tägliche `days_in_stock` und `categories.updated_at` des Kategorie-Abgleichs,
  wie bei jedem Start). Die Hauptbuch-Salden sind gleich.
- K5:
  - Plan: drei Schritte.
  - Anwenden: genau die erwarteten Zeilen, 8 neue Buchungen, Salden Lager +210 / AP −25 / GOLD_LIABILITY −185.
  - Zweiter Lauf: nichts zu tun, bytegleich.
  - Neustart der App auf dem korrigierten Stand: keine fachliche Änderung. Dritter Lauf: nichts zu tun.
- Danach, nur im Speicher, die Schritte des Owners: Rechnung Zero am 25.10.
  - Ergebnis: INV 240, durch die Anzahlung voll bezahlt (FINAL), Artikel ITM-GLD-nnn mit Herkunft ORD-2026-00002.
  - Wareneinsatz 210 gegen Lager 210. Kein neues Geld, keine neue Gebühr, Banking unverändert.
  - Zweite Umwandlung: Nein, kein Duplikat.
  - Goldschuld in BHD: Einstand an der Rechnung berichtigt, VAT bleibt 0. Ihre Rücknahme stellt alles wieder her.
- 27 von 29 Prüfungen sofort grün. Die zwei übrigen waren zu streng formulierte Startprüfungen. An denselben Dateien
  ist spaltengenau bestätigt: nur `categories.updated_at` (cat-gold-jewelry) und `products.days_in_stock`.

## Ablauf für Primary und PC2 (jeder Schritt mit Owner)

**0 Freigaben:** Push, Release der neuen Version, Installation, K5-Ausführung — je gesondert.

**1 Release vorbereiten (nach Freigabe):** Branch per Fast-Forward auf `main`, Version 0.8.98, Release-Build und
Signatur wie bei v0.8.97 (`scripts/release.mjs`, Draft → prüfen → veröffentlichen). Das Release enthält auch die schon
auf `origin/main` liegenden, noch nicht veröffentlichten Pakete (Bulk-Metal-Steuerart, Listen-Navigation).

**2 Vorbereitung:**
- PC2: „Unresolved saves" leer, App schließen. Primary: App schließen.
- Datenbanken 60 s ruhig (Hash gleich).

**3 Sicherung 1 – „vor-v0.8.98":** vollständige Sicherung von `E:\LATAIF\Data` (beide Datenbanken, WAL, Medien,
Schlüssel) nach `E:\LATAIF\Manual-Backups\<Datum>_vor-v0.8.98` und `F:\LATAIF-Backups\…`.
- Vorlage: `scratchpad/inst/backup-vor-datenfix-0897.cjs` und `copy-to-f-0897.cjs`, mit neuem Zielnamen.
- Prüfung: Hash je Datei gegen das Manifest, `integrity_check`, Restore-Gate (isolierte App startet auf der Sicherung).
- Den v0.8.97-Installer behalten (`E:\LATAIF\Installer\v0.8.97`).

**4 Primary installieren:**
- Installer v0.8.98 mit `/S /UPDATE` ausführen, einmal starten (Startmigrationen), als Owner anmelden.
- Sichtprüfung: ORD-2 öffnet; „Create Invoice" lehnt noch ab (`CUSTOM_COSTS_NOT_BOOKED` — gewollt bis K5).
- App schließen, 60 s Ruhe.

**5 Sicherung 2 – „vor-K5":** nur `lataif.db` (nach den Migrationen) auf E: und F:, Hash festhalten.

**6 K5 ausführen** (aus dem Release-Stand des Repos, Primary-Rechner):
```
node --experimental-strip-types scripts/k5-ord2-fix.mts E:\LATAIF\Data\lataif.db
node --experimental-strip-types scripts/k5-ord2-fix.mts E:\LATAIF\Data\lataif.db --apply
node --experimental-strip-types scripts/k5-ord2-fix.mts E:\LATAIF\Data\lataif.db --apply
```
- Erster Aufruf (Plan): genau `A/B/C KORREKTUR`, `PLAN: 3`, wie auf der Kopie.
- Zweiter Aufruf (`--apply`): `ANGEWENDET` mit SHA vorher/nachher.
- Dritter Aufruf (Wiederholung): `NICHTS ZU TUN`.
- Danach Vollvergleich gegen Sicherung 2 (`scratchpad/inst/diff-db.cjs`) und Saldenabgleich wie auf der Kopie.

**7 Primary starten und prüfen:**
- ORD-2: Order Date, Actual Delivery und Deposit Date stehen auf 25.10.2026.
- Ausgaben: EXP-2026-000005 am 25.10.; neue Ausgabe Arup 25,000 offen.
- Arup: Goldschuld 4,330 g offen.
- Banking: Karte 240 am 25.10.

**8 PC2 installieren:** v0.8.98, verbinden, dieselbe Sichtprüfung am PC2.

**9 Rechnung durch den Owner:** ORD-2 → „Create Invoice".
- Im Dialog Steuerart **Zero** und Rechnungsdatum **25.10.2026** prüfen. Die Anzahlung deckt 240 voll, die Rechnung ist
  danach FINAL und nur noch über eine Retoure korrigierbar.
- Erwartet: Rechnung 240 bezahlt, Artikel ITM-GLD-nnn. Die Goldschuld kann danach in BHD beglichen werden.

## Wiederherstellung

- **K5 bricht ab:** Es ist nichts geändert (eine Klammer). Ausgabe sichern, nicht wiederholen, prüfen.
- **K5 angewendet, aber eine Prüfung in Schritt 7 stimmt nicht:** Das gilt nur, solange noch nichts Neues gebucht ist.
  Apps schließen, `lataif.db` aus Sicherung 2 zurückkopieren, Hash prüfen, starten. Danach ist der Stand wie nach Schritt 4.
- **Die neue Version selbst macht Probleme:** Apps schließen, v0.8.97 neu installieren, Sicherung 1 vollständig
  zurückspielen (beide Datenbanken, Medien, Schlüssel), Hash prüfen, starten — Primary zuerst, dann PC2. Alternativ geht
  das über Einstellungen → Sicherung → Wiederherstellen mit Datenverlustschutz (v0.8.86).

## Go / No-Go

**Go (lokal belegt):**
- TS grün, Node-Sweep, gezielte Unit-, Ledger-, VAT- und Storno-Tests, E2E Primary/PC2 (Belege im Abschlussbericht).
- K5 auf der Produktionskopie geprüft.

**Vor Go noch nötig (Owner):**
- Freigabe für Push, Release und Installation.
- Freigabe für die K5-Ausführung.
- Bestätigung, dass Bulk-Metal-Steuerart und Listen-Navigation mit ins Release gehen.

**Bewusst offen, kein Blocker für ORD-2:**
- OF1 (VAT-Korrektur in geschlossenen Quartalen — ORD-2 ist Zero), OF2 (Analytics-Anzeige).
- G1–G3 und K3b (eigenes Gold, Werkstattgold), OF6 (Goldhändler in GOLD SOURCE, Retoure mit Differenz, D1-Retouren).

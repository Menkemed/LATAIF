# Mixed Invoice P1–P5 — Release- und Installationsplan (vorbereitet, nicht ausgeführt)

Inhalt des Releases **v0.8.99**: P2–P5 der gemischten Rechnung (P1a–P1c sind seit v0.8.98 ausgeliefert), dazu die Release-Korrekturen „Pick product…", PC2-Leiste „Unresolved saves" und die einheitliche Margin VAT (VAT-CONSISTENCY, G4; Vertrag §2). Regeln: `docs/mixed-invoice-contract.md`. Allgemeiner Ablauf: `docs/ai/upgrade-runbook.md` — dieser Plan konkretisiert ihn.

**Jeder Schritt braucht eine eigene Owner-Freigabe:** Push, Release, Sicherung, Installation Primary, Installation PC2. Produktions-Apps schließt nur der Owner. Nichts davon ist ausgeführt.

## 0 Ausgangslage

| | Stand |
|---|---|
| Primary | v0.8.98 installiert (07.11.2026), K5 angewendet, SINV-2026-000008 gebucht. Produktionsvorfall vom 07.11. 18:47 behoben (P5-Fremdspalten entfernt, SINV-2026-000014 neu erfasst und geprüft) |
| PC2 | **v0.8.97** (das Update auf v0.8.98 steht noch aus). Vor jeder produktiven Nutzung Version und „Unresolved saves" prüfen. |
| Sicherungen | `2026-11-07_vorfall-1847` (Beweissicherung, nicht zurückspielen) und `2026-11-07_nach-vorfall` (jüngster vollständiger Stand, bei laufender App erstellt) auf E: und F:. Für die Installation trotzdem neu: §3. |
| Handy | Seite kommt vom Primary (immer dieselbe Version) |
| Code | `feature/mixed-invoice-p2` = v0.8.98 (`112c03be` = origin/main) + P2, P3, P4, E5/E9, P5 und die Release-Korrekturen; lokal, nicht gepusht |
| Schema | einzige Änderung gegenüber v0.8.98: `consignments.group_id/group_seq/group_quantity` + Index (additiv, automatisch beim ersten Start) |

Weil PC2 noch v0.8.97 hat, springt er direkt auf die neue Version. Zwischenstände (alter PC2 am neuen Primary) sind nur für die Minuten zwischen den Installationen erlaubt, siehe §5.

## 1 Release (lokal vorbereitet; Push, Tag und Veröffentlichung nur mit Freigabe „push + release")

Lokal erledigt:
- Release-Commit „release: v0.8.99 vorbereitet": Version in den vier Dateien, `RELEASE_NOTES_v0.8.99.md`.
- Gates auf dem Release-Commit: TS, `cargo test --lib` und der signierte Release-Build im Arbeitsbaum `desktop-mixed-p2`, nie im P2-Ordner `desktop`.
- `e2e-binary-identity` mit diesem Build.
- Staging `E:\software\lataif\release-staging\v0.8.99`: Installer, `.sig`, `latest.json` ohne BOM, `SHA256SUMS.txt`. Signatur gegen den Updater-Schlüssel geprüft.
- Der Versions-Commit ändert keinen Code. Node-Gesamtlauf und E2E-Liste (Abnahmematrix §6) gelten deshalb vom Code-Stand `0cbbfdee`.

Mit Freigabe:
1. `feature/mixed-invoice-p2` per Fast-Forward nach `origin/main` pushen (`112c03be` ist Vorfahr).
2. Annotierten Tag `v0.8.99` auf den Release-Commit setzen und pushen.
3. Draft mit genau den Staging-Dateien anlegen, Draft-Dateien bytegleich zum Staging prüfen, dann „Latest" setzen.
4. Prüfen, dass der Updater-Endpunkt `latest.json` mit 0.8.99 liefert.

Den Installer v0.8.98 aufbewahren (`E:\LATAIF\Installer\v0.8.98`); er ist der Rückweg.

Achtung: Sobald das Release „Latest" ist, zeigen beide Rechner das Update-Banner. Auf PC2 **nicht** klicken, bevor der Primary installiert ist.

## 2 Ruhe herstellen (Owner)

- **PC2 zuerst:** Leiste „Unresolved saves" ansehen. Offene Einträge mit „Clarify now" klären, nichts blind entfernen (bekannter Altfall TUD-WCH-003 vom 01.11. — gemeinsam ansehen). Danach PC2 schließen.
- Handy: keine Eingaben.
- Primary schließen.
- Prüfen (nur lesend): `lataif.db` und `lataif_sync_server.db` mindestens 60 s hash-gleich, kein LATAIF-Prozess. In einer Kopie: `remote_command_ledger` nur `completed`/`rejected`, `sync_change_quarantine` leer.

## 3 Sicherung „vor-v0.8.99" (Owner-Freigabe)

- Vollständig von `E:\LATAIF\Data` nach `E:\LATAIF\Manual-Backups\<Datum>_vor-v0.8.99` und `F:\LATAIF-Backups\<Datum>_vor-v0.8.99`: beide Datenbanken (+ WAL/SHM), alle Mediendateien, Ablagen (`mobile-upload-staging`), Schlüssel. Vorlage: die Skripte der v0.8.98-Sicherung (`scratchpad/inst/…`), neuer Zielname.
- Manifest von beiden Platten neu lesen: 0 Abweichungen, Zahl der Mediendateien = Live-Ordner, `integrity_check` ok. `WIEDERHERSTELLUNG.md` hineinlegen (Rückweg: diese Sicherung + Installer v0.8.98).
- **Startprobe auf der Sicherung** (isolierter Release-Kandidat, `com.lataif.app.e2e`, Port 3011, nie die Produktion): Erststart = Migration, Vollvergleich, Salden gleich, zweiter Start ohne Wirkung. Vorlage `scratchpad/rel99/start-probe-p5.mjs` (Quelle auf die neue Sicherung umstellen).
  - **Pflicht seit dem Vorfall vom 07.11.:** In den Testordner kommt **nur `lataif.db`**, nie der Inhalt von `_schluessel/` (dort liegt `data-location.json` mit `E:\LATAIF\Data`). Vor dem Start darf im Testordner kein Datenort-Zeiger liegen; nach dem Start muss der Zeiger der App auf den Testordner zeigen.
  - Doppelt abgesichert: `e2ePreflight` bricht bei einem Zeiger außerhalb von Testordner/Temp ab, und die Test-App verweigert im Automations-Build jeden solchen Datenort vor dem ersten Zugriff (`e2e_assert_isolated_data_root`). Nachweis `test/e2e-safety/locator-isolation.test.ts` und `test/e2e-safety/data-root-isolation.e2e.mjs`.
  - Prüfskripte lesen `E:\LATAIF\Data` nicht, auch nicht zum Hashen; geprüft wird an den Sicherungen.
  - Auf der jüngsten vorhandenen Sicherung ist die Probe grün (siehe §8).

## 4 Primary installieren (Owner-Freigabe)

1. Installer aus dem Staging (SHA gegen `SHA256SUMS.txt`, Signatur gültig) mit `/S /UPDATE` ausführen.
2. Einmal starten (Startmigrationen), als Owner anmelden, nichts buchen. Schließen, 60 s Ruhe.
3. Prüfung nur lesend gegen die Sicherung (Vorlage `scratchpad/inst/nach-install-0898.cjs`, erlaubte Tabellen anpassen):
   - Version 0.8.99, `integrity_check` ok.
   - Neu sind nur die drei Gruppenspalten (alle leer) und der Index; keine fachliche Zeile neu, weg oder geändert (erlaubt: `categories.updated_at`, `products.days_in_stock`, Protokoll, Sitzungen).
   - Hauptbuch-Salden gleich der Sicherung, jede Buchung ausgeglichen.
   - Margin VAT: `E:\software\lataif\vat-pruefung\2026-11-07\historie.ts` auf der Sicherung „vor-v0.8.99" (Quelle umstellen). Erwartet sind 0 Abweichungen; sonst gilt der Korrekturvorschlag dort, nichts automatisch.
4. Erst dann §5.

## 5 PC2 installieren (direkt danach, Owner-Freigabe)

- Update-Banner auf PC2 anklicken bzw. Installer ausführen (0.8.97 → 0.8.99), anmelden.
- Nur ansehen, nichts buchen: eine bestehende Rechnung mit eigener Ware unter „Edit Invoice" öffnen (eigene Zeilen zeigen ihren Artikel, kein „Pick product…"), dann **Cancel**. Kommissionen „Items" öffnen (Einzelkommissionen wie bisher). „Unresolved saves" bleibt leer.
- Mischbetrieb bis dahin: ein alter PC2 am neuen Primary bekommt beim Kommissionsverkauf klare Neins (`CONSIGNOR_VAT_REQUIRED`, `VAT_SHORTFALL_UNCONFIRMED`); ein neuer PC2 an einem alten Primary bekäme „unknown field". Gebucht wird in beiden Fällen nichts — deshalb zwischen §4 und §5 an PC2 nichts eingeben.

## 6 Handy (Owner)

- Kommissionsseite öffnen: Liste lädt, eine Kommission öffnen; beim „New intake" steht das Feld „Quantity" (nicht speichern).

## 7 Erste echte Nutzung (Entscheidung des Owners, nicht Teil der Installation)

Eine erste gemischte Rechnung bzw. Gruppenaufnahme ist eine echte Buchung. Vorschlag: zuerst eine kleine Aufnahme mit Menge 2 am Primary, Detail „Group" ansehen, dann ein Stück über „Record Sale" verkaufen; anschließend lesende Prüfung (Salden, Einkauf beim Einlieferer, Rest 1).

## 8 Bereits auf isolierten Kopien geprüft (07.11.2026)

- Migrationslauf (Migrationsliste) auf einer Kopie der Produktionsdaten (Stand v0.8.98): neu sind nur die drei Spalten (leer) und der Index; alle 13 441 Zeilen in alten Spalten unverändert, außer was schon der v0.8.98-Start nachzieht (`categories`); zweiter Lauf ohne Wirkung (`scratchpad/p5/migrate-copy.mjs`, 11/0).
- Startprobe der neuen Version (echte Test-App, Automations-Build mit Laufzeitsperre) auf `lataif.db` aus `2026-11-07_nach-vorfall` (Hash gegen Manifest): **18/0**. Testordner vor dem Start ohne Zeiger, Datenort der App = Testordner; einzige Schemaänderung die drei Gruppenspalten + Index, bestehende 2 Kommissionen ohne Gruppe, keine fachliche Zeile neu/weg/geändert (nur `categories.updated_at`), Hauptbuch-Salden gleich; zweiter Start ohne Wirkung; Sicherung danach bytegleich. `E:\LATAIF\Data` nicht berührt.
- Isolationsnachweis vorher im selben Lauf: `data-root-isolation` **6/0** (Zeiger auf einen fremden Ordner → Testtreiber bricht ab; Test-App ohne Testtreiber beendet den Start mit „E2E ISOLATION", fremder Ordner unverändert, keine Datenbank angelegt).
- Wiederherstellung in der neuen Version (Settings → Backup & Restore, echter Neustart-Pfad): `restore-safety` **45/0**; Datenort-Umzug `data-root-move` **55/0**.
- Margin VAT (VAT-CONSISTENCY): `test/vat/margin-vat-consistency.test.ts`. Gegenprobe auf dem alten Stand `9caab992`: 27 Prüfungen rot, darunter 36,364 statt 21,818 und die doppelte Auswertung.
- Historische Prüfung auf einer Kopie der Sicherung `nach-vorfall` (nur gelesen; Ergebnis in `E:\software\lataif\vat-pruefung\2026-11-07\`):
  - 6 Margin-Zeilen in 4 Rechnungen, keine Abweichung, Hauptbuch = NBR.
  - Kein G4-Fall, kein Quartal geschlossen.
  - Nur die Anzeige „Total VAT" zeigte 60 statt 30.
  - Keine Korrektur nötig; nach der Installation dieselbe Prüfung auf „vor-v0.8.99" wiederholen.
- Versionswechsel auf Befehlsebene: `test/p5/consignment-quantities.test.ts` §13. PC2 hält keine Datenbank; Primary und PC2 lesen dasselbe Sync-Manifest (Rust bindet es beim Bau ein), der Drift-Test `test/m6b3a/manifest-drift.test.ts` ist grün.

## 8a Lehre aus dem Vorfall vom 07.11.2026

Eine Startprobe übernahm `data-location.json` aus einer Produktionssicherung; die Test-App öffnete `E:\LATAIF\Data\lataif.db` und schrieb die P5-Startmigration hinein. Die laufende v0.8.98 verweigerte danach jedes Speichern (Stale-Write-Schutz); eine Rechnung stand nur im Arbeitsspeicher. Behoben ohne Datenverlust (Beweissicherung, gezielte Entfernung der drei Spalten und des Index, Neuerfassung). Seitdem: Zeigerprüfung im Testtreiber, Laufzeitsperre in der Test-App, Startprobe nur mit `lataif.db`, kein Lesen von `E:\LATAIF\Data` durch Prüfskripte.

## 9 Rückweg

| Zeitpunkt | Weg |
|---|---|
| Vor §5, nichts gebucht | Apps schließen, `E:\LATAIF\Data` beiseite kopieren (nichts löschen), Sicherung „vor-v0.8.99" zurückspielen (Hash gegen Manifest), Installer v0.8.98 ausführen, starten, Salden gegen die Sicherung prüfen. |
| Nach §5, nichts gebucht | wie oben, zusätzlich PC2 auf v0.8.98 (oder 0.8.97 lassen, wenn noch nicht installiert). |
| Nach den ersten Buchungen | Kein Zurückspielen ohne Datenverlust. Fehler werden vorwärts korrigiert; Rückspielen nur nach Entscheidung des Owners und mit Liste der seitdem gebuchten Vorgänge. |

Eine ältere App allein reicht nie: Die migrierte Datenbank trägt die Gruppenspalten, und eine v0.8.98-App würde Kommissionszeilen mit diesen Feldern in ihrer eigenen Synchronisierung abweisen.

## 10 Release Notes v0.8.99

Verbindlicher Text: `RELEASE_NOTES_v0.8.99.md` (englisch, wie v0.8.98). Er enthält die G4-Netto-Regel (Vertrag §2) und die dokumentierte Grenze zur Margin-Berechtigung.

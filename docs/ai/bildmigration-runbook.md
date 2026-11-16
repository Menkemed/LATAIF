# Runbook: Bildspeicher verkleinern (bestehende Bilder auf 60/30/10 KB)

Stand: 16.11.2026. Vorbereitet und auf einer isolierten Kopie vollständig geprüft. **Produktiv noch nicht ausgeführt.**

Jeder der folgenden Schritte braucht eine eigene Owner-Freigabe:
1. Release mit diesem Code
2. Installation am Primary
3. der produktive Migrationslauf
4. später, getrennt: das Löschen alter Bildfassungen

## Was gemacht wird

Bestehende Bilder bekommen dieselben Größen wie neue Bilder:

| Bildtyp | Grenze |
|---|---|
| Uhren | Hauptbild 60 KB |
| Schmuck (Gold, Branded, Original) | Hauptbild 30 KB |
| Accessories | Hauptbild 30 KB |
| Vorschaubilder | 10 KB |
| Reparaturen ohne erkennbare Kategorie | 60 KB |
| Aufträge, Inbox, Altgold mit Schmuck-/Accessory-Kategorie | 30 KB |
| Aufträge, Inbox, Altgold sonstige/unbekannt | 60 KB |
| Ausweise / ID-Dokumente | unverändert 100/20 KB, werden nie angefasst |

Mehrfach genutzte Bilder bekommen die größere (sichere) Grenze. Inbox und Altgold haben in der Datenbank keine Kategorie; sie bekommen deshalb 60 KB. Heute gibt es keine solchen Bilder.

Je Bild entsteht eine neue, kleinere Fassung (Generation n+1). Der Zeiger wird umgestellt, die alte Fassung wird `superseded`. Sie bleibt auf der Platte.

Unverändert bleiben:
- Medien-IDs und Bildzuordnungen
- Artikel und Preise
- pHash und Embedding
- `sync_changelog`, `audit_log` und die Buchhaltung

Übersprungen werden:
- Bilder, die schon klein genug sind
- Bilder mit weniger als 10 % Ersparnis
- Ausweise und Bilder höherer Sicherheitsklassen
- Bilder fremder Besitzer (Kunde, Lieferant, Dokument …)
- historisch entfernte Bilder

## Sicherheit im Code

**Einstieg und Rechte:**
- Einstieg nur über **Settings → Data Repairs → „Make stored images smaller"**. Kein automatischer Lauf, auch nicht beim App-Start.
- Owner-Rolle, Primary sowie Grund und Name der geprüften Vollsicherung werden im Ausführungspfad geprüft (`image-store-migration-wiring.ts`).
- Die Owner-Rolle wird zusätzlich vor jedem Paket erneut gelesen.

**Wartungsmodus während des Laufs:**
- Rust (`maintenance.rs`) weist verändernde PC2-Aufträge, Ablagen, Dokumente, Inventur-Checks und Handy-Uploads mit 503 `MAINTENANCE_ACTIVE` ab. Die Antwort trägt `outcome: not_executed`.
- Das Handy behält den Upload und versucht es später erneut.
- Der Renderer weist dieselben Aufträge ein zweites Mal ab, und der Handy-Drain verarbeitet nichts.
- Lesen bleibt erlaubt.
- Der Wartungsmodus endet immer: nach dem Lauf, bei Fehler oder Stop, und bei einem Neustart.

**Pakete zu 10 Bildern:**
- Jedes Paket läuft im einen exklusiven Schreibplatz: Schreib-Warteschlange → Medien-Sperre → DB-Lease.
- Jedes Paket endet mit durablem Speichern.
- Eine zweite offene Transaktion gibt es nie. Das war die frühere Kollision mit PC2-Aufträgen.
- PC2 sieht nur gespeicherte Bildschlüssel.

**Stop, Absturz, Protokoll:**
- „Stop" hält nach dem laufenden Bild an; das Paket wird gespeichert, und es bleibt keine Datei ohne Zeile.
- Nach einem harten Absturz bleiben höchstens die Dateien des letzten Pakets ohne Zeile. Die Wiederaufnahme erzeugt sie bitgleich und übernimmt sie.
- Protokoll: `<Datenordner>\maintenance-logs\<runId>.jsonl`, der Probelauf als `<runId>-dry.jsonl`. Es enthält nur Kennungen und Zahlen.

## Ablauf der späteren produktiven Ausführung

**A. Ruhe herstellen:**
- An PC2 ist „Unresolved saves" leer, danach PC2 schließen.
- Kein Handy-Upload läuft.
- LATAIF am Primary schließen.

**B. Vollsicherung auf E: und F:**
Diese Sicherung **dauerhaft aufbewahren**: Die automatischen App-Sicherungen nehmen nur die aktuelle Bildfassung mit.

```
node scripts/maint/manuelle-sicherung.mjs sichern --quelle "E:\LATAIF\Data" --ziel "E:\LATAIF\Manual-Backups" --ziel "F:\LATAIF-Backups" --name 2026-11-XX_vor-bildmigration --locator "%APPDATA%\com.lataif.app\data-location.json"
node scripts/maint/manuelle-sicherung.mjs pruefen --sicherung "E:\LATAIF\Manual-Backups\2026-11-XX_vor-bildmigration"
node scripts/maint/manuelle-sicherung.mjs pruefen --sicherung "F:\LATAIF-Backups\2026-11-XX_vor-bildmigration"
```

**C. Ausführen (eigene Freigabe):**
1. Primary starten und als Owner anmelden. PC2 bleibt geschlossen.
2. Settings → Data Repairs öffnen und einen Grund eintragen.
3. „Count images" zeigt den Bestand.
4. „Dry run (changes nothing)" zeigt Anzahl, MB vorher/nachher je Klasse und die geschätzte Dauer.
5. Unter „Name of the verified full backup" den Namen aus B eintragen.
6. „Start image migration" klicken und die Rückfrage bestätigen.
7. Fortschritt: erledigt / gesamt / Fehler. „Stop" hält sauber an; ein neuer Probelauf und Start setzen fort.
8. Erwartet wird „Done. N image(s) made smaller, 0 not changed because of an error."

**D. Nachweis:**
1. App schließen.
2. `lataif.db` aus `E:\LATAIF\Data` in einen Scratch-Ordner kopieren.
3. Vergleich laufen lassen:

```
node scripts/maint/bildmigration-vergleich.mjs --vorher "<Sicherung>\Data\lataif.db" --nachher <Kopie>
```

Erwartet wird `ok: true`:
- nur Generationen und Zeiger geändert
- jede neue Fassung kleiner als die alte und unter der Grenze
- Artikel, Zuordnungen, Changelog und Audit unverändert

**E. Danach:** PC2 öffnen. Es braucht kein PC2-Update, denn v0.8.101 liest die aktuellen Schlüssel über den Primary.

## Speicherplatz

- **Aktuelle Bilddaten:** Sie werden deutlich kleiner. Das spüren die Sicherungen sowie das Laden an PC2 und auf dem Handy.
- **Platte:** Sie wächst zunächst um die neuen Fassungen, denn die alten Fassungen bleiben.
- **Späterer eigener Schritt:** Alte Fassungen löschen
  - Ablauf: superseded → gc_pending → deleted, danach Medien-GC.
  - Bedingungen: nur mit geprüfter Sicherung, die die alten Dateien enthält, und eigener Freigabe.
  - Erst dann wird Platz frei. Dieser Schritt ist nicht gebaut.

## Rückweg

Ein Zurückschalten auf eine `superseded`-Fassung verbieten die Schema-Trigger.

Rückweg ist deshalb das Zurückspielen der Vollsicherung aus B:
1. App auf Primary und PC2 schließen.
2. Dann:

```
node scripts/maint/manuelle-sicherung.mjs zurueckspielen --sicherung "F:\LATAIF-Backups\2026-11-XX_vor-bildmigration" --ziel "E:\LATAIF\Data" --beiseite "E:\LATAIF\Manual-Backups\2026-11-XX_vor-rueckweg" --bestaetigen 2026-11-XX_vor-bildmigration
```

Achtung: Alles, was nach der Sicherung erfasst wurde, ist danach weg. Deshalb D sofort nach dem Lauf, bevor wieder gearbeitet wird.

## Bausteine

**Code:**
- `src/core/media/image-store-migration.ts`: Engine mit Planung, Paketen, Bestandsübersicht und Umstellung.
- `src/core/media/image-store-migration-wiring.ts`: Owner-Pfad, Wartungsmodus und Protokoll.
- `src/pages/settings/ImageStoreMigrationCard.tsx`: die Owner-Karte.
- `src/core/bridge/maintenance-gate.ts`: Renderer-Riegel.
- `src-tauri/src/maintenance.rs`: Server-Riegel und Protokolldatei.

**Tests:**
- `test/image-store/image-store-migration.test.ts`
- `test/image-store/image-store-migration-phase4.test.ts`
- `src-tauri/src/maintenance_tests.rs`
- `test/e2e/image-store-migration.e2e.mjs` (Vollauf auf Kopie)

**Nachweis:** `scripts/maint/bildmigration-vergleich.mjs`.

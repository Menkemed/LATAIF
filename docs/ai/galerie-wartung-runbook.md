# Runbook: überholte Galerie-Bearbeitungen abbrechen (TAG-WCH-004, CAR-OGJ-001)

Stand: 16.11.2026. Vorbereitet und auf isolierten Kopien geprüft. **Produktiv noch nicht ausgeführt.**

Für jeden der Schritte A bis F braucht es eine eigene Owner-Freigabe:
- Release
- Installation
- produktiver Abbruch

## Was gemacht wird

Zwei Handy-Galerie-Bearbeitungen stehen seit dem 25.08. und dem 03.10.2026 in `media_ingest_jobs` auf `accepted`. Spätere Aufträge haben sie überholt. Sie bewirken zweierlei:
- Beide Artikel bekommen kein Bild-Embedding.
- Die Bildmigration ist blockiert.

Die Wartung setzt genau diese zwei Jobs auf `failed` mit dem Code `MEDIA_EDIT_PLAN_SUPERSEDED` und schreibt je eine Audit-Zeile. Alles andere bleibt unverändert:
- Preise und Artikel
- Bilder, Zuordnungen und Generationen
- `sync_changelog`

| Artikel | Job (Ende) | Nachfolger |
|---|---|---|
| TAG-WCH-004 | `…:eeba8daf-baa2-4521-9e29-9940dfc24822` | `…:ffc71801-…`, ready 25.08. 19:28 |
| CAR-OGJ-001 | `…:fdbf065c-d042-4533-b2ff-e0095074345b` | `…:9229cb35-…`, ready 03.10. 13:29 |

## Bausteine (lokal, Commit siehe git log)

**Code:**
- `src/core/media/superseded-edit-plans.ts`: feste Liste mit nur diesen zwei Jobs, die Prüfungen und der atomare Abbruch.
- `src/core/media/superseded-edit-plans-wiring.ts`: der Ablauf. Er läuft nur am Primary, unter Medien-Sperre und DB-Lease. Die Owner-Rolle wird unmittelbar vor der Änderung gelesen. Grund und Name der Sicherung sind Pflicht. Prüfsummen vorher und nachher belegen die Unverändertheit; danach folgt die Nachkontrolle.
- `src/pages/settings/SupersededGalleryEditsCard.tsx`: die Karte in **Settings → Data Repairs** (nur Admin). Sie erscheint nur, solange einer der zwei Jobs offen ist oder danach das Embedding noch fehlt.

**Skripte:**
- `scripts/maint/manuelle-sicherung.mjs`: Vollsicherung bei geschlossener App auf E: und F:, außerdem Prüfen und Zurückspielen. Überschreibt nie etwas.
- `scripts/maint/galerie-wartung-vergleich.mjs`: Nachweis nach der Wartung (nur lesend).

**Tests:**
- `test/image-store/superseded-edit-plans.copy.test.ts`: Prüfung auf einer DB-Kopie.
- `test/e2e/superseded-edit-plans.e2e.mjs`: der ganze Weg mit der echten App auf einer Kopie, einschließlich Rückweg.

## Ablauf der späteren produktiven Ausführung

**A. Release (eigene Freigabe).**
- Die Karte gibt es erst in einer Version, die diesen Code enthält; v0.8.103 hat sie nicht.
- Der Test-Build darf nie auf Produktionsdaten laufen.

**B. Ruhe herstellen.**
- An PC2 ist „Unresolved saves“ leer.
- Kein Handy-Upload läuft.
- LATAIF ist auf Primary und PC2 geschlossen.

**C. Vollsicherung auf E: und F: (bestehende Sicherungen bleiben unberührt).**

```
node scripts/maint/manuelle-sicherung.mjs sichern --quelle "E:\LATAIF\Data" --ziel "E:\LATAIF\Manual-Backups" --ziel "F:\LATAIF-Backups" --name 2026-11-XX_vor-galerie-wartung --locator "%APPDATA%\com.lataif.app\data-location.json"
node scripts/maint/manuelle-sicherung.mjs pruefen --sicherung "E:\LATAIF\Manual-Backups\2026-11-XX_vor-galerie-wartung"
node scripts/maint/manuelle-sicherung.mjs pruefen --sicherung "F:\LATAIF-Backups\2026-11-XX_vor-galerie-wartung"
```

Was das Skript tut:
- Es bricht ab, wenn `lataif.exe` läuft, wenn sich der Datenordner innerhalb von 60 s ändert oder wenn der Name schon existiert.
- Es sichert den ganzen Datenordner: beide Datenbanken samt `-wal`/`-shm`, alle Medien einschließlich `.ingest-journal`, die Ablagen und die Schlüssel.
- Es prüft jede Datei per SHA-256 und beide Datenbanken per `integrity_check`.

**D. Aktueller Zustandsnachweis (App bleibt geschlossen, nur lesend).**

Prüfung der Jobs:
- `lataif.db` aus der neuen Sicherung in einen Scratch-Ordner kopieren.
- Diese Prüfung starten:

```
SUPERSEDED_COPY_DB=<Kopie> SUPERSEDED_COPY_JOURNAL="E:\LATAIF\Manual-Backups\2026-11-XX_vor-galerie-wartung\Data\media\.ingest-journal" node --max-old-space-size=8192 test/image-store/superseded-edit-plans.copy.test.ts
```

Die Prüfung muss sicherstellen:
- beide Jobs sind abbrechbar;
- es gibt kein Rust-Journal zum neuen Bild;
- die Wiederherstellung lässt beide liegen.

Danach die Kopie löschen.

Handy-Warteschlange:
- `lataif_sync_server.db` samt `-wal` aus der Sicherung in einen Scratch-Ordner kopieren.
- Erwartet: `SELECT COUNT(*) FROM mobile_upload_inbox WHERE state IN ('accepted','processing')` ergibt 0.

Weicht etwas ab: STOPP, nichts ausführen.

**E. Installation (eigene Freigabe), falls die Version aus A noch nicht installiert ist.**
- Nur am Primary, mit der Sicherung aus C.
- Danach sofort weiter mit F, bevor wieder gearbeitet wird.

**F. Ausführen (eigene Freigabe).**
1. Primary starten und als Owner anmelden.
2. Settings → Data Repairs öffnen.
3. Einen Grund eintragen, dann in der Karte „Check now“ klicken. Beide Jobs müssen „Check passed“ zeigen.
4. Unter „Name of the verified backup“ den Namen aus C eintragen und auf „Close superseded edits“ klicken. Die App fragt nach; bestätigen.
5. Erwartet:
   - „Done“;
   - „Verified unchanged …“ (sonst STOPP und melden);
   - die Nachkontrolle zeigt beide Artikel „queued for image matching“;
   - die Bildmigration ist nicht mehr blockiert.

Wird ein Job verweigert, hat sich der Stand seit der Prüfung geändert. Dann ist nichts geschrieben worden; „Check now“ erneut klicken.

**G. Nachweis.**
1. Die App schließen.
2. `lataif.db` aus `E:\LATAIF\Data` in einen Scratch-Ordner kopieren und vergleichen:

```
node scripts/maint/galerie-wartung-vergleich.mjs --vorher "<Sicherung>\Data\lataif.db" --nachher <Kopie>
```

Erwartet `ok: true`: nur die zwei Jobs `accepted → failed`, 2 Audit-Zeilen; Artikel, Medien und Changelog sind unverändert.

**H. Bildabgleich.**
- Beim nächsten Start berechnet der bestehende Abgleich Embedding und Bildbeschreibung der zwei Artikel automatisch (AI eingerichtet).
- Das ergibt je Artikel 1 Changelog-Eintrag und 2 Audit-Zeilen; so verhält sich die App bei jedem neuen Foto.
- Die Karte verschwindet, sobald beide Artikel ein Embedding haben. Bis dahin zeigt „Check image matching“ den Stand.

## Rückweg

1. Die App auf Primary und PC2 schließen.
2. Die Sicherung zurückspielen:

```
node scripts/maint/manuelle-sicherung.mjs zurueckspielen --sicherung "F:\LATAIF-Backups\2026-11-XX_vor-galerie-wartung" --ziel "E:\LATAIF\Data" --beiseite "E:\LATAIF\Manual-Backups\2026-11-XX_vor-rueckweg" --bestaetigen 2026-11-XX_vor-galerie-wartung
```

Was dabei geschieht:
- Die Sicherung wird vorher geprüft.
- Der heutige Stand wird zuerst vollständig und geprüft nach `--beiseite` kopiert.
- Danach ist der Datenordner exakt die Sicherung.
- Der Locator wird nie angefasst.

Die Wartung ändert kein Schema. Das Zurückspielen der Daten genügt, auch mit der neuen Version.

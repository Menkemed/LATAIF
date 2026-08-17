# DATA-ROOT-I1 — Architektur- und Migrationsvertrag (Phase A, Audit + Design)

Stand: Baseline `main` = `origin/main` = `40e789b`, Version 0.8.42, Public Latest `v0.8.42`,
LIVE_VALIDATED. Scope Single-PC. Multi-Peer-WIP `0cf518c` unangetastet.

Dieses Dokument beschreibt **nur den Vertrag**. Es wurde in Phase A **keine Zeile Produktcode
geändert, keine Datei verschoben, kein Locator geschrieben und keine Produktions-DB geöffnet**
(die einzige Berührung mit Produktionsdaten war ein read-only-Lesen einer Kopie der
`lataif_sync_server.db`, um den real konfigurierten Backup-Pfad zu ermitteln).

---

## 1. Ist-Zustand — wer bestimmt heute welchen Pfad

Es gibt heute **keinen** Data-Root-Begriff. Es gibt drei voneinander unabhängige Ableitungen
desselben Verzeichnisses, plus rund 40 Stellen, die Dateinamen darunter selbst zusammensetzen.

### 1.1 Die drei Wurzel-Ableitungen

| # | Ort | Ausdruck | Versorgt |
|---|-----|----------|----------|
| A | Renderer (TS) | `appDataDir()` aus `@tauri-apps/api/path` | Business-DB, `openai.key`, Pre-destructive-Backup |
| B | Rust `setup()` | `app.path().app_data_dir()` | Server-DB, Media-Root, Mobile-Staging, alle Boot-Phasen |
| C | Rust Server-Runtime | `self.db_path.parent()` | Frontend-DB-Pfad + Mobile-Staging **für die HTTP-Routen** |

A und B sind derselbe Wert, aber getrennt ermittelt. C leitet aus B ab: *„der Data Root ist das
Verzeichnis, in dem die Server-DB liegt"* — eine implizite, nirgends benannte Invariante
(`src-tauri/src/sync/mod.rs:241-256`).

Zusätzlich resolven **17 einzelne Tauri-Commands** in `src-tauri/src/lib.rs` jeweils selbst
`app_handle.path().app_data_dir()`, statt einen gemeinsamen Wert zu benutzen.

### 1.2 SSOT je Pfad (real, nicht aus Erinnerung)

| Datenart | Heutige SSOT | Konstruktion |
|---|---|---|
| Business-DB `lataif.db` | `src/core/db/database.ts:75` `getDbFilePath()` | `appDataDir() + 'lataif.db'` (`DB_FILENAME`, Zeile 32) |
| Server-DB `lataif_sync_server.db` | `src-tauri/src/lib.rs:2721` | `app_dir.join("lataif_sync_server.db")`, einmal im Setup, dann via `SyncServer.db_path` |
| Server-DB (Read-only-Config-Leser) | `backup_location.rs:32`, `backup_retention.rs:27`, `media_gc.rs:39` | je eigenes `const CONFIG_DB` — **dreifach dupliziert** |
| Media-Root | `src-tauri/src/lib.rs:2729` | `app_dir.join("media")` → `MediaIngestService::new(..)` (managed state) |
| Media-Root (GC/Backup) | `media_gc.rs:257/329/411/462`, `backup.rs:380` | jeweils erneut `app_data_dir.join("media")` — **5× dupliziert** |
| Mobile-Staging | `lib.rs:2730` (managed state) **und** `sync/mod.rs:249` (Server) | `<root>/mobile-upload-staging`, zwei unabhängige Ableitungen |
| Backups-Root | `media/backup_location.rs:77` `resolve_root()` | konfigurierter Pfad (Server-DB `backup_location_config`, v0016) **oder** `<root>/backups` |
| Restore | `media/restore.rs:331/351/393` | ausschließlich über `backup_location::resolve_root()` — sauber |
| Backup-Retention | `media/backup_retention.rs:118` | über `resolve_root()` + `list_snapshots()` — sauber |
| Pre-destructive-Backup | `src/core/settings/pre-destructive-backup.ts:96` | **hart `<appDataDir>/backups/pre_destructive_*`** — ignoriert `backup_location_config` |
| Media-GC / Quarantäne | `media_gc.rs` | `<root>/media/.gc-quarantine/<run>/` |
| Staging-GC | `media/staging_gc.rs:30,31,501` | eigene Konstanten `.ingest-journal`, `mobile-upload-staging`, `lataif_sync_server.db` |
| Import/Export | `src/core/utils/export-file.ts` | `downloadDir()` + nativer Save-Dialog — **außerhalb** des Data Root, nicht betroffen |
| Updater/Relaunch | `plugins.updater`, NSIS `installMode: "both"` | App-Verzeichnis wird beim Erstinstall gewählt; Updater ersetzt nur App-Dateien |
| Identität/Secrets | `install_id.rs:29`, `secret.rs:15`, `device.rs:41/44/118/122`, `trust_root.rs:32` | 6 Dateien direkt im Root |
| E2E-Isolation | `tauri.e2e.conf.json:4` `identifier` | eigener Identifier ⇒ eigener `appDataDir()`; 15 E2E-Suites hardcoden `join(APPDATA,'com.lataif.app.e2e')` |

### 1.3 Vollständiger Inhalt des heutigen Roots

DBs: `lataif.db`, `lataif_sync_server.db` (+ `-wal`/`-shm`).
Verzeichnisse: `media/` (inkl. `.ingest-journal/`, `.gc-quarantine/`), `mobile-upload-staging/`,
`backups/` (Default-Fall).
Schlüssel/Identität: `sync_install_id.key`, `sync_jwt_secret.key`, `sync_device_identity.key`,
`sync_device_certificate.json`, `sync_tenant_trust_anchor.json`,
`sync_device_enrollment_request.json`, `sync_tenant_root.key`, `openai.key`.
Transiente Marker: `.restore-intent`, `.restore-journal`, `.restore-staging/`,
`.restore-rollback/`, `.backup-intent`, `.gc-intent`, `backup-ws-*`.

### 1.4 Harte / duplizierte Pfadlogik — Befund

1. Dateiname `lataif_sync_server.db` steht als Literal an **6** Nicht-Test-Stellen.
2. Dateiname `lataif.db` steht als Literal an **7** Nicht-Test-Stellen (TS + Rust).
3. `join("media")` steht an **6** Stellen, `mobile-upload-staging` an **3**.
4. `db_path.parent()` als Data-Root-Ersatz (`sync/mod.rs`) — bricht, sobald die Server-DB je in
   einem Unterordner läge.
5. 17× `app_data_dir()` in `lib.rs` statt eines gemeinsamen Werts.
6. **Echter Fehler, unabhängig von diesem Slice:** `pre-destructive-backup.ts` schreibt immer nach
   `<appDataDir>/backups/…` und ignoriert den owner-konfigurierten Backup-Ort. Live steht dieser
   auf `E:\` — die Auto-Sicherung vor Factory-Reset/Purge landet also auf `C:`, wo der Owner sie
   nicht erwartet.

---

## 2. Locator — Entscheidung

**Ergebnis der Prüfung: eine bestehende Config-SSOT ist konstruktionsbedingt ungeeignet.**
Der einzige kanonische Konfigurationsspeicher ist die Server-DB (`backup_location_config`,
`backup_retention_config`, `primary_host_config`). Diese Datei liegt **selbst im Data Root**. Der
Data Root kann nicht aus einer Datei kommen, die man erst finden kann, wenn man den Data Root
kennt. Ein Locator **muss** außerhalb liegen.

Zweite Prüfung: `tauri.conf.json` scheidet aus (unveränderlich, im App-Verzeichnis, wird vom
Update ersetzt). Registry scheidet aus (nicht sichtbar, nicht sicherbar, nicht portabel).

**Vertrag:**

* Ort: `<identifier-AppData>/data-location.json` — also `%APPDATA%\com.lataif.app\` für Produktion,
  `%APPDATA%\com.lataif.app.e2e\` für E2E. Damit ist die Test-Isolation **strukturell** erhalten:
  ein Produktions-Locator ist für den E2E-Build unsichtbar und umgekehrt.
* Inhalt, klein und stabil:
  `{ "schemaVersion": 1, "dataRoot": "E:\LATAIF\Data", "rootId": "<uuid>", "updatedAt": "<iso>" }`
* Niemals eine DB-Kopie, niemals Nutzdaten, niemals Secrets im Locator.
* **Root-Marker** `<data root>/.lataif-data-root.json`:
  `{ "schemaVersion": 1, "rootId": "<dieselbe uuid>", "createdAt": "<iso>", "bootstrapPending": bool,
  "businessDbExpected": bool }`
* Keine der beiden Dateien ist für sich autoritativ. **Das Paar ist es:** der Locator sagt *welches*
  Verzeichnis, der Marker beweist, dass es *dieses* Verzeichnis ist und nicht eine Kopie, ein
  wiederhergestellter Ordner oder eine neu erzeugte leere Hülle.

### 2.1 Auflösungsvertrag `data_root::resolve()` — implementiert

Entschieden wird ausschließlich über das Zustandspaar (Locator, Marker):

| Locator | Marker | Ergebnis |
|---|---|---|
| fehlt | fehlt | **Bootstrap** — `app_data_dir` wird in place adoptiert (Upgrade eines Bestandsnutzers **oder** allererster Start). Es wird **nichts** verschoben. |
| fehlt | `bootstrapPending: true` | **Bootstrap fortsetzen**, gleiche `rootId`. Kann nur ein Absturz mitten im Bootstrap in genau diesem Verzeichnis sein. |
| fehlt | final | **FAIL CLOSED** `DATA_ROOT_LOCATOR_MISSING`. Das ist die P1-Regel. |
| vorhanden, unlesbar/kein JSON | — | **FAIL CLOSED** `DATA_ROOT_LOCATOR_CORRUPT` |
| vorhanden, unbekanntes Schema | — | **FAIL CLOSED** `DATA_ROOT_LOCATOR_SCHEMA_UNSUPPORTED` |
| vorhanden, Pfad nicht absolut | — | **FAIL CLOSED** `DATA_ROOT_LOCATOR_PATH_NOT_ABSOLUTE` |
| vorhanden, Root nicht erreichbar | — | **FAIL CLOSED** `DATA_ROOT_UNREACHABLE` (Laufwerk weg ⇒ „später wieder", nie „von vorn") |
| vorhanden | fehlt | **FAIL CLOSED** `DATA_ROOT_MARKER_MISSING` |
| vorhanden | korrupt | **FAIL CLOSED** `DATA_ROOT_MARKER_CORRUPT` |
| vorhanden | `rootId` ≠ Locator-`rootId` | **FAIL CLOSED** `DATA_ROOT_ID_MISMATCH` |
| vorhanden + Marker `businessDbExpected` | `lataif.db` fehlt | **FAIL CLOSED** `DATA_ROOT_BUSINESS_DB_MISSING` |
| vorhanden, Paar stimmig | final | **Normaler Start, ohne jeden Schreibvorgang** |

**Der Legacy-AppData-Fallback existiert für genau EIN Ereignis im Leben einer Installation:** den
ersten Start nach dem Upgrade, wenn nie ein Locator existiert hat. Ab dem Moment, in dem das Paar
geschrieben ist, ist ein fehlender Locator ein **Fehler**, kein Hinweis. Die verlockende Regel
„kein Locator ⇒ AppData" ist genau der Split-Brain-Bug: nach einem späteren Move nach
`E:\LATAIF\Data` würde ein verlorener Locator die App zurück auf den alten `C:`-Root schicken, der
dort noch vollständig und öffenbar liegt — der Nutzer sähe *seine* Daten, nur eben die falschen,
und würde darin weiterarbeiten.

### 2.2 Bootstrap-Reihenfolge (crash-sicher, idempotent)

1. Marker mit `bootstrapPending: true` schreiben,
2. Locator schreiben — **das ist der Commit-Punkt**,
3. Marker final schreiben (`bootstrapPending: false`).

Damit ist jeder Absturzzustand eindeutig auflösbar: ein *pending* Marker ohne Locator kann nur ein
abgebrochener Bootstrap in genau diesem Verzeichnis sein (ein Move hat nie stattgefunden), ein
*finaler* Marker ohne Locator ist der gefährliche Fall und stoppt die App. Alle Schreibvorgänge
atomar (`tmp` → `sync_all` → `rename`). Ein zweiter Start schreibt **nichts** — bewiesen durch
Byte-Vergleich beider Dateien im E2E.

### 2.3 Zwei gültige Roots

Es gibt **keine** „beste Root wählen"-Heuristik. Weder Größe noch mtime noch Alphabet noch ein
AppData-Fallback entscheiden irgendetwas. Es entscheidet ausschließlich der validierte Locator plus
die passende `rootId`. Bei Uneindeutigkeit: fail closed.

---

## 3. Zentraler Resolver — implementiert

* **Rust ist die einzige Autorität.** `src-tauri/src/data_root.rs` — `resolve(app_data_dir)` läuft
  als **erste** Anweisung in `setup()`: vor der Restore-Recovery, vor jedem DB-/Media-Open, vor dem
  Fenster. `app.path().app_data_dir()` wird dort nur noch benutzt, um den **Locator** zu finden;
  es ist für sich genommen keine Antwort mehr auf „wo liegen die Daten".
* Scheitert die Auflösung, startet die App **nicht**: Fehlercode ins Log, `MessageBoxW` mit einer
  Klartext-Erklärung, `setup` liefert `Err`. Im `e2e`-Build ist die Box weggeschaltet (ein modaler
  Dialog würde den Prozess am Leben halten und jeden Refusal-Test aufhängen).
* Abgeleitete Pfade ausschließlich aus `DataRoot`: `business_db()`, `sync_server_db()`,
  `media_root()`, `mobile_staging_root()`, `openai_key()`. Die Dateinamen stehen als Konstanten in
  genau **einer** Liste (`BUSINESS_DB_FILENAME`, `SYNC_SERVER_DB_FILENAME`, `MEDIA_DIRNAME`,
  `MOBILE_STAGING_DIRNAME`, `OPENAI_KEY_FILENAME`).
* Der aufgelöste Root liegt als `AppHandleState.data_root` im managed State. Die **16**
  Command-Handler, die vorher jeweils selbst `app_handle.path().app_data_dir()` gerufen haben,
  ziehen ihn über `data_root_of(&app_handle)`. `app_data_dir()` kommt in `lib.rs` nur noch **einmal**
  vor — beim Suchen des Locators.
* `SyncServer` bekommt den `DataRoot` **im Konstruktor**; `frontend_db_path` und
  `mobile_staging_root` kommen daraus. `AppState` (der Axum-Server-State) traegt ihn ebenfalls, damit
  auch die HTTP-Routen (Mobile-Media-Auslieferung, AI-Key-Lookup) ihn nicht rekonstruieren muessen.
  Die zweite SSOT `db_path.parent()` / `frontend_db_path.parent()` / `mobile_staging_root.parent()`
  ist ersatzlos weg — in `trust_ctx`, im Desktop-Stock-Check, in `storage_free_bytes` und in beiden
  Routen.
  *Bewusste Ausnahme:* `install_id.rs` und `secret.rs` nehmen weiterhin den Server-DB-Pfad entgegen
  und legen ihre Schlüsseldatei daneben. Das ist keine zweite Wurzel-Antwort, sondern eine
  Datei-neben-Datei-Beziehung — und der Server-DB-Pfad kommt jetzt selbst aus `DataRoot`.

### 3.1 TS ↔ Rust — ein Vertrag, keine zweite Implementierung

Die Startreihenfolge erlaubt die einfachste mögliche Architektur: Rust löst den Root auf, **bevor**
der Webview existiert. Ein Renderer, der überhaupt Pfade bekommt, läuft also zwangsläufig in einem
Prozess, dessen Root bereits validiert ist.

* Neuer Read-only-Command `get_runtime_paths` liefert `dataRoot`, `rootId`, `businessDb`,
  `syncServerDb`, `mediaRoot`, `mobileStagingRoot`, `openaiKey`, `backupsRoot`.
* `src/core/runtime/runtime-paths.ts` ist die **einzige** Stelle im Renderer, die ihn ruft; das
  Ergebnis wird für die Fensterlebensdauer gecacht (der Root kann zur Laufzeit nicht wechseln — ein
  Move wird beim Boot angewandt, nach kontrolliertem Relaunch).
* `database.ts`, `ai-service.ts` und `pre-destructive-backup.ts` resolven **nicht** mehr selbst.
  Ein Quell-Sweep (`test/dataroot/runtime-paths.test.ts`) beweist, dass **kein** `.ts/.tsx` unter
  `src/` noch `appDataDir()`/`appLocalDataDir()` aufruft.
* Außerhalb der Desktop-App wirft `getRuntimePaths()`, statt einen plausiblen Pfad zu erfinden.

---

## 4. Backup-Vertrag

* Backups sind **nicht** Teil des Data Root. Zielbild: `E:\LATAIF\Data` (Daten) neben
  `E:\LATAIF\Backups` (Sicherungen) — Geschwister, nicht verschachtelt.
* Die bestehende owner-gated Backup-Location (`backup_location_config`, v0016) bleibt
  unverändert gültig und wird von einem Data-Root-Wechsel **niemals** überschrieben.
* Backup/Restore arbeiten immer gegen den **aktuell aktiven** Data Root (`RestoreInput.app_data_dir`
  wird zu `RestoreInput.data_root`) — inhaltlich ist das schon heute so, nur der Name lügt.
* **Kritische Kopplung, die neu entsteht:** `validate_and_prepare()` verbietet einen Backup-Root,
  der den Datenbestand enthält, darin liegt oder dessen Elter ist. Live ist der Backup-Root
  `E:\` — heute überlappungsfrei (Daten auf `C:`), nach einem Umzug nach `E:\LATAIF\Data`
  **wäre `E:\` ein Elternverzeichnis des Data Root** und hätte die Prüfung nie bestanden.
  Deshalb Pflicht: der Move validiert die Überlappung **in beide Richtungen erneut** und
  verweigert einen Ziel-Root, der mit dem konfigurierten Backup-Root überlappt, bevor irgendetwas
  kopiert wird. Der Owner muss dann erst den Backup-Ort umstellen (z. B. auf `E:\LATAIF\Backups`).
  *Kein Datenverlust-Risiko im Bestand:* Retention ist aus (`enabled=0`), und `delete_one()`
  löscht ausschließlich Verzeichnisse, die als vollständiger Snapshot validieren — `E:\LATAIF`
  könnte selbst bei aktivierter Retention nie gelöscht werden.
* **In B1 behoben (Befund 1.4/6):** `pre-destructive-backup.ts` schrieb hart nach
  `<appDataDir>/backups/…`. Live zeigt die Backup-Location auf `E:\` — die automatische Sicherung
  vor einem Factory Reset landete also auf `C:`, auf genau dem Laufwerk, das der Reset gleich
  leert, an einem Ort, an dem der Owner sie nicht sucht. Quelle ist jetzt der aktive **Data Root**,
  Ziel der konfigurierte **Backups-Root** (`get_runtime_paths().backupsRoot` →
  `backup_location::resolve_root`). Regressionstest: `test/d3/safe-purge.test.ts` §dr-1…dr-9.
* **Overlap-Validator zentralisiert (B1):** `data_root::paths_overlap(a, b)` prüft Gleichheit und
  Enthaltensein in **beide** Richtungen, kanonisiert vorher beide Seiten (Windows-Groß-/
  Kleinschreibung, `.`/`..`, Trailing-Separator) und vergleicht ganze Pfadkomponenten — `…\LATAIFX`
  liegt korrekt **nicht** in `…\LATAIF`. `backup_location::validate_and_prepare` benutzt genau
  diesen Helper; der Move (B3) wird denselben benutzen. Bestehende Produktionskonfiguration wird
  **nicht** automatisch geändert.

---

## 5. Move Data Location — implementiert (B2)

**Vertrag: COPY → VERIFY → LOCATOR-SWITCH → RELAUNCH.** Niemals „Quelle verschieben und hoffen".
Der Quell-Root ist zu **jedem** Zeitpunkt vollständig, öffenbar und korrekt — auch in jedem
Absturzfenster. B2 löscht ihn nicht und enthält **keine** Funktion, die ihn löschen könnte.

### 5.1 Warum der Move beim Boot läuft

Eine laufende App zu quiescen (sql.js im Renderer, LAN-Server, Mobile-Drain, Media-Ingest, GC) ist
ein Versprechen, das für jeden künftigen Writer weitergelten müsste. Der Boot-Pfad braucht dieses
Versprechen nicht: dort ist keine DB offen, kein Server gebunden, kein Worker da und der Renderer
existiert noch nicht — derselbe Grund, aus dem Restore, Backup und Media-GC bereits dort laufen.

Die UI verschiebt deshalb nichts. Sie schreibt einen **Intent**; der bestehende koordinierte
Relaunch (Writer pausieren → `saveDatabaseDurably` → Server stoppen + Port-Freigabe bestätigen →
Relaunch) bringt uns in einen Prozess, in dem der Move trivial sicher ist. Der Move endet dort
**vor** jedem Öffnen, und derselbe Prozess läuft anschließend auf dem NEUEN Root weiter. Damit gibt
es auch keinen Hot-Switch eines lebenden Renderers: der Renderer, der hochkommt, kennt nur das Ziel.
Der B1-Path-Cache wird **nie** manuell aktualisiert.

### 5.2 Move-Intent (`<identifier-AppData>/data-move-intent.json`)

`{ schemaVersion, moveId, rootId, sourceRoot, targetRoot, stagingRoot, phase, attempts, createdAt }`
— keine Secrets, atomar geschrieben, außerhalb des Data Root (weil während eines Moves gerade
„innerhalb des Data Root" mehrdeutig ist).

### 5.3 Phasen und Crash-Regeln

| Phase | Bedeutung | Recovery beim nächsten Boot |
|---|---|---|
| `prepared` | geplant, nichts kopiert | Copy (neu) starten |
| `copying` | Teil-Staging vorhanden | Staging verwerfen, Copy neu starten |
| `verified` | Staging vollständig + bewiesen | neu machen statt halb vertrauen |
| *(Sonderfall)* | Ziel existiert bereits vollständig **mit unserer `rootId`** (Absturz zwischen Rename und Phasenschreiben) | wird als `target_finalized` erkannt und committet — sonst bliebe eine vollständige, unbenutzbare Kopie liegen |
| `target_finalized` | Ziel vollständig + bewiesen | erneut validieren, dann committen (sonst Ziel-Kopie entfernen + abbrechen) |
| `locator_switched` | Commit erfolgt | Ziel validieren; scheitert das → **Rollback** auf den im Intent gebundenen Source |

**Vor dem Locator-Write ist immer die Quelle autoritativ.** Danach das Ziel — außer das Ziel lässt
sich nicht sicher öffnen; dann ist der Rollback erlaubt, **weil** der Intent einen expliziten
Quellpfad und dieselbe `rootId` bindet. Das ist Move-Recovery, keine „beste Root"-Heuristik, und die
einzige Situation, in der der Locator je rückwärts geschrieben wird. Nach `MAX_ATTEMPTS` (2)
erfolglosen Boots wird der Intent aufgegeben — ein kaputter Move darf nicht jeden Start blockieren.

### 5.4 rootId

Ein Move erzeugt **keine** neue Datenidentität: der Marker wird unverändert mitkopiert, der Locator
wechselt nur den Pfad. Nach einem erfolgreichen Move existieren bewusst **zwei** vollständige Roots
mit derselben `rootId`; ausschließlich der validierte Locator entscheidet, welcher aktiv ist.

### 5.5 Preflight (owner-gated, kopiert nichts)

Absoluter Pfad · erreichbar · beschreibbar (echter Write-Probe) · **nicht** die Quelle · keine
Überlappung mit Quelle, Backup-Root oder App-Ordner (jeweils **beide** Richtungen) · Ziel leer und
ohne fremde LATAIF-Daten (sonst `MOVE_TARGET_HAS_LATAIF_DATA`, **nie** Merge/Adopt) · genug freier
Platz (Quellgröße + 5 %) · Unicode/Leerzeichen · Cross-Volume erlaubt. Bestehende Dateien im Ziel
werden **nie** überschrieben.

**Pfad-Normalisierung fail-closed (härtet den B1-Fund):** `normalize_for_compare` kanonisiert den
tiefsten existierenden Vorfahren und hängt die restlichen Komponenten an; `.`/`..` werden abgelehnt.
Lässt sich ein Pfad nicht normalisieren, wird der Move abgelehnt — **kein** Raw-String-Fallback für
Sicherheitsentscheidungen. Verglichen wird komponentenweise (`…\LATAIFX` liegt korrekt nicht in
`…\LATAIF`).

### 5.5a Re-Validierung beim Boot (TOCTOU)

Der UI-Preflight lief in einem **anderen Prozess**, vor dem Relaunch. Dazwischen kann der Owner den
Backup-Ort umgestellt, jemand eine Junction ans Ziel gelegt, einen Ordner gefüllt oder die Platte
gefüllt haben. Der Boot-Executor prüft deshalb vor der ersten Kopie **erneut** und gegen die im
Intent stehenden Pfade: Normalisierung, Ziel ≠ Quelle, Überlappung mit Quelle, **frisch gelesenem**
Backup-Root und App-Ordner, Reparse-Point am Ziel, Ziel leer und ohne fremde LATAIF-Daten,
Schreibbarkeit des Zielelternteils, freier Platz. Der Preflight ist eine Entscheidungshilfe, diese
Prüfung ist das Tor.

### 5.6 Copy + Verifikation

**Control-Plane-Dateien liegen außerhalb des Data Root und werden nie mitkopiert.** `RESERVED_CONTROL_FILES`
= `data-location.json` + `data-move-intent.json`: auf einer Legacy-Installation sind AppData und Data
Root derselbe Ordner, weshalb der v0.8.43-Move beide als tote, autoritativ aussehende Kopien ins neue
Verzeichnis getragen hat. Ausschluss **namentlich**, nicht per Muster — ein Data Root darf beliebige
`.json` enthalten, ausgeschlossen wird nur, was der Vertrag ausdrücklich außerhalb verortet. Bereits
entstandene Kopien räumt `cleanup_stale_control_copies` beim Boot auf, und zwar **nur** wenn: der Root
kein Legacy-in-place-Root ist (dort ist die Datei die echte), ein gültiger Locator außerhalb genau
diesen Root mit passender `rootId` benennt, der Marker dazu passt, und für den Intent kein Move
aussteht. Bei jeder Unklarheit: nichts anfassen.

Kopiert wird **alles** im Data Root außer transienten Artefakten (`.restore-*`, `.backup-intent`,
`.gc-intent`, `backup-ws-*`, eigene `*.tmp-*`) und den Control-Plane-Dateien — also DBs, `media/`, `mobile-upload-staging/`, Root-
Marker und die Schlüsseldateien, die laut B1 bewusst neben der Server-DB liegen. Ein Reparse-Point
irgendwo im Quellbaum bricht den Move ab (folgen würde von außerhalb kopieren, nicht folgen würde
still Daten verlieren). Ziel ist ein Staging-Pfad **auf dem Ziel-Volume**
(`<target-parent>\.lataif-move-<moveId>`), damit die Finalisierung ein Rename ist.

Vor dem Manifest werden die WALs der Quell-DBs eingecheckpointet, damit die Kopie in sich
geschlossen und read-only prüfbar ist. Das ändert Bytes in der Quelle, aber keine Zeile — ein
Checkpoint ist keine Bearbeitung.

Verifiziert wird vor jedem Umschalten: gleiche relativen Pfade, gleiche Anzahl, gleiche Größen,
**SHA-256 jeder Datei** (keine Gesamtgröße) · `PRAGMA integrity_check` + `PRAGMA foreign_key_check`
auf Business- **und** Server-DB · jede **erreichbare** Mediendatei vorhanden und ohne Path-Escape
(§5.6a) · Marker mit derselben `rootId`. Ein einziger Fehlschlag ⇒ Locator
bleibt Quelle.

### 5.6a Gemeinsamer Media-Reachability-Vertrag (v0.8.44)

Drei Subsysteme beantworteten „welche Mediendateien zählen?" unterschiedlich — und das fiel live auf:
ein Snapshot, den das Backup als *complete* erstellt hatte, ließ sich danach **nicht mehr verschieben**.
Zwei Blobs eines abgebrochenen Uploads hingen an keinem Business-Objekt, wurden nirgends angezeigt und
deshalb nie gesichert; der Move verlangte sie trotzdem.

`media::reachability` ist jetzt die einzige Definition, mit **zwei** benannten Mengen:

* **REQUIRED** — erreichbar über `media_links` (aktiv) → `media_objects` (nicht gelöscht) → Blob
  `present` → **aktuelle** Generation `available`, plus deren Varianten. Exakt das, was der
  Gallery-Resolver auflöst, und exakt das, was Backup mitnimmt und der Move verlangt. Fehlt hier
  etwas, ist es ein Loch, das jemand sieht → **harter Fehler**.
* **PRESERVED** — jede `media_blob_generations`-Zeile, unabhängig vom Status. Echte Obermenge:
  In-flight-Ingest, abgelöste Generationen, verwaiste Uploads. Nichts davon darf die **GC löschen**,
  nichts davon muss existieren. „Darf ich das löschen?" und „muss das existieren?" sind verschiedene
  Fragen, und die zweite ist die kleinere Menge.

Backup baut sein Manifest aus **demselben SQL-Text** (`REQUIRED_MASTER_SQL`/`REQUIRED_VARIANT_SQL`),
die Media-GC nutzt `preserved_keys`, der Move `required_keys`. Damit gilt: **ein gültiger `complete`
Snapshot ist nach dem Restore wieder verschiebbar** — der zentrale Regressionstest.

**Alle Consumer gehen durch dieselbe Auflösung:** Gallery-Resolver, AI-Bildquelle und Bild-/Excel-Export
konsumieren das Resolver-Ergebnis; die Mobile-Seite gibt Keys ausschließlich aus derselben
link→object→current-Kette heraus (`product_query`), und `media_key_is_known` ist nur ein Serving-Guard
für bereits ausgegebene Keys — es gibt **keinen** dauerhaften Business-Consumer, der eine Datei allein
über den Content-Hash braucht. Der TS-Zwilling `backup-core.ts` ist dormant (kein Produktions-Caller;
das Live-Backup ist das Rust-seitige), wird aber semantisch mitgeführt.

*Beim Zusammenführen gefunden:* die Varianten-Abfrage kannte nur den Link, nicht das Objekt, und
exportierte deshalb das Thumbnail eines **gelöschten** Media-Objekts. Der Resolver verwirft dabei
Master und Thumbnail gemeinsam; die Abfrage joint jetzt ebenfalls `media_objects` — ebenso die
Mobile-Thumbnail-Abfrage in `product_query` und der dormante TS-Zwilling, damit Handy, Desktop,
Backup und Move dieselbe Menge sehen.

### 5.7 Finalisierung und Commit

Staging → finaler Ziel-Root per Rename **innerhalb des Ziel-Volumes**; finaler Root nochmals
validiert; dann **ein** atomarer Locator-Write auf Ziel + gleiche `rootId`. **Der Locator-Write ist
der Commit-Punkt.** Danach zwingend der (bereits erfolgte) koordinierte Relaunch — kein Hot-Switch.

### 5.8 Exklusivität

Ein Move ist ein exklusiver Wartungszustand **in beide Richtungen**:

* `schedule_data_root_move` verweigert, wenn bereits ein Move-Intent existiert
  (`MOVE_ALREADY_PENDING`) oder ein Backup-/Restore-/GC-Intent im Quell-Root liegt
  (`MOVE_BLOCKED_BY_MAINTENANCE`).
* Umgekehrt verweigern `schedule_backup_snapshot`, `schedule_restore_snapshot`, `schedule_media_gc`
  und `finalize_media_gc` mit `MOVE_OPERATION_PENDING`, solange ein Move-Intent existiert — zentral
  über `data_root_move::ensure_no_pending_move`, als **erste** Anweisung, also bevor irgendein Intent
  geschrieben werden könnte. Grund: der Move kopiert die Intents der anderen Operationen bewusst
  **nicht** mit (sie beschreiben Arbeit am ALTEN Root); ein danach geplantes Backup würde beim
  Umschalten still verloren gehen, ein danach geplanter Restore würde DBs in einen Root tauschen, der
  gerade aufhört, der aktive zu sein. Der Doppelklick-Schutz in der UI ist derselbe Prädikat wie das
Button-`disabled`. Zwei App-Instanzen bleiben durch den bestehenden Single-Instance-Guard aus.

### 5.9 Was B2 NICHT tut

Kein „Delete old data location" — auch nach erfolgreichem Move nicht. Kein automatisches Ändern der
Backup-Location. Keine Fresh-Start-Auswahl. Kein Version-Bump.

## 6. Fresh Install / Fresh Start

* **Neuinstallation** (kein Locator, kein AppData-Bestand): *Zielbild B3* = einmalige Auswahl „Wo
  sollen die Daten liegen?" mit Vorgabe = AppData-Pfad; bricht der Nutzer ab → Default = AppData.
  **Stand B1:** es wird nicht gefragt, der Default (AppData) wird registriert — Marker + Locator
  geschrieben, `businessDbExpected=false`, weil hier nachweislich nie eine DB lag.
* **Bestandsnutzer** (AppData-Bestand vorhanden, kein Locator): **keine Abfrage, keine Migration,
  kein Dialog.** Der Bootstrap adoptiert den vorhandenen Ordner in place und merkt sich im Marker
  `businessDbExpected=true`. Das Update ist vollständig transparent — E2E §2 beweist, dass danach
  dieselbe `lataif.db` byte-identisch geöffnet wird. Der Umzug ist und bleibt ausschließlich ein
  bewusster Menüpunkt (B2).
* **App-Verzeichnis** (`E:\LATAIF\App`) ist eine reine Installer-Entscheidung: NSIS läuft mit
  `installMode: "both"`, das Zielverzeichnis wird beim Erstinstall gewählt, der Updater ersetzt
  danach nur App-Dateien im selben Verzeichnis. Es gibt dafür **keinen Code-Anteil** — und ein
  bestehender Install lässt sich nicht per Update verschieben, nur per Neuinstallation.
* **Fresh Start auf bestehendem Rechner** — Altbestand darf erst entfernt werden, wenn *alle* fünf
  Punkte erfüllt sind: (1) vollständiges Archiv des alten Roots außerhalb beider Roots,
  (2) neuer Root gestartet, (3) mehrere Starts erfolgreich, (4) Backup im neuen Root erfolgreich,
  (5) Restore aus diesem Backup erfolgreich verifiziert. Erst danach bewusste, owner-gated
  Löschung — nie automatisch, nie als Teil des Move.

---

## 7. Kritische Fälle — jeweils festgelegtes Verhalten

| Fall | Verhalten |
|---|---|
| Locator zeigt auf nicht erreichbares Laufwerk | Start fail-closed, `DATA_ROOT_UNREACHABLE`, Retry/Rollback-Dialog. **Nie** AppData-Fallback, **nie** Neuanlage. |
| USB/externe Platte fehlt | identisch — der Bestand gilt als „temporär abwesend", nicht als „nicht vorhanden". |
| Root existiert, `lataif.db` fehlt | Marker vorhanden ⇒ leerer, gültiger Root (nur bei frischem Setup zulässig); Marker fehlt ⇒ fail-closed `DATA_ROOT_NOT_A_ROOT`. |
| Business-DB da, Server-DB fehlt | zulässig (LAN-Sync lief nie) — Server-DB wird wie heute frisch initialisiert. Bereits heutiges Verhalten. |
| Media-Root fehlt | zulässig, wird angelegt; die Media-GC meldet `media_root_present=false` und löscht nichts (bestehendes Verhalten). |
| Ziel enthält bereits andere LATAIF-Daten | Move bricht **vor** jeder Kopie mit `TARGET_HAS_DATA` ab. Kein Merge, nie. |
| Zwei Roots mit gültigen Daten | Der Locator entscheidet, ausschließlich. Der alte Root trägt nach einem Move `.lataif-data-root.superseded` mit Zeitstempel + Ziel — damit ist die Frage „welcher gilt?" ohne Rätselraten beantwortbar. |
| Move während des Kopierens abgebrochen | Staging liegt im **Ziel**, nicht im Quell-Root; Locator zeigt noch auf alt ⇒ Zustand ist „nichts passiert". Staging-Reste werden beim nächsten Start best-effort entfernt. |
| Stromausfall vor Locator-Switch | alter Root, unverändert. |
| Stromausfall nach Locator-Switch | neuer Root — er war vor dem Switch vollständig verifiziert. |
| Restore nach Data-Root-Wechsel | Restore resolvt Backups über `backup_location::resolve_root(data_root)` und schreibt in den **aktiven** Root. Snapshots sind root-unabhängig (relative Pfade im Manifest) ⇒ ein vor dem Umzug erstellter Snapshot ist danach weiter einspielbar. |
| Update nach Data-Root-Wechsel | Updater ersetzt nur App-Dateien; der Locator liegt in AppData und wird nicht angefasst ⇒ derselbe Data Root. |
| App zweimal gestartet | `tauri_plugin_single_instance` beendet die zweite Instanz vor jeder DB-Initialisierung — bereits vorhanden und deckt auch zwei Roots ab. |
| Unicode / Leerzeichen in Pfaden | `PathBuf`/`std::fs` sind byteweise korrekt; Anforderung an die Implementierung: nirgends per String-Konkatenation bauen, im Locator JSON-escaped speichern, in Fehlermeldungen nie ungeprüft interpolieren. |
| Cross-Volume `C:` → `E:` | Es wird **grundsätzlich** kopiert, nie `rename` über Volumes vorausgesetzt. Der einzige Rename ist Staging→Ziel **innerhalb** des Ziel-Volumes. |

**Übergreifende Invariante:** in **keinem** dieser Fälle darf die App still einen neuen, leeren
Produktionsbestand anlegen. Ein leerer Bestand entsteht ausschließlich, wenn gar kein Locator und
gar kein AppData-Bestand existiert (echte Neuinstallation).

---

## 8. Test-Isolation — bewiesen

* Der Locator liegt im **identifier-eigenen** AppData. Produktion (`com.lataif.app`) und E2E
  (`com.lataif.app.e2e`) können den Locator des jeweils anderen nicht sehen — die Isolation ist
  strukturell, nicht per Konvention. Es gibt **keinen** fest verdrahteten gemeinsamen Locator-Pfad.
* `test/e2e/data-root.e2e.mjs` misst das am laufenden Prozess: nach dem kompletten Durchlauf wurde
  weder die Produktions-Business-DB noch die Produktions-Server-DB angefasst, im
  Produktions-Identifier existiert **kein** `data-location.json`, und der E2E-Locator enthält
  keinen einzigen Produktionspfad.
* Rust-seitig deckt `two_identifiers_never_share_a_locator` denselben Vertrag ab.

---

## 9. Phasenschnitt

* **B1 — ERLEDIGT.** Resolver + Locator/Marker + `rootId`-Bindung + fail-closed Startvertrag +
  Konstanten-SSOT + `get_runtime_paths` + Renderer-Umstellung + Fix des pre-destructive Backup-Ortes
  + zentralisierter Overlap-Validator.
* **B2 — ERLEDIGT (dieser Commit).** Move-Engine (Intent, Boot-Ausführung, Preflight, Copy, Verify,
  Finalisierung, Locator-Commit, Rollback), Settings-UI „Data Location", fail-closed
  Pfad-Normalisierung, kontrolliertes Cleanup eigener Temp-Dateien. Der alte Root bleibt
  **vollständig erhalten**; es gibt keine Löschfunktion.
* **B3 — Fresh-Install-Auswahl** (§6): einmalige Ortswahl bei einer echten Neuinstallation. Ein
  Update fragt weiterhin **nichts** und migriert **nichts**.
* **Später, getrennt:** Altbestand-Cleanup — erst nach mehreren echten Starts, Backup, Restore und
  Live-Validierung, und nur als bewusste, owner-gated Aktion.

## 10. Was B1/B2 NICHT tun

* Kein automatischer C:→E:-Move, weder beim Update noch beim ersten Start — der Umzug ist immer eine
  bewusste Owner-Aktion.
* Keine Änderung an Produktionsdaten, keine DB-Kopie in einen fremden Bestand, keine neue leere DB in
  irgendeinem Fehlerfall.
* Keine Änderung an der Backup-Location-Konfiguration (live weiterhin `E:\`).
* Kein Löschen eines alten Data Root.
* Kein Version-Bump (bleibt `0.8.42`), kein Push, kein Tag, kein Release.

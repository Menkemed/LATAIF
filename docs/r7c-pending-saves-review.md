# R7C — offene PC2-Speichervorgänge (R1–R3) und Datenbank-Startschutz (R4)

Stand 15.09.2026 · Basis `1635c8a` (R7B, gepusht) · Version 0.8.54 · Registry 175 (unverändert) · kein Push/Tag/Release.
Herkunft der Befunde: `docs/r7b-pp12-image-paths-review.md` § 0 (R1–R4), § 5 (Wiederholung), § 6 (Persistenz).

## 0. Status (umgesetzt · getestet · unabhängig freigegeben — getrennt)

| Punkt | umgesetzt | getestet (lokal) | unabhängig freigegeben |
|---|---|---|---|
| **R1** Vorgang überlebt Maskenwechsel / Neuladen / Neustart | ja — `2b98e46` | ja — Einheit 56/0, E2E S1 + S3 (Wiederaufnahme nach Zustandsverlust) | **ja** — unabhängig technisch freigegeben (Auftrag N1, 15.09.2026) |
| **R2** Formularänderung nach unklarem Ausgang | ja — `2b98e46` | ja — Einheit, E2E S2 | **ja** (s. R1) |
| **R3** Konflikt nach Verdrängung / Neustart korrekt; „dieser Versuch lief nicht" ≠ Beweis | ja — `2b98e46` | ja — Einheit, Rust 2/0 + 44/0 + 76/0, E2E S4 (nach Fund und Behebung `8f37ee5`) | **ja** (s. R1) |
| **R4** vorhandene 0-Byte-`lataif.db` → `DB_RECOVERY_REQUIRED` | ja — `c4098a8` | ja — c6 27/0, E2E S5 | **ja** (s. R1) |
| **G5** Ganz-DB-Speichern skaliert | nein | — | **OPEN, nicht akzeptiert** |
| **N1 (neu, vorbestehend)** PC2 lässt sich über das Fenster nicht regulär beenden | ja — Folgecommit N1 (§ 6a) | ja — Rust `first_run_ipc`/`shutdown_tests` (neuer Test grün), gezielter Zwei-App-Lauf S3 **21/0** (PC2 endet nach WM_CLOSE von selbst, Exit-Code 0, kein Helfer) | **nein** (ausstehend) |
| **N2 (neu, vorbestehend seit `02c976b`)** Rust-Gate `every_command_is_either_root_bound_or_named_as_first_run_safe` rot (`media_normalize_record_image` nicht eingeordnet) | ja — eingeordnet als **B (absichtlich ohne Wurzel erreichbar)**, nur Test/Klassifikation (§ 7) | ja — `cargo test --lib -- first_run_ipc` **5/0** (inkl. neuem Reinheits-Pin) | **nein** (ausstehend) |

## 1. Ausgangslage (Callpaths vor R7C)

- **R1:** `CommandSaveController` / `CommandSaveAttempt` lebten in `useMemo`/`useRef` der Maske (`shared-write.ts`). Nach
  „keine Antwort" + Maskenwechsel/Neuladen gab `beginAttempt` eine NEUE Kennung aus; hatte der erste Lauf committet → zweite
  Wirkung. Kein Ort außerhalb der Maske kannte den Vorgang.
- **R2:** `shared-write` baut den Rumpf bei jedem Klick neu. Nach „keine Antwort" + Formularänderung ging der neue Rumpf unter
  der alten Kennung hinaus → 409 `BRIDGE_COMMAND_ID_CONFLICT` `not_executed`; der Versuch blieb offen → jeder Klick derselbe
  Konflikt.
- **R3:** Nach Verdrängung der Kennung aus dem Rust-Speicher (> 1024) oder Neustart kam der Konflikt aus dem durablen Nachweis
  (`mutation-engine` → `CommandNotEvaluated('COMMAND_ID_CONFLICT')`) über `command-registry` als `infrastructure_error` →
  `routes.rs` 500 ohne `outcome` → PC2 „unbekannt". Zudem galt jedes `not_executed` als „nichts passiert", auch wenn ein
  früherer Versand desselben Vorgangs mit offenem Ausgang geendet hatte.
- **R4:** `loadSavedDb`: `exists` → `readFile` → `bytes` auch bei 0 Byte; sql.js öffnet 0 Byte als leere Datenbank →
  `initDatabase` legte Schema/Migrationen an (entgegen C6-P1). Außerdem galt `exists: false` als „fehlt", obwohl Rust
  `Path::exists` jeden Metadatenfehler (z. B. Zugriff verweigert) als „nein" meldet.

## 2. R1 — der offene Vorgang bleibt erhalten

**Ablage** (`src/core/bridge/pending-saves.ts`): eine Datei je Vorgang `<AppLocalData>/pending-saves/<Kennung>.json`
(Temp-Datei + Umbenennen; Tauri plugin-fs, Rechte `fs:default` = AppLocalData lesen inkl. `read_dir`, schreiben/umbenennen
über den bestehenden Scope). Inhalt: `commandId`, `op`, der ursprüngliche Auftrag (`payload`, genau so gesendet), Kontext
(`server` = Primary-Adresse, `tenantId`, `userId`, `branchId` aus dem Ausweis), Zustand `sending | unresolved | conflict`.
Keine zweite Wahrheit über Geschäftsergebnisse: ob der Vorgang stattfand, sagt weiterhin nur der durable Nachweis des
Primary; die Ablage hält nur Kennung + Auftrag, um ihn dort zu fragen.

**Vor dem ersten Versand** (`CommandSaveAttempt.send`): Datei schreiben → erst dann `fetch`. Scheitert das Schreiben →
`not_executed PENDING_STORE_FAILED`, nichts geht hinaus.

**Nach der Antwort** (`conclude`): Erfolg oder endgültiges Nein → Datei entfernt; offen → `unresolved`; Konflikt →
`conflict`; `not_executed` ohne jeden früher vielleicht angekommenen Versand → Datei entfernt (nichts passiert).

**Wiederaufnahme** (`attemptForPending`): derselbe laufende Versuch der Maske, sonst aus der Datei — dieselbe Kennung, derselbe
Auftrag; gilt als „kann gelaufen sein". Nur im selben Kontext (`sameContext`): anderer Primary/Mandant/Benutzer/Filiale →
`PENDING_CONTEXT_MISMATCH`, nichts gesendet; die Leiste zählt ihn als „gehört zu einer anderen Anmeldung".

**Sichtbar klären** (`src/components/shared/PendingSavesBar.tsx`, nur PC2): „Unresolved saves" listet die offenen Vorgänge des
Kontexts; „Clarify now" wiederholt den URSPRÜNGLICHEN Auftrag unter SEINER Kennung → Replay (war gespeichert, nichts kommt
hinzu) oder genau einmal ausgeführt; das Ergebnis wird in Worten gezeigt. „Remove…" nur mit zweitem Klick („nach Prüfung am
Primary"). Eine neue Kennung entsteht dort nie.

**Neue Vorgänge bleiben möglich** (`CommandSaveController.guardNewEntry`, in `useSharedWrite`/`useSharedWrites` VOR
`beginAttempt`): ist für dieselbe Buchung ein früherer Vorgang offen, sagt der erste Klick das
(`EARLIER_SAVE_UNRESOLVED`, nichts gesendet); der zweite Klick ist die ausdrückliche Entscheidung „neuer, eigener Vorgang" →
neue Kennung. Mehrere offene Vorgänge = mehrere Dateien; keiner überschreibt einen anderen.

**Bild-/Staging-Verweise:** gespeichert wird der Auftrag mit seinen `stagingId`s. War der Vorgang schon gebucht, braucht die
Klärung die Ablage des Primary nicht (Replay aus dem Nachweis). War er es nicht und hat der Primary die nicht abgeholte
Ablage inzwischen aufgeräumt (Karenz 1 h beim Start), antwortet er mit dem endgültigen Nein `STAGED_IMAGE_GONE` → die Leiste
sagt „die Fotos sind nicht mehr auf dem Primary — mit Fotos neu erfassen"; der Vorgang ist beantwortet.

## 3. R2 — ursprünglicher Auftrag und Formularänderung getrennt

`send` vergleicht den Rumpf (schlüsselstabil, `stableJson`) mit dem gesicherten ursprünglichen Auftrag. Abweichung →
`unknown ORIGINAL_UNRESOLVED`, **nichts gesendet**, beliebig oft. Meldung: „your changes were NOT sent … first clarify the
earlier save under ‚Unresolved saves' (it repeats the ORIGINAL under its own number); then save your changes as an edit or a
new entry". Nach der Klärung ist der Versuch der Maske beantwortet (dieselbe Instanz); der nächste Klick ist ein neuer
Vorgang mit neuer Kennung — bewusst, nicht als automatischer Ausweg.

## 4. R3 — Ergebnis korrekt einordnen

- Renderer (`command-registry.ts`): `CommandNotEvaluated('COMMAND_ID_CONFLICT')` → `{ kind: 'not_executed', code:
  'BRIDGE_COMMAND_ID_CONFLICT' }` (alle anderen Nicht-Zustandekommen bleiben `infrastructure_error`).
- Rust (`bridge.rs` `Reply::NotExecuted`, `routes.rs` `command_reply_parts`): → 409 `{ error, message, outcome: 'not_executed' }`
  — dieselbe Form wie `BridgeError::CommandIdConflict` aus dem Kennungsspeicher. Serde-Form im Rust-Test aus dem exakten JSON
  des Renderers.
- Rust-Kennungsspeicher (`bridge.rs` `IdentityStore::forget_refused`, `8f37ee5`): eine Anfrage, die der durable Nachweis
  abgewiesen hat (`Reply::NotExecuted`), bleibt NICHT als Besitzer der Kennung im Speicher stehen. Vorher (gefunden im
  E2E-Lauf 1, S4) wies der Speicher danach den rechtmäßigen ursprünglichen Auftrag selbst mit 409 ab — bis Verdrängung oder
  Neustart. Entfernt wird nur genau diese Identität und nur ohne laufenden Auftrag; danach schützt der Speicher die Kennung
  wieder für den ursprünglichen Rumpf (`bridge_tests` `a_request_the_durable_ledger_refused_does_not_block_the_original_afterwards`).
- PC2: Konflikt → Vorgang bleibt offen (`conflict`), nie beendet. `not_executed` nach einem früher offenen Versand →
  `unknown EARLIER_TRY_OPEN` (z. B. 401 nach 504): „dieser Versuch lief nicht, der frühere ist offen".
- Grenzen unverändert: Berechtigung vor dem Handler (`executeCommand`), eine Transaktion mit Nachweis (`runRemoteCommand`),
  Audit/Buchung/Bestand im Handler, Nachweis `remote_command_ledger` wie bisher.

## 5. R4 — vorhandene leere Datenbank

`src/core/db/db-file-load.ts` `loadDbFile` (von `loadSavedDb` benutzt): Existenzfrage scheitert → unlesbar; `exists: false` →
Nachfrage `stat`: nur „nicht gefunden" (os error 2/3, ENOENT) = fehlt → Erststart; jeder andere Fehler → unlesbar („absence not
proven"); Datei gefunden → lesen; **0 Byte → unlesbar** („kept unchanged; restore the last backup"). `initDatabase` wirft bei
unlesbar `DB_RECOVERY_REQUIRED` VOR Schema, Migration, Speichern (C6-P1) — die Datei wird weder neu erstellt noch
überschrieben, gelöscht oder wiederhergestellt. Kein Integritätsaudit, kein Speicherumbau.

## 6. Nachweise

| Lauf | Ergebnis | Quellstand |
|---|---|---|
| `node test/r7c/pending-saves.test.ts` | **56/0** (`POST_PARITY_R7C_PENDING_SAVES_PROVED`) | Arbeitsbaum = `2b98e46` |
| `node test/c6/c6-db-fail-closed.test.ts` | **27/0** (R4 §3: 0-Byte unverändert + Recovery, fehlend → Erststart, gültig lesbar, Lesefehler ≠ fehlend) | = `c4098a8` |
| Nachbarn: `client-invoice-ui`, `client-invoice-lifecycle-ui`, `client-masterdata-ui`, `client-commercial-ui` 26/0, `client-financial-ui` 23/0, `client-lifecycle-ui` 24/0, `client-service-ui` 16/0, `client-read-mode`, `remote-invoice-create`, `r4b-write-adapter`, `c4-authorization` 169/0, `r7b-platform-hardening`, `write-foundation` | alle rc=0 | = `2b98e46` |
| `npx tsc -b` | rc=0 | = `2b98e46` |
| `cargo test --lib -- command_reply` · `cargo test --lib bridge` | 2/0 · 43/0 | = `2b98e46` |
| `cargo test --lib bridge` nach `8f37ee5` | **44/0** (neu: vom Nachweis abgewiesene Anfrage blockiert den ursprünglichen Auftrag nicht) | `8f37ee5` |
| `cargo test --lib sync::routes` | erst **3 rot** (w4/w5/raw_body_gate_order: die Quelltext-Gates lesen bis zum ERSTEN `#[cfg(test)]`, das neue Testmodul stand mitten in der Datei) → Testmodul ans Dateiende (`04808fb`) → **76/0** | `04808fb` |
| ESLint geänderter Dateien | 0 neue Fehler (database.ts 1 = vorher 1) | = `2b98e46` |
| E2E `test/e2e/r7c-pending-saves.e2e.mjs` Lauf 1 | **27/2** — Fund R3: nach einer vom Nachweis abgewiesenen Anfrage wies der Rust-Kennungsspeicher den ursprünglichen Auftrag selbst ab (409 statt Replay) → behoben `8f37ee5`; zweiter Fehler = N1 | Build `2b98e46` |
| E2E Lauf 2 (final) | **28/1** — alle R1–R4-Prüfungen ja; der eine Fehler ist die Teilprüfung „PC2 endet nach dem Schließen selbst" = **N1** | Build `8f37ee5` (`lataif.exe` sha256 `770bf758…`, Client `6e8e5aad…`) |

**E2E Lauf 2 im Einzelnen** (zwei echte Anwendungen, PC2 als B, isoliert):
- **S1** „New Client" auf PC2, die Antwort geht verloren: Maske „No answer from the primary", der Primary hat genau einmal
  gebucht (1 Kunde, 1 Nachweiszeile), `pending-saves/<Kennung>.json` = `unresolved` mit dem gesendeten Rumpf, B und Primary.
- **S2** Feld geändert, Speichern: „changes were NOT sent", kein Auftrag, kein Nachweis, 0 Kunden mit dem geänderten Namen,
  die Datei behält den ursprünglichen Rumpf.
- **S3** Primary regulär neu gestartet (Kennungsspeicher leer), PC2 beendet (regulär nicht möglich → N1; eigener Prozess über
  den Helfer) und neu gestartet, weiter als B angemeldet: die Datei hat überlebt, die Leiste zeigt genau diesen Vorgang,
  „Clarify now" schickt den ursprünglichen Rumpf unter derselben Kennung → 200 `replayed`, „WAS saved"; 1 Kunde, 0 geändert,
  1 Nachweiszeile, Datei weg, Leiste leer.
- **S4** Primary erneut neu gestartet: dieselbe Kennung + anderer Rumpf über HTTP mit B's Ausweis → **409
  `BRIDGE_COMMAND_ID_CONFLICT` / `not_executed`**; danach der ursprüngliche Rumpf → **200 `replayed`**; Bestand unverändert.
- **S5** Primary regulär beendet, `lataif.db` beiseite kopiert und auf 0 Byte gesetzt, gestartet: Wiederherstellungsmeldung,
  keine Anwendung, kein Ersteinrichten; die Datei bleibt 0 Byte mit derselben Änderungszeit, keine `lataif.db.tmp-*` — auch
  nach dem Beenden; Bytes zurück → normaler Start, angemeldet, der Kunde aus S1 ist da.

**N1 — Diagnose (wörtlich aus dem Fenster von PC2 nach WM_CLOSE):** „Save failed state not managed for field `state` on
command `finalize_application_shutdown`. You must call `.manage()` before using this command The app stays open. Please close
again to retry." Der Abschlussbefehl verlangt den Tauri-Zustand `AppHandleState`, der nur im Primary-Aufbau verwaltet wird
(`lib.rs` `app.manage(AppHandleState { … })`); im Client-Modus fehlt er → das Beenden bricht nach Regel A/B sichtbar ab, das
Fenster bleibt offen. Vorbestehend: `lib.rs` ist zwischen `1635c8a` und HEAD unverändert; kein früherer Test beendete PC2
regulär. Auswirkung: PC2 lässt sich nur über den Task-Manager beenden. Nicht Teil von R1–R4; die offenen Vorgänge überleben
auch dieses harte Ende (S3). **Korrektur zu Lauf 1/2:** PC2 wurde dort in S3 NICHT regulär beendet, sondern nach 20 s über den
harten Test-Helfer (`killTestPid`, eigene PID am exakten Test-Pfad; Lauf 2: `hart: true`, 103 s). „Regulär" galt in beiden
Läufen nur für den Primary. Behoben und regulär nachgewiesen erst in § 6a.

### 6a. N1 — PC2 regulär beenden (Folgecommit)

**Callpath:** Fenster-X → `onCloseRequested` (`App.tsx`) → `prepareAndCloseApplication` (Sync pausieren, abwarten, Flush) →
`closeWindow` → `invoke('finalize_application_shutdown')`. Der Finalizer nahm `tauri::State<'_, AppHandleState>`. Diesen
Zustand verwaltet nur `setup()` eines Starts MIT Datenwurzel; PC2 (Client-Modus, leeres Kontrollverzeichnis) läuft im Zweig
`Resolution::FirstRunUndecided` → nur `FirstRunState`, keine Brücke, kein Server, keine Datenbank. Tauri konnte den Parameter
nicht auflösen → Fehler vor dem Exit → Regel A/B: sichtbar abgebrochen, App bleibt offen.

**Braucht der Finalizer den Zustand auf PC2?** Nein. Er benutzt davon nur `server` (Sync-Server stoppen). Ohne Wurzel wurde nie
ein Server gebaut oder gestartet; die Brücke (`bridge::global()`) ist dort ebenfalls nicht installiert und wird schon bisher
optional behandelt. **Änderung** (`lib.rs`): der Finalizer nimmt nur `AppHandle`; `app.try_state::<AppHandleState>()` liefert
den Server, WENN es den Zustand gibt → Stopp (3-s-Deckel) → `exit(0)`; gibt es ihn nicht → nichts zu stoppen → `exit(0)`. Kein
Ersatzzustand, kein Serverstart, keine Datei/DB. Primary-Pfad unverändert (gleicher Server-Stopp, gleiche Reihenfolge,
Idempotenz `SHUTDOWN_STARTED`). `first_run_ipc_tests`: Finalizer als „ohne Wurzel erreichbar" eingeordnet (Zusage: beendet nur
den Prozess) + neuer Test `closing_works_without_a_data_root_and_without_a_stand_in_state` (kein `State<`, optionaler Lookup →
Stopp → Exit, kein `manage(`/`SyncServer::new`/`.start(`/`std::fs::`/DB im Rumpf, `AppHandleState` weiter an genau einer Stelle
verwaltet).

| Lauf | Ergebnis | Quellstand / Binary |
|---|---|---|
| `cargo test --lib -- first_run_ipc shutdown_tests` | 8/1 — neuer N1-Test **ok**, `shutdown_tests` 5/0, `first_run_pending`-Weiche/Riegel ok; der 1 Fehler = **N2** (`media_normalize_record_image`, vorbestehend seit `02c976b`, im Diff nicht berührt) | Arbeitsbaum = N1-Commit |
| E2E gezielt `R7C_NUR=S3 node test/e2e/r7c-pending-saves.e2e.mjs` (S1-Schritte nur als Vorbedingung; S2/S4/S5 nicht wiederholt — deren Produktcode unverändert) | **21/0**, `POST_PARITY_R7C_TARGETED_S3_PROVED` | frische Builds aus dem N1-Stand: `lataif.exe` sha256 `5d520c50bd922c3cf9b47aaa788e8e2778977cdfc7c25686b2bcef6d9121a72e`, `lataif-e2e-client.exe` `7a9fcfe3874d253f9c929de323408df6f640f281ae4da78b2dc288459a8ebc53` |

Gemessen (S3): offener Vorgang `unresolved` vorhanden → PC2-Fenster schließen (WM_CLOSE) → **PC2 endet von selbst nach 2 s,
Exit-Code 0, kein Helfer** (`zu/weg: true`, `hart: false`) → Datei vor und nach dem Beenden da, **Byte für Byte gleich** →
Neustart: **weiterhin B**, ohne neue Anmeldung → die Leiste zeigt genau diesen Vorgang → „Clarify now" sendet den
ursprünglichen Rumpf unter derselben Kennung → **200 `replayed`**, 1 Kunde, 1 Nachweiszeile → Datei weg, Leiste leer. Keine
`lataif*.db*` unter den Profilorten von PC2 (vor dem Beenden, danach, nach Neustart + Klärung: 0/0/0). Primary im selben Lauf
regulär beendet (Exit-Code 0, 2 s) und neu gestartet, beantwortet die Klärung. Produktion (fremde `lataif.exe`), `E:\LATAIF\Data`,
Ports 3001/3443 unberührt (Isolationsprüfung des Laufs grün).

Die Einheitstests prüfen die fachliche Wirkung (Buchungs- und Nachweiszeilen an sql.js), nicht nur Rückgabewerte: verlorene
Antwort + Neuladen + Primary-Neustart → Klärung = Replay, genau eine Buchung; nie angekommen → Klärung bucht genau einmal;
Ablage scheitert → nichts gesendet; Formularänderung → nichts gesendet, erst Klärung, dann die Änderung als eigener Vorgang
(je genau einmal); Konflikt nach Neustart → 409 `not_executed`, Vorgang offen, keine Wirkung; 401 nach offenem Versand →
offen; zwei offene Vorgänge unabhängig; fremder Kontext; neue Kennung nur ausdrücklich; Staging weg → begründetes Nein.

## 7. Grenzen (ausgewiesen, nicht Teil dieses Auftrags)

- **G5** Ganz-DB-Speichern skaliert mit der Dateigröße — **OPEN, nicht akzeptiert** (R7B-Review § 8).
- **N1** PC2 ließ sich über das Fenster nicht regulär beenden — behoben im Folgecommit (§ 6a), lokal nachgewiesen,
  unabhängige Freigabe ausstehend.
- **N2 (neu, vorbestehend seit `02c976b`, R7B PP-12)** Das Rust-Gate
  `first_run_ipc_tests::every_command_is_either_root_bound_or_named_as_first_run_safe` ist rot: `media_normalize_record_image`
  (Belegbild im Speicher umrechnen, ohne `AppHandleState`, ohne Datei/DB) ist keiner Klasse zugeordnet. Beim gezielten
  N1-Testlauf gefunden. **Klassifiziert (Folgecommit N2): B — absichtlich ohne Wurzel erreichbar.** Callpath: registriert in
  `generate_handler!`; Parameter nur `data_base64: String` (kein `State`, kein `data_root_of`); Größe vor dem Dekodieren
  begrenzt; `record_image_json` → `normalize_record_image` → `normalize_stock_image` rein im Speicher (`spawn_blocking`); heraus
  Base64 + `mime`/`bytes`/Maße. Keine Datei, keine DB, kein Medienspeicher, keine Geschäftsdaten — nur Bildbytes. Aufrufer:
  Primary (`repair-house`, `scrap-house`, `masterdata-save`, Abgleich) UND PC2 vor dem Ablegen (`stageRecordDataUrls` →
  `normalizeRecordImages`) — PC2 läuft im Erstlauf-Zweig ohne Wurzel; wurzelgebunden könnte PC2 kein Belegbild mehr senden (A
  wäre ein Produktbruch, C liegt nicht vor: keine ungeschützte Grenze). Änderung nur im Test: Eintrag mit Begründung in
  `FIRST_RUN_SAFE` + Pin `the_record_image_normalizer_stays_pure_bytes_in_bytes_out` (nur `data_base64`, Deckel vor
  Dekodieren, kein Zustand/Datei/DB im Rumpf, `record_image.rs`/`normalize.rs` ohne `std::fs`/`File::`/`rusqlite`/Pfade) — fängt
  der Befehl an zu speichern, fällt der Test um. `cargo test --lib -- first_run_ipc` **5/0**. Kein Build/E2E (kein Produktcode).
- Die Ablage folgt dem bestehenden Persistenzvertrag: neustartfest; Stromausfall-Dauerhaftigkeit nicht garantiert (kein
  fsync, wie die Geschäftsdatenbank, R7B-Review § 6).
- Ein Vorgang im Zustand `conflict` lässt sich nicht automatisch klären (der Primary hält die Kennung für anderen Inhalt):
  Prüfung am Primary, dann „Remove…".
- Im Browser-Entwicklungsmodus (ohne Tauri) liegt die Ablage nur im Speicher des Fensters.

## 8. Git

- `c4098a8` — R4 (`db-file-load.ts`, `database.ts`, c6-Test).
- `2b98e46` — R1–R3 (`pending-saves.ts`, `client-command-save.ts`, `shared-write.ts`, `command-registry.ts`,
  `PendingSavesBar.tsx`, `App.tsx`, `bridge.rs`, `routes.rs`, Tests).
- `04808fb` — Folge: Rust-Testmodul `command_reply_tests` ans Ende von `routes.rs` (nur Testcode; Produktcode = `2b98e46`).
- `8f37ee5` — Folge R3: Kennungsspeicher merkt eine vom durablen Nachweis abgewiesene Anfrage nicht als Besitzer (E2E-Fund).
- `617c2c8` — Doku-/E2E-Commit — dieses Review, SSOT, `test/e2e/r7c-pending-saves.e2e.mjs` (Lauf 2: 28/1, der Fehler = N1).
- Folgecommit N1 — `finalize_application_shutdown` ohne Pflicht-Zustand (`lib.rs`), `first_run_ipc_tests.rs`, E2E gezielt
  (`R7C_NUR`, Exit-Code-Beleg, keine DB auf PC2), Doku inkl. Korrektur „PC2 regulär" (§ 6).

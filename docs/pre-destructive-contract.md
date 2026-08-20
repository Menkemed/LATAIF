# Pre-destructive contract — Audit 20.08.2026

Alle produktiven Operationen, die dauerhaft Daten ersetzen, löschen, zurücksetzen oder einen
Zustand irreversibel verändern können. Aufgenommen wurde, was wirklich zerstört — nicht jede
fachliche Löschung: `deleteInvoice`, `cancelPurchase`, `deleteProduct` & Co. sind sync-getrackt und
über Ledger-Reversals rückholbar und stehen deshalb nicht in dieser Tabelle.

**Der Vertrag:** eine destruktive Operation darf erst weiterlaufen, wenn der für sie
vorgeschriebene Sicherheitszustand *nachweislich* hergestellt ist. Scheitert er, bricht die
Operation ab und meldet das — kein Erfolg ohne Sicherung, kein halber Zustand.

| # | Entry Point / UI | Command / Core | Owner-/Auth-Gate | Preflight | Pre-destructive Sicherung | Ziel | Verifikation | Commit Point | Fehlerverhalten |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Settings → Danger Zone → Factory Reset | `SettingsPage.handleReset` → `runGuardedReset` → `resetDatabase` | eingeloggt + getipptes `RESET` | `isFactoryResetBlocked` (Sync/LAN konfiguriert → gesperrt), Signale beim Klick frisch gelesen | `flushDatabase` + `createPreDestructiveBackup('factory-reset')` | `<backupsRoot>/pre_destructive_<ts>/` | `manifest.json` mit Größe + SHA-256 je Datei | `deps.reset()` NACH erfolgreichem Backup | Backup wirft → kein Reset, Meldung „es wurde nichts gelöscht" |
| 2 | Login-Screen → „Reset Database" | `LoginPage.handleReset` → `runGuardedReset` | getipptes `confirm` | wie #1 | wie #1 (`'factory-reset-login'`) | wie #1 | wie #1 | wie #1 | wie #1 |
| 3 | Settings → Danger Zone → Safe Purge | `SettingsPage.handlePurge` → `runSafePurge` | eingeloggt + getipptes `DELETE` | `countPurge` (read-only Vorschau), `PURGE_PLANS` Kinder-vor-Eltern | `flushDatabase` + `createPreDestructiveBackup('purge:<target>')` | wie #1 | wie #1 | `commit()` der Ledger-Tx | Backup- **oder** Purge-Fehler → `rollback()`, nichts (halb) gelöscht |
| 4 | Settings → Import → Produkte importieren | `ImportPage.handleImport` → `runProductImport` | eingeloggt | Klassifizierung + Dedup vor dem Schreiben | `createPreDestructiveBackup('import-products')` | wie #1 | wie #1 | pro Zeile (**nicht** atomar — bewusst, dokumentiert) | ohne Backup-Erfolg **kein** `createProduct` |
| 5 | Settings → Backup → Snapshot wiederherstellen | `schedule_restore_snapshot` → Boot-Swap (`media::restore`) | `authorize_owner` **vor** dem Intent | vollständiger Pre-Check des Snapshots (Manifest-Version, kanonische Pfade, kein Symlink/Traversal, jede Datei mit passender Größe + SHA-256, keine Fremddatei) | Live-DBs + Medienwurzel werden **beiseite bewegt** (Rollback-Punkt), Backup-Quelle bleibt unberührt | Staging auf demselben Volume wie live | erneutes Hashen der **gestagten** Bytes gegen das Manifest (schließt TOCTOU), danach Integritätsprüfung | durables `done` im Write-ahead-Journal | In-Process-Fehler → exakter Rollback; Absturz → `recover()` stellt den ALTEN Stand her, nie einen gemischten |
| 6 | Settings → Datenort verschieben | `preflight_data_root_move` / `schedule_data_root_move` → Boot-Move | `authorize_owner` **vor** dem Intent, Preflight serverseitig wiederholt | `data_root_move::preflight` (Ziel leer/schreibbar, nicht im Installationsordner, Backup-Root berücksichtigt) | Copy **vor** Commit; der alte Root wird nicht gelöscht, sondern eingefroren stehen gelassen | Ziel-Root | Verify nach dem Kopieren, erst dann Locator-Commit | Locator zeigt auf den neuen Root | Abbruch → `clear_pending_data_root_move`; kein Intent bei fehlgeschlagenem Preflight |
| 7 | Settings → Storage → Medien-GC | `scan_unused_media` (dry-run) → `schedule_media_gc` → Boot-Move → `finalize_media_gc` | `authorize_owner` bei Schedule **und** Finalize | Referenzmenge = **alle** `media_blob_generations.storage_key`, fail-closed bei jedem Lesefehler | Boot verschiebt nach `.gc-quarantine/<run>/` — Löschen erst im Finalize | Quarantäne unter der Medienwurzel | Audit-Row `media_gc_runs` je Lauf (planned/quarantined/completed/partial/failed) | `finalize_media_gc` — der **einzige** Ort, an dem gelöscht wird | Fehler → Dateien bleiben in Quarantäne; `clear_pending_gc_intent` nimmt einen nicht ausgeführten Intent zurück |
| 8 | Settings → Storage → Staging-GC | `staging_gc_dry_run` | `authorize_owner` | — | entfällt: **löscht nie** | — | — | — | read-only |
| 9 | Settings → Backup → Aufbewahrung | `set_backup_retention` | `authorize_owner`, Keep-Count auf [1, 1000] geklemmt | — | — | — | — | — | derzeit **deaktiviert** (Single-PC-Scope, siehe RETENTION-I1) |
| 10 | `/admin/repair-flow-test` | `RepairFlowTestPage` | `usePermission` → sonst Redirect | Testdaten tragen den Präfix `TEST_FLOW_` | entfällt | — | — | — | räumt ausschließlich die selbst erzeugten `TEST_FLOW_`-Records ab |

## Was der Audit gefunden hat

**#2 war gebrochen.** Der Login-Screen bot ein „Reset Database" an, das direkt hinter einem
`confirm()` `resetDatabase()` aufrief: **ohne** Pre-destructive Backup, **ohne** den
Resurrection-Guard aus D3b — und vor jeder Anmeldung erreichbar. Damit ließ sich der gesamte
D3-Vertrag umgehen, den #1 zwei Klicks weiter sorgfältig einhält. Behoben: derselbe
`runGuardedReset`-Pfad wie #1.

**Kein zweiter Bruch.** Die übrigen neun Pfade halten ihren Vertrag:
- Der Owner-Gate sitzt überall **vor** dem Schreiben eines Intents (#5, #6, #7) — ein abgelehnter
  Login hinterlässt keinen geplanten destruktiven Vorgang.
- Kein Pfad benutzt mehr einen fest verdrahteten `<appData>/backups`-Fallback; Schreiben *und*
  Lesen gehen durch `backup_location::resolve_root`, also über denselben Root. (Ein Kommentar in
  `media/restore.rs` behauptete noch das Gegenteil — korrigiert.)
- Fail-closed ist überall die Voreinstellung: `runGuardedReset`/`runSafePurge` schlucken keinen
  Backup-Fehler, die GC-Referenzmenge wird bei jedem Lesefehler zum Fehler statt zu „alles
  verwaist", und `runProductImport` startet ohne Backup gar nicht erst.

## Was der Vertrag *nicht* abdeckt

Zwischen Backup und destruktivem Commit liegt bei #1/#3/#4 ein kurzes Fenster, in dem ein anderer
Schreiber im selben Prozess noch etwas ändern könnte; das Backup wäre dann um diese eine Änderung
älter. Für den Single-PC-Scope ist das kein Datenverlust — die destruktive Aktion läuft
benutzergetrieben im Vordergrund und `flushDatabase()` läuft unmittelbar davor. Ein echter Lock
gehört zum Multi-Writer-Thema und ist hier ausdrücklich nicht gebaut.

## Regressionsschutz

`test/d3/reset-callpath-contract.test.ts` liest die Quellen und hält fest, dass **jeder**
Produktionsaufrufer von `resetDatabase` durch `runGuardedReset` geht und ein `backup` mitgibt —
plus die Reihenfolge im Vertrag selbst (Backup vor Reset, `await`, kein verschlucktes `catch`).
Genau die Lücke, die der Kern-Test nicht sehen konnte, weil er den Vertrag prüft und nicht seine
Aufrufer.

## Verlangt der Factory Reset Owner-Credentials? Nein — und das ist so gewollt

Die Frage wurde am Code und am kanonischen Vertrag entschieden, nicht daran, dass beide
Einstiegspunkte dasselbe tun.

**Der Vertrag** steht in `src/core/settings/safe-purge.ts` (Abschnitt „D3b — Factory-Reset-Guard"):
*„Factory Reset löscht NUR die lokale DB. Ist Sync/LAN konfiguriert oder aktiv, kann ein späterer
Pull alte Server-Daten wiederherstellen (Resurrection) — genau die D0-Klasse. Darum: Reset
blockieren, solange Sync/LAN konfiguriert ist."* Die dort benannte Gefahr ist **Wiederauferstehung
gelöschter Daten**, nicht ein unbefugter Löschversuch. Ein Owner-Gate kommt im gesamten
D3/D3b-Vertrag nicht vor.

**Die Codelage stützt das.** Es gibt gar kein Rust-Command für den Factory Reset — `resetDatabase`
entfernt die lokale Frontend-DB-Datei, sonst nichts. Die 48 `authorize_owner`-Aufrufe sitzen
ausnahmslos an Commands, die **außerhalb** der lokalen DB wirken: Restore, Data-Root-Move,
Media-GC (Schedule und Finalize), Backup-Ort, Retention, Staging-GC. Genau die Trennlinie ist die
Regel: Owner-Credentials schützen, was Dateien außerhalb der lokalen Datenbank verschiebt oder
löscht — und was ein anderes Gerät oder eine spätere Wiederherstellung betrifft.

**Die Schutzkette für den lokalen Reset** ist damit dreigliedrig und für beide Einstiegspunkte
identisch: (1) ausdrückliche Bestätigung — getipptes `RESET` in der Danger Zone, `confirm()` auf
dem Login-Screen; (2) `isFactoryResetBlocked` — Reset gesperrt, solange Sync oder LAN konfiguriert
ist, Signale beim Klick frisch gelesen; (3) Pre-destructive Backup **vor** dem Löschen, dessen
Fehlschlag den Reset abbricht.

**Ehrliche Grenze der dritten Stufe:** `runPreDestructiveBackup` kopiert die DB-Dateien und
schreibt Größe + SHA-256 je Datei ins Manifest — es liest die geschriebenen Kopien aber **nicht
zurück**. Die Hashes stammen aus den gelesenen Quellbytes. Ein defekter Schreibvorgang fiele damit
erst beim Restore auf, der seinerseits jede Datei gegen das Manifest prüft. Das ist der Stand des
Vertrags, kein neu eingeführter Mangel — und der Grund, warum hier „Verifikation" *aufgezeichnete*
Prüfsummen meint und nicht *rückgelesene*.

Ergebnis: ein unauthentifizierter lokaler Reset ist zulässig, solange diese drei Glieder halten.
Es wurde deshalb **kein** Owner-Gate ergänzt — weder in der Danger Zone noch auf dem Login-Screen.

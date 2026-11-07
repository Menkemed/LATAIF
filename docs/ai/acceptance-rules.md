# Abnahmeregeln für KI-gestützte Arbeit

Diese Datei ist die verbindliche Stelle für Abnahmeregeln. Andere Dokumente verweisen hierher und wiederholen die Regeln nicht.

## Vorschau ist Abnahmegrundlage

Ein vom Owner freigegebenes interaktives Preview ist verbindliche Abnahmegrundlage. Ein grüner automatisierter Testlauf ersetzt niemals den Abgleich zwischen beauftragter Funktion und tatsächlichem Verhalten der Anwendung.

Das heißt für jede Umsetzung nach einem freigegebenen Preview:

1. **Abgleich:** Jede Funktion des Previews wird gegen die laufende App geprüft und in einer Abnahmematrix festgehalten: Funktion im Preview, Funktion in der App, durchgeführte Benutzeraktion, PASS, FAIL oder bewusste Abweichung, nötige Korrektur.
2. **Echte Bedienung:** Geprüft wird in der laufenden Test-App mit Maus und Tastatur (`test/e2e/_e2e-mouse.mjs`). Der Klick muss das sichtbare, nicht verdeckte Element treffen. Felder müssen erscheinen, sich bedienen lassen und nach dem Speichern und erneuten Öffnen stimmen.
3. **Screenshots ergänzen nur:** Ein Bild belegt das Aussehen, nicht die Funktion.
4. **Keine neuen Designentscheidungen:** Weicht die Umsetzung vom Preview ab, steht das als bewusste Abweichung mit Grund im Bericht. Der Owner entscheidet.
5. **Grün heißt nicht fertig:** Ein Bericht darf eine Funktion erst als umgesetzt nennen, wenn ihre Benutzeraktion in der Matrix belegt ist.

## Bekannte Alt-Tests

Diese E2E-Läufe sind rot, ohne dass ein Produktfehler nachgewiesen ist. Sie zählen nicht als Nachweis und nicht als Blocker, solange ihre Abdeckung anderswo steht.

- `c6-release-hardening`: wartet auf `[data-client-mode]`, das es nicht mehr gibt (nicht Teil der Client-Läufe unten, unverändert).

Entfernt (v0.8.97), jede Prüfung zugeordnet bzw. ersetzt in `docs/ai/client-e2e-coverage.md`:
- `c5-operational-acceptance`, `client-commercial`, `client-financial`, `client-invoice-lifecycle`, `client-invoice-ui`, `client-masterdata-ui`, `client-transfer-lifecycle`. Sie nutzten die tote Navigation `data-client-area` (seit `71d1fc4`). Ihre noch nicht anderswo laufenden Prüfungen (Ausfall, Neustart, verlorene Antworten, alte Stände, Rennen) stehen jetzt in `pc2-reliability` und `financial-actions` §7/§7b.
- `client-service`, `client-remaining-actions` — dieselbe tote Navigation. Die Abläufe stehen in `r5a`, `r5c-*`, `r5d`, `r5d1`, `r5f`, `r4c3`, die Rennen, verlorenen Antworten und alten Stände auf Befehlsebene in `service-documents` (letztes Stück), `return-chain`, `lifecycle-actions` und `financial-actions` im Node-Gesamttest.

Behoben (v0.8.97):
- `r7b-review-runtime` leitet die Monate vom Lauftag ab. Die Anmeldemaske nach dem Uhrsprung war kein hartes Beenden, sondern die richtig abgelaufene 30-Tage-Sitzung; der Lauf meldet sich dort regulär neu an.
- Die vierzehn `mobile-*`/`media-*`-Läufe schließen ihren Test-Edge über seine Debug-Verbindung (`closeEdgeOnPort`, `_e2e-browser.mjs`) auf einem eigenen Port je Lauf (`edgeDebugPort`) statt fest 9224.
- `assertE2eClientBinary` weist einen Client ab, der nicht vom selben Bau wie der Primary daneben stammt (eingebettete Frontend-Dateien).

## Testtreiber und Schutz der Produktion

**Beenden von Prozessen.** Der Helfer `test/e2e/_e2e-process.mjs` beendet nur eine geprüfte PID am exakten Test-Pfad. Er nutzt nie `taskkill /T`. Windows behält die Eltern-PID eines Prozesses, auch wenn der Elternprozess längst beendet und die Nummer neu vergeben ist. `/T` träfe dann einen fremden Prozess, etwa die Produktions-App, die ein inzwischen beendeter Installer gestartet hat. Kinder werden nur über `trueDescendants` mitbeendet: gleiche Eltern-PID **und** nicht vor dem Elternprozess gestartet. `closeTestWindow` schickt `CloseMainWindow` nur an eine PID, die gerade am exakten Test-Pfad läuft. Anlass: Am 04.11.2026 verschwand die Produktions-App während eines E2E-Laufs. Dieser Lauf war das einzige laufende Programm, das Prozesse beendete, und hat das Verschwinden selbst gemessen; der genaue Weg ist nicht bewiesen.

**Datenort einer Test-App.** Eine Test-App darf nur aus ihrem eigenen Testordner oder dem Temp-Verzeichnis lesen. Aus einer Produktionssicherung kommt nur `lataif.db` (bei Bedarf Server-DB und Medien) in einen Testordner, nie der Inhalt von `_schluessel/`. Dort liegt `data-location.json` mit `E:\LATAIF\Data`.
- `e2ePreflight` bricht bei einem Zeiger außerhalb von Testordner und Temp ab (`assertIsolatedLocator`).
- Die Test-App prüft im Automations-Build ihren aufgelösten Datenort vor dem ersten Zugriff selbst und beendet sonst den Start (`e2e_assert_isolated_data_root`, `src-tauri/src/lib.rs`).
- Prüfskripte lesen `E:\LATAIF\Data` nicht, auch nicht zum Hashen.
- Anlass: Am 07.11.2026 migrierte eine Startprobe mit kopiertem Zeiger die Produktionsdatenbank (`docs/ai/mixed-invoice-release-plan.md` §8a).

**Reihen von E2E-Läufen** laufen über `node scripts/e2e-diag-runner.mjs <ordner> <tests…>`. Der Runner liefert je Lauf den vollen Exit-Code, die Reste davor und danach und einen Produktionswächter: Verschwindet eine fremde lataif.exe, bricht die Reihe ab. `test/e2e-safety/process-isolation.test.ts` startet eine Köder-lataif.exe und läuft deshalb nie parallel zu einem E2E-Lauf.

**Absturz des Testtreibers (`0xC0000409`).** node.exe bricht dabei ohne Ausgabe, ohne Node-Bericht und ohne Windows-Ereignis ab. Bisher war das in 3 von etwa 95 Läufen so, immer beim Anbinden an die gerade startende App. Die Ursache ist offen; ERP-Code im Prozess, CET/Shadow-Stack und `fetch` gegen einen flatternden Port sind ausgeschlossen. Ein solcher Lauf zählt nur dann als Infrastruktur und nicht als rot, wenn **alle** Punkte gelten:
1. Exit-Code `0xC0000409`, vom Runner als `TREIBER_ABSTURZ` gekennzeichnet.
2. Das Protokoll enthält bis dahin keinen eigenen Fehlschlag (`x …`).
3. Die Reste sind abgeräumt, und kein Produktionsprozess ist verschwunden.
4. Die sofortige Wiederholung desselben Laufs ist grün.

Tritt derselbe Absturz zweimal in Folge im selben Lauf auf oder in mehr als 1 von 10 Läufen einer Reihe, ist das ein Blocker und wird untersucht. Ein Speicherabbild ist dann nur mit Owner-Freigabe zu erstellen, denn das ist eine Systemeinstellung.

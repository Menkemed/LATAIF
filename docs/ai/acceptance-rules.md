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

- `c5-operational-acceptance`, `client-commercial`, `client-financial`, `client-invoice-lifecycle`, `client-invoice-ui`, `client-masterdata-ui`, `client-transfer-lifecycle`: nutzen die Navigation `data-client-area` des alten Client-Bereichs, den `71d1fc4` entfernt hat, und stoppen im Aufbau. Die Abläufe fahren heute die Zwei-App-Läufe `r3`–`r6*` über die gemeinsame Oberfläche; ob jede Prüfung dort steht (bei C5 auch Neustart und Ausfall), ist je Datei noch zu belegen, bevor sie entfernt oder umgeschrieben wird.

Entfernt (v0.8.97): `client-service`, `client-remaining-actions` — dieselbe tote Navigation. Die Abläufe stehen in `r5a`, `r5c-*`, `r5d`, `r5d1`, `r5f`, `r4c3`, die Rennen, verlorenen Antworten und alten Stände auf Befehlsebene in `service-documents` (letztes Stück), `return-chain`, `lifecycle-actions` und `financial-actions` im Node-Gesamttest.

Behoben (v0.8.97):
- `r7b-review-runtime` leitet die Monate vom Lauftag ab. Die Anmeldemaske nach dem Uhrsprung war kein hartes Beenden, sondern die richtig abgelaufene 30-Tage-Sitzung; der Lauf meldet sich dort regulär neu an.
- Die vierzehn `mobile-*`/`media-*`-Läufe schließen ihren Test-Edge über seine Debug-Verbindung (`closeEdgeOnPort`, `_e2e-browser.mjs`) auf einem eigenen Port je Lauf (`edgeDebugPort`) statt fest 9224.
- `assertE2eClientBinary` weist einen Client ab, der nicht vom selben Bau wie der Primary daneben stammt (eingebettete Frontend-Dateien).

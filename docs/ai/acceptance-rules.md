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

- `client-service`, `client-remaining-actions`: nutzen die Navigation `data-client-area`, die seit `71d1fc4` fehlt, und stoppen im Aufbau. Abgedeckt durch `r5a`, `r5c-*`, `r5d`, `r5f`, `r4c3` und die Befehls-Tests im Node-Gesamttest.
- `r7b-review-runtime`: fest auf September 2026 eingestellt (Daueraufträge), außerdem endet er nach hartem Beenden an der Anmeldemaske. Fachlich nicht von Repair oder Preisen berührt.

Vierzehn Läufe (`mobile-*`, `media-*`) lassen ihren Test-Browser auf Port 9224 stehen. Danach meldet jeder PC2-Lauf „no CDP page on 9224“. Das ist kein Produktfehler; nur Prozesse mit Testprofil beenden.

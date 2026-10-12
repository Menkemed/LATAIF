# Schutz gegen Doppelstart

Stand: nach v0.8.80, Vorfall vom 12.10.2026 (zwei LATAIF-Prozesse auf derselben `lataif.db`).

## Zwei Stufen

1. **tauri-plugin-single-instance** (seit `0e5e852`): Ein zweiter Start holt das offene Fenster nach vorn und beendet sich. Lücke: Findet die zweite Kopie das Nachrichtenfenster der ersten nicht (Start- oder Beendephase), läuft sie weiter.
2. **Instanz-Sperre** (`src-tauri/src/instance_lock.rs`): Eine Datei `%LOCALAPPDATA%\com.lataif.app\.lataif-instance.lock`, die der laufende Prozess exklusiv offen hält.
   - Wird im `setup` als Erstes genommen, vor Datenort, Datenbank, Server und Handy-Verarbeitung.
   - Bleibt bis zum Ende des Prozesses gehalten (Tauri-Zustand). Windows gibt sie beim Prozessende frei, auch nach einem Absturz. Eine liegengebliebene Datei sperrt nichts.

## Verhalten beim Start

| Lage | Verhalten |
|---|---|
| Sperre frei | Start wie bisher |
| Ein anderer Prozess hält die Sperre | Bis zu 10 s warten (Neustart nach Update), dann Meldung „already running" und Ende, ohne etwas zu öffnen |
| Sperre technisch nicht einrichtbar (Ordner, Rechte, Datenträger) | Fail-closed: Sicherheitsmeldung und Ende. Kein Start ohne Sperre |

## Umfang

- **Geschützt:** mehrere LATAIF-Prozesse **desselben Windows-Benutzers**.
- **Nicht geschützt:** zwei **verschiedene Windows-Benutzer**, die denselben Datenordner öffnen (z. B. `E:\LATAIF\Data`). Jeder hat ein eigenes lokales AppData und damit eine eigene Sperre.

Die Instanz-Sperre ist also keine Sperre des Datenordners und darf nicht als solche gelten. Eine benutzerübergreifende Sperre am Datenordner ist ein eigener, späterer Schritt.

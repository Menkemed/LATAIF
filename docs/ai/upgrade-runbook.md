# Upgrade-Ablauf Primary → PC2

Gilt für jede Installation mit neuer Datenbankspalte oder neuen Befehlsfeldern. Produktions-Apps schließt nur der Owner.

## Warum die Reihenfolge zählt

Es gibt keine Versionsprüfung zwischen PC2 und Primary. Die Aktualisierung startet nur auf Klick im Update-Banner, das Banner erscheint aber auf beiden Rechnern, sobald ein Release „Latest“ ist. Auf PC2 darf deshalb nicht zuerst geklickt werden.

| Mischbetrieb | Folge |
|---|---|
| Neuer PC2, alter Primary | Befehle mit neuen Feldern werden abgewiesen (`unknown field`). |
| Alter PC2, neuer Primary | Neue Werte können dort scheitern, zum Beispiel Speichern einer Reparatur mit `repair_type = unset`. |

## Ablauf

1. **Ruhe herstellen:** Am Handy keine Eingaben. An PC2 ist die Leiste „Unresolved saves“ leer; offene Einträge zuerst klären. Dann PC2 schließen, danach den Primary. Das Update-Banner auf PC2 nicht anklicken.
2. **Ruhe prüfen:** `lataif.db` und `lataif_sync_server.db` sind über mindestens eine Minute hash-gleich, und kein LATAIF-Prozess läuft mehr. In einer Kopie gibt es in `remote_command_ledger` nur `completed` und `rejected`, und `sync_change_quarantine` ist leer. Alte Quarantäne-Einträge in `mobile_upload_inbox` bleiben, wie sie sind; neue Einträge seit der letzten Prüfung vorher ansehen.
3. **Sicherung bei geschlossenen Apps:** Vollständig auf E: und F:, mit beiden Datenbanken, allen Dateien im Medienordner (auch nicht verknüpften), den Ablagen und den Schlüsseln. Manifest von beiden Platten neu gelesen und ohne Abweichung; die Zahl der Mediendateien gleich dem Live-Ordner.
4. **Primary installieren** und starten. Prüfen: Version, neue Spalte da und leer, Vergleich mit der Sicherung sauber, Server antwortet.
5. **PC2 installieren,** direkt danach. Anmelden, eine Reparatur und einen Artikel öffnen, einen Preis speichern, „Unresolved saves“ bleibt leer.
6. **Echtes Handy:** Filter, Karten, Summen, eine Arbeitszeile, eine Preisänderung.

## Wenn etwas schiefgeht

Vor Schritt 5: PC2 geschlossen lassen und vom Primary aus prüfen, ob die Sicherung zurückgespielt werden muss (`WIEDERHERSTELLUNG.md` im Sicherungsordner). Eine Schema-Änderung lässt sich nicht durch eine ältere App-Version allein rückgängig machen.

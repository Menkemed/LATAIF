// DATA-ROOT-B1a — was ein Start OHNE Datenwurzel ueber die Fernbedienung erreichen kann.
//
// Die Weiche schuetzt den Bildschirm. Sie schuetzt nicht die Kommandos: die Fernbedienung ist eine
// eigene Oberflaeche, und wer sie direkt anspricht, sieht keinen Knopf. Also wird hier die
// vollstaendige Kommandoliste des ausgelieferten Programms gelesen und jedes einzelne Kommando
// einer Klasse zugeordnet.
//
// Der Schutz ist strukturell: fast jedes Kommando verlangt `State<'_, AppHandleState>`, und den
// gibt es im wurzellosen Zustand nicht — Tauri kann den Aufruf gar nicht erst aufloesen. Was
// uebrig bleibt, steht namentlich in den Listen unten, und jede Zeile darin ist eine Zusage. Kommt
// ein Kommando hinzu, das keiner Klasse angehoert, faellt dieser Test um: dann muss jemand
// entscheiden, ob es im leeren Zustand etwas anfassen darf.

use std::collections::BTreeSet;

const SRC: &str = include_str!("lib.rs");

/// Die tatsaechlich registrierten Kommandos — aus `generate_handler!`, nicht aus einer Doku.
fn registered_commands() -> Vec<String> {
    let block = &SRC[SRC.find("invoke_handler(tauri::generate_handler![").expect("handler list")..];
    let list = &block[..block.find("\n        ])").expect("handler list end")];
    let mut out = BTreeSet::new();
    for line in list.lines() {
        let t = line.trim();
        if t.starts_with("//") || !t.ends_with(',') {
            continue;
        }
        let name = t.trim_end_matches(',');
        if !name.is_empty()
            && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            out.insert(name.to_string());
        }
    }
    out.into_iter().collect()
}

/// Die Parameterliste einer Funktion, geklammert gezaehlt statt geraten.
fn params_of(name: &str) -> Option<String> {
    let needle = format!("fn {name}(");
    let at = SRC.find(&needle)?;
    let start = at + needle.len();
    let mut depth = 1usize;
    let bytes = SRC.as_bytes();
    let mut i = start;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    Some(SRC[start..i - 1].split_whitespace().collect::<Vec<_>>().join(" "))
}

/// Kommandos, die im wurzellosen Zustand absichtlich erreichbar sind — und dort nichts anfassen.
const FIRST_RUN_SAFE: &[&str] = &[
    // Die Weiche selbst.
    "first_run_pending",
    "first_run_setup_new",
    "first_run_validate_candidate",
    "first_run_adopt",
    // Reine Auskunft ueber das Kontrollverzeichnis; schreibt nichts.
    "pending_data_root_move",
    // Beruehren keine Daten dieser Installation: ein Netzwerksuchlauf und ein Etikettendruck.
    "discover_lan_servers",
    "print_raw_zpl",

    // Findet sein Verzeichnis selbst und traegt deshalb seinen eigenen Erstlauf-Riegel.
    "clear_pending_data_root_move",

    // CENTRAL-C1 — die zwei Antwortwege der Kommandobruecke. Sie nehmen absichtlich KEINEN
    // `AppHandleState`: sie sprechen nur mit der prozessweiten Bruecke im Speicher.
    //
    // `bridge_announce_ready` sagt, welche Generation dieses Fenster hat; `bridge_reply` liefert
    // die Antwort auf einen Auftrag, der schon in der Warteschlange steht. Beide oeffnen keine
    // Datenbank, kein Verzeichnis und keine Datei — und ohne installierte Bruecke antworten sie
    // mit `BRIDGE_NOT_INSTALLED`. Im wurzellosen Zustand gibt es keine Bruecke, also auch nichts
    // zu beantworten.
    "bridge_announce_ready",
    "bridge_reply",

    // POST-PARITY R7C N1 — der Abschluss nach dem durablen Flush. Er beendet nur den Prozess: die
    // Bruecke nimmt nichts mehr an (falls es sie gibt), der Server des `AppHandleState` wird
    // gestoppt (falls es den Zustand gibt), dann `exit(0)`. Keine Datenbank, kein Verzeichnis,
    // keine Datei. Ohne Wurzel (PC2, Erstlauf-Weiche) gibt es weder Bruecke noch Server — dort
    // endet nur der Prozess. Vorher verlangte er den Zustand und PC2 liess sich nicht schliessen.
    "finalize_application_shutdown",

    // POST-PARITY R7B PP-12 / N2 — Belegbild umrechnen: Base64 hinein (Groesse VOR dem Dekodieren
    // begrenzt), `normalize_record_image` im Speicher (JPEG ≤ 100 000 B, ≤ 1600 px, Metadaten weg),
    // Base64 + Masse heraus. Kein Zustand, keine Datei, keine DB, kein Medienspeicher — reine Bildbytes,
    // keine Geschaeftsdaten. ABSICHTLICH ohne Wurzel erreichbar: PC2 (Client-Modus, Erstlauf-Zweig)
    // rechnet damit vor dem Ablegen am Primary (`stageRecordDataUrls` → `normalizeRecordImages`).
    // Wurzelgebunden gemacht, koennte PC2 kein Belegbild mehr senden. Gepinnt unten.
    "media_normalize_record_image",
];

#[test]
fn every_command_is_either_root_bound_or_named_as_first_run_safe() {
    let cmds = registered_commands();
    assert!(cmds.len() > 50, "the command list was not parsed ({} found)", cmds.len());

    let mut unclassified = Vec::new();
    for c in &cmds {
        let p = params_of(c).unwrap_or_else(|| panic!("no signature found for command {c}"));
        let root_bound = p.contains("State<'_, AppHandleState>");
        let uses_data_root_of = {
            // Ein Kommando, das seinen Ordner ueber `data_root_of` holt, ist ebenso gebunden: ohne
            // den Zustand gibt es dort einen Fehler statt eines Pfades.
            let needle = format!("fn {c}(");
            let at = SRC.find(&needle).unwrap();
            let body = &SRC[at..];
            let end = body.find("\n}").map(|e| e + 2).unwrap_or(body.len());
            body[..end].contains("data_root_of(")
        };
        if root_bound || uses_data_root_of || FIRST_RUN_SAFE.contains(&c.as_str()) {
            continue;
        }
        unclassified.push(c.clone());
    }
    assert!(
        unclassified.is_empty(),
        "these commands are reachable without a data root and are not declared first-run safe: {unclassified:?}"
    );
}

#[test]
fn the_one_unbound_mutating_command_refuses_while_the_question_is_open() {
    // `clear_pending_data_root_move` loescht eine Datei im Kontrollverzeichnis und holt sich das
    // Verzeichnis selbst — es ist das einzige schreibende Kommando ohne Wurzelbindung. Also muss
    // der Riegel in ihm stehen.
    let needle = "fn clear_pending_data_root_move(";
    let at = SRC.find(needle).expect("command exists");
    let body = &SRC[at..];
    let end = body.find("\n}").expect("body end") + 2;
    let body = &body[..end];
    let guard = body.find("try_state::<FirstRunState>()").expect("first-run guard present");
    let mutation = body.find("clear_intent(").expect("the mutation it guards");
    assert!(guard < mutation, "the guard must come before the deletion");
    assert!(body.contains("DATA_ROOT_FIRST_RUN_UNDECIDED"), "and it must say why it refused");
}

#[test]
fn closing_works_without_a_data_root_and_without_a_stand_in_state() {
    // N1: als Parameter `State<'_, AppHandleState>` konnte Tauri den Abschluss in einem Start ohne
    // Wurzel gar nicht aufloesen („state not managed for field `state`") — PC2 blieb offen.
    let p = params_of("finalize_application_shutdown").expect("command exists");
    assert!(!p.contains("State<"), "the finalizer must not demand any managed state: {p}");

    let at = SRC.find("fn finalize_application_shutdown(").unwrap();
    let body = &SRC[at..];
    let body = &body[..body.find("\n}").unwrap()];
    // Der Server kommt aus dem Zustand, WENN es ihn gibt — und wird nur dann gestoppt, VOR dem Exit.
    let lookup = body.find("try_state::<AppHandleState>()").expect("server looked up optionally");
    let stop = body.find("server.stop()").expect("the server of a rooted start is still stopped");
    let exit = body.find(".exit(0)").expect("the process still ends natively");
    assert!(lookup < stop && stop < exit, "look up, then stop, then exit");
    assert!(body.contains("if let Some(server) = server"), "no server → nothing to stop");
    // Nichts wird erfunden oder angefasst: kein Ersatzzustand, kein Serverstart, keine Datei, keine DB.
    for forbidden in ["manage(", "SyncServer::new", ".start(", "std::fs::", "open_config_db", "data_root_of("] {
        assert!(!body.contains(forbidden), "the finalizer must not use {forbidden}");
    }
    // Der Zustand wird weiterhin an genau einer Stelle verwaltet — im Start mit Datenwurzel.
    assert_eq!(SRC.matches("manage(AppHandleState").count(), 1, "AppHandleState managed in exactly one place");
}

#[test]
fn the_record_image_normalizer_stays_pure_bytes_in_bytes_out() {
    // N2: die Einordnung oben gilt nur, solange der Befehl nichts anfasst. Faengt er an zu speichern
    // oder einen Zustand zu brauchen, faellt dieser Test um — dann gehoert er an die Wurzel.
    let p = params_of("media_normalize_record_image").expect("command exists");
    assert_eq!(p, "data_base64: String", "only the image bytes come in: {p}");

    let at = SRC.find("fn media_normalize_record_image(").unwrap();
    let body = &SRC[at..];
    let body = &body[..body.find("\n}").unwrap()];
    let cap = body.find("MAX_UPLOAD_IMAGE_BYTES").expect("size capped");
    let decode = body.find(".decode(").expect("decoded");
    assert!(cap < decode, "the size cap comes before decoding");
    assert!(body.contains("record_image::record_image_json(&bytes)"), "the one normalizer, in memory");
    for forbidden in ["State<", "try_state", "data_root_of(", "std::fs::", "open_config_db", "media_root", "staging"] {
        assert!(!body.contains(forbidden), "the command must not use {forbidden}");
    }
    // Der Normalisierer selbst: keine Datei, kein Pfad, keine Datenbank.
    for (name, src) in [
        ("media/record_image.rs", include_str!("media/record_image.rs")),
        ("media/normalize.rs", include_str!("media/normalize.rs")),
    ] {
        for forbidden in ["std::fs", "File::", "OpenOptions", "rusqlite", "PathBuf", "Path::"] {
            assert!(!src.contains(forbidden), "{name} must stay pure (found {forbidden})");
        }
    }
}

#[test]
fn setting_up_a_new_installation_is_reachable_only_in_the_rootless_state() {
    // Der Backend-Riegel ist strukturell: das Kommando verlangt `FirstRunState`, und den verwaltet
    // der Start NUR im wurzellosen Zweig. In einer eingerichteten Installation kann Tauri den
    // Aufruf nicht aufloesen — es gibt keinen Weg an dieser Bedingung vorbei, auch nicht per
    // direktem IPC.
    let p = params_of("first_run_setup_new").expect("command exists");
    assert!(p.contains("State<'_, FirstRunState>"), "must be bound to the first-run state: {p}");

    // Und dieser Zustand wird an genau einer Stelle verwaltet: im Erstlauf-Zweig des Starts.
    let managed: Vec<_> = SRC.match_indices("manage(FirstRunState").collect();
    assert_eq!(managed.len(), 1, "FirstRunState must be managed in exactly one place");
    let before = &SRC[..managed[0].0];
    assert!(
        before.contains("Resolution::FirstRunUndecided"),
        "and only after the resolver said the question is open"
    );

    // Einfachausfuehrung: der Wachposten steht im Kern, nicht in der Oberflaeche.
    let at = SRC.find("fn first_run_setup_new(").unwrap();
    let body = &SRC[at..];
    let body = &body[..body.find("\n}").unwrap()];
    let swap = body.find("busy.swap(true").expect("single-flight guard");
    let call = body.find("setup_new_installation(").expect("the bootstrap it guards");
    assert!(swap < call, "the guard must be taken before the bootstrap runs");
}

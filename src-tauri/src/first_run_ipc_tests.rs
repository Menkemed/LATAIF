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

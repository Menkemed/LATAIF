// DATA-ROOT-B1a — der Erstlauf-Vorbereiter fuer die Testumgebung.
//
// Seit der Erstlauf-Weiche legt ein leeres Kontrollverzeichnis nichts mehr von selbst an: die App
// fragt. Fuer die 23 bestehenden E2E-Suiten ist diese Frage aber nicht das Thema — sie loeschen ihr
// isoliertes AppData vor jedem Lauf und erwarten danach eine eingerichtete Installation.
//
// Dieses Werkzeug richtet sie ein — mit GENAU der Primitive, die auch der Knopf in der Oberflaeche
// aufruft (`data_root::setup_new_installation`). Kein nachgebauter Bootstrap, kein von Hand
// geschriebener Locator, kein zusammengebastelter Marker, keine Umgebungsvariable und kein Schalter
// am ausgelieferten Programm: das hier ist ein `examples/`-Binary hinter dem `e2e`-Feature und
// landet in keinem Installer.
//
// Aufruf: `e2e_first_run_preseed <control-dir>`

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .expect("usage: e2e_first_run_preseed <control-dir>");

    match lataif_lib::e2e_support::setup_new_installation(&dir) {
        Ok(root) => {
            // Die Kennung wird ausgegeben, damit der Harness sie mit dem spaeteren Zustand der App
            // vergleichen kann.
            println!("{}", root.root_id());
        }
        Err(e) => {
            eprintln!("preseed failed: {}", e.code());
            std::process::exit(1);
        }
    }
}

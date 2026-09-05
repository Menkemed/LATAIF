// CENTRAL-C1 — die Brücke an ihren vier Lebenszyklusfällen geprüft, nicht nur am guten Tag.
//
// Der gute Tag ist der einfache Teil. Interessant sind die Fälle, in denen niemand mehr antworten
// KANN: der Renderer ist noch nicht bereit, er wurde neu geladen, das Programm wird beendet, oder
// er schweigt. Jeder davon muss eine eigene, sofortige Begründung liefern — eine Zeitgrenze für
// alles wäre dieselbe Auskunft dreißig Sekunden später und ohne Hinweis, was zu tun ist.
//
// Gefahren wird das ECHTE Register (`Bridge`); nur die Zustellung ans Fenster ist gestellt, weil es
// im Test kein Fenster gibt. Der Ersatz zählt mit und kann bewusst schweigen oder scheitern.

use super::bridge::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Ein Fenster, das es nicht gibt: merkt sich die Aufträge und antwortet nur, wenn man es sagt.
struct TestSink {
    seen: Mutex<Vec<Envelope>>,
    delivered: AtomicUsize,
    fail_delivery: AtomicBool,
}

impl TestSink {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            delivered: AtomicUsize::new(0),
            fail_delivery: AtomicBool::new(false),
        })
    }
    fn last(&self) -> Option<Envelope> {
        self.seen.lock().unwrap().last().cloned()
    }
    fn count(&self) -> usize {
        self.delivered.load(Ordering::SeqCst)
    }
}

/// `Bridge` nimmt eine Box; der Test will danach noch mitlesen, also teilen sich beide ein `Arc`.
struct SharedSink(Arc<TestSink>);

impl CommandSink for SharedSink {
    fn deliver(&self, envelope: &Envelope) -> Result<(), String> {
        if self.0.fail_delivery.load(Ordering::SeqCst) {
            return Err("no window".into());
        }
        self.0.seen.lock().unwrap().push(envelope.clone());
        self.0.delivered.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

fn bridge_with_sink() -> (Bridge, Arc<TestSink>) {
    let sink = TestSink::new();
    (Bridge::new(Box::new(SharedSink(sink.clone()))), sink)
}

const SHORT: Duration = Duration::from_millis(250);
/// Fuer Fuellauftraege, die nur einen Eintrag erzeugen sollen: so kurz wie moeglich.
const TINY: Duration = Duration::from_millis(1);

// ── 1) Der gute Tag ────────────────────────────────────────────────────────
#[tokio::test]
async fn a_reply_from_the_renderer_becomes_the_answer() {
    let (bridge, sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    let gen = bridge.announce_generation();
    assert_eq!(gen, 1, "die erste Anmeldung ist Generation 1");

    let b = bridge.clone();
    let s = sink.clone();
    let responder = tokio::spawn(async move {
        // Warten, bis der Auftrag wirklich zugestellt ist — kein Schlafen als Ersatz für eine
        // Bedingung: es wird auf den Eintrag geprüft.
        for _ in 0..200 {
            if let Some(env) = s.last() {
                return b.reply(
                    &env.op_id,
                    env.generation,
                    Reply::Ok { value: serde_json::json!({ "echo": 42 }) },
                );
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("der Auftrag wurde nie zugestellt");
    });

    let got = bridge
        .submit_with_timeout(OP_PROBE, serde_json::json!({ "echo": 42 }), Duration::from_secs(5))
        .await
        .expect("die Brücke muss antworten");
    responder.await.unwrap().unwrap();

    match got {
        Reply::Ok { value } => assert_eq!(value["echo"], 42, "das Ergebnis kommt unverändert an"),
        other => panic!("unerwartete Antwort: {other:?}"),
    }
    assert_eq!(sink.count(), 1, "genau einmal zugestellt");
    assert_eq!(bridge.pending_count(), 0, "und nichts bleibt im Register liegen");
}

// ── 2) Der Renderer schweigt ───────────────────────────────────────────────
#[tokio::test]
async fn silence_ends_in_a_bounded_failure_and_leaves_nothing_behind() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();

    let err = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, SHORT)
        .await
        .expect_err("Schweigen darf nicht als Erfolg gelten");
    assert_eq!(err, BridgeError::Timeout);
    assert_eq!(err.code(), "BRIDGE_TIMEOUT");
    assert_eq!(err.http_status(), 504, "der Client soll wissen, dass es zu lange dauerte");
    assert_eq!(sink.count(), 1, "gesendet wurde er trotzdem");
    assert_eq!(
        bridge.pending_count(),
        0,
        "der Eintrag ist weg — ein Register, das nur wächst, wäre ein Leck"
    );
}

// ── 3) Der Renderer ist noch nicht bereit ──────────────────────────────────
#[tokio::test]
async fn before_the_renderer_announces_itself_nothing_is_even_sent() {
    let (bridge, sink) = bridge_with_sink();
    // KEINE Anmeldung.
    let err = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, SHORT)
        .await
        .expect_err("ohne Geschäftsmaschine gibt es keine Ausführung");
    assert_eq!(err, BridgeError::NotReady);
    assert_eq!(err.code(), "BRIDGE_RENDERER_NOT_READY");
    assert_eq!(err.http_status(), 503, "später nochmal, nicht 'zu lange gedauert'");
    assert_eq!(
        sink.count(),
        0,
        "und es wurde GAR NICHT gesendet — kein Ereignis ins Leere"
    );
}

// ── 4) F5: der Renderer wird neu geladen ───────────────────────────────────
#[tokio::test]
async fn a_reload_ends_the_open_requests_of_the_old_renderer() {
    let (bridge, sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    let first = bridge.announce_generation();

    let b = bridge.clone();
    let pending = tokio::spawn(async move {
        b.submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(30))
            .await
    });
    for _ in 0..200 {
        if bridge.pending_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    assert_eq!(bridge.pending_count(), 1, "der Auftrag wartet");

    // Neuladen: neue Generation.
    let second = bridge.announce_generation();
    assert_eq!(second, first + 1, "jedes Renderer-Leben hat seine eigene Nummer");

    let err = pending.await.unwrap().expect_err("er darf nicht weiterleben");
    assert_eq!(err, BridgeError::Reloaded, "und zwar SOFORT, nicht erst in der Zeitgrenze");
    assert_eq!(err.code(), "BRIDGE_RENDERER_RELOADED");

    // Und eine Antwort aus dem alten Leben wird nicht mehr angenommen.
    let old = sink.last().expect("zugestellt war er");
    let late = bridge.reply(&old.op_id, first, Reply::Ok { value: serde_json::json!({}) });
    assert_eq!(
        late.unwrap_err(),
        BridgeError::Reloaded,
        "eine Antwort des alten Fensters gehört zu einem Auftrag, den es nicht mehr gibt"
    );
}

#[tokio::test]
async fn after_a_reload_the_new_renderer_works_normally() {
    let (bridge, sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    bridge.announce_generation();
    let gen2 = bridge.announce_generation();

    let b = bridge.clone();
    let s = sink.clone();
    tokio::spawn(async move {
        for _ in 0..200 {
            if let Some(env) = s.last() {
                let _ = b.reply(&env.op_id, env.generation, Reply::Ok { value: serde_json::json!({ "n": 1 }) });
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    });
    let got = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(5))
        .await
        .expect("das neue Fenster antwortet");
    assert!(matches!(got, Reply::Ok { .. }));
    assert_eq!(sink.last().unwrap().generation, gen2, "unter der neuen Nummer");
}

// ── 5) Das Programm wird beendet ───────────────────────────────────────────
#[tokio::test]
async fn shutting_down_resolves_the_waiting_and_refuses_the_new() {
    let (bridge, sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    bridge.announce_generation();

    let b = bridge.clone();
    let pending = tokio::spawn(async move {
        b.submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(30))
            .await
    });
    for _ in 0..200 {
        if bridge.pending_count() == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    bridge.stop_accepting();

    let err = pending.await.unwrap().expect_err("wer wartet, bekommt eine Begründung");
    assert_eq!(err, BridgeError::Reloaded, "das Fenster, das ihn ausführen sollte, geht");
    assert_eq!(bridge.pending_count(), 0);

    let after = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, SHORT)
        .await
        .expect_err("danach wird nichts mehr angenommen");
    assert_eq!(after, BridgeError::ShuttingDown);
    assert_eq!(after.code(), "BRIDGE_SHUTTING_DOWN");
    assert_eq!(sink.count(), 1, "der zweite wurde nicht mehr gesendet");
}

// ── 6) Was nicht auf der Liste steht, erreicht den Renderer nie ────────────
#[tokio::test]
async fn a_name_that_is_not_allow_listed_never_reaches_the_renderer() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();

    for name in ["invoiceStore.createInvoice", "SELECT * FROM products", "", "bridge.Probe"] {
        let err = bridge
            .submit_with_timeout(name, serde_json::Value::Null, SHORT)
            .await
            .expect_err("nur die Liste zählt");
        assert_eq!(err, BridgeError::OpNotAllowed, "abgelehnt: {name}");
        assert_eq!(err.http_status(), 400, "das ist ein Fehler des Aufrufers");
    }
    assert_eq!(sink.count(), 0, "und nichts davon wurde zugestellt");
    // C2 hat sechs LESEVORGAENGE dazugelegt, C3B eine veraendernde Operation, C3C zwei weitere.
    // Was zaehlt, ist nicht die Anzahl, sondern dass jeder Name darauf einzeln durchdacht ist —
    // und dass die Probe weiter dabei ist.
    assert!(REMOTE_OPS.contains(&OP_PROBE), "die Probe steht auf der Liste");
    assert_eq!(
        REMOTE_OPS.len(),
        12,
        "Probe, sechs Lesevorgaenge, eine Rechnung, zwei Kunden-, zwei Produktoperationen"
    );
    for op in [
        OP_INVOICES_CREATE,
        OP_CUSTOMERS_CREATE,
        OP_CUSTOMERS_UPDATE,
        OP_PRODUCTS_CREATE,
        OP_PRODUCTS_UPDATE,
    ] {
        assert!(REMOTE_OPS.contains(&op), "die freigegebene Buchung {op} fehlt");
    }
    let mutations: Vec<&&str> = REMOTE_OPS
        .iter()
        .filter(|op| !op.ends_with(".list") && !op.ends_with(".get") && ***op != *OP_PROBE)
        .collect();
    assert_eq!(
        mutations,
        vec![
            &OP_INVOICES_CREATE,
            &OP_CUSTOMERS_CREATE,
            &OP_CUSTOMERS_UPDATE,
            &OP_PRODUCTS_CREATE,
            &OP_PRODUCTS_UPDATE,
        ],
        "und NUR diese fuenf veraendern etwas — kein Loeschen von aussen"
    );
}

// ── 7) Zustellung scheitert ────────────────────────────────────────────────
#[tokio::test]
async fn a_failed_delivery_is_reported_at_once_not_waited_out() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();
    sink.fail_delivery.store(true, Ordering::SeqCst);

    let started = std::time::Instant::now();
    let err = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(30))
        .await
        .expect_err("ohne Zustellung gibt es keine Antwort");
    assert_eq!(err, BridgeError::DeliveryFailed);
    assert!(started.elapsed() < Duration::from_secs(5), "und zwar sofort, nicht nach 30 Sekunden");
    assert_eq!(bridge.pending_count(), 0, "der Eintrag wurde wieder entfernt");
}

// ── 8) Antworten auf Aufträge, die niemand erwartet ────────────────────────
#[tokio::test]
async fn a_reply_nobody_waits_for_changes_nothing() {
    let (bridge, _sink) = bridge_with_sink();
    let gen = bridge.announce_generation();
    // Eine erfundene Kennung: der Renderer kann keine Kennung vergeben, nur Rust.
    let r = bridge.reply("made-up-op-id", gen, Reply::Ok { value: serde_json::json!({}) });
    assert!(r.is_ok(), "still verworfen, nicht als Fehler des Systems");
    assert_eq!(bridge.pending_count(), 0);
}

// ── 9) Die drei Ausgänge bleiben unterscheidbar ────────────────────────────
#[tokio::test]
async fn business_and_infrastructure_answers_stay_apart() {
    let (bridge, sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    bridge.announce_generation();

    for expected in [
        Reply::BusinessError { code: "STOCK_UNAVAILABLE".into(), message: "nichts mehr da".into() },
        Reply::InfrastructureError { code: "BRIDGE_COMMAND_FAILED".into() },
    ] {
        let b = bridge.clone();
        let s = sink.clone();
        let want = expected.clone();
        tokio::spawn(async move {
            for _ in 0..200 {
                if let Some(env) = s.last() {
                    let _ = b.reply(&env.op_id, env.generation, want.clone());
                    return;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        });
        let got = bridge
            .submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(5))
            .await
            .expect("beide sind Antworten, keine Störungen der Brücke");
        assert_eq!(got, expected, "der Ausgang bleibt, wie der Renderer ihn nannte");
        // Für die nächste Runde: der Ersatz hält nur den letzten Auftrag, also leeren.
        sink.seen.lock().unwrap().clear();
    }
}

// ── 10) Jeder Fehler hat seinen eigenen Code und Status ────────────────────
#[test]
fn every_state_says_something_different() {
    let all = [
        BridgeError::NotReady,
        BridgeError::ShuttingDown,
        BridgeError::OpNotAllowed,
        BridgeError::Reloaded,
        BridgeError::Timeout,
        BridgeError::DeliveryFailed,
    ];
    let codes: std::collections::HashSet<&str> = all.iter().map(|e| e.code()).collect();
    assert_eq!(codes.len(), all.len(), "kein Zustand teilt seinen Namen mit einem anderen");
    assert!(all.iter().all(|e| e.code().starts_with("BRIDGE_")), "und alle sind erkennbar");
    // 400 / 503 / 504 sind drei verschiedene Handlungsanweisungen — nicht alles ist 500.
    assert_eq!(BridgeError::OpNotAllowed.http_status(), 400);
    assert_eq!(BridgeError::Timeout.http_status(), 504);
    assert_eq!(BridgeError::NotReady.http_status(), 503);
}

// ── 11) Die Verdrahtung, die man nicht laufen sehen kann ───────────────────
#[test]
fn the_wiring_is_what_it_claims_to_be() {
    let routes = include_str!("sync/routes.rs");
    assert!(
        routes.contains(".route(\"/command\", post(command_execute))"),
        "der Auftragsweg ist registriert"
    );
    // Er MUSS hinter der Anmeldung liegen: im `protected`-Block, vor dem `route_layer`.
    let cmd = routes.find(".route(\"/command\"").expect("route");
    let layer = routes.find("auth::auth_middleware").expect("auth layer");
    assert!(cmd < layer, "der Auftragsweg liegt im geschuetzten Block");
    // Kein allgemeines Ausfuehren, kein SQL-Feld.
    assert!(!routes.contains("fn sql_execute"), "es gibt keinen SQL-Endpunkt");
    assert!(
        routes.contains("crate::bridge::REMOTE_OPS.contains"),
        "die Route prueft die Zulassungsliste selbst"
    );
    assert!(
        routes.contains("\"userId\": claims.sub"),
        "wer fragt, kommt aus dem geprueften Token, nicht aus dem Rumpf"
    );

    let lib = include_str!("lib.rs");
    assert!(lib.contains("bridge_announce_ready,") && lib.contains("bridge_reply,"), "beide Kommandos registriert");
    // Die Bruecke darf NICHT in einem Start ohne Datenwurzel stehen: sie wird nach dem
    // Erstlauf-Zweig installiert, der vorher zurueckkehrt.
    let first_run = lib.find("Ok(data_root::Resolution::FirstRunUndecided)").expect("first run branch");
    let install = lib.find("bridge::install(").expect("install");
    assert!(first_run < install, "ein Start ohne Datenwurzel bekommt keine Kommandobruecke");
    // Beim Herunterfahren zuerst die Bruecke schliessen, dann den Server stoppen.
    let stop_bridge = lib.find("b.stop_accepting()").expect("stop_accepting");
    let stop_server = lib.find("let _ = server.stop().await;").expect("server stop");
    assert!(stop_bridge < stop_server, "erst keine neuen Auftraege, dann den Server");

    // Der Ereignisname muss auf beiden Seiten derselbe sein.
    let listener = include_str!("../../src/core/bridge/bridge-listener.ts");
    assert!(
        listener.contains(&format!("'{}'", EVENT_COMMAND)),
        "Renderer und Rust nennen dasselbe Ereignis"
    );
    let registry = include_str!("../../src/core/bridge/command-registry.ts");
    assert!(
        registry.contains(&format!("export const OP_PROBE = '{}'", OP_PROBE)),
        "und dieselbe Operation"
    );
}

// ── 12) Ein verlorener Antwortweg ist kein „nicht passiert" ───────────────
//
// Die gefährlichste Fehlannahme dieser Schicht. Der Auftrag WAR beim Renderer; der kann ihn
// vollständig ausgeführt und gespeichert haben, und nur die Antwort ging verloren. Wer daraufhin
// wiederholt, bucht zweimal. Deshalb sagt jeder Fehler jetzt zusätzlich, was er über die
// AUSFÜHRUNG weiß — und die Grenze liegt exakt bei der Zustellung.
#[tokio::test]
async fn a_lost_reply_is_unknown_not_failed() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();

    let err = bridge
        .submit_with_timeout(OP_PROBE, serde_json::Value::Null, SHORT)
        .await
        .expect_err("keine Antwort");
    assert_eq!(err, BridgeError::Timeout);
    assert_eq!(sink.count(), 1, "er war unterwegs");
    assert_eq!(
        err.outcome(),
        Outcome::Unknown,
        "also ist offen, ob er lief — NICHT 'ist nicht passiert'"
    );
    assert_eq!(err.outcome().as_str(), "unknown");
}

#[tokio::test]
async fn everything_that_never_left_is_safe_to_retry() {
    // Diese vier scheitern VOR dem Senden. Nur bei ihnen darf ein Client bedenkenlos wiederholen.
    for e in [
        BridgeError::NotReady,
        BridgeError::ShuttingDown,
        BridgeError::OpNotAllowed,
        BridgeError::DeliveryFailed,
    ] {
        assert_eq!(e.outcome(), Outcome::NotExecuted, "{} ist sicher", e.code());
    }
    // Diese beiden waren unterwegs.
    for e in [BridgeError::Timeout, BridgeError::Reloaded] {
        assert_eq!(e.outcome(), Outcome::Unknown, "{} ist offen", e.code());
    }
    // Und die Prüfung ist wirklich am Zustand festgemacht, nicht am Statuscode: 503 gibt es in
    // beiden Klassen.
    assert_eq!(BridgeError::ShuttingDown.http_status(), 503);
    assert_eq!(BridgeError::Reloaded.http_status(), 503);
    assert_ne!(
        BridgeError::ShuttingDown.outcome(),
        BridgeError::Reloaded.outcome(),
        "derselbe Statuscode, verschiedene Gewissheit"
    );
}

#[tokio::test]
async fn a_reload_after_dispatch_is_also_unknown() {
    let (bridge, _sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    bridge.announce_generation();
    let b = bridge.clone();
    let pending = tokio::spawn(async move {
        b.submit_with_timeout(OP_PROBE, serde_json::Value::Null, Duration::from_secs(30))
            .await
    });
    for _ in 0..200 {
        if bridge.pending_count() == 1 { break; }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    bridge.announce_generation();
    let err = pending.await.unwrap().expect_err("aufgeloest");
    assert_eq!(err.outcome(), Outcome::Unknown, "auch ein Neuladen sagt nichts ueber die Ausfuehrung");
}

// ── 13) Die logische Kennung gehört dem Client — geprüft und gebunden ─────
#[tokio::test]
async fn a_command_id_must_be_a_uuid() {
    assert!(is_valid_command_id("4f8b1a2c-9d3e-4a5b-8c7d-0e1f2a3b4c5d"));
    for bad in [
        "",
        "nope",
        "4F8B1A2C-9D3E-4A5B-8C7D-0E1F2A3B4C5D", // Grossschreibung: eine zweite Schreibweise waere eine zweite Kennung
        "4f8b1a2c9d3e4a5b8c7d0e1f2a3b4c5d",
        "../../etc/passwd",
        "'; DROP TABLE products; --",
    ] {
        assert!(!is_valid_command_id(bad), "abgelehnt: {bad}");
    }
}

fn identity(id: &str, op: &str, user: &str) -> CommandIdentity {
    CommandIdentity {
        command_id: id.to_string(),
        tenant_id: "tenant-1".into(),
        branch_id: "branch-main".into(),
        user_id: user.into(),
        op: op.to_string(),
        payload_hash: payload_fingerprint(&serde_json::Value::Null),
    }
}

#[tokio::test]
async fn the_same_id_for_something_else_is_refused() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();
    const ID: &str = "4f8b1a2c-9d3e-4a5b-8c7d-0e1f2a3b4c5d";

    // Erster Versuch: laeuft (und laeuft in die Zeitgrenze, das reicht — er wurde gesendet).
    let first = bridge
        .submit_as(&identity(ID, OP_PROBE, "user-a"), serde_json::Value::Null, SHORT)
        .await;
    assert_eq!(first.unwrap_err(), BridgeError::Timeout);
    assert_eq!(sink.count(), 1);

    // Dieselbe Kennung, derselbe Absender, dieselbe Operation: das ist eine Wiederholung.
    let retry = bridge
        .submit_as(&identity(ID, OP_PROBE, "user-a"), serde_json::Value::Null, SHORT)
        .await;
    assert_eq!(retry.unwrap_err(), BridgeError::Timeout, "eine Wiederholung ist erlaubt");
    assert_eq!(sink.count(), 2);

    // Dieselbe Kennung, ANDERER Benutzer: ein Widerspruch.
    let stolen = bridge
        .submit_as(&identity(ID, OP_PROBE, "user-b"), serde_json::Value::Null, SHORT)
        .await;
    assert_eq!(stolen.unwrap_err(), BridgeError::CommandIdConflict);
    assert_eq!(sink.count(), 2, "und er wurde GAR NICHT gesendet");
    assert_eq!(
        BridgeError::CommandIdConflict.outcome(),
        Outcome::NotExecuted,
        "ein abgewiesener Widerspruch ist sicher nicht passiert"
    );
    assert_eq!(BridgeError::CommandIdConflict.http_status(), 409);

    // Und eine kaputte Kennung erreicht ebenfalls nichts.
    let bad = bridge
        .submit_as(&identity("nope", OP_PROBE, "user-a"), serde_json::Value::Null, SHORT)
        .await;
    assert_eq!(bad.unwrap_err(), BridgeError::BadCommandId);
    assert_eq!(sink.count(), 2);
}

// ── 14) Wo der durable Nachweis fehlt, wird nichts Veraenderndes registriert ─
#[test]
fn the_route_takes_a_client_command_id_and_reports_the_outcome_class() {
    let routes = include_str!("sync/routes.rs");
    assert!(routes.contains("rename = \"commandId\""), "die logische Kennung kommt vom Client");
    assert!(routes.contains("submit_as(&identity"), "und wird gebunden, nicht bloss weitergereicht");
    assert!(
        routes.contains("command_id: req.command_id.clone()")
            && routes.contains("tenant_id: claims.tenant_id.clone()")
            && routes.contains("user_id: claims.sub.clone()"),
        "gebunden an den GEPRUEFTEN Absender, nicht an den Rumpf"
    );
    assert!(
        routes.contains("\"outcome\": e.outcome().as_str()"),
        "jede Fehlerantwort sagt, ob wiederholt werden darf"
    );

    // Und der Riegel gegen veraendernde Fernoperationen steht im Renderer-Code. Seit C3B ist er
    // eine namentliche Zulassung statt eines Schalters: ein Schalter haette in einem Zug JEDE
    // kuenftige Mutation registrierbar gemacht.
    let registry = include_str!("../../src/core/bridge/command-registry.ts");
    assert!(
        registry.contains(
            "export const ALLOWED_MUTATIONS: readonly string[] = [\n  'invoices.create',\n  'customers.create', 'customers.update',\n  'products.create', 'products.update',\n];"
        ),
        "genau diese fuenf veraendernden Namen sind freigegeben"
    );
    assert!(
        registry.contains("if (spec.kind === 'mutation' && !ALLOWED_MUTATIONS.includes(op))"),
        "erst die KLASSE, dann der NAME — ein neu benanntes invoice.save faellt an beidem"
    );
}

// ── 15) Die Kennung benennt eine Absicht, nicht nur einen Absender ────────
//
// Ohne den Rumpf wäre die Kennung ein bloßes Etikett: derselbe Name könnte zweimal etwas ANDERES
// bedeuten. Wenn später ein durabler Nachweis fragt „ist das hier schon gelaufen?", muss die
// Antwort sich auf DIESELBE Buchung beziehen — sonst gilt eine fremde Buchung als erledigt und die
// echte fällt aus. Deshalb gehört der semantische Rumpf zur Identität.
fn identity_with(id: &str, op: &str, user: &str, payload: &serde_json::Value) -> CommandIdentity {
    CommandIdentity {
        command_id: id.to_string(),
        tenant_id: "tenant-1".into(),
        branch_id: "branch-main".into(),
        user_id: user.into(),
        op: op.to_string(),
        payload_hash: payload_fingerprint(payload),
    }
}

#[tokio::test]
async fn the_same_id_with_the_same_payload_is_a_retry() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();
    const ID: &str = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    let body = serde_json::json!({ "amount": 100, "customer": "c-1" });

    let first = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &body), body.clone(), SHORT)
        .await;
    assert_eq!(first.unwrap_err(), BridgeError::Timeout, "gesendet");
    // Dieselbe Absicht, noch einmal — und bewusst mit ANDERER Feldreihenfolge geschrieben.
    let same_meaning = serde_json::json!({ "customer": "c-1", "amount": 100 });
    assert_eq!(
        payload_fingerprint(&body),
        payload_fingerprint(&same_meaning),
        "die Reihenfolge der Felder aendert die Bedeutung nicht"
    );
    let retry = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &same_meaning), same_meaning, SHORT)
        .await;
    assert_eq!(retry.unwrap_err(), BridgeError::Timeout, "eine Wiederholung ist erlaubt");
    assert_eq!(sink.count(), 2, "und wurde auch wirklich gesendet");
}

#[tokio::test]
async fn the_same_id_with_a_different_payload_is_refused_before_dispatch() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();
    const ID: &str = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
    let body = serde_json::json!({ "amount": 100, "customer": "c-1" });

    let first = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &body), body.clone(), SHORT)
        .await;
    assert_eq!(first.unwrap_err(), BridgeError::Timeout);
    assert_eq!(sink.count(), 1);

    // Ein einziger geänderter Betrag ist eine ANDERE Buchung.
    let changed = serde_json::json!({ "amount": 100_000, "customer": "c-1" });
    let err = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &changed), changed, SHORT)
        .await
        .expect_err("derselbe Name fuer etwas anderes");
    assert_eq!(err, BridgeError::CommandIdConflict);
    assert_eq!(err.http_status(), 409);
    assert_eq!(err.outcome(), Outcome::NotExecuted, "sicher nicht passiert");
    assert_eq!(sink.count(), 1, "und er wurde GAR NICHT zugestellt");
}

#[tokio::test]
async fn a_changed_identity_still_conflicts_even_with_the_same_payload() {
    let (bridge, sink) = bridge_with_sink();
    bridge.announce_generation();
    const ID: &str = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    let body = serde_json::json!({ "amount": 7 });

    assert_eq!(
        bridge
            .submit_as(&identity_with(ID, OP_PROBE, "user-a", &body), body.clone(), SHORT)
            .await
            .unwrap_err(),
        BridgeError::Timeout
    );
    // Gleicher Rumpf, anderer Benutzer — die bisherige Bindung gilt weiter.
    let err = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-b", &body), body.clone(), SHORT)
        .await
        .expect_err("fremder Absender");
    assert_eq!(err, BridgeError::CommandIdConflict);
    assert_eq!(sink.count(), 1, "nicht zugestellt");

    // Und der Fingerabdruck unterscheidet wirklich: zwei verschiedene Ruempfe, zwei Werte.
    assert_ne!(
        payload_fingerprint(&serde_json::json!({ "amount": 7 })),
        payload_fingerprint(&serde_json::json!({ "amount": 8 })),
        "ein anderer Inhalt ergibt einen anderen Fingerabdruck"
    );

    // Die Route bindet den Rumpf des CLIENTS, nicht die Huelle mit dem Absender darin.
    let routes = include_str!("sync/routes.rs");
    assert!(
        routes.contains("payload_hash: crate::bridge::payload_fingerprint(&req.payload)"),
        "gebunden wird der semantische Rumpf"
    );
}

// ── 16) Der Schutz merkt sich nur, was kürzlich war ───────────────────────
//
// Die Bindung von Kennung zu Absicht war eine Landkarte, die nur wuchs: jede neue Kennung blieb bis
// zum Prozessende liegen. In einem Programm, das monatelang läuft, ist das ein Leck. Der Zweck ist
// aber eng — eine versehentliche SOFORTIGE Wiederverwendung mit anderem Inhalt soll auffallen —
// also reicht ein begrenzter Vorrat der letzten Kennungen.
//
// Was dabei nicht passieren darf: einen Eintrag verdrängen, auf dem gerade ein Auftrag läuft.
// Seine eigene Wiederholung würde dann mitten im Lauf plötzlich als etwas Neues gelten.
#[tokio::test]
async fn the_identity_store_stays_bounded() {
    let (bridge, _sink) = bridge_with_sink();
    bridge.announce_generation();
    let body = serde_json::json!({ "n": 1 });

    // Deutlich mehr Kennungen als der Vorrat fasst — jede genau einmal.
    for i in 0..(IDENTITY_RETENTION + 200) {
        let id = format!("{:08x}-0000-4000-8000-000000000000", i);
        let _ = bridge
            .submit_as(&identity_with(&id, OP_PROBE, "user-a", &body), body.clone(), TINY)
            .await;
    }
    let kept = bridge.remembered_identities();
    assert!(
        kept <= IDENTITY_RETENTION,
        "der Vorrat bleibt begrenzt ({kept} <= {IDENTITY_RETENTION})"
    );
    assert!(kept > 0, "…und er ist nicht einfach leer");
}

#[tokio::test]
async fn a_running_command_is_never_evicted() {
    let (bridge, _sink) = bridge_with_sink();
    let bridge = Arc::new(bridge);
    bridge.announce_generation();
    const ID: &str = "aaaaaaaa-0000-4000-8000-00000000ffff";
    let body = serde_json::json!({ "amount": 1 });

    // Ein Auftrag, der lange offen bleibt.
    let b = bridge.clone();
    let held = tokio::spawn({
        let body = body.clone();
        async move {
            b.submit_as(
                &identity_with(ID, OP_PROBE, "user-a", &body),
                body,
                Duration::from_secs(30),
            )
            .await
        }
    });
    for _ in 0..200 {
        if bridge.pending_count() == 1 { break; }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    // Genug andere Kennungen, um den Vorrat mehrfach zu fuellen.
    let other = serde_json::json!({ "n": 2 });
    for i in 0..(IDENTITY_RETENTION + 50) {
        let id = format!("{:08x}-1111-4000-8000-000000000000", i);
        let _ = bridge
            .submit_as(&identity_with(&id, OP_PROBE, "user-a", &other), other.clone(), TINY)
            .await;
    }

    // Der laufende Auftrag ist noch geschuetzt: dieselbe Kennung mit ANDEREM Inhalt faellt auf.
    let changed = serde_json::json!({ "amount": 999 });
    let err = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &changed), changed, SHORT)
        .await
        .expect_err("die laufende Kennung darf nicht verdraengt worden sein");
    assert_eq!(err, BridgeError::CommandIdConflict);

    bridge.stop_accepting();
    let _ = held.await.unwrap();
}

#[tokio::test]
async fn within_the_retention_a_changed_payload_still_conflicts() {
    let (bridge, _sink) = bridge_with_sink();
    bridge.announce_generation();
    const ID: &str = "bbbbbbbb-0000-4000-8000-000000000001";
    let first = serde_json::json!({ "amount": 100 });
    let _ = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &first), first, SHORT)
        .await;

    // Ein paar andere dazwischen — weit unterhalb der Grenze, also bleibt die Bindung erhalten.
    let filler = serde_json::json!({ "n": 3 });
    for i in 0..10 {
        let id = format!("{:08x}-2222-4000-8000-000000000000", i);
        let _ = bridge
            .submit_as(&identity_with(&id, OP_PROBE, "user-a", &filler), filler.clone(), TINY)
            .await;
    }

    let changed = serde_json::json!({ "amount": 101 });
    let err = bridge
        .submit_as(&identity_with(ID, OP_PROBE, "user-a", &changed), changed, SHORT)
        .await
        .expect_err("innerhalb des Vorrats faellt das auf");
    assert_eq!(err, BridgeError::CommandIdConflict);
}

#[test]
fn the_retention_is_not_an_exactly_once_claim() {
    // Was hier steht, ist ein Schutz gegen ein Versehen — kein Geschaeftsversprechen. Faellt eine
    // alte Kennung aus dem Vorrat, wuerde Rust dieselbe Kennung mit neuem Inhalt wieder
    // durchlassen. In C1 war das folgenlos, weil nichts Veraenderndes lief. Seit C3B laeuft etwas,
    // und die Zusage haengt nicht mehr an diesem Vorrat, sondern am DURABLEN Nachweis im Renderer:
    // er ist auf die Kennung geschluesselt, traegt den Rumpf-Fingerabdruck und ueberlebt jeden
    // Neustart — eine verdraengte Kennung mit neuem Inhalt laeuft dort in einen Konflikt.
    let ledger = include_str!("../../src/core/bridge/command-ledger.ts");
    assert!(
        ledger.contains("remote_command_ledger") && ledger.contains("command_id"),
        "der durable Nachweis liegt in der Geschaeftsdatenbank und ist auf die Kennung geschluesselt"
    );
    assert!(
        ledger.contains("payload_hash"),
        "und er haelt den Fingerabdruck des Rumpfs — sonst waere die Kennung nur ein Etikett"
    );
    let bridge_src = include_str!("bridge.rs");
    assert!(
        bridge_src.contains("nur prozessweit") || bridge_src.contains("nicht-durable")
            || bridge_src.contains("prozessweite"),
        "und die Datei sagt selbst, dass dieser Schutz nicht durable ist"
    );
}

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
    assert_eq!(REMOTE_OPS, &[OP_PROBE], "C1 gibt genau eine Operation frei");
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

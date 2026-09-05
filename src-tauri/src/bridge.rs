//! CENTRAL-C1 — die Brücke von einer Netzanfrage zur einen Geschäftsautorität.
//!
//! Der Ausgangspunkt ist eine Tatsache über diese Anwendung, nicht ein Entwurf: die
//! Geschäftsdatenbank gehört sql.js im Renderer, und es gibt **genau ein** Fenster. Rust hält
//! `lataif.db` ausdrücklich nur lesend. Ein zweiter Rechner kann also nicht selbst schreiben — er
//! muss den Primary bitten. Genau das ist hier gebaut:
//!
//! ```text
//!   Axum-Anfrage → op_id → Warteregister → Tauri-Ereignis → Renderer führt aus
//!                → Antwortkommando → oneshot → dieselbe HTTP-Antwort
//! ```
//!
//! Was diese Datei NICHT tut: sie führt nichts aus, sie kennt keine Geschäftsregel und sie nimmt
//! keinen Namen aus dem Netz an. Der Aufrufer nennt eine Operation aus einer festen Liste
//! (`REMOTE_OPS`); alles andere wird abgelehnt, bevor irgendetwas den Renderer erreicht. Es gibt
//! bewusst keinen allgemeinen „führe aus"-Endpunkt und keinen Weg, SQL zu übergeben.
//!
//! Die vier Lebenszyklusfälle sind der eigentliche Inhalt. Eine Zeitgrenze allein wäre eine
//! Ausrede: sie verwandelt jeden Fehler in dieselbe späte Enttäuschung. Deshalb:
//!
//!   • **Renderer nicht bereit** — vor der ersten Anmeldung einer Generation wird gar nicht
//!     gesendet (503). Ein Ereignis ins Leere zu schicken und dann 30 Sekunden zu warten wäre
//!     dasselbe Ergebnis mit 30 Sekunden Verzögerung und ohne Begründung.
//!   • **Neu geladen (F5)** — der alte Zuhörer ist weg. Der Renderer meldet beim Start eine NEUE
//!     Generation; damit scheitern alle offenen Aufträge der alten sofort und ausdrücklich. Sie
//!     dürfen nicht „weiterleben" und beim neuen Renderer landen: der weiß nichts von ihnen, und
//!     eine Geschäftsbuchung zweimal auszuführen wäre schlimmer als sie zu verlieren.
//!   • **Herunterfahren** — es werden keine neuen Aufträge angenommen, und die offenen scheitern
//!     kontrolliert, bevor das Fenster geht.
//!   • **Zeitgrenze** — begrenztes Warten, Eintrag wird entfernt, 504. Niemals unbegrenzt.
//!
//! Die Reihenfolge der Geschäftsschreibvorgänge wird NICHT hier hergestellt. Ein Mutex um sql.js
//! wäre eine zweite Autorität; die Serialisierung gehört in den Renderer, der die Datenbank hält.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

/// Der Ereignisname, unter dem ein Auftrag den Renderer erreicht. Muss exakt mit
/// `src/core/bridge/bridge-listener.ts` (BRIDGE_COMMAND_EVENT) uebereinstimmen.
pub const EVENT_COMMAND: &str = "central-c1-bridge-command";

/// Die eine Operation, die C1 freischaltet: eine Probe. Sie beweist den Weg von der Anfrage bis
/// zur Antwort und zurück und rührt keine Geschäftsdaten an. Produktive Schreibvorgänge
/// (Rechnung, Verkauf, Einkauf, Transfer, Kommission) kommen erst, wenn Reihenfolge,
/// Transaktionsgrenzen und Nummernkreise stehen.
pub const OP_PROBE: &str = "bridge.probe";

/// CENTRAL-C2 — die Lesevorgaenge, die ein zweiter Rechner ausloesen darf. Reine Auskunft: sie
/// veraendern nichts und laufen im Primary-Renderer auf der AKTUELLEN Datenbank, nicht auf der
/// Datei, die ihr hinterherhinkt.
pub const OP_PRODUCTS_LIST: &str = "products.list";
pub const OP_PRODUCTS_GET: &str = "products.get";
pub const OP_CUSTOMERS_LIST: &str = "customers.list";
pub const OP_CUSTOMERS_GET: &str = "customers.get";
pub const OP_INVOICES_LIST: &str = "invoices.list";
pub const OP_INVOICES_GET: &str = "invoices.get";

/// CENTRAL-C3B — die ERSTE veraendernde Fernoperation. Sie steht hier neben den Lesevorgaengen,
/// weil Rust dieselbe Liste ein zweites Mal prueft; die Entscheidung, ob eine Mutation ueberhaupt
/// registriert werden darf, faellt zusaetzlich im Renderer (Zulassungsliste, fail-closed).
pub const OP_INVOICES_CREATE: &str = "invoices.create";

/// CENTRAL-C3C — Stammdaten. Zwei Namen, nicht ein generisches "speichere irgendetwas": jede
/// veraendernde Operation steht einzeln hier und einzeln in der Zulassungsliste des Renderers.
pub const OP_CUSTOMERS_CREATE: &str = "customers.create";
pub const OP_CUSTOMERS_UPDATE: &str = "customers.update";
/// CENTRAL-C3C — ein Artikel von einem zweiten Rechner. Die Bilder kommen NICHT hier durch: sie
/// liegen vorher in der neutralen Zwischenablage (`/api/staging/media`), und der Auftrag nennt nur
/// ihre Inhaltskennungen.
pub const OP_PRODUCTS_CREATE: &str = "products.create";
pub const OP_PRODUCTS_UPDATE: &str = "products.update";

/// Die Zulassungsliste. Ein Name, der hier nicht steht, erreicht den Renderer nie.
pub const REMOTE_OPS: &[&str] = &[
    OP_PROBE,
    OP_PRODUCTS_LIST,
    OP_PRODUCTS_GET,
    OP_CUSTOMERS_LIST,
    OP_CUSTOMERS_GET,
    OP_INVOICES_LIST,
    OP_INVOICES_GET,
    OP_INVOICES_CREATE,
    OP_CUSTOMERS_CREATE,
    OP_CUSTOMERS_UPDATE,
    OP_PRODUCTS_CREATE,
    OP_PRODUCTS_UPDATE,
];

/// Wie lange auf den Renderer gewartet wird, wenn niemand etwas anderes vorgibt.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BridgeError {
    /// Der Renderer hat noch keine Generation angemeldet — die Geschäftsmaschine läuft nicht.
    NotReady,
    /// Es wird heruntergefahren; neue Aufträge werden nicht mehr angenommen.
    ShuttingDown,
    /// Der Name steht nicht in `REMOTE_OPS`.
    OpNotAllowed,
    /// Der Renderer wurde neu geladen, während dieser Auftrag offen war.
    Reloaded,
    /// Der Renderer hat innerhalb der Frist nicht geantwortet.
    Timeout,
    /// Das Ereignis konnte nicht zugestellt werden (kein Fenster, Kanal tot).
    DeliveryFailed,
    /// Die mitgeschickte logische Kennung ist kein UUID.
    BadCommandId,
    /// Dieselbe Kennung wurde schon fuer etwas anderes benutzt (anderer Absender/Operation).
    CommandIdConflict,
}

impl BridgeError {
    pub fn code(&self) -> &'static str {
        match self {
            BridgeError::NotReady => "BRIDGE_RENDERER_NOT_READY",
            BridgeError::ShuttingDown => "BRIDGE_SHUTTING_DOWN",
            BridgeError::OpNotAllowed => "BRIDGE_OP_NOT_ALLOWED",
            BridgeError::Reloaded => "BRIDGE_RENDERER_RELOADED",
            BridgeError::Timeout => "BRIDGE_TIMEOUT",
            BridgeError::DeliveryFailed => "BRIDGE_DELIVERY_FAILED",
            BridgeError::BadCommandId => "BRIDGE_BAD_COMMAND_ID",
            BridgeError::CommandIdConflict => "BRIDGE_COMMAND_ID_CONFLICT",
        }
    }

    /// Sagt dieser Fehler etwas ueber die Ausfuehrung? Die Grenze ist die Zustellung: alles, was
    /// VOR dem Senden scheitert, ist sicher nicht passiert; alles danach ist offen.
    pub fn outcome(&self) -> Outcome {
        match self {
            // Nie gesendet.
            BridgeError::NotReady
            | BridgeError::ShuttingDown
            | BridgeError::OpNotAllowed
            | BridgeError::BadCommandId
            | BridgeError::CommandIdConflict
            | BridgeError::DeliveryFailed => Outcome::NotExecuted,
            // War unterwegs — der Renderer kann ihn ausgefuehrt haben.
            BridgeError::Timeout | BridgeError::Reloaded => Outcome::Unknown,
        }
    }

    /// Der Statuscode, den der Client sieht. 503 heißt „später nochmal", 504 „hat zu lange
    /// gedauert", 400 „so nicht" — jeder davon ist eine andere Handlungsanweisung, deshalb werden
    /// sie nicht zu einem gemeinsamen Fehler verschmolzen.
    pub fn http_status(&self) -> u16 {
        match self {
            BridgeError::OpNotAllowed | BridgeError::BadCommandId => 400,
            // Ein Widerspruch, kein Serverfehler: derselbe Name fuer zwei verschiedene Dinge.
            BridgeError::CommandIdConflict => 409,
            BridgeError::Timeout => 504,
            BridgeError::NotReady | BridgeError::ShuttingDown => 503,
            BridgeError::Reloaded | BridgeError::DeliveryFailed => 503,
        }
    }
}

/// Was ein Fehler über die AUSFÜHRUNG aussagt — und das ist etwas anderes als sein Code.
///
/// Der Unterschied ist der wichtigste in dieser Datei. „Zeitgrenze" hieß bisher stillschweigend
/// „nicht passiert". Das ist falsch: der Auftrag WAR beim Renderer, der kann ihn vollständig
/// ausgeführt und gespeichert haben, und nur die Antwort ging verloren. Ein Client, der daraufhin
/// wiederholt, bucht ein zweites Mal.
///
/// Deshalb zwei Klassen, und die Grenze liegt exakt bei der Zustellung:
///   • **NotExecuted** — es wurde gar nicht erst gesendet. Sicher nichts passiert, gefahrlos
///     wiederholbar.
///   • **Unknown** — es war unterwegs. Ob es lief, weiß niemand. Wiederholen NUR mit derselben
///     logischen Kennung und einem durablen Nachweis; den gibt es in C1 noch nicht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    NotExecuted,
    Unknown,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::NotExecuted => "not_executed",
            Outcome::Unknown => "unknown",
        }
    }
}

/// Was an den Renderer geht. `generation` ist mitgeschickt, damit eine Antwort ihrem Auftrag
/// zugeordnet werden kann, ohne dem Renderer zu glauben.
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub op_id: String,
    pub op: String,
    pub generation: u64,
    pub payload: serde_json::Value,
    /// CENTRAL-C3B — wer diesen Auftrag verantwortet. Fuer eine Auskunft ist das entbehrlich; fuer
    /// eine Buchung nicht: der durable Nachweis im Renderer wird auf genau diese Kennung
    /// geschluesselt. Sie kommt aus den geprueften Anmeldedaten, NIE aus dem Rumpf des Clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<EnvelopeIdentity>,
}

/// Die Identitaet, wie der Renderer sie sieht. `op` steht schon im Umschlag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeIdentity {
    pub command_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub user_id: String,
    pub payload_hash: String,
}

impl From<&CommandIdentity> for EnvelopeIdentity {
    fn from(i: &CommandIdentity) -> Self {
        Self {
            command_id: i.command_id.clone(),
            tenant_id: i.tenant_id.clone(),
            branch_id: i.branch_id.clone(),
            user_id: i.user_id.clone(),
            payload_hash: i.payload_hash.clone(),
        }
    }
}

/// Was zurückkommt. Drei Ausgänge, ausdrücklich getrennt: ein Ergebnis, ein fachliches Nein (der
/// Bestand war weg, die Rechnung ist bezahlt) und eine Störung. Der Client muss die drei
/// unterscheiden können — ein fachliches Nein wiederholt man nicht, eine Störung schon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Reply {
    Ok { value: serde_json::Value },
    BusinessError { code: String, message: String },
    InfrastructureError { code: String },
}

/// Wem eine logische Kennung gehört. Der Client vergibt sie EINMAL pro Speicherversuch und
/// benutzt sie bei jeder Wiederholung erneut — nur so kann ein späterer, durabler Nachweis
/// erkennen, dass zwei Anfragen dieselbe Absicht sind.
///
/// Übernommen wird sie nicht ungeprüft: sie muss ein UUID sein, und sie wird an den
/// AUTHENTIFIZIERTEN Absender und die Operation gebunden. Dieselbe Kennung mit anderem Mandanten,
/// anderer Filiale, anderem Benutzer oder anderer Operation ist ein Widerspruch und wird
/// abgewiesen — sonst könnte ein Client mit einer geratenen Kennung an einem fremden Vorgang
/// mitschreiben. Über den Inhalt einer Buchung entscheidet die Kennung nie; sie benennt nur.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandIdentity {
    pub command_id: String,
    pub tenant_id: String,
    pub branch_id: String,
    pub user_id: String,
    pub op: String,
    /// Der Fingerabdruck des semantischen Rumpfs. Ohne ihn waere eine Kennung nur ein Etikett:
    /// derselbe Name koennte zweimal etwas ANDERES bedeuten, und eine spaetere Wiederholung
    /// koennte eine fremde Buchung als "schon erledigt" ausgeben.
    pub payload_hash: String,
}

/// Der Fingerabdruck eines Rumpfs — deterministisch, unabhaengig von der Feldreihenfolge des
/// Clients:  haelt Objektschluessel sortiert (kein ), also ergibt
/// derselbe Inhalt immer denselben Text und damit denselben Hash. Kein neuer Kanonisierungsapparat;
/// es ist die Hash-Funktion, die das Haus ohnehin benutzt.
pub fn payload_fingerprint(payload: &serde_json::Value) -> String {
    crate::media::sha256_hex(serde_json::to_string(payload).unwrap_or_default().as_bytes())
}

/// Ein UUID in der kanonischen Schreibweise — nichts anderes wird angenommen. Damit kann die
/// Kennung kein Pfad, kein SQL-Fragment und kein Bezeichner sein.
pub fn is_valid_command_id(id: &str) -> bool {
    let b = id.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Wie ein Auftrag den Renderer erreicht. Als Merkmal ausgeführt, damit die Tests den echten
/// Registerablauf ohne Fenster fahren können — und damit diese Datei nichts von Tauri wissen muss.
pub trait CommandSink: Send + Sync {
    fn deliver(&self, envelope: &Envelope) -> Result<(), String>;
}

/// Wie viele kürzlich benutzte Kennungen behalten werden.
///
/// Der Zweck ist eng: eine versehentliche sofortige Wiederverwendung derselben Kennung für einen
/// ANDEREN Rumpf soll auffallen. Dafür reichen die letzten paar hundert; ein Client, der eine
/// Kennung nach tausend anderen Aufträgen mit neuem Inhalt erneut benutzt, ist kein Versehen mehr.
/// Bewusst begrenzt: eine Struktur, die nur wächst, ist in einem Programm, das monatelang läuft,
/// ein Leck — und dieser Schutz ist ohnehin nur prozessweit.
pub const IDENTITY_RETENTION: usize = 1024;

/// Eine gemerkte Kennung. `in_flight` zählt die Aufträge, die gerade darauf laufen: solange einer
/// offen ist, darf der Eintrag NICHT verdrängt werden, sonst könnte seine eigene Wiederholung
/// mitten im Lauf plötzlich als etwas Neues gelten.
struct IdentityEntry {
    identity: CommandIdentity,
    in_flight: usize,
}

/// Begrenzter Speicher mit Verdrängung in Ankunftsreihenfolge. Kein LRU-Apparat: der Zweck ist
/// „kürzlich", nicht „häufig", und die Reihenfolge der Ankunft beantwortet genau das.
struct IdentityStore {
    map: HashMap<String, IdentityEntry>,
    order: VecDeque<String>,
}

impl IdentityStore {
    fn new() -> Self {
        Self { map: HashMap::new(), order: VecDeque::new() }
    }

    /// Meldet einen Auftrag an. `Err` heißt: dieselbe Kennung steht schon für etwas anderes.
    fn begin(&mut self, identity: &CommandIdentity) -> Result<(), BridgeError> {
        match self.map.get_mut(&identity.command_id) {
            Some(e) if e.identity == *identity => {
                e.in_flight += 1;
                return Ok(());
            }
            Some(_) => return Err(BridgeError::CommandIdConflict),
            None => {}
        }
        self.map.insert(
            identity.command_id.clone(),
            IdentityEntry { identity: identity.clone(), in_flight: 1 },
        );
        self.order.push_back(identity.command_id.clone());
        self.evict();
        Ok(())
    }

    fn finish(&mut self, command_id: &str) {
        if let Some(e) = self.map.get_mut(command_id) {
            e.in_flight = e.in_flight.saturating_sub(1);
        }
        self.evict();
    }

    /// Verdrängt die ältesten, ÜBERSPRINGT aber alles, was gerade läuft. Die Schleife ist durch die
    /// Länge begrenzt: sind ausnahmsweise alle Einträge offen, wird nichts verdrängt und der
    /// Speicher wächst vorübergehend, statt einen laufenden Auftrag zu verlieren.
    fn evict(&mut self) {
        let mut checked = 0usize;
        while self.map.len() > IDENTITY_RETENTION && checked < self.order.len() {
            checked += 1;
            let Some(key) = self.order.pop_front() else { break };
            match self.map.get(&key) {
                Some(e) if e.in_flight > 0 => self.order.push_back(key), // laeuft noch — hinten anstellen
                Some(_) => { self.map.remove(&key); }
                None => {}
            }
        }
    }

    fn len(&self) -> usize {
        self.map.len()
    }
}

struct PendingEntry {
    generation: u64,
    tx: oneshot::Sender<Reply>,
}

pub struct Bridge {
    sink: Box<dyn CommandSink>,
    /// 0 = der Renderer hat sich noch nie gemeldet. Jede Anmeldung erhöht den Wert.
    generation: AtomicU64,
    accepting: AtomicBool,
    pending: Mutex<HashMap<String, PendingEntry>>,
    /// Welche logische Kennung zu wem gehoert. NUR prozessweit — der durable Nachweis fehlt und
    /// gehoert nach C3 in dieselbe Transaktion wie die Buchung.
    identities: Mutex<IdentityStore>,
}

impl Bridge {
    pub fn new(sink: Box<dyn CommandSink>) -> Self {
        Self {
            sink,
            generation: AtomicU64::new(0),
            accepting: AtomicBool::new(true),
            pending: Mutex::new(HashMap::new()),
            identities: Mutex::new(IdentityStore::new()),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Der Renderer meldet sich als bereit. Alles, was noch von einer FRÜHEREN Generation offen
    /// ist, scheitert hier und jetzt — der Renderer, der es ausführen sollte, existiert nicht mehr.
    pub fn announce_generation(&self) -> u64 {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.fail_pending_before(next);
        next
    }

    /// Ab hier keine neuen Aufträge, und die offenen werden aufgelöst. Wird vor dem Ende des
    /// Fensters gerufen, damit kein Client auf eine Antwort wartet, die niemand mehr geben kann.
    pub fn stop_accepting(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        self.fail_pending_before(u64::MAX);
    }

    fn fail_pending_before(&self, generation: u64) {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.generation < generation)
            .map(|(k, _)| k.clone())
            .collect();
        for key in stale {
            if let Some(entry) = map.remove(&key) {
                // Der Empfänger wandelt ein geschlossenes Kanalende in `Reloaded` um; ein
                // ausdrücklicher Fehlerwert wäre eine zweite Wahrheit für denselben Zustand.
                drop(entry.tx);
            }
        }
    }

    pub async fn submit(&self, op: &str, payload: serde_json::Value) -> Result<Reply, BridgeError> {
        self.submit_with_timeout(op, payload, DEFAULT_TIMEOUT).await
    }

    /// Wie `submit`, aber mit der logischen Kennung des Clients. Die Bindung ist in C1 bewusst nur
    /// prozessweit: sie beweist die REGEL (dieselbe Kennung heißt dieselbe Absicht), ersetzt aber
    /// keinen durablen Nachweis. Genau deshalb ist in C1 auch keine verändernde Operation
    /// registrierbar — ohne Ledger in derselben Transaktion wie die Buchung wäre jede
    /// „genau einmal"-Behauptung unbelegt.
    pub async fn submit_as(
        &self,
        identity: &CommandIdentity,
        payload: serde_json::Value,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        if !is_valid_command_id(&identity.command_id) {
            return Err(BridgeError::BadCommandId);
        }
        {
            let mut store = self.identities.lock().unwrap_or_else(|e| e.into_inner());
            store.begin(identity)?;
        }
        // Der Eintrag bleibt geschuetzt, bis DIESER Auftrag durch ist — auch wenn er scheitert.
        let out = self.dispatch(&identity.op, payload, Some(identity.into()), timeout).await;
        {
            let mut store = self.identities.lock().unwrap_or_else(|e| e.into_inner());
            store.finish(&identity.command_id);
        }
        out
    }

    /// Nur zur Pruefung: wie viele Kennungen gerade gemerkt sind.
    pub fn remembered_identities(&self) -> usize {
        self.identities.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub async fn submit_with_timeout(
        &self,
        op: &str,
        payload: serde_json::Value,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        self.dispatch(op, payload, None, timeout).await
    }

    /// Der gemeinsame Weg. Die Identitaet ist optional, weil eine Auskunft keine braucht — eine
    /// Buchung schon, und der Renderer weist eine Mutation ohne Identitaet ab.
    async fn dispatch(
        &self,
        op: &str,
        payload: serde_json::Value,
        identity: Option<EnvelopeIdentity>,
        timeout: Duration,
    ) -> Result<Reply, BridgeError> {
        // Reihenfolge der Prüfungen ist Absicht: erst der Name (der darf nie zum Renderer),
        // dann der Zustand (der entscheidet, ob überhaupt gesendet wird).
        if !REMOTE_OPS.contains(&op) {
            return Err(BridgeError::OpNotAllowed);
        }
        if !self.accepting.load(Ordering::SeqCst) {
            return Err(BridgeError::ShuttingDown);
        }
        let generation = self.generation();
        if generation == 0 {
            return Err(BridgeError::NotReady);
        }

        let op_id = uuid::Uuid::new_v4().to_string();
        let envelope = Envelope {
            op_id: op_id.clone(),
            op: op.to_string(),
            generation,
            payload,
            identity,
        };

        let rx = {
            let (tx, rx) = oneshot::channel::<Reply>();
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(op_id.clone(), PendingEntry { generation, tx });
            rx
        };

        if let Err(_e) = self.sink.deliver(&envelope) {
            self.take_pending(&op_id);
            return Err(BridgeError::DeliveryFailed);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => Ok(reply),
            // Kanal zu, ohne Antwort: der Eintrag wurde verworfen — Neuladen oder Ende.
            Ok(Err(_recv_error)) => Err(BridgeError::Reloaded),
            Err(_elapsed) => {
                self.take_pending(&op_id);
                Err(BridgeError::Timeout)
            }
        }
    }

    /// Die Antwort des Renderers. Eine Antwort aus einer anderen Generation wird verworfen: sie
    /// gehört zu einem Fenster, das es nicht mehr gibt.
    pub fn reply(&self, op_id: &str, generation: u64, reply: Reply) -> Result<(), BridgeError> {
        if generation != self.generation() {
            return Err(BridgeError::Reloaded);
        }
        // Eine zweite Antwort auf dieselbe `op_id` findet keinen Eintrag mehr und ist ein No-op.
        // Verwechseln kann sie nichts: die Kennung kommt aus `Uuid::new_v4()` und wird nie erneut
        // vergeben — deshalb braucht es hier keine Liste erledigter Auftraege, die nur waechst.
        match self.take_pending(op_id) {
            Some(entry) if entry.generation == generation => {
                let _ = entry.tx.send(reply);
                Ok(())
            }
            Some(_) => Err(BridgeError::Reloaded),
            None => Ok(()), // Zeitgrenze war schneller; niemand wartet mehr.
        }
    }

    fn take_pending(&self, op_id: &str) -> Option<PendingEntry> {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(op_id)
    }

    pub fn pending_count(&self) -> usize {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }
}

// ── Die eine Brücke des Prozesses ─────────────────────────────────────────
//
// Prozessweit, weil sie es tatsächlich ist: eine Anwendung, ein Fenster, eine Geschäftsdatenbank.
// Die Axum-Route hat keinen Zugriff auf den Tauri-Handle, und ihn durch `AppState` zu fädeln würde
// fünf Konstruktoren (darunter Testrouter ohne Tauri) um ein Feld erweitern, das sie nie füllen.

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

/// Einmalig beim Start gesetzt, sobald es ein Fenster gibt. Ein zweiter Aufruf ändert nichts.
pub fn install(bridge: Bridge) -> bool {
    BRIDGE.set(bridge).is_ok()
}

/// `None`, solange keine Brücke steht — dann gibt es keinen Renderer, den man fragen könnte.
pub fn global() -> Option<&'static Bridge> {
    BRIDGE.get()
}

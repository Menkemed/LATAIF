//! CENTRAL-C3C — die neutrale Zwischenablage für Bilder eines zweiten Rechners.
//!
//! Ein Produkt anzulegen heißt, Bytes mitzubringen. Über `/api/command` geht das nicht: dort liegt
//! ein Auftrag, kein Bildstapel, und 25 MiB als Base64 in eine Auftragsnutzlast zu legen hieße, die
//! Warteschlange des Renderers mit Bildern zu verstopfen.
//!
//! Es gab schon einen Weg, auf dem Bilder hereinkommen: `/api/mobile/upload`. Ihn zu benutzen wäre
//! bequem und falsch. Diese Route ist kein Briefkasten, sondern ein PRODUKT-EINGANG: sie prüft
//! Produktfelder, schreibt eine Zeile in `mobile_upload_inbox`, und ihr Abarbeiter legt das Produkt
//! an. Ein Desktop-Client, der sie benutzte, hätte damit einen zweiten Weg, ein Produkt entstehen
//! zu lassen — an `runRemoteCommand` vorbei, ohne durablen Nachweis, mit einer anderen Idempotenz.
//! Zwei Wege zum selben Ergebnis sind zwei Wahrheiten.
//!
//! Also die kleinste ehrliche Stelle, die genau EINES kann: Bytes annehmen und wieder herausgeben.
//!
//!  • **Sie fasst die Geschäftsdatenbank nicht an.** Keine Tabelle, keine Zeile, kein Changelog.
//!    Was hier liegt, ist noch nichts — es wird erst etwas, wenn ein Auftrag es benutzt.
//!  • **Sie nimmt keinen Pfad entgegen.** Der Name einer Ablage ist der SHA-256 ihres Inhalts, vom
//!    Server berechnet. Es gibt kein Feld, in dem ein Client ein Ziel nennen könnte, und deshalb
//!    auch nichts, was man mit `..` verlassen könnte.
//!  • **Der Inhaltshash ist eine BENENNUNG, keine Berechtigung.** Er dient dem Wiedererkennen
//!    derselben Bytes (kein zweites Hochladen) und der Unversehrtheit (beim Abholen wird
//!    nachgerechnet) — aber er öffnet nichts. Jede Ablage liegt unter dem Schlüssel ihres
//!    EIGENTÜMERS, und der wird ausschließlich aus den geprüften Anmeldedaten abgeleitet
//!    (`owner_key`). Wer einen fremden Hash kennt, hat damit nichts: unter seinem eigenen
//!    Eigentümerschlüssel gibt es die Ablage nicht. Ohne diese Bindung wäre der Hash ein
//!    Passwort, das man erraten oder aus einem Protokoll ablesen kann — und ein zweiter Mandant
//!    könnte fremde Bytes in sein eigenes Produkt hängen.
//!  • **Sie entscheidet nichts.** Kein Produkt, keine SKU, keine Kategorie. Wer die Bytes später
//!    verwendet, ist der Primary-Renderer über den ganz normalen Auftragsweg.
//!  • **Sie vergisst.** Was niemand abholt, verschwindet nach einer Frist. Eine Ablage, die ewig
//!    wächst, wäre ein zweiter Medienspeicher ohne Buchführung.
//!
//! Was ein Bild ist, entscheidet NICHT diese Datei: `mobile_upload::accept_image_bytes` ist die
//! eine Antwort darauf, und beide Eingangsstellen fragen sie.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Wie lange eine unbenutzte Ablage liegen bleibt. Lang genug, dass ein Mensch das Formular
/// zwischendurch liegen lassen darf; kurz genug, dass nichts dauerhaft entsteht.
pub const STAGED_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Wie viele Ablagen insgesamt liegen dürfen. Eine harte Obergrenze, damit ein angemeldeter Client
/// die Platte nicht vollschreiben kann, auch nicht innerhalb der Frist.
pub const MAX_STAGED_FILES: usize = 512;

pub const ERR_TOO_MANY: &str = "STAGING_FULL";
pub const ERR_BAD_OWNER: &str = "STAGING_BAD_OWNER";
pub const ERR_BAD_ID: &str = "STAGING_BAD_ID";
pub const ERR_NOT_FOUND: &str = "STAGING_NOT_FOUND";
pub const ERR_IO: &str = "STAGING_IO";

/// Was eine angenommene Ablage über sich sagt. Die Kennung IST der Inhalt (sein Hash) — deshalb
/// ist ein zweites Hochladen derselben Bytes keine zweite Ablage, sondern dieselbe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedBlob {
    pub staging_id: String,
    pub mime: &'static str,
    pub bytes: usize,
    pub width: u32,
    pub height: u32,
}

/// Eine Kennung ist genau 64 Hex-Zeichen. Alles andere wird abgewiesen, bevor daraus ein Pfad
/// wird — das ist der Grund, warum es hier keine Pfadprüfung braucht: es gibt keinen Pfad, den
/// jemand nennen könnte.
pub fn is_staging_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Der Eigentümerschlüssel: SHA-256 über die drei Angaben aus dem GEPRÜFTEN Token. Nichts davon
/// kommt aus dem Rumpf einer Anfrage, und das Ergebnis ist eine feste Folge aus 64 Hex-Zeichen —
/// als Verzeichnisname ebenso undarstellbar-gefährlich wie die Inhaltskennung.
///
/// Bewusst auf (Mandant, Filiale, Benutzer) gebunden und nicht nur auf den Mandanten: eine Ablage
/// gehört dem Menschen, der sie gerade hochgeladen hat, und sie wird Sekunden später von genau
/// seinem Auftrag verbraucht. Eine weitere Reichweite wäre Bequemlichkeit ohne Not.
pub fn owner_key(tenant_id: &str, branch_id: &str, user_id: &str) -> String {
    super::canonical::sha256_hex(
        format!("staging-owner\u{1}{tenant_id}\u{1}{branch_id}\u{1}{user_id}").as_bytes(),
    )
}

/// Ein Eigentümerschlüssel ist immer selbst berechnet — geprüft wird trotzdem, damit ein späterer
/// Aufrufer ihn nicht versehentlich aus einer fremden Quelle durchreicht.
fn owner_dir(root: &Path, owner: &str) -> Result<PathBuf, &'static str> {
    if !is_staging_id(owner) {
        return Err(ERR_BAD_OWNER);
    }
    Ok(root.join(owner))
}

fn path_for(root: &Path, owner: &str, id: &str) -> Result<PathBuf, &'static str> {
    Ok(owner_dir(root, owner)?.join(format!("{id}.bin")))
}

/// Legt Bytes ab und gibt ihre Kennung zurück. `declared_mime` wird gegen die Magic Bytes geprüft —
/// dieselbe Prüfung wie beim mobilen Upload.
pub fn stage_image(
    root: &Path,
    owner: &str,
    declared_mime: &str,
    bytes: &[u8],
) -> Result<StagedBlob, &'static str> {
    let accepted = super::mobile_upload::accept_image_bytes(declared_mime, bytes)?;
    let dir = owner_dir(root, owner)?;
    std::fs::create_dir_all(&dir).map_err(|_| ERR_IO)?;

    let target = path_for(root, owner, &accepted.content_hash)?;
    // Dieselben Bytes ein zweites Mal: dieselbe Ablage. Kein zweites Schreiben, kein Zählen gegen
    // die Obergrenze — es entsteht nichts Neues.
    if target.exists() {
        return Ok(StagedBlob {
            staging_id: accepted.content_hash,
            mime: accepted.mime,
            bytes: bytes.len(),
            width: accepted.width,
            height: accepted.height,
        });
    }
    // Die Obergrenze zählt JE EIGENTÜMER: ein Client soll den nächsten nicht aussperren können.
    if count_staged(&dir) >= MAX_STAGED_FILES {
        return Err(ERR_TOO_MANY);
    }

    // Erst vollständig schreiben, dann umbenennen: eine halbe Datei unter einer Kennung, die ihren
    // Inhalt behauptet, wäre eine Lüge, die später niemand mehr erkennt.
    let tmp = dir.join(format!("{}.tmp-{}", accepted.content_hash, uuid::Uuid::new_v4().as_simple()));
    std::fs::write(&tmp, bytes).map_err(|_| ERR_IO)?;
    if std::fs::rename(&tmp, &target).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(ERR_IO);
    }
    Ok(StagedBlob {
        staging_id: accepted.content_hash,
        mime: accepted.mime,
        bytes: bytes.len(),
        width: accepted.width,
        height: accepted.height,
    })
}

/// Holt die Bytes zurück. Es wird NACHGERECHNET, dass sie ihre Kennung noch verdienen: eine
/// veränderte Datei ist keine Ablage mehr, sondern ein Fund.
pub fn read_staged(root: &Path, owner: &str, id: &str) -> Result<Vec<u8>, &'static str> {
    if !is_staging_id(id) {
        return Err(ERR_BAD_ID);
    }
    // Eine Ablage eines ANDEREN Eigentümers ist von hier aus nicht vorhanden — nicht „verboten",
    // sondern schlicht nicht da. Es gibt keinen Pfad, der aus dem eigenen Verzeichnis herausführt.
    let bytes = std::fs::read(path_for(root, owner, id)?).map_err(|_| ERR_NOT_FOUND)?;
    if super::canonical::sha256_hex(&bytes) != id {
        return Err(ERR_NOT_FOUND);
    }
    Ok(bytes)
}

pub fn discard_staged(root: &Path, owner: &str, id: &str) -> Result<(), &'static str> {
    if !is_staging_id(id) {
        return Err(ERR_BAD_ID);
    }
    match std::fs::remove_file(path_for(root, owner, id)?) {
        Ok(()) => Ok(()),
        // Schon weg ist auch weg — ein Abräumen darf nicht daran scheitern, dass es zweimal läuft.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ERR_IO),
    }
}

fn count_staged(root: &Path) -> usize {
    match std::fs::read_dir(root) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().extension().map(|x| x == "bin").unwrap_or(false))
            .count(),
        Err(_) => 0,
    }
}

/// Räumt auf, was niemand abgeholt hat. Wird beim Start gerufen — nicht als Zeitgeber im Betrieb:
/// eine Ablage, die während eines laufenden Auftrags verschwände, wäre ein Fehler, den niemand
/// erklären kann.
pub fn sweep_expired(root: &Path, now: SystemTime, ttl: Duration) -> usize {
    let mut removed = 0;
    let Ok(owners) = std::fs::read_dir(root) else { return 0 };
    for owner in owners.flatten() {
        removed += sweep_dir(&owner.path(), now, ttl);
    }
    removed
}

/// Was der Kehrbesen NICHT anfasst: alles ausserhalb dieses Verzeichnisses. Ein Produkt, das schon
/// gebucht ist, haengt an veroeffentlichten Medien im Medienspeicher — die Ablage ist dann nur noch
/// ein Rest. Deshalb kann diese Frist niemals ein gebuchtes Produkt entkleiden.
fn sweep_dir(dir: &Path, now: SystemTime, ttl: Duration) -> usize {
    let mut removed = 0;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        // Auch liegengebliebene `.tmp-…` verschwinden: sie sind der Rest eines abgebrochenen
        // Schreibens und gehören keinem.
        let expired = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age > ttl)
            .unwrap_or(false);
        if expired && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
#[path = "media_staging_tests.rs"]
mod media_staging_tests;

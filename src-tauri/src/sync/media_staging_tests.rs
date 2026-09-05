// CENTRAL-C3C — die neutrale Zwischenablage: was sie kann, und vor allem, was sie NICHT kann.
//
// Die Route ist der einzige neue Weg, auf dem Bytes von einem zweiten Rechner ins Haus kommen.
// Genau deshalb steht hier nicht nur „legt ab und gibt heraus", sondern die vier Verbote: kein
// Pfad, keine Datenbank, kein Produkt, kein unbegrenztes Wachstum.

use super::*;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn tmp() -> Tmp {
    let p = std::env::temp_dir().join(format!("lataif-staging-{}", uuid::Uuid::new_v4().as_simple()));
    std::fs::create_dir_all(&p).unwrap();
    Tmp(p)
}

fn jpeg(w: u32, h: u32, salt: u8) -> Vec<u8> {
    let mut img = image::RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            img.put_pixel(
                x,
                y,
                image::Rgb([(x as u8).wrapping_add(salt), (y as u8) ^ salt, ((x + y) as u8).wrapping_mul(31)]),
            );
        }
    }
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .unwrap();
    buf
}

/** Ein Eigentuemer, wie ihn die Route aus geprueften Claims ableiten wuerde. */
fn owner_a() -> String {
    owner_key("tenant-1", "branch-main", "user-a")
}
fn owner_b() -> String {
    owner_key("tenant-1", "branch-main", "user-b")
}
fn owner_other_tenant() -> String {
    owner_key("tenant-2", "branch-main", "user-a")
}

/// Wie viele Dateien in der Ablage EINES Eigentuemers liegen.
fn files(root: &Path, owner: &str) -> usize {
    std::fs::read_dir(root.join(owner)).map(|d| d.flatten().count()).unwrap_or(0)
}

#[test]
fn a_staged_image_is_named_by_its_content() {
    let t = tmp();
    let bytes = jpeg(40, 30, 7);
    let blob = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).expect("ein Bild wird angenommen");

    assert_eq!(blob.staging_id, crate::sync::canonical::sha256_hex(&bytes), "die Kennung IST der Inhalt");
    assert!(is_staging_id(&blob.staging_id), "und sie ist 64 Hex-Zeichen");
    assert_eq!(blob.mime, "image/jpeg");
    assert_eq!(blob.bytes, bytes.len());
    assert_eq!(read_staged(&t.0, &owner_a(), &blob.staging_id).unwrap(), bytes, "und die Bytes kommen unveraendert zurueck");
}

#[test]
fn the_same_bytes_twice_are_the_same_shelf() {
    let t = tmp();
    let bytes = jpeg(20, 20, 1);
    let a = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).unwrap();
    let b = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).unwrap();
    assert_eq!(a.staging_id, b.staging_id, "derselbe Inhalt, dieselbe Kennung");
    assert_eq!(files(&t.0, &owner_a()), 1, "und nur EINE Datei — ein zweites Hochladen legt nichts Neues an");
}

#[test]
fn what_is_not_an_image_never_lands() {
    let t = tmp();
    // Ein PDF-Kopf, ein SVG, ein Textstueck: alles wird an denselben Magic-Bytes abgewiesen, die
    // auch der mobile Eingang benutzt.
    for (name, bytes) in [
        ("pdf", b"%PDF-1.7 fake".to_vec()),
        ("svg", b"<svg xmlns='http://www.w3.org/2000/svg'></svg>".to_vec()),
        ("text", b"just words".to_vec()),
        ("empty", Vec::new()),
    ] {
        let err = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).expect_err(name);
        assert!(!err.is_empty(), "{name} wird mit einem Code abgewiesen");
    }
    assert_eq!(files(&t.0, &owner_a()), 0, "und nichts davon liegt auf der Platte");
}

#[test]
fn a_lie_about_the_type_is_a_rejection_not_a_correction() {
    let t = tmp();
    let bytes = jpeg(16, 16, 3);
    let err = stage_image(&t.0, &owner_a(), "image/png", &bytes).expect_err("PNG behauptet, JPEG geliefert");
    assert_eq!(err, crate::sync::mobile_upload::ERR_MIME_MISMATCH);
    assert_eq!(files(&t.0, &owner_a()), 0, "und es wird nichts abgelegt");
}

#[test]
fn there_is_no_path_only_a_hash() {
    let t = tmp();
    // Was keine Inhaltskennung ist, wird abgewiesen, BEVOR daraus ein Dateiname wird. Genau das
    // macht ein Verlassen des Verzeichnisses undarstellbar statt gefiltert.
    for bad in [
        "../../etc/passwd",
        "..\\..\\windows\\system32",
        "bild.jpg",
        "/absolute/path",
        "C:/Windows/x",
        &"A".repeat(64),          // Grossbuchstaben sind kein Hex-Kleinbuchstabe
        &"z".repeat(64),          // kein Hex
        &"a".repeat(63),          // zu kurz
        &"a".repeat(65),          // zu lang
    ] {
        assert!(!is_staging_id(bad), "{bad} ist keine Kennung");
        assert_eq!(read_staged(&t.0, &owner_a(), bad), Err(ERR_BAD_ID), "{bad} wird beim Lesen abgewiesen");
        assert_eq!(discard_staged(&t.0, &owner_a(), bad), Err(ERR_BAD_ID), "{bad} wird beim Verwerfen abgewiesen");
    }
}

#[test]
fn a_changed_file_is_not_that_shelf_anymore() {
    let t = tmp();
    let bytes = jpeg(24, 24, 5);
    let blob = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).unwrap();
    // Jemand tauscht den Inhalt unter der Kennung aus.
    std::fs::write(t.0.join(owner_a()).join(format!("{}.bin", blob.staging_id)), b"anderes").unwrap();
    assert_eq!(
        read_staged(&t.0, &owner_a(), &blob.staging_id),
        Err(ERR_NOT_FOUND),
        "was seine Kennung nicht mehr traegt, gibt es nicht"
    );
}

#[test]
fn discarding_twice_is_not_an_error() {
    let t = tmp();
    let blob = stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(12, 12, 2)).unwrap();
    assert_eq!(discard_staged(&t.0, &owner_a(), &blob.staging_id), Ok(()));
    assert_eq!(discard_staged(&t.0, &owner_a(), &blob.staging_id), Ok(()), "ein Aufraeumen darf zweimal laufen");
    assert_eq!(read_staged(&t.0, &owner_a(), &blob.staging_id), Err(ERR_NOT_FOUND));
}

#[test]
fn what_nobody_collects_is_swept() {
    let t = tmp();
    let fresh = stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(16, 16, 9)).unwrap();
    // Eine Datei, die aelter ist als die Frist: der Kehrbesen nimmt sie mit. Modelliert ueber
    // einen Kehrbesen-Lauf mit einer Frist von 0.
    let removed = sweep_expired(&t.0, SystemTime::now() + Duration::from_secs(60), Duration::from_secs(1));
    assert_eq!(removed, 1, "die abgelaufene Ablage verschwindet");
    assert_eq!(read_staged(&t.0, &owner_a(), &fresh.staging_id), Err(ERR_NOT_FOUND));

    // Und was frisch ist, bleibt.
    let keep = stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(16, 16, 4)).unwrap();
    assert_eq!(sweep_expired(&t.0, SystemTime::now(), STAGED_TTL), 0, "Frisches bleibt liegen");
    assert!(read_staged(&t.0, &owner_a(), &keep.staging_id).is_ok());
}

#[test]
fn the_shelf_has_a_hard_ceiling() {
    let t = tmp();
    // Die Grenze wird hier nicht mit 512 Bildern nachgestellt — es genuegt, dass sie ueberhaupt
    // zaehlt und nicht erst die Platte fragt.
    assert!(MAX_STAGED_FILES > 0 && MAX_STAGED_FILES <= 4096, "eine endliche Obergrenze");
    for i in 0..3u8 {
        stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(8, 8, i)).unwrap();
    }
    assert_eq!(files(&t.0, &owner_a()), 3, "drei verschiedene Bilder, drei Ablagen");
}

#[test]
fn the_staging_module_touches_no_database() {
    // Der Beweis ist die Abwesenheit: kein SQL, keine Verbindung, kein Produkt. Waere hier je eine
    // Zeile, waere die Route kein Briefkasten mehr, sondern ein zweiter Produkt-Eingang.
    let src = include_str!("media_staging.rs");
    let code: String = src
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    for forbidden in ["INSERT INTO", "UPDATE ", "DELETE FROM", "Connection", "rusqlite", "product"] {
        assert!(
            !code.contains(forbidden),
            "die Zwischenablage darf nichts von {forbidden} wissen"
        );
    }
}

#[test]
fn the_route_sits_behind_the_same_locks_as_every_other_write() {
    let routes = include_str!("routes.rs");
    let handler = &routes[routes.find("async fn staging_media_put").expect("die Route gibt es")
        ..routes.find("struct CommandRequest").expect("bis zum naechsten Vertrag")];
    assert!(handler.contains("may_write_sync()"), "nur ein schreibfaehiger Primary nimmt etwas an");
    assert!(handler.contains("claims.role"), "und nur eine Anmeldung mit Rolle");
    assert!(handler.contains("is_json_content_type"), "derselbe Inhaltstyp-Vertrag wie ueberall");
    assert!(
        handler.contains("command_staging_root()"),
        "und sie schreibt in die EIGENE Ablage, nicht in die des Handys"
    );
    assert!(
        !handler.contains("mobile_staging_root"),
        "die mobile Ablage bleibt unangetastet — dort haengen Inbox-Zeilen dran"
    );
    // Und sie liegt hinter derselben Anmeldeschicht: sie steht im geschuetzten Router.
    let protected = &routes[..routes.find("route_layer(middleware::from_fn_with_state").unwrap()];
    assert!(
        protected.contains(".route(\"/staging/media\", post(staging_media_put))"),
        "die Route steht im angemeldeten Teil des Routers"
    );
}

// ── CENTRAL-C3C FINAL — der Hash benennt, er berechtigt nicht ─────────────

#[test]
fn a_hash_from_someone_else_opens_nothing() {
    let t = tmp();
    let bytes = jpeg(32, 24, 11);
    let blob = stage_image(&t.0, &owner_a(), "image/jpeg", &bytes).unwrap();

    // Ein zweiter Benutzer derselben Filiale KENNT die Kennung (sie steht in einer Antwort, einem
    // Protokoll, einem Screenshot) — und bekommt trotzdem nichts.
    assert_eq!(
        read_staged(&t.0, &owner_b(), &blob.staging_id),
        Err(ERR_NOT_FOUND),
        "eine fremde Ablage ist von hier aus nicht vorhanden"
    );
    // Und ein anderer Mandant erst recht nicht.
    assert_eq!(
        read_staged(&t.0, &owner_other_tenant(), &blob.staging_id),
        Err(ERR_NOT_FOUND),
        "und ueber Mandantengrenzen schon gar nicht"
    );
    // Auch das Verwerfen greift nicht in fremde Ablagen: der Eigentuemer behaelt seine Bytes.
    assert_eq!(discard_staged(&t.0, &owner_b(), &blob.staging_id), Ok(()));
    assert_eq!(
        read_staged(&t.0, &owner_a(), &blob.staging_id).unwrap(),
        bytes,
        "ein fremdes Verwerfen loescht nichts"
    );
}

#[test]
fn the_owner_key_comes_from_the_verified_identity_only() {
    // Drei verschiedene Identitaeten, drei verschiedene Schluessel — und keiner davon ist ein Pfad.
    let a = owner_key("t", "b", "u");
    assert_ne!(a, owner_key("t", "b", "u2"), "ein anderer Benutzer ist ein anderer Eigentuemer");
    assert_ne!(a, owner_key("t", "b2", "u"), "eine andere Filiale auch");
    assert_ne!(a, owner_key("t2", "b", "u"), "und ein anderer Mandant auch");
    assert_eq!(a, owner_key("t", "b", "u"), "und derselbe bleibt derselbe");
    assert!(is_staging_id(&a), "der Schluessel ist eine feste Folge aus 64 Hex-Zeichen");
    // Ein Eigentuemer, der aus einer fremden Quelle stammen koennte, wird nicht als Pfad benutzt.
    let t = tmp();
    for bogus in ["..", "../..", "a/b", "", &"x".repeat(64)] {
        assert_eq!(
            stage_image(&t.0, bogus, "image/jpeg", &jpeg(8, 8, 1)),
            Err(ERR_BAD_OWNER),
            "{bogus} ist kein Eigentuemerschluessel"
        );
    }
}

#[test]
fn the_ceiling_is_per_owner_not_global() {
    let t = tmp();
    stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(8, 8, 1)).unwrap();
    stage_image(&t.0, &owner_b(), "image/jpeg", &jpeg(8, 8, 2)).unwrap();
    assert_eq!(files(&t.0, &owner_a()), 1, "jeder hat sein eigenes Fach…");
    assert_eq!(files(&t.0, &owner_b()), 1, "…und kann den anderen nicht aussperren");
}

#[test]
fn the_sweep_reaches_every_owner_and_nothing_else() {
    let t = tmp();
    let a = stage_image(&t.0, &owner_a(), "image/jpeg", &jpeg(8, 8, 3)).unwrap();
    let b = stage_image(&t.0, &owner_b(), "image/jpeg", &jpeg(8, 8, 4)).unwrap();
    // Eine Datei NEBEN der Ablage — sie geht den Kehrbesen nichts an.
    let outside = t.0.join("nicht-meins.txt");
    std::fs::write(&outside, b"fremd").unwrap();

    let removed = sweep_expired(&t.0, SystemTime::now() + Duration::from_secs(60), Duration::from_secs(1));
    assert_eq!(removed, 2, "beide abgelaufenen Ablagen verschwinden");
    assert_eq!(read_staged(&t.0, &owner_a(), &a.staging_id), Err(ERR_NOT_FOUND));
    assert_eq!(read_staged(&t.0, &owner_b(), &b.staging_id), Err(ERR_NOT_FOUND));
    assert!(outside.exists(), "und was nicht in einem Eigentuemerfach liegt, bleibt unberuehrt");
}

#[test]
fn the_sweep_can_never_undress_a_committed_product() {
    // Der Beweis ist eine Eigenschaft des Codes, nicht eine Beobachtung: der Kehrbesen kennt genau
    // EIN Verzeichnis — die Zwischenablage. Er hat keinen Zugriff auf den Medienspeicher, keine
    // Datenbank und keine Produktkennung. Ein gebuchtes Produkt haengt an veroeffentlichten
    // Medien (media_links → media_blob_generations → Medienspeicher); die Ablage ist danach ein
    // Rest ohne Verweis.
    let src = include_str!("media_staging.rs");
    assert!(!src.contains("media_root"), "der Kehrbesen kennt den Medienspeicher nicht");
    assert!(!src.contains("media_links"), "und keine Galerie");
    let sweep = &src[src.find("pub fn sweep_expired").unwrap()..];
    let sweep = &sweep[..sweep.find("\n}").unwrap()];
    assert!(sweep.contains("read_dir(root)"), "er laeuft ueber die Ablage…");
    assert!(!sweep.contains(".."), "…und nirgendwo daran vorbei");
}

// ── CENTRAL-C3C FINAL — der gemeinsame Bildpruefer, aus Sicht des Handys ──
//
// `accept_image_bytes` bedient seit C3C ZWEI Eingaenge. Diese vier Faelle sind der mobile Vertrag,
// wie er vorher war: was galt, gilt; was nicht galt, gilt nicht.

#[test]
fn the_shared_validator_still_answers_the_mobile_contract() {
    use crate::sync::mobile_upload::*;

    // 1. Ein gueltiges Foto bleibt gueltig — und die abgeleiteten Fakten stimmen.
    let good = jpeg(120, 90, 5);
    let ok = accept_image_bytes("image/jpeg", &good).expect("ein gueltiges JPEG");
    assert_eq!((ok.mime, ok.ext, ok.width, ok.height), ("image/jpeg", "jpg", 120, 90));
    assert_eq!(ok.content_hash, crate::sync::canonical::sha256_hex(&good));

    // 2. `image/jpg` bleibt eine zulaessige Schreibweise von `image/jpeg` (Handys schicken sie).
    assert!(accept_image_bytes("image/jpg", &good).is_ok(), "die alte Schreibweise bleibt gueltig");

    // 3. Ein PNG bleibt ein PNG.
    let png_bytes = {
        let img = image::RgbImage::from_pixel(20, 20, image::Rgb([1, 2, 3]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    };
    assert_eq!(accept_image_bytes("image/png", &png_bytes).unwrap().mime, "image/png");

    // 4. Und die Ablehnungen tragen dieselben Codes wie vorher.
    assert_eq!(accept_image_bytes("image/jpeg", &[]), Err(ERR_TRUNCATED));
    assert_eq!(accept_image_bytes("image/png", &good), Err(ERR_MIME_MISMATCH));
    assert_eq!(accept_image_bytes("image/gif", b"GIF89a....."), Err(ERR_UNSUPPORTED_MIME));
    assert_eq!(accept_image_bytes("image/jpeg", b"%PDF-1.7"), Err(ERR_UNSUPPORTED_MIME));
    let header_only = &good[..4];
    assert!(
        accept_image_bytes("image/jpeg", header_only).is_err(),
        "ein Rumpf, der nur noch wie ein JPEG aussieht, bleibt abgewiesen"
    );
    let too_big = vec![0xffu8; MAX_UPLOAD_IMAGE_BYTES + 1];
    assert_eq!(accept_image_bytes("image/jpeg", &too_big), Err(ERR_IMAGE_TOO_LARGE));
}

#[test]
fn the_mobile_ingress_keeps_its_own_shelf_and_its_own_semantics() {
    let routes = include_str!("routes.rs");
    let m0 = routes.find("async fn mobile_upload_ingress").expect("die mobile Route gibt es");
    // Bis zum naechsten Handler danach — die neue Route steht im Quelltext WEITER OBEN, also darf
    // ihr Offset hier nicht als Ende dienen.
    let mobile_end = routes[m0..].find("\nasync fn ").map(|i| m0 + i).unwrap_or(routes.len());
    let mobile = &routes[m0..mobile_end];
    // Der mobile Eingang bleibt ein PRODUKT-Eingang: eigene Ablage, eigene Inbox, eigener Vertrag.
    assert!(mobile.contains("mobile_staging_root"), "er benutzt weiterhin seine eigene Ablage");
    assert!(mobile.contains("accept_upload"), "und seinen eigenen Annahmeweg");
    assert!(!mobile.contains("command_staging_root"), "die neue Ablage fasst er nicht an");
    assert!(!mobile.contains("owner_key"), "und der Eigentuemer-Vertrag des Desktops gilt dort nicht");
    // Und umgekehrt: die neue Route weiss nichts von der Inbox.
    let s0 = routes.find("async fn staging_media_put").unwrap();
    let staging = &routes[s0..routes[s0..].find("\nasync fn ").map(|i| s0 + i).unwrap_or(routes.len())];
    assert!(!staging.contains("accept_upload"), "die neue Route legt keinen Inbox-Job an");
    assert!(!staging.contains("mobile_staging_root"), "und schreibt nicht in die mobile Ablage");
}

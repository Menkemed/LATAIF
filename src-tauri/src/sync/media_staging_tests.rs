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

fn files(root: &Path) -> usize {
    std::fs::read_dir(root).map(|d| d.flatten().count()).unwrap_or(0)
}

#[test]
fn a_staged_image_is_named_by_its_content() {
    let t = tmp();
    let bytes = jpeg(40, 30, 7);
    let blob = stage_image(&t.0, "image/jpeg", &bytes).expect("ein Bild wird angenommen");

    assert_eq!(blob.staging_id, crate::sync::canonical::sha256_hex(&bytes), "die Kennung IST der Inhalt");
    assert!(is_staging_id(&blob.staging_id), "und sie ist 64 Hex-Zeichen");
    assert_eq!(blob.mime, "image/jpeg");
    assert_eq!(blob.bytes, bytes.len());
    assert_eq!(read_staged(&t.0, &blob.staging_id).unwrap(), bytes, "und die Bytes kommen unveraendert zurueck");
}

#[test]
fn the_same_bytes_twice_are_the_same_shelf() {
    let t = tmp();
    let bytes = jpeg(20, 20, 1);
    let a = stage_image(&t.0, "image/jpeg", &bytes).unwrap();
    let b = stage_image(&t.0, "image/jpeg", &bytes).unwrap();
    assert_eq!(a.staging_id, b.staging_id, "derselbe Inhalt, dieselbe Kennung");
    assert_eq!(files(&t.0), 1, "und nur EINE Datei — ein zweites Hochladen legt nichts Neues an");
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
        let err = stage_image(&t.0, "image/jpeg", &bytes).expect_err(name);
        assert!(!err.is_empty(), "{name} wird mit einem Code abgewiesen");
    }
    assert_eq!(files(&t.0), 0, "und nichts davon liegt auf der Platte");
}

#[test]
fn a_lie_about_the_type_is_a_rejection_not_a_correction() {
    let t = tmp();
    let bytes = jpeg(16, 16, 3);
    let err = stage_image(&t.0, "image/png", &bytes).expect_err("PNG behauptet, JPEG geliefert");
    assert_eq!(err, crate::sync::mobile_upload::ERR_MIME_MISMATCH);
    assert_eq!(files(&t.0), 0, "und es wird nichts abgelegt");
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
        assert_eq!(read_staged(&t.0, bad), Err(ERR_BAD_ID), "{bad} wird beim Lesen abgewiesen");
        assert_eq!(discard_staged(&t.0, bad), Err(ERR_BAD_ID), "{bad} wird beim Verwerfen abgewiesen");
    }
}

#[test]
fn a_changed_file_is_not_that_shelf_anymore() {
    let t = tmp();
    let bytes = jpeg(24, 24, 5);
    let blob = stage_image(&t.0, "image/jpeg", &bytes).unwrap();
    // Jemand tauscht den Inhalt unter der Kennung aus.
    std::fs::write(t.0.join(format!("{}.bin", blob.staging_id)), b"anderes").unwrap();
    assert_eq!(
        read_staged(&t.0, &blob.staging_id),
        Err(ERR_NOT_FOUND),
        "was seine Kennung nicht mehr traegt, gibt es nicht"
    );
}

#[test]
fn discarding_twice_is_not_an_error() {
    let t = tmp();
    let blob = stage_image(&t.0, "image/jpeg", &jpeg(12, 12, 2)).unwrap();
    assert_eq!(discard_staged(&t.0, &blob.staging_id), Ok(()));
    assert_eq!(discard_staged(&t.0, &blob.staging_id), Ok(()), "ein Aufraeumen darf zweimal laufen");
    assert_eq!(read_staged(&t.0, &blob.staging_id), Err(ERR_NOT_FOUND));
}

#[test]
fn what_nobody_collects_is_swept() {
    let t = tmp();
    let fresh = stage_image(&t.0, "image/jpeg", &jpeg(16, 16, 9)).unwrap();
    // Eine Datei, die aelter ist als die Frist: der Kehrbesen nimmt sie mit. Modelliert ueber
    // einen Kehrbesen-Lauf mit einer Frist von 0.
    let removed = sweep_expired(&t.0, SystemTime::now() + Duration::from_secs(60), Duration::from_secs(1));
    assert_eq!(removed, 1, "die abgelaufene Ablage verschwindet");
    assert_eq!(read_staged(&t.0, &fresh.staging_id), Err(ERR_NOT_FOUND));

    // Und was frisch ist, bleibt.
    let keep = stage_image(&t.0, "image/jpeg", &jpeg(16, 16, 4)).unwrap();
    assert_eq!(sweep_expired(&t.0, SystemTime::now(), STAGED_TTL), 0, "Frisches bleibt liegen");
    assert!(read_staged(&t.0, &keep.staging_id).is_ok());
}

#[test]
fn the_shelf_has_a_hard_ceiling() {
    let t = tmp();
    // Die Grenze wird hier nicht mit 512 Bildern nachgestellt — es genuegt, dass sie ueberhaupt
    // zaehlt und nicht erst die Platte fragt.
    assert!(MAX_STAGED_FILES > 0 && MAX_STAGED_FILES <= 4096, "eine endliche Obergrenze");
    for i in 0..3u8 {
        stage_image(&t.0, "image/jpeg", &jpeg(8, 8, i)).unwrap();
    }
    assert_eq!(files(&t.0), 3, "drei verschiedene Bilder, drei Ablagen");
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

//! MEDIA-04A-1 — Rust test matrix for the guarded image storage core.
//!
//! Everything runs against a unique per-test temp directory under the OS temp
//! root; no productive path, DB or app is ever touched.

use super::*;
use image::ImageFormat;
use std::io::Cursor;
use std::path::{Path, PathBuf};

// ── fixture helpers ──────────────────────────────────────────────────────────

fn gradient_rgb(w: u32, h: u32) -> image::RgbImage {
    let mut buf = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            buf.push((x % 256) as u8);
            buf.push((y % 256) as u8);
            buf.push(((x + y) % 256) as u8);
        }
    }
    image::RgbImage::from_raw(w, h, buf).unwrap()
}

/// High-entropy noise via a deterministic xorshift PRNG (fixed seed → stable
/// bytes, no wall-clock/`rand` in the fixture so hashes are reproducible).
fn noise_rgb(w: u32, h: u32, seed: u64) -> image::RgbImage {
    let mut s = seed | 1;
    let mut buf = Vec::with_capacity((w * h * 3) as usize);
    for _ in 0..(w * h) {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        buf.push((s & 0xff) as u8);
        buf.push(((s >> 8) & 0xff) as u8);
        buf.push(((s >> 16) & 0xff) as u8);
    }
    image::RgbImage::from_raw(w, h, buf).unwrap()
}

fn encode(img: &image::RgbImage, fmt: ImageFormat) -> Vec<u8> {
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img.clone())
        .write_to(&mut Cursor::new(&mut buf), fmt)
        .unwrap();
    buf
}

fn to_jpeg(img: &image::RgbImage) -> Vec<u8> {
    encode(img, ImageFormat::Jpeg)
}
/// Encode at an explicit JPEG quality (used to prove a fixture is genuinely
/// over-budget before normalization).
fn to_jpeg_q(img: &image::RgbImage, q: u8) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut buf), q);
    enc.encode(
        img.as_raw(),
        img.width(),
        img.height(),
        image::ExtendedColorType::Rgb8,
    )
    .unwrap();
    buf
}
fn to_png(img: &image::RgbImage) -> Vec<u8> {
    encode(img, ImageFormat::Png)
}
fn to_webp(img: &image::RgbImage) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    match image::DynamicImage::ImageRgb8(img.clone())
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::WebP)
    {
        Ok(()) => Some(buf),
        Err(_) => None,
    }
}

const SCOPE: &str = "tenant-1";

struct TempRoot(PathBuf);
impl TempRoot {
    fn new() -> Self {
        let p =
            std::env::temp_dir().join(format!("lataif_media_a1_{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        TempRoot(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}
impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── magic-byte detection ─────────────────────────────────────────────────────

#[test]
fn jpeg_detected_by_bytes() {
    let bytes = to_jpeg(&gradient_rgb(64, 48));
    let ins = inspect_image_bytes(&bytes);
    assert_eq!(ins.kind, ContentKind::RasterImage);
    assert_eq!((ins.width, ins.height), (64, 48));
}

#[test]
fn png_detected_by_bytes() {
    let bytes = to_png(&gradient_rgb(40, 72));
    let ins = inspect_image_bytes(&bytes);
    assert_eq!(ins.kind, ContentKind::RasterImage);
    assert_eq!((ins.width, ins.height), (40, 72));
}

#[test]
fn webp_detected_when_supported() {
    // WebP is optional per the directive: only assert the round-trip when the
    // build can actually produce a WebP fixture.
    if let Some(bytes) = to_webp(&gradient_rgb(48, 48)) {
        let ins = inspect_image_bytes(&bytes);
        assert_eq!(ins.kind, ContentKind::RasterImage);
        let d = normalize_stock_image(&bytes, &Limits::default()).unwrap();
        assert!(image::load_from_memory(&d.bytes).is_ok());
    }
}

#[test]
fn byte_content_is_authoritative_not_extension() {
    // Real JPEG bytes are classified JPEG regardless of any claimed name; real
    // PDF bytes are classified PDF regardless of a ".jpg" name.
    let jpeg = to_jpeg(&gradient_rgb(32, 32));
    assert_eq!(inspect_image_bytes(&jpeg).kind, ContentKind::RasterImage);
    let pdf = b"%PDF-1.4\n1 0 obj<<>>endobj\n".to_vec();
    assert_eq!(inspect_image_bytes(&pdf).kind, ContentKind::Pdf);
}

#[test]
fn pdf_rejected_as_image() {
    let pdf = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let err = normalize_stock_image(&pdf, &Limits::default()).unwrap_err();
    assert_eq!(err.code(), "MEDIA_UNSUPPORTED_CONTENT");
}

#[test]
fn arbitrary_binary_rejected() {
    let junk = vec![0x00u8, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
    let err = normalize_stock_image(&junk, &Limits::default()).unwrap_err();
    assert_eq!(err.code(), "MEDIA_UNSUPPORTED_CONTENT");
}

#[test]
fn corrupt_raster_rejected() {
    // Valid JPEG magic, garbage body → sniffed as JPEG but fails to decode.
    let mut bytes = vec![0xFF, 0xD8, 0xFF];
    bytes.extend_from_slice(&[0x00; 64]);
    let err = normalize_stock_image(&bytes, &Limits::default()).unwrap_err();
    assert_eq!(err.code(), "MEDIA_IMAGE_DECODE_FAILED");
}

// ── input resource limits ────────────────────────────────────────────────────

#[test]
fn excessive_pixels_rejected() {
    let bytes = to_png(&gradient_rgb(50, 50)); // 2500 px
    let limits = Limits {
        max_input_dim: 12_000,
        max_input_pixels: 100,
    };
    let err = normalize_stock_image(&bytes, &limits).unwrap_err();
    assert_eq!(err.code(), "MEDIA_IMAGE_TOO_LARGE");
}

#[test]
fn excessive_dimension_rejected() {
    let bytes = to_png(&gradient_rgb(50, 50));
    let limits = Limits {
        max_input_dim: 10,
        max_input_pixels: 40_000_000,
    };
    let err = normalize_stock_image(&bytes, &limits).unwrap_err();
    assert_eq!(err.code(), "MEDIA_IMAGE_TOO_LARGE");
}

// ── byte budgets ─────────────────────────────────────────────────────────────

#[test]
fn main_image_within_100kb_and_decodable() {
    // Full-entropy noise so the fixture cannot compress away. Prove it is
    // genuinely over-budget at the top of the quality ladder, so a ≤100 KB
    // result can only mean the reduction ladder engaged.
    let src = noise_rgb(1024, 1024, 0xC0FFEE);
    assert!(
        to_jpeg_q(&src, 85).len() > 100_000,
        "fixture is not over-budget; test would be vacuous"
    );
    let bytes = to_png(&src);
    let d = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    assert!(d.byte_size > 0);
    assert!(
        d.byte_size <= 100_000,
        "main byte_size = {} (> 100000)",
        d.byte_size
    );
    assert_eq!(d.byte_size, d.bytes.len());
    assert_eq!(d.content_kind, "raster_image");
    assert_eq!(d.mime_type, "image/jpeg");
    assert_eq!(d.extension, "jpg");
    assert!(d.width.max(d.height) <= 1600);
    // main image remains a valid, decodable JPEG
    assert!(image::load_from_memory(&d.bytes).is_ok());
}

#[test]
fn thumbnail_within_20kb_and_decodable() {
    let bytes = to_png(&noise_rgb(800, 800, 0x1234));
    let t = create_thumbnail(&bytes, &Limits::default()).unwrap();
    assert!(t.byte_size > 0);
    assert!(
        t.byte_size <= 20_000,
        "thumb byte_size = {} (> 20000)",
        t.byte_size
    );
    assert!(t.width.max(t.height) <= 256);
    assert!(image::load_from_memory(&t.bytes).is_ok());
}

#[test]
fn main_and_thumbnail_measured_independently() {
    let bytes = to_jpeg(&gradient_rgb(900, 700));
    let main = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    let thumb = create_thumbnail(&bytes, &Limits::default()).unwrap();
    assert!(main.byte_size <= 100_000);
    assert!(thumb.byte_size <= 20_000);
    // thumbnail is strictly the smaller rendition
    assert!(thumb.width.max(thumb.height) <= main.width.max(main.height));
}

// ── hashing ──────────────────────────────────────────────────────────────────

#[test]
fn sha256_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn descriptor_hash_matches_returned_bytes() {
    let bytes = to_jpeg(&gradient_rgb(300, 200));
    let d = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    assert_eq!(d.hash, sha256_hex(&d.bytes));
    assert_eq!(d.hash.len(), 64);
    assert!(d
        .hash
        .bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
}

#[test]
fn identical_input_yields_identical_hash_and_path() {
    let bytes = to_png(&gradient_rgb(512, 512));
    let a = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    let b = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    assert_eq!(a.hash, b.hash);
    assert_eq!(a.bytes, b.bytes);
    let root = Path::new("Z:/does/not/need/to/exist");
    let pa = derive_storage_path(root, SCOPE, &a.hash, "jpg").unwrap();
    let pb = derive_storage_path(root, SCOPE, &b.hash, "jpg").unwrap();
    assert_eq!(pa, pb);
}

// ── safe storage paths ───────────────────────────────────────────────────────

#[test]
fn storage_path_shape_is_content_addressed() {
    let hash = sha256_hex(b"whatever");
    let root = TempRoot::new();
    let p = derive_storage_path(root.path(), SCOPE, &hash, "jpg").unwrap();
    let expected = root
        .path()
        .join(SCOPE)
        .join(&hash[0..2])
        .join(format!("{hash}.jpg"));
    assert_eq!(p, expected);
    assert!(p.starts_with(root.path()));
}

#[test]
fn path_traversal_rejected() {
    let root = TempRoot::new();
    let hash = sha256_hex(b"x");
    // traversal via scope
    assert_eq!(
        derive_storage_path(root.path(), "../evil", &hash, "jpg")
            .unwrap_err()
            .code(),
        "MEDIA_PATH_OUTSIDE_ROOT"
    );
    // separator inside scope
    assert_eq!(
        derive_storage_path(root.path(), "a/b", &hash, "jpg")
            .unwrap_err()
            .code(),
        "MEDIA_PATH_OUTSIDE_ROOT"
    );
    // raw relative traversal
    assert_eq!(
        resolve_within_root(root.path(), "../../etc/passwd")
            .unwrap_err()
            .code(),
        "MEDIA_PATH_OUTSIDE_ROOT"
    );
    // stays inside for a benign relative path
    assert!(resolve_within_root(root.path(), "a/b/c.jpg")
        .unwrap()
        .starts_with(root.path()));
}

#[test]
fn invalid_hash_and_extension_rejected() {
    let root = TempRoot::new();
    assert_eq!(
        derive_storage_path(root.path(), SCOPE, "NOTHEX", "jpg")
            .unwrap_err()
            .code(),
        "MEDIA_INVALID_HASH"
    );
    // uppercase hex is not allowed (must be lower-case)
    let upper = "A".repeat(64);
    assert_eq!(
        derive_storage_path(root.path(), SCOPE, &upper, "jpg")
            .unwrap_err()
            .code(),
        "MEDIA_INVALID_HASH"
    );
    let hash = sha256_hex(b"x");
    assert_eq!(
        derive_storage_path(root.path(), SCOPE, &hash, "png")
            .unwrap_err()
            .code(),
        "MEDIA_INVALID_EXTENSION"
    );
}

// ── atomic publication + dedup ───────────────────────────────────────────────

#[test]
fn atomic_publish_writes_complete_file() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(200, 200)), &Limits::default()).unwrap();
    let pub1 = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    assert!(!pub1.reused);
    assert!(pub1.path.exists());
    let on_disk = std::fs::read(&pub1.path).unwrap();
    assert_eq!(on_disk, d.bytes);
    assert_eq!(sha256_hex(&on_disk), d.hash);
    // no leftover temp files in the directory
    let dir = pub1.path.parent().unwrap();
    let leftovers: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp files left behind");
}

#[test]
fn second_identical_publish_is_reused() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(210, 190)), &Limits::default()).unwrap();
    let first = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    let second = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    assert!(!first.reused);
    assert!(second.reused);
    assert_eq!(first.path, second.path);
    assert_eq!(std::fs::read(&second.path).unwrap(), d.bytes);
}

#[test]
fn publish_rejects_mismatched_expected_hash() {
    let root = TempRoot::new();
    let bytes = normalize_stock_image(&to_jpeg(&gradient_rgb(120, 120)), &Limits::default())
        .unwrap()
        .bytes;
    let wrong = sha256_hex(b"not the bytes");
    let err = publish_atomically(root.path(), SCOPE, &bytes, &wrong, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH");
}

#[test]
fn publish_rejects_foreign_bytes_at_hash_path() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(150, 150)), &Limits::default()).unwrap();
    // plant a foreign file at the expected hash path
    let path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, b"totally different content").unwrap();
    let err = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH");
}

// ── verified read ────────────────────────────────────────────────────────────

#[test]
fn read_verified_round_trips() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(256, 256)), &Limits::default()).unwrap();
    publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    let got = read_verified_media(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    assert_eq!(got, d.bytes);
}

#[test]
fn read_missing_file_reports_missing() {
    let root = TempRoot::new();
    let hash = sha256_hex(b"never stored");
    let err = read_verified_media(root.path(), SCOPE, &hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_MISSING");
}

#[test]
fn read_tampered_file_reports_hash_mismatch() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(180, 220)), &Limits::default()).unwrap();
    let pubd = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    // tamper with the stored bytes
    std::fs::write(&pubd.path, b"tampered").unwrap();
    let err = read_verified_media(root.path(), SCOPE, &d.hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH");
}

#[test]
fn read_outside_root_rejected() {
    let root = TempRoot::new();
    let hash = sha256_hex(b"x");
    let err = read_verified_media(root.path(), "../escape", &hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_PATH_OUTSIDE_ROOT");
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-1-R1 additions
// ════════════════════════════════════════════════════════════════════════════

// ── reparse/symlink containment ──────────────────────────────────────────────

#[cfg(windows)]
fn make_reparse_dir(link: &Path, target: &Path) -> bool {
    // Directory junctions need no elevated privilege on NTFS.
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn make_reparse_dir(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[test]
fn publish_and_read_reject_reparse_in_tenant_path() {
    let root = TempRoot::new();
    let external = TempRoot::new(); // lives OUTSIDE the media root
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(64, 64)), &Limits::default()).unwrap();
    let tenant_link = root.path().join("evil");
    if !make_reparse_dir(&tenant_link, external.path()) {
        // Documented platform path: this host cannot create a reparse point
        // without extra privileges. The containment code is still compiled and
        // the lexical-traversal tests still exercise path rejection.
        eprintln!("skip: reparse point could not be created on this platform/host");
        return;
    }
    // publish under a scope whose tenant directory is a reparse point → rejected
    let perr = publish_atomically(root.path(), "evil", &d.bytes, &d.hash, "jpg").unwrap_err();
    assert_eq!(perr.code(), "MEDIA_PATH_REPARSE_POINT_FORBIDDEN");
    // nothing was written through the link into the external directory
    let external_prefix = external.path().join(&d.hash[0..2]);
    assert!(
        !external_prefix.exists(),
        "a file was written through the reparse point"
    );
    // read under the same scope → rejected too
    let rerr = read_verified_media(root.path(), "evil", &d.hash, "jpg").unwrap_err();
    assert_eq!(rerr.code(), "MEDIA_PATH_REPARSE_POINT_FORBIDDEN");

    // a plain real subfolder still works
    let ok = publish_atomically(root.path(), "tenant-1", &d.bytes, &d.hash, "jpg").unwrap();
    assert!(!ok.reused);
    assert_eq!(
        read_verified_media(root.path(), "tenant-1", &d.hash, "jpg").unwrap(),
        d.bytes
    );
}

// ── concurrent publication ───────────────────────────────────────────────────

#[test]
fn concurrent_identical_publish_dedups() {
    use std::sync::Arc;
    use std::thread;

    let root = Arc::new(TempRoot::new());
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(220, 180)), &Limits::default()).unwrap();
    let bytes = Arc::new(d.bytes.clone());
    let hash = Arc::new(d.hash.clone());

    let mut handles = Vec::new();
    for _ in 0..20 {
        let root = Arc::clone(&root);
        let bytes = Arc::clone(&bytes);
        let hash = Arc::clone(&hash);
        handles.push(thread::spawn(move || {
            publish_atomically(root.path(), SCOPE, &bytes, &hash, "jpg").map(|p| p.reused)
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(
        results.iter().all(|r| r.is_ok()),
        "a concurrent publish failed: {results:?}"
    );

    let final_path = derive_storage_path(root.path(), SCOPE, &hash, "jpg").unwrap();
    assert!(final_path.exists());
    assert_eq!(sha256_hex(&std::fs::read(&final_path).unwrap()), *hash);

    let dir = final_path.parent().unwrap();
    let names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|n| !n.ends_with(".tmp")),
        "temp files left behind under concurrency: {names:?}"
    );
    let jpgs = names.iter().filter(|n| n.ends_with(".jpg")).count();
    assert_eq!(jpgs, 1, "expected exactly one final file, saw {names:?}");
}

#[test]
fn concurrent_wrong_winner_rejected_without_overwrite() {
    // Models the race outcome: the winner has already placed a *foreign*
    // (wrong-bytes) file at the hash path; the losing publisher must reject and
    // must not overwrite it.
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(140, 160)), &Limits::default()).unwrap();
    let path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let foreign = b"foreign winner bytes".to_vec();
    std::fs::write(&path, &foreign).unwrap();

    let err = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_HASH_MISMATCH");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        foreign,
        "the foreign winner was overwritten"
    );
    let dir = path.parent().unwrap();
    let tmp_left = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
    assert!(!tmp_left, "temp file left behind after rejected publish");
}

// ── EXIF orientation (behavioural) ───────────────────────────────────────────

/// Little-endian TIFF/EXIF APP1 segment carrying a single Orientation tag.
fn app1_exif_orientation(orientation: u8) -> Vec<u8> {
    let tiff: [u8; 26] = [
        0x49,
        0x49,
        0x2A,
        0x00,
        0x08,
        0x00,
        0x00,
        0x00, // "II", magic 42, IFD0 @ offset 8
        0x01,
        0x00, // entry count = 1
        0x12,
        0x01,
        0x03,
        0x00,
        0x01,
        0x00,
        0x00,
        0x00, // tag 0x0112 (Orientation), SHORT, count 1
        orientation,
        0x00,
        0x00,
        0x00, // value in low 2 bytes
        0x00,
        0x00,
        0x00,
        0x00, // next IFD = 0
    ];
    let mut payload = Vec::new();
    payload.extend_from_slice(b"Exif\0\0");
    payload.extend_from_slice(&tiff);
    let len = (payload.len() + 2) as u16;
    let mut app1 = vec![0xFF, 0xE1, (len >> 8) as u8, (len & 0xff) as u8];
    app1.extend_from_slice(&payload);
    app1
}

fn com_segment(comment: &[u8]) -> Vec<u8> {
    let len = (comment.len() + 2) as u16;
    let mut seg = vec![0xFF, 0xFE, (len >> 8) as u8, (len & 0xff) as u8];
    seg.extend_from_slice(comment);
    seg
}

/// Splice extra marker segments in right after the SOI (FFD8).
fn splice_after_soi(base: &[u8], segments: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&base[0..2]);
    for s in segments {
        out.extend_from_slice(s);
    }
    out.extend_from_slice(&base[2..]);
    out
}

fn jpeg_with_exif_orientation(img: &image::RgbImage, orientation: u8) -> Vec<u8> {
    splice_after_soi(&to_jpeg(img), &[app1_exif_orientation(orientation)])
}

/// Two solid horizontal bands: `top` colour on the upper half, `bottom` on the lower.
fn two_band_top_bottom(w: u32, h: u32, top: [u8; 3], bottom: [u8; 3]) -> image::RgbImage {
    let mut img = image::RgbImage::new(w, h);
    for y in 0..h {
        let c = if y < h / 2 { top } else { bottom };
        for x in 0..w {
            img.put_pixel(x, y, image::Rgb(c));
        }
    }
    img
}

/// Average RGB of a small window centred at fractional position (fx, fy).
fn avg_region(img: &image::RgbImage, fx: f32, fy: f32) -> [u32; 3] {
    let (w, h) = img.dimensions();
    let cx = (fx * w as f32) as i32;
    let cy = (fy * h as f32) as i32;
    let (mut acc, mut n) = ([0u32; 3], 0u32);
    for dy in -5i32..=5 {
        for dx in -5i32..=5 {
            let (x, y) = (cx + dx, cy + dy);
            if x >= 0 && y >= 0 && (x as u32) < w && (y as u32) < h {
                let p = img.get_pixel(x as u32, y as u32);
                acc[0] += p[0] as u32;
                acc[1] += p[1] as u32;
                acc[2] += p[2] as u32;
                n += 1;
            }
        }
    }
    [acc[0] / n, acc[1] / n, acc[2] / n]
}

fn is_reddish(c: [u32; 3]) -> bool {
    c[0] > c[1] + 30 && c[0] > c[2] + 30
}
fn is_bluish(c: [u32; 3]) -> bool {
    c[2] > c[0] + 30 && c[2] > c[1] + 30
}

#[test]
fn exif_orientation_6_rotates_90_clockwise() {
    // Portrait 200×300, top half red, bottom half blue.
    let src = two_band_top_bottom(200, 300, [220, 40, 40], [40, 40, 220]);
    let jpeg = jpeg_with_exif_orientation(&src, 6);
    let d = normalize_stock_image(&jpeg, &Limits::default()).unwrap();
    // Orientation 6 = rotate 90° CW → dimensions swap to landscape 300×200.
    assert_eq!(
        (d.width, d.height),
        (300, 200),
        "orientation 6 must produce a 90°-rotated 3×2 image"
    );
    let out = image::load_from_memory(&d.bytes).unwrap().to_rgb8();
    // After 90° CW: source-top(red) → output RIGHT, source-bottom(blue) → output LEFT.
    let left = avg_region(&out, 0.15, 0.5);
    let right = avg_region(&out, 0.85, 0.5);
    assert!(is_bluish(left), "left region should be blue, got {left:?}");
    assert!(
        is_reddish(right),
        "right region should be red, got {right:?}"
    );
}

#[test]
fn exif_orientation_1_no_rotation() {
    let src = two_band_top_bottom(200, 300, [220, 40, 40], [40, 40, 220]);
    let jpeg = jpeg_with_exif_orientation(&src, 1);
    let d = normalize_stock_image(&jpeg, &Limits::default()).unwrap();
    // Orientation 1 = no transform → portrait dimensions preserved.
    assert_eq!((d.width, d.height), (200, 300));
    let out = image::load_from_memory(&d.bytes).unwrap().to_rgb8();
    let top = avg_region(&out, 0.5, 0.15);
    let bottom = avg_region(&out, 0.5, 0.85);
    assert!(is_reddish(top), "top region should be red, got {top:?}");
    assert!(
        is_bluish(bottom),
        "bottom region should be blue, got {bottom:?}"
    );
}

// ── metadata stripping ───────────────────────────────────────────────────────

/// Which JPEG marker bytes appear before the start-of-scan (SOS).
fn markers_before_sos(jpeg: &[u8]) -> Vec<u8> {
    let mut i = 2usize;
    let mut found = Vec::new();
    while i + 1 < jpeg.len() {
        if jpeg[i] != 0xFF {
            break;
        }
        let m = jpeg[i + 1];
        if m == 0xDA || m == 0xD9 {
            break; // SOS or EOI
        }
        found.push(m);
        // standalone markers carry no length payload
        if (0xD0..=0xD7).contains(&m) || m == 0x01 {
            i += 2;
            continue;
        }
        if i + 3 >= jpeg.len() {
            break;
        }
        let len = ((jpeg[i + 2] as usize) << 8) | (jpeg[i + 3] as usize);
        i += 2 + len;
    }
    found
}

fn contains_subslice(hay: &[u8], needle: &[u8]) -> bool {
    needle.len() <= hay.len() && hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn metadata_stripped_from_output() {
    let src = gradient_rgb(120, 90);
    let jpeg = splice_after_soi(
        &to_jpeg(&src),
        &[
            app1_exif_orientation(1),
            com_segment(b"LATAIF-SECRET-COMMENT"),
        ],
    );
    // The fixture genuinely carries EXIF (APP1) and a COM marker.
    let in_markers = markers_before_sos(&jpeg);
    assert!(in_markers.contains(&0xE1), "fixture must carry EXIF/APP1");
    assert!(
        in_markers.contains(&0xFE),
        "fixture must carry a COM marker"
    );
    assert!(contains_subslice(&jpeg, b"Exif"));
    assert!(contains_subslice(&jpeg, b"LATAIF-SECRET-COMMENT"));

    let d = normalize_stock_image(&jpeg, &Limits::default()).unwrap();

    // Output is still a decodable image with the real content dimensions.
    let out = image::load_from_memory(&d.bytes).unwrap();
    assert_eq!((out.width(), out.height()), (120, 90));

    // The metadata segments are gone.
    let out_markers = markers_before_sos(&d.bytes);
    assert!(
        !out_markers.contains(&0xE1),
        "EXIF/APP1 survived re-encode: {out_markers:?}"
    );
    assert!(
        !out_markers.contains(&0xFE),
        "COM survived re-encode: {out_markers:?}"
    );
    assert!(
        !contains_subslice(&d.bytes, b"Exif"),
        "raw Exif tag survived"
    );
    assert!(
        !contains_subslice(&d.bytes, b"LATAIF-SECRET-COMMENT"),
        "comment payload survived"
    );
}

// ── no unintended upscaling ──────────────────────────────────────────────────

#[test]
fn small_image_not_upscaled() {
    // 100×80 is well below both the main (1600) and thumbnail (256) targets.
    let bytes = to_png(&gradient_rgb(100, 80));
    let main = normalize_stock_image(&bytes, &Limits::default()).unwrap();
    assert_eq!(
        (main.width, main.height),
        (100, 80),
        "main image was upscaled"
    );
    let thumb = create_thumbnail(&bytes, &Limits::default()).unwrap();
    assert_eq!(
        (thumb.width, thumb.height),
        (100, 80),
        "thumbnail was upscaled"
    );
}

// ── read resource limit ──────────────────────────────────────────────────────

#[test]
fn read_rejects_oversized_stored_file() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(64, 64)), &Limits::default()).unwrap();
    let path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // plant an implausibly large file (150 KB > 100 KB) at the hash path
    std::fs::write(&path, vec![0u8; 150_000]).unwrap();
    let err = read_verified_media(root.path(), SCOPE, &d.hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_TOO_LARGE");
}

#[test]
fn publish_rejects_oversized_existing_file() {
    let root = TempRoot::new();
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(70, 70)), &Limits::default()).unwrap();
    let path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, vec![7u8; 200_000]).unwrap();
    let err = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap_err();
    assert_eq!(err.code(), "MEDIA_FILE_TOO_LARGE");
}

// ════════════════════════════════════════════════════════════════════════════
// MEDIA-04A-1-R2 — deterministic no-clobber race proofs
// ════════════════════════════════════════════════════════════════════════════

fn assert_no_tmp(dir: &Path) {
    let leftover = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"));
    assert!(!leftover, "temp file left behind in {dir:?}");
}

/// §5 — a *correct* winner appears in the race window (after our temp is synced,
/// before we publish). We must not overwrite it; we must verify and reuse it.
#[test]
fn no_clobber_correct_winner_in_race_window() {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    let root = Arc::new(TempRoot::new());
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(160, 120)), &Limits::default()).unwrap();

    let (tx_a_at_gate, rx_a_at_gate) = mpsc::channel::<()>();
    let (tx_b_done, rx_b_done) = mpsc::channel::<()>();

    let a_root = Arc::clone(&root);
    let a_bytes = d.bytes.clone();
    let a_hash = d.hash.clone();
    let a = thread::spawn(move || {
        super::storage::publish_with_barrier(a_root.path(), SCOPE, &a_bytes, &a_hash, "jpg", || {
            // A: temp fully written+synced, parked immediately before publish.
            tx_a_at_gate.send(()).unwrap();
            rx_b_done.recv().unwrap();
        })
    });

    // Wait until A is parked, then let B publish the correct bytes and win.
    rx_a_at_gate.recv().unwrap();
    let b = publish_atomically(root.path(), SCOPE, &d.bytes, &d.hash, "jpg").unwrap();
    assert!(!b.reused, "B should be the actual publisher");
    tx_b_done.send(()).unwrap();

    let a_res = a.join().unwrap().unwrap();
    assert!(a_res.reused, "A must reuse B's file, never overwrite it");

    let final_path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    let on_disk = std::fs::read(&final_path).unwrap();
    assert_eq!(on_disk, d.bytes, "final bytes are not exactly correct");
    assert_eq!(sha256_hex(&on_disk), d.hash);
    assert_no_tmp(final_path.parent().unwrap());
}

/// §6 — a *wrong* winner (foreign bytes) appears in the race window. We must not
/// overwrite it, must report a hash mismatch, and must leave it byte-identical.
#[test]
fn no_clobber_wrong_winner_in_race_window() {
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;

    let root = Arc::new(TempRoot::new());
    let d = normalize_stock_image(&to_jpeg(&gradient_rgb(150, 130)), &Limits::default()).unwrap();

    let (tx_a_at_gate, rx_a_at_gate) = mpsc::channel::<()>();
    let (tx_b_done, rx_b_done) = mpsc::channel::<()>();

    let a_root = Arc::clone(&root);
    let a_bytes = d.bytes.clone();
    let a_hash = d.hash.clone();
    let a = thread::spawn(move || {
        super::storage::publish_with_barrier(a_root.path(), SCOPE, &a_bytes, &a_hash, "jpg", || {
            tx_a_at_gate.send(()).unwrap();
            rx_b_done.recv().unwrap();
        })
    });

    rx_a_at_gate.recv().unwrap();
    // Plant FOREIGN bytes at the exact hash path inside A's race window.
    let path = derive_storage_path(root.path(), SCOPE, &d.hash, "jpg").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let foreign = b"foreign winner in the race window".to_vec();
    std::fs::write(&path, &foreign).unwrap();
    tx_b_done.send(()).unwrap();

    let a_res = a.join().unwrap();
    assert_eq!(
        a_res.unwrap_err().code(),
        "MEDIA_FILE_HASH_MISMATCH",
        "A must reject a foreign winner"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        foreign,
        "foreign winner bytes were replaced"
    );
    assert_no_tmp(path.parent().unwrap());
}

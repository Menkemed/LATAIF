//! MEDIA-04A-1 — decode, normalize and re-encode a stock image into a durable,
//! size-bounded JPEG (plus an independently bounded thumbnail).
//!
//! The persistent output is *always* JPEG. Re-encoding is what makes the byte
//! budget deterministic and also strips any embedded metadata (EXIF/ICC/etc.)
//! from the stored file.

use super::detect::{sniff_kind, Kind};
use super::storage::sha256_hex;
use super::{ContentKind, Inspection, Limits, MediaDescriptor, MediaError};
use image::ImageDecoder; // brings the `orientation()` trait method into scope
use std::io::Cursor;

// ── Encoding budgets ─────────────────────────────────────────────────────────
const MAIN_MAX_BYTES: usize = 100_000;
const MAIN_MAX_DIM: u32 = 1600;
const MAIN_MIN_DIM: u32 = 320;

const THUMB_MAX_BYTES: usize = 20_000;
const THUMB_MAX_DIM: u32 = 256;
const THUMB_MIN_DIM: u32 = 96;

/// Descending JPEG quality ladder tried at each candidate dimension.
const QUALITY_LADDER: [u8; 7] = [85, 78, 70, 62, 55, 48, 40];

/// Classify raw bytes and, for raster images, report their header dimensions.
pub fn inspect_image_bytes(bytes: &[u8]) -> Inspection {
    let kind = match sniff_kind(bytes) {
        Kind::Jpeg | Kind::Png | Kind::Webp => ContentKind::RasterImage,
        Kind::Pdf => ContentKind::Pdf,
        Kind::Other => ContentKind::Other,
    };
    let (width, height) = if kind == ContentKind::RasterImage {
        header_dimensions(bytes).unwrap_or((0, 0))
    } else {
        (0, 0)
    };
    Inspection {
        kind,
        width,
        height,
    }
}

/// Read image dimensions from the header only (no full decode) — used as the
/// first line of defence against decode bombs.
fn header_dimensions(bytes: &[u8]) -> Result<(u32, u32), MediaError> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| MediaError::ImageDecodeFailed)?;
    reader
        .into_dimensions()
        .map_err(|_| MediaError::ImageDecodeFailed)
}

/// Fully decode, applying EXIF orientation where the decoder exposes it.
fn decode_with_orientation(bytes: &[u8]) -> Result<image::DynamicImage, MediaError> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| MediaError::ImageDecodeFailed)?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|_| MediaError::ImageDecodeFailed)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img =
        image::DynamicImage::from_decoder(decoder).map_err(|_| MediaError::ImageDecodeFailed)?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// Composite any alpha channel over an opaque white background and return RGB8.
/// This normalizes to a reliable colour space for JPEG (which has no alpha).
fn flatten_to_rgb(img: &image::DynamicImage) -> image::RgbImage {
    if img.color().has_alpha() {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let mut out = image::RgbImage::new(w, h);
        for (x, y, px) in rgba.enumerate_pixels() {
            let a = px[3] as u32;
            let inv = 255 - a;
            // over white: c*a/255 + 255*(255-a)/255
            let r = (px[0] as u32 * a + 255 * inv) / 255;
            let g = (px[1] as u32 * a + 255 * inv) / 255;
            let b = (px[2] as u32 * a + 255 * inv) / 255;
            out.put_pixel(x, y, image::Rgb([r as u8, g as u8, b as u8]));
        }
        out
    } else {
        img.to_rgb8()
    }
}

/// Sniff → reject non-raster → header dimension/pixel guard → decode → orient →
/// flatten to RGB8. Shared by both the main image and the thumbnail so each is
/// derived from the same normalized source.
fn decode_normalized(bytes: &[u8], limits: &Limits) -> Result<image::RgbImage, MediaError> {
    match sniff_kind(bytes) {
        Kind::Jpeg | Kind::Png | Kind::Webp => {}
        Kind::Pdf | Kind::Other => return Err(MediaError::UnsupportedContent),
    }
    let (w, h) = header_dimensions(bytes)?;
    if w == 0 || h == 0 {
        return Err(MediaError::ImageDecodeFailed);
    }
    if w > limits.max_input_dim
        || h > limits.max_input_dim
        || (w as u64) * (h as u64) > limits.max_input_pixels
    {
        return Err(MediaError::ImageTooLarge);
    }
    let dynimg = decode_with_orientation(bytes)?;
    Ok(flatten_to_rgb(&dynimg))
}

/// Encode `rgb` to JPEG at `quality`.
fn encode_jpeg(rgb: &image::RgbImage, quality: u8) -> Result<Vec<u8>, MediaError> {
    let mut buf = Vec::new();
    let mut enc =
        image::codecs::jpeg::JpegEncoder::new_with_quality(Cursor::new(&mut buf), quality);
    enc.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|_| MediaError::ImageDecodeFailed)?;
    Ok(buf)
}

/// Downscale so the longest side is at most `dim` (never upscales).
fn downscale_longest(src: &image::RgbImage, dim: u32) -> image::RgbImage {
    let (w, h) = src.dimensions();
    if w.max(h) <= dim {
        return src.clone();
    }
    image::DynamicImage::ImageRgb8(src.clone())
        .resize(dim, dim, image::imageops::FilterType::Lanczos3)
        .to_rgb8()
}

/// Deterministically encode `src` to a JPEG that is at most `max_bytes`.
/// Strategy: at each candidate dimension (starting at `max_dim`), walk the
/// quality ladder; if even the lowest quality overshoots, shrink by 15% and
/// retry, until the floor `min_dim` is reached. Below the floor we refuse rather
/// than store a useless image.
fn encode_within_budget(
    src: &image::RgbImage,
    max_dim: u32,
    min_dim: u32,
    max_bytes: usize,
) -> Result<(Vec<u8>, u32, u32), MediaError> {
    let mut dim = max_dim;
    loop {
        let scaled = downscale_longest(src, dim);
        for &q in QUALITY_LADDER.iter() {
            let bytes = encode_jpeg(&scaled, q)?;
            if bytes.len() <= max_bytes {
                return Ok((bytes, scaled.width(), scaled.height()));
            }
        }
        let next = dim * 85 / 100;
        if next < min_dim {
            return Err(MediaError::ImageDetailInsufficient);
        }
        dim = next;
    }
}

/// Build a `MediaDescriptor` from final JPEG bytes.
fn descriptor(bytes: Vec<u8>, width: u32, height: u32) -> MediaDescriptor {
    let hash = sha256_hex(&bytes);
    MediaDescriptor {
        byte_size: bytes.len(),
        bytes,
        hash,
        extension: "jpg".to_string(),
        content_kind: "raster_image".to_string(),
        mime_type: "image/jpeg".to_string(),
        width,
        height,
    }
}

/// Produce the durable main raster (`byte_size <= 100_000`, guaranteed).
pub fn normalize_stock_image(bytes: &[u8], limits: &Limits) -> Result<MediaDescriptor, MediaError> {
    let rgb = decode_normalized(bytes, limits)?;
    let (out, w, h) = encode_within_budget(&rgb, MAIN_MAX_DIM, MAIN_MIN_DIM, MAIN_MAX_BYTES)?;
    debug_assert!(out.len() <= MAIN_MAX_BYTES);
    Ok(descriptor(out, w, h))
}

/// Produce the durable thumbnail (`byte_size <= 20_000`, guaranteed),
/// measured and validated independently of the main image.
pub fn create_thumbnail(bytes: &[u8], limits: &Limits) -> Result<MediaDescriptor, MediaError> {
    let rgb = decode_normalized(bytes, limits)?;
    let (out, w, h) = encode_within_budget(&rgb, THUMB_MAX_DIM, THUMB_MIN_DIM, THUMB_MAX_BYTES)?;
    debug_assert!(out.len() <= THUMB_MAX_BYTES);
    Ok(descriptor(out, w, h))
}

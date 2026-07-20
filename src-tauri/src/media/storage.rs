//! MEDIA-04A-1 — content-addressed, root-confined, atomic file storage.
//!
//! All persistence is keyed by the SHA-256 of the *final* stored bytes. The
//! service never accepts a free-form destination path from a caller: it is given
//! only a validated tenant scope, a 64-hex hash and a fixed extension, from which
//! the physical path is derived and proven to stay under the injected media root.
//!
//! Containment is enforced on two levels: the derived path is *lexically* clean
//! (no `..`, absolute prefix or separators in the scope/hash), and — before any
//! read or write — every existing path component under the canonicalized root is
//! checked to not be a symlink/junction/reparse point that could redirect the
//! operation outside the root.

use super::MediaError;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// The largest stored raster this writer can ever produce (the main-image
/// budget). Any file at a hash path exceeding this is refused *before* being
/// read into memory — it cannot have been written by us, so reading it would
/// only risk unbounded allocation on a planted file.
const MAX_STORED_BYTES: u64 = 100_000;

/// Outcome of an atomic publication.
#[derive(Debug, Clone)]
pub struct Published {
    pub path: PathBuf,
    pub hash: String,
    pub byte_size: usize,
    /// `true` when an identical, hash-verified file already existed and was reused.
    pub reused: bool,
}

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        // two lower-case hex nibbles per byte
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap());
    }
    out
}

/// A tenant scope must be a single safe path segment (no separators, no `..`).
pub(crate) fn is_valid_scope(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= 64
        && scope
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// A content hash must be exactly 64 lower-case hex characters.
fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// Join `untrusted_rel` onto `root`, proving the result cannot escape `root`.
/// Any `..`, absolute prefix or root component is rejected as a traversal.
/// Purely lexical — does not touch the filesystem.
pub fn resolve_within_root(root: &Path, untrusted_rel: &str) -> Result<PathBuf, MediaError> {
    if untrusted_rel.is_empty() || untrusted_rel.contains("..") {
        return Err(MediaError::PathOutsideRoot);
    }
    let candidate = Path::new(untrusted_rel);
    if candidate.is_absolute() {
        return Err(MediaError::PathOutsideRoot);
    }
    let mut out = root.to_path_buf();
    for comp in candidate.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(MediaError::PathOutsideRoot);
            }
        }
    }
    Ok(out)
}

/// Derive the physical storage path for a content hash under the media root:
/// `<root>/<tenant_scope>/<hash[0..2]>/<hash>.<ext>`. Purely lexical.
pub fn derive_storage_path(
    root: &Path,
    tenant_scope: &str,
    hash: &str,
    ext: &str,
) -> Result<PathBuf, MediaError> {
    if !is_valid_scope(tenant_scope) {
        return Err(MediaError::PathOutsideRoot);
    }
    if !is_valid_hash(hash) {
        return Err(MediaError::InvalidHash);
    }
    if ext != "jpg" {
        return Err(MediaError::InvalidExtension);
    }
    let rel = format!("{tenant_scope}/{}/{hash}.{ext}", &hash[0..2]);
    resolve_within_root(root, &rel)
}

/// A path-free, non-leaking rendering of an IO error (kind only).
fn safe_io(err: &std::io::Error) -> String {
    format!("io:{:?}", err.kind())
}

/// Random 16-hex temp suffix. Uses `rand` (already a direct dependency) so the
/// code stays free of wall-clock/`Date` calls.
fn temp_suffix() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// Is this metadata a symlink, junction, or any other reparse point? Junctions
/// on Windows are *not* reported by `is_symlink()`, so the reparse attribute is
/// checked explicitly there.
fn is_reparse_or_symlink(md: &fs::Metadata) -> bool {
    if md.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if md.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// Canonicalize the (existing) media root to a real, link-free base path. The
/// root itself is trusted/injected, so resolving it is intentional; everything
/// *below* it is then checked component-by-component.
fn canonical_root_existing(root: &Path) -> Result<PathBuf, MediaError> {
    match fs::canonicalize(root) {
        Ok(p) => Ok(p),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(MediaError::FileMissing),
        Err(e) => Err(MediaError::Io(safe_io(&e))),
    }
}

/// Create the media root if missing and return its canonical, link-free path.
/// Shared by the ingest layer so journal/temp paths use the same trusted base.
pub(crate) fn ensure_root_canonical(root: &Path) -> Result<PathBuf, MediaError> {
    fs::create_dir_all(root).map_err(|e| MediaError::Io(safe_io(&e)))?;
    canonical_root_existing(root)
}

/// Walk every component of `target` below `canon_root`; if any *existing*
/// component (a tenant dir, hash-prefix dir, or the file itself) is a
/// symlink/junction/reparse point, refuse the operation. Non-existent
/// components are fine — they will be created as real directories.
pub(crate) fn assert_no_reparse_under_root(
    canon_root: &Path,
    target: &Path,
) -> Result<(), MediaError> {
    let rel = target
        .strip_prefix(canon_root)
        .map_err(|_| MediaError::PathOutsideRoot)?;
    let mut cur = canon_root.to_path_buf();
    for comp in rel.components() {
        match comp {
            Component::Normal(seg) => {
                cur.push(seg);
                match fs::symlink_metadata(&cur) {
                    Ok(md) => {
                        if is_reparse_or_symlink(&md) {
                            return Err(MediaError::PathReparsePointForbidden);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(MediaError::Io(safe_io(&e))),
                }
            }
            // rel is derived from a validated path, so anything else is a bug/attack.
            _ => return Err(MediaError::PathOutsideRoot),
        }
    }
    Ok(())
}

/// Inspect an existing file at `path` for reuse: `Ok(Some(size))` when it exists
/// and hashes to `expected_hash`, `Ok(None)` when absent, and an error when it
/// is oversized (refused before reading) or its bytes do not match.
fn reuse_if_matches(path: &Path, expected_hash: &str) -> Result<Option<usize>, MediaError> {
    match fs::metadata(path) {
        Ok(md) => {
            if md.len() > MAX_STORED_BYTES {
                return Err(MediaError::FileTooLarge);
            }
            let existing = fs::read(path).map_err(|e| MediaError::Io(safe_io(&e)))?;
            if sha256_hex(&existing) == expected_hash {
                Ok(Some(existing.len()))
            } else {
                Err(MediaError::FileHashMismatch)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(MediaError::Io(safe_io(&e))),
    }
}

/// Publish `bytes` at the content-addressed path with a **no-clobber** guarantee.
///
/// The guarantee does not depend on a prior `exists()` check: the publication
/// step itself is *create-if-absent*. We write a fully-synced temp file in the
/// same directory and then create the final path as an atomic **hard link** to
/// it. `hard_link` fails with [`std::io::ErrorKind::AlreadyExists`] if the final
/// path already exists — on POSIX because `link(2)` returns `EEXIST`, on Windows
/// because `CreateHardLinkW` returns `ERROR_ALREADY_EXISTS`; Rust maps both to
/// the same kind. An already-published target is therefore *never* overwritten.
///
/// Contract:
/// * `expected_hash` must equal `sha256(bytes)` (defensive re-check).
/// * root canonicalized, every component proven reparse-free before any write.
/// * final path absent → linked into place, temp removed → `reused: false`.
/// * final path already present → target left byte-for-byte untouched, then its
///   bytes are hash-verified: identical → reuse (`reused: true`), oversized →
///   [`MediaError::FileTooLarge`], different → [`MediaError::FileHashMismatch`].
///   The temp is removed on every outcome.
pub fn publish_atomically(
    root: &Path,
    tenant_scope: &str,
    bytes: &[u8],
    expected_hash: &str,
    ext: &str,
) -> Result<Published, MediaError> {
    publish_impl(root, tenant_scope, bytes, expected_hash, ext, || {})
}

/// Shared implementation. `before_publish` runs exactly once, after the temp
/// file is fully written+synced and immediately before the no-clobber link. In
/// production it is a no-op; tests inject a barrier to deterministically drive
/// the race window. It is not part of the public API.
fn publish_impl<F: FnOnce()>(
    root: &Path,
    tenant_scope: &str,
    bytes: &[u8],
    expected_hash: &str,
    ext: &str,
    before_publish: F,
) -> Result<Published, MediaError> {
    if sha256_hex(bytes) != expected_hash {
        return Err(MediaError::FileHashMismatch);
    }
    fs::create_dir_all(root).map_err(|e| MediaError::Io(safe_io(&e)))?;
    let canon_root = canonical_root_existing(root)?;
    let final_path = derive_storage_path(&canon_root, tenant_scope, expected_hash, ext)?;
    assert_no_reparse_under_root(&canon_root, &final_path)?;

    let dir = final_path
        .parent()
        .ok_or(MediaError::PathOutsideRoot)?
        .to_path_buf();
    fs::create_dir_all(&dir).map_err(|e| MediaError::Io(safe_io(&e)))?;

    let tmp = dir.join(format!(".{expected_hash}.{}.tmp", temp_suffix()));
    {
        let mut f = File::create(&tmp).map_err(|e| MediaError::Io(safe_io(&e)))?;
        f.write_all(bytes)
            .map_err(|e| MediaError::Io(safe_io(&e)))?;
        f.flush().map_err(|e| MediaError::Io(safe_io(&e)))?;
        f.sync_all().map_err(|e| MediaError::Io(safe_io(&e)))?;
    }

    // Race window: a competing publisher may create the final path here.
    before_publish();

    // No-clobber publication: create the final path as a hard link to the temp.
    // This fails (never overwrites) if the final path already exists.
    match fs::hard_link(&tmp, &final_path) {
        Ok(()) => {
            let _ = fs::remove_file(&tmp);
            // Best-effort durability of the directory entry. Opening a directory
            // as a file is not supported on every platform (e.g. Windows).
            let _ = File::open(&dir).and_then(|d| d.sync_all());
            Ok(Published {
                path: final_path,
                hash: expected_hash.to_string(),
                byte_size: bytes.len(),
                reused: false,
            })
        }
        Err(e) => {
            // On any failure our temp is cleaned up. A collision (the final path
            // already exists) is the expected dedup/race outcome: verify the
            // winner and reuse if it matches, never overwriting it.
            let _ = fs::remove_file(&tmp);
            if is_already_exists(&e) {
                match reuse_if_matches(&final_path, expected_hash)? {
                    Some(size) => Ok(Published {
                        path: final_path,
                        hash: expected_hash.to_string(),
                        byte_size: size,
                        reused: true,
                    }),
                    // Winner vanished between the failed link and the read — a
                    // pathological delete-race (full recovery is MEDIA-04A-2).
                    None => Err(MediaError::Io("io:AlreadyExists-then-vanished".to_string())),
                }
            } else {
                Err(MediaError::Io(safe_io(&e)))
            }
        }
    }
}

/// True when an IO error means "the target already exists". `hard_link` collision
/// is [`std::io::ErrorKind::AlreadyExists`]; the raw codes are checked defensively
/// (POSIX `EEXIST` = 17, Windows `ERROR_ALREADY_EXISTS` = 183) in case a platform
/// surfaces the code without the mapped kind.
fn is_already_exists(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::AlreadyExists
        || matches!(e.raw_os_error(), Some(17) | Some(183))
}

/// Test-only entry point exposing the `before_publish` barrier so a race can be
/// driven deterministically. Compiled only under `cfg(test)`, so no barrier
/// hook exists in a production build.
#[cfg(test)]
pub(crate) fn publish_with_barrier<F: FnOnce()>(
    root: &Path,
    tenant_scope: &str,
    bytes: &[u8],
    expected_hash: &str,
    ext: &str,
    before_publish: F,
) -> Result<Published, MediaError> {
    publish_impl(
        root,
        tenant_scope,
        bytes,
        expected_hash,
        ext,
        before_publish,
    )
}

/// Read a stored medium, re-validating that the path stays under `root`, that no
/// component is a reparse point, that the file is not implausibly large, and
/// that the bytes still hash to `hash`.
pub fn read_verified_media(
    root: &Path,
    tenant_scope: &str,
    hash: &str,
    ext: &str,
) -> Result<Vec<u8>, MediaError> {
    let canon_root = canonical_root_existing(root)?;
    let path = derive_storage_path(&canon_root, tenant_scope, hash, ext)?;
    assert_no_reparse_under_root(&canon_root, &path)?;

    let md = match fs::metadata(&path) {
        Ok(md) => md,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(MediaError::FileMissing),
        Err(e) => return Err(MediaError::Io(safe_io(&e))),
    };
    if md.len() > MAX_STORED_BYTES {
        return Err(MediaError::FileTooLarge);
    }
    let bytes = fs::read(&path).map_err(|e| MediaError::Io(safe_io(&e)))?;
    if sha256_hex(&bytes) != hash {
        return Err(MediaError::FileHashMismatch);
    }
    Ok(bytes)
}

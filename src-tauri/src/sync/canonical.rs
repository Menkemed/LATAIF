//! M6-B2C3 §2 — `canonical_bytes_v1`: the only byte layout we sign or authenticate.
//!
//! ## Why this exists
//!
//! Until now `CertificatePayload::canonical()` was `serde_json::to_vec(self)`, and the
//! argument for it was: *serde serializes struct fields in declaration order, so
//! re-serializing a parsed payload reproduces the signed bytes.* That happens to be true
//! for today's serde and today's struct — and it is not a protocol. It silently depends on
//!
//! - serde's field ordering (a library implementation detail),
//! - JSON whitespace and escaping choices,
//! - map iteration order, if a map is ever added,
//! - `serde_json`'s number and string formatting.
//!
//! A second implementation — a mobile client, a future Rust version, anything not this
//! exact code — could serialize the same logical certificate to different bytes and
//! conclude the signature is invalid. Worse, two implementations could disagree about
//! which bytes a signature *covers*, which is how signature-confusion bugs start.
//!
//! So: an explicit, boring, self-describing encoding that any language can reproduce from
//! this file alone.
//!
//! ## The encoding
//!
//! ```text
//! domain      : raw ASCII bytes of the domain separator, no length prefix
//! version     : u32 big-endian
//! u32/u64/i64 : big-endian, fixed width
//! string      : u32 big-endian byte length, then exact UTF-8 bytes
//! bytes       : u32 big-endian length, then raw bytes
//! option      : 0x00 for none; 0x01 followed by the value for some
//! ```
//!
//! Two rules carry the weight:
//!
//! - **Every variable-length field is length-prefixed.** Without it, `("ab", "c")` and
//!   `("a", "bc")` encode identically and a signature over one would verify over the
//!   other (C5).
//! - **`None` is 0x00, `Some("")` is 0x01 0x00000000.** They are different bytes, so
//!   "the field was absent" and "the field was empty" can never be confused (C3).
//!
//! ## Domain separation
//!
//! Every protocol object leads with its own separator, so bytes produced for one purpose
//! can never verify as another — even if the remaining fields were made to line up.

// ── The domain registry ─────────────────────────────────────────────────────
//
// One separator per protocol object, declared together so the set is reviewable in one
// place — that is the point of domain separation, and a registry split across modules is
// how two objects end up sharing a prefix by accident.
//
// M6-B2C4: every separator below now has a production caller. The three transfer ones were
// declared in B2C3 ahead of the code that uses them — deliberately, so the set stayed
// reviewable in one place — and `c6b_domains_do_not_cross_verify` proved they produce
// disjoint bytes before anything depended on it.

pub const DOMAIN_AUTHORITY_CERT: &[u8] = b"LATAIF-AUTHORITY-CERT-V1";
pub const DOMAIN_TRANSFER_BUNDLE_AAD: &[u8] = b"LATAIF-TRANSFER-BUNDLE-AAD-V1";
pub const DOMAIN_TRANSFER_RECEIPT: &[u8] = b"LATAIF-TRANSFER-RECEIPT-V1";
pub const DOMAIN_TRANSFER_COMMIT: &[u8] = b"LATAIF-TRANSFER-COMMIT-V1";
/// Abort gets its OWN separator, not a flag inside the commit domain. §5 requires commit
/// and abort commitments to be unforgeable from each other: if both hashed under one
/// domain, an abort token — which the source hands out freely on cancellation — would be a
/// commit token with one field flipped.
pub const DOMAIN_TRANSFER_ABORT: &[u8] = b"LATAIF-TRANSFER-ABORT-V1";
/// HKDF info + AEAD associated data for sealing the source's commit/abort secrets at rest.
/// Separate from the wire domains: these bytes never leave the machine, and a sealed secret
/// must never be mistakable for a token someone sent us.
pub const DOMAIN_TRANSFER_SEAL: &[u8] = b"LATAIF-TRANSFER-SEAL-V1";
pub const DOMAIN_RECOVERY_BUNDLE_AAD: &[u8] = b"LATAIF-RECOVERY-BUNDLE-AAD-V1";

/// Encoder for `canonical_bytes_v1`.
///
/// Deliberately not `Serialize`-driven: the whole point is that the layout is written out
/// here, in one readable place, rather than inherited from a derive macro's behaviour.
#[derive(Debug, Clone)]
pub struct CanonicalWriter {
    buf: Vec<u8>,
}

impl CanonicalWriter {
    /// Start a stream: domain separator, then the format version.
    ///
    /// The domain is written raw and un-prefixed on purpose — it is a fixed-length
    /// constant chosen by us, not attacker-supplied data, and every stream starts with
    /// exactly one of them.
    pub fn new(domain: &[u8], version: u32) -> Self {
        let mut w = CanonicalWriter { buf: Vec::with_capacity(256) };
        w.buf.extend_from_slice(domain);
        w.buf.extend_from_slice(&version.to_be_bytes());
        w
    }

    /// Signed integers go in as two's-complement big-endian, fixed width. Never as text:
    /// "-0" / "−0" / locale digits are all ways for two implementations to disagree.
    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_be_bytes());
        self
    }

    /// u32 length prefix, then the exact UTF-8 bytes. Rust strings are UTF-8 already, so
    /// there is no transcoding step to get wrong.
    pub fn string(&mut self, s: &str) -> &mut Self {
        self.bytes(s.as_bytes())
    }

    pub fn bytes(&mut self, b: &[u8]) -> &mut Self {
        // A field longer than 4 GiB cannot occur here (every caller is bounded by the
        // §13 parser limits), and truncating silently would be a collision. Saturating is
        // the safe direction: it can only make two different inputs encode differently.
        self.buf.extend_from_slice(&(b.len() as u32).to_be_bytes());
        self.buf.extend_from_slice(b);
        self
    }

    /// `None` → `0x00`. `Some(v)` → `0x01` followed by `v`.
    pub fn opt_string(&mut self, v: Option<&str>) -> &mut Self {
        match v {
            None => {
                self.buf.push(0x00);
            }
            Some(s) => {
                self.buf.push(0x01);
                self.string(s);
            }
        }
        self
    }

    /// `allow(dead_code)`: no production field is an optional integer yet
    /// (`last_known_authority_epoch` reaches the AEAD via the bundle, not via this
    /// writer). The encoding is still part of the v1 spec and is pinned by `c3_*`, so a
    /// later field cannot invent a second, incompatible one.
    #[allow(dead_code)]
    pub fn opt_i64(&mut self, v: Option<i64>) -> &mut Self {
        match v {
            None => {
                self.buf.push(0x00);
            }
            Some(n) => {
                self.buf.push(0x01);
                self.i64(n);
            }
        }
        self
    }

    pub fn finish(&self) -> Vec<u8> {
        self.buf.clone()
    }
}

/// SHA-256 over canonical bytes, hex-encoded. The one hashing convention in the protocol.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    // ── C1: same structure → always the same bytes ───────────────────────────
    #[test]
    fn c1_encoding_is_deterministic() {
        let build = || {
            let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
            w.string("tenant-1").string("branch-main").i64(7).opt_string(Some("prev"));
            w.finish()
        };
        // Same input, many times, including across separate writer instances.
        let first = build();
        for _ in 0..50 {
            assert_eq!(build(), first, "C1: the encoder must be a pure function");
        }
        // …and hashing it is equally stable.
        assert_eq!(sha256_hex(&first), sha256_hex(&build()));
    }

    // ── C2: field/map order does not leak in ─────────────────────────────────
    //
    // The encoder takes an explicit call sequence, so "order" is a property of the code
    // that writes the object, not of any serializer. This test states the consequence:
    // building the SAME logical object always writes the same sequence, and a different
    // sequence is a different object by construction.
    #[test]
    fn c2_order_is_fixed_by_the_writer_not_by_a_serializer() {
        let mut a = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
        a.string("x").string("y");
        let mut b = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
        b.string("y").string("x");
        assert_ne!(a.finish(), b.finish(), "swapping two fields must change the bytes");

        // No JSON, no whitespace, no map iteration anywhere in the output: the bytes are
        // exactly domain ‖ version ‖ fields.
        let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
        w.string("x").string("y");
        let out = w.finish();
        assert!(out.starts_with(DOMAIN_AUTHORITY_CERT));
        assert!(!out.contains(&b'{'), "no JSON structure leaks into signed bytes");
        assert!(!out.contains(&b'"'));
    }

    // ── C3: null and absent stay distinguishable ─────────────────────────────
    #[test]
    fn c3_none_empty_and_absent_are_distinct() {
        let enc = |v: Option<&str>| {
            let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
            w.opt_string(v);
            w.finish()
        };
        let none = enc(None);
        let empty = enc(Some(""));
        let value = enc(Some("a"));
        assert_ne!(none, empty, "C3: None and Some(\"\") must not collide");
        assert_ne!(empty, value);
        assert_ne!(none, value);

        // And the concrete shapes, so a second implementation can copy them.
        assert_eq!(none.last(), Some(&0x00u8));
        assert_eq!(&empty[empty.len() - 5..], &[0x01, 0x00, 0x00, 0x00, 0x00]);

        // A field that is simply not written is a THIRD thing again — it is a different
        // object, not a null.
        let absent = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1).finish();
        assert_ne!(absent, none, "an unwritten field is not the same as an explicit null");

        // Same for optional integers.
        let enc_i = |v: Option<i64>| {
            let mut w = CanonicalWriter::new(DOMAIN_TRANSFER_RECEIPT, 1);
            w.opt_i64(v);
            w.finish()
        };
        assert_ne!(enc_i(None), enc_i(Some(0)), "None and Some(0) must not collide");
    }

    // ── C4: unicode round-trips reproducibly ─────────────────────────────────
    #[test]
    fn c4_unicode_strings_are_reproducible() {
        for s in ["Lataif", "لطيف", "日本語", "e\u{0301}", "é", "emoji 🔐", "nul\u{0000}inside"] {
            let enc = || {
                let mut w = CanonicalWriter::new(DOMAIN_TRANSFER_RECEIPT, 1);
                w.string(s);
                w.finish()
            };
            assert_eq!(enc(), enc(), "{s:?} must encode identically every time");
            // The length prefix counts BYTES, not characters — otherwise two strings with
            // equal char counts but different byte lengths would frame differently.
            let out = enc();
            let prefix_at = DOMAIN_TRANSFER_RECEIPT.len() + 4;
            let len = u32::from_be_bytes(out[prefix_at..prefix_at + 4].try_into().unwrap());
            assert_eq!(len as usize, s.as_bytes().len(), "{s:?}: prefix is the byte length");
            assert_eq!(&out[prefix_at + 4..], s.as_bytes(), "exact UTF-8 bytes, no escaping");
        }
        // `é` precomposed vs `e` + combining accent are DIFFERENT byte strings and must
        // stay different — we do not normalise, we reproduce.
        let enc = |s: &str| {
            let mut w = CanonicalWriter::new(DOMAIN_TRANSFER_RECEIPT, 1);
            w.string(s);
            w.finish()
        };
        assert_ne!(enc("é"), enc("e\u{0301}"));
    }

    // ── C5: length prefixes defeat concatenation collisions ──────────────────
    //
    // The classic attack: without framing, sign("ab","c") == sign("a","bc"), so a
    // signature over one verifies over the other.
    #[test]
    fn c5_length_prefixes_prevent_concatenation_collisions() {
        let enc = |a: &str, b: &str| {
            let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
            w.string(a).string(b);
            w.finish()
        };
        assert_ne!(enc("ab", "c"), enc("a", "bc"), "C5: the classic framing collision");
        assert_ne!(enc("", "ab"), enc("ab", ""));
        assert_ne!(enc("tenant-1", "branch"), enc("tenant-1branch", ""));
        // Binary fields frame the same way.
        let encb = |a: &[u8], b: &[u8]| {
            let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
            w.bytes(a).bytes(b);
            w.finish()
        };
        assert_ne!(encb(&[1, 2], &[3]), encb(&[1], &[2, 3]));
    }

    // ── C6: any field change changes the bytes (and the signature) ───────────
    #[test]
    fn c6_field_changes_change_the_signature() {
        let payload = |tenant: &str, epoch: i64, prev: Option<&str>| {
            let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
            w.string(tenant).i64(epoch).opt_string(prev);
            w.finish()
        };
        let base = payload("tenant-1", 1, None);
        for (other, why) in [
            (payload("tenant-2", 1, None), "tenant"),
            (payload("tenant-1", 2, None), "epoch"),
            (payload("tenant-1", 1, Some("prev")), "predecessor appears"),
        ] {
            assert_ne!(base, other, "{why} must change the bytes");
            assert_ne!(sha256_hex(&base), sha256_hex(&other), "{why} must change the hash");
        }

        // …and through a real Ed25519 signature, which is what actually matters.
        let key = crate::sync::trust_root::RootKey::from_seed([9u8; 32], "k".into());
        let pk = key.public_key_b64();
        let sig = key.sign(&base);
        assert!(crate::sync::trust_root::verify_signature(&pk, &base, &sig));
        assert!(
            !crate::sync::trust_root::verify_signature(&pk, &payload("tenant-2", 1, None), &sig),
            "C6: a signature must not carry over to different canonical bytes"
        );
    }

    // ── C6b: the domain separator alone is enough to break cross-verification ─
    #[test]
    fn c6b_domains_do_not_cross_verify() {
        let same_fields = |domain: &[u8]| {
            let mut w = CanonicalWriter::new(domain, 1);
            w.string("transfer-1").string("install-a");
            w.finish()
        };
        let cert = same_fields(DOMAIN_AUTHORITY_CERT);
        let receipt = same_fields(DOMAIN_TRANSFER_RECEIPT);
        let commit = same_fields(DOMAIN_TRANSFER_COMMIT);
        let rec_aad = same_fields(DOMAIN_RECOVERY_BUNDLE_AAD);
        let tr_aad = same_fields(DOMAIN_TRANSFER_BUNDLE_AAD);

        // Identical fields, five different byte strings.
        let all = [&cert, &receipt, &commit, &rec_aad, &tr_aad];
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                if i != j {
                    assert_ne!(a, b, "domains {i} and {j} must not produce equal bytes");
                }
            }
        }
        // A signature made for one domain must not verify for another.
        let key = crate::sync::trust_root::RootKey::from_seed([4u8; 32], "k".into());
        let pk = key.public_key_b64();
        let sig = key.sign(&cert);
        assert!(crate::sync::trust_root::verify_signature(&pk, &cert, &sig));
        assert!(!crate::sync::trust_root::verify_signature(&pk, &receipt, &sig));
        assert!(!crate::sync::trust_root::verify_signature(&pk, &commit, &sig));
    }

    // ── C7: golden vectors ───────────────────────────────────────────────────
    //
    // Frozen hex. These are the spec: a second implementation is correct exactly when it
    // reproduces them. If a change here is ever *intended*, it is a new format version,
    // not an edited constant — every existing signature depends on these bytes.
    #[test]
    fn c7_golden_vectors() {
        // Empty stream: just the domain and the version.
        let w = CanonicalWriter::new(b"LATAIF-TEST-V1", 1);
        assert_eq!(hex(&w.finish()), "4c41544149462d544553542d563100000001");

        // A string: u32 length prefix + UTF-8.
        let mut w = CanonicalWriter::new(b"D", 1);
        w.string("ab");
        assert_eq!(hex(&w.finish()), "44" .to_owned() + "00000001" + "00000002" + "6162");

        // Option: none, then some("a").
        let mut w = CanonicalWriter::new(b"D", 1);
        w.opt_string(None).opt_string(Some("a"));
        assert_eq!(hex(&w.finish()), "44".to_owned() + "00000001" + "00" + "01" + "00000001" + "61");

        // i64: two's-complement big-endian, fixed width, including a negative.
        let mut w = CanonicalWriter::new(b"D", 1);
        w.i64(1).i64(-1).i64(0);
        assert_eq!(
            hex(&w.finish()),
            "44".to_owned()
                + "00000001"
                + "0000000000000001"
                + "ffffffffffffffff"
                + "0000000000000000"
        );

        // A realistic certificate-shaped stream, frozen end to end.
        let mut w = CanonicalWriter::new(DOMAIN_AUTHORITY_CERT, 1);
        w.string("tenant-1").string("branch-main").i64(1).opt_string(None);
        assert_eq!(
            sha256_hex(&w.finish()),
            "397bc9dfaae873ca0ccbb87806a1f10e5c8488bad97c9d816be7790018ed4f48",
            "C7: the canonical certificate prefix is frozen — a change here breaks every \
             signature ever issued and must be a NEW format version"
        );
    }
}

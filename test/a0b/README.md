# A0b — Protocol Fixtures + Independent Cross-Language Verifiers

Language-neutral, byte-stable JSON fixtures for the future
**Authoritative-Operation-Commit** (protocol v4), plus two **independent**
verifiers — Node/TypeScript and Rust — that recompute every value from the same
files. Everything lives in the **tracked LATAIF/desktop repo**.

A0b ships **fixtures, a spec and verifiers only**: no production code, no schema
change, no server endpoint, no operation infrastructure, no fix of the cross-client
double-redemption defect (that defect is reproduced and frozen by
[`../a0a`](../a0a)).

## Layout (all tracked)

```
test/a0b/
  README.md
  protocol-spec.md     binding spec (single source of truth)
  fixtures/
    canonical-json.json     LCJ-v4 canonical form, i64-string + NFC + schema vectors
    uuidv5.json             frozen namespace, child-ID derivation, ordinal stability + dedup
    envelopes.json          envelope shape + validation + 1 MiB boundary
    cursor-sequences.json   global sequence + per-branch cursor apply rules
    operation-results.json  final-vs-transient + retry semantics
  verify-node.mjs      independent Node verifier (writes report.md)
  report.md            generated, byte-stable parity report
  rust-verifier/       independent Rust verifier (isolated crate, tracked)
    Cargo.toml
    Cargo.lock
    src/main.rs
```

The separate Rust **server** repo contains no A0b artifact.

## Run

```bash
# Node verifier (from desktop/)
node test/a0b/verify-node.mjs

# Rust verifier (from test/a0b/rust-verifier/)
cargo run            # full verification, exit 0 on PASS
cargo test           # known-answer + full-parity tests
```

Both read the **same** `fixtures/*.json`; there is no second copy of the fixture
data.

## Why two independent verifiers

The fixtures fix byte-level rules (canonical JSON, payload hash, deterministic
UUIDv5 identities, ordinals, envelope/cursor/result logic) that must be
**identical in TypeScript and Rust** for an at-most-once / idempotent-retry
operation commit. To prove they really are identical:

- The Node verifier uses the `crypto` standard library for SHA-256/SHA-1.
- The Rust verifier uses established crates (`serde_json`, `sha2`, `uuid` v5,
  `unicode-normalization`) — no bespoke crypto as a protocol reference. Known-answer
  tests anchor the primitives to external RFC/well-known vectors.
- Neither verifier calls the other; each computes from scratch and asserts against
  the committed fixtures.

A cross-language divergence is traced to the exact byte difference — never hidden
by editing expected values in only one verifier.

## Wire format (frozen)

- **64-bit DOMAIN values are canonical i64 decimal strings**: money fils,
  `*Revision` (scope/root revisions), `serverSequence` (`^(0|[1-9][0-9]*)$`, max
  `9223372036854775807`). Node parses with `BigInt`; Rust parses strictly to
  `i64`.
- **Small SCHEMA-bound structural values are bounded JSON integers**:
  `protocolVersion` (exactly `4`), `mutationCount` and `ordinal` (`0..4294967295`,
  validated as `u32` in Rust). Number rejection is field/schema based — a JSON
  number is allowed only where the schema defines a bounded integer; money floats
  are always rejected.
- **NFC inside the hash boundary**: all string values are NFC-normalized before
  escaping and hashing (Node `normalize("NFC")`, Rust `unicode-normalization`), so
  NFD and NFC inputs produce identical canonical bytes and hashes.
- **Deterministic validation order**: field/schema validation traverses object
  members in ascending UTF-8 byte order of their names and arrays in index order;
  the first error wins, independent of input insertion order.
- Frozen namespace `NS_LATAIF_FIN_OPS = 9520db11-5c48-5d8f-a288-56f1876c0781`.
- Pilot `operationType = APPLY_SUPPLIER_CREDIT_TO_EXPENSES`;
  `MAX_ENVELOPE_BYTES_V4 = 1048576` (1 MiB).

## Reproducibility

`report.md` is generated from the fixtures only (no timestamps, paths, PIDs or
tool versions) and is byte-identical across runs. The Rust verifier reads the
fixtures via a `CARGO_MANIFEST_DIR`-relative path; `rust-verifier/target/` is
git-ignored.

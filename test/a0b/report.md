# A0b — Protocol Fixture Parity Report

Language-neutral fixtures for the Authoritative-Operation-Commit (protocol v4).
Two independent verifiers recompute every value from the SAME JSON files:
Node (`verify-node.mjs`) and Rust (`rust-verifier/`, established crates sha2/uuid/unicode-normalization).
Generated from the fixtures only (no timestamps, paths, PIDs, versions); byte-stable across runs.

## Integer model

- 64-bit DOMAIN values are transmitted as canonical i64 decimal **strings**: all money fils, `*Revision` (scope/root revisions), `serverSequence`.
- small SCHEMA-bound structural values are bounded JSON **integers**: `protocolVersion` (exactly `4`), `mutationCount` and `ordinal` (`0..4294967295`, u32).
- number rejection is FIELD/SCHEMA based, not a global ban: a JSON number is allowed only where the schema defines a bounded integer; money floats are always rejected.
- i64 strings: `^(0|[1-9][0-9]*)$`, max `9223372036854775807` (Node BigInt, Rust strict i64). A JSON number at an i64 field → `EXPECTED_I64_STRING`; a string at a u32/protocolVersion field → `EXPECTED_U32_INTEGER` / `EXPECTED_PROTOCOL_VERSION_INTEGER`.

## Frozen protocol decisions

- `protocolVersion` = `4` (JSON integer, frozen); pilot `operationType` = `APPLY_SUPPLIER_CREDIT_TO_EXPENSES`; pattern `^[A-Z][A-Z0-9_]{2,63}$`
- `NS_LATAIF_FIN_OPS` = `9520db11-5c48-5d8f-a288-56f1876c0781` (= uuidv5(URL-namespace, `urn:lataif:fin-ops:protocol:v4`))
- LCJ-v4 canonical JSON: NFC normalization inside the hash boundary; ASCII member names sorted by code point; arrays ordered; integers serialized minimal-decimal; payload hash = SHA-256 over canonical UTF-8 bytes
- allocation ordinal key = `canonical-json([expenseId, creditId])`; ledger-leg ordinal key = `canonical-json([legRole, sourceId, account, direction, counterpartyType, counterpartyId, amountFils])`; sort by UTF-8 bytes; ordinal = index
- child IDs server-derived via UUIDv5; name components must not contain `|`; retry derives identical IDs
- envelope size limit `MAX_ENVELOPE_BYTES_V4` = `1048576` (exactly 1 MiB allowed; +1 byte rejected)
- final statuses: `accepted`, `conflict`, `validation_rejected`
- transient statuses: `FINANCE_NOT_BOOTSTRAPPED`, `READ_ONLY`, `SERVICE_UNAVAILABLE`, `DB_LOCKED`, `RATE_LIMITED`, `INTERNAL_ERROR_BEFORE_COMMIT`, `UNKNOWN_COMMIT_STATUS`

## Known-answer anchors

- uuidv5(DNS, `www.example.com`) = `2ed6657d-e927-568b-95e1-2665a8aea6a2`
- sha256("") = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

## Fixture groups and case counts

| group | cases |
|---|---:|
| canonical-json | 45 |
| uuidv5 | 22 |
| envelopes | 25 |
| cursor-sequences | 8 |
| operation-results | 22 |
| **total** | **122** |

## Reject codes exercised

`BAD_TIMESTAMP`, `CHILD_ID_COMPONENT_HAS_DELIMITER`, `DUPLICATE_ALLOCATION_KEY`, `DUPLICATE_LEDGER_EFFECT_KEY`, `DUPLICATE_ORDINAL`, `ENVELOPE_TOO_LARGE`, `EXPECTED_I64_STRING`, `EXPECTED_PROTOCOL_VERSION_INTEGER`, `EXPECTED_U32_INTEGER`, `I64_LEADING_ZERO`, `I64_NOT_CANONICAL`, `INT_OUT_OF_RANGE`, `INVALID_OPERATION_ID`, `INVALID_OPERATION_TYPE`, `INVALID_SEQUENCE`, `JSON_NUMBER_NOT_ALLOWED`, `MUTATION_COUNT_MISMATCH`, `MUTATION_ORDER_MISMATCH`, `NON_ASCII_KEY`, `ORDINAL_NOT_DENSE`, `PROTOCOL_VERSION_NOT_INTEGER`, `U32_NEGATIVE`, `U32_NOT_INTEGER`, `U32_OUT_OF_RANGE`, `UNSUPPORTED_PROTOCOL_VERSION`

## Parity contract

Both verifiers independently compute and must agree on: NFC-normalized strings, canonical JSON bytes,
UTF-8 byte length, SHA-256, UUIDv5, ordinal sort order, envelope validation, cursor/sequence results, and
result/retry classification. 64-bit domain values are i64 decimal strings (Node BigInt, Rust strict i64);
protocolVersion/mutationCount/ordinal are bounded JSON integers (Rust u32).
Node verification: PASS (261 assertions). Run the Rust verifier with `cargo run` in `rust-verifier/`.

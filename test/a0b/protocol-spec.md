# A0b — Authoritative-Operation-Commit: Protocol Fixture Specification (v4)

Standalone, language-neutral specification for the byte-level wire/identity rules
of the future Authoritative-Operation-Commit (protocol v4). This document is the
**single source of truth** for the JSON fixtures under `fixtures/`. Two
independent verifiers — `verify-node.mjs` (Node/TypeScript) and `rust-verifier/`
(Rust, established crates `serde_json`, `sha2`, `uuid` v5, `unicode-normalization`)
— read the **same** fixture files and must agree on every computed value.

This is A0b: **fixtures + spec + verifiers only.** No production code, no schema,
no endpoints, no operation infrastructure, no fix of the cross-client defect. All
wire-protocol decisions below are **frozen**; there are no open wire decisions.

---

## 1. LATAIF Canonical JSON (LCJ-v4)

> **LCJ-v4 is a restricted RFC 8785 / JCS profile with upstream NFC normalization
> and canonical decimal strings for semantic 64-bit integers.**

Concretely, LCJ-v4 = RFC 8785 (JCS) plus these binding rules:

1. **Numbers are field/schema governed** (see §2), not globally banned. A JSON
   number is permitted only where the schema defines a bounded integer
   (`protocolVersion`, `mutationCount`, `ordinal`); a JSON number at any other
   field is rejected (`JSON_NUMBER_NOT_ALLOWED`). Money and other 64-bit domain
   values are i64 decimal strings, never JSON numbers. A non-integer JSON number
   is always rejected (`NUMBER_NOT_INTEGER`); money floats are never allowed.
2. **Integers serialize minimal-decimal**: an allowed JSON integer is emitted as
   its shortest decimal form, no leading zeros (`0` is `0`), `-` only for
   negatives. (All schema integers here are non-negative.)
3. **NFC inside the boundary.** Every string value is Unicode-NFC-normalized
   **before** escaping and hashing (§3).
4. **Member names** are ASCII `^[A-Za-z0-9_]+$` (else `NON_ASCII_KEY`), sorted
   ascending by code point.
5. **Strings** are JCS-escaped after NFC: `"`→`\"`, `\`→`\\`, `U+0008`→`\b`,
   `U+0009`→`\t`, `U+000A`→`\n`, `U+000C`→`\f`, `U+000D`→`\r`, other C0 controls →
   `\u00xx` (lowercase); every other code point is literal UTF-8.
6. **Arrays** preserve order (significant).
7. `null` is explicit and distinct from an absent member. Booleans are
   `true`/`false`. No insignificant whitespace.
8. The **payload hash** is `SHA-256` over the canonical UTF-8 bytes, lowercase hex.
   `protocolVersion` and `operationType` are ordinary members and are covered by
   the hash.

---

## 2. Integer model (64-bit domain strings vs small structural integers)

LCJ-v4 distinguishes two kinds of integers:

### 2.1 64-bit domain values → canonical i64 decimal **strings**

Money in fils, scope/root revisions (`*Revision`), `serverSequence`, and any
long-growing 64-bit counter are carried as **JSON strings**:

```json
{ "requestedAmountFils": "100000", "expectedSupplierSettlementRevision": "7", "serverSequence": "40" }
```

i64-string fields are identified by key name: ends with `Fils` or `Revision`, or
is `serverSequence`. A canonical i64 decimal string matches `^(0|[1-9][0-9]*)$`
with value `<= 9223372036854775807` (ASCII digits only; no `+`/`-`/`-0`; no
leading zeros except `"0"`).

| input at an i64 field | code |
|---|---|
| a JSON number (not a string) | `EXPECTED_I64_STRING` |
| non-digit / sign / decimal point (`"100.5"`, `"+5"`) | `I64_NOT_CANONICAL` |
| leading zero (`"00100"`) | `I64_LEADING_ZERO` |
| above i64 max (`"9223372036854775808"`) | `INT_OUT_OF_RANGE` |

Node parses i64 strings with `BigInt`; Rust parses **strictly** to `i64`.

### 2.2 Small schema-bound structural values → bounded JSON **integers**

```json
{ "protocolVersion": 4, "mutationCount": 3, "ordinal": 0 }
```

- **`protocolVersion`**: a JSON integer; for v4 exactly `4`.
  - a string → `EXPECTED_PROTOCOL_VERSION_INTEGER`
  - a non-integer number (`4.5`) → `PROTOCOL_VERSION_NOT_INTEGER`
  - an integer other than `4` (`3`, `5`) → `UNSUPPORTED_PROTOCOL_VERSION`
- **`mutationCount`** and **`ordinal`**: non-negative bounded JSON integers,
  `0 <= value <= 4294967295`. Node checks `Number.isSafeInteger(value) && value >= 0
  && value <= 4294967295`; Rust validates them as `u32`.
  - a string → `EXPECTED_U32_INTEGER`
  - a non-integer number (`1.5`) → `U32_NOT_INTEGER`
  - a negative number (`-1`) → `U32_NEGATIVE`
  - above the maximum (`4294967296`) → `U32_OUT_OF_RANGE`

No floats, negatives, strings, `NaN` or `Infinity` are accepted for these fields.

---

## 3. NFC inside the hash boundary

All string values are NFC-normalized as part of canonicalization, before escaping
and hashing. Object keys are ASCII-only and unaffected. An NFD input and the
equivalent NFC input produce **exactly** the same normalized strings, canonical
JSON bytes, byte lengths and SHA-256 hashes in **both** verifiers (fixture
`nfd-input-normalizes-equal`).

---

## 4. Frozen protocol namespace

```
NS_LATAIF_FIN_OPS = 9520db11-5c48-5d8f-a288-56f1876c0781
```

= `uuidv5(RFC4122-URL-namespace 6ba7b811-9dad-11d1-80b4-00c04fd430c8,
"urn:lataif:fin-ops:protocol:v4")`. Frozen literal; repeated identically in the
spec, fixtures and both verifiers.

---

## 5. Deterministic child-ID derivation (server-side only)

Child record IDs are `uuidv5(NS_LATAIF_FIN_OPS, name)`:

| child | name string |
|---|---|
| ledger transaction | `operationId + "\|ledger-tx"` |
| expense payment | `operationId + "\|exp-pmt\|" + expenseId + "\|" + creditId + "\|" + ordinal` |
| ledger entry | `operationId + "\|entry\|" + ordinal + "\|" + direction + "\|" + account` |

- `ordinal` is rendered as its decimal integer.
- No name component may contain `|` (else `CHILD_ID_COMPONENT_HAS_DELIMITER`).
- UUID fields are canonical UUID strings.
- **The server derives these IDs; client-proposed child IDs are invalid.** A retry
  with identical input derives **identical** IDs.

---

## 6. Deterministic ordinals (finalized)

An ordinal is the 0-based index (a bounded JSON integer, §2.2) after sorting on a
canonical key by **UTF-8 bytes** (never locale-aware).

**Allocations.** Canonical key = `canonical-json([expenseId, creditId])`. The
pair must be unique within an operation; a duplicate → `DUPLICATE_ALLOCATION_KEY`.

**Ledger legs.** Each leg carries a server-determined `legRole`. Canonical key =

```
canonical-json([ legRole, sourceId, account, direction, counterpartyType, counterpartyId, amountFils ])
```

where `amountFils` is a canonical decimal string. An identical key →
`DUPLICATE_LEDGER_EFFECT_KEY`. The fixtures include at least two legs with the same
`account` and the same `direction`.

Identical effect sets supplied in different input order yield the same canonical
order, the same ordinals and the same `uuidv5` IDs.

---

## 7. Operation envelope

```ts
interface OperationEnvelope {
  operationId: string;      // canonical UUID
  serverSequence: string;   // canonical i64 string, >= 1, globally monotonic
  operationType: string;    // matches ^[A-Z][A-Z0-9_]{2,63}$
  branchId: string;
  mutationCount: number;    // bounded JSON integer (u32), == mutations.length
  mutations: MaterializedMutation[];
  result: object;
}
interface MaterializedMutation {
  ordinal: number;          // bounded JSON integer (u32); 0-based, dense, == canonical position
  table: string;
  op: "insert" | "update";
  recordId: string;
  payload: object;          // money as i64 strings
}
```

Validation order (first failure wins):

| check | error code |
|---|---|
| `operationType` not matching `^[A-Z][A-Z0-9_]{2,63}$` | `INVALID_OPERATION_TYPE` |
| `operationId` not a canonical UUID | `INVALID_OPERATION_ID` |
| any typed field malformed (i64 strings, `mutationCount`/`ordinal` u32, payload fils) | `EXPECTED_I64_STRING` / `I64_*` / `EXPECTED_U32_INTEGER` / `U32_*` |
| `serverSequence` < 1 | `INVALID_SEQUENCE` |
| `mutationCount` != `mutations.length` | `MUTATION_COUNT_MISMATCH` |
| ordinals contain a duplicate | `DUPLICATE_ORDINAL` |
| ordinals not exactly `{0 … n-1}` | `ORDINAL_NOT_DENSE` |
| array order ≠ sort by `canonical-json([table, recordId])`, or `ordinal[i] != i` | `MUTATION_ORDER_MISMATCH` |
| canonical envelope byte length > `MAX_ENVELOPE_BYTES_V4` | `ENVELOPE_TOO_LARGE` |
| otherwise | valid → `{canonical, utf8ByteLength, sha256}` |

**`MAX_ENVELOPE_BYTES_V4 = 1048576`** (exactly 1 MiB). Exactly `1048576` canonical
UTF-8 bytes is allowed; `1048577` bytes → `ENVELOPE_TOO_LARGE`. No accepted
operation may be split across multiple envelopes. (The verifiers construct the
1 MiB boundary at run time, so no 1 MiB literal is committed.)

---

## 8. Global sequence and per-branch cursor

- `serverSequence` is a single globally monotonic counter (an i64 decimal string).
- A pull is for **exactly one branch**; the cursor is keyed per
  `(plane, tenantId, branchId)`. Gaps caused by other branches are allowed.
- Apply: sort delivered envelopes by `serverSequence`; for each op of this branch:
  `serverSequence <= cursor` → idempotent **skip** (cursor never regresses); an
  apply `error` **blocks** this and all later sequences (no skipping ahead);
  otherwise apply and set `cursor = serverSequence` (may advance even for a
  non-mutating op). One branch's cursor never moves another's.

---

## 9. Final vs transient results and retry

**Final** (stored authoritative business outcome):

```
accepted   conflict   validation_rejected
```

**Transient** (never stored as a final decision):

```
FINANCE_NOT_BOOTSTRAPPED   READ_ONLY   SERVICE_UNAVAILABLE   DB_LOCKED
RATE_LIMITED   INTERNAL_ERROR_BEFORE_COMMIT   UNKNOWN_COMMIT_STATUS
```

Retry semantics:

| situation | action |
|---|---|
| final decision stored, **same** payload hash | `REPLAY_STORED` (return the identical stored result) |
| final decision stored, **different** payload hash for same `operationId` | `OPERATION_ID_REUSED` |
| no final decision, prior outcome transient / unknown commit status | `STATUS_QUERY` (query before retrying) |
| no stored decision, same `operationId` + same hash | `RETRY_ALLOWED` |

This is the byte-level basis for **at-most-once** acceptance with **idempotent
retry**.

---

## 10. Frozen schema constants

- `protocolVersion = 4` (JSON integer).
- `operationType` matches `^[A-Z][A-Z0-9_]{2,63}$`; pilot operation is
  `APPLY_SUPPLIER_CREDIT_TO_EXPENSES`.
- `businessTimestamp` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`
  (UTC, three fractional digits, `Z`); a retry reuses identical timestamp bytes.

---

## 11. Error-code catalog

Canonicalization: `JSON_NUMBER_NOT_ALLOWED` (number at a field that does not permit
one), `NUMBER_NOT_INTEGER`, `NON_ASCII_KEY`.
i64 strings: `EXPECTED_I64_STRING`, `I64_NOT_CANONICAL`, `I64_LEADING_ZERO`,
`INT_OUT_OF_RANGE`.
u32 integers: `EXPECTED_U32_INTEGER`, `U32_NOT_INTEGER`, `U32_NEGATIVE`,
`U32_OUT_OF_RANGE`.
protocolVersion: `EXPECTED_PROTOCOL_VERSION_INTEGER`, `PROTOCOL_VERSION_NOT_INTEGER`,
`UNSUPPORTED_PROTOCOL_VERSION`.
Schema: `INVALID_OPERATION_TYPE`, `INVALID_OPERATION_ID`, `BAD_TIMESTAMP`.
Identities / ordinals: `CHILD_ID_COMPONENT_HAS_DELIMITER`,
`DUPLICATE_ALLOCATION_KEY`, `DUPLICATE_LEDGER_EFFECT_KEY`.
Envelope: `INVALID_SEQUENCE`, `MUTATION_COUNT_MISMATCH`, `DUPLICATE_ORDINAL`,
`ORDINAL_NOT_DENSE`, `MUTATION_ORDER_MISMATCH`, `ENVELOPE_TOO_LARGE`.
Retry: `REPLAY_STORED`, `OPERATION_ID_REUSED`, `STATUS_QUERY`, `RETRY_ALLOWED`.

---

## 12. Verifier parity

Both verifiers read the same `fixtures/*.json` and recompute every value
independently. The Rust verifier lives in the **tracked LATAIF/desktop repo** at
`test/a0b/rust-verifier/` (an isolated binary crate; it would be part of the same
commit as the rest of A0b) and reads the fixtures via a `CARGO_MANIFEST_DIR`-
relative path. It uses established crates (`serde_json`, `sha2`, `uuid` v5,
`unicode-normalization`); known-answer tests against external RFC/well-known
vectors (`sha256("")`, `sha256("abc")`, `uuidv5(DNS,"www.example.com")`) anchor the
primitives. The separate server repo contains **no** A0b artifact.

Run:

```
node test/a0b/verify-node.mjs                          # from desktop/
cargo run     # in test/a0b/rust-verifier/   (cargo test for known-answer + parity)
```

A cross-language divergence must be traced to the exact byte difference, never
papered over by editing expected values in only one verifier.

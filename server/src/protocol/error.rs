//! Typed protocol error with a stable, frozen A0b error code.
//!
//! The contract-stable surface is [`ProtocolError::code`]. `Display` and the
//! variants carry the same information, but a future client response must depend
//! only on the stable `code()` string — never on raw `Display` text.

/// A protocol validation failure. Every variant maps 1:1 to a frozen A0b error
/// code via [`ProtocolError::code`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    // ── canonicalization ──
    /// A JSON number is not an integer.
    NumberNotInteger,
    /// An object member name is not ASCII `[A-Za-z0-9_]+`.
    NonAsciiKey,
    /// A JSON number appears at a field that does not permit one.
    JsonNumberNotAllowed,
    // ── i64 decimal strings ──
    /// An i64 field is not a JSON string.
    ExpectedI64String,
    /// An i64 string is not canonical (non-digit, sign or decimal point).
    I64NotCanonical,
    /// An i64 string has a leading zero.
    I64LeadingZero,
    /// An i64 string exceeds the i64 maximum.
    IntOutOfRange,
    // ── u32 integers ──
    /// A u32 field is a string, not a JSON integer.
    ExpectedU32Integer,
    /// A u32 field is negative.
    U32Negative,
    /// A u32 field is not an integer.
    U32NotInteger,
    /// A u32 field exceeds `4294967295`.
    U32OutOfRange,
    // ── protocolVersion ──
    /// `protocolVersion` is a string, not a JSON integer.
    ExpectedProtocolVersionInteger,
    /// `protocolVersion` is not an integer.
    ProtocolVersionNotInteger,
    /// `protocolVersion` is an integer other than `4`.
    UnsupportedProtocolVersion,
    // ── schema ──
    /// `operationType` does not match `^[A-Z][A-Z0-9_]{2,63}$`.
    InvalidOperationType,
    /// `operationId` is not a canonical UUID string.
    InvalidOperationId,
    /// `businessTimestamp` does not match the frozen UTC pattern.
    BadTimestamp,
    // ── identities / ordinals ──
    /// A child-ID name component contains the `|` delimiter.
    ChildIdComponentHasDelimiter,
    /// Two allocations share a canonical key.
    DuplicateAllocationKey,
    /// Two ledger legs share a canonical key.
    DuplicateLedgerEffectKey,
    // ── envelope ──
    /// `serverSequence` is below `1`.
    InvalidSequence,
    /// `mutationCount` does not equal the number of mutations.
    MutationCountMismatch,
    /// Two mutations share an ordinal.
    DuplicateOrdinal,
    /// Ordinals are not exactly `{0 … n-1}`.
    OrdinalNotDense,
    /// Mutations are not in canonical order, or `ordinal[i] != i`.
    MutationOrderMismatch,
    /// The canonical envelope exceeds `MAX_ENVELOPE_BYTES_V4`.
    EnvelopeTooLarge,
}

impl ProtocolError {
    /// The stable, frozen A0b error code (the only contract-stable surface).
    pub fn code(&self) -> &'static str {
        match self {
            ProtocolError::NumberNotInteger => "NUMBER_NOT_INTEGER",
            ProtocolError::NonAsciiKey => "NON_ASCII_KEY",
            ProtocolError::JsonNumberNotAllowed => "JSON_NUMBER_NOT_ALLOWED",
            ProtocolError::ExpectedI64String => "EXPECTED_I64_STRING",
            ProtocolError::I64NotCanonical => "I64_NOT_CANONICAL",
            ProtocolError::I64LeadingZero => "I64_LEADING_ZERO",
            ProtocolError::IntOutOfRange => "INT_OUT_OF_RANGE",
            ProtocolError::ExpectedU32Integer => "EXPECTED_U32_INTEGER",
            ProtocolError::U32Negative => "U32_NEGATIVE",
            ProtocolError::U32NotInteger => "U32_NOT_INTEGER",
            ProtocolError::U32OutOfRange => "U32_OUT_OF_RANGE",
            ProtocolError::ExpectedProtocolVersionInteger => "EXPECTED_PROTOCOL_VERSION_INTEGER",
            ProtocolError::ProtocolVersionNotInteger => "PROTOCOL_VERSION_NOT_INTEGER",
            ProtocolError::UnsupportedProtocolVersion => "UNSUPPORTED_PROTOCOL_VERSION",
            ProtocolError::InvalidOperationType => "INVALID_OPERATION_TYPE",
            ProtocolError::InvalidOperationId => "INVALID_OPERATION_ID",
            ProtocolError::BadTimestamp => "BAD_TIMESTAMP",
            ProtocolError::ChildIdComponentHasDelimiter => "CHILD_ID_COMPONENT_HAS_DELIMITER",
            ProtocolError::DuplicateAllocationKey => "DUPLICATE_ALLOCATION_KEY",
            ProtocolError::DuplicateLedgerEffectKey => "DUPLICATE_LEDGER_EFFECT_KEY",
            ProtocolError::InvalidSequence => "INVALID_SEQUENCE",
            ProtocolError::MutationCountMismatch => "MUTATION_COUNT_MISMATCH",
            ProtocolError::DuplicateOrdinal => "DUPLICATE_ORDINAL",
            ProtocolError::OrdinalNotDense => "ORDINAL_NOT_DENSE",
            ProtocolError::MutationOrderMismatch => "MUTATION_ORDER_MISMATCH",
            ProtocolError::EnvelopeTooLarge => "ENVELOPE_TOO_LARGE",
        }
    }
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for ProtocolError {}

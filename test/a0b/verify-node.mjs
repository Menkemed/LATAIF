// A0b — independent TypeScript/Node verifier for the language-neutral protocol
// fixtures of the Authoritative-Operation-Commit (protocol v4). TEST-ONLY, no
// production imports. Reads test/a0b/fixtures/*.json, RE-computes every value and
// asserts it against the fixtures. The Rust verifier under test/a0b/rust-verifier/
// checks the SAME files independently with established crates.
//
// Wire format (frozen):
//   - 64-bit DOMAIN values (money fils, *Revision, serverSequence) are canonical
//     i64 decimal STRINGS.
//   - small SCHEMA-bound structural integers (protocolVersion, mutationCount,
//     ordinal) are bounded JSON INTEGERS (protocolVersion == 4; mutationCount /
//     ordinal in 0..4294967295).
//   - number rejection is FIELD/SCHEMA based, not a global ban.
//   - strings are NFC-normalized inside the hash boundary.
//
// Run:  node test/a0b/verify-node.mjs            (writes report.md on PASS)
//       node test/a0b/verify-node.mjs --no-report
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const NS = '9520db11-5c48-5d8f-a288-56f1876c0781';
const URL_NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const I64_MAX = 9223372036854775807n;
const U32_MAX = 4294967295;
const OP_TYPE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const load = (n) => JSON.parse(readFileSync(join(FIX, n), 'utf8'));

// ===================== LCJ-v4 canonicalizer (NFC inside boundary) ============
const nfc = (s) => s.normalize('NFC');
function canonString(s) {
  let out = '"';
  for (const ch of nfc(s)) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (cp === 0x08) out += '\\b';
    else if (cp === 0x09) out += '\\t';
    else if (cp === 0x0a) out += '\\n';
    else if (cp === 0x0c) out += '\\f';
    else if (cp === 0x0d) out += '\\r';
    else if (cp < 0x20) out += '\\u' + cp.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}
class CanonError extends Error { constructor(c) { super(c); this.code = c; } }
function canon(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') { if (!Number.isInteger(v)) throw new CanonError('NUMBER_NOT_INTEGER'); return String(v); }
  if (t === 'string') return canonString(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v);
    for (const k of keys) if (!/^[A-Za-z0-9_]+$/.test(k)) throw new CanonError('NON_ASCII_KEY');
    keys.sort();
    return '{' + keys.map(k => canonString(k) + ':' + canon(v[k])).join(',') + '}';
  }
  throw new CanonError('UNSUPPORTED_TYPE');
}
function tryCanon(v) { try { return { ok: true, canonical: canon(v) }; } catch (e) { if (e instanceof CanonError) return { ok: false, code: e.code }; throw e; } }
const sha256hex = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const utf8len = (s) => Buffer.byteLength(s, 'utf8');
const cmpBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

// ----- typed-field validation (field/schema based; no global number ban)
function validateI64String(v) {
  if (typeof v !== 'string') return 'EXPECTED_I64_STRING';
  if (!/^[0-9]+$/.test(v)) return 'I64_NOT_CANONICAL';
  if (v.length > 1 && v[0] === '0') return 'I64_LEADING_ZERO';
  if (BigInt(v) > I64_MAX) return 'INT_OUT_OF_RANGE';
  return null;
}
function validateU32(v) {
  if (typeof v === 'string') return 'EXPECTED_U32_INTEGER';
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return 'U32_NOT_INTEGER';
  if (v < 0) return 'U32_NEGATIVE';
  if (v > U32_MAX) return 'U32_OUT_OF_RANGE';
  return null;
}
function validateProtocolVersion(v) {
  if (typeof v === 'string') return 'EXPECTED_PROTOCOL_VERSION_INTEGER';
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'PROTOCOL_VERSION_NOT_INTEGER';
  if (v !== 4) return 'UNSUPPORTED_PROTOCOL_VERSION';
  return null;
}
const isI64Key = (k) => /Fils$/.test(k) || /Revision$/.test(k) || k === 'serverSequence';
const isU32Key = (k) => k === 'mutationCount' || k === 'ordinal';
function walkTypes(v) {
  if (Array.isArray(v)) { for (const e of v) { const r = walkTypes(e); if (r) return r; } return null; }
  if (v && typeof v === 'object') {
    // Deterministic traversal: validate members in ascending UTF-8 byte order
    // of their names (insertion-order independent), not Object.keys order.
    for (const k of Object.keys(v).sort(cmpBytes)) {
      const val = v[k];
      if (isI64Key(k)) { const r = validateI64String(val); if (r) return r; }
      else if (k === 'protocolVersion') { const r = validateProtocolVersion(val); if (r) return r; }
      else if (isU32Key(k)) { const r = validateU32(val); if (r) return r; }
      else if (typeof val === 'number') return 'JSON_NUMBER_NOT_ALLOWED';
      else { const r = walkTypes(val); if (r) return r; }
    }
    return null;
  }
  if (typeof v === 'number') return 'JSON_NUMBER_NOT_ALLOWED';
  return null;
}

// ===================== UUIDv5 (independent, RFC 4122) =====================
function uuidToBytes(u) { const h = u.replace(/-/g, ''); const b = Buffer.alloc(16); for (let i = 0; i < 16; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }
function bytesToUuid(b) { const h = Buffer.from(b).toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
function uuid5(ns, name) { const h = createHash('sha1').update(uuidToBytes(ns)).update(Buffer.from(name, 'utf8')).digest(); const b = Buffer.from(h.subarray(0, 16)); b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80; return bytesToUuid(b); }
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// ===================== test runner =====================
const fails = [];
let passCount = 0;
function ok(cond, label) { if (cond) passCount++; else fails.push(label); }
function eq(a, b, label) { ok(a === b, `${label} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
const arrEq = (a, b, label) => eq(JSON.stringify(a), JSON.stringify(b), label);

// ---- group 1: canonical-json
const cj = load('canonical-json.json');
const cjByName = Object.fromEntries(cj.canonicalCases.map(c => [c.name, c]));
let cjCases = 0;
for (const c of cj.canonicalCases) {
  cjCases++;
  const terr = walkTypes(c.input);
  let result;
  if (terr) result = { reject: terr };
  else { const r = tryCanon(c.input); result = r.ok ? { canonical: r.canonical } : { reject: r.code }; }
  if (c.expect === 'valid') {
    ok(!result.reject, `cj:${c.name} expected valid, got ${result.reject}`);
    if (result.canonical) {
      eq(result.canonical, c.canonical, `cj:${c.name} canonical`);
      eq(utf8len(result.canonical), c.utf8ByteLength, `cj:${c.name} byteLength`);
      eq(sha256hex(result.canonical), c.sha256, `cj:${c.name} sha256`);
    }
    if (c.sameHashAs) eq(c.sha256, cjByName[c.sameHashAs].sha256, `cj:${c.name} sameHashAs`);
    if (c.differentHashFrom) ok(c.sha256 !== cjByName[c.differentHashFrom].sha256, `cj:${c.name} differentHashFrom`);
    if (c.nfcEquivalence) {
      ok(JSON.stringify(c.input) !== JSON.stringify(cjByName[c.nfcEquivalence].input), `cj:${c.name} nfd!=nfc input bytes`);
      eq(canon(c.input), canon(cjByName[c.nfcEquivalence].input), `cj:${c.name} canon(nfd)===canon(nfc)`);
    }
  } else {
    eq(result.reject, c.expect, `cj:${c.name} reject code`);
  }
}
function validateSettlement(p) {
  if (typeof p.operationType !== 'string' || !OP_TYPE_RE.test(p.operationType)) return 'INVALID_OPERATION_TYPE';
  if (!isUuid(p.operationId)) return 'INVALID_OPERATION_ID';
  if (typeof p.businessTimestamp !== 'string' || !TS_RE.test(p.businessTimestamp)) return 'BAD_TIMESTAMP';
  const t = walkTypes(p); if (t) return t;
  return null;
}
let schemaCases = 0;
for (const c of cj.schemaCases) {
  schemaCases++;
  const r = validateSettlement(c.input);
  if (c.expect === 'valid') ok(r === null, `cj-schema:${c.name} expected valid, got ${r}`);
  else eq(r, c.expect, `cj-schema:${c.name} reject`);
}

// ---- group 2: uuidv5
const u5 = load('uuidv5.json');
let u5Cases = 0;
eq(uuid5(URL_NS, u5.namespace.derivation.nameString), u5.namespace.value, 'u5:namespace recompute');
eq(u5.namespace.value, NS, 'u5:namespace frozen literal');
for (const kv of u5.knownAnswerVectors.uuid5) { u5Cases++; eq(uuid5(kv.namespace, kv.nameString), kv.expectedUuid, `u5:kav ${kv.name}`); }
for (const kv of u5.knownAnswerVectors.sha256) { u5Cases++; eq(sha256hex(kv.input), kv.hex, `u5:sha256 ${JSON.stringify(kv.input)}`); }
const u5ByName = Object.fromEntries(u5.childIds.map(c => [c.name, c]));
const childName = (c) => c.kind === 'ledger-tx' ? `${c.operationId}|ledger-tx`
  : c.kind === 'exp-pmt' ? `${c.operationId}|exp-pmt|${c.expenseId}|${c.creditId}|${c.ordinal}`
    : `${c.operationId}|entry|${c.ordinal}|${c.direction}|${c.account}`;
const childComponents = (c) => c.kind === 'ledger-tx' ? [c.operationId]
  : c.kind === 'exp-pmt' ? [c.operationId, c.expenseId, c.creditId, String(c.ordinal)]
    : [c.operationId, String(c.ordinal), c.direction, c.account];
for (const c of u5.childIds) {
  u5Cases++;
  ok(childComponents(c).every(x => !String(x).includes('|')), `u5:${c.name} components pipe-free`);
  eq(childName(c), c.nameString, `u5:${c.name} nameString`);
  eq(uuid5(NS, childName(c)), c.expectedUuid, `u5:${c.name} uuid`);
  if (c.sameUuidAs) eq(c.expectedUuid, u5ByName[c.sameUuidAs].expectedUuid, `u5:${c.name} sameUuidAs`);
  if (c.differentUuidFrom) ok(c.expectedUuid !== u5ByName[c.differentUuidFrom].expectedUuid, `u5:${c.name} differentUuidFrom`);
}
for (const c of u5.rejectChildIds) {
  u5Cases++;
  const hasPipe = childComponents(c).some(x => String(x).includes('|'));
  eq(hasPipe ? 'CHILD_ID_COMPONENT_HAS_DELIMITER' : 'ok', c.expect, `u5:${c.name} reject`);
}
{
  const a = u5.ordinalStability.allocations;
  const sorted = [...a.unsortedInput].sort((x, y) => cmpBytes(canon([x.expenseId, x.creditId]), canon([y.expenseId, y.creditId])));
  sorted.forEach((al, i) => {
    u5Cases++;
    const e = a.expectedSorted[i];
    eq(canon([al.expenseId, al.creditId]), e.canonicalKey, `u5:alloc[${i}] key`);
    eq(i, e.ordinal, `u5:alloc[${i}] ordinal`);
    eq(uuid5(NS, `${a.operationId}|exp-pmt|${al.expenseId}|${al.creditId}|${i}`), e.expectedUuid, `u5:alloc[${i}] uuid`);
  });
  const aKeys = a.duplicateRejectInput.map(x => canon([x.expenseId, x.creditId]));
  eq(new Set(aKeys).size !== aKeys.length ? 'DUPLICATE_ALLOCATION_KEY' : 'ok', a.duplicateExpect, 'u5:alloc dedup');
  u5Cases++;

  const lg = u5.ordinalStability.ledgerLegs;
  const legKey = (l) => canon([l.legRole, l.sourceId, l.account, l.direction, l.counterpartyType, l.counterpartyId, l.amountFils]);
  const ls = [...lg.unsortedInput].sort((x, y) => cmpBytes(legKey(x), legKey(y)));
  ls.forEach((leg, i) => {
    u5Cases++;
    const e = lg.expectedSorted[i];
    eq(legKey(leg), e.canonicalKey, `u5:leg[${i}] key`);
    eq(i, e.ordinal, `u5:leg[${i}] ordinal`);
    eq(uuid5(NS, `${lg.operationId}|entry|${i}|${leg.direction}|${leg.account}`), e.expectedUuid, `u5:leg[${i}] uuid`);
  });
  const lKeys = lg.duplicateRejectInput.map(legKey);
  eq(new Set(lKeys).size !== lKeys.length ? 'DUPLICATE_LEDGER_EFFECT_KEY' : 'ok', lg.duplicateExpect, 'u5:leg dedup');
  u5Cases++;
}

// ---- group 3: envelopes
const ev = load('envelopes.json');
const maxEnv = ev.maxEnvelopeBytes;
let evCases = 0;
for (const c of ev.u32Validity) {
  evCases++;
  const r = validateU32(c.value);
  eq(r === null ? 'valid' : r, c.expect, `env:u32 ${c.name}`);
}
function validateEnvelope(env) {
  if (typeof env.operationType !== 'string' || !OP_TYPE_RE.test(env.operationType)) return { code: 'INVALID_OPERATION_TYPE' };
  if (!isUuid(env.operationId)) return { code: 'INVALID_OPERATION_ID' };
  const terr = walkTypes(env); if (terr) return { code: terr };
  if (BigInt(env.serverSequence) < 1n) return { code: 'INVALID_SEQUENCE' };
  if (env.mutationCount !== env.mutations.length) return { code: 'MUTATION_COUNT_MISMATCH' };
  const ords = env.mutations.map(m => m.ordinal);
  if (new Set(ords).size !== ords.length) return { code: 'DUPLICATE_ORDINAL' };
  const sortedOrds = [...ords].sort((a, b) => a - b);
  for (let i = 0; i < sortedOrds.length; i++) if (sortedOrds[i] !== i) return { code: 'ORDINAL_NOT_DENSE' };
  const byKey = env.mutations.map(m => ({ o: m.ordinal, k: canon([m.table, m.recordId]) })).sort((a, b) => cmpBytes(a.k, b.k));
  for (let i = 0; i < byKey.length; i++) if (byKey[i].o !== i) return { code: 'MUTATION_ORDER_MISMATCH' };
  for (let i = 0; i < env.mutations.length; i++) if (env.mutations[i].ordinal !== i) return { code: 'MUTATION_ORDER_MISMATCH' };
  const cr = tryCanon(env); if (!cr.ok) return { code: cr.code };
  const len = utf8len(cr.canonical);
  if (len > maxEnv) return { code: 'ENVELOPE_TOO_LARGE' };
  return { ok: true, canonical: cr.canonical, sha256: sha256hex(cr.canonical), utf8ByteLength: len };
}
for (const c of ev.cases) {
  evCases++;
  const r = validateEnvelope(c.envelope);
  if (c.expect === 'valid') {
    ok(r.ok, `env:${c.name} expected valid, got ${r.code}`);
    if (r.ok) {
      eq(r.canonical, c.canonical, `env:${c.name} canonical`);
      eq(r.utf8ByteLength, c.utf8ByteLength, `env:${c.name} byteLength`);
      eq(r.sha256, c.sha256, `env:${c.name} sha256`);
    }
  } else eq(r.code, c.expect, `env:${c.name} reject`);
}
{
  const sb = ev.sizeBoundary;
  const setPath = (o, path, val) => { let x = o; for (let i = 0; i < path.length - 1; i++) x = x[path[i]]; x[path[path.length - 1]] = val; };
  const empty = structuredClone(sb.baseEnvelope); setPath(empty, sb.fillPath, '');
  const r0 = validateEnvelope(empty);
  ok(r0.ok, `env:boundary base valid`);
  const need = maxEnv - r0.utf8ByteLength;
  const atLimit = structuredClone(sb.baseEnvelope); setPath(atLimit, sb.fillPath, sb.fillChar.repeat(need));
  const rAt = validateEnvelope(atLimit);
  ok(rAt.ok && rAt.utf8ByteLength === maxEnv, `env:boundary at ${maxEnv} valid (got ${rAt.ok ? rAt.utf8ByteLength : rAt.code})`);
  const over = structuredClone(sb.baseEnvelope); setPath(over, sb.fillPath, sb.fillChar.repeat(need + 1));
  const rOver = validateEnvelope(over);
  eq(rOver.code, sb.overLimitExpect, `env:boundary at ${maxEnv + 1} reject`);
  evCases += 2;
}

// ---- group 4: cursor-sequences
const cs = load('cursor-sequences.json');
function runCursor(initialCursor, branchId, ops) {
  const sorted = [...ops].sort((a, b) => Number(a.serverSequence) - Number(b.serverSequence));
  let cursor = Number(initialCursor), blocked = false;
  const applied = [], mutated = [], skipped = [], blk = [], delivered = [];
  for (const o of sorted) {
    if (o.branchId !== branchId) continue;
    const s = o.serverSequence, sn = Number(s);
    delivered.push(s);
    if (blocked) { blk.push(s); continue; }
    if (sn <= cursor) { skipped.push(s); continue; }
    if (o.applyOutcome === 'error') { blocked = true; blk.push(s); continue; }
    applied.push(s); if (o.mutates) mutated.push(s); cursor = sn;
  }
  return { deliveredSortedSequences: delivered, appliedSequences: applied, mutatedSequences: mutated, skippedSequences: skipped, blockedSequences: blk, finalCursor: String(cursor) };
}
let csCases = 0;
for (const s of cs.scenarios) {
  csCases++;
  const r = runCursor(s.initialCursor, s.branchKey.branchId, s.deliveredOps);
  const e = s.expected;
  arrEq(r.deliveredSortedSequences, e.deliveredSortedSequences, `cs:${s.name} delivered`);
  arrEq(r.appliedSequences, e.appliedSequences, `cs:${s.name} applied`);
  arrEq(r.mutatedSequences, e.mutatedSequences, `cs:${s.name} mutated`);
  arrEq(r.skippedSequences, e.skippedSequences, `cs:${s.name} skipped`);
  arrEq(r.blockedSequences, e.blockedSequences, `cs:${s.name} blocked`);
  eq(r.finalCursor, e.finalCursor, `cs:${s.name} finalCursor`);
}
for (const side of ['branchA', 'branchB']) {
  csCases++;
  const b = cs.isolation[side];
  const r = runCursor(b.initialCursor, b.branchId, cs.isolation.globalOps);
  arrEq(r.appliedSequences, b.expected.appliedSequences, `cs:iso ${side} applied`);
  eq(r.finalCursor, b.expected.finalCursor, `cs:iso ${side} finalCursor`);
}

// ---- group 5: operation-results
const orr = load('operation-results.json');
const FINAL = new Set(orr.finalStatuses);
function retryDecision(stored, incoming) {
  if (stored.exists) {
    if (incoming.hash === stored.hash) return { action: 'REPLAY_STORED', resultStatus: stored.status };
    return { action: 'OPERATION_ID_REUSED' };
  }
  if (incoming.priorOutcome === 'UNKNOWN_COMMIT_STATUS') return { action: 'STATUS_QUERY' };
  return { action: 'RETRY_ALLOWED' };
}
let orCases = 0;
for (const c of orr.classification) { orCases++; eq(FINAL.has(c.status), c.final, `or:classify ${c.status}`); }
for (const c of orr.retryCases) {
  orCases++;
  const r = retryDecision(c.stored, c.incoming);
  eq(r.action, c.expectedAction, `or:retry ${c.name} action`);
  if (c.expectedResultStatus) eq(r.resultStatus, c.expectedResultStatus, `or:retry ${c.name} resultStatus`);
}

// ===================== summary =====================
const groups = [
  ['canonical-json', cjCases + schemaCases],
  ['uuidv5', u5Cases],
  ['envelopes', evCases],
  ['cursor-sequences', csCases],
  ['operation-results', orCases],
];
const totalCases = groups.reduce((a, [, n]) => a + n, 0);
console.log('A0b verify-node');
for (const [g, n] of groups) console.log(`  ${g}: ${n} cases`);
console.log(`  total: ${totalCases} cases, ${passCount} assertions passed, ${fails.length} failed`);
if (fails.length) {
  console.error('FAILURES:');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}

// ----- byte-stable report.md (no env/time/pid/path, no open wire decisions)
if (!process.argv.includes('--no-report')) {
  const rejectCodes = [...new Set(
    cj.canonicalCases.filter(c => c.expect !== 'valid').map(c => c.expect)
      .concat(cj.schemaCases.filter(c => c.expect !== 'valid').map(c => c.expect))
      .concat(ev.cases.filter(c => c.expect !== 'valid').map(c => c.expect))
      .concat(ev.u32Validity.filter(c => c.expect !== 'valid').map(c => c.expect))
      .concat(u5.rejectChildIds.map(c => c.expect))
      .concat(['DUPLICATE_ALLOCATION_KEY', 'DUPLICATE_LEDGER_EFFECT_KEY', 'ENVELOPE_TOO_LARGE']))].sort();
  const L = [];
  L.push('# A0b — Protocol Fixture Parity Report');
  L.push('');
  L.push('Language-neutral fixtures for the Authoritative-Operation-Commit (protocol v4).');
  L.push('Two independent verifiers recompute every value from the SAME JSON files:');
  L.push('Node (`verify-node.mjs`) and Rust (`rust-verifier/`, established crates sha2/uuid/unicode-normalization).');
  L.push('Generated from the fixtures only (no timestamps, paths, PIDs, versions); byte-stable across runs.');
  L.push('');
  L.push('## Integer model');
  L.push('');
  L.push('- 64-bit DOMAIN values are transmitted as canonical i64 decimal **strings**: all money fils, `*Revision` (scope/root revisions), `serverSequence`.');
  L.push('- small SCHEMA-bound structural values are bounded JSON **integers**: `protocolVersion` (exactly `4`), `mutationCount` and `ordinal` (`0..' + ev.u32Max + '`, u32).');
  L.push('- number rejection is FIELD/SCHEMA based, not a global ban: a JSON number is allowed only where the schema defines a bounded integer; money floats are always rejected.');
  L.push('- i64 strings: `^(0|[1-9][0-9]*)$`, max `' + cj.maxI64 + '` (Node BigInt, Rust strict i64). A JSON number at an i64 field → `EXPECTED_I64_STRING`; a string at a u32/protocolVersion field → `EXPECTED_U32_INTEGER` / `EXPECTED_PROTOCOL_VERSION_INTEGER`.');
  L.push('');
  L.push('## Frozen protocol decisions');
  L.push('');
  L.push('- `protocolVersion` = `4` (JSON integer, frozen); pilot `operationType` = `' + cj.operationType + '`; pattern `' + cj.operationTypePattern + '`');
  L.push('- `NS_LATAIF_FIN_OPS` = `' + NS + '` (= uuidv5(URL-namespace, `' + u5.namespace.derivation.nameString + '`))');
  L.push('- LCJ-v4 canonical JSON: NFC normalization inside the hash boundary; ASCII member names sorted by code point; arrays ordered; integers serialized minimal-decimal; payload hash = SHA-256 over canonical UTF-8 bytes');
  L.push('- allocation ordinal key = `canonical-json([expenseId, creditId])`; ledger-leg ordinal key = `canonical-json([legRole, sourceId, account, direction, counterpartyType, counterpartyId, amountFils])`; sort by UTF-8 bytes; ordinal = index');
  L.push('- child IDs server-derived via UUIDv5; name components must not contain `|`; retry derives identical IDs');
  L.push('- envelope size limit `MAX_ENVELOPE_BYTES_V4` = `' + ev.maxEnvelopeBytes + '` (exactly 1 MiB allowed; +1 byte rejected)');
  L.push('- final statuses: ' + orr.finalStatuses.map(s => '`' + s + '`').join(', '));
  L.push('- transient statuses: ' + orr.transientStatuses.map(s => '`' + s + '`').join(', '));
  L.push('');
  L.push('## Known-answer anchors');
  L.push('');
  L.push('- uuidv5(DNS, `www.example.com`) = `' + u5.knownAnswerVectors.uuid5.find(v => v.name.includes('dns')).expectedUuid + '`');
  L.push('- sha256("") = `' + u5.knownAnswerVectors.sha256.find(v => v.input === '').hex + '`');
  L.push('');
  L.push('## Fixture groups and case counts');
  L.push('');
  L.push('| group | cases |');
  L.push('|---|---:|');
  for (const [g, n] of groups) L.push(`| ${g} | ${n} |`);
  L.push(`| **total** | **${totalCases}** |`);
  L.push('');
  L.push('## Reject codes exercised');
  L.push('');
  L.push(rejectCodes.map(c => '`' + c + '`').join(', '));
  L.push('');
  L.push('## Parity contract');
  L.push('');
  L.push('Both verifiers independently compute and must agree on: NFC-normalized strings, canonical JSON bytes,');
  L.push('UTF-8 byte length, SHA-256, UUIDv5, ordinal sort order, envelope validation, cursor/sequence results, and');
  L.push('result/retry classification. 64-bit domain values are i64 decimal strings (Node BigInt, Rust strict i64);');
  L.push('protocolVersion/mutationCount/ordinal are bounded JSON integers (Rust u32).');
  L.push('Node verification: PASS (' + passCount + ' assertions). Run the Rust verifier with `cargo run` in `rust-verifier/`.');
  writeFileSync(join(HERE, 'report.md'), L.join('\n') + '\n', 'utf8');
  console.log('wrote report.md');
}

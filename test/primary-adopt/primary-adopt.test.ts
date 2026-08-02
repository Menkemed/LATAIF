// HOTFIX-v0.8.26-PRIMARY — adoption validation + native-dialog-removal guard.
// Drives the REAL pure helpers from src/pages/settings/primary-adopt-logic.ts and asserts the
// production adoption path no longer uses window.confirm / window.prompt.
// Run: node test/primary-adopt/primary-adopt.test.ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdoptInput, explainAdoptError } from '../../src/pages/settings/primary-adopt-logic.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// ── validateAdoptInput ────────────────────────────────────────────────────────
check(validateAdoptInput('', 'pw').ok === false, 'empty email → not ok');
check(validateAdoptInput('   ', 'pw').ok === false, 'whitespace email → not ok');
check(validateAdoptInput('a@b.com', '').ok === false, 'empty password → not ok');
const good = validateAdoptInput('admin@lataif.com', 'secret-pass');
check(good.ok === true && good.error === null, 'both present → ok, no error');

// ── explainAdoptError (never echoes raw internals / secrets) ───────────────────
check(/authorization/i.test(explainAdoptError('server: OWNER_REQUIRED')), 'auth failure mapped');
check(/different installation/i.test(explainAdoptError('state is read_only, copied db')), 'read-only mapped');
const fallback = explainAdoptError('weird internal 0xDEADBEEF token=SECRETVALUE');
check(!/SECRETVALUE|DEADBEEF/.test(fallback), 'generic fallback does not echo raw error internals');
check(fallback.length > 0, 'generic fallback is non-empty');

// ── native-dialog-removal guard (production adoption path) ─────────────────────
const dialog = readFileSync(join(repo, 'src/pages/settings/PrimaryAdoptDialog.tsx'), 'utf8');
const logic = readFileSync(join(repo, 'src/pages/settings/primary-adopt-logic.ts'), 'utf8');
const settings = readFileSync(join(repo, 'src/pages/settings/SettingsPage.tsx'), 'utf8');
// match actual CALLS (with opening paren), not comment mentions
check(!/window\.confirm\(/.test(dialog) && !/window\.prompt\(/.test(dialog), 'PrimaryAdoptDialog invokes no window.confirm()/prompt()');
check(!/window\.(confirm|prompt)\(/.test(logic), 'primary-adopt-logic invokes no native dialogs');
// the broken confirm gate text is gone from SettingsPage entirely
check(!/Adopting it makes THIS installation/.test(settings), 'removed the broken window.confirm adoption gate from SettingsPage');
// the adoption handler no longer opens native dialogs
check(!/async function handleAdoptLegacy/.test(settings), 'old handleAdoptLegacy removed');
// the adoption button now opens the in-app modal
check(/setShowAdoptModal\(true\)/.test(settings), 'adoption button opens the in-app PrimaryAdoptDialog');
check(/<PrimaryAdoptDialog/.test(settings), 'PrimaryAdoptDialog is rendered');

if (fail.length) { console.error('HOTFIX-PRIMARY: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`HOTFIX-PRIMARY primary-adopt: ${pass}/${pass} checks passed`);

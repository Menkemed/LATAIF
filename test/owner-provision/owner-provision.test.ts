// HOTFIX-v0.8.25-OWNER — owner-provisioning validation + native-dialog-removal guard.
// Drives the REAL pure helpers from src/pages/settings/owner-provision-logic.ts and asserts the
// production provisioning path no longer uses window.prompt / window.confirm.
// Run: node test/owner-provision/owner-provision.test.ts
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOwnerPassword, explainOwnerError } from '../../src/pages/settings/owner-provision-logic.ts';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

// ── validateOwnerPassword ─────────────────────────────────────────────────────
check(validateOwnerPassword('', '', 12).ok === false, 'empty → not ok');
check(validateOwnerPassword('short', 'short', 12).ok === false, 'below min length → not ok');
check(/12/.test(validateOwnerPassword('short', 'short', 12).error || ''), 'length error mentions the minimum');
check(validateOwnerPassword('abcdefghijkl', 'abcdefghijXX', 12).ok === false, 'mismatch → not ok');
check(/match/i.test(validateOwnerPassword('abcdefghijkl', 'zzzzzzzzzzzz', 12).error || ''), 'mismatch error is explicit');
const good = validateOwnerPassword('abcdefghijkl', 'abcdefghijkl', 12);
check(good.ok === true && good.error === null, '≥min + matching → ok, no error');
check(validateOwnerPassword('abcdefghijklmnop', 'abcdefghijklmnop', 12).ok === true, 'longer matching → ok');

// ── explainOwnerError (never echoes raw internals / secrets) ───────────────────
check(/already/i.test(explainOwnerError('server error: OWNER_ALREADY_PROVISIONED')), 'already-provisioned mapped');
const fallback = explainOwnerError('weird internal 0xDEADBEEF token=SECRETVALUE');
check(!/SECRETVALUE|DEADBEEF/.test(fallback), 'generic fallback does not echo raw error internals');
check(fallback.length > 0, 'generic fallback is non-empty');

// ── native-dialog-removal guard (production provisioning path) ─────────────────
const dialog = readFileSync(join(repo, 'src/pages/settings/OwnerProvisionDialog.tsx'), 'utf8');
const logic = readFileSync(join(repo, 'src/pages/settings/owner-provision-logic.ts'), 'utf8');
const settings = readFileSync(join(repo, 'src/pages/settings/SettingsPage.tsx'), 'utf8');
// match actual CALLS (with opening paren), not comment mentions
check(!/window\.prompt\(/.test(dialog) && !/window\.confirm\(/.test(dialog), 'OwnerProvisionDialog invokes no window.prompt()/confirm()');
check(!/window\.(prompt|confirm)\(/.test(logic), 'owner-provision-logic invokes no native dialogs');
// the specific broken confirm gate is gone from the provisioning path
check(!/Set this machine as the sync server owner/.test(settings), 'removed the broken window.confirm provisioning gate from SettingsPage');
// the provisioning button now opens the in-app modal
check(/setShowOwnerModal\(true\)/.test(settings), 'provisioning button opens the in-app OwnerProvisionDialog');
check(/<OwnerProvisionDialog/.test(settings), 'OwnerProvisionDialog is rendered');

if (fail.length) { console.error('HOTFIX-OWNER: FAILURES:'); for (const f of fail) console.error('  ✗ ' + f); process.exit(1); }
console.log(`HOTFIX-OWNER owner-provision: ${pass}/${pass} checks passed`);

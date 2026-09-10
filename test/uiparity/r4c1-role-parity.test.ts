// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-UI-PARITY R4C.1 — dieselbe Person, dieselben Knöpfe.
// Run: node --experimental-strip-types test/uiparity/r4c1-role-parity.test.ts
//
// R4C blieb an der Identität stehen: derselbe Mensch war am Hauptrechner Eigentümer und auf dem
// zweiten Rechner Verkäufer. Der Grund war eine Vokabelfrage, kein Rechteproblem —
//
//   • Das Haus spricht kleingeschrieben: `owner`, `manager`, `sales`, `backoffice`, `viewer`.
//     Genau das steht in `user_branches.role`, und genau das schreibt der Server wörtlich in den
//     Ausweis (`create_token(… &role …)`).
//   • `sessionFromToken` prüfte gegen eine EIGENE Liste (`ADMIN|MANAGER|SALES|ACCOUNTANT`) und
//     fiel bei allem anderen still auf `SALES` zurück. `owner` stand dort nicht.
//
// Dieses Gate hält beides fest: die eine Übersetzung (`canonicalRole`), und dass gleiche Rolle
// auf beiden Rechnern zum gleichen Ergebnis führt — in BEIDE Richtungen, also auch das Nein.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    if (specifier === '@tauri-apps/api/core' || specifier === '@tauri-apps/api/event') {
      return { url: pathToFileURL(resolvePath(repo, 'test/bridge/_tauri-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '@/core/db/database' || specifier === './database' || specifier === '../db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      return { url: pathToFileURL(existsSync(p) ? p : p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { window?: unknown }).window = { localStorage: storage };

let PASS = 0; const fails: string[] = [];
const ok = (c: boolean, m: string) => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string) => readFileSync(resolvePath(repo, p), 'utf8');
const codeOf = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { sessionFromToken, readClaims } = await import('../../src/core/auth/client-session.ts');
const { canonicalRole } = await import('../../src/core/models/types.ts');
const { roleHasPermission, isAdminRole } = await import('../../src/core/auth/role-permissions.ts');

/** Ein Ausweis, wie der Server ihn ausstellt — Rumpf echt, Signatur egal (sie prüft der Server). */
function ausweis(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
}
const OWNER = { sub: 'user-owner', tenant_id: 'tenant-1', branch_id: 'branch-main', role: 'owner', email: 'admin@lataif.com' };
const SALES = { sub: 'user-staff', tenant_id: 'tenant-1', branch_id: 'branch-main', role: 'sales', email: 'staff@lataif.com' };

// ════════════════════════════════════════════════════════════════════════════
// §1 Derselbe Mensch — bewiesen an Kennungen, nicht an Namen
// ════════════════════════════════════════════════════════════════════════════
{
  const s = sessionFromToken(ausweis(OWNER));
  ok(!!s, '1 aus dem Ausweis entsteht eine Sitzung');
  ok(s?.userId === OWNER.sub, `1 dieselbe Benutzerkennung wie im Ausweis (${s?.userId})`);
  ok(s?.branchId === OWNER.branch_id, `1 dieselbe Filialkennung (${s?.branchId})`);
  ok(readClaims(ausweis(OWNER))?.sub === OWNER.sub, '1 …und sie stammt wirklich aus den Ansprüchen');
}

// ════════════════════════════════════════════════════════════════════════════
// §2/§3 Die Rolle ist das Wort des Servers — unverändert, ohne Rückfall
// ════════════════════════════════════════════════════════════════════════════
{
  const c = codeOf(src('src/core/auth/client-session.ts'));
  ok(!/const ROLES: readonly string\[\]/.test(c),
    '3 es gibt keine zweite Rollenliste im Client mehr');
  ok(!/: 'SALES'\)/.test(c) && !/\? c\.role : 'SALES'/.test(c),
    '3 …und keinen stillen Rueckfall auf SALES');
  ok(/const claim = typeof c\.role === 'string' \? c\.role\.trim\(\) : '';/.test(c),
    '3 die Rolle kommt woertlich aus dem Anspruch');
  ok(/if \(!claim\) return null;/.test(c),
    '3 …und ohne Anspruch gibt es gar keine Sitzung (fail-closed)');
  // Keine andere Quelle: nicht der Rumpf des Clients, nicht die Sitzung des Primary.
  ok(!/currentBranchId\(\)|getDatabase\(/.test(c), '3 kein lokaler Datenbankzugriff in diesem Weg');
}
{
  const s = sessionFromToken(ausweis(OWNER));
  ok(s?.role === 'owner', `3 der Eigentuemer bleibt Eigentuemer (${s?.role})`);
  const t = sessionFromToken(ausweis(SALES));
  ok(t?.role === 'sales', `3 und ein Verkaeufer bleibt Verkaeufer (${t?.role})`);
  ok(sessionFromToken(ausweis({ ...OWNER, role: undefined })) === null,
    '3 fehlt die Rolle, entsteht keine Sitzung');
  ok(sessionFromToken(ausweis({ ...OWNER, role: '  ' })) === null,
    '3 …auch nicht bei einer leeren Rolle');
}

// ════════════════════════════════════════════════════════════════════════════
// §3 Die AKTUELLE Rolle des Servers ersetzt die des Ausweises
// ════════════════════════════════════════════════════════════════════════════
{
  const c = codeOf(src('src/core/auth/client-session.ts'));
  ok(/ctx\?\.data\?\.role/.test(c) && /s\.role = rolle as Session\['role'\]/.test(c),
    '3 der Sitzungskontext liefert die aktuelle Rolle nach');
  ok(/ctx\?\.data\?\.userId === s\.userId/.test(c),
    '3 …und sie wird nur fuer DENSELBEN Menschen uebernommen');
  ok(/branch\.id !== s\.branchId\) return;/.test(c),
    '3 …und nur fuer dieselbe Filiale');
  // Der Server liest sie bei jeder geschuetzten Anfrage neu — das ist der C4-Vertrag, unveraendert.
  const rs = src('src-tauri/src/sync/reauthorize.rs');
  ok(/Active \{ role: String \}/.test(rs) && /nicht die aus dem Token/.test(rs),
    '3 der Server ersetzt die Token-Rolle bei jeder Anfrage durch die aktuelle');
  const handler = src('src/core/bridge/store-read-commands.ts');
  ok(/role: ctx\.role,/.test(handler), '3 …und die Auskunft gibt genau diese zurueck');
}

// ════════════════════════════════════════════════════════════════════════════
// §5 Gleiche Person, gleiche Filiale, gleiche Serverrolle → gleiche Knoepfe
// ════════════════════════════════════════════════════════════════════════════
{
  // Der Hauptrechner traegt DASSELBE Wort in seiner Sitzung (`user_branches.role`), und beide
  // Bildschirme fragen dieselbe Tabelle mit derselben Uebersetzung.
  const GATES = [
    ['payments.*', 'Zahlung erfassen'],
    ['invoices.*', 'Rechnung aendern'],
    ['products.edit', 'Artikel aendern'],
    ['customers.edit', 'Kunde aendern'],
  ] as const;
  for (const [perm, was] of GATES) {
    const primary = roleHasPermission('owner', perm);
    const client = roleHasPermission(sessionFromToken(ausweis(OWNER))!.role, perm);
    ok(primary === client && primary === true,
      `5 Eigentuemer: ${was} auf beiden Rechnern gleich (${primary}/${client})`);
  }
  ok(isAdminRole('owner') === isAdminRole(sessionFromToken(ausweis(OWNER))!.role),
    '5 …und die ADMIN-Knoepfe ebenso');
  ok(canonicalRole(sessionFromToken(ausweis(OWNER))!.role) === 'ADMIN',
    '5 der Eigentuemer ist kanonisch ADMIN');
}

// ════════════════════════════════════════════════════════════════════════════
// §6 Negativprobe — das ist Parität, keine Rechteausweitung
// ════════════════════════════════════════════════════════════════════════════
{
  const s = sessionFromToken(ausweis(SALES))!;
  ok(canonicalRole(s.role) === 'SALES', `6 ein Verkaeufer bleibt Verkaeufer (${canonicalRole(s.role)})`);
  for (const perm of ['payments.*', 'invoices.*']) {
    const primary = roleHasPermission('sales', perm);
    const client = roleHasPermission(s.role, perm);
    ok(primary === client && primary === false,
      `6 ${perm}: auf BEIDEN Rechnern verwehrt (${primary}/${client})`);
  }
  ok(isAdminRole('sales') === false && isAdminRole(s.role) === false,
    '6 …und die ADMIN-Knoepfe fehlen beiden');
  // Ein unbekanntes Wort landet weiterhin bei der eingeschraenktesten Rolle — aber an EINER Stelle.
  ok(canonicalRole('erfunden') === 'SALES', '6 ein unbekanntes Wort bleibt am engsten Recht');
  ok(roleHasPermission('erfunden', 'payments.*') === false,
    '6 …und darf nichts, was ein Verkaeufer nicht darf');
}
{
  // Und der Riegel dahinter: die Oberflaeche entscheidet gar nichts. Jede Fernbuchung wird am
  // Primary erneut geprueft — die Rechte-Tabelle ist dieselbe, die Quelle ist der GEPRUEFTE
  // Absender, nicht die Sitzung dieses Bildschirms.
  const c = codeOf(src('src/core/bridge/command-permissions.ts'));
  ok(/permissionForOp/.test(c), '6 der Fernweg fragt seine eigene Rechtetabelle');
  const reg = codeOf(src('src/core/bridge/command-registry.ts'));
  ok(/ALLOWED_MUTATIONS/.test(reg), '6 …und die Freigabeliste bleibt der aeussere Riegel');
  const cs = codeOf(src('src/core/auth/client-session.ts'));
  ok(!/ROLE_PERMISSIONS|hasPermission/.test(cs),
    '6 im Sitzungsweg des Clients steht keine zweite Rechtelogik');
}

// ── §8 Die R4C-Matrix bleibt unangetastet ───────────────────────────────
{
  const { R4C_MATRIX } = await import('./_r4c-write-matrix.ts');
  const verdrahtet = R4C_MATRIX.filter((z) => z.verdrahtet).length;
  const offen = R4C_MATRIX.filter((z) => z.paritaet === 'exakt' && !z.verdrahtet).length;
  const luecken = R4C_MATRIX.filter((z) => z.luecke !== null).length;
  const ohneUi = R4C_MATRIX.filter((z) => z.paritaet === 'keine-ui').length;
  // R4C.2 hat die Matrix nach dem argumentgenauen Vergleich neu gestellt: 20 verdrahtet,
  // keine offenen deckungsgleichen mehr, 18 Klasse-B-Luecken. Der Rollenvertrag ist davon
  // unberuehrt — er prueft die Zahlen nur, damit niemand ihn heimlich mitverschiebt.
  // R5B hat `products.create` und `consignments.create` geschlossen (24/0/14/2) — ohne Rollenarbeit.
  ok(verdrahtet === 24 && offen === 0 && luecken === 14 && ohneUi === 2,
    `8 die Matrix ist unveraendert (${verdrahtet}/${offen}/${luecken}/${ohneUi})`);
  const erlaubt = [...(/export const ALLOWED_MUTATIONS: readonly string\[\] = \[([\s\S]*?)\];/
    .exec(src('src/core/bridge/command-registry.ts'))?.[1] ?? '').matchAll(/'([^']+)'/g)].length;
  ok(erlaubt === 40, `8 vierzig Buchungen, keine neue (${erlaubt})`);
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central ui parity r4c.1: role authority parity: ${PASS} passed, ${fails.length} failed`);
if (fails.length > 0) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('CENTRAL_UI_R4C1_SAME_ACTOR_IDENTITY_PROVED');
console.log('CENTRAL_UI_R4C1_ROLE_CALLPATH_AUDITED');
console.log('CENTRAL_UI_R4C1_SERVER_ROLE_AUTHORITY_PROVED');
console.log('CENTRAL_UI_R4C1_PERMISSION_PARITY_PROVED');
console.log('CENTRAL_UI_R4C1_NO_PERMISSION_ESCALATION_PROVED');

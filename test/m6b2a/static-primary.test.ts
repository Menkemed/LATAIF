// M6-B2A — Static primary: LAN-Startverhalten + Quell-Nachweis, dass der Auto-Claim weg ist.
//
// Faehrt die ECHTE produktive Orchestrierung runLanStartup (src/core/sync/auto-lan.ts) mit
// injizierten Seiteneffekten. Die Rollen-ENTSCHEIDUNG selbst (Legacy-Migration,
// Instance-Binding, Write-Gate) liegt in Rust und ist dort getestet
// (src-tauri/src/sync/primary.rs, install_id.rs) — hier geht es ausschliesslich darum,
// dass KEIN Startpfad die Rolle noch veraendern kann.
//
// KEINE Live-DB, kein AppData, kein Tauri.
// Run: node test/m6b2a/static-primary.test.ts
import { readFileSync } from 'node:fs';
import { runLanStartup, type LanStartupOps, type PrimaryState } from '../../src/core/sync/lan-startup.ts';

let pass = 0; const fail: string[] = [];
const check = (c: unknown, m: string) => { if (c) pass++; else fail.push(m); };

interface Spy extends LanStartupOps {
  started: number; discovered: number; syncStarted: number; setSyncCalls: [string, string][];
}
function ops(over: Partial<LanStartupOps> & { found?: string[]; url?: string } = {}): Spy {
  const s: Spy = {
    started: 0, discovered: 0, syncStarted: 0, setSyncCalls: [],
    startServer: async () => { s.started++; },
    serverStatus: async () => ({ url: 'http://192.168.1.5:3001', selfToken: 'tok' }),
    discover: async () => { s.discovered++; return over.found ?? []; },
    currentSyncUrl: () => over.url ?? '',
    setSync: (u, t) => { s.setSyncCalls.push([u, t]); },
    startSync: () => { s.syncStarted++; },
    ...over,
  };
  return s;
}

(async () => {
  // ── P6: primary startet den Server ────────────────────────────────────────
  {
    const o = ops();
    const r = await runLanStartup('primary', o);
    check(r === 'primary', '1: P6 primary bleibt primary');
    check(o.started === 1, '2: P6 primary startet den eingebetteten Server');
    check(o.setSyncCalls.length === 1 && o.setSyncCalls[0][1] === 'tok', '3: P6 Self-Token wird als Sync-Auth gesetzt');
    check(o.syncStarted === 1, '4: P6 Auto-Sync laeuft');
    check(o.discovered === 0, '5: P6 primary braucht keine Discovery');
  }

  // ── P7: client startet NIEMALS einen Server ───────────────────────────────
  {
    const o = ops({ found: ['http://192.168.1.9:3001'] });
    const r = await runLanStartup('client', o);
    check(r === 'client', '6: P7 client bleibt client');
    check(o.started === 0, '7: P7 client startet KEINEN eingebetteten Server');
    check(o.setSyncCalls.length === 1 && o.setSyncCalls[0][0] === 'http://192.168.1.9:3001', '8: P7 gefundener Server wird konfiguriert');
    check(o.setSyncCalls[0][1] === '', '9: P7 Token bleibt leer (kommt via Login)');
  }

  // ── P4: client + mDNS findet nichts → bleibt client, KEIN Serverstart ─────
  {
    const o = ops({ found: [] });
    const r = await runLanStartup('client', o);
    check(r === 'client', '10: P4 mDNS-Timeout laesst client = client');
    check(o.started === 0, '11: P4 KEIN Auto-Claim bei leerer Discovery — der Kern des Slices');
    check(o.discovered === 1, '12: P4 Discovery lief (und blieb folgenlos)');
    check(o.setSyncCalls.length === 0, '13: P4 nichts gefunden → keine Sync-URL gesetzt');
    check(o.syncStarted === 1, '14: P14 lokaler Betrieb/Sync-Loop laeuft weiter (offline)');
  }

  // ── P4b: mDNS wirft (blockiert/aus) → immer noch kein Serverstart ─────────
  {
    const o = ops({ discover: async () => { throw new Error('mdns blocked'); } });
    const r = await runLanStartup('client', o);
    check(r === 'client', '15: P4b mDNS-Fehler laesst client = client');
    check(o.started === 0, '16: P4b mDNS-Fehler fuehrt zu KEINEM Serverstart');
    check(o.syncStarted === 1, '17: P4b Sync-Loop laeuft trotzdem');
  }

  // ── P5: unconfigured + nichts gefunden → bleibt unconfigured ──────────────
  {
    const o = ops({ found: [] });
    const r = await runLanStartup('unconfigured', o);
    check(r === 'unconfigured', '18: P5 unconfigured bleibt unconfigured');
    check(o.started === 0, '19: P8 unconfigured startet KEINEN schreibenden Server');
    check(o.discovered === 0, '20: P5 unconfigured discovert nicht einmal');
    check(o.syncStarted === 0, '21: P5 kein Auto-Sync ohne Rolle');
  }

  // ── P9: read_only fasst nichts an ─────────────────────────────────────────
  {
    const o = ops();
    const r = await runLanStartup('read_only', o);
    check(r === 'read_only', '22: P9 read_only bleibt read_only');
    check(o.started === 0 && o.setSyncCalls.length === 0 && o.syncStarted === 0,
      '23: P9 Instance-Mismatch → nichts gestartet, nichts umkonfiguriert');
  }

  // ── B2A2: legacy_adoption_required startet KEINEN Server ──────────────────
  {
    const o = ops({ found: ['http://192.168.1.9:3001'] });
    const r = await runLanStartup('legacy_adoption_required', o);
    check(r === 'legacy_adoption_required', '23a: Legacy-Hinweis bleibt Hinweis');
    check(o.started === 0,
      '23b: L3 ein unbestaetigter Legacy-Serverhinweis startet KEINEN schreibenden Server');
    check(o.setSyncCalls.length === 0 && o.syncStarted === 0,
      '23c: vor der Owner-Adoption wird nichts konfiguriert und nicht gesynct');
  }

  // ── P15: ein scheiternder Primary-Start deaktiviert die Rolle nicht ───────
  {
    const o = ops({ startServer: async () => { throw new Error('port busy'); } });
    const r = await runLanStartup('primary', o);
    check(r === 'primary', '24: P15 Startfehler aendert die Rolle NICHT (kein stilles Demoten)');
  }

  // ── P10: mehrfacher Start ist idempotent (kein Umschalten) ────────────────
  {
    const states: PrimaryState[] = [];
    for (let i = 0; i < 3; i++) states.push(await runLanStartup('client', ops({ found: [] })));
    check(states.every(s => s === 'client'), '25: P10 wiederholter Start schaltet nie um');
  }

  // ── P11: QUELL-NACHWEIS — kein Discovery-Pfad kann mode=primary schreiben ─
  const strip = (p: string) =>
    readFileSync(new URL(p, import.meta.url), 'utf8')
      .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const autoLan = strip('../../src/core/sync/auto-lan.ts');
  const startup = strip('../../src/core/sync/lan-startup.ts');
  {
    check(!/setLanMode\(\s*'server'\s*\)/.test(autoLan),
      "26: P11 auto-lan schreibt nirgends mehr setLanMode('server') — der Auto-Claim ist weg");
    const claimWrites = (autoLan.match(/primary_configure/g) || []).length;
    check(claimWrites === 1, '27: P11 genau EINE Stelle schreibt die Rolle (configurePrimaryMode)');
    // Der reine Startkern darf die Rolle ueberhaupt nicht kennen.
    check(!/primary_configure|configurePrimaryMode|setLanMode|localStorage/.test(startup),
      '28: P11 der Startpfad selbst schreibt KEINE Rolle und liest kein localStorage');
    // Die eigentliche Behauptung: im client-Zweig (dem einzigen, der discovert) darf
    // KEIN Serverstart stehen. Genau dort sass frueher der Auto-Claim.
    const clientBranch = startup.slice(startup.indexOf("case 'client'"), startup.indexOf("case 'read_only'"));
    check(clientBranch.length > 50, '29a: client-Zweig gefunden');
    check(/ops\.discover\(/.test(clientBranch), '29b: der client-Zweig discovert');
    check(!/startServer/.test(clientBranch),
      '29: P11 der discovernde Zweig startet KEINEN Server — der Auto-Claim ist ersatzlos weg');
    check(/LAN_SETUP_DONE_KEY/.test(autoLan) && !/setItem\(LAN_SETUP_DONE_KEY/.test(autoLan),
      '30: lataif_lan_setup_done wird nur noch GELESEN (Migration), nie mehr gesetzt');
    check(!/localStorage\.setItem\(LAN_MODE_KEY[\s\S]{0,80}'server'/.test(autoLan),
      '31: keine Autoritaets-Rolle mehr in localStorage geschrieben');
  }

  // ── Scope-Nachweis: B2A implementiert nichts aus spaeteren Slices ─────────
  {
    for (const forbidden of ['root_key', 'rootKey', 'certificate', 'authority_epoch', 'base_revision',
                             'canonical_records', 'bootstrap', 'argon2', 'recovery_bundle']) {
      check(!autoLan.includes(forbidden) && !startup.includes(forbidden), `32+: kein ${forbidden} in B2A`);
    }
  }

  const total = pass + fail.length;
  console.log(`\nM6-B2A static-primary: ${pass}/${total} checks passed`);
  if (fail.length) { console.log('FAILURES:'); for (const f of fail) console.log('  X ' + f); process.exit(1); }
  console.log('OK — Discovery findet nur noch; kein Timeout und kein Fehler kann eine Rolle setzen; client/unconfigured/read_only starten nie einen Server.');
})();

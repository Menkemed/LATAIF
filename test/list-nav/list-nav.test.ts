// ════════════════════════════════════════════════════════════════════════════
// LIST NAVIGATION UX (v0.8.98) — der gemerkte Listenzustand je Verlaufsschritt und die Verträge der Seiten.
// Run: node --experimental-strip-types test/list-nav/list-nav.test.ts
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const m = await import('../../src/core/ui/list-nav-memory.ts');

let PASS = 0;
const fails: string[] = [];
const ok = (c: unknown, msg: string): void => { if (c) PASS++; else { fails.push(msg); console.log('  x ' + msg); } };
const src = (p: string): string => readFileSync(join(repo, p), 'utf8');
const S = JSON.stringify;

// ── Speicher je Verlaufsschritt ────────────────────────────────────────────
{
  m.resetListNavMemoryForTest();
  const a = m.listNavId('/repairs', 'k1'), b = m.listNavId('/repairs', 'k2'), c = m.listNavId('/collection', 'k1');
  ok(a !== b && a !== c && b !== c, 'M1 Kennung trennt Pfad und Verlaufsschritt');
  ok(m.listNavSnapshot(a) === undefined, 'M1 ohne Merken nichts da (normale Navigation beginnt frisch)');
  m.rememberListNav(a, { values: { searchQuery: 'Rolex' } });
  m.rememberListNav(a, { values: { filterStatus: 'ready' } });
  m.rememberListNav(a, { scrollTop: 1234 });
  ok(S(m.listNavSnapshot(a)) === S({ values: { searchQuery: 'Rolex', filterStatus: 'ready' }, scrollTop: 1234 }), `M2 Felder und Scroll zusammengeführt (${S(m.listNavSnapshot(a))})`);
  m.rememberListNav(a, { values: { searchQuery: '' } });
  ok(m.listNavSnapshot(a)!.values.searchQuery === '' && m.listNavSnapshot(a)!.scrollTop === 1234, 'M2 leere Suche wird gemerkt, Scroll bleibt');
  ok(m.listNavSnapshot(b) === undefined && m.listNavSnapshot(c) === undefined, 'M3 andere Schritte und Seiten unberührt');
  m.resetListNavMemoryForTest();
  for (let i = 0; i < m.LIST_NAV_MAX_ENTRIES + 5; i++) m.rememberListNav(m.listNavId('/x', 'k' + i), { scrollTop: i });
  ok(m.listNavSnapshot(m.listNavId('/x', 'k0')) === undefined && m.listNavSnapshot(m.listNavId('/x', 'k4')) === undefined
    && m.listNavSnapshot(m.listNavId('/x', 'k5'))?.scrollTop === 5, `M4 höchstens ${m.LIST_NAV_MAX_ENTRIES} Schritte, die ältesten fallen heraus`);
  m.rememberListNav(m.listNavId('/x', 'k5'), { scrollTop: 55 });
  m.rememberListNav(m.listNavId('/x', 'neu'), { scrollTop: 1 });
  ok(m.listNavSnapshot(m.listNavId('/x', 'k5'))?.scrollTop === 55 && m.listNavSnapshot(m.listNavId('/x', 'k6')) === undefined,
    'M4 zuletzt gemerkt bleibt am längsten (k5 erneuert, k6 fällt heraus)');
}

// ── Scroll-Ziel immer gültig ───────────────────────────────────────────────
{
  ok(m.clampScrollTop(800, 3000, 700) === 800, 'C1 erreichbare Position bleibt genau');
  ok(m.clampScrollTop(2800, 2000, 700) === 1300, 'C2 Liste kürzer geworden → letzte gültige Position');
  ok(m.clampScrollTop(500, 400, 700) === 0, 'C3 Inhalt kürzer als Fenster → oben');
  ok(m.clampScrollTop(-5, 3000, 700) === 0 && m.clampScrollTop(Number.NaN, 3000, 700) === 0, 'C4 ungültig → oben');
}

// ── Verträge der Seiten (Quelltext) ────────────────────────────────────────
{
  const files: string[] = [];
  const walk = (d: string): void => { for (const f of readdirSync(join(repo, d))) { const p = join(d, f); if (statSync(join(repo, p)).isDirectory()) walk(p); else if (p.endsWith('.tsx')) files.push(p.replace(/\\/g, '/')); } };
  walk('src/pages');
  const withSearch = files.filter((f) => /\bshowSearch\b/.test(src(f)));
  const missing = withSearch.filter((f) => !/searchValue=\{/.test(src(f)));
  ok(withSearch.length >= 18 && missing.length === 0, `V1 jedes Seiten-Suchfeld zeigt seinen aktiven Suchtext (${withSearch.length} Seiten, ohne: ${S(missing)})`);
  const pl = src('src/components/layout/PageLayout.tsx');
  ok(/useListScrollRestore\(scrollRef\)/.test(pl) && /ref=\{scrollRef\}/.test(pl) && /visibility: restoring \? 'hidden'/.test(pl),
    'V2 PageLayout stellt die Scroll-Position je Verlaufsschritt wieder her und zeigt solange nichts (kein Sprung)');
  ok(/SearchClearButton/.test(pl) && /onSearch\?\.\(''\)/.test(pl), 'V3 „×" im Suchfeld leert die Suche');
  const hook = src('src/hooks/useListNav.ts');
  ok(/navType === 'POP'/.test(hook) && (hook.match(/isBack \?/g) || []).length === 1 && /if \(isBack\)/.test(hook),
    'V4 wiederhergestellt wird nur bei „Back" (POP); normale Navigation beginnt frisch');
  const imports = [...hook.matchAll(/from '([^']+)'/g)].map((x) => x[1]);
  ok(S(imports) === S(['react', 'react-router-dom', '@/core/ui/list-nav-memory']), `V5 nur UI: keine Datenbank, kein Store, kein Sync (${S(imports)})`);
  const mem = src('src/core/ui/list-nav-memory.ts');
  ok(!/import /.test(mem) && !/localStorage|sessionStorage|indexedDB/.test(mem), 'V5 Speicher nur im Arbeitsspeicher (nach Neustart leer)');
  const lists: Array<[string, string[]]> = [
    ['src/pages/repairs/RepairList.tsx', ['filterStatus', 'filterCustomerId', 'filterStaffId', 'sortDate', 'filterWorkType', 'filterSource', 'filterWorkshopId', 'issueFallback', 'filterInvoice', 'searchQuery']],
    ['src/pages/watches/WatchList.tsx', ['searchQuery', 'filterCategory', 'filterStatus', 'filterOwnership']],
    ['src/pages/customers/CustomerList.tsx', ['searchQuery']],
    ['src/pages/invoices/InvoiceList.tsx', ['searchQuery']],
    ['src/pages/offers/OfferList.tsx', ['filterStatus', 'searchQuery']],
    ['src/pages/orders/OrderList.tsx', ['filterStatus', 'filterType', 'searchQuery']],
    ['src/pages/purchases/PurchaseList.tsx', ['search', 'filter']],
    ['src/pages/consignments/ConsignmentList.tsx', ['search', 'statusFilter', 'tab']],
  ];
  const notKept = lists.flatMap(([f, names]) => names.filter((nm) => !new RegExp(`useListState(<[^(]*>)?\\('${nm}'`).test(src(f))).map((nm) => `${f}:${nm}`));
  ok(notKept.length === 0, `V6 Suche, Filter, Sortierung der Listen bleiben bei „Back" (${S(notKept)})`);
  const wl = src('src/pages/watches/WatchList.tsx'), cl = src('src/pages/customers/CustomerList.tsx');
  ok(!/searchQuery, setSearchQuery,? ?(filterCategory)?/.test(wl.split('useProductStore();')[0].split('const {').pop() ?? '') && !/searchQuery, setSearchQuery \} = useCustomerStore/.test(cl),
    'V7 Collection und Clients: keine unsichtbare Store-Suche mehr');
  const rd = src('src/pages/repairs/RepairDetail.tsx');
  ok(/deleteRepair\(id\);[\s\S]{0,400}goBack\(\);/.test(rd) && !/deleteRepair\(id\);[\s\S]{0,200}navigate\('\/repairs'\)/.test(rd), 'V8 nach dem Löschen einer Reparatur zurück zur Liste, wie sie verlassen wurde');
  ok(/onClick=\{goBack\}>Back/.test(src('src/pages/production/ProductionDetail.tsx')) && /onClick=\{goBack\}>Back/.test(src('src/pages/scrap-trades/ScrapTradeDetail.tsx')),
    'V9 Production und Scrap Trades: Back geht zurück statt neu zur Liste');
  ok(/navigate\(`\/repairs\?customer=\$\{id\}`\)/.test(src('src/pages/customers/CustomerDetail.tsx')) && /searchParams\.get\('customer'\)/.test(src('src/pages/repairs/RepairList.tsx')),
    'V10 „New Repair" von der Kundenseite (?customer=) unverändert');
}

console.log(`\nlist-nav: ${PASS} passed, ${fails.length} failed`);
if (fails.length) process.exit(1);

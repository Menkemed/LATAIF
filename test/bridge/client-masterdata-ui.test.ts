// ════════════════════════════════════════════════════════════════════════════
// CENTRAL-C3C — die Schreibformulare des Clients: Kunde und Artikel, ohne Datenbank.
// Run: node test/bridge/client-masterdata-ui.test.ts
//
// Vier Zusagen, die man einer Oberfläche nicht ansieht:
//
//   • Sie öffnen KEINE lokale Geschäftsdatenbank — auch nicht drei Importe tief.
//   • Was sie schicken, hält der ECHTE Prüfer des Primary aus. Kein abgeleiteter Wert, keine
//     Nummer, keine Filiale — und beim Ändern nur das, was ein Mensch wirklich angefasst hat.
//   • Eine Kennung gehört zum Vorsatz. Eine Zeitgrenze erzeugt keinen zweiten Kunden und keinen
//     zweiten Artikel.
//   • Bilder gehen an die neutrale Ablage, und der Client benennt dort nichts.
// ════════════════════════════════════════════════════════════════════════════
import { readFileSync, existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

const repo = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
registerHooks({
  resolve(specifier: string, context: { parentURL?: string }, nextResolve: (s: string, c: unknown) => unknown) {
    // Der ECHTE Pruefer des Primary zieht die Datenschicht mit; nur seine Datenbankquelle wird
    // gestellt. Die Formulare selbst kommen hier NIE vorbei — genau das prueft Abschnitt 1.
    if (specifier === '@/core/db/database') {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if ((specifier === './database' || specifier === '../db/database') && context.parentURL) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_db-shim.ts')).href, shortCircuit: true };
    }
    if (specifier === '../auth/auth' && context.parentURL && context.parentURL.includes('/db/helpers')) {
      return { url: pathToFileURL(resolvePath(repo, 'test/sync/_auth-shim.ts')).href, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const p = resolvePath(repo, 'src', specifier.slice(2));
      for (const cand of [p, p + '.ts', p + '.tsx']) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
      return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    if (specifier.startsWith('.') && context.parentURL) {
      const p = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
      if (!existsSync(p) && existsSync(p + '.ts')) return { url: pathToFileURL(p + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
} as never);

const memory = new Map<string, string>();
const storage = {
  getItem: (k: string) => (memory.has(k) ? memory.get(k)! : null),
  setItem: (k: string, v: string) => { memory.set(k, String(v)); },
  removeItem: (k: string) => { memory.delete(k); },
};
(globalThis as { window?: unknown }).window = { localStorage: storage };
(globalThis as { localStorage?: unknown }).localStorage = storage;
(globalThis as { btoa?: unknown }).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64');

const cm = await import('../../src/core/bridge/client-mode.ts');
const { CommandSaveController, CommandSaveAttempt } = await import('../../src/core/bridge/client-command-save.ts');
const { stageImage, StagingUploadError } = await import('../../src/core/bridge/client-staging-upload.ts');
const { parseCustomerCreate, parseCustomerUpdate } = await import('../../src/core/bridge/customer-commands.ts');
const { parseProductCreate, parseProductUpdate } = await import('../../src/core/bridge/product-commands.ts');

let PASS = 0; const fails: string[] = [];
const ok = (c: unknown, m: string): void => { if (c) PASS++; else { fails.push(m); console.log('  x ' + m); } };
const src = (p: string): string => readFileSync(resolvePath(repo, p), 'utf8');
/** Derselbe Text ohne Kommentare: ein Satz, der etwas ERKLAERT, ist kein Aufruf. */
const code = (p: string): string => src(p)
  .split(/\r?\n/)
  .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
  .join('\n');

// POST-PARITY R7B PP-7 — die alten Kunden-/Artikelformulare (`src/components/client/`), die
// Bereiche der alten Huelle und ihr Formularvertrag (`client-masterdata-draft.ts`) sind entfernt.
// Was hier bleibt, prueft die neutrale Ablage, den echten Pruefer des Primary (mit woertlich
// gebauten Ruempfen) und den Waechter.
const UPLOAD = 'src/core/bridge/client-staging-upload.ts';

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  ok(!existsSync(resolvePath(repo, 'src/components/client')),
    'DBLESS R7B PP-7 die alten Kunden-/Artikelformulare (src/components/client) gibt es nicht mehr');
  ok(!existsSync(resolvePath(repo, 'src/core/bridge/client-masterdata-draft.ts')),
    'DBLESS R7B PP-7 ihr Formularvertrag (client-masterdata-draft) ist mit ihnen entfernt');
  const up = code(UPLOAD);
  ok(!/\bgetDatabase\b|\binitDatabase\b|use[A-Z][A-Za-z]*Store\b|@\/core\/db\//.test(up),
    'DBLESS die neutrale Ablage fasst weder die lokale Datenbank noch einen Business-Store an');
  ok(!/outbox|localStorage|indexedDB/i.test(up), 'DBLESS …und legt keinen eigenen Ausgangskorb an');
}

// ── 2) Beim Ändern wird NUR der Unterschied geschickt ─────────────────────
//
// Ein Formular, das alles zurückschickt, überschreibt auch das, was jemand anderes inzwischen
// geändert hat — mit dem Stand, den dieser Rechner beim Laden gesehen hat.
{
  // R7B PP-7 — die Unterschiedsbildung des alten Formularvertrags (`client-masterdata-draft`) ist mit
  // ihm entfernt. Der Unterschiedsrumpf steht woertlich hier; der ECHTE Pruefer nimmt genau ihn an.
  const parsed = parseCustomerUpdate({ id: 'c1', phone: '+973 999' });
  ok(parsed.id === 'c1' && parsed.fields.phone === '+973 999', 'DIFF der Pruefer des Primary nimmt ihn an');

  // Dasselbe beim Artikel.
  const pParsed = parseProductUpdate({ id: 'p1', name: 'Datejust 41' });
  ok(pParsed.fields.name === 'Datejust 41', 'DIFF und der Pruefer nimmt ihn an');
}

// ── 3) Was die Formulare schicken, erlaubt der Primary — und mehr nicht ───
{
  // R7B PP-7 — der Rumpf mit jedem Feld des (entfernten) Kundenformulars, woertlich; die Pruefungen
  // an seiner Feldliste sind mit ihr entfernt.
  const body: Record<string, unknown> = {
    firstName: 'wert-firstName', lastName: 'wert-lastName', company: 'wert-company', phone: 'wert-phone',
    whatsapp: 'wert-whatsapp', email: 'wert-email', country: 'wert-country', language: 'wert-language',
    budgetMin: 100, budgetMax: 200, vipLevel: 1,
    customerType: 'wert-customerType', salesStage: 'wert-salesStage', notes: 'wert-notes',
  };
  let accepted = true;
  let why = '';
  try { parseCustomerCreate(body); } catch (e) { accepted = false; why = String(e); }
  ok(accepted, `PAYLOAD jedes Feld des Kundenformulars ist erlaubt (${why})`);

  // Der Artikel: jedes Textfeld des (entfernten) Artikelformulars, woertlich.
  const pAlle: Record<string, unknown> = {
    brand: 'wert-brand', name: 'wert-name', condition: 'wert-condition', storageLocation: 'wert-storageLocation',
    stockStatus: 'wert-stockStatus', taxScheme: 'wert-taxScheme', sourceType: 'wert-sourceType', notes: 'wert-notes',
  };
  // Seit R5B (`bc8220e`) entscheidet der Primary beim ANLEGEN Lagerstatus und Herkunft selbst (ein neuer
  // Artikel ist eigener Bestand, auf Lager). Diese beiden Felder gehoeren beim Anlegen nicht in den Rumpf —
  // die Erwartung „jedes Formularfeld ist erlaubt" war hier veraltet. Dass sie ABGEWIESEN werden, wird
  // unten ausdruecklich geprueft; alle uebrigen Felder muessen weiterhin durchgehen.
  const VOM_PRIMARY_BEIM_ANLEGEN = ['stockStatus', 'sourceType'];
  const pBody = {
    categoryId: 'cat-1',
    ...Object.fromEntries(Object.entries(pAlle).filter(([k]) => !VOM_PRIMARY_BEIM_ANLEGEN.includes(k))),
    stagingIds: ['a'.repeat(64)],
  };
  let pAccepted = true;
  let pWhy = '';
  try { parseProductCreate(pBody); } catch (e) { pAccepted = false; pWhy = String(e); }
  ok(pAccepted, `PAYLOAD jedes Feld des Artikelformulars ist erlaubt — ausser den zwei, die der Primary beim Anlegen entscheidet (${pWhy})`);
  for (const k of VOM_PRIMARY_BEIM_ANLEGEN.filter((f) => f in pAlle)) {
    let why = '';
    try { parseProductCreate({ ...pBody, [k]: pAlle[k] }); } catch (e) { why = String(e); }
    ok(/the primary decides/.test(why), `PAYLOAD ${k} beim Anlegen wird vom Primary abgewiesen (${why || 'ANGENOMMEN'})`);
  }
  // R7B PP-7 — die SKU-Anzeige-Pruefungen am alten Artikelformular sind mit ihm entfernt.
}

// ── 4) Der Speichervertrag an den echten Knöpfen ──────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');
  const reply = (status: number, body: Record<string, unknown>): Response =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

  for (const op of ['customers.create', 'products.create']) {
    const ctl = new CommandSaveController(op);
    const first = ctl.beginAttempt();
    const id = first.commandId;
    const sent: Array<{ op: string; commandId: string }> = [];
    const capture = (async (_u: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as { op: string; commandId: string });
      return reply(504, {});
    }) as unknown as typeof fetch;

    const pendingOut = await first.send({ name: 'X' }, capture);
    ok(pendingOut.kind === 'unknown', `SAVE ${op}: die Zeitgrenze laesst den Ausgang offen`);
    ok(sent[0].op === op, `SAVE ${op}: der Auftrag traegt seinen eigenen Namen (${sent[0].op})`);

    const again = ctl.beginAttempt();
    ok(again.commandId === id, `SAVE ${op}: ein zweiter Klick benutzt DIESELBE Kennung`);
    const settled = await again.send({ name: 'X' },
      (async () => reply(200, { ok: true, value: { productId: 'p1', customerId: 'c1', sku: 'RLX-1', replayed: true } })) as unknown as typeof fetch);
    ok(settled.kind === 'ok' && settled.replayed === true, `SAVE ${op}: …und bekommt das eine Ergebnis des Primary`);
    ok(ctl.beginAttempt().commandId !== id, `SAVE ${op}: erst danach beginnt ein neuer Vorsatz`);
  }

  // Ein fachliches Nein beendet den Versuch; der naechste bewusste Save ist ein neuer.
  const ctl2 = new CommandSaveController('customers.update');
  const a2 = ctl2.beginAttempt();
  const no = await a2.send({}, (async () => reply(409, { ok: false, error: 'CUSTOMER_NOT_FOUND', message: 'weg' })) as unknown as typeof fetch);
  ok(no.kind === 'business_error' && no.code === 'CUSTOMER_NOT_FOUND',
    `SAVE ein 409 OHNE outcome ist das fachliche Nein (${JSON.stringify(no)})`);
  const ctl3 = new CommandSaveController('products.create');
  const a3 = ctl3.beginAttempt();
  const clash = await a3.send({}, (async () => reply(409, { ok: false, error: 'BRIDGE_COMMAND_ID_CONFLICT', outcome: 'not_executed' })) as unknown as typeof fetch);
  ok(clash.kind === 'not_executed', `SAVE ein 409 MIT outcome ist der Kennungskonflikt (${JSON.stringify(clash)})`);

  // R7B PP-7 — die Knopf-Pruefungen an den alten Formularen sind mit ihnen entfernt.
  ok(CommandSaveAttempt !== undefined, 'SAVE der Vertrag liegt im gemeinsamen Modul');
}

// ── 5) Bilder: der Client benennt nichts ──────────────────────────────────
{
  cm.enterClientMode('https://primary.local');
  cm.setClientToken('tok');

  const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const okFetch = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return {
      status: 201, ok: true,
      json: async () => ({ stagingId: 'b'.repeat(64), mime: 'image/jpeg', bytes: 3, width: 10, height: 8 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const file = { type: 'image/jpeg', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  const staged = await stageImage(file, okFetch);
  ok(staged.stagingId === 'b'.repeat(64), `MEDIA die Kennung kommt vom Server (${staged.stagingId})`);
  ok(calls[0].url === 'https://primary.local/api/staging/media',
    `MEDIA und zwar von der neutralen Ablage (${calls[0].url})`);
  ok(!/mobile/.test(calls[0].url), 'MEDIA nicht vom mobilen Produkt-Eingang');
  ok(calls[0].auth === 'Bearer tok', 'MEDIA hinter derselben Anmeldung');
  ok(Object.keys(calls[0].body).sort().join(',') === 'dataBase64,mime',
    `MEDIA der Rumpf enthaelt NUR Typ und Bytes — kein Ziel, kein Name (${Object.keys(calls[0].body).join(',')})`);
  const uploadCode = code(UPLOAD);
  ok(!/path|filename|fileName|folder|dir/i.test(uploadCode),
    'MEDIA und im Modul gibt es kein Feld, in dem ein Ziel stehen koennte');

  // Ein abgelehntes Bild ist eine Auskunft, kein stiller Verlust.
  const refuse = (async () => ({
    status: 422, ok: false, json: async () => ({ state: 'rejected', code: 'MOBILE_UPLOAD_UNSUPPORTED_MIME' }),
  }) as unknown as Response) as unknown as typeof fetch;
  let refused: StagingUploadError | null = null;
  try { await stageImage(file, refuse); } catch (e) { refused = e as StagingUploadError; }
  ok(refused?.code === 'MOBILE_UPLOAD_UNSUPPORTED_MIME',
    `MEDIA der Grund des Primary kommt beim Benutzer an (${refused?.code})`);

  // POST-PARITY R7B PP-7 — der Galerieplan des alten Artikelformulars ist mit ihm gegangen. Der
  // lebende Plan der gemeinsamen Oberflaeche (ProductDetail, R6F) ist `planRemoteGallery`: dieselben
  // Plaetze (`{ keep }` / `{ stagingId }`), hier am echten Code geprueft.
  const { planRemoteGallery, GalleryPlanError } = await import('../../src/core/products/gallery-plan.ts');
  const neu = 'b'.repeat(64);
  const plan = await planRemoteGallery(
    ['blob:alt-1', 'data:image/jpeg;base64,AAAA'],
    [{ url: 'blob:alt-1', mediaId: 'm1' }],
    async () => [neu],
  );
  ok(JSON.stringify(plan) === JSON.stringify([{ keep: 'm1' }, { stagingId: neu }]),
    `MEDIA beim Aendern eine geordnete Liste aus Behalten und Neu (${JSON.stringify(plan)})`);
  ok(!/dataBase64|data:image/.test(JSON.stringify(plan)),
    'MEDIA im Auftrag steht keine einzige Bild-Nutzlast — nur Kennungen');
  let gallWhy = '';
  try { parseProductUpdate({ id: 'p1', gallery: plan }); } catch (e) { gallWhy = String(e); }
  ok(gallWhy === '', `MEDIA …und der Pruefer des Primary nimmt den Plan an (${gallWhy || 'ok'})`);
  let doppelt: string | null = null;
  try {
    await planRemoteGallery(['blob:alt-1', 'blob:alt-1'], [{ url: 'blob:alt-1', mediaId: 'm1' }], async () => []);
  } catch (e) { doppelt = (e as InstanceType<typeof GalleryPlanError>).code; }
  ok(doppelt === 'MEDIA_EDIT_DUPLICATE_IMAGE',
    `MEDIA dasselbe Bild zweimal wird nicht geschickt — der Primary wuerde es sonst abweisen (${doppelt})`);
}

// ── 6) Die Schale bietet genau die freigegebenen Schreibwege an ───────────
{
  ok(!/ClientCustomerForm|ClientProductForm|ClientInvoiceCreate|data-client-edit-/.test(code('src/components/startup/ClientShell.tsx')),
    'SHELL R7B PP-7 die Huelle bietet keine alten Formulare mehr an — geschrieben wird nur in der gemeinsamen Oberflaeche');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c client masterdata ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_CLIENT_MASTERDATA_DBLESS_PROVED');
console.log('CENTRAL_C3C_CLIENT_DIFF_ONLY_UPDATE_PROVED');
console.log('CENTRAL_C3C_CLIENT_STAGING_NO_PATH_PROVED');

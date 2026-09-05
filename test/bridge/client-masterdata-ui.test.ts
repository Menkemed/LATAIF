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
// Der Vertrag der Formulare — Feldliste und Unterschiedsbildung — liegt in einem eigenen Modul.
// Die Komponenten selbst sind Anzeige; ihre Zusagen werden hier am Quelltext geprueft.
const draft = await import('../../src/core/bridge/client-masterdata-draft.ts');
const customerUi = {
  CLIENT_CUSTOMER_FIELDS: draft.CLIENT_CUSTOMER_FIELDS,
  draftFromRemote: (row: Record<string, unknown>) => draft.draftFrom(draft.CLIENT_CUSTOMER_FIELDS, row),
  changedFields: (base: draft.Draft, now: draft.Draft) =>
    draft.diffDraft(draft.CLIENT_CUSTOMER_FIELDS, draft.CUSTOMER_NUMERIC, base, now),
};
const productUi = {
  CLIENT_PRODUCT_FIELDS: draft.CLIENT_PRODUCT_FIELDS,
  draftFromRemote: (row: Record<string, unknown>) => draft.draftFrom(draft.CLIENT_PRODUCT_FIELDS, row),
  changedFields: (base: draft.Draft, now: draft.Draft) =>
    draft.diffDraft(draft.CLIENT_PRODUCT_FIELDS, draft.PRODUCT_NUMERIC, base, now),
};
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

const CUSTOMER_FORM = 'src/components/client/ClientCustomerForm.tsx';
const PRODUCT_FORM = 'src/components/client/ClientProductForm.tsx';
const UPLOAD = 'src/core/bridge/client-staging-upload.ts';

// ── 1) Kein Weg zur lokalen Datenbank — im ganzen Importbaum ──────────────
{
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(resolvePath(repo, file), 'utf8');
    const stripped = text.split(/\r?\n/).filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    }).join('\n');
    if (/\bgetDatabase\b|\binitDatabase\b|useProductStore|useCustomerStore|useInvoiceStore|useOrderStore/.test(stripped)) {
      offenders.push(file);
    }
    for (const m of stripped.matchAll(/from '(@\/[^']+)'/g)) {
      const rel = 'src/' + m[1].slice(2);
      for (const cand of [rel, rel + '.ts', rel + '.tsx']) {
        if (existsSync(resolvePath(repo, cand)) && /\.(ts|tsx)$/.test(cand)) { visit(cand); break; }
      }
    }
  };
  visit(CUSTOMER_FORM);
  visit(PRODUCT_FORM);
  visit(UPLOAD);

  ok(seen.size > 3, `DBLESS der Importbaum wurde wirklich abgelaufen (${seen.size} Dateien)`);
  ok(offenders.length === 0,
    `DBLESS nirgends darin wird die lokale Datenbank oder ein Business-Store benutzt (${offenders.join(', ') || 'keine'})`);
  ok([...seen].every((f) => !f.startsWith('src/core/db/')),
    `DBLESS und keine Datei aus der Datenschicht ist dabei (${[...seen].filter((f) => f.startsWith('src/core/db/')).join(', ') || 'keine'})`);
  for (const f of [CUSTOMER_FORM, PRODUCT_FORM]) {
    ok(!/outbox|localStorage|indexedDB/i.test(code(f)), `DBLESS ${f} legt keinen eigenen Ausgangskorb an`);
    ok(/remoteRead/.test(src(f)), `DBLESS ${f} holt seine Daten aus der Fernquelle`);
    ok(/client-masterdata-draft/.test(src(f)),
      `WIRED ${f} faehrt genau den Vertrag, der hier geprueft wird`);
    ok(/diffDraft\(/.test(code(f)), `WIRED ${f} bildet den Unterschied nicht selbst`);
  }
}

// ── 2) Beim Ändern wird NUR der Unterschied geschickt ─────────────────────
//
// Ein Formular, das alles zurückschickt, überschreibt auch das, was jemand anderes inzwischen
// geändert hat — mit dem Stand, den dieser Rechner beim Laden gesehen hat.
{
  const loaded = customerUi.draftFromRemote({
    id: 'c1', firstName: 'Ali', lastName: 'Hassan', phone: '+973 1', vipLevel: 2, notes: 'alt',
  });
  ok(loaded.firstName === 'Ali' && loaded.vipLevel === '2',
    `DIFF der geladene Stand wird zum Formularstand (${JSON.stringify(loaded)})`);
  ok(Object.keys(customerUi.changedFields(loaded, loaded)).length === 0,
    'DIFF ohne Aenderung wird nichts geschickt');

  const touched = { ...loaded, phone: '+973 999' };
  const diff = customerUi.changedFields(loaded, touched);
  ok(Object.keys(diff).join(',') === 'phone' && diff.phone === '+973 999',
    `DIFF nur das angefasste Feld geht raus (${JSON.stringify(diff)})`);

  const cleared = customerUi.changedFields(loaded, { ...loaded, budgetMin: '' });
  ok(Object.keys(cleared).length === 0, 'DIFF ein leeres Feld, das leer war, ist keine Aenderung');
  const emptied = customerUi.changedFields({ ...loaded, budgetMin: '500' }, { ...loaded, budgetMin: '' });
  ok(emptied.budgetMin === null, 'DIFF ein GELEERTES Zahlenfeld heisst „kein Wert", nicht 0');
  const numeric = customerUi.changedFields(loaded, { ...loaded, vipLevel: '3' });
  ok(numeric.vipLevel === 3 && typeof numeric.vipLevel === 'number',
    'DIFF und eine Zahl geht als Zahl raus — der Primary weist Text ab');

  // Und der ECHTE Pruefer nimmt genau diesen Rumpf an.
  const parsed = parseCustomerUpdate({ id: 'c1', ...diff });
  ok(parsed.id === 'c1' && parsed.fields.phone === '+973 999', 'DIFF der Pruefer des Primary nimmt ihn an');

  // Dasselbe beim Artikel.
  const pLoaded = productUi.draftFromRemote({ brand: 'Rolex', name: 'Datejust', purchasePrice: 100 });
  const pDiff = productUi.changedFields(pLoaded, { ...pLoaded, name: 'Datejust 41' });
  ok(Object.keys(pDiff).join(',') === 'name', `DIFF auch beim Artikel nur das Angefasste (${JSON.stringify(pDiff)})`);
  const pParsed = parseProductUpdate({ id: 'p1', ...pDiff });
  ok(pParsed.fields.name === 'Datejust 41', 'DIFF und der Pruefer nimmt ihn an');
}

// ── 3) Was die Formulare schicken, erlaubt der Primary — und mehr nicht ───
{
  // Der Kunde: die Feldliste des Formulars ist eine TEILMENGE dessen, was der Primary annimmt.
  const draft: Record<string, string> = {};
  for (const f of customerUi.CLIENT_CUSTOMER_FIELDS) draft[f] = f === 'vipLevel' ? '1' : `wert-${f}`;
  const body = customerUi.changedFields(
    Object.fromEntries(customerUi.CLIENT_CUSTOMER_FIELDS.map((f) => [f, ''])) as never,
    draft as never,
  );
  // budgetMin/budgetMax sind Zahlenfelder — der Text oben ergibt NaN, also hier echte Zahlen.
  body.budgetMin = 100;
  body.budgetMax = 200;
  body.vipLevel = 1;
  let accepted = true;
  let why = '';
  try { parseCustomerCreate(body); } catch (e) { accepted = false; why = String(e); }
  ok(accepted, `PAYLOAD jedes Feld des Kundenformulars ist erlaubt (${why})`);

  ok(!customerUi.CLIENT_CUSTOMER_FIELDS.some((f) => ['id', 'branchId', 'totalRevenue', 'purchaseCount'].includes(f)),
    'PAYLOAD und keines der Felder gehoert dem Primary');

  // Der Artikel: dasselbe, plus die drei Dinge, die es NICHT gibt.
  ok(!productUi.CLIENT_PRODUCT_FIELDS.some((f) => ['sku', 'quantity', 'categoryId', 'images'].includes(f as string)),
    `PAYLOAD das Artikelformular kennt weder SKU noch Menge noch Bilder als Feld (${productUi.CLIENT_PRODUCT_FIELDS.join(', ')})`);
  const pDraft: Record<string, string> = {};
  for (const f of productUi.CLIENT_PRODUCT_FIELDS) pDraft[f] = f.includes('Price') ? '' : `wert-${f}`;
  const pBody = {
    categoryId: 'cat-1',
    ...productUi.changedFields(
      Object.fromEntries(productUi.CLIENT_PRODUCT_FIELDS.map((f) => [f, ''])) as never,
      pDraft as never,
    ),
    stagingIds: ['a'.repeat(64)],
  };
  let pAccepted = true;
  let pWhy = '';
  try { parseProductCreate(pBody); } catch (e) { pAccepted = false; pWhy = String(e); }
  ok(pAccepted, `PAYLOAD jedes Feld des Artikelformulars ist erlaubt (${pWhy})`);

  const form = code(PRODUCT_FORM);
  ok(!/peekSku|nextAvailableSku|allocateSku/.test(form),
    'PAYLOAD das Formular zeigt keine SKU-Vorschau — sie waere eine Luege');
  ok(/The primary assigns the item number/.test(src(PRODUCT_FORM)),
    'PAYLOAD …und sagt dem Benutzer, wer sie vergibt');
  ok(/outcome\.value\.sku/.test(form), 'PAYLOAD angezeigt wird die Nummer des Primary');
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

  // Und die Oberflaechen halten sich daran.
  for (const f of [CUSTOMER_FORM, PRODUCT_FORM]) {
    const c = code(f);
    ok(/controller\.beginAttempt\(\)/.test(c) && !/new CommandSaveAttempt\(/.test(c),
      `SAVE ${f} vergibt keine Kennung an der Wache vorbei`);
    ok(!/setTimeout|setInterval/.test(c), `SAVE ${f} hat keinen automatischen zweiten Versuch`);
    ok(/disabled=\{pending\}/.test(c), `SAVE ${f} veraendert die Eingabe nicht, waehrend ein Ausgang offen ist`);
    ok(/not known/.test(src(f)), `SAVE ${f} sagt dem Benutzer, dass der Ausgang offen ist`);
  }
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

  const formCode = code(PRODUCT_FORM);
  ok(/stagingIds: staged\.map\(\(s\) => s\.stagingId\)/.test(formCode),
    'MEDIA der Auftrag traegt nur Kennungen, keine Bytes');
  ok(!/dataBase64|data:image/.test(formCode),
    'MEDIA im Auftrag steht keine einzige Bild-Nutzlast');
  ok(/prev\.some\(\(x\) => x\.stagingId === s\.stagingId\)/.test(formCode),
    'MEDIA dasselbe Bild zweimal bleibt EIN Bild — der Primary wuerde es sonst abweisen');
}

// ── 6) Die Schale bietet genau die freigegebenen Schreibwege an ───────────
{
  const shell = code('src/components/startup/ClientShell.tsx');
  ok(/ClientInvoiceCreate/.test(shell) && /ClientCustomerForm/.test(shell) && /ClientProductForm/.test(shell),
    'SHELL drei Formulare: Rechnung, Kunde, Artikel');
  ok(/editCustomerId/.test(shell) && /editProductId/.test(shell),
    'SHELL …und je ein Aendern, das an einem GELESENEN Datensatz beginnt');
  ok(!/data-client-delete|deleteCustomer|deleteProduct/.test(shell),
    'SHELL kein Loeschen — das steht auf keiner Zulassungsliste');
  // Das Aendern beginnt nie an einer frei eingetippten Kennung.
  ok(/setEditCustomerId\(s\(detail\.id\)\)/.test(shell) && /setEditProductId\(s\(detail\.id\)\)/.test(shell),
    'SHELL die Kennung kommt aus dem gelesenen Datensatz, nicht aus einem Eingabefeld');
}

console.log(`\n${fails.length === 0 ? 'PASS' : 'FAIL'} — central c3c client masterdata ui: ${PASS} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('   - ' + f); process.exit(1); }
console.log('CENTRAL_C3C_CLIENT_MASTERDATA_DBLESS_PROVED');
console.log('CENTRAL_C3C_CLIENT_DIFF_ONLY_UPDATE_PROVED');
console.log('CENTRAL_C3C_CLIENT_STAGING_NO_PATH_PROVED');

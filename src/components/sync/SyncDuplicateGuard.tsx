// Plan §Sync-Duplicate-Detection
// ─────────────────────────────────────────────────────────────────────────
// Reagiert auf neue Produkte, die per Sync (typischerweise Phone-Upload via
// LAN-Sync-Server) hereinkommen. Für jedes neue Item läuft der gleiche
// Score-Helper wie beim Live-Check beim Anlegen (productStore.findPossibleDuplicates).
// Bei Treffer wird ein Side-by-Side-Modal angeboten:
//
//   • Bestätigen → mergeIntoExisting (qty++, Source löschen)
//   • Ablehnen   → als eigenes Item behalten (no-op, dismiss)
//
// Mehrere Hits werden serialisiert: nach Entscheidung des aktuellen Items
// rückt der nächste aus der Queue nach.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { StatusDot } from '@/components/ui/StatusDot';
import { Bhd } from '@/components/ui/Bhd';
import { Package, ArrowRight, Plus } from 'lucide-react';
import { getRecentCorrectionsAsPrompt, useProductStore } from '@/stores/productStore';
import { computeImageEmbedding, cosineSimilarity, isAiConfigured, pairwiseVisualMatch, type AiCategoryId } from '@/core/ai/ai-service';
import { identifyProductFromResolvedInput } from '@/core/ai/identify-adapter';
import { getDatabase, saveDatabase } from '@/core/db/database';
import { trackUpdate } from '@/core/sync/track';
import { frozenSyncTarget, shouldApplySyncAutoIdentify } from '@/core/media/ai-image-source';
import { skuIsEmpty } from '@/core/products/sku-allocation';
import type { Product } from '@/core/models/types';

// Per-product supersession registry for sync auto-identify: a newer run for the
// same product bumps the epoch, so the older in-flight run refuses to apply.
const syncAutoIdentifyEpoch = new Map<string, number>();

interface PendingReview {
  incoming: Product;
  matches: Array<{ product: Product; score: number; reasons: string[] }>;
}

// SKU-ALLOC — the seed builder moved to `core/products/sku-allocation` so the drain, the store
// and this guard cannot drift; `buildSkuSeed` is the shared canonical-brand + category rule.

const VALID_AI_CATEGORIES = new Set<string>([
  'cat-watch', 'cat-gold-jewelry', 'cat-branded-gold-jewelry',
  'cat-original-gold-jewelry', 'cat-accessory', 'cat-spare-part',
]);

/** Auto-AI-Identify fuer ein einzelnes Produkt — wird genutzt:
 *  (1) nach Mobile-Upload wenn KEIN Duplikat erkannt wurde
 *  (2) wenn der User das Duplicate-Modal abbricht (= behalten als eigenes Item)
 *  Silent: skip bei fehlendem API-Key / Foto / unbekannter Kategorie / bereits
 *  AI-identifiziert. Schreibt brand/name/sku/condition/attributes etc. via
 *  updateProduct ohne user-typed Daten zu zerstoeren. */
async function runAutoIdentify(productId: string): Promise<void> {
  if (!isAiConfigured()) return;
  const incoming = useProductStore.getState().products.find(p => p.id === productId);
  if (!incoming) return;
  if (!incoming.images || incoming.images.length === 0) return;
  if (!VALID_AI_CATEGORIES.has(incoming.categoryId)) return;
  const alreadyIdentified = !!incoming.condition && !!incoming.name && incoming.name.trim().length > 3;
  if (alreadyIdentified) return;

  // Freeze the target (product id + primary image ref) and claim a fresh epoch
  // BEFORE the async AI call — a newer run for the same product supersedes this.
  const frozen = frozenSyncTarget({ id: productId, imageRef: incoming.images[0] });
  const myEpoch = (syncAutoIdentifyEpoch.get(productId) ?? 0) + 1;
  syncAutoIdentifyEpoch.set(productId, myEpoch);

  try {
    // MEDIA-04A-3B2C3-R3: route the synced image through the SINGLE central
    // adapter (fail-closed on a malformed/oversized/non-raster remote payload;
    // never a direct provider call). Require a validated image — the sync
    // auto-identify has no text-only fallback.
    const aiOut = await identifyProductFromResolvedInput({
      productId: undefined,
      formImage0: incoming.images[0],
      categoryId: incoming.categoryId as AiCategoryId,
      hints: {
        brand: incoming.brand || undefined,
        name: incoming.name || undefined,
        reference: incoming.sku || undefined,
      },
      recentCorrections: getRecentCorrectionsAsPrompt(incoming.brand, incoming.categoryId),
    });
    if (!aiOut.ok || !aiOut.usedImage) return; // unsafe/invalid remote image → skip
    const result = aiOut.result;
    const store = useProductStore.getState();
    const current = store.products.find(p => p.id === productId);
    // Stale-target guard: skip if the product vanished, its primary image changed
    // or was removed under the in-flight call, or a newer auto-identify run for
    // this product superseded us.
    if (!shouldApplySyncAutoIdentify({
      myEpoch,
      latestEpoch: syncAutoIdentifyEpoch.get(productId) ?? myEpoch,
      targetExists: !!current,
      frozenImageKey: frozen.imageKey,
      currentImageKey: current?.images?.[0],
    })) return;
    if (!current) return; // guard already covers this; narrows the type below.
    const patch: Partial<Product> = {};
    if (result.brand) patch.brand = result.brand;
    if (result.name) patch.name = result.name;
    // SKU MANDATORY: empty / 'null' / 'undefined' / whitespace → fill. The emptiness rule is
    // shared with the drain, so both surfaces agree on what "has no SKU" means.
    if (skuIsEmpty(current.sku)) {
      // SKU-UNIFY — this patch is persisted immediately, so it is a real ALLOCATION and must claim
      // from the shared durable counter. The list-based suggestion it used before forgot a number
      // as soon as its product was deleted, and handed that retired number to the next item. The
      // AI does not decide the SKU either: the stem is brand + category, exactly as on mobile.
      patch.sku = store.allocateSkuOnCreate(undefined, result.brand || current.brand, current.categoryId);
    }
    if (result.condition) patch.condition = result.condition;
    if (result.description) {
      patch.notes = current.notes ? `${current.notes}\n\n${result.description}` : result.description;
    }
    if (result.estimatedValue && !current.plannedSalePrice) patch.plannedSalePrice = result.estimatedValue;
    if (result.taxScheme && !current.taxScheme) patch.taxScheme = result.taxScheme;
    if (Array.isArray(result.scopeOfDelivery) && result.scopeOfDelivery.length > 0
        && (!current.scopeOfDelivery || current.scopeOfDelivery.length === 0)) {
      patch.scopeOfDelivery = result.scopeOfDelivery;
    }
    const attrs = { ...(current.attributes || {}) } as Record<string, string | number | boolean | string[]>;
    let attrsChanged = false;
    for (const [k, v] of Object.entries(result.attributes || {})) {
      if (v === null || v === undefined || v === '') continue;
      if (attrs[k] === undefined || attrs[k] === '') {
        attrs[k] = v as string | number | boolean | string[];
        attrsChanged = true;
      }
    }
    if (attrsChanged) patch.attributes = attrs;
    // AI-Learning: Snapshot dessen was die AI vorgeschlagen hat speichern.
    // Wir picken nur die "lernbaren" Felder (Brand/Name/SKU/Condition + alle
    // Attribute) — Marktpreise und Notes sind nicht relevant fuers Lernen.
    const snapshot = {
      brand: result.brand,
      name: result.name,
      sku: result.sku,
      condition: result.condition,
      attributes: result.attributes,
      identificationConfidence: result.identificationConfidence,
      at: new Date().toISOString(),
    };
    patch.aiIdentifiedSnapshot = JSON.stringify(snapshot);
    if (Object.keys(patch).length === 0) return;
    store.updateProduct(productId, patch);
    console.info('[SyncGuard] auto-identified', productId, Object.keys(patch).join(','));
  } catch (err) {
    console.warn('[SyncGuard] auto-identify failed for', productId, err);
  }
}

function scoreLabel(score: number): { text: string; color: string; bg: string } {
  if (score >= 100) return { text: 'Almost certainly duplicate', color: '#AA6E6E', bg: 'rgba(170,110,110,0.10)' };
  if (score >= 60)  return { text: 'Likely duplicate',           color: '#AA956E', bg: 'rgba(170,149,110,0.12)' };
  return { text: 'Possibly similar', color: '#6E8AAA', bg: 'rgba(110,138,170,0.12)' };
}

function specsOf(p: Product): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (p.sku) out.push({ label: 'SKU', value: p.sku });
  const attrs = p.attributes || {};
  const ref = String(attrs.reference_number || attrs.reference || attrs.referenceNo || '').trim();
  if (ref) out.push({ label: 'Ref', value: ref });
  const serial = String(attrs.serial_number || attrs.serialNo || '').trim();
  if (serial) out.push({ label: 'Serial', value: serial });
  const modelNo = String(attrs.model_number || '').trim();
  if (modelNo) out.push({ label: 'Model No', value: modelNo });
  const weight = Number(attrs.weight) || 0;
  const karat = String(attrs.karat || '').trim();
  if (weight > 0) out.push({ label: 'Weight', value: `${weight}g${karat ? ' · ' + karat : ''}` });
  const itemType = String(attrs.item_type || '').trim();
  if (itemType) out.push({ label: 'Type', value: itemType });
  const caseSize = String(attrs.case_diameter_mm || attrs.case_size || '').trim();
  if (caseSize) out.push({ label: 'Case', value: `${caseSize}${/^\d+$/.test(caseSize) ? ' mm' : ''}` });
  return out;
}

function ItemImage({ src, size = 130 }: { src?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, background: '#F2F7FA', borderRadius: 8,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden', border: '1px solid #E5E9EE',
    }}>
      {src ? (
        <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <Package size={size * 0.28} strokeWidth={1} style={{ color: '#6B7280' }} />
      )}
    </div>
  );
}

function SpecGrid({ specs }: { specs: { label: string; value: string }[] }) {
  if (specs.length === 0) return null;
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px',
      fontSize: 11, marginTop: 10,
    }}>
      {specs.map((s, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <span style={{ color: '#6B7280' }}>{s.label}</span>
          <span style={{ color: '#0F0F10' }} className="font-mono">{s.value}</span>
        </div>
      ))}
    </div>
  );
}

export function SyncDuplicateGuard() {
  const navigate = useNavigate();
  const { products, mergeIntoExisting } = useProductStore();
  const [queue, setQueue] = useState<PendingReview[]>([]);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    async function handle(ev: Event) {
      const ce = ev as CustomEvent<{ ids: string[] }>;
      const ids = ce.detail?.ids || [];
      if (ids.length === 0) return;

      // ═══════════════════════════════════════════════════════════
      // Mobile-Upload Flow (2026-05-18 — rewrite):
      // Phone-Items kommen mit Foto + ggf. Brand-String, KEINE SKU/Serial/Ref.
      // Text-Match ist daher hinfaellig — wir entscheiden ausschliesslich per
      // AI-Foto-Embedding ob ein Duplikat existiert.
      //
      // Schritt 1: Embeddings fuer alle eingehenden Items berechnen (AWAIT).
      // Schritt 2: Cosine-Vergleich gegen bestehende Items (image-only mode).
      //            Bei Treffer → User-Modal "Merge oder behalten?"
      // Schritt 3: Wenn KEIN Duplikat → identifyProduct fuellt alle Felder.
      //
      // Ohne API-Key bricht das System graceful ab (keine Embeddings, kein
      // Identify) — User behaelt das Roh-Item mit Brand/Foto.
      // ═══════════════════════════════════════════════════════════

      // ── Schritt 1: Embeddings sequentiell berechnen ─────────────────────
      if (isAiConfigured()) {
        const state0 = useProductStore.getState();
        for (const id of ids) {
          const incoming = state0.products.find(p => p.id === id);
          if (!incoming) continue;
          if (incoming.imageEmbedding && incoming.imageEmbedding.length > 0) continue;
          if (!incoming.images || incoming.images.length === 0) continue;
          try {
            const { description, embedding } = await computeImageEmbedding(incoming.images[0]);
            getDatabase().run(
              'UPDATE products SET image_description = ?, image_embedding = ? WHERE id = ?',
              [description, JSON.stringify(embedding), id],
            );
            saveDatabase();
            trackUpdate('products', id, { imageDescription: description, imageEmbedding: embedding });
          } catch (err) {
            console.warn('[SyncGuard] embedding failed for', id, err);
          }
        }
        useProductStore.getState().loadProducts();
      }

      // ── Schritt 2: Two-Stage Duplicate-Check (selbe Logik wie Find-Duplicates) ──
      // Stage 1: Cosine-Pre-Filter ueber Embeddings (lokal, gratis) — findet
      //          Kandidaten mit visuell aehnlicher Beschreibung. Threshold 0.75
      //          ist absichtlich grosszuegig (recall).
      // Stage 2: pairwiseVisualMatch — GPT-4o-mini-Vision sieht BEIDE Fotos
      //          direkt und entscheidet "selbes physisches Produkt?". Nur
      //          isMatch=true (high confidence) wird als Duplikat akzeptiert.
      //          So vermeidet das Embedding-Falsch-Positiv-Problem (alle Rolex
      //          sehen im Text-Embedding aehnlich aus, sind aber verschiedene Modelle).
      // Ohne API-Key: Fallback auf strictere Cosine-Schwelle 0.92.
      const stateAfterEmb = useProductStore.getState();
      const reviews: PendingReview[] = [];
      const duplicateFoundIds = new Set<string>();
      const STAGE1_THRESHOLD = 0.75;
      const STRICT_FALLBACK = 0.92;

      for (const id of ids) {
        const incoming = stateAfterEmb.products.find(p => p.id === id);
        if (!incoming) continue;
        if (!incoming.imageEmbedding || incoming.imageEmbedding.length === 0) continue;
        if (!incoming.images || incoming.images.length === 0) continue;

        // Stage 1: Cosine-Pre-Filter
        const candidates: Array<{ product: Product; cosine: number }> = [];
        for (const p of stateAfterEmb.products) {
          if (p.id === id) continue;
          if (!p.imageEmbedding || p.imageEmbedding.length === 0) continue;
          if (p.categoryId !== incoming.categoryId) continue;
          if (!p.images || p.images.length === 0) continue;
          const cos = cosineSimilarity(incoming.imageEmbedding, p.imageEmbedding);
          if (cos >= STAGE1_THRESHOLD) candidates.push({ product: p, cosine: cos });
        }
        candidates.sort((a, b) => b.cosine - a.cosine);
        const top = candidates.slice(0, 5); // bound LLM cost
        if (top.length === 0) continue;

        if (!isAiConfigured()) {
          // Fallback ohne LLM: nur sehr enge Cosine-Treffer zaehlen.
          const strict = top.filter(c => c.cosine >= STRICT_FALLBACK);
          if (strict.length > 0) {
            reviews.push({
              incoming,
              matches: strict.map(c => ({
                product: c.product,
                score: Math.round(c.cosine * 100),
                reasons: [`Foto-Match Cosine ${c.cosine.toFixed(2)} (no API)`],
              })),
            });
            duplicateFoundIds.add(id);
          }
          continue;
        }

        // Stage 2: GPT-4o-mini-Vision pairwise
        const confirmed: Array<{ product: Product; score: number; reasons: string[] }> = [];
        for (const c of top) {
          try {
            const result = await pairwiseVisualMatch(incoming.images[0], c.product.images[0]);
            if (result.isMatch) {
              confirmed.push({
                product: c.product,
                score: Math.round(c.cosine * 100),
                reasons: [`AI Vision: ${result.reason}`, `Cosine ${c.cosine.toFixed(2)}`],
              });
            }
          } catch (err) {
            console.warn('[SyncGuard] pairwise check failed:', id, err);
          }
        }
        if (confirmed.length > 0) {
          reviews.push({ incoming, matches: confirmed });
          duplicateFoundIds.add(id);
        }
      }
      if (reviews.length > 0) {
        setQueue(prev => {
          const known = new Set(prev.map(r => r.incoming.id));
          return [...prev, ...reviews.filter(r => !known.has(r.incoming.id))];
        });
      }

      // ── Schritt 3: AI Identify fuer Nicht-Duplikate ─────────────────────
      // Items die als Duplikat erkannt wurden bekommen kein Identify hier —
      // wenn der User das Modal abbricht ("behalten als eigenes"), wird
      // runAutoIdentify dort nachgereicht (siehe keepAsNew).
      for (const id of ids) {
        if (duplicateFoundIds.has(id)) continue;
        runAutoIdentify(id);
      }
    }
    window.addEventListener('lataif:sync-products-inserted', handle as EventListener);
    return () => window.removeEventListener('lataif:sync-products-inserted', handle as EventListener);
  }, []);

  const current = queue[0];
  // Aktuelle Produkte aus dem Store ziehen — incoming/match könnten in der
  // Zwischenzeit modifiziert sein (z.B. anderer Peer hat schon gemerged).
  const incoming = current ? products.find(p => p.id === current.incoming.id) : null;
  const topMatch = current?.matches[0];
  const existing = topMatch ? products.find(p => p.id === topMatch.product.id) : null;

  function dequeue() {
    setQueue(prev => prev.slice(1));
  }

  function keepAsNew() {
    // "Ablehnen" / "Behalten als eigenes Item" — User hat entschieden dass es
    // KEIN Duplikat ist. Wir reichen das AI-Identify nach (fuellt brand/name/
    // sku/condition/attributes etc.) — der Mobile-Upload kommt schliesslich mit
    // leeren Feldern und ohne Identify bleibt das Item als nackter Brand-Stub
    // in der Datenbank.
    if (current?.incoming.id) {
      runAutoIdentify(current.incoming.id);
    }
    dequeue();
  }

  function confirmMerge() {
    if (!incoming || !existing) { dequeue(); return; }
    setActionBusy(true);
    try {
      mergeIntoExisting(incoming.id, existing.id);
      // Learning-Signal: User hat confirmed dass beide Items dasselbe sind.
      // Das existing-Item wird die Canonical Reference — markieren als bestaetigt.
      if (!existing.aiConfirmedAt) {
        useProductStore.getState().updateProduct(existing.id, {
          aiConfirmedAt: new Date().toISOString(),
        } as Partial<Product>);
      }
      dequeue();
    } catch (e) {
      console.error('[SyncDuplicateGuard] merge failed:', e);
      alert(`Merge fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  // Watch-spezifisch (2026-05-18): "Daten uebernehmen" statt qty++.
  // Jede Uhr hat eigene Serial → physisch eigene Item — wir kopieren nur die
  // Modell-Daten (brand/name/reference/attributes ohne serial) damit der
  // neue Eintrag schon vollstaendig identifiziert ist. Beide Items werden als
  // aiConfirmed markiert (positiver Lern-Signal: User hat bestaetigt dass die
  // AI-Erkennung des Modells stimmt).
  function copyDetailsFromExisting() {
    if (!incoming || !existing) { dequeue(); return; }
    setActionBusy(true);
    try {
      const sourceAttrs = (existing.attributes || {}) as Record<string, unknown>;
      const copiedAttrs: Record<string, string | number | boolean | string[]> = {};
      for (const [k, v] of Object.entries(sourceAttrs)) {
        if (k === 'serial_number' || k === 'serialNo') continue; // unique per piece
        if (v === null || v === undefined || v === '') continue;
        copiedAttrs[k] = v as string | number | boolean | string[];
      }
      // User-typed Werte am incoming sind staerker — nicht ueberschreiben.
      const incomingAttrs = (incoming.attributes || {}) as Record<string, string | number | boolean | string[]>;
      const finalAttrs: Record<string, string | number | boolean | string[]> = { ...copiedAttrs };
      for (const [k, v] of Object.entries(incomingAttrs)) {
        if (v !== null && v !== undefined && v !== '') finalAttrs[k] = v;
      }
      // Serial bleibt explizit leer (User trags selbst nach beim individuellen Item).
      delete finalAttrs.serial_number;
      delete finalAttrs.serialNo;

      const store = useProductStore.getState();
      // SKU-UNIFY — written straight into the product below, so it claims durably like every
      // other create rather than reading the next number off the in-memory list.
      const nextSku = store.allocateSkuOnCreate(undefined, existing.brand, existing.categoryId);

      store.updateProduct(incoming.id, {
        brand: existing.brand,
        name: existing.name,
        sku: nextSku,
        condition: incoming.condition || existing.condition,
        taxScheme: existing.taxScheme,
        scopeOfDelivery: incoming.scopeOfDelivery?.length ? incoming.scopeOfDelivery : existing.scopeOfDelivery,
        plannedSalePrice: incoming.plannedSalePrice || existing.plannedSalePrice,
        attributes: finalAttrs,
        aiConfirmedAt: new Date().toISOString(),
      } as Partial<Product>);

      // Existing wird die Canonical-Reference fuer dieses Modell.
      if (!existing.aiConfirmedAt) {
        store.updateProduct(existing.id, {
          aiConfirmedAt: new Date().toISOString(),
        } as Partial<Product>);
      }

      dequeue();
    } catch (e) {
      console.error('[SyncDuplicateGuard] copy-details failed:', e);
      alert(`Copy failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActionBusy(false);
    }
  }

  function openExisting() {
    if (!existing) return;
    dequeue();
    navigate(`/collection/${existing.id}`);
  }

  // Edge-Cases: wenn Items zwischen Event-Empfang und Render verschwunden
  // sind (anderer Peer hat sie schon gelöscht), Queue-Eintrag stillschweigend
  // skippen.
  if (current && (!incoming || !existing || !topMatch)) {
    setTimeout(() => dequeue(), 0);
    return null;
  }
  if (!current || !incoming || !existing || !topMatch) return null;

  const lbl = scoreLabel(topMatch.score);
  const incomingSpecs = specsOf(incoming);
  const existingSpecs = specsOf(existing);
  const incomingQty = Math.max(1, incoming.quantity || 1);
  const newQty = (existing.quantity || 1) + incomingQty;

  return (
    <Modal open={true} onClose={keepAsNew} title="Möglicher Duplikat-Upload erkannt" width={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          padding: '10px 14px', borderRadius: 8,
          background: 'rgba(170,149,110,0.10)', border: '1px solid rgba(170,149,110,0.25)',
          fontSize: 13, color: '#0F0F10', lineHeight: 1.5,
        }}>
          Ein über Sync hochgeladenes Item sieht aus wie ein bereits bestehender Artikel.
          Vergleiche beide — bei <strong>Bestätigen</strong> wird die Menge des bestehenden Artikels um {incomingQty} erhöht und das neue gelöscht.
          {queue.length > 1 && (
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#6B7280' }}>
              {queue.length - 1} weitere Pair{queue.length - 1 === 1 ? '' : 's'} warten danach.
            </span>
          )}
        </div>

        {/* Side-by-Side */}
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 14, alignItems: 'stretch',
        }}>
          {/* INCOMING — left (gerade per Sync angekommen) */}
          <div style={{
            padding: 14, border: '1px dashed #AA956E', borderRadius: 10,
            background: 'rgba(170,149,110,0.04)',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <span className="text-overline" style={{ color: '#AA956E' }}>NEU (per Sync)</span>
            <ItemImage src={incoming.images?.[0]} />
            <div style={{ marginTop: 4, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{incoming.brand || '—'}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {incoming.name || 'Untitled'}
              </div>
              <SpecGrid specs={incomingSpecs} />
              {incomingQty > 1 && (
                <div className="font-mono" style={{ fontSize: 11, color: '#AA956E', marginTop: 6 }}>
                  Quantity: {incomingQty}
                </div>
              )}
            </div>
          </div>

          {/* Arrow */}
          <div style={{ display: 'flex', alignItems: 'center', color: '#6B7280', paddingTop: 90 }}>
            <ArrowRight size={20} />
          </div>

          {/* EXISTING — right */}
          <div style={{
            padding: 14, border: '1px solid #E5E9EE', borderRadius: 10,
            background: '#FFFFFF',
            display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0,
          }}>
            <div className="flex items-center justify-between">
              <span className="text-overline" style={{ color: '#0F0F10' }}>BESTEHEND</span>
              <StatusDot status={existing.stockStatus} />
            </div>
            <ItemImage src={existing.images?.[0]} />
            <div style={{ marginTop: 4, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: '#6B7280' }}>{existing.brand}</div>
              <div style={{ fontSize: 14, color: '#0F0F10', fontWeight: 500, lineHeight: 1.3 }}>
                {existing.name}
              </div>
              <SpecGrid specs={existingSpecs} />
              <div className="flex items-center" style={{ gap: 10, marginTop: 8, fontSize: 12 }}>
                <span className="font-mono" style={{ color: '#4B5563' }}>
                  Qty: {existing.quantity || 1} → <strong style={{ color: '#7EAA6E' }}>{newQty}</strong>
                </span>
                {existing.plannedSalePrice ? (
                  <span className="font-mono" style={{ color: '#0F0F10' }}>
                    · <Bhd v={existing.plannedSalePrice}/> BHD
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Reason chips */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
          padding: '10px 14px', borderRadius: 8, background: 'rgba(15,15,16,0.03)',
          border: '1px solid #E5E9EE',
        }}>
          <span style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 999,
            color: lbl.color, background: lbl.bg, border: `1px solid ${lbl.color}40`,
            fontWeight: 500,
          }}>{lbl.text}</span>
          <span style={{ fontSize: 11, color: '#6B7280' }}>Why:</span>
          {topMatch.reasons.map((r, i) => (
            <span key={i} style={{
              fontSize: 11, padding: '2px 8px', borderRadius: 999,
              background: '#FFFFFF', color: '#4B5563', border: '1px solid #E5E9EE',
            }}>{r}</span>
          ))}
        </div>

        {/* Footer — Watches haben "Daten uebernehmen" statt qty-Merge weil
            jede Uhr ihre eigene Serial hat (physisch eigene Items). Andere
            Kategorien (Gold/Accessory/etc.) behalten Menge-Merge. */}
        {incoming.categoryId === 'cat-watch' ? (
          <div className="flex justify-end gap-3" style={{
            paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap',
          }}>
            <Button variant="ghost" onClick={openExisting}>Bestehenden öffnen</Button>
            <Button variant="secondary" onClick={keepAsNew} disabled={actionBusy}>
              Ablehnen — als neu behalten
            </Button>
            <Button variant="primary" onClick={copyDetailsFromExisting} disabled={actionBusy}>
              <Plus size={14} /> Daten übernehmen (ohne Serial)
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-3" style={{
            paddingTop: 12, borderTop: '1px solid #E5E9EE', flexWrap: 'wrap',
          }}>
            <Button variant="ghost" onClick={openExisting}>Bestehenden öffnen</Button>
            <Button variant="secondary" onClick={keepAsNew} disabled={actionBusy}>
              Ablehnen — als neu behalten
            </Button>
            <Button variant="primary" onClick={confirmMerge} disabled={actionBusy}>
              <Plus size={14} /> Bestätigen — Menge erhöhen ({newQty})
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

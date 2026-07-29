// MOBILE-04B2A9-I1 — durable collection upload queue for the mobile capture page.
//
// Pure, injectable logic (no globals of its own beyond the single export) so it is node-testable with an
// in-memory store + a fake fetch. Included verbatim into MOBILE_HTML via concat!(include_str!). The mobile
// page wires the real IndexedDB store + fetch + a Math.random uuid; here we only define behaviour:
//   * an upload is persisted (uploadEventId + entityId + metadata + image bytes) BEFORE the first request,
//     so a reload/restart resumes the SAME upload with the SAME ids — never a second event.
//   * exactly one send per entry (single-flight); a stale `sending` (crash mid-send) recovers to retryable.
//   * the /api/mobile/upload result contract decides the next state; an UNKNOWN result never deletes.
// Image bytes live only in IndexedDB (the store), never in localStorage.
(function (global) {
  'use strict';

  // Terminal states keep the entry (conflict/rejected) or remove it (done). Non-terminal: queued|sending|retryable.
  var TERMINAL_KEEP = { conflict: 1, rejected: 1 };

  // Strip a `data:image/...;base64,` prefix so the ingress DTO gets raw base64 only.
  function stripDataUrl(s) {
    if (typeof s !== 'string') return '';
    var i = s.indexOf('base64,');
    return i >= 0 ? s.slice(i + 7) : s;
  }

  // The /api/mobile/upload result contract → an outcome. Fetch-threw / status 0 / anything unrecognised is
  // treated as retryable so an unknown result NEVER deletes a durable entry.
  function classify(status) {
    if (status === 201 || status === 200) return 'done';       // accepted, or idempotent replay
    if (status === 409) return 'conflict';                      // permanent: same event id, different content
    if (status === 401 || status === 403) return 'reauth';     // keep; re-authenticate, then retry same id
    if (status === 413 || status === 422) return 'rejected';   // permanent: too large / invalid → keep + show
    if (status === 503) return 'retryable';                    // transient
    return 'retryable';                                        // network error / unknown → retry, never delete
  }

  // Build the exact /api/mobile/upload request body from a durable entry.
  function buildRequest(entry) {
    return {
      protocol_version: 1,
      upload_event_id: entry.uploadEventId,
      entity_id: entry.entityId,
      mode: 'collection',
      metadata: entry.metadata,
      images: (entry.images || []).map(function (d) { return { mime: 'image/jpeg', data_base64: stripDataUrl(d) }; }),
    };
  }

  // store: async get(id) / put(entry) / delete(id) / getAll(). fetchFn(url, opts) → {status} or throws.
  // genId() → a stable id string. now() → iso timestamp.
  function createQueue(deps) {
    var store = deps.store, fetchFn = deps.fetchFn, genId = deps.genId, now = deps.now;
    var inFlight = {}; // uploadEventId → true, single-flight guard within this runtime.

    // Persist a NEW upload before any request. ids are minted exactly ONCE here.
    async function enqueue(input) {
      var entry = {
        uploadEventId: genId(),
        entityId: genId(),
        metadata: input.metadata,
        images: input.images || [],
        state: 'queued',
        createdAt: now(),
        updatedAt: now(),
        lastStatus: null,
      };
      await store.put(entry);
      return entry;
    }

    // On startup: a `sending` entry means a crash mid-send — make it retryable again (same ids).
    async function recoverStaleSending() {
      var all = await store.getAll();
      for (var i = 0; i < all.length; i++) {
        if (all[i].state === 'sending') {
          all[i].state = 'retryable';
          all[i].updatedAt = now();
          await store.put(all[i]);
        }
      }
    }

    function isDrainable(entry) {
      return entry && (entry.state === 'queued' || entry.state === 'retryable');
    }

    // Send ONE entry at most once (single-flight). Never loops. Returns { outcome, status }.
    async function drainEntry(uploadEventId, token) {
      if (inFlight[uploadEventId]) return { outcome: 'busy', status: 0 };
      inFlight[uploadEventId] = true;
      try {
        var entry = await store.get(uploadEventId);
        if (!isDrainable(entry)) return { outcome: 'skip', status: 0 };
        entry.state = 'sending';
        entry.updatedAt = now();
        await store.put(entry); // durable 'sending' BEFORE the network call
        var status = 0;
        try {
          var res = await fetchFn('/api/mobile/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify(buildRequest(entry)),
          });
          status = res && typeof res.status === 'number' ? res.status : 0;
        } catch (e) {
          status = 0; // network error → retryable
        }
        var outcome = classify(status);
        var fresh = await store.get(uploadEventId);
        if (!fresh) return { outcome: outcome, status: status }; // deleted concurrently — nothing to do
        if (outcome === 'done') {
          await store.delete(uploadEventId); // success (accepted or replay) → drop the durable entry
        } else if (TERMINAL_KEEP[outcome]) {
          fresh.state = outcome; fresh.lastStatus = status; fresh.updatedAt = now();
          await store.put(fresh); // conflict / rejected → keep for the user, no new id
        } else {
          // reauth or retryable → keep the SAME entry+ids, back to retryable for a later user-triggered send.
          fresh.state = 'retryable'; fresh.lastStatus = status; fresh.updatedAt = now();
          await store.put(fresh);
        }
        return { outcome: outcome, status: status };
      } finally {
        delete inFlight[uploadEventId];
      }
    }

    // Drain every drainable entry once. Caller invokes this ONLY after login + an explicit user trigger.
    // Stops early on reauth (do not hammer an unauthenticated server). Never an unbounded loop.
    async function drainAll(token) {
      var all = await store.getAll();
      var results = [];
      for (var i = 0; i < all.length; i++) {
        if (!isDrainable(all[i])) continue;
        var r = await drainEntry(all[i].uploadEventId, token);
        results.push(r);
        if (r.outcome === 'reauth') break;
      }
      return results;
    }

    async function pending() {
      var all = await store.getAll();
      return all.filter(function (e) { return e.state !== 'conflict' && e.state !== 'rejected'; }).length;
    }

    return { enqueue: enqueue, drainEntry: drainEntry, drainAll: drainAll, recoverStaleSending: recoverStaleSending, pending: pending };
  }

  global.MobileUploadQueue = {
    stripDataUrl: stripDataUrl,
    classify: classify,
    buildRequest: buildRequest,
    createQueue: createQueue,
  };
})(typeof self !== 'undefined' ? self : this);

// ═══════════════════════════════════════════════════════════
// LATAIF — B1 operations HTTP client (submit / status / pull)
// ═══════════════════════════════════════════════════════════
//
// PURE + injectable: takes `{ url, token, fetchFn }` so the desktop wires it to
// getSyncUrl() + localStorage['lataif_sync_token'] + global fetch, and the Node
// e2e harness wires it to the test server + token + node fetch. No desktop
// imports. Never logs the token. Maps the server's stable decision/error
// contract; never surfaces raw server/SQL text to the UI.

import type { Envelope } from './b1-protocol';

export interface HttpConfig {
  url: string; // server base, e.g. http://localhost:3001
  token: string; // Bearer JWT
  fetchFn: typeof fetch;
}

/** A normalised submit outcome. `kind` is the stable client-facing class. */
export type SubmitOutcome =
  | { kind: 'accepted'; serverSequence: string; result: Record<string, unknown> }
  | { kind: 'replayed'; status: string; result: Record<string, unknown> }
  | { kind: 'operation_id_reused' }
  | { kind: 'conflict'; errorCode: string; result: Record<string, unknown> }
  | { kind: 'validation_rejected'; errorCode: string; result: Record<string, unknown> }
  | { kind: 'bootstrap_required' } // transient FINANCE_NOT_BOOTSTRAPPED
  | { kind: 'unknown_commit_status' } // transient → must query status / retry same id
  | { kind: 'offline' } // network unreachable
  | { kind: 'auth_error' }
  | { kind: 'server_error'; errorCode: string };

function authHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/** POST /api/operations. Network failure → offline; never throws raw errors. */
export async function submitOperation(http: HttpConfig, payload: unknown): Promise<SubmitOutcome> {
  let res: Response;
  try {
    res = await http.fetchFn(`${http.url}/api/operations`, {
      method: 'POST',
      headers: authHeaders(http.token),
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth_error' };

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* tolerate empty/non-json body */
  }

  // transient (503) — retryable; distinguish bootstrap vs unknown-commit.
  if (res.status === 503) {
    const code = String(body.errorCode ?? '');
    if (code === 'FINANCE_NOT_BOOTSTRAPPED') return { kind: 'bootstrap_required' };
    return { kind: 'unknown_commit_status' };
  }
  if (res.status >= 500) return { kind: 'server_error', errorCode: 'SERVER_ERROR' };

  // 200 — read the final decision from the body.
  const status = String(body.status ?? '');
  const retry = String(body.retryAction ?? '');
  const errorCode = String(body.errorCode ?? '');
  if (status === 'accepted') {
    return { kind: 'accepted', serverSequence: String(body.serverSequence ?? ''), result: (body.result as Record<string, unknown>) ?? {} };
  }
  if (retry === 'REPLAY_STORED') {
    return { kind: 'replayed', status, result: (body.result as Record<string, unknown>) ?? {} };
  }
  if (errorCode === 'OPERATION_ID_REUSED') return { kind: 'operation_id_reused' };
  if (status === 'conflict') return { kind: 'conflict', errorCode, result: (body.result as Record<string, unknown>) ?? {} };
  if (status === 'validation_rejected') {
    return { kind: 'validation_rejected', errorCode, result: (body.result as Record<string, unknown>) ?? {} };
  }
  // anything else (incl. an unexpected transient surfaced as 200) → status query.
  return { kind: 'unknown_commit_status' };
}

export interface StatusOutcome {
  status: string; // unknown | accepted | conflict | validation_rejected
  payloadHash?: string;
  serverSequence?: string | null;
  result?: Record<string, unknown>;
  envelope?: Envelope | null;
}

/** GET /api/operations/{operationId}. */
export async function getOperationStatus(http: HttpConfig, operationId: string): Promise<StatusOutcome | { kind: 'offline' | 'auth_error' }> {
  let res: Response;
  try {
    res = await http.fetchFn(`${http.url}/api/operations/${encodeURIComponent(operationId)}`, {
      headers: { Authorization: `Bearer ${http.token}` },
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth_error' };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    status: String(body.status ?? 'unknown'),
    payloadHash: body.payloadHash == null ? undefined : String(body.payloadHash),
    serverSequence: body.serverSequence == null ? null : String(body.serverSequence),
    result: (body.result as Record<string, unknown>) ?? undefined,
    envelope: (body.envelope as Envelope | null) ?? null,
  };
}

export interface PullOutcome {
  operations: { serverSequence: string; envelope: Envelope }[];
  cursor: string;
  hasMore: boolean;
}

/** GET /api/operations/pull?since=&limit=. */
export async function pullOperations(
  http: HttpConfig,
  since: number,
  limit: number,
): Promise<PullOutcome | { kind: 'offline' | 'auth_error' }> {
  let res: Response;
  try {
    res = await http.fetchFn(`${http.url}/api/operations/pull?since=${since}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${http.token}` },
    });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'auth_error' };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const ops = (Array.isArray(body.operations) ? body.operations : []) as { serverSequence: string; envelope: Envelope }[];
  return {
    operations: ops,
    cursor: String(body.cursor ?? String(since)),
    hasMore: body.hasMore === true,
  };
}

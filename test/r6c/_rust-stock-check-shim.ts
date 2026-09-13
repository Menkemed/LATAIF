// Nur für Tests: der Kern des Primary für Beobachtungen (`stock_checks`), so wie `lib.rs` ihn anbietet.
//
// Nachgestellt ist genau das, worum es geht: `latest_stock_checks` beantwortet je Aufruf nur die
// ersten `take` Artikel (in Rust `.take(1000)`, der Test liest die Zahl aus `lib.rs`) — alles
// dahinter fehlt still in der Antwort. `create_stock_check` ist idempotent über die Anfragekennung
// wie `sync::stock_check`: dieselbe Kennung → dieselbe Zeile.

export interface RustCheck {
  check_id: string;
  product_id: string;
  status: 'available' | 'not_available';
  notes: string | null;
  checked_at: string;
  checked_by: string | null;
  checked_by_name: string | null;
  source: 'mobile' | 'desktop';
  request_id: string | null;
}

export const rustState = {
  take: 1000,
  rows: [] as RustCheck[],
  calls: [] as Array<{ cmd: string; size: number; requestId?: string }>,
  clock: (): string => new Date().toISOString(),
  reset(): void {
    this.rows = [];
    this.calls = [];
  },
};

/** Eine Beobachtung vom Telefon — ohne Anfragekennung des Desktops. */
export function phone(productId: string, status: 'available' | 'not_available', notes: string | null = null): RustCheck {
  const r: RustCheck = {
    check_id: 'chk-' + (rustState.rows.length + 1), product_id: productId, status, notes, checked_at: rustState.clock(),
    checked_by: null, checked_by_name: null, source: 'mobile', request_id: null,
  };
  rustState.rows.push(r);
  return r;
}

function latestOf(productId: string): RustCheck | null {
  const mine = rustState.rows.filter((r) => r.product_id === productId);
  mine.sort((a, b) => (a.checked_at !== b.checked_at ? (a.checked_at < b.checked_at ? 1 : -1) : a.check_id < b.check_id ? 1 : -1));
  return mine[0] ?? null;
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case 'latest_stock_checks': {
      const ids = Array.isArray(a.productIds) ? (a.productIds as string[]) : [];
      rustState.calls.push({ cmd, size: ids.length });
      const out: Record<string, RustCheck> = {};
      for (const id of ids.slice(0, rustState.take)) {
        const c = latestOf(id.trim());
        if (c) out[id] = c;
      }
      return out as T;
    }
    case 'create_stock_check': {
      const requestId = String(a.requestId ?? '');
      rustState.calls.push({ cmd, size: 1, requestId });
      const seen = rustState.rows.find((r) => r.request_id === requestId);
      if (seen) return seen as T;
      const r: RustCheck = {
        check_id: 'chk-' + (rustState.rows.length + 1), product_id: String(a.productId), status: a.status as RustCheck['status'],
        notes: (a.notes as string | null) ?? null, checked_at: rustState.clock(), checked_by: (a.userId as string | null) ?? null,
        checked_by_name: null, source: 'desktop', request_id: requestId,
      };
      rustState.rows.push(r);
      return r as T;
    }
    default:
      throw new Error(`[test] no tauri command in this shim: ${cmd}`);
  }
}

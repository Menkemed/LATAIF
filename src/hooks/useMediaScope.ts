// ════════════════════════════════════════════════════════════════════════════
// MEDIA-CONSUMERS-I1A — shared media scope derivation.
//
// Returns the authorised { tenantId, branchId } used to feed
// `CollectionProductThumb` (and therefore the read-only media resolver). This is
// the SAME derivation WatchList already uses (branchId from the session, tenantId
// looked up from `branches`), extracted verbatim so the seven static product
// views don't each copy-paste it. It carries NO resolver or Object-URL lifecycle
// semantics — it only reads scope evidence; the thumbnail component owns all
// resolve/teardown behaviour exactly as before.
// ════════════════════════════════════════════════════════════════════════════

import { useMemo } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { query } from '@/core/db/helpers';

export interface MediaScope {
  tenantId: string | undefined;
  branchId: string | undefined;
}

export function useMediaScope(): MediaScope {
  const branchId = useAuthStore(s => s.session?.branchId) || undefined;
  const tenantId = useMemo(() => {
    if (!branchId) return undefined;
    const rows = query('SELECT tenant_id FROM branches WHERE id = ?', [branchId]);
    const t = rows.length > 0 ? (rows[0].tenant_id as string | null) : null;
    return t || undefined;
  }, [branchId]);
  return { tenantId, branchId };
}

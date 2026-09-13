// Plan §Scrap Gold Quick Trade — Create-Wrapper.
//
// CENTRAL-UI-PARITY R6D — „Save Trade" ist EINE Buchung (`scrap_trades.create`): am Primary die
// Hausfolge in einer Transaktion, auf PC2 derselbe Vorgang als Auftrag (Fotos zuerst in die
// Zwischenablage). Ein zweiter Klick, solange der erste läuft, legt kein zweites Geschäft an.

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { WriteError } from '@/components/shared/WriteError';
import { ScrapTradeForm } from './ScrapTradeForm';
import { useScrapTradeStore, type ScrapTradeInput } from '@/stores/scrapTradeStore';
import { useSharedWrites } from '@/core/data/shared-write';
import { StagingUploadError } from '@/core/bridge/client-staging-upload';
import {
  createScrapTradeOnPrimary, scrapCreateBody, stageScrapPhotos, type StagedScrapPhotos,
} from '@/core/metals/metal-actions';

export function ScrapTradeNew() {
  const navigate = useNavigate();
  const { loadTrades } = useScrapTradeStore();
  const w = useSharedWrites();
  const [busy, setBusy] = useState(false);
  // Der Riegel über Ablage UND Auftrag: auf PC2 läuft vor dem Auftrag das Ablegen der Fotos.
  const laeuft = useRef(false);

  async function handleSubmit(values: ScrapTradeInput) {
    if (laeuft.current) return;
    laeuft.current = true;
    setBusy(true);
    try {
      let staged: StagedScrapPhotos[] = [];
      if (w.remote) {
        try {
          staged = await stageScrapPhotos(values);
        } catch (e) {
          alert(`The photos could not be handed to the main computer (${e instanceof StagingUploadError ? e.code : String(e)}). Nothing was saved — please try again.`);
          return;
        }
      }
      const r = await w.save<{ tradeId: string }>('scrap_trades.create', {
        local: async () => ({ tradeId: (await createScrapTradeOnPrimary(values)).tradeId }),
        remote: () => scrapCreateBody(values, staged),
        shape: (v) => ({ tradeId: String(v.tradeId ?? '') }),
      });
      // Nicht geglückt: der Grund steht in `w.fehler`, die Eingaben bleiben stehen.
      if (r.kind !== 'ok') return;
      loadTrades();
      navigate(`/scrap-trades/${r.value.tradeId}`);
    } finally {
      laeuft.current = false;
      setBusy(false);
    }
  }

  return (
    <PageLayout
      title="New Scrap Trade"
      subtitle="Buy scrap gold and resell immediately — only the spread counts as income."
      actions={
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/scrap-trades')}>
          Back
        </Button>
      }
    >
      <WriteError text={w.fehler} />
      <ScrapTradeForm
        submitLabel="Save Trade"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/scrap-trades')}
        busy={busy || w.busy}
      />
    </PageLayout>
  );
}

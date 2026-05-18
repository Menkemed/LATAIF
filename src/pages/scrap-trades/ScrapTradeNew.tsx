// Plan §Scrap Gold Quick Trade — Create-Wrapper.

import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { PageLayout } from '@/components/layout/PageLayout';
import { Button } from '@/components/ui/Button';
import { ScrapTradeForm } from './ScrapTradeForm';
import { useScrapTradeStore, type ScrapTradeInput } from '@/stores/scrapTradeStore';

export function ScrapTradeNew() {
  const navigate = useNavigate();
  const { createTrade } = useScrapTradeStore();

  function handleSubmit(values: ScrapTradeInput) {
    const id = createTrade(values);
    navigate(`/scrap-trades/${id}`);
  }

  return (
    <PageLayout
      title="New Scrap Trade"
      subtitle="Altgold ankaufen, sofort weiterverkaufen — nur der Spread zählt als Einkommen."
      actions={
        <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={() => navigate('/scrap-trades')}>
          Back
        </Button>
      }
    >
      <ScrapTradeForm
        submitLabel="Save Trade"
        onSubmit={handleSubmit}
        onCancel={() => navigate('/scrap-trades')}
      />
    </PageLayout>
  );
}

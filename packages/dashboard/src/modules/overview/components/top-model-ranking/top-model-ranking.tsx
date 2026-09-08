import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Progress, ProgressLabel, ProgressValue } from '@aio-proxy/ui/components/progress';
import { Tabs, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { useState } from 'react';

import { formatExactTokenCount } from '@/components/token-count';
import { formatNanoUsd } from '@/lib/nano-usd';

import type { OverviewDiagnosticsData } from '../../services/overview-service';

type RankingMetric = 'cost' | 'tokens';

interface TopModelRankingProps {
  readonly costs: OverviewDiagnosticsData['topModelCosts'];
  readonly tokens: OverviewDiagnosticsData['topModelTokens'];
}

const metrics: readonly RankingMetric[] = ['cost', 'tokens'];

export const TopModelRanking: React.FC<TopModelRankingProps> = ({ costs, tokens }) => {
  const locale = getLocale();
  const [metric, setMetric] = useState<RankingMetric>('cost');
  const labels: Record<RankingMetric, string> = {
    cost: m['dashboard.overview.metric_cost'](),
    tokens: m['dashboard.overview.summary_tokens'](),
  };
  const models =
    metric === 'cost'
      ? costs.map((model) => ({ id: model.modelId, value: model.estimatedCostNanoUsd }))
      : tokens.map((model) => ({ id: model.modelId, value: model.totalTokens }));
  const maximum = models.reduce((highest, model) => (model.value > highest ? model.value : highest), 0n);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.top_models_title']()}
        </CardTitle>
        <CardAction>
          <Tabs value={metric} onValueChange={(value) => setMetric(value as RankingMetric)}>
            <TabsList aria-label={m['dashboard.usage.metric_label']()}>
              {metrics.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {labels[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            {metric === 'cost' ? m['dashboard.overview.no_model_costs']() : m['dashboard.overview.no_model_tokens']()}
          </div>
        ) : (
          <div className="space-y-4">
            {models.map((model) => {
              const value = maximum === 0n ? 0 : Number((model.value * 10_000n) / maximum) / 100;
              return (
                <Progress key={model.id} value={value}>
                  <ProgressLabel>{model.id}</ProgressLabel>
                  <ProgressValue>
                    {() =>
                      metric === 'cost'
                        ? formatNanoUsd(model.value, locale)
                        : formatExactTokenCount(model.value, locale)
                    }
                  </ProgressValue>
                </Progress>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

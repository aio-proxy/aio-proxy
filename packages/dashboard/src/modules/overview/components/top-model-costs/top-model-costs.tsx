import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Progress, ProgressLabel, ProgressValue } from '@aio-proxy/ui/components/progress';

import { formatNanoUsd } from '@/modules/usage/services/usage-value-formatter';

import type { OverviewDiagnosticsData } from '../../services/overview-service';

interface TopModelCostsProps {
  readonly models: OverviewDiagnosticsData['topModelCosts'];
}

export const TopModelCosts: React.FC<TopModelCostsProps> = ({ models }) => {
  const locale = getLocale();
  const maxCost = models.reduce(
    (maximum, model) => (model.estimatedCostNanoUsd > maximum ? model.estimatedCostNanoUsd : maximum),
    0n,
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.top_models_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {models.length === 0 ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            {m['dashboard.overview.no_model_costs']()}
          </div>
        ) : (
          <div className="space-y-4">
            {models.map((model) => {
              const value = maxCost === 0n ? 0 : Number((model.estimatedCostNanoUsd * 10_000n) / maxCost) / 100;
              return (
                <Progress key={model.modelId} value={value}>
                  <ProgressLabel>{model.modelId}</ProgressLabel>
                  <ProgressValue>{() => formatNanoUsd(model.estimatedCostNanoUsd, locale)}</ProgressValue>
                </Progress>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

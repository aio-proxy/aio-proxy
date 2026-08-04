import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';

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
          <ol className="grid gap-4">
            {models.map((model) => {
              const width = maxCost === 0n ? 0 : Number((model.estimatedCostNanoUsd * 10_000n) / maxCost) / 100;
              return (
                <li key={model.modelId} className="grid gap-2">
                  <div className="flex min-w-0 items-center justify-between gap-4">
                    <span className="truncate font-mono text-xs">{model.modelId}</span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {formatNanoUsd(model.estimatedCostNanoUsd, locale)}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${width}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
};

import { getLocale, m } from '@aio-proxy/i18n';
import type { UsageCallerRanking as CallerRanking, UsageOverviewMetric } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Progress, ProgressLabel, ProgressValue } from '@aio-proxy/ui/components/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useForm } from '@tanstack/react-form';
import { useState } from 'react';
import { z } from 'zod';

import { formatExactTokenCount } from '@/components/token-count';
import { formatNanoUsd } from '@/lib/nano-usd';
import { usageCallerLabel } from '@/lib/usage-caller-label';

interface UsageCallerRankingProps {
  readonly rows: readonly CallerRanking[];
  readonly loading: boolean;
  readonly error: boolean;
  readonly onSelect: (id: string) => void;
}

export const UsageCallerRanking: React.FC<UsageCallerRankingProps> = ({ rows, loading, error, onSelect }) => {
  const locale = getLocale();
  const [metric, setMetric] = useState<UsageOverviewMetric>('cost');
  const form = useForm({
    defaultValues: { metric: 'cost' as UsageOverviewMetric },
    validators: { onChange: z.object({ metric: z.enum(['cost', 'tokens', 'requests']) }) },
  });
  const choices = [
    { value: 'cost', label: m['dashboard.overview.metric_cost']() },
    { value: 'tokens', label: m['dashboard.overview.summary_tokens']() },
    { value: 'requests', label: m['dashboard.overview.summary_requests']() },
  ];
  const ranked = rows
    .map((row) => ({
      ...row,
      value: BigInt(
        metric === 'cost' ? row.estimatedCostNanoUsd : metric === 'tokens' ? row.totalTokens : row.requestCount,
      ),
    }))
    .sort((left, right) =>
      left.value === right.value ? left.id.localeCompare(right.id) : left.value > right.value ? -1 : 1,
    );
  const maximum = ranked[0]?.value ?? 0n;
  const total = ranked.reduce((sum, row) => sum + row.value, 0n);
  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.callers.ranking']()}
        </CardTitle>
        <CardDescription>{m['dashboard.callers.cost_note']()}</CardDescription>
        <CardAction>
          <form.Field name="metric">
            {(field) => (
              <Select
                items={choices}
                value={field.state.value}
                onValueChange={(value) => {
                  if (value === null) return;
                  field.handleChange(value as UsageOverviewMetric);
                  setMetric(value as UsageOverviewMetric);
                }}
              >
                <SelectTrigger aria-label={m['dashboard.usage.metric_label']()}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </form.Field>
        </CardAction>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-40" />
        ) : error ? (
          <p role="alert" className="text-destructive">
            {m['dashboard.callers.ranking_error']()}
          </p>
        ) : ranked.length === 0 ? (
          <p className="text-muted-foreground">{m['dashboard.callers.empty']()}</p>
        ) : (
          <div className="max-h-96 space-y-4 overflow-y-auto">
            {ranked.map((row) => (
              <Progress key={row.id} value={maximum === 0n ? 0 : Number((row.value * 10_000n) / maximum) / 100}>
                <ProgressLabel>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto max-w-full truncate p-0"
                    onClick={() => onSelect(row.id)}
                  >
                    {usageCallerLabel(row)}
                  </Button>
                </ProgressLabel>
                <ProgressValue>
                  {() =>
                    `${metric === 'cost' ? formatNanoUsd(row.value, locale) : formatExactTokenCount(row.value, locale)} · ${total === 0n ? '0.0' : (Number((row.value * 1_000n + total / 2n) / total) / 10).toFixed(1)}%`
                  }
                </ProgressValue>
              </Progress>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

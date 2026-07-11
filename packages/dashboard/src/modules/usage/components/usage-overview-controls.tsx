import { m } from "@aio-proxy/i18n";
import type { UsageOverviewGroupBy, UsageOverviewMetric, UsageOverviewRange } from "@aio-proxy/types";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Props = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly onRangeChange: (value: UsageOverviewRange) => void;
  readonly onMetricChange: (value: UsageOverviewMetric) => void;
  readonly onGroupByChange: (value: UsageOverviewGroupBy) => void;
};

const ranges: readonly UsageOverviewRange[] = ["24h", "7d", "14d", "30d"];
const metrics: readonly UsageOverviewMetric[] = ["cost", "tokens", "requests"];
const groupings: readonly UsageOverviewGroupBy[] = ["model", "provider"];

export const UsageOverviewControls: React.FC<Props> = (props) => {
  const rangeLabels: Record<UsageOverviewRange, string> = {
    "24h": m["dashboard.usage.range_24h"](),
    "7d": m["dashboard.usage.range_7d"](),
    "14d": m["dashboard.usage.range_14d"](),
    "30d": m["dashboard.usage.range_30d"](),
  };
  const metricLabels: Record<UsageOverviewMetric, string> = {
    cost: m["dashboard.usage.metric_cost"](),
    tokens: m["dashboard.usage.metric_tokens"](),
    requests: m["dashboard.usage.metric_requests"](),
  };
  const groupingLabels: Record<UsageOverviewGroupBy, string> = {
    model: m["dashboard.usage.group_by_model"](),
    provider: m["dashboard.usage.group_by_provider"](),
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={props.range} onValueChange={(value) => props.onRangeChange(value as UsageOverviewRange)}>
        <SelectTrigger size="sm" aria-label={m["dashboard.usage.range_label"]()}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ranges.map((value) => (
            <SelectItem key={value} value={value}>
              {rangeLabels[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={props.metric} onValueChange={(value) => props.onMetricChange(value as UsageOverviewMetric)}>
        <SelectTrigger size="sm" aria-label={m["dashboard.usage.metric_label"]()}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {metrics.map((value) => (
            <SelectItem key={value} value={value}>
              {metricLabels[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={props.groupBy} onValueChange={(value) => props.onGroupByChange(value as UsageOverviewGroupBy)}>
        <SelectTrigger size="sm" aria-label={m["dashboard.usage.group_by_label"]()}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groupings.map((value) => (
            <SelectItem key={value} value={value}>
              {groupingLabels[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

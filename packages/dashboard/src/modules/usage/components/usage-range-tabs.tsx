import { m } from "@aio-proxy/i18n";
import type { UsageOverviewRange } from "@aio-proxy/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

const ranges: readonly UsageOverviewRange[] = ["24h", "7d", "14d", "30d"];

export const UsageRangeTabs: React.FC = () => {
  const filters = useAtomValue(usageOverviewFiltersAtom);
  const setFilters = useSetAtom(usageOverviewFiltersAtom);
  const labels: Record<UsageOverviewRange, string> = {
    "24h": m["dashboard.usage.range_24h"](),
    "7d": m["dashboard.usage.range_7d"](),
    "14d": m["dashboard.usage.range_14d"](),
    "30d": m["dashboard.usage.range_30d"](),
  };

  return (
    <div className="min-w-0 overflow-x-auto pb-1">
      <Tabs
        className="w-max"
        value={filters.range}
        onValueChange={(value) => setFilters((current) => ({ ...current, range: value as UsageOverviewRange }))}
      >
        <TabsList className="shrink-0" aria-label={m["dashboard.usage.range_label"]()}>
          {ranges.map((range) => (
            <TabsTrigger key={range} value={range}>
              {labels[range]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
};

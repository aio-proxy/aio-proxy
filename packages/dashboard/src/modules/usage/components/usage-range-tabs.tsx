import { m } from "@aio-proxy/i18n";
import type { UsageOverviewRange } from "@aio-proxy/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

const ranges: readonly UsageOverviewRange[] = ["24h", "7d", "14d", "30d"];

type Props = {
  readonly children: React.ReactNode;
};

export const UsageRangeTabs: React.FC<Props> = ({ children }) => {
  const filters = useAtomValue(usageOverviewFiltersAtom);
  const setFilters = useSetAtom(usageOverviewFiltersAtom);
  const labels: Record<UsageOverviewRange, string> = {
    "24h": m["dashboard.usage.range_24h"](),
    "7d": m["dashboard.usage.range_7d"](),
    "14d": m["dashboard.usage.range_14d"](),
    "30d": m["dashboard.usage.range_30d"](),
  };

  return (
    <Tabs
      className="min-w-0 gap-3"
      value={filters.range}
      onValueChange={(value) => setFilters((current) => ({ ...current, range: value as UsageOverviewRange }))}
    >
      <div className="min-w-0 overflow-x-auto pb-1">
        <TabsList className="shrink-0" aria-label={m["dashboard.usage.range_label"]()}>
          {ranges.map((range) => (
            <TabsTrigger key={range} value={range}>
              {labels[range]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {ranges.map((range) => (
        <TabsContent key={range} value={range} keepMounted className="grid gap-3">
          {filters.range === range ? children : null}
        </TabsContent>
      ))}
    </Tabs>
  );
};

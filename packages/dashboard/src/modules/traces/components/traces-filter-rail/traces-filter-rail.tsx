import { m } from '@aio-proxy/i18n';
import { SidebarContent, SidebarHeader } from '@aio-proxy/ui/components/sidebar';

import type { TraceSearch } from '../../lib/trace-search';
import { TracesFilters } from '../traces-filters';

interface TracesFilterRailProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly refreshing: boolean;
  readonly onSearchChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
  readonly onRefresh: () => void;
}

export const TracesFilterRail: React.FC<TracesFilterRailProps> = ({
  search,
  autoRefresh,
  refreshing,
  onSearchChange,
  onAutoRefresh,
  onRefresh,
}) => {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="traces-filter-rail">
      <SidebarHeader className="border-b px-4 py-3">
        <h2 className="font-heading text-base font-medium">{m['dashboard.traces.filters']()}</h2>
      </SidebarHeader>

      <SidebarContent className="p-4">
        <TracesFilters
          search={search}
          autoRefresh={autoRefresh}
          refreshing={refreshing}
          onChange={onSearchChange}
          onAutoRefresh={onAutoRefresh}
          onRefresh={onRefresh}
        />
      </SidebarContent>
    </div>
  );
};

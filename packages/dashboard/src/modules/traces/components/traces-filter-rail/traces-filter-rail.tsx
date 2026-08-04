import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { PanelLeftClose } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TraceSearch } from '../../trace-search';
import { TracesFilters } from '../traces-filters';
import { TracesSearchBar } from '../traces-search-bar';

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
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(mobile);
  const advancedFilterRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mobile) setCollapsed(true);
  }, [mobile]);

  useEffect(() => {
    if (!mobile && collapsed) advancedFilterRef.current?.focus();
  }, [collapsed, mobile]);

  const railOpen = !collapsed;
  const collapse = () => setCollapsed(true);
  const expand = () => setCollapsed(false);

  return (
    <>
      <TracesSearchBar
        collapsed={collapsed}
        mobile={mobile}
        onExpand={expand}
        onToggleMobile={() => setCollapsed((value) => !value)}
        advancedFilterRef={advancedFilterRef}
      />
      {railOpen && (
        <aside className="traces-filter-rail" data-testid="traces-filter-rail">
          {!mobile && (
            <div className="flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={collapse}>
                <PanelLeftClose />
                {m['dashboard.traces.collapse_filters']()}
              </Button>
            </div>
          )}
          <TracesFilters
            search={search}
            autoRefresh={autoRefresh}
            refreshing={refreshing}
            onChange={onSearchChange}
            onAutoRefresh={onAutoRefresh}
            onRefresh={onRefresh}
          />
        </aside>
      )}
    </>
  );
};

import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { PanelLeftClose } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { TraceSearch } from '../../trace-search';
import { TracesFilters } from '../traces-filters';
import { TracesSearchBar } from '../traces-search-bar';

const desktopBreakpoint = 1024;

const useIsNarrow = () => {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < desktopBreakpoint);

  useEffect(() => {
    const updateNarrow = () => setNarrow(window.innerWidth < desktopBreakpoint);
    window.addEventListener('resize', updateNarrow);
    updateNarrow();
    return () => window.removeEventListener('resize', updateNarrow);
  }, []);

  return narrow;
};

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
  const narrow = useIsNarrow();
  const [collapsed, setCollapsed] = useState(narrow);
  const advancedFilterRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const focusTargetRef = useRef<'advanced' | 'collapse'>();

  useEffect(() => {
    if (narrow) setCollapsed(true);
  }, [narrow]);

  useEffect(() => {
    if (narrow) return;
    if (focusTargetRef.current === 'advanced' && collapsed) advancedFilterRef.current?.focus();
    if (focusTargetRef.current === 'collapse' && !collapsed) collapseRef.current?.focus();
    focusTargetRef.current = undefined;
  }, [collapsed, narrow]);

  const railOpen = !collapsed;
  const collapse = () => {
    focusTargetRef.current = 'advanced';
    setCollapsed(true);
  };
  const expand = () => {
    focusTargetRef.current = 'collapse';
    setCollapsed(false);
  };

  return (
    <>
      <TracesSearchBar
        collapsed={collapsed}
        mobile={narrow}
        onExpand={expand}
        onToggleMobile={() => setCollapsed((value) => !value)}
        advancedFilterRef={advancedFilterRef}
      />
      {railOpen && (
        <aside className="traces-filter-rail" data-testid="traces-filter-rail">
          {!narrow && (
            <div className="flex justify-end">
              <Button ref={collapseRef} type="button" variant="ghost" size="sm" onClick={collapse}>
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

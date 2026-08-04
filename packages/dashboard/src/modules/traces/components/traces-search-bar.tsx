import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { SlidersHorizontal } from 'lucide-react';

interface TracesSearchBarProps {
  readonly collapsed: boolean;
  readonly mobile: boolean;
  readonly onExpand: () => void;
  readonly onToggleMobile: () => void;
  readonly advancedFilterRef: React.RefObject<HTMLButtonElement | null>;
}

export const TracesSearchBar: React.FC<TracesSearchBarProps> = ({
  collapsed,
  mobile,
  onExpand,
  onToggleMobile,
  advancedFilterRef,
}) => {
  if (mobile) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="outline" onClick={onToggleMobile} aria-expanded={!collapsed}>
          <SlidersHorizontal />
          {m['dashboard.traces.filters']()}
        </Button>
      </div>
    );
  }

  if (!collapsed) return null;

  return (
    <div className="flex justify-end">
      <Button ref={advancedFilterRef} type="button" variant="outline" onClick={onExpand}>
        <SlidersHorizontal />
        {m['dashboard.traces.advanced_filters']()}
      </Button>
    </div>
  );
};

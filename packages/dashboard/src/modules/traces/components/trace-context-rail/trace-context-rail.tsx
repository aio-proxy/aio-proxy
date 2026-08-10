import type { DashboardTraceSummary } from '@aio-proxy/types';

import { TraceSummary } from '../trace-summary';

interface TraceContextRailProps {
  readonly trace: DashboardTraceSummary;
  readonly onSessionSelect: (session: { readonly source: string; readonly id: string }) => void;
}

export const TraceContextRail: React.FC<TraceContextRailProps> = ({ trace, onSessionSelect }) => (
  <aside className="min-w-0 lg:sticky lg:top-3" data-testid="trace-context-rail">
    <TraceSummary trace={trace} onSessionSelect={onSessionSelect} />
  </aside>
);

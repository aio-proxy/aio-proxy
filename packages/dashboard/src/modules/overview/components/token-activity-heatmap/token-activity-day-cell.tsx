import { HoverCard, HoverCardContent, HoverCardTrigger } from '@aio-proxy/ui/components/hover-card';

import { formatCompactTokenCount } from '@/components/token-count';

import { formatActivityDate } from './activity-date';
import type { ActivityIntensity } from './activity-intensity';
import { HeatmapItem } from './heatmap-item';
import type { ActivityCell } from './heatmap-layout';
import { TokenActivityHover } from './token-activity-hover';

interface TokenActivityDayCellProps {
  readonly cell: ActivityCell;
  readonly intensity: ActivityIntensity;
}

export const TokenActivityDayCell: React.FC<TokenActivityDayCellProps> = ({ cell, intensity }) => {
  const label = `${formatActivityDate(cell.date)}, ${formatCompactTokenCount(cell.totalTokens)} Token`;

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={0}
        render={<HeatmapItem aria-label={label} intensity={intensity} tabIndex={0} />}
      />
      <HoverCardContent align="start" side="top" sideOffset={8}>
        <TokenActivityHover cell={cell} />
      </HoverCardContent>
    </HoverCard>
  );
};

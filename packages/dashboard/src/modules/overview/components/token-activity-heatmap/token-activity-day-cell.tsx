import { m } from '@aio-proxy/i18n';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@aio-proxy/ui/components/hover-card';

import { formatCompactTokenCount } from '@/components/token-count';

import { formatActivityDate } from './activity-date';
import type { ActivityCell } from './heatmap-layout';
import { TokenActivityHover } from './token-activity-hover';

interface TokenActivityDayCellProps {
  readonly cell: ActivityCell;
  readonly level: number;
  readonly intensityClassName: string;
}

export const TokenActivityDayCell: React.FC<TokenActivityDayCellProps> = ({ cell, level, intensityClassName }) => {
  const label = `${formatActivityDate(cell.date)}, ${formatCompactTokenCount(cell.totalTokens)} TOKEN, ${m['dashboard.overview.activity_level']({ level })}`;

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={0}
        closeDelay={0}
        render={<div aria-label={label} className={`size-3 rounded-[2px] ${intensityClassName}`} tabIndex={0} />}
      />
      <HoverCardContent align="start" className="rounded-lg p-3" side="top" sideOffset={8}>
        <TokenActivityHover cell={cell} level={level} />
      </HoverCardContent>
    </HoverCard>
  );
};

import { getLocale } from '@aio-proxy/i18n';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { formatCompactTokenCount, formatExactTokenCount } from './format-token-count';

interface TokenCountProps {
  readonly value: number | bigint | undefined;
  readonly className?: string;
}

export const TokenCount: React.FC<TokenCountProps> = ({ value, className }) => {
  const classNames = cn('tabular-nums', value === undefined && 'text-muted-foreground', className);

  if (value === undefined) return <span className={classNames}>N/A</span>;

  const compact = formatCompactTokenCount(value);
  const exact = formatExactTokenCount(value, getLocale());

  if (compact === exact) {
    return <span className={classNames}>{compact}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className={classNames} />}>{compact}</TooltipTrigger>
      <TooltipContent>{exact}</TooltipContent>
    </Tooltip>
  );
};

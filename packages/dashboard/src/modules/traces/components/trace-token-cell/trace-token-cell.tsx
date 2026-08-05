import type { UsageRow } from '@aio-proxy/types';

import { TokenCount } from '@/components/token-count';

import { TRACE_CACHE_READ_SHORT, TRACE_CACHE_WRITE_SHORT, TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';

interface TraceTokenCellProps {
  readonly usage?: Pick<UsageRow, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'> | undefined;
}

export const TraceTokenCell: React.FC<TraceTokenCellProps> = ({ usage }) => {
  if (
    usage?.inputTokens === undefined &&
    usage?.outputTokens === undefined &&
    usage?.cacheReadTokens === undefined &&
    usage?.cacheWriteTokens === undefined
  ) {
    return TRACE_PLACEHOLDER;
  }

  return (
    <div className="min-w-32">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-baseline">
          ↑<TokenCount value={usage.inputTokens} />
        </span>
        <span className="inline-flex items-baseline">
          ↓<TokenCount value={usage.outputTokens} />
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-flex items-baseline gap-1">
          {TRACE_CACHE_READ_SHORT}
          <TokenCount value={usage.cacheReadTokens} />
        </span>
        <span className="inline-flex items-baseline gap-1">
          {TRACE_CACHE_WRITE_SHORT}
          <TokenCount value={usage.cacheWriteTokens} />
        </span>
      </div>
    </div>
  );
};

import { getLocale, m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import { createPortal } from 'react-dom';

import { formatCompactTokenCount } from '@/components/token-count';

import type { ActivityCell } from './heatmap-layout';

interface TokenActivityHoverProps {
  readonly cell: ActivityCell;
  readonly level: number;
  readonly position: { readonly x: number; readonly y: number };
}

const formatDate = (date: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  );

const formatPercent = (value: number) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 1 }).format(value);

export const TokenActivityHover: React.FC<TokenActivityHoverProps> = ({ cell, level, position }) => {
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="pointer-events-none fixed z-50 w-72 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md"
      role="status"
      style={{ left: position.x + 12, top: position.y + 12 }}
    >
      <div className="flex items-center justify-between gap-2">
        <time className="text-sm font-medium" dateTime={cell.date}>
          {formatDate(cell.date)}
        </time>
        <Badge variant="secondary">{m['dashboard.overview.activity_level']({ level })}</Badge>
      </div>
      <p className="mt-2 text-sm">{formatCompactTokenCount(cell.totalTokens)} TOKEN</p>
      {cell.models.length === 0 ? null : (
        <section className="mt-3 border-t pt-3">
          <h3 className="text-xs font-medium text-muted-foreground">
            {m['dashboard.overview.activity_model_breakdown']()}
          </h3>
          <ul className="mt-2 grid max-h-37.5 gap-2 overflow-y-auto">
            {cell.models.map((model) => {
              const percent = Math.round((Number(model.totalTokens) / Number(cell.totalTokens)) * 100);
              return (
                <li key={model.modelId} className="grid gap-1">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="flex min-w-0 gap-1">
                      <span className="truncate">{model.modelId}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatCompactTokenCount(model.totalTokens)}
                      </span>
                    </span>
                    <span>{formatPercent(percent)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>,
    document.body,
  );
};

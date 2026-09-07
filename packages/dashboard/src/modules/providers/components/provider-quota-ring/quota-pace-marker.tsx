import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import type React from 'react';

interface QuotaPaceMarkerProps {
  /** Track position from 0 to 100, where a steady burn would have left the window by now. */
  readonly percent: number;
  /** Spent faster than evenly, which is the one state worth colouring apart from the fill. */
  readonly overspent: boolean;
  readonly label: string;
  readonly testId: string;
}

/**
 * A reference tick over a `Progress` track. It lives here rather than in `@aio-proxy/ui` because that
 * package's `progress.tsx` is shadcn-CLI-managed and an overwrite discards unsanctioned patches.
 *
 * Absolutely positioned against the `Progress` root, whose track is the full-width `h-2` last row, so
 * `bottom-0 h-2` covers exactly the track. `z-10` because the track is a later sibling and would
 * otherwise paint over it. The 5px box is `border-box`, so the two 2px track-coloured borders leave
 * 1px of visible stripe with a gap either side, keeping it legible where it sits on top of the fill.
 */
export const QuotaPaceMarker: React.FC<QuotaPaceMarkerProps> = ({ percent, overspent, label, testId }) => (
  <Tooltip>
    {/* `aria-hidden` because the bar's `getAriaValueText` already spells this reading out; announcing
        it again from a second node would read the same fact twice. Safe to hide because the trigger
        renders a non-focusable span, so nothing keyboard-reachable ends up inside the hidden subtree.
        The stripe is 5px wide and 8px tall, which is not a hover target, so `::after` stretches the
        hit area past it without adding a node that would shift the tick off its position. */}
    <TooltipTrigger
      render={
        <span
          aria-hidden="true"
          data-testid={testId}
          className={`absolute bottom-0 z-10 h-2 w-[5px] -translate-x-1/2 cursor-help border-x-2 border-muted after:absolute after:-inset-x-1.5 after:-inset-y-1 after:content-[''] ${
            overspent ? 'bg-destructive' : 'bg-primary'
          }`}
          style={{ left: `${Math.min(Math.max(percent, 0), 100)}%` }}
        />
      }
    />
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

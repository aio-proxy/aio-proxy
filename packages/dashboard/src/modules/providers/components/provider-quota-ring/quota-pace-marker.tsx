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
 * otherwise paint over it. The 3px box is `border-box`, so the two track-coloured borders leave 1px of
 * visible stripe with a gap either side, keeping it legible where it sits on top of the fill.
 */
export const QuotaPaceMarker: React.FC<QuotaPaceMarkerProps> = ({ percent, overspent, label, testId }) => (
  // Decoration for a reading the bar's `getAriaValueText` already spells out; announcing it again as
  // its own node would read the same fact twice.
  <span
    aria-hidden="true"
    data-testid={testId}
    title={label}
    className={`absolute bottom-0 z-10 h-2 w-[3px] -translate-x-1/2 border-x border-muted ${
      overspent ? 'bg-destructive' : 'bg-primary'
    }`}
    style={{ left: `${Math.min(Math.max(percent, 0), 100)}%` }}
  />
);

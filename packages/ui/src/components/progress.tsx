import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import type * as React from 'react';

import { cn } from '#lib/utils';

function Progress({
  className,
  children,
  value,
  marker,
  ...props
}: ProgressPrimitive.Root.Props & { readonly marker?: React.ReactNode }) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn('flex flex-wrap gap-3', className)}
      {...props}
    >
      {children}
      <ProgressTrack>
        <ProgressIndicator />
        {marker}
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({ className, ...props }: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      className={cn('relative flex h-2 w-full items-center overflow-x-hidden rounded-2xl bg-muted', className)}
      data-slot="progress-track"
      {...props}
    />
  );
}

function ProgressIndicator({ className, ...props }: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn('h-full bg-primary transition-all', className)}
      {...props}
    />
  );
}

/**
 * A reference tick drawn over the track at `percent`. The 3px box is `border-box`, so the two track-
 * colored borders leave exactly 1px of visible stripe with a gap on either side — the stripe stays
 * legible where it sits on top of the indicator instead of blending into it.
 */
function ProgressMarker({
  className,
  percent,
  style,
  ...props
}: React.ComponentProps<'span'> & { readonly percent: number }) {
  return (
    <span
      data-slot="progress-marker"
      className={cn('absolute inset-y-0 w-[3px] -translate-x-1/2 border-x border-muted bg-primary', className)}
      style={{ left: `${Math.min(Math.max(percent, 0), 100)}%`, ...style }}
      {...props}
    />
  );
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label className={cn('text-sm font-medium', className)} data-slot="progress-label" {...props} />
  );
}

function ProgressValue({ className, ...props }: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      className={cn('ml-auto text-sm text-muted-foreground tabular-nums', className)}
      data-slot="progress-value"
      {...props}
    />
  );
}

export { Progress, ProgressTrack, ProgressIndicator, ProgressMarker, ProgressLabel, ProgressValue };

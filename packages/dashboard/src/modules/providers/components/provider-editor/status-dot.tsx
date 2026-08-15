import type React from 'react';

import type { SectionStatus } from '../../lib/section-status';

interface StatusDotProps {
  readonly status: SectionStatus;
}

// A hollow ring reads as "not filled in yet", so `todo` needs no color of its own.
const STATUS_CLASS: Record<SectionStatus, string> = {
  ok: 'bg-primary',
  attention: 'bg-destructive',
  todo: 'bg-transparent ring-1 ring-muted-foreground/50',
};

// Decorative: the hint text beside it already says what the status is.
export const StatusDot: React.FC<StatusDotProps> = ({ status }) => (
  <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_CLASS[status]}`} />
);

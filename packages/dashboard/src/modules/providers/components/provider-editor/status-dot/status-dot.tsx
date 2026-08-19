import type React from 'react';

import type { SectionStatus } from '../../../lib/section-status';

interface StatusDotProps {
  readonly status: SectionStatus;
}

// Severity follows the save gate, not the prototype's palette: `todo` is the only status that disables
// Save (D-F2), so it takes the system's error colour. `attention` is savable, so it gets a warning
// treatment instead — amber mirrors `--destructive`'s red-600/red-400 light/dark pairing, as there is no
// `warning` token. See D-F1 in fidelity-rules.md for the amendment.
export const STATUS_CLASS: Record<SectionStatus, string> = {
  ok: 'bg-primary',
  attention: 'bg-amber-600 dark:bg-amber-400',
  todo: 'bg-destructive',
};

// Decorative: the hint text beside it already says what the status is.
export const StatusDot: React.FC<StatusDotProps> = ({ status }) => (
  <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_CLASS[status]}`} />
);

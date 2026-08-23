import type React from 'react';

import type { SectionStatus } from '../../../lib/section-status';

interface StatusDotProps {
  readonly status: SectionStatus;
}

// Severity is about what the user has to do, not about savability: since X9 every non-`ok` status gates
// Save, so the two cannot be told apart by that any more. `todo` is a field the user must still fill in
// and takes the system's error colour; `attention` is the one state nothing can be persisted from yet (an
// unauthorized oauth draft), whose way out is a round trip rather than a field, so it gets a warning
// treatment — amber mirrors `--destructive`'s red-600/red-400 light/dark pairing, as there is no
// `warning` token. Palette itself is X8 "do not change"; see D-F1 in fidelity-rules.md.
export const STATUS_CLASS: Record<SectionStatus, string> = {
  ok: 'bg-primary',
  attention: 'bg-amber-600 dark:bg-amber-400',
  todo: 'bg-destructive',
};

// Decorative: the hint text beside it already says what the status is.
export const StatusDot: React.FC<StatusDotProps> = ({ status }) => (
  <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${STATUS_CLASS[status]}`} />
);

import { Badge } from '@aio-proxy/ui/components/badge';
import type React from 'react';

import type { SectionId, SectionStatus } from '../../../lib/section-status';
import { StatusDot } from '../status-dot';

interface SectionShellProps {
  readonly id: SectionId;
  readonly title: string;
  readonly description: string;
  readonly status: SectionStatus;
  readonly statusHint: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const SectionShell: React.FC<SectionShellProps> = ({
  id,
  title,
  description,
  status,
  statusHint,
  action,
  children,
}) => (
  <section
    id={`editor-${id}`}
    aria-labelledby={`editor-${id}-heading`}
    className="scroll-mt-28 border-b border-border pb-8 last:border-b-0 last:pb-0"
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <h2 id={`editor-${id}-heading`} className="font-heading text-base font-medium">
            {title}
          </h2>
          {/* Always rendered: an `ok` section states what it settled on, not nothing. */}
          <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
            <StatusDot status={status} />
            {statusHint}
          </Badge>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
    <div className="mt-5 space-y-5">{children}</div>
  </section>
);

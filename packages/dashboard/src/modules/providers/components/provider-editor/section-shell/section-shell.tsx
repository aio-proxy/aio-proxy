import { Badge } from '@aio-proxy/ui/components/badge';
import { Card, CardAction, CardContent, CardHeader } from '@aio-proxy/ui/components/card';
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
    id={id}
    aria-labelledby={`${id}-title`}
    // Both jump surfaces focus this element after scrolling it into view; a bare `<section>` is not
    // programmatically focusable, so without this the focus call is a silent no-op. The native focus
    // ring is deliberately left in place: the whole point of the jump is that the user can tell it landed.
    tabIndex={-1}
    // The card owns the section's padding and its own separating edge, so the shell keeps only the
    // scroll offset that holds a jumped-to heading clear of the sticky nav strip (~37px) plus a little
    // air. Matches the pinned side panel's `lg:top-18`, so a jumped-to section and the panel beside it
    // start on the same line; without the offset the heading lands underneath the strip.
    className="scroll-mt-18"
  >
    <Card>
      <CardHeader>
        {/* A real `<h2>`, not `CardTitle`: these headings are the outline that `SectionNav` and
            `aria-labelledby` both key on, and `CardTitle` renders a `<div>`. The badge stays a sibling
            rather than a child so the status hint never joins the heading's accessible name. */}
        <div className="flex min-w-0 items-center gap-2">
          <h2 id={`${id}-title`} className="font-heading text-base font-medium">
            {title}
          </h2>
          {/* Always rendered: an `ok` section states what it settled on, not nothing. */}
          <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
            <StatusDot status={status} />
            {statusHint}
          </Badge>
        </div>
        {/* `data-slot` is what `CardHeader`'s grid keys on to give the description a row of its own,
            which is the row `CardAction` spans. Without it both land in row 1 and the action overlaps. */}
        <p data-slot="card-description" className="max-w-prose text-sm text-muted-foreground">
          {description}
        </p>
        {/* Conditional, not always-rendered: an empty `CardAction` still carries the `data-slot` that
            switches the header to two columns, leaving a dead gutter beside every action-less section. */}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  </section>
);

import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';

import type { SectionStatus } from '../../lib/section-status';

interface SectionShellProps {
  readonly id: string;
  readonly title: string;
  readonly status: SectionStatus;
  readonly children: React.ReactNode;
}

export const SectionShell: React.FC<SectionShellProps> = ({ id, title, status, children }) => (
  <section id={`editor-${id}`} aria-labelledby={`editor-${id}-heading`} className="scroll-mt-28 space-y-5">
    <div className="flex items-center gap-2">
      <h2 id={`editor-${id}-heading`} className="text-base font-semibold">
        {title}
      </h2>
      {status === 'todo' ? (
        <Badge variant="destructive">{m['dashboard.providers.editor.section_status_todo']()}</Badge>
      ) : null}
      {status === 'attention' ? (
        <Badge variant="outline">{m['dashboard.providers.editor.section_status_attention']()}</Badge>
      ) : null}
    </div>
    {children}
  </section>
);

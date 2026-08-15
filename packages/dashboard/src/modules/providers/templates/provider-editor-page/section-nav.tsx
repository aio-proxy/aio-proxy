import { m } from '@aio-proxy/i18n';

import type { SectionId, SectionSummary } from '../../lib/section-status';

interface SectionNavProps {
  readonly statuses: Readonly<Record<SectionId, SectionSummary>>;
  readonly activeId: SectionId;
}

const SECTION_ORDER: readonly SectionId[] = ['identity', 'connection', 'models', 'routing', 'advanced'];

const SECTION_LABEL = {
  identity: 'dashboard.providers.editor.section_identity',
  connection: 'dashboard.providers.editor.section_connection',
  models: 'dashboard.providers.editor.section_models',
  routing: 'dashboard.providers.editor.section_routing',
  advanced: 'dashboard.providers.editor.section_advanced',
} as const;

const STATUS_LABEL = {
  todo: 'dashboard.providers.editor.section_status_todo',
  attention: 'dashboard.providers.editor.section_status_attention',
} as const;

export const SectionNav: React.FC<SectionNavProps> = ({ statuses, activeId }) => (
  <nav aria-label={m['dashboard.providers.edit_title']()} className="sticky top-24 hidden w-48 shrink-0 lg:block">
    <ol className="space-y-1 text-sm">
      {SECTION_ORDER.map((id, index) => {
        const status = statuses[id].status;
        return (
          <li key={id}>
            <a
              href={`#editor-${id}`}
              aria-current={activeId === id ? 'location' : undefined}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 ${
                activeId === id ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(`editor-${id}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
            >
              <span>{`${index + 1} ${m[SECTION_LABEL[id]]()}`}</span>
              {status === 'ok' ? null : <span className="text-xs">{m[STATUS_LABEL[status]]()}</span>}
            </a>
          </li>
        );
      })}
    </ol>
  </nav>
);

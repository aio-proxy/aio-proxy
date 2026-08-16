import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { blockingSections, type SectionId, type SectionSummary } from '../../lib/section-status';

interface EditorFooterProps {
  readonly summaries: Readonly<Record<SectionId, SectionSummary>>;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly onCancel: () => void;
  readonly onDelete?: (() => void) | undefined;
  readonly pending: boolean;
}

const SECTION_LABEL = {
  identity: 'dashboard.providers.editor.section_identity',
  connection: 'dashboard.providers.editor.section_connection',
  models: 'dashboard.providers.editor.section_models',
  routing: 'dashboard.providers.editor.section_routing',
  advanced: 'dashboard.providers.editor.section_advanced',
} as const satisfies Record<SectionId, string>;

// Declared in rail order, so its keys double as the order the footer lists sections in — and, unlike
// `Object.keys(summaries)`, that order cannot be reshuffled by however the caller built the map. The
// `satisfies` keeps a sixth SectionId from silently going unlisted here.
const SECTION_IDS = Object.keys(SECTION_LABEL) as readonly SectionId[];

export const EditorFooter: React.FC<EditorFooterProps> = ({
  summaries,
  primaryLabel,
  onPrimary,
  onCancel,
  onDelete,
  pending,
}) => {
  // Two lists on purpose (D-F2): everything unfinished is *named*, but only `todo` gates Save. An
  // `attention` section — a weight tie, a stale catalog entry — gets a jump link and a saveable form.
  const listed = SECTION_IDS.filter((id) => summaries[id].status !== 'ok');
  const blocking = blockingSections(summaries);

  return (
    <div
      className="sticky bottom-0 z-10 mt-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur"
      data-testid="editor-footer"
    >
      <p aria-live="polite" className="min-w-0 text-sm text-muted-foreground">
        {listed.length === 0 ? (
          m['dashboard.providers.editor.footer_ready']()
        ) : (
          <>
            <span>
              {blocking.length === listed.length
                ? m['dashboard.providers.editor.footer_blocking']()
                : m['dashboard.providers.editor.footer_attention']()}
            </span>{' '}
            {listed.map((id) => (
              <button
                key={id}
                type="button"
                className="mr-2 underline underline-offset-4 hover:text-foreground"
                onClick={() => document.getElementById(`editor-${id}`)?.scrollIntoView({ behavior: 'smooth' })}
              >
                {m[SECTION_LABEL[id]]()}
              </button>
            ))}
          </>
        )}
      </p>
      <div className="flex gap-3">
        {onDelete === undefined ? null : (
          <Button type="button" variant="destructive" onClick={onDelete}>
            {m['dashboard.providers.actions.delete']()}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel}>
          {m['dashboard.providers.editor.footer_cancel']()}
        </Button>
        <Button type="button" disabled={blocking.length > 0 || pending} onClick={onPrimary}>
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
};

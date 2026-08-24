import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { jumpToSection } from '../../../lib/jump-to-section';
import { blockingSections, SECTION_LABEL, type SectionId, type SectionSummary } from '../../../lib/section-status';

interface EditorFooterProps {
  readonly summaries: Readonly<Record<SectionId, SectionSummary>>;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly onCancel: () => void;
  readonly pending: boolean;
}

export const EditorFooter: React.FC<EditorFooterProps> = ({
  summaries,
  primaryLabel,
  onPrimary,
  onCancel,
  pending,
}) => {
  const blocking = blockingSections(summaries);
  // One list, two lead-ins. Every outstanding section is named *and* gates Save, so the split is purely
  // copy: `missing` narrows to the sections with nothing filled in yet, and only when that is all of
  // them does the sentence promise a missing field. A form held up by an unauthorized account is
  // "pending", not "still missing".
  const missing = blocking.filter((id) => summaries[id].status === 'todo');

  return (
    <div
      className="sticky bottom-2 z-20 rounded-4xl border bg-background/90 shadow-sm/5 backdrop-blur-md"
      data-testid="editor-footer"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        {/* The links live inside the live region on purpose: the announcement is the sentence, and the
            section names are that sentence's object — reading "still missing" without them says nothing.
            Their labels only change when the list does, which is the change worth announcing. */}
        <p aria-live="polite" className="min-w-0 text-sm text-muted-foreground">
          {blocking.length === 0 ? (
            m['dashboard.providers.editor.footer_ready']()
          ) : (
            <>
              {missing.length === blocking.length
                ? m['dashboard.providers.editor.footer_blocking']()
                : m['dashboard.providers.editor.footer_attention']()}{' '}
              {blocking.map((id, index) => (
                <span key={id}>
                  {/* A message, not an inline `、`: en and ko separate with a comma. */}
                  {index > 0 ? m['dashboard.providers.editor.footer_section_separator']() : ''}
                  <a
                    href={`#${id}`}
                    className="underline underline-offset-4 hover:text-foreground"
                    // As in the nav strip: a bare hash jump does not reliably land on ids inside
                    // PageContainer's scroll container, and `jumpToSection` restores the focus move
                    // `preventDefault` suppresses — this is the "take me to what blocks my save" path.
                    onClick={(event) => {
                      event.preventDefault();
                      jumpToSection(id);
                    }}
                  >
                    {m[SECTION_LABEL[id]]()}
                  </a>
                </span>
              ))}
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {m['dashboard.providers.editor.footer_cancel']()}
          </Button>
          <Button type="button" disabled={blocking.length > 0 || pending} onClick={onPrimary}>
            {primaryLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

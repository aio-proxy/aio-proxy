import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import { jumpToSection } from '../../../lib/jump-to-section';
import {
  blockingSections,
  SECTION_LABEL,
  SECTION_ORDER,
  type SectionId,
  type SectionSummary,
} from '../../../lib/section-status';

interface EditorFooterProps {
  readonly summaries: Readonly<Record<SectionId, SectionSummary>>;
  readonly primaryLabel: string;
  readonly onPrimary: () => void;
  readonly onCancel: () => void;
  readonly onDelete?: (() => void) | undefined;
  readonly pending: boolean;
}

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
  const listed = SECTION_ORDER.filter((id) => summaries[id].status !== 'ok');
  const blocking = blockingSections(summaries);

  return (
    <div
      className="sticky bottom-0 z-10 mt-10 flex flex-wrap items-center justify-between gap-3 border-t bg-background/95 py-4 backdrop-blur"
      data-testid="editor-footer"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        {/* The live region is the sentence alone. With the jump links inside it, every status flip
            re-announced the sentence *and* every link label, so typing read the footer aloud. */}
        <p aria-live="polite">
          {listed.length === 0
            ? m['dashboard.providers.editor.footer_ready']()
            : blocking.length > 0
              ? m['dashboard.providers.editor.footer_blocking']()
              : m['dashboard.providers.editor.footer_attention']()}
        </p>
        {listed.map((id) => (
          <button
            key={id}
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => jumpToSection(id)}
          >
            {m[SECTION_LABEL[id]]()}
          </button>
        ))}
      </div>
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

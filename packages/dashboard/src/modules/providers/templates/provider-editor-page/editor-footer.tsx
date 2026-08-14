import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';

import type { SectionId } from '../../lib/section-status';

interface EditorFooterProps {
  readonly blocking: readonly SectionId[];
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
} as const;

export const EditorFooter: React.FC<EditorFooterProps> = ({
  blocking,
  primaryLabel,
  onPrimary,
  onCancel,
  onDelete,
  pending,
}) => (
  <div className="sticky bottom-0 z-10 mt-10 border-t bg-background/95 py-4 backdrop-blur" data-testid="editor-footer">
    {blocking.length > 0 ? (
      <p className="mb-3 text-sm text-muted-foreground">
        <span>{m['dashboard.providers.editor.footer_blocking']()}</span>{' '}
        {blocking.map((id) => (
          <button
            key={id}
            type="button"
            className="mr-2 underline"
            onClick={() => document.getElementById(`editor-${id}`)?.scrollIntoView({ behavior: 'smooth' })}
          >
            {m[SECTION_LABEL[id]]()}
          </button>
        ))}
      </p>
    ) : null}
    <div className="flex items-center justify-between gap-3">
      <div className="flex gap-3">
        <Button type="button" disabled={blocking.length > 0 || pending} onClick={onPrimary}>
          {primaryLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m['dashboard.providers.editor.footer_cancel']()}
        </Button>
      </div>
      {onDelete === undefined ? null : (
        <Button type="button" variant="destructive" onClick={onDelete}>
          {m['dashboard.providers.actions.delete']()}
        </Button>
      )}
    </div>
  </div>
);

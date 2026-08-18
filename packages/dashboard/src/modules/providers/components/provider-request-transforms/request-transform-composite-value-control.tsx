import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Drawer } from '@aio-proxy/ui/components/drawer';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';
import { useState } from 'react';

import { parseCompositeDraft } from './request-transform-composite-draft';
import { RequestTransformJsonDrawerContent } from './request-transform-json-drawer-content';

interface RequestTransformCompositeValueControlProps {
  readonly type: 'object' | 'array';
  readonly draft: string;
  readonly valueId: string;
  readonly labelId: string;
  readonly invalid: boolean;
  readonly describedBy: string | undefined;
  readonly onChange: (draft: string) => void;
}

export const RequestTransformCompositeValueControl: React.FC<RequestTransformCompositeValueControlProps> = ({
  type,
  draft,
  valueId,
  labelId,
  invalid,
  describedBy,
  onChange,
}) => {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const parsed = parseCompositeDraft(type, draft);
  // Defensive and currently unreachable: every write path stores parseable text — `form.reset` seeds from
  // an already parsed `JsonValue`, the type switch resets through `defaultValue`, and drawer apply emits a
  // re-stringified parse. It stays because `commitDraft`'s `parsed !== undefined` check sits immediately in
  // front of `emit` as the trust boundary, so this is what a draft slipping past it would have to look like.
  const [initialDraft, compactJson] =
    parsed === undefined ? [draft, draft] : [JSON.stringify(parsed, null, 2), JSON.stringify(parsed)];
  const typeLabel =
    type === 'object'
      ? m['dashboard.providers.transforms.value.type_object']()
      : m['dashboard.providers.transforms.value.type_array']();
  // The value is the point of this control, so the name is the label plus the button's own contents.
  // Listing the children rather than self-referencing `valueId`: accname implementations disagree on
  // whether an element inside its own `aria-labelledby` contributes its contents, and the ones that
  // drop it would announce the label alone.
  const [jsonId, affordanceId] = [`${valueId}-json`, `${valueId}-affordance`];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        id={valueId}
        className="h-8 min-w-0 justify-between px-3"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${jsonId} ${affordanceId}`}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onClick={() => setOpen(true)}
      >
        <code id={jsonId} className="min-w-0 truncate font-mono text-xs">
          {compactJson}
        </code>
        <span id={affordanceId} className="ml-3 shrink-0 text-xs text-muted-foreground">
          {m['dashboard.providers.transforms.value.edit_json']()}
        </span>
      </Button>
      <Drawer open={open} onOpenChange={setOpen} swipeDirection={isMobile ? 'down' : 'right'}>
        {open ? (
          <RequestTransformJsonDrawerContent
            key={initialDraft}
            type={type}
            typeLabel={typeLabel}
            initialDraft={initialDraft}
            onOpenChange={setOpen}
            onApply={onChange}
          />
        ) : null}
      </Drawer>
    </>
  );
};

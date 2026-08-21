import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useId, useState } from 'react';

import { parseCompositeDraft } from './request-transform-composite-draft';

interface RequestTransformJsonDrawerContentProps {
  readonly type: 'object' | 'array';
  readonly typeLabel: string;
  readonly initialDraft: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onApply: (draft: string) => void;
}

export const RequestTransformJsonDrawerContent: React.FC<RequestTransformJsonDrawerContentProps> = ({
  type,
  typeLabel,
  initialDraft,
  onOpenChange,
  onApply,
}) => {
  const [draft, setDraft] = useState(initialDraft);
  const errorId = useId();
  const parsed = parseCompositeDraft(type, draft);
  const title = m['dashboard.providers.transforms.value.json_title']({ type: typeLabel });

  return (
    <DrawerContent className="p-0 sm:w-full sm:max-w-[680px]" data-testid="request-transform-json-drawer">
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerDescription>
          {m['dashboard.providers.transforms.value.json_description']({ type: typeLabel })}
        </DrawerDescription>
      </DrawerHeader>
      <div className="min-h-0 flex-1 p-4">
        <Textarea
          value={draft}
          rows={22}
          className="h-full min-h-80 resize-none font-mono text-xs"
          data-testid="request-transform-json-draft"
          aria-label={m['dashboard.providers.transforms.value.static_label']()}
          aria-invalid={parsed === undefined}
          aria-describedby={parsed === undefined ? errorId : undefined}
          onChange={(event) => setDraft(event.target.value)}
        />
        {parsed === undefined ? (
          <p id={errorId} role="alert" className="mt-2 text-sm text-destructive">
            {type === 'object'
              ? m['dashboard.providers.transforms.value.invalid_object']()
              : m['dashboard.providers.transforms.value.invalid_array']()}
          </p>
        ) : null}
      </div>
      <DrawerFooter className="flex-row justify-end border-t pt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {m['dashboard.providers.actions.cancel']()}
        </Button>
        <Button
          type="button"
          data-testid="request-transform-json-apply"
          disabled={parsed === undefined}
          onClick={() => {
            if (parsed === undefined) return;
            onApply(JSON.stringify(parsed, null, 2));
            onOpenChange(false);
          }}
        >
          {m['dashboard.providers.transforms.value.json_apply']()}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  );
};

import { m } from '@aio-proxy/i18n';
import { ModelMetadataSchema, type ModelMetadata } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@aio-proxy/ui/components/drawer';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useMemo, useState } from 'react';

export interface ProviderModelMetadataDrawerContentProps {
  readonly model: string;
  readonly initialDraft: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (value: ModelMetadata) => void;
}

export const ProviderModelMetadataDrawerContent: React.FC<ProviderModelMetadataDrawerContentProps> = ({
  model,
  initialDraft,
  onOpenChange,
  onSave,
}) => {
  const [draft, setDraft] = useState(initialDraft);
  const parsed = useMemo(() => {
    try {
      return ModelMetadataSchema.safeParse(JSON.parse(draft));
    } catch {
      return { success: false } as const;
    }
  }, [draft]);

  return (
    <DrawerContent className="p-0 sm:w-full sm:max-w-[680px]" data-testid="provider-model-metadata-drawer">
      <DrawerHeader>
        <DrawerTitle>{m['dashboard.providers.form.metadata_title']({ model })}</DrawerTitle>
        <DrawerDescription>{m['dashboard.providers.form.metadata_description']()}</DrawerDescription>
      </DrawerHeader>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Textarea
          className="min-h-72 font-mono"
          aria-label={m['dashboard.providers.form.metadata_json_label']({ model })}
          aria-invalid={!parsed.success}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {!parsed.success ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {m['dashboard.providers.form.metadata_json_error']()}
          </p>
        ) : null}
      </div>
      <DrawerFooter className="flex-row justify-end border-t pt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {m['dashboard.providers.actions.cancel']()}
        </Button>
        <Button
          type="button"
          disabled={!parsed.success}
          onClick={() => {
            if (!parsed.success) return;
            onSave(parsed.data);
            onOpenChange(false);
          }}
        >
          {m['dashboard.providers.actions.save']()}
        </Button>
      </DrawerFooter>
    </DrawerContent>
  );
};

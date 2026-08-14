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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { Textarea } from '@aio-proxy/ui/components/textarea';
import { useMemo, useState } from 'react';

import { ModelMetadataVisualTab } from '../provider-editor/model-metadata-visual-tab';

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
  // Deliberately not `parsed.data`: the visual tab must merge over a draft the schema rejects
  // (e.g. `limit.input > limit.context`) instead of replacing it with `{}`.
  const rawValue = useMemo((): Readonly<Record<string, unknown>> | undefined => {
    try {
      const value: unknown = JSON.parse(draft);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : undefined;
    } catch {
      return undefined;
    }
  }, [draft]);

  return (
    <DrawerContent className="p-0 sm:w-full sm:max-w-[680px]" data-testid="provider-model-metadata-drawer">
      <DrawerHeader>
        <DrawerTitle>{m['dashboard.providers.form.metadata_title']({ model })}</DrawerTitle>
        <DrawerDescription>{m['dashboard.providers.form.metadata_description']()}</DrawerDescription>
      </DrawerHeader>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {/* JSON is the default: the textarea is the shipped editor and reaches keys the visual tab cannot. */}
        <Tabs defaultValue="json">
          <TabsList>
            {/*
              Disabled while the draft is not a JSON object: the visual tab merges over the parsed
              draft and writes the whole result back, so entering it on unparseable text would
              silently drop every key it cannot render (`name` among them). A visual edit always
              emits `JSON.stringify` output, so this can never disable the tab a user is already on.
            */}
            <TabsTrigger
              value="visual"
              data-testid="metadata-tab-visual"
              disabled={rawValue === undefined}
              aria-describedby={rawValue === undefined ? 'metadata-visual-blocked' : undefined}
            >
              {m['dashboard.providers.editor.metadata_tab_visual']()}
            </TabsTrigger>
            <TabsTrigger value="json">{m['dashboard.providers.editor.metadata_tab_json']()}</TabsTrigger>
          </TabsList>
          <TabsContent value="visual">
            {rawValue === undefined ? null : (
              <ModelMetadataVisualTab value={rawValue} onChange={(next) => setDraft(JSON.stringify(next, null, 2))} />
            )}
          </TabsContent>
          <TabsContent value="json">
            <Textarea
              className="min-h-72 font-mono"
              aria-label={m['dashboard.providers.form.metadata_json_label']({ model })}
              aria-invalid={!parsed.success}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            {!parsed.success ? (
              <p role="alert" id="metadata-visual-blocked" className="mt-2 text-sm text-destructive">
                {m['dashboard.providers.form.metadata_json_error']()}
              </p>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
      <DrawerFooter className="flex-row justify-end border-t pt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {m['dashboard.providers.actions.cancel']()}
        </Button>
        <Button
          type="button"
          data-testid="provider-model-metadata-save"
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

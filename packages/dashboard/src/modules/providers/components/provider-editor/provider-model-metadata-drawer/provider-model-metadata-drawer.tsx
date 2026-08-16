import type { ModelMetadata } from '@aio-proxy/types';
import { Drawer } from '@aio-proxy/ui/components/drawer';
import { useIsMobile } from '@aio-proxy/ui/hooks/use-mobile';

import { ProviderModelMetadataDrawerContent } from './provider-model-metadata-drawer-content';

interface ProviderModelMetadataDrawerProps {
  readonly model: string | null;
  readonly value: ModelMetadata | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (value: ModelMetadata) => void;
}

export const ProviderModelMetadataDrawer: React.FC<ProviderModelMetadataDrawerProps> = ({
  model,
  value,
  onOpenChange,
  onSave,
}) => {
  const isMobile = useIsMobile();
  const initialDraft = JSON.stringify(value ?? {}, null, 2);

  return (
    <Drawer open={model !== null} onOpenChange={onOpenChange} swipeDirection={isMobile ? 'down' : 'right'}>
      {model === null ? null : (
        <ProviderModelMetadataDrawerContent
          key={`${model}:${initialDraft}`}
          model={model}
          initialDraft={initialDraft}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      )}
    </Drawer>
  );
};

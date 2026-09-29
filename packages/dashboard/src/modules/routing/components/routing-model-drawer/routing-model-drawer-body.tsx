import type { DashboardRoutingModel } from '@aio-proxy/types';
import type React from 'react';

import { useModelReference } from '../../hooks/use-model-reference';
import type { useRoutingMetadataForm } from '../../hooks/use-routing-metadata-form';
import { type MetadataRecord, effectiveGroup } from '../../lib/model-metadata-fields';
import { ModelMetadataEditor } from '../model-metadata-editor';
import { RoutingProviderOverrides } from '../routing-provider-overrides';

export type RoutingModelDrawerSection = 'info' | 'price' | 'providers';

export const SECTION_ANCHOR: Readonly<Record<RoutingModelDrawerSection, string>> = {
  info: 'metadata-extend-title',
  price: 'metadata-cost-title',
  providers: 'provider-overrides-title',
};

interface RoutingModelDrawerBodyProps {
  readonly metadata: MetadataRecord | undefined;
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly setMetadataValid: (valid: boolean) => void;
  readonly metadataInvalidDraft: string | undefined;
  readonly setMetadataInvalidDraft: (text: string | undefined) => void;
}

export const RoutingModelDrawerBody: React.FC<RoutingModelDrawerBodyProps> = ({
  metadata,
  metadataForm,
  model,
  writable,
  setMetadataValid,
  metadataInvalidDraft,
  setMetadataInvalidDraft,
}) => {
  const { inherited } = useModelReference(model.modelId, metadata);
  const inheritedRecord = inherited as MetadataRecord | undefined;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <metadataForm.Field name="metadata">
        {(field) => (
          <ModelMetadataEditor
            model={model.modelId}
            value={field.state.value.value}
            onChange={(next) => field.handleChange({ touched: true, value: next })}
            onValidityChange={setMetadataValid}
            invalidDraft={metadataInvalidDraft}
            onInvalidDraftChange={setMetadataInvalidDraft}
            readOnly={!writable}
          >
            <RoutingProviderOverrides
              metadataForm={metadataForm}
              providers={model.providers}
              modelCost={effectiveGroup(metadata, inheritedRecord, 'cost')}
              modelLimit={effectiveGroup(metadata, inheritedRecord, 'limit')}
              writable={writable}
            />
          </ModelMetadataEditor>
        )}
      </metadataForm.Field>
    </div>
  );
};

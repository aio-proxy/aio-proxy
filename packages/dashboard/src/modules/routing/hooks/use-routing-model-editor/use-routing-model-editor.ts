import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useStore } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useRef, useState } from 'react';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingOverrideDraftsValid,
} from '../../lib/routing-metadata-draft';
import { explicitRoutingOverrides } from '../../lib/routing-summary';
import { isStaleRoutingError } from '../../services/routing-service';
import { reconcileRoutingFormRows, routingDraftRecord, useRoutingForm } from '../use-routing-form';
import { useRoutingMetadataForm } from '../use-routing-metadata-form';
import { useRoutingMutation } from '../use-routing-mutation';

interface UseRoutingModelEditorOptions {
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly onReload: () => void | Promise<DashboardRoutingModel | null | undefined>;
}

export const useRoutingModelEditor = ({ model, writable, onReload }: UseRoutingModelEditorOptions) => {
  const mutation = useRoutingMutation();
  const [stale, setStale] = useState(false);
  const [metadataValid, setMetadataValid] = useState(true);
  const reloadGeneration = useRef(0);
  // This separation is deliberate: topology edits must never carry or delete metadata drafts.
  const metadataForm = useRoutingMetadataForm(model);
  const form = useRoutingForm(model, (value) => {
    mutation.mutate(
      {
        modelId: model.modelId,
        revision: model.revision,
        baselineProviderIds: model.baselineProviderIds,
        ...mergeRoutingMutationDrafts(
          explicitRoutingOverrides(routingDraftRecord(value.providers)),
          metadataForm.state.values,
        ),
      },
      {
        onSuccess: () => {
          mutation.reset();
          setStale(false);
        },
        onError: (error) => {
          if (isStaleRoutingError(error)) setStale(true);
        },
      },
    );
  });

  const topologyDirty = useStore(form.store, (state) => state.isDirty);
  const canSubmit = useStore(form.store, (state) => state.canSubmit);
  const metadataValues = useStore(metadataForm.store, (state) => state.values);
  const dirtyTabs = [
    ...(topologyDirty ? (['topology'] as const) : []),
    ...(metadataValues.metadata.touched ? (['metadata'] as const) : []),
    ...(Object.values(metadataValues.overrides).some((override) => override.cost.touched || override.limit.touched)
      ? (['cost'] as const)
      : []),
  ];
  const canSave =
    writable &&
    canSubmit &&
    !mutation.isPending &&
    metadataValid &&
    routingOverrideDraftsValid(metadataValues.overrides);

  useBlocker({ shouldBlockFn: () => dirtyTabs.length > 0 });

  const save = () => form.handleSubmit();

  const reload = () => {
    const generation = ++reloadGeneration.current;
    const initiatedId = model.modelId;
    void Promise.resolve(onReload()).then((next) => {
      if (generation !== reloadGeneration.current) return;
      if (next == null || next.modelId !== initiatedId) return;
      form.setFieldValue('providers', reconcileRoutingFormRows(form.getFieldValue('providers') ?? [], next));
      metadataForm.reset(reconcileRoutingMetadataValues(metadataForm.state.values, next));
    });
  };

  return {
    form,
    metadataForm,
    dirtyTabs,
    canSave,
    save,
    stale,
    reload,
    saveFailed: mutation.error != null && !isStaleRoutingError(mutation.error),
    metadataValid,
    setMetadataValid,
  };
};

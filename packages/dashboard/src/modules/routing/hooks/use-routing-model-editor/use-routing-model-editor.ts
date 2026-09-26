import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useStore } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingOverrideDraftsValid,
  type RoutingMetadataFormValues,
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

const metadataDraftsClean = (values: RoutingMetadataFormValues): RoutingMetadataFormValues => ({
  metadata: { touched: false, value: values.metadata.value },
  overrides: Object.fromEntries(
    Object.entries(values.overrides).map(([providerId, override]) => [
      providerId,
      {
        cost: { touched: false, value: override.cost.value },
        limit: { touched: false, value: override.limit.value },
      },
    ]),
  ),
});

export const useRoutingModelEditor = ({ model, writable, onReload }: UseRoutingModelEditorOptions) => {
  const mutation = useRoutingMutation();
  const [stale, setStale] = useState(false);
  const [metadataValid, setMetadataValid] = useState(true);
  const reloadGeneration = useRef(0);
  const metadataForm = useRoutingMetadataForm(model);
  const formRef = useRef<ReturnType<typeof useRoutingForm> | null>(null);
  const form = useRoutingForm(model, (value) => {
    const topologyAtSubmit = { providers: structuredClone(value.providers) };
    const metadataAtSubmit = structuredClone(metadataForm.state.values);
    const metadataValueAtSubmit = metadataForm.state.values.metadata.value;
    mutation.mutate(
      {
        modelId: model.modelId,
        revision: model.revision,
        baselineProviderIds: model.baselineProviderIds,
        ...mergeRoutingMutationDrafts(explicitRoutingOverrides(routingDraftRecord(value.providers)), metadataAtSubmit),
      },
      {
        onSuccess: () => {
          mutation.reset();
          setStale(false);
          const savedMetadata = metadataDraftsClean({
            metadata: { touched: true, value: metadataValueAtSubmit },
            overrides: metadataAtSubmit.overrides,
          });
          const editorForm = formRef.current;
          if (editorForm === null) return;
          editorForm.reset(editorForm.state.values);
          editorForm.setFieldValue('providers', topologyAtSubmit.providers, { dontUpdateMeta: true });
          metadataForm.reset(savedMetadata);
        },
        onError: (error) => {
          if (isStaleRoutingError(error)) setStale(true);
        },
      },
    );
  });
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  const topologyDirty = useStore(form.store, (state) => state.isDirty);
  const canSubmit = useStore(form.store, (state) => state.canSubmit);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
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
    !isSubmitting &&
    !mutation.isPending &&
    metadataValid &&
    routingOverrideDraftsValid(metadataValues.overrides);

  const navigationBlocked = () => dirtyTabs.length > 0;
  useBlocker({ shouldBlockFn: navigationBlocked, enableBeforeUnload: navigationBlocked });

  const save = () => {
    if (
      !writable ||
      mutation.isPending ||
      form.state.isSubmitting ||
      !form.state.canSubmit ||
      !metadataValid ||
      !routingOverrideDraftsValid(metadataForm.state.values.overrides)
    ) {
      return;
    }
    void form.handleSubmit();
  };

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

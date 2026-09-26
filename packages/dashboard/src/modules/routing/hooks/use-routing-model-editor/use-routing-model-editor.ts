import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useStore } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingOverrideDraftsValid,
  routingMetadataFormValues,
  type RoutingMetadataFormValues,
} from '../../lib/routing-metadata-draft';
import { explicitRoutingOverrides } from '../../lib/routing-summary';
import { isStaleRoutingError } from '../../services/routing-service';
import {
  reconcileRoutingFormRows,
  routingDraftRecord,
  routingFormValues,
  type RoutingFormValues,
  useRoutingForm,
} from '../use-routing-form';
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
  const [formDefaults, setFormDefaults] = useState<RoutingFormValues>(() => routingFormValues(model));
  const [metadataDefaults, setMetadataDefaults] = useState<RoutingMetadataFormValues>(() =>
    routingMetadataFormValues(model),
  );
  const reloadGeneration = useRef(0);
  const latestModel = useRef(model);
  const previousModelIdentity = useRef({ modelId: model.modelId, revision: model.revision });
  const previousReloadModelId = useRef(model.modelId);
  // oxlint-disable-next-line react/refs -- the adoption effect must read the newest same-key model without depending on object identity
  latestModel.current = model;
  const metadataForm = useRoutingMetadataForm(model, metadataDefaults);
  const form = useRoutingForm(
    model,
    (value, submittedForm) => {
      const savedTopology = { providers: value.providers };
      const metadataAtSubmit = metadataForm.state.values;
      const savedMetadata = metadataDraftsClean(metadataAtSubmit);
      mutation.mutate(
        {
          modelId: model.modelId,
          revision: model.revision,
          baselineProviderIds: model.baselineProviderIds,
          ...mergeRoutingMutationDrafts(
            explicitRoutingOverrides(routingDraftRecord(value.providers)),
            metadataAtSubmit,
          ),
        },
        {
          onSuccess: () => {
            mutation.reset();
            setStale(false);
            setFormDefaults(savedTopology);
            setMetadataDefaults(savedMetadata);
            submittedForm.reset(savedTopology);
            metadataForm.reset(savedMetadata);
          },
          onError: (error) => {
            if (isStaleRoutingError(error)) setStale(true);
          },
        },
      );
    },
    formDefaults,
  );
  useEffect(() => {
    const nextModel = latestModel.current;
    const previous = previousModelIdentity.current;
    if (previous.modelId === nextModel.modelId && previous.revision === nextModel.revision) return;
    previousModelIdentity.current = { modelId: nextModel.modelId, revision: nextModel.revision };

    const metadataValues = metadataForm.state.values;
    const metadataTouched =
      metadataValues.metadata.touched ||
      Object.values(metadataValues.overrides).some((override) => override.cost.touched || override.limit.touched);
    if (form.state.isDirty || metadataTouched) return;

    const nextFormDefaults = routingFormValues(nextModel);
    const nextMetadataDefaults = routingMetadataFormValues(nextModel);
    setFormDefaults(nextFormDefaults);
    setMetadataDefaults(nextMetadataDefaults);
    form.reset(nextFormDefaults);
    metadataForm.reset(nextMetadataDefaults);
  }, [form, metadataForm, model.modelId, model.revision]);

  useEffect(() => {
    if (previousReloadModelId.current === model.modelId) return;
    previousReloadModelId.current = model.modelId;
    reloadGeneration.current += 1;
  }, [model.modelId]);

  useEffect(
    () => () => {
      reloadGeneration.current += 1;
    },
    [],
  );

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
      if (latestModel.current.modelId !== initiatedId) return;
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

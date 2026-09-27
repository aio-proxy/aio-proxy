import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useStore } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mergeRoutingMutationDrafts,
  reconcileRoutingMetadataValues,
  routingDirtyTabs,
  routingMetadataTouched,
  routingOverrideDraftsValid,
  type RoutingMetadataFormValues,
} from '../../lib/routing-metadata-draft';
import { explicitRoutingOverrides } from '../../lib/routing-summary';
import { isStaleRoutingError } from '../../services/routing-service';
import { reconcileRoutingFormRows, routingDraftRecord, useRoutingForm } from '../use-routing-form';
import { useRoutingMetadataForm } from '../use-routing-metadata-form';
import { useRoutingMutation } from '../use-routing-mutation';
import { routingEditorBaseline, type RoutingEditorBaseline } from './routing-editor-baseline';

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
  const [baseline, setBaseline] = useState<RoutingEditorBaseline>(() => routingEditorBaseline(model));
  const reloadGeneration = useRef(0);
  const latestModel = useRef(model);
  const previousModelIdentity = useRef({ modelId: model.modelId, revision: model.revision });
  const appliedReloadIdentity = useRef<{ modelId: string; revision: string } | null>(null);
  const previousReloadModelId = useRef(model.modelId);
  // oxlint-disable-next-line react/refs -- the adoption effect must read the newest same-key model without depending on object identity
  latestModel.current = model;
  const metadataForm = useRoutingMetadataForm(model, baseline.metadata);
  const form = useRoutingForm(
    model,
    (value, submittedForm) => {
      const savedTopology = { providers: value.providers };
      const metadataAtSubmit = metadataForm.state.values;
      const savedMetadata = metadataDraftsClean(metadataAtSubmit);
      mutation.mutate(
        {
          modelId: model.modelId,
          revision: baseline.revision,
          baselineProviderIds: baseline.baselineProviderIds,
          ...mergeRoutingMutationDrafts(
            explicitRoutingOverrides(routingDraftRecord(value.providers)),
            metadataAtSubmit,
          ),
        },
        {
          onSuccess: (saved) => {
            mutation.reset();
            setStale(false);
            // The PUT answers with the refreshed inventory, so the next save is checked against the
            // revision this one produced instead of the one it was based on.
            const next = saved.models.find((entry) => entry.modelId === model.modelId);
            setBaseline((previous) => ({
              form: savedTopology,
              metadata: savedMetadata,
              revision: next?.revision ?? previous.revision,
              baselineProviderIds: next?.baselineProviderIds ?? previous.baselineProviderIds,
            }));
            submittedForm.reset(savedTopology);
            metadataForm.reset(savedMetadata);
          },
          onError: (error) => {
            if (isStaleRoutingError(error)) setStale(true);
          },
        },
      );
    },
    baseline.form,
  );
  useEffect(() => {
    const nextModel = latestModel.current;
    const previous = previousModelIdentity.current;
    if (previous.modelId === nextModel.modelId && previous.revision === nextModel.revision) return;
    previousModelIdentity.current = { modelId: nextModel.modelId, revision: nextModel.revision };
    const appliedReload = appliedReloadIdentity.current;
    if (appliedReload?.modelId === nextModel.modelId && appliedReload.revision === nextModel.revision) {
      appliedReloadIdentity.current = null;
      return;
    }

    if (form.state.isDirty || routingMetadataTouched(metadataForm.state.values)) return;

    const next = routingEditorBaseline(nextModel);
    setBaseline(next);
    form.reset(next.form);
    metadataForm.reset(next.metadata);
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
  const dirtyTabs = routingDirtyTabs(topologyDirty, metadataValues);
  const routeDirty = dirtyTabs.length > 0;
  const canSave =
    writable &&
    canSubmit &&
    !isSubmitting &&
    !mutation.isPending &&
    metadataValid &&
    routingOverrideDraftsValid(metadataValues.overrides);

  const navigationBlocked = useCallback((): boolean => routeDirty, [routeDirty]);
  // Both callbacks are effect dependencies of useBlocker, so they are passed by reference rather
  // than wrapped in an arrow. A fresh literal here re-registers history.block() on every render,
  // including the render that opening the confirmation dialog itself causes — tearing down the
  // subscription while the blocker is still waiting on the user's choice.
  const blocker = useBlocker({
    shouldBlockFn: navigationBlocked,
    enableBeforeUnload: navigationBlocked,
    withResolver: true,
  });

  const discard = () => {
    // mutation.reset() only clears the observer; it cannot abort the request. Discarding mid-flight
    // would unlock the controls and let the original write land anyway, persisting the very snapshot
    // the user just threw away.
    if (mutation.isPending) return;
    reloadGeneration.current += 1;
    setStale(false);
    mutation.reset();
    setMetadataValid(true);
    form.reset(baseline.form);
    metadataForm.reset(baseline.metadata);
  };

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
    if (mutation.isPending) return;
    const generation = ++reloadGeneration.current;
    const initiatedId = model.modelId;
    void Promise.resolve(onReload()).then((next) => {
      if (generation !== reloadGeneration.current) return;
      if (next == null || next.modelId !== initiatedId) return;
      if (latestModel.current.modelId !== initiatedId) return;
      appliedReloadIdentity.current = { modelId: next.modelId, revision: next.revision };
      const providers = reconcileRoutingFormRows(form.getFieldValue('providers') ?? [], next);
      const metadata = reconcileRoutingMetadataValues(metadataForm.state.values, next);
      const fresh = routingEditorBaseline(next);
      setBaseline(fresh);
      // The baseline is what the server holds; the preserved edits go back on top as changes. Making
      // them the baseline instead would leave the form pristine, so the dirty markers and the
      // navigation guard would vanish while the edits were still unsaved, and Cancel would have
      // nothing to fall back to.
      form.reset(fresh.form);
      form.setFieldValue('providers', providers);
      metadataForm.reset(fresh.metadata);
      if (routingMetadataTouched(metadata)) {
        metadataForm.setFieldValue('metadata', metadata.metadata);
        metadataForm.setFieldValue('overrides', metadata.overrides);
      }
    });
  };

  return {
    form,
    metadataForm,
    dirtyTabs,
    canSave,
    save,
    discard,
    stale,
    reload,
    blocker,
    /** A save is in flight. Owners must stop accepting edits: the PUT body and the defaults the
     * forms reset to on success are both snapshotted at submit time. */
    saving: mutation.isPending,
    saveFailed: mutation.error != null && !isStaleRoutingError(mutation.error),
    metadataValid,
    setMetadataValid,
  };
};

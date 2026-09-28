import type { DashboardRoutingModel } from '@aio-proxy/types';
import { useStore } from '@tanstack/react-form';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  mergeRoutingMutationDrafts,
  routingDirtyTabs,
  routingMetadataTouched,
  routingOverrideDraftsValid,
  type RoutingMetadataFormValues,
} from '../../lib/routing-metadata-draft';
import { explicitRoutingOverrides } from '../../lib/routing-summary';
import { isStaleRoutingError } from '../../services/routing-service';
import { routingDraftRecord, useRoutingForm } from '../use-routing-form';
import { useRoutingMetadataForm } from '../use-routing-metadata-form';
import { useRoutingMutation } from '../use-routing-mutation';
import { rebaseRoutingEditorMembership, settleRoutingEditorSave } from './routing-editor-apply';
import {
  routingEditorBaseline,
  routingModelIdentity,
  sameRoutingModelIdentity,
  type RoutingEditorBaseline,
  type RoutingModelIdentity,
} from './routing-editor-baseline';
import { createRoutingEditorReload } from './routing-editor-reload';

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
  // Metadata text that does not parse or pass the schema never reaches the form, so it is held here:
  // it is unsaved work that must block leaving, survive the drawer closing, and go on Cancel.
  const [metadataInvalidDraft, setMetadataInvalidDraft] = useState<string | undefined>(undefined);
  const [baseline, setBaseline] = useState<RoutingEditorBaseline>(() => routingEditorBaseline(model));
  const reloadGeneration = useRef(0);
  const latestModel = useRef(model);
  const previousModelIdentity = useRef(routingModelIdentity(model));
  const appliedReloadIdentity = useRef<RoutingModelIdentity | null>(null);
  const previousReloadModelId = useRef(model.modelId);
  // oxlint-disable-next-line react/refs -- the adoption effect must read the newest same-key model without depending on object identity
  latestModel.current = model;
  const metadataForm = useRoutingMetadataForm(model, baseline.metadata);
  const form = useRoutingForm(
    model,
    (value, submittedForm) => {
      const metadataAtSubmit = metadataForm.state.values;
      const submitted = { form: { providers: value.providers }, metadata: metadataDraftsClean(metadataAtSubmit) };
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
            const stored = saved.models.find((entry) => entry.modelId === model.modelId);
            setBaseline(settleRoutingEditorSave({ form: submittedForm, metadataForm }, stored, submitted, baseline));
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
    const identity = routingModelIdentity(nextModel);
    if (sameRoutingModelIdentity(previousModelIdentity.current, identity)) return;
    previousModelIdentity.current = identity;
    const appliedReload = appliedReloadIdentity.current;
    if (appliedReload !== null && sameRoutingModelIdentity(appliedReload, identity)) {
      appliedReloadIdentity.current = null;
      return;
    }

    // Invalid metadata text counts too: it is the visible draft, and resetting the metadata form would
    // hand the editor a new value that replaces it.
    if (form.state.isDirty || routingMetadataTouched(metadataForm.state.values) || metadataInvalidDraft !== undefined) {
      // A dirty draft is kept on purpose when the policy has moved: the next save must be rejected as
      // stale so Reload can rebase it deliberately. A Provider joining or leaving does not move the
      // revision, though, so bailing outright left the rows holding one the config no longer has —
      // and that save would pass the revision check and write its override back. Rebase membership
      // alone, keeping the field edits and the revision they were made against.
      if (nextModel.revision !== baseline.revision) return;
      setBaseline(rebaseRoutingEditorMembership({ form, metadataForm }, nextModel, baseline));
      return;
    }

    const next = routingEditorBaseline(nextModel);
    setBaseline(next);
    form.reset(next.form);
    metadataForm.reset(next.metadata);
    // baselineProviderIds is a dependency because a Provider appearing or disappearing does not move
    // the revision, and the effect must still reconcile. `baseline` is one because the dirty branch
    // compares against the revision the drafts were made on; the identity guard above makes the extra
    // runs it causes a no-op rather than a loop.
  }, [form, metadataForm, model.modelId, model.revision, model.baselineProviderIds, baseline, metadataInvalidDraft]);

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
  const dirtyTabs = routingDirtyTabs(topologyDirty, metadataValues, metadataInvalidDraft !== undefined);
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
    setMetadataInvalidDraft(undefined);
    // A background refetch that arrived while the draft was dirty was deliberately not adopted, and
    // the identity effect already recorded that revision, so it will never fire again for it.
    // Discarding is the moment to take the server's truth; without this the editor stays on values
    // the server has moved past and the next save earns an avoidable stale_revision.
    const latest = latestModel.current;
    const next = latest.revision === baseline.revision ? baseline : routingEditorBaseline(latest);
    previousModelIdentity.current = routingModelIdentity(latest);
    setBaseline(next);
    form.reset(next.form);
    metadataForm.reset(next.metadata);
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

  // The refs are handed over unread: the returned callback is their only reader, and it runs from the
  // Reload click rather than during render.
  // oxlint-disable-next-line react/refs
  const reload = createRoutingEditorReload({
    model,
    latestModel,
    generation: reloadGeneration,
    appliedIdentity: appliedReloadIdentity,
    baseline,
    form,
    metadataForm,
    fetch: onReload,
    disabled: mutation.isPending,
    // The draft is now based on the fetched revision, so the staleness Reload was offered for is
    // resolved. Leaving it set kept the error and the Reload button up until some later save.
    onRebased: (next) => {
      setStale(false);
      setBaseline(next);
    },
  });

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
    metadataInvalidDraft,
    setMetadataInvalidDraft,
  };
};

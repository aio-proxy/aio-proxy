import type { DashboardRoutingModel } from '@aio-proxy/types';
import type { RefObject } from 'react';

import type { useRoutingForm } from '../use-routing-form';
import type { useRoutingMetadataForm } from '../use-routing-metadata-form';
import { applyRoutingEditorRebase } from './routing-editor-apply';
import {
  routingEditorRebase,
  routingModelIdentity,
  type RoutingEditorBaseline,
  type RoutingModelIdentity,
} from './routing-editor-baseline';

export type RoutingEditorReloadDeps = {
  /** The model this editor is mounted on, read at the moment Reload is pressed. */
  readonly model: DashboardRoutingModel;
  /** The newest model the query has delivered, which may differ by the time the fetch resolves. */
  readonly latestModel: RefObject<DashboardRoutingModel>;
  /** Bumped by every reload, discard, model switch and unmount, so a superseded fetch is dropped. */
  readonly generation: RefObject<number>;
  /** Tells the identity effect this revision was already adopted here, so it does not re-reset. */
  readonly appliedIdentity: RefObject<RoutingModelIdentity | null>;
  readonly baseline: RoutingEditorBaseline;
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
  readonly fetch: () => void | Promise<DashboardRoutingModel | null | undefined>;
  /** True while a save is in flight; reloading then would be overwritten by its own onSuccess. */
  readonly disabled: boolean;
  readonly onRebased: (baseline: RoutingEditorBaseline) => void;
};

/**
 * Fetch the model again and rebase the drafts onto it, keeping unsaved work.
 *
 * Three guards drop a resolved payload rather than apply it: a newer reload (or a discard, or an
 * unmount) has bumped the generation; the payload is for a different model than the one Reload was
 * pressed on; or the editor has since been pointed at a different model.
 */
export const createRoutingEditorReload = (deps: RoutingEditorReloadDeps) => (): void => {
  if (deps.disabled) return;
  const generation = ++deps.generation.current;
  const initiatedId = deps.model.modelId;
  void Promise.resolve(deps.fetch()).then((next) => {
    if (generation !== deps.generation.current) return;
    if (next == null || next.modelId !== initiatedId) return;
    if (deps.latestModel.current.modelId !== initiatedId) return;
    deps.appliedIdentity.current = routingModelIdentity(next);
    // The pre-reload baseline is the common ancestor of the three-way merge.
    const rebased = routingEditorRebase(
      next,
      { providers: deps.form.getFieldValue('providers') ?? [], metadata: deps.metadataForm.state.values },
      deps.baseline,
    );
    deps.onRebased(rebased.baseline);
    applyRoutingEditorRebase(deps, rebased);
  });
};

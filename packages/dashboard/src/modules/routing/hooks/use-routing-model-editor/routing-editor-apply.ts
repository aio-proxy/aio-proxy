import type { DashboardRoutingModel } from '@aio-proxy/types';

import { routingMetadataTouched } from '../../lib/routing-metadata-draft';
import type { useRoutingForm } from '../use-routing-form';
import type { useRoutingMetadataForm } from '../use-routing-metadata-form';
import {
  routingEditorBaseline,
  routingEditorRebase,
  type RoutingEditorBaseline,
  type RoutingEditorRebase,
} from './routing-editor-baseline';

export type RoutingEditorForms = {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly metadataForm: ReturnType<typeof useRoutingMetadataForm>;
};

/**
 * Lay a rebase onto the forms: the server's values become the reset baseline, the preserved drafts go
 * back on top as changes.
 *
 * The order matters. Resetting to the drafts instead would leave the form pristine, so the dirty
 * markers and the navigation guard would vanish while the edits were still unsaved, and Cancel would
 * have nothing to fall back to. Edits that happen to match the server settle as clean, which is
 * correct — there is nothing left to save.
 */
export const applyRoutingEditorRebase = (forms: RoutingEditorForms, rebased: RoutingEditorRebase): void => {
  forms.form.reset(rebased.baseline.form);
  forms.form.setFieldValue('providers', rebased.providers);
  forms.metadataForm.reset(rebased.baseline.metadata);
  if (routingMetadataTouched(rebased.metadata)) {
    forms.metadataForm.setFieldValue('metadata', rebased.metadata.metadata);
    forms.metadataForm.setFieldValue('overrides', rebased.metadata.overrides);
  }
};

/**
 * Rebase Provider membership under a dirty draft, keeping the field edits, and return the baseline
 * the drafts now sit on.
 *
 * Only safe when the policy revision has not moved. When it has, the draft must be left alone so the
 * next save is rejected as stale and Reload can rebase it deliberately — adopting a newer revision
 * here would silently defeat that check.
 */
export const rebaseRoutingEditorMembership = (
  forms: RoutingEditorForms,
  model: DashboardRoutingModel,
  baseline: RoutingEditorBaseline,
): RoutingEditorBaseline => {
  const rebased = routingEditorRebase(
    model,
    { providers: forms.form.getFieldValue('providers') ?? [], metadata: forms.metadataForm.state.values },
    baseline,
  );
  applyRoutingEditorRebase(forms, rebased);
  return rebased.baseline;
};

/**
 * Settle both forms after a successful save and return the baseline they now sit on.
 *
 * The PUT answers with the refreshed inventory, and that is what the forms settle on: the server may
 * have rounded or clamped a value, or a Provider may have joined or left while the request was out,
 * so the submitted snapshot can differ from what was stored. When the query then delivers the same
 * inventory, the identity effect resets to it again, which is the same values whichever lands first.
 * Only a response that omits the model falls back to the submitted values.
 */
export const settleRoutingEditorSave = (
  forms: {
    readonly form: { readonly reset: (values: RoutingEditorBaseline['form']) => void };
    readonly metadataForm: { readonly reset: (values: RoutingEditorBaseline['metadata']) => void };
  },
  stored: DashboardRoutingModel | undefined,
  submitted: Pick<RoutingEditorBaseline, 'form' | 'metadata'>,
  previous: RoutingEditorBaseline,
): RoutingEditorBaseline => {
  const baseline = stored === undefined ? { ...previous, ...submitted } : routingEditorBaseline(stored);
  forms.form.reset(baseline.form);
  forms.metadataForm.reset(baseline.metadata);
  return baseline;
};

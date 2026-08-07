import { ProviderRequestTransformRulesSchema } from '@aio-proxy/types';

import { serializeRequestTransformStages, type RequestTransformStageDraft } from '../../lib/request-transforms';

export interface RequestTransformStageControlValues {
  readonly kind: 'set' | 'remove';
  readonly target: 'header' | 'body';
  readonly path: string;
  readonly valueMode: 'static' | 'expression';
}

export const requestTransformStageControlValues = (
  stage: RequestTransformStageDraft,
): RequestTransformStageControlValues => ({
  kind: stage.kind,
  target: stage.target,
  path: stage.path,
  valueMode: stage.kind === 'set' ? stage.value.kind : 'static',
});

export const buildRequestTransformStageDraft = (
  controls: RequestTransformStageControlValues,
  acceptedStage: RequestTransformStageDraft,
): RequestTransformStageDraft => {
  if (controls.kind === 'remove') {
    return { kind: 'remove', target: controls.target, path: controls.path };
  }
  const acceptedValue = acceptedStage.kind === 'set' ? acceptedStage.value : undefined;
  return {
    kind: 'set',
    target: controls.target,
    path: controls.path,
    value:
      acceptedValue?.kind === controls.valueMode
        ? acceptedValue
        : controls.valueMode === 'static'
          ? { kind: 'static', value: null }
          : { kind: 'expression', expression: { kind: 'field', field: 'request.body.value' } },
  };
};

export const validateRequestTransformStageDraft = (stage: RequestTransformStageDraft): boolean =>
  ProviderRequestTransformRulesSchema.safeParse([{ update: serializeRequestTransformStages([stage]) }]).success;

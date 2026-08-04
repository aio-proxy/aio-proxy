import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefCallback } from 'react';

import type { RequestTransformStageDraft } from '../../request-transforms';
import {
  buildRequestTransformStageDraft,
  requestTransformStageControlValues,
  type RequestTransformStageControlValues,
  validateRequestTransformStageDraft,
} from './request-transform-stage-draft';
import { useRequestTransformStageForm } from './request-transform-stage-form';
import { RequestTransformStagePathControl } from './request-transform-stage-path-control';
import { RequestTransformStagePrimaryControls } from './request-transform-stage-primary-controls';
import { RequestTransformStageValueEditor } from './request-transform-stage-value-editor';

export interface RequestTransformStageCardProps {
  readonly value: RequestTransformStageDraft;
  readonly index: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canRemove: boolean;
  readonly structuralDisabled: boolean;
  readonly pathInputRef?: RefCallback<HTMLInputElement>;
  readonly onChange: (value: RequestTransformStageDraft) => void;
  readonly onValidityChange: (valid: boolean) => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

export const RequestTransformStageCard: React.FC<RequestTransformStageCardProps> = ({
  value,
  index,
  canMoveUp,
  canMoveDown,
  canRemove,
  structuralDisabled,
  pathInputRef,
  onChange,
  onValidityChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}) => {
  const actionId = useId();
  const targetId = useId();
  const pathId = useId();
  const valueModeId = useId();
  const form = useRequestTransformStageForm(value);
  const expectedValue = useRef(value);
  const [controlsValid, setControlsValid] = useState(true);
  const [contentValid, setContentValid] = useState(true);
  const [draftKind, setDraftKind] = useState(value.kind);
  const stageValid = controlsValid && (draftKind === 'remove' || contentValid);
  const structureBlocked = structuralDisabled || !stageValid;
  const actionIndex = index + 1;

  useEffect(() => onValidityChange(stageValid), [onValidityChange, stageValid]);
  useEffect(() => {
    if (isEqual(value, expectedValue.current)) return;
    expectedValue.current = value;
    const controls = requestTransformStageControlValues(value);
    form.reset(controls);
    setDraftKind(controls.kind);
    setControlsValid(true);
    setContentValid(true);
  }, [form, value]);

  const emit = (nextStage: RequestTransformStageDraft) => {
    expectedValue.current = nextStage;
    onChange(nextStage);
  };
  const commitControls = (controls: RequestTransformStageControlValues, allowRecovery = false) => {
    setDraftKind(controls.kind);
    const nextStage = buildRequestTransformStageDraft(controls, value);
    const valid = validateRequestTransformStageDraft(nextStage) && (controlsValid || allowRecovery);
    setControlsValid(valid);
    if (valid) emit(nextStage);
  };
  const commitContent = (nextStage: RequestTransformStageDraft) => {
    const valid = validateRequestTransformStageDraft(nextStage);
    setContentValid(valid);
    if (valid) emit(nextStage);
  };

  return (
    <div className="space-y-4 rounded-lg border p-3" data-testid={`request-transform-stage-${index}`}>
      <p className="text-sm font-medium">{m['dashboard.providers.transforms.action.label']({ index: actionIndex })}</p>
      <div className="space-y-4">
        <RequestTransformStagePrimaryControls
          form={form}
          actionId={actionId}
          targetId={targetId}
          onCommit={commitControls}
          onResetContentValidity={() => setContentValid(true)}
        />
        <RequestTransformStagePathControl
          form={form}
          pathId={pathId}
          {...(pathInputRef === undefined ? {} : { pathInputRef })}
          onCommit={commitControls}
        />
        <RequestTransformStageValueEditor
          form={form}
          acceptedStage={value}
          valueModeId={valueModeId}
          onCommitControls={commitControls}
          onCommitContent={commitContent}
          onContentValidityChange={setContentValid}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={structureBlocked || !canRemove}
          onClick={onRemove}
        >
          {m['dashboard.providers.transforms.action.remove_button']({ index: actionIndex })}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={structureBlocked || !canMoveUp} onClick={onMoveUp}>
          {m['dashboard.providers.transforms.action.move_up']({ index: actionIndex })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={structureBlocked || !canMoveDown}
          onClick={onMoveDown}
        >
          {m['dashboard.providers.transforms.action.move_down']({ index: actionIndex })}
        </Button>
      </div>
    </div>
  );
};

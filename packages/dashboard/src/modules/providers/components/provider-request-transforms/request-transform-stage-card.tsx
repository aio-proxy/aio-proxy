import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { isEqual } from 'es-toolkit/predicate';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefCallback } from 'react';

import type { RequestTransformStageDraft } from '../../lib/request-transforms';
import { RequestTransformStageControlsRow } from './request-transform-stage-controls-row';
import {
  buildRequestTransformStageDraft,
  requestTransformStageControlValues,
  type RequestTransformStageControlValues,
  validateRequestTransformStageDraft,
} from './request-transform-stage-draft';
import { useRequestTransformStageForm } from './request-transform-stage-form';
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
    <div className="space-y-2" data-testid={`request-transform-stage-${index}`}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <RequestTransformStageControlsRow
            form={form}
            index={index}
            actionId={actionId}
            pathId={pathId}
            invalid={!controlsValid}
            {...(pathInputRef === undefined ? {} : { pathInputRef })}
            onCommit={commitControls}
            onResetContentValidity={() => setContentValid(true)}
          />
        </div>
        {/* One action cannot be removed or reordered, so the whole group stays out of the row entirely. */}
        {canRemove ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={structureBlocked || !canMoveUp}
              aria-label={m['dashboard.providers.transforms.action.move_up']({ index: actionIndex })}
              onClick={onMoveUp}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={structureBlocked || !canMoveDown}
              aria-label={m['dashboard.providers.transforms.action.move_down']({ index: actionIndex })}
              onClick={onMoveDown}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={structureBlocked}
              aria-label={m['dashboard.providers.transforms.action.remove_button']({ index: actionIndex })}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </>
        ) : null}
      </div>
      <RequestTransformStageValueEditor
        form={form}
        acceptedStage={value}
        valueModeId={valueModeId}
        onCommitControls={commitControls}
        onCommitContent={commitContent}
        onContentValidityChange={setContentValid}
      />
    </div>
  );
};

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
  readonly ruleName: string;
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
  ruleName,
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
  // Bumped only when the parent hands this card an action it did not emit, which is what a reorder or an
  // earlier action's removal does: both lists key rows by index, so the next action slides into this one's
  // row. The controls row holds the only copy of path text no prefix parses out of, and resetting the form
  // does not reach it, so it kept displaying the previous action's unfinished path. Remounting drops it.
  const [controlsKey, setControlsKey] = useState(0);
  const stageValid = controlsValid && (draftKind === 'remove' || contentValid);
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
    setControlsKey((key) => key + 1);
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
            key={controlsKey}
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
            {/* Reordering re-emits this action from its last accepted value, so a move while it is
                mid-edit would silently drop what the user typed — hence its own validity, not the
                editor's. Remove stays enabled either way: discarding the action is the way out. */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!stageValid || !canMoveUp}
              aria-label={m['dashboard.providers.transforms.action.move_up']({ index: actionIndex })}
              onClick={onMoveUp}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={!stageValid || !canMoveDown}
              aria-label={m['dashboard.providers.transforms.action.move_down']({ index: actionIndex })}
              onClick={onMoveDown}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
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
        ruleName={ruleName}
        onCommitControls={commitControls}
        onCommitContent={commitContent}
        onContentValidityChange={setContentValid}
      />
    </div>
  );
};

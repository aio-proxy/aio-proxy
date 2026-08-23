import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformStage } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { useEffect, useState } from 'react';
import type { RefCallback } from 'react';

import {
  parseRequestTransformStages,
  serializeRequestTransformStages,
  type RequestTransformStageDraft,
} from '../../lib/request-transforms';
import { RequestTransformStageCard } from './request-transform-stage-card';

export interface RequestTransformStageListProps {
  readonly value: readonly ProviderRequestTransformStage[];
  readonly ruleName: string;
  readonly firstPathInputRef?: RefCallback<HTMLInputElement>;
  readonly onChange: (value: readonly ProviderRequestTransformStage[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const RequestTransformStageList: React.FC<RequestTransformStageListProps> = ({
  value,
  ruleName,
  firstPathInputRef,
  onChange,
  onValidityChange,
}) => {
  const stages = parseRequestTransformStages(value);
  const [stageValidity, setStageValidity] = useState<Readonly<Record<number, boolean>>>({});
  const stagesValid = stages.every((_, index) => stageValidity[index] !== false);
  useEffect(() => onValidityChange(stagesValid), [onValidityChange, stagesValid]);
  const emit = (nextStages: readonly RequestTransformStageDraft[]) =>
    onChange(serializeRequestTransformStages(nextStages));
  const move = (index: number, target: number) => {
    const nextStages = [...stages];
    [nextStages[index], nextStages[target]] = [nextStages[target]!, nextStages[index]!];
    emit(nextStages);
  };

  return (
    <div className="space-y-3">
      {stages.map((stage, index) => (
        <RequestTransformStageCard
          key={index}
          value={stage}
          index={index}
          canMoveUp={index > 0 && stageValidity[index - 1] !== false}
          canMoveDown={index < stages.length - 1 && stageValidity[index + 1] !== false}
          canRemove={stages.length > 1}
          ruleName={ruleName}
          {...(index === 0 && firstPathInputRef !== undefined ? { pathInputRef: firstPathInputRef } : {})}
          onChange={(nextStage) => emit(stages.map((item, itemIndex) => (itemIndex === index ? nextStage : item)))}
          onValidityChange={(valid) =>
            setStageValidity((current) => (current[index] === valid ? current : { ...current, [index]: valid }))
          }
          onRemove={() => emit(stages.filter((_, itemIndex) => itemIndex !== index))}
          onMoveUp={() => move(index, index - 1)}
          onMoveDown={() => move(index, index + 1)}
        />
      ))}
      <div className="flex flex-wrap gap-2">
        {/* Appending re-emits every action of this rule from its last accepted value, so an unfinished
            action in this rule would lose what the user typed. Other rules are untouched by that emit
            and must not disable this button. */}
        <Button
          type="button"
          variant="outline"
          disabled={!stagesValid}
          onClick={() =>
            emit([...stages, { kind: 'set', target: 'body', path: 'value', value: { kind: 'static', value: null } }])
          }
        >
          {m['dashboard.providers.transforms.action.add']()}
        </Button>
      </div>
    </div>
  );
};

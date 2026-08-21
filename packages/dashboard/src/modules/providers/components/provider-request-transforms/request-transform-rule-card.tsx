import { m } from '@aio-proxy/i18n';
import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformRule } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Input } from '@aio-proxy/ui/components/input';
import { Switch } from '@aio-proxy/ui/components/switch';
import { useForm } from '@tanstack/react-form';
import { isEqual } from 'es-toolkit/predicate';
import { ArrowDownIcon, ArrowUpIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { RefCallback } from 'react';

import { RequestTransformConditionEditor } from './request-transform-condition-editor';
import { RequestTransformStageList } from './request-transform-stage-list';

type Condition = NonNullable<ProviderRequestTransformRule['when']>;

/** The shape the builder itself writes for a regex row, so the seeded row reopens as one editable condition. */
const starterCondition: Condition = { 'request.model': { $regex: '' } };

export interface RequestTransformRuleCardProps {
  readonly value: ProviderRequestTransformRule;
  readonly index: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly structuralDisabled: boolean;
  readonly firstPathInputRef?: RefCallback<HTMLInputElement>;
  readonly onChange: (value: ProviderRequestTransformRule) => void;
  readonly onValidityChange: (valid: boolean) => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

export const RequestTransformRuleCard: React.FC<RequestTransformRuleCardProps> = ({
  value,
  index,
  canMoveUp,
  canMoveDown,
  structuralDisabled,
  firstPathInputRef,
  onChange,
  onValidityChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}) => {
  const ruleIndex = index + 1;
  const form = useForm({ defaultValues: { name: value.name ?? '' } });
  const expectedValue = useRef(value);
  const [nameValid, setNameValid] = useState(true);
  const [conditionValid, setConditionValid] = useState(true);
  const [stagesValid, setStagesValid] = useState(true);
  const ruleValid = nameValid && conditionValid && stagesValid;
  const structureBlocked = structuralDisabled || !ruleValid;

  useEffect(() => onValidityChange(ruleValid), [onValidityChange, ruleValid]);

  useEffect(() => {
    if (isEqual(value, expectedValue.current)) return;
    expectedValue.current = value;
    form.reset({ name: value.name ?? '' });
    setNameValid(true);
  }, [form, value]);

  const commitRule = (candidate: ProviderRequestTransformRule, setValid: (valid: boolean) => void) => {
    const result = ProviderRequestTransformRulesSchema.safeParse([candidate]);
    setValid(result.success);
    if (!result.success) return;
    const nextRule = result.data[0]!;
    expectedValue.current = nextRule;
    onChange(nextRule);
  };

  // One path for the toggle and the builder alike: an emptied condition means the rule carries no `when`.
  const commitCondition = (when: Condition) => {
    if (Object.keys(when).length === 0) {
      const { when: _when, ...ruleWithoutCondition } = value;
      commitRule(ruleWithoutCondition, setConditionValid);
    } else {
      commitRule({ ...value, when }, setConditionValid);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-3" data-testid={`request-transform-rule-${index}`}>
      <div className="flex items-center gap-2">
        <form.Field name="name">
          {(field) => (
            <Input
              value={field.state.value}
              // 默认名是真实值：demo 语义，新建即落盘；清空则移除 `name`
              placeholder={m['dashboard.providers.transforms.rule.label']({ index: ruleIndex })}
              aria-label={m['dashboard.providers.transforms.rule.name']({ index: ruleIndex })}
              className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 text-sm font-medium hover:border-input focus:bg-background"
              onChange={(event) => {
                const name = event.target.value;
                field.handleChange(name);
                if (name === '') {
                  const { name: _name, ...ruleWithoutName } = value;
                  commitRule(ruleWithoutName, setNameValid);
                } else {
                  commitRule({ ...value, name }, setNameValid);
                }
              }}
            />
          )}
        </form.Field>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!canMoveUp}
          aria-label={m['dashboard.providers.transforms.rule.move_up']({ index: ruleIndex })}
          onClick={onMoveUp}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={!canMoveDown}
          aria-label={m['dashboard.providers.transforms.rule.move_down']({ index: ruleIndex })}
          onClick={onMoveDown}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={m['dashboard.providers.transforms.rule.remove']({ index: ruleIndex })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          checked={value.when !== undefined}
          onCheckedChange={(checked) => commitCondition(checked ? starterCondition : {})}
        />
        {m['dashboard.providers.transforms.rule.conditional_toggle']()}
      </label>
      {value.when === undefined ? (
        <p className="text-xs text-muted-foreground">{m['dashboard.providers.transforms.rule.always']()}</p>
      ) : (
        <RequestTransformConditionEditor
          value={value.when}
          onValidityChange={setConditionValid}
          onChange={commitCondition}
        />
      )}
      <RequestTransformStageList
        value={value.update}
        structuralDisabled={structureBlocked}
        {...(firstPathInputRef === undefined ? {} : { firstPathInputRef })}
        onChange={(update) => commitRule({ ...value, update: [...update] }, setStagesValid)}
        onValidityChange={setStagesValid}
      />
    </div>
  );
};

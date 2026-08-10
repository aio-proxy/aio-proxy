import { m } from '@aio-proxy/i18n';
import { ProviderRequestTransformRulesSchema, type ProviderRequestTransformRule } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { useForm } from '@tanstack/react-form';
import { isEqual } from 'es-toolkit/predicate';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefCallback } from 'react';

import { RequestTransformConditionEditor } from './request-transform-condition-editor';
import { RequestTransformStageList } from './request-transform-stage-list';

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
  const nameId = useId();
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

  return (
    <Card data-testid={`request-transform-rule-${index}`}>
      <CardHeader>
        <CardTitle>
          {value.name?.trim() || m['dashboard.providers.transforms.rule.label']({ index: ruleIndex })}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={nameId}>{m['dashboard.providers.transforms.rule.name']({ index: ruleIndex })}</Label>
          <form.Field name="name">
            {(field) => (
              <Input
                id={nameId}
                value={field.state.value}
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
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>{m['dashboard.providers.transforms.rule.when']()}</Label>
            {value.when === undefined ? (
              <span className="text-xs text-muted-foreground">
                {m['dashboard.providers.transforms.rule.match_all']()}
              </span>
            ) : null}
          </div>
          <RequestTransformConditionEditor
            value={value.when ?? {}}
            onValidityChange={setConditionValid}
            onChange={(when) => {
              if (Object.keys(when).length === 0) {
                const { when: _when, ...ruleWithoutCondition } = value;
                commitRule(ruleWithoutCondition, setConditionValid);
              } else {
                commitRule({ ...value, when }, setConditionValid);
              }
            }}
          />
        </div>
        <div className="space-y-3">
          <Label>{m['dashboard.providers.transforms.rule.then']()}</Label>
          <RequestTransformStageList
            value={value.update}
            structuralDisabled={structureBlocked}
            {...(firstPathInputRef === undefined ? {} : { firstPathInputRef })}
            onChange={(update) => commitRule({ ...value, update: [...update] }, setStagesValid)}
            onValidityChange={setStagesValid}
          />
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" disabled={structureBlocked} onClick={onRemove}>
          {m['dashboard.providers.transforms.rule.remove']({ index: ruleIndex })}
        </Button>
        <Button type="button" variant="outline" disabled={structureBlocked || !canMoveUp} onClick={onMoveUp}>
          {m['dashboard.providers.transforms.rule.move_up']({ index: ruleIndex })}
        </Button>
        <Button type="button" variant="outline" disabled={structureBlocked || !canMoveDown} onClick={onMoveDown}>
          {m['dashboard.providers.transforms.rule.move_down']({ index: ruleIndex })}
        </Button>
      </CardFooter>
    </Card>
  );
};

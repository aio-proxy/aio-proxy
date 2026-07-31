import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { useId } from 'react';
import type { RefCallback } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { RequestTransformConditionEditor } from './request-transform-condition-editor';
import { RequestTransformStageList } from './request-transform-stage-list';

export interface RequestTransformRuleCardProps {
  readonly value: ProviderRequestTransformRule;
  readonly index: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly firstPathInputRef?: RefCallback<HTMLInputElement>;
  readonly onChange: (value: ProviderRequestTransformRule) => void;
  readonly onRemove: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
}

export const RequestTransformRuleCard: React.FC<RequestTransformRuleCardProps> = ({
  value,
  index,
  canMoveUp,
  canMoveDown,
  firstPathInputRef,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}) => {
  const nameId = useId();
  const ruleIndex = index + 1;

  return (
    <Card data-testid={`request-transform-rule-${index}`}>
      <CardHeader>
        <CardTitle>{m['dashboard.providers.transforms.rule.label']({ index: ruleIndex })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor={nameId}>{m['dashboard.providers.transforms.rule.name']({ index: ruleIndex })}</Label>
          <Input
            id={nameId}
            value={value.name ?? ''}
            onChange={(event) => {
              const name = event.target.value;
              if (name === '') {
                const { name: _name, ...ruleWithoutName } = value;
                onChange(ruleWithoutName);
              } else {
                onChange({ ...value, name });
              }
            }}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label>{m['dashboard.providers.transforms.rule.condition']()}</Label>
            {value.when === undefined ? (
              <span className="text-xs text-muted-foreground">
                {m['dashboard.providers.transforms.rule.match_all']()}
              </span>
            ) : null}
          </div>
          <RequestTransformConditionEditor
            value={value.when ?? {}}
            onChange={(when) => {
              if (Object.keys(when).length === 0) {
                const { when: _when, ...ruleWithoutCondition } = value;
                onChange(ruleWithoutCondition);
              } else {
                onChange({ ...value, when });
              }
            }}
          />
        </div>
        <RequestTransformStageList
          value={value.update}
          {...(firstPathInputRef === undefined ? {} : { firstPathInputRef })}
          onChange={(update) => onChange({ ...value, update: [...update] })}
        />
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" onClick={onRemove}>
          {m['dashboard.providers.transforms.rule.remove']({ index: ruleIndex })}
        </Button>
        <Button type="button" variant="outline" disabled={!canMoveUp} onClick={onMoveUp}>
          {m['dashboard.providers.transforms.rule.move_up']({ index: ruleIndex })}
        </Button>
        <Button type="button" variant="outline" disabled={!canMoveDown} onClick={onMoveDown}>
          {m['dashboard.providers.transforms.rule.move_down']({ index: ruleIndex })}
        </Button>
      </CardFooter>
    </Card>
  );
};

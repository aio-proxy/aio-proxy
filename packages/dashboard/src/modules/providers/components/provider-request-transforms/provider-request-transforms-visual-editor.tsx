import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { PlusIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { RequestTransformRuleCard } from './request-transform-rule-card';

export interface ProviderRequestTransformsVisualEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
  readonly onValidityChange: (valid: boolean) => void;
}

export const ProviderRequestTransformsVisualEditor: React.FC<ProviderRequestTransformsVisualEditorProps> = ({
  value,
  onChange,
  onValidityChange,
}) => {
  const pendingFocusRule = useRef<number | undefined>(undefined);
  const [ruleValidity, setRuleValidity] = useState<Readonly<Record<number, boolean>>>({});
  const visualValid = value.every((_, index) => ruleValidity[index] !== false);
  useEffect(() => onValidityChange(visualValid), [onValidityChange, visualValid]);
  const move = (index: number, target: number) => {
    const nextRules = [...value];
    [nextRules[index], nextRules[target]] = [nextRules[target]!, nextRules[index]!];
    onChange(nextRules);
  };

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="rounded-xl bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          {m['dashboard.providers.transforms.empty']()}
        </p>
      ) : (
        value.map((rule, index) => (
          <RequestTransformRuleCard
            key={index}
            value={rule}
            index={index}
            canMoveUp={index > 0 && ruleValidity[index - 1] !== false}
            canMoveDown={index < value.length - 1 && ruleValidity[index + 1] !== false}
            firstPathInputRef={(element: HTMLInputElement | null) => {
              if (element === null || pendingFocusRule.current !== index) return;
              pendingFocusRule.current = undefined;
              element.focus();
              element.select();
            }}
            onChange={(nextRule) => onChange(value.map((item, itemIndex) => (itemIndex === index ? nextRule : item)))}
            onValidityChange={(valid) =>
              setRuleValidity((current) => (current[index] === valid ? current : { ...current, [index]: valid }))
            }
            onRemove={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
            onMoveUp={() => move(index, index - 1)}
            onMoveDown={() => move(index, index + 1)}
          />
        ))
      )}
      <div className="flex justify-start">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            pendingFocusRule.current = value.length;
            onChange([
              ...value,
              {
                name: m['dashboard.providers.transforms.rule.label']({ index: value.length + 1 }),
                update: [{ $set: { 'request.body.value': null } }],
              },
            ]);
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {m['dashboard.providers.transforms.rule.add']()}
        </Button>
      </div>
    </div>
  );
};

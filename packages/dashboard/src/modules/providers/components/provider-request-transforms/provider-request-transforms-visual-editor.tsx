import { m } from '@aio-proxy/i18n';
import type { ProviderRequestTransformRule } from '@aio-proxy/types';
import { useRef } from 'react';

import { Button } from '@/components/ui/button';
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty';

import { RequestTransformRuleCard } from './request-transform-rule-card';

export interface ProviderRequestTransformsVisualEditorProps {
  readonly value: readonly ProviderRequestTransformRule[];
  readonly onChange: (value: readonly ProviderRequestTransformRule[]) => void;
}

export const ProviderRequestTransformsVisualEditor: React.FC<ProviderRequestTransformsVisualEditorProps> = ({
  value,
  onChange,
}) => {
  const pendingFocusRule = useRef<number | undefined>(undefined);
  const move = (index: number, target: number) => {
    const nextRules = [...value];
    [nextRules[index], nextRules[target]] = [nextRules[target]!, nextRules[index]!];
    onChange(nextRules);
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => {
            pendingFocusRule.current = value.length;
            onChange([...value, { update: [{ $unset: 'request.body.value' }] }]);
          }}
        >
          {m['dashboard.providers.transforms.rule.add']()}
        </Button>
      </div>
      {value.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m['dashboard.providers.transforms.empty']()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="space-y-4">
          {value.map((rule, index) => (
            <RequestTransformRuleCard
              key={index}
              value={rule}
              index={index}
              canMoveUp={index > 0}
              canMoveDown={index < value.length - 1}
              {...(pendingFocusRule.current === index
                ? {
                    firstPathInputRef: (element: HTMLInputElement | null) => {
                      if (element === null || pendingFocusRule.current !== index) return;
                      pendingFocusRule.current = undefined;
                      element.focus();
                      element.select();
                    },
                  }
                : {})}
              onChange={(nextRule) => onChange(value.map((item, itemIndex) => (itemIndex === index ? nextRule : item)))}
              onRemove={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              onMoveUp={() => move(index, index - 1)}
              onMoveDown={() => move(index, index + 1)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

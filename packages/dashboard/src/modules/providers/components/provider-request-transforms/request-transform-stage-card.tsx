import { m } from '@aio-proxy/i18n';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import { useId } from 'react';
import type React from 'react';
import type { RefCallback } from 'react';
import { QueryBuilderStateProvider } from 'react-querybuilder';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { requestTransformFunctionMeta, type RequestTransformStageDraft } from '../../request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import { RequestTransformExpressionEditor } from './request-transform-expression-editor';
import { RequestTransformStaticValueEditor } from './request-transform-static-value-editor';

type SetStage = Extract<RequestTransformStageDraft, { kind: 'set' }>;

const renderSetValueEditor = (
  value: SetStage,
  valueModeId: string,
  onChange: (value: RequestTransformStageDraft) => void,
): React.ReactNode => (
  <div className="space-y-4">
    <div className="space-y-2">
      <Label htmlFor={valueModeId}>{m['dashboard.providers.transforms.value.mode']()}</Label>
      <Select
        value={value.value.kind}
        onValueChange={(nextMode) => {
          if (nextMode === value.value.kind) return;
          onChange({
            ...value,
            value:
              nextMode === 'expression'
                ? { kind: 'expression', expression: { kind: 'field', field: 'request.body.value' } }
                : { kind: 'static', value: null },
          });
        }}
      >
        <SelectTrigger id={valueModeId} data-testid="request-transform-value-mode" className="w-full">
          <SelectValue>
            {() =>
              value.value.kind === 'static'
                ? m['dashboard.providers.transforms.value.static']()
                : m['dashboard.providers.transforms.value.computed']()
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="static">{m['dashboard.providers.transforms.value.static']()}</SelectItem>
          <SelectItem value="expression">{m['dashboard.providers.transforms.value.computed']()}</SelectItem>
        </SelectContent>
      </Select>
    </div>
    {value.value.kind === 'static' ? (
      <RequestTransformStaticValueEditor
        value={value.value.value}
        onChange={(nextValue) => onChange({ ...value, value: { kind: 'static', value: nextValue } })}
      />
    ) : (
      <div className="overflow-x-auto" aria-label={m['dashboard.providers.transforms.value.computed_label']()}>
        <QueryBuilderStateProvider>
          <QueryBuilderShadcn>
            <QueryBuilderExpressions functions={requestTransformFunctionMeta}>
              <RequestTransformExpressionEditor
                expression={value.value.expression}
                onChange={(expression) => onChange({ ...value, value: { kind: 'expression', expression } })}
              />
            </QueryBuilderExpressions>
          </QueryBuilderShadcn>
        </QueryBuilderStateProvider>
      </div>
    )}
  </div>
);

export interface RequestTransformStageCardProps {
  readonly value: RequestTransformStageDraft;
  readonly index: number;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canRemove: boolean;
  readonly pathInputRef?: RefCallback<HTMLInputElement>;
  readonly onChange: (value: RequestTransformStageDraft) => void;
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
  pathInputRef,
  onChange,
  onRemove,
  onMoveUp,
  onMoveDown,
}) => {
  const actionId = useId();
  const targetId = useId();
  const pathId = useId();
  const valueModeId = useId();
  const actionIndex = index + 1;
  const pathLabel =
    value.target === 'header'
      ? m['dashboard.providers.transforms.target.header_name']()
      : m['dashboard.providers.transforms.target.body_path']();

  return (
    <Card size="sm" data-testid={`request-transform-stage-${index}`}>
      <CardHeader>
        <CardTitle>{m['dashboard.providers.transforms.action.label']({ index: actionIndex })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={actionId}>{m['dashboard.providers.transforms.action.type']()}</Label>
            <Select
              value={value.kind}
              onValueChange={(nextKind) => {
                if (nextKind === null || nextKind === value.kind) return;
                onChange(
                  nextKind === 'set'
                    ? { ...value, kind: 'set', value: { kind: 'static', value: null } }
                    : { kind: 'remove', target: value.target, path: value.path },
                );
              }}
            >
              <SelectTrigger id={actionId} data-testid="request-transform-action" className="w-full">
                <SelectValue>
                  {() =>
                    value.kind === 'set'
                      ? m['dashboard.providers.transforms.action.set']()
                      : m['dashboard.providers.transforms.action.remove']()
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="set">{m['dashboard.providers.transforms.action.set']()}</SelectItem>
                <SelectItem value="remove">{m['dashboard.providers.transforms.action.remove']()}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={targetId}>{m['dashboard.providers.transforms.target.label']()}</Label>
            <Select
              value={value.target}
              onValueChange={(nextTarget) => {
                if (nextTarget !== 'body' && nextTarget !== 'header') return;
                onChange({
                  ...value,
                  target: nextTarget,
                  path: nextTarget === 'header' ? value.path.toLowerCase() : value.path,
                });
              }}
            >
              <SelectTrigger id={targetId} data-testid="request-transform-target" className="w-full">
                <SelectValue>
                  {() =>
                    value.target === 'header'
                      ? m['dashboard.providers.transforms.target.header']()
                      : m['dashboard.providers.transforms.target.body']()
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="header">{m['dashboard.providers.transforms.target.header']()}</SelectItem>
                <SelectItem value="body">{m['dashboard.providers.transforms.target.body']()}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={pathId}>{pathLabel}</Label>
          <Input
            ref={pathInputRef}
            id={pathId}
            className={value.target === 'header' ? 'lowercase' : undefined}
            value={value.path}
            onChange={(event) =>
              onChange({
                ...value,
                path: value.target === 'header' ? event.target.value.toLowerCase() : event.target.value,
              })
            }
          />
        </div>
        {value.kind === 'set' ? renderSetValueEditor(value, valueModeId, onChange) : null}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button type="button" variant="destructive" size="sm" disabled={!canRemove} onClick={onRemove}>
          {m['dashboard.providers.transforms.action.remove_button']({ index: actionIndex })}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!canMoveUp} onClick={onMoveUp}>
          {m['dashboard.providers.transforms.action.move_up']({ index: actionIndex })}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!canMoveDown} onClick={onMoveDown}>
          {m['dashboard.providers.transforms.action.move_down']({ index: actionIndex })}
        </Button>
      </CardFooter>
    </Card>
  );
};

import { m } from '@aio-proxy/i18n';
import { QueryBuilderExpressions } from '@react-querybuilder/expr/ui';
import type React from 'react';
import { QueryBuilderStateProvider } from 'react-querybuilder';

import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { requestTransformFunctionMeta, type RequestTransformStageDraft } from '../../request-transforms';
import { QueryBuilderShadcn } from './query-builder';
import { RequestTransformExpressionEditor } from './request-transform-expression-editor';
import type { RequestTransformStageForm } from './request-transform-stage-controls';
import {
  buildRequestTransformStageDraft,
  type RequestTransformStageControlValues,
} from './request-transform-stage-draft';
import { RequestTransformStaticValueEditor } from './request-transform-static-value-editor';

type SetStage = Extract<RequestTransformStageDraft, { kind: 'set' }>;

const RequestTransformStageValueContent: React.FC<{
  readonly value: SetStage;
  readonly onChange: (value: RequestTransformStageDraft) => void;
  readonly onValidityChange: (valid: boolean) => void;
}> = ({ value, onChange, onValidityChange }) =>
  value.value.kind === 'static' ? (
    <RequestTransformStaticValueEditor
      value={value.value.value}
      onChange={(nextValue) => onChange({ ...value, value: { kind: 'static', value: nextValue } })}
      onValidityChange={onValidityChange}
    />
  ) : (
    <div className="overflow-x-auto" aria-label={m['dashboard.providers.transforms.value.computed_label']()}>
      <QueryBuilderStateProvider>
        <QueryBuilderShadcn>
          <QueryBuilderExpressions functions={requestTransformFunctionMeta}>
            <RequestTransformExpressionEditor
              expression={value.value.expression}
              onChange={(expression) => onChange({ ...value, value: { kind: 'expression', expression } })}
              onValidityChange={onValidityChange}
            />
          </QueryBuilderExpressions>
        </QueryBuilderShadcn>
      </QueryBuilderStateProvider>
    </div>
  );

interface RequestTransformStageValueEditorProps {
  readonly form: RequestTransformStageForm;
  readonly acceptedStage: RequestTransformStageDraft;
  readonly valueModeId: string;
  readonly onCommitControls: (controls: RequestTransformStageControlValues) => void;
  readonly onCommitContent: (stage: RequestTransformStageDraft) => void;
  readonly onContentValidityChange: (valid: boolean) => void;
}

export const RequestTransformStageValueEditor: React.FC<RequestTransformStageValueEditorProps> = ({
  form,
  acceptedStage,
  valueModeId,
  onCommitControls,
  onCommitContent,
  onContentValidityChange,
}) => (
  <form.Subscribe selector={(state) => [state.values.kind, state.values.valueMode] as const}>
    {([kind, valueMode]) => {
      if (kind === 'remove') return null;
      const setStage = buildRequestTransformStageDraft({ ...form.state.values, valueMode }, acceptedStage) as SetStage;
      return (
        <div className="space-y-4">
          <form.Field name="valueMode">
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={valueModeId}>{m['dashboard.providers.transforms.value.mode']()}</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(nextMode) => {
                    if (nextMode !== 'static' && nextMode !== 'expression') return;
                    field.handleChange(nextMode);
                    onContentValidityChange(true);
                    onCommitControls({ ...form.state.values, valueMode: nextMode });
                  }}
                >
                  <SelectTrigger id={valueModeId} data-testid="request-transform-value-mode" className="w-full">
                    <SelectValue>
                      {() =>
                        field.state.value === 'static'
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
            )}
          </form.Field>
          <RequestTransformStageValueContent
            value={setStage}
            onChange={onCommitContent}
            onValidityChange={onContentValidityChange}
          />
        </div>
      );
    }}
  </form.Subscribe>
);

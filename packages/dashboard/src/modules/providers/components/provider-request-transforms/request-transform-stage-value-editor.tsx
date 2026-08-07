import { m } from '@aio-proxy/i18n';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type React from 'react';

import type { RequestTransformStageDraft } from '../../lib/request-transforms';
import {
  buildRequestTransformStageDraft,
  type RequestTransformStageControlValues,
} from './request-transform-stage-draft';
import type { RequestTransformStageForm } from './request-transform-stage-form';
import { RequestTransformStageValueContent } from './request-transform-stage-value-content';

type SetStage = Extract<RequestTransformStageDraft, { kind: 'set' }>;

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

import { m } from '@aio-proxy/i18n';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type React from 'react';

import type { RequestTransformStageControlValues } from './request-transform-stage-draft';
import type { RequestTransformStageForm } from './request-transform-stage-form';

interface RequestTransformStagePrimaryControlsProps {
  readonly form: RequestTransformStageForm;
  readonly actionId: string;
  readonly targetId: string;
  readonly onCommit: (controls: RequestTransformStageControlValues) => void;
  readonly onResetContentValidity: () => void;
}

export const RequestTransformStagePrimaryControls: React.FC<RequestTransformStagePrimaryControlsProps> = ({
  form,
  actionId,
  targetId,
  onCommit,
  onResetContentValidity,
}) => (
  <div className="grid gap-4 sm:grid-cols-2">
    <form.Field name="kind">
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={actionId}>{m['dashboard.providers.transforms.action.type']()}</Label>
          <Select
            value={field.state.value}
            onValueChange={(kind) => {
              if (kind !== 'set' && kind !== 'remove') return;
              field.handleChange(kind);
              onResetContentValidity();
              onCommit({ ...form.state.values, kind });
            }}
          >
            <SelectTrigger id={actionId} data-testid="request-transform-action" className="w-full">
              <SelectValue>
                {() =>
                  field.state.value === 'set'
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
      )}
    </form.Field>
    <form.Field name="target">
      {(field) => (
        <div className="space-y-2">
          <Label htmlFor={targetId}>{m['dashboard.providers.transforms.target.label']()}</Label>
          <Select
            value={field.state.value}
            onValueChange={(target) => {
              if (target !== 'body' && target !== 'header') return;
              field.handleChange(target);
              const path = target === 'header' ? form.state.values.path.toLowerCase() : form.state.values.path;
              form.setFieldValue('path', path);
              onCommit({ ...form.state.values, target, path });
            }}
          >
            <SelectTrigger id={targetId} data-testid="request-transform-target" className="w-full">
              <SelectValue>
                {() =>
                  field.state.value === 'header'
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
      )}
    </form.Field>
  </div>
);

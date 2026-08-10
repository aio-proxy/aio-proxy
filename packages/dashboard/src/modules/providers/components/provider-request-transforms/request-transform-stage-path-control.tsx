import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import type React from 'react';
import type { RefCallback } from 'react';

import type { RequestTransformStageControlValues } from './request-transform-stage-draft';
import type { RequestTransformStageForm } from './request-transform-stage-form';

interface RequestTransformStagePathControlProps {
  readonly form: RequestTransformStageForm;
  readonly pathId: string;
  readonly pathInputRef?: RefCallback<HTMLInputElement>;
  readonly onCommit: (controls: RequestTransformStageControlValues, allowRecovery: boolean) => void;
}

export const RequestTransformStagePathControl: React.FC<RequestTransformStagePathControlProps> = ({
  form,
  pathId,
  pathInputRef,
  onCommit,
}) => (
  <form.Subscribe selector={(state) => state.values.target}>
    {(target) => (
      <form.Field name="path">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={pathId}>
              {target === 'header'
                ? m['dashboard.providers.transforms.target.header_name']()
                : m['dashboard.providers.transforms.target.body_path']()}
            </Label>
            <Input
              ref={pathInputRef}
              id={pathId}
              className={target === 'header' ? 'lowercase' : undefined}
              value={field.state.value}
              onChange={(event) => {
                const path = target === 'header' ? event.target.value.toLowerCase() : event.target.value;
                field.handleChange(path);
                onCommit({ ...form.state.values, path }, true);
              }}
            />
          </div>
        )}
      </form.Field>
    )}
  </form.Subscribe>
);

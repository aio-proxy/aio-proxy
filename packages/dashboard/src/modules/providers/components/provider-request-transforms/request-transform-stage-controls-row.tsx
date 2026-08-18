import { m } from '@aio-proxy/i18n';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import type React from 'react';
import type { RefCallback } from 'react';

import type { RequestTransformStageControlValues } from './request-transform-stage-draft';
import type { RequestTransformStageForm } from './request-transform-stage-form';

interface RequestTransformStageControlsRowProps {
  readonly form: RequestTransformStageForm;
  readonly index: number;
  readonly actionId: string;
  readonly targetId: string;
  readonly pathId: string;
  readonly pathInputRef?: RefCallback<HTMLInputElement>;
  readonly onCommit: (controls: RequestTransformStageControlValues, allowRecovery?: boolean) => void;
  readonly onResetContentValidity: () => void;
}

export const RequestTransformStageControlsRow: React.FC<RequestTransformStageControlsRowProps> = ({
  form,
  index,
  actionId,
  targetId,
  pathId,
  pathInputRef,
  onCommit,
  onResetContentValidity,
}) => (
  // `sr-only` labels are absolutely positioned, so each one names its control without taking a grid track.
  <div className="grid items-center gap-2 sm:grid-cols-[auto_8rem_8rem_minmax(0,1fr)]">
    {/* Later rows keep the connective reserved but hidden, so every stage row lines up on the same tracks.
        Below `sm` the four-column template does not apply, so the reserved cell would only cost a stacked
        line: there is no track left to hold open. */}
    <span
      className={
        index === 0 ? 'text-xs text-muted-foreground' : 'invisible text-xs text-muted-foreground max-sm:hidden'
      }
    >
      {m['dashboard.providers.transforms.rule.then']()}
    </span>
    <form.Field name="kind">
      {(field) => (
        <>
          <Label htmlFor={actionId} className="sr-only">
            {m['dashboard.providers.transforms.action.type']()}
          </Label>
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
        </>
      )}
    </form.Field>
    <form.Field name="target">
      {(field) => (
        <>
          <Label htmlFor={targetId} className="sr-only">
            {m['dashboard.providers.transforms.target.label']()}
          </Label>
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
        </>
      )}
    </form.Field>
    <form.Subscribe selector={(state) => state.values.target}>
      {(target) => (
        <form.Field name="path">
          {(field) => (
            <>
              <Label htmlFor={pathId} className="sr-only">
                {target === 'header'
                  ? m['dashboard.providers.transforms.target.header_name']()
                  : m['dashboard.providers.transforms.target.body_path']()}
              </Label>
              <Input
                ref={pathInputRef}
                id={pathId}
                // The stored value is the bare path: `bodyPath` strips the `request.body.` prefix on parse.
                placeholder={target === 'header' ? 'x-header-name' : 'temperature'}
                className={target === 'header' ? 'font-mono text-xs lowercase' : 'font-mono text-xs'}
                value={field.state.value}
                onChange={(event) => {
                  const path = target === 'header' ? event.target.value.toLowerCase() : event.target.value;
                  field.handleChange(path);
                  onCommit({ ...form.state.values, path }, true);
                }}
              />
            </>
          )}
        </form.Field>
      )}
    </form.Subscribe>
  </div>
);

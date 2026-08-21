import { m } from '@aio-proxy/i18n';
import { FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useState, type RefCallback } from 'react';

import type { RequestTransformStageControlValues } from './request-transform-stage-draft';
import type { RequestTransformStageForm } from './request-transform-stage-form';

const BODY_PREFIX = 'request.body.';
const HEADER_PREFIX = 'request.headers.';

const parseStagePath = (raw: string): { target: 'header' | 'body'; path: string } | undefined => {
  if (raw.startsWith(HEADER_PREFIX)) {
    return { target: 'header', path: raw.slice(HEADER_PREFIX.length).toLowerCase() };
  }
  if (raw.startsWith(BODY_PREFIX)) {
    return { target: 'body', path: raw.slice(BODY_PREFIX.length) };
  }
  return undefined;
};

interface RequestTransformStageControlsRowProps {
  readonly form: RequestTransformStageForm;
  readonly index: number;
  readonly actionId: string;
  readonly pathId: string;
  readonly pathInputRef?: RefCallback<HTMLInputElement>;
  readonly invalid: boolean;
  readonly onCommit: (controls: RequestTransformStageControlValues, allowRecovery?: boolean) => void;
  readonly onResetContentValidity: () => void;
}

export const RequestTransformStageControlsRow: React.FC<RequestTransformStageControlsRowProps> = ({
  form,
  index,
  actionId,
  pathId,
  pathInputRef,
  invalid,
  onCommit,
  onResetContentValidity,
}) => {
  const [pathOverlay, setPathOverlay] = useState<string | undefined>(undefined);
  const pathErrorId = `${pathId}-error`;

  return (
    // `sr-only` labels are absolutely positioned, so each one names its control without taking a grid track.
    <div className="grid items-center gap-2 sm:grid-cols-[auto_8rem_minmax(0,1fr)]">
      {/* Later rows keep the connective reserved but hidden, so every stage row lines up on the same tracks.
        Below `sm` the three-column template does not apply, so the reserved cell would only cost a stacked
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
      <form.Field name="path">
        {(field) => {
          const display =
            pathOverlay ?? `${form.state.values.target === 'header' ? HEADER_PREFIX : BODY_PREFIX}${field.state.value}`;
          return (
            <div className="min-w-0">
              <Label htmlFor={pathId} className="sr-only">
                {display.startsWith(HEADER_PREFIX)
                  ? m['dashboard.providers.transforms.target.header_name']()
                  : m['dashboard.providers.transforms.target.body_path']()}
              </Label>
              <Input
                ref={pathInputRef}
                id={pathId}
                placeholder="request.body.temperature"
                className="font-mono text-xs"
                value={display}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? pathErrorId : undefined}
                onChange={(event) => {
                  const raw = event.target.value;
                  const parsed = parseStagePath(raw);
                  if (parsed === undefined) {
                    setPathOverlay(raw);
                    onCommit({ ...form.state.values, path: '' }, true);
                    return;
                  }
                  setPathOverlay(undefined);
                  field.handleChange(parsed.path);
                  form.setFieldValue('target', parsed.target);
                  onCommit({ ...form.state.values, target: parsed.target, path: parsed.path }, true);
                }}
              />
              {invalid ? (
                <FieldError id={pathErrorId}>
                  {m['dashboard.providers.transforms.invalid']({ path: display || '$', code: 'INVALID_PATH' })}
                </FieldError>
              ) : null}
            </div>
          );
        }}
      </form.Field>
    </div>
  );
};

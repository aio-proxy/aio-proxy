import { m } from '@aio-proxy/i18n';
import type { AliasTarget } from '@aio-proxy/types';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import type { Dispatch, FC, SetStateAction } from 'react';

import type { AliasDraftForm } from '../alias-editor';
import type { VisibleEditError } from '../alias-editor-copy';

type Props = {
  readonly form: AliasDraftForm;
  readonly target: AliasTarget;
  readonly models: readonly string[];
  readonly nameId: string;
  readonly targetId: string;
  readonly preserveId: string;
  readonly nameInvalid: boolean;
  readonly targetInvalid: boolean;
  readonly preserveCount: number;
  readonly errorMessage: string | null;
  readonly setEditError: Dispatch<SetStateAction<VisibleEditError | null>>;
  readonly onChange: (target: AliasTarget) => void;
  readonly commitName: (name: string) => void;
};

export const ProviderVariantFields: FC<Props> = ({
  form,
  target,
  models,
  nameId,
  targetId,
  preserveId,
  nameInvalid,
  targetInvalid,
  preserveCount,
  errorMessage,
  setEditError,
  onChange,
  commitName,
}) => (
  <>
    <FieldGroup className="gap-4 md:grid md:grid-cols-2">
      <form.Field name="name">
        {(field) => (
          <Field data-invalid={nameInvalid}>
            <FieldLabel htmlFor={nameId}>{m['dashboard.providers.form.variant_name']()}</FieldLabel>
            <Input
              id={nameId}
              value={field.state.value}
              aria-invalid={nameInvalid}
              onChange={(event) => {
                field.handleChange(event.target.value);
                setEditError(null);
              }}
              onBlur={() => {
                field.handleBlur();
                commitName(field.state.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitName(field.state.value);
                }
              }}
            />
          </Field>
        )}
      </form.Field>
      <form.Field name="model">
        {(field) => (
          <Field data-invalid={targetInvalid}>
            <FieldLabel htmlFor={targetId}>{m['dashboard.providers.form.variant_target']()}</FieldLabel>
            <Select
              value={field.state.value}
              onValueChange={(model) => {
                if (model === null) return;
                field.handleChange(model);
                setEditError(null);
                onChange({ ...target, model });
              }}
            >
              <SelectTrigger id={targetId} className="w-full" aria-invalid={targetInvalid}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )}
      </form.Field>
      <form.Field name="preserve">
        {(field) => (
          <Field orientation="horizontal">
            <Switch
              id={preserveId}
              checked={field.state.value}
              onCheckedChange={(preserve) => {
                const checked = Boolean(preserve);
                field.handleChange(checked);
                onChange({ ...target, preserve: checked });
              }}
            />
            <FieldLabel htmlFor={preserveId}>{m['dashboard.providers.form.variant_preserve']()}</FieldLabel>
          </Field>
        )}
      </form.Field>
      {preserveCount > 0 && (
        <FieldDescription>{m['dashboard.providers.form.preserve_shared']({ count: preserveCount })}</FieldDescription>
      )}
    </FieldGroup>
    {errorMessage !== null && <FieldError className="mt-3">{errorMessage}</FieldError>}
  </>
);

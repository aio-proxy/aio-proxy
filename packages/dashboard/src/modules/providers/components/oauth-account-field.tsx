import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';

import { resolveDashboardText } from '@/lib/localized-text';

import type { OAuthProviderForm, OAuthProviderFormValues } from '../hooks/use-oauth-provider-form';
import { SecretAccountField } from './secret-account-field';

export interface FieldApi<T> {
  readonly state: { readonly value: T };
  readonly handleChange: (value: T) => void;
}

export interface OAuthAccountFieldProps {
  readonly field: DashboardOAuthFormField;
  readonly combined: Record<string, unknown>;
  readonly publicField: FieldApi<OAuthProviderFormValues['publicValues']>;
  readonly secretField: FieldApi<OAuthProviderFormValues['secrets']>;
  readonly jsonField: FieldApi<OAuthProviderFormValues['jsonValues']>;
  readonly form: OAuthProviderForm;
}

const optionValue = (value: string | number | boolean) => JSON.stringify(value);
const validJson = (value: string) => {
  if (value === '') return true;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
};

export const OAuthAccountField: React.FC<OAuthAccountFieldProps> = (props) => {
  const { field, combined, publicField, jsonField } = props;
  if (field.when !== undefined && combined[field.when.key] !== field.when.equals) return null;
  const label = resolveDashboardText(field.label);
  const description = field.description === undefined ? undefined : resolveDashboardText(field.description);
  const current = publicField.state.value[field.key];
  const setPublic = (value: unknown) =>
    publicField.handleChange({
      ...publicField.state.value,
      [field.key]: value,
    } as OAuthProviderFormValues['publicValues']);

  if (field.type === 'secret') {
    return <SecretAccountField field={field} label={label} secretField={props.secretField} form={props.form} />;
  }
  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal">
        <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
        <Switch
          id={`oauth-${field.key}`}
          checked={Boolean(current ?? field.defaultValue)}
          onCheckedChange={(checked) => setPublic(Boolean(checked))}
        />
      </Field>
    );
  }
  if (field.type === 'select') {
    return (
      <Field>
        <Label>{label}</Label>
        <Select
          value={current === undefined ? '' : optionValue(current as string | number | boolean)}
          onValueChange={(value) => setPublic(value === null ? undefined : JSON.parse(value))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={optionValue(option.value)} value={optionValue(option.value)}>
                {resolveDashboardText(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  }
  if (field.type === 'json') {
    const value = jsonField.state.value[field.key] ?? (current === undefined ? '' : JSON.stringify(current));
    const invalid = !validJson(value);
    return (
      <Field>
        <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
        <Textarea
          id={`oauth-${field.key}`}
          value={value}
          aria-invalid={invalid}
          onChange={(event) => {
            const next = event.target.value;
            jsonField.handleChange({ ...jsonField.state.value, [field.key]: next });
            if (validJson(next)) setPublic(next === '' ? undefined : JSON.parse(next));
          }}
        />
        {invalid ? (
          <p className="text-sm text-destructive">{m['dashboard.providers.form.options_json_error']()}</p>
        ) : null}
      </Field>
    );
  }
  return (
    <Field>
      <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
      <Input
        id={`oauth-${field.key}`}
        type={field.type === 'number' ? 'number' : 'text'}
        value={typeof current === 'string' || typeof current === 'number' ? current : ''}
        placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
        onChange={(event) => {
          let value: string | number | undefined = event.target.value;
          if (field.type === 'number') value = value === '' ? undefined : Number(value);
          setPublic(value);
        }}
      />
      {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
    </Field>
  );
};

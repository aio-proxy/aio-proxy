import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Field, FieldContent, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { Textarea } from '@aio-proxy/ui/components/textarea';

import { isValidJson, optionValue } from '@/lib/json-form-value';
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
  readonly locked?: boolean;
}

const selectPlaceholder = () => m['dashboard.providers.oauth.account_select_placeholder']();

export const OAuthAccountField: React.FC<OAuthAccountFieldProps> = (props) => {
  const { field, combined, publicField, jsonField, locked = false } = props;
  if (field.when !== undefined && combined[field.when.key] !== field.when.equals) return null;
  // `description` sits on the base schema, so every one of the six variants can carry one and every
  // branch below has to render it and point its control at it.
  const controlId = `oauth-${field.key}`;
  const label = resolveDashboardText(field.label);
  const description = field.description === undefined ? undefined : resolveDashboardText(field.description);
  const descriptionId = description === undefined ? undefined : `${controlId}-description`;
  const current = publicField.state.value[field.key];
  const setPublic = (value: unknown) => {
    // Deleting rather than assigning `undefined`: this object is serialized into the OAuth session
    // start body, where a key present with an undefined value is not the same as an absent key.
    const next: Record<string, unknown> = { ...publicField.state.value };
    if (value === undefined) delete next[field.key];
    else next[field.key] = value;
    publicField.handleChange(next as OAuthProviderFormValues['publicValues']);
  };

  if (field.type === 'secret') {
    return (
      <SecretAccountField
        field={field}
        label={label}
        description={description}
        secretField={props.secretField}
        form={props.form}
        locked={locked}
      />
    );
  }
  if (field.type === 'boolean') {
    return (
      <Field orientation="horizontal">
        <FieldContent>
          <Label htmlFor={controlId}>{label}</Label>
          {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
        </FieldContent>
        <Switch
          id={controlId}
          aria-describedby={descriptionId}
          checked={Boolean(current ?? field.defaultValue)}
          disabled={locked}
          onCheckedChange={(checked) => setPublic(Boolean(checked))}
        />
      </Field>
    );
  }
  if (field.type === 'select') {
    const optionLabel = (value: string | null) => {
      const selected = field.options.find((option) => optionValue(option.value) === value);
      return selected === undefined ? selectPlaceholder() : resolveDashboardText(selected.label);
    };
    return (
      <Field>
        <Label htmlFor={controlId}>{label}</Label>
        <Select
          value={current === undefined ? '' : optionValue(current as string | number | boolean)}
          disabled={locked}
          onValueChange={(value) => setPublic(value === null ? undefined : JSON.parse(value))}
        >
          <SelectTrigger id={controlId} aria-describedby={descriptionId}>
            {/* The trigger has to show the option's label: the raw value is JSON, so rendering it
                would read as `"github.com"`, quotes included, and as nothing at all when unselected. */}
            <SelectValue placeholder={selectPlaceholder()}>{optionLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={optionValue(option.value)} value={optionValue(option.value)}>
                {resolveDashboardText(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
      </Field>
    );
  }
  if (field.type === 'json') {
    const fallback = current ?? field.defaultValue;
    const value = jsonField.state.value[field.key] ?? (fallback === undefined ? '' : JSON.stringify(fallback));
    const invalid = !isValidJson(value);
    const errorId = invalid ? `${controlId}-error` : undefined;
    const describedBy = [descriptionId, errorId].filter((id) => id !== undefined).join(' ') || undefined;
    return (
      <Field>
        <Label htmlFor={controlId}>{label}</Label>
        <Textarea
          id={controlId}
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          disabled={locked}
          placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
          onChange={(event) => {
            const next = event.target.value;
            jsonField.handleChange({ ...jsonField.state.value, [field.key]: next });
            if (isValidJson(next)) setPublic(next === '' ? undefined : JSON.parse(next));
          }}
        />
        {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
        {invalid ? (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {m['dashboard.providers.form.options_json_error']()}
          </p>
        ) : null}
      </Field>
    );
  }
  return (
    <Field>
      <Label htmlFor={controlId}>{label}</Label>
      <Input
        id={controlId}
        aria-describedby={descriptionId}
        type={field.type === 'number' ? 'number' : 'text'}
        value={typeof current === 'string' || typeof current === 'number' ? current : ''}
        disabled={locked}
        placeholder={field.placeholder === undefined ? undefined : resolveDashboardText(field.placeholder)}
        onChange={(event) => {
          let value: string | number | undefined = event.target.value;
          if (field.type === 'number') value = value === '' ? undefined : Number(value);
          setPublic(value);
        }}
      />
      {description === undefined ? null : <FieldDescription id={descriptionId}>{description}</FieldDescription>}
    </Field>
  );
};

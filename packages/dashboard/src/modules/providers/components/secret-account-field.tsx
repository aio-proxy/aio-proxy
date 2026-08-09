import { m } from '@aio-proxy/i18n';
import type { DashboardOAuthFormField } from '@aio-proxy/types';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import type { AnyFieldApi } from '@tanstack/react-form';

import type { OAuthProviderForm, OAuthProviderFormValues } from '../hooks/use-oauth-provider-form';

export interface SecretAccountFieldProps {
  readonly field: Extract<DashboardOAuthFormField, { type: 'secret' }>;
  readonly label: string;
  readonly secretField: {
    readonly state: { readonly value: OAuthProviderFormValues['secrets'] };
    readonly handleChange: (value: OAuthProviderFormValues['secrets']) => void;
  };
  readonly form: OAuthProviderForm;
}

export const SecretAccountField: React.FC<SecretAccountFieldProps> = ({ field, label, secretField, form }) => (
  <Field>
    <Label htmlFor={`oauth-${field.key}`}>{label}</Label>
    <Input
      id={`oauth-${field.key}`}
      type="password"
      value={secretField.state.value[field.key] ?? ''}
      onChange={(event) => secretField.handleChange({ ...secretField.state.value, [field.key]: event.target.value })}
    />
    {field.configured ? (
      <>
        <p className="text-sm text-muted-foreground">{m['dashboard.providers.oauth.secret_configured']()}</p>
        <form.Field name="clearSecrets">
          {(clearField: AnyFieldApi) => (
            <Label className="flex items-center gap-2">
              <Checkbox
                checked={clearField.state.value.includes(field.key)}
                onCheckedChange={(checked) =>
                  clearField.handleChange(
                    checked
                      ? [...clearField.state.value, field.key]
                      : clearField.state.value.filter((key: string) => key !== field.key),
                  )
                }
              />
              {m['dashboard.providers.oauth.clear_secret']()}
            </Label>
          )}
        </form.Field>
      </>
    ) : null}
  </Field>
);

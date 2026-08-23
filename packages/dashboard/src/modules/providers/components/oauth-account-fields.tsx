import type { DashboardOAuthFormField } from '@aio-proxy/types';
import type { AnyFieldApi } from '@tanstack/react-form';

import type { OAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthAccountField } from './oauth-account-field';

interface OAuthAccountFieldsProps {
  readonly fields: readonly DashboardOAuthFormField[];
  readonly form: OAuthProviderForm;
  readonly locked?: boolean;
}

export const OAuthAccountFields: React.FC<OAuthAccountFieldsProps> = ({ fields, form, locked = false }) => (
  <form.Field name="publicValues">
    {(publicField: AnyFieldApi) => (
      <form.Field name="secrets">
        {(secretField: AnyFieldApi) => (
          <form.Field name="jsonValues">
            {(jsonField: AnyFieldApi) => {
              const combined = { ...publicField.state.value, ...secretField.state.value };
              return (
                <div className="space-y-4">
                  {fields.map((field) => (
                    <OAuthAccountField
                      key={field.key}
                      field={field}
                      combined={combined}
                      publicField={publicField}
                      secretField={secretField}
                      jsonField={jsonField}
                      form={form}
                      locked={locked}
                    />
                  ))}
                </div>
              );
            }}
          </form.Field>
        )}
      </form.Field>
    )}
  </form.Field>
);

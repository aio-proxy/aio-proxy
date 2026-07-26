import type { DashboardOAuthFormField } from '@aio-proxy/types';

import type { useOAuthProviderForm } from '../hooks/use-oauth-provider-form';
import { OAuthAccountField } from './oauth-account-field';

interface OAuthAccountFieldsProps {
  readonly fields: readonly DashboardOAuthFormField[];
  readonly form: ReturnType<typeof useOAuthProviderForm>;
}

export const OAuthAccountFields: React.FC<OAuthAccountFieldsProps> = ({ fields, form }) => (
  <form.Field name="publicValues">
    {(publicField) => (
      <form.Field name="secrets">
        {(secretField) => (
          <form.Field name="jsonValues">
            {(jsonField) => {
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

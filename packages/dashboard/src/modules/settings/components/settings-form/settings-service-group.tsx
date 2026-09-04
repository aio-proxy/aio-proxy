import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { FieldGroup } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';

import { SettingsEndpointFields } from './settings-endpoint-fields';
import { SettingsFieldRow } from './settings-field-row';
import { proxySchema } from './settings-form-contract';
import { SettingsPasswordField } from './settings-password-field';
import type { SettingsFormApi } from './use-settings-form';

interface SettingsServiceGroupProps {
  readonly disabled: boolean;
  readonly form: SettingsFormApi;
  readonly settings: DashboardSettingsView;
  readonly onAccessChange: (field: 'host' | 'port', input: DashboardSettingsMutationInput) => void;
  readonly onSave: (input: DashboardSettingsMutationInput) => void;
}

export const SettingsServiceGroup: React.FC<SettingsServiceGroupProps> = ({
  disabled,
  form,
  settings,
  onAccessChange,
  onSave,
}) => (
  <Card data-testid="settings-group-service">
    <CardHeader>
      <CardTitle>
        <h2>{m['dashboard.settings.service_group']()}</h2>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <FieldGroup>
        <SettingsEndpointFields disabled={disabled} form={form} settings={settings} onAccessChange={onAccessChange} />
        <SettingsPasswordField disabled={disabled} settings={settings} onSave={onSave} />
        <form.Field name="proxy">
          {(field) => {
            const proxy = field.state.value.trim() || null;
            const unchangedMask = proxy === '****' && settings.proxy === '****';
            const invalid = field.state.meta.isTouched && !unchangedMask && !proxySchema.safeParse(proxy).success;
            return (
              <SettingsFieldRow
                label={m['dashboard.settings.default_proxy']()}
                htmlFor={field.name}
                description={m['dashboard.settings.proxy_description']()}
                error={invalid ? m['dashboard.settings.invalid']() : null}
              >
                <Input
                  id={field.name}
                  value={field.state.value}
                  disabled={disabled}
                  aria-invalid={invalid}
                  placeholder={
                    settings.proxy === '****'
                      ? m['dashboard.settings.proxy_placeholder_configured']()
                      : m['dashboard.settings.proxy_placeholder_empty']()
                  }
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={() => {
                    field.handleBlur();
                    if (field.state.meta.isDirty && !unchangedMask && proxySchema.safeParse(proxy).success) {
                      onSave({ proxy });
                    }
                  }}
                />
              </SettingsFieldRow>
            );
          }}
        </form.Field>
      </FieldGroup>
    </CardContent>
  </Card>
);

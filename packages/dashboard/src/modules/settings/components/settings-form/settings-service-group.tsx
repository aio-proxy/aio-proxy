import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';

import { SettingsEndpointFields } from './settings-endpoint-fields';
import { proxySchema } from './settings-form-contract';
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
      <div className="grid gap-5 md:grid-cols-2">
        <SettingsEndpointFields disabled={disabled} form={form} settings={settings} onAccessChange={onAccessChange} />
        <Field>
          <Label htmlFor="dashboard-password-state">{m['dashboard.settings.password']()}</Label>
          <Input
            id="dashboard-password-state"
            type="password"
            value={settings.hasPassword ? '********' : ''}
            placeholder={m['dashboard.settings.password_not_configured']()}
            readOnly
            aria-readonly="true"
          />
          <FieldDescription>
            {settings.hasPassword
              ? m['dashboard.settings.password_configured']()
              : m['dashboard.settings.password_not_configured']()}{' '}
            {m['dashboard.settings.password_description']()}
          </FieldDescription>
        </Field>
        <form.Field name="proxy">
          {(field) => {
            const proxy = field.state.value.trim() || null;
            const unchangedMask = proxy === '****' && settings.proxy === '****';
            const invalid = field.state.meta.isTouched && !unchangedMask && !proxySchema.safeParse(proxy).success;
            return (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.settings.default_proxy']()}</Label>
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
                <FieldDescription>{m['dashboard.settings.proxy_description']()}</FieldDescription>
                <FieldError>{invalid ? m['dashboard.settings.invalid']() : null}</FieldError>
              </Field>
            );
          }}
        </form.Field>
      </div>
    </CardContent>
  </Card>
);

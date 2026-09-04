import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Input } from '@aio-proxy/ui/components/input';

import { SettingsFieldRow } from '../settings-field-row';
import { hostSchema, portSchema } from './settings-form-contract';
import type { SettingsFormApi } from './use-settings-form';

interface SettingsEndpointFieldsProps {
  readonly disabled: boolean;
  readonly form: SettingsFormApi;
  readonly settings: DashboardSettingsView;
  readonly onAccessChange: (field: 'host' | 'port', input: DashboardSettingsMutationInput) => void;
}

export const SettingsEndpointFields: React.FC<SettingsEndpointFieldsProps> = ({
  disabled,
  form,
  settings,
  onAccessChange,
}) => (
  <>
    <form.Field name="host">
      {(field) => {
        const invalid = field.state.meta.isTouched && !hostSchema.safeParse(field.state.value).success;
        return (
          <SettingsFieldRow
            label={m['dashboard.settings.host']()}
            htmlFor={field.name}
            description={m['dashboard.settings.host_description']()}
            error={invalid ? m['dashboard.settings.invalid']() : null}
          >
            <Input
              id={field.name}
              value={field.state.value}
              aria-invalid={invalid}
              disabled={disabled}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={() => {
                field.handleBlur();
                if (hostSchema.safeParse(field.state.value).success && field.state.value !== settings.host) {
                  onAccessChange('host', { host: field.state.value });
                }
              }}
            />
          </SettingsFieldRow>
        );
      }}
    </form.Field>
    <form.Field name="port">
      {(field) => {
        const invalid = field.state.meta.isTouched && !portSchema.safeParse(field.state.value).success;
        return (
          <SettingsFieldRow
            label={m['dashboard.settings.port']()}
            htmlFor={field.name}
            description={m['dashboard.settings.port_description']()}
            error={invalid ? m['dashboard.settings.invalid']() : null}
          >
            <Input
              id={field.name}
              type="number"
              min={1}
              max={65_535}
              value={field.state.value}
              aria-invalid={invalid}
              disabled={disabled}
              onChange={(event) => field.handleChange(Number(event.target.value))}
              onBlur={() => {
                field.handleBlur();
                if (portSchema.safeParse(field.state.value).success && field.state.value !== settings.port) {
                  onAccessChange('port', { port: field.state.value });
                }
              }}
            />
          </SettingsFieldRow>
        );
      }}
    </form.Field>
  </>
);

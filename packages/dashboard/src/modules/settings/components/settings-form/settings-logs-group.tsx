import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';

import { levelSchema, retentionSchema, retrySchema } from './settings-form-contract';
import type { SettingsFormApi } from './use-settings-form';

interface SettingsLogsGroupProps {
  readonly disabled: boolean;
  readonly form: SettingsFormApi;
  readonly settings: DashboardSettingsView;
  readonly onSave: (input: DashboardSettingsMutationInput) => void;
}

export const SettingsLogsGroup: React.FC<SettingsLogsGroupProps> = ({ disabled, form, settings, onSave }) => (
  <Card data-testid="settings-group-logs">
    <CardHeader>
      <CardTitle>
        <h2>{m['dashboard.settings.logs_group']()}</h2>
      </CardTitle>
      <CardAction>
        <form.Field name="logging.enabled">
          {(field) => (
            <Field orientation="horizontal">
              <Label htmlFor={field.name}>{m['dashboard.settings.request_logging']()}</Label>
              <Switch
                id={field.name}
                checked={field.state.value}
                disabled={disabled}
                aria-label={m['dashboard.settings.request_logging']()}
                onCheckedChange={(enabled) => {
                  field.handleChange(enabled);
                  onSave({ logging: { enabled } });
                }}
              />
            </Field>
          )}
        </form.Field>
      </CardAction>
    </CardHeader>
    <CardContent>
      <FieldDescription className="mb-5">{m['dashboard.settings.request_logging_description']()}</FieldDescription>
      <div className="grid gap-5 md:grid-cols-3">
        <form.Field name="logging.retentionDays">
          {(field) => {
            const invalid = field.state.meta.isTouched && !retentionSchema.safeParse(field.state.value).success;
            return (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.settings.retention_days']()}</Label>
                <Input
                  id={field.name}
                  type="number"
                  min={1}
                  max={365}
                  value={field.state.value}
                  aria-invalid={invalid}
                  disabled={disabled}
                  onChange={(event) => field.handleChange(Number(event.target.value))}
                  onBlur={() => {
                    field.handleBlur();
                    if (
                      retentionSchema.safeParse(field.state.value).success &&
                      field.state.value !== settings.logging.retentionDays
                    ) {
                      onSave({ logging: { retentionDays: field.state.value } });
                    }
                  }}
                />
                <FieldError>{invalid ? m['dashboard.settings.invalid']() : null}</FieldError>
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="logging.level">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.settings.log_level']()}</Label>
              <Select
                value={field.state.value}
                disabled={disabled}
                onValueChange={(value) => {
                  const parsed = levelSchema.safeParse(value);
                  if (!parsed.success) return;
                  field.handleChange(parsed.data);
                  onSave({ logging: { level: parsed.data } });
                }}
              >
                <SelectTrigger id={field.name} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {levelSchema.options.map((level) => (
                    <SelectItem key={level} value={level}>
                      {level}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="retryAfterCapSeconds">
          {(field) => {
            const retryMs = field.state.value * 1_000;
            const invalid = field.state.meta.isTouched && !retrySchema.safeParse(retryMs).success;
            return (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.settings.retry_after_cap']()}</Label>
                <Input
                  id={field.name}
                  type="number"
                  min={0}
                  max={300}
                  value={field.state.value}
                  aria-invalid={invalid}
                  disabled={disabled}
                  onChange={(event) => field.handleChange(Number(event.target.value))}
                  onBlur={() => {
                    field.handleBlur();
                    if (retrySchema.safeParse(retryMs).success && retryMs !== settings.retryAfterCapMs) {
                      onSave({ retryAfterCapMs: retryMs });
                    }
                  }}
                />
                <FieldDescription>{m['dashboard.settings.retry_description']()}</FieldDescription>
                <FieldError>{invalid ? m['dashboard.settings.invalid']() : null}</FieldError>
              </Field>
            );
          }}
        </form.Field>
      </div>
    </CardContent>
  </Card>
);

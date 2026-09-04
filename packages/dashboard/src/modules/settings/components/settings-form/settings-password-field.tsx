import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Field, FieldDescription, FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { useForm } from '@tanstack/react-form';

import { passwordSchema, type SettingsSave } from './settings-form-contract';

interface SettingsPasswordFieldProps {
  readonly disabled: boolean;
  readonly settings: DashboardSettingsView;
  readonly onSave: SettingsSave;
}

export const SettingsPasswordField: React.FC<SettingsPasswordFieldProps> = ({ disabled, settings, onSave }) => {
  const form = useForm({ defaultValues: { password: '' } });

  return (
    <form.Field name="password">
      {(field) => {
        const draft = field.state.value;
        const tooShort = draft !== '' && !passwordSchema.safeParse(draft).success;
        return (
          <Field>
            <Label htmlFor="dashboard-password">{m['dashboard.settings.password']()}</Label>
            <Input
              id="dashboard-password"
              type="password"
              autoComplete="new-password"
              value={draft}
              disabled={disabled}
              aria-invalid={tooShort}
              placeholder={
                settings.hasPassword
                  ? m['dashboard.settings.password_configured']()
                  : m['dashboard.settings.password_not_configured']()
              }
              onChange={(event) => field.handleChange(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={disabled || draft === '' || tooShort}
                onClick={() => {
                  const parsed = passwordSchema.safeParse(draft);
                  if (!parsed.success) return;
                  // A rejected write leaves nothing to restore the secret from, so hold the
                  // draft until the server confirms rather than making the user retype it.
                  onSave({ password: parsed.data }, { onSuccess: () => field.handleChange('') });
                }}
              >
                {m['dashboard.settings.password_save']()}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || !settings.hasPassword}
                onClick={() => {
                  onSave({ password: null }, { onSuccess: () => field.handleChange('') });
                }}
              >
                {m['dashboard.settings.password_clear']()}
              </Button>
            </div>
            <FieldDescription>
              {settings.hasPassword
                ? m['dashboard.settings.password_configured']()
                : m['dashboard.settings.password_not_configured']()}{' '}
              {m['dashboard.settings.password_description']()}
            </FieldDescription>
            <FieldError>{tooShort ? m['dashboard.settings.password_too_short']() : null}</FieldError>
          </Field>
        );
      }}
    </form.Field>
  );
};

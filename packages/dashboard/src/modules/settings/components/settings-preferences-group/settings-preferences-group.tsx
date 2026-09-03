import { getLocale, getLocaleName, type Locale, locales, m, setLocale } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useTheme } from 'next-themes';

import { reloadDashboard } from '@/lib/reload-dashboard';

const themes = [
  ['system', () => m['dashboard.preferences.theme_system']()],
  ['light', () => m['dashboard.preferences.theme_light']()],
  ['dark', () => m['dashboard.preferences.theme_dark']()],
] as const;

export const SettingsPreferencesGroup: React.FC = () => {
  const { theme = 'system', setTheme } = useTheme();
  const form = useForm({ defaultValues: { locale: getLocale(), theme } });

  const changeLocale = async (locale: Locale) => {
    if (locale === getLocale()) return;
    await setLocale(locale);
    reloadDashboard();
  };

  return (
    <Card data-testid="settings-group-preferences">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.preferences_group']()}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-5 md:grid-cols-2">
          <form.Field name="theme">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.preferences.appearance']()}</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (typeof value !== 'string') return;
                    field.handleChange(value);
                    setTheme(value);
                  }}
                >
                  <SelectTrigger id={field.name} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {themes.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{m['dashboard.settings.appearance_description']()}</FieldDescription>
              </Field>
            )}
          </form.Field>
          <form.Field name="locale">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.preferences.language']()}</Label>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (typeof value !== 'string') return;
                    field.handleChange(value as Locale);
                    void changeLocale(value as Locale);
                  }}
                >
                  <SelectTrigger id={field.name} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {locales.map((locale) => (
                      <SelectItem key={locale} value={locale}>
                        {getLocaleName(locale)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{m['dashboard.settings.language_description']()}</FieldDescription>
              </Field>
            )}
          </form.Field>
        </div>
      </CardContent>
    </Card>
  );
};

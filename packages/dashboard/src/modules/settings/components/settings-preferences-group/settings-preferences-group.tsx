import { getLocale, getLocaleName, type Locale, locales, m, setLocale } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field, FieldContent, FieldDescription, FieldGroup } from '@aio-proxy/ui/components/field';
import { Label } from '@aio-proxy/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@aio-proxy/ui/components/toggle-group';
import { useForm } from '@tanstack/react-form';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import { reloadDashboard } from '@/lib/reload-dashboard';

const themes = [
  ['system', Monitor, () => m['dashboard.preferences.theme_system']()],
  ['light', Sun, () => m['dashboard.preferences.theme_light']()],
  ['dark', Moon, () => m['dashboard.preferences.theme_dark']()],
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
        <FieldGroup>
          <form.Field name="theme">
            {(field) => (
              // Three mutually exclusive options with well-known icons read faster as a segmented
              // control than a dropdown. `ToggleGroup` gives arrow-key roving and keeps exactly one
              // pressed; its `value` is an array even in single-select mode, and an empty array means
              // the user re-pressed the active option, which is no change rather than "no theme".
              // `role="presentation"` drops `Field`'s own `role="group"`: the named group is the
              // `ToggleGroup`, and `Label` has no control to point at here.
              <Field orientation="horizontal" role="presentation">
                <FieldContent>
                  <Label>{m['dashboard.preferences.appearance']()}</Label>
                  <FieldDescription>{m['dashboard.settings.appearance_description']()}</FieldDescription>
                </FieldContent>
                <ToggleGroup
                  aria-label={m['dashboard.preferences.appearance']()}
                  variant="outline"
                  spacing={0}
                  value={[field.state.value]}
                  onValueChange={(next) => {
                    const [value] = next;
                    if (value === undefined) return;
                    field.handleChange(value);
                    setTheme(value);
                  }}
                >
                  {themes.map(([value, Icon, label]) => (
                    <ToggleGroupItem key={value} value={value} aria-label={label()}>
                      <Icon />
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            )}
          </form.Field>
          <form.Field name="locale">
            {(field) => (
              <Field orientation="horizontal">
                <FieldContent>
                  <Label htmlFor={field.name}>{m['dashboard.preferences.language']()}</Label>
                  <FieldDescription>{m['dashboard.settings.language_description']()}</FieldDescription>
                </FieldContent>
                {/* Base UI renders the raw value in the trigger unless the root can map values to
                    labels, so `items` is what makes the trigger read "简体中文" and not "zh-Hans". */}
                <Select
                  items={Object.fromEntries(locales.map((locale) => [locale, getLocaleName(locale)]))}
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (typeof value !== 'string') return;
                    field.handleChange(value as Locale);
                    void changeLocale(value as Locale);
                  }}
                >
                  <SelectTrigger id={field.name}>
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
              </Field>
            )}
          </form.Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
};

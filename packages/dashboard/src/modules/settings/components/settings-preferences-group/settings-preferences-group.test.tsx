import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { SettingsPreferencesGroup } from './settings-preferences-group';

const mocks = rs.hoisted(() => ({
  reloadDashboard: rs.fn(),
  setLocale: rs.fn().mockResolvedValue(undefined),
  setTheme: rs.fn(),
}));

rs.mock('next-themes', () => ({
  useTheme: () => ({ theme: 'system', setTheme: mocks.setTheme }),
}));

rs.mock('@aio-proxy/i18n', () => ({
  getLocale: () => 'en',
  getLocaleName: (locale: string) => (locale === 'en' ? 'English' : '简体中文'),
  locales: ['en', 'zh-Hans'],
  setLocale: mocks.setLocale,
  m: {
    'dashboard.preferences.appearance': () => 'Appearance',
    'dashboard.preferences.language': () => 'Language',
    'dashboard.preferences.theme_system': () => 'System',
    'dashboard.preferences.theme_light': () => 'Light',
    'dashboard.preferences.theme_dark': () => 'Dark',
    'dashboard.settings.preferences_group': () => 'Appearance & language',
    'dashboard.settings.appearance_description': () => 'Applies to this browser only.',
    'dashboard.settings.language_description': () => 'Reloads the Dashboard to apply.',
  },
}));

rs.mock('@/lib/reload-dashboard', () => ({ reloadDashboard: mocks.reloadDashboard }));

const pick = async (trigger: HTMLElement, option: string) => {
  fireEvent.click(trigger);
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerDown(item, { pointerType: 'mouse' });
  fireEvent.click(item);
};

test('stores the appearance without touching the settings mutation', async () => {
  render(<SettingsPreferencesGroup />);

  fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

  await waitFor(() => {
    expect(mocks.setTheme).toHaveBeenCalledWith('dark');
  });
});

test('re-pressing the active appearance leaves the theme alone', async () => {
  mocks.setTheme.mockReset();
  render(<SettingsPreferencesGroup />);

  // Single-select ToggleGroup reports an empty array when the pressed option is pressed again.
  // "No theme" is not a state the dashboard has — `system` already spells it.
  fireEvent.click(screen.getByRole('button', { name: 'System' }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
  });
  expect(mocks.setTheme).not.toHaveBeenCalled();
});

test('shows the language name rather than the locale code in the trigger', () => {
  render(<SettingsPreferencesGroup />);

  expect(screen.getByLabelText('Language')).toHaveTextContent('English');
});

test('stores a different language and reloads the Dashboard', async () => {
  render(<SettingsPreferencesGroup />);

  await pick(screen.getByLabelText('Language'), '简体中文');

  await waitFor(() => {
    expect(mocks.setLocale).toHaveBeenCalledWith('zh-Hans');
    expect(mocks.reloadDashboard).toHaveBeenCalledTimes(1);
  });
});

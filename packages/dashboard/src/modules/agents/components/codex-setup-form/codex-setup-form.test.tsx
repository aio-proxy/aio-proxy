import type { CodexSetupPlan } from '@aio-proxy/types';
import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CodexSetupForm } from './codex-setup-form';

const plan = (overrides: Partial<CodexSetupPlan> = {}): CodexSetupPlan => ({
  configPath: '/home/me/.codex/config.toml',
  inspection: { status: 'absent' },
  defaultProviderId: 'aio-proxy',
  defaultAuthMode: 'command',
  occupiedProviderIds: ['taken'],
  keyChoices: [{ id: 'k1', label: 'Primary' }],
  sessions: { groups: [], blocked: 0 },
  planToken: 'token',
  ...overrides,
});

test('command mode needs no key and submits the plan token', async () => {
  const onSubmit = rs.fn();
  render(<CodexSetupForm plan={plan()} busy={false} onSubmit={onSubmit} onRestoreMigration={rs.fn()} />);
  expect(screen.queryByTestId('codex-key-field')).toBeNull();
  expect(screen.queryByTestId('codex-migration')).toBeNull();
  fireEvent.submit(screen.getByTestId('codex-setup-form'));
  await waitFor(() =>
    expect(onSubmit).toHaveBeenCalledWith({
      providerId: 'aio-proxy',
      auth: { mode: 'command' },
      migrateFrom: [],
      planToken: 'token',
    }),
  );
});

test('keep-ChatGPT mode offers keys, and sessions from other providers can be migrated', () => {
  render(
    <CodexSetupForm
      plan={plan({
        defaultAuthMode: 'keep-chatgpt',
        sessions: { groups: [{ providerId: 'openai', active: 3, archived: 1 }], blocked: 0 },
      })}
      busy={false}
      onSubmit={rs.fn()}
      onRestoreMigration={rs.fn()}
    />,
  );
  expect(screen.getByTestId('codex-key-field')).toBeTruthy();
  expect(screen.getByTestId('codex-migration').textContent).toContain('openai');
});

test('an occupied provider ID is rejected before anything is sent', async () => {
  const onSubmit = rs.fn();
  render(<CodexSetupForm plan={plan()} busy={false} onSubmit={onSubmit} onRestoreMigration={rs.fn()} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'taken' } });
  fireEvent.submit(screen.getByTestId('codex-setup-form'));
  await waitFor(() => expect(screen.getByText(/config\.toml/u)).toBeTruthy());
  expect(onSubmit).not.toHaveBeenCalled();
});

test('a conflicting config blocks saving', () => {
  render(
    <CodexSetupForm
      plan={plan({ inspection: { status: 'conflict' } })}
      busy={false}
      onSubmit={rs.fn()}
      onRestoreMigration={rs.fn()}
    />,
  );
  expect(screen.getByRole('alert')).toBeTruthy();
  expect((screen.getByRole('button', { name: /Save|保存/u }) as HTMLButtonElement).disabled).toBe(true);
});

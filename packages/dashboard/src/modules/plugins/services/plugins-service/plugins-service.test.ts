import { expect, rs, test } from '@rstest/core';

import { installPluginMutationFn, PluginRequestError, uninstallPluginMutationFn } from './plugins-service';

const mocks = rs.hoisted(() => ({
  install: rs.fn(),
  uninstall: rs.fn(),
}));

rs.mock('@/lib/dashboard-client', () => ({
  createDashboardClient: () => ({
    dashboard: {
      api: {
        plugins: {
          install: { $post: mocks.install },
          uninstall: { $delete: mocks.uninstall },
        },
      },
    },
  }),
}));

test('preserves confirmation_required as a recoverable install error', async () => {
  mocks.install.mockResolvedValue({
    json: () => Promise.resolve({ error: { code: 'confirmation_required' }, ok: false }),
    ok: false,
    status: 400,
  });

  await expect(installPluginMutationFn({ packageName: '@example/plugin' })).rejects.toEqual(
    new PluginRequestError('confirmation_required', 400),
  );
});

test('preserves dependent Provider IDs from an uninstall refusal', async () => {
  mocks.uninstall.mockResolvedValue({
    json: () =>
      Promise.resolve({ error: { code: 'dependent_providers', providerIds: ['primary', 'fallback'] }, ok: false }),
    ok: false,
    status: 409,
  });

  await expect(uninstallPluginMutationFn('@example/plugin')).rejects.toEqual(
    new PluginRequestError('dependent_providers', 409, ['primary', 'fallback']),
  );
});

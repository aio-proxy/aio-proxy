import { expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen } from '@testing-library/react';

import { SettingsReloadButton } from './settings-reload-button';

const mocks = rs.hoisted(() => ({ mutate: rs.fn() }));

rs.mock('../../hooks/use-reload-mutation', () => ({
  useReloadMutation: () => ({ isPending: false, mutate: mocks.mutate }),
}));

const toasts = rs.hoisted(() => ({ add: rs.fn() }));

rs.mock('@aio-proxy/ui/components/toast', () => ({ toast: toasts }));

const clickAndFailWith = async (error: unknown) => {
  toasts.add.mockReset();
  mocks.mutate.mockImplementation((_input: unknown, options: { readonly onError: (error: unknown) => void }) => {
    options.onError(error);
  });
  render(<SettingsReloadButton />);
  fireEvent.click(screen.getByRole('button'));
  const [[call]] = toasts.add.mock.calls as readonly [readonly [{ readonly title: string }]];
  return call.title;
};

test('translates a typed reload stage instead of leaking the internal identifier', async () => {
  const { ReloadFailedError } = await import('../../services/reload-service');

  const title = await clickAndFailWith(new ReloadFailedError('alias-collision'));

  // The raw token would leave every non-English user with a mixed-language sentence.
  expect(title).not.toMatch(/alias-collision/u);
  expect(title).toMatch(/model alias collision|模型别名冲突|模型別名衝突|モデルエイリアスの競合|모델 별칭 충돌/u);
});

test('falls back to the localized unknown stage for an unrecognized failure', async () => {
  const title = await clickAndFailWith(new Error('boom'));

  expect(title).not.toMatch(/boom/u);
  expect(title).toMatch(/unknown|未知|不明|알 수 없음/u);
});

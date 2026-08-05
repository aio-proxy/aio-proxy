import type { DashboardOAuthProviderEdit, OAuthProvider } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';

import { OAuthProviderEditPage } from './oauth-provider-edit-page';

rs.mock('../components/provider-request-transforms/provider-request-transforms-editor', () => ({
  ProviderRequestTransformsEditor: ({ onValidityChange }: { onValidityChange: (valid: boolean) => void }) => {
    useEffect(() => onValidityChange(mocks.transformsValid), [onValidityChange]);
    return null;
  },
}));

const provider: OAuthProvider = {
  kind: 'oauth',
  id: 'person',
  plugin: '@example/oauth',
  capability: 'default',
  name: 'Personal',
  enabled: true,
  weight: 2,
  options: { tenant: 'work' },
  alias: { chat: { model: 'model-2', preserve: false } },
};

const oauth: DashboardOAuthProviderEdit = {
  accountLabel: 'person@example.com',
  publicValues: { tenant: 'work' },
  form: [
    { type: 'text', key: 'tenant', label: 'Tenant' },
    { type: 'secret', key: 'token', label: 'Token', configured: true },
  ],
  models: ['model-1', 'model-2'],
};

const mocks = rs.hoisted(() => ({ sessionError: false, transformsValid: true }));

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useMutation: () => ({ mutate: rs.fn(), isPending: false }),
  useQuery: () => ({ data: undefined, isError: mocks.sessionError, refetch: rs.fn() }),
  useQueryClient: () => ({ invalidateQueries: rs.fn() }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => rs.fn(),
}));

afterEach(() => {
  mocks.sessionError = false;
  mocks.transformsValid = true;
});

test('OAuth edit page groups terminal actions in the intended order', () => {
  render(<OAuthProviderEditPage provider={provider} oauth={oauth} sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const connection = screen.getByRole('region', { name: /Connection|连接/u });
  expect(
    screen.getByRole('navigation', { name: /^Breadcrumbs$|^面包屑$|^パンくずリスト$|^브레드크럼$/u }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(/^Back$|^返回$|^戻る$|^뒤로$/u)).toBeNull();
  const actions = screen.getByTestId('provider-form-actions');
  const actionButtons = within(actions).getAllByRole('button');
  const save = within(actions).getByRole('button', { name: /Save|保存/u });
  const cancel = within(actions).getByRole('button', { name: /Cancel|取消/u });
  const deleteProvider = within(actions).getByRole('button', { name: /Delete|删除/u });

  expect(screen.queryByLabelText(/Provider ID|提供商 ID/u)).toBeNull();
  expect(screen.queryByLabelText(/OAuth service|OAuth 服务/u)).toBeNull();
  expect(screen.queryByLabelText(/Account|账户/u)).toBeNull();
  expect(within(screen.getByRole('banner')).getByText(/person · OAuth/u)).toBeInTheDocument();
  expect(screen.getByText('person@example.com')).toBeTruthy();
  expect(screen.getByText('@example/oauth / default')).toBeTruthy();
  expect(screen.getByLabelText('Tenant')).toHaveValue('work');
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  expect(screen.getByRole('combobox', { name: /Proxy mode|代理模式/u })).toHaveTextContent(
    /Inherit global proxy|继承全局代理/u,
  );
  expect(screen.getByText('model-1')).toBeTruthy();
  expect(screen.getByText('model-2')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Edit Aliases|编辑别名/u })).toBeTruthy();
  expect(within(connection).getByRole('button', { name: /Reauthorize|重新授权/u })).toBeTruthy();
  expect(actionButtons).toEqual([save, cancel, deleteProvider]);
  expect(within(actions).queryByRole('button', { name: /Reauthorize|重新授权/u })).toBeNull();
  expect(screen.queryByRole('region', { name: /Danger zone|危险操作/u })).toBeNull();
});

test('OAuth edit page presents only a redacted configured proxy as unchanged', () => {
  render(
    <OAuthProviderEditPage
      provider={{ ...provider, proxy: '****' } as unknown as OAuthProvider}
      oauth={oauth}
      sessionId={undefined}
      onSessionIdChange={rs.fn()}
    />,
  );

  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.getByRole('combobox', { name: /Proxy mode|代理模式/u })).toHaveTextContent(
    /Configured \(unchanged\)|已配置（保持不变）/u,
  );
});

test('OAuth edit page hides edit actions while an existing session loads', () => {
  render(
    <OAuthProviderEditPage
      provider={provider}
      oauth={oauth}
      sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf"
      onSessionIdChange={rs.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: /Reauthorize|重新授权/u })).toBeNull();
});

test('OAuth edit page disables save and reauthorization while transforms are invalid', () => {
  mocks.transformsValid = false;
  render(<OAuthProviderEditPage provider={provider} oauth={oauth} sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const save = screen.getByRole('button', { name: /Save|保存/u });
  const reauthorize = screen.getByRole('button', { name: /Reauthorize|重新授权/u });
  expect(save.hasAttribute('disabled')).toBe(true);
  expect(reauthorize.hasAttribute('disabled')).toBe(true);
});

test('OAuth edit page offers a restart when an existing session cannot be loaded', () => {
  mocks.sessionError = true;
  const changeSession = rs.fn();
  render(
    <OAuthProviderEditPage
      provider={provider}
      oauth={oauth}
      sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf"
      onSessionIdChange={changeSession}
    />,
  );

  expect(screen.getByText(/session is unavailable|授权会话不可用/u)).toBeTruthy();
  screen.getByRole('button', { name: /Start over|重新开始/u }).click();
  expect(changeSession).toHaveBeenCalledWith(undefined);
});

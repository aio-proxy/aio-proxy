import type { DashboardOAuthCapability, DashboardOAuthSession } from '@aio-proxy/types';
import { afterEach, expect, rs, test } from '@rstest/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { OAuthProviderCreatePage } from './oauth-provider-create-page';

const capability: DashboardOAuthCapability = {
  plugin: '@example/oauth',
  capability: 'default',
  displayName: 'Example OAuth',
  description: 'Example account',
  defaults: {},
  form: [
    { type: 'text', key: 'tenant', label: 'Tenant' },
    { type: 'secret', key: 'token', label: 'Token', configured: false },
  ],
};

const mocks = rs.hoisted(() => ({
  start: rs.fn(),
  navigate: rs.fn(),
  invalidate: rs.fn(),
  refetch: rs.fn(),
  session: undefined as DashboardOAuthSession | undefined,
  sessionError: false,
}));

rs.mock('@tanstack/react-query', () => ({
  queryOptions: <T,>(options: T) => options,
  useQuery: (options: { queryKey: readonly string[] }) => {
    let data: { capabilities: DashboardOAuthCapability[] } | { session: DashboardOAuthSession } | undefined;
    if (options.queryKey[0] === 'oauth-capabilities') data = { capabilities: [capability] };
    else if (mocks.session !== undefined) data = { session: mocks.session };
    return {
      data,
      isError: options.queryKey[0] === 'oauth-session' && mocks.sessionError,
      isLoading: false,
      refetch: mocks.refetch,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useMutation: () => ({ mutate: mocks.start, isPending: false }),
}));

rs.mock('@tanstack/react-router', () => ({
  Link: ({ children }: React.PropsWithChildren) => <button type="button">{children}</button>,
  useNavigate: () => mocks.navigate,
}));

afterEach(() => {
  rs.restoreAllMocks();
  mocks.start.mockReset();
  mocks.session = undefined;
  mocks.sessionError = false;
});

test('OAuth create page selects a capability and renders its account fields before authorization', async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  expect(
    screen.getByRole('navigation', { name: /^Breadcrumbs$|^面包屑$|^パンくずリスト$|^브레드크럼$/u }),
  ).toBeTruthy();
  expect(screen.queryByLabelText(/^Back$|^返回$|^戻る$|^뒤로$/u)).toBeNull();
  expect(screen.queryByRole('tablist')).toBeNull();

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));

  expect(screen.getByLabelText('Tenant')).toBeTruthy();
  expect(screen.getByLabelText('Token')).toHaveAttribute('type', 'password');
  expect(screen.getByRole('combobox', { name: /Proxy mode|代理模式/u })).toHaveTextContent(
    /Inherit global proxy|继承全局代理/u,
  );
  expect(screen.getByRole('button', { name: /Continue authorization|继续授权/u })).toBeTruthy();
});

test('OAuth create page submits a typed provider proxy patch without using the stepper', async () => {
  render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));

  const proxy = screen.getByRole('combobox', { name: /Proxy mode|代理模式/u });
  fireEvent.click(proxy);
  const disabled = await screen.findByRole('option', { name: /Disable proxy|禁用代理/u });
  fireEvent.pointerDown(disabled, { pointerType: 'mouse' });
  fireEvent.click(disabled);
  await waitFor(() => expect(proxy).toHaveTextContent(/Disable proxy|禁用代理/u));
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));

  expect(screen.queryByRole('tablist')).toBeNull();
  await waitFor(() =>
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ providerPatch: expect.objectContaining({ enabled: true, proxy: false }) }),
    ),
  );
});

test('OAuth create page navigates the pre-opened popup when authorization is ready', async () => {
  const popup = { location: { href: '' } } as Window;
  const open = rs.spyOn(window, 'open').mockReturnValue(popup);
  const view = render(<OAuthProviderCreatePage sessionId={undefined} onSessionIdChange={rs.fn()} />);

  const picker = screen.getByRole('combobox', { name: /OAuth provider|OAuth 提供商/u });
  fireEvent.keyDown(picker, { key: 'ArrowDown' });
  fireEvent.change(picker, { target: { value: 'Example' } });
  fireEvent.click(await screen.findByRole('option', { name: /Example OAuth/u }));
  fireEvent.click(screen.getByRole('button', { name: /Continue authorization|继续授权/u }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'authorize_url',
    url: 'https://example.com/authorize',
  };
  view.rerender(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />,
  );

  expect(popup.location.href).toBe('https://example.com/authorize');
  expect(open).toHaveBeenCalledTimes(1);

  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'loopback',
    authorizationUrl: 'https://example.com/loopback',
    allowManualCallback: false,
  };
  view.rerender(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />,
  );

  expect(popup.location.href).toBe('https://example.com/authorize');
});

test('OAuth create page hides the setup form while an existing session loads', () => {
  render(<OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />);

  expect(screen.queryByRole('button', { name: /Continue authorization|继续授权/u })).toBeNull();
});

test('OAuth create page offers a restart when an existing session cannot be loaded', () => {
  mocks.sessionError = true;
  const changeSession = rs.fn();
  render(
    <OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={changeSession} />,
  );

  expect(screen.getByText(/session is unavailable|授权会话不可用/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Start over|重新开始/u }));
  expect(changeSession).toHaveBeenCalledWith(undefined);
});

test('OAuth create page refreshes providers after authorization succeeds', () => {
  mocks.session = {
    id: '0198bfc4-239e-7d62-bcb0-a9e0849cabaf',
    status: 'succeeded',
    providerId: 'new-provider',
  };

  render(<OAuthProviderCreatePage sessionId="0198bfc4-239e-7d62-bcb0-a9e0849cabaf" onSessionIdChange={rs.fn()} />);

  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
});
